# Built-in agent

The agent layer runs local CLI agents (Claude Code, Codex) against the open workspace. It is
not a protocol implementation: one user turn = one headless CLI process, resumed by session id
on the next turn. That survives restarts and leaves auth, models and tool loops to the CLIs.

## Entry points

Every entry opens a new chat tab (`kind: 'chat'`, id `chat:<chatId>`) in the
focused pane; there is no separate popover.

- Title bar sparkle button → new chat for the active workspace (hidden when `agentEnabled` is off).
- Explorer row double-click (file or folder) → new chat whose composer already holds the
  `@file` / `@folder` mention. The first click still opens the row;
  `e.detail > 1` suppresses the second one.
- Explorer context menu (file or folder) → same new chat with that mention.
- Command palette → “Ask the agent…”.

A message typed while a turn is running is **queued** for that chat (FIFO, shown above the
composer) and starts the next turn when `done` arrives, reusing the same CLI session.
Stop ends the current turn and drains the queue immediately; the transcript keeps the queue out
until it is actually sent.

The provider scan is warmed shortly after first paint (and again when the setting is turned back
on), then cached for the session; the settings page can rescan on demand.

## Code map

- `src/store/agent.ts`: providers/catalogs, new-chat defaults, chats, streaming reducer, drafts,
  debounced transcript writes.
- `src/lib/agentEvents.ts`: the single `agent:event` listener.
- `src/lib/agentSession.ts`: restores chat tabs, persists the open chat list, closes the bridge.
- `src/lib/agentBridge.ts`: one-way tab-close callback (avoids a tabs ↔ agent import cycle).
- `src/components/AgentChat.tsx`, `AgentComposer.tsx`,
  `AgentMessage.tsx`, `AgentMarkdown.tsx`, `AgentPickers.tsx`, `AgentTags.tsx`.
- `src/lib/agentCommand.ts`: command catalog, `/` `$` trigger detection, skill ranking and
  prompt assembly.
- `src-tauri/src/commands/agent.rs`: spawn/cancel turns, skill scan, chat and tab persistence.
- `src-tauri/src/agent/`: provider scan, skill discovery, argument builders, JSONL translators,
  file store.

## Turn lifecycle

1. `agent_send` authorizes the workspace root, resolves the provider binary, builds the args,
   spawns the CLI with cwd = root, writes the prompt to **stdin** (never argv), then returns.
2. A reader thread parses stdout JSONL into `session | textDelta | thinking | toolStart |
   toolDetail | toolEnd | notice | stderr | done`; a merge thread coalesces text deltas (24ms)
   before emitting `agent:event` to the window.
3. The frontend reducer appends text to an item id, upserts tool cards, stores the CLI session id
   and closes the turn on `done`.
4. Stop / window close / app exit / disabling the agent kill the process group (setsid on Unix,
   `taskkill /T` on Windows). At most 4 turns run at once; one turn per chat.

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

## Provider mapping

- Claude: `claude -p --verbose --output-format stream-json --include-partial-messages
  --permission-mode bypassPermissions --allow-dangerously-skip-permissions`, then
  `--session-id <uuid>` (first) or `--resume <id>`; `--model` / `--effort` optional.
- Codex: `codex exec [resume <thread>] --json --skip-git-repo-check` (with `-C <root>` on the
  first turn), plus
  `-c sandbox_mode="workspace-write" -c approval_policy="never"`; the prompt is `-` (stdin).
- Empty `model` / `effort` means **no flag**: Codex and Claude keep the model
  their own config selects (custom providers included). Tide never edits those config files and must
  not auto-fill a catalog model; only an explicit pick in Settings or the chat picker is passed.
- A resumed session that no longer exists is retried once without the id, with a visible notice.

## Persistence

- `<appConfig>/agent/chats/<id>.json`: opaque frontend-owned transcript JSON, atomic write,
  8MB hard cap. Trimmed to 300 messages / 2MB before saving.
- `<appConfig>/agent/tabs.json`: open chat tabs (max 8) + active chat; primary window only.
- Both are flushed on `app:hidden` / `beforeunload`.

## When adding a provider

Add a `ProviderSpec` row in `agent/providers.rs`, an argument builder + JSONL translator next to
`claude.rs`, its model catalog (or a curated one), and map its events to the same
`AgentEvent`. Detected-but-unsupported CLIs stay in the settings list with a hint.
