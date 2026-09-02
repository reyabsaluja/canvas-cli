# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Initial release of `@reyabsaluja/canvas-cli`.

### Added

- Interactive TUI (`canvas-cli` with no arguments) with three scopes — global, course, and workspace — and a persistent chat session per scope under `.canvas-cli/chat-sessions/`
- AI chat agent with tools for reading cached course material, downloaded attachments, and zip archives on demand; streaming responses, Esc to interrupt, typing while streaming, and `@<resource>` pins to attach files to a prompt
- Assignment workspaces: automatic ingestion and AI investigation on first open, producing `assignment.md`, `plan.md`, `notes.md`, `workup.json`, and extracted text; `/overview`, `/requirements`, `/plan`, `/resources`, `/evidence`, `/status`, `/refresh`, and stale-workspace detection
- Setup commands: `login` (guided wizard with provider and model pickers), `logout`, `status`, `ingest <course> [--refresh] [--json]`, `clean [--all] [-y]`, and `examples`, plus global `--debug` and `-V/--version`
- Named profiles (`--profile`, `CANVAS_CLI_PROFILE`) for multiple Canvas accounts
- Credential storage in the macOS Keychain, with a permission-restricted file fallback under `~/.config/canvas-cli/credentials/` on other platforms (`XDG_CONFIG_HOME` respected)
- Course ingestion into `.canvas-cli/courses/`: modules, pages, files, assignments, syllabus detection, attachment download and text extraction, lecture discovery, and external-link capture, with progress indicators and graceful Ctrl+C/SIGTERM handling
- Pickers for `/courses`, `/recent`, `/assignments`, `/open`, and `/manage-courses`; `/files` and `/modules` views
- `/timeline` ASCII Gantt view of upcoming work (week, month, semester, next N days/weeks, `--all`)
- `/grade` with per-course summary, detail view, and a "need <letter>" calculator
- `/quiz` practice quizzes (count, difficulty, flashcard mode, topic) generated from course material
- `/announcements` scrollable card view and `/thread` discussion reader
- `/lecture` (alias `/lec`) lecture lookup with retrieval-augmented answers
- `/pdf` (alias `/make-pdf`) export of chat context to `.canvas-cli/exports/`, rendered with LaTeX via Tectonic when available (offers to install it)
- `/copy` (and Ctrl+Y) to copy the last response, the last N, or the whole transcript
- `/model` picker for switching provider and model at runtime, with `/model effort` and `/model key` subcommands and custom model IDs; friendly model names in the picker and header
- `/doctor` diagnostics for config, credentials, Canvas connectivity, and AI provider keys
- `/login` from inside the TUI, and a first-run login prompt
- Multi-provider AI via the Vercel AI SDK: Anthropic, OpenAI, Google Gemini, and AWS Bedrock (`AI_PROVIDER`, `AI_MODEL`, `AI_EFFORT`), with auto-detection from whichever API key is present and graceful degradation when no provider is configured
- `AI_PROVIDER=copilot`: use a GitHub Copilot subscription (including Copilot Free and the student Copilot Pro) through the GitHub Copilot CLI, with no API key; default model `auto`, custom model IDs, and `AI_EFFORT` mapped to the CLI's `--effort`
- `AI_PROVIDER=codex` (aliases `chatgpt`, `openai-codex`), **experimental**: use a ChatGPT plan through the OpenAI Codex CLI; default model `default` (your Codex config), custom model IDs, and `AI_EFFORT` mapped to `model_reasoning_effort`. OpenAI has not published terms that explicitly cover third-party tools on a ChatGPT plan; usage counts against the user's plan. Claude Pro/Max is intentionally not supported per Anthropic's Agent SDK terms
- Local MCP tool bridge (`src/ai/mcp-bridge.ts`) that exposes each request's Canvas tools to the vendor CLI over localhost, so subscription providers get the same tools as API-key providers; the `login` wizard, `/model`, `status`, and `/doctor` understand subscription providers (CLI installed / signed-in checks, offer to run `copilot login` or `codex login`). No new npm dependencies; subscription providers are never auto-detected
- Canvas API client with retries and exponential backoff, per-request timeouts, proactive rate-limit throttling (including `X-Request-Cost`), `Retry-After` parsing, and AbortSignal support
- Structured error types with user-facing messages and exit codes; Node.js version check at startup
- `--debug` diagnostic logging to stderr with automatic secret masking (also enabled by `DEBUG=canvas-cli`)
- CI workflow (typecheck, test, build, audit), npm publish workflow with provenance, `prepublishOnly` gate, and an end-to-end npx smoke test

### Changed

- The TUI is the sole interactive interface. There are no non-interactive `courses`, `assignments`, `show`, `do`, `work`, `ask`, `grades`, or `submit` commands.
- Package published under the scoped name `@reyabsaluja/canvas-cli`; source maps and declarations are excluded from the tarball

### Fixed

- Endpoints that are rate-limited or blocked for students (Files, Pages) are skipped with a warning instead of aborting ingestion
- Network failures from undici (`fetch failed` with an error cause) are classified as network errors with a useful hint
- Assignments with a null score are treated as ungraded in `/grade`
- Streamed output is preserved on Ctrl+C instead of wiping the conversation; rendering race between the spinner and the chat shell resolved

### Security

- File downloads send the Canvas token only to the configured Canvas origin (same-origin check)
- Agent-initiated downloads are confined to the workspace directory; filenames and path segments are sanitized against traversal
- Control characters are stripped from text before it reaches the terminal
- On macOS, a successful Keychain write no longer leaves a plaintext copy on disk; the file backend is used only when the Keychain is unavailable or `CANVAS_CLI_CREDENTIAL_BACKEND=file` is set
- When `CANVAS_BASE_URL` comes from the environment, `CANVAS_ACCESS_TOKEN` must too — a stored token is never sent to an environment-supplied URL
- Profile names are validated to prevent path traversal; plain-HTTP Canvas URLs are rejected; secrets are masked in debug output
- Subscription CLIs (Copilot, Codex) run isolated: non-interactive, in an empty temporary directory, with their built-in shell, file, and web tools removed and denied (Codex `--ephemeral --sandbox read-only --ignore-user-config`; Copilot with custom instructions and built-in MCP servers disabled). The Canvas tool bridge binds to 127.0.0.1 only and requires a per-run bearer token; `OPENAI_API_KEY` is stripped from the Codex environment so the subscription path never falls back to API billing

[Unreleased]: https://github.com/reyabsaluja/canvas-cli/commits/main
