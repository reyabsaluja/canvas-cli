import fs from "node:fs/promises";
import path from "node:path";
import { extractFileText } from "../extract/extract-text.js";
import {
  getExtractedAssignmentPath,
  getExtractedAnnouncementPath,
  getExtractedAttachmentPath,
  getExtractedDiscussionPath,
  getExtractedPagePath,
} from "../enrich/course-documents.js";
import type {
  RawAssignmentRecord,
  RawDiscussionThread,
} from "./fetch-course-content.js";
import type { CanvasRubricCriterion } from "../canvas/types.js";
import type {
  CourseMetadata,
  AssignmentIndexEntry,
  ModuleIndexEntry,
  FileIndexEntry,
  PageIndexEntry,
  AnnouncementIndexEntry,
  DiscussionIndexEntry,
  SyllabusCandidate,
  DownloadedAttachmentEntry,
  LectureIndexEntry,
  IngestionMeta,
} from "./types.js";
import { htmlToText } from "../format/html-to-text.js";

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
  announcements: AnnouncementIndexEntry[],
  discussions: DiscussionIndexEntry[],
  syllabusCandidates: SyllabusCandidate[],
  attachments: DownloadedAttachmentEntry[],
  lectures: LectureIndexEntry[],
  ingestion: IngestionMeta,
  rawAssignments?: RawAssignmentRecord[],
  frontPageBody?: string | null,
  fetchedPages?: Array<{ slug: string; title: string; body: string }>,
  rawAnnouncements?: Array<{
    id: number;
    title: string;
    message: string | null;
    posted_at: string | null;
  }>,
  rawDiscussionThreads?: RawDiscussionThread[]
): Promise<void> {
  // Ensure directory structure
  await fs.mkdir(path.join(coursePath, "extracted"), { recursive: true });
  await fs.mkdir(path.join(coursePath, "attachments"), { recursive: true });

  // Write all JSON files atomically (write to temp then rename)
  const writes: Array<[string, unknown]> = [
    ["course.json", courseMeta],
    ["assignments.json", assignments],
    ["modules.json", modules],
    ["files.json", files],
    ["pages.json", pages],
    ["announcements.json", announcements],
    ["discussions.json", discussions],
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

    const textContent = htmlToText(courseMeta.syllabusBody);
    const txtPath = path.join(coursePath, "extracted", "syllabus-body.txt");
    await writeAtomic(txtPath, textContent + "\n");
  }

  const rawAssignmentsById = new Map(
    (rawAssignments ?? []).map((assignment) => [assignment.id, assignment])
  );

  if (assignments.length > 0) {
    await fs.mkdir(path.join(coursePath, "extracted", "assignments"), {
      recursive: true,
    });
    for (const assignment of assignments) {
      const rawAssignment = rawAssignmentsById.get(assignment.id);
      const assignmentText = formatAssignmentText(assignment, rawAssignment);
      await writeAtomic(
        getExtractedAssignmentPath(coursePath, assignment.id),
        assignmentText
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
      htmlToText(frontPageBody) + "\n"
    );
  }

  // Extract individually fetched page bodies
  if (fetchedPages && fetchedPages.length > 0) {
    const pagesDir = path.join(coursePath, "extracted", "pages");
    await fs.mkdir(pagesDir, { recursive: true });
    for (const page of fetchedPages) {
      const pageTextPath = getExtractedPagePath(coursePath, page.slug);
      await writeAtomic(
        pageTextPath,
        `# ${page.title}\n\n${htmlToText(page.body)}\n`
      );
    }
  }

  if (rawAnnouncements && rawAnnouncements.length > 0) {
    await fs.mkdir(path.join(coursePath, "extracted", "announcements"), {
      recursive: true,
    });
    for (const announcement of rawAnnouncements) {
      if (!announcement.message) continue;
      const postedAt = announcement.posted_at
        ? `Posted: ${announcement.posted_at}\n\n`
        : "";
      const content =
        `# ${announcement.title}\n\n` +
        postedAt +
        `${htmlToText(announcement.message)}\n`;
      await writeAtomic(
        getExtractedAnnouncementPath(coursePath, announcement.id),
        content
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

  for (const attachment of attachments) {
    if (attachment.status !== "downloaded" && attachment.status !== "skipped") {
      continue;
    }
    const fullPath = path.join(coursePath, attachment.localPath);
    const extractedPath = getExtractedAttachmentPath(
      coursePath,
      attachment.localPath
    );
    try {
      const text = await extractFileText(fullPath, attachment.originalFilename);
      if (!text || text.startsWith("[") || text.trim().length === 0) {
        continue;
      }
      await fs.mkdir(path.dirname(extractedPath), { recursive: true });
      await writeAtomic(extractedPath, text.endsWith("\n") ? text : text + "\n");
    } catch {
      // Extraction is best-effort; keep ingestion resilient if a file is unreadable.
    }
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

function formatAssignmentText(
  assignment: AssignmentIndexEntry,
  rawAssignment?: RawAssignmentRecord
): string {
  const lines = [`# ${assignment.name}`, ""];

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
        const ratingDetail = toSingleLineText(rating.long_description, baseUrl);
        let line = `- ${ratingLabel}`;
        if (ratingPoints) {
          line += ` (${ratingPoints})`;
        }
        if (ratingDetail && ratingDetail !== ratingLabel) {
          line += `: ${ratingDetail}`;
        }
        sections.push(line);
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
