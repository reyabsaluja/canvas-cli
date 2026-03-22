import readline from "node:readline";
import chalk from "chalk";
import type { AssignmentWorkup } from "../work/types.js";
import type { LoadedWorkspace, WorkspaceAnswer } from "../ask/types.js";
import type { AIProviderConfig } from "../ai/provider.js";
import { askWorkspaceQuestion } from "./services.js";
import { divider } from "./screen.js";

interface WorkspaceContext {
  workspacePath: string;
  workup: AssignmentWorkup | null;
  loaded: LoadedWorkspace;
  aiConfig: AIProviderConfig | null;
}

const SLASH_COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: "/overview", desc: "Show assignment overview" },
  { cmd: "/requirements", desc: "Show deliverables and constraints" },
  { cmd: "/plan", desc: "Show the action plan" },
  { cmd: "/resources", desc: "Show key resources" },
  { cmd: "/evidence", desc: "Show confirmed vs inferred sources" },
  { cmd: "/status", desc: "Show workspace status" },
  { cmd: "/help", desc: "Show available commands" },
  { cmd: "/back", desc: "Return to assignment selection" },
  { cmd: "/courses", desc: "Return to course selection" },
  { cmd: "/quit", desc: "Exit canvas-cli" },
];

/**
 * Run the workspace interactive REPL.
 * Returns: "back" to go to assignment picker, "courses" to go to course picker, "quit" to exit.
 */
export async function runWorkspaceUI(
  ctx: WorkspaceContext
): Promise<"back" | "courses" | "quit"> {
  renderWorkspaceHeader(ctx);
  renderWelcome(ctx);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan("\n  > "),
  });

  return new Promise((resolve) => {
    rl.prompt();

    rl.on("line", async (line) => {
      const input = line.trim();
      if (!input) {
        rl.prompt();
        return;
      }

      // Slash commands
      if (input.startsWith("/")) {
        const cmd = input.toLowerCase().split(/\s/)[0];
        switch (cmd) {
          case "/overview":
            renderOverview(ctx);
            break;
          case "/requirements":
          case "/reqs":
            renderRequirements(ctx);
            break;
          case "/plan":
            renderPlan(ctx);
            break;
          case "/resources":
            renderResources(ctx);
            break;
          case "/evidence":
            renderEvidence(ctx);
            break;
          case "/status":
            renderStatus(ctx);
            break;
          case "/help":
            renderHelp();
            break;
          case "/back":
            rl.close();
            resolve("back");
            return;
          case "/courses":
            rl.close();
            resolve("courses");
            return;
          case "/quit":
          case "/exit":
          case "/q":
            rl.close();
            resolve("quit");
            return;
          default:
            console.log(chalk.dim(`\n  Unknown command: ${cmd}. Type /help for options.`));
        }
        rl.prompt();
        return;
      }

      // Natural language question
      if (!ctx.aiConfig) {
        console.log(
          chalk.dim("\n  AI unavailable (no ANTHROPIC_API_KEY). Slash commands still work — try /help")
        );
        rl.prompt();
        return;
      }

      console.log(chalk.dim("\n  Thinking..."));

      try {
        const answer = await askWorkspaceQuestion(
          ctx.aiConfig,
          ctx.loaded,
          input
        );
        renderAnswer(answer);
      } catch (err) {
        console.log(
          chalk.red(
            `\n  Error: ${err instanceof Error ? err.message : "unknown"}`
          )
        );
      }

      rl.prompt();
    });

    rl.on("close", () => {
      resolve("quit");
    });
  });
}

// --- Renderers ---

function renderWorkspaceHeader(ctx: WorkspaceContext): void {
  const w = ctx.workup;
  const name = ctx.loaded.assignmentName;
  const course = ctx.loaded.courseName;

  console.log("");
  console.log(chalk.bold.cyan(`  ${name}`));
  console.log(chalk.dim(`  ${course}`));

  if (w) {
    const confidence = w.confidence === "high"
      ? chalk.green(w.confidence)
      : w.confidence === "medium"
        ? chalk.yellow(w.confidence)
        : chalk.red(w.confidence);

    const dueStr = w.dueDate ? chalk.dim(` | Due: ${w.dueDate}`) : "";
    console.log(chalk.dim("  Confidence: ") + confidence + dueStr);
  }

  console.log(divider());
}

function renderWelcome(ctx: WorkspaceContext): void {
  if (ctx.workup?.overview) {
    console.log("");
    console.log(chalk.dim("  ") + wrapText(ctx.workup.overview, 76, "  "));
  }

  if (ctx.workup?.actionPlan && ctx.workup.actionPlan.length > 0) {
    console.log("");
    console.log(chalk.bold("  Next steps"));
    const preview = ctx.workup.actionPlan.slice(0, 3);
    for (const step of preview) {
      console.log(`  ${chalk.dim(`${step.step}.`)} ${step.action}`);
    }
    if (ctx.workup.actionPlan.length > 3) {
      console.log(chalk.dim(`  ... ${ctx.workup.actionPlan.length - 3} more — type /plan`));
    }
  }

  console.log("");
  console.log(
    chalk.dim("  Type a question, or use /help for commands")
  );
}

function renderOverview(ctx: WorkspaceContext): void {
  if (!ctx.workup) {
    console.log(chalk.dim("\n  No workup data available."));
    return;
  }
  console.log("");
  console.log(chalk.bold("  Overview"));
  console.log("");
  console.log("  " + wrapText(ctx.workup.overview, 76, "  "));
}

