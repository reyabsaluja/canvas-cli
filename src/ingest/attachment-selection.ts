import type {
  FileIndexEntry,
  SyllabusCandidate,
  AttachmentSourceType,
} from "./types.js";

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
