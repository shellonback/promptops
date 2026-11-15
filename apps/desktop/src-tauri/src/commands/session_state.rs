//! Session state (context management).
//!
//! The agent of the MAIN session keeps two files in
//! `<workspace>/.promptops/sessions/<dbId>/`: `state.md` (rewritten whole)
//! and `logbook.md` (append only). PromptOps reads them only for the handoff.
//!
//! Off by default, per workspace. While the feature is off no function of
//! this module changes anything: no flag on the launch line, no approval,
//! no read, no file. No threads, timers or watchers: the list of workspaces
//! turned on is read once and stays in memory.
//!
//! Emergency switch: `PROMPTOPS_SESSION_STATE=0` turns everything off.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Cap of the read for the handoff (whole state + tail of the logbook).
const HANDOFF_MAX_BYTES: usize = 8 * 1024;
const STATE_FILE: &str = "state.md";
const LOGBOOK_FILE: &str = "logbook.md";
/// Entry for `.git/info/exclude` or `.gitignore`.
const IGNORE_ENTRY: &str = ".promptops/sessions/";

fn kill_switch() -> bool {
    matches!(
        std::env::var("PROMPTOPS_SESSION_STATE").as_deref(),
        Ok("0") | Ok("false")
    )
}

// ── Workspaces turned on (local preference of the device) ─────────────────

#[derive(Default, Serialize, Deserialize)]
struct Store {
    /// Main switch (Settings → "Context management"). Off by default:
    /// while it is off no workspace counts as turned on.
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    workspaces: Vec<String>,
}

fn store_path() -> PathBuf {
    crate::commands::hook::hook_data_dir().join("session-state.json")
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| {
        let loaded = std::fs::read_to_string(store_path())
            .ok()
            .and_then(|raw| serde_json::from_str::<Store>(&raw).ok())
            .unwrap_or_default();
        Mutex::new(loaded)
    })
}

/// Stable key of a workspace: canonical path if it exists, else as given.
fn workspace_key(workspace: &str) -> Option<String> {
    let trimmed = workspace.trim();
    if trimmed.is_empty() || crate::commands::remote::is_remote_path(Some(trimmed)) {
        return None;
    }
    let canonical = std::fs::canonicalize(trimmed).ok()?;
    Some(canonical.to_string_lossy().into_owned())
}

pub(crate) fn is_enabled(workspace: &str) -> bool {
    if kill_switch() {
        return false;
    }
    let Some(key) = workspace_key(workspace) else {
        return false;
    };
    let guard = store().lock();
    guard.enabled && guard.workspaces.contains(&key)
}

fn global_enabled() -> bool {
    !kill_switch() && store().lock().enabled
}

fn save(guard: &Store) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(guard).map_err(|e| e.to_string())?;
    let path = store_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn set_enabled(workspace: &str, on: bool) -> Result<(), String> {
    let key = workspace_key(workspace).ok_or("workspace is not local or does not exist")?;
    let mut guard = store().lock();
    guard.workspaces.retain(|w| *w != key);
    if on {
        guard.workspaces.push(key);
    }
    save(&guard)
}

// ── Paths ────────────────────────────────────────────────────────────────

