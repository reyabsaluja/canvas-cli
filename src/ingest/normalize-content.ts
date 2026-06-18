import type { RawCourseContent } from "./fetch-course-content.js";
import type {
  CourseMetadata,
  AssignmentIndexEntry,
  AssignmentDateDetailsIndex,
  AssignmentDateOverrideIndexEntry,
  AssignmentPeerReviewDateDetailsIndex,
  ModuleIndexEntry,
  FileIndexEntry,
  PageIndexEntry,
  CourseTabIndexEntry,
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
  tabs: CourseTabIndexEntry[];
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
  const canvasLinkBaseUrl = raw.courseDetail.html_url ?? null;

  // Canvas list endpoint may include description and detail fields as extra props
  const assignments: AssignmentIndexEntry[] = raw.assignments.map((a) => {
    const raw_any = a as any;
    const description: string | null = raw_any.description ?? null;
    const linkCount = description
      ? extractLinkedFiles(description, canvasLinkBaseUrl).length
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
      peerReviews: normalizeBoolean(raw_any.peer_reviews),
      automaticPeerReviews: normalizeBoolean(raw_any.automatic_peer_reviews),
      anonymousPeerReviews: normalizeBoolean(raw_any.anonymous_peer_reviews),
      intraGroupPeerReviews: normalizeBoolean(raw_any.intra_group_peer_reviews),
      peerReviewCount: normalizeNumber(raw_any.peer_review_count),
      peerReviewsAssignAt:
        typeof raw_any.peer_reviews_assign_at === "string"
          ? raw_any.peer_reviews_assign_at
          : null,
      dateDetails: normalizeAssignmentDateDetails(raw_any.date_details),
    };
  });

  const modules: ModuleIndexEntry[] = raw.modules.map((m) => ({
    id: m.id,
    name: m.name,
    position: m.position,
    itemCount: m.items.length,
    unlockAt: m.unlock_at ?? null,
    requiresSequentialProgress: m.require_sequential_progress ?? null,
    prerequisiteModuleIds: m.prerequisite_module_ids ?? [],
    items: m.items.map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      position: item.position,
      contentId: item.content_id ?? null,
      pageUrl: item.page_url ?? null,
      htmlUrl: item.html_url ?? null,
      externalUrl: item.external_url ?? null,
      indent: item.indent ?? null,
      completionRequirement: item.completion_requirement
        ? {
            type: item.completion_requirement.type,
            minScore: item.completion_requirement.min_score ?? null,
            completed: item.completion_requirement.completed ?? null,
          }
        : null,
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

  const tabs: CourseTabIndexEntry[] = (raw.tabs ?? []).map((tab) => ({
    id: String(tab.id),
    label: tab.label,
    type: tab.type ?? null,
    position: normalizeNumber(tab.position),
    hidden: normalizeBoolean(tab.hidden),
    visibility: tab.visibility ?? null,
    htmlUrl: tab.html_url ?? null,
    fullUrl: tab.full_url ?? null,
    url: tab.url ?? null,
    externalUrl: tab.external_url ?? null,
  }));

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
        ? extractLinkedFiles(description, canvasLinkBaseUrl).length
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
          ? extractLinkedFiles(description, canvasLinkBaseUrl).length
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
          return count + extractLinkedFiles(entry.message, canvasLinkBaseUrl).length;
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
            ? extractLinkedFiles(announcement.message, canvasLinkBaseUrl).length
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
      return count + extractLinkedFiles(entry.message, canvasLinkBaseUrl).length;
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
          ? extractLinkedFiles(topic.message, canvasLinkBaseUrl).length
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
    tabs,
    quizzes,
    calendarEvents,
    announcements,
    discussions,
    gradingGroups,
  };
}

function normalizeBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeAssignmentDateDetails(
  value: unknown
): AssignmentDateDetailsIndex | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const overrides = normalizeAssignmentDateOverrides(
    raw.overrides ?? raw.assignment_overrides
  );
  return {
    dueAt: normalizeString(raw.due_at),
    unlockAt: normalizeString(raw.unlock_at),
    lockAt: normalizeString(raw.lock_at),
    onlyVisibleToOverrides: normalizeBoolean(raw.only_visible_to_overrides),
    overrideCount: overrides.length,
    overrides,
    peerReviewSubAssignment: normalizePeerReviewSubAssignmentDateDetails(
      raw.peer_review_sub_assignment
    ),
  };
}

function normalizePeerReviewSubAssignmentDateDetails(
  value: unknown
): AssignmentPeerReviewDateDetailsIndex | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const overrides = normalizeAssignmentDateOverrides(
    raw.overrides ?? raw.assignment_overrides
  );
  return {
    id: normalizeNumber(raw.id),
    title: normalizeString(raw.title) ?? normalizeString(raw.name),
    dueAt: normalizeString(raw.due_at),
    unlockAt: normalizeString(raw.unlock_at),
    lockAt: normalizeString(raw.lock_at),
    onlyVisibleToOverrides: normalizeBoolean(raw.only_visible_to_overrides),
    overrideCount: overrides.length,
    overrides,
  };
}

function normalizeAssignmentDateOverrides(
  value: unknown
): AssignmentDateOverrideIndexEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const raw = entry as Record<string, unknown>;
      const studentIds = raw.student_ids;
      return {
        id: normalizeNumber(raw.id),
        title: normalizeString(raw.title),
        dueAt: normalizeString(raw.due_at),
        unlockAt: normalizeString(raw.unlock_at),
        lockAt: normalizeString(raw.lock_at),
        allDay: normalizeBoolean(raw.all_day),
        allDayDate: normalizeString(raw.all_day_date),
        setType: normalizeString(raw.set_type),
        studentCount: Array.isArray(studentIds) ? studentIds.length : null,
        groupId: normalizeNumber(raw.group_id),
        courseSectionId: normalizeNumber(raw.course_section_id),
      };
    })
    .filter((entry): entry is AssignmentDateOverrideIndexEntry => entry !== null);
}
