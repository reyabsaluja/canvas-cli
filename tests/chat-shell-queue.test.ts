import assert from "node:assert/strict";
import test from "node:test";
import { createSerialTaskQueue } from "../src/tui/serial-task-queue.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("serial task queue preserves input ordering under async work", async () => {
  const queue = createSerialTaskQueue();
  const seen: string[] = [];

  queue.enqueue(async () => {
    await sleep(20);
    seen.push("first");
  });
  queue.enqueue(async () => {
    seen.push("second");
  });
  queue.enqueue(async () => {
    await sleep(5);
    seen.push("third");
  });

  await queue.onIdle();
  assert.deepEqual(seen, ["first", "second", "third"]);
});

test("serial task queue drops tasks enqueued after close", async () => {
  const queue = createSerialTaskQueue();
  const seen: string[] = [];

  queue.enqueue(async () => {
    seen.push("before-close");
    queue.close();
  });
  queue.enqueue(async () => {
    seen.push("after-close");
  });

  await queue.onIdle();
  assert.deepEqual(seen, ["before-close"]);
});
