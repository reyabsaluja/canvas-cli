import chalk from "chalk";
import {
  C,
  createBuffer,
  getTermSize,
  invalidateScreenRows,
  stripAnsi,
  truncateAnsiToWidth,
} from "./screen.js";
import type {
  ChatMessage,
  CommandDefinition,
  ScopeRuntime,
} from "./chat-state.js";
import type { ShellOpenOption, ShellPinOption } from "./app-types.js";

const userBubbleBg = chalk.bgHex("#3a3a3a");
const userBoxBg = chalk.bgHex("#2a2a2a");
const userBarColor = chalk.hex("#e82429");
const commandBg = chalk.bgHex("#2a2a2a");
const inputBorderColor = chalk.hex("#505050");
const inputPromptColor = chalk.hex("#e82429");
const inputPlaceholderFg = chalk.hex("#808080");
const toolActionColor = chalk.hex("#e8a86d").bold;
const toolTargetGreen = chalk.hex("#6ec86a");
const toolTargetRed = chalk.hex("#ff6b6b");
const statusBarGrey = chalk.hex("#808080");
let lastStickyBottomRows: string[] | null = null;
let lastStickyBottomScreenSize = "";
let lastOverlayRows: string[] | null = null;
let lastOverlayStartRow = -1;
let lastOverlayScreenSize = "";

const BASE_STICKY_ROWS = 4;
let currentStickyRows = BASE_STICKY_ROWS;
export function getStickyBottomRows(): number { return currentStickyRows; }
export const STICKY_BOTTOM_ROWS = BASE_STICKY_ROWS;
const CHAT_GAP_ROWS = 2;
const MAX_OVERLAY_ROWS = 8;
export const MAIN_VIEW_BOTTOM_RESERVE = BASE_STICKY_ROWS + CHAT_GAP_ROWS;

export interface RenderChatFrameOptions {
  runtime: ScopeRuntime;
  placeholder: string;
  inputBuffer: string;
  chatScrollOffset: number;
  isProcessing: boolean;
  currentSpinnerLine: string;
  modelLabel: string;
  bannerLines: string[];
  transcriptTotalLines: number;
  getTranscriptLines: (startLine: number, endLine: number) => string[];
  slashMatches: CommandDefinition[];
  openMatches: ShellOpenOption[];
  pinMatches: ShellPinOption[];
  slashSelected: number;
  openSelected: number;
  pinSelected: number;
}

const messageRenderCache = new WeakMap<ChatMessage, Map<string, string[]>>();

export function resetChatShellRenderCache(): void {
  lastStickyBottomRows = null;
  lastStickyBottomScreenSize = "";
  lastOverlayRows = null;
  lastOverlayStartRow = -1;
  lastOverlayScreenSize = "";
}

export function buildBannerLines(options: {
  runtime: ScopeRuntime;
  bannerRenderer?: (buf: { push(line?: string): void }) => void;
}): string[] {
  if (options.bannerRenderer) {
    const lines: string[] = [];
    options.bannerRenderer({
      push(line = "") {
        lines.push(line);
      },
    });
    return lines;
  }

  const { cols } = getTermSize();
  const title = options.runtime.title;
  const subtitle = options.runtime.subtitle ?? "";

  const left = C.pureWhiteBold(title) + (subtitle ? "  " + statusBarGrey(subtitle) : "");
  const leftPlain = title + (subtitle ? "  " + subtitle : "");

  const rightText = options.runtime.statusLabel?.replace(/^Status:\s*/, "") ?? "";
  const right = rightText ? statusBarGrey(rightText) : "";
  const rightPlain = rightText;

  const gap = Math.max(2, cols - 4 - leftPlain.length - rightPlain.length);
  const headerLine = "  " + left + " ".repeat(gap) + right;

  const dividerWidth = Math.max(24, cols - 4);
  const divider = "  " + C.dimmer("─".repeat(dividerWidth));

  return [headerLine, divider];
}

