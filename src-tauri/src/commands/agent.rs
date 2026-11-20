//! Agent turn execution and chat persistence commands.
//!
//! One chat runs at most one turn. The child process is owned here (like PTYs), so closing the
//! window, quitting, disabling the feature or pressing Stop always reaps it.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent::{self, providers, store, AgentEvent, AgentEventPayload, AgentTurnRequest};
use crate::error::{AppError, AppResult};
use crate::state::{assert_inside, resolve_in_root, AppState};

#[derive(Clone)]
struct TurnEvents {
    app: AppHandle,
    chat_id: String,
    run_id: String,
    sequence: Arc<parking_lot::Mutex<u64>>,
}

impl TurnEvents {
    fn emit(&self, event: AgentEvent) {
        let mut sequence = self.sequence.lock();
        *sequence += 1;
        let _ = self.app.emit(
            "agent:event",
            AgentEventPayload {
                chat_id: self.chat_id.clone(),
                run_id: self.run_id.clone(),
                sequence: *sequence,
                event,
            },
        );
    }
}

/// Four concurrent CLIs is already a lot of CPU/network; more is a foot-gun, not a feature.
const MAX_TURNS: usize = 4;

pub struct AgentTurn {
    /// Owning window: a destroyed window must not leave an agent writing into the project
    pub owner: String,
    run_id: String,
    pid: Option<u32>,
    pub cancelled: Arc<AtomicBool>,
}

