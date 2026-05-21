export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BASE_DELAY_MS = 1000;

const RETRIABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

const RETRIABLE_NETWORK_ERRORS = [
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "fetch failed",
  "UND_ERR_CONNECT_TIMEOUT",
];

function isRetriableStatus(status: number): boolean {
  return RETRIABLE_STATUS_CODES.has(status);
}

function isRetriableNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return RETRIABLE_NETWORK_ERRORS.some((code) => err.message.includes(code));
}

function isPermanentStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

function getRetryDelay(response: Response, attempt: number, baseDelay: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return baseDelay * 2 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options?: RetryOptions
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  let lastError: unknown = new Error("fetchWithRetry: retries exhausted");

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);

      if (response.ok || isPermanentStatus(response.status)) {
        return response;
      }

      if (isRetriableStatus(response.status) && attempt < maxRetries) {
        const delay = getRetryDelay(response, attempt + 1, baseDelay);
        await response.body?.cancel();
        console.error(
          `Canvas API returned ${response.status}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`
        );
        await sleep(delay);
        continue;
      }

      return response;
    } catch (err) {
      lastError = err;

      if (isRetriableNetworkError(err) && attempt < maxRetries) {
        const delay = baseDelay * 2 ** attempt;
        console.error(
          `Network error, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`
        );
        await sleep(delay);
        continue;
      }

      throw err;
    }
  }

  throw lastError;
}
