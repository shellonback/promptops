//! Workspace / window-state — five IPC domains in a single Tauri 2 command module:
//!   - workspace         → folder selection + recents (encrypted local store)
//!   - device-workspace  → per-device workspace binding (local store)
//!   - desktop-state     → desktop UI state (encrypted local store)
//!   - app settings      → toggle "launch at login"
//!   - focus             → focus tracker (session/sub-agent)
//! Plus: emission of presence:system-away / presence:system-active
//! via OS idle/power monitor → see the TODO in `emit_presence_away`.
//!
//! IPC channel → Tauri command mapping (snake_case):
//!   workspace:select               -> workspace_select
//!   workspace:recent               -> workspace_recent
//!   device-workspace:get           -> device_workspace_get
//!   device-workspace:list          -> device_workspace_list
//!   device-workspace:upsert        -> device_workspace_upsert
//!   device-workspace:update        -> device_workspace_update
//!   device-workspace:delete        -> device_workspace_delete
//!   device-workspace:migrate       -> device_workspace_migrate
//!   device-workspace:validate-path -> device_workspace_validate_path
//!   desktop-state:save             -> desktop_state_save
//!   desktop-state:get              -> desktop_state_get
//!   app:get-auto-launch            -> app_get_auto_launch
//!   app:set-auto-launch            -> app_set_auto_launch
//!   focus:set-active               -> focus_set_active
//!   focus:get-active               -> focus_get_active
//! Push events (main→renderer):
//!   focus:active-changed           -> AppHandle::emit("focus:active-changed", FocusState)
//!   presence:system-away           -> AppHandle::emit("presence:system-away", reason)  [TODO]
//!   presence:system-active         -> AppHandle::emit("presence:system-active", reason) [TODO]
//!
//! Self-contained: does not touch mod.rs / lib.rs / Cargo.toml. lib.rs only needs to
//! `.manage(Arc::new(...))` the States below and register the commands.
//! tauri-plugin-autostart must be initialized in lib.rs for app_*_auto_launch.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

// ─────────────────────────────────────────────────────────────────────────
// Constants.
// ─────────────────────────────────────────────────────────────────────────

/// MAX_RECENT: cap of the recents list.
const MAX_RECENT: usize = 10;

// ─────────────────────────────────────────────────────────────────────────
// Shared DTOs.
// ─────────────────────────────────────────────────────────────────────────

/// WorkspaceBinding: { path, name }.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct WorkspaceBinding {
    pub path: String,
    pub name: String,
}

// ═════════════════════════════════════════════════════════════════════════
//  workspace:* — folder selection + recents list
//  Kept in the encrypted local store (folder paths are personal). Older
//  builds wrote `workspaces.json` in clear text: it is read once, moved into
//  the store and removed.
// ═════════════════════════════════════════════════════════════════════════

/// Shape of the recents record (and of the legacy `workspaces.json`).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct WorkspaceStore {
    #[serde(rename = "recentWorkspaces", default)]
    recent_workspaces: Vec<WorkspaceBinding>,
}

/// Local store collection and ids of the small UI state records.
const UI_STATE: &str = "ui_state";
const RECENTS_ID: &str = "recent-workspaces";
const DESKTOP_STATE_ID: &str = "desktop-state";

/// Legacy clear-text recents file: `<data_dir>/workspaces.json`.
fn legacy_workspace_store_path() -> PathBuf {
    crate::commands::hook::hook_data_dir().join("workspaces.json")
}

/// Serializes read-modify-write of the recents (two windows picking folders).
static RECENTS_LOCK: Mutex<()> = Mutex::new(());

fn load_recents_in(store: &crate::local_store::LocalStore, legacy: &Path) -> WorkspaceStore {
    if let Some(v) = store.get(UI_STATE, RECENTS_ID) {
        return serde_json::from_value(v).unwrap_or_default();
    }
    // First run after an update: move the clear-text file into the store.
    let Ok(bytes) = std::fs::read(legacy) else {
        return WorkspaceStore::default();
    };
    let Ok(parsed) = serde_json::from_slice::<WorkspaceStore>(&bytes) else {
        // Not ours to delete when we cannot read it.
        return WorkspaceStore::default();
    };
    if let Ok(v) = serde_json::to_value(&parsed) {
        if store.put(UI_STATE, RECENTS_ID, v).is_ok() {
            let _ = std::fs::remove_file(legacy);
        }
    }
    parsed
}

fn load_workspace_store(_app: &tauri::AppHandle) -> WorkspaceStore {
    match crate::local_store::get() {
        Some(store) => load_recents_in(store, &legacy_workspace_store_path()),
        None => WorkspaceStore::default(),
    }
}

/// Puts `workspace` at the top of the recents (dedup by path, cap MAX_RECENT).
fn remember_recent_in(
    store: &crate::local_store::LocalStore,
    legacy: &Path,
    workspace: &WorkspaceBinding,
) -> Result<(), String> {
    let _guard = RECENTS_LOCK.lock();
    let mut recents = load_recents_in(store, legacy);
    recents
        .recent_workspaces
        .retain(|w| w.path != workspace.path);
    recents.recent_workspaces.insert(0, workspace.clone());
    recents.recent_workspaces.truncate(MAX_RECENT);
    let v = serde_json::to_value(&recents).map_err(|e| e.to_string())?;
    store.put(UI_STATE, RECENTS_ID, v)
}

fn remember_recent(workspace: &WorkspaceBinding) {
    if let Some(store) = crate::local_store::get() {
        if let Err(err) = remember_recent_in(store, &legacy_workspace_store_path(), workspace) {
            eprintln!("[workspace] recents not saved: {err}");
        }
    }
}

/// workspace:select — opens the "Select Workspace Directory" dialog, adds the
/// chosen folder at the top of the recents (dedup by path, cap MAX_RECENT) and
/// returns it. Returns `None` if the user cancels.
#[tauri::command]
pub async fn workspace_select(app: tauri::AppHandle) -> Result<Option<WorkspaceBinding>, String> {
    // dialog.showOpenDialog({ properties: ['openDirectory'] }).
    // NON-blocking picker: `blocking_pick_folder()` from a sync command runs on the
    // main thread and deadlocks with the main loop that has to draw the dialog
    // (freeze on macOS). Here the command is async and waits on a oneshot while the
    // dialog runs on the main loop without blocking it.
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Select Workspace Directory")
        .pick_folder(move |fp| {
            let _ = tx.send(fp);
        });
    let picked = rx.await.map_err(|e| e.to_string())?;

    let Some(folder) = picked else {
        // result.canceled || filePaths.length === 0 → return null
        return Ok(None);
    };

    // FilePath → absolute path (string).
    let dir_path = match folder.into_path() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => return Ok(None),
    };

    // name = path.basename(dirPath) || dirPath
    let name = PathBuf::from(&dir_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| dir_path.clone());

    let workspace = WorkspaceBinding {
        path: dir_path.clone(),
        name,
    };

    // Add to recent workspaces (best-effort: a failed save is logged).
    remember_recent(&workspace);

    // The "Recent Workspaces" submenu of the native menu reads from the same store:
    // rebuilding it here saves every caller of workspace:select from having to
    // remember it (there are 6 different places on the Angular side).
    let _ = crate::commands::menu::refresh(&app);

    Ok(Some(workspace))
}

