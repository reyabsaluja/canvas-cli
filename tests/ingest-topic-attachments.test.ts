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
  type MockDiscussionTopic,
  type MockServerData,
} from "./helpers/mock-canvas-server.js";
import {
  buildDefaultServerData,
  CS101_ANNOUNCEMENTS,
  CS101_DISCUSSIONS,
  CS101_MIDTERM_REVIEW_ATTACHMENT,
  CS101_REPLY_ATTACHMENT,
  rewriteAttachmentUrls,
} from "./helpers/fixtures.js";

async function withTempCwd(fn: (tempDir: string) => Promise<void>): Promise<void> {
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-topic-attachments-"));
  process.chdir(tempDir);
  try {
    await fn(tempDir);
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const COURSE: Course = {
  id: 101,
  name: "Introduction to Computer Science",
  courseCode: "CS101",
  termName: "Spring 2026",
  isCurrent: true,
};

/**
 * Announcement with an attached study guide, and a discussion whose TA reply
 * carries an attached file. Neither file is linked from any message HTML and
 * (by default) neither is listed in the Files tab.
 */
function buildTopicsWithAttachments(origin: string): MockDiscussionTopic[] {
  const [qna] = CS101_DISCUSSIONS;
  const discussion: MockDiscussionTopic = {
    ...qna!,
    entries: qna!.entries!.map((entry) =>
      entry.id === 74
        ? {
            ...entry,
            replies: entry.replies!.map((reply) =>
              reply.id === 77
                ? { ...reply, attachment: rewriteAttachmentUrls(CS101_REPLY_ATTACHMENT, origin) }
                : reply
            ),
          }
        : entry
    ),
  };
  const announcements = CS101_ANNOUNCEMENTS.map((topic) => ({
    ...topic,
    attachments: (topic.attachments ?? []).map((a) => rewriteAttachmentUrls(a, origin)),
  }));
  return [...announcements, discussion];
}

async function startTopicServer(
  mutate?: (data: MockServerData, origin: string) => void
): Promise<{ data: MockServerData; config: Config; origin: string; stop: () => Promise<void> }> {
  const data = buildDefaultServerData();
  data.files.set(101, []);
  data.folders?.set(101, []);
  data.fileContents = new Map([
    [5301, "Midterm covers chapters 1-4. Bring a calculator. Recursion is on it.\n"],
    [5302, "gcc -std=gnu11 -Wall -Wextra\n"],
  ]);
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  const origin = `http://127.0.0.1:${port}`;
  data.discussions?.set(101, buildTopicsWithAttachments(origin));
  mutate?.(data, origin);
  return {
    data,
    config: { baseUrl: `${origin}/api/v1`, accessToken: "test-token-valid" },
    origin,
    stop: () => stopServer(server),
  };
}

test("topic attachments[] and reply attachments are exposed on the raw course content", async () => {
  const { config, stop } = await startTopicServer();
  try {
    const client = new CanvasClient(config, { maxRetries: 0 });
    const raw = await fetchCourseContent(client, 101);

    assert.equal(raw.announcements.length, 1);
    const announcement = raw.announcements[0]!;
    assert.equal(announcement.attachments?.length, 1);
    assert.equal(announcement.attachments?.[0]?.display_name, "Midterm Review Guide.txt");

    const thread = raw.discussionThreads[0]!;
    const taReply = thread.entries.find((entry) => entry.id === 77);
    assert.ok(taReply);
    assert.equal(taReply.attachment?.display_name, "gnu11-flags.txt");
  } finally {
    await stop();
  }
});

test("ingestCourse downloads files attached to announcements and replies even when the Files API is blocked", async () => {
  const { config, stop } = await startTopicServer((data) => {
    data.forbiddenPaths = [/\/courses\/\d+\/files$/, /\/courses\/\d+\/folders$/];
  });
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });

      const guide = result.attachments.find(
        (a) => a.originalFilename === "Midterm Review Guide.txt"
      );
      assert.ok(guide, "announcement attachment is downloaded");
      assert.equal(guide.status, "downloaded");
      assert.equal(guide.canvasFileId, 5301);
      assert.equal(guide.localPath, "attachments/announcements/Midterm Review Guide.txt");
      assert.match(guide.reason, /attached to announcement "Midterm review session Thursday"/);
      assert.equal(guide.contentType, "text/plain");
      assert.ok(!guide.downloadUrl.includes("verifier="), "one-time verifier is not persisted");

      const flags = result.attachments.find((a) => a.originalFilename === "gnu11-flags.txt");
      assert.ok(flags, "reply attachment is downloaded");
      assert.equal(flags.status, "downloaded");
      assert.equal(flags.localPath, "attachments/discussions/gnu11-flags.txt");
      assert.match(flags.reason, /attached to reply by Prof\. Grace in "Lab 1 Q&A"/);

      // Bytes and text sidecars land where retrieval indexes them.
      const guideText = await fs.readFile(path.join(result.coursePath, guide.localPath), "utf-8");
      assert.match(guideText, /Bring a calculator/);
      const sidecar = await fs.readFile(
        path.join(result.coursePath, "extracted", "attachments", "announcements", "Midterm Review Guide.txt.txt"),
        "utf-8"
      );
      assert.match(sidecar, /Recursion is on it/);
      const attachmentsJson = JSON.parse(
        await fs.readFile(path.join(result.coursePath, "attachments.json"), "utf-8")
      ) as Array<{ canvasFileId: number | null }>;
      assert.ok(attachmentsJson.some((a) => a.canvasFileId === 5301));
      assert.ok(attachmentsJson.some((a) => a.canvasFileId === 5302));

      const topicAttachments = result.ingestion.topicAttachments;
      assert.ok(topicAttachments, "ingestion.topicAttachments summary is recorded");
      assert.equal(topicAttachments.announcements, 1);
      assert.equal(topicAttachments.discussions, 0);
      assert.equal(topicAttachments.replies, 1);
      assert.equal(topicAttachments.downloaded, 2);
      assert.equal(topicAttachments.failed, 0);

      const summary = renderIngestionSummary(result);
      assert.match(summary, /2 files attached to posts \(1 announcement, 1 reply\)/);
      assert.match(summary, /Midterm Review Guide\.txt/);
    });
  } finally {
    await stop();
  }
});

