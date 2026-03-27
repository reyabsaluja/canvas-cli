import { C, getTermSize, stripAnsi } from "./screen.js";
import chalk from "chalk";

/**
 * Fun verbs randomly selected once per prompt.
 */
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

/** Braille spinner frames. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Background for tool call blocks. */
const toolBg = chalk.bgHex("#1e2030");

/**
 * Clean activity indicator for the chat agent.
 *
 * Shows tool call blocks as they happen (like Claude Code),
 * with a single animated spinner line pinned at the bottom.
 */
export class ActivityIndicator {
  private steps: string[] = [];
  private frame = 0;
  private verb: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private baseRow: number;

  constructor(baseRow: number) {
    this.baseRow = baseRow;
    this.verb = WORKING_VERBS[Math.floor(Math.random() * WORKING_VERBS.length)];
  }

  start(): void {
    this.renderAll();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.renderSpinnerLine();
    }, 100);
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
      const icon = isDone ? C.dim("›") : C.accent("›");
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
    const s = C.primary(SPINNER[this.frame]);
    return `  ${s} ${C.accent(this.verb)}${C.text("...")}`;
  }

  private getRow(termRows: number): number {
    const height = this.steps.length + (this.steps.length > 0 ? 1 : 0) + 1;
    if (this.baseRow + height <= termRows) {
      return this.baseRow;
    }
    return Math.max(1, termRows - height);
  }
}
