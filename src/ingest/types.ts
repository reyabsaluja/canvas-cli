// Normalized types for course ingestion

export interface CourseMetadata {
  id: number;
  name: string;
  courseCode: string;
  termName: string | null;
  startAt: string | null;
  endAt: string | null;
  syllabusBody: string | null;
  htmlUrl: string | null;
}

export interface AssignmentIndexEntry {
  id: number;
  name: string;
  dueAt: string | null;
  unlockAt: string | null;
  lockAt: string | null;
  pointsPossible: number | null;
  gradingType: string;
  submissionTypes: string[];
  htmlUrl: string;
  hasDescription: boolean;
  descriptionLinkCount: number;
}

export interface ModuleIndexEntry {
  id: number;
  name: string;
  position: number;
  itemCount: number;
  items: ModuleItemIndexEntry[];
  /** When the module opens, if it is date-locked. */
  unlockAt?: string | null;
  requireSequentialProgress?: boolean;
  /** Ids of modules that must be completed first. */
  prerequisiteModuleIds?: number[];
}

export interface ModuleItemIndexEntry {
  id: number;
  title: string;
  type: string; // "File" | "Page" | "Assignment" | "ExternalUrl" | "ExternalTool" | "SubHeader" | etc
  position: number;
  contentId: number | null;
  pageUrl: string | null;
  htmlUrl: string | null;
  externalUrl: string | null;
  /** What counts as completing this item ("must_submit", "min_score" with minScore, ...). */
  completionRequirement?: { type: string; minScore: number | null } | null;
}

export interface FileIndexEntry {
  id: number;
  displayName: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  updatedAt: string | null;
  folderId: number | null;
}

export interface PageIndexEntry {
  pageId: string; // Canvas pages use string "url" as ID
  title: string;
  htmlUrl: string | null;
  updatedAt: string | null;
  hasBody: boolean;
}

export interface AnnouncementIndexEntry {
  id: number;
  title: string;
  postedAt: string | null;
  htmlUrl: string;
  userName: string | null;
  hasMessage: boolean;
  messageFileLinkCount: number;
}

export interface DiscussionIndexEntry {
  id: number;
  title: string;
  postedAt: string | null;
  lastReplyAt: string | null;
  htmlUrl: string;
  userName: string | null;
  hasMessage: boolean;
  threadEntryCount: number;
  participantCount: number;
  messageFileLinkCount: number;
  replyFileLinkCount: number;
}

export type ExternalLinkContentStatus = "captured" | "metadata_only" | "failed";

export interface ExternalLinkIndexEntry {
  id: string;
  title: string;
  url: string;
  resolvedUrl: string | null;
  sourceCount: number;
  sources: string[];
  contentType: string | null;
  contentStatus: ExternalLinkContentStatus;
}

export type SyllabusCandidateSource =
  | "syllabus_body"
  | "file"
  | "module_item"
  | "page"
  | "assignment_link";

export interface SyllabusCandidate {
  rank: number;
  source: SyllabusCandidateSource;
  title: string;
  reason: string;
  /** Canvas resource ID where applicable */
  resourceId: number | string | null;
  /** URL to the resource */
  url: string | null;
  /** Confidence: high, medium, low */
  confidence: "high" | "medium" | "low";
}

export type AttachmentSourceType =
  | "syllabus_file"
  | "important_file"
  | "assignment_linked"
  | "module_linked"
  | "page_linked"
  | "course_file"
  /** A file the grader attached to (or linked from) feedback on the student's own submission. */
  | "submission_comment_attachment";

export interface ZipAttachmentEntry {
  /** Path of the entry inside the zip, forward slashes, no leading slash. */
  entryName: string;
  /** Filename only (basename of entryName). */
  filename: string;
  /** Path to the unpacked file on disk, relative to the course directory. */
  localPath: string;
  /** Path to the extracted-text sidecar relative to the course directory, if any. */
  extractedTextPath: string | null;
  /** Uncompressed size in bytes. */
  size: number;
}

export interface DownloadedAttachmentEntry {
  sourceType: AttachmentSourceType;
  canvasFileId: number | null;
  originalFilename: string;
  localPath: string;
  contentType: string | null;
  size: number | null;
  downloadUrl: string;
  reason: string;
  status: "downloaded" | "skipped" | "failed";
  /** For zip attachments: the files unpacked out of the zip during ingestion. */
  zipEntries?: ZipAttachmentEntry[];
}

export interface LectureIndexEntry {
  title: string;
  url: string;
  contentType: "video" | "slides" | "page" | "unknown";
  source: string;
  lectureNumber: number | null;
  topic?: string;
}

export interface IngestionMeta {
  version: number;
  ingestedAt: string;
  courseId: number;
  courseName: string;
  courseCode: string;
  refresh: boolean;
  counts: {
    assignments: number;
    modules: number;
    moduleItems: number;
    files: number;
    pages: number;
    syllabusCandidates: number;
    lectures: number;
    /** Quizzes captured as pages (instructions, time limit, attempts). */
    quizzes?: number;
    /** External tools (LTI tabs such as Piazza, Zoom, Ed) captured on the course-tools page. */
    externalTools?: number;
    /** Assignment groups captured on the grading-scheme page. */
    assignmentGroups?: number;
    attachmentsDownloaded: number;
    attachmentsSkipped: number;
    attachmentsFailed: number;
  };
  /** Files attached directly to assignments (starter code, templates). */
  assignmentAttachments?: {
    selected: number;
    alreadySelected: number;
    skippedTooLarge: number;
    downloaded: number;
    failed: number;
  };
}

