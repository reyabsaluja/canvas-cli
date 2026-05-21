import chalk from "chalk";

let lastFlushedRows: Array<string | null> | null = null;
let lastFlushedSize = "";

// --- Red accent color palette ---
export const C = {
  primary: chalk.hex("#e82429"),
  primaryBold: chalk.hex("#e82429").bold,
  accent: chalk.hex("#f25a5e"),
  text: chalk.hex("#d4d4d4"),
  warm: chalk.hex("#e8a86d"),
  muted: chalk.hex("#a0a0a0"),
  secondary: chalk.hex("#707070"),
  dim: chalk.hex("#606060"),
  dimmer: chalk.hex("#404040"),
  success: chalk.hex("#6ec86a"),
  warn: chalk.hex("#e8a86d"),
  error: chalk.hex("#ff6b6b"),
  white: chalk.hex("#d4d4d4"),
  pureWhite: chalk.hex("#ffffff"),
  pureWhiteBold: chalk.hex("#ffffff").bold,
  userBubble: chalk.hex("#3a3a3a"),
  bold: chalk.hex("#d4d4d4").bold,
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
export const CANVAS_TEXT = [
  "  ██████   ██████   ████████   █████ █████  ██████    █████",
  " ███▒▒███ ▒▒▒▒▒███ ▒▒███▒▒███ ▒▒███ ▒▒███  ▒▒▒▒▒███  ███▒▒",
  "▒███ ▒▒▒   ███████  ▒███ ▒███  ▒███  ▒███   ███████ ▒▒█████",
  "▒███  ███ ███▒▒███  ▒███ ▒███  ▒▒███ ███   ███▒▒███  ▒▒▒▒███",
  "▒▒██████ ▒▒████████ ████ █████  ▒▒█████   ▒▒████████ ██████",
  " ▒▒▒▒▒▒   ▒▒▒▒▒▒▒▒ ▒▒▒▒ ▒▒▒▒▒    ▒▒▒▒▒     ▒▒▒▒▒▒▒▒ ▒▒▒▒▒▒",
];

export const CANVAS_ASCII = CANVAS_TEXT.join("\n");

export const CANVAS_LOGO = [
  "  ⠀⠀⢀⣤⠀⠺⣿⣿⠗⠀⣠⣀⠀⠀",
  "  ⠀⣴⣿⠟⣀⠀⠰⡆⠀⢀⠻⣿⣧⠀",
  "  ⣠⡀⠀⠈⠛⠀⠀⠀⠀⠛⠃⠀⢀⣠",
  "  ⣿⣿⠰⠶⠀⠀⠀⠀⠀⠀⠰⠆⢾⣿",
  "  ⠙⠁⠀⢀⣤⠀⠀⠀⠀⣠⡄⠀⠈⠛",
  "  ⠀⠺⣿⣦⠉⠀⠰⠆⠀⠈⣱⣾⡿⠀",
  "  ⠀⠀⠈⠛⠀⣰⣾⣿⣦⠀⠙⠋⠀⠀",
];

const CANVAS_LOGO_WIDTH = Math.max(...CANVAS_LOGO.map((l) => [...l].length));

export function buildLogoBanner(title: string, subtitle?: string, options?: { styledSubtitle?: string }): string[] {
  const logoWidth = CANVAS_LOGO_WIDTH;
  const subtitleLine = options?.styledSubtitle ?? (subtitle ? C.dimmer(subtitle) : "");
  const textLines: string[] = [
    C.pureWhiteBold(title),
    subtitleLine,
  ].filter(Boolean);
  const textStart = 2;

  const bannerLines: string[] = [];
  for (let i = 0; i < CANVAS_LOGO.length; i++) {
    const logoLine = CANVAS_LOGO[i]!;
    const pad = " ".repeat(Math.max(0, logoWidth - [...logoLine].length));
    const textIndex = i - textStart;
    const rightText = textIndex >= 0 && textIndex < textLines.length
      ? "   " + textLines[textIndex]!
      : "";
    bannerLines.push(" " + C.primary(logoLine) + pad + rightText);
  }
  return bannerLines;
}

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
    const screenSizeKey = `${rows}:${cols}`;
    const normalizeLine = (line: string): string => `\x1B[0m${line}\x1B[0m`;
    const maxVisibleCols = Math.max(1, cols - 1);

    if (lastFlushedSize !== screenSizeKey) {
      lastFlushedRows = null;
      lastFlushedSize = screenSizeKey;
    }

    // Truncate lines to terminal width so they never wrap
    let rendered = this.lines.map((line) => {
      const visible = visibleWidth(line);
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

    // Fill remaining content rows with blank lines (reserved rows are managed separately)
    while (rendered.length < maxContentLines) {
      rendered.push("");
    }

    const writes: string[] = [];
    for (let row = 0; row < maxContentLines; row++) {
      if (lastFlushedRows?.[row] === rendered[row]) {
        continue;
      }
      if (writes.length === 0) {
        writes.push("\x1B[0m");
      }
      writes.push(`\x1B[${row + 1};1H\x1B[0m\x1B[2K${rendered[row]!}`);
    }
    if (writes.length > 0) {
      writes.push("\x1B[0m");
      process.stdout.write(writes.join(""));
    }

    lastFlushedRows = Array.from({ length: rows }, (_, i) =>
      i < rendered.length ? rendered[i]! : null
    );

    this.lines = [];
  }
}

/** Create a new screen buffer for flicker-free rendering. */
export function createBuffer(): ScreenBuffer {
  return new ScreenBuffer();
}

export function invalidateScreenRows(startRow: number, endRow: number): void {
  if (!lastFlushedRows) {
    return;
  }
  const start = Math.max(1, Math.min(startRow, endRow));
  const end = Math.min(lastFlushedRows.length, Math.max(startRow, endRow));
  for (let row = start; row <= end; row++) {
    lastFlushedRows[row - 1] = null;
  }
}

/** Clear the terminal screen and move cursor to top-left (used only for full transitions). */
export function clearScreen(): void {
  lastFlushedRows = null;
  lastFlushedSize = "";
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
  lastFlushedRows = null;
  lastFlushedSize = "";
  process.stdout.write("\x1B[?1049h");
}

/** Restore the normal screen buffer; call when leaving a full-screen TUI. */
export function leaveAlternateScreen(): void {
  lastFlushedRows = null;
  lastFlushedSize = "";
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
  let width = 0;
  for (const char of stripAnsi(str)) {
    width += charDisplayWidth(char);
  }
  return width;
}

function charDisplayWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x1f000 && code <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
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
    const codePoint = str.codePointAt(i);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    const charWidth = charDisplayWidth(char);
    if (visible + charWidth > maxWidth) break;
    visible += charWidth;
    i += char.length;
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
