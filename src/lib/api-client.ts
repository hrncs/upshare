import { z } from "zod";
import { getEffectiveApiUrl } from "./config";
import { resolveApiKey } from "./credentials";
import { cleanIdentifier, sanitizeTerminalText } from "./format";
import type {
  CompletedUploadPart,
  CompleteUploadResponse,
  DeleteFileResponse,
  DeviceExchangeResponse,
  DownloadResponse,
  FileInfoResponse,
  HealthResponse,
  ListApiKeysResponse,
  ListFilesResponse,
  MultipartResumeResponse,
  RenameApiKeyResponse,
  RenameFileResponse,
  ShareResponse,
  UploadPartUrl,
  UploadRequestResponse,
  WhoamiResponse,
} from "./schemas";
import {
  completeUploadResponseSchema,
  deleteFileResponseSchema,
  deviceExchangeResponseSchema,
  downloadResponseSchema,
  fileInfoResponseSchema,
  healthResponseSchema,
  listApiKeysResponseSchema,
  listFilesResponseSchema,
  multipartResumeResponseSchema,
  renameApiKeyResponseSchema,
  renameFileResponseSchema,
  revokeShareResponseSchema,
  shareResponseSchema,
  uploadPartUrlsResponseSchema,
  uploadRequestResponseSchema,
  whoamiResponseSchema,
} from "./schemas";

export interface CompleteUploadOptions {
  createShareLink?: boolean;
  parts?: CompletedUploadPart[];
  shareDurationHours?: number;
}

const API_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 8000;
const FINALIZE_TIMEOUT_MS = 10 * 60 * 1000;
const FINALIZE_RETRY_DELAY_MS = 1000;

function waitBeforeFinalizeRetry(attempt: number): Promise<void> {
  const delay = FINALIZE_RETRY_DELAY_MS * 2 ** (attempt - 1);
  return new Promise((resolve) => setTimeout(resolve, delay));
}
const LEGACY_SINGLE_UPLOAD_LIMIT_BYTES = 5_363_466_240;
export const FILE_LIST_PAGE_SIZE = 20;
const apiErrorSchema = z.object({ error: z.string().min(1).optional() });

async function responseError(response: Response, fallback: string) {
  const body: unknown = await response.json().catch(() => null);
  const parsed = apiErrorSchema.safeParse(body);
  return new Error(
    parsed.success && parsed.data.error
      ? sanitizeTerminalText(parsed.data.error)
      : fallback
  );
}

