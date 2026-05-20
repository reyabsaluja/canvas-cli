import fsp from "node:fs/promises";
import path from "node:path";
import { callModel, formatAIError } from "../ai/provider.js";
import { buildPdfContextBundle, type PdfContextInput } from "./context.js";
import { renderMarkdownToPdf } from "./render.js";
import {
  buildLatexDocument,
  compileLatex,
  fixCommonLatexIssues,
  formatLatexErrorSummary,
  getLatexCompiler,
  sanitizeLatexBody,
  extractLatexTitle,
  escapeLatex,
  LATEX_COMPOSE_SYSTEM_PROMPT,
  SHARED_CONTENT_RULES,
} from "./render-latex.js";

export type PdfRenderMode = "auto" | "latex" | "basic";

export interface PdfExportResult {
  title: string;
  pdfPath: string;
  markdownPath: string;
  usedAI: boolean;
  usedLatex: boolean;
  warning?: string;
  /** Set when LaTeX was attempted but the final PDF used PDFKit fallback. */
  latexCompileFailed?: boolean;
  texPath?: string;
}

const MARKDOWN_COMPOSE_SYSTEM_PROMPT = `You create thorough, comprehensive, high-quality PDF-ready Markdown documents from canvas-cli chat and workspace context.

Return Markdown only — no code fences around the entire document, no preamble.

Critical rules:
${SHARED_CONTENT_RULES}
- Use ## and ### headings to organize into clear sections. Use bullet lists for quick scanning.
- Use Markdown tables when comparing items or listing structured data (dates, scores, options).`;

const LATEX_REPAIR_SYSTEM_PROMPT = `You fix LaTeX compilation errors in a document body.

Return ONLY the corrected LaTeX body (no preamble, no \\documentclass, no code fences).

Rules:
- Fix the reported errors while preserving all content and structure.
- In \\texttt{...} and tables, escape special characters: _ → \\_ & → \\& % → \\% # → \\# $ → \\$
- Keep math in $...$ or \\[...\\]; do not break lstlisting blocks.
- Do not add commentary or explanations.`;

export async function generatePdfExport(
  input: PdfContextInput,
  options?: { renderMode?: PdfRenderMode }
): Promise<PdfExportResult> {
  const bundle = buildPdfContextBundle(input);
  const renderMode = options?.renderMode ?? "auto";
  const latexCompiler = await getLatexCompiler();
  const wantsLatex =
    renderMode === "latex" ||
    (renderMode === "auto" && latexCompiler !== null && input.aiConfig);

  if (wantsLatex) {
    if (!input.aiConfig) {
      return generateMarkdownPdf(
        input,
        bundle,
        "AI is not configured, so canvas-cli used the basic PDF renderer."
      );
    }
    if (!latexCompiler) {
      throw new Error(
        "LaTeX compiler not found. Install Tectonic (e.g. brew install tectonic) or choose basic PDF."
      );
    }
    return generateLatexPdf(input, bundle, latexCompiler);
  }

  const noLatexWarning =
    renderMode === "auto" && !latexCompiler && input.aiConfig
      ? "No LaTeX compiler found. Install Tectonic for high-quality math and code (brew install tectonic)."
      : undefined;
  return generateMarkdownPdf(input, bundle, noLatexWarning);
}

