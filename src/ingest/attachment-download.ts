import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config/env.js";
import type { DownloadedAttachmentEntry } from "./types.js";
import type { SelectedAttachment } from "./attachment-selection.js";
import { sanitizeFilename, sanitizeSubfolder, confineToDirectory } from "../sanitize.js";
import { isAbortError } from "../errors.js";

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
    const localPath = path.relative(
      path.dirname(attachmentsDir),
      filePath
    );

    // Skip if already downloaded
    if (await fileExists(filePath)) {
      results.push({
        sourceType: attachment.sourceType,
        canvasFileId: attachment.fileId,
        originalFilename: attachment.filename,
        localPath: `attachments/${safeSubfolder}/${safeFilename}`,
        contentType: attachment.contentType,
        size: attachment.size,
        downloadUrl: attachment.downloadUrl,
        reason: attachment.reason,
        status: "skipped",
      });
      onProgress?.(results.length, total);
      continue;
    }

    const tmpPath = filePath + ".tmp";
    try {
      const response = await fetch(attachment.downloadUrl, {
        headers: { Authorization: `Bearer ${config.accessToken}` },
        redirect: "follow",
        signal: signal ?? undefined,
      });

      if (!response.ok) {
        results.push({
          sourceType: attachment.sourceType,
          canvasFileId: attachment.fileId,
          originalFilename: attachment.filename,
          localPath: `attachments/${safeSubfolder}/${safeFilename}`,
          contentType: attachment.contentType,
          size: attachment.size,
          downloadUrl: attachment.downloadUrl,
          reason: attachment.reason,
          status: "failed",
        });
        onProgress?.(results.length, total);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(tmpPath, buffer);
      await fs.rename(tmpPath, filePath);

      results.push({
        sourceType: attachment.sourceType,
        canvasFileId: attachment.fileId,
        originalFilename: attachment.filename,
        localPath: `attachments/${safeSubfolder}/${safeFilename}`,
        contentType: attachment.contentType,
        size: buffer.length,
        downloadUrl: attachment.downloadUrl,
        reason: attachment.reason,
        status: "downloaded",
      });
      onProgress?.(results.length, total);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      if (isAbortError(err)) {
        throw err;
      }
      results.push({
        sourceType: attachment.sourceType,
        canvasFileId: attachment.fileId,
        originalFilename: attachment.filename,
        localPath: `attachments/${safeSubfolder}/${safeFilename}`,
        contentType: attachment.contentType,
        size: attachment.size,
        downloadUrl: attachment.downloadUrl,
        reason: attachment.reason,
        status: "failed",
      });
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
