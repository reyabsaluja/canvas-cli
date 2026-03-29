# Project Structure

## Top Level

```text
canvas-cli/
├── docs/                  Maintainer and contributor documentation
├── src/                   TypeScript source code
├── test/                  Automated tests
├── dist/                  Compiled output
├── .canvas-cli/           Local runtime data and generated workspaces
├── README.md              User-facing entry point
├── CONTRIBUTING.md        Contributor workflow and expectations
├── package.json           Scripts and package metadata
└── tsconfig.json          TypeScript compiler configuration
```

## Source Layout

```text
src/
├── ai/                    Provider setup, prompt helpers, structured parsing
├── ask/                   Workspace retrieval and answer generation
├── canvas/                Canvas API client and remote type definitions
├── commands/              CLI subcommand handlers
├── config/                Environment loading
├── domain/                Shared domain models, matching, sorting, resolution
├── enrich/                Cache-backed assignment enrichment
├── extract/               Text extraction utilities
├── format/                Console and markdown rendering helpers
├── ingest/                Course ingestion pipeline
├── tui/                   Interactive terminal app
├── work/                  Assignment investigation and workup synthesis
├── workspace/             Local workspace creation and path helpers
├── cli.ts                 CLI entrypoint
└── errors.ts              Shared error handling
```

## Placement Rules

- Put CLI wiring in `src/commands/`, not in domain or API modules.
- Put Canvas HTTP logic in `src/canvas/`.
- Put reusable ranking, filtering, matching, and normalization in `src/domain/`.
- Put cache-specific enrichment behavior in `src/enrich/`.
- Put AI-only orchestration in `src/work/` or `src/ask/` depending on the user flow.
- Put rendering-only helpers in `src/format/`.
- Use kebab-case for new files to keep the tree consistent.

## Tests

- Keep regression tests in `test/`.
- Add tests for parsing, formatting, and other logic that can run without live Canvas credentials.
- Favor tests around boundary-heavy code such as TUI input parsing and workspace generation helpers.
