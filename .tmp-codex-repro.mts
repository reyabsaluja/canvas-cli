import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startToolBridge } from "/Users/rey/Code/canvas-cli/src/ai/mcp-bridge.ts";
import { buildCodexArgs } from "/Users/rey/Code/canvas-cli/src/ai/backends/codex.ts"; const MCP_TOKEN_ENV = "CANVAS_CLI_MCP_TOKEN";
import { buildTranscriptPrompt } from "/Users/rey/Code/canvas-cli/src/ai/cli-backend.ts";

const bridge = await startToolBridge({
  tools: [{ name: "ping", description: "Returns a secret word. Call it when asked.", parameters: { type: "object", properties: {}, additionalProperties: false } }],
  executeTool: async (name) => { console.log(`[bridge] executeTool ${name}`); return "SECRET-WORD-KUMQUAT"; },
  onToolCall: (name, input, result) => console.log(`[bridge] onToolCall ${name} -> ${result}`),
});
// logging proxy in front of the bridge
const bridgeUrl = new URL(bridge.url);
const proxy = createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    let summary = body.slice(0, 200); try { const j = JSON.parse(body); summary = `${j.method ?? "(no method)"} id=${j.id ?? "-"} ${JSON.stringify(j.params ?? {}).slice(0, 120)}`; } catch {}
    console.log(`[proxy] ${req.method} ${req.url} accept=${req.headers.accept ?? ""} auth=${(req.headers.authorization ?? "").slice(0, 12)}… :: ${summary}`);
    const up = httpRequest({ host: bridgeUrl.hostname, port: bridgeUrl.port, path: req.url, method: req.method, headers: req.headers }, (upRes) => {
      let rb = ""; upRes.on("data", (c) => (rb += c)); upRes.on("end", () => { console.log(`[proxy]   -> ${upRes.statusCode} ${rb.slice(0, 160).replace(/\n/g, " ")}`); res.writeHead(upRes.statusCode ?? 500, upRes.headers); res.end(rb); });
    });
    up.end(body);
  });
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
const proxyUrl = `http://127.0.0.1:${(proxy.address() as any).port}/mcp`;
const scratch = mkdtempSync(join(tmpdir(), "codex-repro-"));
const args = buildCodexArgs({ model: process.env.CODEX_MODEL ?? "default", effort: "low", cwd: scratch, bridgeUrl: proxyUrl, env: process.env }); if (process.env.EXTRA_ARGS) args.splice(args.length - 1, 0, ...process.env.EXTRA_ARGS.split(" "));
console.log("[args]", args.join(" "));
const prompt = buildTranscriptPrompt("Call the MCP tool named `ping` exactly once and reply with exactly the word it returns. If you cannot call any tool, reply with NO TOOLS and one sentence explaining what tools you see.", [{ role: "user", content: "Go." }]);
const env = { ...process.env, [MCP_TOKEN_ENV]: bridge.token, RUST_LOG: "codex_core=info,codex_rmcp_client=debug,rmcp=info" };
delete env.OPENAI_API_KEY;
const child = spawn("/Users/rey/Code/canvas-cli/node_modules/.bin/codex", args, { cwd: scratch, env, stdio: ["pipe", "pipe", "pipe"] });
child.stdout.on("data", (c) => process.stdout.write(`[stdout] ${c}`));
let stderr = ""; child.stderr.on("data", (c) => { stderr += c; });
child.stdin.end(prompt);
const code = await new Promise<number | null>((r) => child.on("close", r));
console.log(`[exit] ${code}  toolCalls=${bridge.callCount}`);
console.log("[stderr] " + stderr.split("\n").filter((l) => /mcp|canvas|tool|error|warn|http/i.test(l)).slice(0, 40).join("\n[stderr] "));
await bridge.close(); proxy.close();
