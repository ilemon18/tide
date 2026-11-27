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

CLIs own auth/models/tools; Rust owns processes; the agent store owns queues/UI. New chats refresh the model
catalog in the background; empty/failed probes never clear the saved model. Input:
[agent-composer.md](./agent-composer.md); history: [agent-storage.md](./agent-storage.md).

store/agent.ts 同时承载 turns、history、composer 状态，改动前按小节判断。

## Turns and events

- `agent_send` authorizes the root and launches with the prompt on stdin. Rust owns four-turn concurrency, one
  turn per chat and process-group cleanup; reap before Done and release only the matching run. EOF/error never
  means success. Codex uses app-server initialize/thread/turn; Claude uses stream-json with stdio approvals.
  `transport.rs` keeps stdin writable; native schemas govern.
- Run ID/sequence reject stale events. `agentEvents` batches text/thinking/tools, flushes before
  structure/end, replaces snapshots and deduplicates Claude blocks. Caps preserve Unicode and mark truncation.
- Running sends enter a FIFO queue; success drains without erasing newer drafts and failure keeps
  session/queue. Completed questions and unresolved plans block sends; incomplete/failed streams do not.
  Queued cards interject: wait for the old launch, cancel, wait for Done, then launch; Edit appends to the
  composer. A running chat cannot close through any path; teardown may force-clean.

## Permissions

- Persist `permissionMode=read-only/workspace-write/full-access`; legacy missing stays writable. Explicit
  choices update defaults and new chats inherit. Restore/hydration/provider fallback never overwrite
  preferences; plan/question/compact/execution choices never become defaults. Plan/question follow-ups force
  read-only and runs lock model/effort/permissions.
- Mapping: Codex read-only/never, workspace-write/on-request, danger-full-access/never; Claude plan,
  acceptEdits, bypassPermissions. Native restrictions still apply; Claude modes are not OS sandboxes.
  Allow-once/deny cards validate window/run/request ownership and single use, persist before responding and
  last one turn.

## Replies and usage

- Tab failures override completion. Replies use GFM/code-copy, reject HTML/remote images and accept only
  contained owning-root file links (`:line:col`/`#LlineCcol`). Entries respect `agentEnabled`; items keep
  source order and expansion. Output folds show the provider; user bubbles show `agent.you`; copies omit
  speaker labels.
- Each pane keeps the active chat plus one previous chat mounted through React `Activity`; the limit lives
  in `ChatPaneHost.tsx`. Hidden chats retain DOM/state, release effects and follow observers, and resume at
  the latest message when shown again, so switching through files must not rebuild a transcript.
- Following pauses on upward gestures or scrollbar presses and resumes on send/completion. The tail owns its
  one-second clock; the context ring uses the current snapshot while token rows show native session
  cumulative usage. Zero is valid; invalid is unavailable.

## Turn changes and undo

- Write-capable turns snapshot before spawn and after reaping; `turnChanges` precedes `done`, so the summary
  joins the message and a queued turn cannot leak writes.
- The card shows per-file status, nonzero numstat counts and spaced rows (200-row cap; truncation disables
  undo), opens the unstaged diff and offers undo only on the latest message. Undo restores listed rows through
  the Git store, never rewrites commits or touches unlisted paths; a pruned baseline fails with
  `git.turnSnapshotMissing`. Mechanics: [git.md](./git.md).

## Snapshot transport

- `AgentTurnRequest` carries attachments; `agent/mod.rs` validates them before provider setup, authorizes
  roots/paths and serializes metadata/text as quoted JSON. Limits live in `agent/mod.rs` and mirror
  `src/lib/memoryBudget.ts`; old callers may omit attachments.

## Change map

Coordinate Rust emitters, reducers and IPC types; keep schemas and cleanup. Gate: [checks.md](./checks.md).
