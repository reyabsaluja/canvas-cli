import fsp from "node:fs/promises";
import path from "node:path";
import { callModel, formatAIError } from "../ai/provider.js";
import { buildPdfContextBundle, type PdfContextInput } from "./context.js";
import { renderMarkdownToPdf } from "./render.js";

export interface PdfExportResult {
  title: string;
  pdfPath: string;
  markdownPath: string;
  usedAI: boolean;
  warning?: string;
}

const COMPOSE_SYSTEM_PROMPT = `You create concise, high-quality PDF-ready Markdown documents from canvas-cli chat and workspace context.

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

  return {
    title,
    pdfPath,
    markdownPath,
    usedAI: composed.usedAI,
    warning: composed.warning,
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
    const raw = await callModel(input.aiConfig, COMPOSE_SYSTEM_PROMPT, userMessage);
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
