//! Multi-provider accounts: IPC channel `provider-account:*`, manager
//! (store/capabilities), persisted shape and JSON persistence.
//!
//! A `ProviderAccountManager` keeps the state in memory
//! (parking_lot::Mutex) and persists it to disk as JSON
//! (`provider-accounts.json`):
//!   { "accounts": [...], "activeByProvider": {...}, "version": 1 }
//!
//! Account config directories live under
//! `~/.promptops/provider-accounts/<defaultDirName>/<slug>` (this is the
//! load-bearing value of the `configDir` field, exposed to the renderer and used at spawn time).
//!
//! Push channels (`provider-account:active-changed` / `:list-changed`) emitted via
//! `AppHandle::emit`, like subagent.rs does.
//!
//! Conventions: see terminal.rs. `#[tauri::command] pub fn <name>(...) ->
//! Result<T, String>`, snake_case, state via `tauri::State<'_, Arc<...>>`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

// ===========================================================================
// ProviderType (string union shared with the web UI).
// ===========================================================================
//
// We keep providers as `String` to match the web UI union and the
// keys of the capabilities map; validation is done by looking at the map.
// Canonical values (in order):
//   claude-code-cli | codex | gemini-cli | antigravity | copilot | cursor |
//   grok | hermes | muse | opencode | kora | promptops-cli | generic-shell
pub type ProviderType = String;

// ===========================================================================
// Capabilities (PROVIDER_ACCOUNT_CAPABILITIES).
// ===========================================================================

#[derive(Clone, Serialize)]
pub struct ProviderAccountCapability {
    #[serde(rename = "envVar")]
    pub env_var: Option<&'static str>,
    #[serde(rename = "defaultDirName")]
    pub default_dir_name: &'static str,
    /// The path the CLI uses when no env var is set (standard installation).
    #[serde(rename = "defaultCliPath")]
    pub default_cli_path: Option<&'static str>,
    /// 'native' | 'partial' | 'unsupported'
    pub support: &'static str,
}

/// PROVIDER_ACCOUNT_CAPABILITIES (the order is part of the output).
/// `Record<ProviderType, {...}>` → ordered pairs, serialized as an object.
const CAPABILITIES: &[(&str, ProviderAccountCapability)] = &[
    (
        "zai",
        ProviderAccountCapability {
            env_var: Some("CLAUDE_CONFIG_DIR"),
            default_dir_name: "zai",
            default_cli_path: Some("~/.claude"),
            support: "native",
        },
    ),
    (
        "kimi",
        ProviderAccountCapability {
            env_var: Some("CLAUDE_CONFIG_DIR"),
            default_dir_name: "kimi",
            default_cli_path: Some("~/.claude"),
            support: "native",
        },
    ),
    (
        "claude-code-cli",
        ProviderAccountCapability {
            env_var: Some("CLAUDE_CONFIG_DIR"),
            default_dir_name: "claude-code-cli",
            default_cli_path: Some("~/.claude"),
            support: "native",
        },
    ),
    (
        "codex",
        ProviderAccountCapability {
            env_var: Some("CODEX_HOME"),
            default_dir_name: "codex",
            default_cli_path: Some("~/.codex"),
            support: "native",
        },
    ),
    (
        "copilot",
        ProviderAccountCapability {
            env_var: Some("COPILOT_HOME"),
            default_dir_name: "copilot",
            default_cli_path: Some("~/.copilot"),
            support: "native",
        },
    ),
    (
        "gemini-cli",
        ProviderAccountCapability {
            env_var: Some("GEMINI_CLI_HOME"),
            default_dir_name: "gemini-cli",
            default_cli_path: Some("~/.gemini"),
            support: "partial",
        },
    ),
    (
        "opencode",
        ProviderAccountCapability {
            env_var: Some("OPENCODE_CONFIG_DIR"),
            default_dir_name: "opencode",
            default_cli_path: Some("~/.config/opencode"),
            support: "partial",
        },
    ),
    (
        "cursor",
        ProviderAccountCapability {
            env_var: None,
            default_dir_name: "cursor",
            default_cli_path: Some("~/.cursor"),
            support: "unsupported",
        },
    ),
    (
        "grok",
        ProviderAccountCapability {
            env_var: None,
            default_dir_name: "grok",
            default_cli_path: Some("~/.grok"),
            // No config-dir env var is injected: a managed profile would be the
            // same login. Existing aliases still work.
            support: "unsupported",
        },
    ),
    (
        "hermes",
        ProviderAccountCapability {
            env_var: None,
            default_dir_name: "hermes",
            default_cli_path: Some("~/.hermes"),
            // No config-dir env var is injected: a managed profile would be the
            // same login. Existing aliases still work.
            support: "unsupported",
        },
    ),
    (
        // kora honors `KORA_PROFILE_ROOT` as the WHOLE profile root (settings,
        // API key, sessions): a managed dir is a fully isolated profile, not
        // only a config dir — hence "partial", like opencode.
        "kora",
        ProviderAccountCapability {
            env_var: Some("KORA_PROFILE_ROOT"),
            default_dir_name: "kora",
            default_cli_path: Some("~/.kora"),
            support: "partial",
        },
    ),
    (
        // muse: config under $XDG_CONFIG_HOME/muse; no dedicated env var
        // (moving XDG_CONFIG_HOME would move the config of every other CLI).
        "muse",
        ProviderAccountCapability {
            env_var: None,
            default_dir_name: "muse",
            default_cli_path: Some("~/.config/muse"),
            support: "unsupported",
        },
    ),
    (
        // agy (1.3.4) has no config-dir variable (`AGY_CONFIG_DIR` does not exist
        // in the binary) and keeps its state under ~/.gemini/antigravity-cli:
        // existing aliases only.
        "antigravity",
        ProviderAccountCapability {
            env_var: None,
            default_dir_name: "antigravity",
            default_cli_path: Some("~/.gemini/antigravity-cli"),
            support: "unsupported",
        },
    ),
    (
        "promptops-cli",
        ProviderAccountCapability {
            env_var: Some("CLAUDE_CONFIG_DIR"),
            default_dir_name: "promptops-cli",
            default_cli_path: Some("~/.claude"),
            support: "native",
        },
    ),
    (
        "generic-shell",
        ProviderAccountCapability {
            env_var: None,
            default_dir_name: "generic-shell",
            default_cli_path: None,
            support: "unsupported",
        },
    ),
];

