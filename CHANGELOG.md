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
- Ingestion: folder-aware crawl of the whole Files tab (`GET /folders`), so lecture-like files anywhere in the course are indexed and downloaded under `attachments/files/<folder>/`, with a "Files-tab documents crawled" line in the summary
- Ingestion: threaded discussion replies captured in thread order with participant names (nested replies, paged `has_more_replies` lists), and reply counts in the summary
- Ingestion: files attached to announcements, discussion posts, and replies, and files attached directly to assignments (starter code, templates, data), are downloaded and extracted, deduped against the Files-tab crawl, with "files attached to posts" and "files attached to assignments" counts
- Ingestion: lecture recordings embedded in pages, the syllabus, announcements, discussions, and assignment descriptions (YouTube, Panopto, Kaltura, Echo360, Zoom, Loom, Google, Canvas Studio) become lecture entries with title, host, and lecture number
- Ingestion: quizzes (classic and New Quizzes, including practice quizzes and surveys) stored as "Quiz: <title>" pages with type, due/lock dates, time limit, attempts, points, question count, and instructions
- Ingestion: external tools from course navigation (Piazza, Ed, Zoom, Gradescope, recording platforms, ...) captured as a "Course tools and external links" page with purpose hints and launch links
- Ingestion: assignment groups (weights, drop rules, each assignment's share of the final grade) captured as a "Grading scheme: assignment groups and weights" page
- Ingestion: module prerequisites, unlock dates, sequential progress, and per-item completion requirements (must view/submit/contribute, minimum score) recorded in `modules.json` and rendered as a "Requirements:" line on each module
- Extraction: DOCX, PPTX, and XLSX text extraction with headings, lists, tables, links, alt text, speaker notes, and sheets
- Extraction: PDFs are extracted page by page under "## Page N" headings (cap raised from 30k to 400k characters, with a note naming the omitted page range); image-only pages keep their heading with an explicit "no extractable text" note so every page stays citable
- Extraction: assignment extracts state submission rules (attempts allowed, group assignment and grading mode, peer reviews, anonymous grading, omitted from final grade, lock reason) plus the assignment group, its weight and drop rules, and the assignment's approximate share of the final grade
- Extraction: page extracts carry "Updated:" and "Canvas URL:" lines, announcement extracts name their author and link, and announcement and discussion extracts list the files attached to the post and its replies
- Retrieval: lecture entries (slides, recordings, embedded videos) are indexed as a "lecture" artifact kind, so `search_course` finds "lecture 5 recording" and hands off to `open_lecture`
- Agent: `read_file` takes `section` ("Page 57", "57", "p. 12", or a heading fragment, with a raw-heading fallback when the splitter folded the section away) and `offset`; every read starts with the document's section outline, and the whole-read window is 120k characters (was 30k) with a cut-off note naming omitted sections
- Agent: `search_workspace` and `search_course` take a `limit` (1-20, default 8) so a thin first pass can be widened
- Agent: plan → investigate → reflect → decide loop with a visible 30-step budget and a per-result reflection footer that names the sections a cut-off read omitted
- Agent: the `/work` investigation's `read_document` takes a `section` too, so workups can reach pages past its 60k cut-off
- Grounding: section-level, answer-attributed citations for document reads and search hits ("Page 57", "## Grading")
- Grounding: numeric and date claims in an answer (dates in any spelling, times, percentages, addresses, and spelled-out figures such as "ten percent") are checked against the evidence read; an unconfirmed figure lowers confidence one level and adds a "could not confirm" note in chat and workspace answers
- Grounding: a weekday written next to a date is checked against the calendar ("Thursday March 27" is flagged when March 27 is a Friday)
- Grounding: not-found answers name what was checked ("Not found after checking: Lab4.pdf (read in full); course search for \"penalty\" (no matches)")
- Grounding: workups always report the document-stated due date and show a "Due-date conflict" line when it disagrees with Canvas

### Changed

- Model catalog refreshed for September 2026: Claude Fable 5.1, Fable 5, Opus 5, Sonnet 5, Opus 4.8 and Haiku 4.5; GPT-5.6 (Sol, Terra, Luna), GPT-6 Astra and GPT-5.5; Gemini 3.8 Flash, 3.7 Flash and 3.5 Flash Lite; and the matching Bedrock `us.` inference profiles. Defaults are now Claude Opus 5, GPT-5.6, Gemini 3.8 Flash, and Claude Sonnet 5 on Bedrock
- Effort is a five-step scale (`low`, `medium`, `high`, `xhigh`, `max`) that works on every provider, including Google: Claude 4.6 and later use adaptive thinking with the `effort` parameter (older Claude models keep an extended-thinking budget), OpenAI models get `reasoning.effort` including `xhigh` and `max`, Gemini models get a `thinking_level`, and Bedrock mirrors Claude. Pickers only offer the levels a model accepts, and an unsupported level rounds up to the nearest one the model has
- Model display names are derived from the id (so `us.anthropic.claude-opus-5` shows as "Opus 5" and `gpt-5.6-terra` as "GPT 5.6 Terra") instead of a lookup table; the Bedrock picker reads from the shared catalog
- `@ai-sdk/openai` bumped to 3.0.104 so `max` reasoning effort passes provider validation
- The TUI is the sole interactive interface. There are no non-interactive `courses`, `assignments`, `show`, `do`, `work`, `ask`, `grades`, or `submit` commands.
- Package published under the scoped name `@reyabsaluja/canvas-cli`; source maps and declarations are excluded from the tarball
- Retrieval: every search path strips query stop words, applies conservative stemming, and expands course vocabulary synonyms (due/deadline, rubric/grading/marking, late/penalty, submit/upload, exam/midterm, lecture/slides, ...) at a lower weight so direct matches still win
- Retrieval: `search_course` hits show the best-matching section and a query-centred passage instead of the document's opening characters, list up to two further matching sections of the same document ("also — Extensions: ..."), and rank a focused page above a long document that merely mentions every query word
- Retrieval: `search_workspace` previews are a 2,400-character window centred on the matching passage; workspace extracted files are split on their markdown headings ("## Page N", DOCX/PPTX headings) so pages are searchable and citable inside workspaces; sections split on up to four heading levels; default match count raised from 5 to 8
- Retrieval: announcements and discussion threads get a recency boost (up to 20% for a post from today, fading to nothing at 90 days; discussions use the last reply time) so the newest matching post ranks first
- Agent: cross-turn tool memory grew from 2.4k/220-character head slices to 12k/1.2k-character excerpts centred on the current question; each remembered read states the section it covered and, for cut-off reads, the sections not read and the call to fetch them
- Agent: the prompt teaches a figure check (every date, time, percentage, or value must come from a result read this turn), routes "how much is this worth", "where do I ask questions", and quiz-rule questions to the grading-scheme, course-tools, and quiz pages, and lists up to 60 lectures (was 30) and 8 lecture items per module (was 5)
- Agent: when a question names a page or heading that a cut-off read never included, the retrieval gate issues a section read instead of answering from truncated memory; the numeric-claim check also accepts figures grounded by earlier turns' reads
- Extraction: HTML tables keep colspan/rowspan, nested tables, captions, and row-header keys; `<dl>` lists render as "term: definition" lines; links with generic text ("here", "download") show the linked filename
- Extraction: zip summary caps raised from 30k to 120k characters per file and from 50k to 400k total, with an explicit "N more characters omitted" note instead of a silent cut
- Workspace answers are no longer capped at 2-4 sentences, and the prompt asks the agent to list the sources it checked in not-found answers
- Observation relevance stems question words and treats a match on a document heading as strong on its own, so a read that answers the question counts as grounded evidence across verification, memory reuse, and the retrieval gate
- Minimum supported Node.js is now 20.10 (`engines.node` is `>=20.10`), the first release with stable JSON import attributes

### Fixed

- Endpoints that are rate-limited or blocked for students (Files, Pages) are skipped with a warning instead of aborting ingestion
- Network failures from undici (`fetch failed` with an error cause) are classified as network errors with a useful hint
- Assignments with a null score are treated as ungraded in `/grade`
- Streamed output is preserved on Ctrl+C instead of wiping the conversation; rendering race between the spinner and the chat shell resolved
- pdf.js is fed a `Uint8Array` view, fixing "bad XRef entry" failures on some generated PDFs
- Files-tab file entries are deduped against their extracted attachment in search results
- A due date correctly remembered from an earlier turn is no longer flagged as unconfirmed
- A wrong due date is flagged even when its day number appears elsewhere in the evidence (dates are checked as month+day pairs in any common spelling)
- Questions already covered by the workup still get tool calls instead of an answer from memory alone
- Quizzes, external tools, and assignment groups degrade to none on a 403 instead of failing ingestion
- Ctrl+C during the external-link capture phase of ingestion now aborts in-flight requests and stops starting new ones, instead of letting each request run to its 30 s timeout

### Security

- File downloads send the Canvas token only to the configured Canvas origin (same-origin check)
- Agent-initiated downloads are confined to the workspace directory; filenames and path segments are sanitized against traversal
- Control characters are stripped from text before it reaches the terminal
- On macOS, a successful Keychain write no longer leaves a plaintext copy on disk; the file backend is used only when the Keychain is unavailable or `CANVAS_CLI_CREDENTIAL_BACKEND=file` is set
- When `CANVAS_BASE_URL` comes from the environment, `CANVAS_ACCESS_TOKEN` must too — a stored token is never sent to an environment-supplied URL
- Profile names are validated to prevent path traversal; plain-HTTP Canvas URLs are rejected; secrets are masked in debug output
- Zip inflation is bounded to stop archive bombs: 100 MB per entry (checked against the declared size and again while streaming), 5,000 entries and 1 GB inflated per archive, for zip summaries, on-demand unpacks (which now stream to a temp file and rename), and Office document containers. Oversized entries are still listed with their size and a "[Skipped ...]" note; everything else in the archive is read as before
- External-link capture reads at most 100 MB per response; a larger resource is recorded as `metadata_only` with a note naming the limit rather than being buffered in memory
- Subscription CLIs (Copilot, Codex) run isolated: non-interactive, in an empty temporary directory, with their built-in shell, file, and web tools removed and denied (Codex `--ephemeral --sandbox read-only --ignore-user-config`; Copilot with custom instructions and built-in MCP servers disabled). The Canvas tool bridge binds to 127.0.0.1 only and requires a per-run bearer token; `OPENAI_API_KEY` is stripped from the Codex environment so the subscription path never falls back to API billing

[Unreleased]: https://github.com/reyabsaluja/canvas-cli/commits/main
