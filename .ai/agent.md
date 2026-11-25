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

CLIs own auth/models/tools; Rust owns processes; the agent store owns queues/UI. Every new chat forces
`loadCatalog(provider, true)` in the background: concurrent requests coalesce with one owed force run,
and a non-empty refreshed catalog repairs session defaults (and blank idle chats) whose model disappeared.
An empty/failed probe never clears the saved model. Input/plans:
[agent-composer.md](./agent-composer.md). History: [agent-storage.md](./agent-storage.md).

## Turns and events

- agent_send authorizes root, launches there with prompt on stdin. Rust owns four-turn concurrency,
  one turn/chat and process-group cleanup on stop/close/exit/disable. Reap before Done, release only the
  matching run. EOF/error never means success.
- Codex uses app-server initialize/thread/turn; Claude uses bidirectional stream-json/stdio approvals.
  transport.rs keeps stdin writable, bounds handshake and closes completed processes. Native schemas
  govern; unsupported protocols require upgrade, never whole-response fallback.
- Run ID/sequence reject stale/completed events; upsert IDs. agentEvents batches text/thinking/tools,
  flushes before structure/end, replaces snapshots and deduplicates Claude blocks. Caps preserve Unicode
  and mark truncation; grapheme smoothing preserves stored/copied bytes.
- Running sends enter FIFO queue, never process stdin. Success drains without erasing newer drafts;
  failure keeps session/queue. Completed unanswered questions and unresolved plans block sends/drain
  across pages; an incomplete or failed/cancelled streamed question does not establish a gate.
- A queued card can interject: wait for the old launch, cancel, then wait for its Done before launching the
  selection. Edit appends its text/metadata to the composer (existing command wins), removes the entry and
  focuses the composer. Lock duplicate actions/drain; preserve order, metadata and newer drafts. Cancel/launch
  failure retains the selection; pending question/plan gates still apply.
- A chat tab with a running turn cannot be closed through the tab button, middle-click, context menu, bulk
  close, or shortcut. The tab store rejects non-force close requests before stopping the run; task teardown
  may use force cleanup. The guard lifts on Done, stop, error, or cancellation.

## Permissions and preferences

- Persist permissionMode=read-only/workspace-write/full-access; legacy missing stays writable. Explicit
  picker/local-command choices update defaults immediately; new chats inherit. Model changes save
  compatible effort, including empty Default (CLI config). Restore/hydration/provider fallback never
  overwrite preferences; restored chats retain options. Temporary plan/question/compact/execution choices
  never become defaults. Plan/question follow-ups force read-only; runs lock model/effort/permissions.
  Menu and /permissions share a setter.
- Codex maps modes to read-only/never, workspace-write/on-request, danger-full-access/never; Claude to
  plan, acceptEdits, bypassPermissions. Native/organization restrictions still apply; Claude modes are not
  OS sandboxes. Ordered allow-once/deny cards validate window/run/request ownership and single use in Rust.
  Grants last one turn; persist before responding. Read-only rejects escalation. Stop/done/recovery expire
  cards; waiting blocks drain; failed question launch restores the card. Permission queries/compact never create plans.

## Replies and usage

- Tab failures override completion. Replies use GFM/code-copy, reject HTML/remote images and accept only
  contained owning-root file links (`:line:col`/`#LlineCcol`). Entry points respect agentEnabled; tree double-click
  stays a tree gesture. Items preserve source order, reconcile IDs and retain expansion.
- Output folds show reply provider names (catalog, then Codex/Claude Code or ID); legacy replies use the chat
  provider. Retain expansion/copy. User bubbles show `agent.you`; copies omit speaker labels.
- History opens for the active project in a non-modal right-side drawer; only the editor region narrows. It
  validates roots on resume; native session IDs preserve provider continuation. Its preference is
  independent from agentEnabled.
- Tail reports activity/elapsed/confirmation waits; persist completion time and backend duration. Finished
  reopened turns show local HH:mm, live ones omit it. History expansion pauses following.
- Tail status receives primitive fields and owns its one-second clock; streamed Markdown/tools never remount
  it. AgentSpinner rotates a fixed HTML box separately from SVG painting. Live replies use visible rendering;
  only inactive messages use automatic skipped-content rendering.
- The configurable context.openOrLatest action (default Mod+Down) jumps only in the active chat, respecting
  overlays and IME; its other focus context opens a file-tree row. Jumping loads the latest
  history page first. Sends and successful interjections resume following after transcript commits, through
  deferred content/viewport resizing and final completion layout. A running-to-finished transition also
  re-enables following and anchors the completed reply at the latest bottom after deferred layout. Upward
  reading gestures and direct scrollbar presses pause following. Layout-generated scroll events, including
  upward offsets after content shrink/regrowth, never clear that intent and schedule another bottom anchor.
  First-send layout changes and queue/composer resizing retain following. Queued cards use the lighter panel surface.
  Observe transcript text/child mutations as well as box resizing so deferred stream smoothing and Markdown
  code/table formatting anchor the latest bottom after rendering; these commits respect paused following.
- Context popup uses provider context/session usage, unaffected by loaded history/drafts. The context ring
  uses the current context snapshot, while token rows show only the current native session cumulative usage;
  latest-turn token details are not displayed. Zero is valid; invalid is unavailable. Keep persisted cost
  fields compatible, without price UI.

- Composer permission state comes from its picker/cards, without a duplicate plan/read-only line.
  Settings → Agent shows all installed providers and five uninstalled (More reveals the rest), plus the
  history toggle. Permission defaults/explanation stay hidden there; chat permission controls remain.

## Snapshot transport

- AgentTurnRequest carries structured attachments. agent/mod.rs validates them before provider setup,
  authorizes their owning root and contained relative paths, and serializes metadata/text as quoted JSON
  context after prompt guidance. It does not reread snapshot content or change permission/planning state.
- Request count/byte limits are owned by agent/mod.rs and mirror src/lib/memoryBudget.ts. Old callers
  omit attachments safely. Provider test request fixtures include the new field.

## Change map and verification

Coordinate Rust emitters, frontend reducers and IPC types. Preserve native schemas, ownership and cleanup;
settings defaults follow [runtime.md](./runtime.md). Provider/transport and agent tests protect protocol,
queues, replies and usage. Native-account compatibility needs explicit native verification.
