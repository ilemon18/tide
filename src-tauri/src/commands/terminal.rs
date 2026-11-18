use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};
#[cfg(windows)]
use crate::proc;
use crate::state::AppState;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Default shell.
///
/// Windows has no `$SHELL`, and a fallback like `/bin/zsh` only yields "file not found" there;
/// the login flag (`-l`) is also invalid for cmd / PowerShell.
/// So return [program, extra args] per platform, with the shell from settings taking priority.
fn shell_launch(requested: Option<&str>) -> (String, Vec<String>) {
    let wanted = requested.map(str::trim).filter(|s| !s.is_empty());

    #[cfg(windows)]
    {
        if let Some(shell) = wanted {
            return (shell.to_string(), Vec::new());
        }
        // PowerShell ships with Windows 10/11; Git Bash / WSL come from user settings
        for candidate in ["pwsh.exe", "powershell.exe"] {
            if in_windows_dir(candidate) || in_path(candidate) {
                return (candidate.to_string(), vec!["-NoLogo".to_string()]);
            }
        }
        // Last resort: COMSPEC points at cmd.exe; fall back to the literal name (always on PATH)
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        (comspec, Vec::new())
    }

    #[cfg(not(windows))]
    {
        let shell = wanted
            .map(str::to_string)
            .or_else(|| std::env::var("SHELL").ok().filter(|s| !s.is_empty()))
            .unwrap_or_else(|| default_unix_shell().to_string());
        (shell, vec!["-l".to_string()])
    }
}

#[cfg(not(windows))]
fn default_unix_shell() -> &'static str {
    if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/bash"
    }
}

#[cfg(windows)]
fn in_windows_dir(name: &str) -> bool {
    let Some(root) = std::env::var_os("SystemRoot") else {
        return false;
    };
    let dir = std::path::PathBuf::from(root).join("System32");
    // PowerShell lives in System32\WindowsPowerShell\v1.0\
    dir.join(name).is_file()
        || dir
            .join("WindowsPowerShell")
            .join("v1.0")
            .join(name)
            .is_file()
}

#[cfg(windows)]
fn in_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(name).is_file())
}

/// The Rust side owns the whole PTY session: master, writer, child
pub struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    /// Owning window: reclaimed when the window is destroyed, otherwise the shell keeps running
    pub owner: String,
}

impl PtySession {
    pub fn kill(&self) {
        let mut child = self.child.lock();
        let pid = child.process_id();
        #[cfg(unix)]
        if let Some(pid) = pid {
            // portable-pty makes the shell the session leader (setsid), so pgid == pid. Signal the
            // whole process group with SIGHUP / SIGTERM, then SIGKILL as a backstop: killing only the
            // shell would leave the dev server it started holding the port.
            let pgid = -(pid as i32);
            unsafe {
                libc::kill(pgid, libc::SIGHUP);
                libc::kill(pgid, libc::SIGTERM);
                libc::kill(pgid, libc::SIGKILL);
            }
        }
        // No process groups on Windows: `child.kill()` stops only the shell and the dev server it
        // started keeps the port. Kill the whole tree instead (taskkill, no extra dependency).
        #[cfg(windows)]
        if let Some(pid) = pid {
            let _ = proc::command("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyDataEvent {
    id: String,
    data: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExitEvent {
    id: String,
}

/// Incremental UTF-8 decoding: join chunks into complete chars so split multi-byte chars are not garbled
fn decode_incremental(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(s) => {
                out.push_str(s);
                pending.clear();
                return out;
            }
            Err(err) => {
                let valid = err.valid_up_to();
                if valid > 0 {
                    out.push_str(std::str::from_utf8(&pending[..valid]).unwrap_or(""));
                    pending.drain(..valid);
                }
                match err.error_len() {
                    Some(len) => {
                        out.push('\u{FFFD}');
                        pending.drain(..len);
                    }
                    // Incomplete char at the end; wait for the next chunk
                    None => return out,
                }
            }
        }
    }
}

#[tauri::command(async)]
pub fn pty_open(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    root: Option<String>,
    rel: Option<String>,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> AppResult<String> {
    // cwd may be "a directory inside the workspace": the frontend sends root + relative dir, and the backend still validates it
    let cwd = match root {
        Some(r) if !r.is_empty() => {
            let root_path = state.authorize(&r)?;
            let sub = rel.unwrap_or_default();
            if sub.is_empty() {
                Some(root_path)
            } else {
                let target = crate::state::resolve_in_root(&root_path, &sub)?;
                crate::state::assert_inside(&root_path, &target)?;
                if target.is_dir() {
                    Some(target)
                } else {
                    target.parent().map(|p| p.to_path_buf()).or(Some(root_path))
                }
            }
        }
        _ => None,
    };

    let (shell, shell_args) = shell_launch(shell.as_deref());

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::p("terminal.createFailed", [("error", e.to_string())]))?;

    let mut cmd = CommandBuilder::new(&shell);
    for arg in &shell_args {
        cmd.arg(arg);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Tell starship / zsh plugins they are inside an IDE terminal, like VSCode does
    cmd.env("TERM_PROGRAM", "vscode");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    // Without a project context fall back to the home dir: never inherit the app process cwd (e.g. build output/)
    if let Some(dir) = cwd.or_else(crate::paths::home_dir) {
        cmd.cwd(dir);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::p("terminal.shellFailed", [("error", e.to_string())]))?;
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::p("terminal.readFailed", [("error", e.to_string())]))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::p("terminal.writeFailed", [("error", e.to_string())]))?;

    let id = format!("pty-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    let session = Arc::new(PtySession {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        owner: window.label().to_string(),
    });

