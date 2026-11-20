//! Bidirectional protocol control. The command layer owns process lifetime and serializes events.
//! Codex wire types: https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema/typescript
//! Claude control envelopes follow the public claude-agent-sdk-python query transport.
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::process::ChildStdin;
use serde_json::{json, Value};
use super::{AgentEvent, AgentPermissionMode, AgentSessionAction, AgentTurnRequest};
use crate::error::{AppError, AppResult};

pub struct Transport<W: Write = ChildStdin> {
    stdin: Option<W>,
    request: AgentTurnRequest,
    prompt: String,
    pending: HashMap<String, Value>,
    seen_requests: HashSet<String>,
    item_details: HashMap<String, String>,
    pub ready: bool,
    pub finished: Option<bool>,
    thread_id: Option<String>,
    turn_id: Option<String>,
}

pub fn thread_request(request: &AgentTurnRequest) -> Value {
    let mode = request.permission();
    let mut params = json!({"cwd": request.root,
        "sandbox": match mode { AgentPermissionMode::ReadOnly => "read-only", AgentPermissionMode::WorkspaceWrite => "workspace-write", AgentPermissionMode::FullAccess => "danger-full-access" },
        "approvalPolicy": if mode == AgentPermissionMode::WorkspaceWrite { "on-request" } else { "never" },
        "approvalsReviewer": "user"});
    if let Some(model) = request.model.as_ref().filter(|value| !value.is_empty()) { params["model"] = json!(model); }
    let method = match request.session_action {
        AgentSessionAction::New => "thread/start",
        AgentSessionAction::Resume => "thread/resume",
        AgentSessionAction::Fork => "thread/fork",
    };
    if !matches!(request.session_action, AgentSessionAction::New) { params["threadId"] = json!(request.session_id); }
    json!({"id":"tide-thread", "method":method, "params":params})
}

