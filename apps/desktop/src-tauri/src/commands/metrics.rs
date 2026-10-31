//! Metrics — four IPC domains in a single module:
//!
//!   token efficiency   (token:*)
//!   usage center       (usage:*)
//!   provider usage     (provider-usage:*)
//!   optimization       (optimization:*, file-read cache)
//!
//! IPC channel → Tauri command mapping (snake_case):
//!   token:get-stats             -> token_get_stats
//!   token:get-all-stats         -> token_get_all_stats
//!   token:record-usage          -> token_record_usage
//!   token:set-flags             -> token_set_flags
//!   usage:get-summary           -> usage_get_summary
//!   usage:export                -> usage_export
//!   usage:clear                 -> usage_clear
//!   usage:run-scan              -> usage_run_scan
//!   provider-usage:get          -> provider_usage_get
//!   provider-usage:get-all      -> provider_usage_get_all
//!   provider-usage:probe        -> provider_usage_probe
//!   optimization:get-status     -> optimization_get_status
//!   optimization:refresh-context-> optimization_refresh_context
//!   optimization:get-file-cache -> optimization_get_file_cache
//!
//! Push channels (main → renderer, via AppHandle::emit):
//!   token:usage-updated         (TokenTracker.emitUpdate)
//!   usage:updated               (UsageAggregator.onUpdate)
//!   usage:scan-status           (registerUsageHandlers.pushStatus)
//!   provider-usage:updated      (EventBus 'provider:usage-updated')
//!   provider-usage:probe-failed (EventBus 'provider:usage-probe-failed')
//!
//! State managers (Arc + parking_lot::Mutex) registered in lib.rs (NOT touched here):
//!   Arc<TokenTracker>           — per-session token stat-store + analytics + flags
//!   Arc<FileReadCache>          — per-session file-read cache (redundant tokens)
//!   Arc<UsageAggregator>        — usage ring buffer + rollup + usage.json persistence
//!   Arc<ProviderUsageProbe>     — rate-limit/activity snapshot per provider/session
//!
//! Self-contained: does NOT touch mod.rs / lib.rs / Cargo.toml. lib.rs only needs to
//! `.manage(...)` the four Arcs and register the commands in the invoke_handler.
//!
//! Extra crates beyond {tauri, portable-pty, parking_lot, serde, serde_json,
//! tokio, uuid, anyhow, reqwest}: NONE. (regex avoided with manual scanners,
//! md5 replaced by an internal deterministic hash, chrono avoided with now_iso.)

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, Emitter, Manager};

use super::codex_rollout;

// Push channel constants (IpcChannels).
const TOKEN_USAGE_UPDATED: &str = "token:usage-updated";
const USAGE_SCAN_STATUS: &str = "usage:scan-status";
const PROVIDER_USAGE_UPDATED: &str = "provider-usage:updated";
const PROVIDER_USAGE_PROBE_FAILED: &str = "provider-usage:probe-failed";

// ═════════════════════════════════════════════════════════════════════════
// Shared helpers — now_iso (Date().toISOString()), now_ms (Date.now()),
// app_data_dir (app.getPath('userData')), basename, home_dir, shell utils.
// Same logic as session.rs and device.rs (replicated to stay self-contained).
// ═════════════════════════════════════════════════════════════════════════

/// Date.now() — milliseconds since the epoch.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Date().toISOString() — ISO-8601 UTC with milliseconds and Z suffix.
/// (Howard Hinnant's algorithm, identical to session.rs.)
fn now_iso() -> String {
    iso_from_ms(now_ms())
}

/// Converts epoch milliseconds → ISO-8601 (for Date(ts).toISOString()).
fn iso_from_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
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

/// userData dir (app.getPath('userData')) + `promptops` subfolder.
/// TODO: use `tauri::AppHandle::path().app_data_dir()` when the
/// command has the AppHandle, to match the runtime. For now this derives a stable
/// path like device.rs and session.rs.
fn promptops_dir() -> PathBuf {
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
    let dir = base.join(crate::APP_DIR_NAME).join("promptops");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// path.basename(p) || p (handles both '/' and '\\', strips trailing slash).
fn basename(p: &str) -> String {
    let trimmed = p.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(p)
        .to_string()
}

/// path.basename(p, ext) — removes the extension if it matches.
fn basename_ext(p: &str, ext: &str) -> String {
    let base = basename(p);
    base.strip_suffix(ext)
        .map(|s| s.to_string())
        .unwrap_or(base)
}

/// Efficiency shown in Usage: saved / (used + saved) * 100, rounded to 1 decimal.
/// This is the formula written on the page; some places used to divide by `tokens_estimated`,
/// which the Claude scanner set = used (so saved/used, e.g. 87.9% instead of 46.8%).
fn usage_efficiency(used: i64, saved: i64) -> f64 {
    let used = used.max(0);
    let saved = saved.max(0);
    let denom = used + saved;
    if denom <= 0 {
        return 0.0;
    }
    ((saved as f64 / denom as f64) * 1000.0).round() / 10.0
}

/// Last "real" segment of a path: "/" , "\\" and "C:\\" have none → None.
fn meaningful_path_segment(p: &str) -> Option<String> {
    p.split(['/', '\\'])
        .map(str::trim)
        .rfind(|s| !(s.is_empty() || s.len() == 2 && s.ends_with(':')))
        .map(String::from)
}

/// Session name to show in Usage: never "/" (basename of a cwd = root).
/// Order: given name → last meaningful segment of the workspace → "" (the webapp
/// shows a translated "Untitled session", with the short id only as secondary text).
fn display_session_name(name: &str, workspace: Option<&str>) -> String {
    let n = name.trim();
    if n.chars().any(|c| !matches!(c, '/' | '\\' | '.' | ':')) {
        return n.to_string();
    }
    workspace
        .and_then(meaningful_path_segment)
        .unwrap_or_default()
}

/// Summary of a user prompt to use as a title: first useful line, whitespace
/// collapsed, max 60 characters. Drops service messages (`<command-name>`,
/// `<local-command-stdout>`, caveat, system reminder…).
fn summarize_prompt(text: &str) -> Option<String> {
    let t = text.trim();
    if t.is_empty() || t.starts_with('<') || t.starts_with("Caveat:") || t.starts_with('[') {
        return None;
    }
    let line = t.lines().map(str::trim).find(|l| !l.is_empty())?;
    let compact: String = line.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 60;
    if compact.chars().count() > MAX {
        let cut: String = compact.chars().take(MAX).collect();
        Some(format!("{}…", cut.trim_end()))
    } else {
        Some(compact)
    }
}

/// Text of a user message in a Claude Code jsonl (string content or `text` blocks).
fn claude_user_text(v: &JsonValue) -> Option<String> {
    if v.get("isMeta").and_then(|x| x.as_bool()) == Some(true) {
        return None;
    }
    let content = v.pointer("/message/content")?;
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    content.as_array()?.iter().find_map(|b| {
        (b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .then(|| b.get("text").and_then(|t| t.as_str()).map(String::from))
            .flatten()
    })
}

fn home_dir() -> String {
    if cfg!(windows) {
        std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into())
    } else {
        std::env::var("HOME").unwrap_or_else(|_| ".".into())
    }
}

const IS_WINDOWS: bool = cfg!(windows);

fn get_shell() -> String {
    if IS_WINDOWS {
        "powershell.exe".into()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }
}

/// Shell arguments of the usage probe. On Unix the CLI runs as the `-c`
/// command of a login+interactive shell (same PATH as a session) instead of
/// being TYPED into an interactive shell: typed lines landed in the user's
/// shell history (`claude`, then `/usage` when the CLI was not there to
/// receive it), shared with every Plain Shell session. With `-c` nothing is
/// recorded, and when the CLI exits the shell exits too, so the status
/// command can never reach a shell. Windows keeps the typed launch.
fn probe_shell_args(command: &str) -> Vec<String> {
    let mut args = get_login_args();
    if !IS_WINDOWS {
        args.push("-c".into());
        args.push(command.into());
    }
    args
}

fn get_login_args() -> Vec<String> {
    if IS_WINDOWS {
        // Same as the app's terminals: the npm `.ps1` shims of the CLIs must
        // run under the default Restricted policy too.
        let mut args = vec!["-NoLogo".to_string()];
        args.extend(crate::commands::windows_shells::ps_bypass_args());
        args
    } else {
        vec!["-l".into(), "-i".into()]
    }
}

fn default_extra_paths() -> Vec<String> {
    let home = home_dir();
    if IS_WINDOWS {
        vec![
            format!("{home}\\AppData\\Local\\Programs"),
            format!("{home}\\AppData\\Roaming\\npm"),
            format!("{home}\\.local\\bin"),
        ]
    } else {
        vec![
            format!("{home}/.local/bin"),
            "/usr/local/bin".into(),
            "/opt/homebrew/bin".into(),
        ]
    }
}

fn build_path(extra: &[String]) -> String {
    let sep = if IS_WINDOWS { ";" } else { ":" };
    let fallback = if IS_WINDOWS { "" } else { "/usr/bin:/bin" };
    let current = std::env::var("PATH").unwrap_or_else(|_| fallback.to_string());
    format!("{}{}{}", extra.join(sep), sep, current)
}

/// Round half-away-from-zero like JS Math.round() (for integer counts).
fn round_js(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

// ═════════════════════════════════════════════════════════════════════════
// 1) TOKEN EFFICIENCY — token tracker + IPC handlers.
// ═════════════════════════════════════════════════════════════════════════

/// TokenConfig — default token estimation config.
#[derive(Clone)]
struct TokenConfig {
    avg_tokens_per_char: f64,
    tool_schema_token_estimate: f64,
    base_context_overhead: f64,
}

impl Default for TokenConfig {
    fn default() -> Self {
        Self {
            avg_tokens_per_char: 0.25,
            tool_schema_token_estimate: 800.0,
            base_context_overhead: 4000.0,
        }
    }
}

/// breakdown (file_reads_estimated / tool_schema_estimated / context_estimated / actual_tokens).
#[derive(Clone, Default, Serialize, Deserialize)]
struct Breakdown {
    file_reads_estimated: i64,
    tool_schema_estimated: i64,
    context_estimated: i64,
    actual_tokens: i64,
}

/// OptimizationAnalytics — { tokensSaved, occurrences }.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OptimizationAnalytics {
    tokens_saved: i64,
    occurrences: i64,
}

/// Last call of a conversation (per-conversation provider cache).
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationActivity {
    #[serde(default)]
    last_context_tokens: i64,
    #[serde(default)]
    last_activity_ms: i64,
    #[serde(default)]
    cache_ttl_ms: i64,
}

/// SessionTokenState — per-session state (camelCase in JSON).
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTokenState {
    #[serde(default)]
    provisional_turns: HashMap<String, ProvisionalTurn>,
    #[serde(default)]
    measured_turn_ids: HashSet<String>,
    #[serde(default)]
    redundant_read_tokens: i64,
    /// No counterfactual baseline is measured for new usage.
    #[serde(default)]
    savings_available: bool,
    tokens_used: i64,
    tokens_estimated: i64,
    tokens_saved: i64,
    efficiency_percentage: f64,
    breakdown: Breakdown,
    optimization_flags: HashMap<String, bool>,
    optimization_analytics: HashMap<String, OptimizationAnalytics>,
    prompt_count: i64,
    /// Real provider usage (Claude transcript / worker): billed input
    /// + cache write + cache read. Missing in old history files → 0.
    #[serde(default)]
    input_tokens_total: i64,
    #[serde(default)]
    cache_read_tokens: i64,
    #[serde(default)]
    cache_hit_percentage: f64,
    #[serde(default)]
    cost_usd: f64,
    /// Provider prompt cache discount (cacheRead × (input − cacheRead rate)).
    #[serde(default)]
    cache_saved_usd: f64,
    /// Context of the last call (input + cache) and when it happened:
    /// the webapp warns about a cold resume when the cache has expired.
    #[serde(default)]
    last_context_tokens: i64,
    #[serde(default)]
    last_activity_ms: i64,
    /// Prompt cache TTL seen in the transcript (300_000 or 3_600_000; 0 = unknown).
    #[serde(default)]
    cache_ttl_ms: i64,
    /// Resume after expired cache: occurrences and tokens rewritten to cache.
    /// Same data for the session's agents (key = sub-agent id): their
    /// metrics roll up here but each has its own conversation and its own
    /// cache. The `last_*` fields above belong to the main only.
    #[serde(default)]
    agent_contexts: HashMap<String, ConversationActivity>,
    #[serde(default)]
    cold_resume_count: i64,
    #[serde(default)]
    cold_resume_tokens: i64,
    #[serde(default)]
    compactions_by_promptops: i64,
    /// When this state was last written to the history file (ms): the
    /// history keeps the most recent MAX_HISTORY_ENTRIES sessions.
    #[serde(default)]
    history_saved_ms: i64,
}

/// Real usage data beyond input/output: cache and model (pricing).
#[derive(Clone, Default)]
pub(crate) struct UsageExtras {
    pub cache_read: i64,
    pub cache_write: i64,
    pub model: Option<String>,
}

fn cache_hit_pct(state: &SessionTokenState) -> f64 {
    if state.input_tokens_total > 0 {
        (state.cache_read_tokens as f64 / state.input_tokens_total as f64 * 10000.0).round() / 100.0
    } else {
        0.0
    }
}

/// Per-turn input threshold above which to suggest /compact.
const CONTEXT_PRESSURE_THRESHOLD: i64 = 120_000;
const CONTEXT_PRESSURE_COOLDOWN_MS: i64 = 15 * 60 * 1000;
const TOKEN_CONTEXT_PRESSURE: &str = "token:context-pressure";
/// Sessions kept in token-efficiency-history.json. The whole file is rewritten
/// (with a backup copy) on every update, so it must not grow with every
/// session ever opened.
const MAX_HISTORY_ENTRIES: usize = 1000;
/// First attach to a transcript: maximum tail read (long sessions).
const TRANSCRIPT_FIRST_READ_MAX: u64 = 4 * 1024 * 1024;

#[derive(Default)]
struct TranscriptDelta {
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    /// Context of the largest message (input + cache) → context pressure.
    max_context: i64,
    model: Option<String>,
    events: Vec<TranscriptEvent>,
}

struct TranscriptMsg {
    id: String,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    ts: i64,
    /// The CLI writes the cache with a 1h TTL (otherwise 5 min).
    ttl_1h: bool,
}

impl TranscriptMsg {
    fn context(&self) -> i64 {
        self.input + self.cache_read + self.cache_write
    }
}

enum TranscriptEvent {
    Msg(TranscriptMsg),
    Boundary { manual: bool, pre: i64, post: i64 },
}

/// Window within which a manual compaction is attributed to the PromptOps click.
const COMPACT_REQUEST_WINDOW_MS: i64 = 10 * 60 * 1000;

#[derive(Default)]
struct TranscriptCursor {
    offset: u64,
    seen: HashSet<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct ProvisionalTurn {
    used: i64,
    baseline: i64,
    prompts: i64,
    files: i64,
    tools: i64,
    context: i64,
}

/// PromptTokenRecord — return value of token:record-usage.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTokenRecord {
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    estimated_tokens: i64,
    estimation_breakdown: Breakdown,
    provider: String,
    timestamp: String,
}

/// Pending raw data per turn (pendingEstimation).
#[derive(Clone, Default)]
struct PendingEstimation {
    file_chars: f64,
    tool_count: i64,
    context_chars: f64,
}

#[derive(Default)]
struct EditWriteStats {
    edits: i64,
    writes: i64,
}

#[derive(Clone, Default)]
struct OutputAcc {
    chars: i64,
    flushed_chars: i64,
    last_output_at: i64,
}

#[derive(Default)]
struct TokenStore {
    active_turns: HashMap<String, String>,
    sessions: HashMap<String, SessionTokenState>,
    pending_estimation: HashMap<String, PendingEstimation>,
    turn_tool_names: HashMap<String, Vec<String>>,
    edit_write_stats: HashMap<String, EditWriteStats>,
    conversation_length: HashMap<String, i64>,
    /// Start of the current turn (UserPromptSubmit): filter for the first transcript read.
    turn_started_at: HashMap<String, i64>,
    /// PromptOps compaction in progress: (preTokens, postTokens).
    active_compaction: HashMap<String, (i64, i64)>,
    /// lastToolTime — gating for auto-finalize (10s of quiet).
    last_tool_time: HashMap<String, i64>,
    /// outputAccumulator — estimation fallback when hooks don't arrive.
    output_accumulator: HashMap<String, OutputAcc>,
}

/// TokenTracker — token stat-store, driven by the
/// IPC handlers (record-usage / set-flags) instead of the hook EventBus.
///
/// TODO: the EventBus listeners ('hook:tool-use', 'hook:stop',
/// 'session:output', the 15s flushTimer with estimateFromOutput, and
/// autoFinalizeeTurn) are NOT wired here because they depend on the native
/// HookManager/SessionManager. The public surface (handle_tool_use_for_session,
/// finalize_turn, record_actual_usage, set/record analytics) is complete and
/// ready for wiring; they must be hooked up from the hook module once integrated.
pub struct TokenTracker {
    store: Mutex<TokenStore>,
    config: TokenConfig,
    history: Mutex<TokenHistory>,
    /// transcript_path → incremental read cursor.
    transcripts: Mutex<HashMap<String, TranscriptCursor>>,
    pressure_notified_at: Mutex<HashMap<String, i64>>,
    compact_requested_at: Mutex<HashMap<String, i64>>,
}

struct TokenHistory {
    path: PathBuf,
    entries: HashMap<String, SessionTokenState>,
    bindings: HashMap<String, String>,
    loaded: bool,
}

impl TokenHistory {
    fn load(&mut self) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        self.entries = std::fs::read(&self.path)
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .or_else(|| {
                std::fs::read(self.path.with_extension("json.bak"))
                    .ok()
                    .and_then(|raw| serde_json::from_slice(&raw).ok())
            })
            .unwrap_or_default();
    }

    /// Drops the least recently saved sessions beyond MAX_HISTORY_ENTRIES,
    /// never one bound to a live session.
    fn prune(&mut self) {
        if self.entries.len() <= MAX_HISTORY_ENTRIES {
            return;
        }
        let live: HashSet<&String> = self.bindings.values().collect();
        let mut candidates: Vec<(i64, String)> = self
            .entries
            .iter()
            .filter(|(k, _)| !live.contains(k))
            .map(|(k, v)| (v.history_saved_ms.max(v.last_activity_ms), k.clone()))
            .collect();
        candidates.sort();
        let excess = self.entries.len() - MAX_HISTORY_ENTRIES;
        for (_, key) in candidates.into_iter().take(excess) {
            self.entries.remove(&key);
        }
    }

    fn save(&mut self) -> std::io::Result<()> {
        self.prune();
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let mut file = std::fs::File::create(&tmp)?;
        serde_json::to_writer(&mut file, &self.entries)?;
        file.sync_all()?;
        drop(file);
        if let Ok(raw) = std::fs::read(&self.path) {
            if serde_json::from_slice::<HashMap<String, SessionTokenState>>(&raw).is_ok() {
                std::fs::copy(&self.path, self.path.with_extension("json.bak"))?;
            }
        }
        std::fs::rename(tmp, &self.path)
    }
}

fn merge_token_history(state: &mut SessionTokenState, history: &SessionTokenState) {
    state.savings_available |= history.savings_available || history.tokens_saved > 0;
    state
        .provisional_turns
        .extend(history.provisional_turns.clone());
    state
        .measured_turn_ids
        .extend(history.measured_turn_ids.clone());
    state.redundant_read_tokens += history.redundant_read_tokens;
    state.tokens_used += history.tokens_used;
    state.tokens_estimated += history.tokens_estimated;
    state.prompt_count += history.prompt_count;
    state.input_tokens_total += history.input_tokens_total;
    state.cache_read_tokens += history.cache_read_tokens;
    state.cache_hit_percentage = cache_hit_pct(state);
    state.cost_usd += history.cost_usd;
    state.cache_saved_usd += history.cache_saved_usd;
    state.cold_resume_count += history.cold_resume_count;
    state.cold_resume_tokens += history.cold_resume_tokens;
    state.compactions_by_promptops += history.compactions_by_promptops;
    if history.last_activity_ms > state.last_activity_ms {
        state.last_activity_ms = history.last_activity_ms;
        state.last_context_tokens = history.last_context_tokens;
    }
    if state.cache_ttl_ms == 0 {
        state.cache_ttl_ms = history.cache_ttl_ms;
    }
    for (id, h) in &history.agent_contexts {
        let cur = state.agent_contexts.entry(id.clone()).or_default();
        if h.last_activity_ms > cur.last_activity_ms {
            *cur = *h;
        }
    }
    state.tokens_saved = (state.tokens_estimated - state.tokens_used).max(0);
    state.efficiency_percentage = if state.tokens_estimated > 0 {
        (state.tokens_saved as f64 / state.tokens_estimated as f64 * 10000.0).round() / 100.0
    } else {
        0.0
    };
    state.breakdown.file_reads_estimated += history.breakdown.file_reads_estimated;
    state.breakdown.tool_schema_estimated += history.breakdown.tool_schema_estimated;
    state.breakdown.context_estimated += history.breakdown.context_estimated;
    state.breakdown.actual_tokens = state.tokens_used;
    for (key, value) in &history.optimization_flags {
        state
            .optimization_flags
            .entry(key.clone())
            .or_insert(*value);
    }
    for (key, value) in &history.optimization_analytics {
        add_analytics(state, key, value.tokens_saved, value.occurrences);
    }
}

impl Default for TokenTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl TokenTracker {
    pub fn new() -> Self {
        Self::with_history_path(promptops_dir().join("token-efficiency-history.json"))
    }

    fn with_history_path(path: PathBuf) -> Self {
        Self {
            store: Mutex::new(TokenStore::default()),
            config: TokenConfig::default(),
            history: Mutex::new(TokenHistory {
                path,
                entries: HashMap::new(),
                bindings: HashMap::new(),
                loaded: false,
            }),
            transcripts: Mutex::new(HashMap::new()),
            pressure_notified_at: Mutex::new(HashMap::new()),
            compact_requested_at: Mutex::new(HashMap::new()),
        }
    }

    fn restore_key(&self, session_id: &str, key: String) {
        // Lock order is always history -> store; loading late merges live activity once.
        let mut history = self.history.lock();
        history.load();
        if history.bindings.get(session_id) == Some(&key) {
            return;
        }
        let legacy_id = key.strip_prefix("history:").unwrap_or(&key);
        if let Some(saved) = history
            .entries
            .get(&key)
            .or_else(|| history.entries.get(&format!("db:{legacy_id}")))
            .or_else(|| history.entries.get(&format!("local:{legacy_id}")))
        {
            let mut store = self.store.lock();
            Self::init_session(&mut store, session_id);
            merge_token_history(store.sessions.get_mut(session_id).unwrap(), saved);
        }
        history.bindings.insert(session_id.to_string(), key);
    }

    pub(crate) fn restore_session(&self, app: &AppHandle, session_id: &str) {
        let key = app
            .try_state::<Arc<super::session::SessionManager>>()
            .and_then(|sessions| {
                sessions
                    .token_history_id(session_id)
                    .map(|id| format!("history:{id}"))
                    .or_else(|| {
                        sessions
                            .get(session_id)
                            .and_then(|s| s.db_id)
                            .map(|id| format!("db:{id}"))
                    })
            })
            .unwrap_or_else(|| {
                self.history
                    .lock()
                    .bindings
                    .get(session_id)
                    .cloned()
                    .unwrap_or_else(|| format!("local:{session_id}"))
            });
        self.restore_key(session_id, key);
    }

    fn persist_session(&self, session_id: &str) {
        let mut history = self.history.lock();
        history.load();
        let state = self.store.lock().sessions.get(session_id).cloned();
        if let Some(mut state) = state {
            state.history_saved_ms = now_ms();
            let key = history
                .bindings
                .get(session_id)
                .cloned()
                .unwrap_or_else(|| format!("local:{session_id}"));
            history.entries.insert(key, state);
            if let Err(err) = history.save() {
                eprintln!("[TokenEfficiency] Could not persist history: {err}");
            }
        }
    }

    pub(crate) fn checkpoint_all(&self, app: &AppHandle) {
        let ids: HashSet<String> = {
            let store = self.store.lock();
            store
                .sessions
                .keys()
                .chain(store.output_accumulator.keys())
                .cloned()
                .collect()
        };
        for id in ids {
            self.restore_session(app, &id);
            self.auto_finalize_turn(app, &id);
            let chars = {
                let mut store = self.store.lock();
                store
                    .output_accumulator
                    .get_mut(&id)
                    .map(|acc| {
                        let chars = acc.chars - acc.flushed_chars;
                        acc.flushed_chars = acc.chars;
                        chars
                    })
                    .unwrap_or(0)
            };
            if chars > 0 {
                self.estimate_from_output(app, &id, chars);
            }
            self.persist_session(&id);
        }
    }

    /// Initialize missing state without discarding an in-flight turn.
    fn init_session(store: &mut TokenStore, session_id: &str) {
        store.sessions.entry(session_id.to_string()).or_default();
        store
            .pending_estimation
            .entry(session_id.to_string())
            .or_default();
    }

    pub(crate) fn begin_turn(&self, session_id: &str, turn_id: Option<&str>) {
        let mut store = self.store.lock();
        store.active_turns.insert(
            session_id.to_string(),
            turn_id
                .map(str::to_string)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        );
        store
            .turn_started_at
            .insert(session_id.to_string(), now_ms());
    }

    pub(crate) fn end_turn(&self, session_id: &str) {
        self.store.lock().active_turns.remove(session_id);
    }

