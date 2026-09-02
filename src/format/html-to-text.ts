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
  return html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_match, inner) => {
    const rendered = renderTable(inner, options);
    return rendered ? `\n${rendered}\n` : "\n";
  });
}

function renderTable(
  tableHtml: string,
  options?: { baseUrl?: string | null }
): string {
  const rowMatches = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rowMatches.length === 0) {
    return htmlFragmentToText(tableHtml, options);
  }

  const rows = rowMatches.map((match) => {
    const rowHtml = match[1] ?? "";
    const cells = [...rowHtml.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(
      (cellMatch) => ({
        isHeader: (cellMatch[1] ?? "").toLowerCase() === "th",
        text: htmlFragmentToSingleLineText(cellMatch[2] ?? "", options),
      })
    );
    return cells;
  });

  const headerRow =
    rows.find((row) => row.some((cell) => cell.isHeader))?.map((cell) => cell.text) ??
    null;
  const dataRows = headerRow ? rows.slice(1) : rows;

  const lines = ["Table:"];
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
