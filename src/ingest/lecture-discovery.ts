import type {
  ModuleIndexEntry,
  PageIndexEntry,
  LectureIndexEntry,
  FileIndexEntry,
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

/** Hosts and paths that mean "this embed is a recording/media object". */
const MEDIA_URL_PATTERNS =
  /youtu\.?be|vimeo\.com|panopto|kaltura|echo360|mediasite|zoom\.(?:us|com)\/rec|loom\.com|drive\.google\.com|docs\.google\.com\/presentation|\/media_objects(?:_iframe)?\/|\/media_attachments_iframe\/|instructuremedia\.com|canvasstudio|\.(?:mp4|webm|m4v|mov|mp3|m4a)(?:[?#]|$)/i;

const MEDIA_HOST_LABELS: Array<[RegExp, string]> = [
  [/youtu\.?be/i, "YouTube"],
  [/vimeo/i, "Vimeo"],
  [/panopto/i, "Panopto"],
  [/kaltura/i, "Kaltura"],
  [/echo360/i, "Echo360"],
  [/mediasite/i, "Mediasite"],
  [/zoom\./i, "Zoom recording"],
  [/loom\.com/i, "Loom"],
  [/docs\.google\.com\/presentation/i, "Google Slides"],
  [/drive\.google\.com/i, "Google Drive"],
  [/media_objects|media_attachments|instructuremedia|canvasstudio/i, "Canvas media"],
];

function mediaHostLabel(url: string): string {
  for (const [pattern, label] of MEDIA_HOST_LABELS) {
    if (pattern.test(url)) return label;
  }
  try {
    return new URL(url, "https://canvas.invalid").hostname.replace(/^www\./, "") || "embedded media";
  } catch {
    return "embedded media";
  }
}

function readAttr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i")) ??
    tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i"));
  return match?.[1] ? decodeEntities(match[1]).trim() : null;
}

function normalizeEmbedUrl(src: string): string | null {
  const trimmed = src.trim();
  if (!trimmed || /^(javascript|data|about):/i.test(trimmed)) return null;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return trimmed;
}

/**
 * Embedded recordings and media players. Pages, announcements and
 * assignments routinely hold the lecture video as an <iframe> (YouTube,
 * Panopto, Kaltura, Canvas Studio) or a <video>/<audio> element rather than a
 * link, so without this "where is the lecture 5 recording?" has nothing to
 * find. Exported for tests.
 */
export function extractEmbeddedMedia(
  html: string,
  source: string,
  contextTitle: string
): LectureIndexEntry[] {
  const entries: LectureIndexEntry[] = [];
  const seen = new Set<string>();
  const contextNumber = extractLectureNumber(contextTitle);

  const push = (url: string | null, title: string | null, forceMedia: boolean): void => {
    const normalized = url ? normalizeEmbedUrl(url) : null;
    if (!normalized) return;
    // "embed"/"player" alone is not enough (Google Calendar embeds, maps); it
    // must sit on a media host or next to a media-ish word.
    const looksLikeMedia =
      MEDIA_URL_PATTERNS.test(normalized) ||
      (/embed|player/i.test(normalized) && /video|media|watch|rec(ording)?|lecture|stream/i.test(normalized));
    if (!forceMedia && !looksLikeMedia) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    const host = mediaHostLabel(normalized);
    const cleanTitle = title && title.length >= 3 ? title : null;
    const finalTitle = cleanTitle ?? `${contextTitle} — ${host} recording`;
    entries.push({
      title: finalTitle,
      url: normalized,
      contentType: "video",
      source,
      lectureNumber: extractLectureNumber(finalTitle) ?? contextNumber,
      topic: cleanTitle ? undefined : contextTitle,
    });
  };

  const iframePattern = /<iframe\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = iframePattern.exec(html)) !== null) {
    const tag = match[0];
    push(readAttr(tag, "src") ?? readAttr(tag, "data-src"), readAttr(tag, "title") ?? readAttr(tag, "aria-label"), false);
  }

  const mediaElementPattern = /<(video|audio)\b([^>]*)>([\s\S]*?)<\/\1>|<(video|audio)\b([^>]*)\/?>/gi;
  while ((match = mediaElementPattern.exec(html)) !== null) {
    const attrs = match[2] ?? match[5] ?? "";
    const inner = match[3] ?? "";
    const tag = `<${match[1] ?? match[4]} ${attrs}>`;
    const title = readAttr(tag, "title") ?? readAttr(tag, "aria-label") ?? readAttr(tag, "data-title");
    const direct = readAttr(tag, "src");
    if (direct) push(direct, title, true);
    const sourcePattern = /<source\b[^>]*>/gi;
    let sourceMatch: RegExpExecArray | null;
    while ((sourceMatch = sourcePattern.exec(inner)) !== null) {
      push(readAttr(sourceMatch[0], "src"), title, true);
    }
  }

  const embedPattern = /<embed\b[^>]*>/gi;
  while ((match = embedPattern.exec(html)) !== null) {
    push(readAttr(match[0], "src"), readAttr(match[0], "title"), false);
  }

  // Canvas media anchors (Studio / media comments) look like plain links.
  const mediaAnchorPattern = /<a\b[^>]*class="[^"]*instructure_(?:video|audio)_link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = mediaAnchorPattern.exec(html)) !== null) {
    const tag = match[0].slice(0, match[0].indexOf(">") + 1);
    const text = decodeEntities(match[1]!.replace(/<[^>]*>/g, "").trim());
    push(readAttr(tag, "href"), text || readAttr(tag, "title"), true);
  }

  return entries;
}

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
  syllabusBody: string | null,
  files: FileIndexEntry[] = [],
  /** Other HTML bodies worth scanning for embedded recordings (announcements, assignments, discussions). */
  extraHtml: Array<{ title: string; body: string; source: string }> = []
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

  // 1b. Embedded recordings/media players anywhere we hold HTML. Done before
  //     the link scans so an iframe's own title wins over a nearby link.
  if (frontPageBody) {
    for (const entry of extractEmbeddedMedia(frontPageBody, "front page", "Front page")) push(entry);
  }
  if (syllabusBody) {
    for (const entry of extractEmbeddedMedia(syllabusBody, "syllabus", "Syllabus")) push(entry);
  }
  for (const page of fetchedPages) {
    for (const entry of extractEmbeddedMedia(page.body, `page: ${page.title}`, page.title)) push(entry);
  }
  for (const extra of extraHtml) {
    if (!extra.body) continue;
    for (const entry of extractEmbeddedMedia(extra.body, extra.source, extra.title)) push(entry);
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

  // 6. Files-tab documents: lecture-like filenames anywhere, plus every
  //    slide/video file inside a lecture-like folder (e.g. "Lectures/Week 3").
  for (const file of files) {
    const folderPath = file.folderPath ?? "";
    const folderIsLecture =
      folderPath.length > 0 &&
      folderPath.split("/").some((segment) => isLectureLikeTitle(segment));
    const name = file.displayName || file.filename;
    const fileIsLecture = isLectureLikeTitle(name) || extractLectureNumber(name) !== null;
    if (!fileIsLecture && !folderIsLecture) continue;
    if (!file.url) continue;

    const contentType = classifyContentType(file.url, name);
    if (!fileIsLecture && contentType !== "slides" && contentType !== "video") continue;

    push({
      title: decodeEntities(name),
      url: file.url,
      contentType,
      source: folderPath.length > 0 ? `files: ${folderPath}` : "files",
      lectureNumber: extractLectureNumber(name) ?? extractLectureNumber(folderPath),
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
