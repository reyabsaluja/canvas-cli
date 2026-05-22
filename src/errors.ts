import { CanvasApiError } from "./canvas/errors.js";
import { AIError, classifyAIError, isAIProviderError } from "./ai/provider.js";

export type ExitCode = 1 | 2;

export type ErrorKind =
  | "auth"
  | "network"
  | "not_found"
  | "permission"
  | "rate_limit"
  | "server"
  | "ai_provider"
  | "config"
  | "unknown";

export class CanvasCliError extends Error {
  readonly kind: ErrorKind;
  readonly exitCode: ExitCode;
  readonly recoveryHint: string | null;
  readonly retriable: boolean;

  constructor(
    message: string,
    kind: ErrorKind,
    options?: {
      exitCode?: ExitCode;
      recoveryHint?: string | null;
      retriable?: boolean;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = "CanvasCliError";
    this.kind = kind;
    this.exitCode = options?.exitCode ?? 1;
    this.recoveryHint = options?.recoveryHint ?? null;
    this.retriable = options?.retriable ?? false;
    if (options?.cause) this.cause = options.cause;
  }

  get userMessage(): string {
    const parts = [this.message];
    if (this.recoveryHint) parts.push(this.recoveryHint);
    return parts.join("\n");
  }
}

export class CanvasAuthError extends CanvasCliError {
  constructor(message?: string, cause?: unknown) {
    super(
      message ?? "Authentication failed.",
      "auth",
      {
        recoveryHint: "Check your CANVAS_ACCESS_TOKEN, or run `canvas-cli login` to reconfigure.",
        cause,
      }
    );
    this.name = "CanvasAuthError";
  }
}

export class CanvasNetworkError extends CanvasCliError {
  constructor(message?: string, cause?: unknown) {
    super(
      message ?? "Network error. Could not reach Canvas.",
      "network",
      {
        recoveryHint: "Check your CANVAS_BASE_URL and internet connection.",
        retriable: true,
        cause,
      }
    );
    this.name = "CanvasNetworkError";
  }
}

export class CanvasNotFoundError extends CanvasCliError {
  constructor(resource?: string, cause?: unknown) {
    const msg = resource
      ? `Not found: ${resource}`
      : "The requested resource was not found on Canvas.";
    super(msg, "not_found", { cause });
    this.name = "CanvasNotFoundError";
  }
}

export class CanvasPermissionError extends CanvasCliError {
  constructor(message?: string, cause?: unknown) {
    super(
      message ?? "You do not have permission to access this resource.",
      "permission",
      {
        recoveryHint: "Check that your token has the required scopes, or contact your Canvas admin.",
        cause,
      }
    );
    this.name = "CanvasPermissionError";
  }
}

export class CanvasRateLimitError extends CanvasCliError {
  readonly retryAfterMs: number | null;

  constructor(retryAfterMs?: number | null, cause?: unknown) {
    super("Canvas API rate limit exceeded.", "rate_limit", {
      recoveryHint: retryAfterMs
        ? `Try again in ~${Math.ceil(retryAfterMs / 1000)}s.`
        : "Wait a moment and try again.",
      retriable: true,
      cause,
    });
    this.name = "CanvasRateLimitError";
    this.retryAfterMs = retryAfterMs ?? null;
  }
}

export class CanvasServerError extends CanvasCliError {
  readonly statusCode: number;

  constructor(statusCode: number, cause?: unknown) {
    super(
      `Canvas returned a server error (${statusCode}).`,
      "server",
      {
        recoveryHint: "This is a Canvas-side issue. Try again later.",
        retriable: true,
        cause,
      }
    );
    this.name = "CanvasServerError";
    this.statusCode = statusCode;
  }
}

export class AIProviderError extends CanvasCliError {
  readonly aiError: AIError;

  constructor(aiError: AIError) {
    super(aiError.message, "ai_provider", {
      recoveryHint: aiError.setupHint,
      retriable: aiError.kind === "rate_limit" || aiError.kind === "provider_unavailable",
      cause: aiError,
    });
    this.name = "AIProviderError";
    this.aiError = aiError;
  }
}

export class ConfigError extends CanvasCliError {
  constructor(message: string, recoveryHint?: string) {
    super(message, "config", {
      exitCode: 2,
      recoveryHint: recoveryHint ?? null,
    });
    this.name = "ConfigError";
  }
}

const NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const causeCode = (err.cause as { code?: string } | undefined)?.code;
  if (causeCode && NETWORK_ERROR_CODES.has(causeCode)) return true;
  // Node's undici wraps connection errors as "fetch failed" with the real code in cause
  if (err.message === "fetch failed" && err.cause instanceof Error) {
    const causeMsg = err.cause.message;
    if (
      causeMsg.includes("ENOTFOUND") ||
      causeMsg.includes("ECONNREFUSED") ||
      causeMsg.includes("ECONNRESET") ||
      causeMsg.includes("ETIMEDOUT")
    ) {
      return true;
    }
  }
  return (
    err.message.includes("ENOTFOUND") ||
    err.message.includes("ECONNREFUSED") ||
    err.message.includes("ECONNRESET") ||
    err.message.includes("ETIMEDOUT")
  );
}

export function classifyError(err: unknown): CanvasCliError {
  if (err instanceof CanvasCliError) return err;

  // Safety net: CanvasClient.throwForStatus maps known codes to typed errors,
  // but raw CanvasApiError can still reach here via its default branch (e.g. 400/409).
  if (err instanceof CanvasApiError) {
    switch (err.status) {
      case 401:
        return new CanvasAuthError(undefined, err);
      case 403:
        return new CanvasPermissionError(undefined, err);
      case 404:
        return new CanvasNotFoundError(undefined, err);
      case 429:
        return new CanvasRateLimitError(null, err);
      default:
        if (err.status >= 500) {
          return new CanvasServerError(err.status, err);
        }
        return new CanvasCliError(err.message, "unknown", { cause: err });
    }
  }

  if (err instanceof AIError) {
    return new AIProviderError(err);
  }

  if (isAIProviderError(err)) {
    return new AIProviderError(classifyAIError(err));
  }

  if (err instanceof Error) {
    if (isNetworkError(err)) {
      return new CanvasNetworkError(undefined, err);
    }
    return new CanvasCliError(err.message, "unknown", { cause: err });
  }

  return new CanvasCliError("An unexpected error occurred.", "unknown", { cause: err });
}

export function handleError(err: unknown): never {
  const classified = classifyError(err);
  console.error(classified.userMessage);
  process.exit(classified.exitCode);
}
