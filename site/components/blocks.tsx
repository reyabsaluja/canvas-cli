import Image, { type StaticImageData } from "next/image";
import type { ReactNode } from "react";

const CALLOUT_LABEL = { note: "Note", tip: "Tip", warning: "Important" } as const;

/** A quiet aside: a thin coloured rule and a pixel label, never a filled box. */
export function Callout({
  kind = "note",
  title,
  children,
}: {
  kind?: keyof typeof CALLOUT_LABEL;
  title?: string;
  children: ReactNode;
}) {
  const rule =
    kind === "warning" ? "border-accent" : kind === "tip" ? "border-accent-warm" : "border-neutral-300 dark:border-neutral-600";
  return (
    <aside className={`border-l-2 ${rule} pl-5 py-1 my-1 flex flex-col gap-1.5`}>
      <span className="font-pixel text-[13px] tracking-[-0.01em] text-foreground">{title ?? CALLOUT_LABEL[kind]}</span>
      <div className="font-rounded text-[16px] leading-[1.6] text-muted flex flex-col gap-2">{children}</div>
    </aside>
  );
}

/** Minimal reference table: hairline rules, no fills, scrolls sideways on phones. */
export function Table({ head, rows }: { head: ReactNode[]; rows: ReactNode[][] }) {
  return (
    <div className="w-full overflow-x-auto my-1">
      <table className="w-full border-collapse text-left font-rounded">
        <thead>
          <tr className="border-b border-rule">
            {head.map((cell, i) => (
              <th key={i} className="text-[14px] font-medium text-foreground py-2.5 pr-6 align-bottom whitespace-nowrap">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b border-rule last:border-b-0">
              {row.map((cell, c) => (
                <td
                  key={c}
                  className={`text-[15px] leading-[1.55] text-muted py-2.5 pr-6 align-top ${c === 0 ? "min-w-[9rem]" : ""}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A screenshot with its caption. Terminal captures are dark in both themes. */
export function Figure({
  src,
  alt,
  caption,
  className = "",
}: {
  src: StaticImageData;
  alt: string;
  caption?: string;
  className?: string;
}) {
  return (
    <figure className="flex flex-col mb-2">
      {/* Terminal captures are dense at column width; a click opens the full-size image. */}
      <a href={src.src} target="_blank" rel="noopener noreferrer" className="block cursor-zoom-in" title="Open full size">
        <Image
          src={src}
          alt={alt}
          sizes="(min-width: 1024px) 760px, 100vw"
          className={`w-full h-auto rounded-md border border-neutral-200 dark:border-neutral-800 ${className}`}
        />
      </a>
      {caption && (
        <figcaption className="mt-3 text-[14px] text-neutral-500 dark:text-neutral-400 font-rounded mb-3">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}

/** Numbered steps: pixel numerals in a narrow gutter, content beside them. */
export function Steps({ children }: { children: ReactNode }) {
  return <ol className="flex flex-col gap-7 my-1">{children}</ol>;
}

export function Step({ n, title, id, children }: { n: number; title: string; id?: string; children: ReactNode }) {
  return (
    <li id={id} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3">
      <span className="font-pixel text-[16px] text-accent leading-[1.4]">{String(n).padStart(2, "0")}</span>
      <div className="flex flex-col gap-3 min-w-0">
        <h3 className="font-pixel text-[16px] tracking-[-0.01em] text-foreground leading-[1.4]">{title}</h3>
        {children}
      </div>
    </li>
  );
}
