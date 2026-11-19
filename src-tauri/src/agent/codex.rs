//! Codex over `codex exec --json` (JSONL events), one process per user turn.
//!
//! A follow-up resumes the thread id the first turn printed. Sandbox and approval policy are
//! config overrides, which both `exec` and `exec resume` accept.

use std::collections::HashSet;
use std::path::Path;

use serde_json::Value;

use super::question::{self, Piece};
use super::{AgentEvent, AgentTurnRequest, AgentUsage, Launch};

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
    args.push(if request.read_only {
        "sandbox_mode=\"read-only\"".into()
    } else {
        "sandbox_mode=\"workspace-write\"".into()
    });
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
    questions: question::Parser,
    seq: u64,
    /// Current text item. A question closes it so trailing text starts a new item.
    text_id: Option<String>,
}

fn piece_events(pieces: Vec<Piece>, base_id: &str, state: &mut State) -> Vec<AgentEvent> {
    let mut out = Vec::new();
    let mut text_id = state
        .text_id
        .clone()
        .or_else(|| Some(base_id.to_string()));
    for piece in pieces {
        match piece {
            Piece::Text(text) if !text.is_empty() => {
                if text_id.is_none() {
                    state.seq += 1;
                    text_id = Some(format!("{base_id}-text-{}", state.seq));
                }
                out.push(AgentEvent::TextDelta {
                    item_id: text_id.clone().expect("text id set above"),
                    text,
                });
            }
            Piece::Question(question) => {
                state.seq += 1;
                out.push(AgentEvent::Question {
                    item_id: format!("question-{}", state.seq),
                    header: question.header,
                    question: question.question,
                    multi_select: question.multi_select,
                    options: question.options,
                });
                text_id = None;
            }
            Piece::Invalid(text) => {
                if !text.is_empty() {
                    if text_id.is_none() {
                        state.seq += 1;
                        text_id = Some(format!("{base_id}-text-{}", state.seq));
                    }
                    out.push(AgentEvent::TextDelta {
                        item_id: text_id.clone().expect("text id set above"),
                        text: text.clone(),
                    });
                    out.push(AgentEvent::QuestionInvalid { text });
                }
            }
            Piece::Text(_) => {}
        }
    }
    state.text_id = text_id;
    out
}

