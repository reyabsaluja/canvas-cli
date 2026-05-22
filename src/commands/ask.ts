import { getAIConfig, AI_PROVIDER_SETUP_HINT } from "../ai/provider.js";
import { resolveWorkspace, listWorkspaces } from "../ask/resolve-workspace.js";
import { loadWorkspace } from "../ask/load-workspace.js";
import { loadCourseCache } from "../enrich/cache-loader.js";
import { renderWorkspaceAnswer } from "../ask/render.js";
import {
  askWorkspaceQuestion,
  createChatContext,
  type ToolCallEvent,
} from "../tui/services.js";
import chalk from "chalk";

interface AskOptions {
  workspace?: string;
  json?: boolean;
  showRetrieval?: boolean;
}

export async function askCommand(
  question: string,
  options: AskOptions
): Promise<void> {
  const aiConfig = getAIConfig();
  if (!aiConfig) {
    console.error(
      `Error: no AI provider is configured.\n${AI_PROVIDER_SETUP_HINT}`
    );
    process.exit(1);
  }

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

  const ws = await loadWorkspace(wsPath);

  if (!ws.workupJson && !ws.assignmentMd) {
    console.error(
      `Workspace at ${wsPath} appears incomplete (no workup.json or assignment.md).\n` +
        `Run ${chalk.dim("canvas-cli work <assignment>")} to generate workspace artifacts.`
    );
    process.exit(1);
  }

  const cache =
    ws.courseId !== null && ws.courseCode
      ? await loadCourseCache(ws.courseCode, ws.courseId)
      : null;
  const chatContext = createChatContext(aiConfig, ws, {
    cache,
    client: null,
    config: null,
    courseId: ws.courseId,
  });
  const toolEvents: ToolCallEvent[] = [];

  let answer;
  try {
    answer = await askWorkspaceQuestion(
      aiConfig,
      ws,
      question,
      (event) => {
        toolEvents.push(event);
      },
      {
        cache,
        client: null,
        config: null,
        courseId: ws.courseId,
      },
      chatContext
    );
  } catch (err) {
    console.error(
      `Failed to generate answer: ${err instanceof Error ? err.message : "unknown error"}`
    );
    process.exit(1);
  }

  if (options.showRetrieval) {
    console.log(chalk.dim("\n--- Debug: Workspace agent ---"));
    console.log(chalk.dim(`  Workspace: ${ws.sessionSlug}`));
    console.log(chalk.dim(`  Course cache: ${cache ? "loaded" : "unavailable"}`));
    console.log(
      chalk.dim(
        "  Network-backed downloads: disabled for `canvas-cli ask` (local-first mode)"
      )
    );
    if (toolEvents.length === 0) {
      console.log(chalk.dim("  Tool calls: none"));
    } else {
      console.log(chalk.dim("  Tool calls:"));
      for (const event of toolEvents) {
        console.log(
          chalk.dim(
            `    - ${event.action} ${event.target}${
              event.observation
                ? ` [${event.observation.tool}:${event.observation.status}]`
                : ""
            }`
          )
        );
      }
    }
    console.log(
      chalk.dim(
        `  Remembered observations: ${chatContext.runState.observations.length}`
      )
    );
    console.log(chalk.dim("--- End debug ---\n"));
  }

  if (options.json) {
    console.log(JSON.stringify(answer, null, 2));
  } else {
    console.log(renderWorkspaceAnswer(answer));
  }
}
