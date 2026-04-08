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

<<<<<<< HEAD
1. **Start in global chat** — open directly into a persistent home session
2. **Move between scopes** — global, course, and workspace all use the same shell
3. **Open pickers from commands** — `/courses`, `/recent`, `/assignments`, `/open`
4. **Ask questions naturally** — global handles broad questions, course scope handles course context, workspace scope keeps the rich assignment chat
5. **Use scope-aware slash commands** — `/help` changes with the current scope

### Scope model

canvas-cli has three explicit scopes, and the header always shows which one you are in:

- **Global** — cross-course questions, recent sessions, and navigation
- **Course** — one course at a time, with course files/modules/assignments
- **Workspace** — one assignment workspace with the full assignment-specific command set

If you run a command in the wrong scope, canvas-cli returns a helpful scoped error instead of failing silently.

### Persistent sessions

The interactive TUI uses persistent chat sessions stored under `.canvas-cli/chat-sessions/`.

- Global scope reuses one persistent home session
- Each course gets its own persistent course session
- Each workspace gets its own persistent workspace session

Reopening a course or workspace restores the prior thread instead of starting from scratch.
=======
- [Documentation index](docs/README.md)
- [Architecture overview](docs/architecture.md)
- [Project structure](docs/project-structure.md)
- [Development guide](docs/development.md)
- [Contributing guide](CONTRIBUTING.md)
>>>>>>> main

## Conventions

<<<<<<< HEAD
```
$ canvas-cli

  [canvas ascii header]
  [home box]

  Academic control center ready.

  Use /courses to open a course, /recent to reopen work,
  or ask a broad question across your courses.

  > what's due soon across my courses?
```

Move into a course, then open a workspace without leaving the chat shell:

```
  > /courses
  [course picker opens]

  > /assignments
  [assignment picker opens]

  Workspace: ECE212 2026 Home Page / Lab4
  > what exactly do I need to submit?
```

Course scope appears immediately, then hydrates assignments and cached course material in the background. If course data is still loading, the status line reflects that and deeper answers become available as soon as hydration finishes.

Type questions directly:

```
  > what exactly do I need to submit?

  Based on the lab instructions, you need to submit pre-lab simulation
  waveforms, experimental measurements for all three damping conditions,
  labeled oscilloscope captures, and a comparison analysis table.

  • Pre-lab PSpice simulation results
  • Experimental voltage measurements
  • Oscilloscope waveform captures
  • Comparison table: simulation vs experimental

  [extracted] Lab4_Second-order-Circuits.pdf.txt
  confidence: high

  > /plan

  Action Plan

  1. Complete pre-lab PSpice simulations
     Run simulations for underdamped, critically damped, overdamped
  2. Calculate component values
     Determine R for each damping condition using formulas
  3. Perform in-lab measurements
     Build circuits and capture oscilloscope waveforms
  ...
```

### Slash commands

Global scope:

| Command | Description |
|---|---|
| `/courses` | Open the course picker |
| `/manage-courses` | Add, remove, or rename configured courses |
| `/recent` | Reopen a recent course or workspace |
| `/open` | Jump straight to a course or recent item |
| `/clear` | Clear the current chat and reset context |
| `/home` | Stay in the global home session |
| `/help` | Show available commands |
| `/quit` | Exit canvas-cli |

Course scope:

| Command | Description |
|---|---|
| `/assignments` | Open the assignment picker for the current course |
| `/files` | Show cached files and downloads for the course |
| `/modules` | Show course modules |
| `/manage-courses` | Add, remove, or rename configured courses |
| `/open` | Open an assignment or cached course resource |
| `/clear` | Clear the current chat and reset context |
| `/back` | Return to global scope |
| `/home` | Return to global scope |
| `/help` | Show course-scope commands |
| `/quit` | Exit canvas-cli |

Workspace scope:

