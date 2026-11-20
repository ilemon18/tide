# Agent implementation status

Reference: [openidea 7b2ba44](https://github.com/l0ng-ai/openidea/tree/7b2ba44a8de183d002a08a431d441551684411bd),
including its Chinese Agent guide. This is a partial implementation, not a claim of parity. No upstream
source code was copied. The terminal Cmd+/ and IME changes remain as originally staged.

## Implemented foundation

| Capability | UI entry | IPC | Rust implementation | Persistence | Tests |
|---|---|---|---|---|---|
| Load recent history | AgentChat restoration | agentChatOpen | agent/store.rs recent_page | Existing v:1 JSON | Legacy parsing, default count, byte budget |
| Browse history | Earlier/later buttons | agentChatPage | cursor_page, page_range | Read-only exclusive cursors | Start/end/missing/ambiguous cursors; both byte limits |
| Update history | Chat changes/flush | agentChatApply | apply_path, apply_document | Per-file lock, merged header and message IDs, atomic write | Concurrent updates, unloaded history, unknown fields |
| Protect saved history | Save error alert/toast | agentChatApply | write_document | 8 MiB rejection preserves original; invalid JSON rejected | Oversize, corrupt input and failed write preservation |
| Pending historical question | Open pending request | agentChatPage | Full-history pending metadata | Existing question answer fields | Rust full-history detection; frontend send blocking |
| Explicit native session action | Send; /fork for Claude | agentSend.sessionAction | Claude launch; Codex resume | sessionId and pending Claude fork action | Launch fixtures; explicit frontend resume |
| Event isolation | Streaming chat | runId + sequence in events | TurnEvents | Transcript updates through patches | Duplicate/stale/post-completion filtering |
| Local commands | Composer slash menu | Existing chat/session IPC | Existing provider execution | Chat metadata | Command parser, local help dispatch, chip removal |
| Current context vs usage | Context popup | usage and sessionUsage events | Existing translators | Separate sessionUsage header | Unknown context, zero, invalid values, no cumulative fallback |
| Failed startup | Composer/error card | agentSend error | Existing process launch | Original session retained | Draft preserved, no implicit new-session retry |

Local commands currently execute new chat, saved-chat resume by ID, Claude session fork, status, model
selection and help. Compact and permissions explicitly report unavailable. Codex fork is rejected at IPC:
the existing exec driver cannot provide the app-server native fork operation. Model selection remains a
next-turn CLI option, not a transactional protocol configuration operation.

## Remaining scope

| Planned area | Current limitation / required work |
|---|---|
| Rust task manager | Frontend still owns queue/display transcript updates. Backend snapshots, task/session state, durable queues and view-independent execution are not implemented. Closing a tab still cancels its process. |
| Native drivers | Codex still uses exec JSONL, Claude still uses one-turn headless output. Bidirectional app-server/control requests and Copilot native protocol remain unimplemented. |
| ACP | Initialization, capability negotiation, request routing and registry-driven providers are absent. |
| Built-in providers | Gemini, Cursor, OpenCode, Qwen, Qoder/Qoder CN, Kimi, Goose, Auggie, Kiro, Vibe, Hermes, OMP and DeepSeek Harness need executable protocol adapters. Icons/discovery do not count as support. |
| Lifecycle/error recovery | Four-turn limit exists. Five-minute idle session retention, explicit retry/new-session recovery choices, and classified auth/protocol failures remain outstanding. |
| Interaction | Native permissions/forms, subagents, background tasks, editable/send-now queues, steering and native compact/review/goal/MCP commands remain outstanding. |
| Plan actions | Read-only planning exists. Durable exactly-once current/new-session implementation actions are absent; legacy plan metadata can block sends but has no complete action UI. |
| Message operations | Edit, retract, regenerate, quote and branch at a specific turn remain outstanding. |
| Context and attachments | Images/attachment files, line-range references, editor selections, input history and full-session search remain outstanding. |
| Provider options | Protocol-discovered model-specific options, cooldown/coalesced refresh and rollback on rejected changes remain outstanding. |
| Statistics | Context/turn/session separation fixed. Rate limits, retries, complete session totals for all providers and pricing semantics need protocol support. |
| Task panel | Categorization, unread state, pin/group/archive/rename/delete and editor/panel placement remain outstanding. |
| External sessions | Import and deduplication of native sessions remain outstanding. |
| Worktrees and review | Task worktrees, run baselines, task/turn diff attribution, conflict-safe rollback and reference-counted deletion remain outstanding. |
| Provider settings/registry | Custom binaries/args/env, Hermes profile, ACP registry search/install/update/remove and checksum verification remain outstanding. |
| MCP and secrets | User/project/session inheritance, import/testing/tool listing, read-only Tide MCP server and OS credential storage remain outstanding. |
| Full acceptance | Protocol fake processes, worktree/MCP fixtures and the remaining frontend flows need implementation and coverage. Current tests do not establish full feature parity or real-provider compatibility. |

## Verification

The project verify skill runs six static gates, Rust tests and the frontend agent suite. Frontend tests use
Vitest and React Testing Library; CI invokes the same frontend command. No application build, installer,
GUI smoke test, real account or authenticated provider session was used for this foundation.
