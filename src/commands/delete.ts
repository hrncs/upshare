import readline from "node:readline/promises";
import pc from "picocolors";
import { ApiClient } from "../lib/api-client";
import { cleanIdentifier } from "../lib/format";
import { printError } from "../lib/output";
import { createSpinner } from "../lib/spinner";

export async function deleteCommand(
  target: string,
  options?: { apiUrl?: string; yes?: boolean }
): Promise<void> {
  const id = cleanIdentifier(target);
  if (!id) {
    printError("File identifier or share token is required.");
    process.exitCode = 1;
    return;
  }

  if (!options?.yes) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      const answer = await rl.question(
        pc.yellow(`Delete '${id}' permanently? (y/N): `)
      );
      if (
        answer.trim().toLowerCase() !== "y" &&
        answer.trim().toLowerCase() !== "yes"
      ) {
        console.log(pc.dim("Delete cancelled."));
        return;
      }
    } catch {
      console.log();
      console.log(pc.dim("Delete cancelled."));
      return;
    } finally {
      rl.close();
    }
  }

  const client = new ApiClient({ apiUrl: options?.apiUrl });
  const spinner = createSpinner(`Deleting file '${id}'...`).start();

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
