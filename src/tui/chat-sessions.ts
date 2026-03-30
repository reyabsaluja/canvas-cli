import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type {
  AppScope,
  ChatSession,
  ChatSessionMetadata,
  ChatSessionSummary,
} from "./chat-state.js";

const CHAT_SESSIONS_DIR = ".canvas-cli/chat-sessions";
const CHAT_SESSIONS_INDEX = "index.json";

function getChatSessionsRoot(): string {
  return path.resolve(process.cwd(), CHAT_SESSIONS_DIR);
}

function getChatSessionPath(sessionId: string): string {
  return path.join(getChatSessionsRoot(), `${sessionId}.json`);
}

function getChatSessionIndexPath(): string {
  return path.join(getChatSessionsRoot(), CHAT_SESSIONS_INDEX);
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
  await writeAtomic(filePath, JSON.stringify(session, null, 2) + "\n");
  await upsertChatSessionSummary(toChatSessionSummary(session));
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

export async function listChatSessions(): Promise<ChatSessionSummary[]> {
  const indexed = await loadChatSessionIndex();
  if (indexed) {
    return indexed;
  }
  return rebuildChatSessionIndex();
}

async function loadChatSessionIndex(): Promise<ChatSessionSummary[] | null> {
  try {
    const raw = await fs.readFile(getChatSessionIndexPath(), "utf-8");
    const parsed = JSON.parse(raw) as { sessions?: ChatSessionSummary[] };
    if (!parsed || !Array.isArray(parsed.sessions)) {
      return null;
    }
    return parsed.sessions
      .slice()
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
  } catch {
    return null;
  }
}

async function rebuildChatSessionIndex(): Promise<ChatSessionSummary[]> {
  const root = getChatSessionsRoot();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const sessions: ChatSessionSummary[] = [];
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".json") ||
        entry.name === CHAT_SESSIONS_INDEX
      ) {
        continue;
      }
      const loaded = await loadChatSession(entry.name.replace(/\.json$/, ""));
      if (loaded) {
        sessions.push(toChatSessionSummary(loaded));
      }
    }
    await saveChatSessionIndex(sessions);
    return sessions;
  } catch {
    return [];
  }
}

async function upsertChatSessionSummary(
  summary: ChatSessionSummary
): Promise<void> {
  const current = (await loadChatSessionIndex()) ?? [];
  const next = current.filter((entry) => entry.id !== summary.id);
  next.push(summary);
  next.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  await saveChatSessionIndex(next);
}

async function saveChatSessionIndex(
  sessions: ChatSessionSummary[]
): Promise<void> {
  const filePath = getChatSessionIndexPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeAtomic(
    filePath,
    JSON.stringify({ version: 1, sessions }, null, 2) + "\n"
  );
}

function toChatSessionSummary(session: ChatSession): ChatSessionSummary {
  return {
    version: session.version,
    id: session.id,
    title: session.title,
    scope: session.scope,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastOpenedAt: session.lastOpenedAt,
    metadata: session.metadata,
  };
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, "utf-8");
    await fs.rename(tmpPath, filePath);
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}
