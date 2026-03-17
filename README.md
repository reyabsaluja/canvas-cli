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

Course-scoped view:

```bash
canvas-cli assignments --course ece297
```

```
  - Milestone 3 — Mar 22, 11:59 PM — due in 5d
  - Milestone 2 — Mar 15, 11:59 PM — overdue
```

### `canvas-cli show assignment <name>`

Show detailed information for a single assignment.

```bash
canvas-cli show assignment "Milestone 3" --course ece297   # scoped to a course
canvas-cli show assignment "Lab5 Quiz"                      # search across all current courses
canvas-cli show assignment _ --id 1710240 --course ece297   # look up by Canvas ID
canvas-cli show assignment "Milestone 3" --json             # JSON output
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
  commands/
    courses.ts                    — courses command
    assignments.ts                — assignments command
    show-assignment.ts            — show assignment detail command
    do-assignment.ts              — do command (workspace creation)
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
  format/
    renderCourses.ts              — Course list formatting
    renderAssignments.ts          — Assignment list formatting
    renderAssignmentDetail.ts     — Single assignment detail view
    html-to-text.ts               — HTML → terminal text converter
  workspace/
    paths.ts                      — Slug generation, workspace paths
    session.ts                    — Session metadata types
    create.ts                     — Workspace creation logic
    assignment-markdown.ts        — assignment.md generation
  config/
    env.ts                        — Environment variable loading
```
