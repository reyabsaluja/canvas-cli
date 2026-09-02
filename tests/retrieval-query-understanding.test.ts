import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LoadedWorkspace } from "../src/ask/types.js";
import type { CourseCache } from "../src/enrich/cache-loader.js";
import {
  getExtractedAssignmentPath,
  getExtractedDiscussionPath,
  getExtractedPagePath,
} from "../src/enrich/course-documents.js";
import {
  analyzeSearchQuery,
  clearArtifactIndexCache,
  stemSearchToken,
} from "../src/knowledge/artifact-index.js";
import {
  buildWorkspaceRetrievalContext,
  retrieveRelevant,
} from "../src/ask/retrieve.js";
import { searchCourseArtifacts } from "../src/tui/course-retrieval.js";
import {
  readWorkspaceKnowledgeArtifact,
  searchWorkspaceKnowledge,
} from "../src/tui/workspace-knowledge.js";

async function withTempDir(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-cli-retrieval-query-")
  );
  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function createWorkspace(tempDir: string): Promise<LoadedWorkspace> {
  const workspacePath = path.join(tempDir, "workspace");
  await fs.mkdir(path.join(workspacePath, "extracted", "docs"), {
    recursive: true,
  });
  const assignmentMd = [
    "# Assignment",
    "",
    "## Overview",
    "",
    "Implement the datapath and capture the waveform.",
    "",
    "## Grading",
    "",
    "Reports are graded on clarity of the schematic and the analysis.",
    "",
    "## Submission",
    "",
    "Upload report.pdf and starter.zip together in Canvas.",
  ].join("\n");
  const planMd = "# Plan\nCapture the waveform before writing the analysis.\n";
  const referenceText =
    "The waveform must show stall cycles around the branch hazard.\n";
  await fs.writeFile(path.join(workspacePath, "assignment.md"), assignmentMd);
  await fs.writeFile(path.join(workspacePath, "plan.md"), planMd);
  await fs.writeFile(
    path.join(workspacePath, "extracted", "docs", "reference.txt"),
    referenceText
  );

  return {
    path: workspacePath,
    sessionSlug: "lab-4",
    assignmentId: 42,
    assignmentName: "Lab 4",
    courseId: 17,
    courseName: "ECE243",
    courseCode: "ECE243H1",
    preparedAt: "2026-04-02T09:00:00.000Z",
    workspaceState: "ready",
    assignmentMd,
    planMd,
    notesMd: null,
    workupJson: {
      overview: "Use the lab brief and extracted reference together.",
    },
    extractedFiles: [
      {
        name: "docs/reference.txt",
        relativePath: path.join("extracted", "docs", "reference.txt"),
      },
    ],
    extractedFileCache: new Map<string, string>(),
  };
}

/**
 * A course cache with the three kinds of text that confuse lexical retrieval:
 * a structured assignment brief, a discussion thread full of question words,
 * and a policy page whose wording is inflected differently from how students
 * ask about it.
 */
