import { Command, CommanderError, Help } from "commander";
import pc from "picocolors";
import packageJson from "../package.json";
import { abortCommand } from "./commands/abort";
import { deleteCommand } from "./commands/delete";
import { downloadCommand } from "./commands/download";
import { extendCommand } from "./commands/extend";
import { infoCommand } from "./commands/info";
import { listKeysCommand, renameKeyCommand } from "./commands/keys";
import { listCommand } from "./commands/list";
import { loginCommand } from "./commands/login";
import { logoutCommand } from "./commands/logout";
import { manageCommand } from "./commands/manage";
import {
  addProfileCommand,
  listProfilesCommand,
  removeProfileCommand,
  showProfileCommand,
  useProfileCommand,
} from "./commands/profile";
import { renameCommand } from "./commands/rename";
import { revokeCommand, shareCommand } from "./commands/share";
import { signupCommand } from "./commands/signup";
import { statusCommand } from "./commands/status";
import { upgradeCommand } from "./commands/upgrade";
import { uploadCommand } from "./commands/upload";
import { whoamiCommand } from "./commands/whoami";
import { printError } from "./lib/output";
import { type SuggestableCommand, suggestCommand } from "./lib/suggest";
import {
  checkForUpdate,
  printUpdateBanner,
  shouldSkipUpdateCheck,
} from "./lib/update-check";

const CURRENT_VERSION = packageJson.version;
const program = new Command();
const defaultHelp = new Help();
let upgradedThisRun = false;

interface GlobalOptions {
  apiUrl?: string;
  profile?: string;
}

function resolveGlobals(cmdOptions: GlobalOptions): GlobalOptions {
  const globals = program.opts();
  return {
    apiUrl: cmdOptions.apiUrl || globals.apiUrl,
    profile: cmdOptions.profile || globals.profile,
  };
}

function rejectGlobalOverrides(
  subcommand: string,
  options: { checkApiUrl?: boolean; checkProfile?: boolean } = {}
): boolean {
  const { checkApiUrl = true, checkProfile = true } = options;
  const globals = program.opts();
  const flags: string[] = [];
  if (checkApiUrl && globals.apiUrl) {
    flags.push("--api-url");
  }
  if (checkProfile && globals.profile) {
    flags.push("--profile");
  }
  if (flags.length === 0) {
    return false;
  }
  printError(
    `${subcommand} does not accept global ${flags.join(" / ")}.`,
    `Run without ${flags.join(" ")} or use a command that accepts it.`
  );
  process.exitCode = 1;
  return true;
}

function formatSection(
  title: string,
  items: [string, string][],
  padWidth = 22
): string {
  const lines = items.map(
    ([term, desc]) => `  ${term.padEnd(padWidth)}  ${desc}`
  );
  return `${pc.bold(title)}:\n${lines.join("\n")}`;
}

program
  .name("upshare")
  .description(
    "Official CLI for UpShare - upload, download, and manage your files securely."
  )
  .version(CURRENT_VERSION, "-v, --version", "Output the current version")
  .option(
    "--api-url <url>",
    "Override UpShare backend API URL (default: https://upshare.app)"
  )
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .exitOverride()
  .configureHelp({
    formatHelp(cmd, helper) {
      if (cmd.parent) {
        return defaultHelp.formatHelp(cmd, helper);
      }

      const accountCommands: [string, string][] = [
        ["signup", "Create an account via browser and save the API key"],
        ["login", "Log in with API key, or --web for browser"],
        ["keys", "List API keys for this account"],
        ["keys rename", "Rename an API key by id, prefix, name, or current"],
        ["profile", "Manage configuration profiles"],
        ["profile list", "List all profiles"],
        ["profile use", "Switch the active profile"],
        ["whoami", "Show current account information"],
        ["logout", "Clear stored API credentials for the active profile"],
      ];

      const fileCommands: [string, string][] = [
        ["upload <file>", "Upload a file to UpShare"],
        ["download <target>", "Download a file by ID, share link, or token"],
        ["list, ls", "List active files and monthly upload usage"],
        ["info <target>", "Show full details for one file"],
        ["rename <target> <name>", "Rename an uploaded file"],
        ["abort [target]", "Abort unfinished uploads and free pending space"],
        ["delete, rm <target>", "Permanently delete an uploaded file"],
        ["manage, files [target]", "Interactive file management menu"],
      ];

      const shareCommands: [string, string][] = [
        ["share <target>", "Create or retrieve a public share link for a file"],
        ["extend <target>", "Extend the share link duration for a file"],
        ["revoke <target>", "Revoke a public share link (makes file private)"],
      ];

      const generalCommands: [string, string][] = [
        ["status", "Check UpShare API status"],
        ["upgrade, update", "Upgrade UpShare CLI to the latest version"],
        ["help [command]", "Display help for a command"],
      ];

      const options: [string, string][] = [
        ["-v, --version", "Output the current version"],
        [
          "--api-url <url>",
          "Override UpShare backend API URL (default: https://upshare.app)",
        ],
        ["-p, --profile <name>", "Use a specific configuration profile"],
        ["--no-update-check", "Skip the background update check"],
        ["-h, --help", "Display help for upshare"],
      ];

      return [
        "",
        `${pc.bold(pc.cyan("UpShare CLI"))} ${pc.dim("- upload, download, and manage your files securely.")}`,
        "",
        `${pc.bold("Usage:")} upshare [command] [options]`,
        "",
        formatSection("Options", options),
        "",
        formatSection("Account", accountCommands),
        "",
        formatSection("Files", fileCommands),
        "",
        formatSection("Sharing", shareCommands),
        "",
        formatSection("General", generalCommands),
        "",
      ].join("\n");
    },
  });

