import { loadWorkspaceExtractedFiles } from "./load-workspace.js";
import type { LoadedWorkspace, ContentChunk } from "./types.js";

/**
 * Build content chunks from workspace artifacts.
 * Splits markdown into sections, flattens workup JSON fields,
 * and includes extracted document text.
 */
export async function buildChunks(ws: LoadedWorkspace): Promise<ContentChunk[]> {
  const chunks: ContentChunk[] = [];

  // Workup JSON fields as individual chunks (highest signal)
  if (ws.workupJson) {
    const w = ws.workupJson;

    if (typeof w.overview === "string") {
      chunks.push({
        source: "workup.json",
        section: "Overview",
        text: w.overview,
        kind: "workup",
      });
    }

    if (Array.isArray(w.deliverables) && w.deliverables.length > 0) {
      chunks.push({
        source: "workup.json",
        section: "Deliverables",
        text: w.deliverables.join("\n"),
        kind: "workup",
      });
    }

    if (Array.isArray(w.constraints) && w.constraints.length > 0) {
      chunks.push({
        source: "workup.json",
        section: "Constraints",
        text: w.constraints.join("\n"),
        kind: "workup",
      });
    }

    if (
      Array.isArray(w.recommended_read_order) &&
      w.recommended_read_order.length > 0
    ) {
      chunks.push({
        source: "workup.json",
        section: "Recommended read order",
        text: (w.recommended_read_order as string[]).join("\n"),
        kind: "workup",
      });
    }
    // Also try camelCase variant
    if (
      Array.isArray(w.recommendedReadOrder) &&
      w.recommendedReadOrder.length > 0
    ) {
      chunks.push({
        source: "workup.json",
        section: "Recommended read order",
        text: (w.recommendedReadOrder as string[]).join("\n"),
        kind: "workup",
      });
    }

    if (Array.isArray(w.uncertainties) && w.uncertainties.length > 0) {
      chunks.push({
        source: "workup.json",
        section: "Uncertainties",
        text: (w.uncertainties as string[]).join("\n"),
        kind: "workup",
      });
    }

    if (Array.isArray(w.action_plan)) {
      const planText = (w.action_plan as any[])
        .map(
          (s) =>
            `Step ${s.step}: ${s.action}${s.detail ? " — " + s.detail : ""}`
        )
        .join("\n");
      if (planText) {
        chunks.push({
          source: "workup.json",
          section: "Action plan",
          text: planText,
          kind: "workup",
        });
      }
    }
    if (Array.isArray(w.actionPlan)) {
      const planText = (w.actionPlan as any[])
        .map(
          (s: any) =>
            `Step ${s.step}: ${s.action}${s.detail ? " — " + s.detail : ""}`
        )
        .join("\n");
      if (planText) {
        chunks.push({
          source: "workup.json",
          section: "Action plan",
          text: planText,
          kind: "workup",
        });
      }
    }

    if (Array.isArray(w.relevant_resources)) {
      const resText = (w.relevant_resources as any[])
        .map((r) => `${r.title} (${r.type}) — ${r.why}`)
        .join("\n");
      if (resText) {
        chunks.push({
          source: "workup.json",
          section: "Relevant resources",
          text: resText,
          kind: "workup",
        });
      }
    }
    if (Array.isArray(w.relevantResources)) {
      const resText = (w.relevantResources as any[])
        .map((r: any) => `${r.title} (${r.type}) — ${r.why}`)
        .join("\n");
      if (resText) {
        chunks.push({
          source: "workup.json",
          section: "Relevant resources",
          text: resText,
          kind: "workup",
        });
      }
    }

    if (Array.isArray(w.source_trace)) {
      const traceText = (w.source_trace as any[])
        .map((e) => `${e.conclusion} — source: ${e.source}`)
        .join("\n");
      if (traceText) {
        chunks.push({
          source: "workup.json",
          section: "Source trace",
          text: traceText,
          kind: "workup",
        });
      }
    }
    if (Array.isArray(w.sourceTrace)) {
      const traceText = (w.sourceTrace as any[])
        .map((e: any) => `${e.conclusion} — source: ${e.source}`)
        .join("\n");
      if (traceText) {
        chunks.push({
          source: "workup.json",
          section: "Source trace",
          text: traceText,
          kind: "workup",
        });
      }
    }

    if (typeof w.due_date === "string" || typeof w.dueDate === "string") {
      chunks.push({
        source: "workup.json",
        section: "Due date",
        text: `Due date: ${(w.due_date as string) ?? (w.dueDate as string)}`,
        kind: "workup",
      });
    }
  }

  // assignment.md split into sections
  if (ws.assignmentMd) {
    for (const chunk of splitMarkdown(ws.assignmentMd, "assignment.md", "assignment")) {
      chunks.push(chunk);
    }
  }

  // plan.md split into sections
  if (ws.planMd) {
    for (const chunk of splitMarkdown(ws.planMd, "plan.md", "plan")) {
      chunks.push(chunk);
    }
  }

  // notes.md as a single chunk
  if (ws.notesMd && ws.notesMd.trim().length > 30) {
    chunks.push({
      source: "notes.md",
      section: "User notes",
      text: ws.notesMd,
      kind: "notes",
    });
  }

  // Extracted documents
  for (const ef of await loadWorkspaceExtractedFiles(ws)) {
    // Split large extracted files into ~2000 char chunks
    if (ef.content.length > 3000) {
      const parts = splitByParagraphs(ef.content, 2500);
      for (let i = 0; i < parts.length; i++) {
        chunks.push({
          source: `extracted/${ef.name}`,
          section: `Part ${i + 1}`,
          text: parts[i],
          kind: "extracted",
        });
      }
    } else {
      chunks.push({
        source: `extracted/${ef.name}`,
        section: "Full text",
        text: ef.content,
        kind: "extracted",
      });
    }
  }

  return chunks;
}

