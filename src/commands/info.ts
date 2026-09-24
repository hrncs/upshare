import pc from "picocolors";
import { ApiClient, RetryableApiError } from "../lib/api-client";
import {
  cleanIdentifier,
  formatBytes,
  formatRelativeTime,
  sanitizeTerminalText,
} from "../lib/format";
import { printError, printFields, printHeading } from "../lib/output";
import type { FileInfoResponse, MultipartResumeResponse } from "../lib/schemas";
import { createSpinner } from "../lib/spinner";

const RETRYABLE_INFO_ERROR_PATTERN =
  /401|403|unauthor|forbidden|connect|network|timed?\s?out/i;

function printPartialInfo(
  fileId: string,
  fileSize: number,
  resume: MultipartResumeResponse | null
): void {
  const hint =
    "Run the same upload command to continue; `upshare abort` frees the space.";
  printHeading("Partial upload");
  if (!resume) {
    printFields([
      ["ID", sanitizeTerminalText(fileId)],
      ["Size", formatBytes(fileSize)],
      ["Progress", "Waiting to finish - retry the upload to continue"],
      ["Hint", hint],
    ]);
    console.log();
    return;
  }
  if (resume.storageCompleted) {
    printFields([
      ["ID", sanitizeTerminalText(resume.fileId)],
      ["Size", formatBytes(fileSize)],
      ["Progress", "All bytes received, not finalized yet"],
      ["Resume", "Run the same upload command again to continue"],
    ]);
    console.log();
    return;
  }
  const doneBytes = resume.uploadedParts.reduce(
    (total, part) => total + part.size,
    0
  );
  const percent =
    fileSize > 0
      ? Math.min(100, Math.round((doneBytes / fileSize) * 1000) / 10)
      : 0;
  printFields([
    ["ID", sanitizeTerminalText(resume.fileId)],
    ["Size", formatBytes(fileSize)],
    ["Progress", `${resume.uploadedParts.length}/${resume.partCount} parts`],
    [
      "Transferred",
      `${formatBytes(doneBytes)} of ${formatBytes(fileSize)} (${percent}%)`,
    ],
    ["Resume", "Run the same upload command again to continue"],
    ["Hint", hint],
  ]);
  console.log();
}

function formatStatus(status: string): string {
  if (!status) {
    return "Active";
  }
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export async function infoCommand(
  target: string,
  options?: { apiUrl?: string; profile?: string }
): Promise<void> {
  const id = cleanIdentifier(target);
  if (!id) {
    printError("File identifier or share token is required.");
    process.exitCode = 1;
    return;
  }

  const client = new ApiClient({
    apiUrl: options?.apiUrl,
    profile: options?.profile,
  });
  const spinner = createSpinner("Fetching file info...").start();

  try {
    const data: FileInfoResponse | null = await client.getFile(id);
    spinner.stop();
    if (!data) {
      printError(`No file found for '${id}'.`);
      process.exitCode = 1;
      return;
    }

    if (data.file.status === "uploading" || data.file.status === "finalizing") {
      let resume: MultipartResumeResponse | null = null;
      try {
        resume = await client.getMultipartUpload(data.file.id);
      } catch (error) {
        if (error instanceof RetryableApiError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : "";
        if (RETRYABLE_INFO_ERROR_PATTERN.test(message)) {
          throw error;
        }
        resume = null;
      }
      printPartialInfo(data.file.id, data.file.fileSize, resume);
      return;
    }

    printHeading(sanitizeTerminalText(data.file.fileName));
    const fields: [string, string][] = [
      ["ID", sanitizeTerminalText(data.file.id)],
      ["Size", formatBytes(data.file.fileSize)],
      ["Type", sanitizeTerminalText(data.file.mimeType)],
      ["Status", formatStatus(data.file.status)],
      ["Uploaded", new Date(data.file.createdAt).toLocaleString()],
      [
        "Expires",
        `${new Date(data.file.expiresAt).toLocaleString()} (${formatRelativeTime(data.file.expiresAt)})`,
      ],
    ];
    if (data.shareLink) {
      fields.push(
        ["Share link", pc.cyan(pc.bold(data.shareLink.shareUrl))],
        ["Token", sanitizeTerminalText(data.shareLink.token)],
        ["Views", String(data.shareLink.viewsCount)]
      );
    } else {
      fields.push(["Sharing", pc.dim("Private")]);
    }
    printFields(fields);
    console.log();
  } catch (error) {
    spinner.fail(
      error instanceof Error ? error.message : "Failed to fetch file info"
    );
    process.exitCode = 1;
  }
}