fn capability_for(provider: &str) -> Option<&'static ProviderAccountCapability> {
    CAPABILITIES
        .iter()
        .find(|(k, _)| *k == provider)
        .map(|(_, v)| v)
}

const DIR_MODE: u32 = 0o700;
const SLUG_FALLBACK: &str = "account";

// ===========================================================================
// Persisted types.
// camelCase field names to stay compatible with the JSON store.
// ===========================================================================

#[derive(Clone, Serialize, Deserialize)]
pub struct ProviderAccount {
    pub id: String,
    pub name: String,
    pub provider: ProviderType,
    #[serde(rename = "configDir")]
    pub config_dir: String,
    #[serde(
        rename = "commandAlias",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub command_alias: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub notes: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// ProviderAccountState — { accounts, activeByProvider, version: 1 }.
#[derive(Clone, Serialize, Deserialize)]
pub struct ProviderAccountState {
    pub accounts: Vec<ProviderAccount>,
    #[serde(rename = "activeByProvider")]
    pub active_by_provider: HashMap<ProviderType, String>,
    pub version: u32,
}

impl Default for ProviderAccountState {
    fn default() -> Self {
        // PROVIDER_ACCOUNT_STATE_DEFAULTS
        Self {
            accounts: Vec::new(),
            active_by_provider: HashMap::new(),
            version: 1,
        }
    }
}

// ===========================================================================
// Input — CreateAccountInput / IPC payload.
// ===========================================================================

#[derive(Deserialize)]
pub struct CreateAccountInput {
    #[serde(rename = "commandAlias", default)]
    pub command_alias: Option<String>,
    pub name: String,
    pub provider: ProviderType,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdatePatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

// ===========================================================================
// Manager — ProviderAccountManager + ProviderAccountStore.
// In-memory state behind parking_lot::Mutex, persisted to a JSON file.
// ===========================================================================

pub struct ProviderAccountManager {
    /// Root of the account config directories (default `~/.promptops/provider-accounts`).
    root_dir: PathBuf,
    /// JSON persistence file for the state.
    /// `None` until initialized from the AppHandle (see `ensure_init`).
    state_file: Mutex<Option<PathBuf>>,
    /// In-memory state cache (single source of truth at runtime).
    state: Mutex<ProviderAccountState>,
}

impl Default for ProviderAccountManager {
    fn default() -> Self {
        Self {
            root_dir: default_root(),
            state_file: Mutex::new(None),
            state: Mutex::new(ProviderAccountState::default()),
        }
    }
}

impl ProviderAccountManager {
    pub fn new() -> Self {
        Self::default()
    }

    // --- bootstrap / persistence -----------------------------------------

    /// Resolves the state file path under the app data dir and loads the state
    /// from disk the first time. Idempotent. File name: `provider-accounts.json`.
    pub(crate) fn ensure_init(&self, app: &AppHandle) -> Result<(), String> {
        if self.state_file.lock().is_some() {
            return Ok(());
        }
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir: {e}"))?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        self.init_from_file(dir.join("provider-accounts.json"))
    }

    fn init_from_file(&self, file: PathBuf) -> Result<(), String> {
        let mut slot = self.state_file.lock();
        if slot.is_some() {
            return Ok(());
        }
        // Load the existing state, otherwise the defaults.
        let loaded = match std::fs::read_to_string(&file) {
            Ok(raw) => serde_json::from_str::<ProviderAccountState>(&raw)
                .map_err(|_| "Cannot read saved AI Accounts: invalid account store".to_string())?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => ProviderAccountState::default(),
            Err(e) => return Err(format!("Cannot read saved AI Accounts: {e}")),
        };
        *self.state.lock() = loaded;
        *slot = Some(file);
        Ok(())
    }

