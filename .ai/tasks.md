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

Rust `commands/tasks.rs` discovers and runs project commands. `AppState` owns task process lifetimes and
reaps them on workspace release, window destruction or application exit. The frontend task store owns cached
definitions, live output, execution state and parsed Problems. `problemParser.ts` never opens paths.

Tasks come from `.tide/tasks.json`, package scripts, Makefile targets, Cargo.toml, go.mod and common Python
test markers. Custom cwd is relative to the authorized workspace root; validate traversal, symlink escapes
and directory type at discovery and execution. Pass cwd separately to the process, never through shell `cd`.
Config reads are bounded and reject symlink escapes. Discovered script/Make target names reject shell
metacharacters and leading options. Discovery never executes commands; a task action starts execution.

Client execution ids and listeners exist before spawn. Emit UTF-8-safe output only to the owning window;
drain readers before exit. Waiting never holds the child mutex while the process is running. Stop and
cleanup reap the process tree once. Native concurrency/config limits belong to `commands/tasks.rs`;
output/history/Problems limits belong to `lib/memoryBudget.ts` and shrink with lightweight mode. Output is
not persisted; memory reclamation trims history and output at the current budget.

Problems accept `path:line:column`, `path(line,column)` and standard Rust message-before-arrow output.
Only relative workspace paths are retained; URL, absolute and traversal paths are rejected before
`tabs.openAt`. Resolve paths relative to the task cwd and preserve one-based line/column coordinates.
Combine different tasks' diagnostics; reruns replace only that task's diagnostics. Ignore late discovery and
events for released roots. Run/stop failures surface localized toasts. Disabling tasks stops live executions.

`tasksEnabled` defaults to true, migrates in settings schema 15 and is shared across windows. The Settings
activity-bar row and the activity-bar checklist both write this one switch; the task icon has no separate
visibility setting. Keep frontend Settings/defaults, Rust defaults and locales synchronized; shared settings
contracts belong to [runtime.md](./runtime.md).
The task toggle has its localized setting label as its accessible name; task selection buttons name the
label, command and source with explicit separators so completed runs can be selected independently of Run.

Custom task configuration (`.tide/tasks.json`):

```json
{ "tasks": [{ "id": "api-test", "label": "API tests", "command": "python -m pytest", "cwd": "packages/api" }] }
```

`id` and `command` are required and nonempty; ids must be unique. `label` falls back to id, and `cwd`
defaults to the workspace root.
