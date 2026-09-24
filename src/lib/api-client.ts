import { z } from "zod";
import { resolveCommandContext } from "./config";
import { resolveProfileApiKey } from "./credentials";
import { sanitizeTerminalText } from "./format";
import { cleanIdentifier, isFileId } from "./identifiers";
import type {
  CompletedUploadPart,
  CompleteUploadResponse,
  DeleteFileResponse,
  DeviceAuthorizationResponse,
  DeviceTokenErrorResponse,
  DeviceTokenResponse,
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
  deviceAuthorizationResponseSchema,
  deviceTokenErrorResponseSchema,
  deviceTokenResponseSchema,
  downloadResponseSchema,
  fileInfoResponseSchema,
  healthResponseSchema,
  listApiKeysResponseSchema,
  listFilesResponseSchema,
  MAX_PAGE_SIZE,
  multipartResumeResponseSchema,
  renameApiKeyResponseSchema,
  renameFileResponseSchema,
  revokeShareResponseSchema,
  shareResponseSchema,
  uploadPartUrlsResponseSchema,
  uploadRequestResponseSchema,
  whoamiResponseSchema,
} from "./schemas";
import { wait } from "./wait";

export interface CompleteUploadOptions {
  createShareLink?: boolean;
  parts?: CompletedUploadPart[];
  shareDurationHours?: number;
}

const API_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 8000;
const FINALIZE_TIMEOUT_MS = 10 * 60 * 1000;
const FINALIZE_RETRY_DELAY_MS = 1000;
const COMPLETE_UPLOAD_MAX_ATTEMPTS = 3;
const COMPLETE_UPLOAD_RETRY_AFTER_CAP_MS = 30_000;

function finalizeRetryDelay(attempt: number): Promise<void> {
  return wait(FINALIZE_RETRY_DELAY_MS * 2 ** (attempt - 1));
}

function isFinalUploadStateError(bodyText: string): boolean {
  return (
    bodyText.includes("cannot be finalized") ||
    bodyText.includes("invalid_state") ||
    bodyText.includes("current state")
  );
}

function finalizeRetryAfterMs(
  retryAfterHeader: string | null,
  attempt: number
): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader.trim());
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, COMPLETE_UPLOAD_RETRY_AFTER_CAP_MS);
    }
    const dateMs = Date.parse(retryAfterHeader);
    if (!Number.isNaN(dateMs)) {
      return Math.min(
        Math.max(dateMs - Date.now(), 0),
        COMPLETE_UPLOAD_RETRY_AFTER_CAP_MS
      );
    }
  }
  return FINALIZE_RETRY_DELAY_MS * 2 ** (attempt - 1);
}

async function shouldRetryFinalizeConflict(
  response: Response,
  attempt: number
): Promise<boolean> {
  const peek: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  const bodyText = JSON.stringify(peek ?? "").toLowerCase();
  if (isFinalUploadStateError(bodyText)) {
    return false;
  }
  await response.body?.cancel();
  await wait(
    finalizeRetryAfterMs(response.headers.get("retry-after"), attempt)
  );
  return true;
}

async function handleFinalizeFailure(
  response: Response,
  attempt: number
): Promise<void> {
  if (response.status === 409 && attempt < COMPLETE_UPLOAD_MAX_ATTEMPTS) {
    const shouldRetry = await shouldRetryFinalizeConflict(response, attempt);
    if (shouldRetry) {
      return;
    }
  }
  if (response.status >= 500 && attempt < COMPLETE_UPLOAD_MAX_ATTEMPTS) {
    await response.body?.cancel();
    await finalizeRetryDelay(attempt);
    return;
  }
  throw await responseError(
    response,
    `Failed to finalize upload (${response.status})`
  );
}

const LEGACY_SINGLE_UPLOAD_LIMIT_BYTES = 5_363_466_240;

