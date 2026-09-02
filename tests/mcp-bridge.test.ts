import assert from "node:assert/strict";
import test from "node:test";
import { startToolBridge } from "../src/ai/mcp-bridge.js";

async function rpc(url: string, token: string | null, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

test("mcp bridge serves initialize, tools/list and tools/call over HTTP", async () => {
  const calls: Array<{ name: string; input: Record<string, unknown>; result: string }> = [];
  const bridge = await startToolBridge({
    tools: [
      {
        name: "get_assignment",
        description: "Fetch an assignment",
        parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
      },
    ],
    executeTool: async (name, input) => `${name}:${JSON.stringify(input)}`,
    onToolCall: (name, input, result) => calls.push({ name, input, result }),
  });

  try {
    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const init = await rpc(bridge.url, bridge.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    assert.equal(init.status, 200);
    assert.equal(init.json.result.protocolVersion, "2025-03-26");
    assert.equal(init.json.result.serverInfo.name, "canvas");
    assert.ok(init.json.result.capabilities.tools);

    const notified = await fetch(bridge.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(notified.status, 202);

    const list = await rpc(bridge.url, bridge.token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(list.json.result.tools.length, 1);
    assert.equal(list.json.result.tools[0].name, "get_assignment");
    assert.equal(list.json.result.tools[0].inputSchema.type, "object");

    const call = await rpc(bridge.url, bridge.token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_assignment", arguments: { id: 42 } },
    });
    assert.equal(call.json.result.isError, false);
    assert.equal(call.json.result.content[0].text, 'get_assignment:{"id":42}');
    assert.equal(bridge.callCount, 1);
    assert.deepEqual(calls, [{ name: "get_assignment", input: { id: 42 }, result: 'get_assignment:{"id":42}' }]);

    const unknownTool = await rpc(bridge.url, bridge.token, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    assert.equal(unknownTool.json.error.code, -32602);

    const unknownMethod = await rpc(bridge.url, bridge.token, { jsonrpc: "2.0", id: 5, method: "resources/list" });
    assert.equal(unknownMethod.json.error.code, -32601);
  } finally {
    await bridge.close();
  }
});

test("mcp bridge rejects requests without the per-run bearer token", async () => {
  const bridge = await startToolBridge({ tools: [], executeTool: async () => "" });
  try {
    const noToken = await rpc(bridge.url, null, { jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(noToken.status, 401);
    const wrongToken = await rpc(bridge.url, "nope", { jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(wrongToken.status, 401);
    const ok = await rpc(bridge.url, bridge.token, { jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.result, {});
  } finally {
    await bridge.close();
  }
});

test("mcp bridge reports tool failures as isError results instead of crashing", async () => {
  const bridge = await startToolBridge({
    tools: [{ name: "boom", description: "fails", parameters: { type: "object", properties: {} } }],
    executeTool: async () => {
      throw new Error("canvas is down");
    },
  });
  try {
    const call = await rpc(bridge.url, bridge.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "boom", arguments: {} },
    });
    assert.equal(call.status, 200);
    assert.equal(call.json.result.isError, true);
    assert.match(call.json.result.content[0].text, /canvas is down/);
  } finally {
    await bridge.close();
  }
});

test("mcp bridge refuses tool calls once the request is aborted", async () => {
  const controller = new AbortController();
  const bridge = await startToolBridge({
    tools: [{ name: "slow", description: "", parameters: { type: "object", properties: {} } }],
    executeTool: async () => "should not run",
    abortSignal: controller.signal,
  });
  try {
    controller.abort();
    const call = await rpc(bridge.url, bridge.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "slow", arguments: {} },
    });
    assert.equal(call.json.error.code, -32000);
    assert.equal(bridge.callCount, 0);
  } finally {
    await bridge.close();
  }
});
