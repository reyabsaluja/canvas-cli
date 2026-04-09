import test from "node:test";
import assert from "node:assert/strict";
import { RadarService } from "../src/tui/services/radar-service.js";
import type { CanvasDiscussionTopic, CanvasDiscussionTopicView } from "../src/canvas/types.js";
import {
  parseRadarArgs,
  formatRadarItems,
  formatThread,
} from "../src/tui/radar-commands.js";
import type { RadarItem, RadarThread } from "../src/tui/services/radar-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTopic(overrides: Partial<CanvasDiscussionTopic> = {}): CanvasDiscussionTopic {
  return {
    id: 1,
    title: "Test Topic",
    message: "<p>Hello world</p>",
    posted_at: new Date().toISOString(),
    last_reply_at: null,
    discussion_type: "side_comment",
    read_state: "read",
    unread_count: 0,
    user_name: "Alice",
    html_url: "https://canvas.example.com/courses/1/discussion_topics/1",
    published: true,
    is_announcement: false,
    locked: false,
    ...overrides,
  };
}

function makeView(overrides: Partial<CanvasDiscussionTopicView> = {}): CanvasDiscussionTopicView {
  return {
    participants: [{ id: 1, display_name: "Alice" }],
    unread_entries: [],
    view: [],
    new_entries: [],
    ...overrides,
  };
}

function makeItem(overrides: Partial<RadarItem> = {}): RadarItem {
  return {
    kind: "discussion",
    topicId: 1,
    courseId: 100,
    courseName: "CS 101",
    title: "Test Topic",
    authorName: "Alice",
    postedAt: new Date("2026-04-08T12:00:00Z"),
    lastReplyAt: null,
    unreadCount: 0,
    htmlUrl: "https://canvas.example.com",
    locked: false,
    ...overrides,
  };
}

function stubClient(opts: {
  announcements?: CanvasDiscussionTopic[];
  discussions?: CanvasDiscussionTopic[];
  view?: CanvasDiscussionTopicView | null;
}) {
  return {
    getAnnouncementsSafe: async () => opts.announcements ?? [],
    getDiscussionTopicsSafe: async () => opts.discussions ?? [],
    getDiscussionTopicViewSafe: async () => opts.view ?? null,
  } as unknown as import("../src/canvas/client.js").CanvasClient;
}

// ---------------------------------------------------------------------------
// parseRadarArgs
// ---------------------------------------------------------------------------

test("parseRadarArgs: empty string returns all filter", () => {
  assert.deepEqual(parseRadarArgs(""), { filter: "all", query: "" });
});

test("parseRadarArgs: 'announcements' returns announcements filter", () => {
  assert.deepEqual(parseRadarArgs("announcements"), { filter: "announcements", query: "" });
});

test("parseRadarArgs: 'a homework' returns announcements filter with query", () => {
  assert.deepEqual(parseRadarArgs("a homework"), { filter: "announcements", query: "homework" });
});

test("parseRadarArgs: 'd' returns discussions filter", () => {
  assert.deepEqual(parseRadarArgs("d"), { filter: "discussions", query: "" });
});

test("parseRadarArgs: plain text returns all filter with query", () => {
  assert.deepEqual(parseRadarArgs("midterm review"), { filter: "all", query: "midterm review" });
});

// ---------------------------------------------------------------------------
// formatRadarItems
// ---------------------------------------------------------------------------

test("formatRadarItems: empty list shows 'no recent' message", () => {
  const result = formatRadarItems([], "all", "");
  assert.ok(result.toLowerCase().includes("no recent"));
});

test("formatRadarItems: includes query in empty message", () => {
  const result = formatRadarItems([], "all", "midterm");
  assert.ok(result.includes("midterm"));
});

test("formatRadarItems: formats items with [A] and [D] tags", () => {
  const items: RadarItem[] = [
    makeItem({ kind: "announcement", title: "Welcome" }),
    makeItem({ kind: "discussion", title: "Office Hours" }),
  ];
  const result = formatRadarItems(items, "all", "");
  assert.ok(result.includes("[A] Welcome"));
  assert.ok(result.includes("[D] Office Hours"));
});

test("formatRadarItems: shows unread count when present", () => {
  const items = [makeItem({ unreadCount: 3 })];
  const result = formatRadarItems(items, "all", "");
  assert.ok(result.includes("3 unread"));
});

// ---------------------------------------------------------------------------
// formatThread
// ---------------------------------------------------------------------------

test("formatThread: renders topic title and course name", () => {
  const thread: RadarThread = {
    topic: makeItem({ title: "Midterm Review" }),
    body: "Here is the review material.",
    entries: [],
    participantCount: 1,
    totalEntries: 0,
  };
  const result = formatThread(thread);
  assert.ok(result.includes("Midterm Review"));
  assert.ok(result.includes("CS 101"));
});

