export type AIProviderName = "anthropic" | "openai" | "google" | "bedrock" | "copilot" | "codex";

/**
 * Canonical provider name for an AI_PROVIDER value or stored aiProvider:
 * case-insensitive, with the accepted aliases (gemini, aws-bedrock,
 * github-copilot, chatgpt, ...). Null for anything unrecognized.
 */
export function normalizeAIProvider(value: string | undefined): AIProviderName | null {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "anthropic":
      return "anthropic";
    case "openai":
      return "openai";
    case "google":
    case "gemini":
      return "google";
    case "bedrock":
    case "aws-bedrock":
    case "amazon-bedrock":
      return "bedrock";
    case "copilot":
    case "github-copilot":
      return "copilot";
    case "codex":
    case "chatgpt":
    case "openai-codex":
      return "codex";
    default:
      return null;
  }
}
