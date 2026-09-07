import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { ApiClient } from "../lib/api-client";
import {
  createDownloadJournal,
  type DownloadJournal,
  getDownloadWorkPaths,
  loadDownloadState,
  openDownloadJournal,
  removeDownloadWorkFiles,
} from "../lib/download-journal";
import { formatBytes, formatDuration } from "../lib/format";
import { printError, printFields, printWarning } from "../lib/output";
import { downloadFileInRanges } from "../lib/ranged-download";
import type { DownloadResponse } from "../lib/schemas";
import { createSpinner } from "../lib/spinner";
import {
  createTransferProgressLine,
  type TransferProgressLine,
} from "../lib/transfer-progress";
import { parseIntegerRange } from "../lib/validation";

const DOWNLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const DEFAULT_DOWNLOAD_CONCURRENCY = 8;
const MAX_DOWNLOAD_CONCURRENCY = 16;
const DEFAULT_RETRIES = 5;
const MAX_RETRIES = 20;

export interface DownloadCommandOptions {
  apiUrl?: string;
  concurrency?: string;
  force?: boolean;
  out?: string;
  retries?: string;
}

function ensureOutputDirectory(outputDirectory: string): void {
  if (!fs.existsSync(outputDirectory)) {
    fs.mkdirSync(outputDirectory, { recursive: true });
    return;
  }
  if (!fs.statSync(outputDirectory).isDirectory()) {
    throw new Error(`Output path is not a directory: ${outputDirectory}`);
  }
}

export function finalizeDownloadedFile(
  partPath: string,
  destinationPath: string,
  options?: { force?: boolean }
): void {
  if (fs.existsSync(destinationPath)) {
    if (!options?.force) {
      throw new Error(
        `A file with the same name already exists at the destination path; cannot overwrite: ${destinationPath}`
      );
    }
    fs.unlinkSync(destinationPath);
  }
  try {
    fs.renameSync(partPath, destinationPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EXDEV" || code === "ENOTSUP" || code === "EPERM") {
      fs.copyFileSync(partPath, destinationPath);
      fs.unlinkSync(partPath);
      return;
    }
    throw error;
  }
}

function createOrLoadDownload(
  outputDirectory: string,
  fileInfo: DownloadResponse
): {
  journal: DownloadJournal;
  journalPath: string;
  partPath: string;
  state: NonNullable<ReturnType<typeof loadDownloadState>>;
} {
  const paths = getDownloadWorkPaths(outputDirectory, fileInfo.fileId);
  const savedState = loadDownloadState(paths.journalPath);
  const partExists = fs.existsSync(paths.partPath);

  if (savedState) {
    if (!partExists) {
      throw new Error(
        `Download resume journal exists but its partial file is missing: ${paths.journalPath}`
      );
    }
    if (
      savedState.fileId !== fileInfo.fileId ||
      savedState.fileName !== fileInfo.fileName ||
      savedState.fileSize !== fileInfo.fileSize ||
      savedState.chunkSize !== DOWNLOAD_CHUNK_SIZE
    ) {
      throw new Error(
        `Download resume journal does not match the remote file: ${paths.journalPath}`
      );
    }
    if (fs.statSync(paths.partPath).size !== fileInfo.fileSize) {
      throw new Error(`Partial download has the wrong size: ${paths.partPath}`);
    }
    return {
      ...paths,
      journal: openDownloadJournal(paths.journalPath),
      state: savedState,
    };
  }

  if (partExists) {
    throw new Error(
      `Partial download exists without a resume journal: ${paths.partPath}`
    );
  }

  const state = {
    chunkSize: DOWNLOAD_CHUNK_SIZE,
    completedChunks: [],
    fileId: fileInfo.fileId,
    fileName: fileInfo.fileName,
    fileSize: fileInfo.fileSize,
  };
  try {
    const descriptor = fs.openSync(paths.partPath, "wx", 0o600);
    try {
      fs.ftruncateSync(descriptor, fileInfo.fileSize);
    } finally {
      fs.closeSync(descriptor);
    }
    const journal = createDownloadJournal(paths.journalPath, {
      chunkSize: state.chunkSize,
      fileId: state.fileId,
      fileName: state.fileName,
      fileSize: state.fileSize,
    });
    return { ...paths, journal, state };
  } catch (error) {
    removeDownloadWorkFiles(paths);
    throw error;
  }
}

