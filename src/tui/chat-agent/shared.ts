export function cleanInlineText(value?: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function buildArtifactExcerpt(value?: string | null): string | null {
  const cleaned = cleanInlineText(value);
  if (!cleaned) {
    return null;
  }
  if (cleaned.length <= 180) {
    return cleaned;
  }
  return `${cleaned.slice(0, 177).trimEnd()}...`;
}
