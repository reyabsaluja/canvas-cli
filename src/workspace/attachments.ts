import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config/env.js";
import { decodeEntities } from "../format/html-to-text.js";
import { sanitizeFilename, confineToDirectory } from "../sanitize.js";

export interface LinkedFile {
  title: string;
  url: string;
  downloadUrl: string;
}

export function extractLinkedFileFromUrl(
  rawUrl: string,
  title?: string | null,
  canvasBaseUrl?: string | null
): LinkedFile | null {
  const cleanUrl = resolveCanvasFileUrl(rawUrl, canvasBaseUrl);
  if (!cleanUrl) {
    return null;
  }

  const downloadUrl = toDownloadUrl(cleanUrl);
  const filename =
    title?.trim() || filenameFromUrl(cleanUrl) || "canvas-file";
  return { title: filename, url: cleanUrl, downloadUrl };
}

/**
 * Extract Canvas file links from rich Canvas HTML.
 * Canvas often marks file links with the "instructure_file_link" class and a
 * title attribute, but instructors can also paste plain /courses/:id/files/:id
 * links next to those richer anchors. Capture both forms in one pass.
 */
export function extractLinkedFiles(
  descriptionHtml: string,
  canvasBaseUrl?: string | null
): LinkedFile[] {
  const files: LinkedFile[] = [];
  const seen = new Set<string>();

  const addLinkedFile = (
    rawUrl: string | null,
    title: string | null | undefined
  ): void => {
    if (!rawUrl) {
      return;
    }
    const linkedFile = extractLinkedFileFromUrl(rawUrl, title, canvasBaseUrl);
    if (!linkedFile) {
      return;
    }

    const dedupKey = getLinkedFileDedupKey(linkedFile.downloadUrl);
    if (seen.has(dedupKey)) {
      return;
    }
    seen.add(dedupKey);
    files.push(linkedFile);
  };

  const linkRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkRegex.exec(descriptionHtml)) !== null) {
    const attrs = match[1] ?? "";
    const innerHtml = match[2] ?? "";
    const className = extractAttr(attrs, "class") ?? "";
    const href = extractAttr(attrs, "href");

    if (
      !href ||
      (!isInstructureFileLink(className) &&
        !isCanvasFileUrl(href, canvasBaseUrl))
    ) {
      continue;
    }

    const title = extractAttr(attrs, "title");
    const label = extractLinkLabel(innerHtml);
    addLinkedFile(href, title || label);
  }

  const embeddedTagRegex = /<([a-z][a-z0-9:-]*)\b([^>]*)>/gi;
  let embeddedMatch: RegExpExecArray | null;
  while ((embeddedMatch = embeddedTagRegex.exec(descriptionHtml)) !== null) {
    const attrs = embeddedMatch[2] ?? "";
    const title =
      extractAttr(attrs, "title") ||
      extractAttr(attrs, "aria-label") ||
      extractAttr(attrs, "alt");
    for (const attr of ["href", "src", "data", "data-src", "data-download-url"]) {
      addLinkedFile(extractAttr(attrs, attr), title);
    }
  }

  return files;
}

/**
 * Convert a Canvas file preview URL to a download URL.
 * e.g. /courses/123/files/456?verifier=abc → /courses/123/files/456/download?verifier=abc
 */
function toDownloadUrl(url: string): string {
  // Split on ? to separate path and query
  const [pathPart, queryPart] = url.split("?", 2);

  // Remove &wrap=1 from query params (it's a preview param)
  const cleanQuery = queryPart
    ? queryPart
        .split("&")
        .filter((p) => !p.startsWith("wrap="))
        .join("&")
    : "";

  const normalizedPath = pathPart
    .replace(/\/(?:preview|download)\/?$/i, "")
    .replace(/\/$/, "");
  const downloadPath = normalizedPath.endsWith("/download")
    ? normalizedPath
    : normalizedPath + "/download";
  return cleanQuery ? `${downloadPath}?${cleanQuery}` : downloadPath;
}

function extractAttr(tag: string, attr: string): string | null {
  const regex = new RegExp(
    `(?:^|\\s)${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i"
  );
  const match = tag.match(regex);
  const value = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  const decoded = decodeEntities(value).trim();
  return decoded.length > 0 ? decoded : null;
}

function isInstructureFileLink(className: string): boolean {
  return className.split(/\s+/).includes("instructure_file_link");
}

function isCanvasFileUrl(url: string, canvasBaseUrl?: string | null): boolean {
  return resolveCanvasFileUrl(url, canvasBaseUrl) !== null;
}

function resolveCanvasFileUrl(
  rawUrl: string,
  canvasBaseUrl?: string | null
): string | null {
  const cleanUrl = decodeEntities(rawUrl).trim();
  if (!cleanUrl) return null;

  let parsed: URL;
  let canvasOrigin: string;
  try {
    if (!canvasBaseUrl) return null;
    const base = new URL(canvasBaseUrl);
    canvasOrigin = base.origin;
    parsed = new URL(cleanUrl, base);
  } catch {
    return null;
  }

  if (parsed.origin !== canvasOrigin) {
    return null;
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    return null;
  }
  if (!/(?:^|\/)(?:courses\/\d+\/)?files\/\d+(?:\/|$)/i.test(parsed.pathname)) {
    return null;
  }

  return parsed.toString();
}

function extractLinkLabel(innerHtml: string): string | null {
  const label = decodeEntities(innerHtml.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return label.length > 0 ? label : null;
}

function getLinkedFileDedupKey(downloadUrl: string): string {
  const fileId = filenameFromUrl(downloadUrl);
  if (fileId) {
    return fileId;
  }

  try {
    const trimmed = downloadUrl.trim();
    const parsed = new URL(trimmed, "https://canvas.invalid");
    parsed.searchParams.delete("wrap");
    parsed.pathname = parsed.pathname.replace(/\/download\/?$/, "");
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    const isRelative = !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
    return isRelative ? `${parsed.pathname}${parsed.search}` : parsed.toString();
  } catch {
    return downloadUrl;
  }
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

    try {
      const response = await fetch(file.downloadUrl, {
        headers: { Authorization: `Bearer ${config.accessToken}` },
        redirect: "follow",
      });

      if (!response.ok) {
        failed.push(file.title);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(filePath, buffer);
      downloaded.push(file.title);
    } catch {
      failed.push(file.title);
    }
  }

  return { downloaded, skipped, failed };
}
