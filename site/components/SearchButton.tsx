"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ALL_PAGES } from "@/lib/nav";
import { SECTIONS } from "@/lib/sections";

type Entry = { href: string; title: string; context: string; haystack: string };

/** Every page and every section heading, flattened for matching. */
function buildIndex(): Entry[] {
  const entries: Entry[] = [];
  for (const page of ALL_PAGES) {
    const title = page.navTitle ?? page.title;
    entries.push({
      href: page.href,
      title,
      context: page.description,
      haystack: `${title} ${page.title} ${page.description}`.toLowerCase(),
    });
    for (const section of SECTIONS[page.href] ?? []) {
      entries.push({
        href: `${page.href}#${section.id}`,
        title: section.label,
        context: title,
        haystack: `${section.label} ${section.keywords ?? ""} ${title}`.toLowerCase(),
      });
    }
  }
  return entries;
}

function score(entry: Entry, terms: string[]) {
  let total = 0;
  for (const term of terms) {
    const at = entry.haystack.indexOf(term);
    if (at === -1) return 0;
    // Earlier and title matches rank higher.
    total += entry.title.toLowerCase().includes(term) ? 3 : 1;
    total += at === 0 ? 1 : 0;
  }
  return total;
}

export default function SearchButton({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const index = useMemo(buildIndex, []);

  const results = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return index.filter((e) => !e.href.includes("#")).slice(0, 8);
    return index
      .map((entry) => ({ entry, s: score(entry, terms) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 10)
      .map((r) => r.entry);
  }, [index, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, []);

  const go = useCallback(
    (href: string) => {
      close();
      router.push(href);
    },
    [close, router]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      go(results[active].href);
    }
  };

  return (
    <>
      {compact ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Search the docs"
          className="inline-flex items-center justify-center size-9 rounded-md text-muted hover:text-foreground"
        >
          <Search size={18} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full flex items-center gap-2 h-9 px-3 rounded-md border border-rule text-subtle hover:text-foreground hover:border-neutral-300 dark:hover:border-neutral-600 transition-colors font-rounded text-[14px]"
        >
          <Search size={14} />
          <span className="flex-1 text-left">Search</span>
          <kbd className="font-mono text-[11px] text-subtle">⌘K</kbd>
        </button>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/25 dark:bg-black/60 backdrop-blur-[2px] flex items-start justify-center pt-[12vh] px-4"
          onMouseDown={(e) => e.target === e.currentTarget && close()}
        >
          <div
            role="dialog"
            aria-label="Search the docs"
            className="w-full max-w-[560px] bg-background border border-rule rounded-lg shadow-2xl overflow-hidden"
          >
            <div className="flex items-center gap-3 px-4 border-b border-rule">
              <Search size={16} className="text-subtle shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onInputKey}
                placeholder="Search commands, settings, guides..."
                className="flex-1 h-12 bg-transparent outline-none font-rounded text-[16px] text-foreground placeholder:text-subtle"
              />
              <kbd className="font-mono text-[11px] text-subtle">esc</kbd>
            </div>
            <ul className="max-h-[50vh] overflow-y-auto py-2">
              {results.length === 0 && (
                <li className="px-4 py-6 text-center font-rounded text-[15px] text-subtle">No matches for “{query}”</li>
              )}
              {results.map((result, i) => (
                <li key={result.href}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(result.href)}
                    className={`w-full text-left px-4 py-2.5 flex flex-col gap-0.5 ${
                      i === active ? "bg-neutral-100 dark:bg-neutral-800/70" : ""
                    }`}
                  >
                    <span className="font-rounded text-[15px] text-foreground flex items-center gap-2">
                      {i === active && <span aria-hidden className="size-[5px] bg-accent shrink-0" />}
                      {result.title}
                    </span>
                    <span className="font-rounded text-[13px] text-subtle line-clamp-1">{result.context}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
