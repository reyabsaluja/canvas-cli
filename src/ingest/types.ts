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

export interface QuizIndexEntry {
  id: number;
  title: string;
  quizType: string | null;
  dueAt: string | null;
  unlockAt: string | null;
  lockAt: string | null;
  pointsPossible: number | null;
  questionCount: number | null;
  timeLimit: number | null;
  allowedAttempts: number | null;
  published: boolean | null;
  htmlUrl: string | null;
  assignmentId: number | null;
  hasDescription: boolean;
  descriptionLinkCount: number;
}

export interface CalendarEventIndexEntry {
  id: number;
  title: string;
  startAt: string | null;
  endAt: string | null;
  allDay: boolean | null;
  locationName: string | null;
  locationAddress: string | null;
  htmlUrl: string | null;
  workflowState: string | null;
  hasDescription: boolean;
  descriptionLinkCount: number;
}

export interface AnnouncementIndexEntry {
  id: number;
  title: string;
  postedAt: string | null;
  htmlUrl: string;
  userName: string | null;
  hasMessage: boolean;
  messageFileLinkCount: number;
  threadEntryCount: number;
  participantCount: number;
  replyFileLinkCount: number;
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
  | "assignment_attachment"
  | "announcement_attachment"
  | "discussion_attachment"
  | "assignment_linked"
  | "quiz_linked"
  | "calendar_event_linked"
  | "module_linked"
  | "page_linked";

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

export interface GradingGroupIndexEntry {
  id: number;
  name: string;
  weight: number;
  assignmentCount: number;
  assignmentNames: string[];
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
    attachmentsDownloaded: number;
    attachmentsSkipped: number;
    attachmentsFailed: number;
  };
}

export interface IngestionResult {
  courseMeta: CourseMetadata;
  assignments: AssignmentIndexEntry[];
  modules: ModuleIndexEntry[];
  files: FileIndexEntry[];
  pages: PageIndexEntry[];
  quizzes?: QuizIndexEntry[];
  calendarEvents?: CalendarEventIndexEntry[];
  announcements?: AnnouncementIndexEntry[];
  discussions?: DiscussionIndexEntry[];
  externalLinks?: ExternalLinkIndexEntry[];
  gradingGroups?: GradingGroupIndexEntry[];
  syllabusCandidates: SyllabusCandidate[];
  attachments: DownloadedAttachmentEntry[];
  lectures: LectureIndexEntry[];
  ingestion: IngestionMeta;
  coursePath: string;
}