export async function downloadCommand(
  target: string,
  options?: DownloadCommandOptions
): Promise<void> {
  const commandStartedAt = Date.now();
  let concurrency: number;
  let retries: number;
  try {
    concurrency = parseIntegerRange(
      options?.concurrency,
      DEFAULT_DOWNLOAD_CONCURRENCY,
      1,
      MAX_DOWNLOAD_CONCURRENCY,
      "Concurrency"
    );
    retries = parseIntegerRange(
      options?.retries,
      DEFAULT_RETRIES,
      0,
      MAX_RETRIES,
      "Retries"
    );
  } catch (error) {
    printError(
      error instanceof Error ? error.message : "Invalid download option"
    );
    process.exitCode = 1;
    return;
  }

  const client = new ApiClient({ apiUrl: options?.apiUrl });
  const spinner = createSpinner(`Resolving ${pc.bold(target)}...`).start();
  let workPaths: ReturnType<typeof getDownloadWorkPaths> | undefined;
  let journal: DownloadJournal | undefined;
  let transferProgress: TransferProgressLine | undefined;

  try {
    const fileInfo = await client.resolveDownload(target);
    const outputDirectory = path.resolve(process.cwd(), options?.out ?? ".");
    ensureOutputDirectory(outputDirectory);

    const destinationPath = path.resolve(outputDirectory, fileInfo.fileName);
    if (path.dirname(destinationPath) !== outputDirectory) {
      throw new Error("The server returned an unsafe file name.");
    }
    if (!options?.force && fs.existsSync(destinationPath)) {
      throw new Error(
        `A file with the same name already exists at the destination path; cannot overwrite: ${destinationPath}`
      );
    }

    const download = createOrLoadDownload(outputDirectory, fileInfo);
    workPaths = download;
    ({ journal } = download);
    let networkBytes = 0;
    spinner.stop();
    transferProgress = createTransferProgressLine({
      action: "Downloading",
      startedAt: Date.now(),
      totalBytes: fileInfo.fileSize,
    });
    const result = await downloadFileInRanges({
      client,
      concurrency,
      fileInfo,
      journal: download.journal,
      onProgress: ({ completedBytes, networkBytes: receivedBytes }) => {
        networkBytes = receivedBytes;
        transferProgress?.update(completedBytes, receivedBytes);
      },
      partPath: download.partPath,
      retries,
      state: download.state,
      target,
    });
    ({ networkBytes } = result);

    const downloadedSize = fs.statSync(download.partPath).size;
    if (downloadedSize !== fileInfo.fileSize) {
      throw new Error(
        `Download size mismatch: expected ${fileInfo.fileSize} bytes, received ${downloadedSize}.`
      );
    }
    download.journal.close();
    journal = undefined;
    finalizeDownloadedFile(download.partPath, destinationPath, {
      force: options?.force,
    });
    removeDownloadWorkFiles(download);
    transferProgress.clear();
    transferProgress = undefined;

    spinner.succeed(`Downloaded ${fileInfo.fileName}`);
    const totalSeconds = (Date.now() - commandStartedAt) / 1000;
    const averageSpeed = networkBytes / Math.max(totalSeconds, 0.001);
    console.log();
    printFields([
      ["Saved to", pc.cyan(destinationPath)],
      ["Size", formatBytes(fileInfo.fileSize)],
      ["Total time", formatDuration(totalSeconds)],
      [
        "Average speed",
        networkBytes > 0
          ? `${formatBytes(averageSpeed)}/s`
          : "Already downloaded",
      ],
    ]);
    console.log();
  } catch (error) {
    transferProgress?.clear();
    spinner.fail(error instanceof Error ? error.message : "Download failed");
    if (workPaths) {
      printWarning("Run the same command again to resume this download.");
    }
    process.exitCode = 1;
  } finally {
    journal?.close();
  }
}
