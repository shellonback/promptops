//! Claude Code hook domain.
//!
//!  - `HookServer` is an HTTP server on a `std::net::TcpListener` running on a
//!    dedicated thread (zero extra crates: no axum/hyper), listening on
//!    `127.0.0.1:<random-port>`. It speaks minimal HTTP/1.1 — enough for hook
//!    scripts doing `curl`/`fetch` POST. It receives POSTs from Claude Code
//!    hook scripts (`/hook`) and from the sub-agent CLI commands
//!    (`/subagent/*`), plus a GET `/speech` for the speech-recognition page.
//!  - `dispatch_hook_event` normalizes the payload and does
//!    `AppHandle::emit("hook:event", …)`, updates the session status (running /
//!    waiting_input / completed) and — when input is needed — emits
//!    `hook:navigate-session` and (best-effort) a system notification that, on
//!    click, navigates to the parent session.
//!
//! There is no internal event bus: the hook kinds (notification, stop,
//! tool-use, session-start, session-end, generic) all collapse directly into
//! the `hook:event` emit to the renderer.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

// ── Channels ────────────────────────────────────────────────────────
/// URL path of the direct HTTP hook (Windows, Claude Code >= 2.1.63). It is also
/// the stable marker that identifies an HTTP hook written by PromptOps.
const HTTP_HOOK_PATH: &str = "/promptops-hook";

/// Current hook server port, readable by other modules (session.rs)
/// without going through Tauri State. 0 = server not started.
static GLOBAL_PORT: AtomicU16 = AtomicU16::new(0);

/// Hook server port for modules that have no access to State.
pub fn global_port() -> u16 {
    GLOBAL_PORT.load(Ordering::Relaxed)
}

/// `IpcChannels.HOOK_EVENT` — main → renderer push of every hook event.
const HOOK_EVENT: &str = "hook:event";
/// `IpcChannels.HOOK_NAVIGATE_SESSION` — main → renderer push on notification click.
/// Reserved for the click→navigate TODO (the desktop plugin does not expose the click).
#[allow(dead_code)]
const HOOK_NAVIGATE_SESSION: &str = "hook:navigate-session";

// ── Injected callbacks (HookServer.setAutoApproveCheckFn) ─────────────

/// `AutoApproveCheckFn` — is auto-approve active for a session? (PreToolUse).
pub type AutoApproveCheckFn = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// `resolveToParent` — resolves a sub-agent sessionId to its parent, so
/// navigation always points to the main session.
pub type ResolveParentFn = Arc<dyn Fn(&str) -> String + Send + Sync>;
/// child session id → sub-agent id (the one used by `subagent_write`).
pub type ResolveSubAgentFn = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// `resolveSessionName` — readable session name (fallback: first 8 chars
/// of the sessionId).
pub type ResolveNameFn = Arc<dyn Fn(&str) -> String + Send + Sync>;

/// `updateSessionStatus` — updates the status of the *original* session (not the
/// parent), via `sessionManager.updateStatus`.
/// Receives (sessionId, status) with status ∈ {running,waiting_input,completed,error}.
pub type UpdateStatusFn = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// `setClaudeSessionId` — persists the provider conversation id on the
/// main session at SessionStart (`hook:session-start` →
/// `sessionManager.setClaudeSessionId`).
/// Receives (sessionId, claudeSessionId).
pub type SetClaudeSessionFn = Arc<dyn Fn(&str, &str) + Send + Sync>;

// ── HookManager — managed state (Arc + parking_lot::Mutex) ───────────
//
// Holds the port the server is listening on + the callbacks injected by main.
// Holds the server properties (port, subAgentListFn, autoApproveCheckFn) plus
// the session resolvers used by the dispatcher.

#[derive(Default)]
struct HookState {
    /// Actual listener port (0 until started). `HookServer.port`.
    port: u16,
    auto_approve_check_fn: Option<AutoApproveCheckFn>,
    resolve_parent_fn: Option<ResolveParentFn>,
    resolve_sub_agent_fn: Option<ResolveSubAgentFn>,
    resolve_name_fn: Option<ResolveNameFn>,
    update_status_fn: Option<UpdateStatusFn>,
    set_claude_session_fn: Option<SetClaudeSessionFn>,
}

#[derive(Default)]
pub struct HookManager {
    state: Mutex<HookState>,
}

impl HookManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// `HookServer.setAutoApproveCheckFn`.
    pub fn set_auto_approve_check_fn(&self, f: AutoApproveCheckFn) {
        self.state.lock().auto_approve_check_fn = Some(f);
    }

    /// Resolver for sub-agent → parent resolution (see `resolveToParent`).
    pub fn set_resolve_parent_fn(&self, f: ResolveParentFn) {
        self.state.lock().resolve_parent_fn = Some(f);
    }

    /// Resolver child session → sub-agent id (routing of actions like /compact).
    pub fn set_resolve_sub_agent_fn(&self, f: ResolveSubAgentFn) {
        self.state.lock().resolve_sub_agent_fn = Some(f);
    }

    /// Session name resolver (`resolveSessionName`).
    pub fn set_resolve_name_fn(&self, f: ResolveNameFn) {
        self.state.lock().resolve_name_fn = Some(f);
    }

    /// Hook for session status updates (`updateSessionStatus`).
    pub fn set_update_status_fn(&self, f: UpdateStatusFn) {
        self.state.lock().update_status_fn = Some(f);
    }

    /// Hook for capturing the claudeSessionId on the main session.
    pub fn set_set_claude_session_fn(&self, f: SetClaudeSessionFn) {
        self.state.lock().set_claude_session_fn = Some(f);
    }

    /// `HookServer.getPort`.
    pub fn port(&self) -> u16 {
        self.state.lock().port
    }

    fn resolve_to_parent(&self, session_id: &str) -> String {
        match &self.state.lock().resolve_parent_fn {
            Some(f) => f(session_id),
            None => session_id.to_string(),
        }
    }

    fn resolve_sub_agent(&self, session_id: &str) -> Option<String> {
        let f = self.state.lock().resolve_sub_agent_fn.clone();
        f.and_then(|f| f(session_id))
    }

    fn resolve_session_name(&self, session_id: &str) -> String {
        match &self.state.lock().resolve_name_fn {
            Some(f) => f(session_id),
            None => fallback_name(session_id),
        }
    }

    fn update_session_status(&self, session_id: &str, status: &str) {
        if let Some(f) = &self.state.lock().update_status_fn {
            f(session_id, status);
        }
    }

    fn set_claude_session_id(&self, session_id: &str, claude_session_id: &str) {
        // Clone outside the lock: the callback does I/O (local store sync).
        let f = self.state.lock().set_claude_session_fn.clone();
        if let Some(f) = f {
            f(session_id, claude_session_id);
        }
    }

    fn auto_approve(&self, session_id: &str) -> bool {
        match &self.state.lock().auto_approve_check_fn {
            Some(f) => f(session_id),
            None => false,
        }
    }
}

// ── Commands ──────────────────────────────────────────────────────────

/// `HookServer.start` — starts the HTTP listener on `127.0.0.1:0` (random port),
/// stores the port in state and returns it (for the hook scripts).
///
/// Idempotent: if already started, returns the current
/// port without opening a second listener.
#[tauri::command]
pub fn hook_start(
    app: AppHandle,
    manager: tauri::State<'_, Arc<HookManager>>,
) -> Result<u16, String> {
    {
        let existing = manager.state.lock().port;
        if existing != 0 {
            return Ok(existing);
        }
    }

    // `server.listen(0, '127.0.0.1', …)` → ephemeral port assigned by the OS.
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    manager.state.lock().port = port;
    GLOBAL_PORT.store(port, Ordering::Relaxed);
    crate::commands::promptops_cli::write_ctl_file(port);

    // `manager.inner()` → `&Arc<HookManager>`; we clone the Arc for the thread.
    let manager_for_thread: Arc<HookManager> = Arc::clone(manager.inner());
    let app_for_thread = app.clone();

    // Accept loop on a dedicated thread. Each connection is READ on its own
    // thread (with timeouts and caps): a slow or silent client no longer blocks hooks.
    // Routing stays serial (`ROUTE_LOCK`), as before.
    std::thread::spawn(move || accept_loop(listener, app_for_thread, manager_for_thread));

    Ok(port)
}

/// `HookServer.getPort` exposed as a command (hook scripts need it to know
/// where to POST).
#[tauri::command]
pub fn hook_get_port(manager: tauri::State<'_, Arc<HookManager>>) -> u16 {
    manager.port()
}

// ── Minimal HTTP/1.1 server ─────────────────────────────────────────
//
// Bare-bones parsing: first line "METHOD URL HTTP/1.1", headers (for
// Content-Length), body. Enough for the hook scripts' JSON POSTs.

// ── Server limits ────────────────────────────────────────────────
//
// The port is on loopback but reachable by ANY local process and by
// any web page open in the user's browser ("simple" POST to
// 127.0.0.1). So: bounded time and size before trusting
// anything, no requests originating in a browser, token BEFORE the body for
// endpoints that command agents.

/// Longest accepted request/header line.
const MAX_HEADER_LINE: u64 = 8 * 1024;
const MAX_HEADERS: usize = 100;
/// Hook body (Claude events with tool output): large but bounded.
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
/// Control plane body: a prompt (256 KiB) plus the JSON envelope.
const MAX_CTL_BODY_BYTES: usize = 512 * 1024;
/// Maximum wait on a single socket read/write.
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// Total time to receive a complete request (anti slow-drip).
const REQUEST_DEADLINE: Duration = Duration::from_secs(15);
const MAX_CONNECTIONS: usize = 128;
/// ctl calls in flight (`wait` holds the connection up to 45 s).
const MAX_CTL_CALLS: usize = 64;

static CONNECTIONS: AtomicUsize = AtomicUsize::new(0);
static CTL_CALLS: AtomicUsize = AtomicUsize::new(0);
static ROUTE_LOCK: Mutex<()> = Mutex::new(());

