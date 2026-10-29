//! Local data: the records the app keeps on this device.
//!
//! Sessions, workspaces, session profiles, sidebar folders and device
//! workspaces live here; the personal Prompt Library, shortcuts, action slots,
//! notes and your local profile live in `local_data_more.rs`. Everything is
//! stored in the encrypted local store (`local_store.rs`). Nothing in these
//! files opens a network connection.
//!
//! There is one entry point, [`call`]: a method name such as `sessions.list`
//! and a JSON object of parameters. The web UI reaches it through the
//! `local_call` Tauri command; the desktop shell calls it directly (sessions in
//! `commands/session.rs`, device workspaces in `commands/workspace.rs`).
//!
//! Some data is never stored, whatever the caller sends: environment variables
//! (they often hold API keys) and the text of prompts sent to agents (session
//! config, sub-agent lists of a session and of the UI snapshot).
//!
//! Each call is one unit: its changes reach the disk in a single atomic write
//! when it returns (see `LocalStore::batch`), so a crash in the middle of a
//! reorder or a persist of every session never leaves half of it on disk.

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::local_store::{self, LocalStore};

/// The only user of a local install.
pub(crate) const LOCAL_USER_ID: i64 = 1;

pub(crate) const SESSIONS: &str = "sessions";
const WORKSPACES: &str = "workspaces";
const PROFILES: &str = "session_profiles";
const FOLDERS: &str = "sidebar_folders";
const DEVICE_WORKSPACES: &str = "device_workspaces";
const SNAPSHOTS: &str = "state_snapshots";

/// Days an archived sub-agent stays resumable.
const ARCHIVE_TTL_DAYS: i64 = 30;
const ARCHIVE_MAX: usize = 20;
const SESSION_STATUSES: &[&str] = &[
    "idle",
    "running",
    "in_progress",
    "waiting_input",
    "completed",
    "error",
];

/// One call at a time: handlers read, change and write whole records, and both
/// the UI and the shell can call in parallel.
static OP_LOCK: Mutex<()> = Mutex::new(());

/// Why a call failed. `code` is stable and meant for code (`invalid`,
/// `not_found`, `conflict`, `session_name_taken`, `unknown_method`,
/// `unavailable`, `storage`); `message` is a short sentence for people.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LocalError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl LocalError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            details: None,
        }
    }

    pub(crate) fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

impl std::fmt::Display for LocalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

pub type LocalResult = Result<Value, LocalError>;

pub(crate) fn invalid(message: impl Into<String>) -> LocalError {
    LocalError::new("invalid", message)
}

pub(crate) fn not_found(what: &str) -> LocalError {
    LocalError::new("not_found", format!("{what} not found."))
}

/// Runs one method against the local store.
pub fn call(method: &str, params: Value) -> LocalResult {
    match local_store::get() {
        Some(store) => call_with(store, method, &params),
        None => Err(LocalError::new(
            "unavailable",
            "The local store is not available.",
        )),
    }
}

/// Tauri command used by the web UI. Runs off the async runtime because it
/// reads and writes the local store.
#[tauri::command]
pub async fn local_call(method: String, params: Option<Value>) -> Result<Value, LocalError> {
    tauri::async_runtime::spawn_blocking(move || call(&method, params.unwrap_or(Value::Null)))
        .await
        .map_err(|e| LocalError::new("internal", e.to_string()))?
}

pub(crate) fn call_with(store: &LocalStore, method: &str, params: &Value) -> LocalResult {
    let _guard = OP_LOCK.lock();
    let ctx = Ctx { store, params };
    let (result, saved) = store.batch(|| dispatch(&ctx, method));
    match (result, saved) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(e)) => Err(storage_error(e)),
        (Err(e), _) => Err(e),
    }
}

fn dispatch(ctx: &Ctx, method: &str) -> LocalResult {
    let ctx = Ctx {
        store: ctx.store,
        params: ctx.params,
    };
    match method {
        // How the store was opened: quarantined file, read-only reason.
        "store.health" => serde_json::to_value(ctx.store.health())
            .map_err(|e| LocalError::new("internal", e.to_string())),
        "sessions.list" => session_list(&ctx),
        "sessions.get" => session_get(&ctx),
        "sessions.create" => session_create(&ctx),
        "sessions.update" => session_update(&ctx),
        "sessions.updateByName" => session_update_by_name(&ctx),
        "sessions.delete" => session_delete(&ctx),
        "sessions.deleteByName" => session_delete_by_name(&ctx),
        "sessions.reorder" => session_reorder(&ctx),
        "sessions.persist" => session_persist(&ctx),
        "sessions.setSubAgentsOrder" => session_sub_agents_order(&ctx),
        "sessions.promote" => session_promote(&ctx),
        "sessions.saveSnapshot" => snapshot_save(&ctx),
        "sessions.getSnapshot" => Ok(ctx
            .store
            .get(SNAPSHOTS, &snapshot_id(&ctx))
            .unwrap_or(Value::Null)),
        "sessions.archive" => archive_list(&ctx),
        "sessions.removeArchived" => archive_delete(&ctx),

        "workspaces.list" => workspace_list(&ctx),
        "workspaces.get" => workspace_get(&ctx),
        "workspaces.create" => workspace_create(&ctx),
        "workspaces.findOrCreate" => workspace_find_or_create(&ctx),
        "workspaces.update" => workspace_update(&ctx),
        "workspaces.delete" => workspace_delete(&ctx),

        "profiles.list" => profile_list(&ctx),
        "profiles.create" => profile_create(&ctx),
        "profiles.update" => profile_update(&ctx),
        "profiles.delete" => profile_delete(&ctx),

        "folders.list" => folder_list(&ctx),
        "folders.create" => folder_create(&ctx),
        "folders.update" => folder_update(&ctx),
        "folders.delete" => folder_delete(&ctx),
        "folders.reorder" => folder_reorder(&ctx),
        "folders.assign" => folder_assign(&ctx),

        // Not in the renderer's DataBackend contract on purpose: the renderer
        // reaches these through the device_workspace_* commands (workspace.rs
        // `dw_call`), which add this device's id.
        "deviceWorkspaces.forDevice" => device_workspace_list(&ctx),
        "deviceWorkspaces.get" => device_workspace_get(&ctx),
        "deviceWorkspaces.upsert" => device_workspace_upsert(&ctx),
        "deviceWorkspaces.update" => device_workspace_update(&ctx),
        "deviceWorkspaces.delete" => device_workspace_delete(&ctx),
        "deviceWorkspaces.migrateLegacy" => device_workspace_migrate(&ctx),

        _ => crate::local_data_more::dispatch(&ctx, method).unwrap_or_else(|| {
            Err(LocalError::new(
                "unknown_method",
                format!("Unknown method: {method}"),
            ))
        }),
    }
}

pub(crate) struct Ctx<'a> {
    pub store: &'a LocalStore,
    pub params: &'a Value,
}

impl Ctx<'_> {
    /// A non-empty text parameter. Numbers are accepted and turned into text,
    /// so ids and page numbers can be sent either way.
    pub(crate) fn text(&self, key: &str) -> Option<String> {
        match self.params.get(key)? {
            Value::String(s) if !s.is_empty() => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        }
    }

    /// A required text parameter.
    pub(crate) fn required(&self, key: &str) -> Result<String, LocalError> {
        self.text(key)
            .ok_or_else(|| invalid(format!("{key} is required.")))
    }

    pub(crate) fn flag(&self, key: &str) -> bool {
        match self.params.get(key) {
            Some(Value::Bool(b)) => *b,
            Some(Value::String(s)) => s == "true",
            _ => false,
        }
    }

    /// Active session profile: `None` is the Standard profile. An unknown id
    /// falls back to Standard.
    pub(crate) fn profile(&self) -> Option<String> {
        let raw = self.text("profile_id")?;
        let raw = raw.trim();
        if raw.is_empty() || raw.eq_ignore_ascii_case("standard") {
            return None;
        }
        live(self.store.get(PROFILES, raw)).map(|_| raw.to_string())
    }
}

// ───────────────────────────── helpers ─────────────────────────────

pub(crate) fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.6fZ")
        .to_string()
}

/// The record if it exists and is not soft-deleted.
pub(crate) fn live(v: Option<Value>) -> Option<Value> {
    v.filter(is_live)
}

pub(crate) fn is_live(r: &Value) -> bool {
    r.get("deleted_at").is_none_or(Value::is_null)
}

pub(crate) fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

pub(crate) fn has(v: &Value, key: &str) -> bool {
    v.as_object().is_some_and(|o| o.contains_key(key))
}

pub(crate) fn storage_error(e: String) -> LocalError {
    LocalError::new("storage", format!("Could not save: {e}"))
}

pub(crate) fn put(store: &LocalStore, collection: &str, record: &Value) -> Result<(), LocalError> {
    let id = s(record, "id").unwrap_or_default();
    store
        .put(collection, &id, record.clone())
        .map_err(storage_error)
}

/// A required, non-blank text field of at most `max` characters.
pub(crate) fn validate_required(
    params: &Value,
    key: &str,
    max: usize,
) -> Result<String, LocalError> {
    match params.get(key).and_then(Value::as_str) {
        Some(v) if !v.trim().is_empty() && v.chars().count() <= max => Ok(v.to_string()),
        Some(v) if !v.trim().is_empty() => Err(invalid(format!(
            "{key} is too long (at most {max} characters)."
        ))),
        _ => Err(invalid(format!("{key} is required."))),
    }
}

/// Comparison key for session names: case-insensitive, accent-insensitive,
/// trailing spaces ignored.
pub(crate) fn name_key(name: &str) -> String {
    name.trim_end_matches(' ')
        .chars()
        .flat_map(char::to_lowercase)
        .map(strip_accent)
        .collect()
}

/// Base letter of an accented Latin letter (common Western and Central
/// European ones), written as code points to keep the source ASCII.
fn strip_accent(c: char) -> char {
    const MAP: &[(char, &[u32])] = &[
        (
            'a',
            &[0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0x101, 0x103, 0x105],
        ),
        ('c', &[0xE7, 0x107, 0x10D]),
        ('d', &[0x10F]),
        ('e', &[0xE8, 0xE9, 0xEA, 0xEB, 0x113, 0x117, 0x119, 0x11B]),
        ('i', &[0xEC, 0xED, 0xEE, 0xEF, 0x12B, 0x12F]),
        ('n', &[0xF1, 0x144, 0x148]),
        ('o', &[0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0x14D, 0x151]),
        ('r', &[0x159]),
        ('s', &[0x15B, 0x161, 0x15F]),
        ('t', &[0x165]),
        ('u', &[0xF9, 0xFA, 0xFB, 0xFC, 0x16B, 0x16F, 0x171]),
        ('y', &[0xFD, 0xFF]),
        ('z', &[0x17A, 0x17C, 0x17E]),
    ];
    let code = c as u32;
    MAP.iter()
        .find(|(_, codes)| codes.contains(&code))
        .map(|(base, _)| *base)
        .unwrap_or(c)
}

// ───────────────────────────── sessions ─────────────────────────────
//
// A session is a named agent workspace on your machine: its name, the
// provider CLI it runs (Claude Code, Codex, …), its folder, its layout and the
// list of its sub-agents. Deleting a session keeps the record (soft delete),
// so creating one with the same name brings it back.

pub(crate) fn all_sessions(ctx: &Ctx) -> Vec<Value> {
    ctx.store.list(SESSIONS)
}

/// Removes data that must never be stored: environment variables (they often
/// hold API keys) and prompt text.
fn sanitize_config(config: &mut Value) {
    if let Some(obj) = config.as_object_mut() {
        obj.remove("env");
        obj.remove("extensionSelection");
        if let Some(opts) = obj
            .get_mut("providerOptions")
            .and_then(Value::as_object_mut)
        {
            for key in ["autoPrompt", "userPrompt", "prompt"] {
                opts.remove(key);
            }
        }
    }
}

