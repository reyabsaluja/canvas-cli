import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight } from "lucide-react";
import Scrollbar from "./scrollbar/Scrollbar";
import { findPage, REPO } from "@/lib/nav";
import { SECTIONS } from "@/lib/sections";

/** Where each route's source lives, for the "Edit this page" link. */
function sourcePath(href: string) {
  return href === "/" ? "site/app/page.tsx" : `site/app${href}page.tsx`;
}

/**
 * The frame every docs page shares: the portfolio case-study header (eyebrow
 * on the left, source link on the right, centred pixel title), the section
 * rail down the right edge, and previous/next links at the foot.
 */
export default function DocPage({
  href,
  hero,
  eyebrow,
  headerLink,
  sections: sectionsOverride,
  children,
}: {
  href: string;
  /** Replaces the standfirst on the overview page. */
  hero?: ReactNode;
  /** Replaces the group name at the top left (the overview shows the version). */
  eyebrow?: string;
  /** Replaces "Edit this page" at the top right. */
  headerLink?: { label: string; href: string };
  /** Sections computed at build time (the changelog), instead of lib/sections.ts. */
  sections?: { id: string; label: string }[];
  children: ReactNode;
}) {
  const { page, group, prev, next } = findPage(href);
  const sections = sectionsOverride ?? SECTIONS[href] ?? [];

  return (
    <main className="min-h-screen px-5 pt-10 pb-20 sm:px-8 md:px-12 lg:pt-16 xl:pr-[190px]">
      {sections.length > 0 && (
        <div className="hidden xl:block">
          <Scrollbar sections={sections} hoverColor="#e82429" lineLength={Math.min(360, sections.length * 30)} />
        </div>
      )}

      <article className="max-w-[760px] mx-auto flex flex-col gap-5">
        <header className="flex flex-col gap-4 mb-4">
          <div className="flex items-center justify-between font-rounded text-[15px] tracking-[-0.03em]">
            <span className="text-[#4b5563] dark:text-[#cfcfcf]">{eyebrow ?? group}</span>
            <a
              href={headerLink?.href ?? `${REPO}/blob/main/${sourcePath(href)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center underline underline-offset-[3px] text-[#4b5563] dark:text-[#cfcfcf] hover:text-foreground"
            >
              {headerLink?.label ?? "Edit this page"}
              <ArrowUpRight size={15} />
            </a>
          </div>
          <h1 className="font-pixel text-[32px] sm:text-[38px] tracking-[-0.01em] leading-[1.15] text-center mt-[11px] text-foreground">
            {page.title}
          </h1>
          {hero ?? (
            <p className="font-rounded text-[18px] text-[#2a3140] dark:text-white text-center max-w-[600px] mx-auto leading-[1.5]">
              {page.description}
            </p>
          )}
        </header>

        {children}

        <nav aria-label="Pagination" className="grid grid-cols-2 gap-4 mt-14 pt-8 border-t border-rule">
          {prev ? (
            <Link href={prev.href} className="group flex flex-col gap-1.5">
              <span className="font-rounded text-[13px] text-subtle inline-flex items-center gap-1">
                <ArrowLeft size={13} /> Previous
              </span>
              <span className="font-pixel text-[16px] text-foreground group-hover:text-accent transition-colors">
                {prev.navTitle ?? prev.title}
              </span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link href={next.href} className="group flex flex-col gap-1.5 items-end text-right">
              <span className="font-rounded text-[13px] text-subtle inline-flex items-center gap-1">
                Next <ArrowRight size={13} />
              </span>
              <span className="font-pixel text-[16px] text-foreground group-hover:text-accent transition-colors">
                {next.navTitle ?? next.title}
              </span>
            </Link>
          )}
        </nav>
      </article>
    </main>
  );
}
