import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { fetchWithRetry, DEFAULT_MAX_DELAY_MS, type RetryOptions, type SleepFn } from "../src/canvas/retry.js";
import { CanvasClient } from "../src/canvas/client.js";

const noopSleep: SleepFn = async () => {};
const FAST: RetryOptions = { baseDelayMs: 1, log: () => {}, sleepFn: noopSleep };

afterEach(() => {
  mock.restoreAll();
});

function mockFetch(responses: Array<{ status: number; headers?: Record<string, string> } | { error: string; causeCode?: string }>) {
  let callCount = 0;

  mock.method(globalThis, "fetch", async () => {
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
  });

  return {
    get callCount() { return callCount; },
  };
}

test("fetchWithRetry succeeds on first try for 200", async () => {
  const mock = mockFetch([{ status: 200 }]);
  const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
  assert.equal(res.status, 200);
  assert.equal(mock.callCount, 1);
});

test("fetchWithRetry does not retry 401", async () => {
  const mock = mockFetch([{ status: 401 }]);
  const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
  assert.equal(res.status, 401);
  assert.equal(mock.callCount, 1);
});

test("fetchWithRetry does not retry 403", async () => {
  const mock = mockFetch([{ status: 403 }]);
  const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
  assert.equal(res.status, 403);
  assert.equal(mock.callCount, 1);
});

test("fetchWithRetry does not retry 404", async () => {
  const mock = mockFetch([{ status: 404 }]);
  const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
  assert.equal(res.status, 404);
  assert.equal(mock.callCount, 1);
});

test("fetchWithRetry retries 429 and succeeds", async () => {
  const mock = mockFetch([
    { status: 429 },
    { status: 200 },
  ]);
  const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
  assert.equal(res.status, 200);
  assert.equal(mock.callCount, 2);
});

test("fetchWithRetry retries 500 and succeeds", async () => {
  const mock = mockFetch([
    { status: 500 },
    { status: 200 },
  ]);
  const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
  assert.equal(res.status, 200);
  assert.equal(mock.callCount, 2);
});

test("fetchWithRetry retries 502 and succeeds", async () => {
  const mock = mockFetch([
    { status: 502 },
    { status: 200 },
  ]);
  const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
  assert.equal(res.status, 200);
  assert.equal(mock.callCount, 2);
});

test("fetchWithRetry retries 503 and succeeds", async () => {
  const mock = mockFetch([
    { status: 503 },
    { status: 503 },
    { status: 200 },
  ]);
  const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
  assert.equal(res.status, 200);
  assert.equal(mock.callCount, 3);
});

test("fetchWithRetry does not retry when maxRetries is 0", async () => {
  const mock = mockFetch([
    { status: 503 },
    { status: 200 },
  ]);
  const res = await fetchWithRetry("http://test.com/api", undefined, { ...FAST, maxRetries: 0 });
  assert.equal(res.status, 503);
  assert.equal(mock.callCount, 1);
});

test("fetchWithRetry gives up after MAX_RETRIES", async () => {
  const mock = mockFetch([
    { status: 503 },
    { status: 503 },
    { status: 503 },
    { status: 503 },
  ]);
  const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
  assert.equal(res.status, 503);
  assert.equal(mock.callCount, 4);
});

test("fetchWithRetry retries network errors with transient cause code", async () => {
  const mock = mockFetch([
    { error: "fetch failed", causeCode: "ECONNRESET" },
    { status: 200 },
  ]);
  const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
  assert.equal(res.status, 200);
  assert.equal(mock.callCount, 2);
});

test("fetchWithRetry does not retry generic fetch failed without transient cause", async () => {
  const mock = mockFetch([{ error: "fetch failed" }]);
  await assert.rejects(
    () => fetchWithRetry("http://test.com/api", undefined, FAST),
    { message: "fetch failed" }
  );
  assert.equal(mock.callCount, 1);
});

test("fetchWithRetry retries ECONNRESET", async () => {
  const mock = mockFetch([
    { error: "read ECONNRESET" },
    { status: 200 },
  ]);
  const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
  assert.equal(res.status, 200);
  assert.equal(mock.callCount, 2);
});

test("fetchWithRetry retries ETIMEDOUT", async () => {
  const mock = mockFetch([
    { error: "connect ETIMEDOUT" },
    { status: 200 },
  ]);
  const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
  assert.equal(res.status, 200);
  assert.equal(mock.callCount, 2);
});

