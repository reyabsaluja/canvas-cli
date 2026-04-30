import { truncateAnsiToWidth, visibleWidth } from "./screen.js";

const COMMAND_SYMBOLS: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  Delta: "Δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  Theta: "Θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  Lambda: "Λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  Xi: "Ξ",
  pi: "π",
  Pi: "Π",
  rho: "ρ",
  varrho: "ϱ",
  sigma: "σ",
  Sigma: "Σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  Phi: "Φ",
  chi: "χ",
  psi: "ψ",
  Psi: "Ψ",
  omega: "ω",
  Omega: "Ω",
  nabla: "∇",
  partial: "∂",
  infty: "∞",
  cdot: "⋅",
  times: "×",
  div: "÷",
  pm: "±",
  mp: "∓",
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  neq: "≠",
  ne: "≠",
  approx: "≈",
  sim: "∼",
  equiv: "≡",
  propto: "∝",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  Leftrightarrow: "⇔",
  implies: "⇒",
  mapsto: "↦",
  in: "∈",
  notin: "∉",
  subset: "⊂",
  subseteq: "⊆",
  superset: "⊃",
  supseteq: "⊇",
  union: "∪",
  cap: "∩",
  emptyset: "∅",
  forall: "∀",
  exists: "∃",
  neg: "¬",
  land: "∧",
  lor: "∨",
  perp: "⊥",
  parallel: "∥",
  angle: "∠",
  degree: "°",
  int: "∫",
  iint: "∬",
  iiint: "∭",
  oint: "∮",
  sum: "∑",
  prod: "∏",
  sqrt: "√",
};

const SPACING_COMMANDS: Record<string, string> = {
  ",": " ",
  ":": " ",
  ";": " ",
  " ": " ",
  quad: "    ",
  qquad: "        ",
  enspace: " ",
  thinspace: " ",
  medspace: " ",
  thickspace: " ",
  "!": "",
};

const FUNCTION_COMMANDS = new Set([
  "arccos",
  "arcsin",
  "arctan",
  "arg",
  "cos",
  "cosh",
  "cot",
  "coth",
  "csc",
  "deg",
  "det",
  "dim",
  "exp",
  "gcd",
  "hom",
  "inf",
  "ker",
  "lg",
  "lim",
  "liminf",
  "limsup",
  "ln",
  "log",
  "max",
  "min",
  "Pr",
  "sec",
  "sin",
  "sinh",
  "sup",
  "tan",
  "tanh",
]);

const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  a: "ᵃ",
  b: "ᵇ",
  c: "ᶜ",
  d: "ᵈ",
  e: "ᵉ",
  f: "ᶠ",
  g: "ᵍ",
  h: "ʰ",
  i: "ⁱ",
  j: "ʲ",
  k: "ᵏ",
  l: "ˡ",
  m: "ᵐ",
  n: "ⁿ",
  o: "ᵒ",
  p: "ᵖ",
  r: "ʳ",
  s: "ˢ",
  t: "ᵗ",
  u: "ᵘ",
  v: "ᵛ",
  w: "ʷ",
  x: "ˣ",
  y: "ʸ",
  z: "ᶻ",
  theta: "ᶿ",
  phi: "ᵠ",
};

const SUBSCRIPT: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
  y: "ᵧ",
  beta: "ᵦ",
  gamma: "ᵧ",
  rho: "ᵨ",
  phi: "ᵩ",
  chi: "ᵪ",
};

const MATH_BOLD_UPPER_START = 0x1d400;
const MATH_BOLD_LOWER_START = 0x1d41a;
const MATH_BOLD_DIGIT_START = 0x1d7ce;

const BLACKBOARD: Record<string, string> = {
  A: "𝔸",
  B: "𝔹",
  C: "ℂ",
  D: "𝔻",
  E: "𝔼",
  F: "𝔽",
  G: "𝔾",
  H: "ℍ",
  I: "𝕀",
  J: "𝕁",
  K: "𝕂",
  L: "𝕃",
  M: "𝕄",
  N: "ℕ",
  O: "𝕆",
  P: "ℙ",
  Q: "ℚ",
  R: "ℝ",
  S: "𝕊",
  T: "𝕋",
  U: "𝕌",
  V: "𝕍",
  W: "𝕎",
  X: "𝕏",
  Y: "𝕐",
  Z: "ℤ",
};

export function renderInlineMathToText(text: string): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    if (text.startsWith("\\(", index)) {
      const close = text.indexOf("\\)", index + 2);
      if (close !== -1) {
        const tex = text.slice(index + 2, close);
        result += renderMaybeMath(tex, text.slice(index, close + 2));
        index = close + 2;
        continue;
      }
    }

    if (text.startsWith("\\[", index)) {
      const close = text.indexOf("\\]", index + 2);
      if (close !== -1) {
        const tex = text.slice(index + 2, close);
        result += renderMaybeMath(tex, text.slice(index, close + 2));
        index = close + 2;
        continue;
      }
    }

    if (text[index] === "$" && text[index - 1] !== "\\") {
      const isDisplay = text[index + 1] === "$";
      const openLength = isDisplay ? 2 : 1;
      const close = findClosingDollar(text, index + openLength, isDisplay);
      if (close !== -1) {
        const tex = text.slice(index + openLength, close);
        const original = text.slice(index, close + openLength);
        result += renderMaybeMath(tex, original);
        index = close + openLength;
        continue;
      }
    }

    result += text[index];
    index++;
  }

  return result;
}

