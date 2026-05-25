import type { LoadedWorkspace } from "../ask/types.js";
import type { CourseCache } from "../enrich/cache-loader.js";
import type { AIProviderConfig } from "../ai/provider.js";
import { callModel } from "../ai/provider.js";
import {
  loadArtifactIndex,
  readArtifactContent,
  searchArtifacts,
} from "../knowledge/artifact-index.js";

export interface QuizArgs {
  count: number;
  difficulty: "easy" | "medium" | "hard";
  topic: string | null;
  flashcard: boolean;
  error?: string;
}

export interface MCQuestion {
  type: "mc";
  topic: string;
  difficulty: string;
  stem: string;
  choices: { label: string; text: string }[];
  answer: string;
  explanation: string;
}

export interface TFQuestion {
  type: "tf";
  topic: string;
  difficulty: string;
  stem: string;
  answer: boolean;
  explanation: string;
}

export interface FillQuestion {
  type: "fill";
  topic: string;
  difficulty: string;
  stem: string;
  accepted: string[];
  explanation: string;
}

export interface FlashQuestion {
  type: "flash";
  topic: string;
  term: string;
  definition: string;
}

export type QuizQuestion = MCQuestion | TFQuestion | FillQuestion | FlashQuestion;

export interface QuizResult {
  questions: QuizQuestion[];
  answers: (boolean | null)[];
  times: number[];
}

export function parseQuizArgs(args: string): QuizArgs {
  const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let count = 5;
  let difficulty: "easy" | "medium" | "hard" = "medium";
  let flashcard = false;
  const topicParts: string[] = [];

  for (const part of parts) {
    if (part === "flash" || part === "flashcard" || part === "flashcards") {
      flashcard = true;
    } else if (part === "easy") {
      difficulty = "easy";
    } else if (part === "medium") {
      difficulty = "medium";
    } else if (part === "hard") {
      difficulty = "hard";
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n > 0 && n <= 20) {
        count = n;
      } else {
        return { count, difficulty, topic: null, flashcard, error: "Question count must be between 1 and 20." };
      }
    } else {
      topicParts.push(part);
    }
  }

  const topic = topicParts.length > 0 ? topicParts.join(" ") : null;
  return { count, difficulty, topic, flashcard };
}

export async function gatherMaterial(
  workspace: LoadedWorkspace | null,
  cache: CourseCache | null,
  topic: string | null,
  conversationContext?: string
): Promise<{ material: string; courseName: string | null }> {
  const chunks: string[] = [];
  let courseName: string | null = null;

  if (conversationContext) {
    chunks.push("--- Recent conversation context ---\n" + conversationContext);
  }

  if (workspace) {
    courseName = workspace.courseName || null;
    if (workspace.assignmentMd) {
      chunks.push("--- Assignment ---\n" + workspace.assignmentMd.slice(0, 8000));
    }
    if (workspace.planMd) {
      chunks.push("--- Study Plan ---\n" + workspace.planMd.slice(0, 4000));
    }
  }

  const index = await loadArtifactIndex({ workspace, cache });
  if (!index) {
    return { material: chunks.join("\n\n"), courseName };
  }

  if (!courseName && cache) {
    courseName = cache.coursePath?.split("/").pop() ?? null;
  }

  if (topic) {
    const results = searchArtifacts(index, topic, { limit: 8 });
    for (const result of results) {
      const content = await readArtifactContent(index, result.artifact.id);
      if (content) {
        chunks.push(`--- ${result.artifact.title} ---\n${content.slice(0, 6000)}`);
      }
      if (chunks.join("\n\n").length > 25000) break;
    }
  } else {
    const allArtifacts = index.artifacts.slice(0, 10);
    for (const artifact of allArtifacts) {
      const content = await readArtifactContent(index, artifact.id);
      if (content) {
        chunks.push(`--- ${artifact.title} ---\n${content.slice(0, 5000)}`);
      }
      if (chunks.join("\n\n").length > 25000) break;
    }
  }

  if (chunks.length === 0) {
    return { material: "", courseName };
  }

  return { material: chunks.join("\n\n").slice(0, 30000), courseName };
}

export async function generateQuestions(
  config: AIProviderConfig,
  material: string,
  args: QuizArgs,
  signal?: AbortSignal
): Promise<QuizQuestion[]> {
  const typeInstruction = args.flashcard
    ? 'Generate ONLY flashcard questions with type "flash".'
    : 'Generate a mix of question types: "mc" (multiple choice, majority), "tf" (true/false), and "fill" (fill-in-the-blank). Roughly 60% mc, 20% tf, 20% fill.';

  const difficultyGuide = {
    easy: "Focus on recall and recognition: definitions, terminology, direct facts from the material.",
    medium: "Focus on comprehension and application: apply concepts to scenarios, identify why something works.",
    hard: "Focus on analysis and synthesis: multi-step reasoning, edge cases, combining multiple concepts, 'what would happen if' scenarios.",
  }[args.difficulty];

  const systemPrompt = `You are a quiz generator for educational content. Generate exactly ${args.count} questions based on the provided course material.

${typeInstruction}

Difficulty level: ${args.difficulty}
${difficultyGuide}

${args.topic ? `Focus specifically on content related to: "${args.topic}"` : "Cover the breadth of the provided material."}

Respond with ONLY a JSON object in this exact format (no markdown, no code fences):
{
  "questions": [
    {
      "type": "mc",
      "topic": "Short topic label",
      "difficulty": "${args.difficulty}",
      "stem": "The question text",
      "choices": [
        { "label": "a", "text": "First choice" },
        { "label": "b", "text": "Second choice" },
        { "label": "c", "text": "Third choice" },
        { "label": "d", "text": "Fourth choice" }
      ],
      "answer": "b",
      "explanation": "Brief explanation of why this is correct"
    },
    {
      "type": "tf",
      "topic": "Short topic label",
      "difficulty": "${args.difficulty}",
      "stem": "A statement that is true or false",
      "answer": true,
      "explanation": "Brief explanation"
    },
    {
      "type": "fill",
      "topic": "Short topic label",
      "difficulty": "${args.difficulty}",
      "stem": "A sentence with a __________ to fill in",
      "accepted": ["answer1", "answer2", "alternate spelling"],
      "explanation": "Brief explanation"
    },
    {
      "type": "flash",
      "topic": "Short topic label",
      "term": "Term or concept name",
      "definition": "Clear, concise definition or explanation"
    }
  ]
}

Rules:
- Questions must be derived from the provided material, not general knowledge
- Each question should cover a different aspect of the material
- Explanations should be educational and reinforce learning
- For MC questions, make distractors plausible but clearly wrong
- For fill-in-the-blank, provide 2-3 acceptable answer variations
- Keep stems concise but unambiguous`;

  const userMessage = `Here is the course material to generate questions from:\n\n${material}`;

  const response = await callModel(config, systemPrompt, userMessage, {
    maxTokens: 4096,
    abortSignal: signal,
  });

  const cleaned = response.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const parsed = JSON.parse(cleaned);
  return parsed.questions ?? [];
}

export async function checkConversationRelevance(
  config: AIProviderConfig,
  conversationContext: string,
  signal?: AbortSignal
): Promise<boolean> {
  const response = await callModel(
    config,
    `Does this conversation reference specific academic or course content (e.g. assignments, topics, concepts, lectures, problems)? Reply ONLY "yes" or "no".`,
    conversationContext,
    { maxTokens: 5, abortSignal: signal }
  );
  return response.trim().toLowerCase().startsWith("yes");
}