/// workspace:recent — returns the list of recent workspaces.
#[tauri::command]
pub fn workspace_recent(app: tauri::AppHandle) -> Vec<WorkspaceBinding> {
    load_workspace_store(&app).recent_workspaces
}

// ═════════════════════════════════════════════════════════════════════════
//  device-workspace:* — per-device workspace binding (local store)
//  Every handler returns a { ok, ... } envelope.
// ═════════════════════════════════════════════════════════════════════════

/// DeviceWorkspaceDto — snake_case fields of the stored record.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeviceWorkspaceDto {
    pub id: String,
    pub session_id: String,
    pub device_id: String,
    pub local_path: String,
    pub updated_at: String,
}

/// This device's id, set at start; device workspaces are keyed on it.
#[derive(Default)]
pub struct DeviceWorkspaceState {
    inner: Mutex<DeviceWorkspaceCreds>,
}

#[derive(Default, Clone)]
struct DeviceWorkspaceCreds {
    device_id: Option<String>,
}

impl DeviceWorkspaceState {
    pub fn new() -> Self {
        Self::default()
    }

    /// getDeviceId() — the bootstrap registers it.
    pub fn set_device_id(&self, device_id: Option<String>) {
        self.inner.lock().device_id = device_id;
    }

    fn snapshot(&self) -> DeviceWorkspaceCreds {
        self.inner.lock().clone()
    }
}

/// { ok: true, deviceWorkspace } / { ok: false, error }.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWorkspaceResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_workspace: Option<DeviceWorkspaceDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// { ok: true, deviceWorkspaces } / { ok: false, error }.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWorkspaceListResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_workspaces: Option<Vec<DeviceWorkspaceDto>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// { ok: true } / { ok: false, error } — delete.
#[derive(Serialize)]
pub struct OkResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// { ok, migrated, total } / { ok: false, error } — migrate.
#[derive(Serialize)]
pub struct MigrateResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migrated: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// { ok: true, valid, exists, isDirectory } — validate-path.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatePathResult {
    pub ok: bool,
    pub valid: bool,
    pub exists: bool,
    pub is_directory: bool,
}

// NB: all device_workspace_* read and write the local store synchronously, so
// they are async commands running on spawn_blocking, off the main thread.

