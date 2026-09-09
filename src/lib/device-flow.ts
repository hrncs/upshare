import { spawn } from "node:child_process";
import { RetryableApiError } from "./api-client";
import type { DeviceTokenErrorResponse, DeviceTokenResponse } from "./schemas";

const CONNECTION_BACKOFF_MAX_SECONDS = 60;

function getBrowserCommand(url: string): { args: string[]; file: string } {
  if (process.platform === "win32") {
    return { args: ["url.dll,FileProtocolHandler", url], file: "rundll32" };
  }
  if (process.platform === "darwin") {
    return { args: [url], file: "open" };
  }
  return { args: [url], file: "xdg-open" };
}

export function openBrowser(url: string): boolean {
  try {
    const command = getBrowserCommand(url);
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => {
      // The URL is always printed, so a missing launcher remains recoverable.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

interface PollDeviceTokenOptions {
  expiresInSeconds: number;
  intervalSeconds: number;
  requestToken: () => Promise<
    | { data: DeviceTokenResponse; status: "success" }
    | { error: DeviceTokenErrorResponse; status: "error" }
  >;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function terminalError(error: DeviceTokenErrorResponse): Error {
  const serverDescription = error.error_description;
  if (error.error === "access_denied") {
    return new Error(serverDescription ?? "Authorization was denied.");
  }
  if (error.error === "expired_token") {
    return new Error(
      serverDescription ??
        "Authorization expired. Run the command again to get a new code."
    );
  }
  return new Error(
    serverDescription ?? `Device authorization failed: ${error.error}.`
  );
}

export async function pollForDeviceToken({
  expiresInSeconds,
  intervalSeconds,
  requestToken,
}: PollDeviceTokenOptions): Promise<DeviceTokenResponse> {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  let nextIntervalSeconds = intervalSeconds;

  while (Date.now() < expiresAt) {
    const remainingMilliseconds = expiresAt - Date.now();
    // biome-ignore lint/performance/noAwaitInLoops: RFC 8628 requires sequential polling.
    await wait(Math.min(nextIntervalSeconds * 1000, remainingMilliseconds));
    if (Date.now() >= expiresAt) {
      break;
    }

    let result: Awaited<ReturnType<typeof requestToken>>;
    try {
      result = await requestToken();
    } catch (error) {
      if (!(error instanceof RetryableApiError)) {
        throw error;
      }
      nextIntervalSeconds = Math.min(
        nextIntervalSeconds * 2,
        CONNECTION_BACKOFF_MAX_SECONDS
      );
      continue;
    }

    if (result.status === "success") {
      return result.data;
    }
    if (result.error.error === "authorization_pending") {
      continue;
    }
    if (result.error.error === "slow_down") {
      nextIntervalSeconds += 5;
      continue;
    }
    throw terminalError(result.error);
  }

  throw new Error(
    "Authorization expired. Run the command again to get a new code."
  );
}
