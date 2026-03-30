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
import type { ShellPinOption } from "./app-types.js";

const inputBg = chalk.bgHex("#2d3342");
const inputPlaceholderFg = chalk.hex("#8b95a8");
const toolBgGreen = chalk.bgHex("#1a2e1a");
const toolBgRed = chalk.bgHex("#2e1a1a");
const toolActionColor = chalk.hex("#e0af68").bold;
const toolTargetGreen = chalk.hex("#9ece6a");
const toolTargetRed = chalk.hex("#f7768e");
const statusBarGrey = chalk.hex("#9ca3af");

export const STICKY_BOTTOM_ROWS = 4;
const CHAT_GAP_ROWS = 2;
export const MAIN_VIEW_BOTTOM_RESERVE = STICKY_BOTTOM_ROWS + CHAT_GAP_ROWS;

export interface RenderChatFrameOptions {
  messages: ChatMessage[];
  runtime: ScopeRuntime;
  placeholder: string;
  inputBuffer: string;
  chatScrollOffset: number;
  isProcessing: boolean;
  currentSpinnerLine: string;
  toolOutputExpanded: boolean;
  modelLabel: string;
  bannerRenderer?: (buf: { push(line?: string): void }) => void;
  slashMatches: CommandDefinition[];
  pinMatches: ShellPinOption[];
  slashSelected: number;
  pinSelected: number;
}

export function renderChatFrame(
  options: RenderChatFrameOptions
): { chatScrollOffset: number; spinnerRow: number } {
  const buf = createBuffer();
  const { cols } = getTermSize();
  const contentWidth = Math.min(cols - 4, 100);

  buf.push("");
  buf.push("");

  if (options.bannerRenderer) {
    options.bannerRenderer(buf);
    buf.push("");
  } else {
    const subtitle = options.runtime.subtitle
      ? `  ${statusBarGrey(options.runtime.subtitle)}`
      : "";
    const status = options.runtime.statusLabel
      ? `  ${C.warn(options.runtime.statusLabel)}`
      : "";
    buf.push(`  ${C.primaryBold(options.runtime.title)}${subtitle}${status}`);
    buf.push("");
  }

  if (options.chatScrollOffset > 0) {
    buf.push(
      C.dim(
        "  ↑ Older · PgUp / PgDn · Ctrl+P up / Ctrl+N down · End latest · Home oldest"
      )
    );
  }

  for (const message of options.messages) {
    renderMessage(message, buf, contentWidth, options.toolOutputExpanded);
  }

  let spinnerRow = 0;
  if (options.isProcessing && options.currentSpinnerLine) {
    buf.push("");
    spinnerRow = buf.length + 1;
    buf.push("");
    buf.push("");
  }

  for (let gap = 0; gap < CHAT_GAP_ROWS; gap++) {
    buf.push("");
  }

  const bufferLength = buf.length;
  const { rows } = getTermSize();
  const maxContent = Math.max(1, rows - MAIN_VIEW_BOTTOM_RESERVE);
  const maxScroll = Math.max(0, bufferLength - maxContent);
  const chatScrollOffset = Math.min(Math.max(0, options.chatScrollOffset), maxScroll);

  const end = bufferLength - chatScrollOffset;
  const start = Math.max(0, end - maxContent);
  buf.flush(MAIN_VIEW_BOTTOM_RESERVE, chatScrollOffset);

  if (spinnerRow > 0) {
    const spinnerIndex = spinnerRow - 1;
    if (spinnerIndex < start || spinnerIndex >= end) {
      spinnerRow = 0;
    } else {
      spinnerRow = spinnerRow - start;
    }
  }

  renderStickyBottom(
    options.placeholder,
    options.inputBuffer,
    options.runtime.scopeLabel,
    options.runtime.statusLabel,
    options.modelLabel
  );
  renderSlashPinOverlay(
    options.slashMatches,
    options.pinMatches,
    options.slashSelected,
    options.pinSelected,
    options.inputBuffer
  );

  return { chatScrollOffset, spinnerRow };
}

export function renderInputFooter(options: {
  placeholder: string;
  inputBuffer: string;
  scopeLabel: string;
  statusLabel?: string;
  modelLabel: string;
  slashMatches: CommandDefinition[];
  pinMatches: ShellPinOption[];
  slashSelected: number;
  pinSelected: number;
}): void {
  renderStickyBottom(
    options.placeholder,
    options.inputBuffer,
    options.scopeLabel,
    options.statusLabel,
    options.modelLabel
  );
  renderSlashPinOverlay(
    options.slashMatches,
    options.pinMatches,
    options.slashSelected,
    options.pinSelected,
    options.inputBuffer
  );
}

