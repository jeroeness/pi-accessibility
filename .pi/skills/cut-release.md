---
name: cut-release
description: How to cut a new release for this fork. Push a v* tag and let the Build Binaries GitHub Actions workflow build cross-platform binaries and publish the GitHub Release. Covers picking the next tag, verifying sync, pushing, and confirming the published release with gh.
---

# Cutting a New Release

Releases in this fork are produced entirely by CI. Pushing a `v*` tag triggers
`.github/workflows/build-binaries.yml`, which builds the six platform binaries,
stages a **draft** GitHub Release with all assets, then publishes it. You do not
run `gh release create` yourself — the workflow does that. Your job is to pick
the right tag, push it, and verify the result.

## Release tag scheme

- This fork tags releases as `v<pkg-version>-vi.<N>` (e.g. `v1.2.0-vi.1`), where
  `<pkg-version>` is the version in `packages/ai/package.json` and `<N>` is a
  monotonically increasing fork release counter.
- The package versions (`packages/*/package.json`) are **not** bumped for a
  `-vi.N` release — only a new tag is created. Each `-vi.N` release just points
  at a newer commit on `main`.
- Release notes come from `scripts/release-notes.mjs extract`, which looks for a
  `## [<version>]` heading in `packages/coding-agent/CHANGELOG.md`. Since
  `1.2.0-vi.N` has no such heading, the notes fall back to `Release <version>`.
  That is expected for `-vi.N` releases.

## Steps

### 1. Understand current state

```bash
git tag --sort=-creatordate | head              # find the latest v*-vi.N tag
gh release list --limit 5                        # confirm what is already published
grep '"version"' packages/*/package.json         # current package version
```

Determine the next tag: same package version, `N` incremented by one
(e.g. latest `v1.2.0-vi.1` → next `v1.2.0-vi.2`). If the package version has
moved on since the last `-vi` tag, reset `N` to `1` under the new version.

### 2. Verify a clean, in-sync tree

The workflow checks out the tag ref, so the commit you tag must be pushed to
`origin`. Make sure the working tree is clean and `HEAD == origin/main`.

```bash
git status --short                               # must be empty
git fetch origin --quiet
git rev-list --left-right --count origin/main...HEAD   # expect "0	0"
git ls-remote --tags origin 'v*-vi.*'            # confirm the next tag is unused
```

### 3. Create and push the tag

Tag `HEAD` (the commit you want released) with an annotated tag, then push it.
The push is what triggers CI.

```bash
git tag -a v1.2.0-vi.1 -m "Release v1.2.0-vi.1" HEAD
git push origin v1.2.0-vi.1
```

Note: `origin` may redirect (the repo has been renamed). The push still
succeeds through the redirect; optionally realign with
`git remote set-url origin <current-url>`.

### 4. Watch the build

```bash
gh run list --workflow=build-binaries.yml --limit 3     # confirm the run started
gh run watch <run-id> --exit-status --interval 20       # wait for success
```

The run has five jobs: `build` → `smoke-test-binaries` → `stage-github-release` → `publish-github-release`,
with `cleanup-draft-github-release` skipped on success (it only fires to delete
the draft if staging or publishing fails). A run takes roughly 2–3 minutes.

### 5. Verify the published release

```bash
gh release view v1.2.0-vi.1 \
  --json name,tagName,isDraft,isPrerelease,url,assets \
  --jq '{name, tagName, isDraft, isPrerelease, url, assets: [.assets[].name]}'
```

Confirm `isDraft: false` and that all nine assets are present:

- `pi-darwin-arm64.tar.gz`, `pi-darwin-x64.tar.gz`
- `pi-linux-arm64.tar.gz`, `pi-linux-x64.tar.gz`
- `pi-windows-arm64.zip`, `pi-windows-x64.zip`
- `pi-coding-agent-install-package.json`, `pi-coding-agent-install-package-lock.json`
- `SHA256SUMS`

## Recovery

- **Build failed after the tag was pushed:** fix the cause, then re-run the same
  tag build via `gh workflow run build-binaries.yml -f tag=v1.2.0-vi.1`
  (`workflow_dispatch` supports an optional `source_ref` for release recovery).
  The staging job deletes and recreates the draft on re-run, but refuses to touch
  an already-**published** release.
- **Wrong tag pushed:** delete it locally and remotely
  (`git tag -d <tag>` / `git push origin :refs/tags/<tag>`), delete the draft
  release if one was created (`gh release delete <tag> --yes`), then start over.

## Notes

- `scripts/release.mjs` (`npm run release:patch|minor|major`) is the upstream
  full-release flow: it bumps package versions, rewrites changelogs, runs checks,
  commits, tags `v<x.y.z>`, and pushes. Use it only for a real version bump — for
  routine fork releases, the `-vi.N` tag-only flow above is what you want.
