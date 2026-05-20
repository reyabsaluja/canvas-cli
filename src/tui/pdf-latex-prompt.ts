import { getAIConfig } from "../ai/provider.js";
import {
  formatLatexManualInstallMessage,
  getRecommendedLatexInstall,
  LATEX_QUALITY_HINT,
  latexCompilerAvailable,
  runLatexInstallCommand,
} from "../pdf/latex-setup.js";
import { showPicker } from "./picker.js";
import { C, clearScreen } from "./screen.js";

export type PdfRenderMode = "latex" | "basic";

export interface PdfRenderModeInputControls {
  pauseInput: () => void;
  resumeInput: () => void;
}

/**
 * Decide whether to use LaTeX or the basic PDFKit path before generation starts.
 * When AI is configured but no compiler is installed, ask interactively.
 */
export async function resolvePdfRenderMode(
  controls: PdfRenderModeInputControls,
  options?: { signal?: AbortSignal }
): Promise<PdfRenderMode | "cancel"> {
  const aiConfig = getAIConfig();
  if (!aiConfig) {
    return "basic";
  }

  if (await latexCompilerAvailable()) {
    return "latex";
  }

  return promptMissingLatexCompiler(controls, options?.signal);
}

async function promptMissingLatexCompiler(
  controls: PdfRenderModeInputControls,
  signal?: AbortSignal
): Promise<PdfRenderMode | "cancel"> {
  while (!signal?.aborted) {
    const choice = await withPausedInput(controls, () =>
      showPicker({
        title: "LaTeX not installed",
        subtitle: LATEX_QUALITY_HINT,
        items: [
          {
            label: "Install LaTeX compiler",
            sublabel: "Recommended for math and code in PDFs",
            description: "Run an install command or check again after installing manually",
            value: "install",
          },
          {
            label: "Use basic PDF",
            sublabel: "No install — simpler layout via PDFKit",
            description: "Works now; math and code blocks are less polished",
            value: "basic",
          },
          {
            label: "Cancel",
            sublabel: "Return to chat",
            value: "cancel",
          },
        ],
        backLabel: "cancel",
      })
    );

    if (!choice || choice === "cancel") {
      return "cancel";
    }

    if (choice === "basic") {
      return "basic";
    }

    const afterInstall = await runInstallFlow(controls, signal);
    if (afterInstall === "latex") {
      return "latex";
    }
    if (afterInstall === "cancel") {
      return "cancel";
    }
  }

  return "cancel";
}

async function runInstallFlow(
  controls: PdfRenderModeInputControls,
  signal?: AbortSignal
): Promise<PdfRenderMode | "retry" | "cancel"> {
  const recipe = await getRecommendedLatexInstall();

  if (recipe) {
    const action = await withPausedInput(controls, () =>
      showPicker({
        title: "Install Tectonic",
        subtitle: recipe.sublabel,
        items: [
          {
            label: `Run install now`,
            sublabel: recipe.command,
            description: "Runs in your terminal; may take a few minutes",
            value: "run",
          },
          {
            label: "I installed it — check again",
            sublabel: "Re-detect LaTeX compiler",
            value: "recheck",
          },
          {
            label: "Show manual install commands",
            sublabel: "macOS, Linux, and Windows",
            value: "manual",
          },
          { label: "Back", value: "back" },
        ],
        backLabel: "back",
      })
    );

    if (!action || action === "back") {
      return "retry";
    }

    if (action === "manual") {
      await showManualInstallNotice(controls);
      return "retry";
    }

    if (action === "run") {
      const result = await runInstallWithInheritedStdio(
        controls,
        recipe.command,
        signal
      );
      if (result === "cancel") {
        return "cancel";
      }
      if (result === "failed") {
        return "retry";
      }
    }
  } else {
    await showManualInstallNotice(controls);
    const recheck = await withPausedInput(controls, () =>
      showPicker({
        title: "After installing",
        items: [
          {
            label: "Check again",
            sublabel: "Re-detect LaTeX compiler",
            value: "recheck",
          },
          { label: "Back", value: "back" },
        ],
        backLabel: "back",
      })
    );
    if (!recheck || recheck === "back") {
      return "retry";
    }
  }

  if (await latexCompilerAvailable()) {
    return "latex";
  }

  await withPausedInput(controls, async () => {
    clearScreen();
    console.log(
      C.warn(
        "\n  LaTeX compiler still not found. Install Tectonic, then try /pdf again.\n"
      )
    );
    await waitForKeypress();
  });

  return "retry";
}

async function runInstallWithInheritedStdio(
  controls: PdfRenderModeInputControls,
  command: string,
  signal?: AbortSignal
): Promise<"ok" | "failed" | "cancel"> {
  controls.pauseInput();
  try {
    clearScreen();
    console.log(C.dim(`\n  Running: ${command}\n`));
    const result = await runLatexInstallCommand(command, { signal });
    if (signal?.aborted) {
      return "cancel";
    }
    if (!result.ok) {
      clearScreen();
      console.log(
        C.warn(
          `\n  Install did not finish successfully${result.error ? `: ${result.error}` : "."}\n`
        )
      );
      console.log(C.dim("  Press any key to continue…"));
      await waitForKeypress();
      return "failed";
    }
    clearScreen();
    console.log(C.success("\n  Install finished. Checking for LaTeX…\n"));
    await waitForKeypress();
    return "ok";
  } finally {
    controls.resumeInput();
  }
}

async function showManualInstallNotice(
  controls: PdfRenderModeInputControls
): Promise<void> {
  await withPausedInput(controls, async () => {
    clearScreen();
    console.log(C.dim(`\n${formatLatexManualInstallMessage()}\n`));
    console.log(C.dim("  Press any key to continue…"));
    await waitForKeypress();
  });
}

async function withPausedInput<T>(
  controls: PdfRenderModeInputControls,
  run: () => Promise<T>
): Promise<T> {
  controls.pauseInput();
  try {
    return await run();
  } finally {
    controls.resumeInput();
  }
}

function waitForKeypress(): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    try { stdin.setRawMode(true); } catch {}
    stdin.resume();
    stdin.once("data", () => {
      try { stdin.setRawMode(wasRaw ?? false); } catch {}
      resolve();
    });
  });
}