export function renderChatFrame(
  options: RenderChatFrameOptions
): { chatScrollOffset: number; maxScroll: number } {
  const buf = createBuffer();
  const { cols, rows } = getTermSize();
  const contentWidth = Math.min(cols - 4, 100);
  const baseHeaderLines = ["", "", ...options.bannerLines, ""];
  const olderHintLines =
    options.chatScrollOffset > 0
      ? [
          C.dim(
            "  ↑ Older · PgUp / PgDn · Ctrl+P up / Ctrl+N down · End latest · Home oldest"
          ),
        ]
      : [];
  const spinnerLines =
    options.isProcessing && options.currentSpinnerLine
      ? ["", `  ${options.currentSpinnerLine}`]
      : [];
  const maxContent = Math.max(1, rows - currentStickyRows - CHAT_GAP_ROWS);
  const baseContentHeight =
    baseHeaderLines.length +
    olderHintLines.length +
    options.transcriptTotalLines +
    spinnerLines.length +
    CHAT_GAP_ROWS;
  const topPadding = Math.floor(Math.max(0, maxContent - baseContentHeight) / 2);
  const headerLines = [...new Array<string>(topPadding).fill(""), ...baseHeaderLines];
  const totalVirtualLines =
    headerLines.length +
    olderHintLines.length +
    options.transcriptTotalLines +
    spinnerLines.length +
    CHAT_GAP_ROWS;

  const maxScroll = Math.max(0, totalVirtualLines - maxContent);
  const chatScrollOffset = Math.min(
    Math.max(0, options.chatScrollOffset),
    maxScroll
  );
  const end = totalVirtualLines - chatScrollOffset;
  const start = Math.max(0, end - maxContent);
  const transcriptSectionStart = headerLines.length + olderHintLines.length;
  const transcriptLines = options.getTranscriptLines(
    Math.max(0, start - transcriptSectionStart),
    Math.max(0, end - transcriptSectionStart)
  );
  const overlayRows = buildAutocompleteOverlayRows(
    options.slashMatches,
    options.openMatches,
    options.pinMatches,
    options.slashSelected,
    options.openSelected,
    options.pinSelected,
    options.inputBuffer
  );
  if (overlayRows === null && lastOverlayRows) {
    invalidateScreenRows(
      lastOverlayStartRow,
      lastOverlayStartRow + lastOverlayRows.length - 1
    );
    lastOverlayRows = null;
    lastOverlayStartRow = -1;
    lastOverlayScreenSize = "";
  }

  appendVisibleLines(buf, headerLines, start, end, 0);
  appendVisibleLines(buf, olderHintLines, start, end, headerLines.length);
  appendVisibleLines(buf, transcriptLines, 0, transcriptLines.length, 0);
  appendVisibleLines(
    buf,
    spinnerLines,
    start,
    end,
    transcriptSectionStart + options.transcriptTotalLines
  );
  appendVisibleBlankSection(
    buf,
    CHAT_GAP_ROWS,
    start,
    end,
    headerLines.length +
      olderHintLines.length +
      options.transcriptTotalLines +
      spinnerLines.length
  );

  buf.flush(currentStickyRows, chatScrollOffset);
  writeStickyBottom(
    buildStickyBottomRows(
      options.placeholder,
      options.inputBuffer,
      options.runtime.scopeLabel,
      options.runtime.statusLabel,
      options.modelLabel
    )
  );
  writeAutocompleteOverlay(overlayRows);

  return { chatScrollOffset, maxScroll };
}

export function renderInputFooter(options: {
  placeholder: string;
  inputBuffer: string;
  scopeLabel: string;
  statusLabel?: string;
  modelLabel: string;
  slashMatches: CommandDefinition[];
  openMatches: ShellOpenOption[];
  pinMatches: ShellPinOption[];
  slashSelected: number;
  openSelected: number;
  pinSelected: number;
}): void {
  writeStickyBottom(
    buildStickyBottomRows(
      options.placeholder,
      options.inputBuffer,
      options.scopeLabel,
      options.statusLabel,
      options.modelLabel
    )
  );
  const overlayRows = buildAutocompleteOverlayRows(
    options.slashMatches,
    options.openMatches,
    options.pinMatches,
    options.slashSelected,
    options.openSelected,
    options.pinSelected,
    options.inputBuffer
  );
  writeAutocompleteOverlay(overlayRows);
}

