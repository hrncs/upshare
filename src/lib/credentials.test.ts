import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CredentialBackend,
  deleteStoredApiKey,
  getApiKeyPrefix,
  getCredentialStoreName,
  maskApiKey,
  resolveApiKey,
  storeApiKeyWithRollback,
} from "./credentials";

const apiUrl = "https://upshare.app";

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
