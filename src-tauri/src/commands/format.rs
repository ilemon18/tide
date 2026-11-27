//! Formatting: run the one tool the user picked in settings.
//!
//! Prettier prefers the project's own copy (`node_modules/.bin/prettier` + project `.prettierrc`);
//! when missing or not runnable, return `fallback: true` so the frontend runs the bundled standalone
//! in the WebView. rustfmt / gofmt / Black call system commands through stdin -> stdout.
//!
//! Tool discovery uses the augmented PATH shared with the agent child, because a GUI app on macOS
//! does not inherit the login shell's PATH. Install/update commands are direct argv calls, never a
//! shell, and each tool id is checked against the fixed whitelist below.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::{assert_inside, resolve_in_root, AppState};
use crate::toolpath;

/// Supported tool ids (kept in sync with frontend lib/formatters.ts)
const TOOLS: [&str; 4] = ["prettier", "rustfmt", "gofmt", "black"];

const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const FORMAT_TIMEOUT: Duration = Duration::from_secs(45);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

fn label_of(tool: &str) -> &'static str {
    match tool {
        "prettier" => "Prettier",
        "rustfmt" => "rustfmt",
        "gofmt" => "gofmt",
        _ => "Black",
    }
}

fn language_of(tool: &str) -> Option<&'static str> {
    match tool {
        "prettier" => Some("node"),
        "rustfmt" => Some("rust"),
        "gofmt" => Some("go"),
        "black" => Some("python"),
        _ => None,
    }
}

/// Which extensions this tool handles
fn supports(tool: &str, rel: &str) -> bool {
    let Some(ext) = Path::new(rel).extension().map(|e| e.to_string_lossy().to_lowercase()) else {
        return false;
    };
    match tool {
        "prettier" => matches!(
            ext.as_str(),
            "js" | "jsx"
                | "mjs"
                | "cjs"
                | "ts"
                | "tsx"
                | "mts"
                | "cts"
                | "json"
                | "jsonc"
                | "css"
                | "scss"
                | "less"
                | "html"
                | "vue"
                | "md"
                | "mdx"
                | "yaml"
                | "yml"
        ),
        "rustfmt" => ext == "rs",
        "gofmt" => ext == "go",
        "black" => ext == "py",
        _ => false,
    }
}

/// For the status bar: whether the selected tool works for this file and where its version comes from
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    /// Rule that matched, e.g. `*.tsx`; null = this tool does not handle the file
    pub rule: Option<String>,
    pub label: String,
    pub available: bool,
    /// project | bundled | system
    pub source: String,
    pub version: Option<String>,
}

/// Settings-page tool details. System tools need a language environment; the frontend uses this to
/// decide between install, update and a manual-instructions dialog.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatToolInfo {
    pub id: String,
    pub label: String,
    pub installed: bool,
    pub source: String,
    pub version: Option<String>,
    pub language: Option<String>,
    pub language_installed: bool,
    pub language_version: Option<String>,
    pub can_install: bool,
    pub can_update: bool,
    pub install_kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatResult {
    /// Formatted text; None when it did not run / failed
    pub text: Option<String>,
    pub changed: bool,
    /// project | bundled | system
    pub source: String,
    /// A coded error (`format.missingBinary`, `format.emptyOutput`, ...) for the frontend to translate.
    pub error: Option<String>,
    /// true = this project has no runnable prettier; ask the frontend to retry with bundled Prettier
    pub fallback: bool,
}

#[derive(Clone, Debug)]
struct ToolCommand {
    program: PathBuf,
    /// Arguments that must precede the action, e.g. `python3 -m black` or `py -3`.
    prefix: Vec<String>,
}

impl ToolCommand {
    fn new(program: PathBuf, prefix: &[&str]) -> Self {
        Self {
            program,
            prefix: prefix.iter().map(|value| (*value).to_string()).collect(),
        }
    }

    fn args(&self, extra: &[&str]) -> Vec<String> {
        self.prefix
            .iter()
            .cloned()
            .chain(extra.iter().map(|value| (*value).to_string()))
            .collect()
    }
}

#[derive(Debug)]
struct Capture {
    success: bool,
    stdout: String,
    stderr: String,
}