| Command | Description |
|---|---|
| `/overview` | Show assignment overview |
| `/requirements` | Show deliverables and constraints |
| `/plan` | Show the action plan |
| `/resources` | Show key resources |
| `/evidence` | Show confirmed vs inferred sources |
| `/status` | Show workspace status |
| `/open` | Open a workspace or course resource by name |
| `/pin` | Attach a workspace file or cached attachment to your next prompt |
| `/clear` | Clear the current chat and reset context |
| `/refresh` | Refresh the workspace from the latest course cache |
| `/manage-courses` | Add, remove, or rename configured courses |
| `/back` | Return to the course session |
| `/home` | Return to the global home session |
| `/help` | Show workspace commands |
| `/quit` | Exit canvas-cli |

In course and workspace scope, `/open` shows a resource picker, and the assistant can also handle requests like `open lab 4 pdf` by calling the same opener tool.

### Automatic workspace preparation

When you open an assignment for the first time, canvas-cli automatically:
1. Checks for an existing workspace
2. Runs course ingestion if needed (downloads modules, PDFs, syllabus)
3. Runs the AI work agent (reads documents, synthesizes understanding)
4. Creates the workspace with assignment.md, plan.md, workup.json, etc.

You see the progress live before the workspace session opens:
```
  › resolving assignment
  › checking course cache
  › ingesting course data
  › investigating assignment
  › list_downloaded_files
  › read_document (Lab4_Second-order-Circuits.pdf)
  › get_syllabus
  › synthesizing assignment workup
  › creating workspace
  › workspace ready
```

On subsequent opens, the workspace loads instantly.

If the workspace is still valid but the underlying course cache is newer, it opens immediately in a **stale** state and recommends `/refresh` instead of forcing a rebuild up front.

### Recent sessions and reopening work

`/recent` searches the full saved session set, not just the newest few items. The picker windows large lists so you can still filter older course/workspace sessions without dumping every row to the terminal at once.

### Local workspace files

The TUI is the primary interface, but all data is persisted as local files under `.canvas-cli/sessions/<slug>/`. Power users can inspect these directly:

| File | Purpose |
|---|---|
| `assignment.md` | Rich assignment brief |
| `plan.md` | Action plan with steps |
| `notes.md` | Your scratch notes (never overwritten) |
| `workup.json` | Structured AI analysis |
| `extracted/` | Text extracted from PDFs |
| `work/` | Your files |

## Non-Interactive Commands

All original CLI commands remain available for scripting and power use:

### `canvas-cli courses`

List your current courses.

```bash
canvas-cli courses            # current/active courses only
canvas-cli courses --all      # include past/inactive courses
canvas-cli courses --json     # JSON output
```

Example output:

```
  ECE297  Algorithms and Data Structures  (Winter 2026)
  ECE216  Signals and Systems  (Winter 2026)
  ECE221  Electric and Magnetic Fields  (Winter 2026)
  ECE243  Computer Organization  (Winter 2026)
  ECE212  Circuit Analysis  (Winter 2026)
```

### `canvas-cli assignments`

List upcoming assignments across your current courses.

```bash
canvas-cli assignments                          # upcoming work across all current courses
canvas-cli assignments --course ece297          # assignments for a specific course
canvas-cli assignments --all                    # everything, including old/submitted
canvas-cli assignments --include-submitted      # also show submitted work
canvas-cli assignments --include-no-due-date    # also show items with no due date
canvas-cli assignments --json                   # JSON output
```

Example output:

```
ECE297
  - Milestone 3 — Mar 22, 11:59 PM — due in 5d
  - Milestone 2 — Mar 15, 11:59 PM — overdue

ECE243
  - Project Week 1 Grade — Mar 21, 11:59 PM — due in 4d

ECE221
  - Lab5 Quiz — Apr 1, 11:59 PM — due in 15d
```

Course-scoped view (with ingestion cache available):

```bash
canvas-cli assignments --course ece297
```

```
  - Milestone 3 — Mar 22, 11:59 PM — due in 5d
    context: high  sources: module_item, attachment
  - Milestone 2 — Mar 15, 11:59 PM — overdue
  - OP2: Submit Final Slides — Apr 29, 8:30 AM — not submitted
    ! likely submission shell
    context: low  (no related resources found)
```

