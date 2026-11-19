---
name: release-check
description: Run Tide's release preflight only when the user explicitly asks for a release check / 发布前检查 / 打包前检查 / preflight. Checks local git and version state, release and CI workflow wiring, Tauri bundle configuration and the update manifest, then runs the verification gate, frontend build and Rust tests. Fixes local failures but never commits, tags, pushes or publishes; its static check does not query GitHub.
---

# Tide release preflight

Use only when the user explicitly asks for a release check.

## Before you start

- Know the target version: X.Y.Z, optionally with a prerelease suffix. A leading `v` is fine. If the user
  did not name one, ask; do not guess.
- Start from a clean working tree. If it is dirty, ask the user to commit or stash first.
- The static check does not use the network. If tags may be stale, ask the user to run `git fetch --tags`.
- Never commit, tag, push, publish or create a GitHub release; a general release-check request is not
  permission for those operations.
- Run commands one at a time.

## Gate

Run from the repository root.

1. `pnpm release:check <version>` — static release checks, including `install.sh` syntax and release upload.
   If fixes make the tree dirty, rerun with `--allow-dirty`.
2. `pnpm install --frozen-lockfile`
3. Follow [the verification gate](../release-verify/SKILL.md). If `pnpm verify` stops early, run the
   remaining verify commands individually.
4. `pnpm build`
5. `cargo test --manifest-path src-tauri/Cargo.toml`

Fix release blockers at the root; do not refactor unrelated code or weaken guards. After fixes, rerun the
failed step and then the full sequence. If the tree remains dirty, keep using `--allow-dirty`; the final
clean-tree static check happens after the user commits.

## Optional deep packaging

Ask before building an installer. It takes a long time and only covers the current OS.

- macOS: `pnpm tauri build --target universal-apple-darwin --bundles dmg`
- Windows: `pnpm tauri build --target x86_64-pc-windows-msvc --bundles nsis`
- Other OS: refuse; the release workflow builds on macOS and Windows.

The expected bundle directory must contain exactly one artifact:

- macOS: `src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg`
- Windows: `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe`

The build uses the version currently in `tauri.conf.json`. The artifact is a disposable packaging check,
not a release file.

## Fix or stop

Fix local code, config, scripts and docs directly. Stop and report when the issue is outside the working
tree:

- the local tag already exists, or the target version is not newer than the latest local tag;
- the working tree is dirty or HEAD is not on `origin/main`, except for a post-fix `--allow-dirty` run;
- signing or notarization secrets, GitHub runner capacity, or remote release/tag state are unavailable.

Do not delete tags, rewrite history, commit, push or publish. If the target version is already tagged, ask
for a new version.

## Report

Report each check, what was fixed, remaining blockers and residual risks. Include the commands the user
still needs to run, without executing them:

    git add ...
    git commit ...
    git tag v<version>
    git push origin main
    git push origin v<version>

Remote tags, releases and CI runs were not queried by design; the user should watch Actions after pushing
the tag.
