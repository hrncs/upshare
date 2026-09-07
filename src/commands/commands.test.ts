import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, FILE_LIST_PAGE_SIZE } from "../lib/api-client";
import type {
  FileInfoResponse,
  HealthResponse,
  ListFilesResponse,
  MultipartResumeResponse,
} from "../lib/schemas";
import { abortCommand } from "./abort";
import { deleteCommand } from "./delete";
import { finalizeDownloadedFile } from "./download";
import { infoCommand } from "./info";
import { listCommand } from "./list";
import { manageCommand } from "./manage";
import { renameCommand } from "./rename";
import { SUPPORT_EMAIL, statusCommand } from "./status";
import { upgradeCommand } from "./upgrade";
import { uploadFileRange } from "./upload";

const spinner = vi.hoisted(() => ({
  fail: vi.fn(),
  stop: vi.fn(),
  succeed: vi.fn(),
}));

const readline = vi.hoisted(() => ({
  close: vi.fn(),
  question: vi.fn(),
}));

vi.mock("ora", () => ({
  default: () => ({ ...spinner, start: () => spinner }),
}));

vi.mock("node:readline/promises", () => ({
  default: {
    createInterface: () => readline,
  },
}));

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const mockedSpawnSync = vi.mocked(spawnSync);
const originalArgv = [...process.argv];

const expiresAt = "2026-09-07T00:00:00.000Z";
const DEFAULT_API = "https://upshare.app";
const CUSTOM_API = "https://status.example.com";
const LATENCY_SUFFIX_PATTERN = /\(\d+\s?ms\)/;

function pendingFile(id: string, fileSize: number) {
  return {
    createdAt: "2026-09-06T00:00:00.000Z",
    expiresAt,
    fileName: `${id}.bin`,
    fileSize,
    id,
    mimeType: "application/octet-stream",
    shareLink: null,
    status: "uploading" as const,
  };
}

function pendingPage(ids: string[]): ListFilesResponse {
  const files = ids.map((id, index) => pendingFile(id, (index + 1) * 100));
  return {
    files,
    hasMore: false,
    page: 1,
    pageSize: 100,
    quota: {
      maxQuotaBytes: 1000,
      periodKey: "2026-09",
      reservedBytes: files.reduce((total, file) => total + file.fileSize, 0),
      usedBytes: 0,
    },
    sort: "newest",
    totalFiles: files.length,
  };
}

function createPage(
  page: number,
  hasMore: boolean,
  totalFiles = 2
): ListFilesResponse {
  return {
    files: [
      {
        createdAt: "2026-09-06T00:00:00.000Z",
        expiresAt,
        fileName: `file-${page}.txt`,
        fileSize: page,
        id: `file-${page}`,
        mimeType: "text/plain",
        shareLink: null,
        status: "active",
      },
    ],
    hasMore,
    page,
    pageSize: FILE_LIST_PAGE_SIZE,
    quota: {
      maxQuotaBytes: 100,
      periodKey: "2026-09",
      reservedBytes: 0,
      usedBytes: 3,
    },
    sort: "newest",
    totalFiles,
  };
}

function healthy(): HealthResponse {
  return {
    checks: {
      database: { latencyMs: 12, status: "ok" },
      storage: { latencyMs: 34, status: "ok" },
    },
    status: "ok",
  };
}

function mockRegistry(version: unknown) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    json: async () => version,
    ok: true,
  } as Response);
}

