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
import {
  getActiveProfileName,
  normalizeApiUrl,
  saveProfile,
} from "./lib/config";
import { printError, printWarning } from "./lib/output";
import { type SuggestableCommand, suggestCommand } from "./lib/suggest";
import {
  checkForUpdate,
  printUpdateBanner,
  printVersionWithUpdateCheck,
} from "./lib/update-check";

const CURRENT_VERSION = packageJson.version;
const program = new Command();
const defaultHelp = new Help();
let upgradedThisRun = false;

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
        ["keys rename", "Rename an API key by id, prefix, or name"],
        ["profile", "Manage configuration profiles"],
        ["profile list", "List all profiles"],
        ["profile use", "Switch the active profile"],
        ["whoami", "Show current account information"],
        ["logout", "Clear stored API credentials"],
      ];

      const fileCommands: [string, string][] = [
        ["upload <file>", "Upload a file to UpShare"],
        ["download <target>", "Download a file by ID, share link, or token"],
        ["list, ls", "List active files and monthly upload usage"],
        ["info <target>", "Show full details for one file"],
        ["rename <target> <name>", "Rename an uploaded file"],
        ["abort [target]", "Abort unfinished upload(s) and free pending space"],
        ["delete, rm <target>", "Permanently delete an uploaded file"],
        ["manage, files", "Interactive file management menu"],
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
  .action(
    async (cmdOptions: {
      apiUrl?: string;
      browser?: boolean;
      profile?: string;
      web?: boolean;
    }) => {
      const options = program.opts();
      const apiUrl = cmdOptions.apiUrl || options.apiUrl;
      const profile = cmdOptions.profile || options.profile;
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
  .option("--no-browser", "Print the URL instead of opening a browser")
  .action(
    async (cmdOptions: {
      apiUrl?: string;
      browser?: boolean;
      profile?: string;
    }) => {
      const options = program.opts();
      const apiUrl = cmdOptions.apiUrl || options.apiUrl;
      const profile = cmdOptions.profile || options.profile;
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
  .action(async (cmdOptions: { apiUrl?: string; profile?: string }) => {
    const options = program.opts();
    const apiUrl = cmdOptions.apiUrl || options.apiUrl;
    const profile = cmdOptions.profile || options.profile;
    await whoamiCommand({ apiUrl, profile });
  });

const keysCommand = program
  .command("keys")
  .description("List API keys for this account")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .action(async (cmdOptions: { apiUrl?: string; profile?: string }) => {
    const options = program.opts();
    const apiUrl = cmdOptions.apiUrl || options.apiUrl;
    const profile = cmdOptions.profile || options.profile;
    await listKeysCommand({ apiUrl, profile });
  });

keysCommand
  .command("rename <key> <name>")
  .description("Rename an API key by id, prefix, name, or `current`")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .action(
    async (
      key: string,
      name: string,
      cmdOptions: { apiUrl?: string; profile?: string }
    ) => {
      const options = program.opts();
      const apiUrl = cmdOptions.apiUrl || options.apiUrl;
      const profile = cmdOptions.profile || options.profile;
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
      const options = program.opts();
      const apiUrl = cmdOptions.apiUrl || options.apiUrl;
      const profile = cmdOptions.profile || options.profile;
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
      const options = program.opts();
      const apiUrl = cmdOptions.apiUrl || options.apiUrl;
      const profile = cmdOptions.profile || options.profile;
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
  .option("--page <page>", "Page number", "1")
  .option("--all", "List all active files")
  .option("--pending", "List partial uploads holding space")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .action(
    async (cmdOptions: {
      all?: boolean;
      apiUrl?: string;
      page: string;
      pending?: boolean;
      profile?: string;
    }) => {
      const options = program.opts();
      const apiUrl = cmdOptions.apiUrl || options.apiUrl;
      const profile = cmdOptions.profile || options.profile;
      await listCommand({
        all: cmdOptions.all,
        apiUrl,
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
  .action(
    async (
      target: string,
      cmdOptions: { apiUrl?: string; profile?: string }
    ) => {
      const options = program.opts();
      const apiUrl = cmdOptions.apiUrl || options.apiUrl;
      const profile = cmdOptions.profile || options.profile;
      await infoCommand(target, { apiUrl, profile });
    }
  );

program
  .command("share <target>")
  .description("Create or retrieve a public share link for a file")
  .option(
    "-d, --duration <hours>",
    "Share link expiration in hours (1-168)",
    "24"
  )
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .action(
    async (
      target: string,
      cmdOptions: { apiUrl?: string; duration?: string; profile?: string }
    ) => {
      const options = program.opts();
      const apiUrl = cmdOptions.apiUrl || options.apiUrl;
      const profile = cmdOptions.profile || options.profile;
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
    "New share duration from now in hours (1-168)",
    "24"
  )
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .action(
    async (
      target: string,
      cmdOptions: { apiUrl?: string; duration?: string; profile?: string }
    ) => {
      const options = program.opts();
      const apiUrl = cmdOptions.apiUrl || options.apiUrl;
      const profile = cmdOptions.profile || options.profile;
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
  .action(
    async (
      target: string,
      cmdOptions: { apiUrl?: string; profile?: string }
    ) => {
      const options = program.opts();
      const apiUrl = cmdOptions.apiUrl || options.apiUrl;
      const profile = cmdOptions.profile || options.profile;
      await revokeCommand(target, { apiUrl, profile });
    }
  );

program
  .command("rename <target> <name>")
  .description("Rename an uploaded file")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .action(
    async (
      target: string,
      name: string,
      cmdOptions: { apiUrl?: string; profile?: string }
    ) => {
      const options = program.opts();
      const apiUrl = cmdOptions.apiUrl || options.apiUrl;
      const profile = cmdOptions.profile || options.profile;
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
  .action(
    async (
      target: string,
      cmdOptions: { apiUrl?: string; profile?: string; yes?: boolean }
    ) => {
      const options = program.opts();
      const apiUrl = cmdOptions.apiUrl || options.apiUrl;
      const profile = cmdOptions.profile || options.profile;
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
  .action(
    async (
      target: string | undefined,
      cmdOptions: { apiUrl?: string; profile?: string; yes?: boolean }
    ) => {
      const options = program.opts();
      const apiUrl = cmdOptions.apiUrl || options.apiUrl;
      const profile = cmdOptions.profile || options.profile;
      await abortCommand(target, { apiUrl, profile, yes: cmdOptions.yes });
    }
  );

program
  .command("manage [target]")
  .alias("files")
  .description("Interactive file management menu")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .action(
    async (
      target: string | undefined,
      cmdOptions: { apiUrl?: string; profile?: string }
    ) => {
      const options = program.opts();
      const apiUrl = cmdOptions.apiUrl || options.apiUrl;
      const profile = cmdOptions.profile || options.profile;
      await manageCommand(target, { apiUrl, profile });
    }
  );

program
  .command("upgrade")
  .alias("update")
  .description("Upgrade UpShare CLI to the latest version")
  .action(async () => {
    upgradedThisRun = await upgradeCommand();
  });

program
  .command("status")
  .description("Check UpShare API status")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .action(async (cmdOptions: { apiUrl?: string; profile?: string }) => {
    const options = program.opts();
    const apiUrl = cmdOptions.apiUrl || options.apiUrl;
    const profile = cmdOptions.profile || options.profile;
    await statusCommand({ apiUrl, profile });
  });

program
  .command("logout")
  .description("Clear stored API credentials for the active profile")
  .option("--api-url <url>", "Override UpShare backend API URL")
  .option("-p, --profile <name>", "Use a specific configuration profile")
  .option("--all", "Remove all profiles and stored credentials")
  .action(
    (cmdOptions: { all?: boolean; apiUrl?: string; profile?: string }) => {
      const options = program.opts();
      const apiUrl = cmdOptions.apiUrl || options.apiUrl;
      const profile = cmdOptions.profile || options.profile;
      logoutCommand({ all: cmdOptions.all, apiUrl, profile });
    }
  );

const profileCommand = program
  .command("profile")
  .description("Manage configuration profiles");

profileCommand
  .command("list")
  .description("List all profiles")
  .action(() => {
    listProfilesCommand();
  });

profileCommand
  .command("use <name>")
  .description("Switch the active profile")
  .action((name: string) => {
    useProfileCommand(name);
  });

profileCommand
  .command("add <name>")
  .description("Add a new profile")
  .option("--api-url <url>", "API URL for the new profile")
  .action((name: string, cmdOptions: { apiUrl?: string }) => {
    // NOTE: --api-url duplicates the global flag, so commander may attribute
    // it to the root program instead of this subcommand. Fall back to it.
    const options = program.opts();
    addProfileCommand(name, {
      apiUrl: cmdOptions.apiUrl || options.apiUrl,
    });
  });

profileCommand
  .command("show [name]")
  .description("Show profile details (defaults to the active profile)")
  .action((name?: string) => {
    showProfileCommand(name);
  });

profileCommand
  .command("remove <name>")
  .description("Remove a profile and its stored credential")
  .option("-y, --yes", "Skip removal confirmation prompt")
  .action(async (name: string, cmdOptions: { yes?: boolean }) => {
    await removeProfileCommand(name, { yes: cmdOptions.yes });
  });

program.allowExcessArguments();
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
  const globalApiUrl = program.opts().apiUrl as string | undefined;
  if (globalApiUrl) {
    persistGlobalApiUrl(globalApiUrl);
    return;
  }
  console.log(`
${pc.bold(pc.cyan("UpShare CLI"))}
${pc.dim("Fast & secure file sharing from your terminal.")}

Run ${pc.cyan("upshare --help")} to see all available commands.
`);
});

function persistGlobalApiUrl(rawUrl: string): void {
  try {
    const apiUrl = normalizeApiUrl(rawUrl);
    const profile = getActiveProfileName(program.opts().profile);
    saveProfile(profile, { apiUrl });
    console.log();
    console.log(
      `${pc.dim(`API URL for profile "${profile}" set to`)} ${pc.cyan(apiUrl)}`
    );
    console.log();
    if (
      process.env.UPSHARE_API_URL &&
      normalizeApiUrl(process.env.UPSHARE_API_URL) !== apiUrl
    ) {
      printWarning(
        "UPSHARE_API_URL is set and takes precedence over the saved URL."
      );
    }
  } catch (error) {
    printError(error instanceof Error ? error.message : "Invalid API URL.");
    process.exitCode = 1;
  }
}

async function run() {
  if (
    process.argv.slice(2).some((arg) => arg === "-v" || arg === "--version")
  ) {
    await printVersionWithUpdateCheck(CURRENT_VERSION);
    return;
  }

  const updatePromise = checkForUpdate(CURRENT_VERSION);

  try {
    await program.parseAsync(process.argv);
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