function buildAutocompleteOverlayRows(
  slashMatches: CommandDefinition[],
  openMatches: ShellOpenOption[],
  pinMatches: ShellPinOption[],
  slashSelected: number,
  openSelected: number,
  pinSelected: number,
  inputBuffer: string
): string[] | null {
  const { cols, rows } = getTermSize();
  const maxVisibleCols = Math.max(1, cols - 1);
  const lastRowAboveInput = rows - currentStickyRows;
  if (lastRowAboveInput < 1) return null;
  const hasOverlay =
    openMatches.length > 0 || pinMatches.length > 0 || slashMatches.length > 0;
  if (!hasOverlay) return null;

  const clearStartRow = Math.max(1, lastRowAboveInput - MAX_OVERLAY_ROWS + 1);
  const overlayRows = Array.from(
    { length: lastRowAboveInput - clearStartRow + 1 },
    () => ""
  );
  const fitToRow = (value: string): string => {
    const visible = stripAnsi(value).length;
    if (visible > maxVisibleCols) {
      return truncateAnsiToWidth(value, maxVisibleCols);
    }
    return value;
  };

  if (openMatches.length > 0) {
    const maxShow = Math.min(openMatches.length, lastRowAboveInput, MAX_OVERLAY_ROWS);
    const start = Math.max(
      0,
      Math.min(openSelected - Math.floor(maxShow / 2), openMatches.length - maxShow)
    );
    const openIndex = inputBuffer.search(/\/open/i);
    const indent = " ".repeat(Math.max(0, openIndex + 1));
    const firstRow = lastRowAboveInput - maxShow + 1;
    for (let index = 0; index < maxShow; index++) {
      const option = openMatches[start + index]!;
      const selected = start + index === openSelected;
      const pointer = selected ? C.bold("❯ ") : "  ";
      const title = selected ? C.bold(option.title) : C.text(option.title);
      overlayRows[firstRow + index - clearStartRow] = fitToRow(
        `${indent}${pointer}${title}${
          option.detail ? `  ${C.dim(option.detail)}` : ""
        }`
      );
    }
    return overlayRows;
  }

  if (pinMatches.length > 0) {
    const maxShow = Math.min(pinMatches.length, lastRowAboveInput, MAX_OVERLAY_ROWS);
    const start = Math.max(
      0,
      Math.min(pinSelected - Math.floor(maxShow / 2), pinMatches.length - maxShow)
    );
    const pinIndex = inputBuffer.search(/\/pin/i);
    const indent = " ".repeat(Math.max(0, pinIndex + 1));
    const firstRow = lastRowAboveInput - maxShow + 1;
    for (let index = 0; index < maxShow; index++) {
      const pin = pinMatches[start + index]!;
      const selected = start + index === pinSelected;
      const pointer = selected ? C.bold("❯ ") : "  ";
      const label = selected ? C.bold(pin.label) : C.text(pin.label);
      overlayRows[firstRow + index - clearStartRow] = fitToRow(
        `${indent}${pointer}${label}  ${C.dim(pin.name)}`
      );
    }
    return overlayRows;
  }

  const maxShow = Math.min(slashMatches.length, lastRowAboveInput, MAX_OVERLAY_ROWS);
  const start = Math.max(
    0,
    Math.min(slashSelected - Math.floor(maxShow / 2), slashMatches.length - maxShow)
  );
  const firstRow = lastRowAboveInput - maxShow + 1;
  for (let index = 0; index < maxShow; index++) {
    const command = slashMatches[start + index]!;
    const selected = start + index === slashSelected;
    const pointer = selected ? C.bold("❯ ") : "  ";
    const name = selected ? C.bold(command.name) : C.text(command.name);
    overlayRows[firstRow + index - clearStartRow] = fitToRow(
      ` ${pointer}${name}  ${C.muted(command.description)}`
    );
  }

  return overlayRows;
}

