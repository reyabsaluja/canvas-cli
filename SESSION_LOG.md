# canvas-cli Development Session Log

## Session Overview
- **Duration:** ~9 days (March 19–28, 2026)
- **Total Cost:** ~$210
- **Lines Changed:** ~14,000 added, ~2,200 removed
- **Models Used:** Claude Opus 4.6 (primary), Claude Haiku 4.5 (subagents)

---

## Phase 1: Foundation — CLI Commands

### 1.1 Course Ingestion Pipeline
**Request:** Implement `canvas-cli ingest <course>` — a non-AI course ingestion pipeline that fetches and caches course structure (modules, assignments, files, pages), identifies syllabus candidates via heuristics, and downloads targeted important attachments locally.

**Implementation:**
- Created `src/ingest/` module with types, slug generation, syllabus heuristics, attachment selection, download logic, and storage
- Added new Canvas API types for modules, module items, pages, files, course detail
- Added client methods: `getCourseDetail`, `getModules`, `getModuleItems`, `getFilesSafe`, `getPagesSafe`
- Downloads stored in `.canvas-cli/courses/<course-slug>/` with structured artifacts (course.json, assignments.json, modules.json, files.json, pages.json, syllabus-candidates.json, ingestion.json)
- Text extraction from syllabus body (HTML to text)
- Heuristic-based syllabus candidate identification and targeted attachment downloading

**Bug Fix:** Canvas API returned 404 for modules endpoint on some courses. Made all module/file/page fetching use safe methods that return empty arrays on 404/403/401 instead of crashing.

---

### 1.2 Deterministic Assignment Enrichment
**Request:** Build a reusable enrichment layer that merges live Canvas assignment data with local ingested course knowledge, producing richer normalized assignment objects.

**Implementation:**
- Created `src/enrich/` module with types, cache loader, matchers, scoring, and enrichment logic
- Title matching with 3 strategies: exact normalized match, containment, token overlap (≥50%)
- Weak description detection: blank, <30 chars, links-only, or generic submit patterns
- Submission shell detection: weak description + title matches "submit/upload/dropbox/grade"
- Confidence scoring: high/medium/low based on related resources and description strength
- Updated `assignments` and `show assignment` commands to use enrichment when cache exists

---

### 1.3 AI-Powered Assignment Overview
**Request:** Add a grounded "real assignment overview" section to `canvas-cli show assignment` using AI synthesis.

**Implementation:**
- Created `src/ai/` module with provider abstraction, context bundle builder, prompts, parser
- Single-shot retrieval + synthesis: assembles context from assignment + enrichment + cache, calls LLM once
- Structured output: overview, likely_tasks, primary_sources, next_steps, confidence, due_date
- `--smart` flag on `show assignment`
- Graceful fallback if no AI key configured

**Upgrade:** Added PDF text extraction (pdf-parse), always includes syllabus in context, increased text limits for comprehensive document reading.

---

### 1.4 Work Command — Deep Assignment Workspace
**Request:** Implement `canvas-cli work <assignment>` — a tool-using agent that investigates course materials and creates a rich local workspace.

**Implementation:**
- Created `src/work/` module with orchestrator, tools, tool handlers, synthesis, workspace builder, markdown generators
- Bounded tool-calling investigation loop (max 15 iterations) with tools: search_modules, get_module_items, read_document, download_module_file, get_syllabus, list_assignments, list_downloaded_files, search_files, complete_investigation
- Separate synthesis pass for structured AssignmentWorkup output
- Rich workspace creation: assignment.md, plan.md, notes.md, workup.json, extracted/, resources/, work/

---

### 1.5 Workspace Q&A — Ask Command
**Request:** Implement `canvas-cli ask "<question>"` for querying the current assignment workspace.

**Implementation:**
- Created `src/ask/` module with workspace resolution, loading, BM25 retrieval, answer generation
- Workspace auto-detection (most recently updated session)
- Content chunking from workup fields, markdown sections, extracted documents
- BM25-style keyword scoring with workup boost
- Structured answer: question, answer, bulletPoints, sources, confidence

---

## Phase 2: Ingestion & Agent Improvements

### 2.1 Ingestion Downloads All Module Files
**Request:** The agent found relevant PDFs in modules but could not read them because ingestion only downloaded files matching heuristic patterns. Module-linked instruction PDFs were never downloaded.

**Fix:**
- Ingestion now downloads ALL module-linked files (type "File" with contentId)
- Added `getFileSafe(fileId)` and `downloadFile(url)` to Canvas client
- New `selectModuleFiles()` function iterates every module item, fetches file metadata, downloads to `attachments/modules/`
- Added `download_module_file` tool to work agent for on-demand downloads

