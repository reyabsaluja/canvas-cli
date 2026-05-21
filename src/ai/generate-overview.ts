import type { AssignmentDetail } from "../domain/models.js";
import type { EnrichmentSummary } from "../enrich/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import type { AssignmentRealOverview } from "./types.js";
import {
  getAIConfig,
  callModel,
  classifyAIError,
  AI_PROVIDER_SETUP_HINT,
} from "./provider.js";
import { buildContextBundle } from "./context-bundle.js";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompts.js";
import { parseOverviewResponse } from "./parse.js";

export interface OverviewResult {
  overview: AssignmentRealOverview | null;
  error: string | null;
}

/**
 * Generate an AI-powered assignment overview.
 *
 * Pipeline:
 * 1. Check for AI API key
 * 2. Build context bundle from assignment + enrichment + cache
 * 3. Call the model once with grounded prompt
 * 4. Parse structured response
 * 5. Return result or graceful error with actionable guidance
 */
export async function generateAssignmentOverview(
  detail: AssignmentDetail,
  enrichment: EnrichmentSummary | null,
  cache: CourseCache | null
): Promise<OverviewResult> {
  const aiConfig = getAIConfig();
  if (!aiConfig) {
    return {
      overview: null,
      error: `AI overview unavailable: no AI provider configured. ${AI_PROVIDER_SETUP_HINT}`,
    };
  }

  try {
    const bundle = await buildContextBundle(detail, enrichment, cache);
    const userMessage = buildUserMessage(bundle);
    const rawResponse = await callModel(aiConfig, SYSTEM_PROMPT, userMessage);
    const overview = parseOverviewResponse(rawResponse);

    return { overview, error: null };
  } catch (err) {
    const classified = classifyAIError(err);
    return {
      overview: null,
      error: `AI overview failed: ${classified.userMessage}`,
    };
  }
}
