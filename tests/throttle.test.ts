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
  // 50/100 remaining → ratio=0.5 → delay = 500*(1+0.5*3) = 1250
  assert.equal(delays[0], 1250);
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
  // 30/50 remaining → ratio=0.4 → delay = 1000*(1+0.4*3) = 2200
  assert.equal(delays[0], 2200);
});

test("throttle delay increases as remaining approaches zero", async () => {
  const delays: number[] = [];
  const sleepFn = async (ms: number) => { delays.push(ms); };
  const throttle = new RateLimitThrottle({ sleepFn });

  // remaining=99 (just below threshold) → ratio≈0.01 → minimal extra delay
  throttle.update(new Response(null, { headers: { "x-rate-limit-remaining": "99" } }));
  await throttle.throttleIfNeeded();

  // remaining=0 → ratio=1 → max delay = 500*(1+1*3) = 2000
  throttle.update(new Response(null, { headers: { "x-rate-limit-remaining": "0" } }));
  await throttle.throttleIfNeeded();

  assert.ok(delays[1] > delays[0], `Delay at 0 (${delays[1]}) should exceed delay at 99 (${delays[0]})`);
  assert.equal(delays[1], 2000);
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

test("throttle reads x-request-cost header", async () => {
  const throttle = new RateLimitThrottle({ sleepFn: async () => {} });
  throttle.update(new Response(null, { headers: { "x-rate-limit-remaining": "80", "x-request-cost": "5" } }));
  assert.equal(throttle.currentCost, 5);
});

test("throttle increases delay for high-cost requests", async () => {
  const delays: number[] = [];
  const sleepFn = async (ms: number) => { delays.push(ms); };

  const throttleLow = new RateLimitThrottle({ sleepFn });
  throttleLow.update(new Response(null, { headers: { "x-rate-limit-remaining": "50", "x-request-cost": "1" } }));
  await throttleLow.throttleIfNeeded();

  const throttleHigh = new RateLimitThrottle({ sleepFn });
  throttleHigh.update(new Response(null, { headers: { "x-rate-limit-remaining": "50", "x-request-cost": "5" } }));
  await throttleHigh.throttleIfNeeded();

  assert.ok(delays[1] > delays[0], `High-cost delay (${delays[1]}) should exceed low-cost delay (${delays[0]})`);
});

test("throttle ignores invalid x-request-cost values", async () => {
  const throttle = new RateLimitThrottle({ sleepFn: async () => {} });
  throttle.update(new Response(null, { headers: { "x-request-cost": "0" } }));
  assert.equal(throttle.currentCost, 1);
  throttle.update(new Response(null, { headers: { "x-request-cost": "-2" } }));
  assert.equal(throttle.currentCost, 1);
  throttle.update(new Response(null, { headers: { "x-request-cost": "abc" } }));
  assert.equal(throttle.currentCost, 1);
});