    fn remember_estimate(store: &mut TokenStore, session_id: &str, mut delta: ProvisionalTurn) {
        let id = store
            .active_turns
            .entry(session_id.to_string())
            .or_insert_with(|| uuid::Uuid::new_v4().to_string())
            .clone();
        let state = store.sessions.get_mut(session_id).unwrap();
        if let Some(previous) = state.provisional_turns.get_mut(&id) {
            state.prompt_count -= delta.prompts;
            delta.prompts = 0;
            previous.used += delta.used;
            previous.baseline += delta.baseline;
            previous.files += delta.files;
            previous.tools += delta.tools;
            previous.context += delta.context;
        } else {
            state.provisional_turns.insert(id, delta);
        }
    }

    fn reconcile_estimate(store: &mut TokenStore, session_id: &str, turn_id: Option<&str>) {
        let active = store.active_turns.get(session_id).cloned();
        let state = store.sessions.get_mut(session_id).unwrap();
        let key = turn_id.map(str::to_string).or_else(|| {
            if state.provisional_turns.len() != 1 {
                return None;
            }
            let candidate = state.provisional_turns.keys().next()?.clone();
            if active.as_ref().is_none_or(|id| id == &candidate) {
                Some(candidate)
            } else {
                None
            }
        });
        if let Some(previous) = key.and_then(|id| state.provisional_turns.remove(&id)) {
            state.tokens_used -= previous.used;
            state.tokens_estimated -= previous.baseline;
            state.prompt_count -= previous.prompts;
            state.breakdown.file_reads_estimated -= previous.files;
            state.breakdown.tool_schema_estimated -= previous.tools;
            state.breakdown.context_estimated -= previous.context;
        }
    }

    fn mark_output_accounted(store: &mut TokenStore, session_id: &str) {
        if let Some(acc) = store.output_accumulator.get_mut(session_id) {
            acc.flushed_chars = acc.chars;
        }
    }

    /// getSessionStats.
    fn session_stats(&self, session_id: &str) -> Option<SessionTokenState> {
        self.store.lock().sessions.get(session_id).cloned()
    }

    /// getAllStats.
    fn all_stats(&self) -> HashMap<String, SessionTokenState> {
        self.store.lock().sessions.clone()
    }

    /// recordActualUsage — records the real provider tokens + emits update.
    /// Public variant for native consumers (TurnRunner worker).
    pub(crate) fn record_actual_usage_public(
        &self,
        app: &AppHandle,
        session_id: &str,
        input_tokens: i64,
        output_tokens: i64,
        total_tokens: i64,
        provider: &str,
        turn_id: Option<&str>,
        extras: &UsageExtras,
    ) {
        let _ = self.record_actual_usage(
            app,
            session_id,
            input_tokens,
            output_tokens,
            total_tokens,
            provider,
            false,
            turn_id,
            extras,
        );
    }

    fn record_actual_usage(
        &self,
        app: &AppHandle,
        session_id: &str,
        input_tokens: i64,
        output_tokens: i64,
        total_tokens: i64,
        provider: &str,
        account_pending: bool,
        turn_id: Option<&str>,
        extras: &UsageExtras,
    ) -> PromptTokenRecord {
        self.restore_session(app, session_id);
        let mut store = self.store.lock();
        Self::init_session(&mut store, session_id);
        let file_reads_estimated = 0;
        let consume_pending = account_pending
            && turn_id.is_none_or(|id| {
                store
                    .active_turns
                    .get(session_id)
                    .is_none_or(|active| active == id)
            });
        let tool_schema_estimated = 0;
        let context_estimated = total_tokens;
        let estimated_tokens = total_tokens;

        let record = PromptTokenRecord {
            input_tokens,
            output_tokens,
            total_tokens,
            estimated_tokens,
            estimation_breakdown: Breakdown {
                file_reads_estimated,
                tool_schema_estimated,
                context_estimated,
                actual_tokens: total_tokens,
            },
            provider: provider.to_string(),
            timestamp: now_iso(),
        };

        if turn_id.is_some_and(|id| store.sessions[session_id].measured_turn_ids.contains(id)) {
            return record;
        }
        if account_pending {
            Self::reconcile_estimate(&mut store, session_id, turn_id);
        }
        if let Some(id) = turn_id {
            store
                .sessions
                .get_mut(session_id)
                .unwrap()
                .measured_turn_ids
                .insert(id.to_string());
        }
        {
            let state = store.sessions.get_mut(session_id).unwrap();
            state.prompt_count += 1;
            state.tokens_used += total_tokens;
            state.tokens_estimated += estimated_tokens;
            state.tokens_saved = (state.tokens_estimated - state.tokens_used).max(0);
            state.efficiency_percentage = if state.tokens_estimated > 0 {
                ((state.tokens_saved as f64 / state.tokens_estimated as f64) * 10000.0).round()
                    / 100.0
            } else {
                0.0
            };
            state.efficiency_percentage = state.efficiency_percentage.max(0.0);
            state.breakdown.file_reads_estimated += file_reads_estimated;
            state.breakdown.tool_schema_estimated += tool_schema_estimated;
            state.breakdown.context_estimated += context_estimated;
            state.breakdown.actual_tokens = state.tokens_used;

            let pricing = resolve_pricing(provider, extras.model.as_deref());
            state.input_tokens_total += input_tokens + extras.cache_read + extras.cache_write;
            state.cache_read_tokens += extras.cache_read;
            state.cache_hit_percentage = cache_hit_pct(state);
            state.cost_usd += (input_tokens as f64 * pricing.input_per_m
                + output_tokens as f64 * pricing.output_per_m
                + extras.cache_read as f64 * pricing.cache_read_per_m
                + extras.cache_write as f64 * pricing.cache_write_per_m)
                / 1_000_000.0;
            state.cache_saved_usd += extras.cache_read as f64
                * (pricing.input_per_m - pricing.cache_read_per_m).max(0.0)
                / 1_000_000.0;
        }

        if consume_pending {
            store.active_turns.remove(session_id);
            store
                .pending_estimation
                .insert(session_id.to_string(), PendingEstimation::default());
            store
                .turn_tool_names
                .insert(session_id.to_string(), Vec::new());
            Self::mark_output_accounted(&mut store, session_id);
        }

        let payload = Self::build_update_payload(&store, session_id);
        drop(store);
        if let Some(p) = payload {
            self.persist_session(session_id);
            let _ = app.emit(TOKEN_USAGE_UPDATED, p);
        }
        record
    }

    /// Real usage of a Claude PTY session from the JSONL transcript (Stop hook).
    /// Incremental read per `transcript_path`: only new bytes, never
    /// the whole file (on first attach at most the 4 MiB tail, counting
    /// only the current turn's messages). Returns true if it recorded usage:
    /// in that case the turn's hook estimate is discarded (consume_pending).
    pub(crate) fn ingest_claude_transcript(
        &self,
        app: &AppHandle,
        session_id: &str,
        sub_agent_id: Option<&str>,
        path: &str,
    ) -> bool {
        let Some(delta) = self.read_transcript_delta(session_id, path) else {
            return false;
        };
        self.apply_transcript_events(session_id, sub_agent_id, &delta.events);
        let has_usage = delta.input + delta.output + delta.cache_read + delta.cache_write > 0;
        if has_usage {
            let extras = UsageExtras {
                cache_read: delta.cache_read,
                cache_write: delta.cache_write,
                model: delta.model,
            };
            self.record_actual_usage(
                app,
                session_id,
                delta.input,
                delta.output,
                delta.input + delta.cache_write + delta.output,
                "claude-code-cli",
                true,
                None,
                &extras,
            );
            self.maybe_emit_context_pressure(app, session_id, sub_agent_id, delta.max_context);
        } else {
            // Only a compact_boundary: update the UI anyway.
            let payload = Self::build_update_payload(&self.store.lock(), session_id);
            if let Some(p) = payload {
                self.persist_session(session_id);
                let _ = app.emit(TOKEN_USAGE_UPDATED, p);
            }
        }
        has_usage
    }

