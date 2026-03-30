import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getChatSessionId,
  listChatSessions,
  loadChatSession,
  loadOrCreateChatSession,
  saveChatSession,
} from "../src/tui/chat-sessions.js";
import {
  COMMANDS,
  formatScopeTargets,
  getAvailableCommands,
  resolveCommand,
} from "../src/tui/commands.js";
import type { AppScope } from "../src/tui/chat-state.js";

async function withTempCwd(
  fn: (tempDir: string) => Promise<void>
): Promise<void> {
  const previous = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-cli-test-"));
  process.chdir(tempDir);
  try {
    await fn(tempDir);
  } finally {
    process.chdir(previous);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("chat architecture integration", { concurrency: false }, async (t) => {
  await t.test("persists and reopens scoped sessions", async () => {
    await withTempCwd(async () => {
      const scope: AppScope = { type: "workspace", workspacePath: "/tmp/ws-a", courseId: 17, assignmentId: 42 };
      const created = await loadOrCreateChatSession(scope, {
        title: "Lab 4",
        metadata: {
          courseId: 17,
          courseName: "ECE243",
          assignmentId: 42,
          assignmentName: "Lab 4",
        },
        initialMessages: [{ role: "assistant", content: "Workspace ready." }],
      });

      created.messages.push({ role: "user", content: "What should I do first?" });
      await saveChatSession(created);

      const reopened = await loadOrCreateChatSession(scope, {
        title: "Lab 4 updated",
        metadata: { assignmentName: "Lab 4 updated" },
      });

      assert.equal(reopened.id, getChatSessionId(scope));
      assert.equal(reopened.messages.length, 2);
      assert.equal(reopened.messages[1]?.content, "What should I do first?");
      assert.equal(reopened.title, "Lab 4 updated");
      assert.equal(reopened.metadata.assignmentName, "Lab 4 updated");

      const loaded = await loadChatSession(reopened.id);
      assert.ok(loaded);
      assert.equal(loaded?.messages.length, 2);

      const sessions = await listChatSessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.id, reopened.id);
    });
  });

  await t.test("keeps command availability scoped and aliases resolvable", async () => {
    const globalCommands = getAvailableCommands(COMMANDS, "global").map((command) => command.name);
    const courseCommands = getAvailableCommands(COMMANDS, "course").map((command) => command.name);
    const workspaceCommands = getAvailableCommands(COMMANDS, "workspace").map((command) => command.name);

    assert.ok(globalCommands.includes("/manage-courses"));
    assert.ok(!globalCommands.includes("/overview"));
    assert.ok(courseCommands.includes("/manage-courses"));
    assert.ok(courseCommands.includes("/assignments"));
    assert.ok(!courseCommands.includes("/overview"));
    assert.ok(workspaceCommands.includes("/manage-courses"));
    assert.ok(workspaceCommands.includes("/overview"));

    assert.equal(resolveCommand(COMMANDS, "/reqs")?.name, "/requirements");
    assert.match(formatScopeTargets(["workspace"]), /Open an assignment first/);
    assert.match(formatScopeTargets(["course", "workspace"]), /a course/);
  });
});