function buildStickyBottomRows(
  placeholder: string,
  inputBuffer: string,
  leftStatus: string,
  runtimeStatus: string | undefined,
  modelLabel: string
): string[] {
  const { cols, rows: termRows } = getTermSize();
  const boxWidth = Math.max(24, cols - 4);
  const promptStr = "> ";
  const promptLen = promptStr.length;
  const firstLineWidth = Math.max(1, boxWidth - 2 - promptLen);
  const contLineWidth = Math.max(1, boxWidth - 2);
  const cursor = chalk.white("█");
  const fitToRow = (value: string) => {
    const visible = stripAnsi(value).length;
    if (visible > cols - 1) {
      return truncateAnsiToWidth(value, cols - 1);
    }
    return value;
  };
  const b = inputBorderColor;
  const padTo = (text: string, width: number) => {
    const visible = stripAnsi(text).length;
    return text + " ".repeat(Math.max(0, width - visible));
  };

  const contentRows: string[] = [];

  if (!inputBuffer) {
    const maxPlaceholder = Math.max(0, firstLineWidth - 1);
    const trimmed =
      placeholder.length > maxPlaceholder && maxPlaceholder > 3
        ? placeholder.slice(0, maxPlaceholder - 3) + "..."
        : placeholder.slice(0, maxPlaceholder);
    const styled = inputPlaceholderFg(trimmed);
    const displayText = padTo(cursor + styled, firstLineWidth);
    contentRows.push(`  ${b("│")} ${inputPromptColor(">")} ${displayText} ${b("│")}`);
  } else {
    const textWithCursor = inputBuffer + "█";
    const chunks: string[] = [];
    let remaining = textWithCursor;
    let isFirst = true;
    while (remaining.length > 0) {
      const w = isFirst ? firstLineWidth : contLineWidth;
      chunks.push(remaining.slice(0, w));
      remaining = remaining.slice(w);
      isFirst = false;
    }

    const maxInputLines = Math.max(1, Math.floor((termRows - 3) / 2));
    const visibleChunks = chunks.length > maxInputLines
      ? chunks.slice(chunks.length - maxInputLines)
      : chunks;

    for (let i = 0; i < visibleChunks.length; i++) {
      const chunk = visibleChunks[i]!;
      const isFirstVisible = i === 0 && visibleChunks === chunks;
      const w = isFirstVisible ? firstLineWidth : contLineWidth;
      const hasCursor = chunk.endsWith("█");
      const rawText = hasCursor ? chunk.slice(0, -1) : chunk;
      const colored = rawText.replace(/\/pin\s+\S+/g, (match) => C.warm(match));
      const display = hasCursor ? colored + cursor : colored;
      const padded = padTo(display, w);
      if (isFirstVisible) {
        contentRows.push(`  ${b("│")} ${inputPromptColor(">")} ${padded} ${b("│")}`);
      } else {
        contentRows.push(`  ${b("│")} ${padded} ${b("│")}`);
      }
    }
  }

  let left = runtimeStatus ? `${leftStatus} · ${runtimeStatus}` : leftStatus;
  let right = modelLabel;
  const rightVisible = stripAnsi(right).length;
  if (stripAnsi(left).length + rightVisible + 1 > boxWidth) {
    const maxLeft = Math.max(0, boxWidth - rightVisible - 1);
    left =
      maxLeft > 3 ? left.slice(0, maxLeft - 3) + "..." : left.slice(0, maxLeft);
  }
  const leftStyled = statusBarGrey(left);
  const gap = Math.max(
    0,
    boxWidth - stripAnsi(leftStyled).length - rightVisible
  );
  const statusLine =
    "  " +
    leftStyled +
    " ".repeat(gap) +
    statusBarGrey(right);

  const topBorder = `  ${b("╭" + "─".repeat(boxWidth) + "╮")}`;
  const botBorder = `  ${b("╰" + "─".repeat(boxWidth) + "╯")}`;

  const result = [
    fitToRow(topBorder),
    ...contentRows.map(fitToRow),
    fitToRow(botBorder),
    fitToRow(statusLine),
  ];

  currentStickyRows = result.length;
  return result;
}

function writeStickyBottom(rows: string[]): void {
  const { rows: totalRows, cols } = getTermSize();
  const screenSizeKey = `${totalRows}:${cols}`;
  if (
    lastStickyBottomScreenSize !== screenSizeKey ||
    !lastStickyBottomRows ||
    lastStickyBottomRows.length !== rows.length
  ) {
    lastStickyBottomRows = null;
    lastStickyBottomScreenSize = screenSizeKey;
  }

  const startRow = totalRows - rows.length + 1;
  const writes: string[] = [];
  for (let index = 0; index < rows.length; index++) {
    if (lastStickyBottomRows?.[index] === rows[index]) {
      continue;
    }
    if (writes.length === 0) {
      writes.push("\x1B[0m");
    }
    writes.push(`\x1B[${startRow + index};1H\x1B[0m\x1B[2K${rows[index]!}`);
  }
  if (writes.length > 0) {
    writes.push("\x1B[0m");
    process.stdout.write(writes.join(""));
  }
  lastStickyBottomRows = rows.slice();
}

