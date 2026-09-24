import pc from "picocolors";
import { z } from "zod";
import { loadConfig, saveGlobal, VERSION_PATTERN } from "./config";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 800;
const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org/upshare";
const NPM_REGISTRY_URL = `${NPM_REGISTRY_BASE_URL}/latest`;
const registryResponseSchema = z.object({ version: z.string() });

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
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
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
  return Math.sign(a - b);
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
  const separator = argv.indexOf("--");
  const head = separator === -1 ? argv : argv.slice(0, separator);
  if (head.includes("--no-update-check")) {
    return true;
  }
  return isTruthyEnv(process.env.UPSHARE_NO_UPDATE_CHECK);
}

export function shouldSkipUpdateCheck(argv: string[] = process.argv): boolean {
  if (isUpdateCheckDisabled(argv)) {
    return true;
  }
  if (isTruthyEnv(process.env.CI)) {
    return true;
  }
  if (!process.stdout.isTTY) {
    return true;
  }
  return false;
}

async function fetchRegistryVersion(
  url: string,
  timeoutMs: number
): Promise<{ status: number; version?: string }> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const status = res.status ?? (res.ok ? 200 : 500);
  if (!res.ok) {
    return { status };
  }
  const parsed = registryResponseSchema.safeParse(await res.json());
  return {
    status,
    ...(parsed.success ? { version: parsed.data.version } : {}),
  };
}

function recordCheck(now: number, latest?: string): void {
  try {
    saveGlobal({
      lastUpdateCheck: now,
      ...(latest === undefined ? {} : { latestVersion: latest }),
    });
  } catch {
    // Intentionally ignored: cache write is best-effort.
  }
}

export async function checkForUpdate(
  currentVersion: string,
  timeoutMs = UPDATE_CHECK_TIMEOUT_MS
): Promise<string | null> {
  const now = Date.now();
  try {
    const config = loadConfig();

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

    let fetched: { status: number; version?: string };
    try {
      fetched = await fetchRegistryVersion(NPM_REGISTRY_URL, timeoutMs);
    } catch {
      recordCheck(now - CHECK_INTERVAL_MS + FAILURE_RETRY_MS);
      return null;
    }

    if (fetched.status !== 200 || !fetched.version) {
      recordCheck(now - CHECK_INTERVAL_MS + FAILURE_RETRY_MS);
      return null;
    }

    recordCheck(now, fetched.version);
    if (isUpdateAvailable(currentVersion, fetched.version)) {
      return fetched.version;
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
  let fetched: { status: number; version?: string };
  try {
    fetched = await fetchRegistryVersion(
      `${NPM_REGISTRY_BASE_URL}/${tag}`,
      timeoutMs
    );
  } catch (error) {
    throw new Error(
      "Couldn't reach the update registry. Check your connection.",
      {
        cause: error,
      }
    );
  }
  if (fetched.status === 404) {
    return null;
  }
  if (fetched.status !== 200) {
    throw new Error(`Update registry responded with HTTP ${fetched.status}.`);
  }
  return fetched.version ?? null;
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
