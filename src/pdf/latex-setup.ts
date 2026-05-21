import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { getLatexCompiler } from "./render-latex.js";

const execFileAsync = promisify(execFile);

export interface LatexInstallRecipe {
  label: string;
  sublabel: string;
  command: string;
}

export const LATEX_QUALITY_HINT =
  "LaTeX produces higher-quality PDFs with proper math, code listings, and tables.";

export const LATEX_MANUAL_INSTALL_LINES = [
  "macOS (Homebrew):  brew install tectonic",
  "Linux:             see https://tectonic-typesetting.github.io/install",
  "Windows (Chocolatey): choco install tectonic",
] as const;

async function commandExists(command: string): Promise<boolean> {
  const whichCmd = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(whichCmd, [command], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function getRecommendedLatexInstall(): Promise<LatexInstallRecipe | null> {
  if (process.platform === "darwin" && (await commandExists("brew"))) {
    return {
      label: "Install with Homebrew",
      sublabel: "brew install tectonic",
      command: "brew install tectonic",
    };
  }

  if (process.platform === "win32" && (await commandExists("choco"))) {
    return {
      label: "Install with Chocolatey",
      sublabel: "choco install tectonic",
      command: "choco install tectonic",
    };
  }

  if (process.platform === "win32" && (await commandExists("scoop"))) {
    return {
      label: "Install with Scoop",
      sublabel: "scoop install tectonic",
      command: "scoop install tectonic",
    };
  }

  return null;
}

export function formatLatexManualInstallMessage(): string {
  return [
    "No LaTeX compiler is installed. Install Tectonic (recommended):",
    ...LATEX_MANUAL_INSTALL_LINES.map((line) => `  ${line}`),
  ].join("\n");
}

export async function runLatexInstallCommand(
  command: string,
  options?: { signal?: AbortSignal }
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: "inherit",
      env: process.env,
      signal: options?.signal,
    });

    child.on("error", (error) => {
      resolve({
        ok: false,
        error: error instanceof Error ? error.message : "install failed",
      });
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      resolve({
        ok: false,
        error: code === null ? "install interrupted" : `install exited with code ${code}`,
      });
    });
  });
}

export async function latexCompilerAvailable(): Promise<boolean> {
  return (await getLatexCompiler()) !== null;
}