function writeAutocompleteOverlay(rows: string[] | null): void {
  const { rows: totalRows, cols } = getTermSize();
  const screenSizeKey = `${totalRows}:${cols}`;
  if (rows === null) {
    lastOverlayRows = null;
    lastOverlayStartRow = -1;
    lastOverlayScreenSize = screenSizeKey;
    return;
  }

  const startRow = Math.max(1, totalRows - currentStickyRows - rows.length + 1);
  if (
    lastOverlayScreenSize !== screenSizeKey ||
    lastOverlayStartRow !== startRow ||
    !lastOverlayRows ||
    lastOverlayRows.length !== rows.length
  ) {
    lastOverlayRows = null;
    lastOverlayStartRow = startRow;
    lastOverlayScreenSize = screenSizeKey;
  }

  const writes: string[] = [];
  for (let index = 0; index < rows.length; index++) {
    if (lastOverlayRows?.[index] === rows[index]) {
      continue;
    }
    if (writes.length === 0) {
      writes.push("\x1B[0m");
    }
    writes.push(`\x1B[${startRow + index};1H\x1B[0m\x1B[2K${rows[index]!}`);
  }
  if (writes.length > 0) {
    writes.push("\x1B[0m");
    process.stdout.write(writes.join(""));
  }

  lastOverlayRows = rows.slice();
}

export function getRenderedMessageLines(
  message: ChatMessage,
  maxWidth: number,
  cols: number,
  expanded: boolean
): string[] {
  const cacheKey = `${maxWidth}:${cols}:${expanded ? 1 : 0}`;
  let cache = messageRenderCache.get(message);
  if (!cache) {
    cache = new Map<string, string[]>();
    messageRenderCache.set(message, cache);
  }
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const lines: string[] = [""];

  switch (message.role) {
    case "user": {
      const trimmed = message.content.trim();
      if (trimmed.startsWith("/")) {
        const cmdBarWidth = Math.max(24, cols - 4);
        const cmdInnerWidth = Math.max(1, cmdBarWidth - 2);
        const rendered = wrapLines(trimmed, Math.max(12, cmdInnerWidth)).map((line) => {
          const visible = stripAnsi(line).length;
          const pad = " ".repeat(Math.max(0, cmdInnerWidth - visible));
          return `  ${commandBg(` ${chalk.white.bold(line)}${pad} `)}`;
        });
        cache.set(cacheKey, ["", ...rendered]);
        return ["", ...rendered];
      }

      const bar = userBarColor("█");
      const boxWidth = Math.max(24, cols - 5);
      const innerWidth = Math.max(1, boxWidth - 2);
      const wrappedLines = wrapLines(message.content, innerWidth);
      const padInner = (line: string) => {
        const visible = stripAnsi(line).length;
        return line + " ".repeat(Math.max(0, innerWidth - visible));
      };
      const rendered: string[] = [];
      for (const line of wrappedLines) {
        rendered.push(`  ${bar}${userBoxBg(` ${chalk.white(padInner(line))} `)}`);
      }
      cache.set(cacheKey, ["", ...rendered]);
      return ["", ...rendered];
    }
    case "assistant": {
      renderWrappedContent(message.content, lines, maxWidth);
      if (message.bulletPoints?.length) {
        lines.push("");
        for (const point of message.bulletPoints) {
          lines.push(`  ${C.dim("•")} ${chalk.white(point)}`);
        }
      }
      if (message.sources?.length) {
        lines.push("");
        for (const source of message.sources) {
          lines.push(`  ${C.dimmer(`[${source.kind}]`)} ${C.dim(source.title)}`);
        }
      }
      break;
    }
    case "system": {
      const isElapsedSummary = /^(Worked|Thought|Studied|Read|Analyzed|Explored|Reviewed) for \d/.test(message.content);
      const systemColor = isElapsedSummary ? chalk.hex("#707070") : chalk.white;
      wrapLines(message.content, maxWidth).forEach((line) => {
        lines.push(`  ${systemColor(line)}`);
      });
      break;
    }
    case "tool": {
      const marker = message.toolColor === "red" ? C.error("│") : C.success("│");
      const targetColor =
        message.toolColor === "red" ? toolTargetRed : toolTargetGreen;
      const boxWidth = getTranscriptBlockWidth(maxWidth, cols);
      const innerWidth = Math.max(1, boxWidth - 6);
      lines.push(
        `  ${marker} ${toolActionColor(message.toolAction ?? "tool")} ${targetColor(
          message.toolTarget ?? ""
        )}`
      );
      const wrappedContentLines = message.content
        .split("\n")
        .flatMap((line) => wrapLines(line, innerWidth));
      const showLines = expanded
        ? wrappedContentLines
        : wrappedContentLines.slice(0, 8);
      const remaining = expanded
        ? 0
        : Math.max(0, wrappedContentLines.length - 8);
      lines.push("");
      for (const line of showLines) {
        lines.push(`  ${marker} ${chalk.white(line)}`);
      }
      if (remaining > 0) {
        lines.push(
          `  ${marker} ${C.dim(`... (${remaining} more lines, `)}${C.dimmer(
            "ctrl+o"
          )}${C.dim(" to expand)")}`
        );
      }
      break;
    }
  }

  cache.set(cacheKey, lines);
  return lines;
}

export function buildTranscriptLines(options: {
  messages: ChatMessage[];
  contentWidth: number;
  cols: number;
  expanded: boolean;
}): string[] {
  return options.messages.flatMap((message) =>
    getRenderedMessageLines(
      message,
      options.contentWidth,
      options.cols,
      options.expanded
    )
  );
}

function renderWrappedContent(content: string, lines: string[], maxWidth: number): void {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      lines.push("");
      continue;
    }
    if (/^[-*_]{3,}$/.test(trimmed) || trimmed === "***") {
      lines.push(`  ${C.dimmer("─".repeat(Math.min(maxWidth - 4, 40)))}`);
      continue;
    }
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      lines.push("");
      lines.push(`  ${C.bold(applyInlineFormatting(headingMatch[2]!))}`);
      continue;
    }
    const bulletMatch = trimmed.match(/^[*\-•]\s+(.+)/);
    if (bulletMatch) {
      const text = applyInlineFormatting(bulletMatch[1]!);
      wrapLines(stripAnsi(text), maxWidth - 6).forEach((wrapped, index) => {
        lines.push(
          index === 0
            ? `  ${C.dim("•")} ${applyInlineFormatting(wrapped)}`
            : `    ${applyInlineFormatting(wrapped)}`
        );
      });
      continue;
    }
    const numbered = trimmed.match(/^(\d+)\.\s+(.+)/);
    if (numbered) {
      wrapLines(stripAnsi(numbered[2]!), maxWidth - 6).forEach((wrapped, index) => {
        lines.push(
          index === 0
            ? `  ${C.bold(numbered[1]! + ".")} ${applyInlineFormatting(
                wrapped
              )}`
            : `      ${applyInlineFormatting(wrapped)}`
        );
      });
      continue;
    }
    wrapLines(stripAnsi(trimmed), maxWidth - 2).forEach((wrapped) => {
      lines.push(`  ${applyInlineFormatting(wrapped)}`);
    });
  }
}

