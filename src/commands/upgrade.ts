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

const DLX_PATH_PATTERN = /(^|[/\\-])dlx([/\\-]|$)/;
const EPHEMERAL_EXEC_PATTERN = /[/\\](npx|dlx|bunx)([/\\. ]|$)/;
const LIFECYCLE_EPHEMERAL_PATTERN = /\b(dlx|bunx|npx)\b/;
const YARN_VERSION_PATTERN = /yarn\/(\d+)/;

function isEphemeralRun(): boolean {
  const entry = process.argv[1] ?? "";
  if (
    entry.includes("_npx") ||
    entry.includes("/dlx/") ||
    entry.includes("\\dlx\\") ||
    entry.includes("bunx") ||
    DLX_PATH_PATTERN.test(entry)
  ) {
    return true;
  }
  const execPath = process.env.npm_execpath ?? "";
  if (EPHEMERAL_EXEC_PATTERN.test(execPath)) {
    return true;
  }
  const lifecycle = process.env.npm_lifecycle_command ?? "";
  if (LIFECYCLE_EPHEMERAL_PATTERN.test(lifecycle)) {
    return true;
  }
  return false;
}

function getYarnMajorVersion(): number | undefined {
  const userAgent = process.env.npm_config_user_agent ?? "";
  // biome-ignore lint/suspicious/noUnnecessaryConditions: RegExp.exec returns null on no match
  const majorText = YARN_VERSION_PATTERN.exec(userAgent)?.[1];
  if (majorText !== undefined) {
    const major = Number.parseInt(majorText, 10);
    return Number.isInteger(major) ? major : undefined;
  }
  return undefined;
}

function isYarnBerry(): boolean {
  const major = getYarnMajorVersion();
  if (major !== undefined) {
    return major >= 2;
  }
  return false;
}

function yarnInstallCommand(tag: string): [string, string[]] {
  if (isYarnBerry()) {
    // Yarn Berry removed `yarn global`; fall back to npm for global installs.
    return ["npm", ["install", "-g", `upshare@${tag}`]];
  }
  return ["yarn", ["global", "add", `upshare@${tag}`]];
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: installer detection checks 4 ordered sources; splitting further hurts readability
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
  if (userAgent.startsWith("npm")) {
    return "npm";
  }
  const execPath = process.env.npm_execpath ?? "";
  if (execPath.includes("pnpm")) {
    return "pnpm";
  }
  if (execPath.includes("yarn")) {
    return "yarn";
  }
  if (execPath.includes("bun")) {
    return "bun";
  }
  if (process.env.VOLTA_HOME && execPath.includes("volta")) {
    const voltaAgent = userAgent.toLowerCase();
    if (voltaAgent.includes("pnpm")) {
      return "pnpm";
    }
    if (voltaAgent.includes("yarn")) {
      return "yarn";
    }
    if (voltaAgent.includes("bun")) {
      return "bun";
    }
  }
  const entry = process.argv[1] ?? "";
  if (entry.includes("pnpm")) {
    return "pnpm";
  }
  if (entry.includes("bun")) {
    return "bun";
  }
  if (entry.includes("yarn")) {
    return "yarn";
  }
  return "npm";
}

async function upgradeToTag(
  tag: "latest" | "beta",
  messages: {
    alreadyCurrent: string;
    checking: string;
    noTag: string;
  },
  isNewer: (current: string, target: string) => boolean
): Promise<boolean> {
  const spinner = createSpinner(messages.checking).start();
  let target: string | null;
  try {
    target =
      tag === "latest"
        ? await fetchLatestVersion()
        : await fetchDistTagVersion(tag);
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

  if (!target) {
    console.log();
    console.log(pc.dim(messages.noTag));
    console.log();
    return false;
  }
  if (!isNewer(CURRENT_VERSION, target)) {
    console.log();
    console.log(pc.green(messages.alreadyCurrent));
    console.log();
    return false;
  }

  const manager = detectPackageManager();
  const suffix = tag === "beta" ? " (beta)" : "";
  console.log();
  console.log(
    `${pc.dim("Upgrading:")} ${pc.dim(CURRENT_VERSION)} -> ${pc.green(target)} ${pc.dim(`via ${manager}${suffix}`)}`
  );
  const installed = installPackage(manager, tag);
  if (!installed) {
    return false;
  }

  console.log();
  console.log(pc.green(`Upgraded to ${target}.`));
  console.log();
  return true;
}

export async function upgradeCommand(
  options: { beta?: boolean } = {}
): Promise<boolean> {
  if (isEphemeralRun()) {
    console.log();
    console.log(
      pc.dim(
        "You're running via npx/pnpm dlx/bunx/yarn dlx, so there's nothing installed to update."
      )
    );
    console.log(
      `${pc.dim("Next run picks up the latest automatically:")} ${pc.cyan("npx upshare --help")}`
    );
    console.log();
    return false;
  }

  if (options.beta) {
    return await upgradeToTag(
      "beta",
      {
        alreadyCurrent: `You're already past the beta (${CURRENT_VERSION}).`,
        checking: "Checking for beta versions...",
        noTag: "No beta version published.",
      },
      isNewerVersion
    );
  }

  return await upgradeToTag(
    "latest",
    {
      alreadyCurrent: `You're on the latest version (${CURRENT_VERSION}).`,
      checking: "Checking for updates...",
      noTag: "No latest version published in the registry.",
    },
    isUpdateAvailable
  );
}

function installPackage(manager: PackageManager, tag: string): boolean {
  const [command, args] =
    manager === "yarn"
      ? yarnInstallCommand(tag)
      : (() => {
          const [base, baseArgs] = INSTALL_BASE_COMMANDS[manager];
          return [base, [...baseArgs, `upshare@${tag}`]] as [string, string[]];
        })();
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
