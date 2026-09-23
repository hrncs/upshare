import pc from "picocolors";
import { z } from "zod";
import { loadConfig, saveGlobal } from "./config";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 800;
const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org/upshare";
const NPM_REGISTRY_URL = `${NPM_REGISTRY_BASE_URL}/latest`;
const registryResponseSchema = z.object({ version: z.string() });

const VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const NUMERIC_PATTERN = /^\d+$/;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: (number | string)[] | null;
}

function parseVersion(value: string): ParsedVersion | null {
  const match: RegExpExecArray | null = VERSION_PATTERN.exec(value.trim());
  if (match === null) {
    return null;
  }
  return {
    major: Number.parseInt(match[1] ?? "0", 10),
    minor: Number.parseInt(match[2] ?? "0", 10),
    patch: Number.parseInt(match[3] ?? "0", 10),
    prerelease:
      match[4] === undefined
        ? null
        : match[4]
            .split(".")
            .map((part) =>
              NUMERIC_PATTERN.test(part) ? Number.parseInt(part, 10) : part
            ),
  };
}

function compareNumbers(a: number, b: number): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function comparePrereleaseIdentifiers(
  a: number | string,
  b: number | string
): number {
  if (typeof a === "number" && typeof b === "number") {
    return compareNumbers(a, b);
  }
  if (typeof a === "number") {
    return -1;
  }
  if (typeof b === "number") {
    return 1;
  }
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function compareVersionCore(c: ParsedVersion, l: ParsedVersion): number {
  return (
    compareNumbers(c.major, l.major) ||
    compareNumbers(c.minor, l.minor) ||
    compareNumbers(c.patch, l.patch)
  );
}

function comparePrerelease(
  current: (number | string)[] | null,
  latest: (number | string)[] | null
): number {
  if (current === null && latest === null) {
    return 0;
  }
  if (current !== null && latest === null) {
    return -1;
  }
  if (current === null && latest !== null) {
    return 1;
  }
  const currentIds = current ?? [];
  const latestIds = latest ?? [];
  const length = Math.max(currentIds.length, latestIds.length);
  for (let i = 0; i < length; i += 1) {
    const a = currentIds[i];
    const b = latestIds[i];
    if (a === undefined) {
      return -1;
    }
    if (b === undefined) {
      return 1;
    }
    const compared = comparePrereleaseIdentifiers(a, b);
    if (compared !== 0) {
      return compared;
    }
  }
  return 0;
}

export function isNewerVersion(current: string, latest: string): boolean {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  if (!(c && l)) {
    return false;
  }
  const core = compareVersionCore(c, l);
  if (core !== 0) {
    return core < 0;
  }
  return comparePrerelease(c.prerelease, l.prerelease) < 0;
}

export function isStableVersion(version: string): boolean {
  const parsed = parseVersion(version);
  return parsed !== null && parsed.prerelease === null;
}

export function isUpdateAvailable(current: string, latest: string): boolean {
  if (!isNewerVersion(current, latest)) {
    return false;
  }
  return !isStableVersion(current) || isStableVersion(latest);
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function isUpdateCheckDisabled(argv: string[] = process.argv): boolean {
  if (argv.includes("--no-update-check")) {
    return true;
  }
  return isTruthyEnv(process.env.UPSHARE_NO_UPDATE_CHECK);
}

export function shouldSkipUpdateCheck(argv: string[] = process.argv): boolean {
  if (isUpdateCheckDisabled(argv)) {
    return true;
  }
  const ci = process.env.CI?.trim().toLowerCase();
  if (ci && ci !== "0" && ci !== "false") {
    return true;
  }
  if (process.stdout.isTTY === false) {
    return true;
  }
  return false;
}

export async function checkForUpdate(
  currentVersion: string,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS
): Promise<string | null> {
  try {
    const config = loadConfig();
    const now = Date.now();

    if (
      config.lastUpdateCheck &&
      now - config.lastUpdateCheck < CHECK_INTERVAL_MS
    ) {
      if (
        config.latestVersion &&
        isUpdateAvailable(currentVersion, config.latestVersion)
      ) {
        return config.latestVersion;
      }
      return null;
    }

    const res = await fetch(NPM_REGISTRY_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return null;
    }

    const parsed = registryResponseSchema.safeParse(await res.json());
    const latest = parsed.success ? parsed.data.version : undefined;

    if (latest) {
      saveGlobal({
        lastUpdateCheck: now,
        latestVersion: latest,
      });

      if (isUpdateAvailable(currentVersion, latest)) {
        return latest;
      }
    }

    return null;
  } catch {
    return null;
  }
}

export async function fetchDistTagVersion(
  tag: string,
  timeoutMs = 10_000
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${NPM_REGISTRY_BASE_URL}/${tag}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(
      "Couldn't reach the update registry. Check your connection.",
      {
        cause: error,
      }
    );
  }
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Update registry responded with HTTP ${res.status}.`);
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch (error) {
    throw new Error("Update registry returned an invalid response.", {
      cause: error,
    });
  }
  const parsed = registryResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data.version : null;
}

export function fetchLatestVersion(timeoutMs = 10_000): Promise<string | null> {
  return fetchDistTagVersion("latest", timeoutMs);
}

export function printUpdateBanner(current: string, latest: string): void {
  console.log();
  console.log(
    `${pc.yellow("Update available:")} ${pc.dim(current)} -> ${pc.green(latest)}`
  );
  console.log(`${pc.dim("Update with:")} ${pc.cyan("upshare upgrade")}`);
  console.log();
}

export function printVersionWithUpdateCheck(currentVersion: string): void {
  console.log(currentVersion);
  if (isUpdateCheckDisabled()) {
    return;
  }
  const { latestVersion } = loadConfig();
  if (latestVersion && isUpdateAvailable(currentVersion, latestVersion)) {
    printUpdateBanner(currentVersion, latestVersion);
  }
}
