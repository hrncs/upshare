import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const userSchema = z.strictObject({
  email: z.email(),
  id: z.string().min(1),
  name: z.string().min(1),
});
const profileSchema = z.strictObject({
  apiUrl: z.string().min(1),
  keyPrefix: z.string().min(1).max(32).optional(),
  user: userSchema.optional(),
});
const rawConfigSchema = z.strictObject({
  apiUrl: z.string().optional(),
  currentProfile: z.string().min(1).max(64).optional(),
  keyPrefix: z.string().min(1).max(32).optional(),
  lastUpdateCheck: z.number().int().nonnegative().optional(),
  latestVersion: z.string().regex(VERSION_PATTERN).optional(),
  profiles: z.record(z.string(), profileSchema).optional(),
  user: userSchema.optional(),
});

export type ConfigUser = z.infer<typeof userSchema>;
export interface ProfileConfig {
  apiUrl: string;
  keyPrefix?: string;
  user?: ConfigUser;
}
export interface CliConfig {
  currentProfile?: string;
  lastUpdateCheck?: number;
  latestVersion?: string;
  profiles?: Record<string, ProfileConfig>;
}
export const DEFAULT_API_URL = "https://upshare.app";
export const DEFAULT_PROFILE = "default";
export const PROFILE_ENVIRONMENT_VARIABLE = "UPSHARE_PROFILE";
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function normalizeProfileName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!PROFILE_NAME_PATTERN.test(normalized)) {
    throw new Error(
      "Profile name must be 1-64 characters: letters, numbers, `_` or `-`, starting with a letter or number."
    );
  }
  return normalized;
}

export function getConfigPaths() {
  const configDirectory = process.env.UPSHARE_CONFIG_DIR
    ? path.resolve(process.env.UPSHARE_CONFIG_DIR)
    : path.join(os.homedir(), ".upshare");
  return {
    configDirectory,
    configFile: path.join(configDirectory, "config.json"),
  };
}

export function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`Invalid UpShare API URL: ${value}`, { cause: error });
  }

  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "The UpShare API URL must use HTTPS (HTTP is allowed for localhost only)."
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "The UpShare API URL must be an origin without credentials, path, query, or fragment."
    );
  }
  return url.origin;
}

type RawConfig = z.infer<typeof rawConfigSchema>;

let configCache:
  | { data: CliConfig; file: string; mtimeMs: number; size: number }
  | undefined;

function invalidateConfigCache(): void {
  configCache = undefined;
}

