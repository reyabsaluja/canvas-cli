import chalk from "chalk";
import type { WorkspaceAnswer } from "./types.js";

/**
 * Render a workspace answer for terminal output.
 */
export function renderWorkspaceAnswer(wa: WorkspaceAnswer): string {
  const lines: string[] = [""];

  // Question
  lines.push(chalk.bold("Question"));
  lines.push(`  ${wa.question}`);
  lines.push("");

  // Answer
  lines.push(chalk.bold("Answer"));
  const answerLines = wa.answer.split("\n");
  for (const line of answerLines) {
    lines.push(line ? `  ${line}` : "");
  }
  lines.push("");

  // Key points
  if (wa.bulletPoints.length > 0) {
    lines.push(chalk.bold("Key points"));
    for (const point of wa.bulletPoints) {
      lines.push(`  - ${point}`);
    }
    lines.push("");
  }

  // Sources
  if (wa.sources.length > 0) {
    lines.push(chalk.bold("Sources"));
    for (const src of wa.sources) {
      const excerpt = src.excerpt
        ? chalk.dim(` — "${truncate(src.excerpt, 60)}"`)
        : "";
      lines.push(`  ${chalk.dim("-")} ${src.title} ${chalk.dim(`[${src.kind}]`)}${excerpt}`);
    }
    lines.push("");
  }

  // Confidence
  lines.push(`  ${chalk.dim("Confidence:")} ${formatConfidence(wa.confidence)}`);
  lines.push("");

  return lines.join("\n");
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

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}
