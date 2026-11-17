//! Local agent CLI discovery.
//!
//! A GUI app on macOS does not inherit the login shell's PATH, so `which claude` from a
//! terminal proves nothing here. The scan looks in PATH plus the usual package-manager bin
//! directories, then asks the login shell once for the two providers Tide can talk to.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::proc;

pub struct ProviderSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub binaries: &'static [&'static str],
    /// Only these speak the CLI protocol Tide implements end to end
    pub supported: bool,
}

pub const PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec { id: "claude", name: "Claude Code", binaries: &["claude"], supported: true },
    ProviderSpec { id: "codex", name: "Codex", binaries: &["codex"], supported: true },
    ProviderSpec { id: "gemini", name: "Gemini CLI", binaries: &["gemini"], supported: false },
    ProviderSpec { id: "cursor", name: "Cursor Agent", binaries: &["cursor-agent"], supported: false },
    ProviderSpec { id: "opencode", name: "OpenCode", binaries: &["opencode"], supported: false },
    ProviderSpec { id: "qwen", name: "Qwen Code", binaries: &["qwen"], supported: false },
    ProviderSpec { id: "goose", name: "Goose", binaries: &["goose"], supported: false },
    ProviderSpec { id: "copilot", name: "GitHub Copilot", binaries: &["copilot"], supported: false },
    ProviderSpec { id: "aider", name: "Aider", binaries: &["aider"], supported: false },
    ProviderSpec { id: "crush", name: "Crush", binaries: &["crush"], supported: false },
    ProviderSpec { id: "amp", name: "Amp", binaries: &["amp"], supported: false },
    ProviderSpec { id: "droid", name: "Droid", binaries: &["droid"], supported: false },
];

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderInfo {
    pub id: String,
    pub name: String,
    pub command: Option<String>,
    pub version: Option<String>,
    pub installed: bool,
    pub supported: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelInfo {
    pub id: String,
    pub label: String,
    pub efforts: Vec<String>,
    pub default_effort: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCatalog {
    pub provider: String,
    pub models: Vec<AgentModelInfo>,
    /// Levels offered for the CLI default model (and for custom ids)
    pub efforts: Vec<String>,
    pub default_model: String,
}

static SCAN: Mutex<Option<Vec<AgentProviderInfo>>> = Mutex::new(None);
static CATALOGS: Mutex<Option<HashMap<String, (Instant, AgentCatalog)>>> = Mutex::new(None);
const CATALOG_TTL: Duration = Duration::from_secs(300);
const MAX_CATALOG_BYTES: usize = 8 * 1024 * 1024;

fn home_dir() -> Option<PathBuf> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    if let Some(home) = home_dir() {
        for rel in [
            ".volta/bin",
            ".local/bin",
            ".bun/bin",
            ".npm-global/bin",
            ".cargo/bin",
            ".deno/bin",
            ".asdf/shims",
        ] {
            dirs.push(home.join(rel));
        }
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
        dirs.push(PathBuf::from(dir));
    }
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    dirs
}

fn executable(path: &Path) -> bool {
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

fn find_in_dirs(binaries: &[&str], dirs: &[PathBuf]) -> Option<PathBuf> {
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

/// Run a program, read its stdout concurrently (a large catalog must not fill the pipe and
/// deadlock `try_wait`), and give up after `timeout`.
pub fn run_capture(program: &Path, args: &[String], timeout: Duration) -> Option<String> {
    let mut command = build_command(program, args);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 16384];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    if buf.len() < MAX_CATALOG_BYTES {
                        buf.extend_from_slice(&chunk[..n]);
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = tx.send(buf);
    });

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(_) => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let bytes = rx.recv_timeout(Duration::from_secs(2)).ok()?;
    if bytes.len() > MAX_CATALOG_BYTES {
        return None;
    }
    String::from_utf8(bytes).ok()
}

#[cfg(windows)]
pub fn build_command(program: &Path, args: &[String]) -> Command {
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
    let mut cmd = proc::command(program);
    for arg in args {
        cmd.arg(arg);
    }
    cmd
}

#[cfg(not(windows))]
pub fn build_command(program: &Path, args: &[String]) -> Command {
    let mut cmd = proc::command(program);
    for arg in args {
        cmd.arg(arg);
    }
    cmd
}

/// One login-shell lookup for a supported provider whose binary the plain scan missed.
fn shell_lookup(name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let _ = name;
        None
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/zsh".to_string());
        // `name` comes from the static table, never from user input.
        let script = format!("command -v {name}");
        let output = run_capture(
            Path::new(&shell),
            &["-lc".to_string(), script],
            Duration::from_millis(2000),
        )?;
        let line = output.lines().last()?.trim().to_string();
        if line.is_empty() {
            return None;
        }
        let path = PathBuf::from(line);
        path.is_file().then_some(path)
    }
}

