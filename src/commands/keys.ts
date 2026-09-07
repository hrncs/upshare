import pc from "picocolors";
import { ApiClient } from "../lib/api-client";
import { formatAge, sanitizeTerminalText } from "../lib/format";
import { printError, printFields } from "../lib/output";
import type { ApiKeyItem } from "../lib/schemas";
import { createSpinner } from "../lib/spinner";

function resolveKeyTarget(
  keys: ApiKeyItem[],
  target: string,
  currentKeyId?: string | null
): ApiKeyItem | null {
  const trimmed = target.trim();
  if (!trimmed) {
    return null;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === "current" || lowered === "this") {
    return keys.find((key) => key.id === currentKeyId) ?? null;
  }
  const byId = keys.find((key) => key.id === trimmed);
  if (byId) {
    return byId;
  }
  const byPrefix = keys.filter(
    (key) =>
      key.keyPrefix === trimmed || key.keyPrefix.endsWith(trimmed.slice(-4))
  );
  if (byPrefix.length === 1) {
    return byPrefix[0];
  }
  if (byPrefix.length > 1) {
    return null;
  }
  const byName = keys.filter((key) => key.name.toLowerCase() === lowered);
  return byName.length === 1 ? byName[0] : null;
}

export async function listKeysCommand(options?: {
  apiUrl?: string;
}): Promise<void> {
  const spinner = createSpinner("Fetching API keys...").start();
  try {
    const client = new ApiClient({ apiUrl: options?.apiUrl });
    const data = await client.listApiKeys();
    spinner.stop();
    if (data.apiKeys.length === 0) {
      console.log("No active API keys.");
      return;
    }
    console.log();
    for (const key of data.apiKeys) {
      const marker =
        data.currentKeyId === key.id ? ` ${pc.green("(current)")}` : "";
      printFields([
        ["Name", `${sanitizeTerminalText(key.name)}${marker}`],
        ["ID", key.id],
        ["Prefix", pc.gray(sanitizeTerminalText(key.keyPrefix))],
        [
          "Created",
          `${new Date(key.createdAt).toLocaleString()} (${formatAge(key.createdAt)})`,
        ],
        [
          "Last used",
          key.lastUsedAt
            ? `${new Date(key.lastUsedAt).toLocaleString()} (${formatAge(key.lastUsedAt)})`
            : "Never",
        ],
      ]);
      console.log();
    }
  } catch (error) {
    spinner.fail(
      error instanceof Error ? error.message : "Failed to fetch API keys"
    );
    process.exitCode = 1;
  }
}

export async function renameKeyCommand(
  target: string,
  name: string,
  options?: { apiUrl?: string }
): Promise<void> {
  const trimmedName = name.trim();
  if (!(trimmedName.length >= 1 && trimmedName.length <= 64)) {
    printError("New key name must be 1-64 characters.");
    process.exitCode = 1;
    return;
  }

  const spinner = createSpinner("Fetching API keys...").start();
  try {
    const client = new ApiClient({ apiUrl: options?.apiUrl });
    const data = await client.listApiKeys();
    const match = resolveKeyTarget(data.apiKeys, target, data.currentKeyId);
    if (!match) {
      spinner.fail(
        "API key not found. Use an id, prefix, name, or `current`. Run `upshare keys` to list keys."
      );
      process.exitCode = 1;
      return;
    }
    spinner.text = "Renaming API key...";
    const result = await client.renameApiKey(match.id, trimmedName);
    spinner.succeed(`Renamed to ${sanitizeTerminalText(result.apiKey.name)}`);
    console.log();
    printFields([
      ["Name", pc.bold(sanitizeTerminalText(result.apiKey.name))],
      ["ID", result.apiKey.id],
      ["Prefix", pc.gray(sanitizeTerminalText(result.apiKey.keyPrefix))],
      [
        "Created",
        `${new Date(result.apiKey.createdAt).toLocaleString()} (${formatAge(result.apiKey.createdAt)})`,
      ],
      [
        "Last used",
        result.apiKey.lastUsedAt
          ? `${new Date(result.apiKey.lastUsedAt).toLocaleString()} (${formatAge(result.apiKey.lastUsedAt)})`
          : "Never",
      ],
    ]);
    console.log();
  } catch (error) {
    spinner.fail(
      error instanceof Error ? error.message : "Failed to rename API key"
    );
    process.exitCode = 1;
  }
}
