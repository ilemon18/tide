---
summary: Project tasks, process execution and Problems diagnostics
scope:
  - .ai/tasks.md
  - src/store/tasks*.ts
  - src/lib/problemParser*.ts
  - src/components/TasksPanel*.tsx
  - src-tauri/src/commands/tasks.rs
  - src-tauri/src/commands/mod.rs
  - src-tauri/src/state.rs
  - src-tauri/src/main.rs
keywords:
  - tasks
  - problems
  - diagnostics
  - process
  - command
  - 任务
  - 问题
  - 诊断
---
# Project tasks and Problems

## Ownership

Rust `commands/tasks.rs` discovers and runs project commands; `AppState` owns task process lifetimes and
reaps them on workspace release, window destruction or app exit. The frontend task store owns cached
definitions, live output, execution state and parsed Problems; `problemParser.ts` never opens paths.

## Discovery and execution

- Tasks come from `.tide/tasks.json`, package scripts, Makefile targets, Cargo.toml, go.mod and Python test
  markers. Custom cwd is relative to the authorized root; validate traversal, symlink escapes and directory
  type at discovery and execution, and pass cwd separately, never through shell `cd`. Config reads are
  bounded. Script/Make names reject shell metacharacters and leading options; discovery never executes.
- Client execution ids and listeners exist before spawn. Emit UTF-8-safe output only to the owning window and
  drain readers before exit. Waiting never holds the child mutex while the process runs. Stop/cleanup reaps
  the process tree once. Native concurrency/config limits belong to `commands/tasks.rs`; output/history/
  Problems limits belong to `lib/memoryBudget.ts` and shrink in lightweight mode. Output is not persisted.
- `.tide/tasks.json` takes `{ "tasks": [{ "id", "label", "command", "cwd" }] }`; `id` and `command` are
  required and unique, `label` falls back to id and `cwd` defaults to the workspace root.

## Problems

- Accept `path:line:column`, `path(line,column)` and standard Rust message-before-arrow output. Keep only
  relative workspace paths; reject URL, absolute and traversal paths before `tabs.openAt`. Resolve relative
  to the task cwd and preserve one-based line/column coordinates.
- Combine diagnostics from different tasks; reruns replace only that task's diagnostics. Ignore late
  discovery/events for released roots; run/stop failures use localized toasts.

## Settings

`tasksEnabled` defaults to true, migrates in settings schema 15 and is shared across windows. Settings and
the checklist write this one switch; there is no separate visibility setting. Disabling stops live runs.
Keep Rust/frontend defaults and locales synchronized; shared settings: [runtime.md](./runtime.md).

## Change map

Coordinate discovery, execution, parsing and limits; tests live beside owners. Gate: [checks.md](./checks.md).
