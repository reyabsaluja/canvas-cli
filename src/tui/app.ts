import { existsSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import {
  hideCursor,
  showCursor,
  clearScreen,
  CANVAS_ASCII,
  C,
  MenuBox,
  getTermSize,
  stripAnsi,
} from "./screen.js";
import { showPicker } from "./picker.js";
import {
  type AssignmentTarget,
  initServices,
  fetchAssignments,
  openWorkspace,
  refreshWorkspace,
  getRecentWorkspaces,
  getDisplayCourses,
  getDisplayCourseAvailability,
  getUnavailableConfiguredCourses,
  formatDueCompact,
  createChatContext,
  askWorkspaceQuestion,
  hydrateConversationHistory,
  getCourseById,
  fetchUpcomingAssignments,
  getWorkspaceLifecycleState,
  type AppServices,
} from "./services.js";
import { loadCourseConfig } from "./course-config.js";
import { runCourseManagement, runCourseSetup } from "./course-setup.js";
import { loadCourseCache } from "../enrich/cache-loader.js";
import { loadWorkspace } from "../ask/load-workspace.js";
import { updateWorkspaceSessionMeta } from "../workspace/session.js";
import { runChatShell } from "./chat-shell.js";
import {
  loadOrCreateChatSession,
  listChatSessions,
  saveChatSession,
} from "./chat-sessions.js";
import type {
  AppScope,
  ChatMessage,
  ChatSession,
  ScopeRuntime,
} from "./chat-state.js";
import { answerCourseQuestion, answerGlobalQuestion } from "./chat-assistant.js";
import { extractFileText } from "../extract/extract-text.js";
import type { Course, Assignment } from "../domain/models.js";
import { matchAssignments } from "../domain/matching.js";
import type { AssignmentWorkup } from "../work/types.js";
import { COMMANDS } from "./commands.js";

type ShellResult =
  | { type: "quit" }
  | { type: "scope"; scope: AppScope }
  | { type: "course-management" }
  | { type: "course-picker" }
  | { type: "recent-picker" }
  | { type: "assignment-picker"; courseId: number }
  | { type: "open-assignment"; courseId: number; assignmentTarget: AssignmentTarget }
  | { type: "workspace-refresh"; courseId: number; assignmentTarget: AssignmentTarget };

/**
 * Main interactive TUI application.
 */
export async function launchApp(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("canvas-cli interactive mode requires a TTY.");
    process.exit(1);
  }

  const handleSigint = (): void => {
    showCursor();
    clearScreen();
    process.exit(130);
  };

  process.once("SIGINT", handleSigint);

  try {
    clearScreen();
    hideCursor();
    renderSplashLoading();

    let services: AppServices;
    try {
      services = await initServices();
    } catch (error) {
      showCursor();
      clearScreen();
      console.error(
        C.error(
          `\n  Failed to connect: ${error instanceof Error ? error.message : "unknown error"}`
        )
      );
      console.error(
        C.dim("  Check your CANVAS_BASE_URL and CANVAS_ACCESS_TOKEN in .env")
      );
      process.exit(1);
    }

    let courseConfig = await loadCourseConfig();
    if (!courseConfig || courseConfig.courses.length === 0) {
      clearScreen();
      courseConfig = await runCourseSetup(services.allCourses);
    }
    services.courseConfig = courseConfig;

    let scope: AppScope = { type: "global" };

    while (true) {
      const shellContext = await createShellContext(services, scope);
      const result = await runChatShell<ShellResult>({
        session: shellContext.session,
        runtime: shellContext.runtime,
        commands: COMMANDS,
        modelLabel: services.aiConfig?.model ?? "no model",
        bannerRenderer: shellContext.bannerRenderer,
        extraHelpCommands: shellContext.extraHelpCommands,
        pinOptions: shellContext.pinOptions,
        resolvePinContent: shellContext.resolvePinContent,
        onAsk: shellContext.onAsk,
        onCommand: async (command, args, api) => {
          return handleCommand(command, args, api, services);
        },
      });

      if (!result || result.type === "quit") {
        showCursor();
        clearScreen();
        return;
      }

      if (result.type === "scope") {
        scope = result.scope;
        continue;
      }

      if (result.type === "course-management") {
        clearScreen();
        const updated = await runCourseManagement(
          services.courseConfig ?? { courses: [] },
          services.allCourses
        );
        services.courseConfig = updated;
        scope = normalizeScopeAfterCourseManagement(scope, services);
        continue;
      }

      if (result.type === "course-picker") {
        const nextCourse = await pickCourse(services);
        scope = nextCourse
          ? { type: "course", courseId: nextCourse.id }
          : shellContext.runtime.scope;
        continue;
      }

      if (result.type === "recent-picker") {
        const nextScope = await pickRecentScope(services);
        scope = nextScope ?? shellContext.runtime.scope;
        continue;
      }

      if (result.type === "assignment-picker") {
        const nextScope = await pickAssignmentScope(services, result.courseId);
        scope = nextScope ?? shellContext.runtime.scope;
        continue;
      }

      if (result.type === "open-assignment") {
        const nextScope = await openAssignmentScope(
          services,
          result.courseId,
          result.assignmentTarget
        );
        scope = nextScope ?? shellContext.runtime.scope;
        continue;
      }

      if (result.type === "workspace-refresh") {
        scope = await refreshWorkspaceScope(
          services,
          result.courseId,
          result.assignmentTarget,
          shellContext.runtime.scope
        );
      }
    }
  } finally {
    process.removeListener("SIGINT", handleSigint);
  }
}

