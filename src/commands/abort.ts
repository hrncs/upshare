import pc from "picocolors";
import { ApiClient, FILE_LIST_PAGE_SIZE } from "../lib/api-client";
import { formatBytes, sanitizeTerminalText } from "../lib/format";
import { printError, printHeading } from "../lib/output";
import { confirmPrompt } from "../lib/prompt";
import { createSpinner } from "../lib/spinner";

const MAX_PENDING_PAGES = 100;
const ABORT_DELETE_CONCURRENCY = 5;

export function resolveAbortTargets(
  pending: { id: string }[],
  target: string | undefined
): { id: string } | { all: true } | { missing: string } {
  if (target === undefined) {
    return { all: true };
  }
  const match = pending.find((file) => file.id === target);
  if (!match) {
    return { missing: target };
  }
  return { id: match.id };
}

async function fetchAllPending(client: ApiClient): Promise<{
  files: import("../lib/schemas").UserFileItem[];
  reservedBytes: number;
}> {
  const files: import("../lib/schemas").UserFileItem[] = [];
  let reservedBytes: number | undefined;
  for (let page = 1; page <= MAX_PENDING_PAGES; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential
    const data = await client.listPendingUploads({
      page,
      pageSize: FILE_LIST_PAGE_SIZE,
    });
    reservedBytes ??= data.quota.reservedBytes;
    files.push(...data.files);
    if (!data.hasMore) {
      break;
    }
    if (page === MAX_PENDING_PAGES) {
      throw new Error(
        `Too many unfinished uploads to list (over ${MAX_PENDING_PAGES * FILE_LIST_PAGE_SIZE}). Refine with a file ID.`
      );
    }
  }
  return { files, reservedBytes: reservedBytes ?? 0 };
}

async function deleteWithConcurrency(
  client: ApiClient,
  ids: string[]
): Promise<{ failures: { id: string; reason: string }[]; succeeded: number }> {
  const failures: { id: string; reason: string }[] = [];
  let succeeded = 0;
  for (let index = 0; index < ids.length; index += ABORT_DELETE_CONCURRENCY) {
    const batch = ids.slice(index, index + ABORT_DELETE_CONCURRENCY);
    // biome-ignore lint/performance/noAwaitInLoops: bounded batches
    const results = await Promise.allSettled(
      batch.map((id) => client.deleteFile(id))
    );
    results.forEach((result, batchIndex) => {
      const id = batch[batchIndex] ?? "";
      if (result.status === "fulfilled") {
        succeeded += 1;
      } else {
        failures.push({
          id,
          reason:
            result.reason instanceof Error
              ? result.reason.message
              : "Unknown error",
        });
      }
    });
  }
  return { failures, succeeded };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: command handler with pagination, confirm, and batch reporting
export async function abortCommand(
  target?: string,
  options?: {
    apiUrl?: string;
    profile?: string;
    yes?: boolean;
  }
): Promise<void> {
  const client = new ApiClient({
    apiUrl: options?.apiUrl,
    profile: options?.profile,
  });
  const spinner = createSpinner("Fetching unfinished uploads...").start();

  let pending: import("../lib/schemas").UserFileItem[];
  try {
    ({ files: pending } = await fetchAllPending(client));
    spinner.stop();
  } catch (error) {
    spinner.fail(
      error instanceof Error
        ? error.message
        : "Failed to list unfinished uploads"
    );
    process.exitCode = 1;
    return;
  }

  if (pending.length === 0) {
    printHeading("No unfinished uploads found");
    console.log(
      `${pc.dim("Nothing holding quota. Verify with:")} ${pc.cyan("upshare whoami")}`
    );
    console.log();
    return;
  }

  const resolution = resolveAbortTargets(pending, target);
  if ("missing" in resolution) {
    printError(
      `No unfinished upload found for '${resolution.missing}'.`,
      "upshare abort to list unfinished uploads."
    );
    process.exitCode = 1;
    return;
  }
  const targets =
    "all" in resolution
      ? pending
      : pending.filter((file) => file.id === resolution.id);

  const totalBytes = targets.reduce((total, file) => total + file.fileSize, 0);
  printHeading(`Unfinished Uploads (${targets.length})`);
  for (const file of targets) {
    console.log(
      `  ${pc.cyan(file.id)}  ${sanitizeTerminalText(file.fileName)}  ${formatBytes(file.fileSize)}`
    );
  }
  console.log();
  console.log(
    pc.dim(`Aborting frees ${formatBytes(totalBytes)} of unfinished quota.`)
  );
  console.log();

  if (!options?.yes) {
    const confirmed = await confirmPrompt(
      `Abort ${targets.length} unfinished upload${targets.length === 1 ? "" : "s"} (${formatBytes(totalBytes)})? (y/N): `,
      { yes: options?.yes }
    );
    if (!confirmed) {
      if (process.exitCode === 130) {
        return;
      }
      console.log(pc.dim("Abort cancelled."));
      return;
    }
  }

  const abortSpinner = createSpinner(
    `Aborting ${targets.length} unfinished upload${targets.length === 1 ? "" : "s"}...`
  ).start();
  const { failures, succeeded } = await deleteWithConcurrency(
    client,
    targets.map((file) => file.id)
  );

  if (failures.length === 0) {
    abortSpinner.succeed(
      `Aborted ${succeeded} upload${succeeded === 1 ? "" : "s"}, freed ${formatBytes(totalBytes)}`
    );
    console.log();
  } else {
    abortSpinner.fail(
      `Aborted ${succeeded} of ${targets.length} uploads (${failures.length} failed)`
    );
    for (const failure of failures) {
      printError(`Could not abort ${failure.id}: ${failure.reason}`);
    }
    printError("Some unfinished uploads could not be aborted. Try again.");
    process.exitCode = 1;
  }
}
