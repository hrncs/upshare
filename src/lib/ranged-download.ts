import fs from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { ApiClient } from "./api-client";
import type { DownloadJournal, DownloadState } from "./download-journal";
import type { DownloadResponse } from "./schemas";

const DOWNLOAD_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const URL_REFRESH_AGE_MS = 4 * 60 * 1000;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;

export interface RangedDownloadProgress {
  completedBytes: number;
  networkBytes: number;
}

export interface RangedDownloadResult {
  networkBytes: number;
  resumedBytes: number;
}

interface RangedDownloadOptions {
  client: ApiClient;
  concurrency: number;
  fileInfo: DownloadResponse;
  journal: DownloadJournal;
  onProgress: (progress: RangedDownloadProgress) => void;
  partPath: string;
  retries: number;
  state: DownloadState;
  target: string;
}

interface UrlProvider {
  get: () => Promise<string>;
  refreshAfterFailure: (failedUrl: string) => Promise<string>;
}

function getChunkBounds(
  chunkIndex: number,
  chunkSize: number,
  fileSize: number
): { end: number; length: number; start: number } {
  const start = chunkIndex * chunkSize;
  const end = Math.min(fileSize - 1, start + chunkSize - 1);
  return { end, length: end - start + 1, start };
}

function waitBeforeRetry(retryNumber: number): Promise<void> {
  const delay = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** (retryNumber - 1)
  );
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function assertSameFile(
  original: DownloadResponse,
  refreshed: DownloadResponse
): void {
  if (
    refreshed.fileId !== original.fileId ||
    refreshed.fileName !== original.fileName ||
    refreshed.fileSize !== original.fileSize
  ) {
    throw new Error("The refreshed download URL points to a different file.");
  }
}

function createUrlProvider(
  client: ApiClient,
  target: string,
  initial: DownloadResponse
): UrlProvider {
  let current = initial;
  let resolvedAt = Date.now();
  let refreshPromise: Promise<DownloadResponse> | undefined;

  const refresh = (): Promise<DownloadResponse> => {
    if (!refreshPromise) {
      refreshPromise = client
        .resolveDownload(target)
        .then((refreshed) => {
          assertSameFile(initial, refreshed);
          current = refreshed;
          resolvedAt = Date.now();
          return refreshed;
        })
        .finally(() => {
          refreshPromise = undefined;
        });
    }
    return refreshPromise;
  };

  return {
    async get() {
      if (Date.now() - resolvedAt >= URL_REFRESH_AGE_MS) {
        await refresh();
      }
      return current.downloadUrl;
    },
    async refreshAfterFailure(failedUrl) {
      if (current.downloadUrl === failedUrl) {
        await refresh();
      }
      return current.downloadUrl;
    },
  };
}

async function downloadChunkWithRetries(options: {
  chunkIndex: number;
  chunkSize: number;
  fileSize: number;
  getExpectedEtag: () => string | undefined;
  onProgress: (loaded: number, received: number) => void;
  partPath: string;
  retries: number;
  urls: UrlProvider;
}): Promise<string> {
  const attemptDownload = async (
    attempt: number,
    url: string
  ): Promise<string> => {
    try {
      const etag = await downloadChunk(
        url,
        options.partPath,
        options.chunkIndex,
        options.chunkSize,
        options.fileSize,
        options.getExpectedEtag(),
        options.onProgress
      );
      const expectedEtag = options.getExpectedEtag();
      if (expectedEtag && etag !== expectedEtag) {
        throw new Error("The remote file changed while it was downloading.");
      }
      return etag;
    } catch (error) {
      options.onProgress(0, 0);
      if (attempt >= options.retries) {
        throw error;
      }
      await waitBeforeRetry(attempt + 1);
      const refreshedUrl = await options.urls.refreshAfterFailure(url);
      return attemptDownload(attempt + 1, refreshedUrl);
    }
  };

  return attemptDownload(0, await options.urls.get());
}

