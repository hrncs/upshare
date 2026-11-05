import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../lib/api-client";
import type { CredentialBackend } from "../lib/credentials";
import { signupCommand } from "./signup";

const backend: CredentialBackend = {
  delete: () => false,
  get: () => undefined,
  set: () => undefined,
};

let configDirectory = "";

beforeEach(() => {
  configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "upshare-signup-"));
  process.env.UPSHARE_CONFIG_DIR = configDirectory;
  delete process.env.UPSHARE_API_KEY;
  delete process.env.UPSHARE_API_URL;
  delete process.env.UPSHARE_PROFILE;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.UPSHARE_API_KEY;
  delete process.env.UPSHARE_API_URL;
  delete process.env.UPSHARE_PROFILE;
  delete process.env.UPSHARE_CONFIG_DIR;
  process.exitCode = undefined;
  fs.rmSync(configDirectory, { force: true, recursive: true });
  vi.restoreAllMocks();
});

function errorOutput(): string {
  return vi.mocked(console.error).mock.calls.flat().join("\n");
}

describe("signupCommand", () => {
  it("fails before browser authorization when signups are closed", async () => {
    const getCliConfig = vi
      .spyOn(ApiClient.prototype, "getCliConfig")
      .mockResolvedValue({ allowNewUserSignups: false });
    const requestDeviceAuthorization = vi.spyOn(
      ApiClient.prototype,
      "requestDeviceAuthorization"
    );

    await signupCommand({
      apiUrl: "https://upshare.app",
      backend,
      noBrowser: true,
    });

    expect(getCliConfig).toHaveBeenCalledOnce();
    expect(requestDeviceAuthorization).not.toHaveBeenCalled();
    expect(errorOutput()).toContain("New sign-ups are temporarily closed.");
    expect(errorOutput()).toContain("upshare login --web");
    expect(process.exitCode).toBe(1);
  });

  it("continues when the server does not expose signup availability", async () => {
    vi.spyOn(ApiClient.prototype, "getCliConfig").mockResolvedValue(null);
    const requestDeviceAuthorization = vi
      .spyOn(ApiClient.prototype, "requestDeviceAuthorization")
      .mockRejectedValue(new Error("authorization unavailable"));

    await signupCommand({
      apiUrl: "https://upshare.app",
      backend,
      noBrowser: true,
    });

    expect(requestDeviceAuthorization).toHaveBeenCalledOnce();
    expect(errorOutput()).toContain("authorization unavailable");
    expect(process.exitCode).toBe(1);
  });

  it("skips the signup check when logging in to an existing account", async () => {
    const getCliConfig = vi.spyOn(ApiClient.prototype, "getCliConfig");
    vi.spyOn(
      ApiClient.prototype,
      "requestDeviceAuthorization"
    ).mockRejectedValue(new Error("authorization unavailable"));

    await signupCommand({
      apiUrl: "https://upshare.app",
      backend,
      mode: "login",
      noBrowser: true,
    });

    expect(getCliConfig).not.toHaveBeenCalled();
  });
});
