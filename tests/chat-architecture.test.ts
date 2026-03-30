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
import { openWorkspace, refreshWorkspace } from "../src/tui/services.js";
import { makeCourseSlug } from "../src/ingest/slug.js";
import type { Course } from "../src/domain/models.js";

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

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

  await t.test("reopens an existing workspace without Canvas calls", async () => {
    await withTempCwd(async (tempDir) => {
      const course: Course = {
        id: 17,
        name: "ECE243",
        courseCode: "ECE243H1",
        termName: "Winter 2026",
        isCurrent: true,
      };
      const workspacePath = path.join(
        tempDir,
        ".canvas-cli",
        "sessions",
        "ece243h1-lab-4-42"
      );
      await fs.mkdir(workspacePath, { recursive: true });
      await writeJson(path.join(workspacePath, "session.json"), {
        version: 1,
        createdAt: "2026-03-29T10:00:00.000Z",
        updatedAt: "2026-03-29T10:05:00.000Z",
        sessionSlug: "ece243h1-lab-4-42",
        workspacePath,
        assignmentId: 42,
        assignmentName: "Lab 4",
        courseId: 17,
        courseName: "ECE243",
        courseCode: "ECE243H1",
        preparedAt: "2026-03-29T10:05:00.000Z",
        workspaceState: "ready",
        lastError: null,
      });
      await writeJson(path.join(workspacePath, "workup.json"), {
        overview: "Existing overview",
      });
      await fs.writeFile(
        path.join(workspacePath, "assignment.md"),
        "# Lab 4\n",
        "utf-8"
      );
      await fs.writeFile(
        path.join(workspacePath, "plan.md"),
        "# Plan\n",
        "utf-8"
      );

      let assignmentCalls = 0;
      let detailCalls = 0;
      const services = {
        client: {
          async getAssignments() {
            assignmentCalls += 1;
            throw new Error("network should not be used for existing workspace");
          },
          async getAssignmentDetail() {
            detailCalls += 1;
            throw new Error("network should not be used for existing workspace");
          },
        },
        config: {} as never,
        aiConfig: null,
        rawCourses: [],
        allCourses: [course],
        courseConfig: null,
      } as any;

      const progress: string[] = [];
      const result = await openWorkspace(
        services,
        course,
        { id: 42, name: "Lab 4" },
        (stage) => {
          progress.push(stage);
        }
      );

      assert.equal(result.workspacePath, workspacePath);
      assert.equal(result.loaded.assignmentName, "Lab 4");
      assert.equal(result.lifecycleState, "ready");
      assert.equal(assignmentCalls, 0);
      assert.equal(detailCalls, 0);
      assert.deepEqual(progress, ["checking existing workspaces", "loading workspace"]);
    });
  });

  await t.test("missing workspace still falls back to Canvas resolution for creation", async () => {
    await withTempCwd(async (tempDir) => {
      const course: Course = {
        id: 17,
        name: "ECE243",
        courseCode: "ECE243H1",
        termName: "Winter 2026",
        isCurrent: true,
      };
      const courseSlug = makeCourseSlug(course.courseCode, course.id);
      const coursePath = path.join(tempDir, ".canvas-cli", "courses", courseSlug);
      await writeJson(path.join(coursePath, "ingestion.json"), {
        ingestedAt: "2026-03-29T10:00:00.000Z",
      });
      await writeJson(path.join(coursePath, "assignments.json"), []);
      await writeJson(path.join(coursePath, "modules.json"), []);
      await writeJson(path.join(coursePath, "files.json"), []);
      await writeJson(path.join(coursePath, "pages.json"), []);
      await writeJson(path.join(coursePath, "syllabus-candidates.json"), []);
      await writeJson(path.join(coursePath, "attachments.json"), []);

      let assignmentCalls = 0;
      let detailCalls = 0;
      const services = {
        client: {
          async getAssignments() {
            assignmentCalls += 1;
            return [
              {
                id: 42,
                name: "Lab 4",
                course_id: course.id,
                due_at: null,
                has_submitted_submissions: false,
                html_url: "https://canvas.example/lab-4",
              },
            ];
          },
          async getAssignmentDetail() {
            detailCalls += 1;
            return {
              id: 42,
              name: "Lab 4",
              course_id: course.id,
              due_at: null,
              has_submitted_submissions: false,
              html_url: "https://canvas.example/lab-4",
              description: null,
              unlock_at: null,
              lock_at: null,
              points_possible: null,
              grading_type: "points",
              submission_types: [],
              allowed_extensions: null,
              submitted_at: null,
              score: null,
              grade: null,
              late: false,
              missing: false,
              attachments: [],
            };
          },
          async getCourseDetail() {
            return {
              id: course.id,
              name: course.name,
              course_code: course.courseCode,
              syllabus_body: null,
              term: null,
            };
          },
          async getModulesSafe() {
            return [];
          },
          async getFilesSafe() {
            return [];
          },
          async getPagesSafe() {
            return [];
          },
          async getFrontPageSafe() {
            return null;
          },
          async getPageBySlugSafe() {
            return null;
          },
          async downloadFile() {
            return null;
          },
        },
        config: {} as never,
        aiConfig: null,
        rawCourses: [],
        allCourses: [course],
        courseConfig: null,
      } as any;

      await assert.rejects(
        openWorkspace(services, course, { id: null, name: "Lab 4" }, () => {}),
        /ANTHROPIC_API_KEY not set/
      );
      assert.equal(assignmentCalls, 1);
      assert.equal(detailCalls, 1);
    });
  });

  await t.test("creation path skips assignment listing when assignment id is already known", async () => {
    await withTempCwd(async (tempDir) => {
      const course: Course = {
        id: 17,
        name: "ECE243",
        courseCode: "ECE243H1",
        termName: "Winter 2026",
        isCurrent: true,
      };
      const courseSlug = makeCourseSlug(course.courseCode, course.id);
      const coursePath = path.join(tempDir, ".canvas-cli", "courses", courseSlug);
      await writeJson(path.join(coursePath, "ingestion.json"), {
        ingestedAt: "2026-03-29T10:00:00.000Z",
      });
      await writeJson(path.join(coursePath, "assignments.json"), []);
      await writeJson(path.join(coursePath, "modules.json"), []);
      await writeJson(path.join(coursePath, "files.json"), []);
      await writeJson(path.join(coursePath, "pages.json"), []);
      await writeJson(path.join(coursePath, "syllabus-candidates.json"), []);
      await writeJson(path.join(coursePath, "attachments.json"), []);

      let assignmentCalls = 0;
      let detailCalls = 0;
      const services = {
        client: {
          async getAssignments() {
            assignmentCalls += 1;
            throw new Error("assignment listing should not be used when id is known");
          },
          async getAssignmentDetail() {
            detailCalls += 1;
            return {
              id: 42,
              name: "Lab 4",
              course_id: course.id,
              due_at: null,
              has_submitted_submissions: false,
              html_url: "https://canvas.example/lab-4",
              description: null,
              unlock_at: null,
              lock_at: null,
              points_possible: null,
              grading_type: "points",
              submission_types: [],
              allowed_extensions: null,
              submitted_at: null,
              score: null,
              grade: null,
              late: false,
              missing: false,
              attachments: [],
            };
          },
          async getCourseDetail() {
            return {
              id: course.id,
              name: course.name,
              course_code: course.courseCode,
              syllabus_body: null,
              term: null,
            };
          },
          async getModulesSafe() {
            return [];
          },
          async getFilesSafe() {
            return [];
          },
          async getPagesSafe() {
            return [];
          },
          async getFrontPageSafe() {
            return null;
          },
          async getPageBySlugSafe() {
            return null;
          },
          async downloadFile() {
            return null;
          },
        },
        config: {} as never,
        aiConfig: null,
        rawCourses: [],
        allCourses: [course],
        courseConfig: null,
      } as any;

      await assert.rejects(
        openWorkspace(services, course, { id: 42, name: "Lab 4" }, () => {}),
        /ANTHROPIC_API_KEY not set/
      );
      assert.equal(assignmentCalls, 0);
      assert.equal(detailCalls, 1);
    });
  });

  await t.test("refresh still uses Canvas-backed resolution", async () => {
    await withTempCwd(async (tempDir) => {
      const course: Course = {
        id: 17,
        name: "ECE243",
        courseCode: "ECE243H1",
        termName: "Winter 2026",
        isCurrent: true,
      };
      const workspacePath = path.join(
        tempDir,
        ".canvas-cli",
        "sessions",
        "ece243h1-lab-4-42"
      );
      await fs.mkdir(workspacePath, { recursive: true });
      await writeJson(path.join(workspacePath, "session.json"), {
        version: 1,
        createdAt: "2026-03-29T10:00:00.000Z",
        updatedAt: "2026-03-29T10:05:00.000Z",
        sessionSlug: "ece243h1-lab-4-42",
        workspacePath,
        assignmentId: 42,
        assignmentName: "Lab 4",
        courseId: 17,
        courseName: "ECE243",
        courseCode: "ECE243H1",
        preparedAt: "2026-03-29T10:05:00.000Z",
        workspaceState: "ready",
        lastError: null,
      });

      const courseSlug = makeCourseSlug(course.courseCode, course.id);
      const coursePath = path.join(tempDir, ".canvas-cli", "courses", courseSlug);
      await writeJson(path.join(coursePath, "ingestion.json"), {
        ingestedAt: "2026-03-29T10:00:00.000Z",
      });
      await writeJson(path.join(coursePath, "assignments.json"), []);
      await writeJson(path.join(coursePath, "modules.json"), []);
      await writeJson(path.join(coursePath, "files.json"), []);
      await writeJson(path.join(coursePath, "pages.json"), []);
      await writeJson(path.join(coursePath, "syllabus-candidates.json"), []);
      await writeJson(path.join(coursePath, "attachments.json"), []);

      let assignmentCalls = 0;
      let detailCalls = 0;
      const services = {
        client: {
          async getAssignments() {
            assignmentCalls += 1;
            return [
              {
                id: 42,
                name: "Lab 4",
                course_id: course.id,
                due_at: null,
                has_submitted_submissions: false,
                html_url: "https://canvas.example/lab-4",
              },
            ];
          },
          async getAssignmentDetail() {
            detailCalls += 1;
            return {
              id: 42,
              name: "Lab 4",
              course_id: course.id,
              due_at: null,
              has_submitted_submissions: false,
              html_url: "https://canvas.example/lab-4",
              description: null,
              unlock_at: null,
              lock_at: null,
              points_possible: null,
              grading_type: "points",
              submission_types: [],
              allowed_extensions: null,
              submitted_at: null,
              score: null,
              grade: null,
              late: false,
              missing: false,
              attachments: [],
            };
          },
          async getCourseDetail() {
            return {
              id: course.id,
              name: course.name,
              course_code: course.courseCode,
              syllabus_body: null,
              term: null,
            };
          },
          async getModulesSafe() {
            return [];
          },
          async getFilesSafe() {
            return [];
          },
          async getPagesSafe() {
            return [];
          },
          async getFrontPageSafe() {
            return null;
          },
          async getPageBySlugSafe() {
            return null;
          },
          async downloadFile() {
            return null;
          },
        },
        config: {} as never,
        aiConfig: null,
        rawCourses: [],
        allCourses: [course],
        courseConfig: null,
      } as any;

      await assert.rejects(
        refreshWorkspace(services, course, { id: 42, name: "Lab 4" }, () => {}),
        /ANTHROPIC_API_KEY not set/
      );
      assert.ok(
        assignmentCalls >= 1,
        `expected refresh to hit Canvas assignments, saw ${assignmentCalls} calls`
      );
      assert.equal(detailCalls, 1);
    });
  });
});