fn safe_db_id(db_id: &str) -> bool {
    !db_id.is_empty()
        && db_id.len() <= 64
        && db_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A path that can sit inside quotes in zsh/bash/fish as is.
fn launch_safe(path: &str) -> bool {
    !path.is_empty()
        && !path
            .chars()
            .any(|c| matches!(c, '\'' | '"' | '$' | '`' | '\\' | '\n' | '\r' | '%' | '!'))
}

/// `<workspace>/.promptops/sessions/<dbId>`, absolute and canonical on the workspace.
pub(crate) fn state_dir(workspace: &str, db_id: &str) -> Option<PathBuf> {
    if !safe_db_id(db_id) {
        return None;
    }
    let root = PathBuf::from(workspace_key(workspace)?);
    Some(root.join(".promptops").join("sessions").join(db_id))
}

// ── Instructions for the agent ──────────────────────────────────────────

/// Fixed text: the only variable is the folder path, so the system prompt
/// prefix stays stable in the cache. No quotes.
pub(crate) fn instructions(dir: &Path) -> String {
    let d = dir.to_string_lossy();
    format!(
        "PromptOps session state is on for this session. Keep the state of the work in two files in {d} (create the folder on the first save). \
{d}/state.md is rewritten whole with these sections: Status (IN_PROGRESS, DONE or BLOCKED), Goal, Read first, Where we are, Next action, Constraints, Decisions, Open problem, Failed attempts, Waiting on (who, what, where), Part of. \
{d}/logbook.md is append only: one dated line per entry, typed done, decided, blocked or waiting. \
Update both after each meaningful step, after every decision and before you stop. PromptOps reads them to hand the work over to a fresh agent, so they must stand on their own."
    )
}

// ── Sessions with the state active, in this run ─────────────────────────

struct Active {
    /// The instructions are already in the system prompt of the current process.
    at_launch: bool,
    state: PathBuf,
    logbook: PathBuf,
    /// File with the instructions passed with `--append-system-prompt-file`.
    prompt_file: Option<PathBuf>,
}

fn active() -> &'static Mutex<HashMap<String, Active>> {
    static MAP: OnceLock<Mutex<HashMap<String, Active>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn forget(session_id: &str) {
    active().lock().remove(session_id);
    counters().lock().remove(session_id);
}

/// Does the CLI accept `--append-system-prompt-file`? The help mentions it only
/// as `--append-system-prompt[-file]`: without confirmation no flag (an unknown
/// flag would stop Claude from starting) and the instructions go by message.
/// Probed once per run.
fn supports_prompt_file() -> bool {
    if cfg!(windows) || cfg!(test) {
        return false;
    }
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    *SUPPORTED.get_or_init(|| {
        let ok = crate::commands::session::cli_help_mentions_login_shell("claude", "append-system-prompt[-file]")
            || crate::commands::session::cli_help_mentions_login_shell("claude", "--append-system-prompt-file");
        if !ok {
            eprintln!("[session-state] --append-system-prompt-file not available: instructions sent by message");
        }
        ok
    })
}

/// Instructions file of a session, in the app data folder (not in the repo).
fn prompt_file_path(db_id: &str) -> PathBuf {
    crate::commands::hook::hook_data_dir()
        .join("session-state")
        .join(format!("{db_id}.md"))
}

/// At the spawn of the MAIN session: decides whether the instructions enter the
/// system prompt. Only local claude-code-cli, workspace turned on, known dbId,
/// not on Windows, CLI that accepts `--append-system-prompt-file`.
/// `user_has_prompt_file` = the session already passes its own file (Claude would keep only the last): no flag.
pub(crate) fn prepare_launch(
    session_id: &str,
    provider: &str,
    workspace: Option<&str>,
    db_id: Option<&str>,
    user_has_prompt_file: bool,
) {
    forget(session_id);
    if cfg!(windows) || provider != "claude-code-cli" {
        return;
    }
    let (Some(ws), Some(db)) = (workspace, db_id) else {
        return;
    };
    if !is_enabled(ws) {
        return;
    }
    let Some(dir) = state_dir(ws, db) else { return };
    let mut entry = Active {
        at_launch: false,
        state: dir.join(STATE_FILE),
        logbook: dir.join(LOGBOOK_FILE),
        prompt_file: None,
    };
    if !user_has_prompt_file && supports_prompt_file() {
        let file = prompt_file_path(db);
        let written = file
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|_| {
                let tmp = file.with_extension("md.tmp");
                std::fs::write(&tmp, instructions(&dir)).and_then(|_| std::fs::rename(&tmp, &file))
            });
        match written {
            Ok(()) if launch_safe(&file.to_string_lossy()) => {
                entry.at_launch = true;
                entry.prompt_file = Some(file);
            }
            Ok(()) => {}
            Err(err) => eprintln!(
                "[session-state] instructions not written ({err}): instructions sent by message"
            ),
        }
    }
    // Without the flag the session is not registered: approvals only after the message.
    if entry.at_launch {
        active().lock().insert(session_id.to_string(), entry);
    }
}

