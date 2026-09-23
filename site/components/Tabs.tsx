"use client";

import { useId, useState, type ReactNode } from "react";

/**
 * Text tabs in the page's own voice: labels in rounded type, the active one
 * at full contrast over a Canvas-red rule. Panels are server-rendered and
 * passed in, so switching tabs never re-highlights code.
 */
export default function Tabs({ tabs }: { tabs: { label: string; content: ReactNode }[] }) {
  const [active, setActive] = useState(0);
  const id = useId();

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" className="flex flex-wrap gap-x-6 gap-y-1 border-b border-rule">
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            role="tab"
            id={`${id}-tab-${i}`}
            aria-selected={i === active}
            aria-controls={`${id}-panel-${i}`}
            onClick={() => setActive(i)}
            className={`font-rounded text-[15px] tracking-[-0.02em] pb-2 -mb-px border-b-2 transition-colors ${
              i === active
                ? "border-accent text-foreground"
                : "border-transparent text-subtle hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab, i) => (
        <div
          key={tab.label}
          role="tabpanel"
          id={`${id}-panel-${i}`}
          aria-labelledby={`${id}-tab-${i}`}
          hidden={i !== active}
          className="flex flex-col gap-4"
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