function renderSlashPinOverlay(
  slashMatches: CommandDefinition[],
  pinMatches: ShellPinOption[],
  slashSelected: number,
  pinSelected: number,
  inputBuffer: string
): void {
  const { cols, rows } = getTermSize();
  const lastRowAboveInput = rows - STICKY_BOTTOM_ROWS;
  if (lastRowAboveInput < 1) return;

  const padToCols = (value: string): string => {
    const visible = stripAnsi(value).length;
    if (visible > cols) return truncateAnsiToWidth(value, cols);
    return value + " ".repeat(cols - visible);
  };

  if (pinMatches.length > 0) {
    const maxShow = Math.min(pinMatches.length, lastRowAboveInput, 8);
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
      const pointer = selected ? C.primary("❯ ") : "  ";
      const label = selected ? C.primaryBold(pin.label) : C.accent(pin.label);
      process.stdout.write(
        `\x1B[${firstRow + index};1H${padToCols(
          `${indent}${pointer}${label}  ${C.dim(pin.name)}`
        )}`
      );
    }
    return;
  }

  if (slashMatches.length === 0) return;
  const maxShow = Math.min(slashMatches.length, lastRowAboveInput);
  const start = Math.max(
    0,
    Math.min(slashSelected - Math.floor(maxShow / 2), slashMatches.length - maxShow)
  );
  const firstRow = lastRowAboveInput - maxShow + 1;
  for (let index = 0; index < maxShow; index++) {
    const command = slashMatches[start + index]!;
    const selected = start + index === slashSelected;
    const pointer = selected ? C.primary("❯ ") : "  ";
    const name = selected ? C.primaryBold(command.name) : C.accent(command.name);
    process.stdout.write(
      `\x1B[${firstRow + index};1H${padToCols(
        ` ${pointer}${name}  ${C.dim(command.description)}`
      )}`
    );
  }
}

function renderStickyBottom(
  placeholder: string,
  inputBuffer: string,
  leftStatus: string,
  runtimeStatus: string | undefined,
  modelLabel: string
): void {
  const { cols, rows } = getTermSize();
  const boxWidth = Math.max(1, cols - 1);
  const cursor = chalk.white("█");
  const emptyLine = " ".repeat(boxWidth + 1);
  const pad = (value: string) => {
    const visible = stripAnsi(value).length;
    return visible < cols ? value + " ".repeat(cols - visible) : value;
  };

  let displayText: string;
  if (!inputBuffer) {
    const maxPlaceholder = Math.max(0, boxWidth - 1);
    const trimmed =
      placeholder.length > maxPlaceholder && maxPlaceholder > 3
        ? placeholder.slice(0, maxPlaceholder - 3) + "..."
        : placeholder.slice(0, maxPlaceholder);
    const styled = inputPlaceholderFg(trimmed);
    const remaining = Math.max(0, boxWidth - 1 - stripAnsi(styled).length);
    displayText = cursor + styled + " ".repeat(remaining);
  } else {
    const colored = inputBuffer.replace(/\/pin\s+\S+/g, (match) => C.accent(match));
    const visible = stripAnsi(colored).length;
    const remaining = Math.max(0, boxWidth - visible - 1);
    displayText = colored + cursor + " ".repeat(remaining);
  }

  let left = runtimeStatus ? `${leftStatus} · ${runtimeStatus}` : leftStatus;
  let right = modelLabel;
  const leftVisible = stripAnsi(left).length;
  const rightVisible = stripAnsi(right).length;
  if (leftVisible + rightVisible + 1 > cols) {
    const maxLeft = Math.max(0, cols - rightVisible - 1);
    left = maxLeft > 3 ? left.slice(0, maxLeft - 3) + "..." : left.slice(0, maxLeft);
  }
  const gap = Math.max(0, cols - stripAnsi(left).length - rightVisible);
  const statusLine = statusBarGrey(left) + " ".repeat(gap) + statusBarGrey(right);
  const startRow = rows - 3;

  process.stdout.write(
    `\x1B[${startRow};1H` +
      pad(inputBg(emptyLine)) +
      "\n" +
      pad(inputBg(` ${displayText}`)) +
      "\n" +
      pad(inputBg(emptyLine)) +
      "\n" +
      pad(statusLine)
  );
}

type Buf = { push(line: string): void };