/// `--append-system-prompt-file "<file>"` for the launch line, if prepared:
/// the line stays short, the text lives in a file of the app data folder.
pub(crate) fn launch_fragment(session_id: Option<&str>) -> Option<String> {
    if !global_enabled() && !cfg!(test) {
        return None;
    }
    let sid = session_id?;
    let guard = active().lock();
    let entry = guard.get(sid).filter(|a| a.at_launch)?;
    let file = entry.prompt_file.as_ref()?;
    Some(format!(
        "--append-system-prompt-file \"{}\"",
        file.to_string_lossy()
    ))
}

/// Are the instructions in the system prompt of the current process?
pub(crate) fn instructed_at_launch(session_id: &str) -> bool {
    active().lock().get(session_id).is_some_and(|a| a.at_launch)
}

/// Session already open: the instructions arrive with a message. From here on
/// the approvals of the two files apply; `at_launch` stays false.
pub(crate) fn activate_by_message(
    session_id: &str,
    workspace: &str,
    db_id: &str,
) -> Option<String> {
    if !is_enabled(workspace) {
        return None;
    }
    let dir = state_dir(workspace, db_id)?;
    let text = instructions(&dir);
    let mut guard = active().lock();
    let (at_launch, prompt_file) = guard
        .get(session_id)
        .map(|a| (a.at_launch, a.prompt_file.clone()))
        .unwrap_or((false, None));
    guard.insert(
        session_id.to_string(),
        Active {
            at_launch,
            state: dir.join(STATE_FILE),
            logbook: dir.join(LOGBOOK_FILE),
            prompt_file,
        },
    );
    Some(text)
}

/// PreToolUse: Write/Edit/MultiEdit on the EXACT path of one of the two files
/// of the session. Any other path (or shape) goes through the normal flow.
pub(crate) fn approves_tool(session_id: &str, event: &Value) -> bool {
    if !global_enabled() && !cfg!(test) {
        return false;
    }
    let tool = event.get("tool_name").and_then(Value::as_str).unwrap_or("");
    if !matches!(tool, "Write" | "Edit" | "MultiEdit") {
        return false;
    }
    let Some(path) = event
        .get("tool_input")
        .and_then(|i| i.get("file_path"))
        .and_then(Value::as_str)
    else {
        return false;
    };
    if path.contains("..") {
        return false;
    }
    let target = {
        let guard = active().lock();
        let Some(entry) = guard.get(session_id) else {
            return false;
        };
        if Path::new(path) == entry.state {
            entry.state.clone()
        } else if Path::new(path) == entry.logbook {
            entry.logbook.clone()
        } else {
            return false;
        }
    };
    not_redirected(&target)
}

/// No symbolic link along the path: the file (if any) is not a link and the
/// real folder (if any) is exactly the expected one. Otherwise an approved
/// write could land outside the state folder.
fn not_redirected(target: &Path) -> bool {
    if let Ok(meta) = std::fs::symlink_metadata(target) {
        if meta.file_type().is_symlink() || !meta.is_file() {
            return false;
        }
    }
    let Some(dir) = target.parent() else {
        return false;
    };
    match std::fs::canonicalize(dir) {
        Ok(real) => same_real_path(&real, dir),
        // Folder not created yet: the agent creates it on the first save.
        // The first existing ancestor must be the expected one.
        Err(_) => {
            let mut probe = dir;
            loop {
                let Some(parent) = probe.parent() else {
                    return false;
                };
                if let Ok(real) = std::fs::canonicalize(parent) {
                    return same_real_path(&real, parent);
                }
                probe = parent;
            }
        }
    }
}

