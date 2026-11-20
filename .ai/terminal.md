# Terminal and PTY

**Load when:** changing PTY lifecycle, terminal output/backpressure, hidden terminal behavior, keyboard
forwarding, or IME handling.
**Code:** `src/components/TerminalView.tsx`, `src/store/terminal.ts`, `src/lib/keys.ts`,
`src-tauri/src/commands/terminal.rs`, `src-tauri/src/state.rs`.

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
- macOS `Cmd+/` under an IME can report `Process`/key code 229: let the browser commit composition, capture
  the textarea's final `?` or `？`, and let xterm's data event win the one-send race; if it emitted nothing,
  poll for two stable textarea reads within the bounded timeout, then write once. Never send composition
  previews, and let a composition that never ends expire without output.
- Keep shortcut definitions in `src/lib/keys.ts` and the forwarding exception together with the platform
  tests; changing one without the other causes duplicate, dropped or control-sequence input.