    /// Pure (testable) part of ingest_claude_transcript: None = no new usage.
    fn read_transcript_delta(&self, session_id: &str, path: &str) -> Option<TranscriptDelta> {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = std::fs::File::open(path).ok()?;
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        let resume = self
            .transcripts
            .lock()
            .get(path)
            .map(|c| c.offset)
            .filter(|o| *o <= len);
        let (start, since_ms) = match resume {
            Some(offset) => (offset, None),
            None => {
                let started = self.store.lock().turn_started_at.get(session_id).copied();
                let Some(started) = started else {
                    // Turn started before the app: no reliable baseline, start from EOF.
                    self.transcripts.lock().insert(
                        path.to_string(),
                        TranscriptCursor {
                            offset: len,
                            ..Default::default()
                        },
                    );
                    return None;
                };
                (len.saturating_sub(TRANSCRIPT_FIRST_READ_MAX), Some(started))
            }
        };
        if start >= len {
            return None;
        }
        let mut buf = Vec::with_capacity((len - start) as usize);
        if file.seek(SeekFrom::Start(start)).is_err()
            || file.take(len - start).read_to_end(&mut buf).is_err()
        {
            return None;
        }
        let last_nl = buf.iter().rposition(|b| *b == b'\n')?;
        let mut body = &buf[..=last_nl];
        if resume.is_none() && start > 0 {
            // Tail: the first line is almost certainly cut.
            let i = body.iter().position(|b| *b == b'\n')?;
            body = &body[i + 1..];
        }

        // message.id → usage (streamed lines of the same message repeat the usage: the last one wins).
        // Events in order: assistant messages (streamed lines of the same
        // message.id repeat the usage: the last one wins) and compact_boundary.
        let mut events: Vec<TranscriptEvent> = Vec::new();
        let mut model: Option<String> = None;
        for line in body.split(|b| *b == b'\n') {
            // Byte prefilter: JSON is parsed only for lines with usage or boundary.
            if !line.windows(7).any(|w| w == b"\"usage\"")
                && !line.windows(16).any(|w| w == b"compact_boundary")
            {
                continue;
            }
            let Ok(v) = serde_json::from_slice::<JsonValue>(line) else {
                continue;
            };
            let ts = v
                .get("timestamp")
                .and_then(|t| t.as_str())
                .and_then(parse_iso_ms)
                .unwrap_or(0);
            if since_ms.is_some_and(|since| ts < since) {
                continue;
            }
            if v.get("subtype").and_then(|t| t.as_str()) == Some("compact_boundary") {
                let meta = v.get("compactMetadata");
                let n = |k: &str| {
                    meta.and_then(|m| m.get(k))
                        .and_then(|x| x.as_i64())
                        .unwrap_or(0)
                };
                events.push(TranscriptEvent::Boundary {
                    manual: meta.and_then(|m| m.get("trigger")).and_then(|t| t.as_str())
                        == Some("manual"),
                    pre: n("preTokens"),
                    post: n("postTokens"),
                });
                continue;
            }
            if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
                continue;
            }
            let Some(usage) = v.pointer("/message/usage") else {
                continue;
            };
            let Some(id) = v
                .pointer("/message/id")
                .and_then(|x| x.as_str())
                .or_else(|| v.get("uuid").and_then(|x| x.as_str()))
            else {
                continue;
            };
            let n = |k: &str| usage.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
            let msg = TranscriptMsg {
                id: id.to_string(),
                input: n("input_tokens"),
                output: n("output_tokens"),
                cache_read: n("cache_read_input_tokens"),
                cache_write: n("cache_creation_input_tokens"),
                ts,
                ttl_1h: usage
                    .pointer("/cache_creation/ephemeral_1h_input_tokens")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0)
                    > 0,
            };
            if let Some(m) = v.pointer("/message/model").and_then(|x| x.as_str()) {
                if m != "<synthetic>" {
                    model = Some(m.to_string());
                }
            }
            let existing = events.iter_mut().rev().find_map(|e| match e {
                TranscriptEvent::Msg(m) if m.id == msg.id => Some(m),
                _ => None,
            });
            match existing {
                Some(m) => *m = msg,
                None => events.push(TranscriptEvent::Msg(msg)),
            }
        }

        let mut delta = TranscriptDelta {
            model,
            ..Default::default()
        };
        {
            let mut cursors = self.transcripts.lock();
            let cursor = cursors.entry(path.to_string()).or_default();
            cursor.offset = start + (buf[..=last_nl].len() as u64);
            for event in events {
                if let TranscriptEvent::Msg(m) = &event {
                    if !cursor.seen.insert(m.id.clone()) {
                        continue;
                    }
                    delta.input += m.input;
                    delta.output += m.output;
                    delta.cache_read += m.cache_read;
                    delta.cache_write += m.cache_write;
                    delta.max_context = delta.max_context.max(m.context());
                }
                delta.events.push(event);
            }
            if cursor.seen.len() > 20_000 {
                cursor.seen.clear();
            }
        }
        if delta.events.is_empty() {
            return None;
        }
        Some(delta)
    }

    /// Applies transcript events to the "waste/savings" counters:
    /// - cold resume: message after a pause > cache TTL that rewrites the cache;
    /// - compaction started by PromptOps (manual + requested ≤ 10 min earlier):
    ///   every following call sends (pre − post) fewer tokens, until the
    ///   context grows back to `pre`; the compaction pass costs `pre` once.
    fn apply_transcript_events(
        &self,
        session_id: &str,
        sub_agent_id: Option<&str>,
        events: &[TranscriptEvent],
    ) {
        let now = now_ms();
        let requested = self
            .compact_requested_at
            .lock()
            .get(session_id)
            .copied()
            .is_some_and(|t| now - t < COMPACT_REQUEST_WINDOW_MS);
        let mut store = self.store.lock();
        Self::init_session(&mut store, session_id);
        let mut active = store.active_compaction.get(session_id).copied();
        let mut consumed_request = false;
        let (mut saved, mut charged) = (0i64, 0i64);
        let state = store.sessions.get_mut(session_id).unwrap();
        // Context/activity/TTL of the conversation that wrote the transcript.
        let mut conv = match sub_agent_id {
            Some(id) => state.agent_contexts.get(id).copied().unwrap_or_default(),
            None => ConversationActivity {
                last_context_tokens: state.last_context_tokens,
                last_activity_ms: state.last_activity_ms,
                cache_ttl_ms: state.cache_ttl_ms,
            },
        };
        for event in events {
            match event {
                TranscriptEvent::Boundary { manual, pre, post } => {
                    active = None;
                    if *manual && requested && !consumed_request && pre > post {
                        consumed_request = true;
                        active = Some((*pre, *post));
                        charged += pre;
                        state.compactions_by_promptops += 1;
                    }
                    conv.last_context_tokens = *post;
                }
                TranscriptEvent::Msg(m) => {
                    let ttl = if m.ttl_1h { 3_600_000 } else { 300_000 };
                    if m.ttl_1h || conv.cache_ttl_ms == 0 {
                        conv.cache_ttl_ms = ttl;
                    }
                    if conv.last_activity_ms > 0
                        && m.ts - conv.last_activity_ms > conv.cache_ttl_ms
                        && m.cache_write > 0
                    {
                        state.cold_resume_count += 1;
                        state.cold_resume_tokens += m.cache_write;
                    }
                    if m.ts > 0 {
                        conv.last_activity_ms = conv.last_activity_ms.max(m.ts);
                    }
                    conv.last_context_tokens = m.context();
                    if let Some((pre, post)) = active {
                        if m.context() < pre {
                            saved += pre - post;
                        } else {
                            active = None;
                        }
                    }
                }
            }
        }
        match sub_agent_id {
            Some(id) => {
                state.agent_contexts.insert(id.to_string(), conv);
            }
            None => {
                state.last_context_tokens = conv.last_context_tokens;
                state.last_activity_ms = conv.last_activity_ms;
                state.cache_ttl_ms = conv.cache_ttl_ms;
            }
        }
        if saved > 0 || charged > 0 {
            state.savings_available = true;
            state.tokens_estimated += saved;
            state.tokens_used += charged;
            state.tokens_saved = (state.tokens_estimated - state.tokens_used).max(0);
            state.efficiency_percentage = if state.tokens_estimated > 0 {
                (state.tokens_saved as f64 / state.tokens_estimated as f64 * 10000.0).round()
                    / 100.0
            } else {
                0.0
            };
            state.breakdown.actual_tokens = state.tokens_used;
            state
                .optimization_flags
                .insert("used_compaction".into(), true);
            add_analytics(
                state,
                "used_compaction",
                saved - charged,
                if charged > 0 { 1 } else { 0 },
            );
        }
        match active {
            Some(a) => {
                store.active_compaction.insert(session_id.to_string(), a);
            }
            None => {
                store.active_compaction.remove(session_id);
            }
        }
        drop(store);
        if consumed_request {
            self.compact_requested_at.lock().remove(session_id);
        }
    }

    /// PromptOps is about to send /compact: the next manual compact_boundary
    /// within COMPACT_REQUEST_WINDOW_MS is attributed to PromptOps.
    pub(crate) fn mark_compact_requested(&self, session_id: &str) {
        self.compact_requested_at
            .lock()
            .insert(session_id.to_string(), now_ms());
    }

    /// `sub_agent_id` = the transcript belongs to an agent (metrics on the parent):
    /// the renderer must send /compact to that agent, not to the main.
    fn maybe_emit_context_pressure(
        &self,
        app: &AppHandle,
        session_id: &str,
        sub_agent_id: Option<&str>,
        input_tokens: i64,
    ) {
        if input_tokens < CONTEXT_PRESSURE_THRESHOLD {
            return;
        }
        let now = now_ms();
        {
            let key = sub_agent_id.unwrap_or(session_id);
            let mut notified = self.pressure_notified_at.lock();
            if notified
                .get(key)
                .is_some_and(|t| now - t < CONTEXT_PRESSURE_COOLDOWN_MS)
            {
                return;
            }
            notified.insert(key.to_string(), now);
        }
        let _ = app.emit(
            TOKEN_CONTEXT_PRESSURE,
            json!({
                "sessionId": session_id,
                "subAgentId": sub_agent_id,
                "inputTokens": input_tokens,
                "threshold": CONTEXT_PRESSURE_THRESHOLD,
            }),
        );
    }

    /// setOptimizationFlags — merges flags + emit.
    fn set_optimization_flags(
        &self,
        app: &AppHandle,
        session_id: &str,
        flags: HashMap<String, bool>,
    ) {
        self.restore_session(app, session_id);
        let mut store = self.store.lock();
        Self::init_session(&mut store, session_id);
        {
            let state = store.sessions.get_mut(session_id).unwrap();
            for (k, v) in flags {
                state.optimization_flags.insert(k, v);
            }
        }
        let payload = Self::build_update_payload(&store, session_id);
        drop(store);
        if let Some(p) = payload {
            self.persist_session(session_id);
            let _ = app.emit(TOKEN_USAGE_UPDATED, p);
        }
    }

    /// setCacheFlag — called by FileReadCache when it detects redundant re-reads.
    pub(crate) fn set_cache_flag(&self, app: &AppHandle, session_id: &str, redundant_tokens: i64) {
        self.restore_session(app, session_id);
        let mut store = self.store.lock();
        Self::init_session(&mut store, session_id);
        {
            let state = store.sessions.get_mut(session_id).unwrap();
            state.redundant_read_tokens += redundant_tokens;
        }
        let payload = Self::build_update_payload(&store, session_id);
        drop(store);
        if let Some(p) = payload {
            self.persist_session(session_id);
            let _ = app.emit(TOKEN_USAGE_UPDATED, p);
        }
    }

    /// emitUpdate → builds the snake_case payload of 'token:usage-updated'.
    fn build_update_payload(store: &TokenStore, session_id: &str) -> Option<JsonValue> {
        let state = store.sessions.get(session_id)?;
        Some(json!({
            "sessionId": session_id,
            "stats": {
                "tokens_used": state.tokens_used,
                "tokens_estimated": state.tokens_estimated,
                "tokens_saved": state.tokens_saved,
                "savings_available": state.savings_available,
                "efficiency_percentage": state.efficiency_percentage,
                "breakdown": state.breakdown,
                "optimization_flags": state.optimization_flags,
                "optimization_analytics": state.optimization_analytics,
                "prompt_count": state.prompt_count,
                "cache_read_tokens": state.cache_read_tokens,
                "cache_hit_percentage": state.cache_hit_percentage,
                "cost_usd": state.cost_usd,
                "cache_saved_usd": state.cache_saved_usd,
                "last_context_tokens": state.last_context_tokens,
                "last_activity_ms": state.last_activity_ms,
                "cache_ttl_ms": state.cache_ttl_ms,
                "agent_contexts": state.agent_contexts,
                "cold_resume_count": state.cold_resume_count,
                "cold_resume_tokens": state.cold_resume_tokens,
                "compactions_by_promptops": state.compactions_by_promptops,
            }
        }))
    }

    /// handleToolUse — feeds the raw counters for the turn estimate.
    /// Public surface for the future HookManager wiring.
    #[allow(dead_code)]
    pub(crate) fn handle_tool_use(
        &self,
        session_id: &str,
        tool_name: &str,
        tool_input: &JsonValue,
    ) {
        let mut store = self.store.lock();
        if !store.pending_estimation.contains_key(session_id) {
            Self::init_session(&mut store, session_id);
        }
        let pending = store.pending_estimation.get_mut(session_id).unwrap();
        pending.tool_count += 1;

        store
            .turn_tool_names
            .entry(session_id.to_string())
            .or_default()
            .push(tool_name.to_string());

        let file_read_tools = ["Read", "read_file", "ReadFile", "cat", "View"];
        if file_read_tools.iter().any(|t| tool_name.contains(t)) {
            let has_path = tool_input
                .get("file_path")
                .or_else(|| tool_input.get("path"))
                .and_then(|v| v.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            if has_path {
                store
                    .pending_estimation
                    .get_mut(session_id)
                    .unwrap()
                    .file_chars += 5000.0;
            }
        }

        let context_tools = [
            "Write",
            "Edit",
            "write_file",
            "Bash",
            "bash",
            "execute_command",
        ];
        if context_tools.iter().any(|t| tool_name.contains(t)) {
            let content = tool_input
                .get("content")
                .or_else(|| tool_input.get("command"))
                .or_else(|| tool_input.get("new_string"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            store
                .pending_estimation
                .get_mut(session_id)
                .unwrap()
                .context_chars += content.len() as f64;
        }

        let ew = store
            .edit_write_stats
            .entry(session_id.to_string())
            .or_default();
        if tool_name == "Edit" || tool_name == "edit_file" {
            ew.edits += 1;
        } else if tool_name == "Write" || tool_name == "write_file" {
            ew.writes += 1;
        }

        store
            .last_tool_time
            .insert(session_id.to_string(), now_ms());
    }

    /// Accumulates PTY output (chars) for the fallback estimate (session:output).
    pub(crate) fn record_output(&self, session_id: &str, chars: i64) {
        let mut store = self.store.lock();
        let acc = store
            .output_accumulator
            .entry(session_id.to_string())
            .or_default();
        acc.chars += chars;
        acc.last_output_at = now_ms();
    }

    /// autoFinalizeeTurn — closes the turn with the pending hook data.
    /// Baseline: what the agent would have done WITHOUT optimization.
    pub(crate) fn auto_finalize_turn(&self, app: &AppHandle, session_id: &str) {
        self.restore_session(app, session_id);
        let mut store = self.store.lock();
        Self::init_session(&mut store, session_id);
        let Some(pending) = store.pending_estimation.get(session_id).cloned() else {
            return;
        };
        if pending.tool_count == 0 && pending.file_chars == 0.0 && pending.context_chars == 0.0 {
            return;
        }

        let actual_file_reads = round_js(pending.file_chars * self.config.avg_tokens_per_char);
        let actual_tool_schemas =
            pending.tool_count * self.config.tool_schema_token_estimate as i64;
        let actual_context = round_js(pending.context_chars * self.config.avg_tokens_per_char);
        let actual_total = actual_file_reads
            + actual_tool_schemas
            + actual_context
            + self.config.base_context_overhead as i64;

        let baseline_file_reads = actual_file_reads;
        let baseline_tool_schemas = actual_tool_schemas;
        let baseline_context = actual_context + self.config.base_context_overhead as i64;
        let baseline_total = actual_total;

        {
            let state = store.sessions.get_mut(session_id).unwrap();
            state.prompt_count += 1;
            state.tokens_used += actual_total;
            state.tokens_estimated += baseline_total;
            state.tokens_saved = (state.tokens_estimated - state.tokens_used).max(0);
            state.efficiency_percentage = if state.tokens_estimated > 0 {
                ((state.tokens_saved as f64 / state.tokens_estimated as f64) * 10000.0).round()
                    / 100.0
            } else {
                0.0
            };
            state.efficiency_percentage = state.efficiency_percentage.max(0.0);
            state.breakdown.file_reads_estimated += baseline_file_reads;
            state.breakdown.tool_schema_estimated += baseline_tool_schemas;
            state.breakdown.context_estimated += baseline_context;
            state.breakdown.actual_tokens = state.tokens_used;
        }

        Self::remember_estimate(
            &mut store,
            session_id,
            ProvisionalTurn {
                used: actual_total,
                baseline: baseline_total,
                prompts: 1,
                files: baseline_file_reads,
                tools: baseline_tool_schemas,
                context: baseline_context,
            },
        );
        store
            .pending_estimation
            .insert(session_id.to_string(), PendingEstimation::default());
        store
            .turn_tool_names
            .insert(session_id.to_string(), Vec::new());
        Self::mark_output_accounted(&mut store, session_id);

        let payload = Self::build_update_payload(&store, session_id);
        drop(store);
        if let Some(p) = payload {
            self.persist_session(session_id);
            let _ = app.emit(TOKEN_USAGE_UPDATED, p);
        }
    }

    /// estimateFromOutput — estimate from output volume when hooks don't
    /// work (output ≈ chars×0.25; total ≈ output×3.5).
    fn estimate_from_output(&self, app: &AppHandle, session_id: &str, output_chars: i64) {
        self.restore_session(app, session_id);
        let mut store = self.store.lock();
        Self::init_session(&mut store, session_id);

        let output_tokens = round_js(output_chars as f64 * self.config.avg_tokens_per_char);
        let actual_total = round_js(output_tokens as f64 * 3.5);
        let baseline_total = actual_total;

        {
            let state = store.sessions.get_mut(session_id).unwrap();
            state.prompt_count += 1;
            state.tokens_used += actual_total;
            state.tokens_estimated += baseline_total;
            state.tokens_saved = (state.tokens_estimated - state.tokens_used).max(0);
            state.efficiency_percentage = if state.tokens_estimated > 0 {
                ((state.tokens_saved as f64 / state.tokens_estimated as f64) * 10000.0).round()
                    / 100.0
            } else {
                0.0
            };
            state.efficiency_percentage = state.efficiency_percentage.max(0.0);
            state.breakdown.actual_tokens = state.tokens_used;
            state.breakdown.context_estimated += actual_total;
        }

        Self::remember_estimate(
            &mut store,
            session_id,
            ProvisionalTurn {
                used: actual_total,
                baseline: baseline_total,
                prompts: 1,
                files: 0,
                tools: 0,
                context: actual_total,
            },
        );
        let payload = Self::build_update_payload(&store, session_id);
        drop(store);
        if let Some(p) = payload {
            self.persist_session(session_id);
            let _ = app.emit(TOKEN_USAGE_UPDATED, p);
        }
    }

    /// The periodic 15s flush (startFlushTimer): (1) finalizes turns with
    /// pending hook data idle for 10s+; (2) fallback: estimate from output if
    /// hooks produce nothing (>500 new chars, 8s+ quiet).
    pub(crate) fn flush_tick(&self, app: &AppHandle) {
        let now = now_ms();

        let to_finalize: Vec<String> = {
            let store = self.store.lock();
            store
                .pending_estimation
                .iter()
                .filter(|(_, p)| p.tool_count > 0 || p.file_chars > 0.0 || p.context_chars > 0.0)
                .filter(|(sid, _)| {
                    now - store.last_tool_time.get(*sid).copied().unwrap_or(0) > 10_000
                })
                .map(|(sid, _)| sid.clone())
                .collect()
        };
        for sid in to_finalize {
            self.auto_finalize_turn(app, &sid);
        }

        let to_estimate: Vec<(String, i64)> = {
            let mut store = self.store.lock();
            let mut out = Vec::new();
            let accs: Vec<(String, OutputAcc)> = store
                .output_accumulator
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            for (sid, acc) in accs {
                let new_chars = acc.chars - acc.flushed_chars;
                if new_chars < 500 || now - acc.last_output_at < 8_000 {
                    continue;
                }
                let had_hook_data = store
                    .pending_estimation
                    .get(&sid)
                    .map(|p| p.tool_count > 0 || p.file_chars > 0.0 || p.context_chars > 0.0)
                    .unwrap_or(false);
                // Hooks working → no double-count, mark flushed and that's it.
                store
                    .output_accumulator
                    .get_mut(&sid)
                    .unwrap()
                    .flushed_chars = acc.chars;
                if !had_hook_data {
                    out.push((sid, new_chars));
                }
            }
            out
        };
        for (sid, chars) in to_estimate {
            self.estimate_from_output(app, &sid, chars);
        }
    }

    /// removeSession — cleanup.
    #[allow(dead_code)]
    pub(crate) fn remove_session(&self, session_id: &str) {
        self.persist_session(session_id);
        let mut store = self.store.lock();
        // SessionEnd is also emitted during provider changes: retain the totals.
        store.active_turns.remove(session_id);
        store.pending_estimation.remove(session_id);
        store.turn_tool_names.remove(session_id);
        store.edit_write_stats.remove(session_id);
        store.conversation_length.remove(session_id);
        store.output_accumulator.remove(session_id);
        store.last_tool_time.remove(session_id);
    }
}

/// addAnalytics — sums tokensSaved/occurrences on a key.
fn add_analytics(state: &mut SessionTokenState, key: &str, saved: i64, occurrences: i64) {
    let entry = state
        .optimization_analytics
        .entry(key.to_string())
        .or_default();
    entry.tokens_saved += saved;
    entry.occurrences += occurrences;
}

// ── token:* commands ──────────────────────────────────────────────────────

/// token:get-stats — stats of a session (null if missing).
#[tauri::command]
pub fn token_get_stats(
    app: AppHandle,
    tracker: tauri::State<'_, Arc<TokenTracker>>,
    session_id: String,
) -> Option<SessionTokenState> {
    tracker.restore_session(&app, &session_id);
    tracker.session_stats(&session_id)
}

/// token:get-all-stats — sessionId → stats map.
#[tauri::command]
pub fn token_get_all_stats(
    tracker: tauri::State<'_, Arc<TokenTracker>>,
) -> HashMap<String, SessionTokenState> {
    tracker.all_stats()
}

/// Payload of token:record-usage ({ inputTokens, outputTokens, totalTokens, provider }).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordUsageData {
    #[serde(default)]
    turn_id: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    provider: String,
    #[serde(default)]
    cache_read_tokens: Option<i64>,
    #[serde(default)]
    model: Option<String>,
}

/// Result of token:record-usage — { ok, record? , error? }.
#[derive(Serialize)]
pub struct RecordUsageResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record: Option<PromptTokenRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// token:record-usage — records the real tokens; emits token:usage-updated.
#[tauri::command]
pub fn token_record_usage(
    app: AppHandle,
    tracker: tauri::State<'_, Arc<TokenTracker>>,
    session_id: String,
    data: RecordUsageData,
) -> RecordUsageResult {
    let extras = UsageExtras {
        cache_read: data.cache_read_tokens.unwrap_or(0).max(0),
        cache_write: 0,
        model: data.model.clone(),
    };
    let record = tracker.record_actual_usage(
        &app,
        &session_id,
        data.input_tokens,
        data.output_tokens,
        data.total_tokens,
        &data.provider,
        true,
        data.turn_id.as_deref(),
        &extras,
    );
    RecordUsageResult {
        ok: true,
        record: Some(record),
        error: None,
    }
}

/// token:request-compact — the webapp is about to send /compact to the session:
/// the compaction that follows is attributed to (and measured for) PromptOps.
#[tauri::command]
pub fn token_request_compact(
    tracker: tauri::State<'_, Arc<TokenTracker>>,
    session_id: String,
) -> OkResult {
    tracker.mark_compact_requested(&session_id);
    OkResult::ok()
}

/// token:set-flags — sets the optimization flags; emits token:usage-updated.
#[tauri::command]
pub fn token_set_flags(
    app: AppHandle,
    tracker: tauri::State<'_, Arc<TokenTracker>>,
    session_id: String,
    flags: HashMap<String, bool>,
) -> OkResult {
    tracker.set_optimization_flags(&app, &session_id, flags);
    OkResult::ok()
}

// ═════════════════════════════════════════════════════════════════════════
// 2) OPTIMIZATION — file-read cache + the three optimization:* handlers.
// ═════════════════════════════════════════════════════════════════════════

/// CachedFile — entry for a file read in a session.
#[derive(Clone)]
struct CachedFile {
    hash: u64,
    size_chars: usize,
    read_count: i64,
}

/// FileReadCache — tracks file reads per session.
///
/// TODO: register listeners on the EventBus ('hook:tool-use'
/// for Reads, 'hook:session-end' for cleanup). The listeners depend on the
/// native HookManager; `track_file_read` / `clear_session` are the surface
/// ready for wiring.
#[derive(Default)]
pub struct FileReadCache {
    sessions: Mutex<HashMap<String, HashMap<String, CachedFile>>>,
    total_redundant_tokens_saved: Mutex<i64>,
}

impl FileReadCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Deterministic content hash (replaces md5 — only used to
    /// detect "unchanged", not for cryptographic purposes).
    fn content_hash(content: &str) -> u64 {
        // FNV-1a 64-bit.
        let mut h: u64 = 0xcbf29ce484222325;
        for b in content.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x00000100000001B3);
        }
        h
    }

    /// trackFileRead — returns the redundant tokens (0 if first read or file changed).
    pub(crate) fn track_file_read(&self, session_id: &str, file_path: &str) -> i64 {
        let content = match std::fs::read_to_string(file_path) {
            Ok(c) => c,
            Err(_) => return 0, // missing/unreadable file — not redundant
        };
        let current_hash = Self::content_hash(&content);
        let size_chars = content.chars().count();

        let mut sessions = self.sessions.lock();
        let cache = sessions.entry(session_id.to_string()).or_default();

        if let Some(existing) = cache.get_mut(file_path) {
            existing.read_count += 1;
            if existing.hash == current_hash {
                let redundant = round_js(size_chars as f64 * 0.25);
                *self.total_redundant_tokens_saved.lock() += redundant;
                return redundant;
            }
            existing.hash = current_hash;
            existing.size_chars = size_chars;
            return 0;
        }

        cache.insert(
            file_path.to_string(),
            CachedFile {
                hash: current_hash,
                size_chars,
                read_count: 1,
            },
        );
        0
    }

    /// getUnchangedFiles — files with readCount>1 still matching the hash.
    fn unchanged_files(&self, session_id: &str) -> Vec<UnchangedFile> {
        let sessions = self.sessions.lock();
        let Some(cache) = sessions.get(session_id) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (path, entry) in cache {
            if entry.read_count <= 1 {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(path) {
                if Self::content_hash(&content) == entry.hash {
                    out.push(UnchangedFile {
                        path: path.clone(),
                        read_count: entry.read_count,
                    });
                }
            }
        }
        out
    }

    /// getSessionStats.
    fn session_stats(&self, session_id: &str) -> Option<FileCacheStats> {
        let sessions = self.sessions.lock();
        let cache = sessions.get(session_id)?;
        let mut total_reads = 0i64;
        let mut redundant_reads = 0i64;
        let mut redundant_tokens = 0i64;
        for entry in cache.values() {
            total_reads += entry.read_count;
            if entry.read_count > 1 {
                redundant_reads += entry.read_count - 1;
                redundant_tokens +=
                    (entry.read_count - 1) * round_js(entry.size_chars as f64 * 0.25);
            }
        }
        Some(FileCacheStats {
            total_files_read: total_reads,
            unique_files_read: cache.len() as i64,
            redundant_reads,
            estimated_redundant_tokens: redundant_tokens,
        })
    }

    pub(crate) fn total_redundant_tokens_saved(&self) -> i64 {
        *self.total_redundant_tokens_saved.lock()
    }

    #[allow(dead_code)]
    pub(crate) fn clear_session(&self, session_id: &str) {
        self.sessions.lock().remove(session_id);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnchangedFile {
    path: String,
    read_count: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCacheStats {
    total_files_read: i64,
    unique_files_read: i64,
    redundant_reads: i64,
    estimated_redundant_tokens: i64,
}

/// Result of optimization:get-status.
#[derive(Serialize)]
pub struct OptimizationStatusResult {
    pub ok: bool,
    pub optimizations: OptimizationStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizationStatus {
    context_injection: bool,
    file_cache_active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_cache_stats: Option<FileCacheStats>,
    total_redundant_tokens_saved: i64,
}

/// Result of optimization:get-file-cache.
#[derive(Serialize)]
pub struct FileCacheResult {
    pub ok: bool,
    pub files: Vec<UnchangedFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<FileCacheStats>,
}

/// optimization:get-status — optimization flags and stats of a session.
#[tauri::command]
pub fn optimization_get_status(
    tracker: tauri::State<'_, Arc<TokenTracker>>,
    cache: tauri::State<'_, Arc<FileReadCache>>,
    session_id: String,
) -> OptimizationStatusResult {
    let stats = tracker.session_stats(&session_id);
    let file_cache_stats = cache.session_stats(&session_id);
    let context_injection = stats
        .as_ref()
        .map(|s| {
            *s.optimization_flags
                .get("used_context_injection")
                .unwrap_or(&false)
        })
        .unwrap_or(false);

    OptimizationStatusResult {
        ok: true,
        optimizations: OptimizationStatus {
            context_injection,
            file_cache_active: true, // fileReadCache is always present as State
            file_cache_stats,
            total_redundant_tokens_saved: cache.total_redundant_tokens_saved(),
        },
    }
}

/// optimization:refresh-context — force-refresh of the workspace context.
///
/// TODO: call ContextOptimizer + WorkspaceAnalyzer +
/// SessionManager (clearCache → analyze → generateContext → injectIntoWorkspace).
/// The context optimizer and workspace analyzer do not exist as State yet;
/// until they do we return the "Optimizer not available" result.
#[tauri::command]
pub fn optimization_refresh_context(_session_id: String) -> OkResult {
    OkResult::err("Optimizer not available")
}

/// optimization:get-file-cache — unchanged files + session stats.
#[tauri::command]
pub fn optimization_get_file_cache(
    cache: tauri::State<'_, Arc<FileReadCache>>,
    session_id: String,
) -> FileCacheResult {
    FileCacheResult {
        ok: true,
        files: cache.unchanged_files(&session_id),
        stats: cache.session_stats(&session_id),
    }
}

// ═════════════════════════════════════════════════════════════════════════
// 3) USAGE CENTER — usage store, aggregator, scanners and IPC handlers.
// In-memory ring buffer, rollup by provider/model/session/trend, usage.json
// persistence, on-disk scanner (Claude Code + Codex) with ScanIndex.
// ═════════════════════════════════════════════════════════════════════════

const MAX_RING: usize = 5000;
const MAX_ENTRIES_ON_DISK: usize = 2000;

/// UsageEntry — usage record shared with the web UI (camelCase).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    session_id: String,
    session_name: String,
    provider: String,
    model: String,
    workspace_path: Option<String>,
    workspace_name: Option<String>,
    timestamp: i64,
    tokens_used: i64,
    tokens_estimated: i64,
    tokens_saved: i64,
    efficiency: f64,
    cost_usd: f64,
    prompt_count: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBreakdown {
    key: String,
    label: String,
    tokens: i64,
    cost: f64,
    share: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSessionRow {
    session_id: String,
    name: String,
    provider: String,
    model: String,
    workspace_name: Option<String>,
    tokens: i64,
    saved: i64,
    cost: f64,
    efficiency: f64,
    last_seen: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTrendPoint {
    bucket: String,
    tokens: i64,
    cost: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    tokens: i64,
    tokens_saved: i64,
    cost: f64,
    efficiency: f64,
    sessions: i64,
    prompts: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    window: String,
    generated_at: i64,
    totals: UsageTotals,
    by_provider: Vec<UsageBreakdown>,
    by_model: Vec<UsageBreakdown>,
    top_sessions: Vec<UsageSessionRow>,
    trend: Vec<UsageTrendPoint>,
}

fn window_ms(window: &str) -> i64 {
    match window {
        "24h" => 24 * 60 * 60 * 1000,
        "7d" => 7 * 24 * 60 * 60 * 1000,
        "30d" => 30 * 24 * 60 * 60 * 1000,
        _ => 7 * 24 * 60 * 60 * 1000, // default 7d (also for 'all', the cutoff is handled separately)
    }
}

fn provider_label(id: &str) -> String {
    match id {
        "claude-code-cli" => "Claude Code",
        "codex" => "Codex",
        "gemini-cli" => "Gemini",
        "antigravity" => "Antigravity",
        "copilot" => "Copilot",
        "cursor" => "Cursor",
        "grok" => "Grok",
        "hermes" => "Hermes",
        "muse" => "Muse Code",
        "zai" => "Z.AI",
        "kimi" => "Kimi",
        "opencode" => "OpenCode",
        "kora" => "Kora",
        "promptops-cli" => "PromptOps",
        "generic-shell" => "Shell",
        other => return other.to_string(),
    }
    .to_string()
}

/// UsageStore — usage.json persistence.
struct UsageStore {
    path: PathBuf,
}

impl UsageStore {
    fn new() -> Self {
        Self {
            path: promptops_dir().join("usage.json"),
        }
    }

    fn load(&self) -> Vec<UsageEntry> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|raw| serde_json::from_str::<JsonValue>(&raw).ok())
            .and_then(|v| v.get("entries").cloned())
            .and_then(|e| serde_json::from_value::<Vec<UsageEntry>>(e).ok())
            .unwrap_or_default()
    }

    /// flushNow — writes at most MAX_ENTRIES_ON_DISK entries (the latest).
    fn flush_now(&self, entries: &[UsageEntry]) {
        let start = entries.len().saturating_sub(MAX_ENTRIES_ON_DISK);
        let slice = &entries[start..];
        let body = json!({ "version": 1, "savedAt": now_ms(), "entries": slice });
        if let Ok(s) = serde_json::to_string(&body) {
            let _ = std::fs::write(&self.path, s);
        }
    }

    fn clear(&self) {
        let body = json!({ "version": 1, "savedAt": now_ms(), "entries": [] });
        if let Ok(s) = serde_json::to_string(&body) {
            let _ = std::fs::write(&self.path, s);
        }
    }
}

struct AggregatorState {
    ring: Vec<UsageEntry>,
}

/// UsageAggregator — in-memory usage rollups: query (getSummary), persistence
/// and scanner ingest.
pub struct UsageAggregator {
    state: Mutex<AggregatorState>,
    store: UsageStore,
}

impl Default for UsageAggregator {
    fn default() -> Self {
        Self::new()
    }
}

impl UsageAggregator {
    pub fn new() -> Self {
        let store = UsageStore::new();
        let ring = store.load();
        Self {
            state: Mutex::new(AggregatorState { ring }),
            store,
        }
    }

    /// getSummary — full rollup for the requested window.
    fn get_summary(&self, window: &str) -> UsageSummary {
        let st = self.state.lock();
        let now = now_ms();
        let cutoff = if window == "all" {
            0
        } else {
            now - window_ms(window)
        };
        let slice: Vec<&UsageEntry> = st.ring.iter().filter(|e| e.timestamp >= cutoff).collect();

        let total_tokens: i64 = slice.iter().map(|e| e.tokens_used).sum();
        let by_provider = rollup(&slice, total_tokens, |e| {
            (e.provider.clone(), provider_label(&e.provider))
        });
        let by_model = rollup(&slice, total_tokens, |e| (e.model.clone(), e.model.clone()));
        let top_sessions = session_rollup(&slice);
        let trend = build_trend(&slice, window, now);

        let tokens = total_tokens;
        let tokens_saved: i64 = slice.iter().map(|e| e.tokens_saved).sum();
        let cost: f64 = slice.iter().map(|e| e.cost_usd).sum();
        // saved / (used + saved): tokens_estimated is not used, because in entries already
        // saved to disk by the Claude scanner it equals used (not used + saved).
        let efficiency = usage_efficiency(tokens, tokens_saved);
        let sessions = slice
            .iter()
            .map(|e| &e.session_id)
            .collect::<HashSet<_>>()
            .len() as i64;
        let prompts = slice.len() as i64;

        UsageSummary {
            window: window.to_string(),
            generated_at: now,
            totals: UsageTotals {
                tokens,
                tokens_saved,
                cost,
                efficiency,
                sessions,
                prompts,
            },
            by_provider,
            by_model,
            top_sessions,
            trend,
        }
    }

    /// ingestScanned — imports on-disk scanner entries with safety-net dedup.
    fn ingest_scanned(&self, entries: Vec<UsageEntry>) -> (usize, usize) {
        if entries.is_empty() {
            return (0, 0);
        }
        let mut st = self.state.lock();
        let mut seen: HashSet<String> = st.ring.iter().map(dedup_key).collect();
        let mut added = 0usize;
        let mut skipped = 0usize;
        for entry in entries {
            let key = dedup_key(&entry);
            if seen.contains(&key) {
                skipped += 1;
                continue;
            }
            seen.insert(key);
            st.ring.push(entry);
            added += 1;
        }
        if st.ring.len() > MAX_RING {
            let excess = st.ring.len() - MAX_RING;
            st.ring.drain(0..excess);
        }
        st.ring.sort_by_key(|e| e.timestamp);
        self.store.flush_now(&st.ring);
        (added, skipped)
    }

    /// clear — empties ring + persistence.
    fn clear(&self) {
        let mut st = self.state.lock();
        st.ring.clear();
        self.store.clear();
    }
}

fn dedup_key(e: &UsageEntry) -> String {
    format!(
        "{}|{}|{}|{}",
        e.provider, e.session_id, e.timestamp, e.tokens_used
    )
}

fn rollup<F>(entries: &[&UsageEntry], total_tokens: i64, key_of: F) -> Vec<UsageBreakdown>
where
    F: Fn(&UsageEntry) -> (String, String),
{
    let mut map: HashMap<String, (String, i64, f64)> = HashMap::new();
    // Preserve insertion order for secondary sort stability.
    let mut order: Vec<String> = Vec::new();
    for e in entries {
        let (key, label) = key_of(e);
        let entry = map.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            (label, 0, 0.0)
        });
        entry.1 += e.tokens_used;
        entry.2 += e.cost_usd;
    }
    let total = if total_tokens == 0 {
        1.0
    } else {
        total_tokens as f64
    };
    let mut out: Vec<UsageBreakdown> = order
        .into_iter()
        .map(|key| {
            let (label, tokens, cost) = map.remove(&key).unwrap();
            UsageBreakdown {
                key,
                label,
                tokens,
                cost,
                share: tokens as f64 / total,
            }
        })
        .collect();
    out.sort_by_key(|b| std::cmp::Reverse(b.tokens));
    out
}

fn session_rollup(entries: &[&UsageEntry]) -> Vec<UsageSessionRow> {
    let mut map: HashMap<String, UsageSessionRow> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for e in entries {
        if let Some(prev) = map.get_mut(&e.session_id) {
            prev.tokens += e.tokens_used;
            prev.saved += e.tokens_saved;
            prev.cost += e.cost_usd;
            prev.last_seen = prev.last_seen.max(e.timestamp);
            // The ring is in time order: the last non-empty name wins (later
            // scans find the conversation title).
            if !e.session_name.trim().is_empty() {
                prev.name = e.session_name.clone();
            }
            if prev.workspace_name.is_none() {
                prev.workspace_name = e.workspace_name.clone();
            }
        } else {
            order.push(e.session_id.clone());
            map.insert(
                e.session_id.clone(),
                UsageSessionRow {
                    session_id: e.session_id.clone(),
                    name: e.session_name.clone(),
                    provider: e.provider.clone(),
                    model: e.model.clone(),
                    workspace_name: e.workspace_name.clone(),
                    tokens: e.tokens_used,
                    saved: e.tokens_saved,
                    cost: e.cost_usd,
                    efficiency: e.efficiency,
                    last_seen: e.timestamp,
                },
            );
        }
    }
    let mut out: Vec<UsageSessionRow> = order
        .into_iter()
        .map(|k| {
            let mut row = map.remove(&k).unwrap();
            // Row efficiency from the session totals, same formula as the total.
            row.efficiency = usage_efficiency(row.tokens, row.saved);
            row.name = display_session_name(&row.name, row.workspace_name.as_deref());
            row
        })
        .collect();
    out.sort_by_key(|b| std::cmp::Reverse(b.tokens));
    out.truncate(20);
    out
}

fn build_trend(entries: &[&UsageEntry], window: &str, now: i64) -> Vec<UsageTrendPoint> {
    let buckets: i64 = match window {
        "24h" => 24,
        "7d" => 7,
        _ => 30,
    };
    let bucket_ms: i64 = if window == "24h" {
        60 * 60 * 1000
    } else {
        24 * 60 * 60 * 1000
    };
    let base = now - buckets * bucket_ms;
    let mut points = Vec::with_capacity(buckets as usize);
    for i in 0..buckets {
        let start = base + i * bucket_ms;
        let end = start + bucket_ms;
        let tokens: i64 = entries
            .iter()
            .filter(|e| e.timestamp >= start && e.timestamp < end)
            .map(|e| e.tokens_used)
            .sum();
        let cost: f64 = entries
            .iter()
            .filter(|e| e.timestamp >= start && e.timestamp < end)
            .map(|e| e.cost_usd)
            .sum();
        let iso = iso_from_ms(start);
        let label = if window == "24h" {
            // toISOString().slice(11,13) + 'h'
            format!("{}h", &iso[11..13])
        } else {
            // toISOString().slice(5,10)
            iso[5..10].to_string()
        };
        points.push(UsageTrendPoint {
            bucket: label,
            tokens,
            cost,
        });
    }
    points
}

// ── usage:* commands ───────────────────────────────────────────────────────

/// usage:get-summary — summary per window ('24h'|'7d'|'30d'|'all', default 7d).
#[tauri::command]
pub fn usage_get_summary(
    aggregator: tauri::State<'_, Arc<UsageAggregator>>,
    window: Option<String>,
) -> UsageSummary {
    aggregator.get_summary(&window.unwrap_or_else(|| "7d".into()))
}

/// Result of usage:export — { ok, path?, error? }.
#[derive(Serialize)]
pub struct ExportResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// usage:export — serializes the summary to JSON/CSV and saves it to disk.
///
/// TODO: let the user choose the path. Here we save to the promptops data dir
/// with the default name `promptops-usage-<window>-<YYYY-MM-DD>.<fmt>`;
/// the native file picker must be wired with `tauri-plugin-dialog` when available
/// (replacing the default_path line → return 'canceled' on cancel).
#[tauri::command]
pub fn usage_export(
    aggregator: tauri::State<'_, Arc<UsageAggregator>>,
    window: Option<String>,
    format: Option<String>,
) -> ExportResult {
    // Both end up in the file name: only the known values, never a path.
    let window = match window.as_deref() {
        Some(w @ ("24h" | "7d" | "30d" | "all")) => w.to_string(),
        None => "7d".into(),
        Some(_) => {
            return ExportResult {
                ok: false,
                path: None,
                error: Some("unsupported window".into()),
            }
        }
    };
    let format = match format.as_deref() {
        Some(f @ ("json" | "csv")) => f.to_string(),
        None => "json".into(),
        Some(_) => {
            return ExportResult {
                ok: false,
                path: None,
                error: Some("unsupported format".into()),
            }
        }
    };
    let summary = aggregator.get_summary(&window);
    let day = &now_iso()[0..10]; // toISOString().slice(0,10)
    let default_name = format!("promptops-usage-{window}-{day}.{format}");
    let path = promptops_dir().join(&default_name);

    let body = if format == "json" {
        match serde_json::to_string_pretty(&summary) {
            Ok(s) => s,
            Err(e) => {
                return ExportResult {
                    ok: false,
                    path: None,
                    error: Some(e.to_string()),
                }
            }
        }
    } else {
        summary_to_csv(&summary)
    };

    match std::fs::write(&path, body) {
        Ok(()) => ExportResult {
            ok: true,
            path: Some(path.to_string_lossy().into_owned()),
            error: None,
        },
        Err(e) => ExportResult {
            ok: false,
            path: None,
            error: Some(e.to_string()),
        },
    }
}

/// usage:clear — empties the ring buffer, the scan index and the file on disk.
#[tauri::command]
pub fn usage_clear(aggregator: tauri::State<'_, Arc<UsageAggregator>>) -> OkResult {
    aggregator.clear();
    ScanIndex::new().clear();
    OkResult::ok()
}

/// Result of usage:run-scan — { ok, added?, skipped?, report?, error? }.
#[derive(Serialize)]
pub struct ScanResultDto {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Global scan anti-concurrency guard (a single module-level flag).
static SCANNING: AtomicBool = AtomicBool::new(false);

/// usage:run-scan — runs all on-disk scanners, ingests into the ring,
/// pushes the state on `usage:scan-status`.
/// spawn_blocking: the scanners read every JSONL on disk — seconds of IO
/// that on the main thread (sync command) froze the UI.
#[tauri::command]
pub async fn usage_run_scan(
    app: AppHandle,
    aggregator: tauri::State<'_, Arc<UsageAggregator>>,
) -> Result<ScanResultDto, String> {
    let aggregator = aggregator.inner().clone();
    tauri::async_runtime::spawn_blocking(move || usage_run_scan_impl(app, &aggregator))
        .await
        .map_err(|e| e.to_string())
}

fn usage_run_scan_impl(app: AppHandle, aggregator: &Arc<UsageAggregator>) -> ScanResultDto {
    if SCANNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return ScanResultDto {
            ok: false,
            added: None,
            skipped: None,
            report: None,
            error: Some("already-scanning".into()),
        };
    }

    let _ = app.emit(USAGE_SCAN_STATUS, json!({ "phase": "scanning" }));

    let mut index = ScanIndex::new();
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_all_scans(&mut index)));

    let out = match result {
        Ok((entries, report)) => {
            let (added, skipped) = aggregator.ingest_scanned(entries);
            let _ = app.emit(
                USAGE_SCAN_STATUS,
                json!({ "phase": "idle", "lastReport": report, "added": added, "skipped": skipped }),
            );
            ScanResultDto {
                ok: true,
                added: Some(added),
                skipped: Some(skipped),
                report: Some(report),
                error: None,
            }
        }
        Err(_) => {
            let msg = "scan failed".to_string();
            let _ = app.emit(USAGE_SCAN_STATUS, json!({ "phase": "idle", "error": msg }));
            ScanResultDto {
                ok: false,
                added: None,
                skipped: None,
                report: None,
                error: Some(msg),
            }
        }
    };

    SCANNING.store(false, Ordering::SeqCst);
    out
}

