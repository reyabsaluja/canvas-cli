import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CanvasClient } from "../src/canvas/client.js";
import type { Config } from "../src/config/env.js";
import type { Course } from "../src/domain/models.js";
import { ingestCourse } from "../src/ingest/ingest-course.js";
import { fetchCourseContent } from "../src/ingest/fetch-course-content.js";
import { renderIngestionSummary } from "../src/format/render-ingestion-summary.js";
import {
  createMockCanvasServer,
  startServer,
  stopServer,
  type MockServerData,
} from "./helpers/mock-canvas-server.js";
import {
  buildDefaultServerData,
  CS101_MIDTERM_RUBRIC,
  CS101_SUBMISSIONS,
  rewriteAttachmentUrls,
} from "./helpers/fixtures.js";

const COURSE: Course = {
  id: 101,
  name: "Introduction to Computer Science",
  courseCode: "CS101",
  termName: "Spring 2026",
  isCurrent: true,
};

async function withTempCwd(fn: () => Promise<void>): Promise<void> {
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-submission-feedback-"));
  process.chdir(tempDir);
  try {
    await fn();
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Serve the student's own graded midterm with a TA comment (plus attached
 * marked-up PDF) and a rubric assessment, and record every request path.
 */
async function startFeedbackServer(mutate?: (data: MockServerData) => void) {
  const data = buildDefaultServerData();
  const requests: string[] = [];
  data.onRequest = (_method, requestPath) => {
    requests.push(requestPath);
  };
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  const origin = `http://127.0.0.1:${port}`;
  const midterm = data.assignments.get(101)!.find((a) => a.id === 1003)!;
  midterm.rubric = CS101_MIDTERM_RUBRIC;
  data.submissions = new Map([
    [
      101,
      CS101_SUBMISSIONS.map((submission) => ({
        ...submission,
        submission_comments: (submission.submission_comments ?? []).map((comment) => ({
          ...comment,
          attachments: (comment.attachments ?? []).map((a) => rewriteAttachmentUrls(a, origin)),
        })),
      })),
    ],
  ]);
  mutate?.(data);
  const config: Config = { baseUrl: `${origin}/api/v1`, accessToken: "test-token-valid" };
  return { config, data, requests, stop: () => stopServer(server) };
}

const SUBMISSIONS_PATH = "/courses/101/students/submissions";

test("fetchCourseContent merges the student's own grader comments and rubric assessment into the assignment", async () => {
  const { config, requests, stop } = await startFeedbackServer();
  try {
    const raw = await fetchCourseContent(new CanvasClient(config, { maxRetries: 0 }), 101);
    assert.ok(requests.includes(SUBMISSIONS_PATH), "requests the caller's own submissions");
    const midterm = raw.assignments.find((a) => a.id === 1003);
    assert.ok(midterm);
    assert.equal(midterm.submission?.score, 87, "score from the assignment list is kept");
    const comments = midterm.submission?.submission_comments ?? [];
    assert.equal(comments.length, 1);
    assert.equal(comments[0]?.author_name, "TA Linus");
    assert.equal(midterm.submission?.rubric_assessment?._crit_1?.points, 8);
    assert.equal(raw.submissionFeedback.comments, 1);
  } finally {
    await stop();
  }
});

test("ingestCourse writes a Submission Feedback section and downloads the feedback PDF under attachments/submission-comments/", async () => {
  const { config, stop } = await startFeedbackServer();
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });

      const extract = await fs.readFile(
        path.join(result.coursePath, "extracted", "assignments", "1003.txt"),
        "utf-8"
      );
      assert.match(extract, /^## Submission Feedback$/m);
      assert.match(extract, /^### TA Linus — /m);
      // The HTML comment is preferred over the plain one (bold survives as **).
      assert.match(extract, /Good work on question 3; \*\*show your steps\*\* next time\./);
      assert.match(extract, /^### Rubric Assessment$/m);
      assert.match(extract, /#### Correctness/);
      assert.match(extract, /Points: 8 \/ 10/);
      assert.match(extract, /Rating: Mostly right \(8 points\)/);
      assert.match(extract, /Sign error in part \(b\)\./);
      assert.match(extract, /#### Clarity/);
      assert.match(extract, /Points: 5 \/ 5/);
      // The rubric itself still renders before the feedback.
      assert.ok(extract.indexOf("## Rubric") < extract.indexOf("## Submission Feedback"));
      assert.match(
        extract,
        /Attachments: midterm-feedback\.pdf \(attachments\/submission-comments\/midterm-feedback\.pdf\)/
      );

      const feedbackFile = result.attachments.find(
        (a) => a.originalFilename === "midterm-feedback.pdf"
      );
      assert.ok(feedbackFile, "feedback attachment is selected for download");
      assert.equal(feedbackFile.sourceType, "submission_comment_attachment");
      assert.equal(feedbackFile.status, "downloaded");
      assert.equal(feedbackFile.localPath, "attachments/submission-comments/midterm-feedback.pdf");
      assert.match(feedbackFile.reason, /submission feedback for "Midterm Exam" by TA Linus/);
      const onDisk = await fs.readFile(path.join(result.coursePath, feedbackFile.localPath), "utf-8");
      assert.match(onDisk, /mock content of midterm-feedback\.pdf/);

      assert.equal(result.ingestion.submissionFeedback?.comments, 1);
      assert.equal(result.ingestion.submissionFeedback?.rubricAssessments, 1);
      assert.equal(result.ingestion.submissionFeedback?.attachmentsDownloaded, 1);
      const summary = renderIngestionSummary(result);
      assert.match(summary, /1 grader comment/);
    });
  } finally {
    await stop();
  }
});

test("files linked from grader comments are resolved against the Canvas base URL", async () => {
  const { config, stop } = await startFeedbackServer((data) => {
    const midterm = data.submissions!.get(101)![0]!;
    const comment = midterm.submission_comments![0]!;
    comment.html_comment = [
      comment.html_comment,
      // A relative Canvas file link, the way the rich editor writes them.
      '<p>Marked-up copy: <a href="/files/5305/download?download_frd=1">marked-up-solution.txt</a>.</p>',
      // A file-shaped link on another host must be dropped, not attempted.
      '<p>Mirror: <a href="https://elsewhere.invalid/files/9999/download">external copy</a>.</p>',
    ].join("");
    // Served by GET /files/5305/download; not in CS101's Files tab, so only
    // the feedback selector can claim it.
    data.files.set(202, [
      {
        id: 5305,
        display_name: "marked-up-solution.txt",
        filename: "marked-up-solution.txt",
        content_type: "text/plain",
        size: 40,
        url: "https://canvas.example/files/5305/download",
        updated_at: null,
        folder_id: null,
      },
    ]);
  });
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });

      const linked = result.attachments.find((a) => a.originalFilename === "marked-up-solution.txt");
      assert.ok(linked, "the relative file link in the grader comment is selected");
      assert.equal(linked.sourceType, "submission_comment_attachment");
      assert.equal(linked.status, "downloaded");
      assert.equal(linked.localPath, "attachments/submission-comments/marked-up-solution.txt");
      assert.match(linked.reason, /linked in submission feedback for "Midterm Exam" by TA Linus/);
      assert.equal(
        linked.downloadUrl,
        `${config.baseUrl.replace(/\/api\/v1$/, "")}/files/5305/download?download_frd=1`,
        "the download URL is absolute on the Canvas origin"
      );
      const onDisk = await fs.readFile(path.join(result.coursePath, linked.localPath), "utf-8");
      assert.match(onDisk, /mock content of marked-up-solution\.txt/);

      assert.ok(
        !result.attachments.some((a) => a.downloadUrl.includes("elsewhere.invalid")),
        "an off-origin file link is dropped at selection time, not recorded as a failed download"
      );
      assert.equal(result.ingestion.submissionFeedback?.attachmentsDownloaded, 2);
    });
  } finally {
    await stop();
  }
});

