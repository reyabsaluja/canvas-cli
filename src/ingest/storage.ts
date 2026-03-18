import fs from "node:fs/promises";
import path from "node:path";
import type {
  CourseMetadata,
  AssignmentIndexEntry,
  ModuleIndexEntry,
  FileIndexEntry,
  PageIndexEntry,
  SyllabusCandidate,
  DownloadedAttachmentEntry,
  IngestionMeta,
} from "./types.js";
import { htmlToText } from "../format/html-to-text.js";

/**
 * Write all ingestion artifacts to the course directory.
 * Creates the directory structure and writes normalized JSON files.
 */
export async function writeIngestionArtifacts(
  coursePath: string,
  courseMeta: CourseMetadata,
  assignments: AssignmentIndexEntry[],
  modules: ModuleIndexEntry[],
  files: FileIndexEntry[],
  pages: PageIndexEntry[],
  syllabusCandidates: SyllabusCandidate[],
  attachments: DownloadedAttachmentEntry[],
  ingestion: IngestionMeta
): Promise<void> {
  // Ensure directory structure
  await fs.mkdir(path.join(coursePath, "extracted"), { recursive: true });
  await fs.mkdir(path.join(coursePath, "attachments"), { recursive: true });

  // Write all JSON files atomically (write to temp then rename)
  const writes: Array<[string, unknown]> = [
    ["course.json", courseMeta],
    ["assignments.json", assignments],
    ["modules.json", modules],
    ["files.json", files],
    ["pages.json", pages],
    ["syllabus-candidates.json", syllabusCandidates],
    ["attachments.json", attachments],
    ["ingestion.json", ingestion],
  ];

  for (const [filename, data] of writes) {
    const filePath = path.join(coursePath, filename);
    const content = JSON.stringify(data, null, 2) + "\n";
    await writeAtomic(filePath, content);
  }

  // Extract syllabus body text if present
  if (courseMeta.syllabusBody) {
    const htmlPath = path.join(coursePath, "extracted", "syllabus-body.html");
    await writeAtomic(htmlPath, courseMeta.syllabusBody);

    const textContent = htmlToText(courseMeta.syllabusBody);
    const txtPath = path.join(coursePath, "extracted", "syllabus-body.txt");
    await writeAtomic(txtPath, textContent + "\n");
  }
}

/**
 * Write a file atomically by writing to a temp file then renaming.
 * Prevents half-written files if the process is interrupted.
 */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + ".tmp";
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}