/// `canonicalize` on Windows answers with the verbatim prefix (`\\?\C:\…`),
/// which never equals the path we built: compare without it, and without
/// case, there. Elsewhere the two paths must be identical.
fn same_real_path(real: &Path, expected: &Path) -> bool {
    #[cfg(windows)]
    {
        let norm = |p: &Path| {
            let s = p.to_string_lossy().replace('/', "\\");
            let s = match s.strip_prefix(r"\\?\UNC\") {
                Some(rest) => format!(r"\\{rest}"),
                None => s.strip_prefix(r"\\?\").unwrap_or(&s).to_string(),
            };
            s.trim_end_matches('\\').to_lowercase()
        };
        norm(real) == norm(expected)
    }
    #[cfg(not(windows))]
    {
        real == expected
    }
}

// ── Measures ─────────────────────────────────────────────────────────────
//
// Age of the state in TURNS (not minutes: those include pauses) at every Stop,
// at every compact_boundary and at every handoff. Only sessions with the state
// active: for the others it is a `get` on an empty map. One JSON line per measure
// in `session-state-metrics.jsonl` (app data folder, 1 MB cap). Local only.

#[derive(Default)]
struct Counters {
    /// Turns closed since the last write of state.md.
    turns_since_update: u32,
    /// Turn in progress with changes to other files.
    changed_this_turn: bool,
    /// Turns with changes closed without updating the state.
    changed_without_update: u32,
    /// Size of the logbook at the last measure (bytes, from `stat`).
    logbook_bytes: u64,
    last_state_mtime: Option<std::time::SystemTime>,
}

fn counters() -> &'static Mutex<HashMap<String, Counters>> {
    static MAP: OnceLock<Mutex<HashMap<String, Counters>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn paths_of(session_id: &str) -> Option<(PathBuf, PathBuf)> {
    active()
        .lock()
        .get(session_id)
        .map(|a| (a.state.clone(), a.logbook.clone()))
}

fn metrics_path() -> PathBuf {
    crate::commands::hook::hook_data_dir().join("session-state-metrics.jsonl")
}

fn record(session_id: &str, event: &str, c: &Counters) {
    use std::io::Write as _;
    if cfg!(test) {
        return;
    }
    let path = metrics_path();
    if std::fs::metadata(&path)
        .map(|m| m.len() > 1024 * 1024)
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(&path);
    }
    let line = serde_json::json!({
        "ts": chrono_now(),
        "session": session_id,
        "event": event,
        "ageTurns": c.turns_since_update,
        "changedWithoutUpdate": c.changed_without_update,
        "logbookBytes": c.logbook_bytes,
    });
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{line}");
    }
}

