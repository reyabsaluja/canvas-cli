import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import fsp from "node:fs/promises";
import path from "node:path";

export interface LatexRenderOptions {
  title: string;
  subtitle?: string;
  generatedAt?: string;
}

const TEX_COMPILERS = ["tectonic", "pdflatex", "xelatex", "lualatex"] as const;

export async function getLatexCompiler(): Promise<string | null> {
  const whichCmd = process.platform === "win32" ? "where" : "which";
  for (const compiler of TEX_COMPILERS) {
    try {
      await execFileAsync(whichCmd, [compiler], { timeout: 5_000 });
      return compiler;
    } catch {
      continue;
    }
  }
  return null;
}

const PH_BACKSLASH = "";
const PH_TILDE = "";
const PH_CARET = "";

export function escapeLatex(text: string): string {
  return text
    .replace(/\\/g, PH_BACKSLASH)
    .replace(/~/g, PH_TILDE)
    .replace(/\^/g, PH_CARET)
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(new RegExp(PH_BACKSLASH, "g"), "\\textbackslash{}")
    .replace(new RegExp(PH_TILDE, "g"), "\\textasciitilde{}")
    .replace(new RegExp(PH_CARET, "g"), "\\textasciicircum{}");
}

const PREAMBLE = String.raw`\documentclass[11pt,letterpaper]{article}

% ── Encoding & Fonts ──
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{lmodern}

% ── Page Layout ──
\usepackage[
  top=1.15in,
  bottom=1.15in,
  left=1.1in,
  right=1.1in,
  headheight=14pt,
]{geometry}

% ── Colors ──
\usepackage{xcolor}
\definecolor{accent}{HTML}{b91c1c}
\definecolor{accentdark}{HTML}{991b1b}
\definecolor{muted}{HTML}{6b7280}
\definecolor{codebg}{HTML}{f4f4f5}
\definecolor{codetext}{HTML}{374151}
\definecolor{linkblue}{HTML}{1d4ed8}
\definecolor{rulegray}{HTML}{d4d4d8}
\definecolor{quotebg}{HTML}{fafafa}

% ── Typography ──
\usepackage{microtype}
\usepackage{parskip}
\setlength{\parskip}{6pt plus 2pt minus 1pt}

% ── Math ──
\usepackage{amsmath}
\usepackage{amssymb}
\usepackage{mathtools}

% ── Code Listings ──
\usepackage{listings}
\lstset{
  backgroundcolor=\color{codebg},
  basicstyle=\ttfamily\small\color{codetext},
  keywordstyle=\color{accentdark}\bfseries,
  commentstyle=\color{muted}\itshape,
  stringstyle=\color{accent},
  breaklines=true,
  breakatwhitespace=false,
  frame=single,
  framerule=0pt,
  rulecolor=\color{codebg},
  xleftmargin=10pt,
  xrightmargin=10pt,
  framexleftmargin=6pt,
  tabsize=4,
  showstringspaces=false,
  captionpos=b,
  aboveskip=12pt,
  belowskip=8pt,
  numbers=none,
}

% ── Tables ──
\usepackage{booktabs}
\usepackage{array}
\usepackage{longtable}

% ── Lists ──
\usepackage{enumitem}
\setlist[itemize]{leftmargin=*, nosep, topsep=4pt, itemsep=2pt}
\setlist[enumerate]{leftmargin=*, nosep, topsep=4pt, itemsep=2pt}

% ── Headers & Footers ──
\usepackage{fancyhdr}
\pagestyle{fancy}
\fancyhf{}
\fancyhead[L]{\small\color{accent}\textbf{canvas-cli}}
\fancyhead[R]{\small\color{muted}\nouppercase{\leftmark}}
\fancyfoot[C]{\small\color{muted}Page~\thepage}
\renewcommand{\headrulewidth}{0.5pt}
\renewcommand{\footrulewidth}{0pt}
\renewcommand{\headrule}{\hbox to\headwidth{\color{rulegray}\leaders\hrule height \headrulewidth\hfill}}

% ── Section Formatting ──
\usepackage{titlesec}
\titleformat{\section}
  {\Large\bfseries\color{accent}}
  {\thesection}{0.8em}{}
  [\vspace{-4pt}{\color{rulegray}\titlerule[0.6pt]}]
\titleformat{\subsection}
  {\large\bfseries\color{accentdark}}
  {\thesubsection}{0.7em}{}
\titleformat{\subsubsection}
  {\normalsize\bfseries}
  {\thesubsubsection}{0.6em}{}

\titlespacing*{\section}{0pt}{18pt plus 4pt minus 2pt}{8pt plus 2pt}
\titlespacing*{\subsection}{0pt}{14pt plus 3pt minus 2pt}{6pt plus 2pt}
\titlespacing*{\subsubsection}{0pt}{10pt plus 2pt minus 1pt}{4pt plus 1pt}

% ── Links ──
\usepackage{hyperref}
\hypersetup{
  colorlinks=true,
  linkcolor=accent,
  urlcolor=linkblue,
  citecolor=accent,
  pdfborder={0 0 0},
}

% ── Blockquote Environment ──
\usepackage{mdframed}
\newmdenv[
  topline=false,
  bottomline=false,
  rightline=false,
  linewidth=3pt,
  linecolor=accent,
  backgroundcolor=quotebg,
  innertopmargin=8pt,
  innerbottommargin=8pt,
  innerleftmargin=12pt,
  innerrightmargin=12pt,
  skipabove=10pt,
  skipbelow=10pt,
]{quotebox}

% ── Highlight Box ──
\newmdenv[
  linewidth=1pt,
  linecolor=accent,
  backgroundcolor=codebg,
  innertopmargin=10pt,
  innerbottommargin=10pt,
  innerleftmargin=12pt,
  innerrightmargin=12pt,
  roundcorner=3pt,
  skipabove=10pt,
  skipbelow=10pt,
]{highlightbox}
`;