async function parseResponse<T>(
  response: Response,
  schema: z.ZodType<T>
): Promise<T> {
  const body: unknown = await response.json().catch(() => {
    throw new Error("The UpShare API returned invalid JSON.");
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error("The UpShare API returned an unexpected response.");
  }
  return parsed.data;
}

export class ApiClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly credentialError: Error | undefined;

  constructor(options?: { apiKey?: string; apiUrl?: string }) {
    this.apiUrl = getEffectiveApiUrl(options?.apiUrl);

    if (options?.apiKey) {
      this.apiKey = options.apiKey;
      this.credentialError = undefined;
      return;
    }

    try {
      this.apiKey = resolveApiKey(this.apiUrl)?.apiKey ?? "";
      this.credentialError = undefined;
    } catch (error) {
      this.apiKey = "";
      this.credentialError =
        error instanceof Error
          ? error
          : new Error("Could not access stored API credentials.");
    }
  }

  private getHeaders(apiKey = this.apiKey): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
  }

  private ensureAuth(): void {
    if (this.credentialError) {
      throw this.credentialError;
    }
    if (!this.apiKey) {
      throw new Error(
        "Not logged in. Run `upshare login` or set UPSHARE_API_KEY."
      );
    }
  }

  private async fetch(
    path: string,
    init?: RequestInit,
    timeoutMs = API_TIMEOUT_MS
  ): Promise<Response> {
    try {
      return await fetch(`${this.apiUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");
      throw new Error(
        timedOut
          ? `Request to ${this.apiUrl} timed out.`
          : `Could not connect to ${this.apiUrl}.`,
        { cause: error }
      );
    }
  }

  async verifyApiKey(key?: string): Promise<WhoamiResponse> {
    const activeKey = key || this.apiKey;
    if (!activeKey) {
      if (this.credentialError) {
        throw this.credentialError;
      }
      throw new Error(
        "No API key provided. Run `upshare login` or set UPSHARE_API_KEY."
      );
    }
    const response = await this.fetch("/api/cli/whoami", {
      headers: this.getHeaders(activeKey),
    });
    if (!response.ok) {
      throw await responseError(
        response,
        `Authentication failed (${response.status})`
      );
    }
    return parseResponse(response, whoamiResponseSchema);
  }

  async exchangeDeviceCode(
    code: string,
    state: string,
    name?: string
  ): Promise<DeviceExchangeResponse> {
    if (!(code && state)) {
      throw new Error("Invalid browser callback. Run the command again.");
    }
    const response = await this.fetch("/api/cli/device/exchange", {
      body: JSON.stringify(name ? { code, name, state } : { code, state }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      throw await responseError(
        response,
        `Sign-in exchange failed (${response.status})`
      );
    }
    return parseResponse(response, deviceExchangeResponseSchema);
  }

  async checkHealth(): Promise<HealthResponse> {
    const response = await this.fetch(
      "/api/health",
      undefined,
      HEALTH_TIMEOUT_MS
    );
    if (!response.ok && response.status !== 503) {
      throw await responseError(
        response,
        `Health check failed (${response.status})`
      );
    }
    return parseResponse(response, healthResponseSchema);
  }

  async requestUpload(params: {
    expiryHours?: number;
    fileName: string;
    fileSize: number;
    mimeType?: string;
  }): Promise<UploadRequestResponse> {
    this.ensureAuth();
    let response = await this.fetch("/api/files/upload-request", {
      body: JSON.stringify({ ...params, supportsMultipart: true }),
      headers: this.getHeaders(),
      method: "POST",
    });
    if (
      response.status === 400 &&
      params.fileSize <= LEGACY_SINGLE_UPLOAD_LIMIT_BYTES
    ) {
      await response.body?.cancel();
      response = await this.fetch("/api/files/upload-request", {
        body: JSON.stringify(params),
        headers: this.getHeaders(),
        method: "POST",
      });
    }
    if (!response.ok) {
      throw await responseError(
        response,
        `Upload request failed (${response.status})`
      );
    }
    return parseResponse(response, uploadRequestResponseSchema);
  }

  completeUpload(
    fileId: string,
    options?: CompleteUploadOptions
  ): Promise<CompleteUploadResponse> {
    return this.completeUploadAttempt(fileId, options, 1);
  }

  private async completeUploadAttempt(
    fileId: string,
    options: CompleteUploadOptions | undefined,
    attempt: number
  ): Promise<CompleteUploadResponse> {
    this.ensureAuth();
    let response: Response;
    try {
      response = await this.fetch(
        "/api/files/upload-complete",
        {
          body: JSON.stringify({
            createShareLink: options?.createShareLink,
            fileId,
            parts: options?.parts,
            shareDurationHours: options?.shareDurationHours,
          }),
          headers: this.getHeaders(),
          method: "POST",
        },
        FINALIZE_TIMEOUT_MS
      );
    } catch (error) {
      if (attempt < 3) {
        await waitBeforeFinalizeRetry(attempt);
        return this.completeUploadAttempt(fileId, options, attempt + 1);
      }
      throw error;
    }
    if (!response.ok) {
      if (response.status >= 500 && attempt < 3) {
        await response.body?.cancel();
        await waitBeforeFinalizeRetry(attempt);
        return this.completeUploadAttempt(fileId, options, attempt + 1);
      }
      throw await responseError(
        response,
        `Failed to finalize upload (${response.status})`
      );
    }
    return parseResponse(response, completeUploadResponseSchema);
  }

  async requestUploadPartUrls(
    fileId: string,
    partNumbers: number[]
  ): Promise<UploadPartUrl[]> {
    this.ensureAuth();
    const response = await this.fetch(
      `/api/files/${encodeURIComponent(fileId)}/upload-parts`,
      {
        body: JSON.stringify({ partNumbers }),
        headers: this.getHeaders(),
        method: "POST",
      }
    );
    if (!response.ok) {
      throw await responseError(
        response,
        `Failed to prepare upload parts (${response.status})`
      );
    }
    const { parts } = await parseResponse(
      response,
      uploadPartUrlsResponseSchema
    );
    const requested = new Set(partNumbers);
    if (
      parts.length !== requested.size ||
      parts.some((part) => !requested.has(part.partNumber))
    ) {
      throw new Error("The UpShare API returned mismatched upload parts.");
    }
    return parts;
  }

  async getMultipartUpload(
    fileId: string
  ): Promise<MultipartResumeResponse | null> {
    this.ensureAuth();
    const response = await this.fetch(
      `/api/files/${encodeURIComponent(fileId)}/upload-parts`,
      { headers: this.getHeaders() }
    );
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      throw await responseError(
        response,
        `Failed to inspect multipart upload (${response.status})`
      );
    }
    return parseResponse(response, multipartResumeResponseSchema);
  }

  async listFiles(options?: {
    page?: number;
    pageSize?: number;
  }): Promise<ListFilesResponse> {
    this.ensureAuth();
    const page = options?.page ?? 1;
    const pageSize = options?.pageSize ?? FILE_LIST_PAGE_SIZE;
    if (!(Number.isSafeInteger(page) && page > 0)) {
      throw new Error("Page must be a positive whole number.");
    }
    if (!(Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 500)) {
      throw new Error("Page size must be a whole number between 1 and 500.");
    }
    const searchParams = new URLSearchParams({
      limit: String(pageSize),
      page: String(page),
    });
    const response = await this.fetch(`/api/files?${searchParams}`, {
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw await responseError(
        response,
        `Failed to fetch files (${response.status})`
      );
    }
    const data = await parseResponse(response, listFilesResponseSchema);
    if (
      data.page !== page ||
      data.pageSize !== pageSize ||
      data.sort !== "newest" ||
      (data.hasMore && data.files.length === 0)
    ) {
      throw new Error("The UpShare API returned mismatched pagination data.");
    }
    return data;
  }

  async listPendingUploads(options?: {
    page?: number;
    pageSize?: number;
  }): Promise<ListFilesResponse> {
    this.ensureAuth();
    const page = options?.page ?? 1;
    const pageSize = options?.pageSize ?? FILE_LIST_PAGE_SIZE;
    if (!(Number.isSafeInteger(page) && page > 0)) {
      throw new Error("Page must be a positive whole number.");
    }
    if (!(Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 500)) {
      throw new Error("Page size must be a whole number between 1 and 500.");
    }
    const searchParams = new URLSearchParams({
      limit: String(pageSize),
      page: String(page),
      status: "uploading",
    });
    const response = await this.fetch(`/api/files?${searchParams}`, {
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw await responseError(
        response,
        `Failed to fetch unfinished uploads (${response.status})`
      );
    }
    const data = await parseResponse(response, listFilesResponseSchema);
    if (
      data.page !== page ||
      data.pageSize !== pageSize ||
      data.sort !== "newest" ||
      (data.hasMore && data.files.length === 0)
    ) {
      throw new Error("The UpShare API returned mismatched pagination data.");
    }
    return data;
  }

  async getFile(target: string): Promise<FileInfoResponse | null> {
    this.ensureAuth();
    const id = cleanIdentifier(target);
    const response = await this.fetch(`/api/files/${encodeURIComponent(id)}`, {
      headers: this.getHeaders(),
    });
    if (response.status === 404 || response.status === 405) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      throw await responseError(
        response,
        `Failed to fetch file (${response.status})`
      );
    }
    return parseResponse(response, fileInfoResponseSchema);
  }

  async renameFile(
    target: string,
    fileName: string
  ): Promise<RenameFileResponse> {
    this.ensureAuth();
    const id = cleanIdentifier(target);
    const response = await this.fetch(`/api/files/${encodeURIComponent(id)}`, {
      body: JSON.stringify({ fileName }),
      headers: this.getHeaders(),
      method: "PATCH",
    });
    if (!response.ok) {
      throw await responseError(
        response,
        `Failed to rename file (${response.status})`
      );
    }
    return parseResponse(response, renameFileResponseSchema);
  }

  async deleteFile(target: string): Promise<DeleteFileResponse> {
    this.ensureAuth();
    const id = cleanIdentifier(target);
    const response = await this.fetch(`/api/files/${encodeURIComponent(id)}`, {
      headers: this.getHeaders(),
      method: "DELETE",
    });
    if (!response.ok) {
      throw await responseError(
        response,
        `Failed to delete file (${response.status})`
      );
    }
    return parseResponse(response, deleteFileResponseSchema);
  }

  createShare(target: string, durationHours = 24): Promise<ShareResponse> {
    return this.changeShare(target, durationHours, "POST");
  }

  extendShare(target: string, durationHours = 24): Promise<ShareResponse> {
    return this.changeShare(target, durationHours, "PATCH");
  }

  private async changeShare(
    target: string,
    durationHours: number,
    method: "PATCH" | "POST"
  ): Promise<ShareResponse> {
    this.ensureAuth();
    const id = cleanIdentifier(target);
    const response = await this.fetch(
      `/api/files/${encodeURIComponent(id)}/share`,
      {
        body: JSON.stringify({ durationHours, extendMasterFile: true }),
        headers: this.getHeaders(),
        method,
      }
    );
    if (!response.ok) {
      const action = method === "POST" ? "create" : "extend";
      throw await responseError(
        response,
        `Failed to ${action} share link (${response.status})`
      );
    }
    return parseResponse(response, shareResponseSchema);
  }

  async revokeShare(target: string): Promise<{ success: true }> {
    this.ensureAuth();
    const id = cleanIdentifier(target);
    const response = await this.fetch(
      `/api/files/${encodeURIComponent(id)}/share`,
      { headers: this.getHeaders(), method: "DELETE" }
    );
    if (!response.ok) {
      throw await responseError(
        response,
        `Failed to revoke share link (${response.status})`
      );
    }
    return parseResponse(response, revokeShareResponseSchema);
  }

  async listApiKeys(): Promise<ListApiKeysResponse> {
    this.ensureAuth();
    const response = await this.fetch("/api/cli/keys", {
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw await responseError(
        response,
        `Failed to fetch API keys (${response.status})`
      );
    }
    return parseResponse(response, listApiKeysResponseSchema);
  }

  async renameApiKey(id: string, name: string): Promise<RenameApiKeyResponse> {
    this.ensureAuth();
    if (!id.trim()) {
      throw new Error("API key identifier is required.");
    }
    if (!(name.trim().length >= 1 && name.trim().length <= 64)) {
      throw new Error("New key name must be 1-64 characters.");
    }
    const response = await this.fetch("/api/cli/keys", {
      body: JSON.stringify({ id: id.trim(), name: name.trim() }),
      headers: this.getHeaders(),
      method: "PATCH",
    });
    if (!response.ok) {
      throw await responseError(
        response,
        `Failed to rename API key (${response.status})`
      );
    }
    return parseResponse(response, renameApiKeyResponseSchema);
  }

  async resolveDownload(target: string): Promise<DownloadResponse> {
    const identifier = cleanIdentifier(target);
    if (!identifier) {
      throw new Error("A file identifier or share token is required.");
    }
    const isShareTarget =
      target.includes("/s/") ||
      (identifier.length <= 16 && !identifier.includes("."));
    const primaryPath = isShareTarget
      ? `/api/files/download?token=${encodeURIComponent(identifier)}`
      : `/api/files/download?fileId=${encodeURIComponent(identifier)}`;
    let response = await this.fetch(primaryPath, {
      headers: this.getHeaders(),
    });

    if (!(response.ok || !isShareTarget)) {
      response = await this.fetch(
        `/api/files/download?fileId=${encodeURIComponent(identifier)}`,
        { headers: this.getHeaders() }
      );
    }
    if (!response.ok) {
      throw await responseError(
        response,
        `Download resolution failed (${response.status})`
      );
    }
    return parseResponse(response, downloadResponseSchema);
  }
}