export interface IngestionResult {
  courseMeta: CourseMetadata;
  assignments: AssignmentIndexEntry[];
  modules: ModuleIndexEntry[];
  files: FileIndexEntry[];
  pages: PageIndexEntry[];
  announcements?: AnnouncementIndexEntry[];
  discussions?: DiscussionIndexEntry[];
  externalLinks?: ExternalLinkIndexEntry[];
  syllabusCandidates: SyllabusCandidate[];
  attachments: DownloadedAttachmentEntry[];
  lectures: LectureIndexEntry[];
  ingestion: IngestionMeta;
  coursePath: string;
}

// ---------------------------------------------------------------------------
// ADDITIVE: Files-tab crawl (src/ingest/attachment-selection.ts,
// src/ingest/ingest-course.ts). Interface declarations below merge with the
// ones above; nothing earlier in this file should be reordered.
// ---------------------------------------------------------------------------

/** A folder in the course Files area, with its path relative to the root. */
export interface FolderIndexEntry {
  id: number;
  name: string;
  /** Canvas full name, e.g. "course files/Lectures/Week 1". */
  fullName: string;
  /** Path relative to the course root folder, e.g. "Lectures/Week 1" ("" for root). */
  path: string;
  parentFolderId: number | null;
  filesCount: number | null;
}

export interface FileIndexEntry {
  /** Folder path relative to the course root (e.g. "Lectures/Week 1"), when the folder tree was readable. */
  folderPath?: string | null;
}

/** How the Files-tab crawl went for one ingestion. */
export interface CourseFilesCrawlSummary {
  /** Folders visible in the course Files area. */
  folders: number;
  /** Files listed by the Files API. */
  listed: number;
  /** Files selected for download because nothing else had already claimed them. */
  selected: number;
  /** Files already downloaded via modules / syllabus heuristics / HTML links. */
  alreadySelected: number;
  /** Media, images, and other files with no extractable text. */
  skippedUnsupported: number;
  /** Files larger than the download limit. */
  skippedTooLarge: number;
  downloaded: number;
  failed: number;
}

export interface IngestionMeta {
  courseFiles?: CourseFilesCrawlSummary;
}

export interface IngestionResult {
  folders?: FolderIndexEntry[];
}

// ---------------------------------------------------------------------------
// ADDITIVE: discussion thread capture (src/ingest/fetch-course-content.ts,
// src/ingest/ingest-course.ts, src/format/render-ingestion-summary.ts).
// ---------------------------------------------------------------------------

/** How discussion threads were captured for one ingestion. */
export interface DiscussionThreadSummary {
  /** Discussion topics (announcements excluded) whose threads were fetched. */
  topics: number;
  /** Entries captured across all topics, nested replies included. */
  replies: number;
  /** Replies retrieved through GET .../entries/:id/replies because the inline list was truncated. */
  pagedReplies: number;
}

export interface IngestionMeta {
  discussionThreads?: DiscussionThreadSummary;
}

// ---------------------------------------------------------------------------
// ADDITIVE: topic attachments (src/ingest/attachment-selection.ts,
// src/ingest/ingest-course.ts, src/format/render-ingestion-summary.ts).
// ---------------------------------------------------------------------------

/** How files attached to announcements, discussion posts, and replies were captured. */
export interface TopicAttachmentSummary {
  /** Files attached to announcement posts. */
  announcements: number;
  /** Files attached to discussion topic posts. */
  discussions: number;
  /** Files attached to discussion replies. */
  replies: number;
  /** Attached files another selector had already claimed (same Canvas file id or URL). */
  alreadySelected: number;
  /** Attached files larger than the download limit. */
  skippedTooLarge: number;
  downloaded: number;
  failed: number;
}

export interface IngestionMeta {
  topicAttachments?: TopicAttachmentSummary;
}

// ---------------------------------------------------------------------------
// ADDITIVE: submission feedback (src/ingest/fetch-course-content.ts,
// src/ingest/ingest-course.ts, src/ingest/storage.ts,
// src/format/render-ingestion-summary.ts).
// ---------------------------------------------------------------------------

/** How the student's own grader feedback was captured for one ingestion. */
export interface SubmissionFeedbackSummary {
  /** False when the run opted out (`--no-feedback`); nothing was requested then. */
  enabled: boolean;
  /** Submissions returned for the current user. */
  submissions: number;
  /** Grader/peer comments across those submissions. */
  comments: number;
  /** Submissions carrying a rubric assessment. */
  rubricAssessments: number;
  /** Files attached to, or linked from, feedback that were selected for download. */
  attachmentsSelected: number;
  attachmentsDownloaded: number;
  attachmentsFailed: number;
}

export interface IngestionMeta {
  submissionFeedback?: SubmissionFeedbackSummary;
}
