import { clearConfig, getEffectiveApiUrl, loadConfig } from "../lib/config";
import {
  type CredentialBackend,
  deleteAllStoredApiKeys,
  deleteStoredApiKey,
  ensureCredentialStoreAccessible,
  getCredentialStoreName,
  getEnvironmentApiKey,
  nativeCredentialBackend,
} from "../lib/credentials";
import { printError, printSuccess, printWarning } from "../lib/output";

export interface LogoutOptions {
  all?: boolean;
  apiUrl?: string;
  backend?: CredentialBackend;
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

function collectLogoutTargets(
  apiUrl: string,
  backend: CredentialBackend
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
  return [...new Set([...listed, apiUrl])];
}

function deleteLogoutTargets(
  targets: string[],
  backend: CredentialBackend
): { deletedCount: number; failedUrls: string[] } {
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
  return { deletedCount, failedUrls };
}

function logoutAll(apiUrl: string, backend: CredentialBackend): void {
  const targets = collectLogoutTargets(apiUrl, backend);
  const { deletedCount, failedUrls } = deleteLogoutTargets(targets, backend);
  if (failedUrls.length === 0) {
    try {
      ensureCredentialStoreAccessible(apiUrl, backend);
    } catch (error) {
      printWarning(
        error instanceof Error
          ? error.message
          : "Could not access the credential store."
      );
      failedUrls.push(apiUrl);
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
  } else {
    printSuccess("Already logged out. No credential found.");
  }
  warnEnvironmentKey();
}

function logoutSingle(apiUrl: string, backend: CredentialBackend): void {
  let removedStoredCredential = false;
  let storeError: Error | undefined;
  try {
    removedStoredCredential = deleteStoredApiKey(apiUrl, backend);
  } catch (error) {
    storeError =
      error instanceof Error
        ? error
        : new Error("Could not access the credential store.");
  }
  clearConfig();
  if (storeError) {
    printWarning(
      `Could not remove the stored credential: ${storeError.message} It may still be present in ${getCredentialStoreName()}.`
    );
    printSuccess("Local configuration cleared");
    process.exitCode = 1;
  } else if (removedStoredCredential) {
    printSuccess("Logged out");
  } else {
    printSuccess("Already logged out. No credential found.");
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
    const apiUrl = getEffectiveApiUrl(options?.apiUrl);
    if (options?.all) {
      logoutAll(apiUrl, backend);
    } else {
      logoutSingle(apiUrl, backend);
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
