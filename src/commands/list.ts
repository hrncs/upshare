import { stripVTControlCharacters } from "node:util";
import pc from "picocolors";
import { ApiClient, FILE_LIST_PAGE_SIZE } from "../lib/api-client";
import { formatBytes, formatRelativeTime } from "../lib/format";
import { printError, printHeading } from "../lib/output";
import type { ListFilesResponse, UserFileItem } from "../lib/schemas";
import { createSpinner } from "../lib/spinner";

function parsePage(value: string | undefined): number {
  if (value === undefined) {
    return 1;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("Page must be a positive whole number.");
  }
  return parsed;
}

function visibleLength(str: string): number {
  return Array.from(stripVTControlCharacters(str)).length;
}

function pad(str: string, length: number): string {
  const vLen = visibleLength(str);
  if (vLen >= length) {
    return str;
  }
  return str + " ".repeat(length - vLen);
}

function truncateName(name: string, maxWidth = 40): string {
  const chars = Array.from(name);
  if (chars.length <= maxWidth) {
    return name;
  }
  return `${chars.slice(0, maxWidth - 3).join("")}...`;
}

function printFileRows(files: UserFileItem[], pending: boolean): void {
  for (const file of files) {
    const displayName = truncateName(file.fileName);
    if (pending) {
      console.log(
        [
          pad(file.id, 23),
          pad(displayName, 40),
          pad(formatBytes(file.fileSize), 10),
          pc.dim("partial"),
        ].join("  ")
      );
      continue;
    }
    const displayId = file.shareLink ? file.shareLink.token : file.id;
    const sizeStr = formatBytes(file.fileSize);
    const expiresStr = formatRelativeTime(file.expiresAt);
    const viewsStr = file.shareLink ? String(file.shareLink.viewsCount) : "-";
    const shareUrlStr = file.shareLink
      ? file.shareLink.shareUrl
      : pc.dim("Private");

    const row = [
      pad(displayId, 23),
      pad(displayName, 40),
      pad(sizeStr, 10),
      pad(expiresStr, 12),
      pad(viewsStr, 6),
      shareUrlStr,
    ].join("  ");

    console.log(row);
  }
}

async function printAllPagesLoop(
  firstPage: ListFilesResponse,
  fetchPage: (page: number) => Promise<ListFilesResponse>,
  pending: boolean
): Promise<number> {
  let total = 0;
  let current: ListFilesResponse | undefined = firstPage;
  while (current) {
    printFileRows(current.files, pending);
    total += current.files.length;
    if (!current.hasMore) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: sequential pagination
    current = await fetchPage(current.page + 1);
  }
  return total;
}

function printPageNavigation(data: ListFilesResponse): void {
  const firstFileNumber = (data.page - 1) * data.pageSize + 1;
  const lastFileNumber = firstFileNumber + data.files.length - 1;
  console.log(
    pc.dim(
      `Showing files ${firstFileNumber.toLocaleString()}-${lastFileNumber.toLocaleString()} of ${data.totalFiles.toLocaleString()}.`
    )
  );
  if (data.page > 1) {
    console.log(
      `${pc.dim("Previous:")} ${pc.cyan(`upshare ls --page ${data.page - 1}`)}`
    );
  }
  if (data.hasMore) {
    console.log(
      `${pc.dim("Next:")}     ${pc.cyan(`upshare ls --page ${data.page + 1}`)}`
    );
  }
  console.log();
}

async function collectAllPages(
  firstPage: ListFilesResponse,
  fetchPage: (page: number) => Promise<ListFilesResponse>
): Promise<UserFileItem[]> {
  const files = [...firstPage.files];
  let current = firstPage;
  while (current.hasMore) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential pagination
    current = await fetchPage(current.page + 1);
    files.push(...current.files);
  }
  return files;
}

interface ListOptions {
  all?: boolean;
  apiUrl?: string;
  json?: boolean;
  page?: string;
  pending?: boolean;
  profile?: string;
}

function checkExclusiveAllPage(options?: ListOptions): boolean {
  if (options?.all && options?.page !== undefined) {
    printError("Use either --all or --page, not both.");
    process.exitCode = 1;
    return true;
  }
  return false;
}

