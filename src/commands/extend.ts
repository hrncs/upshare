import pc from "picocolors";
import { formatRelativeTime } from "../lib/format";
import { printError, printFields, printWarning } from "../lib/output";
import { resolveShareTarget, startShareSpinner } from "../lib/share-helpers";

export async function extendCommand(
  target: string,
  options?: { apiUrl?: string; duration?: string; profile?: string }
): Promise<void> {
  let resolved: ReturnType<typeof resolveShareTarget>;
  try {
    resolved = resolveShareTarget(target, options);
  } catch (error) {
    printError(error instanceof Error ? error.message : "Invalid duration");
    process.exitCode = 1;
    return;
  }

  const spinner = startShareSpinner(
    `Extending expiration for '${resolved.id}'...`
  );

  try {
    const result = await resolved.client.extendShare(
      resolved.id,
      resolved.durationHours
    );
    spinner.succeed(
      `Expiration extended for ${result.fileName || resolved.id}`
    );

    console.log();
    printFields([
      ["Share URL", pc.cyan(pc.bold(result.shareUrl))],
      ["Token", result.token],
      [
        "Expires",
        `${formatRelativeTime(result.expiresAt)} (${new Date(result.expiresAt).toLocaleString()})`,
      ],
    ]);
    if (result.capped) {
      console.log();
      printWarning("Share duration was limited by the file expiration.");
    }
    console.log();
  } catch (error) {
    spinner.fail(
      error instanceof Error ? error.message : "Failed to extend expiration"
    );
    process.exitCode = 1;
  }
}
