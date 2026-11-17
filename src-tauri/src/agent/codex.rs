//! Codex over `codex exec --json` (JSONL events), one process per user turn.
//!
//! A follow-up resumes the thread id the first turn printed. Sandbox and approval policy are
//! config overrides, which both `exec` and `exec resume` accept.

use std::collections::HashSet;
use std::path::Path;

use serde_json::Value;

use super::{AgentEvent, AgentTurnRequest, Launch};

pub fn launch(program: &Path, request: &AgentTurnRequest, root: &Path) -> Launch {
    let resume = request.session_id.as_deref().filter(|id| !id.is_empty());
    let mut args: Vec<String> = vec!["exec".into()];
    if let Some(thread) = resume {
        args.push("resume".into());
        args.push(thread.to_string());
    }
    args.push("--json".into());
    // Accepted by both `exec` and `exec resume`; a workspace does not have to be a git repo
    args.push("--skip-git-repo-check".into());
    if resume.is_none() {
        // `exec resume` takes the cwd from the process and does not accept -C
        args.push("-C".into());
        args.push(root.to_string_lossy().to_string());
    }
    if let Some(model) = request.model.as_deref().filter(|m| !m.is_empty()) {
        args.push("-m".into());
        args.push(model.to_string());
    }
    if let Some(effort) = request.effort.as_deref().filter(|e| !e.is_empty()) {
        args.push("-c".into());
        args.push(format!("model_reasoning_effort=\"{effort}\""));
    }
    args.push("-c".into());
    args.push("sandbox_mode=\"workspace-write\"".into());
    args.push("-c".into());
    args.push("approval_policy=\"never\"".into());
    // Prompt over stdin: no argv length limit, and it does not show up in `ps`
    args.push("-".into());
    Launch {
        program: program.to_path_buf(),
        args,
    }
}

#[derive(Default)]
pub struct State {
    seen: HashSet<String>,
}

fn clip(value: &str) -> String {
    const MAX: usize = 64 * 1024;
    if value.len() <= MAX {
        return value.to_string();
    }
    let mut end = MAX;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

fn item_title(item: &Value) -> String {
    match item.get("type").and_then(Value::as_str).unwrap_or_default() {
        "command_execution" => item
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("command")
            .to_string(),
        "file_change" => {
            let paths: Vec<&str> = item
                .get("changes")
                .and_then(Value::as_array)
                .map(|changes| {
                    changes
                        .iter()
                        .filter_map(|change| change.get("path").and_then(Value::as_str))
                        .collect()
                })
                .unwrap_or_default();
            match paths.as_slice() {
                [] => "file change".to_string(),
                [only] => (*only).to_string(),
                [first, ..] => format!("{first} +{}", paths.len() - 1),
            }
        }
        "mcp_tool_call" => {
            let server = item.get("server").and_then(Value::as_str).unwrap_or_default();
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or("tool");
            if server.is_empty() {
                tool.to_string()
            } else {
                format!("{server}/{tool}")
            }
        }
        "web_search" => item
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("web search")
            .to_string(),
        other => other.to_string(),
    }
}

fn item_detail(item: &Value) -> Option<String> {
    match item.get("type").and_then(Value::as_str).unwrap_or_default() {
        "command_execution" => item
            .get("command")
            .and_then(Value::as_str)
            .map(|command| clip(command)),
        "file_change" => item.get("changes").map(|changes| clip(&changes.to_string())),
        "mcp_tool_call" => item
            .get("arguments")
            .map(|arguments| clip(&arguments.to_string())),
        _ => None,
    }
}

pub fn translate(line: &str, state: &mut State) -> Vec<AgentEvent> {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return vec![AgentEvent::Stderr { text: line.to_string() }],
    };
    let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
    let mut out = Vec::new();

    match kind {
        "thread.started" => {
            if let Some(thread) = value.get("thread_id").and_then(Value::as_str) {
                out.push(AgentEvent::Session {
                    session_id: thread.to_string(),
                });
            }
        }
        "item.started" | "item.updated" | "item.completed" => {
            let Some(item) = value.get("item") else {
                return out;
            };
            let id = item.get("id").and_then(Value::as_str).unwrap_or_default();
            if id.is_empty() {
                return out;
            }
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
            match item_type {
                "agent_message" if kind == "item.completed" => {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        out.push(AgentEvent::TextDelta {
                            item_id: id.to_string(),
                            text: text.to_string(),
                        });
                    }
                }
                "reasoning" if kind == "item.completed" => {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        out.push(AgentEvent::Thinking {
                            item_id: id.to_string(),
                            text: text.to_string(),
                        });
                    }
                }
                "command_execution" | "file_change" | "mcp_tool_call" | "web_search" => {
                    if kind == "item.started" {
                        if state.seen.insert(id.to_string()) {
                            out.push(AgentEvent::ToolStart {
                                item_id: id.to_string(),
                                title: item_title(item),
                            });
                            if let Some(detail) = item_detail(item) {
                                out.push(AgentEvent::ToolDetail {
                                    item_id: id.to_string(),
                                    detail,
                                });
                            }
                        }
                    } else if kind == "item.completed" {
                        if state.seen.insert(id.to_string()) {
                            out.push(AgentEvent::ToolStart {
                                item_id: id.to_string(),
                                title: item_title(item),
                            });
                        }
                        let status = item.get("status").and_then(Value::as_str).unwrap_or("completed");
                        let exit = item.get("exit_code").and_then(Value::as_i64);
                        let ok = status == "completed" && exit.unwrap_or(0) == 0;
                        let output = item
                            .get("aggregated_output")
                            .and_then(Value::as_str)
                            .or_else(|| item.get("error").and_then(Value::as_str))
                            .map(clip);
                        out.push(AgentEvent::ToolEnd {
                            item_id: id.to_string(),
                            ok,
                            output,
                        });
                    }
                }
                "error" => {
                    if let Some(message) = item.get("message").and_then(Value::as_str) {
                        out.push(AgentEvent::Notice {
                            text: clip(message),
                        });
                    }
                }
                _ => {}
            }
        }
        "turn.failed" => {
            let message = value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Codex reported a failed turn.");
            out.push(AgentEvent::Notice {
                text: clip(message),
            });
        }
        "error" => {
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Codex reported an error.");
            out.push(AgentEvent::Notice {
                text: clip(message),
            });
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_thread_and_agent_message() {
        let mut state = State::default();
        let started = translate(r#"{"type":"thread.started","thread_id":"t-1"}"#, &mut state);
        assert!(matches!(&started[0], AgentEvent::Session { .. }));
        let done = translate(
            r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"hello"}}"#,
            &mut state,
        );
        match &done[0] {
            AgentEvent::TextDelta { text, .. } => assert_eq!(text, "hello"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn command_finishes_with_exit_code() {
        let mut state = State::default();
        let started = translate(
            r#"{"type":"item.started","item":{"id":"c1","type":"command_execution","command":"ls","status":"in_progress"}}"#,
            &mut state,
        );
        assert!(matches!(&started[0], AgentEvent::ToolStart { title, .. } if title == "ls"));
        let done = translate(
            r#"{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"ls","aggregated_output":"a.rs","exit_code":0,"status":"completed"}}"#,
            &mut state,
        );
        assert!(done.iter().any(|e| matches!(e, AgentEvent::ToolEnd { ok: true, .. })));
    }

    #[test]
    fn non_json_lines_become_stderr() {
        let mut state = State::default();
        let events = translate("not json", &mut state);
        assert!(matches!(&events[0], AgentEvent::Stderr { .. }));
    }
}
