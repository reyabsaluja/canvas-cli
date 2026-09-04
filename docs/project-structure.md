# Project Structure

## Top Level

```text
canvas-cli/
├── .github/               CI and publish workflows
├── bin/                   Node launcher for the published package
├── docs/                  Maintainer and contributor documentation
│   └── harness-loop.md    Improvement-loop state: area rotation, per-area file ownership, backlog, Done log
├── src/                   TypeScript source code
├── tests/                 Automated tests (primary location)
├── test/                  A few older TUI regression tests
├── dist/                  Compiled output (ignored)
├── .canvas-cli/           Local runtime data and generated workspaces (ignored)
├── README.md              User-facing entry point
├── CHANGELOG.md           Release notes
├── CONTRIBUTING.md        Contributor workflow and expectations
├── RELEASING.md           Versioning and release process
├── package.json           Scripts and package metadata
└── tsconfig.json          TypeScript compiler configuration
```

## Source Layout

```text
src/
├── agent/                 Shared agent run state, retrieval gating, observation and verification helpers
├── ai/                    Provider setup and routing, model catalog, prompt helpers, context bundling
│   ├── backends/          Vendor CLI drivers for subscription providers (copilot.ts, codex.ts)
│   ├── cli-backend.ts     Shared CLI plumbing: provider table, executable lookup, JSONL runner, transcript prompt
│   ├── mcp-bridge.ts      Localhost MCP server (per-run bearer token) exposing a request's tools to the vendor CLI
│   ├── subscription-status.ts  Installed / signed-in checks and foreground `<cli> login`
│   └── errors.ts          AIError type shared by the AI SDK and CLI paths
├── ask/                   Workspace retrieval and grounded answer generation
├── canvas/                Canvas API client, retry, throttling, remote type definitions
├── commands/              CLI subcommand handlers (login, logout, status, ingest, clean, examples)
│                          and the TUI-invoked model picker (model.ts)
├── config/                Environment loading, profiles, config store, credential storage
├── domain/                Shared domain models, matching, sorting, resolution
├── enrich/                Cache-backed assignment enrichment
├── extract/               Text extraction utilities
├── format/                Console and markdown rendering helpers
├── ingest/                Course ingestion pipeline
├── knowledge/             Artifact index over cached course and workspace files
├── pdf/                   PDF generation, LaTeX rendering, and Tectonic setup
├── tui/                   Interactive terminal app, slash commands, chat agent, views
├── work/                  Assignment investigation and workup synthesis
├── workspace/             Local workspace creation, lifecycle, and path helpers
├── cli.ts                 CLI entrypoint
├── debug.ts               --debug logging with secret masking
├── errors.ts              Shared error types and classification
└── sanitize.ts            Filename, path, and terminal-output sanitization
```

## Placement Rules

- Put CLI wiring in `src/commands/`, not in domain or API modules.
- Put Canvas HTTP logic in `src/canvas/`.
- Put reusable ranking, filtering, matching, and normalization in `src/domain/`.
- Put cache-specific enrichment behavior in `src/enrich/`.
- Put AI-only orchestration in `src/work/` or `src/ask/` depending on the user flow; put TUI chat tooling under `src/tui/chat-agent/`.
- Put a new CLI-driven (subscription) AI provider in `src/ai/backends/` and register it in `src/ai/cli-backend.ts` and `src/ai/provider.ts`; API-key providers stay on the AI SDK path in `src/ai/provider.ts`.
- Put rendering-only helpers in `src/format/`.
- Route anything that touches the filesystem from untrusted names through `src/sanitize.ts`.
- Use kebab-case for new files to keep the tree consistent.
- Before editing ingestion, extraction, retrieval, agent, or grounding code, check the ownership table in `docs/harness-loop.md` so changes stay within one area's files.

## Tests

- Put new tests in `tests/`. The `test/` directory holds a handful of older TUI regression tests; both are picked up by `bun run test`.
- Shared fixtures and the mock Canvas server live in `tests/helpers/`.
- Add tests for parsing, formatting, and other logic that can run without live Canvas credentials.
- Favor tests around boundary-heavy code such as TUI input parsing, config resolution, and workspace generation helpers.
