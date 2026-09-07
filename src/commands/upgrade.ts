import { spawnSync } from "node:child_process";
import pc from "picocolors";
import packageJson from "../../package.json";
import { printError } from "../lib/output";
import { createSpinner } from "../lib/spinner";
import { fetchLatestVersion, isNewerVersion } from "../lib/update-check";

const CURRENT_VERSION = packageJson.version;

type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

const INSTALL_COMMANDS: Record<
  PackageManager,
  [command: string, args: string[]]
> = {
  bun: ["bun", ["add", "-g", "upshare@latest"]],
  npm: ["npm", ["install", "-g", "upshare@latest"]],
  pnpm: ["pnpm", ["add", "-g", "upshare@latest"]],
  yarn: ["yarn", ["global", "add", "upshare@latest"]],
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

export async function upgradeCommand(): Promise<boolean> {
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

  const spinner = createSpinner("Checking for updates...").start();
  const latest = await fetchLatestVersion();
  spinner.stop();

  if (!latest) {
    printError("Couldn't reach the update registry. Check your connection.");
    process.exitCode = 1;
    return false;
  }
  if (!isNewerVersion(CURRENT_VERSION, latest)) {
    console.log();
    console.log(pc.green(`You're on the latest version (${CURRENT_VERSION}).`));
    console.log();
    return false;
  }

  const manager = detectPackageManager();
  const [command, args] = INSTALL_COMMANDS[manager];
  console.log();
  console.log(
    `${pc.dim("Upgrading:")} ${pc.dim(CURRENT_VERSION)} -> ${pc.green(latest)} ${pc.dim(`via ${manager}`)}`
  );
  const result = spawnSync(command, args, {
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.error || result.status !== 0) {
    printError("Upgrade failed.", `Try manually: ${command} ${args.join(" ")}`);
    process.exitCode = 1;
    return false;
  }

  console.log();
  console.log(pc.green(`Upgraded to ${latest}.`));
  console.log();
  return true;
}
