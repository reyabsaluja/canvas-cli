/**
 * Structure-aware HTML-to-text converter for ingested Canvas content.
 * Preserves the information retrieval cares about most: headings, numbered
 * steps, collapsible details, table header/value pairs, captions, media labels,
 * and resolved links.
 */
export function htmlToText(
  html: string,
  options?: { baseUrl?: string | null }
): string {
  const savedPreBlocks: string[] = [];
  const previousPreBlocks = preBlocks;
  preBlocks = savedPreBlocks;

  try {
    let text = html.replace(/\r\n/g, "\n");

    text = stripCommentsScriptsAndStyles(text);
    text = replaceFigures(text, options);
    text = replaceTables(text, options);
    text = replaceDefinitionLists(text, options);
    text = replaceLists(text, options);
    text = replaceDetails(text, options);
    text = replaceMedia(text, options);
    text = replacePreformatted(text, options);

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
      /<\/(p|div|section|article|header|footer|aside|nav|blockquote|main)>/gi,
      "\n\n"
    );
    text = text.replace(
      /<(p|div|section|article|header|footer|aside|nav|blockquote|main)\b[^>]*>/gi,
      ""
    );

    text = text.replace(/<\/li>/gi, "\n");
    text = text.replace(/<\/t[dh]>/gi, "\t");
    text = text.replace(/<\/tr>/gi, "\n");

    text = stripTags(text);
    text = decodeEntities(text);

    text = normalizeOutput(text);
    if (savedPreBlocks.length > 0) {
      text = restorePreBlocks(text, savedPreBlocks);
    }
    return text;
  } finally {
    preBlocks = previousPreBlocks;
  }
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
  return html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_match, inner) => {
    const rendered = renderTable(inner, options);
    return rendered ? `\n${rendered}\n` : "\n";
  });
}

