import { createRequire } from "node:module";
import type { Entry as KeyringEntry } from "@napi-rs/keyring";
import { DEFAULT_PROFILE, normalizeProfileName } from "./config";

const API_KEY_ENVIRONMENT_VARIABLE = "UPSHARE_API_KEY";
const CREDENTIAL_SERVICE = "UpShare CLI";
const PROFILE_ACCOUNT_SEPARATOR = "::";
const AMBIGUOUS_ERROR_PATTERN = /ambiguous/i;

function parseApiKeyValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const runtimeRequire = createRequire(import.meta.url);

let cachedKeyringModule:
  | {
      Entry?: KeyringConstructor;
      findCredentials?: FindCredentialsFn;
    }
  | undefined;
let keyringModuleLoaded = false;

function getKeyringModule(): {
  Entry?: KeyringConstructor;
  findCredentials?: FindCredentialsFn;
} {
  if (!keyringModuleLoaded) {
    try {
      cachedKeyringModule = runtimeRequire("@napi-rs/keyring") as {
        Entry?: KeyringConstructor;
        findCredentials?: FindCredentialsFn;
      };
    } catch {
      cachedKeyringModule = {};
    }
    keyringModuleLoaded = true;
  }
  return cachedKeyringModule ?? {};
}

export interface CredentialBackend {
  delete: (account: string) => boolean;
  get: (account: string) => string | undefined;
  list?: () => string[];
  set: (account: string, apiKey: string) => void;
}

export interface ResolvedCredential {
  apiKey: string;
  source: "environment" | "keyring";
}

type KeyringConstructor = new (
  service: string,
  username: string
) => Pick<KeyringEntry, "deletePassword" | "getPassword" | "setPassword">;

type FindCredentialsFn = (
  service: string
) => Array<{ account: string; password: string }>;

let keyringEntryOverride: { factory?: KeyringConstructor } | undefined;
let findCredentialsOverride: FindCredentialsFn | undefined;

/** @internal Test-only hook to inject a fake keyring Entry. */
export function __setKeyringEntryFactoryForTesting(
  factory: KeyringConstructor | undefined
): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Test hook unavailable in production.");
  }
  keyringEntryOverride = factory === undefined ? undefined : { factory };
}

/** @internal Test-only hook to inject a fake findCredentials. */
export function __setFindCredentialsForTesting(
  fn: FindCredentialsFn | undefined
): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Test hook unavailable in production.");
  }
  findCredentialsOverride = fn;
}

