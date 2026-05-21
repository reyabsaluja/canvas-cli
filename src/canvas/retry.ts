export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BASE_DELAY_MS = 1000;
export const DEFAULT_MAX_DELAY_MS = 30_000;

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
  if (cause?.code && RETRIABLE_NETWORK_CODES.has(cause.code)) return true;
  // Match messages like "read ECONNRESET" or "connect ETIMEDOUT" where code is a word boundary
  return [...RETRIABLE_NETWORK_CODES].some((code) =>
    new RegExp(`\\b${code}\\b`).test(err.message)
  );
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

function getRetryDelay(response: Response, attempt: number, baseDelay: number, maxDelay: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) return clampDelay(seconds * 1000, maxDelay);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return clampDelay(date - Date.now(), maxDelay);
  }
  return Math.min(maxDelay, addJitter(baseDelay * 2 ** (attempt - 1)));
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options?: RetryOptions
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelay = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const signal = init?.signal ?? null;
  let lastError: unknown = new Error("fetchWithRetry: retries exhausted");

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);

      if (response.ok || isPermanentStatus(response.status)) {
        return response;
      }

      if (RETRIABLE_STATUS_CODES.has(response.status) && attempt < maxRetries) {
        const delay = getRetryDelay(response, attempt + 1, baseDelay, maxDelay);
        await response.body?.cancel();
        console.error(
          `Canvas API returned ${response.status}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`
        );
        await sleep(delay, signal);
        continue;
      }

      return response;
    } catch (err) {
      lastError = err;

      if (isRetriableNetworkError(err) && attempt < maxRetries) {
        const delay = Math.min(maxDelay, addJitter(baseDelay * 2 ** attempt));
        console.error(
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
