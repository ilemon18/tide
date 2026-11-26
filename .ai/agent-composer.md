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

Composer/pickers own edits/selections; agentCommand builds guidance; the agent store owns pending cards,
actions and queue gates. Rust parses questions/scans skills. Provider/model/permission changes also follow
[agent.md](./agent.md); persistence changes follow [agent-storage.md](./agent-storage.md).

## Input contracts

- Keep per-turn guidance concise, preserving workspace/read-only boundaries and the full question contract.
- Enter/Ctrl+Enter/Cmd+Enter sends; Shift+Enter inserts a line. Candidate Enter commits first. Composition,
  native isComposing, keyCode 229 and WebKit post-composition Enter precede completion/send/delete.
  Repeated Enter never duplicates queue entries; preserve body whitespace.
  Send tooltips contain only the localized Enter hint; pending-card guidance stays in the input placeholder.
- Composer starts at 90px and grows to min(480px, half-window); clamping preserves larger saved minima.
  Height owners: `src/store/settings.ts` and `src-tauri/src/commands/theme.rs`; smaller minima normalize up.
  Nearest /, $ or @ wins. Slash/mention need a boundary; skills reject preceding word/$; $5 stays prose.
  Mentions show eight ranked file/folder matches from indexed ancestors, cached tree entries and lazy
  paged directory reads (including empty folders). Real metadata overrides inferred ancestors; confirm
  directories before selection, reject obsolete reads/selections and preserve {rel,isDir} chips/queues.
  A bare / opens commands at a boundary. Keep stable frequency order, at most eight visible rows and the
  full list scrollable/Arrow Up/Down. Local picks place the caret after the command.
  Candidate overlays share a cap below the chat header, remeasure on resize/scroll/content change and scroll
  the active item into view without resizing the composer/footer. Limits live in
  `src/components/AgentComposer.tsx`. Scan project/user skills lazily, cache results, keep plan tags single.
- Empty chats center a workspace heading above one accent-bordered composer; messages/history, loading,
  running, sessions or queues use the transcript/footer layout, and transitions retain composer and guidance.
- Sends atomically append messages, start running and consume the draft before save/launch awaits. Failures
  restore the original only if its empty replacement is untouched and the run still owns the chat; edits,
  queues and reset/close invalidate recovery. Queue/card follow-ups keep drafts.
- The footer permission picker shows icon, mode name and arrow only when the label fits, else a compact
  icon button; measure intrinsic content apart from the slot to avoid resize oscillation, updating on
  mode/locale/font. Tooltips/accessibility keep the full name and menus provider descriptions; the toolbar stays one row,
  send/stop keep space and long model names truncate.

## Questions and plan transactions

- `<TIDE_QUESTION>`: one marker/turn, nonempty header/question, 2–4 labelled/described options, optional
  multi-select/custom answer. Preserve order; hide partial markers until flush; invalid markers restore
  source plus notice. Blank answers block sending once the turn has completed.
- A structured question streams header/body in order; options, custom-answer input and the gate stay hidden
  until it completes successfully. While incomplete, drafts continue and running sends follow the FIFO queue.
  Answer submission claims the completed question and awaits the follow-up launch; failed/rejected launches
  restore the pending answer/page gate without replacing newer content, and all outcomes release local locks
  while preserving selections/custom text for retry. Follow-ups keep the source planning/read-only boundary;
  duplicate submits never start a second run.
- Successful planning without questions creates plan-<message>; questions take precedence. Implement-current
  resumes writable; implement-fresh clears the chat tab's transcript/session and launches the plan in that
  same tab; continue-planning is read-only. Persist action/result/target
  before launch, lock duplicates, restore the plan card after a reset/launch failure for retry, and never run
  on hydration.
- Plan options follow Codex copy/order in all catalogs:
  “Yes, implement this plan”; “Yes, clear context and implement”; “No, stay in Plan mode”.
  Source: [plan_implementation.rs, 63a15005](https://github.com/openai/codex/blob/63a15005de43a3db68d451403593b202ed337d20/codex-rs/tui/src/chatwidget/plan_implementation.rs).
  Preserve persisted action IDs. Clear-context passes the plan into a fresh session in the same tab.
  Optional instructions follow all actions; cards flat, accent primary/selected.
- The complete command set is /new, /resume [chat ID], /fork, /compact, /status, /model [ID|default],
  /permissions, /plan, /goal, /review, /test, /explain and /help. Local /new resets the chat tab in place,
  clearing transcript/session but keeping provider/model/permissions. Local commands never reach the model;
  prompt commands are wrapped and sent as their tags. Argument-less /resume opens the history drawer; other
  missing arguments open selectors, and invalid arguments report errors.
- /fork clones saved history after capability probing (Claude --fork-session; Codex app-server/RPC validation).
  Failure preserves clone/parent boundaries with explicit fresh-session restart. Empty model/effort sends no
  flag, keeping CLI/per-chat defaults.
- /compact requires idle/no queue/no pending card. Keep transcript; persist a read-only summary atomically
  before session/context/usage reset. It becomes the new-session preamble; failure preserves session.

## Context attachments

- Editor/terminal actions append immutable snapshots to a same-root draft and focus it: visible chats first,
  then other open chats by last focus, else a new chat.
  Explain/refactor append editable instructions without replacing text, tags, skills or permissions.
- Draft/user-message/request attachments are optional for v:1 compatibility. snapshotAgentDraft owns
  queue/interjection copies; adding context never sends. Existing question/plan gates remain authoritative.
- AgentAttachments renders bounded, expandable plain-text previews with capture time, copy and removal.
  Queue/user-turn copies include snapshot text and source metadata.
- Limits live in src/lib/memoryBudget.ts and Rust agent/mod.rs: reject entire additions rather than
  truncating. Validate source root, shape, duplicate ids and UTF-8 sizes before changing a draft or sending.

## Change map and verification

Align prompts, Rust parsing, cards and saved actions. Tests cover IME/chips, read-only guidance, streaming
questions and launch recovery, plans, duplicate actions/retries and permission pickers.
Native IME/approval checks require a request; gate policy: [checks.md](./checks.md).
