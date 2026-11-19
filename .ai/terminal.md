# Terminal and PTY

**Load when:** changing PTY lifecycle, terminal output/backpressure, hidden terminal behavior, terminal
keyboard forwarding, or IME handling.
**Code:** `src/components/TerminalView.tsx`, `src/store/terminal.ts`, `src/lib/keys.ts`,
`src-tauri/src/commands/terminal.rs`, `src-tauri/src/state.rs`.

## PTY ownership and lifecycle

- PTY lifetime is entirely in Rust (`state.ptys`); the frontend sends only input, resize and close over
  `api.*`. `pty:data` and `pty:exit` are protocol events, not permission to move process ownership into
  the webview.
- The terminal for a workspace remains alive while hidden. Do not recreate an xterm instance to hide it;
  pause frontend parsing/writes and retain state instead.
- Closing a workspace’s last reference, window destruction, app exit and terminal close must go through the
  Rust-owning cleanup path. The frontend cannot reap a PTY after its window grant is gone.

## Output queue and backpressure

- Each `TerminalView` owns its output queue. Visible terminals write through `requestAnimationFrame` in
  bounded chunks, with a timer fallback because occluded WKWebViews can stop animation frames.
- Hidden tabs and hidden panels must not call `term.write`. Retain only the newest bounded tail and replay
  it when the terminal becomes active/visible again. Do not let a backgrounded page grow an unbounded queue.
- Never trim or chunk in the middle of a UTF-16 surrogate pair. When reducing a queue, drop complete
  leading units and retain a valid suffix.
- Tail size, frame chunk size, scrollback and WebGL defaults are owned by `memoryBudget.ts`, terminal
  settings or the terminal implementation. Read them at use time instead of copying values into docs.

## Keyboard and IME

- App capture-phase shortcuts run before xterm. After those, `TerminalView` forwards printable punctuation
  held with `Cmd` on macOS or `Ctrl+Shift` on Windows/Linux to the PTY, because xterm otherwise drops it.
  `Cmd/Ctrl +/-` remain visible-character inputs. Do not broaden this exception to plain
  `Ctrl+punctuation`, which is terminal control input.
- macOS `Cmd+/` under an IME can report `Process`/key code 229. Let the browser commit composition, capture
  the textarea's final `?` or `？`, and let xterm's data event win the one-send race. If xterm emitted
  nothing, poll for two stable textarea reads within the bounded timeout in the implementation, then write
  once. Never send composition previews.
- A composition that never ends must expire without emitting output.
- Keep shortcut definitions in `src/lib/keys.ts` and the terminal forwarding exception together with the
  platform tests; changing one without the other causes duplicate, dropped or control-sequence input.