beforeEach(() => {
  process.env.UPSHARE_API_KEY = "ups_test_secret";
  delete process.env.UPSHARE_API_URL;
  process.env.npm_config_user_agent = "npm/10.0.0 node/v20.0.0 linux x64";
  process.argv = ["node", "/usr/local/lib/node_modules/upshare/dist/index.js"];
  mockedSpawnSync.mockReset();
  readline.close.mockClear();
  readline.question.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.UPSHARE_API_KEY;
  delete process.env.UPSHARE_API_URL;
  delete process.env.npm_config_user_agent;
  process.argv = originalArgv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("abortCommand", () => {
  it("aborts only the targeted unfinished upload", async () => {
    vi.spyOn(ApiClient.prototype, "listPendingUploads").mockResolvedValue(
      pendingPage(["file-1", "file-2"])
    );
    const deleteFile = vi
      .spyOn(ApiClient.prototype, "deleteFile")
      .mockResolvedValue({
        fileId: "file-1",
        fileName: "file-1.bin",
        success: true as const,
      });

    await abortCommand("file-1", {
      apiUrl: "https://upshare.app",
      yes: true,
    });

    expect(deleteFile).toHaveBeenCalledOnce();
    expect(deleteFile).toHaveBeenCalledWith("file-1");
  });

  it("aborts every unfinished upload without a target", async () => {
    vi.spyOn(ApiClient.prototype, "listPendingUploads").mockResolvedValue(
      pendingPage(["file-1", "file-2"])
    );
    const deleteFile = vi
      .spyOn(ApiClient.prototype, "deleteFile")
      .mockResolvedValue({
        fileId: "file-1",
        fileName: "file-1.bin",
        success: true as const,
      });

    await abortCommand(undefined, {
      apiUrl: "https://upshare.app",
      yes: true,
    });

    expect(deleteFile).toHaveBeenCalledTimes(2);
  });

  it("refuses a target that is not an unfinished upload", async () => {
    vi.spyOn(ApiClient.prototype, "listPendingUploads").mockResolvedValue(
      pendingPage(["file-1"])
    );
    const deleteFile = vi.spyOn(ApiClient.prototype, "deleteFile");

    await abortCommand("active-file-id", { apiUrl: "https://upshare.app" });

    expect(deleteFile).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "No unfinished upload found"
    );
    expect(process.exitCode).toBe(1);
  });
});

describe("infoCommand", () => {
  const directActive: FileInfoResponse = {
    file: {
      createdAt: "2026-09-06T00:00:00.000Z",
      expiresAt: "2026-09-07T00:00:00.000Z",
      fileName: "report.pdf",
      fileSize: 123,
      id: "file-1",
      mimeType: "application/pdf",
      status: "active",
    },
    shareLink: {
      expiresAt: "2026-09-07T00:00:00.000Z",
      id: "share-1",
      shareUrl: "https://upshare.app/s/abcdef12",
      token: "abcdef12",
      viewsCount: 3,
    },
  };

  const directPending: FileInfoResponse = {
    file: {
      createdAt: "2026-09-06T00:00:00.000Z",
      expiresAt: "2026-09-07T00:00:00.000Z",
      fileName: "movie.mp4",
      fileSize: 128,
      id: "file-2",
      mimeType: "video/mp4",
      status: "uploading",
    },
    shareLink: null,
  };

  const resume: MultipartResumeResponse = {
    expiresAt: "2026-09-07T00:00:00.000Z",
    fileId: "file-2",
    partCount: 2,
    partSize: 64,
    storageCompleted: false,
    uploadedParts: [{ etag: '"first"', partNumber: 1, size: 64 }],
    uploadType: "multipart",
  };

  it("shows details and share link for an active file", async () => {
    const getFile = vi
      .spyOn(ApiClient.prototype, "getFile")
      .mockResolvedValue(directActive);

    await infoCommand("file-1", { apiUrl: "https://upshare.app" });

    expect(getFile).toHaveBeenCalledWith("file-1");
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("report.pdf");
    expect(output).toContain("https://upshare.app/s/abcdef12");
    expect(output).toContain("Active");
  });

  it("shows resume progress for a partial upload", async () => {
    vi.spyOn(ApiClient.prototype, "getFile").mockResolvedValue(directPending);
    vi.spyOn(ApiClient.prototype, "getMultipartUpload").mockResolvedValue(
      resume
    );

    await infoCommand("file-2", { apiUrl: "https://upshare.app" });

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Partial upload");
    expect(output).toContain("1/2 parts");
    expect(output).toContain("64 B of 128 B (50%)");
  });

  it("fails when the file does not exist", async () => {
    vi.spyOn(ApiClient.prototype, "getFile").mockResolvedValue(null);

    await infoCommand("missing", { apiUrl: "https://upshare.app" });

    expect(process.exitCode).toBe(1);
  });

  it("rejects an empty identifier before making a request", async () => {
    const getFile = vi.spyOn(ApiClient.prototype, "getFile");

    await infoCommand("   ", { apiUrl: "https://upshare.app" });

    expect(getFile).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe("listCommand pagination", () => {
  it("requests and labels a specific page", async () => {
    const listFiles = vi
      .spyOn(ApiClient.prototype, "listFiles")
      .mockResolvedValue(createPage(2, true, 41));

    await listCommand({ apiUrl: "https://upshare.app", page: "2" });

    expect(listFiles).toHaveBeenCalledOnce();
    expect(listFiles).toHaveBeenCalledWith({
      page: 2,
      pageSize: FILE_LIST_PAGE_SIZE,
    });
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "upshare ls --page 3"
    );
  });

  it("fetches every page when --all is used", async () => {
    const listFiles = vi
      .spyOn(ApiClient.prototype, "listFiles")
      .mockResolvedValueOnce(createPage(1, true))
      .mockResolvedValueOnce(createPage(2, false));

    await listCommand({ all: true, apiUrl: "https://upshare.app", page: "1" });

    expect(listFiles).toHaveBeenNthCalledWith(1, {
      page: 1,
      pageSize: FILE_LIST_PAGE_SIZE,
    });
    expect(listFiles).toHaveBeenNthCalledWith(2, {
      page: 2,
      pageSize: FILE_LIST_PAGE_SIZE,
    });
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "Showing all 2 active files."
    );
  });

  it("rejects invalid page input before making a request", async () => {
    const listFiles = vi.spyOn(ApiClient.prototype, "listFiles");

    await listCommand({ apiUrl: "https://upshare.app", page: "0" });

    expect(listFiles).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("rejects using --all with a page number", async () => {
    const listFiles = vi.spyOn(ApiClient.prototype, "listFiles");

    await listCommand({ all: true, apiUrl: "https://upshare.app", page: "2" });

    expect(listFiles).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe("listCommand pending", () => {
  function createPendingPage(): ListFilesResponse {
    return {
      files: [
        {
          createdAt: "2026-09-06T00:00:00.000Z",
          expiresAt,
          fileName: "half.bin",
          fileSize: 64,
          id: "pending-1",
          mimeType: "application/octet-stream",
          shareLink: null,
          status: "uploading",
        },
      ],
      hasMore: false,
      page: 1,
      pageSize: FILE_LIST_PAGE_SIZE,
      quota: {
        maxQuotaBytes: 100,
        periodKey: "2026-09",
        reservedBytes: 64,
        usedBytes: 3,
      },
      sort: "newest",
      totalFiles: 1,
    };
  }

  it("lists partial uploads when --pending is used", async () => {
    const listPendingUploads = vi
      .spyOn(ApiClient.prototype, "listPendingUploads")
      .mockResolvedValue(createPendingPage());
    const listFiles = vi.spyOn(ApiClient.prototype, "listFiles");

    await listCommand({
      apiUrl: "https://upshare.app",
      page: "1",
      pending: true,
    });

    expect(listPendingUploads).toHaveBeenCalledOnce();
    expect(listFiles).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "Partial Uploads"
    );
  });

  it("reports when no partial uploads exist", async () => {
    vi.spyOn(ApiClient.prototype, "listPendingUploads").mockResolvedValue({
      ...createPendingPage(),
      files: [],
      totalFiles: 0,
    });

    await listCommand({ apiUrl: "https://upshare.app", pending: true });

    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "No partial uploads found"
    );
  });
});

describe("manageCommand pagination", () => {
  it("loads the next page and reuses the cached previous page", async () => {
    const listFiles = vi
      .spyOn(ApiClient.prototype, "listFiles")
      .mockResolvedValueOnce(createPage(1, true))
      .mockResolvedValueOnce(createPage(2, false));
    readline.question
      .mockResolvedValueOnce("n")
      .mockResolvedValueOnce("p")
      .mockResolvedValueOnce("1")
      .mockResolvedValueOnce("0");

    await manageCommand(undefined, { apiUrl: "https://upshare.app" });

    expect(listFiles).toHaveBeenCalledTimes(2);
    expect(listFiles).toHaveBeenNthCalledWith(1, {
      page: 1,
      pageSize: FILE_LIST_PAGE_SIZE,
    });
    expect(listFiles).toHaveBeenNthCalledWith(2, {
      page: 2,
      pageSize: FILE_LIST_PAGE_SIZE,
    });
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "Load next 20"
    );
  });

  it("exits cleanly when user presses Ctrl+C during file selection", async () => {
    vi.spyOn(ApiClient.prototype, "listFiles").mockResolvedValue(
      createPage(1, false)
    );
    readline.question.mockRejectedValueOnce(new Error("Aborted with Ctrl+C"));

    await manageCommand(undefined, { apiUrl: "https://upshare.app" });

    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "Exited."
    );
    expect(process.exitCode).toBeFalsy();
  });
});

describe("deleteCommand", () => {
  it("cancels cleanly when user presses Ctrl+C on confirmation", async () => {
    readline.question.mockRejectedValueOnce(new Error("Aborted with Ctrl+C"));

    await deleteCommand("file-123", { apiUrl: "https://upshare.app" });

    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "Delete cancelled."
    );
    expect(process.exitCode).toBeFalsy();
  });
});

describe("abortCommand", () => {
  it("cancels cleanly when user presses Ctrl+C on confirmation", async () => {
    vi.spyOn(ApiClient.prototype, "listPendingUploads").mockResolvedValueOnce(
      pendingPage(["pending-1"])
    );
    readline.question.mockRejectedValueOnce(new Error("Aborted with Ctrl+C"));

    await abortCommand(undefined, { apiUrl: "https://upshare.app" });

    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "Abort cancelled."
    );
    expect(process.exitCode).toBeFalsy();
  });
});

describe("renameCommand", () => {
  it("renames the file and shows the new name", async () => {
    const renameFile = vi
      .spyOn(ApiClient.prototype, "renameFile")
      .mockResolvedValue({
        expiresAt: "2026-09-07T00:00:00.000Z",
        fileId: "file-1",
        fileName: "fixed.pdf",
        success: true,
      });

    await renameCommand("file-1", "fixed.pdf", {
      apiUrl: "https://upshare.app",
    });

    expect(renameFile).toHaveBeenCalledWith("file-1", "fixed.pdf");
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "fixed.pdf"
    );
  });

  it("rejects an empty identifier before making a request", async () => {
    const renameFile = vi.spyOn(ApiClient.prototype, "renameFile");

    await renameCommand("   ", "fixed.pdf", { apiUrl: "https://upshare.app" });

    expect(renameFile).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("rejects a blank new name before making a request", async () => {
    const renameFile = vi.spyOn(ApiClient.prototype, "renameFile");

    await renameCommand("file-1", "   ", { apiUrl: "https://upshare.app" });

    expect(renameFile).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("fails when the API rejects the rename", async () => {
    vi.spyOn(ApiClient.prototype, "renameFile").mockRejectedValue(
      new Error("Invalid file name.")
    );

    await renameCommand("file-1", "bad/name", {
      apiUrl: "https://upshare.app",
    });

    expect(process.exitCode).toBe(1);
  });
});

describe("statusCommand", () => {
  it("reports operational when every check passes", async () => {
    vi.spyOn(ApiClient.prototype, "checkHealth").mockResolvedValue(healthy());

    await statusCommand({ apiUrl: DEFAULT_API });

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Operational");
    expect(output).not.toMatch(LATENCY_SUFFIX_PATTERN);
    expect(output).not.toContain(SUPPORT_EMAIL);
    expect(process.exitCode).not.toBe(1);
  });

  it("flags degraded storage and points at support", async () => {
    vi.spyOn(ApiClient.prototype, "checkHealth").mockResolvedValue({
      checks: {
        database: { latencyMs: 12, status: "ok" },
        storage: { status: "unavailable" },
      },
      status: "degraded",
    });

    await statusCommand({ apiUrl: DEFAULT_API });

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Degraded");
    expect(output).toContain("unavailable");
    expect(output).toContain(SUPPORT_EMAIL);
    expect(process.exitCode).toBe(1);
  });

  it("works without per-check details from older servers", async () => {
    vi.spyOn(ApiClient.prototype, "checkHealth").mockResolvedValue({
      status: "ok",
    });

    await statusCommand({ apiUrl: DEFAULT_API });

    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "Operational"
    );
  });

  it("shows a friendly error with support contact when unreachable", async () => {
    vi.spyOn(ApiClient.prototype, "checkHealth").mockRejectedValue(
      new Error("Could not connect to https://upshare.app.")
    );

    await statusCommand({ apiUrl: DEFAULT_API });

    const errors = vi.mocked(console.error).mock.calls.flat().join("\n");
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(errors).toContain("Could not connect");
    expect(output).toContain(SUPPORT_EMAIL);
    expect(process.exitCode).toBe(1);
  });

  it("hides the support contact for non-default APIs", async () => {
    vi.spyOn(ApiClient.prototype, "checkHealth").mockRejectedValue(
      new Error("Could not connect to https://status.example.com.")
    );

    await statusCommand({ apiUrl: CUSTOM_API });

    const output = [
      ...vi.mocked(console.log).mock.calls.flat(),
      ...vi.mocked(console.error).mock.calls.flat(),
    ].join("\n");
    expect(output).toContain("Could not connect");
    expect(output).not.toContain(SUPPORT_EMAIL);
    expect(process.exitCode).toBe(1);
  });
});

describe("upgradeCommand", () => {
  it("stops when already on the latest version", async () => {
    mockRegistry({ version: "0.0.12" });

    await expect(upgradeCommand()).resolves.toBe(false);

    expect(mockedSpawnSync).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "latest version"
    );
  });

  it("upgrades with npm when a newer version exists", async () => {
    mockRegistry({ version: "9.9.9" });
    mockedSpawnSync.mockReturnValue({ status: 0 } as never);

    await expect(upgradeCommand()).resolves.toBe(true);

    expect(mockedSpawnSync).toHaveBeenCalledOnce();
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "upshare@latest"],
      expect.objectContaining({ stdio: "inherit" })
    );
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "Upgraded to 9.9.9"
    );
  });

  it("uses pnpm when installed via pnpm", async () => {
    process.env.npm_config_user_agent =
      "pnpm/10.0.0 npm/? node/v20.0.0 linux x64";
    mockRegistry({ version: "9.9.9" });
    mockedSpawnSync.mockReturnValue({ status: 0 } as never);

    await expect(upgradeCommand()).resolves.toBe(true);

    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "pnpm",
      ["add", "-g", "upshare@latest"],
      expect.objectContaining({ stdio: "inherit" })
    );
  });

  it("fails gracefully when the registry is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await expect(upgradeCommand()).resolves.toBe(false);

    expect(mockedSpawnSync).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("reports a failed install with the manual command", async () => {
    mockRegistry({ version: "9.9.9" });
    mockedSpawnSync.mockReturnValue({ status: 1 } as never);

    await expect(upgradeCommand()).resolves.toBe(false);

    expect(process.exitCode).toBe(1);
  });
});

describe("finalizeDownloadedFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "upshare-finalize-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  it("renames part file directly when on the same filesystem", () => {
    const partPath = path.join(tempDir, "file.part");
    const destPath = path.join(tempDir, "file.txt");
    fs.writeFileSync(partPath, "content");

    finalizeDownloadedFile(partPath, destPath);

    expect(fs.existsSync(partPath)).toBe(false);
    expect(fs.readFileSync(destPath, "utf8")).toBe("content");
  });

  it("refuses to overwrite an existing destination file", () => {
    const partPath = path.join(tempDir, "file.part");
    const destPath = path.join(tempDir, "file.txt");
    fs.writeFileSync(partPath, "new content");
    fs.writeFileSync(destPath, "existing");

    expect(() => finalizeDownloadedFile(partPath, destPath)).toThrow(
      /A file with the same name already exists at the destination path; cannot overwrite/
    );
    expect(fs.readFileSync(destPath, "utf8")).toBe("existing");
    expect(fs.existsSync(partPath)).toBe(true);
  });

  it("overwrites an existing destination file when force is true", () => {
    const partPath = path.join(tempDir, "file.part");
    const destPath = path.join(tempDir, "file.txt");
    fs.writeFileSync(partPath, "new content");
    fs.writeFileSync(destPath, "old content");

    finalizeDownloadedFile(partPath, destPath, { force: true });

    expect(fs.existsSync(partPath)).toBe(false);
    expect(fs.readFileSync(destPath, "utf8")).toBe("new content");
  });

  it("falls back to copyFileSync + unlinkSync on EXDEV (cross-device)", () => {
    const partPath = path.join(tempDir, "file.part");
    const destPath = path.join(tempDir, "file.txt");
    fs.writeFileSync(partPath, "cross-device content");

    const exdevError = Object.assign(
      new Error("cross-device link not permitted"),
      {
        code: "EXDEV",
      }
    );
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw exdevError;
    });

    finalizeDownloadedFile(partPath, destPath);

    expect(fs.existsSync(partPath)).toBe(false);
    expect(fs.readFileSync(destPath, "utf8")).toBe("cross-device content");
  });

  it("falls back to copyFileSync + unlinkSync on ENOTSUP (exFAT / unsupported filesystem)", () => {
    const partPath = path.join(tempDir, "file.part");
    const destPath = path.join(tempDir, "file.txt");
    fs.writeFileSync(partPath, "exfat content");

    const enotsupError = Object.assign(new Error("operation not supported"), {
      code: "ENOTSUP",
    });
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw enotsupError;
    });

    finalizeDownloadedFile(partPath, destPath);

    expect(fs.existsSync(partPath)).toBe(false);
    expect(fs.readFileSync(destPath, "utf8")).toBe("exfat content");
  });

  it("falls back to copyFileSync + unlinkSync on EPERM", () => {
    const partPath = path.join(tempDir, "file.part");
    const destPath = path.join(tempDir, "file.txt");
    fs.writeFileSync(partPath, "eperm content");

    const epermError = Object.assign(new Error("operation not permitted"), {
      code: "EPERM",
    });
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw epermError;
    });

    finalizeDownloadedFile(partPath, destPath);

    expect(fs.existsSync(partPath)).toBe(false);
    expect(fs.readFileSync(destPath, "utf8")).toBe("eperm content");
  });

  it("re-throws unexpected errors like EACCES", () => {
    const partPath = path.join(tempDir, "file.part");
    const destPath = path.join(tempDir, "file.txt");
    fs.writeFileSync(partPath, "permission denied test");

    const eaccesError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw eaccesError;
    });

    expect(() => finalizeDownloadedFile(partPath, destPath)).toThrow(
      /permission denied/
    );
  });
});

