import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ESCAPED, promptLine, promptSecret } from "../src/commands/login-prompts.js";

class FakeStdin extends EventEmitter {
  isTTY = true;
  rawMode: boolean | null = null;
  paused = false;
  setRawMode(mode: boolean) {
    this.rawMode = mode;
    return this;
  }
  resume() {
    this.paused = false;
    return this;
  }
  pause() {
    this.paused = true;
    return this;
  }
}

/** Run `prompt` against a fake raw-mode stdin fed the given chunks. */
async function drive(
  prompt: (question: string) => Promise<string | typeof ESCAPED>,
  chunks: string[]
): Promise<{ result: string | typeof ESCAPED; stdin: FakeStdin; output: string }> {
  const stdin = new FakeStdin();
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const originalWrite = process.stdout.write;
  let output = "";
  // The prompt writes synchronously (while the question is issued and inside
  // the data handler); the test reporter writes in between. Capture only the
  // former so the reporter's output is not swallowed.
  let capturing = false;
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (capturing) {
      output += String(chunk);
      return true;
    }
    return (originalWrite as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  }) as typeof process.stdout.write;
  const captured = <T>(run: () => T): T => {
    capturing = true;
    try {
      return run();
    } finally {
      capturing = false;
    }
  };
  try {
    const pending = captured(() => prompt("? "));
    for (const chunk of chunks) {
      captured(() => stdin.emit("data", Buffer.from(chunk)));
      await new Promise((resolve) => setImmediate(resolve));
    }
    const result = await pending;
    return { result, stdin, output };
  } finally {
    process.stdout.write = originalWrite;
    Object.defineProperty(process, "stdin", originalDescriptor);
  }
}

test("promptLine ignores arrow-key escape sequences instead of aborting", async () => {
  const { result, stdin } = await drive(promptLine, ["\x1b[A", "abc\r"]);
  assert.equal(result, "abc");
  assert.equal(stdin.rawMode, false, "raw mode restored");
  assert.equal(stdin.paused, true, "stdin paused");
  assert.equal(stdin.listenerCount("data"), 0, "data listener removed");
});

test("promptLine skips a CSI sequence in the middle of a chunk", async () => {
  const { result } = await drive(promptLine, ["ab\x1b[1;5Dc\x1bOAd\r"]);
  assert.equal(result, "abcd");
});

test("promptLine keeps bracketed-paste content and drops the markers", async () => {
  const { result } = await drive(promptLine, ["\x1b[200~school.instructure.com\x1b[201~", "\r"]);
  assert.equal(result, "school.instructure.com");
});

test("promptLine still escapes on a bare Esc", async () => {
  const { result, stdin } = await drive(promptLine, ["\x1b"]);
  assert.equal(result, ESCAPED);
  assert.equal(stdin.rawMode, false);
});

test("promptSecret ignores arrow-key escape sequences and masks input", async () => {
  const { result, output } = await drive(promptSecret, ["\x1b[B", "tok3n\r"]);
  assert.equal(result, "tok3n");
  assert.doesNotMatch(output, /tok3n/, "secret is never echoed");
  assert.match(output, /•{5}/);
});

test("promptSecret still escapes on a bare Esc", async () => {
  const { result } = await drive(promptSecret, ["\x1b"]);
  assert.equal(result, ESCAPED);
});
