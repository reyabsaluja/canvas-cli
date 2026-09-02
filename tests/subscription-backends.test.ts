import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTranscriptPrompt,
  classifyCliFailure,
  findExecutable,
  type CliDeps,
} from "../src/ai/cli-backend.js";
import {
  buildCodexArgs,
  consumeCodexEvent,
  runCodex,
  type CodexStreamState,
} from "../src/ai/backends/codex.js";
import {
  buildCopilotArgs,
  buildCopilotMcpConfig,
  consumeCopilotEvent,
  createCopilotState,
  runCopilot,
  COPILOT_EXCLUDED_TOOLS,
} from "../src/ai/backends/copilot.js";
import { AIError } from "../src/ai/errors.js";
import { getBackendKind } from "../src/ai/provider.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("buildTranscriptPrompt replays history and ends with the current request", () => {
  const prompt = buildTranscriptPrompt("Be terse.", [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "what is due?" },
  ]);
  assert.match(prompt, /# Instructions\nBe terse\./);
  assert.match(prompt, /# Conversation so far\nUser: hello\n\nAssistant: hi/);
  assert.match(prompt, /# Current request\nwhat is due\?$/);
  assert.match(prompt, /do not run shell commands/);
});

test("classifyCliFailure maps vendor messages to AIError kinds", () => {
  assert.equal(classifyCliFailure("codex", "unexpected status 401 Unauthorized").kind, "auth");
  assert.equal(classifyCliFailure("copilot", "No authentication information found.").kind, "auth");
  assert.equal(classifyCliFailure("copilot", "weekly limit hit", "rate_limit").kind, "rate_limit");
  assert.equal(classifyCliFailure("codex", "You've hit your usage limit").kind, "rate_limit");
  assert.equal(classifyCliFailure("copilot", "model gpt-9 not found").kind, "model_not_found");
  assert.equal(classifyCliFailure("codex", "getaddrinfo ENOTFOUND api.openai.com").kind, "network");
  assert.equal(classifyCliFailure("codex", "something odd").kind, "unknown");
  assert.match(classifyCliFailure("codex", "401").userMessage, /codex login/);
  assert.match(classifyCliFailure("copilot", "401").userMessage, /copilot login/);
});

test("buildCodexArgs isolates the run and wires the MCP bridge", () => {
  const args = buildCodexArgs({ model: "default", effort: "high", cwd: "/tmp/x", bridgeUrl: "http://127.0.0.1:1/mcp" });
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
  assert.ok(!args.includes("-m"), "default model must not pass -m");
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes('mcp_servers.canvas.url="http://127.0.0.1:1/mcp"'));
  assert.ok(args.includes('mcp_servers.canvas.bearer_token_env_var="CANVAS_CLI_MCP_TOKEN"'));
  assert.equal(args[args.length - 1], "-", "prompt comes from stdin");

  const withModel = buildCodexArgs({ model: "gpt-5.4-codex", cwd: "/tmp/x" });
  assert.deepEqual(withModel.slice(withModel.indexOf("-m"), withModel.indexOf("-m") + 2), ["-m", "gpt-5.4-codex"]);
  assert.ok(!withModel.some((a) => a.startsWith("mcp_servers")));
});

test("buildCopilotArgs removes built-in tools and keeps the variadic flag last", () => {
  const args = buildCopilotArgs({
    prompt: "hi",
    model: "auto",
    effort: "medium",
    cwd: "/tmp/y",
    mcpConfigPath: "/tmp/y/mcp.json",
  });
  assert.deepEqual(args.slice(0, 2), ["-p", "hi"]);
  assert.ok(args.includes("--output-format") && args.includes("json"));
  assert.ok(args.includes("--disable-builtin-mcps"));
  assert.ok(args.includes("--no-custom-instructions"));
  assert.ok(args.includes("--additional-mcp-config") && args.includes("@/tmp/y/mcp.json"));
  assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "medium"]);
  const excludedIndex = args.indexOf("--excluded-tools");
  assert.deepEqual(args.slice(excludedIndex + 1), COPILOT_EXCLUDED_TOOLS);
  assert.ok(args.includes("--deny-tool"));
  assert.ok(COPILOT_EXCLUDED_TOOLS.includes("bash") && COPILOT_EXCLUDED_TOOLS.includes("web_fetch"));
});