async function listPendingCommand(options?: ListOptions): Promise<void> {
  if (checkExclusiveAllPage(options)) {
    return;
  }
  let page: number;
  try {
    page = parsePage(options?.page);
  } catch (error) {
    printError(error instanceof Error ? error.message : "Invalid page.");
    process.exitCode = 1;
    return;
  }

  const client = new ApiClient({
    apiUrl: options?.apiUrl,
    profile: options?.profile,
  });
  const spinner = createSpinner("Fetching partial uploads...").start();

  try {
    const data = await client.listPendingUploads({
      page,
      pageSize: FILE_LIST_PAGE_SIZE,
    });
    spinner.stop();

    if (options?.json) {
      const files = options?.all
        ? await collectAllPages(data, (p) =>
            client.listPendingUploads({
              page: p,
              pageSize: FILE_LIST_PAGE_SIZE,
            })
          )
        : data.files;
      console.log(
        JSON.stringify(options?.all ? { ...data, files } : data, null, 2)
      );
      return;
    }

    if (data.files.length === 0) {
      printHeading("No partial uploads found");
      console.log(
        `${pc.dim("Nothing holding space. Verify with:")} ${pc.cyan("upshare whoami")}`
      );
      console.log();
      return;
    }

    printHeading(`Partial Uploads (${data.totalFiles.toLocaleString()})`);
    console.log(
      pc.dim(
        `${formatBytes(data.quota.reservedBytes)} still blocking space. Free it with ${pc.cyan("upshare abort")}.`
      )
    );
    console.log();

    const headers = [
      pad("ID", 23),
      pad("File Name", 40),
      pad("Size", 10),
      "State",
    ].join("  ");

    console.log(pc.bold(pc.cyan(headers)));
    console.log(pc.dim("-".repeat(visibleLength(headers))));

    if (options?.all) {
      const displayedCount = await printAllPagesLoop(
        data,
        (p) =>
          client.listPendingUploads({ page: p, pageSize: FILE_LIST_PAGE_SIZE }),
        true
      );
      console.log();
      console.log(
        pc.dim(
          `Showing all ${displayedCount.toLocaleString()} partial uploads.`
        )
      );
      console.log();
    } else {
      printFileRows(data.files, true);
      console.log();
      printPageNavigation(data);
    }
  } catch (error) {
    spinner.fail(
      error instanceof Error ? error.message : "Failed to list partial uploads"
    );
    process.exitCode = 1;
  }
}

function printEmptyActiveFiles(page: number): void {
  if (page === 1) {
    printHeading("No active files found");
    console.log(
      `${pc.dim("Upload with:")} ${pc.cyan("upshare upload <file>")}`
    );
  } else {
    printHeading(`No files found on page ${page}`);
    console.log(
      `${pc.dim("Previous:")} ${pc.cyan(`upshare ls --page ${page - 1}`)}`
    );
  }
  console.log();
}

function printActiveFilesHeader(data: ListFilesResponse): void {
  printHeading(`Active Files (${data.totalFiles.toLocaleString()})`);
  console.log(
    `${pc.dim("Monthly uploads:")} ${formatBytes(data.quota.usedBytes)} / ${formatBytes(data.quota.maxQuotaBytes)}`
  );
  if (data.quota.reservedBytes > 0) {
    console.log(
      pc.dim(
        `${formatBytes(data.quota.reservedBytes)} unfinished - run \`upshare abort\` to free it.`
      )
    );
  }
  console.log();

  const headers = [
    pad("ID / Token", 23),
    pad("File Name", 40),
    pad("Size", 10),
    pad("Expires In", 12),
    pad("Views", 6),
    "Share Link",
  ].join("  ");

  console.log(pc.bold(pc.cyan(headers)));
  console.log(pc.dim("-".repeat(visibleLength(headers))));
}

async function printActiveFilesBody(
  client: ApiClient,
  data: ListFilesResponse,
  all: boolean
): Promise<void> {
  let displayedCount = data.files.length;
  if (all) {
    displayedCount = await printAllPagesLoop(
      data,
      (p) => client.listFiles({ page: p, pageSize: FILE_LIST_PAGE_SIZE }),
      false
    );
  } else {
    printFileRows(data.files, false);
  }

  console.log();
  if (all) {
    console.log(
      pc.dim(`Showing all ${displayedCount.toLocaleString()} active files.`)
    );
    console.log();
  } else {
    printPageNavigation(data);
  }
  console.log(
    `${pc.dim("Commands: ")}${pc.dim(
      "upshare share <id>  |  upshare extend <id>  |  upshare delete <id>  |  upshare manage"
    )}`
  );
  console.log();
}

export async function listCommand(options?: ListOptions): Promise<void> {
  if (options?.pending) {
    await listPendingCommand(options);
    return;
  }
  if (checkExclusiveAllPage(options)) {
    return;
  }
  let page: number;
  try {
    page = parsePage(options?.page);
  } catch (error) {
    printError(error instanceof Error ? error.message : "Invalid page.");
    process.exitCode = 1;
    return;
  }

  const client = new ApiClient({
    apiUrl: options?.apiUrl,
    profile: options?.profile,
  });
  const spinner = createSpinner("Fetching active files...").start();

  try {
    const data = await client.listFiles({
      page,
      pageSize: FILE_LIST_PAGE_SIZE,
    });
    spinner.stop();

    if (options?.json) {
      const files = options?.all
        ? await collectAllPages(data, (p) =>
            client.listFiles({ page: p, pageSize: FILE_LIST_PAGE_SIZE })
          )
        : data.files;
      console.log(
        JSON.stringify(options?.all ? { ...data, files } : data, null, 2)
      );
      return;
    }

    if (data.files.length === 0) {
      printEmptyActiveFiles(page);
      return;
    }

    printActiveFilesHeader(data);
    await printActiveFilesBody(client, data, options?.all ?? false);
  } catch (error) {
    spinner.fail(
      error instanceof Error ? error.message : "Failed to list files"
    );
    process.exitCode = 1;
  }
}
