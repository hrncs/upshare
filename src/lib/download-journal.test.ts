import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDownloadJournal,
  getDownloadWorkPaths,
  loadDownloadState,
  openDownloadJournal,
  removeDownloadWorkFiles,
} from "./download-journal";

let outputDirectory = "";
const PART_FILE_NAME_REGEX = /^\.upshare-[a-f0-9]{24}\.part$/;
const JOURNAL_FILE_NAME_REGEX = /^\.upshare-[a-f0-9]{24}\.resume\.log$/;

const metadata = {
  chunkSize: 64,
  fileId: "file-id",
  fileName: "archive.zip",
  fileSize: 150,
};

beforeEach(() => {
  outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "upshare-download-journal-")
  );
});

afterEach(() => {
  fs.rmSync(outputDirectory, { force: true, recursive: true });
});

describe("download resume journal", () => {
  it("appends, replays, reopens, and removes resume records", () => {
    const paths = getDownloadWorkPaths(outputDirectory, metadata.fileId);
    fs.writeFileSync(paths.partPath, "partial");
    const journal = createDownloadJournal(paths.journalPath, metadata);
    journal.appendEtag('"file-etag"');
    journal.appendCompletedChunk(2);
    journal.close();

    expect(loadDownloadState(paths.journalPath)).toEqual({
      ...metadata,
      completedChunks: [2],
      etag: '"file-etag"',
    });

    const reopened = openDownloadJournal(paths.journalPath);
    reopened.appendCompletedChunk(0);
    reopened.close();
    expect(loadDownloadState(paths.journalPath)?.completedChunks).toEqual([
      2, 0,
    ]);

    removeDownloadWorkFiles(paths);
    expect(fs.existsSync(paths.partPath)).toBe(false);
    expect(loadDownloadState(paths.journalPath)).toBeNull();
  });

  it("uses deterministic safe work-file names", () => {
    const first = getDownloadWorkPaths(outputDirectory, "../../unsafe");
    const second = getDownloadWorkPaths(outputDirectory, "../../unsafe");

    expect(first).toEqual(second);
    expect(path.dirname(first.partPath)).toBe(outputDirectory);
    expect(path.basename(first.partPath)).toMatch(PART_FILE_NAME_REGEX);
    expect(path.basename(first.journalPath)).toMatch(JOURNAL_FILE_NAME_REGEX);
  });

  it("ignores a torn final record", () => {
    const { journalPath } = getDownloadWorkPaths(
      outputDirectory,
      metadata.fileId
    );
    const journal = createDownloadJournal(journalPath, metadata);
    journal.appendCompletedChunk(0);
    journal.close();
    fs.appendFileSync(journalPath, '{"type":"chunk","index":');

    expect(loadDownloadState(journalPath)?.completedChunks).toEqual([0]);
    const resumed = openDownloadJournal(journalPath);
    resumed.appendCompletedChunk(1);
    resumed.close();
    expect(loadDownloadState(journalPath)?.completedChunks).toEqual([0, 1]);
  });

  it("rejects malformed complete records", () => {
    const { journalPath } = getDownloadWorkPaths(
      outputDirectory,
      metadata.fileId
    );
    const journal = createDownloadJournal(journalPath, metadata);
    journal.close();
    fs.appendFileSync(journalPath, "not-json\n");

    expect(() => loadDownloadState(journalPath)).toThrow(
      "Download resume journal is invalid"
    );
  });

  it("rejects duplicate and out-of-range chunks", () => {
    const duplicate = getDownloadWorkPaths(outputDirectory, "duplicate");
    const duplicateJournal = createDownloadJournal(
      duplicate.journalPath,
      metadata
    );
    duplicateJournal.appendCompletedChunk(0);
    duplicateJournal.appendCompletedChunk(0);
    duplicateJournal.close();

    const outOfRange = getDownloadWorkPaths(outputDirectory, "out-of-range");
    const outOfRangeJournal = createDownloadJournal(
      outOfRange.journalPath,
      metadata
    );
    outOfRangeJournal.appendCompletedChunk(3);
    outOfRangeJournal.close();

    expect(() => loadDownloadState(duplicate.journalPath)).toThrow(
      "Download resume journal is invalid"
    );
    expect(() => loadDownloadState(outOfRange.journalPath)).toThrow(
      "Download resume journal is invalid"
    );
  });

  it("rejects a second ETag record", () => {
    const { journalPath } = getDownloadWorkPaths(
      outputDirectory,
      metadata.fileId
    );
    const journal = createDownloadJournal(journalPath, metadata);
    journal.appendEtag('"first"');
    journal.appendEtag('"second"');
    journal.close();

    expect(() => loadDownloadState(journalPath)).toThrow(
      "Download resume journal is invalid"
    );
  });
});