export function buildLatexDocument(
  body: string,
  options: LatexRenderOptions
): string {
  const title = escapeLatex(options.title);
  const subtitle = options.subtitle
    ? escapeLatex(options.subtitle)
    : "";
  const date = options.generatedAt
    ? escapeLatex(options.generatedAt)
    : "";

  const titleLines = [
    String.raw`\begin{center}`,
    String.raw`  {\small\color{accent}\textbf{canvas-cli}}\\[6pt]`,
    String.raw`  {\LARGE\bfseries ${title}}\\[4pt]`,
  ];
  if (subtitle) {
    titleLines.push(
      String.raw`  {\color{muted}\small ${subtitle}}\\[2pt]`
    );
  }
  if (date) {
    titleLines.push(
      String.raw`  {\color{muted}\footnotesize Generated ${date}}`
    );
  }
  titleLines.push(
    String.raw`\end{center}`,
    String.raw`\vspace{4pt}`,
    String.raw`{\color{rulegray}\hrule height 0.6pt}`,
    String.raw`\vspace{12pt}`
  );

  return [
    PREAMBLE,
    "",
    String.raw`\begin{document}`,
    "",
    titleLines.join("\n"),
    "",
    body,
    "",
    String.raw`\end{document}`,
  ].join("\n");
}

export interface LatexCompileResult {
  success: boolean;
  pdfPath: string;
  log?: string;
  /** Human-readable compiler errors (e.g. from Tectonic). */
  errors: string[];
}

export function parseLatexCompilerOutput(output: string): string[] {
  const errors: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^error:/i.test(trimmed)) {
      errors.push(trimmed.replace(/^error:\s*/i, ""));
    }
  }
  return errors;
}

export function formatLatexErrorSummary(errors: string[]): string {
  if (errors.length === 0) {
    return "LaTeX compilation failed (see the .tex file for details).";
  }
  const preview = errors.slice(0, 3).join("; ");
  return errors.length > 3 ? `${preview}; …` : preview;
}

/** Escape stray underscores inside \\texttt{...} blocks (common model mistake). */
export function fixCommonLatexIssues(body: string): string {
  return body.replace(/\\texttt\{([^}]*)\}/g, (_match, content: string) => {
    const fixed = content.replace(/(?<!\\)_/g, "\\_");
    return `\\texttt{${fixed}}`;
  });
}

export async function compileLatex(
  texPath: string,
  compiler: string,
  options?: { signal?: AbortSignal }
): Promise<LatexCompileResult> {
  const dir = path.dirname(texPath);
  const basename = path.basename(texPath, ".tex");
  const pdfPath = path.join(dir, `${basename}.pdf`);

  try {
    if (compiler === "tectonic") {
      await execFileAsync(compiler, [
        "--outdir", dir,
        texPath,
      ], {
        cwd: dir,
        timeout: 120_000,
        signal: options?.signal,
        maxBuffer: 10 * 1024 * 1024,
      });
    } else {
      for (let pass = 0; pass < 2; pass++) {
        await execFileAsync(compiler, [
          "-interaction=nonstopmode",
          "-halt-on-error",
          `-output-directory=${dir}`,
          texPath,
        ], {
          cwd: dir,
          timeout: 30_000,
          signal: options?.signal,
        });
      }
    }

    await fsp.access(pdfPath);

    const auxExts = [".aux", ".log", ".out", ".toc", ".nav", ".snm"];
    await Promise.allSettled(
      auxExts.map((ext) => fsp.unlink(path.join(dir, `${basename}${ext}`)))
    );

    return { success: true, pdfPath, errors: [] };
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    const logPath = path.join(dir, `${basename}.log`);
    let log: string | undefined;
    try {
      log = await fsp.readFile(logPath, "utf-8");
    } catch {}

    const stderr =
      error &&
      typeof error === "object" &&
      "stderr" in error &&
      error.stderr != null
        ? String(error.stderr)
        : "";
    const stdout =
      error &&
      typeof error === "object" &&
      "stdout" in error &&
      error.stdout != null
        ? String(error.stdout)
        : "";

    const combined = [stderr, stdout, log ?? ""].filter(Boolean).join("\n");
    const errors = parseLatexCompilerOutput(combined);

    return { success: false, pdfPath, log, errors };
  }
}

