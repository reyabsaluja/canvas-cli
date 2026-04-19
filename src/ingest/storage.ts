import fs from "node:fs/promises";
import path from "node:path";
import { extractFileText } from "../extract/extract-text.js";
import { getExtractedAttachmentPath, getExtractedPagePath } from "../enrich/course-documents.js";
import type {
  CourseMetadata,
  AssignmentIndexEntry,
  ModuleIndexEntry,
  FileIndexEntry,
  PageIndexEntry,
  SyllabusCandidate,
  DownloadedAttachmentEntry,
  LectureIndexEntry,
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
  lectures: LectureIndexEntry[],
  ingestion: IngestionMeta,
  frontPageBody?: string | null,
  fetchedPages?: Array<{ slug: string; title: string; body: string }>
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
    ["lectures.json", lectures],
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

  // Extract front page (course home page) if present
  if (frontPageBody) {
    await writeAtomic(
      path.join(coursePath, "extracted", "front-page.html"),
      frontPageBody
    );
    await writeAtomic(
      path.join(coursePath, "extracted", "front-page.txt"),
      htmlToText(frontPageBody) + "\n"
    );
  }

  // Extract individually fetched page bodies
  if (fetchedPages && fetchedPages.length > 0) {
    const pagesDir = path.join(coursePath, "extracted", "pages");
    await fs.mkdir(pagesDir, { recursive: true });
    for (const page of fetchedPages) {
      const pageTextPath = getExtractedPagePath(coursePath, page.slug);
      await writeAtomic(pageTextPath, `# ${page.title}\n\n${htmlToText(page.body)}\n`);
    }
  }

  for (const attachment of attachments) {
    if (attachment.status !== "downloaded" && attachment.status !== "skipped") {
      continue;
    }
    const fullPath = path.join(coursePath, attachment.localPath);
    const extractedPath = getExtractedAttachmentPath(coursePath, attachment.localPath);
    try {
      const text = await extractFileText(fullPath, attachment.originalFilename);
      if (!text || text.startsWith("[") || text.trim().length === 0) {
        continue;
      }
      await fs.mkdir(path.dirname(extractedPath), { recursive: true });
      await writeAtomic(extractedPath, text.endsWith("\n") ? text : text + "\n");
    } catch {
      // Extraction is best-effort; keep ingestion resilient if a file is unreadable.
    }
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