### 2.2 Workspace Output Polish
**Request:** Improve trust, usability, and actionability of generated workspace files.

**Implementation:**
- Evidence classification in assignment.md: confirmed vs inferred sources
- Required vs optional resource separation
- Structured plan.md with Goal/Resources/Output per step
- Scaffolded notes.md with pre-filled sections
- Source trace with provenance indicators

---

## Phase 3: Interactive TUI Rework

### 3.1 Interactive Terminal Application
**Request:** Rework canvas-cli from a command-first CLI into an interactive terminal application with workspace-first user flow.

**Implementation:**
- Built with Node.js builtins (readline, raw mode) + chalk — zero framework overhead
- State machine: HOME → COURSE_PICKER → ASSIGNMENT_PICKER → WORKSPACE
- Picker component with arrow key navigation, type-to-filter
- Workspace REPL with chat input and slash commands
- Service layer wrapping all existing backend logic
- Auto ingest-then-work flow when opening new assignments
- TUI-safe assignment resolution (no process.exit)

### 3.2 Splash Screen & Info Box Design
**Request:** Polished splash screen with centered ASCII "canvas" art, info box with school/courses/model info and commands list, course list directly below.

**Implementation:**
- Centered ASCII art with terminal width scaling
- Two-column info box with box-drawing characters
- Version label embedded in top border (`┌── v0.1.0 ──┐`)
- School URL extracted from CANVAS_BASE_URL
- Commands list on right side
- Course list with section headers on same page

### 3.3 Flicker-Free Rendering
**Request:** Every keystroke caused visible screen flashing during navigation.

**Fix:** Implemented `ScreenBuffer` class — collects all lines, writes everything in a single `process.stdout.write()` call with cursor-home positioning. Lines padded to terminal width to overwrite old content. Eliminated intermediate blank state between clears and redraws.

### 3.4 Course Configuration System
**Request:** Allow users to select, rename, and manage which courses appear in the app.

**Implementation:**
- First-run setup: multi-select picker with space-to-toggle, d-to-confirm
- Per-course renaming flow after selection
- Stored in `.canvas-cli/user-courses.json`
- Management menu: add, remove, rename courses
- Display names shown in UI, original codes used for slugs/cache

### 3.5 Small Terminal Handling
**Request:** Info box and ASCII art broke horribly on narrow terminals.

**Fix:**
- ASCII art replaced with simple text header when terminal < 60 chars
- Info box collapses to single-line summary when < 40 chars
- Line truncation with ANSI-aware width calculation
- Comprehensive ANSI stripping regex

---

## Phase 4: Chatbot-Style Workspace Interface

### 4.1 Chat Message Rendering
**Request:** Make the workspace look like a chatbot interface with message bubbles, tool call displays, and input box styling.

**Implementation:**
- User messages in highlighted background boxes (`#2a2e3f`)
- Tool call blocks in green-tinted (`#1a2e1a`) or red-tinted (`#2e1a1a`) background
- Tool action in bold yellow/tan, target in green
- Content preview (max 8 lines) with "... (N more lines, ctrl+o to expand)"
- Input box with dark background (`#1e2030`) and cursor indicator
- Vertical padding on all boxes

### 4.2 Slash Command Autocomplete
**Request:** Typing `/` should show a navigable command popup.

**Implementation:**
- Popup appears inline when `/` typed at start of input
- Arrow keys navigate, Tab autocompletes, Enter selects
- Commands: /overview, /requirements, /plan, /resources, /evidence, /status, /refresh, /help, /back, /courses, /quit

### 4.3 Working Indicator Animation
**Request:** Show live animated indicator during AI processing, similar to Claude Code.

**Implementation:**
- Braille spinner animation (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) at 80ms per frame
- Random verb per prompt: Working, Thinking, Studying, Reading, Analyzing, Exploring, Reviewing
- Independent `setInterval` timer for continuous animation
- Direct cursor positioning for flicker-free updates
- Spinner stops when streaming text begins

### 4.4 Tool Call Display
**Request:** Show tool calls as background boxes (like Claude Code) with actual content preview.

**Implementation:**
- Each tool call renders as a colored background block
- Header: bold yellow action + green target (e.g., `read lab4.pdf`)
- Content: first 8 lines of tool result in white text
- Overflow: `... (N more lines, ctrl+o to expand)` with ctrl+o in darker gray
- Ctrl+O toggles "detailed transcript" view showing all content

### 4.5 Typing Performance
**Request:** Typing lagged because every keystroke triggered a full screen render.

