import chalk from "chalk";
import {
  C,
  createBuffer,
  getTermSize,
  stripAnsi,
  truncateAnsiToWidth,
} from "./screen.js";
import type {
  ChatMessage,
  CommandDefinition,
  ScopeRuntime,
} from "./chat-state.js";
import type { ShellOpenOption, ShellPinOption } from "./app-types.js";

const userBubbleBg = chalk.bgHex("#3a445d");
const inputBg = userBubbleBg;
const inputPlaceholderFg = chalk.hex("#8b95a8");
const toolActionColor = chalk.hex("#e0af68").bold;
const toolTargetGreen = chalk.hex("#9ece6a");
const toolTargetRed = chalk.hex("#f7768e");
const statusBarGrey = chalk.hex("#9ca3af");

export const STICKY_BOTTOM_ROWS = 4;
const CHAT_GAP_ROWS = 2;
const MAX_OVERLAY_ROWS = 8;
export const MAIN_VIEW_BOTTOM_RESERVE = STICKY_BOTTOM_ROWS + CHAT_GAP_ROWS;

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

  const subtitle = options.runtime.subtitle
    ? `  ${statusBarGrey(options.runtime.subtitle)}`
    : "";
  const status = options.runtime.statusLabel
    ? `  ${C.warn(options.runtime.statusLabel)}`
    : "";
  return [`  ${C.bold(options.runtime.title)}${subtitle}${status}`];
}

export function renderChatFrame(
  options: RenderChatFrameOptions
): { chatScrollOffset: number; maxScroll: number } {
  const buf = createBuffer();
  const { cols, rows } = getTermSize();
  const contentWidth = Math.min(cols - 4, 100);
  const headerLines = ["", "", ...options.bannerLines, ""];
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
  const totalVirtualLines =
    headerLines.length +
    olderHintLines.length +
    options.transcriptTotalLines +
    spinnerLines.length +
    CHAT_GAP_ROWS;
  const maxContent = Math.max(1, rows - MAIN_VIEW_BOTTOM_RESERVE);
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

  buf.flush(MAIN_VIEW_BOTTOM_RESERVE, chatScrollOffset);
  process.stdout.write(
    renderStickyBottom(
      options.placeholder,
      options.inputBuffer,
      options.runtime.scopeLabel,
      options.runtime.statusLabel,
      options.modelLabel
    ) +
      renderAutocompleteOverlay(
        options.slashMatches,
        options.openMatches,
        options.pinMatches,
        options.slashSelected,
        options.openSelected,
        options.pinSelected,
        options.inputBuffer
      )
  );

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
  process.stdout.write(
    renderStickyBottom(
      options.placeholder,
      options.inputBuffer,
      options.scopeLabel,
      options.statusLabel,
      options.modelLabel
    ) +
      renderAutocompleteOverlay(
        options.slashMatches,
        options.openMatches,
        options.pinMatches,
        options.slashSelected,
        options.openSelected,
        options.pinSelected,
        options.inputBuffer
      )
  );
}

function renderAutocompleteOverlay(
  slashMatches: CommandDefinition[],
  openMatches: ShellOpenOption[],
  pinMatches: ShellPinOption[],
  slashSelected: number,
  openSelected: number,
  pinSelected: number,
  inputBuffer: string
): string {
  const { cols, rows } = getTermSize();
  const maxVisibleCols = Math.max(1, cols - 1);
  const lastRowAboveInput = rows - STICKY_BOTTOM_ROWS;
  if (lastRowAboveInput < 1) return "";
  const hasOverlay =
    openMatches.length > 0 || pinMatches.length > 0 || slashMatches.length > 0;
  if (!hasOverlay) return "";

  const writes: string[] = [];
  const clearStartRow = Math.max(1, lastRowAboveInput - MAX_OVERLAY_ROWS + 1);
  const fitToRow = (value: string): string => {
    const visible = stripAnsi(value).length;
    if (visible > maxVisibleCols) {
      return truncateAnsiToWidth(value, maxVisibleCols);
    }
    return value;
  };
  for (let row = clearStartRow; row <= lastRowAboveInput; row++) {
    writes.push(`\x1B[${row};1H\x1B[0m\x1B[2K`);
  }

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
      writes.push(
        `\x1B[${firstRow + index};1H\x1B[0m\x1B[2K${fitToRow(
          `${indent}${pointer}${title}${
            option.detail ? `  ${C.dim(option.detail)}` : ""
          }`
        )}`
      );
    }
    writes.push("\x1B[0m");
    return writes.join("");
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
      writes.push(
        `\x1B[${firstRow + index};1H\x1B[0m\x1B[2K${fitToRow(
          `${indent}${pointer}${label}  ${C.dim(pin.name)}`
        )}`
      );
    }
    writes.push("\x1B[0m");
    return writes.join("");
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
    writes.push(
      `\x1B[${firstRow + index};1H\x1B[0m\x1B[2K${fitToRow(
        ` ${pointer}${name}  ${C.muted(command.description)}`
      )}`
    );
  }

  writes.push("\x1B[0m");
  return writes.join("");
}

