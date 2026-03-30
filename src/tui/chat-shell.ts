import chalk from "chalk";
import {
  clearScreen,
  showCursor,
  hideCursor,
  enterAlternateScreen,
  leaveAlternateScreen,
  enableMouseTracking,
  disableMouseTracking,
  createBuffer,
  getTermSize,
  C,
  stripAnsi,
  truncateAnsiToWidth,
} from "./screen.js";
import type {
  ChatMessage,
  ChatSession,
  CommandDefinition,
  ScopeRuntime,
} from "./chat-state.js";
import { saveChatSession } from "./chat-sessions.js";

interface PinOption {
  name: string;
  label: string;
  localPath?: string;
}

interface ChatShellApi<TExit> {
  addMessage: (message: ChatMessage) => Promise<void>;
  addMessages: (messages: ChatMessage[]) => Promise<void>;
  resolve: (result: TExit | null) => void;
  render: () => void;
  session: ChatSession;
  runtime: ScopeRuntime;
}

interface AskCallbacks {
  onToolCall?: (event: {
    action: string;
    target: string;
    result: string;
    color: "green" | "red";
  }) => void;
  onTextDelta?: (delta: string) => void;
}

export interface ChatShellOptions<TExit> {
  session: ChatSession;
  runtime: ScopeRuntime;
  commands: CommandDefinition[];
  modelLabel: string;
  bannerRenderer?: (buf: { push(line?: string): void }) => void;
  extraHelpCommands?: Array<{ cmd: string; desc: string }>;
  pinOptions?: PinOption[];
  resolvePinContent?: (pin: PinOption) => Promise<string | null>;
  onAsk: (input: string, callbacks: AskCallbacks) => Promise<{
    content: string;
    bulletPoints?: string[];
    sources?: Array<{ title: string; kind: string }>;
    confidence?: string;
  }>;
  onCommand: (
    command: string,
    args: string,
    api: ChatShellApi<TExit>
  ) => Promise<TExit | null | void>;
}

const inputBg = chalk.bgHex("#2d3342");
const inputPlaceholderFg = chalk.hex("#8b95a8");
const toolBgGreen = chalk.bgHex("#1a2e1a");
const toolBgRed = chalk.bgHex("#2e1a1a");
const toolActionColor = chalk.hex("#e0af68").bold;
const toolTargetGreen = chalk.hex("#9ece6a");
const toolTargetRed = chalk.hex("#f7768e");
const statusBarGrey = chalk.hex("#9ca3af");
const STICKY_BOTTOM_ROWS = 4;
const CHAT_GAP_ROWS = 2;
const MAIN_VIEW_BOTTOM_RESERVE = STICKY_BOTTOM_ROWS + CHAT_GAP_ROWS;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const VERBS = [
  "Working",
  "Thinking",
  "Studying",
  "Reading",
  "Analyzing",
  "Exploring",
  "Reviewing",
];

