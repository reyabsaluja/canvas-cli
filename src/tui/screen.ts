import chalk from "chalk";

// --- Pale blue color palette ---
export const C = {
  primary: chalk.hex("#7aa2f7"),
  primaryBold: chalk.hex("#7aa2f7").bold,
  accent: chalk.hex("#7dcfff"),
  text: chalk.hex("#c0caf5"),
  warm: chalk.hex("#d8c58f"),
  muted: chalk.hex("#bcd1da"),
  /** Home info: command descriptions, school/courses/model/workspaces labels */
  secondary: chalk.hex("#536878"),
  dim: chalk.hex("#565f89"),
  dimmer: chalk.hex("#3b4261"),
  success: chalk.hex("#9ece6a"),
  warn: chalk.hex("#e0af68"),
  error: chalk.hex("#f7768e"),
  white: chalk.hex("#c0caf5"),
  userBubble: chalk.hex("#414868"),
  bold: chalk.hex("#c0caf5").bold,
};

/** Menu box text styles (no background — inherits terminal default). Border uses `#536878` (`C.secondary`). */
export const MenuBox = {
  edge: (s: string) => C.secondary(s),
  version: (s: string) => C.secondary(s),
  primary: (s: string) => C.primary(s),
  primaryBold: (s: string) => C.primaryBold(s),
  secondary: (s: string) => C.muted(s),
  dim: (s: string) => C.dim(s),
  text: (s: string) => C.text(s),
  bold: (s: string) => C.bold(s),
  fill: (s: string) => s,
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
    const normalizeLine = (line: string): string => `\x1B[0m${line}\x1B[0m`;
    const maxVisibleCols = Math.max(1, cols - 1);

    // Truncate lines to terminal width so they never wrap
    let rendered = this.lines.map((line) => {
      const visible = stripAnsi(line).length;
      if (visible > maxVisibleCols) {
        return normalizeLine(truncateAnsiToWidth(line, maxVisibleCols));
      }
      return normalizeLine(line);
    });

    if (rendered.length > maxContentLines) {
      const maxScroll = rendered.length - maxContentLines;
      const off = Math.max(0, Math.min(scrollOffsetFromBottom, maxScroll));
      const end = rendered.length - off;
      const start = Math.max(0, end - maxContentLines);
      rendered = rendered.slice(start, end);
    }

    // Fill remaining rows with blank lines to clear old content
    while (rendered.length < rows) {
      rendered.push("");
    }

    const writes: string[] = ["\x1B[0m"];
    for (let row = 0; row < rows; row++) {
      writes.push(`\x1B[${row + 1};1H\x1B[0m\x1B[2K${rendered[row]!}`);
    }
    writes.push("\x1B[0m");
    process.stdout.write(writes.join(""));

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

/**
 * Alternate screen buffer (DEC 1049). Full-screen TUIs that redraw the whole
 * terminal should use this so the host scrollbar does not browse stale frames
 * from past writes (which looks like “scrolling” hides your prompt).
 */
export function enterAlternateScreen(): void {
  process.stdout.write("\x1B[?1049h");
}

/** Restore the normal screen buffer; call when leaving a full-screen TUI. */
export function leaveAlternateScreen(): void {
  process.stdout.write("\x1B[?1049l");
}

/** Enable SGR mouse tracking (scroll wheel + click events sent as escape sequences). */
export function enableMouseTracking(): void {
  process.stdout.write("\x1B[?1000h\x1B[?1006h");
}

/** Disable mouse tracking; call when leaving a full-screen TUI. */
export function disableMouseTracking(): void {
  process.stdout.write("\x1B[?1000l\x1B[?1006l");
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

export function visibleWidth(str: string): number {
  return stripAnsi(str).length;
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

export function padAnsiToWidth(str: string, width: number): string {
  const visible = visibleWidth(str);
  if (visible >= width) {
    return visible > width ? truncateAnsiToWidth(str, width) : str;
  }
  return str + " ".repeat(width - visible);
}

export function truncatePlainToWidth(str: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (str.length <= maxWidth) return str;
  if (maxWidth <= 3) return str.slice(0, maxWidth);
  return str.slice(0, maxWidth - 3) + "...";
}

export function tailPlainToWidth(str: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (str.length <= maxWidth) return str;
  return str.slice(str.length - maxWidth);
}

export function wrapPlainText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];

  const rawLines = text.split("\n");
  const wrapped: string[] = [];

  for (const rawLine of rawLines) {
    if (!rawLine.trim()) {
      wrapped.push("");
      continue;
    }

    const words = rawLine.split(/\s+/).filter(Boolean);
    let current = "";

    const flushCurrent = (): void => {
      if (current) {
        wrapped.push(current);
        current = "";
      }
    };

    for (const word of words) {
      if (word.length > maxWidth) {
        flushCurrent();
        for (let start = 0; start < word.length; start += maxWidth) {
          wrapped.push(word.slice(start, start + maxWidth));
        }
        continue;
      }

      const next = current ? `${current} ${word}` : word;
      if (next.length > maxWidth) {
        flushCurrent();
        current = word;
      } else {
        current = next;
      }
    }

    flushCurrent();
  }

  return wrapped.length > 0 ? wrapped : [""];
}

export function keepLineVisible(
  lineIndex: number,
  scrollTop: number,
  viewportRows: number,
  totalRows: number,
  paddingRows: number = 1
): number {
  if (viewportRows <= 0 || totalRows <= viewportRows) {
    return 0;
  }

  const maxScroll = Math.max(0, totalRows - viewportRows);
  const padding = Math.max(0, Math.min(paddingRows, Math.floor(viewportRows / 2)));
  let nextScrollTop = Math.max(0, Math.min(scrollTop, maxScroll));

  if (lineIndex < nextScrollTop + padding) {
    nextScrollTop = Math.max(0, lineIndex - padding);
  } else if (lineIndex >= nextScrollTop + viewportRows - padding) {
    nextScrollTop = Math.min(maxScroll, lineIndex - viewportRows + padding + 1);
  }

  return nextScrollTop;
}
