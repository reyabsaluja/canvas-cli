import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyError,
  isNetworkError,
  CanvasCliError,
  CanvasAuthError,
  CanvasNetworkError,
  CanvasNotFoundError,
  CanvasPermissionError,
  CanvasRateLimitError,
  CanvasServerError,
  ConfigError,
} from "../src/errors.js";
import { CanvasApiError } from "../src/canvas/errors.js";

test("isNetworkError", async (t) => {
  await t.test("returns false for non-Error values", () => {
    assert.equal(isNetworkError(null), false);
    assert.equal(isNetworkError("ECONNREFUSED"), false);
    assert.equal(isNetworkError(42), false);
  });

  await t.test("detects network error via cause.code", () => {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
    assert.equal(isNetworkError(err), true);
  });

  await t.test("detects ENOTFOUND in message", () => {
    const err = new Error("getaddrinfo ENOTFOUND canvas.example.com");
    assert.equal(isNetworkError(err), true);
  });

  await t.test("detects ETIMEDOUT in message", () => {
    const err = new Error("connect ETIMEDOUT 10.0.0.1:443");
    assert.equal(isNetworkError(err), true);
  });

  await t.test("does not match generic fetch failed without code", () => {
    const err = new TypeError("fetch failed");
    assert.equal(isNetworkError(err), false);
  });

  await t.test("does not match unrelated errors", () => {
    const err = new Error("Cannot read properties of undefined");
    assert.equal(isNetworkError(err), false);
  });
});

test("classifyError", async (t) => {
  await t.test("returns CanvasCliError instances unchanged", () => {
    const err = new CanvasAuthError();
    assert.strictEqual(classifyError(err), err);
  });

  await t.test("classifies CanvasApiError 401 as CanvasAuthError", () => {
    const err = new CanvasApiError(401, "Unauthorized");
    const classified = classifyError(err);
    assert.ok(classified instanceof CanvasAuthError);
    assert.equal(classified.kind, "auth");
    assert.equal(classified.cause, err);
  });

  await t.test("classifies CanvasApiError 403 as CanvasPermissionError", () => {
    const err = new CanvasApiError(403, "Forbidden");
    const classified = classifyError(err);
    assert.ok(classified instanceof CanvasPermissionError);
    assert.equal(classified.kind, "permission");
  });

  await t.test("classifies CanvasApiError 404 as CanvasNotFoundError", () => {
    const err = new CanvasApiError(404, "Not Found");
    const classified = classifyError(err);
    assert.ok(classified instanceof CanvasNotFoundError);
    assert.equal(classified.kind, "not_found");
  });

  await t.test("classifies CanvasApiError 429 as CanvasRateLimitError", () => {
    const err = new CanvasApiError(429, "Too Many Requests");
    const classified = classifyError(err);
    assert.ok(classified instanceof CanvasRateLimitError);
    assert.equal(classified.kind, "rate_limit");
    assert.equal(classified.retriable, true);
  });

  await t.test("classifies CanvasApiError 5xx as CanvasServerError", () => {
    const err = new CanvasApiError(502, "Bad Gateway");
    const classified = classifyError(err);
    assert.ok(classified instanceof CanvasServerError);
    assert.equal(classified.kind, "server");
    assert.equal((classified as CanvasServerError).statusCode, 502);
  });

  await t.test("classifies CanvasApiError with unmapped code as unknown", () => {
    const err = new CanvasApiError(409, "Conflict");
    const classified = classifyError(err);
    assert.equal(classified.kind, "unknown");
    assert.equal(classified.cause, err);
  });

  await t.test("classifies network errors from plain Error", () => {
    const err = new Error("getaddrinfo ENOTFOUND canvas.example.com");
    const classified = classifyError(err);
    assert.ok(classified instanceof CanvasNetworkError);
    assert.equal(classified.kind, "network");
    assert.equal(classified.retriable, true);
  });

  await t.test("wraps unknown Error as CanvasCliError", () => {
    const err = new Error("something unexpected");
    const classified = classifyError(err);
    assert.ok(classified instanceof CanvasCliError);
    assert.equal(classified.kind, "unknown");
    assert.equal(classified.message, "something unexpected");
  });

  await t.test("wraps non-Error thrown values", () => {
    const classified = classifyError("string error");
    assert.ok(classified instanceof CanvasCliError);
    assert.equal(classified.kind, "unknown");
    assert.equal(classified.message, "An unexpected error occurred.");
  });

  await t.test("wraps null/undefined thrown values", () => {
    const classified = classifyError(null);
    assert.equal(classified.kind, "unknown");
    const classified2 = classifyError(undefined);
    assert.equal(classified2.kind, "unknown");
  });
});

test("CanvasCliError.userMessage", async (t) => {
  await t.test("includes recovery hint when present", () => {
    const err = new CanvasAuthError();
    assert.ok(err.userMessage.includes("Authentication failed."));
    assert.ok(err.userMessage.includes("CANVAS_ACCESS_TOKEN"));
  });

  await t.test("omits recovery hint when null", () => {
    const err = new CanvasCliError("bare error", "unknown");
    assert.equal(err.userMessage, "bare error");
  });
});

test("ConfigError", async (t) => {
  await t.test("has exit code 2", () => {
    const err = new ConfigError("missing config", "run login");
    assert.equal(err.exitCode, 2);
    assert.equal(err.kind, "config");
    assert.equal(err.recoveryHint, "run login");
  });
});
