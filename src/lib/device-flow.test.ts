import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  generateDeviceState,
  startLoopbackServer,
} from "./device-flow";
import { deviceExchangeResponseSchema } from "./schemas";

const HEX_64_REGEX = /^[a-f0-9]{64}$/;

describe("device-flow", () => {
  it("generates a 64-char hex state", () => {
    const state = generateDeviceState();
    expect(state).toMatch(HEX_64_REGEX);
    expect(generateDeviceState()).not.toBe(state);
  });

  it("receives the browser callback on loopback", async () => {
    const state = generateDeviceState();
    const server = await startLoopbackServer(state, { timeoutMs: 5000 });
    const pending = server.waitForCallback();
    const res = await fetch(
      `http://127.0.0.1:${server.port}/callback?code=code123&state=${state}`
    );
    await res.body?.cancel();
    await expect(pending).resolves.toEqual({ code: "code123", state });
    server.close();
  });

  it("rejects callbacks with the wrong state", async () => {
    const state = generateDeviceState();
    const server = await startLoopbackServer(state, { timeoutMs: 5000 });
    const pending = server.waitForCallback();
    const res = await fetch(
      `http://127.0.0.1:${server.port}/callback?code=code123&state=${"b".repeat(64)}`
    );
    expect(res.status).toBe(400);
    await res.body?.cancel();
    await expect(pending).rejects.toThrow("State mismatch");
    server.close();
  });

  it("builds the authorize URL with port, state, and mode", () => {
    const url = buildAuthorizeUrl(
      "https://upshare.app",
      1234,
      "a".repeat(64),
      "signup"
    );
    expect(url).toBe(
      `https://upshare.app/cli/authorize?mode=signup&port=1234&state=${"a".repeat(64)}`
    );
  });
});

describe("deviceExchangeResponseSchema", () => {
  it("accepts a valid exchange payload", () => {
    const parsed = deviceExchangeResponseSchema.safeParse({
      apiKey: {
        createdAt: new Date().toISOString(),
        id: "key_1",
        keyPrefix: "upshare_live_...abcd",
        name: "Default CLI Key",
      },
      key: `upshare_live_${"x".repeat(32)}`,
      user: { email: "a@b.com", id: "u_1", name: "Test" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a key with the wrong prefix", () => {
    const parsed = deviceExchangeResponseSchema.safeParse({
      apiKey: {
        createdAt: new Date().toISOString(),
        id: "key_1",
        keyPrefix: "bad",
        name: "Default CLI Key",
      },
      key: "sk_wrong",
      user: { email: "a@b.com", id: "u_1", name: "Test" },
    });
    expect(parsed.success).toBe(false);
  });
});
