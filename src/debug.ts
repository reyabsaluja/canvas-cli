const SENSITIVE_PATTERNS = [
  /Bearer\s+[^\s]+/gi,
  /api[_-]?key[=:]\s*[^\s]+/gi,
  /(?<![A-Za-z_])token[=:]\s*[^\s]+/gi,
  /(?<![A-Za-z_])secret[=:]\s*[^\s]+/gi,
  /(?<![A-Za-z_])password[=:]\s*[^\s]+/gi,
];

const SENSITIVE_ENV_KEYS = new Set([
  "CANVAS_ACCESS_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
]);

let debugEnabled = false;

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

export function enableDebug(): void {
  debugEnabled = true;
}

export function initDebug(flagValue: boolean): void {
  if (flagValue || process.env.DEBUG === "canvas-cli") {
    debugEnabled = true;
  }
}

/** @internal Test-only. Resets debug state between test cases. */
export function __test__resetDebug(): void {
  debugEnabled = false;
}

function maskSecrets(message: string): string {
  let masked = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    masked = masked.replace(pattern, "***");
  }
  return masked;
}

const SENSITIVE_URL_PARAM_PATTERNS = [
  /token$/i,
  /^access/i,
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /credential/i,
];

function isSensitiveParam(key: string): boolean {
  return SENSITIVE_URL_PARAM_PATTERNS.some((p) => p.test(key));
}

export function maskUrl(url: string): string {
  const qIndex = url.indexOf("?");
  if (qIndex === -1) return url;

  const base = url.slice(0, qIndex);
  const queryString = url.slice(qIndex + 1);
  const masked = queryString.replace(
    /([^&=]+)=([^&]*)/g,
    (match, key: string, _value: string) => {
      if (isSensitiveParam(key)) {
        return `${key}=***`;
      }
      return match;
    }
  );
  return `${base}?${masked}`;
}

export function maskEnvForDebug(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of SENSITIVE_ENV_KEYS) {
    if (process.env[key]) {
      result[key] = "***";
    }
  }
  return result;
}

type DebugCategory =
  | "api"
  | "ai"
  | "fs"
  | "cache"
  | "config"
  | "general";

function formatTimestamp(): string {
  return new Date().toISOString();
}

export function warn(category: DebugCategory, message: string): void {
  const safeMessage = maskSecrets(message);
  const prefix = `[WARN ${formatTimestamp()} ${category.toUpperCase()}]`;
  process.stderr.write(`${prefix} ${safeMessage}\n`);
}

export function debug(category: DebugCategory, message: string, data?: Record<string, unknown>): void {
  if (!debugEnabled) return;

  const safeMessage = maskSecrets(message);
  const prefix = `[DEBUG ${formatTimestamp()} ${category.toUpperCase()}]`;

  if (data) {
    const safeData = sanitizeData(data);
    process.stderr.write(`${prefix} ${safeMessage} ${JSON.stringify(safeData)}\n`);
  } else {
    process.stderr.write(`${prefix} ${safeMessage}\n`);
  }
}

const SENSITIVE_KEY_PATTERNS = [
  /token$/i,
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /authorization/i,
  /credential/i,
  /^key$/i,
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return maskSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === "object" && value !== null) return sanitizeData(value as Record<string, unknown>);
  return value;
}

function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (isSensitiveKey(key)) {
      result[key] = "***";
    } else {
      result[key] = sanitizeValue(value);
    }
  }
  return result;
}

export function debugApiRequest(method: string, url: string): void {
  debug("api", `${method} ${maskUrl(url)}`);
}

export function debugApiResponse(method: string, url: string, status: number, durationMs: number): void {
  debug("api", `${method} ${maskUrl(url)} → ${status} (${durationMs}ms)`);
}

export function debugAI(provider: string, model: string, message: string, data?: Record<string, unknown>): void {
  debug("ai", `[${provider}/${model}] ${message}`, data);
}

export function debugFs(operation: string, path: string, detail?: string): void {
  const msg = detail ? `${operation}: ${path} (${detail})` : `${operation}: ${path}`;
  debug("fs", msg);
}

export function debugCache(operation: string, key: string, hit?: boolean): void {
  const hitStr = hit === undefined ? "" : hit ? " [HIT]" : " [MISS]";
  debug("cache", `${operation}: ${key}${hitStr}`);
}
