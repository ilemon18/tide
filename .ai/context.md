# Tide — AI Context

> Agent entry point. Human docs [../README.md](../README.md); checks & packaging [checks.md](./checks.md);
> copy/locales [i18n.md](./i18n.md); traps by area [traps.md](./traps.md) — read that before touching the
> editor, tree, Git, windows or settings. Paths + rules only; <10KB.

## Project

macOS / Windows editor: Tauri 2 + Rust, React 19 + TS + Vite 8 + Tailwind 4, CodeMirror 6,
xterm.js + portable-pty, zustand 5. 21 themes + `system`; 6 locales, English source.

Low memory/startup are deliberate; see ceilings.

## File map

| Changing | Where |
|---|---|
| Layout, shortcuts, session restore, drag & drop, startup | `src/App.tsx`, `src/main.tsx`, `src/lib/keys.ts` (IME-safe), `fileDragState.ts` + `groupDrop.ts` |
| UI components, settings sections | `src/components/` (only `EditorView` is `EditorHost.tsx`), `lib/settingsSections.ts` |
| Diff view, conflicts, syntax colours | `src/components/DiffView.tsx`, `diffHighlight.ts`, `lib/conflictFiles.ts`, `src/theme/syntax.ts` |
| CodeMirror | `src/editor/`: setup, stateCache, stateKeys, viewRef, openState, mirror, folding, languages, largeFile, indentGuides, blame, conflicts, highlight, importLinks, scrollMemory, signals, locale, outline |
| State slices (14) | `src/store/`: workspace, tabs, git, search, terminal, settings, ui, blame, watcher, fileIndex, commitHover, folderChain, update, agent |
| Folder chain compaction | `src/store/folderChain.ts`, `resolve_dir_chain` in `src-tauri/src/commands/fs.rs`, `buildRows` in `FileTree.tsx` |
| Built-in agent | Chat UI `src/components/Agent*.tsx`, state `src/store/agent.ts`, Rust `src-tauri/src/agent/` — [agent.md](./agent.md) |
| IPC + DTO types | `src/lib/ipc.ts` (**only** `invoke` wrapper) |
| Flows, palette, tab titles, untitled, memory | `src/lib/`: actions, commands, tabTitle, untitledDrafts, memory, memoryBudget, layoutBus |
| Text format, session restore | `src/lib/textMeta.ts`, `editorSession.ts`, backend `save_open_tabs` |
| Formatting | `src/lib/formatting.ts`, `src/lib/formatters.ts`, `src/lib/prettier.ts` + `src/vendor/prettier/`, `src-tauri/src/commands/format.rs` |
| In-app update | `src-tauri/src/update.rs`, `src/lib/update.ts`, `updateView.ts`, `src/store/update.ts`, `UpdateBadge.tsx` |
| Copy & locales | `src/i18n/` (English bundled, others on demand), `src-tauri/src/i18n.rs` (Dock / tray) — [i18n.md](./i18n.md) |
| Themes (21 + `system`), style tokens | `src/theme/`: palettes, apply, cmTheme, xtermTheme, syntax; `src/styles/index.css`, `public/theme-boot.js` |
| Rust entry, windows, single instance | `src-tauri/src/main.rs` |
| Workspace grants, PTY / watcher tables | `src-tauri/src/state.rs` |
| Commands, paths, subprocess, Dock, watcher, errors | `src-tauri/src/commands/{fs,format,git,blame,search,terminal,theme}.rs`, `paths.rs` `proc.rs` `dock_menu.rs` `watcher.rs` `error.rs` |
| Scripts | `scripts/`: guards + `release-check` ([checks.md](./checks.md)), build/manifest helpers, `test-install.sh` |
| Artifacts (ignored) | `release/*` (README tracked), `dist/`, `website/` |

## Hard rules

### Frontend
- **IPC only through `api.*`** (`lib/ipc.ts`). No direct `invoke` in components or slices.
- **Subscribe with a selector** (`useTabs(s => s.activeId)`), never `useTabs()` as a whole.
- **One `EditorView` per panel** (1, or 2 after split). Per-tab `EditorState` lives in `editor/stateCache.ts` and swaps via `view.setState`; `mirror.ts` forwards split-pane ChangeSets. **Never** hold views/states in zustand or share a state between views.
- **Theme, font size, blame, word wrap use `Compartment.reconfigure`** (a rebuilt state drops undo history).
- **No hex colours**: use the `--c-*` tokens (`bg-bg`, `text-fg`, `border-line`, `bg-panel`).
- **UI copy only through `t()` / `tp()`**, no literals (`pnpm i18n:scan` enforces it); Chinese comments are fine.
- Fixed event names: `pty:data` `pty:exit` `agent:event` `fs:changed` `settings:changed` `session:recent-changed` `update:progress` `update:flush` `app:hidden` `app:shown` `app:open-file`.

