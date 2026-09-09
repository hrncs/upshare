import readline from "node:readline";
import pc from "picocolors";
import { ApiClient } from "../lib/api-client";
import { getEffectiveApiUrl, saveConfig } from "../lib/config";
import {
  type CredentialBackend,
  ensureCredentialStoreAccessible,
  getApiKeyPrefix,
  getCredentialStoreName,
  getEnvironmentApiKey,
  maskApiKey,
  nativeCredentialBackend,
  storeApiKeyWithRollback,
} from "../lib/credentials";
import { sanitizeTerminalText } from "../lib/format";
import { printError, printFields, printWarning } from "../lib/output";
import { createSpinner } from "../lib/spinner";

function promptApiKey(): Promise<string> {
  if (
    !(process.stdin.isTTY && process.stdout.isTTY && process.stdin.setRawMode)
  ) {
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

  return new Promise((resolve, reject) => {
    const wasRaw = process.stdin.isRaw;
    let answer = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write("\n");
    };
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: raw TTY handler
    const onData = (chunk: Buffer | string) => {
      const input = chunk.toString("utf8");
      for (const character of input) {
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(answer.trim());
          return;
        }
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Login cancelled."));
          return;
        }
        if (character === "\b" || character === "\u007f") {
          answer = answer.slice(0, -1);
        } else if (character >= " ") {
          answer += character;
        }
      }
    };

    process.stdout.write(pc.cyan("Enter your UpShare API Key: "));
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

export async function loginCommand(options?: {
  apiUrl?: string;
  backend?: CredentialBackend;
}): Promise<void> {
  const backend = options?.backend ?? nativeCredentialBackend;
  let apiUrl: string;
  try {
    apiUrl = getEffectiveApiUrl(options?.apiUrl);
  } catch (error) {
    printError(error instanceof Error ? error.message : "Invalid API URL.");
    process.exitCode = 1;
    return;
  }

  try {
    ensureCredentialStoreAccessible(apiUrl, backend);
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
    const client = new ApiClient({ apiKey: key, apiUrl });
    const data = await client.verifyApiKey(key);
    storeApiKeyWithRollback(
      apiUrl,
      key,
      () => {
        saveConfig({
          apiUrl,
          keyPrefix: getApiKeyPrefix(key),
          user: data.user,
        });
      },
      backend
    );

    spinner.succeed(`✓ Logged in as ${data.user.name}`);
    console.log();
    printFields([
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
