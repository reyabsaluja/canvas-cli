# canvas-cli

`canvas-cli` is a TypeScript command-line interface for working with Canvas LMS from the terminal. It combines direct Canvas API access, local course ingestion, an interactive TUI, and optional AI-assisted assignment investigation.

## Highlights

- Browse Canvas courses and assignments without leaving the terminal
- Ingest course materials into a reusable local cache
- Generate assignment workspaces with summaries, plans, and extracted artifacts
- Ask grounded questions against an existing workspace
- Launch an interactive terminal UI by running the CLI with no subcommand

## Quick Start

```bash
npm install
cp .env.example .env
npm run build
npm start
```

Configure `.env` with:

- `CANVAS_BASE_URL`
- `CANVAS_ACCESS_TOKEN`
- One optional AI provider key for smart features: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_API_KEY`

## Commands

| Command | Purpose |
| --- | --- |
| `canvas-cli` | Launch the interactive TUI |
| `canvas-cli courses` | List courses |
| `canvas-cli assignments` | List assignments |
| `canvas-cli show assignment <name>` | Show detailed assignment information |
| `canvas-cli ingest <course>` | Cache course materials locally |
| `canvas-cli work <assignment>` | Build an AI-assisted assignment workspace |
| `canvas-cli ask <question>` | Ask a question about an existing workspace |

## Local State

Generated local state is stored under `.canvas-cli/` and ignored by git:

- `.canvas-cli/courses/`: ingested course data and attachments
- `.canvas-cli/sessions/`: assignment workspaces, extracted text, notes, and plans

## Development

```bash
npm run dev
npm run typecheck
npm run test
npm run build
npm run check
```

## Documentation

- [Documentation index](docs/README.md)
- [Architecture overview](docs/architecture.md)
- [Project structure](docs/project-structure.md)
- [Development guide](docs/development.md)
- [Contributing guide](CONTRIBUTING.md)

## Conventions

- `src/` is the source root and `dist/` is build output.
- Source folders are organized by responsibility rather than by command surface alone.
- New source files should use kebab-case names.
