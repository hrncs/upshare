import { afterEach, describe, expect, it, vi } from "vitest";
import { RetryableApiError } from "./api-client";
import { pollForDeviceToken } from "./device-flow";
import {
  type DeviceTokenResponse,
  deviceAuthorizationResponseSchema,
  deviceTokenResponseSchema,
} from "./schemas";

const token: DeviceTokenResponse = {
  access_token: `upshare_live_${"x".repeat(32)}`,
  api_key: {
    createdAt: new Date().toISOString(),
    id: "key_1",
    keyPrefix: "upshare_live_...xxxx",
    name: "UpShare CLI",
  },
  token_type: "Bearer",
  user: { email: "a@b.com", id: "u_1", name: "Test" },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("pollForDeviceToken", () => {
  it("waits for the advertised interval and continues while pending", async () => {
    vi.useFakeTimers();
    const requestToken = vi
      .fn()
      .mockResolvedValueOnce({
        error: { error: "authorization_pending" },
        status: "error",
      })
      .mockResolvedValueOnce({ data: token, status: "success" });
    const pending = pollForDeviceToken({
      expiresInSeconds: 30,
      intervalSeconds: 5,
      requestToken,
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(requestToken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(requestToken).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toEqual(token);
    expect(requestToken).toHaveBeenCalledTimes(2);
  });

  it("adds five seconds after a slow_down response", async () => {
    vi.useFakeTimers();
    const requestToken = vi
      .fn()
      .mockResolvedValueOnce({
        error: { error: "slow_down" },
        status: "error",
      })
      .mockResolvedValueOnce({ data: token, status: "success" });
    const pending = pollForDeviceToken({
      expiresInSeconds: 30,
      intervalSeconds: 5,
      requestToken,
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(9999);
    expect(requestToken).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual(token);
  });

  it("backs off after connection failures", async () => {
    vi.useFakeTimers();
    const requestToken = vi
      .fn()
      .mockRejectedValueOnce(
        new RetryableApiError("timed out", {
          cause: new Error("timeout"),
        })
      )
      .mockResolvedValueOnce({ data: token, status: "success" });
    const pending = pollForDeviceToken({
      expiresInSeconds: 30,
      intervalSeconds: 5,
      requestToken,
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual(token);
  });

  it("stops when authorization expires", async () => {
    vi.useFakeTimers();
    const requestToken = vi.fn();
    const pending = pollForDeviceToken({
      expiresInSeconds: 5,
      intervalSeconds: 5,
      requestToken,
    });
    const rejection = expect(pending).rejects.toThrow("Authorization expired");

    await vi.advanceTimersByTimeAsync(5000);

    await rejection;
    expect(requestToken).not.toHaveBeenCalled();
  });

  it("stops polling when the device grant is invalid or already used", async () => {
    vi.useFakeTimers();
    const requestToken = vi.fn().mockResolvedValue({
      error: {
        error: "invalid_grant",
        error_description:
          "The device authorization is invalid or already used.",
      },
      status: "error",
    });
    const pending = pollForDeviceToken({
      expiresInSeconds: 30,
      intervalSeconds: 5,
      requestToken,
    });
    const rejection = expect(pending).rejects.toThrow(
      "The device authorization is invalid or already used."
    );

    await vi.advanceTimersByTimeAsync(5000);

    await rejection;
    expect(requestToken).toHaveBeenCalledOnce();
  });
});

describe("device authorization response schemas", () => {
  it("accepts standards-shaped authorization and token responses", () => {
    const authorization = deviceAuthorizationResponseSchema.safeParse({
      device_code: "a".repeat(43),
      expires_in: 600,
      interval: 5,
      user_code: "ABCD-EFGH-JKMN-PQRS",
      verification_uri: "https://upshare.app/cli/authorize",
      verification_uri_complete:
        "https://upshare.app/cli/authorize?user_code=ABCD-EFGH-JKMN-PQRS",
    });

    expect(authorization.success).toBe(true);
    expect(deviceTokenResponseSchema.safeParse(token).success).toBe(true);
  });

  it("rejects malformed token responses", () => {
    const parsed = deviceTokenResponseSchema.safeParse({
      ...token,
      access_token: "wrong_prefix",
    });

    expect(parsed.success).toBe(false);
  });
});
