import { stripControlChars } from "../sanitize.js";

/**
 * Structure-aware HTML-to-text converter for ingested Canvas content.
 * Preserves the information retrieval cares about most: headings, numbered
 * steps, table header/value pairs, captions, media labels, and resolved links.
 */
export function htmlToText(
  html: string,
  options?: { baseUrl?: string | null }
): string {
  let text = html.replace(/\r\n/g, "\n");

  text = stripCommentsScriptsAndStyles(text);
  text = replaceFigures(text, options);
  text = replaceTables(text, options);
  text = replaceDefinitionLists(text, options);
  text = replaceLists(text, options);
  text = replaceMedia(text, options);

  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

  text = text.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_match, level, content) => {
      const depth = Number.parseInt(level, 10);
      const heading = htmlFragmentToSingleLineText(content, options);
      if (!heading) return "\n";
      const prefix = "#".repeat(Number.isNaN(depth) ? 2 : Math.min(depth + 1, 6));
      return `\n${prefix} ${heading}\n`;
    }
  );

  text = text.replace(
    /<(a)\b([^>]*)>([\s\S]*?)<\/a>/gi,
    (_match, _tag, attrs, content) => {
      const href = extractAttr(attrs, "href");
      const label = htmlFragmentToSingleLineText(content, options);
      if (!href || href.startsWith("javascript:")) {
        return label;
      }
      const resolvedHref = resolveHref(href, options?.baseUrl ?? null);
      if (!label) return resolvedHref;
      if (label === resolvedHref) return resolvedHref;
      return `${label} (${resolvedHref})`;
    }
  );

  text = text.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner) => {
    const content = htmlFragmentToSingleLineText(inner, options);
    return content ? `**${content}**` : "";
  });

  text = text.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner) => {
    const content = htmlFragmentToSingleLineText(inner, options);
    return content ? `_${content}_` : "";
  });

  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => {
    const content = htmlFragmentToSingleLineText(inner, options);
    return content ? `\`${content}\`` : "";
  });

  text = text.replace(
    /<\/(p|div|section|article|header|footer|aside|nav|blockquote|pre|main)>/gi,
    "\n\n"
  );
  text = text.replace(
    /<(p|div|section|article|header|footer|aside|nav|blockquote|pre|main)\b[^>]*>/gi,
    ""
  );

  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<\/t[dh]>/gi, "\t");
  text = text.replace(/<\/tr>/gi, "\n");

  text = stripTags(text);
  text = decodeEntities(text);

  return normalizeOutput(text);
}

function stripCommentsScriptsAndStyles(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
}

function replaceTables(
  html: string,
  options?: { baseUrl?: string | null }
): string {
  // Innermost tables first, so a table nested inside a cell is rendered to
  // text before the outer table reads that cell.
  const tablePattern = /<table\b[^>]*>((?:(?!<table\b)[\s\S])*?)<\/table>/gi;
  let current = html;
  let previous: string;

  do {
    previous = current;
    current = current.replace(tablePattern, (_match, inner) => {
      const rendered = renderTable(String(inner), options);
      return rendered ? `\n${rendered}\n` : "\n";
    });
  } while (current !== previous);

  return current;
}

interface TableCell {
  isHeader: boolean;
  text: string;
  colspan: number;
  rowspan: number;
}

/** A cell as placed on the table grid; spanned positions share one object. */
interface PlacedCell extends TableCell {
  row: number;
  col: number;
}

