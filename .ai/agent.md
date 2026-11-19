# Built-in agent

The agent layer runs local Claude/Codex CLIs; one user turn = one headless process, resumed by
session id. Auth, model selection and tool loops stay in the CLIs.

## Entry points

Every entry opens a chat tab (`kind: 'chat'`, id `chat:<chatId>`) in the right pane. The first chat
creates a 60/40 row split; an existing split keeps its ratio, moves chat to secondary and converts
a column split to row.

- Title bar sparkle button → new chat for the active workspace (hidden when `agentEnabled` is off).
- Explorer file double-click → new chat whose composer already holds the `@file` mention. The first
  click still opens the file; `e.detail > 1` suppresses the second one. Folder double-click only toggles
  the folder. The context menu still starts a new chat for either a file or a folder.
- Command palette → “Ask the agent…”.

When the focused secondary tab is a chat, ordinary file, quick-open, search,
diff and untitled opens route to primary so code appears beside the conversation.
File drops into an explicit pane and in-place replacements keep their target.
An emptied primary remains split while secondary still contains a chat; closing
that chat or choosing unsplit restores the normal empty-pane merge.

A message typed while a turn is running is **queued** for that chat (FIFO, shown above the
composer) and starts the next turn when `done` arrives, reusing the same CLI session.
Stop, or Escape while the running chat is the focused tab, ends the current turn and drains the queue
immediately; the transcript keeps the queue out until it is actually sent.
An unanswered structured question blocks both normal sends and automatic queue draining; the user must
answer it through the question card before the next turn starts.

Provider scan warms after first paint and is cached per session; Settings can rescan. While scanning,
`loadProviders` ignores new/forced requests and a failed refresh keeps the old provider list.

## Code map

- `src/store/agent.ts`: providers/catalogs, new-chat defaults, chats, streaming reducer, drafts,
  debounced transcript writes.
- `src/lib/agentEvents.ts`: the single `agent:event` listener.
- `src/lib/agentSession.ts`: restores chat tabs, persists the open chat list, closes the bridge.
- `src/lib/agentBridge.ts`: one-way tab-close callback (avoids a tabs ↔ agent import cycle).
- `src/components/AgentChat.tsx`, `AgentComposer.tsx`,
  `AgentMessage.tsx`, `AgentMarkdown.tsx`, `AgentPickers.tsx`, `AgentTags.tsx`.
- `src/lib/agentDuration.ts`, `agentUsage.ts`, `clipboard.ts` and
  `src/components/CopyButton.tsx`: duration formatting, usage normalization/cumulative cost,
  shared clipboard fallback and copy affordance.
- `src/lib/agentCommand.ts`: command catalog, `/` `$` trigger detection, skill ranking and
  prompt assembly.
- `src-tauri/src/commands/agent.rs`: spawn/cancel turns, skill scan, chat and tab persistence.
- `src-tauri/src/agent/`: provider scan, skill discovery, argument builders, JSONL translators,
  shared question parser and file store.

## Turn lifecycle

1. `agent_send` authorizes the root, resolves the binary, builds args, spawns with cwd = root, writes
   the prompt to **stdin** (never argv), then returns.
2. A reader thread parses stdout JSONL into `session | textDelta | thinking | toolStart |
   toolDetail | toolEnd | question | questionInvalid | usage | notice | stderr | done`; a merge thread
   coalesces text deltas (24ms) before emitting `agent:event` to the window.
3. The frontend reducer appends text to an item id, upserts tool and question cards, stores the CLI
   session id, attaches usage to the latest assistant message and closes the turn on `done`.
4. Stop / close / exit / disable kills the process group (setsid on Unix, `taskkill /T` on Windows).
   At most 4 turns run; one per chat.

## Composer commands and skills

- `/` opens the built-in command list (`plan` `goal` `review` `test` `explain`). A space after
  an exact name, or Enter on a row, moves it into a chip. One command per message; picking
  another replaces it. On send the text is wrapped as `<plan>…</plan>` for every provider.
- `$` opens the skill picker. Sources: `<root>/.agents/skills`, `<root>/.claude/skills`,
  `~/.claude/skills`, and `$CODEX_HOME/skills` (default `~/.codex/skills`). Only the frontmatter
  `name` / `description` and the SKILL.md path travel; the agent reads the file itself.
- Multiple skill chips are allowed. The prompt starts with
  `Use the skill "<name>" (SKILL.md: <path>).`; project paths are workspace-relative, user-level
  paths absolute. Mentions are still added by `agent::build_prompt`.
- The scan is lazy (first `$` per root), cached in `store/agent.ts` for the session, and retried
  after a failure. No watcher and no cache in Rust.
- Queue entries and the session-reset retry carry `command` / `skills` along with the text.

## Structured questions and read-only planning

- A provider may emit one question per turn using the exact marker
  `<TIDE_QUESTION>{"header":"...","question":"...","multiSelect":false,"options":[{"label":"...","description":"..."}]}</TIDE_QUESTION>`.
  The header and question must be non-empty; `options` must contain 2–4 entries with non-empty labels and
  descriptions. The translators stream-parse the marker, preserve ordinary text before and after it in
  source order, and hide only a valid marker from the visible text.
