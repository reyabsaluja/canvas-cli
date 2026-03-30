import { CanvasClient } from "../canvas/client.js";
import { loadConfig } from "../config/env.js";
import { resolveAssignment } from "../domain/resolve-assignment.js";
import { renderAssignmentDetail } from "../format/render-assignment-detail.js";
import { loadCourseCache } from "../enrich/cache-loader.js";
import { enrichAssignmentDetail } from "../enrich/enrich-assignment.js";
import type { EnrichedAssignmentDetail } from "../enrich/types.js";
import { generateAssignmentOverview } from "../ai/generate-overview.js";
import { handleError } from "../errors.js";
import chalk from "chalk";

interface ShowAssignmentOptions {
  course?: string;
  id?: string;
  json?: boolean;
  smart?: boolean;
}

export async function showAssignmentCommand(
  name: string,
  options: ShowAssignmentOptions
): Promise<void> {
  const config = loadConfig();
  const client = new CanvasClient(config);

  let rawCourses;
  try {
    rawCourses = await client.getCourses();
  } catch (err) {
    handleError(err);
    return;
  }

  try {
    const { detail, course } = await resolveAssignment(name, options, client, rawCourses);

    // Try to enrich with course cache
    const cache = await loadCourseCache(course.courseCode, course.id);
    const enriched = cache
      ? enrichAssignmentDetail(detail, cache)
      : detail;

    // Generate AI overview if --smart
    let aiOverview = null;
    let aiError: string | null = null;

    if (options.smart) {
      const enrichment = "enrichment" in enriched ? (enriched as EnrichedAssignmentDetail).enrichment : null;
      const result = await generateAssignmentOverview(detail, enrichment, cache);
      aiOverview = result.overview;
      aiError = result.error;
    }

    if (options.json) {
      const output: Record<string, unknown> = { ...enriched };
      if (options.smart) {
        output.realOverview = aiOverview ?? null;
        if (aiError) output.realOverviewError = aiError;
      }
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(renderAssignmentDetail(enriched, aiOverview, aiError));
    }
  } catch (err) {
    handleError(err);
  }
}
