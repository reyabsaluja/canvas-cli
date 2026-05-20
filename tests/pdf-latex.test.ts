import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeLatex,
  sanitizeLatexBody,
  extractLatexTitle,
  buildLatexDocument,
  fixCommonLatexIssues,
  parseLatexCompilerOutput,
  formatLatexErrorSummary,
} from "../src/pdf/render-latex.js";
import { latexBodyToMarkdown } from "../src/pdf/generate.js";
import { getInlineCommandGhost } from "../src/tui/chat-shell-render.js";
import type { CommandDefinition } from "../src/tui/chat-state.js";

// ── fixCommonLatexIssues ──

test("fixCommonLatexIssues escapes unescaped underscores in texttt", () => {
  const input = String.raw`\texttt{..._2023\_solutions.pdf}`;
  const fixed = fixCommonLatexIssues(input);
  assert.equal(fixed, String.raw`\texttt{...\_2023\_solutions.pdf}`);
});

test("fixCommonLatexIssues leaves already-escaped underscores unchanged", () => {
  const input = String.raw`\texttt{final\_exam\_2022.pdf}`;
  assert.equal(fixCommonLatexIssues(input), input);
});

// ── parseLatexCompilerOutput ──

test("parseLatexCompilerOutput extracts tectonic error lines", () => {
  const output = [
    "note: Running TeX ...",
    "error: file.tex:1386: Missing $ inserted",
    "error: halted on potentially-recoverable error",
  ].join("\n");
  assert.deepEqual(parseLatexCompilerOutput(output), [
    "file.tex:1386: Missing $ inserted",
    "halted on potentially-recoverable error",
  ]);
});

test("formatLatexErrorSummary joins errors", () => {
  assert.equal(
    formatLatexErrorSummary(["line 1: bad", "line 2: worse"]),
    "line 1: bad; line 2: worse"
  );
});

// ── escapeLatex ──

test("escapeLatex escapes special characters", () => {
  assert.equal(escapeLatex("100% done & 50$ off"), "100\\% done \\& 50\\$ off");
});

test("escapeLatex escapes backslash, tilde, and caret", () => {
  assert.equal(escapeLatex("a\\b~c^d"), "a\\textbackslash{}b\\textasciitilde{}c\\textasciicircum{}d");
});

test("escapeLatex escapes #, _, {, }", () => {
  assert.equal(escapeLatex("x_y {z} #1"), "x\\_y \\{z\\} \\#1");
});

test("escapeLatex returns empty string unchanged", () => {
  assert.equal(escapeLatex(""), "");
});

test("escapeLatex leaves plain text unchanged", () => {
  assert.equal(escapeLatex("hello world"), "hello world");
});

// ── sanitizeLatexBody ──

test("sanitizeLatexBody strips documentclass preamble", () => {
  const input = "\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nHello\n\\end{document}";
  assert.equal(sanitizeLatexBody(input), "Hello");
});

test("sanitizeLatexBody strips code fences", () => {
  const input = "```latex\n\\section{Title}\n```";
  assert.equal(sanitizeLatexBody(input), "\\section{Title}");
});

test("sanitizeLatexBody strips conversational preamble", () => {
  const input = "Here's the document:\n\\section{Intro}";
  assert.equal(sanitizeLatexBody(input), "\\section{Intro}");
});

test("sanitizeLatexBody leaves clean body unchanged", () => {
  const input = "\\section{Intro}\nSome content.";
  assert.equal(sanitizeLatexBody(input), input);
});

// ── extractLatexTitle ──

test("extractLatexTitle extracts first section title", () => {
  assert.equal(extractLatexTitle("\\section{My Title}\nContent"), "My Title");
});

test("extractLatexTitle returns null when no section exists", () => {
  assert.equal(extractLatexTitle("Just a paragraph."), null);
});

test("extractLatexTitle picks the first section not the second", () => {
  assert.equal(
    extractLatexTitle("\\section{First}\n\\section{Second}"),
    "First"
  );
});

// ── buildLatexDocument ──