    /// Writes the state to disk (ProviderAccountStore.setState).
    fn persist(&self, state: &ProviderAccountState) -> Result<(), String> {
        if let Some(file) = self.state_file.lock().as_ref() {
            let raw = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
            // Temp file + rename: a crash mid-write must not leave a truncated
            // store, which the next start refuses to load.
            let tmp = file.with_extension("json.tmp");
            std::fs::write(&tmp, raw).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, file).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn provider_root(&self, provider: &str) -> Result<PathBuf, String> {
        let cap =
            capability_for(provider).ok_or_else(|| format!("Unknown provider: {provider}"))?;
        Ok(self.root_dir.join(cap.default_dir_name))
    }
}

// ===========================================================================
// Push events — 'provider-account:active-changed' / ':list-changed'.
// ===========================================================================

#[derive(Clone, Serialize)]
struct ActiveChangedPayload {
    provider: ProviderType,
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

#[derive(Clone, Serialize)]
struct ListChangedPayload {
    accounts: Vec<ProviderAccount>,
}

fn emit_active_changed(app: &AppHandle, provider: &str, account_id: Option<String>) {
    let _ = app.emit(
        "provider-account:active-changed",
        ActiveChangedPayload {
            provider: provider.to_string(),
            account_id,
        },
    );
}

fn emit_list_changed(app: &AppHandle, accounts: Vec<ProviderAccount>) {
    let _ = app.emit(
        "provider-account:list-changed",
        ListChangedPayload { accounts },
    );
}

// ===========================================================================
// IPC results — `{ ok, ... }` shape.
// ===========================================================================

#[derive(Serialize)]
pub struct ListResult {
    pub ok: bool,
    pub accounts: Vec<ProviderAccount>,
}

#[derive(Serialize)]
pub struct GetResult {
    pub ok: bool,
    pub account: Option<ProviderAccount>,
}

#[derive(Serialize)]
pub struct CapabilitiesResult {
    pub ok: bool,
    pub capabilities: JsonValue,
}

// ===========================================================================
// Commands — one per `provider-account:*` channel.
// Names follow the rule: provider-account:set-active → provider_account_set_active.
// ===========================================================================

/// provider-account:list
#[tauri::command]
pub fn provider_account_list(
    app: AppHandle,
    manager: tauri::State<'_, Arc<ProviderAccountManager>>,
) -> Result<ListResult, String> {
    manager.ensure_init(&app)?;
    let accounts = manager.state.lock().accounts.clone();
    Ok(ListResult { ok: true, accounts })
}

/// provider-account:list-by-provider
#[tauri::command]
pub fn provider_account_list_by_provider(
    app: AppHandle,
    manager: tauri::State<'_, Arc<ProviderAccountManager>>,
    provider: ProviderType,
) -> Result<ListResult, String> {
    manager.ensure_init(&app)?;
    let accounts = manager
        .state
        .lock()
        .accounts
        .iter()
        .filter(|a| a.provider == provider)
        .cloned()
        .collect();
    Ok(ListResult { ok: true, accounts })
}

/// provider-account:get
#[tauri::command]
pub fn provider_account_get(
    app: AppHandle,
    manager: tauri::State<'_, Arc<ProviderAccountManager>>,
    id: String,
) -> Result<GetResult, String> {
    manager.ensure_init(&app)?;
    let account = manager
        .state
        .lock()
        .accounts
        .iter()
        .find(|a| a.id == id)
        .cloned();
    Ok(GetResult { ok: true, account })
}

/// provider-account:get-active
#[tauri::command]
pub fn provider_account_get_active(
    app: AppHandle,
    manager: tauri::State<'_, Arc<ProviderAccountManager>>,
    provider: ProviderType,
) -> Result<GetResult, String> {
    manager.ensure_init(&app)?;
    let guard = manager.state.lock();
    let account = guard
        .active_by_provider
        .get(&provider)
        .and_then(|id| guard.accounts.iter().find(|a| &a.id == id).cloned());
    Ok(GetResult { ok: true, account })
}

/// provider-account:set-active
/// payload: { id: string | null, provider?: ProviderType }
#[tauri::command]
pub fn provider_account_set_active(
    app: AppHandle,
    manager: tauri::State<'_, Arc<ProviderAccountManager>>,
    id: Option<String>,
    provider: Option<ProviderType>,
) -> Result<JsonValue, String> {
    if let Err(e) = manager.ensure_init(&app) {
        return Ok(err_result(&e));
    }

    let mut guard = manager.state.lock();

    match id {
        // id === null → opt-out for the provider (requires provider).
        None => {
            let provider = match provider {
                Some(p) => p,
                None => {
                    return Ok(err_result(
                        "provider is required when setting active to null",
                    ))
                }
            };
            if !guard.active_by_provider.contains_key(&provider) {
                return Ok(ok_result());
            }
            guard.active_by_provider.remove(&provider);
            let snapshot = guard.clone();
            drop(guard);
            if let Err(e) = manager.persist(&snapshot) {
                return Ok(err_result(&e));
            }
            emit_active_changed(&app, &provider, None);
            Ok(ok_result())
        }
        // id === string → sets the account as active for its provider.
        Some(id) => {
            let account = match guard.accounts.iter().find(|a| a.id == id).cloned() {
                Some(a) => a,
                None => return Ok(err_result(&format!("Provider account not found: {id}"))),
            };
            let resolved_provider = provider.unwrap_or_else(|| account.provider.clone());
            if resolved_provider != account.provider {
                return Ok(err_result(&format!(
                    "Account {id} belongs to provider '{}', not '{resolved_provider}'",
                    account.provider
                )));
            }
            if guard.active_by_provider.get(&account.provider) == Some(&id) {
                return Ok(ok_result());
            }
            guard
                .active_by_provider
                .insert(account.provider.clone(), id.clone());
            let snapshot = guard.clone();
            let provider = account.provider.clone();
            drop(guard);
            if let Err(e) = manager.persist(&snapshot) {
                return Ok(err_result(&e));
            }
            emit_active_changed(&app, &provider, Some(id));
            Ok(ok_result())
        }
    }
}

/// provider-account:create
/// payload: { name, provider, color?, notes? } — the bridge passes the fields
/// flattened as invoke arguments (not wrapped in `input`), so the
/// command accepts them individually like the other `provider_account_*`.
#[tauri::command]
pub fn provider_account_create(
    app: AppHandle,
    manager: tauri::State<'_, Arc<ProviderAccountManager>>,
    name: String,
    provider: ProviderType,
    color: Option<String>,
    notes: Option<String>,
    command_alias: Option<String>,
) -> Result<JsonValue, String> {
    if let Err(e) = manager.ensure_init(&app) {
        return Ok(err_result(&e));
    }
    let input = CreateAccountInput {
        command_alias,
        name,
        provider,
        color,
        notes,
    };
    match do_create(&app, &manager, input) {
        Ok(account) => Ok(account_result(account)),
        Err(e) => Ok(err_result(&e)),
    }
}

fn do_create(
    app: &AppHandle,
    manager: &ProviderAccountManager,
    input: CreateAccountInput,
) -> Result<ProviderAccount, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("Account name is required".to_string());
    }

    let command_alias = input.command_alias.map(|s| s.trim().to_string());
    if let Some(alias) = &command_alias {
        validate_command_alias(alias)?;
    }
    let mut guard = manager.state.lock();
    let provider_root = manager.provider_root(&input.provider)?;
    if command_alias.is_none() {
        create_dir_mode(&provider_root)?;
    }

    let siblings: Vec<&ProviderAccount> = guard
        .accounts
        .iter()
        .filter(|a| a.provider == input.provider)
        .collect();
    let slug = unique_slug(&name, &siblings);
    let config_dir = provider_root.join(&slug);
    if command_alias.is_none() {
        create_dir_mode(&config_dir)?;
    }

