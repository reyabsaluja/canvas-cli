import chalk from "chalk";
import type { AssignmentWorkup } from "../work/types.js";
import type { LoadedWorkspace, WorkspaceAnswer } from "../ask/types.js";
import type { AIProviderConfig } from "../ai/provider.js";
import { askWorkspaceQuestion } from "./services.js";
import { clearScreen, showCursor, hideCursor, createBuffer, divider, wrapText, fmtConfidence, C } from "./screen.js";

export interface WorkspaceContext {
  workspacePath: string;
  workup: AssignmentWorkup | null;
  loaded: LoadedWorkspace;
  aiConfig: AIProviderConfig | null;
}

// --- Chat message types ---

interface ChatMessage {
  role: "user" | "assistant" | "system" | "action";
  content: string;
  actions?: string[];
  sources?: Array<{ title: string; kind: string }>;
  confidence?: string;
  bulletPoints?: string[];
}

// --- Slash commands ---

const SLASH_COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: "/overview", desc: "Show assignment overview" },
  { cmd: "/requirements", desc: "Show deliverables and constraints" },
  { cmd: "/plan", desc: "Show the action plan" },
  { cmd: "/resources", desc: "Show key resources" },
  { cmd: "/evidence", desc: "Show confirmed vs inferred sources" },
  { cmd: "/status", desc: "Show workspace status" },
  { cmd: "/help", desc: "Show available commands" },
  { cmd: "/back", desc: "Return to assignment selection" },
  { cmd: "/courses", desc: "Return to course selection" },
  { cmd: "/quit", desc: "Exit canvas-cli" },
];

/**
 * Run the workspace chatbot UI.
 * Full raw-mode control for slash command popup and chat rendering.
 */
export async function runWorkspaceUI(
  ctx: WorkspaceContext
): Promise<"back" | "courses" | "quit"> {
  const messages: ChatMessage[] = [];

  // Initial system message with overview
  if (ctx.workup?.overview) {
    messages.push({
      role: "system",
      content: ctx.workup.overview,
    });
  }

  let inputBuffer = "";
  let slashSelected = 0;
  let showSlashMenu = false;
  let isProcessing = false;

  function getSlashMatches(): typeof SLASH_COMMANDS {
    if (!inputBuffer.startsWith("/")) return [];
    const partial = inputBuffer.toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(partial));
  }

  function render(): void {
    const buf = createBuffer();

    // Header
    renderHeader(ctx, buf);

    // Chat messages
    for (const msg of messages) {
      renderMessage(msg, buf);
    }

    // Processing indicator
    if (isProcessing) {
      buf.push("");
      buf.push(`  ${C.primary("∷")} ${C.dim("Working...")}`);
    }

    // Slash command popup
    const matches = showSlashMenu ? getSlashMatches() : [];
    if (matches.length > 0 && !isProcessing) {
      buf.push("");
      buf.push(C.dimmer("  ─── commands ───"));
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        const sel = i === slashSelected;
        const ptr = sel ? C.primary("❯ ") : "  ";
        const cmd = sel ? C.primaryBold(m.cmd) : C.accent(m.cmd);
        buf.push(`  ${ptr}${cmd}  ${C.dim(m.desc)}`);
      }
    }

    // Input area
    buf.push("");
    buf.push(C.dimmer("  ─" + "─".repeat(38)));
    const inputLine = isProcessing
      ? C.dim("  > ") + C.dim(inputBuffer)
      : C.dim("  > ") + C.text(inputBuffer);
    buf.push(inputLine);

    buf.flush();
  }

  render();
  showCursor();

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve) => {
    async function handleKey(key: string): Promise<void> {
      if (isProcessing) return; // ignore input while working

      // Ctrl+C
      if (key === "\x03") {
        cleanup();
        process.exit(0);
      }

      // Escape — close slash menu or do nothing
      if (key === "\x1B") {
        if (showSlashMenu) {
          showSlashMenu = false;
          render();
        }
        return;
      }

      // Enter
      if (key === "\r" || key === "\n") {
        if (showSlashMenu && getSlashMatches().length > 0) {
          // Select from slash menu
          const matches = getSlashMatches();
          inputBuffer = matches[slashSelected].cmd;
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

        // Handle slash commands
        if (input.startsWith("/")) {
          const cmd = input.toLowerCase().split(/\s/)[0];
          const navResult = handleSlashCommand(cmd, ctx, messages);
          if (navResult) {
            cleanup();
            resolve(navResult);
            return;
          }
          render();
          return;
        }

        // Natural language question
        messages.push({ role: "user", content: input });

        if (!ctx.aiConfig) {
          messages.push({
            role: "system",
            content: "AI unavailable (no ANTHROPIC_API_KEY). Slash commands still work — type /help",
          });
          render();
          return;
        }

        isProcessing = true;
        render();

        try {
          const answer = await askWorkspaceQuestion(ctx.aiConfig, ctx.loaded, input);
          messages.push({
            role: "assistant",
            content: answer.answer,
            bulletPoints: answer.bulletPoints,
            sources: answer.sources,
            confidence: answer.confidence,
            actions: ["searched workspace", "retrieved context", "generated answer"],
          });
        } catch (err) {
          messages.push({
            role: "system",
            content: `Error: ${err instanceof Error ? err.message : "unknown"}`,
          });
        }

        isProcessing = false;
        render();
        return;
      }

      // Arrow up/down for slash menu
      if (key === "\x1B[A" && showSlashMenu) {
        const matches = getSlashMatches();
        slashSelected = Math.max(0, slashSelected - 1);
        render();
        return;
      }
      if (key === "\x1B[B" && showSlashMenu) {
        const matches = getSlashMatches();
        slashSelected = Math.min(matches.length - 1, slashSelected + 1);
        render();
        return;
      }

      // Backspace
      if (key === "\x7F" || key === "\b") {
        if (inputBuffer.length > 0) {
          inputBuffer = inputBuffer.slice(0, -1);
          showSlashMenu = inputBuffer.startsWith("/");
          slashSelected = 0;
          render();
        }
        return;
      }

      // Tab — autocomplete slash command
      if (key === "\t" && showSlashMenu) {
        const matches = getSlashMatches();
        if (matches.length > 0) {
          inputBuffer = matches[slashSelected].cmd;
          render();
        }
        return;
      }

      // Regular character
      if (key.length === 1 && key >= " ") {
        inputBuffer += key;

        // Detect slash command start
        if (inputBuffer === "/") {
          showSlashMenu = true;
          slashSelected = 0;
        } else if (inputBuffer.startsWith("/")) {
          showSlashMenu = true;
          slashSelected = 0;
        } else {
          showSlashMenu = false;
        }

        render();
      }
    }

    function onData(key: string): void {
      handleKey(key).catch((err) => {
        console.error(err);
      });
    }

    function cleanup(): void {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      showCursor();
      clearScreen();
    }

    stdin.on("data", onData);
  });
}

