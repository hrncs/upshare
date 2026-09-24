import { spawn } from "node:child_process";
import { RetryableApiError } from "./api-client";
import type { DeviceTokenErrorResponse, DeviceTokenResponse } from "./schemas";
import { wait } from "./wait";

const CONNECTION_BACKOFF_MAX_SECONDS = 60;
const SLOW_DOWN_MAX_SECONDS = 60;

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
      // Intentionally ignored: fire-and-forget; use openBrowserAsync for a result.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function openBrowserAsync(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let command: { args: string[]; file: string };
    try {
      command = getBrowserCommand(url);
    } catch {
      resolve(false);
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.file, command.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0 || code === null));
    child.unref();
  });
}

interface PollDeviceTokenOptions {
  expiresInSeconds: number;
  intervalSeconds: number;
  requestToken: () => Promise<
    | { data: DeviceTokenResponse; status: "success" }
    | { error: DeviceTokenErrorResponse; status: "error" }
  >;
}

function terminalError(
  error: DeviceTokenErrorResponse
): Error & { code: string } {
  const serverDescription = error.error_description;
  let message: string;
  if (error.error === "access_denied") {
    message = serverDescription ?? "Authorization was denied.";
  } else if (error.error === "expired_token") {
    message =
      serverDescription ??
      "Authorization expired. Run the command again to get a new code.";
  } else {
    message =
      serverDescription ?? `Device authorization failed: ${error.error}.`;
  }
  return Object.assign(new Error(message), { code: error.error });
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
      nextIntervalSeconds = Math.min(
        nextIntervalSeconds + 5,
        SLOW_DOWN_MAX_SECONDS
      );
      continue;
    }
    throw terminalError(result.error);
  }

  throw new Error(
    "Authorization expired. Run the command again to get a new code."
  );
}
