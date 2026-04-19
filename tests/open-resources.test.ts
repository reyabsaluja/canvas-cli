import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import {
  buildShellOpenOptions,
  collectOpenableResources,
  handleOpenResourceQuery,
  searchOpenableResources,
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
      lectures: [],
      ingestion: null,
    };

    const resources = await collectOpenableResources({ loaded, cache });
    assert.ok(resources.some((resource) => resource.title === "assignment.md"));
    assert.ok(resources.some((resource) => resource.title === "starter.zip"));
    assert.ok(resources.some((resource) => resource.title === "lab4-spec.pdf"));
  });
});

test("buildShellOpenOptions disambiguates duplicate titles for the /open picker", () => {
  const options = buildShellOpenOptions([
    {
      id: "a",
      title: "lab4.pdf",
      kind: "downloaded attachment",
      targetType: "file",
      target: "/tmp/lab4.pdf",
      detail: "lab4.pdf",
      searchTerms: ["lab4.pdf"],
    },
    {
      id: "b",
      title: "lab4.pdf",
      kind: "course file",
      targetType: "url",
      target: "https://canvas.example/lab4",
      detail: "https://canvas.example/lab4",
      searchTerms: ["lab4.pdf"],
    },
  ]);

  assert.deepEqual(
    options.map((option) => option.query),
    ["lab4.pdf downloaded attachment", "lab4.pdf course file"]
  );
});

test("buildShellOpenOptions preserves aliases for picker search", () => {
  const [option] = buildShellOpenOptions([
    {
      id: "a",
      title: "lab4.pdf",
      kind: "downloaded attachment",
      targetType: "file",
      target: "/tmp/lab4.pdf",
      detail: "/tmp/lab4.pdf",
      searchTerms: ["lab 4 handout", "week 5 module", "starter pdf"],
    },
  ]);

  assert.deepEqual(option?.searchTerms?.includes("week 5 module"), true);

  const matches = searchOpenableResources(
    "week 5",
    [
      {
        id: "picker-option",
        title: option!.title,
        kind: option!.detail ?? "resource",
        targetType: "file",
        target: option!.query,
        detail: option!.detail,
        searchTerms: option!.searchTerms ?? [],
      },
    ],
    8
  );

  assert.equal(matches[0]?.title, "lab4.pdf");
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
      lectures: [],
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
