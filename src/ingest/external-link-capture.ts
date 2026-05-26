import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Config } from "../config/env.js";
import type { CanvasCalendarEvent, CanvasQuiz } from "../canvas/types.js";
import { extractFileBufferText } from "../extract/extract-text.js";
import { decodeEntities, htmlToText } from "../format/html-to-text.js";
import { mapWithConcurrency } from "./concurrency.js";
import type { RawAssignmentRecord, RawDiscussionThread } from "./fetch-course-content.js";
import type {
  ExternalLinkContentStatus,
  ExternalLinkIndexEntry,
  ModuleIndexEntry,
} from "./types.js";

const require = createRequire(import.meta.url);
const pdfParse: (buffer: Buffer) => Promise<{ text: string }> = require("pdf-parse");

const EXTERNAL_LINK_CAPTURE_CONCURRENCY = 4;
const MAX_REDIRECTS = 6;
const MAX_CAPTURED_TEXT = 30000;

interface ExternalLinkCandidate {
  url: string;
  title: string;
  source: string;
}

interface AggregatedExternalLinkCandidate {
  url: string;
  title: string;
  sources: string[];
}

interface ExternalLinkFetchResult {
  status: ExternalLinkContentStatus;
  resolvedUrl: string | null;
  contentType: string | null;
  pageTitle: string | null;
  text: string;
  note: string | null;
}

interface GoogleWorkspaceExportRequest {
  url: string;
  filename: string;
  label: string;
  kind: "text" | "binary";
}

export interface CapturedExternalLink {
  entry: ExternalLinkIndexEntry;
  text: string;
}

