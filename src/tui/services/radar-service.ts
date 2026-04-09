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

  async getRadarItemsMultiCourse(
    courses: Array<{ id: number; name: string }>,
    filter: RadarFilter,
    query?: string
  ): Promise<RadarItem[]> {
    const results = await Promise.all(
      courses.map(async (c) => {
        try {
          return await this.getRadarItems(c.id, c.name, filter, query);
        } catch {
          return [];
        }
      })
    );

    const merged = results.flat();
    return sortRadarItems(merged);
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
    const rawTopic = allTopics.find((t) => t.id === topicId);
    if (!rawTopic) return null;
    const view =
      initialView ?? (await this.client.getDiscussionTopicViewSafe(courseId, topicId));
    if (!view) return null;

    return this.buildThread(rawTopic, view, courseId, courseName);
  }

  async resolveTopicByPartialTitle(
    courses: Array<{ id: number; name: string }>,
    query: string
  ): Promise<{ item: RadarItem; courseId: number } | null> {
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
    const normalized = query.toLowerCase();

    const exact = allItems.find(
      (item) => item.title.toLowerCase() === normalized
    );
    if (exact) return { item: exact, courseId: exact.courseId };

    const partial = allItems.filter((item) =>
      item.title.toLowerCase().includes(normalized)
    );
    if (partial.length === 1) return { item: partial[0]!, courseId: partial[0]!.courseId };
    if (partial.length > 1) return { item: partial[0]!, courseId: partial[0]!.courseId };

    return null;
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
    const cutoff = Date.now() - RECENT_WINDOW_MS;

    const catalog = await this.getTopicCatalog(courseId);
    const announcements =
      filter === "discussions" ? [] : catalog.announcements;
    const discussions =
      filter === "announcements" ? [] : catalog.discussions;

    const items: RadarItem[] = [];

    for (const a of announcements) {
      const posted = a.posted_at ? new Date(a.posted_at).getTime() : 0;
      if (posted >= cutoff) {
        items.push(normalizeTopicToRadarItem(a, courseId, courseName));
      }
    }

    const unread: RadarItem[] = [];
    const recent: RadarItem[] = [];
    for (const d of discussions) {
      const item = normalizeTopicToRadarItem(d, courseId, courseName);
      if (d.read_state === "unread" || d.unread_count > 0) {
        unread.push(item);
      } else {
        const activity = d.last_reply_at
          ? new Date(d.last_reply_at).getTime()
          : d.posted_at
            ? new Date(d.posted_at).getTime()
            : 0;
        if (activity >= cutoff) {
          recent.push(item);
        }
      }
    }

    items.push(...unread, ...recent);
    return sortRadarItems(items);
  }

  private async getTopicCatalog(courseId: number): Promise<CachedTopicCatalog> {
    const cacheKey = String(courseId);
    const cached = this.topicCatalogCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < LIST_TTL_MS) {
      return cached;
    }

    const [announcements, discussions] = await Promise.all([
      this.client.getAnnouncementsSafe(courseId),
      this.client.getDiscussionTopicsSafe(courseId),
    ]);
    const catalog: CachedTopicCatalog = {
      announcements,
      discussions,
      fetchedAt: Date.now(),
    };
    this.topicCatalogCache.set(cacheKey, catalog);
    return catalog;
  }
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

function filterByQuery(items: RadarItem[], query: string): RadarItem[] {
  const normalized = query.toLowerCase();
  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(normalized) ||
      item.courseName.toLowerCase().includes(normalized) ||
      (item.authorName?.toLowerCase().includes(normalized) ?? false)
  );
}