function renderTable(
  tableHtml: string,
  options?: { baseUrl?: string | null }
): string {
  const captionMatch = tableHtml.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i);
  const caption = captionMatch
    ? htmlFragmentToSingleLineText(captionMatch[1] ?? "", options)
    : "";
  const body = tableHtml.replace(/<caption\b[^>]*>[\s\S]*?<\/caption>/gi, "");

  const rowMatches = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rowMatches.length === 0) {
    const fallback = htmlFragmentToText(body, options);
    if (!fallback) return caption ? `Table: ${caption}` : "";
    return caption ? `Table: ${caption}\n${fallback}` : fallback;
  }

  const rows: TableCell[][] = rowMatches.map((match) =>
    [...(match[1] ?? "").matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map(
      (cellMatch) => ({
        isHeader: (cellMatch[1] ?? "").toLowerCase() === "th",
        text: htmlCellToSingleLineText(cellMatch[3] ?? "", options),
        colspan: parseSpanAttr(cellMatch[2] ?? "", "colspan"),
        rowspan: parseSpanAttr(cellMatch[2] ?? "", "rowspan"),
      })
    )
  );

  const grid = placeTableCells(rows);
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  const title = caption ? `Table: ${caption}` : "Table:";
  const lines = [title];

  // Header rows: the leading rows made only of <th> cells (a lone first row
  // with any <th> still counts, matching how most hand-written tables look).
  let headerRowCount = 0;
  while (
    headerRowCount < grid.length &&
    gridRowCells(grid[headerRowCount] ?? []).length > 0 &&
    gridRowCells(grid[headerRowCount] ?? []).every((cell) => cell.isHeader)
  ) {
    headerRowCount += 1;
  }
  // Row-header tables ("Instructor | Prof. Grace"): every row keys on its first cell.
  const isRowHeaderTable =
    headerRowCount === 0 &&
    grid.length > 0 &&
    grid.every((row) => {
      const cells = gridRowCells(row);
      return (
        cells.length > 1 &&
        cells[0]?.isHeader === true &&
        cells.slice(1).every((cell) => !cell.isHeader)
      );
    });
  if (
    headerRowCount === 0 &&
    !isRowHeaderTable &&
    (grid[0] ?? []).some((cell) => cell?.isHeader)
  ) {
    headerRowCount = 1;
  }
  if (headerRowCount >= grid.length) {
    headerRowCount = grid.length > 1 ? grid.length - 1 : 0;
  }

  if (headerRowCount > 0) {
    const columnKeys: string[] = [];
    for (let col = 0; col < width; col += 1) {
      const parts: string[] = [];
      for (let row = 0; row < headerRowCount; row += 1) {
        const text = grid[row]?.[col]?.text ?? "";
        if (text && parts[parts.length - 1] !== text) parts.push(text);
      }
      columnKeys.push(parts.join(" – ") || `Column ${col + 1}`);
    }

    for (let row = headerRowCount; row < grid.length; row += 1) {
      const parts: string[] = [];
      const seen = new Set<PlacedCell>();
      for (let col = 0; col < width; col += 1) {
        const cell = grid[row]?.[col];
        if (!cell || seen.has(cell)) continue;
        seen.add(cell);
        const keys: string[] = [];
        for (let span = col; span < width && grid[row]?.[span] === cell; span += 1) {
          const key = columnKeys[span] ?? `Column ${span + 1}`;
          if (!keys.includes(key)) keys.push(key);
        }
        parts.push(`${keys.join(" / ")}: ${cell.text || "—"}`);
      }
      if (parts.length > 0) lines.push(`- ${parts.join(" | ")}`);
    }
  } else if (isRowHeaderTable) {
    for (const row of grid) {
      const [key, ...values] = gridRowCells(row);
      const rendered = values.map((cell) => cell.text).filter((text) => text.length > 0);
      if (key?.text || rendered.length > 0) {
        lines.push(`- ${key?.text || "—"}: ${rendered.join(" | ") || "—"}`);
      }
    }
  } else {
    for (const row of grid) {
      const values = gridRowCells(row)
        .map((cell) => cell.text)
        .filter((text) => text.length > 0);
      if (values.length > 0) lines.push(`- ${values.join(" | ")}`);
    }
  }

  return lines.length > 1 || caption ? lines.join("\n") : "";
}

/**
 * Lay cells out on a grid honouring colspan/rowspan, so a "Week 1" cell that
 * spans two rows is present on both and the columns below it stay aligned.
 */
function placeTableCells(rows: TableCell[][]): Array<Array<PlacedCell | undefined>> {
  const grid: Array<Array<PlacedCell | undefined>> = [];
  const ensureRow = (index: number): Array<PlacedCell | undefined> => {
    while (grid.length <= index) grid.push([]);
    return grid[index]!;
  };

  rows.forEach((cells, rowIndex) => {
    const gridRow = ensureRow(rowIndex);
    let col = 0;
    for (const cell of cells) {
      while (gridRow[col] !== undefined) col += 1;
      const placed: PlacedCell = { ...cell, row: rowIndex, col };
      const rowspan = Math.min(cell.rowspan, rows.length - rowIndex);
      for (let r = 0; r < rowspan; r += 1) {
        const target = ensureRow(rowIndex + r);
        for (let c = 0; c < cell.colspan; c += 1) {
          if (target[col + c] === undefined) target[col + c] = placed;
        }
      }
      col += cell.colspan;
    }
  });

  return grid;
}

/** Distinct cells of a grid row in column order (spans collapsed). */
function gridRowCells(row: Array<PlacedCell | undefined>): PlacedCell[] {
  const cells: PlacedCell[] = [];
  for (const cell of row) {
    if (cell && cells[cells.length - 1] !== cell && !cells.includes(cell)) cells.push(cell);
  }
  return cells;
}

function parseSpanAttr(attrs: string, attr: "colspan" | "rowspan"): number {
  const parsed = Number.parseInt(extractAttr(attrs, attr) ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 100);
}

/**
 * Cell text on one line. Lists and nested tables inside the cell keep their
 * item boundaries ("Lab 1 | Due: Sep 12; Lab 2 | Due: Sep 26") instead of
 * being run together with spaces.
 */
