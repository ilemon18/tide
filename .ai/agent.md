---
summary: Agent chat, providers, composer, planning and persistence
scope:
  - src/store/agent.ts
  - src/lib/agent*.ts
  - src/components/Agent*.tsx
  - src-tauri/src/commands/agent.rs
  - src-tauri/src/agent/**
---
# Built-in agent

Claude/Codex CLIs own auth, models and tools; one turn is one headless process.

## Lifecycle and prompts

- `agent_send` authorizes the root and starts the resolved CLI with `cwd = root`, prompt on stdin, never
  argv. Rust owns bounded concurrency, one turn/chat and process-group cleanup on stop, tab/window close,
  exit and disable. Release a completed turn before Done without removing a subsequent run.
- Events have run ID and monotonic sequence; reject stale, duplicate and completed-run events. Upsert
  items by ID. `agentEvents.ts` coalesces adjacent text/thinking at 100ms, flushing before structural/end
  events so Markdown receives final bytes in order. Offscreen transcript rows defer painting.
- Sends while running join a FIFO queue, never running stdin. Success drains it without erasing a newer
  draft. Failures keep session/queue; unanswered questions and plans block sending/draining across pages.
- Composer minimum persists globally (60px, v10); content grows to min(480px, half-window), and
  viewport clamps never overwrite the saved minimum. `/`, `$`, `@` use the closest trigger to the caret;
  slash/mention require whitespace/start; skills reject preceding word/`$`, and `$5` stays prose.
- Mentions fuzzy-match eight quick-open paths and retain `{rel,isDir}` chips through edits/renames. Rust
  adds workspace-relative referenced paths, marking directories. Skills lazily scan project `.agents/skills`,
  `.claude/skills`, user `~/.claude/skills`, `$CODEX_HOME/skills`; cache successes, retry errors. Queue metadata
  retains mentions/skills/command. Prompt commands `plan|goal|review|test|explain` are single replaceable tags;
  typed leading commands normalize identically. Skill paths precede tags/question/read-only instructions.

## Questions, permissions and plans

- `<TIDE_QUESTION>` allows one valid marker/turn: nonempty header/question, 2–4 labelled/described options,
  optional multiSelect and custom UI answer. Preserve surrounding text order. Hide partial markers until
  flush; invalid/unclosed markers restore source text plus localized notice. Blank answer blocks sends.
- Header `permissionMode` and `planning` persist. Standalone `/plan` toggles locally; planning follow-ups
  and question answers stay read-only. Old chats default writable, retaining existing planning state.
  Claude read-only uses plan permission mode without bypass flags; Codex uses read-only sandbox. Writable
  Claude uses bypass flags; writable Codex uses workspace-write with approval_policy=never. Failed question
  launches restore the unanswered card. Permissions-only queries and compact never create plan cards.
- Only successful planning with nonblank text and no pending question creates stable `plan-<message>`.
  Questions take precedence. Implement-current resumes writable; implement-fresh opens an isolated same-root
  tab containing only approved plan, optional instructions and fixed handoff preamble, without old history/session. Continue-planning resolves the card, stays read-only and focuses instructions as a draft.
  Persist action/result/target ID before launching; lock duplicates, retry the same target after failure,
  never auto-launch on hydration. Buttons are text-only; pending guidance uses placeholder/send tooltip.
- Local `/new`, project-scoped `/resume [chat ID]`, `/model [ID|default]`, two-mode `/permissions`, `/status`
  and `/help` never reach the model. Missing arguments open selectors; invalid ones show errors.
- `/fork` clones full persisted history and uses native provider fork only if installed CLI help advertises
  support; Rust probes again before launch. Failure retains clone/parent session boundary, with explicit
  fresh-session restart. Empty model/effort sends no flag, preserving CLI config and per-chat defaults.
- `/compact` requires idle/no queue/no pending card. Generate a read-only summary, preserve transcript,
  then reset session/context/cumulative usage only after atomic summary persistence. Next new session uses
  summary as history preamble; failure keeps original session. No app-server/ACP/MCP driver is introduced.

## UI, usage and storage

- Title-bar/tree-context entry points respect agentEnabled. Tree double-click remains normal open/toggle.
  New chats fill an empty editor or open in a secondary row pane. Only installed/supported providers run;
  new providers need a spec and event translator.
- RunningStatus alone ticks each second after the latest transcript output, showing spinner, elapsed
  (0s before start timestamp), activity/tooltip. No header timer; long titles truncate. Tool groups remain message-local, priority error > running > ok, never persisted.
- Footer order: context ring, stop, send. Popup handles Escape before stop. Header `currentContext` and
  `sessionUsage` are independent of loaded history: only provider contextTokens/contextWindow drive the
  ring (zero valid, missing/invalid unavailable), never draft estimates or cumulative usage. Replace each
  turn's prior cumulative contribution, or use native session total. Session/provider reset clears stats.
- Chat v:1 uses open/page/apply/list/clone IPC. Rust merges header/message-ID patches, preserving unknown
  fields and unloaded history. Per-file locks serialize windows; atomic writes reject >8 MiB or invalid
  JSON without trimming/replacing originals. Closing-write failures retain snapshots for flush/reopen retry.
- Initial pages: 80 records/512 KiB; history: 40 per load. Window: 160 records/1 MiB, oversized record alone.
  Persist before eviction/navigation; retain earlier/later links and visible message anchor. Exclusive
  before/after cursors reject missing/ambiguous boundaries; pending-card metadata scans full history.
- Primary-window tabs persist in agent/tabs.json; hidden/unload flush patches. All AgentChat hooks precede
  loading/missing returns. Tests do not establish native scroll feel or real-account compatibility.
