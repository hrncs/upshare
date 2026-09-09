import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../lib/config";
import type { CredentialBackend } from "../lib/credentials";
import {
  addProfileCommand,
  listProfilesCommand,
  removeProfileCommand,
  showProfileCommand,
  useProfileCommand,
} from "./profile";

let configDirectory = "";

function createBackend(): CredentialBackend & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    delete: (account: string) => store.delete(account),
    get: (account: string) => store.get(account),
    set: (account: string, apiKey: string) => {
      store.set(account, apiKey);
    },
    store,
  };
}

beforeEach(() => {
  configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "upshare-profile-"));
  process.env.UPSHARE_CONFIG_DIR = configDirectory;
  delete process.env.UPSHARE_PROFILE;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.UPSHARE_CONFIG_DIR;
  delete process.env.UPSHARE_PROFILE;
  process.exitCode = undefined;
  fs.rmSync(configDirectory, { force: true, recursive: true });
  vi.restoreAllMocks();
});

describe("profile commands", () => {
  it("adds, switches, lists, and shows profiles", () => {
    addProfileCommand("own", { apiUrl: "https://own.example" });
    expect(process.exitCode).toBeFalsy();
    expect(loadConfig().profiles?.own?.apiUrl).toBe("https://own.example");

    useProfileCommand("own");
    expect(loadConfig().currentProfile).toBe("own");

    listProfilesCommand();
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("own");
    expect(output).toContain("https://own.example");

    showProfileCommand();
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "own"
    );
  });

  it("rejects duplicate profiles and unknown switches", () => {
    addProfileCommand("own");
    process.exitCode = undefined;
    addProfileCommand("own");
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    useProfileCommand("missing");
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    showProfileCommand("missing");
    expect(process.exitCode).toBe(1);
  });

  it("removes a profile and its stored credential", async () => {
    const backend = createBackend();
    backend.store.set("own::https://upshare.app", "ups_secret");
    addProfileCommand("own");
    useProfileCommand("own");

    await removeProfileCommand("own", { backend, yes: true });

    expect(process.exitCode).toBeFalsy();
    expect(loadConfig().profiles?.own).toBeUndefined();
    expect(backend.store.size).toBe(0);
  });

  it("refuses to remove an unknown profile", async () => {
    await removeProfileCommand("missing", {
      backend: createBackend(),
      yes: true,
    });
    expect(process.exitCode).toBe(1);
  });
});
