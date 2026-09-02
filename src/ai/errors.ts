export type AIErrorKind =
  | "rate_limit"
  | "auth"
  | "network"
  | "model_not_found"
  | "provider_unavailable"
  | "bad_request"
  | "unknown";

export class AIError extends Error {
  readonly kind: AIErrorKind;
  readonly retryAfterMs: number | null;
  readonly setupHint: string | null;

  constructor(
    message: string,
    kind: AIErrorKind,
    options?: { retryAfterMs?: number | null; setupHint?: string | null }
  ) {
    super(message);
    this.name = "AIError";
    this.kind = kind;
    this.retryAfterMs = options?.retryAfterMs ?? null;
    this.setupHint = options?.setupHint ?? null;
  }

  get userMessage(): string {
    const parts = [this.message];
    if (this.retryAfterMs !== null) {
      const seconds = Math.ceil(this.retryAfterMs / 1000);
      parts.push(`Try again in ~${seconds}s.`);
    }
    if (this.setupHint) {
      parts.push(this.setupHint);
    }
    return parts.join(" ");
  }
}