/// Slot taken in a capped counter; released on drop.
struct Slot(&'static AtomicUsize);

impl Slot {
    fn take(counter: &'static AtomicUsize, max: usize) -> Option<Slot> {
        if counter.fetch_add(1, Ordering::AcqRel) >= max {
            counter.fetch_sub(1, Ordering::AcqRel);
            return None;
        }
        Some(Slot(counter))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn accept_loop(listener: TcpListener, app: AppHandle, manager: Arc<HookManager>) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        // Above the cap the connection is closed without reading it.
        let Some(slot) = Slot::take(&CONNECTIONS, MAX_CONNECTIONS) else {
            continue;
        };
        let app = app.clone();
        let manager = Arc::clone(&manager);
        let _ = std::thread::Builder::new()
            .name("hook-conn".into())
            .spawn(move || {
                let _slot = slot;
                handle_connection(&app, &manager, stream);
            });
    }
}

#[derive(Default)]
struct RequestHead {
    method: String,
    url: String,
    content_length: usize,
    session: String,
    workspace: String,
    token: String,
    /// Request `Host` (empty if missing).
    host: String,
    /// The request carries an `Origin` header: it originates in a browser.
    has_origin: bool,
}

impl RequestHead {
    /// Endpoints that command or list agents: always behind a token.
    fn is_protected(&self) -> bool {
        self.url.starts_with("/ctl/") || self.url.starts_with("/subagent/")
    }

    /// Hook events from the agent CLIs: they change session state and answer
    /// permission questions, so they also need the app's token.
    fn is_hook(&self) -> bool {
        self.method == "POST" && (self.url == "/hook" || self.url == HTTP_HOOK_PATH)
    }
}

/// A `\n`-terminated line, at most `MAX_HEADER_LINE` long. `false` on EOF,
/// timeout, line too long or non-UTF-8.
fn read_bounded_line<R: BufRead>(reader: &mut R, line: &mut String) -> bool {
    line.clear();
    matches!(reader.take(MAX_HEADER_LINE).read_line(line), Ok(n) if n > 0) && line.ends_with('\n')
}

fn read_head<R: BufRead>(reader: &mut R, deadline: Instant) -> Option<RequestHead> {
    let mut line = String::new();
    if !read_bounded_line(reader, &mut line) {
        return None;
    }
    let mut parts = line.split_whitespace();
    let mut head = RequestHead {
        method: parts.next().unwrap_or("").to_string(),
        url: parts.next().unwrap_or("").to_string(),
        ..RequestHead::default()
    };
    if head.method.is_empty() || !head.url.starts_with('/') {
        return None;
    }
    // Headers → Content-Length + the PromptOps attribution headers
    // (used by Claude Code's direct HTTP hooks on /promptops-hook).
    for _ in 0..=MAX_HEADERS {
        if Instant::now() > deadline || !read_bounded_line(reader, &mut line) {
            return None;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            return Some(head); // fine header
        }
        let (name, value) = trimmed.split_once(':')?;
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            // A non-numeric Content-Length is a malformed request, not "0".
            "content-length" => head.content_length = value.parse().ok()?,
            // No body of unknown length: the parser could not delimit it.
            "transfer-encoding" => return None,
            "x-promptops-session" => head.session = value.to_string(),
            "x-promptops-workspace" => head.workspace = value.to_string(),
            "x-promptops-token" => head.token = value.to_string(),
            "host" => head.host = value.to_string(),
            "origin" => head.has_origin = true,
            _ => {}
        }
    }
    None // too many headers
}

/// Acceptable `Host`: `localhost` or a literal IP (loopback, or the WSL
/// listener interface). A domain name is a DNS rebinding attempt: the
/// browser thinks it is talking to a site and talks to us. Missing = non-browser
/// client (browsers always send it).
fn host_is_local(host: &str) -> bool {
    if host.is_empty() {
        return true;
    }
    let name = match host.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => name,
        _ => host,
    };
    let name = name.trim_start_matches('[').trim_end_matches(']');
    name.eq_ignore_ascii_case("localhost") || name.parse::<std::net::IpAddr>().is_ok()
}

/// Decides whether the request may proceed, BEFORE reading its body.
/// `Ok(body cap)` or `Err((status, code, message))`.
fn gate(
    head: &RequestHead,
    token_ok: bool,
) -> Result<usize, (&'static str, &'static str, &'static str)> {
    if !host_is_local(&head.host) {
        return Err((
            "403 Forbidden",
            "forbidden_host",
            "Host must be localhost or an IP literal",
        ));
    }
    let protected = head.is_protected();
    // A web page can GET/POST to 127.0.0.1: every write originating in
    // a browser is rejected, and on protected endpoints reads too.
    if head.has_origin && (protected || head.method != "GET") {
        return Err((
            "403 Forbidden",
            "forbidden_origin",
            "requests from a browser are not accepted",
        ));
    }
    if (protected || head.is_hook()) && !token_ok {
        return Err((
            "401 Unauthorized",
            "unauthorized",
            "missing or invalid control token",
        ));
    }
    let cap = if protected {
        MAX_CTL_BODY_BYTES
    } else {
        MAX_BODY_BYTES
    };
    if head.content_length > cap {
        return Err((
            "413 Payload Too Large",
            "payload_too_large",
            "request body too large",
        ));
    }
    Ok(cap)
}

