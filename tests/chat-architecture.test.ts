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
import { handleCommand } from "../src/tui/app-commands.js";
import type { AppScope } from "../src/tui/chat-state.js";
import {
  createChatContext,
  fetchAssignments,
  getCourseById,
  getDisplayCourseAvailability,
  hydrateConversationHistory,
  invalidateAssignmentCache,
  getWorkspaceLifecycleState,
  openWorkspace,
  refreshWorkspace,
} from "../src/tui/services.js";
import { createShellContext } from "../src/tui/app-runtime.js";
import { buildRecentSessionPickerItems } from "../src/tui/app-navigation.js";
import { makeCourseSlug } from "../src/ingest/slug.js";
import type { Course } from "../src/domain/models.js";
import { loadWorkspaceSessionMeta } from "../src/workspace/session.js";
import {
  loadWorkspace,
  readWorkspaceExtractedFile,
} from "../src/ask/load-workspace.js";
import { listWorkspaces } from "../src/ask/resolve-workspace.js";
import {
  createWorkspace,
  createWorkWorkspace,
} from "../src/workspace/create.js";
import {
  readCourseDocumentFromIndex,
  searchCourseIndex,
} from "../src/tui/course-retrieval.js";
import { buildContextBundle } from "../src/ai/context-bundle.js";
import { resolveWorkspacePinContent } from "../src/tui/app-workspace-content.js";

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
  await t.test("filters unavailable configured courses out of active scope", async () => {
    const liveCourse: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };

    const services = {
      allCourses: [liveCourse],
      courseConfig: {
        courses: [
          {
            id: 17,
            displayName: "Computer Organization",
            originalCode: "ECE243H1",
            originalName: "ECE243",
          },
          {
            id: 99,
            displayName: "Dead Course",
            originalCode: "CSC999H1",
            originalName: "Ghost Course",
          },
        ],
      },
    } as any;

    const availability = getDisplayCourseAvailability(services);

    assert.equal(availability.available.length, 1);
    assert.equal(availability.available[0]?.id, 17);
    assert.equal(availability.available[0]?.name, "Computer Organization");
    assert.equal(availability.unavailable.length, 1);
    assert.equal(availability.unavailable[0]?.id, 99);
    assert.equal(getCourseById(services, 17)?.name, "Computer Organization");
    assert.equal(getCourseById(services, 99), null);
  });

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

  await t.test("chat session saves do not leave temp files behind", async () => {
    await withTempCwd(async (tempDir) => {
      const scope: AppScope = { type: "global" };
      const session = await loadOrCreateChatSession(scope, {
        title: "Global",
        initialMessages: [{ role: "assistant", content: "Ready." }],
      });

      session.messages.push({ role: "user", content: "hello" });
      await saveChatSession(session);

      const sessionsDir = path.join(tempDir, ".canvas-cli", "chat-sessions");
      const entries = await fs.readdir(sessionsDir);
      assert.ok(entries.includes("global-home.json"));
      assert.equal(entries.some((entry) => entry.endsWith(".tmp")), false);
    });
  });

  await t.test("session listing uses metadata index instead of reparsing full transcripts", async () => {
    await withTempCwd(async (tempDir) => {
      const scope: AppScope = {
        type: "workspace",
        workspacePath: "/tmp/ws-a",
        courseId: 17,
        assignmentId: 42,
      };
      const session = await loadOrCreateChatSession(scope, {
        title: "Lab 4",
        metadata: {
          courseId: 17,
          courseName: "ECE243",
          assignmentId: 42,
          assignmentName: "Lab 4",
        },
        initialMessages: [{ role: "assistant", content: "Workspace ready." }],
      });
      session.messages.push({
        role: "assistant",
        content: "A".repeat(20000),
      });
      await saveChatSession(session);

      const sessionPath = path.join(
        tempDir,
        ".canvas-cli",
        "chat-sessions",
        `${session.id}.json`
      );
      await fs.writeFile(sessionPath, "{ broken json", "utf-8");

      const listed = await listChatSessions();
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.id, session.id);
      assert.equal(listed[0]?.title, "Lab 4");
      assert.equal(await loadChatSession(session.id), null);
    });
  });

  await t.test("recent session picker items include the full filtered session set", async () => {
    const sessions = Array.from({ length: 25 }, (_, index) => ({
      version: 1 as const,
      id: `workspace-${index + 1}`,
      title: `Workspace ${index + 1}`,
      scope: {
        type: "workspace" as const,
        workspacePath: `/tmp/ws-${index + 1}`,
        courseId: 17,
        assignmentId: index + 1,
      },
      createdAt: "2026-03-29T10:00:00.000Z",
      updatedAt: "2026-03-29T10:00:00.000Z",
      lastOpenedAt: "2026-03-29T10:00:00.000Z",
      metadata: {
        courseName: "ECE243",
      },
    }));

    const items = buildRecentSessionPickerItems(sessions);

    assert.equal(items.length, 25);
    assert.equal(items[24]?.value, "workspace-25");
    assert.match(items[24]?.label ?? "", /Workspace 25/);
  });

  await t.test("listWorkspaces returns workspaces sorted by most recent update", async () => {
    await withTempCwd(async (tempDir) => {
      const sessionsRoot = path.join(tempDir, ".canvas-cli", "sessions");
      const olderPath = path.join(sessionsRoot, "ece243h1-lab-3-41");
      const newerPath = path.join(sessionsRoot, "ece243h1-lab-4-42");
      await fs.mkdir(olderPath, { recursive: true });
      await fs.mkdir(newerPath, { recursive: true });

      await writeJson(path.join(olderPath, "session.json"), {
        version: 1,
        createdAt: "2026-03-29T09:00:00.000Z",
        updatedAt: "2026-03-29T09:30:00.000Z",
        sessionSlug: "ece243h1-lab-3-41",
        workspacePath: olderPath,
        assignmentId: 41,
        assignmentName: "Lab 3",
        courseId: 17,
        courseName: "ECE243",
      });

      await writeJson(path.join(newerPath, "session.json"), {
        version: 1,
        createdAt: "2026-03-29T09:00:00.000Z",
        updatedAt: "2026-03-29T10:30:00.000Z",
        sessionSlug: "ece243h1-lab-4-42",
        workspacePath: newerPath,
        assignmentId: 42,
        assignmentName: "Lab 4",
        courseId: 17,
        courseName: "ECE243",
      });

      const workspaces = await listWorkspaces();

      assert.equal(workspaces.length, 2);
      assert.equal(workspaces[0]?.name, "Lab 4");
      assert.equal(workspaces[1]?.name, "Lab 3");
    });
  });

  await t.test("workspace base and work flows share one writer and metadata contract", async () => {
    await withTempCwd(async (tempDir) => {
      const course: Course = {
        id: 17,
        name: "ECE243",
        courseCode: "ECE243H1",
        termName: "Winter 2026",
        isCurrent: true,
      };
      const detail = {
        id: 42,
        name: "Lab 4",
        courseId: course.id,
        courseName: course.name,
        dueAt: null,
        unlockAt: null,
        lockAt: null,
        submitted: false,
        submittedAt: null,
        score: null,
        grade: null,
        late: false,
        missing: false,
        status: "upcoming",
        pointsPossible: null,
        gradingType: "points",
        submissionTypes: [],
        allowedExtensions: null,
        htmlUrl: "https://canvas.example/lab-4",
        description: null,
        attachments: [],
      };

      const baseResult = await createWorkspace(detail as any, course, {
        accessToken: "token",
      } as any);

      const workup = {
        overview: "Complete lab 4.",
        deliverables: ["report"],
        constraints: ["submit pdf"],
        relevantResources: [],
        recommendedReadOrder: [],
        actionPlan: [{ step: 1, action: "Read the brief", detail: null }],
        uncertainties: [],
        dueDate: null,
        confidence: "medium",
        sourceTrace: [],
      } as const;
      const state = {
        assignmentName: "Lab 4",
        courseName: course.name,
        visitedSources: [],
        extractedTexts: new Map([["lab-spec", "Important extracted text"]]),
        evidenceNotes: [],
        toolCallCount: 0,
      };

      const workResult = await createWorkWorkspace(
        detail as any,
        course,
        workup as any,
        state,
        {
          accessToken: "token",
        } as any
      );

      assert.equal(workResult.workspacePath, baseResult.workspacePath);
      const workspacePath = path.join(
        tempDir,
        ".canvas-cli",
        "sessions",
        "ece243h1-lab-4-42"
      );
      const meta = await loadWorkspaceSessionMeta(workspacePath);
      assert.ok(meta);
      assert.equal(meta?.assignmentId, 42);
      assert.equal(meta?.courseId, 17);
      assert.equal(meta?.workspaceState, "ready");

      const planMd = await fs.readFile(path.join(workspacePath, "plan.md"), "utf-8");
      assert.match(planMd, /Read the brief/);
      const extracted = await fs.readFile(
        path.join(workspacePath, "extracted", "lab-spec.txt"),
        "utf-8"
      );
      assert.equal(extracted, "Important extracted text");
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

  await t.test("workspace chat context helpers preserve conversation history shape", async () => {
    const loaded = {
      assignmentName: "Lab 4",
      courseName: "ECE243",
      extractedFiles: [],
      workupJson: null,
    } as any;

    const context = createChatContext(
      { provider: "anthropic", model: "test-model", apiKey: "test" } as any,
      loaded,
      {
        cache: null,
        client: null,
        config: null,
        courseId: 17,
      }
    );

    hydrateConversationHistory(context, [
      { role: "system", content: "ignore me" },
      { role: "user", content: "What is due?" },
      { role: "assistant", content: "Lab 4 is due soon." },
      { role: "tool", content: "also ignore me" },
    ]);

    assert.equal(context.loaded, loaded);
    assert.equal(context.courseId, 17);
    assert.deepEqual(context.conversationHistory, [
      { role: "user", content: "What is due?" },
      { role: "assistant", content: "Lab 4 is due soon." },
    ]);
  });

  await t.test("course shell context renders before background hydration completes", async () => {
    await withTempCwd(async () => {
      const course: Course = {
        id: 17,
        name: "ECE243",
        courseCode: "ECE243H1",
        termName: "Winter 2026",
        isCurrent: true,
      };

      let resolveAssignments: ((value: any[]) => void) | null = null;
      let assignmentCalls = 0;
      const assignmentsPromise = new Promise<any[]>((resolve) => {
        resolveAssignments = resolve;
      });

      const services = {
        client: {
          async getAssignments() {
            assignmentCalls += 1;
            return assignmentsPromise;
          },
        },
        config: {} as never,
        aiConfig: null,
        rawCourses: [],
        allCourses: [course],
        courseConfig: null,
        assignmentCache: new Map(),
      } as any;

      const shellContext = await Promise.race([
        createShellContext(services, { type: "course", courseId: course.id }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("course shell context blocked on hydration")),
            100
          )
        ),
      ]);

      assert.equal(shellContext.runtime.statusLabel, "Status: loading course data");
      assert.equal(
        assignmentCalls,
        0,
        "course shell creation should not fetch assignments before first render"
      );

      const api = {
        addMessage: async (message: (typeof shellContext.session.messages)[number]) => {
          shellContext.session.messages.push(message);
        },
        addMessages: async (
          messages: Array<(typeof shellContext.session.messages)[number]>
        ) => {
          shellContext.session.messages.push(...messages);
        },
        render: () => {},
        session: shellContext.session,
        runtime: shellContext.runtime,
      };

      const hydrationPromise = shellContext.onReady?.(api);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(assignmentCalls, 1);

      resolveAssignments?.([
        {
          id: 42,
          name: "Lab 4",
          course_id: course.id,
          due_at: null,
          has_submitted_submissions: false,
          html_url: "https://canvas.example/lab-4",
        },
      ]);
      await hydrationPromise;

      assert.equal(shellContext.runtime.statusLabel, "Status: assignments ready");
      assert.equal(shellContext.session.messages.length, 2);
      assert.match(shellContext.session.messages[1]?.content ?? "", /Upcoming work/);
      assert.match(shellContext.session.messages[1]?.content ?? "", /Lab 4/);
    });
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
        assignmentCache: new Map(),
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
        assignmentCache: new Map(),
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
        assignmentCache: new Map(),
      } as any;

      await assert.rejects(
        openWorkspace(services, course, { id: 42, name: "Lab 4" }, () => {}),
        /ANTHROPIC_API_KEY not set/
      );
      assert.equal(assignmentCalls, 0);
      assert.equal(detailCalls, 1);
    });
  });

  await t.test("assignment lists are cached for the shell lifetime and reused by openWorkspace", async () => {
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
        assignmentCache: new Map(),
      } as any;

      const first = await fetchAssignments(services, course.id, course.name);
      const second = await fetchAssignments(services, course.id, course.name);
      assert.equal(first.length, 1);
      assert.equal(second.length, 1);
      assert.equal(assignmentCalls, 1);

      await assert.rejects(
        openWorkspace(services, course, { id: null, name: "Lab 4" }, () => {}),
        /ANTHROPIC_API_KEY not set/
      );
      assert.equal(
        assignmentCalls,
        1,
        "openWorkspace should reuse cached assignments instead of refetching them"
      );
      assert.equal(detailCalls, 1);
    });
  });

  await t.test("failed assignment fetches do not poison the cache", async () => {
    const course: Course = {
      id: 17,
      name: "ECE243",
      courseCode: "ECE243H1",
      termName: "Winter 2026",
      isCurrent: true,
    };
    let calls = 0;
    const services = {
      client: {
        async getAssignments() {
          calls += 1;
          if (calls === 1) {
            throw new Error("temporary Canvas failure");
          }
          return [];
        },
      },
      assignmentCache: new Map(),
    } as any;

    await assert.rejects(
      fetchAssignments(services, course.id, course.name),
      /temporary Canvas failure/
    );
    assert.equal(services.assignmentCache.size, 0);

    const assignments = await fetchAssignments(services, course.id, course.name);
    assert.deepEqual(assignments, []);
    assert.equal(calls, 2);

    invalidateAssignmentCache(services, course.id);
    assert.equal(services.assignmentCache.size, 0);
  });

  await t.test("create failure persists workspace error state", async () => {
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

      const workspacePath = path.join(
        tempDir,
        ".canvas-cli",
        "sessions",
        "ece243h1-lab-4-42"
      );
      const services = {
        client: {
          async getAssignments() {
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
        },
        config: {} as never,
        aiConfig: null,
        rawCourses: [],
        allCourses: [course],
        courseConfig: null,
        assignmentCache: new Map(),
      } as any;

      await assert.rejects(
        openWorkspace(services, course, { id: 42, name: "Lab 4" }, () => {}),
        /ANTHROPIC_API_KEY not set/
      );

      const meta = await loadWorkspaceSessionMeta(workspacePath);
      assert.ok(meta);
      assert.equal(meta?.workspaceState, "error");
      assert.match(meta?.lastError ?? "", /ANTHROPIC_API_KEY not set/);
      assert.equal(meta?.preparedAt, undefined);
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
        assignmentCache: new Map(),
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

  await t.test("refresh failure persists workspace error state", async () => {
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

      const services = {
        client: {
          async getAssignments() {
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
        assignmentCache: new Map(),
      } as any;

      let caught: Error | null = null;
      try {
        await refreshWorkspace(
          services,
          course,
          { id: 42, name: "Lab 4" },
          () => {}
        );
      } catch (error) {
        caught = error instanceof Error ? error : new Error(String(error));
      }
      assert.ok(caught);
      assert.match(caught.message, /ANTHROPIC_API_KEY not set/);

      const meta = await loadWorkspaceSessionMeta(workspacePath);
      assert.ok(meta);
      assert.equal(meta?.workspaceState, "error");
      assert.match(meta?.lastError ?? "", /ANTHROPIC_API_KEY not set/);
      assert.equal(meta?.preparedAt, "2026-03-29T10:05:00.000Z");
    });
  });

  await t.test("explicit error state is not masked as stale", async () => {
    const lifecycle = getWorkspaceLifecycleState(
      "2026-03-29T10:00:00.000Z",
      "error",
      {
        courseId: 17,
        coursePath: "/tmp/course",
        assignments: [],
        modules: [],
        files: [],
        pages: [],
        syllabusCandidates: [],
        attachments: [],
        ingestion: {
          version: 1,
          ingestedAt: "2026-03-29T11:00:00.000Z",
          courseId: 17,
          courseName: "ECE243",
          courseCode: "ECE243H1",
          refresh: true,
          counts: {
            assignments: 0,
            modules: 0,
            moduleItems: 0,
            files: 0,
            pages: 0,
            syllabusCandidates: 0,
            attachmentsDownloaded: 0,
            attachmentsSkipped: 0,
            attachmentsFailed: 0,
          },
        },
      }
    );

    assert.equal(lifecycle, "error");
  });

  await t.test("course retrieval searches cached extracted content instead of metadata only", async () => {
    await withTempCwd(async (tempDir) => {
      const coursePath = path.join(tempDir, ".canvas-cli", "courses", "ece243h1-17");
      await writeJson(path.join(coursePath, "assignments.json"), []);
      await writeJson(path.join(coursePath, "modules.json"), []);
      await writeJson(path.join(coursePath, "files.json"), []);
      await writeJson(path.join(coursePath, "pages.json"), [
        { pageId: "lab-brief", title: "Lab Brief", url: null },
      ]);
      await writeJson(path.join(coursePath, "syllabus-candidates.json"), []);
      await writeJson(path.join(coursePath, "attachments.json"), [
        {
          originalFilename: "lab4-spec.pdf",
          localPath: "attachments/lab4-spec.pdf",
          status: "downloaded",
          reason: "",
        },
      ]);
      await writeJson(path.join(coursePath, "ingestion.json"), {
        ingestedAt: "2026-03-29T10:00:00.000Z",
      });
      await fs.mkdir(path.join(coursePath, "extracted", "pages"), { recursive: true });
      await fs.mkdir(path.join(coursePath, "extracted", "attachments"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(coursePath, "extracted", "pages", "lab-brief.txt"),
        "# Lab Brief\n\nAssembly pipeline timing is explained here.\n",
        "utf-8"
      );
      await fs.writeFile(
        path.join(coursePath, "extracted", "attachments", "lab4-spec.pdf.txt"),
        "Deliverables include a waveform screenshot and a short analysis.\n",
        "utf-8"
      );

      const cache = {
        courseId: 17,
        coursePath,
        assignments: [],
        modules: [],
        files: [],
        pages: [{ pageId: "lab-brief", title: "Lab Brief", url: null }],
        syllabusCandidates: [],
        attachments: [
          {
            originalFilename: "lab4-spec.pdf",
            localPath: "attachments/lab4-spec.pdf",
            status: "downloaded",
            reason: "",
          },
        ],
        ingestion: { ingestedAt: "2026-03-29T10:00:00.000Z" },
      } as any;

      const searchResult = await searchCourseIndex(cache, "waveform screenshot");
      assert.match(searchResult, /\[attachment\] lab4-spec\.pdf/);

      const pageResult = await searchCourseIndex(cache, "pipeline timing");
      assert.match(pageResult, /\[page\] Lab Brief/);

      const readResult = await readCourseDocumentFromIndex(cache, "lab4 spec");
      assert.match(readResult, /waveform screenshot/);
    });
  });

  await t.test("context bundle reuses cached extracted attachments", async () => {
    await withTempCwd(async (tempDir) => {
      const coursePath = path.join(tempDir, ".canvas-cli", "courses", "ece243h1-17");
      await fs.mkdir(path.join(coursePath, "extracted", "attachments"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(coursePath, "extracted", "attachments", "lab4-spec.pdf.txt"),
        "Cached extracted attachment text.\n",
        "utf-8"
      );

      const bundle = await buildContextBundle(
        {
          id: 42,
          name: "Lab 4",
          courseId: 17,
          courseName: "ECE243",
          dueAt: null,
          unlockAt: null,
          lockAt: null,
          submitted: false,
          submittedAt: null,
          score: null,
          grade: null,
          late: false,
          missing: false,
          status: "upcoming",
          pointsPossible: null,
          gradingType: "points",
          submissionTypes: [],
          allowedExtensions: null,
          htmlUrl: "https://canvas.example/lab-4",
          description: null,
          attachments: [],
        } as any,
        {
          flags: {
            hasWeakCanvasDescription: false,
            missingDueDate: true,
            likelySubmissionShell: false,
          },
          relatedAttachments: [
            {
              filename: "lab4-spec.pdf",
              localPath: "attachments/lab4-spec.pdf",
              reason: "linked from assignment",
            },
          ],
          relatedPages: [],
          relatedModules: [],
          relevantAssignments: [],
        } as any,
        {
          courseId: 17,
          coursePath,
          assignments: [],
          modules: [],
          files: [],
          pages: [],
          syllabusCandidates: [],
          attachments: [
            {
              originalFilename: "lab4-spec.pdf",
              localPath: "attachments/lab4-spec.pdf",
              status: "downloaded",
              reason: "",
            },
          ],
          ingestion: { ingestedAt: "2026-03-29T10:00:00.000Z" },
        }
      );

      assert.match(
        bundle.extractedTexts.map((entry) => entry.content).join("\n"),
        /Cached extracted attachment text/
      );
    });
  });

  await t.test("workspace pinning uses cached extracted course attachments", async () => {
    await withTempCwd(async (tempDir) => {
      const coursePath = path.join(tempDir, ".canvas-cli", "courses", "ece243h1-17");
      await fs.mkdir(path.join(coursePath, "extracted", "attachments", "modules"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(coursePath, "extracted", "attachments", "modules", "lab4-spec.pdf.txt"),
        "Pinned cached attachment text.\n",
        "utf-8"
      );

      const content = await resolveWorkspacePinContent(
        {
          path: "/tmp/ws",
          sessionSlug: "ws",
          assignmentId: 42,
          assignmentName: "Lab 4",
          courseId: 17,
          courseName: "ECE243",
          courseCode: "ECE243H1",
          preparedAt: null,
          workspaceState: "ready",
          assignmentMd: null,
          planMd: null,
          notesMd: null,
          workupJson: null,
          extractedFiles: [],
          extractedFileCache: new Map(),
        },
        {
          courseId: 17,
          coursePath,
          assignments: [],
          modules: [],
          files: [],
          pages: [],
          syllabusCandidates: [],
          attachments: [
            {
              originalFilename: "lab4-spec.pdf",
              localPath: "attachments/modules/lab4-spec.pdf",
              status: "downloaded",
              reason: "",
            },
          ],
          ingestion: { ingestedAt: "2026-03-29T10:00:00.000Z" },
        } as any,
        {
          name: "lab4-spec.pdf",
          label: "lab4_spec",
          localPath: "attachments/modules/lab4-spec.pdf",
        }
      );

      assert.match(content ?? "", /Pinned cached attachment text/);
    });
  });

  await t.test("workspace slash commands use loaded shell state instead of reloading from disk", async () => {
    const messages: Array<{ role: string; content: string }> = [];
    const api = {
      addMessage: async (message: { role: string; content: string }) => {
        messages.push(message);
      },
      session: {
        title: "Lab 4",
        metadata: {
          assignmentId: 42,
          assignmentName: "Lab 4",
        },
      },
      runtime: {
        scope: {
          type: "workspace",
          workspacePath: "/path/that/does/not/exist",
          courseId: null,
          assignmentId: 42,
        },
      },
      getLoadedWorkspace: () =>
        ({
          path: "/path/that/does/not/exist",
          sessionSlug: "ece243h1-lab-4-42",
          assignmentId: 42,
          assignmentName: "Lab 4",
          courseId: 17,
          courseName: "ECE243",
          courseCode: "ECE243H1",
          preparedAt: "2026-03-29T10:05:00.000Z",
          workspaceState: "ready",
          assignmentMd: "# Assignment",
          planMd: "# Plan",
          notesMd: null,
          workupJson: {
            overview: "Cached overview",
            deliverables: ["report"],
            constraints: ["submit pdf"],
            relevantResources: [
              { title: "Lab Handout", type: "pdf", why: "primary spec" },
            ],
            actionPlan: [
              { step: 1, action: "Read spec", detail: "Focus on timing" },
            ],
            uncertainties: ["Confirm waveform format"],
            dueDate: null,
            confidence: "medium",
            sourceTrace: [
              { conclusion: "Need waveform screenshot", source: "lab4-spec.pdf" },
            ],
          },
          extractedFiles: [
            {
              name: "lab4-spec.txt",
              relativePath: "extracted/lab4-spec.txt",
            },
          ],
          extractedFileCache: new Map([
            ["lab4-spec.txt", "waveform screenshot"],
          ]),
        }) as any,
      getCourseCache: () => null,
    } as any;

    await handleCommand("/overview", "", api, {} as any);
    await handleCommand("/plan", "", api, {} as any);
    await handleCommand("/resources", "", api, {} as any);
    await handleCommand("/evidence", "", api, {} as any);
    await handleCommand("/status", "", api, {} as any);

    assert.equal(messages.length, 5);
    assert.match(messages[0]?.content ?? "", /Cached overview/);
    assert.match(messages[1]?.content ?? "", /Read spec/);
    assert.match(messages[2]?.content ?? "", /Lab Handout/);
    assert.match(messages[3]?.content ?? "", /waveform screenshot/);
    assert.match(messages[4]?.content ?? "", /Assignment: Lab 4/);
  });

  await t.test("workspace loading indexes extracted files lazily and reads content on demand", async () => {
    await withTempCwd(async (tempDir) => {
      const workspacePath = path.join(
        tempDir,
        ".canvas-cli",
        "sessions",
        "ece243h1-lab-4-42"
      );
      await fs.mkdir(path.join(workspacePath, "extracted", "pages"), {
        recursive: true,
      });
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
      });
      await fs.writeFile(
        path.join(workspacePath, "extracted", "lab4-spec.txt"),
        "waveform screenshot requirement\n",
        "utf-8"
      );
      await fs.writeFile(
        path.join(workspacePath, "extracted", "pages", "brief.txt"),
        "pipeline timing details\n",
        "utf-8"
      );

      const loaded = await loadWorkspace(workspacePath);

      assert.deepEqual(
        loaded.extractedFiles.map((file) => file.name),
        ["lab4-spec.txt", "pages/brief.txt"]
      );
      assert.equal((loaded.extractedFiles[0] as any).content, undefined);

      const content = await readWorkspaceExtractedFile(loaded, "pages/brief.txt");
      assert.match(content ?? "", /pipeline timing details/);
      assert.equal(loaded.extractedFileCache?.get("pages/brief.txt"), content);
    });
  });
});
