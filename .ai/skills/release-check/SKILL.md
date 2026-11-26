---
name: release-check
description: Run Tide's release preflight only when the user explicitly asks for a release check / 发布前检查 / 打包前检查. Checks local Git/version state, workflows, Tauri bundle and update manifest, then runs verification, build and Rust tests. Fixes local failures but never commits, tags, pushes or publishes.
---

# Tide release preflight

Use only when the user explicitly asks for a release check. Never commit, tag, push, publish or create a
release; pushing is not a prerequisite. Run commands one at a time.

## Before you start

- Target version is X.Y.Z with an optional prerelease suffix and optional leading `v`. If unnamed, derive it
  from the highest local semver `v*` tag by incrementing the patch; use `0.0.1` when none exists. Announce
  the derived version and never infer it from package metadata.
- Start from a clean tree; otherwise ask the user to commit or stash. Identify the highest local semver tag
  and review its complete range through `HEAD` with `git log <previous-tag>..HEAD`. `HEAD` need not match
  `origin/main`. Without a tag, review local history. The static check uses no network; if tags may be stale,
  ask the user to run `git fetch --tags`.

## Gate

From the repository root: `node --test scripts/release-git-state.test.mjs`, then
`pnpm release:check [version]` (static release checks including `install.sh` syntax; use `--allow-dirty` once
fixes dirty the tree), then `pnpm install --frozen-lockfile`, then the
[verification gate](../release-verify/SKILL.md) — running any check `pnpm verify` skipped before it stopped —
then `pnpm build`, then `cargo test --manifest-path src-tauri/Cargo.toml`.

Fix blockers at the root; do not refactor unrelated code or weaken guards. Rerun the failed step and the full
sequence, keeping `--allow-dirty` while the tree stays dirty; the final clean-tree static check happens after
the user commits.

## Optional deep packaging

Ask before building an installer. Use `pnpm app:build` for the current platform, expect exactly one artifact
in the bundle directory, and treat it as a disposable packaging check built with the version in
`tauri.conf.json`, never as a release file.

## Fix, stop or report

Fix code, config, scripts and docs directly. Stop when the issue is outside the working tree: the tag exists
or the version is not newer than the latest tag; the tree is dirty (except a post-fix `--allow-dirty` run);
signing secrets, runner capacity or remote tag state are unavailable. Never delete tags, rewrite history or
publish; ask for a new version if the current one is tagged. Do not require a push to complete this local
preflight.

Report each check, fixes, remaining blockers and residual risks, plus commands the user still has to run:

    git add ...
    git commit ...
    git tag v<version>

Pushing the commit or tag is a separate decision. Remote tags, releases and CI runs were not queried.
