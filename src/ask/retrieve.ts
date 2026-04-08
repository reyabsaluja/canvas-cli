import type { ContentChunk, LoadedWorkspace } from "./types.js";
import {
  loadArtifactIndex,
  searchArtifactSections,
  type ArtifactIndex,
  type ArtifactKind,
  type ArtifactSection,
} from "../knowledge/artifact-index.js";

export interface WorkspaceRetrievalContext {
  index: ArtifactIndex;
  chunks: ContentChunk[];
  chunksBySectionId: Map<string, ContentChunk>;
}

/**
 * Build a retrieval context for workspace answers from the shared knowledge store.
 * This keeps workspace chat and the ask command on the same artifact/section graph.
 */
export async function buildWorkspaceRetrievalContext(
  workspace: LoadedWorkspace
): Promise<WorkspaceRetrievalContext> {
  const index = await loadArtifactIndex({ workspace });
  const chunks = index.sections
    .filter((section) => section.scope === "workspace")
    .map(chunkFromSection);

  return {
    index,
    chunks,
    chunksBySectionId: new Map(
      chunks
        .filter((chunk): chunk is ContentChunk & { sectionId: string } =>
          typeof chunk.sectionId === "string"
        )
        .map((chunk) => [chunk.sectionId, chunk])
    ),
  };
}

/**
 * Retrieve the most relevant workspace sections using the shared artifact index.
 * Returns top-K sections mapped back to the ContentChunk shape for downstream consumers.
 */
export function retrieveRelevant(
  question: string,
  context: WorkspaceRetrievalContext,
  topK: number = 8
): ContentChunk[] {
  const trimmed = question.trim();
  if (!trimmed) {
    return context.chunks.slice(0, topK);
  }

  const rankedSections = searchArtifactSections(context.index, trimmed, {
    scope: "workspace",
    limit: topK,
  });

  return rankedSections.map(({ section, score }) => {
    const existing = context.chunksBySectionId.get(section.id);
    if (existing) {
      return {
        ...existing,
        excerpt: section.excerpt,
        score,
      };
    }

    return {
      ...chunkFromSection(section),
      score,
    };
  });
}

function chunkFromSection(section: ArtifactSection): ContentChunk {
  return {
    source: section.source,
    section: section.section,
    text: section.text,
    excerpt: section.excerpt,
    kind: mapArtifactKindToChunkKind(section.kind),
    artifactId: section.artifactId,
    sectionId: section.id,
    searchTokens: section.tokens,
    scoreBoost: section.scoreBoost,
  };
}

function mapArtifactKindToChunkKind(kind: ArtifactKind): string {
  switch (kind) {
    case "workup":
      return "workup";
    case "assignment":
      return "assignment";
    case "plan":
      return "plan";
    case "notes":
      return "notes";
    case "extracted":
      return "extracted";
    default:
      return kind;
  }
}