/// device-workspace:get — { sessionId } → this device's folder for the session.
#[tauri::command]
pub async fn device_workspace_get(
    state: tauri::State<'_, Arc<DeviceWorkspaceState>>,
    session_id: String,
) -> Result<DeviceWorkspaceResult, String> {
    let creds = state.snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(device_id) = creds.device_id.clone() else {
            return DeviceWorkspaceResult {
                ok: false,
                device_workspace: None,
                error: Some("device id not available".into()),
            };
        };
        match dw_call(
            "deviceWorkspaces.get",
            serde_json::json!({ "session_id": session_id, "device_id": device_id }),
        ) {
            Ok(res) => DeviceWorkspaceResult {
                ok: true,
                device_workspace: extract_device_workspace(&res),
                error: None,
            },
            Err(err) => DeviceWorkspaceResult {
                ok: false,
                device_workspace: None,
                error: Some(err),
            },
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// device-workspace:list — every folder binding of this device.
#[tauri::command]
pub async fn device_workspace_list(
    state: tauri::State<'_, Arc<DeviceWorkspaceState>>,
) -> Result<DeviceWorkspaceListResult, String> {
    let creds = state.snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(device_id) = creds.device_id.clone() else {
            return DeviceWorkspaceListResult {
                ok: false,
                device_workspaces: None,
                error: Some("device id not available".into()),
            };
        };
        match dw_call(
            "deviceWorkspaces.forDevice",
            serde_json::json!({ "device_id": device_id }),
        ) {
            Ok(res) => DeviceWorkspaceListResult {
                ok: true,
                device_workspaces: Some(extract_device_workspaces(&res)),
                error: None,
            },
            Err(err) => DeviceWorkspaceListResult {
                ok: false,
                device_workspaces: None,
                error: Some(err),
            },
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// device-workspace:upsert — { sessionId, localPath } for this device.
#[tauri::command]
pub async fn device_workspace_upsert(
    state: tauri::State<'_, Arc<DeviceWorkspaceState>>,
    session_id: String,
    local_path: String,
) -> Result<DeviceWorkspaceResult, String> {
    let creds = state.snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(device_id) = creds.device_id.clone() else {
            return DeviceWorkspaceResult {
                ok: false,
                device_workspace: None,
                error: Some("device id not available".into()),
            };
        };
        let body = serde_json::json!({
            "session_id": session_id,
            "device_id": device_id,
            "local_path": local_path,
        });
        match dw_call("deviceWorkspaces.upsert", body) {
            Ok(res) => DeviceWorkspaceResult {
                ok: true,
                device_workspace: extract_device_workspace(&res),
                error: None,
            },
            Err(err) => DeviceWorkspaceResult {
                ok: false,
                device_workspace: None,
                error: Some(err),
            },
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// device-workspace:update — { id, localPath }.
#[tauri::command]
pub async fn device_workspace_update(
    _state: tauri::State<'_, Arc<DeviceWorkspaceState>>,
    id: String,
    local_path: String,
) -> Result<DeviceWorkspaceResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let body = serde_json::json!({ "id": id, "local_path": local_path });
        match dw_call("deviceWorkspaces.update", body) {
            Ok(res) => DeviceWorkspaceResult {
                ok: true,
                device_workspace: extract_device_workspace(&res),
                error: None,
            },
            Err(err) => DeviceWorkspaceResult {
                ok: false,
                device_workspace: None,
                error: Some(err),
            },
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// device-workspace:delete — { id }.
#[tauri::command]
pub async fn device_workspace_delete(
    _state: tauri::State<'_, Arc<DeviceWorkspaceState>>,
    id: String,
) -> Result<OkResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match dw_call("deviceWorkspaces.delete", serde_json::json!({ "id": id })) {
            Ok(_) => OkResult {
                ok: true,
                error: None,
            },
            Err(err) => OkResult {
                ok: false,
                error: Some(err),
            },
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// device-workspace:migrate — gives legacy sessions a device workspace here.
#[tauri::command]
pub async fn device_workspace_migrate(
    state: tauri::State<'_, Arc<DeviceWorkspaceState>>,
) -> Result<MigrateResult, String> {
    let creds = state.snapshot();
    tauri::async_runtime::spawn_blocking(move || device_workspace_migrate_blocking(&creds))
        .await
        .map_err(|e| e.to_string())
}

fn device_workspace_migrate_blocking(creds: &DeviceWorkspaceCreds) -> MigrateResult {
    let Some(device_id) = creds.device_id.clone() else {
        return MigrateResult {
            ok: false,
            migrated: None,
            total: None,
            error: Some("device id not available".into()),
        };
    };
    let body = serde_json::json!({ "device_id": device_id });
    match dw_call("deviceWorkspaces.migrateLegacy", body) {
        Ok(res) => {
            let migrated = res.get("migrated").and_then(|v| v.as_u64()).unwrap_or(0);
            let total = res.get("total").and_then(|v| v.as_u64()).unwrap_or(0);
            MigrateResult {
                ok: true,
                migrated: Some(migrated),
                total: Some(total),
                error: None,
            }
        }
        Err(err) => MigrateResult {
            ok: false,
            migrated: None,
            total: None,
            error: Some(err),
        },
    }
}

/// device-workspace:validate-path — { localPath } → existsSync + statSync.isDirectory.
/// The error does not propagate: it always returns ok:true with valid:false.
#[tauri::command]
pub fn device_workspace_validate_path(local_path: String) -> ValidatePathResult {
    match std::fs::metadata(&local_path) {
        Ok(meta) => {
            let is_directory = meta.is_dir();
            ValidatePathResult {
                ok: true,
                valid: is_directory,
                exists: true,
                is_directory,
            }
        }
        Err(_) => ValidatePathResult {
            ok: true,
            valid: false,
            exists: false,
            is_directory: false,
        },
    }
}

/// A device workspace record (null when there is none).
fn extract_device_workspace(res: &JsonValue) -> Option<DeviceWorkspaceDto> {
    serde_json::from_value(res.clone()).ok()
}

/// A list of device workspace records (default empty list).
fn extract_device_workspaces(res: &JsonValue) -> Vec<DeviceWorkspaceDto> {
    serde_json::from_value(res.clone()).unwrap_or_default()
}

/// Runs a device workspace method of the local store (`local_data.rs`).
fn dw_call(method: &str, params: JsonValue) -> Result<JsonValue, String> {
    crate::local_data::call(method, params).map_err(|e| e.to_string())
}

// ═════════════════════════════════════════════════════════════════════════
//  desktop-state:* — desktop UI state (last active session, sub-agent panel)
//  Kept in the encrypted local store: the session name is personal.
//  `desktop-state.json` in the app data dir is the legacy clear-text home of
//  these fields; old context-transfer preferences left there are moved into
//  the store by smart_context.rs.
// ═════════════════════════════════════════════════════════════════════════

/// DesktopState — camelCase fields identical to the file. Missing fields take
/// their defaults, so an older or partial record still loads.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopState {
    pub active_session_name: Option<String>,
    pub sub_agents_expanded: bool,
    pub focused_sub_agent_role: Option<String>,
    pub saved_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_launch_default_applied: Option<bool>,
}

/// Payload of desktop-state:save (the three fields sent by the renderer).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStateSavePayload {
    pub active_session_name: Option<String>,
    pub sub_agents_expanded: bool,
    pub focused_sub_agent_role: Option<String>,
}

/// Fields of the legacy file that now live in the store.
const MOVED_KEYS: &[&str] = &[
    "activeSessionName",
    "subAgentsExpanded",
    "focusedSubAgentRole",
];

/// `<app_data_dir>/desktop-state.json` (legacy + context-transfer prefs).
fn desktop_state_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("desktop-state.json"))
}

fn read_legacy_state(legacy: &Path) -> Option<JsonValue> {
    let raw = std::fs::read(legacy).ok()?;
    serde_json::from_slice::<JsonValue>(&raw)
        .ok()
        .filter(JsonValue::is_object)
}

/// Removes the moved fields from the legacy file, keeping what other modules
/// still keep there; the file goes when nothing else is left.
fn scrub_legacy_state(legacy: &Path) {
    let Some(mut v) = read_legacy_state(legacy) else {
        return;
    };
    let Some(obj) = v.as_object_mut() else {
        return;
    };
    if !MOVED_KEYS.iter().any(|k| obj.contains_key(*k)) {
        return;
    }
    for k in MOVED_KEYS {
        obj.remove(*k);
    }
    if obj.keys().all(|k| k == "savedAt") {
        let _ = std::fs::remove_file(legacy);
    } else if let Ok(body) = serde_json::to_vec_pretty(&v) {
        let _ = crate::local_store::replace_file_private(legacy, &body);
    }
}

/// The state: the store record (moving the legacy fields in on first use),
/// with the preferences other modules keep in the legacy file.
fn load_desktop_state_in(
    store: &crate::local_store::LocalStore,
    legacy: Option<&Path>,
) -> Option<DesktopState> {
    let legacy_value = legacy.and_then(read_legacy_state);
    let mut state: Option<DesktopState> = store
        .get(UI_STATE, DESKTOP_STATE_ID)
        .and_then(|v| serde_json::from_value(v).ok());
    if state.is_none() {
        if let Some(old) = legacy_value
            .as_ref()
            .filter(|v| MOVED_KEYS.iter().any(|k| v.get(*k).is_some()))
        {
            let moved: DesktopState = serde_json::from_value(old.clone()).unwrap_or_default();
            if let Ok(v) = serde_json::to_value(&moved) {
                if store.put(UI_STATE, DESKTOP_STATE_ID, v).is_ok() {
                    if let Some(path) = legacy {
                        scrub_legacy_state(path);
                    }
                }
            }
            state = Some(moved);
        }
    }
    // The context-transfer preferences left in the legacy file belong to
    // smart_context.rs, which moves them into the store on first use.
    state
}

fn save_desktop_state_in(
    store: &crate::local_store::LocalStore,
    legacy: Option<&Path>,
    data: DesktopStateSavePayload,
) -> Result<(), String> {
    let mut state: DesktopState = store
        .get(UI_STATE, DESKTOP_STATE_ID)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    // Override of the three received fields, preserving autoLaunchDefaultApplied.
    state.active_session_name = data.active_session_name;
    state.sub_agents_expanded = data.sub_agents_expanded;
    state.focused_sub_agent_role = data.focused_sub_agent_role;
    state.saved_at = now_iso();
    let v = serde_json::to_value(&state).map_err(|e| e.to_string())?;
    store.put(UI_STATE, DESKTOP_STATE_ID, v)?;
    if let Some(path) = legacy {
        scrub_legacy_state(path);
    }
    Ok(())
}

/// desktop-state:save — merge over the existing state + savedAt = now.
#[tauri::command]
pub fn desktop_state_save(
    app: tauri::AppHandle,
    data: DesktopStateSavePayload,
) -> Result<OkResult, String> {
    let store =
        crate::local_store::get().ok_or_else(|| "The local store is not available.".to_string())?;
    save_desktop_state_in(store, desktop_state_path(&app).as_deref(), data)?;
    Ok(OkResult {
        ok: true,
        error: None,
    })
}

/// desktop-state:get — the saved state (null if there is none).
#[tauri::command]
pub fn desktop_state_get(app: tauri::AppHandle) -> Option<DesktopState> {
    let store = crate::local_store::get()?;
    load_desktop_state_in(store, desktop_state_path(&app).as_deref())
}

// ═════════════════════════════════════════════════════════════════════════
//  app:*-auto-launch — toggle "launch at login"
//  via tauri-plugin-autostart.
// ═════════════════════════════════════════════════════════════════════════

/// { ok: true, enabled } — response of app:set-auto-launch.
#[derive(Serialize)]
pub struct AutoLaunchResult {
    pub ok: bool,
    pub enabled: bool,
}

/// app:get-auto-launch — app.getLoginItemSettings().openAtLogin.
///
/// Implemented with tauri-plugin-autostart (`AutoLaunchManager::is_enabled`). The plugin
/// must be initialized in lib.rs:
///   `.plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))`
#[tauri::command]
pub fn app_get_auto_launch(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// app:set-auto-launch — app.setLoginItemSettings({ openAtLogin: enabled }).
///
/// Implemented with tauri-plugin-autostart enable()/disable(). On macOS the
/// `openAsHidden` option (launch without stealing focus) is not exposed by the plugin →
/// TODO: launch hidden on macOS is not implemented.
#[tauri::command]
pub fn app_set_auto_launch(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<AutoLaunchResult, String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        manager.disable().map_err(|e| e.to_string())?;
    }
    Ok(AutoLaunchResult { ok: true, enabled })
}

// ═════════════════════════════════════════════════════════════════════════
//  focus:* — focus tracker (session / sub-agent)
// ═════════════════════════════════════════════════════════════════════════

/// FocusState.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FocusState {
    pub session_id: Option<String>,
    /// 1-based slot of the focused sub-agent, or null for the main terminal.
    pub sub_agent_slot: Option<u32>,
    pub sub_agent_id: Option<String>,
}

/// WriteTarget — active write destination.
#[derive(Clone, Debug, Serialize)]
pub struct WriteTarget {
    #[serde(rename = "type")]
    pub kind: String, // 'session' | 'subagent'
    pub id: String,
}

/// Patch of focus:set-active. The three fields are optional; `Option<Option<_>>`
/// distinguishes "missing" (no change) from "explicit null" (clear):
/// `patch.subAgentSlot === null` forces the main terminal.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusPatch {
    #[serde(default)]
    pub session_id: Option<Option<String>>,
    #[serde(default)]
    pub sub_agent_slot: Option<Option<u32>>,
    #[serde(default)]
    pub sub_agent_id: Option<Option<String>>,
}

/// { ok: true, state } / { ok: false, error }.
#[derive(Serialize)]
pub struct FocusResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<FocusState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Slot↔sub-agent resolver: lists the sub-agents of a session
/// (order = createdAt ASC). It is abstracted with a closure registrable by the
/// sub-agent module, so this file stays self-contained.
type SubAgentResolver = Arc<dyn Fn(&str) -> Vec<String> + Send + Sync>;

/// FocusManager — stateful focus tracker.
pub struct FocusManager {
    state: Mutex<FocusState>,
    /// Closure: parentSessionId → sub-agent IDs sorted by createdAt ASC.
    resolver: Mutex<Option<SubAgentResolver>>,
}

impl Default for FocusManager {
    fn default() -> Self {
        Self::new()
    }
}

impl FocusManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(FocusState::default()),
            resolver: Mutex::new(None),
        }
    }

    /// getActive() — copy of the current state.
    pub fn get_active(&self) -> FocusState {
        self.state.lock().clone()
    }

    /// listByParent(parentId) sorted; empty if there is no resolver.
    fn sorted_sub_agents(&self, parent_session_id: &str) -> Vec<String> {
        match &*self.resolver.lock() {
            Some(r) => r(parent_session_id),
            None => Vec::new(),
        }
    }

    /// subAgentForSlot(parentId, slot) — slot 1-based → id.
    fn sub_agent_for_slot(&self, parent_session_id: Option<&str>, slot: u32) -> Option<String> {
        let parent = parent_session_id?;
        if slot < 1 {
            return None;
        }
        let sorted = self.sorted_sub_agents(parent);
        sorted.get((slot - 1) as usize).cloned()
    }

    /// slotForSubAgent(parentId, id) — id → slot 1-based.
    fn slot_for_sub_agent(
        &self,
        parent_session_id: Option<&str>,
        sub_agent_id: &str,
    ) -> Option<u32> {
        let parent = parent_session_id?;
        let sorted = self.sorted_sub_agents(parent);
        sorted
            .iter()
            .position(|id| id == sub_agent_id)
            .map(|idx| (idx + 1) as u32)
    }

    /// setActive(patch) — exact replica of the FocusTracker.setActive logic.
    /// Returns `(next, changed)`: changed=false if the state did not change.
    pub fn set_active(&self, patch: &FocusPatch) -> (FocusState, bool) {
        let prev = self.state.lock().clone();

        // sessionId: patch !== undefined ? patch : prev
        let next_session = match &patch.session_id {
            Some(v) => v.clone(),
            None => prev.session_id.clone(),
        };

        // Reproduces the exact order of the ifs in FocusTracker.setActive.
        // Patch representation: Some(Some(_)) = explicit value, Some(None) =
        // explicit null, None = missing field (undefined).
        let explicit_id = match &patch.sub_agent_id {
            Some(Some(id)) => Some(id.clone()), // patch.subAgentId truthy
            _ => None,
        };
        let explicit_slot = match patch.sub_agent_slot {
            Some(Some(slot)) if slot >= 1 => Some(slot), // number && >= 1
            _ => None,
        };
        let is_explicit_clear =
            matches!(patch.sub_agent_slot, Some(None)) || matches!(patch.sub_agent_id, Some(None));

        let (next_slot, next_id) = if let Some(sa_id) = explicit_id {
            // Explicit ID wins over slot.
            let slot = self.slot_for_sub_agent(next_session.as_deref(), &sa_id);
            (slot, Some(sa_id))
        } else if let Some(slot) = explicit_slot {
            // typeof subAgentSlot === 'number' && >= 1
            let resolved = self.sub_agent_for_slot(next_session.as_deref(), slot);
            (Some(slot), resolved)
        } else if is_explicit_clear {
            // Explicit clear: focus back on main terminal.
            (None, None)
        } else {
            // No sub-agent change: preserve existing.
            (prev.sub_agent_slot, prev.sub_agent_id.clone())
        };

        let next = FocusState {
            session_id: next_session,
            sub_agent_slot: next_slot,
            sub_agent_id: next_id,
        };

        if next == prev {
            return (prev, false);
        }
        *self.state.lock() = next.clone();
        (next, true)
    }

    /// getWriteTarget() — current write destination.
    #[allow(dead_code)]
    pub fn get_write_target(&self) -> Option<WriteTarget> {
        let s = self.state.lock();
        if let Some(id) = &s.sub_agent_id {
            Some(WriteTarget {
                kind: "subagent".into(),
                id: id.clone(),
            })
        } else {
            s.session_id.as_ref().map(|id| WriteTarget {
                kind: "session".into(),
                id: id.clone(),
            })
        }
    }
}