/// Session with the related records the UI reads. There are no teams or
/// projects in this edition, so those are always null; the category is the
/// local prompt category the session saves its prompts under.
fn session_view(ctx: &Ctx, session: &Value, device_id: Option<&str>) -> Value {
    let mut out = session.clone();
    let workspace = s(session, "workspace_id")
        .and_then(|id| live(ctx.store.get(WORKSPACES, &id)))
        .map(|w| json!({ "id": w["id"], "name": w["name"], "project_path": w["project_path"] }));
    out["workspace"] = workspace.unwrap_or(Value::Null);
    for key in ["team", "project", "token_stats"] {
        out[key] = Value::Null;
    }
    out["category"] = crate::local_data_more::live_category(ctx, &session["category_id"])
        .map(|c| json!({ "id": c["id"], "name": c["name"], "color": c["color"] }))
        .unwrap_or(Value::Null);
    if let Some(device_id) = device_id {
        let sid = s(session, "id").unwrap_or_default();
        out["device_workspace"] = ctx
            .store
            .list(DEVICE_WORKSPACES)
            .into_iter()
            .find(|d| s(d, "session_id").as_deref() == Some(sid.as_str()) && s(d, "device_id").as_deref() == Some(device_id))
            .map(|d| json!({ "id": d["id"], "local_path": d["local_path"], "updated_at": d["updated_at"] }))
            .unwrap_or(Value::Null);
    }
    out
}

/// `sessions.list` — sessions of the active profile, in tab order.
/// Optional filters: `workspace_id`, or `standalone: true` (no workspace).
fn session_list(ctx: &Ctx) -> LocalResult {
    let workspace = ctx.text("workspace_id");
    let standalone = ctx.flag("standalone");
    if workspace.is_some() && standalone {
        return Err(invalid("Use either workspace_id or standalone, not both."));
    }
    let profile = ctx.profile();
    let mut list: Vec<Value> = all_sessions(ctx)
        .into_iter()
        .filter(is_live)
        .filter(|r| s(r, "session_profile_id") == profile)
        .filter(|r| {
            workspace
                .as_ref()
                .is_none_or(|w| s(r, "workspace_id").as_deref() == Some(w.as_str()))
        })
        .filter(|r| !standalone || r["workspace_id"].is_null())
        .collect();
    list.sort_by(|a, b| {
        let oa = a["sort_order"].as_i64().unwrap_or(0);
        let ob = b["sort_order"].as_i64().unwrap_or(0);
        oa.cmp(&ob)
            .then_with(|| s(b, "updated_at").cmp(&s(a, "updated_at")))
    });
    let device = ctx.text("device_id");
    Ok(Value::Array(
        list.iter()
            .map(|r| session_view(ctx, r, device.as_deref()))
            .collect(),
    ))
}

/// `sessions.get` — `{ id }`.
fn session_get(ctx: &Ctx) -> LocalResult {
    let id = ctx.required("id")?;
    live(ctx.store.get(SESSIONS, &id)).ok_or_else(|| not_found("Session"))
}

fn new_session(name: &str) -> Value {
    let now = now_iso();
    json!({
        "id": local_store::new_id(),
        "user_id": LOCAL_USER_ID,
        "workspace_id": null,
        "session_profile_id": null,
        "sidebar_folder_id": null,
        "name": name,
        "provider": "",
        "status": "idle",
        "terminal_prompt_count": 0,
        "workspace_path": null,
        "workspace_name": null,
        "sort_order": 0,
        "config": null,
        "repo_url": null,
        "repo_branch": null,
        "claude_session_id": null,
        "sub_agents": null,
        "sub_agents_order": null,
        "view_state": null,
        "standby_at": null,
        "team_id": null,
        "project_id": null,
        "category_id": null,
        "created_at": now,
        "updated_at": now,
        "deleted_at": null,
    })
}

/// The `category_id` to store: the id of an existing prompt category, else null.
fn session_category_id(ctx: &Ctx, requested: Option<&Value>) -> Value {
    requested
        .and_then(|v| crate::local_data_more::live_category(ctx, v))
        .map(|c| c["id"].clone())
        .unwrap_or(Value::Null)
}

fn find_by_name(ctx: &Ctx, name: &str, include_trashed: bool) -> Option<Value> {
    let key = name_key(name);
    let mut matches: Vec<Value> = all_sessions(ctx)
        .into_iter()
        .filter(|r| s(r, "name").map(|n| name_key(&n) == key).unwrap_or(false))
        .filter(|r| include_trashed || is_live(r))
        .collect();
    // Live rows first.
    matches.sort_by_key(|r| !is_live(r));
    matches.into_iter().next()
}

/// How long after its creation a stored session that has nothing to lose yet
/// (no conversation id, no sub-agents) may be written again by another
/// `sessions.create` with its name. Every new terminal session is saved twice
/// (by the native session manager and by the renderer, in either order):
/// the second call must land on the same record, not fail.
const CREATE_GRACE_SECS: i64 = 120;

/// Whether `sessions.create` may write over `existing`, the record that
/// already has the requested name. A deleted one comes back; a live one is
/// replaced only when the caller asks (`replace: true`), when the same live
/// terminal session saves itself again (`local_session_id`), or when it is
/// the fresh, empty record of that same creation. Anything else is another
/// session: overwriting it destroyed its resume id and sub-agents.
fn create_may_overwrite(existing: &Value, params: &Value, profile: Option<&str>) -> bool {
    if !is_live(existing) || params.get("replace").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    if let (Some(mine), Some(theirs)) = (
        s(params, "local_session_id"),
        s(existing, "local_session_id"),
    ) {
        return mine == theirs;
    }
    if s(existing, "session_profile_id").as_deref() != profile {
        return false;
    }
    let empty_agents = existing["sub_agents"]
        .as_array()
        .is_none_or(|a| a.is_empty());
    let no_conversation = s(existing, "claude_session_id").is_none_or(|c| c.is_empty());
    let fresh = s(existing, "created_at")
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(&t).ok())
        .is_some_and(|t| {
            let age = chrono::Utc::now().signed_duration_since(t);
            age >= chrono::Duration::seconds(-5)
                && age <= chrono::Duration::seconds(CREATE_GRACE_SECS)
        });
    empty_agents && no_conversation && fresh
}

/// `sessions.create` — creates a session. A deleted session with the same
/// name comes back; a live one is never overwritten unless the caller says
/// so (`replace: true`) or it is this same creation saved twice (see
/// [`create_may_overwrite`]): otherwise `session_name_taken`.
fn session_create(ctx: &Ctx) -> LocalResult {
    let params = ctx.params;
    let name = validate_required(params, "name", 255)?;
    validate_required(params, "provider", 100)?;
    let workspace = s(params, "workspace_id").and_then(|id| live(ctx.store.get(WORKSPACES, &id)));
    let profile = match &workspace {
        Some(w) => s(w, "session_profile_id"),
        None => ctx.profile(),
    };
    let mut session = match find_by_name(ctx, &name, true) {
        Some(existing) if create_may_overwrite(&existing, params, profile.as_deref()) => existing,
        Some(existing) => {
            return Err(LocalError::new(
                "session_name_taken",
                "A session with this name already exists.",
            )
            .with_details(
                json!({ "conflict_id": existing["id"], "conflict_name": existing["name"] }),
            ))
        }
        None => new_session(&name),
    };
    if let Some(local) = s(params, "local_session_id").filter(|l| !l.is_empty() && l.len() <= 128) {
        session["local_session_id"] = json!(local);
    }
    for key in [
        "workspace_name",
        "provider",
        "workspace_path",
        "config",
        "claude_session_id",
        "sub_agents",
        "repo_url",
        "repo_branch",
    ] {
        session[key] = params.get(key).cloned().unwrap_or(Value::Null);
    }
    session["workspace_id"] = workspace
        .as_ref()
        .map(|w| w["id"].clone())
        .unwrap_or(Value::Null);
    for key in ["team_id", "project_id"] {
        session[key] = Value::Null;
    }
    session["category_id"] = session_category_id(ctx, params.get("category_id"));
    session["session_profile_id"] = profile.map(Value::from).unwrap_or(Value::Null);
    session["deleted_at"] = Value::Null;
    sanitize_config(&mut session["config"]);
    if let Some(list) = session["sub_agents"].as_array() {
        session["sub_agents"] = Value::Array(sub_agents_without_prompts(list));
    }
    session["updated_at"] = json!(now_iso());
    put(ctx.store, SESSIONS, &session)?;
    Ok(session)
}

/// `sessions.update` — `{ id, ...fields }`. The id may also be a session name;
/// `lookup_name` is tried when the id is unknown.
fn session_update(ctx: &Ctx) -> LocalResult {
    let id = ctx.required("id")?;
    let target = ctx
        .store
        .get(SESSIONS, &id)
        .or_else(|| {
            ctx.text("lookup_name")
                .and_then(|n| find_by_name(ctx, &n, false))
        })
        .or_else(|| find_by_name(ctx, &id, false));
    match target {
        Some(session) => apply_session_update(ctx, session),
        None => Err(not_found("Session")),
    }
}

/// `sessions.updateByName` — `{ lookup_name, ...fields }`.
fn session_update_by_name(ctx: &Ctx) -> LocalResult {
    let name = ctx.required("lookup_name")?;
    match find_by_name(ctx, &name, true) {
        Some(session) => apply_session_update(ctx, session),
        None => Err(not_found("Session")),
    }
}

fn apply_session_update(ctx: &Ctx, mut session: Value) -> LocalResult {
    let params = ctx.params;
    let increment = params
        .get("terminal_prompt_count_increment")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if increment > 0 {
        let count = session["terminal_prompt_count"].as_i64().unwrap_or(0);
        session["terminal_prompt_count"] = json!(count + increment.min(500));
    }
    // A deleted session only takes the prompt counter.
    if !is_live(&session) {
        if increment > 0 {
            put(ctx.store, SESSIONS, &session)?;
        }
        return Ok(session);
    }
    if let Some(status) = params.get("status").and_then(Value::as_str) {
        if !SESSION_STATUSES.contains(&status) {
            return Err(invalid(format!("Unknown session status: {status}.")));
        }
    }
    if has(params, "name") {
        validate_required(params, "name", 255)?;
    }
    if let Some(new_name) = params.get("name").and_then(Value::as_str) {
        let current = s(&session, "name").unwrap_or_default();
        if new_name != current {
            let sid = s(&session, "id");
            if let Some(conflict) = find_by_name(ctx, new_name, true).filter(|c| s(c, "id") != sid)
            {
                if params.get("force_rename").and_then(Value::as_bool) != Some(true) {
                    return Err(LocalError::new(
                        "session_name_taken",
                        "A session with this name already exists.",
                    )
                    .with_details(
                        json!({ "conflict_id": conflict["id"], "conflict_name": conflict["name"] }),
                    ));
                }
                let mut moved = conflict;
                moved["name"] = json!(free_name(ctx, new_name));
                moved["updated_at"] = json!(now_iso());
                put(ctx.store, SESSIONS, &moved)?;
            }
        }
    }
    for key in [
        "name",
        "provider",
        "status",
        "config",
        "workspace_path",
        "workspace_name",
        "claude_session_id",
        "view_state",
        "standby_at",
        "repo_url",
        "repo_branch",
    ] {
        if has(params, key) {
            session[key] = params[key].clone();
        }
    }
    if has(params, "category_id") {
        session["category_id"] = session_category_id(ctx, params.get("category_id"));
    }
    if has(params, "workspace_id") {
        let requested = params["workspace_id"].clone();
        if requested != session["workspace_id"] {
            let allowed = match requested.as_str() {
                Some(wid) => live(ctx.store.get(WORKSPACES, wid)).is_some(),
                None => true,
            };
            if allowed {
                session["workspace_id"] = requested;
            }
        }
    }
    if has(params, "sub_agents") {
        session["sub_agents"] = match params["sub_agents"].as_array() {
            Some(incoming) => {
                Value::Array(merge_sub_agents(incoming, session["sub_agents"].as_array()))
            }
            None => Value::Null,
        };
    }
    if let Some(path) = params.get("workspace_path").and_then(Value::as_str) {
        let mut config = if has(params, "config") {
            params["config"].clone()
        } else {
            session["config"].clone()
        };
        if !config.is_object() {
            config = json!({});
        }
        config["cwd"] = json!(path);
        session["config"] = config;
    }
    sanitize_config(&mut session["config"]);
    session["updated_at"] = json!(now_iso());
    put(ctx.store, SESSIONS, &session)?;
    Ok(session_view(ctx, &session, None))
}

