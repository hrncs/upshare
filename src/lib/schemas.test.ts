import { describe, expect, it } from "vitest";
import {
  downloadResponseSchema,
  fileIdSchema,
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

describe("fileIdSchema", () => {
  it("accepts f_-prefixed and legacy bare 21-char ids", () => {
    expect(fileIdSchema.safeParse(`f_${"a".repeat(21)}`).success).toBe(true);
    expect(fileIdSchema.safeParse("a".repeat(21)).success).toBe(true);
  });

  it("rejects empty and malformed ids", () => {
    expect(fileIdSchema.safeParse("").success).toBe(false);
    expect(fileIdSchema.safeParse("file-1").success).toBe(false);
    expect(fileIdSchema.safeParse(`f_${"a".repeat(20)}`).success).toBe(false);
  });
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

  it("accepts ready-style checks keyed by state", () => {
    const result = healthResponseSchema.parse({
      checks: {
        database: { latencyMs: 3, state: "ok" },
        storage: { state: "unavailable" },
      },
      status: "unavailable",
    });
    expect(result.checks?.database.state).toBe("ok");
    expect(result.checks?.storage.status).toBeUndefined();
  });
});

describe("listFilesResponseSchema", () => {
  it("accepts every server sort echo", () => {
    for (const sort of [
      "newest",
      "oldest",
      "largest",
      "smallest",
      "shared",
      "unshared",
    ]) {
      const result = listFilesResponseSchema.safeParse({
        files: [],
        hasMore: false,
        page: 1,
        pageSize: 20,
        quota: {
          maxQuotaBytes: 1000,
          periodKey: "2026-09",
          reservedBytes: 0,
          usedBytes: 0,
        },
        sort,
        totalFiles: 0,
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts the finalizing status without crashing", () => {
    const result = listFilesResponseSchema.safeParse({
      files: [
        {
          createdAt: "2026-09-06T00:00:00.000Z",
          expiresAt: "2026-09-07T00:00:00.000Z",
          fileName: "half.bin",
          fileSize: 64,
          id: "file-1",
          mimeType: "application/octet-stream",
          shareLink: null,
          status: "finalizing",
        },
      ],
      hasMore: false,
      page: 1,
      pageSize: 20,
      quota: {
        maxQuotaBytes: 1000,
        periodKey: "2026-09",
        reservedBytes: 0,
        usedBytes: 0,
      },
      sort: "newest",
      totalFiles: 1,
    });
    expect(result.success).toBe(true);
  });
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
