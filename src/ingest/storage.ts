import fs from "node:fs/promises";
import path from "node:path";
import { debugFs } from "../debug.js";
import { extractAttachmentContents } from "./attachment-extraction.js";
import {
  getExtractedAssignmentPath,
  getExtractedAnnouncementPath,
  getExtractedDiscussionPath,
  getExtractedExternalLinkPath,
  getExtractedPagePath,
} from "../enrich/course-documents.js";
import type {
  RawAssignmentRecord,
  RawDiscussionThread,
} from "./fetch-course-content.js";
import type {
  CanvasRubricCriterion,
  CanvasTopicAttachment,
  CanvasAssignmentGroup,
} from "../canvas/types.js";
import type {
  CourseMetadata,
  AssignmentIndexEntry,
  ModuleIndexEntry,
  FileIndexEntry,
  PageIndexEntry,
  AnnouncementIndexEntry,
  DiscussionIndexEntry,
  ExternalLinkIndexEntry,
  SyllabusCandidate,
  DownloadedAttachmentEntry,
  LectureIndexEntry,
  IngestionMeta,
} from "./types.js";
import { htmlToText } from "../format/html-to-text.js";
import { stripControlChars } from "../sanitize.js";
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
  announcements: AnnouncementIndexEntry[],
  discussions: DiscussionIndexEntry[],
  externalLinks: ExternalLinkIndexEntry[],
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
    html_url?: string | null;
    /** Files attached to the post itself (not linked from `message`). */
    attachments?: CanvasTopicAttachment[] | null;
  }>,
  rawDiscussionThreads?: RawDiscussionThread[],
  capturedExternalLinks?: CapturedExternalLink[],
  /** Assignment groups so each assignment extract can state its weight. */
  assignmentGroups?: CanvasAssignmentGroup[]
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
    ["announcements.json", announcements],
    ["discussions.json", discussions],
    ["external-links.json", externalLinks],
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

  if (assignments.length > 0) {
    await fs.mkdir(path.join(coursePath, "extracted", "assignments"), {
      recursive: true,
    });
    for (const assignment of assignments) {
      const rawAssignment = rawAssignmentsById.get(assignment.id);
      const assignmentText = formatAssignmentText(
        assignment,
        rawAssignment,
        describeAssignmentWeight(assignment.id, rawAssignment, assignmentGroups ?? [])
      );
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

  const attachmentLookup = buildTopicAttachmentLookup(attachments);

  if (rawAnnouncements && rawAnnouncements.length > 0) {
    await fs.mkdir(path.join(coursePath, "extracted", "announcements"), {
      recursive: true,
    });
    for (const announcement of rawAnnouncements) {
      const attachmentLine = formatTopicAttachmentsLine(
        announcement.attachments,
        attachmentLookup
      );
      if (!announcement.message && !attachmentLine) continue;
      const header = [
        announcement.posted_at ? `Posted: ${announcement.posted_at}` : "",
        attachmentLine,
      ].filter(Boolean);
      const postedAt = header.length > 0 ? `${header.join("\n")}\n\n` : "";
      const content =
        `# ${announcement.title}\n\n` +
        postedAt +
        `${htmlToText(announcement.message ?? "", {
          baseUrl: announcement.html_url ?? courseMeta.htmlUrl,
        })}\n`;
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
        formatDiscussionThreadText(thread, attachmentLookup)
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

/**
 * "Assignment group: Labs (30% of the final grade; lowest 1 dropped);
 * this assignment is about 7.5% of the final grade." Exported for tests.
 */
export function describeAssignmentWeight(
  assignmentId: number,
  rawAssignment: { assignment_group_id?: number | null; points_possible?: number | null } | undefined,
  groups: CanvasAssignmentGroup[]
): string[] {
  if (groups.length === 0) return [];
  const group =
    groups.find((candidate) => (candidate.assignments ?? []).some((a) => a.id === assignmentId)) ??
    (rawAssignment?.assignment_group_id
      ? groups.find((candidate) => candidate.id === rawAssignment.assignment_group_id)
      : undefined);
  if (!group) return [];
  const anyWeight = groups.some((candidate) => typeof candidate.group_weight === "number" && candidate.group_weight > 0);
  const weightText =
    anyWeight && typeof group.group_weight === "number"
      ? `${group.group_weight}% of the final grade`
      : "weight not set; final grade is by total points";
  const rules: string[] = [];
  if (group.rules?.drop_lowest) rules.push(`lowest ${group.rules.drop_lowest} dropped`);
  if (group.rules?.drop_highest) rules.push(`highest ${group.rules.drop_highest} dropped`);
  const lines = [`Assignment group: ${group.name} (${weightText}${rules.length ? `; ${rules.join(", ")}` : ""})`];
  const members = (group.assignments ?? []).filter((a) => !a.omit_from_final_grade);
  const total = members.reduce((sum, a) => sum + (a.points_possible ?? 0), 0);
  const own = members.find((a) => a.id === assignmentId)?.points_possible ?? rawAssignment?.points_possible ?? null;
  if (anyWeight && typeof group.group_weight === "number" && total > 0 && own) {
    lines.push(
      `Approximate share of the final grade: ${((own / total) * group.group_weight).toFixed(1)}% (${own} of ${total} points in ${group.name})`
    );
  }
  return lines;
}

function formatAssignmentText(
  assignment: AssignmentIndexEntry,
  rawAssignment?: RawAssignmentRecord,
  weightLines: string[] = []
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
  // Submission rules students ask about ("can I resubmit?", "is this a group
  // assignment?", "do I have to peer review?") live on the detail record.
  for (const line of formatSubmissionRules(rawAssignment)) {
    lines.push(line);
  }
  for (const line of weightLines) {
    lines.push(line);
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

function formatSubmissionRules(rawAssignment?: RawAssignmentRecord): string[] {
  if (!rawAssignment) return [];
  const lines: string[] = [];
  const attempts = rawAssignment.allowed_attempts;
  if (typeof attempts === "number") {
    lines.push(`Attempts allowed: ${attempts < 0 ? "unlimited" : String(attempts)}`);
  }
  if (rawAssignment.group_category_id) {
    lines.push(
      `Group assignment: yes${
        rawAssignment.grade_group_students_individually ? " (students graded individually)" : " (one grade per group)"
      }`
    );
  }
  if (rawAssignment.peer_reviews) {
    const count = rawAssignment.peer_review_count;
    lines.push(
      `Peer reviews: required${typeof count === "number" && count > 0 ? ` (${count} per student)` : ""}${
        rawAssignment.automatic_peer_reviews ? ", assigned automatically" : ""
      }`
    );
  }
  if (rawAssignment.anonymous_submissions) {
    lines.push("Anonymous submissions: yes");
  }
  if (rawAssignment.omit_from_final_grade) {
    lines.push("Counts toward final grade: no (omitted from the final grade)");
  }
  if (rawAssignment.published === false) {
    lines.push("Published: no (not yet visible to students)");
  }
  if (rawAssignment.lock_explanation) {
    lines.push(`Locked: ${rawAssignment.lock_explanation}`);
  }
  return lines;
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

/**
 * Where a post's attached files ended up on disk, keyed by Canvas file id and
 * by download URL (minus one-time query tokens), so an "Attachments:" line can
 * point a search hit on the post at the extracted file.
 */
export interface TopicAttachmentLookup {
  byFileId: Map<number, DownloadedAttachmentEntry>;
  byUrl: Map<string, DownloadedAttachmentEntry>;
}

export function buildTopicAttachmentLookup(
  attachments: DownloadedAttachmentEntry[]
): TopicAttachmentLookup {
  const lookup: TopicAttachmentLookup = { byFileId: new Map(), byUrl: new Map() };
  for (const attachment of attachments) {
    if (typeof attachment.canvasFileId === "number") {
      lookup.byFileId.set(attachment.canvasFileId, attachment);
    }
    lookup.byUrl.set(stripUrlQuery(attachment.downloadUrl), attachment);
  }
  return lookup;
}

function stripUrlQuery(url: string): string {
  const index = url.indexOf("?");
  return index === -1 ? url : url.slice(0, index);
}

function topicAttachmentName(attachment: CanvasTopicAttachment): string {
  return stripControlChars(
    attachment.display_name || attachment.filename || `file-${attachment.id}`
  );
}

/**
 * "name (attachments/announcements/name.pdf)" for files on disk, with a note
 * for files that failed or were never downloaded so the name is still searchable.
 */
export function describeTopicAttachment(
  attachment: CanvasTopicAttachment,
  lookup: TopicAttachmentLookup
): string {
  const name = topicAttachmentName(attachment);
  const entry =
    lookup.byFileId.get(attachment.id) ??
    (typeof attachment.url === "string"
      ? lookup.byUrl.get(stripUrlQuery(attachment.url))
      : undefined);
  if (!entry) return `${name} (not downloaded)`;
  if (entry.status === "failed") return `${name} (download failed)`;
  return `${name} (${entry.localPath})`;
}

function formatTopicAttachmentsLine(
  attachments: CanvasTopicAttachment[] | null | undefined,
  lookup: TopicAttachmentLookup,
  label = "Attachments"
): string {
  const described = (attachments ?? [])
    .filter((attachment): attachment is CanvasTopicAttachment => !!attachment)
    .map((attachment) => describeTopicAttachment(attachment, lookup));
  return described.length > 0 ? `${label}: ${described.join("; ")}` : "";
}

function formatDiscussionThreadText(
  thread: RawDiscussionThread,
  attachmentLookup: TopicAttachmentLookup = buildTopicAttachmentLookup([])
): string {
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
  const topicAttachments = formatTopicAttachmentsLine(
    thread.topic.attachments,
    attachmentLookup
  );
  if (topicAttachments) lines.push(topicAttachments);
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
      const replyAttachment = entry.attachment
        ? formatTopicAttachmentsLine([entry.attachment], attachmentLookup, "Attachment")
        : "";
      if (replyAttachment) {
        lines.push(replyAttachment);
        lines.push("");
      }
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