Enrichment lines only appear when a course has been ingested. Without ingestion, output is unchanged.

### `canvas-cli show assignment <name>`

Show detailed information for a single assignment.

```bash
canvas-cli show assignment "Milestone 3" --course ece297   # scoped to a course
canvas-cli show assignment "Lab5 Quiz"                      # search across all current courses
canvas-cli show assignment _ --id 1710240 --course ece297   # look up by Canvas ID
canvas-cli show assignment "Milestone 3" --json             # JSON output
canvas-cli show assignment "Milestone 3" --course ece297 --smart   # include AI overview
```

Example output:

```
Milestone 3: Shortest Path Algorithms and User Interface

  Course      ECE297H1 S LEC0101 20261:Software Design and Communication
  ID          1710240
  Due         Sun, Mar 22, 11:59 PM
  Status      not submitted
  Points      15
  Grading     points
  Submit via  none
  URL         https://q.utoronto.ca/courses/420471/assignments/1710240

Description

  • M3_Instructions (https://...)
  • M3_Grading_Rubric (https://...)
```

The detail view includes: due/unlock/lock dates, points, grading type, submission types, submission status (with grade if available), description (HTML converted to readable text), and attachments if present.

**Assignment matching** is case-insensitive and supports partial names. If multiple assignments match, you'll see a disambiguation list. If none match, you'll get a hint to use `canvas-cli assignments` to browse.

#### `--smart` — AI-powered real overview

When you add `--smart`, the command generates an AI-powered "Real overview" section that synthesizes what the assignment is likely asking based on all available context.

```bash
canvas-cli show assignment "Milestone 3" --course ece297 --smart
```

Example output (appended after the standard detail view):

```
Real overview

  Milestone 3 requires implementing shortest path algorithms (Dijkstra's and
  A*) and integrating them into the mapping application's UI. Students must
  provide a functional pathfinding feature with visual route display.

  Due date (from syllabus): March 22, 2026, 11:59 PM

Tasks
  - Implement Dijkstra's algorithm for shortest path computation
  - Implement A* search with a suitable heuristic
  - Integrate pathfinding into the map UI with route visualization
  - Write tests demonstrating correctness on provided test cases
  - Submit via the Canvas assignment page

Sources
  - M3_Instructions.pdf
  - M3_Grading_Rubric.pdf
  - Course syllabus (schedule section)

Next steps
  - Review the grading rubric for specific weight breakdowns

  Confidence: high
```

**Requirements:**
- Set `ANTHROPIC_API_KEY` in your `.env` file
- Best results when the course has been ingested first (`canvas-cli ingest <course>`)

**How it works:** The AI reads the actual course materials — including PDF instruction documents, the course syllabus, the module structure, and the full assignment list. It synthesizes a concrete summary of what the assignment requires. When the Canvas due date is missing, it cross-references the syllabus and schedule to find it.

**Fallback behavior:**
- Without `ANTHROPIC_API_KEY`: the `--smart` flag shows a subtle note that AI is unavailable; the rest of the command works normally
- Without ingestion cache: AI still works but has less context; confidence will be lower
- If the AI call fails: the deterministic output is still shown, with a failure note

### `canvas-cli do <assignment>`

Create a local workspace for an assignment.

```bash
canvas-cli do "Milestone 3" --course ece297    # create workspace for a specific assignment
canvas-cli do "Lab5 Quiz"                       # resolves across all current courses
canvas-cli do "Milestone 3" --course ece297    # safe to run again — updates data, preserves your files
```

Example output:

```
Workspace ready

  Assignment  Milestone 3: Shortest Path Algorithms and User Interface
  Course      ECE297H1 S LEC0101 20261:Software Design and Communication
  Path        .canvas-cli/sessions/ece297h1-s-lec0101-milestone-3-...-1710240

Created:
  - assignment.json
  - assignment.md
  - session.json
  - notes.md
  - work/

Next:
  - open .canvas-cli/sessions/.../assignment.md to review the brief
  - use .canvas-cli/sessions/.../notes.md for scratch notes
  - use .canvas-cli/sessions/.../work/ for your files
```