async function downloadChunk(
  url: string,
  partPath: string,
  chunkIndex: number,
  chunkSize: number,
  fileSize: number,
  expectedEtag: string | undefined,
  onProgress: (loaded: number, received: number) => void
): Promise<string> {
  const { end, length, start } = getChunkBounds(
    chunkIndex,
    chunkSize,
    fileSize
  );
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!(response.status === 206 && response.body)) {
    await response.body?.cancel();
    throw new Error(`Storage download failed with HTTP ${response.status}.`);
  }

  const contentRange = response.headers.get("content-range");
  if (contentRange !== `bytes ${start}-${end}/${fileSize}`) {
    await response.body.cancel();
    throw new Error("Storage returned an invalid byte range.");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) !== length) {
    await response.body.cancel();
    throw new Error("Storage returned an invalid range size.");
  }
  const etag = response.headers.get("etag");
  if (!etag) {
    await response.body.cancel();
    throw new Error("Storage did not return a file ETag.");
  }
  if (expectedEtag && etag !== expectedEtag) {
    await response.body.cancel();
    throw new Error("The remote file changed while it was downloading.");
  }

  let loaded = 0;
  const progressStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const received = chunk.byteLength;
      loaded += received;
      onProgress(loaded, received);
      callback(null, chunk);
    },
  });
  const readable = Readable.fromWeb(
    response.body as unknown as NodeReadableStream<Uint8Array>
  );
  const writable = fs.createWriteStream(partPath, {
    flags: "r+",
    start,
  });
  await pipeline(readable, progressStream, writable);
  if (loaded !== length) {
    throw new Error(
      `Download range size mismatch: expected ${length} bytes, received ${loaded}.`
    );
  }
  return etag;
}

export async function downloadFileInRanges(
  options: RangedDownloadOptions
): Promise<RangedDownloadResult> {
  const {
    client,
    concurrency,
    fileInfo,
    journal,
    onProgress,
    partPath,
    retries,
    state,
    target,
  } = options;
  const chunkCount = Math.ceil(fileInfo.fileSize / state.chunkSize);
  const completedChunks = new Set(state.completedChunks);
  const resumedBytes = [...completedChunks].reduce(
    (total, chunkIndex) =>
      total +
      getChunkBounds(chunkIndex, state.chunkSize, fileInfo.fileSize).length,
    0
  );
  const pendingChunks = Array.from(
    { length: chunkCount },
    (_, chunkIndex) => chunkIndex
  ).filter((chunkIndex) => !completedChunks.has(chunkIndex));
  const inFlight = new Map<number, number>();
  const urls = createUrlProvider(client, target, fileInfo);
  let cursor = 0;
  let completedBytes = resumedBytes;
  let networkBytes = 0;
  let expectedEtag = state.etag;
  let failure: unknown;

  const reportProgress = () => {
    const inFlightBytes = [...inFlight.values()].reduce(
      (total, value) => total + value,
      0
    );
    onProgress({
      completedBytes: Math.min(
        fileInfo.fileSize,
        completedBytes + inFlightBytes
      ),
      networkBytes,
    });
  };
  reportProgress();

  const worker = async () => {
    if (failure || cursor >= pendingChunks.length) {
      return;
    }
    const chunkIndex = pendingChunks[cursor];
    cursor += 1;

    try {
      const etag = await downloadChunkWithRetries({
        chunkIndex,
        chunkSize: state.chunkSize,
        fileSize: fileInfo.fileSize,
        getExpectedEtag: () => expectedEtag,
        onProgress: (loaded, received) => {
          inFlight.set(chunkIndex, loaded);
          networkBytes += received;
          reportProgress();
        },
        partPath,
        retries,
        urls,
      });
      if (expectedEtag && etag !== expectedEtag) {
        throw new Error("The remote file changed while it was downloading.");
      }
      if (!expectedEtag) {
        journal.appendEtag(etag);
        expectedEtag = etag;
      }
      inFlight.delete(chunkIndex);
      journal.appendCompletedChunk(chunkIndex);
      completedChunks.add(chunkIndex);
      completedBytes += getChunkBounds(
        chunkIndex,
        state.chunkSize,
        fileInfo.fileSize
      ).length;
      reportProgress();
    } catch (error) {
      inFlight.delete(chunkIndex);
      reportProgress();
      failure ??= error;
    }

    await worker();
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pendingChunks.length) }, worker)
  );
  if (failure) {
    throw failure instanceof Error ? failure : new Error("Download failed.");
  }
  return { networkBytes, resumedBytes };
}
