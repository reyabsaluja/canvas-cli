import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config/env.js";
import type { DownloadedAttachmentEntry } from "./types.js";
import type { SelectedAttachment } from "./attachment-selection.js";
import { sanitizeFilename, sanitizeSubfolder, confineToDirectory } from "../sanitize.js";

/**
 * Download selected attachments into the course attachments directory.
 * Skips files that already exist locally.
 * Uses the Canvas auth token for downloads.
 */
export async function downloadSelectedAttachments(
  attachments: SelectedAttachment[],
  attachmentsDir: string,
  config: Config
): Promise<DownloadedAttachmentEntry[]> {
  const results: DownloadedAttachmentEntry[] = [];

  for (const attachment of attachments) {
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
      continue;
    }

    try {
      const response = await fetch(attachment.downloadUrl, {
        headers: { Authorization: `Bearer ${config.accessToken}` },
        redirect: "follow",
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
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(filePath, buffer);

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
    } catch {
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
