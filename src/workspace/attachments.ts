import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config/env.js";
import { debug, maskUrl } from "../debug.js";
import { decodeEntities } from "../format/html-to-text.js";
import {
  sanitizeFilename,
  confineToDirectory,
  isSameCanvasOrigin,
  resolveCanvasUrl,
} from "../sanitize.js";
import { fetchCanvasFile, readBodyWithLimit } from "../canvas/safe-download.js";

export interface LinkedFile {
  title: string;
  url: string;
  downloadUrl: string;
}

/**
 * A Canvas file URL: `/files/:id` or `/courses/:id/files/:id`, optionally
 * followed by `/preview`, `/download`, or a query string. Group 1 is the id.
 */
const CANVAS_FILE_PATH = /(?:^|\/)(?:courses\/\d+\/)?files\/(\d+)(?:\/|$)/i;
const NON_HTTP_HREF = /^(?:#|mailto:|tel:|javascript:|data:|blob:)/i;
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;
/** Attributes through which Canvas HTML references a file. */
const FILE_URL_ATTRIBUTES = ["href", "src", "data", "data-src", "data-download-url"];

/**
 * Resolve one URL (an href, a module item's external URL) to a Canvas file
 * link, or null when it is not one.
 *
 * With `canvasBaseUrl` the URL is resolved against it and must share its
 * origin; anything on another host is dropped here (with a debug line) rather
 * than becoming a "failed" attachment at download time. Without a base the
 * caller cannot check origins, so absolute links of any host are kept as-is
 * and relative Canvas-shaped paths are kept for the downloader to resolve.
 */
export function extractLinkedFileFromUrl(
  rawUrl: string | null | undefined,
  title?: string | null,
  canvasBaseUrl?: string | null
): LinkedFile | null {
  const cleanUrl = resolveCanvasFileUrl(rawUrl, canvasBaseUrl);
  if (!cleanUrl) return null;

  const downloadUrl = toDownloadUrl(cleanUrl);
  const filename = title?.trim() || filenameFromUrl(cleanUrl) || "canvas-file";
  return { title: filename, url: cleanUrl, downloadUrl };
}

/** The Canvas file id named by a Canvas file URL, or null. */
export function canvasFileIdFromUrl(
  rawUrl: string | null | undefined,
  canvasBaseUrl?: string | null
): number | null {
  const cleanUrl = resolveCanvasFileUrl(rawUrl, canvasBaseUrl);
  if (!cleanUrl) return null;
  const match = cleanUrl.split(/[?#]/)[0]!.match(CANVAS_FILE_PATH);
  const id = match ? Number.parseInt(match[1]!, 10) : Number.NaN;
  return Number.isFinite(id) ? id : null;
}

/**
 * Extract Canvas file links from rich Canvas HTML.
 *
 * Canvas marks file links with the "instructure_file_link" class and a title
 * attribute holding the real filename, but instructors also paste plain
 * /courses/:id/files/:id links, embed PDFs in iframes, and drop files in
 * through `src`, `data`, `data-src` and `data-download-url` attributes.
 * Every form is captured in one pass; the same file linked several ways is
 * returned once, under the most descriptive title seen.
 */
export function extractLinkedFiles(
  descriptionHtml: string,
  canvasBaseUrl?: string | null
): LinkedFile[] {
  const files: LinkedFile[] = [];
  const byKey = new Map<string, LinkedFile>();

  const addLinkedFile = (
    rawUrl: string | null,
    title: string | null | undefined
  ): void => {
    if (!rawUrl) return;
    const linkedFile = extractLinkedFileFromUrl(rawUrl, title, canvasBaseUrl);
    if (!linkedFile) return;

    const key = linkedFileDedupKey(linkedFile.downloadUrl);
    const existing = byKey.get(key);
    if (existing) {
      // A later mention may carry the real filename (title attribute) where
      // the first was a bare "Download" anchor or a titleless iframe.
      if (isGenericLinkedFileTitle(existing.title) && !isGenericLinkedFileTitle(linkedFile.title)) {
        existing.title = linkedFile.title;
      }
      return;
    }
    byKey.set(key, linkedFile);
    files.push(linkedFile);
  };

  // Anchors first: their label is a usable title when no title attribute is set.
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let anchorMatch: RegExpExecArray | null;
  while ((anchorMatch = anchorRegex.exec(descriptionHtml)) !== null) {
    const attrs = anchorMatch[1] ?? "";
    const href = extractAttr(attrs, "href");
    if (!href) continue;
    const title = extractAttr(attrs, "title");
    const label = extractLinkLabel(anchorMatch[2] ?? "");
    addLinkedFile(href, title || (label && !looksLikeUrl(label) ? label : null));
  }

  // Then every tag, for embeds and data attributes (anchors again, harmlessly).
  const tagRegex = /<([a-z][a-z0-9:-]*)\b([^>]*)>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRegex.exec(descriptionHtml)) !== null) {
    const attrs = tagMatch[2] ?? "";
    const title =
      extractAttr(attrs, "title") ||
      extractAttr(attrs, "aria-label") ||
      extractAttr(attrs, "alt");
    for (const attr of FILE_URL_ATTRIBUTES) {
      addLinkedFile(extractAttr(attrs, attr), title);
    }
  }

  return files;
}

function resolveCanvasFileUrl(
  rawUrl: string | null | undefined,
  canvasBaseUrl?: string | null
): string | null {
  const cleanUrl = decodeEntities(rawUrl ?? "").trim();
  if (!cleanUrl || NON_HTTP_HREF.test(cleanUrl)) return null;

  if (canvasBaseUrl) {
    const resolved = resolveCanvasUrl(cleanUrl, canvasBaseUrl);
    if (!resolved || !isCanvasFilePath(resolved.pathname)) return null;
    if (!isSameCanvasOrigin(cleanUrl, canvasBaseUrl)) {
      debug("general", `Dropping off-origin file link: ${maskUrl(resolved.toString())}`);
      return null;
    }
    return resolved.toString();
  }

  if (ABSOLUTE_URL.test(cleanUrl)) {
    try {
      const parsed = new URL(cleanUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      return isCanvasFilePath(parsed.pathname) ? cleanUrl : null;
    } catch {
      return null;
    }
  }

  // Relative path with no base to resolve against: keep it when it is shaped
  // like a Canvas file link so the downloader can resolve it later.
  const pathOnly = cleanUrl.split(/[?#]/)[0] ?? "";
  return isCanvasFilePath(pathOnly) ? cleanUrl : null;
}

function isCanvasFilePath(pathname: string): boolean {
  if (/^\/api\//i.test(pathname)) return false;
  return CANVAS_FILE_PATH.test(pathname);
}

/**
 * Convert a Canvas file preview URL to a download URL.
 * e.g. /courses/123/files/456?verifier=abc → /courses/123/files/456/download?verifier=abc
 * A trailing /preview or /download is normalised away first, and the
 * preview-only `wrap=1` parameter is dropped.
 */
function toDownloadUrl(url: string): string {
  const [pathPart = "", queryPart] = url.split("?", 2);

  const cleanQuery = queryPart
    ? queryPart
        .split("&")
        .filter((p) => !p.startsWith("wrap="))
        .join("&")
    : "";

  const normalizedPath = pathPart
    .replace(/\/(?:preview|download)\/?$/i, "")
    .replace(/\/$/, "");
  return cleanQuery ? `${normalizedPath}/download?${cleanQuery}` : `${normalizedPath}/download`;
}

function extractAttr(attrs: string, attr: string): string | null {
  const regex = new RegExp(
    `(?:^|\\s)${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i"
  );
  const match = attrs.match(regex);
  const value = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  const decoded = decodeEntities(value).trim();
  return decoded.length > 0 ? decoded : null;
}

function extractLinkLabel(innerHtml: string): string | null {
  const label = decodeEntities(innerHtml.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return label.length > 0 ? label : null;
}

function looksLikeUrl(value: string): boolean {
  return ABSOLUTE_URL.test(value) || value.startsWith("/");
}

function isGenericLinkedFileTitle(title: string): boolean {
  return (
    /^file-\d+$/.test(title) ||
    /^(?:here|link|download|click here|open|view|preview|attachment|file)$/i.test(title.trim())
  );
}

function linkedFileDedupKey(downloadUrl: string): string {
  const fileId = filenameFromUrl(downloadUrl);
  if (fileId) return fileId;
  return downloadUrl;
}

function filenameFromUrl(url: string): string | null {
  // Try to extract from path like /files/12345
  const match = url.match(/\/files\/(\d+)/);
  return match ? `file-${match[1]}` : null;
}

export interface DownloadResult {
  downloaded: string[];
  skipped: string[];
  failed: string[];
}

/**
 * Download linked files into the attachments directory.
 * Skips files that already exist. Uses the Canvas auth token for downloads.
 */
export async function downloadAttachments(
  files: LinkedFile[],
  attachmentsDir: string,
  config: Config
): Promise<DownloadResult> {
  await fs.mkdir(attachmentsDir, { recursive: true });

  const downloaded: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const file of files) {
    const safeName = sanitizeFilename(file.title);
    const filePath = confineToDirectory(attachmentsDir, safeName);

    // Skip if already downloaded
    try {
      await fs.stat(filePath);
      skipped.push(file.title);
      continue;
    } catch {
      // File doesn't exist, proceed with download
    }

    // Only Canvas-hosted files are fetched; the bearer token must never be
    // sent to a third-party host embedded in course HTML.
    if (!isSameCanvasOrigin(file.downloadUrl, config.baseUrl)) {
      failed.push(file.title);
      continue;
    }

    try {
      const response = await fetchCanvasFile(file.downloadUrl, config);

      if (!response.ok) {
        failed.push(file.title);
        continue;
      }

      const buffer = await readBodyWithLimit(response);
      await fs.writeFile(filePath, buffer);
      downloaded.push(file.title);
    } catch {
      failed.push(file.title);
    }
  }

  return { downloaded, skipped, failed };
}