function appendVisibleLines(
  buf: { push(line?: string): void },
  lines: string[],
  start: number,
  end: number,
  sectionStart: number
): void {
  if (lines.length === 0) return;
  const visibleStart = Math.max(start - sectionStart, 0);
  const visibleEnd = Math.min(end - sectionStart, lines.length);
  if (visibleStart >= visibleEnd) return;
  for (let index = visibleStart; index < visibleEnd; index++) {
    buf.push(lines[index]!);
  }
}

function appendVisibleBlankSection(
  buf: { push(line?: string): void },
  count: number,
  start: number,
  end: number,
  sectionStart: number
): void {
  const visibleStart = Math.max(start - sectionStart, 0);
  const visibleEnd = Math.min(end - sectionStart, count);
  for (let index = visibleStart; index < visibleEnd; index++) {
    buf.push("");
  }
}

function applyInlineFormatting(text: string): string {
  let result = text;
  result = result.replace(/\*\*(.+?)\*\*/g, (_match, inner) => chalk.white.bold(inner));
  result = result.replace(/__(.+?)__/g, (_match, inner) => chalk.white.bold(inner));
  result = result.replace(/`([^`]+)`/g, (_match, inner) => C.warm(inner));
  result = result.replace(
    /(?<!\*)\*([^*]+)\*(?!\*)/g,
    (_match, inner) => chalk.white.italic(inner)
  );
  return result === text ? chalk.white(text) : result;
}

function wrapLines(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!word) continue;
    if (word.length > maxWidth) {
      if (current) {
        lines.push(current);
        current = "";
      }
      for (let index = 0; index < word.length; index += maxWidth) {
        lines.push(word.slice(index, index + maxWidth));
      }
      continue;
    }
    if (current.length + word.length + 1 > maxWidth && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function getTranscriptBlockWidth(maxWidth: number, cols: number): number {
  return Math.max(24, Math.min(Math.max(maxWidth, cols - 8), cols - 4));
}
