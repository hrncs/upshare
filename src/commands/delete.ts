import pc from "picocolors";
import { ApiClient } from "../lib/api-client";
import { sanitizeTerminalText } from "../lib/format";
import { cleanIdentifier } from "../lib/identifiers";
import { printError } from "../lib/output";
import { confirmPrompt } from "../lib/prompt";
import { createSpinner } from "../lib/spinner";

export async function deleteCommand(
  target: string,
  options?: { apiUrl?: string; profile?: string; yes?: boolean }
): Promise<void> {
  const id = cleanIdentifier(target);
  if (!id) {
    printError("File identifier or share token is required.");
    process.exitCode = 1;
    return;
  }

  if (!options?.yes) {
    const confirmed = await confirmPrompt(
      `Delete '${sanitizeTerminalText(id)}' permanently? (y/N): `,
      { yes: options?.yes }
    );
    if (!confirmed) {
      if (process.exitCode === 130) {
        return;
      }
      console.log(pc.dim("Delete cancelled."));
      return;
    }
  }

  const client = new ApiClient({
    apiUrl: options?.apiUrl,
    profile: options?.profile,
  });
  const spinner = createSpinner(
    `Deleting file '${sanitizeTerminalText(id)}'...`
  ).start();

  try {
    const result = await client.deleteFile(id);
    spinner.succeed(`Deleted ${result.fileName || id}`);
    console.log();
  } catch (error) {
    spinner.fail(
      error instanceof Error ? error.message : "Failed to delete file"
    );
    process.exitCode = 1;
  }
}