test("fetchWithRetry retries ECONNREFUSED", async () => {
  const mock = mockFetch([
    { error: "connect ECONNREFUSED 127.0.0.1:443" },
    { status: 200 },
  ]);
  const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
  assert.equal(res.status, 200);
  assert.equal(mock.callCount, 2);
});

test("fetchWithRetry retries ECONNREFUSED via cause code", async () => {
  const mock = mockFetch([
    { error: "fetch failed", causeCode: "ECONNREFUSED" },
    { status: 200 },
  ]);
  const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
  assert.equal(res.status, 200);
  assert.equal(mock.callCount, 2);
});

test("fetchWithRetry retries UND_ERR_CONNECT_TIMEOUT", async () => {
  const mock = mockFetch([
    { error: "fetch failed", causeCode: "UND_ERR_CONNECT_TIMEOUT" },
    { status: 200 },
  ]);
  const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
  assert.equal(res.status, 200);
  assert.equal(mock.callCount, 2);
});

test("fetchWithRetry retries UND_ERR_CONNECT_TIMEOUT in message", async () => {
  const mock = mockFetch([
    { error: "UND_ERR_CONNECT_TIMEOUT: connect timeout" },
    { status: 200 },
  ]);
  const res = await fetchWithRetry("http://test.com/api", undefined, FAST);
  assert.equal(res.status, 200);
  assert.equal(mock.callCount, 2);
});

test("fetchWithRetry does not retry unknown errors", async () => {
  const mock = mockFetch([{ error: "something completely unexpected" }]);
  await assert.rejects(
    () => fetchWithRetry("http://test.com/api", undefined, FAST),
    { message: "something completely unexpected" }
  );
  assert.equal(mock.callCount, 1);
});

test("fetchWithRetry does not retry non-Error throws", async () => {
  let callCount = 0;
  mock.method(globalThis, "fetch", async () => {
    callCount++;
    throw "string error";
  });
  await assert.rejects(
    () => fetchWithRetry("http://test.com/api", undefined, FAST),
    (err: unknown) => err === "string error"
  );
  assert.equal(callCount, 1);
});

test("fetchWithRetry respects Retry-After header over base delay", async () => {
  mockFetch([
    { status: 429, headers: { "retry-after": "1" } },
    { status: 200 },
  ]);
  const delays: number[] = [];
  const trackingSleep: SleepFn = async (ms) => { delays.push(ms); };
  const res = await fetchWithRetry("http://test.com/api", undefined, { baseDelayMs: 5000, log: () => {}, sleepFn: trackingSleep });
  assert.equal(res.status, 200);
  assert.ok(delays[0] >= 1000 && delays[0] < 5000, `Should use Retry-After: 1 (1000ms) not base delay (5000ms), got ${delays[0]}ms`);
});

test("fetchWithRetry treats past-date Retry-After as immediate retry", async () => {
  const pastDate = new Date(Date.now() - 60000).toUTCString();
  const mock = mockFetch([
    { status: 429, headers: { "retry-after": pastDate } },
    { status: 200 },
  ]);
  const delays: number[] = [];
  const trackingSleep: SleepFn = async (ms) => { delays.push(ms); };
  const res = await fetchWithRetry("http://test.com/api", undefined, { ...FAST, sleepFn: trackingSleep });
  assert.equal(res.status, 200);
  assert.equal(mock.callCount, 2);
  assert.equal(delays[0], 0, "Past-date Retry-After should result in immediate retry (0ms)");
});

test("fetchWithRetry treats Retry-After: 0 as immediate retry", async () => {
  const mock = mockFetch([
    { status: 429, headers: { "retry-after": "0" } },
    { status: 200 },
  ]);
  const delays: number[] = [];
  const trackingSleep: SleepFn = async (ms) => { delays.push(ms); };
  const res = await fetchWithRetry("http://test.com/api", undefined, { ...FAST, sleepFn: trackingSleep });
  assert.equal(res.status, 200);
  assert.equal(mock.callCount, 2);
  assert.equal(delays[0], 0, "Retry-After: 0 should result in immediate retry (0ms)");
});

test("fetchWithRetry caps large Retry-After to maxDelayMs", async () => {
  const mock = mockFetch([
    { status: 429, headers: { "retry-after": "3600" } },
    { status: 200 },
  ]);
  const delays: number[] = [];
  const trackingSleep: SleepFn = async (ms) => { delays.push(ms); };
  const res = await fetchWithRetry("http://test.com/api", undefined, { baseDelayMs: 0, maxDelayMs: 1000, log: () => {}, sleepFn: trackingSleep });
  assert.equal(res.status, 200);
  assert.equal(mock.callCount, 2);
  assert.ok(delays[0] <= 1000, `Should cap at maxDelayMs (1000ms), got ${delays[0]}ms`);
  assert.ok(delays[0] >= 500, `Should be at least MIN_RETRY_DELAY_MS (500ms), got ${delays[0]}ms`);
});