export async function captureExternalCourseLinks(options: {
  courseId: number;
  courseHtmlUrl: string | null;
  modules: ModuleIndexEntry[];
  assignments: RawAssignmentRecord[];
  quizzes: CanvasQuiz[];
  calendarEvents: CanvasCalendarEvent[];
  frontPageBody: string | null;
  fetchedPages: Array<{ slug: string; title: string; body: string }>;
  syllabusBody: string | null;
  announcementThreads: RawDiscussionThread[];
  discussionThreads: RawDiscussionThread[];
  config: Config;
}): Promise<CapturedExternalLink[]> {
  const canvasOrigin = getOrigin(options.config.baseUrl);
  const aggregated = new Map<string, AggregatedExternalLinkCandidate>();

  const addCandidate = (candidate: ExternalLinkCandidate): void => {
    const normalizedUrl = normalizeExternalUrl(candidate.url);
    if (!normalizedUrl) return;

    const existing = aggregated.get(normalizedUrl);
    if (existing) {
      existing.title = pickBetterTitle(existing.title, candidate.title);
      if (!existing.sources.includes(candidate.source)) {
        existing.sources.push(candidate.source);
      }
      return;
    }

    aggregated.set(normalizedUrl, {
      url: normalizedUrl,
      title: candidate.title.trim(),
      sources: [candidate.source],
    });
  };

  for (const module of options.modules) {
    for (const item of module.items) {
      if (item.type !== "ExternalUrl" && item.type !== "ExternalTool") {
        continue;
      }

      const url = item.externalUrl ?? item.htmlUrl;
      if (
        !url ||
        !isCapturableExternalUrl(url, {
          courseId: options.courseId,
          canvasOrigin,
        })
      ) {
        continue;
      }

      addCandidate({
        url,
        title: item.title,
        source: `module "${module.name}" item "${item.title}"`,
      });
    }
  }

  const addHtmlCandidates = (
    html: string | null | undefined,
    source: string,
    baseUrl: string | null
  ): void => {
    if (!html) return;
    for (const link of extractExternalLinksFromHtml(html, {
      baseUrl,
      courseId: options.courseId,
      canvasOrigin,
    })) {
      addCandidate({
        url: link.url,
        title: link.title,
        source,
      });
    }
  };

  for (const assignment of options.assignments) {
    const description = assignment.description;
    if (typeof description !== "string" || description.trim().length === 0) {
      continue;
    }
    addHtmlCandidates(
      description,
      `assignment "${assignment.name}" description`,
      assignment.html_url
    );
  }

  for (const quiz of options.quizzes) {
    const description = quiz.description;
    if (typeof description !== "string" || description.trim().length === 0) {
      continue;
    }
    addHtmlCandidates(
      description,
      `quiz "${quiz.title}" description`,
      quiz.html_url ?? options.courseHtmlUrl
    );
  }

  for (const event of options.calendarEvents) {
    const description = event.description;
    if (typeof description !== "string" || description.trim().length === 0) {
      continue;
    }
    addHtmlCandidates(
      description,
      `calendar event "${event.title}" description`,
      event.html_url ?? options.courseHtmlUrl
    );
  }

  addHtmlCandidates(options.frontPageBody, "front page", options.courseHtmlUrl);
  addHtmlCandidates(options.syllabusBody, "syllabus", options.courseHtmlUrl);

  for (const page of options.fetchedPages) {
    const baseUrl = options.courseHtmlUrl
      ? `${options.courseHtmlUrl.replace(/\/$/, "")}/pages/${encodeURIComponent(page.slug)}`
      : null;
    addHtmlCandidates(page.body, `page "${page.title}"`, baseUrl);
  }

  for (const thread of options.announcementThreads) {
    addHtmlCandidates(
      thread.topic.message,
      `announcement "${thread.topic.title}"`,
      thread.topic.html_url
    );
    for (const entry of thread.entries) {
      const author = entry.user_name ?? `User ${entry.user_id}`;
      addHtmlCandidates(
        entry.message,
        `announcement reply in "${thread.topic.title}" by ${author}`,
        thread.topic.html_url
      );
    }
  }

  for (const thread of options.discussionThreads) {
    addHtmlCandidates(
      thread.topic.message,
      `discussion "${thread.topic.title}"`,
      thread.topic.html_url
    );
    for (const entry of thread.entries) {
      const author = entry.user_name ?? `User ${entry.user_id}`;
      addHtmlCandidates(
        entry.message,
        `discussion reply in "${thread.topic.title}" by ${author}`,
        thread.topic.html_url
      );
    }
  }

  const candidates = Array.from(aggregated.values());
  if (candidates.length === 0) {
    return [];
  }

  const fetchedResults = await mapWithConcurrency(
    candidates,
    EXTERNAL_LINK_CAPTURE_CONCURRENCY,
    async (candidate) => {
      return {
        candidate,
        fetched: await fetchExternalLink(candidate.url, options.config),
      };
    }
  );

  const deduped = new Map<
    string,
    {
      candidate: AggregatedExternalLinkCandidate;
      fetched: ExternalLinkFetchResult;
    }
  >();

  for (const result of fetchedResults) {
    const key =
      normalizeExternalUrl(result.fetched.resolvedUrl ?? result.candidate.url) ??
      result.candidate.url;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, {
        candidate: {
          url: result.candidate.url,
          title: result.candidate.title,
          sources: [...result.candidate.sources],
        },
        fetched: result.fetched,
      });
      continue;
    }

    existing.candidate.title = pickBetterTitle(
      existing.candidate.title,
      result.candidate.title
    );
    existing.candidate.sources = Array.from(
      new Set([...existing.candidate.sources, ...result.candidate.sources])
    );
    existing.candidate.url = pickPreferredSourceUrl(
      existing.candidate.url,
      result.candidate.url,
      key
    );
    if (isBetterFetchedResult(result.fetched, existing.fetched)) {
      existing.fetched = result.fetched;
    }
  }

  return Array.from(deduped.entries(), ([key, result]) => {
    const title =
      pickBetterTitle(result.candidate.title, result.fetched.pageTitle) ||
      result.fetched.pageTitle ||
      result.candidate.title ||
      key;
    const entry: ExternalLinkIndexEntry = {
      id: hashExternalLinkId(key),
      title,
      url: result.candidate.url,
      resolvedUrl: result.fetched.resolvedUrl,
      sourceCount: result.candidate.sources.length,
      sources: result.candidate.sources,
      contentType: result.fetched.contentType,
      contentStatus: result.fetched.status,
    };

    return {
      entry,
      text: formatExternalLinkText(entry, result.fetched),
    };
  });
}

