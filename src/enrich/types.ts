import type { Assignment, AssignmentDetail } from "../domain/models.js";

export type ContextConfidence = "high" | "medium" | "low" | "none";

export interface RelatedModuleItem {
  moduleId: number;
  moduleName: string;
  itemId: number;
  title: string;
  type: string;
  htmlUrl: string | null;
  matchReason: string;
}

export interface RelatedPage {
  pageId: string;
  title: string;
  htmlUrl: string | null;
  matchReason: string;
}

export interface RelatedFile {
  fileId: number;
  displayName: string;
  contentType: string;
  size: number;
  url: string;
  matchReason: string;
}

export interface RelatedAttachment {
  filename: string;
  localPath: string;
  sourceType: string;
  matchReason: string;
}

export interface InstructionSourceHint {
  type: "module_item" | "page" | "file" | "attachment";
  title: string;
  url: string | null;
  localPath: string | null;
  reason: string;
}

export interface EnrichmentFlags {
  hasWeakCanvasDescription: boolean;
  missingDueDate: boolean;
  likelySubmissionShell: boolean;
}

export interface EnrichmentSummary {
  flags: EnrichmentFlags;
  contextConfidence: ContextConfidence;
  relatedModuleItems: RelatedModuleItem[];
  relatedPages: RelatedPage[];
  relatedFiles: RelatedFile[];
  relatedAttachments: RelatedAttachment[];
  likelyInstructionSources: InstructionSourceHint[];
  notes: string[];
}

/** Assignment list item with optional enrichment. */
export interface EnrichedAssignment extends Assignment {
  enrichment: EnrichmentSummary | null;
}

/** Assignment detail with optional enrichment. */
export interface EnrichedAssignmentDetail extends AssignmentDetail {
  enrichment: EnrichmentSummary | null;
}