**Workspace location:** `.canvas-cli/sessions/<slug>/` in the current directory. The slug is deterministic (based on course code, assignment name, and Canvas ID), so running `do` again for the same assignment reuses the same workspace.

**Workspace contents:**

| File | Purpose | On re-run |
|---|---|---|
| `assignment.json` | Normalized assignment detail data | Refreshed |
| `assignment.md` | Human-readable assignment brief | Refreshed |
| `session.json` | Workspace metadata (timestamps, IDs) | Updated (preserves `createdAt`) |
| `notes.md` | Your scratch notes | Preserved — never overwritten |
| `work/` | Directory for your files | Preserved |

**Repeated invocation** is safe: data files are refreshed with latest Canvas info, but `notes.md` and anything in `work/` are never touched.

### `canvas-cli work <assignment>`

The deep assignment setup command. Uses a tool-calling AI agent to investigate the assignment through course materials, then creates a rich local workspace.

```bash
canvas-cli work "Milestone 3" --course ece297
canvas-cli work "Lab5 Quiz"
canvas-cli work "Project" --id 1710240
```

**Prerequisites:**
- `ANTHROPIC_API_KEY` set in `.env`
- Course ingested first: `canvas-cli ingest <course>`

**What happens:**
1. Resolves the assignment from Canvas
2. Loads the ingested course cache
3. Runs a bounded investigation agent that:
   - Searches modules for related content
   - Reads downloaded PDFs and instruction documents
   - Checks the syllabus for schedule/due date info
   - Cross-references the full assignment list
4. Synthesizes a structured workup
5. Creates a rich workspace

Example output:

```
  > resolving assignment
  > found: Milestone 3: Shortest Path Algorithms and User Interface
  > loading course cache
  > enriching assignment context
  > starting investigation agent
  > investigating course materials
  > reading: list_downloaded_files
  > reading: read_document (M3_Instructions.pdf)
  > reading: read_document (M3_Grading_Rubric.pdf)
  > reading: get_syllabus
  > reading: search_modules (Milestone 3)
  > synthesizing assignment workup
  > creating workspace

Workspace ready

  Assignment  Milestone 3: Shortest Path Algorithms and User Interface
  Course      ECE297H1 S LEC0101 20261:Software Design and Communication
  Path        .canvas-cli/sessions/ece297h1-s-lec0101-milestone-3-1710240
  Confidence  high

Generated:
  - session.json
  - assignment.json
  - workup.json
  - assignment.md
  - plan.md
  - notes.md
  - extracted/ (3 documents)

Next steps:
  1. Read M3_Instructions.pdf for detailed requirements
  2. Review the grading rubric for evaluation criteria
  3. Start implementing shortest path algorithms
```

**Workspace contents:**

| File/Dir | Purpose | On re-run |
|---|---|---|
| `assignment.md` | Rich brief with overview, deliverables, constraints, reading order | Refreshed |
| `plan.md` | Practical action plan with checklist | Refreshed |
| `workup.json` | Structured agent result (machine-readable) | Refreshed |
| `assignment.json` | Raw Canvas assignment data | Refreshed |
| `session.json` | Workspace metadata | Updated |
| `notes.md` | Your scratch notes | Preserved |
| `work/` | Your files | Preserved |
| `resources/` | Links to relevant course documents | Refreshed |
| `extracted/` | Extracted text from PDFs and documents | Refreshed |

**How the agent works:**
The investigation agent uses Anthropic tool calling with a bounded loop (max 10 iterations). It has tools to search modules, read downloaded PDFs, check the syllabus, and browse files. It decides what to investigate based on the assignment context and enrichment data. After investigation, a separate synthesis pass produces the structured workup.

**The agent does NOT:**
- Make new Canvas API calls (works from ingested cache)
- Solve the assignment or write code
- Run indefinitely (bounded iteration limit)
- Download files not already ingested

