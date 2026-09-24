import { ApiClient } from "./api-client";
import { cleanIdentifier } from "./format";
import { createSpinner } from "./spinner";
import { parseDurationHours } from "./validation";

export const SHARE_MIN_DURATION_HOURS = 0.5;
export const SHARE_DEFAULT_DURATION_HOURS = 24;
export const SHARE_MAX_DURATION_HOURS = 168;

export interface ShareTarget {
  client: ApiClient;
  durationHours: number;
  id: string;
}

export function resolveShareTarget(
  target: string,
  options?: {
    apiUrl?: string;
    duration?: string;
    profile?: string;
  }
): ShareTarget {
  const id = cleanIdentifier(target);
  if (!id) {
    throw new Error("File identifier or share token is required.");
  }
  const durationHours = parseDurationHours(
    options?.duration,
    SHARE_DEFAULT_DURATION_HOURS,
    SHARE_MIN_DURATION_HOURS
  );
  if (durationHours > SHARE_MAX_DURATION_HOURS) {
    throw new Error(
      `Duration must be a number between ${SHARE_MIN_DURATION_HOURS} and ${SHARE_MAX_DURATION_HOURS} hours.`
    );
  }
  const client = new ApiClient({
    apiUrl: options?.apiUrl,
    profile: options?.profile,
  });
  return { client, durationHours, id };
}

export function startShareSpinner(message: string) {
  return createSpinner(message).start();
}