const LEGACY_BARE_FILE_ID_REGEX = /^[A-Za-z0-9_-]{21}$/;
export const FILE_LIST_PAGE_SIZE = 20;
const apiErrorSchema = z.object({
  code: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  error_description: z.string().min(1).optional(),
});
const DEVICE_CLIENT_ID = "upshare-cli";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export class RetryableApiError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "RetryableApiError";
  }
}

async function responseError(response: Response, fallback: string) {
  const body: unknown = await response.json().catch(() => null);
  const parsed = apiErrorSchema.safeParse(body);
  return new Error(
    parsed.success && (parsed.data.error_description || parsed.data.error)
      ? sanitizeTerminalText(
          parsed.data.error_description ?? parsed.data.error ?? fallback
        )
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

function isMultipartUnsupportedError(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }
  const text = JSON.stringify(body).toLowerCase();
  return (
    text.includes("supportsmultipart") ||
    (text.includes("multipart") &&
      (text.includes("unsupported") ||
        text.includes("unknown") ||
        text.includes("invalid")))
  );
}

export class ApiClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly credentialError: Error | undefined;
  private readonly profile: string;

  constructor(options?: {
    apiKey?: string;
    apiUrl?: string;
    profile?: string;
  }) {
    const context = resolveCommandContext({
      apiUrl: options?.apiUrl,
      profile: options?.profile,
    });
    this.profile = context.profile;
    this.apiUrl = context.apiUrl;

    if (options?.apiKey) {
      this.apiKey = options.apiKey;
      this.credentialError = undefined;
      return;
    }

    try {
      this.apiKey =
        resolveProfileApiKey(this.profile, this.apiUrl)?.apiKey ?? "";
      this.credentialError = undefined;
    } catch (error) {
      this.apiKey = "";
      this.credentialError =
        error instanceof Error
          ? error
          : new Error("Could not access stored API credentials.");
    }
  }

  private getHeaders(
    apiKey = this.apiKey,
    hasBody = false
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }
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
      if (error instanceof RetryableApiError) {
        throw error;
      }

      const isTimeout =
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");
      if (isTimeout || error instanceof TypeError) {
        throw new RetryableApiError(
          isTimeout
            ? `Request to ${this.apiUrl} timed out.`
            : `Could not connect to ${this.apiUrl}.`,
          { cause: error }
        );
      }
      throw error;
    }
  }

  async verifyApiKey(key?: string): Promise<WhoamiResponse> {
    let activeKey: string;
    if (key) {
      activeKey = key;
    } else {
      this.ensureAuth();
      activeKey = this.apiKey;
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

  async requestDeviceAuthorization(
    deviceName?: string
  ): Promise<DeviceAuthorizationResponse> {
    const body = new URLSearchParams({ client_id: DEVICE_CLIENT_ID });
    if (deviceName) {
      body.set("device_name", deviceName);
    }
    const response = await this.fetch("/api/cli/device/authorization", {
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    if (!response.ok) {
      throw await responseError(
        response,
        `Could not start browser authorization (${response.status})`
      );
    }
    const authorization = await parseResponse(
      response,
      deviceAuthorizationResponseSchema
    );
    const apiOrigin = new URL(this.apiUrl).origin;
    const verificationUrl = new URL(authorization.verification_uri);
    const completeVerificationUrl = new URL(
      authorization.verification_uri_complete
    );

    const isLocalhostUrl = (url: URL): boolean =>
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1";
    const hasTrustedVerificationUrls = [
      verificationUrl,
      completeVerificationUrl,
    ].every(
      (url) =>
        (url.protocol === "https:" ||
          (url.protocol === "http:" && isLocalhostUrl(url))) &&
        url.pathname.startsWith("/cli/authorize")
    );
    const completeCode = completeVerificationUrl.searchParams.get("user_code");
    if (
      !hasTrustedVerificationUrls ||
      completeVerificationUrl.pathname !== verificationUrl.pathname ||
      (completeCode !== null && completeCode !== authorization.user_code)
    ) {
      throw new Error(
        "The UpShare API returned an untrusted verification URL."
      );
    }
    if (
      verificationUrl.origin !== apiOrigin ||
      completeVerificationUrl.origin !== apiOrigin
    ) {
      console.warn(
        `Warning: verification URL origin (${verificationUrl.origin}) differs from the API origin (${apiOrigin}). Continuing.`
      );
    }
    return authorization;
  }

  async requestDeviceToken(
    deviceCode: string
  ): Promise<
    | { data: DeviceTokenResponse; status: "success" }
    | { error: DeviceTokenErrorResponse; status: "error" }
  > {
    const body = new URLSearchParams({
      client_id: DEVICE_CLIENT_ID,
      device_code: deviceCode,
      grant_type: DEVICE_GRANT_TYPE,
    });
    const response = await this.fetch("/api/cli/device/token", {
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    if (response.ok) {
      return {
        data: await parseResponse(response, deviceTokenResponseSchema),
        status: "success",
      };
    }

    if (response.status === 429 || response.status >= 500) {
      const serverError = await responseError(
        response,
        `Device authorization temporarily failed (${response.status}).`
      );
      throw new RetryableApiError(serverError.message, { cause: serverError });
    }

    const responseBody: unknown = await response.json().catch(() => null);
    const parsed = deviceTokenErrorResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new Error(`Device authorization failed (${response.status}).`);
    }
    return { error: parsed.data, status: "error" };
  }

  async checkHealth(): Promise<HealthResponse> {
    const response = await this.fetch(
      "/api/health",
      undefined,
      HEALTH_TIMEOUT_MS
    );
    if (response.status === 503) {
      try {
        return await parseResponse(response, healthResponseSchema);
      } catch {
        return { status: "degraded" };
      }
    }
    if (!response.ok) {
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
      headers: this.getHeaders(this.apiKey, true),
      method: "POST",
    });
    if (
      response.status === 400 &&
      params.fileSize <= LEGACY_SINGLE_UPLOAD_LIMIT_BYTES
    ) {
      const peek: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      if (isMultipartUnsupportedError(peek)) {
        await response.body?.cancel();
        response = await this.fetch("/api/files/upload-request", {
          body: JSON.stringify(params),
          headers: this.getHeaders(this.apiKey, true),
          method: "POST",
        });
      }
    }
    if (!response.ok) {
      throw await responseError(
        response,
        `Upload request failed (${response.status})`
      );
    }
    return parseResponse(response, uploadRequestResponseSchema);
  }

  async completeUpload(
    fileId: string,
    options?: CompleteUploadOptions
  ): Promise<CompleteUploadResponse> {
    this.ensureAuth();
    for (
      let attempt = 1;
      attempt <= COMPLETE_UPLOAD_MAX_ATTEMPTS;
      attempt += 1
    ) {
      let response: Response;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: sequential finalize retries must not run in parallel
        response = await this.fetch(
          "/api/files/upload-complete",
          {
            body: JSON.stringify({
              createShareLink: options?.createShareLink,
              fileId,
              parts: options?.parts,
              shareDurationHours: options?.shareDurationHours,
            }),
            headers: this.getHeaders(this.apiKey, true),
            method: "POST",
          },
          FINALIZE_TIMEOUT_MS
        );
      } catch (error) {
        if (
          error instanceof RetryableApiError &&
          attempt < COMPLETE_UPLOAD_MAX_ATTEMPTS
        ) {
          await finalizeRetryDelay(attempt);
          continue;
        }
        throw error;
      }
      if (!response.ok) {
        await handleFinalizeFailure(response, attempt);
        continue;
      }
      return parseResponse(response, completeUploadResponseSchema);
    }
    throw new Error("Failed to finalize upload.");
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
        headers: this.getHeaders(this.apiKey, true),
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

  private async listFilesInternal(params: {
    errorMessage: string;
    page?: number;
    pageSize?: number;
    status?: string;
  }): Promise<ListFilesResponse> {
    this.ensureAuth();
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? FILE_LIST_PAGE_SIZE;
    if (!(Number.isSafeInteger(page) && page > 0)) {
      throw new Error("Page must be a positive whole number.");
    }
    if (
      !(
        Number.isSafeInteger(pageSize) &&
        pageSize > 0 &&
        pageSize <= MAX_PAGE_SIZE
      )
    ) {
      throw new Error(
        `Page size must be a whole number between 1 and ${MAX_PAGE_SIZE}.`
      );
    }
    const searchParams = new URLSearchParams({
      limit: String(pageSize),
      page: String(page),
    });
    if (params.status) {
      searchParams.set("status", params.status);
    }
    const response = await this.fetch(`/api/files?${searchParams}`, {
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw await responseError(
        response,
        `${params.errorMessage} (${response.status})`
      );
    }
    const data = await parseResponse(response, listFilesResponseSchema);

    if (
      data.page !== page ||
      data.pageSize !== pageSize ||
      (data.hasMore && data.files.length === 0)
    ) {
      throw new Error("The UpShare API returned mismatched pagination data.");
    }
    return data;
  }

  // biome-ignore lint/suspicious/useAwait: thin typed wrapper over listFilesInternal keeps call sites stable
  async listFiles(options?: {
    page?: number;
    pageSize?: number;
  }): Promise<ListFilesResponse> {
    return this.listFilesInternal({
      errorMessage: "Failed to fetch files",
      page: options?.page,
      pageSize: options?.pageSize,
    });
  }

  // biome-ignore lint/suspicious/useAwait: thin typed wrapper over listFilesInternal keeps call sites stable
  async listPendingUploads(options?: {
    page?: number;
    pageSize?: number;
  }): Promise<ListFilesResponse> {
    return this.listFilesInternal({
      errorMessage: "Failed to fetch unfinished uploads",
      page: options?.page,
      pageSize: options?.pageSize,
      status: "uploading",
    });
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
      headers: this.getHeaders(this.apiKey, true),
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
        body: JSON.stringify({ durationHours }),
        headers: this.getHeaders(this.apiKey, true),
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
      headers: this.getHeaders(this.apiKey, true),
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

    const fileIdFirst = isFileId(identifier);
    const firstQuery = fileIdFirst
      ? `/api/files/download?fileId=${encodeURIComponent(identifier)}`
      : `/api/files/download?token=${encodeURIComponent(identifier)}`;
    const secondQuery = fileIdFirst
      ? `/api/files/download?token=${encodeURIComponent(identifier)}`
      : `/api/files/download?fileId=${encodeURIComponent(identifier)}`;
    let response = await this.fetch(firstQuery, {
      headers: this.getHeaders(),
    });

    if (response.ok) {
      return parseResponse(response, downloadResponseSchema);
    }
    const firstStatus = response.status;

    await response.body?.cancel();
    response = await this.fetch(secondQuery, {
      headers: this.getHeaders(),
    });
    if (response.ok) {
      return parseResponse(response, downloadResponseSchema);
    }
    const secondStatus = response.status;
    await response.body?.cancel();

    if (
      !fileIdFirst &&
      LEGACY_BARE_FILE_ID_REGEX.test(identifier) &&
      firstStatus === 404 &&
      secondStatus === 404
    ) {
      const legacyResponse = await this.fetch(
        `/api/files/download?fileId=${encodeURIComponent(`f_${identifier}`)}`,
        { headers: this.getHeaders() }
      );
      if (!legacyResponse.ok) {
        throw await responseError(
          legacyResponse,
          `Download resolution failed (${legacyResponse.status})`
        );
      }
      return parseResponse(legacyResponse, downloadResponseSchema);
    }
    throw await responseError(
      response,
      `Download resolution failed (${secondStatus})`
    );
  }
}
