import pc from "picocolors";
import { ApiClient } from "../lib/api-client";
import { cleanIdentifier, formatRelativeTime } from "../lib/format";
import { printError, printFields, printWarning } from "../lib/output";
import { resolveShareTarget, startShareSpinner } from "../lib/share-helpers";

export async function shareCommand(
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
    `Generating share link for '${resolved.id}'...`
  );

  try {
    const result = await resolved.client.createShare(
      resolved.id,
      resolved.durationHours
    );
    spinner.succeed(`Share link created for ${result.fileName || resolved.id}`);

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
  options?: { apiUrl?: string; profile?: string }
): Promise<void> {
  const id = cleanIdentifier(target);
  if (!id) {
    printError("File identifier or share token is required.");
    process.exitCode = 1;
    return;
  }

  const client = new ApiClient({
    apiUrl: options?.apiUrl,
    profile: options?.profile,
  });
  const spinner = startShareSpinner(
    `Revoking public share link for '${id}'...`
  );

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