function renderTable(
  tableHtml: string,
  options?: { baseUrl?: string | null }
): string {
  const captionMatch = tableHtml.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i);
  const caption = captionMatch
    ? htmlFragmentToSingleLineText(captionMatch[1] ?? "", options)
    : "";
  const tableWithoutCaption = tableHtml.replace(
    /<caption\b[^>]*>[\s\S]*?<\/caption>/gi,
    ""
  );
  const rowMatches = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rowMatches.length === 0) {
    const fallback = htmlFragmentToText(tableWithoutCaption, options);
    if (!fallback) {
      return caption ? `Table: ${caption}` : "";
    }
    return [caption ? `Table: ${caption}` : "Table:", fallback].join("\n");
  }

  const rows = rowMatches.map((match) => {
    const rowHtml = match[1] ?? "";
    const cells = [...rowHtml.matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map(
      (cellMatch) => {
        const attrs = cellMatch[2] ?? "";
        return {
          isHeader: (cellMatch[1] ?? "").toLowerCase() === "th",
          scope: extractAttr(attrs, "scope")?.toLowerCase() ?? null,
          text: htmlFragmentToSingleLineText(cellMatch[3] ?? "", options),
        };
      }
    );
    return cells;
  });

  const lines = [caption ? `Table: ${caption}` : "Table:"];
  const nonEmptyRows = rows.filter((row) => row.some((cell) => cell.text.length > 0));
  const hasColumnHeaderRow = nonEmptyRows.some(
    (row) => row.length > 1 && row.every((cell) => cell.isHeader)
  );
  const keyValueRows = rows
    .map((row) => renderKeyValueTableRow(row))
    .filter((line): line is string => line !== null);
  if (
    keyValueRows.length > 0 &&
    keyValueRows.length === nonEmptyRows.length &&
    !hasColumnHeaderRow
  ) {
    lines.push(...keyValueRows);
    return lines.length > 1 ? lines.join("\n") : "";
  }

  const headerRow =
    rows.find((row) => row.some((cell) => cell.isHeader))?.map((cell) => cell.text) ??
    null;
  const dataRows = headerRow ? rows.slice(1) : rows;

  if (headerRow && dataRows.length > 0) {
    for (const row of dataRows) {
      const parts = row.map((cell, index) => {
        const key = headerRow[index] || `Column ${index + 1}`;
        return `${key}: ${cell.text || "—"}`;
      });
      lines.push(`- ${parts.join(" | ")}`);
    }
  } else {
    for (const row of rows) {
      const values = row.map((cell) => cell.text).filter((cell) => cell.length > 0);
      if (values.length > 0) {
        lines.push(`- ${values.join(" | ")}`);
      }
    }
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

function renderKeyValueTableRow(
  row: Array<{ isHeader: boolean; scope: string | null; text: string }>
): string | null {
  if (row.length < 2) {
    return null;
  }

  const [labelCell, ...valueCells] = row;
  if (!labelCell?.isHeader) {
    return null;
  }
  if (labelCell.scope && labelCell.scope !== "row") {
    return null;
  }

  const label = labelCell.text.trim();
  const values = valueCells
    .map((cell) => cell.text.trim())
    .filter((value) => value.length > 0);
  if (!label || values.length === 0) {
    return null;
  }

  return `- ${label}: ${values.join(" | ")}`;
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

function replaceDefinitionLists(
  html: string,
  options?: { baseUrl?: string | null }
): string {
  return html.replace(/<dl\b[^>]*>([\s\S]*?)<\/dl>/gi, (_match, inner) => {
    const rendered = renderDefinitionList(inner, options);
    return rendered ? `\n${rendered}\n` : "\n";
  });
}

function renderDefinitionList(
  dlHtml: string,
  options?: { baseUrl?: string | null }
): string {
  const lines: string[] = [];
  const tokens: Array<{ type: "dt" | "dd"; content: string }> = [];
  dlHtml.replace(
    /<(dt|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_m, tag, content) => {
      tokens.push({ type: tag.toLowerCase() as "dt" | "dd", content });
      return "";
    }
  );

  let currentTerm: string | null = null;
  for (const token of tokens) {
    if (token.type === "dt") {
      currentTerm = htmlFragmentToSingleLineText(token.content, options);
    } else {
      const def = htmlFragmentToText(token.content, options);
      if (!def) continue;
      const defLines = def
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (currentTerm && defLines.length > 0) {
        lines.push(`- **${currentTerm}**: ${defLines[0]}`);
        for (const continuation of defLines.slice(1)) {
          lines.push(`  ${continuation}`);
        }
      } else if (defLines.length > 0) {
        lines.push(`- ${defLines.join("\n  ")}`);
      }
      currentTerm = null;
    }
  }

  if (currentTerm) {
    lines.push(`- **${currentTerm}**`);
  }

  return lines.join("\n");
}

function replaceDetails(
  html: string,
  options?: { baseUrl?: string | null }
): string {
  return html.replace(/<details\b[^>]*>([\s\S]*?)<\/details>/gi, (_match, inner) => {
    const rendered = renderDetails(String(inner), options);
    return rendered ? `\n${rendered}\n` : "\n";
  });
}

function renderDetails(
  detailsHtml: string,
  options?: { baseUrl?: string | null }
): string {
  const summaryMatch = detailsHtml.match(
    /<summary\b[^>]*>([\s\S]*?)<\/summary>/i
  );
  const summary = summaryMatch
    ? htmlFragmentToSingleLineText(summaryMatch[1] ?? "", options)
    : "";
  const bodyHtml = detailsHtml.replace(
    /<summary\b[^>]*>[\s\S]*?<\/summary>/i,
    ""
  );
  const body = htmlFragmentToText(bodyHtml, options);

  if (summary && body) {
    return `Details: ${summary}\n${body}`;
  }
  if (summary) {
    return `Details: ${summary}`;
  }
  return body ? `Details:\n${body}` : "";
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
  current = current.replace(
    /<iframe\b([^>]*)>([\s\S]*?)<\/iframe>/gi,
    (_match, attrs) => renderEmbed("Embedded content", attrs, options)
  );
  current = current.replace(
    /<video\b([^>]*)>([\s\S]*?)<\/video>/gi,
    (_match, attrs, inner) => renderMediaElement("Video", attrs, inner, options)
  );
  current = current.replace(
    /<audio\b([^>]*)>([\s\S]*?)<\/audio>/gi,
    (_match, attrs, inner) => renderMediaElement("Audio", attrs, inner, options)
  );
  current = current.replace(
    /<object\b([^>]*)>([\s\S]*?)<\/object>/gi,
    (_match, attrs) => renderEmbed("Embedded object", attrs, options)
  );
  current = current.replace(/<embed\b([^>]*)\/?>/gi, (_match, attrs) => {
    return renderEmbed("Embedded object", attrs, options);
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
  const src =
    extractAttr(attrs, "src") ??
    extractAttr(attrs, "data-src") ??
    extractAttr(attrs, "data");
  const resolvedSrc = src ? resolveHref(src, options?.baseUrl ?? null) : "";
  const label = title || ariaLabel || resolvedSrc;
  if (!label) return "";
  return resolvedSrc && label !== resolvedSrc
    ? `${kind}: ${label} (${resolvedSrc})`
    : `${kind}: ${label}`;
}

function renderMediaElement(
  kind: "Audio" | "Video",
  attrs: string,
  inner: string,
  options?: { baseUrl?: string | null }
): string {
  const title = extractAttr(attrs, "title");
  const ariaLabel = extractAttr(attrs, "aria-label");
  const poster = extractAttr(attrs, "poster");
  const directSrc =
    extractAttr(attrs, "src") ?? extractAttr(attrs, "data-src");
  const resolvedDirectSrc = directSrc
    ? resolveHref(directSrc, options?.baseUrl ?? null)
    : "";
  const resolvedPoster = poster
    ? resolveHref(poster, options?.baseUrl ?? null)
    : "";
  const sources = extractSourceDescriptions(inner, options);
  const tracks = extractTrackDescriptions(inner, options);
  const fallback = htmlFragmentToSingleLineText(
    inner.replace(/<(source|track)\b[^>]*\/?>/gi, ""),
    options
  );

  const label =
    title || ariaLabel || fallback || resolvedDirectSrc || sources[0] || "";
  const parts = [label];
  if (resolvedDirectSrc && label !== resolvedDirectSrc) {
    parts.push(`Source: ${resolvedDirectSrc}`);
  }
  if (resolvedPoster) {
    parts.push(`Poster: ${resolvedPoster}`);
  }
  parts.push(...sources.filter((source) => source !== label));
  parts.push(...tracks);

  const cleaned = parts.filter((part) => part.trim().length > 0);
  return cleaned.length > 0 ? `${kind}: ${cleaned.join(" — ")}` : "";
}

function extractSourceDescriptions(
  html: string,
  options?: { baseUrl?: string | null }
): string[] {
  const descriptions: string[] = [];
  for (const match of html.matchAll(/<source\b([^>]*)\/?>/gi)) {
    const attrs = match[1] ?? "";
    const src = extractAttr(attrs, "src");
    if (!src) continue;
    const resolvedSrc = resolveHref(src, options?.baseUrl ?? null);
    const type = extractAttr(attrs, "type");
    descriptions.push(
      type ? `Source: ${resolvedSrc} (${type})` : `Source: ${resolvedSrc}`
    );
  }
  return unique(descriptions);
}

function extractTrackDescriptions(
  html: string,
  options?: { baseUrl?: string | null }
): string[] {
  const descriptions: string[] = [];
  for (const match of html.matchAll(/<track\b([^>]*)\/?>/gi)) {
    const attrs = match[1] ?? "";
    const src = extractAttr(attrs, "src");
    if (!src) continue;
    const resolvedSrc = resolveHref(src, options?.baseUrl ?? null);
    const kind = extractAttr(attrs, "kind");
    const label = extractAttr(attrs, "label");
    const srclang = extractAttr(attrs, "srclang");
    const descriptor = [label, srclang].filter(Boolean).join(" ");
    const trackType = kind ? titleCase(kind) : "Track";
    descriptions.push(
      descriptor
        ? `${trackType}: ${descriptor} (${resolvedSrc})`
        : `${trackType}: ${resolvedSrc}`
    );
  }
  return unique(descriptions);
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
    const rendered = renderMediaElement(
      "Video",
      match[1] ?? "",
      match[2] ?? "",
      options
    );
    if (rendered) descriptions.push(rendered);
  }
  for (const match of html.matchAll(/<audio\b([^>]*)>([\s\S]*?)<\/audio>/gi)) {
    const rendered = renderMediaElement(
      "Audio",
      match[1] ?? "",
      match[2] ?? "",
      options
    );
    if (rendered) descriptions.push(rendered);
  }
  for (const match of html.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/gi)) {
    const rendered = renderEmbed("Embedded object", match[1] ?? "", options);
    if (rendered) descriptions.push(rendered);
  }
  for (const match of html.matchAll(/<embed\b([^>]*)\/?>/gi)) {
    const rendered = renderEmbed("Embedded object", match[1] ?? "", options);
    if (rendered) descriptions.push(rendered);
  }

  return descriptions;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function titleCase(value: string): string {
  const cleaned = value.replace(/[-_]+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

const PRE_PLACEHOLDER_PREFIX = "\x00PRE:";
const PRE_PLACEHOLDER_SUFFIX = "\x00";

let preBlocks: string[] = [];

function replacePreformatted(
  html: string,
  _options?: { baseUrl?: string | null }
): string {
  return html.replace(
    /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
    (_match, inner) => {
      let content = inner as string;
      content = content.replace(/<br\s*\/?>/gi, "\n");
      content = content.replace(/<[^>]*>/g, "");
      content = decodeEntities(content);
      const trimmed = content.replace(/^\n/, "").replace(/\n$/, "");
      const index = preBlocks.length;
      preBlocks.push(trimmed);
      return `\n${PRE_PLACEHOLDER_PREFIX}${index}${PRE_PLACEHOLDER_SUFFIX}\n`;
    }
  );
}

function restorePreBlocks(text: string, blocks: string[]): string {
  return text.replace(
    /\x00PRE:(\d+)\x00/g,
    (_match, indexStr) => {
      const index = Number.parseInt(indexStr, 10);
      const block = blocks[index] ?? "";
      return `\`\`\`\n${block}\n\`\`\``;
    }
  );
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
  return text
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
