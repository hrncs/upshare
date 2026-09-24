import readline from "node:readline";
import pc from "picocolors";
import { ApiClient } from "../lib/api-client";
import {
  resolveCommandContext,
  saveProfile,
  setCurrentProfile,
} from "../lib/config";
import type { CredentialBackend } from "../lib/credentials";
import {
  ensureCredentialStoreAccessible,
  getApiKeyPrefix,
  getCredentialStoreName,
  getEnvironmentApiKey,
  getKeyringAccount,
  maskApiKey,
  nativeCredentialBackend,
  storeProfileApiKeyWithRollback,
} from "../lib/credentials";
import { sanitizeTerminalText } from "../lib/format";
import { printError, printFields, printWarning } from "../lib/output";
import { createSpinner } from "../lib/spinner";

const ESCAPE_END_PATTERN = /[a-zA-Z~]$/;

function removeLastCodePoint(value: string): string {
  const chars = Array.from(value);
  chars.pop();
  return chars.join("");
}

type KeyAction =
  | { type: "append"; char: string }
  | { type: "backspace" }
  | { type: "cancel" }
  | { type: "clear" }
  | { type: "ignore" }
  | { type: "submit" };

function classifyKeypress(character: string): KeyAction {
  if (character === "\r" || character === "\n") {
    return { type: "submit" };
  }
  if (character === "\\u0003" || character === "\\u0004") {
    return { type: "cancel" };
  }
  if (character === "\\u0015") {
    return { type: "clear" };
  }
  if (character === "\b" || character === "\\u007f") {
    return { type: "backspace" };
  }
  if (character < " ") {
    return { type: "ignore" };
  }
  return { char: character, type: "append" };
}

interface RawKeyState {
  answer: string;
  escapeBuf: string;
  inEscape: boolean;
}

function stepRawKeyState(
  state: RawKeyState,
  character: string
): KeyAction | null {
  if (state.inEscape) {
    state.escapeBuf += character;
    if (ESCAPE_END_PATTERN.test(character) || state.escapeBuf.length > 8) {
      state.inEscape = false;
      state.escapeBuf = "";
    }
    return null;
  }
  if (character === "\\u001b") {
    state.inEscape = true;
    state.escapeBuf = "";
    return null;
  }
  return classifyKeypress(character);
}

function applyKeyAction(
  state: RawKeyState,
  action: KeyAction
): "cancelled" | "submitted" | null {
  switch (action.type) {
    case "submit":
      return "submitted";
    case "cancel":
      return "cancelled";
    case "clear":
      state.answer = "";
      return null;
    case "backspace":
      state.answer = removeLastCodePoint(state.answer);
      return null;
    case "ignore":
      return null;
    case "append":
      state.answer += action.char;
      return null;
    default:
      return null;
  }
}

function promptApiKeyMuted(): Promise<string> {
  return new Promise((resolve, reject) => {
    const wasRaw = process.stdin.isRaw;
    const state: RawKeyState = { answer: "", escapeBuf: "", inEscape: false };
    const cleanup = () => {
      process.stdin.off("data", onData);
      try {
        process.stdin.setRawMode(Boolean(wasRaw));
      } catch {
        // Ignore failure to restore raw mode during shutdown.
      }
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer | string) => {
      const input = chunk.toString("utf8");
      for (const character of input) {
        const action = stepRawKeyState(state, character);
        if (!action) {
          continue;
        }
        const done = applyKeyAction(state, action);
        if (done === "submitted") {
          cleanup();
          resolve(state.answer.trim());
          return;
        }
        if (done === "cancelled") {
          cleanup();
          reject(new Error("Login cancelled."));
          return;
        }
      }
    };

    process.stdout.write(pc.cyan("Enter your UpShare API Key: "));
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

function promptApiKey(): Promise<string> {
  if (
    !(process.stdin.isTTY && process.stdout.isTTY && process.stdin.setRawMode)
  ) {
    printWarning(
      "No TTY detected: your API key will echo visibly as you type. Prefer setting UPSHARE_API_KEY for non-interactive use."
    );
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      rl.question(pc.cyan("Enter your UpShare API Key: "), (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  return promptApiKeyMuted();
}

export async function loginCommand(options?: {
  apiUrl?: string;
  backend?: CredentialBackend;
  profile?: string;
}): Promise<void> {
  const backend = options?.backend ?? nativeCredentialBackend;
  let context: { apiUrl: string; profile: string };
  try {
    context = resolveCommandContext({
      apiUrl: options?.apiUrl,
      profile: options?.profile,
    });
  } catch (error) {
    printError(
      error instanceof Error ? error.message : "Invalid login options."
    );
    process.exitCode = 1;
    return;
  }
  const { apiUrl, profile } = context;

  try {
    ensureCredentialStoreAccessible(
      getKeyringAccount(profile, apiUrl),
      backend
    );
  } catch (error) {
    printError(
      error instanceof Error
        ? error.message
        : "Could not access the credential store."
    );
    process.exitCode = 1;
    return;
  }

  let key: string;
  try {
    key = await promptApiKey();
  } catch (error) {
    printError(error instanceof Error ? error.message : "Login cancelled.");
    process.exitCode = 1;
    return;
  }

  if (!key) {
    printError("API key is required.");
    process.exitCode = 1;
    return;
  }

  const spinner = createSpinner("Verifying API Key...").start();

  try {
    const client = new ApiClient({ apiKey: key, apiUrl, profile });
    const data = await client.verifyApiKey(key);
    storeProfileApiKeyWithRollback(
      profile,
      apiUrl,
      key,
      () => {
        saveProfile(profile, {
          apiUrl,
          keyPrefix: getApiKeyPrefix(key),
          user: data.user,
        });
      },
      backend
    );
    setCurrentProfile(profile);

    spinner.succeed(`Logged in as ${data.user.name}`);
    console.log();
    printFields([
      ["Profile", profile],
      ["Email", data.user.email],
      ["API key", pc.gray(sanitizeTerminalText(maskApiKey(key)))],
      ["Credential", getCredentialStoreName()],
      ["API URL", apiUrl],
    ]);
    console.log();
    if (getEnvironmentApiKey()) {
      printWarning(
        "UPSHARE_API_KEY is set and takes precedence over the stored credential."
      );
    }
  } catch (error) {
    spinner.fail(
      error instanceof Error ? error.message : "Failed to verify API key"
    );
    process.exitCode = 1;
  }
}
