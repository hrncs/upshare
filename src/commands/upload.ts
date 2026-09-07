import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import pc from "picocolors";
import { ApiClient } from "../lib/api-client";
import { getEffectiveApiUrl } from "../lib/config";
import { formatBytes, formatDuration } from "../lib/format";
import { printError, printFields, printWarning } from "../lib/output";
import type {
  CompletedUploadPart,
  MultipartResumeResponse,
  UploadPartUrl,
  UploadRequestResponse,
} from "../lib/schemas";
import { createSpinner } from "../lib/spinner";
import {
  createTransferProgressLine,
  type TransferProgressLine,
} from "../lib/transfer-progress";
import {
  clearUploadState,
  loadUploadState,
  saveUploadState,
} from "../lib/upload-state";
import { parseDurationHours, parseIntegerRange } from "../lib/validation";

const MIME_MAP: Record<string, string> = {
  ".7z": "application/x-7z-compressed",
  ".css": "text/css",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript",
  ".json": "application/json",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tar": "application/x-tar",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".zip": "application/zip",
};
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024 * 1024;
const DEFAULT_MULTIPART_CONCURRENCY = 16;
const MAX_MULTIPART_CONCURRENCY = 16;
const DEFAULT_RETRIES = 5;
const MAX_RETRIES = 20;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;

type MultipartPreparation = Extract<
  UploadRequestResponse | MultipartResumeResponse,
  { uploadType: "multipart" }
>;

interface MultipartUploadResult {
  networkBytes: number;
  parts: CompletedUploadPart[];
  resumedBytes: number;
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

function waitBeforeRetry(retryNumber: number): Promise<void> {
  const delay = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** (retryNumber - 1)
  );
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export async function uploadFileRange(
  uploadUrl: string,
  filePath: string,
  start: number,
  length: number,
  options?: {
    contentType?: string;
    onProgress?: (loaded: number) => void;
  }
): Promise<string> {
  const fileStream = fs.createReadStream(filePath, {
    end: start + length - 1,
    start,
  });
  let loaded = 0;
  const progressStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      loaded += chunk.byteLength;
      options?.onProgress?.(loaded);
      callback(null, chunk);
    },
  });
  try {
    const response = await fetch(uploadUrl, {
      body: fileStream.pipe(progressStream),
      duplex: "half",
      headers: {
        "Content-Length": String(length),
        ...(options?.contentType
          ? { "Content-Type": options.contentType }
          : {}),
      },
      method: "PUT",
      signal: AbortSignal.timeout(6 * 60 * 60 * 1000),
    } as unknown as RequestInit & { duplex: "half" });
    if (!response.ok) {
      throw new Error(`Storage upload failed with HTTP ${response.status}.`);
    }
    return response.headers.get("etag") ?? "";
  } finally {
    fileStream.destroy();
    progressStream.destroy();
  }
}

