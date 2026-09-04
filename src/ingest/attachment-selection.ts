import type {
  FileIndexEntry,
  SyllabusCandidate,
  AttachmentSourceType,
  CourseFilesCrawlSummary,
  FolderIndexEntry,
  TopicAttachmentSummary,
} from "./types.js";
import type {
  CanvasDiscussionEntry,
  CanvasDiscussionTopic,
  CanvasFolder,
  CanvasTopicAttachment,
} from "../canvas/types.js";
import { DEFAULT_MAX_DOWNLOAD_BYTES } from "../canvas/safe-download.js";

/**
 * Heuristic patterns for identifying important course documents by filename.
 *
 * These are files worth downloading even if they aren't syllabus candidates,
 * because they contain high-signal course information.
 */
const IMPORTANT_FILE_PATTERNS: Array<{
  pattern: RegExp;
  reason: string;
}> = [
  { pattern: /\bsyllabus\b/i, reason: "filename contains 'syllabus'" },
  { pattern: /\bcourse\s*outline\b/i, reason: "filename contains 'course outline'" },
  { pattern: /\bschedule\b/i, reason: "filename contains 'schedule'" },
  { pattern: /\brubric\b/i, reason: "filename contains 'rubric'" },
  { pattern: /\binstructions?\b/i, reason: "filename contains 'instructions'" },
  { pattern: /\bhandbook\b/i, reason: "filename contains 'handbook'" },
  { pattern: /\bgrading\b/i, reason: "filename contains 'grading'" },
  { pattern: /\bpolicy\b/i, reason: "filename contains 'policy'" },
  { pattern: /\bguidelines?\b/i, reason: "filename contains 'guidelines'" },
];

/** Max number of important files to download beyond syllabus candidates. */
const MAX_IMPORTANT_FILES = 10;

export interface SelectedAttachment {
  sourceType: AttachmentSourceType;
  fileId: number | null;
  filename: string;
  downloadUrl: string;
  reason: string;
  contentType: string | null;
  size: number | null;
  /** Subfolder under attachments/ */
  subfolder: string;
}

/**
 * Select which files to download based on syllabus candidates and importance heuristics.
 *
 * Strategy:
 * 1. Download files referenced by high-confidence syllabus candidates
 * 2. Download files matching important-document heuristics
 * 3. Cap total downloads to avoid fetching the entire course
 */
export function selectAttachments(
  syllabusCandidates: SyllabusCandidate[],
  files: FileIndexEntry[]
): SelectedAttachment[] {
  const selected: SelectedAttachment[] = [];
  const selectedFileIds = new Set<number>();

  // 1. Syllabus candidate files (high and medium confidence)
  for (const candidate of syllabusCandidates) {
    if (candidate.source !== "file") continue;
    if (candidate.confidence === "low") continue;

    const fileId = candidate.resourceId as number;
    const file = files.find((f) => f.id === fileId);
    if (!file) continue;

    if (selectedFileIds.has(file.id)) continue;
    selectedFileIds.add(file.id);

    selected.push({
      sourceType: "syllabus_file",
      fileId: file.id,
      filename: file.displayName,
      downloadUrl: file.url,
      reason: candidate.reason,
      contentType: file.contentType,
      size: file.size,
      subfolder: "syllabus",
    });
  }

  // 2. Important files by filename heuristic
  let importantCount = 0;
  for (const file of files) {
    if (selectedFileIds.has(file.id)) continue;
    if (importantCount >= MAX_IMPORTANT_FILES) break;

    const match = matchImportantFile(file.displayName);
    if (!match) continue;

    selectedFileIds.add(file.id);
    importantCount++;

    selected.push({
      sourceType: "important_file",
      fileId: file.id,
      filename: file.displayName,
      downloadUrl: file.url,
      reason: match.reason,
      contentType: file.contentType,
      size: file.size,
      subfolder: "important",
    });
  }

  return selected;
}

