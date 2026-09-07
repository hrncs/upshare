import pc from "picocolors";
import { ApiClient } from "../lib/api-client";
import { DEFAULT_API_URL, getEffectiveApiUrl } from "../lib/config";
import { printError, printFields, printHeading } from "../lib/output";
import { createSpinner } from "../lib/spinner";

export const SUPPORT_EMAIL = "support@upshare.app";

function checkLabel(check: { status: string }): string {
  return check.status.toLowerCase() === "ok"
    ? pc.green("ok")
    : pc.yellow(check.status);
}

export async function statusCommand(options?: {
  apiUrl?: string;
}): Promise<void> {
  const spinner = createSpinner("Checking UpShare status...").start();
  const client = new ApiClient({ apiUrl: options?.apiUrl });
  const showSupport = getEffectiveApiUrl(options?.apiUrl) === DEFAULT_API_URL;

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
