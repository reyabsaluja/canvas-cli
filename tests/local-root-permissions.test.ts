import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensurePrivateLocalRoot } from "../src/workspace/local-root.js";

test(".canvas-cli is created, and an existing one tightened, to owner-only", { skip: process.platform === "win32" }, () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "canvas-cli-root-"));
  try {
    ensurePrivateLocalRoot(cwd);
    assert.equal(statSync(path.join(cwd, ".canvas-cli")).mode & 0o777, 0o700);

    const other = mkdtempSync(path.join(os.tmpdir(), "canvas-cli-root-"));
    mkdirSync(path.join(other, ".canvas-cli"), { mode: 0o755 });
    ensurePrivateLocalRoot(other);
    assert.equal(statSync(path.join(other, ".canvas-cli")).mode & 0o777, 0o700);
    rmSync(other, { recursive: true, force: true });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
