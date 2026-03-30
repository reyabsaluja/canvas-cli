import { getAIConfig } from "../ai/provider.js";
import { resolveWorkspace, listWorkspaces } from "../ask/resolve-workspace.js";
import { loadWorkspace } from "../ask/load-workspace.js";
import { buildChunks, retrieveRelevant } from "../ask/retrieve.js";
import { answerQuestion } from "../ask/answer.js";
import { renderWorkspaceAnswer } from "../ask/render.js";
import chalk from "chalk";

interface AskOptions {
  workspace?: string;
  json?: boolean;
  debug?: boolean;
}

export async function askCommand(
  question: string,
  options: AskOptions
): Promise<void> {
  // Check AI config
  const aiConfig = getAIConfig();
  if (!aiConfig) {
    console.error(
      "Error: ANTHROPIC_API_KEY is not set.\nThe ask command requires AI. Add ANTHROPIC_API_KEY to your .env file."
    );
    process.exit(1);
  }

  // Resolve workspace
  const wsPath = await resolveWorkspace(options.workspace);
  if (!wsPath) {
    console.error("No assignment workspace found.\n");
    const workspaces = await listWorkspaces();
    if (workspaces.length > 0) {
      console.error("Available workspaces:");
      for (const ws of workspaces) {
        console.error(`  ${chalk.bold(ws.name)}  ${chalk.dim(ws.course)}  ${chalk.dim(ws.slug)}`);
      }
      console.error(
        `\nUse ${chalk.dim("--workspace <path>")} to specify one, or cd into a workspace directory.`
      );
    } else {
      console.error(
        `Run ${chalk.dim("canvas-cli work <assignment>")} first to create a workspace.`
      );
    }
    process.exit(1);
  }

  // Load workspace
  const ws = await loadWorkspace(wsPath);

  if (!ws.workupJson && !ws.assignmentMd) {
    console.error(
      `Workspace at ${wsPath} appears incomplete (no workup.json or assignment.md).\n` +
        `Run ${chalk.dim("canvas-cli work <assignment>")} to generate workspace artifacts.`
    );
    process.exit(1);
  }

  // Build chunks and retrieve
  const chunks = await buildChunks(ws);

  if (chunks.length === 0) {
    console.error("Workspace has no content to answer from.");
    process.exit(1);
  }

  const relevant = retrieveRelevant(question, chunks);

  if (options.debug) {
    console.log(chalk.dim("\n--- Debug: Retrieved chunks ---"));
    for (const c of relevant) {
      console.log(
        chalk.dim(
          `  [${c.kind}] ${c.source} / ${c.section} (${c.text.length} chars)`
        )
      );
    }
    console.log(chalk.dim("--- End debug ---\n"));
  }

  // Generate answer
  let answer;
  try {
    answer = await answerQuestion(aiConfig, question, relevant);
  } catch (err) {
    console.error(
      `Failed to generate answer: ${err instanceof Error ? err.message : "unknown error"}`
    );
    process.exit(1);
  }

  // Render
  if (options.json) {
    console.log(JSON.stringify(answer, null, 2));
  } else {
    console.log(renderWorkspaceAnswer(answer));
  }
}
