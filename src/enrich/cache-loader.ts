import fs from "node:fs/promises";
import path from "node:path";
import { makeCourseSlug, getCoursePath } from "../ingest/slug.js";
import type {
  AssignmentIndexEntry,
  ModuleIndexEntry,
  FileIndexEntry,
  PageIndexEntry,
  SyllabusCandidate,
  DownloadedAttachmentEntry,
} from "../ingest/types.js";

/**
 * Loaded course cache — all the ingestion artifacts needed for enrichment.
 */
export interface CourseCache {
  courseId: number;
  coursePath: string;
  assignments: AssignmentIndexEntry[];
  modules: ModuleIndexEntry[];
  files: FileIndexEntry[];
  pages: PageIndexEntry[];
  syllabusCandidates: SyllabusCandidate[];
  attachments: DownloadedAttachmentEntry[];
}

/**
 * Try to load the course cache for a given course.
 * Returns null if no cache exists or if files are malformed.
 */
export async function loadCourseCache(
  courseCode: string,
  courseId: number
): Promise<CourseCache | null> {
  const slug = makeCourseSlug(courseCode, courseId);
  const coursePath = getCoursePath(slug);

  // Check if ingestion.json exists (marker that ingestion completed)
  const ingestionPath = path.join(coursePath, "ingestion.json");
  if (!(await fileExists(ingestionPath))) {
    return null;
  }

  try {
    const [assignments, modules, files, pages, syllabusCandidates, attachments] =
      await Promise.all([
        readJsonSafe<AssignmentIndexEntry[]>(path.join(coursePath, "assignments.json"), []),
        readJsonSafe<ModuleIndexEntry[]>(path.join(coursePath, "modules.json"), []),
        readJsonSafe<FileIndexEntry[]>(path.join(coursePath, "files.json"), []),
        readJsonSafe<PageIndexEntry[]>(path.join(coursePath, "pages.json"), []),
        readJsonSafe<SyllabusCandidate[]>(path.join(coursePath, "syllabus-candidates.json"), []),
        readJsonSafe<DownloadedAttachmentEntry[]>(path.join(coursePath, "attachments.json"), []),
      ]);

    return {
      courseId,
      coursePath,
      assignments,
      modules,
      files,
      pages,
      syllabusCandidates,
      attachments,
    };
  } catch {
    return null;
  }
}

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return fallback;
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
