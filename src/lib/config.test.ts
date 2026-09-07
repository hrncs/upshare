import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfig, loadConfig, normalizeApiUrl, saveConfig } from "./config";
import {
  clearUploadState,
  loadUploadState,
  saveUploadState,
} from "./upload-state";

let configDirectory = "";

beforeEach(() => {
  configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "upshare-config-"));
  process.env.UPSHARE_CONFIG_DIR = configDirectory;
});

afterEach(() => {
  delete process.env.UPSHARE_CONFIG_DIR;
  fs.rmSync(configDirectory, { force: true, recursive: true });
});

describe("normalizeApiUrl", () => {
  it("normalizes an HTTPS origin", () => {
    expect(normalizeApiUrl("https://example.com/")).toBe("https://example.com");
  });

  it("allows HTTP only for loopback development", () => {
    expect(normalizeApiUrl("http://localhost:3000")).toBe(
      "http://localhost:3000"
    );
    expect(() => normalizeApiUrl("http://example.com")).toThrow();
  });

  it("rejects URLs with credentials or paths", () => {
    expect(() => normalizeApiUrl("https://user:pass@example.com")).toThrow();
    expect(() => normalizeApiUrl("https://example.com/api")).toThrow();
  });
});

describe("configuration storage", () => {
  it("round-trips and clears configuration", () => {
    saveConfig({ apiUrl: "https://example.com", keyPrefix: "ups_1234" });
    expect(loadConfig()).toMatchObject({
      apiUrl: "https://example.com",
      keyPrefix: "ups_1234",
    });
    expect(
      fs.readFileSync(path.join(configDirectory, "config.json"), "utf8")
    ).not.toContain("secret");
    saveConfig({ latestVersion: "1.2.3" });
    expect(loadConfig().latestVersion).toBe("1.2.3");
    expect(loadConfig().apiUrl).toBe("https://example.com");
    clearConfig();
    expect(loadConfig()).toEqual({});
  });

  it("rejects malformed configuration", () => {
    fs.writeFileSync(path.join(configDirectory, "config.json"), "not-json");
    expect(() => loadConfig()).toThrow("Invalid UpShare configuration");
  });

  it("rejects plaintext API keys", () => {
    fs.writeFileSync(
      path.join(configDirectory, "config.json"),
      JSON.stringify({ apiKey: "secret" })
    );
    expect(() => loadConfig()).toThrow("Invalid UpShare configuration");
  });
});

describe("multipart upload state", () => {
  const expected = {
    apiUrl: "https://upshare.app",
    filePath: "C:\\files\\archive.zip",
    fileSize: 123,
    modifiedAt: 456,
  };

  it("saves, loads, and clears matching state", () => {
    saveUploadState({ ...expected, fileId: "file-id" });
    expect(loadUploadState(expected)?.fileId).toBe("file-id");
    clearUploadState(expected.apiUrl, expected.filePath);
    expect(loadUploadState(expected)).toBeNull();
  });

  it("does not resume a changed file", () => {
    saveUploadState({ ...expected, fileId: "file-id" });
    expect(
      loadUploadState({ ...expected, modifiedAt: expected.modifiedAt + 1 })
    ).toBeNull();
  });

  it("triggers onInvalidated callback when a file has changed", () => {
    saveUploadState({ ...expected, fileId: "file-id" });
    const onInvalidated = vi.fn();
    expect(
      loadUploadState(
        { ...expected, modifiedAt: expected.modifiedAt + 1 },
        { onInvalidated }
      )
    ).toBeNull();
    expect(onInvalidated).toHaveBeenCalledWith("modified");
  });
});
