import { CanvasClient } from "../canvas/client.js";
import { loadConfig } from "../config/env.js";
import { resolveAssignment } from "../domain/resolve-assignment.js";
import { loadCourseCache } from "../enrich/cache-loader.js";
import { enrichAssignmentDetail } from "../enrich/enrich-assignment.js";
import { getAIConfig } from "../ai/provider.js";
import { runInvestigation } from "../work/orchestrator.js";
import { createWorkWorkspace } from "../workspace/create.js";
import { handleError } from "../errors.js";
import chalk from "chalk";
import path from "node:path";

interface WorkOptions {
  course?: string;
  id?: string;
}

export async function workCommand(
  name: string,
  options: WorkOptions
): Promise<void> {
  // Check AI config first
  const aiConfig = getAIConfig();
  if (!aiConfig) {
    console.error(
      "Error: ANTHROPIC_API_KEY is not set.\nThe work command requires AI. Add ANTHROPIC_API_KEY to your .env file."
    );
    process.exit(1);
  }

  const config = loadConfig();
  const client = new CanvasClient(config);

  // Phase 1: Resolve assignment
  logPhase("resolving assignment");

  let rawCourses;
  try {
    rawCourses = await client.getCourses();
  } catch (err) {
    handleError(err);
    return;
  }

  let resolved;
  try {
    resolved = await resolveAssignment(name, options, client, rawCourses);
  } catch (err) {
    handleError(err);
    return;
  }

  const { detail, course } = resolved;
  logPhase(`found: ${detail.name}`);

  // Phase 2: Load course cache
  logPhase("loading course cache");

  const cache = await loadCourseCache(course.courseCode, course.id);
  if (!cache) {
    console.error(
      `\nNo ingestion cache found for ${course.courseCode}.\n` +
        chalk.dim(`Run: canvas-cli ingest ${options.course ?? course.courseCode}\n`) +
        chalk.dim("The work command needs ingested course data to investigate.\n")
    );
    process.exit(1);
  }

  // Phase 3: Deterministic enrichment
  logPhase("enriching assignment context");
  const enriched = enrichAssignmentDetail(detail, cache);

  // Phase 4: Run investigation agent
  logPhase("starting investigation agent");

  let investigation;
  try {
    investigation = await runInvestigation(
      aiConfig,
      detail,
      course,
      enriched.enrichment,
      cache,
      client,
      config,
      (phase) => logPhase(phase)
    );
  } catch (err) {
    if (err instanceof Error) {
      console.error(`\nInvestigation failed: ${err.message}`);
    } else {
      console.error("\nInvestigation failed.");
    }
    process.exit(1);
  }

  const { workup, state } = investigation;

  // Phase 5: Create workspace
  logPhase("creating workspace");

  let result;
  try {
    result = await createWorkWorkspace(detail, course, workup, state, config);
  } catch (err) {
    if (err instanceof Error) {
      console.error(`\nFailed to create workspace: ${err.message}`);
    } else {
      console.error("\nFailed to create workspace.");
    }
    process.exit(1);
  }

  // Phase 6: Render summary
  const relativePath = path.relative(process.cwd(), result.workspacePath);

  console.log("");
  console.log(chalk.bold.green("Workspace ready"));
  console.log("");
  console.log(`  ${chalk.dim("Assignment")}  ${detail.name}`);
  console.log(`  ${chalk.dim("Course    ")}  ${course.name}`);
  console.log(`  ${chalk.dim("Path      ")}  ${relativePath}`);
  console.log(`  ${chalk.dim("Confidence")}  ${formatConfidence(workup.confidence)}`);
  console.log("");

  // Files created
  console.log("Generated:");
  for (const f of result.filesWritten) {
    console.log(`  ${chalk.dim("-")} ${f}`);
  }
  if (result.filesSkipped.length > 0) {
    console.log("Preserved:");
    for (const f of result.filesSkipped) {
      console.log(`  ${chalk.dim("-")} ${f} ${chalk.dim("(already exists)")}`);
    }
  }

  // Action plan preview
  if (workup.actionPlan.length > 0) {
    console.log("");
    console.log(chalk.bold("Next steps:"));
    const preview = workup.actionPlan.slice(0, 3);
    for (const step of preview) {
      console.log(`  ${step.step}. ${step.action}`);
    }
    if (workup.actionPlan.length > 3) {
      console.log(chalk.dim(`  ... ${workup.actionPlan.length - 3} more in plan.md`));
    }
  }

  console.log("");
  console.log(chalk.dim(`Open ${relativePath}/assignment.md for the full brief`));
  console.log(chalk.dim(`Open ${relativePath}/plan.md for the action plan`));
  console.log("");
}

function logPhase(phase: string): void {
  console.log(`  ${chalk.dim(">")} ${phase}`);
}

function formatConfidence(confidence: string): string {
  switch (confidence) {
    case "high":
      return chalk.green(confidence);
    case "medium":
      return chalk.yellow(confidence);
    case "low":
      return chalk.red(confidence);
    default:
      return chalk.dim(confidence);
  }
}