async function createShellContext(
  services: AppServices,
  scope: AppScope
): Promise<{
  session: ChatSession;
  runtime: ScopeRuntime;
  bannerRenderer?: (buf: { push(line?: string): void }) => void;
  extraHelpCommands?: Array<{ cmd: string; desc: string }>;
  pinOptions?: Array<{ name: string; label: string }>;
  resolvePinContent?: (pin: { name: string; label: string }) => Promise<string | null>;
  onAsk: Parameters<typeof runChatShell<ShellResult>>[0]["onAsk"];
}> {
  if (scope.type === "global") {
    const recent = await getRecentWorkspaces();
    const unavailableCourses = getUnavailableConfiguredCourses(services);
    let upcomingPromise: Promise<Assignment[]> | null = null;
    const getUpcomingAssignments = (): Promise<Assignment[]> => {
      upcomingPromise ??= fetchUpcomingAssignments(services, 10).catch(() => []);
      return upcomingPromise;
    };
    const session = await loadOrCreateChatSession(scope, {
      title: "Global",
      metadata: {},
      initialMessages: buildGlobalIntroMessages(recent, [], unavailableCourses),
    });

    return {
      session,
      runtime: {
        scope,
        title: "Global",
        scopeLabel: "Global",
        placeholder: "Ask about your courses, or use /courses and /recent",
      },
      bannerRenderer: (buf) => renderGlobalBanner(buf, services, recent, []),
      onAsk: async (input, callbacks) => {
        if (!services.aiConfig) {
          return {
            content:
              "AI is unavailable because no provider key is configured. You can still use /courses, /recent, and /open.",
          };
        }
        const upcoming = await getUpcomingAssignments();
        const answer = await answerGlobalQuestion({
          aiConfig: services.aiConfig,
          services,
          question: input,
          history: session.messages,
          recent,
          upcomingAssignments: upcoming,
          onTextDelta: callbacks.onTextDelta,
        });
        return { content: answer };
      },
    };
  }

  if (scope.type === "course") {
    const course = getCourseById(services, scope.courseId);
    if (!course) {
      const session = await loadOrCreateChatSession({ type: "global" }, {
        title: "Global",
      });
      return {
        session,
        runtime: {
          scope: { type: "global" },
          title: "Global",
          scopeLabel: "Global",
        },
        bannerRenderer: (buf) => renderGlobalBanner(buf, services, [], []),
        onAsk: async () => ({
          content: "That course is no longer available. Use /courses to pick another one.",
        }),
      };
    }

    const assignments = await fetchAssignments(services, course.id, course.name).catch(() => []);
    const cache = await loadCourseCache(course.courseCode, course.id);
    const session = await loadOrCreateChatSession(scope, {
      title: course.name,
      metadata: {
        courseId: course.id,
        courseName: course.name,
        courseCode: course.courseCode,
      },
      initialMessages: buildCourseIntroMessages(course, assignments, cache !== null),
    });

    return {
      session,
      runtime: {
        scope,
        title: course.name,
        subtitle: course.courseCode,
        scopeLabel: `Course: ${course.name}`,
        placeholder: "Ask about this course, or use /assignments",
      },
      onAsk: async (input, callbacks) => {
        if (!services.aiConfig) {
          return {
            content:
              "AI is unavailable because no provider key is configured. Course navigation commands still work.",
          };
        }
        const answer = await answerCourseQuestion({
          aiConfig: services.aiConfig,
          courseName: course.name,
          courseCode: course.courseCode,
          cache,
          assignments,
          history: session.messages,
          question: input,
          onToolCall: callbacks.onToolCall,
          onTextDelta: callbacks.onTextDelta,
        });
        return { content: answer };
      },
    };
  }

  const workspaceData = await loadOrCreateWorkspaceShell(services, scope);
  return workspaceData;
}

async function loadOrCreateWorkspaceShell(
  services: AppServices,
  scope: Extract<AppScope, { type: "workspace" }>
): Promise<{
  session: ChatSession;
  runtime: ScopeRuntime;
  bannerRenderer?: (buf: { push(line?: string): void }) => void;
  extraHelpCommands: Array<{ cmd: string; desc: string }>;
  pinOptions: Array<{ name: string; label: string; localPath?: string }>;
  resolvePinContent: (pin: {
    name: string;
    label: string;
    localPath?: string;
  }) => Promise<string | null>;
  onAsk: Parameters<typeof runChatShell<ShellResult>>[0]["onAsk"];
}> {
  if (!(await workspaceExists(scope.workspacePath))) {
    const unavailableCourses = getUnavailableConfiguredCourses(services);
    const session = await loadOrCreateChatSession({ type: "global" }, {
      title: "Global",
      initialMessages: buildGlobalIntroMessages([], [], unavailableCourses),
    });
    const message =
      "That workspace no longer exists on disk. Use /recent or /courses to open something else.";
    if (session.messages[session.messages.length - 1]?.content !== message) {
      session.messages.push({ role: "system", content: message });
      await saveChatSession(session);
    }
    return {
      session,
      runtime: {
        scope: { type: "global" },
        title: "Global",
        scopeLabel: "Global",
        placeholder: "Ask about your courses, or use /courses and /recent",
      },
      bannerRenderer: (buf: { push(line?: string): void }) =>
        renderGlobalBanner(buf, services, [], []),
      onAsk: async () => ({
        content: "Open another course or workspace to continue.",
      }),
      extraHelpCommands: [],
      pinOptions: [],
      resolvePinContent: async () => null,
    };
  }

  const loaded = await loadWorkspace(scope.workspacePath);
  const workup = loaded.workupJson as AssignmentWorkup | null;
  const courseId = loaded.courseId ?? scope.courseId;
  const course = courseId ? getCourseById(services, courseId) : null;
  const cache = course ? await loadCourseCache(course.courseCode, course.id) : null;
  const lifecycleState = getWorkspaceLifecycleState(
    loaded.preparedAt,
    loaded.workspaceState,
    cache
  );
  await updateWorkspaceSessionMeta(scope.workspacePath, (current) => ({
    ...current,
    updatedAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    workspaceState: lifecycleState,
  }));
  const openResult = {
    workspacePath: scope.workspacePath,
    workup,
    loaded,
    lifecycleState,
  };

  const session = await loadOrCreateChatSession(
    {
      type: "workspace",
      workspacePath: openResult.workspacePath,
      courseId: courseId ?? null,
      assignmentId: loaded.assignmentId ?? scope.assignmentId,
    },
    {
      title: loaded.assignmentName,
      metadata: {
        courseId: courseId ?? null,
        courseName: loaded.courseName,
        courseCode: loaded.courseCode ?? undefined,
        assignmentId: loaded.assignmentId,
        assignmentName: loaded.assignmentName,
        workspacePath: openResult.workspacePath,
        sessionSlug: loaded.sessionSlug,
      },
      initialMessages: buildWorkspaceIntroMessages(loaded, workup, openResult.lifecycleState),
    }
  );

  const chatCtx = services.aiConfig
    ? createChatContext(services.aiConfig, loaded, {
        cache,
        client: services.client,
        config: services.config,
        courseId: courseId ?? null,
      })
    : null;
  if (chatCtx) {
    hydrateConversationHistory(chatCtx, session.messages);
  }

  return {
    session,
    runtime: {
      scope,
      title: loaded.assignmentName,
      subtitle:
        openResult.lifecycleState === "stale"
          ? `${loaded.courseName} · stale workspace`
          : loaded.courseName,
      scopeLabel: `Workspace: ${loaded.courseName} / ${loaded.assignmentName}`,
      statusLabel: formatWorkspaceStatusLabel(openResult.lifecycleState),
      placeholder: "Ask about this assignment, or use /help",
    },
    extraHelpCommands: [
      { cmd: "/pin", desc: "Attach a workspace file to your prompt" },
    ],
    pinOptions: buildWorkspacePinOptions(loaded, cache),
    resolvePinContent: async (pin) => resolveWorkspacePinContent(loaded, cache, pin),
    onAsk: async (input, callbacks) => {
      if (!services.aiConfig || !chatCtx) {
        return {
          content:
            "AI is unavailable because no provider key is configured. Workspace slash commands still work.",
        };
      }
      const answer = await askWorkspaceQuestion(
        services.aiConfig,
        loaded,
        input,
        callbacks.onToolCall,
        {
          cache,
          client: services.client,
          config: services.config,
          courseId: courseId ?? null,
        },
        chatCtx,
        callbacks.onTextDelta
      );
      return {
        content: answer.answer,
        bulletPoints: answer.bulletPoints,
        sources: answer.sources,
        confidence: answer.confidence,
      };
    },
  };
}

