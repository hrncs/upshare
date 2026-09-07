import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const metadataSchema = z.strictObject({
  chunkSize: z.number().int().positive().safe(),
  fileId: z.string().min(1),
  fileName: z.string().min(1),
  fileSize: z.number().int().positive().safe(),
});

const headerSchema = metadataSchema.extend({
  type: z.literal("header"),
  version: z.literal(1),
});

const eventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("etag"),
    value: z.string().min(1).max(512),
  }),
  z.strictObject({
    index: z.number().int().nonnegative().safe(),
    type: z.literal("chunk"),
  }),
]);

const stateSchema = metadataSchema.extend({
  completedChunks: z.array(z.number().int().nonnegative().safe()),
  etag: z.string().min(1).max(512).optional(),
});

export type DownloadJournalMetadata = z.infer<typeof metadataSchema>;
export type DownloadState = z.infer<typeof stateSchema>;

export interface DownloadWorkPaths {
  journalPath: string;
  partPath: string;
}

function invalidJournal(journalPath: string, cause?: unknown): Error {
  return new Error(`Download resume journal is invalid: ${journalPath}`, {
    cause,
  });
}

function writeRecord(descriptor: number, value: unknown): void {
  const record = Buffer.from(`${JSON.stringify(value)}\n`);
  let offset = 0;
  while (offset < record.byteLength) {
    const written = fs.writeSync(
      descriptor,
      record,
      offset,
      record.byteLength - offset
    );
    if (written === 0) {
      throw new Error("Could not append to the download resume journal.");
    }
    offset += written;
  }
}

function parseRecord(line: string, journalPath: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw invalidJournal(journalPath, error);
  }
}

export class DownloadJournal {
  #descriptor: number | undefined;
  readonly #journalPath: string;

  constructor(journalPath: string, descriptor: number) {
    this.#journalPath = journalPath;
    this.#descriptor = descriptor;
  }

  appendCompletedChunk(index: number): void {
    const parsed = eventSchema.safeParse({ index, type: "chunk" });
    if (!parsed.success) {
      throw invalidJournal(this.#journalPath);
    }
    this.#append(parsed.data);
  }

  appendEtag(value: string): void {
    const parsed = eventSchema.safeParse({ type: "etag", value });
    if (!parsed.success) {
      throw invalidJournal(this.#journalPath);
    }
    this.#append(parsed.data);
  }

  close(): void {
    if (this.#descriptor === undefined) {
      return;
    }
    fs.closeSync(this.#descriptor);
    this.#descriptor = undefined;
  }

  #append(record: z.infer<typeof eventSchema>): void {
    if (this.#descriptor === undefined) {
      throw new Error(
        `Download resume journal is closed: ${this.#journalPath}`
      );
    }
    writeRecord(this.#descriptor, record);
  }
}

export function getDownloadWorkPaths(
  outputDirectory: string,
  fileId: string
): DownloadWorkPaths {
  const key = createHash("sha256").update(fileId).digest("hex").slice(0, 24);
  return {
    journalPath: path.join(outputDirectory, `.upshare-${key}.resume.log`),
    partPath: path.join(outputDirectory, `.upshare-${key}.part`),
  };
}

export function createDownloadJournal(
  journalPath: string,
  metadata: DownloadJournalMetadata
): DownloadJournal {
  const parsed = headerSchema.safeParse({
    ...metadata,
    type: "header",
    version: 1,
  });
  if (!parsed.success) {
    throw invalidJournal(journalPath);
  }

  const descriptor = fs.openSync(journalPath, "wx", 0o600);
  try {
    writeRecord(descriptor, parsed.data);
    return new DownloadJournal(journalPath, descriptor);
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function openDownloadJournal(journalPath: string): DownloadJournal {
  const contents = fs.readFileSync(journalPath);
  const finalNewline = contents.lastIndexOf(0x0a);
  if (finalNewline < 0) {
    throw invalidJournal(journalPath);
  }
  if (finalNewline !== contents.byteLength - 1) {
    fs.truncateSync(journalPath, finalNewline + 1);
  }
  return new DownloadJournal(journalPath, fs.openSync(journalPath, "a"));
}

export function loadDownloadState(journalPath: string): DownloadState | null {
  let serialized: string;
  try {
    serialized = fs.readFileSync(journalPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const lines = serialized.split("\n");
  lines.pop();
  if (lines.length === 0) {
    throw invalidJournal(journalPath);
  }

  const headerValue = parseRecord(lines[0] ?? "", journalPath);
  const header = headerSchema.safeParse(headerValue);
  if (!header.success) {
    throw invalidJournal(journalPath);
  }

  const completedChunks = new Set<number>();
  const chunkCount = Math.ceil(header.data.fileSize / header.data.chunkSize);
  let etag: string | undefined;

  for (const line of lines.slice(1)) {
    const eventValue = parseRecord(line, journalPath);
    const event = eventSchema.safeParse(eventValue);
    if (!event.success) {
      throw invalidJournal(journalPath);
    }
    if (event.data.type === "etag") {
      if (etag !== undefined) {
        throw invalidJournal(journalPath);
      }
      etag = event.data.value;
      continue;
    }
    if (
      event.data.index >= chunkCount ||
      completedChunks.has(event.data.index)
    ) {
      throw invalidJournal(journalPath);
    }
    completedChunks.add(event.data.index);
  }

  const state = stateSchema.safeParse({
    chunkSize: header.data.chunkSize,
    completedChunks: [...completedChunks],
    etag,
    fileId: header.data.fileId,
    fileName: header.data.fileName,
    fileSize: header.data.fileSize,
  });
  if (!state.success) {
    throw invalidJournal(journalPath);
  }
  return state.data;
}

export function removeDownloadWorkFiles(paths: DownloadWorkPaths): void {
  for (const filePath of [paths.partPath, paths.journalPath]) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
