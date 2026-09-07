import { describe, expect, it } from "vitest";
import {
  downloadResponseSchema,
  healthResponseSchema,
  listFilesResponseSchema,
  multipartResumeResponseSchema,
  uploadRequestResponseSchema,
} from "./schemas";

const download = {
  downloadUrl: "https://storage.example/file",
  expiresAt: "2026-09-06T00:00:00.000Z",
  fileId: "file-id",
  fileName: "report.pdf",
  fileSize: 123,
  mimeType: "application/pdf",
};

describe("downloadResponseSchema", () => {
  it("accepts a safe response", () => {
    expect(downloadResponseSchema.parse(download).fileName).toBe("report.pdf");
  });

  it.each(["../secret", "folder/file", "folder\\file", ".", ".."])(
    "rejects unsafe server file name %j",
    (fileName) => {
      expect(
        downloadResponseSchema.safeParse({ ...download, fileName }).success
      ).toBe(false);
    }
  );
});

describe("healthResponseSchema", () => {
  it("accepts ok, degraded, and unavailable payloads", () => {
    for (const status of ["ok", "degraded", "unavailable"]) {
      const result = healthResponseSchema.parse({
        checks: {
          database: { latencyMs: 12, status: "ok" },
          storage: { latencyMs: 34, status: "ok" },
        },
        status,
      });
      expect(result.status).toBe(status);
      expect(result.checks?.database.latencyMs).toBe(12);
    }
  });

  it("accepts legacy payloads without per-check details", () => {
    expect(healthResponseSchema.parse({ status: "ok" }).checks).toBeUndefined();
  });

  it("omits latency for failed checks", () => {
    const result = healthResponseSchema.parse({
      checks: {
        database: { latencyMs: 12, status: "ok" },
        storage: { status: "unavailable" },
      },
      status: "degraded",
    });
    expect(result.checks?.storage.latencyMs).toBeUndefined();
  });
});

describe("listFilesResponseSchema", () => {
  it("does not expose server-only storage fields", () => {
    const result = listFilesResponseSchema.parse({
      files: [
        {
          ...download,
          createdAt: download.expiresAt,
          id: download.fileId,
          shareLink: null,
          status: "active",
          storageKey: "secret/storage/key",
          userId: "user-id",
        },
      ],
      hasMore: true,
      page: 2,
      pageSize: 20,
      quota: {
        maxQuotaBytes: 1000,
        periodKey: "2026-09",
        reservedBytes: 0,
        usedBytes: 123,
      },
      sort: "newest",
      totalFiles: 42,
    });
    expect(result.files[0]).not.toHaveProperty("storageKey");
    expect(result.files[0]).not.toHaveProperty("userId");
    expect(result).toMatchObject({
      hasMore: true,
      page: 2,
      pageSize: 20,
      totalFiles: 42,
    });
  });
});

describe("uploadRequestResponseSchema", () => {
  const base = {
    expiresAt: "2026-09-06T00:00:00.000Z",
    fileId: "file-id",
  };

  it("accepts both upload modes", () => {
    expect(
      uploadRequestResponseSchema.safeParse({
        ...base,
        uploadType: "single",
        uploadUrl: "https://storage.example/upload",
      }).success
    ).toBe(true);
    expect(
      uploadRequestResponseSchema.safeParse({
        ...base,
        partCount: 2,
        partSize: 64 * 1024 * 1024,
        uploadType: "multipart",
      }).success
    ).toBe(true);
  });

  it("normalizes the legacy single-upload response", () => {
    const result = uploadRequestResponseSchema.safeParse({
      ...base,
      uploadUrl: "https://storage.example/upload",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.uploadType).toBe("single");
    }
  });

  it("rejects incomplete multipart metadata", () => {
    expect(
      uploadRequestResponseSchema.safeParse({
        ...base,
        uploadType: "multipart",
      }).success
    ).toBe(false);
  });

  it("accepts resumable multipart state", () => {
    expect(
      multipartResumeResponseSchema.safeParse({
        ...base,
        partCount: 2,
        partSize: 64 * 1024 * 1024,
        storageCompleted: false,
        uploadedParts: [{ etag: '"etag"', partNumber: 1, size: 64 }],
        uploadType: "multipart",
      }).success
    ).toBe(true);
  });
});