fn resolve_file(state: &AppState, root: &str, rel: &str) -> AppResult<(PathBuf, PathBuf)> {
    let root_path = state.authorize(root)?;
    // An external file is its own authorized root (rel is only the language/extension hint).
    // The workspace for tool discovery is its parent directory.
    if root_path.is_file() {
        let workspace = root_path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| AppError::c("fs.targetInvalid"))?;
        return Ok((workspace, root_path));
    }
    let file = resolve_in_root(&root_path, rel)?;
    assert_inside(&root_path, &file)?;
    Ok((root_path, file))
}

/// Prettier may be inspected from Settings without an open file: a project root is enough.
fn prettier_scope(
    state: &AppState,
    root: Option<&str>,
    rel: Option<&str>,
) -> AppResult<Option<(PathBuf, PathBuf)>> {
    let Some(root) = root.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let root_path = state.authorize(root)?;
    if root_path.is_file() {
        let Some(workspace) = root_path.parent().map(Path::to_path_buf) else {
            return Ok(None);
        };
        return Ok(Some((workspace.clone(), workspace)));
    }
    let start = match rel.filter(|value| !value.is_empty()) {
        Some(rel) => {
            let file = resolve_in_root(&root_path, rel)?;
            assert_inside(&root_path, &file)?;
            file.parent().unwrap_or(&root_path).to_path_buf()
        }
        None => root_path.clone(),
    };
    Ok(Some((root_path, start)))
}

/// Prettier executable names inside the project.
/// npm on Windows generates `prettier.cmd` (the extensionless file cannot be executed there),
/// so try them in platform order.
#[cfg(windows)]
const LOCAL_PRETTIER_NAMES: [&str; 2] = ["prettier.cmd", "prettier.bat"];
#[cfg(not(windows))]
const LOCAL_PRETTIER_NAMES: [&str; 2] = ["prettier", "prettier"];

/// Walk up from the file's directory looking for the project's prettier (`node_modules/.bin/prettier`).
/// One level above the workspace root is allowed: a monorepo's `.bin` often sits at the repo root.
fn local_prettier(start: &Path, stop_at: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    let mut hops = 0;
    let mut beyond_root = 0;
    while let Some(current) = dir {
        if hops > 12 {
            break;
        }
        for name in LOCAL_PRETTIER_NAMES {
            let candidate = current.join("node_modules").join(".bin").join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        if current == stop_at {
            beyond_root += 1;
            if beyond_root > 1 {
                break;
            }
        }
        dir = current.parent();
        hops += 1;
    }
    None
}

fn command_in_path(names: &[&str]) -> Option<ToolCommand> {
    toolpath::find_executable(names).map(|path| ToolCommand::new(path, &[]))
}

fn rustup_command() -> Option<ToolCommand> {
    command_in_path(&["rustup"])
}

fn pipx_command() -> Option<ToolCommand> {
    command_in_path(&["pipx"])
}

fn python_command() -> Option<ToolCommand> {
    #[cfg(windows)]
    if let Some(py) = toolpath::find_executable(&["py"]) {
        return Some(ToolCommand::new(py, &["-3"]));
    }
    command_in_path(&["python3", "python"])
}

fn black_command() -> Option<ToolCommand> {
    if let Some(path) = toolpath::find_executable(&["black"]) {
        return Some(ToolCommand::new(path, &[]));
    }
    let python = python_command()?;
    let mut prefix = python.prefix.clone();
    prefix.push("-m".to_string());
    prefix.push("black".to_string());
    Some(ToolCommand {
        program: python.program,
        prefix,
    })
}

fn gofmt_command() -> Option<ToolCommand> {
    if let Some(path) = toolpath::find_executable(&["gofmt"]) {
        return Some(ToolCommand::new(path, &[]));
    }
    // A GUI process may not have GOROOT/bin on PATH even though `go` is available.
    let go = command_in_path(&["go"])?;
    let capture = run_process(&go, &["env".into(), "GOROOT".into()], None, None, PROBE_TIMEOUT).ok()?;
    if !capture.success {
        return None;
    }
    let root = capture.stdout.trim();
    if root.is_empty() {
        return None;
    }
    let name = if cfg!(windows) { "gofmt.exe" } else { "gofmt" };
    let path = Path::new(root).join("bin").join(name);
    toolpath::executable(&path).then(|| ToolCommand::new(path, &[]))
}

fn system_command(tool: &str) -> Option<ToolCommand> {
    match tool {
        "rustfmt" => command_in_path(&["rustfmt"]),
        "gofmt" => gofmt_command(),
        "black" => black_command(),
        _ => None,
    }
}

fn prettier_project(
    state: &AppState,
    root: Option<&str>,
    rel: Option<&str>,
) -> AppResult<Option<(ToolCommand, String)>> {
    let Some((workspace, start)) = prettier_scope(state, root, rel)? else {
        return Ok(None);
    };
    let Some(path) = local_prettier(&start, &workspace) else {
        return Ok(None);
    };
    let command = ToolCommand::new(path, &[]);
    // A node_modules entry may exist while node itself is unavailable. Treat that as "no project
    // Prettier" so formatting falls back to the bundled build instead of failing.
    let Some(version) = probe_version(&command, &["--version"]) else {
        return Ok(None);
    };
    Ok(Some((command, version)))
}

#[derive(Debug)]
enum ProcessError {
    Spawn(std::io::Error),
    Io(std::io::Error),
    Timeout,
}

fn read_stream<R: Read + Send + 'static>(mut reader: R, tx: mpsc::Sender<Vec<u8>>) {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    if bytes.len() < MAX_OUTPUT_BYTES {
                        let room = MAX_OUTPUT_BYTES - bytes.len();
                        bytes.extend_from_slice(&chunk[..n.min(room)]);
                    }
                }
                Err(ref error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = tx.send(bytes);
    });
}

