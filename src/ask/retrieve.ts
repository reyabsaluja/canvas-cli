import type { LoadedWorkspace, ContentChunk } from "./types.js";
import {
  loadArtifactIndex,
  type ArtifactKind,
} from "../knowledge/artifact-index.js";

/**
 * Build content chunks from workspace artifacts.
 * Splits markdown into sections, flattens workup JSON fields,
 * and includes extracted document text.
 */
export async function buildChunks(ws: LoadedWorkspace): Promise<ContentChunk[]> {
  const index = await loadArtifactIndex({ workspace: ws });
  return index.sections
    .filter((section) => section.scope === "workspace")
    .map((section) => ({
      source: section.source,
      section: section.section,
      text: section.text,
      kind: mapArtifactKindToChunkKind(section.kind),
      artifactId: section.artifactId,
      sectionId: section.id,
      searchTokens: section.tokens,
      scoreBoost: section.scoreBoost,
    }));
}

/**
 * Retrieve the most relevant chunks for a question using BM25-style keyword scoring.
 * Returns top-K chunks sorted by relevance.
 */
export function retrieveRelevant(
  question: string,
  chunks: ContentChunk[],
  topK: number = 8
): ContentChunk[] {
  const queryTokens = tokenize(question);
  if (queryTokens.length === 0) return chunks.slice(0, topK);

  // IDF: how rare each query token is across chunks
  const docCount = chunks.length;
  const averageLength =
    docCount > 0
      ? chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) / docCount
      : 1;
  const df = new Map<string, number>();
  for (const chunk of chunks) {
    const chunkTokens = new Set(
      chunk.searchTokens ?? tokenize(chunk.text + " " + chunk.section)
    );
    for (const qt of queryTokens) {
      if (chunkTokens.has(qt)) {
        df.set(qt, (df.get(qt) ?? 0) + 1);
      }
    }
  }

  // Score each chunk
  const scored = chunks.map((chunk) => {
    const text = (chunk.text + " " + chunk.section).toLowerCase();
    const chunkTokens = chunk.searchTokens ?? tokenize(text);
    const tokenSet = new Set(chunkTokens);
    let score = 0;

    for (const qt of queryTokens) {
      if (!tokenSet.has(qt)) continue;

      // Term frequency
      const tf = chunkTokens.filter((t) => t === qt).length;
      // Inverse document frequency
      const docFreq = df.get(qt) ?? 1;
      const idf = Math.log((docCount + 1) / (docFreq + 0.5));
      // BM25-style scoring (k1=1.5, b=0.75)
      const norm = 1 - 0.75 + 0.75 * (chunk.text.length / averageLength);
      score += idf * ((tf * 2.5) / (tf + 1.5 * norm));
    }

    // Boost workup chunks slightly (structured, high-signal)
    if (chunk.kind === "workup") score *= 1.2;
    if (typeof chunk.scoreBoost === "number") score *= chunk.scoreBoost;

    return { chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.chunk);
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

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}