async function handleCommand(
  command: string,
  args: string,
  api: {
    addMessage: (message: ChatMessage) => Promise<void>;
    session: ChatSession;
    runtime: ScopeRuntime;
  },
  services: AppServices
): Promise<ShellResult | null | void> {
  const scope = api.runtime.scope;

  if (command === "/quit" || command === "/exit" || command === "/q") {
    return { type: "quit" };
  }

  if (command === "/home") {
    if (scope.type === "global") {
      await api.addMessage({
        role: "system",
        content: "You are already in the global home session.",
      });
      return;
    }
    return { type: "scope", scope: { type: "global" } };
  }

  if (command === "/back") {
    if (scope.type === "workspace" && scope.courseId) {
      return { type: "scope", scope: { type: "course", courseId: scope.courseId } };
    }
    if (scope.type === "course") {
      return { type: "scope", scope: { type: "global" } };
    }
    await api.addMessage({
      role: "system",
      content: "There is no higher scope above global.",
    });
    return;
  }

  if (command === "/manage-courses") {
    return { type: "course-management" };
  }

  if (scope.type === "global") {
    if (command === "/courses") {
      const courses = getDisplayCourses(services);
      if (courses.length === 0) {
        await api.addMessage({
          role: "system",
          content: "No courses are configured yet.",
        });
        return;
      }
      return { type: "course-picker" };
    }
    if (command === "/recent") {
      return { type: "recent-picker" };
    }
    if (command === "/open") {
      const next = await resolveGlobalOpen(args, services);
      if (next.scope) return { type: "scope", scope: next.scope };
      if (next.error) {
        await api.addMessage({
          role: "system",
          content: next.error,
        });
        return;
      }
      if (args.trim()) {
        await api.addMessage({
          role: "system",
          content: `No course or available workspace matched "${args.trim()}".`,
        });
        return;
      }
      return { type: "recent-picker" };
    }
    return;
  }

  if (scope.type === "course") {
    const course = getCourseById(services, scope.courseId);
    if (!course) {
      await api.addMessage({
        role: "system",
        content: "That course is no longer available. Use /courses to pick another one.",
      });
      return { type: "scope", scope: { type: "global" } };
    }

    if (command === "/assignments" || command === "/open") {
      if (args.trim()) {
        const assignments = await fetchAssignments(services, course.id, course.name);
        const matches = matchAssignments(args.trim(), assignments);
        if (matches.length === 1) {
          return {
            type: "open-assignment",
            courseId: course.id,
            assignmentTarget: {
              id: matches[0]!.id,
              name: matches[0]!.name,
            },
          };
        }
        if (matches.length > 1) {
          await api.addMessage({
            role: "system",
            content: [
              `Multiple assignments in ${course.name} matched "${args.trim()}".`,
              "Be more specific or use /assignments:",
              ...matches.slice(0, 5).map((assignment) => `• ${assignment.name}`),
            ].join("\n"),
          });
          return;
        }
        await api.addMessage({
          role: "system",
          content: `No assignment in ${course.name} matched "${args.trim()}".`,
        });
        return;
      }
      return { type: "assignment-picker", courseId: course.id };
    }

    const cache = await loadCourseCache(course.courseCode, course.id);
    if (command === "/modules") {
      if (!cache || cache.modules.length === 0) {
        await api.addMessage({
          role: "system",
          content:
            "No course modules are cached yet. Open a workspace or refresh the course cache first.",
        });
        return;
      }
      await api.addMessage({
        role: "assistant",
        content: cache.modules
          .map((module, index) => `${index + 1}. ${module.name} (${module.itemCount} items)`)
          .join("\n"),
      });
      return;
    }

    if (command === "/files") {
      if (!cache) {
        await api.addMessage({
          role: "system",
          content:
            "No cached course files are available yet. Open a workspace or refresh the course cache first.",
        });
        return;
      }
      const downloaded = cache.attachments
        .filter((attachment) => attachment.status === "downloaded" || attachment.status === "skipped")
        .slice(0, 20)
        .map((attachment) => `• ${attachment.originalFilename}`);
      const indexed = cache.files.slice(0, 12).map((file) => `• ${file.displayName}`);
      await api.addMessage({
        role: "assistant",
        content: [
          `Downloaded attachments (${downloaded.length || 0})`,
          downloaded.length > 0 ? downloaded.join("\n") : "• none yet",
          "",
          `Course file index (${cache.files.length})`,
          indexed.length > 0 ? indexed.join("\n") : "• none indexed",
        ].join("\n"),
      });
      return;
    }

    return;
  }

  if (command === "/overview") {
    const loaded = await loadWorkspace(scope.workspacePath);
    const currentWorkup = loaded.workupJson as AssignmentWorkup | null;
    await api.addMessage({
      role: currentWorkup?.overview ? "assistant" : "system",
      content: currentWorkup?.overview ?? "No workup data available.",
    });
    return;
  }

  if (command === "/requirements" || command === "/reqs") {
    const loaded = await loadWorkspace(scope.workspacePath);
    const currentWorkup = loaded.workupJson as AssignmentWorkup | null;
    if (!currentWorkup) {
      await api.addMessage({ role: "system", content: "No workup data available." });
      return;
    }
    const parts: string[] = [];
    if (currentWorkup.deliverables.length > 0) {
      parts.push(
        "**Deliverables**\n" +
          currentWorkup.deliverables.map((item) => `• ${item}`).join("\n")
      );
    }
    if (currentWorkup.constraints.length > 0) {
      parts.push(
        "**Constraints**\n" +
          currentWorkup.constraints.map((item) => `• ${item}`).join("\n")
      );
    }
    await api.addMessage({
      role: "assistant",
      content: parts.join("\n\n") || "No deliverables or constraints found.",
    });
    return;
  }

  if (command === "/plan") {
    const loaded = await loadWorkspace(scope.workspacePath);
    const currentWorkup = loaded.workupJson as AssignmentWorkup | null;
    await api.addMessage({
      role:
        currentWorkup && currentWorkup.actionPlan.length > 0 ? "assistant" : "system",
      content:
        currentWorkup && currentWorkup.actionPlan.length > 0
          ? currentWorkup.actionPlan
              .map((step) => `${step.step}. ${step.action}${step.detail ? `\n   ${step.detail}` : ""}`)
              .join("\n")
          : "No action plan available.",
    });
    return;
  }

  if (command === "/resources") {
    const loaded = await loadWorkspace(scope.workspacePath);
    const currentWorkup = loaded.workupJson as AssignmentWorkup | null;
    await api.addMessage({
      role:
        currentWorkup && currentWorkup.relevantResources.length > 0
          ? "assistant"
          : "system",
      content:
        currentWorkup && currentWorkup.relevantResources.length > 0
          ? currentWorkup.relevantResources
              .map((resource) => `• **${resource.title}** (${resource.type}) — ${resource.why}`)
              .join("\n")
          : "No resources listed.",
    });
    return;
  }

  if (command === "/evidence") {
    const loaded = await loadWorkspace(scope.workspacePath);
    const currentWorkup = loaded.workupJson as AssignmentWorkup | null;
    if (!currentWorkup || currentWorkup.sourceTrace.length === 0) {
      await api.addMessage({
        role: "system",
        content: "No source trace available.",
      });
      return;
    }
    let content = currentWorkup.sourceTrace
      .map((item) => `• ${item.conclusion}\n  source: ${item.source}`)
      .join("\n");
    if (currentWorkup.uncertainties.length > 0) {
      content +=
        "\n\n**Open questions**\n" +
        currentWorkup.uncertainties.map((item) => `? ${item}`).join("\n");
    }
    await api.addMessage({ role: "assistant", content });
    return;
  }

  if (command === "/status") {
    const loaded = await loadWorkspace(scope.workspacePath);
    const course =
      scope.courseId !== null ? getCourseById(services, scope.courseId) : null;
    const cache = course ? await loadCourseCache(course.courseCode, course.id) : null;
    const lifecycleState = getWorkspaceLifecycleState(
      loaded.preparedAt,
      loaded.workspaceState,
      cache
    );
    await api.addMessage({
      role: "assistant",
      content: [
        `Assignment: ${loaded.assignmentName}`,
        `Course: ${loaded.courseName}`,
        `Status: ${lifecycleState}${lifecycleState === "stale" ? " (refresh recommended)" : ""}`,
        `Path: ${scope.workspacePath}`,
        `Extracted: ${loaded.extractedFiles.length} documents`,
        `Plan: ${loaded.planMd ? "available" : "missing"}`,
      ].join("\n"),
    });
    return;
  }

  if (command === "/refresh") {
    if (!scope.courseId) {
      await api.addMessage({
        role: "system",
        content: "Cannot refresh this workspace because the course is unknown.",
      });
      return;
    }
    return {
      type: "workspace-refresh",
      courseId: scope.courseId,
      assignmentTarget: {
        id: api.session.metadata.assignmentId ?? scope.assignmentId ?? null,
        name: api.session.metadata.assignmentName ?? api.session.title,
      },
    };
  }
}

