import { loadCourseCache } from "../enrich/cache-loader.js";
import type { LoadedWorkspace } from "../ask/types.js";
import type { AssignmentWorkup } from "../work/types.js";
import {
  getCourseById,
  getDisplayCourses,
  getWorkspaceLifecycleState,
  type AppServices,
} from "./services.js";
import type { CommandApi, ShellResult } from "./app-types.js";
import { resolveGlobalOpen } from "./app-navigation.js";
import { handleOpenResourceQuery } from "./open-resources.js";
import {
  formatRadarItems,
  parseRadarArgs,
  resolveAndRenderThread,
} from "./radar-commands.js";
import { handleLectureQuery } from "./lecture-resources.js";
import { formatCourseFilesList } from "./format-course-files.js";
import { formatCourseModulesList } from "./format-course-modules.js";

export async function handleCommand(
  command: string,
  args: string,
  api: CommandApi,
  services: AppServices
): Promise<ShellResult | null | void> {
  const scope = api.runtime.scope;

  const getCurrentWorkspace = (): LoadedWorkspace | null => {
    return api.getLoadedWorkspace?.() ?? null;
  };

  const getCurrentWorkup = (): AssignmentWorkup | null => {
    return (getCurrentWorkspace()?.workupJson as AssignmentWorkup | null) ?? null;
  };

  if (command === "/quit" || command === "/exit" || command === "/q") {
    return { type: "quit" };
  }

  if (command === "/login") {
    return { type: "login" };
  }

  if (command === "/model") {
    return { type: "model", args: args.trim() || undefined };
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
    if (command === "/announcements") {
      const courses = getDisplayCourses(services);
      if (courses.length === 0) {
        await api.addMessage({ role: "system", content: "No courses configured." });
        return;
      }
      return { type: "announcements" } as const;
    }
    if (command === "/thread") {
      const trimmed = args.trim();
      if (!trimmed) {
        await api.addMessage({ role: "system", content: "Usage: /thread <topic-id or title>" });
        return;
      }
      const courses = getDisplayCourses(services);
      const result = await resolveAndRenderThread(services, courses, trimmed);
      await api.addMessage({
        role: result.found ? "assistant" : "system",
        content: result.content,
      });
      return;
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

    if (command === "/assignments") {
      return { type: "assignment-picker", courseId: course.id };
    }

    if (command === "/open") {
      const cache = await loadCourseCache(course.courseCode, course.id);
      const result = await handleOpenResourceQuery(args.trim(), { cache });
      await api.addMessage({
        role:
          result.status === "opened" || result.status === "listed"
            ? "assistant"
            : "system",
        content: result.message,
      });
      return;
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
        content: formatCourseModulesList(cache),
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
      await api.addMessage({
        role: "assistant",
        content: formatCourseFilesList(cache),
      });
      return;
    }

    if (command === "/announcements") {
      return { type: "announcements", courseId: course.id, courseName: course.name } as const;
    }

    if (command === "/thread") {
      const trimmed = args.trim();
      if (!trimmed) {
        await api.addMessage({ role: "system", content: "Usage: /thread <topic-id or title>" });
        return;
      }
      const result = await resolveAndRenderThread(services, [course], trimmed);
      await api.addMessage({
        role: result.found ? "assistant" : "system",
        content: result.content,
      });
      return;
    }

    if (command === "/lecture" || command === "/lec") {
      const result = await handleLectureQuery(
        args,
        cache,
        services.client,
        course.id
      );
      await api.addMessage({
        role: result.status === "opened" || result.status === "listed" ? "assistant" : "system",
        content: result.message,
      });
      return;
    }

    return;
  }

  if (command === "/overview") {
    const currentWorkup = getCurrentWorkup();
    await api.addMessage({
      role: currentWorkup?.overview ? "assistant" : "system",
      content: currentWorkup?.overview ?? "No workup data available.",
    });
    return;
  }

  if (command === "/requirements" || command === "/reqs") {
    const currentWorkup = getCurrentWorkup();
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
    const currentWorkup = getCurrentWorkup();
    await api.addMessage({
      role:
        currentWorkup && currentWorkup.actionPlan.length > 0 ? "assistant" : "system",
      content:
        currentWorkup && currentWorkup.actionPlan.length > 0
          ? currentWorkup.actionPlan
              .map(
                (step) =>
                  `${step.step}. ${step.action}${step.detail ? `\n   ${step.detail}` : ""}`
              )
              .join("\n")
          : "No action plan available.",
    });
    return;
  }

  if (command === "/resources") {
    const currentWorkup = getCurrentWorkup();
    await api.addMessage({
      role:
        currentWorkup && currentWorkup.relevantResources.length > 0
          ? "assistant"
          : "system",
      content:
        currentWorkup && currentWorkup.relevantResources.length > 0
          ? currentWorkup.relevantResources
              .map(
                (resource) =>
                  `• **${resource.title}** (${resource.type}) — ${resource.why}`
              )
              .join("\n")
          : "No resources listed.",
    });
    return;
  }

  if (command === "/evidence") {
    const currentWorkup = getCurrentWorkup();
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
    const loaded = getCurrentWorkspace();
    if (!loaded) {
      await api.addMessage({
        role: "system",
        content: "Workspace data is not loaded. Reopen the workspace and try again.",
      });
      return;
    }
    const course =
      scope.courseId !== null ? getCourseById(services, scope.courseId) : null;
    const cache =
      api.getCourseCache?.() ??
      (course ? await loadCourseCache(course.courseCode, course.id) : null);
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
        `Status: ${lifecycleState}${
          lifecycleState === "stale" ? " (refresh recommended)" : ""
        }`,
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

  if (command === "/lecture" || command === "/lec") {
    const loaded = getCurrentWorkspace();
    const cache =
      api.getCourseCache?.() ??
      (loaded?.courseCode && loaded?.courseId
        ? await loadCourseCache(loaded.courseCode, loaded.courseId)
        : null);
    const result = await handleLectureQuery(
      args,
      cache,
      services.client,
      loaded?.courseId ?? scope.courseId ?? null
    );
    await api.addMessage({
      role: result.status === "opened" || result.status === "listed" ? "assistant" : "system",
      content: result.message,
    });
    return;
  }

  if (command === "/open") {
    const loaded = getCurrentWorkspace();
    if (!loaded) {
      await api.addMessage({
        role: "system",
        content: "No workspace is loaded right now.",
      });
      return;
    }

    const cache =
      api.getCourseCache?.() ??
      (loaded.courseCode && loaded.courseId
        ? await loadCourseCache(loaded.courseCode, loaded.courseId)
        : null);
    const result = await handleOpenResourceQuery(args, {
      loaded,
      cache,
    });
    await api.addMessage({
      role: result.status === "opened" || result.status === "listed" ? "assistant" : "system",
      content: result.message,
    });
    return;
  }
}