**Fix:** `renderInputOnly()` fast path — only rewrites the 3 input box lines using direct cursor positioning. Full render only on Enter, slash menu open/close. Slash menu navigation also uses full render since it needs layout coordination.

---

## Phase 5: Chat Agent Architecture

### 5.1 Real Tool-Calling Chat Agent
**Request:** The workspace chat used a simple "retrieve chunks + single LLM call" pipeline with fake steps. Need a real tool-calling agent.

**Implementation:**
- Created `src/tui/chat-agent.ts` with Anthropic tool-use loop
- 5 tools: search_workspace, read_file, list_files, search_course, download_course_file
- Pre-loaded workup context in system prompt for fast simple answers
- Tools only used for deeper investigation
- Max 10 tool-calling iterations

### 5.2 Ingestion Downloads Assignment Description Files
**Request:** Files linked in assignment descriptions (with verifier tokens) were not being downloaded during ingestion.

**Fix:** New `selectDescriptionLinkedFiles()` scans ALL assignment descriptions for Canvas file links and downloads them to `attachments/assignments/`.

### 5.3 Shared Text Extraction Utility
**Request:** PDF and zip extraction code was duplicated across 3 modules.

**Fix:** Created `src/extract/extract-text.ts` — single shared utility handling PDF, text, HTML, ZIP (with content extraction from files inside zips including nested PDFs). Removed duplicates from context-bundle, work tool-handlers, and chat-agent.

### 5.4 Workspace Refresh Command
**Request:** Add `/refresh` to re-ingest course data and rebuild workspace.

**Implementation:**
- `/refresh` command in workspace slash menu
- Calls `refreshWorkspace()` which force re-ingests (refresh: true) + re-runs work agent
- Both workspace entry functions handle refresh loop
- Progress events stream to UI during refresh

---

## Phase 6: Vercel AI SDK Migration

### 6.1 Multi-Provider Support
**Request:** Replace direct Anthropic SDK with Vercel AI SDK for provider flexibility.

**Implementation:**
- Installed `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`
- Removed `@anthropic-ai/sdk`
- Auto-detection: ANTHROPIC_API_KEY → OPENAI_API_KEY → GOOGLE_API_KEY
- Model override via AI_MODEL env var
- `tool()` + `jsonSchema()` + `inputSchema` for tool definitions

**Bug Fixes:**
- `parameters` → `inputSchema` (AI SDK v6 naming)
- `maxSteps` → `stopWhen: stepCountIs(N)` (deprecated in v5+)
- Tool result message format for multi-turn conversations

### 6.2 Conversation Context Persistence
**Request:** Chat context was lost between messages — each message created a fresh context.

**Fix:** Added `conversationHistory` array to `ChatAgentContext`, maintained across calls. User messages and assistant responses accumulate so the model has full conversation context.

### 6.3 Streaming Text Output
**Request:** Implement token-by-token streaming for the final answer using `streamText`.

**Implementation:**
- New `streamWithTools()` function using AI SDK's `streamText`
- `fullStream` iteration detects `text-delta` parts
- `onTextDelta` callback fires for each text chunk
- Throttled buffer-based rendering (80ms intervals)
- Model's "thinking" text between tool calls shown as system messages
- Spinner stops when streaming starts

---

## Phase 7: Content Access & Quality

### 7.1 ZIP File Content Access
**Request:** Lab instructions inside zip files were inaccessible — the agent kept trying to read "lab4.pdf" but only found the zip listing.

**Fix:**
- Zip-aware file matching: requesting "lab4.pdf" finds "lab4.zip" in course cache
- Fresh extraction from the actual zip on disk (not truncated workspace extract)
- Section extraction: returns just the PDF portion from inside the zip
- Increased limits: per-file 30K chars, total zip 50K chars

### 7.2 Course Front Page & Individual Pages
**Request:** Important course content (lecture links, instructor info) lived on the Canvas home page and individual pages accessible by slug.

**Implementation:**
- `getFrontPageSafe()` fetches course home page body
- `getPageBySlugSafe()` fetches individual pages by URL slug
- Both stored during ingestion as extracted text
- Workspace loader reads from `extracted/pages/` subdirectory

### 7.3 Markdown Rendering
**Request:** AI output looked ugly — headings, bullet points, code, and dividers not rendered properly.

**Implementation:**
- Proper heading rendering (`###` → bold primary blue)
- Horizontal rules (`---`) → dim line dividers
- Nested bullet points with `◦` for sub-items
- Inline code in accent color
- Bold and italic support
- `applyInlineFormatting()` handles all inline markdown

---

## Phase 8: UX Polish

### 8.1 Workspace Management
**Request:** Duplicate workspaces from refresh, no way to manage/delete workspaces.