fn run_process(
    command: &ToolCommand,
    args: &[String],
    dir: Option<&Path>,
    input: Option<&str>,
    timeout: Duration,
) -> Result<Capture, ProcessError> {
    let mut process = toolpath::build_command(&command.program, args);
    if let Some(dir) = dir {
        process.current_dir(dir);
    }
    process
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = process.spawn().map_err(ProcessError::Spawn)?;
    if let Some(input) = input {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(input.as_bytes()).map_err(ProcessError::Io)?;
        }
    }

    let stdout = child.stdout.take().ok_or_else(|| {
        ProcessError::Io(std::io::Error::new(std::io::ErrorKind::Other, "stdout pipe missing"))
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        ProcessError::Io(std::io::Error::new(std::io::ErrorKind::Other, "stderr pipe missing"))
    })?;
    let (stdout_tx, stdout_rx) = mpsc::channel();
    let (stderr_tx, stderr_rx) = mpsc::channel();
    read_stream(stdout, stdout_tx);
    read_stream(stderr, stderr_tx);

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(ProcessError::Timeout);
                }
                thread::sleep(Duration::from_millis(15));
            }
            Err(error) => {
                let _ = child.kill();
                return Err(ProcessError::Io(error));
            }
        }
    };

    let stdout = stdout_rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    let stderr = stderr_rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    Ok(Capture {
        success: status.success(),
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
    })
}

fn process_error(command: &ToolCommand, error: ProcessError) -> AppError {
    match error {
        ProcessError::Spawn(error) => AppError::p(
            "format.spawnFailed",
            [
                ("bin", command.program.display().to_string()),
                ("error", error.to_string()),
            ],
        ),
        ProcessError::Io(error) => AppError::p("format.runFailed", [("error", error.to_string())]),
        ProcessError::Timeout => AppError::c("format.timeout"),
    }
}

/// Probe a command and return its combined text. Some tools (Python on some platforms) print
/// `--version` to stderr, so stdout alone is not enough.
fn probe(command: &ToolCommand, extra: &[&str]) -> Option<String> {
    let capture = run_process(command, &command.args(extra), None, None, PROBE_TIMEOUT).ok()?;
    if !capture.success {
        return None;
    }
    let text = if capture.stdout.trim().is_empty() {
        capture.stderr
    } else {
        capture.stdout
    };
    (!text.trim().is_empty()).then_some(text)
}

fn first_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|line| !line.is_empty())
}

fn parse_rustfmt_version(text: &str) -> Option<String> {
    first_line(text)?.split_whitespace().nth(1).map(str::to_string)
}

fn parse_black_version(text: &str) -> Option<String> {
    first_line(text)?
        .split_whitespace()
        .nth(1)
        .map(|value| value.trim_end_matches(',').to_string())
}

