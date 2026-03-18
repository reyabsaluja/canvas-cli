import { htmlToText } from "../format/html-to-text.js";
import type { EnrichmentFlags, ContextConfidence } from "./types.js";

/**
 * Weak description detection.
 *
 * An assignment description is considered "weak" if:
 * 1. It is null or empty
 * 2. After HTML stripping, it has fewer than 30 characters of real text
 * 3. It consists only of links (no explanatory prose)
 * 4. It matches known generic submit-only patterns
 */
export function isWeakDescription(descriptionHtml: string | null): boolean {
  if (!descriptionHtml) return true;

  const text = htmlToText(descriptionHtml).trim();

  // Empty or very short
  if (text.length < 30) return true;

  // Check if it's mostly just links with no explanatory text
  // Strip URLs and link references, see what's left
  const withoutUrls = text
    .replace(/https?:\/\/[^\s)]+/g, "")
    .replace(/\([^)]*\)/g, "")
    .trim();
  if (withoutUrls.length < 20) return true;

  // Known generic patterns
  const genericPatterns = [
    /^submit\s+(your|the)/i,
    /^upload\s+(your|the)/i,
    /^this\s+is\s+(where|the\s+submission)/i,
    /^please\s+submit/i,
    /^no\s+description/i,
  ];
  for (const pattern of genericPatterns) {
    if (pattern.test(text)) return true;
  }

  return false;
}

/**
 * Submission shell detection.
 *
 * An assignment is likely a "submission shell" if:
 * 1. Its Canvas description is weak/blank AND
 * 2. Its title suggests a submission portal (contains "submit", "upload", "dropbox", "grade")
 *    OR there are strong related module/page/file matches suggesting instructions live elsewhere
 *
 * The relatedCount is the number of related resources found during enrichment.
 */
const SUBMISSION_SHELL_PATTERNS = [
  /\bsubmit\b/i,
  /\bsubmission\b/i,
  /\bupload\b/i,
  /\bdropbox\b/i,
  /\bgrade\b/i,
  /\bgrading\b/i,
  /\bsubmit\s+here\b/i,
];

export function isLikelySubmissionShell(
  assignmentName: string,
  descriptionHtml: string | null,
  relatedCount: number
): boolean {
  if (!isWeakDescription(descriptionHtml)) return false;

  // Title suggests submission portal
  for (const pattern of SUBMISSION_SHELL_PATTERNS) {
    if (pattern.test(assignmentName)) return true;
  }

  // Weak description + strong related context = likely shell
  if (relatedCount >= 2) return true;

  return false;
}

/**
 * Compute enrichment flags for an assignment.
 */
export function computeFlags(
  assignmentName: string,
  descriptionHtml: string | null,
  dueAt: Date | null,
  relatedCount: number
): EnrichmentFlags {
  return {
    hasWeakCanvasDescription: isWeakDescription(descriptionHtml),
    missingDueDate: dueAt === null,
    likelySubmissionShell: isLikelySubmissionShell(
      assignmentName,
      descriptionHtml,
      relatedCount
    ),
  };
}

/**
 * Confidence scoring.
 *
 * Deterministic scoring based on:
 * - Number of related resources found (module items, pages, files, attachments)
 * - Whether downloaded attachments exist for this assignment
 * - Whether description is strong (non-weak)
 *
 * Scoring:
 * - "high": strong description + related resources, OR 3+ related resources
 * - "medium": some related resources (1-2), or strong description alone
 * - "low": weak description, few/no related resources
 * - "none": no enrichment data available at all
 */
export function computeConfidence(
  hasWeakDescription: boolean,
  relatedResourceCount: number,
  hasDownloadedAttachments: boolean
): ContextConfidence {
  // Strong description with related resources
  if (!hasWeakDescription && relatedResourceCount >= 1) return "high";

  // Many related resources regardless of description
  if (relatedResourceCount >= 3) return "high";

  // Some related resources or downloaded attachments
  if (relatedResourceCount >= 1 || hasDownloadedAttachments) return "medium";

  // Strong description alone
  if (!hasWeakDescription) return "medium";

  return "low";
}
