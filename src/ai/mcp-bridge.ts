import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { debug } from "../debug.js";

/**
 * A minimal Model Context Protocol server over streamable HTTP.
 *
 * Subscription backends (GitHub Copilot, ChatGPT via Codex) run as vendor CLIs
 * in a child process. They cannot call our in-process tool functions directly,
 * so we expose the tools of the current request as an MCP server bound to
 * 127.0.0.1 on an ephemeral port, protected by a per-run bearer token. The CLI
 * connects to it like any other MCP server; tool execution still happens here.
 *
 * Only the subset of MCP needed for tools is implemented: initialize, ping,
 * tools/list and tools/call. There is no SSE stream and no session state.
 */

export interface BridgeTool {
  name: string;
  description: string;
  /** JSON Schema for the tool input. Must describe an object. */
  parameters: Record<string, unknown>;
}

export interface ToolBridgeOptions {
  tools: BridgeTool[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  onToolCall?: (name: string, input: Record<string, unknown>, result: string) => void;
  /** Optional abort signal; tool calls are refused once it fires. */
  abortSignal?: AbortSignal;
  /** Server name reported to the client. Also the MCP server name the CLI sees. */
  serverName?: string;
  serverVersion?: string;
}

export interface ToolBridge {
  /** Full URL of the MCP endpoint, e.g. http://127.0.0.1:53211/mcp */
  url: string;
  /** Bearer token the client must send. */
  token: string;
  /** Number of tool calls executed through the bridge so far. */
  readonly callCount: number;
  close(): Promise<void>;
}

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: number | string | null; result: unknown }
  | { jsonrpc: "2.0"; id: number | string | null; error: { code: number; message: string; data?: unknown } };

export async function startToolBridge(options: ToolBridgeOptions): Promise<ToolBridge> {
  const token = randomBytes(24).toString("base64url");
  const serverName = options.serverName ?? "canvas";
  const serverVersion = options.serverVersion ?? "1.0.0";
  let callCount = 0;

  const toolsByName = new Map<string, BridgeTool>();
  for (const tool of options.tools) {
    toolsByName.set(tool.name, tool);
  }

  const handle = async (message: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
    const id = message.id ?? null;
    const method = message.method;
    const isNotification = message.id === undefined;

    if (!method) {
      return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } };
    }
    if (isNotification) {
      // notifications/initialized, notifications/cancelled, etc. need no reply.
      return null;
    }

    switch (method) {
      case "initialize": {
        const requested = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        const protocolVersion =
          typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : DEFAULT_PROTOCOL_VERSION;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: serverName, version: serverVersion },
            instructions:
              "These tools give access to the student's Canvas course data. Prefer them over guessing.",
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: options.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: normalizeSchema(tool.parameters),
            })),
          },
        };
      case "tools/call": {
        const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
        const name = typeof params.name === "string" ? params.name : "";
        const tool = toolsByName.get(name);
        if (!tool) {
          return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        }
        if (options.abortSignal?.aborted) {
          return { jsonrpc: "2.0", id, error: { code: -32000, message: "Request aborted" } };
        }
        const input =
          params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {};
        callCount += 1;
        debug("ai", `mcp bridge: tool call ${name}`);
        try {
          const result = await options.executeTool(name, input);
          options.onToolCall?.(name, input, result);
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: result }], isError: false },
          };
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          options.onToolCall?.(name, input, `Error: ${text}`);
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: `Tool failed: ${text}` }], isError: true },
          };
        }
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  };

  const server: Server = createServer((req, res) => {
    void handleHttp(req, res, token, handle);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/mcp`;
  debug("ai", `mcp bridge listening on ${url} with ${options.tools.length} tools`);

  return {
    url,
    token,
    get callCount() {
      return callCount;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  handle: (message: JsonRpcRequest) => Promise<JsonRpcResponse | null>
): Promise<void> {
  try {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (req.method === "DELETE") {
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST, DELETE" });
      res.end();
      return;
    }

    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }

    const messages = Array.isArray(parsed) ? (parsed as JsonRpcRequest[]) : [parsed as JsonRpcRequest];
    const responses: JsonRpcResponse[] = [];
    for (const message of messages) {
      const response = await handle(message ?? {});
      if (response) responses.push(response);
    }

    if (responses.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }

    const payload = Array.isArray(parsed) ? responses : responses[0];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  } catch (error) {
    debug("ai", `mcp bridge request failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type === "object") return schema;
  return { type: "object", ...schema };
}
