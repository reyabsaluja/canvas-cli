import type { CanvasClient } from "../canvas/client.js";
import type { Config } from "../config/env.js";
import type { Course } from "../domain/models.js";
import type {
  IngestionResult,
  IngestionMeta,
  ModuleIndexEntry,
  FileIndexEntry,
  DownloadedAttachmentEntry,
  LectureIndexEntry,
} from "./types.js";
import type { SelectedAttachment } from "./attachment-selection.js";
import type { CanvasAssignment } from "../canvas/types.js";
import { extractLinkedFiles } from "../workspace/attachments.js";
import { makeCourseSlug, getCoursePath } from "./slug.js";
import {
  fetchCourseContent,
  type RawDiscussionThread,
} from "./fetch-course-content.js";
import { mapWithConcurrency } from "./concurrency.js";
import { normalizeCourseContent } from "./normalize-content.js";
import { identifySyllabusCandidates } from "./syllabus-heuristics.js";
import {
  selectAttachments,
  selectCourseFiles,
  selectAssignmentAttachments,
  selectTopicAttachments,
  buildFolderIndex,
} from "./attachment-selection.js";
import { downloadSelectedAttachments } from "./attachment-download.js";
import { discoverLectures } from "./lecture-discovery.js";
import { captureExternalCourseLinks } from "./external-link-capture.js";
import { writeIngestionArtifacts } from "./storage.js";
import path from "node:path";

const MODULE_FILE_METADATA_CONCURRENCY = 4;

/**
 * Main ingestion pipeline. Deterministic, non-AI.
 *
 * Steps:
 * 1. Fetch all available course content from Canvas API
 * 2. Normalize into structured index types
 * 3. Identify syllabus candidates via title heuristics
 * 4. Select targeted attachments for download (syllabus + important files)
 * 5. Select ALL module-linked files for download (instructor-curated content)
 * 5c. Files linked from page/announcement/discussion HTML
 * 5c'. Files attached to announcements, discussion posts, and replies
 * 5d. Crawl the Files tab: every remaining readable document, folder-aware
 * 6. Download all selected attachments
 * 7. Write all artifacts to local course directory
 */
export type ProgressCallback = (message: string) => void;
const noop: ProgressCallback = () => {};