program
  .command("login")
  .description("Log in with API key, or --web for browser")
  .option(
    "-w, --web",
    "Log in via browser (dashboard session, creates API key)"
  )
  .option("--no-browser", "Print the URL instead of opening a browser")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .action(
    async (cmdOptions: {
      apiUrl?: string;
      browser?: boolean;
      profile?: string;
      web?: boolean;
    }) => {
      const { apiUrl, profile } = resolveGlobals(cmdOptions);
      if (cmdOptions.web) {
        await signupCommand({
          apiUrl,
          mode: "login",
          noBrowser: cmdOptions.browser === false,
          profile,
        });
        return;
      }
      if (cmdOptions.browser === false) {
        printError("--no-browser requires --web.");
        process.exitCode = 1;
        return;
      }
      await loginCommand({ apiUrl, profile });
    }
  );

program
  .command("signup")
  .description("Create an account via browser and save the API key")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .option("--no-browser", "Print the URL instead of opening a browser")
  .action(
    async (cmdOptions: {
      apiUrl?: string;
      browser?: boolean;
      profile?: string;
    }) => {
      const { apiUrl, profile } = resolveGlobals(cmdOptions);
      await signupCommand({
        apiUrl,
        mode: "signup",
        noBrowser: cmdOptions.browser === false,
        profile,
      });
    }
  );

program
  .command("whoami")
  .description("Show current account information")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .action(async (cmdOptions: { apiUrl?: string; profile?: string }) => {
    const { apiUrl, profile } = resolveGlobals(cmdOptions);
    await whoamiCommand({ apiUrl, profile });
  });

const keysCommand = program
  .command("keys")
  .description("List API keys for this account")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .action(async (cmdOptions: { apiUrl?: string; profile?: string }) => {
    const { apiUrl, profile } = resolveGlobals(cmdOptions);
    await listKeysCommand({ apiUrl, profile });
  });

keysCommand
  .command("rename <key> <name>")
  .description("Rename an API key by id, prefix, name, or `current`")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .action(
    async (
      key: string,
      name: string,
      cmdOptions: { apiUrl?: string; profile?: string }
    ) => {
      const { apiUrl, profile } = resolveGlobals(cmdOptions);
      await renameKeyCommand(key, name, { apiUrl, profile });
    }
  );

program
  .command("upload <file>")
  .description("Upload a file to UpShare")
  .option("--hours <hours>", "File expiration duration in hours (1-168)", "24")
  .option("--concurrency <count>", "Concurrent multipart uploads (1-16)", "16")
  .option("--retries <count>", "Retries per failed upload or part (0-20)", "5")
  .option(
    "--no-share",
    "Do not generate a public share link (keep file private in dashboard)"
  )
  .option(
    "-d, --share-duration <hours>",
    "Custom share link expiration in hours (defaults to file expiration)"
  )
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .action(
    async (
      file: string,
      cmdOptions: {
        apiUrl?: string;
        concurrency: string;
        hours: string;
        profile?: string;
        retries: string;
        share: boolean;
        shareDuration?: string;
      }
    ) => {
      const { apiUrl, profile } = resolveGlobals(cmdOptions);
      await uploadCommand(file, {
        apiUrl,
        concurrency: cmdOptions.concurrency,
        hours: cmdOptions.hours,
        profile,
        retries: cmdOptions.retries,
        share: cmdOptions.share,
        shareDuration: cmdOptions.shareDuration,
      });
    }
  );

program
  .command("download <target>")
  .description("Download a file by ID, share link, or token")
  .option("-o, --out <dir>", "Directory to save downloaded file", ".")
  .option("--concurrency <count>", "Concurrent download streams (1-16)", "8")
  .option("--retries <count>", "Retries per failed download range (0-20)", "5")
  .option("-f, --force", "Overwrite existing destination file")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .action(
    async (
      target: string,
      cmdOptions: {
        apiUrl?: string;
        concurrency: string;
        force?: boolean;
        out: string;
        profile?: string;
        retries: string;
      }
    ) => {
      const { apiUrl, profile } = resolveGlobals(cmdOptions);
      await downloadCommand(target, {
        apiUrl,
        concurrency: cmdOptions.concurrency,
        force: cmdOptions.force,
        out: cmdOptions.out,
        profile,
        retries: cmdOptions.retries,
      });
    }
  );

