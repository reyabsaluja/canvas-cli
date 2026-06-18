import fs from "node:fs/promises";
import path from "node:path";
import { debugFs } from "../debug.js";
import { extractAttachmentContents } from "./attachment-extraction.js";
import {
  getExtractedAssignmentPath,
  getExtractedAnnouncementPath,
  getExtractedCalendarEventPath,
  getExtractedCourseTabPath,
  getExtractedDiscussionPath,
  getExtractedExternalLinkPath,
  getExtractedModulePath,
  getExtractedPagePath,
  getExtractedQuizPath,
} from "../enrich/course-documents.js";
import type {
  RawAssignmentRecord,
  RawDiscussionThread,
} from "./fetch-course-content.js";
import type {
  CanvasCalendarEvent,
  CanvasQuiz,
  CanvasQuizQuestion,
  CanvasRubricAssessment,
  CanvasRubricAssessmentCriterion,
  CanvasRubricCriterion,
  CanvasSubmissionComment,
} from "../canvas/types.js";
import type {
  CourseMetadata,
  AssignmentIndexEntry,
  AssignmentDateDetailsIndex,
  AssignmentDateOverrideIndexEntry,
  ModuleIndexEntry,
  FileIndexEntry,
  PageIndexEntry,
  CourseTabIndexEntry,
  QuizIndexEntry,
  CalendarEventIndexEntry,
  AnnouncementIndexEntry,
  DiscussionIndexEntry,
  ExternalLinkIndexEntry,
  GradingGroupIndexEntry,
  SyllabusCandidate,
  DownloadedAttachmentEntry,
  LectureIndexEntry,
  IngestionMeta,
} from "./types.js";
import { htmlToText } from "../format/html-to-text.js";
import type { CapturedExternalLink } from "./external-link-capture.js";

/**
 * Write all ingestion artifacts to the course directory.
 * Creates the directory structure and writes normalized JSON files.
 */
