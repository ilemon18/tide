//! Claude Code in `-p --output-format stream-json` mode.

use std::collections::HashSet;
use std::path::Path;

use serde_json::Value;

use super::{uuid_v4, workspace_note, AgentEvent, AgentTurnRequest, Launch};

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
}
