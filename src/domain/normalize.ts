import type {
  CanvasAssignment,
  CanvasAssignmentDetail,
  CanvasCourse,
} from "../canvas/types.js";
import type {
  Assignment,
  AssignmentDetail,
  AssignmentStatus,
  Course,
} from "./models.js";
import { isCourseRelevant } from "./course-relevance.js";

export function normalizeCourse(raw: CanvasCourse): Course {
  return {
    id: raw.id,
    name: raw.name ?? "",
    courseCode: raw.course_code ?? "",
    termName: raw.term?.name ?? null,
    publicDescription: raw.public_description?.trim() || null,
    isCurrent: isCourseRelevant(raw),
  };
}

function isSubmitted(raw: CanvasAssignment): boolean {
  if (!raw.submission) return false;
  const state = raw.submission.workflow_state;
  return state === "submitted" || state === "graded";
}

function deriveStatus(raw: CanvasAssignment): AssignmentStatus {
  if (isSubmitted(raw)) return "submitted";
  if (!raw.due_at) return "no_date";
  const due = new Date(raw.due_at);
  if (due < new Date()) return "overdue";
  return "upcoming";
}

export function normalizeAssignment(
  raw: CanvasAssignment,
  courseName: string
): Assignment {
  return {
    id: raw.id,
    name: raw.name,
    courseId: raw.course_id,
    courseName,
    dueAt: raw.due_at ? new Date(raw.due_at) : null,
    submitted: isSubmitted(raw),
    status: deriveStatus(raw),
    htmlUrl: raw.html_url,
  };
}

export function normalizeAssignmentDetail(
  raw: CanvasAssignmentDetail,
  courseName: string
): AssignmentDetail {
  const base = normalizeAssignment(raw, courseName);
  return {
    ...base,
    description: raw.description ?? null,
    unlockAt: raw.unlock_at ? new Date(raw.unlock_at) : null,
    lockAt: raw.lock_at ? new Date(raw.lock_at) : null,
    pointsPossible: raw.points_possible ?? null,
    gradingType: raw.grading_type ?? "none",
    submissionTypes: raw.submission_types ?? [],
    allowedExtensions: raw.allowed_extensions ?? null,
    submittedAt: raw.submission?.submitted_at
      ? new Date(raw.submission.submitted_at)
      : null,
    score: raw.submission?.score ?? null,
    grade: raw.submission?.grade ?? null,
    late: raw.submission?.late ?? false,
    missing: raw.submission?.missing ?? false,
    attachments: (raw.attachments ?? [])
      .filter((a) => !!a.url)
      .map((a) => {
        const filename = a.filename || a.display_name || `attachment-${a.id}`;
        return {
          id: a.id,
          displayName: a.display_name || filename,
          filename,
          url: a.url!,
          contentType: a.content_type ?? "",
          size: a.size ?? 0,
        };
      }),
  };
}
