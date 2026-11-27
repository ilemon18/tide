---
summary: PTY output, keyboard, IME and geometry
scope:
  - .ai/terminal.md
  - src/components/TerminalView.tsx
  - src/components/TerminalPanel.tsx
  - src/components/TerminalPanel.test.tsx
  - src/lib/terminalLayout*.ts
  - src/store/terminal*.ts
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

- Rust `state.ptys` owns PTY lifetime; the frontend only sends input/resize/close and `pty:data`/`pty:exit`
  remain protocol events. Last workspace reference, window destruction, app exit and terminal close all reap
  in Rust.
- Hidden terminals stay alive but pause parsing/writes, retain xterm state and only the newest bounded tail;
  never `term.write` while hidden. Visible writes use bounded animation frames and activation replays the
  tail without recreating xterm. Trimming never splits UTF-16 surrogate pairs; limits come from
  memoryBudget/settings at use time.

## Font styling

- v19 terminal weight/italic default to 400/off and are independent of code/UI styling. `fonts.ts` maps
  xterm's public fontFamily API to intrinsic oblique faces; normal and ANSI italic descriptors share faces
  to avoid double shear. WeightBold is weight + 300 capped at 900. Never override a chosen weight for DPI.
- `generate-terminal-oblique.py` (fontTools 4.60.2 + brotli/zopfli) removes upright hints, expands variation
  deltas before shear, preserves advances/cmap/features and renames derived families. SOURCE.json records
  sources/hashes/licenses; generators run only during development. No PTY recreation on styling changes:
  load regular/bold fonts, clear atlas, refresh/fit, resize. Ignore obsolete font-load completions.

## Keyboard and IME

- App capture shortcuts use the shared configurable dispatcher before xterm; clear terminal is a mounted
  runtime action with no hardcoded Cmd/Ctrl+K fallback after rebinding. Recording captures before PTY input.
  [Runtime](./runtime.md) owns conflict and persistence rules.
- Forward printable punctuation held with macOS Cmd or Windows/Linux Ctrl+Shift after app shortcuts;
  Cmd/Ctrl +/- stay visible input and plain Ctrl+punctuation stays control input.
- macOS Cmd+/ sends ASCII `?` directly on physical-slash keydown, including Chinese IME. Prevent browser/xterm
  handling before composition; never wait for Process/keyCode 229 commit.

## Panel geometry

- Maximize fills the right editor region including the tab bar; the sidebar stays. App measures via
  ResizeObserver; terminalLayout subtracts the persistent 4px splitter and keeps the 120px minimum. Never
  derive height from a window offset.
- Maximize is window-memory state; restore keeps the saved normal height. Drag to the top maximizes and
  hidden/last-closed panels exit maximize. Resize/fit sends native PTY resize after layout changes.

## Tab management

- Blank strip double-click opens one terminal; controls/tabs do not forward this gesture. Ordinals start at 1
  after all tabs close; existing titles remain stable when others close or reorder. IDs are independent UUIDs.
- Context menus close current/others/left/right/all/exited. Close all is red and explicitly ends every PTY;
  other bulk actions preserve pinned tabs. Exited means the shell has emitted `pty:exit` (idle shells stay).
- Left/right pins partition the strip; drag reorders only inside a partition. Activation/pinning/reordering
  preserve PTY identities and resident xterm views. Pointer listeners and selection locks release on teardown.
- Dragged pills follow the grab point, clamped to their pin partition; measured widths and visual centers
  drive insertion. Neighbor transforms animate; the strip scrolls at edges and reveals the active tab.
  Escape/blur/cancel/removal also release the gesture without reinitializing terminals.

## Selection context

- TerminalView registers a lazy selected-text reader with `terminalSelection`; selection changes publish
  availability without copying output. `TerminalContextAction` targets the active tab and preserves selection
  on toolbar clicks; exited terminals can still contribute visible selected output.
- Snapshot metadata labels root/rel as startup location, never shell cwd; rootless shells use the active
  workspace. Unregister on teardown, including failed initialization.

## Change map

Project tasks use a separate non-PTY path: authorized cwd, bounded output, exit codes and whole-tree cleanup;
never route through xterm. Update `src/lib/keys.ts`, forwarding exceptions and platform tests together.
Gate: [checks.md](./checks.md).
