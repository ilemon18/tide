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

CLIs own auth/models/tools; Rust owns processes; the agent store owns queues/UI. Input/plans:
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
  failure keeps session/queue. Unanswered questions/plans block sends/drain across pages.
- A queued card can explicitly interject: wait for the old launch, request cancellation, then wait for its
  matching Done before launching the selected entry. Lock duplicate actions and automatic drain during the
  transaction; preserve other entries' relative order, metadata and newer composer drafts. Cancel/launch
  failure retains the selected entry and reports the error; pending question/plan gates still apply.

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
- History opens on demand for the active project and validates roots on resume; native session IDs preserve
  provider continuation. Its preference is independent from agentEnabled.
- Tail reports activity/elapsed/confirmation waits; persist completion time and backend duration. Finished
  reopened turns show local HH:mm, live ones omit it. History expansion pauses following.
- The live tail status is isolated from streamed assistant content and receives primitive status fields, so
  markdown/tool updates do not remount or flash the elapsed line. Its own one-second clock remains local.
  AgentSpinner rotates a fixed HTML box on the compositor, keeping SVG painting separate. The live reply
  uses visible content rendering; only inactive messages use automatic skipped-content rendering.
- Cmd+Down/Ctrl+Down jumps only in the active chat, respecting overlays and IME. Jumping loads the latest
  history page first. Sends and successful interjections resume following after transcript commits, through
  deferred content/viewport resizing and final completion layout. Upward reading gestures pause following;
  content-growth scroll events alone never clear that intent. Queued cards use the lighter panel surface.
- Context popup uses provider context/session usage, unaffected by loaded history/drafts. The context ring
  uses the current context snapshot, while token rows show only the current native session cumulative usage;
  latest-turn token details are not displayed. Zero is valid; invalid is unavailable. Keep persisted cost
  fields compatible, without price UI.

- The composer no longer repeats a plan/read-only permission line above its footer; the permission picker
  and permission request cards remain authoritative. Settings → Agent keeps all installed providers visible,
  shows the first five uninstalled providers by default, and reveals the rest through a More control.

## Change map and verification

Coordinate Rust emitters, frontend reducers and IPC types. Preserve native schemas, ownership and cleanup;
settings defaults follow [runtime.md](./runtime.md). Provider/transport and agent tests protect protocol,
queues, replies and usage. Native-account compatibility needs explicit native verification.
