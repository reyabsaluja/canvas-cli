import type { ChatMessage } from "./chat-state.js";

export interface CopyOptions {
  includeTools?: boolean;
  includeSystem?: boolean;
}

export function formatMessageForCopy(
  message: ChatMessage,
  options: CopyOptions = {}
): string | null {
  switch (message.role) {
    case "user":
      return message.content.trim();
    case "assistant": {
      const parts: string[] = [message.content.trim()];
      if (message.bulletPoints?.length) {
        parts.push("");
        for (const point of message.bulletPoints) parts.push(`- ${point}`);
      }
      if (message.sources?.length) {
        parts.push("");
        parts.push("Sources:");
        for (const source of message.sources) {
          const label = source.section
            ? `${source.title} — ${source.section}`
            : source.title;
          parts.push(`- [${source.kind}] ${label}`);
          const excerpt = source.excerpt?.replace(/\s+/g, " ").trim();
          if (excerpt) {
            parts.push(`  ${excerpt}`);
          }
        }
      }
      return parts.join("\n").trim();
    }
    case "tool":
      if (!options.includeTools) return null;
      return `\`\`\`\n[${message.toolAction ?? "tool"}${
        message.toolTarget ? ` ${message.toolTarget}` : ""
      }]\n${message.content}\n\`\`\``;
    case "system":
      if (!options.includeSystem) return null;
      return message.content.trim();
  }
}

export function formatLastAssistantForCopy(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "assistant") {
      return formatMessageForCopy(message);
    }
  }
  return null;
}

export function formatConversationForCopy(
  messages: ChatMessage[],
  options: CopyOptions = {}
): string {
  const blocks: string[] = [];
  for (const message of messages) {
    const body = formatMessageForCopy(message, options);
    if (!body) continue;
    const heading =
      message.role === "user"
        ? "## You"
        : message.role === "assistant"
          ? "## Assistant"
          : message.role === "tool"
            ? "## Tool"
            : "## System";
    blocks.push(`${heading}\n\n${body}`);
  }
  return blocks.join("\n\n---\n\n");
}

export function formatLastNForCopy(
  messages: ChatMessage[],
  n: number,
  options: CopyOptions = {}
): string {
  const filtered: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && filtered.length < n; i--) {
    const message = messages[i]!;
    if (message.role === "user" || message.role === "assistant") {
      filtered.unshift(message);
    }
  }
  return formatConversationForCopy(filtered, options);
}