async function fetchExternalLink(
  url: string,
  config: Config
): Promise<ExternalLinkFetchResult> {
  let response: Response;
  let finalUrl: string;

  try {
    ({ response, finalUrl } = await fetchWithControlledRedirects(url, config));
  } catch (error) {
    return {
      status: "failed",
      resolvedUrl: null,
      contentType: null,
      pageTitle: null,
      text: "",
      note: `Request failed: ${error instanceof Error ? error.message : "unknown error"}.`,
    };
  }

  const contentType = response.headers.get("content-type");

  if (!response.ok) {
    return {
      status: "failed",
      resolvedUrl: finalUrl,
      contentType,
      pageTitle: null,
      text: "",
      note: `Request returned ${response.status} ${response.statusText}.`,
    };
  }

  const googleWorkspaceExport = await fetchGoogleWorkspaceExport(finalUrl);
  if (googleWorkspaceExport) {
    return {
      status: googleWorkspaceExport.text.length > 0 ? "captured" : "metadata_only",
      resolvedUrl: finalUrl,
      contentType: googleWorkspaceExport.contentType ?? contentType,
      pageTitle: googleWorkspaceExport.pageTitle,
      text: googleWorkspaceExport.text,
      note: googleWorkspaceExport.note,
    };
  }

  if (looksLikePdf(contentType, finalUrl)) {
    try {
      const buffer = Buffer.from(await response.arrayBuffer());
      const extracted = (await pdfParse(buffer)).text.trim().slice(0, MAX_CAPTURED_TEXT);
      return {
        status: extracted.length > 0 ? "captured" : "metadata_only",
        resolvedUrl: finalUrl,
        contentType,
        pageTitle: null,
        text: extracted,
        note:
          extracted.length > 0
            ? null
            : "The PDF was reachable, but no readable text could be extracted.",
      };
    } catch (error) {
      return {
        status: "metadata_only",
        resolvedUrl: finalUrl,
        contentType,
        pageTitle: null,
        text: "",
        note: `The PDF was reachable, but text extraction failed: ${
          error instanceof Error ? error.message : "unknown error"
        }.`,
      };
    }
  }

  if (looksLikeOfficeDocument(contentType, finalUrl)) {
    try {
      const buffer = Buffer.from(await response.arrayBuffer());
      const filename =
        guessFilenameFromUrl(finalUrl) ?? guessOfficeFilename(contentType);
      const extracted = (await extractFileBufferText(buffer, filename))
        .trim()
        .slice(0, MAX_CAPTURED_TEXT);
      const isUsable =
        extracted.length > 0 && !extracted.startsWith("[Binary file:") && !extracted.startsWith("[Error");
      return {
        status: isUsable ? "captured" : "metadata_only",
        resolvedUrl: finalUrl,
        contentType,
        pageTitle: null,
        text: isUsable ? extracted : "",
        note: isUsable
          ? null
          : "The Office document was reachable, but no readable text could be extracted.",
      };
    } catch (error) {
      return {
        status: "metadata_only",
        resolvedUrl: finalUrl,
        contentType,
        pageTitle: null,
        text: "",
        note: `The Office document was reachable, but text extraction failed: ${
          error instanceof Error ? error.message : "unknown error"
        }.`,
      };
    }
  }

  if (looksLikeHtml(contentType, finalUrl)) {
    const html = (await response.text()).slice(0, MAX_CAPTURED_TEXT * 2);
    const pageTitle = extractHtmlTitle(html);
    const pageDescription = extractMetaDescription(html);
    const htmlForText = extractHtmlBody(html) ?? html;
    let text = htmlToText(htmlForText, { baseUrl: finalUrl }).slice(0, MAX_CAPTURED_TEXT);
    if (text.length === 0 && pageDescription) {
      text = pageDescription.slice(0, MAX_CAPTURED_TEXT);
    }
    return {
      status: text.length > 0 ? "captured" : "metadata_only",
      resolvedUrl: finalUrl,
      contentType,
      pageTitle,
      text,
      note:
        text.length > 0
          ? null
          : "The page was reachable, but no readable text content was found.",
    };
  }

  if (looksLikePlainText(contentType, finalUrl)) {
    const text = (await response.text()).trim().slice(0, MAX_CAPTURED_TEXT);
    return {
      status: text.length > 0 ? "captured" : "metadata_only",
      resolvedUrl: finalUrl,
      contentType,
      pageTitle: null,
      text,
      note:
        text.length > 0
          ? null
          : "The resource was reachable, but it did not include readable text.",
    };
  }

  return {
    status: "metadata_only",
    resolvedUrl: finalUrl,
    contentType,
    pageTitle: null,
    text: "",
    note:
      contentType && contentType.trim().length > 0
        ? `The resource was reachable, but its content type (${contentType}) is not extracted yet.`
        : "The resource was reachable, but its content type could not be determined.",
  };
}