fn parse_go_version(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| line.starts_with("go version "))
        .and_then(|line| line.split_whitespace().nth(2))
        .map(str::to_string)
}

fn parse_python_version(text: &str) -> Option<String> {
    first_line(text)?
        .split_whitespace()
        .find(|part| part.chars().next().is_some_and(|ch| ch.is_ascii_digit()))
        .map(str::to_string)
}

fn parse_node_version(text: &str) -> Option<String> {
    let version = first_line(text)?.trim();
    Some(if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    })
}

fn probe_version(command: &ToolCommand, extra: &[&str]) -> Option<String> {
    let text = probe(command, extra)?;
    let tool = command.program.to_string_lossy().to_lowercase();
    if tool.ends_with("rustfmt") {
        parse_rustfmt_version(&text)
    } else if tool.contains("black") || command.prefix.iter().any(|value| value == "black") {
        parse_black_version(&text)
    } else if tool.ends_with("prettier") || tool.contains("prettier") {
        first_line(&text).map(str::to_string)
    } else {
        first_line(&text).map(str::to_string)
    }
}

fn tool_version(tool: &str, command: &ToolCommand) -> Option<String> {
    match tool {
        "rustfmt" => probe(command, &["--version"]).and_then(|text| parse_rustfmt_version(&text)),
        "gofmt" => {
            let go = command_in_path(&["go"])?;
            probe(&go, &["version"]).and_then(|text| parse_go_version(&text))
        }
        "black" => probe(command, &["--version"]).and_then(|text| parse_black_version(&text)),
        "prettier" => probe(command, &["--version"])
            .and_then(|text| first_line(&text).map(str::to_string)),
        _ => None,
    }
}

fn rust_environment() -> (bool, Option<String>) {
    if let Some(rustc) = command_in_path(&["rustc"]) {
        if let Some(text) = probe(&rustc, &["--version"]) {
            let version = first_line(&text)
                .and_then(|line| line.split_whitespace().nth(1))
                .map(str::to_string);
            return (true, version);
        }
    }
    if let Some(rustup) = rustup_command() {
        return (true, probe(&rustup, &["--version"]).and_then(|text| first_line(&text).map(str::to_string)));
    }
    (false, None)
}

fn go_environment() -> (bool, Option<String>) {
    let Some(go) = command_in_path(&["go"]) else {
        return (false, None);
    };
    let version = probe(&go, &["version"]).and_then(|text| parse_go_version(&text));
    (true, version)
}

fn python_environment() -> (bool, Option<String>) {
    let Some(python) = python_command() else {
        return (false, None);
    };
    let version = probe(&python, &["--version"]).and_then(|text| parse_python_version(&text));
    (true, version)
}

fn node_environment() -> (bool, Option<String>) {
    let Some(node) = command_in_path(&["node"]) else {
        return (false, None);
    };
    let version = probe(&node, &["--version"]).and_then(|text| parse_node_version(&text));
    (true, version)
}

fn environment_of(tool: &str) -> (bool, Option<String>) {
    match tool {
        "rustfmt" => rust_environment(),
        "gofmt" => go_environment(),
        "black" => python_environment(),
        "prettier" => node_environment(),
        _ => (false, None),
    }
}

fn pip_available(python: &ToolCommand) -> bool {
    probe(python, &["-m", "pip", "--version"]).is_some()
}

fn pipx_has_black() -> bool {
    let Some(pipx) = pipx_command() else {
        return false;
    };
    let Some(text) = probe(&pipx, &["list", "--short"]) else {
        return false;
    };
    text.lines()
        .any(|line| line.split_whitespace().next() == Some("black"))
}

fn black_install_kind(command: Option<&ToolCommand>) -> &'static str {
    let via_pipx = command
        .map(|value| value.program.to_string_lossy().to_lowercase().contains("pipx"))
        .unwrap_or(false)
        || pipx_has_black();
    if via_pipx {
        return "pipx";
    }
    let Some(python) = python_command() else {
        return "manual";
    };
    if pip_available(&python) {
        "pip"
    } else {
        "manual"
    }
}