test("with submission feedback off, no submissions request is made and no section is written", async () => {
  const { config, requests, stop } = await startFeedbackServer();
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, {
        refresh: false,
        includeSubmissionFeedback: false,
      });
      assert.ok(
        !requests.includes(SUBMISSIONS_PATH),
        "the submissions endpoint is never requested when feedback is off"
      );
      const extract = await fs.readFile(
        path.join(result.coursePath, "extracted", "assignments", "1003.txt"),
        "utf-8"
      );
      assert.doesNotMatch(extract, /Submission Feedback/);
      assert.doesNotMatch(extract, /Rubric Assessment/);
      assert.ok(
        !result.attachments.some((a) => a.originalFilename === "midterm-feedback.pdf"),
        "feedback attachments are not downloaded"
      );
      assert.equal(result.ingestion.submissionFeedback?.enabled, false);
    });
  } finally {
    await stop();
  }
});

test("a blocked submissions endpoint degrades to no feedback without failing the ingest", async () => {
  const { config, stop } = await startFeedbackServer((data) => {
    data.forbiddenPaths = [/\/students\/submissions$/];
  });
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });
      assert.equal(result.assignments.length, 3);
      const extract = await fs.readFile(
        path.join(result.coursePath, "extracted", "assignments", "1003.txt"),
        "utf-8"
      );
      assert.doesNotMatch(extract, /Submission Feedback/);
      assert.equal(result.ingestion.submissionFeedback?.comments, 0);
    });
  } finally {
    await stop();
  }
});
