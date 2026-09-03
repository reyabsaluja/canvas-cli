import type { ContentChunk, WorkspaceAnswer } from "./types.js";
import { callModel, type AIProviderConfig } from "../ai/provider.js";
import {
  buildUnsupportedClaimsNote,
  findUnsupportedAnswerClaims,
} from "../agent/verify.js";

const SYSTEM_PROMPT = `You are an assignment workspace assistant. You answer questions about a specific assignment using only the workspace context provided to you.

Rules:
- Answer ONLY from the provided context. Do not invent facts.
- Be concise and direct.
- If the context doesn't contain the answer, say so clearly.
- Distinguish between confirmed information (from instruction docs) and inferred information (from syllabus/schedule/patterns).
- Use bullet points for lists of items.
- Cite evidence using the exact "ref" ids from the context blocks that support the answer.

Respond with valid JSON:
{
  "answer": "string — direct answer to the question (2-4 sentences)",
  "bullet_points": ["string — key specific points relevant to the question"],
  "source_ids": ["string — exact ref ids copied from the context blocks"],
  "confidence": "high | medium | low"
}

Return ONLY the JSON object.`;

/**
 * Generate a grounded answer to a workspace question.
 */
export async function answerQuestion(
  config: AIProviderConfig,
  question: string,
  context: ContentChunk[]
): Promise<WorkspaceAnswer> {
  const userMessage = buildWorkspaceQuestionMessage(question, context);
  const rawResponse = await callModel(config, SYSTEM_PROMPT, userMessage);
  return parseWorkspaceAnswerResponse(question, rawResponse, context);
}

export function buildWorkspaceQuestionMessage(
  question: string,
  chunks: ContentChunk[]
): string {
  const sections: string[] = [];

  sections.push(`## Question\n${question}\n`);
  sections.push("## Workspace context\n");

  for (const chunk of chunks) {
    const refId = getChunkReferenceId(chunk);
    sections.push(
      `### [ref:${refId}] [${chunk.kind}] ${chunk.source} — ${chunk.section}`
    );
    sections.push(`Reference ID: ${refId}`);
    if (chunk.excerpt) {
      sections.push(`Excerpt: ${chunk.excerpt}`);
    }
    sections.push(chunk.text);
    sections.push("");
  }

  sections.push("Answer the question using only the context above.");

  return sections.join("\n");
}

export function parseWorkspaceAnswerResponse(
  question: string,
  raw: string,
  context: ContentChunk[]
): WorkspaceAnswer {
  const cleaned = stripMarkdownFence(raw);
  const fallbackSources = buildFallbackSources(context);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        return {
          question,
          answer: cleaned,
          bulletPoints: [],
          sources: fallbackSources,
          confidence: "low",
          verificationNote: null,
        };
      }
    } else {
      return {
        question,
        answer: cleaned,
        bulletPoints: [],
        sources: fallbackSources,
        confidence: "low",
        verificationNote: null,
      };
    }
  }

  const obj = parsed as Record<string, unknown>;

  const answer =
    typeof obj.answer === "string"
      ? obj.answer
      : "Could not generate an answer from workspace context.";

  const bulletPoints = Array.isArray(obj.bullet_points)
    ? obj.bullet_points.filter((x): x is string => typeof x === "string")
    : [];

  const sourceIds = Array.isArray(obj.source_ids)
    ? obj.source_ids.filter((x): x is string => typeof x === "string")
    : [];

  const sources = resolveSources(context, sourceIds, obj.sources, fallbackSources);

  const reportedConfidence = ["high", "medium", "low"].includes(
    obj.confidence as string
  )
    ? (obj.confidence as "high" | "medium" | "low")
    : "medium";

  // The model grades its own confidence; check its figures against the
  // context it was given before passing that grade on to the student.
  const evidenceText = context
    .map((chunk) => [chunk.section, chunk.excerpt ?? "", chunk.text].join("\n"))
    .join("\n");
  const unsupportedClaims = findUnsupportedAnswerClaims(
    [answer, ...bulletPoints].join("\n"),
    evidenceText,
    question
  );
  const confidence =
    unsupportedClaims.length > 0
      ? reportedConfidence === "high"
        ? "medium"
        : "low"
      : reportedConfidence;

  return {
    question,
    answer,
    bulletPoints,
    sources,
    confidence,
    verificationNote:
      unsupportedClaims.length > 0
        ? buildUnsupportedClaimsNote(unsupportedClaims, sources)
        : null,
  };
}

