# canvas-cli docs site

The documentation at https://reyabsaluja.github.io/canvas-cli/, built with Next.js as a static export and
deployed by `.github/workflows/docs.yml` on every push to `main` that touches `site/` or `CHANGELOG.md`.

```bash
cd site
bun install
bun run dev        # http://localhost:3000/canvas-cli/
bun run build      # static export in out/
```

## Layout

- `app/<route>/page.tsx`: one file per page, written directly in TSX with the components below.
- `lib/nav.ts`: the page list. Sidebar order, page titles and descriptions, and previous/next links come from here.
- `lib/sections.ts`: each page's section ids and labels, for the right-hand rail and search. Add a heading, add it here.
- `components/prose.tsx`, `blocks.tsx`: the type voices (`Body`, `C`, `Term`, `Kbd`) and blocks (`Callout`, `Table`, `Figure`, `Steps`).
- `components/scrollbar/`: the section rail, shared with the portfolio case studies.
- `assets/`: terminal screenshots, imported statically so they respect the base path.

The version in the sidebar and the changelog page are read from the repository root (`package.json`,
`CHANGELOG.md`) at build time, so they never need editing here.

## Style

The design follows the portfolio case studies: Geist Pixel headings, SF Rounded body copy in grey, a single
centred column, and Canvas red (`#e82429`) as the only accent. Write in plain, specific sentences; say what
canvas-cli does, not how great it is. Every claim should match the source, so check `src/` before documenting
a behaviour.
