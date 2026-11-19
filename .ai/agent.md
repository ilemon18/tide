# Built-in agent

**Load when:** changing agent chat state/UI, provider lifecycle, command/skill pickers, structured
questions, read-only planning, usage/context display, or transcript persistence.
**Code:** `src/store/agent.ts`, `src/lib/agent*.ts`, `src/components/Agent*.tsx`,
`src-tauri/src/commands/agent.rs`, `src-tauri/src/agent/`.

The agent wraps local Claude/Codex CLIs. One user turn is one headless process resumed by provider
session id; the CLIs own auth, configured models and tool loops. Chat tabs use the secondary pane; see
[editor.md](./editor.md) for routing.

## Turn lifecycle and queue

- `agent_send` authorizes the workspace root, resolves the binary, builds args, spawns with `cwd = root`,
  writes the prompt to **stdin** (never argv), and returns. Rust owns the process.
- A reader parses stdout JSONL into `session | textDelta | thinking | toolStart | toolDetail | toolEnd |
  question | questionInvalid | usage | notice | stderr | done`. Coalesce text deltas before the single
  `agent:event` listener reaches the store. The reducer appends by item id, upserts tool/question cards,
  stores the CLI session id, attaches usage to the latest assistant message, and closes on `done`.
- Stop, tab close, window close, app exit and disabling the agent kill the process group (`setsid` on Unix,
  `taskkill /T` on Windows). Enforce bounded global concurrency and one turn per chat in Rust.
- A send during a turn appends to that chat's FIFO queue, not running stdin. `done` and Stop both drain the
  queue on the same session. Auto-drain must not erase a draft typed meanwhile. Queue text is not in the
  transcript until sent.
- Escape stops only the focused running chat; composer menus, pickers and the context-usage popup consume
  Escape first and stop propagation.
- Provider scan warms after first paint and caches per session. `loadProviders` deduplicates normal and
  forced scans while loading; refresh failure keeps the last successful list, while failed first scan may
  use an empty list.

## Commands, skills and questions

- `/` uses the command catalog in `src/lib/agentCommand.ts`; one command is allowed and selecting another
  replaces it. `/plan` also sets `readOnly`.
- `$` lazily scans skills per root from `<root>/.agents/skills`, `<root>/.claude/skills`,
  `~/.claude/skills`, and `$CODEX_HOME/skills` (default `~/.codex/skills`). Only frontmatter
  name/description and SKILL.md path travel; the agent reads the file. Project paths are
  workspace-relative and user paths absolute. Cache per session, retry failures, and add no watcher or
  Rust cache.
- Queue entries and session-reset retries carry `command` / `skills` with the text; preserve them through
  retries and question answers.
- Providers may emit at most one valid `<TIDE_QUESTION>…</TIDE_QUESTION>` marker per turn. It requires
  non-empty header/question and 2–4 non-empty labelled/described options. Preserve surrounding text in
  source order and hide only the valid marker; multiple questions are invalid. Keep partially streamed
  markers hidden until flush. Invalid JSON/options or an unclosed marker restores the original text and
  emits a localized `questionInvalid` notice.
- A question with absent/blank `answer` is pending and blocks sends and queue draining. Submitting marks it
  answered, appends the localized question/answer user message, and resumes the same CLI session in a new
  process.
- `/plan` sends `readOnly: true` and tells the agent to inspect before planning. It may ask only when a key
  decision cannot be derived from the repository. Answer follow-ups keep the source `readOnly` flag; the
  next ordinary message starts a writable turn. Ordinary chat questions are allowed, but their answer
  turns are writable unless they came from a read-only plan turn.
- Read-only turns must not use the ordinary bypass/workspace-write launch path. Claude uses
  `--permission-mode plan` and omits `--permission-mode bypassPermissions` plus
  `--allow-dangerously-skip-permissions`; Codex uses `sandbox_mode="read-only"`. Session-reset retry
  preserves the question item and `readOnly` flag.

## Providers and UI invariants

- Claude writable turns use bypass/dangerously-skip flags; Codex writable turns set
  `-c sandbox_mode="workspace-write" -c approval_policy="never"`. Empty `model` / `effort` means **no flag**,
  so user provider config wins; never auto-fill a catalog model or rewrite the global default from a
  per-chat pick. A missing session retries once without its id and shows a notice.
- Group consecutive tool items only while rendering one assistant message; any non-tool item cuts the
  group. Status priority is `error > running > ok`. Running groups start expanded and completed groups
  auto-collapse until manually toggled. Never persist grouping/toggle state.
- Only `RunningStatus` ticks each second; do not rerender the transcript on a timer. Repeated usage events
  replace the latest snapshot. A cumulative cost exists only when every contributing turn is priced;
  unpriced Codex tokens stay `null`, never a partial total.
- Context percentage is latest assistant `totalTokens / contextWindow`, clamped. A missing or invalid
  provider window is unavailable, never a fixed fallback. The estimate includes wrappers and file sizes
  without contents, but excludes history, directory contents and CLI overhead. Clear stale estimates on
  chat close.

## Persistence and providers

- `<appConfig>/agent/chats/<id>.json` is opaque, frontend-owned transcript JSON written atomically. Enforce
  the hard cap and trim limit beside the store/tests. Keep transcript `v: 1`; usage, question items and
  assistant `readOnly` are optional additions, and old files must load.
- `<appConfig>/agent/tabs.json` stores open chat tabs and the active chat for the primary window only. Apply
  the max-open limit in the implementation. Flush both stores on `app:hidden` / `beforeunload`.
- To add a provider, add a `ProviderSpec` in `src-tauri/src/agent/providers.rs`, an argument builder and
  JSONL translator beside `src-tauri/src/agent/claude.rs`, an optional model catalog, and map events into `AgentEvent`.
  Unsupported detected CLIs stay in Settings with a hint.

