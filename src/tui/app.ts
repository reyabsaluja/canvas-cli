import { clearScreen, hideCursor, showCursor, C } from "./screen.js";
import {
  invalidateAssignmentCache,
  initServices,
  type AppServices,
} from "./services.js";
import { loadCourseConfig } from "./course-config.js";
import { runCourseManagement, runCourseSetup } from "./course-setup.js";
import { runChatShell } from "./chat-shell.js";
import { USER_ABORT_EXIT_CODE } from "./chat-shell-exit.js";
import type { AppScope } from "./chat-state.js";
import { COMMANDS } from "./commands.js";
import { createShellContext } from "./app-runtime.js";
import { handleCommand } from "./app-commands.js";
import type { ShellResult } from "./app-types.js";
import { deleteChatSession, getChatSessionId } from "./chat-sessions.js";
import {
  normalizeScopeAfterCourseManagement,
  openAssignmentScope,
  pickAssignmentScope,
  pickCourse,
  pickRecentScope,
  refreshWorkspaceScope,
} from "./app-navigation.js";
import { renderSplashLoading } from "./app-banner.js";

export async function launchApp(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("canvas-cli interactive mode requires a TTY.");
    process.exit(1);
  }

  const handleSigint = (): void => {
    showCursor();
    clearScreen();
    process.exit(USER_ABORT_EXIT_CODE);
  };

  process.once("SIGINT", handleSigint);

  try {
    clearScreen();
    hideCursor();
    renderSplashLoading();

    const services = await connectServices();
    await ensureCourseConfig(services);

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
        getOpenOptions: shellContext.getOpenOptions,
        resolvePinContent: shellContext.resolvePinContent,
        onReady: shellContext.onReady,
        onAsk: shellContext.onAsk,
        onCommand: (command, args, api) =>
          handleCommand(
            command,
            args,
            {
              ...api,
              getLoadedWorkspace: shellContext.getLoadedWorkspace,
              getCourseCache: shellContext.getCourseCache,
            },
            services
          ),
      });

      if (!result || result.type === "quit") {
        showCursor();
        clearScreen();
        return;
      }

      const nextScope = await resolveShellResult(
        services,
        scope,
        shellContext.runtime.scope,
        result
      );
      if (
        shellContext.runtime.scope.type === "global" &&
        nextScope.type !== "global"
      ) {
        await deleteChatSession(getChatSessionId(shellContext.runtime.scope));
      }
      scope = nextScope;
    }
  } finally {
    process.removeListener("SIGINT", handleSigint);
  }
}

async function connectServices(): Promise<AppServices> {
  try {
    return await initServices();
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
}

async function ensureCourseConfig(services: AppServices): Promise<void> {
  let courseConfig = await loadCourseConfig();
  if (!courseConfig || courseConfig.courses.length === 0) {
    clearScreen();
    courseConfig = await runCourseSetup(services.allCourses);
  }
  services.courseConfig = courseConfig;
}

export async function resolveShellResult(
  services: AppServices,
  currentScope: AppScope,
  runtimeScope: AppScope,
  result: ShellResult
): Promise<AppScope> {
  if (result.type === "scope") {
    return result.scope;
  }

  if (result.type === "course-management") {
    clearScreen();
    const updated = await runCourseManagement(
      services.courseConfig ?? { courses: [] },
      services.allCourses
    );
    services.courseConfig = updated;
    invalidateAssignmentCache(services);
    return normalizeScopeAfterCourseManagement(currentScope, services);
  }

  if (result.type === "course-picker") {
    const nextCourse = await pickCourse(services);
    return nextCourse ? { type: "course", courseId: nextCourse.id } : runtimeScope;
  }

  if (result.type === "recent-picker") {
    return (await pickRecentScope(services)) ?? runtimeScope;
  }

  if (result.type === "assignment-picker") {
    return (await pickAssignmentScope(services, result.courseId)) ?? runtimeScope;
  }

  if (result.type === "open-assignment") {
    return (
      (await openAssignmentScope(
        services,
        result.courseId,
        result.assignmentTarget
      )) ?? runtimeScope
    );
  }

  if (result.type === "workspace-refresh") {
    return refreshWorkspaceScope(
      services,
      result.courseId,
      result.assignmentTarget,
      runtimeScope
    );
  }

  return runtimeScope;
}
