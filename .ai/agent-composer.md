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
- Enter/Ctrl+Enter/Cmd+Enter sends; Shift+Enter inserts a line. Candidate Enter commits first. Composition
  lifecycle, native isComposing, keyCode 229 and WebKit post-composition Enter precede completion/send/delete.
  Repeated Enter never duplicates queue entries; preserve body whitespace.
  Send tooltips contain only the localized Enter hint; pending-card guidance stays in the input placeholder.
- Composer starts at 90px, grows to min(480px, half-window); clamping preserves larger saved minima.
  Height owners: `src/store/settings.ts` and `src-tauri/src/commands/theme.rs`; older smaller minima normalize up.
  Nearest /, $ or @ wins. Slash/mention need a boundary; skills reject preceding word/$; $5 stays prose.
  Mentions show eight ranked file/folder matches from indexed ancestors, cached tree entries and lazy
  paged directory reads (including empty folders). Real metadata overrides inferred ancestors; confirm
  directories before selection, reject obsolete reads/selections and preserve {rel,isDir} chips/queues.
  A bare / opens commands at a boundary. Keep the stable frequency order, at most eight visible command
  rows and the full list available to scrolling/Arrow Up/Down. Local picks place the caret after the command.
  Candidate overlays share a height cap measured below the chat header, remeasure on resize/scroll/content
  changes and scroll the active item into view without resizing the composer/footer. Popup/row limits live
  in `src/components/AgentComposer.tsx`. Scan project/user skills lazily, cache results, keep plan tags single.
- Empty chats center a workspace heading above one accent-bordered composer. Messages/history, loading,
  running, sessions or queues use the transcript/footer layout; transitions retain the composer and guidance.
- Sends atomically append messages, start running and consume the matching draft before save/launch awaits.
  Failures restore the original only if its empty replacement is untouched and the run still owns the chat;
  edits, queues and reset/close invalidate recovery. Queue/card follow-ups preserve drafts.
- The footer permission picker shows its mode icon, localized mode name and dropdown arrow only when the
  entire label fits; otherwise it uses the compact icon button. Measure the full intrinsic content separately
  from the allocated slot to avoid resize oscillation; mode/locale/font changes update the measurement.
  Tooltip/accessibility retain the full name and menus retain provider descriptions. The toolbar stays on
  one row, send/stop controls keep their space and long model names truncate.

## Questions and plan transactions

- `<TIDE_QUESTION>`: one marker/turn, nonempty header/question, 2–4 labelled/described options, optional
  multi-select/custom answer. Preserve order; hide partial markers until flush; invalid markers restore
  source plus notice. Blank answers block sending once the turn has completed.
- Every structured question may stream its header/body in source order, but its options, custom-answer
  input and pending gate remain hidden until the turn completes successfully. While the question is
  incomplete, drafts can continue and running sends follow FIFO queue behavior. Answer submission claims
  the completed question synchronously and awaits the actual follow-up launch. Failed/rejected launches
  restore the pending answer/page gate without replacing newer message content; all submission outcomes
  release local locks, preserving selections/custom text for retry. Follow-ups retain the source
  planning/read-only boundary; duplicate submits never start a second run.
- Successful planning without questions creates plan-<message>; questions take precedence. Implement-current
  resumes writable; implement-fresh clears the current chat tab's transcript/session and launches the plan
  with a fresh provider session in that same tab; continue-planning is read-only. Persist action/result/target
  before launch, lock duplicates, restore the plan card after a reset/launch failure for retry, and never run
  on hydration.
- Plan options follow Codex copy/order in all catalogs:
  “Yes, implement this plan”; “Yes, clear context and implement”; “No, stay in Plan mode”.
  Source: [Codex plan_implementation.rs, commit 63a15005](https://github.com/openai/codex/blob/63a15005de43a3db68d451403593b202ed337d20/codex-rs/tui/src/chatwidget/plan_implementation.rs).
  Preserve persisted action IDs. Clear-context passes the plan into a fresh session in the same tab.
  Optional instructions follow all three buttons and accompany the selected action.
- The complete command set is /new, /resume [chat ID], /fork, /compact, /status, /model [ID|default],
  /permissions, /plan, /goal, /review, /test, /explain and /help. Local /new resets the current chat tab
  in place, clears its transcript/session context and keeps the selected provider/model/permissions.
  Local commands never reach the model; prompt commands are wrapped and sent as their matching tags.
  Argument-less /resume opens the project history drawer; other missing arguments open selectors.
  Invalid arguments report errors.
- /fork clones saved history after capability probing (Claude --fork-session; Codex app-server/RPC validation).
  Failure preserves clone/parent boundaries with explicit fresh-session restart. Empty model/effort sends no
  flag, preserving CLI/per-chat defaults.
- /compact requires idle/no queue/no pending card. Keep transcript; atomically persist read-only summary
  before session/context/usage reset. Summary becomes new-session preamble; failure preserves session.

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
