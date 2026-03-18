import Anthropic from "@anthropic-ai/sdk";

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