/// focus:get-active — { ok, state }.
#[tauri::command]
pub fn focus_get_active(focus: tauri::State<'_, Arc<FocusManager>>) -> FocusResult {
    FocusResult {
        ok: true,
        state: Some(focus.get_active()),
        error: None,
    }
}

/// focus:set-active — applies the patch and, if it changes, emits focus:active-changed.
#[tauri::command]
pub fn focus_set_active(
    app: tauri::AppHandle,
    focus: tauri::State<'_, Arc<FocusManager>>,
    patch: Option<FocusPatch>,
) -> FocusResult {
    let patch = patch.unwrap_or_default();
    let (state, changed) = focus.set_active(&patch);
    // FocusTracker emits 'change' → focus-handlers forwards FOCUS_ACTIVE_CHANGED.
    if changed {
        let _ = app.emit("focus:active-changed", state.clone());
    }
    FocusResult {
        ok: true,
        state: Some(state),
        error: None,
    }
}

// ═════════════════════════════════════════════════════════════════════════
//  presence:* — away/active signals from the system (power/idle monitor)
// ═════════════════════════════════════════════════════════════════════════

/// Forwards the OS away/active signals to the renderer (presence:system-away/active).
/// Suspend/lock-screen/shutdown → away; resume/unlock-screen → active.
/// Call these helpers from the OS listeners.
///
/// TODO: Tauri/tao does not expose a cross-platform equivalent of
/// powerMonitor (suspend/resume/lock/unlock). A per-OS crate would be needed
/// (e.g. CGSession/IORegistry on macOS, WTSRegisterSessionNotification + power
/// broadcast on Windows, logind/DBus on Linux) to wire these events.
/// Until then, the emission must be triggered manually by whoever detects idle.
#[allow(dead_code)]
pub fn emit_presence_away(app: &tauri::AppHandle, reason: &str) {
    let _ = app.emit("presence:system-away", reason.to_string());
}

