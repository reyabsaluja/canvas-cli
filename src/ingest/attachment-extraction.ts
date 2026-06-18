import fs from "node:fs/promises";
import path from "node:path";
import { extractFileText, unpackZipToDirectory } from "../extract/extract-text.js";
import {
  getExtractedAttachmentPath,
  getUnpackedZipDir,
} from "../enrich/course-documents.js";
import type {
  DownloadedAttachmentEntry,
  ZipAttachmentEntry,
} from "./types.js";

const MAX_NESTED_ZIP_DEPTH = 3;

/**
 * Shared attachment-content pipeline used by both full ingestion and on-demand
 * chat downloads. Writes a `.txt` sidecar for every extractable attachment
 * and, for zip attachments, unpacks the archive and writes per-entry sidecars
 * so inner files are individually addressable/openable.
 *
 * Mutates the given attachment entries in place to record zipEntries metadata.
 * Safe to re-run: rewrites sidecars atomically.
 */
export async function extractAttachmentContents(
  coursePath: string,
  attachments: DownloadedAttachmentEntry[]
): Promise<void> {
  for (const attachment of attachments) {
    await extractSingleAttachment(coursePath, attachment);
  }
}

/**
 * Extract sidecars and unpack a single attachment. Exposed so callers that
 * download attachments one at a time (the chat agent) can trigger the exact
 * same pipeline without faking an array.
 */
export async function extractSingleAttachment(
  coursePath: string,
  attachment: DownloadedAttachmentEntry
): Promise<void> {
  if (attachment.status !== "downloaded" && attachment.status !== "skipped") {
    return;
  }

  const fullPath = path.join(coursePath, attachment.localPath);
  const extractedPath = getExtractedAttachmentPath(
    coursePath,
    attachment.localPath
  );
  try {
    const text = await extractFileText(fullPath, attachment.originalFilename);
    if (isReadableExtractedText(text)) {
      await fs.mkdir(path.dirname(extractedPath), { recursive: true });
      await writeAtomicText(extractedPath, text.endsWith("\n") ? text : text + "\n");
    }
  } catch {
    // Extraction is best-effort; keep the pipeline resilient if a file is unreadable.
  }

  if (path.extname(attachment.originalFilename).toLowerCase() === ".zip") {
    try {
      attachment.zipEntries = await unpackAttachmentZip(coursePath, attachment);
    } catch {
      // Unpacking is best-effort.
    }
  }
}

/**
 * Unpack a zip attachment next to its original location and write per-entry
 * text sidecars so inner PDFs/text files are individually searchable and
 * openable. Returns the per-entry metadata for persisting on the attachment.
 */
export async function unpackAttachmentZip(
  coursePath: string,
  attachment: DownloadedAttachmentEntry
): Promise<ZipAttachmentEntry[]> {
  const zipAbsolutePath = path.join(coursePath, attachment.localPath);
  const unpackDirAbsolute = getUnpackedZipDir(coursePath, attachment.localPath);
  return unpackZipEntries(coursePath, zipAbsolutePath, unpackDirAbsolute, {
    depth: 0,
    entryNamePrefix: "",
  });
}

async function unpackZipEntries(
  coursePath: string,
  zipAbsolutePath: string,
  unpackDirAbsolute: string,
  options: { depth: number; entryNamePrefix: string }
): Promise<ZipAttachmentEntry[]> {
  await fs.mkdir(unpackDirAbsolute, { recursive: true });

  const unpackedEntries = await unpackZipToDirectory(
    zipAbsolutePath,
    unpackDirAbsolute
  );

  const entries: ZipAttachmentEntry[] = [];
  for (const unpacked of unpackedEntries) {
    const entryName = `${options.entryNamePrefix}${unpacked.entryName}`;
    const entryLocalPath = path.relative(coursePath, unpacked.absolutePath);
    const filename = path.basename(unpacked.entryName);
    const extractedTextPath = await writeExtractedEntryText(
      coursePath,
      entryLocalPath,
      unpacked.absolutePath,
      filename
    );

    entries.push({
      entryName,
      filename,
      localPath: entryLocalPath,
      extractedTextPath,
      size: unpacked.size,
    });

    if (
      path.extname(unpacked.entryName).toLowerCase() === ".zip" &&
      options.depth < MAX_NESTED_ZIP_DEPTH
    ) {
      try {
        const nestedEntries = await unpackZipEntries(
          coursePath,
          unpacked.absolutePath,
          `${unpacked.absolutePath}.unpacked`,
          {
            depth: options.depth + 1,
            entryNamePrefix: `${entryName}.unpacked/`,
          }
        );
        entries.push(...nestedEntries);
      } catch {
        // Best-effort — keep the nested zip entry even if it cannot be unpacked.
      }
    }
  }

  return entries;
}

async function writeExtractedEntryText(
  coursePath: string,
  entryLocalPath: string,
  absolutePath: string,
  filename: string
): Promise<string | null> {
  try {
    const text = await extractFileText(absolutePath, filename);
    if (isReadableExtractedText(text)) {
      const absoluteExtractedPath = getExtractedAttachmentPath(
        coursePath,
        entryLocalPath
      );
      await fs.mkdir(path.dirname(absoluteExtractedPath), { recursive: true });
      await writeAtomicText(
        absoluteExtractedPath,
        text.endsWith("\n") ? text : text + "\n"
      );
      return path.relative(coursePath, absoluteExtractedPath);
    }
  } catch {
    // Best-effort — leave extractedTextPath as null if extraction fails.
  }
  return null;
}

function isReadableExtractedText(text: string): boolean {
  if (!text) return false;
  if (text.startsWith("[")) return false;
  return text.trim().length > 0;
}

async function writeAtomicText(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}
