import pc from "picocolors";
import { ApiClient } from "../lib/api-client";
import { cleanIdentifier, sanitizeTerminalText } from "../lib/format";
import { printError, printFields } from "../lib/output";
import { createSpinner } from "../lib/spinner";

function validateFileName(value: unknown): string | null {
  if (typeof value !== "string") {
    return "New file name is required.";
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "New file name is required.";
  }
  if (trimmed.length > 255) {
    return "New file name must be 1-255 characters.";
  }
  if (trimmed === "." || trimmed === "..") {
    return "New file name must not be '.' or '..'.";
  }
  for (const character of trimmed) {
    const code = character.charCodeAt(0);
    if (character === "/" || character === "\\" || code < 32 || code === 127) {
      return "New file name must not contain '/', '\\', or control characters.";
    }
  }
  return null;
}

export async function renameCommand(
  target: string,
  fileName: string,
  options?: { apiUrl?: string; profile?: string }
): Promise<void> {
  const id = cleanIdentifier(target);
  if (!id) {
    printError("File identifier or share token is required.");
    process.exitCode = 1;
    return;
  }
  const nameError = validateFileName(fileName);
  if (nameError) {
    printError(nameError);
    process.exitCode = 1;
    return;
  }
  const trimmedName = (fileName as string).trim();

  const client = new ApiClient({
    apiUrl: options?.apiUrl,
    profile: options?.profile,
  });
  const spinner = createSpinner("Renaming file...").start();

  try {
    const result = await client.renameFile(id, trimmedName);
    spinner.succeed(`Renamed to ${sanitizeTerminalText(result.fileName)}`);
    console.log();
    printFields([
      ["File ID", pc.cyan(sanitizeTerminalText(result.fileId))],
      ["New name", pc.bold(sanitizeTerminalText(result.fileName))],
    ]);
    console.log();
  } catch (error) {
    spinner.fail(
      error instanceof Error ? error.message : "Failed to rename file"
    );
    process.exitCode = 1;
  }
}
