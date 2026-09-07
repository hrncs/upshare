import { createRequire } from "node:module";
import type { Entry as KeyringEntry } from "@napi-rs/keyring";
import { z } from "zod";

const API_KEY_ENVIRONMENT_VARIABLE = "UPSHARE_API_KEY";
const CREDENTIAL_SERVICE = "UpShare CLI";
const apiKeySchema = z.string().trim().min(1);
const runtimeRequire = createRequire(import.meta.url);

export interface CredentialBackend {
  delete: (apiUrl: string) => boolean;
  get: (apiUrl: string) => string | undefined;
  set: (apiUrl: string, apiKey: string) => void;
}

export interface ResolvedCredential {
  apiKey: string;
  source: "environment" | "keyring";
}

type KeyringConstructor = new (
  service: string,
  username: string
) => Pick<KeyringEntry, "deletePassword" | "getPassword" | "setPassword">;

function credentialStoreError(action: string, cause: unknown): Error {
  return new Error(
    `Could not ${action} the API key in ${getCredentialStoreName()}. ` +
      `Set ${API_KEY_ENVIRONMENT_VARIABLE} for temporary or headless use.`,
    { cause }
  );
}

function createEntry(apiUrl: string) {
  try {
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
      return createEntry(apiUrl).getPassword() ?? undefined;
    } catch (error) {
      throw credentialStoreError("read", error);
    }
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

export function resolveApiKey(
  apiUrl: string,
  backend: CredentialBackend = nativeCredentialBackend
): ResolvedCredential | undefined {
  const environmentApiKey = getEnvironmentApiKey();
  if (environmentApiKey) {
    return { apiKey: environmentApiKey, source: "environment" };
  }

  const storedApiKey = backend.get(apiUrl);
  return storedApiKey ? { apiKey: storedApiKey, source: "keyring" } : undefined;
}

export function storeApiKeyWithRollback(
  apiUrl: string,
  apiKey: string,
  commitMetadata: () => void,
  backend: CredentialBackend = nativeCredentialBackend
): void {
  const previousApiKey = backend.get(apiUrl);
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

export function deleteStoredApiKey(
  apiUrl: string,
  backend: CredentialBackend = nativeCredentialBackend
): boolean {
  return backend.delete(apiUrl);
}