/// "name (2)", "name (3)", … — the first name nobody uses.
fn free_name(ctx: &Ctx, name: &str) -> String {
    let base: String = name.chars().take(240).collect();
    (2..)
        .map(|n| format!("{base} ({n})"))
        .find(|candidate| find_by_name(ctx, candidate, true).is_none())
        .unwrap_or(base)
}

/// Keeps the archived sub-agents of a session resumable: newest 20, at most
/// 30 days old, without any prompt text.
fn merge_sub_agents(incoming: &[Value], stored: Option<&Vec<Value>>) -> Vec<Value> {
    let is_archived = |v: &Value| v.get("status").and_then(Value::as_str) == Some("archived");
    let actives: Vec<Value> = incoming
        .iter()
        .filter(|v| !is_archived(v))
        .cloned()
        .collect();
    let mut archived: Vec<Value> = incoming
        .iter()
        .filter(|v| is_archived(v))
        .cloned()
        .collect();
    if archived.is_empty() {
        archived = stored
            .map(|list| list.iter().filter(|v| is_archived(v)).cloned().collect())
            .unwrap_or_default();
    }
    let archived_at = |v: &Value| {
        s(v, "archived_at")
            .or_else(|| s(v, "archivedAt"))
            .unwrap_or_default()
    };
    let cutoff = chrono::Utc::now() - chrono::Duration::days(ARCHIVE_TTL_DAYS);
    archived.retain(
        |v| match chrono::DateTime::parse_from_rfc3339(&archived_at(v)) {
            Ok(t) => t >= cutoff,
            Err(_) => true,
        },
    );
    let mut seen = std::collections::HashSet::new();
    archived.retain(|v| {
        let key = s(v, "archive_id")
            .or_else(|| s(v, "archiveId"))
            .or_else(|| s(v, "claude_session_id"))
            .or_else(|| s(v, "claudeSessionId"))
            .unwrap_or_else(|| format!("{}|{}", s(v, "title").unwrap_or_default(), archived_at(v)));
        seen.insert(key)
    });
    archived.sort_by_key(|b| std::cmp::Reverse(archived_at(b)));
    archived.truncate(ARCHIVE_MAX);
    sub_agents_without_prompts(&actives.into_iter().chain(archived).collect::<Vec<_>>())
}

/// Sub-agents of a session at `sessions.persist` (quit, profile switch). The
/// shell only knows the agents archived during this run, so the archive
/// already stored (earlier runs) is kept next to them instead of being
/// replaced: before, every quit dropped it and the resume list came back
/// empty after a restart. Same TTL, cap and dedup as `merge_sub_agents`.
fn persist_sub_agents(incoming: &[Value], stored: Option<&Vec<Value>>) -> Vec<Value> {
    let is_archived = |v: &&Value| v.get("status").and_then(Value::as_str) == Some("archived");
    let combined: Vec<Value> = incoming
        .iter()
        .chain(stored.into_iter().flatten().filter(is_archived))
        .cloned()
        .collect();
    merge_sub_agents(&combined, None)
}

/// Prompt fields a sub-agent entry may carry, in any of the spellings the
/// shell and the UI use.
const PROMPT_KEYS: &[&str] = &[
    "prompt",
    "user_prompt",
    "userPrompt",
    "auto_prompt",
    "autoPrompt",
];

fn strip_prompts(v: &mut Value) {
    if let Some(obj) = v.as_object_mut() {
        for key in PROMPT_KEYS {
            obj.remove(*key);
        }
    }
}

/// A sub-agent list as it may be stored: every entry without prompt text.
fn sub_agents_without_prompts(list: &[Value]) -> Vec<Value> {
    list.iter()
        .cloned()
        .map(|mut v| {
            strip_prompts(&mut v);
            v
        })
        .collect()
}

fn soft_delete(ctx: &Ctx, mut session: Value) -> LocalResult {
    let now = now_iso();
    session["deleted_at"] = json!(now);
    session["updated_at"] = json!(now);
    put(ctx.store, SESSIONS, &session)?;
    Ok(Value::Null)
}

/// `sessions.delete` — `{ id }`. The name stays reserved: creating a session
/// with the same name brings this one back.
fn session_delete(ctx: &Ctx) -> LocalResult {
    let id = ctx.required("id")?;
    let session = live(ctx.store.get(SESSIONS, &id)).ok_or_else(|| not_found("Session"))?;
    soft_delete(ctx, session)
}

/// `sessions.deleteByName` — `{ name }`.
fn session_delete_by_name(ctx: &Ctx) -> LocalResult {
    let name = ctx.required("name")?;
    let session = find_by_name(ctx, &name, false).ok_or_else(|| not_found("Session"))?;
    soft_delete(ctx, session)
}

/// `sessions.reorder` — `{ workspace_id, session_ids }`: tab order inside a
/// workspace. Entries may be ids or names.
fn session_reorder(ctx: &Ctx) -> LocalResult {
    let workspace_id = ctx.required("workspace_id")?;
    let ids = ctx
        .params
        .get("session_ids")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("session_ids is required."))?;
    let sessions = all_sessions(ctx);
    for (index, wanted) in ids.iter().filter_map(Value::as_str).enumerate() {
        let key = name_key(wanted);
        for mut session in sessions.iter().filter(|r| is_live(r)).cloned() {
            let same_ws = s(&session, "workspace_id").as_deref() == Some(workspace_id.as_str());
            let matches = s(&session, "id").as_deref() == Some(wanted)
                || s(&session, "name")
                    .map(|n| name_key(&n) == key)
                    .unwrap_or(false);
            if same_ws && matches {
                session["sort_order"] = json!(index);
                put(ctx.store, SESSIONS, &session)?;
            }
        }
    }
    Ok(Value::Null)
}

/// `sessions.persist` — `{ sessions: [...] }`: the shell saves every open
/// session at quit and when you switch profile.
fn session_persist(ctx: &Ctx) -> LocalResult {
    let entries = ctx
        .params
        .get("sessions")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("sessions is required."))?;
    let profile = ctx.profile();
    let mut persisted = 0;
    // Name → record index built once: looking every entry up by scanning (and
    // cloning) all sessions made a 500-session persist quadratic.
    let mut by_name: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for r in all_sessions(ctx) {
        let key = s(&r, "name").map(|n| name_key(&n)).unwrap_or_default();
        let keep_existing = by_name
            .get(&key)
            .is_some_and(|e| is_live(e) || !is_live(&r));
        if !keep_existing {
            by_name.insert(key, r);
        }
    }
    let live_workspaces: Vec<Value> = ctx
        .store
        .list(WORKSPACES)
        .into_iter()
        .filter(is_live)
        .collect();
    for entry in entries {
        let (Some(name), Some(_)) = (s(entry, "name"), s(entry, "provider")) else {
            continue;
        };
        if validate_required(entry, "name", 255).is_err() {
            continue;
        }
        let mut workspace_id = s(entry, "workspace_id");
        if workspace_id.is_none() {
            if let Some(path) = s(entry, "workspace_path") {
                workspace_id = live_workspaces
                    .iter()
                    .find(|w| {
                        s(w, "project_path").as_deref() == Some(path.as_str())
                            && s(w, "session_profile_id") == profile
                    })
                    .and_then(|w| s(w, "id"));
            }
        }
        let by_id = s(entry, "id").and_then(|id| live(ctx.store.get(SESSIONS, &id)));
        let mut session = match by_id {
            Some(mut existing) => {
                let authoritative = entry
                    .get("name_authoritative")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let current = s(&existing, "name").unwrap_or_default();
                // Taken = another record has that name (a case-only rename of
                // this same record is fine).
                let taken = by_name
                    .get(&name_key(&name))
                    .is_some_and(|other| s(other, "id") != s(&existing, "id"));
                if authoritative && name != current && !taken {
                    by_name.remove(&name_key(&current));
                    existing["name"] = json!(name);
                }
                existing
            }
            None => match by_name.get(&name_key(&name)).cloned() {
                Some(mut existing) => {
                    existing["deleted_at"] = Value::Null;
                    existing
                }
                None => new_session(&name),
            },
        };
        session["provider"] = entry["provider"].clone();
        session["status"] = entry
            .get("status")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!("idle"));
        for key in [
            "config",
            "workspace_path",
            "claude_session_id",
            "workspace_name",
            "standby_at",
        ] {
            session[key] = entry.get(key).cloned().unwrap_or(Value::Null);
        }
        let incoming = entry
            .get("sub_agents")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let kept = persist_sub_agents(&incoming, session["sub_agents"].as_array());
        session["sub_agents"] = if kept.is_empty() {
            Value::Null
        } else {
            Value::Array(kept)
        };
        if let Some(view) = entry.get("view_state").filter(|v| !v.is_null()) {
            session["view_state"] = view.clone();
        }
        if let Some(wid) = workspace_id {
            session["workspace_id"] = json!(wid);
        }
        session["session_profile_id"] = profile.clone().map(Value::from).unwrap_or(Value::Null);
        sanitize_config(&mut session["config"]);
        session["updated_at"] = json!(now_iso());
        put(ctx.store, SESSIONS, &session)?;
        if let Some(n) = s(&session, "name") {
            by_name.insert(name_key(&n), session);
        }
        persisted += 1;
    }
    Ok(json!({ "persisted": persisted }))
}

fn snapshot_id(ctx: &Ctx) -> String {
    ctx.text("device_id")
        .unwrap_or_else(|| "default".to_string())
}

/// `sessions.saveSnapshot` — which session was active and which panels were
/// open, restored at the next start.
fn snapshot_save(ctx: &Ctx) -> LocalResult {
    let params = ctx.params;
    let id = snapshot_id(ctx);
    let now = now_iso();
    let created = ctx
        .store
        .get(SNAPSHOTS, &id)
        .and_then(|r| s(&r, "created_at"))
        .unwrap_or_else(|| now.clone());
    let mut ui_state = params.get("ui_state").cloned().unwrap_or(Value::Null);
    if let Some(list) = ui_state.get("sub_agents").and_then(Value::as_array) {
        ui_state["sub_agents"] = Value::Array(sub_agents_without_prompts(list));
    }
    let snapshot = json!({
        "id": id,
        "user_id": LOCAL_USER_ID,
        "device_id": ctx.text("device_id"),
        "active_session_name": params.get("active_session_name").cloned().unwrap_or(Value::Null),
        "sub_agents_state": params.get("sub_agents_state").cloned().unwrap_or(Value::Null),
        "ui_state": ui_state,
        "created_at": created,
        "updated_at": now,
    });
    put(ctx.store, SNAPSHOTS, &snapshot)?;
    Ok(snapshot)
}