/// Usage export → CSV.
fn summary_to_csv(summary: &UsageSummary) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push("section,key,label,tokens,cost_usd,share".into());
    for b in &summary.by_provider {
        lines.push(format!(
            "provider,{},{},{},{:.4},{:.4}",
            esc(&b.key),
            esc(&b.label),
            b.tokens,
            b.cost,
            b.share
        ));
    }
    for b in &summary.by_model {
        lines.push(format!(
            "model,{},{},{},{:.4},{:.4}",
            esc(&b.key),
            esc(&b.label),
            b.tokens,
            b.cost,
            b.share
        ));
    }
    lines.push(String::new());
    lines.push(
        "session_id,name,provider,model,workspace,tokens,saved,cost_usd,efficiency,last_seen"
            .into(),
    );
    for s in &summary.top_sessions {
        lines.push(
            [
                esc(&s.session_id),
                esc(&s.name),
                esc(&s.provider),
                esc(&s.model),
                esc(s.workspace_name.as_deref().unwrap_or("")),
                s.tokens.to_string(),
                s.saved.to_string(),
                format!("{:.4}", s.cost),
                fmt_efficiency(s.efficiency),
                iso_from_ms(s.last_seen),
            ]
            .join(","),
        );
    }
    lines.join("\n")
}

/// Replica of the JS number in CSV (integers without decimals, otherwise minimal).
fn fmt_efficiency(v: f64) -> String {
    if v.fract() == 0.0 {
        format!("{}", v as i64)
    } else {
        let s = format!("{v}");
        s
    }
}

fn esc(v: &str) -> String {
    if v.contains(['"', ',', '\n']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

// ── Pricing (subset of the pricing table used by usage) ──

struct ModelPricing {
    label: String,
    input_per_m: f64,
    output_per_m: f64,
    cache_read_per_m: f64,
    cache_write_per_m: f64,
}

/// resolvePricing(provider, modelHint) — substring match on model ids.
fn resolve_pricing(provider: &str, model_hint: Option<&str>) -> ModelPricing {
    // (key, label, input, output, cacheRead, cacheWrite). default_model = first element.
    let table: &[(&str, &[(&str, &str, f64, f64, f64, f64)])] = &[
        (
            "claude-code-cli",
            &[
                // Claude 5 family before legacy: matching is by substring, in order.
                // opus-5 first = default_model.
                ("opus-5", "Claude Opus 5", 5.0, 25.0, 0.5, 6.25),
                ("opus-5-5", "Claude Opus 5.5", 5.0, 25.0, 0.5, 6.25),
                // fable-5-1 before fable-5: matching is by substring, in order.
                ("fable-5-1", "Claude Fable 5.1", 10.0, 50.0, 1.0, 12.5),
                ("fable-5", "Claude Fable 5", 10.0, 50.0, 1.0, 12.5),
                ("mythos-5", "Claude Mythos 5", 10.0, 50.0, 1.0, 12.5),
                ("sonnet-5", "Claude Sonnet 5", 3.0, 15.0, 0.3, 3.75),
                ("opus-4-6", "Claude Opus 4.6", 5.0, 25.0, 0.5, 6.25),
                ("sonnet-4-6", "Claude Sonnet 4.6", 3.0, 15.0, 0.3, 3.75),
                ("haiku-4-5", "Claude Haiku 4.5", 1.0, 5.0, 0.1, 1.25),
                ("opus-4", "Claude Opus 4", 15.0, 75.0, 1.5, 18.75),
                ("sonnet-4", "Claude Sonnet 4", 3.0, 15.0, 0.3, 3.75),
            ],
        ),
        (
            "codex",
            &[
                // gpt-6 before codex: matching is by substring, in order (prices = gpt-5, to be verified).
                ("gpt-6", "OpenAI GPT-6", 1.25, 10.0, 0.125, 0.0),
                ("codex", "OpenAI Codex", 2.5, 10.0, 1.25, 2.5),
                ("o3", "OpenAI o3", 10.0, 40.0, 2.5, 10.0),
                ("o4-mini", "OpenAI o4-mini", 1.1, 4.4, 0.275, 1.1),
            ],
        ),
        (
            "gemini-cli",
            &[
                ("2.5-pro", "Gemini 2.5 Pro", 1.25, 10.0, 0.315, 4.5),
                ("2.5-flash", "Gemini 2.5 Flash", 0.15, 0.6, 0.0375, 0.15),
            ],
        ),
        (
            "copilot",
            &[("copilot", "GitHub Copilot", 0.0, 0.0, 0.0, 0.0)],
        ),
        ("cursor", &[("cursor", "Cursor", 0.0, 0.0, 0.0, 0.0)]),
        (
            "grok",
            &[
                ("grok-4", "Grok 4", 3.0, 15.0, 0.75, 3.0),
                ("grok-code", "Grok Code Fast", 0.2, 1.5, 0.02, 0.2),
            ],
        ),
        ("opencode", &[("opencode", "OpenCode", 0.0, 0.0, 0.0, 0.0)]),
        // Subscription providers: no per-token list price → cost 0.
        (
            "antigravity",
            &[("antigravity", "Google Antigravity", 0.0, 0.0, 0.0, 0.0)],
        ),
        ("hermes", &[("hermes", "Hermes", 0.0, 0.0, 0.0, 0.0)]),
        ("muse", &[("muse", "Muse Code", 0.0, 0.0, 0.0, 0.0)]),
        // kora is multi-provider inside its own CLI: usage is billed by the
        // configured backend, not per-token list price here → cost 0.
        ("kora", &[("kora", "Kora", 0.0, 0.0, 0.0, 0.0)]),
        ("zai", &[("glm", "Z.AI GLM", 0.0, 0.0, 0.0, 0.0)]),
        ("kimi", &[("kimi", "Kimi", 0.0, 0.0, 0.0, 0.0)]),
        (
            "promptops-cli",
            &[("promptops", "PromptOps", 0.0, 0.0, 0.0, 0.0)],
        ),
        ("generic-shell", &[("none", "Shell", 0.0, 0.0, 0.0, 0.0)]),
    ];

    let Some((_, models)) = table.iter().find(|(p, _)| *p == provider) else {
        return ModelPricing {
            label: provider.to_string(),
            input_per_m: 0.0,
            output_per_m: 0.0,
            cache_read_per_m: 0.0,
            cache_write_per_m: 0.0,
        };
    };

    if let Some(hint) = model_hint {
        let lower = hint.to_lowercase();
        // The longest contained key wins: "claude-opus-5-5" must not
        // fall on "opus-5" just because it comes first in the table.
        if let Some((_, label, i, o, cr, cw)) = models
            .iter()
            .filter(|(key, ..)| lower.contains(key))
            .max_by_key(|(key, ..)| key.len())
        {
            return ModelPricing {
                label: label.to_string(),
                input_per_m: *i,
                output_per_m: *o,
                cache_read_per_m: *cr,
                cache_write_per_m: *cw,
            };
        }
    }

    // Fallback: default model = first (default_models match the first entry).
    let (_, label, i, o, cr, cw) = models[0];
    ModelPricing {
        label: label.to_string(),
        input_per_m: i,
        output_per_m: o,
        cache_read_per_m: cr,
        cache_write_per_m: cw,
    }
}

// ── ScanIndex ──────────────────────────────────────────────────────────

struct FileState {
    mtime_ms: i64,
    size: u64,
    seen_ids: Vec<String>,
}

struct ScanIndex {
    path: PathBuf,
    state: HashMap<String, FileState>,
}

impl ScanIndex {
    fn new() -> Self {
        let path = promptops_dir().join("usage-scan-index.json");
        let mut idx = Self {
            path,
            state: HashMap::new(),
        };
        idx.load();
        idx
    }

    fn load(&mut self) {
        let Ok(raw) = std::fs::read_to_string(&self.path) else {
            return;
        };
        let Ok(parsed) = serde_json::from_str::<JsonValue>(&raw) else {
            return;
        };
        let Some(files) = parsed.get("files").and_then(|f| f.as_object()) else {
            return;
        };
        for (k, v) in files {
            let mtime_ms = v.get("mtimeMs").and_then(|x| x.as_f64()).unwrap_or(0.0) as i64;
            let size = v.get("size").and_then(|x| x.as_u64()).unwrap_or(0);
            let seen_ids = v
                .get("seenIds")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|s| s.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            self.state.insert(
                k.clone(),
                FileState {
                    mtime_ms,
                    size,
                    seen_ids,
                },
            );
        }
    }

    fn save(&mut self) {
        // Transcripts the CLIs deleted (or that moved) would stay in the index
        // forever, each with up to 5000 ids: the file only ever grew.
        self.state
            .retain(|path, _| std::path::Path::new(path).exists());
        let mut files = serde_json::Map::new();
        for (k, v) in &self.state {
            files.insert(
                k.clone(),
                json!({
                    "mtimeMs": v.mtime_ms,
                    "size": v.size,
                    "scannedAt": now_ms(),
                    "seenIds": v.seen_ids,
                }),
            );
        }
        let body = json!({ "version": 1, "savedAt": now_ms(), "files": files });
        if let Ok(s) = serde_json::to_string(&body) {
            let _ = std::fs::write(&self.path, s);
        }
    }

    fn is_unchanged(&self, file_path: &str, mtime_ms: i64, size: u64) -> bool {
        match self.state.get(file_path) {
            Some(prev) => prev.mtime_ms == mtime_ms && prev.size == size,
            None => false,
        }
    }

    fn get_seen_ids(&self, file_path: &str) -> HashSet<String> {
        self.state
            .get(file_path)
            .map(|s| s.seen_ids.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn upsert_file(
        &mut self,
        file_path: &str,
        mtime_ms: i64,
        size: u64,
        seen_ids: HashSet<String>,
    ) {
        let mut capped: Vec<String> = seen_ids.into_iter().collect();
        let start = capped.len().saturating_sub(5000);
        capped = capped.split_off(start);
        self.state.insert(
            file_path.to_string(),
            FileState {
                mtime_ms,
                size,
                seen_ids: capped,
            },
        );
    }

    fn clear(&mut self) {
        self.state.clear();
        self.save();
    }
}

// ── Scanner runner + Claude Code / Codex scanners ──────────────────────────

struct SourceReport {
    files_scanned: i64,
    files_skipped: i64,
    lines_parsed: i64,
    duration_ms: i64,
    error: Option<String>,
}

/// runAllScans — Claude Code + Codex, incremental via ScanIndex.
fn run_all_scans(index: &mut ScanIndex) -> (Vec<UsageEntry>, JsonValue) {
    let started = now_ms();
    let mut all: Vec<UsageEntry> = Vec::new();
    let mut sources = serde_json::Map::new();

    let (cc_entries, cc_report) = scan_claude_code(index);
    all.extend(cc_entries);
    sources.insert("claude-code".into(), source_report_json(&cc_report));

    let (cx_entries, cx_report) = scan_codex(index);
    all.extend(cx_entries);
    sources.insert("codex".into(), source_report_json(&cx_report));

    index.save();

    let finished = now_ms();
    let report = json!({
        "startedAt": started,
        "finishedAt": finished,
        "durationMs": finished - started,
        "sources": sources,
        "totalEntries": all.len(),
    });
    (all, report)
}

fn source_report_json(r: &SourceReport) -> JsonValue {
    let mut o = json!({
        "filesScanned": r.files_scanned,
        "filesSkipped": r.files_skipped,
        "linesParsed": r.lines_parsed,
        "durationMs": r.duration_ms,
    });
    if let Some(err) = &r.error {
        o["error"] = json!(err);
    }
    o
}

/// walkFiles — recursive descent (depth cap 6) collecting .jsonl paths.
fn walk_jsonl(root: &std::path::Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            walk_jsonl(&path, depth + 1, out);
        } else if ft.is_file() && path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            out.push(path);
        }
    }
}

/// readableWorkspaceName — decodes Claude Code's escaped dir.
fn readable_workspace_name(escaped_dir: &str) -> (String, String) {
    // Windows drive-letter heuristic: `C--…`.
    let win_drive = escaped_dir
        .as_bytes()
        .first()
        .map(|c| c.is_ascii_alphabetic())
        .unwrap_or(false)
        && escaped_dir.get(1..3) == Some("--");
    let decoded = if win_drive {
        let drive = escaped_dir[0..1].to_uppercase();
        let rest = escaped_dir[3..].replace('-', "/");
        format!("{drive}:/{rest}")
    } else {
        let trimmed = escaped_dir.strip_prefix('-').unwrap_or(escaped_dir);
        format!("/{}", trimmed.replace('-', "/"))
    };
    let name = {
        let b = basename(&decoded);
        if b.is_empty() {
            escaped_dir.to_string()
        } else {
            b
        }
    };
    (decoded, name)
}

/// scanClaudeCode — ~/.claude/projects/<escaped>/<sessionId>.jsonl.
fn scan_claude_code(index: &mut ScanIndex) -> (Vec<UsageEntry>, SourceReport) {
    let started = now_ms();
    let mut report = SourceReport {
        files_scanned: 0,
        files_skipped: 0,
        lines_parsed: 0,
        duration_ms: 0,
        error: None,
    };
    let mut entries: Vec<UsageEntry> = Vec::new();

    let root = PathBuf::from(home_dir()).join(".claude").join("projects");
    if !root.exists() {
        report.duration_ms = now_ms() - started;
        return (entries, report);
    }

    let mut files = Vec::new();
    walk_jsonl(&root, 0, &mut files);

    for file_path in files {
        let Ok(meta) = std::fs::metadata(&file_path) else {
            continue;
        };
        let mtime_ms = file_mtime_ms(&meta);
        let size = meta.len();
        let fp = file_path.to_string_lossy().to_string();

        if index.is_unchanged(&fp, mtime_ms, size) {
            report.files_skipped += 1;
            continue;
        }

        let mut seen = index.get_seen_ids(&fp);
        let workspace_escaped = file_path
            .parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let (decoded_path, decoded_name) = readable_workspace_name(&workspace_escaped);
        let mut workspace_path = decoded_path;
        let mut workspace_name = decoded_name;
        let mut cwd_resolved = false;
        let mut line_count = 0i64;
        // Conversation title: /rename (custom-title) → first user prompt →
        // summary. Applied at end of file to all of the file's entries.
        let mut custom_title: Option<String> = None;
        let mut first_prompt: Option<String> = None;
        let mut summary_title: Option<String> = None;
        let mut file_entries: Vec<UsageEntry> = Vec::new();

        let Ok(content) = std::fs::read_to_string(&file_path) else {
            continue;
        };
        for raw in content.lines() {
            let line = raw.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<JsonValue>(line) else {
                continue;
            };
            line_count += 1;

            match v.get("type").and_then(|t| t.as_str()) {
                Some("custom-title") => {
                    if let Some(t) = v
                        .get("customTitle")
                        .and_then(|x| x.as_str())
                        .and_then(summarize_prompt)
                    {
                        custom_title = Some(t);
                    }
                }
                Some("summary") if summary_title.is_none() => {
                    summary_title = v
                        .get("summary")
                        .and_then(|x| x.as_str())
                        .and_then(summarize_prompt);
                }
                Some("user") if first_prompt.is_none() => {
                    first_prompt = claude_user_text(&v).as_deref().and_then(summarize_prompt);
                }
                _ => {}
            }

            if !cwd_resolved {
                if let Some(cwd) = v.get("cwd").and_then(|c| c.as_str()) {
                    workspace_path = cwd.to_string();
                    let b = basename(cwd);
                    if !b.is_empty() {
                        workspace_name = b;
                    }
                    cwd_resolved = true;
                }
            }

            if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
                continue;
            }
            let Some(usage) = v.pointer("/message/usage") else {
                continue;
            };

            let message_id = v
                .pointer("/message/id")
                .and_then(|x| x.as_str())
                .or_else(|| v.get("uuid").and_then(|x| x.as_str()));
            let Some(message_id) = message_id else {
                continue;
            };
            if seen.contains(message_id) {
                continue;
            }
            seen.insert(message_id.to_string());

            let input = usage
                .get("input_tokens")
                .and_then(|x| x.as_i64())
                .unwrap_or(0);
            let output = usage
                .get("output_tokens")
                .and_then(|x| x.as_i64())
                .unwrap_or(0);
            let cache_read = usage
                .get("cache_read_input_tokens")
                .and_then(|x| x.as_i64())
                .unwrap_or(0);
            let cache_write = usage
                .get("cache_creation_input_tokens")
                .and_then(|x| x.as_i64())
                .unwrap_or(0);
            let tokens_used = input + output + cache_read + cache_write;
            if tokens_used == 0 {
                continue;
            }

            let model = v
                .pointer("/message/model")
                .and_then(|x| x.as_str())
                .unwrap_or("unknown");
            let pricing = resolve_pricing("claude-code-cli", Some(model));
            let cost_usd = (input as f64 * pricing.input_per_m
                + output as f64 * pricing.output_per_m
                + cache_read as f64 * pricing.cache_read_per_m
                + cache_write as f64 * pricing.cache_write_per_m)
                / 1_000_000.0;

            let timestamp = v
                .get("timestamp")
                .and_then(|t| t.as_str())
                .and_then(parse_iso_ms)
                .unwrap_or(mtime_ms);

            let tokens_saved = if cache_read > 0 {
                let ratio = 1.0 - pricing.cache_read_per_m / pricing.input_per_m.max(0.0001);
                round_js(cache_read as f64 * ratio).max(0)
            } else {
                0
            };

            let session_id = v
                .get("sessionId")
                .and_then(|s| s.as_str())
                .map(String::from)
                .unwrap_or_else(|| format!("cc-{}", basename_ext(&fp, ".jsonl")));

            file_entries.push(UsageEntry {
                session_id,
                session_name: workspace_name.clone(),
                provider: "claude-code-cli".into(),
                model: pricing.label.clone(),
                workspace_path: Some(workspace_path.clone()),
                workspace_name: Some(workspace_name.clone()),
                timestamp,
                tokens_used,
                // Baseline without cache = used + saved (it used to be = used).
                tokens_estimated: tokens_used + tokens_saved,
                tokens_saved,
                efficiency: usage_efficiency(tokens_used, tokens_saved),
                cost_usd,
                prompt_count: 1,
            });
        }

        let title = custom_title.or(first_prompt).or(summary_title);
        for mut e in file_entries {
            e.session_name = match &title {
                Some(t) => t.clone(),
                None => display_session_name(&e.session_name, e.workspace_path.as_deref()),
            };
            entries.push(e);
        }

        report.files_scanned += 1;
        report.lines_parsed += line_count;
        index.upsert_file(&fp, mtime_ms, size, seen);
    }

    report.duration_ms = now_ms() - started;
    (entries, report)
}

/// scanCodex — ~/.codex/sessions/<Y>/<M>/<D>/<id>.jsonl.
fn scan_codex(index: &mut ScanIndex) -> (Vec<UsageEntry>, SourceReport) {
    let started = now_ms();
    let mut report = SourceReport {
        files_scanned: 0,
        files_skipped: 0,
        lines_parsed: 0,
        duration_ms: 0,
        error: None,
    };
    let mut entries: Vec<UsageEntry> = Vec::new();

    let root = PathBuf::from(home_dir()).join(".codex").join("sessions");
    if !root.exists() {
        report.duration_ms = now_ms() - started;
        return (entries, report);
    }

    let mut files = Vec::new();
    walk_jsonl(&root, 0, &mut files);

    for file_path in files {
        let Ok(meta) = std::fs::metadata(&file_path) else {
            continue;
        };
        let mtime_ms = file_mtime_ms(&meta);
        let size = meta.len();
        let fp = file_path.to_string_lossy().to_string();

        if index.is_unchanged(&fp, mtime_ms, size) {
            report.files_skipped += 1;
            continue;
        }

        let mut seen = index.get_seen_ids(&fp);
        let mut session_id = format!("codex-{}", basename_ext(&fp, ".jsonl"));
        let mut cwd: Option<String> = None;
        let mut line_count = 0i64;

        let Ok(content) = std::fs::read_to_string(&file_path) else {
            continue;
        };
        for raw in content.lines() {
            let line = raw.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<JsonValue>(line) else {
                continue;
            };
            line_count += 1;

            if let Some(sid) = v.get("session_id").and_then(|x| x.as_str()) {
                session_id = sid.to_string();
            }
            if let Some(sid) = v.get("sessionId").and_then(|x| x.as_str()) {
                session_id = sid.to_string();
            }
            if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                cwd = Some(c.to_string());
            }

            // turn = info.last_token_usage ?? usage.
            let turn = v
                .pointer("/info/last_token_usage")
                .or_else(|| v.get("usage"));
            let Some(turn) = turn else { continue };

            let input = turn
                .get("input_tokens")
                .and_then(|x| x.as_i64())
                .unwrap_or(0);
            let output = turn
                .get("output_tokens")
                .and_then(|x| x.as_i64())
                .unwrap_or(0);
            let total_from_line = turn
                .get("total_tokens")
                .and_then(|x| x.as_i64())
                .unwrap_or(input + output);
            if total_from_line == 0 {
                continue;
            }

            let id_part = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
            let ts_part = v
                .get("timestamp")
                .and_then(|x| x.as_str())
                .map(String::from)
                .unwrap_or_else(|| line_count.to_string());
            let dedup = format!("{id_part}|{ts_part}");
            if seen.contains(&dedup) {
                continue;
            }
            seen.insert(dedup);

            let model = v
                .pointer("/info/model")
                .and_then(|x| x.as_str())
                .or_else(|| v.get("model").and_then(|x| x.as_str()))
                .unwrap_or("gpt-4o");
            let pricing = resolve_pricing("codex", Some(model));
            let cost_usd = (input as f64 * pricing.input_per_m
                + output as f64 * pricing.output_per_m)
                / 1_000_000.0;
            let timestamp = v
                .get("timestamp")
                .and_then(|t| t.as_str())
                .and_then(parse_iso_ms)
                .unwrap_or(mtime_ms);
            let workspace_name = match &cwd {
                Some(c) => basename(c),
                None => basename_ext(&fp, ".jsonl"),
            };

            entries.push(UsageEntry {
                session_id: session_id.clone(),
                session_name: workspace_name.clone(),
                provider: "codex".into(),
                model: pricing.label.clone(),
                workspace_path: cwd.clone(),
                workspace_name: Some(workspace_name),
                timestamp,
                tokens_used: total_from_line,
                tokens_estimated: total_from_line,
                tokens_saved: 0,
                efficiency: 0.0,
                cost_usd,
                prompt_count: 1,
            });
        }

        report.files_scanned += 1;
        report.lines_parsed += line_count;
        index.upsert_file(&fp, mtime_ms, size, seen);
    }

    report.duration_ms = now_ms() - started;
    (entries, report)
}

