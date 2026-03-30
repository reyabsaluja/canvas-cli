import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceLifecycleState } from "../tui/chat-state.js";

export interface SessionMeta {
  version: 1;
  createdAt: string;
  updatedAt: string;
  sessionSlug: string;
  workspacePath: string;
  assignmentId: number;
  assignmentName: string;
  courseId: number;
  courseName: string;
  courseCode: string;
  preparedAt?: string;
  lastOpenedAt?: string;
  workspaceState?: WorkspaceLifecycleState;
  lastError?: string | null;
}

export async function loadWorkspaceSessionMeta(
  workspacePath: string
): Promise<SessionMeta | null> {
  try {
    const raw = await fs.readFile(getWorkspaceSessionPath(workspacePath), "utf-8");
    return JSON.parse(raw) as SessionMeta;
  } catch {
    return null;
  }
}

export async function saveWorkspaceSessionMeta(
  workspacePath: string,
  session: SessionMeta
): Promise<void> {
  await fs.writeFile(
    getWorkspaceSessionPath(workspacePath),
    JSON.stringify(session, null, 2) + "\n",
    "utf-8"
  );
}

export async function updateWorkspaceSessionMeta(
  workspacePath: string,
  update: (current: SessionMeta) => SessionMeta | null
): Promise<SessionMeta | null> {
  const existing = await loadWorkspaceSessionMeta(workspacePath);
  if (!existing) return null;
  const next = update(existing);
  if (!next) return existing;
  await saveWorkspaceSessionMeta(workspacePath, next);
  return next;
}

function getWorkspaceSessionPath(workspacePath: string): string {
  return path.join(workspacePath, "session.json");
}