async function pickCourse(services: AppServices): Promise<Course | null> {
  const courses = getDisplayCourses(services);
  if (courses.length === 0) return null;
  const selected = await showPicker({
    title: "Courses",
    subtitle: `${courses.length} courses`,
    items: courses.map((course) => ({
      label: course.name,
      sublabel: course.courseCode,
      value: String(course.id),
    })),
    filterable: true,
    backLabel: "back",
  });
  if (!selected) return null;
  return courses.find((course) => String(course.id) === selected) ?? null;
}

async function pickAssignmentScope(
  services: AppServices,
  courseId: number
): Promise<AppScope | null> {
  const course = getCourseById(services, courseId);
  if (!course) return null;

  clearScreen();
  console.log("");
  console.log(C.dim(`  loading assignments for ${course.courseCode}...`));

  let assignments: Assignment[];
  try {
    assignments = await fetchAssignments(services, course.id, course.name);
  } catch (error) {
    console.error(
      C.error(`  Error: ${error instanceof Error ? error.message : "unknown"}`)
    );
    await sleep(1200);
    return null;
  }

  if (assignments.length === 0) {
    console.log(C.dim("  No assignments found for this course."));
    await sleep(1200);
    return null;
  }

  const selected = await showPicker({
    title: course.courseCode || course.name,
    subtitle: `${assignments.length} assignments`,
    items: assignments.map((assignment) => ({
      label: assignment.name,
      sublabel:
        formatDueCompact(assignment.dueAt) +
        (assignment.submitted ? " · submitted" : ""),
      value: String(assignment.id),
      dimmed: assignment.submitted,
    })),
    filterable: true,
    backLabel: "back",
  });

  if (!selected) return null;
  const selectedAssignment =
    assignments.find((assignment) => String(assignment.id) === selected) ?? null;
  if (!selectedAssignment) return null;

  clearScreen();
  console.log("");
  console.log(C.primaryBold(`  ${selectedAssignment.name}`));
  console.log(C.dim(`  ${course.name}`));
  console.log("");

  try {
    const result = await openWorkspace(
      services,
      course,
      {
        id: selectedAssignment.id,
        name: selectedAssignment.name,
      },
      (stage) => {
        console.log(`  ${C.dim("›")} ${C.dim(stage)}`);
      }
    );
    return {
      type: "workspace",
      workspacePath: result.workspacePath,
      courseId: course.id,
      assignmentId: result.loaded.assignmentId,
    };
  } catch (error) {
    console.error(
      C.error(`\n  Failed: ${error instanceof Error ? error.message : "unknown"}`)
    );
    console.log(C.dim("\n  Press any key to continue..."));
    await waitForKey();
    return null;
  }
}