pub fn flush(state: &mut State) -> Vec<AgentEvent> {
    let pieces = state.questions.flush();
    let item_id = state
        .text_id
        .clone()
        .unwrap_or_else(|| format!("text-flush-{}", state.seq + 1));
    piece_events(pieces, &item_id, state)
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

fn token(value: &Value, aliases: &[&str]) -> Option<u64> {
    aliases.iter().find_map(|key| {
        let value = value.get(*key)?;
        value
            .as_u64()
            .or_else(|| value.as_i64().filter(|number| *number >= 0).map(|number| number as u64))
    })
}

fn has_usage_fields(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.keys().any(|key| {
        matches!(
            key.as_str(),
            "input_tokens"
                | "inputTokens"
                | "prompt_tokens"
                | "promptTokens"
                | "cached_input_tokens"
                | "cachedInputTokens"
                | "cache_read_input_tokens"
                | "cacheReadInputTokens"
                | "cache_write_input_tokens"
                | "cacheWriteInputTokens"
                | "cache_creation_input_tokens"
                | "cacheCreationInputTokens"
                | "output_tokens"
                | "outputTokens"
                | "completion_tokens"
                | "completionTokens"
                | "reasoning_output_tokens"
                | "reasoningOutputTokens"
                | "reasoning_tokens"
                | "total_tokens"
                | "totalTokens"
        )
    })
}

/// Find the usage object in the shapes emitted by `codex exec` and newer token-count events.
fn usage_value(value: &Value) -> Option<&Value> {
    if has_usage_fields(value) {
        return Some(value);
    }
    for key in ["usage", "total_token_usage", "payload", "info"] {
        if let Some(nested) = value.get(key) {
            if let Some(found) = usage_value(nested) {
                return Some(found);
            }
        }
    }
    None
}

fn usage_from_event(value: &Value) -> Option<AgentUsage> {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
    let candidate = if kind == "turn.completed" || kind == "token_count" || has_usage_fields(value) {
        usage_value(value)
    } else {
        None
    }?;
    let input_tokens = token(candidate, &["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"])
        .unwrap_or(0);
    let cached_input_tokens = token(
        candidate,
        &[
            "cached_input_tokens",
            "cachedInputTokens",
            "cache_read_input_tokens",
            "cacheReadInputTokens",
        ],
    )
    .unwrap_or(0);
    let cache_write_input_tokens = token(
        candidate,
        &[
            "cache_write_input_tokens",
            "cacheWriteInputTokens",
            "cache_creation_input_tokens",
            "cacheCreationInputTokens",
        ],
    )
    .unwrap_or(0);
    let output_tokens = token(
        candidate,
        &["output_tokens", "outputTokens", "completion_tokens", "completionTokens"],
    )
    .unwrap_or(0);
    let reasoning_output_tokens = token(
        candidate,
        &[
            "reasoning_output_tokens",
            "reasoningOutputTokens",
            "reasoning_tokens",
        ],
    )
    .unwrap_or(0);
    let total_tokens = token(candidate, &["total_tokens", "totalTokens"]).unwrap_or_else(|| {
        // Codex reports cached input as part of `input_tokens`. Only add the excess when a
        // provider supplies cache-only counters, so fallback totals neither double-count nor
        // collapse to zero.
        input_tokens
            .saturating_add(output_tokens)
            .saturating_add(cache_write_input_tokens)
            .saturating_add(cached_input_tokens.saturating_sub(input_tokens))
    });
    Some(AgentUsage {
        input_tokens,
        cached_input_tokens,
        cache_write_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        total_tokens,
        // Codex JSONL does not report a price; never turn missing cost into a fabricated zero.
        cost_usd: None,
    })
}

pub fn translate(line: &str, state: &mut State) -> Vec<AgentEvent> {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return vec![AgentEvent::Stderr { text: line.to_string() }],
    };
    let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
    let mut out = Vec::new();

    if let Some(usage) = usage_from_event(&value) {
        out.push(AgentEvent::Usage { usage });
    }

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
                        state.text_id = Some(id.to_string());
                        let pieces = state.questions.push(text);
                        out.extend(piece_events(pieces, id, state));
                        out.extend(flush(state));
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
        "turn.completed" => {
            out.extend(flush(state));
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(read_only: bool) -> AgentTurnRequest {
        AgentTurnRequest {
            chat_id: "chat-1".into(),
            root: "/tmp".into(),
            provider: "codex".into(),
            session_id: None,
            model: None,
            effort: None,
            prompt: "hi".into(),
            mentions: Vec::new(),
            read_only,
        }
    }

    fn question_marker() -> String {
        format!(
            "{}{}{}",
            question::QUESTION_START,
            r#"{"header":"Decision","question":"Which option?","multiSelect":true,"options":[{"label":"A","description":"First"},{"label":"B","description":"Second"}]}"#,
            question::QUESTION_END
        )
    }

    #[test]
    fn read_only_uses_codex_read_only_sandbox() {
        let launch = launch(Path::new("codex"), &request(true), Path::new("/tmp"));
        assert!(launch
            .args
            .iter()
            .any(|arg| arg == "sandbox_mode=\"read-only\""));
        assert!(!launch
            .args
            .iter()
            .any(|arg| arg == "sandbox_mode=\"workspace-write\""));
    }

    #[test]
    fn writable_turns_keep_codex_workspace_write_sandbox() {
        let launch = launch(Path::new("codex"), &request(false), Path::new("/tmp"));
        assert!(launch
            .args
            .iter()
            .any(|arg| arg == "sandbox_mode=\"workspace-write\""));
        assert!(!launch.args.iter().any(|arg| arg == "sandbox_mode=\"read-only\""));
    }

    #[test]
    fn completed_agent_message_emits_question_in_source_order() {
        let mut state = State::default();
        let text = format!("before\n{}\nafter", question_marker());
        let event = serde_json::to_string(&json!({
            "type": "item.completed",
            "item": { "id": "m1", "type": "agent_message", "text": text }
        }))
        .expect("agent message should serialize");
        let events = translate(&event, &mut state);
        assert!(matches!(&events[0], AgentEvent::TextDelta { text, .. } if text == "before\n"));
        let question_index = events
            .iter()
            .position(|event| matches!(event, AgentEvent::Question { multi_select: true, .. }))
            .expect("question event");
        assert!(events[question_index + 1..]
            .iter()
            .any(|event| matches!(event, AgentEvent::TextDelta { text, .. } if text == "\nafter")));
    }

    #[test]
    fn partial_marker_after_question_flushes_into_trailing_text_item() {
        let mut state = State::default();
        let text = format!("before{}after <TIDE_QU", question_marker());
        let event = serde_json::to_string(&json!({
            "type": "item.completed",
            "item": { "id": "m1", "type": "agent_message", "text": text }
        }))
        .expect("agent message should serialize");
        let events = translate(&event, &mut state);
        let question_index = events
            .iter()
            .position(|event| matches!(event, AgentEvent::Question { .. }))
            .expect("question event");
        let before_id = events[..question_index]
            .iter()
            .find_map(|event| match event {
                AgentEvent::TextDelta { item_id, .. } => Some(item_id),
                _ => None,
            })
            .expect("text before question");
        let trailing_id = events[question_index + 1..]
            .iter()
            .find_map(|event| match event {
                AgentEvent::TextDelta { item_id, .. } => Some(item_id),
                _ => None,
            })
            .expect("text after question");
        let last = events.last().expect("partial marker text");
        assert!(matches!(
            last,
            AgentEvent::TextDelta { item_id, text } if item_id == trailing_id && text == "<TIDE_QU"
        ));
        assert_ne!(before_id, trailing_id);
    }

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

    #[test]
    fn reads_turn_completed_usage() {
        let mut state = State::default();
        let events = translate(
            r#"{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":30,"output_tokens":40,"reasoning_output_tokens":10,"total_tokens":160}}"#,
            &mut state,
        );
        let usage = events
            .iter()
            .find_map(|event| match event {
                AgentEvent::Usage { usage } => Some(usage),
                _ => None,
            })
            .expect("turn completion should include usage");
        assert_eq!(usage.input_tokens, 120);
        assert_eq!(usage.cached_input_tokens, 30);
        assert_eq!(usage.output_tokens, 40);
        assert_eq!(usage.reasoning_output_tokens, 10);
        assert_eq!(usage.total_tokens, 160);
        assert_eq!(usage.cost_usd, None);
    }

    #[test]
    fn reads_cache_only_usage_fields() {
        let mut state = State::default();
        let events = translate(
            r#"{"type":"turn.completed","usage":{"cache_read_input_tokens":7,"cache_write_input_tokens":3}}"#,
            &mut state,
        );
        let usage = events
            .iter()
            .find_map(|event| match event {
                AgentEvent::Usage { usage } => Some(usage),
                _ => None,
            })
            .expect("cache fields should count as usage");
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.cached_input_tokens, 7);
        assert_eq!(usage.cache_write_input_tokens, 3);
        assert_eq!(usage.total_tokens, 10);
        assert_eq!(usage.cost_usd, None);
    }

    #[test]
    fn derives_usage_total_from_partial_token_count() {
        let mut state = State::default();
        let events = translate(
            r#"{"type":"token_count","payload":{"info":{"total_token_usage":{"input_tokens":8,"output_tokens":5}}}}"#,
            &mut state,
        );
        let usage = events
            .iter()
            .find_map(|event| match event {
                AgentEvent::Usage { usage } => Some(usage),
                _ => None,
            })
            .expect("token count should include usage");
        assert_eq!(usage.input_tokens, 8);
        assert_eq!(usage.output_tokens, 5);
        assert_eq!(usage.total_tokens, 13);
        assert_eq!(usage.cost_usd, None);
    }

    #[test]
    fn ignores_empty_turn_completed_usage() {
        let mut state = State::default();
        let events = translate(r#"{"type":"turn.completed","usage":{}}"#, &mut state);
        assert!(!events.iter().any(|event| matches!(event, AgentEvent::Usage { .. })));
    }

    #[test]
    fn normalizes_invalid_token_fields_to_zero() {
        let mut state = State::default();
        let events = translate(
            r#"{"type":"turn.completed","usage":{"input_tokens":-1,"output_tokens":"bad"}}"#,
            &mut state,
        );
        let usage = events
            .iter()
            .find_map(|event| match event {
                AgentEvent::Usage { usage } => Some(usage),
                _ => None,
            })
            .expect("turn completion should include usage");
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.output_tokens, 0);
        assert_eq!(usage.total_tokens, 0);
        assert_eq!(usage.cost_usd, None);
    }
}