/// `sessions.archive` — closed sub-agents you can resume, newest first.
fn archive_list(ctx: &Ctx) -> LocalResult {
    let mut sessions: Vec<Value> = all_sessions(ctx).into_iter().filter(is_live).collect();
    sessions.sort_by_key(|b| std::cmp::Reverse(s(b, "updated_at")));
    let mut out = Vec::new();
    for session in &sessions {
        let Some(list) = session["sub_agents"].as_array() else {
            continue;
        };
        for (index, sa) in list.iter().enumerate() {
            if sa.get("status").and_then(Value::as_str) != Some("archived") {
                continue;
            }
            let pick = |a: &str, b: &str| {
                sa.get(a)
                    .filter(|v| !v.is_null())
                    .or_else(|| sa.get(b))
                    .cloned()
                    .unwrap_or(Value::Null)
            };
            let claude_id = pick("claude_session_id", "claudeSessionId");
            let archived_at = match pick("archived_at", "archivedAt") {
                Value::Null => session["updated_at"].clone(),
                v => v,
            };
            let mut entry = json!({
                "index": index,
                "archive_id": pick("archive_id", "archiveId"),
                "role": sa.get("role").cloned().unwrap_or(json!("custom")),
                "title": sa.get("title").cloned().unwrap_or(json!("Untitled")),
                "user_prompt": sa.get("user_prompt").or_else(|| sa.get("userPrompt")).or_else(|| sa.get("prompt")).cloned().unwrap_or(json!("")),
                "prompt": sa.get("prompt").cloned().unwrap_or(json!("")),
                "icon": sa.get("icon").cloned().unwrap_or(json!("solar:cpu-bolt-bold-duotone")),
                "mode": sa.get("mode").cloned().unwrap_or(Value::Null),
                "config": sa.get("config").cloned().unwrap_or(Value::Null),
                "provider": sa.get("provider").cloned().unwrap_or(json!("claude-code-cli")),
                "claude_session_id": claude_id,
                "status": "archived",
                "archived_at": archived_at,
                "parent_session_id": session["id"],
                "parent_session_name": sa.get("parent_session_name").cloned().unwrap_or(session["name"].clone()),
                "workspace_path": sa.get("workspace_path").cloned().unwrap_or(session["workspace_path"].clone()),
                "workspace_name": session["workspace_name"],
                "can_resume": !claude_id.is_null(),
            });
            for key in ["soft_skill", "softSkill", "updated_at"] {
                if let Some(v) = sa.get(key) {
                    entry[key] = v.clone();
                }
            }
            out.push(entry);
        }
    }
    out.sort_by_key(|b| std::cmp::Reverse(s(b, "archived_at")));
    Ok(Value::Array(out))
}

/// `sessions.removeArchived` — forget one archived sub-agent, found by
/// `archive_id`, `claude_session_id`, or `title` + `archived_at`.
fn archive_delete(ctx: &Ctx) -> LocalResult {
    let archive_id = ctx.text("archive_id");
    let claude_id = ctx.text("claude_session_id");
    let title = ctx.text("title");
    let archived_at = ctx.text("archived_at");
    let parent = ctx.text("parent_session_id");
    if archive_id.is_none() && claude_id.is_none() && (title.is_none() || archived_at.is_none()) {
        return Err(invalid("Say which archived sub-agent to remove."));
    }
    let field = |v: &Value, a: &str, b: &str| s(v, a).or_else(|| s(v, b));
    for mut session in all_sessions(ctx).into_iter().filter(is_live) {
        if parent
            .as_deref()
            .is_some_and(|p| s(&session, "id").as_deref() != Some(p))
        {
            continue;
        }
        let Some(list) = session["sub_agents"].as_array_mut() else {
            continue;
        };
        let position = list.iter().position(|sa| {
            sa.get("status").and_then(Value::as_str) == Some("archived")
                && if let Some(a) = &archive_id {
                    field(sa, "archive_id", "archiveId").as_deref() == Some(a.as_str())
                } else if let Some(c) = &claude_id {
                    field(sa, "claude_session_id", "claudeSessionId").as_deref() == Some(c.as_str())
                } else {
                    s(sa, "title") == title && field(sa, "archived_at", "archivedAt") == archived_at
                }
        });
        if let Some(i) = position {
            list.remove(i);
            put(ctx.store, SESSIONS, &session)?;
            return Ok(json!({ "removed": true }));
        }
    }
    Ok(json!({ "removed": false }))
}

/// `sessions.setSubAgentsOrder` — `{ id, order }`.
fn session_sub_agents_order(ctx: &Ctx) -> LocalResult {
    let id = ctx.required("id")?;
    let order = ctx
        .params
        .get("order")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("order is required."))?;
    let mut session = live(ctx.store.get(SESSIONS, &id)).ok_or_else(|| not_found("Session"))?;
    session["sub_agents_order"] = Value::Array(order.clone());
    session["updated_at"] = json!(now_iso());
    put(ctx.store, SESSIONS, &session)?;
    Ok(session)
}

/// `sessions.promote` — `{ id, target_workspace_id }`: attach a standalone
/// session to a workspace.
fn session_promote(ctx: &Ctx) -> LocalResult {
    let id = ctx.required("id")?;
    let target = ctx.required("target_workspace_id")?;
    let mut session = live(ctx.store.get(SESSIONS, &id)).ok_or_else(|| not_found("Session"))?;
    if !session["workspace_id"].is_null() {
        return Err(invalid("This session already belongs to a workspace."));
    }
    let workspace =
        live(ctx.store.get(WORKSPACES, &target)).ok_or_else(|| not_found("Workspace"))?;
    session["workspace_id"] = workspace["id"].clone();
    session["workspace_name"] = workspace["name"].clone();
    session["workspace_path"] = workspace["project_path"].clone();
    if !session["config"].is_object() {
        session["config"] = json!({});
    }
    session["config"]["cwd"] = workspace["project_path"].clone();
    session["updated_at"] = json!(now_iso());
    put(ctx.store, SESSIONS, &session)?;
    Ok(session_view(ctx, &session, None))
}

// ───────────────────────────── workspaces ─────────────────────────────
//
// A workspace is a project folder on your disk that groups sessions. The
// record holds its name and folder path, scoped to a session profile.

fn workspace_view(ctx: &Ctx, w: &Value) -> Value {
    let id = s(w, "id");
    let count = all_sessions(ctx)
        .iter()
        .filter(|r| is_live(r) && s(r, "workspace_id") == id)
        .count();
    let mut out = w.clone();
    out["active_sessions_count"] = json!(count);
    out["team"] = Value::Null;
    out["project"] = Value::Null;
    out
}

fn new_workspace(ctx: &Ctx, name: &str, path: &str) -> Value {
    let now = now_iso();
    json!({
        "id": local_store::new_id(),
        "user_id": LOCAL_USER_ID,
        "session_profile_id": ctx.profile(),
        "sidebar_folder_id": null,
        "team_id": null,
        "project_id": null,
        "name": name,
        "project_path": path,
        "created_at": now,
        "updated_at": now,
        "deleted_at": null,
    })
}

/// Same folder in the active profile, including deleted ones (oldest first).
fn find_workspace_by_path(ctx: &Ctx, path: &str) -> Option<Value> {
    let profile = ctx.profile();
    let mut list: Vec<Value> = ctx
        .store
        .list(WORKSPACES)
        .into_iter()
        .filter(|w| {
            s(w, "project_path").as_deref() == Some(path) && s(w, "session_profile_id") == profile
        })
        .collect();
    list.sort_by_key(|a| s(a, "created_at"));
    list.into_iter().next()
}

/// `workspaces.list` — workspaces of the active profile, oldest first.
fn workspace_list(ctx: &Ctx) -> LocalResult {
    let profile = ctx.profile();
    let mut list: Vec<Value> = ctx
        .store
        .list(WORKSPACES)
        .into_iter()
        .filter(is_live)
        .filter(|w| s(w, "session_profile_id") == profile)
        .collect();
    list.sort_by(|a, b| {
        s(a, "created_at")
            .cmp(&s(b, "created_at"))
            .then_with(|| s(a, "id").cmp(&s(b, "id")))
    });
    Ok(Value::Array(
        list.iter().map(|w| workspace_view(ctx, w)).collect(),
    ))
}

/// `workspaces.get` — `{ id }`.
fn workspace_get(ctx: &Ctx) -> LocalResult {
    let id = ctx.required("id")?;
    live(ctx.store.get(WORKSPACES, &id))
        .map(|w| workspace_view(ctx, &w))
        .ok_or_else(|| not_found("Workspace"))
}

/// `workspaces.create` — `{ name, project_path }`. An existing workspace for
/// the same folder is reused and renamed.
fn workspace_create(ctx: &Ctx) -> LocalResult {
    let name = validate_required(ctx.params, "name", 255)?;
    let path = ctx.required("project_path")?;
    let mut w =
        find_workspace_by_path(ctx, &path).unwrap_or_else(|| new_workspace(ctx, &name, &path));
    w["name"] = json!(name);
    w["deleted_at"] = Value::Null;
    w["updated_at"] = json!(now_iso());
    put(ctx.store, WORKSPACES, &w)?;
    Ok(workspace_view(ctx, &w))
}

/// `workspaces.findOrCreate` — `{ project_path, name? }`. The name defaults to
/// the folder name.
fn workspace_find_or_create(ctx: &Ctx) -> LocalResult {
    let path = ctx.required("project_path")?;
    let name = ctx.text("name").unwrap_or_else(|| {
        std::path::Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone())
    });
    let w = match find_workspace_by_path(ctx, &path) {
        Some(found) if is_live(&found) => found,
        Some(mut trashed) => {
            trashed["deleted_at"] = Value::Null;
            trashed["name"] = json!(name);
            trashed["updated_at"] = json!(now_iso());
            put(ctx.store, WORKSPACES, &trashed)?;
            trashed
        }
        None => {
            let w = new_workspace(ctx, &name, &path);
            put(ctx.store, WORKSPACES, &w)?;
            w
        }
    };
    Ok(workspace_view(ctx, &w))
}

/// `workspaces.update` — `{ id, name? }`.
fn workspace_update(ctx: &Ctx) -> LocalResult {
    let id = ctx.required("id")?;
    let mut w = live(ctx.store.get(WORKSPACES, &id)).ok_or_else(|| not_found("Workspace"))?;
    if has(ctx.params, "name") {
        w["name"] = json!(validate_required(ctx.params, "name", 255)?);
    }
    w["updated_at"] = json!(now_iso());
    put(ctx.store, WORKSPACES, &w)?;
    Ok(workspace_view(ctx, &w))
}

/// `workspaces.delete` — `{ id }`. Its sessions stay, detached from the workspace.
fn workspace_delete(ctx: &Ctx) -> LocalResult {
    let id = ctx.required("id")?;
    let mut w = live(ctx.store.get(WORKSPACES, &id)).ok_or_else(|| not_found("Workspace"))?;
    for mut session in all_sessions(ctx)
        .into_iter()
        .filter(|r| is_live(r) && s(r, "workspace_id").as_deref() == Some(id.as_str()))
    {
        session["workspace_id"] = Value::Null;
        put(ctx.store, SESSIONS, &session)?;
    }
    w["deleted_at"] = json!(now_iso());
    put(ctx.store, WORKSPACES, &w)?;
    Ok(Value::Null)
}

// ───────────────────────────── session profiles ─────────────────────────────
//
// Profiles split your sessions into contexts (for example "Work" and
// "Personal"). The Standard profile is implicit and has no record.

fn profile_view(ctx: &Ctx, p: &Value) -> Value {
    let id = s(p, "id");
    let sessions = all_sessions(ctx)
        .iter()
        .filter(|r| is_live(r) && s(r, "session_profile_id") == id)
        .count();
    let workspaces = ctx
        .store
        .list(WORKSPACES)
        .iter()
        .filter(|w| is_live(w) && s(w, "session_profile_id") == id)
        .count();
    let mut out = p.clone();
    out["desktop_sessions_count"] = json!(sessions);
    out["workspaces_count"] = json!(workspaces);
    out
}

fn sorted_live(ctx: &Ctx, collection: &str) -> Vec<Value> {
    let mut list: Vec<Value> = ctx
        .store
        .list(collection)
        .into_iter()
        .filter(is_live)
        .collect();
    list.sort_by(|a, b| {
        a["sort_order"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&b["sort_order"].as_i64().unwrap_or(0))
            .then_with(|| s(a, "created_at").cmp(&s(b, "created_at")))
    });
    list
}

