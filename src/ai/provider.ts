import { generateText, streamText, tool, jsonSchema, stepCountIs, RetryError } from "ai";
import { APICallError } from "@ai-sdk/provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

export interface AIProviderConfig {
  provider: "anthropic" | "openai" | "google";
  model: string;
}

/**
 * Detect which AI provider is configured from environment variables.
 * Checks in order: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY.
 * Model can be overridden with AI_MODEL env var.
 */
export function getAIConfig(): AIProviderConfig | null {
  const modelOverride = process.env.AI_MODEL;

  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      model: modelOverride ?? "claude-sonnet-4-20250514",
    };
  }

  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      model: modelOverride ?? "gpt-4o",
    };
  }

  if (process.env.GOOGLE_API_KEY) {
    return {
      provider: "google",
      model: modelOverride ?? "gemini-2.0-flash",
    };
  }

  return null;
}

function getModel(config: AIProviderConfig) {
  switch (config.provider) {
    case "anthropic": {
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY!,
      });
      return anthropic(config.model);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
      return openai(config.model);
    }
    case "google": {
      const google = createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_API_KEY!,
      });
      return google(config.model);
    }
  }
}

/**
 * Call the AI model with a system prompt and user message.
 * Returns the text response.
 */
export async function callModel(
  config: AIProviderConfig,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const result = await generateText({
    model: getModel(config),
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  return result.text;
}

/** Provider-agnostic tool definition with an execute function. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GenerateWithToolsResult {
  text: string;
  /** All messages from this interaction (for appending to conversation history). */
  responseMessages: any[];
}

/**
 * Execute tool-calling generation with the AI SDK's built-in tool loop.
 *
 * Accepts a message history for multi-turn conversations.
 * Returns the response text + response messages for accumulating context.
 */
export async function generateWithTools(
  config: AIProviderConfig,
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  toolDefs: ToolDefinition[],
  executeTool: (
    name: string,
    input: Record<string, unknown>
  ) => Promise<string>,
  onToolCall?: (name: string, input: Record<string, unknown>, result: string) => void,
  maxSteps: number = 10
): Promise<GenerateWithToolsResult> {
  const aiTools: Record<string, any> = {};
  for (const t of toolDefs) {
    aiTools[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters as any),
      execute: async (input: any) => {
        const result = await executeTool(t.name, input);
        onToolCall?.(t.name, input, result);
        return result;
      },
    } as any);
  }

  const result = await generateText({
    model: getModel(config),
    system: systemPrompt,
    messages: messages as any,
    tools: aiTools,
    stopWhen: stepCountIs(maxSteps),
  } as any);

  return {
    text: result.text,
    responseMessages: result.response.messages ?? [],
  };
}

/**
 * Stream tool-calling generation. Tool calls execute synchronously and
 * fire onToolCall. The final text response streams token-by-token via onTextDelta.
 *
 * Returns the complete text when done.
 */
