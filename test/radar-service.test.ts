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
    context_code: null,
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
  searchResults?: CanvasDiscussionTopic[];
  bulkAnnouncements?: CanvasDiscussionTopic[];
}) {
  return {
    getAnnouncementsSafe: async () => opts.announcements ?? [],
    getAnnouncementsForContexts: async () => opts.bulkAnnouncements ?? [],
    getDiscussionTopicsSafe: async () => opts.discussions ?? [],
    getDiscussionTopicViewSafe: async () => opts.view ?? null,
    searchDiscussionTopicsSafe: async () => opts.searchResults ?? [],
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

test("formatRadarItems: uses lastReplyAt for age when available", () => {
  const items = [
    makeItem({
      postedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000), // 6 days ago
      lastReplyAt: new Date(Date.now() - 60 * 60 * 1000),        // 1 hour ago
    }),
  ];
  const result = formatRadarItems(items, "all", "");
  // Should show ~1h, not ~6d
  assert.ok(result.includes("1h ago"));
  assert.ok(!result.includes("6d ago"));
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
  assert.equal(match.status, "found");
  assert.equal(match.status === "found" && match.item.topicId, 40);
  assert.equal(match.status === "found" && match.item.title, "Archived Setup Thread");
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
  assert.equal(match.status, "found");
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
  const ann1 = makeTopic({
    id: 1,
    title: "Course A Ann",
    is_announcement: true,
    context_code: "course_100",
    html_url: "https://canvas.example.com/courses/100/discussion_topics/1",
    posted_at: older,
  });
  const ann2 = makeTopic({
    id: 2,
    title: "Course B Ann",
    is_announcement: true,
    context_code: "course_200",
    html_url: "https://canvas.example.com/courses/200/discussion_topics/2",
    posted_at: recent,
  });

  const client = stubClient({});
  client.getAnnouncementsForContexts = async () => [ann1, ann2];
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

test("RadarService.getRadarItemsMultiCourse uses one bulk announcements request before falling back", async () => {
  let bulkCalls = 0;
  let perCourseCalls = 0;
  const now = new Date().toISOString();
  const ann1 = makeTopic({
    id: 3,
    title: "Course A Ann",
    is_announcement: true,
    context_code: "course_100",
    html_url: "https://canvas.example.com/courses/100/discussion_topics/3",
    posted_at: now,
  });
  const ann2 = makeTopic({
    id: 4,
    title: "Course B Ann",
    is_announcement: true,
    context_code: "course_200",
    html_url: "https://canvas.example.com/courses/200/discussion_topics/4",
    posted_at: now,
  });
  const client = stubClient({});
  client.getAnnouncementsForContexts = async () => {
    bulkCalls += 1;
    return [ann1, ann2];
  };
  client.getAnnouncementsSafe = async () => {
    perCourseCalls += 1;
    return [];
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
  assert.equal(bulkCalls, 1);
  assert.equal(perCourseCalls, 0);
});

test("RadarService.getRadarItemsMultiCourse falls back to per-course announcements when bulk fetch fails", async () => {
  let bulkCalls = 0;
  let perCourseCalls = 0;
  const now = new Date().toISOString();
  const client = stubClient({});
  client.getAnnouncementsForContexts = async () => {
    bulkCalls += 1;
    throw new Error("Canvas API error: 403 Forbidden");
  };
  client.getAnnouncementsSafe = async (courseId: number) => {
    perCourseCalls += 1;
    return [
      makeTopic({
        id: courseId,
        title: `Announcement ${courseId}`,
        is_announcement: true,
        html_url: `https://canvas.example.com/courses/${courseId}/discussion_topics/${courseId}`,
        posted_at: now,
      }),
    ];
  };
  client.getDiscussionTopicsSafe = async () => [];

  const service = new RadarService(client);
  const items = await service.getRadarItemsMultiCourse(
    [
      { id: 100, name: "Course A" },
      { id: 200, name: "Course B" },
    ],
    "announcements"
  );

  assert.equal(items.length, 2);
  assert.equal(bulkCalls, 1);
  assert.equal(perCourseCalls, 2);
});

test("RadarService.getRadarItemsMultiCourse caches bulk announcement responses across repeated calls", async () => {
  let bulkCalls = 0;
  const now = new Date().toISOString();
  const client = stubClient({});
  client.getAnnouncementsForContexts = async () => {
    bulkCalls += 1;
    return [
      makeTopic({
        id: 5,
        title: "Course A Ann",
        is_announcement: true,
        context_code: "course_100",
        html_url: "https://canvas.example.com/courses/100/discussion_topics/5",
        posted_at: now,
      }),
    ];
  };
  client.getDiscussionTopicsSafe = async () => [];

  const service = new RadarService(client);
  await service.getRadarItemsMultiCourse([{ id: 100, name: "Course A" }], "announcements");
  await service.getRadarItemsMultiCourse([{ id: 100, name: "Course A" }], "announcements");

  assert.equal(bulkCalls, 1);
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
  assert.equal(result.status, "found");
  assert.equal(result.status === "found" && result.item.title, "Midterm Review Session");
});

test("RadarService.resolveTopicByPartialTitle finds unique partial match", async () => {
  const ann = makeTopic({ id: 1, title: "Midterm Review Session", is_announcement: true, posted_at: new Date().toISOString() });
  const client = stubClient({ announcements: [ann] });
  const service = new RadarService(client);

  const result = await service.resolveTopicByPartialTitle(
    [{ id: 1, name: "CS 101" }],
    "midterm"
  );
  assert.ok(result);
  assert.equal(result.status, "found");
  assert.equal(result.status === "found" && result.item.title, "Midterm Review Session");
});

test("RadarService.resolveTopicByPartialTitle returns ambiguous for multiple partial matches", async () => {
  const ann1 = makeTopic({ id: 1, title: "Midterm Review Session", is_announcement: true, posted_at: new Date().toISOString() });
  const ann2 = makeTopic({ id: 2, title: "Midterm Study Guide", is_announcement: true, posted_at: new Date().toISOString() });
  const client = stubClient({ announcements: [ann1, ann2] });
  const service = new RadarService(client);

  const result = await service.resolveTopicByPartialTitle(
    [{ id: 1, name: "CS 101" }],
    "midterm"
  );
  assert.ok(result);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.status === "ambiguous" && result.matches.length, 2);
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

// ---------------------------------------------------------------------------
// resolveTopicByPartialTitle — API search fallback
// ---------------------------------------------------------------------------

test("resolveTopicByPartialTitle falls back to API search when catalog has no match", async () => {
  const searchHit = makeTopic({
    id: 90,
    title: "Ancient Syllabus Thread",
    is_announcement: false,
    posted_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const client = stubClient({
    announcements: [],
    discussions: [],
    searchResults: [searchHit],
  });
  const service = new RadarService(client);

  const result = await service.resolveTopicByPartialTitle(
    [{ id: 1, name: "CS 101" }],
    "syllabus"
  );
  assert.ok(result);
  assert.equal(result.status, "found");
  assert.equal(result.status === "found" && result.item.topicId, 90);
});

test("resolveTopicByPartialTitle skips API search when catalog already matched", async () => {
  let searchCalled = false;
  const catalogTopic = makeTopic({
    id: 91,
    title: "Syllabus Overview",
    is_announcement: true,
    posted_at: new Date().toISOString(),
  });
  const client = stubClient({ announcements: [catalogTopic], discussions: [] });
  client.searchDiscussionTopicsSafe = async () => {
    searchCalled = true;
    return [];
  };
  const service = new RadarService(client);

  const result = await service.resolveTopicByPartialTitle(
    [{ id: 1, name: "CS 101" }],
    "syllabus"
  );
  assert.ok(result);
  assert.equal(result.status, "found");
  assert.equal(searchCalled, false);
});

test("resolveTopicByPartialTitle returns ambiguous from API search with multiple hits", async () => {
  const hit1 = makeTopic({ id: 92, title: "Lab Setup A" });
  const hit2 = makeTopic({ id: 93, title: "Lab Setup B" });
  const client = stubClient({
    announcements: [],
    discussions: [],
    searchResults: [hit1, hit2],
  });
  const service = new RadarService(client);

  const result = await service.resolveTopicByPartialTitle(
    [{ id: 1, name: "CS 101" }],
    "lab setup"
  );
  assert.ok(result);
  assert.equal(result.status, "ambiguous");
});

// ---------------------------------------------------------------------------
// Command-level: /announcements and /thread via resolveAndRenderThread
// ---------------------------------------------------------------------------

import { resolveAndRenderThread } from "../src/tui/radar-commands.js";
import type { AppServices } from "../src/tui/services/types.js";

function makeServices(radarService: RadarService): AppServices {
  return { radar: radarService } as unknown as AppServices;
}

// -- /announcements (tested via getRadarItems / getRadarItemsMultiCourse) --

test("/announcements global scope: merges items from multiple courses", async () => {
  const now = new Date().toISOString();
  const client = stubClient({});
  client.getAnnouncementsForContexts = async () => [
    makeTopic({
      id: 10,
      title: "CS Announcement",
      is_announcement: true,
      context_code: "course_1",
      html_url: "https://canvas.example.com/courses/1/discussion_topics/10",
      posted_at: now,
    }),
    makeTopic({
      id: 20,
      title: "Math Announcement",
      is_announcement: true,
      context_code: "course_2",
      html_url: "https://canvas.example.com/courses/2/discussion_topics/20",
      posted_at: now,
    }),
  ];
  client.getDiscussionTopicsSafe = async () => [];

  const service = new RadarService(client);
  const items = await service.getRadarItemsMultiCourse(
    [{ id: 1, name: "CS 101" }, { id: 2, name: "MATH 200" }],
    "all"
  );
  assert.equal(items.length, 2);
  const titles = items.map((i) => i.title);
  assert.ok(titles.includes("CS Announcement"));
  assert.ok(titles.includes("Math Announcement"));
});

test("/announcements course scope: returns only that course's items", async () => {
  const now = new Date().toISOString();
  const client = stubClient({
    announcements: [makeTopic({ id: 10, title: "Only Mine", is_announcement: true, posted_at: now })],
    discussions: [],
  });
  const service = new RadarService(client);

  const items = await service.getRadarItems(5, "BIO 300", "all");
  assert.equal(items.length, 1);
  assert.equal(items[0]!.courseName, "BIO 300");
});

test("/announcements discussions filter excludes announcements", async () => {
  const now = new Date().toISOString();
  const client = stubClient({
    announcements: [makeTopic({ id: 10, title: "Ann", is_announcement: true, posted_at: now })],
    discussions: [makeTopic({ id: 11, title: "Disc", is_announcement: false, posted_at: now })],
  });
  const service = new RadarService(client);

  const items = await service.getRadarItems(1, "CS 101", "discussions");
  assert.ok(items.every((i) => i.kind === "discussion"));
});

test("/announcements announcements filter excludes discussions", async () => {
  const now = new Date().toISOString();
  const client = stubClient({
    announcements: [makeTopic({ id: 10, title: "Ann", is_announcement: true, posted_at: now })],
    discussions: [makeTopic({ id: 11, title: "Disc", is_announcement: false, posted_at: now })],
  });
  const service = new RadarService(client);

  const items = await service.getRadarItems(1, "CS 101", "announcements");
  assert.ok(items.every((i) => i.kind === "announcement"));
});

// -- /thread --

test("/thread global scope: resolves numeric ID across courses", async () => {
  const topic = makeTopic({ id: 50, title: "Found It" });
  const view = makeView({
    view: [{
      id: 200,
      user_id: 1,
      user_name: "Alice",
      message: "<p>reply</p>",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      read_state: "read",
    }],
  });
  const client = stubClient({ discussions: [topic], announcements: [], view });
  const service = new RadarService(client);
  const services = makeServices(service);

  const result = await resolveAndRenderThread(
    services,
    [{ id: 1, name: "CS 101" }, { id: 2, name: "MATH 200" }],
    "50"
  );
  assert.equal(result.found, true);
  assert.ok(result.content.includes("Found It"));
});

test("/thread course scope: resolves by partial title within single course", async () => {
  const topic = makeTopic({ id: 60, title: "Homework 3 Questions", posted_at: new Date().toISOString() });
  const view = makeView();
  const client = stubClient({ discussions: [topic], announcements: [], view });
  const service = new RadarService(client);
  const services = makeServices(service);

  const result = await resolveAndRenderThread(services, [{ id: 1, name: "CS 101" }], "homework 3");
  assert.equal(result.found, true);
  assert.ok(result.content.includes("Homework 3 Questions"));
});

test("/thread shows disambiguation when multiple titles match", async () => {
  const now = new Date().toISOString();
  const t1 = makeTopic({ id: 70, title: "Exam Review Part 1", posted_at: now });
  const t2 = makeTopic({ id: 71, title: "Exam Review Part 2", posted_at: now });
  const client = stubClient({ discussions: [t1, t2], announcements: [] });
  const service = new RadarService(client);
  const services = makeServices(service);

  const result = await resolveAndRenderThread(services, [{ id: 1, name: "CS 101" }], "exam review");
  assert.equal(result.found, false);
  assert.ok(result.content.includes("Multiple threads"));
  assert.ok(result.content.includes("70"));
  assert.ok(result.content.includes("71"));
});

test("/thread returns not-found for unknown query", async () => {
  const client = stubClient({ discussions: [], announcements: [] });
  const service = new RadarService(client);
  const services = makeServices(service);

  const result = await resolveAndRenderThread(services, [{ id: 1, name: "CS 101" }], "nonexistent");
  assert.equal(result.found, false);
  assert.ok(result.content.includes("No discussion thread"));
});

test("/thread global scope: finds old topic via API search fallback", async () => {
  // Catalog is empty (topic is too old), but API search finds it
  const oldTopic = makeTopic({
    id: 80,
    title: "Semester 1 Setup Guide",
    posted_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const view = makeView();
  const client = stubClient({
    announcements: [],
    discussions: [],
    view,
  });
  // Only course 1 returns the search hit
  client.searchDiscussionTopicsSafe = async (courseId: number) =>
    courseId === 1 ? [oldTopic] : [];
  const service = new RadarService(client);
  const services = makeServices(service);

  const result = await resolveAndRenderThread(
    services,
    [{ id: 1, name: "CS 101" }, { id: 2, name: "MATH 200" }],
    "setup guide"
  );
  assert.equal(result.found, true);
  assert.ok(result.content.includes("Semester 1 Setup Guide"));
});
