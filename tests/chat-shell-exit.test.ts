import assert from "node:assert/strict";
import test from "node:test";
import {
  exitShellAborted,
  USER_ABORT_EXIT_CODE,
} from "../src/tui/chat-shell-exit.js";

test("exitShellAborted exits with user abort code after cleanup", async () => {
  let closed = false;
  let exitCode: number | null = null;

  await assert.rejects(
    exitShellAborted(
      async () => {
        closed = true;
        return null;
      },
      (code) => {
        exitCode = code;
        throw new Error("exit");
      }
    ),
    /exit/
  );

  assert.equal(closed, true);
  assert.equal(exitCode, USER_ABORT_EXIT_CODE);
});

test("exitShellAborted reports persistence failures before exiting", async () => {
  const logs: string[] = [];

  await assert.rejects(
    exitShellAborted(
      async () => "disk full",
      (code) => {
        assert.equal(code, USER_ABORT_EXIT_CODE);
        throw new Error("exit");
      },
      (message) => {
        logs.push(message);
      }
    ),
    /exit/
  );

  assert.deepEqual(logs, ["Failed to save chat session: disk full"]);
});
