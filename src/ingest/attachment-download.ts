import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config/env.js";
import type { DownloadedAttachmentEntry } from "./types.js";
import type { SelectedAttachment } from "./attachment-selection.js";
import {
  sanitizeFilename,
  sanitizeSubfolder,
  confineToDirectory,
  isSameCanvasOrigin,
  stripQueryParam,
} from "../sanitize.js";
import { isAbortError } from "../errors.js";
import { fetchCanvasFile, readBodyWithLimit } from "../canvas/safe-download.js";
import { debug, maskUrl } from "../debug.js";

/**
 * Download selected attachments into the course attachments directory.
 * Skips files that already exist locally.
 * Uses the Canvas auth token for downloads.
 *
 * If signal is aborted, stops processing and cleans up any partial download
 * in progress. Already-completed downloads are left intact.
 */
export type DownloadProgressCallback = (
  completed: number,
  total: number
) => void;

export async function downloadSelectedAttachments(
  attachments: SelectedAttachment[],
  attachmentsDir: string,
  config: Config,
  signal?: AbortSignal | null,
  onProgress?: DownloadProgressCallback | null
): Promise<DownloadedAttachmentEntry[]> {
  const results: DownloadedAttachmentEntry[] = [];
  const total = attachments.length;

  for (const attachment of attachments) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    const safeSubfolder = sanitizeSubfolder(attachment.subfolder);
    const safeFilename = sanitizeFilename(attachment.filename);
    // Forward slashes in localPath are intentional — manifest uses POSIX paths regardless of platform
    const subDir = confineToDirectory(attachmentsDir, safeSubfolder);
    await fs.mkdir(subDir, { recursive: true });

    const filePath = confineToDirectory(subDir, safeFilename);
    // One-time `verifier` tokens are only needed for the fetch itself; do not
    // persist them in attachments.json.
    const persistedDownloadUrl = stripQueryParam(attachment.downloadUrl, "verifier");
    const makeEntry = (
      status: DownloadedAttachmentEntry["status"],
      size: number | null
    ): DownloadedAttachmentEntry => ({
      sourceType: attachment.sourceType,
      canvasFileId: attachment.fileId,
      originalFilename: attachment.filename,
      localPath: `attachments/${safeSubfolder}/${safeFilename}`,
      contentType: attachment.contentType,
      size,
      downloadUrl: persistedDownloadUrl,
      reason: attachment.reason,
      status,
    });

    // Skip if already downloaded
    if (await fileExists(filePath)) {
      results.push(makeEntry("skipped", attachment.size));
      onProgress?.(results.length, total);
      continue;
    }

    // Never send the Canvas bearer token to a host other than the Canvas origin.
    if (!isSameCanvasOrigin(attachment.downloadUrl, config.baseUrl)) {
      debug("api", `Skipping off-origin attachment: ${maskUrl(attachment.downloadUrl)}`);
      results.push(makeEntry("failed", attachment.size));
      onProgress?.(results.length, total);
      continue;
    }

    const tmpPath = filePath + ".tmp";
    try {
      const response = await fetchCanvasFile(attachment.downloadUrl, config, { signal });

      if (!response.ok) {
        results.push(makeEntry("failed", attachment.size));
        onProgress?.(results.length, total);
        continue;
      }

      const buffer = await readBodyWithLimit(response, undefined, { signal });
      await fs.writeFile(tmpPath, buffer);
      await fs.rename(tmpPath, filePath);

      results.push(makeEntry("downloaded", buffer.length));
      onProgress?.(results.length, total);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      if (isAbortError(err)) {
        throw err;
      }
      results.push(makeEntry("failed", attachment.size));
      onProgress?.(results.length, total);
    }
  }

  return results;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}
