import { stripVTControlCharacters } from "node:util";

// biome-ignore lint/performance/noBarrelFile: back-compat re-export so existing `format` imports keep working
export { cleanIdentifier } from "./identifiers";

export function sanitizeTerminalText(value: string): string {
  return [...stripVTControlCharacters(value)]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("");
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) {
    return "0 B";
  }
  if (!Number.isFinite(bytes)) {
    return "?";
  }
  if (bytes < 0) {
    throw new Error("Bytes must be a non-negative finite number.");
  }
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    sizes.length - 1,
    Math.floor(Math.log(bytes) / Math.log(k))
  );
  return `${Number.parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${remainingSeconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}

export function formatRelativeTime(dateInput: string | Date): string {
  const target = new Date(dateInput).getTime();
  if (Number.isNaN(target)) {
    return "expired";
  }
  const now = Date.now();
  const diffMs = target - now;

  if (diffMs <= 0) {
    return "expired";
  }

  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    const remHours = diffHours % 24;
    return remHours > 0 ? `${diffDays}d ${remHours}h` : `${diffDays}d`;
  }
  if (diffHours > 0) {
    const remMin = diffMin % 60;
    return remMin > 0 ? `${diffHours}h ${remMin}m` : `${diffHours}h`;
  }
  if (diffMin > 0) {
    return `${diffMin}m`;
  }
  return `${diffSec}s`;
}

export function formatAge(dateInput: string | Date): string {
  const diff = Date.now() - new Date(dateInput).getTime();
  if (Number.isNaN(diff) || diff < 0) {
    return "just now";
  }
  if (diff < 60_000) {
    return "just now";
  }
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months}mo ago`;
  }
  return `${Math.floor(months / 12)}y ago`;
}
