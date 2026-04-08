import type { ChatMessage, ChatSession } from "./chat-state.js";
import { saveChatSession } from "./chat-sessions.js";

export class ChatShellPersistence {
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private persistFailureMessage: string | null = null;

  constructor(
    private readonly session: ChatSession,
    private readonly messages: ChatMessage[]
  ) {}

  schedule(delayMs: number = 180): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush().catch(() => {});
    }, delayMs);
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.session.updatedAt = new Date().toISOString();
    this.persistChain = this.persistChain.catch(() => {}).then(async () => {
      try {
        await saveChatSession(this.session);
        this.persistFailureMessage = null;
      } catch (error) {
        this.persistFailureMessage =
          error instanceof Error ? error.message : "unknown persistence error";
        throw error;
      }
    });
    return this.persistChain;
  }

  async addMessage(message: ChatMessage): Promise<void> {
    this.messages.push(message);
    this.schedule();
  }

  async addMessages(nextMessages: ChatMessage[]): Promise<void> {
    this.messages.push(...nextMessages);
    this.schedule();
  }

  getFailureMessage(): string | null {
    return this.persistFailureMessage;
  }
}