fn tool_info_inner(
    state: &AppState,
    root: Option<&str>,
    rel: Option<&str>,
    tool: &str,
) -> AppResult<FormatToolInfo> {
    let label = label_of(tool).to_string();
    let language = language_of(tool).map(str::to_string);
    let (language_installed, language_version) = environment_of(tool);
    if tool == "prettier" {
        let project = prettier_project(state, root, rel)?;
        let (source, version) = match project {
            Some((_, version)) => ("project", Some(version)),
            None => ("bundled", None),
        };
        return Ok(FormatToolInfo {
            id: tool.to_string(),
            label,
            installed: true,
            source: source.to_string(),
            version,
            language,
            language_installed,
            language_version,
            can_install: false,
            can_update: false,
            install_kind: "bundled".to_string(),
        });
    }

    let command = system_command(tool);
    let installed = command.is_some();
    let version = command.as_ref().and_then(|value| tool_version(tool, value));
    let (can_install, can_update, install_kind) = match tool {
        "rustfmt" => {
            let rustup = rustup_command().is_some();
            (!installed && rustup, installed && rustup, if rustup { "rustup" } else { "manual" })
        }
        "black" => {
            let kind = black_install_kind(command.as_ref());
            (!installed && kind != "manual", installed && kind != "manual", kind)
        }
        "gofmt" => (false, false, "manual"),
        _ => (false, false, "manual"),
    };

    Ok(FormatToolInfo {
        id: tool.to_string(),
        label,
        installed,
        source: "system".to_string(),
        version,
        language,
        language_installed,
        language_version,
        can_install,
        can_update,
        install_kind: install_kind.to_string(),
    })
}

/// Status bar: whether the selected tool is usable and which copy it uses.
#[tauri::command(async)]
pub fn format_tool_status(
    state: State<'_, AppState>,
    root: String,
    rel: String,
    tool: String,
) -> AppResult<ToolStatus> {
    let label = label_of(&tool).to_string();
    if !TOOLS.contains(&tool.as_str()) || !supports(&tool, &rel) {
        return Ok(ToolStatus {
            rule: None,
            label,
            available: false,
            source: String::new(),
            version: None,
        });
    }
    let rule = Path::new(&rel)
        .extension()
        .map(|ext| format!("*.{}", ext.to_string_lossy().to_lowercase()));
    let info = tool_info_inner(&state, Some(&root), Some(&rel), &tool)?;
    Ok(ToolStatus {
        rule,
        label: info.label,
        available: info.installed,
        source: info.source,
        version: info.version,
    })
}

/// Settings-page detection. `root` is optional because the page can be open with no workspace.
#[tauri::command(async)]
pub fn format_tool_info(
    state: State<'_, AppState>,
    root: Option<String>,
    rel: Option<String>,
    tool: String,
) -> AppResult<FormatToolInfo> {
    if !TOOLS.contains(&tool.as_str()) {
        return Err(AppError::c("format.unknownTool"));
    }
    tool_info_inner(&state, root.as_deref(), rel.as_deref(), &tool)
}

fn run_install(
    command: &ToolCommand,
    args: &[&str],
    fallback_code: &'static str,
) -> AppResult<()> {
    let capture = run_process(
        command,
        &command.args(args),
        None,
        None,
        INSTALL_TIMEOUT,
    )
    .map_err(|error| process_error(command, error))?;
    if capture.success {
        return Ok(());
    }
    let message = capture.stderr.trim();
    if message.is_empty() {
        Err(AppError::c(fallback_code))
    } else {
        Err(AppError::new(
            message.lines().take(8).collect::<Vec<_>>().join("\n"),
        ))
    }
}

/// Install the formatter itself. Language runtimes are deliberately never installed here.
#[tauri::command(async)]
pub fn format_tool_install(
    state: State<'_, AppState>,
    tool: String,
) -> AppResult<FormatToolInfo> {
    if !TOOLS.contains(&tool.as_str()) {
        return Err(AppError::c("format.unknownTool"));
    }
    match tool.as_str() {
        "rustfmt" => {
            let rustup = rustup_command().ok_or_else(|| AppError::c("format.installUnsupported"))?;
            run_install(&rustup, &["component", "add", "rustfmt"], "format.installFailed")?;
        }
        "black" => {
            let kind = black_install_kind(None);
            match kind {
                "pipx" => {
                    let pipx = pipx_command().ok_or_else(|| AppError::c("format.installUnsupported"))?;
                    run_install(&pipx, &["install", "black"], "format.installFailed")?;
                }
                "pip" => {
                    let python = python_command().ok_or_else(|| AppError::c("format.installUnsupported"))?;
                    run_install(
                        &python,
                        &["-m", "pip", "install", "--user", "--upgrade", "black"],
                        "format.installFailed",
                    )?;
                }
                _ => return Err(AppError::c("format.installUnsupported")),
            }
        }
        _ => return Err(AppError::c("format.installUnsupported")),
    }
    tool_info_inner(&state, None, None, &tool)
}

