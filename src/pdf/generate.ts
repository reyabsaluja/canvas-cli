import fsp from "node:fs/promises";
import path from "node:path";
import { callModel, formatAIError } from "../ai/provider.js";
import { buildPdfContextBundle, type PdfContextInput } from "./context.js";
import { renderMarkdownToPdf } from "./render.js";
import {
  buildLatexDocument,
  compileLatex,
  getLatexCompiler,
  sanitizeLatexBody,
  extractLatexTitle,
  LATEX_COMPOSE_SYSTEM_PROMPT,
} from "./render-latex.js";

export interface PdfExportResult {
  title: string;
  pdfPath: string;
  markdownPath: string;
  usedAI: boolean;
  usedLatex: boolean;
  warning?: string;
}

const MARKDOWN_COMPOSE_SYSTEM_PROMPT = `You create concise, high-quality PDF-ready Markdown documents from canvas-cli chat and workspace context.

Return Markdown only — no code fences around the entire document, no preamble.

Critical rules:
- Be CONCISE. A typical document is 1-4 pages when printed. Do NOT pad with filler.
- Every sentence must add value. Cut anything a student would skip.
- Infer the best document type: study guide, assignment brief, cheat sheet, checklist, summary, or action plan.
- Use ## and ### headings to organize. Use bullet lists for quick scanning.
- Use Markdown tables when comparing items or listing structured data (dates, scores, options).
- Preserve due dates, deliverables, constraints, source names, and open questions.
- Do not invent facts beyond the supplied context.
- If the request is vague, produce the most useful possible summary of the conversation and workspace.
- Skip any "Sources" section if there are fewer than 3 distinct sources.
- Never mention AI, PDF generation, or canvas-cli in the document body.
- Never repeat the same information in multiple sections.`;

export async function generatePdfExport(
  input: PdfContextInput
): Promise<PdfExportResult> {
  const bundle = buildPdfContextBundle(input);
  const latexCompiler = getLatexCompiler();

  if (latexCompiler && input.aiConfig) {
    return generateLatexPdf(input, bundle, latexCompiler);
  }

  return generateMarkdownPdf(input, bundle);
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
    const raw = await callModel(input.aiConfig!, LATEX_COMPOSE_SYSTEM_PROMPT, userMessage);
    latexBody = sanitizeLatexBody(raw);
  } catch (error) {
    usedAI = false;
    warning = `AI composition failed: ${formatAIError(error)}. Using fallback.`;
    latexBody = buildFallbackLatexBody(bundle);
  }

  const finalTitle = extractLatexTitle(latexBody) ?? title;
  const fullTex = buildLatexDocument(latexBody, {
    title: finalTitle,
    subtitle: input.runtime.title,
    generatedAt: bundle.generatedAt,
  });

  const texPath = path.join(bundle.outputDirectory, `${outputBaseName}.tex`);
  const markdownPath = path.join(bundle.outputDirectory, `${outputBaseName}.md`);

  await fsp.writeFile(texPath, fullTex, "utf-8");
  await fsp.writeFile(markdownPath, latexBody, "utf-8");

  const result = await compileLatex(texPath, compiler);

  if (result.success) {
    return {
      title: finalTitle,
      pdfPath: result.pdfPath,
      markdownPath: texPath,
      usedAI,
      usedLatex: true,
      warning,
    };
  }

  warning = (warning ? warning + " " : "") +
    "LaTeX compilation failed — falling back to PDFKit renderer.";

  return generateMarkdownPdf(input, bundle, warning);
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
    const raw = await callModel(input.aiConfig, MARKDOWN_COMPOSE_SYSTEM_PROMPT, userMessage);
    const markdown = normalizeModelMarkdown(raw, bundle.suggestedTitle);
    return { markdown, usedAI: true };
  } catch (error) {
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
  for (const line of contextLines) {
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!;
      if (level === 1) lines.push(String.raw`\section{${escapeLatex(text)}}`);
      else if (level === 2) lines.push(String.raw`\subsection{${escapeLatex(text)}}`);
      else lines.push(String.raw`\subsubsection{${escapeLatex(text)}}`);
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      lines.push(String.raw`\begin{itemize}`);
      lines.push(String.raw`  \item ${escapeLatex(line.slice(2))}`);
      lines.push(String.raw`\end{itemize}`);
      continue;
    }
    lines.push(escapeLatex(line));
  }
  return lines.join("\n");
}

function escapeLatex(text: string): string {
  return text
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
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
