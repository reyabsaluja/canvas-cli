import path from "node:path";
import { slugify, truncateSlug } from "../sanitize.js";

const SESSIONS_DIR = ".canvas-cli/sessions";

/**
 * Generate a deterministic, filesystem-safe slug for an assignment workspace.
 * Format: <course-code>-<assignment-name>-<assignment-id>
 * e.g. "ece297-milestone-3-1710240"
 */
export function makeSessionSlug(
  courseCode: string,
  assignmentName: string,
  assignmentId: number
): string {
  const codePart = slugify(courseCode || "course");
  const namePart = truncateSlug(slugify(assignmentName));
  return `${codePart}-${namePart}-${assignmentId}`;
}

/**
 * Get the absolute workspace path for a session slug.
 */
export function getWorkspacePath(slug: string): string {
  return path.resolve(process.cwd(), SESSIONS_DIR, slug);
}

/**
 * Get the sessions root directory.
 */
export function getSessionsRoot(): string {
  return path.resolve(process.cwd(), SESSIONS_DIR);
}
