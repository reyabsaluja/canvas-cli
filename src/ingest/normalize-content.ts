import type { RawCourseContent } from "./fetch-course-content.js";
import type {
  CourseMetadata,
  AssignmentIndexEntry,
  ModuleIndexEntry,
  FileIndexEntry,
  PageIndexEntry,
  AnnouncementIndexEntry,
  DiscussionIndexEntry,
} from "./types.js";
import { extractLinkedFiles } from "../workspace/attachments.js";
import { stripControlChars } from "../sanitize.js";

/**
 * Normalize raw Canvas API responses into ingestion index types.
 */
export function normalizeCourseContent(raw: RawCourseContent): {
  courseMeta: CourseMetadata;
  assignments: AssignmentIndexEntry[];
  modules: ModuleIndexEntry[];
  files: FileIndexEntry[];
  pages: PageIndexEntry[];
  announcements: AnnouncementIndexEntry[];
  discussions: DiscussionIndexEntry[];
} {
  const courseMeta: CourseMetadata = {
    id: raw.courseDetail.id,
    name: stripControlChars(raw.courseDetail.name ?? ""),
    courseCode: stripControlChars(raw.courseDetail.course_code ?? ""),
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
      name: stripControlChars(a.name),
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
    name: stripControlChars(m.name),
    position: m.position,
    itemCount: m.items.length,
    items: m.items.map((item) => ({
      id: item.id,
      title: stripControlChars(item.title),
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
    displayName: stripControlChars(f.display_name),
    filename: stripControlChars(f.filename),
    contentType: f.content_type,
    size: f.size,
    url: f.url,
    updatedAt: f.updated_at,
    folderId: f.folder_id,
  }));

  const pagesById = new Map<string, PageIndexEntry>();
  for (const page of raw.pages) {
    pagesById.set(page.url, {
      pageId: page.url,
      title: stripControlChars(page.title),
      htmlUrl: page.html_url,
      updatedAt: page.updated_at,
      hasBody: !!page.body,
    });
  }

  const courseHtmlUrl = raw.courseDetail.html_url?.replace(/\/$/, "") ?? null;
  for (const fetchedPage of raw.fetchedPages) {
    const existing = pagesById.get(fetchedPage.slug);
    pagesById.set(fetchedPage.slug, {
      pageId: fetchedPage.slug,
      title: existing?.title ?? stripControlChars(fetchedPage.title),
      htmlUrl:
        existing?.htmlUrl ??
        (courseHtmlUrl
          ? `${courseHtmlUrl}/pages/${encodeURIComponent(fetchedPage.slug)}`
          : null),
      updatedAt: existing?.updatedAt ?? null,
      hasBody: true,
    });
  }

  const pages = Array.from(pagesById.values());

  const announcements: AnnouncementIndexEntry[] = raw.announcements.map(
    (announcement) => ({
      id: announcement.id,
      title: stripControlChars(announcement.title),
      postedAt: announcement.posted_at,
      htmlUrl: announcement.html_url,
      userName: announcement.user_name,
      hasMessage:
        typeof announcement.message === "string" &&
        announcement.message.length > 0,
      messageFileLinkCount:
        typeof announcement.message === "string"
          ? extractLinkedFiles(announcement.message).length
          : 0,
    })
  );

  const threadByTopicId = new Map(
    raw.discussionThreads.map((thread) => [thread.topic.id, thread])
  );
  const discussions: DiscussionIndexEntry[] = raw.discussions.map((topic) => {
    const thread = threadByTopicId.get(topic.id);
    const replyFileLinkCount = (thread?.entries ?? []).reduce((count, entry) => {
      if (typeof entry.message !== "string") {
        return count;
      }
      return count + extractLinkedFiles(entry.message).length;
    }, 0);

    return {
      id: topic.id,
      title: stripControlChars(topic.title),
      postedAt: topic.posted_at,
      lastReplyAt: topic.last_reply_at,
      htmlUrl: topic.html_url,
      userName: topic.user_name,
      hasMessage: typeof topic.message === "string" && topic.message.length > 0,
      threadEntryCount: thread?.entries.length ?? 0,
      participantCount: thread?.participantCount ?? 0,
      messageFileLinkCount:
        typeof topic.message === "string"
          ? extractLinkedFiles(topic.message).length
          : 0,
      replyFileLinkCount,
    };
  });

  return {
    courseMeta,
    assignments,
    modules,
    files,
    pages,
    announcements,
    discussions,
  };
}