function isAmbiguousError(cause: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = cause;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (AMBIGUOUS_ERROR_PATTERN.test(current.message)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  if (typeof current === "string" && AMBIGUOUS_ERROR_PATTERN.test(current)) {
    return true;
  }
  return false;
}

function credentialStoreError(action: string, cause: unknown): Error {
  let hint = `Set ${API_KEY_ENVIRONMENT_VARIABLE} for temporary or headless use.`;
  if (isAmbiguousError(cause)) {
    hint =
      "The credential store contains multiple matching entries. " +
      `Run \`upshare logout --all\` to clear them and try again. ${hint}`;
  }
  return new Error(
    `Could not ${action} the API key in ${getCredentialStoreName()}. ${hint}`,
    { cause }
  );
}

function createEntry(apiUrl: string) {
  try {
    if (keyringEntryOverride) {
      if (!keyringEntryOverride.factory) {
        throw new Error("The native credential module did not export Entry");
      }
      return new keyringEntryOverride.factory(CREDENTIAL_SERVICE, apiUrl);
    }
    const keyring = getKeyringModule();
    if (!keyring.Entry) {
      throw new Error("The native credential module did not export Entry");
    }
    return new keyring.Entry(CREDENTIAL_SERVICE, apiUrl);
  } catch (error) {
    throw credentialStoreError("access", error);
  }
}

function listStoredAccounts(): Array<{ account: string; password: string }> {
  try {
    if (findCredentialsOverride) {
      return findCredentialsOverride(CREDENTIAL_SERVICE);
    }
    const keyring = getKeyringModule();
    if (!keyring.findCredentials) {
      return [];
    }
    return keyring.findCredentials(CREDENTIAL_SERVICE);
  } catch (error) {
    throw credentialStoreError("list", error);
  }
}

export const nativeCredentialBackend: CredentialBackend = {
  delete(apiUrl) {
    try {
      return createEntry(apiUrl).deletePassword();
    } catch (error) {
      throw credentialStoreError("delete", error);
    }
  },
  get(apiUrl) {
    try {
      const raw = createEntry(apiUrl).getPassword() ?? undefined;
      return parseApiKeyValue(raw);
    } catch (error) {
      throw credentialStoreError("read", error);
    }
  },
  list() {
    return listStoredAccounts().map((entry) => entry.account);
  },
  set(apiUrl, apiKey) {
    const parsed = parseApiKeyValue(apiKey);
    if (!parsed) {
      throw credentialStoreError(
        "store",
        new Error("API key must not be empty.")
      );
    }
    try {
      createEntry(apiUrl).setPassword(parsed);
    } catch (error) {
      throw credentialStoreError("store", error);
    }
  },
};

export function getCredentialStoreName(platform = process.platform): string {
  if (platform === "win32") {
    return "Windows Credential Manager";
  }
  if (platform === "darwin") {
    return "macOS Keychain";
  }
  if (platform === "linux") {
    return "Linux Secret Service";
  }
  return "the operating-system credential store";
}

const LIVE_KEY_PREFIX = "upshare_live_";

export function getApiKeyPrefix(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.startsWith(LIVE_KEY_PREFIX) && trimmed.length > 4) {
    return `${LIVE_KEY_PREFIX}...${trimmed.slice(-4)}`;
  }
  return trimmed.slice(0, 8);
}

export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.startsWith(LIVE_KEY_PREFIX) && trimmed.length > 4) {
    return getApiKeyPrefix(trimmed);
  }
  return `${getApiKeyPrefix(trimmed)}${"*".repeat(8)}`;
}

export function getEnvironmentApiKey(): string | undefined {
  const value = process.env[API_KEY_ENVIRONMENT_VARIABLE];
  if (value === undefined) {
    return undefined;
  }

  const parsed = parseApiKeyValue(value);
  if (!parsed) {
    throw new Error(`${API_KEY_ENVIRONMENT_VARIABLE} must not be empty.`);
  }
  return parsed;
}

export function getKeyringAccount(profile: string, apiUrl: string): string {
  return `${normalizeProfileName(profile)}${PROFILE_ACCOUNT_SEPARATOR}${apiUrl}`;
}

export function parseKeyringAccount(account: string): {
  apiUrl: string;
  profile: string;
} {
  const separator = account.indexOf(PROFILE_ACCOUNT_SEPARATOR);
  if (separator < 0) {
    return { apiUrl: account, profile: DEFAULT_PROFILE };
  }
  return {
    apiUrl: account.slice(separator + PROFILE_ACCOUNT_SEPARATOR.length),
    profile: account.slice(0, separator),
  };
}

function toResolvedCredential(
  storedApiKey: string | undefined
): ResolvedCredential | undefined {
  const parsed = parseApiKeyValue(storedApiKey);
  return parsed ? { apiKey: parsed, source: "keyring" } : undefined;
}

function getEnvironmentCredential(): ResolvedCredential | undefined {
  const environmentApiKey = getEnvironmentApiKey();
  return environmentApiKey
    ? { apiKey: environmentApiKey, source: "environment" }
    : undefined;
}

export function resolveApiKey(
  apiUrl: string,
  backend: CredentialBackend = nativeCredentialBackend
): ResolvedCredential | undefined {
  return (
    getEnvironmentCredential() ?? toResolvedCredential(backend.get(apiUrl))
  );
}

