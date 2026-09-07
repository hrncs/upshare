import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const userSchema = z.strictObject({
  email: z.email(),
  id: z.string().min(1),
  name: z.string().min(1),
});
const configSchema = z.strictObject({
  apiUrl: z.string().optional(),
  keyPrefix: z.string().min(1).max(32).optional(),
  lastUpdateCheck: z.number().int().nonnegative().optional(),
  latestVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:[-+].*)?$/)
    .optional(),
  user: userSchema.optional(),
});

export type CliConfig = z.infer<typeof configSchema>;
export const DEFAULT_API_URL = "https://upshare.app";

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

export function getEffectiveApiUrl(overrideUrl?: string): string {
  const explicitUrl = overrideUrl || process.env.UPSHARE_API_URL;
  if (explicitUrl) {
    return normalizeApiUrl(explicitUrl);
  }
  return normalizeApiUrl(loadConfig().apiUrl || DEFAULT_API_URL);
}

export function loadConfig(): CliConfig {
  const { configFile } = getConfigPaths();
  if (!fs.existsSync(configFile)) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configFile, "utf8"));
    const result = configSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error("Configuration does not match the expected schema.");
    }
    return result.data;
  } catch (error) {
    throw new Error(
      `Invalid UpShare configuration at ${configFile}. Run \`upshare logout\` to reset it.`,
      { cause: error }
    );
  }
}

export function saveConfig(updates: Partial<CliConfig>): void {
  const { configDirectory, configFile } = getConfigPaths();
  fs.mkdirSync(configDirectory, { mode: 0o700, recursive: true });
  fs.chmodSync(configDirectory, 0o700);

  const normalizedUpdates: Partial<CliConfig> = { ...updates };
  if (updates.apiUrl !== undefined) {
    normalizedUpdates.apiUrl = normalizeApiUrl(updates.apiUrl);
  }
  const merged = configSchema.parse({ ...loadConfig(), ...normalizedUpdates });
  const temporaryFile = path.join(
    configDirectory,
    `.config-${process.pid}-${Date.now()}.tmp`
  );

  try {
    fs.writeFileSync(temporaryFile, `${JSON.stringify(merged, null, 2)}\n`, {
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
