import fs from "node:fs/promises";
import path from "node:path";
import type { AppScope, ChatSession, ChatSessionMetadata } from "./chat-state.js";

const CHAT_SESSIONS_DIR = ".canvas-cli/chat-sessions";

function getChatSessionsRoot(): string {
  return path.resolve(process.cwd(), CHAT_SESSIONS_DIR);
}

function getChatSessionPath(sessionId: string): string {
  return path.join(getChatSessionsRoot(), `${sessionId}.json`);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function getChatSessionId(scope: AppScope): string {
  switch (scope.type) {
    case "global":
      return "global-home";
    case "course":
      return `course-${scope.courseId}`;
    case "workspace":
      return `workspace-${slugify(path.basename(scope.workspacePath))}`;
  }
}

export async function loadChatSession(sessionId: string): Promise<ChatSession | null> {
  try {
    const raw = await fs.readFile(getChatSessionPath(sessionId), "utf-8");
    const parsed = JSON.parse(raw) as ChatSession;
    if (!parsed || !Array.isArray(parsed.messages)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveChatSession(session: ChatSession): Promise<void> {
  const filePath = getChatSessionPath(session.id);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(session, null, 2) + "\n", "utf-8");
}

export async function loadOrCreateChatSession(
  scope: AppScope,
  options: {
    title: string;
    metadata?: ChatSessionMetadata;
    initialMessages?: ChatSession["messages"];
  }
): Promise<ChatSession> {
  const id = getChatSessionId(scope);
  const now = new Date().toISOString();
  const existing = await loadChatSession(id);

  if (existing) {
    const next: ChatSession = {
      ...existing,
      title: options.title || existing.title,
      scope,
      updatedAt: now,
      lastOpenedAt: now,
      metadata: {
        ...existing.metadata,
        ...options.metadata,
        lastOpenedAt: now,
      },
    };
    await saveChatSession(next);
    return next;
  }

  const created: ChatSession = {
    version: 1,
    id,
    title: options.title,
    scope,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    messages: options.initialMessages ?? [],
    metadata: {
      ...(options.metadata ?? {}),
      lastOpenedAt: now,
    },
  };
  await saveChatSession(created);
  return created;
}

export async function touchChatSession(
  session: ChatSession,
  updates?: Partial<Pick<ChatSession, "title" | "scope">> & {
    metadata?: Partial<ChatSessionMetadata>;
  }
): Promise<ChatSession> {
  const now = new Date().toISOString();
  const next: ChatSession = {
    ...session,
    ...updates,
    updatedAt: now,
    lastOpenedAt: now,
    metadata: {
      ...session.metadata,
      ...(updates?.metadata ?? {}),
      lastOpenedAt: now,
    },
  };
  await saveChatSession(next);
  return next;
}

export async function listChatSessions(): Promise<ChatSession[]> {
  const root = getChatSessionsRoot();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const sessions: ChatSession[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const loaded = await loadChatSession(entry.name.replace(/\.json$/, ""));
      if (loaded) sessions.push(loaded);
    }
    sessions.sort((a, b) => {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    return sessions;
  } catch {
    return [];
  }
}
