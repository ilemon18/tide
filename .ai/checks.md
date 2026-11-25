---
summary: Guards, docs, CI and release
scope:
  - .ai/checks.md
  - package.json
  - pnpm-lock.yaml
  - scripts/**
  - .github/workflows/**
  - .ai/context.md
  - .ai/skills/**
  - AGENTS.md
  - CLAUDE.md
  - install.sh
  - assets/dmg-background.png
  - README.md
  - README.zh-CN.md
keywords:
  - docs
  - documentation
  - routing
  - guard
  - ci
  - release
  - verify
  - 文档
  - 路由
  - 校验
  - 检查
  - 发布
---
# Checks, docs and release

## Ownership

Package scripts define commands; scripts/ai-docs-lib.mjs owns doc metadata/routing/budgets. CI runs guards;
canonical gate procedures live in .ai/skills. Local execution remains explicitly user-triggered under AGENTS.md.

## Guard map

| Command | Protects |
|---|---|
| `node --test scripts/release-git-state.test.mjs` | Release preflight treats local tracking-ref differences and missing refs as advisory without requiring a push/fetch |
| `node --test scripts/dmg-contract.test.mjs` | Generated DMG artwork/layout agreement, missing or malformed PNGs, image/window dimensions and macOS-only Finder layout opt-in before the release build |
| `pnpm release:check` | Local Git/version, release workflows, bundle (including DMG background dimensions/layout and CI Finder opt-in) and update-manifest contracts; HEAD need not match origin/main |
| `pnpm i18n` | Six-locale keys/placeholders/plurals and emitted error coverage |
| `pnpm i18n:scan` | CJK UI literals; only explicit non-UI/IME/Unicode fixture allowlists |
| `pnpm check:workflows` | Non-ASCII text immediately after shell variable expansions |
| `pnpm test:frontend` | Configurable shortcuts (ownership transfer, explicit unbinding, recording/cancel/reserved keys, portal recording dialog/focus/navigation, platform identities, focus scopes, live hints, migration and cross-window echoes), default context-menu suppression with custom-event propagation, confirmed optimistic history deletion/rollback/write draining/stale reads/retry/page preservation, update-caption deduplication, Agent/settings, including context snapshot extraction/UTF-8 limits, same-root draft routing, attachment queue/drain/failure/history preservation, plain-text preview/removal/copy and selection-reader lifecycle, Agent history and About update preference placement, removed Agent permission settings and automatic-save defaults/migration, sidebar-width commit persistence, header-bounded floating slash/mention/skill menus, folder/empty-folder mention ranking and stale-read/selection rejection, bare-slash triggering and complete scrolling command navigation, Git file double-click/context menus with metadata filtering/action isolation, paged workspace entry reads, history drawer open/close/Escape/editor-region shrink, 15-summary paging, debounced name/ID search with IME and stale-request isolation, provider logos, last-page deletion fallback, workspace shortcut isolation, blank-tab reference replacement/draft protection and native session restore, first-prompt conversation/tab titles and truncation, empty-title fallback and live updates, stable follow-up titles and reset renaming, structured question completion-delayed options/gates and failed-launch unlock/retry with answer preservation, queued interjection ordering/recovery/edit-to-composer merge, in-place chat reset, same-tab clear-context plan execution and failed-launch retry restoration, running-Agent tab close protection across buttons, middle-click, context menus, bulk commands and shortcuts, complete local/prompt command help and slash ordering, session-only token rows, isolated live status rendering, stable HTML spinner nodes and live-reply paint policy, latest-message shortcuts/following and completion re-anchoring, Codex plan copy/action mapping/instructions order, send hints, welcome layout/composer height, permission picker labels/actions/overflow recovery, empty-pane collapse, providers and installed/uninstalled detection folding, IME, terminal, tree/watch, diffs, updates, explicit install confirmation and links |
| `pnpm typecheck` | Types, missing runtime imports/hooks and complete locale records |
| `pnpm check:rust` | Rust types/borrows without linking, including attachment DTOs |
| `pnpm docs:route` | All matching scopes; --explain reasons; --query metadata-only candidate search |
| `pnpm docs:sync` | Deterministic context route table; only its marked region is written |
| `pnpm check:docs` | Local verification gate: doc tests, metadata, path/query fixtures, budgets, index, wrappers, links and script names |

`pnpm check` runs frontend guards; `pnpm verify` adds Rust/doc checks. Outside CI follow
[verify](./skills/release-verify/SKILL.md). Agent command tests protect prompt/read-only/question guidance.
Automated tests do not establish native-account compatibility, IME ordering or native layout/scrolling;
manual surfaces require an explicit request.

Rust theme compatibility tests protect malformed shortcut fields, aliases, unknown ids and explicit unbinding.
The `pnpm test:frontend` guard also protects debounced/serial blame prefetch, shared requests, root isolation/LRU, failure retries,
typing suppression and lifecycle cancellation. Hover tests protect completed-content first paint and measured
positioning, empty/error results, stale-response rejection, close/scroll behavior and memory reclamation.
History-page tests use real symbol lifetimes and protect search reset when the same root is reopened.
Frontend regressions also cover named task controls and shortcut migration to the current settings schema.
`pnpm test:frontend` also covers blank loaded/filtered-empty file trees, reading/collapsed hints, and Agent
following through shrink/regrowth scroll events, first-send and queued-card resizing, plus scrollbar pause/send resume.
Deferred streamed Markdown code/table commits also retain bottom following without another store update or
resize notification, while formatting after an upward reading gesture preserves the reading position.
Agent frontend regressions also protect atomic draft consumption before first-send layout, save/launch
failure recovery without overwriting edits/queues/reset chats, persisted reply provider attribution and
provider-named output folds, plus localized user labels excluded from copies.

Rust agent tests also protect context root/path/range/byte validation and quoted snapshot prompt round trips.
Rust history tests cover 0/15/16/30/31-entry page boundaries/totals, project-scoped title/ID search before paging, Unicode/literal matching and exclusion of message bodies.
Rust transcript deletion tests cover project ownership, idempotent removal and preservation of corrupt records.

## Documentation contract

- Top-level .ai Markdown (except context) has one-line summary, nonempty scope globs and short English/
  Chinese keywords in block lists. Scope is repository-relative POSIX and each glob must match real files.
  Shared files may route several docs. Each area doc also scopes itself, so maintenance loads its contract.
- Scope is authoritative. Query normalizes case/Unicode/whitespace, matches Latin words and CJK phrases,
  scores keyword hits above summary words, and breaks ties by filename. Output is candidate advice; locate
  code and confirm paths. Queries never search bodies or silently load all docs. Paths never drop matches
  to meet a budget. Use -- before dash-prefixed filenames; do not combine paths and --query.
- docs:sync generates the context table from metadata; never hand-edit that region. check:docs rejects stale
  tables, invalid metadata, unmatched globs, missing paths/links/scripts and inaccurate fixture doc sets.
  Repeated long prose produces advisory warnings, never automatic deletion.
- Hard limits: context ≤2KB, AGENTS + context ≤4KB, fixture bundle ≤24KB. Bundle includes resident context
  and all routed docs. Target ≤16KB; warn above 6KB/document and 36KB .ai Markdown. Prefer deduplication
  before splitting; split only where independent scopes reduce reads. Token counts are rough bytes/4;
  metadata reads retain the separate 16KB cap. Routing output reports resident/docs/total separately.
- Skill wrappers require directory-matching name, description and a canonical .ai/skills link. CLAUDE.md
  imports AGENTS.md; .agents/skills links .claude/skills, deduplicated by real path. Preserve existing gate
  names, trigger restrictions and release behavior when editing documentation.

## Change map and verification

macOS DMG layout is owned by `src-tauri/tauri.conf.json`; regenerate its committed artwork with
`node scripts/make-dmg-background.mjs` after changing dimensions or icon positions. The generator draws
only the arrow/waves; Tauri supplies the native app and `/Applications` drop link. `scripts/dmg-contract.mjs`
owns the shared layout/resource/workflow checks used by release preflight. CI and release prerequisites
run its regression tests without Finder or packaging. The release build opts into Finder automation only
on macOS and propagates layout failures before collecting artifacts. READMEs describe DMG installation first.

Tasks and Problems changes require frontend tests for task discovery, execution state, output parsing, path
filtering, custom cwd, aggregate diagnostics, settings migration, Problem navigation, early events, failed
launch/stop retries, stale discovery and bounded history/output. Rust tests cover command discovery, bounded
config validation, split UTF-8, process/group cleanup, ownership and workspace/symlink containment. Resource
ceilings are owned by src/lib/memoryBudget.ts and src-tauri/src/commands/tasks.rs.

Keep metadata parser, route/sync, guard and tests aligned; scope/index changes update fixtures and regenerated
context together. Guard changes also update this map and [verify](./skills/release-verify/SKILL.md).
Keep tests beside owners. Run targeted tests through the requested gate when test code or update/path/
settings/Git/provider behavior changes; installer work belongs to [release-check](./skills/release-check/SKILL.md).
Never weaken/delete a guard or test to pass.

CI runs frontend guards/tests/build and Rust tests on supported platforms.
The tag-driven release workflow remains separate and does not replace release-check.
