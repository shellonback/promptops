//! Agents — the main session is no longer a category.
//!
//! From the first spawn the session PTY is an agent like the others: the "lead".
//! This module keeps the metadata that makes that true at runtime, without
//! touching the stored session (the `sessions` record stays container + identity of the
//! original lead):
//!
//! - `lead_closed`: the user closed the session PTY. Sub-agents stay
//!   alive, the session stays active (no standby_at), the wake does NOT
//!   respawn it. It is reopened only explicitly (`agents_reopen_lead`), with the
//!   provider resume of the normal wake.
//! - `lead_id`: lead preference (None = session PTY). The EFFECTIVE lead
//!   is resolved by the renderer on the live roster: if the preference no longer exists,
//!   lead = first remaining pane ("the last one left becomes the main").
//! - `order`: pane order (reserved, not used by the UI yet).
//!
//! Key = stored dbId when known (stable across runs: on restart the local id
//! changes), otherwise the local id. Persisted in `agents-meta.json` inside
//! `hook_data_dir()`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Emitter;

use crate::commands::session::{SessionManager, SessionSummary};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead_id: Option<String>,
    /// Stable identity (`role|title`) of the chosen lead. A sub-agent's id
    /// changes on every respawn (restart, wake from standby): without this the
    /// lead preference was lost and fell back to the first pane.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead_key: Option<String>,
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub lead_closed: bool,
}

fn meta_path() -> PathBuf {
    crate::commands::hook::hook_data_dir().join("agents-meta.json")
}

fn load_from_disk() -> HashMap<String, AgentsMeta> {
    std::fs::read_to_string(meta_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn store() -> &'static Mutex<HashMap<String, AgentsMeta>> {
    static STORE: OnceLock<Mutex<HashMap<String, AgentsMeta>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(load_from_disk()))
}

