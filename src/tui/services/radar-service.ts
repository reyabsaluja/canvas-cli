import type { CanvasClient } from "../../canvas/client.js";
import type {
  CanvasDiscussionEntry,
  CanvasDiscussionTopic,
  CanvasDiscussionTopicView,
} from "../../canvas/types.js";
import { htmlToText } from "../../format/html-to-text.js";
import type {
  RadarFilter,
  RadarItem,
  RadarThread,
  RadarThreadEntry,
} from "./radar-types.js";

interface CachedList {
  items: RadarItem[];
  fetchedAt: number;
}

interface CachedTopicCatalog {
  announcements: CanvasDiscussionTopic[];
  discussions: CanvasDiscussionTopic[];
  announcementsFetchedAt: number | null;
  discussionsFetchedAt: number | null;
}

interface CachedBulkAnnouncements {
  itemsByCourseId: Map<number, CanvasDiscussionTopic[]>;
  fetchedAt: number;
}

interface CachedThread {
  thread: RadarThread;
  fetchedAt: number;
}

const LIST_TTL_MS = 60_000;
const THREAD_TTL_MS = 300_000;
const MAX_THREAD_ENTRIES = 200;
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export class RadarService {
  private client: CanvasClient;
  private listCache = new Map<string, CachedList>();
  private topicCatalogCache = new Map<string, CachedTopicCatalog>();
  private bulkAnnouncementsCache = new Map<string, CachedBulkAnnouncements>();
  private threadCache = new Map<string, CachedThread>();

  constructor(client: CanvasClient) {
    this.client = client;
  }

  async getRadarItems(
    courseId: number,
    courseName: string,
    filter: RadarFilter,
    query?: string
  ): Promise<RadarItem[]> {
    const cacheKey = `${courseId}:${filter}`;
    const cached = this.listCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < LIST_TTL_MS) {
      return query ? filterByQuery(cached.items, query) : cached.items;
    }

    const items = await this.fetchRadarItems(courseId, courseName, filter);
    this.listCache.set(cacheKey, { items, fetchedAt: Date.now() });
    return query ? filterByQuery(items, query) : items;
  }

  async getAllAnnouncements(
    courseId: number,
    courseName: string
  ): Promise<RadarItem[]> {
    const announcements = await this.client.getAnnouncementsSafe(courseId);
    return sortRadarItems(
      announcements.map((a) => normalizeTopicToRadarItem(a, courseId, courseName))
    );
  }

  async getAllAnnouncementsMultiCourse(
    courses: Array<{ id: number; name: string }>
  ): Promise<RadarItem[]> {
    if (courses.length === 0) return [];

    const results = await Promise.all(
      courses.map((course) => this.getAllAnnouncements(course.id, course.name))
    );

    return sortRadarItems(results.flat());
  }

  async getRadarItemsMultiCourse(
    courses: Array<{ id: number; name: string }>,
    filter: RadarFilter,
    query?: string
  ): Promise<RadarItem[]> {
    if (courses.length === 0) return [];

    const announcementsByCourse =
      filter === "discussions"
        ? new Map<number, CanvasDiscussionTopic[]>()
        : await this.getAnnouncementsMultiCourse(courses);

    const results = await Promise.all(
      courses.map(async (course) => {
        try {
          const items: RadarItem[] = [];

          if (filter !== "discussions") {
            items.push(
              ...buildAnnouncementItems(
                announcementsByCourse.get(course.id) ?? [],
                course.id,
                course.name
              )
            );
          }

          if (filter !== "announcements") {
            const discussions = await this.getCourseDiscussions(course.id);
            items.push(...buildDiscussionItems(discussions, course.id, course.name));
          }

          return items;
        } catch {
          return [];
        }
      })
    );

    const merged = sortRadarItems(results.flat());
    return query ? filterByQuery(merged, query) : merged;
  }

  async getThread(
    courseId: number,
    courseName: string,
    topicId: number
  ): Promise<RadarThread | null> {
    const cacheKey = `${courseId}:${topicId}`;
    const cached = this.threadCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < THREAD_TTL_MS) {
      return cached.thread;
    }

    const [catalog, initialView] = await Promise.all([
      this.getTopicCatalog(courseId),
      this.client.getDiscussionTopicViewSafe(courseId, topicId),
    ]);
    const allTopics = [...catalog.announcements, ...catalog.discussions];
    let rawTopic = allTopics.find((t) => t.id === topicId);

    // Topic may not be in the recent-activity catalog (e.g. old thread found
    // via API search). Fall back to a targeted search to get its metadata.
    if (!rawTopic) {
      const searchResults = await this.client.searchDiscussionTopicsSafe(
        courseId,
        String(topicId)
      );
      rawTopic = searchResults.find((t) => t.id === topicId);
    }
    if (!rawTopic) return null;

    const view =
      initialView ?? (await this.client.getDiscussionTopicViewSafe(courseId, topicId));
    if (!view) return null;

    return this.buildThread(rawTopic, view, courseId, courseName);
  }

  async resolveTopicByPartialTitle(
    courses: Array<{ id: number; name: string }>,
    query: string
  ): Promise<
    | { status: "found"; item: RadarItem; courseId: number }
    | { status: "ambiguous"; matches: RadarItem[] }
    | null
  > {
    // Step 1: Search the cached topic catalog (no network if warm).
    const catalogResult = await this.searchCatalog(courses, query);
    if (catalogResult) return catalogResult;

    // Step 2: Fall back to Canvas search_term API for matches beyond the
    // recent-activity window that the catalog covers.
    return this.searchApi(courses, query);
  }

  private async searchCatalog(
    courses: Array<{ id: number; name: string }>,
    query: string
  ): Promise<
    | { status: "found"; item: RadarItem; courseId: number }
    | { status: "ambiguous"; matches: RadarItem[] }
    | null
  > {
    const results = await Promise.all(
      courses.map(async (course) => {
        try {
          const catalog = await this.getTopicCatalog(course.id);
          return [
            ...catalog.announcements.map((topic) =>
              normalizeTopicToRadarItem(topic, course.id, course.name)
            ),
            ...catalog.discussions.map((topic) =>
              normalizeTopicToRadarItem(topic, course.id, course.name)
            ),
          ];
        } catch {
          return [];
        }
      })
    );
    const allItems = sortRadarItems(results.flat());
    return matchItems(allItems, query);
  }

  private async searchApi(
    courses: Array<{ id: number; name: string }>,
    query: string
  ): Promise<
    | { status: "found"; item: RadarItem; courseId: number }
    | { status: "ambiguous"; matches: RadarItem[] }
    | null
  > {
    const results = await Promise.all(
      courses.map(async (course) => {
        try {
          const topics = await this.client.searchDiscussionTopicsSafe(
            course.id,
            query
          );
          return topics.map((topic) =>
            normalizeTopicToRadarItem(topic, course.id, course.name)
          );
        } catch {
          return [];
        }
      })
    );
    const allItems = sortRadarItems(results.flat());
    return matchItems(allItems, query);
  }

  private buildThread(
    rawTopic: CanvasDiscussionTopic,
    view: CanvasDiscussionTopicView,
    courseId: number,
    courseName: string
  ): RadarThread {
    const topic = normalizeTopicToRadarItem(rawTopic, courseId, courseName);
    const participants = new Map<number, string>();
    for (const p of view.participants) {
      participants.set(p.id, p.display_name);
    }

    const allEntries = [...view.view, ...view.new_entries];
    const entries = flattenEntries(allEntries, participants, 0);

    const thread: RadarThread = {
      topic,
      body: rawTopic.message ? htmlToText(rawTopic.message) : "",
      entries: entries.slice(0, MAX_THREAD_ENTRIES),
      participantCount: view.participants.length,
      totalEntries: entries.length,
    };

    this.threadCache.set(`${courseId}:${rawTopic.id}`, {
      thread,
      fetchedAt: Date.now(),
    });
    return thread;
  }

  private async fetchRadarItems(
    courseId: number,
    courseName: string,
    filter: RadarFilter
  ): Promise<RadarItem[]> {
    const catalog = await this.getTopicCatalog(courseId);
    return sortRadarItems([
      ...(filter === "discussions"
        ? []
        : buildAnnouncementItems(catalog.announcements, courseId, courseName)),
      ...(filter === "announcements"
        ? []
        : buildDiscussionItems(catalog.discussions, courseId, courseName)),
    ]);
  }

  private async getTopicCatalog(courseId: number): Promise<CachedTopicCatalog> {
    const cacheKey = String(courseId);
    const cached = this.topicCatalogCache.get(cacheKey);
    const hasFreshAnnouncements = cached
      ? this.isFresh(cached.announcementsFetchedAt)
      : false;
    const hasFreshDiscussions = cached
      ? this.isFresh(cached.discussionsFetchedAt)
      : false;

    if (cached && hasFreshAnnouncements && hasFreshDiscussions) {
      return cached;
    }

    const [announcements, discussions] = await Promise.all([
      hasFreshAnnouncements
        ? Promise.resolve(cached?.announcements ?? [])
        : this.client.getAnnouncementsSafe(courseId),
      hasFreshDiscussions
        ? Promise.resolve(cached?.discussions ?? [])
        : this.client.getDiscussionTopicsSafe(courseId),
    ]);
    const fetchedAt = Date.now();
    const catalog: CachedTopicCatalog = {
      announcements,
      discussions,
      announcementsFetchedAt: hasFreshAnnouncements
        ? cached?.announcementsFetchedAt ?? fetchedAt
        : fetchedAt,
      discussionsFetchedAt: hasFreshDiscussions
        ? cached?.discussionsFetchedAt ?? fetchedAt
        : fetchedAt,
    };
    this.topicCatalogCache.set(cacheKey, catalog);
    return catalog;
  }

  private async getCourseDiscussions(
    courseId: number
  ): Promise<CanvasDiscussionTopic[]> {
    const cacheKey = String(courseId);
    const cached = this.topicCatalogCache.get(cacheKey);
    if (cached && this.isFresh(cached.discussionsFetchedAt)) {
      return cached.discussions;
    }

    const discussions = await this.client.getDiscussionTopicsSafe(courseId);
    this.topicCatalogCache.set(cacheKey, {
      announcements: cached?.announcements ?? [],
      discussions,
      announcementsFetchedAt: cached?.announcementsFetchedAt ?? null,
      discussionsFetchedAt: Date.now(),
    });
    return discussions;
  }

  private async getAnnouncementsMultiCourse(
    courses: Array<{ id: number; name: string }>
  ): Promise<Map<number, CanvasDiscussionTopic[]>> {
    const cacheKey = courses
      .map((course) => course.id)
      .sort((left, right) => left - right)
      .join(",");
    const cached = this.bulkAnnouncementsCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < LIST_TTL_MS) {
      return cached.itemsByCourseId;
    }

    const startDate = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
    let itemsByCourseId: Map<number, CanvasDiscussionTopic[]>;

    try {
      const announcements = await this.client.getAnnouncementsForContexts(
        courses.map((course) => `course_${course.id}`),
        { startDate }
      );
      itemsByCourseId = groupAnnouncementsByCourse(courses, announcements);
    } catch {
      const perCourse = await Promise.all(
        courses.map(async (course) => [
          course.id,
          await this.client.getAnnouncementsSafe(course.id, { startDate }),
        ] as const)
      );
      itemsByCourseId = new Map(perCourse);
    }

    const fetchedAt = Date.now();
    for (const course of courses) {
      const announcements = itemsByCourseId.get(course.id) ?? [];
      const cachedCatalog = this.topicCatalogCache.get(String(course.id));
      this.topicCatalogCache.set(String(course.id), {
        announcements,
        discussions: cachedCatalog?.discussions ?? [],
        announcementsFetchedAt: fetchedAt,
        discussionsFetchedAt: cachedCatalog?.discussionsFetchedAt ?? null,
      });
    }

    this.bulkAnnouncementsCache.set(cacheKey, {
      itemsByCourseId,
      fetchedAt,
    });
    return itemsByCourseId;
  }

  private isFresh(fetchedAt: number | null): boolean {
    return fetchedAt !== null && Date.now() - fetchedAt < LIST_TTL_MS;
  }
}

