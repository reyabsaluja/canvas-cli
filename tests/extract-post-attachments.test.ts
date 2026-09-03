import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeIngestionArtifacts } from "../src/ingest/storage.js";
import type { RawDiscussionThread } from "../src/ingest/fetch-course-content.js";
import type { CanvasDiscussionTopic } from "../src/canvas/types.js";
import type {
  CourseMetadata,
  DownloadedAttachmentEntry,
  IngestionMeta,
} from "../src/ingest/types.js";

const COURSE_META: CourseMetadata = {
  id: 101,
  name: "Introduction to Computer Science",
  courseCode: "CS101",
  termName: "Spring 2026",
  startAt: null,
  endAt: null,
  syllabusBody: null,
  htmlUrl: "https://canvas.example/courses/101",
};

const INGESTION: IngestionMeta = {
  version: 1,
  ingestedAt: "2026-09-03T00:00:00.000Z",
  courseId: 101,
  courseName: COURSE_META.name,
  courseCode: COURSE_META.courseCode,
  refresh: false,
  counts: {
    assignments: 0,
    modules: 0,
    moduleItems: 0,
    files: 0,
    pages: 0,
    syllabusCandidates: 0,
    lectures: 0,
    attachmentsDownloaded: 0,
    attachmentsSkipped: 0,
    attachmentsFailed: 0,
  },
};

function topic(overrides: Partial<CanvasDiscussionTopic>): CanvasDiscussionTopic {
  return {
    id: 1,
    title: "Topic",
    message: "<p>Body</p>",
    posted_at: "2026-09-01T12:00:00Z",
    last_reply_at: null,
    discussion_type: "threaded",
    read_state: "read",
    unread_count: 0,
    user_name: "Prof. Grace",
    html_url: "https://canvas.example/courses/101/discussion_topics/1",
    published: true,
    is_announcement: false,
    locked: false,
    ...overrides,
  };
}

function downloaded(
  canvasFileId: number,
  originalFilename: string,
  subfolder: string,
  status: DownloadedAttachmentEntry["status"] = "downloaded"
): DownloadedAttachmentEntry {
  return {
    sourceType: "page_linked",
    canvasFileId,
    originalFilename,
    localPath: `attachments/${subfolder}/${originalFilename}`,
    contentType: "text/plain",
    size: 10,
    downloadUrl: `https://canvas.example/files/${canvasFileId}/download`,
    reason: "attached to post",
    status,
  };
}

async function withTempCourse(fn: (coursePath: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-post-attachments-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("announcement and discussion extracts list the files attached to the post and its replies", async () => {
  await withTempCourse(async (coursePath) => {
    const announcement = topic({
      id: 7101,
      title: "Midterm review session Thursday",
      message: "<p>Review session Thursday 5pm. The study guide is attached.</p>",
      is_announcement: true,
      attachments: [
        {
          id: 5301,
          display_name: "Midterm Review Guide.txt",
          filename: "midterm_review_guide.txt",
          "content-type": "text/plain",
          size: 96,
          url: "https://canvas.example/files/5301/download?verifier=abc",
        },
        {
          id: 5399,
          display_name: "deleted-handout.pdf",
          filename: "deleted-handout.pdf",
          "content-type": "application/pdf",
          size: 10,
          url: "https://canvas.example/files/5399/download",
        },
      ],
    });

    const thread: RawDiscussionThread = {
      topic: topic({
        id: 7001,
        title: "Lab 1 Q&A",
        message: "<p>Ask Lab 1 questions here. Starter code attached.</p>",
        attachments: [
          {
            id: 5310,
            display_name: "lab1-starter.zip",
            filename: "lab1-starter.zip",
            "content-type": "application/zip",
            size: 2048,
            url: "https://canvas.example/files/5310/download",
          },
        ],
      }),
      entries: [
        {
          id: 74,
          user_id: 2,
          user_name: "Student Ada",
          message: "<p>Which C standard should we use?</p>",
          created_at: "2026-09-02T10:00:00Z",
          updated_at: "2026-09-02T10:00:00Z",
        },
        {
          id: 77,
          user_id: 1,
          user_name: "Prof. Grace",
          message: "<p>gnu11 is fine, flags attached.</p>",
          created_at: "2026-09-02T11:00:00Z",
          updated_at: "2026-09-02T11:00:00Z",
          attachment: {
            id: 5302,
            display_name: "gnu11-flags.txt",
            filename: "gnu11-flags.txt",
            "content-type": "text/plain",
            size: 40,
            url: "https://canvas.example/files/5302/download",
          },
        },
      ],
      participantCount: 2,
    };

    const attachments: DownloadedAttachmentEntry[] = [
      downloaded(5301, "Midterm Review Guide.txt", "announcements"),
      downloaded(5399, "deleted-handout.pdf", "announcements", "failed"),
      downloaded(5302, "gnu11-flags.txt", "discussions"),
      // 5310 was skipped as too large: no download record at all.
    ];

    await writeIngestionArtifacts(
      coursePath,
      COURSE_META,
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      attachments,
      [],
      INGESTION,
      [],
      null,
      [],
      [announcement],
      [thread],
      []
    );

    const announcementText = await fs.readFile(
      path.join(coursePath, "extracted", "announcements", "7101.txt"),
      "utf-8"
    );
    assert.match(
      announcementText,
      /^Attachments: Midterm Review Guide\.txt \(attachments\/announcements\/Midterm Review Guide\.txt\); deleted-handout\.pdf \(download failed\)$/m
    );
    assert.ok(
      announcementText.indexOf("Attachments:") < announcementText.indexOf("Review session Thursday"),
      "attachment line sits in the header block before the body"
    );

    const discussionText = await fs.readFile(
      path.join(coursePath, "extracted", "discussions", "7001.txt"),
      "utf-8"
    );
    assert.match(discussionText, /^Attachments: lab1-starter\.zip \(not downloaded\)$/m);
    assert.match(
      discussionText,
      /### Prof\. Grace — 2026-09-02T11:00:00Z\n\nAttachment: gnu11-flags\.txt \(attachments\/discussions\/gnu11-flags\.txt\)\n\ngnu11 is fine, flags attached\./
    );
    assert.doesNotMatch(
      discussionText,
      /### Student Ada — 2026-09-02T10:00:00Z\n\nAttachment:/,
      "replies without a file get no attachment line"
    );
  });
});

test("posts without attached files keep their existing layout", async () => {
  await withTempCourse(async (coursePath) => {
    const announcement = topic({
      id: 7102,
      title: "Welcome",
      message: "<p>Welcome to CS101.</p>",
      is_announcement: true,
    });
    await writeIngestionArtifacts(
      coursePath,
      COURSE_META,
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      INGESTION,
      [],
      null,
      [],
      [announcement],
      [],
      []
    );
    const text = await fs.readFile(
      path.join(coursePath, "extracted", "announcements", "7102.txt"),
      "utf-8"
    );
    assert.equal(text, "# Welcome\n\nPosted: 2026-09-01T12:00:00Z\n\nWelcome to CS101.\n");
  });
});
