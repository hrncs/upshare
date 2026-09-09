import { createRequire } from "node:module";
import type { Entry as KeyringEntry } from "@napi-rs/keyring";
import { z } from "zod";
import { DEFAULT_PROFILE, normalizeProfileName } from "./config";

const API_KEY_ENVIRONMENT_VARIABLE = "UPSHARE_API_KEY";
const CREDENTIAL_SERVICE = "UpShare CLI";
const PROFILE_ACCOUNT_SEPARATOR = "::";
const AMBIGUOUS_ERROR_PATTERN = /ambiguous/i;
const apiKeySchema = z.string().trim().min(1);
const runtimeRequire = createRequire(import.meta.url);

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
  keyringEntryOverride = factory === undefined ? undefined : { factory };
}

/** @internal Test-only hook to inject a fake findCredentials. */
export function __setFindCredentialsForTesting(
  fn: FindCredentialsFn | undefined
): void {
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
    const keyring = runtimeRequire("@napi-rs/keyring") as {
      Entry?: KeyringConstructor;
    };
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
    const keyring = runtimeRequire("@napi-rs/keyring") as {
      findCredentials?: FindCredentialsFn;
    };
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
      if (raw === undefined) {
        return;
      }
      const parsed = apiKeySchema.safeParse(raw);
      return parsed.success ? parsed.data : undefined;
    } catch (error) {
      throw credentialStoreError("read", error);
    }
  },
  list() {
    return listStoredAccounts().map((entry) => entry.account);
  },
  set(apiUrl, apiKey) {
    try {
      createEntry(apiUrl).setPassword(apiKeySchema.parse(apiKey));
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

  const parsed = apiKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${API_KEY_ENVIRONMENT_VARIABLE} must not be empty.`);
  }
  return parsed.data;
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
  if (!storedApiKey) {
    return undefined;
  }
  const parsed = apiKeySchema.safeParse(storedApiKey);
  return parsed.success
    ? { apiKey: parsed.data, source: "keyring" }
    : undefined;
}

export function resolveApiKey(
  apiUrl: string,
  backend: CredentialBackend = nativeCredentialBackend
): ResolvedCredential | undefined {
  const environmentApiKey = getEnvironmentApiKey();
  if (environmentApiKey) {
    return { apiKey: environmentApiKey, source: "environment" };
  }

  return toResolvedCredential(backend.get(apiUrl));
}

export function resolveProfileApiKey(
  profile: string,
  apiUrl: string,
  backend: CredentialBackend = nativeCredentialBackend
): ResolvedCredential | undefined {
  const environmentApiKey = getEnvironmentApiKey();
  if (environmentApiKey) {
    return { apiKey: environmentApiKey, source: "environment" };
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
      // Ignore legacy cleanup failure; the credential remains readable.
    }
  } catch {
    // Ignore migration failure and fall back to the legacy entry.
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
}

export function deleteAllStoredApiKeys(
  backend: CredentialBackend = nativeCredentialBackend
): DeleteAllResult {
  const candidates = backend.list?.() ?? [];
  const result: DeleteAllResult = { deletedApiUrls: [], failed: [] };
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
  const rawPrevious = backend.get(apiUrl);
  const parsedPrevious = rawPrevious
    ? apiKeySchema.safeParse(rawPrevious)
    : undefined;
  const previousApiKey =
    parsedPrevious?.success === true ? parsedPrevious.data : undefined;
  backend.set(apiUrl, apiKey);

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
      // Ignore legacy cleanup failure; the migrated entry is authoritative.
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
