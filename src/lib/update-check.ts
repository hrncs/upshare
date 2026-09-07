import pc from "picocolors";
import { z } from "zod";
import { loadConfig, saveConfig } from "./config";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NPM_REGISTRY_URL = "https://registry.npmjs.org/upshare/latest";
const registryResponseSchema = z.object({ version: z.string() });

export function isNewerVersion(current: string, latest: string): boolean {
  const currentParts = current
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  const latestParts = latest.split(".").map((n) => Number.parseInt(n, 10) || 0);

  for (let i = 0; i < 3; i += 1) {
    const c = currentParts[i] ?? 0;
    const l = latestParts[i] ?? 0;
    if (l > c) {
      return true;
    }
    if (l < c) {
      return false;
    }
  }
  return false;
}

export async function checkForUpdate(
  currentVersion: string
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
        isNewerVersion(currentVersion, config.latestVersion)
      ) {
        return config.latestVersion;
      }
      return null;
    }

    const res = await fetch(NPM_REGISTRY_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(1200),
    });

    if (!res.ok) {
      return null;
    }

    const parsed = registryResponseSchema.safeParse(await res.json());
    const latest = parsed.success ? parsed.data.version : undefined;

    if (latest) {
      saveConfig({
        lastUpdateCheck: now,
        latestVersion: latest,
      });

      if (isNewerVersion(currentVersion, latest)) {
        return latest;
      }
    }

    return null;
  } catch {
    return null;
  }
}

export async function fetchLatestVersion(
  timeoutMs = 10_000
): Promise<string | null> {
  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return null;
    }
    const parsed = registryResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.version : null;
  } catch {
    return null;
  }
}

export function printUpdateBanner(current: string, latest: string): void {
  console.log();
  console.log(
    `${pc.yellow("Update available:")} ${pc.dim(current)} -> ${pc.green(latest)}`
  );
  console.log(`${pc.dim("Update with:")} ${pc.cyan("upshare upgrade")}`);
  console.log();
}

export async function printVersionWithUpdateCheck(
  currentVersion: string,
  timeoutMs = 1200
): Promise<void> {
  console.log(currentVersion);
  const latest = await fetchLatestVersion(timeoutMs);
  if (latest && isNewerVersion(currentVersion, latest)) {
    printUpdateBanner(currentVersion, latest);
  }
}
