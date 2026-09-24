import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, RetryableApiError } from "./api-client";

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

describe("OAuth device authorization", () => {
  it("starts a form-encoded device authorization request", async () => {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, _requestInit?: RequestInit) =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              device_code: "a".repeat(43),
              expires_in: 600,
              interval: 5,
              user_code: "ABCD-EFGH-JKMN-PQRS",
              verification_uri: "https://upshare.app/cli/authorize",
              verification_uri_complete:
                "https://upshare.app/cli/authorize?user_code=ABCD-EFGH-JKMN-PQRS",
            }),
            { headers: { "Content-Type": "application/json" }, status: 200 }
          )
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({ apiUrl: "https://upshare.app" });

    await client.requestDeviceAuthorization("CLI workstation");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://upshare.app/api/cli/device/authorization"
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/x-www-form-urlencoded"
    );
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("client_id")).toBe("upshare-cli");
    expect(body.get("device_name")).toBe("CLI workstation");
  });

  it("returns standards-shaped pending token responses", async () => {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, _requestInit?: RequestInit) =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: "authorization_pending",
              error_description: "Approval is pending.",
            }),
            { headers: { "Content-Type": "application/json" }, status: 400 }
          )
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({ apiUrl: "https://upshare.app" });

    await expect(client.requestDeviceToken("a".repeat(43))).resolves.toEqual({
      error: {
        error: "authorization_pending",
        error_description: "Approval is pending.",
      },
      status: "error",
    });

    const body = new URLSearchParams(
      String(fetchMock.mock.calls[0]?.[1]?.body)
    );
    expect(body.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code"
    );
    expect(body.get("device_code")).toBe("a".repeat(43));
  });

  it("rejects verification URLs from another origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              device_code: "a".repeat(43),
              expires_in: 600,
              interval: 5,
              user_code: "ABCD-EFGH-JKMN-PQRS",
              verification_uri: "https://attacker.example/authorize",
              verification_uri_complete:
                "https://attacker.example/authorize?user_code=ABCD",
            }),
            { headers: { "Content-Type": "application/json" }, status: 200 }
          )
        )
      )
    );
    const client = new ApiClient({ apiUrl: "https://upshare.app" });

    await expect(client.requestDeviceAuthorization()).rejects.toThrow(
      "untrusted verification URL"
    );
  });

  it("marks token endpoint server failures as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "temporarily unavailable" }), {
            headers: { "Content-Type": "application/json" },
            status: 503,
          })
        )
      )
    );
    const client = new ApiClient({ apiUrl: "https://upshare.app" });

    await expect(
      client.requestDeviceToken("a".repeat(43))
    ).rejects.toBeInstanceOf(RetryableApiError);
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

  it("passes f_-prefixed file ids through unchanged", async () => {
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    const fileId = `f_${"a".repeat(21)}`;
    const fetchMock = vi.fn((_url: string | URL | Request) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            file: {
              createdAt: "2026-09-06T00:00:00.000Z",
              expiresAt: "2026-09-07T00:00:00.000Z",
              fileName: "report.pdf",
              fileSize: 123,
              id: fileId,
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
    await expect(client.getFile(fileId)).resolves.toMatchObject({
      file: { id: fileId },
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://upshare.app/api/files/${encodeURIComponent(fileId)}`
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

  it("retries 409 in_progress honoring Retry-After, then succeeds", async () => {
    vi.useFakeTimers();
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error:
              "This upload is already being finalized. Please retry shortly.",
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "5",
            },
            status: 409,
          }
        )
      )
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

    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toMatchObject({ file: { id: "file-id" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("fails fast on 409 invalid_state without retrying", async () => {
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: "This upload cannot be finalized in its current state.",
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 409,
          }
        )
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ apiUrl: "https://upshare.app" });
    await expect(client.completeUpload("file-id")).rejects.toThrow(
      "This upload cannot be finalized in its current state."
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveDownload fallback", () => {
  const downloadPayload = {
    downloadUrl: "https://storage.example/file",
    expiresAt: "2026-09-06T00:00:00.000Z",
    fileId: "file-id",
    fileName: "report.pdf",
    fileSize: 123,
    mimeType: "application/pdf",
  };

  it("tries the token endpoint first and falls back to fileId", async () => {
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(downloadPayload), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ apiUrl: "https://upshare.app" });
    // 21-char bare share id: must still attempt the token path first.
    const longId = "a".repeat(21);
    const result = await client.resolveDownload(longId);

    expect(result).toMatchObject({ fileName: "report.pdf" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://upshare.app/api/files/download?token=${longId}`
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `https://upshare.app/api/files/download?fileId=${longId}`
    );
  });

  it("costs a single request when the token endpoint succeeds", async () => {
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    const fetchMock = vi.fn(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify(downloadPayload), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          })
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ apiUrl: "https://upshare.app" });
    await client.resolveDownload("https://upshare.app/s/abcdef1234567890");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("?token=");
  });

  it("tries fileId first for f_-prefixed ids with a single request", async () => {
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    const fileId = `f_${"a".repeat(21)}`;
    const fetchMock = vi.fn(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify(downloadPayload), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          })
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ apiUrl: "https://upshare.app" });
    const result = await client.resolveDownload(fileId);

    expect(result).toMatchObject({ fileName: "report.pdf" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://upshare.app/api/files/download?fileId=${encodeURIComponent(fileId)}`
    );
  });

  it("falls back to token when fileId-first misses for f_-prefixed ids", async () => {
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    const fileId = `f_${"a".repeat(21)}`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(downloadPayload), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ apiUrl: "https://upshare.app" });
    const result = await client.resolveDownload(fileId);

    expect(result).toMatchObject({ fileName: "report.pdf" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://upshare.app/api/files/download?fileId=${encodeURIComponent(fileId)}`
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `https://upshare.app/api/files/download?token=${encodeURIComponent(fileId)}`
    );
  });

  it("resolves a bare share token via the token endpoint in one request", async () => {
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    const token = "abcdef1234567890";
    const fetchMock = vi.fn(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(
          new Response(JSON.stringify(downloadPayload), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          })
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ apiUrl: "https://upshare.app" });
    await client.resolveDownload(token);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://upshare.app/api/files/download?token=${token}`
    );
  });

  it("retries a bare 21-char id once as f_-prefixed fileId after dual 404", async () => {
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    const bare = "b".repeat(21);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 404 }))
      .mockResolvedValueOnce(new Response("nope", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(downloadPayload), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ apiUrl: "https://upshare.app" });
    const result = await client.resolveDownload(bare);

    expect(result).toMatchObject({ fileName: "report.pdf" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://upshare.app/api/files/download?token=${bare}`
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `https://upshare.app/api/files/download?fileId=${bare}`
    );
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe(
      `https://upshare.app/api/files/download?fileId=${encodeURIComponent(`f_${bare}`)}`
    );
  });

  it("does not legacy-retry when either qualified attempt is non-404", async () => {
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    const bare = "c".repeat(21);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockResolvedValueOnce(new Response("denied", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ apiUrl: "https://upshare.app" });
    await expect(client.resolveDownload(bare)).rejects.toThrow(
      "Download resolution failed (403)"
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("share body contract", () => {
  it("omits extendMasterFile to match web behavior", async () => {
    process.env.UPSHARE_API_KEY = "ups_ci_secret";
    const fetchMock = vi.fn(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              capped: false,
              expiresAt: "2026-09-07T00:00:00.000Z",
              fileExpiresAt: "2026-09-08T00:00:00.000Z",
              fileId: "file-1",
              id: "share-1",
              shareUrl: "https://upshare.app/s/abcdef1234567890",
              token: "abcdef1234567890",
            }),
            { headers: { "Content-Type": "application/json" }, status: 200 }
          )
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ apiUrl: "https://upshare.app" });
    await client.createShare("file-1", 24);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ durationHours: 24 });
    expect(body).not.toHaveProperty("extendMasterFile");
  });
});