test("formatThread: renders replies with indentation", () => {
  const thread: RadarThread = {
    topic: makeItem(),
    body: "Top post",
    entries: [
      {
        entryId: 10,
        authorName: "Bob",
        message: "I agree",
        createdAt: new Date("2026-04-08T14:00:00Z"),
        depth: 0,
      },
      {
        entryId: 11,
        authorName: "Carol",
        message: "Me too",
        createdAt: new Date("2026-04-08T15:00:00Z"),
        depth: 1,
      },
    ],
    participantCount: 3,
    totalEntries: 2,
  };
  const result = formatThread(thread);
  assert.ok(result.includes("Bob"));
  assert.ok(result.includes("I agree"));
  assert.ok(result.includes("Carol"));
  assert.ok(result.includes("Me too"));
  assert.ok(result.includes("2 replies"));
});

// ---------------------------------------------------------------------------
// RadarService — getRadarItems
// ---------------------------------------------------------------------------

test("RadarService.getRadarItems returns recent announcements", async () => {
  const ann = makeTopic({
    id: 10,
    title: "Welcome",
    is_announcement: true,
    posted_at: new Date().toISOString(),
  });
  const client = stubClient({ announcements: [ann] });
  const service = new RadarService(client);

  const items = await service.getRadarItems(1, "CS 101", "all");
  assert.ok(items.some((i) => i.title === "Welcome" && i.kind === "announcement"));
});

