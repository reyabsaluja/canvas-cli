import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  DownloadTooLargeError,
  readBodyWithLimit,
  withTimeoutSignal,
} from "../canvas/safe-download.js";
import type { CanvasTab } from "../canvas/types.js";
import type { Config } from "../config/env.js";
import { extractOfficeText } from "../extract/office-text.js";
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
const EXTERNAL_FETCH_TIMEOUT_MS = 30_000;
/**
 * Largest response body read from an external link. Only the first 30k
 * characters are ever kept, so this is purely a guard against a link that
 * resolves to a multi-gigabyte download (a lecture recording, a dataset)
 * being buffered in memory while text extraction is attempted.
 */
const MAX_EXTERNAL_BODY_BYTES = 100 * 1024 * 1024;

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

export interface CapturedExternalLink {
  entry: ExternalLinkIndexEntry;
  text: string;
}

export async function captureExternalCourseLinks(options: {
  courseId: number;
  courseHtmlUrl: string | null;
  modules: ModuleIndexEntry[];
  assignments: RawAssignmentRecord[];
  frontPageBody: string | null;
  fetchedPages: Array<{ slug: string; title: string; body: string }>;
  syllabusBody: string | null;
  announcements: Array<{
    title: string;
    message: string | null;
    html_url?: string | null;
  }>;
  discussionThreads: RawDiscussionThread[];
  /** Course navigation tabs; visible external-tool tabs are captured by their launch URL. */
  tabs?: CanvasTab[] | null;
  config: Config;
  /** Ctrl-C during ingestion: stops new fetches and aborts in-flight ones. */
  signal?: AbortSignal | null;
}): Promise<CapturedExternalLink[]> {
  const canvasOrigin = getOrigin(options.config.baseUrl);
  const signal = options.signal ?? null;
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

  // Course navigation tabs for external tools (Piazza, Ed, Zoom, ...). Their
  // launch URL always lives on the Canvas origin; anything else is not a tab
  // launch URL and is left alone.
  for (const tab of options.tabs ?? []) {
    if (tab.type !== "external" || tab.hidden) continue;
    for (const rawUrl of [tab.full_url, tab.html_url]) {
      const url = resolveHref(rawUrl ?? "", options.config.baseUrl);
      if (
        !url ||
        !canvasOrigin ||
        getOrigin(url) !== canvasOrigin ||
        !isCapturableExternalUrl(url, { courseId: options.courseId, canvasOrigin })
      ) {
        continue;
      }
      addCandidate({
        url,
        title: tab.label,
        source: `course navigation tab "${tab.label}"`,
      });
      break;
    }
  }

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

  addHtmlCandidates(options.frontPageBody, "front page", options.courseHtmlUrl);
  addHtmlCandidates(options.syllabusBody, "syllabus", options.courseHtmlUrl);

  for (const page of options.fetchedPages) {
    const baseUrl = options.courseHtmlUrl
      ? `${options.courseHtmlUrl.replace(/\/$/, "")}/pages/${encodeURIComponent(page.slug)}`
      : null;
    addHtmlCandidates(page.body, `page "${page.title}"`, baseUrl);
  }

  for (const announcement of options.announcements) {
    addHtmlCandidates(
      announcement.message,
      `announcement "${announcement.title}"`,
      announcement.html_url ?? options.courseHtmlUrl
    );
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
        fetched: await fetchExternalLink(candidate.url, options.config, signal),
      };
    },
    signal
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
  config: Config,
  signal: AbortSignal | null
): Promise<ExternalLinkFetchResult> {
  let response: Response;
  let finalUrl: string;

  try {
    ({ response, finalUrl } = await fetchWithControlledRedirects(url, config, signal));
  } catch (error) {
    if (signal?.aborted) throw error;
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

  const googleDocExport = await fetchGoogleWorkspaceExport(finalUrl, signal);
  if (googleDocExport) {
    await response.body?.cancel().catch(() => {});
    return {
      status: googleDocExport.text.length > 0 ? "captured" : "metadata_only",
      resolvedUrl: finalUrl,
      contentType: googleDocExport.contentType ?? contentType,
      pageTitle: googleDocExport.pageTitle,
      text: googleDocExport.text,
      note: googleDocExport.note,
    };
  }

  if (looksLikePdf(contentType, finalUrl)) {
    const body = await readExternalBody(response, signal);
    if (!body.ok) return bodyFailureResult(body, finalUrl, contentType);
    try {
      const extracted = (await pdfParse(body.buffer)).text.trim().slice(0, MAX_CAPTURED_TEXT);
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
    const body = await readExternalBody(response, signal);
    if (!body.ok) return bodyFailureResult(body, finalUrl, contentType);
    const filename = guessOfficeFilename(finalUrl, contentType);
    try {
      const extracted = ((await extractOfficeText(body.buffer, filename)) ?? "")
        .trim()
        .slice(0, MAX_CAPTURED_TEXT);
      return {
        status: extracted.length > 0 ? "captured" : "metadata_only",
        resolvedUrl: finalUrl,
        contentType,
        pageTitle: null,
        text: extracted,
        note:
          extracted.length > 0
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
    const body = await readExternalBody(response, signal);
    if (!body.ok) return bodyFailureResult(body, finalUrl, contentType);
    const html = body.buffer.toString("utf-8").slice(0, MAX_CAPTURED_TEXT * 2);
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
    const body = await readExternalBody(response, signal);
    if (!body.ok) return bodyFailureResult(body, finalUrl, contentType);
    const text = body.buffer.toString("utf-8").trim().slice(0, MAX_CAPTURED_TEXT);
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

  await response.body?.cancel().catch(() => {});
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

type ExternalBodyRead =
  | { ok: true; buffer: Buffer }
  | { ok: false; reason: "too_large" | "unreadable"; message: string };

/**
 * Read a response body within MAX_EXTERNAL_BODY_BYTES. A user abort is
 * rethrown; anything else (too large, connection dropped, body timeout) is
 * returned as a failure so one bad link degrades to metadata_only instead of
 * failing the whole capture phase.
 */
async function readExternalBody(
  response: Response,
  signal: AbortSignal | null
): Promise<ExternalBodyRead> {
  try {
    const buffer = await readBodyWithLimit(response, MAX_EXTERNAL_BODY_BYTES, {
      signal,
      timeoutMs: EXTERNAL_FETCH_TIMEOUT_MS,
    });
    return { ok: true, buffer };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DownloadTooLargeError) {
      return { ok: false, reason: "too_large", message: externalBodyCapNote() };
    }
    return {
      ok: false,
      reason: "unreadable",
      message: `The resource was reachable, but its body could not be read: ${
        error instanceof Error ? error.message : "unknown error"
      }.`,
    };
  }
}

function externalBodyCapNote(): string {
  const mb = Math.round(MAX_EXTERNAL_BODY_BYTES / (1024 * 1024));
  return `The resource was reachable, but it is larger than the ${mb} MB limit for external downloads, so its content was not captured.`;
}

function bodyFailureResult(
  body: Extract<ExternalBodyRead, { ok: false }>,
  finalUrl: string,
  contentType: string | null
): ExternalLinkFetchResult {
  return {
    status: "metadata_only",
    resolvedUrl: finalUrl,
    contentType,
    pageTitle: null,
    text: "",
    note: body.message,
  };
}

interface GoogleWorkspaceExportRequest {
  url: string;
  /** Filename whose extension picks the extractor for the export body. */
  filename: string;
  label: string;
}

/**
 * Google Docs, Slides and Sheets pages are login-walled JavaScript shells, but
 * each has an export endpoint that serves the document itself: plain text
 * for a Doc, a .pptx for Slides (speaker notes included), CSV for a Sheet.
 */
async function fetchGoogleWorkspaceExport(
  url: string,
  signal: AbortSignal | null
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

  const timed = withTimeoutSignal(signal, EXTERNAL_FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(exportRequest.url, {
        redirect: "follow",
        signal: timed.signal,
      });
    } finally {
      timed.dispose();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }

    const body = await readExternalBody(response, signal);
    if (!body.ok) {
      // The export exists but cannot be read here; report why rather than
      // falling back to scraping the (login-walled) HTML page.
      return {
        contentType: response.headers.get("content-type"),
        pageTitle: null,
        text: "",
        note: body.message,
      };
    }

    const text = (
      exportRequest.filename.endsWith(".pptx")
        ? (await extractOfficeText(body.buffer, exportRequest.filename)) ?? ""
        : body.buffer.toString("utf-8")
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
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/** Export URL for a Google Doc, Slides or Sheets link, or null. Exported for tests. */
export function buildGoogleWorkspaceExportRequest(
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
    };
  }

  return null;
}

async function fetchWithControlledRedirects(
  url: string,
  config: Config,
  signal: AbortSignal | null
): Promise<{ response: Response; finalUrl: string }> {
  const canvasOrigin = getOrigin(config.baseUrl);
  let currentUrl = url;

  for (let attempt = 0; attempt < MAX_REDIRECTS; attempt += 1) {
    const headers = shouldSendCanvasAuth(currentUrl, canvasOrigin)
      ? { Authorization: `Bearer ${config.accessToken}` }
      : undefined;
    // The timer covers the header exchange only; body reads are bounded
    // separately by readExternalBody. A user abort propagates through.
    const timed = withTimeoutSignal(signal, EXTERNAL_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        headers,
        redirect: "manual",
        signal: timed.signal,
      });
    } finally {
      timed.dispose();
    }
    const redirectLocation = response.headers.get("location");

    if (
      redirectLocation &&
      response.status >= 300 &&
      response.status < 400
    ) {
      await response.body?.cancel().catch(() => {});
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

  const addCandidate = (rawUrl: string | null, title: string | null): void => {
    if (!rawUrl) return;

    const resolvedUrl = resolveHref(rawUrl, options.baseUrl);
    if (
      !resolvedUrl ||
      !isCapturableExternalUrl(resolvedUrl, {
        courseId: options.courseId,
        canvasOrigin: options.canvasOrigin,
      })
    ) {
      return;
    }

    const normalizedUrl = normalizeExternalUrl(resolvedUrl);
    if (!normalizedUrl || seen.has(normalizedUrl)) {
      return;
    }
    seen.add(normalizedUrl);

    results.push({
      title: decodeEntities(title ?? "").replace(/\s+/g, " ").trim() || normalizedUrl,
      url: normalizedUrl,
    });
  };

  const anchorRegex = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorRegex.exec(html)) !== null) {
    const tag = match[0];
    addCandidate(extractAttr(tag, "href"), normalizeLinkTitle(match[1], ""));
  }

  // Embedded players and documents: an iframe around a PDF or a Google Doc,
  // a <video> with a caption <track> (a transcript of the lecture), an
  // <object data="..."> viewer. YouTube/Panopto iframes resolve to HTML
  // shells and land as metadata_only, which still records where the
  // recording lives.
  const embeddedTagRegex = /<(iframe|embed|object|video|audio|source|track)\b[^>]*>/gi;
  let embeddedMatch: RegExpExecArray | null;

  while ((embeddedMatch = embeddedTagRegex.exec(html)) !== null) {
    const tagName = (embeddedMatch[1] ?? "").toLowerCase();
    const tag = embeddedMatch[0];
    const attrName = tagName === "object" ? "data" : "src";
    const url =
      extractAttr(tag, attrName) ??
      extractAttr(tag, "data-src") ??
      (tagName === "object" ? extractAttr(tag, "src") : null);
    addCandidate(url, mediaLinkTitle(tagName, tag));
  }

  return results;
}

/** A title for an embedded resource: its own title, else what kind of embed it is. */
function mediaLinkTitle(tagName: string, tag: string): string | null {
  const title = extractAttr(tag, "title") ?? extractAttr(tag, "aria-label");
  if (title) return title;

  if (tagName === "track") {
    const kind = extractAttr(tag, "kind");
    const label = extractAttr(tag, "label");
    const srclang = extractAttr(tag, "srclang");
    const descriptor = [label, srclang ? `(${srclang})` : null].filter(Boolean).join(" ");
    const prefix = kind ? titleCase(kind) : "Media track";
    return descriptor ? `${prefix}: ${descriptor}` : prefix;
  }

  if (tagName === "source") {
    const type = extractAttr(tag, "type");
    return type ? `Media source: ${type}` : "Media source";
  }

  if (tagName === "video" || tagName === "audio") {
    return `${titleCase(tagName)} media`;
  }

  return "Embedded content";
}

function titleCase(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1).toLowerCase() : value;
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
    return !/\.(pdf|zip|png|jpe?g|gif|webp|pptx?|docx?|xlsx?|txt|md|csv|json|xml|vtt|srt)(?:$|[?#])/i.test(
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

const OFFICE_URL_EXTENSION = /\.(docx|docm|dotx|pptx|pptm|potx|xlsx|xlsm|xltx)(?:$|[?#])/i;

function looksLikeOfficeDocument(contentType: string | null, url: string): boolean {
  if (OFFICE_URL_EXTENSION.test(url)) return true;
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("application/vnd.openxmlformats-officedocument") ||
    normalized.includes("application/vnd.ms-powerpoint") ||
    normalized.includes("application/vnd.ms-excel") ||
    normalized.includes("application/msword")
  );
}

/** A filename whose extension selects the Office extractor (URL first, then content type). */
function guessOfficeFilename(url: string, contentType: string | null): string {
  try {
    const lastSegment = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    if (OFFICE_URL_EXTENSION.test(lastSegment)) return lastSegment;
  } catch {
    // Fall through to the content type.
  }
  const normalized = (contentType ?? "").toLowerCase();
  if (normalized.includes("presentation") || normalized.includes("powerpoint")) {
    return "document.pptx";
  }
  if (normalized.includes("spreadsheet") || normalized.includes("excel")) {
    return "document.xlsx";
  }
  return "document.docx";
}

/**
 * Plain text, including caption/subtitle tracks (.vtt/.srt): a lecture's
 * captions are its transcript, the highest-value text a recording can offer.
 */
function looksLikePlainText(contentType: string | null, url: string): boolean {
  if (!contentType) {
    return /\.(txt|md|csv|json|xml|vtt|srt)(?:$|[?#])/i.test(url);
  }

  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("application/json") ||
    normalized.includes("application/xml") ||
    normalized.includes("application/x-subrip") ||
    /\.(vtt|srt)(?:$|[?#])/i.test(url)
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
