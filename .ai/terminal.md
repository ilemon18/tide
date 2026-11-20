---
summary: PTY lifecycle, terminal output, keyboard and IME
scope:
  - src/components/TerminalView.tsx
  - src/components/TerminalPanel.tsx
  - src/components/TerminalPanel.test.tsx
  - src/lib/terminalLayout*.ts
  - src/store/terminal.ts
  - src/lib/keys.ts
  - src-tauri/src/commands/terminal.rs
  - src-tauri/src/state.rs
---
# Terminal and PTY

## PTY ownership and output

- PTY lifetime is entirely in Rust (`state.ptys`); the frontend sends only input, resize and close over
  `api.*`, and `pty:data` / `pty:exit` are protocol events, not permission to move process ownership into the
  webview. Closing a workspace's last reference, window destruction, app exit and terminal close all go
  through the Rust-owning cleanup path.
- A workspace's terminal stays alive while hidden: pause frontend parsing/writes and retain state instead of
  recreating the xterm instance. Visible terminals write through `requestAnimationFrame` in bounded chunks
  with a timer fallback, because occluded WKWebViews can stop animation frames; hidden tabs must not call
  `term.write` at all, keeping only the newest bounded tail to replay on activation.
- Never trim or chunk inside a UTF-16 surrogate pair — drop complete leading units and keep a valid suffix.
  Tail size, chunk size, scrollback and WebGL defaults are owned by `memoryBudget.ts`, terminal settings or
  the terminal itself; read them at use time.

## Keyboard and IME

- App capture-phase shortcuts run before xterm. After them, `TerminalView` forwards printable punctuation
  held with `Cmd` on macOS or `Ctrl+Shift` on Windows/Linux, which xterm otherwise drops; `Cmd/Ctrl +/-` stay
  visible-character inputs, and plain `Ctrl+punctuation` stays terminal control input.
- macOS `Cmd+/` is a direct ASCII `?` input, including while a Chinese IME is active. Detect the physical slash
  key before composition handling, prevent the browser/xterm path, and write `?` to the PTY on keydown; never
  wait for `Process`/key code 229 to commit or poll the textarea.
- Keep shortcut definitions in `src/lib/keys.ts` and the forwarding exception together with the platform
  tests; changing one without the other causes duplicate, dropped or control-sequence input.

## Panel geometry

- Terminal maximize fills only the right editor region, including its tab-bar space. The file tree stays.
  `App` measures that region with ResizeObserver; `terminalLayout.ts` subtracts the persistent 4px splitter
  and retains the 120px terminal minimum. Never use a window-height offset as the available height.
- Maximize is window-memory state in the terminal store. Button restore uses the unchanged saved normal
  height; dragging upward to the top maximizes, dragging down starts continuously from the actual current
  region height and resumes normal persisted height updates. Hidden/last-closed panels exit maximize.
- EditorArea and TerminalView stay mounted across geometry changes; no generation/PTY replacement occurs.
  Existing terminal ResizeObserver/fit sends native PTY resize after layout changes.
