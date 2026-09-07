import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api-client";
import {
  createDownloadJournal,
  type DownloadJournal,
  type DownloadState,
  loadDownloadState,
  openDownloadJournal,
} from "./download-journal";
import { downloadFileInRanges } from "./ranged-download";
import type { DownloadResponse } from "./schemas";

let outputDirectory = "";
const RANGE_HEADER_REGEX = /^bytes=(\d+)-(\d+)$/;

const fileInfo: DownloadResponse = {
  downloadUrl: "https://storage.example/first",
  expiresAt: "2026-09-07T12:00:00.000Z",
  fileId: "file-id",
  fileName: "file.bin",
  fileSize: 10,
  mimeType: "application/octet-stream",
};

beforeEach(() => {
  outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "upshare-range-download-")
  );
});

afterEach(() => {
  fs.rmSync(outputDirectory, { force: true, recursive: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function preparePartialFile(state: DownloadState): {
  journal: DownloadJournal;
  journalPath: string;
  partPath: string;
} {
  const partPath = path.join(outputDirectory, "file.part");
  const journalPath = path.join(outputDirectory, "file.resume.log");
  fs.writeFileSync(partPath, Buffer.alloc(state.fileSize));
  const journal = createDownloadJournal(journalPath, {
    chunkSize: state.chunkSize,
    fileId: state.fileId,
    fileName: state.fileName,
    fileSize: state.fileSize,
  });
  if (state.etag) {
    journal.appendEtag(state.etag);
  }
  for (const chunkIndex of state.completedChunks) {
    journal.appendCompletedChunk(chunkIndex);
  }
  return { journal, journalPath, partPath };
}

function createRangeResponse(contents: Buffer, range: string): Response {
  const match = RANGE_HEADER_REGEX.exec(range);
  if (!match) {
    return new Response(null, { status: 400 });
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const body = contents.subarray(start, end + 1);
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Length": String(body.byteLength),
      "Content-Range": `bytes ${start}-${end}/${contents.byteLength}`,
      ETag: '"file-etag"',
    },
    status: 206,
  });
}

describe("ranged downloads", () => {
  it("downloads pending ranges concurrently and preserves completed ranges", async () => {
    const contents = Buffer.from("abcdefghij");
    const state: DownloadState = {
      chunkSize: 4,
      completedChunks: [0],
      etag: '"file-etag"',
      fileId: fileInfo.fileId,
      fileName: fileInfo.fileName,
      fileSize: fileInfo.fileSize,
    };
    const paths = preparePartialFile(state);
    const descriptor = fs.openSync(paths.partPath, "r+");
    try {
      fs.writeSync(descriptor, contents.subarray(0, 4), 0);
    } finally {
      fs.closeSync(descriptor);
    }
    const requestedRanges: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const range = new Headers(init?.headers).get("Range") ?? "";
        requestedRanges.push(range);
        const match = RANGE_HEADER_REGEX.exec(range);
        if (!match) {
          return Promise.resolve(new Response(null, { status: 400 }));
        }
        const start = Number(match[1]);
        const end = Number(match[2]);
        const body = contents.subarray(start, end + 1);
        return Promise.resolve(
          new Response(body, {
            headers: {
              "Content-Length": String(body.byteLength),
              "Content-Range": `bytes ${start}-${end}/${contents.byteLength}`,
              ETag: '"file-etag"',
            },
            status: 206,
          })
        );
      })
    );
    const client = new ApiClient({
      apiKey: "ups_test",
      apiUrl: "https://upshare.app",
    });
    const progress = vi.fn();

    const result = await downloadFileInRanges({
      client,
      concurrency: 2,
      fileInfo,
      journal: paths.journal,
      onProgress: progress,
      partPath: paths.partPath,
      retries: 0,
      state,
      target: fileInfo.fileId,
    });
    paths.journal.close();

    expect(result).toEqual({ networkBytes: 6, resumedBytes: 4 });
    expect(new Set(requestedRanges)).toEqual(
      new Set(["bytes=4-7", "bytes=8-9"])
    );
    expect(fs.readFileSync(paths.partPath)).toEqual(contents);
    expect(
      new Set(loadDownloadState(paths.journalPath)?.completedChunks)
    ).toEqual(new Set([0, 1, 2]));
    expect(progress).toHaveBeenLastCalledWith({
      completedBytes: 10,
      networkBytes: 6,
    });
  });

  it("refreshes the signed URL and retries a failed range", async () => {
    const contents = Buffer.from("xy");
    const retryFileInfo = { ...fileInfo, fileSize: contents.byteLength };
    const state: DownloadState = {
      chunkSize: contents.byteLength,
      completedChunks: [],
      fileId: retryFileInfo.fileId,
      fileName: retryFileInfo.fileName,
      fileSize: retryFileInfo.fileSize,
    };
    const paths = preparePartialFile(state);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(contents, {
          headers: {
            "Content-Length": String(contents.byteLength),
            "Content-Range": "bytes 0-1/2",
            ETag: '"file-etag"',
          },
          status: 206,
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiKey: "ups_test",
      apiUrl: "https://upshare.app",
    });
    const refresh = vi.spyOn(client, "resolveDownload").mockResolvedValue({
      ...retryFileInfo,
      downloadUrl: "https://storage.example/refreshed",
    });

    await expect(
      downloadFileInRanges({
        client,
        concurrency: 1,
        fileInfo: retryFileInfo,
        journal: paths.journal,
        onProgress: vi.fn(),
        partPath: paths.partPath,
        retries: 1,
        state,
        target: retryFileInfo.fileId,
      })
    ).resolves.toEqual({ networkBytes: contents.byteLength, resumedBytes: 0 });
    paths.journal.close();
    expect(refresh).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://storage.example/refreshed"
    );
    expect(fs.readFileSync(paths.partPath)).toEqual(contents);
  });

  it("resumes completed ranges in a second run after interruption", async () => {
    const contents = Buffer.from("abcdefghijkl");
    const interruptedFileInfo = { ...fileInfo, fileSize: contents.byteLength };
    const initialState: DownloadState = {
      chunkSize: 3,
      completedChunks: [],
      fileId: interruptedFileInfo.fileId,
      fileName: interruptedFileInfo.fileName,
      fileSize: interruptedFileInfo.fileSize,
    };
    const paths = preparePartialFile(initialState);
    const firstRunRanges: string[] = [];
    const secondRunRanges: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const range = new Headers(init?.headers).get("Range") ?? "";
        firstRunRanges.push(range);
        if (range === "bytes=6-8") {
          return Promise.resolve(new Response(null, { status: 503 }));
        }
        return Promise.resolve(createRangeResponse(contents, range));
      })
    );
    const client = new ApiClient({
      apiKey: "ups_test",
      apiUrl: "https://upshare.app",
    });

    await expect(
      downloadFileInRanges({
        client,
        concurrency: 1,
        fileInfo: interruptedFileInfo,
        journal: paths.journal,
        onProgress: vi.fn(),
        partPath: paths.partPath,
        retries: 0,
        state: initialState,
        target: interruptedFileInfo.fileId,
      })
    ).rejects.toThrow("HTTP 503");
    paths.journal.close();
    expect(loadDownloadState(paths.journalPath)?.completedChunks).toEqual([
      0, 1,
    ]);

    const resumedState = loadDownloadState(paths.journalPath);
    if (!resumedState) {
      throw new Error("Expected the interrupted download checkpoint.");
    }
    const resumedJournal = openDownloadJournal(paths.journalPath);
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const range = new Headers(init?.headers).get("Range") ?? "";
        secondRunRanges.push(range);
        return Promise.resolve(createRangeResponse(contents, range));
      })
    );
    const result = await downloadFileInRanges({
      client,
      concurrency: 1,
      fileInfo: interruptedFileInfo,
      journal: resumedJournal,
      onProgress: vi.fn(),
      partPath: paths.partPath,
      retries: 0,
      state: resumedState,
      target: interruptedFileInfo.fileId,
    });
    resumedJournal.close();

    expect(firstRunRanges).toEqual(["bytes=0-2", "bytes=3-5", "bytes=6-8"]);
    expect(secondRunRanges).toEqual(["bytes=6-8", "bytes=9-11"]);
    expect(result).toEqual({ networkBytes: 6, resumedBytes: 6 });
    expect(fs.readFileSync(paths.partPath)).toEqual(contents);
    expect(loadDownloadState(paths.journalPath)?.completedChunks).toEqual([
      0, 1, 2, 3,
    ]);
  });
});
