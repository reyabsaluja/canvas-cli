# canvas-cli

A terminal interface for Canvas LMS. View your courses and assignments from the command line.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file from the example:

```bash
cp .env.example .env
```

3. Fill in your Canvas credentials in `.env`:

- **`CANVAS_BASE_URL`** — Your institution's Canvas API base URL (e.g. `https://q.utoronto.ca/api/v1`)
- **`CANVAS_ACCESS_TOKEN`** — Generate one from Canvas: Account → Settings → New Access Token
- **`ANTHROPIC_API_KEY`** (optional) — Required for `--smart` AI features. Get one from [console.anthropic.com](https://console.anthropic.com)

4. Build the project:

```bash
npm run build
```

## Commands

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
  cli.ts                          — CLI entry point
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
  commands/
    courses.ts                    — courses command
    assignments.ts                — assignments command
    show-assignment.ts            — show assignment detail command
    do-assignment.ts              — do command (basic workspace)
    work.ts                       — work command (AI-powered deep workspace)
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
