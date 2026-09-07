import { stripVTControlCharacters } from "node:util";
import pc from "picocolors";
import { z } from "zod";
import { ApiClient, FILE_LIST_PAGE_SIZE } from "../lib/api-client";
import { formatBytes, formatRelativeTime } from "../lib/format";
import { printError, printHeading } from "../lib/output";
import type { ListFilesResponse, UserFileItem } from "../lib/schemas";
import { createSpinner } from "../lib/spinner";

const PAGE_PATTERN = /^[1-9]\d*$/;
const pageSchema = z
  .string()
  .regex(PAGE_PATTERN)
  .transform(Number)
  .pipe(z.number().int().positive().safe());

function visibleLength(str: string): number {
  return stripVTControlCharacters(str).length;
}

function pad(str: string, length: number): string {
  const vLen = visibleLength(str);
  if (vLen >= length) {
    return str;
  }
  return str + " ".repeat(length - vLen);
}

function printRows(files: UserFileItem[]): void {
  for (const file of files) {
    const displayId = file.shareLink ? file.shareLink.token : file.id;
    const displayName =
      file.fileName.length > 28
        ? `${file.fileName.slice(0, 25)}...`
        : file.fileName;
    const sizeStr = formatBytes(file.fileSize);
    const expiresStr = formatRelativeTime(file.expiresAt);
    const viewsStr = file.shareLink ? String(file.shareLink.viewsCount) : "-";
    const shareUrlStr = file.shareLink
      ? file.shareLink.shareUrl
      : pc.dim("Private");

    const row = [
      pad(displayId, 23),
      pad(displayName, 28),
      pad(sizeStr, 10),
      pad(expiresStr, 12),
      pad(viewsStr, 6),
      shareUrlStr,
    ].join("  ");

    console.log(row);
  }
}

async function printAllPages(
  client: ApiClient,
  currentPage: ListFilesResponse
): Promise<number> {
  printRows(currentPage.files);
  if (!currentPage.hasMore) {
    return currentPage.files.length;
  }
  const nextPage = await client.listFiles({
    page: currentPage.page + 1,
    pageSize: FILE_LIST_PAGE_SIZE,
  });
  return currentPage.files.length + (await printAllPages(client, nextPage));
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

function printPendingRows(files: UserFileItem[]): void {
  for (const file of files) {
    const displayName =
      file.fileName.length > 28
        ? `${file.fileName.slice(0, 25)}...`
        : file.fileName;
    console.log(
      [
        pad(file.id, 23),
        pad(displayName, 28),
        pad(formatBytes(file.fileSize), 10),
        pc.dim("partial"),
      ].join("  ")
    );
  }
}

async function printAllPendingPages(
  client: ApiClient,
  currentPage: ListFilesResponse
): Promise<number> {
  printPendingRows(currentPage.files);
  if (!currentPage.hasMore) {
    return currentPage.files.length;
  }
  const nextPage = await client.listPendingUploads({
    page: currentPage.page + 1,
    pageSize: FILE_LIST_PAGE_SIZE,
  });
  return (
    currentPage.files.length + (await printAllPendingPages(client, nextPage))
  );
}

async function listPendingCommand(options?: {
  all?: boolean;
  apiUrl?: string;
  page?: string;
}): Promise<void> {
  const parsedPage = pageSchema.safeParse(options?.page ?? "1");
  if (!parsedPage.success) {
    printError("Page must be a positive whole number.");
    process.exitCode = 1;
    return;
  }
  if (options?.all && parsedPage.data !== 1) {
    printError("Use either --all or --page, not both.");
    process.exitCode = 1;
    return;
  }

  const client = new ApiClient({ apiUrl: options?.apiUrl });
  const spinner = createSpinner("Fetching partial uploads...").start();

  try {
    const data = await client.listPendingUploads({
      page: parsedPage.data,
      pageSize: FILE_LIST_PAGE_SIZE,
    });
    spinner.stop();

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
      pad("File Name", 28),
      pad("Size", 10),
      "State",
    ].join("  ");

    console.log(pc.bold(pc.cyan(headers)));
    console.log(pc.dim("-".repeat(visibleLength(headers))));

    if (options?.all) {
      const displayedCount = await printAllPendingPages(client, data);
      console.log();
      console.log(
        pc.dim(
          `Showing all ${displayedCount.toLocaleString()} partial uploads.`
        )
      );
      console.log();
    } else {
      printPendingRows(data.files);
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

export async function listCommand(options?: {
  all?: boolean;
  apiUrl?: string;
  page?: string;
  pending?: boolean;
}): Promise<void> {
  if (options?.pending) {
    await listPendingCommand(options);
    return;
  }
  const parsedPage = pageSchema.safeParse(options?.page ?? "1");
  if (!parsedPage.success) {
    printError("Page must be a positive whole number.");
    process.exitCode = 1;
    return;
  }
  if (options?.all && parsedPage.data !== 1) {
    printError("Use either --all or --page, not both.");
    process.exitCode = 1;
    return;
  }

  const client = new ApiClient({ apiUrl: options?.apiUrl });
  const spinner = createSpinner("Fetching active files...").start();

  try {
    const data = await client.listFiles({
      page: parsedPage.data,
      pageSize: FILE_LIST_PAGE_SIZE,
    });
    spinner.stop();

    if (data.files.length === 0) {
      if (parsedPage.data === 1) {
        printHeading("No active files found");
        console.log(
          `${pc.dim("Upload with:")} ${pc.cyan("upshare upload <file>")}`
        );
      } else {
        printHeading(`No files found on page ${parsedPage.data}`);
        console.log(
          `${pc.dim("Previous:")} ${pc.cyan(`upshare ls --page ${parsedPage.data - 1}`)}`
        );
      }
      console.log();
      return;
    }

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
      pad("File Name", 28),
      pad("Size", 10),
      pad("Expires In", 12),
      pad("Views", 6),
      "Share Link",
    ].join("  ");

    console.log(pc.bold(pc.cyan(headers)));
    console.log(pc.dim("-".repeat(visibleLength(headers))));

    let displayedCount = data.files.length;
    if (options?.all) {
      displayedCount = await printAllPages(client, data);
    } else {
      printRows(data.files);
    }

    console.log();
    if (options?.all) {
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
  } catch (error) {
    spinner.fail(
      error instanceof Error ? error.message : "Failed to list files"
    );
    process.exitCode = 1;
  }
}