/// Body of `len` bytes, read in chunks: memory grows with the bytes that ARRIVED,
/// not with those announced. `None` on EOF, timeout or deadline exceeded.
fn read_body<R: Read>(reader: &mut R, len: usize, deadline: Instant) -> Option<String> {
    let mut buf = Vec::with_capacity(len.min(64 * 1024));
    let mut chunk = [0u8; 16 * 1024];
    while buf.len() < len {
        if Instant::now() > deadline {
            return None;
        }
        let want = (len - buf.len()).min(chunk.len());
        match reader.read(&mut chunk[..want]) {
            Ok(0) | Err(_) => return None,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn reject(status: &str, code: &str, message: &str) -> String {
    let body = json!({ "ok": false, "error": { "code": code, "message": message } }).to_string();
    http_response(status, "application/json", &body)
}

fn respond(stream: &mut TcpStream, response: &str) {
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

/// Which token a request needs. The `ctl.json` file token exists for the
/// MCP server (`/ctl/*`) only; hook events and `/subagent/*` come from
/// PromptOps terminals and accept only the terminal token, so a process that
/// can read ctl.json cannot forge hook events (session state, permission
/// answers) or drive sub-agents.
fn request_token_ok(head: &RequestHead) -> bool {
    if head.url.starts_with("/ctl/") {
        crate::commands::agent_ctl::authorized(&head.token)
    } else if head.is_protected() || head.is_hook() {
        crate::commands::agent_ctl::authorized_terminal(&head.token)
    } else {
        false
    }
}

/// Receives and validates a request: headers (bounded), gate, then body.
/// `Err(response)` = the request must be closed with that response.
fn receive(stream: &TcpStream) -> Result<(RequestHead, String), String> {
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let deadline = Instant::now() + REQUEST_DEADLINE;
    let mut reader = BufReader::new(stream.try_clone().map_err(|_| bad_request())?);
    let head = read_head(&mut reader, deadline).ok_or_else(bad_request)?;
    let token_ok = request_token_ok(&head);
    gate(&head, token_ok).map_err(|(status, code, message)| reject(status, code, message))?;
    let body = read_body(&mut reader, head.content_length, deadline).ok_or_else(bad_request)?;
    Ok((head, body))
}

fn handle_connection(app: &AppHandle, manager: &Arc<HookManager>, mut stream: TcpStream) {
    let (head, body) = match receive(&stream) {
        Ok(request) => request,
        Err(response) => {
            respond(&mut stream, &response);
            return;
        }
    };

    // Control plane (`promptops ctl` / `promptops mcp`): `wait` is a long-poll.
    // It runs on this connection thread and does NOT take `ROUTE_LOCK`, so it does not
    // block hooks.
    if head.url.starts_with("/ctl/") {
        let Some(_slot) = Slot::take(&CTL_CALLS, MAX_CTL_CALLS) else {
            respond(
                &mut stream,
                &reject(
                    "429 Too Many Requests",
                    "busy",
                    "too many control calls in flight",
                ),
            );
            return;
        };
        let (status, value) =
            crate::commands::agent_ctl::handle(app, &head.method, &head.url, &body, &head.token);
        let body = serde_json::to_string(&value).unwrap_or_else(|_| "{}".into());
        respond(
            &mut stream,
            &http_response(status, "application/json", &body),
        );
        return;
    }

    // Route the request. Any panic/parse-error → 400.
    let response = {
        let _serial = ROUTE_LOCK.lock();
        route(
            app,
            manager,
            &head.method,
            &head.url,
            &body,
            &head.session,
            &head.workspace,
        )
    };
    respond(&mut stream, &response);
}

/// `HookServer.route` — routes requests to the known endpoints.
#[allow(clippy::too_many_arguments)]
fn route(
    app: &AppHandle,
    manager: &Arc<HookManager>,
    method: &str,
    url: &str,
    body: &str,
    header_session: &str,
    header_workspace: &str,
) -> String {
    // ── Speech Recognition page (GET /speech) ───────────────────────
    // Served over HTTP so microphone permissions work in the webview.
    if method == "GET" && url.starts_with("/speech") {
        // Ends up inside a <script>: BCP-47 form only, never free text.
        let locale = query_param(url, "lang")
            .filter(|l| {
                !l.is_empty()
                    && l.len() <= 16
                    && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
            .unwrap_or_else(|| "en-US".into());
        let html = speech_page_html(&locale);
        return http_response("200 OK", "text/html; charset=utf-8", &html);
    }

    // ── Claude Code hooks (POST /hook) ──────────────────────────────
    if method == "POST" && url == "/hook" {
        let payload: Value = match serde_json::from_str(body) {
            Ok(v) => v,
            Err(_) => return bad_request(),
        };
        dispatch_hook_event(app, manager, &payload);

        // PreToolUse: tells the script whether to auto-approve this session.
        let session_id = payload
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let is_pre_tool_use = payload
            .get("event")
            .and_then(|e| e.get("hook_event_name"))
            .and_then(|v| v.as_str())
            == Some("PreToolUse");
        let should_auto_approve = is_pre_tool_use && manager.auto_approve(session_id);
        return json_response(&json!({ "ok": true, "autoApprove": should_auto_approve }));
    }

    // ── Claude Code direct HTTP hooks (Windows, CLI >= 2.1.63) ──────
    // Like /hook, but Claude POSTs the event's native JSON (no node
    // shim): the body IS the raw event, the session id arrives via header
    // (interpolated from the per-process env). The response must use Claude's
    // decision format: {} neutral = "no opinion".
    if method == "POST" && url == HTTP_HOOK_PATH {
        let event: Value = serde_json::from_str(body).unwrap_or(json!({}));

        // Header broken by failed env interpolation → never use the literal.
        let valid_header =
            |v: &str, var: &str| !v.is_empty() && !v.contains('$') && !v.contains(var);
        let session_id = if valid_header(header_session, "PROMPTOPS_SESSION_ID") {
            header_session.to_string()
        } else {
            String::new()
        };
        let workspace = if valid_header(header_workspace, "PROMPTOPS_WORKSPACE") {
            header_workspace.to_string()
        } else {
            event
                .get("cwd")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };

        let payload = json!({
            "type": "claude.hook",
            "sessionId": session_id,
            "workspace": workspace,
            "timestamp": now_iso(),
            "event": event,
        });
        dispatch_hook_event(app, manager, &payload);

        let is_pre_tool_use =
            event.get("hook_event_name").and_then(|v| v.as_str()) == Some("PreToolUse");
        let allow = is_pre_tool_use && manager.auto_approve(&session_id);
        if allow {
            return json_response(&json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "permissionDecisionReason": "Auto-approved by PromptOps",
                }
            }));
        }
        return json_response(&json!({}));
    }

    // ── Sub-agent: spawn / message / relay / broadcast ──────────────
    // All re-emitted as `hook:generic` with a dedicated hookEvent.
    if method == "POST" && url == "/subagent/spawn" {
        let payload: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        emit_generic(
            app,
            str_field(&payload, "sessionId"),
            str_field(&payload, "workspace"),
            "subagent:spawn",
            payload,
        );
        return json_response(&json!({ "ok": true }));
    }
    if method == "POST" && url == "/subagent/message" {
        let payload: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        emit_generic(
            app,
            str_field(&payload, "sessionId"),
            str_field(&payload, "workspace"),
            "subagent:message",
            payload,
        );
        return json_response(&json!({ "ok": true }));
    }
    if method == "POST" && url == "/subagent/relay" {
        let payload: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        // relay: sessionId = payload.from, workspace = ''.
        emit_generic(
            app,
            str_field(&payload, "from"),
            String::new(),
            "subagent:relay",
            payload,
        );
        return json_response(&json!({ "ok": true }));
    }
    if method == "POST" && url == "/subagent/broadcast" {
        let payload: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        emit_generic(
            app,
            str_field(&payload, "sessionId"),
            String::new(),
            "subagent:broadcast",
            payload,
        );
        return json_response(&json!({ "ok": true }));
    }

    not_found()
}

// ── Hook event dispatch (handleHookEvent + registerHookHandlers) ─────

/// Replicates `HookServer.handleHookEvent` *merged* with `registerHookHandlers`:
/// normalizes the payload per event type, forwards it to the renderer as
/// `hook:event`, updates the session status and handles notification/navigation.
fn dispatch_hook_event(app: &AppHandle, manager: &Arc<HookManager>, payload: &Value) {
    let session_id = str_field(payload, "sessionId");
    let workspace = str_field(payload, "workspace");
    let timestamp = str_field(payload, "timestamp");
    let event = payload.get("event").cloned().unwrap_or(Value::Null);
    let event_name = event
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // Model in use announced by the hook (agy `modelName`): applies to
    // sub-agent children too, the badge is per terminal.
    if let Some(model) = event.get("model").and_then(|v| v.as_str()) {
        crate::commands::session_model::record_hook_model(&session_id, model);
    }

    // Child of a sub-agent? Metrics are attributed to the PARENT (sub
    // tool-use/stop feed the main session's tracker).
    let sub_parent = if session_id.is_empty() {
        None
    } else {
        Some(manager.resolve_to_parent(&session_id)).filter(|p| p != &session_id)
    };

    // Metrics wiring (token/optimization/usage): token tracker, file-read
    // cache, provider usage probe. For sub-agent children only tool-use and
    // stop are forwarded (never
    // session-start: it would remap the parent's provider/probe on every spawn).
    match &sub_parent {
        None => wire_metrics(app, event_name, &session_id, None, &event),
        Some(parent) if matches!(event_name, "PreToolUse" | "PostToolUse" | "Stop") => {
            // The sub-agent id is needed by context-pressure: /compact must be
            // written to the agent's PTY, not the main one.
            let sub_agent_id = manager.resolve_sub_agent(&session_id);
            wire_metrics(app, event_name, parent, sub_agent_id.as_deref(), &event)
        }
        Some(_) => {}
    }

    // Sub-agent child sessions (attributed via PROMPTOPS_SESSION_ID):
    // to avoid noise leaks, their hooks do NOT reach the
    // renderer or system notifications. The only effect is attaching
    // the resume key to the view on SessionStart (+ stash refresh).
    if sub_parent.is_some() {
        use tauri::Manager;
        let subs = app
            .state::<Arc<crate::commands::subagent::SubAgentManager>>()
            .inner()
            .clone();
        // Control plane lifecycle + sub-agent state: previously child hooks
        // did not touch the view and an interactive one stayed "running"
        // forever after the first turn.
        crate::commands::agent_ctl::note_hook(&session_id, event_name, &event);
        subs.hook_status(app, &session_id, event_name, &event);
        if event_name == "SessionStart" {
            if let Some(csid) = event.get("session_id").and_then(|v| v.as_str()) {
                if let Some(parent) = subs.set_claude_session_id(&session_id, csid) {
                    crate::commands::subagent::push_stash_snapshot(app, &subs, &parent);
                }
            }
        }
        return;
    }

    // UserPromptSubmit = turn opened: "in_progress" right away, without waiting
    // for the first tool-use (a text-only turn emits none).
    if event_name == "UserPromptSubmit" {
        manager.update_session_status(&session_id, "in_progress");
    }

    match event_name {
        // ── Notification ────────────────────────────────────────────
        "Notification" => {
            let notification_type = event
                .get("notification_type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let title = event
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let message = event
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let resolved = manager.resolve_to_parent(&session_id);
            // `sendToRenderer(HOOK_EVENT, { type:'notification', …, sessionId:resolved })`.
            let _ = app.emit(
                HOOK_EVENT,
                json!({
                    "type": "notification",
                    "sessionId": resolved,
                    "workspace": workspace,
                    "timestamp": timestamp,
                    "message": message,
                    "title": title,
                    "notificationType": notification_type,
                }),
            );

            // permission_prompt / idle_prompt / elicitation_dialog → human input needed.
            if matches!(
                notification_type.as_str(),
                "permission_prompt" | "idle_prompt" | "elicitation_dialog"
            ) {
                // updateStatus on the ORIGINAL session (not the parent).
                manager.update_session_status(&session_id, "waiting_input");

                let session_name = manager.resolve_session_name(&resolved);
                let workspace_name = basename(&workspace);
                let notif_title = if title.is_empty() {
                    format!("{} requires input", agent_label(&event))
                } else {
                    title
                };
                let notif_body = format!("Workspace: {workspace_name}\nSession: {session_name}");
                show_system_notification(app, &notif_title, &notif_body, Some(&resolved));
            }
        }

        // ── Stop (session completed) ──────────────────────────────
        "Stop" => {
            let last_message = event
                .get("last_assistant_message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let resolved = manager.resolve_to_parent(&session_id);
            let _ = app.emit(
                HOOK_EVENT,
                json!({
                    "type": "stop",
                    "sessionId": resolved,
                    "workspace": workspace,
                    "timestamp": timestamp,
                    "lastMessage": last_message,
                }),
            );

            manager.update_session_status(&session_id, "completed");

            let session_name = manager.resolve_session_name(&resolved);
            let workspace_name = basename(&workspace);
            let notif_body = format!("Workspace: {workspace_name}\nSession: {session_name}");
            show_system_notification(
                app,
                &format!("{} has finished", agent_label(&event)),
                &notif_body,
                Some(&resolved),
            );
        }

        // ── Tool use (Pre/PostToolUse) ──────────────────────────────
        "PreToolUse" | "PostToolUse" => {
            let tool_name = event
                .get("tool_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let tool_input = event
                .get("tool_input")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let resolved = manager.resolve_to_parent(&session_id);
            let _ = app.emit(
                HOOK_EVENT,
                json!({
                    "type": "tool-use",
                    "sessionId": resolved,
                    "workspace": workspace,
                    "timestamp": timestamp,
                    "hookEvent": event_name,
                    "toolName": tool_name,
                    "toolInput": tool_input,
                }),
            );
            // Tool use → turn opened → in_progress ("running" is no longer used:
            // it meant both "PTY alive" and "working", so always green).
            manager.update_session_status(&session_id, "in_progress");
        }

        // ── Session start ───────────────────────────────────────────
        "SessionStart" => {
            let claude_session_id = event
                .get("session_id")
                .and_then(|v| v.as_str())
                .map(String::from);
            // No parent resolution: session-start does not resolve it.
            let _ = app.emit(
                HOOK_EVENT,
                json!({
                    "type": "session-start",
                    "sessionId": session_id,
                    "workspace": workspace,
                    "timestamp": timestamp,
                    "claudeSessionId": claude_session_id,
                }),
            );
            // Claude ready at the prompt: alive but idle. The turn is opened by
            // UserPromptSubmit/tool-use and closed by Stop (or PTY silence).
            manager.update_session_status(&session_id, "idle");
            // Capture the id on the main session (if session_id is the child of a
            // sub-agent the SessionManager lookup fails → no-op), then attach the resume key to the sub-agent.
            if let Some(csid) = &claude_session_id {
                manager.set_claude_session_id(&session_id, csid);
            }
            if let Some(csid) = &claude_session_id {
                use tauri::Manager;
                let subs = app
                    .state::<Arc<crate::commands::subagent::SubAgentManager>>()
                    .inner()
                    .clone();
                if let Some(parent) = subs.set_claude_session_id(&session_id, csid) {
                    crate::commands::subagent::push_stash_snapshot(app, &subs, &parent);
                }
            }
        }

        // ── Session end ─────────────────────────────────────────────
        "SessionEnd" => {
            let reason = event
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let _ = app.emit(
                HOOK_EVENT,
                json!({
                    "type": "session-end",
                    "sessionId": session_id,
                    "workspace": workspace,
                    "timestamp": timestamp,
                    "reason": reason,
                }),
            );
        }

        // ── Generic (any other hook) ──────────────────────────
        other => {
            let hook_event = if other.is_empty() { "unknown" } else { other };
            let _ = app.emit(
                HOOK_EVENT,
                json!({
                    "type": "generic",
                    "sessionId": session_id,
                    "workspace": workspace,
                    "timestamp": timestamp,
                    "hookEvent": hook_event,
                    "data": event,
                }),
            );
        }
    }
}

/// Agent name for notifications: gemini/agy events arrive translated
/// by the shim with `promptops_provider`; without it, it is Claude.
fn agent_label(event: &Value) -> &'static str {
    match event.get("promptops_provider").and_then(|v| v.as_str()) {
        Some("gemini-cli") => "Gemini",
        Some("antigravity") => "Antigravity",
        _ => "Claude",
    }
}

/// Wiring of hook events to the metrics managers:
/// - hook:tool-use → TokenTracker.handle_tool_use + FileReadCache (Read)
/// - hook:stop     → ProviderUsageProbe throttled (30s per session)
/// - hook:session-start → provider mapping + probe scheduled at 20s
/// - hook:session-end   → cache/tracker/probe cleanup
fn wire_metrics(
    app: &AppHandle,
    event_name: &str,
    session_id: &str,
    sub_agent_id: Option<&str>,
    event: &Value,
) {
    use std::sync::OnceLock;
    if session_id.is_empty() {
        return;
    }
    let tracker = app
        .state::<Arc<crate::commands::metrics::TokenTracker>>()
        .inner()
        .clone();
    let cache = app
        .state::<Arc<crate::commands::metrics::FileReadCache>>()
        .inner()
        .clone();
    let probe = app
        .state::<Arc<crate::commands::metrics::ProviderUsageProbe>>()
        .inner()
        .clone();

    match event_name {
        "UserPromptSubmit" => {
            tracker.auto_finalize_turn(app, session_id);
            tracker.begin_turn(session_id, event.get("turn_id").and_then(|v| v.as_str()));
        }
        "PreToolUse" | "PostToolUse" => {
            let tool_name = event
                .get("tool_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if tool_name.is_empty() {
                return;
            }
            let tool_input = event.get("tool_input").cloned().unwrap_or(Value::Null);
            // Tailer keep-alive: a tool dispatch = provider at work.
            if let Some(tailer) = crate::commands::session_tailer::global_tailer() {
                tailer.on_hook_event(session_id, true);
            }
            // Only PreToolUse feeds the tracker (avoids double-counting).
            if event_name == "PreToolUse" {
                tracker.handle_tool_use(session_id, &tool_name, &tool_input);
                if tool_name == "Read" {
                    if let Some(file_path) = tool_input.get("file_path").and_then(|v| v.as_str()) {
                        let saved = cache.track_file_read(session_id, file_path);
                        if saved > 0 {
                            tracker.set_cache_flag(app, session_id, saved);
                        }
                    }
                }
            }
        }
        "Stop" => {
            if let Some(tailer) = crate::commands::session_tailer::global_tailer() {
                tailer.on_hook_event(session_id, false);
            }
            // hook:stop → turn closed with the pending data.
            // Real usage from the Claude transcript (incremental read, only
            // new bytes): if present, it replaces the turn's hook estimate.
            if let Some(path) = event
                .get("transcript_path")
                .and_then(|v| v.as_str())
                .filter(|p| !p.is_empty())
            {
                tracker.ingest_claude_transcript(app, session_id, sub_agent_id, path);
            }
            tracker.auto_finalize_turn(app, session_id);
            tracker.end_turn(session_id);
            // Throttled probe: at most one every 30s per session, on a thread
            // (it spawns an ephemeral PTY — never on the hook server thread).
            static LAST_PROBE: OnceLock<Mutex<std::collections::HashMap<String, u64>>> =
                OnceLock::new();
            let last = LAST_PROBE.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            {
                let mut map = last.lock();
                if now.saturating_sub(*map.get(session_id).unwrap_or(&0)) < 30 {
                    return;
                }
                map.insert(session_id.to_string(), now);
            }
            let app = app.clone();
            let sid = session_id.to_string();
            std::thread::spawn(move || {
                let _ = probe.probe(&app, &sid);
            });
        }
        "SessionStart" => {
            if let Some(tailer) = crate::commands::session_tailer::global_tailer() {
                tailer.on_hook_event(session_id, false);
            }
            // Map the session's provider and schedule the first probe at 20s.
            let sessions = app
                .state::<Arc<crate::commands::session::SessionManager>>()
                .inner()
                .clone();
            if let Some(provider) = sessions.provider_of(session_id) {
                probe.set_session_provider(session_id, &provider);
            }
            let app = app.clone();
            let sid = session_id.to_string();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(20));
                let _ = probe.probe(&app, &sid);
            });
        }
        "SessionEnd" => {
            cache.clear_session(session_id);
            tracker.auto_finalize_turn(app, session_id);
            tracker.end_turn(session_id);
            tracker.remove_session(session_id);
            probe.cleanup_session(session_id);
        }
        _ => {}
    }
}

/// Helper for sub-agent endpoints: emits a generic `hook:event`
/// directly, without an intermediate event bus.
fn emit_generic(
    app: &AppHandle,
    session_id: String,
    workspace: String,
    hook_event: &str,
    data: Value,
) {
    let _ = app.emit(
        HOOK_EVENT,
        json!({
            "type": "generic",
            "sessionId": session_id,
            "workspace": workspace,
            "timestamp": now_iso(),
            "hookEvent": hook_event,
            "data": data,
        }),
    );
}

/// `showSystemNotification` — best-effort.
///
/// Foreground guard (focused + visible + not
/// minimized → the user is already looking at the app, no noise), then native
/// notification. Click → window focus + `hook:navigate-session(sessionId)` is
/// handled by `notify_macos` (UserNotifications); on other platforms the
/// plugin does not expose the click and the navigation event is not emitted.
pub(crate) fn show_system_notification(
    app: &AppHandle,
    title: &str,
    body: &str,
    session_id: Option<&str>,
) {
    use tauri::Manager;

    let in_foreground = app
        .get_webview_window("main")
        .map(|w| {
            w.is_focused().unwrap_or(false)
                && w.is_visible().unwrap_or(true)
                && !w.is_minimized().unwrap_or(false)
        })
        .unwrap_or(false);
    if in_foreground {
        return;
    }

    crate::commands::notify::show(app, title, body, session_id);
}

// ── Helpers ──────────────────────────────────────────────────────────

/// First 8 characters of the sessionId (fallback for `resolveSessionName`).
fn fallback_name(session_id: &str) -> String {
    session_id.chars().take(8).collect()
}

/// `path.basename(workspace) || workspace`.
fn basename(workspace: &str) -> String {
    let trimmed = workspace.trim_end_matches(['/', '\\']);
    let base = trimmed.rsplit(['/', '\\']).next().filter(|s| !s.is_empty());
    match base {
        Some(b) => b.to_string(),
        None => workspace.to_string(),
    }
}

fn str_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Extracts a query param from a `/path?a=1&b=2` URL.
fn query_param(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return Some(url_decode(v));
            }
        }
    }
    None
}

