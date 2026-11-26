---
summary: Input, mentions, questions and plans
scope:
  - .ai/agent-composer.md
  - src/store/agent.ts
  - src/store/agent.test.ts
  - src/lib/agentCommand*.ts
  - src/lib/agentMentions*.ts
  - src/components/AgentComposer*.tsx
  - src/components/AgentPickers*.tsx
  - src/components/AgentTags*.tsx
  - src/components/AgentChat*.tsx
  - src-tauri/src/agent/question.rs
  - src-tauri/src/agent/skills.rs
  - src-tauri/src/commands/agent.rs
  - src/lib/agentContext*.ts
  - src/lib/contextSelection*.ts
  - src/lib/commands*.ts
  - src/components/AgentAttachments*.tsx
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

Composer/pickers own edits/selections; `agentCommand` builds guidance; the agent store owns cards, actions and
queue gates. Rust parses questions and scans skills. Provider changes follow [agent.md](./agent.md);
persistence follows [agent-storage.md](./agent-storage.md).

## Input

- Enter/Ctrl+Enter/Cmd+Enter sends; Shift+Enter inserts a line. Candidate Enter commits first. Composition,
  `isComposing`, keyCode 229 and WebKit post-composition Enter precede completion/send/delete. Repeated Enter
  never duplicates queue entries; preserve body whitespace.
- The composer starts at 90px and grows to min(480px, half-window); larger saved minima are preserved and
  smaller ones normalize up. Height owners: `settings.ts`/`theme.rs`.
- The nearest `/`, `$` or `@` wins; slash/mention need a boundary and skills reject a preceding word or `$`.
  Mentions show eight ranked matches with real metadata winning over inferred ancestors, reject obsolete
  reads and preserve `{rel,isDir}` chips.
- Sends atomically append messages, start running and consume the draft before awaits; failures restore the
  original only if its replacement is untouched and the run still owns the chat. Edits, queues and
  reset/close invalidate recovery.

## Questions and plans

- `<TIDE_QUESTION>` allows one marker per turn, nonempty header/question, 2–4 labelled/described options and
  optional multi-select/custom answer. Preserve order, hide partial markers, and restore invalid markers with
  a notice. Blank answers block sending once the turn completes.
- A structured question streams header/body in order; options, custom input and the gate stay hidden until it
  completes. Answer submission claims the question and awaits the follow-up launch; failure restores the
  pending answer/page gate without replacing newer content and keeps selections for retry. Duplicate submits
  never start a run.
- Successful planning creates `plan-<message>`; questions take precedence. Implement-current resumes
  writable; implement-fresh clears transcript/session and launches in the same tab; continue-planning is
  read-only. Persist action/result/target before launch, lock duplicates and restore the card after failure.
  Plan options follow Codex copy and order; preserve action IDs.
- Commands: `/new`, `/resume [chat ID]`, `/fork`, `/compact`, `/status`, `/model [ID|default]`,
  `/permissions`, `/plan`, `/goal`, `/review`, `/test`, `/explain`, `/help`. Local commands never reach the
  model; prompt commands are wrapped as tags. `/new` resets in place and keeps provider/model/permissions;
  `/resume` without an argument opens history.
- `/fork` clones history after capability probing. Empty model/effort sends no flag. `/compact` requires
  idle/no queue/no pending card, keeps the transcript and persists a read-only summary before resetting
  session/context/usage; failure preserves the session.

## Attachments

- Editor/terminal actions append immutable snapshots to a same-root draft and focus it: visible chats first,
  then other chats by last focus, else a new chat. Explain/refactor append instructions without replacing
  text, tags, skills or permissions.
- Draft/user/request attachments are optional for v:1. `snapshotAgentDraft` owns queue/interjection copies;
  adding context never sends, and question/plan gates stay authoritative. `AgentAttachments` renders bounded
  expandable plain-text previews with capture time, copy and removal.
- Limits live in `src/lib/memoryBudget.ts` and Rust `agent/mod.rs`: reject entire additions rather than
  truncating. Validate source root, shape, duplicate ids and UTF-8 sizes before changing a draft or sending.

## Change map

Align prompts, Rust parsing and actions; tests cover IME, streaming, recovery and plans.
Gate: [checks.md](./checks.md).