function buildAnnouncementItems(
  announcements: CanvasDiscussionTopic[],
  courseId: number,
  courseName: string
): RadarItem[] {
  return announcements.map((announcement) =>
    normalizeTopicToRadarItem(announcement, courseId, courseName)
  );
}

function buildDiscussionItems(
  discussions: CanvasDiscussionTopic[],
  courseId: number,
  courseName: string
): RadarItem[] {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const unread: RadarItem[] = [];
  const recent: RadarItem[] = [];

  for (const discussion of discussions) {
    const item = normalizeTopicToRadarItem(discussion, courseId, courseName);
    if (discussion.read_state === "unread" || discussion.unread_count > 0) {
      unread.push(item);
      continue;
    }

    const activity = discussion.last_reply_at
      ? new Date(discussion.last_reply_at).getTime()
      : discussion.posted_at
        ? new Date(discussion.posted_at).getTime()
        : 0;
    if (activity >= cutoff) {
      recent.push(item);
    }
  }

  return [...unread, ...recent];
}

function groupAnnouncementsByCourse(
  courses: Array<{ id: number; name: string }>,
  announcements: CanvasDiscussionTopic[]
): Map<number, CanvasDiscussionTopic[]> {
  const allowedCourseIds = new Set(courses.map((course) => course.id));
  const grouped = new Map<number, CanvasDiscussionTopic[]>();
  for (const course of courses) {
    grouped.set(course.id, []);
  }

  for (const announcement of announcements) {
    const courseId = getAnnouncementCourseId(announcement);
    if (courseId === null || !allowedCourseIds.has(courseId)) continue;
    grouped.get(courseId)?.push(announcement);
  }

  return grouped;
}