/// Minimal percent-decoding (enough for locales like `en-US`).
fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Speech-recognition page (the `route` template).
fn speech_page_html(locale: &str) -> String {
    format!(
        "<!DOCTYPE html><html><head><title>WAITING</title></head><body>
<script>
try {{
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {{ document.title = 'ERROR:not-supported'; }}
  else {{
    var r = new SR();
    r.lang = '{locale}';
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.continuous = false;
    r.onresult = function(e) {{ document.title = 'OK:' + e.results[0][0].transcript; }};
    r.onerror = function(e) {{ document.title = 'ERROR:' + e.error; }};
    r.onend = function() {{ if (document.title === 'WAITING') document.title = 'ERROR:no-speech'; }};
    setTimeout(function() {{ r.start(); }}, 200);
  }}
}} catch(e) {{ document.title = 'ERROR:' + e.message; }}
</script></body></html>"
    )
}

// ── HTTP/1.1 response builders ───────────────────────────────────────

fn http_response(status: &str, content_type: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
        len = body.len()
    )
}

fn json_response(value: &Value) -> String {
    let body = serde_json::to_string(value).unwrap_or_else(|_| "{}".into());
    http_response("200 OK", "application/json", &body)
}

fn bad_request() -> String {
    http_response(
        "400 Bad Request",
        "application/json",
        r#"{"error":"invalid request"}"#,
    )
}

fn not_found() -> String {
    http_response(
        "404 Not Found",
        "application/json",
        r#"{"error":"not found"}"#,
    )
}

/// RFC3339 UTC without extra dependencies (same format as `new Date().toISOString()`).
/// Epoch→civil date conversion with Hinnant's days-from-civil algorithm.
fn now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let millis = dur.subsec_millis();
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil_from_days (Howard Hinnant, domain far wider than needed)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

// ─────────────────────────────────────────────────────────────────────────
// Hook settings — writeHookSettings / cleanupHookSettings
//
// Writes the Claude Code hook configuration to
// `<workspace>/.claude/settings.local.json` before launching the CLI.
// `sessionId` is NOT embedded in the command (with a shared settings file
// the last writer broke per-session attribution); attribution goes
// through the Claude process env (PROMPTOPS_SESSION_ID, set at spawn).
// ─────────────────────────────────────────────────────────────────────────

/// Hook script source, embedded in the binary and materialized in
/// app-data on first use.
const HOOK_SCRIPT_SRC: &str = include_str!("../../resources/claude-notification.js");

/// Detector for a PromptOps hook (legacy/current command format).
fn is_promptops_hook_cmd(cmd: Option<&str>) -> bool {
    match cmd {
        Some(c) => c.contains("claude-notification.js") || c.contains("PROMPTOPS_HOOK_PORT"),
        None => false,
    }
}

/// Entry-level detector: covers both `command` hooks and HTTP (`url`) hooks.
fn is_promptops_hook_entry(h: &Value) -> bool {
    is_promptops_hook_cmd(h.get("command").and_then(|v| v.as_str()))
        || h.get("url")
            .and_then(|v| v.as_str())
            .map(|u| u.contains(HTTP_HOOK_PATH))
            .unwrap_or(false)
}

/// HTTP hooks (`type: "http"`) exist since Claude Code v2.1.63: on Windows
/// they avoid spawning node.exe for every hook (process creation + Defender
/// scan = the dominant source of lag). Windows only and only with a recent
/// enough CLI; macOS/Linux stay on command hooks. Any
/// failure (missing binary, timeout, unparsable output) → false, i.e.
/// safe fallback to command hooks. Cached for the process lifetime.
pub fn claude_supports_http_hooks_on_windows() -> bool {
    if !cfg!(windows) {
        return false;
    }
    static SUPPORTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *SUPPORTED.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        std::thread::spawn(move || {
            let result = crate::commands::util_cmd::cmd("powershell.exe")
                .args(crate::commands::util_cmd::powershell_args(
                    "claude --version",
                ))
                .output()
                .ok()
                .and_then(|out| parse_semver(&String::from_utf8_lossy(&out.stdout)))
                .map(|v| v >= (2, 1, 63))
                .unwrap_or(false);
            let _ = tx.send(result);
        });
        rx.recv_timeout(std::time::Duration::from_secs(4))
            .unwrap_or(false)
    })
}

// ── Hooks for WSL sessions ("PreToolUse:Bash hook error" reported by users) ───
//
// With a `wsl:<distro>` shell Claude runs INSIDE the distro: a command hook with
// a Windows path (`node "C:\…\claude-notification.js"`) never resolves in
// there and the Linux node fails the load on every event → spam
// "PreToolUse:Bash hook error / Failed with non-blocking status code" in the
// terminal. The per-distro plan picks the format that actually works
// in the distro — and when none can work it writes NOTHING
// (features silently degraded, never errors in the console).

/// How to write hooks for a WSL session.
#[derive(Clone)]
pub enum WslHookPlan {
    /// claude >= 2.1.63 in the distro and HookServer reachable: direct HTTP
    /// hooks on `http://<host>:<port>/promptops-hook` (zero node spawns).
    Http { host: String },
    /// Command hook with the shim at the /mnt/c/… path and the list of candidate hosts
    /// via PROMPTOPS_HOOK_HOSTS (the shim fails silently if unreachable).
    Command { script_path: String, hosts: String },
    /// Neither HTTP nor node available: no hooks (+ cleanup of stale ones).
    Skip,
}

/// Hook plan for the distro, computed once and cached for the process
/// lifetime (probes inside WSL cost seconds on a cold distro).
pub fn wsl_hook_plan(app: &AppHandle, distro: &str, hook_port: u16) -> WslHookPlan {
    use std::collections::HashMap;
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, WslHookPlan>>> =
        std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(plan) = cache.lock().get(distro) {
        return plan.clone();
    }
    let plan = compute_wsl_hook_plan(app, distro, hook_port);
    cache.lock().insert(distro.to_string(), plan.clone());
    plan
}

fn compute_wsl_hook_plan(app: &AppHandle, distro: &str, hook_port: u16) -> WslHookPlan {
    let env = crate::commands::windows_shells::probe_wsl_hook_env(distro);
    let host = env.host_candidate;
    // WSL2 NAT: the distro reaches Windows only on the vEthernet IP
    // (= its default gateway) → a listener is needed there too, the default
    // server only listens on 127.0.0.1.
    if host != "127.0.0.1" {
        ensure_extra_listener(app, &host, hook_port);
    }
    let reachable =
        crate::commands::windows_shells::probe_wsl_tcp_reachable(distro, &host, hook_port);
    let http_ok = parse_semver(&env.claude_version_raw)
        .map(|v| v >= (2, 1, 63))
        .unwrap_or(false);
    // HTTP only if reachability is VERIFIED: an http hook that does not
    // connect would pollute the terminal again, the node shim would not.
    if reachable && http_ok {
        return WslHookPlan::Http { host };
    }
    if env.has_node {
        if let Ok(script) = ensure_hook_script() {
            if let Some(wsl_script) =
                crate::commands::windows_shells::windows_to_wsl_path(&script.to_string_lossy())
            {
                let hosts = if host == "127.0.0.1" {
                    host
                } else {
                    format!("{host},127.0.0.1")
                };
                return WslHookPlan::Command {
                    script_path: wsl_script,
                    hosts,
                };
            }
        }
    }
    WslHookPlan::Skip
}

/// Additional HookServer listener on a non-loopback IP (the WSL
/// vEthernet), same port. Idempotent; failed bind = best-effort (the downstream
/// reachability probe will reject the HTTP format anyway).
fn ensure_extra_listener(app: &AppHandle, host: &str, port: u16) {
    use std::collections::HashSet;
    static BOUND: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();
    let key = format!("{host}:{port}");
    {
        let mut bound = BOUND.get_or_init(|| Mutex::new(HashSet::new())).lock();
        if !bound.insert(key.clone()) {
            return;
        }
    }
    match TcpListener::bind((host, port)) {
        Ok(listener) => {
            let manager: Arc<HookManager> = app.state::<Arc<HookManager>>().inner().clone();
            let app = app.clone();
            std::thread::spawn(move || accept_loop(listener, app, manager));
        }
        Err(err) => {
            eprintln!("[HookServer] WSL listener bind {key} failed: {err}");
            BOUND
                .get_or_init(|| Mutex::new(HashSet::new()))
                .lock()
                .remove(&key);
        }
    }
}

