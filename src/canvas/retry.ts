const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

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

function getRetryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return BASE_DELAY_MS * 2 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, init);

      if (response.ok || isPermanentStatus(response.status)) {
        return response;
      }

      if (isRetriableStatus(response.status) && attempt < MAX_RETRIES) {
        const delay = getRetryDelay(response, attempt + 1);
        console.error(
          `Canvas API returned ${response.status}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`
        );
        await sleep(delay);
        continue;
      }

      return response;
    } catch (err) {
      lastError = err;

      if (isRetriableNetworkError(err) && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * 2 ** attempt;
        console.error(
          `Network error, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`
        );
        await sleep(delay);
        continue;
      }

      throw err;
    }
  }

  throw lastError;
}