async function generateLatexPdf(
  input: PdfContextInput,
  bundle: ReturnType<typeof buildPdfContextBundle>,
  compiler: string
): Promise<PdfExportResult> {
  const title = bundle.suggestedTitle;
  const outputBaseName = bundle.outputBaseName;

  await fsp.mkdir(bundle.outputDirectory, { recursive: true });

  const userMessage = [
    `Requested PDF: ${bundle.instruction || "(infer the most useful document)"}`,
    "",
    "Current canvas-cli context:",
    bundle.promptContext,
  ].join("\n");

  let latexBody: string;
  let usedAI = true;
  let warning: string | undefined;

  try {
    const raw = await callModel(input.aiConfig!, LATEX_COMPOSE_SYSTEM_PROMPT, userMessage, { maxTokens: 16_000, timeoutMs: 600_000, abortSignal: input.abortSignal });
    latexBody = sanitizeLatexBody(raw);
  } catch (error) {
    if (input.abortSignal?.aborted) throw error;
    usedAI = false;
    warning = `AI composition failed: ${formatAIError(error)}. Using fallback.`;
    latexBody = buildFallbackLatexBody(bundle);
  }

  const finalTitle = extractLatexTitle(latexBody) ?? title;
  const texPath = path.join(bundle.outputDirectory, `${outputBaseName}.tex`);
  const markdownPath = path.join(bundle.outputDirectory, `${outputBaseName}.md`);

  latexBody = fixCommonLatexIssues(latexBody);
  await fsp.writeFile(markdownPath, latexBody, "utf-8");

  let result = await compileLatexFromBody(
    latexBody,
    texPath,
    compiler,
    {
      title: finalTitle,
      subtitle: input.runtime.title,
      generatedAt: bundle.generatedAt,
    },
    input.abortSignal
  );

  if (!result.success && input.aiConfig && result.errors.length > 0) {
    const repaired = await repairLatexBody(
      latexBody,
      result.errors,
      input.aiConfig,
      input.abortSignal
    );
    if (repaired) {
      latexBody = fixCommonLatexIssues(repaired);
      await fsp.writeFile(markdownPath, latexBody, "utf-8");
      result = await compileLatexFromBody(
        latexBody,
        texPath,
        compiler,
        {
          title: extractLatexTitle(latexBody) ?? finalTitle,
          subtitle: input.runtime.title,
          generatedAt: bundle.generatedAt,
        },
        input.abortSignal
      );
    }
  }

  if (result.success) {
    return {
      title: extractLatexTitle(latexBody) ?? finalTitle,
      pdfPath: result.pdfPath,
      markdownPath,
      usedAI,
      usedLatex: true,
      warning,
      texPath,
    };
  }

  const errorSummary = formatLatexErrorSummary(result.errors);
  warning = (warning ? warning + " " : "") +
    `LaTeX compilation failed (${errorSummary}). Used basic PDF layout instead. Source: ${texPath}`;

  const fallbackMarkdown = usedAI
    ? ensureMarkdownTitle(latexBodyToMarkdown(latexBody), finalTitle)
    : ensureMarkdownTitle(bundle.fallbackMarkdown, bundle.suggestedTitle);

  await fsp.writeFile(markdownPath, fallbackMarkdown, "utf-8");

  const pdfPath = path.join(bundle.outputDirectory, `${outputBaseName}.pdf`);
  await renderMarkdownToPdf(fallbackMarkdown, pdfPath, {
    title: finalTitle,
    subtitle: input.runtime.title,
    generatedAt: bundle.generatedAt,
  });

  return {
    title: finalTitle,
    pdfPath,
    markdownPath,
    usedAI,
    usedLatex: false,
    warning,
    latexCompileFailed: true,
    texPath,
  };
}

async function compileLatexFromBody(
  latexBody: string,
  texPath: string,
  compiler: string,
  docOptions: {
    title: string;
    subtitle?: string;
    generatedAt?: string;
  },
  abortSignal?: AbortSignal
): Promise<Awaited<ReturnType<typeof compileLatex>>> {
  const fullTex = buildLatexDocument(latexBody, docOptions);
  await fsp.writeFile(texPath, fullTex, "utf-8");
  return compileLatex(texPath, compiler, { signal: abortSignal });
}

async function repairLatexBody(
  body: string,
  errors: string[],
  aiConfig: NonNullable<PdfContextInput["aiConfig"]>,
  abortSignal?: AbortSignal
): Promise<string | null> {
  const userMessage = [
    "Compilation errors:",
    ...errors.map((e) => `- ${e}`),
    "",
    "LaTeX body to fix:",
    body,
  ].join("\n");

  try {
    const raw = await callModel(aiConfig, LATEX_REPAIR_SYSTEM_PROMPT, userMessage, {
      maxTokens: 16_000,
      timeoutMs: 120_000,
      abortSignal,
    });
    return sanitizeLatexBody(raw);
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    return null;
  }
}

