import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearConfig,
  clearProfileLogin,
  getActiveProfileName,
  getEffectiveApiUrl,
  listProfileNames,
  loadConfig,
  normalizeApiUrl,
  normalizeProfileName,
  removeProfileFromConfig,
  saveGlobal,
  saveProfile,
  setCurrentProfile,
} from "./config";
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
  delete process.env.UPSHARE_PROFILE;
  delete process.env.UPSHARE_API_URL;
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
    saveProfile("default", {
      apiUrl: "https://example.com",
      keyPrefix: "ups_1234",
    });
    expect(loadConfig()).toMatchObject({
      profiles: {
        default: { apiUrl: "https://example.com", keyPrefix: "ups_1234" },
      },
    });
    expect(
      fs.readFileSync(path.join(configDirectory, "config.json"), "utf8")
    ).not.toContain("secret");
    saveGlobal({ latestVersion: "1.2.3" });
    expect(loadConfig().latestVersion).toBe("1.2.3");
    expect(loadConfig().profiles?.default?.apiUrl).toBe("https://example.com");
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

  it("migrates a legacy flat config to the default profile", () => {
    fs.writeFileSync(
      path.join(configDirectory, "config.json"),
      JSON.stringify({
        apiUrl: "https://example.com",
        keyPrefix: "ups_1234",
        user: { email: "a@example.com", id: "u1", name: "A" },
      })
    );
    expect(loadConfig()).toMatchObject({
      profiles: {
        default: {
          apiUrl: "https://example.com",
          keyPrefix: "ups_1234",
          user: { email: "a@example.com" },
        },
      },
    });
    expect(getActiveProfileName()).toBe("default");
    expect(getEffectiveApiUrl()).toBe("https://example.com");
  });

  it("resolves the active profile from flag, env, config, then default", () => {
    expect(getActiveProfileName("Work")).toBe("work");
    process.env.UPSHARE_PROFILE = "Self-Hosted";
    expect(getActiveProfileName()).toBe("self-hosted");
    delete process.env.UPSHARE_PROFILE;
    saveProfile("own", { apiUrl: "https://own.example" });
    setCurrentProfile("own");
    expect(getActiveProfileName()).toBe("own");
    expect(getEffectiveApiUrl()).toBe("https://own.example");
    expect(getEffectiveApiUrl(undefined, "default")).toBe(
      "https://upshare.app"
    );
    expect(listProfileNames()).toEqual(["own"]);
    clearProfileLogin("own");
    expect(loadConfig().profiles?.own).toEqual({
      apiUrl: "https://own.example",
    });
    removeProfileFromConfig("own");
    expect(loadConfig().profiles?.own).toBeUndefined();
    expect(getActiveProfileName()).toBe("default");
  });

  it("rejects invalid profile names", () => {
    expect(() => normalizeProfileName("")).toThrow("Profile name");
    expect(() => normalizeProfileName("has space")).toThrow("Profile name");
    expect(() => normalizeProfileName("a".repeat(65))).toThrow("Profile name");
    expect(() => saveProfile("bad name", {})).toThrow("Profile name");
    expect(() => setCurrentProfile("missing")).toThrow(
      'Profile "missing" not found'
    );
  });
});

describe("multipart upload state", () => {
  const expected = {
    apiUrl: "https://upshare.app",
    filePath: "C:\\files\\archive.zip",
    fileSize: 123,
    modifiedAt: 456,
    profile: "default",
  };

  it("saves, loads, and clears matching state", () => {
    saveUploadState({ ...expected, fileId: "file-id" });
    expect(loadUploadState(expected)?.fileId).toBe("file-id");
    clearUploadState(expected.profile, expected.apiUrl, expected.filePath);
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

  it("isolates resume state per profile", () => {
    saveUploadState({ ...expected, fileId: "file-id" });
    expect(loadUploadState({ ...expected, profile: "work" })).toBeNull();
    saveUploadState({ ...expected, fileId: "work-file-id", profile: "work" });
    expect(loadUploadState({ ...expected, profile: "work" })?.fileId).toBe(
      "work-file-id"
    );
    expect(loadUploadState(expected)?.fileId).toBe("file-id");
  });
});