test("RadarService.getRadarItems filters old items outside 7-day window", async () => {
  const old = makeTopic({
    id: 20,
    title: "Old Post",
    is_announcement: true,
    posted_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const client = stubClient({ announcements: [old] });
  const service = new RadarService(client);

  const items = await service.getRadarItems(1, "CS 101", "announcements");
  assert.equal(items.length, 0);
});

test("RadarService.getRadarItems includes unread discussions regardless of age", async () => {
  const disc = makeTopic({
    id: 30,
    title: "Old but unread",
    is_announcement: false,
    posted_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    read_state: "unread",
    unread_count: 2,
  });
  const client = stubClient({ discussions: [disc] });
  const service = new RadarService(client);

  const items = await service.getRadarItems(1, "CS 101", "all");
  assert.ok(items.some((i) => i.title === "Old but unread"));
});

test("RadarService.getRadarItems caches results", async () => {
  let callCount = 0;
  const client = stubClient({ announcements: [] });
  const origMethod = client.getAnnouncementsSafe;
  client.getAnnouncementsSafe = async (courseId: number) => {
    callCount++;
    return origMethod.call(client, courseId);
  };
  const service = new RadarService(client);

  await service.getRadarItems(1, "CS 101", "all");
  await service.getRadarItems(1, "CS 101", "all");
  assert.equal(callCount, 1);
});

test("RadarService.getRadarItems applies query filter", async () => {
  const ann1 = makeTopic({ id: 1, title: "Midterm Info", is_announcement: true, posted_at: new Date().toISOString() });
  const ann2 = makeTopic({ id: 2, title: "Lab Hours", is_announcement: true, posted_at: new Date().toISOString() });
  const client = stubClient({ announcements: [ann1, ann2] });
  const service = new RadarService(client);

  const items = await service.getRadarItems(1, "CS 101", "all", "midterm");
  assert.equal(items.length, 1);
  assert.equal(items[0]!.title, "Midterm Info");
});

test("RadarService.resolveTopicByPartialTitle finds older read discussions outside the radar window", async () => {
  const oldDiscussion = makeTopic({
    id: 40,
    title: "Archived Setup Thread",
    is_announcement: false,
    posted_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    last_reply_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    read_state: "read",
    unread_count: 0,
  });
  const client = stubClient({ discussions: [oldDiscussion] });
  const service = new RadarService(client);

  const feedItems = await service.getRadarItems(1, "CS 101", "all");
  assert.equal(feedItems.length, 0);

  const match = await service.resolveTopicByPartialTitle(
    [{ id: 1, name: "CS 101" }],
    "archived setup"
  );
  assert.ok(match);
  assert.equal(match.item.topicId, 40);
  assert.equal(match.item.title, "Archived Setup Thread");
});

test("RadarService reuses the per-course topic catalog across feed listing and title lookup", async () => {
  let announcementCalls = 0;
  let discussionCalls = 0;
  const topic = makeTopic({
    id: 41,
    title: "Shared Catalog Topic",
    is_announcement: false,
    posted_at: new Date().toISOString(),
  });
  const client = stubClient({ announcements: [], discussions: [topic] });
  const originalAnnouncements = client.getAnnouncementsSafe.bind(client);
  const originalDiscussions = client.getDiscussionTopicsSafe.bind(client);
  client.getAnnouncementsSafe = async (courseId: number) => {
    announcementCalls++;
    return originalAnnouncements(courseId);
  };
  client.getDiscussionTopicsSafe = async (courseId: number) => {
    discussionCalls++;
    return originalDiscussions(courseId);
  };
  const service = new RadarService(client);

  await service.getRadarItems(1, "CS 101", "all");
  const match = await service.resolveTopicByPartialTitle(
    [{ id: 1, name: "CS 101" }],
    "shared catalog"
  );

  assert.ok(match);
  assert.equal(announcementCalls, 1);
  assert.equal(discussionCalls, 1);
});

// ---------------------------------------------------------------------------
// RadarService — getThread
// ---------------------------------------------------------------------------

test("RadarService.getThread returns thread with entries", async () => {
  const topic = makeTopic({ id: 50, title: "Discussion 1" });
  const view = makeView({
    participants: [
      { id: 1, display_name: "Alice" },
      { id: 2, display_name: "Bob" },
    ],
    view: [
      {
        id: 100,
        user_id: 2,
        user_name: "Bob",
        message: "<p>Great point</p>",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        read_state: "read",
      },
    ],
  });
  const client = stubClient({
    discussions: [topic],
    announcements: [],
    view,
  });
  const service = new RadarService(client);

  const thread = await service.getThread(1, "CS 101", 50);
  assert.ok(thread);
  assert.equal(thread.topic.title, "Discussion 1");
  assert.equal(thread.entries.length, 1);
  assert.equal(thread.entries[0]!.authorName, "Bob");
});

test("RadarService.getThread returns null for non-existent topic", async () => {
  const client = stubClient({ view: null, discussions: [], announcements: [] });
  const service = new RadarService(client);

  const thread = await service.getThread(1, "CS 101", 999);
  assert.equal(thread, null);
});

// ---------------------------------------------------------------------------
// RadarService — getRadarItemsMultiCourse
// ---------------------------------------------------------------------------

test("RadarService.getRadarItemsMultiCourse merges and sorts items from multiple courses", async () => {
  const recent = new Date().toISOString();
  const older = new Date(Date.now() - 3600_000).toISOString();
  const ann1 = makeTopic({ id: 1, title: "Course A Ann", is_announcement: true, posted_at: older });
  const ann2 = makeTopic({ id: 2, title: "Course B Ann", is_announcement: true, posted_at: recent });

  let lastCourseId: number | undefined;
  const client = stubClient({});
  client.getAnnouncementsSafe = async (courseId: number) => {
    lastCourseId = courseId;
    return courseId === 100 ? [ann1] : [ann2];
  };
  client.getDiscussionTopicsSafe = async () => [];

  const service = new RadarService(client);
  const items = await service.getRadarItemsMultiCourse(
    [
      { id: 100, name: "Course A" },
      { id: 200, name: "Course B" },
    ],
    "all"
  );

  assert.equal(items.length, 2);
  // Most recent first
  assert.equal(items[0]!.title, "Course B Ann");
});

// ---------------------------------------------------------------------------
// RadarService — resolveTopicByPartialTitle
// ---------------------------------------------------------------------------

test("RadarService.resolveTopicByPartialTitle finds exact match", async () => {
  const ann = makeTopic({ id: 1, title: "Midterm Review Session", is_announcement: true, posted_at: new Date().toISOString() });
  const client = stubClient({ announcements: [ann] });
  const service = new RadarService(client);

  const result = await service.resolveTopicByPartialTitle(
    [{ id: 1, name: "CS 101" }],
    "Midterm Review Session"
  );
  assert.ok(result);
  assert.equal(result.item.title, "Midterm Review Session");
});

test("RadarService.resolveTopicByPartialTitle finds partial match", async () => {
  const ann = makeTopic({ id: 1, title: "Midterm Review Session", is_announcement: true, posted_at: new Date().toISOString() });
  const client = stubClient({ announcements: [ann] });
  const service = new RadarService(client);

  const result = await service.resolveTopicByPartialTitle(
    [{ id: 1, name: "CS 101" }],
    "midterm"
  );
  assert.ok(result);
  assert.equal(result.item.title, "Midterm Review Session");
});

test("RadarService.resolveTopicByPartialTitle returns null when no match", async () => {
  const client = stubClient({ announcements: [], discussions: [] });
  const service = new RadarService(client);

  const result = await service.resolveTopicByPartialTitle(
    [{ id: 1, name: "CS 101" }],
    "nonexistent"
  );
  assert.equal(result, null);
});