/// First `x.y.z` in the string.
fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    for token in s.split(|c: char| !(c.is_ascii_digit() || c == '.')) {
        let nums: Vec<&str> = token.split('.').filter(|p| !p.is_empty()).collect();
        if nums.len() >= 3 {
            if let (Ok(a), Ok(b), Ok(c)) = (nums[0].parse(), nums[1].parse(), nums[2].parse()) {
                return Some((a, b, c));
            }
        }
    }
    None
}

/// Materializes the hook script in `<app-data>/hooks/claude-notification.js`
/// and returns the path. Rewrites only if missing or changed (upgrade).
pub fn ensure_hook_script() -> Result<PathBuf, String> {
    let dir = hook_data_dir().join("hooks");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("claude-notification.js");
    let stale = match std::fs::read_to_string(&path) {
        Ok(existing) => existing != HOOK_SCRIPT_SRC,
        Err(_) => true,
    };
    if stale {
        std::fs::write(&path, HOOK_SCRIPT_SRC).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

/// App-data dir (same path as the one in device.rs).
/// Pub: reused by session.rs for the auto-standby config.
pub fn hook_data_dir() -> PathBuf {
    let base = if cfg!(target_os = "macos") {
        std::env::var("HOME")
            .map(|h| PathBuf::from(h).join("Library/Application Support"))
            .unwrap_or_else(|_| PathBuf::from("."))
    } else if cfg!(target_os = "windows") {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    } else {
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|_| std::env::var("HOME").map(|h| PathBuf::from(h).join(".local/share")))
            .unwrap_or_else(|_| PathBuf::from("."))
    };
    base.join(crate::APP_DIR_NAME)
}

/// The PromptOps entries of a Claude Code `hooks` object, event by event: a
/// command hook through the shim, or an HTTP hook carrying the session
/// headers. One builder for every place that writes them (the repository's
/// settings.local.json and the `--settings` file of session.rs), so they cannot
/// drift. `http_host`: host of the HTTP hook URL (default 127.0.0.1).
/// PreToolUse and Notification are blocking; the rest fire-and-forget.
pub fn claude_hook_events(
    hook_script_path: &str,
    hook_port: u16,
    use_http: bool,
    http_host: Option<&str>,
) -> Value {
    let hook_command = format!("node \"{hook_script_path}\"");
    let host = http_host.unwrap_or("127.0.0.1");
    let make_hook = |is_async: bool| -> Value {
        let mut h = if use_http {
            json!({
                "type": "http",
                "url": format!("http://{host}:{hook_port}{HTTP_HOOK_PATH}"),
                "headers": {
                    "X-PromptOps-Session": "$PROMPTOPS_SESSION_ID",
                    "X-PromptOps-Workspace": "$PROMPTOPS_WORKSPACE",
                    "X-PromptOps-Token": "$PROMPTOPS_CTL_TOKEN",
                },
                "allowedEnvVars": ["PROMPTOPS_SESSION_ID", "PROMPTOPS_WORKSPACE", "PROMPTOPS_CTL_TOKEN"],
                "timeout": 5,
            })
        } else {
            json!({ "type": "command", "command": hook_command, "timeout": 5 })
        };
        if is_async {
            h["async"] = json!(true);
        }
        h
    };
    json!({
        "Notification": [{ "hooks": [make_hook(false)] }],
        "Stop": [{ "hooks": [make_hook(true)] }],
        "PreToolUse": [{ "hooks": [make_hook(false)] }],
        "PostToolUse": [{ "hooks": [make_hook(true)] }],
        "SessionStart": [{ "hooks": [make_hook(true)] }],
        "SessionEnd": [{ "hooks": [make_hook(true)] }],
    })
}

/// writeHookSettings — merges the PromptOps hooks into settings.local.json,
/// preserving existing non-PromptOps hooks.
///
/// `http_host`: host of the HTTP hook URL (default 127.0.0.1). WSL sessions
/// in NAT pass the vEthernet IP — the only one through which the distro reaches
/// the server (see wsl_hook_plan). Ignored for command hooks.
pub fn write_hook_settings(
    workspace_path: &str,
    hook_script_path: &str,
    hook_port: u16,
    use_http_hooks: bool,
    http_host: Option<&str>,
) -> Result<(), String> {
    write_hook_settings_in(
        &config_backups_dir(),
        workspace_path,
        hook_script_path,
        hook_port,
        use_http_hooks,
        http_host,
    )
}

fn write_hook_settings_in(
    backups: &std::path::Path,
    workspace_path: &str,
    hook_script_path: &str,
    hook_port: u16,
    use_http_hooks: bool,
    http_host: Option<&str>,
) -> Result<(), String> {
    let claude_dir = PathBuf::from(workspace_path).join(".claude");
    let settings_path = claude_dir.join("settings.local.json");

    // A file we cannot parse (comments, a half-finished edit, a merge conflict) is
    // the user's, not ours: rewriting it with only our hooks would wipe their
    // permissions and env. Leave it alone; the session runs without hooks.
    let Some(mut settings) = read_json_object(&settings_path) else {
        return Err(format!(
            "{} is not a JSON object: hooks not written",
            settings_path.display()
        ));
    };
    std::fs::create_dir_all(&claude_dir).map_err(|e| e.to_string())?;

    let promptops_hooks =
        claude_hook_events(hook_script_path, hook_port, use_http_hooks, http_host);

    // Merge: keep every existing non-PromptOps entry exactly as it is.
    if settings.get("hooks").is_some_and(|h| !h.is_object()) {
        return Err(format!(
            "{}: \"hooks\" is not an object: hooks not written",
            settings_path.display()
        ));
    }
    let mut merged = settings
        .get("hooks")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    strip_promptops_groups(&mut merged);
    for (event_name, matchers) in promptops_hooks.as_object().unwrap() {
        let entry = merged
            .entry(event_name.clone())
            .or_insert_with(|| Value::Array(vec![]));
        if let (Some(dst), Some(src)) = (entry.as_array_mut(), matchers.as_array()) {
            dst.extend(src.iter().cloned());
        }
    }
    settings["hooks"] = Value::Object(merged);

    let body = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    if std::fs::read_to_string(&settings_path).ok().as_deref() == Some(body.as_str()) {
        return Ok(());
    }
    backup_before_change(backups, &settings_path)?;
    write_atomic(&settings_path, body)
}

/// Where the original bytes of a user config are kept before PromptOps first
/// changes it (app data, never next to the user's file).
pub(crate) fn config_backups_dir() -> PathBuf {
    hook_data_dir().join("config-backups")
}

pub(crate) fn backup_path(backups: &std::path::Path, target: &std::path::Path) -> PathBuf {
    let flat: String = target
        .to_string_lossy()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let tail: String = flat
        .chars()
        .rev()
        .take(180)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    backups.join(format!("{tail}.orig"))
}

/// Copies the user's file as it is now, once: the copy taken before the first
/// change is the one an uninstall compares against.
pub(crate) fn backup_before_change(
    backups: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    let copy = backup_path(backups, target);
    if !target.is_file() || copy.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(backups).map_err(|e| e.to_string())?;
    std::fs::copy(target, &copy)
        .map(|_| ())
        .map_err(|e| format!("backup of {} failed: {e}", target.display()))
}

/// Uninstall step for one file. When what is left equals the original copy, the
/// original BYTES go back (formatting, key order and comments-free layout
/// exactly as the user had them); otherwise the cleaned JSON is written, or the
/// file and the folders we created for it are removed when nothing is left.
fn finish_removal(
    backups: &std::path::Path,
    target: &std::path::Path,
    after: &Value,
    stop: &std::path::Path,
) -> bool {
    let copy = backup_path(backups, target);
    let original = std::fs::read(&copy).ok();
    let _ = std::fs::remove_file(&copy);
    // An empty "hooks" object is how removal leaves a file whose only hooks were
    // ours: it compares equal to an original without one (or with `{}`).
    let canon = |v: &Value| {
        let mut v = v.clone();
        if let Some(o) = v.as_object_mut() {
            if o.get("hooks")
                .is_some_and(|h| h.as_object().is_some_and(|m| m.is_empty()))
            {
                o.remove("hooks");
            }
        }
        v
    };
    if let Some(bytes) = original {
        if serde_json::from_slice::<Value>(&bytes)
            .ok()
            .is_some_and(|orig| canon(&orig) == canon(after))
        {
            return write_atomic(target, &bytes).is_ok();
        }
    }
    write_or_remove(target, after, stop)
}

/// Writes through a temporary file in the same folder and renames it over the
/// target: a crash or a full disk never leaves a user's config half-written.
/// The target's permissions carry over (a 0600 config stays 0600).
pub(crate) fn write_atomic(path: &std::path::Path, body: impl AsRef<[u8]>) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent folder", path.display()))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(
        ".{name}.promptops-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Removes `dir` and then its parents while they are empty, never going above
/// `stop`. Used after uninstalling so folders PromptOps created leave no trace.
fn remove_empty_dirs(dir: &std::path::Path, stop: &std::path::Path) {
    let mut current = Some(dir.to_path_buf());
    while let Some(d) = current {
        if d == stop || !d.starts_with(stop) || std::fs::remove_dir(&d).is_err() {
            return;
        }
        current = d.parent().map(std::path::Path::to_path_buf);
    }
}

/// Drops every hook group that carries a PromptOps hook. Event lists that only
/// held ours disappear; lists the user left empty stay as they were.
fn strip_promptops_groups(hooks: &mut serde_json::Map<String, Value>) -> bool {
    let mut changed = false;
    hooks.retain(|_, defs| {
        let Some(arr) = defs.as_array_mut() else {
            return true;
        };
        let before = arr.len();
        arr.retain(|d| {
            !d.get("hooks")
                .and_then(|v| v.as_array())
                .is_some_and(|hs| hs.iter().any(is_promptops_hook_entry))
        });
        if arr.len() == before {
            return true;
        }
        changed = true;
        !arr.is_empty()
    });
    changed
}

/// cleanupHookSettings — removes the PromptOps hooks from the workspace settings.
/// Called when the workspace's last session is destroyed. Best-effort.
/// Returns true when the file changed. A file without our hooks is never
/// rewritten (no reformatting of the user's file); when ours were the only
/// content, the file goes and so does a `.claude` folder left empty.
pub fn cleanup_hook_settings(workspace_path: &str) -> bool {
    cleanup_hook_settings_in(&config_backups_dir(), workspace_path)
}

fn cleanup_hook_settings_in(backups: &std::path::Path, workspace_path: &str) -> bool {
    let claude_dir = PathBuf::from(workspace_path).join(".claude");
    let settings_path = claude_dir.join("settings.local.json");
    let Ok(raw) = std::fs::read_to_string(&settings_path) else {
        return false;
    };
    let Ok(mut settings) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    let Some(mut hooks) = settings.get("hooks").and_then(|v| v.as_object()).cloned() else {
        return false;
    };
    if !strip_promptops_groups(&mut hooks) {
        return false;
    }
    if hooks.is_empty() {
        settings.as_object_mut().map(|o| o.remove("hooks"));
    } else {
        settings["hooks"] = Value::Object(hooks);
    }

    finish_removal(
        backups,
        &settings_path,
        &settings,
        std::path::Path::new(workspace_path),
    );
    true
}

// ── Native hooks for Gemini CLI and Antigravity (agy) ─────────────────────
//
// Neither CLI has an unversioned "local" file like
// `.claude/settings.local.json`: writing into the project would dirty the repo.
// So the hooks go into the GLOBAL config, once, and the shim is a no-op
// outside PromptOps (`PROMPTOPS_HOOK_PORT`/`PROMPTOPS_HOOK_PROVIDER` missing
// or for another provider). Same approach as other tools (herdr, bridgespace).

/// Shim flavor (`--provider <x>`) for providers with native hooks.
/// It is also the value of `PROMPTOPS_HOOK_PROVIDER` in the session env.
pub fn native_hook_flavor(provider: &str) -> Option<&'static str> {
    match provider {
        "gemini-cli" => Some("gemini"),
        "antigravity" => Some("agy"),
        _ => None,
    }
}

