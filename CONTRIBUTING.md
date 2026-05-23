# Contributing

## Setup

```bash
bun install
cp .env.example .env
```

Add your Canvas credentials to `.env`. If you want to use AI-assisted commands, also add one supported AI provider key.

## Common Commands

```bash
bun run dev
bun run typecheck
bun run test
bun run build
bun run check
```

## Project Conventions

- Keep source files in `src/` and compiled output in `dist/`.
- Prefer small modules with a single responsibility.
- Use kebab-case for new file names.
- Keep Canvas API access in `src/canvas/` and avoid scattering request logic across command files.
- Prefer deterministic logic in `src/domain/`, `src/enrich/`, and `src/ingest/` before reaching for AI behavior in `src/work/` or `src/ask/`.
- Do not commit `.env`, `dist/`, or `.canvas-cli/`.

## Before Opening a PR

- Run `bun run check`
- Update documentation when structure or behavior changes
- Add or extend tests when touching TUI parsing, workspace behavior, or CLI command flows
- Add a bullet under `[Unreleased]` in `CHANGELOG.md` for user-visible changes

## Versioning and Releases

This project follows [Semantic Versioning](https://semver.org/). See [RELEASING.md](./RELEASING.md) for the full release process, versioning strategy, and release checklist.
