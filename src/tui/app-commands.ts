import { loadCourseCache } from "../enrich/cache-loader.js";
import type { LoadedWorkspace } from "../ask/types.js";
import type { AssignmentWorkup } from "../work/types.js";
import type { Course } from "../domain/models.js";
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
import {
  buildTimelineOutput,
  fetchTimelineData,
  NO_COURSES_MESSAGE,
  parseTimelineArgs,
} from "./timeline.js";
import { handleLectureQuery } from "./lecture-resources.js";
import { formatCourseFilesList } from "./format-course-files.js";
import { formatCourseModulesList } from "./format-course-modules.js";
import { runDoctor } from "./doctor.js";
import {
  parseGradeArgs,
  matchCourse,
  fetchGradeSummary,
  fetchGradeDetail,
  renderGradeSummary,
  renderGradeDetail,
  renderNeedResult,
} from "./grade-command.js";
import { calculateNeeded } from "./grade-calculator.js";

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

  if (command === "/doctor") {
    const output = await runDoctor();
    await api.addMessage({ role: "assistant", content: output });
    return;
  }

  if (command === "/model") {
    const sub = args.trim().toLowerCase();
    if (sub && sub !== "effort" && sub !== "key") {
      await api.addMessage({ role: "system", content: `└ ERROR: Unknown subcommand "${args.trim()}". Usage: /model [effort | key]` });
      return;
    }
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
    if (command === "/timeline") {
      const courses = getDisplayCourses(services);
      if (courses.length === 0) {
        await api.addMessage({ role: "system", content: NO_COURSES_MESSAGE });
        return;
      }
      return buildTimelineTask(api, services, courses, args);
    }
    if (command === "/grade") {
      const courses = getDisplayCourses(services);
      if (courses.length === 0) {
        await api.addMessage({ role: "system", content: NO_COURSES_MESSAGE });
        return;
      }
      return buildGradeTask(api, services, courses, args, false);
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

    if (command === "/timeline") {
      return buildTimelineTask(api, services, [course], args);
    }

    if (command === "/grade") {
      return buildGradeTask(api, services, [course], args, true);
    }

    if (command === "/assignments") {
      return { type: "assignment-picker", courseId: course.id };
    }

    if (command === "/refresh") {
      return { type: "course-refresh", courseId: course.id };
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

function buildTimelineTask(
  api: CommandApi,
  services: AppServices,
  courses: Course[],
  args: string
): ShellResult | void {
  const { window: windowArg, showAll, error } = parseTimelineArgs(args);
  if (error) {
    void api.addMessage({ role: "system", content: `└ ${error}` });
    return;
  }
  return {
    type: "background-task",
    verb: "Fetching timeline",
    run: async (signal) => {
      const { data, warnings } = await fetchTimelineData(services.client, courses, showAll, signal);
      const output = buildTimelineOutput(data, windowArg, showAll, warnings);
      await api.addMessage({ role: "assistant", content: output });
    },
  };
}

function buildGradeTask(
  api: CommandApi,
  services: AppServices,
  courses: Course[],
  args: string,
  inCourseScope: boolean
): ShellResult | void {
  const parsed = parseGradeArgs(args, inCourseScope);
  if (parsed.error) {
    void api.addMessage({ role: "system", content: `└ ERROR: ${parsed.error}` });
    return;
  }

  if (parsed.mode === "summary") {
    return {
      type: "background-task",
      verb: "Fetching grades",
      run: async (signal) => {
        const { rows, warnings } = await fetchGradeSummary(services.client, courses, signal);
        const output = renderGradeSummary(rows, warnings);
        await api.addMessage({ role: "assistant", content: output });
      },
    };
  }

  if (parsed.mode === "detail") {
    let targetCourse: Course;
    if (parsed.courseName) {
      const match = matchCourse(parsed.courseName, getDisplayCourses(services));
      if (match.error) {
        void api.addMessage({ role: "system", content: `└ ERROR: ${match.error}` });
        return;
      }
      targetCourse = match.course!;
    } else if (courses.length === 1) {
      targetCourse = courses[0]!;
    } else {
      void api.addMessage({ role: "system", content: "└ ERROR: Specify a course name, or use /grade from within a course." });
      return;
    }

    return {
      type: "background-task",
      verb: `Fetching grades for ${targetCourse.courseCode || targetCourse.name}`,
      run: async (signal) => {
        const { data, warnings } = await fetchGradeDetail(services.client, targetCourse, signal);
        const output = renderGradeDetail(targetCourse, data, warnings);
        await api.addMessage({ role: "assistant", content: output });
      },
    };
  }

  // mode === "need"
  let targetCourse: Course;
  if (parsed.courseName) {
    const match = matchCourse(parsed.courseName, getDisplayCourses(services));
    if (match.error) {
      void api.addMessage({ role: "system", content: `└ ERROR: ${match.error}` });
      return;
    }
    targetCourse = match.course!;
  } else if (inCourseScope && courses.length === 1) {
    targetCourse = courses[0]!;
  } else {
    void api.addMessage({ role: "system", content: "└ ERROR: Specify a course name for the need calculator (e.g., /grade need A MATH 240)." });
    return;
  }

  return {
    type: "background-task",
    verb: `Calculating grades for ${targetCourse.courseCode || targetCourse.name}`,
    run: async (signal) => {
      const { data } = await fetchGradeDetail(services.client, targetCourse, signal);
      if (data.currentScore === null) {
        await api.addMessage({ role: "system", content: "No graded assignments yet. Check back after your first score is posted." });
        return;
      }
      const result = calculateNeeded(data, parsed.target!);
      const output = renderNeedResult(targetCourse, result);
      await api.addMessage({ role: "assistant", content: output });
    },
  };
}