fn user_home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Existing JSON config: missing → empty object; unreadable or non-object
/// → None (never overwrite a user file we cannot read).
fn read_json_object(path: &std::path::Path) -> Option<Value> {
    match std::fs::read_to_string(path) {
        Ok(raw) if raw.trim().is_empty() => Some(json!({})),
        Ok(raw) => serde_json::from_str::<Value>(&raw)
            .ok()
            .filter(|v| v.is_object()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(json!({})),
        Err(_) => None,
    }
}

fn write_json_if_changed(
    backups: &std::path::Path,
    path: &std::path::Path,
    before: &Value,
    after: &Value,
) -> Result<(), String> {
    if before == after {
        return Ok(());
    }
    backup_before_change(backups, path)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let pretty = serde_json::to_string_pretty(after).map_err(|e| e.to_string())?;
    write_atomic(path, pretty)
}

fn provider_hook_command(script: &str, flavor: &str, event: &str) -> String {
    format!("node \"{script}\" --provider {flavor} --event {event}")
}

/// Gemini CLI: `hooks` in `<home>/.gemini/settings.json` (home = GEMINI_CLI_HOME
/// if the account sets it). Group format `{matcher?, hooks:[…]}`,
/// timeout in ms. Non-PromptOps hooks are left intact.
fn gemini_hooks_merged(mut settings: Value, script: &str) -> Value {
    // BeforeTool/Notification block the CLI until the shim responds: tight
    // timeout. The rest is fast anyway (local POST).
    const EVENTS: &[&str] = &[
        "SessionStart",
        "SessionEnd",
        "BeforeAgent",
        "AfterAgent",
        "BeforeTool",
        "AfterTool",
        "Notification",
    ];
    let mut hooks = settings
        .get("hooks")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    // Drop our previous definitions, wherever they are.
    strip_promptops_groups(&mut hooks);
    for event in EVENTS {
        let def = json!({
            "hooks": [{
                "type": "command",
                "name": "promptops",
                "command": provider_hook_command(script, "gemini", event),
                "timeout": 5000,
            }]
        });
        let entry = hooks
            .entry((*event).to_string())
            .or_insert_with(|| json!([]));
        match entry.as_array_mut() {
            Some(arr) => arr.push(def),
            None => *entry = json!([def]),
        }
    }
    settings["hooks"] = Value::Object(hooks);
    settings
}

/// Antigravity CLI: `~/.gemini/config/hooks.json`, hook-name → events map.
/// We own the `promptops` key entirely; timeout in seconds.
/// Pre/PostToolUse want groups with matchers, the others the direct list.
fn agy_hooks_merged(mut config: Value, script: &str) -> Value {
    let handler = |event: &str| json!({ "type": "command", "command": provider_hook_command(script, "agy", event), "timeout": 5 });
    config["promptops"] = json!({
        "enabled": true,
        "SessionStart": [handler("SessionStart")],
        "PreToolUse": [{ "matcher": "*", "hooks": [handler("PreToolUse")] }],
        "PostToolUse": [{ "matcher": "*", "hooks": [handler("PostToolUse")] }],
        "Stop": [handler("Stop")],
    });
    config
}

/// Installs (idempotently) the PromptOps hooks in the CLI's global config.
/// `gemini_home`: the account's GEMINI_CLI_HOME, if present.
pub fn ensure_provider_hooks(provider: &str, gemini_home: Option<&str>) -> Result<(), String> {
    let Some(flavor) = native_hook_flavor(provider) else {
        return Ok(());
    };
    let script = ensure_hook_script()?;
    install_provider_hooks_at(
        &config_backups_dir(),
        flavor,
        &user_home(),
        gemini_home.map(std::path::Path::new),
        &script.to_string_lossy(),
    )
}

fn install_provider_hooks_at(
    backups: &std::path::Path,
    flavor: &str,
    home: &std::path::Path,
    gemini_home: Option<&std::path::Path>,
    script: &str,
) -> Result<(), String> {
    match flavor {
        "gemini" => {
            let path = gemini_home
                .unwrap_or(home)
                .join(".gemini")
                .join("settings.json");
            let before =
                read_json_object(&path).ok_or("gemini settings.json unreadable — hooks skipped")?;
            let after = gemini_hooks_merged(before.clone(), script);
            write_json_if_changed(backups, &path, &before, &after)
        }
        _ => {
            let path = home.join(".gemini").join("config").join("hooks.json");
            let before =
                read_json_object(&path).ok_or("agy hooks.json unreadable — hooks skipped")?;
            let after = agy_hooks_merged(before.clone(), script);
            write_json_if_changed(backups, &path, &before, &after)
        }
    }
}

/// Gemini `settings.json` without our hook groups. `None` = nothing of ours in it.
fn gemini_hooks_removed(mut settings: Value) -> Option<Value> {
    let mut hooks = settings.get("hooks")?.as_object()?.clone();
    if !strip_promptops_groups(&mut hooks) {
        return None;
    }
    if hooks.is_empty() {
        settings.as_object_mut()?.remove("hooks");
    } else {
        settings["hooks"] = Value::Object(hooks);
    }
    Some(settings)
}

/// agy `hooks.json` without our `promptops` key. `None` = not installed.
fn agy_hooks_removed(mut config: Value) -> Option<Value> {
    config.as_object_mut()?.remove("promptops")?;
    Some(config)
}

/// Writes `after` back, or deletes the file (and the folders we created for it,
/// up to `home`) when nothing else is left in it.
fn write_or_remove(path: &std::path::Path, after: &Value, home: &std::path::Path) -> bool {
    if after.as_object().is_some_and(|o| o.is_empty()) {
        if std::fs::remove_file(path).is_err() {
            return false;
        }
        if let Some(dir) = path.parent() {
            remove_empty_dirs(dir, home);
        }
        return true;
    }
    serde_json::to_string_pretty(after)
        .ok()
        .is_some_and(|pretty| write_atomic(path, pretty).is_ok())
}

/// Removes the PromptOps hooks from the global Gemini CLI / Antigravity configs:
/// the user's home plus every Gemini account home in `gemini_homes`. Only files
/// that carry our hooks are touched. Returns the files that changed.
pub fn uninstall_provider_hooks(gemini_homes: &[PathBuf]) -> Vec<PathBuf> {
    uninstall_provider_hooks_at(&config_backups_dir(), &user_home(), gemini_homes)
}

fn uninstall_provider_hooks_at(
    backups: &std::path::Path,
    home: &std::path::Path,
    gemini_homes: &[PathBuf],
) -> Vec<PathBuf> {
    let home = home.to_path_buf();
    let mut changed = Vec::new();
    let mut homes = vec![home.clone()];
    for h in gemini_homes {
        if !homes.contains(h) {
            homes.push(h.clone());
        }
    }
    for gemini_home in &homes {
        let path = gemini_home.join(".gemini").join("settings.json");
        if let Some(after) = read_json_object(&path).and_then(gemini_hooks_removed) {
            if finish_removal(backups, &path, &after, gemini_home) {
                changed.push(path);
            }
        }
    }
    let agy = home.join(".gemini").join("config").join("hooks.json");
    if let Some(after) = read_json_object(&agy).and_then(agy_hooks_removed) {
        if finish_removal(backups, &agy, &after, &home) {
            changed.push(agy);
        }
    }
    changed
}

/// hook:uninstall-integrations — what "System cleanup" calls to take PromptOps
/// out of the user's tools: our hooks in each workspace's
/// `.claude/settings.local.json`, in the Gemini CLI / Antigravity configs and
/// in the app's `--settings` hooks file, plus the project trust entries added
/// to ~/.claude.json and ~/.codex/config.toml. Everything else in those files
/// is left as it was.
#[tauri::command]
pub fn hook_uninstall_integrations(workspace_paths: Option<Vec<String>>) -> Value {
    let mut changed: Vec<String> = Vec::new();
    for workspace in workspace_paths.unwrap_or_default() {
        if !workspace.trim().is_empty() && cleanup_hook_settings(&workspace) {
            changed.push(
                PathBuf::from(&workspace)
                    .join(".claude")
                    .join("settings.local.json")
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    let gemini_homes: Vec<PathBuf> =
        crate::commands::provider_account::config_dirs_for("gemini-cli")
            .into_iter()
            .map(PathBuf::from)
            .collect();
    changed.extend(
        uninstall_provider_hooks(&gemini_homes)
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned()),
    );
    // The hooks file every claude launch line points at (`--settings`).
    let process_hooks = crate::commands::session::process_hook_settings_path();
    if std::fs::remove_file(&process_hooks).is_ok() {
        changed.push(process_hooks.to_string_lossy().into_owned());
    }
    // Trust entries the Browser page and Plugin Studio added for their folders.
    changed.extend(
        crate::commands::browser::untrust_projects()
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned()),
    );
    json!({ "ok": true, "changed": changed })
}

/// Env the shim needs to report the events of a
/// gemini/agy session, after installing the hooks. Empty = no hooks (server
/// off, provider without native hooks, or unreadable config).
pub fn provider_hook_env(provider: &str, gemini_home: Option<&str>) -> Vec<(String, String)> {
    let port = global_port();
    let Some(flavor) = native_hook_flavor(provider).filter(|_| port != 0) else {
        return Vec::new();
    };
    if let Err(err) = ensure_provider_hooks(provider, gemini_home) {
        eprintln!("[hooks] {provider}: {err}");
        return Vec::new();
    }
    vec![
        ("PROMPTOPS_HOOK_PORT".into(), port.to_string()),
        ("PROMPTOPS_HOOK_PROVIDER".into(), flavor.into()),
        (
            crate::commands::agent_ctl::TOKEN_ENV.into(),
            crate::commands::agent_ctl::token().into(),
        ),
    ]
}

/// hook:write-settings — exposed command (also used by the native spawn).
#[tauri::command]
pub fn hook_write_settings(
    manager: tauri::State<'_, Arc<HookManager>>,
    workspace_path: String,
    use_http_hooks: Option<bool>,
) -> Result<(), String> {
    let script = ensure_hook_script()?;
    write_hook_settings(
        &workspace_path,
        &script.to_string_lossy(),
        manager.port(),
        use_http_hooks.unwrap_or(false),
        None,
    )
}

/// hook:cleanup-settings — exposed command.
#[tauri::command]
pub fn hook_cleanup_settings(workspace_path: String) {
    cleanup_hook_settings(&workspace_path);
}

#[cfg(test)]
mod server_gate_tests {
    use super::*;

    fn head(raw: &str) -> Option<RequestHead> {
        read_head(
            &mut std::io::Cursor::new(raw.as_bytes()),
            Instant::now() + Duration::from_secs(5),
        )
    }

    fn request(
        method: &str,
        url: &str,
        host: &str,
        has_origin: bool,
        content_length: usize,
    ) -> RequestHead {
        RequestHead {
            method: method.into(),
            url: url.into(),
            host: host.into(),
            has_origin,
            content_length,
            ..RequestHead::default()
        }
    }

    fn code(result: Result<usize, (&'static str, &'static str, &'static str)>) -> &'static str {
        result.unwrap_err().1
    }

    /// The ctl.json file token opens `/ctl/*` only; hook events and
    /// `/subagent/*` need the terminal token.
    #[test]
    fn file_token_is_accepted_only_for_ctl_routes() {
        let with = |method: &str, url: &str, token: &str| RequestHead {
            token: token.into(),
            ..request(method, url, "127.0.0.1:5000", false, 10)
        };
        let terminal = crate::commands::agent_ctl::token().to_string();
        let file = crate::commands::agent_ctl::file_token().to_string();
        assert!(request_token_ok(&with(
            "POST",
            "/ctl/agent/list",
            &terminal
        )));
        assert!(request_token_ok(&with("POST", "/ctl/agent/list", &file)));
        for url in [
            "/hook",
            HTTP_HOOK_PATH,
            "/subagent/spawn",
            "/subagent/relay",
        ] {
            assert!(request_token_ok(&with("POST", url, &terminal)), "{url}");
            assert!(!request_token_ok(&with("POST", url, &file)), "{url}");
            assert!(!request_token_ok(&with("POST", url, "nope")), "{url}");
        }
    }

    #[test]
    fn hook_events_builder_is_shared_and_complete() {
        let v = claude_hook_events("/app data/hooks/shim.js", 4242, false, None);
        for event in [
            "Notification",
            "Stop",
            "PreToolUse",
            "PostToolUse",
            "SessionStart",
            "SessionEnd",
        ] {
            assert!(v[event][0]["hooks"][0].is_object(), "{event}");
        }
        assert_eq!(
            v["PreToolUse"][0]["hooks"][0]["command"],
            "node \"/app data/hooks/shim.js\""
        );
        assert_eq!(v["Stop"][0]["hooks"][0]["async"], true);
        let http = claude_hook_events("", 4242, true, Some("172.20.0.1"));
        assert_eq!(
            http["Notification"][0]["hooks"][0]["url"],
            format!("http://172.20.0.1:4242{HTTP_HOOK_PATH}")
        );
    }

    #[test]
    fn request_head_is_bounded_and_strict() {
        let parsed = head("POST /ctl/agent/list HTTP/1.1\r\nHost: 127.0.0.1:5000\r\ncontent-length: 12\r\nX-PromptOps-Token: abc\r\nOrigin: https://evil.example\r\n\r\n").unwrap();
        assert_eq!(
            (
                parsed.method.as_str(),
                parsed.url.as_str(),
                parsed.content_length,
                parsed.token.as_str(),
                parsed.host.as_str(),
                parsed.has_origin
            ),
            ("POST", "/ctl/agent/list", 12, "abc", "127.0.0.1:5000", true)
        );
        let hook = head("POST /promptops-hook HTTP/1.1\r\nX-PromptOps-Session: s-1\r\nX-PromptOps-Workspace: /w x\r\n\r\n").unwrap();
        assert_eq!(
            (
                hook.session.as_str(),
                hook.workspace.as_str(),
                hook.content_length,
                hook.has_origin
            ),
            ("s-1", "/w x", 0, false)
        );
        assert!(head("POST /hook HTTP/1.1\r\nContent-Length: lots\r\n\r\n").is_none());
        assert!(head("POST /hook HTTP/1.1\r\nContent-Length: -1\r\n\r\n").is_none());
        assert!(head("POST /hook HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n").is_none());
        assert!(
            head("POST /hook HTTP/1.1\r\nHost: x").is_none(),
            "header without terminator"
        );
        assert!(head("POST /hook HTTP/1.1\r\nno colon here\r\n\r\n").is_none());
        assert!(head("garbage\r\n\r\n").is_none());
        assert!(head("").is_none());
        assert!(
            head(&format!("GET /{} HTTP/1.1\r\n\r\n", "a".repeat(9000))).is_none(),
            "line too long"
        );
        assert!(
            head(&format!(
                "GET / HTTP/1.1\r\n{}\r\n",
                "X-A: b\r\n".repeat(MAX_HEADERS + 1)
            ))
            .is_none(),
            "too many headers"
        );
        assert!(head(&format!(
            "GET / HTTP/1.1\r\n{}\r\n",
            "X-A: b\r\n".repeat(MAX_HEADERS)
        ))
        .is_some());
    }

    #[test]
    fn gate_blocks_browsers_rebinding_and_missing_tokens_before_the_body() {
        // Legit hooks: the app's token, no Origin, loopback or missing Host.
        assert_eq!(
            gate(&request("POST", "/hook", "127.0.0.1:5000", false, 10), true),
            Ok(MAX_BODY_BYTES)
        );
        assert_eq!(
            gate(&request("POST", "/promptops-hook", "", false, 10), true),
            Ok(MAX_BODY_BYTES)
        );
        // Hook events without the token: any local process could fake agent state.
        assert_eq!(
            code(gate(
                &request("POST", "/hook", "127.0.0.1:5000", false, 10),
                false
            )),
            "unauthorized"
        );
        assert_eq!(
            code(gate(
                &request("POST", "/promptops-hook", "", false, 10),
                false
            )),
            "unauthorized"
        );
        assert_eq!(
            gate(
                &request("GET", "/speech?lang=it-IT", "127.0.0.1:5000", true, 0),
                false
            ),
            Ok(MAX_BODY_BYTES)
        );
        // Web page: POST to loopback, or DNS rebinding.
        assert_eq!(
            code(gate(
                &request("POST", "/hook", "127.0.0.1:5000", true, 10),
                false
            )),
            "forbidden_origin"
        );
        assert_eq!(
            code(gate(
                &request("POST", "/hook", "evil.example:5000", false, 10),
                false
            )),
            "forbidden_host"
        );
        assert_eq!(
            code(gate(
                &request("GET", "/speech", "evil.example", false, 0),
                false
            )),
            "forbidden_host"
        );
        // Control plane and sub-agent routes: token always, browser never.
        assert_eq!(
            code(gate(
                &request("POST", "/ctl/agent/spawn", "127.0.0.1:5000", false, 10),
                false
            )),
            "unauthorized"
        );
        assert_eq!(
            code(gate(
                &request("POST", "/subagent/relay", "127.0.0.1:5000", false, 10),
                false
            )),
            "unauthorized"
        );
        assert_eq!(
            code(gate(
                &request("POST", "/subagent/spawn", "", false, 10),
                false
            )),
            "unauthorized"
        );
        assert_eq!(
            gate(
                &request("POST", "/ctl/agent/spawn", "127.0.0.1:5000", false, 10),
                true
            ),
            Ok(MAX_CTL_BODY_BYTES)
        );
        assert_eq!(
            code(gate(
                &request("POST", "/ctl/agent/spawn", "127.0.0.1:5000", true, 10),
                true
            )),
            "forbidden_origin"
        );
        assert_eq!(
            code(gate(
                &request("POST", "/subagent/relay", "127.0.0.1:5000", true, 10),
                true
            )),
            "forbidden_origin"
        );
        // Declared size above the cap: rejected without reading anything.
        assert_eq!(
            code(gate(
                &request(
                    "POST",
                    "/ctl/agent/prompt",
                    "",
                    false,
                    MAX_CTL_BODY_BYTES + 1
                ),
                true
            )),
            "payload_too_large"
        );
        assert_eq!(
            code(gate(
                &request("POST", "/hook", "", false, MAX_BODY_BYTES + 1),
                true
            )),
            "payload_too_large"
        );
        assert_eq!(
            gate(&request("POST", "/hook", "", false, MAX_BODY_BYTES), true),
            Ok(MAX_BODY_BYTES)
        );
    }

    #[test]
    fn host_must_be_localhost_or_an_ip_literal() {
        for ok in [
            "",
            "127.0.0.1:5000",
            "127.0.0.1",
            "localhost:5000",
            "LOCALHOST",
            "[::1]:5000",
            "172.20.0.1:5000",
        ] {
            assert!(host_is_local(ok), "{ok}");
        }
        for bad in [
            "evil.example:5000",
            "evil.example",
            "127.0.0.1.evil.example",
            "localhost.evil.example:80",
            "a:b",
            "127.0.0.1:",
        ] {
            assert!(!host_is_local(bad), "{bad}");
        }
    }

    #[test]
    fn body_is_read_up_to_the_declared_length_or_not_at_all() {
        let deadline = Instant::now() + Duration::from_secs(5);
        assert_eq!(
            read_body(
                &mut std::io::Cursor::new(b"hello world".as_slice()),
                5,
                deadline
            )
            .as_deref(),
            Some("hello")
        );
        assert_eq!(
            read_body(&mut std::io::Cursor::new(b"".as_slice()), 0, deadline).as_deref(),
            Some("")
        );
        assert_eq!(
            read_body(&mut std::io::Cursor::new(b"hi".as_slice()), 3, deadline),
            None,
            "body shorter than declared"
        );
        let expired = Instant::now() - Duration::from_secs(1);
        assert_eq!(
            read_body(&mut std::io::Cursor::new(b"hello".as_slice()), 5, expired),
            None
        );
        let big = vec![b'x'; 100_000];
        assert_eq!(
            read_body(&mut std::io::Cursor::new(big.as_slice()), 100_000, deadline)
                .map(|b| b.len()),
            Some(100_000)
        );
    }

    #[test]
    fn slots_cap_concurrency_and_are_released_on_drop() {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let first = Slot::take(&COUNTER, 2).unwrap();
        let second = Slot::take(&COUNTER, 2).unwrap();
        assert!(Slot::take(&COUNTER, 2).is_none());
        assert_eq!(COUNTER.load(Ordering::Acquire), 2);
        drop(first);
        assert!(Slot::take(&COUNTER, 2).is_some());
        drop(second);
        assert_eq!(COUNTER.load(Ordering::Acquire), 0);
    }

    /// A real server on loopback that only does `receive` and replies 200 if the
    /// request passes: the clients below speak raw HTTP over the socket.
    fn exchange(request: &[u8], half_close: bool) -> (String, Option<(String, String)>, Duration) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let started = Instant::now();
            let outcome = receive(&stream);
            let elapsed = started.elapsed();
            let accepted = match outcome {
                Ok((head, body)) => {
                    respond(&mut stream, &json_response(&json!({ "ok": true })));
                    Some((head.url, body))
                }
                Err(response) => {
                    respond(&mut stream, &response);
                    None
                }
            };
            (accepted, elapsed)
        });
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client.write_all(request).unwrap();
        if half_close {
            client.shutdown(std::net::Shutdown::Write).unwrap();
        }
        let mut response = String::new();
        let _ = client.read_to_string(&mut response);
        let (accepted, elapsed) = server.join().unwrap();
        (response, accepted, elapsed)
    }

    #[test]
    fn over_a_real_socket_hooks_and_the_control_plane_need_the_token_before_any_body() {
        let token = crate::commands::agent_ctl::token();
        let hook = format!("POST /hook HTTP/1.1\r\nHost: 127.0.0.1:1\r\nX-PromptOps-Token: {token}\r\nContent-Length: 7\r\n\r\n{{\"a\":1}}");
        let (response, accepted, _) = exchange(hook.as_bytes(), false);
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert_eq!(
            accepted,
            Some(("/hook".to_string(), "{\"a\":1}".to_string()))
        );
        let (response, accepted, _) = exchange(
            b"POST /hook HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Length: 7\r\n\r\n{\"a\":1}",
            false,
        );
        assert!(response.starts_with("HTTP/1.1 401"), "{response}");
        assert_eq!(accepted, None);

        let authed = format!("POST /ctl/agent/list HTTP/1.1\r\nHost: 127.0.0.1:1\r\nX-PromptOps-Token: {token}\r\nContent-Length: 2\r\n\r\n{{}}");
        let (response, accepted, _) = exchange(authed.as_bytes(), false);
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert_eq!(
            accepted,
            Some(("/ctl/agent/list".to_string(), "{}".to_string()))
        );

        // Wrong token and a body announced but NEVER sent: the 401 arrives
        // immediately, without waiting for (or allocating) that body.
        let (response, accepted, elapsed) = exchange(b"POST /ctl/agent/spawn HTTP/1.1\r\nHost: 127.0.0.1:1\r\nX-PromptOps-Token: nope\r\nContent-Length: 400000\r\n\r\n", false);
        assert!(
            response.starts_with("HTTP/1.1 401 Unauthorized"),
            "{response}"
        );
        assert!(accepted.is_none());
        assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");

        // Even with the right token: no requests originating in a browser.
        let from_page = format!("POST /ctl/agent/spawn HTTP/1.1\r\nHost: 127.0.0.1:1\r\nOrigin: https://evil.example\r\nX-PromptOps-Token: {token}\r\nContent-Length: 2\r\n\r\n{{}}");
        assert!(exchange(from_page.as_bytes(), false)
            .0
            .starts_with("HTTP/1.1 403 Forbidden"));
        let (response, accepted, _) = exchange(b"POST /hook HTTP/1.1\r\nHost: 127.0.0.1:1\r\nOrigin: https://evil.example\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\n{}", false);
        assert!(response.starts_with("HTTP/1.1 403 Forbidden"), "{response}");
        assert!(accepted.is_none());
        assert!(exchange(
            b"POST /hook HTTP/1.1\r\nHost: rebind.evil.example:1\r\nContent-Length: 2\r\n\r\n{}",
            false
        )
        .0
        .starts_with("HTTP/1.1 403 Forbidden"));
        assert!(exchange(
            b"POST /subagent/relay HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Length: 2\r\n\r\n{}",
            false
        )
        .0
        .starts_with("HTTP/1.1 401 Unauthorized"));
        // Connection closed mid-body: 400, never a truncated request.
        let cut = format!("POST /hook HTTP/1.1\r\nX-PromptOps-Token: {token}\r\nContent-Length: 50\r\n\r\n{{\"a\":");
        assert!(exchange(cut.as_bytes(), true)
            .0
            .starts_with("HTTP/1.1 400 Bad Request"));
    }

    #[test]
    fn a_silent_client_is_dropped_by_the_read_timeout() {
        // Headers never terminated and connection held open (slowloris).
        let (response, accepted, elapsed) =
            exchange(b"POST /hook HTTP/1.1\r\nHost: 127.0.0.1:1\r\n", false);
        assert!(
            response.starts_with("HTTP/1.1 400 Bad Request"),
            "{response}"
        );
        assert!(accepted.is_none());
        assert!(
            elapsed >= IO_TIMEOUT - Duration::from_millis(200)
                && elapsed < IO_TIMEOUT + Duration::from_secs(3),
            "{elapsed:?}"
        );
    }

    #[test]
    fn rejections_use_the_control_plane_error_shape() {
        let response = reject(
            "401 Unauthorized",
            "unauthorized",
            "missing or invalid control token",
        );
        assert!(response.starts_with("HTTP/1.1 401 Unauthorized\r\n"));
        let body: Value = serde_json::from_str(response.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"]["code"], "unauthorized");
    }

    #[test]
    fn gemini_hooks_merge_keeps_foreign_hooks_and_is_idempotent() {
        let foreign = json!({ "type": "command", "command": "node other.cjs --event stop" });
        let settings = json!({
            "security": { "auth": { "selectedType": "oauth-personal" } },
            "hooks": { "AfterAgent": [{ "hooks": [foreign.clone()] }], "enabled": true },
        });
        let once = gemini_hooks_merged(settings, "/x/claude-notification.js");
        let twice = gemini_hooks_merged(once.clone(), "/x/claude-notification.js");
        assert_eq!(once, twice);
        assert_eq!(once["security"]["auth"]["selectedType"], "oauth-personal");
        assert_eq!(once["hooks"]["enabled"], true);
        let after_agent = once["hooks"]["AfterAgent"].as_array().unwrap();
        assert_eq!(after_agent.len(), 2);
        assert_eq!(after_agent[0]["hooks"][0], foreign);
        assert_eq!(
            after_agent[1]["hooks"][0]["command"],
            "node \"/x/claude-notification.js\" --provider gemini --event AfterAgent"
        );
        // Script moved → the old definition disappears, no duplicates.
        let moved = gemini_hooks_merged(once, "/y/claude-notification.js");
        assert_eq!(moved["hooks"]["BeforeTool"].as_array().unwrap().len(), 1);
        assert_eq!(moved["hooks"]["AfterAgent"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn agy_hooks_merge_owns_only_its_key() {
        let config =
            json!({ "herdr": { "PreInvocation": [{ "type": "command", "command": "x" }] } });
        let merged = agy_hooks_merged(config.clone(), "/x/claude-notification.js");
        assert_eq!(merged["herdr"], config["herdr"]);
        assert_eq!(merged["promptops"]["PreToolUse"][0]["matcher"], "*");
        assert_eq!(
            merged["promptops"]["Stop"][0]["command"],
            "node \"/x/claude-notification.js\" --provider agy --event Stop"
        );
        assert_eq!(
            agy_hooks_merged(merged.clone(), "/x/claude-notification.js"),
            merged
        );
    }
}

#[cfg(test)]
mod home_side_effect_tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::Path;

    /// Every file (bytes) and folder under `root`, except the app-data backups.
    fn snapshot(root: &Path, skip: &Path) -> BTreeMap<String, Option<Vec<u8>>> {
        let mut out = BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                if path.starts_with(skip) {
                    continue;
                }
                // Same keys on every OS: Windows paths use backslashes.
                let key = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if path.is_dir() {
                    out.insert(key, None);
                    stack.push(path);
                } else {
                    out.insert(key, Some(std::fs::read(&path).unwrap()));
                }
            }
        }
        out
    }

    const SCRIPT: &str = "/app-data/hooks/claude-notification.js";

    /// Checkpoint 4: install + use + uninstall leaves the user's files byte for
    /// byte as they were — user hooks, key order and formatting included — and
    /// a file PromptOps cannot parse is never touched.
    #[test]
    fn install_then_uninstall_leaves_the_home_identical() {
        let root =
            std::env::temp_dir().join(format!("po-home-diff-{}", uuid::Uuid::new_v4().simple()));
        let home = root.join("home");
        let backups = root.join("app-data").join("config-backups");
        let repo = home.join("code").join("repo");
        let fresh = home.join("code").join("fresh");
        let jsonc = home.join("code").join("jsonc");
        for d in [&repo, &fresh, &jsonc] {
            std::fs::create_dir_all(d.join(".git")).unwrap();
        }
        std::fs::create_dir_all(home.join(".gemini")).unwrap();
        std::fs::create_dir_all(repo.join(".claude")).unwrap();
        std::fs::create_dir_all(jsonc.join(".claude")).unwrap();
        // Unsorted keys and 4-space indentation: a rewrite would show in the diff.
        std::fs::write(
            home.join(".gemini/settings.json"),
            "{\n    \"security\": {\"auth\": {\"selectedType\": \"oauth-personal\"}},\n    \"hooks\": {\n        \"AfterAgent\": [{\"hooks\": [{\"type\": \"command\", \"command\": \"notify-send done\"}]}],\n        \"BeforeModel\": []\n    },\n    \"model\": {\"name\": \"gemini-3\"}\n}\n",
        )
        .unwrap();
        std::fs::write(
            repo.join(".claude/settings.local.json"),
            "{\"permissions\":{\"allow\":[\"Bash(npm test)\"]},\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"./guard.sh\"}]}]},\"env\":{\"A\":\"1\"}}",
        )
        .unwrap();
        let jsonc_body = "{\n  // my notes\n  \"permissions\": {}\n}\n";
        std::fs::write(jsonc.join(".claude/settings.local.json"), jsonc_body).unwrap();
        std::fs::write(repo.join("README.md"), "hi").unwrap();
        let before = snapshot(&home, &root.join("app-data"));

        // Install twice (every spawn reinstalls) for every kind of file.
        for _ in 0..2 {
            for ws in [&repo, &fresh] {
                write_hook_settings_in(&backups, &ws.to_string_lossy(), SCRIPT, 4242, false, None)
                    .unwrap();
            }
            let err = write_hook_settings_in(
                &backups,
                &jsonc.to_string_lossy(),
                SCRIPT,
                4242,
                false,
                None,
            );
            assert!(err.is_err(), "an unparsable user file must be refused");
            install_provider_hooks_at(&backups, "gemini", &home, None, SCRIPT).unwrap();
            install_provider_hooks_at(&backups, "agy", &home, None, SCRIPT).unwrap();
        }
        let installed = snapshot(&home, &root.join("app-data"));
        let repo_settings: Value = serde_json::from_slice(
            installed["code/repo/.claude/settings.local.json"]
                .as_ref()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            repo_settings["hooks"]["PreToolUse"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(repo_settings["permissions"]["allow"][0], "Bash(npm test)");
        assert_eq!(
            installed["code/jsonc/.claude/settings.local.json"].as_deref(),
            Some(jsonc_body.as_bytes())
        );
        let gemini: Value =
            serde_json::from_slice(installed[".gemini/settings.json"].as_ref().unwrap()).unwrap();
        assert_eq!(gemini["hooks"]["AfterAgent"].as_array().unwrap().len(), 2);
        assert!(installed.contains_key(".gemini/config/hooks.json"));
        assert!(installed.contains_key("code/fresh/.claude/settings.local.json"));

        // Uninstall ("System cleanup").
        for ws in [&repo, &fresh, &jsonc] {
            cleanup_hook_settings_in(&backups, &ws.to_string_lossy());
        }
        let changed = uninstall_provider_hooks_at(&backups, &home, &[]);
        assert_eq!(changed.len(), 2, "{changed:?}");
        let after = snapshot(&home, &root.join("app-data"));
        let diff: Vec<&String> = before
            .keys()
            .chain(after.keys())
            .filter(|k| before.get(*k) != after.get(*k))
            .collect();
        assert!(diff.is_empty(), "home differs after uninstall: {diff:?}");
        // A second uninstall finds nothing to do.
        assert!(uninstall_provider_hooks_at(&backups, &home, &[]).is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn hooks_that_are_not_an_object_are_left_alone() {
        let root =
            std::env::temp_dir().join(format!("po-hooks-odd-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(root.join(".claude")).unwrap();
        let body = "{\"hooks\": []}";
        std::fs::write(root.join(".claude/settings.local.json"), body).unwrap();
        let backups = root.join("b");
        assert!(
            write_hook_settings_in(&backups, &root.to_string_lossy(), SCRIPT, 1, false, None)
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(root.join(".claude/settings.local.json")).unwrap(),
            body
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
