import { closeSync, openSync, writeSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { debugAI } from "../../debug.js";
import { AIError } from "../errors.js";
import { startToolBridge, type ToolBridge } from "../mcp-bridge.js";
import {
  buildTranscriptPrompt,
  classifyCliFailure,
  findExecutable,
  makeScratchDir,
  missingCliError,
  runCliJsonl,
  safeJsonParse,
  type CliBackendRequest,
  type CliDeps,
} from "../cli-backend.js";

/**
 * GitHub Copilot subscription backend, driven through the Copilot CLI.
 *
 * Runs `copilot -p` in non-interactive mode with JSON event output. All
 * built-in tools (shell, file access, web fetch, sub-agents) are removed from
 * the model's view and denied as a second layer; only the request's tools,
 * exposed through the local MCP bridge, are available.
 */

export const COPILOT_DEFAULT_MODEL = "auto";

/** Built-in Copilot tools that must never be reachable from a Canvas chat. */
export const COPILOT_EXCLUDED_TOOLS = [
  "bash",
  "powershell",
  "shell",
  "view",
  "edit",
  "create",
  "grep",
  "glob",
  "web_fetch",
  "ask_user",
  "task",
  "sql",
  "skill",
  "update_todo",
  "store_memory",
];

/** Maximum prompt size passed on the command line (stays well under ARG_MAX). */
const MAX_PROMPT_ARG_BYTES = 400 * 1024;

export function buildCopilotArgs(input: {
  prompt: string;
  model: string;
  effort?: string;
  cwd: string;
  mcpConfigPath?: string;
}): string[] {
  const args = [
    "-p",
    input.prompt,
    "--output-format",
    "json",
    "--stream",
    "on",
    "--silent",
    "--no-color",
    "--no-auto-update",
    "--no-custom-instructions",
    "--disable-builtin-mcps",
    "--no-ask-user",
    "--disallow-temp-dir",
    "--no-remote-export",
    "-C",
    input.cwd,
    "--model",
    input.model || COPILOT_DEFAULT_MODEL,
  ];
  if (input.effort) {
    args.push("--effort", input.effort);
  }
  if (input.mcpConfigPath) {
    args.push("--additional-mcp-config", `@${input.mcpConfigPath}`);
  }
  // Auto-approve remaining tools (only the MCP bridge survives the filters),
  // with explicit denials as a second layer in case a filter is bypassed.
  args.push("--allow-all-tools", "--deny-tool", "shell", "--deny-tool", "write");
  // Variadic option goes last so it cannot swallow other arguments.
  args.push("--excluded-tools", ...COPILOT_EXCLUDED_TOOLS);
  return args;
}

export function buildCopilotMcpConfig(bridgeUrl: string, token: string): string {
  return JSON.stringify({
    mcpServers: {
      canvas: {
        type: "http",
        url: bridgeUrl,
        tools: ["*"],
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  });
}

export interface CopilotStreamState {
  text: string;
  done: boolean;
  /** Text already streamed per assistant messageId, so the final message is not emitted twice. */
  streamed: Map<string, string>;
  error: { message: string; category?: string } | null;
}

export function createCopilotState(): CopilotStreamState {
  return { text: "", done: false, streamed: new Map(), error: null };
}

/** Consume one JSONL event from `copilot -p --output-format json`. Exported for tests. */
export function consumeCopilotEvent(
  state: CopilotStreamState,
  event: Record<string, unknown>,
  onTextDelta?: (delta: string) => void
): void {
  // Sub-agent events carry agentId; only the root agent's text is the answer.
  if (typeof event.agentId === "string" && event.agentId) return;
  const type = event.type;
  const data = (event.data ?? {}) as Record<string, unknown>;

  if (type === "assistant.message_delta") {
    const delta = typeof data.deltaContent === "string" ? data.deltaContent : "";
    const messageId = typeof data.messageId === "string" ? data.messageId : "";
    if (!delta) return;
    state.streamed.set(messageId, (state.streamed.get(messageId) ?? "") + delta);
    state.text += delta;
    onTextDelta?.(delta);
    return;
  }

  if (type === "assistant.message") {
    const content = typeof data.content === "string" ? data.content : "";
    const messageId = typeof data.messageId === "string" ? data.messageId : "";
    if (!content) return;
    const already = state.streamed.get(messageId) ?? "";
    if (already) {
      if (content.length > already.length && content.startsWith(already)) {
        const remainder = content.slice(already.length);
        state.text += remainder;
        onTextDelta?.(remainder);
      }
      state.streamed.delete(messageId);
      return;
    }
    const delta = state.text ? `\n\n${content}` : content;
    state.text += delta;
    onTextDelta?.(delta);
    return;
  }

  if (type === "session.error") {
    const message = typeof data.message === "string" ? data.message : "unknown error";
    const category = typeof data.errorType === "string" ? data.errorType : undefined;
    state.error = { message, category };
    return;
  }

  if (type === "session.idle" || type === "assistant.turn_end") {
    state.done = true;
  }
}

export async function runCopilot(request: CliBackendRequest, deps: CliDeps = {}): Promise<string> {
  const locate = deps.findExecutable ?? findExecutable;
  const baseEnv = deps.env ?? process.env;
  const command = locate("copilot");
  if (!command) {
    throw missingCliError("copilot");
  }

  const scratch = makeScratchDir("copilot");
  let bridge: ToolBridge | null = null;
  const startedAt = Date.now();

  try {
    let mcpConfigPath: string | undefined;
    if (request.tools.length > 0) {
      bridge = await startToolBridge({
        tools: request.tools,
        executeTool: request.executeTool,
        onToolCall: request.onToolCall,
        abortSignal: request.abortSignal,
      });
      mcpConfigPath = join(scratch.path, "mcp-config.json");
      writePrivateFile(mcpConfigPath, buildCopilotMcpConfig(bridge.url, bridge.token));
    }

    const prompt = buildTranscriptPrompt(request.systemPrompt, request.messages);
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_ARG_BYTES) {
      throw new AIError("The request is too large for GitHub Copilot.", "bad_request", {
        setupHint: "Start a new chat with /clear or ask about fewer documents at once.",
      });
    }

    const args = buildCopilotArgs({
      prompt,
      model: request.model,
      effort: request.effort,
      cwd: scratch.path,
      mcpConfigPath,
    });

    debugAI("copilot", request.model, "copilot run starting", {
      tools: request.tools.map((t) => t.name),
      promptLength: prompt.length,
    });

    const state = createCopilotState();
    const result = await runCliJsonl({
      command,
      args,
      env: { ...baseEnv },
      cwd: scratch.path,
      abortSignal: request.abortSignal,
      timeoutMs: request.timeoutMs,
      spawnImpl: deps.spawn,
      onLine: (line) => {
        const event = safeJsonParse(line);
        if (event) consumeCopilotEvent(state, event, request.onTextDelta);
      },
    });

    if (result.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (result.timedOut) {
      throw new AIError("GitHub Copilot timed out.", "network", {
        setupHint: "Try again, or lower the effort level with /model effort.",
      });
    }

    if (state.error && !state.text) {
      throw classifyCliFailure("copilot", state.error.message, state.error.category);
    }
    if (!state.text) {
      // Classify on the whole stderr: the vendor prints the cause first and
      // remediation hints after it.
      const detail = state.error?.message ?? result.stderr.trim();
      throw classifyCliFailure("copilot", detail || `copilot exited with code ${result.exitCode ?? "unknown"}`);
    }

    debugAI("copilot", request.model, "copilot run completed", {
      durationMs: Date.now() - startedAt,
      responseLength: state.text.length,
      toolCalls: bridge?.callCount ?? 0,
    });
    return state.text;
  } finally {
    if (bridge) await bridge.close();
    scratch.cleanup();
  }
}

function writePrivateFile(path: string, content: string): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