async function fetchGoogleWorkspaceExport(
  url: string
): Promise<{
  contentType: string | null;
  pageTitle: string | null;
  text: string;
  note: string | null;
} | null> {
  const exportRequest = buildGoogleWorkspaceExportRequest(url);
  if (!exportRequest) {
    return null;
  }

  try {
    const response = await fetch(exportRequest.url, {
      redirect: "follow",
    });
    if (!response.ok) {
      return null;
    }

    const text =
      exportRequest.kind === "text"
        ? (await response.text()).trim().slice(0, MAX_CAPTURED_TEXT)
        : (
            await extractFileBufferText(
              Buffer.from(await response.arrayBuffer()),
              exportRequest.filename
            )
          )
            .trim()
            .slice(0, MAX_CAPTURED_TEXT);
    return {
      contentType: response.headers.get("content-type"),
      pageTitle: null,
      text,
      note:
        text.length > 0
          ? null
          : `The ${exportRequest.label} export was reachable, but it did not include readable text.`,
    };
  } catch {
    return null;
  }
}

function buildGoogleWorkspaceExportRequest(
  url: string
): GoogleWorkspaceExportRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.hostname !== "docs.google.com") {
    return null;
  }

  const documentMatch = parsed.pathname.match(
    /^\/document\/(?:u\/\d+\/)?d\/([^/]+)(?:\/|$)/i
  );
  if (documentMatch?.[1]) {
    return {
      url: `https://docs.google.com/document/d/${documentMatch[1]}/export?format=txt`,
      filename: "google-doc.txt",
      label: "Google Doc",
      kind: "text",
    };
  }

  const presentationMatch = parsed.pathname.match(
    /^\/presentation\/(?:u\/\d+\/)?d\/([^/]+)(?:\/|$)/i
  );
  if (presentationMatch?.[1]) {
    return {
      url: `https://docs.google.com/presentation/d/${presentationMatch[1]}/export/pptx`,
      filename: "google-slides.pptx",
      label: "Google Slides",
      kind: "binary",
    };
  }

  const spreadsheetMatch = parsed.pathname.match(
    /^\/spreadsheets\/(?:u\/\d+\/)?d\/([^/]+)(?:\/|$)/i
  );
  if (spreadsheetMatch?.[1]) {
    return {
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetMatch[1]}/export?format=csv`,
      filename: "google-sheet.csv",
      label: "Google Sheet",
      kind: "text",
    };
  }

  return null;
}

async function fetchWithControlledRedirects(
  url: string,
  config: Config
): Promise<{ response: Response; finalUrl: string }> {
  const canvasOrigin = getOrigin(config.baseUrl);
  let currentUrl = url;

  for (let attempt = 0; attempt < MAX_REDIRECTS; attempt += 1) {
    const headers = shouldSendCanvasAuth(currentUrl, canvasOrigin)
      ? { Authorization: `Bearer ${config.accessToken}` }
      : undefined;
    const response = await fetch(currentUrl, {
      headers,
      redirect: "manual",
    });
    const redirectLocation = response.headers.get("location");

    if (
      redirectLocation &&
      response.status >= 300 &&
      response.status < 400
    ) {
      currentUrl = new URL(redirectLocation, currentUrl).toString();
      continue;
    }

    return { response, finalUrl: currentUrl };
  }

  throw new Error("too many redirects");
}

function extractExternalLinksFromHtml(
  html: string,
  options: {
    baseUrl: string | null;
    courseId: number;
    canvasOrigin: string | null;
  }
): Array<{ title: string; url: string }> {
  const results: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  const anchorRegex = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorRegex.exec(html)) !== null) {
    const tag = match[0];
    const href = extractAttr(tag, "href");
    if (!href) continue;

    const resolvedUrl = resolveHref(href, options.baseUrl);
    if (
      !resolvedUrl ||
      !isCapturableExternalUrl(resolvedUrl, {
        courseId: options.courseId,
        canvasOrigin: options.canvasOrigin,
      })
    ) {
      continue;
    }

    const normalizedUrl = normalizeExternalUrl(resolvedUrl);
    if (!normalizedUrl || seen.has(normalizedUrl)) {
      continue;
    }
    seen.add(normalizedUrl);

    results.push({
      title: normalizeLinkTitle(match[1], normalizedUrl),
      url: normalizedUrl,
    });
  }

  const iframeRegex = /<iframe\b[^>]*>/gi;
  let iframeMatch: RegExpExecArray | null;

  while ((iframeMatch = iframeRegex.exec(html)) !== null) {
    const tag = iframeMatch[0];
    const src = extractAttr(tag, "src");
    if (!src) continue;

    const resolvedUrl = resolveHref(src, options.baseUrl);
    if (
      !resolvedUrl ||
      !isCapturableExternalUrl(resolvedUrl, {
        courseId: options.courseId,
        canvasOrigin: options.canvasOrigin,
      })
    ) {
      continue;
    }

    const normalizedUrl = normalizeExternalUrl(resolvedUrl);
    if (!normalizedUrl || seen.has(normalizedUrl)) {
      continue;
    }
    seen.add(normalizedUrl);

    const title = extractAttr(tag, "title") ?? normalizedUrl;
    results.push({
      title: decodeEntities(title),
      url: normalizedUrl,
    });
  }

  return results;
}

function isCapturableExternalUrl(
  url: string,
  options: { courseId: number; canvasOrigin: string | null }
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  const path = parsed.pathname;
  if (options.canvasOrigin && parsed.origin === options.canvasOrigin) {
    if (path.startsWith("/api/")) {
      return false;
    }
    if (new RegExp(`^/courses/${options.courseId}(?:/|$)`).test(path)) {
      if (
        /^\/courses\/\d+\/(?:pages|files|discussion_topics|assignments|quizzes|modules|front_page)\b/.test(
          path
        ) ||
        /^\/courses\/\d+$/.test(path)
      ) {
        return false;
      }
    }
  }

  return true;
}

function formatExternalLinkText(
  entry: ExternalLinkIndexEntry,
  fetched: ExternalLinkFetchResult
): string {
  const lines = [`# ${entry.title}`, ""];

  lines.push(`Source URL: ${entry.url}`);
  if (entry.resolvedUrl && entry.resolvedUrl !== entry.url) {
    lines.push(`Resolved URL: ${entry.resolvedUrl}`);
  }
  if (fetched.pageTitle && fetched.pageTitle !== entry.title) {
    lines.push(`Page title: ${fetched.pageTitle}`);
  }
  if (entry.contentType) {
    lines.push(`Content type: ${entry.contentType}`);
  }
  lines.push(`Capture status: ${entry.contentStatus}`);
  lines.push("");
  lines.push("Linked from:");
  for (const source of entry.sources) {
    lines.push(`- ${source}`);
  }
  lines.push("");

  if (fetched.text.trim().length > 0) {
    lines.push("## Captured content");
    lines.push("");
    lines.push(fetched.text.trim());
  } else {
    lines.push("## Notes");
    lines.push("");
    lines.push(
      fetched.note ?? "No readable content was captured, but the destination URL was preserved."
    );
  }

  return lines.join("\n").trimEnd() + "\n";
}

