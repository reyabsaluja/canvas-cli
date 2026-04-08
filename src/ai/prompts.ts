import type { ContextBundle } from "./context-bundle.js";

export const SYSTEM_PROMPT = `You are an academic assignment context synthesizer. You help a student understand what an assignment is really asking by reading the actual course materials provided to you.

You are given:
- The Canvas assignment metadata (which is often incomplete or just a submission shell)
- The full course module structure
- The full course assignment list with due dates
- The course syllabus text
- The actual text content of downloaded course documents (PDFs, instruction files, rubrics)

Your job:
1. Read all the provided source material carefully
2. Synthesize a clear, direct explanation of what this assignment requires
3. Extract specific tasks and deliverables from the instruction documents
4. If the Canvas due date is missing, try to find it from the syllabus or schedule
5. Cite which documents you got your information from

Rules:
- Be direct and specific. If the instructions say "implement X", say that — don't hedge with "likely" when you have the actual document.
- Only use hedging language when you genuinely don't have the source material.
- Do not solve the assignment or write code/answers.
- Do not repeat the full text of documents — summarize the key requirements.
- If you have the actual PDF/instruction content, base your answer on it directly.
- Keep the overview to 2-4 sentences. Keep tasks specific and actionable.
- Use the exact source labels from the provided context when populating primary_sources.

Respond with valid JSON matching this exact schema:
{
  "overview": "string — 2-4 sentence summary of what this assignment is and what's expected",
  "likely_tasks": ["string — each specific task or deliverable"],
  "due_date": "string or null — due date if found in syllabus/schedule and not already on Canvas",
  "primary_sources": ["string — each source document that informed this"],
  "next_steps": ["string — actionable things the student should do if any info is still missing"],
  "confidence": "high | medium | low"
}

Return ONLY the JSON object. No markdown fencing, no extra text.`;

/**
 * Build the user message from the assembled context bundle.
 */
export function buildUserMessage(bundle: ContextBundle): string {
  const sections: string[] = [];

  sections.push("## Assignment metadata");
  sections.push(`Name: ${bundle.assignmentName}`);
  sections.push(`Course: ${bundle.courseName}`);
  if (bundle.dueDate) {
    sections.push(`Canvas due date: ${bundle.dueDate}`);
  } else {
    sections.push("Canvas due date: NOT SET — please check syllabus/schedule for the real due date");
  }
  if (bundle.pointsPossible !== null) sections.push(`Points: ${bundle.pointsPossible}`);
  if (bundle.gradingType) sections.push(`Grading: ${bundle.gradingType}`);
  if (bundle.submissionTypes.length > 0) {
    sections.push(`Submission types: ${bundle.submissionTypes.join(", ")}`);
  }

  if (bundle.canvasDescriptionText) {
    sections.push("");
    sections.push("## Canvas description");
    sections.push(bundle.canvasDescriptionText);
  }

  if (bundle.assignmentList) {
    sections.push("");
    sections.push("## All course assignments (for cross-referencing dates)");
    sections.push(bundle.assignmentList);
  }

  if (bundle.moduleStructure) {
    sections.push("");
    sections.push("## Course module structure");
    sections.push(bundle.moduleStructure);
  }

  if (bundle.extractedTexts.length > 0) {
    sections.push("");
    sections.push("## Source documents (actual content)");
    for (const ext of bundle.extractedTexts) {
      sections.push("");
      sections.push(`### ${ext.source}`);
      sections.push(`Selected because: ${ext.selectionReason}`);
      sections.push(ext.content);
    }
  }

  sections.push("");
  sections.push("Based on all the above materials, provide a clear summary of what this assignment requires.");

  return sections.join("\n");
}
