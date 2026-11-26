---
summary: Providers, turns, events and reply UI
scope:
  - .ai/agent.md
  - src/store/agent.ts
  - src/store/agent.test.ts
  - src/lib/agentBridge.ts
  - src/lib/agentEvents*.ts
  - src/lib/agentUsage*.ts
  - src/lib/agentDuration.ts
  - src/lib/agentLinks*.ts
  - src/components/AgentChat*.tsx
  - src/components/AgentMessage*.tsx
  - src/components/AgentMarkdown*.tsx
  - src/components/AgentStreamText*.tsx
  - src/components/AgentTurnStatus*.tsx
  - src/components/AgentSpinner*.tsx
  - src/components/AgentTabStatus*.tsx
  - src/components/AgentProviderIcon*.tsx
  - src/components/AgentContextUsage*.tsx
  - src/components/AgentTurnChanges*.tsx
  - src/components/ContextMenu.tsx
  - src-tauri/src/commands/agent.rs
  - src-tauri/src/agent/mod.rs
  - src-tauri/src/agent/providers.rs
  - src-tauri/src/agent/claude.rs
  - src-tauri/src/agent/codex.rs
  - src-tauri/src/agent/transport.rs
keywords:
  - agent
  - provider
  - turn
  - stream
  - permission
  - usage
  - 代理
  - 协议
  - 权限
  - 流式
  - 用量
---
# Agent execution and replies

## Ownership

CLIs own auth/models/tools; Rust owns processes; the agent store owns queues/UI. New chats force
`loadCatalog(provider, true)` in the background: concurrent requests coalesce around one owed run, and a
non-empty refresh repairs session defaults (and blank idle chats) whose model disappeared. Empty/failed
probes never clear the saved model. Input/plans:
[agent-composer.md](./agent-composer.md). History: [agent-storage.md](./agent-storage.md).

## Turns and events

- agent_send authorizes root, launches there with prompt on stdin. Rust owns four-turn concurrency,
  one turn/chat and process-group cleanup on stop/close/exit/disable. Reap before Done, release only the
  matching run. EOF/error never means success.
- Codex uses app-server initialize/thread/turn; Claude uses bidirectional stream-json/stdio approvals.
  transport.rs keeps stdin writable, bounds handshake and closes completed processes. Native schemas
  govern; unsupported protocols need an upgrade, never a whole-response fallback.
- Run ID/sequence reject stale/completed events; upsert IDs. agentEvents batches text/thinking/tools,
  flushes before structure/end, replaces snapshots and deduplicates Claude blocks. Caps preserve Unicode
  and mark truncation; grapheme smoothing preserves stored/copied bytes.
- Running sends enter the FIFO queue, never process stdin. Success drains without erasing newer drafts;
  failure keeps session/queue. Completed unanswered questions and unresolved plans block sends/drain
  across pages; incomplete or failed/cancelled streams do not gate.
- A queued card can interject: wait for the old launch, cancel, then wait for its Done before launching the
  selection. Edit appends its text/metadata to the composer (existing command wins), removes the entry and
  focuses the composer. Lock duplicate actions/drain; preserve order, metadata and newer drafts.
  Launch failure retains the selection; question/plan gates still apply.
- A chat tab with a running turn cannot close via tab button, middle-click, context menu, bulk close or
  shortcut. The tab store rejects non-force closes before stopping the run; task teardown
  may force-clean. The guard lifts on Done/stop/error/cancel.

## Permissions and preferences

- Persist permissionMode=read-only/workspace-write/full-access; legacy missing stays writable. Explicit
  picker/local-command choices update defaults immediately; new chats inherit. Model changes save
  compatible effort, including empty Default (CLI config). Restore/hydration/provider fallback never
  overwrite preferences. Temporary plan/question/compact/execution choices
  never become defaults. Plan/question follow-ups force read-only; runs lock model/effort/permissions.
  Menu and /permissions share a setter.
