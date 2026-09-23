/**
 * The docs' table of contents. Sidebar order, the eyebrow over each page
 * title, and the previous/next links at the foot of every page all come from
 * this one list.
 */

export type DocPageMeta = {
  href: string;
  title: string;
  /** Shorter label for the sidebar, when the title is long. */
  navTitle?: string;
  /** One sentence under the page title, and the search index summary. */
  description: string;
};

export type NavGroup = { title: string; pages: DocPageMeta[] };

export const NAV: NavGroup[] = [
  {
    title: "Getting started",
    pages: [
      {
        href: "/",
        title: "canvas-cli",
        navTitle: "Overview",
        description:
          "Canvas LMS in your terminal: courses, assignments, grades, and an assistant that reads your course material and shows its sources.",
      },
      {
        href: "/quickstart/",
        title: "Quickstart",
        description:
          "Install canvas-cli, connect it to your school's Canvas, and open your first assignment workspace in about five minutes.",
      },
      {
        href: "/installation/",
        title: "Installation",
        description:
          "Every way to install canvas-cli, how to update it, and how to remove it cleanly.",
      },
    ],
  },
  {
    title: "Using canvas-cli",
    pages: [
      {
        href: "/shell/",
        title: "The interactive shell",
        navTitle: "The shell",
        description:
          "One chat shell with three scopes, global, course, and workspace, plus the keys and input tricks that make it fast.",
      },
      {
        href: "/workspaces/",
        title: "Assignment workspaces",
        navTitle: "Workspaces",
        description:
          "Open an assignment and canvas-cli reads everything relevant to it, then writes a brief, a plan, and a workup you can come back to.",
      },
      {
        href: "/asking-questions/",
        title: "Asking questions",
        description:
          "How the assistant finds answers in your course material, cites the exact page, and tells you when it could not confirm something.",
      },
      {
        href: "/ingestion/",
        title: "Course ingestion",
        navTitle: "Ingestion",
        description:
          "What canvas-cli downloads from a course, how it extracts text from every file type, and where it all lives on disk.",
      },
      {
        href: "/study-tools/",
        title: "Study tools",
        description:
          "Timelines, grades, practice quizzes, lectures, announcements, and PDF export, straight from the shell.",
      },
    ],
  },
  {
    title: "Configuration",
    pages: [
      {
        href: "/ai-providers/",
        title: "AI providers",
        description:
          "Use an API key from Anthropic, OpenAI, Google, or AWS Bedrock, or the GitHub Copilot or ChatGPT plan you already have.",
      },
      {
        href: "/configuration/",
        title: "Profiles and settings",
        description:
          "Where canvas-cli keeps credentials and config, how profiles separate accounts, and every environment variable it reads.",
      },
    ],
  },
  {
    title: "Reference",
    pages: [
      {
        href: "/cli-reference/",
        title: "CLI reference",
        description:
          "Every canvas-cli command and flag you can run from your shell.",
      },
      {
        href: "/slash-commands/",
        title: "Slash commands",
        description:
          "Every command you can type inside the shell, grouped by the scope it works in.",
      },
      {
        href: "/local-files/",
        title: "Local files",
        description:
          "The .canvas-cli folder, file by file: course caches, workspaces, chat sessions, and exports.",
      },
    ],
  },
  {
    title: "Resources",
    pages: [
      {
        href: "/privacy/",
        title: "Privacy and security",
        navTitle: "Privacy",
        description:
          "What stays on your machine, exactly what leaves it and where it goes, and how secrets are protected.",
      },
      {
        href: "/troubleshooting/",
        title: "Troubleshooting",
        description:
          "Fixes for sign-in failures, network errors, missing courses, and AI features that will not start.",
      },
      {
        href: "/changelog/",
        title: "Changelog",
        description: "What changed in each release of canvas-cli.",
      },
    ],
  },
];

export const ALL_PAGES: DocPageMeta[] = NAV.flatMap((group) => group.pages);

export function findPage(href: string) {
  const index = ALL_PAGES.findIndex((page) => page.href === href);
  if (index === -1) throw new Error(`Page ${href} is missing from lib/nav.ts`);
  const group = NAV.find((g) => g.pages.some((page) => page.href === href))!;
  return {
    page: ALL_PAGES[index],
    group: group.title,
    prev: index > 0 ? ALL_PAGES[index - 1] : undefined,
    next: index < ALL_PAGES.length - 1 ? ALL_PAGES[index + 1] : undefined,
  };
}

export const REPO = "https://github.com/reyabsaluja/canvas-cli";
export const NPM = "https://www.npmjs.com/package/@reyabsaluja/canvas-cli";
export const INSTALL_URL =
  "https://raw.githubusercontent.com/reyabsaluja/canvas-cli/main/install.sh";

/** Per-page <title> and description, straight from the registry above. */
export function metadataFor(href: string) {
  const { page } = findPage(href);
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: href },
    openGraph: { title: `${page.title} · canvas-cli`, description: page.description },
  };
}
