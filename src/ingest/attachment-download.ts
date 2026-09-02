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
import { mapWithConcurrency } from "./concurrency.js";

/** Parallel downloads; matches the other Canvas fetch stages. */
const DOWNLOAD_CONCURRENCY = 4;

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
  const total = attachments.length;
  let completed = 0;
  // Two selections can resolve to the same local path (same name, same
  // subfolder). Serialize those so the second sees the first's file and is
  // reported as "skipped" instead of racing on the same temp file.
  const inflightByPath = new Map<string, Promise<unknown>>();

  const results = await mapWithConcurrency(
    attachments,
    DOWNLOAD_CONCURRENCY,
    async (attachment) => {
      const safeSubfolder = sanitizeSubfolder(attachment.subfolder);
      const safeFilename = sanitizeFilename(attachment.filename);
      const subDir = confineToDirectory(attachmentsDir, safeSubfolder);
      const filePath = confineToDirectory(subDir, safeFilename);

      const previous = inflightByPath.get(filePath) ?? Promise.resolve();
      const run = previous
        .catch(() => {})
        .then(() =>
          downloadOne(attachment, {
            safeSubfolder,
            safeFilename,
            subDir,
            filePath,
            config,
            signal,
          })
        );
      inflightByPath.set(filePath, run);
      try {
        return await run;
      } finally {
        completed += 1;
        onProgress?.(completed, total);
      }
    },
    signal
  );

  return results;
}

async function downloadOne(
  attachment: SelectedAttachment,
  ctx: {
    safeSubfolder: string;
    safeFilename: string;
    subDir: string;
    filePath: string;
    config: Config;
    signal?: AbortSignal | null;
  }
): Promise<DownloadedAttachmentEntry> {
  const { safeSubfolder, safeFilename, subDir, filePath, config, signal } = ctx;
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  await fs.mkdir(subDir, { recursive: true });

  // Forward slashes in localPath are intentional — manifest uses POSIX paths regardless of platform
  const localSubfolder = safeSubfolder.split(path.sep).join("/");
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
    localPath: `attachments/${localSubfolder}/${safeFilename}`,
    contentType: attachment.contentType,
    size,
    downloadUrl: persistedDownloadUrl,
    reason: attachment.reason,
    status,
  });

  // Skip if already downloaded
  if (await fileExists(filePath)) {
    return makeEntry("skipped", attachment.size);
  }

  // Never send the Canvas bearer token to a host other than the Canvas origin.
  if (!isSameCanvasOrigin(attachment.downloadUrl, config.baseUrl)) {
    debug("api", `Skipping off-origin attachment: ${maskUrl(attachment.downloadUrl)}`);
    return makeEntry("failed", attachment.size);
  }

  const tmpPath = filePath + ".tmp";
  try {
    const response = await fetchCanvasFile(attachment.downloadUrl, config, { signal });

    if (!response.ok) {
      return makeEntry("failed", attachment.size);
    }

    const buffer = await readBodyWithLimit(response, undefined, { signal });
    await fs.writeFile(tmpPath, buffer);
    await fs.rename(tmpPath, filePath);

    return makeEntry("downloaded", buffer.length);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    if (isAbortError(err)) {
      throw err;
    }
    return makeEntry("failed", attachment.size);
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}