// --- Slash command handler ---

function handleSlashCommand(
  cmd: string,
  ctx: WorkspaceContext,
  messages: ChatMessage[]
): "back" | "courses" | "quit" | null {
  switch (cmd) {
    case "/overview":
      if (ctx.workup) {
        messages.push({
          role: "assistant",
          content: ctx.workup.overview,
          actions: ["loaded overview"],
        });
      } else {
        messages.push({ role: "system", content: "No workup data available." });
      }
      return null;

    case "/requirements":
    case "/reqs": {
      if (!ctx.workup) {
        messages.push({ role: "system", content: "No workup data available." });
        return null;
      }
      const parts: string[] = [];
      if (ctx.workup.deliverables.length > 0) {
        parts.push("**Deliverables**\n" + ctx.workup.deliverables.map((d) => `• ${d}`).join("\n"));
      }
      if (ctx.workup.constraints.length > 0) {
        parts.push("**Constraints**\n" + ctx.workup.constraints.map((c) => `• ${c}`).join("\n"));
      }
      messages.push({
        role: "assistant",
        content: parts.join("\n\n") || "No deliverables or constraints found.",
        actions: ["loaded requirements"],
      });
      return null;
    }

    case "/plan":
      if (ctx.workup && ctx.workup.actionPlan.length > 0) {
        const planText = ctx.workup.actionPlan
          .map((s) => `${s.step}. ${s.action}${s.detail ? `\n   ${s.detail}` : ""}`)
          .join("\n");
        messages.push({
          role: "assistant",
          content: planText,
          actions: ["loaded plan"],
        });
      } else {
        messages.push({ role: "system", content: "No action plan available." });
      }
      return null;

    case "/resources":
      if (ctx.workup && ctx.workup.relevantResources.length > 0) {
        const resText = ctx.workup.relevantResources
          .map((r) => `• **${r.title}** (${r.type}) — ${r.why}`)
          .join("\n");
        messages.push({
          role: "assistant",
          content: resText,
          actions: ["loaded resources"],
        });
      } else {
        messages.push({ role: "system", content: "No resources listed." });
      }
      return null;

    case "/evidence":
      if (ctx.workup && ctx.workup.sourceTrace.length > 0) {
        let text = ctx.workup.sourceTrace
          .map((e) => `• ${e.conclusion}\n  source: ${e.source}`)
          .join("\n");
        if (ctx.workup.uncertainties.length > 0) {
          text += "\n\n**Open questions**\n" + ctx.workup.uncertainties.map((u) => `? ${u}`).join("\n");
        }
        messages.push({
          role: "assistant",
          content: text,
          actions: ["loaded evidence trace"],
        });
      } else {
        messages.push({ role: "system", content: "No source trace available." });
      }
      return null;

    case "/status": {
      const w = ctx.workup;
      const lines = [
        `Assignment: ${ctx.loaded.assignmentName}`,
        `Course: ${ctx.loaded.courseName}`,
        `Path: ${ctx.workspacePath}`,
        `Workup: ${w ? "loaded" : "not available"}`,
        `Extracted: ${ctx.loaded.extractedFiles.length} documents`,
        w ? `Confidence: ${w.confidence}` : "",
      ].filter(Boolean);
      messages.push({
        role: "assistant",
        content: lines.join("\n"),
        actions: ["checked status"],
      });
      return null;
    }

    case "/help":
      messages.push({
        role: "assistant",
        content: SLASH_COMMANDS.map((c) => `${c.cmd}  ${c.desc}`).join("\n"),
        actions: ["loaded help"],
      });
      return null;

    case "/back":
      return "back";
    case "/courses":
      return "courses";
    case "/quit":
    case "/exit":
    case "/q":
      return "quit";

    default:
      messages.push({ role: "system", content: `Unknown command: ${cmd}. Type /help for options.` });
      return null;
  }
}

