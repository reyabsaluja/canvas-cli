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
import { buildDefaultServerData } from "./helpers/fixtures.js";

async function withTempCwd(fn: (tempDir: string) => Promise<void>): Promise<void> {
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-discussions-"));
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

/** Thread order: each reply directly after the entry it answers. */
const EXPECTED_THREAD_ORDER = [71, 72, 73, 74, 75, 76, 77];

async function startDiscussionServer(
  mutate?: (data: MockServerData) => void
): Promise<{ data: MockServerData; config: Config; stop: () => Promise<void> }> {
  const data = buildDefaultServerData();
  // Keep this fixture about discussions: no file downloads to an unreachable origin.
  data.files.set(101, []);
  data.folders?.set(101, []);
  mutate?.(data);
  const server = createMockCanvasServer(data);
  const port = await startServer(server);
  return {
    data,
    config: { baseUrl: `http://127.0.0.1:${port}/api/v1`, accessToken: "test-token-valid" },
    stop: () => stopServer(server),
  };
}

test("threaded replies nested under /view entries are captured in thread order with author names", async () => {
  const { config, stop } = await startDiscussionServer();
  try {
    const client = new CanvasClient(config, { maxRetries: 0 });
    const raw = await fetchCourseContent(client, 101);

    assert.equal(raw.discussions.length, 1);
    const thread = raw.discussionThreads[0]!;
    assert.deepEqual(
      thread.entries.map((entry) => entry.id),
      EXPECTED_THREAD_ORDER,
      "nested replies are walked and kept next to what they answer"
    );
    assert.equal(thread.participantCount, 5);
    // /view entries carry only user_id; names come from the participants list.
    assert.deepEqual(
      thread.entries.map((entry) => entry.user_name),
      [
        "Student One",
        "TA Linus",
        "Student One",
        "Student Two",
        "TA Linus",
        "Student Three",
        "Prof. Grace",
      ]
    );
    assert.equal(thread.repliesPaged, 0);
  } finally {
    await stop();
  }
});

test("ingestCourse stores every threaded reply so retrieval can answer from the TA's nested reply", async () => {
  const { config, stop } = await startDiscussionServer();
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });

      assert.equal(result.discussions?.length, 1);
      assert.equal(result.discussions?.[0]?.threadEntryCount, 7);
      assert.equal(result.discussions?.[0]?.participantCount, 5);
      assert.deepEqual(result.ingestion.discussionThreads, {
        topics: 1,
        replies: 7,
        pagedReplies: 0,
      });

      const extract = await fs.readFile(
        path.join(result.coursePath, "extracted", "discussions", "7001.txt"),
        "utf-8"
      );
      assert.match(extract, /Replies captured: 7/);
      assert.match(extract, /### TA Linus — /, "author resolved from participants, not 'User 2'");
      assert.doesNotMatch(extract, /User \d+ — /);
      assert.match(extract, /No Makefile needed: submit hello\.c only/);
      assert.match(extract, /Use C11 for every lab\./);
      assert.match(extract, /gnu11 is fine/);
      // Thread order: the question, then its answer.
      assert.ok(
        extract.indexOf("Does Lab 1 need a Makefile?") <
          extract.indexOf("No Makefile needed") &&
          extract.indexOf("No Makefile needed") < extract.indexOf("Which C standard"),
        "reply follows the entry it answers"
      );

      const summary = renderIngestionSummary(result);
      assert.match(summary, /1 discussions \(7 replies\)/);
    });
  } finally {
    await stop();
  }
});

test("falls back to /entries and pages has_more_replies when /view is forbidden", async () => {
  const { config, stop } = await startDiscussionServer((data) => {
    data.forbiddenPaths = [/\/discussion_topics\/\d+\/view$/];
    data.discussionRecentReplyLimit = 2;
    // Force pagination of the replies endpoint too.
    data.pagePerPage = 2;
  });
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });

      assert.equal(result.discussions?.[0]?.threadEntryCount, 7);
      assert.equal(result.discussions?.[0]?.participantCount, 5);
      // Entry 74 has 3 replies but /entries only lists 2 inline, so its full
      // reply list is paged; entry 71's 2 replies fit inline.
      assert.deepEqual(result.ingestion.discussionThreads, {
        topics: 1,
        replies: 7,
        pagedReplies: 3,
      });

      const extract = await fs.readFile(
        path.join(result.coursePath, "extracted", "discussions", "7001.txt"),
        "utf-8"
      );
      assert.match(extract, /Use C11 for every lab\./, "oldest reply, omitted from recent_replies, is paged in");
      assert.match(extract, /gnu11 is fine/);
      assert.match(extract, /No Makefile needed/);
      assert.match(extract, /### TA Linus — /);

      const summary = renderIngestionSummary(result);
      assert.match(summary, /1 discussions \(7 replies, 3 paged\)/);
    });
  } finally {
    await stop();
  }
});