    let now = now_iso();
    let account = ProviderAccount {
        id: Uuid::new_v4().to_string(),
        name,
        provider: input.provider,
        config_dir: if command_alias.is_some() {
            String::new()
        } else {
            config_dir.to_string_lossy().into_owned()
        },
        command_alias,
        color: input.color,
        notes: input.notes,
        created_at: now.clone(),
        updated_at: now,
    };
    guard.accounts.push(account.clone());
    let snapshot = guard.clone();
    drop(guard);
    manager.persist(&snapshot)?;
    emit_list_changed(app, snapshot.accounts.clone());
    Ok(account)
}

/// provider-account:duplicate
/// payload: { id: string, newName: string }
#[tauri::command]
pub fn provider_account_duplicate(
    app: AppHandle,
    manager: tauri::State<'_, Arc<ProviderAccountManager>>,
    id: String,
    #[allow(non_snake_case)] newName: String,
) -> Result<JsonValue, String> {
    if let Err(e) = manager.ensure_init(&app) {
        return Ok(err_result(&e));
    }
    match do_duplicate(&app, &manager, id, newName) {
        Ok(account) => Ok(account_result(account)),
        Err(e) => Ok(err_result(&e)),
    }
}

fn do_duplicate(
    app: &AppHandle,
    manager: &ProviderAccountManager,
    id: String,
    new_name: String,
) -> Result<ProviderAccount, String> {
    let name = new_name.trim().to_string();
    if name.is_empty() {
        return Err("Account name is required".to_string());
    }
    let mut guard = manager.state.lock();
    let source = guard
        .accounts
        .iter()
        .find(|a| a.id == id)
        .cloned()
        .ok_or_else(|| format!("Provider account not found: {id}"))?;

    if source.command_alias.is_some() {
        return Err("Add another existing alias instead of duplicating this account".into());
    }
    let provider_root = manager.provider_root(&source.provider)?;
    create_dir_mode(&provider_root)?;
    let siblings: Vec<&ProviderAccount> = guard
        .accounts
        .iter()
        .filter(|a| a.provider == source.provider)
        .collect();
    let slug = unique_slug(&name, &siblings);
    let target_dir = provider_root.join(&slug);
    create_dir_mode(&target_dir)?;

    // fs.cp(source.configDir, targetDir, { recursive, force }) if the source exists.
    if dir_exists(&source.config_dir) {
        copy_dir_recursive(Path::new(&source.config_dir), &target_dir)?;
        set_dir_mode(&target_dir)?;
    }

    let now = now_iso();
    let account = ProviderAccount {
        id: Uuid::new_v4().to_string(),
        name,
        provider: source.provider.clone(),
        config_dir: target_dir.to_string_lossy().into_owned(),
        command_alias: None,
        color: source.color.clone(),
        notes: source.notes.clone(),
        created_at: now.clone(),
        updated_at: now,
    };
    guard.accounts.push(account.clone());
    let snapshot = guard.clone();
    drop(guard);
    manager.persist(&snapshot)?;
    emit_list_changed(app, snapshot.accounts.clone());
    Ok(account)
}

/// provider-account:rename
/// payload: { id: string, name: string }
#[tauri::command]
pub fn provider_account_rename(
    app: AppHandle,
    manager: tauri::State<'_, Arc<ProviderAccountManager>>,
    id: String,
    name: String,
) -> Result<JsonValue, String> {
    if let Err(e) = manager.ensure_init(&app) {
        return Ok(err_result(&e));
    }
    let new_name = name.trim().to_string();
    if new_name.is_empty() {
        return Ok(err_result("Account name is required"));
    }
    let mut guard = manager.state.lock();
    let index = match guard.accounts.iter().position(|a| a.id == id) {
        Some(i) => i,
        None => return Ok(err_result(&format!("Provider account not found: {id}"))),
    };
    guard.accounts[index].name = new_name;
    guard.accounts[index].updated_at = now_iso();
    let updated = guard.accounts[index].clone();
    let snapshot = guard.clone();
    drop(guard);
    if let Err(e) = manager.persist(&snapshot) {
        return Ok(err_result(&e));
    }
    emit_list_changed(&app, snapshot.accounts.clone());
    Ok(account_result(updated))
}

/// provider-account:update
/// payload: { id: string, patch: { name?, color?, notes? } }
#[tauri::command]
pub fn provider_account_update(
    app: AppHandle,
    manager: tauri::State<'_, Arc<ProviderAccountManager>>,
    id: String,
    patch: UpdatePatch,
) -> Result<JsonValue, String> {
    if let Err(e) = manager.ensure_init(&app) {
        return Ok(err_result(&e));
    }
    let mut guard = manager.state.lock();
    let index = match guard.accounts.iter().position(|a| a.id == id) {
        Some(i) => i,
        None => return Ok(err_result(&format!("Provider account not found: {id}"))),
    };

    // name: patch.name !== undefined ? trim : current; empty → error.
    let name = match &patch.name {
        Some(n) => {
            let trimmed = n.trim().to_string();
            if trimmed.is_empty() {
                return Ok(err_result("Account name is required"));
            }
            trimmed
        }
        None => guard.accounts[index].name.clone(),
    };

    guard.accounts[index].name = name;
    // color/notes: patch !== undefined ? patch : current (a None keeps the value).
    if patch.color.is_some() {
        guard.accounts[index].color = patch.color;
    }
    if patch.notes.is_some() {
        guard.accounts[index].notes = patch.notes;
    }
    guard.accounts[index].updated_at = now_iso();
    let updated = guard.accounts[index].clone();
    let snapshot = guard.clone();
    drop(guard);
    if let Err(e) = manager.persist(&snapshot) {
        return Ok(err_result(&e));
    }
    emit_list_changed(&app, snapshot.accounts.clone());
    Ok(account_result(updated))
}

/// provider-account:delete
/// payload: { id: string, deleteFiles: boolean }
#[tauri::command]
pub fn provider_account_delete(
    app: AppHandle,
    manager: tauri::State<'_, Arc<ProviderAccountManager>>,
    id: String,
    #[allow(non_snake_case)] deleteFiles: bool,
) -> Result<JsonValue, String> {
    if let Err(e) = manager.ensure_init(&app) {
        return Ok(err_result(&e));
    }
    match do_delete(&app, &manager, id, deleteFiles) {
        Ok(()) => Ok(ok_result()),
        Err(e) => Ok(err_result(&e)),
    }
}

fn do_delete(
    app: &AppHandle,
    manager: &ProviderAccountManager,
    id: String,
    delete_files: bool,
) -> Result<(), String> {
    let mut guard = manager.state.lock();
    let account = guard
        .accounts
        .iter()
        .find(|a| a.id == id)
        .cloned()
        .ok_or_else(|| format!("Provider account not found: {id}"))?;

    if guard.active_by_provider.get(&account.provider) == Some(&id) {
        return Err(format!(
            "Cannot delete the active account for provider '{}'. Switch first.",
            account.provider
        ));
    }

    if delete_files
        && account.command_alias.is_none()
        && is_managed_dir(manager, &account.config_dir, &account.provider)?
    {
        let _ = std::fs::remove_dir_all(&account.config_dir); // { recursive, force }
    }

    guard.accounts.retain(|a| a.id != id);
    let snapshot = guard.clone();
    drop(guard);
    manager.persist(&snapshot)?;
    emit_list_changed(app, snapshot.accounts.clone());
    Ok(())
}

/// provider-account:open-folder
#[tauri::command]
pub fn provider_account_open_folder(
    app: AppHandle,
    manager: tauri::State<'_, Arc<ProviderAccountManager>>,
    id: String,
) -> Result<JsonValue, String> {
    if let Err(e) = manager.ensure_init(&app) {
        return Ok(err_result(&e));
    }
    let account = manager
        .state
        .lock()
        .accounts
        .iter()
        .find(|a| a.id == id)
        .cloned();
    let account = match account {
        Some(a) => a,
        None => return Ok(err_result("Account not found")),
    };
    // shell.openPath(account.configDir) — opens the folder in the file manager.
    if account.command_alias.is_some() {
        return Ok(err_result(
            "Existing aliases do not have a PromptOps config folder",
        ));
    }
    match open_path(&account.config_dir) {
        Ok(()) => Ok(ok_result()),
        Err(e) => Ok(err_result(&e)),
    }
}

/// provider-account:import
/// payload: { name, provider, sourceDir? }. Without sourceDir → native folder picker.
#[tauri::command]
pub async fn provider_account_import(
    app: AppHandle,
    manager: tauri::State<'_, Arc<ProviderAccountManager>>,
    name: String,
    provider: ProviderType,
    #[allow(non_snake_case)] sourceDir: Option<String>,
) -> Result<JsonValue, String> {
    if let Err(e) = manager.ensure_init(&app) {
        return Ok(err_result(&e));
    }

    // Resolve the source: from the payload or via the folder selection dialog.
    let source_dir = match sourceDir {
        Some(s) => s,
        None => match pick_directory(&app, &provider).await {
            Some(p) => p,
            None => return Ok(err_result("Import canceled")),
        },
    };

    match do_import(&app, &manager, name, provider, source_dir) {
        Ok(account) => Ok(account_result(account)),
        Err(e) => Ok(err_result(&e)),
    }
}

fn do_import(
    app: &AppHandle,
    manager: &ProviderAccountManager,
    name: String,
    provider: ProviderType,
    source_dir: String,
) -> Result<ProviderAccount, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("Account name is required".to_string());
    }
    // path.resolve(sourceDir) → absolute. canonicalize fails if it doesn't exist,
    // so we normalize manually to keep the "not found" error message.
    let absolute = resolve_path(&source_dir);
    if !dir_exists(&absolute) {
        return Err(format!("Directory not found: {absolute}"));
    }