// --- Message renderers (buffer-based for flicker-free rendering) ---

type Buf = { push(line: string): void };

function renderHeader(ctx: WorkspaceContext, buf: Buf): void {
  const name = ctx.loaded.assignmentName;
  const course = ctx.loaded.courseName;
  const w = ctx.workup;

  buf.push("");
  buf.push(`  ${C.primaryBold(name)}  ${C.dim(course)}`);

  if (w) {
    const parts = [`confidence: ${fmtConfidence(w.confidence)}`];
    if (w.dueDate) parts.push(`due: ${C.text(w.dueDate)}`);
    buf.push(`  ${parts.map((p) => C.dim(p)).join(C.dimmer("  ·  "))}`);
  }

  buf.push(divider());
}

function renderMessage(msg: ChatMessage, buf: Buf): void {
  buf.push("");

  switch (msg.role) {
    case "user":
      buf.push(`  ${C.bold(msg.content)}`);
      break;

    case "assistant":
      if (msg.actions && msg.actions.length > 0) {
        for (const action of msg.actions) {
          buf.push(`  ${C.dim("›")} ${C.dim(action)}`);
        }
        buf.push("");
      }

      renderMarkdownContent(msg.content, buf);

      if (msg.bulletPoints && msg.bulletPoints.length > 0) {
        buf.push("");
        for (const bp of msg.bulletPoints) {
          buf.push(`  ${C.dim("•")} ${C.text(bp)}`);
        }
      }

      if (msg.sources && msg.sources.length > 0) {
        buf.push("");
        for (const src of msg.sources) {
          buf.push(`  ${C.dimmer(`[${src.kind}]`)} ${C.dim(src.title)}`);
        }
      }

      if (msg.confidence) {
        buf.push(`  ${C.dimmer("confidence:")} ${fmtConfidence(msg.confidence)}`);
      }
      break;

    case "system":
      buf.push(`  ${C.dim(msg.content)}`);
      break;

    case "action":
      buf.push(`  ${C.dim("›")} ${C.dim(msg.content)}`);
      break;
  }
}

function renderMarkdownContent(content: string, buf: Buf): void {
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.trim()) {
      buf.push("");
      continue;
    }

    let rendered = line;
    rendered = rendered.replace(/\*\*(.+?)\*\*/g, (_m, t) => C.bold(t));

    if (rendered.trim().startsWith("•") || rendered.trim().startsWith("?")) {
      const indent = rendered.match(/^\s*/)?.[0] ?? "";
      const symbol = rendered.trim().startsWith("?")
        ? C.warn("?")
        : C.dim("•");
      const text = rendered.trim().slice(1).trim();
      buf.push(`  ${indent}${symbol} ${C.text(text)}`);
    } else if (/^\d+\.\s/.test(rendered.trim())) {
      const match = rendered.trim().match(/^(\d+)\.\s(.+)/);
      if (match) {
        buf.push(`  ${C.primaryBold(match[1] + ".")} ${C.text(match[2])}`);
      }
    } else {
      buf.push(`  ${C.text(rendered)}`);
    }
  }
}