export function renderTexToUnicode(tex: string): string {
  return normalizeMathText(new TexParser(tex).parse());
}

export function renderDisplayMathLines(tex: string, maxWidth: number): string[] {
  const rendered = renderTexToUnicode(tex);
  return wrapMathText(rendered, maxWidth);
}

function renderMaybeMath(tex: string, original: string): string {
  return looksLikeMath(tex) ? renderTexToUnicode(tex) : original;
}

function findClosingDollar(text: string, start: number, display: boolean): number {
  const needle = display ? "$$" : "$";
  let index = start;
  while (index < text.length) {
    const found = text.indexOf(needle, index);
    if (found === -1) return -1;
    if (text[found - 1] !== "\\") return found;
    index = found + needle.length;
  }
  return -1;
}

function looksLikeMath(tex: string): boolean {
  const trimmed = tex.trim();
  if (!trimmed) return false;
  return /\\[A-Za-z]+|[_^{}=+\-*/]|[∂∇πθφρσ∞]/.test(trimmed);
}

class TexParser {
  private index = 0;

  constructor(private readonly input: string) {}

  parse(): string {
    let out = "";

    while (this.index < this.input.length) {
      const ch = this.input[this.index]!;

      if (ch === "}") {
        this.index++;
        continue;
      }

      if (ch === "{") {
        out += renderTexToUnicode(this.readGroupRaw());
        continue;
      }

      if (ch === "\\" ) {
        out += this.readCommand();
        continue;
      }

      if (ch === "_" || ch === "^") {
        this.index++;
        const raw = this.readArgumentRaw();
        if (!raw) {
          out += ch;
          continue;
        }
        const rendered = renderTexToUnicode(raw);
        out += ch === "_" ? toScript(rendered, SUBSCRIPT, "_") : toScript(rendered, SUPERSCRIPT, "^");
        continue;
      }

      out += normalizePlainMathChar(ch);
      this.index++;
    }

    return out;
  }

  private readCommand(): string {
    this.index++;
    if (this.index >= this.input.length) return "";

    const start = this.index;
    let name = "";
    if (/[A-Za-z]/.test(this.input[this.index]!)) {
      while (this.index < this.input.length && /[A-Za-z]/.test(this.input[this.index]!)) {
        this.index++;
      }
      name = this.input.slice(start, this.index);
      this.consumeCommandSpace();
    } else {
      name = this.input[this.index]!;
      this.index++;
    }

    if (name in SPACING_COMMANDS) return SPACING_COMMANDS[name]!;
    if (name === "\\") return " ";
    if (name === "$" || name === "%" || name === "&" || name === "#" || name === "_" || name === "{" || name === "}") {
      return name;
    }
    if (name === "left" || name === "right" || name === "big" || name === "Big" || name === "bigg" || name === "Bigg") {
      return "";
    }
    if (name === "text" || name === "mathrm" || name === "operatorname") {
      return renderTextArgument(this.readArgumentRaw());
    }
    if (name === "mathbf" || name === "boldsymbol" || name === "bm") {
      return toMathBold(renderTexToUnicode(this.readArgumentRaw()));
    }
    if (name === "mathbb") {
      return toBlackboard(renderTexToUnicode(this.readArgumentRaw()));
    }
    if (name === "mathit" || name === "mathcal" || name === "mathsf" || name === "mathtt") {
      return renderTexToUnicode(this.readArgumentRaw());
    }
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const numeratorRaw = this.readArgumentRaw();
      const denominatorRaw = this.readArgumentRaw();
      return formatFraction(
        renderTexToUnicode(numeratorRaw),
        renderTexToUnicode(denominatorRaw)
      );
    }
    if (name === "sqrt") {
      const arg = renderTexToUnicode(this.readArgumentRaw());
      return arg.length <= 1 ? `√${arg}` : `√(${arg})`;
    }
    if (name === "hat" || name === "widehat") {
      return addCombiningMark(renderTexToUnicode(this.readArgumentRaw()), "\u0302");
    }
    if (name === "bar" || name === "overline") {
      return addCombiningMark(renderTexToUnicode(this.readArgumentRaw()), "\u0305");
    }
    if (name === "vec") {
      return addCombiningMark(renderTexToUnicode(this.readArgumentRaw()), "\u20d7");
    }
    if (name in COMMAND_SYMBOLS) return COMMAND_SYMBOLS[name]!;
    if (FUNCTION_COMMANDS.has(name)) return name;

