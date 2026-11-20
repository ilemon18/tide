---
name: release-check
description: Run Tide's release preflight only when the user explicitly asks for a release check / 发布前检查 / 打包前检查 / preflight. Checks local git and version state, release and CI workflow wiring, Tauri bundle configuration and the update manifest, then runs the verification gate, frontend build and Rust tests. Fixes local failures but never commits, tags, pushes or publishes; its static check does not query GitHub.
---

# Tide release preflight

Use only when the user explicitly asks for a release check, and never commit, tag, push, publish or create a
GitHub release — a release-check request is not permission for those. Run commands one at a time.

## Before you start

- The target version is X.Y.Z, optionally with a prerelease suffix and an optional leading `v`. If the user
  did not name one, derive it from the highest local semver `v*` tag by incrementing the patch (`v1.2.3` →
  `1.2.4`); use `0.0.1` when no local semver tag exists. Announce the derived version and never infer it from
  package metadata.
- Start from a clean working tree, otherwise ask the user to commit or stash first. The static check uses no
  network, so if tags may be stale ask the user to run `git fetch --tags`.

## Gate

Run from the repository root: `pnpm release:check [version]` (static release checks including `install.sh`
syntax, with `--allow-dirty` once fixes dirty the tree), `pnpm install --frozen-lockfile`, then follow
[the verification gate](../release-verify/SKILL.md) — running any check `pnpm verify` skipped before it
stopped — then `pnpm build`, then `cargo test --manifest-path src-tauri/Cargo.toml`.

Fix release blockers at the root; do not refactor unrelated code or weaken guards. After fixes, rerun the
failed step and then the full sequence, keeping `--allow-dirty` while the tree stays dirty: the final
clean-tree static check happens after the user commits.

## Optional deep packaging

Ask before building an installer — it is slow and only covers the current OS. Use `pnpm app:build` for the
current platform, expect exactly one artifact in the bundle directory, and treat it as a disposable packaging
check built with the version in `tauri.conf.json`, never as a release file.

## Fix, stop or report

Fix local code, config, scripts and docs directly, and stop when the issue is outside the working tree: the
tag already exists or the version is not newer than the latest local tag; the tree is dirty or HEAD is not on
`origin/main` (except a post-fix `--allow-dirty` run); signing secrets, runner capacity or remote tag state
are unavailable. Never delete tags, rewrite history or publish; if the version is already tagged, ask for a
new one.

Report each check, what was fixed, remaining blockers and residual risks, plus the commands the user still
has to run, without executing them:

    git add ...
    git commit ...
    git tag v<version>
    git push origin main
    git push origin v<version>

Remote tags, releases and CI runs were not queried by design.
