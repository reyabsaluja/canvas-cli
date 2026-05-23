# Releasing

This document describes the versioning strategy and release process for canvas-cli.

## Versioning Strategy

canvas-cli follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html):

- **Patch** (`0.1.x`): Bug fixes, dependency updates, documentation corrections
- **Minor** (`0.x.0`): New commands, new flags, new provider integrations, non-breaking behavioral changes
- **Major** (`x.0.0`): Removal of commands/flags, breaking changes to config format, breaking changes to CLI output relied upon by scripts

### Pre-1.0 Stability

While in the `0.x` range, minor versions may include breaking changes. The stability bar for 1.0 is:

1. Core commands (`courses`, `assignments`, `grades`, `submit`) are stable
2. Configuration format (`.env` + `~/.canvas-cli/`) is finalized
3. At least one full academic term of real-world usage without major regressions
4. No open issues tagged `breaking` or `pre-launch`

### Pre-release Tags

Use pre-release tags when changes need broader testing before a stable release:

- `x.y.z-beta.N` — feature-complete but not yet validated in production
- `x.y.z-rc.N` — release candidate, only critical fixes before stable

Example: `npm version 0.2.0-beta.1`

> **Note:** Pre-release tags (e.g., `v0.2.0-beta.1`) also trigger the publish workflow and will be published to npm with the `next` dist-tag. Install with `npx @reyabsaluja/canvas-cli@next`.

## Release Process

### 1. Prepare the release

```bash
# Ensure you're on main with a clean tree
git checkout main
git pull origin main
git status  # must be clean

# Run the full quality gate
bun run check
```

### 2. Update the changelog

Move items from `[Unreleased]` into a new version section:

```markdown
## [Unreleased]

## [0.2.0] - 2025-03-15

### Added
- ...

### Fixed
- ...
```

Update the comparison links at the bottom of CHANGELOG.md:

```markdown
[Unreleased]: https://github.com/reyabsaluja/canvas-cli/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/reyabsaluja/canvas-cli/compare/v0.1.0...v0.2.0
```

### 3. Bump the version and tag

```bash
npm version patch|minor|major  # or: npm version 0.2.0-beta.1
```

This updates `package.json`, creates a git commit, and creates a `vX.Y.Z` tag.

### 4. Push

The `postversion` script in package.json handles this automatically (`git push origin HEAD --follow-tags`). If you prefer to push manually, run:

```bash
git push origin HEAD --follow-tags
```

### 5. Automated publishing

Pushing the tag triggers `.github/workflows/publish.yml`, which:

1. Runs the full CI pipeline (typecheck, test, build, audit)
2. Publishes to npm with provenance
3. Creates a GitHub Release with auto-generated notes

### 6. Verify

- Check the [GitHub Actions](https://github.com/reyabsaluja/canvas-cli/actions) run
- Verify the package on [npm](https://www.npmjs.com/package/@reyabsaluja/canvas-cli)
- Test installation: `npx @reyabsaluja/canvas-cli@latest --version`

## Release Checklist

Before cutting any release, ensure:

- [ ] `bun run check` passes (typecheck + test + build)
- [ ] No open issues tagged `release-blocker`
- [ ] CHANGELOG.md is updated with all notable changes
- [ ] Breaking changes (if any) are documented with migration steps
- [ ] README.md reflects any new commands or changed behavior
- [ ] Smoke tests pass in CI on the latest main

## Releases and Distribution

- **npm**: Primary distribution channel. Published automatically on tag push.
- **GitHub Releases**: Created automatically with generated release notes. Use these for changelogs visible to GitHub watchers.
- **Tags**: Every release has a corresponding `vX.Y.Z` git tag. Tags are the source of truth for what's released.

## Hotfix Process

For urgent fixes to the latest release:

```bash
git checkout main
# make the fix
bun run check
npm version patch
git push origin main --follow-tags
```

If a fix is needed for an older release, create a branch from that tag:

```bash
git checkout -b hotfix/v0.1.1 v0.1.0
# make the fix, then follow the normal release process on that branch
```
