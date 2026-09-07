import readline from "node:readline/promises";
import pc from "picocolors";
import { ApiClient } from "../lib/api-client";
import { formatBytes } from "../lib/format";
import { printError, printHeading } from "../lib/output";
import type { UserFileItem } from "../lib/schemas";
import { createSpinner } from "../lib/spinner";

const PENDING_PAGE_SIZE = 100;

function resolveAbortTargets(
  pending: UserFileItem[],
  target: string | undefined
): UserFileItem[] | null {
  if (target === undefined) {
    return pending;
  }
  const match = pending.find((file) => file.id === target);
  if (!match) {
    printError(
      `No unfinished upload found for '${target}'.`,
      "upshare abort to list unfinished uploads."
    );
    process.exitCode = 1;
    return null;
  }
  return [match];
}

async function confirmAbort(
  count: number,
  totalBytes: number
): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(
      pc.yellow(
        `Abort ${count.toLocaleString()} unfinished upload${count === 1 ? "" : "s"} (${formatBytes(totalBytes)})? (y/N): `
      )
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } catch {
    console.log();
    return false;
  } finally {
    rl.close();
  }
}

async function fetchAllPending(client: ApiClient): Promise<{
  files: UserFileItem[];
  reservedBytes: number;
}> {
  const files: UserFileItem[] = [];
  let page = 1;
  let reservedBytes = 0;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential
    const data = await client.listPendingUploads({
      page,
      pageSize: PENDING_PAGE_SIZE,
    });
    ({ reservedBytes } = data.quota);
    files.push(...data.files);
    if (!data.hasMore) {
      break;
    }
    page += 1;
  }
  return { files, reservedBytes };
}

export async function abortCommand(
  target?: string,
  options?: {
    apiUrl?: string;
    yes?: boolean;
  }
): Promise<void> {
  const client = new ApiClient({ apiUrl: options?.apiUrl });
  const spinner = createSpinner("Fetching unfinished uploads...").start();

  let pending: UserFileItem[];
  try {
    const result = await fetchAllPending(client);
    pending = result.files;
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

  const targets = resolveAbortTargets(pending, target);
  if (!targets) {
    return;
  }
  pending = targets;

  const totalBytes = pending.reduce((total, file) => total + file.fileSize, 0);
  printHeading(`Unfinished Uploads (${pending.length.toLocaleString()})`);
  for (const file of pending) {
    console.log(
      `  ${pc.cyan(file.id)}  ${file.fileName}  ${formatBytes(file.fileSize)}`
    );
  }
  console.log();
  console.log(
    pc.dim(`Aborting frees ${formatBytes(totalBytes)} of unfinished quota.`)
  );
  console.log();

  if (!options?.yes) {
    const confirmed = await confirmAbort(pending.length, totalBytes);
    if (!confirmed) {
      console.log(pc.dim("Abort cancelled."));
      return;
    }
  }

  const abortSpinner = createSpinner(
    `Aborting ${pending.length.toLocaleString()} unfinished upload${pending.length === 1 ? "" : "s"}...`
  ).start();
  let aborted = 0;
  let failed = 0;
  for (const file of pending) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: sequential
      await client.deleteFile(file.id);
      aborted += 1;
    } catch {
      failed += 1;
    }
  }

  if (failed === 0) {
    abortSpinner.succeed(
      `Aborted ${aborted.toLocaleString()} upload${aborted === 1 ? "" : "s"}, freed ${formatBytes(totalBytes)}`
    );
    console.log();
  } else {
    abortSpinner.fail(
      `Aborted ${aborted} of ${pending.length} uploads (${failed} failed)`
    );
    printError("Some unfinished uploads could not be aborted. Try again.");
    process.exitCode = 1;
  }
}
