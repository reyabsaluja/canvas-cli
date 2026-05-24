# canvas-cli

[![CI](https://github.com/reyabsaluja/canvas-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/reyabsaluja/canvas-cli/actions/workflows/ci.yml)

`canvas-cli` is a TypeScript command-line interface for working with Canvas LMS from the terminal. It combines direct Canvas API access, local course ingestion, an interactive TUI, and optional AI-assisted assignment investigation.

## Highlights

- Browse Canvas courses and assignments without leaving the terminal
- Ingest course materials into a reusable local cache
- Generate assignment workspaces with summaries, plans, and extracted artifacts
- Ask grounded questions against an existing workspace
- Launch an interactive terminal UI by running the CLI with no subcommand

## Installation

**Prerequisites:** [Node.js](https://nodejs.org/) version 20 or later.

```bash
npm install -g @reyabsaluja/canvas-cli
```

Or use another package manager:

```bash
bun add -g @reyabsaluja/canvas-cli
pnpm add -g @reyabsaluja/canvas-cli
```

Or run without installing:

```bash
npx @reyabsaluja/canvas-cli
```

Verify the installation:

```bash
canvas-cli --version
```

## Quick Start

### 1. Run the interactive login

```bash
canvas-cli login
```

The login wizard walks you through:
1. Entering your Canvas base URL (e.g., `https://your-school.instructure.com`)
2. Pasting your Canvas API access token
3. Optionally configuring an AI provider for smart features

Credentials are stored securely — on macOS in your system Keychain, otherwise under `~/.config/canvas-cli/`. They are never written to your project directory.

### 2. Verify your connection

```bash
canvas-cli courses
```

You should see your active courses listed. If not, see [Troubleshooting](#troubleshooting) below.

### 3. Start using canvas-cli

Launch the interactive TUI:

```bash
canvas-cli
```

Or use individual commands:

```bash
canvas-cli assignments                    # see what's due
canvas-cli ingest ece297                  # cache course materials locally
canvas-cli work "Milestone 3"            # build an AI-powered assignment workspace
```

## Getting a Canvas API Token

Canvas uses personal access tokens for API authentication. Here's how to generate one:

1. Log in to your institution's Canvas site (e.g., `https://your-school.instructure.com`)
2. Click your **profile picture** (top-left) → **Settings**
3. Scroll down to **Approved Integrations**
4. Click **+ New Access Token**
5. Enter a purpose (e.g., "canvas-cli") and optionally set an expiry date
6. Click **Generate Token**
7. **Copy the token immediately** — it won't be shown again

> **Security:** Treat your token like a password. Do not share it in chat, commit it to git, or post it in issues. If compromised, revoke it immediately in Canvas → Settings → Approved Integrations.

Your Canvas base URL is the root of your institution's Canvas site. Common formats:
- `https://canvas.university.edu`
- `https://your-school.instructure.com`
- `https://learn.institution.edu`

> **Note:** Do not include `/api/v1` in the base URL — canvas-cli adds this automatically.

> **Note:** Some institutions disable personal access tokens for students. If you don't see the "New Access Token" button, contact your institution's Canvas administrator.

## AI Provider Setup (Optional)

AI features require an API key from one supported provider. Only one provider is needed — pick whichever you prefer. All AI features are optional; core Canvas functionality works without any AI configuration.

The fastest way to set up AI is through the interactive login:

```bash
canvas-cli login
```

Select "Configure AI provider" when prompted, choose your provider, and paste your API key. You can also change providers later with the `/model` command in the TUI.

### Which features require AI?

| Feature | Requires AI | Notes |
|---|---|---|
| `canvas-cli courses` | No | Direct Canvas API |
| `canvas-cli assignments` | No | Direct Canvas API (enrichment is local) |
| `canvas-cli show assignment` | No | Direct Canvas API |
| `canvas-cli show assignment --smart` | **Yes** | AI-powered assignment overview |
| `canvas-cli ingest` | No | Downloads and caches locally |
| `canvas-cli do` | No | Creates workspace structure without AI |
| `canvas-cli work` | **Yes** | AI investigation agent |
| `canvas-cli ask` | **Yes** | AI-grounded Q&A |
| TUI conversational mode | **Yes** | AI chat in all scopes |
| TUI navigation and pickers | No | `/courses`, `/assignments`, `/recent`, etc. |

### Provider comparison

| Provider | Default model | Cost tier | Best for |
|---|---|---|---|
| Anthropic | Claude Sonnet 4.6 | Mid | Detailed reasoning, structured output |
| OpenAI | GPT-5.4 | Mid | General-purpose, fast responses |
| Google / Gemini | Gemini 3.5 Flash | Low | Budget-friendly, fast |
| AWS Bedrock | Claude Sonnet 4.6 | Mid | Teams already on AWS, no separate API key |

**Typical usage costs ~$0.50–2/month** for a student using AI features a few times per week (as of mid-2025 — check your provider's pricing page for current rates). Costs depend on the model you choose and how often you use `work`, `ask`, and TUI chat. Budget models (Gemini Flash, GPT-5.4 Mini) are significantly cheaper; premium models (Claude Opus, GPT-5.5) cost more but produce higher-quality analysis.

### Setting up Anthropic

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Sign up or log in
3. Navigate to **API Keys** in the dashboard
4. Click **Create Key**, give it a name (e.g., "canvas-cli")
5. Copy the key (typically starts with `sk-ant-`)

Then either run `canvas-cli login` and paste the key when prompted, or set it manually:

```bash
# In your .env file
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

### Setting up OpenAI

1. Go to [platform.openai.com](https://platform.openai.com/)
2. Sign up or log in
3. Navigate to **API keys** (under your profile or the sidebar)
4. Click **Create new secret key**, name it (e.g., "canvas-cli")
5. Copy the key (starts with `sk-`)

```bash
# In your .env file
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

### Setting up Google / Gemini

1. Go to [aistudio.google.com](https://aistudio.google.com/)
2. Sign in with your Google account
3. Click **Get API key** in the top navigation
4. Click **Create API key** and select or create a project
5. Copy the generated key

```bash
# In your .env file
AI_PROVIDER=google
GOOGLE_API_KEY=...
```

### Setting up AWS Bedrock

Bedrock is for users already on AWS. It requires IAM credentials rather than a simple API key, and the Claude models must be enabled in your AWS account first.

1. In the AWS Console, navigate to **Amazon Bedrock** → **Model access**
2. Request access to the Anthropic Claude models in your preferred region
3. Create an IAM user or role with `bedrock:InvokeModel` permissions
4. Generate access keys for that IAM user

```bash
# In your .env file
AI_PROVIDER=bedrock
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

Optional Bedrock variables: `AWS_SESSION_TOKEN` (for temporary credentials) and `AWS_BEARER_TOKEN_BEDROCK` (for Bedrock bearer token auth).

### Overriding the default model

Each provider has a sensible default, but you can override it with `AI_MODEL`:

```bash
AI_MODEL=claude-opus-4-7        # use Anthropic's most capable model
AI_MODEL=gpt-5.5                # use OpenAI's most capable model
AI_MODEL=gemini-2.5-pro         # use Google's legacy reasoning model
```

Available models per provider:

| Provider | Models |
|---|---|
| Anthropic | `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6` |
| OpenAI | `gpt-5.5`, `gpt-5.4-pro`, `gpt-5.4`, `gpt-5.4-mini` |
| Google | `gemini-3.5-flash`, `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-3.1-flash-lite`, `gemini-2.5-pro`, `gemini-2.5-flash` |
| Bedrock | `us.anthropic.claude-opus-4-7`, `us.anthropic.claude-opus-4-6-v1`, `us.anthropic.claude-sonnet-4-6` |

You can also set the model interactively with the `/model` command in the TUI, or rotate your API key with `/model key`.

### Thinking effort

For providers that support extended thinking (Anthropic, OpenAI, Bedrock), you can control how much reasoning the model does:

```bash
AI_EFFORT=low       # fastest, cheapest — good for simple questions
AI_EFFORT=medium    # balanced
AI_EFFORT=high      # more thorough analysis
AI_EFFORT=max       # maximum reasoning — best for complex assignments
```

Set interactively with `/model effort` in the TUI. Google/Gemini does not support effort levels.

### Auto-detection fallback

If you set an API key without specifying `AI_PROVIDER`, canvas-cli auto-detects the provider from whichever key is present (checking Anthropic, then OpenAI, then Google in that order). Bedrock is never auto-detected — you must set `AI_PROVIDER=bedrock` explicitly. Explicit `AI_PROVIDER` is recommended to avoid ambiguity if you have multiple keys set.

## Troubleshooting

### "Authentication failed" or 401 errors

- **Token expired:** Canvas tokens can expire if you set an expiry date. Generate a new one in Canvas → Settings → Approved Integrations.
- **Wrong base URL:** Ensure your base URL matches your institution's Canvas domain exactly. Try opening `https://your-base-url/api/v1/users/self` in a browser while logged in — if it returns JSON, the URL is correct.
- **Token revoked:** Check that your token still appears in Canvas → Settings → Approved Integrations. If not, generate a new one and run `canvas-cli login` again.

### "Network error" or connection failures

- **VPN required:** Many institutions require VPN access to reach Canvas. Connect to your school's VPN and retry.
- **Firewall blocking:** Corporate or campus firewalls may block outbound HTTPS. Try from a different network.
- **Wrong URL format:** The base URL should not include `/api/v1`, trailing slashes, or path segments beyond the domain. Correct: `https://canvas.school.edu`. Incorrect: `https://canvas.school.edu/api/v1/`.
- **DNS issues:** Verify you can reach the URL with `curl https://your-base-url/api/v1/users/self -H "Authorization: Bearer YOUR_TOKEN"`.

### "No courses found"

- **Enrollment filtering:** By default, only current/active courses are shown. Use `canvas-cli courses --all` to include past terms.
- **Completed terms:** Courses from finished terms are hidden by default. If your current term just ended, courses may have already been marked inactive.
- **Student role only:** canvas-cli filters to enrollments where you have an active role. If you were recently added to a course, it may take a few minutes to appear.
- **Wrong account:** Verify you're using a token from the correct Canvas account if your institution has multiple Canvas instances.

### AI features not working

- **No provider configured:** Run `canvas-cli login` and select "Configure AI provider" to set up an API key.
- **Invalid API key:** Verify your key is correct and has not been revoked. Test it directly with your provider's API.
- **Rate limited:** If you see rate limit errors, wait a few minutes and retry. Consider using a provider with higher rate limits.
- **Missing course ingestion:** Commands like `work` and `ask` produce better results after running `canvas-cli ingest <course>` first. Without ingestion, the AI has less context to work with.

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

## Privacy

canvas-cli collects **no telemetry, analytics, or usage data**. There are no external service calls for tracking, no crash reporters, and no "phone home" behavior of any kind.

### What stays on your machine

All data canvas-cli creates lives in two locations:

| Location | Contents |
|---|---|
| `~/.config/canvas-cli/` (respects `$XDG_CONFIG_HOME`; macOS uses Keychain) | Your Canvas token, AI provider API keys, and profile configuration |
| `.canvas-cli/` (in your project directory) | Ingested course data, assignment workspaces, chat sessions, and extracted documents |

Nothing is sent anywhere except the destinations listed below.

### What leaves your machine

| Destination | Data sent | When |
|---|---|---|
| Your Canvas instance | Canvas API token (in `Authorization` header) | Any command that fetches courses, assignments, or files |
| AI provider (Anthropic, OpenAI, Google, or AWS Bedrock) | AI API key + prompt content (assignment text, course materials) | Only when using AI features (`work`, `ask`, `show --smart`, TUI chat) |
| External URLs linked in course content | HTTP request (no credentials) | During `canvas-cli ingest`, to capture linked documents (Google Docs, PDFs, etc.) |

API keys are sent **only** to their respective providers — your Canvas token is never sent to an AI provider, and AI keys are never sent to Canvas. External link fetches during ingestion carry no authentication headers.

### Debug output

The `--debug` flag writes diagnostic info to stderr. All secrets are automatically masked in debug output — tokens, API keys, and credentials are replaced with `***` before being written.

### Future policy

If analytics are ever added, they will be strictly opt-in with clear disclosure before any data is collected.

## Development

```bash
git clone https://github.com/reyabsaluja/canvas-cli.git
cd canvas-cli
bun install
cp .env.example .env   # fill in your Canvas URL, token, and optional AI key
bun run dev            # run from source
```

Other development commands:

```bash
bun run typecheck
bun run test
bun run build
bun run check          # typecheck + test + build (all gates)
```

## Documentation

- [Documentation index](docs/README.md)
- [Architecture overview](docs/architecture.md)
- [Project structure](docs/project-structure.md)
- [Development guide](docs/development.md)
- [Contributing guide](CONTRIBUTING.md)

## Interactive Shell

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
| `@<resource>` | Attach a workspace file or cached attachment to your next prompt |
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
- Configure an AI provider in your `.env` file (`AI_PROVIDER` plus the matching credentials)
- Best results when the course has been ingested first (`canvas-cli ingest <course>`)

**How it works:** The AI reads the actual course materials — including PDF instruction documents, the course syllabus, the module structure, and the full assignment list. It synthesizes a concrete summary of what the assignment requires. When the Canvas due date is missing, it cross-references the syllabus and schedule to find it.

**Fallback behavior:**
- Without an AI provider configured: the `--smart` flag shows a subtle note that AI is unavailable; the rest of the command works normally
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
- An AI provider configured in `.env` (`AI_PROVIDER` plus the matching credentials)
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
The investigation agent uses AI SDK tool calling with the configured provider and a bounded loop (max 10 iterations). It has tools to search modules, read downloaded PDFs, check the syllabus, and browse files. It decides what to investigate based on the assignment context and enrichment data. After investigation, a separate synthesis pass produces the structured workup.

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
- An AI provider configured in `.env` (`AI_PROVIDER` plus the matching credentials)
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

- `src/` is the source root and `dist/` is build output.
- `src/tui/` contains the chat-native shell, scope runtime, and interactive workflows.
- `src/workspace/` owns workspace lifecycle orchestration, workspace creation, and persisted session files.
- `src/work/` contains the bounded assignment investigation pipeline and synthesis logic.
- `src/ingest/`, `src/enrich/`, and `src/knowledge/` handle local course caching, enrichment, and retrieval.
- `src/commands/` keeps the non-interactive CLI entrypoints.
- `tests/` covers workspace lifecycle, chat grounding, and regression behavior.
- Source folders are organized by responsibility rather than by command surface alone.
- New source files should use kebab-case names.
- For the up-to-date detailed map, use [Project structure](docs/project-structure.md).
