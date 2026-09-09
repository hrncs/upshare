import readline from "node:readline/promises";
import pc from "picocolors";
import {
  DEFAULT_API_URL,
  getActiveProfileName,
  listProfileNames,
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

export interface ProfileCommandOptions {
  backend?: CredentialBackend;
}

function profileFields(profile: string) {
  const entry = loadConfig().profiles?.[profile];
  const resolved = entry
    ? resolveProfileApiKey(profile, entry.apiUrl)
    : undefined;
  return { entry, resolved };
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
    const names = listProfileNames();
    if (names.length === 0) {
      console.log("No profiles yet. Run `upshare login` to create one.");
      console.log(pc.dim("Run `upshare profile add <name>` to add another."));
      return;
    }
    const current = getActiveProfileName();
    printHeading("Profiles");
    for (const name of names) {
      const { entry } = profileFields(name);
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
    const profile = getActiveProfileName(name);
    const { entry, resolved } = profileFields(profile);
    if (!entry) {
      printError(`Profile "${profile}" not found.`);
      process.exitCode = 1;
      return;
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
  const entry = loadConfig().profiles?.[profile];
  if (!entry) {
    printError(`Profile "${profile}" not found. Nothing to remove.`);
    process.exitCode = 1;
    return;
  }

  if (!options?.yes) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await rl.question(
        pc.yellow(
          `Remove profile "${profile}" and its stored credential? (y/N): `
        )
      );
      if (
        answer.trim().toLowerCase() !== "y" &&
        answer.trim().toLowerCase() !== "yes"
      ) {
        console.log(pc.dim("Remove cancelled."));
        return;
      }
    } catch {
      console.log();
      console.log(pc.dim("Remove cancelled."));
      return;
    } finally {
      rl.close();
    }
  }

  let storeError: Error | undefined;
  try {
    deleteProfileCredential(profile, entry.apiUrl, backend);
  } catch (error) {
    storeError =
      error instanceof Error
        ? error
        : new Error("Could not access the credential store.");
  }
  try {
    removeProfileFromConfig(profile);
  } catch (error) {
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
