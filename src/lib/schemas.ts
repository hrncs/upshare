import { z } from "zod";
import { sanitizeTerminalText } from "./format";

const dateString = z.iso.datetime({ offset: true });
const byteCount = z.number().int().nonnegative().safe();
const fileStatus = z.enum(["uploading", "active", "deleting", "deleted"]);
const displayText = z.string().min(1).transform(sanitizeTerminalText);
const isSafeFileName = (name: string) =>
  ![...name].some((character) => {
    const code = character.charCodeAt(0);
    return character === "/" || character === "\\" || code < 32 || code === 127;
  });
const safeFileName = z
  .string()
  .min(1)
  .max(255)
  .refine(isSafeFileName)
  .refine((name) => name !== "." && name !== "..")
  .transform(sanitizeTerminalText);

export const quotaSchema = z.object({
  isLegacy: z.boolean().optional(),
  maxQuotaBytes: byteCount,
  periodKey: z.string().regex(/^\d{4}-\d{2}$/),
  remainingBytes: byteCount.optional(),
  reservedBytes: byteCount.default(0),
  usedBytes: byteCount,
});

export const whoamiResponseSchema = z.object({
  authType: z.string(),
  quota: quotaSchema.extend({ remainingBytes: byteCount }),
  user: z.object({
    email: z.email().transform(sanitizeTerminalText),
    id: z.string().min(1),
    name: displayText,
  }),
});

const healthCheckSchema = z.object({
  latencyMs: z.number().int().nonnegative().optional(),
  status: z.string().min(1),
});

export const healthResponseSchema = z.object({
  status: z.string().min(1),
  checks: z
    .object({
      database: healthCheckSchema,
      storage: healthCheckSchema,
    })
    .optional(),
});

const uploadPreparationBase = {
  expiresAt: dateString,
  fileId: z.string().min(1),
};
const uploadRequestResponseUnion = z.discriminatedUnion("uploadType", [
  z.object({
    ...uploadPreparationBase,
    uploadType: z.literal("single"),
    uploadUrl: z.url(),
  }),
  z.object({
    ...uploadPreparationBase,
    partCount: z.number().int().min(2).max(10_000),
    partSize: byteCount.positive(),
    uploadType: z.literal("multipart"),
  }),
]);
export const uploadRequestResponseSchema = z.preprocess((input) => {
  if (
    input &&
    typeof input === "object" &&
    !("uploadType" in input) &&
    "uploadUrl" in input
  ) {
    return { ...input, uploadType: "single" };
  }
  return input;
}, uploadRequestResponseUnion);

export const uploadPartUrlsResponseSchema = z.object({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(10_000),
        uploadUrl: z.url(),
      })
    )
    .min(1)
    .max(16),
});

export const multipartResumeResponseSchema = z.object({
  ...uploadPreparationBase,
  partCount: z.number().int().min(2).max(10_000),
  partSize: byteCount.positive(),
  storageCompleted: z.boolean(),
  uploadedParts: z.array(
    z.object({
      etag: z.string().min(1).max(256),
      partNumber: z.number().int().min(1).max(10_000),
      size: byteCount,
    })
  ),
  uploadType: z.literal("multipart"),
});

const publicFileSchema = z.object({
  createdAt: dateString,
  expiresAt: dateString,
  fileName: safeFileName,
  fileSize: byteCount,
  id: z.string().min(1),
  mimeType: z.string().min(1),
  status: fileStatus,
});

const shareLinkSchema = z.object({
  expiresAt: dateString,
  id: z.string().min(1),
  shareUrl: z.url(),
  token: z.string().min(1),
  viewsCount: z.number().int().nonnegative(),
});

export const completeUploadResponseSchema = z.object({
  file: publicFileSchema,
  shareLink: shareLinkSchema.nullish(),
  shareUrl: z.url().nullish(),
  success: z.boolean(),
});