fn chrono_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Stop and PostToolUse of the main session (from the hook dispatch).
pub(crate) fn on_hook(session_id: &str, event_name: &str, event: &Value) {
    if !matches!(event_name, "PostToolUse" | "Stop") {
        return;
    }
    let Some((state, logbook)) = paths_of(session_id) else {
        return;
    };
    if event_name == "PostToolUse" {
        let tool = event.get("tool_name").and_then(Value::as_str).unwrap_or("");
        if !matches!(tool, "Write" | "Edit" | "MultiEdit" | "NotebookEdit") {
            return;
        }
        let path = event
            .get("tool_input")
            .and_then(|i| i.get("file_path"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if Path::new(path) != state && Path::new(path) != logbook {
            counters()
                .lock()
                .entry(session_id.to_string())
                .or_default()
                .changed_this_turn = true;
        }
        return;
    }
    // Stop: two `stat` calls, no content read.
    let mtime = std::fs::metadata(&state).and_then(|m| m.modified()).ok();
    let logbook_bytes = std::fs::metadata(&logbook).map(|m| m.len()).unwrap_or(0);
    let mut map = counters().lock();
    let c = map.entry(session_id.to_string()).or_default();
    let updated = mtime.is_some() && mtime != c.last_state_mtime;
    if updated {
        c.turns_since_update = 0;
        c.last_state_mtime = mtime;
    } else {
        c.turns_since_update = c.turns_since_update.saturating_add(1);
        if c.changed_this_turn {
            c.changed_without_update = c.changed_without_update.saturating_add(1);
        }
    }
    c.changed_this_turn = false;
    c.logbook_bytes = logbook_bytes;
    record(session_id, "stop", c);
}

/// compact_boundary of the main session (from the Claude transcript).
pub(crate) fn on_compact(session_id: &str) {
    if paths_of(session_id).is_none() {
        return;
    }
    let mut map = counters().lock();
    let c = map.entry(session_id.to_string()).or_default();
    record(session_id, "compact", c);
}

/// At the handoff: records the measure and returns the age in turns, if known.
pub(crate) fn on_handoff(session_id: &str) -> Option<u32> {
    paths_of(session_id)?;
    let mut map = counters().lock();
    let c = map.entry(session_id.to_string()).or_default();
    record(session_id, "handoff", c);
    c.last_state_mtime.map(|_| c.turns_since_update)
}

// ── Read for the handoff ────────────────────────────────────────────────

/// Whole state plus the tail of the logbook, within ~8 KB. `None` if there is
/// nothing: in that case the handoff stays identical to before.
pub(crate) fn read_for_handoff(workspace: &str, db_id: &str) -> Option<String> {
    if !global_enabled() && !cfg!(test) {
        return None;
    }
    let dir = state_dir(workspace, db_id)?;
    let state = read_capped(&dir.join(STATE_FILE), HANDOFF_MAX_BYTES);
    let budget = HANDOFF_MAX_BYTES.saturating_sub(state.as_deref().map_or(0, str::len));
    let logbook = (budget > 256)
        .then(|| read_tail(&dir.join(LOGBOOK_FILE), budget))
        .flatten();
    if state.is_none() && logbook.is_none() {
        return None;
    }
    let mut out = String::new();
    if let Some(s) = state.filter(|s| !s.trim().is_empty()) {
        out.push_str("### state.md\n");
        out.push_str(s.trim_end());
        out.push('\n');
    }
    if let Some(l) = logbook.filter(|l| !l.trim().is_empty()) {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str("### logbook.md (latest entries)\n");
        out.push_str(l.trim_end());
        out.push('\n');
    }
    (!out.is_empty()).then_some(out)
}

fn read_capped(path: &Path, max: usize) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let slice = &bytes[..bytes.len().min(max)];
    Some(String::from_utf8_lossy(slice).into_owned())
}

fn read_tail(path: &Path, max: usize) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let start = bytes.len().saturating_sub(max);
    let text = String::from_utf8_lossy(&bytes[start..]).into_owned();
    // It starts mid-file: the first line is dropped, probably cut.
    Some(if start > 0 {
        text.split_once('\n')
            .map(|(_, r)| r.to_string())
            .unwrap_or_default()
    } else {
        text
    })
}

// ── Git exclusion ───────────────────────────────────────────────────────

fn git(workspace: &str, args: &[&str]) -> Option<std::process::Output> {
    crate::commands::util_cmd::cmd("git")
        .args(args)
        .current_dir(workspace)
        .output()
        .ok()
}

/// "not_git" | "ignored" | "not_ignored"
fn git_exclusion_status(workspace: &str) -> &'static str {
    match git(workspace, &["rev-parse", "--is-inside-work-tree"]) {
        Some(o) if o.status.success() => {}
        _ => return "not_git",
    }
    // `check-ignore` on a path inside the folder: 0 = ignored.
    match git(
        workspace,
        &["check-ignore", "-q", ".promptops/sessions/x/state.md"],
    ) {
        Some(o) if o.status.success() => "ignored",
        _ => "not_ignored",
    }
}

