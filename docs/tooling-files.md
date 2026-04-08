# Tooling Files

This repo contains a few hidden or metadata files that are easy to confuse with source code. This page explains what each one is for and what should happen to it.

## Skills

### `.agents/skills/`

This is the local project skills directory. It contains installed skill definitions such as `debug`, `terminal-ui`, and `ai-sdk`.

Recommended practice:

- Keep personal or local project skills here.
- Organize by one folder per skill.
- Ignore it in git unless the team explicitly wants a shared checked-in skill workflow.

### `.claude/`

In this repo, `.claude/` contains local Claude configuration and symlinks for local skill access. It is tool-specific setup, not source code.

Recommended practice:

- Do not merge `.agents/skills/` into `.claude/` or vice versa unless your tooling is explicitly configured for that layout.
- Treat it as local config and ignore it in git.

### `skills-lock.json`

This is the lockfile for installed skills. It records where each skill came from and its integrity hash.

Recommended practice:

- Keep it at the repo root next to `package.json`.
- Ignore it in git if skills are local-only for your development environment.
- Commit it only if you intentionally decide to share and reproduce skill installs across the whole team.

## Editor and OS Files

### `.editorconfig`

This is a standard editor configuration file. It tells editors how to format files in a consistent way, such as:

- using spaces instead of tabs
- using LF line endings
- ending files with a newline
- trimming trailing whitespace in code files

Recommended practice:

- Keep this file.
- Treat it as a repo quality tool, similar to a formatter or linter config.

### `.DS_Store`

This is a macOS Finder metadata file. It is not source code and does not belong in the repository.

Recommended practice:

- Delete it if it appears.
- Keep it in `.gitignore`.

## Cleanup Decision For This Repo

Current recommended structure:

- `.agents/skills/` for local installed skills
- `.claude/` for local Claude-specific settings and symlinks
- `skills-lock.json` at the root as local lock metadata
- `.editorconfig` kept in the root
- `.DS_Store` removed and ignored