**Fix:**
- Root cause: display name vs original code mismatch in slug generation
- `getDisplayCourses` now uses original code for `courseCode` (slugs) and display name for `name` (UI)
- Home screen shows max 3 recent workspaces
- "See all workspaces" option with full picker
- Workspace deletion via "Manage workspaces" menu

### 8.2 Input Cursor
**Request:** No visible cursor in the input box.

**Fix:** Added `│` cursor character (dim color) after text in input box, in both buffer render and fast-path render.

### 8.3 Ctrl+O Detailed Transcript
**Request:** Ctrl+O should show a detailed transcript view, not just expand in place.

**Implementation:**
- Toggle between normal view and "detailed transcript" view
- Transcript shows ALL messages with ALL tool output expanded
- Footer: `Showing detailed transcript · ctrl+o to toggle`
- Uses `clearScreen()` + `console.log()` for natural scrolling

### 8.4 Inline File Pinning (`/pin`)
**Request:** Allow attaching files as context inline in messages, like `/pin lab4`.

**Implementation:**
- Type `/pin` anywhere in a message to trigger file picker dropdown
- Arrow keys navigate, Enter auto-completes the file label
- `/pin lab4_zip` renders in accent color in the input box
- Multiple pins supported: `explain differences /pin lab4_zip /pin rubric`
- On send: file content prepended to question, `/pin` parts stripped from visible text
- Available files: workspace extracts, course cache attachments, workspace markdown files

---

## Architecture Summary

```
src/
├── cli.ts                    — Entry point (TUI default + CLI subcommands)
├── tui/                      — Interactive terminal UI
│   ├── app.ts               — State machine + splash + home screen
│   ├── picker.ts            — Arrow-key list picker
│   ├── workspace-ui.ts      — Chat interface + slash commands
│   ├── chat-agent.ts        — Tool-calling chat agent
│   ├── activity.ts          — Animated working indicator
│   ├── services.ts          — Service layer wrapping backend
│   ├── course-config.ts     — User course preferences
│   ├── course-setup.ts      — Course selection/rename flow
│   └── screen.ts            — Screen buffer + ANSI utilities
├── ai/                       — AI provider abstraction (Vercel AI SDK)
│   ├── provider.ts          — Multi-provider support + tool calling + streaming
│   ├── context-bundle.ts    — Context assembly for AI
│   ├── generate-overview.ts — Assignment overview generation
│   ├── prompts.ts           — System/user prompts
│   ├── parse.ts             — Response parsing
│   └── types.ts             — AI types
├── work/                     — Work agent pipeline
│   ├── orchestrator.ts      — Investigation loop
│   ├── tools.ts             — Tool definitions
│   ├── tool-handlers.ts     — Tool execution
│   ├── synthesis.ts         — Final synthesis
│   ├── workspace.ts         — Workspace creation
│   ├── generate-markdown.ts — Markdown generators
│   └── types.ts             — Work types
├── ingest/                   — Course ingestion pipeline
│   ├── ingest-course.ts     — Main pipeline
│   ├── fetch-course-content.ts
│   ├── normalize-content.ts
│   ├── attachment-selection.ts
│   ├── attachment-download.ts
│   ├── syllabus-heuristics.ts
│   ├── storage.ts
│   ├── slug.ts
│   └── types.ts
├── extract/                  — Shared text extraction
│   └── extract-text.ts      — PDF, ZIP, HTML, text extraction
├── enrich/                   — Deterministic enrichment
├── ask/                      — Workspace Q&A
├── canvas/                   — Canvas API client
├── domain/                   — Domain models + normalization
├── workspace/                — Workspace paths + sessions
├── format/                   — Terminal formatting
├── commands/                 — Non-interactive CLI commands
└── config/                   — Environment configuration
```

## Key Technical Decisions

1. **No TUI framework** — Built with readline + raw mode + chalk. Zero dependencies, full control, fits existing codebase.
2. **Screen buffer pattern** — All rendering goes through a buffer that writes everything in one `stdout.write()` call, eliminating flicker.
3. **Vercel AI SDK** — Provider-agnostic AI integration supporting Anthropic, OpenAI, and Google with the same code.
4. **Streaming + tool calling** — Uses `streamText` with `stopWhen` for token-by-token output while tools execute synchronously.
5. **Shared extraction** — Single `extractFileText()` utility handles PDF, ZIP (with nested file extraction), HTML, text, and code files.
6. **Conversation persistence** — Chat history maintained across messages within a workspace session for multi-turn context.
7. **Ingestion-first architecture** — Course data ingested once (deterministic, no AI), then used by both the work agent and chat agent.