export async function ingestCourse(
  course: Course,
  client: CanvasClient,
  config: Config,
  options: {
    refresh: boolean;
    signal?: AbortSignal | null;
    onProgress?: ProgressCallback | null;
  }
): Promise<IngestionResult> {
  const signal = options.signal ?? null;
  const onProgress = options.onProgress ?? noop;
  const slug = makeCourseSlug(course.courseCode, course.id);
  const coursePath = getCoursePath(slug);

  // Step 1: Fetch raw content from Canvas
  onProgress("Fetching course content from Canvas...");
  const raw = await fetchCourseContent(client, course.id, signal);

  // Step 2: Normalize
  onProgress("Processing course structure...");
  const {
    courseMeta,
    assignments,
    modules,
    files,
    pages,
    announcements,
    discussions,
  } =
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
  onProgress("Selecting files for download...");
  const heuristicAttachments = selectAttachments(syllabusCandidates, files);

  // Step 5: Select ALL module-linked files for download
  // Modules are curated by instructors — every file in a module is relevant
  const moduleAttachments = await selectModuleFiles(
    modules,
    files,
    heuristicAttachments,
    client,
    signal
  );

  // Step 5b: Also download files linked in assignment descriptions
  // These have verifier tokens making them downloadable even when Files API is blocked
  const descriptionAttachments = selectDescriptionLinkedFiles(
    raw.assignments,
    [...heuristicAttachments, ...moduleAttachments]
  );

  // Step 5c: Download files linked in fetched Canvas pages, front page,
  // syllabus, announcements, and discussion threads.
  const htmlLinkedAttachments = selectHtmlLinkedFiles(
    raw.fetchedPages,
    raw.frontPageBody,
    courseMeta.syllabusBody,
    raw.announcements,
    raw.discussionThreads,
    [...heuristicAttachments, ...moduleAttachments, ...descriptionAttachments]
  );

  // Step 5c': Files attached to posts through the Canvas "Attach" button.
  // They are never linked from the message HTML, so the selectors above miss
  // them — and the Files API may be blocked, so this is often the only route.
  const topicAttachmentSelection = selectTopicAttachments(
    raw.announcements,
    raw.discussionThreads,
    [
      ...heuristicAttachments,
      ...moduleAttachments,
      ...descriptionAttachments,
      ...htmlLinkedAttachments,
    ]
  );

  // Step 5c'': Files attached to assignments themselves (starter code,
  // templates, data). Never linked from the description HTML either.
  const assignmentAttachmentSelection = selectAssignmentAttachments(raw.assignments, [
    ...heuristicAttachments,
    ...moduleAttachments,
    ...descriptionAttachments,
    ...htmlLinkedAttachments,
    ...topicAttachmentSelection.selected,
  ]);

  const capturedExternalLinks = await captureExternalCourseLinks({
    courseId: course.id,
    courseHtmlUrl: courseMeta.htmlUrl,
    modules,
    assignments: raw.assignments,
    frontPageBody: raw.frontPageBody,
    fetchedPages: raw.fetchedPages,
    syllabusBody: courseMeta.syllabusBody,
    announcements: raw.announcements,
    discussionThreads: raw.discussionThreads,
    config,
    signal,
  });
  const externalLinks = capturedExternalLinks.map((capture) => capture.entry);

  // Step 5d: Crawl the Files tab. Anything readable that no other selector
  // claimed (lecture decks, readings, handouts sitting in folders) is
  // downloaded with its folder path preserved.
  const folders = buildFolderIndex(raw.folders);
  const folderPathById = new Map(folders.map((folder) => [folder.id, folder.path]));
  for (const file of files) {
    file.folderPath =
      file.folderId !== null ? (folderPathById.get(file.folderId) ?? null) : null;
  }
  const courseFileSelection = selectCourseFiles(files, folders, [
    ...heuristicAttachments,
    ...moduleAttachments,
    ...descriptionAttachments,
    ...htmlLinkedAttachments,
    ...topicAttachmentSelection.selected,
    ...assignmentAttachmentSelection.selected,
  ]);

  const allSelected = [
    ...heuristicAttachments,
    ...moduleAttachments,
    ...descriptionAttachments,
    ...htmlLinkedAttachments,
    ...topicAttachmentSelection.selected,
    ...assignmentAttachmentSelection.selected,
    ...courseFileSelection.selected,
  ];
  // downloadSelectedAttachments returns results in input order; remember where
  // the topic attachments sit so their outcome can be summarised.
  const topicAttachmentStart =
    heuristicAttachments.length +
    moduleAttachments.length +
    descriptionAttachments.length +
    htmlLinkedAttachments.length;
  const topicAttachmentEnd =
    topicAttachmentStart + topicAttachmentSelection.selected.length;

  // Step 6: Download all attachments
  const attachmentsDir = path.join(coursePath, "attachments");
  onProgress(`Downloading files (0/${allSelected.length})...`);
  const attachmentResults = await downloadSelectedAttachments(
    allSelected,
    attachmentsDir,
    config,
    signal,
    (completed, total) => {
      onProgress(`Downloading files (${completed}/${total})...`);
    }
  );

  // Step 7: Discover lectures from module items, front page, and fetched pages
  // Announcements, discussion posts and assignment descriptions often hold the
  // recording as an embedded player rather than a link; scan them too.
  const embeddedMediaSources = [
    ...raw.announcements.map((topic) => ({
      title: topic.title,
      body: topic.message ?? "",
      source: `announcement: ${topic.title}`,
    })),
    ...raw.discussions.map((topic) => ({
      title: topic.title,
      body: topic.message ?? "",
      source: `discussion: ${topic.title}`,
    })),
    ...raw.assignments.map((assignment) => ({
      title: assignment.name,
      body: assignment.description ?? "",
      source: `assignment: ${assignment.name}`,
    })),
  ];
  const lectures = discoverLectures(
    modules,
    pages,
    raw.frontPageBody,
    raw.fetchedPages,
    courseMeta.syllabusBody,
    files,
    embeddedMediaSources
  );

  // Step 8: Build ingestion metadata
  const downloaded = attachmentResults.filter((a) => a.status === "downloaded");
  const skipped = attachmentResults.filter((a) => a.status === "skipped");
  const failed = attachmentResults.filter((a) => a.status === "failed");

  const courseFileResults = attachmentResults.filter(
    (a) => a.sourceType === "course_file"
  );
  const topicAttachmentResults = attachmentResults.slice(
    topicAttachmentStart,
    topicAttachmentEnd
  );

  const ingestion: IngestionMeta = {
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
      lectures: lectures.length,
      quizzes: raw.quizzes.length,
      externalTools: raw.tabs.filter((tab) => tab.type === "external" && !tab.hidden).length,
      assignmentGroups: raw.assignmentGroups.length,
      attachmentsDownloaded: downloaded.length,
      attachmentsSkipped: skipped.length,
      attachmentsFailed: failed.length,
    },
    courseFiles: {
      ...courseFileSelection.summary,
      downloaded: courseFileResults.filter((a) => a.status !== "failed").length,
      failed: courseFileResults.filter((a) => a.status === "failed").length,
    },
    assignmentAttachments: {
      selected: assignmentAttachmentSelection.summary.assignments,
      alreadySelected: assignmentAttachmentSelection.summary.alreadySelected,
      skippedTooLarge: assignmentAttachmentSelection.summary.skippedTooLarge,
      downloaded: attachmentResults.filter(
        (a) => a.status === "downloaded" && a.reason.startsWith("attached to assignment")
      ).length,
      failed: attachmentResults.filter(
        (a) => a.status === "failed" && a.reason.startsWith("attached to assignment")
      ).length,
    },
    topicAttachments: {
      ...topicAttachmentSelection.summary,
      downloaded: topicAttachmentResults.filter((a) => a.status !== "failed").length,
      failed: topicAttachmentResults.filter((a) => a.status === "failed").length,
    },
    discussionThreads: {
      topics: raw.discussionThreads.length,
      replies: raw.discussionThreads.reduce(
        (sum, thread) => sum + thread.entries.length,
        0
      ),
      pagedReplies: raw.discussionThreads.reduce(
        (sum, thread) => sum + (thread.repliesPaged ?? 0),
        0
      ),
    },
  };

  // Step 9: Write all artifacts (including front page and fetched pages)
  onProgress("Writing course data to disk...");
  await writeIngestionArtifacts(
    coursePath,
    courseMeta,
    assignments,
    modules,
    files,
    pages,
    announcements,
    discussions,
    externalLinks,
    syllabusCandidates,
    attachmentResults,
    lectures,
    ingestion,
    raw.assignments,
    raw.frontPageBody,
    raw.fetchedPages,
    raw.announcements,
    raw.discussionThreads,
    capturedExternalLinks,
    raw.assignmentGroups
  );

  return {
    courseMeta,
    assignments,
    modules,
    files,
    pages,
    announcements,
    discussions,
    externalLinks,
    syllabusCandidates,
    attachments: attachmentResults,
    lectures,
    ingestion,
    coursePath,
    folders,
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
  client: CanvasClient,
  signal?: AbortSignal | null
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

  const candidates: Array<{
    modName: string;
    itemTitle: string;
    contentId: number;
    file: FileIndexEntry | null;
  }> = [];

  for (const mod of modules) {
    for (const item of mod.items) {
      if (item.type !== "File") continue;
      if (item.contentId === null) continue;
      if (alreadySelectedIds.has(item.contentId)) continue;
      candidates.push({
        modName: mod.name,
        itemTitle: item.title,
        contentId: item.contentId,
        file: fileById.get(item.contentId) ?? null,
      });
    }
  }

  const resolved = await mapWithConcurrency(
    candidates,
    MODULE_FILE_METADATA_CONCURRENCY,
    async (candidate) => {
      if (candidate.file) {
        return {
          file: candidate.file,
          modName: candidate.modName,
          itemTitle: candidate.itemTitle,
        };
      }

      const fetched = await client.getFileSafe(candidate.contentId, signal);
      if (!fetched) {
        return null;
      }

      return {
        file: {
          id: fetched.id,
          displayName: fetched.display_name,
          filename: fetched.filename,
          contentType: fetched.content_type,
          size: fetched.size,
          url: fetched.url,
          updatedAt: fetched.updated_at,
          folderId: fetched.folder_id,
        },
        modName: candidate.modName,
        itemTitle: candidate.itemTitle,
      };
    },
    signal
  );

  for (const entry of resolved) {
    if (!entry) continue;
    if (alreadySelectedIds.has(entry.file.id)) continue;
    alreadySelectedIds.add(entry.file.id);
    selected.push({
      sourceType: "module_linked",
      fileId: entry.file.id,
      filename: entry.file.displayName || entry.itemTitle,
      downloadUrl: entry.file.url,
      reason: `module file in "${entry.modName}"`,
      contentType: entry.file.contentType,
      size: entry.file.size,
      subfolder: "modules",
    });
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

/**
 * Extract files linked in fetched Canvas page bodies, front page, syllabus,
 * and announcements. Pages like "Labs" or announcement posts often contain
 * direct download links to worksheets, handouts, and other course materials.
 */
function selectHtmlLinkedFiles(
  fetchedPages: Array<{ slug: string; title: string; body: string }>,
  frontPageBody: string | null,
  syllabusBody: string | null,
  announcements: Array<{ title: string; message: string | null }>,
  discussionThreads: RawDiscussionThread[],
  alreadySelected: SelectedAttachment[]
): SelectedAttachment[] {
  const selected: SelectedAttachment[] = [];
  const alreadyUrls = new Set(alreadySelected.map((a) => a.downloadUrl));

  const htmlSources: Array<{ title: string; body: string }> = [
    ...fetchedPages,
  ];
  if (frontPageBody) {
    htmlSources.push({ title: "Front Page", body: frontPageBody });
  }
  if (syllabusBody) {
    htmlSources.push({ title: "Syllabus", body: syllabusBody });
  }
  for (const announcement of announcements) {
    if (!announcement.message) continue;
    htmlSources.push({
      title: `Announcement: ${announcement.title}`,
      body: announcement.message,
    });
  }
  for (const thread of discussionThreads) {
    if (thread.topic.message) {
      htmlSources.push({
        title: `Discussion: ${thread.topic.title}`,
        body: thread.topic.message,
      });
    }
    for (const entry of thread.entries) {
      if (!entry.message) continue;
      const author = entry.user_name ?? `User ${entry.user_id}`;
      htmlSources.push({
        title: `Discussion reply in "${thread.topic.title}" by ${author}`,
        body: entry.message,
      });
    }
  }

  for (const source of htmlSources) {
    const linked = extractLinkedFiles(source.body);
    for (const file of linked) {
      if (alreadyUrls.has(file.downloadUrl)) continue;
      alreadyUrls.add(file.downloadUrl);

      selected.push({
        sourceType: "page_linked",
        fileId: null,
        filename: file.title,
        downloadUrl: file.downloadUrl,
        reason: `linked in "${source.title}"`,
        contentType: null,
        size: null,
        subfolder: "pages",
      });
    }
  }

  return selected;
}