function hashExternalLinkId(url: string): string {
  return createHash("sha1").update(url).digest("hex").slice(0, 12);
}

function isBetterFetchedResult(
  incoming: ExternalLinkFetchResult,
  current: ExternalLinkFetchResult
): boolean {
  const rank = (status: ExternalLinkContentStatus): number => {
    switch (status) {
      case "captured":
        return 3;
      case "metadata_only":
        return 2;
      case "failed":
      default:
        return 1;
    }
  };

  const incomingRank = rank(incoming.status);
  const currentRank = rank(current.status);
  if (incomingRank !== currentRank) {
    return incomingRank > currentRank;
  }
  if (incoming.text.length !== current.text.length) {
    return incoming.text.length > current.text.length;
  }
  return (incoming.pageTitle?.length ?? 0) > (current.pageTitle?.length ?? 0);
}

function pickPreferredSourceUrl(
  current: string,
  incoming: string,
  canonicalUrl: string
): string {
  if (current === canonicalUrl) return current;
  if (incoming === canonicalUrl) return incoming;
  if (isCanvasLaunchUrl(current) && !isCanvasLaunchUrl(incoming)) {
    return incoming;
  }
  if (!isCanvasLaunchUrl(current) && isCanvasLaunchUrl(incoming)) {
    return current;
  }
  return current.length <= incoming.length ? current : incoming;
}

function isCanvasLaunchUrl(url: string): boolean {
  return /\/external_tools\//.test(url);
}

