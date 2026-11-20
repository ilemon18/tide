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
- Codex uses app-server initialize/initialized, thread start/resume/fork and turn start/interrupt; Claude
  uses bidirectional stream-json, partial messages and stdio approvals. `transport.rs` keeps stdin writable,
  bounds handshakes and closes completed processes. Native schemas govern; unsupported protocols require
  upgrade, never a whole-response fallback.
- Run ID/sequence reject stale, duplicate and completed-run events; upsert item IDs. `agentEvents.ts`
  batches text/thinking/tool-output at 100ms, flushing before structure/end. Snapshots replace deltas;
  Claude deduplicates message/block. Caps mark truncation, preserve Unicode; offscreen paint defers.
  Grapheme smoothing preserves stored/copied bytes.
- Sends while running join a FIFO queue, never running stdin. Success drains it without erasing a newer
  draft. Failures keep session/queue; unanswered questions and plans block sending/draining across pages.
- Enter/Ctrl+Enter/Cmd+Enter send; Shift+Enter inserts a line. Candidate Enter commits first. Composition
  lifecycle, native isComposing, keyCode 229 and WebKit post-composition Enter precede completion/send/delete.
  Repeated Enter never queues duplicates; preserve body whitespace.
- Composer minimum: global 60px (v10), growth to min(480px, half-window); clamps never overwrite it.
  Closest `/`, `$`, `@` to caret wins. Slash/mention require whitespace/start; skills reject preceding
  word/`$`; `$5` stays prose.
- Mentions: eight fuzzy quick-open matches; preserve `{rel,isDir}` chips across edits/renames. Rust adds
  relative references/directory markers. Lazy scans: project `.agents/skills`, `.claude/skills`, user
  `~/.claude/skills`, `$CODEX_HOME/skills`; cache success/retry errors. Queues retain mentions/skills/command.
  `plan|goal|review|test|explain`: single replaceable tags, including typed prefixes. Skill paths precede
  tags/question/read-only instructions.

## Questions, permissions and plans

- `<TIDE_QUESTION>`: one marker/turn, nonempty header/question, 2–4 labelled/described options, optional
  multiSelect/custom answer. Preserve text order; hide partial markers until flush. Invalid/unclosed markers
  restore source plus localized notice. Blank answers block sends.
- Persist `permissionMode`: read-only/workspace-write/full-access; old missing values stay writable.
  Plan/question follow-ups force read-only. Menu and `/permissions` share a setter; runs lock model/effort/permissions.
  Codex mappings: read-only/never, workspace-write/on-request, danger-full-access/never. Claude: plan,
  acceptEdits, bypassPermissions; these are not OS sandboxes and retain native/organization restrictions.
- Ordered native cards: allow-once/deny. Rust checks window/run/request ownership and single use; grants
  last one turn. Persist before responding; read-only rejects escalation. Stop/completion/recovery expires
  unfinished cards. Waiting blocks queue drain; failed question launch restores its card. Permission queries/
  compact never create plans.
- Successful nonblank planning without questions creates `plan-<message>`; questions take precedence.
  Implement-current resumes writable; implement-fresh isolates a same-root tab with only plan/instructions/
  fixed preamble. Continue-planning resolves the card read-only and focuses its draft. Persist action/result/
  target before launch; lock duplicates, retry the same target, never launch on hydration. Text-only buttons;
  guidance in placeholder/tooltip.
- Local `/new`, project-scoped `/resume [chat ID]`, `/model [ID|default]`, three-mode `/permissions`, `/status`
  and `/help` never reach the model. Missing arguments open selectors; invalid ones show errors.
- `/fork` clones persisted history after capability probing (Claude --fork-session; Codex app-server plus
  RPC validation). Failure preserves clone/parent session boundaries with explicit fresh-session restart.
  Empty model/effort sends no flag, preserving CLI config and per-chat defaults.
- `/compact` needs idle/no queue/no pending card. Preserve transcript; atomically persist a read-only
  summary before resetting session/context/usage. Use it as new-session preamble; failure keeps the session.

## UI, usage and storage

Tabs/drag ghosts: live provider icon + Agent + `AgentTabStatus`, no duplicated tab state.
Running/error/cancelled override completion; idle success requires latest-page assistant completion.
Unknown/new/history-only omit results. Stored titles stay stable for headers/tooltips; time stays at tail.

- Replies: GFM, code copying, skip HTML/image loads. Blue underlined file links use owning chat root via
  openFile/openAt. `agentLinks.ts` resolves relative/contained absolute paths and `:line:col`/`#LlineCcol`,
  rejects escapes/schemes; native reads enforce containment. Links never navigate the WebView.

- Entry points respect agentEnabled; tree double-click opens/toggles normally. Chats use an empty editor
  or secondary row. Run only installed/supported providers; additions need a spec/event translator.
- Loading/tool indicators use a dedicated SVG spinner with fixed transform box, linear timing and compositor hint.
- User bubbles shrink/right-align with left-aligned whitespace-preserving text. Absolute copy includes
  references without consuming text width; hover/focus reveals only the owning message/item control.
- Items retain source order without tool groups/detail wrappers. Commands show two lines, results three;
  segments keep arrival positions across permissions/text and reconcile final snapshots. Long/wrapped
  content has expand-all retained across deltas; prefer parsed command/path over JSON. Copy uses all bytes.
  Clipped input/output expand controls have visible hover and pointer cursor.
- One assistant tail shows activity/elapsed/confirmation waits and a running accent spinner. Done saves
  completion/timestamp/backend duration including approval waits; never invent missing historical values.
  Finished turns append saved zero-padded local 24-hour `HH:mm` after duration, including reopening; live
  turns omit it. Follow only at bottom; history expansion pauses following.
- Footer: context ring/stop/send; popup consumes Escape first. `currentContext`/`sessionUsage` ignore loaded
  history. Ring uses only provider contextTokens/contextWindow (zero valid; missing/invalid unavailable).
  Replace turn contributions or use native session totals; reset stats with session/provider.
  The popup shows actual context and token counts only: no cost rows, draft token estimates or prompt
  breakdown. Draft changes do not trigger estimation IPC; the estimate command/store/cache are removed.
  Provider cost fields remain compatible with persisted usage, but have no price formatter or UI.
- Chat v:1 open/page/apply/list/clone IPC merges header/message-ID patches, preserving unknown fields and
  unloaded history. Per-file locks serialize windows; atomic writes reject >8 MiB/invalid JSON, preserving
  originals. Failed closing writes retain snapshots for flush/reopen retry.
- Pages: initially 80 records/512 KiB, then 40/load. Window: 160 records/1 MiB, oversized record alone.
  Persist before eviction/navigation; keep earlier/later links and visible anchor. Exclusive before/after
  cursors reject missing/ambiguous boundaries; pending-card metadata scans full history.
- Primary tabs persist in agent/tabs.json; hidden/unload flush patches. AgentChat hooks precede returns.
  Tests cannot establish native scrolling/account compatibility.
