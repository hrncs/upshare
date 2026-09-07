import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getConfigPaths } from "./config";

const uploadStateSchema = z.strictObject({
  apiUrl: z.url(),
  fileId: z.string().min(1),
  filePath: z.string().min(1),
  fileSize: z.number().int().positive().safe(),
  modifiedAt: z.number().nonnegative().finite(),
});

export type UploadState = z.infer<typeof uploadStateSchema>;

function getStateFile(apiUrl: string, filePath: string): string {
  const key = createHash("sha256")
    .update(apiUrl)
    .update("\0")
    .update(filePath)
    .digest("hex");
  return path.join(getConfigPaths().configDirectory, "uploads", `${key}.json`);
}

export function loadUploadState(
  expected: Omit<UploadState, "fileId">,
  options?: { onInvalidated?: (reason: "modified" | "corrupt") => void }
): UploadState | null {
  const stateFile = getStateFile(expected.apiUrl, expected.filePath);
  try {
    const value: unknown = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const parsed = uploadStateSchema.safeParse(value);
    if (!parsed.success) {
      fs.unlinkSync(stateFile);
      options?.onInvalidated?.("corrupt");
      return null;
    }
    const state = parsed.data;
    const matches =
      state.apiUrl === expected.apiUrl &&
      state.filePath === expected.filePath &&
      state.fileSize === expected.fileSize &&
      state.modifiedAt === expected.modifiedAt;
    if (!matches) {
      fs.unlinkSync(stateFile);
      options?.onInvalidated?.("modified");
      return null;
    }
    return state;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export function saveUploadState(state: UploadState): void {
  const stateFile = getStateFile(state.apiUrl, state.filePath);
  const stateDirectory = path.dirname(stateFile);
  fs.mkdirSync(stateDirectory, { mode: 0o700, recursive: true });
  fs.chmodSync(stateDirectory, 0o700);
  const temporaryFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(
      temporaryFile,
      `${JSON.stringify(uploadStateSchema.parse(state))}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
    fs.renameSync(temporaryFile, stateFile);
    fs.chmodSync(stateFile, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryFile);
    } catch {}
    throw error;
  }
}

export function clearUploadState(apiUrl: string, filePath: string): void {
  try {
    fs.unlinkSync(getStateFile(apiUrl, filePath));
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
}