function matchImportantFile(
  filename: string
): { reason: string } | null {
  for (const { pattern, reason } of IMPORTANT_FILE_PATTERNS) {
    if (pattern.test(filename)) {
      return { reason };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Files-tab crawl
//
// Instructors frequently upload lecture decks, readings, and handouts straight
// into the course Files area without ever linking them from a module or page.
// The heuristics above only pick a handful of "important" documents; this crawl
// downloads every remaining readable document, preserving the folder layout so
// same-named files in different weeks do not collide.
// ---------------------------------------------------------------------------

/** Upper bound on Files-tab documents downloaded per course. */
export const MAX_COURSE_FILES = 1000;
/** Files above this size are recorded but not downloaded. */
export const MAX_COURSE_FILE_BYTES = DEFAULT_MAX_DOWNLOAD_BYTES;

/**
 * Extensions worth downloading: anything we can extract text from now, plus
 * office documents and archives that are still useful to open on demand.
 * Media, images, fonts, and executables are skipped — no readable payoff.
 */
const DOWNLOADABLE_EXTENSIONS = new Set([
  ".pdf", ".txt", ".md", ".markdown", ".rst", ".csv", ".tsv", ".json", ".xml",
  ".html", ".htm", ".tex", ".bib", ".rtf",
  ".doc", ".docx", ".odt", ".ppt", ".pptx", ".odp", ".xls", ".xlsx", ".ods",
  ".ipynb", ".py", ".c", ".h", ".cpp", ".hpp", ".cc", ".java", ".js", ".ts",
  ".s", ".asm", ".sql", ".r", ".m", ".sh", ".v", ".vhd", ".vhdl", ".go", ".rs",
  ".zip",
]);

const DOWNLOADABLE_CONTENT_TYPE_RE =
  /^(text\/|application\/(pdf|json|xml|zip|x-zip-compressed|msword|rtf|x-tex|x-latex|x-ipynb\+json|vnd\.openxmlformats-officedocument|vnd\.ms-(powerpoint|excel|word)|vnd\.oasis\.opendocument))/i;

const SKIPPED_CONTENT_TYPE_RE = /^(image|audio|video|font)\//i;

const ROOT_FOLDER_RE = /^course files(?:\/|$)/i;

export function isDownloadableCourseFile(file: FileIndexEntry): boolean {
  const contentType = (file.contentType ?? "").toLowerCase();
  if (SKIPPED_CONTENT_TYPE_RE.test(contentType)) return false;
  const name = file.displayName || file.filename || "";
  const ext = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  if (DOWNLOADABLE_EXTENSIONS.has(ext)) return true;
  return DOWNLOADABLE_CONTENT_TYPE_RE.test(contentType);
}

/** Convert the raw Canvas folder list into index entries with root-relative paths. */
export function buildFolderIndex(folders: CanvasFolder[]): FolderIndexEntry[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const entries: FolderIndexEntry[] = [];

  for (const folder of folders) {
    let relativePath: string;
    const fullName = (folder.full_name ?? "").replace(/^\/+|\/+$/g, "");
    if (fullName.length > 0) {
      relativePath = fullName.replace(ROOT_FOLDER_RE, "");
    } else {
      // Reconstruct from parent chain when full_name is missing.
      const segments: string[] = [];
      let current: CanvasFolder | undefined = folder;
      const seen = new Set<number>();
      while (current && current.parent_folder_id !== null && !seen.has(current.id)) {
        seen.add(current.id);
        segments.unshift(current.name);
        current = byId.get(current.parent_folder_id);
      }
      relativePath = segments.join("/");
    }

    entries.push({
      id: folder.id,
      name: folder.name,
      fullName: folder.full_name ?? folder.name,
      path: relativePath,
      parentFolderId: folder.parent_folder_id ?? null,
      filesCount: typeof folder.files_count === "number" ? folder.files_count : null,
    });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

export interface CourseFileSelection {
  selected: SelectedAttachment[];
  summary: Omit<CourseFilesCrawlSummary, "downloaded" | "failed">;
}

/**
 * Select every readable document from the Files tab that has not already been
 * claimed by another selector. Files are stored under
 * attachments/files/<folder path>/<name> so the instructor's organisation
 * survives, and the reason records the folder for downstream grounding.
 */
export function selectCourseFiles(
  files: FileIndexEntry[],
  folders: FolderIndexEntry[],
  alreadySelected: SelectedAttachment[]
): CourseFileSelection {
  const folderPathById = new Map(folders.map((folder) => [folder.id, folder.path]));
  const claimedIds = new Set<number>();
  const claimedUrls = new Set<string>();
  for (const attachment of alreadySelected) {
    if (attachment.fileId !== null) claimedIds.add(attachment.fileId);
    claimedUrls.add(attachment.downloadUrl);
    const idFromUrl = attachment.downloadUrl.match(/\/files\/(\d+)/)?.[1];
    if (idFromUrl) claimedIds.add(parseInt(idFromUrl, 10));
  }

  const summary: CourseFileSelection["summary"] = {
    folders: folders.length,
    listed: files.length,
    selected: 0,
    alreadySelected: 0,
    skippedUnsupported: 0,
    skippedTooLarge: 0,
  };

  const candidates = files
    .map((file) => ({
      file,
      folderPath: file.folderPath ?? (file.folderId !== null ? folderPathById.get(file.folderId) ?? null : null),
    }))
    .sort((a, b) => {
      const pathCompare = (a.folderPath ?? "").localeCompare(b.folderPath ?? "");
      if (pathCompare !== 0) return pathCompare;
      return a.file.displayName.localeCompare(b.file.displayName);
    });

  const selected: SelectedAttachment[] = [];
  for (const { file, folderPath } of candidates) {
    if (claimedIds.has(file.id) || claimedUrls.has(file.url)) {
      summary.alreadySelected += 1;
      continue;
    }
    if (!isDownloadableCourseFile(file)) {
      summary.skippedUnsupported += 1;
      continue;
    }
    if (typeof file.size === "number" && file.size > MAX_COURSE_FILE_BYTES) {
      summary.skippedTooLarge += 1;
      continue;
    }
    if (selected.length >= MAX_COURSE_FILES) {
      break;
    }

    claimedIds.add(file.id);
    claimedUrls.add(file.url);
    const folderLabel = folderPath && folderPath.length > 0 ? folderPath : null;
    selected.push({
      sourceType: "course_file",
      fileId: file.id,
      filename: file.displayName || file.filename,
      downloadUrl: file.url,
      reason: folderLabel
        ? `course file in Files folder "${folderLabel}"`
        : "course file in Files tab",
      contentType: file.contentType,
      size: file.size,
      subfolder: folderLabel ? `files/${folderLabel}` : "files",
    });
  }
  summary.selected = selected.length;

  return { selected, summary };
}

// ---------------------------------------------------------------------------
// Topic attachments
//
// Instructors often attach the actual handout to an announcement (the Canvas
// "Attach" button) instead of linking it in the message body, and TAs attach
// files to replies. Those files appear only in the topic's `attachments[]` /
// the entry's `attachment` field, never as an <a> in the HTML, so the HTML
// link selectors above cannot see them.
// ---------------------------------------------------------------------------

export interface TopicAttachmentSelection {
  selected: SelectedAttachment[];
  summary: Omit<TopicAttachmentSummary, "downloaded" | "failed">;
}

function attachmentContentType(attachment: CanvasTopicAttachment): string | null {
  return attachment["content-type"] ?? attachment.content_type ?? null;
}

function attachmentName(attachment: CanvasTopicAttachment): string {
  return (
    attachment.display_name ||
    attachment.filename ||
    `file-${attachment.id}`
  );
}

/**
 * Select every file attached to an announcement, discussion post, or reply
 * that no other selector has claimed. Announcement files land under
 * attachments/announcements, discussion and reply files under
 * attachments/discussions; the reason names the post so grounding can say
 * where the file came from.
 */
export function selectTopicAttachments(
  announcements: CanvasDiscussionTopic[],
  discussionThreads: Array<{
    topic: CanvasDiscussionTopic;
    entries: CanvasDiscussionEntry[];
  }>,
  alreadySelected: SelectedAttachment[]
): TopicAttachmentSelection {
  const claimedIds = new Set<number>();
  const claimedUrls = new Set<string>();
  for (const attachment of alreadySelected) {
    if (attachment.fileId !== null) claimedIds.add(attachment.fileId);
    claimedUrls.add(attachment.downloadUrl);
    const idFromUrl = attachment.downloadUrl.match(/\/files\/(\d+)/)?.[1];
    if (idFromUrl) claimedIds.add(parseInt(idFromUrl, 10));
  }

  const summary: TopicAttachmentSelection["summary"] = {
    announcements: 0,
    discussions: 0,
    replies: 0,
    alreadySelected: 0,
    skippedTooLarge: 0,
  };
  const selected: SelectedAttachment[] = [];

  const consider = (
    attachment: CanvasTopicAttachment | null | undefined,
    kind: "announcements" | "discussions" | "replies",
    subfolder: string,
    reason: string
  ): void => {
    if (!attachment || typeof attachment.url !== "string" || attachment.url.length === 0) {
      return;
    }
    if (claimedIds.has(attachment.id) || claimedUrls.has(attachment.url)) {
      summary.alreadySelected += 1;
      return;
    }
    if (typeof attachment.size === "number" && attachment.size > MAX_COURSE_FILE_BYTES) {
      summary.skippedTooLarge += 1;
      return;
    }
    claimedIds.add(attachment.id);
    claimedUrls.add(attachment.url);
    summary[kind] += 1;
    selected.push({
      sourceType: "page_linked",
      fileId: attachment.id,
      filename: attachmentName(attachment),
      downloadUrl: attachment.url,
      reason,
      contentType: attachmentContentType(attachment),
      size: typeof attachment.size === "number" ? attachment.size : null,
      subfolder,
    });
  };

  for (const announcement of announcements) {
    for (const attachment of announcement.attachments ?? []) {
      consider(
        attachment,
        "announcements",
        "announcements",
        `attached to announcement "${announcement.title}"`
      );
    }
  }

  for (const thread of discussionThreads) {
    const { topic } = thread;
    for (const attachment of topic.attachments ?? []) {
      consider(
        attachment,
        "discussions",
        "discussions",
        `attached to discussion "${topic.title}"`
      );
    }
    for (const entry of thread.entries) {
      const author = entry.user_name ?? `User ${entry.user_id}`;
      consider(
        entry.attachment,
        "replies",
        "discussions",
        `attached to reply by ${author} in "${topic.title}"`
      );
    }
  }

  return { selected, summary };
}

export interface AssignmentAttachmentSelection {
  selected: SelectedAttachment[];
  summary: { assignments: number; alreadySelected: number; skippedTooLarge: number };
}

interface AssignmentWithAttachments {
  id: number;
  name: string;
  attachments?: Array<{
    id: number;
    display_name?: string | null;
    filename?: string | null;
    url?: string | null;
    content_type?: string | null;
    "content-type"?: string | null;
    size?: number | null;
  }> | null;
}

/**
 * Files attached to an assignment through the Canvas "Attach" control
 * (starter code, templates, data sets). They are not linked from the
 * description HTML, so no other selector sees them.
 */
export function selectAssignmentAttachments(
  assignments: AssignmentWithAttachments[],
  alreadySelected: SelectedAttachment[]
): AssignmentAttachmentSelection {
  const claimedIds = new Set<number>();
  const claimedUrls = new Set<string>();
  for (const attachment of alreadySelected) {
    if (attachment.fileId !== null) claimedIds.add(attachment.fileId);
    claimedUrls.add(attachment.downloadUrl);
    const idFromUrl = attachment.downloadUrl.match(/\/files\/(\d+)/)?.[1];
    if (idFromUrl) claimedIds.add(parseInt(idFromUrl, 10));
  }
  const summary = { assignments: 0, alreadySelected: 0, skippedTooLarge: 0 };
  const selected: SelectedAttachment[] = [];
  for (const assignment of assignments) {
    for (const attachment of assignment.attachments ?? []) {
      const url = typeof attachment.url === "string" ? attachment.url : "";
      if (!url) continue;
      if (claimedIds.has(attachment.id) || claimedUrls.has(url)) {
        summary.alreadySelected += 1;
        continue;
      }
      if (typeof attachment.size === "number" && attachment.size > MAX_COURSE_FILE_BYTES) {
        summary.skippedTooLarge += 1;
        continue;
      }
      claimedIds.add(attachment.id);
      claimedUrls.add(url);
      summary.assignments += 1;
      selected.push({
        sourceType: "assignment_linked",
        fileId: attachment.id,
        filename: attachment.display_name?.trim() || attachment.filename?.trim() || `file-${attachment.id}`,
        downloadUrl: url,
        reason: `attached to assignment "${assignment.name}"`,
        contentType: attachment.content_type ?? attachment["content-type"] ?? null,
        size: typeof attachment.size === "number" ? attachment.size : null,
        subfolder: "assignments",
      });
    }
  }
  return { selected, summary };
}
