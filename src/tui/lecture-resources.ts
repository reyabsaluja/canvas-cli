import fs from "node:fs/promises";
import path from "node:path";
import type { CourseCache } from "../enrich/cache-loader.js";
import type { CanvasClient } from "../canvas/client.js";
import type {
  OpenableResource,
  OpenResourceResult,
} from "./open-resources.js";
import {
  resolveOpenableResource,
  openResourceTarget,
} from "./open-resources.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LectureContentType = "video" | "slides" | "page" | "unknown";

interface CachedLectureHubPages {
  items: OpenableResource[];
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Heuristic helpers (exported for testing)
// ---------------------------------------------------------------------------

const LECTURE_NUMBER_PATTERNS = [
  /\blec(?:ture)?[-_ .]?(\d+)/i,
  /\bweek[-_ ]?(\d+)/i,
  /\bclass[-_ ]?(\d+)/i,
];

export function extractLectureNumber(text: string): number | null {
  for (const pattern of LECTURE_NUMBER_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) return parseInt(match[1], 10);
  }
  return null;
}

const STRONG_LECTURE_KEYWORDS =
  /\b(lecture|lec|recordings?)\b/i;
const LECTURE_CONTENT_KEYWORDS =
  /\b(video|slides?|presentation)\b/i;
const LECTURE_CONTEXT_KEYWORDS =
  /\b(lecture|lec|class|week|session|recordings?)\b/i;

export function isLectureLikeTitle(title: string): boolean {
  if (STRONG_LECTURE_KEYWORDS.test(title)) return true;
  if (!LECTURE_CONTENT_KEYWORDS.test(title)) return false;

  return (
    extractLectureNumber(title) !== null || LECTURE_CONTEXT_KEYWORDS.test(title)
  );
}

const VIDEO_URL_PATTERNS =
  /youtu\.?be|zoom\.(us|com)|vimeo\.com|panopto|kaltura|echo360|mediasite/i;

