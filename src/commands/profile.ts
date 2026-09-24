import pc from "picocolors";
import {
  type CliConfig,
  DEFAULT_API_URL,
  getActiveProfileName,
  loadConfig,
  normalizeProfileName,
  removeProfileFromConfig,
  saveProfile,
  setCurrentProfile,
} from "../lib/config";
import {
  type CredentialBackend,
  deleteProfileCredential,
  getEnvironmentApiKey,
  getKeyringAccount,
  nativeCredentialBackend,
  resolveProfileApiKey,
} from "../lib/credentials";
import { sanitizeTerminalText } from "../lib/format";
import {
  printError,
  printFields,
  printHeading,
  printSuccess,
  printWarning,
} from "../lib/output";
import { confirm } from "../lib/prompt";

export interface ProfileCommandOptions {
  backend?: CredentialBackend;
}

function credentialLabel(resolved: { source: string } | undefined): string {
  if (!resolved) {
    return pc.dim("None stored");
  }
  if (resolved.source === "environment") {
    return pc.dim("UPSHARE_API_KEY");
  }
  return "OS credential store";
}

export function listProfilesCommand(): void {
  try {
    const config = loadConfig();
    const names = Object.keys(config.profiles ?? {}).sort();
    if (names.length === 0) {
      console.log("No profiles yet. Run `upshare login` to create one.");
      console.log(pc.dim("Run `upshare profile add <name>` to add another."));
      return;
    }
    const current = config.currentProfile ?? getActiveProfileName();
    printHeading("Profiles");
    for (const name of names) {
      const entry = config.profiles?.[name];
      const marker = name === current ? ` ${pc.green("(current)")}` : "";
      printFields([
        ["Name", `${sanitizeTerminalText(name)}${marker}`],
        ["API URL", entry?.apiUrl ?? DEFAULT_API_URL],
        [
          "Account",
          entry?.user
            ? sanitizeTerminalText(entry.user.email)
            : pc.dim("Not logged in"),
        ],
        [
          "Key",
          entry?.keyPrefix
            ? pc.gray(sanitizeTerminalText(entry.keyPrefix))
            : pc.dim("-"),
        ],
      ]);
      console.log();
    }
  } catch (error) {
    printError(
      error instanceof Error ? error.message : "Failed to list profiles."
    );
    process.exitCode = 1;
  }
}

export function useProfileCommand(name: string): void {
  try {
    const profile = normalizeProfileName(name);
    setCurrentProfile(profile);
    const entry = loadConfig().profiles?.[profile];
    printSuccess(
      `Switched to profile "${profile}" (${entry?.apiUrl ?? DEFAULT_API_URL})`
    );
    if (!entry?.user) {
      printWarning(
        `Profile "${profile}" has no saved login. Run \`upshare login\` to log in.`
      );
    }
    if (getEnvironmentApiKey()) {
      printWarning(
        "UPSHARE_API_KEY is set and takes precedence over the stored credential."
      );
    }
  } catch (error) {
    printError(
      error instanceof Error ? error.message : "Failed to switch profile."
    );
    process.exitCode = 1;
  }
}

export function addProfileCommand(
  name: string,
  options: { apiUrl?: string } = {}
): void {
  try {
    const profile = normalizeProfileName(name);
    if (loadConfig().profiles?.[profile] !== undefined) {
      printError(`Profile "${profile}" already exists.`);
      process.exitCode = 1;
      return;
    }
    saveProfile(profile, { apiUrl: options.apiUrl ?? DEFAULT_API_URL });
    printSuccess(`Created profile "${profile}"`);
    console.log(pc.dim(`Next: upshare login -p ${profile}`));
  } catch (error) {
    printError(
      error instanceof Error ? error.message : "Failed to add profile."
    );
    process.exitCode = 1;
  }
}

export function showProfileCommand(name?: string): void {
  try {
    const config = loadConfig();
    const profile = getActiveProfileName(name);
    const entry = config.profiles?.[profile];
    if (!entry) {
      printError(`Profile "${profile}" not found.`);
      process.exitCode = 1;
      return;
    }
    let resolved: { source: string } | undefined;
    try {
      resolved = resolveProfileApiKey(profile, entry.apiUrl) ?? undefined;
    } catch (error) {
      printWarning(
        error instanceof Error
          ? `Could not read stored credential: ${error.message}`
          : "Could not read stored credential."
      );
    }
    printHeading(`Profile "${profile}"`);
    printFields([
      ["API URL", entry.apiUrl],
      [
        "Account",
        entry.user
          ? sanitizeTerminalText(entry.user.email)
          : pc.dim("Not logged in"),
      ],
      [
        "Key",
        entry.keyPrefix
          ? pc.gray(sanitizeTerminalText(entry.keyPrefix))
          : pc.dim("-"),
      ],
      ["Credential", credentialLabel(resolved)],
    ]);
    console.log();
  } catch (error) {
    printError(
      error instanceof Error ? error.message : "Failed to show profile."
    );
    process.exitCode = 1;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: command handler with credential rollback
export async function removeProfileCommand(
  name: string,
  options?: { backend?: CredentialBackend; yes?: boolean }
): Promise<void> {
  const backend = options?.backend ?? nativeCredentialBackend;
  let profile: string;
  try {
    profile = normalizeProfileName(name);
  } catch (error) {
    printError(
      error instanceof Error ? error.message : "Invalid profile name."
    );
    process.exitCode = 1;
    return;
  }
  let config: CliConfig;
  try {
    config = loadConfig();
  } catch (error) {
    printError(
      error instanceof Error ? error.message : "Failed to load profiles."
    );
    process.exitCode = 1;
    return;
  }
  const entry = config.profiles?.[profile];
  if (!entry) {
    printError(`Profile "${profile}" not found. Nothing to remove.`);
    process.exitCode = 1;
    return;
  }

  if (!options?.yes) {
    const ok = await confirm(
      `Remove profile "${profile}" and its stored credential? (y/N): `,
      { yes: options?.yes }
    );
    if (!ok) {
      if (process.exitCode === 130) {
        return;
      }
      console.log(pc.dim("Remove cancelled."));
      return;
    }
  }

  const account = getKeyringAccount(profile, entry.apiUrl);
  let previousKey: string | undefined;
  try {
    previousKey = backend.get(account) ?? undefined;
  } catch {
    previousKey = undefined;
  }
  let deletedCredential = false;
  let storeError: Error | undefined;
  try {
    deletedCredential = deleteProfileCredential(profile, entry.apiUrl, backend);
  } catch (error) {
    storeError =
      error instanceof Error
        ? error
        : new Error("Could not access the credential store.");
  }
  try {
    removeProfileFromConfig(profile);
  } catch (error) {
    if (deletedCredential && previousKey !== undefined) {
      try {
        backend.set(account, previousKey);
      } catch {
        // Intentionally ignored: rollback is best-effort.
      }
    }
    printError(
      error instanceof Error ? error.message : "Failed to remove profile."
    );
    process.exitCode = 1;
    return;
  }
  if (storeError) {
    printWarning(
      `Profile removed, but the stored credential may still be present: ${storeError.message}`
    );
    process.exitCode = 1;
    return;
  }
  printSuccess(`Removed profile "${profile}"`);
}
