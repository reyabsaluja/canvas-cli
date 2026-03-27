import { C, getTermSize, stripAnsi } from "./screen.js";

/**
 * Context-aware phrases that cycle during agent work.
 */
const THINKING_PHRASES = [
  "Studying your course...",
  "Reading your materials...",
  "Reviewing assignment details...",
  "Analyzing context...",
  "Building your answer...",
  "Organizing information...",
  "Preparing response...",
  "Checking requirements...",
];

/**
 * Braille spinner frames (single character each).
 * Simulates a rotating/pulsing pattern within a 3x2 braille dot grid.
 */
const PULSE_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

/**
 * Manages the live activity feed + animated working indicator.
 *
 * Renders an activity log that grows upward with a pinned
 * animated indicator at the bottom. Uses direct cursor
 * positioning for flicker-free updates.
 */
export class ActivityIndicator {
  private steps: Array<{ label: string; done: boolean }> = [];
  private animFrame = 0;
  private phraseIdx = 0;
  private phraseTimer = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startRow: number;
  private running = false;

  constructor(startRow: number) {
    this.startRow = startRow;
  }

  /** Start the animation loop. */
  start(): void {
    this.running = true;
    this.animFrame = 0;
    this.phraseIdx = Math.floor(Math.random() * THINKING_PHRASES.length);
    this.phraseTimer = 0;
    this.renderActivity();

    this.timer = setInterval(() => {
      if (!this.running) return;
      this.animFrame = (this.animFrame + 1) % PULSE_FRAMES.length;
      this.phraseTimer++;
      // Cycle phrase every ~18 ticks (~1.8s at 100ms interval)
      if (this.phraseTimer >= 18) {
        this.phraseTimer = 0;
        this.phraseIdx = (this.phraseIdx + 1) % THINKING_PHRASES.length;
      }
      this.renderActivity();
    }, 100);
  }

  /** Stop the animation and show "Done". */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.renderDone();
  }

  /** Add a new step to the activity feed. */
  addStep(label: string): void {
    // Mark previous step as done
    if (this.steps.length > 0) {
      this.steps[this.steps.length - 1].done = true;
    }
    this.steps.push({ label, done: false });
    if (this.running) {
      this.renderActivity();
    }
  }

  /** Get the total number of lines this indicator occupies. */
  getHeight(): number {
    // steps + blank line + indicator line
    return this.steps.length + 2;
  }

  /** Render the activity feed + animated indicator at startRow. */
  private renderActivity(): void {
    const { cols, rows: termRows } = getTermSize();

    // Determine render position
    let row: number;
    if (this.startRow + this.getHeight() + 1 <= termRows) {
      row = this.startRow;
    } else {
      // Pin near bottom
      row = Math.max(1, termRows - this.getHeight() - 1);
    }

    const lines: string[] = [];

    // Activity steps
    for (const step of this.steps) {
      const icon = step.done ? C.success("✓") : C.dim("›");
      const text = step.done ? C.dim(step.label) : C.text(step.label);
      lines.push(`  ${icon} ${text}`);
    }

    // Blank line before indicator
    lines.push("");

    // Animated indicator
    const pulse = C.primary(PULSE_FRAMES[this.animFrame]);
    const phrase = C.dim(THINKING_PHRASES[this.phraseIdx]);
    lines.push(`  ${pulse}  ${phrase}`);

    // Pad each line and write
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

  /** Render the final "Done" state. */
  private renderDone(): void {
    const { cols, rows: termRows } = getTermSize();

    let row: number;
    if (this.startRow + this.getHeight() + 1 <= termRows) {
      row = this.startRow;
    } else {
      row = Math.max(1, termRows - this.getHeight() - 1);
    }

    const lines: string[] = [];

    // All steps marked done
    for (const step of this.steps) {
      lines.push(`  ${C.success("✓")} ${C.dim(step.label)}`);
    }
    lines.push("");
    lines.push(`  ${C.success("✓")} ${C.dim("Done")}`);

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
}