export async function writeIngestionArtifacts(
  coursePath: string,
  courseMeta: CourseMetadata,
  assignments: AssignmentIndexEntry[],
  modules: ModuleIndexEntry[],
  files: FileIndexEntry[],
  pages: PageIndexEntry[],
  tabs: CourseTabIndexEntry[],
  quizzes: QuizIndexEntry[],
  calendarEvents: CalendarEventIndexEntry[],
  announcements: AnnouncementIndexEntry[],
  discussions: DiscussionIndexEntry[],
  externalLinks: ExternalLinkIndexEntry[],
  gradingGroups: GradingGroupIndexEntry[],
  syllabusCandidates: SyllabusCandidate[],
  attachments: DownloadedAttachmentEntry[],
  lectures: LectureIndexEntry[],
  ingestion: IngestionMeta,
  rawAssignments?: RawAssignmentRecord[],
  rawQuizzes?: CanvasQuiz[],
  rawCalendarEvents?: CanvasCalendarEvent[],
  frontPageBody?: string | null,
  fetchedPages?: Array<{ slug: string; title: string; body: string }>,
  rawAnnouncementThreads?: RawDiscussionThread[],
  rawDiscussionThreads?: RawDiscussionThread[],
  capturedExternalLinks?: CapturedExternalLink[],
  quizQuestions?: Map<number, CanvasQuizQuestion[]>
): Promise<void> {
  debugFs("write", coursePath, "writing ingestion artifacts");
  // Ensure directory structure
  await fs.mkdir(path.join(coursePath, "extracted"), { recursive: true });
  await fs.mkdir(path.join(coursePath, "attachments"), { recursive: true });

  // Extract text and unpack zips before writing attachments.json so that
  // zipEntries metadata is captured in the persisted attachment records.
  await extractAttachmentContents(coursePath, attachments);

  // Write all JSON files atomically (write to temp then rename)
  const writes: Array<[string, unknown]> = [
    ["course.json", courseMeta],
    ["assignments.json", assignments],
    ["modules.json", modules],
    ["files.json", files],
    ["pages.json", pages],
    ["tabs.json", tabs],
    ["quizzes.json", quizzes],
    ["calendar-events.json", calendarEvents],
    ["announcements.json", announcements],
    ["discussions.json", discussions],
    ["external-links.json", externalLinks],
    ["grading-groups.json", gradingGroups],
    ["syllabus-candidates.json", syllabusCandidates],
    ["attachments.json", attachments],
    ["lectures.json", lectures],
    ["ingestion.json", ingestion],
  ];

  for (const [filename, data] of writes) {
    const filePath = path.join(coursePath, filename);
    const content = JSON.stringify(data, null, 2) + "\n";
    await writeAtomic(filePath, content);
  }

  // Extract syllabus body text if present
  if (courseMeta.syllabusBody) {
    const htmlPath = path.join(coursePath, "extracted", "syllabus-body.html");
    await writeAtomic(htmlPath, courseMeta.syllabusBody);

    const textContent = htmlToText(courseMeta.syllabusBody, {
      baseUrl: courseMeta.htmlUrl,
    });
    const txtPath = path.join(coursePath, "extracted", "syllabus-body.txt");
    await writeAtomic(txtPath, textContent + "\n");
  }

  const rawAssignmentsById = new Map(
    (rawAssignments ?? []).map((assignment) => [assignment.id, assignment])
  );

  const assignmentContext = buildAssignmentContext(assignments, modules, gradingGroups);

  if (tabs.length > 0) {
    await fs.mkdir(path.join(coursePath, "extracted", "course-tabs"), {
      recursive: true,
    });
    for (const tab of tabs) {
      await writeAtomic(
        getExtractedCourseTabPath(coursePath, tab.id),
        formatCourseTabText(tab)
      );
    }
  }

  if (modules.length > 0) {
    await fs.mkdir(path.join(coursePath, "extracted", "modules"), {
      recursive: true,
    });
    for (const module of modules) {
      await writeAtomic(
        getExtractedModulePath(coursePath, module.id),
        formatModuleText(module, modules)
      );
    }
  }

  if (assignments.length > 0) {
    await fs.mkdir(path.join(coursePath, "extracted", "assignments"), {
      recursive: true,
    });
    for (const assignment of assignments) {
      const rawAssignment = rawAssignmentsById.get(assignment.id);
      const context = assignmentContext.get(assignment.id);
      const assignmentText = formatAssignmentText(
        assignment,
        rawAssignment,
        context
      );
      await writeAtomic(
        getExtractedAssignmentPath(coursePath, assignment.id),
        assignmentText
      );
    }
  }

  const rawQuizzesById = new Map(
    (rawQuizzes ?? []).map((quiz) => [quiz.id, quiz])
  );
  if (quizzes.length > 0) {
    await fs.mkdir(path.join(coursePath, "extracted", "quizzes"), {
      recursive: true,
    });
    for (const quiz of quizzes) {
      await writeAtomic(
        getExtractedQuizPath(coursePath, quiz.id),
        formatQuizText(
          quiz,
          rawQuizzesById.get(quiz.id),
          courseMeta.htmlUrl,
          quizQuestions?.get(quiz.id)
        )
      );
    }
  }

  const rawCalendarEventsById = new Map(
    (rawCalendarEvents ?? []).map((event) => [event.id, event])
  );
  if (calendarEvents.length > 0) {
    await fs.mkdir(path.join(coursePath, "extracted", "calendar-events"), {
      recursive: true,
    });
    for (const event of calendarEvents) {
      await writeAtomic(
        getExtractedCalendarEventPath(coursePath, event.id),
        formatCalendarEventText(
          event,
          rawCalendarEventsById.get(event.id),
          courseMeta.htmlUrl
        )
      );
    }
  }

  // Extract front page (course home page) if present
  if (frontPageBody) {
    await writeAtomic(
      path.join(coursePath, "extracted", "front-page.html"),
      frontPageBody
    );
    await writeAtomic(
      path.join(coursePath, "extracted", "front-page.txt"),
      htmlToText(frontPageBody, {
        baseUrl: courseMeta.htmlUrl,
      }) + "\n"
    );
  }

  // Extract individually fetched page bodies
  if (fetchedPages && fetchedPages.length > 0) {
    const pagesDir = path.join(coursePath, "extracted", "pages");
    await fs.mkdir(pagesDir, { recursive: true });
    for (const page of fetchedPages) {
      const pageTextPath = getExtractedPagePath(coursePath, page.slug);
      const pageUrl = courseMeta.htmlUrl
        ? `${courseMeta.htmlUrl.replace(/\/$/, "")}/pages/${encodeURIComponent(page.slug)}`
        : null;
      await writeAtomic(
        pageTextPath,
        `# ${page.title}\n\n${htmlToText(page.body, { baseUrl: pageUrl })}\n`
      );
    }
  }

  if (rawAnnouncementThreads && rawAnnouncementThreads.length > 0) {
    await fs.mkdir(path.join(coursePath, "extracted", "announcements"), {
      recursive: true,
    });
    for (const thread of rawAnnouncementThreads) {
      if (!thread.topic.message && thread.entries.length === 0) continue;
      await writeAtomic(
        getExtractedAnnouncementPath(coursePath, thread.topic.id),
        formatAnnouncementThreadText(thread, courseMeta.htmlUrl)
      );
    }
  }

  if (rawDiscussionThreads && rawDiscussionThreads.length > 0) {
    await fs.mkdir(path.join(coursePath, "extracted", "discussions"), {
      recursive: true,
    });
    for (const thread of rawDiscussionThreads) {
      await writeAtomic(
        getExtractedDiscussionPath(coursePath, thread.topic.id),
        formatDiscussionThreadText(thread)
      );
    }
  }

  if (capturedExternalLinks && capturedExternalLinks.length > 0) {
    await fs.mkdir(path.join(coursePath, "extracted", "external-links"), {
      recursive: true,
    });
    for (const capture of capturedExternalLinks) {
      await writeAtomic(
        getExtractedExternalLinkPath(coursePath, capture.entry.id),
        capture.text
      );
    }
  }

  if (gradingGroups.length > 0) {
    await writeAtomic(
      path.join(coursePath, "extracted", "grading-breakdown.txt"),
      formatGradingBreakdownText(gradingGroups)
    );
  }
}