async function createCourseCache(tempDir: string): Promise<CourseCache> {
  const coursePath = path.join(tempDir, "course");
  const assignmentPath = getExtractedAssignmentPath(coursePath, 42);
  const discussionPath = getExtractedDiscussionPath(coursePath, 7);
  const pagePath = getExtractedPagePath(coursePath, "late-policy");
  await Promise.all(
    [assignmentPath, discussionPath, pagePath].map((filePath) =>
      fs.mkdir(path.dirname(filePath), { recursive: true })
    )
  );

  await fs.writeFile(
    assignmentPath,
    [
      "# Lab 4",
      "",
      "## Overview",
      "",
      "Implement the datapath and capture the waveform.",
      "",
      "## Report requirements",
      "",
      "The report must include the schematic, waveform captures, and a short analysis of stall cycles.",
      "",
      "## Branch hazards",
      "",
      "Stall cycles are inserted around branch hazards so the pipeline recovers.",
      "",
      "## Deadline",
      "",
      "The report is due April 10 at 11:59 PM.",
      "",
      "## Submissions",
      "",
      "Submissions are accepted through Canvas only.",
    ].join("\n")
  );
  await fs.writeFile(
    discussionPath,
    [
      "# Lab 4 Q&A",
      "",
      "What should I do if my board does not boot? I tried everything and I do not know what else I should try for the lab.",
      "",
      "Reply: Check the power jumper first, then ask in office hours.",
    ].join("\n")
  );
  await fs.writeFile(
    pagePath,
    [
      "# Late policy",
      "",
      "Late assignments receive a 10% penalty per day, to a maximum of three days.",
    ].join("\n")
  );

  return {
    courseId: 17,
    coursePath,
    assignments: [
      {
        id: 42,
        name: "Lab 4",
        dueAt: "2026-04-10T23:59:00.000Z",
        unlockAt: null,
        lockAt: null,
        pointsPossible: 100,
        gradingType: "points",
        submissionTypes: ["online_upload"],
        htmlUrl: "https://canvas.example/courses/17/assignments/42",
        hasDescription: true,
        descriptionLinkCount: 0,
      },
    ],
    modules: [],
    files: [],
    pages: [
      {
        pageId: "late-policy",
        title: "Late policy",
        htmlUrl: null,
        updatedAt: null,
        hasBody: true,
      },
    ],
    discussions: [
      {
        id: 7,
        title: "Lab 4 Q&A",
        postedAt: null,
        lastReplyAt: null,
        htmlUrl: "https://canvas.example/courses/17/discussion_topics/7",
        userName: null,
        hasMessage: true,
        threadEntryCount: 1,
        participantCount: 2,
        messageFileLinkCount: 0,
        replyFileLinkCount: 0,
      },
    ],
    syllabusCandidates: [],
    attachments: [],
    lectures: [],
    ingestion: {
      version: 1,
      ingestedAt: "2026-04-01T12:00:00.000Z",
      courseId: 17,
      courseName: "ECE243",
      courseCode: "ECE243H1",
      refresh: false,
      counts: {
        assignments: 1,
        modules: 0,
        moduleItems: 0,
        files: 0,
        pages: 1,
        syllabusCandidates: 0,
        lectures: 0,
        attachmentsDownloaded: 0,
        attachmentsSkipped: 0,
        attachmentsFailed: 0,
      },
    },
  };
}

test("search tokens unify plural and inflected forms without touching identifiers", () => {
  const pairs: Array<[string, string]> = [
    ["hazards", "hazard"],
    ["graded", "grading"],
    ["grades", "grade"],
    ["policies", "policy"],
    ["penalties", "penalty"],
    ["submitted", "submit"],
    ["deadlines", "deadline"],
    ["requirements", "requirement"],
    ["stalled", "stall"],
    ["classes", "class"],
    ["modules", "module"],
  ];
  for (const [left, right] of pairs) {
    assert.equal(
      stemSearchToken(left),
      stemSearchToken(right),
      `${left} and ${right} should share a stem`
    );
  }

  // Words that only look like plurals or inflections stay distinct.
  assert.equal(stemSearchToken("syllabus"), "syllabus");
  assert.equal(stemSearchToken("analysis"), "analysis");
  assert.equal(stemSearchToken("class"), "class");
  assert.equal(stemSearchToken("bus"), "bus");
  assert.equal(stemSearchToken("lab4"), "lab4");
  assert.equal(stemSearchToken("2026"), "2026");
  assert.notEqual(stemSearchToken("branch"), stemSearchToken("brand"));
});

test("query analysis drops question scaffolding but keeps the content phrase", () => {
  const analysis = analyzeSearchQuery("What is the late policy?");
  assert.deepEqual(analysis.tokens, ["late", "policy"]);
  assert.deepEqual(analysis.phrases, ["what is the late policy?", "late policy"]);

  const inflected = analyzeSearchQuery("When are the deadlines for the reports?");
  assert.deepEqual(inflected.tokens, ["deadlin", "report"]);

  // A query made only of scaffolding still has something to match on.
  const scaffoldingOnly = analyzeSearchQuery("what is it");
  assert.deepEqual(scaffoldingOnly.tokens, ["what", "is", "it"]);
  assert.deepEqual(scaffoldingOnly.phrases, ["what is it"]);

  // Filenames and identifiers are preserved for direct lookups.
  assert.deepEqual(analyzeSearchQuery("lab4-spec.pdf").tokens, ["lab4", "spec", "pdf"]);
});