test("DEFAULT_MAX_DELAY_MS is 30 seconds", () => {
  assert.equal(DEFAULT_MAX_DELAY_MS, 30_000);
});

test("fetchWithRetry applies jitter to retry delay", async () => {
  mockFetch([
    { status: 503 },
    { status: 200 },
  ]);
  const baseDelayMs = 1000;
  const delays: number[] = [];
  const trackingSleep: SleepFn = async (ms) => { delays.push(ms); };
  const res = await fetchWithRetry("http://test.com/api", undefined, { baseDelayMs, log: () => {}, sleepFn: trackingSleep });
  assert.equal(res.status, 200);
  const minExpected = baseDelayMs * 0.7;
  const maxExpected = baseDelayMs * 1.3;
  assert.ok(
    delays[0] >= minExpected && delays[0] <= maxExpected,
    `Expected delay with jitter between ${minExpected}-${maxExpected}ms, got ${delays[0]}ms`
  );
});

test("fetchWithRetry aborts sleep when signal is aborted", async () => {
  const mock = mockFetch([
    { status: 503 },
    { status: 200 },
  ]);
  const controller = new AbortController();
  const abortingSleep: SleepFn = async (_ms, signal) => {
    controller.abort();
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
  };
  await assert.rejects(
    () => fetchWithRetry("http://test.com/api", { signal: controller.signal }, { baseDelayMs: 10_000, log: () => {}, sleepFn: abortingSleep }),
    (err: Error) => err.name === "AbortError"
  );
  assert.equal(mock.callCount, 1);
});

test("fetchWithRetry passes same url and init on every attempt", async () => {
  const calls: Array<{ url: string | URL | Request; init?: RequestInit }> = [];
  let callCount = 0;
  mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url, init });
    callCount++;
    if (callCount < 3) {
      return {
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        headers: new Headers(),
        body: { cancel: async () => {} },
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: { cancel: async () => {} },
    } as unknown as Response;
  });

  const customHeaders = { Authorization: "Bearer tok", Accept: "application/json" };
  const res = await fetchWithRetry(
    "http://test.com/api/v1/courses",
    { headers: customHeaders },
    FAST
  );
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url, "http://test.com/api/v1/courses");
    assert.deepEqual(call.init?.headers, customHeaders);
  }
});

test("CanvasClient retries 503 during pagination and continues", async () => {
  let callCount = 0;
  mock.method(globalThis, "fetch", async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ link: '<http://test.com/api?page=2>; rel="next"' }),
        body: { cancel: async () => {} },
        json: async () => [{ id: 1 }],
      } as unknown as Response;
    }
    if (callCount === 2) {
      return {
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        headers: new Headers(),
        body: { cancel: async () => {} },
        json: async () => ({}),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: { cancel: async () => {} },
      json: async () => [{ id: 2 }],
    } as unknown as Response;
  });

  const client = new CanvasClient({ baseUrl: "http://test.com", accessToken: "token" }, FAST);
  const courses = await (client as any).fetchPaginated("http://test.com/api?page=1");
  assert.equal(callCount, 3);
  assert.deepEqual(courses, [{ id: 1 }, { id: 2 }]);
});

test("CanvasClient fetchPaginatedSafe returns [] after retry exhaustion on 503", async () => {
  mock.method(globalThis, "fetch", async () => {
    return {
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      headers: new Headers(),
      body: { cancel: async () => {} },
      json: async () => ({}),
    } as unknown as Response;
  });

  const client = new CanvasClient({ baseUrl: "http://test.com", accessToken: "token" }, FAST);
  const result = await (client as any).fetchPaginatedSafe("http://test.com/api?page=1");
  assert.deepEqual(result, []);
});

test("CanvasClient fetchPaginatedSafe returns [] after retry exhaustion on 500", async () => {
  mock.method(globalThis, "fetch", async () => {
    return {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers(),
      body: { cancel: async () => {} },
      json: async () => ({}),
    } as unknown as Response;
  });

  const client = new CanvasClient({ baseUrl: "http://test.com", accessToken: "token" }, FAST);
  const result = await (client as any).fetchPaginatedSafe("http://test.com/api?page=1");
  assert.deepEqual(result, []);
});