fn file_mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Date.parse(iso) → ms. Supports the ISO-8601 format with offset/Z produced by the
/// CLIs. Minimal implementation without chrono.
fn parse_iso_ms(s: &str) -> Option<i64> {
    // Expected format: YYYY-MM-DDTHH:MM:SS(.fff)?(Z|±HH:MM)?
    let bytes = s.as_bytes();
    if s.len() < 19
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || (bytes[10] != b'T' && bytes[10] != b' ')
    {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let min: i64 = s.get(14..16)?.parse().ok()?;
    let sec: i64 = s.get(17..19)?.parse().ok()?;

    // Optional milliseconds.
    let mut idx = 19;
    let mut millis: i64 = 0;
    if bytes.get(idx) == Some(&b'.') {
        idx += 1;
        let mut frac = String::new();
        while idx < bytes.len() && bytes[idx].is_ascii_digit() {
            if frac.len() < 3 {
                frac.push(bytes[idx] as char);
            }
            idx += 1;
        }
        while frac.len() < 3 {
            frac.push('0');
        }
        millis = frac.parse().unwrap_or(0);
    }

    // days from civil (Howard Hinnant).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;

    let mut total = ((days * 86_400 + hour * 3600 + min * 60 + sec) * 1000) + millis;

    // Timezone offset.
    if let Some(&c) = bytes.get(idx) {
        if c == b'+' || c == b'-' {
            if let (Some(oh), Some(om)) = (
                s.get(idx + 1..idx + 3).and_then(|x| x.parse::<i64>().ok()),
                s.get(idx + 4..idx + 6).and_then(|x| x.parse::<i64>().ok()),
            ) {
                let off = (oh * 60 + om) * 60 * 1000;
                if c == b'+' {
                    total -= off;
                } else {
                    total += off;
                }
            }
        }
    }
    Some(total)
}

// ═════════════════════════════════════════════════════════════════════════
// 4) PROVIDER USAGE — usage probe + per-provider strategies + IPC handlers.
//
// Spawns an ephemeral PTY of the provider CLI, sends the slash command (/usage,
// /status, /stats), parses the ANSI-stripped output into rate-limit sections
// or activity metrics, and caches the snapshot per provider (CLI) or per session
// (token-based).
// ═════════════════════════════════════════════════════════════════════════

/// Per-provider cache TTL: a switch to a provider probed < 5 min ago
/// is served from memory (no CLI spawn). Windows keeps the window
/// longer (slow PTY).
const MIN_PROBE_INTERVAL_MS: i64 = if IS_WINDOWS { 10 } else { 5 } * 60 * 1000;
const FAIL_RETRY_INTERVAL_MS: i64 = 30_000;
/// TTL of the Codex disk read (rollout).
const CODEX_DISK_TTL_MS: i64 = 30_000;
const USAGE_PROCESS_TIMEOUT_MS: u64 = 60_000;
/// Hard cap on the debounced settle of the STATUS_SENT phase: if the TUI never
/// stops redrawing (spinner `Refreshing…`) it closes anyway.
const SETTLE_CAP_MS: u64 = 12_000;
const INIT_WAIT_MS: u64 = 4000;
const MAX_BUFFER_SIZE: usize = 256 * 1024;

/// UsageSection — { label, percentUsed, resetsLabel }.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSection {
    label: String,
    percent_used: i64,
    resets_label: String,
}

/// ActivityMetrics — activity metrics (Gemini /stats + token-based fallback).
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityMetrics {
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls_success: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls_error: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    success_rate_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wall_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_active: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tokens_used: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tokens_saved: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    efficiency_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

/// ProviderUsageSnapshot — payload emitted on provider-usage:updated.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageSnapshot {
    session_id: String,
    provider: String,
    model: String,
    sections: Vec<UsageSection>,
    session_percent: i64,
    session_resets: String,
    weekly_percent: i64,
    weekly_resets: String,
    /// Weekly quota on a single model bucket — Claude `/usage` prints it
    /// as `Current week (Fable)`. Empty label / 0% when missing.
    model_weekly_label: String,
    model_weekly_percent: i64,
    model_weekly_resets: String,
    extra_usage_enabled: bool,
    timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    activity_metrics: Option<ActivityMetrics>,
}

/// ParsedUsage — output of the strategy parsers.
struct ParsedUsage {
    model: String,
    sections: Vec<UsageSection>,
    extra_usage_enabled: bool,
    activity_metrics: Option<ActivityMetrics>,
}

/// Per-provider strategy (command/statusCommand/regex markers/parser).
struct ProbeStrategy {
    provider_type: &'static str,
    command: &'static str,
    status_command: &'static str,
    parse: fn(&str) -> Option<ParsedUsage>,
}

const TOKEN_BASED_PROVIDERS: [&str; 3] = ["copilot", "cursor", "opencode"];

fn resolve_strategy(provider: &str) -> Option<ProbeStrategy> {
    match provider {
        "claude-code-cli" => Some(ProbeStrategy {
            provider_type: "claude-code-cli",
            command: "claude",
            status_command: "/usage",
            parse: parse_claude_usage,
        }),
        "codex" => Some(ProbeStrategy {
            provider_type: "codex",
            command: "codex",
            status_command: "/status",
            parse: parse_codex_usage,
        }),
        "gemini-cli" => Some(ProbeStrategy {
            provider_type: "gemini-cli",
            command: "gemini",
            status_command: "/stats",
            parse: parse_gemini_stats,
        }),
        _ => None,
    }
}

fn is_token_based_provider(provider: &str) -> bool {
    TOKEN_BASED_PROVIDERS.contains(&provider)
}

#[derive(Default)]
struct ProbeState {
    /// CLI snapshots keyed by provider.
    snapshots: HashMap<String, ProviderUsageSnapshot>,
    /// Token-based snapshots keyed by session.
    token_snapshots: HashMap<String, ProviderUsageSnapshot>,
    /// lastProbeTime keyed by provider.
    last_probe_time: HashMap<String, i64>,
    /// sessionId → provider mapping (resolveProvider). Populated by the session wiring.
    session_providers: HashMap<String, String>,
    /// Sub-agent flag keyed by session.
    sub_agents: HashSet<String>,
    /// Last disk read (Codex rollout) keyed by provider.
    disk_probe_time: HashMap<String, i64>,
    /// Effective CODEX_HOME per session (provider account included).
    codex_homes: HashMap<String, String>,
    /// Root of the last Codex snapshot: avoids a cache shared across accounts.
    disk_probe_root: Option<String>,
}

/// ProviderUsageProbe — reads provider rate limits and usage.
///
/// TODO: drive it from the EventBus (hook:session-start →
/// probe scheduled at 20s, hook:stop → throttled probe, token:usage-updated →
/// token-based snapshot, hook:session-end/session:destroyed → cleanup). Those
/// triggers depend on the native HookManager/SessionManager and are not
/// wired here: the integration will call them on `probe()`.
/// `resolveProvider`/`isSubAgent` are exposed here as
/// state (`session_providers`/`sub_agents`) to populate via the public setters.
/// The core part — ephemeral PTY spawn, /usage·/status·/stats parsing,
/// caching, token-based snapshot from the TokenTracker, emit updated/probe-failed —
/// is complete.
pub struct ProviderUsageProbe {
    state: Mutex<ProbeState>,
    probing: AtomicBool,
    tracker: Mutex<Option<Arc<TokenTracker>>>,
}

impl Default for ProviderUsageProbe {
    fn default() -> Self {
        Self::new()
    }
}

impl ProviderUsageProbe {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(ProbeState::default()),
            probing: AtomicBool::new(false),
            tracker: Mutex::new(None),
        }
    }

    /// setTokenTracker — connects the TokenTracker for token-based snapshots.
    pub fn set_token_tracker(&self, tracker: Arc<TokenTracker>) {
        *self.tracker.lock() = Some(tracker);
    }

    /// setProviderResolver equivalent: registers the sessionId→provider map.
    pub fn set_session_provider(&self, session_id: &str, provider: &str) {
        self.state
            .lock()
            .session_providers
            .insert(session_id.to_string(), provider.to_string());
    }

    pub fn set_codex_home(&self, session_id: &str, home: Option<String>) {
        let mut st = self.state.lock();
        let previous = st.codex_homes.get(session_id).cloned();
        if let Some(home) = home {
            st.codex_homes.insert(session_id.to_string(), home);
        } else {
            st.codex_homes.remove(session_id);
        }
        let current = st.codex_homes.get(session_id).cloned();
        if previous != current {
            st.snapshots.remove("codex");
            st.disk_probe_time.remove("codex");
            st.disk_probe_root = None;
        }
    }

    fn resolve_provider(&self, session_id: &str) -> String {
        self.state
            .lock()
            .session_providers
            .get(session_id)
            .cloned()
            .unwrap_or_else(|| "claude-code-cli".to_string())
    }

    fn is_sub_agent(&self, session_id: &str) -> bool {
        self.state.lock().sub_agents.contains(session_id)
    }

    /// Cleanup on session-end/destroy.
    pub(crate) fn cleanup_session(&self, session_id: &str) {
        let mut st = self.state.lock();
        st.session_providers.remove(session_id);
        st.sub_agents.remove(session_id);
        st.token_snapshots.remove(session_id);
        st.last_probe_time.remove(session_id);
        st.codex_homes.remove(session_id);
    }

    /// getSnapshot — cache lookup; never triggers a probe.
    fn get_snapshot(&self, session_id: &str) -> Option<ProviderUsageSnapshot> {
        let provider = self.resolve_provider(session_id);
        if is_token_based_provider(&provider) {
            if let Some(t) = self.state.lock().token_snapshots.get(session_id) {
                return Some(t.clone());
            }
            return self.build_token_snapshot(session_id, &provider);
        }
        let st = self.state.lock();
        st.snapshots.get(&provider).map(|s| {
            let mut s = s.clone();
            s.session_id = session_id.to_string();
            s
        })
    }

    /// getAllSnapshots — provider-keyed CLI + session:<id> namespaced token-based.
    fn get_all_snapshots(&self) -> HashMap<String, ProviderUsageSnapshot> {
        let st = self.state.lock();
        let mut result = HashMap::new();
        for (provider, snap) in &st.snapshots {
            result.insert(provider.clone(), snap.clone());
        }
        for (session_id, snap) in &st.token_snapshots {
            result.insert(format!("session:{session_id}"), snap.clone());
        }
        result
    }

    /// buildTokenSnapshot — snapshot from the TokenTracker for token-based providers.
    fn build_token_snapshot(
        &self,
        session_id: &str,
        provider: &str,
    ) -> Option<ProviderUsageSnapshot> {
        let tracker = self.tracker.lock().clone()?;
        let stats = tracker.session_stats(session_id).unwrap_or_default();
        let parsed = build_token_based_snapshot(
            provider,
            stats.tokens_used,
            stats.tokens_saved,
            stats.efficiency_percentage,
            stats.prompt_count,
        );
        Some(ProviderUsageSnapshot {
            session_id: session_id.to_string(),
            provider: provider.to_string(),
            model: parsed.model,
            sections: parsed.sections,
            session_percent: 0,
            session_resets: String::new(),
            weekly_percent: 0,
            weekly_resets: String::new(),
            model_weekly_label: String::new(),
            model_weekly_percent: 0,
            model_weekly_resets: String::new(),
            extra_usage_enabled: parsed.extra_usage_enabled,
            timestamp: now_iso(),
            activity_metrics: parsed.activity_metrics,
        })
    }

    /// probe — three paths (sub-agent, token-based, ephemeral CLI).
    /// Probe from a hook of the session's own CLI (SessionStart / Stop): the
    /// provider is already running there because the user started it.
    pub(crate) fn probe(&self, app: &AppHandle, session_id: &str) -> Option<ProviderUsageSnapshot> {
        self.probe_with(app, session_id, ProbeOrigin::SessionCliRunning)
    }

    /// Probe asked by the renderer: launches the provider CLI only when the
    /// user explicitly asked (refresh / retry), otherwise answers from cache
    /// and from files on disk.
    pub(crate) fn probe_requested(
        &self,
        app: &AppHandle,
        session_id: &str,
        user_initiated: bool,
    ) -> Option<ProviderUsageSnapshot> {
        let origin = if user_initiated {
            ProbeOrigin::UserAction
        } else {
            ProbeOrigin::Automatic
        };
        self.probe_with(app, session_id, origin)
    }

    fn probe_with(
        &self,
        app: &AppHandle,
        session_id: &str,
        origin: ProbeOrigin,
    ) -> Option<ProviderUsageSnapshot> {
        let provider = self.resolve_provider(session_id);
        let strategy = resolve_strategy(&provider);

        // Sub-agent: never a PTY — CLI cache or instant token-based snapshot.
        if self.is_sub_agent(session_id) {
            if is_token_based_provider(&provider) {
                if let Some(snapshot) = self.build_token_snapshot(session_id, &provider) {
                    self.state
                        .lock()
                        .token_snapshots
                        .insert(session_id.to_string(), snapshot.clone());
                    let _ = app.emit(PROVIDER_USAGE_UPDATED, &snapshot);
                    return Some(snapshot);
                }
                return None;
            }
            let cached = self.state.lock().snapshots.get(&provider).cloned();
            if let Some(mut snapshot) = cached {
                snapshot.session_id = session_id.to_string();
                let _ = app.emit(PROVIDER_USAGE_UPDATED, &snapshot);
                return Some(snapshot);
            }
            return None;
        }

        // Token-based fallback: snapshot from the TokenTracker, always fresh.
        let Some(strategy) = strategy else {
            if !is_token_based_provider(&provider) {
                return None;
            }
            return match self.build_token_snapshot(session_id, &provider) {
                Some(snapshot) => {
                    self.state
                        .lock()
                        .token_snapshots
                        .insert(session_id.to_string(), snapshot.clone());
                    let _ = app.emit(PROVIDER_USAGE_UPDATED, &snapshot);
                    Some(snapshot)
                }
                None => {
                    let _ = app.emit(
                        PROVIDER_USAGE_PROBE_FAILED,
                        json!({
                            "sessionId": session_id,
                            "provider": provider,
                            "reason": "no-output",
                            "detail": "No token usage recorded yet for this session",
                        }),
                    );
                    None
                }
            };
        };

        // Codex: quota read from the rollouts on disk (same numbers as /status,
        // no PTY). Falls back to the legacy PTY flow only without any rollout
        // (fresh install). Since codex-cli 0.153 `/status` replies
        // "Limits: refresh requested; run /status again shortly" → the TUI
        // probe timed out and the GPT panel stayed empty.
        if provider == "codex" {
            if let Some(snapshot) = self.probe_codex_from_disk(app, session_id) {
                return Some(snapshot);
            }
        }

        // Return cached if recent.
        let now = now_ms();
        {
            let st = self.state.lock();
            let last = st.last_probe_time.get(&provider).copied().unwrap_or(0);
            if let Some(cached) = st.snapshots.get(&provider) {
                if now - last < MIN_PROBE_INTERVAL_MS {
                    let mut snapshot = cached.clone();
                    snapshot.session_id = session_id.to_string();
                    drop(st);
                    let _ = app.emit(PROVIDER_USAGE_UPDATED, &snapshot);
                    return Some(snapshot);
                }
            }
        }

        // Launching the CLI means a process that signs in to the provider with
        // the user's account and talks to its servers: never on our own.
        let mapped = self.state.lock().session_providers.get(session_id).cloned();
        if !may_launch_cli_probe(origin, mapped.as_deref(), strategy.provider_type) {
            let cached = self.state.lock().snapshots.get(&provider).cloned();
            if let Some(mut snapshot) = cached {
                snapshot.session_id = session_id.to_string();
                let _ = app.emit(PROVIDER_USAGE_UPDATED, &snapshot);
                return Some(snapshot);
            }
            let _ = app.emit(
                PROVIDER_USAGE_PROBE_FAILED,
                json!({
                    "sessionId": session_id,
                    "provider": provider,
                    "reason": "user-action-required",
                    "detail": "Usage is read from the provider CLI only when you refresh it",
                }),
            );
            return None;
        }

        // Concurrency guard: if a probe is already running, return cached (no async
        // queue — the renderer's polling repeats the request).
        if self
            .probing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            let st = self.state.lock();
            return st.snapshots.get(&provider).map(|c| {
                let mut s = c.clone();
                s.session_id = session_id.to_string();
                s
            });
        }

        // Ephemeral spawn (blocking). The guard clears `probing` even if the
        // probe panics: a stuck flag silenced every later probe until restart.
        struct ProbingGuard<'a>(&'a AtomicBool);
        impl Drop for ProbingGuard<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let outcome = {
            let _guard = ProbingGuard(&self.probing);
            spawn_ephemeral_probe(session_id, &strategy)
        };

        let now = now_ms();
        match outcome {
            ProbeOutcome::Ok(snapshot) => {
                {
                    let mut st = self.state.lock();
                    st.last_probe_time.insert(provider.clone(), now);
                    st.snapshots.insert(provider.clone(), snapshot.clone());
                }
                let _ = app.emit(PROVIDER_USAGE_UPDATED, &snapshot);
                self.propagate_to_sub_agents(app, &provider, &snapshot);
                Some(snapshot)
            }
            ProbeOutcome::Failed { reason, detail } => {
                self.state.lock().last_probe_time.insert(
                    provider.clone(),
                    now - (MIN_PROBE_INTERVAL_MS - FAIL_RETRY_INTERVAL_MS),
                );
                let final_reason = if reason.is_empty() {
                    "no-output".to_string()
                } else {
                    reason
                };
                let _ = app.emit(
                    PROVIDER_USAGE_PROBE_FAILED,
                    json!({
                        "sessionId": session_id,
                        "provider": provider,
                        "reason": final_reason,
                        "detail": detail,
                    }),
                );
                None
            }
        }
    }

    /// probeCodexFromDisk — most recent rollout with rate_limits → snapshot,
    /// cached for CODEX_DISK_TTL_MS in the same provider-keyed map as the PTY.
    fn probe_codex_from_disk(
        &self,
        app: &AppHandle,
        session_id: &str,
    ) -> Option<ProviderUsageSnapshot> {
        let now = now_ms();
        let root = self
            .state
            .lock()
            .codex_homes
            .get(session_id)
            .map(|home| std::path::Path::new(home).join("sessions"))
            .unwrap_or_else(|| codex_rollout::resolve_sessions_root(&home_dir()));
        let root_key = root.to_string_lossy().to_string();
        {
            let st = self.state.lock();
            let last = st.disk_probe_time.get("codex").copied().unwrap_or(0);
            if st.disk_probe_root.as_deref() == Some(root_key.as_str()) {
                if let Some(cached) = st.snapshots.get("codex") {
                    if now - last < CODEX_DISK_TTL_MS {
                        let mut snapshot = cached.clone();
                        snapshot.session_id = session_id.to_string();
                        drop(st);
                        let _ = app.emit(PROVIDER_USAGE_UPDATED, &snapshot);
                        return Some(snapshot);
                    }
                }
            }
        }

        let usage = codex_rollout::read_latest_codex_usage(
            &root,
            codex_rollout::DEFAULT_MAX_FILES,
            codex_rollout::DEFAULT_MAX_DAYS,
            codex_rollout::DEFAULT_TAIL_BYTES,
        )?;
        let sections: Vec<UsageSection> = codex_rollout::build_codex_sections(&usage, now)
            .into_iter()
            .map(|s| UsageSection {
                label: s.label,
                percent_used: s.percent_used,
                resets_label: s.resets_label,
            })
            .collect();
        if sections.is_empty() {
            return None;
        }
        let scoped = find_model_weekly_section(&sections);
        let snapshot = ProviderUsageSnapshot {
            session_id: session_id.to_string(),
            provider: "codex".to_string(),
            model: usage.model.clone().unwrap_or_default(),
            session_percent: sections.first().map(|s| s.percent_used).unwrap_or(0),
            session_resets: sections
                .first()
                .map(|s| s.resets_label.clone())
                .unwrap_or_default(),
            weekly_percent: sections.get(1).map(|s| s.percent_used).unwrap_or(0),
            weekly_resets: sections
                .get(1)
                .map(|s| s.resets_label.clone())
                .unwrap_or_default(),
            model_weekly_label: scoped
                .as_ref()
                .map(|s| s.display_name.clone())
                .unwrap_or_default(),
            model_weekly_percent: scoped.as_ref().map(|s| s.percent_used).unwrap_or(0),
            model_weekly_resets: scoped
                .as_ref()
                .map(|s| s.resets_label.clone())
                .unwrap_or_default(),
            sections,
            extra_usage_enabled: true, // Codex has no concept of "extra usage"
            timestamp: now_iso(),
            activity_metrics: None,
        };
        {
            let mut st = self.state.lock();
            st.snapshots.insert("codex".to_string(), snapshot.clone());
            st.disk_probe_time.insert("codex".to_string(), now);
            st.disk_probe_root = Some(root_key);
            // Also stamp the PTY throttle: no redundant ephemeral spawn.
            st.last_probe_time.insert("codex".to_string(), now);
        }
        let _ = app.emit(PROVIDER_USAGE_UPDATED, &snapshot);
        self.propagate_to_sub_agents(app, "codex", &snapshot);
        Some(snapshot)
    }

    /// propagateToSubAgents — re-emits the CLI snapshot to all sub-agents of the
    /// provider (here: to all sub-agent sessions resolved to the same provider).
    fn propagate_to_sub_agents(
        &self,
        app: &AppHandle,
        provider: &str,
        snapshot: &ProviderUsageSnapshot,
    ) {
        let subs: Vec<String> = {
            let st = self.state.lock();
            st.sub_agents
                .iter()
                .filter(|sid| {
                    st.session_providers
                        .get(*sid)
                        .map(|p| p == provider)
                        .unwrap_or(false)
                })
                .cloned()
                .collect()
        };
        for sub in subs {
            let mut s = snapshot.clone();
            s.session_id = sub;
            let _ = app.emit(PROVIDER_USAGE_UPDATED, &s);
        }
    }
}

/// Who asked for a usage probe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProbeOrigin {
    /// The user clicked refresh / retry in the Usage panel.
    UserAction,
    /// A hook of the session's own CLI: that provider is already running.
    SessionCliRunning,
    /// Anything else (session switch, app start, panel open).
    Automatic,
}

/// May the probe launch `provider`'s CLI (an ephemeral process that signs in
/// with the user's account and contacts the provider)? Only on an explicit
/// user action, or for a session that is itself running that provider.
/// Never automatically, and never because of a default or a guess (a Plain
/// Shell session, a composer chip, an unmapped session).
pub(crate) fn may_launch_cli_probe(
    origin: ProbeOrigin,
    session_provider: Option<&str>,
    probe_provider: &str,
) -> bool {
    match origin {
        ProbeOrigin::UserAction => true,
        ProbeOrigin::SessionCliRunning => session_provider == Some(probe_provider),
        ProbeOrigin::Automatic => false,
    }
}

/// build_token_based_snapshot — snapshot built from tracked tokens.
fn build_token_based_snapshot(
    provider: &str,
    tokens_used: i64,
    tokens_saved: i64,
    efficiency_percentage: f64,
    prompt_count: i64,
) -> ParsedUsage {
    let pricing = resolve_pricing(provider, None);
    let avg_per_m = (pricing.input_per_m + pricing.output_per_m) / 2.0;
    let cost_usd = if avg_per_m > 0.0 && tokens_used > 0 {
        Some((tokens_used as f64 / 1_000_000.0) * avg_per_m)
    } else {
        None
    };
    let metrics = ActivityMetrics {
        tier: Some(pricing.label.clone()),
        tokens_used: Some(tokens_used),
        tokens_saved: Some(tokens_saved),
        efficiency_pct: Some(efficiency_percentage),
        cost_usd,
        prompt_count: Some(prompt_count),
        source: Some("token-tracker".into()),
        ..Default::default()
    };
    ParsedUsage {
        model: pricing.label,
        sections: Vec::new(),
        extra_usage_enabled: true,
        activity_metrics: Some(metrics),
    }
}

enum ProbeOutcome {
    Ok(ProviderUsageSnapshot),
    Failed {
        reason: String,
        detail: Option<String>,
    },
}

