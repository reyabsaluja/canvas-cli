import { generateText, streamText, tool, jsonSchema, stepCountIs } from "ai";
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
  const aiTools: Record<string, any> = {};
  for (const t of toolDefs) {
    aiTools[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters as any),
      execute: async (input: any) => {
        const result = await executeTool(t.name, input);
        callbacks.onToolCall?.(t.name, input, result);
        return result;
      },
    } as any);
  }

  const result = streamText({
    model: getModel(config),
    system: systemPrompt,
    messages: messages as any,
    tools: aiTools,
    stopWhen: stepCountIs(maxSteps),
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
          callbacks.onTextDelta?.(delta);
        }
      }
      // "error" parts indicate stream-level errors
      if (part.type === "error") {
        console.error("Stream error:", (part as any).error);
      }
    }
  } catch (err) {
    // If streaming fails partway, return whatever text we got
    if (!fullText) {
      throw err;
    }
  }

  return fullText;
}