- Codex maps modes to read-only/never, workspace-write/on-request, danger-full-access/never; Claude to
  plan, acceptEdits, bypassPermissions. Native/organization restrictions still apply; Claude modes are not
  OS sandboxes. Ordered allow-once/deny cards validate window/run/request ownership and single use.
  Grants last one turn; persist before responding. Read-only rejects escalation. Stop/done/recovery expire
  cards; waiting blocks drain; failed question launch restores the card. Queries/compact never create plans.

## Replies and usage

- Tab failures override completion. Replies use GFM/code-copy, reject HTML/remote images and accept only
  contained owning-root file links (`:line:col`/`#LlineCcol`). Entries respect agentEnabled; tree double-click
  stays a tree gesture. Items keep source order, reconcile IDs and retain expansion.
- Output folds show reply provider names (catalog, then Codex/Claude Code or ID); legacy replies use the chat
  provider. Keep expansion/copy. User bubbles show `agent.you`; copies omit speaker labels.
- Tail reports activity/elapsed/confirmation waits; persist completion time and backend duration. Finished
  reopened turns show local HH:mm; live ones omit it. History expansion pauses following.
- Tail status takes primitive fields and owns its one-second clock; streamed Markdown/tools never remount it.
  AgentSpinner rotates a fixed HTML box apart from SVG painting. Live replies render visibly; only inactive
  messages skip content automatically.
- The configurable context.openOrLatest jumps only in the active chat, respecting overlays and IME; its other
  focus context opens a file-tree row, loading the latest history page first. Sends, successful interjections
  and running→finished transitions resume following and anchor the bottom after deferred layout; upward
  reading gestures and direct scrollbar presses pause it. Layout-generated scrolls, including upward offsets
  after shrink/regrowth, never clear that intent and schedule another anchor; first-send layout changes and
  queue/composer resizing retain following, and queued cards use the lighter surface. Observe transcript
  text/child mutations and box resizing so deferred smoothing and Markdown formatting anchor after render;
  respect paused following.
- Context popup uses provider context/session usage, unaffected by loaded history/drafts. The context ring
  uses the current context snapshot, while token rows show only the native session cumulative usage;
  latest-turn details are hidden. Zero is valid; invalid is unavailable. Keep persisted cost
  fields compatible, without price UI.

- Composer permission state comes from its picker/cards, without a duplicate plan/read-only line.
  Settings → Agent shows all installed providers and five uninstalled (More reveals the rest), plus the
  history toggle. Permission defaults/explanation stay hidden there; chat permission controls remain.

## Turn changes and undo

- Write-capable turns snapshot the worktree baseline before spawn and again after the child is reaped;
  `turnChanges` precedes `done`, so the summary joins the same assistant message and a queued next turn cannot
  leak its writes into it. Read-only/planning turns and non-repository roots make no card.
- The card shows per-file A/M/D/R/T status with numstat counts (200-row cap, complete totals; truncation
  disables undo), opens the unstaged diff, and offers undo only on the latest assistant message; a
  new turn removes it. The confirm dialog warns when the turn also committed.
- Undo restores only the listed rows via the Git store (index queue, suspended saves, closed/reloaded tabs),
  never rewriting commits or touching unlisted paths; a pruned baseline fails with
  `git.turnSnapshotMissing`. Command mechanics: [git.md](./git.md).

## Snapshot transport

- AgentTurnRequest carries structured attachments; agent/mod.rs validates them before provider setup,
  authorizes owning roots/contained paths and serializes metadata/text as quoted JSON after prompt
  guidance. It neither rereads content nor changes permission/planning state.
- Limits are owned by agent/mod.rs and mirror src/lib/memoryBudget.ts. Old callers may omit attachments.

## Change map and verification

Coordinate Rust emitters, frontend reducers and IPC types; keep native schemas, ownership and cleanup, and
follow [runtime.md](./runtime.md) for settings defaults. Provider/transport and agent tests protect protocol, queues, replies and
usage; native-account compatibility needs explicit verification.
