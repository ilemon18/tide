---
summary: Agent chat, providers, composer, planning and persistence
scope:
  - src/store/agent.ts
  - src/lib/agent*.ts
  - src/components/Agent*.tsx
  - src-tauri/src/commands/agent.rs
  - src-tauri/src/agent/**
---
# Built-in agent

The agent wraps local Claude/Codex CLIs. One turn is one headless process resumed by provider session id;
the CLIs own auth, models and tool loops.

## Turn lifecycle and queue

- `agent_send` authorizes the root, spawns the resolved CLI with `cwd = root` and the prompt on **stdin**
  (never argv), then returns; Rust owns the process and kills the process group (`setsid`, `taskkill /T`) on
  stop, tab close, window close, app exit and disable. Bounded concurrency and one turn per chat live there.
- A reader turns stdout JSONL into `AgentEvent`s and coalesces text deltas before the single listener in
  `src/lib/agentEvents.ts`; the reducer appends items by id, upserts tool/question cards, keeps the session
  id, attaches usage to the latest assistant message and closes on `done`.
- A send during a turn joins that chat's FIFO queue, not running stdin; `done` and Stop drain it on the same
  session without erasing a draft typed meanwhile, and queued text stays out of the transcript.

## Composer input and prompt assembly

- The composer textarea has a horizontal splitter on its top edge. `agentComposerHeight` is one global persisted
  manual minimum (default 60px, settings schema v10, shared across windows and chats); drag up to grow it and
  down to shrink it. Long drafts still auto-grow above that minimum, then scroll inside at
  `max(60, min(480, round(window.innerHeight * 0.5)))`. A smaller window clamps the displayed height without
  overwriting the saved value, so resizing back restores the user's height.
- `src/lib/agentCommand.ts` owns three triggers — `/` command, `$` skill, `@` mention — resolved to the one
  closest to the caret. `@` and `/` need line start or whitespace; `$` accepts any prefix except a word
  character or `$`, and `$5` stays prose.
- `@` lists up to eight workspace files from the quick-open index by fuzzy match. A `{ rel, isDir }` chip
  survives edits and renames, and becomes a `Referenced paths (relative to the workspace root)` preamble from
  Rust `build_prompt`, with directories marked `/ (directory)`.
- `/` allows one command — `plan | goal | review | test | explain` — and picking another replaces it; a typed
  leading `/command` normalizes into the same tag. `buildAgentPrompt` wraps the text as `<plan>…</plan>` or
  `<command>…</command>`, appends the question protocol, appends `READ_ONLY_CONTINUATION` to a read-only turn
  that is not a plan, and puts one `Use the skill "<name>" (SKILL.md: <path>).` line per skill first.
- `$` lazily scans `<root>/.agents/skills`, `<root>/.claude/skills`, `~/.claude/skills` and
  `$CODEX_HOME/skills`, passing only frontmatter name/description and the SKILL.md path, with project paths
  workspace-relative. Cache per session and retry failures; queue entries and session-reset retries carry
  `command` / `skills` / `mentions`.

## Questions and read-only planning

- At most one valid `<TIDE_QUESTION>` marker per turn, with a non-empty header/question, 2–4 non-empty
  labelled/described options, `multiSelect` when choices may combine, and a custom answer always available in
  the UI. Preserve surrounding text in source order, hide only the valid marker (a partly streamed one stays
  hidden until flush), and on invalid JSON/options or an unclosed marker restore the text with a localized
  `questionInvalid` notice. A blank `answer` blocks sends and queue draining.
- `/plan` sends `readOnly: true`: inspect first, ask only when a key decision cannot be derived from the
  repository. Answer follow-ups keep `readOnly` and the next ordinary message starts a writable turn.
  Read-only turns never use the bypass/workspace-write path — Claude gets `--permission-mode plan` and drops
  `--permission-mode bypassPermissions` and `--allow-dangerously-skip-permissions`, Codex gets
  `sandbox_mode="read-only"` — and a session-reset retry preserves the question item and `readOnly`.

## Providers, UI and persistence

- Agent chats open from the title-bar button or a file-tree row's context menu. Double-clicking a file-tree
  row remains a normal open/toggle gesture and must not switch chats; disabling `agentEnabled` hides the
  remaining entry points without changing chat persistence or provider behavior.
- Claude writable turns use the bypass/dangerously-skip flags; Codex writable ones set
  `-c sandbox_mode="workspace-write" -c approval_policy="never"`. Empty `model` / `effort` means **no flag**,
  so user provider config wins: never auto-fill a catalog model or rewrite the global default from a per-chat
  pick. A missing session retries once without its id and shows a notice.
- Tool items group only within one assistant message, with status priority `error > running > ok`; only
  `RunningStatus` ticks each second, usage replaces the latest snapshot, and grouping is never persisted. A new
  provider needs a `ProviderSpec` in `src-tauri/src/agent/providers.rs` plus a translator beside
  `src-tauri/src/agent/claude.rs`, mapped into `AgentEvent`.
- `<appConfig>/agent/chats/<id>.json` is opaque, frontend-owned transcript JSON written atomically, with its
  hard cap and trim limit beside the store/tests; `v: 1` stays and old files must load.
  `<appConfig>/agent/tabs.json` holds the primary window's chat tabs, and both flush on `app:hidden` /
  `beforeunload`.
- **Hooks:** `AgentChat` must finish every hook before its `!chat` loading/missing return, so hydration and
  missing-chat states cannot change the hook order.
