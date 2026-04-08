import { loadCourseCache } from "../enrich/cache-loader.js";
import { loadWorkspace } from "../ask/load-workspace.js";
import { updateWorkspaceSessionMeta } from "../workspace/session.js";
import { answerCourseQuestion, answerGlobalQuestion } from "./chat-assistant.js";
import {
  askWorkspaceQuestion,
  createChatContext,
  fetchAssignments,
  fetchUpcomingAssignments,
  getCourseById,
  getRecentWorkspaces,
  getUnavailableConfiguredCourses,
  getWorkspaceLifecycleState,
  hydrateConversationHistory,
  type AppServices,
} from "./services.js";
import {
  loadOrCreateChatSession,
  saveChatSession,
} from "./chat-sessions.js";
import type { AppScope } from "./chat-state.js";
import type { AssignmentWorkup } from "../work/types.js";
import type { Assignment } from "../domain/models.js";
import { renderGlobalBanner } from "./app-banner.js";
import {
  buildCourseIntroMessages,
  buildGlobalIntroMessages,
  buildWorkspaceIntroMessages,
  buildWorkspacePinOptions,
  formatWorkspaceStatusLabel,
  resolveWorkspacePinContent,
} from "./app-workspace-content.js";
import { workspaceExists } from "./app-navigation.js";
import type { ShellContext, ShellRuntimeApi } from "./app-types.js";
import {
  buildShellOpenOptions,
  collectOpenableResources,
} from "./open-resources.js";

function getGlobalScopeLabel(): string {
  const schoolUrl = process.env.CANVAS_BASE_URL ?? "";
  try {
    return new URL(schoolUrl.replace("/api/v1", "")).hostname || "global";
  } catch {
    return schoolUrl.replace(/https?:\/\//, "").replace(/\/api\/v1.*/, "") || "global";
  }
}

export async function createShellContext(
  services: AppServices,
  scope: AppScope
): Promise<ShellContext> {
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
        scopeLabel: getGlobalScopeLabel(),
        placeholder: "Ask about your courses, or use /courses and /recent",
      },
      bannerRenderer: (buf) => renderGlobalBanner(buf, services, recent),
      onClear: async () => buildGlobalIntroMessages(recent, [], unavailableCourses),
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
          onToolCall: callbacks.onToolCall,
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
          scopeLabel: getGlobalScopeLabel(),
          placeholder: "Ask about your courses, or use /courses and /recent",
        },
        onClear: async () =>
          buildGlobalIntroMessages([], [], getUnavailableConfiguredCourses(services)),
        onAsk: async () => ({
          content: "That course is no longer available. Use /courses to pick another one.",
        }),
      };
    }

    let assignments: Assignment[] = [];
    let cache = null as Awaited<ReturnType<typeof loadCourseCache>>;
    let openOptions = [] as ReturnType<typeof buildShellOpenOptions>;
    let hydrationPromise: Promise<void> | null = null;
    const session = await loadOrCreateChatSession(scope, {
      title: course.name,
      metadata: {
        courseId: course.id,
        courseName: course.name,
        courseCode: course.courseCode,
      },
      initialMessages: buildCourseIntroMessages(course, [], false),
    });
    const shouldPostHydrationMessage = session.messages.length <= 1;

    const setCourseStatus = (
      runtime: ShellContext["runtime"],
      statusLabel?: string
    ): void => {
      runtime.statusLabel = statusLabel;
    };

    const hydrateCourseData = async (api?: ShellRuntimeApi): Promise<void> => {
      if (hydrationPromise) {
        return hydrationPromise;
      }

      hydrationPromise = (async () => {
        const runtime = api?.runtime;
        if (runtime) {
          setCourseStatus(runtime, "Status: loading course data");
          api.render();
        }

        try {
          const [nextAssignments, nextCache] = await Promise.all([
            fetchAssignments(services, course.id, course.name).catch(() => []),
            loadCourseCache(course.courseCode, course.id),
          ]);
          assignments = nextAssignments;
          cache = nextCache;
          openOptions = nextCache
            ? buildShellOpenOptions(
                await collectOpenableResources({ cache: nextCache })
              )
            : [];

          if (runtime) {
            setCourseStatus(
              runtime,
              nextCache ? "Status: course data ready" : "Status: assignments ready"
            );
          }

          if (api && shouldPostHydrationMessage) {
            const nextMessage = buildCourseIntroMessages(
              course,
              nextAssignments,
              nextCache !== null
            )[0];
            if (
              nextMessage &&
              api.session.messages[api.session.messages.length - 1]?.content !==
              nextMessage.content
            ) {
              await api.addMessage(nextMessage);
            }
          }
        } catch (error) {
          if (runtime) {
            setCourseStatus(runtime, "Status: course data unavailable");
          }
          if (api && shouldPostHydrationMessage) {
            const message = `Course data could not finish loading: ${
              error instanceof Error ? error.message : "unknown error"
            }`;
            if (
              api.session.messages[api.session.messages.length - 1]?.content !==
              message
            ) {
              await api.addMessage({
                role: "system",
                content: message,
              });
            }
          }
        }
      })();

      return hydrationPromise;
    };

    return {
      session,
      runtime: {
        scope,
        title: course.name,
        subtitle: course.courseCode,
        scopeLabel: `Course: ${course.name}`,
        statusLabel: "Status: loading course data",
        placeholder: "Ask about this course, or use /assignments",
      },
      getOpenOptions: () => openOptions,
      onClear: async () => {
        await hydrateCourseData();
        return buildCourseIntroMessages(course, assignments, cache !== null);
      },
      onReady: async (api) => {
        await hydrateCourseData(api);
      },
      onAsk: async (input, callbacks) => {
        if (!services.aiConfig) {
          return {
            content:
              "AI is unavailable because no provider key is configured. Course navigation commands still work.",
          };
        }
        await hydrateCourseData();
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
      getCourseCache: () => cache,
    };
  }

  return loadOrCreateWorkspaceShell(services, scope);
}

