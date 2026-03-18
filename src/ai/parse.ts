import type { AssignmentRealOverview } from "./types.js";

/**
 * Parse the model's JSON response into a structured overview.
 * Handles common parsing issues (markdown fencing, extra text).
 * Validates required fields and returns a safe result.
 */
export function parseOverviewResponse(raw: string): AssignmentRealOverview {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract JSON from the response
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error("Could not parse AI response as JSON");
    }
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI response is not a valid object");
  }

  const obj = parsed as Record<string, unknown>;

  const overview = typeof obj.overview === "string"
    ? obj.overview
    : "Unable to generate overview from available context.";

  const likelyTasks = Array.isArray(obj.likely_tasks)
    ? obj.likely_tasks.filter((t): t is string => typeof t === "string")
    : [];

  const dueDate = typeof obj.due_date === "string" ? obj.due_date : null;

  const primarySources = Array.isArray(obj.primary_sources)
    ? obj.primary_sources.filter((s): s is string => typeof s === "string")
    : [];

  const nextSteps = Array.isArray(obj.next_steps)
    ? obj.next_steps.filter((n): n is string => typeof n === "string")
    : [];

  const confidence = ["high", "medium", "low"].includes(obj.confidence as string)
    ? (obj.confidence as "high" | "medium" | "low")
    : "low";

  return {
    overview,
    likelyTasks,
    dueDate,
    primarySources,
    nextSteps,
    confidence,
  };
}
