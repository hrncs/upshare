import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

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
  latestVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:[-+].*)?$/)
    .optional(),
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

function normalizeRawConfig(raw: RawConfig): CliConfig {
  const profiles: Record<string, ProfileConfig> = {};
  for (const [name, entry] of Object.entries(raw.profiles ?? {})) {
    profiles[normalizeProfileName(name)] = {
      apiUrl: normalizeApiUrl(entry.apiUrl),
      ...(entry.keyPrefix === undefined ? {} : { keyPrefix: entry.keyPrefix }),
      ...(entry.user === undefined ? {} : { user: entry.user }),
    };
  }
  if (
    profiles[DEFAULT_PROFILE] === undefined &&
    (raw.apiUrl !== undefined ||
      raw.keyPrefix !== undefined ||
      raw.user !== undefined)
  ) {
    profiles[DEFAULT_PROFILE] = {
      apiUrl: normalizeApiUrl(raw.apiUrl ?? DEFAULT_API_URL),
      ...(raw.keyPrefix === undefined ? {} : { keyPrefix: raw.keyPrefix }),
      ...(raw.user === undefined ? {} : { user: raw.user }),
    };
  }
  return {
    ...(raw.currentProfile === undefined
      ? {}
      : { currentProfile: normalizeProfileName(raw.currentProfile) }),
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
  const { configFile } = getConfigPaths();
  if (!fs.existsSync(configFile)) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configFile, "utf8"));
    const result = rawConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error("Configuration does not match the expected schema.");
    }
    return normalizeRawConfig(result.data);
  } catch (error) {
    throw new Error(
      `Invalid UpShare configuration at ${configFile}. Run \`upshare logout --all\` to reset it.`,
      { cause: error }
    );
  }
}

function writeConfig(config: CliConfig): void {
  const { configDirectory, configFile } = getConfigPaths();
  fs.mkdirSync(configDirectory, { mode: 0o700, recursive: true });
  fs.chmodSync(configDirectory, 0o700);

  const payload = rawConfigSchema.parse({
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
    fs.chmodSync(configFile, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryFile);
    } catch {
      // Ignore cleanup error if temporary file was not created
    }
    throw error;
  }
}

export function getActiveProfileName(explicit?: string): string {
  const raw =
    explicit ??
    process.env[PROFILE_ENVIRONMENT_VARIABLE] ??
    loadConfig().currentProfile ??
    DEFAULT_PROFILE;
  return normalizeProfileName(raw);
}

export function getProfileEntry(profile: string): ProfileConfig | undefined {
  return loadConfig().profiles?.[normalizeProfileName(profile)];
}

export function listProfileNames(): string[] {
  return Object.keys(loadConfig().profiles ?? {}).sort();
}

export function getEffectiveApiUrl(
  overrideUrl?: string,
  profile?: string
): string {
  const explicitUrl = overrideUrl || process.env.UPSHARE_API_URL;
  if (explicitUrl) {
    return normalizeApiUrl(explicitUrl);
  }
  const name =
    profile === undefined
      ? getActiveProfileName()
      : normalizeProfileName(profile);
  return normalizeApiUrl(
    loadConfig().profiles?.[name]?.apiUrl || DEFAULT_API_URL
  );
}

export interface CommandContext {
  apiUrl: string;
  profile: string;
}

export function resolveCommandContext(options?: {
  apiUrl?: string;
  profile?: string;
}): CommandContext {
  const profile = getActiveProfileName(options?.profile);
  return { apiUrl: getEffectiveApiUrl(options?.apiUrl, profile), profile };
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
  };
  const keyPrefix = updates.keyPrefix ?? existing.keyPrefix;
  if (keyPrefix !== undefined) {
    next.keyPrefix = keyPrefix;
  }
  const user = updates.user ?? existing.user;
  if (user !== undefined) {
    next.user = user;
  }
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
  if (config.profiles?.[name] === undefined) {
    throw new Error(`Profile "${name}" not found. Nothing to remove.`);
  }
  const { [name]: _removed, ...remaining } = config.profiles;
  let { currentProfile } = config;
  if (currentProfile === name) {
    currentProfile =
      remaining[DEFAULT_PROFILE] === undefined
        ? Object.keys(remaining).sort()[0]
        : DEFAULT_PROFILE;
  }
  const next: CliConfig = {
    ...config,
    ...(currentProfile === undefined
      ? { currentProfile: undefined }
      : { currentProfile }),
    ...(Object.keys(remaining).length === 0
      ? { profiles: undefined }
      : { profiles: remaining }),
  };
  const cleaned: CliConfig = Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined)
  ) as CliConfig;
  if (
    cleaned.profiles === undefined &&
    cleaned.currentProfile === undefined &&
    cleaned.lastUpdateCheck === undefined &&
    cleaned.latestVersion === undefined
  ) {
    clearConfig();
    return;
  }
  writeConfig(cleaned);
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
  }
}
