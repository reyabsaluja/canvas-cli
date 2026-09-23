"use client";

import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ExternalLinks, NavLinks, Wordmark } from "./Sidebar";
import SearchButton from "./SearchButton";

/** Top bar and full-height menu for screens without room for the sidebar. */
export default function MobileNav({ version }: { version: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <header className="sticky top-0 z-30 flex items-center justify-between px-5 h-16 border-b border-rule bg-background/90 backdrop-blur">
        <Wordmark version={version} />
        <div className="flex items-center gap-1">
          <SearchButton compact />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            className="inline-flex items-center justify-center size-9 rounded-md text-muted hover:text-foreground"
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </header>
      {open && (
        <div className="fixed inset-x-0 top-16 bottom-0 z-30 bg-background overflow-y-auto px-6 pt-6 pb-10 flex flex-col gap-8">
          <NavLinks onNavigate={() => setOpen(false)} />
          <div className="border-t border-rule pt-5">
            <ExternalLinks />
          </div>
        </div>
      )}
    </div>
  );
}