/// See `emit_presence_away`. TODO: same for the active triggers.
#[allow(dead_code)]
pub fn emit_presence_active(app: &tauri::AppHandle, reason: &str) {
    let _ = app.emit("presence:system-active", reason.to_string());
}

// ─────────────────────────────────────────────────────────────────────────
// Utility.
// ─────────────────────────────────────────────────────────────────────────

/// ISO-8601 timestamp in UTC (new Date().toISOString()), without extra dependencies
/// (Howard Hinnant's algorithm for epoch→civil date). Aligned with session.rs.
fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();
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

// ═════════════════════════════════════════════════════════════════════════
//  Context policy + WORKSPACE_CREATE_FOLDER + project brief reader
// ═════════════════════════════════════════════════════════════════════════

/// Root context file per provider (PROVIDER_ROOT_CONTEXT_FILES).
fn provider_root_context_files(provider: &str) -> &'static [&'static str] {
    match provider {
        "claude-code-cli" | "zai" | "kimi" | "promptops-cli" => &["CLAUDE.md"],
        "codex" | "opencode" | "muse" => &["AGENTS.md"],
        "gemini-cli" => &["GEMINI.md"],
        // agy reads both GEMINI.md and AGENTS.md (+ .agents/rules/).
        "antigravity" => &["GEMINI.md", "AGENTS.md"],
        _ => &[],
    }
}

/// contextFilesForProvider — CLAUDE.md always included (optimizer target).
fn context_files_for_provider(provider: &str) -> Vec<String> {
    let mut files = vec!["CLAUDE.md".to_string()];
    for f in provider_root_context_files(provider) {
        if !files.iter().any(|x| x == f) {
            files.push((*f).to_string());
        }
    }
    files
}

const PROMPTOPS_MARKER: &str = "<!-- PROMPTOPS:CONTEXT -->";
const PROMPTOPS_END_MARKER: &str = "<!-- /PROMPTOPS:CONTEXT -->";
const POLICY_REL_PATH: &str = ".promptops/context-policy.json";

