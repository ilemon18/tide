# Tide — AI Context

> Agent entry point. Human docs [../README.md](../README.md); checks & packaging [checks.md](./checks.md);
> copy/locales [i18n.md](./i18n.md); traps by area [traps.md](./traps.md) — read that before touching the
> editor, tree, Git, windows or settings. Paths + rules only; keep this file under 10KB.

## Project

Tide: lightweight macOS / Windows code editor. Tauri 2 + Rust; React 19 +
TS + Vite 8 + Tailwind 4; CodeMirror 6; xterm.js + portable-pty; zustand 5; 21 themes + `system`; 6 locales (English
is the source).

**Low memory and low startup cost** are deliberate; see the ceilings below.

## File map

| Changing | Where |
|---|---|
| Layout, shortcuts, session restore, drag & drop, startup | `src/App.tsx`, `src/main.tsx`, `src/lib/keys.ts` (IME-safe key normalisation), `fileDragState.ts` + `groupDrop.ts` |
| UI components, settings sections | `src/components/` (only `EditorView` is `EditorHost.tsx`), `lib/settingsSections.ts` |
| Diff view, conflicts, syntax colours | `src/components/DiffView.tsx`, `diffHighlight.ts`, `lib/conflictFiles.ts`, `src/theme/syntax.ts` |
| CodeMirror | `src/editor/`: `setup` `stateCache` `stateKeys` `viewRef` `openState` `mirror` `folding` `languages` `largeFile` `indentGuides` `blame` `conflicts` `highlight` `importLinks` `scrollMemory` `signals` `locale` `outline` |
| State slices (14) | `src/store/`: `workspace` `tabs` `git` `search` `terminal` `settings` `ui` `blame` `watcher` `fileIndex` `commitHover` `folderChain` `update` `agent` |
| Folder chain compaction | `src/store/folderChain.ts`, `resolve_dir_chain` in `src-tauri/src/commands/fs.rs`, `buildRows` in `FileTree.tsx` |
| Built-in agent (chat tabs, local CLI turns) | `src/components/AgentChat.tsx`, `AgentComposer.tsx`, `AgentMessage.tsx`, `AgentMarkdown.tsx`, `AgentPickers.tsx`, `src/store/agent.ts`, `src/lib/agentSession.ts`, `src/lib/agentEvents.ts`, `src/lib/agentBridge.ts`, `src-tauri/src/commands/agent.rs`, `src-tauri/src/agent/{mod,providers,claude,codex,store}.rs` — [agent.md](./agent.md) |
| IPC + DTO types | `src/lib/ipc.ts` (**only** `invoke` wrapper) |
| Flows, palette entries, tab titles, untitled buffers, memory | `src/lib/actions.ts`, `commands.ts`, `tabTitle.ts`, `untitledDrafts.ts`, `memory.ts`, `memoryBudget.ts`, `layoutBus.ts` |
| Text format, session restore | `src/lib/textMeta.ts`, `editorSession.ts`, backend `save_open_tabs` |
| Formatting | `src/lib/formatting.ts`, `src/lib/formatters.ts`, `src/lib/prettier.ts` + `src/vendor/prettier/`, `src-tauri/src/commands/format.rs` |
| In-app update | `src-tauri/src/update.rs`, `src/lib/update.ts`, `updateView.ts`, `src/store/update.ts`, `UpdateBadge.tsx` |
| Copy & locales | `src/i18n/` (English in the bundle, the other catalogs are fetched on demand), `src-tauri/src/i18n.rs` (Dock / tray) — [i18n.md](./i18n.md) |
| Themes (21 + `system`), style tokens | `src/theme/` (`palettes` `apply` `cmTheme` `xtermTheme` `syntax`), `src/styles/index.css`, `public/theme-boot.js` |
| Rust entry, windows, single instance | `src-tauri/src/main.rs` |
| Workspace grants, PTY / watcher tables | `src-tauri/src/state.rs` |
| Commands, paths, subprocess, Dock, watcher, errors | `src-tauri/src/commands/{fs,format,git,blame,search,terminal,theme}.rs`, `paths.rs` `proc.rs` `dock_menu.rs` `watcher.rs` `error.rs` |
| Scripts | `scripts/`: guards `check-ai-docs` `check-workflows` `i18n-check` `i18n-scan` `release-check` ([checks.md](./checks.md)); build `build-file-icons` `make-icon` `collect-app` `make-latest-json` `release-targets` `set-version` |
| Artifacts (gitignored) | `release/` (bundles), `dist/`, `website/` |

## Hard rules

### Frontend
- **IPC only through `api.*`** (`lib/ipc.ts`). No direct `invoke` in components or slices.
- **Subscribe with a selector** (`useTabs(s => s.activeId)`), never `useTabs()` as a whole.
- **One `EditorView` per panel** (1, or 2 after a split). Per-tab `EditorState` lives in `editor/stateCache.ts`, swapped with `view.setState`; a split file gets one state per pane (`editor/mirror.ts` forwards ChangeSets). **Never** hold `EditorState`/`EditorView` in zustand, **never** share one state between views.
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
- Check, download and install happen in Rust (`update.rs`); the webview never touches the network, it only drives the state machine.
- Only https URLs on GitHub hosts; byte count and the `latest.json` SHA-256 must match; nothing runs before the user clicks. `latest.json` is generated at release time by `scripts/make-latest-json.mjs` and **never enters the repo**.- One window owns **one** project; several projects means several windows (`main` + `win-<pid>-<seq>`, project via `?open=<path>`). Only the main window persists the session (`IS_PRIMARY_WINDOW`).