### `canvas-cli ask "<question>"`

Ask a question about the current assignment workspace. Answers are grounded in local workspace artifacts — no re-crawling or new agent runs.

```bash
canvas-cli ask "what exactly do I need to submit?"
canvas-cli ask "what should I read first?"
canvas-cli ask "what formulas matter here?"
canvas-cli ask "what is inferred vs confirmed?"
canvas-cli ask "what are the constraints?" --json
canvas-cli ask "what's the due date?" --workspace .canvas-cli/sessions/ece212-lab4-1645539
canvas-cli ask "what should I focus on?" --debug
```

**Prerequisites:**
- `ANTHROPIC_API_KEY` set in `.env`
- A workspace created by `canvas-cli work <assignment>`

Example output:

```
Question
  what exactly do I need to submit?

Answer
  Based on the lab instructions, you need to submit pre-lab simulation results,
  experimental measurements for three damping conditions, labeled waveform
  documentation, and a comparison analysis between simulation and experimental
  results.

Key points
  - Pre-lab PSpice simulation waveforms
  - Experimental measurements for underdamped, critically damped, overdamped
  - Labeled oscilloscope captures
  - Comparison table: simulation vs experimental

Sources
  - workup.json [workup] — "Deliverables"
  - extracted/Lab4_Second-order-Circuits.pdf.txt [extracted]

  Confidence: high
```

**Workspace detection:** The command automatically finds the most recently updated workspace in `.canvas-cli/sessions/`. Use `--workspace <path>` to target a specific one.

**Retrieval:** Uses BM25 keyword scoring to select the most relevant workspace sections for the question. Workup fields (deliverables, constraints, plan) are treated as high-signal sources. Extracted document text is chunked and scored. Only the top-8 most relevant chunks are sent to the model.

**When no workspace exists:** Shows a helpful error listing available workspaces if any, or suggests running `canvas-cli work` first.

**When retrieval is weak:** The model answers with low confidence and explicitly states what it couldn't find.

### `canvas-cli ingest <course>`

Ingest course structure and content into a local cache for future commands.

```bash
canvas-cli ingest ece297                              # ingest by course code
canvas-cli ingest "Software Design and Communication" # ingest by course name
canvas-cli ingest ece297 --refresh                    # force re-ingestion
canvas-cli ingest ece297 --json                       # machine-readable summary
```

Example output:

```
Course ingested

  Course  ECE297H1 S LEC0101 20261:Software Design and Communication
  Code    ECE297H1 S LEC0101
  Term    Winter 2026
  Path    .canvas-cli/courses/ece297h1-s-lec0101-420471

Fetched:
  - 9 assignments
  - 11 modules
  - 42 module items
  - files (API not accessible)
  - pages (API not accessible)

Likely syllabus sources:
  1. ECE297 Course Outline.pdf [file] high
  2. Course Outline (in Week 1) [module_item] medium

Attachments:
  - ECE297 Course Outline.pdf downloaded (title contains 'course outline')

Next:
  - future commands will use this local course cache
  - this ingestion does not yet infer true assignments
```

**Storage location:** `.canvas-cli/courses/<course-slug>/` in the current directory. The slug is deterministic (based on course code and Canvas course ID).

**What gets stored:**

| File | Contents |
|---|---|
| `course.json` | Normalized course metadata (name, code, term, dates, syllabus body) |
| `assignments.json` | All assignment objects for the course |
| `modules.json` | Module structure with all module items, preserving order |
| `files.json` | Course file index (empty if Files API is blocked) |
| `pages.json` | Course page index (empty if Pages API is blocked) |
| `syllabus-candidates.json` | Ranked list of likely syllabus sources with reasons |
| `attachments.json` | Metadata for all downloaded/skipped/failed attachments |
| `ingestion.json` | Ingestion run metadata (timestamps, counts, version) |
| `extracted/syllabus-body.txt` | Plain text extracted from course syllabus body (if present) |
| `extracted/syllabus-body.html` | Raw HTML of course syllabus body (if present) |
| `attachments/syllabus/` | Downloaded syllabus/outline PDFs and docs |
| `attachments/important/` | Downloaded important course documents |