function validateConfigDirEarly(directory: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Invalid UpShare configuration: ${directory} exists but is not a directory.`
    );
  }
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: fs.constants are bit flags by design
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    throw new Error(
      `Invalid UpShare configuration: configuration directory ${directory} is not readable/writable. Check permissions.`,
      { cause: error }
    );
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: config migration handles legacy + per-profile validation in one pass
function normalizeRawConfig(raw: RawConfig): CliConfig {
  const profiles: Record<string, ProfileConfig> = {};
  for (const [name, entry] of Object.entries(raw.profiles ?? {})) {
    try {
      profiles[normalizeProfileName(name)] = {
        apiUrl: normalizeApiUrl(entry.apiUrl),
        ...(entry.keyPrefix === undefined
          ? {}
          : { keyPrefix: entry.keyPrefix }),
        ...(entry.user === undefined ? {} : { user: entry.user }),
      };
    } catch (error) {
      console.warn(
        `Warning: skipping invalid profile ${JSON.stringify(name)} in configuration: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (
    profiles[DEFAULT_PROFILE] === undefined &&
    (raw.apiUrl !== undefined ||
      raw.keyPrefix !== undefined ||
      raw.user !== undefined)
  ) {
    try {
      profiles[DEFAULT_PROFILE] = {
        apiUrl: normalizeApiUrl(raw.apiUrl ?? DEFAULT_API_URL),
        ...(raw.keyPrefix === undefined ? {} : { keyPrefix: raw.keyPrefix }),
        ...(raw.user === undefined ? {} : { user: raw.user }),
      };
    } catch (error) {
      console.warn(
        `Warning: skipping invalid legacy default profile: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  let currentProfile: string | undefined;
  if (raw.currentProfile !== undefined) {
    try {
      currentProfile = normalizeProfileName(raw.currentProfile);
    } catch (error) {
      console.warn(
        `Warning: ignoring invalid currentProfile in configuration: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return {
    ...(currentProfile === undefined ? {} : { currentProfile }),
    ...(raw.lastUpdateCheck === undefined
      ? {}
      : { lastUpdateCheck: raw.lastUpdateCheck }),
    ...(raw.latestVersion === undefined
      ? {}
      : { latestVersion: raw.latestVersion }),
    ...(Object.keys(profiles).length === 0 ? {} : { profiles }),
  };
}

export function loadConfig(): CliConfig {
  const { configDirectory, configFile } = getConfigPaths();
  validateConfigDirEarly(configDirectory);
  if (!fs.existsSync(configFile)) {
    return {};
  }
  try {
    const stat = fs.statSync(configFile);
    const cached = configCache;
    if (
      cached &&
      cached.file === configFile &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.data;
    }
    let rawText: string;
    try {
      rawText = fs.readFileSync(configFile, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EACCES" || error.code === "EPERM")
      ) {
        throw new Error(
          `Invalid UpShare configuration at ${configFile}: permission denied. Check file permissions.`,
          { cause: error }
        );
      }
      throw new Error(
        `Invalid UpShare configuration at ${configFile}: could not be read.`,
        { cause: error }
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      throw new Error(
        `Invalid UpShare configuration at ${configFile}: file is not valid JSON. Run \`upshare logout --all\` to reset it.`,
        { cause: error }
      );
    }
    const result = rawConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Invalid UpShare configuration at ${configFile}: configuration does not match the expected schema. Run \`upshare logout --all\` to reset it.`
      );
    }
    const data = normalizeRawConfig(result.data);
    configCache = {
      data,
      file: configFile,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
    return data;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Invalid UpShare configuration")
    ) {
      throw error;
    }
    throw new Error(
      `Invalid UpShare configuration at ${configFile}. Run \`upshare logout --all\` to reset it.`,
      { cause: error }
    );
  }
}

function writeConfig(config: CliConfig): void {
  const { configDirectory, configFile } = getConfigPaths();
  fs.mkdirSync(configDirectory, { mode: 0o700, recursive: true });
  // chmodSync is a no-op on Windows (ACL-based permissions); modes only
  // apply on POSIX. Skip there to avoid confusion.
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(configDirectory, 0o700);
    } catch {
      // Intentionally ignored: permission hardening is best-effort.
    }
  }

  let payload: z.infer<typeof rawConfigSchema>;
  try {
    payload = rawConfigSchema.parse({
      ...(config.currentProfile === undefined
        ? {}
        : { currentProfile: config.currentProfile }),
      ...(config.lastUpdateCheck === undefined
        ? {}
        : { lastUpdateCheck: config.lastUpdateCheck }),
      ...(config.latestVersion === undefined
        ? {}
        : { latestVersion: config.latestVersion }),
      ...(config.profiles === undefined ? {} : { profiles: config.profiles }),
    });
  } catch (error) {
    throw new Error(
      "Invalid UpShare configuration: cannot save an invalid configuration object.",
      { cause: error }
    );
  }
  const temporaryFile = path.join(
    configDirectory,
    `.config-${process.pid}-${Date.now()}.tmp`
  );

  try {
    fs.writeFileSync(temporaryFile, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporaryFile, configFile);
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(configFile, 0o600);
      } catch {
        // Intentionally ignored: permission hardening is best-effort.
      }
    }
    invalidateConfigCache();
  } catch (error) {
    try {
      fs.unlinkSync(temporaryFile);
    } catch {
      // Intentionally ignored: temp-file cleanup is best-effort.
    }
    throw error;
  }
}

export function getActiveProfileName(
  explicit?: string,
  cached?: CliConfig
): string {
  const raw =
    explicit ??
    process.env[PROFILE_ENVIRONMENT_VARIABLE] ??
    (cached ?? loadConfig()).currentProfile ??
    DEFAULT_PROFILE;
  return normalizeProfileName(raw);
}

export function getProfileEntry(
  profile: string,
  cached?: CliConfig
): ProfileConfig | undefined {
  return (cached ?? loadConfig()).profiles?.[normalizeProfileName(profile)];
}

export function listProfileNames(cached?: CliConfig): string[] {
  return Object.keys((cached ?? loadConfig()).profiles ?? {}).sort();
}