describe("device verification origin relaxation", () => {
  function authorizationPayload(origin: string) {
    return {
      device_code: "a".repeat(43),
      expires_in: 600,
      interval: 5,
      user_code: "ABCD-EFGH-JKMN-PQRS",
      verification_uri: `${origin}/cli/authorize`,
      verification_uri_complete: `${origin}/cli/authorize?user_code=ABCD-EFGH-JKMN-PQRS`,
    };
  }

  it("warns instead of throwing when the app origin differs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify(authorizationPayload("https://app.example.com")),
            { headers: { "Content-Type": "application/json" }, status: 200 }
          )
        )
      )
    );
    const client = new ApiClient({ apiUrl: "https://api.example.com" });

    const result = await client.requestDeviceAuthorization();

    expect(result.verification_uri).toBe(
      "https://app.example.com/cli/authorize"
    );
    expect(warn).toHaveBeenCalledOnce();
  });

  it("still rejects non-https verification URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify(authorizationPayload("http://upshare.app")),
            { headers: { "Content-Type": "application/json" }, status: 200 }
          )
        )
      )
    );
    const client = new ApiClient({ apiUrl: "https://upshare.app" });

    await expect(client.requestDeviceAuthorization()).rejects.toThrow(
      "untrusted verification URL"
    );
  });
});
