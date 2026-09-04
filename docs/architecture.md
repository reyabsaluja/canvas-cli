# Architecture Overview

## System Shape

`canvas-cli` is a single-package TypeScript CLI with three major responsibilities:

1. Talk to Canvas safely and consistently.
2. Build deterministic local caches and workspaces from course data.
3. Layer optional AI-assisted investigation and question answering on top of those local artifacts.

## Major Runtime Flows

### 1. Entry and setup

- `src/cli.ts` registers the setup commands (`login`, `logout`, `status`, `ingest`, `clean`, `examples`) and launches the TUI when run with no command.
- `src/commands/` contains thin command handlers for setup operations, plus the TUI-invoked `/model` flow.
- `src/config/` resolves the active profile, stored config, credentials (Keychain or file), and `.env` overrides.
- `src/canvas/` handles Canvas API communication, including retries, throttling, and abort support.
- `src/domain/` normalizes and resolves courses and assignments for user-facing workflows.

### 2. Course ingestion

- `src/ingest/` fetches modules, files (folder-aware Files-tab crawl), pages, assignments, quizzes, announcements and discussion threads with replies, course-navigation tools, and assignment groups from Canvas, and builds "Quiz: ...", "Course tools", and "Grading scheme" reference pages.
- The ingestion pipeline chooses relevant attachments, downloads local copies, extracts text, and writes artifacts under `.canvas-cli/courses/`.
- `src/enrich/` reads that stored data later to add deterministic context to assignment results.
- `src/knowledge/` indexes cached artifacts so the TUI and agents can retrieve them by name or content.

### 3. Assignment workspace creation

- `src/work/` drives the investigation workflow for a specific assignment.
- The work pipeline combines assignment details, ingestion cache data, and AI tool calls.
- Output is written through `src/workspace/` into `.canvas-cli/sessions/<slug>/`.

### 4. Workspace question answering

- `src/ask/` loads workspace artifacts, retrieves supporting context, and produces grounded answers.
- The answer flow depends on previously generated local workspace files rather than live Canvas reads.

### 5. Interactive terminal UI

- `src/tui/` owns the interactive application: the chat shell, scope runtime, slash commands, pickers, and feature views (`/timeline`, `/grade`, `/quiz`, `/announcements`, `/thread`, `/lecture`, `/pdf`, `/doctor`).
- `src/tui/chat-agent/` defines the chat agent's tools, prompt, memory, and verification; `src/agent/` holds run state and gating logic shared with the work pipeline.
- `src/pdf/` renders `/pdf` exports, using LaTeX via Tectonic when available.
- The TUI is the primary interface — all course browsing, assignment interaction, and AI features are accessed through it.

### 6. AI provider backends

- `src/ai/provider.ts` routes every model call. API-key providers (Anthropic, OpenAI, Google, Bedrock) go through the Vercel AI SDK; subscription providers (`copilot`, `codex`) take the CLI path and never touch the SDK.
- `src/ai/cli-backend.ts` is the shared CLI plumbing: the `SUBSCRIPTION_PROVIDERS` table (binary, install/login hints, experimental flag), executable lookup, the JSONL child-process runner, the transcript prompt builder, scratch-directory creation, and CLI failure classification.
- `src/ai/backends/` holds one driver per vendor CLI (`copilot.ts`, `codex.ts`) that builds the non-interactive command line, strips the CLI's own tools, and parses its event stream.
- `src/ai/mcp-bridge.ts` is a minimal MCP server on `127.0.0.1` with a per-run bearer token; it exposes the current request's tools to the CLI while tool execution stays in-process.
- `src/ai/subscription-status.ts` answers "is the CLI installed / signed in?" and runs the vendor's foreground `login`; used by `login`, `/model`, `status`, and `/doctor`.
- `src/ai/errors.ts` defines `AIError` (kind, retry hint, setup hint) shared by both paths.

## Source Responsibility Map

| Area | Responsibility |
| --- | --- |
| `src/agent/` | Agent run state, retrieval gating, observation relevance, verification |
| `src/ai/` | AI provider setup and routing, model catalog, prompting, context bundling, shared AI types; `backends/`, `cli-backend.ts`, `mcp-bridge.ts`, and `subscription-status.ts` implement the subscription (vendor CLI) path |
| `src/ask/` | Retrieval and answer generation for prepared workspaces |
| `src/canvas/` | Canvas API client, retry and throttle policy, remote types |
| `src/commands/` | Setup CLI entrypoints (`login`, `logout`, `status`, `ingest`, `clean`, `examples`) and TUI-invoked flows (`model`) |
| `src/config/` | Environment loading, profiles, config store, credential storage |
| `src/domain/` | Core models, matching, normalization, ranking, and resolution |
| `src/enrich/` | Deterministic enrichment from cached course artifacts |
| `src/extract/` | Text extraction utilities for downloaded documents |
| `src/format/` | Rendering helpers for console and markdown output |
| `src/ingest/` | Course ingestion, attachment selection, and storage |
| `src/knowledge/` | Artifact index over cached course and workspace files |
| `src/pdf/` | PDF generation and LaTeX rendering |
| `src/tui/` | Interactive terminal application, slash commands, chat agent, views |
| `src/work/` | AI-assisted investigation and workup synthesis |
| `src/workspace/` | Workspace pathing, creation, lifecycle, and attachment helpers |
| `src/debug.ts` | `--debug` logging with secret masking |
| `src/errors.ts` | Structured error types and classification |
| `src/sanitize.ts` | Filename, path, and terminal-output sanitization |

## Design Principles

- Keep setup command handlers thin and push reusable logic into domain modules.
- Prefer deterministic data preparation before AI synthesis.
- Treat `.canvas-cli/` as generated local state, not source-controlled content.
- Keep the TUI isolated from Canvas-specific logic where possible so workflows stay testable.
- Never write to disk from an untrusted name without going through `src/sanitize.ts`.

## Improvement Loop

- `docs/harness-loop.md` is the state file for the recurring improvement loop: the area rotation (discover → extract → retrieve → reason → ground), which files each area owns and must never touch, the open backlog, and a one-line Done log. Read it before changing ingestion, extraction, retrieval, agent, or grounding code.
