import { getAIConfig } from "../ai/provider.js";
import { generatePdfExport, type PdfExportResult, type PdfProgressCallback } from "../pdf/generate.js";
import type { PdfContextInput } from "../pdf/context.js";
import type { LoadedWorkspace } from "../ask/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import type { ChatSession, ScopeRuntime } from "./chat-state.js";
import type { PdfRenderMode } from "./pdf-latex-prompt.js";

export interface MakePdfRequest {
  instruction: string;
  session: ChatSession;
  runtime: ScopeRuntime;
  getLoadedWorkspace?: () => LoadedWorkspace | null;
  getCourseCache?: () => CourseCache | null;
  abortSignal?: AbortSignal;
  renderMode?: PdfRenderMode;
  onProgress?: PdfProgressCallback;
}

const MAKE_PDF_PATTERN = /\/(?:make-pdf|pdf)\b/i;

/**
 * Returns the instruction text and whether /make-pdf was found.
 * Handles both prefix (`/make-pdf study guide`) and suffix (`make study guide /make-pdf`).
 */
export function extractMakePdf(input: string): {
  triggered: boolean;
  instruction: string;
} {
  const trimmed = input.trim();

  if (!MAKE_PDF_PATTERN.test(trimmed)) {
    return { triggered: false, instruction: "" };
  }

  const cleaned = trimmed
    .replace(MAKE_PDF_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();

  return { triggered: true, instruction: cleaned };
}

export async function executeMakePdf(
  request: MakePdfRequest
): Promise<PdfExportResult> {
  const aiConfig = getAIConfig();
  const loaded = request.getLoadedWorkspace?.() ?? null;
  const cache = request.getCourseCache?.() ?? null;

  const input: PdfContextInput = {
    instruction: request.instruction,
    session: request.session,
    runtime: request.runtime,
    loaded,
    cache,
    aiConfig,
    abortSignal: request.abortSignal,
  };

  return generatePdfExport(
    input,
    {
      renderMode: request.renderMode,
      onProgress: request.onProgress,
    }
  );
}
