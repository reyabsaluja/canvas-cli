import chalk from "chalk";
import { C, getTermSize } from "./screen.js";
import type {
  ChatMessage,
  CommandDefinition,
  ChatSession,
  ScopeRuntime,
} from "./chat-state.js";
import {
  formatScopeTargets,
  getAvailableCommands,
  resolveCommand,
} from "./commands.js";
import type { ShellPinOption, ShellRuntimeApi } from "./app-types.js";
import {
  MAIN_VIEW_BOTTOM_RESERVE,
  buildBannerLines,
  buildTranscriptLines,
  renderChatFrame,
  renderInputFooter,
} from "./chat-shell-render.js";
import { ChatShellPersistence } from "./chat-shell-persistence.js";
import { enterChatShell, leaveChatShell } from "./chat-shell-terminal.js";
import { createSerialTaskQueue } from "./serial-task-queue.js";

interface ChatShellApi<TExit> extends ShellRuntimeApi {
  addMessage: (message: ChatMessage) => Promise<void>;
  addMessages: (messages: ChatMessage[]) => Promise<void>;
  resolve: (result: TExit | null) => void;
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
  pinOptions?: ShellPinOption[];
  resolvePinContent?: (pin: ShellPinOption) => Promise<string | null>;
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
  onReady?: (api: ShellRuntimeApi) => Promise<void> | void;
}

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
  const persistence = new ChatShellPersistence(session, messages);
  const availableCommands = getAvailableCommands(
    options.commands,
    options.runtime.scope.type
  );

  let inputBuffer = "";
  let slashSelected = 0;
  let pinSelected = 0;
  let showSlashMenu = false;
  let isProcessing = false;
  let toolOutputExpanded = false;
  let currentSpinnerLine = "";
  let spinnerFrame = 0;
  let chatScrollOffset = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let currentVerb = "";
  let transcriptLinesCache: string[] | null = null;
  let transcriptCacheKey = "";
  let bannerLinesCache: string[] | null = null;
  let bannerCacheCols = -1;

  const placeholder =
    options.runtime.placeholder ?? "Type your message or /help for commands";

  function markTranscriptDirty(): void {
    transcriptLinesCache = null;
  }

  function getCachedBannerLines(): string[] {
    const { cols } = getTermSize();
    if (bannerLinesCache && bannerCacheCols === cols) {
      return bannerLinesCache;
    }
    bannerLinesCache = buildBannerLines({
      runtime: options.runtime,
      bannerRenderer: options.bannerRenderer,
    });
    bannerCacheCols = cols;
    return bannerLinesCache;
  }

  function getCachedTranscriptLines(): string[] {
    const { cols } = getTermSize();
    const contentWidth = Math.min(cols - 4, 100);
    const cacheKey = `${cols}:${contentWidth}:${toolOutputExpanded ? 1 : 0}`;
    if (transcriptLinesCache && transcriptCacheKey === cacheKey) {
      return transcriptLinesCache;
    }
    transcriptLinesCache = buildTranscriptLines({
      messages,
      contentWidth,
      cols,
      expanded: toolOutputExpanded,
    });
    transcriptCacheKey = cacheKey;
    return transcriptLinesCache;
  }

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

  function getPinMatches(): ShellPinOption[] {
    const partial = getActivePinPartial();
    if (partial === null) return [];
    if (!partial) return options.pinOptions ?? [];
    return (options.pinOptions ?? []).filter((pin) =>
      pin.label.includes(partial.toLowerCase())
    );
  }

  function render(): void {
    const next = renderChatFrame({
      runtime: options.runtime,
      placeholder,
      inputBuffer,
      chatScrollOffset,
      isProcessing,
      currentSpinnerLine,
      toolOutputExpanded,
      modelLabel: options.modelLabel,
      bannerLines: getCachedBannerLines(),
      transcriptLines: getCachedTranscriptLines(),
      slashMatches: showSlashMenu ? getSlashMatches() : [],
      pinMatches: getPinMatches(),
      slashSelected,
      pinSelected,
    });
    chatScrollOffset = next.chatScrollOffset;
  }

  function renderInputOnly(): void {
    renderInputFooter({
      placeholder,
      inputBuffer,
      scopeLabel: options.runtime.scopeLabel,
      statusLabel: options.runtime.statusLabel,
      modelLabel: options.modelLabel,
      slashMatches: showSlashMenu ? getSlashMatches() : [],
      pinMatches: getPinMatches(),
      slashSelected,
      pinSelected,
    });
  }

  function startSpinner(): void {
    stopSpinner();
    spinnerTimer = setInterval(() => {
      if (!isProcessing || !currentSpinnerLine) return;
      spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
      currentSpinnerLine = `  ${C.primary(SPINNER[spinnerFrame])} ${C.accent(
        currentVerb
      )}${chalk.white("...")}`;
      render();
    }, 80);
  }

  function stopSpinner(): void {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  }

  async function cleanup(
    stdin: NodeJS.ReadStream,
    onData: (data: string) => void
  ): Promise<string | null> {
    return leaveChatShell(
      stdin,
      onData,
      () => persistence.flush(),
      stopSpinner,
      () => persistence.getFailureMessage()
    );
  }

  const stdin = enterChatShell(render);

  return new Promise((resolve) => {
    const keyQueue = createSerialTaskQueue();
    let shellClosed = false;
    let closingPromise: Promise<string | null> | null = null;

    const api: ChatShellApi<TExit> = {
      addMessage: async (message) => {
        markTranscriptDirty();
        await persistence.addMessage(message);
      },
      addMessages: async (nextMessages) => {
        markTranscriptDirty();
        await persistence.addMessages(nextMessages);
      },
      resolve: (result) => resolve(result),
      render,
      session,
      runtime: options.runtime,
    };

    async function closeShellOnce(): Promise<string | null> {
      if (closingPromise) {
        return closingPromise;
      }
      shellClosed = true;
      keyQueue.close();
      closingPromise = cleanup(stdin, onData);
      return closingPromise;
    }

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
      const pins: ShellPinOption[] = [];
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
              `--- Begin pinned file: ${pin.name} ---\n${content}\n--- End ${pin.name} ---`
            );
          }
        }
        if (attached.length > 0) {
          fullInput = `${attached.join("\n\n")}\n\nUser question: ${cleanInput}`;
        }
      }

      markTranscriptDirty();
      await persistence.addMessage({ role: "user", content: input });
      isProcessing = true;
      currentVerb = VERBS[Math.floor(Math.random() * VERBS.length)]!;
      spinnerFrame = 0;
      currentSpinnerLine = `  ${C.primary(SPINNER[0])} ${C.accent(
        currentVerb
      )}${chalk.white("...")}`;
      render();
      startSpinner();

      let streamingStarted = false;
      let streamedText = "";
      let lastRenderTime = 0;
      const renderInterval = 80;

      try {
        const final = await options.onAsk(fullInput, {
          onToolCall: async (event) => {
            if (streamingStarted && streamedText.trim()) {
              messages[messages.length - 1] = {
                role: "assistant",
                content: streamedText.trim(),
              };
              markTranscriptDirty();
              persistence.schedule();
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
            markTranscriptDirty();
            persistence.schedule();
            currentSpinnerLine = `  ${C.primary(
              SPINNER[spinnerFrame]
            )} ${C.accent(currentVerb)}${chalk.white("...")}`;
            render();
            startSpinner();
          },
          onTextDelta: (delta) => {
            if (!streamingStarted) {
              streamingStarted = true;
              stopSpinner();
              currentSpinnerLine = "";
              messages.push({ role: "assistant", content: "" });
              markTranscriptDirty();
            }
            streamedText += delta;
            const now = Date.now();
            if (now - lastRenderTime > renderInterval) {
              lastRenderTime = now;
              messages[messages.length - 1] = {
                role: "assistant",
                content: streamedText,
              };
              markTranscriptDirty();
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
          markTranscriptDirty();
        } else {
          messages.push({
            role: "assistant",
            content: final.content,
            bulletPoints: final.bulletPoints,
            sources: final.sources,
            confidence: final.confidence,
          });
          markTranscriptDirty();
        }
        await persistence.flush();
      } catch (error) {
        stopSpinner();
        markTranscriptDirty();
        await persistence.addMessage({
          role: "system",
          content: `Error: ${error instanceof Error ? error.message : "unknown"}`,
        });
      }

      isProcessing = false;
      currentSpinnerLine = "";
      render();
    }

    async function handleKey(key: string): Promise<void> {
      if (shellClosed) return;
      if (isProcessing && !keyOkWhileProcessing(key)) return;

      if (key === "\x03") {
        const persistError = await closeShellOnce();
        if (persistError) {
          console.error(`Failed to save chat session: ${persistError}`);
        }
        process.exit(130);
      }

      if (key === "\x0F") {
        toolOutputExpanded = !toolOutputExpanded;
        markTranscriptDirty();
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
            inputBuffer = inputBuffer.replace(
              /\/pin(\s+\S*)?$/,
              `/pin ${selected.label}`
            );
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
          markTranscriptDirty();
          await persistence.addMessage({ role: "user", content: input });
          const [commandName, ...rest] = input.split(/\s+/);
          if (commandName === "/help") {
            const helpLines = availableCommands.map(
              (command) =>
                `${C.accent(command.name.padEnd(16))}${command.description}`
            );
            for (const extra of options.extraHelpCommands ?? []) {
              helpLines.push(`${C.accent(extra.cmd.padEnd(16))}${extra.desc}`);
            }
            markTranscriptDirty();
            await persistence.addMessage({
              role: "assistant",
              content: helpLines.join("\n"),
            });
            render();
            return;
          }

          const resolvedCommand = resolveCommand(options.commands, commandName);
          if (!resolvedCommand) {
            markTranscriptDirty();
            await persistence.addMessage({
              role: "system",
              content: `Unknown command: ${commandName}. Type /help for options.`,
            });
            render();
            return;
          }

          if (!resolvedCommand.scopes.includes(options.runtime.scope.type)) {
            markTranscriptDirty();
            await persistence.addMessage({
              role: "system",
              content: `${commandName} is only available in ${formatScopeTargets(
                resolvedCommand.scopes
              )}.`,
            });
            render();
            return;
          }

          try {
            const exit = await options.onCommand(commandName, rest.join(" "), api);
            if (exit !== undefined) {
              const persistError = await closeShellOnce();
              if (persistError) {
                console.error(`Failed to save chat session: ${persistError}`);
              }
              resolve(exit ?? null);
              return;
            }
            render();
            return;
          } catch (error) {
            markTranscriptDirty();
            await persistence.addMessage({
              role: "system",
              content: `Error: ${error instanceof Error ? error.message : "unknown"}`,
            });
            render();
            return;
          }
        }

        await handlePrompt(input);
        render();
        return;
      }

      if (
        key === "\x1B[A" &&
        getActivePinPartial() !== null &&
        getPinMatches().length > 0
      ) {
        pinSelected = Math.max(0, pinSelected - 1);
        render();
        return;
      }
      if (
        key === "\x1B[B" &&
        getActivePinPartial() !== null &&
        getPinMatches().length > 0
      ) {
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
          } else if (showSlashMenu || getActivePinPartial() !== null) {
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
      if (shellClosed) return;
      let input = stdinEscHold + data;
      stdinEscHold = "";

      while (input.length > 0) {
        const escIdx = input.indexOf("\x1b");
        if (escIdx < 0) {
          for (let index = 0; index < input.length; index++) {
            const key = input[index]!;
            keyQueue.enqueue(() => handleKey(key));
          }
          return;
        }

        for (let index = 0; index < escIdx; index++) {
          const key = input[index]!;
          keyQueue.enqueue(() => handleKey(key));
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
            keyQueue.enqueue(async () => {
              if (shellClosed) return;
              if (button === 64) {
                chatScrollOffset += 3;
              } else if (button === 65) {
                chatScrollOffset = Math.max(0, chatScrollOffset - 3);
              }
              render();
            });
            input = input.slice(mouseMatch[0].length);
            continue;
          }

          const match = input.match(/^\x1b\[[\d;]*[~A-Za-z]/);
          if (match) {
            const key = match[0];
            keyQueue.enqueue(() => handleKey(key));
            input = input.slice(match[0].length);
            continue;
          }
          stdinEscHold = input;
          return;
        }

        if (input[1] === "O" && input.length >= 3) {
          const key = input.slice(0, 3);
          keyQueue.enqueue(() => handleKey(key));
          input = input.slice(3);
          continue;
        }

        const key = input.slice(0, 2);
        keyQueue.enqueue(() => handleKey(key));
        input = input.slice(2);
      }
    }

    stdin.on("data", onData);

    if (options.onReady) {
      queueMicrotask(() => {
        if (shellClosed) return;
        void Promise.resolve(options.onReady!(api))
          .then(() => {
            if (!shellClosed) {
              render();
            }
          })
          .catch(async (error: unknown) => {
            if (shellClosed) return;
            markTranscriptDirty();
            await persistence.addMessage({
              role: "system",
              content: `Error: ${error instanceof Error ? error.message : "unknown"}`,
            });
            if (!shellClosed) {
              render();
            }
          });
      });
    }
  });
}
