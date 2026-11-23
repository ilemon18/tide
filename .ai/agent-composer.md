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
- A new conversation centers its workspace heading above one complete accent-bordered composer. Messages,
  persisted history/pages, loading, running, existing sessions or queued sends keep the transcript/footer layout.
  First send changes layout without remounting the composer; provider/error guidance remains visible.
- The footer permission picker shows its mode icon, localized mode name and dropdown arrow only when the
  entire label fits; otherwise it uses the compact icon button. Measure the full intrinsic content separately
  from the allocated slot to avoid resize oscillation; mode/locale/font changes update the measurement.
  Tooltip/accessibility retain the full name and menus retain provider descriptions. The toolbar stays on
  one row, send/stop controls keep their space and long model names truncate.

## Questions and plan transactions

- `<TIDE_QUESTION>`: one marker/turn, nonempty header/question, 2–4 labelled/described options, optional
  multi-select/custom answer. Preserve order; hide partial markers until flush; invalid markers restore
  source plus notice. Blank answers block sending.
- The active question permits option/custom-answer edits during streaming; submission waits for the turn
  to finish. Answer submission claims the question synchronously and awaits the actual follow-up launch.
  Failed/rejected launches restore the pending answer/page gate without replacing newer message content;
  all submission outcomes release local locks, preserving selections/custom text for retry. Follow-ups
  retain the source planning/read-only boundary; duplicate submits never start a second run.
- Successful planning without questions creates plan-<message>; questions take precedence. Implement-current
  resumes writable; implement-fresh isolates a same-root tab with plan/fixed preamble; continue-planning is
  read-only. Persist action/result/target before launch, lock duplicates, retry same target, never run on hydration.
- Plan options use Codex's official English copy/order, translated consistently across all catalogs:
  “Yes, implement this plan”; “Yes, clear context and implement”; “No, stay in Plan mode”.
  Source: [Codex plan_implementation.rs, commit 63a15005](https://github.com/openai/codex/blob/63a15005de43a3db68d451403593b202ed337d20/codex-rs/tui/src/chatwidget/plan_implementation.rs).
  Copy maps to existing persisted action IDs; clear-context execution starts a fresh same-root chat carrying the plan.
  Optional instructions follow all three action buttons and accompany the selected action.
- The complete command set is /new, /resume [chat ID], /fork, /compact, /status, /model [ID|default],
  /permissions, /plan, /goal, /review, /test, /explain and /help. Local /new resets the current chat tab
  in place, clears its transcript/session context and keeps the selected provider/model/permissions.
  Local commands never reach the model; prompt commands are wrapped and sent as their matching tags.
  Missing arguments open selectors; invalid ones report errors.
- /fork clones saved history after capability probing (Claude --fork-session; Codex app-server/RPC validation).
  Failure preserves clone/parent boundaries with explicit fresh-session restart. Empty model/effort sends no
  flag, preserving CLI/per-chat defaults.
- /compact requires idle/no queue/no pending card. Keep transcript; atomically persist read-only summary
  before session/context/usage reset. Summary becomes new-session preamble; failure preserves session.

## Change map and verification

Align prompt construction, Rust parser, UI cards and saved actions. Existing tests protect IME/chip boundaries,
read-only guidance, questions (streaming edits and failed-launch unlock/retry), plan persistence, duplicate
actions, retries and permission picker labels/actions.
Real IME/native approval verification requires an explicit request; gate policy: [checks.md](./checks.md).