async function generateMarkdownPdf(
  input: PdfContextInput,
  bundle: ReturnType<typeof buildPdfContextBundle>,
  existingWarning?: string
): Promise<PdfExportResult> {
  const composed = await composeMarkdown(bundle.promptContext, bundle, input);
  const title = extractMarkdownTitle(composed.markdown) ?? bundle.suggestedTitle;
  const outputBaseName = bundle.outputBaseName;
  const pdfPath = path.join(bundle.outputDirectory, `${outputBaseName}.pdf`);
  const markdownPath = path.join(bundle.outputDirectory, `${outputBaseName}.md`);

  await fsp.mkdir(bundle.outputDirectory, { recursive: true });
  await fsp.writeFile(markdownPath, composed.markdown, "utf-8");
  await renderMarkdownToPdf(composed.markdown, pdfPath, {
    title,
    subtitle: input.runtime.title,
    generatedAt: bundle.generatedAt,
  });

  const warning = existingWarning
    ? `${existingWarning} ${composed.warning ?? ""}`.trim()
    : composed.warning;

  return {
    title,
    pdfPath,
    markdownPath,
    usedAI: composed.usedAI,
    usedLatex: false,
    warning: warning || undefined,
  };
}

async function composeMarkdown(
  promptContext: string,
  bundle: ReturnType<typeof buildPdfContextBundle>,
  input: PdfContextInput
): Promise<{ markdown: string; usedAI: boolean; warning?: string }> {
  if (!input.aiConfig) {
    return {
      markdown: ensureMarkdownTitle(bundle.fallbackMarkdown, bundle.suggestedTitle),
      usedAI: false,
      warning:
        "AI is not configured, so canvas-cli exported the current context directly.",
    };
  }

  const userMessage = [
    `Requested PDF: ${bundle.instruction || "(infer the most useful document)"}`,
    "",
    "Current canvas-cli context:",
    promptContext,
  ].join("\n");

  try {
    const raw = await callModel(input.aiConfig, MARKDOWN_COMPOSE_SYSTEM_PROMPT, userMessage, { maxTokens: 16_000, timeoutMs: 600_000, abortSignal: input.abortSignal });
    const markdown = normalizeModelMarkdown(raw, bundle.suggestedTitle);
    return { markdown, usedAI: true };
  } catch (error) {
    if (input.abortSignal?.aborted) throw error;
    return {
      markdown: ensureMarkdownTitle(bundle.fallbackMarkdown, bundle.suggestedTitle),
      usedAI: false,
      warning: `AI composition failed, so canvas-cli exported the current context directly. ${formatAIError(error)}`,
    };
  }
}

