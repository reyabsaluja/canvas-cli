import chalk from "chalk";
import {
  C,
  createBuffer,
  getTermSize,
  invalidateScreenRows,
  stripAnsi,
  truncateAnsiToWidth,
  visibleWidth,
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
let lastOverlayPaintedStart = -1;
let lastOverlayPaintedEnd = -1;

const BASE_STICKY_ROWS = 4;
let currentStickyRows = BASE_STICKY_ROWS;
export function getStickyBottomRows(): number { return currentStickyRows; }
export const STICKY_BOTTOM_ROWS = BASE_STICKY_ROWS;
export const CHAT_GAP_ROWS = 1;
const MAX_OVERLAY_ROWS = 8;
export const MAIN_VIEW_BOTTOM_RESERVE = BASE_STICKY_ROWS + CHAT_GAP_ROWS;

type InputMode = "sticky" | "flowing";
let currentInputMode: InputMode = "sticky";
let lastInputStartRow: number = 0;
export function getInputMode(): InputMode { return currentInputMode; }

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
  availableCommands?: CommandDefinition[];
}

const messageRenderCache = new WeakMap<ChatMessage, Map<string, string[]>>();

export function resetChatShellRenderCache(): void {
  lastStickyBottomRows = null;
  lastStickyBottomScreenSize = "";
  lastOverlayRows = null;
  lastOverlayStartRow = -1;
  lastOverlayScreenSize = "";
  lastOverlayPaintedStart = -1;
  lastOverlayPaintedEnd = -1;
  currentInputMode = "sticky";
  lastInputStartRow = 0;
}

const CANVAS_LOGO = [
  "  ⠀⠀⢀⣤⠀⠺⣿⣿⠗⠀⣠⣀⠀⠀",
  "  ⠀⣴⣿⠟⣀⠀⠰⡆⠀⢀⠻⣿⣧⠀",
  "  ⣠⡀⠀⠈⠛⠀⠀⠀⠀⠛⠃⠀⢀⣠",
  "  ⣿⣿⠰⠶⠀⠀⠀⠀⠀⠀⠰⠆⢾⣿",
  "  ⠙⠁⠀⢀⣤⠀⠀⠀⠀⣠⡄⠀⠈⠛",
  "  ⠀⠺⣿⣦⠉⠀⠰⠆⠀⠈⣱⣾⡿⠀",
  "  ⠀⠀⠈⠛⠀⣰⣾⣿⣦⠀⠙⠋⠀⠀",
];

function logoCodePointLength(line: string): number {
  return [...line].length;
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

  const title = options.runtime.title;
  const subtitle = options.runtime.subtitle ?? "";

  const logoWidth = Math.max(...CANVAS_LOGO.map((l) => logoCodePointLength(l)));
  const textLines: string[] = [
    C.pureWhiteBold(title),
    subtitle ? statusBarGrey(subtitle) : "",
  ].filter(Boolean);

  const totalLogoLines = CANVAS_LOGO.length;
  const textStart = 2;

  const bannerLines: string[] = [];
  for (let i = 0; i < totalLogoLines; i++) {
    const logoLine = CANVAS_LOGO[i]!;
    const pad = " ".repeat(Math.max(0, logoWidth - logoCodePointLength(logoLine)));
    const textIndex = i - textStart;
    const rightText = textIndex >= 0 && textIndex < textLines.length
      ? "   " + textLines[textIndex]!
      : "";
    bannerLines.push(" " + C.primary(logoLine) + pad + rightText);
  }

  return bannerLines;
}