test("buildCopilotMcpConfig produces the CLI's mcpServers shape with a bearer header", () => {
  const config = JSON.parse(buildCopilotMcpConfig("http://127.0.0.1:5/mcp", "tok"));
  assert.deepEqual(config, {
    mcpServers: {
      canvas: { type: "http", url: "http://127.0.0.1:5/mcp", tools: ["*"], headers: { Authorization: "Bearer tok" } },
    },
  });
});

test("consumeCodexEvent collects agent messages and terminal state", () => {
  const state: CodexStreamState = { text: "", done: false, lastError: null, fatalError: null };
  const deltas: string[] = [];
  consumeCodexEvent(state, { type: "thread.started", thread_id: "t" }, (d) => deltas.push(d));
  consumeCodexEvent(state, { type: "item.started", item: { type: "agent_message", text: "" } }, (d) => deltas.push(d));
  consumeCodexEvent(state, { type: "item.completed", item: { type: "reasoning", text: "thinking" } }, (d) => deltas.push(d));
  consumeCodexEvent(state, { type: "item.completed", item: { type: "agent_message", text: "First." } }, (d) => deltas.push(d));
  consumeCodexEvent(state, { type: "error", message: "Reconnecting... 1/5" }, (d) => deltas.push(d));
  consumeCodexEvent(state, { type: "item.completed", item: { type: "agent_message", text: "Second." } }, (d) => deltas.push(d));
  consumeCodexEvent(state, { type: "turn.completed", usage: {} }, (d) => deltas.push(d));
  assert.equal(state.text, "First.\n\nSecond.");
  assert.deepEqual(deltas, ["First.", "\n\nSecond."]);
  assert.equal(state.done, true);
  assert.equal(state.lastError, "Reconnecting... 1/5");
  assert.equal(state.fatalError, null);

  consumeCodexEvent(state, { type: "turn.failed", error: { message: "boom" } });
  assert.equal(state.fatalError, "boom");
});

test("consumeCopilotEvent streams deltas without duplicating the final message", () => {
  const state = createCopilotState();
  const deltas: string[] = [];
  const emit = (d: string) => deltas.push(d);
  consumeCopilotEvent(state, { type: "assistant.turn_start", data: { turnId: "1" } }, emit);
  consumeCopilotEvent(state, { type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "Hel" } }, emit);
  consumeCopilotEvent(state, { type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "lo" } }, emit);
  consumeCopilotEvent(state, { type: "assistant.message", data: { messageId: "m1", content: "Hello!" } }, emit);
  // A sub-agent's chatter must not leak into the answer.
  consumeCopilotEvent(state, { type: "assistant.message", agentId: "sub", data: { messageId: "s1", content: "ignore" } }, emit);
  // A message that was never streamed is emitted whole.
  consumeCopilotEvent(state, { type: "assistant.message", data: { messageId: "m2", content: "Bye." } }, emit);
  consumeCopilotEvent(state, { type: "session.idle", data: {} }, emit);
  assert.equal(state.text, "Hello!\n\nBye.");
  assert.deepEqual(deltas, ["Hel", "lo", "!", "\n\nBye."]);
  assert.equal(state.done, true);

  consumeCopilotEvent(state, { type: "session.error", data: { errorType: "quota", message: "out of credits" } }, emit);
  assert.deepEqual(state.error, { message: "out of credits", category: "quota" });
});

test("getBackendKind keeps API-key providers on the SDK path", () => {
  assert.equal(getBackendKind({ provider: "anthropic" }), "sdk");
  assert.equal(getBackendKind({ provider: "openai" }), "sdk");
  assert.equal(getBackendKind({ provider: "google" }), "sdk");
  assert.equal(getBackendKind({ provider: "bedrock" }), "sdk");
  assert.equal(getBackendKind({ provider: "copilot" }), "cli");
  assert.equal(getBackendKind({ provider: "codex" }), "cli");
});

test("findExecutable returns null for a binary that does not exist", () => {
  assert.equal(findExecutable("definitely-not-a-real-binary-xyz"), null);
  assert.ok(findExecutable("node"));
});

// ---------------------------------------------------------------------------
// End-to-end against fake CLIs that speak the real JSONL protocols and call
// back into the MCP bridge for tool execution.
// ---------------------------------------------------------------------------