function renderStickyBottom(
  placeholder: string,
  inputBuffer: string,
  leftStatus: string,
  runtimeStatus: string | undefined,
  modelLabel: string
): string {
  const { cols, rows } = getTermSize();
  const footerIndent = "  ";
  const contentWidth = Math.min(cols - 4, 100);
  const footerWidth = Math.max(
    24,
    Math.min(Math.max(contentWidth, cols - 8), cols - 4)
  );
  const innerWidth = Math.max(1, footerWidth - 2);
  const cursor = chalk.white("█");
  const emptyLine = " ".repeat(footerWidth);
  const fitToRow = (value: string) => {
    const visible = stripAnsi(value).length;
    if (visible > cols - 1) {
      return truncateAnsiToWidth(value, cols - 1);
    }
    return value;
  };

  let displayText: string;
  if (!inputBuffer) {
    const maxPlaceholder = Math.max(0, innerWidth - 1);
    const trimmed =
      placeholder.length > maxPlaceholder && maxPlaceholder > 3
        ? placeholder.slice(0, maxPlaceholder - 3) + "..."
        : placeholder.slice(0, maxPlaceholder);
    const styled = inputPlaceholderFg(trimmed);
    const remaining = Math.max(
      0,
      innerWidth - stripAnsi(cursor + styled).length
    );
    displayText = cursor + styled + " ".repeat(remaining);
  } else {
    const colored = inputBuffer.replace(/\/pin\s+\S+/g, (match) => C.warm(match));
    const visible = stripAnsi(colored + cursor).length;
    const remaining = Math.max(0, innerWidth - visible);
    displayText = colored + cursor + " ".repeat(remaining);
  }

  let left = runtimeStatus ? `${leftStatus} · ${runtimeStatus}` : leftStatus;
  let right = modelLabel;
  const rightVisible = stripAnsi(right).length;
  if (stripAnsi(left).length + rightVisible + 1 > footerWidth) {
    const maxLeft = Math.max(0, footerWidth - rightVisible - 1);
    left =
      maxLeft > 3 ? left.slice(0, maxLeft - 3) + "..." : left.slice(0, maxLeft);
  }
  const leftStyled = statusBarGrey(left);
  const gap = Math.max(
    0,
    footerWidth - stripAnsi(leftStyled).length - rightVisible
  );
  const statusLine =
    footerIndent +
    leftStyled +
    " ".repeat(gap) +
    statusBarGrey(right);
  const startRow = rows - 3;

  return (
    "\x1B[0m" +
    `\x1B[${startRow};1H\x1B[0m\x1B[2K` +
    fitToRow(`${footerIndent}${inputBg(emptyLine)}`) +
    `\x1B[${startRow + 1};1H\x1B[0m\x1B[2K` +
    fitToRow(`${footerIndent}${inputBg(` ${displayText} `)}`) +
    `\x1B[${startRow + 2};1H\x1B[0m\x1B[2K` +
    fitToRow(`${footerIndent}${inputBg(emptyLine)}`) +
    `\x1B[${startRow + 3};1H\x1B[0m\x1B[2K` +
    fitToRow(statusLine) +
    "\x1B[0m"
  );
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
        const rendered = wrapLines(trimmed, Math.max(12, maxWidth - 4)).map((line) =>
          `  ${C.bold(line)}`
        );
        cache.set(cacheKey, ["", ...rendered]);
        return ["", ...rendered];
      }

      const indent = "  ";
      const bubbleWidth = getTranscriptBlockWidth(maxWidth, cols);
      const innerWidth = Math.max(1, bubbleWidth - 2);
      const wrappedLines = wrapLines(message.content, innerWidth);
      const emptyLine = " ".repeat(bubbleWidth);
      const padInner = (line: string) => {
        const visible = stripAnsi(line).length;
        return line + " ".repeat(Math.max(0, innerWidth - visible));
      };
      const rendered: string[] = [`${indent}${userBubbleBg(emptyLine)}`];
      for (const line of wrappedLines) {
        rendered.push(`${indent}${userBubbleBg(` ${padInner(line)} `)}`);
      }
      rendered.push(`${indent}${userBubbleBg(emptyLine)}`);
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
    case "system":
      wrapLines(message.content, maxWidth).forEach((line) => {
        lines.push(`  ${chalk.white(line)}`);
      });
      break;
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
