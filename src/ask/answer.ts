import type { ContentChunk } from "./types.js";
import type { WorkspaceAnswer } from "./types.js";
import { callModel, type AIProviderConfig } from "../ai/provider.js";

const SYSTEM_PROMPT = `You are an assignment workspace assistant. You answer questions about a specific assignment using only the workspace context provided to you.

Rules:
- Answer ONLY from the provided context. Do not invent facts.
- Be concise and direct.
- If the context doesn't contain the answer, say so clearly.
- Distinguish between confirmed information (from instruction docs) and inferred information (from syllabus/schedule/patterns).
- Use bullet points for lists of items.
- Cite which source each key fact comes from.

Respond with valid JSON:
{
  "answer": "string — direct answer to the question (2-4 sentences)",
  "bullet_points": ["string — key specific points relevant to the question"],
  "sources": [{"title": "string — source filename or section", "kind": "string — workup|plan|extracted|assignment|notes", "excerpt": "string or null — short relevant quote if applicable"}],
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
  const userMessage = buildUserMessage(question, context);
  const rawResponse = await callModel(config, SYSTEM_PROMPT, userMessage);
  return parseResponse(question, rawResponse);
}

function buildUserMessage(question: string, chunks: ContentChunk[]): string {
  const sections: string[] = [];

  sections.push(`## Question\n${question}\n`);
  sections.push("## Workspace context\n");

  for (const chunk of chunks) {
    sections.push(`### [${chunk.kind}] ${chunk.source} — ${chunk.section}`);
    sections.push(chunk.text);
    sections.push("");
  }

  sections.push("Answer the question using only the context above.");

  return sections.join("\n");
}

function parseResponse(question: string, raw: string): WorkspaceAnswer {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      // Fallback: treat raw text as the answer
      return {
        question,
        answer: cleaned,
        bulletPoints: [],
        sources: [],
        confidence: "low",
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

  const sources = Array.isArray(obj.sources)
    ? obj.sources
        .filter((x) => x && typeof x === "object")
        .map((x: any) => ({
          title: typeof x.title === "string" ? x.title : "",
          kind: typeof x.kind === "string" ? x.kind : "unknown",
          excerpt: typeof x.excerpt === "string" ? x.excerpt : null,
        }))
    : [];

  const confidence = ["high", "medium", "low"].includes(
    obj.confidence as string
  )
    ? (obj.confidence as "high" | "medium" | "low")
    : "medium";

  return { question, answer, bulletPoints, sources, confidence };
}