function htmlCellToSingleLineText(
  html: string,
  options?: { baseUrl?: string | null }
): string {
  const lines = htmlFragmentToText(html, options)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let result = "";
  for (const line of lines) {
    const tableStart = line.match(/^Table:(?:\s+(.*))?$/);
    if (tableStart) {
      if (tableStart[1]) result += `${result ? " " : ""}${tableStart[1]}:`;
      continue;
    }
    const item = line.match(/^(?:-|\d+\.)\s+(.*)$/);
    if (item) {
      result += `${result ? (result.endsWith(":") ? " " : "; ") : ""}${item[1]}`;
      continue;
    }
    result += `${result ? " " : ""}${line}`;
  }
  return result.trim();
}

function replaceDefinitionLists(
  html: string,
  options?: { baseUrl?: string | null }
): string {
  const pattern = /<dl\b[^>]*>((?:(?!<dl\b)[\s\S])*?)<\/dl>/gi;
  let current = html;
  let previous: string;

  do {
    previous = current;
    current = current.replace(pattern, (_match, inner) => {
      const rendered = renderDefinitionList(String(inner), options);
      return rendered ? `\n${rendered}\n` : "\n";
    });
  } while (current !== previous);

  return current;
}

/** `<dt>`/`<dd>` pairs become "- term: definition" lines. */
function renderDefinitionList(
  inner: string,
  options?: { baseUrl?: string | null }
): string {
  const lines: string[] = [];
  let terms: string[] = [];
  let definitions: string[] = [];

  const flush = (): void => {
    if (terms.length === 0 && definitions.length === 0) return;
    const term = terms.join(" / ");
    const definition = definitions.join("; ");
    if (term && definition) lines.push(`- ${term}: ${definition}`);
    else lines.push(`- ${term || definition}`);
    terms = [];
    definitions = [];
  };

  for (const match of inner.matchAll(/<(dt|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = htmlCellToSingleLineText(match[2] ?? "", options);
    if ((match[1] ?? "").toLowerCase() === "dt") {
      if (definitions.length > 0) flush();
      if (text) terms.push(text);
    } else if (text) {
      definitions.push(text);
    }
  }
  flush();

  return lines.join("\n");
}

function replaceLists(
  html: string,
  options?: { baseUrl?: string | null }
): string {
  const listPattern =
    /<(ol|ul)\b([^>]*)>((?:(?!<(?:ol|ul)\b)[\s\S])*?)<\/\1>/gi;
  let current = html;
  let previous: string;

  do {
    previous = current;
    current = current.replace(listPattern, (_match, tag, attrs, inner) => {
      const rendered = renderList(
        String(tag).toLowerCase() === "ol" ? "ol" : "ul",
        String(attrs),
        String(inner),
        options
      );
      return rendered ? `\n${rendered}\n` : "\n";
    });
  } while (current !== previous);

  return current;
}

function renderList(
  type: "ol" | "ul",
  attrs: string,
  inner: string,
  options?: { baseUrl?: string | null }
): string {
  const start = type === "ol" ? parseStartAttr(attrs) : 1;
  const itemMatches = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)];
  const lines: string[] = [];

  for (let index = 0; index < itemMatches.length; index += 1) {
    const content = htmlFragmentToText(itemMatches[index]?.[1] ?? "", options);
    if (!content) continue;

    const contentLines = content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (contentLines.length === 0) continue;

    const marker = type === "ol" ? `${start + index}. ` : "- ";
    lines.push(`${marker}${contentLines[0]}`);
    for (const continuation of contentLines.slice(1)) {
      lines.push(`   ${continuation}`);
    }
  }

  return lines.join("\n");
}

function replaceFigures(
  html: string,
  options?: { baseUrl?: string | null }
): string {
  return html.replace(/<figure\b[^>]*>([\s\S]*?)<\/figure>/gi, (_match, inner) => {
    const rendered = renderFigure(inner, options);
    return rendered ? `\n${rendered}\n` : "\n";
  });
}

function renderFigure(
  figureHtml: string,
  options?: { baseUrl?: string | null }
): string {
  const captionMatch = figureHtml.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);
  const caption = captionMatch
    ? htmlFragmentToSingleLineText(captionMatch[1] ?? "", options)
    : "";
  const figureWithoutCaption = figureHtml.replace(
    /<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/gi,
    ""
  );
  const mediaDescriptions = extractMediaDescriptions(figureWithoutCaption, options);
  const parts = [
    ...mediaDescriptions,
    caption ? `Caption: ${caption}` : "",
  ].filter(Boolean);

  if (parts.length === 0) {
    const fallback = htmlFragmentToSingleLineText(figureHtml, options);
    return fallback ? `Figure: ${fallback}` : "";
  }

  return `Figure: ${parts.join(" — ")}`;
}