test("buildLatexDocument wraps body in document structure", () => {
  const doc = buildLatexDocument("\\section{Hello}", {
    title: "Test Doc",
  });
  assert.match(doc, /\\documentclass/);
  assert.match(doc, /\\begin\{document\}/);
  assert.match(doc, /\\end\{document\}/);
  assert.match(doc, /\\section\{Hello\}/);
  assert.match(doc, /Test Doc/);
});

test("buildLatexDocument includes subtitle and date when provided", () => {
  const doc = buildLatexDocument("Body", {
    title: "Title",
    subtitle: "Subtitle",
    generatedAt: "May 2, 2026",
  });
  assert.match(doc, /Subtitle/);
  assert.match(doc, /Generated May 2, 2026/);
});

test("buildLatexDocument escapes special chars in title", () => {
  const doc = buildLatexDocument("Body", { title: "100% & Done" });
  assert.match(doc, /100\\% \\& Done/);
});

// ── latexBodyToMarkdown ──

test("latexBodyToMarkdown converts sections to headings", () => {
  const md = latexBodyToMarkdown("\\section{Title}\n\\subsection{Sub}\n\\subsubsection{SubSub}");
  assert.match(md, /^# Title/m);
  assert.match(md, /^## Sub/m);
  assert.match(md, /^### SubSub/m);
});

test("latexBodyToMarkdown converts text formatting", () => {
  const md = latexBodyToMarkdown("\\textbf{bold} \\textit{italic} \\texttt{code}");
  assert.match(md, /\*\*bold\*\*/);
  assert.match(md, /\*italic\*/);
  assert.match(md, /`code`/);
});

test("latexBodyToMarkdown converts list items", () => {
  const md = latexBodyToMarkdown("\\begin{itemize}\n\\item first\n\\item second\n\\end{itemize}");
  assert.match(md, /^- first/m);
  assert.match(md, /^- second/m);
});

test("latexBodyToMarkdown converts lstlisting to code fences", () => {
  const md = latexBodyToMarkdown("\\begin{lstlisting}[language=Python]\nprint('hi')\n\\end{lstlisting}");
  assert.match(md, /```/);
  assert.match(md, /print\('hi'\)/);
});

test("latexBodyToMarkdown unescapes special characters", () => {
  const md = latexBodyToMarkdown("50\\% off \\& \\$10 \\#1 a\\_b");
  assert.match(md, /50% off/);
  assert.match(md, /& \$10/);
  assert.match(md, /#1/);
  assert.match(md, /a_b/);
});

test("latexBodyToMarkdown strips tabular wrappers", () => {
  const md = latexBodyToMarkdown("\\begin{tabular}{ll}\nA & B\n\\end{tabular}");
  assert.doesNotMatch(md, /\\begin\{tabular\}/);
  assert.doesNotMatch(md, /\\end\{tabular\}/);
});

// ── getInlineCommandGhost ──

const commands: CommandDefinition[] = [
  { name: "/make-pdf", description: "Generate PDF", scopes: ["global"], aliases: ["/pdf"] },
  { name: "/help", description: "Show help", scopes: ["global"] },
  { name: "/quit", description: "Exit", scopes: ["global"] },
];

test("getInlineCommandGhost returns completion suffix for partial command", () => {
  assert.equal(getInlineCommandGhost("write a guide /mak", commands), "e-pdf");
});

test("getInlineCommandGhost returns empty when no match", () => {
  assert.equal(getInlineCommandGhost("write a guide /zzz", commands), "");
});

test("getInlineCommandGhost returns empty for complete command", () => {
  assert.equal(getInlineCommandGhost("write a guide /make-pdf", commands), "");
});

test("getInlineCommandGhost returns empty for start-of-line slash", () => {
  assert.equal(getInlineCommandGhost("/mak", commands), "");
});

test("getInlineCommandGhost returns empty for too-short partial", () => {
  assert.equal(getInlineCommandGhost("text /", commands), "");
});

test("getInlineCommandGhost matches aliases", () => {
  assert.equal(getInlineCommandGhost("export /pd", commands), "f");
});

test("getInlineCommandGhost returns empty with no commands", () => {
  assert.equal(getInlineCommandGhost("text /mak", undefined), "");
});

test("getInlineCommandGhost returns empty with empty input", () => {
  assert.equal(getInlineCommandGhost("", commands), "");
});