    let mut guard = manager.state.lock();
    let now = now_iso();
    let account = ProviderAccount {
        id: Uuid::new_v4().to_string(),
        name: trimmed,
        provider,
        config_dir: absolute,
        command_alias: None,
        color: None,
        notes: None,
        created_at: now.clone(),
        updated_at: now,
    };
    guard.accounts.push(account.clone());
    let snapshot = guard.clone();
    drop(guard);
    manager.persist(&snapshot)?;
    emit_list_changed(app, snapshot.accounts.clone());
    Ok(account)
}

/// provider-account:capabilities
#[tauri::command]
pub fn provider_account_capabilities() -> Result<CapabilitiesResult, String> {
    // Serialize the map preserving the declared order via serde_json::Map.
    let mut map = serde_json::Map::new();
    for (k, v) in CAPABILITIES.iter() {
        map.insert(
            (*k).to_string(),
            serde_json::to_value(v).map_err(|e| e.to_string())?,
        );
    }
    Ok(CapabilitiesResult {
        ok: true,
        capabilities: JsonValue::Object(map),
    })
}

// ===========================================================================
// resolveForSpawn — not exposed as an IPC channel (it is meant to be called
// at spawn time). Used by the env injection below.
// ===========================================================================

#[derive(Clone, Serialize)]
pub struct ResolveResult {
    pub account: Option<ProviderAccount>,
    /// 'explicit' | 'active' | 'none' | 'fallback'
    pub source: &'static str,
}

// ── Env injection at spawn ──

static GLOBAL_MANAGER: std::sync::OnceLock<Arc<ProviderAccountManager>> =
    std::sync::OnceLock::new();

/// Wired once in lib.rs setup — shared by all spawns.
pub fn set_global_manager(m: Arc<ProviderAccountManager>) {
    let _ = GLOBAL_MANAGER.set(m);
}

/// Config folders of the managed (non-alias) accounts of `provider`: where the
/// CLI keeps its settings for that account (e.g. a GEMINI_CLI_HOME).
pub(crate) fn config_dirs_for(provider: &str) -> Vec<String> {
    let Some(manager) = GLOBAL_MANAGER.get() else {
        return Vec::new();
    };
    let state = manager.state.lock();
    state
        .accounts
        .iter()
        .filter(|a| a.provider == provider && a.command_alias.is_none())
        .map(|a| a.config_dir.clone())
        .filter(|d| !d.is_empty())
        .collect()
}

/// An alias is a single shell word, never a shell command or definition.
pub(crate) fn validate_command_alias(alias: &str) -> Result<(), String> {
    if alias.is_empty()
        || alias.len() > 128
        || !alias.as_bytes()[0].is_ascii_alphabetic()
        || !alias
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-.".contains(&c))
    {
        return Err(
            "Enter an alias name (e.g. claude-work), without spaces, arguments or shell syntax"
                .into(),
        );
    }
    Ok(())
}

