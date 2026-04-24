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
  const description = options.runtime.description ?? "";

  const left = C.pureWhiteBold(title) + (subtitle ? "  " + statusBarGrey(subtitle) : "");
  const leftPlain = title + (subtitle ? "  " + subtitle : "");

  const statusText = options.runtime.statusLabel?.replace(/^Status:\s*/, "") ?? "";
  const maxRightWidth = Math.max(0, cols - 4 - leftPlain.length - 4);
  let rightText = "";
  if (description && maxRightWidth >= 12) {
    rightText = description.length > maxRightWidth
      ? description.slice(0, maxRightWidth - 3) + "..."
      : description;
    if (statusText) {
      const combined = `${rightText} · ${statusText}`;
      rightText = combined.length > maxRightWidth
        ? rightText
        : combined;
    }
  } else {
    rightText = statusText;
  }
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
  const stickyRows = buildStickyBottomRows(
    options.placeholder,
    options.inputBuffer,
    options.runtime.scopeLabel,
    options.runtime.statusLabel,
    options.modelLabel
  );

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
  writeStickyBottom(stickyRows);
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
    const pinIndex = inputBuffer.search(/@/);
    const indent = " ".repeat(Math.max(0, pinIndex + 1));
    const firstRow = lastRowAboveInput - maxShow + 1;
    for (let index = 0; index < maxShow; index++) {
      const pin = pinMatches[start + index]!;
      const selected = start + index === pinSelected;
      const pointer = selected ? C.bold("❯ ") : "  ";
      const title = selected ? C.bold(pin.name) : C.text(pin.name);
      overlayRows[firstRow + index - clearStartRow] = fitToRow(
        `${indent}${pointer}${title}${pin.detail ? `  ${C.dim(pin.detail)}` : ""}`
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
  const boxWidth = Math.max(24, cols - 5);
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
      const colored = rawText.replace(/@\S+/g, (match) => C.warm(match));
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
  const prevLen = lastStickyBottomRows?.length ?? 0;
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

  if (prevLen > 0 && prevLen !== rows.length) {
    const oldStartRow = totalRows - prevLen + 1;
    const clearEnd = Math.min(oldStartRow + prevLen, startRow);
    for (let r = oldStartRow; r < clearEnd; r++) {
      if (r >= 1 && r <= totalRows) {
        writes.push(`\x1B[${r};1H\x1B[2K`);
      }
    }
    invalidateScreenRows(oldStartRow, clearEnd - 1);
  }
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
      if (message.verificationNote) {
        lines.push("");
        lines.push(`  ${chalk.hex("#d9a441").bold("Grounding")}`);
        wrapLines(message.verificationNote, Math.max(12, maxWidth - 2)).forEach((line) => {
          lines.push(`  ${chalk.hex("#d9a441")(line)}`);
        });
      }
      if (message.sources?.length) {
        lines.push("");
        for (const source of message.sources) {
          const label = source.section
            ? `${source.title} — ${source.section}`
            : source.title;
          lines.push(`  ${C.dimmer(`[${source.kind}]`)} ${C.dim(label)}`);
        }
      }
      break;
    }
    case "system": {
      const isError = message.content.startsWith("Error:");
      const isElapsedSummary = /^(Worked|Thought|Studied|Read|Analyzed|Explored|Reviewed) for \d/.test(message.content);
      const systemColor = isError
        ? chalk.hex("#ff6b6b")
        : isElapsedSummary
          ? chalk.hex("#707070")
          : chalk.white;
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
  const rawLines = content.split("\n");
  for (let index = 0; index < rawLines.length; index++) {
    const line = rawLines[index]!;
    const trimmed = line.trim();
    if (!trimmed) {
      lines.push("");
      continue;
    }
    const tableConsumed = tryRenderTable(rawLines, index, lines, maxWidth);
    if (tableConsumed > 0) {
      index += tableConsumed - 1;
      continue;
    }
    if (/^[-*_]{3,}$/.test(trimmed) || trimmed === "***") {
      lines.push(`  ${C.dimmer("─".repeat(Math.max(1, maxWidth - 2)))}`);
      continue;
    }
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      const { plain } = parseAndStripFormatting(headingMatch[2]!);
      lines.push("");
      lines.push(`  ${chalk.white.bold(plain)}`);
      continue;
    }
    const bulletMatch = trimmed.match(/^[*\-•]\s+(.+)/);
    if (bulletMatch) {
      formatAndWrap(bulletMatch[1]!, maxWidth - 6).forEach((wrapped, index) => {
        lines.push(
          index === 0
            ? `  ${C.dim("•")} ${wrapped}`
            : `    ${wrapped}`
        );
      });
      continue;
    }
    const numbered = trimmed.match(/^(\d+)\.\s+(.+)/);
    if (numbered) {
      formatAndWrap(numbered[2]!, maxWidth - 6).forEach((wrapped, index) => {
        lines.push(
          index === 0
            ? `  ${C.bold(numbered[1]! + ".")} ${wrapped}`
            : `      ${wrapped}`
        );
      });
      continue;
    }
    formatAndWrap(trimmed, maxWidth - 2).forEach((wrapped) => {
      lines.push(`  ${wrapped}`);
    });
  }
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

function isTableSeparatorRow(cells: string[]): boolean {
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function tryRenderTable(
  rawLines: string[],
  startIndex: number,
  out: string[],
  maxWidth: number
): number {
  const headerCells = splitTableRow(rawLines[startIndex] ?? "");
  if (!headerCells || headerCells.length < 2) return 0;
  const separatorCells = splitTableRow(rawLines[startIndex + 1] ?? "");
  if (!separatorCells || !isTableSeparatorRow(separatorCells)) return 0;
  if (separatorCells.length !== headerCells.length) return 0;

  const bodyRows: string[][] = [];
  let cursor = startIndex + 2;
  while (cursor < rawLines.length) {
    const cells = splitTableRow(rawLines[cursor] ?? "");
    if (!cells) break;
    while (cells.length < headerCells.length) cells.push("");
    if (cells.length > headerCells.length) cells.length = headerCells.length;
    bodyRows.push(cells);
    cursor++;
  }

  renderMarkdownTable(headerCells, bodyRows, out, maxWidth);
  return cursor - startIndex;
}

function renderMarkdownTable(
  header: string[],
  rows: string[][],
  out: string[],
  maxWidth: number
): void {
  const colCount = header.length;
  const available = Math.max(20, maxWidth - 2);
  // Subtract vertical borders (colCount + 1) and padding (2 per col).
  const borderOverhead = colCount + 1 + colCount * 2;
  const usableContent = Math.max(colCount, available - borderOverhead);

  const headerParsed = header.map((cell) => parseAndStripFormatting(cell));
  const rowsParsed = rows.map((row) => row.map((cell) => parseAndStripFormatting(cell)));

  const naturalWidths = headerParsed.map((parsed, i) => {
    let widest = parsed.plain.length;
    for (const row of rowsParsed) {
      const cellPlain = row[i]?.plain ?? "";
      for (const piece of cellPlain.split(/\s+/)) {
        widest = Math.max(widest, piece.length);
      }
      widest = Math.max(widest, Math.min(cellPlain.length, 24));
    }
    return Math.max(3, widest);
  });

  const totalNatural = naturalWidths.reduce((a, b) => a + b, 0) || 1;
  let colWidths: number[];
  if (totalNatural <= usableContent) {
    colWidths = naturalWidths.slice();
    let remaining = usableContent - totalNatural;
    let i = 0;
    while (remaining > 0) {
      colWidths[i % colCount]!++;
      remaining--;
      i++;
    }
  } else {
    colWidths = naturalWidths.map((w) =>
      Math.max(3, Math.floor((w / totalNatural) * usableContent))
    );
    let diff = usableContent - colWidths.reduce((a, b) => a + b, 0);
    let i = 0;
    while (diff > 0) {
      colWidths[i % colCount]!++;
      diff--;
      i++;
    }
    while (diff < 0) {
      const idx = i % colCount;
      if (colWidths[idx]! > 3) {
        colWidths[idx]!--;
        diff++;
      }
      i++;
      if (i > colCount * 10) break;
    }
  }

  const b = C.dimmer;
  const top = b("┌") + colWidths.map((w) => b("─".repeat(w + 2))).join(b("┬")) + b("┐");
  const sep = b("├") + colWidths.map((w) => b("─".repeat(w + 2))).join(b("┼")) + b("┤");
  const bot = b("└") + colWidths.map((w) => b("─".repeat(w + 2))).join(b("┴")) + b("┘");

  const renderRow = (
    parsedCells: Array<{ plain: string; ranges: InlineRange[] }>,
    bold: boolean
  ): string[] => {
    const wrappedPerCol = parsedCells.map((parsed, i) => {
      const wrapped = wrapLines(parsed.plain, colWidths[i]!);
      let offset = 0;
      return wrapped.map((line) => {
        const styled = parsed.ranges.length
          ? applyFormattingRanges(line, offset, parsed.ranges)
          : (bold ? chalk.white.bold(line) : chalk.white(line));
        offset += line.length + 1;
        return { plain: line, styled };
      });
    });
    const height = Math.max(...wrappedPerCol.map((w) => w.length), 1);
    const rendered: string[] = [];
    for (let row = 0; row < height; row++) {
      const parts: string[] = [];
      for (let col = 0; col < colCount; col++) {
        const cell = wrappedPerCol[col]![row];
        const plain = cell?.plain ?? "";
        const styledBase = cell?.styled ?? chalk.white("");
        const styled = bold && cell && parsedCells[col]!.ranges.length === 0
          ? chalk.white.bold(plain)
          : styledBase;
        const pad = " ".repeat(Math.max(0, colWidths[col]! - plain.length));
        parts.push(` ${styled}${pad} `);
      }
      rendered.push(b("│") + parts.join(b("│")) + b("│"));
    }
    return rendered;
  };

  out.push("");
  out.push(`  ${top}`);
  for (const line of renderRow(headerParsed, true)) out.push(`  ${line}`);
  out.push(`  ${sep}`);
  for (let i = 0; i < rowsParsed.length; i++) {
    for (const line of renderRow(rowsParsed[i]!, false)) out.push(`  ${line}`);
  }
  out.push(`  ${bot}`);
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

interface InlineRange {
  start: number;
  end: number;
  style: "bold" | "italic" | "code" | "link";
}

const BARE_URL_RE = /\bhttps?:\/\/[^\s<>()[\]{}'"`]+[^\s<>()[\]{}'"`.,;:!?]/;

function parseAndStripFormatting(text: string): {
  plain: string;
  ranges: InlineRange[];
} {
  const ranges: InlineRange[] = [];
  let plain = "";
  let i = 0;

  while (i < text.length) {
    if (text[i] === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (
        closeBracket !== -1 &&
        text[closeBracket + 1] === "("
      ) {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          const label = text.slice(i + 1, closeBracket);
          const start = plain.length;
          plain += label;
          ranges.push({ start, end: plain.length, style: "link" });
          i = closeParen + 1;
          continue;
        }
      }
    }
    if (text[i] === "h" || text[i] === "H") {
      const rest = text.slice(i);
      const match = rest.match(BARE_URL_RE);
      if (match && match.index === 0) {
        const start = plain.length;
        plain += match[0];
        ranges.push({ start, end: plain.length, style: "link" });
        i += match[0].length;
        continue;
      }
    }
    if (text[i] === "*" && text[i + 1] === "*") {
      const close = text.indexOf("**", i + 2);
      if (close !== -1) {
        const start = plain.length;
        plain += text.slice(i + 2, close);
        ranges.push({ start, end: plain.length, style: "bold" });
        i = close + 2;
        continue;
      }
    }
    if (text[i] === "_" && text[i + 1] === "_") {
      const close = text.indexOf("__", i + 2);
      if (close !== -1) {
        const start = plain.length;
        plain += text.slice(i + 2, close);
        ranges.push({ start, end: plain.length, style: "bold" });
        i = close + 2;
        continue;
      }
    }
    if (text[i] === "`") {
      const close = text.indexOf("`", i + 1);
      if (close !== -1) {
        const start = plain.length;
        plain += text.slice(i + 1, close);
        ranges.push({ start, end: plain.length, style: "code" });
        i = close + 1;
        continue;
      }
    }
    if (text[i] === "*" && text[i + 1] !== "*") {
      const close = text.indexOf("*", i + 1);
      if (close !== -1 && text[close + 1] !== "*") {
        const start = plain.length;
        plain += text.slice(i + 1, close);
        ranges.push({ start, end: plain.length, style: "italic" });
        i = close + 1;
        continue;
      }
    }
    plain += text[i];
    i++;
  }

  return { plain, ranges };
}

function applyFormattingRanges(
  line: string,
  lineStart: number,
  ranges: InlineRange[]
): string {
  if (ranges.length === 0) return chalk.white(line);

  let result = "";
  let i = 0;

  while (i < line.length) {
    const pos = lineStart + i;
    const range = ranges.find((r) => pos >= r.start && pos < r.end);

    if (range) {
      let j = i;
      while (j < line.length && lineStart + j < range.end) j++;
      const segment = line.slice(i, j);
      switch (range.style) {
        case "bold":
          result += chalk.white.bold(segment);
          break;
        case "italic":
          result += chalk.white.italic(segment);
          break;
        case "code":
          result += C.warm(segment);
          break;
        case "link":
          result += C.secondary.underline(segment);
          break;
      }
      i = j;
    } else {
      let j = i + 1;
      while (j < line.length) {
        if (ranges.some((r) => lineStart + j >= r.start && lineStart + j < r.end))
          break;
        j++;
      }
      result += chalk.white(line.slice(i, j));
      i = j;
    }
  }

  return result || chalk.white(line);
}

function formatAndWrap(text: string, maxWidth: number): string[] {
  const { plain, ranges } = parseAndStripFormatting(stripAnsi(text));
  const wrapped = wrapLines(plain, maxWidth);

  if (ranges.length === 0) {
    return wrapped.map((line) => chalk.white(line));
  }

  let charOffset = 0;
  return wrapped.map((line) => {
    const formatted = applyFormattingRanges(line, charOffset, ranges);
    charOffset += line.length + 1;
    return formatted;
  });
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