const FAKE_CODEX = `
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
const urlArg = args.find((a) => a.startsWith("mcp_servers.canvas.url="));
const url = urlArg ? JSON.parse(urlArg.slice("mcp_servers.canvas.url=".length)) : null;
const token = process.env.CANVAS_CLI_MCP_TOKEN;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
(async () => {
  out({ type: "thread.started", thread_id: "t1" });
  out({ type: "turn.started" });
  if (process.env.FAKE_MODE === "auth-fail") {
    out({ type: "error", message: "unexpected status 401 Unauthorized: Missing bearer" });
    process.exit(1);
  }
  if (process.env.FAKE_MODE === "hang") {
    await new Promise((r) => setTimeout(r, 60000));
  }
  let toolText = "";
  if (url) {
    const call = async (body) => (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(body) })).json();
    const list = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const name = list.result.tools[0].name;
    const res = await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: { id: 7 } } });
    toolText = res.result.content[0].text;
    out({ type: "item.completed", item: { id: "i1", type: "mcp_tool_call", server: "canvas", tool: name, status: "completed" } });
  }
  out({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "prompt-bytes=" + prompt.length + (toolText ? " tool=" + toolText : "") + " model=" + (args.includes("-m") ? args[args.indexOf("-m") + 1] : "default") } });
  out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
})();
`;

const FAKE_COPILOT = `
const fs = require("node:fs");
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1];
const cfgArg = args.find((a) => a.startsWith("@"));
const out = (o) => process.stdout.write(JSON.stringify({ id: "e", timestamp: "now", parentId: null, ...o }) + "\\n");
(async () => {
  if (process.env.FAKE_MODE === "auth-fail") {
    process.stderr.write("Error: No authentication information found.\\n");
    process.exit(1);
  }
  out({ type: "assistant.turn_start", data: { turnId: "1" } });
  let toolText = "";
  if (cfgArg) {
    const cfg = JSON.parse(fs.readFileSync(cfgArg.slice(1), "utf8"));
    const server = cfg.mcpServers.canvas;
    const call = async (body) => (await fetch(server.url, { method: "POST", headers: { "Content-Type": "application/json", ...server.headers }, body: JSON.stringify(body) })).json();
    const list = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const name = list.result.tools[0].name;
    out({ type: "tool.execution_start", data: { toolCallId: "c1", toolName: "canvas-" + name, mcpServerName: "canvas", mcpToolName: name } });
    const res = await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: { id: 9 } } });
    toolText = res.result.content[0].text;
    out({ type: "tool.execution_complete", data: { toolCallId: "c1", success: true } });
  }
  const text = "prompt-bytes=" + prompt.length + (toolText ? " tool=" + toolText : "") + " model=" + args[args.indexOf("--model") + 1];
  out({ type: "assistant.message_delta", data: { messageId: "m1", deltaContent: text.slice(0, 5) } });
  out({ type: "assistant.message_delta", data: { messageId: "m1", deltaContent: text.slice(5) } });
  out({ type: "assistant.message", data: { messageId: "m1", content: text } });
  out({ type: "assistant.turn_end", data: { turnId: "1" } });
  out({ type: "session.idle", data: {} });
})();
`;