export function getEffectiveApiUrl(
  overrideUrl?: string,
  profile?: string,
  cached?: CliConfig
): string {
  const explicitUrl = overrideUrl || process.env.UPSHARE_API_URL;
  if (explicitUrl) {
    return normalizeApiUrl(explicitUrl);
  }
  const config = cached ?? loadConfig();
  const name =
    profile === undefined
      ? getActiveProfileName(undefined, config)
      : normalizeProfileName(profile);
  return normalizeApiUrl(config.profiles?.[name]?.apiUrl || DEFAULT_API_URL);
}

export interface CommandContext {
  apiUrl: string;
  profile: string;
}

export function resolveCommandContext(options?: {
  apiUrl?: string;
  profile?: string;
}): CommandContext {
  const config = loadConfig();
  const profile = getActiveProfileName(options?.profile, config);
  return {
    apiUrl: getEffectiveApiUrl(options?.apiUrl, profile, config),
    profile,
  };
}

export function saveProfile(
  profile: string,
  updates: { apiUrl?: string; keyPrefix?: string; user?: ConfigUser }
): void {
  const name = normalizeProfileName(profile);
  const config = loadConfig();
  const existing: ProfileConfig = config.profiles?.[name] ?? {
    apiUrl: DEFAULT_API_URL,
  };
  const next: ProfileConfig = {
    apiUrl:
      updates.apiUrl === undefined
        ? existing.apiUrl
        : normalizeApiUrl(updates.apiUrl),
    ...((updates.keyPrefix ?? existing.keyPrefix)
      ? { keyPrefix: (updates.keyPrefix ?? existing.keyPrefix) as string }
      : {}),
    ...((updates.user ?? existing.user)
      ? { user: (updates.user ?? existing.user) as ConfigUser }
      : {}),
  };
  writeConfig({
    ...config,
    profiles: { ...config.profiles, [name]: next },
  });
}

export function saveGlobal(updates: {
  lastUpdateCheck?: number;
  latestVersion?: string;
}): void {
  const config = loadConfig();
  writeConfig({
    ...config,
    ...(updates.lastUpdateCheck === undefined
      ? {}
      : { lastUpdateCheck: updates.lastUpdateCheck }),
    ...(updates.latestVersion === undefined
      ? {}
      : { latestVersion: updates.latestVersion }),
  });
}

export function setCurrentProfile(profile: string): void {
  const name = normalizeProfileName(profile);
  const config = loadConfig();
  if (config.profiles?.[name] === undefined) {
    throw new Error(
      `Profile "${name}" not found. Run \`upshare profile list\` to see available profiles.`
    );
  }
  writeConfig({ ...config, currentProfile: name });
}

export function clearProfileLogin(profile: string): void {
  const name = normalizeProfileName(profile);
  const config = loadConfig();
  const entry = config.profiles?.[name];
  if (!entry) {
    return;
  }
  if (entry.keyPrefix === undefined && entry.user === undefined) {
    return;
  }
  writeConfig({
    ...config,
    profiles: { ...config.profiles, [name]: { apiUrl: entry.apiUrl } },
  });
}

export function removeProfileFromConfig(profile: string): void {
  const name = normalizeProfileName(profile);
  const config = loadConfig();
  const remaining = { ...config.profiles };
  if (remaining[name] === undefined) {
    throw new Error(`Profile "${name}" not found. Nothing to remove.`);
  }
  delete remaining[name];
  const { currentProfile: activeProfile } = config;
  let currentProfile = activeProfile;
  if (currentProfile === name) {
    currentProfile =
      remaining[DEFAULT_PROFILE] === undefined
        ? Object.keys(remaining).sort()[0]
        : DEFAULT_PROFILE;
  }
  const next: CliConfig = { ...config };
  if (currentProfile === undefined) {
    // biome-ignore lint/performance/noDelete: removing optional key so JSON omits it
    delete next.currentProfile;
  } else {
    next.currentProfile = currentProfile;
  }
  if (Object.keys(remaining).length === 0) {
    // biome-ignore lint/performance/noDelete: removing optional key so JSON omits it
    delete next.profiles;
  } else {
    next.profiles = remaining;
  }
  if (
    next.profiles === undefined &&
    next.currentProfile === undefined &&
    next.lastUpdateCheck === undefined &&
    next.latestVersion === undefined
  ) {
    clearConfig();
    return;
  }
  writeConfig(next);
}

export function clearConfig(): void {
  const { configFile } = getConfigPaths();
  try {
    fs.unlinkSync(configFile);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  } finally {
    invalidateConfigCache();
  }
}
