import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_PROFILE, getConfigPaths } from "./config";
import { printWarning } from "./output";

const uploadStateSchema = z.strictObject({
  apiUrl: z.url(),
  fileId: z.string().min(1),
  filePath: z.string().min(1),
  fileSize: z.number().int().positive().safe(),
  modifiedAt: z.number().nonnegative().finite(),
  profile: z.string().min(1).max(64),
});
const legacyUploadStateSchema = uploadStateSchema.omit({ profile: true });

export type UploadState = z.infer<typeof uploadStateSchema>;
export type ExpectedUploadState = Omit<UploadState, "fileId">;

function hashStateKey(parts: string[]): string {
  const hash = createHash("sha256");
  for (const [index, part] of parts.entries()) {
    if (index > 0) {
      hash.update("\0");
    }
    hash.update(part);
  }
  return hash.digest("hex");
}

function getStateFile(
  profile: string,
  apiUrl: string,
  filePath: string
): string {
  const key = hashStateKey([profile, apiUrl, filePath]);
  return path.join(getConfigPaths().configDirectory, "uploads", `${key}.json`);
}

function getLegacyStateFile(apiUrl: string, filePath: string): string {
  const key = hashStateKey([apiUrl, filePath]);
  return path.join(getConfigPaths().configDirectory, "uploads", `${key}.json`);
}

function stateMatches(
  state: Omit<UploadState, "fileId" | "profile">,
  expected: ExpectedUploadState
): boolean {
  return (
    state.apiUrl === expected.apiUrl &&
    state.filePath === expected.filePath &&
    state.fileSize === expected.fileSize &&
    state.modifiedAt === expected.modifiedAt
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: resume-state matching across current/legacy schemas
function readMatchingState(
  stateFile: string,
  expected: ExpectedUploadState,
  options?: { onInvalidated?: (reason: "modified" | "corrupt") => void }
): UploadState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    printWarning(
      `Could not read upload resume state at ${stateFile}: ${error instanceof Error ? error.message : "unknown error"}. Continuing without resume.`
    );
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    try {
      fs.unlinkSync(stateFile);
    } catch (unlinkError) {
      if (
        !(
          unlinkError instanceof Error &&
          "code" in unlinkError &&
          unlinkError.code === "ENOENT"
        )
      ) {
        throw unlinkError;
      }
    }
    options?.onInvalidated?.("corrupt");
    return null;
  }
  const parsed = uploadStateSchema.safeParse(value);
  let state: UploadState | null = null;
  if (parsed.success === true) {
    state = parsed.data;
  } else {
    const legacyParsed = legacyUploadStateSchema.safeParse(value);
    if (legacyParsed.success === true) {
      state = { ...legacyParsed.data, profile: expected.profile };
    }
  }
  if (
    !(state && stateMatches(state, expected)) ||
    (parsed.success === true && parsed.data.profile !== expected.profile)
  ) {
    try {
      fs.unlinkSync(stateFile);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }
    options?.onInvalidated?.(state ? "modified" : "corrupt");
    return null;
  }
  return state;
}

export function loadUploadState(
  expected: ExpectedUploadState,
  options?: { onInvalidated?: (reason: "modified" | "corrupt") => void }
): UploadState | null {
  const scoped = readMatchingState(
    getStateFile(expected.profile, expected.apiUrl, expected.filePath),
    expected,
    options
  );
  if (scoped || expected.profile !== DEFAULT_PROFILE) {
    return scoped;
  }
  const legacyFile = getLegacyStateFile(expected.apiUrl, expected.filePath);
  const legacy = readMatchingState(legacyFile, expected, options);
  if (!legacy) {
    return null;
  }
  const migrated: UploadState = { ...legacy, profile: DEFAULT_PROFILE };
  try {
    saveUploadState(migrated);
    fs.unlinkSync(legacyFile);
  } catch (error) {
    printWarning(
      `Could not migrate legacy upload resume state: ${error instanceof Error ? error.message : "unknown error"}.`
    );
  }
  return migrated;
}

export function saveUploadState(state: UploadState): void {
  const stateFile = getStateFile(state.profile, state.apiUrl, state.filePath);
  const stateDirectory = path.dirname(stateFile);
  fs.mkdirSync(stateDirectory, { mode: 0o700, recursive: true });
  fs.chmodSync(stateDirectory, 0o700);
  const temporaryFile = `${stateFile}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const descriptor = fs.openSync(temporaryFile, "wx", 0o600);
    try {
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify(uploadStateSchema.parse(state))}\n`,
        { encoding: "utf8" }
      );
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryFile, stateFile);
    fs.chmodSync(stateFile, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryFile);
    } catch {
      // Intentionally ignored: temp-file cleanup is best-effort.
    }
    throw error;
  }
}

function unlinkQuietly(stateFile: string): void {
  try {
    fs.unlinkSync(stateFile);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
}

export function clearUploadState(
  profile: string,
  apiUrl: string,
  filePath: string
): void {
  unlinkQuietly(getStateFile(profile, apiUrl, filePath));
  if (profile === DEFAULT_PROFILE) {
    unlinkQuietly(getLegacyStateFile(apiUrl, filePath));
  }
}
