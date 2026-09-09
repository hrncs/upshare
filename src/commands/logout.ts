import {
  type CliConfig,
  clearConfig,
  clearProfileLogin,
  DEFAULT_PROFILE,
  loadConfig,
  resolveCommandContext,
} from "../lib/config";
import {
  type CredentialBackend,
  deleteAllStoredApiKeys,
  deleteProfileCredential,
  deleteStoredApiKey,
  ensureCredentialStoreAccessible,
  getCredentialStoreName,
  getEnvironmentApiKey,
  getKeyringAccount,
  nativeCredentialBackend,
} from "../lib/credentials";
import { printError, printSuccess, printWarning } from "../lib/output";

export interface LogoutOptions {
  all?: boolean;
  apiUrl?: string;
  backend?: CredentialBackend;
  profile?: string;
}

function warnEnvironmentKey(): void {
  if (getEnvironmentApiKey()) {
    printWarning(
      "UPSHARE_API_KEY is still set in this environment and cannot be removed by the CLI."
    );
  }
}

function logoutWithInvalidConfig(
  backend: CredentialBackend,
  all: boolean
): void {
  clearConfig();
  if (all) {
    const result = deleteAllStoredApiKeys(backend);
    if (result.failed.length > 0) {
      printWarning(
        `Invalid local configuration removed, but ${result.failed.length} stored credential(s) could not be removed from ${getCredentialStoreName()}. It may still be present.`
      );
      process.exitCode = 1;
    } else if (result.deletedApiUrls.length > 0) {
      printSuccess(
        `Logged out; invalid local configuration removed and ${result.deletedApiUrls.length} stored credential(s) removed`
      );
    } else {
      printSuccess("Logged out; invalid local configuration removed");
      printWarning(
        "No stored OS credential was found. If a credential exists for a different API URL, run `upshare logout --all`."
      );
    }
  } else {
    printSuccess("Logged out; invalid local configuration removed");
    printWarning(
      "Stored OS credentials were not checked. Run `upshare logout --all` to remove credentials for all API URLs."
    );
  }
  warnEnvironmentKey();
}

function collectLogoutAllTargets(
  backend: CredentialBackend,
  config: CliConfig,
  context: { apiUrl: string; profile: string }
): string[] {
  let listed: string[] = [];
  try {
    listed = backend.list?.() ?? [];
  } catch (error) {
    printWarning(
      error instanceof Error
        ? `Could not list stored credentials: ${error.message}`
        : "Could not list stored credentials."
    );
  }
  const configured: string[] = [];
  for (const [name, entry] of Object.entries(config.profiles ?? {})) {
    configured.push(getKeyringAccount(name, entry.apiUrl));
    if (name === DEFAULT_PROFILE) {
      configured.push(entry.apiUrl);
    }
  }
  return [
    ...new Set([
      ...listed,
      ...configured,
      getKeyringAccount(context.profile, context.apiUrl),
    ]),
  ];
}

function logoutAll(
  context: { apiUrl: string; profile: string },
  backend: CredentialBackend
): void {
  const config = loadConfig();
  const profileCount = Object.keys(config.profiles ?? {}).length;
  const targets = collectLogoutAllTargets(backend, config, context);
  let deletedCount = 0;
  const failedUrls: string[] = [];
  for (const target of targets) {
    try {
      if (deleteStoredApiKey(target, backend)) {
        deletedCount += 1;
      }
    } catch {
      failedUrls.push(target);
    }
  }
  if (failedUrls.length === 0) {
    try {
      ensureCredentialStoreAccessible(
        getKeyringAccount(context.profile, context.apiUrl),
        backend
      );
    } catch (error) {
      printWarning(
        error instanceof Error
          ? error.message
          : "Could not access the credential store."
      );
      failedUrls.push(context.apiUrl);
    }
  }
  clearConfig();
  if (failedUrls.length > 0) {
    printWarning(
      `Local configuration cleared, but the stored credential may still be present in ${getCredentialStoreName()}.`
    );
    process.exitCode = 1;
  } else if (deletedCount > 0) {
    printSuccess(
      deletedCount === 1
        ? "Logged out"
        : `Logged out; removed ${deletedCount} stored credentials`
    );
  } else if (profileCount > 0) {
    printSuccess(
      profileCount === 1
        ? "Logged out; removed 1 profile"
        : `Logged out; removed ${profileCount} profiles`
    );
  } else {
    printSuccess("Already logged out. No credential found.");
  }
  warnEnvironmentKey();
}

function logoutSingle(
  context: { apiUrl: string; profile: string },
  backend: CredentialBackend
): void {
  const { apiUrl, profile } = context;
  let removedStoredCredential = false;
  let storeError: Error | undefined;
  try {
    removedStoredCredential = deleteProfileCredential(profile, apiUrl, backend);
  } catch (error) {
    storeError =
      error instanceof Error
        ? error
        : new Error("Could not access the credential store.");
  }
  clearProfileLogin(profile);
  if (storeError) {
    printWarning(
      `Could not remove the stored credential: ${storeError.message} It may still be present in ${getCredentialStoreName()}.`
    );
    printSuccess("Local configuration cleared");
    process.exitCode = 1;
  } else if (removedStoredCredential) {
    printSuccess(`Logged out of profile "${profile}"`);
  } else {
    printSuccess(
      `Already logged out of profile "${profile}". No credential found.`
    );
  }
  warnEnvironmentKey();
}

function hasValidConfig(): boolean {
  try {
    loadConfig();
    return true;
  } catch {
    return false;
  }
}

export function logoutCommand(options?: LogoutOptions): void {
  const backend = options?.backend ?? nativeCredentialBackend;
  try {
    if (!hasValidConfig()) {
      logoutWithInvalidConfig(backend, options?.all ?? false);
      return;
    }
    const context = resolveCommandContext({
      apiUrl: options?.apiUrl,
      profile: options?.profile,
    });
    if (options?.all) {
      logoutAll(context, backend);
    } else {
      logoutSingle(context, backend);
    }
  } catch (error) {
    printError(
      error instanceof Error
        ? `Failed to clear credentials: ${error.message}`
        : "Failed to clear credentials."
    );
    process.exitCode = 1;
  }
}
