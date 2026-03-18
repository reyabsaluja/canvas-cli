import type { CanvasClient } from "../canvas/client.js";
import type { Config } from "../config/env.js";
import type { Course } from "../domain/models.js";
import type { IngestionResult } from "./types.js";
import { makeCourseSlug, getCoursePath } from "./slug.js";
import { fetchCourseContent } from "./fetch-course-content.js";
import { normalizeCourseContent } from "./normalize-content.js";
import { identifySyllabusCandidates } from "./syllabus-heuristics.js";
import { selectAttachments } from "./attachment-selection.js";
import { downloadSelectedAttachments } from "./attachment-download.js";
import { writeIngestionArtifacts } from "./storage.js";
import path from "node:path";

/**
 * Main ingestion pipeline. Deterministic, non-AI.
 *
 * Steps:
 * 1. Fetch all available course content from Canvas API
 * 2. Normalize into structured index types
 * 3. Identify syllabus candidates via title heuristics
 * 4. Select targeted attachments for download
 * 5. Download selected attachments
 * 6. Write all artifacts to local course directory
 */
export async function ingestCourse(
  course: Course,
  client: CanvasClient,
  config: Config,
  options: { refresh: boolean }
): Promise<IngestionResult> {
  const slug = makeCourseSlug(course.courseCode, course.id);
  const coursePath = getCoursePath(slug);

  // Step 1: Fetch raw content from Canvas
  const raw = await fetchCourseContent(client, course.id);

  // Step 2: Normalize
  const { courseMeta, assignments, modules, files, pages } =
    normalizeCourseContent(raw);

  // Count module items
  const totalModuleItems = modules.reduce((sum, m) => sum + m.items.length, 0);

  // Step 3: Identify syllabus candidates
  const syllabusCandidates = identifySyllabusCandidates(
    courseMeta,
    files,
    modules,
    pages
  );

  // Step 4: Select attachments for download
  const selectedAttachments = selectAttachments(syllabusCandidates, files);

  // Step 5: Download attachments
  const attachmentsDir = path.join(coursePath, "attachments");
  const attachmentResults = await downloadSelectedAttachments(
    selectedAttachments,
    attachmentsDir,
    config
  );

  // Step 6: Build ingestion metadata
  const downloaded = attachmentResults.filter((a) => a.status === "downloaded");
  const skipped = attachmentResults.filter((a) => a.status === "skipped");
  const failed = attachmentResults.filter((a) => a.status === "failed");

  const ingestion = {
    version: 1,
    ingestedAt: new Date().toISOString(),
    courseId: course.id,
    courseName: course.name,
    courseCode: course.courseCode,
    refresh: options.refresh,
    counts: {
      assignments: assignments.length,
      modules: modules.length,
      moduleItems: totalModuleItems,
      files: files.length,
      pages: pages.length,
      syllabusCandidates: syllabusCandidates.length,
      attachmentsDownloaded: downloaded.length,
      attachmentsSkipped: skipped.length,
      attachmentsFailed: failed.length,
    },
  };

  // Step 7: Write all artifacts
  await writeIngestionArtifacts(
    coursePath,
    courseMeta,
    assignments,
    modules,
    files,
    pages,
    syllabusCandidates,
    attachmentResults,
    ingestion
  );

  return {
    courseMeta,
    assignments,
    modules,
    files,
    pages,
    syllabusCandidates,
    attachments: attachmentResults,
    ingestion,
    coursePath,
  };
}
