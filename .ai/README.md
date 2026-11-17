# AI Docs

Smallest useful context for an agent. Human docs: [../README.md](../README.md).

## What to read

- **Every session** — [`context.md`](./context.md): file map, hard rules, architecture, common changes, pointers.
- **Changing copy / adding a language** — [`i18n.md`](./i18n.md): catalog layout, plurals, placeholders, error codes.
- **Touching the editor, file tree, Git/diff, window or settings** — [`traps.md`](./traps.md): the mistakes that already cost a session.
- **Before packaging / releasing, or when the user asks to verify** — load [`.ai/skills/verify/SKILL.md`](./skills/verify/SKILL.md); it runs the gate in [`checks.md`](./checks.md), fixes failures and reruns.
- **While coding** — write code, docs and tests only. Do not run i18n, workflow, typecheck, Rust, doc or test checks; leave execution to the verify skill or CI.
- **On demand** — Rust commands in `src-tauri/src/commands/`, the editor in `src/editor/`, UI in `src/components/`.
- **Don't** read the whole source tree, the README or `node_modules` at session start.
- **Don't build unless asked.** No `pnpm app:build` / `app:build:win` / `app:release` / `tauri build`, debug
  bundles included, unless the user asked for a build. `pnpm verify` is a check, not a build.

## Maintaining these files

- New module / architectural change / new trap → update the matching section of `context.md` (or `traps.md` for traps).
- New guard script or a changed check step → update `checks.md` and the verify skill.
- Changing the coding or verification policy → update `AGENTS.md`, `CLAUDE.md` and `checks.md` together.
- New locale or a change to copy conventions → update `i18n.md`.
- Paths and rules only: no code copies, no line numbers (they rot).
- `context.md` stays ≤10KB, every other file ≤8KB. Over budget means split the file, not grow it.
- `pnpm check:docs` verifies every path and every `pnpm <script>` named here, so renaming a module means updating the docs in the same change.

---
**Last updated**: 2026-11-17
