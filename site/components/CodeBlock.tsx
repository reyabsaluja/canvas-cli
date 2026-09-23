import { codeToHtml } from "shiki";
import CopyButton from "./CopyButton";

/**
 * Syntax-highlighted code, coloured by Shiki at build time - the page ships
 * plain HTML, with no highlighter in the client bundle. Both themes are
 * emitted at once; globals.css swaps in the dark colours under `.dark`.
 */

/**
 * Re-expresses leading indentation as tabs so its width is a CSS decision
 * (`tab-size` in globals.css) rather than whatever the snippet used.
 */
function toTabs(code: string) {
  const indents = [...code.matchAll(/^ +/gm)].map((m) => m[0].length);
  const unit = indents.length ? Math.min(...indents) : 0;
  if (!unit) return code;
  return code.replace(/^ +/gm, (run) => {
    const levels = Math.floor(run.length / unit);
    return "\t".repeat(levels) + " ".repeat(run.length - levels * unit);
  });
}

/** What the copy button puts on the clipboard: commands without their comments. */
function copyText(code: string, lang: string) {
  if (lang !== "bash" && lang !== "sh") return code;
  return code
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#\s.*$/, ""))
    .join("\n")
    .trim();
}

export default async function CodeBlock({
  children,
  caption,
  title,
  lang = "bash",
  copy = true,
}: {
  children: string;
  caption?: string;
  /** File name or context shown above the code, e.g. `.env`. */
  title?: string;
  lang?: string;
  copy?: boolean;
}) {
  const code = children.replace(/^\n+|\n+$/g, "");
  const html = await codeToHtml(toTabs(code), {
    lang,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });

  return (
    <div className="flex flex-col mb-1">
      <div className="relative border border-rule bg-neutral-50 dark:bg-neutral-900">
        {title && (
          <div className="font-mono text-[12px] text-subtle px-4 pt-3 -mb-1">{title}</div>
        )}
        <div
          className="shiki-block w-full overflow-x-auto p-4 pr-12 text-[13px] leading-relaxed"
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {copy && (
          <div className="absolute top-2 right-2">
            <CopyButton text={copyText(code, lang)} />
          </div>
        )}
      </div>
      {caption && (
        <p className="mt-3 text-[14px] text-neutral-500 dark:text-neutral-400 font-rounded mb-2">{caption}</p>
      )}
    </div>
  );
}