function fakeCliDeps(script: string, mode?: string): { deps: CliDeps; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "canvas-cli-fake-cli-"));
  const scriptPath = join(dir, "fake.cjs");
  writeFileSync(scriptPath, script);
  const deps: CliDeps = {
    findExecutable: () => process.execPath,
    env: { ...process.env, ...(mode ? { FAKE_MODE: mode } : {}) },
    spawn: (command, args, options) => spawn(command, [scriptPath, ...args], options),
  };
  return { deps, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const TOOL = {
  name: "get_assignment",
  description: "Fetch an assignment by id",
  parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
};

test("runCodex round-trips a tool call through the bridge and returns the agent message", async () => {
  const { deps, cleanup } = fakeCliDeps(FAKE_CODEX);
  const toolCalls: string[] = [];
  const deltas: string[] = [];
  try {
    const text = await runCodex(
      {
        provider: "codex",
        model: "gpt-5.4-codex",
        effort: "low",
        systemPrompt: "SYSTEM",
        messages: [{ role: "user", content: "what is assignment 7?" }],
        tools: [TOOL],
        executeTool: async (name, input) => `${name}#${(input as { id: number }).id}`,
        onToolCall: (name) => toolCalls.push(name),
        onTextDelta: (d) => deltas.push(d),
      },
      deps
    );
    assert.match(text, /^prompt-bytes=\d+ tool=get_assignment#7 model=gpt-5\.4-codex$/);
    assert.deepEqual(toolCalls, ["get_assignment"]);
    assert.equal(deltas.join(""), text);
  } finally {
    cleanup();
  }
});

test("runCodex surfaces a sign-in failure as an auth AIError", async () => {
  const { deps, cleanup } = fakeCliDeps(FAKE_CODEX, "auth-fail");
  try {
    await assert.rejects(
      runCodex(
        { provider: "codex", model: "default", systemPrompt: "s", messages: [{ role: "user", content: "q" }], tools: [], executeTool: async () => "" },
        deps
      ),
      (error: unknown) => error instanceof AIError && error.kind === "auth" && /codex login/.test(error.userMessage)
    );
  } finally {
    cleanup();
  }
});

test("runCodex reports a missing CLI with install instructions", async () => {
  await assert.rejects(
    runCodex(
      { provider: "codex", model: "default", systemPrompt: "s", messages: [{ role: "user", content: "q" }], tools: [], executeTool: async () => "" },
      { findExecutable: () => null }
    ),
    (error: unknown) =>
      error instanceof AIError && error.kind === "provider_unavailable" && /npm install -g @openai\/codex/.test(error.userMessage)
  );
});

test("runCodex honours abort by killing the CLI", async () => {
  const { deps, cleanup } = fakeCliDeps(FAKE_CODEX, "hang");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  try {
    await assert.rejects(
      runCodex(
        {
          provider: "codex",
          model: "default",
          systemPrompt: "s",
          messages: [{ role: "user", content: "q" }],
          tools: [],
          executeTool: async () => "",
          abortSignal: controller.signal,
        },
        deps
      ),
      (error: unknown) => error instanceof DOMException && error.name === "AbortError"
    );
  } finally {
    cleanup();
  }
});

test("runCopilot streams deltas and round-trips a tool call through the bridge", async () => {
  const { deps, cleanup } = fakeCliDeps(FAKE_COPILOT);
  const toolCalls: string[] = [];
  const deltas: string[] = [];
  try {
    const text = await runCopilot(
      {
        provider: "copilot",
        model: "auto",
        effort: "high",
        systemPrompt: "SYSTEM",
        messages: [
          { role: "user", content: "earlier" },
          { role: "assistant", content: "reply" },
          { role: "user", content: "what is assignment 9?" },
        ],
        tools: [TOOL],
        executeTool: async (name, input) => `${name}#${(input as { id: number }).id}`,
        onToolCall: (name) => toolCalls.push(name),
        onTextDelta: (d) => deltas.push(d),
      },
      deps
    );
    assert.match(text, /^prompt-bytes=\d+ tool=get_assignment#9 model=auto$/);
    assert.deepEqual(toolCalls, ["get_assignment"]);
    assert.equal(deltas.length, 2, "final message must not be re-emitted after deltas");
    assert.equal(deltas.join(""), text);
  } finally {
    cleanup();
  }
});

test("runCopilot surfaces a sign-in failure as an auth AIError", async () => {
  const { deps, cleanup } = fakeCliDeps(FAKE_COPILOT, "auth-fail");
  try {
    await assert.rejects(
      runCopilot(
        { provider: "copilot", model: "auto", systemPrompt: "s", messages: [{ role: "user", content: "q" }], tools: [], executeTool: async () => "" },
        deps
      ),
      (error: unknown) => error instanceof AIError && error.kind === "auth" && /copilot login/.test(error.userMessage)
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Local status checks used by login, /model, status and /doctor
// ---------------------------------------------------------------------------

test("checkSubscriptionCli reports a missing CLI without touching the network", async () => {
  const { checkSubscriptionCli } = await import("../src/ai/subscription-status.js");
  const savedPath = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), "canvas-cli-empty-path-"));
  try {
    const copilot = checkSubscriptionCli("copilot");
    assert.equal(copilot.installed, false);
    assert.equal(copilot.loggedIn, false);
    assert.match(copilot.installHint, /npm install -g @github\/copilot/);
    const codex = checkSubscriptionCli("codex");
    assert.equal(codex.installed, false);
    assert.match(codex.loginHint, /codex login/);
  } finally {
    rmSync(process.env.PATH!, { recursive: true, force: true });
    process.env.PATH = savedPath;
  }
});

test("doctor turns a missing subscription CLI into a failing check with install steps", async () => {
  const { checkSubscriptionProvider } = await import("../src/tui/doctor.js");
  const savedPath = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), "canvas-cli-empty-path-"));
  try {
    const result = checkSubscriptionProvider("copilot");
    assert.equal(result.status, "fail");
    assert.match(result.detail, /not installed/);
    assert.match(result.fix ?? "", /npm install -g @github\/copilot/);
  } finally {
    rmSync(process.env.PATH!, { recursive: true, force: true });
    process.env.PATH = savedPath;
  }
});
