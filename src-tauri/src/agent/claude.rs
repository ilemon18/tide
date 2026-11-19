//! Claude Code in `-p --output-format stream-json` mode.

use std::collections::HashSet;
use std::path::Path;

use serde_json::Value;

use super::{uuid_v4, workspace_note, AgentEvent, AgentTurnRequest, AgentUsage, Launch};

/// One process per user turn. The first turn names its own session so a follow-up can resume
/// it; a restore keeps the id in the transcript.
pub fn launch(program: &Path, request: &AgentTurnRequest, root: &Path) -> Launch {
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--verbose".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--include-partial-messages".into(),
        // Tide has no approval channel: Claude must not stop to ask. The system prompt keeps
        // it inside the project; the settings page says so in plain words.
        "--permission-mode".into(),
        "bypassPermissions".into(),
        "--allow-dangerously-skip-permissions".into(),
        "--append-system-prompt".into(),
        workspace_note(root),
    ];
    if let Some(model) = request.model.as_deref().filter(|m| !m.is_empty()) {
        args.push("--model".into());
        args.push(model.to_string());
    }
    if let Some(effort) = request.effort.as_deref().filter(|e| !e.is_empty()) {
        args.push("--effort".into());
        args.push(effort.to_string());
    }
    match request.session_id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => {
            args.push("--resume".into());
            args.push(id.to_string());
        }
        None => {
            args.push("--session-id".into());
            args.push(uuid_v4());
        }
    }
    Launch {
        program: program.to_path_buf(),
        args,
    }
}