export async function streamWithTools(
  config: AIProviderConfig,
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  toolDefs: ToolDefinition[],
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>,
  callbacks: {
    onToolCall?: (name: string, input: Record<string, unknown>, result: string) => void;
    onTextDelta?: (delta: string) => void;
  },
  maxSteps: number = 10
): Promise<string> {
  const STREAM_TEXT_FLUSH_MS = 16;
  const STREAM_TEXT_MAX_HOLD_MS = 40;
  const STREAM_TEXT_FORCE_FLUSH_CHARS = 64;
  const aiTools: Record<string, any> = {};
  let pendingTextDelta = "";
  let textFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTextStartedAt = 0;

  function findFlushBoundary(text: string): number {
    for (let index = text.length - 1; index >= 0; index--) {
      const char = text[index]!;
      if (char === "\n" || char === "\r") {
        return index + 1;
      }
      if (/\s/.test(char)) {
        return index + 1;
      }
      if (/[.,!?;:)\]]/.test(char)) {
        const next = text[index + 1];
        if (next === undefined || /\s/.test(next)) {
          return index + 1;
        }
      }
    }
    return 0;
  }

  function emitTextDelta(delta: string): void {
    if (!delta) {
      return;
    }
    callbacks.onTextDelta?.(delta);
  }

  function flushPendingTextDelta(force: boolean = false): void {
    if (textFlushTimer) {
      clearTimeout(textFlushTimer);
      textFlushTimer = null;
    }
    if (!pendingTextDelta) {
      return;
    }

    const boundary = findFlushBoundary(pendingTextDelta);
    if (!force) {
      if (boundary > 0 && boundary < pendingTextDelta.length) {
        emitTextDelta(pendingTextDelta.slice(0, boundary));
        pendingTextDelta = pendingTextDelta.slice(boundary);
        pendingTextStartedAt = Date.now();
        schedulePendingTextFlush();
        return;
      }

      const holdingTooLong =
        pendingTextStartedAt > 0 &&
        Date.now() - pendingTextStartedAt >= STREAM_TEXT_MAX_HOLD_MS;
      if (
        boundary === 0 &&
        !holdingTooLong &&
        pendingTextDelta.length < STREAM_TEXT_FORCE_FLUSH_CHARS
      ) {
        schedulePendingTextFlush();
        return;
      }
    }

    emitTextDelta(pendingTextDelta);
    pendingTextDelta = "";
    pendingTextStartedAt = 0;
  }

  function schedulePendingTextFlush(): void {
    if (textFlushTimer) {
      return;
    }
    textFlushTimer = setTimeout(() => {
      textFlushTimer = null;
      flushPendingTextDelta();
    }, STREAM_TEXT_FLUSH_MS);
  }

  for (const t of toolDefs) {
    aiTools[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters as any),
      execute: async (input: any) => {
        flushPendingTextDelta(true);
        const result = await executeTool(t.name, input);
        callbacks.onToolCall?.(t.name, input, result);
        return result;
      },
    } as any);
  }

  let capturedStreamError: unknown = null;
  const result = streamText({
    model: getModel(config),
    system: systemPrompt,
    messages: messages as any,
    tools: aiTools,
    stopWhen: stepCountIs(maxSteps),
    onError: ({ error }: { error: unknown }) => {
      capturedStreamError = error;
    },
  } as any);

  // Consume the fullStream to get text deltas.
  // Tool calls are handled by SDK's execute functions automatically.
  let fullText = "";
  try {
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        const delta = (part as any).text ?? "";
        if (delta) {
          fullText += delta;
          if (!pendingTextDelta) {
            pendingTextStartedAt = Date.now();
          }
          pendingTextDelta += delta;
          schedulePendingTextFlush();
        }
      }
      if (part.type === "error") {
        const streamErr = (part as any).error;
        throw streamErr instanceof Error ? streamErr : new Error(formatAIError(streamErr));
      }
    }
  } catch (err) {
    flushPendingTextDelta(true);
    if (!fullText) {
      throw err;
    }
  }

  flushPendingTextDelta(true);
  if (capturedStreamError && !fullText) {
    throw capturedStreamError;
  }
  return fullText;
}

export function formatAIError(error: unknown): string {
  const apiError = findAPICallError(error);
  if (apiError) {
    const status = apiError.statusCode;
    if (status === 429) return "Rate limited by the AI provider. Wait a moment and try again.";
    if (status === 401 || status === 403) return "Authentication failed. Check your API key.";
    if (status === 404) return "Model not found. Check your AI_MODEL setting.";
    if (status === 400) return "Bad request sent to AI provider. The prompt may be too long.";
    if (status === 503 || status === 502) return "AI provider is temporarily unavailable. Try again shortly.";
    if (status && status >= 500) return `AI provider returned server error (${status}). Try again shortly.`;
    if (status) return `AI provider returned error ${status}.`;
    return "Failed to reach the AI provider. Check your network connection.";
  }

  if (error instanceof Error) {
    if (error.message.includes("fetch failed") || error.message.includes("ECONNREFUSED")) {
      return "Failed to reach the AI provider. Check your network connection.";
    }
    const msg = error.message;
    if (msg.length > 200) return msg.slice(0, 200) + "...";
    return msg;
  }

  return "An unknown error occurred.";
}

function findAPICallError(error: unknown): APICallError | null {
  if (APICallError.isInstance(error)) return error as APICallError;
  if (RetryError.isInstance(error)) {
    const retry = error as RetryError;
    if (APICallError.isInstance(retry.lastError)) return retry.lastError as APICallError;
    for (const inner of retry.errors) {
      if (APICallError.isInstance(inner)) return inner as APICallError;
    }
  }
  if (error instanceof Error && error.cause) {
    return findAPICallError(error.cause);
  }
  return null;
}
