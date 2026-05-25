import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MissingCourseCacheError, runWorkspaceLifecycle } from "../src/workspace/lifecycle.js";

test("MissingCourseCacheError includes recovery hint", () => {
  const err = new MissingCourseCacheError("ECE243H1");
  assert.match(err.message, /\/refresh/);
  assert.match(err.message, /re-enter the course/);
  assert.equal(err.courseCode, "ECE243H1");
  assert.equal(err.name, "MissingCourseCacheError");
});

test("runWorkspaceLifecycle with require_existing throws MissingCourseCacheError when no cache", async () => {
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-lifecycle-"));
  process.chdir(tempDir);

  try {
    await assert.rejects(
      runWorkspaceLifecycle({
        aiConfig: { provider: "openai", model: "gpt-4o", apiKey: "fake" } as any,
        detail: { id: 1, name: "Test Assignment", courseName: "Test" } as any,
        course: { id: 99, name: "Test Course", courseCode: "TEST101", termName: "Fall", isCurrent: true },
        client: {} as any,
        config: { baseUrl: "https://example.com", accessToken: "fake" },
        cachePolicy: "require_existing",
      }),
      (err: Error) => {
        assert.ok(err instanceof MissingCourseCacheError);
        assert.equal(err.name, "MissingCourseCacheError");
        return true;
      }
    );
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
