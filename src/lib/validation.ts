export function parseDurationHours(
  value: string | undefined,
  fallback: number,
  minimum: number
): number {
  if (value === undefined) {
    return fallback;
  }
  const duration = Number(value);
  if (!(Number.isFinite(duration) && duration >= minimum && duration <= 168)) {
    throw new Error(
      `Duration must be a number between ${minimum} and 168 hours.`
    );
  }
  return duration;
}

export function parseIntegerRange(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (
    !(Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum)
  ) {
    throw new Error(
      `${label} must be a whole number between ${minimum} and ${maximum}.`
    );
  }
  return parsed;
}