function getAnnouncementCourseId(
  announcement: CanvasDiscussionTopic
): number | null {
  const contextCode = announcement.context_code ?? null;
  if (contextCode) {
    const contextMatch = contextCode.match(/^course_(\d+)$/);
    if (contextMatch?.[1]) return parseInt(contextMatch[1], 10);
  }

  const htmlUrlMatch = announcement.html_url.match(/\/courses\/(\d+)\//);
  if (htmlUrlMatch?.[1]) return parseInt(htmlUrlMatch[1], 10);
  return null;
}

function normalizeTopicToRadarItem(
  topic: CanvasDiscussionTopic,
  courseId: number,
  courseName: string
): RadarItem {
  return {
    kind: topic.is_announcement ? "announcement" : "discussion",
    topicId: topic.id,
    courseId,
    courseName,
    title: topic.title,
    authorName: topic.user_name,
    postedAt: topic.posted_at ? new Date(topic.posted_at) : null,
    lastReplyAt: topic.last_reply_at ? new Date(topic.last_reply_at) : null,
    unreadCount: topic.unread_count,
    htmlUrl: topic.html_url,
    locked: topic.locked,
  };
}

function flattenEntries(
  entries: CanvasDiscussionEntry[],
  participants: Map<number, string>,
  depth: number
): RadarThreadEntry[] {
  const result: RadarThreadEntry[] = [];
  for (const entry of entries) {
    result.push({
      entryId: entry.id,
      authorName:
        entry.user_name ??
        participants.get(entry.user_id) ??
        `User ${entry.user_id}`,
      message: entry.message ? htmlToText(entry.message) : "",
      createdAt: new Date(entry.created_at),
      depth,
    });
    if (entry.recent_replies && entry.recent_replies.length > 0) {
      result.push(
        ...flattenEntries(entry.recent_replies, participants, depth + 1)
      );
    }
  }
  return result;
}

function sortRadarItems(items: RadarItem[]): RadarItem[] {
  return items.sort((a, b) => {
    const aTime = mostRecentTime(a);
    const bTime = mostRecentTime(b);
    return bTime - aTime;
  });
}

function mostRecentTime(item: RadarItem): number {
  return Math.max(
    item.lastReplyAt?.getTime() ?? 0,
    item.postedAt?.getTime() ?? 0
  );
}

function matchItems(
  allItems: RadarItem[],
  query: string
): { status: "found"; item: RadarItem; courseId: number } | { status: "ambiguous"; matches: RadarItem[] } | null {
  const normalized = query.toLowerCase();

  const exact = allItems.find(
    (item) => item.title.toLowerCase() === normalized
  );
  if (exact) return { status: "found", item: exact, courseId: exact.courseId };

  const partial = allItems.filter((item) =>
    item.title.toLowerCase().includes(normalized)
  );
  if (partial.length === 1) return { status: "found", item: partial[0]!, courseId: partial[0]!.courseId };
  if (partial.length > 1) return { status: "ambiguous", matches: partial };

  // API search may return results that don't contain the query as a substring
  // (Canvas does fuzzy matching). Treat a single API result as found.
  if (allItems.length === 1) return { status: "found", item: allItems[0]!, courseId: allItems[0]!.courseId };
  if (allItems.length > 1) return { status: "ambiguous", matches: allItems };

  return null;
}

function filterByQuery(items: RadarItem[], query: string): RadarItem[] {
  const normalized = query.toLowerCase();
  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(normalized) ||
      item.courseName.toLowerCase().includes(normalized) ||
      (item.authorName?.toLowerCase().includes(normalized) ?? false)
  );
}
