import pc from "picocolors";
import { ApiClient } from "../lib/api-client";
import { cleanIdentifier } from "../lib/format";
import { printError, printFields } from "../lib/output";
import { createSpinner } from "../lib/spinner";

export async function renameCommand(
  target: string,
  fileName: string,
  options?: { apiUrl?: string }
): Promise<void> {
  const id = cleanIdentifier(target);
  if (!id) {
    printError("File identifier or share token is required.");
    process.exitCode = 1;
    return;
  }
  const trimmedName = fileName.trim();
  if (!trimmedName) {
    printError("New file name is required.");
    process.exitCode = 1;
    return;
  }

  const client = new ApiClient({ apiUrl: options?.apiUrl });
  const spinner = createSpinner("Renaming file...").start();

  try {
    const result = await client.renameFile(id, trimmedName);
    spinner.succeed(`Renamed to ${result.fileName}`);
    console.log();
    printFields([
      ["File ID", pc.cyan(result.fileId)],
      ["New name", pc.bold(result.fileName)],
    ]);
    console.log();
  } catch (error) {
    spinner.fail(
      error instanceof Error ? error.message : "Failed to rename file"
    );
    process.exitCode = 1;
  }
}
