import { stripVTControlCharacters } from "node:util";
import { formatBytes, formatDuration } from "./format";

const PROGRESS_UPDATE_INTERVAL_MS = 200;

interface ProgressOutput {
  columns?: number;
  isTTY?: boolean;
  write: (text: string) => unknown;
}

export interface TransferProgressLine {
  clear: () => void;
  update: (completedBytes: number, networkBytes: number) => void;
}

function availableTextWidth(columns: number): number {
  return Math.max(1, columns - 1);
}

function visibleWidth(text: string): number {
  return stripVTControlCharacters(text).length;
}

export function formatTransferProgressText(
  action: "Downloading" | "Uploading",
  completedBytes: number,
  totalBytes: number,
  bytesPerSecond: number,
  columns = process.stderr.columns ?? 80
): string {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return `${action} ${formatBytes(Math.max(0, completedBytes))}`;
  }
  const percent = (completedBytes / totalBytes) * 100;
  const remainingBytes = Math.max(0, totalBytes - completedBytes);
  const eta =
    bytesPerSecond > 0 ? formatDuration(remainingBytes / bytesPerSecond) : "--";
  const percentage = `${(Number.isFinite(percent) ? percent : 0).toFixed(1)}%`;
  const speed = `${formatBytes(Math.max(0, bytesPerSecond))}/s`;
  const candidates = [
    `${action} ${percentage} (${formatBytes(completedBytes)} / ${formatBytes(totalBytes)}) | ${speed} | ETA ${eta}`,
    `${action} ${percentage} | ${speed} | ETA ${eta}`,
    `${action} ${percentage} | ${speed}`,
    `${action} ${percentage}`,
  ];
  const available = availableTextWidth(columns);
  const matching = candidates.find(
    (candidate) => candidate.length <= available
  );
  if (matching) {
    return matching;
  }
  const shortest = candidates.at(-1) ?? action;
  return available <= 3
    ? ".".repeat(available)
    : `${shortest.slice(0, available - 3)}...`;
}

export function createTransferProgressLine(options: {
  action: "Downloading" | "Uploading";
  output?: ProgressOutput;
  startedAt: number;
  totalBytes: number;
}): TransferProgressLine {
  const output = options.output ?? process.stderr;
  let lastRenderedAt: number | undefined;
  let renderedWidth = 0;

  return {
    clear() {
      if (!(output.isTTY && renderedWidth > 0)) {
        return;
      }
      output.write(`\r${" ".repeat(renderedWidth)}\r`);
      renderedWidth = 0;
    },
    update(completedBytes, networkBytes) {
      if (!output.isTTY) {
        return;
      }
      const now = Date.now();
      const isComplete = completedBytes >= options.totalBytes;
      if (
        !isComplete &&
        lastRenderedAt !== undefined &&
        now - lastRenderedAt < PROGRESS_UPDATE_INTERVAL_MS
      ) {
        return;
      }
      lastRenderedAt = now;
      const elapsedSeconds = Math.max((now - options.startedAt) / 1000, 0.1);

      const text = formatTransferProgressText(
        options.action,
        completedBytes,
        options.totalBytes,
        networkBytes / elapsedSeconds,
        output.columns ?? 80
      );
      output.write(`\r${text.padEnd(renderedWidth)}`);
      renderedWidth = visibleWidth(text);
    },
  };
}
