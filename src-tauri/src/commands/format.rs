//! Formatting: run the one tool the user picked in settings.
//!
//! Prettier prefers the project's own copy (`node_modules/.bin/prettier` + project `.prettierrc`);
//! when missing, return `fallback: true` so the frontend runs the bundled standalone in the WebView;
//! rustfmt / gofmt / Black call system commands.
//!
//! Always "stdin -> stdout": no temp files, no disk writes; cwd is the file's directory so config applies.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::proc;
use crate::state::{assert_inside, resolve_in_root, AppState};

/// Supported tool ids (kept in sync with frontend lib/formatters.ts)
const TOOLS: [&str; 4] = ["prettier", "rustfmt", "gofmt", "black"];

fn label_of(tool: &str) -> &'static str {
    match tool {
        "prettier" => "Prettier",
        "rustfmt" => "rustfmt",
        "gofmt" => "gofmt",
        _ => "Black",
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
    /// project = the copy installed in the project; bundled = built-in Prettier; system = system command
    pub source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatResult {
    /// Formatted text; None when it did not run / failed
    pub text: Option<String>,
    pub changed: bool,
    /// project | bundled | system
    pub source: String,
    /// Error code the frontend translates (`format.missingBinary`) instead of raw text
    pub error_code: Option<String>,
    /// true = this project has no prettier; ask the frontend to retry with the bundled version
    pub fallback: bool,
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

/// Find an executable on PATH. Windows executables carry an extension (`.exe` / `.cmd` / `.bat`),
/// so `dir.join("rustfmt")` never matches; try each PATHEXT entry instead.
fn in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| e.to_ascii_lowercase())
            .collect()
    } else {
        Vec::new()
    };
    for dir in std::env::split_paths(&path) {
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        for ext in &exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn system_binary(tool: &str) -> Option<PathBuf> {
    match tool {
        "rustfmt" => in_path("rustfmt"),
        "gofmt" => in_path("gofmt"),
        "black" => in_path("black"),
        _ => None,
    }
}

/// Status bar: whether the selected tool is usable and which copy it uses
#[tauri::command(async)]
pub fn format_tool_status(
    state: State<'_, AppState>,
    root: String,
    rel: String,
    tool: String,
) -> AppResult<ToolStatus> {
    let label = label_of(&tool).to_string();
    if !TOOLS.contains(&tool.as_str()) {
        return Ok(ToolStatus {
            rule: None,
            label,
            available: false,
            source: String::new(),
        });
    }
    if !supports(&tool, &rel) {
        return Ok(ToolStatus {
            rule: None,
            label,
            available: false,
            source: String::new(),
        });
    }
    let rule = Path::new(&rel)
        .extension()
        .map(|ext| format!("*.{}", ext.to_string_lossy().to_lowercase()));

    if tool == "prettier" {
        let (workspace, file) = resolve_file(&state, &root, &rel)?;
        let dir = file.parent().unwrap_or(&workspace).to_path_buf();
        let source = if local_prettier(&dir, &workspace).is_some() {
            "project"
        } else {
            "bundled"
        };
        return Ok(ToolStatus {
            rule,
            label,
            available: true,
            source: source.to_string(),
        });
    }

    Ok(ToolStatus {
        rule,
        label,
        available: system_binary(&tool).is_some(),
        source: "system".to_string(),
    })
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

/// Run a "stdin -> stdout" formatter
fn run(bin: &Path, dir: &Path, args: &[String], text: &str) -> AppResult<String> {
    // Windows .cmd / .bat are not executables; they must go through cmd.exe or CreateProcess fails
    let is_script = cfg!(windows)
        && bin
            .extension()
            .map(|e| {
                let ext = e.to_string_lossy().to_ascii_lowercase();
                ext == "cmd" || ext == "bat"
            })
            .unwrap_or(false);

    let mut command = if is_script {
        let mut cmd = proc::command("cmd");
        cmd.arg("/C").arg(bin);
        cmd
    } else {
        proc::command(bin)
    };

    let mut child = command
        .current_dir(dir)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            AppError::p(
                "format.spawnFailed",
                [("bin", bin.display().to_string()), ("error", e.to_string())],
            )
        })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| AppError::p("format.writeFailed", [("error", e.to_string())]))?;
    }

    let out = child
        .wait_with_output()
        .map_err(|e| AppError::p("format.runFailed", [("error", e.to_string())]))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let message = stderr.trim();
        // Nothing to show when the tool printed nothing; use an error code so the frontend can phrase it
        if message.is_empty() {
            return Err(AppError::c("format.failed"));
        }
        // Formatter errors are often long; keep only the first few lines
        return Err(AppError::new(
            message.lines().take(4).collect::<Vec<_>>().join("\n"),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
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
            source: tool,
            error_code: None,
            fallback: false,
        });
    }

    let (workspace, file) = resolve_file(&state, &root, &rel)?;
    let dir = file.parent().unwrap_or(&workspace).to_path_buf();

    if tool == "prettier" {
        // Prefer the project's prettier when present (version and config follow the project);
        // otherwise hand off to the frontend's bundled Prettier
        let Some(bin) = local_prettier(&dir, &workspace) else {
            return Ok(FormatResult {
                text: None,
                changed: false,
                source: "bundled".to_string(),
                error_code: None,
                fallback: true,
            });
        };
        let args = vec![
            "--stdin-filepath".to_string(),
            file.to_string_lossy().to_string(),
        ];
        let formatted = run(&bin, &dir, &args, &text)?;
        return Ok(FormatResult {
            changed: formatted != text,
            text: Some(formatted),
            source: "project".to_string(),
            error_code: None,
            fallback: false,
        });
    }

    let Some(bin) = system_binary(&tool) else {
        return Ok(FormatResult {
            text: None,
            changed: false,
            source: "system".to_string(),
            error_code: Some("format.missingBinary".to_string()),
            fallback: false,
        });
    };

    let args: Vec<String> = match tool.as_str() {
        "rustfmt" => vec!["--edition".into(), "2021".into()],
        "black" => vec!["-q".into()],
        _ => Vec::new(),
    };
    let formatted = run(&bin, &dir, &args, &text)?;
    Ok(FormatResult {
        changed: formatted != text,
        text: Some(formatted),
        source: "system".to_string(),
        error_code: None,
        fallback: false,
    })
}