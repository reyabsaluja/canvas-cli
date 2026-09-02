# Development Guide

## Prerequisites

- Node.js 20 or newer
- Bun 1.3.11 or newer
- Canvas API credentials: run `bun run dev login` (stored under `~/.config/canvas-cli/`), or set `CANVAS_BASE_URL` and `CANVAS_ACCESS_TOKEN` in `.env` as an alternative

## First-Time Setup

```bash
bun install
bun run dev login          # or: cp .env.example .env and fill it in
```

## Useful Commands

```bash
bun run dev
bun run typecheck
bun run test
bun run build
bun run check
```

## Working Agreement

- Use `bun run dev` while iterating on command or TUI behavior.
- Use `bun run typecheck` before larger refactors.
- Use `bun run test` for local regression coverage.
- Use `bun run check` before merging structural or behavior changes.

Tests are invoked through Bun scripts but still use Node's `node:test` runner because the suite uses nested subtests that Bun's native test runner does not yet support.

The published CLI still targets Node through `dist/cli.js` and the `@reyabsaluja/canvas-cli` package `bin`, so users can install released versions with `npm install -g @reyabsaluja/canvas-cli` even though this repository uses Bun for development.

## Local State

Generated course caches and workspaces live under `.canvas-cli/`. That folder is intentionally ignored and should be treated as disposable local state.

## Documentation Expectations

Update docs when you change:

- top-level structure
- source folder responsibilities
- setup requirements
- scripts or verification commands
