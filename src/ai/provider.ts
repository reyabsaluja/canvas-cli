import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  Tool,
  ContentBlock,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";

export interface AIProviderConfig {
  apiKey: string;
}

/**
 * Check if an AI provider API key is configured.
 * Returns the key or null if not set.
 */
export function getAIConfig(): AIProviderConfig | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return { apiKey };
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
  const client = new Anthropic({ apiKey: config.apiKey });

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from model");
  }
  return textBlock.text;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolCallResponse {
  stopReason: "end_turn" | "tool_use" | "max_tokens" | string;
  textContent: string | null;
  toolCalls: ToolCallRequest[];
  rawContent: ContentBlock[];
}

/**
 * Call the AI model with tool definitions, supporting multi-turn tool use.
 * Returns the model's response including any tool calls.
 */
export async function callModelWithTools(
  config: AIProviderConfig,
  systemPrompt: string,
  messages: MessageParam[],
  tools: Tool[],
  maxTokens: number = 4096
): Promise<ToolCallResponse> {
  const client = new Anthropic({ apiKey: config.apiKey });

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
    tools,
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const toolCalls: ToolCallRequest[] = response.content
    .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      name: b.name,
      input: b.input as Record<string, unknown>,
    }));

  return {
    stopReason: response.stop_reason ?? "end_turn",
    textContent: textBlock && textBlock.type === "text" ? textBlock.text : null,
    toolCalls,
    rawContent: response.content,
  };
}

/**
 * Build a tool_result message from executed tool results.
 */
export function buildToolResultMessage(
  results: Array<{ toolCallId: string; content: string; isError?: boolean }>
): MessageParam {
  return {
    role: "user",
    content: results.map(
      (r): ToolResultBlockParam => ({
        type: "tool_result",
        tool_use_id: r.toolCallId,
        content: r.content,
        is_error: r.isError,
      })
    ),
  };
}
