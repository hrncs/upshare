import readline from "node:readline/promises";
import pc from "picocolors";
import { printError } from "./output";

export async function confirmPrompt(
  message: string,
  options?: { yes?: boolean }
): Promise<boolean> {
  if (options?.yes) {
    return true;
  }

  if (
    !(process.stdin.isTTY && process.stdout.isTTY) &&
    process.env.VITEST !== "true"
  ) {
    printError(
      "Confirmation required but stdin is not interactive. Re-run with --yes to confirm."
    );
    process.exitCode = 1;
    return false;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(pc.yellow(message));
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } catch {
    console.log();
    console.log(pc.dim("Cancelled."));
    process.exitCode = 130;
    return false;
  } finally {
    rl.close();
  }
}

export const confirm = confirmPrompt;
