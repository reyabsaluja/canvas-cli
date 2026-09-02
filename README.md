# canvas-cli

[![CI](https://github.com/reyabsaluja/canvas-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/reyabsaluja/canvas-cli/actions/workflows/ci.yml)

`canvas-cli` is an interactive terminal interface for Canvas LMS. It provides a TUI for browsing courses, assignments, and course materials, with optional AI-assisted assignment investigation — all from the terminal.

## Highlights

- Interactive TUI for browsing courses, assignments, modules, and files
- Ingest course materials into a reusable local cache
- AI-powered assignment workspaces with summaries, plans, and extracted artifacts
- Grounded Q&A against workspace context
- Timeline, grades, announcements, and discussion threads straight from Canvas (`/timeline`, `/grade`, `/announcements`, `/thread`)
- Practice quizzes, lecture lookup, and PDF export with LaTeX rendering (`/quiz`, `/lecture`, `/pdf`)
- Persistent chat sessions across global, course, and workspace scopes

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

Credentials are stored securely. On macOS they go in your system Keychain with no plaintext copy on disk. Elsewhere — or when the Keychain is unavailable, or when `CANVAS_CLI_CREDENTIAL_BACKEND=file` is set — they are written to permission-restricted files under `~/.config/canvas-cli/credentials/` (respects `$XDG_CONFIG_HOME`). They are never written to your project directory.

### 2. Verify your connection

```bash
canvas-cli status
```

You should see your credentials and connection confirmed. If not, see [Troubleshooting](#troubleshooting) below.

### 3. Launch canvas-cli

```bash
canvas-cli
```

This opens the interactive TUI where you can browse courses, view assignments, open workspaces, and chat with AI about your coursework. Use `/courses` to get started.

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

> **Note:** When entering the URL in `canvas-cli login`, leave off `/api/v1` — canvas-cli appends it for stored config. If you set `CANVAS_BASE_URL` in your environment or `.env` instead, the value is used verbatim, so include `/api/v1` there (e.g., `https://your-school.instructure.com/api/v1`). See [Environment variables](#environment-variables).

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
| `canvas-cli ingest` | No | Downloads and caches locally |
| TUI navigation and pickers | No | `/courses`, `/assignments`, `/recent`, etc. |
| `/timeline`, `/grade`, `/announcements`, `/thread`, `/files`, `/modules` | No | Read from Canvas or the local cache |
| TUI workspace creation | **Yes** | AI investigation agent |
| TUI conversational mode | **Yes** | AI chat in all scopes |
| `/quiz`, `/pdf` | **Yes** | Quiz generation and PDF content |

### Provider comparison

| Provider | Default model | Cost tier | Best for |
|---|---|---|---|
| Anthropic | Claude Sonnet 4.6 | Mid | Detailed reasoning, structured output |
| OpenAI | GPT-5.4 | Mid | General-purpose, fast responses |
| Google / Gemini | Gemini 3.5 Flash | Low | Budget-friendly, fast |
| AWS Bedrock | Claude Sonnet 4.6 | Mid | Teams already on AWS, no separate API key |

**Typical usage costs ~$0.50–2/month** for a student using AI features a few times per week (check your provider's pricing page for current rates). Costs depend on the model you choose and how often you use AI features in the TUI (workspace creation, chat, `/quiz`, `/pdf`). Budget models (Gemini Flash, GPT-5.4 Mini) are significantly cheaper; premium models (Claude Opus, GPT-5.5) cost more but produce higher-quality analysis.

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
AI_MODEL=gemini-3.1-pro-preview # use Google's reasoning model
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
- **Wrong URL format:** With `canvas-cli login`, the base URL should be just the domain — no `/api/v1`, trailing slashes, or extra path segments (`https://canvas.school.edu`). With `CANVAS_BASE_URL` in the environment, the value is used as-is and must include `/api/v1` (`https://canvas.school.edu/api/v1`). Run `/doctor` in the TUI to check what canvas-cli resolved.
- **DNS issues:** Verify you can reach the URL with `curl https://your-base-url/api/v1/users/self -H "Authorization: Bearer YOUR_TOKEN"`.

### "No courses found"

- **Enrollment filtering:** By default, only current/active courses are shown in the TUI. If your current term just ended, courses may have already been marked inactive.
- **Student role only:** canvas-cli filters to enrollments where you have an active role. If you were recently added to a course, it may take a few minutes to appear.
- **Wrong account:** Verify you're using a token from the correct Canvas account if your institution has multiple Canvas instances.

### AI features not working

- **No provider configured:** Run `canvas-cli login` and select "Configure AI provider" to set up an API key.
- **Invalid API key:** Verify your key is correct and has not been revoked. Test it directly with your provider's API.
- **Rate limited:** If you see rate limit errors, wait a few minutes and retry. Consider using a provider with higher rate limits.
- **Missing course ingestion:** Workspaces produce better results after running `canvas-cli ingest <course>` first. Without ingestion, the AI has less context to work with.

## Commands

| Command | Purpose |
| --- | --- |
| `canvas-cli` | Launch the interactive TUI |
| `canvas-cli login [--profile <name>]` | Set up Canvas credentials (and optionally an AI provider) interactively |
| `canvas-cli logout [--profile <name>]` | Remove stored credentials and configuration |
| `canvas-cli status [--profile <name>]` | Show current configuration and connection status |
| `canvas-cli ingest <course> [--refresh] [--json]` | Cache course materials locally |
| `canvas-cli clean [-y]` | Remove local cached data (courses, sessions, chat history); `-y` skips the confirmation |
| `canvas-cli clean --all` | Also remove global config and stored credentials |
| `canvas-cli examples` | Print common workflows |
| `canvas-cli --debug <command>` | Verbose diagnostic output to stderr (secrets masked) |
| `canvas-cli --version` | Print the installed version |

Run `canvas-cli <command> --help` for details on any command.

### Profiles

Use `--profile <name>` with `login`, `logout`, and `status` to keep separate Canvas accounts (e.g., `school` and `work`). Set `CANVAS_CLI_PROFILE=<name>` to make a profile active for the TUI and `ingest`. Profile names may contain letters, numbers, hyphens, and underscores.

### Environment variables

`canvas-cli login` is the recommended setup and stores everything under `~/.config/canvas-cli/`. Environment variables (or a `.env` file in the current directory) override stored config:

| Variable | Purpose |
|---|---|
| `CANVAS_BASE_URL` | Canvas API URL, used verbatim — include `/api/v1` |
| `CANVAS_ACCESS_TOKEN` | Canvas access token |
| `CANVAS_CLI_PROFILE` | Active profile name (default: `default`) |
| `AI_PROVIDER` | `anthropic`, `openai`, `google` (or `gemini`), or `bedrock` |
| `AI_MODEL` | Model ID override for the provider |
| `AI_EFFORT` | `low`, `medium`, `high`, or `max` (ignored for Google) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` | Provider API keys |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK` | Bedrock credentials |
| `DEBUG=canvas-cli` | Same as `--debug` |
| `CANVAS_CLI_CREDENTIAL_BACKEND=file` | Store credentials in permission-restricted files instead of the macOS Keychain (mainly for tests and CI) |
| `XDG_CONFIG_HOME` | Relocates the config directory from `~/.config` |

> **Important:** If `CANVAS_BASE_URL` is set in the environment or `.env`, `CANVAS_ACCESS_TOKEN` must be set there too. A token saved by `canvas-cli login` is never combined with an environment-supplied URL, so a stray `.env` can't redirect your stored token to another host.

## Local State

Generated local state is stored under `.canvas-cli/` and ignored by git:

- `.canvas-cli/courses/`: ingested course data and attachments
- `.canvas-cli/sessions/`: assignment workspaces, extracted text, notes, and plans
- `.canvas-cli/chat-sessions/`: persistent chat history (global, course, workspace scopes)
- `.canvas-cli/exports/`: generated PDFs from chat `/pdf` command

### Data lifecycle

| Action | What happens |
|---|---|
| `canvas-cli ingest <course>` | Downloads course data into `.canvas-cli/courses/` |
| `canvas-cli clean` | Removes the entire `.canvas-cli/` directory in the current project |
| `canvas-cli clean --all` | Removes `.canvas-cli/` and `~/.config/canvas-cli/` (credentials + config) |
| `npm uninstall -g @reyabsaluja/canvas-cli` | Removes the CLI binary only — local `.canvas-cli/` directories and `~/.config/canvas-cli/` are **not** removed |

To fully uninstall, run `canvas-cli clean --all` before uninstalling the package.

## Privacy

canvas-cli collects **no telemetry, analytics, or usage data**. There are no external service calls for tracking, no crash reporters, and no "phone home" behavior of any kind.

### What stays on your machine

All data canvas-cli creates lives in two locations:

| Location | Contents |
|---|---|
| `~/.config/canvas-cli/` (respects `$XDG_CONFIG_HOME`) | Profile configuration, plus your Canvas token and AI provider API keys when the file backend is in use. On macOS these secrets live in the Keychain instead and no plaintext copy is written unless the Keychain is unavailable or `CANVAS_CLI_CREDENTIAL_BACKEND=file` is set. |
| `.canvas-cli/` (in your project directory) | Ingested course data, assignment workspaces, chat sessions, and extracted documents |

Nothing is sent anywhere except the destinations listed below.

### What leaves your machine

| Destination | Data sent | When |
|---|---|---|
| Your Canvas instance | Canvas API token (in `Authorization` header) | Any command that fetches courses, assignments, or files |
| AI provider (Anthropic, OpenAI, Google, or AWS Bedrock) | AI API key + prompt content (assignment text, course materials) | Only when using AI features (workspace creation, chat, Q&A in the TUI) |
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
bun run dev login      # store credentials (or: cp .env.example .env and fill it in)
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

`/help` lists exactly what is available in the current scope. Type a partial command to get inline completion.

Available in every scope:

| Command | Description |
|---|---|
| `/manage-courses` | Add, remove, or rename configured courses |
| `/open <query>` | Open a resource or file (shows a picker in course and workspace scope) |
| `/copy [all \| last <N>]` | Copy the last response, the last N, or the whole transcript (Ctrl+Y also works) |
| `/pdf <instructions>` | Generate a PDF from the chat context into `.canvas-cli/exports/` (alias `/make-pdf`) |
| `/model [effort \| key]` | Switch AI provider/model; `effort` sets thinking effort, `key` rotates the API key |
| `/doctor` | Diagnose configuration, credentials, and connectivity |
| `/login` | Re-run the login setup |
| `/clear` | Clear the current chat and reset context |
| `/help` | Show available commands for this scope |
| `/quit` | Exit canvas-cli (aliases `/exit`, `/q`) |

Global scope:

| Command | Description |
|---|---|
| `/courses` | Open the course picker |
| `/recent` | Reopen a recent course or workspace |
| `/timeline [week \| month \| semester \| next N days/weeks] [--all]` | ASCII Gantt view of upcoming work across courses |
| `/grade [need <letter>] [<course>]` | Grade summary, per-course detail, and "what do I need" calculator |
| `/announcements` | Browse announcements in a scrollable card view |
| `/thread <id \| title>` | Read a discussion thread |

Course scope:

| Command | Description |
|---|---|
| `/assignments` | Open the assignment picker for the current course |
| `/files` | List cached files and downloads for the course |
| `/modules` | List course modules |
| `/timeline`, `/grade`, `/announcements`, `/thread` | As in global scope, limited to the current course |
| `/quiz [<count>] [easy \| medium \| hard] [flash] [<topic>]` | Practice quiz generated from course material |
| `/lecture <query>` | Find and open lecture content (alias `/lec`) |
| `/refresh` | Re-ingest the course data |
| `/back` | Return to global scope |
| `/home` | Return to the global home session |

Workspace scope:

| Command | Description |
|---|---|
| `/overview` | Show assignment overview |
| `/requirements` | Show deliverables and constraints (alias `/reqs`) |
| `/plan` | Show the action plan |
| `/resources` | Show key resources |
| `/evidence` | Show confirmed vs inferred sources |
| `/status` | Show workspace status |
| `/quiz`, `/lecture` | As in course scope |
| `@<resource>` | Attach a workspace file or cached attachment to your next prompt |
| `/refresh` | Refresh the workspace from the latest course cache |
| `/back` | Return to the course session |
| `/home` | Return to the global home session |

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

### `canvas-cli ingest <course>`

Ingest course structure and content into a local cache. This is the only data-fetching command outside the TUI — useful for pre-caching course materials before going offline or to ensure the TUI has full context available.

```bash
canvas-cli ingest ece297                              # ingest by course code
canvas-cli ingest "Software Design and Communication" # ingest by course name
canvas-cli ingest ece297 --refresh                    # force re-ingestion
canvas-cli ingest ece297 --json                       # machine-readable summary
```

**Storage location:** `.canvas-cli/courses/<course-slug>/` in the current directory.

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

**Repeated invocation** refreshes all data and re-downloads missing attachments. Use `--refresh` to force a complete re-ingestion.

**Note:** Some institutions block the Files API and/or Pages API for students. When this happens, the file and page indexes will be empty, and attachment selection will be limited. Module items and assignment descriptions remain accessible.

## Project Structure

- `src/` is the source root and `dist/` is build output.
- `src/tui/` contains the chat-native shell, scope runtime, and interactive workflows.
- `src/workspace/` owns workspace lifecycle orchestration, workspace creation, and persisted session files.
- `src/work/` contains the bounded assignment investigation pipeline and synthesis logic.
- `src/ingest/`, `src/enrich/`, and `src/knowledge/` handle local course caching, enrichment, and retrieval.
- `src/commands/` keeps the setup CLI entrypoints (`login`, `logout`, `status`, `ingest`, `clean`, `examples`) and TUI-invoked flows (`model`).
- `src/agent/`, `src/pdf/`, `src/sanitize.ts`, and `src/debug.ts` hold agent run state, PDF/LaTeX rendering, filesystem/terminal sanitization, and masked debug logging.
- `tests/` (and a few older files in `test/`) cover workspace lifecycle, chat grounding, config resolution, and regression behavior.
- Source folders are organized by responsibility rather than by command surface alone.
- New source files should use kebab-case names.
- For the up-to-date detailed map, use [Project structure](docs/project-structure.md).