function renderRequirements(ctx: WorkspaceContext): void {
  if (!ctx.workup) {
    console.log(chalk.dim("\n  No workup data available."));
    return;
  }
  console.log("");

  if (ctx.workup.deliverables.length > 0) {
    console.log(chalk.bold("  Deliverables"));
    console.log("");
    for (const d of ctx.workup.deliverables) {
      console.log(`  ${chalk.dim("•")} ${d}`);
    }
  }

  if (ctx.workup.constraints.length > 0) {
    console.log("");
    console.log(chalk.bold("  Constraints"));
    console.log("");
    for (const c of ctx.workup.constraints) {
      console.log(`  ${chalk.dim("•")} ${c}`);
    }
  }

  if (
    ctx.workup.deliverables.length === 0 &&
    ctx.workup.constraints.length === 0
  ) {
    console.log(chalk.dim("  No deliverables or constraints found in workup."));
  }
}

function renderPlan(ctx: WorkspaceContext): void {
  if (!ctx.workup || ctx.workup.actionPlan.length === 0) {
    console.log(chalk.dim("\n  No action plan available."));
    return;
  }
  console.log("");
  console.log(chalk.bold("  Action Plan"));
  console.log("");
  for (const step of ctx.workup.actionPlan) {
    console.log(`  ${chalk.bold(`${step.step}.`)} ${step.action}`);
    if (step.detail) {
      console.log(`     ${chalk.dim(step.detail)}`);
    }
  }
}

function renderResources(ctx: WorkspaceContext): void {
  if (!ctx.workup || ctx.workup.relevantResources.length === 0) {
    console.log(chalk.dim("\n  No resources listed."));
    return;
  }
  console.log("");
  console.log(chalk.bold("  Resources"));
  console.log("");
  for (const r of ctx.workup.relevantResources) {
    console.log(`  ${chalk.dim("•")} ${chalk.bold(r.title)} ${chalk.dim(`(${r.type})`)}`);
    console.log(`    ${r.why}`);
    if (r.location) console.log(chalk.dim(`    ${r.location}`));
  }
}

function renderEvidence(ctx: WorkspaceContext): void {
  if (!ctx.workup || ctx.workup.sourceTrace.length === 0) {
    console.log(chalk.dim("\n  No source trace available."));
    return;
  }
  console.log("");
  console.log(chalk.bold("  Evidence & Source Trace"));
  console.log("");
  for (const e of ctx.workup.sourceTrace) {
    console.log(`  ${chalk.dim("•")} ${e.conclusion}`);
    console.log(`    ${chalk.dim(`source: ${e.source}`)}`);
  }

  if (ctx.workup.uncertainties.length > 0) {
    console.log("");
    console.log(chalk.bold("  Open questions"));
    console.log("");
    for (const u of ctx.workup.uncertainties) {
      console.log(`  ${chalk.dim("?")} ${u}`);
    }
  }
}

function renderStatus(ctx: WorkspaceContext): void {
  console.log("");
  console.log(chalk.bold("  Workspace Status"));
  console.log("");
  console.log(`  ${chalk.dim("Assignment")}  ${ctx.loaded.assignmentName}`);
  console.log(`  ${chalk.dim("Course    ")}  ${ctx.loaded.courseName}`);
  console.log(`  ${chalk.dim("Path      ")}  ${ctx.workspacePath}`);
  console.log(
    `  ${chalk.dim("Workup    ")}  ${ctx.workup ? chalk.green("loaded") : chalk.red("not available")}`
  );
  console.log(
    `  ${chalk.dim("Extracted ")}  ${ctx.loaded.extractedFiles.length} documents`
  );
  console.log(
    `  ${chalk.dim("Notes     ")}  ${ctx.loaded.notesMd ? "present" : "empty"}`
  );
  if (ctx.workup) {
    console.log(
      `  ${chalk.dim("Confidence")}  ${ctx.workup.confidence}`
    );
  }
}

function renderHelp(): void {
  console.log("");
  console.log(chalk.bold("  Commands"));
  console.log("");
  for (const { cmd, desc } of SLASH_COMMANDS) {
    console.log(`  ${chalk.cyan(cmd.padEnd(16))} ${chalk.dim(desc)}`);
  }
  console.log("");
  console.log(chalk.dim("  Or type any question in natural language."));
}

function renderAnswer(answer: WorkspaceAnswer): void {
  console.log("");

  // Answer text
  const lines = answer.answer.split("\n");
  for (const line of lines) {
    console.log(line ? `  ${line}` : "");
  }

  // Bullet points
  if (answer.bulletPoints.length > 0) {
    console.log("");
    for (const bp of answer.bulletPoints) {
      console.log(`  ${chalk.dim("•")} ${bp}`);
    }
  }

  // Sources
  if (answer.sources.length > 0) {
    console.log("");
    for (const src of answer.sources) {
      console.log(`  ${chalk.dim(`[${src.kind}]`)} ${chalk.dim(src.title)}`);
    }
  }

  // Confidence
  const conf =
    answer.confidence === "high"
      ? chalk.green(answer.confidence)
      : answer.confidence === "medium"
        ? chalk.yellow(answer.confidence)
        : chalk.red(answer.confidence);
  console.log(chalk.dim(`\n  confidence: `) + conf);
}

function wrapText(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + " " + word : word;
    }
  }
  if (current) lines.push(current);

  return lines.join("\n" + indent);
}
