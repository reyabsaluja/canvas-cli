import assert from "node:assert/strict";
import test from "node:test";
import { RateLimitThrottle, THROTTLE_THRESHOLD, THROTTLE_DELAY_MS } from "../src/canvas/throttle.js";

test("throttle does not delay when no header has been seen", async () => {
  const delays: number[] = [];
  const throttle = new RateLimitThrottle({ sleepFn: async (ms) => { delays.push(ms); } });
  await throttle.throttleIfNeeded();
  assert.equal(delays.length, 0);
});

test("throttle does not delay when remaining is above threshold", async () => {
  const delays: number[] = [];
  const throttle = new RateLimitThrottle({ sleepFn: async (ms) => { delays.push(ms); } });
  const response = new Response(null, { headers: { "x-rate-limit-remaining": "200" } });
  throttle.update(response);
  await throttle.throttleIfNeeded();
  assert.equal(delays.length, 0);
});

test("throttle delays when remaining is below threshold", async () => {
  const delays: number[] = [];
  const throttle = new RateLimitThrottle({ sleepFn: async (ms) => { delays.push(ms); } });
  const response = new Response(null, { headers: { "x-rate-limit-remaining": "50" } });
  throttle.update(response);
  await throttle.throttleIfNeeded();
  assert.equal(delays.length, 1);
  assert.equal(delays[0], THROTTLE_DELAY_MS);
});

test("throttle delays at exactly threshold - 1", async () => {
  const delays: number[] = [];
  const throttle = new RateLimitThrottle({ sleepFn: async (ms) => { delays.push(ms); } });
  const response = new Response(null, { headers: { "x-rate-limit-remaining": String(THROTTLE_THRESHOLD - 1) } });
  throttle.update(response);
  await throttle.throttleIfNeeded();
  assert.equal(delays.length, 1);
});

test("throttle does not delay at exactly the threshold", async () => {
  const delays: number[] = [];
  const throttle = new RateLimitThrottle({ sleepFn: async (ms) => { delays.push(ms); } });
  const response = new Response(null, { headers: { "x-rate-limit-remaining": String(THROTTLE_THRESHOLD) } });
  throttle.update(response);
  await throttle.throttleIfNeeded();
  assert.equal(delays.length, 0);
});

test("throttle uses custom threshold and delay", async () => {
  const delays: number[] = [];
  const throttle = new RateLimitThrottle({ threshold: 50, delayMs: 1000, sleepFn: async (ms) => { delays.push(ms); } });
  const response = new Response(null, { headers: { "x-rate-limit-remaining": "30" } });
  throttle.update(response);
  await throttle.throttleIfNeeded();
  assert.equal(delays[0], 1000);
});

test("throttle logs when throttling", async () => {
  const logs: string[] = [];
  const throttle = new RateLimitThrottle({ sleepFn: async () => {}, log: (msg) => logs.push(msg) });
  const response = new Response(null, { headers: { "x-rate-limit-remaining": "10" } });
  throttle.update(response);
  await throttle.throttleIfNeeded();
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes("10 remaining"));
});

test("throttle ignores non-numeric header values", async () => {
  const throttle = new RateLimitThrottle({ sleepFn: async () => {} });
  const response = new Response(null, { headers: { "x-rate-limit-remaining": "abc" } });
  throttle.update(response);
  assert.equal(throttle.currentRemaining, null);
});

test("throttle tracks latest remaining value", async () => {
  const throttle = new RateLimitThrottle({ sleepFn: async () => {} });
  throttle.update(new Response(null, { headers: { "x-rate-limit-remaining": "200" } }));
  assert.equal(throttle.currentRemaining, 200);
  throttle.update(new Response(null, { headers: { "x-rate-limit-remaining": "150" } }));
  assert.equal(throttle.currentRemaining, 150);
});

test("throttle handles fractional remaining values", async () => {
  const delays: number[] = [];
  const throttle = new RateLimitThrottle({ sleepFn: async (ms) => { delays.push(ms); } });
  throttle.update(new Response(null, { headers: { "x-rate-limit-remaining": "45.5" } }));
  assert.equal(throttle.currentRemaining, 45.5);
  await throttle.throttleIfNeeded();
  assert.equal(delays.length, 1);
});