fn persist(map: &HashMap<String, AgentsMeta>) {
    let path = meta_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let Ok(json) = serde_json::to_string_pretty(map) else {
        return;
    };
    // Atomic write: never a half-written file in case of a crash.
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Meta keys of a session: (resolved local id, dbId if known). The canonical
/// key is the dbId (stable across runs); the local id is used only until the
/// dbId exists.
fn meta_keys(manager: &SessionManager, session_id: &str) -> (String, Option<String>) {
    let local = manager
        .resolve_local_id(session_id)
        .unwrap_or_else(|| session_id.to_string());
    let db = manager.db_id_of(&local);
    (local, db)
}

/// A meta written when the dbId was not known yet lives under the local id,
/// which changes on restart: without migration the "lead closed" was lost and the
/// main reappeared. As soon as the dbId is known we move it under the dbId.
fn migrate_local_key(map: &mut HashMap<String, AgentsMeta>, local: &str, db: Option<&str>) -> bool {
    let Some(db) = db else { return false };
    if local == db || !map.contains_key(local) {
        return false;
    }
    let from_local = map.remove(local).unwrap_or_default();
    map.entry(db.to_string()).or_insert(from_local);
    true
}

pub fn meta_for(manager: &SessionManager, session_id: &str) -> AgentsMeta {
    let (local, db) = meta_keys(manager, session_id);
    let mut map = store().lock();
    *map = load_from_disk(); // small file, shared between instances: disk = truth
    if migrate_local_key(&mut map, &local, db.as_deref()) {
        persist(&map);
    }
    let mut meta = db
        .as_deref()
        .and_then(|k| map.get(k))
        .or_else(|| map.get(&local))
        .cloned()
        .unwrap_or_default();
    // Belt and braces: a "lead closed" recorded under ANY key of the
    // session (local, dbId, id passed by the renderer) wins. Better a
    // lead that stays closed than a main that reappears on its own.
    if !meta.lead_closed {
        meta.lead_closed = [Some(local.as_str()), db.as_deref(), Some(session_id)]
            .into_iter()
            .flatten()
            .any(|k| map.get(k).is_some_and(|m| m.lead_closed));
    }
    meta
}

/// Called as soon as the local store assigns the dbId to a session created in this
/// run: immediately moves the meta from the local id (which changes on restart) to the dbId.
/// Without it, a lead closed before the sync was lost on restart and the main
/// reappeared.
pub fn adopt_db_id(local: &str, db: &str) {
    let mut map = store().lock();
    *map = load_from_disk();
    if migrate_local_key(&mut map, local, Some(db)) {
        persist(&map);
    }
}

/// Read by the wake (session.rs) and by the restore stash poll (subagent.rs).
pub fn is_lead_closed(manager: &SessionManager, session_id: &str) -> bool {
    meta_for(manager, session_id).lead_closed
}

fn update<F: FnOnce(&mut AgentsMeta)>(
    manager: &SessionManager,
    session_id: &str,
    f: F,
) -> AgentsMeta {
    let (local, db) = meta_keys(manager, session_id);
    let mut map = store().lock();
    // The file is shared between instances (installed app + dev build): start again from
    // disk before writing, or one instance's stale map would wipe out
    // the closures made by the other.
    *map = load_from_disk();
    migrate_local_key(&mut map, &local, db.as_deref());
    let entry = map.entry(db.unwrap_or(local)).or_default();
    f(entry);
    let out = entry.clone();
    persist(&map);
    out
}

fn emit_changed(app: &tauri::AppHandle, session_id: &str, meta: &AgentsMeta) {
    let _ = app.emit(
        "agents:changed",
        serde_json::json!({ "sessionId": session_id, "meta": meta }),
    );
}

#[tauri::command]
pub fn agents_meta_get(
    manager: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> AgentsMeta {
    meta_for(&manager, &session_id)
}

#[tauri::command]
pub fn agents_set_lead(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    lead_id: Option<String>,
    lead_key: Option<String>,
) -> AgentsMeta {
    let meta = update(&manager, &session_id, |m| {
        // With no chosen lead, no identity is left dangling.
        m.lead_key = lead_id.as_ref().and(lead_key);
        m.lead_id = lead_id;
    });
    emit_changed(&app, &session_id, &meta);
    meta
}

#[tauri::command]
pub fn agents_set_order(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    order: Vec<String>,
) -> AgentsMeta {
    let meta = update(&manager, &session_id, |m| m.order = order);
    emit_changed(&app, &session_id, &meta);
    meta
}

/// Closes the session PTY (the lead) leaving the sub-agents alive. The flag must
/// be written BEFORE the kill: if a concurrent wake arrived in between it must not
/// respawn the PTY that was just closed.
#[tauri::command]
pub async fn agents_close_lead(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<AgentsMeta, String> {
    let mgr = manager.inner().clone();
    let meta = update(&mgr, &session_id, |m| m.lead_closed = true);
    let app2 = app.clone();
    let sid = session_id.clone();
    // spawn_blocking: killing the child may wait (same as standby).
    tauri::async_runtime::spawn_blocking(move || mgr.close_own_pty(&app2, &sid))
        .await
        .map_err(|e| e.to_string())?;
    emit_changed(&app, &session_id, &meta);
    Ok(meta)
}

/// Reopens the lead: revokes the flag and respawns the session PTY reusing the
/// wake (provider check + conversation resume). The only way back —
/// no automation reopens a closed lead.
#[tauri::command]
pub async fn agents_reopen_lead(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SessionManager>>,
    session_id: String,
    on_output: Channel<InvokeResponseBody>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<Option<SessionSummary>, String> {
    let mgr = manager.inner().clone();
    let meta = update(&mgr, &session_id, |m| m.lead_closed = false);
    emit_changed(&app, &session_id, &meta);
    let app2 = app.clone();
    let sid = session_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        mgr.mark_for_respawn(&sid);
        crate::commands::session::wake_session_impl(&app2, &mgr, &sid, on_output, cols, rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Self-healing kill-switch: if the webapp starts with the agents model OFF
/// (`promptops_agents_v2=off`) it revokes every `lead_closed`, so the classic
/// flow sees all the mains again on the next wake (respawn + resume) instead
/// of a black terminal on a session whose PTY was killed.
#[tauri::command]
pub fn agents_clear_lead_closed_all() -> usize {
    let mut map = store().lock();
    *map = load_from_disk();
    let mut n = 0usize;
    for meta in map.values_mut() {
        if meta.lead_closed {
            meta.lead_closed = false;
            n += 1;
        }
    }
    if n > 0 {
        persist(&map);
    }
    n
}
