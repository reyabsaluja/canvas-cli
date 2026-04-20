import { C, getTermSize, stripAnsi } from "./screen.js";
import chalk from "chalk";

const WORKING_VERBS = [
  "Working",
  "Thinking",
  "Learning",
  "Studying",
  "Reading",
  "Analyzing",
  "Researching",
  "Exploring",
  "Reviewing",
  "Processing",
];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const toolBg = chalk.bgHex("#1e1e1e");
const spinnerColor = chalk.hex("#e82429");
const SHIMMER_COLORS = [
  chalk.hex("#6e1114"),
  chalk.hex("#8c1618"),
  chalk.hex("#ab1b1e"),
  chalk.hex("#c92023"),
  chalk.hex("#e82429"),
  chalk.hex("#f25a5e"),
  chalk.hex("#f78e90"),
  chalk.hex("#f25a5e"),
  chalk.hex("#e82429"),
  chalk.hex("#c92023"),
  chalk.hex("#ab1b1e"),
  chalk.hex("#8c1618"),
];

function buildShimmerText(text: string, frame: number): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const colorIndex = (frame + i) % SHIMMER_COLORS.length;
    result += SHIMMER_COLORS[colorIndex]!(text[i]!);
  }
  return result;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m${remaining}s`;
}

/**
 * Clean activity indicator for the chat agent.
 *
 * Shows tool call blocks as they happen (like Claude Code),
 * with a single animated spinner line pinned at the bottom.
 */
export class ActivityIndicator {
  private steps: string[] = [];
  private frame = 0;
  private shimmerFrame = 0;
  private verb: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private baseRow: number;
  private startTime: number;

  constructor(baseRow: number) {
    this.baseRow = baseRow;
    this.verb = WORKING_VERBS[Math.floor(Math.random() * WORKING_VERBS.length)]!;
    this.startTime = Date.now();
  }

  start(): void {
    this.startTime = Date.now();
    this.renderAll();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.shimmerFrame = (this.shimmerFrame + 1) % SHIMMER_COLORS.length;
      this.renderSpinnerLine();
    }, 80);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Update the base row (call after re-rendering the main UI). */
  updateBaseRow(row: number): void {
    this.baseRow = row;
  }

  /** Add a tool call step (shown as a compact block above the spinner). */
  addStep(label: string): void {
    this.steps.push(label);
    this.renderAll();
  }

  /** Render all steps + spinner. */
  private renderAll(): void {
    const { cols, rows: termRows } = getTermSize();
    const row = this.getRow(termRows);

    const lines: string[] = [];

    // Tool call blocks — each is a single line in a dark background
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      const isDone = i < this.steps.length - 1;
      const icon = isDone ? C.dim("›") : C.text("›");
      const label = isDone ? C.dim(step) : C.text(step);
      const blockWidth = Math.min(cols - 6, 80);
      const textPart = `  ${stripAnsi(icon)} ${step}`;
      const pad = " ".repeat(Math.max(0, blockWidth - textPart.length));
      lines.push("  " + toolBg(` ${icon} ${label}${pad}`));
    }

    // Blank line before spinner
    if (this.steps.length > 0) lines.push("");

    // Spinner line
    lines.push(this.buildSpinnerLine());

    // Write all at once
    const pad = (s: string) => {
      const vis = stripAnsi(s).length;
      return vis < cols ? s + " ".repeat(cols - vis) : s;
    };

    let output = `\x1B[${row};1H`;
    for (const line of lines) {
      output += pad(line) + "\n";
    }
    process.stdout.write(output);
  }

  /** Render only the spinner line (for animation ticks — no flicker). */
  private renderSpinnerLine(): void {
    const { cols, rows: termRows } = getTermSize();
    const row = this.getRow(termRows);
    const spinnerRow = row + this.steps.length + (this.steps.length > 0 ? 1 : 0);

    const line = this.buildSpinnerLine();
    const vis = stripAnsi(line).length;
    const padded = vis < cols ? line + " ".repeat(cols - vis) : line;

    process.stdout.write(`\x1B[${spinnerRow};1H` + padded);
  }

  private buildSpinnerLine(): string {
    const elapsed = formatElapsed(Date.now() - this.startTime);
    const verbText = `${this.verb}...`;
    const shimmer = buildShimmerText(verbText, this.shimmerFrame);
    return `  ${spinnerColor(SPINNER[this.frame]!)} ${shimmer} ${C.dim(`(${elapsed})`)}`;
  }

  private getRow(termRows: number): number {
    const height = this.steps.length + (this.steps.length > 0 ? 1 : 0) + 1;
    if (this.baseRow + height <= termRows) {
      return this.baseRow;
    }
    return Math.max(1, termRows - height);
  }
}
