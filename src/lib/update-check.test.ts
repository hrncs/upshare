import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkForUpdate,
  isNewerVersion,
  isUpdateAvailable,
  isUpdateCheckDisabled,
  printVersionWithUpdateCheck,
  shouldSkipUpdateCheck,
} from "./update-check";

const originalConfigDir = process.env.UPSHARE_CONFIG_DIR;
let tempConfigDir = "";

function mockCachedVersion(latestVersion?: string) {
  tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "upshare-update-"));
  process.env.UPSHARE_CONFIG_DIR = tempConfigDir;
  if (latestVersion !== undefined) {
    fs.writeFileSync(
      path.join(tempConfigDir, "config.json"),
      JSON.stringify({ latestVersion })
    );
  }
}

function cleanupTempConfig() {
  if (tempConfigDir) {
    fs.rmSync(tempConfigDir, { force: true, recursive: true });
    tempConfigDir = "";
  }
  if (originalConfigDir === undefined) {
    delete process.env.UPSHARE_CONFIG_DIR;
  } else {
    process.env.UPSHARE_CONFIG_DIR = originalConfigDir;
  }
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isNewerVersion", () => {
  it("compares dotted versions part by part", () => {
    expect(isNewerVersion("0.0.12", "0.0.13")).toBe(true);
    expect(isNewerVersion("0.0.13", "0.0.13")).toBe(false);
    expect(isNewerVersion("0.0.13", "0.0.12")).toBe(false);
  });

  it("handles prerelease versions per semver", () => {
    expect(isNewerVersion("1.0.0-beta", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0-beta")).toBe(false);
    expect(isNewerVersion("1.0.0-alpha", "1.0.0-beta")).toBe(true);
    expect(isNewerVersion("1.0.0-beta.2", "1.0.0-beta.11")).toBe(true);
    expect(isNewerVersion("1.0.0-beta", "1.0.0-beta")).toBe(false);
  });

  it("ignores unparsable versions instead of nagging", () => {
    expect(isNewerVersion("0.0.13", "not-a-version")).toBe(false);
    expect(isNewerVersion("not-a-version", "9.9.9")).toBe(false);
  });
});

describe("isUpdateAvailable", () => {
  it("offers stable updates to stable users", () => {
    expect(isUpdateAvailable("0.0.20", "0.0.21")).toBe(true);
    expect(isUpdateAvailable("0.0.21", "0.0.21")).toBe(false);
  });

  it("hides prereleases from stable users", () => {
    expect(isUpdateAvailable("0.0.20", "0.0.21-beta")).toBe(false);
    expect(isUpdateAvailable("0.0.20", "0.0.20-beta")).toBe(false);
  });

  it("offers updates to beta users", () => {
    expect(isUpdateAvailable("0.0.21-beta", "0.0.21")).toBe(true);
    expect(isUpdateAvailable("0.0.21-beta", "0.0.22-beta")).toBe(true);
    expect(isUpdateAvailable("0.0.22-beta", "0.0.21")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  function mockRegistryVersion(version: unknown) {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      json: async () => version,
      ok: true,
    } as Response);
  }

  afterEach(() => {
    cleanupTempConfig();
  });

  it("ignores prereleases for stable users", async () => {
    mockCachedVersion(undefined);
    mockRegistryVersion({ version: "0.0.21-beta" });

    await expect(checkForUpdate("0.0.20")).resolves.toBeNull();
  });

  it("offers stables to beta users", async () => {
    mockCachedVersion(undefined);
    mockRegistryVersion({ version: "0.0.21" });

    await expect(checkForUpdate("0.0.20-beta")).resolves.toBe("0.0.21");
  });
});
describe("isUpdateCheckDisabled", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env.UPSHARE_NO_UPDATE_CHECK = originalEnv.UPSHARE_NO_UPDATE_CHECK;
    if (process.env.UPSHARE_NO_UPDATE_CHECK === undefined) {
      delete process.env.UPSHARE_NO_UPDATE_CHECK;
    }
  });

  it("is disabled via --no-update-check anywhere in argv", () => {
    expect(
      isUpdateCheckDisabled(["node", "upshare", "--no-update-check"])
    ).toBe(true);
    expect(
      isUpdateCheckDisabled(["node", "upshare", "upload", "--no-update-check"])
    ).toBe(true);
    expect(isUpdateCheckDisabled(["node", "upshare", "upload"])).toBe(false);
  });

  it("ignores --no-update-check after the -- terminator", () => {
    expect(
      isUpdateCheckDisabled([
        "node",
        "upshare",
        "upload",
        "--",
        "--no-update-check",
      ])
    ).toBe(false);
  });

  it("is disabled via environment variable", () => {
    process.env.UPSHARE_NO_UPDATE_CHECK = "1";
    expect(isUpdateCheckDisabled(["node", "upshare"])).toBe(true);
  });
});

describe("shouldSkipUpdateCheck", () => {
  const originalCi = process.env.CI;

  afterEach(() => {
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
  });

  it("skips in CI environments", () => {
    process.env.CI = "true";
    expect(shouldSkipUpdateCheck(["node", "upshare"])).toBe(true);
  });
});

describe("printVersionWithUpdateCheck", () => {
  const originalOptOut = process.env.UPSHARE_NO_UPDATE_CHECK;

  afterEach(() => {
    cleanupTempConfig();
    if (originalOptOut === undefined) {
      delete process.env.UPSHARE_NO_UPDATE_CHECK;
    } else {
      process.env.UPSHARE_NO_UPDATE_CHECK = originalOptOut;
    }
  });

  it("shows the banner when the cache has a newer version", () => {
    mockCachedVersion("9.9.9");

    printVersionWithUpdateCheck("0.0.13");

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("0.0.13");
    expect(output).toContain("Update available");
    expect(output).toContain("upshare upgrade");
  });

  it("prints only the version when the cache is current", () => {
    mockCachedVersion("0.0.13");

    printVersionWithUpdateCheck("0.0.13");

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("0.0.13");
    expect(output).not.toContain("Update available");
  });

  it("prints only the version with no cached version", () => {
    mockCachedVersion(undefined);

    printVersionWithUpdateCheck("0.0.13");

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("0.0.13");
    expect(output).not.toContain("Update available");
  });

  it("prints only the version when opted out", () => {
    process.env.UPSHARE_NO_UPDATE_CHECK = "1";
    mockCachedVersion("9.9.9");

    printVersionWithUpdateCheck("0.0.13");

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("0.0.13");
    expect(output).not.toContain("Update available");
  });
});