/// Update an installed system formatter. gofmt is part of Go and bundled Prettier follows Tide,
/// so those tools intentionally have no updater here.
#[tauri::command(async)]
pub fn format_tool_update(
    state: State<'_, AppState>,
    tool: String,
) -> AppResult<FormatToolInfo> {
    if !TOOLS.contains(&tool.as_str()) {
        return Err(AppError::c("format.unknownTool"));
    }
    match tool.as_str() {
        "rustfmt" => {
            let rustup = rustup_command().ok_or_else(|| AppError::c("format.updateUnsupported"))?;
            run_install(&rustup, &["update"], "format.updateFailed")?;
        }
        "black" => {
            let installed = black_command();
            let kind = black_install_kind(installed.as_ref());
            match kind {
                "pipx" => {
                    let pipx = pipx_command().ok_or_else(|| AppError::c("format.updateUnsupported"))?;
                    run_install(&pipx, &["upgrade", "black"], "format.updateFailed")?;
                }
                "pip" => {
                    let python = python_command().ok_or_else(|| AppError::c("format.updateUnsupported"))?;
                    run_install(
                        &python,
                        &["-m", "pip", "install", "--user", "--upgrade", "black"],
                        "format.updateFailed",
                    )?;
                }
                _ => return Err(AppError::c("format.updateUnsupported")),
            }
        }
        _ => return Err(AppError::c("format.updateUnsupported")),
    }
    tool_info_inner(&state, None, None, &tool)
}

/// The project's Prettier config (JSON forms only: `.prettierrc` / `.prettierrc.json` /
/// the `prettier` field of `package.json`). YAML / JS configs are not parsed here.
#[tauri::command(async)]
pub fn prettier_config(
    state: State<'_, AppState>,
    root: String,
    rel: String,
) -> AppResult<Option<Value>> {
    let (workspace, file) = resolve_file(&state, &root, &rel)?;
    let mut dir = Some(file.parent().unwrap_or(&workspace));
    while let Some(current) = dir {
        for name in [".prettierrc", ".prettierrc.json"] {
            let path = current.join(name);
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    return Ok(Some(value));
                }
            }
        }
        let manifest = current.join("package.json");
        if let Ok(text) = std::fs::read_to_string(&manifest) {
            if let Ok(json) = serde_json::from_str::<Value>(&text) {
                if let Some(value) = json.get("prettier") {
                    return Ok(Some(value.clone()));
                }
            }
        }
        if current == workspace {
            break;
        }
        match current.parent() {
            Some(parent) => dir = Some(parent),
            None => break,
        }
    }
    Ok(None)
}


fn formatter_args(tool: &str) -> Vec<&'static str> {
    match tool {
        "rustfmt" => vec!["--edition", "2021"],
        "black" => vec!["-q", "-"],
        _ => Vec::new(),
    }
}

fn checked_output(input: &str, output: String) -> AppResult<String> {
    if !input.trim().is_empty() && output.trim().is_empty() {
        return Err(AppError::c("format.emptyOutput"));
    }
    Ok(output)
}

/// Run a "stdin -> stdout" formatter.
fn run_formatter(
    command: &ToolCommand,
    dir: &Path,
    extra: &[&str],
    text: &str,
    timeout: Duration,
) -> AppResult<String> {
    let capture = run_process(
        command,
        &command.args(extra),
        Some(dir),
        Some(text),
        timeout,
    )
    .map_err(|error| process_error(command, error))?;
    if !capture.success {
        let stderr = capture.stderr.trim();
        if stderr.is_empty() {
            return Err(AppError::c("format.failed"));
        }
        return Err(AppError::new(
            stderr.lines().take(6).collect::<Vec<_>>().join("\n"),
        ));
    }
    checked_output(text, capture.stdout)
}