/**
 * Retrieve the most relevant chunks for a question using BM25-style keyword scoring.
 * Returns top-K chunks sorted by relevance.
 */
export function retrieveRelevant(
  question: string,
  chunks: ContentChunk[],
  topK: number = 8
): ContentChunk[] {
  const queryTokens = tokenize(question);
  if (queryTokens.length === 0) return chunks.slice(0, topK);

  // IDF: how rare each query token is across chunks
  const docCount = chunks.length;
  const df = new Map<string, number>();
  for (const chunk of chunks) {
    const chunkTokens = new Set(tokenize(chunk.text + " " + chunk.section));
    for (const qt of queryTokens) {
      if (chunkTokens.has(qt)) {
        df.set(qt, (df.get(qt) ?? 0) + 1);
      }
    }
  }

  // Score each chunk
  const scored = chunks.map((chunk) => {
    const text = (chunk.text + " " + chunk.section).toLowerCase();
    const chunkTokens = tokenize(text);
    const tokenSet = new Set(chunkTokens);
    let score = 0;

    for (const qt of queryTokens) {
      if (!tokenSet.has(qt)) continue;

      // Term frequency
      const tf = chunkTokens.filter((t) => t === qt).length;
      // Inverse document frequency
      const docFreq = df.get(qt) ?? 1;
      const idf = Math.log((docCount + 1) / (docFreq + 0.5));
      // BM25-style scoring (k1=1.5, b=0.75)
      const avgLen = chunks.reduce((s, c) => s + c.text.length, 0) / docCount;
      const norm = 1 - 0.75 + 0.75 * (chunk.text.length / avgLen);
      score += idf * ((tf * 2.5) / (tf + 1.5 * norm));
    }

    // Boost workup chunks slightly (structured, high-signal)
    if (chunk.kind === "workup") score *= 1.2;

    return { chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.chunk);
}

// --- Helpers ---

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function splitMarkdown(
  md: string,
  source: string,
  kind: string
): ContentChunk[] {
  const chunks: ContentChunk[] = [];
  const lines = md.split("\n");
  let currentSection = "Top";
  let currentText: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      // Flush previous section
      if (currentText.length > 0) {
        const text = currentText.join("\n").trim();
        if (text.length > 10) {
          chunks.push({ source, section: currentSection, text, kind });
        }
      }
      currentSection = headingMatch[1];
      currentText = [];
    } else {
      currentText.push(line);
    }
  }

  // Flush last section
  if (currentText.length > 0) {
    const text = currentText.join("\n").trim();
    if (text.length > 10) {
      chunks.push({ source, section: currentSection, text, kind });
    }
  }

  return chunks;
}

function splitByParagraphs(text: string, maxChunkLen: number): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const p of paragraphs) {
    if (current.length + p.length > maxChunkLen && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += p + "\n\n";
  }
  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}
