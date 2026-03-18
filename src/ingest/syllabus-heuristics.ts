import type {
  CourseMetadata,
  FileIndexEntry,
  ModuleIndexEntry,
  PageIndexEntry,
  SyllabusCandidate,
} from "./types.js";

/**
 * Heuristic patterns for identifying syllabus/course outline sources.
 *
 * High confidence: exact keyword matches for syllabus, course outline
 * Medium confidence: schedule, calendar, grading scheme
 * Low confidence: weaker signals like "overview", "info"
 */
const SYLLABUS_PATTERNS: Array<{
  pattern: RegExp;
  confidence: "high" | "medium" | "low";
  reason: string;
}> = [
  { pattern: /\bsyllabus\b/i, confidence: "high", reason: "title contains 'syllabus'" },
  { pattern: /\bcourse\s*outline\b/i, confidence: "high", reason: "title contains 'course outline'" },
  { pattern: /\bcourse\s*schedule\b/i, confidence: "high", reason: "title contains 'course schedule'" },
  { pattern: /\bschedule\b/i, confidence: "medium", reason: "title contains 'schedule'" },
  { pattern: /\bcalendar\b/i, confidence: "medium", reason: "title contains 'calendar'" },
  { pattern: /\bgrading\s*(scheme|policy|breakdown)\b/i, confidence: "medium", reason: "title matches grading policy pattern" },
  { pattern: /\bcourse\s*info(rmation)?\b/i, confidence: "low", reason: "title contains 'course info'" },
  { pattern: /\bcourse\s*overview\b/i, confidence: "low", reason: "title contains 'course overview'" },
];

/**
 * Identify likely syllabus / course outline sources using deterministic heuristics.
 * Returns a ranked list of candidates.
 */
export function identifySyllabusCandidates(
  courseMeta: CourseMetadata,
  files: FileIndexEntry[],
  modules: ModuleIndexEntry[],
  pages: PageIndexEntry[]
): SyllabusCandidate[] {
  const candidates: SyllabusCandidate[] = [];

  // 1. Check course.syllabus_body
  if (courseMeta.syllabusBody && courseMeta.syllabusBody.trim().length > 50) {
    candidates.push({
      rank: 0,
      source: "syllabus_body",
      title: "Course Syllabus (built-in)",
      reason: "course.syllabus_body is present and non-trivial",
      resourceId: courseMeta.id,
      url: courseMeta.htmlUrl
        ? `${courseMeta.htmlUrl}/assignments/syllabus`
        : null,
      confidence: "high",
    });
  }

  // 2. Check files
  for (const file of files) {
    const match = matchTitle(file.displayName);
    if (match) {
      candidates.push({
        rank: 0,
        source: "file",
        title: file.displayName,
        reason: match.reason,
        resourceId: file.id,
        url: file.url,
        confidence: match.confidence,
      });
    }
  }

  // 3. Check module items
  for (const mod of modules) {
    for (const item of mod.items) {
      const match = matchTitle(item.title);
      if (match) {
        candidates.push({
          rank: 0,
          source: "module_item",
          title: `${item.title} (in ${mod.name})`,
          reason: match.reason,
          resourceId: item.contentId ?? item.id,
          url: item.htmlUrl,
          confidence: match.confidence,
        });
      }
    }
  }

  // 4. Check pages
  for (const page of pages) {
    const match = matchTitle(page.title);
    if (match) {
      candidates.push({
        rank: 0,
        source: "page",
        title: page.title,
        reason: match.reason,
        resourceId: page.pageId,
        url: page.htmlUrl,
        confidence: match.confidence,
      });
    }
  }

  // Sort by confidence (high first), then by source priority
  const confidenceOrder = { high: 0, medium: 1, low: 2 };
  const sourceOrder: Record<string, number> = {
    syllabus_body: 0,
    file: 1,
    module_item: 2,
    page: 3,
    assignment_link: 4,
  };

  candidates.sort((a, b) => {
    const confDiff = confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
    if (confDiff !== 0) return confDiff;
    return (sourceOrder[a.source] ?? 5) - (sourceOrder[b.source] ?? 5);
  });

  // Assign ranks
  candidates.forEach((c, i) => (c.rank = i + 1));

  return candidates;
}

function matchTitle(
  title: string
): { confidence: "high" | "medium" | "low"; reason: string } | null {
  for (const { pattern, confidence, reason } of SYLLABUS_PATTERNS) {
    if (pattern.test(title)) {
      return { confidence, reason };
    }
  }
  return null;
}
