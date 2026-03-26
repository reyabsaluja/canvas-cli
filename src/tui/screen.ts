import chalk from "chalk";

// --- Pale blue color palette ---
export const C = {
  primary: chalk.hex("#7aa2f7"),
  primaryBold: chalk.hex("#7aa2f7").bold,
  accent: chalk.hex("#7dcfff"),
  text: chalk.hex("#c0caf5"),
  dim: chalk.hex("#565f89"),
  dimmer: chalk.hex("#3b4261"),
  success: chalk.hex("#9ece6a"),
  warn: chalk.hex("#e0af68"),
  error: chalk.hex("#f7768e"),
  white: chalk.hex("#c0caf5"),
  userBubble: chalk.hex("#414868"),
  bold: chalk.hex("#c0caf5").bold,
};

// --- ASCII art ---
export const CANVAS_ASCII = `
  ██████   ██████   ████████   █████ █████  ██████    █████
 ███▒▒███ ▒▒▒▒▒███ ▒▒███▒▒███ ▒▒███ ▒▒███  ▒▒▒▒▒███  ███▒▒
▒███ ▒▒▒   ███████  ▒███ ▒███  ▒███  ▒███   ███████ ▒▒█████
▒███  ███ ███▒▒███  ▒███ ▒███  ▒▒███ ███   ███▒▒███  ▒▒▒▒███
▒▒██████ ▒▒████████ ████ █████  ▒▒█████   ▒▒████████ ██████
 ▒▒▒▒▒▒   ▒▒▒▒▒▒▒▒ ▒▒▒▒ ▒▒▒▒▒    ▒▒▒▒▒     ▒▒▒▒▒▒▒▒ ▒▒▒▒▒▒  `;

/** Clear the terminal screen and move cursor to top-left. */
export function clearScreen(): void {
  process.stdout.write("\x1B[2J\x1B[H");
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

/** Render a horizontal divider. */
export function divider(cols?: number): string {
  const w = cols ?? Math.min(getTermSize().cols, 80);
  return C.dimmer("─".repeat(w));
}

/** Wrap text to a given width. */
export function wrapText(text: string, width: number, indent: string = ""): string {
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

/** Format confidence with color. */
export function fmtConfidence(confidence: string): string {
  switch (confidence) {
    case "high": return C.success(confidence);
    case "medium": return C.warn(confidence);
    case "low": return C.error(confidence);
    default: return C.dim(confidence);
  }
}