async function pickRecentScope(services: AppServices): Promise<AppScope | null> {
  const allSessions = (await listChatSessions()).filter(
    (session) => session.scope.type !== "global"
  );
  const sessions: typeof allSessions = [];
  for (const session of allSessions) {
    if (
      session.scope.type === "workspace" &&
      !(await workspaceExists(session.scope.workspacePath))
    ) {
      continue;
    }
    sessions.push(session);
  }

  if (sessions.length > 0) {
    const selected = await showPicker({
      title: "Recent sessions",
      subtitle: `${sessions.length} recent items`,
      items: sessions.slice(0, 20).map((session) => ({
        label: session.title,
        sublabel:
          session.scope.type === "course"
            ? `Course · ${session.metadata.courseName ?? ""}`
            : `Workspace · ${session.metadata.courseName ?? ""}`,
        value: session.id,
      })),
      filterable: true,
      backLabel: "back",
    });
    if (!selected) return null;
    const session = sessions.find((entry) => entry.id === selected) ?? null;
    return session?.scope ?? null;
  }

  const allRecent = await getRecentWorkspaces();
  const recent: typeof allRecent = [];
  for (const workspace of allRecent) {
    if (await workspaceExists(workspace.path)) {
      recent.push(workspace);
    }
  }
  if (recent.length === 0) return null;
  const selected = await showPicker({
    title: "Recent workspaces",
    subtitle: `${recent.length} workspaces`,
    items: recent.map((workspace) => ({
      label: workspace.name,
      sublabel: workspace.course,
      value: workspace.path,
    })),
    filterable: true,
    backLabel: "back",
  });
  if (!selected) return null;
  if (!(await workspaceExists(selected))) {
    return null;
  }
  let loaded;
  try {
    loaded = await loadWorkspace(selected);
  } catch {
    return null;
  }
  return {
    type: "workspace",
    workspacePath: selected,
    courseId: loaded.courseId,
    assignmentId: loaded.assignmentId,
  };
}

async function resolveGlobalOpen(
  query: string,
  services: AppServices
): Promise<{ scope: AppScope | null; error?: string }> {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return { scope: null };

  const course = getDisplayCourses(services).find(
    (entry) =>
      entry.name.toLowerCase().includes(trimmed) ||
      entry.courseCode.toLowerCase().includes(trimmed)
  );
  if (course) {
    return { scope: { type: "course", courseId: course.id } };
  }

  const recent = await getRecentWorkspaces();
  const workspace = recent.find(
    (entry) =>
      entry.name.toLowerCase().includes(trimmed) ||
      entry.course.toLowerCase().includes(trimmed)
  );
  if (!workspace) return { scope: null };
  if (!(await workspaceExists(workspace.path))) {
    return {
      scope: null,
      error:
        "That workspace is no longer available on disk. Use /recent or /courses to open something else.",
    };
  }
  try {
    const loaded = await loadWorkspace(workspace.path);
    return {
      scope: {
        type: "workspace",
        workspacePath: workspace.path,
        courseId: loaded.courseId,
        assignmentId: loaded.assignmentId,
      },
    };
  } catch {
    return {
      scope: null,
      error:
        "That workspace could not be reopened. Use /recent or /courses to pick another one.",
    };
  }
}

function normalizeScopeAfterCourseManagement(
  scope: AppScope,
  services: AppServices
): AppScope {
  if (scope.type === "course") {
    return getCourseById(services, scope.courseId)
      ? scope
      : { type: "global" };
  }
  return scope;
}

function formatWorkspaceStatusLabel(lifecycleState: string): string | undefined {
  switch (lifecycleState) {
    case "stale":
      return "Status: stale · /refresh recommended";
    case "refreshing":
      return "Status: refreshing";
    case "ingesting":
      return "Status: ingesting";
    case "creating":
      return "Status: creating";
    case "error":
      return "Status: error";
    default:
      return undefined;
  }
}

async function openAssignmentScope(
  services: AppServices,
  courseId: number,
  assignmentTarget: AssignmentTarget
): Promise<AppScope | null> {
  const course = getCourseById(services, courseId);
  if (!course) return null;

  clearScreen();
  console.log("");
  console.log(C.primaryBold(`  ${assignmentTarget.name}`));
  console.log(C.dim(`  ${course.name}`));
  console.log("");

  try {
    const result = await openWorkspace(
      services,
      course,
      assignmentTarget,
      (stage) => {
        console.log(`  ${C.dim("›")} ${C.dim(stage)}`);
      }
    );
    return {
      type: "workspace",
      workspacePath: result.workspacePath,
      courseId: course.id,
      assignmentId: result.loaded.assignmentId,
    };
  } catch (error) {
    console.error(
      C.error(`\n  Failed: ${error instanceof Error ? error.message : "unknown"}`)
    );
    console.log(C.dim("\n  Press any key to continue..."));
    await waitForKey();
    return null;
  }
}

async function refreshWorkspaceScope(
  services: AppServices,
  courseId: number,
  assignmentTarget: AssignmentTarget,
  fallbackScope: AppScope
): Promise<AppScope> {
  const course = getCourseById(services, courseId);
  if (!course) return fallbackScope;

  clearScreen();
  console.log("");
  console.log(C.primaryBold(`  Refreshing ${assignmentTarget.name}`));
  console.log(C.dim(`  ${course.name}`));
  console.log("");

  try {
    const refreshed = await refreshWorkspace(
      services,
      course,
      assignmentTarget,
      (stage) => {
        console.log(`  ${C.dim("›")} ${C.dim(stage)}`);
      }
    );
    return {
      type: "workspace",
      workspacePath: refreshed.workspacePath,
      courseId: course.id,
      assignmentId: refreshed.loaded.assignmentId,
    };
  } catch (error) {
    console.error(
      C.error(`\n  Refresh failed: ${error instanceof Error ? error.message : "unknown"}`)
    );
    console.log(C.dim("\n  Press any key to continue..."));
    await waitForKey();
    return fallbackScope;
  }
}

function buildGlobalIntroMessages(
  recent: Array<{ name: string; course: string }>,
  upcoming: Assignment[],
  unavailableCourses: Array<{ displayName: string; originalCode: string }>
): ChatMessage[] {
  const lines = [
    "Academic control center ready.",
    "",
    "Use `/courses` to open a course, `/manage-courses` to edit your list, `/recent` to reopen work, or ask a broad question across your courses.",
  ];
  if (unavailableCourses.length > 0) {
    lines.push("", "**Unavailable courses**");
    for (const course of unavailableCourses.slice(0, 4)) {
      lines.push(`• ${course.displayName} (${course.originalCode}) is no longer available in Canvas`);
    }
    lines.push("Use `/manage-courses` to remove or rename outdated entries.");
  }
  if (recent.length > 0) {
    lines.push("", "**Recent workspaces**");
    for (const workspace of recent.slice(0, 4)) {
      lines.push(`• ${workspace.name} — ${workspace.course}`);
    }
  }
  if (upcoming.length > 0) {
    lines.push("", "**Upcoming assignments**");
    for (const assignment of upcoming.slice(0, 5)) {
      lines.push(`• ${assignment.name} — ${assignment.courseName}`);
    }
  }
  return [{ role: "assistant", content: lines.join("\n") }];
}

