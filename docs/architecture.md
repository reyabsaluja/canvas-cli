# Architecture Overview

## System Shape

`canvas-cli` is a single-package TypeScript CLI with three major responsibilities:

1. Talk to Canvas safely and consistently.
2. Build deterministic local caches and workspaces from course data.
3. Layer optional AI-assisted investigation and question answering on top of those local artifacts.

## Major Runtime Flows

### 1. Entry and setup

- `src/cli.ts` registers the setup commands (`login`, `logout`, `status`, `ingest`) and launches the TUI by default.
- `src/commands/` contains thin command handlers for setup operations.
- `src/canvas/` handles Canvas API communication.
- `src/domain/` normalizes and resolves courses and assignments for user-facing workflows.

### 2. Course ingestion

- `src/ingest/` fetches modules, files, pages, and assignments from Canvas.
- The ingestion pipeline chooses relevant attachments, downloads local copies, and writes artifacts under `.canvas-cli/courses/`.
- `src/enrich/` reads that stored data later to add deterministic context to assignment results.

### 3. Assignment workspace creation

- `src/work/` drives the investigation workflow for a specific assignment.
- The work pipeline combines assignment details, ingestion cache data, and AI tool calls.
- Output is written through `src/workspace/` into `.canvas-cli/sessions/<slug>/`.

### 4. Workspace question answering

- `src/ask/` loads workspace artifacts, retrieves supporting context, and produces grounded answers.
- The answer flow depends on previously generated local workspace files rather than live Canvas reads.

### 5. Interactive terminal UI

- `src/tui/` owns the interactive application, picker screens, workspace UI, and terminal input parsing.
- The TUI is the primary interface — all course browsing, assignment interaction, and AI features are accessed through it.

## Source Responsibility Map

| Area | Responsibility |
| --- | --- |
| `src/ai/` | AI provider setup, prompting, parsing, and shared AI types |
| `src/ask/` | Retrieval and answer generation for prepared workspaces |
| `src/canvas/` | Canvas API client and remote types |
| `src/commands/` | Setup CLI entrypoints (`login`, `logout`, `status`, `ingest`) and TUI-invoked flows (`model`) |
| `src/config/` | Environment loading and runtime configuration |
| `src/domain/` | Core models, matching, normalization, ranking, and resolution |
| `src/enrich/` | Deterministic enrichment from cached course artifacts |
| `src/extract/` | Text extraction utilities for downloaded documents |
| `src/format/` | Rendering helpers for console and markdown output |
| `src/ingest/` | Course ingestion, attachment selection, and storage |
| `src/tui/` | Interactive terminal application and input handling |
| `src/work/` | AI-assisted investigation and workup synthesis |
| `src/workspace/` | Workspace pathing, creation, and attachment helpers |

## Design Principles

- Keep setup command handlers thin and push reusable logic into domain modules.
- Prefer deterministic data preparation before AI synthesis.
- Treat `.canvas-cli/` as generated local state, not source-controlled content.
- Keep the TUI isolated from Canvas-specific logic where possible so workflows stay testable.
