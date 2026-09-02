import type { Config } from "../config/env.js";
import { isSameCanvasOrigin, resolveCanvasUrl } from "../sanitize.js";
import { debug, maskUrl } from "../debug.js";

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

/** Thrown when a download target is not on the configured Canvas origin. */
export class CrossOriginDownloadError extends Error {
  constructor(url: string) {
    super(`Refusing to send Canvas credentials to non-Canvas origin: ${maskUrl(url)}`);
    this.name = "CrossOriginDownloadError";
  }
}

/** Thrown when a response body exceeds the configured size limit. */
export class DownloadTooLargeError extends Error {
  constructor(limit: number) {
    super(`Download exceeds the ${Math.round(limit / (1024 * 1024))} MB limit`);
    this.name = "DownloadTooLargeError";
  }
}

/**
 * Combine an optional caller signal with a timeout. Aborting the caller signal
 * propagates its reason (typically an AbortError); the timeout aborts with a
 * TimeoutError so callers can distinguish user cancellation from slow servers.
 */
export function withTimeoutSignal(
  signal: AbortSignal | null | undefined,
  timeoutMs: number
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Fetch a Canvas-hosted file with the bearer token. The URL (absolute or
 * relative to the Canvas base URL) must share the Canvas origin; anything else
 * throws CrossOriginDownloadError before any request is made.
 */
export async function fetchCanvasFile(
  url: string,
  config: Config,
  options?: { signal?: AbortSignal | null; timeoutMs?: number }
): Promise<Response> {
  const resolved = resolveCanvasUrl(url, config.baseUrl);
  if (!resolved || !isSameCanvasOrigin(url, config.baseUrl)) {
    debug("api", `Skipping cross-origin file download: ${maskUrl(url)}`);
    throw new CrossOriginDownloadError(url);
  }
  const { signal, dispose } = withTimeoutSignal(
    options?.signal,
    options?.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
  );
  try {
    return await fetch(resolved.toString(), {
      headers: { Authorization: `Bearer ${config.accessToken}` },
      // Redirects to another origin are followed without credentials by fetch;
      // the bearer header is only attached to the same-origin initial request.
      redirect: "follow",
      signal,
    });
  } finally {
    // The timer must outlive the header exchange only; body reads are guarded
    // separately by readBodyWithLimit's own timeout.
    dispose();
  }
}

/**
 * Read a response body into a Buffer, refusing bodies larger than `maxBytes`
 * (checked via Content-Length up front and again while streaming).
 */
export async function readBodyWithLimit(
  response: Response,
  maxBytes: number = DEFAULT_MAX_DOWNLOAD_BYTES,
  options?: { signal?: AbortSignal | null; timeoutMs?: number }
): Promise<Buffer> {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new DownloadTooLargeError(maxBytes);
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new DownloadTooLargeError(maxBytes);
    return buffer;
  }

  const { signal, dispose } = withTimeoutSignal(
    options?.signal,
    options?.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
  );
  const reader = response.body.getReader();
  const onAbort = () => {
    reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new DownloadTooLargeError(maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    dispose();
  }
  return Buffer.concat(chunks);
}
