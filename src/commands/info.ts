import pc from "picocolors";
import { ApiClient } from "../lib/api-client";
import {
  cleanIdentifier,
  formatBytes,
  formatRelativeTime,
} from "../lib/format";
import { printError, printFields, printHeading } from "../lib/output";
import type { FileInfoResponse, MultipartResumeResponse } from "../lib/schemas";
import { createSpinner } from "../lib/spinner";

function printPartialInfo(
  fileId: string,
  fileSize: number,
  resume: MultipartResumeResponse | null
): void {
  printHeading("Partial upload");
  if (!resume) {
    printFields([
      ["ID", fileId],
      ["Size", formatBytes(fileSize)],
      ["Progress", "Waiting to finish - retry the upload to continue"],
      ["Free space", "upshare abort"],
    ]);
    console.log();
    return;
  }
  if (resume.storageCompleted) {
    printFields([
      ["ID", resume.fileId],
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
  const percent = Math.min(100, Math.round((doneBytes / fileSize) * 1000) / 10);
  printFields([
    ["ID", resume.fileId],
    ["Size", formatBytes(fileSize)],
    ["Progress", `${resume.uploadedParts.length}/${resume.partCount} parts`],
    [
      "Transferred",
      `${formatBytes(doneBytes)} of ${formatBytes(fileSize)} (${percent}%)`,
    ],
    ["Resume", "Run the same upload command again to continue"],
    ["Free space", "upshare abort"],
  ]);
  console.log();
}

export async function infoCommand(
  target: string,
  options?: { apiUrl?: string }
): Promise<void> {
  const id = cleanIdentifier(target);
  if (!id) {
    printError("File identifier or share token is required.");
    process.exitCode = 1;
    return;
  }

  const client = new ApiClient({ apiUrl: options?.apiUrl });
  const spinner = createSpinner("Fetching file info...").start();

  try {
    const data: FileInfoResponse | null = await client.getFile(id);
    spinner.stop();
    if (!data) {
      printError(`No file found for '${id}'.`);
      process.exitCode = 1;
      return;
    }

    if (data.file.status === "uploading") {
      const resume = await client
        .getMultipartUpload(data.file.id)
        .catch(() => null);
      printPartialInfo(data.file.id, data.file.fileSize, resume);
      return;
    }

    printHeading(data.file.fileName);
    const fields: [string, string][] = [
      ["ID", data.file.id],
      ["Size", formatBytes(data.file.fileSize)],
      ["Type", data.file.mimeType],
      ["Status", "Active"],
      ["Uploaded", new Date(data.file.createdAt).toLocaleString()],
      [
        "Expires",
        `${new Date(data.file.expiresAt).toLocaleString()} (${formatRelativeTime(data.file.expiresAt)})`,
      ],
    ];
    if (data.shareLink) {
      fields.push(
        ["Share link", pc.cyan(pc.bold(data.shareLink.shareUrl))],
        ["Token", data.shareLink.token],
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
