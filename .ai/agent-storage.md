---
summary: History, paging and persistence
scope:
  - .ai/agent-storage.md
  - src/store/agent.ts
  - src/store/agent.test.ts
  - src/lib/agentSession.ts
  - src/components/AgentChat*.tsx
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

Rust agent/store owns locked patches/cursors; the frontend agent store owns loaded pages; agentSession
restores primary-window tabs. Keep transcript v:1 compatible.

## Storage contracts

- Open/page/apply/list/clone merge patches, preserve unknown/unloaded data and lock each file. Atomic writes
  reject invalid JSON or >8 MiB without damaging originals; failed close writes retry.
- Project history lists are fetched only when opened, authorize/filter by the owning root, and return five
  summaries per page in updated-time order (`AGENT_HISTORY_PAGE_SIZE` in `src/store/agent.ts`). Transcript
  pages remain independently lazy-loaded on selection; project-root restore validates the saved root again.
  Flush open chats before listing so a new turn is visible immediately, but discard the list when its panel closes.
- Initial page: 80 records/512 KiB, then 40/load. Loaded window: 160 records/1 MiB; oversized record alone.
  Persist before eviction/navigation; retain cursors/anchor, scan pending cards across full history, flush
  agent/tabs.json on hide/unload. Eviction/reopen never loses question/plan send gates. In-place /new uses
  an atomic chat reset that clears the complete persisted message list, including unloaded history, while
  retaining the chat id and header identity.

## Change map and verification

Coordinate Rust/IPC/frontend DTOs. Saving a partial page preserves unloaded records; compact/reset preserves
transcript. Action transactions: [agent-composer.md](./agent-composer.md). Run ownership: [agent.md](./agent.md).
Rust tests cover corrupt/oversized input, concurrent patches, cursors/budgets; store tests cover eviction,
failed-close retry/reopen. Gate policy: [checks.md](./checks.md).
