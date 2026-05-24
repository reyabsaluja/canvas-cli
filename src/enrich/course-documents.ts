import path from "node:path";
import { sanitizeDocumentSegment } from "../sanitize.js";

export function getExtractedSyllabusPath(coursePath: string): string {
  return path.join(coursePath, "extracted", "syllabus-body.txt");
}

export function getExtractedFrontPagePath(coursePath: string): string {
  return path.join(coursePath, "extracted", "front-page.txt");
}

export function getExtractedPagePath(
  coursePath: string,
  pageId: string
): string {
  return path.join(
    coursePath,
    "extracted",
    "pages",
    `${sanitizeDocumentSegment(pageId)}.txt`
  );
}

export function getExtractedAssignmentPath(
  coursePath: string,
  assignmentId: number
): string {
  return path.join(
    coursePath,
    "extracted",
    "assignments",
    `${sanitizeDocumentSegment(String(assignmentId))}.txt`
  );
}

export function getExtractedAnnouncementPath(
  coursePath: string,
  announcementId: number
): string {
  return path.join(
    coursePath,
    "extracted",
    "announcements",
    `${sanitizeDocumentSegment(String(announcementId))}.txt`
  );
}

export function getExtractedDiscussionPath(
  coursePath: string,
  discussionId: number
): string {
  return path.join(
    coursePath,
    "extracted",
    "discussions",
    `${sanitizeDocumentSegment(String(discussionId))}.txt`
  );
}

export function getExtractedExternalLinkPath(
  coursePath: string,
  externalLinkId: string
): string {
  return path.join(
    coursePath,
    "extracted",
    "external-links",
    `${sanitizeDocumentSegment(externalLinkId)}.txt`
  );
}

export function getExtractedAttachmentPath(
  coursePath: string,
  localPath: string
): string {
  const relativeToAttachments = localPath.startsWith("attachments/")
    ? localPath.slice("attachments/".length)
    : localPath;
  return path.join(coursePath, "extracted", "attachments", `${relativeToAttachments}.txt`);
}

/**
 * Directory where the contents of a zip attachment are unpacked during ingestion.
 * Sits next to the original zip in attachments/<subfolder>/<zipname>.unpacked/.
 */
export function getUnpackedZipDir(
  coursePath: string,
  zipLocalPath: string
): string {
  return path.join(coursePath, `${zipLocalPath}.unpacked`);
}

