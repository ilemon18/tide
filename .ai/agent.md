---
summary: Agent chat, providers, composer, planning and persistence
scope:
  - src/store/agent.ts
  - src/lib/agent*.ts
  - src/components/Agent*.tsx
  - src/components/ContextMenu.tsx
  - src-tauri/src/commands/agent.rs
  - src-tauri/src/agent/**
---
# Built-in agent

Claude/Codex CLIs own auth, models and tools; Rust owns one bidirectional stdio process per turn.

## Lifecycle and prompts

- `agent_send` authorizes the root and starts the resolved CLI at that root, prompt only on stdin. Rust
  owns four-turn concurrency, one turn/chat and process-group cleanup on stop, window close, exit and
  disable. Reap before Done; release only the matching run. Protocol EOF/error cannot imply success.
- Codex uses app-server initialize/initialized, thread start/resume/fork, turn start/interrupt. Claude uses
  bidirectional stream-json, partial messages and stdio permission callbacks. `transport.rs` keeps stdin
  writable, bounds handshake time and closes each completed process. Unsupported protocols require an
  upgrade, never a silent whole-response fallback. Native schemas remain authoritative.
- Events have run ID and monotonic sequence; reject stale, duplicate and completed-run events. Upsert
  items by ID. `agentEvents.ts` coalesces adjacent text/thinking/tool-output at 100ms, flushing before structural/end
  events so Markdown receives final bytes in order. Final item snapshots replace deltas without duplication;
  Claude deduplicates per message/block. Output caps mark truncation and preserve Unicode boundaries.
  Offscreen rows defer painting; display-only grapheme smoothing never changes stored/copied content.
- Sends while running join a FIFO queue, never running stdin. Success drains it without erasing a newer
  draft. Failures keep session/queue; unanswered questions and plans block sending/draining across pages.
- Enter sends, Shift+Enter inserts a line, Ctrl/Cmd+Enter also sends. Candidate Enter commits first.
  Composition lifecycle, native isComposing, keyCode 229 and WebKit post-composition Enter precede every
  completion/send/delete shortcut. Repeated Enter never queues duplicates. Preserve body whitespace.
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
- Header `permissionMode` persists read-only/workspace-write/full-access (old missing values stay writable).
  Planning and question follow-ups override the session choice with read-only. Menu and `/permissions`
  share one setter; model, effort and permissions lock during runs. Codex maps to read-only/never,
  workspace-write/on-request, danger-full-access/never; Claude maps to plan, acceptEdits, bypassPermissions.
  Claude modes are not OS sandboxes; native/organization restrictions still apply.
- Native permission requests appear in ordered cards, allow-once/deny only. Rust validates owner window,
  run/request IDs and single use. Native permission-profile grants are turn-scoped, never session-scoped.
  Persist the decision before responding. Read-only rejects escalation;
  stop/completion/recovery expires unfinished cards. Waiting never drains the queue. Failed question
  launches restore the unanswered card. Permissions queries and compact do not create plans.
- Only successful planning with nonblank text and no pending question creates stable `plan-<message>`.
  Questions take precedence. Implement-current resumes writable; implement-fresh opens an isolated same-root
  tab containing only approved plan, optional instructions and fixed handoff preamble, without old history/session. Continue-planning resolves the card, stays read-only and focuses instructions as a draft.
  Persist action/result/target ID before launching; lock duplicates, retry the same target after failure,
  never auto-launch on hydration. Buttons are text-only; pending guidance uses placeholder/send tooltip.
- Local `/new`, project-scoped `/resume [chat ID]`, `/model [ID|default]`, three-mode `/permissions`, `/status`
  and `/help` never reach the model. Missing arguments open selectors; invalid ones show errors.
- `/fork` clones full persisted history and uses native provider fork after capability probing
  (Claude --fork-session, Codex app-server entry point plus RPC validation). Failure retains clone/parent session boundary, with explicit
  fresh-session restart. Empty model/effort sends no flag, preserving CLI config and per-chat defaults.
- `/compact` requires idle/no queue/no pending card. Generate a read-only summary, preserve transcript,
  then reset session/context/cumulative usage only after atomic summary persistence. New sessions use
  the summary as history preamble; failure keeps the original session.

## UI, usage and storage

Chat tabs subscribe to their chat record's provider and render the shared `AgentProviderIcon` artwork at
tab size. Unknown or not-yet-loaded providers use the generic agent fallback; the same component is used by
the cross-pane drag ghost, so provider hydration and changes update both surfaces without adding tab fields.

- Title-bar/tree-context entry points respect agentEnabled. Tree double-click remains normal open/toggle.
  New chats fill an empty editor or open in a secondary row pane. Only installed/supported providers run;
  new providers need a spec and event translator.
- User bubbles shrink to content at the right edge; body stays left-aligned with indentation/newlines.
  The absolute copy button appears on hover/focus, includes references and never occupies a text column.
- Items render in source order without tool groups or command details wrappers. Commands show two lines,
  results three; result segments retain their arrival positions across permissions/text, while final snapshots
  reconcile those segments. Wrapped/long content exposes expand-all, retained across deltas. Prefer parsed command/path
  over argument JSON. Full input/result and whole-turn copying use all received bytes.
- Each assistant turn owns one tail activity/elapsed status (waiting confirmation when applicable).
  Done persists completion, completion timestamp and backend duration including approval waits; old records
  never invent a duration. Scroll follows only at bottom; history expansion pauses following.
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
