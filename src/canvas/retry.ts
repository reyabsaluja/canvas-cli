export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BASE_DELAY_MS = 1000;
export const DEFAULT_MAX_DELAY_MS = 30_000;

export type LogFn = (message: string) => void;
const defaultLog: LogFn = (msg) => console.error(msg);

const RETRIABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

const RETRIABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function isRetriableNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code) return RETRIABLE_NETWORK_CODES.has(cause.code);
  // Fallback: only message-match when there's no structured cause
  for (const code of RETRIABLE_NETWORK_CODES) {
    if (new RegExp(`\\b${code}\\b`).test(err.message)) return true;
  }
  return false;
}

function isPermanentStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

const MIN_RETRY_DELAY_MS = 500;

function addJitter(ms: number): number {
  return ms * (1 + (Math.random() - 0.5) * 0.4);
}

function clampDelay(ms: number, maxDelay: number): number {
  return Math.min(maxDelay, Math.max(MIN_RETRY_DELAY_MS, ms));
}

function exponentialDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  return clampDelay(addJitter(baseDelay * 2 ** attempt), maxDelay);
}

function getRetryDelay(response: Response, attempt: number, baseDelay: number, maxDelay: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) return clampDelay(seconds * 1000, maxDelay);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return clampDelay(date - Date.now(), maxDelay);
  }
  return exponentialDelay(attempt, baseDelay, maxDelay);
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  log?: LogFn;
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options?: RetryOptions
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelay = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const log = options?.log ?? defaultLog;
  const signal = init?.signal ?? null;
  let lastError: unknown = new Error("fetchWithRetry: retries exhausted");

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);

      if (response.ok || isPermanentStatus(response.status)) {
        return response;
      }

      if (!RETRIABLE_STATUS_CODES.has(response.status) || attempt >= maxRetries) {
        return response;
      }

      const delay = getRetryDelay(response, attempt, baseDelay, maxDelay);
      await response.body?.cancel();
      log(
        `Canvas API returned ${response.status}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`
      );
      await sleep(delay, signal);
    } catch (err) {
      lastError = err;

      if (isRetriableNetworkError(err) && attempt < maxRetries) {
        const delay = exponentialDelay(attempt, baseDelay, maxDelay);
        log(
          `Network error, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`
        );
        await sleep(delay, signal);
        continue;
      }

      throw err;
    }
  }

  // Unreachable: final iteration always returns or throws, but satisfies TypeScript
  throw lastError;
}
