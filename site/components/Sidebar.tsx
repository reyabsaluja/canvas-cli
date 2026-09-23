"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { NAV, NPM, REPO } from "@/lib/nav";
import ThemeToggle from "./ThemeToggle";
import SearchButton from "./SearchButton";

const normalize = (path: string) => (path.endsWith("/") ? path : `${path}/`);

export function Wordmark({ version }: { version: string }) {
  return (
    <Link href="/" className="group inline-flex flex-col gap-1">
      <span className="font-pixel text-[22px] tracking-[-0.01em] leading-none text-foreground inline-flex items-center gap-2">
        {/* The TUI's prompt marker, in its own red. */}
        <span aria-hidden className="inline-block size-[9px] bg-accent translate-y-[1px]" />
        canvas-cli
      </span>
      <span className="font-rounded text-[13px] text-subtle pl-[17px]">Docs · v{version}</span>
    </Link>
  );
}

export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = normalize(usePathname() ?? "/");

  return (
    <nav aria-label="Documentation" className="flex flex-col gap-7">
      {NAV.map((group) => (
        <div key={group.title} className="flex flex-col gap-2">
          <h2 className="font-pixel text-[13px] tracking-[-0.01em] text-foreground">{group.title}</h2>
          <ul className="flex flex-col gap-[3px]">
            {group.pages.map((page) => {
              const active = normalize(page.href) === pathname;
              return (
                <li key={page.href} className="relative">
                  {active && (
                    <span aria-hidden className="absolute -left-[13px] top-1/2 -translate-y-1/2 size-[5px] bg-accent" />
                  )}
                  <Link
                    href={page.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`block font-rounded text-[15px] tracking-[-0.02em] py-[3px] transition-colors ${
                      active ? "text-foreground" : "text-muted hover:text-foreground"
                    }`}
                  >
                    {page.navTitle ?? page.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function ExternalLinks() {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-4 font-rounded text-[14px] tracking-[-0.02em]">
        <a href={REPO} target="_blank" rel="noopener noreferrer" className="inline-flex items-center text-muted hover:text-foreground underline underline-offset-[3px]">
          GitHub
          <ArrowUpRight size={14} />
        </a>
        <a href={NPM} target="_blank" rel="noopener noreferrer" className="inline-flex items-center text-muted hover:text-foreground underline underline-offset-[3px]">
          npm
          <ArrowUpRight size={14} />
        </a>
      </div>
      <ThemeToggle />
    </div>
  );
}

/** Fixed left column on wide screens. */
export default function Sidebar({ version }: { version: string }) {
  return (
    <aside className="hidden lg:flex fixed inset-y-0 left-0 w-[264px] flex-col border-r border-rule bg-background z-20">
      <div className="px-8 pt-10 pb-6">
        <Wordmark version={version} />
      </div>
      <div className="px-8 pb-6">
        <SearchButton />
      </div>
      <div className="flex-1 overflow-y-auto px-8 pb-10 [scrollbar-width:thin]">
        <NavLinks />
      </div>
      <div className="px-8 py-5 border-t border-rule">
        <ExternalLinks />
      </div>
    </aside>
  );
}