export async function runChatShell<TExit>(
  options: ChatShellOptions<TExit>
): Promise<TExit | null> {
  const session = options.session;
  const messages = session.messages;
  const availableCommands = options.commands.filter((command) =>
    command.scopes.includes(options.runtime.scope.type)
  );

  let inputBuffer = "";
  let slashSelected = 0;
  let pinSelected = 0;
  let showSlashMenu = false;
  let isProcessing = false;
  let toolOutputExpanded = false;
  let currentSpinnerLine = "";
  let spinnerFrame = 0;
  let spinnerRow = 0;
  let chatScrollOffset = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  const placeholder =
    options.runtime.placeholder ?? "Type your message or /help for commands";

  function getSlashMatches(): CommandDefinition[] {
    if (!inputBuffer.startsWith("/")) return [];
    const partial = inputBuffer.toLowerCase();
    return availableCommands.filter((command) =>
      [command.name, ...(command.aliases ?? [])].some((alias) =>
        alias.startsWith(partial)
      )
    );
  }

  function getActivePinPartial(): string | null {
    const match = inputBuffer.match(/\/pin(\s+(\S*))?$/);
    if (!match) return null;
    return match[2] ?? "";
  }

  function getPinMatches(): PinOption[] {
    const partial = getActivePinPartial();
    if (partial === null) return [];
    if (!partial) return options.pinOptions ?? [];
    return (options.pinOptions ?? []).filter((pin) =>
      pin.label.includes(partial.toLowerCase())
    );
  }

  function render(): void {
    const buf = createBuffer();
    const { cols } = getTermSize();
    const contentWidth = Math.min(cols - 4, 100);

    buf.push("");
    buf.push("");

    if (options.bannerRenderer) {
      options.bannerRenderer(buf);
      buf.push("");
    } else {
      buf.push(`  ${C.primaryBold(options.runtime.title)}  ${statusBarGrey(options.runtime.subtitle ?? "")}`);
      buf.push("");
    }

    if (chatScrollOffset > 0) {
      buf.push(
        C.dim(
          "  ↑ Older · PgUp / PgDn · Ctrl+P up / Ctrl+N down · End latest · Home oldest"
        )
      );
    }

    for (const message of messages) {
      renderMessage(message, buf, contentWidth, toolOutputExpanded);
    }

    if (isProcessing && currentSpinnerLine) {
      buf.push("");
      spinnerRow = buf.length + 1;
      buf.push("");
      buf.push("");
    } else {
      spinnerRow = 0;
    }

    for (let gap = 0; gap < CHAT_GAP_ROWS; gap++) {
      buf.push("");
    }

    const bufferLength = buf.length;
    const { rows } = getTermSize();
    const maxContent = Math.max(1, rows - MAIN_VIEW_BOTTOM_RESERVE);
    const maxScroll = Math.max(0, bufferLength - maxContent);
    chatScrollOffset = Math.min(Math.max(0, chatScrollOffset), maxScroll);

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

    renderStickyBottom(placeholder, inputBuffer, options.runtime.scopeLabel, options.modelLabel);
    renderSlashPinOverlay(
      showSlashMenu ? getSlashMatches() : [],
      getPinMatches(),
      slashSelected,
      pinSelected,
      inputBuffer
    );
  }

  function startSpinner(): void {
    stopSpinner();
    spinnerTimer = setInterval(() => {
      if (!isProcessing || !currentSpinnerLine || spinnerRow <= 0) return;
      spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
      currentSpinnerLine = `  ${C.primary(SPINNER[spinnerFrame])} ${C.accent(currentVerb)}${chalk.white("...")}`;
      const { cols, rows } = getTermSize();
      if (spinnerRow <= rows) {
        const visible = stripAnsi(currentSpinnerLine).length;
        const padded =
          visible < cols
            ? currentSpinnerLine + " ".repeat(cols - visible)
            : currentSpinnerLine;
        process.stdout.write(`\x1B[${spinnerRow};1H${padded}`);
      }
    }, 80);
  }

  function stopSpinner(): void {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    spinnerRow = 0;
  }

  let currentVerb = "";

  function schedulePersist(delayMs: number = 180): void {
    if (persistTimer) {
      clearTimeout(persistTimer);
    }
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void flushPersist();
    }, delayMs);
  }

  async function flushPersist(): Promise<void> {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    session.updatedAt = new Date().toISOString();
    await saveChatSession(session);
  }

  async function addMessage(message: ChatMessage): Promise<void> {
    messages.push(message);
    schedulePersist();
  }

  async function addMessages(nextMessages: ChatMessage[]): Promise<void> {
    messages.push(...nextMessages);
    schedulePersist();
  }

  function renderInputOnly(): void {
    renderStickyBottom(placeholder, inputBuffer, options.runtime.scopeLabel, options.modelLabel);
  }

  async function cleanup(
    stdin: NodeJS.ReadStream,
    onData: (data: string) => void
  ): Promise<void> {
    stopSpinner();
    await flushPersist();
    stdin.removeListener("data", onData);
    stdin.setRawMode(false);
    stdin.pause();
    disableMouseTracking();
    leaveAlternateScreen();
    showCursor();
    clearScreen();
  }

  enterAlternateScreen();
  enableMouseTracking();
  clearScreen();
  hideCursor();
  render();
  showCursor();

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve) => {
    const api: ChatShellApi<TExit> = {
      addMessage,
      addMessages,
      resolve: (result) => resolve(result),
      render,
      session,
      runtime: options.runtime,
    };

    function scrollPageStep(): number {
      const { rows } = getTermSize();
      return Math.max(2, Math.floor((rows - MAIN_VIEW_BOTTOM_RESERVE) * 0.65));
    }

    function keyOkWhileProcessing(key: string): boolean {
      return [
        "\x03",
        "\x0F",
        "\x10",
        "\x0e",
        "\x1B[A",
        "\x1B[B",
        "\x1b[5~",
        "\x1B[5~",
        "\x1b[6~",
        "\x1B[6~",
        "\x1b[4~",
        "\x1B[4~",
        "\x1b[1~",
        "\x1B[1~",
      ].includes(key);
    }

    async function handlePrompt(input: string): Promise<void> {
      const pinRegex = /\/pin\s+(\S+)/g;
      const pins: PinOption[] = [];
      let pinMatch: RegExpExecArray | null;
      while ((pinMatch = pinRegex.exec(input)) !== null) {
        const label = pinMatch[1].toLowerCase();
        const match = (options.pinOptions ?? []).find(
          (pin) => pin.label === label || pin.label.includes(label)
        );
        if (match) pins.push(match);
      }

      const cleanInput = input.replace(/\/pin\s+\S+/g, "").replace(/\s+/g, " ").trim();
      let fullInput = cleanInput;

      if (pins.length > 0 && options.resolvePinContent) {
        const attached: string[] = [];
        for (const pin of pins) {
          const content = await options.resolvePinContent(pin);
          if (content) {
            attached.push(
              `--- Attached file: ${pin.name} ---\n${content}\n--- End ${pin.name} ---`
            );
          }
        }
        if (attached.length > 0) {
          fullInput = `${attached.join("\n\n")}\n\nUser question: ${cleanInput}`;
        }
      }

      await addMessage({ role: "user", content: input });
      isProcessing = true;
      currentVerb = VERBS[Math.floor(Math.random() * VERBS.length)]!;
      spinnerFrame = 0;
      currentSpinnerLine = `  ${C.primary(SPINNER[0])} ${C.accent(currentVerb)}${chalk.white("...")}`;
      render();
      startSpinner();

      let streamingStarted = false;
      let streamedText = "";
      let lastRenderTime = 0;
      const RENDER_INTERVAL = 80;

      try {
        const final = await options.onAsk(fullInput, {
          onToolCall: async (event) => {
            if (streamingStarted && streamedText.trim()) {
              messages[messages.length - 1] = {
                role: "assistant",
                content: streamedText.trim(),
              };
              schedulePersist();
              streamingStarted = false;
              streamedText = "";
            }
            stopSpinner();
            messages.push({
              role: "tool",
              content: event.result,
              toolAction: event.action,
              toolTarget: event.target,
              toolColor: event.color,
            });
            schedulePersist();
            currentSpinnerLine = `  ${C.primary(SPINNER[spinnerFrame])} ${C.accent(currentVerb)}${chalk.white("...")}`;
            render();
            startSpinner();
          },
          onTextDelta: (delta) => {
            if (!streamingStarted) {
              streamingStarted = true;
              stopSpinner();
              currentSpinnerLine = "";
              messages.push({ role: "assistant", content: "" });
            }
            streamedText += delta;
            const now = Date.now();
            if (now - lastRenderTime > RENDER_INTERVAL) {
              lastRenderTime = now;
              messages[messages.length - 1] = {
                role: "assistant",
                content: streamedText,
              };
              render();
            }
          },
        });

        stopSpinner();
        if (streamingStarted) {
          messages[messages.length - 1] = {
            role: "assistant",
            content: final.content || streamedText,
            bulletPoints: final.bulletPoints,
            sources: final.sources,
            confidence: final.confidence,
          };
        } else {
          messages.push({
            role: "assistant",
            content: final.content,
            bulletPoints: final.bulletPoints,
            sources: final.sources,
            confidence: final.confidence,
          });
        }
        await flushPersist();
      } catch (error) {
        stopSpinner();
        await addMessage({
          role: "system",
          content: `Error: ${error instanceof Error ? error.message : "unknown"}`,
        });
      }

      isProcessing = false;
      currentSpinnerLine = "";
      render();
    }

    async function handleKey(key: string): Promise<void> {
      if (isProcessing && !keyOkWhileProcessing(key)) return;

      if (key === "\x03") {
        await cleanup(stdin, onData);
        process.exit(0);
      }

      if (key === "\x0F") {
        toolOutputExpanded = !toolOutputExpanded;
        render();
        return;
      }

      if (key === "\x1b[5~" || key === "\x1B[5~" || key === "\x10") {
        chatScrollOffset += scrollPageStep();
        render();
        return;
      }
      if (key === "\x1b[6~" || key === "\x1B[6~" || key === "\x0e") {
        chatScrollOffset = Math.max(0, chatScrollOffset - scrollPageStep());
        render();
        return;
      }
      if (key === "\x1b[4~" || key === "\x1B[4~") {
        chatScrollOffset = 0;
        render();
        return;
      }
      if (key === "\x1b[1~" || key === "\x1B[1~") {
        chatScrollOffset = 999999;
        render();
        return;
      }

      if (key === "\x1B") {
        if (showSlashMenu) {
          showSlashMenu = false;
          render();
        }
        return;
      }

      if (key === "\r" || key === "\n") {
        chatScrollOffset = 0;

        const pinPartial = getActivePinPartial();
        if (pinPartial !== null) {
          const pinMatches = getPinMatches();
          const isComplete = (options.pinOptions ?? []).some(
            (pin) => pin.label === pinPartial
          );
          if (!isComplete && pinMatches.length > 0) {
            const selected = pinMatches[pinSelected]!;
            inputBuffer = inputBuffer.replace(/\/pin(\s+\S*)?$/, `/pin ${selected.label}`);
            pinSelected = 0;
            render();
            return;
          }
        }

        if (showSlashMenu && getSlashMatches().length > 0) {
          inputBuffer = getSlashMatches()[slashSelected]!.name;
          showSlashMenu = false;
        }

        const input = inputBuffer.trim();
        inputBuffer = "";
        slashSelected = 0;
        showSlashMenu = false;

        if (!input) {
          render();
          return;
        }

        if (input.startsWith("/")) {
          await addMessage({ role: "user", content: input });
          const [commandName, ...rest] = input.split(/\s+/);
          if (commandName === "/help") {
            const helpLines = availableCommands.map(
              (command) =>
                `${C.accent(command.name.padEnd(16))}${command.description}`
            );
            for (const extra of options.extraHelpCommands ?? []) {
              helpLines.push(`${C.accent(extra.cmd.padEnd(16))}${extra.desc}`);
            }
            await addMessage({
              role: "assistant",
              content: helpLines.join("\n"),
            });
            render();
            return;
          }

          const resolvedCommand = resolveCommand(options.commands, commandName);
          if (!resolvedCommand) {
            await addMessage({
              role: "system",
              content: `Unknown command: ${commandName}. Type /help for options.`,
            });
            render();
            return;
          }

          if (!resolvedCommand.scopes.includes(options.runtime.scope.type)) {
            await addMessage({
              role: "system",
              content: `${commandName} is only available in ${formatScopeTargets(
                resolvedCommand.scopes
              )}.`,
            });
            render();
            return;
          }

          const exit = await options.onCommand(commandName, rest.join(" "), api);
          if (exit !== undefined) {
            await cleanup(stdin, onData);
            resolve(exit ?? null);
            return;
          }
          render();
          return;
        }

        await handlePrompt(input);
        render();
        return;
      }

      if (key === "\x1B[A" && getActivePinPartial() !== null && getPinMatches().length > 0) {
        pinSelected = Math.max(0, pinSelected - 1);
        render();
        return;
      }
      if (key === "\x1B[B" && getActivePinPartial() !== null && getPinMatches().length > 0) {
        pinSelected = Math.min(getPinMatches().length - 1, pinSelected + 1);
        render();
        return;
      }
      if (key === "\x1B[A" && showSlashMenu) {
        slashSelected = Math.max(0, slashSelected - 1);
        render();
        return;
      }
      if (key === "\x1B[B" && showSlashMenu) {
        slashSelected = Math.min(getSlashMatches().length - 1, slashSelected + 1);
        render();
        return;
      }

      if (key === "\x1B[A") {
        chatScrollOffset += 3;
        render();
        return;
      }
      if (key === "\x1B[B") {
        chatScrollOffset = Math.max(0, chatScrollOffset - 3);
        render();
        return;
      }

      if (key === "\x7F" || key === "\b") {
        if (inputBuffer.length > 0) {
          inputBuffer = inputBuffer.slice(0, -1);
          const wasSlash = showSlashMenu;
          showSlashMenu = inputBuffer.startsWith("/");
          slashSelected = 0;
          if (wasSlash && !showSlashMenu) {
            render();
          } else if (showSlashMenu) {
            render();
          } else {
            renderInputOnly();
          }
        }
        return;
      }

      if (key === "\t" && showSlashMenu) {
        const matches = getSlashMatches();
        if (matches.length > 0) {
          inputBuffer = matches[slashSelected]!.name;
          render();
        }
        return;
      }

      if (key.length === 1 && key >= " ") {
        inputBuffer += key;
        const wasSlash = showSlashMenu;
        showSlashMenu = inputBuffer.startsWith("/");
        if (getActivePinPartial() !== null) {
          pinSelected = 0;
          render();
        } else if (showSlashMenu) {
          slashSelected = 0;
          render();
        } else if (wasSlash) {
          render();
        } else {
          renderInputOnly();
        }
      }
    }

    let stdinEscHold = "";
    function onData(data: string): void {
      let input = stdinEscHold + data;
      stdinEscHold = "";

      while (input.length > 0) {
        const escIdx = input.indexOf("\x1b");
        if (escIdx < 0) {
          for (let i = 0; i < input.length; i++) {
            void handleKey(input[i]!);
          }
          return;
        }

        for (let i = 0; i < escIdx; i++) {
          void handleKey(input[i]!);
        }
        input = input.slice(escIdx);

        if (input.length === 1) {
          stdinEscHold = input;
          return;
        }

        if (input[1] === "[") {
          const mouseMatch = input.match(/^\x1b\[<(\d+);\d+;\d+[Mm]/);
          if (mouseMatch) {
            const button = parseInt(mouseMatch[1]!, 10);
            if (button === 64) {
              chatScrollOffset += 3;
            } else if (button === 65) {
              chatScrollOffset = Math.max(0, chatScrollOffset - 3);
            }
            render();
            input = input.slice(mouseMatch[0].length);
            continue;
          }

          const match = input.match(/^\x1b\[[\d;]*[~A-Za-z]/);
          if (match) {
            void handleKey(match[0]);
            input = input.slice(match[0].length);
            continue;
          }
          stdinEscHold = input;
          return;
        }

        if (input[1] === "O" && input.length >= 3) {
          void handleKey(input.slice(0, 3));
          input = input.slice(3);
          continue;
        }

        void handleKey(input.slice(0, 2));
        input = input.slice(2);
      }
    }

    stdin.on("data", onData);
  });
}