/// spawn_ephemeral_probe — runs the provider CLI in a short-lived PTY.
/// Spawns a login shell, launches the CLI, sends the status command, waits for
/// the output marker, parses. State: SHELL_WAIT → CLI_INIT → STATUS_SENT → DONE.
fn spawn_ephemeral_probe(session_id: &str, strategy: &ProbeStrategy) -> ProbeOutcome {
    let provider = strategy.provider_type;

    // Env: enriched PATH (including global npm prefixes on Unix), no CLAUDECODE.
    let home = home_dir();
    let mut extra = default_extra_paths();
    if !IS_WINDOWS {
        extra.push(format!("{home}/.npm-global/bin"));
        extra.push(format!("{home}/.volta/bin"));
        extra.push(format!("{home}/.fnm/aliases/default/bin"));
        extra.push(format!("{home}/.bun/bin"));
    }
    let path = build_path(&extra);

    let pty_system = NativePtySystem::default();
    let pair = match pty_system.openpty(PtySize {
        rows: 30,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => {
            return ProbeOutcome::Failed {
                reason: "generic".into(),
                detail: Some(e.to_string()),
            }
        }
    };

    let mut cmd = CommandBuilder::new(get_shell());
    for arg in probe_shell_args(strategy.command) {
        cmd.arg(arg);
    }
    cmd.cwd(&home);
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("PATH", path);
    // Launched from Finder/installer the app doesn't inherit TERM: without it, the TUI
    // (ink) draws spaces as cursor-forward `ESC[nC` and the `/usage` labels
    // arrive glued together (`Currentweek(allmodels)`). In `tauri dev`
    // TERM is always set → that's why the Fable bar only showed up there.
    if std::env::var("TERM")
        .map(|t| t.trim().is_empty())
        .unwrap_or(true)
    {
        cmd.env("TERM", "xterm-256color");
    }
    cmd.env_remove("CLAUDECODE");
    cmd.env_remove("CLAUDE_CODE");

    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            return ProbeOutcome::Failed {
                reason: "generic".into(),
                detail: Some(e.to_string()),
            }
        }
    };

    let mut reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            return ProbeOutcome::Failed {
                reason: "generic".into(),
                detail: Some(e.to_string()),
            }
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            return ProbeOutcome::Failed {
                reason: "generic".into(),
                detail: Some(e.to_string()),
            }
        }
    };
    let writer = Arc::new(Mutex::new(writer));

    // Buffer shared with the reader thread.
    let buffer = Arc::new(Mutex::new(String::new()));
    let pump_buffer = buffer.clone();
    let reader_handle = std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut b = pump_buffer.lock();
                    if b.len() < MAX_BUFFER_SIZE {
                        b.push_str(&String::from_utf8_lossy(&buf[..n]));
                    }
                }
            }
        }
    });

    let strip = |s: &str| strip_ansi(s);
    let prompt_ready = |s: &str| prompt_ready_re(provider, s);
    let output_ready = |s: &str| output_ready_re(provider, s);

    let start = Instant::now();
    let timeout = Duration::from_millis(USAGE_PROCESS_TIMEOUT_MS);

    // Unix: the CLI is the shell's `-c` command, already launched.
    let mut phase = if IS_WINDOWS {
        ProbePhase::ShellWait
    } else {
        ProbePhase::CliInit
    };
    let mut trust_handled = false;
    let mut forced_reason: Option<String> = None;
    let mut forced_detail: Option<String> = None;
    let mut status_sends = 0u32;
    let mut last_status_send = Instant::now();
    let mut cli_launched_at: Option<Instant> = (!IS_WINDOWS).then(Instant::now);
    let mut fallback_status_sent = false;
    let mut output_seen_at: Option<Instant> = None;
    let mut last_change_at = Instant::now();
    let mut last_len = 0usize;

    let shell_wait = Duration::from_millis(if IS_WINDOWS { 2500 } else { 1000 });

    let write_str = |s: &str| {
        let mut w = writer.lock();
        let _ = w.write_all(s.as_bytes());
        let _ = w.flush();
    };

    loop {
        if start.elapsed() >= timeout {
            if forced_reason.is_none() {
                forced_reason = Some("timeout".into());
                forced_detail = Some(format!(
                    "{} did not reply within {}ms (phase {:?})",
                    strategy.command, USAGE_PROCESS_TIMEOUT_MS, phase
                ));
            }
            break;
        }

        let raw = buffer.lock().clone();
        if raw.len() != last_len {
            last_len = raw.len();
            last_change_at = Instant::now();
        }
        let stripped = strip(&raw);

        match phase {
            ProbePhase::ShellWait => {
                if start.elapsed() >= shell_wait {
                    phase = ProbePhase::CliInit;
                    write_str(&format!("{}\r", strategy.command));
                    cli_launched_at = Some(Instant::now());
                }
            }
            ProbePhase::CliInit => {
                // command-not-found detection.
                if forced_reason.is_none() && command_not_found(strategy.command, &stripped) {
                    forced_reason = Some("command-not-found".into());
                    forced_detail = Some(format!(
                        "{} CLI not found in the spawned shell PATH",
                        strategy.command
                    ));
                    break;
                }
                // Trust dialog auto-accept. Since CLI 2.1.261 the dialog
                // ("Quick safety check") preselects `❯ No, exit`: a bare Enter
                // closed the CLI and the probe failed (no Claude bar
                // in the Usage panel). If the cursor is on "No" we first send
                // arrow down. The cursor is re-read from the buffer AFTER
                // the wait, so the frame is complete.
                if !trust_handled && contains_ci_compact(&stripped, "trust this folder") {
                    trust_handled = true;
                    let w = writer.clone();
                    let b = buffer.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(300));
                        let snapshot = strip_ansi(&b.lock().clone());
                        if trust_dialog_cursor_on_no(&snapshot) {
                            {
                                let mut w = w.lock();
                                let _ = w.write_all(b"\x1b[B");
                                let _ = w.flush();
                            }
                            std::thread::sleep(Duration::from_millis(150));
                        }
                        let mut w = w.lock();
                        let _ = w.write_all(b"\r");
                        let _ = w.flush();
                    });
                }
                // Prompt ready → send status.
                let tail: String = stripped
                    .chars()
                    .rev()
                    .take(20)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
                if prompt_ready(&tail) {
                    status_sends += 1;
                    phase = ProbePhase::StatusSent;
                    write_str(&format!("{}\r", strategy.status_command));
                    last_status_send = Instant::now();
                }
                // Fallback: after INIT_WAIT_MS+3s without a prompt, send anyway.
                if !fallback_status_sent {
                    if let Some(launched) = cli_launched_at {
                        if launched.elapsed() >= Duration::from_millis(INIT_WAIT_MS + 3000) {
                            fallback_status_sent = true;
                            status_sends += 1;
                            phase = ProbePhase::StatusSent;
                            write_str(&format!("{}\r", strategy.status_command));
                            last_status_send = Instant::now();
                        }
                    }
                }
            }
            ProbePhase::StatusSent => {
                if output_ready(&stripped) {
                    if output_seen_at.is_none() {
                        output_seen_at = Some(Instant::now());
                    }
                    // Debounce, not a fixed timeout: it re-arms the
                    // timer on every chunk (`onData`), so it waits for 800ms of
                    // SILENCE. It's really needed: since CLI 2.1.229 `/usage`
                    // first draws session + week (all models), then
                    // `Scanning local sessions…`/`Refreshing…` and only afterwards the
                    // per-model bar (`Current week (Fable)`). Closing
                    // 800ms after the first "% used", that bar never made it
                    // into the buffer and the model badge stayed empty.
                    // The cap protects against spinners that never stop.
                    let quiet = last_change_at.elapsed() >= Duration::from_millis(800);
                    let capped = output_seen_at
                        .map(|seen| seen.elapsed() >= Duration::from_millis(SETTLE_CAP_MS))
                        .unwrap_or(false);
                    if quiet || capped {
                        write_str("\x1b");
                        if IS_WINDOWS {
                            write_str("q");
                        }
                        std::thread::sleep(Duration::from_millis(200));
                        break;
                    }
                } else {
                    // Periodic re-send every 5s, max 6 sends.
                    if last_status_send.elapsed() >= Duration::from_secs(5) && status_sends < 6 {
                        status_sends += 1;
                        write_str(&format!("{}\r", strategy.status_command));
                        last_status_send = Instant::now();
                    }
                }
            }
        }

        std::thread::sleep(Duration::from_millis(60));
    }

    // Parse + cleanup.
    let raw = buffer.lock().clone();
    let stripped = strip(&raw);
    let parsed = (strategy.parse)(&stripped);
    // Diagnostics: `PROMPTOPS_PROBE_DUMP=/path` saves the raw PTY buffer.
    if let Ok(dump) = std::env::var("PROMPTOPS_PROBE_DUMP") {
        if !dump.is_empty() {
            let _ = std::fs::write(&dump, &raw);
        }
    }

    // killProc: Ctrl-C + exit + kill.
    write_str("\x03");
    write_str("exit\r");
    std::thread::sleep(Duration::from_millis(300));
    let _ = child.kill();
    // Reap it: without wait() the CLI stayed a <defunct> zombie until the app quit.
    let reap_deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => break,
            Ok(None) if Instant::now() < reap_deadline => {
                std::thread::sleep(Duration::from_millis(50))
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    drop(writer); // releases the writer (the last reference before closing the pty)
    drop(pair); // closes master → reader thread exits
    let _ = reader_handle.join();

    match parsed {
        Some(p) if !p.sections.is_empty() || p.activity_metrics.is_some() => {
            let session_percent = p.sections.first().map(|s| s.percent_used).unwrap_or(0);
            let session_resets = p
                .sections
                .first()
                .map(|s| s.resets_label.clone())
                .unwrap_or_default();
            let weekly_percent = p.sections.get(1).map(|s| s.percent_used).unwrap_or(0);
            let weekly_resets = p
                .sections
                .get(1)
                .map(|s| s.resets_label.clone())
                .unwrap_or_default();
            let scoped = find_model_weekly_section(&p.sections);
            let model_weekly_label = scoped
                .as_ref()
                .map(|s| s.display_name.clone())
                .unwrap_or_default();
            let model_weekly_percent = scoped.as_ref().map(|s| s.percent_used).unwrap_or(0);
            let model_weekly_resets = scoped
                .as_ref()
                .map(|s| s.resets_label.clone())
                .unwrap_or_default();
            ProbeOutcome::Ok(ProviderUsageSnapshot {
                session_id: session_id.to_string(),
                provider: provider.to_string(),
                model: p.model,
                sections: p.sections,
                session_percent,
                session_resets,
                weekly_percent,
                weekly_resets,
                model_weekly_label,
                model_weekly_percent,
                model_weekly_resets,
                extra_usage_enabled: p.extra_usage_enabled,
                timestamp: now_iso(),
                activity_metrics: p.activity_metrics,
            })
        }
        _ => ProbeOutcome::Failed {
            reason: forced_reason.unwrap_or_default(),
            detail: forced_detail,
        },
    }
}

#[derive(Debug, Clone, Copy)]
enum ProbePhase {
    ShellWait,
    CliInit,
    StatusSent,
}

// ── Provider strategy regex markers (usage strategy RegExps) ──

/// promptReadyRe: all providers use `[❯›>]\s*$`.
fn prompt_ready_re(_provider: &str, tail: &str) -> bool {
    let trimmed = tail.trim_end();
    trimmed.ends_with('❯') || trimmed.ends_with('›') || trimmed.ends_with('>')
}

/// outputReadyRe per provider.
fn output_ready_re(provider: &str, text: &str) -> bool {
    match provider {
        // Claude: /\d+%\s*used/i
        "claude-code-cli" => contains_pct_used(text),
        // Codex: /\d+\s*%\s*(?:left|remaining|used)/i
        "codex" => contains_pct_kind(text),
        // Gemini: /Interaction\s+Summary/i
        "gemini-cli" => contains_ci_words(text, &["interaction", "summary"]),
        _ => false,
    }
}

/// "<N>% used" present (case-insensitive, optional spaces).
fn contains_pct_used(text: &str) -> bool {
    let lower = text.to_lowercase();
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            // check digit before (skipping spaces), and "used" after (skipping spaces).
            let mut j = i;
            // at least one digit right before (zero-space is the common case).
            // but we accept spaces: search backwards for a digit.
            let mut k = i;
            while k > 0 && (bytes[k - 1] as char).is_whitespace() {
                k -= 1;
            }
            let has_digit = k > 0 && bytes[k - 1].is_ascii_digit();
            // after %: skip spaces, then "used".
            j += 1;
            while j < bytes.len() && (bytes[j] as char).is_whitespace() {
                j += 1;
            }
            if has_digit && lower[j..].starts_with("used") {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// "<N>% (left|remaining|used)" present.
fn contains_pct_kind(text: &str) -> bool {
    let lower = text.to_lowercase();
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let mut k = i;
            while k > 0 && (bytes[k - 1] as char).is_whitespace() {
                k -= 1;
            }
            let has_digit = k > 0 && bytes[k - 1].is_ascii_digit();
            let mut j = i + 1;
            while j < bytes.len() && (bytes[j] as char).is_whitespace() {
                j += 1;
            }
            let rest = &lower[j..];
            if has_digit
                && (rest.starts_with("left")
                    || rest.starts_with("remaining")
                    || rest.starts_with("used"))
            {
                return true;
            }
        }
        i += 1;
    }
    false
}

#[cfg(test)]
fn contains_ci(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// Case-insensitive match ignoring ALL whitespace (like the regex
/// `/trust\s*this\s*folder/i`): the CLI 2.1.261 trust dialog lands in the
/// buffer with the words glued together (`Yes,Itrustthisfolder`) and `contains_ci`
/// never saw it → the fallback sent Enter on the default "No, exit".
fn contains_ci_compact(haystack: &str, needle: &str) -> bool {
    let compact = |s: &str| {
        s.chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
            .to_lowercase()
    };
    compact(haystack).contains(&compact(needle))
}

/// Trust dialog: true if the preselected option (`❯`) is "No, exit"
/// (CLI 2.1.261+), so an arrow down is needed before Enter. The old
/// dialog (`❯ Yes, proceed` / `No, exit`) returns false → direct Enter.
fn trust_dialog_cursor_on_no(stripped: &str) -> bool {
    let Some(idx) = stripped.rfind('❯') else {
        return false;
    };
    let after: String = stripped[idx + '❯'.len_utf8()..]
        .chars()
        .filter(|c| !c.is_whitespace())
        .take(3)
        .collect::<String>()
        .to_lowercase();
    after.starts_with("no")
}

/// All words present in order (with spaces/whitespace in between).
fn contains_ci_words(text: &str, words: &[&str]) -> bool {
    let lower = text.to_lowercase();
    let joined = words.join(" ");
    // tolerant of multiple whitespace: collapse.
    let collapsed: String = lower.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.contains(&joined)
}

/// command-not-found detection (three RegExps).
fn command_not_found(cmd: &str, stripped: &str) -> bool {
    let lower = stripped.to_lowercase();
    let cmd_l = cmd.to_lowercase();
    // generic: "<cmd> … command not found / not recognized / no such file / cannot find"
    if let Some(pos) = lower.find(&cmd_l) {
        // 60 bytes, shortened to a character boundary: the CLI banner puts
        // box-drawing characters (3 bytes each) right after its own name,
        // and a byte slice inside one panicked the probe.
        let mut end = (pos + 60).min(lower.len());
        while !lower.is_char_boundary(end) {
            end -= 1;
        }
        let window = &lower[pos..end];
        if window.contains("command not found")
            || window.contains("not recognized")
            || window.contains("no such file")
            || window.contains("cannot find")
        {
            return true;
        }
    }
    // zsh: "zsh: command not found: <cmd>" (and "zsh:1: …" for `-c`)
    if lower.contains(&format!("command not found: {cmd_l}")) {
        return true;
    }
    // bash: "bash: <cmd>: command not found"
    if lower.contains(&format!("bash: {cmd_l}: command not found")) {
        return true;
    }
    false
}

// ── Strategy parsers (parse* functions per usage strategy) ──────────

const BOX_CHARS: &[char] = &[
    '█', '▌', '▐', '░', '▒', '▓', '▏', '▎', '▍', '▋', '▊', '▉', '■', '□', '▪', '▫', '─', '│', '┌',
    '┐', '└', '┘', '├', '┤', '┬', '┴', '┼', '╭', '╮', '╯', '╰', '╱', '╲', '╳', '●', '○', '◆', '◇',
    '▲', '▼', '◀', '▶', '⏎', '⏏', '⌘', '⌥', '⇧', '⇪', '⌫', '⌦',
];

fn clean_text(text: &str) -> String {
    let replaced: String = text
        .chars()
        .map(|c| if BOX_CHARS.contains(&c) { ' ' } else { c })
        .collect();
    collapse_spaces(&replaced).trim().to_string()
}

fn collapse_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for c in s.chars() {
        if c == ' ' {
            if !prev_space {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    out
}

fn format_resets(raw: &str) -> String {
    // split on /(?:Current|Extra|Esc|█|\$)/i → first segment.
    let lower = raw.to_lowercase();
    let mut cut = raw.len();
    for marker in ["current", "extra", "esc"] {
        if let Some(p) = lower.find(marker) {
            cut = cut.min(p);
        }
    }
    for ch in ['█', '$'] {
        if let Some(p) = raw.find(ch) {
            cut = cut.min(p);
        }
    }
    let mut text = clean_text(&raw[..cut]);
    // remove "(...)" groups.
    while let (Some(a), Some(b)) = (text.find('('), text.find(')')) {
        if a < b {
            text.replace_range(a..=b, " ");
        } else {
            break;
        }
    }
    text = collapse_spaces(&text);
    // " at " → ", "
    let lower2 = text.to_lowercase();
    if let Some(p) = lower2.find(" at ") {
        text = format!("{}, {}", &text[..p], &text[p + 4..]);
    }
    text = text.trim_start_matches(['·', ' ']).to_string();
    keep_reset_tokens(text.trim())
}

/// Keeps only the leading date/time expression.
///
/// The TUI emits no newlines (it uses cursor-move), so everything the CLI
/// draws *after* the "Resets …" line ends up in the same capture: since
/// 2.1.225 below it there are the promo banner (`+50% weekly limits promo …`) and
/// the "What's contributing to your limits usage?" panel. Without this
/// cut the resets label becomes a paragraph that overflows the Usage panel.
/// Token whitelist instead of a marker blacklist: new text that
/// Anthropic adds tomorrow still stops at the first non-date token.
fn keep_reset_tokens(text: &str) -> String {
    const MONTHS: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    const DAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const WORDS: [&str; 6] = ["at", "in", "on", "today", "tomorrow", "resets"];

    // A bare number ("13") only counts after month/day/word: so "Aug 13"
    // passes while the "+50%" of the promo banner, which follows a time, stops.
    let mut kept: Vec<&str> = Vec::new();
    let mut prev_allows_number = true;
    for tok in text.split(' ') {
        let norm = tok
            .trim_matches(|c: char| !c.is_alphanumeric() && c != ':')
            .to_lowercase();
        if norm.is_empty() {
            continue;
        }
        let is_word = MONTHS.iter().any(|m| norm.starts_with(m))
            || DAYS.iter().any(|d| norm.starts_with(d))
            || WORDS.contains(&norm.as_str());
        let core = norm.strip_suffix("am").or_else(|| norm.strip_suffix("pm"));
        let is_clock = core.is_some() || norm.contains(':');
        let digits = core.unwrap_or(&norm);
        let is_numeric = !digits.is_empty()
            && digits.len() <= 5
            && digits.chars().all(|c| c.is_ascii_digit() || c == ':');

        let ok = if is_word {
            true
        } else if is_numeric {
            is_clock || prev_allows_number
        } else {
            false
        };
        if !ok {
            break;
        }
        prev_allows_number = is_word;
        kept.push(tok);
    }
    kept.join(" ").trim().to_string()
}

const CLAUDE_LABELS: [&str; 5] = [
    "Current session",
    "Current week (all models)",
    "Current week (Sonnet only)",
    "Current week",
    "Extra usage",
];

/// Scopes that are NOT a per-model bucket.
const NON_MODEL_WEEK_SCOPES: [&str; 1] = ["all models"];

/// Fixed titles (never a model bucket): break ties when choosing the scope.
const CLAUDE_FIXED_TITLES: [&str; 2] = ["current session", "extra usage"];

/// Weekly bar on a single model bucket (e.g. Fable).
struct ModelWeekly {
    display_name: String,
    percent_used: i64,
    resets_label: String,
}

/// Last occurrence of `Current week (<X>)` in `text` (case-insensitive).
///
/// Besides the fixed lines, `/usage` prints a weekly bar for each
/// model bucket of the account (today Fable) with a title generated by the CLI as
/// `Current week (${scope.model.display_name})`: a server-side name, so it can't
/// be in the whitelist — without this match every scoped bar
/// would collapse onto a generic "Current week".
/// A repeated/truncated frame can leave an orphan scoped title in the
/// region: the scope wins only if no fixed title appears after it,
/// otherwise a half-drawn "Current week (Fable)" would relabel the
/// next bar.
fn last_week_scope(text: &str) -> Option<String> {
    // to_ascii_lowercase preserves the byte length → safe indices.
    let lower = text.to_ascii_lowercase();
    let needle = "current week";
    let mut found: Option<String> = None;
    let mut found_idx = 0usize;
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find(needle) {
        let start = from + rel;
        let mut i = start + needle.len();
        let bytes = lower.as_bytes();
        while i < bytes.len() && bytes[i] == b' ' {
            i += 1;
        }
        if i < bytes.len() && bytes[i] == b'(' {
            if let Some(close_rel) = lower[i + 1..].find(')') {
                let inner = &text[i + 1..i + 1 + close_rel];
                if !inner.trim().is_empty() && inner.len() <= 40 {
                    found = Some(clean_text(inner));
                    found_idx = start;
                }
                from = i + 1 + close_rel;
                continue;
            }
        }
        from = start + needle.len();
    }
    let scope = found?;
    for title in CLAUDE_FIXED_TITLES {
        if let Some(pos) = lower.rfind(title) {
            if pos > found_idx {
                return None;
            }
        }
    }
    Some(scope)
}

/// The PTY buffer keeps every TUI frame: a repaint can emit the same
/// bar several times. Keeps the freshest value per label, preserving the order
/// of first appearance (key without the cost suffix `· $x / $y`).
fn dedupe_sections(sections: Vec<UsageSection>) -> Vec<UsageSection> {
    let mut order: Vec<String> = Vec::new();
    let mut by_key: HashMap<String, UsageSection> = HashMap::new();
    for s in sections {
        let key = s
            .label
            .split(" · ")
            .next()
            .unwrap_or(&s.label)
            .trim()
            .to_lowercase();
        if !by_key.contains_key(&key) {
            order.push(key.clone());
        }
        by_key.insert(key, s);
    }
    order
        .into_iter()
        .filter_map(|k| by_key.remove(&k))
        .collect()
}

/// Per-model weekly bar to expose in the snapshot's flat fields.
/// Fable wins when present (it's the bucket that consumes usage credits), otherwise
/// the first scoped one found. `all models` is never a candidate: it's already
/// `weekly_percent`.
fn find_model_weekly_section(sections: &[UsageSection]) -> Option<ModelWeekly> {
    let mut scoped: Vec<ModelWeekly> = Vec::new();
    for s in sections {
        let lower = s.label.to_ascii_lowercase();
        if !lower.starts_with("current week") {
            continue;
        }
        let open = match s.label.find('(') {
            Some(p) => p,
            None => continue,
        };
        let close = match s.label[open + 1..].find(')') {
            Some(p) => open + 1 + p,
            None => continue,
        };
        let display_name = s.label[open + 1..close].trim().to_string();
        if display_name.is_empty()
            || NON_MODEL_WEEK_SCOPES.contains(&display_name.to_lowercase().as_str())
        {
            continue;
        }
        scoped.push(ModelWeekly {
            display_name,
            percent_used: s.percent_used,
            resets_label: s.resets_label.clone(),
        });
    }
    if scoped.is_empty() {
        return None;
    }
    let fable_idx = scoped
        .iter()
        .position(|s| s.display_name.to_lowercase().contains("fable"));
    Some(scoped.swap_remove(fable_idx.unwrap_or(0)))
}

/// parseClaudeUsage — "<N>% used" sections with label/resets/cost.
fn parse_claude_usage(text: &str) -> Option<ParsedUsage> {
    // Find all occurrences of "<N>% used".
    let hits = find_pct_used_hits(text);
    if hits.is_empty() {
        return None;
    }

    let chars: Vec<char> = text.chars().collect();
    let mut sections = Vec::new();
    for i in 0..hits.len() {
        let hit = &hits[i];
        let region_start = if i > 0 { hits[i - 1].end_idx } else { 0 };
        let before: String = chars[region_start..hit.idx].iter().collect();
        let region_end = if i < hits.len() - 1 {
            hits[i + 1].idx
        } else {
            chars.len()
        };
        let after: String = chars[hit.end_idx..region_end].iter().collect();

        let mut label = format!("Usage {}", i + 1);
        // Scoped weekly bars first: dynamic title, the whitelist
        // below would swallow "(Fable)" leaving a bare "Current week".
        if let Some(scope) = last_week_scope(&before) {
            label = format!("Current week ({scope})");
        } else {
            let before_norm: String = before
                .to_lowercase()
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect();
            for lbl in CLAUDE_LABELS {
                let lbl_norm: String = lbl
                    .to_lowercase()
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .collect();
                if before_norm.contains(&lbl_norm) {
                    label = lbl.to_string();
                    break;
                }
            }
        }

        let mut resets_label = String::new();
        if let Some(r) = match_resets(&after).or_else(|| match_resets(&before)) {
            resets_label = format_resets(&r);
        }

        if let Some((spent, total)) = match_cost_spent(&after) {
            label = format!("{label} · ${spent} / ${total}");
        }

        sections.push(UsageSection {
            label,
            percent_used: hit.pct,
            resets_label,
        });
    }

    let model = match_claude_model(text)
        .map(|m| clean_text(&m))
        .unwrap_or_default();

    Some(ParsedUsage {
        model,
        sections: dedupe_sections(sections),
        extra_usage_enabled: !text.contains("Extra usage not enabled"),
        activity_metrics: None,
    })
}

struct PctHit {
    pct: i64,
    idx: usize,
    end_idx: usize,
}

/// Finds "<N>% used" (case-insensitive, optional space): returns char-index positions.
fn find_pct_used_hits(text: &str) -> Vec<PctHit> {
    let chars: Vec<char> = text.chars().collect();
    let lower: Vec<char> = text.to_lowercase().chars().collect();
    let mut hits = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() {
            let start = i;
            let mut num = String::new();
            while i < chars.len() && chars[i].is_ascii_digit() {
                num.push(chars[i]);
                i += 1;
            }
            if i < chars.len() && chars[i] == '%' {
                let mut j = i + 1;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                let word: String = lower[j..(j + 4).min(lower.len())].iter().collect();
                if word == "used" {
                    let end = j + 4;
                    hits.push(PctHit {
                        pct: num.parse().unwrap_or(0),
                        idx: start,
                        end_idx: end,
                    });
                    i = end;
                    continue;
                }
            }
        } else {
            i += 1;
        }
    }
    hits
}

/// /Rese[ts]*\s*(.+)/i → captures the rest of the line (greedy to end of regex match = end of string,
/// but in practice .+ is single-line: we take up to newline to match observed behavior).
fn match_resets(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    // "rese" followed by repeated t/s.
    let pos = lower.find("rese")?;
    let after = &text[pos + 4..];
    let after_lower = &lower[pos + 4..];
    // skip the 't'/'s' characters.
    let mut k = 0;
    let ab = after_lower.as_bytes();
    while k < ab.len() && (ab[k] == b't' || ab[k] == b's') {
        k += 1;
    }
    // skip whitespace.
    let rest = &after[k..];
    let trimmed = rest.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    // .+ is single-line in JS → up to newline.
    let captured = trimmed.split('\n').next().unwrap_or(trimmed);
    if captured.is_empty() {
        None
    } else {
        Some(captured.to_string())
    }
}

/// /\$([\d.]+)\s*\/\s*\$([\d.]+)\s*spent/.
fn match_cost_spent(text: &str) -> Option<(String, String)> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' {
            let (a, ni) = take_num(text, i + 1);
            if !a.is_empty() {
                let mut j = ni;
                while j < bytes.len() && (bytes[j] as char).is_whitespace() {
                    j += 1;
                }
                if j < bytes.len() && bytes[j] == b'/' {
                    j += 1;
                    while j < bytes.len() && (bytes[j] as char).is_whitespace() {
                        j += 1;
                    }
                    if j < bytes.len() && bytes[j] == b'$' {
                        let (b, nj) = take_num(text, j + 1);
                        if !b.is_empty() {
                            let mut k = nj;
                            while k < bytes.len() && (bytes[k] as char).is_whitespace() {
                                k += 1;
                            }
                            if text[k..].to_lowercase().starts_with("spent") {
                                return Some((a, b));
                            }
                        }
                    }
                }
            }
        }
        i += 1;
    }
    None
}

