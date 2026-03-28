import type { CanvasClient } from "../canvas/client.js";
import type { Config } from "../config/env.js";
import type { Course } from "../domain/models.js";
import type {
  IngestionResult,
  ModuleIndexEntry,
  FileIndexEntry,
  DownloadedAttachmentEntry,
} from "./types.js";
import type { SelectedAttachment } from "./attachment-selection.js";
import type { CanvasAssignment } from "../canvas/types.js";
import { extractLinkedFiles } from "../workspace/attachments.js";
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
 * 4. Select targeted attachments for download (syllabus + important files)
 * 5. Select ALL module-linked files for download (instructor-curated content)
 * 6. Download all selected attachments
 * 7. Write all artifacts to local course directory
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

  // Step 4: Select heuristic-matched attachments (syllabus, rubric, etc.)
  const heuristicAttachments = selectAttachments(syllabusCandidates, files);

  // Step 5: Select ALL module-linked files for download
  // Modules are curated by instructors — every file in a module is relevant
  const moduleAttachments = await selectModuleFiles(
    modules,
    files,
    heuristicAttachments,
    client
  );

  // Step 5b: Also download files linked in assignment descriptions
  // These have verifier tokens making them downloadable even when Files API is blocked
  const descriptionAttachments = selectDescriptionLinkedFiles(
    raw.assignments,
    [...heuristicAttachments, ...moduleAttachments]
  );

  const allSelected = [
    ...heuristicAttachments,
    ...moduleAttachments,
    ...descriptionAttachments,
  ];

  // Step 6: Download all attachments
  const attachmentsDir = path.join(coursePath, "attachments");
  const attachmentResults = await downloadSelectedAttachments(
    allSelected,
    attachmentsDir,
    config
  );

  // Step 7: Build ingestion metadata
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

  // Step 8: Write all artifacts (including front page and fetched pages)
  await writeIngestionArtifacts(
    coursePath,
    courseMeta,
    assignments,
    modules,
    files,
    pages,
    syllabusCandidates,
    attachmentResults,
    ingestion,
    raw.frontPageBody,
    raw.fetchedPages
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

/**
 * Select all module-linked files for download.
 * For each module item of type "File", find or fetch its download URL.
 * Skips files already selected by heuristic attachment selection.
 */
async function selectModuleFiles(
  modules: ModuleIndexEntry[],
  files: FileIndexEntry[],
  alreadySelected: SelectedAttachment[],
  client: CanvasClient
): Promise<SelectedAttachment[]> {
  const selected: SelectedAttachment[] = [];
  const alreadySelectedIds = new Set(
    alreadySelected.filter((a) => a.fileId != null).map((a) => a.fileId)
  );

  // Build a lookup from file ID to FileIndexEntry
  const fileById = new Map<number, FileIndexEntry>();
  for (const f of files) {
    fileById.set(f.id, f);
  }

  for (const mod of modules) {
    for (const item of mod.items) {
      if (item.type !== "File") continue;
      if (item.contentId === null) continue;
      if (alreadySelectedIds.has(item.contentId)) continue;

      // Try to find in the files index first (if Files API was accessible)
      let file = fileById.get(item.contentId);

      // If not in files index, try fetching individual file metadata via API
      if (!file) {
        const fetched = await client.getFileSafe(item.contentId);
        if (fetched) {
          file = {
            id: fetched.id,
            displayName: fetched.display_name,
            filename: fetched.filename,
            contentType: fetched.content_type,
            size: fetched.size,
            url: fetched.url,
            updatedAt: fetched.updated_at,
            folderId: fetched.folder_id,
          };
        }
      }

      if (!file) continue;

      alreadySelectedIds.add(file.id);
      selected.push({
        sourceType: "module_linked",
        fileId: file.id,
        filename: file.displayName || item.title,
        downloadUrl: file.url,
        reason: `module file in "${mod.name}"`,
        contentType: file.contentType,
        size: file.size,
        subfolder: "modules",
      });
    }
  }

  return selected;
}

/**
 * Extract files linked in assignment descriptions (with verifier tokens).
 * These are often instruction PDFs, rubrics, etc. that Canvas links directly
 * in the assignment body with download-ready URLs.
 */
function selectDescriptionLinkedFiles(
  assignments: CanvasAssignment[],
  alreadySelected: SelectedAttachment[]
): SelectedAttachment[] {
  const selected: SelectedAttachment[] = [];
  const alreadyUrls = new Set(alreadySelected.map((a) => a.downloadUrl));

  for (const assignment of assignments) {
    const desc = (assignment as any).description;
    if (!desc || typeof desc !== "string") continue;

    const linked = extractLinkedFiles(desc);
    for (const file of linked) {
      if (alreadyUrls.has(file.downloadUrl)) continue;
      alreadyUrls.add(file.downloadUrl);

      selected.push({
        sourceType: "assignment_linked",
        fileId: null,
        filename: file.title,
        downloadUrl: file.downloadUrl,
        reason: `linked in "${assignment.name}" description`,
        contentType: null,
        size: null,
        subfolder: "assignments",
      });
    }
  }

  return selected;
}
