import type {
  ModuleIndexEntry,
  PageIndexEntry,
  LectureIndexEntry,
} from "./types.js";
import { decodeEntities } from "../format/html-to-text.js";

const LECTURE_NUMBER_PATTERNS = [
  /\blec(?:ture)?[-_ .]?(\d+)/i,
  /\bweek[-_ ]?(\d+)/i,
  /\bclass[-_ ]?(\d+)/i,
];

const STRONG_LECTURE_KEYWORDS = /\b(lectures?|lec|recordings?)\b/i;
const LECTURE_CONTENT_KEYWORDS = /\b(video|slides?|presentation)\b/i;
const LECTURE_CONTEXT_KEYWORDS = /\b(lecture|lec|class|week|session|recordings?)\b/i;

const VIDEO_URL_PATTERNS =
  /youtu\.?be|zoom\.(us|com)|vimeo\.com|panopto|kaltura|echo360|mediasite/i;

const LINK_REGEX_GLOBAL = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

function extractLectureNumber(text: string): number | null {
  for (const pattern of LECTURE_NUMBER_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) return parseInt(match[1], 10);
  }
  return null;
}

function isLectureLikeTitle(title: string): boolean {
  if (STRONG_LECTURE_KEYWORDS.test(title)) return true;
  if (!LECTURE_CONTENT_KEYWORDS.test(title)) return false;
  return extractLectureNumber(title) !== null || LECTURE_CONTEXT_KEYWORDS.test(title);
}

function classifyContentType(
  url?: string | null,
  filename?: string | null
): LectureIndexEntry["contentType"] {
  if (url && VIDEO_URL_PATTERNS.test(url)) return "video";
  const name = filename ?? url ?? "";
  if (/\.pdf$/i.test(name)) return "slides";
  if (/\.pptx?$/i.test(name)) return "slides";
  if (/\.mp4$/i.test(name)) return "video";
  if (/\.webm$/i.test(name)) return "video";
  if (url && /\/pages\//i.test(url)) return "page";
  return "unknown";
}

function parseHtmlLinks(html: string): Array<{ text: string; href: string }> {
  const results: Array<{ text: string; href: string }> = [];
  let match;
  while ((match = LINK_REGEX_GLOBAL.exec(html)) !== null) {
    const href = match[1]!;
    const text = match[2]!.replace(/<[^>]*>/g, "").trim();
    if (href && text) results.push({ text: decodeEntities(text), href });
  }
  LINK_REGEX_GLOBAL.lastIndex = 0;
  return results;
}

const NAV_NOISE_RE = /\b(home|syllabus|modules|assignments?|grades|people|announcements?|discussions?|quizzes?|settings|files|outcomes|rubrics?|collaborations?|conferences?|pages)\b/i;

function extractAllLinksAsLectures(
  html: string,
  source: string
): LectureIndexEntry[] {
  const links = parseHtmlLinks(html);
  const entries: LectureIndexEntry[] = [];
  for (const link of links) {
    if (!link.text || link.text.length < 3) continue;
    if (NAV_NOISE_RE.test(link.text) && link.text.split(/\s+/).length <= 2) continue;
    entries.push({
      title: link.text,
      url: link.href,
      contentType: classifyContentType(link.href, link.text),
      source,
      lectureNumber: extractLectureNumber(link.text),
    });
  }
  return entries;
}

function extractLecturesFromHtml(
  html: string,
  source: string
): LectureIndexEntry[] {
  const links = parseHtmlLinks(html);
  const entries: LectureIndexEntry[] = [];
  for (const link of links) {
    if (!isLectureLikeTitle(link.text) && extractLectureNumber(link.text) === null) {
      continue;
    }
    entries.push({
      title: link.text,
      url: link.href,
      contentType: classifyContentType(link.href, link.text),
      source,
      lectureNumber: extractLectureNumber(link.text),
    });
  }
  return entries;
}

export function discoverLectures(
  modules: ModuleIndexEntry[],
  pages: PageIndexEntry[],
  frontPageBody: string | null,
  fetchedPages: Array<{ slug: string; title: string; body: string }>,
  syllabusBody: string | null
): LectureIndexEntry[] {
  const entries: LectureIndexEntry[] = [];
  const seenKeys = new Set<string>();

  const push = (entry: LectureIndexEntry): void => {
    const key = entry.url || `${entry.title.toLowerCase()}`;
    if (seenKeys.has(key)) return;
    const normalizedTitle = entry.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const titleKey = `title:${normalizedTitle}`;
    if (seenKeys.has(titleKey)) return;
    seenKeys.add(key);
    seenKeys.add(titleKey);
    entries.push(entry);
  };

  // 1. Module items with lecture-like titles
  for (const mod of modules) {
    for (const item of mod.items) {
      if (!isLectureLikeTitle(item.title) && extractLectureNumber(item.title) === null) {
        continue;
      }
      const url = item.externalUrl ?? item.htmlUrl ?? null;
      if (!url) continue;
      push({
        title: decodeEntities(item.title),
        url,
        contentType: classifyContentType(url, item.title),
        source: `module: ${mod.name}`,
        lectureNumber: extractLectureNumber(item.title),
      });
    }
  }

  // 2. Front page links
  if (frontPageBody) {
    for (const entry of extractLecturesFromHtml(frontPageBody, "front page")) {
      push(entry);
    }
  }

  // 3. Syllabus body links
  if (syllabusBody) {
    for (const entry of extractLecturesFromHtml(syllabusBody, "syllabus")) {
      push(entry);
    }
  }

  // 4. Fetched page bodies — lecture-titled pages get all their links scraped
  //    (hub pages like "Prof. Rose's Lectures" contain the actual lecture links);
  //    other pages are only scanned for lecture-like links
  for (const page of fetchedPages) {
    const isHub = isLectureLikeTitle(page.title) || extractLectureNumber(page.title) !== null;
    if (isHub) {
      for (const entry of extractAllLinksAsLectures(page.body, `page: ${page.title}`)) {
        push(entry);
      }
    } else {
      for (const entry of extractLecturesFromHtml(page.body, `page: ${page.title}`)) {
        push(entry);
      }
    }
  }

  // 5. Pages themselves that have lecture-like titles (as hub pages)
  for (const page of pages) {
    if (!isLectureLikeTitle(page.title)) continue;
    if (!page.htmlUrl) continue;
    push({
      title: decodeEntities(page.title),
      url: page.htmlUrl,
      contentType: "page",
      source: "page index",
      lectureNumber: extractLectureNumber(page.title),
    });
  }

  entries.sort((a, b) => {
    if (a.lectureNumber !== null && b.lectureNumber !== null) {
      return a.lectureNumber - b.lectureNumber;
    }
    if (a.lectureNumber !== null) return -1;
    if (b.lectureNumber !== null) return 1;
    return a.title.localeCompare(b.title);
  });

  return entries;
}