    return name;
  }

  private readArgumentRaw(): string {
    this.skipWhitespace();
    if (this.index >= this.input.length) return "";
    if (this.input[this.index] === "{") {
      return this.readGroupRaw();
    }
    if (this.input[this.index] === "\\") {
      const start = this.index;
      this.index++;
      if (this.index < this.input.length && /[A-Za-z]/.test(this.input[this.index]!)) {
        while (this.index < this.input.length && /[A-Za-z]/.test(this.input[this.index]!)) {
          this.index++;
        }
      } else if (this.index < this.input.length) {
        this.index++;
      }
      return this.input.slice(start, this.index);
    }
    return this.input[this.index++]!;
  }

  private readGroupRaw(): string {
    if (this.input[this.index] !== "{") return "";
    this.index++;
    const start = this.index;
    let depth = 1;
    while (this.index < this.input.length && depth > 0) {
      const ch = this.input[this.index]!;
      if (ch === "\\") {
        this.index += 2;
        continue;
      }
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      this.index++;
    }
    const end = depth === 0 ? this.index - 1 : this.index;
    return this.input.slice(start, Math.max(start, end));
  }

  private skipWhitespace(): void {
    while (this.index < this.input.length && /\s/.test(this.input[this.index]!)) {
      this.index++;
    }
  }

  private consumeCommandSpace(): void {
    while (this.index < this.input.length && /[ \t\r\n]/.test(this.input[this.index]!)) {
      this.index++;
    }
  }
}

function renderTextArgument(raw: string): string {
  return raw.replace(/\\([{}$%&#_])/g, "$1").replace(/\s+/g, " ").trim();
}

function normalizePlainMathChar(ch: string): string {
  if (ch === "-") return "−";
  return ch;
}

function formatFraction(numerator: string, denominator: string): string {
  const n = compactFractionSide(numerator);
  const d = compactFractionSide(denominator);
  const left = needsFractionParens(n) ? `(${n})` : n;
  const right = needsFractionParens(d) ? `(${d})` : d;
  return `${left}⁄${right}`;
}

function compactFractionSide(value: string): string {
  return value.replace(/\s+/g, "");
}

function needsFractionParens(value: string): boolean {
  return /\s|[=+−-]/.test(value);
}

function addCombiningMark(value: string, mark: string): string {
  return Array.from(value).map((char) => `${char}${mark}`).join("");
}

function toMathBold(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      out += char;
    } else if (code >= 65 && code <= 90) {
      out += String.fromCodePoint(MATH_BOLD_UPPER_START + code - 65);
    } else if (code >= 97 && code <= 122) {
      out += String.fromCodePoint(MATH_BOLD_LOWER_START + code - 97);
    } else if (code >= 48 && code <= 57) {
      out += String.fromCodePoint(MATH_BOLD_DIGIT_START + code - 48);
    } else {
      out += char;
    }
  }
  return out;
}

function toBlackboard(value: string): string {
  return Array.from(value).map((char) => BLACKBOARD[char] ?? char).join("");
}

function toScript(value: string, table: Record<string, string>, marker: "_" | "^"): string {
  const compact = value.replace(/\s+/g, "");
  if (!compact) return "";

  const rendered = scriptChars(compact, table);
  if (rendered !== null) return rendered;

  if (compact.length === 1) return `${marker}${compact}`;
  return `${marker}{${compact}}`;
}

function scriptChars(value: string, table: Record<string, string>): string | null {
  let out = "";
  for (let index = 0; index < value.length; ) {
    const char = Array.from(value.slice(index))[0]!;
    const width = char.length;
    const greekName = greekScriptName(char);
    const mapped = table[char] ?? (greekName ? table[greekName] : undefined);
    if (!mapped) return null;
    out += mapped;
    index += width;
  }
  return out;
}

function greekScriptName(char: string): string | null {
  switch (char) {
    case "β":
      return "beta";
    case "γ":
      return "gamma";
    case "ρ":
      return "rho";
    case "φ":
      return "phi";
    case "χ":
      return "chi";
    case "θ":
      return "theta";
    default:
      return null;
  }
}

function normalizeMathText(text: string): string {
  let out = text.replace(/[ \t\r\n]+/g, " ").trim();
  out = out.replace(/\s*([=+×⋅≤≥<>≈±∓∝])\s*/g, " $1 ");
  out = out.replace(/\s*([−])\s*/g, " − ");
  out = out.replace(/\s*([,;])\s*/g, "$1 ");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

function wrapMathText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const tokens = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  const pushCurrent = (): void => {
    if (current) {
      lines.push(current);
      current = "";
    }
  };

  for (const token of tokens) {
    if (visibleWidth(token) > maxWidth) {
      pushCurrent();
      for (const chunk of splitToWidth(token, maxWidth)) {
        lines.push(chunk);
      }
      continue;
    }

    const next = current ? `${current} ${token}` : token;
    if (visibleWidth(next) > maxWidth && current) {
      pushCurrent();
      current = token;
    } else {
      current = next;
    }
  }

  pushCurrent();
  return lines.length > 0 ? lines : [""];
}

function splitToWidth(text: string, maxWidth: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining) {
    const chunk = truncateAnsiToWidth(remaining, maxWidth);
    if (!chunk) break;
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return chunks.length > 0 ? chunks : [text];
}