fn take_num(text: &str, start: usize) -> (String, usize) {
    let bytes = text.as_bytes();
    let mut i = start;
    let mut out = String::new();
    while i < bytes.len() && ((bytes[i] as char).is_ascii_digit() || bytes[i] == b'.') {
        out.push(bytes[i] as char);
        i += 1;
    }
    (out, i)
}

/// Match of Claude model patterns (Opus/Sonnet/Haiku …).
fn match_claude_model(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    for kw in ["opus", "sonnet", "haiku", "fable"] {
        if let Some(pos) = lower.find(kw) {
            // capture "<Kw> X.Y" if a number follows, otherwise the word.
            let chars: Vec<char> = text.chars().collect();
            // rebuild char offset from byte-pos (approximation: ASCII keyword).
            let prefix_chars = text[..pos].chars().count();
            let mut end = prefix_chars + kw.len();
            // include an optional " X.Y".
            let mut j = end;
            // skip spaces.
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j].is_ascii_digit()) {
                while j < chars.len() && (chars[j].is_ascii_digit() || chars[j] == '.') {
                    j += 1;
                }
                end = j;
            }
            let captured: String = chars[prefix_chars..end].iter().collect();
            return Some(captured);
        }
    }
    None
}

/// parseCodexUsage — "<label>: <N>% (left|used|remaining)" per line.
fn parse_codex_usage(text: &str) -> Option<ParsedUsage> {
    let mut sections = Vec::new();
    for line in text.lines() {
        if let Some((label, pct, kind)) = parse_codex_limit_line(line) {
            let pct = pct.clamp(0, 100);
            let percent_used = if kind == "used" { pct } else { 100 - pct };
            sections.push(UsageSection {
                label: clean_text(&label),
                percent_used,
                resets_label: String::new(),
            });
        }
    }
    if sections.is_empty() {
        return None;
    }

    let model = match_codex_model(text).unwrap_or_default();
    Some(ParsedUsage {
        model,
        sections,
        extra_usage_enabled: true,
        activity_metrics: None,
    })
}

/// Extracts (label, pct, kind) from "<label>: <N>% <left|used|remaining>".
fn parse_codex_limit_line(line: &str) -> Option<(String, i64, String)> {
    let colon = line.find(':')?;
    let label = line[..colon].trim();
    if label.is_empty() || label.len() > 41 {
        return None;
    }
    // first alphanumeric char.
    if !label.chars().next()?.is_ascii_alphanumeric() {
        return None;
    }
    let rest = line[colon + 1..].trim_start();
    // number.
    let bytes = rest.as_bytes();
    let mut i = 0;
    let mut num = String::new();
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        num.push(bytes[i] as char);
        i += 1;
    }
    if num.is_empty() {
        return None;
    }
    while i < bytes.len() && (bytes[i] as char).is_whitespace() {
        i += 1;
    }
    if i >= bytes.len() || bytes[i] != b'%' {
        return None;
    }
    i += 1;
    while i < bytes.len() && (bytes[i] as char).is_whitespace() {
        i += 1;
    }
    let kind_rest = rest[i..].to_lowercase();
    for kind in ["left", "used", "remaining"] {
        if let Some(after) = kind_rest.strip_prefix(kind) {
            // word boundary \b: the next char must not be alphanumeric.
            if after.is_empty() || !after.chars().next().unwrap().is_alphanumeric() {
                return Some((label.to_string(), num.parse().ok()?, kind.to_string()));
            }
        }
    }
    None
}

/// "Model: <value>" up to a double space or a known label.
fn match_codex_model(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let pos = lower.find("model:")?;
    let after = &text[pos + 6..];
    // cut on '\n' or '│'.
    let mut val = after.split(['\n', '│']).next().unwrap_or(after);
    // cut on double space or a known label.
    if let Some(p) = val.find("  ") {
        val = &val[..p];
    }
    for lbl in [
        "Directory",
        "Permissions",
        "Agents.md",
        "Account",
        "Collaboration",
        "Session",
    ] {
        if let Some(p) = val.find(lbl) {
            val = &val[..p];
        }
    }
    let mut cleaned = clean_text(val);
    // remove trailing " (...)".
    if let Some(p) = cleaned.find('(') {
        cleaned = cleaned[..p].to_string();
    }
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// parseGeminiStats — activity metrics (no rate-limit).
fn parse_gemini_stats(text: &str) -> Option<ParsedUsage> {
    let grab = |label: &str| -> Option<String> {
        grab_line(text, label).map(|v| clean_text(&v.replace('»', "")).trim().to_string())
    };

    let session_id = grab("Session ID");
    let auth_method = grab("Auth Method");
    let tier = grab("Tier");
    let wall_time = grab("Wall Time");
    let agent_active = grab("Agent Active");
    let api_time = grab("API Time");
    let tool_time = grab("Tool Time");

    let success_rate_pct = grab_after_pct(text, "Success Rate");
    let (tool_calls, tool_calls_success, tool_calls_error) = grab_tool_calls(text);

    let metrics = ActivityMetrics {
        session_id: session_id.clone(),
        auth_method,
        tier: tier.clone(),
        tool_calls,
        tool_calls_success,
        tool_calls_error,
        success_rate_pct,
        wall_time,
        agent_active,
        api_time,
        tool_time,
        ..Default::default()
    };

    // hasAny: at least one field set.
    let has_any = metrics.session_id.is_some()
        || metrics.auth_method.is_some()
        || metrics.tier.is_some()
        || metrics.tool_calls.is_some()
        || metrics.tool_calls_success.is_some()
        || metrics.tool_calls_error.is_some()
        || metrics.success_rate_pct.is_some()
        || metrics.wall_time.is_some()
        || metrics.agent_active.is_some()
        || metrics.api_time.is_some()
        || metrics.tool_time.is_some();
    if !has_any {
        return None;
    }

    Some(ParsedUsage {
        model: tier.unwrap_or_default(),
        sections: Vec::new(),
        extra_usage_enabled: true,
        activity_metrics: Some(metrics),
    })
}

/// "<label>:\s*(rest of line)" case-insensitive.
fn grab_line(text: &str, label: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let label_lower = label.to_lowercase();
    // tolerant of whitespace between label words (e.g. "Session ID" / "Session  ID").
    // simplified: look for the first occurrence of the collapsed label.
    let collapsed_label: String = label_lower.split_whitespace().collect::<Vec<_>>().join(" ");
    // scan line by line.
    for line in text.lines() {
        let line_lower = line.to_lowercase();
        let collapsed_line: String = line_lower.split_whitespace().collect::<Vec<_>>().join(" ");
        if let Some(p) = collapsed_line.find(&format!("{collapsed_label}:")) {
            // get the part after the colon in the original line.
            // find the real ':' after the label in the raw line.
            if let Some(colon) = line.find(':') {
                let _ = p;
                let val = line[colon + 1..].trim();
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
            let _ = &lower;
        }
    }
    None
}

/// "<label>:\s*([\d.]+)\s*%".
fn grab_after_pct(text: &str, label: &str) -> Option<f64> {
    let v = grab_line(text, label)?;
    // extract the leading number.
    let mut num = String::new();
    for c in v.chars() {
        if c.is_ascii_digit() || c == '.' {
            num.push(c);
        } else {
            break;
        }
    }
    num.parse().ok()
}

/// "Tool Calls: <N> ( ✓ <S> x <E> )".
fn grab_tool_calls(text: &str) -> (Option<i64>, Option<i64>, Option<i64>) {
    let Some(v) = grab_line(text, "Tool Calls") else {
        return (None, None, None);
    };
    // leading N.
    let chars: Vec<char> = v.chars().collect();
    let mut i = 0;
    let mut n = String::new();
    while i < chars.len() && chars[i].is_ascii_digit() {
        n.push(chars[i]);
        i += 1;
    }
    let total = n.parse::<i64>().ok();
    // look for "(... S x E)".
    let rest: String = chars[i..].iter().collect();
    if let Some(open) = rest.find('(') {
        let inner = &rest[open + 1..];
        // extract two numbers separated by x/×.
        let nums = extract_two_nums_around_x(inner);
        return (total, nums.0, nums.1);
    }
    (total, None, None)
}

/// Extracts (S, E) from "✓ S x E" / "S × E".
fn extract_two_nums_around_x(s: &str) -> (Option<i64>, Option<i64>) {
    let lower = s.to_lowercase();
    // find the x or × separator between two digit groups.
    let chars: Vec<char> = lower.chars().collect();
    let mut nums: Vec<i64> = Vec::new();
    let mut cur = String::new();
    let mut saw_x = false;
    for c in chars {
        if c.is_ascii_digit() {
            cur.push(c);
        } else {
            if !cur.is_empty() {
                if let Ok(v) = cur.parse() {
                    nums.push(v);
                }
                cur.clear();
            }
            if c == 'x' || c == '×' {
                saw_x = true;
            }
            if c == ')' {
                break;
            }
        }
    }
    if !cur.is_empty() {
        if let Ok(v) = cur.parse() {
            nums.push(v);
        }
    }
    if saw_x && nums.len() >= 2 {
        (Some(nums[0]), Some(nums[1]))
    } else {
        (None, None)
    }
}

/// stripAnsi — strips ANSI sequences from probe output.
/// State scanner (no regex crate): CSI/OSC/8-bit/2-char/ESC/CR + box-chars + spaces.
fn strip_ansi(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            0x1b => {
                if i + 1 < bytes.len() {
                    match bytes[i + 1] {
                        b'[' => {
                            i += 2;
                            let param_start = i;
                            while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                                i += 1;
                            }
                            if i < bytes.len() {
                                // CUF (`ESC[nC`): without TERM the TUI uses it
                                // instead of spaces → re-expanded to n spaces,
                                // otherwise the labels arrive glued together.
                                if bytes[i] == b'C' {
                                    let n = std::str::from_utf8(&bytes[param_start..i])
                                        .ok()
                                        .and_then(|p| p.parse::<usize>().ok())
                                        .unwrap_or(1)
                                        .min(512);
                                    out.extend(std::iter::repeat_n(b' ', n));
                                } else if bytes[i] == b'G' {
                                    // CHA (`ESC[nG`, absolute column): CLI
                                    // 2.1.261 separates the trust dialog words this
                                    // way → at least one space, otherwise the
                                    // text arrives glued together (`Quicksafetycheck`).
                                    if !matches!(out.last(), None | Some(b' ') | Some(b'\n')) {
                                        out.push(b' ');
                                    }
                                }
                                i += 1;
                            }
                        }
                        b']' => {
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
                            i += 1;
                            while i < bytes.len() && (0x20..=0x2f).contains(&bytes[i]) {
                                i += 1;
                            }
                            if i < bytes.len() && (0x40..=0x7e).contains(&bytes[i]) {
                                i += 1;
                            }
                        }
                    }
                } else {
                    i += 1;
                }
            }
            0x9b => {
                i += 1;
                while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                    i += 1;
                }
                if i < bytes.len() {
                    i += 1;
                }
            }
            b'\r' => {
                i += 1;
            }
            _ => {
                out.push(b);
                i += 1;
            }
        }
    }
    // box-chars → space, then collapse.
    let text = String::from_utf8_lossy(&out);
    let no_box: String = text
        .chars()
        .map(|c| if BOX_CHARS.contains(&c) { ' ' } else { c })
        .collect();
    collapse_spaces(&no_box)
}

// ── provider-usage:* commands ──────────────────────────────────────────────

/// provider-usage:get — cached snapshot of a session (never triggers a probe).
#[tauri::command]
pub fn provider_usage_get(
    probe: tauri::State<'_, Arc<ProviderUsageProbe>>,
    session_id: String,
) -> Option<ProviderUsageSnapshot> {
    probe.get_snapshot(&session_id)
}

/// provider-usage:get-all — all snapshots (provider-keyed + session:<id>).
#[tauri::command]
pub fn provider_usage_get_all(
    probe: tauri::State<'_, Arc<ProviderUsageProbe>>,
) -> HashMap<String, ProviderUsageSnapshot> {
    probe.get_all_snapshots()
}

/// provider-usage:probe — forces a fresh probe; emits provider-usage:updated
/// or provider-usage:probe-failed.
///
/// async + spawn_blocking: the ephemeral CLI probe sleeps in 200-300ms steps
/// waiting for output — on a sync command it would run on the main thread and
/// freeze the window (beachball measured ~17s at boot via sample).
#[tauri::command]
///
/// `user_initiated`: true only from the Usage panel's refresh/retry buttons;
/// without it the provider CLI is never launched (see `may_launch_cli_probe`).
///
/// `provider` (optional): hint from the renderer after a data-only provider
/// switch (composer chip) — `session_providers` keeps the provider
/// from the spawn until the session restarts, so without the hint the probe
/// would query the old provider.
pub async fn provider_usage_probe(
    app: AppHandle,
    probe: tauri::State<'_, Arc<ProviderUsageProbe>>,
    sessions: tauri::State<'_, Arc<crate::commands::session::SessionManager>>,
    session_id: String,
    provider: Option<String>,
    user_initiated: Option<bool>,
) -> Result<Option<ProviderUsageSnapshot>, String> {
    let probe = probe.inner().clone();
    if let Some(p) = provider.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        probe.set_session_provider(&session_id, p);
    } else if let Some(p) = sessions
        .resolve_local_id(&session_id)
        .and_then(|id| sessions.provider_of(&id))
    {
        // No hint: the session's own provider, never the claude default — a
        // restored Plain Shell session missing from the map got a `claude`
        // probe (and its typed lines in the user's shell history).
        probe.set_session_provider(&session_id, &p);
    }
    let effective_provider = provider
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| probe.resolve_provider(&session_id));
    if effective_provider == "codex" {
        let explicit = sessions.provider_account_for(&session_id, "codex");
        let home = crate::commands::provider_account::resolve_account_env("codex", explicit)
            .and_then(|(env_var, dir, _)| (env_var == Some("CODEX_HOME")).then_some(dir));
        probe.set_codex_home(&session_id, home);
    }
    let user_initiated = user_initiated == Some(true);
    tauri::async_runtime::spawn_blocking(move || {
        probe.probe_requested(&app, &session_id, user_initiated)
    })
    .await
    .map_err(|e| e.to_string())
}

// ═════════════════════════════════════════════════════════════════════════
// Shared result type { ok, error? }.
// ═════════════════════════════════════════════════════════════════════════

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