test("question words no longer pull section search toward Q&A threads that merely share them", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const workspace = await createWorkspace(tempDir);
    const cache = await createCourseCache(tempDir);

    const matches = await searchWorkspaceKnowledge(
      workspace,
      cache,
      "What should I do for the lab report?",
      3
    );

    assert.ok(matches.length > 0);
    assert.equal(matches[0]?.artifact.title, "Lab 4");
    assert.match(matches[0]?.header ?? "", /Report requirements/);
    // The Q&A thread shares "what", "should", "do", "for" and "lab" with the
    // question; only "lab" counts now, so it must trail the actual answer.
    const discussion = matches.find((match) => match.artifact.kind === "discussion");
    if (discussion) {
      assert.ok(
        discussion.score < (matches[0]?.score ?? 0) / 2,
        `Q&A scored ${discussion.score} against top ${matches[0]?.score}`
      );
    }

    // A question with no content overlap returns nothing instead of noise.
    const unrelated = await searchWorkspaceKnowledge(
      workspace,
      cache,
      "What should I do this weekend?",
      3
    );
    assert.deepEqual(unrelated, []);
  });
});

test("document-level course search is ranked by content words, not by shared question words", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const cache = await createCourseCache(tempDir);

    const matches = await searchCourseArtifacts(
      cache,
      "What should I do for the lab report?"
    );
    assert.equal(matches[0]?.artifact.title, "Lab 4");
    assert.ok(
      (matches[0]?.score ?? 0) > 2 * (matches[1]?.score ?? 0),
      `expected a clear margin, got ${matches.map((m) => `${m.artifact.title}=${m.score}`).join(", ")}`
    );

    // The content phrase of a question matches a page title directly.
    const policy = await searchCourseArtifacts(cache, "What is the late policy?");
    assert.equal(policy[0]?.artifact.title, "Late policy");

    // Exact titles still win when a user names a document.
    const qa = await searchCourseArtifacts(cache, "Lab 4 Q&A");
    assert.equal(qa[0]?.artifact.kind, "discussion");
  });
});

test("inflected question wording matches the section that answers it", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const workspace = await createWorkspace(tempDir);
    const cache = await createCourseCache(tempDir);

    const deadlines = await searchWorkspaceKnowledge(
      workspace,
      cache,
      "When are the deadlines?",
      3
    );
    assert.match(deadlines[0]?.header ?? "", /Deadline/);
    assert.match(deadlines[0]?.preview ?? "", /April 10 at 11:59 PM/);

    const hazard = await searchWorkspaceKnowledge(
      workspace,
      cache,
      "What happens on a branch hazard in the pipeline?",
      3
    );
    assert.equal(hazard[0]?.artifact.title, "Lab 4");
    assert.match(hazard[0]?.header ?? "", /Branch hazards/);

    const penalty = await searchWorkspaceKnowledge(
      workspace,
      cache,
      "Are there penalties for late work?",
      3
    );
    assert.equal(penalty[0]?.artifact.title, "Late policy");
  });
});

test("ask retrieval matches inflected workspace sections and keeps direct reads working", async () => {
  await withTempDir(async (tempDir) => {
    clearArtifactIndexCache();
    const workspace = await createWorkspace(tempDir);

    const context = await buildWorkspaceRetrievalContext(workspace);
    const graded = retrieveRelevant("How is the report graded?", context, 3);
    assert.equal(graded[0]?.source, "assignment.md");
    assert.equal(graded[0]?.section, "Grading");

    const hazards = retrieveRelevant("Explain the branch hazards.", context, 3);
    assert.equal(hazards[0]?.source, "extracted/docs/reference.txt");

    // Stemming must not break exact filename lookups for reads.
    const read = await readWorkspaceKnowledgeArtifact(
      workspace,
      null,
      "reference.txt",
      5000
    );
    assert.equal(read.status, "ok");
    if (read.status === "ok") {
      assert.equal(read.artifact.title, "docs/reference.txt");
    }
  });
});
