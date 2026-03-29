# Development Guide

## Prerequisites

- Node.js with ESM support for the current toolchain
- An npm environment capable of running `tsx` and `typescript`
- Canvas API credentials in `.env`

## First-Time Setup

```bash
npm install
cp .env.example .env
```

## Useful Commands

```bash
npm run dev
npm run typecheck
npm run test
npm run build
npm run check
```

## Working Agreement

- Use `npm run dev` while iterating on command or TUI behavior.
- Use `npm run typecheck` before larger refactors.
- Use `npm run test` for local regression coverage.
- Use `npm run check` before merging structural or behavior changes.

## Local State

Generated course caches and workspaces live under `.canvas-cli/`. That folder is intentionally ignored and should be treated as disposable local state.

## Documentation Expectations

Update docs when you change:

- top-level structure
- source folder responsibilities
- setup requirements
- scripts or verification commands