export function renderChatFrame(
  options: RenderChatFrameOptions
): { chatScrollOffset: number; maxScroll: number } {
  const stickyRows = buildStickyBottomRows(
    options.placeholder,
    options.inputBuffer,
    options.runtime.scopeLabel,
    options.runtime.statusLabel,
    options.modelLabel,
    options.availableCommands
  );

  const buf = createBuffer();
  const { cols, rows } = getTermSize();
  const isGlobalScope = options.runtime.scope.type === "global";
  const baseHeaderLines = ["", "", ...options.bannerLines, ""];
  const spinnerLines =
    options.isProcessing && options.currentSpinnerLine
      ? ["", `  ${options.currentSpinnerLine}`]
      : [];

  if (!isGlobalScope) {
    const rawContentHeight =
      baseHeaderLines.length +
      options.transcriptTotalLines +
      spinnerLines.length +
      CHAT_GAP_ROWS +
      stickyRows.length;

    if (rawContentHeight <= rows) {
      // --- FLOWING MODE: input inline, no scroll ---
      const wasSticky = currentInputMode === "sticky";
      currentInputMode = "flowing";
      currentStickyRows = 0;

      for (const line of baseHeaderLines) buf.push(line);
      const transcriptLines = options.getTranscriptLines(0, options.transcriptTotalLines);
      for (const line of transcriptLines) buf.push(line);
      for (const line of spinnerLines) buf.push(line);
      for (let i = 0; i < CHAT_GAP_ROWS; i++) buf.push("");
      lastInputStartRow = baseHeaderLines.length + transcriptLines.length + spinnerLines.length + CHAT_GAP_ROWS + 1;
      for (const line of stickyRows) buf.push(line);

      if (wasSticky) {
        lastStickyBottomRows = null;
        lastStickyBottomScreenSize = "";
      }

      const overlayRows = buildAutocompleteOverlayRows(
        options.slashMatches,
        options.openMatches,
        options.pinMatches,
        options.slashSelected,
        options.openSelected,
        options.pinSelected,
        options.inputBuffer
      );
      clearOverlayPaintedRows();
      buf.flush(0, 0);
      writeAutocompleteOverlay(overlayRows);

      return { chatScrollOffset: 0, maxScroll: 0 };
    }

    // --- STICKY MODE (non-global, no centering) ---
    currentInputMode = "sticky";
    const olderHintLines =
      options.chatScrollOffset > 0
        ? [
            `  ${C.dim("↑ Older ·")} ${C.white("PgUp")} ${C.dim("/")} ${C.white("PgDn")} ${C.dim("·")} ${C.white("Ctrl+P")} ${C.dim("up /")} ${C.white("Ctrl+N")} ${C.dim("down ·")} ${C.white("End")} ${C.dim("latest ·")} ${C.white("Home")} ${C.dim("oldest")}`,
          ]
        : [];
    const headerLines = baseHeaderLines;
    const transcriptLines = options.getTranscriptLines(0, options.transcriptTotalLines);

    for (const line of headerLines) buf.push(line);
    for (const line of olderHintLines) buf.push(line);
    for (const line of transcriptLines) buf.push(line);
    for (const line of spinnerLines) buf.push(line);
    for (let i = 0; i < CHAT_GAP_ROWS; i++) buf.push("");

    const totalVirtualLines =
      headerLines.length +
      olderHintLines.length +
      transcriptLines.length +
      spinnerLines.length +
      CHAT_GAP_ROWS;
    const maxContent = Math.max(1, rows - currentStickyRows);
    const maxScroll = Math.max(0, totalVirtualLines - maxContent);
    const chatScrollOffset = Math.min(
      Math.max(0, options.chatScrollOffset),
      maxScroll
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
    clearOverlayPaintedRows();
    lastInputStartRow = rows - currentStickyRows + 1;
    buf.flush(currentStickyRows, chatScrollOffset);
    writeStickyBottom(stickyRows);
    writeAutocompleteOverlay(overlayRows);

    return { chatScrollOffset, maxScroll };
  }

  // --- GLOBAL SCOPE: existing behavior with centering ---
  currentInputMode = "sticky";
  const olderHintLines =
    options.chatScrollOffset > 0
      ? [
          C.dim(
            "  ↑ Older · PgUp / PgDn · Ctrl+P up / Ctrl+N down · End latest · Home oldest"
          ),
        ]
      : [];
  const maxContent = Math.max(1, rows - currentStickyRows);
  const baseContentHeight =
    baseHeaderLines.length +
    olderHintLines.length +
    options.transcriptTotalLines +
    spinnerLines.length +
    CHAT_GAP_ROWS;
  const topPadding = Math.floor(Math.max(0, maxContent - baseContentHeight) / 2);
  const headerLines = [...new Array<string>(topPadding).fill(""), ...baseHeaderLines];
  const transcriptLines = options.getTranscriptLines(0, options.transcriptTotalLines);

  for (const line of headerLines) buf.push(line);
  for (const line of olderHintLines) buf.push(line);
  for (const line of transcriptLines) buf.push(line);
  for (const line of spinnerLines) buf.push(line);
  for (let i = 0; i < CHAT_GAP_ROWS; i++) buf.push("");

  const totalVirtualLines =
    headerLines.length +
    olderHintLines.length +
    transcriptLines.length +
    spinnerLines.length +
    CHAT_GAP_ROWS;
  const maxScroll = Math.max(0, totalVirtualLines - maxContent);
  const chatScrollOffset = Math.min(
    Math.max(0, options.chatScrollOffset),
    maxScroll
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
  clearOverlayPaintedRows();
  lastInputStartRow = rows - currentStickyRows + 1;
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
  availableCommands?: CommandDefinition[];
}): void {
  if (currentInputMode === "flowing") {
    return;
  }
  writeStickyBottom(
    buildStickyBottomRows(
      options.placeholder,
      options.inputBuffer,
      options.scopeLabel,
      options.statusLabel,
      options.modelLabel,
      options.availableCommands
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
  const lastRowAboveInput = currentInputMode === "flowing"
    ? lastInputStartRow - 1
    : rows - currentStickyRows;
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
    const visible = visibleWidth(value);
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
  const maxNameLen = Math.max(...slashMatches.slice(start, start + maxShow).map((c) => c.name.length));
  const firstRow = lastRowAboveInput - maxShow + 1;
  for (let index = 0; index < maxShow; index++) {
    const command = slashMatches[start + index]!;
    const selected = start + index === slashSelected;
    const pointer = selected ? C.bold("❯ ") : "  ";
    const padded = command.name + " ".repeat(maxNameLen - command.name.length);
    const name = selected ? C.bold(padded) : C.text(padded);
    overlayRows[firstRow + index - clearStartRow] = fitToRow(
      ` ${pointer}${name}  ${C.muted(command.description)}`
    );
  }

  return overlayRows;
}

export function getInlineCommandGhost(
  inputBuffer: string,
  commands?: CommandDefinition[]
): string {
  if (!commands || !inputBuffer) return "";
  const match = inputBuffer.match(/\s(\/\S*)$/);
  if (!match) return "";
  const partial = match[1]!.toLowerCase();
  if (partial.length < 2) return "";
  for (const cmd of commands) {
    const names = [cmd.name, ...(cmd.aliases ?? [])];
    for (const name of names) {
      if (name.startsWith(partial) && name !== partial) {
        return name.slice(partial.length);
      }
    }
  }
  return "";
}

function buildStickyBottomRows(
  placeholder: string,
  inputBuffer: string,
  leftStatus: string,
  runtimeStatus: string | undefined,
  modelLabel: string,
  availableCommands?: CommandDefinition[]
): string[] {
  const { cols, rows: termRows } = getTermSize();
  const boxWidth = Math.max(24, cols - 5);
  const promptStr = "> ";
  const promptLen = promptStr.length;
  const firstLineWidth = Math.max(1, boxWidth - 2 - promptLen);
  const contLineWidth = Math.max(1, boxWidth - 2);
  const cursor = chalk.white("█");
  const fitToRow = (value: string) => {
    const visible = visibleWidth(value);
    if (visible > cols - 1) {
      return truncateAnsiToWidth(value, cols - 1);
    }
    return value;
  };
  const b = inputBorderColor;
  const padTo = (text: string, width: number) => {
    const visible = visibleWidth(text);
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
    contentRows.push(`  ${b("│")} ${inputPromptColor("❯")} ${displayText} ${b("│")}`);
  } else {
    const ghost = getInlineCommandGhost(inputBuffer, availableCommands);
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
      const colored = rawText
        .replace(/@\S+/g, (match) => C.warm(match))
        .replace(/\/\S+/g, (match) => {
          const cmd = match.toLowerCase();
          if (availableCommands?.some((c) => c.name === cmd || (c.aliases ?? []).includes(cmd))) {
            return C.warm(match);
          }
          return match;
        });
      let display: string;
      if (hasCursor && ghost) {
        const ghostCursor = chalk.bgHex("#505050").hex("#808080")(ghost[0]!);
        const ghostRest = ghost.length > 1 ? inputPlaceholderFg(ghost.slice(1)) : "";
        display = colored + ghostCursor + ghostRest;
      } else {
        display = hasCursor ? colored + cursor : colored;
      }
      const padded = padTo(display, w);
      if (isFirstVisible) {
        contentRows.push(`  ${b("│")} ${inputPromptColor("❯")} ${padded} ${b("│")}`);
      } else {
        contentRows.push(`  ${b("│")} ${padded} ${b("│")}`);
      }
    }
  }

  let left = runtimeStatus ? `${leftStatus} · ${runtimeStatus}` : leftStatus;
  let right = modelLabel;
  const rightVisible = visibleWidth(right);
  if (visibleWidth(left) + rightVisible + 1 > boxWidth) {
    const maxLeft = Math.max(0, boxWidth - rightVisible - 1);
    left =
      maxLeft > 3 ? left.slice(0, maxLeft - 3) + "..." : left.slice(0, maxLeft);
  }
  const leftStyled = statusBarGrey(left);
  const gap = Math.max(
    0,
    boxWidth - visibleWidth(leftStyled) - rightVisible
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

function clearOverlayPaintedRows(): void {
  if (lastOverlayPaintedStart < 1 || lastOverlayPaintedEnd < lastOverlayPaintedStart) {
    return;
  }
  const writes: string[] = ["\x1B[0m"];
  for (let row = lastOverlayPaintedStart; row <= lastOverlayPaintedEnd; row++) {
    writes.push(`\x1B[${row};1H\x1B[2K`);
  }
  writes.push("\x1B[0m");
  process.stdout.write(writes.join(""));
  invalidateScreenRows(lastOverlayPaintedStart, lastOverlayPaintedEnd);
  lastOverlayPaintedStart = -1;
  lastOverlayPaintedEnd = -1;
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

  const startRow = currentInputMode === "flowing"
    ? Math.max(1, lastInputStartRow - rows.length)
    : Math.max(1, totalRows - currentStickyRows - rows.length + 1);

  clearOverlayPaintedRows();

  const writes: string[] = ["\x1B[0m"];
  for (let index = 0; index < rows.length; index++) {
    writes.push(`\x1B[${startRow + index};1H\x1B[0m\x1B[2K${rows[index]!}`);
  }
  writes.push("\x1B[0m");
  process.stdout.write(writes.join(""));
  invalidateScreenRows(startRow, startRow + rows.length - 1);

  lastOverlayPaintedStart = startRow;
  lastOverlayPaintedEnd = startRow + rows.length - 1;
  lastOverlayRows = rows.slice();
  lastOverlayStartRow = startRow;
  lastOverlayScreenSize = screenSizeKey;
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
          const visible = visibleWidth(line);
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
        const visible = visibleWidth(line);
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
      renderWrappedContent(message.content, lines, maxWidth, cols);
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

function renderWrappedContent(
  content: string,
  lines: string[],
  maxWidth: number,
  cols: number
): void {
  const rawLines = content.split("\n");
  for (let index = 0; index < rawLines.length; index++) {
    const line = rawLines[index]!;
    const codeConsumed = tryRenderCodeBlock(rawLines, index, lines, maxWidth);
    if (codeConsumed > 0) {
      index += codeConsumed - 1;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      lines.push("");
      continue;
    }
    const tableConsumed = tryRenderTable(rawLines, index, lines, maxWidth, cols);
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

const LANGUAGE_LABELS: Record<string, string> = {
  js: "JavaScript",
  jsx: "JavaScript",
  javascript: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  typescript: "TypeScript",
  py: "Python",
  python: "Python",
  rb: "Ruby",
  ruby: "Ruby",
  go: "Go",
  rs: "Rust",
  rust: "Rust",
  java: "Java",
  kt: "Kotlin",
  kotlin: "Kotlin",
  swift: "Swift",
  c: "C",
  h: "C",
  cpp: "C++",
  cc: "C++",
  cxx: "C++",
  hpp: "C++",
  cs: "C#",
  csharp: "C#",
  php: "PHP",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  shell: "Shell",
  ps1: "PowerShell",
  powershell: "PowerShell",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  sass: "Sass",
  less: "Less",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  xml: "XML",
  md: "Markdown",
  markdown: "Markdown",
  tex: "TeX",
  latex: "LaTeX",
  r: "R",
  matlab: "MATLAB",
  scala: "Scala",
  lua: "Lua",
  dart: "Dart",
  elixir: "Elixir",
  ex: "Elixir",
  erlang: "Erlang",
  clj: "Clojure",
  clojure: "Clojure",
  hs: "Haskell",
  haskell: "Haskell",
  ocaml: "OCaml",
  fs: "F#",
  fsharp: "F#",
  vb: "Visual Basic",
  pl: "Perl",
  perl: "Perl",
  asm: "Assembly",
  s: "Assembly",
  nasm: "Assembly",
  riscv: "Assembly",
  diff: "Diff",
  patch: "Diff",
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  make: "Makefile",
  cmake: "CMake",
  nix: "Nix",
  vim: "Vim",
  graphql: "GraphQL",
  proto: "Protobuf",
  ini: "INI",
  env: "Env",
  txt: "Text",
  text: "Text",
  plaintext: "Text",
};

function matchFenceLine(line: string): { fence: string; lang: string } | null {
  const match = line.match(/^(\s*)(`{3,}|~{3,})([^\s`~]*)\s*$/);
  if (!match) return null;
  return { fence: match[2]!, lang: (match[3] ?? "").trim().toLowerCase() };
}

function languageLabel(lang: string): string {
  if (!lang) return "Code";
  return LANGUAGE_LABELS[lang] ?? (lang.charAt(0).toUpperCase() + lang.slice(1));
}

function highlightCodeLine(line: string, lang: string): string {
  if (!line) return "";
  const base = chalk.hex("#d4d4d4");
  const comment = chalk.hex("#6a9955");
  const keyword = chalk.hex("#c586c0");
  const type = chalk.hex("#4ec9b0");
  const string = chalk.hex("#ce9178");
  const number = chalk.hex("#b5cea8");
  const fn = chalk.hex("#dcdcaa");
  const property = chalk.hex("#9cdcfe");

  const KEYWORDS: Record<string, Set<string>> = {
    js: new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "new", "class", "extends", "import", "from", "export", "default", "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "null", "undefined", "true", "false", "this", "super", "yield", "static", "void", "delete"]),
    ts: new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "new", "class", "extends", "implements", "import", "from", "export", "default", "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "null", "undefined", "true", "false", "this", "super", "yield", "static", "void", "delete", "interface", "type", "enum", "namespace", "public", "private", "protected", "readonly", "abstract", "as", "is", "keyof", "satisfies"]),
    py: new Set(["def", "class", "return", "if", "elif", "else", "for", "while", "break", "continue", "import", "from", "as", "try", "except", "finally", "raise", "with", "pass", "lambda", "yield", "async", "await", "global", "nonlocal", "True", "False", "None", "and", "or", "not", "in", "is"]),
    go: new Set(["func", "return", "if", "else", "for", "switch", "case", "break", "continue", "import", "package", "var", "const", "type", "struct", "interface", "map", "chan", "go", "defer", "select", "range", "nil", "true", "false"]),
    rs: new Set(["fn", "let", "mut", "return", "if", "else", "for", "while", "loop", "match", "break", "continue", "use", "pub", "mod", "struct", "enum", "trait", "impl", "where", "as", "move", "async", "await", "self", "Self", "ref", "const", "static", "true", "false", "Some", "None", "Ok", "Err"]),
    rb: new Set(["def", "end", "class", "module", "return", "if", "elsif", "else", "unless", "for", "while", "until", "do", "begin", "rescue", "ensure", "raise", "require", "yield", "true", "false", "nil", "self", "and", "or", "not", "then"]),
    java: new Set(["public", "private", "protected", "class", "interface", "extends", "implements", "static", "final", "abstract", "void", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "new", "this", "super", "try", "catch", "finally", "throw", "throws", "import", "package", "true", "false", "null", "instanceof"]),
    sh: new Set(["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "return", "in", "select", "until", "true", "false", "export", "local", "readonly"]),
    sql: new Set(["select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create", "table", "drop", "alter", "add", "column", "primary", "key", "foreign", "references", "join", "inner", "left", "right", "outer", "on", "group", "by", "order", "having", "limit", "offset", "distinct", "as", "and", "or", "not", "null", "is", "in", "like", "between", "exists", "union", "all", "case", "when", "then", "else", "end"]),
    asm: new Set(["mov", "add", "sub", "mul", "div", "li", "la", "lw", "sw", "lb", "sb", "lh", "sh", "beq", "bne", "blt", "bgt", "ble", "bge", "bltu", "bgeu", "j", "jal", "jalr", "jr", "ret", "call", "push", "pop", "nop", "addi", "subi", "muli", "andi", "ori", "xori", "slli", "srli", "srai", "and", "or", "xor", "not", "neg", "slt", "slti", "sltu", "sltiu"]),
  };

  const aliases: Record<string, string> = {
    jsx: "js", typescript: "ts", javascript: "js", tsx: "ts",
    python: "py", ruby: "rb", rust: "rs", golang: "go",
    bash: "sh", zsh: "sh", shell: "sh",
    nasm: "asm", riscv: "asm", s: "asm",
  };
  const key = aliases[lang] ?? lang;
  const keywords = KEYWORDS[key];

  const isAsm = key === "asm";
  const isPy = key === "py";
  const isRb = key === "rb";
  const isSh = key === "sh";

  const tokens: Array<{ text: string; style: ((s: string) => string) | null }> = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;

    if ((ch === "/" && line[i + 1] === "/") ||
        ((isPy || isRb || isSh || isAsm) && ch === "#")) {
      tokens.push({ text: line.slice(i), style: comment });
      i = line.length;
      continue;
    }
    if (ch === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      const stop = end === -1 ? line.length : end + 2;
      tokens.push({ text: line.slice(i, stop), style: comment });
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\" && j + 1 < line.length) { j += 2; continue; }
        if (line[j] === quote) { j++; break; }
        j++;
      }
      tokens.push({ text: line.slice(i, j), style: string });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) && (i === 0 || !/[A-Za-z_]/.test(line[i - 1]!))) {
      let j = i;
      while (j < line.length && /[0-9a-fA-FxX._]/.test(line[j]!)) j++;
      tokens.push({ text: line.slice(i, j), style: number });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < line.length && /[A-Za-z0-9_$]/.test(line[j]!)) j++;
      const word = line.slice(i, j);
      let style: ((s: string) => string) | null = null;
      if (keywords?.has(word)) {
        style = keyword;
      } else if (/^[A-Z]/.test(word)) {
        style = type;
      } else if (line[j] === "(") {
        style = fn;
      } else if (line[i - 1] === ".") {
        style = property;
      }
      tokens.push({ text: word, style });
      i = j;
      continue;
    }
    let j = i;
    while (j < line.length && !/[A-Za-z0-9_$"'`\s\/#]/.test(line[j]!)) j++;
    if (j === i) j = i + 1;
    tokens.push({ text: line.slice(i, j), style: null });
    i = j;
  }

  return tokens.map((t) => (t.style ? t.style(t.text) : base(t.text))).join("");
}

function tryRenderCodeBlock(
  rawLines: string[],
  startIndex: number,
  out: string[],
  maxWidth: number
): number {
  const opener = matchFenceLine(rawLines[startIndex] ?? "");
  if (!opener) return 0;
  let end = startIndex + 1;
  while (end < rawLines.length) {
    const closer = matchFenceLine(rawLines[end] ?? "");
    if (closer && closer.fence[0] === opener.fence[0] && closer.fence.length >= opener.fence.length && !closer.lang) {
      break;
    }
    end++;
  }
  const codeLines = rawLines.slice(startIndex + 1, end);
  const consumed = end < rawLines.length ? end - startIndex + 1 : rawLines.length - startIndex;

  renderCodeBlock(codeLines, opener.lang, out, maxWidth);
  return consumed;
}

function renderCodeBlock(
  codeLines: string[],
  lang: string,
  out: string[],
  maxWidth: number
): void {
  while (codeLines.length > 0 && codeLines[0]!.trim() === "") codeLines.shift();
  while (codeLines.length > 0 && codeLines[codeLines.length - 1]!.trim() === "") codeLines.pop();

  const boxWidth = Math.max(24, maxWidth);
  const border = C.dimmer;
  const gutter = C.dim;
  const label = languageLabel(lang);
  const gutterWidth = Math.max(2, String(codeLines.length).length);
  const codeAreaWidth = Math.max(1, boxWidth - gutterWidth - 5);
  const preserveGeometry = shouldPreserveCodeGeometry(codeLines, lang);

  const wrapCodeLine = (text: string): string[] => {
    if (visibleWidth(text) <= codeAreaWidth) return [text];
    if (preserveGeometry) {
      return [truncatePlainToDisplayWidth(text, codeAreaWidth)];
    }
    return splitPlainToDisplayWidth(text, codeAreaWidth);
  };

  const rendered: Array<{ num: string; content: string; contentVisible: number }> = [];
  for (let i = 0; i < codeLines.length; i++) {
    const raw = codeLines[i]!.replace(/\t/g, "  ");
    const wrapped = wrapCodeLine(raw);
    for (let j = 0; j < wrapped.length; j++) {
      const chunk = wrapped[j]!;
      rendered.push({
        num: j === 0 ? String(i + 1) : "",
        content: highlightCodeLine(chunk, lang),
        contentVisible: visibleWidth(chunk),
      });
    }
  }

  const headerLabel = ` ${label} `;
  const headerLabelVisible = visibleWidth(headerLabel);
  const remainingTop = Math.max(0, boxWidth - 2 - headerLabelVisible);
  const top =
    border("╭") +
    border("─") +
    C.muted(headerLabel) +
    border("─".repeat(Math.max(0, remainingTop - 1))) +
    border("╮");
  const bot = border("╰" + "─".repeat(boxWidth - 2) + "╯");

  out.push("");
  out.push(`  ${top}`);

  for (const row of rendered) {
    const num = row.num.padStart(gutterWidth, " ");
    const gutterText = gutter(num);
    const contentPad = Math.max(0, codeAreaWidth - Math.min(row.contentVisible, codeAreaWidth));
    const content = row.content + " ".repeat(contentPad);
    const line = `${border("│")} ${gutterText} ${content} ${border("│")}`;
    out.push(`  ${line}`);
  }

  out.push(`  ${bot}`);
}

function shouldPreserveCodeGeometry(codeLines: string[], lang: string): boolean {
  const normalizedLang = lang.trim().toLowerCase();
  if (normalizedLang && !["text", "txt", "plaintext", "md", "markdown"].includes(normalizedLang)) {
    return false;
  }

  let structuralLines = 0;
  let nonBlankLines = 0;
  for (const line of codeLines) {
    if (!line.trim()) continue;
    nonBlankLines++;
    if (/[┌┬┐├┼┤└┴┘│─╭╮╰╯═║╔╗╚╝+\-|<>←→↑↓↔=]{3,}/.test(line)) {
      structuralLines++;
    }
  }

  return nonBlankLines > 0 && structuralLines / nonBlankLines >= 0.25;
}

function splitPlainToDisplayWidth(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [""];
  const chunks: string[] = [];
  let current = "";
  let width = 0;

  for (const char of text) {
    const charWidth = visibleWidth(char);
    if (width > 0 && width + charWidth > maxWidth) {
      chunks.push(current);
      current = "";
      width = 0;
    }
    if (charWidth > maxWidth) {
      chunks.push(truncatePlainToDisplayWidth(char, maxWidth));
      continue;
    }
    current += char;
    width += charWidth;
  }

  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

function truncatePlainToDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return truncateAnsiToWidth(text, maxWidth);
  return truncateAnsiToWidth(text, maxWidth - 3).replace(/\s+$/, "") + "...";
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

interface TableLayout {
  fullWidth: boolean;
  columnWeights: number[];
}

function colMatches(cell: string, ...keywords: string[]): boolean {
  return keywords.some((kw) => cell.includes(kw));
}

function detectTableLayout(header: string[]): TableLayout | null {
  const normalized = header.map((cell) => cell.trim().toLowerCase().replace(/[_\-]/g, " "));
  const col0 = normalized[0] ?? "";
  const col1 = normalized[1] ?? "";
  const col2 = normalized[2] ?? "";

  if (colMatches(col0, "name", "file") && colMatches(col1, "type") && colMatches(col2, "size")) {
    return { fullWidth: true, columnWeights: [0.64, 0.12, 0.24] };
  }
  if (colMatches(col0, "name", "file") && colMatches(col1, "type")) {
    return { fullWidth: true, columnWeights: [0.78, 0.22] };
  }
  if (colMatches(col0, "name", "file") && colMatches(col1, "size")) {
    return { fullWidth: true, columnWeights: [0.72, 0.28] };
  }
  if (colMatches(col0, "#", "num") && colMatches(col1, "module") && colMatches(col2, "item", "count")) {
    return { fullWidth: true, columnWeights: [0.07, 0.69, 0.24] };
  }
  if (colMatches(col0, "module") && colMatches(col1, "item", "count")) {
    return { fullWidth: true, columnWeights: [0.78, 0.22] };
  }
  return null;
}

function tryRenderTable(
  rawLines: string[],
  startIndex: number,
  out: string[],
  maxWidth: number,
  cols: number
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

  renderMarkdownTable(headerCells, bodyRows, out, maxWidth, cols);
  return cursor - startIndex;
}

function renderMarkdownTable(
  header: string[],
  rows: string[][],
  out: string[],
  maxWidth: number,
  cols: number
): void {
  const colCount = header.length;
  const layout = detectTableLayout(header);
  const tableWidth = layout?.fullWidth
    ? Math.max(32, cols - 4)
    : Math.max(20, maxWidth - 2);
  const borderOverhead = colCount + 1 + colCount * 2;
  const usableContent = Math.max(colCount, tableWidth - borderOverhead);

  const headerParsed = header.map((cell) => parseAndStripFormatting(cell));
  const rowsParsed = rows.map((row) => row.map((cell) => parseAndStripFormatting(cell)));

  let colWidths: number[];
  if (layout?.columnWeights.length === colCount) {
    colWidths = layout.columnWeights.map((weight) =>
      Math.max(3, Math.floor(usableContent * weight))
    );
    let diff = usableContent - colWidths.reduce((sum, width) => sum + width, 0);
    let index = 0;
    while (diff > 0) {
      colWidths[index % colCount]!++;
      diff--;
      index++;
    }
    while (diff < 0) {
      const shrinkIndex = colWidths.findIndex((width) => width > 3);
      if (shrinkIndex < 0) break;
      colWidths[shrinkIndex]!--;
      diff++;
    }
  } else {
    const naturalWidths = headerParsed.map((parsed, i) => {
      let widest = visibleWidth(parsed.plain);
      for (const row of rowsParsed) {
        const cellPlain = row[i]?.plain ?? "";
        for (const piece of cellPlain.split(/\s+/)) {
          widest = Math.max(widest, visibleWidth(piece));
        }
        widest = Math.max(widest, Math.min(visibleWidth(cellPlain), 24));
      }
      return Math.max(3, widest);
    });

    const totalNatural = naturalWidths.reduce((a, b) => a + b, 0) || 1;
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
  }

  const border = layout?.fullWidth ? C.secondary : C.dimmer;
  const b = border;
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
        const pad = " ".repeat(Math.max(0, colWidths[col]! - visibleWidth(plain)));
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
  let currentWidth = 0;
  for (const word of words) {
    if (!word) continue;
    const wordWidth = visibleWidth(word);
    if (wordWidth > maxWidth) {
      if (current) {
        lines.push(current);
        current = "";
        currentWidth = 0;
      }
      lines.push(word);
      continue;
    }
    if (currentWidth + wordWidth + 1 > maxWidth && currentWidth > 0) {
      lines.push(current);
      current = word;
      currentWidth = wordWidth;
    } else if (current) {
      current = `${current} ${word}`;
      currentWidth += wordWidth + 1;
    } else {
      current = word;
      currentWidth = wordWidth;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function getTranscriptBlockWidth(maxWidth: number, cols: number): number {
  return Math.max(24, Math.min(Math.max(maxWidth, cols - 8), cols - 4));
}
