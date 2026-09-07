import { clearConfig, getEffectiveApiUrl, loadConfig } from "../lib/config";
import {
  deleteStoredApiKey,
  getEnvironmentApiKey,
  nativeCredentialBackend,
} from "../lib/credentials";
import { printError, printSuccess, printWarning } from "../lib/output";

export function logoutCommand(options?: { apiUrl?: string }): void {
  try {
    try {
      loadConfig();
    } catch {
      clearConfig();
      printSuccess("Logged out; invalid local configuration removed");
      if (getEnvironmentApiKey()) {
        printWarning(
          "UPSHARE_API_KEY is still set in this environment and cannot be removed by the CLI."
        );
      }
      return;
    }
    const apiUrl = getEffectiveApiUrl(options?.apiUrl);
    let removedStoredCredential = false;
    try {
      if (nativeCredentialBackend.get(apiUrl) !== undefined) {
        removedStoredCredential = deleteStoredApiKey(apiUrl);
      }
    } catch {
      removedStoredCredential = false;
    }
    clearConfig();
    if (removedStoredCredential) {
      printSuccess("Logged out");
    } else {
      printSuccess("Already logged out. No credential found.");
    }
    if (getEnvironmentApiKey()) {
      printWarning(
        "UPSHARE_API_KEY is still set in this environment and cannot be removed by the CLI."
      );
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
