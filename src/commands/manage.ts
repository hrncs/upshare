import readline from "node:readline/promises";
import pc from "picocolors";
import { ApiClient, FILE_LIST_PAGE_SIZE } from "../lib/api-client";
import {
  formatBytes,
  formatRelativeTime,
  sanitizeTerminalText,
} from "../lib/format";
import {
  printError,
  printFields,
  printHeading,
  printSuccess,
  printWarning,
} from "../lib/output";
import type { ListFilesResponse, UserFileItem } from "../lib/schemas";
import { createSpinner } from "../lib/spinner";
import { deleteCommand } from "./delete";
import { downloadCommand } from "./download";
import { extendCommand } from "./extend";
import { revokeCommand, shareCommand } from "./share";

const FILE_SELECTION_PATTERN = /^[1-9]\d*$/;

async function askQuestion(promptText: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await rl.question(promptText);
  } catch {
    console.log();
    return "0";
  } finally {
    rl.close();
  }
}

async function getManagePage(
  client: ApiClient,
  pageCache: Map<number, ListFilesResponse>,
  page: number
): Promise<ListFilesResponse> {
  const cached = pageCache.get(page);
  if (cached) {
    return cached;
  }

  const spinner = createSpinner({
    discardStdin: false,
    text: page === 1 ? "Fetching active files..." : "Fetching more files...",
  }).start();
  try {
    const data = await client.listFiles({
      page,
      pageSize: FILE_LIST_PAGE_SIZE,
    });
    pageCache.set(page, data);
    return data;
  } finally {
    spinner.stop();
  }
}

function printManagePage(data: ListFilesResponse): void {
  const firstFileNumber = (data.page - 1) * data.pageSize + 1;
  const lastFileNumber = firstFileNumber + data.files.length - 1;
  printHeading("UpShare File Manager");
  console.log(
    pc.dim(
      `Select a file to manage (${firstFileNumber.toLocaleString()}-${lastFileNumber.toLocaleString()} of ${data.totalFiles.toLocaleString()}):`
    )
  );
  console.log();

  for (const [index, file] of data.files.entries()) {
    const linkStatus = file.shareLink
      ? pc.green(`Public (${file.shareLink.token})`)
      : pc.dim("Private");
    console.log(
      `  [${pc.cyan(String(index + 1))}] ${pc.bold(file.fileName)} ` +
        pc.dim(
          `(${formatBytes(file.fileSize)}, expires ${formatRelativeTime(file.expiresAt)}) `
        ) +
        linkStatus
    );
  }
  if (data.page > 1) {
    console.log(`  [${pc.cyan("P")}] Previous ${FILE_LIST_PAGE_SIZE}`);
  }
  if (data.hasMore) {
    console.log(`  [${pc.cyan("N")}] Load next ${FILE_LIST_PAGE_SIZE}`);
  }
  console.log(`  [${pc.dim("0")}] Exit`);
  console.log();
}

function printNoFiles(): void {
  printHeading("No active files to manage");
  console.log(`${pc.dim("Upload with:")} ${pc.cyan("upshare upload <file>")}`);
  console.log();
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: interactive file-selection loop
async function promptSelectFilePage(
  client: ApiClient,
  pageCache: Map<number, ListFilesResponse>,
  startPage: number
): Promise<UserFileItem | null> {
  let page = startPage;
  for (;;) {
    let data: ListFilesResponse;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: interactive pagination
      data = await getManagePage(client, pageCache, page);
    } catch (error) {
      printError(
        error instanceof Error ? error.message : "Could not load file list"
      );
      return null;
    }
    if (data.files.length === 0) {
      printNoFiles();
      return null;
    }

    printManagePage(data);
    const selection = (
      await askQuestion(
        pc.cyan(`Choose file [1-${data.files.length}] or an option: `)
      )
    )
      .trim()
      .toLowerCase();

    if (selection === "n" && data.hasMore) {
      page += 1;
      continue;
    }
    if (selection === "p" && page > 1) {
      page -= 1;
      continue;
    }
    if (selection === "0") {
      return null;
    }

    if (FILE_SELECTION_PATTERN.test(selection)) {
      const selectedIndex = Number.parseInt(selection, 10);
      const selectedFile = data.files[selectedIndex - 1];
      if (selectedFile) {
        return selectedFile;
      }
    }

    printWarning("Choose one of the available options.");
  }
}

function promptSelectFile(client: ApiClient): Promise<UserFileItem | null> {
  return promptSelectFilePage(client, new Map(), 1);
}

