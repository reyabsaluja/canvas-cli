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
import type { AnnouncementIndexEntry } from "../src/ingest/types.js";
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
  CS101_REPLY_ATTACHMENT,
  daysFromNow,
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-announcement-replies-"));
  process.chdir(tempDir);
  try {
    await fn();
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * The midterm-review announcement with one TA reply that (a) carries an
 * attached file and (b) links a Canvas file from its HTML. Neither file is
 * reachable from the announcement post itself.
 */
function buildAnnouncementWithReply(origin: string): MockDiscussionTopic {
  const [announcement] = CS101_ANNOUNCEMENTS;
  return {
    ...announcement!,
    attachments: (announcement!.attachments ?? []).map((a) => rewriteAttachmentUrls(a, origin)),
    last_reply_at: daysFromNow(-11),
    entries: [
      {
        id: 91,
        user_id: 2,
        user_name: "TA Linus",
        message:
          `<p>Room change: the review session is now in <strong>ENG 102</strong>. ` +
          `Flags are attached; see also <a class="instructure_file_link" title="room-change.txt" href="${origin}/files/5303?wrap=1">this note</a>.</p>`,
        created_at: daysFromNow(-11),
        attachment: rewriteAttachmentUrls(CS101_REPLY_ATTACHMENT, origin),
      },
    ],
  };
}

async function startAnnouncementServer(mutate?: (data: MockServerData) => void) {
  const data = buildDefaultServerData();
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  const origin = `http://127.0.0.1:${port}`;
  data.discussions = new Map([[101, [buildAnnouncementWithReply(origin), ...CS101_DISCUSSIONS]]]);
  // Copy rather than push: the default data shares the module-level fixture array.
  data.files.set(101, [
    ...(data.files.get(101) ?? []),
    {
      id: 5303,
      display_name: "room-change.txt",
      filename: "room-change.txt",
      content_type: "text/plain",
      size: 30,
      url: `${origin}/files/5303/download`,
      updated_at: "2026-02-01T10:00:00Z",
      folder_id: 1,
    },
  ]);
  mutate?.(data);
  const config: Config = { baseUrl: `${origin}/api/v1`, accessToken: "test-token-valid" };
  return { config, origin, stop: () => stopServer(server) };
}

test("fetchCourseContent collects announcement reply threads like discussion threads", async () => {
  const { config, stop } = await startAnnouncementServer();
  try {
    const raw = await fetchCourseContent(new CanvasClient(config, { maxRetries: 0 }), 101);
    assert.equal(raw.announcements.length, 1);
    assert.equal(raw.announcementThreads.length, 1);
    const thread = raw.announcementThreads[0]!;
    assert.equal(thread.topic.id, 7101);
    assert.equal(thread.entries.length, 1);
    assert.equal(thread.entries[0]?.user_name, "TA Linus");
    assert.match(thread.entries[0]?.message ?? "", /ENG 102/);
    assert.equal(thread.participantCount, 1);
  } finally {
    await stop();
  }
});

test("ingestCourse renders announcement replies and captures files attached to or linked from them", async () => {
  const { config, stop } = await startAnnouncementServer();
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });

      const extract = await fs.readFile(
        path.join(result.coursePath, "extracted", "announcements", "7101.txt"),
        "utf-8"
      );
      assert.match(extract, /^# Midterm review session Thursday/m);
      assert.match(extract, /Review session Thursday 5pm in ENG 101/);
      assert.match(extract, /^Replies captured: 1$/m);
      assert.match(extract, /^## Replies$/m);
      assert.match(extract, /^### TA Linus — /m);
      assert.match(extract, /Room change: the review session is now in \*\*ENG 102\*\*/);
      assert.match(
        extract,
        /Attachment: gnu11-flags\.txt \(attachments\/announcements\/gnu11-flags\.txt\)/
      );

      const replyFile = result.attachments.find((a) => a.originalFilename === "gnu11-flags.txt");
      assert.ok(replyFile, "the reply's attached file is downloaded");
      assert.equal(replyFile.status, "downloaded");
      assert.equal(replyFile.localPath, "attachments/announcements/gnu11-flags.txt");
      assert.match(replyFile.reason, /reply by TA Linus in announcement "Midterm review session Thursday"/);

      const linkedFile = result.attachments.find((a) => a.originalFilename === "room-change.txt");
      assert.ok(linkedFile, "a file linked from the reply HTML is downloaded");
      assert.equal(linkedFile.status, "downloaded");
      assert.match(linkedFile.reason, /Announcement reply in "Midterm review session Thursday" by TA Linus/);

      const announcements = JSON.parse(
        await fs.readFile(path.join(result.coursePath, "announcements.json"), "utf-8")
      ) as AnnouncementIndexEntry[];
      assert.equal(announcements[0]?.replyCount, 1);
      assert.equal(announcements[0]?.participantCount, 1);
      assert.equal(announcements[0]?.replyFileLinkCount, 1);

      assert.equal(result.ingestion.announcementThreads?.topics, 1);
      assert.equal(result.ingestion.announcementThreads?.replies, 1);
      // Reply attachments are counted with the other post attachments.
      assert.equal(result.ingestion.topicAttachments?.replies, 1);
      assert.equal(result.ingestion.topicAttachments?.announcements, 1);
      const summary = renderIngestionSummary(result);
      assert.match(summary, /1 announcements \(1 reply\)/);
    });
  } finally {
    await stop();
  }
});

test("an announcement whose thread view is blocked still renders the post", async () => {
  const { config, stop } = await startAnnouncementServer((data) => {
    data.forbiddenPaths = [/\/discussion_topics\/7101\/(view|entries)/];
  });
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });
      const extract = await fs.readFile(
        path.join(result.coursePath, "extracted", "announcements", "7101.txt"),
        "utf-8"
      );
      assert.match(extract, /Review session Thursday 5pm in ENG 101/);
      assert.doesNotMatch(extract, /## Replies/);
      assert.equal(result.ingestion.announcementThreads?.replies, 0);
    });
  } finally {
    await stop();
  }
});
