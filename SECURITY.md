# Security Policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

1. Go to the [Security tab](https://github.com/reyabsaluja/canvas-cli/security) of this repository.
2. Choose **Report a vulnerability** and describe the issue, how to reproduce it, and what an attacker could do with it.

You should hear back within a few days. Once a fix is released, the advisory is published with credit to you unless you ask otherwise.

## Scope

canvas-cli handles a Canvas personal access token and AI provider keys, downloads course files, and runs vendor CLIs (GitHub Copilot, OpenAI Codex) for subscription providers. Reports about any of these are especially welcome, for example:

- a secret reaching a host other than the one it belongs to, or appearing in logs, argv, or files readable by other users
- a course file, archive, or link that can write outside the `.canvas-cli` folder or exhaust disk or memory
- a way for course content to make the assistant run commands or read files it should not

## Supported versions

Security fixes go into the latest release. Update with the install script or `npm install -g @reyabsaluja/canvas-cli@latest`.