async function uploadMultipartPart(
  client: ApiClient,
  preparation: MultipartPreparation,
  signedPart: UploadPartUrl,
  filePath: string,
  fileSize: number,
  retries: number,
  onProgress: (partNumber: number, loaded: number, sentBytes: number) => void
): Promise<CompletedUploadPart> {
  const start = (signedPart.partNumber - 1) * preparation.partSize;
  const length = Math.min(preparation.partSize, fileSize - start);
  let { uploadUrl } = signedPart;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let previousLoaded = 0;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: sequential
      const etag = await uploadFileRange(uploadUrl, filePath, start, length, {
        onProgress: (loaded) => {
          onProgress(
            signedPart.partNumber,
            loaded,
            Math.max(0, loaded - previousLoaded)
          );
          previousLoaded = loaded;
        },
      });
      if (!etag) {
        throw new Error("Storage did not return the uploaded part ETag.");
      }
      return { etag, partNumber: signedPart.partNumber };
    } catch (error) {
      lastError = error;
      onProgress(signedPart.partNumber, 0, 0);
      if (attempt < retries) {
        await waitBeforeRetry(attempt + 1);
        const [replacement] = await client.requestUploadPartUrls(
          preparation.fileId,
          [signedPart.partNumber]
        );
        ({ uploadUrl } = replacement);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Multipart upload failed.");
}

function getPartSize(
  fileSize: number,
  partSize: number,
  partNumber: number
): number {
  const start = (partNumber - 1) * partSize;
  return Math.min(partSize, fileSize - start);
}

async function uploadMultipartFile(
  client: ApiClient,
  preparation: MultipartPreparation,
  filePath: string,
  fileSize: number,
  concurrency: number,
  retries: number,
  initialParts: CompletedUploadPart[],
  onProgress: (completedBytes: number, networkBytes: number) => void
): Promise<MultipartUploadResult> {
  const completedParts = new Map(
    initialParts.map(({ etag, partNumber }) => [
      partNumber,
      { etag, partNumber },
    ])
  );
  const resumedBytes = [...completedParts.keys()].reduce(
    (total, partNumber) =>
      total + getPartSize(fileSize, preparation.partSize, partNumber),
    0
  );
  let completedBytes = resumedBytes;
  let networkBytes = 0;
  const progressByPart = new Map<number, number>();
  const pendingPartNumbers = Array.from(
    { length: preparation.partCount },
    (_, index) => index + 1
  ).filter((partNumber) => !completedParts.has(partNumber));

  const reportProgress = () => {
    const inFlightBytes = [...progressByPart.values()].reduce(
      (total, value) => total + value,
      0
    );
    onProgress(
      Math.min(fileSize, completedBytes + inFlightBytes),
      networkBytes
    );
  };
  reportProgress();

  for (
    let firstPending = 0;
    firstPending < pendingPartNumbers.length;
    firstPending += concurrency
  ) {
    const partNumbers = pendingPartNumbers.slice(
      firstPending,
      firstPending + concurrency
    );
    // biome-ignore lint/performance/noAwaitInLoops: sequential
    const signedParts = await client.requestUploadPartUrls(
      preparation.fileId,
      partNumbers
    );
    const uploadResults = await Promise.allSettled(
      signedParts.map((part) =>
        uploadMultipartPart(
          client,
          preparation,
          part,
          filePath,
          fileSize,
          retries,
          (partNumber, loaded, sentBytes) => {
            progressByPart.set(partNumber, loaded);
            networkBytes += sentBytes;
            reportProgress();
          }
        )
      )
    );
    const failedPart = uploadResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failedPart) {
      throw failedPart.reason;
    }
    for (const result of uploadResults) {
      const part = (result as PromiseFulfilledResult<CompletedUploadPart>)
        .value;
      completedParts.set(part.partNumber, part);
      progressByPart.delete(part.partNumber);
      completedBytes += getPartSize(
        fileSize,
        preparation.partSize,
        part.partNumber
      );
    }
    reportProgress();
  }

  return {
    networkBytes,
    parts: [...completedParts.values()].sort(
      (left, right) => left.partNumber - right.partNumber
    ),
    resumedBytes,
  };
}

