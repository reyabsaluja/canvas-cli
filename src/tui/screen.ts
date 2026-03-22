import chalk from "chalk";

/** Clear the terminal screen and move cursor to top-left. */
export function clearScreen(): void {
  process.stdout.write("\x1B[2J\x1B[H");
}

/** Move cursor to a specific row (0-based). */
export function moveTo(row: number, col: number = 0): void {
  process.stdout.write(`\x1B[${row + 1};${col + 1}H`);
}

/** Clear from cursor to end of screen. */
export function clearDown(): void {
  process.stdout.write("\x1B[J");
}

/** Hide cursor. */
export function hideCursor(): void {
  process.stdout.write("\x1B[?25l");
}

/** Show cursor. */
export function showCursor(): void {
  process.stdout.write("\x1B[?25h");
}

/** Get terminal dimensions. */
export function getTermSize(): { rows: number; cols: number } {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

/** Render the app header bar. */
export function renderHeader(title: string, subtitle?: string): string {
  const line = chalk.bgHex("#1a1a2e").white.bold(` ${title} `);
  const sub = subtitle ? chalk.dim(` ${subtitle}`) : "";
  return line + sub;
}

/** Truncate a string to fit terminal width. */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

/** Render a horizontal divider. */
export function divider(cols?: number): string {
  const w = cols ?? getTermSize().cols;
  return chalk.dim("─".repeat(Math.min(w, 80)));
}
