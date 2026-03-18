import type { RawCourseContent } from "./fetch-course-content.js";
import type {
  CourseMetadata,
  AssignmentIndexEntry,
  ModuleIndexEntry,
  FileIndexEntry,
  PageIndexEntry,
} from "./types.js";
import { extractLinkedFiles } from "../workspace/attachments.js";

/**
 * Normalize raw Canvas API responses into ingestion index types.
 */
export function normalizeCourseContent(raw: RawCourseContent): {
  courseMeta: CourseMetadata;
  assignments: AssignmentIndexEntry[];
  modules: ModuleIndexEntry[];
  files: FileIndexEntry[];
  pages: PageIndexEntry[];
} {
  const courseMeta: CourseMetadata = {
    id: raw.courseDetail.id,
    name: raw.courseDetail.name ?? "",
    courseCode: raw.courseDetail.course_code ?? "",
    termName: raw.courseDetail.term?.name ?? null,
    startAt: raw.courseDetail.start_at,
    endAt: raw.courseDetail.end_at,
    syllabusBody: raw.courseDetail.syllabus_body ?? null,
    htmlUrl: raw.courseDetail.html_url ?? null,
  };

  // Canvas list endpoint may include description and detail fields as extra props
  const assignments: AssignmentIndexEntry[] = raw.assignments.map((a) => {
    const raw_any = a as any;
    const description: string | null = raw_any.description ?? null;
    const linkCount = description
      ? extractLinkedFiles(description).length
      : 0;
    return {
      id: a.id,
      name: a.name,
      dueAt: a.due_at,
      unlockAt: raw_any.unlock_at ?? null,
      lockAt: raw_any.lock_at ?? null,
      pointsPossible: raw_any.points_possible ?? null,
      gradingType: raw_any.grading_type ?? "none",
      submissionTypes: raw_any.submission_types ?? [],
      htmlUrl: a.html_url,
      hasDescription: !!description,
      descriptionLinkCount: linkCount,
    };
  });

  const modules: ModuleIndexEntry[] = raw.modules.map((m) => ({
    id: m.id,
    name: m.name,
    position: m.position,
    itemCount: m.items.length,
    items: m.items.map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      position: item.position,
      contentId: item.content_id ?? null,
      pageUrl: item.page_url ?? null,
      htmlUrl: item.html_url ?? null,
      externalUrl: item.external_url ?? null,
    })),
  }));

  const files: FileIndexEntry[] = raw.files.map((f) => ({
    id: f.id,
    displayName: f.display_name,
    filename: f.filename,
    contentType: f.content_type,
    size: f.size,
    url: f.url,
    updatedAt: f.updated_at,
    folderId: f.folder_id,
  }));

  const pages: PageIndexEntry[] = raw.pages.map((p) => ({
    pageId: p.url,
    title: p.title,
    htmlUrl: p.html_url,
    updatedAt: p.updated_at,
    hasBody: !!p.body,
  }));

  return { courseMeta, assignments, modules, files, pages };
}
