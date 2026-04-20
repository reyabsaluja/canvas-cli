/**
 * Lightweight HTML-to-terminal-text converter.
 * Handles the common elements found in Canvas assignment descriptions
 * without pulling in a heavy dependency.
 */
export function htmlToText(
  html: string,
  options?: { baseUrl?: string | null }
): string {
  let text = html;

  // Normalize line endings
  text = text.replace(/\r\n/g, "\n");

  // Block-level elements: insert newlines around them
  text = text.replace(/<\/(p|div|h[1-6]|blockquote|pre|table|tr)>/gi, "\n\n");
  text = text.replace(/<(p|div|h[1-6]|blockquote|pre|table)[\s>]/gi, "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

  // Headings: bold-style markers
  text = text.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_match, _level, content) => `\n## ${stripTags(content).trim()}\n`
  );

  // Lists
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "  • ");
  text = text.replace(/<\/?[uo]l[^>]*>/gi, "\n");

  // Links: [text](url)
  text = text.replace(
    /<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href, content) => {
      const label = stripTags(content).trim();
      if (!href || href.startsWith("javascript:")) return label;
      const resolvedHref = resolveHref(href, options?.baseUrl ?? null);
      // If label is the URL itself, just show it once
      if (label === resolvedHref) return resolvedHref;
      return `${label} (${resolvedHref})`;
    }
  );

  // Bold / strong
  text = text.replace(/<(strong|b)[\s>][\s\S]*?<\/\1>/gi, (match) => {
    const inner = stripTags(match).trim();
    return inner ? `**${inner}**` : "";
  });

  // Italic / em
  text = text.replace(/<(em|i)[\s>][\s\S]*?<\/\1>/gi, (match) => {
    const inner = stripTags(match).trim();
    return inner ? `_${inner}_` : "";
  });

  // Code
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, c) => `\`${stripTags(c)}\``);

  // Table rows: join cells with tabs
  text = text.replace(/<\/td>/gi, "\t");
  text = text.replace(/<\/th>/gi, "\t");
  text = text.replace(/<\/tr>/gi, "\n");

  // Strip all remaining tags
  text = stripTags(text);

  // Decode common HTML entities
  text = decodeEntities(text);

  // Clean up whitespace: collapse multiple blank lines, trim lines
  text = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function resolveHref(href: string, baseUrl: string | null): string {
  if (!baseUrl) return href;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
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

  // Numeric entities
  result = result.replace(/&#(\d+);/g, (_m, code) =>
    String.fromCharCode(parseInt(code, 10))
  );
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_m, code) =>
    String.fromCharCode(parseInt(code, 16))
  );

  return result;
}
