# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `prepublishOnly` script to prevent broken publishes
- End-to-end smoke tests for npx installation flow

### Changed

- Scoped npm package name to `@reyabsaluja/canvas-cli`
- Excluded source maps and declarations from published package

### Fixed

- Missing pdfkit dependencies breaking CI build
- Generic fallback hint in TUI connect error handler
- Rate-limited endpoints now skipped gracefully in paginated fetches
- Network error detection improvements (undici `fetch failed`, cause chain)

## [0.1.0] - 2026-03-17

### Added

- Initial CLI scaffolding with Commander.js
- Canvas LMS API integration (courses, assignments, submissions, grades)
- AI-powered commands via Anthropic, OpenAI, Google, and Amazon Bedrock
- PDF ingestion and generation support
- `--version` flag
- CI pipeline with typecheck, test, and build
- Automated npm publish workflow with provenance
- End-to-end smoke tests for npx installation

[Unreleased]: https://github.com/reyabsaluja/canvas-cli/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/reyabsaluja/canvas-cli/releases/tag/v0.1.0
