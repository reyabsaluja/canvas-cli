import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import { resolveImplicitCommandIntent } from "../src/tui/input-intents.js";
import { COMMANDS, getAvailableCommands } from "../src/tui/commands.js";
import {
  collectOpenableResources,
  handleOpenResourceQuery,
} from "../src/tui/open-resources.js";

async function withTempDir(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-open-test-"));
  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("implicit open intent only triggers in course and workspace scopes", () => {
  assert.equal(
    resolveImplicitCommandIntent(
      "open lab 4 pdf",
      getAvailableCommands(COMMANDS, "global"),
      "global"
    ),
    null
  );

  assert.deepEqual(
    resolveImplicitCommandIntent(
      "open lab 4 pdf",
      getAvailableCommands(COMMANDS, "course"),
      "course"
    ),
    { commandName: "/open", args: "lab 4 pdf" }
  );

  assert.deepEqual(
    resolveImplicitCommandIntent(
      "Open",
      getAvailableCommands(COMMANDS, "workspace"),
      "workspace"
    ),
    { commandName: "/open", args: "" }
  );
});

test("collectOpenableResources includes workspace files and downloaded course attachments", async () => {
  await withTempDir(async (tempDir) => {
    const workspacePath = path.join(tempDir, "workspace");
    const coursePath = path.join(tempDir, "course");

    await fs.mkdir(path.join(workspacePath, "attachments"), { recursive: true });
    await fs.mkdir(path.join(coursePath, "attachments"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "assignment.md"), "# Assignment\n", "utf-8");
    await fs.writeFile(
      path.join(workspacePath, "attachments", "starter.zip"),
      "starter",
      "utf-8"
    );
    await fs.writeFile(
      path.join(coursePath, "attachments", "lab4-spec.pdf"),
      "pdf",
      "utf-8"
    );

    const loaded: LoadedWorkspace = {
      path: workspacePath,
      sessionSlug: "lab-4",
      assignmentId: 42,
      assignmentName: "Lab 4",
      courseId: 17,
      courseName: "ECE243",
      courseCode: "ECE243H1",
      preparedAt: null,
      workspaceState: "ready",
      assignmentMd: "# Assignment\n",
      planMd: null,
      notesMd: null,
      workupJson: null,
      extractedFiles: [],
    };

    const cache: CourseCache = {
      courseId: 17,
      coursePath,
      assignments: [],
      modules: [],
      files: [],
      pages: [],
      syllabusCandidates: [],
      attachments: [
        {
          sourceType: "important_file",
          canvasFileId: 99,
          originalFilename: "lab4-spec.pdf",
          localPath: "attachments/lab4-spec.pdf",
          contentType: "application/pdf",
          size: 42,
          downloadUrl: "https://canvas.example/files/99",
          reason: "lab handout",
          status: "downloaded",
        },
      ],
      ingestion: null,
    };

    const resources = await collectOpenableResources({ loaded, cache });
    assert.ok(resources.some((resource) => resource.title === "assignment.md"));
    assert.ok(resources.some((resource) => resource.title === "starter.zip"));
    assert.ok(resources.some((resource) => resource.title === "lab4-spec.pdf"));
  });
});

test("handleOpenResourceQuery opens matching downloaded resources and reports ambiguity", async () => {
  await withTempDir(async (tempDir) => {
    const coursePath = path.join(tempDir, "course");
    await fs.mkdir(path.join(coursePath, "attachments"), { recursive: true });
    const specPath = path.join(coursePath, "attachments", "lab4-spec.pdf");
    const rubricPath = path.join(coursePath, "attachments", "lab4-rubric.pdf");
    await fs.writeFile(specPath, "spec", "utf-8");
    await fs.writeFile(rubricPath, "rubric", "utf-8");

    const cache: CourseCache = {
      courseId: 17,
      coursePath,
      assignments: [],
      modules: [],
      files: [],
      pages: [],
      syllabusCandidates: [],
      attachments: [
        {
          sourceType: "important_file",
          canvasFileId: 1,
          originalFilename: "lab4-spec.pdf",
          localPath: "attachments/lab4-spec.pdf",
          contentType: "application/pdf",
          size: 10,
          downloadUrl: "https://canvas.example/files/1",
          reason: "spec",
          status: "downloaded",
        },
        {
          sourceType: "important_file",
          canvasFileId: 2,
          originalFilename: "lab4-rubric.pdf",
          localPath: "attachments/lab4-rubric.pdf",
          contentType: "application/pdf",
          size: 10,
          downloadUrl: "https://canvas.example/files/2",
          reason: "rubric",
          status: "downloaded",
        },
      ],
      ingestion: null,
    };

    const opened: string[] = [];
    const openedResult = await handleOpenResourceQuery(
      "lab 4 spec pdf",
      { cache },
      async (resource) => {
        opened.push(resource.target);
      }
    );

    assert.equal(openedResult.status, "opened");
    assert.equal(opened[0], specPath);
    assert.match(openedResult.message, /Opened lab4-spec\.pdf/);

    const ambiguousResult = await handleOpenResourceQuery(
      "lab 4 pdf",
      { cache },
      async () => {
        throw new Error("should not open ambiguous match");
      }
    );

    assert.equal(ambiguousResult.status, "ambiguous");
    assert.match(ambiguousResult.message, /Multiple resources matched/);
  });
});
