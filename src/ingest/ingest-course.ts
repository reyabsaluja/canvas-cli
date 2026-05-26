import type { CanvasClient } from "../canvas/client.js";
import type { Config } from "../config/env.js";
import type { Course } from "../domain/models.js";
import type {
  IngestionResult,
  ModuleIndexEntry,
  FileIndexEntry,
  DownloadedAttachmentEntry,
  LectureIndexEntry,
} from "./types.js";
import type { SelectedAttachment } from "./attachment-selection.js";
import type {
  CanvasAssignment,
  CanvasAttachment,
  CanvasCalendarEvent,
  CanvasDiscussionTopic,
  CanvasQuiz,
} from "../canvas/types.js";
import { extractLinkedFiles } from "../workspace/attachments.js";
import { makeCourseSlug, getCoursePath } from "./slug.js";
import {
  fetchCourseContent,
  type RawAssignmentRecord,
  type RawDiscussionThread,
} from "./fetch-course-content.js";
import { mapWithConcurrency } from "./concurrency.js";
import { normalizeCourseContent } from "./normalize-content.js";
import { identifySyllabusCandidates } from "./syllabus-heuristics.js";
import { selectAttachments } from "./attachment-selection.js";
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
    quizzes,
    calendarEvents,
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

  // Step 5b: Also download files attached directly to assignment details.
  const assignmentAttachments = selectAssignmentAttachedFiles(
    raw.assignments,
    [...heuristicAttachments, ...moduleAttachments]
  );

  // Step 5c: Also download files linked in assignment descriptions
  // These have verifier tokens making them downloadable even when Files API is blocked
  const descriptionAttachments = selectDescriptionLinkedFiles(
    raw.assignments,
    [...heuristicAttachments, ...moduleAttachments, ...assignmentAttachments]
  );

  // Step 5d: Download files attached directly to announcements/discussions.
  const discussionAttachments = selectAnnouncementDiscussionAttachedFiles(
    raw.announcements,
    raw.discussionThreads,
    [
      ...heuristicAttachments,
      ...moduleAttachments,
      ...assignmentAttachments,
      ...descriptionAttachments,
    ]
  );

  // Step 5e: Download files linked in fetched Canvas pages, front page,
  // syllabus, quizzes, calendar events, announcements, and discussion threads.
  const htmlLinkedAttachments = selectHtmlLinkedFiles(
    raw.fetchedPages,
    raw.frontPageBody,
    courseMeta.syllabusBody,
    raw.quizzes,
    raw.calendarEvents,
    raw.announcements,
    raw.discussionThreads,
    [
      ...heuristicAttachments,
      ...moduleAttachments,
      ...assignmentAttachments,
      ...descriptionAttachments,
      ...discussionAttachments,
    ]
  );

  const capturedExternalLinks = await captureExternalCourseLinks({
    courseId: course.id,
    courseHtmlUrl: courseMeta.htmlUrl,
    modules,
    assignments: raw.assignments,
    quizzes: raw.quizzes,
    calendarEvents: raw.calendarEvents,
    frontPageBody: raw.frontPageBody,
    fetchedPages: raw.fetchedPages,
    syllabusBody: courseMeta.syllabusBody,
    announcements: raw.announcements,
    discussionThreads: raw.discussionThreads,
    config,
  });
  const externalLinks = capturedExternalLinks.map((capture) => capture.entry);

  const allSelected = [
    ...heuristicAttachments,
    ...moduleAttachments,
    ...assignmentAttachments,
    ...descriptionAttachments,
    ...discussionAttachments,
    ...htmlLinkedAttachments,
  ];

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
  const lectures = discoverLectures(
    modules,
    pages,
    raw.frontPageBody,
    raw.fetchedPages,
    courseMeta.syllabusBody
  );

  // Step 8: Build ingestion metadata
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
      lectures: lectures.length,
      attachmentsDownloaded: downloaded.length,
      attachmentsSkipped: skipped.length,
      attachmentsFailed: failed.length,
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
    quizzes,
    calendarEvents,
    announcements,
    discussions,
    externalLinks,
    syllabusCandidates,
    attachmentResults,
    lectures,
    ingestion,
    raw.assignments,
    raw.quizzes,
    raw.calendarEvents,
    raw.frontPageBody,
    raw.fetchedPages,
    raw.announcements,
    raw.discussionThreads,
    capturedExternalLinks
  );

  return {
    courseMeta,
    assignments,
    modules,
    files,
    pages,
    quizzes,
    calendarEvents,
    announcements,
    discussions,
    externalLinks,
    syllabusCandidates,
    attachments: attachmentResults,
    lectures,
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
 * Extract files exposed by the assignment detail API's attachments field.
 * These can be instructor-provided specs or starter files even when they are
 * not linked in the rich-text assignment description.
 */
function selectAssignmentAttachedFiles(
  assignments: RawAssignmentRecord[],
  alreadySelected: SelectedAttachment[]
): SelectedAttachment[] {
  const selected: SelectedAttachment[] = [];
  const tryMarkSelected = createAttachmentDeduper(alreadySelected);

  for (const assignment of assignments) {
    for (const attachment of assignment.attachments ?? []) {
      if (!attachment.url) continue;
      if (
        !tryMarkSelected({
          fileId: attachment.id,
          downloadUrl: attachment.url,
        })
      ) {
        continue;
      }

      selected.push({
        sourceType: "assignment_attachment",
        fileId: attachment.id,
        filename:
          attachment.display_name ||
          attachment.filename ||
          `assignment-${assignment.id}-file-${attachment.id}`,
        downloadUrl: attachment.url,
        reason: `attached to assignment "${assignment.name}"`,
        contentType: attachment.content_type ?? null,
        size: attachment.size ?? null,
        subfolder: "assignments",
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
  const tryMarkSelected = createAttachmentDeduper(alreadySelected);

  for (const assignment of assignments) {
    const desc = (assignment as any).description;
    if (!desc || typeof desc !== "string") continue;

    const linked = extractLinkedFiles(desc);
    for (const file of linked) {
      if (!tryMarkSelected({ fileId: null, downloadUrl: file.downloadUrl })) {
        continue;
      }

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
 * Extract files attached to announcement/discussion API records. Canvas can
 * expose these as attachment objects without also placing a file link in the
 * HTML message body.
 */
function selectAnnouncementDiscussionAttachedFiles(
  announcements: CanvasDiscussionTopic[],
  discussionThreads: RawDiscussionThread[],
  alreadySelected: SelectedAttachment[]
): SelectedAttachment[] {
  const selected: SelectedAttachment[] = [];
  const tryMarkSelected = createAttachmentDeduper(alreadySelected);

  const addAttachment = (
    attachment: CanvasAttachment,
    options: {
      sourceType: "announcement_attachment" | "discussion_attachment";
      fallbackPrefix: string;
      reason: string;
      subfolder: string;
    }
  ): void => {
    if (!attachment.url) {
      return;
    }
    const fileId = Number.isFinite(attachment.id) ? attachment.id : null;
    if (
      !tryMarkSelected({
        fileId,
        downloadUrl: attachment.url,
      })
    ) {
      return;
    }

    selected.push({
      sourceType: options.sourceType,
      fileId,
      filename:
        attachment.display_name ||
        attachment.filename ||
        `${options.fallbackPrefix}-${fileId ?? selected.length + 1}`,
      downloadUrl: attachment.url,
      reason: options.reason,
      contentType: attachment.content_type ?? null,
      size: attachment.size ?? null,
      subfolder: options.subfolder,
    });
  };

  for (const announcement of announcements) {
    for (const attachment of getCanvasAttachments(announcement)) {
      addAttachment(attachment, {
        sourceType: "announcement_attachment",
        fallbackPrefix: `announcement-${announcement.id}-attachment`,
        reason: `attached to announcement "${announcement.title}"`,
        subfolder: "announcements",
      });
    }
  }

  for (const thread of discussionThreads) {
    for (const attachment of getCanvasAttachments(thread.topic)) {
      addAttachment(attachment, {
        sourceType: "discussion_attachment",
        fallbackPrefix: `discussion-${thread.topic.id}-attachment`,
        reason: `attached to discussion "${thread.topic.title}"`,
        subfolder: "discussions",
      });
    }

    for (const entry of thread.entries) {
      const author = entry.user_name ?? `User ${entry.user_id}`;
      for (const attachment of getCanvasAttachments(entry)) {
        addAttachment(attachment, {
          sourceType: "discussion_attachment",
          fallbackPrefix: `discussion-${thread.topic.id}-reply-${entry.id}-attachment`,
          reason: `attached to discussion reply in "${thread.topic.title}" by ${author}`,
          subfolder: "discussions",
        });
      }
    }
  }

  return selected;
}

function getCanvasAttachments(value: {
  attachment?: CanvasAttachment | null;
  attachments?: CanvasAttachment[] | null;
}): CanvasAttachment[] {
  const attachments: CanvasAttachment[] = [];
  if (value.attachment) {
    attachments.push(value.attachment);
  }
  if (Array.isArray(value.attachments)) {
    attachments.push(...value.attachments);
  }
  return attachments;
}

/**
 * Extract files linked in fetched Canvas page bodies, front page, syllabus,
 * quizzes, calendar events, announcements, and discussions. Pages like "Labs"
 * or announcement posts often contain direct download links to worksheets,
 * handouts, and other course materials.
 */
function selectHtmlLinkedFiles(
  fetchedPages: Array<{ slug: string; title: string; body: string }>,
  frontPageBody: string | null,
  syllabusBody: string | null,
  quizzes: CanvasQuiz[],
  calendarEvents: CanvasCalendarEvent[],
  announcements: Array<{ title: string; message: string | null }>,
  discussionThreads: RawDiscussionThread[],
  alreadySelected: SelectedAttachment[]
): SelectedAttachment[] {
  const selected: SelectedAttachment[] = [];
  const tryMarkSelected = createAttachmentDeduper(alreadySelected);

  const htmlSources: Array<{
    title: string;
    body: string;
    sourceType: "page_linked" | "quiz_linked" | "calendar_event_linked";
    subfolder: string;
  }> = fetchedPages.map((page) => ({
    title: page.title,
    body: page.body,
    sourceType: "page_linked",
    subfolder: "pages",
  }));
  if (frontPageBody) {
    htmlSources.push({
      title: "Front Page",
      body: frontPageBody,
      sourceType: "page_linked",
      subfolder: "pages",
    });
  }
  if (syllabusBody) {
    htmlSources.push({
      title: "Syllabus",
      body: syllabusBody,
      sourceType: "page_linked",
      subfolder: "pages",
    });
  }
  for (const quiz of quizzes) {
    if (!quiz.description) continue;
    htmlSources.push({
      title: `Quiz: ${quiz.title}`,
      body: quiz.description,
      sourceType: "quiz_linked",
      subfolder: "quizzes",
    });
  }
  for (const event of calendarEvents) {
    if (!event.description) continue;
    htmlSources.push({
      title: `Calendar event: ${event.title}`,
      body: event.description,
      sourceType: "calendar_event_linked",
      subfolder: "calendar-events",
    });
  }
  for (const announcement of announcements) {
    if (!announcement.message) continue;
    htmlSources.push({
      title: `Announcement: ${announcement.title}`,
      body: announcement.message,
      sourceType: "page_linked",
      subfolder: "pages",
    });
  }
  for (const thread of discussionThreads) {
    if (thread.topic.message) {
      htmlSources.push({
        title: `Discussion: ${thread.topic.title}`,
        body: thread.topic.message,
        sourceType: "page_linked",
        subfolder: "pages",
      });
    }
    for (const entry of thread.entries) {
      if (!entry.message) continue;
      const author = entry.user_name ?? `User ${entry.user_id}`;
      htmlSources.push({
        title: `Discussion reply in "${thread.topic.title}" by ${author}`,
        body: entry.message,
        sourceType: "page_linked",
        subfolder: "pages",
      });
    }
  }

  for (const source of htmlSources) {
    const linked = extractLinkedFiles(source.body);
    for (const file of linked) {
      if (!tryMarkSelected({ fileId: null, downloadUrl: file.downloadUrl })) {
        continue;
      }

      selected.push({
        sourceType: source.sourceType,
        fileId: null,
        filename: file.title,
        downloadUrl: file.downloadUrl,
        reason: `linked in "${source.title}"`,
        contentType: null,
        size: null,
        subfolder: source.subfolder,
      });
    }
  }

  return selected;
}

function createAttachmentDeduper(
  alreadySelected: SelectedAttachment[]
): (candidate: { fileId: number | null; downloadUrl: string }) => boolean {
  const seenKeys = new Set<string>();
  for (const attachment of alreadySelected) {
    for (const key of getAttachmentDedupKeys(
      attachment.fileId,
      attachment.downloadUrl
    )) {
      seenKeys.add(key);
    }
  }

  return (candidate) => {
    const keys = getAttachmentDedupKeys(
      candidate.fileId,
      candidate.downloadUrl
    );
    if (keys.some((key) => seenKeys.has(key))) {
      return false;
    }
    for (const key of keys) {
      seenKeys.add(key);
    }
    return true;
  };
}

function getAttachmentDedupKeys(
  fileId: number | null,
  downloadUrl: string
): string[] {
  const keys = new Set<string>();
  const canvasFileId = fileId ?? extractCanvasFileId(downloadUrl);
  if (canvasFileId !== null) {
    keys.add(`canvas-file:${canvasFileId}`);
  }

  const normalizedUrl = normalizeAttachmentUrl(downloadUrl);
  if (normalizedUrl) {
    keys.add(`url:${normalizedUrl}`);
  }

  return Array.from(keys);
}

function extractCanvasFileId(url: string): number | null {
  const match = url.match(/\/files\/(\d+)(?:\/|[?#]|$)/);
  if (!match?.[1]) {
    return null;
  }
  const id = Number.parseInt(match[1], 10);
  return Number.isFinite(id) ? id : null;
}

function normalizeAttachmentUrl(url: string): string | null {
  const trimmed = url.replace(/&amp;/g, "&").trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = new URL(trimmed, "https://canvas.invalid");
    parsed.searchParams.delete("wrap");
    parsed.pathname = parsed.pathname.replace(/\/download\/?$/, "");
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    const isRelative = !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
    return isRelative
      ? `${parsed.pathname}${parsed.search}`
      : parsed.toString();
  } catch {
    return trimmed;
  }
}