pub(crate) fn resolve_account_command(
    provider: &str,
    explicit: Option<Option<String>>,
) -> Option<String> {
    let alias = GLOBAL_MANAGER
        .get()?
        .resolve_for_spawn(provider, explicit)
        .account?
        .command_alias?;
    validate_command_alias(&alias).ok()?;
    Some(alias)
}

pub(crate) fn override_launch_command(launch: String, alias: Option<&str>) -> String {
    match alias {
        Some(alias) => {
            let end = launch.find(char::is_whitespace).unwrap_or(launch.len());
            format!("{alias}{}", &launch[end..])
        }
        None => launch,
    }
}

/// Env to inject into the spawn for the resolved account:
/// (env_var → configDir if the provider has native support, accountId).
/// `explicit`: None = inherit the active one; Some(None) = opt-out; Some(Some(id))
/// = explicit account (falls back to the active one if stale). Never errors: any
/// problem → no injection, the spawn proceeds.
pub fn resolve_account_env(
    provider: &str,
    explicit: Option<Option<String>>,
) -> Option<(Option<&'static str>, String, String)> {
    let manager = GLOBAL_MANAGER.get()?;
    let resolved = manager.resolve_for_spawn(provider, explicit.clone());
    if resolved.source == "fallback" {
        eprintln!(
            "[{provider}] providerAccountId {:?} not found — fell back to active account.",
            explicit
        );
    }
    let account = resolved.account?;
    if account.command_alias.is_some() {
        return Some((None, String::new(), account.id));
    }
    // TCC guard: a configDir imported under a
    // denied root would break the CLI in EVERY session regardless of the
    // workspace — better to spawn without an account and let the
    // folder-access banner speak.
    if let Some(monitor) = crate::commands::folder_access::global_monitor() {
        let (ok, root) = monitor.probe(Some(account.config_dir.as_str()), false);
        if !ok {
            eprintln!(
                "[{provider}] account '{}' configDir is under the denied root {:?} — spawning without account env",
                account.name, root
            );
            return None;
        }
    }
    let env_var = capability_for(provider).and_then(|c| c.env_var);
    Some((env_var, account.config_dir, account.id))
}

/// Credentials inherited from the app/shell must not override a managed login.
pub(crate) const CLAUDE_AUTH_OVERRIDES: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
];

pub(crate) fn account_env_vars(
    env_var: Option<&'static str>,
    config_dir: &str,
    account_id: &str,
) -> Vec<(String, String)> {
    let mut vars = vec![("PROMPTOPS_PROVIDER_ACCOUNT_ID".into(), account_id.into())];
    if let Some(manager) = GLOBAL_MANAGER.get() {
        if let Some(alias) = manager
            .state
            .lock()
            .accounts
            .iter()
            .find(|a| a.id == account_id)
            .and_then(|a| a.command_alias.clone())
        {
            vars.push(("PROMPTOPS_PROVIDER_COMMAND".into(), alias));
        }
    }
    if let Some(var) = env_var {
        vars.push((var.into(), config_dir.into()));
        if var == "CLAUDE_CONFIG_DIR" {
            // This override takes precedence over CLAUDE_CONFIG_DIR in recent
            // Claude versions. A stale inherited value selects another login.
            vars.push(("CLAUDE_SECURESTORAGE_CONFIG_DIR".into(), config_dir.into()));
        }
    }
    vars
}

pub(crate) fn apply_account_env(cmd: &mut portable_pty::CommandBuilder, vars: &[(String, String)]) {
    if vars
        .iter()
        .any(|(k, _)| k == "CLAUDE_SECURESTORAGE_CONFIG_DIR")
    {
        for key in CLAUDE_AUTH_OVERRIDES {
            cmd.env_remove(key);
        }
    }
    for (key, value) in vars {
        cmd.env(key, value);
    }
}

/// Reassert the managed Claude account after Unix login-shell startup files.
/// Export into the shell too, so resume recovery and manual relaunch agree.
/// Remote sessions never receive this local-account prefix.
pub(crate) fn account_shell_prefix(vars: &[(String, String)], shell: &str) -> Option<String> {
    let shell_name = Path::new(shell).file_name().and_then(|n| n.to_str());
    if cfg!(windows)
        || !matches!(shell_name, Some("sh" | "bash" | "zsh" | "dash" | "ksh"))
        || !vars
            .iter()
            .any(|(k, _)| k == "CLAUDE_SECURESTORAGE_CONFIG_DIR")
    {
        return None;
    }
    let exports = vars
        .iter()
        .map(|(key, value)| format!("{key}={}", crate::commands::remote::sh_quote(value)))
        .collect::<Vec<_>>()
        .join(" ");
    Some(format!(
        "unset {} && export {exports}",
        CLAUDE_AUTH_OVERRIDES.join(" ")
    ))
}

impl ProviderAccountManager {
    pub fn resolve_for_spawn(
        &self,
        provider: &str,
        explicit: Option<Option<String>>,
    ) -> ResolveResult {
        // explicit === null → { None, 'none' }
        if matches!(explicit, Some(None)) {
            return ResolveResult {
                account: None,
                source: "none",
            };
        }
        let guard = self.state.lock();
        let active = guard
            .active_by_provider
            .get(provider)
            .and_then(|id| guard.accounts.iter().find(|a| &a.id == id).cloned());

        match explicit {
            // explicit === string
            Some(Some(explicit_id)) => {
                let found = guard
                    .accounts
                    .iter()
                    .find(|a| a.id == explicit_id && a.provider == provider)
                    .cloned();
                match found {
                    Some(acc) => ResolveResult {
                        account: Some(acc),
                        source: "explicit",
                    },
                    None => ResolveResult {
                        account: active,
                        source: "fallback",
                    },
                }
            }
            // explicit === undefined
            _ => ResolveResult {
                account: active,
                source: "active",
            },
        }
    }
}

// ===========================================================================
// Private helpers — defaultRoot/uniqueSlug/slugify/dirExists/isManagedDir.
// ===========================================================================

fn ok_result() -> JsonValue {
    serde_json::json!({ "ok": true })
}

fn err_result(message: &str) -> JsonValue {
    serde_json::json!({ "ok": false, "error": message })
}

fn account_result(account: ProviderAccount) -> JsonValue {
    serde_json::json!({ "ok": true, "account": account })
}

