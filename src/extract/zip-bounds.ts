import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Resource bounds for reading zip archives (course attachments, on-demand
 * unpacks, and Office Open XML containers). They exist only to stop a runaway
 * or hostile archive — a zip bomb, a 40 GB "lecture recording", a million
 * empty entries — from exhausting memory or disk; every normal course archive
 * stays far inside them, so no limit here should ever be lowered.
 */

/** Per-entry inflated size cap. */
export const MAX_ZIP_ENTRY_BYTES = 100 * 1024 * 1024;
/** Number of entries whose bodies are read from a single archive. */
export const MAX_ZIP_ENTRY_COUNT = 5000;
/** Total inflated bytes read from a single archive. */
export const MAX_ZIP_TOTAL_BYTES = 1024 * 1024 * 1024;

export interface ZipReadLimits {
  maxEntryBytes: number;
  maxEntries: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_READ_LIMITS: ZipReadLimits = {
  maxEntryBytes: MAX_ZIP_ENTRY_BYTES,
  maxEntries: MAX_ZIP_ENTRY_COUNT,
  maxTotalBytes: MAX_ZIP_TOTAL_BYTES,
};

export function resolveZipReadLimits(limits?: Partial<ZipReadLimits> | null): ZipReadLimits {
  return { ...DEFAULT_ZIP_READ_LIMITS, ...(limits ?? {}) };
}

/** "100 MB", "512 KB", "300 B" — for cap notes shown to the user. */
export function formatByteCap(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024 && bytes % (1024 * 1024 * 1024) === 0) {
    return `${bytes / (1024 * 1024 * 1024)} GB`;
  }
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Thrown when a zip entry declares, or actually inflates to, more than the per-entry cap. */
export class ZipEntryTooLargeError extends Error {
  readonly entryName: string;
  readonly limit: number;

  constructor(entryName: string, limit: number) {
    super(`Zip entry "${entryName}" inflates past the ${formatByteCap(limit)} per-file cap`);
    this.name = "ZipEntryTooLargeError";
    this.entryName = entryName;
    this.limit = limit;
  }
}

/** The subset of a yauzl-promise Entry these helpers rely on. */
export interface ZipEntryLike {
  filename: string;
  uncompressedSize: number;
  openReadStream(): Promise<NodeJS.ReadableStream>;
}

/**
 * Inflate one entry into memory, refusing it once it passes `maxBytes`.
 *
 * The declared size is checked first (cheap; catches an honest 3 GB entry
 * without touching the body). The streamed count is what actually prevents an
 * OOM: yauzl's own `validateEntrySizes` only reports a size mismatch after the
 * whole entry has been inflated, and lets entries whose size it is unsure of
 * (some macOS archives) grow without limit.
 */
export async function readZipEntryBounded(
  entry: ZipEntryLike,
  maxBytes: number
): Promise<Buffer> {
  const name = String(entry.filename);
  const declared = Number(entry.uncompressedSize ?? 0);
  if (declared > maxBytes) {
    throw new ZipEntryTooLargeError(name, maxBytes);
  }

  const stream = await entry.openReadStream();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > maxBytes) {
        throw new ZipEntryTooLargeError(name, maxBytes);
      }
      chunks.push(buffer);
    }
  } catch (error) {
    destroyQuietly(stream);
    throw error;
  }
  return Buffer.concat(chunks, total);
}

/**
 * Inflate one entry straight to disk. The bytes go to a `.tmp-*` sibling that
 * is renamed onto `targetPath` only once the whole entry has arrived within
 * `maxBytes`; on overflow or any other failure the temp file is removed and
 * the error rethrown. Returns the number of bytes written.
 */
export async function writeZipEntryBounded(
  entry: ZipEntryLike,
  targetPath: string,
  maxBytes: number
): Promise<number> {
  const name = String(entry.filename);
  const declared = Number(entry.uncompressedSize ?? 0);
  if (declared > maxBytes) {
    throw new ZipEntryTooLargeError(name, maxBytes);
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(targetPath),
    `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}-${path.basename(targetPath)}`
  );

  const stream = await entry.openReadStream();
  let total = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new ZipEntryTooLargeError(name, maxBytes));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(stream, counter, createWriteStream(tmpPath));
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    destroyQuietly(stream);
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  return total;
}

function destroyQuietly(stream: NodeJS.ReadableStream): void {
  const destroyable = stream as { destroy?: () => void };
  try {
    destroyable.destroy?.();
  } catch {
    // Already closed.
  }
}
