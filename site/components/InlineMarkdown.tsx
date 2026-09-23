import type { ReactNode } from "react";
import { A, C } from "./prose";

/** Renders the inline Markdown used in CHANGELOG.md: `code`, **bold**, *italics*, and [links](url). */
export default function InlineMarkdown({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))|(\*[^*]+\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    if (match[1]) parts.push(<C key={key++}>{token.slice(1, -1)}</C>);
    else if (match[2]) parts.push(<strong key={key++} className="font-medium text-foreground">{token.slice(2, -2)}</strong>);
    else if (match[3]) {
      const [, label, href] = /\[([^\]]+)\]\(([^)]+)\)/.exec(token)!;
      parts.push(<A key={key++} href={href}>{label}</A>);
    } else parts.push(<em key={key++}>{token.slice(1, -1)}</em>);
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