function renderMessage(
  message: ChatMessage,
  buf: Buf,
  maxWidth: number,
  expanded: boolean
): void {
  buf.push("");

  switch (message.role) {
    case "user": {
      const { cols } = getTermSize();
      const boxWidth = Math.max(1, cols - 1);
      const emptyLine = " ".repeat(boxWidth + 1);
      const padRow = (line: string) => {
        const visible = stripAnsi(line).length;
        return visible < cols ? line + " ".repeat(cols - visible) : line;
      };
      const padInner = (line: string) => {
        const visible = stripAnsi(line).length;
        return line + " ".repeat(Math.max(0, boxWidth - visible));
      };
      const lines = wrapLines(message.content, boxWidth);
      buf.push(padRow(inputBg(emptyLine)));
      for (const line of lines) {
        buf.push(padRow(inputBg(` ${padInner(line)}`)));
      }
      buf.push(padRow(inputBg(emptyLine)));
      break;
    }
    case "assistant": {
      renderWrappedContent(message.content, buf, maxWidth);
      if (message.bulletPoints?.length) {
        buf.push("");
        for (const point of message.bulletPoints) {
          buf.push(`  ${C.dim("•")} ${chalk.white(point)}`);
        }
      }
      if (message.sources?.length) {
        buf.push("");
        for (const source of message.sources) {
          buf.push(`  ${C.dimmer(`[${source.kind}]`)} ${C.dim(source.title)}`);
        }
      }
      break;
    }
    case "system":
      wrapLines(message.content, maxWidth).forEach((line) => {
        buf.push(`  ${chalk.white(line)}`);
      });
      break;
    case "tool": {
      const bg = message.toolColor === "red" ? toolBgRed : toolBgGreen;
      const targetColor =
        message.toolColor === "red" ? toolTargetRed : toolTargetGreen;
      const boxWidth = Math.max(maxWidth, 40);
      const empty = " ".repeat(boxWidth);
      buf.push("  " + bg(empty));
      const headerText = `${message.toolAction ?? "tool"} ${message.toolTarget ?? ""}`;
      const headerPad = " ".repeat(Math.max(0, boxWidth - headerText.length - 1));
      buf.push(
        "  " +
          bg(
            ` ${toolActionColor(message.toolAction ?? "tool")} ${targetColor(
              message.toolTarget ?? ""
            )}${headerPad}`
          )
      );
      const contentLines = message.content.split("\n");
      const showLines = expanded ? contentLines : contentLines.slice(0, 8);
      const remaining = expanded ? 0 : Math.max(0, contentLines.length - 8);
      buf.push("  " + bg(empty));
      for (const line of showLines) {
        const trimmed = line.slice(0, boxWidth - 4);
        const padLen = Math.max(0, boxWidth - trimmed.length - 3);
        buf.push("  " + bg(`  ${chalk.white(trimmed)}${" ".repeat(padLen)} `));
      }
      if (remaining > 0) {
        const moreText = `... (${remaining} more lines, `;
        const totalLength =
          moreText.length + "ctrl+o".length + " to expand)".length;
        const padLen = Math.max(0, boxWidth - totalLength - 3);
        buf.push(
          "  " +
            bg(
              `  ${C.dim(moreText)}${C.dimmer("ctrl+o")}${C.dim(
                " to expand)"
              )}${" ".repeat(padLen)} `
            )
        );
      }
      buf.push("  " + bg(empty));
      break;
    }
  }
}

function renderWrappedContent(content: string, buf: Buf, maxWidth: number): void {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      buf.push("");
      continue;
    }
    if (/^[-*_]{3,}$/.test(trimmed) || trimmed === "***") {
      buf.push(`  ${C.dimmer("─".repeat(Math.min(maxWidth - 4, 40)))}`);
      continue;
    }
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      buf.push("");
      buf.push(`  ${C.primaryBold(applyInlineFormatting(headingMatch[2]!))}`);
      continue;
    }
    const bulletMatch = trimmed.match(/^[*\-•]\s+(.+)/);
    if (bulletMatch) {
      const text = applyInlineFormatting(bulletMatch[1]!);
      wrapLines(stripAnsi(text), maxWidth - 6).forEach((wrapped, index) => {
        buf.push(
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
        buf.push(
          index === 0
            ? `  ${C.primaryBold(numbered[1]! + ".")} ${applyInlineFormatting(
                wrapped
              )}`
            : `      ${applyInlineFormatting(wrapped)}`
        );
      });
      continue;
    }
    wrapLines(stripAnsi(trimmed), maxWidth - 2).forEach((wrapped) => {
      buf.push(`  ${applyInlineFormatting(wrapped)}`);
    });
  }
}

function applyInlineFormatting(text: string): string {
  let result = text;
  result = result.replace(/\*\*(.+?)\*\*/g, (_match, inner) => chalk.white.bold(inner));
  result = result.replace(/__(.+?)__/g, (_match, inner) => chalk.white.bold(inner));
  result = result.replace(/`([^`]+)`/g, (_match, inner) => C.accent(inner));
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
