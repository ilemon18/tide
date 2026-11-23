---
summary: PTY output, keyboard, IME and geometry
scope:
  - .ai/terminal.md
  - src/components/TerminalView.tsx
  - src/components/TerminalPanel.tsx
  - src/components/TerminalPanel.test.tsx
  - src/lib/terminalLayout*.ts
  - src/store/terminal.ts
  - src/lib/keys.ts
  - src-tauri/src/commands/terminal.rs
  - src-tauri/src/state.rs
  - src/components/TerminalContextAction.tsx
  - src-tauri/src/commands/tasks.rs
  - src/components/EditorContextActions.test.tsx
  - src/lib/terminalSelection*.ts
keywords:
  - terminal
  - pty
  - xterm
  - keyboard
  - 终端
  - 键盘
---
# Terminal and PTY

## Ownership and output

- Rust state.ptys owns PTY lifetime. Frontend only sends input/resize/close; pty:data/pty:exit remain
  protocol events. Last workspace reference, window destruction, app exit and terminal close all reap in Rust.
- Hidden workspace terminals remain alive; pause parsing/writes, retain xterm state and only the newest
  bounded tail. Never term.write while hidden. Visible writes use bounded requestAnimationFrame chunks
  with a timer fallback for occluded WKWebViews. Activation replays the tail without recreating xterm.
- Trimming/chunking must not split UTF-16 surrogate pairs. Read tail/chunk/scrollback/WebGL limits from
  memoryBudget, settings or terminal implementation at use time, without copying ceilings.

## Keyboard and IME

- App capture shortcuts use the shared configurable dispatcher before xterm. Clear terminal is a mounted
  runtime action, with no hardcoded Cmd/Ctrl+K fallback after rebinding. Recording captures before PTY input.
  [Runtime](./runtime.md) owns conflict/persistence rules.
- App capture shortcuts precede xterm. Forward printable punctuation held with macOS Cmd or Windows/Linux
  Ctrl+Shift after app shortcuts. Cmd/Ctrl +/- remain visible input; plain Ctrl+punctuation stays control input.
- macOS Cmd+/ sends ASCII ? directly on physical-slash keydown, including Chinese IME. Prevent browser/
  xterm handling before composition; never wait for Process/keyCode 229 commit or poll the textarea.

## Panel geometry

- Maximize fills the right editor region including tab bar; sidebar stays. App measures via ResizeObserver;
  terminalLayout subtracts the persistent 4px splitter and retains the 120px minimum. Never derive height
  from a window offset. EditorArea/TerminalView stay mounted; no generation or PTY replacement.
- Maximize is window-memory state. Restore uses saved normal height unchanged. Drag upward to top maximizes;
  drag downward starts continuously at current region height and resumes normal persisted updates.
  Hidden/last-closed panels exit maximize. Existing resize/fit sends native PTY resize after layout changes.

## Selection context

- TerminalView registers a lazy selected-text reader with terminalSelection; selection changes publish
  availability without copying output. TerminalContextAction targets the active tab and preserves its
  selection on toolbar clicks. Exited terminals can still contribute visible selected output.
- Snapshot metadata labels root/rel as startup location, never current shell cwd. Rootless shells use the
  active workspace for the conversation and mark startup location unavailable. Unregister on teardown,
  including failed initialization; existing snapshots do not depend on PTY lifetime or later output.

Project tasks use a separate non-PTY process path. They inherit the authorized workspace cwd, forward bounded
stdout/stderr events, expose exit codes and kill the whole process group/tree on stop, window destruction or app
exit. Do not route task output through xterm or let tasks inherit terminal input.

## Change map and verification

Update src/lib/keys.ts, forwarding exceptions and platform tests together to prevent duplicate/dropped/
control input. Geometry changes coordinate App, terminalLayout, store and panel tests. Native IME and
maximize/drag/restore need explicit manual verification. Gate policy: [checks.md](./checks.md).
