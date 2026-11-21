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

- `agent_send` authorizes the root and launches the CLI there with prompts on stdin. Rust owns four-turn
  concurrency, one turn/chat and process-group cleanup on stop/close/exit/disable. Reap before Done,
  release only the matching run; EOF/error never implies success.
- Keep per-turn workspace and question guidance concise while preserving workspace boundaries, read-only
  restrictions and the complete structured-question contract.
- Codex uses app-server initialize/thread/turn operations; Claude uses bidirectional stream-json and stdio
  approvals. `transport.rs` keeps stdin writable, bounds handshakes and closes completed processes. Native
  schemas govern; unsupported protocols require upgrade, never a whole-response fallback.
- Run ID/sequence rejects stale or completed events; upsert IDs. `agentEvents.ts` batches text/thinking/tool
  output, flushes before structure/end, replaces snapshots and deduplicates Claude blocks. Caps preserve
  Unicode and mark truncation; grapheme smoothing preserves stored/copied bytes.
- Sends while running join a FIFO queue, never running stdin. Success drains it without erasing a newer
  draft. Failures keep session/queue; unanswered questions and plans block sending/draining across pages.
- Enter/Ctrl+Enter/Cmd+Enter send; Shift+Enter inserts a line. Candidate Enter commits first. Composition
  lifecycle, native isComposing, keyCode 229 and WebKit post-composition Enter precede completion/send/delete.
  Repeated Enter never queues duplicates; preserve body whitespace.
- Composer starts at 60px (v10), grows to min(480px, half-window), and keeps its minimum when clamped.
  The nearest `/`, `$` or `@` trigger wins; slash/mention needs a boundary, skills reject a preceding word or
  `$`, and `$5` stays prose.
- Mentions show eight fuzzy matches, preserve `{rel,isDir}` chips and retain queued references; scan project/user
  skills lazily, cache results, and keep plan tags single.

## Questions, permissions and plans

- `<TIDE_QUESTION>` is one marker/turn with a nonempty header/question and 2–4 labelled options, optionally
  multi-select/custom answer. Preserve order, hide partial markers until flush, restore invalid markers with a
  notice, and block blank answers.
- Persist `permissionMode`: read-only/workspace-write/full-access; old missing values stay writable.
  Explicit picker and local-command choices update global defaults immediately; new chats inherit them.
  Model changes save the compatible effort, including empty values labelled Default (CLI config).
  Restored chats keep their own options; hydration/provider fallback never changes preferences.
  Planning, question follow-ups, compact and plan execution never save temporary permissions as defaults.
  Plan/question follow-ups force read-only. Menu and `/permissions` share a setter; runs lock model/effort/permissions.
  Codex mappings: read-only/never, workspace-write/on-request, danger-full-access/never. Claude: plan,
  acceptEdits, bypassPermissions; these are not OS sandboxes and retain native/organization restrictions.
- Ordered native cards: allow-once/deny. Rust checks window/run/request ownership and single use; grants
  last one turn. Persist before responding; read-only rejects escalation. Stop/completion/recovery expires
  unfinished cards. Waiting blocks queue drain; failed question launch restores its card. Permission queries/
  compact never create plans.
- Successful planning without questions creates `plan-<message>`; questions take precedence. Implement-current
  resumes writable; implement-fresh isolates a same-root tab with the plan and fixed preamble. Continue-planning
  stays read-only. Persist action/result/target before launch, lock duplicates, retry the same target, and never
  launch on hydration.
- Local `/new`, project-scoped `/resume [chat ID]`, `/model [ID|default]`, three-mode `/permissions`, `/status`
  and `/help` never reach the model. Missing arguments open selectors; invalid ones show errors.
- `/fork` clones persisted history after capability probing (Claude --fork-session; Codex app-server plus
  RPC validation). Failure preserves clone/parent session boundaries with explicit fresh-session restart.
  Empty model/effort sends no flag, preserving CLI config and per-chat defaults.
- `/compact` needs idle/no queue/no pending card. Preserve transcript; atomically persist a read-only
  summary before resetting session/context/usage. Use it as new-session preamble; failure keeps the session.

## UI, usage and storage

- Agent tabs use status; failures override completion. Replies use
  GFM, copy code, reject HTML/remote images, and resolve only contained chat-root links (`:line:col`/`#LlineCcol`).
- Entry points respect `agentEnabled`; tree double-click stays a file-tree gesture. Items retain source order,
  reconcile IDs and preserve expansion.
- Turn tails report activity, elapsed time and confirmation waits. Persist completion time and backend duration;
  reopened finished turns show local `HH:mm`, live turns omit it, and following pauses during history expansion.
- Context popup uses provider context/session usage; loaded history and drafts do not alter it. Zero is valid,
  invalid values are unavailable, and persisted provider cost fields have no price UI.
- Chat v:1 open/page/apply/list/clone merges patches, preserves unknown/unloaded data, locks each file and
  writes atomically. Invalid JSON or files over 8 MiB leave the original intact; failed close writes retry.
- Pages start at 80 records/512 KiB, then load 40; the window is 160 records/1 MiB with an oversized record
  alone. Persist before eviction/navigation, retain cursors/anchor, scan pending cards, and flush
  `agent/tabs.json` on hide/unload.
