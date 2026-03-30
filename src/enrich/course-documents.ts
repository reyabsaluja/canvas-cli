import path from "node:path";

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

export function getExtractedAttachmentPath(
  coursePath: string,
  localPath: string
): string {
  const relativeToAttachments = localPath.startsWith("attachments/")
    ? localPath.slice("attachments/".length)
    : localPath;
  return path.join(coursePath, "extracted", "attachments", `${relativeToAttachments}.txt`);
}

function sanitizeDocumentSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
