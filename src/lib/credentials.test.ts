import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setFindCredentialsForTesting,
  __setKeyringEntryFactoryForTesting,
  type CredentialBackend,
  deleteAllStoredApiKeys,
  deleteStoredApiKey,
  ensureCredentialStoreAccessible,
  getApiKeyPrefix,
  getCredentialStoreName,
  maskApiKey,
  nativeCredentialBackend,
  resolveApiKey,
  storeApiKeyWithRollback,
} from "./credentials";

const apiUrl = "https://upshare.app";
const READ_ERROR_PATTERN = "Could not read the API key";
const LOGOUT_ALL_HINT = "logout --all";

function createBackend(initialApiKey?: string): CredentialBackend & {
  delete: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  let storedApiKey = initialApiKey;
  return {
    delete: vi.fn(() => {
      const existed = storedApiKey !== undefined;
      storedApiKey = undefined;
      return existed;
    }),
    get: vi.fn(() => storedApiKey),
    set: vi.fn((_url: string, apiKey: string) => {
      storedApiKey = apiKey;
    }),
  };
}

afterEach(() => {
  delete process.env.UPSHARE_API_KEY;
  __setKeyringEntryFactoryForTesting(undefined);
  __setFindCredentialsForTesting(undefined);
});

describe("credential resolution", () => {
  it("uses the environment without reading the keyring", () => {
    process.env.UPSHARE_API_KEY = "  ups_ci_secret  ";
    const backend = createBackend("ups_stored_secret");

    expect(resolveApiKey(apiUrl, backend)).toEqual({
      apiKey: "ups_ci_secret",
      source: "environment",
    });
    expect(backend.get).not.toHaveBeenCalled();
  });

  it("uses the keyring when the environment is absent", () => {
    const backend = createBackend("ups_stored_secret");
    expect(resolveApiKey(apiUrl, backend)).toEqual({
      apiKey: "ups_stored_secret",
      source: "keyring",
    });
    expect(backend.get).toHaveBeenCalledWith(apiUrl);
  });

  it("rejects an explicitly empty environment key", () => {
    process.env.UPSHARE_API_KEY = "   ";
    expect(() => resolveApiKey(apiUrl, createBackend())).toThrow(
      "UPSHARE_API_KEY must not be empty"
    );
  });

  it("returns undefined when no credential exists", () => {
    expect(resolveApiKey(apiUrl, createBackend())).toBeUndefined();
  });

  it("treats whitespace-only keyring values as absent", () => {
    expect(resolveApiKey(apiUrl, createBackend("   "))).toBeUndefined();
    expect(resolveApiKey(apiUrl, createBackend(""))).toBeUndefined();
  });

  it("trims padded keyring values", () => {
    expect(resolveApiKey(apiUrl, createBackend("  ups_secret  "))).toEqual({
      apiKey: "ups_secret",
      source: "keyring",
    });
  });
});

