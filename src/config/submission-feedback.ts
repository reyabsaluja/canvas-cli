import { getActiveProfile } from "./env.js";
import { readStoredConfig } from "./store.js";

/**
 * Whether ingestion should capture the student's own grader feedback
 * (submission comments, feedback files, rubric assessments). On by default;
 * `canvas-cli ingest --no-feedback` or `"ingestSubmissionFeedback": false` in
 * the profile's config.json turns it off. Every ingest entry point (the CLI
 * command, the TUI's ingest/refresh, and workspace creation) resolves it here
 * so the stored toggle is honoured everywhere.
 */
export function resolveIncludeSubmissionFeedback(cliFlag?: boolean): boolean {
  if (cliFlag === false) return false;
  let stored: ReturnType<typeof readStoredConfig> = null;
  try {
    stored = readStoredConfig(getActiveProfile());
  } catch {
    stored = null;
  }
  return stored?.ingestSubmissionFeedback !== false;
}