impl<W: Write> Transport<W> {
    pub fn new(stdin: W, request: AgentTurnRequest, prompt: String) -> Self {
        Self { stdin: Some(stdin), request, prompt, pending: HashMap::new(), seen_requests: HashSet::new(), item_details: HashMap::new(), ready: false,
            finished: None, thread_id: None, turn_id: None }
    }
    fn write(&mut self, value: &Value) -> AppResult<()> {
        let stdin = self.stdin.as_mut().ok_or_else(|| AppError::c("agent.permissionExpired"))?;
        let line = format!("{value}\n");
        stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush())
            .map_err(|error| AppError::p("agent.spawnFailed", [("error", error.to_string())]))
    }
    pub fn start(&mut self) -> AppResult<()> {
        if self.request.provider == "codex" {
            self.write(&json!({"id":"tide-init", "method":"initialize", "params":{
                "clientInfo":{"name":"tide", "title":"Tide", "version":env!("CARGO_PKG_VERSION")},
                "capabilities":{"experimentalApi":true, "requiredHumanApproval":true}}}))
        } else {
            self.write(&json!({"type":"control_request", "request_id":"tide-init",
                "request":{"subtype":"initialize", "hooks":null}}))
        }
    }
    pub fn close(&mut self) { self.pending.clear(); self.stdin.take(); }
    pub fn interrupt(&mut self) {
        let value = if self.request.provider == "codex" {
            json!({"id":"tide-interrupt", "method":"turn/interrupt", "params":{"threadId":self.thread_id,"turnId":self.turn_id}})
        } else { json!({"type":"control_request","request_id":"tide-interrupt","request":{"subtype":"interrupt"}}) };
        let _ = self.write(&value);
        self.close();
    }
    pub fn respond(&mut self, request_id: &str, allow: bool) -> AppResult<AgentEvent> {
        if self.finished.is_some() || self.stdin.is_none() { return Err(AppError::c("agent.permissionExpired")); }
        let raw = self.pending.remove(request_id).ok_or_else(|| AppError::c("agent.permissionExpired"))?;
        // A read-only turn can never use a callback to upgrade its permission boundary.
        let allow = allow && self.request.permission() != AgentPermissionMode::ReadOnly;
        let response = permission_response(&raw, self.request.provider == "codex", allow);
        self.write(&response)?;
        Ok(AgentEvent::PermissionResolved { request_id: request_id.into(), allowed: allow })
    }
    /// Handle protocol handshakes/server requests before passing notifications to the translator.
    pub fn receive(&mut self, value: &Value) -> AppResult<Vec<AgentEvent>> {
        let mut out = Vec::new();
        if self.request.provider == "codex" {
            if value.get("method").is_none() {
                if let Some(error) = value.get("error") {
                    return Err(if matches!(error["code"].as_i64(), Some(-32601 | -32602)) {
                        AppError::p("agent.protocolUpgrade", [("provider", "Codex".into()), ("detail", error.to_string())])
                    } else { AppError::new(error["message"].as_str().map(str::to_string).unwrap_or_else(|| error.to_string())) });
                }
                match value["id"].as_str() {
                    Some("tide-init") => {
                        self.write(&json!({"method":"initialized"}))?;
                        self.write(&thread_request(&self.request))?;
                    }
                    Some("tide-thread") => {
                        let id = value["result"]["thread"]["id"].as_str().ok_or_else(|| AppError::c("agent.protocolInvalid"))?;
                        self.thread_id = Some(id.into());
                        out.push(AgentEvent::Session { session_id: id.into() });
                        let mut params = json!({"threadId":id, "input":[{"type":"text", "text":self.prompt, "text_elements":[]}]});
                        if let Some(effort) = self.request.effort.as_ref().filter(|value| !value.is_empty()) { params["effort"] = json!(effort); }
                        self.write(&json!({"id":"tide-turn", "method":"turn/start", "params":params}))?;
                    }
                    Some("tide-turn") => { self.ready = true; self.turn_id = value["result"]["turn"]["id"].as_str().map(str::to_string); }
                    _ => {}
                }
            }
            let method = value["method"].as_str().unwrap_or_default();
            if matches!(method, "item/started" | "item/completed") {
                let item = &value["params"]["item"];
                if let Some(id) = item["id"].as_str() {
                    let detail = item["command"].as_str().map(str::to_string)
                        .or_else(|| item.get("changes").map(|changes| changes.to_string()));
                    if let Some(detail) = detail { self.item_details.insert(id.into(), detail); }
                }
            }
            if method == "turn/started" { self.ready = true; self.turn_id = value["params"]["turn"]["id"].as_str().map(str::to_string); }
            if method == "turn/completed" {
                self.finished = Some(value["params"]["turn"]["status"] == "completed");
                self.pending.clear();
            }
            if value.get("id").is_some() && !method.is_empty() {
                if matches!(method, "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" | "item/permissions/requestApproval") {
                    out.extend(self.approval(value, true)?);
                } else {
                    // Unknown native requests fail closed and visibly; never leave a server waiting forever.
                    self.write(&json!({"id":value["id"], "error":{"code":-32601,"message":"Unsupported Tide client request"}}))?;
                    out.push(AgentEvent::Notice { text: format!("Unsupported Codex request: {method}") });
                }
            }
        } else {
            if value["type"] == "control_response" && value["response"]["request_id"] == "tide-init" {
                if value["response"]["subtype"] == "error" {
                    return Err(AppError::p("agent.protocolUpgrade", [("provider", "Claude Code".into()), ("detail", value["response"].to_string())]));
                }
                self.ready = true;
                self.write(&json!({"type":"user", "message":{"role":"user", "content":self.prompt}, "parent_tool_use_id":null, "session_id":""}))?;
            }
            if value["type"] == "control_request" {
                if value["request"]["subtype"] == "can_use_tool" { out.extend(self.approval(value, false)?); }
                else { self.write(&json!({"type":"control_response", "response":{"subtype":"error", "request_id":value["request_id"], "error":"Unsupported Tide client request"}}))?; }
            }
            if value["type"] == "control_cancel_request" {
                if let Some(id) = value["request_id"].as_str() {
                    if self.pending.remove(id).is_some() { out.push(AgentEvent::PermissionResolved { request_id: id.into(), allowed: false }); }
                }
            }
            if value["type"] == "result" {
                self.finished = Some(value["is_error"] != true && value["subtype"] == "success");
                self.pending.clear();
            }
        }
        Ok(out)
    }
    fn approval(&mut self, raw: &Value, codex: bool) -> AppResult<Vec<AgentEvent>> {
        let id = if codex { raw["id"].to_string() } else { raw["request_id"].as_str().ok_or_else(|| AppError::c("agent.protocolInvalid"))?.into() };
        if !self.seen_requests.insert(id.clone()) { return Ok(Vec::new()); }
        let p = if codex { &raw["params"] } else { &raw["request"] };
        let operation = if codex { match raw["method"].as_str() { Some("item/commandExecution/requestApproval") => "command", Some("item/fileChange/requestApproval") => "fileChange", _ => "permissions" } } else { p["tool_name"].as_str().unwrap_or("tool") };
        let detail = if codex {
            p["command"].as_str().or_else(|| p["grantRoot"].as_str()).map(str::to_string)
                .or_else(|| p.get("permissions").map(|value| value.to_string()))
                .or_else(|| p["itemId"].as_str().and_then(|id| self.item_details.get(id).cloned())).unwrap_or_default()
        } else {
            let input = &p["input"];
            input["command"].as_str().or_else(|| input["file_path"].as_str()).or_else(|| input["path"].as_str())
                .map(str::to_string).unwrap_or_else(|| input.to_string())
        };
        let reason = p["reason"].as_str().or_else(|| p["decision_reason"].as_str()).or_else(|| p["description"].as_str()).unwrap_or_default().to_string();
        self.pending.insert(id.clone(), raw.clone());
        let event = AgentEvent::PermissionRequest { item_id: format!("permission-{id}"), request_id: id.clone(), operation: operation.into(), detail, reason };
        if self.request.permission() == AgentPermissionMode::ReadOnly {
            return Ok(vec![event, self.respond(&id, false)?]);
        }
        Ok(vec![event])
    }
}