async function uploadSingleFile(
  uploadUrl: string,
  filePath: string,
  fileSize: number,
  mimeType: string,
  retries: number,
  onProgress: (completedBytes: number, networkBytes: number) => void
): Promise<number> {
  let networkBytes = 0;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let previousLoaded = 0;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: sequential
      await uploadFileRange(uploadUrl, filePath, 0, fileSize, {
        contentType: mimeType,
        onProgress: (loaded) => {
          networkBytes += Math.max(0, loaded - previousLoaded);
          previousLoaded = loaded;
          onProgress(loaded, networkBytes);
        },
      });
      return networkBytes;
    } catch (error) {
      lastError = error;
      onProgress(0, networkBytes);
      if (attempt < retries) {
        await waitBeforeRetry(attempt + 1);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Upload failed.");
}

export interface UploadCommandOptions {
  apiUrl?: string;
  concurrency?: string;
  hours?: string;
  retries?: string;
  share?: boolean;
  shareDuration?: string;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: command handler
export async function uploadCommand(
  filePath: string,
  options?: UploadCommandOptions
): Promise<void> {
  const commandStartedAt = Date.now();
  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    printError(`File not found at ${resolvedPath}`);
    process.exitCode = 1;
    return;
  }

  const stat = fs.statSync(resolvedPath);
  if (stat.isDirectory()) {
    printError(
      "Directories are not supported directly. Zip the directory first."
    );
    process.exitCode = 1;
    return;
  }

  const fileName = path.basename(resolvedPath);
  const fileSize = stat.size;
  const mimeType = getMimeType(resolvedPath);
  let expiryHours: number;
  let shareDurationHours: number | undefined;
  let concurrency: number;
  let retries: number;
  try {
    expiryHours = parseDurationHours(options?.hours, 24, 1);
    shareDurationHours = options?.shareDuration
      ? parseDurationHours(options.shareDuration, 24, 0.5)
      : undefined;
    concurrency = parseIntegerRange(
      options?.concurrency,
      DEFAULT_MULTIPART_CONCURRENCY,
      1,
      MAX_MULTIPART_CONCURRENCY,
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
      error instanceof Error ? error.message : "Invalid upload option"
    );
    process.exitCode = 1;
    return;
  }

  if (fileSize <= 0) {
    printError("Empty files cannot be uploaded.");
    process.exitCode = 1;
    return;
  }
  if (fileSize > MAX_FILE_SIZE_BYTES) {
    printError("File exceeds the 50 GiB per-file limit.");
    process.exitCode = 1;
    return;
  }

  const apiUrl = getEffectiveApiUrl(options?.apiUrl);
  const client = new ApiClient({ apiUrl });
  const spinner = createSpinner(
    `Preparing ${pc.bold(fileName)} (${formatBytes(fileSize)})...`
  ).start();
  const expectedState = {
    apiUrl,
    filePath: resolvedPath,
    fileSize,
    modifiedAt: stat.mtimeMs,
  };
  let preparation: UploadRequestResponse | MultipartResumeResponse | null =
    null;
  let networkBytes = 0;
  let resumedBytes = 0;
  let transferProgress: TransferProgressLine | undefined;

  const showProgress = (completedBytes: number, sentBytes: number) => {
    networkBytes = sentBytes;
    transferProgress?.update(completedBytes, sentBytes);
  };

  try {
    const savedState = loadUploadState(expectedState, {
      onInvalidated: (reason) => {
        if (reason === "modified") {
          printWarning(
            "Local file was modified since previous partial upload. Run 'upshare abort' to free unused server quota."
          );
        }
      },
    });
    if (savedState) {
      spinner.text = "Checking resumable upload...";
      preparation = await client.getMultipartUpload(savedState.fileId);
      if (!preparation) {
        clearUploadState(apiUrl, resolvedPath);
      }
    }

    if (!preparation) {
      preparation = await client.requestUpload({
        expiryHours,
        fileName,
        fileSize,
        mimeType,
      });
      if (preparation.uploadType === "multipart") {
        saveUploadState({ ...expectedState, fileId: preparation.fileId });
      }
    }

    spinner.stop();
    transferProgress = createTransferProgressLine({
      action: "Uploading",
      startedAt: Date.now(),
      totalBytes: fileSize,
    });

    let completedParts: CompletedUploadPart[] | undefined;
    if (preparation.uploadType === "single") {
      networkBytes = await uploadSingleFile(
        preparation.uploadUrl,
        resolvedPath,
        fileSize,
        mimeType,
        retries,
        showProgress
      );
    } else if (
      "storageCompleted" in preparation &&
      preparation.storageCompleted
    ) {
      resumedBytes = fileSize;
      completedParts = [];
      showProgress(fileSize, 0);
    } else {
      const initialParts =
        "uploadedParts" in preparation ? preparation.uploadedParts : [];
      const result = await uploadMultipartFile(
        client,
        preparation,
        resolvedPath,
        fileSize,
        concurrency,
        retries,
        initialParts,
        showProgress
      );
      ({ networkBytes, resumedBytes } = result);
      completedParts = result.parts;
    }

    transferProgress.clear();
    transferProgress = undefined;
    spinner.start("Verifying...");
    const completeRes = await client.completeUpload(preparation.fileId, {
      createShareLink: options?.share !== false,
      parts: completedParts,
      shareDurationHours,
    });
    clearUploadState(apiUrl, resolvedPath);

    spinner.succeed(`Uploaded ${fileName}`);

    const expiryDate = new Date(completeRes.file.expiresAt).toLocaleString();
    const totalSeconds = (Date.now() - commandStartedAt) / 1000;
    const averageSpeed = networkBytes / Math.max(totalSeconds, 0.001);

    console.log();
    const fields: [string, string][] = [
      ["File ID", pc.cyan(preparation.fileId)],
      ["Size", formatBytes(fileSize)],
      ["Total time", formatDuration(totalSeconds)],
      [
        "Average speed",
        networkBytes > 0
          ? `${formatBytes(averageSpeed)}/s`
          : "Already uploaded",
      ],
    ];
    if (resumedBytes > 0 && resumedBytes < fileSize) {
      fields.push(["Resumed from", formatBytes(resumedBytes)]);
    }
    fields.push(["Expires", expiryDate]);

    if (completeRes.shareUrl) {
      fields.push([
        "Share link",
        pc.underline(pc.bold(pc.cyan(completeRes.shareUrl))),
      ]);
      if (options?.shareDuration && completeRes.shareLink?.expiresAt) {
        const linkExpiry = new Date(
          completeRes.shareLink.expiresAt
        ).toLocaleString();
        fields.push(["Link expiry", linkExpiry]);
      }
    } else {
      fields.push(["Share link", pc.dim("Private")]);
    }
    printFields(fields);
    console.log();
  } catch (error) {
    transferProgress?.clear();
    if (preparation?.uploadType === "single") {
      await client.deleteFile(preparation.fileId).catch(() => undefined);
    }
    spinner.fail(error instanceof Error ? error.message : "Upload failed");
    if (preparation?.uploadType === "multipart") {
      printWarning("Run the same command again to resume this upload.");
    }
    process.exitCode = 1;
  }
}
