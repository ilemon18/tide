---
summary: Input, mentions, questions and plans
scope:
  - .ai/agent-composer.md
  - src/store/agent.ts
  - src/store/agent.test.ts
  - src/lib/agentCommand*.ts
  - src/components/AgentComposer*.tsx
  - src/components/AgentPickers.tsx
  - src/components/AgentTags*.tsx
  - src/components/AgentChat*.tsx
  - src-tauri/src/agent/question.rs
  - src-tauri/src/agent/skills.rs
  - src-tauri/src/commands/agent.rs
keywords:
  - composer
  - input
  - mention
  - question
  - planning
  - plan
  - command
  - 输入
  - 输入法
  - 提及
  - 问题
  - 规划
  - 计划
  - 命令
---
# Agent input and planning

## Ownership

Composer/pickers own edits/selections; agentCommand builds guidance; the agent store owns pending cards,
actions and queue gates. Rust parses questions/scans skills. Provider/model/permission changes also follow
[agent.md](./agent.md); persistence changes follow [agent-storage.md](./agent-storage.md).

## Input contracts

- Keep per-turn guidance concise, preserving workspace/read-only boundaries and the full question contract.
- Enter/Ctrl+Enter/Cmd+Enter sends; Shift+Enter inserts a line. Candidate Enter commits first. Composition
  lifecycle, native isComposing, keyCode 229 and WebKit post-composition Enter precede completion/send/delete.
  Repeated Enter never duplicates queue entries; preserve body whitespace.
- Composer starts at 90px, grows to min(480px, half-window); clamping preserves larger saved minima.
  Height owners: `src/store/settings.ts` and `src-tauri/src/commands/theme.rs`; older smaller minima normalize up.
  Nearest /, $ or @ wins. Slash/mention need a boundary; skills reject preceding word/$; $5 stays prose.
  Mentions show eight fuzzy matches, preserve {rel,isDir} chips and queued references. Scan project/user
  skills lazily, cache results, keep plan tags single.
- A new conversation centers its workspace heading above one complete accent-bordered composer. Messages,
  persisted history/pages, loading, running, existing sessions or queued sends keep the transcript/footer layout.
  First send changes layout without remounting the composer; provider/error guidance remains visible.

## Questions and plan transactions

- `<TIDE_QUESTION>`: one marker/turn, nonempty header/question, 2–4 labelled/described options, optional
  multi-select/custom answer. Preserve order; hide partial markers until flush; invalid markers restore
  source plus notice. Blank answers block sending.
- Successful planning without questions creates plan-<message>; questions take precedence. Implement-current
  resumes writable; implement-fresh isolates a same-root tab with plan/fixed preamble; continue-planning is
  read-only. Persist action/result/target before launch, lock duplicates, retry same target, never run on hydration.
- Plan options use Codex's official English copy/order, translated consistently across all catalogs:
  “Yes, implement this plan”; “Yes, clear context and implement”; “No, stay in Plan mode”.
  Source: [Codex plan_implementation.rs, commit 63a15005](https://github.com/openai/codex/blob/63a15005de43a3db68d451403593b202ed337d20/codex-rs/tui/src/chatwidget/plan_implementation.rs).
  Copy maps to existing persisted action IDs; clear-context execution starts a fresh same-root chat carrying the plan.
- Local /new, project-scoped /resume [chat ID], /model [ID|default], three-mode /permissions, /status and
  /help never reach the model. Missing arguments open selectors; invalid ones report errors.
- /fork clones saved history after capability probing (Claude --fork-session; Codex app-server/RPC validation).
  Failure preserves clone/parent boundaries with explicit fresh-session restart. Empty model/effort sends no
  flag, preserving CLI/per-chat defaults.
- /compact requires idle/no queue/no pending card. Keep transcript; atomically persist read-only summary
  before session/context/usage reset. Summary becomes new-session preamble; failure preserves session.

## Change map and verification

Align prompt construction, Rust parser, UI cards and saved actions. Existing tests protect IME/chip boundaries,
read-only guidance, questions, plan persistence, duplicate actions and retries. Real IME/native approval
verification requires an explicit request; gate policy: [checks.md](./checks.md).
