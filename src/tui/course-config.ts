import fs from "node:fs/promises";
import path from "node:path";

const CONFIG_DIR = ".canvas-cli";
const CONFIG_FILE = "user-courses.json";

/**
 * A user-configured course entry.
 * Stored locally — never touches Canvas.
 */
export interface UserCourse {
  /** Canvas course ID. */
  id: number;
  /** Original Canvas course code. */
  originalCode: string;
  /** Original Canvas course name. */
  originalName: string;
  /** User-chosen display name (may differ from Canvas). */
  displayName: string;
}

export interface CourseConfig {
  courses: UserCourse[];
}

function getConfigPath(): string {
  return path.resolve(process.cwd(), CONFIG_DIR, CONFIG_FILE);
}

/**
 * Load the user's course configuration.
 * Returns null if no config exists (first run).
 */
export async function loadCourseConfig(): Promise<CourseConfig | null> {
  try {
    const content = await fs.readFile(getConfigPath(), "utf-8");
    const parsed = JSON.parse(content);
    if (parsed && Array.isArray(parsed.courses)) {
      return parsed as CourseConfig;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Save the user's course configuration.
 */
export async function saveCourseConfig(config: CourseConfig): Promise<void> {
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Add courses to the config. Skips duplicates.
 */
export function addCourses(config: CourseConfig, courses: UserCourse[]): CourseConfig {
  const existingIds = new Set(config.courses.map((c) => c.id));
  const newCourses = courses.filter((c) => !existingIds.has(c.id));
  return { courses: [...config.courses, ...newCourses] };
}

/**
 * Remove a course from the config by ID.
 */
export function removeCourse(config: CourseConfig, courseId: number): CourseConfig {
  return { courses: config.courses.filter((c) => c.id !== courseId) };
}

/**
 * Rename a course in the config.
 */
export function renameCourse(
  config: CourseConfig,
  courseId: number,
  newName: string
): CourseConfig {
  return {
    courses: config.courses.map((c) =>
      c.id === courseId ? { ...c, displayName: newName } : c
    ),
  };
}
