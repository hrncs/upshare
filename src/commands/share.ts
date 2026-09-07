import pc from "picocolors";
import { ApiClient } from "../lib/api-client";
import { cleanIdentifier, formatRelativeTime } from "../lib/format";
import { printError, printFields, printWarning } from "../lib/output";
import { createSpinner } from "../lib/spinner";
import { parseDurationHours } from "../lib/validation";

export async function shareCommand(
  target: string,
  options?: { apiUrl?: string; duration?: string }
): Promise<void> {
  const id = cleanIdentifier(target);
  if (!id) {
    printError("File identifier or share token is required.");
    process.exitCode = 1;
    return;
  }

  let durationHours: number;
  try {
    durationHours = parseDurationHours(options?.duration, 24, 0.5);
  } catch (error) {
    printError(error instanceof Error ? error.message : "Invalid duration");
    process.exitCode = 1;
    return;
  }

  const client = new ApiClient({ apiUrl: options?.apiUrl });
  const spinner = createSpinner(`Generating share link for '${id}'...`).start();

  try {
    const result = await client.createShare(id, durationHours);
    spinner.succeed(`Share link created for ${result.fileName || id}`);

    console.log();
    printFields([
      ["Share URL", pc.cyan(pc.bold(result.shareUrl))],
      ["Token", result.token],
      ["File ID", result.fileId],
      [
        "Expires",
        `${formatRelativeTime(result.expiresAt)} (${new Date(result.expiresAt).toLocaleString()})`,
      ],
    ]);
    if (result.capped) {
      console.log();
      printWarning("Expiration was limited by the file expiration.");
    }
    console.log();
  } catch (error) {
    spinner.fail(
      error instanceof Error ? error.message : "Failed to create share link"
    );
    process.exitCode = 1;
  }
}

export async function revokeCommand(
  target: string,
  options?: { apiUrl?: string }
): Promise<void> {
  const id = cleanIdentifier(target);
  if (!id) {
    printError("File identifier or share token is required.");
    process.exitCode = 1;
    return;
  }

  const client = new ApiClient({ apiUrl: options?.apiUrl });
  const spinner = createSpinner(
    `Revoking public share link for '${id}'...`
  ).start();

  try {
    await client.revokeShare(id);
    spinner.succeed("Share link revoked; the file is now private");
    console.log();
  } catch (error) {
    spinner.fail(
      error instanceof Error ? error.message : "Failed to revoke share link"
    );
    process.exitCode = 1;
  }
}