function buildFallbackLatexBody(
  bundle: ReturnType<typeof buildPdfContextBundle>
): string {
  const lines: string[] = [];
  if (bundle.instruction) {
    lines.push(String.raw`\section{${escapeLatex(bundle.suggestedTitle)}}`);
    lines.push("");
    lines.push(String.raw`\begin{quotebox}`);
    lines.push(escapeLatex(bundle.instruction));
    lines.push(String.raw`\end{quotebox}`);
    lines.push("");
  }
  lines.push(
    String.raw`\begin{quotebox}`,
    "AI composition was unavailable. This PDF exports the current canvas-cli context directly.",
    String.raw`\end{quotebox}`,
    ""
  );
  const contextLines = bundle.fallbackMarkdown.split("\n");
  let listType: "itemize" | "enumerate" | null = null;
  let inCode = false;
  let codeLang = "";
  const codeBuffer: string[] = [];

  function closeList() {
    if (listType) {
      lines.push(String.raw`\end{${listType}}`);
      listType = null;
    }
  }

  function convertInlineFormatting(text: string): string {
    return escapeLatex(text)
      .replace(/\*\*(.+?)\*\*/g, (_, t) => String.raw`\textbf{${t}}`)
      .replace(/\*(.+?)\*/g, (_, t) => String.raw`\textit{${t}}`)
      .replace(/`(.+?)`/g, (_, t) => String.raw`\texttt{${t}}`);
  }

  for (const line of contextLines) {
    const fenceMatch = line.match(/^```(\w*)$/);
    if (fenceMatch) {
      if (inCode) {
        const langOpt = codeLang ? `[language=${codeLang}]` : "";
        lines.push(String.raw`\begin{lstlisting}${langOpt}`);
        lines.push(...codeBuffer);
        lines.push(String.raw`\end{lstlisting}`);
        codeBuffer.length = 0;
        codeLang = "";
        inCode = false;
      } else {
        closeList();
        inCode = true;
        codeLang = fenceMatch[1] ?? "";
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    const isBullet = line.startsWith("- ") || line.startsWith("* ");
    const numberedMatch = line.match(/^(\d+)[.)]\s+(.+)$/);

    if (!isBullet && !numberedMatch && listType) {
      closeList();
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1]!.length;
      const text = heading[2]!;
      if (level === 1) lines.push(String.raw`\section{${escapeLatex(text)}}`);
      else if (level === 2) lines.push(String.raw`\subsection{${escapeLatex(text)}}`);
      else lines.push(String.raw`\subsubsection{${escapeLatex(text)}}`);
      continue;
    }
    if (isBullet) {
      if (listType !== "itemize") {
        closeList();
        lines.push(String.raw`\begin{itemize}`);
        listType = "itemize";
      }
      lines.push(String.raw`  \item ${convertInlineFormatting(line.slice(2))}`);
      continue;
    }
    if (numberedMatch) {
      if (listType !== "enumerate") {
        closeList();
        lines.push(String.raw`\begin{enumerate}`);
        listType = "enumerate";
      }
      lines.push(String.raw`  \item ${convertInlineFormatting(numberedMatch[2]!)}`);
      continue;
    }
    lines.push(convertInlineFormatting(line));
  }
  closeList();
  if (inCode && codeBuffer.length > 0) {
    lines.push(String.raw`\begin{lstlisting}`);
    lines.push(...codeBuffer);
    lines.push(String.raw`\end{lstlisting}`);
  }
  return lines.join("\n");
}

function normalizeModelMarkdown(raw: string, fallbackTitle: string): string {
  const stripped = stripMarkdownFence(raw).trim();
  const withoutPreamble = stripped.replace(
    /^(?:here(?:'s| is)\s+.*?:|sure[,!.\s]+.*?:)\s*/i,
    ""
  );
  return ensureMarkdownTitle(withoutPreamble, fallbackTitle);
}

function ensureMarkdownTitle(markdown: string, fallbackTitle: string): string {
  const trimmed = markdown.trim();
  if (/^#\s+/m.test(trimmed)) return trimmed;
  return [`# ${fallbackTitle}`, "", trimmed].join("\n").trim();
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  return fenced ? fenced[1] ?? "" : trimmed;
}

function extractMarkdownTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || null;
}

export function latexBodyToMarkdown(latex: string): string {
  return latex
    .replace(/\\section\{([^}]+)\}/g, "# $1")
    .replace(/\\subsection\{([^}]+)\}/g, "## $1")
    .replace(/\\subsubsection\{([^}]+)\}/g, "### $1")
    .replace(/\\textbf\{([^}]+)\}/g, "**$1**")
    .replace(/\\textit\{([^}]+)\}/g, "*$1*")
    .replace(/\\texttt\{([^}]+)\}/g, "`$1`")
    .replace(/\\begin\{itemize\}/g, "")
    .replace(/\\end\{itemize\}/g, "")
    .replace(/\\begin\{enumerate\}/g, "")
    .replace(/\\end\{enumerate\}/g, "")
    .replace(/\\item\s*/g, "- ")
    .replace(/\\begin\{lstlisting\}(\[.*?\])?\s*\n?/g, "```\n")
    .replace(/\\end\{lstlisting\}/g, "```")
    .replace(/\\begin\{(?:quotebox|highlightbox)\}/g, "> ")
    .replace(/\\end\{(?:quotebox|highlightbox)\}/g, "")
    .replace(/\\begin\{tabular\}\{[^}]*\}\s*/g, "")
    .replace(/\\end\{tabular\}/g, "")
    .replace(/\\\\/g, "\n")
    .replace(/\\[&%$#_{}]/g, (m) => m[1]!)
    .replace(/\\textbackslash\{\}/g, "\\")
    .replace(/\\textasciitilde\{\}/g, "~")
    .replace(/\\textasciicircum\{\}/g, "^")
    .replace(/\\vspace\{[^}]*\}/g, "")
    .replace(/\\(?:hfill|noindent|clearpage|newpage|par)\b/g, "")
    .replace(/\{\\color\{[^}]+\}\\hrule[^}]*\}/g, "---")
    .replace(/\\toprule|\\midrule|\\bottomrule/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