/// Copies `name`, `color` and `sort_order` when present, after checking
/// them: a name is required text, a color is text or null, an order is a
/// whole number.
fn apply_name_color_order(
    record: &mut Value,
    params: &Value,
    max_name: usize,
) -> Result<(), LocalError> {
    if has(params, "name") {
        validate_required(params, "name", max_name)?;
    }
    validate_color(params)?;
    if has(params, "sort_order") && params["sort_order"].as_i64().is_none() {
        return Err(invalid("sort_order must be a whole number."));
    }
    for key in ["name", "color", "sort_order"] {
        if has(params, key) {
            record[key] = params[key].clone();
        }
    }
    Ok(())
}

/// A color, when given, is text (or null), on create as on update.
fn validate_color(params: &Value) -> Result<(), LocalError> {
    if has(params, "color") && !(params["color"].is_null() || params["color"].is_string()) {
        return Err(invalid("color must be text."));
    }
    Ok(())
}

fn profile_list(ctx: &Ctx) -> LocalResult {
    Ok(Value::Array(
        sorted_live(ctx, PROFILES)
            .iter()
            .map(|p| profile_view(ctx, p))
            .collect(),
    ))
}

/// `profiles.create` — `{ name, color? }`.
fn profile_create(ctx: &Ctx) -> LocalResult {
    let name = validate_required(ctx.params, "name", 255)?;
    validate_color(ctx.params)?;
    let next = sorted_live(ctx, PROFILES)
        .iter()
        .filter_map(|p| p["sort_order"].as_i64())
        .max()
        .unwrap_or(0)
        + 1;
    let now = now_iso();
    let p = json!({
        "id": local_store::new_id(),
        "user_id": LOCAL_USER_ID,
        "name": name,
        "color": ctx.params.get("color").cloned().unwrap_or(Value::Null),
        "sort_order": next,
        "created_at": now,
        "updated_at": now,
        "deleted_at": null,
    });
    put(ctx.store, PROFILES, &p)?;
    Ok(profile_view(ctx, &p))
}

/// `profiles.update` — `{ id, name?, color?, sort_order? }`.
fn profile_update(ctx: &Ctx) -> LocalResult {
    let id = ctx.required("id")?;
    let mut p = live(ctx.store.get(PROFILES, &id)).ok_or_else(|| not_found("Profile"))?;
    apply_name_color_order(&mut p, ctx.params, 255)?;
    p["updated_at"] = json!(now_iso());
    put(ctx.store, PROFILES, &p)?;
    Ok(profile_view(ctx, &p))
}

/// `profiles.delete` — `{ id }`. Its sessions and workspaces move to the
/// Standard profile.
fn profile_delete(ctx: &Ctx) -> LocalResult {
    let id = ctx.required("id")?;
    let mut p = live(ctx.store.get(PROFILES, &id)).ok_or_else(|| not_found("Profile"))?;
    for collection in [SESSIONS, WORKSPACES] {
        for mut r in
            ctx.store.list(collection).into_iter().filter(|r| {
                is_live(r) && s(r, "session_profile_id").as_deref() == Some(id.as_str())
            })
        {
            r["session_profile_id"] = Value::Null;
            put(ctx.store, collection, &r)?;
        }
    }
    p["deleted_at"] = json!(now_iso());
    put(ctx.store, PROFILES, &p)?;
    Ok(Value::Null)
}

// ───────────────────────────── sidebar folders ─────────────────────────────
//
// Folders group workspaces and sessions in the sidebar, inside a profile.
// Membership is stored on the workspace or session (`sidebar_folder_id`).

/// `folders.list` — folders of the active profile with the ids they contain.
fn folder_list(ctx: &Ctx) -> LocalResult {
    let profile = ctx.profile();
    let workspaces: Vec<Value> = ctx
        .store
        .list(WORKSPACES)
        .into_iter()
        .filter(is_live)
        .collect();
    let sessions: Vec<Value> = all_sessions(ctx).into_iter().filter(is_live).collect();
    let list: Vec<Value> = sorted_live(ctx, FOLDERS)
        .into_iter()
        .filter(|f| s(f, "session_profile_id") == profile)
        .map(|mut f| {
            let id = s(&f, "id");
            let ids = |rows: &[Value]| -> Vec<Value> {
                rows.iter()
                    .filter(|r| s(r, "sidebar_folder_id") == id)
                    .map(|r| r["id"].clone())
                    .collect()
            };
            f["workspace_ids"] = Value::Array(ids(&workspaces));
            f["session_ids"] = Value::Array(ids(&sessions));
            f
        })
        .collect();
    Ok(Value::Array(list))
}

/// `folders.create` — `{ name, color? }`.
fn folder_create(ctx: &Ctx) -> LocalResult {
    let name = validate_required(ctx.params, "name", 100)?;
    validate_color(ctx.params)?;
    let profile = ctx.profile();
    let next = sorted_live(ctx, FOLDERS)
        .iter()
        .filter(|f| s(f, "session_profile_id") == profile)
        .filter_map(|f| f["sort_order"].as_i64())
        .max()
        .unwrap_or(0)
        + 1;
    let now = now_iso();
    let f = json!({
        "id": local_store::new_id(),
        "user_id": LOCAL_USER_ID,
        "session_profile_id": profile,
        "name": name,
        "color": ctx.params.get("color").cloned().unwrap_or(Value::Null),
        "sort_order": next,
        "created_at": now,
        "updated_at": now,
        "deleted_at": null,
    });
    put(ctx.store, FOLDERS, &f)?;
    Ok(f)
}

/// `folders.reorder` — `{ folder_ids }`.
fn folder_reorder(ctx: &Ctx) -> LocalResult {
    let ids = ctx
        .params
        .get("folder_ids")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("folder_ids is required."))?;
    for (index, id) in ids.iter().filter_map(Value::as_str).enumerate() {
        if let Some(mut f) = live(ctx.store.get(FOLDERS, id)) {
            f["sort_order"] = json!(index);
            put(ctx.store, FOLDERS, &f)?;
        }
    }
    Ok(Value::Null)
}

/// `folders.assign` — `{ folder_id, workspace_ids, session_ids }`. A null
/// `folder_id` takes the items out of their folder.
fn folder_assign(ctx: &Ctx) -> LocalResult {
    let folder_id = ctx.text("folder_id");
    if let Some(id) = &folder_id {
        if live(ctx.store.get(FOLDERS, id)).is_none() {
            return Err(not_found("Folder"));
        }
    }
    let mut updated = Map::new();
    for (collection, key) in [(WORKSPACES, "workspace_ids"), (SESSIONS, "session_ids")] {
        let mut done = Vec::new();
        for id in ctx
            .params
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if let Some(mut r) = live(ctx.store.get(collection, id)) {
                r["sidebar_folder_id"] = folder_id.clone().map(Value::from).unwrap_or(Value::Null);
                put(ctx.store, collection, &r)?;
                done.push(json!(id));
            }
        }
        updated.insert(key.to_string(), Value::Array(done));
    }
    updated.insert(
        "folder_id".into(),
        folder_id.map(Value::from).unwrap_or(Value::Null),
    );
    Ok(Value::Object(updated))
}

/// `folders.update` — `{ id, name?, color?, sort_order? }`.
fn folder_update(ctx: &Ctx) -> LocalResult {
    let id = ctx.required("id")?;
    let mut f = live(ctx.store.get(FOLDERS, &id)).ok_or_else(|| not_found("Folder"))?;
    apply_name_color_order(&mut f, ctx.params, 100)?;
    f["updated_at"] = json!(now_iso());
    put(ctx.store, FOLDERS, &f)?;
    Ok(f)
}

/// `folders.delete` — `{ id }`. Its contents move out of the folder.
fn folder_delete(ctx: &Ctx) -> LocalResult {
    let id = ctx.required("id")?;
    let mut f = live(ctx.store.get(FOLDERS, &id)).ok_or_else(|| not_found("Folder"))?;
    for collection in [WORKSPACES, SESSIONS] {
        for mut r in ctx
            .store
            .list(collection)
            .into_iter()
            .filter(|r| s(r, "sidebar_folder_id").as_deref() == Some(id.as_str()))
        {
            r["sidebar_folder_id"] = Value::Null;
            put(ctx.store, collection, &r)?;
        }
    }
    f["deleted_at"] = json!(now_iso());
    put(ctx.store, FOLDERS, &f)?;
    Ok(Value::Null)
}

// ───────────────────────────── device workspaces ─────────────────────────────
//
// Where a session's folder is on a particular device (the same session can
// live in different folders on two computers).

fn device_rows(ctx: &Ctx) -> Vec<Value> {
    ctx.store.list(DEVICE_WORKSPACES)
}

/// `deviceWorkspaces.forDevice` — `{ device_id }`.
fn device_workspace_list(ctx: &Ctx) -> LocalResult {
    let device_id = ctx.required("device_id")?;
    Ok(Value::Array(
        device_rows(ctx)
            .into_iter()
            .filter(|d| s(d, "device_id").as_deref() == Some(device_id.as_str()))
            .collect(),
    ))
}

/// `deviceWorkspaces.get` — `{ session_id, device_id }`; null when unknown.
fn device_workspace_get(ctx: &Ctx) -> LocalResult {
    let session_id = ctx.required("session_id")?;
    let device_id = ctx.required("device_id")?;
    Ok(device_rows(ctx)
        .into_iter()
        .find(|d| {
            s(d, "session_id").as_deref() == Some(session_id.as_str())
                && s(d, "device_id").as_deref() == Some(device_id.as_str())
        })
        .unwrap_or(Value::Null))
}

/// `deviceWorkspaces.upsert` — `{ session_id, device_id, local_path }`.
fn device_workspace_upsert(ctx: &Ctx) -> LocalResult {
    let session_id = ctx.required("session_id")?;
    let device_id = ctx.required("device_id")?;
    let local_path = ctx.required("local_path")?;
    let now = now_iso();
    let existing = device_rows(ctx).into_iter().find(|d| {
        s(d, "session_id").as_deref() == Some(session_id.as_str())
            && s(d, "device_id").as_deref() == Some(device_id.as_str())
    });
    let mut d = existing.unwrap_or_else(|| {
        json!({ "id": local_store::new_id(), "user_id": LOCAL_USER_ID, "session_id": session_id, "device_id": device_id, "created_at": now })
    });
    d["local_path"] = json!(local_path);
    d["updated_at"] = json!(now);
    put(ctx.store, DEVICE_WORKSPACES, &d)?;
    Ok(d)
}

/// `deviceWorkspaces.update` — `{ id, local_path }`.
fn device_workspace_update(ctx: &Ctx) -> LocalResult {
    let id = ctx.required("id")?;
    let mut d = ctx
        .store
        .get(DEVICE_WORKSPACES, &id)
        .ok_or_else(|| not_found("Device workspace"))?;
    d["local_path"] = json!(ctx.required("local_path")?);
    d["updated_at"] = json!(now_iso());
    put(ctx.store, DEVICE_WORKSPACES, &d)?;
    Ok(d)
}

/// `deviceWorkspaces.delete` — `{ id }`.
fn device_workspace_delete(ctx: &Ctx) -> LocalResult {
    let id = ctx.required("id")?;
    ctx.store
        .get(DEVICE_WORKSPACES, &id)
        .ok_or_else(|| not_found("Device workspace"))?;
    ctx.store
        .delete(DEVICE_WORKSPACES, &id)
        .map_err(storage_error)?;
    Ok(Value::Null)
}