/// defaultRoot() — `~/.promptops/provider-accounts`.
fn default_root() -> PathBuf {
    PathBuf::from(home_dir())
        .join(".promptops")
        .join("provider-accounts")
}

fn home_dir() -> String {
    if cfg!(windows) {
        std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into())
    } else {
        std::env::var("HOME").unwrap_or_else(|_| ".".into())
    }
}

/// ISO-8601 UTC with milliseconds and Z suffix (equivalent to `new Date().toISOString()`).
fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let millis = dur.as_millis() as i64;
    let secs = millis / 1000;
    let ms = (millis % 1000) as u32;

    // civil-from-days conversion (Howard Hinnant's algorithm), days since epoch.
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{ms:03}Z")
}

/// uniqueSlug(name, siblings) — base slug + `-N` suffix if it collides with the
/// basenames of the siblings' configDirs.
fn unique_slug(name: &str, siblings: &[&ProviderAccount]) -> String {
    let base = slugify(name);
    let taken: std::collections::HashSet<String> = siblings
        .iter()
        .map(|a| {
            Path::new(&a.config_dir)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        })
        .collect();
    if !taken.contains(&base) {
        return base;
    }
    let mut i = 2;
    while taken.contains(&format!("{base}-{i}")) {
        i += 1;
    }
    format!("{base}-{i}")
}

/// slugify(name) — lowercase, diacritics removal, non-alphanumerics → `-`,
/// trim hyphens at the edges; fallback "account".
/// NB: removing combining marks (NFKD) would require the `unicode-
/// normalization` crate, outside the allowed set; we remove the Unicode combining
/// marks already present as the closest approximation.
/// TODO: decompose with NFKD before stripping marks, if the crate is allowed.
fn slugify(name: &str) -> String {
    let lowered = name.to_lowercase();
    // Removes diacritics (combining marks U+0300..=U+036F).
    let stripped: String = lowered
        .chars()
        .filter(|c| !('\u{0300}'..='\u{036F}').contains(c))
        .collect();
    // Runs of non [a-z0-9] → '-'.
    let mut out = String::with_capacity(stripped.len());
    let mut prev_dash = false;
    for c in stripped.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        SLUG_FALLBACK.to_string()
    } else {
        trimmed
    }
}

