import path from "node:path";

const MAX_FILENAME_LENGTH = 200;
const MAX_SLUG_COMPONENT_LENGTH = 40;

const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * Sanitize a filename for safe use on all platforms.
 * Handles: path traversal, Windows reserved names, length limits, control chars,
 * and invalid filesystem characters.
 *
 * Note: strips leading dots — not suitable for preserving dotfile names.
 */
export function sanitizeFilename(name: string): string {
  if (!name || !name.trim()) return "unnamed";

  // Strip path separators and traversal components
  let sanitized = path.basename(name);

  // Remove control characters (U+0000-U+001F, U+007F, U+0080-U+009F)
  sanitized = sanitized.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

  // Remove characters illegal on Windows: < > : " / \ | ? *
  sanitized = sanitized.replace(/[<>:"/\\|?*]/g, "_");

  // Collapse multiple underscores/dots
  sanitized = sanitized.replace(/_{2,}/g, "_");
  sanitized = sanitized.replace(/\.{2,}/g, ".");

  // Trim leading/trailing dots, spaces, underscores
  sanitized = sanitized.replace(/^[.\s_]+|[.\s_]+$/g, "");

  if (!sanitized) return "unnamed";

  // Check for Windows reserved names (with or without extension)
  const baseName = sanitized.replace(/\.[^.]*$/, "");
  if (WINDOWS_RESERVED_NAMES.has(baseName.toUpperCase())) {
    sanitized = `_${sanitized}`;
  }

  // Truncate to max length, preserving extension
  if (sanitized.length > MAX_FILENAME_LENGTH) {
    const ext = path.extname(sanitized);
    const stem = sanitized.slice(0, MAX_FILENAME_LENGTH - ext.length);
    sanitized = stem + ext;
  }

  return sanitized;
}

/**
 * Sanitize a subfolder name. Same as filename but also blocks nested paths.
 */
export function sanitizeSubfolder(name: string): string {
  // Split on separators, sanitize each segment, rejoin
  const segments = name.split(/[/\\]+/).filter(Boolean);
  if (segments.length === 0) return "unnamed";

  return segments
    .map((seg) => sanitizeFilename(seg))
    .join(path.sep);
}

/**
 * Ensure a resolved file path stays within the expected base directory.
 * Returns the safe absolute path, or throws if traversal is detected.
 */
export function confineToDirectory(baseDir: string, untrustedPath: string): string {
  const resolved = path.resolve(baseDir, untrustedPath);
  const normalizedBase = path.resolve(baseDir) + path.sep;

  if (!resolved.startsWith(normalizedBase) && resolved !== path.resolve(baseDir)) {
    throw new Error(
      `Path traversal blocked: "${untrustedPath}" resolves outside "${baseDir}"`
    );
  }
  return resolved;
}

/**
 * Generate a filesystem-safe slug from arbitrary text.
 * Handles empty strings, all-special-char inputs, and Unicode.
 */
export function slugify(text: string): string {
  if (!text || !text.trim()) return "unnamed";

  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug || "unnamed";
}

/**
 * Truncate a slug component to the given max length without cutting mid-word
 * when possible.
 */
export function truncateSlug(
  slug: string,
  maxLength: number = MAX_SLUG_COMPONENT_LENGTH
): string {
  if (slug.length <= maxLength) return slug;

  const truncated = slug.slice(0, maxLength);
  // Avoid trailing dash from a cut
  return truncated.replace(/-+$/, "");
}

/**
 * Sanitize a document segment (used in extracted file paths).
 * Replaces any non-alphanumeric, dot, underscore, or dash with underscore.
 */
export function sanitizeDocumentSegment(value: string): string {
  if (!value || !value.trim()) return "unnamed";

  let sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  sanitized = sanitized.replace(/_{2,}/g, "_");

  if (!sanitized || sanitized === "_") return "unnamed";

  if (sanitized.length > MAX_FILENAME_LENGTH) {
    sanitized = sanitized.slice(0, MAX_FILENAME_LENGTH);
    sanitized = sanitized.replace(/_+$/, "");
  }

  // Check Windows reserved names
  const baseName = sanitized.replace(/\.[^.]*$/, "");
  if (WINDOWS_RESERVED_NAMES.has(baseName.toUpperCase())) {
    sanitized = `_${sanitized}`;
  }

  return sanitized;
}

