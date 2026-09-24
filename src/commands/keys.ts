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
  // `current` refers to the API key used for this request.
  if (lowered === "current") {
    return keys.find((key) => key.id === currentKeyId) ?? null;
  }
  const byId = keys.find((key) => key.id === trimmed);
  if (byId) {
    return byId;
  }
  const prefixMatches = keys.filter(
    (key) =>
      key.keyPrefix === trimmed ||
      (trimmed.length >= 4 && key.keyPrefix.endsWith(trimmed))
  );
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(
      `Ambiguous API key prefix: ${prefixMatches.length} matches. Use a full id or name. Run \`upshare keys\` to list keys.`
    );
  }
  const byName = keys.filter((key) => key.name.toLowerCase() === lowered);
  if (byName.length === 1) {
    return byName[0];
  }
  if (byName.length > 1) {
    throw new Error(
      `Ambiguous API key name: ${byName.length} matches. Use a full id or prefix. Run \`upshare keys\` to list keys.`
    );
  }
  return null;
}

export async function listKeysCommand(options?: {
  apiUrl?: string;
  profile?: string;
}): Promise<void> {
  const spinner = createSpinner("Fetching API keys...").start();
  try {
    const client = new ApiClient({
      apiUrl: options?.apiUrl,
      profile: options?.profile,
    });
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
  options?: { apiUrl?: string; profile?: string }
): Promise<void> {
  const trimmedName = name.trim();
  if (trimmedName.length === 0 || trimmedName.length > 64) {
    printError("New key name must be 1-64 characters.");
    process.exitCode = 1;
    return;
  }

  const spinner = createSpinner("Fetching API keys...").start();
  try {
    const client = new ApiClient({
      apiUrl: options?.apiUrl,
      profile: options?.profile,
    });
    const data = await client.listApiKeys();
    let match: ApiKeyItem | null;
    try {
      match = resolveKeyTarget(data.apiKeys, target, data.currentKeyId);
    } catch (error) {
      spinner.fail(
        error instanceof Error ? error.message : "Ambiguous API key."
      );
      process.exitCode = 1;
      return;
    }
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
