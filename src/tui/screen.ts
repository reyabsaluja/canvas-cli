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

/**
 * Screen buffer — collects lines, then flushes all at once.
 * Avoids flicker by writing a single large chunk to stdout.
 */
class ScreenBuffer {
  private lines: string[] = [];

  /** Add a line to the buffer (like console.log). */
  push(line: string = ""): void {
    this.lines.push(line);
  }

  /** Get the current number of lines in the buffer. */
  get length(): number {
    return this.lines.length;
  }

  /**
   * Flush the buffer to stdout. Moves cursor to top-left, writes all lines,
   * clears any remaining old content below, all in one write() call.
   *
   * Truncates lines that would wrap to prevent row-count mismatches.
   *
   * @param bottomReserveRows — Lines left blank at the bottom (overdrawn by a sticky
   *   footer). Content is sliced to at most `rows - bottomReserveRows` so it is not
   *   hidden under that region.
   * @param scrollOffsetFromBottom — When content exceeds the viewport, how many lines
   *   to scroll up from the bottom (0 = show the latest lines).
   */
  flush(bottomReserveRows: number = 0, scrollOffsetFromBottom: number = 0): void {
    const { rows, cols } = getTermSize();
    const reserve = Math.max(0, bottomReserveRows);
    const maxContentLines = Math.max(1, rows - reserve);

    // Truncate lines to terminal width so they never wrap
    let padded = this.lines.map((line) => {
      const visible = stripAnsi(line).length;
      if (visible > cols) {
        return truncateAnsiToWidth(line, cols - 1) + " ";
      }
      if (visible < cols) {
        return line + " ".repeat(cols - visible);
      }
      return line;
    });

    if (padded.length > maxContentLines) {
      const maxScroll = padded.length - maxContentLines;
      const off = Math.max(0, Math.min(scrollOffsetFromBottom, maxScroll));
      const end = padded.length - off;
      const start = Math.max(0, end - maxContentLines);
      padded = padded.slice(start, end);
    }

    // Fill remaining rows with blank lines to clear old content
    while (padded.length < rows) {
      padded.push(" ".repeat(cols));
    }

    // Move cursor home + write everything in one shot
    process.stdout.write("\x1B[H" + padded.join("\n"));

    this.lines = [];
  }
}

/** Create a new screen buffer for flicker-free rendering. */
export function createBuffer(): ScreenBuffer {
  return new ScreenBuffer();
}

/** Clear the terminal screen and move cursor to top-left (used only for full transitions). */
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

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

/**
 * Truncate a string with ANSI codes to a visible width.
 * Walks through characters, skipping ANSI escapes, until
 * the visible width reaches maxWidth.
 */
export function truncateAnsiToWidth(str: string, maxWidth: number): string {
  let visible = 0;
  let i = 0;

  while (i < str.length && visible < maxWidth) {
    // Check for ANSI escape sequence
    if (str[i] === "\x1B") {
      const match = str.slice(i).match(/^[\x1B\x9B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/);
      if (match) {
        i += match[0].length;
        continue;
      }
    }
    visible++;
    i++;
  }

  // Include any trailing ANSI reset sequences
  while (i < str.length && str[i] === "\x1B") {
    const match = str.slice(i).match(/^[\x1B\x9B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/);
    if (match) {
      i += match[0].length;
    } else {
      break;
    }
  }

  return str.slice(0, i);
}
