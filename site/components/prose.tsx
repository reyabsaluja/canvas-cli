import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The page's type voices, lifted from the portfolio case studies: Geist Pixel
 * for headings, SF Rounded in a soft grey for body copy, SF Mono for anything
 * you would type.
 */

export function SectionHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="font-pixel text-[20px] tracking-[-0.01em] mt-6 text-foreground">
      {children}
    </h2>
  );
}

/** A heading inside a section, a step down from the section heading. */
export function SubHeading({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3 id={id} className="font-pixel text-[16px] tracking-[-0.01em] mt-3 text-foreground">
      {children}
    </h3>
  );
}

export function Body({ children }: { children: ReactNode }) {
  return <p className="font-rounded text-[17px] leading-[1.6] text-muted">{children}</p>;
}

/** Body copy a step down, for asides and dense reference pages. */
export function Aside({ children }: { children: ReactNode }) {
  return <p className="font-rounded text-[16px] leading-[1.6] text-muted">{children}</p>;
}

/** Pulls a term up to full contrast. Used sparingly - a few per page. */
export function Term({ children }: { children: ReactNode }) {
  return <strong className="font-medium text-foreground">{children}</strong>;
}

/** Inline code: commands, flags, file names, environment variables. */
export function C({ children }: { children: ReactNode }) {
  return (
    <code className="font-mono text-[14.5px] px-[5px] py-[2px] bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 break-words">
      {children}
    </code>
  );
}

/** A key on the keyboard. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="font-mono text-[13px] px-[6px] py-[1px] border border-rule border-b-2 rounded-[4px] text-foreground bg-background whitespace-nowrap">
      {children}
    </kbd>
  );
}

/** Link inside body copy. Internal hrefs go through next/link for the base path. */
export function A({ href, children }: { href: string; children: ReactNode }) {
  if (href.startsWith("http")) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="prose-link">
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className="prose-link">
      {children}
    </Link>
  );
}

export function List({ children, ordered = false }: { children: ReactNode; ordered?: boolean }) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag
      className={`font-rounded text-[17px] leading-[1.6] text-muted flex flex-col gap-2 pl-6 ${
        ordered ? "list-decimal marker:text-subtle" : "list-disc marker:text-neutral-300 dark:marker:text-neutral-600"
      }`}
    >
      {children}
    </Tag>
  );
}

export function Li({ children }: { children: ReactNode }) {
  return <li className="pl-1">{children}</li>;
}
