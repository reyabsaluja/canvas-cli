import { CanvasClient } from "../../canvas/client.js";
import { loadConfig } from "../../config/env.js";
import { getAIConfig } from "../../ai/provider.js";
import { normalizeAssignment, normalizeCourse } from "../../domain/normalize.js";
import { filterRelevantAssignments } from "../../domain/assignment-relevance.js";
import { sortByUrgency } from "../../domain/sorting.js";
import type { Course, Assignment } from "../../domain/models.js";
import type { AppServices, DisplayCourseAvailability } from "./types.js";

export async function initServices(): Promise<AppServices> {
  const config = loadConfig();
  const client = new CanvasClient(config);
  const aiConfig = getAIConfig();
  const rawCourses = await client.getCourses();
  const allCourses = rawCourses
    .map(normalizeCourse)
    .filter((course) => course.isCurrent);

  return {
    config,
    client,
    aiConfig,
    rawCourses,
    allCourses,
    courseConfig: null,
    assignmentCache: new Map(),
  };
}

/**
 * Get the display courses — user-configured with custom names.
 * Returns empty array if no courses configured (user must add via Manage courses).
 * Only falls back to allCourses if courseConfig is null (pre-setup state).
 */
export function getDisplayCourses(services: AppServices): Course[] {
  return getDisplayCourseAvailability(services).available;
}

export function getDisplayCourseAvailability(
  services: AppServices
): DisplayCourseAvailability {
  if (!services.courseConfig) {
    return {
      available: services.allCourses,
      unavailable: [],
    };
  }

  const allCoursesById = new Map(
    services.allCourses.map((course) => [course.id, course] as const)
  );
  const available: Course[] = [];
  const unavailable = [];

  for (const configuredCourse of services.courseConfig.courses) {
    const original = allCoursesById.get(configuredCourse.id);
    if (!original) {
      unavailable.push(configuredCourse);
      continue;
    }
    available.push({
      id: configuredCourse.id,
      name: configuredCourse.displayName,
      courseCode: configuredCourse.originalCode,
      termName: original.termName,
      isCurrent: original.isCurrent,
    });
  }

  return { available, unavailable };
}

export function getUnavailableConfiguredCourses(
  services: AppServices
) {
  return getDisplayCourseAvailability(services).unavailable;
}

/**
 * Fetch assignments for a course, filtered and sorted.
 */
export async function fetchAssignments(
  services: AppServices,
  courseId: number,
  courseName: string
): Promise<Assignment[]> {
  const cached = services.assignmentCache.get(courseId);
  if (cached && cached.courseName === courseName) {
    return cached.assignmentsPromise;
  }

  const assignmentsPromise = services.client
    .getAssignments(courseId)
    .then((raw) => {
      const normalized = raw.map((assignment) =>
        normalizeAssignment(assignment, courseName)
      );
      const filtered = filterRelevantAssignments(normalized, { all: true });
      return sortByUrgency(filtered);
    })
    .catch((error) => {
      const current = services.assignmentCache.get(courseId);
      if (current?.assignmentsPromise === assignmentsPromise) {
        services.assignmentCache.delete(courseId);
      }
      throw error;
    });

  services.assignmentCache.set(courseId, {
    courseName,
    assignmentsPromise,
  });
  return assignmentsPromise;
}

export function invalidateAssignmentCache(
  services: AppServices,
  courseId?: number
): void {
  if (typeof courseId === "number") {
    services.assignmentCache.delete(courseId);
    return;
  }
  services.assignmentCache.clear();
}

export function getCourseById(
  services: AppServices,
  courseId: number
): Course | null {
  return getDisplayCourses(services).find((course) => course.id === courseId) ?? null;
}

export function getCourseDisplayName(
  services: AppServices,
  courseId: number
): string | null {
  const configured = services.courseConfig?.courses.find(
    (course) => course.id === courseId
  );
  if (configured) return configured.displayName;
  return services.allCourses.find((course) => course.id === courseId)?.name ?? null;
}

export async function fetchUpcomingAssignments(
  services: AppServices,
  limit: number = 12
): Promise<Assignment[]> {
  const courses = getDisplayCourses(services);
  const allAssignments = await Promise.all(
    courses.map(async (course) => {
      try {
        return await fetchAssignments(services, course.id, course.name);
      } catch {
        return [];
      }
    })
  );

  return sortByUrgency(
    allAssignments
      .flat()
      .filter((assignment) => !assignment.submitted)
  ).slice(0, limit);
}

/**
 * Format a due date for compact display.
 */
export function formatDueCompact(dueAt: Date | null): string {
  if (!dueAt) return "no due date";
  const now = new Date();
  const diffMs = dueAt.getTime() - now.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return `overdue by ${Math.abs(diffDays)}d`;
  if (diffDays === 0) return "due today";
  if (diffDays === 1) return "due tomorrow";
  if (diffDays <= 7) return `due in ${diffDays}d`;
  return `due ${dueAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}
