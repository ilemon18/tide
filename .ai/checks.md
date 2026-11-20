---
summary: Scripts, guards, tests, CI, release and verification
scope:
  - package.json
  - pnpm-lock.yaml
  - scripts/**
  - .github/workflows/**
  - .ai/checks.md
  - .ai/context.md
  - .ai/skills/**
  - AGENTS.md
  - CLAUDE.md
  - install.sh
---
# Checks, tests and release wiring

## Guard map

| Command | Protects |
|---|---|
| `pnpm i18n` | Locale key/placeholder/plural parity and error-code coverage |
| `pnpm i18n:scan` | Hardcoded CJK UI literals; named IME/Unicode test-data files and other non-UI files are explicitly allowlisted |
| `pnpm check:workflows` | Workflow shell expansions followed by non-ASCII text after `$var` |
| `pnpm test:frontend` | Vitest/React Testing Library: local commands, context usage, composer chips, plan completion/actions, persistent Plan/permissions, isolated plan handoff, compact/fork, usage replacement, bounded history, stream flushing, IME send/completion priority, ordered tool previews, native permission decisions, completion persistence, terminal maximize geometry/resident PTYs, tree/watch races, diff scrolling and restoration, provider tab icons and grouped branch search |
| `pnpm typecheck` | TypeScript types, missing runtime imports (including root React hooks), and complete typed locale records |
| `pnpm check:rust` | Rust types/borrows without linking |
| `pnpm docs:route` | Select only area docs whose scope matches the supplied touched paths |
| `pnpm docs:sync` | Regenerate the route table in `context.md` from area-doc frontmatter; never hand-edit the generated region |
| `pnpm check:docs` | AI-doc tests, metadata, route precision/budgets, skill metadata, plus paths, relative links and `pnpm` script names in docs and wrappers |

Agent transcript/terminal native behavior is a manual review surface (only when explicitly requested):
IME event order, incremental Markdown, bottom-only following, tool expansion, one activity/elapsed label
at each turn's tail, completion duration after reopening, and terminal maximize/drag/restore feel.
Component/store tests cover order, geometry and persistence; real-account stdio approval compatibility
requires native validation. These tests do not establish native visual appearance or actual account support.
UI copy density is also a manual review surface: text-only plan action buttons without icons, explicit action labels, no repeated plan descriptions
or pending-action banners, accessible question inputs, and contextual settings/send tooltips.

`pnpm check` is the frontend guard set and `pnpm verify` adds Rust and doc checks; outside CI only
[the verification skill](./skills/release-verify/SKILL.md) runs them.

## AI docs

Area docs declare a one-line `summary` and a block-list `scope` of repository-relative POSIX globs in
frontmatter. `pnpm docs:sync` rewrites only the marked route region in `context.md`; `pnpm check:docs` rejects
missing/empty metadata, invalid or unmatched globs, stale/hand-edited routing, and every area doc missing from
the generated table. Repeated hits are valid for cross-domain work, but routing fixtures must resolve exactly
their expected doc set.

Wrappers must have frontmatter whose `name` matches their directory and a non-empty `description`, and must
link to the canonical `.ai/skills/**/SKILL.md`; `CLAUDE.md` must import `AGENTS.md`. `.agents/skills` symlinks
`.claude/skills`, which the guard deduplicates by real path.

Hard limits are `context.md` <=2KB, `AGENTS.md` + `context.md` <=4KB, and each fixture bundle <=16KB. Other
docs warn above 6KB and `.ai` Markdown above 36KB. When over budget, delete duplication before splitting.
Path, guard or behavior-contract changes update their routed docs in the same change.

## Tests and CI

- `src/App.test.tsx` in `pnpm test:frontend` renders the real root's startup frame before effects to catch
  render-time failures that would prevent session restoration and its reveal timeout. It does not cover
  native startup; debug packaging uses Vite transpilation and does not itself run the typecheck guard.
- Diff tests cover latest scroll input, clamped echoes, independent axes, overview jumps, first-change
  positioning, refresh restoration, folding and cancellation on tab switch/unmount. Native scrolling
  smoothness still needs an explicitly requested app review; jsdom does not model layout or compositing.
- Frontend tests cover Plan persistence/actions/retries/queue guards, local command selectors, compact
  success/failure, session usage, 160-record/1 MiB windows, stream ordering, footer/status placement and
  usage popup keyboard interaction; tree/watch tests cover transition batches and stale directory reads.
  Plan execution tests cover all permission modes and legacy missing values; failed read-only question
  follow-ups preserve the session's permission choice. Branch-menu tests use jsdom and ensure an old
  current branch stays pinned within the local group's ten-row limit.
- `src/components/AgentTurnStatus.test.tsx` covers local 24-hour `HH:mm` completion times after duration,
  zero padding, saved times after reopening, omission during runs or without a valid saved timestamp, and
  the running indicator's dedicated spinner class; visual smoothness remains a manual app review surface.
- Provider/transport tests cover app-server initialization and native thread operations, streamed Unicode
  text/thinking/tool input/output, final snapshots, three permission mappings, read-only override,
  allow/deny, duplicate requests and stop invalidation. Native failures stay explicit; no exec fallback.
  Request fixtures include required `permissionMode`; tests reject its omission and enforce read-only overrides.
- Rust watcher tests cover truncation, overflow, continuous event deadlines, rescan/errors and Git-only locks;
  provider capability tests reject missing native fork/app-server entry points. Real-account protocol behavior is not
  established by these tests.
- Agent store tests cover exclusive cursors, byte budgets, unknown fields, concurrent patches, preserving
  files after failed writes, and stable chat tab titles during runs and after completion/cancellation/failure.
- Run targeted Rust tests through the verification skill when test code changed, or when the change touches
  update, path containment, settings migration, Git commands or agent providers; installer changes belong to
  the release-check surface. Keep unit tests beside the owning Rust module.
- Update tests must keep startup/manual cache freshness unchanged, prove forced checks bypass a fresh cache
  and forbid cached fallback, and assert forced lookup requests carry `Cache-Control: no-cache`.
- Never weaken or delete a guard or test to make a check pass. If a guard is wrong, change the script, this
  map and the owning skill in one edit.
- `.github/workflows/ci.yml` runs frontend guard/build jobs and Rust test jobs on supported platforms, with
  platform prerequisites and generated-icon assertions kept in workflow configuration.
  `.github/workflows/release.yml` is tag-driven: set the version, run frontend guards, build macOS and Windows
  bundles, generate the update manifest and upload installer assets. It does not replace
  [the release-check skill](./skills/release-check/SKILL.md).
- An omitted release-check version defaults to the highest local semver `v*` tag plus one patch (`v1.2.3` →
  `1.2.4`, or `0.0.1` with no tags); an explicit version always overrides it. The static check remains
  network-free.
