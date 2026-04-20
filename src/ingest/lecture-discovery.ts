import type {
  ModuleIndexEntry,
  PageIndexEntry,
  LectureIndexEntry,
} from "./types.js";
import { decodeEntities } from "../format/html-to-text.js";

const LECTURE_NUMBER_PATTERNS = [
  /\blec(?:ture)?[-_ .]?(\d+)/i,
  /\bmodule[-_ .]?(\d+)/i,
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

function extractRowText(html: string): string {
  return html
    .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTopicFromRowText(rowText: string, linkText: string): string | undefined {
  const cleaned = rowText
    .replace(new RegExp(linkText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "")
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, "")
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/gi, "")
    .replace(/\b\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)/gi, "")
    .replace(/\b\d{1,2}(am|pm)\b/gi, "")
    .replace(/\b\d{1,2}:\d{2}\b/g, "")
    .replace(/\b(noon|midnight)\b/gi, "")
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)\w*\b/gi, "")
    .replace(/\bnotes?:?\b/gi, "")
    .replace(/\bvideo:?\b/gi, "")
    .replace(/\brecording:?\b/gi, "")
    .replace(/\blecture\s*#?\s*\d*/gi, "")
    .replace(/[|·•–—,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length >= 5 && cleaned.length <= 200) {
    return cleaned;
  }
  return undefined;
}

const TABLE_ROW_REGEX = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;

function extractAllLinksAsLectures(
  html: string,
  source: string
): LectureIndexEntry[] {
  const entries: LectureIndexEntry[] = [];

  const hasTable = /<table\b/i.test(html);
  if (hasTable) {
    let rowMatch;
    while ((rowMatch = TABLE_ROW_REGEX.exec(html)) !== null) {
      const rowHtml = rowMatch[1]!;
      const rowLinks = parseHtmlLinks(rowHtml);
      if (rowLinks.length === 0) continue;

      const rowText = extractRowText(rowHtml);

      for (const link of rowLinks) {
        if (!link.text || link.text.length < 3) continue;
        if (NAV_NOISE_RE.test(link.text) && link.text.split(/\s+/).length <= 2) continue;
        const topic = extractTopicFromRowText(rowText, link.text);
        entries.push({
          title: link.text,
          url: link.href,
          contentType: classifyContentType(link.href, link.text),
          source,
          lectureNumber: extractLectureNumber(rowText) ?? extractLectureNumber(link.text),
          topic,
        });
      }
    }
    TABLE_ROW_REGEX.lastIndex = 0;
    if (entries.length > 0) return entries;
  }

  const links = parseHtmlLinks(html);
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

const CANVAS_PAGE_URL_RE = /\/courses\/\d+\/pages\//i;

function extractLecturesFromHtml(
  html: string,
  source: string,
  skipCanvasPages: boolean = false
): LectureIndexEntry[] {
  const links = parseHtmlLinks(html);
  const entries: LectureIndexEntry[] = [];
  for (const link of links) {
    if (!isLectureLikeTitle(link.text) && extractLectureNumber(link.text) === null) {
      continue;
    }
    if (skipCanvasPages && CANVAS_PAGE_URL_RE.test(link.href)) continue;
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
  // Also: if the module name itself is lecture-like, include all slide/video
  // files from it (e.g. "LEC01 & LEC02 - Prof. X" containing "Module1.pdf")
  for (const mod of modules) {
    const moduleIsLecture = isLectureLikeTitle(mod.name);
    for (const item of mod.items) {
      const itemIsLecture = isLectureLikeTitle(item.title) || extractLectureNumber(item.title) !== null;
      if (!itemIsLecture && !moduleIsLecture) continue;

      const url = item.externalUrl ?? item.htmlUrl ?? null;
      if (!url) continue;

      const contentType = classifyContentType(url, item.title);
      if (!itemIsLecture && contentType !== "slides" && contentType !== "video") continue;

      push({
        title: decodeEntities(item.title),
        url,
        contentType,
        source: `module: ${mod.name}`,
        lectureNumber: extractLectureNumber(item.title) ?? extractLectureNumber(mod.name),
      });
    }
  }

  // 2. Front page links — skip links to Canvas pages since those are fetched
  //    and scraped in step 4 (avoids listing empty hub pages as lectures)
  if (frontPageBody) {
    for (const entry of extractLecturesFromHtml(frontPageBody, "front page", true)) {
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

  // 5. Pages themselves that have lecture-like titles — only if their body
  //    wasn't already fetched and scraped in step 4 (otherwise we already
  //    have the individual lectures from within them)
  const fetchedSlugs = new Set(fetchedPages.map(p => p.slug));
  for (const page of pages) {
    if (!isLectureLikeTitle(page.title)) continue;
    if (!page.htmlUrl) continue;
    if (page.pageId && fetchedSlugs.has(page.pageId)) continue;
    push({
      title: decodeEntities(page.title),
      url: page.htmlUrl,
      contentType: "page",
      source: "page index",
      lectureNumber: extractLectureNumber(page.title),
    });
  }

  const topicByLectureNum = new Map<number, string>();
  for (const entry of entries) {
    if (entry.topic && entry.lectureNumber !== null && !topicByLectureNum.has(entry.lectureNumber)) {
      topicByLectureNum.set(entry.lectureNumber, entry.topic);
    }
  }
  for (const entry of entries) {
    if (!entry.topic && entry.lectureNumber !== null) {
      entry.topic = topicByLectureNum.get(entry.lectureNumber);
    }
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