/// `deviceWorkspaces.migrateLegacy` — `{ device_id }`: gives every session
/// that only has a `workspace_path` a device workspace on this device.
fn device_workspace_migrate(ctx: &Ctx) -> LocalResult {
    let device_id = ctx.required("device_id")?;
    let now = now_iso();
    let rows = device_rows(ctx);
    let candidates: Vec<Value> = all_sessions(ctx)
        .into_iter()
        .filter(|r| is_live(r) && s(r, "workspace_path").is_some_and(|p| !p.is_empty()))
        .collect();
    let mut migrated = 0;
    for session in &candidates {
        let sid = s(session, "id");
        let exists = rows.iter().any(|d| {
            s(d, "session_id") == sid && s(d, "device_id").as_deref() == Some(device_id.as_str())
        });
        if !exists {
            let d = json!({
                "id": local_store::new_id(), "user_id": LOCAL_USER_ID, "session_id": sid, "device_id": device_id,
                "local_path": session["workspace_path"], "created_at": now, "updated_at": now,
            });
            put(ctx.store, DEVICE_WORKSPACES, &d)?;
            migrated += 1;
        }
    }
    Ok(json!({ "migrated": migrated, "total": candidates.len() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> LocalStore {
        let dir =
            std::env::temp_dir().join(format!("promptops-local-data-{}", local_store::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        LocalStore::open_at(&dir, crate::vault::VaultKey::from_bytes([3; 32])).unwrap()
    }

    fn ok(st: &LocalStore, method: &str, params: Value) -> Value {
        call_with(st, method, &params).unwrap_or_else(|e| panic!("{method} failed: {e}"))
    }

    fn err(st: &LocalStore, method: &str, params: Value) -> LocalError {
        call_with(st, method, &params).expect_err(method)
    }

    #[test]
    fn create_never_overwrites_another_live_session() {
        let st = store();
        let a = ok(
            &st,
            "sessions.create",
            json!({ "name": "api", "provider": "codex", "local_session_id": "pty-1" }),
        );
        // The same creation saved again (native manager + renderer): same record.
        let again = ok(
            &st,
            "sessions.create",
            json!({ "name": "api", "provider": "codex", "category_id": null }),
        );
        assert_eq!(again["id"], a["id"]);
        let again = ok(
            &st,
            "sessions.create",
            json!({ "name": "API", "provider": "codex", "local_session_id": "pty-1" }),
        );
        assert_eq!(again["id"], a["id"]);
        // Another terminal session with that name: refused, nothing changed.
        let clash = err(
            &st,
            "sessions.create",
            json!({ "name": "api", "provider": "claude-code-cli", "local_session_id": "pty-2" }),
        );
        assert_eq!(clash.code, "session_name_taken");
        assert_eq!(clash.details.unwrap()["conflict_id"], a["id"]);

        // Once the session has a conversation or sub-agents, or is old, a
        // second create without an id is another session too.
        let id = a["id"].as_str().unwrap();
        let mut rec = st.get(SESSIONS, id).unwrap();
        rec["claude_session_id"] = json!("conv-1");
        rec["sub_agents"] = json!([{ "id": "s1", "role": "dev" }]);
        st.put(SESSIONS, id, rec).unwrap();
        let clash = err(
            &st,
            "sessions.create",
            json!({ "name": "api", "provider": "codex" }),
        );
        assert_eq!(clash.code, "session_name_taken");
        let kept = st.get(SESSIONS, id).unwrap();
        assert_eq!(kept["claude_session_id"], "conv-1");
        assert_eq!(kept["provider"], "codex");
        assert_eq!(kept["sub_agents"].as_array().unwrap().len(), 1);

        let b = ok(
            &st,
            "sessions.create",
            json!({ "name": "old", "provider": "codex" }),
        );
        let bid = b["id"].as_str().unwrap();
        let mut rec = st.get(SESSIONS, bid).unwrap();
        rec["created_at"] = json!("2026-01-01T00:00:00.000000Z");
        st.put(SESSIONS, bid, rec).unwrap();
        assert_eq!(
            err(
                &st,
                "sessions.create",
                json!({ "name": "old", "provider": "codex" })
            )
            .code,
            "session_name_taken"
        );
        // The explicit restore path still replaces.
        let replaced = ok(
            &st,
            "sessions.create",
            json!({ "name": "old", "provider": "gemini-cli", "replace": true }),
        );
        assert_eq!(replaced["id"], b["id"]);
        assert_eq!(replaced["provider"], "gemini-cli");
    }

    #[test]
    fn create_list_and_rename_conflict() {
        let st = store();
        let a = ok(
            &st,
            "sessions.create",
            json!({ "name": "api", "provider": "codex", "config": { "env": { "KEY": "secret" }, "cols": 80 } }),
        );
        assert!(
            a["config"].get("env").is_none(),
            "environment variables are never stored"
        );
        let b = ok(
            &st,
            "sessions.create",
            json!({ "name": "web", "provider": "codex" }),
        );
        let b_id = b["id"].as_str().unwrap().to_string();
        assert_eq!(
            ok(&st, "sessions.list", Value::Null)
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let clash = err(
            &st,
            "sessions.update",
            json!({ "id": b_id, "name": "API " }),
        );
        assert_eq!(clash.code, "session_name_taken");
        assert_eq!(clash.details.unwrap()["conflict_name"], "api");
        ok(
            &st,
            "sessions.update",
            json!({ "id": b_id, "name": "api", "force_rename": true }),
        );
        let names: Vec<String> = ok(&st, "sessions.list", Value::Null)
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["name"].as_str().unwrap().to_string())
            .collect();
        assert!(names.contains(&"api".to_string()) && names.contains(&"api (2)".to_string()));
    }

    #[test]
    fn validation_errors_are_plain() {
        let st = store();
        let e = err(&st, "sessions.create", json!({ "provider": "codex" }));
        assert_eq!(e, invalid("name is required."));
        let long = "x".repeat(256);
        assert_eq!(
            err(
                &st,
                "sessions.create",
                json!({ "name": long, "provider": "codex" })
            )
            .code,
            "invalid"
        );
        let s = ok(
            &st,
            "sessions.create",
            json!({ "name": "s", "provider": "codex" }),
        );
        assert_eq!(
            err(
                &st,
                "sessions.update",
                json!({ "id": s["id"], "status": "dancing" })
            )
            .code,
            "invalid"
        );
        assert_eq!(
            err(&st, "sessions.get", json!({ "id": "missing" })).code,
            "not_found"
        );
        assert_eq!(err(&st, "nothing.here", Value::Null).code, "unknown_method");
    }

    #[test]
    fn deleted_session_comes_back_when_created_again() {
        let st = store();
        let id = ok(
            &st,
            "sessions.create",
            json!({ "name": "Caf\u{e9}", "provider": "codex" }),
        )["id"]
            .clone();
        assert_eq!(ok(&st, "sessions.delete", json!({ "id": id })), Value::Null);
        assert!(
            ok(&st, "sessions.list", Value::Null)
                .as_array()
                .unwrap()
                .is_empty(),
            "soft-deleted sessions are hidden"
        );
        assert_eq!(
            err(&st, "sessions.get", json!({ "id": id })).code,
            "not_found"
        );
        let again = ok(
            &st,
            "sessions.create",
            json!({ "name": "cafe", "provider": "codex" }),
        );
        assert_eq!(again["id"], id);
    }

    #[test]
    fn delete_by_name_and_reorder() {
        let st = store();
        let w = ok(
            &st,
            "workspaces.findOrCreate",
            json!({ "project_path": "/tmp/r" }),
        );
        ok(
            &st,
            "sessions.create",
            json!({ "name": "a", "provider": "codex", "workspace_id": w["id"] }),
        );
        ok(
            &st,
            "sessions.create",
            json!({ "name": "b", "provider": "codex", "workspace_id": w["id"] }),
        );
        ok(
            &st,
            "sessions.reorder",
            json!({ "workspace_id": w["id"], "session_ids": ["b", "a"] }),
        );
        let names: Vec<Value> = ok(&st, "sessions.list", json!({ "workspace_id": w["id"] }))
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["name"].clone())
            .collect();
        assert_eq!(names, vec![json!("b"), json!("a")]);
        ok(&st, "sessions.deleteByName", json!({ "name": "B" }));
        assert_eq!(
            ok(&st, "sessions.list", Value::Null)
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            err(&st, "sessions.reorder", json!({ "session_ids": [] })).code,
            "invalid"
        );
    }

    #[test]
    fn persist_updates_by_id_and_keeps_names_unique() {
        let st = store();
        let id = ok(
            &st,
            "sessions.create",
            json!({ "name": "one", "provider": "codex" }),
        )["id"]
            .clone();
        ok(
            &st,
            "sessions.create",
            json!({ "name": "two", "provider": "codex" }),
        );
        let r = ok(
            &st,
            "sessions.persist",
            json!({ "sessions": [
            { "id": id, "name": "two", "provider": "claude-code-cli", "status": "running", "name_authoritative": true },
            { "name": "three", "provider": "codex" }
        ] }),
        );
        assert_eq!(r["persisted"], 2);
        let one = ok(&st, "sessions.get", json!({ "id": id }));
        assert_eq!(one["name"], "one", "a taken name is not applied");
        assert_eq!(one["provider"], "claude-code-cli");
        // A case-only rename of the same record is not a conflict.
        ok(
            &st,
            "sessions.persist",
            json!({ "sessions": [{ "id": id, "name": "ONE", "provider": "codex" }] }),
        );
        assert_eq!(ok(&st, "sessions.get", json!({ "id": id }))["name"], "ONE");
        // A name persisted twice in one batch is one record.
        ok(
            &st,
            "sessions.persist",
            json!({ "sessions": [{ "name": "twin", "provider": "codex" }, { "name": "Twin", "provider": "codex" }] }),
        );
        let twins = ok(&st, "sessions.list", Value::Null)
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["name"].as_str().unwrap().eq_ignore_ascii_case("twin"))
            .count();
        assert_eq!(twins, 1);
    }

    #[test]
    fn archived_sub_agents_are_kept_without_prompts() {
        let st = store();
        ok(
            &st,
            "sessions.create",
            json!({ "name": "s", "provider": "codex" }),
        );
        let now = now_iso();
        ok(
            &st,
            "sessions.updateByName",
            json!({ "lookup_name": "s", "sub_agents": [
            { "title": "old", "status": "archived", "archived_at": now, "claude_session_id": "c1", "prompt": "secret" }
        ] }),
        );
        // An actives-only update keeps the archive.
        ok(
            &st,
            "sessions.updateByName",
            json!({ "lookup_name": "s", "sub_agents": [{ "title": "live", "status": "running" }] }),
        );
        let archive = ok(&st, "sessions.archive", Value::Null);
        let entries = archive.as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["prompt"], "");
        assert_eq!(entries[0]["can_resume"], true);
        assert_eq!(
            ok(
                &st,
                "sessions.removeArchived",
                json!({ "claude_session_id": "c1" })
            )["removed"],
            true
        );
        assert!(ok(&st, "sessions.archive", Value::Null)
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn quit_persist_keeps_the_archive_of_earlier_runs() {
        let st = store();
        let earlier = now_iso();
        ok(
            &st,
            "sessions.create",
            json!({ "name": "s", "provider": "codex" }),
        );
        // An earlier run archived one agent.
        ok(
            &st,
            "sessions.updateByName",
            json!({ "lookup_name": "s", "sub_agents": [
            { "title": "old", "status": "archived", "archived_at": earlier, "claudeSessionId": "c-old" }
        ] }),
        );
        // This run's quit: nothing archived in this run...
        ok(
            &st,
            "sessions.persist",
            json!({ "sessions": [{ "name": "s", "provider": "codex" }] }),
        );
        let titles = |st: &LocalStore| -> Vec<String> {
            ok(st, "sessions.archive", Value::Null)
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["title"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(titles(&st), vec!["old"]);
        // ...or one more, which joins the earlier one (no duplicate).
        ok(
            &st,
            "sessions.persist",
            json!({ "sessions": [{ "name": "s", "provider": "codex", "sub_agents": [
                { "title": "new", "status": "archived", "archivedAt": now_iso(), "claudeSessionId": "c-new", "userPrompt": "SECRET" },
                { "title": "old", "status": "archived", "archivedAt": earlier, "claudeSessionId": "c-old" }
            ] }] }),
        );
        assert_eq!(titles(&st), vec!["new", "old"]);
        assert!(!serde_json::to_string(&st.snapshot())
            .unwrap()
            .contains("SECRET"));
    }

    #[test]
    fn workspaces_folders_and_profiles() {
        let st = store();
        let w = ok(
            &st,
            "workspaces.findOrCreate",
            json!({ "project_path": "/tmp/acme" }),
        );
        assert_eq!(w["name"], "acme");
        assert_eq!(
            ok(
                &st,
                "workspaces.findOrCreate",
                json!({ "project_path": "/tmp/acme" })
            )["id"],
            w["id"]
        );
        let f = ok(&st, "folders.create", json!({ "name": "Clients" }));
        ok(
            &st,
            "folders.assign",
            json!({ "folder_id": f["id"], "workspace_ids": [w["id"]], "session_ids": [] }),
        );
        assert_eq!(
            ok(&st, "folders.list", Value::Null)[0]["workspace_ids"][0],
            w["id"]
        );
        let p = ok(&st, "profiles.create", json!({ "name": "Work" }));
        assert_eq!(p["sort_order"], 1);
        // Sessions in a profile are listed only with that profile.
        ok(
            &st,
            "sessions.create",
            json!({ "name": "w1", "provider": "codex", "profile_id": p["id"] }),
        );
        assert_eq!(
            ok(&st, "sessions.list", json!({ "profile_id": p["id"] }))
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(ok(&st, "sessions.list", Value::Null)
            .as_array()
            .unwrap()
            .is_empty());
        ok(&st, "profiles.delete", json!({ "id": p["id"] }));
        assert_eq!(
            ok(&st, "sessions.list", Value::Null)
                .as_array()
                .unwrap()
                .len(),
            1,
            "sessions move to Standard"
        );
        // A deleted workspace keeps its sessions, detached.
        let s = ok(
            &st,
            "sessions.create",
            json!({ "name": "inside", "provider": "codex", "workspace_id": w["id"] }),
        );
        ok(&st, "workspaces.delete", json!({ "id": w["id"] }));
        assert!(ok(&st, "sessions.get", json!({ "id": s["id"] }))["workspace_id"].is_null());
        assert_eq!(
            err(&st, "workspaces.get", json!({ "id": w["id"] })).code,
            "not_found"
        );
    }

    #[test]
    fn device_workspaces() {
        let st = store();
        let s = ok(
            &st,
            "sessions.create",
            json!({ "name": "s", "provider": "codex", "workspace_path": "/tmp/s" }),
        );
        let migrated = ok(
            &st,
            "deviceWorkspaces.migrateLegacy",
            json!({ "device_id": "dev" }),
        );
        assert_eq!(migrated["migrated"], 1);
        let d = ok(
            &st,
            "deviceWorkspaces.get",
            json!({ "session_id": s["id"], "device_id": "dev" }),
        );
        assert_eq!(d["local_path"], "/tmp/s");
        ok(
            &st,
            "deviceWorkspaces.upsert",
            json!({ "session_id": s["id"], "device_id": "dev", "local_path": "/tmp/t" }),
        );
        assert_eq!(
            ok(
                &st,
                "deviceWorkspaces.forDevice",
                json!({ "device_id": "dev" })
            )
            .as_array()
            .unwrap()
            .len(),
            1
        );
        let listed = ok(&st, "sessions.list", json!({ "device_id": "dev" }));
        assert_eq!(listed[0]["device_workspace"]["local_path"], "/tmp/t");
        ok(&st, "deviceWorkspaces.delete", json!({ "id": d["id"] }));
        assert!(ok(
            &st,
            "deviceWorkspaces.get",
            json!({ "session_id": s["id"], "device_id": "dev" })
        )
        .is_null());
    }

    #[test]
    fn prompts_versions_and_restore() {
        let st = store();
        let p = ok(
            &st,
            "prompts.create",
            json!({ "title": "Review", "body": "Check {{file}} and {{file}} {{lang}}" }),
        );
        assert_eq!(p["variables"], json!(["file", "lang"]));
        let id = p["id"].clone();
        ok(&st, "prompts.update", json!({ "id": id, "body": "v2" }));
        let versions = ok(&st, "prompts.versions", json!({ "id": id }));
        assert_eq!(versions[0]["version_number"], 2);
        assert_eq!(versions[0]["body"], "v2");
        let restored = ok(
            &st,
            "prompts.restoreVersion",
            json!({ "id": id, "version_id": versions[1]["id"] }),
        );
        assert_eq!(restored["current_version"], 3);
        let found = ok(&st, "prompts.list", json!({ "search": "check" }));
        assert_eq!(found["pagination"]["total"], 1);
        ok(&st, "prompts.delete", json!({ "id": id }));
        assert_eq!(
            ok(&st, "prompts.list", Value::Null)["pagination"]["total"],
            0
        );
        assert_eq!(
            err(&st, "prompts.create", json!({ "title": "t" })).code,
            "invalid"
        );
    }

    #[test]
    fn session_keeps_an_existing_prompt_category() {
        let st = store();
        let cat = ok(&st, "promptCategories.create", json!({ "name": "API" }));
        let s = ok(
            &st,
            "sessions.create",
            json!({ "name": "api", "provider": "codex", "category_id": cat["id"], "team_id": 7, "project_id": 9 }),
        );
        assert_eq!(s["category_id"], cat["id"]);
        assert_eq!(s["team_id"], Value::Null);
        assert_eq!(s["project_id"], Value::Null);
        let listed = ok(&st, "sessions.list", Value::Null);
        assert_eq!(listed[0]["category"]["name"], "API");
        let sid = s["id"].clone();
        let moved = ok(
            &st,
            "sessions.update",
            json!({ "id": sid, "category_id": 999 }),
        );
        assert_eq!(
            moved["category_id"],
            Value::Null,
            "unknown categories are dropped"
        );
        let back = ok(
            &st,
            "sessions.update",
            json!({ "id": sid, "category_id": cat["id"].to_string() }),
        );
        assert_eq!(back["category_id"], cat["id"]);
    }

    #[test]
    fn prompt_stars_toggle_and_filter() {
        let st = store();
        let a = ok(&st, "prompts.create", json!({ "title": "A", "body": "a" }));
        ok(&st, "prompts.create", json!({ "title": "B", "body": "b" }));
        assert_eq!(a["is_starred"], false);
        let starred = ok(&st, "prompts.toggleStar", json!({ "id": a["id"] }));
        assert_eq!(starred["is_starred"], true);
        assert_eq!(starred["stars_count"], 1);
        assert_eq!(starred["current_version"], 1, "a star is not an edit");
        assert_eq!(
            ok(&st, "prompts.get", json!({ "id": a["id"] }))["is_starred"],
            true
        );
        let only = ok(&st, "prompts.list", json!({ "starred": true }));
        assert_eq!(only["pagination"]["total"], 1);
        assert_eq!(only["prompts"][0]["id"], a["id"]);
        let by_stars = ok(
            &st,
            "prompts.list",
            json!({ "sort_field": "stars_count", "sort_dir": "desc" }),
        );
        assert_eq!(by_stars["prompts"][0]["id"], a["id"]);
        let unstarred = ok(&st, "prompts.toggleStar", json!({ "id": a["id"] }));
        assert_eq!(unstarred["is_starred"], false);
        assert_eq!(
            ok(&st, "prompts.list", json!({ "starred": true }))["pagination"]["total"],
            0
        );
        assert_eq!(
            err(&st, "prompts.toggleStar", json!({ "id": 999 })).code,
            "not_found"
        );
    }

    #[test]
    fn action_slots_echo_their_scope() {
        let st = store();
        let w = ok(
            &st,
            "workspaces.findOrCreate",
            json!({ "project_path": "/tmp/x" }),
        );
        let s = ok(
            &st,
            "sessions.create",
            json!({ "name": "s", "provider": "codex", "workspace_id": w["id"] }),
        );
        let p = ok(&st, "prompts.create", json!({ "title": "t", "body": "b" }))["id"].clone();
        let sid = s["id"].as_str().unwrap();
        ok(
            &st,
            "actionSlots.create",
            json!({ "prompt_id": p, "label": "Go", "session_id": sid, "scope": "session" }),
        );
        let list = ok(
            &st,
            "actionSlots.list",
            json!({ "session_id": sid, "scope": "session" }),
        );
        assert_eq!(list["scope"], json!({ "type": "workspace", "id": w["id"] }));
        assert_eq!(list["slots"].as_array().unwrap().len(), 1);
        let dup = err(
            &st,
            "actionSlots.create",
            json!({ "prompt_id": p, "label": "Go", "session_id": sid }),
        );
        assert_eq!(dup.code, "conflict");
    }

    #[test]
    fn shortcuts_and_notes() {
        let st = store();
        let p = ok(&st, "prompts.create", json!({ "title": "t", "body": "b" }))["id"].clone();
        let sc = ok(
            &st,
            "shortcuts.create",
            json!({ "prompt_id": p, "label": "T" }),
        );
        assert_eq!(
            err(
                &st,
                "shortcuts.create",
                json!({ "prompt_id": p, "label": "T" })
            )
            .code,
            "conflict"
        );
        ok(
            &st,
            "prompts.update",
            json!({ "id": p, "title": "renamed" }),
        );
        assert_eq!(
            ok(&st, "shortcuts.list", Value::Null)[0]["label"],
            "renamed"
        );
        ok(&st, "shortcuts.delete", json!({ "id": sc["id"] }));
        assert!(ok(&st, "shortcuts.list", Value::Null)
            .as_array()
            .unwrap()
            .is_empty());
        let n = ok(
            &st,
            "notes.create",
            json!({ "content": "remember", "session_id": "s1" }),
        );
        assert_eq!(
            ok(&st, "notes.list", json!({ "session_id": "s1" }))
                .as_array()
                .unwrap()
                .len(),
            1
        );
        ok(&st, "notes.delete", json!({ "id": n["id"] }));
        assert_eq!(
            err(&st, "notes.delete", json!({ "id": n["id"] })).code,
            "not_found"
        );
    }

    #[test]
    fn prompt_text_is_never_stored_with_sub_agents_or_the_ui_snapshot() {
        let st = store();
        let agents = json!([
            { "title": "a", "status": "running", "autoPrompt": "SECRET-1", "userPrompt": "SECRET-2" },
            { "title": "b", "status": "archived", "archived_at": now_iso(), "prompt": "SECRET-3", "user_prompt": "SECRET-4", "auto_prompt": "SECRET-5" }
        ]);
        ok(
            &st,
            "sessions.create",
            json!({ "name": "s", "provider": "codex", "sub_agents": agents }),
        );
        ok(
            &st,
            "sessions.updateByName",
            json!({ "lookup_name": "s", "sub_agents": agents }),
        );
        ok(
            &st,
            "sessions.persist",
            json!({ "sessions": [{ "name": "s", "provider": "codex", "sub_agents": agents }] }),
        );
        ok(
            &st,
            "sessions.saveSnapshot",
            json!({ "active_session_name": "s", "ui_state": { "sub_agents": agents } }),
        );
        let everything = serde_json::to_string(&st.snapshot()).unwrap();
        assert!(!everything.contains("SECRET"), "{everything}");
        // The rest of each entry is kept.
        let listed = ok(&st, "sessions.list", Value::Null);
        assert_eq!(listed[0]["sub_agents"][0]["title"], "a");
    }

    #[test]
    fn renames_and_updates_are_validated() {
        let st = store();
        let s = ok(
            &st,
            "sessions.create",
            json!({ "name": "s", "provider": "codex" }),
        );
        for bad in [json!(""), json!("   "), json!("x".repeat(256)), json!(null)] {
            let e = err(
                &st,
                "sessions.update",
                json!({ "id": s["id"], "name": bad }),
            );
            assert_eq!(e.code, "invalid");
        }
        assert_eq!(
            ok(&st, "sessions.get", json!({ "id": s["id"] }))["name"],
            "s"
        );
        let w = ok(
            &st,
            "workspaces.findOrCreate",
            json!({ "project_path": "/tmp/v" }),
        );
        assert_eq!(
            err(
                &st,
                "workspaces.update",
                json!({ "id": w["id"], "name": " " })
            )
            .code,
            "invalid"
        );
        let f = ok(&st, "folders.create", json!({ "name": "F" }));
        assert_eq!(
            err(
                &st,
                "folders.update",
                json!({ "id": f["id"], "sort_order": "first" })
            )
            .code,
            "invalid"
        );
        assert_eq!(
            err(&st, "folders.update", json!({ "id": f["id"], "name": "" })).code,
            "invalid"
        );
        let p = ok(&st, "profiles.create", json!({ "name": "P" }));
        assert_eq!(
            err(&st, "profiles.update", json!({ "id": p["id"], "color": 5 })).code,
            "invalid"
        );
        for method in ["profiles.create", "folders.create"] {
            let e = err(&st, method, json!({ "name": "C", "color": { "x": 1 } }));
            assert_eq!(e.code, "invalid", "{method}");
        }
        ok(
            &st,
            "profiles.update",
            json!({ "id": p["id"], "color": "#fff", "sort_order": 3 }),
        );
        // persist skips entries without a usable name instead of storing them.
        let r = ok(
            &st,
            "sessions.persist",
            json!({ "sessions": [{ "name": "x".repeat(300), "provider": "codex" }] }),
        );
        assert_eq!(r["persisted"], 0);
    }

    #[test]
    fn promote_attaches_a_standalone_session_once() {
        let st = store();
        let w = ok(
            &st,
            "workspaces.findOrCreate",
            json!({ "project_path": "/tmp/promo" }),
        );
        let s = ok(
            &st,
            "sessions.create",
            json!({ "name": "loose", "provider": "codex" }),
        );
        let promoted = ok(
            &st,
            "sessions.promote",
            json!({ "id": s["id"], "target_workspace_id": w["id"] }),
        );
        assert_eq!(promoted["workspace_id"], w["id"]);
        assert_eq!(promoted["config"]["cwd"], "/tmp/promo");
        assert_eq!(
            err(
                &st,
                "sessions.promote",
                json!({ "id": s["id"], "target_workspace_id": w["id"] })
            )
            .code,
            "invalid"
        );
        let other = ok(
            &st,
            "sessions.create",
            json!({ "name": "loose2", "provider": "codex" }),
        );
        assert_eq!(
            err(
                &st,
                "sessions.promote",
                json!({ "id": other["id"], "target_workspace_id": "nope" })
            )
            .code,
            "not_found"
        );
    }

    #[test]
    fn reorder_touches_only_the_named_workspace() {
        let st = store();
        let w1 = ok(
            &st,
            "workspaces.findOrCreate",
            json!({ "project_path": "/tmp/w1" }),
        );
        let w2 = ok(
            &st,
            "workspaces.findOrCreate",
            json!({ "project_path": "/tmp/w2" }),
        );
        ok(
            &st,
            "sessions.create",
            json!({ "name": "a", "provider": "codex", "workspace_id": w1["id"] }),
        );
        ok(
            &st,
            "sessions.create",
            json!({ "name": "b", "provider": "codex", "workspace_id": w1["id"] }),
        );
        let c = ok(
            &st,
            "sessions.create",
            json!({ "name": "c", "provider": "codex", "workspace_id": w2["id"] }),
        );
        ok(
            &st,
            "sessions.reorder",
            json!({ "workspace_id": w1["id"], "session_ids": ["c", "B", "a"] }),
        );
        let in_w1: Vec<Value> = ok(&st, "sessions.list", json!({ "workspace_id": w1["id"] }))
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["name"].clone())
            .collect();
        assert_eq!(in_w1, vec![json!("b"), json!("a")]);
        assert_eq!(
            ok(&st, "sessions.get", json!({ "id": c["id"] }))["sort_order"],
            0
        );
    }

    #[test]
    fn store_health_is_exposed_to_the_interface() {
        let st = store();
        let h = ok(&st, "store.health", Value::Null);
        assert_eq!(h["unreadable"], 0);
        assert_eq!(h["formatVersion"], crate::local_store::FORMAT_VERSION);
        assert!(h.get("quarantined").is_none());
    }

    #[test]
    fn two_windows_writing_at_once_keep_both_changes() {
        let st = std::sync::Arc::new(store());
        let s = ok(
            &st,
            "sessions.create",
            json!({ "name": "shared", "provider": "codex" }),
        );
        let id = s["id"].as_str().unwrap().to_string();
        let threads: Vec<_> = (0..4)
            .map(|w| {
                let (st, id) = (st.clone(), id.clone());
                std::thread::spawn(move || {
                    for i in 0..20 {
                        // Window w: its own notes + a counter on the shared session.
                        ok(
                            &st,
                            "notes.create",
                            json!({ "content": format!("w{w}-{i}") }),
                        );
                        ok(
                            &st,
                            "sessions.update",
                            json!({ "id": id, "terminal_prompt_count_increment": 1 }),
                        );
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(
            ok(&st, "notes.list", Value::Null).as_array().unwrap().len(),
            80
        );
        assert_eq!(
            ok(&st, "sessions.get", json!({ "id": id }))["terminal_prompt_count"],
            80
        );
        // Ids stay unique under concurrency.
        let ids: std::collections::HashSet<String> = ok(&st, "notes.list", Value::Null)
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["id"].to_string())
            .collect();
        assert_eq!(ids.len(), 80);
    }

    #[test]
    fn a_crash_at_any_moment_of_a_persist_leaves_all_or_nothing_on_disk() {
        let dir = std::env::temp_dir().join(format!(
            "promptops-local-data-crash-{}",
            local_store::new_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let key = || crate::vault::VaultKey::from_bytes([4; 32]);
        let st = std::sync::Arc::new(LocalStore::open_at(&dir, key()).unwrap());
        ok(
            &st,
            "sessions.create",
            json!({ "name": "seed", "provider": "codex" }),
        );
        let file = dir.join("local-store.json");
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        // "kill -9" simulator: snapshots the file as the OS would leave it at
        // any instant while the persist runs.
        let watcher = {
            let (file, stop, dir) = (file.clone(), stop.clone(), dir.clone());
            std::thread::spawn(move || {
                let mut seen = Vec::new();
                let mut n = 0;
                while !stop.load(std::sync::atomic::Ordering::SeqCst) && n < 150 {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                    let copy = dir.join(format!("crash-{n}"));
                    std::fs::create_dir_all(&copy).unwrap();
                    if std::fs::copy(&file, copy.join("local-store.json")).is_ok() {
                        seen.push(copy);
                        n += 1;
                    }
                }
                seen
            })
        };
        let batch: Vec<Value> = (0..300)
            .map(|i| json!({ "name": format!("p{i}"), "provider": "codex" }))
            .collect();
        for _ in 0..3 {
            ok(&st, "sessions.persist", json!({ "sessions": batch }));
        }
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        let copies = watcher.join().unwrap();
        assert!(!copies.is_empty());
        for copy in copies {
            let reopened = LocalStore::open_at(&copy, key()).unwrap();
            assert!(reopened.health().quarantined.is_none(), "torn file seen");
            let n = reopened
                .list(SESSIONS)
                .iter()
                .filter(|s| s["name"].as_str().is_some_and(|n| n.starts_with('p')))
                .count();
            assert!(n == 0 || n == 300, "half a persist on disk: {n}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Checkpoint 6 benchmark: `cargo test --lib bench_ten_thousand_prompts -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn bench_ten_thousand_prompts_and_five_hundred_sessions() {
        use std::time::Instant;
        let dir = std::env::temp_dir().join(format!(
            "promptops-local-data-bench-{}",
            local_store::new_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let key = || crate::vault::VaultKey::from_bytes([8; 32]);
        let st = LocalStore::open_at(&dir, key()).unwrap();
        let body = "Review the change and report. ".repeat(20);
        let mut records: std::collections::BTreeMap<
            String,
            std::collections::BTreeMap<String, Value>,
        > = Default::default();
        let now = now_iso();
        for i in 1..=10_000i64 {
            let p = json!({ "id": i, "user_id": 1, "title": format!("Prompt {i}"), "body": body,
                "status": "draft", "visibility": "private", "current_version": 1, "tag_ids": [],
                "sub_agents": [], "created_at": now, "updated_at": now, "deleted_at": null });
            records
                .entry(PROMPTS_FOR_BENCH.into())
                .or_default()
                .insert(i.to_string(), p);
        }
        for i in 0..500 {
            let mut s = new_session(&format!("session-{i}"));
            s["provider"] = json!("codex");
            s["sort_order"] = json!(i);
            records
                .entry(SESSIONS.into())
                .or_default()
                .insert(s["id"].as_str().unwrap().to_string(), s);
        }
        let t = Instant::now();
        st.replace_all(records, false, &dir.join("prev.json"))
            .unwrap();
        let seed = t.elapsed();
        let size = std::fs::metadata(dir.join("local-store.json"))
            .unwrap()
            .len();

        let t = Instant::now();
        let reopened = LocalStore::open_at(&dir, key()).unwrap();
        let open = t.elapsed();
        let time = |label: &str, f: &dyn Fn()| {
            let t = Instant::now();
            f();
            eprintln!("[bench] {label}: {:?}", t.elapsed());
        };
        eprintln!("[bench] seed 10,000 prompts + 500 sessions: {seed:?}, file {size} bytes");
        eprintln!("[bench] open (decrypt everything): {open:?}");
        time("prompts.list page 1 (sorted, 10k scanned)", &|| {
            ok(&reopened, "prompts.list", json!({ "per_page": 20 }));
        });
        time("prompts.list search", &|| {
            ok(
                &reopened,
                "prompts.list",
                json!({ "search": "prompt 9999" }),
            );
        });
        time("prompts.create (1 write of the whole file)", &|| {
            ok(
                &reopened,
                "prompts.create",
                json!({ "title": "t", "body": "b" }),
            );
        });
        time("sessions.list (500)", &|| {
            ok(&reopened, "sessions.list", Value::Null);
        });
        let batch: Vec<Value> = (0..500)
            .map(|i| json!({ "name": format!("session-{i}"), "provider": "codex", "status": "idle" }))
            .collect();
        time("sessions.persist (500 sessions, one write)", &|| {
            ok(&reopened, "sessions.persist", json!({ "sessions": batch }));
        });
        time("sessions.update (rename)", &|| {
            ok(
                &reopened,
                "sessions.updateByName",
                json!({ "lookup_name": "session-7", "name": "session-7b" }),
            );
        });
    }

    const PROMPTS_FOR_BENCH: &str = "prompts";

    #[test]
    fn local_profile() {
        let st = store();
        let me = ok(&st, "user.me", Value::Null);
        assert_eq!(me["role"]["name"], "user");
        assert_eq!(me["is_pro"], true);
        ok(&st, "user.completeOnboarding", json!({}));
        assert!(ok(&st, "user.me", Value::Null)["onboarding_completed_at"].is_string());
        let prefs = ok(&st, "user.updateUiPreferences", json!({ "theme": "dark" }));
        assert_eq!(prefs["ui_preferences"]["theme"], "dark");
        assert_eq!(
            err(
                &st,
                "user.setPreferredProvider",
                json!({ "provider": "nope" })
            )
            .code,
            "invalid"
        );
    }
}
