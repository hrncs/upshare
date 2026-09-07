import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api-client";

let configDirectory = "";

beforeEach(() => {
  configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "upshare-client-"));
  process.env.UPSHARE_CONFIG_DIR = configDirectory;
});

afterEach(() => {
  delete process.env.UPSHARE_API_KEY;
  delete process.env.UPSHARE_CONFIG_DIR;
  fs.rmSync(configDirectory, { force: true, recursive: true });
  vi.unstubAllGlobals();
});

describe("API client credentials", () => {
  it("reports the API origin when a connection fails", async () => {
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed")))
    );

    const client = new ApiClient({ apiUrl: "http://localhost:3000" });

    await expect(client.verifyApiKey()).rejects.toThrow(
      "Could not connect to http://localhost:3000."
    );
  });

  it("authenticates with UPSHARE_API_KEY without accessing the keyring", async () => {
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer ups_ci_secret"
        );
        return new Response(
          JSON.stringify({
            authType: "apiKey",
            quota: {
              maxQuotaBytes: 100,
              periodKey: "2026-09",
              remainingBytes: 100,
              reservedBytes: 0,
              usedBytes: 0,
            },
            user: {
              email: "ci@example.com",
              id: "user_ci",
              name: "CI",
            },
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }
        );
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ apiUrl: "https://upshare.app" });
    await expect(client.verifyApiKey()).resolves.toMatchObject({
      authType: "apiKey",
      user: { email: "ci@example.com" },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("requests a specific file-list page", async () => {
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    const fetchMock = vi.fn((_url: string | URL | Request) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            files: [],
            hasMore: false,
            page: 2,
            pageSize: 20,
            quota: {
              maxQuotaBytes: 100,
              periodKey: "2026-09",
              reservedBytes: 0,
              usedBytes: 0,
            },
            sort: "newest",
            totalFiles: 20,
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }
        )
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ apiUrl: "https://upshare.app" });
    await expect(
      client.listFiles({ page: 2, pageSize: 20 })
    ).resolves.toMatchObject({ hasMore: false, page: 2, pageSize: 20 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://upshare.app/api/files?limit=20&page=2"
    );
  });

  it("loads resumable multipart state", async () => {
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              expiresAt: "2026-09-07T00:00:00.000Z",
              fileId: "file-id",
              partCount: 2,
              partSize: 64,
              storageCompleted: false,
              uploadedParts: [{ etag: '"first"', partNumber: 1, size: 64 }],
              uploadType: "multipart",
            }),
            { headers: { "Content-Type": "application/json" }, status: 200 }
          )
        )
      )
    );

    const client = new ApiClient({ apiUrl: "https://upshare.app" });
    await expect(client.getMultipartUpload("file-id")).resolves.toMatchObject({
      uploadedParts: [{ partNumber: 1 }],
    });
  });
});

describe("single file lookup", () => {
  it("fetches one file with its share link", async () => {
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    const fetchMock = vi.fn((_url: string | URL | Request) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            file: {
              createdAt: "2026-09-06T00:00:00.000Z",
              expiresAt: "2026-09-07T00:00:00.000Z",
              fileName: "report.pdf",
              fileSize: 123,
              id: "file-1",
              mimeType: "application/pdf",
              status: "active",
            },
            shareLink: null,
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }
        )
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ apiUrl: "https://upshare.app" });
    await expect(client.getFile("file-1")).resolves.toMatchObject({
      file: { fileName: "report.pdf" },
      shareLink: null,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://upshare.app/api/files/file-1"
    );
  });

  it("returns null when the endpoint is missing or the file is gone", async () => {
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    for (const status of [404, 405]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            new Response("nope", {
              headers: { "Content-Type": "application/json" },
              status,
            })
          )
        )
      );
      const client = new ApiClient({ apiUrl: "https://upshare.app" });
      // biome-ignore lint/performance/noAwaitInLoops: statuses must resolve in order.
      await expect(client.getFile("file-1")).resolves.toBeNull();
    }
  });

  it("requests partial uploads with the uploading status", async () => {
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    const fetchMock = vi.fn((_url: string | URL | Request) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            files: [],
            hasMore: false,
            page: 1,
            pageSize: 20,
            quota: {
              maxQuotaBytes: 100,
              periodKey: "2026-09",
              reservedBytes: 0,
              usedBytes: 0,
            },
            sort: "newest",
            totalFiles: 0,
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }
        )
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ apiUrl: "https://upshare.app" });
    await client.listPendingUploads({ page: 1, pageSize: 20 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://upshare.app/api/files?limit=20&page=1&status=uploading"
    );
  });
});

describe("completeUpload retries", () => {
  it("retries on 500 error with backoff and succeeds on subsequent attempt", async () => {
    vi.useFakeTimers();
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("error", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            file: {
              createdAt: "2026-09-07T00:00:00.000Z",
              expiresAt: "2026-09-08T00:00:00.000Z",
              fileName: "test.bin",
              fileSize: 1024,
              id: "file-id",
              mimeType: "application/octet-stream",
              status: "active",
            },
            shareLink: null,
            success: true,
          }),
          { headers: { "Content-Type": "application/json" }, status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ apiUrl: "https://upshare.app" });
    const promise = client.completeUpload("file-id");

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toMatchObject({ file: { id: "file-id" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
