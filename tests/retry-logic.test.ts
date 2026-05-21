import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithRetry, DEFAULT_MAX_DELAY_MS, type RetryOptions } from "../src/canvas/retry.js";

const FAST: RetryOptions = { baseDelayMs: 0 };

function mockFetch(responses: Array<{ status: number; headers?: Record<string, string> } | { error: string; causeCode?: string }>) {
  let callCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    const entry = responses[callCount++];
    if (!entry) throw new Error("No more mock responses");
    if ("error" in entry) {
      const err = new Error(entry.error);
      if (entry.causeCode) (err as any).cause = { code: entry.causeCode };
      throw err;
    }
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      statusText: `Status ${entry.status}`,
      headers: new Headers(entry.headers ?? {}),
      body: { cancel: async () => {} },
      json: async () => ({}),
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;

  return {
    get callCount() { return callCount; },
    restore() { globalThis.fetch = originalFetch; },
  };
}

test("fetchWithRetry succeeds on first try for 200", async () => {
  const mock = mockFetch([{ status: 200 }]);
  try {
    const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
    assert.equal(res.status, 200);
    assert.equal(mock.callCount, 1);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry does not retry 401", async () => {
  const mock = mockFetch([{ status: 401 }]);
  try {
    const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
    assert.equal(res.status, 401);
    assert.equal(mock.callCount, 1);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry does not retry 403", async () => {
  const mock = mockFetch([{ status: 403 }]);
  try {
    const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
    assert.equal(res.status, 403);
    assert.equal(mock.callCount, 1);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry does not retry 404", async () => {
  const mock = mockFetch([{ status: 404 }]);
  try {
    const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
    assert.equal(res.status, 404);
    assert.equal(mock.callCount, 1);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry retries 429 and succeeds", async () => {
  const mock = mockFetch([
    { status: 429 },
    { status: 200 },
  ]);
  try {
    const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
    assert.equal(res.status, 200);
    assert.equal(mock.callCount, 2);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry retries 500 and succeeds", async () => {
  const mock = mockFetch([
    { status: 500 },
    { status: 200 },
  ]);
  try {
    const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
    assert.equal(res.status, 200);
    assert.equal(mock.callCount, 2);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry retries 502 and succeeds", async () => {
  const mock = mockFetch([
    { status: 502 },
    { status: 200 },
  ]);
  try {
    const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
    assert.equal(res.status, 200);
    assert.equal(mock.callCount, 2);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry retries 503 and succeeds", async () => {
  const mock = mockFetch([
    { status: 503 },
    { status: 503 },
    { status: 200 },
  ]);
  try {
    const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
    assert.equal(res.status, 200);
    assert.equal(mock.callCount, 3);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry gives up after MAX_RETRIES", async () => {
  const mock = mockFetch([
    { status: 503 },
    { status: 503 },
    { status: 503 },
    { status: 503 },
  ]);
  try {
    const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
    assert.equal(res.status, 503);
    assert.equal(mock.callCount, 4);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry retries network errors with transient cause code", async () => {
  const mock = mockFetch([
    { error: "fetch failed", causeCode: "ECONNRESET" },
    { status: 200 },
  ]);
  try {
    const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
    assert.equal(res.status, 200);
    assert.equal(mock.callCount, 2);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry does not retry generic fetch failed without transient cause", async () => {
  const mock = mockFetch([{ error: "fetch failed" }]);
  try {
    await assert.rejects(
      () => fetchWithRetry("http://test.com/api", undefined, FAST),
      { message: "fetch failed" }
    );
    assert.equal(mock.callCount, 1);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry retries ECONNRESET", async () => {
  const mock = mockFetch([
    { error: "read ECONNRESET" },
    { status: 200 },
  ]);
  try {
    const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
    assert.equal(res.status, 200);
    assert.equal(mock.callCount, 2);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry retries ETIMEDOUT", async () => {
  const mock = mockFetch([
    { error: "connect ETIMEDOUT" },
    { status: 200 },
  ]);
  try {
    const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
    assert.equal(res.status, 200);
    assert.equal(mock.callCount, 2);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry does not retry unknown errors", async () => {
  const mock = mockFetch([{ error: "something completely unexpected" }]);
  try {
    await assert.rejects(
      () => fetchWithRetry("http://test.com/api", undefined, FAST),
      { message: "something completely unexpected" }
    );
    assert.equal(mock.callCount, 1);
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry respects Retry-After header over base delay", async () => {
  const mock = mockFetch([
    { status: 429, headers: { "retry-after": "1" } },
    { status: 200 },
  ]);
  try {
    const start = Date.now();
    const res = await fetchWithRetry("http://test.com/api", undefined, { baseDelayMs: 5000 });
    const elapsed = Date.now() - start;
    assert.equal(res.status, 200);
    assert.ok(elapsed >= 1000 && elapsed < 2000, "Should use Retry-After: 1 (1000ms) not base delay (5000ms)");
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry clamps past-date Retry-After to minimum delay", async () => {
  const pastDate = new Date(Date.now() - 60000).toUTCString();
  const mock = mockFetch([
    { status: 429, headers: { "retry-after": pastDate } },
    { status: 200 },
  ]);
  try {
    const start = Date.now();
    const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
    const elapsed = Date.now() - start;
    assert.equal(res.status, 200);
    assert.equal(mock.callCount, 2);
    assert.ok(elapsed >= 500, "Past-date Retry-After should be clamped to MIN_RETRY_DELAY_MS (500ms)");
    assert.ok(elapsed < 1500, "Should not wait longer than necessary");
  } finally {
    mock.restore();
  }
});

test("fetchWithRetry caps large Retry-After to maxDelayMs", async () => {
  const mock = mockFetch([
    { status: 429, headers: { "retry-after": "3600" } },
    { status: 200 },
  ]);
  try {
    const start = Date.now();
    const res = await fetchWithRetry("http://test.com/api", undefined, { baseDelayMs: 0, maxDelayMs: 1000 });
    const elapsed = Date.now() - start;
    assert.equal(res.status, 200);
    assert.equal(mock.callCount, 2);
    assert.ok(elapsed >= 500 && elapsed < 1500, `Should cap at maxDelayMs (1000ms), got ${elapsed}ms`);
  } finally {
    mock.restore();
  }
});

test("DEFAULT_MAX_DELAY_MS is 30 seconds", () => {
  assert.equal(DEFAULT_MAX_DELAY_MS, 30_000);
});

test("fetchWithRetry aborts sleep when signal is aborted", async () => {
  const mock = mockFetch([
    { status: 503 },
    { status: 200 },
  ]);
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      () => fetchWithRetry("http://test.com/api", { signal: controller.signal }, { baseDelayMs: 10_000 }),
      (err: Error) => err.name === "AbortError"
    );
    assert.equal(mock.callCount, 1);
  } finally {
    mock.restore();
  }
});
