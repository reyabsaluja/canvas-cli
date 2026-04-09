import type { AnswerSource } from "../ask/types.js";
import type { LoadedWorkspace } from "../ask/types.js";
import type { Observation } from "./observation.js";

export interface VerificationResult {
  ok: boolean;
  confidence: "high" | "medium" | "low";
  sources: AnswerSource[];
  missing: string[];
}

export interface VerifyWorkspaceAnswerInput {
  answer: string;
  observations: Observation[];
  usedWorkup: boolean;
  loaded: LoadedWorkspace;
}

export function verifyWorkspaceAnswer(
  input: VerifyWorkspaceAnswerInput
): VerificationResult {
  const trimmedAnswer = input.answer.trim();
  const sources = collectSources(input.observations, input.usedWorkup, input.loaded);
  const missing: string[] = [];

  if (!trimmedAnswer) {
    missing.push("answer");
  }

  if (input.observations.length > 0 && sources.length === 0) {
    missing.push("source");
  }

  const hasDirectRead = input.observations.some(
    (observation) => observation.tool === "read_file" && observation.status === "ok"
  );

  return {
    ok: missing.length === 0,
    confidence: hasDirectRead ? "high" : sources.length > 0 ? "medium" : "low",
    sources,
    missing,
  };
}

function collectSources(
  observations: Observation[],
  usedWorkup: boolean,
  loaded: LoadedWorkspace
): AnswerSource[] {
  const resolved: AnswerSource[] = [];
  const seen = new Set<string>();

  for (const observation of observations) {
    // Only successful tool observations count as evidence. Failed lookups like
    // missing_text/not_found should never create grounding-looking citations.
    if (observation.status !== "ok") {
      continue;
    }
    for (const artifact of observation.artifacts) {
      const key = `${artifact.kind}:${artifact.title}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      resolved.push({
        title: artifact.title,
        kind: artifact.kind,
        excerpt: artifact.excerpt ?? buildExcerpt(observation.content ?? observation.summary),
      });
    }
  }

  if (resolved.length === 0 && usedWorkup && loaded.workupJson) {
    const overview = (loaded.workupJson.overview as string | undefined) ?? null;
    resolved.push({
      title: "workup.json",
      kind: "workup",
      excerpt: overview ?? "Pre-loaded assignment workup context.",
    });
  }

  return resolved;
}

function buildExcerpt(value: string | undefined): string | null {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return null;
  }
  if (cleaned.length <= 160) {
    return cleaned;
  }
  return `${cleaned.slice(0, 157)}...`;
}