function pickBetterTitle(current: string | null, incoming: string | null): string {
  const currentText = current?.trim() ?? "";
  const incomingText = incoming?.trim() ?? "";

  if (incomingText.length === 0) {
    return currentText;
  }
  if (currentText.length === 0) {
    return incomingText;
  }
  if (isGenericTitle(currentText) && !isGenericTitle(incomingText)) {
    return incomingText;
  }
  if (!isGenericTitle(currentText) && isGenericTitle(incomingText)) {
    return currentText;
  }
  return incomingText.length > currentText.length ? incomingText : currentText;
}

function isGenericTitle(value: string): boolean {
  return /^(here|link|open|launch|view|website|url|resource)$/i.test(
    value.trim()
  );
}

function normalizeExternalUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeLinkTitle(rawHtml: string, fallbackUrl: string): string {
  const text = decodeEntities(stripTags(rawHtml)).replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : fallbackUrl;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

function extractAttr(tag: string, attr: string): string | null {
  const regex = new RegExp(
    `${attr}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')`,
    "i"
  );
  const match = tag.match(regex);
  return decodeEntities(match?.[1] ?? match?.[2] ?? "").trim() || null;
}

function resolveHref(href: string, baseUrl: string | null): string | null {
  if (
    href.startsWith("#") ||
    href.startsWith("mailto:") ||
    href.startsWith("tel:") ||
    href.startsWith("javascript:")
  ) {
    return null;
  }

  try {
    return new URL(decodeEntities(href), baseUrl ?? undefined).toString();
  } catch {
    return null;
  }
}

function getOrigin(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function shouldSendCanvasAuth(url: string, canvasOrigin: string | null): boolean {
  if (!canvasOrigin) return false;
  try {
    return new URL(url).origin === canvasOrigin;
  } catch {
    return false;
  }
}

function looksLikePdf(contentType: string | null, url: string): boolean {
  return (
    (contentType?.toLowerCase().includes("application/pdf") ?? false) ||
    /\.pdf(?:$|[?#])/i.test(url)
  );
}

function looksLikeHtml(contentType: string | null, url: string): boolean {
  if (!contentType) {
    return !/\.(pdf|zip|png|jpe?g|gif|webp|pptx?|docx?|xlsx?)(?:$|[?#])/i.test(
      url
    );
  }

  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("text/html") ||
    normalized.includes("application/xhtml") ||
    normalized.includes("application/xml")
  );
}

function looksLikeOfficeDocument(contentType: string | null, url: string): boolean {
  if (/\.(?:docx|pptx|xlsx)(?:$|[?#])/i.test(url)) {
    return true;
  }
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("application/vnd.openxmlformats-officedocument") ||
    normalized.includes("application/vnd.ms-powerpoint") ||
    normalized.includes("application/vnd.ms-excel") ||
    normalized.includes("application/msword")
  );
}

function guessFilenameFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split("/").pop() ?? "";
    const decoded = decodeURIComponent(lastSegment);
    if (/\.(docx|pptx|xlsx)$/i.test(decoded)) {
      return decoded;
    }
  } catch {
    // fall through
  }
  return null;
}

function guessOfficeFilename(contentType: string | null): string {
  if (!contentType) return "document.docx";
  const ct = contentType.toLowerCase();
  if (ct.includes("presentation") || ct.includes("powerpoint")) return "document.pptx";
  if (ct.includes("spreadsheet") || ct.includes("excel")) return "document.xlsx";
  return "document.docx";
}

function looksLikePlainText(contentType: string | null, url: string): boolean {
  if (!contentType) {
    return /\.(txt|md|csv|json|xml)(?:$|[?#])/i.test(url);
  }

  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("application/json") ||
    normalized.includes("application/xml")
  );
}

function extractHtmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const title = decodeEntities(stripTags(match[1])).replace(/\s+/g, " ").trim();
  return title.length > 0 ? title : null;
}

function extractHtmlBody(html: string): string | null {
  const match = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return match?.[1] ?? null;
}

function extractMetaDescription(html: string): string | null {
  const match = html.match(
    /<meta[^>]+name=(?:"description"|'description')[^>]+content=(?:"([^"]*)"|'([^']*)')[^>]*>/i
  );
  const content = decodeEntities(match?.[1] ?? match?.[2] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return content.length > 0 ? content : null;
}