function stripMarkdownFence(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "");
  }
  return cleaned;
}

function resolveSources(
  context: ContentChunk[],
  sourceIds: string[],
  legacySources: unknown,
  fallbackSources: WorkspaceAnswer["sources"]
): WorkspaceAnswer["sources"] {
  const sectionsByRef = new Map(
    context.map((chunk) => [getChunkReferenceId(chunk), chunk] as const)
  );

  const resolved: WorkspaceAnswer["sources"] = [];
  const seen = new Set<string>();
  const addChunk = (chunk: ContentChunk | undefined): void => {
    if (!chunk) return;
    const source = buildAnswerSourceFromChunk(chunk);
    const key = `${source.kind}:${source.title}:${source.section ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    resolved.push(source);
  };

  for (const sourceId of sourceIds) {
    addChunk(sectionsByRef.get(normalizeReferenceId(sourceId)));
  }

  if (resolved.length === 0 && Array.isArray(legacySources)) {
    for (const source of legacySources) {
      if (!source || typeof source !== "object") continue;
      const title =
        typeof (source as Record<string, unknown>).title === "string"
          ? ((source as Record<string, unknown>).title as string)
          : "";
      const match = context.find((chunk) => {
        const sourceTitle = formatLegacySourceTitle(chunk);
        const chunkSection = normalizeSourceSection(chunk.section);
        const sourceSection =
          typeof (source as Record<string, unknown>).section === "string"
            ? ((source as Record<string, unknown>).section as string).trim()
            : "";
        return (
          chunk.source === title ||
          sourceTitle === title ||
          `${chunk.source} / ${chunk.section}` === title ||
          (chunkSection !== null &&
            title === chunk.source &&
            sourceSection.length > 0 &&
            sourceSection === chunkSection)
        );
      });
      addChunk(match);
    }
  }

  return resolved.length > 0 ? resolved : fallbackSources;
}

function buildFallbackSources(
  context: ContentChunk[]
): WorkspaceAnswer["sources"] {
  return context.slice(0, 3).map((chunk) => buildAnswerSourceFromChunk(chunk));
}

function buildAnswerSourceFromChunk(
  chunk: ContentChunk
): WorkspaceAnswer["sources"][number] {
  const section = normalizeSourceSection(chunk.section);
  return {
    title: chunk.source,
    kind: chunk.kind,
    ...(section ? { section } : {}),
    excerpt: chunk.excerpt ?? buildExcerpt(chunk.text),
  };
}

function formatLegacySourceTitle(chunk: ContentChunk): string {
  const section = normalizeSourceSection(chunk.section);
  if (!section) {
    return chunk.source;
  }
  return `${chunk.source} — ${section}`;
}

function getChunkReferenceId(chunk: ContentChunk): string {
  return chunk.sectionId ?? `${chunk.source}::${chunk.section}`;
}

function normalizeReferenceId(value: string): string {
  return value
    .trim()
    .replace(/^\[?ref:/i, "")
    .replace(/\]$/, "")
    .trim();
}

function buildExcerpt(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 140) return cleaned;
  return `${cleaned.slice(0, 137)}...`;
}

function normalizeSourceSection(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim();
  if (!normalized || normalized === "Full text" || normalized === "Top") {
    return null;
  }
  return normalized;
}