program
  .command("list")
  .alias("ls")
  .description("List active files and monthly upload usage")
  .option("--page <page>", "Page number")
  .option("--all", "List all active files")
  .option("--pending", "List partial uploads holding space")
  .option("--json", "Output raw JSON for scripting")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .action(
    async (cmdOptions: {
      all?: boolean;
      apiUrl?: string;
      json?: boolean;
      page?: string;
      pending?: boolean;
      profile?: string;
    }) => {
      const { apiUrl, profile } = resolveGlobals(cmdOptions);
      await listCommand({
        all: cmdOptions.all,
        apiUrl,
        json: cmdOptions.json,
        page: cmdOptions.page,
        pending: cmdOptions.pending,
        profile,
      });
    }
  );

program
  .command("info <target>")
  .description("Show full details for one file")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .action(
    async (
      target: string,
      cmdOptions: { apiUrl?: string; profile?: string }
    ) => {
      const { apiUrl, profile } = resolveGlobals(cmdOptions);
      await infoCommand(target, { apiUrl, profile });
    }
  );

program
  .command("share <target>")
  .description("Create or retrieve a public share link for a file")
  .option(
    "-d, --duration <hours>",
    "Share link expiration in hours (0.5-168)",
    "24"
  )
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .action(
    async (
      target: string,
      cmdOptions: { apiUrl?: string; duration?: string; profile?: string }
    ) => {
      const { apiUrl, profile } = resolveGlobals(cmdOptions);
      await shareCommand(target, {
        apiUrl,
        duration: cmdOptions.duration,
        profile,
      });
    }
  );

program
  .command("extend <target>")
  .description("Extend the share link duration for a file")
  .option(
    "-d, --duration <hours>",
    "New share duration from now in hours (0.5-168)",
    "24"
  )
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .action(
    async (
      target: string,
      cmdOptions: { apiUrl?: string; duration?: string; profile?: string }
    ) => {
      const { apiUrl, profile } = resolveGlobals(cmdOptions);
      await extendCommand(target, {
        apiUrl,
        duration: cmdOptions.duration,
        profile,
      });
    }
  );

program
  .command("revoke <target>")
  .description("Revoke a public share link (makes file private)")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .action(
    async (
      target: string,
      cmdOptions: { apiUrl?: string; profile?: string }
    ) => {
      const { apiUrl, profile } = resolveGlobals(cmdOptions);
      await revokeCommand(target, { apiUrl, profile });
    }
  );

program
  .command("rename <target> <name>")
  .description("Rename an uploaded file")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .action(
    async (
      target: string,
      name: string,
      cmdOptions: { apiUrl?: string; profile?: string }
    ) => {
      const { apiUrl, profile } = resolveGlobals(cmdOptions);
      await renameCommand(target, name, { apiUrl, profile });
    }
  );

program
  .command("delete <target>")
  .alias("rm")
  .description("Permanently delete an uploaded file")
  .option("-y, --yes", "Skip delete confirmation prompt")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .action(
    async (
      target: string,
      cmdOptions: { apiUrl?: string; profile?: string; yes?: boolean }
    ) => {
      const { apiUrl, profile } = resolveGlobals(cmdOptions);
      await deleteCommand(target, {
        apiUrl,
        profile,
        yes: cmdOptions.yes,
      });
    }
  );

program
  .command("abort [target]")
  .description("Abort unfinished uploads and free pending space")
  .option("-y, --yes", "Skip abort confirmation prompt")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .action(
    async (
      target: string | undefined,
      cmdOptions: { apiUrl?: string; profile?: string; yes?: boolean }
    ) => {
      const { apiUrl, profile } = resolveGlobals(cmdOptions);
      await abortCommand(target, { apiUrl, profile, yes: cmdOptions.yes });
    }
  );

program
  .command("manage [target]")
  .alias("files")
  .description("Interactive file management menu")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .action(
    async (
      target: string | undefined,
      cmdOptions: { apiUrl?: string; profile?: string }
    ) => {
      const { apiUrl, profile } = resolveGlobals(cmdOptions);
      await manageCommand(target, { apiUrl, profile });
    }
  );

program
  .command("upgrade")
  .alias("update")
  .description("Upgrade UpShare CLI to the latest version")
  .option("--beta", "Upgrade to the latest beta version")
  .option("--no-update-check", "Skip the background update check")
  .action(async (cmdOptions: { beta?: boolean }) => {
    upgradedThisRun = await upgradeCommand({ beta: cmdOptions.beta });
  });

