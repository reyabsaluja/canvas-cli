import { clearScreen, hideCursor, showCursor, C } from "./screen.js";
import {
  getCourseById,
  getDisplayCourses,
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
  ensureCourseIngested,
  normalizeScopeAfterCourseManagement,
  openAssignmentScope,
  pickAssignmentScope,
  pickCourse,
  pickRecentScope,
  refreshWorkspaceScope,
} from "./app-navigation.js";
import { renderSplashLoading } from "./app-banner.js";
import { showAnnouncementsView } from "./announcements-view.js";
import { isConfigured, getActiveProfile } from "../config/env.js";
import { loginCommand } from "../commands/login.js";
import { modelCommand } from "../commands/model.js";
import { getAIConfig } from "../ai/provider.js";
import { loadStoredCredentialsToEnv } from "../config/load-credentials-to-env.js";
import { clearCredentialCache } from "../config/credentials.js";
import { CanvasCliError, classifyError } from "../errors.js";

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

    if (!isConfigured()) {
      showCursor();
      console.log(C.dim("\n  No Canvas credentials found. Let's get you set up.\n"));
      await loginCommand({ profile: getActiveProfile() });
      clearCredentialCache();
      loadStoredCredentialsToEnv();
      if (!isConfigured()) {
        process.exit(1);
      }
      clearScreen();
    }

    hideCursor();
    renderSplashLoading();

    let services = await connectServices();
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
        getPinOptions: shellContext.getPinOptions,
        getOpenOptions: shellContext.getOpenOptions,
        getLoadedWorkspace: shellContext.getLoadedWorkspace,
        getCourseCache: shellContext.getCourseCache,
        onClear: shellContext.onClear,
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

      if (result.type === "login") {
        showCursor();
        clearScreen();
        await loginCommand({ profile: getActiveProfile() });
        clearCredentialCache();
        loadStoredCredentialsToEnv();
        clearScreen();
        hideCursor();
        services = await connectServices();
        await ensureCourseConfig(services);
        scope = { type: "global" };
        continue;
      }

      if (result.type === "model") {
        showCursor();
        clearScreen();
        const modelResult = await modelCommand(result.args);
        if (modelResult) {
          loadStoredCredentialsToEnv();
          services.aiConfig = getAIConfig();
        }
        clearScreen();
        hideCursor();
        continue;
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

      if (
        nextScope.type === "course" &&
        scope.type !== "course"
      ) {
        const course = getCourseById(services, nextScope.courseId);
        if (course) {
          const ok = await ensureCourseIngested(services, course);
          if (!ok) {
            continue;
          }
        }
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
    const classified = error instanceof CanvasCliError ? error : classifyError(error);
    console.error(C.error(`\n  Failed to connect: ${classified.message}`));
    if (classified.recoveryHint) {
      console.error(C.dim(`  ${classified.recoveryHint}`));
    } else {
      console.error(C.dim("  Check your configuration and try again."));
    }
    process.exit(classified.exitCode);
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

  if (result.type === "announcements") {
    const courses = result.courseId != null && result.courseName
      ? [{ id: result.courseId, name: result.courseName }]
      : getDisplayCourses(services).map((c) => ({ id: c.id, name: c.name }));
    const isGlobal = result.courseId == null;
    const items = isGlobal
      ? await services.radar.getAllAnnouncementsMultiCourse(courses)
      : await services.radar.getAllAnnouncements(result.courseId!, result.courseName!);
    await showAnnouncementsView(items, isGlobal ? "global" : "course", result.courseName, services.radar);
    return runtimeScope;
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

  if (result.type === "course-refresh") {
    const course = getCourseById(services, result.courseId);
    if (course) {
      await ensureCourseIngested(services, course, { refresh: true });
    }
    return runtimeScope;
  }

  return runtimeScope;
}