#[derive(Default)]
pub struct State {
    text_id: Option<String>,
    seq: u64,
    /// Tool ids already announced, so the final `assistant` event does not duplicate them
    tools: HashSet<String>,
    /// Any text delta seen: the assistant event then carries the same text again
    streamed: bool,
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

fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn token_count(usage: &Value, key: &str) -> u64 {
    usage.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn has_token_count(usage: &Value) -> bool {
    [
        "input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
        "output_tokens",
    ]
    .iter()
    .any(|key| usage.get(*key).and_then(Value::as_u64).is_some())
}

fn result_usage(value: &Value) -> Option<AgentUsage> {
    let usage = value.get("usage").filter(|usage| usage.is_object());
    let cost_usd = value
        .get("total_cost_usd")
        .and_then(Value::as_f64)
        .filter(|cost| cost.is_finite() && *cost >= 0.0);
    if !usage.is_some_and(has_token_count) && cost_usd.is_none() {
        return None;
    }
    let usage = usage.unwrap_or(&Value::Null);
    let input_tokens = token_count(usage, "input_tokens");
    let cached_input_tokens = token_count(usage, "cache_read_input_tokens");
    let cache_write_input_tokens = token_count(usage, "cache_creation_input_tokens");
    let output_tokens = token_count(usage, "output_tokens");
    // Claude reports reasoning as part of the output token stream, not as a separate field.
    let reasoning_output_tokens = 0;
    let total_tokens = input_tokens
        .saturating_add(cached_input_tokens)
        .saturating_add(cache_write_input_tokens)
        .saturating_add(output_tokens);
    Some(AgentUsage {
        input_tokens,
        cached_input_tokens,
        cache_write_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        total_tokens,
        cost_usd,
    })
}

pub fn translate(line: &str, state: &mut State) -> Vec<AgentEvent> {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        // Not every stdout line is JSON (warnings from wrappers): keep it visible in the log
        Err(_) => return vec![AgentEvent::Stderr { text: line.to_string() }],
    };
    let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
    let session = value.get("session_id").and_then(Value::as_str);
    let mut out = Vec::new();

    match kind {
        "system" => {
            if value.get("subtype").and_then(Value::as_str) == Some("init") {
                if let Some(id) = session {
                    out.push(AgentEvent::Session {
                        session_id: id.to_string(),
                    });
                }
            }
        }
        "stream_event" => {
            let Some(event) = value.get("event") else {
                return out;
            };
            match event.get("type").and_then(Value::as_str).unwrap_or_default() {
                "content_block_start" => {
                    let block = event.get("content_block");
                    match block.and_then(|b| b.get("type")).and_then(Value::as_str) {
                        Some("text") => {
                            state.seq += 1;
                            state.text_id = Some(format!("text-{}", state.seq));
                        }
                        Some("tool_use") => {
                            let id = block
                                .and_then(|b| b.get("id"))
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            let name = block
                                .and_then(|b| b.get("name"))
                                .and_then(Value::as_str)
                                .unwrap_or("tool");
                            if !id.is_empty() {
                                state.tools.insert(id.to_string());
                                out.push(AgentEvent::ToolStart {
                                    item_id: id.to_string(),
                                    title: name.to_string(),
                                });
                            }
                        }
                        _ => {}
                    }
                }
                "content_block_delta" => {
                    let delta = event.get("delta");
                    if delta.and_then(|d| d.get("type")).and_then(Value::as_str)
                        == Some("text_delta")
                    {
                        if let (Some(id), Some(text)) = (
                            state.text_id.as_ref(),
                            delta.and_then(|d| d.get("text")).and_then(Value::as_str),
                        ) {
                            state.streamed = true;
                            out.push(AgentEvent::TextDelta {
                                item_id: id.clone(),
                                text: text.to_string(),
                            });
                        }
                    }
                }
                "content_block_stop" => {
                    state.text_id = None;
                }
                _ => {}
            }
        }
        "assistant" => {
            let blocks = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array);
            let Some(blocks) = blocks else {
                return out;
            };
            for (index, block) in blocks.iter().enumerate() {
                match block.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "text" => {
                        if state.streamed {
                            continue;
                        }
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            state.seq += 1;
                            out.push(AgentEvent::TextDelta {
                                item_id: format!("text-{}", state.seq),
                                text: text.to_string(),
                            });
                        }
                    }
                    "tool_use" => {
                        let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
                        if id.is_empty() {
                            continue;
                        }
                        if state.tools.insert(id.to_string()) {
                            out.push(AgentEvent::ToolStart {
                                item_id: id.to_string(),
                                title: block
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .unwrap_or("tool")
                                    .to_string(),
                            });
                        }
                        if let Some(input) = block.get("input") {
                            out.push(AgentEvent::ToolDetail {
                                item_id: id.to_string(),
                                detail: clip(&input.to_string()),
                            });
                        }
                    }
                    "thinking" => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            state.seq += 1;
                            out.push(AgentEvent::Thinking {
                                item_id: format!("think-{}-{index}", state.seq),
                                text: text.to_string(),
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        "user" => {
            let Some(blocks) = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array)
            else {
                return out;
            };
            for block in blocks {
                if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
                    continue;
                };
                let ok = !block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                let output = content_text(block.get("content"));
                out.push(AgentEvent::ToolEnd {
                    item_id: id.to_string(),
                    ok,
                    output: (!output.is_empty()).then(|| clip(&output)),
                });
            }
        }
        "result" => {
            if let Some(usage) = result_usage(&value) {
                out.push(AgentEvent::Usage { usage });
            }
            let failed = value.get("is_error").and_then(Value::as_bool).unwrap_or(false)
                || value
                    .get("subtype")
                    .and_then(Value::as_str)
                    .is_some_and(|subtype| subtype != "success");
            if failed {
                let message = value
                    .get("result")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .or_else(|| value.get("subtype").and_then(Value::as_str))
                    .unwrap_or("Claude Code reported an error.");
                out.push(AgentEvent::Notice {
                    text: clip(message),
                });
            }
        }
        "error" => {
            let message = value
                .get("error")
                .and_then(Value::as_str)
                .or_else(|| value.get("message").and_then(Value::as_str))
                .unwrap_or("Claude Code reported an error.");
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
    fn reads_session_and_text_deltas() {
        let mut state = State::default();
        let init = translate(
            r#"{"type":"system","subtype":"init","session_id":"abc"}"#,
            &mut state,
        );
        assert!(matches!(&init[0], AgentEvent::Session { .. }));

        translate(
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
            &mut state,
        );
        let delta = translate(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}}"#,
            &mut state,
        );
        match &delta[0] {
            AgentEvent::TextDelta { text, .. } => assert_eq!(text, "hi"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn tool_use_and_result_pair_up() {
        let mut state = State::default();
        let start = translate(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}"#,
            &mut state,
        );
        assert!(start.iter().any(|e| matches!(e, AgentEvent::ToolStart { title, .. } if title == "Bash")));
        let end = translate(
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#,
            &mut state,
        );
        assert!(end.iter().any(|e| matches!(e, AgentEvent::ToolEnd { ok: true, output: Some(text), .. } if text == "ok")));
    }

    #[test]
    fn non_json_lines_become_stderr() {
        let mut state = State::default();
        let events = translate("warning: something", &mut state);
        assert!(matches!(&events[0], AgentEvent::Stderr { .. }));
    }

    #[test]
    fn result_reports_cache_usage_and_cost() {
        let mut state = State::default();
        let events = translate(
            r#"{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.0125,"usage":{"input_tokens":120,"cache_read_input_tokens":300,"cache_creation_input_tokens":40,"output_tokens":80}}"#,
            &mut state,
        );
        let usage = events
            .iter()
            .find_map(|event| match event {
                AgentEvent::Usage { usage } => Some(usage),
                _ => None,
            })
            .expect("result should include usage");
        assert_eq!(usage.input_tokens, 120);
        assert_eq!(usage.cached_input_tokens, 300);
        assert_eq!(usage.cache_write_input_tokens, 40);
        assert_eq!(usage.output_tokens, 80);
        assert_eq!(usage.reasoning_output_tokens, 0);
        assert_eq!(usage.total_tokens, 540);
        assert_eq!(usage.cost_usd, Some(0.0125));
    }

    #[test]
    fn result_keeps_an_explicit_zero_cost() {
        let mut state = State::default();
        let events = translate(
            r#"{"type":"result","subtype":"success","total_cost_usd":0,"usage":{}}"#,
            &mut state,
        );
        let usage = events
            .iter()
            .find_map(|event| match event {
                AgentEvent::Usage { usage } => Some(usage),
                _ => None,
            })
            .expect("result should include usage");
        assert_eq!(usage.cost_usd, Some(0.0));
        assert_eq!(usage.total_tokens, 0);
    }

    #[test]
    fn result_without_usage_or_cost_emits_no_usage_event() {
        let mut state = State::default();
        let events = translate(
            r#"{"type":"result","subtype":"success","is_error":false}"#,
            &mut state,
        );
        assert!(!events
            .iter()
            .any(|event| matches!(event, AgentEvent::Usage { .. })));
    }

    #[test]
    fn empty_usage_without_cost_emits_no_usage_event() {
        let mut state = State::default();
        let events = translate(
            r#"{"type":"result","subtype":"success","is_error":false,"usage":{}}"#,
            &mut state,
        );
        assert!(!events
            .iter()
            .any(|event| matches!(event, AgentEvent::Usage { .. })));
    }
}