test("topic attachments are not downloaded twice when the same file is also in the Files tab", async () => {
  const { config, stop } = await startTopicServer((data, origin) => {
    data.files.set(101, [
      {
        id: 5301,
        display_name: "Midterm Review Guide.txt",
        filename: "Midterm Review Guide.txt",
        content_type: "text/plain",
        size: 96,
        url: `${origin}/files/5301/download`,
        updated_at: null,
        folder_id: 1,
      },
    ]);
  });
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });

      const copies = result.attachments.filter((a) => a.canvasFileId === 5301);
      assert.equal(copies.length, 1, "one download for the attached file");
      assert.match(copies[0]!.reason, /attached to announcement/);
      assert.equal(result.ingestion.courseFiles?.alreadySelected, 1);
      assert.equal(result.ingestion.courseFiles?.selected, 0);
      assert.equal(result.ingestion.topicAttachments?.downloaded, 2);
    });
  } finally {
    await stop();
  }
});

test("a topic attachment whose download 404s is recorded as failed without breaking the ingest", async () => {
  const { config, stop } = await startTopicServer((data, origin) => {
    const topics = data.discussions!.get(101)!;
    const announcement = topics.find((t) => t.id === 7101)!;
    announcement.attachments = [
      ...(announcement.attachments ?? []),
      {
        id: 5399,
        display_name: "deleted-handout.pdf",
        filename: "deleted-handout.pdf",
        "content-type": "application/pdf",
        size: 10,
        // Not served by the mock: the download returns 404.
        url: `${origin}/files/9999999/download`,
      },
    ];
  });
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });

      const missing = result.attachments.find((a) => a.originalFilename === "deleted-handout.pdf");
      assert.ok(missing);
      assert.equal(missing.status, "failed");
      assert.equal(result.ingestion.topicAttachments?.announcements, 2);
      assert.equal(result.ingestion.topicAttachments?.downloaded, 2);
      assert.equal(result.ingestion.topicAttachments?.failed, 1);
      const summary = renderIngestionSummary(result);
      assert.match(summary, /3 files attached to posts .*\(1 failed\)/);
      assert.ok(
        result.attachments.some((a) => a.originalFilename === "Midterm Review Guide.txt" && a.status === "downloaded")
      );
    });
  } finally {
    await stop();
  }
});