    state.ptys.lock().insert(id.clone(), session);

    // Reader thread only does "read -> send". A bounded channel makes the reader block when the
    // frontend falls behind, so the PTY backpressures instead of output piling up in memory.
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(64);
    let mut reader = reader;
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        // Empty chunk means EOF
        let _ = tx.send(Vec::new());
    });

    // Merge thread: coalesce frequent small chunks into one frame, flushing on timeout even with no
    // new data. Checking the clock only when data arrives would strand the last output after a
    // command ends (usually the new prompt) in acc.
    let app_handle = app.clone();
    let thread_id = id.clone();
    std::thread::spawn(move || {
        let mut pending: Vec<u8> = Vec::with_capacity(64);
        let mut acc = String::new();
        let emit = |acc: &mut String| {
            if acc.is_empty() {
                return;
            }
            let _ = app_handle.emit(
                "pty:data",
                PtyDataEvent {
                    id: thread_id.clone(),
                    data: std::mem::take(acc),
                },
            );
        };
        loop {
            let closed = match rx.recv_timeout(Duration::from_millis(8)) {
                Ok(chunk) if chunk.is_empty() => true,
                Ok(chunk) => {
                    pending.extend_from_slice(&chunk);
                    acc.push_str(&decode_incremental(&mut pending));
                    if acc.len() >= 32 * 1024 {
                        emit(&mut acc);
                    }
                    false
                }
                // Flush when idle: the shell prompt should not wait for the next keystroke
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    emit(&mut acc);
                    false
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => true,
            };
            if closed {
                break;
            }
        }
        emit(&mut acc);

        let _ = app_handle.emit(
            "pty:exit",
            PtyExitEvent {
                id: thread_id.clone(),
            },
        );

        // Reclaim the session after the shell exits, avoiding zombies and memory leaks
        let removed = app_handle
            .state::<AppState>()
            .ptys
            .lock()
            .remove(&thread_id);
        if let Some(session) = removed {
            session.kill();
        }
    });

    Ok(id)
}

#[tauri::command(async)]
pub fn pty_write(state: State<'_, AppState>, id: String, data: String) -> AppResult<()> {
    let session = state.ptys.lock().get(&id).cloned();
    let Some(session) = session else {
        return Err(AppError::c("terminal.closed"));
    };
    let mut writer = session.writer.lock();
    writer
        .write_all(data.as_bytes())
        .map_err(|e| AppError::p("terminal.writeFailed", [("error", e.to_string())]))?;
    writer.flush().ok();
    Ok(())
}

#[tauri::command(async)]
pub fn pty_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> AppResult<()> {
    let session = state.ptys.lock().get(&id).cloned();
    let Some(session) = session else {
        return Ok(());
    };
    let master = session.master.lock();
    master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::p("terminal.resizeFailed", [("error", e.to_string())]))?;
    Ok(())
}

#[tauri::command(async)]
pub fn pty_close(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let removed = state.ptys.lock().remove(&id);
    if let Some(session) = removed {
        session.kill();
    }
    Ok(())
}