//! Codex app-server notifications. Legacy JSONL fixtures remain readable for compatibility tests.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::Value;

use super::question::{self, Piece};
use super::{AgentEvent, AgentTurnRequest, AgentUsage, Launch};

pub fn launch(program: &Path, request: &AgentTurnRequest, _root: &Path) -> Launch {
    let mode = match request.permission() {
        super::AgentPermissionMode::ReadOnly => "read-only",
        super::AgentPermissionMode::WorkspaceWrite => "workspace-write",
        super::AgentPermissionMode::FullAccess => "danger-full-access",
    };
    Launch { program: program.to_path_buf(), args: vec!["app-server".into(), "--listen".into(), "stdio://".into(),
        "-c".into(), format!("sandbox_mode=\"{mode}\"")] }
}

#[derive(Default)]
pub struct State {
    seen: HashSet<String>,
    raw_text: HashMap<String, String>,
    output_bytes: HashMap<String, usize>,
    completed: HashSet<String>,
    questions: question::Parser,
    seq: u64,
    /// Last window reported by `token_count`; later usage-only events keep it for this turn.
    context_window: Option<u64>,
    /// Latest `last_token_usage.total_tokens`; unlike cumulative usage it measures context pressure.
    context_tokens: Option<u64>,
    /// Latest cumulative usage reported by `total_token_usage`.
    session_usage: Option<AgentUsage>,
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
    format!("{}\n… [output truncated at 64 KiB]", &value[..end])
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

/// Codex token-count events carry both turn and session counters. Find one by its exact key so
/// `total_token_usage` is never mistaken for `last_token_usage` (or vice versa).
fn named_usage<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    if let Some(found) = value.get(key).filter(|found| has_usage_fields(found)) {
        return Some(found);
    }
    ["payload", "info"]
        .into_iter()
        .find_map(|container| value.get(container).and_then(|nested| named_usage(nested, key)))
}