describe("uploadFileRange", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads range and destroys stream on success", async () => {
    const stream = new PassThrough();
    const destroySpy = vi.spyOn(stream, "destroy");
    vi.spyOn(fs, "createReadStream").mockReturnValue(stream as never);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { etag: '"test-etag"' },
      })
    );

    const etag = await uploadFileRange(
      "https://storage.test/part",
      "dummy.bin",
      0,
      10
    );
    expect(etag).toBe('"test-etag"');
    expect(destroySpy).toHaveBeenCalled();
  });

  it("destroys stream on network failure", async () => {
    const stream = new PassThrough();
    const destroySpy = vi.spyOn(stream, "destroy");
    vi.spyOn(fs, "createReadStream").mockReturnValue(stream as never);

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("network error")
    );

    await expect(
      uploadFileRange("https://storage.test/part", "dummy.bin", 0, 10)
    ).rejects.toThrow("network error");
    expect(destroySpy).toHaveBeenCalled();
  });

  it("destroys stream on storage HTTP error", async () => {
    const stream = new PassThrough();
    const destroySpy = vi.spyOn(stream, "destroy");
    vi.spyOn(fs, "createReadStream").mockReturnValue(stream as never);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal Error", { status: 500 })
    );

    await expect(
      uploadFileRange("https://storage.test/part", "dummy.bin", 0, 10)
    ).rejects.toThrow("Storage upload failed with HTTP 500.");
    expect(destroySpy).toHaveBeenCalled();
  });
});
