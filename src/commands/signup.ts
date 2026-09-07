import os from "node:os";
import readline from "node:readline";
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
import {
  buildAuthorizeUrl,
  DEVICE_FLOW_TIMEOUT_MS,
  generateDeviceState,
  openBrowser,
  startLoopbackServer,
} from "../lib/device-flow";
import { sanitizeTerminalText } from "../lib/format";
import { printError, printFields, printWarning } from "../lib/output";
import { createSpinner } from "../lib/spinner";

export interface SignupOptions {
  apiUrl?: string;
  mode?: "signup" | "login";
  noBrowser?: boolean;
  port?: number;
  timeoutMs?: number;
}

function parsePort(raw: string | number | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const port = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("Port must be a whole number between 1 and 65535.");
  }
  return port;
}

interface SignupPrereqs {
  apiUrl: string;
  preferredPort: number | undefined;
}

function resolveSignupPrereqs(options?: SignupOptions): SignupPrereqs {
  const apiUrl = getEffectiveApiUrl(options?.apiUrl);
  const preferredPort = parsePort(options?.port);
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
  return { apiUrl, preferredPort };
}

function buildDeviceKeyName(): string | undefined {
  try {
    const host = os.hostname().trim().replace(/\s+/g, "-").slice(0, 32);
    if (host) {
      return `CLI ${host}`.slice(0, 64);
    }
  } catch {}
  return undefined;
}

async function exchangeAndStore(apiUrl: string, code: string, state: string) {
  const client = new ApiClient({ apiUrl });
  const data = await client.exchangeDeviceCode(
    code,
    state,
    buildDeviceKeyName()
  );
  const rawKey = data.key;
  storeApiKeyWithRollback(apiUrl, rawKey, () => {
    saveConfig({
      apiUrl,
      keyPrefix: getApiKeyPrefix(rawKey),
      user: data.user,
    });
  });
  return { data, rawKey };
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

interface EnterPrompt {
  cancel: () => void;
  wait: Promise<void>;
}

function createEnterPrompt(): EnterPrompt {
  if (!process.stdin.isTTY) {
    return { cancel: () => undefined, wait: Promise.resolve() };
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let cancel!: () => void;
  const wait = new Promise<void>((resolve) => {
    cancel = () => {
      rl.close();
      resolve();
    };
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
  return { cancel, wait };
}

function printAuthorizeUrls(
  mode: "signup" | "login",
  authorizeUrl: string,
  noBrowser: boolean
): void {
  console.log();
  console.log(`${pc.bold(mode === "login" ? "Logging in" : "Signing up")}...`);
  console.log();
  console.log(`  ${pc.cyan(authorizeUrl)}`);
  console.log();
  if (noBrowser) {
    console.log(pc.dim("Open the URL above to continue."));
  } else {
    console.log("Press Enter to open the browser, or open the URL manually.");
  }
  console.log();
}

async function awaitBrowserCode(
  server: Awaited<ReturnType<typeof startLoopbackServer>>,
  expectedState: string
): Promise<{ code: string; state: string }> {
  const result = await server.waitForCallback();
  if (result.state !== expectedState) {
    throw new Error("State mismatch. Run the command again.");
  }
  return result;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: interactive auth flow
export async function signupCommand(options?: SignupOptions): Promise<void> {
  const mode = options?.mode ?? "signup";

  let prereqs: SignupPrereqs;
  try {
    prereqs = resolveSignupPrereqs(options);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Already logged in")
    ) {
      printError(error.message);
    } else {
      printError(
        error instanceof Error ? error.message : "Invalid signup options."
      );
    }
    process.exitCode = 1;
    return;
  }
  const { apiUrl, preferredPort } = prereqs;
  const state = generateDeviceState();
  const timeoutMs = options?.timeoutMs ?? DEVICE_FLOW_TIMEOUT_MS;

  let server: Awaited<ReturnType<typeof startLoopbackServer>>;
  try {
    server = await startLoopbackServer(state, {
      port: preferredPort,
      timeoutMs,
    });
  } catch (error) {
    printError(
      error instanceof Error
        ? error.message
        : "Could not start local callback server."
    );
    process.exitCode = 1;
    return;
  }

  const authorizeUrl = buildAuthorizeUrl(apiUrl, server.port, state, mode);
  const noBrowser = options?.noBrowser ?? false;
  printAuthorizeUrls(mode, authorizeUrl, noBrowser);

  const callbackPending = awaitBrowserCode(server, state);

  let code: string;
  let returnedState: string;
  if (noBrowser) {
    const waitSpinner = createSpinner("Waiting for browser sign-in...").start();
    try {
      ({ code, state: returnedState } = await callbackPending);
      server.close();
    } catch (error) {
      server.close();
      waitSpinner.fail(
        error instanceof Error ? error.message : "Browser sign-in failed"
      );
      process.exitCode = 1;
      return;
    }
    waitSpinner.stop();
  } else {
    const prompt = createEnterPrompt();
    let first:
      | (Awaited<typeof callbackPending> & { kind: "callback" })
      | {
          kind: "enter";
        };
    try {
      first = await Promise.race([
        prompt.wait.then(() => ({ kind: "enter" as const })),
        callbackPending.then((callback) => ({
          ...callback,
          kind: "callback" as const,
        })),
      ]);
    } catch (error) {
      server.close();
      printError(
        error instanceof Error ? error.message : "Browser sign-in failed"
      );
      process.exitCode = 1;
      return;
    } finally {
      prompt.cancel();
    }
    if (first.kind === "callback") {
      ({ code, state: returnedState } = first);
      server.close();
    } else {
      openBrowser(authorizeUrl);
      const waitSpinner = createSpinner(
        "Waiting for browser sign-in..."
      ).start();
      try {
        ({ code, state: returnedState } = await callbackPending);
        server.close();
      } catch (error) {
        server.close();
        waitSpinner.fail(
          error instanceof Error ? error.message : "Browser sign-in failed"
        );
        process.exitCode = 1;
        return;
      }
      waitSpinner.stop();
    }
  }
  const exchangeSpinner = createSpinner("Creating API key...").start();
  try {
    const { data, rawKey } = await exchangeAndStore(
      apiUrl,
      code,
      returnedState
    );
    if (mode === "login") {
      exchangeSpinner.succeed(`✓ Logged in as ${data.user.name}`);
    } else {
      exchangeSpinner.succeed("✓ Account created");
      console.log(`Signed in as ${data.user.name}`);
    }
    printSignupSuccess(apiUrl, data.user, rawKey);
  } catch (error) {
    exchangeSpinner.fail(
      error instanceof Error ? error.message : "Failed to create API key"
    );
    process.exitCode = 1;
  }
}