fn permission_response(raw: &Value, codex: bool, allow: bool) -> Value {
    if codex && raw["method"] == "item/permissions/requestApproval" {
        let permissions = if allow { raw["params"]["permissions"].as_object().map(|fields|
            fields.iter().filter(|(_, value)| !value.is_null()).map(|(key, value)| (key.clone(), value.clone())).collect::<serde_json::Map<String, Value>>()).unwrap_or_default()
        } else { serde_json::Map::new() };
        json!({"id":raw["id"], "result":{"permissions":permissions, "scope":"turn"}})
    } else if codex { json!({"id":raw["id"],"result":{"decision":if allow {"accept"} else {"decline"}}}) }
    else { json!({"type":"control_response", "response":{"subtype":"success", "request_id":raw["request_id"],
        "response":if allow { json!({"behavior":"allow","updatedInput":raw["request"]["input"]}) }
            else { json!({"behavior":"deny","message":"Denied by the user or read-only mode."}) }}}) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(mode: AgentPermissionMode, provider: &str) -> AgentTurnRequest {
        AgentTurnRequest { chat_id: "chat".into(), run_id: "run".into(), root: "/tmp".into(), provider: provider.into(),
            session_action: AgentSessionAction::New, session_id: None, model: None, effort: None,
            prompt: "hello".into(), mentions: Vec::new(), read_only: false, permission_mode: mode }
    }

    #[test]
    fn three_modes_and_read_only_override_are_explicit() {
        for (mode, sandbox, policy) in [(AgentPermissionMode::ReadOnly, "read-only", "never"),
            (AgentPermissionMode::WorkspaceWrite, "workspace-write", "on-request"),
            (AgentPermissionMode::FullAccess, "danger-full-access", "never")] {
            let mut r = request(mode, "codex");
            assert_eq!(thread_request(&r)["params"]["sandbox"], sandbox);
            assert_eq!(thread_request(&r)["params"]["approvalPolicy"], policy);
            r.read_only = true;
            assert_eq!(thread_request(&r)["params"]["sandbox"], "read-only");
        }
    }

    #[test]
    fn handshake_defers_prompt_until_native_thread_is_ready() {
        for (action, method) in [(AgentSessionAction::New, "thread/start"),
            (AgentSessionAction::Resume, "thread/resume"), (AgentSessionAction::Fork, "thread/fork")] {
            let mut r = request(AgentPermissionMode::WorkspaceWrite, "codex");
            r.session_action = action; r.session_id = Some("parent".into());
            let mut t = Transport::new(Vec::new(), r, "private prompt".into());
            t.start().unwrap();
            assert!(!String::from_utf8(t.stdin.clone().unwrap()).unwrap().contains("private prompt"));
            t.receive(&json!({"id":"tide-init","result":{}})).unwrap();
            let lines = String::from_utf8(t.stdin.clone().unwrap()).unwrap();
            assert!(lines.contains(method));
            t.receive(&json!({"id":"tide-thread","result":{"thread":{"id":"child"}}})).unwrap();
            assert!(String::from_utf8(t.stdin.clone().unwrap()).unwrap().contains("private prompt"));
        }
    }

    #[test]
    fn pending_approvals_are_single_use_and_expire_on_stop() {
        let mut t = Transport::new(Vec::new(), request(AgentPermissionMode::WorkspaceWrite, "codex"), "hi".into());
        let raw = json!({"id":12,"method":"item/commandExecution/requestApproval","params":{"command":"pwd"}});
        assert_eq!(t.receive(&raw).unwrap().len(), 1);
        assert!(t.receive(&raw).unwrap().is_empty());
        assert!(matches!(t.respond("12", true).unwrap(), AgentEvent::PermissionResolved { allowed: true, .. }));
        assert!(t.respond("12", true).is_err());
        t.receive(&json!({"id":13,"method":"item/fileChange/requestApproval","params":{"grantRoot":"/outside"}})).unwrap();
        t.interrupt();
        assert!(t.respond("13", true).is_err());
    }

    #[test]
    fn read_only_denies_native_escalation_without_user_action() {
        let mut t = Transport::new(Vec::new(), request(AgentPermissionMode::ReadOnly, "claude"), "hi".into());
        let events = t.receive(&json!({"type":"control_request","request_id":"p","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"/outside"}}})).unwrap();
        assert!(matches!(events.last(), Some(AgentEvent::PermissionResolved { allowed: false, .. })));
        assert!(t.respond("p", true).is_err());
        assert!(String::from_utf8(t.stdin.unwrap()).unwrap().contains("deny"));
    }

    #[test]
    fn claude_final_result_closes_pending_requests_and_marks_failure() {
        let mut t = Transport::new(Vec::new(), request(AgentPermissionMode::WorkspaceWrite, "claude"), "hi".into());
        t.receive(&json!({"type":"control_response","response":{"request_id":"tide-init","subtype":"success"}})).unwrap();
        assert!(t.ready);
        assert!(String::from_utf8(t.stdin.clone().unwrap()).unwrap().contains("\"type\":\"user\""));
        t.receive(&json!({"type":"result","subtype":"error_during_execution","is_error":true})).unwrap();
        assert_eq!(t.finished, Some(false));
        assert!(t.respond("old", true).is_err());
    }

    #[test]
    fn granular_permissions_never_persist_beyond_the_turn() {
        let raw = json!({"id":"p", "method":"item/permissions/requestApproval",
            "params":{"permissions":{"network":{"enabled":true},"fileSystem":null}}});
        let result = permission_response(&raw, true, true);
        assert_eq!(result["result"]["scope"], "turn");
        assert_eq!(result["result"]["permissions"]["network"]["enabled"], true);
        assert!(result["result"]["permissions"].get("fileSystem").is_none());
        assert_eq!(permission_response(&raw, true, false)["result"]["permissions"], json!({}));
    }

    #[test]
    fn approvals_preserve_wire_ids_and_only_allow_once() {
        let raw = json!({"id":42});
        assert_eq!(permission_response(&raw, true, true), json!({"id":42,"result":{"decision":"accept"}}));
        assert_eq!(permission_response(&raw, true, false)["result"]["decision"], "decline");
        let raw = json!({"request_id":"a", "request":{"input":{"command":"pwd"}}});
        assert_eq!(permission_response(&raw, false, true)["response"]["response"]["updatedInput"]["command"], "pwd");
        assert!(permission_response(&raw, false, true)["response"]["response"].get("updatedPermissions").is_none());
    }
}
