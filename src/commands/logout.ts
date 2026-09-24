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

function formatDeleteFailures(
  failed: Array<{ apiUrl: string; error: Error }>
): string {
  return failed
    .map(({ apiUrl, error }) => `${apiUrl}: ${error.message}`)
    .join("; ");
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
        `Invalid local configuration removed, but ${result.failed.length} stored credential(s) could not be removed from ${getCredentialStoreName()}. ${formatDeleteFailures(result.failed)}`
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
}

function collectConfiguredAccounts(
  config: CliConfig,
  context: { apiUrl: string; profile: string }
): string[] {
  const configured: string[] = [];
  for (const [name, entry] of Object.entries(config.profiles ?? {})) {
    configured.push(getKeyringAccount(name, entry.apiUrl));
  }
  configured.push(getKeyringAccount(context.profile, context.apiUrl));
  return [...new Set(configured)];
}

function tryDeleteTarget(
  target: string,
  backend: CredentialBackend,
  deleted: Set<string>,
  failures: Map<string, Error>
): void {
  if (deleted.has(target) || failures.has(target)) {
    return;
  }
  try {
    if (deleteStoredApiKey(target, backend)) {
      deleted.add(target);
    }
  } catch (error) {
    failures.set(
      target,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

function reportLogoutAllResult(
  deleted: Set<string>,
  failures: Map<string, Error>,
  profileCount: number
): void {
  if (failures.size > 0) {
    const details = [...failures.entries()]
      .map(([url, err]) => `${url}: ${err.message}`)
      .join("; ");
    printWarning(
      `Local configuration cleared, but ${failures.size} stored credential(s) may still be present in ${getCredentialStoreName()}: ${details}`
    );
    process.exitCode = 1;
    return;
  }
  if (deleted.size > 0) {
    printSuccess(
      deleted.size === 1
        ? "Logged out"
        : `Logged out; removed ${deleted.size} stored credentials`
    );
    return;
  }
  if (profileCount > 0) {
    printSuccess(
      profileCount === 1
        ? "Logged out; removed 1 profile"
        : `Logged out; removed ${profileCount} profiles`
    );
    return;
  }
  printSuccess("Already logged out. No credential found.");
}

function logoutAll(
  context: { apiUrl: string; profile: string },
  backend: CredentialBackend
): void {
  const config = loadConfig();
  const profileCount = Object.keys(config.profiles ?? {}).length;
  const result = deleteAllStoredApiKeys(backend);
  const deleted = new Set(result.deletedApiUrls);
  const failures = new Map<string, Error>(
    result.failed.map(({ apiUrl, error }) => [apiUrl, error])
  );

  for (const target of collectConfiguredAccounts(config, context)) {
    tryDeleteTarget(target, backend, deleted, failures);
  }

  const legacyTarget = config.profiles?.[DEFAULT_PROFILE]?.apiUrl;
  if (legacyTarget) {
    tryDeleteTarget(legacyTarget, backend, deleted, failures);
  }

  clearConfig();
  reportLogoutAllResult(deleted, failures, profileCount);
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
    if (hasValidConfig()) {
      const context = resolveCommandContext({
        apiUrl: options?.apiUrl,
        profile: options?.profile,
      });
      if (options?.all) {
        logoutAll(context, backend);
      } else {
        logoutSingle(context, backend);
      }
    } else {
      logoutWithInvalidConfig(backend, options?.all ?? false);
    }
  } catch (error) {
    printError(
      error instanceof Error
        ? `Failed to clear credentials: ${error.message}`
        : "Failed to clear credentials."
    );
    process.exitCode = 1;
  }
  warnEnvironmentKey();
}