**Syllabus candidate heuristics:** The tool identifies likely syllabus sources by matching titles/filenames against keywords like "syllabus", "course outline", "schedule", "calendar", "grading scheme". Each candidate is ranked by confidence (high/medium/low) and source type.

**Attachment selection:** Only a targeted subset of files is downloaded — not the entire course. The tool downloads:
- High/medium confidence syllabus candidate files
- Files matching importance heuristics (rubric, instructions, handbook, grading, guidelines)
- Capped at a reasonable limit to avoid excessive downloads

**What this feature does NOT do:**
- No AI or LLM integration
- No assignment inference or "true assignment" reconstruction
- No PDF parsing (PDFs are downloaded and indexed but not read)
- No semantic interpretation of content

**Repeated invocation** refreshes all data and re-downloads missing attachments. Use `--refresh` to force a complete re-ingestion.

**Note:** Some institutions block the Files API and/or Pages API for students. When this happens, the file and page indexes will be empty, and attachment selection will be limited. Module items and assignment descriptions remain accessible.

### Ingestion-aware enrichment

When a course has been ingested with `canvas-cli ingest`, both `assignments` and `show assignment` automatically become enrichment-aware. The enrichment layer merges live Canvas data with the local course cache to surface additional context.

**How it works:** For each assignment, the enrichment layer:
1. Searches the course cache for related module items, pages, files, and downloaded attachments by matching titles
2. Detects weak/missing Canvas descriptions
3. Identifies likely submission-shell assignments
4. Computes a context confidence score
5. Ranks likely instruction sources

**What appears in the output:**

For `assignments`:
```
ECE297
  - Milestone 3 — Mar 22, 11:59 PM — due in 5d
    context: high  sources: attachment, module_item
  - OP2: Submit Final Presentation Slides — Apr 29, 8:30 AM — not submitted
    ! likely submission shell
    context: low  (no related resources found)
```

For `show assignment`:
```
Context
  Confidence            high
  Weak description      yes

Likely instruction sources
  - M3_Instructions.pdf [attachment] (attachments/important/M3_Instructions.pdf)
  - Milestone 3 Instructions (File in Week 8) [module_item]

Warnings
  ! Canvas description appears incomplete or missing
  ! This may be a submission-only endpoint; instructions likely live elsewhere
```

**Key concepts:**

- **Likely submission shell**: An assignment that appears to be a submission-only endpoint. Detected when the Canvas description is weak/blank and the title contains patterns like "submit", "upload", "dropbox", or "grade", or when strong related resources exist elsewhere. Instructions for these assignments likely live in modules, pages, or files.

- **Context confidence**:
  - `high` — strong Canvas description with related resources, or 3+ related resources
  - `medium` — some related resources, or downloaded attachments, or strong description alone
  - `low` — weak description with few/no related resources

- **Weak description**: A Canvas description is considered weak if it is blank, very short (<30 chars), consists only of links, or matches generic submit-only text patterns.

**Title matching** uses case-insensitive normalization with punctuation stripping. Matches are found via exact match, containment (one title contains the other), or token overlap (≥50% of meaningful words shared).

**Graceful fallback:** If no course cache exists, commands behave exactly as before — no enrichment lines are shown. Enrichment never breaks existing functionality.

### Course matching

The `--course` flag matches against course codes and names, case-insensitively:

```bash
canvas-cli assignments --course ece297
canvas-cli assignments --course "Algorithms"
canvas-cli assignments --course ece
```

If multiple courses match, you'll see a disambiguation message.

## Default filtering

By default, `canvas-cli` optimizes for relevance over completeness:

**Courses:**
- Only current/active courses are shown
- A course is considered "past" if its term or end date is more than 30 days ago, its workflow state is completed, or all enrollments are inactive
- Use `--all` to see everything