fn append_line(path: &Path, line: &str) -> Result<(), String> {
    use std::io::Write as _;
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == line) {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    let sep = if existing.is_empty() || existing.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    write!(f, "{sep}# PromptOps session state\n{line}\n").map_err(|e| e.to_string())
}

fn apply_exclusion(workspace: &str, mode: &str) -> Result<(), String> {
    match mode {
        "gitignore" => append_line(&Path::new(workspace).join(".gitignore"), IGNORE_ENTRY),
        _ => {
            let out =
                git(workspace, &["rev-parse", "--git-common-dir"]).ok_or("git is not available")?;
            if !out.status.success() {
                return Err("not a git repository".into());
            }
            let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let common = if Path::new(&raw).is_absolute() {
                PathBuf::from(raw)
            } else {
                Path::new(workspace).join(raw)
            };
            append_line(&common.join("info").join("exclude"), IGNORE_ENTRY)
        }
    }
}

// ── Commands ────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStateInfo {
    /// Main switch in Settings.
    pub global: bool,
    pub available: bool,
    pub enabled: bool,
    /// "not_git" | "ignored" | "not_ignored"
    pub git: String,
}

/// session_state:get — status of the feature for a workspace.
#[tauri::command]
pub async fn session_state_get(workspace_path: String) -> Result<SessionStateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let available = !kill_switch() && workspace_key(&workspace_path).is_some();
        SessionStateInfo {
            global: global_enabled(),
            available,
            enabled: available && is_enabled(&workspace_path),
            git: if available {
                git_exclusion_status(&workspace_path).to_string()
            } else {
                "not_git".into()
            },
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// session_state:set — turns it on or off for a workspace. When turning on, if
/// the folder is not excluded from git, it excludes it as chosen (`info_exclude`,
/// default, or `gitignore`). Turning off does not delete the state files.
#[tauri::command]
pub async fn session_state_set(
    workspace_path: String,
    enabled: bool,
    exclusion: Option<String>,
) -> Result<crate::commands::session::OkResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use crate::commands::session::OkResult;
        if kill_switch() {
            return OkResult::err("Session state is disabled on this device");
        }
        if enabled && !global_enabled() {
            return OkResult::err("Turn on Context management in Settings first");
        }
        if enabled && git_exclusion_status(&workspace_path) == "not_ignored" {
            if let Err(err) = apply_exclusion(
                &workspace_path,
                exclusion.as_deref().unwrap_or("info_exclude"),
            ) {
                return OkResult::err(format!(
                    "Could not exclude the state folder from git: {err}"
                ));
            }
        }
        match set_enabled(&workspace_path, enabled) {
            Ok(()) => OkResult::ok(),
            Err(err) => OkResult::err(err),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// session_state:global-get — main switch (Settings).
#[tauri::command]
pub fn session_state_global_get() -> bool {
    global_enabled()
}

/// session_state:global-set — turns the feature on or off for the whole device.
/// Turning off touches neither the chosen workspaces nor the state files:
/// PromptOps simply stops using them from the next launch.
#[tauri::command]
pub fn session_state_global_set(enabled: bool) -> crate::commands::session::OkResult {
    use crate::commands::session::OkResult;
    if kill_switch() {
        return OkResult::err("Session state is disabled on this device");
    }
    let mut guard = store().lock();
    guard.enabled = enabled;
    match save(&guard) {
        Ok(()) => OkResult::ok(),
        Err(err) => OkResult::err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("po-state-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::canonicalize(d).unwrap()
    }

    #[test]
    fn state_dir_requires_safe_db_id_and_local_workspace() {
        let ws = tmp("dir");
        let w = ws.to_string_lossy();
        assert_eq!(
            state_dir(&w, "42").unwrap(),
            ws.join(".promptops/sessions/42")
        );
        assert!(state_dir(&w, "../x").is_none());
        assert!(state_dir(&w, "").is_none());
        assert!(state_dir("ssh://host/repo", "42").is_none());
        assert!(state_dir("/does/not/exist/po", "42").is_none());
    }

    #[test]
    fn instructions_are_stable_and_launch_safe() {
        let dir = Path::new("/Users/a b/repo/.promptops/sessions/42");
        let a = instructions(dir);
        assert_eq!(a, instructions(dir));
        assert!(!a.contains('\'') && !a.contains('"') && !a.contains('$') && !a.contains('`'));
        assert!(a.contains("/Users/a b/repo/.promptops/sessions/42/state.md"));
    }

    #[test]
    fn nothing_happens_for_sessions_never_prepared() {
        let ev = serde_json::json!({ "tool_name": "Write", "tool_input": { "file_path": "/x/state.md" } });
        assert!(!approves_tool("never", &ev));
        assert!(launch_fragment(Some("never")).is_none());
        assert!(launch_fragment(None).is_none());
        assert!(!instructed_at_launch("never"));
    }

    #[test]
    fn approves_only_exact_paths_and_write_tools() {
        // A real, canonical base: on Windows the root of "/w" is not "/".
        let base = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let base = PathBuf::from(
            base.to_string_lossy()
                .trim_start_matches(r"\\?\")
                .to_string(),
        );
        let dir = base
            .join("po-approve-missing")
            .join(".promptops")
            .join("sessions")
            .join("7");
        let at = |rel: &str| format!("{}/{rel}", dir.display());
        active().lock().insert(
            "s-approve".into(),
            Active {
                at_launch: true,
                state: dir.join(STATE_FILE),
                logbook: dir.join(LOGBOOK_FILE),
                prompt_file: Some(PathBuf::from("/data/session-state/7.md")),
            },
        );
        let ev = |tool: &str, p: &str| serde_json::json!({ "tool_name": tool, "tool_input": { "file_path": p } });
        assert!(approves_tool("s-approve", &ev("Write", &at("state.md"))));
        assert!(approves_tool("s-approve", &ev("Edit", &at("logbook.md"))));
        assert!(!approves_tool("s-approve", &ev("Bash", &at("state.md"))));
        assert!(!approves_tool("s-approve", &ev("Write", &at("other.md"))));
        assert!(!approves_tool(
            "s-approve",
            &ev("Write", &at("../7/state.md"))
        ));
        assert!(!approves_tool("s-approve", &ev("Write", "state.md")));
        assert!(!approves_tool(
            "other-session",
            &ev("Write", &at("state.md"))
        ));
        let frag = launch_fragment(Some("s-approve")).unwrap();
        assert_eq!(
            frag,
            "--append-system-prompt-file \"/data/session-state/7.md\""
        );
        forget("s-approve");
        assert!(!approves_tool("s-approve", &ev("Write", &at("state.md"))));
    }

    #[cfg(unix)]
    #[test]
    fn never_approves_through_a_symlink() {
        let ws = tmp("symlink");
        let w = ws.to_string_lossy().into_owned();
        let dir = state_dir(&w, "5").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let elsewhere = ws.join("secret.txt");
        std::fs::write(&elsewhere, "x").unwrap();
        active().lock().insert(
            "s-link".into(),
            Active {
                at_launch: false,
                state: dir.join(STATE_FILE),
                logbook: dir.join(LOGBOOK_FILE),
                prompt_file: None,
            },
        );
        let ev = |p: &Path| serde_json::json!({ "tool_name": "Write", "tool_input": { "file_path": p.to_string_lossy() } });
        // Regular file (or missing): approved.
        assert!(approves_tool("s-link", &ev(&dir.join(STATE_FILE))));
        std::fs::write(dir.join(STATE_FILE), "ok").unwrap();
        assert!(approves_tool("s-link", &ev(&dir.join(STATE_FILE))));
        // logbook.md as a link to another file: never.
        std::os::unix::fs::symlink(&elsewhere, dir.join(LOGBOOK_FILE)).unwrap();
        assert!(!approves_tool("s-link", &ev(&dir.join(LOGBOOK_FILE))));
        // Session folder as a link: never.
        std::fs::remove_dir_all(&dir).unwrap();
        let other = ws.join("other");
        std::fs::create_dir_all(&other).unwrap();
        std::os::unix::fs::symlink(&other, &dir).unwrap();
        assert!(!approves_tool("s-link", &ev(&dir.join(STATE_FILE))));
        forget("s-link");
    }

    #[test]
    fn handoff_reads_state_and_logbook_tail_within_cap() {
        let ws = tmp("handoff");
        let w = ws.to_string_lossy().into_owned();
        assert!(read_for_handoff(&w, "9").is_none());
        let dir = state_dir(&w, "9").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(STATE_FILE),
            "Status: IN_PROGRESS\nNext action: test\n",
        )
        .unwrap();
        let mut log = String::new();
        for i in 0..2000 {
            log.push_str(&format!("2026-11-12 done entry {i}\n"));
        }
        std::fs::write(dir.join(LOGBOOK_FILE), &log).unwrap();
        let out = read_for_handoff(&w, "9").unwrap();
        assert!(out.len() <= HANDOFF_MAX_BYTES + 128, "{}", out.len());
        assert!(out.starts_with("### state.md\nStatus: IN_PROGRESS"));
        assert!(out.contains("done entry 1999"));
        assert!(!out.contains("done entry 0\n"));
    }

    #[test]
    fn counts_turns_since_the_last_state_update() {
        let ws = tmp("counters");
        let w = ws.to_string_lossy().into_owned();
        let dir = state_dir(&w, "11").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        active().lock().insert(
            "s-count".into(),
            Active {
                at_launch: true,
                state: dir.join(STATE_FILE),
                logbook: dir.join(LOGBOOK_FILE),
                prompt_file: Some(PathBuf::from("/data/session-state/7.md")),
            },
        );
        let stop = serde_json::json!({});
        let edit = |p: &Path| serde_json::json!({ "tool_name": "Edit", "tool_input": { "file_path": p.to_string_lossy() } });
        // Without a state file: unknown age at the handoff.
        on_hook("s-count", "Stop", &stop);
        assert_eq!(on_handoff("s-count"), None);
        // State written: at the next Stop the age goes back to zero.
        std::fs::write(dir.join(STATE_FILE), "Status: IN_PROGRESS").unwrap();
        on_hook("s-count", "Stop", &stop);
        assert_eq!(on_handoff("s-count"), Some(0));
        // Two turns with code changes and the state unchanged.
        on_hook("s-count", "PostToolUse", &edit(&ws.join("src.rs")));
        on_hook("s-count", "Stop", &stop);
        on_hook("s-count", "PostToolUse", &edit(&ws.join("src.rs")));
        on_hook("s-count", "Stop", &stop);
        assert_eq!(on_handoff("s-count"), Some(2));
        assert_eq!(
            counters()
                .lock()
                .get("s-count")
                .unwrap()
                .changed_without_update,
            2
        );
        // Writes to the state files do not count as changes.
        on_hook("s-count", "PostToolUse", &edit(&dir.join(LOGBOOK_FILE)));
        assert!(!counters().lock().get("s-count").unwrap().changed_this_turn);
        forget("s-count");
        // Inactive session: no effect.
        on_hook("s-count", "Stop", &stop);
        assert!(counters().lock().get("s-count").is_none());
    }

    #[test]
    fn exclusion_lines_are_idempotent() {
        let ws = tmp("exclude");
        let f = ws.join("info").join("exclude");
        append_line(&f, IGNORE_ENTRY).unwrap();
        append_line(&f, IGNORE_ENTRY).unwrap();
        let text = std::fs::read_to_string(&f).unwrap();
        assert_eq!(text.matches(IGNORE_ENTRY).count(), 1);
    }
}