async function loadOrCreateWorkspaceShell(
  services: AppServices,
  scope: Extract<AppScope, { type: "workspace" }>
): Promise<ShellContext> {
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
        scopeLabel: getGlobalScopeLabel(),
        placeholder: "Ask about your courses, or use /courses and /recent",
      },
      bannerRenderer: (buf) => renderGlobalBanner(buf, services, []),
      onClear: async () => buildGlobalIntroMessages([], [], unavailableCourses),
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
  const openOptions = buildShellOpenOptions(
    await collectOpenableResources({ loaded, cache })
  );
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

  const session = await loadOrCreateChatSession(
    {
      type: "workspace",
      workspacePath: scope.workspacePath,
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
        workspacePath: scope.workspacePath,
        sessionSlug: loaded.sessionSlug,
      },
      initialMessages: buildWorkspaceIntroMessages(loaded, workup, lifecycleState),
    }
  );

  const chatContext = services.aiConfig
    ? createChatContext(services.aiConfig, loaded, {
        cache,
        client: services.client,
        config: services.config,
        courseId: courseId ?? null,
      })
    : null;
  if (chatContext) {
    hydrateConversationHistory(chatContext, session.messages);
  }

  return {
    session,
    runtime: {
      scope,
      title: loaded.assignmentName,
      subtitle:
        lifecycleState === "stale"
          ? `${loaded.courseName} · stale workspace`
          : loaded.courseName,
      scopeLabel: `Workspace: ${loaded.courseName} / ${loaded.assignmentName}`,
      statusLabel: formatWorkspaceStatusLabel(lifecycleState),
      placeholder: "Ask about this assignment, or use /help",
    },
    getLoadedWorkspace: () => loaded,
    getCourseCache: () => cache,
    getOpenOptions: () => openOptions,
    onClear: async () => {
      const nextMessages = buildWorkspaceIntroMessages(loaded, workup, lifecycleState);
      if (chatContext) {
        hydrateConversationHistory(chatContext, nextMessages);
      }
      return nextMessages;
    },
    pinOptions: buildWorkspacePinOptions(loaded, cache),
    resolvePinContent: async (pin) => resolveWorkspacePinContent(loaded, cache, pin),
    onAsk: async (input, callbacks) => {
      if (!services.aiConfig || !chatContext) {
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
        chatContext,
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
