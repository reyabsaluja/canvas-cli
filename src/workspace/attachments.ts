import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config/env.js";

export interface LinkedFile {
  title: string;
  url: string;
  downloadUrl: string;
}

/**
 * Extract Canvas file links from assignment description HTML.
 * Canvas file links have the class "instructure_file_link" and a title attribute
 * with the real filename. The href points to a preview page; we convert it to
 * a download URL by appending /download before the query string.
 */
export function extractLinkedFiles(descriptionHtml: string): LinkedFile[] {
  const files: LinkedFile[] = [];

  // Match <a> tags with instructure_file_link class
  const linkRegex =
    /<a[^>]*class="[^"]*instructure_file_link[^"]*"[^>]*>/gi;
  let match;

  while ((match = linkRegex.exec(descriptionHtml)) !== null) {
    const tag = match[0];

    const title = extractAttr(tag, "title");
    const href = extractAttr(tag, "href");

    if (!href) continue;

    // Decode HTML entities in the URL
    const cleanUrl = href.replace(/&amp;/g, "&");

    const downloadUrl = toDownloadUrl(cleanUrl);
    const filename = title || filenameFromUrl(cleanUrl) || `file-${files.length}`;

    files.push({ title: filename, url: cleanUrl, downloadUrl });
  }

  // Fallback: if no instructure_file_link found, look for any Canvas file URLs
  if (files.length === 0) {
    const hrefRegex =
      /href="([^"]*\/courses\/\d+\/files\/\d+[^"]*)"/gi;
    let hrefMatch;
    while ((hrefMatch = hrefRegex.exec(descriptionHtml)) !== null) {
      const cleanUrl = hrefMatch[1].replace(/&amp;/g, "&");
      const downloadUrl = toDownloadUrl(cleanUrl);
      const filename = filenameFromUrl(cleanUrl) || `file-${files.length}`;
      files.push({ title: filename, url: cleanUrl, downloadUrl });
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

  const downloadPath = pathPart.replace(/\/$/, "") + "/download";
  return cleanQuery ? `${downloadPath}?${cleanQuery}` : downloadPath;
}

function extractAttr(tag: string, attr: string): string | null {
  const regex = new RegExp(`${attr}="([^"]*)"`, "i");
  const match = tag.match(regex);
  return match ? match[1] : null;
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
    const filePath = path.join(attachmentsDir, file.title);

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