export function sanitizeLatexBody(raw: string): string {
  let body = raw.trim();
  body = body.replace(/^\\documentclass[\s\S]*?\\begin\{document\}\s*/i, "");
  body = body.replace(/\\end\{document\}\s*$/i, "");
  body = body.replace(/^```(?:latex|tex)?\s*\n/i, "");
  body = body.replace(/\n```\s*$/i, "");
  body = body.replace(
    /^(?:here(?:'s| is)\s+.*?:|sure[,!.\s]+.*?:)\s*/i,
    ""
  );
  return body.trim();
}

export function extractLatexTitle(body: string): string | null {
  const match = body.match(/\\section\{([^}]+)\}/);
  return match?.[1]?.trim() || null;
}

export const SHARED_CONTENT_RULES = `- Be THOROUGH and COMPREHENSIVE. Cover EVERYTHING in the provided context. Do not summarize or abbreviate — expand on every topic, every detail, every concept. A typical document should be 5-15 pages printed.
- Infer the best document type: study guide, assignment brief, cheat sheet, checklist, summary, or action plan — then go deep on it.
- For study guides: explain each concept fully with definitions, examples, and connections to other topics. Include formulas, code snippets, key terms, and practice-ready content.
- For assignment briefs: detail every requirement, constraint, deliverable, resource, and step of the action plan with full explanations.
- Preserve ALL due dates, deliverables, constraints, source names, open questions, lecture content, and module details.
- Include a Sources section listing all referenced materials.
- Do not invent facts beyond the supplied context, but DO fully elaborate on everything that IS in the context.
- If the request is vague, produce the most comprehensive and useful document possible from all available context.
- Never mention AI, PDF generation, or canvas-cli in the document body.
- Never repeat the same information in multiple sections.`;

export const LATEX_COMPOSE_SYSTEM_PROMPT = `You create thorough, comprehensive, high-quality LaTeX document bodies from canvas-cli chat and workspace context.

Return ONLY LaTeX body content. Do NOT include \\documentclass, \\usepackage, \\begin{document}, or \\end{document} — the preamble and document wrapper are handled externally.

The first line of your output should begin the document content directly (e.g., with a \\section{} or paragraph).

Available environments and commands (already loaded in preamble):
- Headings: \\section{Title}, \\subsection{Title}, \\subsubsection{Title}
- Lists: itemize (\\begin{itemize} \\item ... \\end{itemize}), enumerate
- Code blocks: \\begin{lstlisting}[language=Python] ... \\end{lstlisting}
  Supported languages: Python, Java, C, C++, JavaScript, SQL, Bash, R, MATLAB
- Inline code: \\texttt{code here}
- Math: $x^2 + y^2 = z^2$ for inline, \\[ E = mc^2 \\] for display
- Aligned equations: \\begin{align*} a &= b + c \\\\ d &= e + f \\end{align*}
- Tables: \\begin{tabular}{lll} \\toprule H1 & H2 & H3 \\\\ \\midrule ... \\bottomrule \\end{tabular}
- Block quotes: \\begin{quotebox} ... \\end{quotebox}
- Highlight boxes: \\begin{highlightbox} ... \\end{highlightbox}
- Bold: \\textbf{text}, Italic: \\textit{text}, Monospace: \\texttt{text}
- Horizontal rules: \\vspace{6pt}{\\color{rulegray}\\hrule}\\vspace{6pt}

CRITICAL LaTeX escaping — in regular text (NOT in math mode, lstlisting, or \\texttt{}):
- & → \\&
- % → \\%
- $ → \\$ (unless opening/closing math mode)
- # → \\#
- _ → \\_
- { and } → \\{ and \\} (unless used as LaTeX grouping)
- ~ → \\textasciitilde{}
- ^ → \\textasciicircum{} (unless in math mode)

Content rules:
${SHARED_CONTENT_RULES}
- Use proper LaTeX math for ALL mathematical expressions, formulas, and equations.
- Use lstlisting for ALL code snippets — never use verbatim or raw monospace for code.
- Use booktabs tables (\\toprule, \\midrule, \\bottomrule) for structured data comparisons.`;
