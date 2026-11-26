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

Rust owns locked patches/cursors; the agent store owns loaded pages; agentSession restores primary-window
tabs. Keep transcript v:1 compatible.

## Storage contracts

- Open/page/apply/list/clone merge patches, preserve unknown/unloaded data and lock each file. Atomic writes
  reject invalid JSON or >8 MiB without damaging originals; failed closes retry.
- History is an active-project right drawer (chat header, /resume); only the editor/terminal
  region narrows. Fetch on entry; discard
  summaries/obsolete reads on exit, root change or disabling agentHistoryEnabled. Its preference is
  independent of agentEnabled.
- Rust authorizes the root, streams summaries without bodies, filters trimmed case-insensitive
  literal title matches (IDs are not searchable), sorts updated-time/ID descending, then pages with filtered
  total/nextOffset.
  Keep one page of 15 (`AGENT_HISTORY_PAGE_SIZE` in src/store/agent.ts). Search resets to page one; IME
  debounce belongs to AgentHistoryPage. Flush accepted open/closing writes first; load bodies on selection.
- Rows use AgentProviderIcon with unknown fallback, the title (New chat when empty) and a 30s relative age;
  the tooltip is the absolute time. Provider names/chat IDs are hidden.
  Restore locks duplicates, revalidates root/lifetime/page epoch, preserves native options/pending gates and
  never sends. Drawer transitions invalidate restores; restore closes.
- Restore focuses an existing target, else the active same-root blank tab, then the last-focused blank, else
  the Agent split rule. Native session IDs preserve provider continuation. isBlankChat rejects transcript/pages/session/summary/usage, drafts with
  text/attachments/mentions/commands/skills, queues and conflicting transactions. Recheck after loading;
  replace the reference, preserve pane/position/pinning and release the placeholder.
- History deletion requires confirmation; Enter confirms only this dialog (Cancel keeps cancellation); other
  confirmations keep default keyboard behavior. Frontend/Rust reject running chats; Rust validates
  project ownership under the document lock. The drawer optimistically removes the row and locks the chat while the
  frontend drains writes, invalidates reads/save callbacks, clears transcript/draft/queue/page/retry and closes
  any open tab without another save. Failure restores only that row and keeps the record/tab retryable; success
  preserves keyword/page and silently falls back one page only when its last row was removed.
- Initial page: 80 records/512 KiB, then 40/load. Loaded window: 160 records/1 MiB; oversized record alone.
  Persist before eviction/navigation; retain cursors/anchor, scan pending cards across full history, flush
  agent/tabs.json on hide/unload. Only completed questions establish a persisted question gate; streamed
  `complete: false` items remain visible without blocking; legacy questions without it stay compatible. Eviction/reopen never loses question/plan send gates. In-place /new atomically resets the
  complete persisted message list, including unloaded history, keeping the chat id and header identity.

## Snapshot persistence

- Replies snapshot optional `provider`; switches retain attribution. Keep v:1, discard invalid values and
  preserve the field through paging, reopen and cloning.
- Sent user-message attachments preserve exact capture text/metadata through atomic patches, paging,
  eviction, reopen and cloning. Keep v:1; absent attachments mean none. normalizeChat rejects malformed
  attachment records before rendering; Rust preserves unknown message fields.
- Draft and queued attachments follow existing in-memory lifetime: tab switches retain them; closing the
  chat releases them. No unsent attachment recovery after restart is promised.

## Change map and verification

Align Rust/IPC/frontend DTOs; partial saves retain unloaded records. Actions: [agent-composer.md](./agent-composer.md);
run ownership: [agent.md](./agent.md). Rust tests cover corrupt/oversized input, concurrent patches,
cursors/budgets; store tests cover eviction, failed-close retry/reopen. Gate: [checks.md](./checks.md).