fn dir_exists(p: &str) -> bool {
    std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

/// isManagedDir — true if `dir` is inside the managed providerRoot (non-empty rel,
/// does not climb with `..`, not absolute).
fn is_managed_dir(
    manager: &ProviderAccountManager,
    dir: &str,
    provider: &str,
) -> Result<bool, String> {
    let provider_root = manager.provider_root(provider)?;
    Ok(is_inside_root(&provider_root, Path::new(dir)))
}

/// `dir` is strictly below `root`, written without `.`/`..` segments. A stored
/// path like `<root>/x/../../..` must never pass: it is handed to
/// `remove_dir_all`.
fn is_inside_root(root: &Path, dir: &Path) -> bool {
    use std::path::Component;
    let Ok(rel) = dir.strip_prefix(root) else {
        return false;
    };
    let mut parts = rel.components().peekable();
    parts.peek().is_some() && parts.all(|c| matches!(c, Component::Normal(_)))
}

/// path.resolve(p) — makes it absolute relative to the cwd if relative, normalizes.
fn resolve_path(p: &str) -> String {
    let path = Path::new(p);
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    abs.to_string_lossy().into_owned()
}

// --- filesystem with permissions (mode 0o700) ------------------------------

/// fs.mkdir(dir, { recursive, mode: 0o700 }).
fn create_dir_mode(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    set_dir_mode(dir)
}

#[cfg(unix)]
fn set_dir_mode(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(DIR_MODE);
    std::fs::set_permissions(dir, perms).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn set_dir_mode(_dir: &Path) -> Result<(), String> {
    // POSIX permission bits don't apply on Windows.
    Ok(())
}

/// fs.cp(src, dst, { recursive, force }) — recursive copy of a directory.
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if file_type.is_symlink() {
            // Copy the symlink target as a file (force). Best-effort.
            let _ = std::fs::copy(&from, &to);
        } else {
            std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// --- shell.openPath / dialog (via OS + tauri-plugin-dialog) ---------------

/// shell.openPath(dir) — opens the folder in the system file manager.
fn open_path(dir: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::commands::util_cmd::cmd("open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        crate::commands::util_cmd::cmd("explorer")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        crate::commands::util_cmd::cmd("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// dialog.showOpenDialog({ properties: ['openDirectory'] }) — native folder picker.
/// Returns None if the user cancels. Uses tauri-plugin-dialog (already in the builder).
async fn pick_directory(app: &AppHandle, provider: &str) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let title = format!("Select existing {provider} config directory");
    // Non-blocking picker (see note in workspace_select): avoids the main thread
    // deadlock that `blocking_pick_folder()` causes when the command is sync.
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title(title).pick_folder(move |fp| {
        let _ = tx.send(fp);
    });
    rx.await
        .ok()
        .flatten()
        .and_then(|fp| fp.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod account_launch_tests {
    use super::*;

    fn account(id: &str) -> ProviderAccount {
        ProviderAccount {
            id: id.into(),
            name: id.into(),
            provider: "claude-code-cli".into(),
            command_alias: None,
            config_dir: format!("/test/accounts/{id}"),
            color: None,
            notes: None,
            created_at: "test".into(),
            updated_at: "test".into(),
        }
    }

    #[test]
    fn delete_only_ever_targets_folders_strictly_inside_the_managed_root() {
        let root = Path::new("/home/u/.promptops/provider-accounts/claude-code-cli");
        assert!(is_inside_root(root, &root.join("work")));
        assert!(is_inside_root(root, &root.join("work/sub")));
        assert!(!is_inside_root(root, root));
        assert!(!is_inside_root(root, Path::new("/home/u")));
        assert!(!is_inside_root(
            root,
            Path::new("/home/u/.promptops/provider-accounts/codex/x")
        ));
        // Climbing out after a valid first segment used to pass (`x/../..` does
        // not START with `..`) and would have reached remove_dir_all.
        assert!(!is_inside_root(root, &root.join("x/../../../..")));
        assert!(!is_inside_root(root, &root.join("../codex")));
    }

    #[test]
    fn managed_profiles_are_offered_only_where_an_env_var_isolates_them() {
        for (provider, cap) in CAPABILITIES {
            if cap.support != "unsupported" {
                assert!(
                    cap.env_var.is_some(),
                    "{provider}: a managed profile without an env var shares the login"
                );
            }
        }
        // agy has no config-dir variable: the old AGY_CONFIG_DIR was invented.
        assert!(CAPABILITIES
            .iter()
            .all(|(_, c)| c.env_var != Some("AGY_CONFIG_DIR")));
    }

    #[test]
    fn existing_alias_round_trip_and_legacy_accounts() {
        let legacy = serde_json::to_value(account("work")).unwrap();
        assert!(legacy.get("commandAlias").is_none());
        assert!(serde_json::from_value::<ProviderAccount>(legacy)
            .unwrap()
            .command_alias
            .is_none());
        let mut existing = account("personal");
        existing.command_alias = Some("claude-personal".into());
        existing.config_dir.clear();
        let restored: ProviderAccount =
            serde_json::from_str(&serde_json::to_string(&existing).unwrap()).unwrap();
        assert_eq!(restored.command_alias.as_deref(), Some("claude-personal"));
        assert!(restored.config_dir.is_empty());
    }

    #[test]
    fn existing_alias_preserves_resume_flags_and_rejects_shell_syntax() {
        for alias in ["claude-work", "codex_personal", "gemini.team"] {
            assert!(validate_command_alias(alias).is_ok());
        }
        for alias in [
            "",
            "claude work",
            "claude;id",
            "$(id)",
            "claude\nexit",
            "--help",
        ] {
            assert!(validate_command_alias(alias).is_err());
        }
        assert_eq!(
            override_launch_command(
                "claude --resume abc --model sonnet\r".into(),
                Some("claude-work")
            ),
            "claude-work --resume abc --model sonnet\r"
        );
        assert_eq!(
            override_launch_command("codex resume abc\r".into(), Some("codex-personal")),
            "codex-personal resume abc\r"
        );
    }

    #[test]
    fn saved_global_account_is_available_before_opening_accounts_ui() {
        let file =
            std::env::temp_dir().join(format!("promptops-account-test-{}.json", Uuid::new_v4()));
        let state = ProviderAccountState {
            accounts: vec![account("work"), account("personal")],
            active_by_provider: HashMap::from([("claude-code-cli".into(), "work".into())]),
            version: 1,
        };
        std::fs::write(&file, serde_json::to_vec(&state).unwrap()).unwrap();
        let manager = ProviderAccountManager::new();
        manager.init_from_file(file.clone()).unwrap();
        assert_eq!(
            manager
                .resolve_for_spawn("claude-code-cli", None)
                .account
                .unwrap()
                .id,
            "work"
        );
        // A subsequent UI init must not reload the previous choice from disk.
        manager
            .state
            .lock()
            .active_by_provider
            .insert("claude-code-cli".into(), "personal".into());
        manager.init_from_file(file.clone()).unwrap();
        assert_eq!(
            manager
                .resolve_for_spawn("claude-code-cli", None)
                .account
                .unwrap()
                .id,
            "personal"
        );
        assert_eq!(
            manager
                .resolve_for_spawn("claude-code-cli", Some(Some("work".into())))
                .account
                .unwrap()
                .id,
            "work"
        );
        assert!(manager
            .resolve_for_spawn("claude-code-cli", Some(None))
            .account
            .is_none());
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn invalid_store_is_reported_instead_of_selecting_personal_account() {
        let file =
            std::env::temp_dir().join(format!("promptops-account-test-{}.json", Uuid::new_v4()));
        std::fs::write(&file, b"invalid json").unwrap();
        let manager = ProviderAccountManager::new();
        assert!(manager.init_from_file(file.clone()).is_err());
        assert!(manager.state_file.lock().is_none());
        assert_eq!(std::fs::read(&file).unwrap(), b"invalid json");
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn managed_claude_config_and_credential_store_always_match() {
        let vars = account_env_vars(Some("CLAUDE_CONFIG_DIR"), "/accounts/work", "work");
        let mut cmd = portable_pty::CommandBuilder::new("unused-test-command");
        cmd.env("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/accounts/personal");
        for key in CLAUDE_AUTH_OVERRIDES {
            cmd.env(key, "fake-personal-secret");
        }
        apply_account_env(&mut cmd, &vars);
        assert_eq!(cmd.get_env("CLAUDE_CONFIG_DIR").unwrap(), "/accounts/work");
        assert_eq!(
            cmd.get_env("CLAUDE_SECURESTORAGE_CONFIG_DIR").unwrap(),
            "/accounts/work"
        );
        for key in CLAUDE_AUTH_OVERRIDES {
            assert!(cmd.get_env(key).is_none());
        }
    }

    #[test]
    fn other_providers_do_not_change_claude_authentication() {
        let vars = account_env_vars(Some("CODEX_HOME"), "/accounts/codex", "codex");
        assert_eq!(vars.len(), 2);
        assert!(account_shell_prefix(&vars, "/bin/sh").is_none());
        assert!(account_shell_prefix(&[], "/bin/sh").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn shell_startup_cannot_override_managed_account_and_paths_are_quoted() {
        // Dummy shell only: no Claude invocation, login, Keychain or real tokens.
        let path = "/accounts/work space/'$(printf BAD)`printf BAD`";
        let vars = account_env_vars(Some("CLAUDE_CONFIG_DIR"), path, "work");
        let prefix = account_shell_prefix(&vars, "/bin/sh").unwrap();
        let script = format!(
            "export CLAUDE_CONFIG_DIR=/personal CLAUDE_SECURESTORAGE_CONFIG_DIR=/personal ANTHROPIC_API_KEY=fake; {prefix} && printf '%s\\n' \"$CLAUDE_CONFIG_DIR\" \"$CLAUDE_SECURESTORAGE_CONFIG_DIR\" \"${{ANTHROPIC_API_KEY-unset}}\""
        );
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &script])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("{path}\n{path}\nunset\n")
        );
    }
}