**Assignments:**
- Only upcoming assignments and recently overdue items (last 14 days) from current courses
- Submitted assignments are hidden by default
- Assignments with no due date are hidden by default
- Use `--all`, `--include-submitted`, or `--include-no-due-date` to broaden

## Project Structure

```
src/
  cli.ts                          — Entry point (TUI default + CLI subcommands)
  tui/
    app.ts                        — Interactive TUI state machine
    picker.ts                     — Arrow-key list picker component
    workspace-ui.ts               — Workspace REPL (chat + slash commands)
    screen.ts                     — ANSI terminal utilities
    services.ts                   — Service layer wrapping existing logic
  errors.ts                       — Shared error handling
  ai/
    types.ts                      — AI overview types
    provider.ts                   — AI provider abstraction (Anthropic)
    prompts.ts                    — System/user prompt construction
    context-bundle.ts             — Assemble context for AI from enrichment
    parse.ts                      — Parse structured AI response
    generate-overview.ts          — AI overview pipeline orchestrator
  work/
    types.ts                      — AssignmentWorkup, InvestigationState types
    orchestrator.ts               — Bounded tool-calling investigation loop
    tools.ts                      — Tool definitions for the agent
    tool-handlers.ts              — Tool execution (search, read, extract)
    synthesis.ts                  — Final structured synthesis pass
    workspace.ts                  — Rich workspace creation
    generate-markdown.ts          — assignment.md and plan.md generation
  ask/
    types.ts                      — WorkspaceAnswer, ContentChunk types
    resolve-workspace.ts          — Find active workspace
    load-workspace.ts             — Load workspace artifacts
    retrieve.ts                   — BM25 keyword retrieval over chunks
    answer.ts                     — Grounded QA via LLM
    render.ts                     — Terminal output rendering
  commands/
    courses.ts                    — courses command
    assignments.ts                — assignments command
    show-assignment.ts            — show assignment detail command
    do-assignment.ts              — do command (basic workspace)
    work.ts                       — work command (AI-powered deep workspace)
    ask.ts                        — ask command (workspace QA)
    ingest-course.ts              — ingest command (course ingestion)
  canvas/
    client.ts                     — Canvas REST API client
    types.ts                      — Raw Canvas API types
  domain/
    models.ts                     — Normalized internal types
    normalize.ts                  — Canvas → internal mapping
    course-relevance.ts           — Course relevance heuristics
    assignment-relevance.ts       — Assignment filtering logic
    matching.ts                   — Course and assignment matching
    sorting.ts                    — Urgency-based sorting
    resolve-assignment.ts         — Shared assignment resolution logic
  enrich/
    types.ts                      — Enriched assignment types
    enrich-assignment.ts          — Core enrichment logic
    cache-loader.ts               — Load course cache from disk
    matchers.ts                   — Title similarity matching
    scoring.ts                    — Weak description, submission shell, confidence
  ingest/
    types.ts                      — Ingestion-specific normalized types
    slug.ts                       — Course slug generation, paths
    ingest-course.ts              — Main ingestion pipeline orchestrator
    fetch-course-content.ts       — Fetch all course data from Canvas
    normalize-content.ts          — Normalize raw API data for storage
    syllabus-heuristics.ts        — Identify likely syllabus sources
    attachment-selection.ts       — Select which files to download
    attachment-download.ts        — Download selected attachments
    storage.ts                    — Write artifacts to local filesystem
  format/
    renderCourses.ts              — Course list formatting
    renderAssignments.ts          — Assignment list formatting
    renderAssignmentDetail.ts     — Single assignment detail view
    render-ingestion-summary.ts   — Ingestion result formatting
    html-to-text.ts               — HTML → terminal text converter
  workspace/
    paths.ts                      — Slug generation, workspace paths
    session.ts                    — Session metadata types
    create.ts                     — Workspace creation logic
    assignment-markdown.ts        — assignment.md generation
  config/
    env.ts                        — Environment variable loading
```
=======
- `src/` is the source root and `dist/` is build output.
- Source folders are organized by responsibility rather than by command surface alone.
- New source files should use kebab-case names.
>>>>>>> main
