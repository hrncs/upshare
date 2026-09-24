import pc from "picocolors";
import { ApiClient } from "../lib/api-client";
import { DEFAULT_API_URL, getEffectiveApiUrl } from "../lib/config";
import { printError, printFields, printHeading } from "../lib/output";
import { createSpinner } from "../lib/spinner";

export const SUPPORT_EMAIL = "support@upshare.app";

function checkLabel(check: { state?: string; status?: string }): string {
  const value = check.status ?? check.state ?? "unknown";
  return value.toLowerCase() === "ok" ? pc.green("ok") : pc.yellow(value);
}

export async function statusCommand(options?: {
  apiUrl?: string;
  profile?: string;
}): Promise<void> {
  const spinner = createSpinner("Checking UpShare status...").start();
  const client = new ApiClient({
    apiUrl: options?.apiUrl,
    profile: options?.profile,
  });

  let showSupport = false;
  try {
    showSupport =
      getEffectiveApiUrl(options?.apiUrl, options?.profile) === DEFAULT_API_URL;
  } catch {
    showSupport = false;
  }

  try {
    const data = await client.checkHealth();
    spinner.stop();
    const status = data.status.toLowerCase();

    if (status === "ok" || status === "degraded") {
      const degraded = status === "degraded";
      printHeading("UpShare Status");
      const fields: [string, string][] = [
        ["API", degraded ? pc.yellow("Degraded") : pc.green("Operational")],
      ];
      if (data.checks) {
        fields.push(["Database", checkLabel(data.checks.database)]);
        fields.push(["Storage", checkLabel(data.checks.storage)]);
      }
      if (degraded && showSupport) {
        fields.push(["Contact us:", SUPPORT_EMAIL]);
      }
      printFields(fields);
      console.log();
      if (degraded) {
        printError(
          "Some UpShare features may be unavailable. Try again shortly."
        );
        process.exitCode = 1;
      }
      return;
    }

    console.log();
    printError(
      `UpShare reported an unexpected status ('${data.status}'). Try again shortly.`
    );
    if (showSupport) {
      printFields([["Contact us:", SUPPORT_EMAIL]]);
    }
    console.log();
    process.exitCode = 1;
  } catch (error) {
    spinner.stop();
    console.log();
    printError(
      error instanceof Error ? error.message : "Could not reach UpShare.",
      "Check your connection or pass --api-url with the correct API URL."
    );
    if (showSupport) {
      printFields([["Contact us:", SUPPORT_EMAIL]]);
    }
    console.log();
    process.exitCode = 1;
  }
}
