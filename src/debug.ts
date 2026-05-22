const SENSITIVE_PATTERNS = [
  /Bearer\s+[^\s*]+/gi,
  /api[_-]?key[=:]\s*[^\s*]+/gi,
  /(?<![A-Z_])token[=:]\s*[^\s*]+/gi,
  /(?<![A-Z_])secret[=:]\s*[^\s*]+/gi,
  /(?<![A-Z_])password[=:]\s*[^\s*]+/gi,
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

export function resetDebug(): void {
  debugEnabled = false;
}

function maskSecrets(message: string): string {
  let masked = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    masked = masked.replace(pattern, "***");
  }
  return masked;
}

export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const params = new URLSearchParams(parsed.search);
    for (const key of params.keys()) {
      const lower = key.toLowerCase();
      if (
        lower.includes("token") ||
        lower.includes("key") ||
        lower.includes("secret") ||
        lower.includes("access")
      ) {
        params.set(key, "***");
      }
    }
    parsed.search = params.toString();
    return parsed.toString();
  } catch {
    return maskSecrets(url);
  }
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
  /token/i,
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

function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (isSensitiveKey(key)) {
      result[key] = "***";
    } else if (typeof value === "string") {
      result[key] = maskSecrets(value);
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeData(value as Record<string, unknown>);
    } else {
      result[key] = value;
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
