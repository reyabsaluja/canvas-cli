import path from "node:path";

const COURSES_DIR = ".canvas-cli/courses";

/**
 * Generate a deterministic, filesystem-safe slug for a course.
 * Format: <course-code>-<course-id>
 * e.g. "ece297-420471"
 */
export function makeCourseSlug(courseCode: string, courseId: number): string {
  const codePart = slugify(courseCode || "course");
  return `${codePart}-${courseId}`;
}

/**
 * Get the absolute path for a course ingestion directory.
 */
export function getCoursePath(slug: string): string {
  return path.resolve(process.cwd(), COURSES_DIR, slug);
}

/**
 * Get the courses root directory.
 */
export function getCoursesRoot(): string {
  return path.resolve(process.cwd(), COURSES_DIR);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}
