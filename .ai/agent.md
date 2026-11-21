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
- Tail reports activity/elapsed/confirmation waits; persist completion time and backend duration. Finished
  reopened turns show local HH:mm, live ones omit it. History expansion pauses following.
- Context popup uses provider context/session usage, unaffected by loaded history/drafts. Zero is valid;
  invalid is unavailable. Keep persisted cost fields compatible, without price UI.

## Change map and verification

Coordinate Rust emitters, frontend reducers and IPC types. Preserve native schemas, ownership and cleanup;
settings defaults follow [runtime.md](./runtime.md). Provider/transport and agent tests protect protocol,
queues, replies and usage. Native-account compatibility needs explicit native verification.