function buildCourseIntroMessages(
  course: Course,
  assignments: Assignment[],
  hasCache: boolean
): ChatMessage[] {
  const lines = [
    `You are in ${course.name}.`,
    "",
    "Ask about assignments in this course, or use `/assignments`, `/files`, and `/modules`.",
    hasCache
      ? "Course cache is available for deeper questions."
      : "Course cache is not ready yet. Open an assignment workspace for richer detail.",
  ];
  if (assignments.length > 0) {
    lines.push("", "**Upcoming work**");
    for (const assignment of assignments.slice(0, 5)) {
      lines.push(`• ${assignment.name} — ${formatDueCompact(assignment.dueAt)}`);
    }
  }
  return [{ role: "assistant", content: lines.join("\n") }];
}

function buildWorkspaceIntroMessages(
  loaded: Awaited<ReturnType<typeof loadWorkspace>>,
  workup: AssignmentWorkup | null,
  lifecycleState: string
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (lifecycleState === "stale") {
    messages.push({
      role: "system",
      content:
        "This workspace is available, but the course cache is newer than the current workup. Use /refresh when you want the latest assignment context.",
    });
  }
  if (workup?.overview) {
    messages.push({
      role: "system",
      content: workup.overview,
    });
  } else {
    messages.push({
      role: "assistant",
      content: `Workspace ready for ${loaded.assignmentName}. Use /help for assignment commands.`,
    });
  }
  return messages;
}

function buildWorkspacePinOptions(
  loaded: Awaited<ReturnType<typeof loadWorkspace>>,
  cache: Awaited<ReturnType<typeof loadCourseCache>>
): Array<{ name: string; label: string; localPath?: string }> {
  const options: Array<{ name: string; label: string; localPath?: string }> = [];
  for (const extracted of loaded.extractedFiles) {
    options.push({
      name: extracted.name,
      label: extracted.name
        .replace(/\.txt$/, "")
        .replace(/[._\s-]/g, "_")
        .toLowerCase(),
    });
  }
  if (cache) {
    for (const attachment of cache.attachments) {
      if (attachment.status !== "downloaded" && attachment.status !== "skipped") continue;
      const label = attachment.originalFilename
        .replace(/\.[^.]+$/, "")
        .replace(/[.\s-]/g, "_")
        .toLowerCase();
      if (!options.some((option) => option.label === label)) {
        options.push({
          name: attachment.originalFilename,
          label,
          localPath: attachment.localPath,
        });
      }
    }
  }
  if (loaded.assignmentMd) options.push({ name: "assignment.md", label: "assignment" });
  if (loaded.planMd) options.push({ name: "plan.md", label: "plan" });
  if (loaded.workupJson) options.push({ name: "workup.json", label: "workup" });
  return options;
}

async function resolveWorkspacePinContent(
  loaded: Awaited<ReturnType<typeof loadWorkspace>>,
  cache: Awaited<ReturnType<typeof loadCourseCache>>,
  pin: { name: string; label: string; localPath?: string }
): Promise<string | null> {
  for (const extracted of loaded.extractedFiles) {
    if (extracted.name === pin.name || extracted.name.includes(pin.label)) {
      return extracted.content.slice(0, 15000);
    }
  }
  if (pin.localPath && cache) {
    const fullPath = path.join(cache.coursePath, pin.localPath);
    const extracted = await extractFileText(fullPath, pin.name);
    return extracted.slice(0, 15000);
  }
  if (pin.name === "assignment.md" && loaded.assignmentMd) {
    return loaded.assignmentMd.slice(0, 15000);
  }
  if (pin.name === "plan.md" && loaded.planMd) {
    return loaded.planMd.slice(0, 15000);
  }
  if (pin.name === "workup.json" && loaded.workupJson) {
    return JSON.stringify(loaded.workupJson, null, 2).slice(0, 15000);
  }
  return null;
}

function renderSplashLoading(): void {
  const { cols } = getTermSize();
  console.log("");
  renderCenteredAscii(cols);
  console.log("");
  console.log(centerText(C.dim("connecting to canvas..."), cols));
}

function renderGlobalBanner(
  buf: { push(line?: string): void },
  services: AppServices,
  recent: Array<{ name: string; course: string }>,
  _upcoming: Assignment[]
): void {
  const { cols } = getTermSize();
  renderCenteredAscii(cols, {
    push: (line: string) => buf.push(line),
  });
  buf.push("");
  renderInfoBox(
    services,
    recent.map((item) => ({ ...item, slug: "", path: "" })),
    [
      ["/courses", "browse your configured courses and move into a course session"],
      ["/manage-courses", "add, remove, or rename the courses shown in canvas-cli"],
      ["/recent", "reopen a recent course or workspace session"],
      ["/open", "jump directly to a course or recent workspace by name"],
      ["/help", "full command list for the current scope"],
    ],
    cols,
    {
      push: (line: string) => buf.push(line),
    }
  );
}