describe("credential persistence", () => {
  it("stores the credential before committing metadata", () => {
    const backend = createBackend();
    const commitMetadata = vi.fn();

    storeApiKeyWithRollback(apiUrl, "ups_new_secret", commitMetadata, backend);

    expect(backend.set).toHaveBeenCalledWith(apiUrl, "ups_new_secret");
    expect(commitMetadata).toHaveBeenCalledOnce();
    expect(resolveApiKey(apiUrl, backend)?.apiKey).toBe("ups_new_secret");
  });

  it("restores the previous credential when metadata saving fails", () => {
    const backend = createBackend("ups_previous_secret");

    expect(() =>
      storeApiKeyWithRollback(
        apiUrl,
        "ups_new_secret",
        () => {
          throw new Error("metadata failed");
        },
        backend
      )
    ).toThrow("metadata failed");
    expect(resolveApiKey(apiUrl, backend)?.apiKey).toBe("ups_previous_secret");
  });

  it("removes a newly stored credential when metadata saving fails", () => {
    const backend = createBackend();

    expect(() =>
      storeApiKeyWithRollback(
        apiUrl,
        "ups_new_secret",
        () => {
          throw new Error("metadata failed");
        },
        backend
      )
    ).toThrow("metadata failed");
    expect(resolveApiKey(apiUrl, backend)).toBeUndefined();
  });

  it("deletes the stored credential", () => {
    const backend = createBackend("ups_secret");
    expect(deleteStoredApiKey(apiUrl, backend)).toBe(true);
    expect(deleteStoredApiKey(apiUrl, backend)).toBe(false);
  });

  it("discards a corrupt previous credential instead of restoring it", () => {
    const backend = createBackend("   ");
    expect(() =>
      storeApiKeyWithRollback(
        apiUrl,
        "ups_new_secret",
        () => {
          throw new Error("metadata failed");
        },
        backend
      )
    ).toThrow("metadata failed");
    expect(backend.get(apiUrl)).toBeUndefined();
  });

  it("aggregates metadata and rollback failures", () => {
    const backend = createBackend("ups_previous_secret");
    backend.set.mockImplementationOnce(() => undefined);
    backend.set.mockImplementationOnce(() => {
      throw new Error("rollback locked");
    });
    let caught: unknown;
    try {
      storeApiKeyWithRollback(
        apiUrl,
        "ups_new_secret",
        () => {
          throw new Error("metadata failed");
        },
        backend
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toHaveLength(2);
  });

  it("checks store accessibility without swallowing errors", () => {
    const backend = createBackend("ups_secret");
    expect(() =>
      ensureCredentialStoreAccessible(apiUrl, backend)
    ).not.toThrow();
    const failing: CredentialBackend = {
      delete: () => false,
      get: () => {
        throw new Error("Could not read the API key in store.");
      },
      set: () => undefined,
    };
    expect(() => ensureCredentialStoreAccessible(apiUrl, failing)).toThrow(
      "Could not read"
    );
  });

  it("deletes every listed credential with deleteAll", () => {
    const backend: CredentialBackend & { list: () => string[] } = {
      delete: vi.fn((url: string) => url !== "https://missing.example"),
      get: () => undefined,
      list: () => ["https://a.example", "https://missing.example"],
      set: () => undefined,
    };
    const result = deleteAllStoredApiKeys(backend);
    expect(result.deletedApiUrls).toEqual(["https://a.example"]);
    expect(result.failed).toHaveLength(0);
  });

  it("reports per-URL delete failures with deleteAll", () => {
    const backend: CredentialBackend & { list: () => string[] } = {
      delete: () => {
        throw new Error("locked");
      },
      get: () => undefined,
      list: () => ["https://a.example"],
      set: () => undefined,
    };
    const result = deleteAllStoredApiKeys(backend);
    expect(result.deletedApiUrls).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.apiUrl).toBe("https://a.example");
  });
});

describe("native credential backend", () => {
  function injectEntry(instance: {
    deletePassword?: () => boolean;
    getPassword?: () => string | null;
    setPassword?: (value: string) => void;
  }) {
    __setKeyringEntryFactoryForTesting(
      class {
        deletePassword() {
          return instance.deletePassword?.() ?? false;
        }
        getPassword() {
          return instance.getPassword?.() ?? null;
        }
        setPassword(value: string) {
          instance.setPassword?.(value);
        }
      } as never
    );
  }

  it("maps null to undefined and trims padded values", () => {
    injectEntry({ getPassword: () => null });
    expect(nativeCredentialBackend.get(apiUrl)).toBeUndefined();
    injectEntry({ getPassword: () => "   " });
    expect(nativeCredentialBackend.get(apiUrl)).toBeUndefined();
    injectEntry({ getPassword: () => "" });
    expect(nativeCredentialBackend.get(apiUrl)).toBeUndefined();
    injectEntry({ getPassword: () => "  ups_secret  " });
    expect(nativeCredentialBackend.get(apiUrl)).toBe("ups_secret");
  });

  it("wraps read failures with an actionable message", () => {
    injectEntry({
      getPassword: () => {
        throw new Error("locked");
      },
    });
    expect(() => nativeCredentialBackend.get(apiUrl)).toThrow(
      READ_ERROR_PATTERN
    );
  });

  it("wraps a missing Entry export as an access error", () => {
    __setKeyringEntryFactoryForTesting({} as never);
    expect(() => nativeCredentialBackend.get(apiUrl)).toThrow(
      READ_ERROR_PATTERN
    );
  });

  it("hints at logout --all for ambiguous store entries", () => {
    injectEntry({
      getPassword: () => {
        throw new Error("Ambiguous credentials found");
      },
    });
    expect(() => nativeCredentialBackend.get(apiUrl)).toThrow(LOGOUT_ALL_HINT);
  });

  it("lists stored accounts via findCredentials", () => {
    injectEntry({ getPassword: () => null });
    __setFindCredentialsForTesting(() => [
      { account: "https://a.example", password: "x" },
      { account: "https://b.example", password: "y" },
    ]);
    expect(nativeCredentialBackend.list?.()).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });
});

describe("credential presentation", () => {
  it("shows only a fixed prefix and mask", () => {
    expect(getApiKeyPrefix("ups_1234567890")).toBe("ups_1234");
    expect(maskApiKey("ups_1234567890")).toBe("ups_1234********");
  });

  it("matches the server prefix format for live keys", () => {
    expect(getApiKeyPrefix("upshare_live_abcdefghKuud")).toBe(
      "upshare_live_...Kuud"
    );
    expect(maskApiKey("upshare_live_abcdefghKuud")).toBe(
      "upshare_live_...Kuud"
    );
  });

  it("names native credential stores", () => {
    expect(getCredentialStoreName("win32")).toBe("Windows Credential Manager");
    expect(getCredentialStoreName("darwin")).toBe("macOS Keychain");
    expect(getCredentialStoreName("linux")).toBe("Linux Secret Service");
  });
});
