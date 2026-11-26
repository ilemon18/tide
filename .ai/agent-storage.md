---
summary: History, paging and persistence
scope:
  - .ai/agent-storage.md
  - src/store/agent.ts
  - src/store/agent.test.ts
  - src/lib/agentSession.ts
  - src/components/AgentChat*.tsx
  - src/components/AgentHistoryPage*.tsx
  - src-tauri/src/agent/store.rs
  - src-tauri/src/commands/agent.rs
keywords:
  - history
  - persistence
  - paging
  - storage
  - 历史
  - 恢复
  - 分页
  - 持久化
---
# Agent history and persistence

## Ownership

Rust owns locked patches and cursors; the agent store owns loaded pages; `agentSession` restores
primary-window tabs. Keep transcript v:1 compatible.

## Storage

- Open/page/apply/list/clone merge patches, preserve unknown/unloaded data and lock each file. Atomic writes
  reject invalid JSON or >8 MiB without damaging originals; failed closes retry.
- History is an active-project right drawer; only the editor/terminal region narrows.
  Fetch on entry and discard summaries/obsolete reads on exit, root change or disabling
  `agentHistoryEnabled`. The preference is independent of `agentEnabled`.
- Rust authorizes the root, streams summaries without bodies, filters trimmed case-insensitive literal title
  matches (IDs are not searchable), sorts updated-time/ID descending, then pages with filtered
  total/nextOffset. Keep one page of 15 (`AGENT_HISTORY_PAGE_SIZE` in `src/store/agent.ts`). Search resets to
  page one; IME debounce belongs to `AgentHistoryPage`. Load bodies on selection.
- Restore locks duplicates, revalidates root/lifetime/page epoch, preserves native options/pending gates and
  never sends.
- Restore focuses an existing target, else the active same-root blank tab, then the last-focused blank, else
  the Agent split rule; native session IDs preserve continuation. `isBlankChat` rejects transcript, pages,
  session, summary, usage, drafts, queues and conflicting transactions; recheck after loading and preserve
  pane/position/pinning.
- History deletion confirms (Enter confirms only this dialog) and rejects running chats; Rust validates
  project ownership under the document lock. The drawer removes the row optimistically while the frontend
  drains writes and invalidates reads. Failure restores only that row; success preserves keyword/page and
  falls back one page only when its last row was removed.
- Initial page: 80 records/512 KiB, then 40/load. Loaded window: 160 records/1 MiB. Persist before
  eviction/navigation, retain cursors/anchor, scan pending cards across full history and
  flush `agent/tabs.json` on hide/unload. Only completed questions establish a persisted gate. In-place
  `/new` resets the complete persisted message list while keeping chat id.

## Snapshot persistence

- Replies snapshot optional `provider`; switches retain attribution. Keep v:1, discard invalid values and
  preserve the field through paging, reopen and cloning.
- Sent attachments preserve exact capture text/metadata through atomic patches, paging, eviction, reopen and
  cloning. Keep v:1; absent means none. `normalizeChat` rejects malformed records and Rust preserves unknown
  fields. Draft/queued attachments live in memory: tab switches retain them, closing releases them.

## Change map

Align Rust/IPC/frontend DTOs; partial saves retain unloaded records. Actions:
[agent-composer.md](./agent-composer.md); runs: [agent.md](./agent.md); gate: [checks.md](./checks.md).