function renderInfoBox(
  services: AppServices,
  recent: Array<{ name: string; course: string; slug: string; path: string }>,
  commands: [string, string][],
  termCols: number,
  buf: { push(line: string): void } = { push: (line) => console.log(line) }
): void {
  const schoolUrl = process.env.CANVAS_BASE_URL ?? "";
  let school = "unknown";
  try {
    const parsed = new URL(schoolUrl.replace("/api/v1", ""));
    school = parsed.hostname;
  } catch {
    school = schoolUrl.replace(/https?:\/\//, "").replace(/\/api\/v1.*/, "");
  }

  const aiModelText = services.aiConfig ? services.aiConfig.model : "not configured";
  const availability = getDisplayCourseAvailability(services);
  const displayCourses = availability.available;
  const courseCount = availability.unavailable.length > 0
    ? `${displayCourses.length} active · ${availability.unavailable.length} unavailable`
    : `${displayCourses.length} active`;
  const workspaceCount = `${recent.length} active`;
  const systemSummary = formatSystemSummary();
  const toolAgentSummary = "9 tools · 2 agents";

  const boxInner = Math.min(termCols - 4, 98);

  function pushMenuRow(core: string): void {
    const width = stripAnsi(core).length;
    const gap = Math.max(0, termCols - width);
    const left = Math.floor(gap / 2);
    buf.push(" ".repeat(left) + core);
  }

  if (boxInner < 40) {
    pushMenuRow(
      MenuBox.secondary("  school: ") +
        MenuBox.dim(school) +
        MenuBox.secondary("  ·  courses: ") +
        MenuBox.dim(courseCount) +
        MenuBox.secondary("  ·  model: ") +
        MenuBox.dim(aiModelText)
    );
    return;
  }

  const leftW = Math.floor(boxInner * 0.4);
  const rightW = boxInner - leftW - 1;

  const versionLabel = " v0.1.0 ";
  const topLineTotal = leftW + 1 + rightW + 2;
  const versionStart = Math.floor((topLineTotal - versionLabel.length) / 2);
  const topLeft = "─".repeat(Math.max(0, versionStart));
  const topRight = "─".repeat(
    Math.max(0, topLineTotal - versionStart - versionLabel.length)
  );
  pushMenuRow(
    MenuBox.edge("╭") +
      MenuBox.edge(topLeft) +
      MenuBox.version(versionLabel) +
      MenuBox.edge(topRight) +
      MenuBox.edge("╮")
  );

  pushMenuRow(
    MenuBox.edge("│") +
      MenuBox.fill(" ") +
      MenuBox.fill(" ".repeat(leftW)) +
      MenuBox.edge("│") +
      MenuBox.fill(" ") +
      MenuBox.fill(" ".repeat(rightW)) +
      MenuBox.edge("│")
  );

  type LeftStyle =
    | "kv"
    | "kvMuted"
    | "kvWarm"
    | "sectionHeader"
    | "desc"
    | "dim"
    | "empty";
  type RightStyle = "header" | "cmd" | "empty";
  type LeftRow = { text: string; style: LeftStyle };
  type RightRow = { text: string; style: RightStyle };
  const leftRows: LeftRow[] = [];
  const rightRows: RightRow[] = [];
  const commandStarts = new Map<string, number>();
  const pushLeft = (text: string, style: LeftStyle) => leftRows.push({ text, style });
  const pushRight = (text: string, style: RightStyle) =>
    rightRows.push({ text, style });
  const pushCommand = (command: [string, string]) => {
    commandStarts.set(command[0], rightRows.length);
    for (const line of formatCmdRows(command, rightW)) {
      pushRight(line, "cmd");
    }
  };
  const padLeftToRow = (targetRow: number) => {
    while (leftRows.length < targetRow) pushLeft("", "empty");
  };

  const L = (text: string) => truncPlain(text, leftW);
  const formatInfoRow = (label: string, value: string) =>
    L(`${label.padEnd(12)}${value}`);

  pushRight("Commands", "header");
  for (const command of commands) {
    pushCommand(command);
  }

  const findCommandRow = (names: string[], fallback: number): number => {
    for (const name of names) {
      const row = commandStarts.get(name);
      if (row !== undefined) return row;
    }
    return fallback;
  };

  const statusRow = findCommandRow(["/status", "/open", "/courses"], rightRows.length);
  const systemRow = Math.max(
    leftRows.length,
    findCommandRow(["/evidence", "/recent", "/open"], rightRows.length) - 1
  );
  const toolsRow = Math.max(
    leftRows.length,
    findCommandRow(["/requirements", "/home", "/help"], rightRows.length) - 1
  );
  const refreshRow = findCommandRow(["/refresh", "/help"], rightRows.length);

  pushLeft(formatInfoRow("school", school), "kvWarm");
  pushLeft(formatInfoRow("model", aiModelText), "kvWarm");
  pushLeft("", "empty");
  pushLeft(formatInfoRow("courses", courseCount), "kvMuted");
  pushLeft(formatInfoRow("workspaces", workspaceCount), "kvMuted");
  padLeftToRow(systemRow);
  pushLeft(formatInfoRow("system", systemSummary), "kvMuted");
  padLeftToRow(toolsRow);
  pushLeft(toolAgentSummary, "dim");

  if (displayCourses.length > 0) {
    padLeftToRow(statusRow);
    pushLeft("Courses", "sectionHeader");
    const courseLines = wrapCommaList(
      displayCourses.slice(0, 5).map((course) => course.name || course.courseCode),
      leftW - 2
    );
    for (const line of courseLines) {
      pushLeft(line, "desc");
    }
  }

  if (recent.length > 0) {
    padLeftToRow(refreshRow);
    pushLeft("Recent Workspaces", "sectionHeader");
    for (const workspace of recent) {
      const workspaceName = truncPlain(workspace.name, leftW - 2);
      pushLeft(workspaceName, workspaceName ? "desc" : "empty");
    }
  }

  const totalRows = Math.max(16, leftRows.length, rightRows.length);

  for (let i = 0; i < totalRows; i++) {
    const leftRow = leftRows[i] ?? { text: "", style: "empty" as LeftStyle };
    const rightRow = rightRows[i] ?? { text: "", style: "empty" as RightStyle };
    const leftPadded =
      leftRow.text + " ".repeat(Math.max(0, leftW - leftRow.text.length));
    const rightPadded =
      rightRow.text + " ".repeat(Math.max(0, rightW - rightRow.text.length));

    const leftColored = colorizeCell(leftPadded, leftRow.style, true);
    const rightColored = colorizeCmdCell(rightPadded, rightRow.style, true);

    pushMenuRow(
      MenuBox.edge("│") +
        MenuBox.fill(" ") +
        leftColored +
        MenuBox.edge("│") +
        MenuBox.fill(" ") +
        rightColored +
        MenuBox.edge("│")
    );
  }

  pushMenuRow(
    MenuBox.edge("╰") +
      MenuBox.edge("─".repeat(leftW + 1)) +
      MenuBox.edge("┴") +
      MenuBox.edge("─".repeat(rightW + 1)) +
      MenuBox.edge("╯")
  );
}

function formatCmdRows(command: [string, string], maxW: number): string[] {
  const cmdColW = Math.min(16, Math.max(8, maxW - 12));
  const descW = Math.max(8, maxW - cmdColW);
  const descLines = wrapWords(command[1], descW);

  return descLines.map((line, index) =>
    index === 0
      ? `${command[0].padEnd(cmdColW)}${line}`
      : `${" ".repeat(cmdColW)}${line}`
  );
}

function truncPlain(text: string, maxLen: number): string {
  return text.length <= maxLen
    ? text
    : maxLen > 3
      ? text.slice(0, maxLen - 3) + "..."
      : text.slice(0, maxLen);
}

function wrapCommaList(items: string[], maxLen: number): string[] {
  if (items.length === 0) return [];

  const tokens = items.map((item, index) =>
    index < items.length - 1 ? `${item},` : item
  );
  const lines: string[] = [];
  let current = "";

  for (const token of tokens) {
    const candidate = current ? `${current} ${token}` : token;
    if (candidate.length <= maxLen) {
      current = candidate;
      continue;
    }

    if (current) lines.push(current);
    current = token.length <= maxLen ? token : truncPlain(token, maxLen);
  }

  if (current) lines.push(current);
  return lines;
}

function wrapWords(text: string, maxLen: number): string[] {
  if (!text) return [""];

  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxLen) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      current = word.length <= maxLen ? word : truncPlain(word, maxLen);
    } else {
      lines.push(truncPlain(word, maxLen));
    }
  }

  if (current) lines.push(current);
  return lines;
}