program
  .command("status")
  .description("Check UpShare API status")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .action(async (cmdOptions: { apiUrl?: string; profile?: string }) => {
    const { apiUrl, profile } = resolveGlobals(cmdOptions);
    await statusCommand({ apiUrl, profile });
  });

program
  .command("logout")
  .description("Clear stored API credentials for the active profile")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--no-update-check", "Skip the background update check")
  .option("--all", "Remove all profiles and stored credentials")
  .action(
    (cmdOptions: { all?: boolean; apiUrl?: string; profile?: string }) => {
      const { apiUrl, profile } = resolveGlobals(cmdOptions);
      logoutCommand({ all: cmdOptions.all, apiUrl, profile });
    }
  );

const profileCommand = program
  .command("profile")
  .description("Manage configuration profiles");

profileCommand
  .command("list")
  .description("List all profiles")
  .option("--no-update-check", "Skip the background update check")
  .action(() => {
    if (rejectGlobalOverrides("profile list")) {
      return;
    }
    listProfilesCommand();
  });

profileCommand
  .command("use <name>")
  .description("Switch the active profile")
  .option("--no-update-check", "Skip the background update check")
  .action((name: string) => {
    if (rejectGlobalOverrides("profile use")) {
      return;
    }
    useProfileCommand(name);
  });

profileCommand
  .command("add <name>")
  .description("Add a new profile")
  .option("--api-url <url>", "API URL for the new profile")
  .option("--no-update-check", "Skip the background update check")
  .action((name: string, cmdOptions: { apiUrl?: string }) => {
    // A global --profile is rejected: it is ambiguous with the name argument.
    if (rejectGlobalOverrides("profile add", { checkApiUrl: false })) {
      return;
    }
    addProfileCommand(name, {
      apiUrl: resolveGlobals(cmdOptions).apiUrl,
    });
  });

profileCommand
  .command("show [name]")
  .description("Show profile details (defaults to the active profile)")
  .option("--no-update-check", "Skip the background update check")
  .action((name?: string) => {
    if (rejectGlobalOverrides("profile show")) {
      return;
    }
    showProfileCommand(name);
  });

profileCommand
  .command("remove <name>")
  .description("Remove a profile and its stored credential")
  .option("-y, --yes", "Skip removal confirmation prompt")
  .option("--no-update-check", "Skip the background update check")
  .action(async (name: string, cmdOptions: { yes?: boolean }) => {
    if (rejectGlobalOverrides("profile remove")) {
      return;
    }
    await removeProfileCommand(name, { yes: cmdOptions.yes });
  });

program.argument(
  "[unknown-command]",
  "Unknown command (used to suggest the intended command)"
);
program.action(() => {
  const [unknown] = program.args;
  if (unknown !== undefined) {
    const input = String(unknown);
    const candidates: SuggestableCommand[] = [
      ...program.commands.map((cmd) => ({
        aliases: cmd.aliases(),
        name: cmd.name(),
      })),
      { aliases: [], name: "help" },
    ];
    const suggestion = suggestCommand(input, candidates);
    printError(
      `Unknown command '${input}'.${suggestion ? ` Did you mean '${suggestion}'?` : ""}`
    );
    console.error("  Run: upshare --help to see all available commands.");
    process.exitCode = 1;
    return;
  }
  const globals = program.opts();
  if (globals.apiUrl || globals.profile) {
    printError(
      "--api-url and --profile are per-run overrides and are not saved.",
      "upshare profile add <name> --api-url <url>"
    );
    console.error("  Run: upshare --help to see all available commands.");
    process.exitCode = 1;
    return;
  }
  console.log(`
${pc.bold(pc.cyan("UpShare CLI"))}
${pc.dim("Fast & secure file sharing from your terminal.")}

Run ${pc.cyan("upshare --help")} to see all available commands.
`);
});

async function run() {
  const rawArgv = process.argv;
  const updatePromise = shouldSkipUpdateCheck(rawArgv)
    ? Promise.resolve(null)
    : checkForUpdate(CURRENT_VERSION);

  try {
    await program.parseAsync(rawArgv);
  } catch (err) {
    const isCommanderExit =
      err instanceof CommanderError &&
      (err.code === "commander.helpDisplayed" ||
        err.code === "commander.help" ||
        err.code === "commander.version");
    if (!isCommanderExit) {
      throw err;
    }
  }

  const latest = await updatePromise;
  if (latest && !upgradedThisRun) {
    printUpdateBanner(CURRENT_VERSION, latest);
  }
}

run().catch((err) => {
  if (err instanceof CommanderError) {
    process.exitCode = err.exitCode;
    return;
  }
  printError(err instanceof Error ? err.message : "Unexpected CLI error.");
  process.exitCode = 1;
});