export const listFilesResponseSchema = z.object({
  files: z.array(
    publicFileSchema.extend({ shareLink: shareLinkSchema.nullable() })
  ),
  hasMore: z.boolean(),
  page: z.number().int().positive().safe(),
  pageSize: z.number().int().positive().max(500).safe(),
  quota: quotaSchema.pick({
    maxQuotaBytes: true,
    periodKey: true,
    reservedBytes: true,
    usedBytes: true,
  }),
  sort: z.literal("newest"),
  totalFiles: byteCount,
});

export const shareResponseSchema = z.object({
  capped: z.boolean(),
  expiresAt: dateString,
  fileExpiresAt: dateString,
  fileId: z.string().min(1),
  fileName: safeFileName.optional(),
  id: z.string().min(1).optional(),
  shareUrl: z.url(),
  token: z.string().min(1),
  viewsCount: z.number().int().nonnegative().optional(),
});

export const deleteFileResponseSchema = z.object({
  fileId: z.string().min(1),
  fileName: safeFileName,
  success: z.literal(true),
});

export const fileInfoResponseSchema = z.object({
  file: publicFileSchema,
  shareLink: shareLinkSchema.nullable(),
});

export const renameFileResponseSchema = z.object({
  expiresAt: dateString,
  fileId: z.string().min(1),
  fileName: safeFileName,
  success: z.literal(true),
});

export const revokeShareResponseSchema = z.object({ success: z.literal(true) });

const apiKeyItemSchema = z.object({
  createdAt: dateString,
  id: z.string().min(1),
  keyPrefix: z.string().min(1),
  lastUsedAt: dateString.nullable(),
  name: z.string().min(1),
});

export const listApiKeysResponseSchema = z.object({
  apiKeys: z.array(apiKeyItemSchema),
  currentKeyId: z.string().min(1).nullable().optional(),
});

export const renameApiKeyResponseSchema = z.object({
  apiKey: apiKeyItemSchema,
});

export const deviceExchangeResponseSchema = z.object({
  apiKey: z.object({
    createdAt: dateString,
    id: z.string().min(1),
    keyPrefix: z.string().min(1),
    name: z.string().min(1),
  }),
  key: z.string().min(1).startsWith("upshare_live_"),
  user: z.object({
    email: z.email().transform(sanitizeTerminalText),
    id: z.string().min(1),
    name: displayText,
  }),
});

export const downloadResponseSchema = z.object({
  downloadUrl: z.url(),
  expiresAt: dateString,
  fileId: z.string().min(1),
  fileName: safeFileName,
  fileSize: byteCount,
  mimeType: z.string().min(1),
});

export type WhoamiResponse = z.infer<typeof whoamiResponseSchema>;
export type DeviceExchangeResponse = z.infer<
  typeof deviceExchangeResponseSchema
>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type UploadRequestResponse = z.infer<typeof uploadRequestResponseSchema>;
export interface CompletedUploadPart {
  etag: string;
  partNumber: number;
}
export type UploadPartUrl = z.infer<
  typeof uploadPartUrlsResponseSchema
>["parts"][number];
export type MultipartResumeResponse = z.infer<
  typeof multipartResumeResponseSchema
>;
export type CompleteUploadResponse = z.infer<
  typeof completeUploadResponseSchema
>;
export type UserFileItem = z.infer<
  typeof listFilesResponseSchema
>["files"][number];
export type ListFilesResponse = z.infer<typeof listFilesResponseSchema>;
export type ShareResponse = z.infer<typeof shareResponseSchema>;
export type DeleteFileResponse = z.infer<typeof deleteFileResponseSchema>;
export type FileInfoResponse = z.infer<typeof fileInfoResponseSchema>;
export type RenameFileResponse = z.infer<typeof renameFileResponseSchema>;
export type DownloadResponse = z.infer<typeof downloadResponseSchema>;
export type ApiKeyItem = z.infer<typeof apiKeyItemSchema>;
export type ListApiKeysResponse = z.infer<typeof listApiKeysResponseSchema>;
export type RenameApiKeyResponse = z.infer<typeof renameApiKeyResponseSchema>;