## Common changes

### Add a backend command
1. Implement `#[tauri::command] fn ... -> AppResult<T>` in `src-tauri/src/commands/<domain>.rs`
2. Register it in `invoke_handler![...]` in `src-tauri/src/main.rs` (a missing entry fails only at runtime)
3. Add a typed `api.xxx` in `src/lib/ipc.ts`
4. Consume it in a store or `src/lib/actions.ts`, never in a component
5. User-visible → add an entry in `src/lib/commands.ts`; user-facing error → add the code to the catalogs ([i18n.md](./i18n.md))

### Add a setting
Four places, always together: `Settings` in `src/lib/ipc.ts` → `DEFAULT_SETTINGS` in `src/store/settings.ts` (plus `SHARED_KEYS` if it syncs across windows) → `Settings` + migration in `src-tauri/src/commands/theme.rs` → `SettingsView.tsx`. `schemaVersion` is 9.

### Add an editor extension
Implement in `src/editor/`; always-on ones go into `setup.ts`, toggleable ones become a `Compartment` in `stateCache.ts` so switching only reconfigures.

### Add a theme
Five places: `palettes.ts` (`ui` / `syntax` / `terminal` + `CYCLE_ORDER`), `apply.ts`, `cmTheme.ts`, `xtermTheme.ts`, `ThemeMenu.tsx`. Syntax colours live only in `syntax`, so `theme/syntax.ts` and the diff view follow automatically.

### Generated, do not hand-edit
- `src/assets/fileIcons.generated.ts` ← `scripts/build-file-icons.mjs`
- `src/vendor/prettier/` ← vendored standalone Prettier build
- `src-tauri/icons/`, `src-tauri/gen/` ← `pnpm icon` / tauri

## Architecture

`App.tsx` →(selector) zustand →(`api.*`) `src/lib/ipc.ts` →(invoke, camelCase) `main.rs` →(authorize) `commands/*.rs` → fs / git subprocesses, ignore walker, portable-pty, notify. Data flows: [traps.md](./traps.md).

## Performance ceilings

| Area | Limit |
|---|---|
| Memory profile | `src/lib/memoryBudget.ts` owns every memory limit; lightweight mode (`settings.lightweightMode`, off by default) sets it to `light`. Read `budget.*` / `feature.*` at use time, never a copied number |
| EditorState / large files | LRU ≤8 states (≤2 heavy), ≤2M chars resident, eviction skips active/dirty tabs; >1MB no wrapping, >5MB read-only, >20MB refused. Light: 3 / 1 / 600k, 512KB / 2MB |
| File tree | 200 entries per page, 20k scanned per directory, 30 cached dirs per root, ±10 row overscan; chain resolve for visible rows only, depth 16, concurrency 4 |
| Quick open / search | index is one sorted `string[]` (no objects, no Set; lookup = binary search), built on the first ⌘P rather than on project open; ≤50k entries (10k light), 5 min TTL; search ≤2MB per file, ≤500 hits (200 light), 250ms debounce |
| Blame / formatting | blame: current file only, 200ms debounce, 2MB / 5000 lines, 24-entry cache (off in light). Formatting: nothing above 500k chars, bundled Prettier on demand |
| Text meta / restore | format probe ≤400 lines (first 200 chars each); restore ≤12 files (4 light), ≤2MB each, active file last so the LRU keeps it (session ≤20 tabs, 20 closed) |
| Terminal | rAF-batched writes, 128KB backlog per frame; scrollback 2000 (1000 light); WebGL off by default; xterm instances stay alive (switching must keep the screen) |
| Agent chats | one CLI per turn (max 4 running), transcript trimmed to 300 messages / 2MB before the atomic write, tool output 8KB, stderr 200 lines; only chats with an open tab stay in memory |
| Git / memory | one `status --porcelain=v2 -z`, 350ms debounce, branch TTL 30s, no setState when the signature is unchanged; caches dropped after 30s unfocused (5s light); `app:hidden` also drops inactive EditorStates, search results, the ⌘P index |

## Data & config

- Agent transcripts live in `<config>/agent/chats/<id>.json`, open chat tabs in `<config>/agent/tabs.json` (primary window only).
- `settings.json` / `session.json` live in `app_config_dir()` (macOS `~/Library/Application Support/com.aitify.tide/`), read/written under a lock by `commands/theme.rs`.
- Defaults exist twice and must match: `DEFAULT_SETTINGS` (`src/store/settings.ts`) and `Settings::default` (`theme.rs`). A fresh install reads the Rust side (`schemaVersion` 0 → frontend migrates → writes back); after that `settings.json` wins.
- `SHARED_KEYS` decides what syncs across windows (`locale` does, layout fields do not). Workspace roots are refcounted in `state.rs`: at zero the PTYs and watcher are reaped. First paint theme comes from `public/theme-boot.js` (no inline scripts under CSP).

## Commands

`pnpm app:dev` is only for a requested UI check; `pnpm icon` regenerates app icons + the file icon table. **Never package unless the user asked**: no `pnpm app:build`, `app:build:win`, `app:release` or `tauri build` (debug bundles included). **No checks, tests or builds while coding**; when the user asks to verify, follow [`.ai/skills/verify/SKILL.md`](./skills/verify/SKILL.md). For a release check / 发布前检查, follow [the release-check skill](./skills/release-check/SKILL.md).

---
**Last updated**: 2026-11-17