/**
 * Write a file atomically by writing to a temp file then renaming.
 * Prevents half-written files if the process is interrupted.
 */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + ".tmp";
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}

function formatCourseTabText(tab: CourseTabIndexEntry): string {
  const lines = [`# ${tab.label}`, ""];

  lines.push("## Key facts");
  lines.push("");
  lines.push(`ID: ${tab.id}`);
  lines.push(`Type: ${tab.type ?? "Not specified"}`);
  lines.push(
    `Position: ${tab.position !== null ? String(tab.position) : "Not specified"}`
  );
  lines.push(`Hidden: ${tab.hidden === null ? "Not specified" : tab.hidden ? "yes" : "no"}`);
  lines.push(`Visibility: ${tab.visibility ?? "Not specified"}`);
  if (tab.htmlUrl) {
    lines.push(`Canvas URL: ${tab.htmlUrl}`);
  }
  if (tab.fullUrl) {
    lines.push(`Full URL: ${tab.fullUrl}`);
  }
  if (tab.externalUrl) {
    lines.push(`External URL: ${tab.externalUrl}`);
  }
  if (tab.url) {
    lines.push(`API or launch URL: ${tab.url}`);
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

interface AssignmentContext {
  moduleName: string | null;
  modulePosition: number | null;
  gradingCategory: string | null;
  categoryWeight: number | null;
}

function buildAssignmentContext(
  assignments: AssignmentIndexEntry[],
  modules: ModuleIndexEntry[],
  gradingGroups: GradingGroupIndexEntry[]
): Map<number, AssignmentContext> {
  const contextMap = new Map<number, AssignmentContext>();

  const moduleByAssignmentId = new Map<number, { name: string; position: number }>();
  for (const mod of modules) {
    for (const item of mod.items) {
      if (item.type === "Assignment" && item.contentId !== null) {
        moduleByAssignmentId.set(item.contentId, {
          name: mod.name,
          position: mod.position,
        });
      }
    }
  }

  const totalWeight = gradingGroups.reduce((sum, g) => sum + g.weight, 0);
  const isWeighted = totalWeight > 0;
  const categoryByAssignmentName = new Map<
    string,
    { name: string; weight: number }
  >();
  if (isWeighted) {
    for (const group of gradingGroups) {
      for (const assignmentName of group.assignmentNames) {
        categoryByAssignmentName.set(assignmentName, {
          name: group.name,
          weight: group.weight,
        });
      }
    }
  }

  for (const assignment of assignments) {
    const mod = moduleByAssignmentId.get(assignment.id);
    const category = categoryByAssignmentName.get(assignment.name);
    if (mod || category) {
      contextMap.set(assignment.id, {
        moduleName: mod?.name ?? null,
        modulePosition: mod?.position ?? null,
        gradingCategory: category?.name ?? null,
        categoryWeight: category?.weight ?? null,
      });
    }
  }

  return contextMap;
}

function formatModuleText(
  module: ModuleIndexEntry,
  modules: ModuleIndexEntry[]
): string {
  const lines = [`# ${module.name}`, ""];

  lines.push("## Key facts");
  lines.push("");
  lines.push(`Position: ${module.position}`);
  lines.push(`Items: ${module.itemCount}`);
  if (module.unlockAt) {
    lines.push(`Unlocks: ${module.unlockAt}`);
  }
  if (
    module.requiresSequentialProgress !== null &&
    module.requiresSequentialProgress !== undefined
  ) {
    lines.push(
      `Requires sequential progress: ${
        module.requiresSequentialProgress ? "yes" : "no"
      }`
    );
  }

  const prerequisiteIds = module.prerequisiteModuleIds ?? [];
  if (prerequisiteIds.length > 0) {
    lines.push("");
    lines.push("## Prerequisites");
    for (const prerequisiteId of prerequisiteIds) {
      const prerequisite = modules.find(
        (candidate) => candidate.id === prerequisiteId
      );
      lines.push(
        `- ${prerequisite?.name ?? `Module ${prerequisiteId}`} (module ${prerequisiteId})`
      );
    }
  }

  if (module.items.length > 0) {
    lines.push("");
    lines.push("## Items");
    lines.push("");
    for (const item of [...module.items].sort(
      (left, right) => left.position - right.position
    )) {
      const itemParts = [
        `${item.position}. ${item.title}`,
        `type: ${item.type}`,
      ];
      if (item.contentId !== null) {
        itemParts.push(`content ID: ${item.contentId}`);
      }
      if (item.pageUrl) {
        itemParts.push(`page: ${item.pageUrl}`);
      }
      if (item.htmlUrl) {
        itemParts.push(`Canvas URL: ${item.htmlUrl}`);
      }
      if (item.externalUrl) {
        itemParts.push(`External URL: ${item.externalUrl}`);
      }
      lines.push(itemParts.join(" — "));

      const requirement = item.completionRequirement;
      if (requirement) {
        const completed =
          requirement.completed !== null
            ? `; completed: ${requirement.completed ? "yes" : "no"}`
            : "";
        lines.push(
          `   Completion requirement: ${formatModuleItemRequirement(requirement)}${completed}`
        );
      }
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function formatModuleItemRequirement(
  requirement: NonNullable<
    ModuleIndexEntry["items"][number]["completionRequirement"]
  >
): string {
  switch (requirement.type) {
    case "must_view":
      return "must view";
    case "must_mark_done":
      return "must mark done";
    case "must_submit":
      return "must submit";
    case "min_score": {
      const score =
        requirement.minScore !== null
          ? ` with at least ${requirement.minScore}`
          : "";
      return `must earn a minimum score${score}`;
    }
    case "must_contribute":
      return "must contribute";
    default:
      return requirement.type.replace(/_/g, " ");
  }
}

function formatAssignmentText(
  assignment: AssignmentIndexEntry,
  rawAssignment?: RawAssignmentRecord,
  context?: AssignmentContext
): string {
  const lines = [`# ${assignment.name}`, ""];

  lines.push("## Key facts");
  lines.push("");
  if (context?.moduleName) {
    lines.push(`Module: ${context.moduleName}`);
  }
  if (context?.gradingCategory) {
    const weightLabel =
      context.categoryWeight !== null ? ` (${context.categoryWeight}% of grade)` : "";
    lines.push(`Category: ${context.gradingCategory}${weightLabel}`);
  }
  lines.push(`Due: ${assignment.dueAt ?? "No due date"}`);
  if (assignment.unlockAt) {
    lines.push(`Unlocks: ${assignment.unlockAt}`);
  }
  if (assignment.lockAt) {
    lines.push(`Locks: ${assignment.lockAt}`);
  }
  lines.push(
    `Points: ${
      assignment.pointsPossible !== null ? String(assignment.pointsPossible) : "Not specified"
    }`
  );
  lines.push(`Grading type: ${assignment.gradingType}`);
  lines.push(
    `Submission types: ${
      assignment.submissionTypes.length > 0
        ? assignment.submissionTypes.join(", ")
        : "Not specified"
    }`
  );
  if (rawAssignment?.allowed_extensions?.length) {
    lines.push(
      `Allowed file extensions: ${rawAssignment.allowed_extensions.join(", ")}`
    );
  }
  lines.push(...formatAssignmentPeerReviewLines(assignment, rawAssignment));
  lines.push(`Canvas URL: ${assignment.htmlUrl}`);

  const dateDetailsText = formatAssignmentDateDetailsText(
    assignment.dateDetails ?? null
  );
  if (dateDetailsText) {
    lines.push("");
    lines.push("## Assignment Dates");
    lines.push("");
    lines.push(dateDetailsText);
  }

  lines.push("");
  lines.push("## Description");
  lines.push("");

  const description =
    typeof rawAssignment?.description === "string"
      ? rawAssignment.description
      : null;

  if (description && description.trim().length > 0) {
    const text = renderRichText(description, assignment.htmlUrl);
    lines.push(text || "No Canvas description provided.");
  } else {
    lines.push("No Canvas description provided.");
  }

  const rubric = rawAssignment?.rubric ?? [];
  if (rubric.length > 0) {
    lines.push("");
    lines.push("## Rubric");
    lines.push("");
    lines.push(formatRubricText(rubric, assignment.htmlUrl));
  }

  const submission = rawAssignment?.submission;
  const submissionComments = submission?.submission_comments ?? [];
  const rubricAssessmentText = formatSubmissionRubricAssessmentText(
    submission?.rubric_assessment,
    rubric,
    assignment.htmlUrl
  );
  if (submissionComments.length > 0 || rubricAssessmentText) {
    lines.push("");
    lines.push("## Submission Feedback");
    lines.push("");
    if (submissionComments.length > 0) {
      lines.push(formatSubmissionFeedbackText(submissionComments, assignment.htmlUrl));
    }
    if (rubricAssessmentText) {
      if (submissionComments.length > 0) {
        lines.push("");
      }
      lines.push(rubricAssessmentText);
    }
  }

  return lines.join("\n") + "\n";
}

function formatAssignmentPeerReviewLines(
  assignment: AssignmentIndexEntry,
  rawAssignment?: RawAssignmentRecord
): string[] {
  const peerReviews = coalesceBoolean(
    assignment.peerReviews,
    rawAssignment?.peer_reviews
  );
  const automaticPeerReviews = coalesceBoolean(
    assignment.automaticPeerReviews,
    rawAssignment?.automatic_peer_reviews
  );
  const anonymousPeerReviews = coalesceBoolean(
    assignment.anonymousPeerReviews,
    rawAssignment?.anonymous_peer_reviews
  );
  const intraGroupPeerReviews = coalesceBoolean(
    assignment.intraGroupPeerReviews,
    rawAssignment?.intra_group_peer_reviews
  );
  const peerReviewCount = coalesceNumber(
    assignment.peerReviewCount,
    rawAssignment?.peer_review_count
  );
  const peerReviewsAssignAt = coalesceString(
    assignment.peerReviewsAssignAt,
    rawAssignment?.peer_reviews_assign_at
  );

  const lines: string[] = [];
  if (peerReviews !== null) {
    lines.push(`Peer reviews: ${formatBooleanLabel(peerReviews)}`);
  }

  if (peerReviews === false) {
    return lines;
  }

  if (automaticPeerReviews !== null) {
    lines.push(
      `Peer reviews assigned automatically: ${formatBooleanLabel(automaticPeerReviews)}`
    );
  }
  if (anonymousPeerReviews !== null) {
    lines.push(
      `Anonymous peer reviews: ${formatBooleanLabel(anonymousPeerReviews)}`
    );
  }
  if (intraGroupPeerReviews !== null) {
    lines.push(
      `Intra-group peer reviews: ${formatBooleanLabel(intraGroupPeerReviews)}`
    );
  }
  if (peerReviewCount !== null) {
    lines.push(`Peer reviews required: ${peerReviewCount}`);
  }
  if (peerReviewsAssignAt !== null) {
    lines.push(`Peer reviews assigned at: ${peerReviewsAssignAt}`);
  }

  return lines;
}

function formatAssignmentDateDetailsText(
  details: AssignmentDateDetailsIndex | null
): string | null {
  if (!details) {
    return null;
  }

  const sections: string[] = [];
  const baseLines = formatDateDetailLines({
    dueAt: details.dueAt,
    unlockAt: details.unlockAt,
    lockAt: details.lockAt,
    onlyVisibleToOverrides: details.onlyVisibleToOverrides,
  });
  if (baseLines.length > 0) {
    sections.push("### Base assignment dates");
    sections.push("");
    sections.push(...baseLines);
  }

  if (details.overrides.length > 0) {
    sections.push("");
    sections.push("### Assignment date overrides");
    sections.push("");
    sections.push(...formatDateOverrideLines(details.overrides));
  }

  const peerReview = details.peerReviewSubAssignment;
  if (peerReview) {
    sections.push("");
    sections.push("### Peer review dates");
    sections.push("");
    const label = peerReview.title ?? "Peer review sub-assignment";
    sections.push(`Peer review assignment: ${label}`);
    const peerLines = formatDateDetailLines(peerReview);
    if (peerLines.length > 0) {
      sections.push(...peerLines);
    }
    if (peerReview.overrides.length > 0) {
      sections.push("");
      sections.push("Peer review date overrides:");
      sections.push(...formatDateOverrideLines(peerReview.overrides));
    }
  }

  return sections.join("\n").trim() || null;
}

function formatDateDetailLines(details: {
  dueAt: string | null;
  unlockAt: string | null;
  lockAt: string | null;
  onlyVisibleToOverrides: boolean | null;
}): string[] {
  const lines: string[] = [];
  if (details.dueAt) {
    lines.push(`Due: ${details.dueAt}`);
  }
  if (details.unlockAt) {
    lines.push(`Unlocks: ${details.unlockAt}`);
  }
  if (details.lockAt) {
    lines.push(`Locks: ${details.lockAt}`);
  }
  if (details.onlyVisibleToOverrides !== null) {
    lines.push(
      `Only visible to override recipients: ${formatBooleanLabel(details.onlyVisibleToOverrides)}`
    );
  }
  return lines;
}

function formatDateOverrideLines(
  overrides: AssignmentDateOverrideIndexEntry[]
): string[] {
  return overrides.map((override, index) => {
    const label = override.title ?? `Override ${index + 1}`;
    const parts = [`- ${label}`];
    if (override.setType) {
      parts.push(`type ${override.setType}`);
    }
    if (override.courseSectionId !== null) {
      parts.push(`section ${override.courseSectionId}`);
    }
    if (override.groupId !== null) {
      parts.push(`group ${override.groupId}`);
    }
    if (override.studentCount !== null) {
      parts.push(`${override.studentCount} student${override.studentCount === 1 ? "" : "s"}`);
    }
    if (override.dueAt) {
      parts.push(`due ${override.dueAt}`);
    }
    if (override.unlockAt) {
      parts.push(`unlocks ${override.unlockAt}`);
    }
    if (override.lockAt) {
      parts.push(`locks ${override.lockAt}`);
    }
    if (override.allDayDate) {
      parts.push(`all-day date ${override.allDayDate}`);
    }
    if (override.allDay !== null) {
      parts.push(`all day ${formatBooleanLabel(override.allDay)}`);
    }
    return parts.join("; ");
  });
}

function coalesceBoolean(
  ...values: Array<boolean | null | undefined>
): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }
  return null;
}

function coalesceNumber(...values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function coalesceString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function formatBooleanLabel(value: boolean): string {
  return value ? "yes" : "no";
}

function formatQuizText(
  quiz: QuizIndexEntry,
  rawQuiz: CanvasQuiz | undefined,
  courseHtmlUrl: string | null,
  questions?: CanvasQuizQuestion[]
): string {
  const lines = [`# ${quiz.title}`, ""];

  lines.push("## Key facts");
  lines.push("");
  lines.push(`Due: ${quiz.dueAt ?? "No due date"}`);
  if (quiz.unlockAt) {
    lines.push(`Unlocks: ${quiz.unlockAt}`);
  }
  if (quiz.lockAt) {
    lines.push(`Locks: ${quiz.lockAt}`);
  }
  lines.push(
    `Points: ${
      quiz.pointsPossible !== null ? String(quiz.pointsPossible) : "Not specified"
    }`
  );
  lines.push(
    `Questions: ${
      quiz.questionCount !== null ? String(quiz.questionCount) : "Not specified"
    }`
  );
  lines.push(
    `Time limit: ${
      quiz.timeLimit !== null ? `${quiz.timeLimit} minutes` : "Not specified"
    }`
  );
  lines.push(
    `Allowed attempts: ${
      quiz.allowedAttempts !== null
        ? formatAllowedAttempts(quiz.allowedAttempts)
        : "Not specified"
    }`
  );
  if (quiz.quizType) {
    lines.push(`Quiz type: ${quiz.quizType}`);
  }
  if (quiz.published !== null) {
    lines.push(`Published: ${quiz.published ? "yes" : "no"}`);
  }
  if (quiz.assignmentId !== null) {
    lines.push(`Assignment ID: ${quiz.assignmentId}`);
  }
  if (quiz.htmlUrl) {
    lines.push(`Canvas URL: ${quiz.htmlUrl}`);
  }
  lines.push("");
  lines.push("## Instructions");
  lines.push("");

  const description =
    typeof rawQuiz?.description === "string" ? rawQuiz.description : null;
  if (description && description.trim().length > 0) {
    const baseUrl = quiz.htmlUrl ?? rawQuiz?.html_url ?? courseHtmlUrl;
    lines.push(renderRichText(description, baseUrl) || "No quiz instructions provided.");
  } else {
    lines.push("No quiz instructions provided.");
  }

  if (questions && questions.length > 0) {
    lines.push("");
    lines.push("## Questions");
    lines.push("");
    const baseUrl = quiz.htmlUrl ?? rawQuiz?.html_url ?? courseHtmlUrl;
    for (const question of questions) {
      const pointsLabel =
        question.points_possible !== null && question.points_possible !== undefined
          ? ` (${question.points_possible} pts)`
          : "";
      lines.push(`### ${question.question_name}${pointsLabel}`);
      lines.push("");
      const text = renderRichText(question.question_text, baseUrl);
      if (text) {
        lines.push(text);
      }
      lines.push("");
    }
  }

  return lines.join("\n") + "\n";
}

function formatCalendarEventText(
  event: CalendarEventIndexEntry,
  rawEvent: CanvasCalendarEvent | undefined,
  courseHtmlUrl: string | null
): string {
  const lines = [`# ${event.title}`, ""];

  lines.push("## Key facts");
  lines.push("");
  lines.push(`Starts: ${event.startAt ?? "No start time"}`);
  if (event.endAt) {
    lines.push(`Ends: ${event.endAt}`);
  }
  if (event.allDay !== null) {
    lines.push(`All day: ${event.allDay ? "yes" : "no"}`);
  }
  if (event.locationName) {
    lines.push(`Location: ${event.locationName}`);
  }
  if (event.locationAddress) {
    lines.push(`Address: ${event.locationAddress}`);
  }
  if (event.workflowState) {
    lines.push(`Status: ${event.workflowState}`);
  }
  if (event.htmlUrl) {
    lines.push(`Canvas URL: ${event.htmlUrl}`);
  }
  lines.push("");
  lines.push("## Description");
  lines.push("");

  const description =
    typeof rawEvent?.description === "string" ? rawEvent.description : null;
  if (description && description.trim().length > 0) {
    const baseUrl = event.htmlUrl ?? rawEvent?.html_url ?? courseHtmlUrl;
    lines.push(renderRichText(description, baseUrl) || "No event description provided.");
  } else {
    lines.push("No event description provided.");
  }

  return lines.join("\n") + "\n";
}

function formatRubricText(
  rubric: CanvasRubricCriterion[],
  baseUrl: string | null
): string {
  const sections: string[] = [];

  for (const criterion of rubric) {
    const heading = toSingleLineText(criterion.description, baseUrl) || "Criterion";
    const points = formatPointLabel(criterion.points);

    sections.push(`### ${heading}${points ? ` (${points})` : ""}`);

    const detail = renderRichText(criterion.long_description, baseUrl);
    if (detail && detail !== heading) {
      sections.push("");
      sections.push(detail);
    }

    const ratings = (criterion.ratings ?? []).filter(
      (rating) => typeof rating.description === "string" && rating.description.trim().length > 0
    );
    if (ratings.length > 0) {
      sections.push("");
      sections.push("Ratings:");
      for (const rating of ratings) {
        const ratingLabel = toSingleLineText(rating.description, baseUrl) || "Rating";
        const ratingPoints = formatPointLabel(rating.points);
        const ratingDetail = renderRichText(rating.long_description, baseUrl);
        const ratingHeading = `#### Rating: ${ratingLabel}${
          ratingPoints ? ` (${ratingPoints})` : ""
        }`;
        sections.push("");
        sections.push(ratingHeading);
        if (ratingDetail && ratingDetail !== ratingLabel) {
          sections.push("");
          sections.push(ratingDetail);
        }
      }
    }

    sections.push("");
  }

  return sections.join("\n").trimEnd();
}

function formatSubmissionFeedbackText(
  comments: CanvasSubmissionComment[],
  baseUrl: string | null
): string {
  const sections: string[] = [];

  for (const comment of comments) {
    const headingParts = [
      comment.author_name ?? "Unknown author",
      comment.created_at ?? null,
    ].filter((part) => typeof part === "string" && part.length > 0);
    sections.push(`### ${headingParts.join(" — ")}`);
    sections.push("");

    const body =
      renderRichText(comment.html_comment, baseUrl) ||
      renderRichText(comment.comment, baseUrl);
    sections.push(body || "No text feedback captured.");

    if (comment.media_comment) {
      const media = comment.media_comment;
      const label =
        media.display_name ||
        media.media_id ||
        `${media.media_type ?? "media"} comment`;
      const mediaParts = [`Media comment: ${label}`];
      if (media.media_type) {
        mediaParts.push(`type: ${media.media_type}`);
      }
      if (media.url) {
        mediaParts.push(`URL: ${media.url}`);
      }
      sections.push("");
      sections.push(mediaParts.join(" — "));
    }

    const attachments = comment.attachments ?? [];
    if (attachments.length > 0) {
      sections.push("");
      sections.push("Attachments:");
      for (const attachment of attachments) {
        const name =
          attachment.display_name ||
          attachment.filename ||
          `attachment ${attachment.id}`;
        const url = attachment.url ? ` — ${attachment.url}` : "";
        sections.push(`- ${name}${url}`);
      }
    }

    sections.push("");
  }

  return sections.join("\n").trimEnd();
}

function formatSubmissionRubricAssessmentText(
  assessment: CanvasRubricAssessment | null | undefined,
  rubric: CanvasRubricCriterion[],
  baseUrl: string | null
): string {
  const rows = normalizeRubricAssessmentRows(assessment, rubric);
  if (rows.length === 0) {
    return "";
  }

  const criterionById = new Map(
    rubric.map((criterion) => [String(criterion.id), criterion])
  );
  const sections = ["### Rubric Assessment", ""];

  for (const [criterionId, row] of rows) {
    const criterion = criterionById.get(criterionId);
    const heading =
      (criterion ? toSingleLineText(criterion.description, baseUrl) : "") ||
      `Criterion ${criterionId}`;
    sections.push(`#### ${heading}`);
    sections.push("");

    const facts: string[] = [];
    if (typeof row.points === "number" && Number.isFinite(row.points)) {
      facts.push(
        `Points: ${formatRubricAssessmentPoints(row.points, criterion?.points)}`
      );
    }

    const ratingId =
      row.rating_id !== null && row.rating_id !== undefined
        ? String(row.rating_id)
        : null;
    if (ratingId) {
      const rating = criterion?.ratings?.find(
        (candidate) => String(candidate.id) === ratingId
      );
      if (rating) {
        const ratingLabel =
          toSingleLineText(rating.description, baseUrl) || ratingId;
        const ratingPoints = formatPointLabel(rating.points);
        facts.push(
          `Rating: ${ratingLabel}${ratingPoints ? ` (${ratingPoints})` : ""}`
        );
      } else {
        facts.push(`Rating ID: ${ratingId}`);
      }
    }

    sections.push(...facts);

    const comments = renderRichText(row.comments, baseUrl);
    if (comments) {
      if (facts.length > 0) {
        sections.push("");
      }
      sections.push(comments);
    }

    sections.push("");
  }

  return sections.join("\n").trimEnd();
}

function normalizeRubricAssessmentRows(
  assessment: CanvasRubricAssessment | null | undefined,
  rubric: CanvasRubricCriterion[]
): Array<[string, CanvasRubricAssessmentCriterion]> {
  if (!assessment || typeof assessment !== "object") {
    return [];
  }

  const rubricOrder = new Map(
    rubric.map((criterion, index) => [String(criterion.id), index])
  );
  return Object.entries(assessment)
    .filter(
      (entry): entry is [string, CanvasRubricAssessmentCriterion] =>
        isRubricAssessmentCriterion(entry[1])
    )
    .sort(([leftId], [rightId]) => {
      const leftOrder = rubricOrder.get(leftId);
      const rightOrder = rubricOrder.get(rightId);
      if (leftOrder !== undefined && rightOrder !== undefined) {
        return leftOrder - rightOrder;
      }
      if (leftOrder !== undefined) return -1;
      if (rightOrder !== undefined) return 1;
      return 0;
    });
}

function isRubricAssessmentCriterion(
  value: CanvasRubricAssessment[string]
): value is CanvasRubricAssessmentCriterion {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (typeof value.points === "number" && Number.isFinite(value.points)) {
    return true;
  }
  if (value.rating_id !== null && value.rating_id !== undefined) {
    return true;
  }
  return typeof value.comments === "string" && value.comments.trim().length > 0;
}

function formatRubricAssessmentPoints(
  points: number,
  maxPoints: number | null | undefined
): string {
  if (typeof maxPoints === "number" && Number.isFinite(maxPoints)) {
    return `${points} / ${maxPoints}`;
  }
  return String(points);
}

function renderRichText(
  value: string | null | undefined,
  baseUrl: string | null
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "";
  }

  return htmlToText(value, { baseUrl });
}

function toSingleLineText(
  value: string | null | undefined,
  baseUrl: string | null
): string {
  return renderRichText(value, baseUrl).replace(/\s+/g, " ").trim();
}

function formatPointLabel(points: number | null | undefined): string | null {
  if (typeof points !== "number" || Number.isNaN(points)) {
    return null;
  }

  return `${points} ${points === 1 ? "point" : "points"}`;
}

function formatAllowedAttempts(allowedAttempts: number): string {
  if (allowedAttempts < 0) {
    return "unlimited";
  }
  return String(allowedAttempts);
}

function formatDiscussionThreadText(thread: RawDiscussionThread): string {
  const lines = [`# ${thread.topic.title}`, ""];

  if (thread.topic.posted_at) {
    lines.push(`Posted: ${thread.topic.posted_at}`);
  }
  if (thread.topic.last_reply_at) {
    lines.push(`Last reply: ${thread.topic.last_reply_at}`);
  }
  if (thread.topic.user_name) {
    lines.push(`Started by: ${thread.topic.user_name}`);
  }
  lines.push(`Participants: ${thread.participantCount}`);
  lines.push(`Replies captured: ${thread.entries.length}`);
  lines.push(`Canvas URL: ${thread.topic.html_url}`);
  lines.push("");
  lines.push("## Topic");
  lines.push("");

  if (thread.topic.message && thread.topic.message.trim().length > 0) {
    lines.push(
      htmlToText(thread.topic.message, { baseUrl: thread.topic.html_url }) ||
        "No topic message provided."
    );
  } else {
    lines.push("No topic message provided.");
  }

  if (thread.entries.length > 0) {
    lines.push("");
    lines.push("## Replies");
    lines.push("");

    for (const entry of thread.entries) {
      const headingParts = [
        entry.user_name ?? `User ${entry.user_id}`,
        entry.created_at,
      ].filter((part) => typeof part === "string" && part.length > 0);
      lines.push(`### ${headingParts.join(" — ")}`);
      lines.push("");
      if (entry.message && entry.message.trim().length > 0) {
        lines.push(
          htmlToText(entry.message, { baseUrl: thread.topic.html_url }) ||
            "No reply text captured."
        );
      } else {
        lines.push("No reply text captured.");
      }
      lines.push("");
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function formatGradingBreakdownText(
  gradingGroups: GradingGroupIndexEntry[]
): string {
  const totalWeight = gradingGroups.reduce((sum, g) => sum + g.weight, 0);
  const isWeighted = totalWeight > 0;
  const lines = ["# Grading Breakdown", ""];

  if (isWeighted) {
    lines.push(`Grading scheme: weighted (total ${totalWeight}%)`, "");
  } else {
    lines.push("Grading scheme: unweighted (equal weight per assignment)", "");
  }

  const sorted = [...gradingGroups].sort((a, b) => b.weight - a.weight);
  for (const group of sorted) {
    const weightLabel = isWeighted ? ` (${group.weight}%)` : "";
    lines.push(`## ${group.name}${weightLabel}`);
    lines.push("");
    lines.push(`Assignments in this category: ${group.assignmentCount}`);
    if (group.assignmentNames.length > 0) {
      for (const name of group.assignmentNames) {
        lines.push(`- ${name}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function formatAnnouncementThreadText(
  thread: RawDiscussionThread,
  courseHtmlUrl: string | null
): string {
  const baseUrl = thread.topic.html_url ?? courseHtmlUrl;
  const lines = [`# ${thread.topic.title}`, ""];

  if (thread.topic.posted_at) {
    lines.push(`Posted: ${thread.topic.posted_at}`);
  }
  if (thread.topic.user_name) {
    lines.push(`Author: ${thread.topic.user_name}`);
  }
  if (thread.entries.length > 0) {
    lines.push(`Replies: ${thread.entries.length}`);
  }
  lines.push("");

  if (thread.topic.message && thread.topic.message.trim().length > 0) {
    lines.push(
      htmlToText(thread.topic.message, { baseUrl }) ||
        "No announcement message provided."
    );
  } else {
    lines.push("No announcement message provided.");
  }

  if (thread.entries.length > 0) {
    lines.push("");
    lines.push("## Replies");
    lines.push("");

    for (const entry of thread.entries) {
      const headingParts = [
        entry.user_name ?? `User ${entry.user_id}`,
        entry.created_at,
      ].filter((part) => typeof part === "string" && part.length > 0);
      lines.push(`### ${headingParts.join(" — ")}`);
      lines.push("");
      if (entry.message && entry.message.trim().length > 0) {
        lines.push(
          htmlToText(entry.message, { baseUrl }) || "No reply text captured."
        );
      } else {
        lines.push("No reply text captured.");
      }
      lines.push("");
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
