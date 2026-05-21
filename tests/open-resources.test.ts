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
  isRecentExportQuery,
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

test("handleOpenResourceQuery does not open resources for unrelated queries", async () => {
  await withTempDir(async (tempDir) => {
    const workspacePath = path.join(tempDir, "workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, "assignment.md"), "# Assignment\n", "utf-8");

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

    const opened: string[] = [];
    const result = await handleOpenResourceQuery(
      "zyxwv qplm",
      { loaded },
      async (resource) => {
        opened.push(resource.target);
      }
    );

    assert.equal(result.status, "missing");
    assert.deepEqual(opened, []);
    assert.equal(result.matches, undefined);
    assert.match(result.message, /No openable resource matched "zyxwv qplm"/);
    assert.doesNotMatch(result.message, /Closest resources/);
  });
});

test("handleOpenResourceQuery suggests close resources for typos without opening them", async () => {
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
          reason: "lab specification",
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
          reason: "grading rubric",
          status: "downloaded",
        },
      ],
      lectures: [],
      ingestion: null,
    };

    const opened: string[] = [];
    const result = await handleOpenResourceQuery(
      "labb specifcation",
      { cache },
      async (resource) => {
        opened.push(resource.target);
      }
    );

    assert.equal(result.status, "missing");
    assert.deepEqual(opened, []);
    assert.equal(result.matches?.[0]?.title, "lab4-spec.pdf");
    assert.match(result.message, /Closest resources:/);
    assert.match(result.message, /lab4-spec\.pdf/);
    assert.doesNotMatch(result.message, /Opened/);
  });
});

test("handleOpenResourceQuery opens a zip entry PDF directly rather than the parent zip", async () => {
  await withTempDir(async (tempDir) => {
    const coursePath = path.join(tempDir, "course");
    const innerDir = path.join(
      coursePath,
      "attachments",
      "reference",
      "exams.zip.unpacked",
      "2024"
    );
    await fs.mkdir(innerDir, { recursive: true });
    const zipPath = path.join(coursePath, "attachments", "reference", "exams.zip");
    const innerPdfPath = path.join(innerDir, "final_exam_2024.pdf");
    await fs.writeFile(zipPath, "zip-bytes", "utf-8");
    await fs.writeFile(innerPdfPath, "pdf-bytes", "utf-8");

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
          canvasFileId: 555,
          originalFilename: "exams.zip",
          localPath: "attachments/reference/exams.zip",
          contentType: "application/zip",
          size: 4096,
          downloadUrl: "https://canvas.example/files/555",
          reason: "past exam archive",
          status: "downloaded",
          zipEntries: [
            {
              entryName: "2024/final_exam_2024.pdf",
              filename: "final_exam_2024.pdf",
              localPath:
                "attachments/reference/exams.zip.unpacked/2024/final_exam_2024.pdf",
              extractedTextPath: null,
              size: 2048,
            },
          ],
        },
      ],
      lectures: [],
      ingestion: null,
    };

    const opened: string[] = [];
    const result = await handleOpenResourceQuery(
      "final_exam_2024.pdf",
      { cache },
      async (resource) => {
        opened.push(resource.target);
      }
    );

    assert.equal(result.status, "opened");
    assert.equal(opened[0], innerPdfPath);
    assert.match(result.message, /Opened final_exam_2024\.pdf \(zip entry\)/);
  });
});

test("handleOpenResourceQuery opens exported PDF instead of similarly named course files", async () => {
  await withTempDir(async (tempDir) => {
    const exportDir = path.join(tempDir, "exports");
    const coursePath = path.join(tempDir, "course");
    const exportPdf = path.join(
      exportDir,
      "20260519-230401-make-a-study-guide-for-final-exam.pdf"
    );
    const zipPdf = path.join(
      coursePath,
      "attachments/exams.zip.unpacked/._ECE243_Final_Exam_25_Solutions.pdf"
    );

    await fs.mkdir(exportDir, { recursive: true });
    await fs.mkdir(path.dirname(zipPdf), { recursive: true });
    await fs.writeFile(exportPdf, "%PDF-1.4 export", "utf-8");
    await fs.writeFile(zipPdf, "zip entry", "utf-8");

    const cache: CourseCache = {
      courseId: 420148,
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
          originalFilename: "exams.zip",
          localPath: "attachments/exams.zip",
          contentType: "application/zip",
          size: 100,
          downloadUrl: "https://example.com/exams.zip",
          reason: "exams",
          status: "downloaded",
          zipEntries: [
            {
              entryName: "._ECE243_Final_Exam_25_Solutions.pdf",
              filename: "._ECE243_Final_Exam_25_Solutions.pdf",
              localPath:
                "attachments/exams.zip.unpacked/._ECE243_Final_Exam_25_Solutions.pdf",
              extractedTextPath: null,
              size: 50,
            },
          ],
        },
      ],
      lectures: [],
      ingestion: null,
    };

    const opened: string[] = [];
    const result = await handleOpenResourceQuery(
      "20260519-230401-make-a-study-guide-for-final-exam.pdf",
      { cache, exportDirectories: [exportDir] },
      async (resource) => {
        opened.push(resource.target);
      }
    );

    assert.equal(result.status, "opened");
    assert.equal(opened[0], exportPdf);
    assert.match(result.message, /exported pdf/);
  });
});

test("handleOpenResourceQuery opens last export for vague 'the pdf' query", async () => {
  await withTempDir(async (tempDir) => {
    const exportDir = path.join(tempDir, "exports");
    const exportPdf = path.join(exportDir, "study-guide.pdf");
    await fs.mkdir(exportDir, { recursive: true });
    await fs.writeFile(exportPdf, "%PDF", "utf-8");

    const opened: string[] = [];
    const result = await handleOpenResourceQuery(
      "the pdf",
      {
        cache: null,
        exportDirectories: [exportDir],
        lastExportedPdfPath: exportPdf,
      },
      async (resource) => {
        opened.push(resource.target);
      }
    );

    assert.equal(result.status, "opened");
    assert.equal(opened[0], exportPdf);
  });
});

// ---------------------------------------------------------------------------
// isRecentExportQuery
// ---------------------------------------------------------------------------

test("isRecentExportQuery matches common user phrases for reopening exports", () => {
  const positives = [
    "the pdf",
    "my pdf",
    "open it",
    "the study guide",
    "export",
    "the file you made",
    "pdf you generated",
    "that pdf",
    "open the export",
    "this study guide",
  ];
  for (const q of positives) {
    assert.ok(isRecentExportQuery(q), `expected match for: "${q}"`);
  }
});

test("isRecentExportQuery rejects unrelated queries", () => {
  const negatives = [
    "lab1.pdf",
    "open the syllabus",
    "midterm solutions",
    "notes",
    "",
    "   ",
    "my pdf assignment about chapter 5",
  ];
  for (const q of negatives) {
    assert.ok(!isRecentExportQuery(q), `expected no match for: "${q}"`);
  }
});
