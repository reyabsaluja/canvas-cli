import fs from "node:fs/promises";
import path from "node:path";
import { debugFs } from "../debug.js";
import { extractAttachmentContents } from "./attachment-extraction.js";
import {
  getExtractedAssignmentPath,
  getExtractedAnnouncementPath,
  getExtractedCalendarEventPath,
  getExtractedDiscussionPath,
  getExtractedExternalLinkPath,
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
  CanvasRubricCriterion,
} from "../canvas/types.js";
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

function formatAssignmentText(
  assignment: AssignmentIndexEntry,
  rawAssignment?: RawAssignmentRecord,
  context?: AssignmentContext
): string {
  const lines = [`# ${assignment.name}`, ""];

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
  lines.push(`Canvas URL: ${assignment.htmlUrl}`);
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

  return lines.join("\n") + "\n";
}

function formatQuizText(
  quiz: QuizIndexEntry,
  rawQuiz: CanvasQuiz | undefined,
  courseHtmlUrl: string | null,
  questions?: CanvasQuizQuestion[]
): string {
  const lines = [`# ${quiz.title}`, ""];

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