export function classifyContentType(
  url?: string | null,
  filename?: string | null
): LectureContentType {
  if (url && VIDEO_URL_PATTERNS.test(url)) return "video";
  const name = filename ?? url ?? "";
  if (/\.pdf$/i.test(name)) return "slides";
  if (/\.pptx?$/i.test(name)) return "slides";
  if (/\.mp4$/i.test(name)) return "video";
  if (/\.webm$/i.test(name)) return "video";
  if (url && /\/pages\//i.test(url)) return "page";
  return "unknown";
}

const LINK_REGEX = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

export function parseHtmlLinks(
  html: string
): Array<{ text: string; href: string }> {
  const results: Array<{ text: string; href: string }> = [];
  let match;
  while ((match = LINK_REGEX.exec(html)) !== null) {
    const href = match[1]!;
    const text = match[2]!.replace(/<[^>]*>/g, "").trim();
    if (href && text) results.push({ text, href });
  }
  // Reset lastIndex since LINK_REGEX has the global flag
  LINK_REGEX.lastIndex = 0;
  return results;
}

// ---------------------------------------------------------------------------
// Lecture index builder (cache-only, no network)
// ---------------------------------------------------------------------------

export function buildLectureIndex(cache: CourseCache): OpenableResource[] {
  const resources: OpenableResource[] = [];
  const seenTargets = new Set<string>();

  const push = (resource: OpenableResource): void => {
    if (seenTargets.has(resource.target)) return;
    seenTargets.add(resource.target);
    resources.push(resource);
  };

  // 1. Module items
  const downloadedByFileId = new Map<number, { localPath: string; filename: string }>();
  for (const attachment of cache.attachments) {
    if (
      (attachment.status === "downloaded" || attachment.status === "skipped") &&
      typeof attachment.canvasFileId === "number"
    ) {
      downloadedByFileId.set(attachment.canvasFileId, {
        localPath: path.join(cache.coursePath, attachment.localPath),
        filename: attachment.originalFilename,
      });
    }
  }

  for (const module of cache.modules) {
    for (const item of module.items) {
      if (!isLectureLikeTitle(item.title) && extractLectureNumber(item.title) === null) {
        continue;
      }

      const lecNum = extractLectureNumber(item.title);
      const aliases = buildLectureAliases(lecNum, item.title, module.name);

      if (item.type === "ExternalUrl" && item.externalUrl) {
        const contentType = classifyContentType(item.externalUrl);
        push(makeLectureResource(
          `lecture:module:${module.id}:${item.id}`,
          item.title,
          contentType,
          "url",
          item.externalUrl,
          aliases
        ));
      } else if (item.type === "File" && item.contentId !== null) {
        const downloaded = downloadedByFileId.get(item.contentId);
        const contentType = classifyContentType(null, item.title);
        if (downloaded) {
          push(makeLectureResource(
            `lecture:module:${module.id}:${item.id}`,
            item.title,
            contentType,
            "file",
            downloaded.localPath,
            aliases
          ));
        } else {
          const fileEntry = cache.files.find((f) => f.id === item.contentId);
          if (fileEntry) {
            push(makeLectureResource(
              `lecture:module:${module.id}:${item.id}`,
              item.title,
              contentType,
              "url",
              fileEntry.url,
              aliases
            ));
          }
        }
      } else if (item.type === "Page" && item.pageUrl) {
        const page = cache.pages.find((p) => p.pageId === item.pageUrl);
        const target = page?.htmlUrl ?? item.htmlUrl;
        if (target) {
          push(makeLectureResource(
            `lecture:module:${module.id}:${item.id}`,
            item.title,
            "page",
            "url",
            target,
            aliases
          ));
        }
      } else if (item.htmlUrl) {
        const contentType = classifyContentType(item.htmlUrl, item.title);
        push(makeLectureResource(
          `lecture:module:${module.id}:${item.id}`,
          item.title,
          contentType,
          "url",
          item.htmlUrl,
          aliases
        ));
      }
    }
  }

  // 2. Standalone files matching lecture patterns
  for (const file of cache.files) {
    if (extractLectureNumber(file.displayName) === null && extractLectureNumber(file.filename) === null) {
      continue;
    }
    const contentType = classifyContentType(null, file.filename);
    if (contentType !== "slides" && contentType !== "video") continue;

    const lecNum =
      extractLectureNumber(file.displayName) ??
      extractLectureNumber(file.filename);
    const aliases = buildLectureAliases(lecNum, file.displayName);

    const downloaded = downloadedByFileId.get(file.id);
    if (downloaded) {
      push(makeLectureResource(
        `lecture:file:${file.id}`,
        file.displayName,
        contentType,
        "file",
        downloaded.localPath,
        aliases
      ));
    } else {
      push(makeLectureResource(
        `lecture:file:${file.id}`,
        file.displayName,
        contentType,
        "url",
        file.url,
        aliases
      ));
    }
  }

  return resources;
}

// ---------------------------------------------------------------------------
// Front-page HTML link extraction (reads from disk, no network)
// ---------------------------------------------------------------------------

async function extractFrontPageLectures(
  coursePath: string
): Promise<OpenableResource[]> {
  const htmlPath = path.join(coursePath, "extracted", "front-page.html");
  let html: string;
  try {
    html = await fs.readFile(htmlPath, "utf-8");
  } catch {
    return [];
  }
  return extractLectureLinksFromHtml(html, "front-page");
}

function extractLectureLinksFromHtml(
  html: string,
  source: string
): OpenableResource[] {
  const links = parseHtmlLinks(html);
  const resources: OpenableResource[] = [];
  for (const link of links) {
    if (!isLectureLikeTitle(link.text) && extractLectureNumber(link.text) === null) {
      continue;
    }
    const contentType = classifyContentType(link.href, link.text);
    const lecNum = extractLectureNumber(link.text);
    const aliases = buildLectureAliases(lecNum, link.text, source);
    resources.push(makeLectureResource(
      `lecture:link:${source}:${link.href}`,
      link.text,
      contentType,
      "url",
      link.href,
      aliases
    ));
  }
  return resources;
}

// ---------------------------------------------------------------------------
// Lecture hub page resolution (runtime network fetch)
// ---------------------------------------------------------------------------

const LECTURE_HUB_PATTERNS =
  /\b(lecture\s*[\/\-&]?\s*(links?|slides?|recordings?|notes?|videos?)|recordings?\s*[&\/\-]?\s*links?|lecture\s*notes?\s*and|notes?\s*[\/\-&]?\s*recordings?)\b/i;

const LECTURE_HUB_CACHE_TTL_MS = 300_000;
const lectureHubPageCache = new Map<string, CachedLectureHubPages>();
const lectureHubPageInflight = new Map<string, Promise<OpenableResource[]>>();

function findLectureHubPages(cache: CourseCache): Array<{ pageId: string; title: string }> {
  return cache.pages.filter((p) => LECTURE_HUB_PATTERNS.test(p.title));
}

async function resolveLectureHubPages(
  cache: CourseCache,
  client: CanvasClient,
  courseId: number
): Promise<OpenableResource[]> {
  const cacheKey = `${courseId}:${cache.coursePath}`;
  const cached = lectureHubPageCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < LECTURE_HUB_CACHE_TTL_MS) {
    return cached.items;
  }

  const inFlight = lectureHubPageInflight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const hubs = findLectureHubPages(cache);
  const load = (async () => {
    const results = (
      await Promise.all(
        hubs.map(async (hub) => {
          try {
            const page = await client.getPageBySlugSafe(courseId, hub.pageId);
            if (!page?.body) return [];
            return extractLectureLinksFromHtml(page.body, hub.title);
          } catch {
            return [];
          }
        })
      )
    ).flat();
    lectureHubPageCache.set(cacheKey, {
      items: results,
      fetchedAt: Date.now(),
    });
    return results;
  })();

  lectureHubPageInflight.set(cacheKey, load);
  try {
    return await load;
  } finally {
    lectureHubPageInflight.delete(cacheKey);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function handleLectureQuery(
  query: string,
  cache: CourseCache | null,
  client?: CanvasClient | null,
  courseId?: number | null,
  opener: typeof openResourceTarget = openResourceTarget
): Promise<OpenResourceResult> {
  if (!cache) {
    return {
      status: "missing",
      message:
        "No course cache is available. Open a workspace or run cache ingestion first.",
    };
  }

  // Build index from cache (no network)
  const lectures = buildLectureIndex(cache);

  // Add front-page links (disk read only)
  const frontPageLectures = await extractFrontPageLectures(cache.coursePath);
  const seenTargets = new Set(lectures.map((l) => l.target));
  mergeLectureResources(lectures, seenTargets, frontPageLectures);

  if (lectures.length === 0) {
    if (client && courseId) {
      const hubLectures = await resolveLectureHubPages(cache, client, courseId);
      mergeLectureResources(lectures, seenTargets, hubLectures);
    }
  }

  if (lectures.length === 0) {
    return {
      status: "missing",
      message:
        "No lecture content was found in this course. Lectures may not be published yet, or may be hosted outside Canvas.",
    };
  }

  const trimmed = query.trim();
  if (!trimmed) {
    return {
      status: "listed",
      message: formatLectureList(lectures),
      };
  }

  let resolved = resolveOpenableResource(trimmed, lectures);
  if (
    resolved.status === "missing" &&
    client &&
    courseId &&
    findLectureHubPages(cache).length > 0
  ) {
    const hubLectures = await resolveLectureHubPages(cache, client, courseId);
    mergeLectureResources(lectures, seenTargets, hubLectures);
    resolved = resolveOpenableResource(trimmed, lectures);
  }

  if (resolved.status === "missing") {
    return {
      status: "missing",
      message: `No lecture matched "${trimmed}".\nAvailable lectures:\n${formatLectureList(lectures)}`,
    };
  }

  if (resolved.status === "ambiguous") {
    return {
      status: "ambiguous",
      matches: resolved.matches,
      message: [
        `Multiple lectures matched "${trimmed}":`,
        ...resolved.matches
          .slice(0, 8)
          .map((r) => `• ${r.title} (${r.kind})`),
        "Be more specific, e.g. /lecture 13 video or /lecture 13 slides.",
      ].join("\n"),
    };
  }

  try {
    await opener(resolved.resource);
  } catch (error) {
    return {
      status: "missing",
      message: `Failed to open ${resolved.resource.title}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }

  return {
    status: "opened",
    resource: resolved.resource,
    message: `Opened ${resolved.resource.title} (${resolved.resource.kind}).`,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeLectureResource(
  id: string,
  title: string,
  contentType: LectureContentType,
  targetType: "file" | "url",
  target: string,
  aliases: string[]
): OpenableResource {
  const kindLabel =
    contentType === "video"
      ? "lecture video"
      : contentType === "slides"
        ? "lecture slides"
        : contentType === "page"
          ? "lecture page"
          : "lecture";
  return {
    id,
    title,
    kind: kindLabel,
    targetType,
    target,
    searchTerms: [title, kindLabel, contentType, ...aliases],
  };
}

function buildLectureAliases(
  lecNum: number | null,
  title: string,
  source?: string
): string[] {
  const aliases: string[] = [];
  if (lecNum !== null) {
    aliases.push(
      String(lecNum),
      `lecture ${lecNum}`,
      `lec ${lecNum}`,
      `lec${lecNum}`
    );
  }
  // Add meaningful words from the title
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  aliases.push(...words);
  if (source) aliases.push(source);
  return aliases;
}

function mergeLectureResources(
  lectures: OpenableResource[],
  seenTargets: Set<string>,
  additions: OpenableResource[]
): void {
  for (const lecture of additions) {
    if (seenTargets.has(lecture.target)) continue;
    seenTargets.add(lecture.target);
    lectures.push(lecture);
  }
}

function formatLectureList(lectures: OpenableResource[]): string {
  const lines = [
    `**Lectures** (${lectures.length} item${lectures.length === 1 ? "" : "s"})`,
    "",
  ];
  for (const lecture of lectures.slice(0, 40)) {
    const type = lecture.kind === "lecture" ? "" : ` [${lecture.kind.replace("lecture ", "")}]`;
    lines.push(`• ${lecture.title}${type}`);
  }
  if (lectures.length > 40) {
    lines.push(`... and ${lectures.length - 40} more`);
  }
  return lines.join("\n");
}
