const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
const INTEGER_PATTERN = /^\d+$/;

export function parseDurationHours(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum = 168
): number {
  if (value === undefined) {
    return fallback;
  }
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new Error(
      `Duration must be a number between ${minimum} and ${maximum} hours.`
    );
  }
  const duration = Number(trimmed);
  if (
    !(Number.isFinite(duration) && duration >= minimum && duration <= maximum)
  ) {
    throw new Error(
      `Duration must be a number between ${minimum} and ${maximum} hours.`
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
  const trimmed = value.trim();
  if (!INTEGER_PATTERN.test(trimmed)) {
    throw new Error(
      `${label} must be a whole number between ${minimum} and ${maximum}.`
    );
  }
  const parsed = Number(trimmed);
  if (
    !(Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum)
  ) {
    throw new Error(
      `${label} must be a whole number between ${minimum} and ${maximum}.`
    );
  }
  return parsed;
}