/// Format text. The frontend passes the tool from settings; no guessing here.
#[tauri::command(async)]
pub fn format_text(
    state: State<'_, AppState>,
    root: String,
    rel: String,
    tool: String,
    text: String,
) -> AppResult<FormatResult> {
    if !TOOLS.contains(&tool.as_str()) || !supports(&tool, &rel) {
        return Ok(FormatResult {
            text: None,
            changed: false,
            source: "unsupported".to_string(),
            error: None,
            fallback: false,
        });
    }

    let (workspace, file) = resolve_file(&state, &root, &rel)?;
    let dir = file.parent().unwrap_or(&workspace).to_path_buf();

    if tool == "prettier" {
        let Some((command, _)) = prettier_project(&state, Some(&root), Some(&rel))? else {
            return Ok(FormatResult {
                text: None,
                changed: false,
                source: "bundled".to_string(),
                error: None,
                fallback: true,
            });
        };
        let args = vec![
            "--stdin-filepath".to_string(),
            file.to_string_lossy().to_string(),
        ];
        let extra: Vec<&str> = args.iter().map(String::as_str).collect();
        match run_formatter(&command, &dir, &extra, &text, FORMAT_TIMEOUT) {
            Ok(formatted) => Ok(FormatResult {
                changed: formatted != text,
                text: Some(formatted),
                source: "project".to_string(),
                error: None,
                fallback: false,
            }),
            // A project copy that cannot start (usually node missing) is not a user-facing
            // formatting error: use the bundled Prettier instead.
            Err(error) if error.code == "format.spawnFailed" => Ok(FormatResult {
                text: None,
                changed: false,
                source: "bundled".to_string(),
                error: None,
                fallback: true,
            }),
            Err(error) => Err(error),
        }
    } else {
        let Some(command) = system_command(&tool) else {
            return Ok(FormatResult {
                text: None,
                changed: false,
                source: "system".to_string(),
                error: Some("format.missingBinary".to_string()),
                fallback: false,
            });
        };
        let args = formatter_args(&tool);
        let formatted = run_formatter(&command, &dir, &args, &text, FORMAT_TIMEOUT)?;
        Ok(FormatResult {
            changed: formatted != text,
            text: Some(formatted),
            source: "system".to_string(),
            error: None,
            fallback: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supports_only_its_own_extensions() {
        assert!(supports("prettier", "src/App.tsx"));
        assert!(supports("prettier", "README.MD"));
        assert!(supports("rustfmt", "src/main.rs"));
        assert!(supports("gofmt", "main.go"));
        assert!(supports("black", "tool.py"));
        assert!(!supports("rustfmt", "main.go"));
        assert!(!supports("gofmt", "main.rs"));
    }

    #[test]
    fn black_uses_explicit_stdin_source() {
        assert_eq!(formatter_args("black"), vec!["-q", "-"]);
        let command = ToolCommand::new(PathBuf::from("python3"), &["-m", "black"]);
        assert_eq!(
            command.args(&formatter_args("black")),
            vec!["-m".to_string(), "black".to_string(), "-q".to_string(), "-".to_string()]
        );
    }

    #[test]
    fn parses_versions_from_tool_output() {
        assert_eq!(
            parse_rustfmt_version("rustfmt 1.9.0-stable (59807616e1 2026-04-14)"),
            Some("1.9.0-stable".to_string())
        );
        assert_eq!(
            parse_black_version("black, 25.1.0 (compiled: yes)"),
            Some("25.1.0".to_string())
        );
        assert_eq!(
            parse_go_version("go version go1.26.1 darwin/amd64"),
            Some("go1.26.1".to_string())
        );
        assert_eq!(parse_python_version("Python 3.15.2"), Some("3.15.2".to_string()));
        assert_eq!(parse_node_version("v20.11.0"), Some("v20.11.0".to_string()));
    }

    #[test]
    fn rejects_empty_formatter_output() {
        assert_eq!(checked_output("const x = 1;\n", String::new()).unwrap_err().code, "format.emptyOutput");
        assert_eq!(checked_output("   \n", String::new()).unwrap(), "");
        assert_eq!(checked_output("const x = 1;\n", "const x = 1;\n".into()).unwrap(), "const x = 1;\n");
    }
}
