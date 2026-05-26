import type { RawCourseContent } from "./fetch-course-content.js";
import type {
  CourseMetadata,
  AssignmentIndexEntry,
  ModuleIndexEntry,
  FileIndexEntry,
  PageIndexEntry,
  QuizIndexEntry,
  CalendarEventIndexEntry,
  AnnouncementIndexEntry,
  DiscussionIndexEntry,
  GradingGroupIndexEntry,
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
  quizzes: QuizIndexEntry[];
  calendarEvents: CalendarEventIndexEntry[];
  announcements: AnnouncementIndexEntry[];
  discussions: DiscussionIndexEntry[];
  gradingGroups: GradingGroupIndexEntry[];
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

  const pagesById = new Map<string, PageIndexEntry>();
  for (const page of raw.pages) {
    pagesById.set(page.url, {
      pageId: page.url,
      title: page.title,
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
      title: existing?.title ?? fetchedPage.title,
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

  const quizzes: QuizIndexEntry[] = raw.quizzes.map((quiz) => {
    const description =
      typeof quiz.description === "string" ? quiz.description : null;
    return {
      id: quiz.id,
      title: quiz.title,
      quizType: quiz.quiz_type ?? null,
      dueAt: quiz.due_at ?? null,
      unlockAt: quiz.unlock_at ?? null,
      lockAt: quiz.lock_at ?? null,
      pointsPossible: quiz.points_possible ?? null,
      questionCount: quiz.question_count ?? null,
      timeLimit: quiz.time_limit ?? null,
      allowedAttempts: quiz.allowed_attempts ?? null,
      published: quiz.published ?? null,
      htmlUrl: quiz.html_url ?? null,
      assignmentId: quiz.assignment_id ?? null,
      hasDescription: !!description,
      descriptionLinkCount: description
        ? extractLinkedFiles(description).length
        : 0,
    };
  });

  const calendarEvents: CalendarEventIndexEntry[] = raw.calendarEvents.map(
    (event) => {
      const description =
        typeof event.description === "string" ? event.description : null;
      return {
        id: event.id,
        title: event.title,
        startAt: event.start_at ?? null,
        endAt: event.end_at ?? null,
        allDay: event.all_day ?? null,
        locationName: event.location_name ?? null,
        locationAddress: event.location_address ?? null,
        htmlUrl: event.html_url ?? null,
        workflowState: event.workflow_state ?? null,
        hasDescription: !!description,
        descriptionLinkCount: description
          ? extractLinkedFiles(description).length
          : 0,
      };
    }
  );

  const announcementThreadByTopicId = new Map(
    raw.announcementThreads.map((thread) => [thread.topic.id, thread])
  );
  const announcements: AnnouncementIndexEntry[] = raw.announcements.map(
    (announcement) => {
      const thread = announcementThreadByTopicId.get(announcement.id);
      const replyFileLinkCount = (thread?.entries ?? []).reduce(
        (count, entry) => {
          if (typeof entry.message !== "string") {
            return count;
          }
          return count + extractLinkedFiles(entry.message).length;
        },
        0
      );

      return {
        id: announcement.id,
        title: announcement.title,
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
        threadEntryCount: thread?.entries.length ?? 0,
        participantCount: thread?.participantCount ?? 0,
        replyFileLinkCount,
      };
    }
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
      title: topic.title,
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

  const gradingGroups: GradingGroupIndexEntry[] = raw.assignmentGroups.map(
    (group) => {
      const groupAssignments = group.assignments ?? [];
      return {
        id: group.id,
        name: group.name,
        weight: group.group_weight,
        assignmentCount: groupAssignments.length,
        assignmentNames: groupAssignments
          .map((a) => a.name)
          .slice(0, 20),
      };
    }
  );

  return {
    courseMeta,
    assignments,
    modules,
    files,
    pages,
    quizzes,
    calendarEvents,
    announcements,
    discussions,
    gradingGroups,
  };
}