async function executeAction(
  action: string,
  identifier: string,
  chosenFile: UserFileItem | null,
  options?: { apiUrl?: string; profile?: string }
): Promise<boolean> {
  switch (action) {
    case "1": {
      if (chosenFile?.shareLink) {
        console.log();
        printSuccess("Share link ready");
        console.log();
        printFields([
          ["Share URL", pc.cyan(pc.bold(chosenFile.shareLink.shareUrl))],
          ["Token", chosenFile.shareLink.token],
        ]);
        console.log();
      } else {
        const answer = (
          await askQuestion(
            pc.yellow("No share link yet — create a 24h link? (y/N): ")
          )
        )
          .trim()
          .toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          console.log(pc.dim("Kept private. No link created."));
          return false;
        }
        await shareCommand(identifier, {
          apiUrl: options?.apiUrl,
          duration: "24",
          profile: options?.profile,
        });
      }
      return true;
    }
    case "2": {
      await shareCommand(identifier, {
        apiUrl: options?.apiUrl,
        profile: options?.profile,
      });
      return true;
    }
    case "3": {
      await extendCommand(identifier, {
        apiUrl: options?.apiUrl,
        profile: options?.profile,
      });
      return true;
    }
    case "4": {
      await revokeCommand(identifier, {
        apiUrl: options?.apiUrl,
        profile: options?.profile,
      });
      return true;
    }
    case "5": {
      await downloadCommand(identifier, {
        apiUrl: options?.apiUrl,
        profile: options?.profile,
      });
      return true;
    }
    case "6": {
      await deleteCommand(identifier, {
        apiUrl: options?.apiUrl,
        profile: options?.profile,
      });
      return true;
    }
    case "0": {
      console.log(pc.dim("Exited."));
      return true;
    }
    default: {
      printWarning("Choose one of the available options [0-6].");
      return false;
    }
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: command handler with lookup, selection, and action loop
export async function manageCommand(
  target?: string,
  options?: { apiUrl?: string; profile?: string }
): Promise<void> {
  const client = new ApiClient({
    apiUrl: options?.apiUrl,
    profile: options?.profile,
  });
  let chosenFile: UserFileItem | null = null;

  if (target) {
    const spinner = createSpinner({
      discardStdin: false,
      text: "Looking up file...",
    }).start();
    try {
      const direct = await client.getFile(target);
      spinner.stop();
      if (direct) {
        chosenFile = { ...direct.file, shareLink: direct.shareLink };
      } else {
        printWarning(
          `File '${sanitizeTerminalText(target)}' was not found; managing by identifier.`
        );
      }
    } catch (error) {
      spinner.fail(
        error instanceof Error ? error.message : "Could not load file"
      );
      process.exitCode = 1;
      return;
    }
  }

  if (!(chosenFile || target)) {
    try {
      chosenFile = await promptSelectFile(client);
    } catch (error) {
      printError(
        error instanceof Error ? error.message : "Could not load file list"
      );
      process.exitCode = 1;
      return;
    }
    if (!chosenFile) {
      console.log(pc.dim("Exited."));
      return;
    }
  }

  const fileIdentifier = chosenFile?.id || target || "";
  const fileName = sanitizeTerminalText(chosenFile?.fileName || fileIdentifier);

  printHeading(`Manage ${fileName}`);
  if (chosenFile) {
    const fields: [string, string][] = [
      ["ID", chosenFile.id],
      ["Size", formatBytes(chosenFile.fileSize)],
      ["Expires", formatRelativeTime(chosenFile.expiresAt)],
    ];
    if (chosenFile.shareLink) {
      fields.push(
        ["Share link", pc.cyan(chosenFile.shareLink.shareUrl)],
        ["Views", String(chosenFile.shareLink.viewsCount)]
      );
    } else {
      fields.push(["Sharing", pc.dim("Private")]);
    }
    printFields(fields);
  }
  console.log();

  console.log(pc.bold("Actions"));
  console.log(
    `  [${pc.cyan("1")}] Get link (shows existing, asks before creating 24h link if private)`
  );
  console.log(`  [${pc.cyan("2")}] Create / Update Share Link`);
  console.log(`  [${pc.cyan("3")}] Extend Expiration Duration`);
  console.log(`  [${pc.cyan("4")}] Revoke Public Share Link`);
  console.log(`  [${pc.cyan("5")}] Download File Locally`);
  console.log(`  [${pc.cyan("6")}] Delete File Permanently`);
  console.log(`  [${pc.dim("0")}] Exit`);
  console.log();

  for (;;) {
    const action =
      // biome-ignore lint/performance/noAwaitInLoops: interactive prompt
      (await askQuestion(pc.cyan("Select action [1-6] (0 to exit): "))).trim();
    const handled = await executeAction(
      action,
      fileIdentifier,
      chosenFile,
      options
    );
    if (handled) {
      break;
    }
  }
}
