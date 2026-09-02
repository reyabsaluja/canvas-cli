# Tooling Files

This repo contains a few hidden or metadata files that are easy to confuse with source code. This page explains what each one is for and what should happen to it.

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

## Local Agent Tooling

`.gitignore` excludes `.agents/`, `.claude/`, and `skills-lock.json`. These are per-developer coding-agent configuration and are not part of the checkout. If they appear on your machine, leave them uncommitted.

## Local State

`.env`, `.canvas-cli/`, and `dist/` are generated or personal and are ignored as well. See the [development guide](development.md) for how credentials are expected to be configured.
