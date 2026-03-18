import type { Assignment, AssignmentDetail } from "../domain/models.js";
import type { CourseCache } from "./cache-loader.js";
import type {
  EnrichmentSummary,
  RelatedModuleItem,
  RelatedPage,
  RelatedFile,
  RelatedAttachment,
  InstructionSourceHint,
  EnrichedAssignment,
  EnrichedAssignmentDetail,
} from "./types.js";
import { matchTitles } from "./matchers.js";
import { computeFlags, computeConfidence } from "./scoring.js";

/**
 * Enrich a list-level assignment with context from the course cache.
 * Returns the assignment with an enrichment summary attached.
 */
export function enrichAssignment(
  assignment: Assignment,
  cache: CourseCache
): EnrichedAssignment {
  const enrichment = buildEnrichment(
    assignment.name,
    null, // no description at list level
    assignment.dueAt,
    cache
  );
  return { ...assignment, enrichment };
}

/**
 * Enrich a detail-level assignment with context from the course cache.
 */
export function enrichAssignmentDetail(
  detail: AssignmentDetail,
  cache: CourseCache
): EnrichedAssignmentDetail {
  const enrichment = buildEnrichment(
    detail.name,
    detail.description,
    detail.dueAt,
    cache
  );
  return { ...detail, enrichment };
}

/**
 * Core enrichment logic. Finds related resources, computes flags and confidence.
 */
function buildEnrichment(
  assignmentName: string,
  descriptionHtml: string | null,
  dueAt: Date | null,
  cache: CourseCache
): EnrichmentSummary {
  const notes: string[] = [];

  // Find related module items
  const relatedModuleItems: RelatedModuleItem[] = [];
  for (const mod of cache.modules) {
    for (const item of mod.items) {
      // Skip Assignment-type items that are the assignment itself
      if (item.type === "Assignment") continue;

      const match = matchTitles(assignmentName, item.title);
      if (match.strength >= 1) {
        relatedModuleItems.push({
          moduleId: mod.id,
          moduleName: mod.name,
          itemId: item.id,
          title: item.title,
          type: item.type,
          htmlUrl: item.htmlUrl,
          matchReason: match.reason,
        });
      }
    }
  }

  // Find related pages
  const relatedPages: RelatedPage[] = [];
  for (const page of cache.pages) {
    const match = matchTitles(assignmentName, page.title);
    if (match.strength >= 1) {
      relatedPages.push({
        pageId: page.pageId,
        title: page.title,
        htmlUrl: page.htmlUrl,
        matchReason: match.reason,
      });
    }
  }

  // Find related files
  const relatedFiles: RelatedFile[] = [];
  for (const file of cache.files) {
    const match = matchTitles(assignmentName, file.displayName);
    if (match.strength >= 1) {
      relatedFiles.push({
        fileId: file.id,
        displayName: file.displayName,
        contentType: file.contentType,
        size: file.size,
        url: file.url,
        matchReason: match.reason,
      });
    }
  }

  // Find related downloaded attachments
  const relatedAttachments: RelatedAttachment[] = [];
  for (const att of cache.attachments) {
    if (att.status !== "downloaded" && att.status !== "skipped") continue;
    const match = matchTitles(assignmentName, att.originalFilename);
    if (match.strength >= 1) {
      relatedAttachments.push({
        filename: att.originalFilename,
        localPath: att.localPath,
        sourceType: att.sourceType,
        matchReason: match.reason,
      });
    }
  }

  const totalRelated =
    relatedModuleItems.length +
    relatedPages.length +
    relatedFiles.length +
    relatedAttachments.length;

  // Compute flags
  const flags = computeFlags(
    assignmentName,
    descriptionHtml,
    dueAt,
    totalRelated
  );

  // Build instruction source hints — ranked by relevance
  const likelyInstructionSources: InstructionSourceHint[] = [];

  // Downloaded attachments are highest priority (local access)
  for (const att of relatedAttachments) {
    likelyInstructionSources.push({
      type: "attachment",
      title: att.filename,
      url: null,
      localPath: att.localPath,
      reason: att.matchReason,
    });
  }

  // Module items (File/Page type are most useful)
  const sortedModItems = [...relatedModuleItems].sort((a, b) => {
    const typeOrder: Record<string, number> = { File: 0, Page: 1, ExternalUrl: 2 };
    return (typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3);
  });
  for (const item of sortedModItems) {
    likelyInstructionSources.push({
      type: "module_item",
      title: `${item.title} (${item.type} in ${item.moduleName})`,
      url: item.htmlUrl,
      localPath: null,
      reason: item.matchReason,
    });
  }

  // Files
  for (const file of relatedFiles) {
    likelyInstructionSources.push({
      type: "file",
      title: file.displayName,
      url: file.url,
      localPath: null,
      reason: file.matchReason,
    });
  }

  // Pages
  for (const page of relatedPages) {
    likelyInstructionSources.push({
      type: "page",
      title: page.title,
      url: page.htmlUrl,
      localPath: null,
      reason: page.matchReason,
    });
  }

  // Compute confidence
  const hasDownloaded = relatedAttachments.length > 0;
  const contextConfidence = computeConfidence(
    flags.hasWeakCanvasDescription,
    totalRelated,
    hasDownloaded
  );

  // Build notes
  if (flags.hasWeakCanvasDescription) {
    notes.push("Canvas description appears incomplete or missing");
  }
  if (flags.likelySubmissionShell) {
    notes.push("This may be a submission-only endpoint; instructions likely live elsewhere");
  }
  if (flags.missingDueDate) {
    notes.push("No due date set on Canvas");
  }
  if (totalRelated > 0) {
    notes.push(
      `Found ${totalRelated} related resource${totalRelated > 1 ? "s" : ""} in course cache`
    );
  }

  return {
    flags,
    contextConfidence,
    relatedModuleItems,
    relatedPages,
    relatedFiles,
    relatedAttachments,
    likelyInstructionSources,
    notes,
  };
}