function formatSystemSummary(): string {
  const memoryGb = Math.round(totalmem() / 1024 ** 3);
  const runtime = detectRuntimeLabel();
  return `${cpus().length} cores · ${memoryGb}GB · ${runtime}`;
}

function detectRuntimeLabel(): string {
  if (
    existsSync("/.dockerenv") ||
    process.env.CONTAINER ||
    process.env.DOCKER_CONTAINER
  ) {
    return "docker";
  }

  if (process.platform === "darwin") return "macOS";
  if (process.platform === "win32") return "windows";
  return process.platform;
}

type InfoBoxPalette = {
  secondary: (value: string) => string;
  dim: (value: string) => string;
  warm: (value: string) => string;
  text: (value: string) => string;
  bold: (value: string) => string;
  primary: (value: string) => string;
  primaryBold: (value: string) => string;
  fill: (value: string) => string;
};

const infoPalDefault: InfoBoxPalette = {
  secondary: (value) => C.muted(value),
  dim: (value) => C.dim(value),
  warm: (value) => C.warm(value),
  text: (value) => C.text(value),
  bold: (value) => C.bold(value),
  primary: (value) => C.primary(value),
  primaryBold: (value) => C.primaryBold(value),
  fill: (value) => value,
};

const infoPalMenu: InfoBoxPalette = {
  secondary: (value) => MenuBox.secondary(value),
  dim: (value) => MenuBox.dim(value),
  warm: (value) => C.warm(value),
  text: (value) => MenuBox.text(value),
  bold: (value) => MenuBox.bold(value),
  primary: (value) => MenuBox.primary(value),
  primaryBold: (value) => MenuBox.primaryBold(value),
  fill: (value) => MenuBox.fill(value),
};

function colorizeCell(
  paddedPlain: string,
  style: string,
  onMenuBox = false
): string {
  const palette = onMenuBox ? infoPalMenu : infoPalDefault;
  switch (style) {
    case "kv": {
      const match = paddedPlain.match(/^(\S+)(\s{2,})(.*)/);
      if (match) {
        return (
          palette.secondary(match[1]!) +
          palette.fill(match[2]!) +
          palette.dim(match[3]!)
        );
      }
      return palette.text(paddedPlain);
    }
    case "kvMuted": {
      const match = paddedPlain.match(/^(\S+)(\s{2,})(.*)/);
      if (match) {
        return (
          palette.dim(match[1]!) +
          palette.fill(match[2]!) +
          palette.dim(match[3]!)
        );
      }
      return palette.text(paddedPlain);
    }
    case "kvWarm": {
      const match = paddedPlain.match(/^(\S+)(\s{2,})(.*)/);
      if (match) {
        return (
          palette.secondary(match[1]!) +
          palette.fill(match[2]!) +
          palette.warm(match[3]!)
        );
      }
      return palette.text(paddedPlain);
    }
    case "sectionHeader":
      return palette.primaryBold(paddedPlain);
    case "desc":
      return palette.secondary(paddedPlain);
    case "dim":
      return palette.dim(paddedPlain);
    case "empty":
      return onMenuBox ? MenuBox.fill(paddedPlain) : paddedPlain;
    default:
      return palette.text(paddedPlain);
  }
}

function colorizeCmdCell(
  paddedPlain: string,
  style: string,
  onMenuBox = false
): string {
  const palette = onMenuBox ? infoPalMenu : infoPalDefault;
  switch (style) {
    case "header":
      return palette.primaryBold(paddedPlain);
    case "cmd": {
      const slashMatch = paddedPlain.match(/^(\/\S+)(\s+)(.*)/);
      if (slashMatch) {
        return (
          palette.primary(slashMatch[1]!) +
          palette.fill(slashMatch[2]!) +
          palette.secondary(slashMatch[3]!)
        );
      }
      const continuationMatch = paddedPlain.match(/^(\s+)(\S.*)/);
      if (continuationMatch) {
        return (
          palette.fill(continuationMatch[1]!) +
          palette.secondary(continuationMatch[2]!)
        );
      }
      const kvMatch = paddedPlain.match(/^(\S+)(\s{2,})(.*)/);
      if (kvMatch) {
        return (
          palette.primary(kvMatch[1]!) +
          palette.fill(kvMatch[2]!) +
          palette.secondary(kvMatch[3]!)
        );
      }
      return palette.dim(paddedPlain);
    }
    case "empty":
      return onMenuBox ? MenuBox.fill(paddedPlain) : paddedPlain;
    default:
      return palette.dim(paddedPlain);
  }
}

const MIN_ART_WIDTH = 60;

function renderCenteredAscii(
  termCols: number,
  buf: { push(line: string): void } = { push: (line) => console.log(line) }
): void {
  const artLines = CANVAS_ASCII.split("\n").filter((line) => line.trim());
  const artWidth = Math.max(...artLines.map((line) => line.length));

  if (termCols < MIN_ART_WIDTH) {
    const simple = "  canvas";
    const padding = Math.max(0, Math.floor((termCols - simple.length) / 2));
    buf.push(" ".repeat(padding) + C.primaryBold(simple));
    return;
  }

  for (const line of artLines) {
    const padding = Math.max(0, Math.floor((termCols - artWidth) / 2));
    buf.push(" ".repeat(padding) + C.primary(line));
  }
}

function centerText(text: string, termCols: number): string {
  const visibleLen = stripAnsi(text).length;
  const padding = Math.max(0, Math.floor((termCols - visibleLen) / 2));
  return " ".repeat(padding) + text;
}

async function workspaceExists(workspacePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(workspacePath, "session.json"));
    return stat.isFile();
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForKey(): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once("data", () => {
      stdin.setRawMode(false);
      stdin.pause();
      resolve();
    });
  });
}