fn probe_version(program: &Path) -> Option<String> {
    let out = run_capture(
        program,
        &["--version".to_string()],
        Duration::from_millis(2000),
    )?;
    out.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

/// PATH for the agent child: the GUI app inherits a minimal PATH on macOS, so an agent's
/// own Bash tool would not find pnpm/node/git installed under volta or Homebrew.
pub fn augmented_path() -> Option<std::ffi::OsString> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for dir in search_dirs() {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    std::env::join_paths(dirs).ok()
}

pub fn scan(force: bool) -> Vec<AgentProviderInfo> {
    let mut cache = SCAN.lock();
    if !force {
        if let Some(known) = cache.as_ref() {
            return known.clone();
        }
    }
    let dirs = search_dirs();
    let mut out = Vec::with_capacity(PROVIDERS.len());
    for spec in PROVIDERS {
        let mut found = find_in_dirs(spec.binaries, &dirs);
        if found.is_none() && spec.supported {
            found = shell_lookup(spec.binaries[0]);
        }
        // Only the two we can drive are probed: a stray CLI hanging on --version must not delay the panel
        let version = if spec.supported {
            found.as_ref().and_then(|path| probe_version(path))
        } else {
            None
        };
        out.push(AgentProviderInfo {
            id: spec.id.to_string(),
            name: spec.name.to_string(),
            command: found.as_ref().map(|p| p.to_string_lossy().to_string()),
            version,
            installed: found.is_some(),
            supported: spec.supported,
        });
    }
    *cache = Some(out.clone());
    out
}

pub fn installed(id: &str) -> Option<AgentProviderInfo> {
    scan(false).into_iter().find(|p| p.id == id && p.installed)
}

fn claude_catalog() -> AgentCatalog {
    let efforts: Vec<String> = ["low", "medium", "high", "xhigh", "max"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let models = [
        ("sonnet", "Claude Sonnet"),
        ("opus", "Claude Opus"),
        ("haiku", "Claude Haiku"),
    ]
    .iter()
    .map(|(id, label)| AgentModelInfo {
        id: (*id).to_string(),
        label: (*label).to_string(),
        efforts: efforts.clone(),
        default_effort: String::new(),
    })
    .collect();
    AgentCatalog {
        provider: "claude".into(),
        models,
        efforts,
        default_model: String::new(),
    }
}

#[derive(serde::Deserialize)]
struct DebugEffort {
    #[serde(default)]
    effort: String,
}

#[derive(serde::Deserialize)]
struct DebugModel {
    #[serde(default)]
    slug: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    visibility: Option<String>,
    #[serde(default)]
    supported_reasoning_levels: Vec<DebugEffort>,
    #[serde(default)]
    default_reasoning_level: String,
}

#[derive(serde::Deserialize)]
struct DebugCatalog {
    #[serde(default)]
    models: Vec<DebugModel>,
}

fn codex_catalog() -> AgentCatalog {
    let fallback_efforts: Vec<String> = ["low", "medium", "high", "xhigh", "max"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let Some(info) = installed("codex") else {
        return AgentCatalog {
            provider: "codex".into(),
            models: Vec::new(),
            efforts: fallback_efforts,
            default_model: String::new(),
        };
    };
    let Some(command) = info.command else {
        return AgentCatalog {
            provider: "codex".into(),
            models: Vec::new(),
            efforts: fallback_efforts,
            default_model: String::new(),
        };
    };
    let output = run_capture(
        Path::new(&command),
        &["debug".to_string(), "models".to_string()],
        Duration::from_secs(15),
    );
    let Some(parsed) = output.and_then(|text| {
        // A wrapper may print a banner before the JSON; start at the first object
        let start = text.find('{')?;
        serde_json::from_str::<DebugCatalog>(&text[start..]).ok()
    }) else {
        return AgentCatalog {
            provider: "codex".into(),
            models: Vec::new(),
            efforts: fallback_efforts,
            default_model: String::new(),
        };
    };

    let mut models = Vec::new();
    let mut union: Vec<String> = Vec::new();
    for model in parsed.models {
        if model.slug.is_empty() {
            continue;
        }
        if matches!(model.visibility.as_deref(), Some("hidden") | Some("none")) {
            continue;
        }
        let mut efforts = Vec::new();
        for level in &model.supported_reasoning_levels {
            if level.effort.is_empty() || efforts.contains(&level.effort) {
                continue;
            }
            efforts.push(level.effort.clone());
            if !union.contains(&level.effort) {
                union.push(level.effort.clone());
            }
        }
        models.push(AgentModelInfo {
            id: model.slug.clone(),
            label: if model.display_name.is_empty() {
                model.slug
            } else {
                model.display_name
            },
            efforts,
            default_effort: model.default_reasoning_level,
        });
        if models.len() >= 30 {
            break;
        }
    }

    // A stable, intuitive order: cheap to expensive, unknown levels last.
    let order = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
    union.sort_by_key(|level| {
        order
            .iter()
            .position(|known| *known == level.as_str())
            .unwrap_or(order.len())
    });
    if union.is_empty() {
        union = fallback_efforts;
    }
    AgentCatalog {
        provider: "codex".into(),
        models,
        efforts: union,
        default_model: String::new(),
    }
}

pub fn catalog(provider: &str, force: bool) -> AgentCatalog {
    let mut cache = CATALOGS.lock();
    let map = cache.get_or_insert_with(HashMap::new);
    if !force {
        if let Some((at, value)) = map.get(provider) {
            if at.elapsed() < CATALOG_TTL {
                return value.clone();
            }
        }
    }
    let catalog = match provider {
        "claude" => claude_catalog(),
        "codex" => codex_catalog(),
        _ => AgentCatalog {
            provider: provider.to_string(),
            models: Vec::new(),
            efforts: Vec::new(),
            default_model: String::new(),
        },
    };
    map.insert(provider.to_string(), (Instant::now(), catalog.clone()));
    catalog
}
