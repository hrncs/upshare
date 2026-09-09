import os from "node:os";
import pc from "picocolors";
import { ApiClient } from "../lib/api-client";
import { getEffectiveApiUrl, saveConfig } from "../lib/config";
import {
  getApiKeyPrefix,
  getCredentialStoreName,
  getEnvironmentApiKey,
  maskApiKey,
  resolveApiKey,
  storeApiKeyWithRollback,
} from "../lib/credentials";
import { openBrowser, pollForDeviceToken } from "../lib/device-flow";
import { sanitizeTerminalText } from "../lib/format";
import { printError, printFields, printWarning } from "../lib/output";
import type {
  DeviceAuthorizationResponse,
  DeviceTokenResponse,
} from "../lib/schemas";
import { createSpinner } from "../lib/spinner";

const NON_PRINTABLE_HOST_CHARACTERS_REGEX = /[^\x20-\x7e]+/g;
const HOST_WHITESPACE_REGEX = /\s+/g;

export interface SignupOptions {
  apiUrl?: string;
  mode?: "signup" | "login";
  noBrowser?: boolean;
}

function resolveApiUrl(options?: SignupOptions): string {
  const apiUrl = getEffectiveApiUrl(options?.apiUrl);
  const mode = options?.mode ?? "signup";
  try {
    const existing = resolveApiKey(apiUrl);
    if (existing && mode === "signup") {
      throw new Error(
        "Already logged in. Run `upshare logout` first or `upshare login --web` for an additional browser key."
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Already logged in")
    ) {
      throw error;
    }
  }
  return apiUrl;
}

function buildDeviceKeyName(): string | undefined {
  try {
    const host = os
      .hostname()
      .trim()
      .replace(NON_PRINTABLE_HOST_CHARACTERS_REGEX, "-")
      .replace(HOST_WHITESPACE_REGEX, "-")
      .slice(0, 32);
    return host ? `CLI ${host}`.slice(0, 64) : undefined;
  } catch {
    return undefined;
  }
}

function storeAuthorization(
  apiUrl: string,
  authorization: DeviceTokenResponse
): string {
  const rawKey = authorization.access_token;
  storeApiKeyWithRollback(apiUrl, rawKey, () => {
    saveConfig({
      apiUrl,
      keyPrefix: getApiKeyPrefix(rawKey),
      user: authorization.user,
    });
  });
  return rawKey;
}

function printSignupSuccess(
  apiUrl: string,
  user: { email: string; name: string },
  rawKey: string
): void {
  console.log();
  printFields([
    ["Email", user.email],
    ["API key", pc.gray(sanitizeTerminalText(maskApiKey(rawKey)))],
    ["Credential", getCredentialStoreName()],
    ["API URL", apiUrl],
  ]);
  console.log();
  if (getEnvironmentApiKey()) {
    printWarning(
      "UPSHARE_API_KEY is set and takes precedence over the stored credential."
    );
  }
}

function printAuthorizationInstructions(
  mode: "signup" | "login",
  authorization: DeviceAuthorizationResponse,
  noBrowser: boolean
): void {
  console.log();
  console.log(`${pc.bold(mode === "login" ? "Logging in" : "Signing up")}...`);
  console.log();
  printFields([
    ["Open", pc.cyan(authorization.verification_uri)],
    ["Code", pc.bold(authorization.user_code)],
  ]);
  console.log();
  if (noBrowser) {
    console.log(pc.dim("Open the URL and enter the code to continue."));
  } else {
    console.log(pc.dim("Opening your browser for approval..."));
  }
  console.log();
}

export async function signupCommand(options?: SignupOptions): Promise<void> {
  const mode = options?.mode ?? "signup";
  let apiUrl: string;
  try {
    apiUrl = resolveApiUrl(options);
  } catch (error) {
    printError(
      error instanceof Error ? error.message : "Invalid signup options."
    );
    process.exitCode = 1;
    return;
  }

  const client = new ApiClient({ apiUrl });
  let authorization: DeviceAuthorizationResponse;
  try {
    authorization = await client.requestDeviceAuthorization(
      buildDeviceKeyName()
    );
  } catch (error) {
    printError(
      error instanceof Error
        ? error.message
        : "Could not start browser authorization."
    );
    process.exitCode = 1;
    return;
  }

  const noBrowser = options?.noBrowser ?? false;
  printAuthorizationInstructions(mode, authorization, noBrowser);
  if (!noBrowser) {
    openBrowser(authorization.verification_uri_complete);
  }

  const spinner = createSpinner("Waiting for browser approval...").start();
  try {
    const token = await pollForDeviceToken({
      expiresInSeconds: authorization.expires_in,
      intervalSeconds: authorization.interval,
      requestToken: () => client.requestDeviceToken(authorization.device_code),
    });
    const rawKey = storeAuthorization(apiUrl, token);
    if (mode === "login") {
      spinner.succeed(`✓ Logged in as ${token.user.name}`);
    } else {
      spinner.succeed("✓ Account created");
      console.log(`Signed in as ${token.user.name}`);
    }
    printSignupSuccess(apiUrl, token.user, rawKey);
  } catch (error) {
    spinner.fail(
      error instanceof Error ? error.message : "Browser authorization failed"
    );
    process.exitCode = 1;
  }
}
