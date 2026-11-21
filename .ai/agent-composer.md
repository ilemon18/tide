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
- Composer starts at 60px (v10), grows to min(480px, half-window); clamping preserves its saved minimum.
  Nearest /, $ or @ wins. Slash/mention need a boundary; skills reject preceding word/$; $5 stays prose.
  Mentions show eight fuzzy matches, preserve {rel,isDir} chips and queued references. Scan project/user
  skills lazily, cache results, keep plan tags single.

## Questions and plan transactions

- `<TIDE_QUESTION>`: one marker/turn, nonempty header/question, 2–4 labelled/described options, optional
  multi-select/custom answer. Preserve order; hide partial markers until flush; invalid markers restore
  source plus notice. Blank answers block sending.
- Successful planning without questions creates plan-<message>; questions take precedence. Implement-current
  resumes writable; implement-fresh isolates a same-root tab with plan/fixed preamble; continue-planning is
  read-only. Persist action/result/target before launch, lock duplicates, retry same target, never run on hydration.
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
