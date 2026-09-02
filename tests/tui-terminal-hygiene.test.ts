import assert from "node:assert/strict";
import test from "node:test";
import { installShellCrashHandlers, restoreTerminal } from "../src/tui/chat-shell-terminal.js";

const WATCHED = ["SIGTERM", "SIGHUP", "uncaughtException", "unhandledRejection"] as const;

function makeFakeStdin(): NodeJS.ReadStream & { rawMode: boolean | null; paused: boolean } {
  const fake = {
    isTTY: true,
    rawMode: null as boolean | null,
    paused: false,
    setRawMode(mode: boolean) {
      fake.rawMode = mode;
      return fake;
    },
    pause() {
      fake.paused = true;
      return fake;
    },
  };
  return fake as unknown as NodeJS.ReadStream & { rawMode: boolean | null; paused: boolean };
}

function captureStdout(run: () => void): string {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return output;
}

test("installShellCrashHandlers registers handlers and removes them on leave", () => {
  const before = Object.fromEntries(WATCHED.map((e) => [e, process.listenerCount(e)]));

  const remove = installShellCrashHandlers(makeFakeStdin(), async () => {}, () => {});
  for (const event of WATCHED) {
    assert.equal(process.listenerCount(event), before[event]! + 1, `${event} handler added`);
  }

  remove();
  for (const event of WATCHED) {
    assert.equal(process.listenerCount(event), before[event], `${event} handler removed`);
  }

  // Calling the remover twice must be harmless (leave + crash path).
  remove();
  for (const event of WATCHED) {
    assert.equal(process.listenerCount(event), before[event]);
  }
});

test("crash handler restores the terminal, reports the error and exits non-zero", async () => {
  const stdin = makeFakeStdin();
  const logs: string[] = [];
  let flushed = false;
  let exitCode: number | null = null;
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const remove = installShellCrashHandlers(
    stdin,
    async () => {
      flushed = true;
    },
    (code) => {
      exitCode = code;
      resolveExit();
    },
    (message) => logs.push(message)
  );

  const handler = process.listeners("uncaughtException").at(-1) as (error: unknown) => void;
  const output = captureStdout(() => handler(new Error("boom")));
  await exited;
  remove();

  assert.equal(stdin.rawMode, false, "raw mode restored");
  assert.equal(stdin.paused, true, "stdin paused");
  assert.ok(output.includes("\x1B[?1000l\x1B[?1006l"), "mouse tracking disabled");
  assert.ok(output.includes("\x1B[?1049l"), "alternate screen left");
  assert.ok(output.includes("\x1B[?25h"), "cursor shown");
  assert.equal(flushed, true, "chat session flushed");
  assert.equal(exitCode, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /Unexpected error: Error: boom/);
});

test("restoreTerminal emits the teardown sequences in a safe order", () => {
  const stdin = makeFakeStdin();
  const output = captureStdout(() => restoreTerminal(stdin));
  const mouseOff = output.indexOf("\x1B[?1000l");
  const altOff = output.indexOf("\x1B[?1049l");
  const cursorOn = output.indexOf("\x1B[?25h");
  assert.ok(mouseOff >= 0 && altOff > mouseOff && cursorOn > altOff, output);
  assert.equal(stdin.rawMode, false);
});
