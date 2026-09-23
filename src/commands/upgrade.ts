import { spawnSync } from "node:child_process";
import pc from "picocolors";
import packageJson from "../../package.json";
import { printError } from "../lib/output";
import { createSpinner } from "../lib/spinner";
import {
  fetchDistTagVersion,
  fetchLatestVersion,
  isNewerVersion,
  isUpdateAvailable,
} from "../lib/update-check";

const CURRENT_VERSION = packageJson.version;

type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

const INSTALL_BASE_COMMANDS: Record<
  PackageManager,
  [command: string, args: string[]]
> = {
  bun: ["bun", ["add", "-g"]],
  npm: ["npm", ["install", "-g"]],
  pnpm: ["pnpm", ["add", "-g"]],
  yarn: ["yarn", ["global", "add"]],
};

function isNpxRun(): boolean {
  return (process.argv[1] ?? "").includes("_npx");
}

function detectPackageManager(): PackageManager {
  const userAgent = process.env.npm_config_user_agent ?? "";
  if (userAgent.startsWith("pnpm")) {
    return "pnpm";
  }
  if (userAgent.startsWith("yarn")) {
    return "yarn";
  }
  if (userAgent.startsWith("bun")) {
    return "bun";
  }
  const entry = process.argv[1] ?? "";
  if (entry.includes("pnpm")) {
    return "pnpm";
  }
  if (entry.includes("bun")) {
    return "bun";
  }
  return "npm";
}

export async function upgradeCommand(
  options: { beta?: boolean } = {}
): Promise<boolean> {
  if (isNpxRun()) {
    console.log();
    console.log(
      pc.dim("You're running via npx, so there's nothing installed to update.")
    );
    console.log(
      `${pc.dim("Next run picks up the latest automatically:")} ${pc.cyan("npx upshare --help")}`
    );
    console.log();
    return false;
  }

  if (options.beta) {
    return upgradeToBeta();
  }

  const spinner = createSpinner("Checking for updates...").start();
  let latest: string | null;
  try {
    latest = await fetchLatestVersion();
  } catch (error) {
    spinner.stop();
    printError(
      error instanceof Error
        ? error.message
        : "Couldn't reach the update registry."
    );
    process.exitCode = 1;
    return false;
  }
  spinner.stop();

  if (!latest) {
    printError("Couldn't reach the update registry. Check your connection.");
    process.exitCode = 1;
    return false;
  }
  if (!isUpdateAvailable(CURRENT_VERSION, latest)) {
    console.log();
    console.log(pc.green(`You're on the latest version (${CURRENT_VERSION}).`));
    console.log();
    return false;
  }

  const manager = detectPackageManager();
  console.log();
  console.log(
    `${pc.dim("Upgrading:")} ${pc.dim(CURRENT_VERSION)} -> ${pc.green(latest)} ${pc.dim(`via ${manager}`)}`
  );
  const installed = installPackage(manager, "latest");
  if (!installed) {
    return false;
  }

  console.log();
  console.log(pc.green(`Upgraded to ${latest}.`));
  console.log();
  return true;
}

async function upgradeToBeta(): Promise<boolean> {
  const spinner = createSpinner("Checking for beta versions...").start();
  let beta: string | null;
  try {
    beta = await fetchDistTagVersion("beta");
  } catch (error) {
    spinner.stop();
    printError(
      error instanceof Error
        ? error.message
        : "Couldn't reach the update registry."
    );
    process.exitCode = 1;
    return false;
  }
  spinner.stop();

  if (!beta) {
    console.log();
    console.log(pc.dim("No beta version published."));
    console.log();
    return false;
  }
  if (!isNewerVersion(CURRENT_VERSION, beta)) {
    console.log();
    console.log(pc.green(`You're already past the beta (${CURRENT_VERSION}).`));
    console.log();
    return false;
  }

  const manager = detectPackageManager();
  console.log();
  console.log(
    `${pc.dim("Upgrading:")} ${pc.dim(CURRENT_VERSION)} -> ${pc.green(beta)} ${pc.dim(`via ${manager} (beta)`)}`
  );
  const installed = installPackage(manager, "beta");
  if (!installed) {
    return false;
  }

  console.log();
  console.log(pc.green(`Upgraded to ${beta}.`));
  console.log();
  return true;
}

function installPackage(manager: PackageManager, tag: string): boolean {
  const [command, baseArgs] = INSTALL_BASE_COMMANDS[manager];
  const args = [...baseArgs, `upshare@${tag}`];
  const result = spawnSync(command, args, {
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.error || result.status !== 0) {
    printError("Upgrade failed.", `Try manually: ${command} ${args.join(" ")}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}
