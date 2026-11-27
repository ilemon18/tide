//! Executable discovery shared by agent and formatter probes.
//!
//! A GUI app on macOS does not inherit the login shell's PATH. Looking only at the process
//! environment therefore misses tools installed through rustup, Homebrew, pipx or a system Go
//! package. Keep one search path for every child-tool probe and the agent child environment.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::proc;

fn home_dir() -> Option<PathBuf> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Add versioned Python user-script directories without guessing every interpreter version.
fn push_python_bins(dirs: &mut Vec<PathBuf>, root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let candidate = entry.path().join("bin");
        if candidate.is_dir() {
            dirs.push(candidate);
        }
    }
}

#[cfg(windows)]
fn push_windows_python_bins(dirs: &mut Vec<PathBuf>, root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let candidate = entry.path().join("Scripts");
        if candidate.is_dir() {
            dirs.push(candidate);
        }
    }
}

/// PATH plus the usual package-manager bin directories.
pub fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    if let Some(home) = home_dir() {
        for rel in [
            ".volta/bin",
            ".local/bin",
            ".local/share/pnpm",
            ".bun/bin",
            ".npm-global/bin",
            ".cargo/bin",
            ".deno/bin",
            ".asdf/shims",
            ".pyenv/shims",
        ] {
            dirs.push(home.join(rel));
        }
        // macOS Python's `pip install --user` lands in ~/Library/Python/<version>/bin.
        push_python_bins(&mut dirs, &home.join("Library").join("Python"));
        #[cfg(windows)]
        {
            push_windows_python_bins(&mut dirs, &home.join("AppData").join("Roaming").join("Python"));
            push_windows_python_bins(
                &mut dirs,
                &home.join("AppData").join("Local").join("Programs").join("Python"),
            );
        }
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/local/go/bin"] {
        dirs.push(PathBuf::from(dir));
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            dirs.push(PathBuf::from(program_files).join("Go").join("bin"));
        }
    }
    dirs
}

pub fn executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Find one of `binaries` in `dirs`. On Windows the executable extensions are tried explicitly.
pub fn find_in_dirs(binaries: &[&str], dirs: &[PathBuf]) -> Option<PathBuf> {
    for name in binaries {
        for dir in dirs {
            #[cfg(windows)]
            {
                for suffix in [".exe", ".cmd", ".bat", ""] {
                    let candidate = dir.join(format!("{name}{suffix}"));
                    if executable(&candidate) {
                        return Some(candidate);
                    }
                }
            }
            #[cfg(not(windows))]
            {
                let candidate = dir.join(name);
                if executable(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// Find a command in the augmented PATH without spawning a login shell.
pub fn find_executable(binaries: &[&str]) -> Option<PathBuf> {
    find_in_dirs(binaries, &search_dirs())
}

/// PATH for child tools: the GUI app inherits a minimal PATH on macOS, so an agent's own Bash
/// tool would not find pnpm/node/git installed under volta or Homebrew.
pub fn augmented_path() -> Option<OsString> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for dir in search_dirs() {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    std::env::join_paths(dirs).ok()
}

/// Build a command that never opens a console window on Windows and handles `.cmd` / `.bat`.
pub fn build_command(program: &Path, args: &[String]) -> Command {
    #[cfg(windows)]
    {
        let ext = program
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if ext == "cmd" || ext == "bat" {
            let mut cmd = proc::command("cmd.exe");
            cmd.arg("/C").arg(program);
            for arg in args {
                cmd.arg(arg);
            }
            return cmd;
        }
    }
    let mut cmd = proc::command(program);
    for arg in args {
        cmd.arg(arg);
    }
    cmd
}