// ═════════════════════════════════════════════════════════════════════════
// Tests — cover the pure parsers and the deterministic helpers.
// ═════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn usage_entry(
        session: &str,
        name: &str,
        ws: Option<&str>,
        ts: i64,
        used: i64,
        saved: i64,
    ) -> UsageEntry {
        UsageEntry {
            session_id: session.into(),
            session_name: name.into(),
            provider: "claude-code-cli".into(),
            model: "m".into(),
            workspace_path: ws.map(String::from),
            workspace_name: ws.map(basename),
            timestamp: ts,
            tokens_used: used,
            // Like legacy entries on disk: estimated = used (the old bug).
            tokens_estimated: used,
            tokens_saved: saved,
            efficiency: 87.9,
            cost_usd: 0.0,
            prompt_count: 1,
        }
    }

    #[test]
    fn usage_efficiency_is_saved_over_used_plus_saved() {
        // UX audit: 879 saved out of 1000 used showed 87.9% (saved/used).
        assert_eq!(usage_efficiency(1000, 879), 46.8);
        assert_eq!(usage_efficiency(1000, 0), 0.0);
        assert_eq!(usage_efficiency(0, 0), 0.0);
        assert_eq!(usage_efficiency(0, 500), 100.0);
        assert_eq!(usage_efficiency(-5, 10), 100.0);
    }

    #[test]
    fn usage_summary_totals_and_rows_use_the_displayed_formula() {
        let now = now_ms();
        let ring = [
            usage_entry("a", "/", Some("/"), now - 2000, 600, 300),
            usage_entry("a", "Fix login flow", Some("/"), now - 1000, 400, 579),
            usage_entry("b", "", Some("/Users/me/prompt-ops"), now - 500, 1000, 0),
        ];
        let entries: Vec<&UsageEntry> = ring.iter().collect();
        let rows = session_rollup(&entries);
        let a = rows.iter().find(|r| r.session_id == "a").unwrap();
        assert_eq!(a.tokens, 1000);
        assert_eq!(a.saved, 879);
        assert_eq!(a.efficiency, 46.8);
        // The last non-empty name wins and is never "/".
        assert_eq!(a.name, "Fix login flow");
        let b = rows.iter().find(|r| r.session_id == "b").unwrap();
        assert_eq!(b.name, "prompt-ops");
        assert_eq!(b.efficiency, 0.0);

        let total_used: i64 = ring.iter().map(|e| e.tokens_used).sum();
        let total_saved: i64 = ring.iter().map(|e| e.tokens_saved).sum();
        assert_eq!(usage_efficiency(total_used, total_saved), 30.5);
    }

    #[test]
    fn display_session_name_never_returns_a_bare_root() {
        assert_eq!(display_session_name("/", Some("/")), "");
        assert_eq!(display_session_name("/", None), "");
        assert_eq!(display_session_name("\\", Some("C:\\")), "");
        assert_eq!(display_session_name("/", Some("/Users/me/app/")), "app");
        assert_eq!(display_session_name("  ", Some("C:\\work\\api")), "api");
        assert_eq!(display_session_name("My session", Some("/")), "My session");
    }

    #[test]
    fn conversation_title_helpers() {
        assert_eq!(
            summarize_prompt("  fix the\n  login   bug \nmore"),
            Some("fix the".into())
        );
        assert_eq!(
            summarize_prompt("<command-name>/clear</command-name>"),
            None
        );
        assert_eq!(summarize_prompt("Caveat: the messages below"), None);
        let long = "a".repeat(80);
        let s = summarize_prompt(&long).unwrap();
        assert_eq!(s.chars().count(), 61);
        assert!(s.ends_with('…'));

        let v = json!({"type":"user","message":{"content":[{"type":"text","text":"Refactor the sidebar"}]}});
        assert_eq!(
            claude_user_text(&v).as_deref(),
            Some("Refactor the sidebar")
        );
        let meta = json!({"type":"user","isMeta":true,"message":{"content":"x"}});
        assert_eq!(claude_user_text(&meta), None);
        let tool =
            json!({"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}});
        assert_eq!(claude_user_text(&tool), None);
    }

    #[test]
    fn savings_availability_survives_history_and_matches_live_payload() {
        let mut store = TokenStore::default();
        TokenTracker::init_session(&mut store, "s");
        let payload = TokenTracker::build_update_payload(&store, "s").unwrap();
        assert_eq!(payload["stats"]["savings_available"], false);
        assert_eq!(
            serde_json::to_value(&store.sessions["s"]).unwrap()["savingsAvailable"],
            false
        );

        // Legacy histories lack the availability field, but retain their estimates.
        let mut legacy = serde_json::to_value(SessionTokenState::default()).unwrap();
        legacy.as_object_mut().unwrap().remove("savingsAvailable");
        legacy["tokensUsed"] = json!(1000);
        legacy["tokensEstimated"] = json!(1300);
        legacy["tokensSaved"] = json!(300);
        let history: SessionTokenState = serde_json::from_value(legacy).unwrap();
        merge_token_history(store.sessions.get_mut("s").unwrap(), &history);
        let payload = TokenTracker::build_update_payload(&store, "s").unwrap();
        assert_eq!(payload["stats"]["savings_available"], true);
        assert_eq!(payload["stats"]["tokens_saved"], 300);

        let persisted = serde_json::to_value(&store.sessions["s"]).unwrap();
        let restored: SessionTokenState = serde_json::from_value(persisted).unwrap();
        assert!(restored.savings_available);
        let mut fresh = SessionTokenState::default();
        merge_token_history(&mut fresh, &SessionTokenState::default());
        assert!(!fresh.savings_available);
    }

    #[test]
    fn late_usage_reconciles_only_the_identified_provisional_turn_after_reload() {
        let mut store = TokenStore::default();
        TokenTracker::init_session(&mut store, "s");
        for id in ["old", "new"] {
            store.active_turns.insert("s".into(), id.into());
            let state = store.sessions.get_mut("s").unwrap();
            state.tokens_used += 5000;
            state.tokens_estimated += 5000;
            state.prompt_count += 1;
            state.breakdown.context_estimated += 5000;
            TokenTracker::remember_estimate(
                &mut store,
                "s",
                ProvisionalTurn {
                    used: 5000,
                    baseline: 5000,
                    prompts: 1,
                    context: 5000,
                    ..Default::default()
                },
            );
        }
        let encoded = serde_json::to_vec(&store.sessions["s"]).unwrap();
        let mut restored = TokenStore::default();
        restored
            .sessions
            .insert("s".into(), serde_json::from_slice(&encoded).unwrap());
        TokenTracker::reconcile_estimate(&mut restored, "s", None);
        assert_eq!(restored.sessions["s"].tokens_used, 10000); // ambiguous: don't guess
        TokenTracker::reconcile_estimate(&mut restored, "s", Some("old"));
        assert_eq!(restored.sessions["s"].tokens_used, 5000);
        assert_eq!(restored.sessions["s"].prompt_count, 1);
        assert!(restored.sessions["s"].provisional_turns.contains_key("new"));
        TokenTracker::reconcile_estimate(&mut restored, "s", Some("old"));
        assert_eq!(restored.sessions["s"].tokens_used, 5000);
    }

    #[test]
    fn multiple_estimate_flushes_keep_one_prompt_and_preserve_historical_savings() {
        let mut store = TokenStore::default();
        TokenTracker::init_session(&mut store, "s");
        store.sessions.get_mut("s").unwrap().tokens_saved = 300;
        for _ in 0..2 {
            store.sessions.get_mut("s").unwrap().prompt_count += 1;
            TokenTracker::remember_estimate(
                &mut store,
                "s",
                ProvisionalTurn {
                    used: 1000,
                    baseline: 1000,
                    prompts: 1,
                    context: 1000,
                    ..Default::default()
                },
            );
        }
        assert_eq!(store.sessions["s"].prompt_count, 1);
        assert_eq!(store.sessions["s"].tokens_saved, 300);
        assert_eq!(
            store.sessions["s"]
                .provisional_turns
                .values()
                .next()
                .unwrap()
                .used,
            2000
        );
    }

    #[test]
    fn token_history_survives_restart_late_binding_and_session_end() {
        let dir = std::env::temp_dir().join(format!("token-history-{}", uuid_like()));
        let path = dir.join("history.json");
        let first = TokenTracker::with_history_path(path.clone());
        first.restore_key("old-runtime", "db:stable".into());
        {
            let mut store = first.store.lock();
            TokenTracker::init_session(&mut store, "old-runtime");
            let state = store.sessions.get_mut("old-runtime").unwrap();
            state.tokens_used = 1000;
            state.tokens_estimated = 2000;
            state.prompt_count = 1;
        }
        first.persist_session("old-runtime");
        let reopened = TokenTracker::with_history_path(path.clone());
        {
            let mut store = reopened.store.lock();
            TokenTracker::init_session(&mut store, "new-runtime");
            let state = store.sessions.get_mut("new-runtime").unwrap();
            state.tokens_used = 200;
            state.tokens_estimated = 400;
            state.prompt_count = 1;
        }
        reopened.restore_key("new-runtime", "history:stable".into());
        reopened.restore_key("new-runtime", "history:stable".into());
        assert_eq!(
            reopened.session_stats("new-runtime").unwrap().tokens_used,
            1200
        );
        reopened.remove_session("new-runtime");
        assert_eq!(
            reopened.session_stats("new-runtime").unwrap().tokens_used,
            1200
        );
        let third = TokenTracker::with_history_path(path.clone());
        third.restore_key("third-runtime", "history:stable".into());
        assert_eq!(
            third.session_stats("third-runtime").unwrap().prompt_count,
            2
        );
        // Latest complete snapshot remains readable if a primary is corrupted.
        third.persist_session("third-runtime");
        std::fs::write(&path, "{interrupted").unwrap();
        let recovered = TokenTracker::with_history_path(path);
        recovered.restore_key("recovered-runtime", "history:stable".into());
        assert_eq!(
            recovered
                .session_stats("recovered-runtime")
                .unwrap()
                .tokens_used,
            1200
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn token_history_keeps_only_the_most_recent_sessions() {
        let dir = std::env::temp_dir().join(format!("token-history-cap-{}", uuid_like()));
        let path = dir.join("history.json");
        let tracker = TokenTracker::with_history_path(path.clone());
        tracker.restore_key("live", "history:live".into());
        {
            let mut history = tracker.history.lock();
            for i in 0..(MAX_HISTORY_ENTRIES + 50) {
                let state = SessionTokenState {
                    history_saved_ms: 1_000 + i as i64,
                    ..Default::default()
                };
                history.entries.insert(format!("history:old-{i}"), state);
            }
            // The live session is the oldest of all but must survive.
            history
                .entries
                .insert("history:live".into(), SessionTokenState::default());
            history.save().unwrap();
        }
        let reopened = TokenTracker::with_history_path(path);
        let mut history = reopened.history.lock();
        history.load();
        assert_eq!(history.entries.len(), MAX_HISTORY_ENTRIES);
        assert!(history.entries.contains_key("history:live"));
        assert!(!history.entries.contains_key("history:old-0"));
        assert!(history
            .entries
            .contains_key(&format!("history:old-{}", MAX_HISTORY_ENTRIES + 49)));
        drop(history);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn scan_index_forgets_deleted_transcripts() {
        let dir = std::env::temp_dir().join(format!("scan-index-{}", uuid_like()));
        std::fs::create_dir_all(&dir).unwrap();
        let kept = dir.join("kept.jsonl");
        std::fs::write(&kept, "{}").unwrap();
        let mut index = ScanIndex {
            path: dir.join("index.json"),
            state: HashMap::new(),
        };
        let ids = HashSet::from(["a".to_string()]);
        index.upsert_file(&kept.to_string_lossy(), 1, 2, ids.clone());
        index.upsert_file(&dir.join("gone.jsonl").to_string_lossy(), 1, 2, ids);
        index.save();
        assert_eq!(index.state.len(), 1);
        let raw = std::fs::read_to_string(dir.join("index.json")).unwrap();
        assert!(raw.contains("kept.jsonl") && !raw.contains("gone.jsonl"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn usage_probe_survives_multibyte_text_after_the_cli_name() {
        // Claude's banner: the name followed by box drawing (3 bytes per char)
        // within 60 bytes used to panic on a non-boundary slice.
        for pad in 0..4 {
            let text = format!(
                "welcome to claude code{} {}",
                " ".repeat(pad),
                "│─╭╮".repeat(30)
            );
            assert!(!command_not_found("claude", &text));
        }
        assert!(command_not_found(
            "claude",
            "zsh: claude: command not found ╭──╮"
        ));
    }

    #[test]
    fn provider_cli_is_launched_only_on_user_action_or_for_its_own_running_session() {
        use ProbeOrigin::*;
        // App start, session switch, panel open: never.
        assert!(!may_launch_cli_probe(
            Automatic,
            Some("claude-code-cli"),
            "claude-code-cli"
        ));
        assert!(!may_launch_cli_probe(
            Automatic,
            Some("generic-shell"),
            "claude-code-cli"
        ));
        assert!(!may_launch_cli_probe(Automatic, None, "claude-code-cli"));
        // A hook of the session's own CLI: only that provider.
        assert!(may_launch_cli_probe(
            SessionCliRunning,
            Some("claude-code-cli"),
            "claude-code-cli"
        ));
        assert!(may_launch_cli_probe(
            SessionCliRunning,
            Some("codex"),
            "codex"
        ));
        assert!(!may_launch_cli_probe(
            SessionCliRunning,
            Some("generic-shell"),
            "claude-code-cli"
        ));
        assert!(!may_launch_cli_probe(
            SessionCliRunning,
            None,
            "claude-code-cli"
        ));
        assert!(!may_launch_cli_probe(
            SessionCliRunning,
            Some("codex"),
            "claude-code-cli"
        ));
        // Explicit refresh / retry.
        assert!(may_launch_cli_probe(
            UserAction,
            Some("generic-shell"),
            "claude-code-cli"
        ));
    }

    #[test]
    fn token_initialization_preserves_in_flight_reads() {
        let tracker = TokenTracker::new();
        for i in 0..10 {
            tracker.handle_tool_use("s1", "Read", &json!({"file_path": format!("/file-{i}")}));
        }
        tracker.handle_tool_use("s2", "Read", &json!({"file_path": "/other"}));
        let mut store = tracker.store.lock();
        TokenTracker::init_session(&mut store, "s1");
        assert_eq!(store.pending_estimation["s1"].tool_count, 10);
        assert_eq!(store.pending_estimation["s1"].file_chars, 50_000.0);
        assert_eq!(store.pending_estimation["s2"].tool_count, 1);
    }

    #[test]
    fn accounted_output_does_not_consume_other_sessions_or_future_output() {
        let mut store = TokenStore::default();
        store.output_accumulator.insert(
            "s1".into(),
            OutputAcc {
                chars: 1000,
                ..Default::default()
            },
        );
        store.output_accumulator.insert(
            "s2".into(),
            OutputAcc {
                chars: 2000,
                ..Default::default()
            },
        );
        TokenTracker::mark_output_accounted(&mut store, "s1");
        assert_eq!(store.output_accumulator["s1"].flushed_chars, 1000);
        assert_eq!(store.output_accumulator["s2"].flushed_chars, 0);
        store.output_accumulator.get_mut("s1").unwrap().chars += 500;
        let acc = &store.output_accumulator["s1"];
        assert_eq!(acc.chars - acc.flushed_chars, 500);
    }

    #[test]
    fn strip_ansi_removes_csi_and_box() {
        let input = "\x1b[31mhello\x1b[0m\r│world│";
        assert_eq!(strip_ansi(input), "hello world ");
    }

    #[test]
    fn strip_ansi_cha_becomes_word_separator() {
        // Real CLI 2.1.261 trust dialog frame (absolute columns).
        let input = "\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\r\r\n\x1b[2GYes,\x1b[7GI\x1b[9Gtrust\x1b[15Gthis\x1b[20Gfolder";
        let out = strip_ansi(input);
        assert!(out.contains("Quick safety check: Is this"), "{out}");
        assert!(out.contains("Yes, I trust this folder"), "{out}");
        assert!(contains_ci(&out, "trust this folder"));
    }

    #[test]
    fn strip_ansi_expands_cursor_forward_to_spaces() {
        // Without TERM (app launched from Finder) ink uses `ESC[nC` instead of spaces.
        let input = "Current\x1b[1Cweek\x1b[1C(all\x1b[1Cmodels)\x1b[17C34%\x1b[Cused";
        assert_eq!(strip_ansi(input), "Current week (all models) 34% used");
        let parsed = parse_claude_usage(&strip_ansi(
            "Current\x1b[1Csession 6% used Current\x1b[1Cweek\x1b[1C(Fable) 63% used",
        ))
        .expect("should parse");
        assert_eq!(parsed.sections[1].label, "Current week (Fable)");
    }

    #[test]
    fn parse_claude_usage_basic() {
        let text = "Current session 42% used Resets Jan 1, 3pm Current week (all models) 10% used";
        let parsed = parse_claude_usage(text).expect("should parse");
        assert_eq!(parsed.sections.len(), 2);
        assert_eq!(parsed.sections[0].percent_used, 42);
        assert_eq!(parsed.sections[0].label, "Current session");
        assert_eq!(parsed.sections[1].percent_used, 10);
        assert!(parsed.extra_usage_enabled);
    }

    /// ANSI-stripped form of the `/usage` panel with the Fable bucket.
    const PANEL_FABLE: &str = "Current session 45% used Resets Feb 3, 3pm \
         Current week (all models) 18% used Resets Feb 5 \
         Current week (Sonnet only) 7% used Resets Feb 5 \
         Current week (Fable) 12% used Resets Feb 5";

    #[test]
    fn parse_claude_usage_keeps_model_scoped_week() {
        let parsed = parse_claude_usage(PANEL_FABLE).expect("should parse");
        assert_eq!(parsed.sections.len(), 4);
        assert_eq!(parsed.sections[1].label, "Current week (all models)");
        assert_eq!(parsed.sections[2].label, "Current week (Sonnet only)");
        // Without the dynamic match this would collapse onto "Current week".
        assert_eq!(parsed.sections[3].label, "Current week (Fable)");
        assert_eq!(parsed.sections[3].percent_used, 12);

        let scoped = find_model_weekly_section(&parsed.sections).expect("bucket Fable");
        assert_eq!(scoped.display_name, "Fable");
        assert_eq!(scoped.percent_used, 12);
    }

    #[test]
    fn parse_claude_usage_dedupes_repainted_frames() {
        let text = format!("{PANEL_FABLE} Current session 46% used Current week (Fable) 13% used");
        let parsed = parse_claude_usage(&text).expect("should parse");
        assert_eq!(
            parsed.sections.len(),
            4,
            "repaint does not duplicate the bars"
        );
        assert_eq!(
            parsed.sections[0].percent_used, 46,
            "the freshest frame wins"
        );
        assert_eq!(parsed.sections[3].percent_used, 13);
    }

    #[test]
    fn parse_claude_usage_orphan_scope_does_not_hijack_next_bar() {
        // Truncated frame: scoped title without its bar.
        let text =
            "Current week (Fable) Current session 45% used Current week (all models) 18% used";
        let parsed = parse_claude_usage(text).expect("should parse");
        assert_eq!(parsed.sections[0].label, "Current session");
        assert_eq!(parsed.sections[1].label, "Current week (all models)");
    }

    /// Since CLI 2.1.225, below the "Resets …" line come promo banners and the
    /// "What's contributing…" panel without newlines (the TUI moves the cursor):
    /// the resets label must stop at the date/time.
    #[test]
    fn parse_claude_usage_resets_stop_at_date_time() {
        let text = "Current session 4% used Resets 8pm (Europe/Rome) \
                    Current week (all models) 38% used Resets Aug 13 at 9pm (Europe/Rome)\
                    +50% weekly limits promo through Aug 19 · clau.de/cc-50-promo\
                    What's contributing to your limits usage? Approximate, based on local sessions on this machine \
                    Current week (Fable) 65% used Resets Aug 13 at 8:59pm (Europe/Rome) Scanning local sessions…";
        let parsed = parse_claude_usage(text).expect("should parse");
        assert_eq!(parsed.sections[0].resets_label, "8pm");
        assert_eq!(parsed.sections[1].resets_label, "Aug 13, 9pm");
        let fable = find_model_weekly_section(&parsed.sections).expect("fable bucket");
        assert_eq!(fable.display_name, "Fable");
        assert_eq!(fable.percent_used, 65);
        assert_eq!(fable.resets_label, "Aug 13, 8:59pm");
    }

    /// Real 120x30 PTY capture of CLI 2.1.229: no space between `%` and
    /// `used`, and between the all-models bar and the per-model one there are the
    /// `Refreshing…` spinner and the "What's contributing…" panel.
    #[test]
    fn parse_claude_usage_cli_2_1_229_layout() {
        let text = "Current session█████                                             10%usedResets 4am (Europe/Rome)\
                    Current week (all models)██████████████████████████▌                       53%usedResets Aug 13 at 9pm (Europe/Rome)\
                    +50% weekly limits promo through Aug 19 · clau.de/cc-50-promo\
                    What's contributing to your limits usage?Approximate, based on local sessions on this machine\
                       Scanning local sessions…   Refreshing… Esc to cancl▌1\
                    Current week (Fable)█████████████████████████████████████████████      90% usedResets Aug 13 at 9pm (Europe/Rome)";
        let parsed = parse_claude_usage(text).expect("should parse");
        assert_eq!(parsed.sections.len(), 3);
        assert_eq!(parsed.sections[0].percent_used, 10);
        assert_eq!(parsed.sections[1].label, "Current week (all models)");
        let fable = find_model_weekly_section(&parsed.sections).expect("fable bucket");
        assert_eq!(fable.display_name, "Fable");
        assert_eq!(fable.percent_used, 90);
        assert_eq!(fable.resets_label, "Aug 13, 9pm");
    }

    #[test]
    fn model_weekly_ignores_all_models_scope() {
        let parsed =
            parse_claude_usage("Current session 45% used Current week (all models) 18% used")
                .expect("should parse");
        assert!(find_model_weekly_section(&parsed.sections).is_none());
    }

    #[test]
    fn parse_codex_converts_left_to_used() {
        let text = "Model: gpt-5.4 (reasoning)\n5h limit: 100% left\nWeekly: 20% used";
        let parsed = parse_codex_usage(text).expect("should parse");
        assert_eq!(parsed.sections.len(), 2);
        // 100% left → 0% used
        assert_eq!(parsed.sections[0].percent_used, 0);
        // 20% used → 20% used
        assert_eq!(parsed.sections[1].percent_used, 20);
        assert_eq!(parsed.model, "gpt-5.4");
    }

    #[test]
    fn parse_gemini_activity() {
        let text = "Interaction Summary\nSession ID: abc-123\nTier: Gemini Code\nTool Calls: 5 ( 4 x 1 )\nSuccess Rate: 80.0%\nWall Time: 3m 7s";
        let parsed = parse_gemini_stats(text).expect("should parse");
        let m = parsed.activity_metrics.expect("metrics");
        assert_eq!(m.session_id.as_deref(), Some("abc-123"));
        assert_eq!(m.tool_calls, Some(5));
        assert_eq!(m.tool_calls_success, Some(4));
        assert_eq!(m.tool_calls_error, Some(1));
        assert_eq!(m.success_rate_pct, Some(80.0));
        assert_eq!(m.wall_time.as_deref(), Some("3m 7s"));
    }

    /// LIVE probe against the installed CLI (real PTY): `cargo test --lib
    /// live_claude_usage_probe -- --ignored --nocapture`. Diagnostics only.
    #[test]
    #[ignore]
    fn live_claude_usage_probe() {
        let provider =
            std::env::var("PROMPTOPS_LIVE_PROVIDER").unwrap_or_else(|_| "claude-code-cli".into());
        let strategy = resolve_strategy(&provider).expect("strategy");
        let started = Instant::now();
        match spawn_ephemeral_probe("live-test", &strategy) {
            ProbeOutcome::Ok(s) => eprintln!(
                "LIVE OK in {:?}: session={}% weekly={}% model={}:{}% sections={}",
                started.elapsed(),
                s.session_percent,
                s.weekly_percent,
                s.model_weekly_label,
                s.model_weekly_percent,
                s.sections.len()
            ),
            ProbeOutcome::Failed { reason, detail } => {
                eprintln!(
                    "LIVE FAILED in {:?}: reason={reason} detail={detail:?}",
                    started.elapsed()
                )
            }
        }
    }

    #[test]
    fn trust_dialog_cursor_detection() {
        // CLI 2.1.261: default "No, exit" → arrow down needed.
        let new_dialog = "Quick safety check: Is this a project you created or one you trust?\n\
                          ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel";
        assert!(trust_dialog_cursor_on_no(new_dialog));
        // Cursor separated by spaces expanded from ESC[nC / nbsp.
        assert!(trust_dialog_cursor_on_no(
            "❯\u{a0}   No,exit\n Yes, I trust this folder"
        ));
        // Old dialog: default "Yes" → direct Enter.
        let old_dialog = "Do you trust the files in this folder?\n❯ Yes, proceed\n  No, exit";
        assert!(!trust_dialog_cursor_on_no(old_dialog));
        // After manual selection the cursor is on Yes.
        assert!(!trust_dialog_cursor_on_no(
            "  No, exit\n ❯Yes, I trust this folder"
        ));
        assert!(!trust_dialog_cursor_on_no("no cursor"));
        // Real CLI 2.1.261 buffer (glued words): dialog detection
        // must be whitespace-insensitive, the cursor on "No".
        let glued = "Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?\n❯No,exit\nYes,Itrustthisfolder\nEntertoconfirm·Esctocancel";
        assert!(contains_ci_compact(glued, "trust this folder"));
        assert!(!contains_ci(glued, "trust this folder"));
        assert!(trust_dialog_cursor_on_no(glued));
    }

    #[test]
    fn output_ready_markers() {
        assert!(output_ready_re(
            "claude-code-cli",
            "you have 42% used today"
        ));
        assert!(output_ready_re("codex", "5h limit: 100% left"));
        assert!(output_ready_re("gemini-cli", "Interaction Summary box"));
        assert!(!output_ready_re("claude-code-cli", "nothing here"));
    }

    #[test]
    fn pricing_resolves_model_hint() {
        let p = resolve_pricing("claude-code-cli", Some("claude-sonnet-4-6-20260101"));
        assert_eq!(p.label, "Claude Sonnet 4.6");
        let d = resolve_pricing("claude-code-cli", None);
        assert_eq!(d.label, "Claude Opus 5");
    }

    #[test]
    fn transcript_delta_is_incremental_and_scoped_to_turn() {
        let dir = std::env::temp_dir().join(format!("transcript-{}", uuid_like()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        let p = path.to_string_lossy().to_string();
        let line = |id: &str, ts: &str, i: i64, o: i64, cr: i64| {
            format!(
            "{{\"type\":\"assistant\",\"timestamp\":\"{ts}\",\"message\":{{\"id\":\"{id}\",\"model\":\"claude-sonnet-5\",\"usage\":{{\"input_tokens\":{i},\"output_tokens\":{o},\"cache_read_input_tokens\":{cr},\"cache_creation_input_tokens\":0}}}}}}\n")
        };
        let old = line("m0", "2020-01-01T00:00:00.000Z", 999, 999, 999);
        let streamed = line("m1", "2099-01-01T00:00:00.000Z", 10, 1, 100)
            + &line("m1", "2099-01-01T00:00:00.000Z", 10, 5, 100);
        std::fs::write(&path, format!("{old}{{\"type\":\"user\"}}\n{streamed}")).unwrap();

        let tracker = TokenTracker::new();
        // Without a known turn start: attach at EOF, history is not counted.
        assert!(tracker.read_transcript_delta("s", &p).is_none());
        let tracker = TokenTracker::new();
        tracker.begin_turn("s", None);
        let d = tracker.read_transcript_delta("s", &p).unwrap();
        // m0 outside the turn excluded; streamed m1 counted once with the last usage.
        assert_eq!(
            (d.input, d.output, d.cache_read, d.max_context),
            (10, 5, 100, 110)
        );
        assert_eq!(d.model.as_deref(), Some("claude-sonnet-5"));
        // No new bytes → nothing.
        assert!(tracker.read_transcript_delta("s", &p).is_none());
        // New line (even with an id already seen in the next batch): only the delta.
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        use std::io::Write;
        f.write_all(
            (line("m1", "2099-01-01T00:00:00.000Z", 10, 5, 100)
                + &line("m2", "2099-01-01T00:00:01.000Z", 3, 2, 50))
                .as_bytes(),
        )
        .unwrap();
        let d = tracker.read_transcript_delta("s", &p).unwrap();
        assert_eq!((d.input, d.output, d.cache_read), (3, 2, 50));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn compaction_by_promptops_is_measured_and_cold_resume_counted() {
        let msg = |id: &str, ts: i64, ctx: i64, cw: i64| {
            TranscriptEvent::Msg(TranscriptMsg {
                id: id.into(),
                input: 10,
                output: 5,
                cache_read: ctx - 10 - cw,
                cache_write: cw,
                ts,
                ttl_1h: false,
            })
        };
        let tracker = TokenTracker::new();
        // Auto or unrequested compaction: no credit.
        tracker.apply_transcript_events(
            "s",
            None,
            &[
                msg("a", 1_000, 150_000, 0),
                TranscriptEvent::Boundary {
                    manual: true,
                    pre: 150_000,
                    post: 20_000,
                },
                msg("b", 2_000, 21_000, 0),
            ],
        );
        assert!(!tracker.session_stats("s").unwrap().savings_available);
        // PromptOps request: 2 calls with reduced context, then the context grows back to pre.
        tracker.mark_compact_requested("s");
        tracker.apply_transcript_events(
            "s",
            None,
            &[
                TranscriptEvent::Boundary {
                    manual: true,
                    pre: 150_000,
                    post: 20_000,
                },
                msg("c", 3_000, 22_000, 0),
                msg("d", 4_000, 30_000, 0),
                msg("e", 5_000, 151_000, 0),
                msg("f", 6_000, 40_000, 0),
            ],
        );
        let st = tracker.session_stats("s").unwrap();
        assert!(st.savings_available);
        assert_eq!(st.compactions_by_promptops, 1);
        // 2 × 130K saved − 150K for the compaction pass.
        assert_eq!(
            st.optimization_analytics["used_compaction"].tokens_saved,
            2 * 130_000 - 150_000
        );
        assert_eq!(st.tokens_saved, 2 * 130_000 - 150_000);
        // Resume after 6 min (TTL 5 min) that rewrites the cache.
        tracker.apply_transcript_events("s", None, &[msg("g", 6_000 + 360_000, 40_000, 39_000)]);
        let st = tracker.session_stats("s").unwrap();
        assert_eq!((st.cold_resume_count, st.cold_resume_tokens), (1, 39_000));
        assert_eq!(st.last_context_tokens, 40_000);
    }

    #[test]
    fn agent_transcripts_keep_their_own_cache_activity() {
        let msg = |id: &str, ts: i64, ctx: i64, cw: i64| {
            TranscriptEvent::Msg(TranscriptMsg {
                id: id.into(),
                input: 10,
                output: 5,
                cache_read: ctx - 10 - cw,
                cache_write: cw,
                ts,
                ttl_1h: false,
            })
        };
        let tracker = TokenTracker::new();
        tracker.apply_transcript_events("s", None, &[msg("m1", 1_000, 90_000, 0)]);
        // The agent starts 10 min later: first call of ITS conversation, not a cold resume.
        tracker.apply_transcript_events("s", Some("sa1"), &[msg("a1", 601_000, 30_000, 29_000)]);
        let st = tracker.session_stats("s").unwrap();
        assert_eq!(st.cold_resume_count, 0);
        assert_eq!(
            (st.last_context_tokens, st.last_activity_ms),
            (90_000, 1_000)
        );
        let a = st.agent_contexts["sa1"];
        assert_eq!(
            (a.last_context_tokens, a.last_activity_ms, a.cache_ttl_ms),
            (30_000, 601_000, 300_000)
        );
        // Agent resume after the TTL: it counts, and stays on the agent.
        tracker.apply_transcript_events("s", Some("sa1"), &[msg("a2", 1_000_000, 31_000, 30_000)]);
        let st = tracker.session_stats("s").unwrap();
        assert_eq!(st.cold_resume_count, 1);
        assert_eq!(st.last_context_tokens, 90_000);
    }

    #[test]
    fn legacy_history_without_cache_fields_deserializes() {
        let legacy = json!({"tokensUsed": 5, "tokensEstimated": 5, "tokensSaved": 0, "efficiencyPercentage": 0.0,
            "breakdown": {"file_reads_estimated": 0, "tool_schema_estimated": 0, "context_estimated": 0, "actual_tokens": 5},
            "optimizationFlags": {}, "optimizationAnalytics": {}, "promptCount": 1});
        let state: SessionTokenState = serde_json::from_value(legacy).unwrap();
        assert_eq!(state.cache_read_tokens, 0);
        assert_eq!(state.cost_usd, 0.0);
    }

    #[test]
    fn token_record_updates_state() {
        let tracker = TokenTracker::new();
        // record without AppHandle: we test the logic via the store directly.
        let mut store = tracker.store.lock();
        TokenTracker::init_session(&mut store, "s1");
        let state = store.sessions.get_mut("s1").unwrap();
        state.tokens_used += 1000;
        state.tokens_estimated += 2000;
        state.tokens_saved = (state.tokens_estimated - state.tokens_used).max(0);
        assert_eq!(state.tokens_saved, 1000);
    }

    #[test]
    fn file_cache_hash_detects_unchanged() {
        let cache = FileReadCache::new();
        let dir = std::env::temp_dir();
        let path = dir.join(format!("metrics-test-{}.txt", uuid_like()));
        std::fs::write(&path, "hello world content").unwrap();
        let p = path.to_string_lossy().to_string();
        assert_eq!(cache.track_file_read("s1", &p), 0); // first read
        let redundant = cache.track_file_read("s1", &p); // unchanged re-read
        assert!(redundant > 0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn parse_iso_roundtrip() {
        let ms = parse_iso_ms("2026-06-23T12:00:00.000Z").unwrap();
        assert_eq!(iso_from_ms(ms), "2026-06-23T12:00:00.000Z");
    }

    fn uuid_like() -> String {
        format!("{}", now_ms())
    }
}

#[cfg(test)]
mod usage_probe_shell_tests {
    use super::*;

    #[test]
    fn probe_runs_the_cli_as_a_command_not_as_typed_input() {
        let args = probe_shell_args("claude");
        if IS_WINDOWS {
            assert!(!args.iter().any(|a| a == "claude"));
        } else {
            assert_eq!(args, vec!["-l", "-i", "-c", "claude"]);
        }
    }

    #[test]
    fn zsh_dash_c_not_found_is_detected() {
        assert!(command_not_found(
            "claude",
            "zsh:1: command not found: claude"
        ));
    }
}