function resolveCommand(
  commands: CommandDefinition[],
  rawName: string
): CommandDefinition | null {
  return (
    commands.find(
      (command) =>
        command.name === rawName || (command.aliases ?? []).includes(rawName)
    ) ?? null
  );
}

function formatScopeTargets(scopes: string[]): string {
  if (scopes.length === 1) {
    return scopeDisplay(scopes[0]!);
  }
  if (scopes.length === 2) {
    return `${scopeDisplay(scopes[0]!)} or ${scopeDisplay(scopes[1]!)}`;
  }
  return scopes.map(scopeDisplay).join(", ");
}

function scopeDisplay(scope: string): string {
  switch (scope) {
    case "global":
      return "global scope. Try /courses or /recent";
    case "course":
      return "a course. Open a course first";
    case "workspace":
      return "a workspace. Open an assignment first";
    default:
      return scope;
  }
}

function renderSlashPinOverlay(
  slashMatches: CommandDefinition[],
  pinMatches: PinOption[],
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
    for (let i = 0; i < maxShow; i++) {
      const pin = pinMatches[start + i]!;
      const selected = start + i === pinSelected;
      const pointer = selected ? C.primary("❯ ") : "  ";
      const label = selected ? C.primaryBold(pin.label) : C.accent(pin.label);
      process.stdout.write(
        `\x1B[${firstRow + i};1H${padToCols(`${indent}${pointer}${label}  ${C.dim(pin.name)}`)}`
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
  for (let i = 0; i < maxShow; i++) {
    const command = slashMatches[start + i]!;
    const selected = start + i === slashSelected;
    const pointer = selected ? C.primary("❯ ") : "  ";
    const name = selected ? C.primaryBold(command.name) : C.accent(command.name);
    process.stdout.write(
      `\x1B[${firstRow + i};1H${padToCols(` ${pointer}${name}  ${C.dim(command.description)}`)}`
    );
  }
}

function renderStickyBottom(
  placeholder: string,
  inputBuffer: string,
  leftStatus: string,
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

  let left = leftStatus;
  let right = modelLabel;
  if (left.length + right.length + 1 > cols) {
    const maxLeft = Math.max(0, cols - right.length - 1);
    left = maxLeft > 3 ? left.slice(0, maxLeft - 3) + "..." : left.slice(0, maxLeft);
  }
  const gap = Math.max(0, cols - left.length - right.length);
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
  msg: ChatMessage,
  buf: Buf,
  maxWidth: number,
  expanded: boolean
): void {
  buf.push("");

  switch (msg.role) {
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
      const lines = wrapLines(msg.content, boxWidth);
      buf.push(padRow(inputBg(emptyLine)));
      for (const line of lines) {
        buf.push(padRow(inputBg(` ${padInner(line)}`)));
      }
      buf.push(padRow(inputBg(emptyLine)));
      break;
    }
    case "assistant": {
      renderWrappedContent(msg.content, buf, maxWidth);
      if (msg.bulletPoints?.length) {
        buf.push("");
        for (const point of msg.bulletPoints) {
          buf.push(`  ${C.dim("•")} ${chalk.white(point)}`);
        }
      }
      if (msg.sources?.length) {
        buf.push("");
        for (const source of msg.sources) {
          buf.push(`  ${C.dimmer(`[${source.kind}]`)} ${C.dim(source.title)}`);
        }
      }
      break;
    }
    case "system":
      wrapLines(msg.content, maxWidth).forEach((line) => {
        buf.push(`  ${chalk.white(line)}`);
      });
      break;
    case "tool": {
      const bg = msg.toolColor === "red" ? toolBgRed : toolBgGreen;
      const targetColor = msg.toolColor === "red" ? toolTargetRed : toolTargetGreen;
      const boxWidth = Math.max(maxWidth, 40);
      const empty = " ".repeat(boxWidth);
      buf.push("  " + bg(empty));
      const headerText = `${msg.toolAction ?? "tool"} ${msg.toolTarget ?? ""}`;
      const headerPad = " ".repeat(Math.max(0, boxWidth - headerText.length - 1));
      buf.push(
        "  " +
          bg(
            ` ${toolActionColor(msg.toolAction ?? "tool")} ${targetColor(
              msg.toolTarget ?? ""
            )}${headerPad}`
          )
      );
      const contentLines = msg.content.split("\n");
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
        const totalLength = moreText.length + "ctrl+o".length + " to expand)".length;
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
        buf.push(index === 0 ? `  ${C.dim("•")} ${applyInlineFormatting(wrapped)}` : `    ${applyInlineFormatting(wrapped)}`);
      });
      continue;
    }
    const numbered = trimmed.match(/^(\d+)\.\s+(.+)/);
    if (numbered) {
      wrapLines(stripAnsi(numbered[2]!), maxWidth - 6).forEach((wrapped, index) => {
        buf.push(index === 0 ? `  ${C.primaryBold(numbered[1]! + ".")} ${applyInlineFormatting(wrapped)}` : `      ${applyInlineFormatting(wrapped)}`);
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
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_match, inner) => chalk.white.italic(inner));
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