fn is_token_count_event(value: &Value) -> bool {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
    let payload_kind = value
        .pointer("/payload/type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    kind == "token_count" || payload_kind == "token_count"
}

fn find_context_window(value: &Value) -> Option<&Value> {
    if let Some(window) = value.get("model_context_window") {
        return Some(window);
    }
    ["payload", "info"]
        .into_iter()
        .find_map(|key| value.get(key).and_then(find_context_window))
}

/// `None` means this event did not report a window; `Some(None)` is an explicit invalid value.
fn context_window(value: &Value) -> Option<Option<u64>> {
    if !is_token_count_event(value) {
        return None;
    }
    let window = find_context_window(value)?;
    Some(window.as_u64().filter(|window| *window > 0))
}

fn usage_from_tokens(
    candidate: &Value,
    context_tokens: Option<u64>,
    context_window: Option<u64>,
) -> AgentUsage {
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
    AgentUsage {
        input_tokens,
        cached_input_tokens,
        cache_write_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        total_tokens,
        // Codex JSONL does not report a price; never turn missing cost into a fabricated zero.
        cost_usd: None,
        context_tokens,
        context_window,
    }
}

fn usage_from_event(value: &Value, state: &mut State) -> Option<(AgentUsage, Option<AgentUsage>)> {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
    if is_token_count_event(value) {
        let last = named_usage(value, "last_token_usage");
        let total = named_usage(value, "total_token_usage");
        if let Some(context_tokens) = last
            .and_then(|usage| token(usage, &["total_tokens", "totalTokens"]))
            .filter(|tokens| *tokens > 0)
        {
            state.context_tokens = Some(context_tokens);
        }
        if let Some(total) = total {
            state.session_usage = Some(usage_from_tokens(
                total,
                None,
                state.context_window,
            ));
        }
        let candidate = last.or(total).or_else(|| usage_value(value))?;
        return Some((
            usage_from_tokens(candidate, state.context_tokens, state.context_window),
            state.session_usage.clone(),
        ));
    }
    let candidate = if kind == "turn.completed"
        || has_usage_fields(value)
    {
        usage_value(value)
    } else {
        None
    }?;
    Some((
        usage_from_tokens(candidate, state.context_tokens, state.context_window),
        state.session_usage.clone(),
    ))
}

pub fn translate(line: &str, state: &mut State) -> Vec<AgentEvent> {
    if let Ok(value) = serde_json::from_str::<Value>(line) {
        if value.get("method").is_some() || value.get("id").is_some() {
            return translate_server(&value, state);
        }
    }
    translate_legacy(line, state)
}

fn translate_legacy(line: &str, state: &mut State) -> Vec<AgentEvent> {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return vec![AgentEvent::Stderr { text: line.to_string() }],
    };
    let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
    let mut out = Vec::new();

    if let Some(window) = context_window(&value) {
        state.context_window = window;
    }
    if let Some((usage, session_usage)) = usage_from_event(&value, state) {
        out.push(AgentEvent::Usage {
            usage,
            session_usage,
        });
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

/// Public text/reasoning and command output are consumed as deltas; completed snapshots replace them.
fn translate_server(value: &Value, state: &mut State) -> Vec<AgentEvent> {
    let method = value["method"].as_str().unwrap_or_default();
    let p = &value["params"];
    let id = p["itemId"].as_str().unwrap_or_default();
    let delta = p["delta"].as_str().unwrap_or_default();
    let mut out = Vec::new();
    match method {
        "item/agentMessage/delta" => {
            if state.completed.contains(id) { return out; }
            if !state.raw_text.contains_key(id) {
                out.extend(flush(state));
                state.text_id = Some(id.into());
            }
            state.raw_text.entry(id.into()).or_default().push_str(delta);
            let pieces = state.questions.push(delta);
            out.extend(piece_events(pieces, id, state));
        }
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
            if state.completed.contains(id) { return out; }
            out.extend(flush(state));
            let summary = method.contains("summary");
            let index = p[if summary { "summaryIndex" } else { "contentIndex" }].as_u64().unwrap_or(0);
            let key = format!("{id}-{}-{index}", if summary { "summary" } else { "content" });
            state.raw_text.entry(key.clone()).or_default().push_str(delta);
            out.push(AgentEvent::Thinking { item_id: key, text: delta.into() });
        }
        "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
            if state.completed.contains(id) { return out; }
            out.extend(flush(state));
            let bytes = state.output_bytes.entry(id.into()).or_default();
            if *bytes < 64 * 1024 {
                let mut end = delta.len().min(64 * 1024 - *bytes);
                while !delta.is_char_boundary(end) { end -= 1; }
                *bytes += end;
                let text = if end < delta.len() { *bytes = 64 * 1024; format!("{}\n… [output truncated at 64 KiB]", &delta[..end]) } else { delta.into() };
                out.push(AgentEvent::ToolOutputDelta { item_id: id.into(), text });
            }
        }
        "item/started" | "item/completed" => {
            let item = &p["item"];
            let id = item["id"].as_str().unwrap_or_default();
            let kind = item["type"].as_str().unwrap_or_default();
            let completed = method == "item/completed";
            if id.is_empty() || state.completed.contains(id) { return out; }
            if !matches!(kind, "agentMessage" | "plan") { out.extend(flush(state)); }
            match kind {
                "agentMessage" | "plan" => {
                    if completed {
                        let text = item["text"].as_str().unwrap_or_default();
                        let previous = state.raw_text.remove(id).unwrap_or_default();
                        if previous.is_empty() { state.text_id = Some(id.into()); }
                        if let Some(suffix) = text.strip_prefix(&previous) {
                            let pieces = state.questions.push(suffix);
                            out.extend(piece_events(pieces, id, state));
                            out.extend(flush(state));
                        }
                        // Questions split a source item into multiple ordered UI items; don't restore markers.
                        let has_marker = text.contains(question::QUESTION_START) || previous.contains(question::QUESTION_START);
                        out.push(AgentEvent::ItemComplete { item_id: id.into(), text: (!has_marker).then(|| text.into()) });
                        state.text_id = None;
                    }
                }
                "reasoning" => {
                    if completed {
                        for field in ["summary", "content"] {
                            if let Some(parts) = item[field].as_array() {
                                for (index, part) in parts.iter().enumerate() {
                                    let key = format!("{id}-{field}-{index}");
                                    let text = part.as_str().unwrap_or_default();
                                    if !state.raw_text.contains_key(&key) { out.push(AgentEvent::Thinking { item_id: key.clone(), text: text.into() }); }
                                    out.push(AgentEvent::ItemComplete { item_id: key, text: Some(text.into()) });
                                }
                            }
                        }
                    }
                }
                "userMessage" => {}
                _ => {
                    let title = item["command"].as_str().or_else(|| item["path"].as_str())
                        .or_else(|| item["changes"][0]["path"].as_str()).or_else(|| item["tool"].as_str())
                        .or_else(|| item["query"].as_str()).unwrap_or(kind).to_string();
                    if state.seen.insert(id.into()) { out.push(AgentEvent::ToolStart { item_id: id.into(), title }); }
                    if let Some(input) = item.get("arguments").or_else(|| item.get("changes")) {
                        out.push(AgentEvent::ToolDetail { item_id: id.into(), detail: clip(&input.to_string()) });
                    }
                    if completed {
                        let output = item["aggregatedOutput"].as_str().map(clip).or_else(||
                            item.get("result").filter(|v| !v.is_null()).or_else(|| item.get("error").filter(|v| !v.is_null())).map(|v| clip(&v.to_string())));
                        let ok = !matches!(item["status"].as_str(), Some("failed" | "declined")) && item["exitCode"].as_i64().unwrap_or(0) == 0;
                        out.push(AgentEvent::ToolEnd { item_id: id.into(), ok, output });
                    }
                }
            }
            if completed { state.completed.insert(id.into()); }
        }
        "thread/tokenUsage/updated" => {
            let usage = &p["tokenUsage"];
            let window = usage["modelContextWindow"].as_u64().filter(|v| *v > 0);
            let context = usage["last"]["totalTokens"].as_u64();
            out.push(AgentEvent::Usage { usage: usage_from_tokens(&usage["last"], context, window),
                session_usage: Some(usage_from_tokens(&usage["total"], None, window)) });
        }
        "turn/completed" | "error" => {
            out.extend(flush(state));
            if let Some(error) = p["turn"]["error"]["message"].as_str().or_else(|| p["error"]["message"].as_str()) {
                out.push(AgentEvent::Notice { text: error.into() });
            }
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::AgentSessionAction;
    use serde_json::json;

    fn request(read_only: bool) -> AgentTurnRequest {
        AgentTurnRequest {
            run_id: "run-test".into(),
            chat_id: "chat-1".into(),
            root: "/tmp".into(),
            provider: "codex".into(),
            session_action: AgentSessionAction::New,
            session_id: None,
            model: None,
            effort: None,
            prompt: "hi".into(),
            mentions: Vec::new(), attachments: Vec::new(),
            read_only,
            permission_mode: super::super::AgentPermissionMode::WorkspaceWrite,
        }
    }

    fn session_request(action: AgentSessionAction, session_id: Option<&str>) -> AgentTurnRequest {
        let mut request = request(false);
        request.session_action = action;
        request.session_id = session_id.map(str::to_string);
        request
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
    fn app_server_deltas_precede_snapshots_without_duplicate_text() {
        let mut state = State::default();
        let delta = translate(r#"{"method":"item/agentMessage/delta","params":{"itemId":"a","delta":"你好🙂"}}"#, &mut state);
        assert!(matches!(&delta[0], AgentEvent::TextDelta { text, .. } if text == "你好🙂"));
        let snapshot = r#"{"method":"item/completed","params":{"item":{"id":"a","type":"agentMessage","text":"你好🙂!"}}}"#;
        let events = translate(snapshot, &mut state);
        assert!(events.iter().any(|e| matches!(e, AgentEvent::TextDelta { text, .. } if text == "!")));
        assert!(events.iter().any(|e| matches!(e, AgentEvent::ItemComplete { text: Some(text), .. } if text == "你好🙂!")));
        assert!(translate(snapshot, &mut state).is_empty());
    }

    #[test]
    fn app_server_streams_reasoning_and_command_output_and_calibrates_final_output() {
        let mut state = State::default();
        let events = translate(r#"{"method":"item/reasoning/summaryTextDelta","params":{"itemId":"r","summaryIndex":0,"delta":"Inspect"}}"#, &mut state);
        assert!(matches!(&events[0], AgentEvent::Thinking { text, .. } if text == "Inspect"));
        let events = translate(r#"{"method":"item/commandExecution/outputDelta","params":{"itemId":"cmd","delta":"first\n"}}"#, &mut state);
        assert!(matches!(&events[0], AgentEvent::ToolOutputDelta { text, .. } if text == "first\n"));
        let events = translate(r#"{"method":"item/completed","params":{"item":{"id":"cmd","type":"commandExecution","command":"pwd","status":"completed","exitCode":0,"aggregatedOutput":"first\nlast"}}}"#, &mut state);
        assert!(events.iter().any(|e| matches!(e, AgentEvent::ToolEnd { output: Some(text), ok: true, .. } if text == "first\nlast")));
    }

    #[test]
    fn app_server_usage_keeps_explicit_zero_context() {
        let mut state = State::default();
        let events = translate(r#"{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"last":{"totalTokens":0,"inputTokens":0},"total":{"totalTokens":100},"modelContextWindow":200000}}}"#, &mut state);
        assert!(matches!(&events[0], AgentEvent::Usage { usage, .. } if usage.context_tokens == Some(0) && usage.context_window == Some(200000)));
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
    fn new_session_starts_codex_exec() {
        let launch = launch(
            Path::new("codex"),
            &session_request(AgentSessionAction::New, Some("old-thread")),
            Path::new("/tmp"),
        );
        assert_eq!(&launch.args[..3], ["app-server", "--listen", "stdio://"]);
        assert!(!launch.args.iter().any(|arg| arg == "resume" || arg == "fork"));
    }

    #[test]
    fn resume_uses_codex_exec_resume_and_thread() {
        let launch = launch(
            Path::new("codex"),
            &session_request(AgentSessionAction::Resume, Some("thread-1")),
            Path::new("/tmp"),
        );
        assert_eq!(super::super::transport::thread_request(&session_request(AgentSessionAction::Resume, Some("thread-1")))["method"], "thread/resume");
        assert_eq!(launch.args[0], "app-server");
    }

    #[test]
    fn fork_uses_codex_exec_fork_and_thread() {
        let launch = launch(
            Path::new("codex"),
            &session_request(AgentSessionAction::Fork, Some("thread-1")),
            Path::new("/tmp"),
        );
        assert_eq!(super::super::transport::thread_request(&session_request(AgentSessionAction::Fork, Some("thread-1")))["method"], "thread/fork");
        assert_eq!(launch.args[0], "app-server");
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
                AgentEvent::Usage { usage, .. } => Some(usage),
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
                AgentEvent::Usage { usage, .. } => Some(usage),
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
                AgentEvent::Usage { usage, .. } => Some(usage),
                _ => None,
            })
            .expect("token count should include usage");
        assert_eq!(usage.input_tokens, 8);
        assert_eq!(usage.output_tokens, 5);
        assert_eq!(usage.total_tokens, 13);
        assert_eq!(usage.cost_usd, None);
        assert_eq!(usage.context_window, None);
    }

    #[test]
    fn reads_model_context_window_from_token_count() {
        let mut state = State::default();
        let events = translate(
            r#"{"type":"token_count","payload":{"info":{"total_token_usage":{"input_tokens":8,"output_tokens":5},"model_context_window":258400}}}"#,
            &mut state,
        );
        let usage = events
            .iter()
            .find_map(|event| match event {
                AgentEvent::Usage { usage, .. } => Some(usage),
                _ => None,
            })
            .expect("token count should include usage");
        assert_eq!(usage.context_window, Some(258_400));
    }

    #[test]
    fn reads_wrapped_token_count_context_window() {
        let mut state = State::default();
        let events = translate(
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":8},"model_context_window":258400}}}"#,
            &mut state,
        );
        let usage = events
            .iter()
            .find_map(|event| match event {
                AgentEvent::Usage { usage, .. } => Some(usage),
                _ => None,
            })
            .expect("wrapped token count should include usage");
        assert_eq!(usage.context_window, Some(258_400));
    }

    #[test]
    fn codex_uses_last_usage_for_context_and_total_usage_for_session() {
        let mut state = State::default();
        let events = translate(
            r#"{"type":"token_count","payload":{"info":{"last_token_usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15},"total_token_usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150},"model_context_window":200}}}"#,
            &mut state,
        );
        let (usage, session_usage) = events
            .iter()
            .find_map(|event| match event {
                AgentEvent::Usage {
                    usage,
                    session_usage,
                } => Some((usage, session_usage)),
                _ => None,
            })
            .expect("token count should include usage");
        assert_eq!(usage.total_tokens, 15);
        assert_eq!(usage.context_tokens, Some(15));
        assert_eq!(usage.context_window, Some(200));
        let session_usage = session_usage.as_ref().expect("provider session usage");
        assert_eq!(session_usage.total_tokens, 150);
        assert_eq!(session_usage.context_tokens, None);
    }

    #[test]
    fn codex_does_not_fall_back_to_total_usage_for_context() {
        let mut state = State::default();
        let events = translate(
            r#"{"type":"token_count","payload":{"info":{"total_token_usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150},"model_context_window":200}}}"#,
            &mut state,
        );
        let usage = events
            .iter()
            .find_map(|event| match event {
                AgentEvent::Usage { usage, .. } => Some(usage),
                _ => None,
            })
            .expect("token count should include usage");
        assert_eq!(usage.context_tokens, None);
        assert_eq!(usage.context_window, Some(200));
    }

    #[test]
    fn codex_zero_last_usage_is_unavailable_context() {
        let mut state = State::default();
        let events = translate(
            r#"{"type":"token_count","payload":{"info":{"last_token_usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0},"model_context_window":200}}}"#,
            &mut state,
        );
        let usage = events
            .iter()
            .find_map(|event| match event {
                AgentEvent::Usage { usage, .. } => Some(usage),
                _ => None,
            })
            .expect("token count should include usage");
        assert_eq!(usage.context_tokens, None);
    }

    #[test]
    fn keeps_context_window_for_later_usage_event() {
        let mut state = State::default();
        translate(
            r#"{"type":"token_count","payload":{"info":{"total_token_usage":{"input_tokens":8},"model_context_window":258400}}}"#,
            &mut state,
        );
        let events = translate(
            r#"{"type":"turn.completed","usage":{"input_tokens":8,"output_tokens":5}}"#,
            &mut state,
        );
        let usage = events
            .iter()
            .find_map(|event| match event {
                AgentEvent::Usage { usage, .. } => Some(usage),
                _ => None,
            })
            .expect("turn completion should include usage");
        assert_eq!(usage.context_window, Some(258_400));
    }

    #[test]
    fn ignores_invalid_model_context_window() {
        let mut state = State::default();
        let events = translate(
            r#"{"type":"token_count","payload":{"info":{"total_token_usage":{"input_tokens":8},"model_context_window":0}}}"#,
            &mut state,
        );
        let usage = events
            .iter()
            .find_map(|event| match event {
                AgentEvent::Usage { usage, .. } => Some(usage),
                _ => None,
            })
            .expect("token count should still include usage");
        assert_eq!(usage.context_window, None);
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
                AgentEvent::Usage { usage, .. } => Some(usage),
                _ => None,
            })
            .expect("turn completion should include usage");
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.output_tokens, 0);
        assert_eq!(usage.total_tokens, 0);
        assert_eq!(usage.cost_usd, None);
    }
}
