import readline from "node:readline/promises";
import pc from "picocolors";
import { ApiClient, FILE_LIST_PAGE_SIZE } from "../lib/api-client";
import { formatBytes, formatRelativeTime } from "../lib/format";
import {
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
    console.log(`  [${pc.cyan("P")}] Previous 20`);
  }
  if (data.hasMore) {
    console.log(`  [${pc.cyan("N")}] Load next 20`);
  }
  console.log(`  [${pc.dim("0")}] Exit`);
  console.log();
}

function printNoFiles(): void {
  printHeading("No active files to manage");
  console.log(`${pc.dim("Upload with:")} ${pc.cyan("upshare upload <file>")}`);
  console.log();
}

async function promptSelectFilePage(
  client: ApiClient,
  pageCache: Map<number, ListFilesResponse>,
  page: number
): Promise<UserFileItem | null> {
  const data = await getManagePage(client, pageCache, page);
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
    return promptSelectFilePage(client, pageCache, page + 1);
  }
  if (selection === "p" && page > 1) {
    return promptSelectFilePage(client, pageCache, page - 1);
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
  return promptSelectFilePage(client, pageCache, page);
}

function promptSelectFile(client: ApiClient): Promise<UserFileItem | null> {
  return promptSelectFilePage(client, new Map(), 1);
}

async function executeAction(
  action: string,
  identifier: string,
  chosenFile: UserFileItem | null,
  options?: { apiUrl?: string }
): Promise<void> {
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
        await shareCommand(identifier, {
          apiUrl: options?.apiUrl,
          duration: "24",
        });
      }
      break;
    }
    case "2": {
      await shareCommand(identifier, { apiUrl: options?.apiUrl });
      break;
    }
    case "3": {
      await extendCommand(identifier, { apiUrl: options?.apiUrl });
      break;
    }
    case "4": {
      await revokeCommand(identifier, { apiUrl: options?.apiUrl });
      break;
    }
    case "5": {
      await downloadCommand(identifier, { apiUrl: options?.apiUrl });
      break;
    }
    case "6": {
      await deleteCommand(identifier, { apiUrl: options?.apiUrl });
      break;
    }
    default: {
      console.log(pc.dim("Exited."));
      break;
    }
  }
}

export async function manageCommand(
  target?: string,
  options?: { apiUrl?: string }
): Promise<void> {
  const client = new ApiClient({ apiUrl: options?.apiUrl });
  let chosenFile: UserFileItem | null = null;

  if (target) {
    const spinner = createSpinner({
      discardStdin: false,
      text: "Looking up file...",
    }).start();
    try {
      const data = await client.listFiles();
      spinner.stop();
      chosenFile =
        data.files.find(
          (f) =>
            f.id === target ||
            f.shareLink?.token === target ||
            f.shareLink?.id === target
        ) || null;

      if (!chosenFile) {
        printWarning(
          `File '${target}' was not found in the active list; managing by identifier.`
        );
      }
    } catch (error) {
      spinner.fail(
        error instanceof Error ? error.message : "Could not load file list"
      );
      process.exitCode = 1;
      return;
    }
  }

  if (!(chosenFile || target)) {
    chosenFile = await promptSelectFile(client);
    if (!chosenFile) {
      console.log(pc.dim("Exited."));
      return;
    }
  }

  const fileIdentifier =
    chosenFile?.shareLink?.token || chosenFile?.id || target || "";
  const fileName = chosenFile?.fileName || fileIdentifier;

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
  console.log(`  [${pc.cyan("1")}] Get / Copy Share Link`);
  console.log(`  [${pc.cyan("2")}] Create / Update Share Link`);
  console.log(`  [${pc.cyan("3")}] Extend Expiration Duration`);
  console.log(`  [${pc.cyan("4")}] Revoke Public Share Link`);
  console.log(`  [${pc.cyan("5")}] Download File Locally`);
  console.log(`  [${pc.cyan("6")}] Delete File Permanently`);
  console.log(`  [${pc.dim("0")}] Exit`);
  console.log();

  const action = await askQuestion(
    pc.cyan("Select action [1-6] (0 to exit): ")
  );

  await executeAction(action.trim(), fileIdentifier, chosenFile, options);
}