/// stripPromptOpsBlock — removes the blocks managed by PromptOps. An opening
/// marker without a closing one does NOT match → content intact.
pub fn strip_promptops_block(content: &str) -> String {
    let mut out = String::new();
    let mut rest = content;
    while let Some(start) = rest.find(PROMPTOPS_MARKER) {
        let after = &rest[start..];
        match after.find(PROMPTOPS_END_MARKER) {
            Some(end_rel) => {
                out.push_str(&rest[..start]);
                let mut next = &after[end_rel + PROMPTOPS_END_MARKER.len()..];
                if let Some(stripped) = next.strip_prefix('\n') {
                    next = stripped;
                }
                rest = next;
            }
            None => {
                out.push_str(rest);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// readContextPolicy — { contextInjection, decidedAt, files? } or None.
fn read_context_policy(workspace_path: &str) -> Option<JsonValue> {
    let raw = std::fs::read_to_string(Path::new(workspace_path).join(POLICY_REL_PATH)).ok()?;
    let parsed: JsonValue = serde_json::from_str(&raw).ok()?;
    match parsed.get("contextInjection").and_then(|v| v.as_str()) {
        Some("allow") | Some("preserve") => Some(parsed),
        _ => None,
    }
}

/// detectCuratedContextFiles — context files with user content beyond the
/// PromptOps block. Unreadable = curated (stay safe).
fn detect_curated_context_files(workspace_path: &str, provider: &str) -> Vec<String> {
    let mut curated = Vec::new();
    for file_name in context_files_for_provider(provider) {
        let full = Path::new(workspace_path).join(&file_name);
        if !full.exists() {
            continue;
        }
        match std::fs::read_to_string(&full) {
            Ok(content) => {
                if !strip_promptops_block(&content).trim().is_empty() {
                    curated.push(file_name);
                }
            }
            Err(_) => curated.push(file_name),
        }
    }
    curated
}

/// workspace:context-file-check.
#[tauri::command]
pub fn workspace_context_file_check(path: String, provider: Option<String>) -> JsonValue {
    if path.is_empty() {
        return serde_json::json!({ "ok": false, "error": "missing path" });
    }
    let policy = read_context_policy(&path);
    let curated_files = detect_curated_context_files(&path, provider.as_deref().unwrap_or(""));
    serde_json::json!({
        "ok": true,
        "curatedFiles": curated_files,
        // Ask only when curated files exist and there is no decision yet.
        "needsDecision": !curated_files.is_empty() && policy.is_none(),
        "policy": policy.and_then(|p| p.get("contextInjection").cloned()),
    })
}

/// workspace:context-policy-set — persists the decision ('allow' | 'preserve').
#[tauri::command]
pub fn workspace_context_policy_set(
    path: String,
    mode: String,
    files: Option<Vec<String>>,
) -> JsonValue {
    if path.is_empty() || (mode != "allow" && mode != "preserve") {
        return serde_json::json!({ "ok": false, "error": "invalid payload" });
    }
    let dir = Path::new(&path).join(".promptops");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return serde_json::json!({ "ok": false, "error": e.to_string() });
    }
    let mut policy = serde_json::json!({
        "contextInjection": mode,
        "decidedAt": now_iso(),
    });
    if let Some(files) = files.filter(|f| !f.is_empty()) {
        policy["files"] = serde_json::json!(files);
    }
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(&policy).unwrap_or_default()
    );
    match std::fs::write(Path::new(&path).join(POLICY_REL_PATH), body) {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

/// workspace:create-folder — creates a new folder under the chosen parent and
/// returns it as a workspace binding ("create folder" flow of the pickers).
#[tauri::command]
pub fn workspace_create_folder(
    app: tauri::AppHandle,
    parent_path: String,
    folder_name: String,
) -> JsonValue {
    let parent_path = parent_path.trim();
    let folder_name = folder_name.trim();
    if parent_path.is_empty() || folder_name.is_empty() {
        return serde_json::json!({ "ok": false, "error": "missing parent path or folder name" });
    }
    // A single segment: no separators or traversal.
    let is_single_segment = Path::new(folder_name)
        .file_name()
        .map(|b| b == std::ffi::OsStr::new(folder_name))
        .unwrap_or(false);
    if !is_single_segment || folder_name == "." || folder_name == ".." {
        return serde_json::json!({ "ok": false, "error": "invalid folder name" });
    }
    if folder_name
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\' | '/'))
    {
        return serde_json::json!({ "ok": false, "error": "invalid folder name" });
    }
    let parent = Path::new(parent_path);
    if !parent.is_dir() {
        return serde_json::json!({ "ok": false, "error": "parent path does not exist" });
    }
    let full_path = parent.join(folder_name);
    if full_path.exists() {
        // Reuse an existing directory, never a file.
        if !full_path.is_dir() {
            return serde_json::json!({ "ok": false, "error": "a file with that name already exists" });
        }
    } else if let Err(e) = std::fs::create_dir_all(&full_path) {
        return serde_json::json!({ "ok": false, "error": e.to_string() });
    }

    let workspace = WorkspaceBinding {
        path: full_path.to_string_lossy().into_owned(),
        name: folder_name.to_string(),
    };

    // Update the recents (dedup by path, unshift, cap MAX_RECENT).
    let _ = &app;
    remember_recent(&workspace);

    serde_json::json!({ "ok": true, "workspace": workspace })
}

// ─────────────────────────────────────────────────────────────────────────
// Project brief reader — read-only aggregation of agent memories.
// No disk writes: memories stay local.
// ─────────────────────────────────────────────────────────────────────────

const EXCERPT_MAX_CHARS: usize = 2200;
const ACTIVITY_MAX_ENTRIES: usize = 8;
const ACTIVITY_CONTENT_MAX: usize = 240;
const MEMORY_FALLBACK_MAX_FILES: usize = 40;
const AI_SOURCE_MAX_CHARS: usize = 12_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefContextFile {
    pub file_name: String,
    pub curated: bool,
    pub excerpt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct BriefMemoryEntry {
    pub title: String,
    pub hook: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefActivityEntry {
    pub category: String,
    pub content: String,
    pub timestamp: i64,
    pub related_files: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefAgentMemories {
    pub dir: Option<String>,
    pub entries: Vec<BriefMemoryEntry>,
    pub file_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBriefData {
    pub workspace_path: String,
    pub project_name: String,
    pub generated_at: String,
    pub frameworks: Vec<String>,
    pub languages: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub context_files: Vec<BriefContextFile>,
    pub agent_memories: BriefAgentMemories,
    pub recent_activity: Vec<BriefActivityEntry>,
    pub ai_source: String,
}

/// All root context files of every supported provider.
fn root_context_file_names() -> Vec<String> {
    let mut names = vec!["CLAUDE.md".to_string()];
    for provider in ["claude-code-cli", "codex", "gemini-cli"] {
        for f in provider_root_context_files(provider) {
            if !names.iter().any(|x| x == f) {
                names.push((*f).to_string());
            }
        }
    }
    names
}

/// claudeProjectDirName — every char outside [A-Za-z0-9] becomes '-'.
pub fn claude_project_dir_name(workspace_path: &str) -> String {
    workspace_path
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Char-safe truncation with ellipsis.
fn truncate_chars(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(max).collect();
    format!("{}…", cut.trim_end())
}

/// parseMemoryIndex — lines `- [Title](file.md) — hook` (bullet -/*, various dashes).
fn parse_memory_index(markdown: &str) -> Vec<BriefMemoryEntry> {
    use regex::Regex;
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^\s*[-*]\s*\[([^\]]+)\]\(([^)]*)\)\s*(?:[—–-]\s*)?(.*)$").unwrap()
    });
    markdown
        .lines()
        .filter_map(|line| {
            let m = re.captures(line)?;
            let file = m[2].trim().to_string();
            Some(BriefMemoryEntry {
                title: m[1].trim().to_string(),
                hook: m[3].trim().to_string(),
                file: if file.is_empty() { None } else { Some(file) },
            })
        })
        .collect()
}

/// parseMemoryFrontmatter — name/description from the YAML frontmatter.
fn parse_memory_frontmatter(markdown: &str) -> (Option<String>, Option<String>) {
    use regex::Regex;
    use std::sync::OnceLock;
    static FM: OnceLock<Regex> = OnceLock::new();
    let fm = FM.get_or_init(|| Regex::new(r"(?s)^---\n(.*?)\n---").unwrap());
    let Some(body) = fm.captures(markdown).map(|m| m[1].to_string()) else {
        return (None, None);
    };
    let pick = |key: &str| -> Option<String> {
        let re = Regex::new(&format!(r"(?m)^{key}:\s*(.+)$")).ok()?;
        re.captures(&body).map(|m| {
            m[1].trim()
                .trim_matches(|c| c == '\'' || c == '"')
                .to_string()
        })
    };
    (pick("name"), pick("description"))
}

fn brief_context_files(workspace_path: &str) -> Vec<BriefContextFile> {
    let mut files = Vec::new();
    for file_name in root_context_file_names() {
        let full = Path::new(workspace_path).join(&file_name);
        let Ok(raw) = std::fs::read_to_string(&full) else {
            continue;
        };
        let curated_content = strip_promptops_block(&raw).trim().to_string();
        let updated_at = std::fs::metadata(&full)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| format!("{}", d.as_millis()));
        files.push(BriefContextFile {
            file_name,
            curated: !curated_content.is_empty(),
            excerpt: truncate_chars(&curated_content, EXCERPT_MAX_CHARS),
            updated_at,
        });
    }
    files
}

fn brief_claude_memories(workspace_path: &str) -> BriefAgentMemories {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let memory_dir = Path::new(&home)
        .join(".claude")
        .join("projects")
        .join(claude_project_dir_name(workspace_path))
        .join("memory");

    let Ok(read_dir) = std::fs::read_dir(&memory_dir) else {
        return BriefAgentMemories {
            dir: None,
            entries: Vec::new(),
            file_count: 0,
        };
    };
    let file_names: Vec<String> = read_dir
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|f| f.ends_with(".md"))
        .collect();
    let memory_files: Vec<&String> = file_names.iter().filter(|f| *f != "MEMORY.md").collect();

    let index = std::fs::read_to_string(memory_dir.join("MEMORY.md")).ok();
    let mut entries = index.as_deref().map(parse_memory_index).unwrap_or_default();

    // No index but files present → fallback to the per-file frontmatter.
    if entries.is_empty() && !memory_files.is_empty() {
        for file_name in memory_files.iter().take(MEMORY_FALLBACK_MAX_FILES) {
            let Ok(raw) = std::fs::read_to_string(memory_dir.join(file_name)) else {
                continue;
            };
            let (name, description) = parse_memory_frontmatter(&raw);
            entries.push(BriefMemoryEntry {
                title: name.unwrap_or_else(|| file_name.trim_end_matches(".md").to_string()),
                hook: description.unwrap_or_default(),
                file: Some((*file_name).clone()),
            });
        }
    }

    BriefAgentMemories {
        dir: Some(memory_dir.to_string_lossy().into_owned()),
        entries,
        file_count: memory_files.len(),
    }
}

fn brief_recent_activity(workspace_path: &str) -> Vec<BriefActivityEntry> {
    let raw = std::fs::read_to_string(
        Path::new(workspace_path)
            .join(".promptops")
            .join("session-memory.json"),
    );
    let Ok(raw) = raw else { return Vec::new() };
    let Ok(parsed) = serde_json::from_str::<JsonValue>(&raw) else {
        return Vec::new();
    };
    let mut entries: Vec<BriefActivityEntry> = parsed
        .get("entries")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    let content = e.get("content")?.as_str()?;
                    Some(BriefActivityEntry {
                        category: e
                            .get("category")
                            .and_then(|c| c.as_str())
                            .unwrap_or("note")
                            .to_string(),
                        content: truncate_chars(content, ACTIVITY_CONTENT_MAX),
                        timestamp: e.get("timestamp").and_then(|t| t.as_i64()).unwrap_or(0),
                        related_files: e
                            .get("relatedFiles")
                            .and_then(|r| r.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|f| f.as_str().map(str::to_string))
                                    .take(3)
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    entries.sort_by_key(|b| std::cmp::Reverse(b.timestamp));
    entries.truncate(ACTIVITY_MAX_ENTRIES);
    entries
}

/// collectProjectBrief — full aggregation.
pub fn collect_project_brief(workspace_path: &str) -> ProjectBriefData {
    let project_ctx = crate::commands::smart_context::read_project_context(workspace_path)
        .and_then(|raw| serde_json::from_str::<JsonValue>(&raw).ok())
        .unwrap_or(JsonValue::Null);

    let str_vec = |key: &str| -> Vec<String> {
        project_ctx
            .get(key)
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };

    let project_name = project_ctx
        .get("projectName")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| {
            Path::new(workspace_path)
                .file_name()
                .and_then(|b| b.to_str())
                .unwrap_or(workspace_path)
                .to_string()
        });

    let data = ProjectBriefData {
        workspace_path: workspace_path.to_string(),
        project_name,
        generated_at: now_iso(),
        frameworks: str_vec("frameworks"),
        languages: str_vec("languages"),
        summary: project_ctx
            .get("summary")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        context_files: brief_context_files(workspace_path),
        agent_memories: brief_claude_memories(workspace_path),
        recent_activity: brief_recent_activity(workspace_path),
        ai_source: String::new(),
    };

    // buildAiSource — raw material for the AI brief (instruction on the renderer side).
    let mut parts: Vec<String> = vec![format!("# Project: {}", data.project_name)];
    if let Some(summary) = &data.summary {
        parts.push(summary.clone());
    }
    if !data.frameworks.is_empty() {
        parts.push(format!("Frameworks: {}", data.frameworks.join(", ")));
    }
    if !data.languages.is_empty() {
        parts.push(format!("Languages: {}", data.languages.join(", ")));
    }
    for file in &data.context_files {
        if file.curated {
            parts.push(format!("\n## {}\n{}", file.file_name, file.excerpt));
        }
    }
    if !data.agent_memories.entries.is_empty() {
        let lines: Vec<String> = data
            .agent_memories
            .entries
            .iter()
            .map(|e| format!("- {}: {}", e.title, e.hook))
            .collect();
        parts.push(format!(
            "\n## Agent memories ({} files)\n{}",
            data.agent_memories.file_count,
            lines.join("\n")
        ));
    }
    if !data.recent_activity.is_empty() {
        let lines: Vec<String> = data
            .recent_activity
            .iter()
            .map(|e| format!("- [{}] {}", e.category, e.content))
            .collect();
        parts.push(format!("\n## Recent activity\n{}", lines.join("\n")));
    }
    let ai_source = truncate_chars(&parts.join("\n"), AI_SOURCE_MAX_CHARS);

    ProjectBriefData { ai_source, ..data }
}

/// project-brief:collect. spawn_blocking: reads README/manifest/tree of the
/// workspace — IO that must not run on the main thread.
#[tauri::command]
pub async fn project_brief_collect(workspace_path: String) -> JsonValue {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = workspace_path.trim();
        if trimmed.is_empty() {
            return serde_json::json!({ "ok": false, "error": "workspacePath required" });
        }
        serde_json::json!({ "ok": true, "data": collect_project_brief(trimmed) })
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({ "ok": false, "error": "join error" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_a_complete_promptops_block() {
        let input = "# Project\n<!-- PROMPTOPS:CONTEXT -->\ngenerated\n<!-- /PROMPTOPS:CONTEXT -->\ncurated by the user";
        let out = strip_promptops_block(input);
        assert!(!out.contains("generated"));
        assert!(out.contains("curated by the user"));
        assert!(out.contains("# Project"));
    }

    #[test]
    fn leaves_an_unclosed_marker_intact() {
        // Without a closing marker nothing matches.
        let input = "text\n<!-- PROMPTOPS:CONTEXT -->\nrest of the file";
        assert_eq!(strip_promptops_block(input), input);
    }

    #[test]
    fn claude_project_dir_escapes_non_alphanumerics() {
        assert_eq!(
            claude_project_dir_name("/Users/me/projects/foo"),
            "-Users-me-projects-foo"
        );
        assert_eq!(
            claude_project_dir_name("C:\\Users\\me\\foo.bar"),
            "C--Users-me-foo-bar"
        );
    }

    #[test]
    fn memory_index_parses_title_file_and_hook() {
        let md = "- [Title](file.md) — the hook\n* [Other](b.md) - second\nnoise";
        let entries = parse_memory_index(md);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].title, "Title");
        assert_eq!(entries[0].file.as_deref(), Some("file.md"));
        assert_eq!(entries[0].hook, "the hook");
        assert_eq!(entries[1].hook, "second");
    }

    #[test]
    fn frontmatter_picks_name_and_description() {
        let md = "---\nname: my-memory\ndescription: \"a description\"\n---\nbody";
        let (name, desc) = parse_memory_frontmatter(md);
        assert_eq!(name.as_deref(), Some("my-memory"));
        assert_eq!(desc.as_deref(), Some("a description"));
    }

    fn temp_store() -> (crate::local_store::LocalStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "promptops-ws-state-{}",
            crate::local_store::new_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        (
            crate::local_store::LocalStore::open_at(
                &dir,
                crate::vault::VaultKey::from_bytes([6; 32]),
            )
            .unwrap(),
            dir,
        )
    }

    #[test]
    fn desktop_state_is_stored_encrypted_and_moved_out_of_the_clear_file() {
        let (store, dir) = temp_store();
        let legacy = dir.join("desktop-state.json");
        std::fs::write(
            &legacy,
            r#"{"activeSessionName":"acme-secret","subAgentsExpanded":true,"focusedSubAgentRole":null,"savedAt":"x","contextTransferPrefs":{"/w":{"codex":"always"}}}"#,
        )
        .unwrap();
        // First read moves the name into the store and leaves the prefs in the
        // file for smart_context.rs (they are not part of the desktop state).
        let s = load_desktop_state_in(&store, Some(&legacy)).unwrap();
        assert_eq!(s.active_session_name.as_deref(), Some("acme-secret"));
        assert!(s.sub_agents_expanded);
        assert!(!serde_json::to_string(&s)
            .unwrap()
            .contains("contextTransferPrefs"));
        let left = std::fs::read_to_string(&legacy).unwrap();
        assert!(!left.contains("acme-secret") && left.contains("contextTransferPrefs"));

        save_desktop_state_in(
            &store,
            Some(&legacy),
            DesktopStateSavePayload {
                active_session_name: Some("next".into()),
                sub_agents_expanded: false,
                focused_sub_agent_role: Some("reviewer".into()),
            },
        )
        .unwrap();
        let s = load_desktop_state_in(&store, Some(&legacy)).unwrap();
        assert_eq!(s.active_session_name.as_deref(), Some("next"));
        assert_eq!(s.focused_sub_agent_role.as_deref(), Some("reviewer"));
        let raw = std::fs::read_to_string(dir.join("local-store.json")).unwrap();
        assert!(!raw.contains("next") && !raw.contains("reviewer"));
    }

    #[test]
    fn desktop_state_without_any_record_is_none_and_partial_records_load() {
        let (store, dir) = temp_store();
        assert!(load_desktop_state_in(&store, Some(&dir.join("missing.json"))).is_none());
        let partial: DesktopState = serde_json::from_str(r#"{"activeSessionName":"a"}"#).unwrap();
        assert_eq!(partial.active_session_name.as_deref(), Some("a"));
        assert!(!partial.sub_agents_expanded);
    }

    #[test]
    fn recents_move_from_the_clear_file_and_stay_capped_and_unique() {
        let (store, dir) = temp_store();
        let legacy = dir.join("workspaces.json");
        std::fs::write(
            &legacy,
            r#"{"recentWorkspaces":[{"path":"/Users/alice/old","name":"old"}]}"#,
        )
        .unwrap();
        for i in 0..12 {
            let w = WorkspaceBinding {
                path: format!("/w/{i}"),
                name: format!("w{i}"),
            };
            remember_recent_in(&store, &legacy, &w).unwrap();
        }
        assert!(!legacy.exists());
        let again = WorkspaceBinding {
            path: "/w/5".into(),
            name: "w5".into(),
        };
        remember_recent_in(&store, &legacy, &again).unwrap();
        let recents = load_recents_in(&store, &legacy).recent_workspaces;
        assert_eq!(recents.len(), MAX_RECENT);
        assert_eq!(recents[0].path, "/w/5");
        assert_eq!(recents.iter().filter(|w| w.path == "/w/5").count(), 1);
        let raw = std::fs::read_to_string(dir.join("local-store.json")).unwrap();
        assert!(!raw.contains("/w/5") && !raw.contains("alice"));
    }

    #[test]
    fn context_files_always_include_claude_md() {
        assert_eq!(
            context_files_for_provider("codex"),
            vec!["CLAUDE.md", "AGENTS.md"]
        );
        assert_eq!(
            context_files_for_provider("claude-code-cli"),
            vec!["CLAUDE.md"]
        );
        assert_eq!(context_files_for_provider("unknown"), vec!["CLAUDE.md"]);
    }
}