### Rust
- **Paths travel as `(root, rel)`**, `rel` relative to the workspace root; the frontend never sends absolute paths.
- **Every file command calls `state.authorize(root)` first**, then `resolve_in_root` + `assert_inside` (canonicalise + prefix check, rejects `..` and symlink escapes).
- **Writes go to a temp file + `rename`**, never in place.
- **All errors are `AppResult<T>`**: `AppError::c` / `AppError::p` for translatable copy, `AppError::new` only for external tool output. No `unwrap()` on user input.
- **DTOs use `#[serde(rename_all = "camelCase")]`** and match `src/lib/ipc.ts` one to one.
- **Git is a subprocess** (`git -C <root>`) with `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, editors and pager disabled, `LC_ALL=C`, stdin closed; 180s network timeout.
- **PTY lifetime is entirely in Rust** (`state.ptys`); the frontend only sends input / resize / close. Agent CLIs are owned the same way (`state.agent_turns`, one turn per chat), and their prompt travels over stdin.

### Updates & window scope
- Updates check/download/install in Rust (`update.rs`); the webview only drives the state machine.
- Only HTTPS GitHub URLs; byte count and `latest.json` SHA-256 must match; nothing runs before a click. Generated `latest.json` never enters the repo.
- macOS curl install (`install.sh`): latest stable manifest, DMG URL/size/SHA-256 and app version checks, then replace under `~/Applications`; no sudo. Windows remains `.exe` only.
- One window owns **one** project; several projects means several windows (`main` + `win-<pid>-<seq>`, project via `?open=<path>`). Only the main window persists the session (`IS_PRIMARY_WINDOW`).

## Common changes

### Add a backend command
Implement in `commands/<domain>.rs`, register in `main.rs`, type it in `lib/ipc.ts`, and
consume through a store/action. Add palette entries in `lib/commands.ts` and errors to all catalogs.

### Add a setting
Four places: `Settings` in `src/lib/ipc.ts`; `DEFAULT_SETTINGS` + `SHARED_KEYS` in `src/store/settings.ts`; `Settings` + migration in `src-tauri/src/commands/theme.rs`; `SettingsView.tsx`. `schemaVersion` is 9.

### Add an editor extension
Implement in `src/editor/`; always-on ones go into `setup.ts`, toggleable ones become a `Compartment` in `stateCache.ts` so switching only reconfigures.

### Add a theme
Five places: `palettes.ts` (`ui` / `syntax` / `terminal` + `CYCLE_ORDER`), `apply.ts`, `cmTheme.ts`, `xtermTheme.ts`, `ThemeMenu.tsx`; syntax colours live only in `syntax`.

### Generated, do not hand-edit
- `src/assets/fileIcons.generated.ts` ← `scripts/build-file-icons.mjs`
- `src/vendor/prettier/` ← vendored standalone Prettier build
- `src-tauri/icons/`, `src-tauri/gen/` ← `pnpm icon` / tauri

## Performance ceilings

| Area | Limit |
|---|---|
| Memory profile | `src/lib/memoryBudget.ts` owns every memory limit; lightweight mode (`settings.lightweightMode`, off by default) sets it to `light`. Read `budget.*` / `feature.*` at use time, never copy numbers |
| EditorState / large files | LRU ≤8 states (≤2 heavy), ≤2M chars resident, eviction skips active/dirty tabs; >1MB no wrapping, >5MB read-only, >20MB refused. Light: 3 / 1 / 600k, 512KB / 2MB |
| File tree | 200 entries per page, 20k scanned per directory, 30 cached dirs per root, ±10 row overscan; chain resolve for visible rows only, depth 16, concurrency 4 |
| Quick open / search | one sorted `string[]` (binary search), built on first ⌘P; ≤50k entries (10k light), 5 min TTL; ≤2MB/file, ≤500 hits (200 light), 250ms debounce |
| Blame / formatting | blame: current file only, 200ms debounce, 2MB / 5000 lines, 24-entry cache (off in light). Formatting: nothing above 500k chars, bundled Prettier on demand |
| Text meta / restore | format probe ≤400 lines (first 200 chars each); restore ≤12 files (4 light), ≤2MB each, active file last so the LRU keeps it (session ≤20 tabs, 20 closed) |
| Tabs | Memoized tab items; cached layout from ResizeObserver box sizes; width/viewport/layout changes commit once; no per-node layout reads |
| Terminal | Per-terminal queues; rAF ≤128KB/frame; hidden/occluded views pause `term.write` and keep a 128KB tail, replaying on show; 80ms fallback; scrollback 2000 (1000 light); WebGL off by default; xterm instances stay alive |
| Agent chats | one CLI/turn (max 4), transcript ≤300 messages / 2MB before atomic write, tool output 8KB, stderr 200 lines; only open chats stay in memory |
| Git / memory | Fixed 28px rows, ±10 overscan, repo-local status and active path/id subscriptions; actions after hover/focus; one `status --porcelain=v2 -z`, 350ms debounce, branch TTL 30s, no setState when unchanged; caches drop after 30s unfocused (5s light); `app:hidden` drops inactive EditorStates, search results and the ⌘P index |

## Data & config

- Agent transcripts live in `<config>/agent/chats/<id>.json`, open chat tabs in `<config>/agent/tabs.json` (primary window only).
- `settings.json` / `session.json` live in `app_config_dir()` (macOS `~/Library/Application Support/com.aitify.tide/`), read/written under a lock by `commands/theme.rs`.
- Defaults and migration: see [traps.md](./traps.md), Config & settings.
- Workspace roots are refcounted in `state.rs`; zero reaps PTYs and watchers. First paint uses `public/theme-boot.js` (CSP forbids inline scripts).

## Maintaining docs

- Update the relevant area doc when a module, path or behavior changes; keep paths and rules,
  not copied code or line numbers. Keep this entry under 10KB and other area docs under 8KB.
- Update [checks.md](./checks.md) and the relevant skill when a guard or check step changes.
  Coding-policy changes must stay aligned with `AGENTS.md` and `CLAUDE.md`.
- Remove obsolete designs and their references when retiring a feature. Keep one source of truth
  for each topic; tool-specific skill entries only point to the canonical skill.

---
**Last updated**: 2026-11-19