impl AgentTurn {
    pub fn kill(&self) {
        let Some(pid) = self.pid else {
            return;
        };
        #[cfg(unix)]
        unsafe {
            // The CLI is the session leader (setsid), so its process group id is its pid.
            // A wrapper such as a node shim starts children that must go too.
            let pgid = -(pid as i32);
            libc::kill(pgid, libc::SIGHUP);
            libc::kill(pgid, libc::SIGTERM);
            libc::kill(pgid, libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            let _ = crate::proc::command("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

fn release_turn(app: &AppHandle, chat_id: &str, run_id: &str) {
    let state = app.state::<AppState>();
    let mut turns = state.agent_turns.lock();
    if turns.get(chat_id).is_some_and(|turn| turn.run_id == run_id) {
        turns.remove(chat_id);
    }
}

pub fn kill_turns(turns: &mut HashMap<String, Arc<AgentTurn>>, owner: Option<&str>) {
    let ids: Vec<String> = turns
        .iter()
        .filter(|(_, turn)| owner.map_or(true, |owner| turn.owner.as_str() == owner))
        .map(|(id, _)| id.clone())
        .collect();
    let killed: Vec<Arc<AgentTurn>> = ids.iter().filter_map(|id| turns.remove(id)).collect();
    for turn in killed {
        turn.cancelled.store(true, Ordering::Relaxed);
        turn.kill();
    }
}

#[tauri::command(async)]
pub fn agent_providers(force: bool) -> Vec<providers::AgentProviderInfo> {
    providers::scan(force)
}

#[tauri::command(async)]
pub fn agent_models(provider: String, force: bool) -> providers::AgentCatalog {
    providers::catalog(&provider, force)
}

/// Read-only skill discovery for the composer's `$` picker. The root is authorized like every
/// other project path; the scan itself only reads the known skill directories.
#[tauri::command(async)]
pub fn agent_skills(
    state: State<'_, AppState>,
    root: String,
) -> AppResult<Vec<agent::skills::SkillInfo>> {
    let root = state.authorize(&root)?;
    Ok(agent::skills::scan(&root))
}

#[tauri::command(async)]
pub fn agent_send(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    request: AgentTurnRequest,
) -> AppResult<()> {
    let settings = crate::commands::theme::read_settings(&app);
    if !settings.agent_enabled {
        return Err(AppError::c("agent.disabled"));
    }
    if !store::valid_id(&request.chat_id) || !store::valid_id(&request.run_id) {
        return Err(AppError::c("agent.invalidId"));
    }
    if request.prompt.trim().is_empty() {
        return Err(AppError::c("agent.emptyPrompt"));
    }
    // The workspace allow-list is the permission boundary: never spawn outside a granted root.
    let root = state.authorize(&request.root)?;

    let info = providers::scan(false)
        .into_iter()
        .find(|provider| provider.id == request.provider)
        .ok_or_else(|| AppError::c("agent.notInstalled"))?;
    if !info.supported {
        return Err(AppError::c("agent.unsupported"));
    }
    let Some(command) = info.command.clone() else {
        return Err(AppError::c("agent.notInstalled"));
    };

    if matches!(
        request.session_action,
        agent::AgentSessionAction::Resume | agent::AgentSessionAction::Fork
    ) && request
        .session_id
        .as_deref()
        .is_none_or(|id| id.trim().is_empty())
    {
        return Err(AppError::c("agent.invalidId"));
    }
    if matches!(request.session_action, agent::AgentSessionAction::Fork)
        && !providers::supports_fork(Path::new(&command), &request.provider)
    {
        return Err(AppError::c("agent.unsupported"));
    }
    let launch = match request.provider.as_str() {
        "claude" => agent::claude::launch(Path::new(&command), &request, &root),
        "codex" => agent::codex::launch(Path::new(&command), &request, &root),
        _ => return Err(AppError::c("agent.unsupported")),
    };

    let mut turns = state.agent_turns.lock();
    if turns.contains_key(&request.chat_id) {
        return Err(AppError::c("agent.busy"));
    }
    if turns.len() >= MAX_TURNS {
        return Err(AppError::c("agent.tooManyTurns"));
    }

    let prompt = agent::build_prompt(&request.prompt, &request.mentions);
    // Codex has no system-prompt flag: the workspace boundary travels with the prompt.
    let prompt = if request.provider == "codex" {
        format!("{}\n\n{prompt}", agent::workspace_note(&root))
    } else {
        prompt
    };

    let mut cmd = providers::build_command(&launch.program, &launch.args);
    cmd.current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Started from inside Claude Code (e.g. Tide opened from a terminal in it), the CLI
        // would otherwise think it is nested.
        .env_remove("CLAUDECODE");
    if let Some(path) = providers::augmented_path() {
        cmd.env("PATH", path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::p("agent.spawnFailed", [("error", e.to_string())]))?;
    let pid = Some(child.id());
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::p("agent.spawnFailed", [("error", "stdio".into())]))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::p("agent.spawnFailed", [("error", "stdio".into())]))?;
    let stderr = child.stderr.take();

    let cancelled = Arc::new(AtomicBool::new(false));
    turns.insert(
        request.chat_id.clone(),
        Arc::new(AgentTurn {
            owner: window.label().to_string(),
            run_id: request.run_id.clone(),
            pid,
            cancelled: cancelled.clone(),
        }),
    );
    drop(turns);

    // The prompt goes over stdin: no argv limit, and nothing visible in the process list.
    let _ = stdin.write_all(prompt.as_bytes());
    let _ = stdin.flush();
    drop(stdin);

    let chat_id = request.chat_id.clone();
    let provider_id = request.provider.clone();
    let claude_model = request.model.clone();

    let events = TurnEvents {
        app: app.clone(),
        chat_id: chat_id.clone(),
        run_id: request.run_id.clone(),
        sequence: Arc::new(parking_lot::Mutex::new(0)),
    };
    if let Some(stderr) = stderr {
        let events = events.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            let mut emitted = 0usize;
            // Keep draining even after the cap, otherwise a chatty CLI blocks on a full pipe.
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() || emitted >= 200 {
                    continue;
                }
                emitted += 1;
                events.emit(AgentEvent::Stderr { text: line });
            }
        });
    }

    let (tx, rx) = sync_channel::<AgentEvent>(256);
    let cancel_flag = cancelled.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let mut claude_state = agent::claude::State::with_model(claude_model);
        let mut codex_state = agent::codex::State::default();
        'read: loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let text = line.trim_end();
                    if text.is_empty() {
                        continue;
                    }
                    let events = if provider_id == "claude" {
                        agent::claude::translate(text, &mut claude_state)
                    } else {
                        agent::codex::translate(text, &mut codex_state)
                    };
                    for event in events {
                        if tx.send(event).is_err() {
                            break 'read;
                        }
                    }
                }
                Err(_) => break,
            }
        }
        let events = if provider_id == "claude" {
            agent::claude::flush(&mut claude_state)
        } else {
            agent::codex::flush(&mut codex_state)
        };
        for event in events {
            if tx.send(event).is_err() {
                break;
            }
        }
        let status = child.wait();
        let ok = status
            .as_ref()
            .map(|status| status.success())
            .unwrap_or(false);
        let cancelled = cancel_flag.load(Ordering::Relaxed);
        let code = if ok {
            None
        } else {
            status.ok().and_then(|status| status.code())
        };
        let _ = tx.send(AgentEvent::Done {
            ok: ok && !cancelled,
            cancelled,
            code,
        });
    });

    let app_for_events = app.clone();
    std::thread::spawn(move || {
        // Coalesce token deltas: one IPC per 24ms instead of one per token.
        let mut pending: Option<(String, String)> = None;
        let mut saw_done = false;
        let emit_pending = |pending: &mut Option<(String, String)>| {
            if let Some((item_id, text)) = pending.take() {
                if !text.is_empty() {
                    events.emit(AgentEvent::TextDelta { item_id, text });
                }
            }
        };
        loop {
            match rx.recv_timeout(Duration::from_millis(24)) {
                Ok(AgentEvent::TextDelta { item_id, text }) => {
                    if matches!(&pending, Some((id, _)) if id == &item_id) {
                        let mut flush_now = false;
                        if let Some((_, buffer)) = pending.as_mut() {
                            buffer.push_str(&text);
                            // A model that never pauses must not grow the pending string forever
                            flush_now = buffer.len() >= 8 * 1024;
                        }
                        if flush_now {
                            emit_pending(&mut pending);
                        }
                    } else {
                        emit_pending(&mut pending);
                        pending = Some((item_id, text));
                    }
                }
                Ok(event) => {
                    emit_pending(&mut pending);
                    // Free the chat before the frontend sees Done: a retry (or the next message)
                    // must not race the cleanup and be rejected as "busy".
                    if matches!(&event, AgentEvent::Done { .. }) {
                        saw_done = true;
                        release_turn(&app_for_events, &chat_id, &events.run_id);
                    }
                    events.emit(event);
                }
                Err(RecvTimeoutError::Timeout) => emit_pending(&mut pending),
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        emit_pending(&mut pending);
        // A parser panic drops the sender without a Done: never leave the chat spinning forever
        if !saw_done {
            release_turn(&app_for_events, &chat_id, &events.run_id);
            events.emit(AgentEvent::Done {
                ok: false,
                cancelled: false,
                code: None,
            });
        }
        // Done already released this turn before notifying the view. Never remove a newer turn.
    });

    Ok(())
}

#[tauri::command]
pub fn agent_cancel(state: State<'_, AppState>, chat_id: String) -> AppResult<()> {
    let turn = state.agent_turns.lock().get(&chat_id).cloned();
    if let Some(turn) = turn {
        turn.cancelled.store(true, Ordering::Relaxed);
        turn.kill();
    }
    Ok(())
}

#[tauri::command(async)]
pub fn agent_chat_open(
    app: AppHandle,
    id: String,
    recent_limit: usize,
) -> AppResult<Option<store::AgentChatPage>> {
    store::open_chat(&app, &id, recent_limit)
}

#[tauri::command(async)]
pub fn agent_chat_page(
    app: AppHandle,
    id: String,
    before_id: Option<String>,
    after_id: Option<String>,
    limit: usize,
) -> AppResult<Option<store::AgentChatPage>> {
    store::page_chat(&app, &id, before_id.as_deref(), after_id.as_deref(), limit)
}

#[tauri::command(async)]
pub fn agent_chat_apply(
    app: AppHandle,
    id: String,
    patch: store::AgentChatPatch,
) -> AppResult<store::AgentChatPage> {
    store::apply_chat(&app, &id, patch)
}

#[tauri::command(async)]
pub fn agent_chat_list(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
) -> AppResult<Vec<store::AgentChatSummary>> {
    let root = state.authorize(&root)?;
    store::list_chats(&app, &root.to_string_lossy())
}

#[tauri::command(async)]
pub fn agent_chat_clone(
    app: AppHandle,
    state: State<'_, AppState>,
    from_id: String,
    header: store::AgentChatRecord,
) -> AppResult<store::AgentChatPage> {
    if let Some(root) = header.get("root").and_then(serde_json::Value::as_str) {
        state.authorize(root)?;
    }
    store::clone_chat(&app, &from_id, header)
}

#[tauri::command(async)]
pub fn agent_chat_delete(app: AppHandle, id: String) -> AppResult<()> {
    store::delete_chat(&app, &id)
}

#[tauri::command(async)]
pub fn agent_tabs_save(
    app: AppHandle,
    tabs: Vec<store::AgentTabRef>,
    active: Option<String>,
) -> AppResult<()> {
    store::save_tabs(&app, &store::AgentTabs { tabs, active })
}

#[tauri::command(async)]
pub fn agent_tabs_load(app: AppHandle) -> store::AgentTabs {
    store::load_tabs(&app)
}

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenEstimate {
    pub total: usize,
    pub breakdown: Vec<TokenBreakdown>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBreakdown {
    pub kind: String,
    pub label: String,
    pub tokens: usize,
}

#[tauri::command(async)]
pub fn agent_estimate_tokens(
    state: State<'_, AppState>,
    root: String,
    mentions: Vec<agent::AgentMention>,
    prompt: String,
) -> AppResult<TokenEstimate> {
    let root_path = state.authorize(&root)?;
    let mut breakdown = Vec::new();

    // A rough byte-based estimate, never a claim about the provider's actual usage.
    let prompt_tokens = prompt.len().div_ceil(4);
    breakdown.push(TokenBreakdown {
        kind: "prompt".to_string(),
        label: String::new(),
        tokens: prompt_tokens,
    });

    for mention in mentions {
        let path = resolve_in_root(&root_path, &mention.rel)?;
        assert_inside(&root_path, &path)?;
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        // Stat only: estimating must not load large files into memory.
        let tokens = (meta.len().min(usize::MAX as u64 / 2) as usize).div_ceil(3) + 20;
        breakdown.push(TokenBreakdown {
            kind: "file".to_string(),
            label: mention.rel,
            tokens,
        });
    }

    let total = breakdown
        .iter()
        .fold(0usize, |total, item| total.saturating_add(item.tokens));
    Ok(TokenEstimate { total, breakdown })
}
