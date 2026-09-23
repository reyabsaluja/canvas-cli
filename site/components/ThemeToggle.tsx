"use client";

import { Moon, Sun } from "lucide-react";

/** Flips the `.dark` class and remembers the choice, same key as the portfolio. */
export default function ThemeToggle() {
  const toggle = () => {
    const dark = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("theme", dark ? "dark" : "light");
    } catch {}
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle dark mode"
      title="Toggle dark mode"
      className="inline-flex items-center justify-center size-8 rounded-md text-subtle hover:text-foreground hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
    >
      <Sun size={16} className="hidden dark:block" />
      <Moon size={16} className="block dark:hidden" />
    </button>
  );
}