test("thread order from /entries fallback matches the /view walk", async () => {
  const { config, stop } = await startDiscussionServer((data) => {
    data.forbiddenPaths = [/\/discussion_topics\/\d+\/view$/];
  });
  try {
    const client = new CanvasClient(config, { maxRetries: 0 });
    const raw = await fetchCourseContent(client, 101);
    const thread = raw.discussionThreads[0]!;
    assert.deepEqual(thread.entries.map((entry) => entry.id), EXPECTED_THREAD_ORDER);
    assert.equal(thread.repliesPaged, 3);
  } finally {
    await stop();
  }
});

test("degrades to an empty thread when every discussion endpoint is forbidden", async () => {
  const { config, stop } = await startDiscussionServer((data) => {
    data.forbiddenPaths = [/\/discussion_topics\/\d+\//];
  });
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });
      assert.equal(result.discussions?.length, 1, "topic index still lists the topic");
      assert.equal(result.discussions?.[0]?.threadEntryCount, 0);
      assert.deepEqual(result.ingestion.discussionThreads, {
        topics: 1,
        replies: 0,
        pagedReplies: 0,
      });
      const extract = await fs.readFile(
        path.join(result.coursePath, "extracted", "discussions", "7001.txt"),
        "utf-8"
      );
      assert.match(extract, /Post your Lab 1 questions here\./);
    });
  } finally {
    await stop();
  }
});

test("ingestion survives when discussion_topics itself is forbidden", async () => {
  const { config, stop } = await startDiscussionServer((data) => {
    data.forbiddenPaths = [/\/discussion_topics/];
  });
  try {
    await withTempCwd(async () => {
      const client = new CanvasClient(config, { maxRetries: 0 });
      const result = await ingestCourse(COURSE, client, config, { refresh: false });
      assert.equal(result.discussions?.length, 0);
      assert.equal(result.announcements?.length, 0);
      assert.deepEqual(result.ingestion.discussionThreads, {
        topics: 0,
        replies: 0,
        pagedReplies: 0,
      });
    });
  } finally {
    await stop();
  }
});

test("view new_entries are attached under their parent and deleted stubs are skipped", async () => {
  const client = {
    async getDiscussionTopicViewSafe() {
      return {
        participants: [
          { id: 1, display_name: "Prof. Ada" },
          { id: 2, display_name: "Student One" },
        ],
        unread_entries: [],
        view: [
          {
            id: 10,
            user_id: 2,
            parent_id: null,
            message: "<p>Is the quiz open book?</p>",
            created_at: "2026-04-01T10:00:00.000Z",
            updated_at: "2026-04-01T10:00:00.000Z",
            read_state: "read",
            replies: [
              {
                id: 11,
                user_id: 2,
                parent_id: 10,
                deleted: true,
                message: null,
                created_at: "2026-04-01T10:05:00.000Z",
                updated_at: "2026-04-01T10:05:00.000Z",
                read_state: "read",
                replies: [
                  {
                    id: 12,
                    user_id: 1,
                    parent_id: 11,
                    message: "<p>Yes, open book but no internet.</p>",
                    created_at: "2026-04-01T11:00:00.000Z",
                    updated_at: "2026-04-01T11:00:00.000Z",
                    read_state: "read",
                  },
                ],
              },
            ],
          },
        ],
        new_entries: [
          {
            id: 13,
            user_id: 2,
            parent_id: 12,
            message: "<p>Great, thanks.</p>",
            created_at: "2026-04-02T09:00:00.000Z",
            updated_at: "2026-04-02T09:00:00.000Z",
            read_state: "read",
          },
          {
            id: 14,
            user_id: 1,
            parent_id: null,
            message: "<p>Reminder: quiz closes Friday.</p>",
            created_at: "2026-04-02T12:00:00.000Z",
            updated_at: "2026-04-02T12:00:00.000Z",
            read_state: "read",
          },
        ],
      };
    },
  } as unknown as CanvasClient;

  const { collectDiscussionThread } = await import("../src/ingest/fetch-course-content.js");
  const thread = await collectDiscussionThread(client, 17, {
    id: 9,
    title: "Quiz 1 questions",
    message: null,
    posted_at: null,
    last_reply_at: null,
    discussion_type: "threaded",
    read_state: "read",
    unread_count: 0,
    user_name: "Prof. Ada",
    html_url: "https://canvas.example/courses/17/discussion_topics/9",
    published: true,
    is_announcement: false,
    locked: false,
  });

  assert.deepEqual(
    thread.entries.map((entry) => [entry.id, entry.user_name]),
    [
      [10, "Student One"],
      [12, "Prof. Ada"],
      [13, "Student One"],
      [14, "Prof. Ada"],
    ]
  );
  assert.equal(thread.participantCount, 2);
});
