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
 * ChatGPT subscription backend, driven through the OpenAI Codex CLI.
 *
 * Runs `codex exec --json` in an empty scratch directory with a read-only
 * sandbox, no persisted session, and the user's own config ignored. The
 * request's tools are exposed to Codex through the local MCP bridge.
 *
 * Experimental: OpenAI has not published terms that explicitly cover
 * third-party tools using a ChatGPT plan through the Codex CLI.
 */

export const CODEX_DEFAULT_MODEL = "default";
const MCP_TOKEN_ENV = "CANVAS_CLI_MCP_TOKEN";

export function buildCodexArgs(input: {
  model: string;
  effort?: string;
  cwd: string;
  bridgeUrl?: string;
}): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "-C",
    input.cwd,
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
  ];
  if (input.model && input.model !== CODEX_DEFAULT_MODEL) {
    args.push("-m", input.model);
  }
  if (input.effort) {
    args.push("-c", `model_reasoning_effort="${input.effort}"`);
  }
  if (input.bridgeUrl) {
    args.push("-c", `mcp_servers.canvas.url="${input.bridgeUrl}"`);
    args.push("-c", `mcp_servers.canvas.bearer_token_env_var="${MCP_TOKEN_ENV}"`);
  }
  // "-" reads the prompt from stdin so it never appears in the process list.
  args.push("-");
  return args;
}

export interface CodexStreamState {
  text: string;
  done: boolean;
  lastError: string | null;
  fatalError: string | null;
}

/** Consume one JSONL event from `codex exec --json`. Exported for tests. */
export function consumeCodexEvent(
  state: CodexStreamState,
  event: Record<string, unknown>,
  onTextDelta?: (delta: string) => void
): void {
  const type = event.type;
  if (type === "item.completed") {
    const item = event.item as { type?: string; text?: string } | undefined;
    if (item?.type === "agent_message" && typeof item.text === "string" && item.text) {
      const delta = state.text ? `\n\n${item.text}` : item.text;
      state.text += delta;
      onTextDelta?.(delta);
    }
    return;
  }
  if (type === "turn.completed") {
    state.done = true;
    return;
  }
  if (type === "turn.failed") {
    const error = event.error as { message?: string } | undefined;
    state.fatalError = error?.message ?? "turn failed";
    return;
  }
  if (type === "error") {
    const message = typeof event.message === "string" ? event.message : "unknown error";
    state.lastError = message;
  }
}

export async function runCodex(request: CliBackendRequest, deps: CliDeps = {}): Promise<string> {
  const locate = deps.findExecutable ?? findExecutable;
  const baseEnv = deps.env ?? process.env;
  const command = locate("codex");
  if (!command) {
    throw missingCliError("codex");
  }

  const scratch = makeScratchDir("codex");
  let bridge: ToolBridge | null = null;
  const startedAt = Date.now();

  try {
    if (request.tools.length > 0) {
      bridge = await startToolBridge({
        tools: request.tools,
        executeTool: request.executeTool,
        onToolCall: request.onToolCall,
        abortSignal: request.abortSignal,
      });
    }

    const args = buildCodexArgs({
      model: request.model,
      effort: request.effort,
      cwd: scratch.path,
      bridgeUrl: bridge?.url,
    });
    const prompt = buildTranscriptPrompt(request.systemPrompt, request.messages);

    const env: NodeJS.ProcessEnv = { ...baseEnv };
    // The subscription path must not silently fall back to API-key billing.
    delete env.OPENAI_API_KEY;
    if (bridge) env[MCP_TOKEN_ENV] = bridge.token;

    debugAI("codex", request.model, "codex run starting", {
      tools: request.tools.map((t) => t.name),
      promptLength: prompt.length,
    });

    const state: CodexStreamState = { text: "", done: false, lastError: null, fatalError: null };
    const result = await runCliJsonl({
      command,
      args,
      stdin: prompt,
      env,
      cwd: scratch.path,
      abortSignal: request.abortSignal,
      timeoutMs: request.timeoutMs,
      spawnImpl: deps.spawn,
      onLine: (line) => {
        const event = safeJsonParse(line);
        if (event) consumeCodexEvent(state, event, request.onTextDelta);
      },
    });

    if (result.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (result.timedOut) {
      throw new AIError("ChatGPT (Codex) timed out.", "network", {
        setupHint: "Try again, or lower the effort level with /model effort.",
      });
    }

    if (state.fatalError) {
      throw classifyCliFailure("codex", state.fatalError);
    }
    if (!state.done || (!state.text && result.exitCode !== 0)) {
      const detail = state.lastError ?? cleanStderr(result.stderr);
      throw classifyCliFailure("codex", detail || `codex exited with code ${result.exitCode ?? "unknown"}`);
    }

    debugAI("codex", request.model, "codex run completed", {
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

/** Strip tracing prefixes ("2026-... ERROR codex_core::x:") from stderr lines. */
function cleanStderr(stderr: string): string {
  return stderr
    .split("\n")
    .map((line) => line.replace(/^\S+\s+(ERROR|WARN|INFO)\s+\S+:\s*/, "").trim())
    .filter(Boolean)
    .join("\n");
}
