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
 * A file already on disk is kept unless Canvas reports a different size (the
 * instructor replaced it) or `refresh` is set, which downloads everything
 * again once per run.
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
  onProgress?: DownloadProgressCallback | null,
  options: { refresh?: boolean } = {}
): Promise<DownloadedAttachmentEntry[]> {
  const total = attachments.length;
  // With refresh, a path is fetched once; a second selection resolving to the
  // same path in this run reuses it.
  const fetchedThisRun = new Set<string>();
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
            refresh: options.refresh === true,
            fetchedThisRun,
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
    refresh: boolean;
    fetchedThisRun: Set<string>;
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

  // Keep the local copy unless it is stale: refresh asked for everything
  // again, or Canvas reports a different size than the file on disk.
  const localSize = await fileSize(filePath);
  if (localSize !== null) {
    const sizeChanged = attachment.size !== null && attachment.size !== localSize;
    // Never twice in one run: two Canvas files that share a local name would
    // otherwise keep replacing each other.
    const refetch = !ctx.fetchedThisRun.has(filePath) && (sizeChanged || ctx.refresh);
    if (!refetch) {
      return makeEntry("skipped", attachment.size);
    }
  }
  ctx.fetchedThisRun.add(filePath);

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

/** Size of a regular file in bytes, or null when there is no file. */
async function fileSize(p: string): Promise<number | null> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}
