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
  | "module_linked";

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
}

export interface LectureIndexEntry {
  title: string;
  url: string;
  contentType: "video" | "slides" | "page" | "unknown";
  source: string;
  lectureNumber: number | null;
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
  syllabusCandidates: SyllabusCandidate[];
  attachments: DownloadedAttachmentEntry[];
  lectures: LectureIndexEntry[];
  ingestion: IngestionMeta;
  coursePath: string;
}