export function resolveProfileApiKey(
  profile: string,
  apiUrl: string,
  backend: CredentialBackend = nativeCredentialBackend
): ResolvedCredential | undefined {
  const environment = getEnvironmentCredential();
  if (environment) {
    return environment;
  }

  const account = getKeyringAccount(profile, apiUrl);
  const stored = toResolvedCredential(backend.get(account));
  if (stored) {
    return stored;
  }
  if (normalizeProfileName(profile) !== DEFAULT_PROFILE) {
    return undefined;
  }
  const legacy = toResolvedCredential(backend.get(apiUrl));
  if (!legacy) {
    return undefined;
  }

  try {
    backend.set(account, legacy.apiKey);
    try {
      backend.delete(apiUrl);
    } catch {
      // Intentionally ignored: legacy-entry cleanup is best-effort.
    }
  } catch {
    // Intentionally ignored: migration is best-effort; the credential was resolved.
  }
  return legacy;
}

export function ensureCredentialStoreAccessible(
  apiUrl: string,
  backend: CredentialBackend = nativeCredentialBackend
): void {
  backend.get(apiUrl);
}

export interface DeleteAllResult {
  deletedApiUrls: string[];
  failed: Array<{ apiUrl: string; error: Error }>;
  listed: boolean;
}

export function deleteAllStoredApiKeys(
  backend: CredentialBackend = nativeCredentialBackend
): DeleteAllResult {
  if (!backend.list) {
    console.warn(
      "Warning: credential backend does not support listing; no credentials were enumerated."
    );
    return { deletedApiUrls: [], failed: [], listed: false };
  }
  const candidates = backend.list();
  const result: DeleteAllResult = {
    deletedApiUrls: [],
    failed: [],
    listed: true,
  };
  for (const candidate of candidates) {
    try {
      if (backend.delete(candidate)) {
        result.deletedApiUrls.push(candidate);
      }
    } catch (error) {
      result.failed.push({
        apiUrl: candidate,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return result;
}

export function storeApiKeyWithRollback(
  apiUrl: string,
  apiKey: string,
  commitMetadata: () => void,
  backend: CredentialBackend = nativeCredentialBackend
): void {
  const previousApiKey = parseApiKeyValue(backend.get(apiUrl));
  const parsedNew = parseApiKeyValue(apiKey);
  if (!parsedNew) {
    throw new Error("API key must not be empty.");
  }
  backend.set(apiUrl, parsedNew);

  try {
    commitMetadata();
  } catch (error) {
    try {
      if (previousApiKey) {
        backend.set(apiUrl, previousApiKey);
      } else {
        backend.delete(apiUrl);
      }
    } catch (rollbackError) {
      // biome-ignore lint/style/useErrorCause: aggregate error retains both failures
      throw new AggregateError(
        [error, rollbackError],
        "Failed to save login metadata and restore the previous credential.",
        { cause: rollbackError }
      );
    }
    throw error;
  }
}

export function storeProfileApiKeyWithRollback(
  profile: string,
  apiUrl: string,
  apiKey: string,
  commitMetadata: () => void,
  backend: CredentialBackend = nativeCredentialBackend
): void {
  const account = getKeyringAccount(profile, apiUrl);
  storeApiKeyWithRollback(account, apiKey, commitMetadata, backend);
  if (normalizeProfileName(profile) === DEFAULT_PROFILE) {
    try {
      backend.delete(apiUrl);
    } catch {
      // Intentionally ignored: legacy-entry cleanup is best-effort.
    }
  }
}

export function deleteProfileCredential(
  profile: string,
  apiUrl: string,
  backend: CredentialBackend = nativeCredentialBackend
): boolean {
  const account = getKeyringAccount(profile, apiUrl);
  const candidates =
    normalizeProfileName(profile) === DEFAULT_PROFILE
      ? [account, apiUrl]
      : [account];
  let removed = false;
  let firstError: unknown;
  for (const candidate of candidates) {
    try {
      if (backend.delete(candidate)) {
        removed = true;
      }
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined && !removed) {
    throw firstError;
  }
  return removed;
}

export function deleteStoredApiKey(
  apiUrl: string,
  backend: CredentialBackend = nativeCredentialBackend
): boolean {
  return backend.delete(apiUrl);
}