function replaceMedia(
  html: string,
  options?: { baseUrl?: string | null }
): string {
  let current = html;

  current = current.replace(/<img\b([^>]*)\/?>/gi, (_match, attrs) => {
    return renderImage(attrs, options);
  });
  current = current.replace(/<iframe\b([^>]*)>([\s\S]*?)<\/iframe>/gi, (_match, attrs) => {
    return renderEmbed("Embedded content", attrs, options);
  });
  current = current.replace(/<video\b([^>]*)>([\s\S]*?)<\/video>/gi, (_match, attrs) => {
    return renderEmbed("Video", attrs, options);
  });
  current = current.replace(/<audio\b([^>]*)>([\s\S]*?)<\/audio>/gi, (_match, attrs) => {
    return renderEmbed("Audio", attrs, options);
  });

  return current;
}

function renderImage(
  attrs: string,
  options?: { baseUrl?: string | null }
): string {
  const alt = extractAttr(attrs, "alt");
  const title = extractAttr(attrs, "title");
  const src = extractAttr(attrs, "src");
  const resolvedSrc = src ? resolveHref(src, options?.baseUrl ?? null) : "";
  const label = alt || title || resolvedSrc;
  if (!label) return "";
  return resolvedSrc && label !== resolvedSrc
    ? `Image: ${label} (${resolvedSrc})`
    : `Image: ${label}`;
}

function renderEmbed(
  kind: string,
  attrs: string,
  options?: { baseUrl?: string | null }
): string {
  const title = extractAttr(attrs, "title");
  const ariaLabel = extractAttr(attrs, "aria-label");
  const src = extractAttr(attrs, "src");
  const resolvedSrc = src ? resolveHref(src, options?.baseUrl ?? null) : "";
  const label = title || ariaLabel || resolvedSrc;
  if (!label) return "";
  return resolvedSrc && label !== resolvedSrc
    ? `${kind}: ${label} (${resolvedSrc})`
    : `${kind}: ${label}`;
}

function extractMediaDescriptions(
  html: string,
  options?: { baseUrl?: string | null }
): string[] {
  const descriptions: string[] = [];

  for (const match of html.matchAll(/<img\b([^>]*)\/?>/gi)) {
    const rendered = renderImage(match[1] ?? "", options);
    if (rendered) descriptions.push(rendered);
  }
  for (const match of html.matchAll(/<iframe\b([^>]*)>([\s\S]*?)<\/iframe>/gi)) {
    const rendered = renderEmbed("Embedded content", match[1] ?? "", options);
    if (rendered) descriptions.push(rendered);
  }
  for (const match of html.matchAll(/<video\b([^>]*)>([\s\S]*?)<\/video>/gi)) {
    const rendered = renderEmbed("Video", match[1] ?? "", options);
    if (rendered) descriptions.push(rendered);
  }
  for (const match of html.matchAll(/<audio\b([^>]*)>([\s\S]*?)<\/audio>/gi)) {
    const rendered = renderEmbed("Audio", match[1] ?? "", options);
    if (rendered) descriptions.push(rendered);
  }

  return descriptions;
}

function htmlFragmentToText(
  html: string,
  options?: { baseUrl?: string | null }
): string {
  return normalizeOutput(htmlToText(html, options));
}

function htmlFragmentToSingleLineText(
  html: string,
  options?: { baseUrl?: string | null }
): string {
  return htmlFragmentToText(html, options).replace(/\s*\n+\s*/g, " ").trim();
}

function normalizeOutput(text: string): string {
  return stripControlChars(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function parseStartAttr(attrs: string): number {
  const start = extractAttr(attrs, "start");
  const parsed = Number.parseInt(start ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 1;
}

function extractAttr(attrs: string, attr: string): string | null {
  const regex = new RegExp(
    `${attr}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`,
    "i"
  );
  const match = attrs.match(regex);
  const value = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  const decoded = decodeEntities(value).trim();
  return decoded.length > 0 ? decoded : null;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function resolveHref(href: string, baseUrl: string | null): string {
  if (!baseUrl) return decodeEntities(href);
  try {
    return new URL(decodeEntities(href), baseUrl).toString();
  } catch {
    return decodeEntities(href);
  }
}

export function decodeEntities(text: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&ndash;": "–",
    "&mdash;": "—",
    "&lsquo;": "'",
    "&rsquo;": "'",
    "&ldquo;": "\u201C",
    "&rdquo;": "\u201D",
    "&hellip;": "…",
    "&bull;": "•",
  };

  let result = text;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.replaceAll(entity, char);
  }

  result = result.replace(/&#(\d+);/g, (_m, code) =>
    String.fromCharCode(Number.parseInt(code, 10))
  );
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_m, code) =>
    String.fromCharCode(Number.parseInt(code, 16))
  );

  return result;
}