- More than one question is invalid. Invalid JSON/options and an unclosed marker restore the original
  marker text and produce a localized `questionInvalid` notice; a partially streamed marker must not be
  shown or dropped until the text block/turn is flushed.
- A question item is pending when its optional `answer` is absent or blank. While a pending question
  exists, `AgentComposer`, `sendMessage` and `drainQueue` all reject another turn. Submitting marks the
  item answered, appends the localized question/answer prompt as a user message, and resumes the same
  CLI session in a new process. The answer turn inherits the source assistant message's `readOnly` flag;
  a session-reset retry preserves both the question item and that flag.
- `/plan` sets `AgentTurnRequest.readOnly = true` and asks the agent to inspect the repository first. It
  may ask only when a key decision cannot be derived from the repository; otherwise it returns the full
  implementation plan. Every answer follow-up keeps `readOnly` true, and the next ordinary user message
  starts a writable turn. Questions in ordinary chats are allowed too, but their answer turns are
  writable unless they came from a read-only plan turn.
- Tool cards are grouped only while rendering an assistant message: consecutive `tool` items form one
  component-local group, and every non-tool item cuts it. The group status is `error > running > ok`.
  Running groups start expanded; completed groups auto-collapse until the user manually toggles that
  group. Grouping and toggle state are UI-only and never enter the transcript or IPC.

## Provider mapping

- Claude writable: `claude -p --verbose --output-format stream-json --include-partial-messages
  --permission-mode bypassPermissions --allow-dangerously-skip-permissions`, then `--session-id <uuid>`
  (first) or `--resume <id>`; `--model` / `--effort` optional. Read-only turns use
  `--permission-mode plan` and omit both bypass/dangerously-skip flags.
- Codex: `codex exec [resume <thread>] --json --skip-git-repo-check` (with `-C <root>` on the
  first turn), plus `-c sandbox_mode="workspace-write" -c approval_policy="never"` for writable turns;
  read-only turns use `-c sandbox_mode="read-only"`. The prompt is `-` (stdin).
- Empty `model` / `effort` means **no flag**: providers keep their configured model, including custom
  providers. Tide never edits those configs or auto-fills a catalog model.
- A resumed session that no longer exists is retried once without the id, with a visible notice.

## Duration, copy and usage

- Duration is compact/locale-independent: `3s`, `12m 03s`, `1h 02m 03s` (floored). Only
  `RunningStatus` ticks each second; never rerender the transcript for the timer.
- Chat content remains selectable. `CopyButton` is shown on hover/focus for complete user turns,
  assistant replies, text/thinking blocks, tools (title/input/output), errors, notices, logs and
  queued messages. User turns include command/skills/mentions/prompt; queue entries include command,
  skills, mentions and text. Fenced code uses the same shared clipboard helper and failure toast.
- `AgentUsage` is optional per assistant message. Repeated token events in one turn replace the
  snapshot, not double-count. Transcript `v: 1` is unchanged; malformed usage is ignored/normalized.
- Claude reports token/cache fields and `total_cost_usd`; an explicit zero displays `$0.00`. Codex
  reports tokens but no price, so `costUsd` is `null` and the UI shows localized cost-unavailable.
  A cumulative total containing any priced and unpriced history is unavailable, never partial.

## Persistence

- `<appConfig>/agent/chats/<id>.json`: opaque frontend-owned transcript JSON, atomic write,
  8MB hard cap. Trimmed to 300 messages / 2MB before saving. Keep `v: 1`; old transcripts without
  usage, question items or assistant `readOnly` must load normally. These new fields are optional; a
  question item stores its structured payload plus the submitted `answer`, and a read-only assistant
  turn stores `readOnly: true`.
- `<appConfig>/agent/tabs.json`: open chat tabs (max 8) + active chat; primary window only.
- Both are flushed on `app:hidden` / `beforeunload`.

## When adding a provider

Add a `ProviderSpec` row in `agent/providers.rs`, an argument builder + JSONL translator next to
`claude.rs`, its model catalog (or a curated one), and map its events to the same
`AgentEvent`. Detected-but-unsupported CLIs stay in the settings list with a hint.

## Token budget

- `src/components/AgentTokenBudget.tsx` renders a compact ring left of Send, including while running.
  Hover shows the draft estimate; click opens cumulative/latest details; Escape/outside/close dismiss.
- Ring color indicates estimate size: neutral at zero, accent through 100k, warning above 100k,
  danger above 150k. A center dot also distinguishes the warning states. This is a size
  indicator, not a model context-window percentage.
- Compact text shows cumulative tokens/cost; details show cumulative and latest-turn input,
  cached input, cache write, output, reasoning, total and cost.
- Drafts debounce 300ms. `agent_estimate_tokens` includes command/skill wrappers and file sizes
  without contents; it excludes history, directory contents and CLI overhead. Stale responses are
  discarded and chat close clears estimates.
- File references are selected explicitly through the `@` picker or explorer entry points.
