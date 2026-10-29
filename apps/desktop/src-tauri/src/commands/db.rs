//! Database explorer.
//!
//! Detection flow:
//!   1. saved config (active connection from the last successful detection)
//!   2. fast-path scan of the `.env` files
//!   3. AI fallback (spawn provider CLI) to analyze the project files
//!   4. connection test → persist to storage
//!
//! Supported databases: MySQL/MariaDB, PostgreSQL, SQLite,
//! MongoDB. Read-only, enforced by the database where it can be:
//! MySQL and PostgreSQL sessions are opened with `TRANSACTION READ ONLY`,
//! SQLite files are opened read-only. Generated queries are also checked
//! before they run (single SELECT; for MongoDB an allowlist of read calls).
//!
//! Drivers:
//!   - mysql / pgsql / sqlite  → `sqlx` (tokio runtime) for test/tables/query
//!     in-process, without shelling out to `psql`/`sqlite3`.
//!   - mongodb                 → shell-out to `mongosh` (no sqlx driver).
//!
//! The returned DTO shapes are `{ ok, error, ... }` envelopes: we return
//! `serde_json::Value` instead of making the Tauri command reject (so
//! `ok:false` stays a value, not an Err).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sqlx::mysql::{MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{Column, Row, TypeInfo, ValueRef};
use tauri::Manager;
use uuid::Uuid;

// ─────────────────────────────────────────────────────────────────────────
//  Types — DbConfig / SavedDbConfig / DbStore.
// ─────────────────────────────────────────────────────────────────────────

/// `DbConfig` — connection config. `type` (reserved word in Rust) is
/// mapped to `db_type` but serialized/deserialized as `"type"`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DbConfig {
    #[serde(rename = "type")]
    pub db_type: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub port: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub database: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub path: Option<String>,
}

/// `SavedDbConfig extends DbConfig` — config + identity for the multi-conn UI.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SavedDbConfig {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub config: DbConfig,
}

/// `DbStore` — persisted v2 format.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DbStore {
    pub version: u32,
    pub connections: Vec<SavedDbConfig>,
    #[serde(rename = "activeId")]
    pub active_id: Option<String>,
}

impl Default for DbStore {
    fn default() -> Self {
        Self {
            version: 2,
            connections: Vec::new(),
            active_id: None,
        }
    }
}

/// `Filter` — { column, operator, value }.
#[derive(Clone, Debug, Deserialize)]
pub struct Filter {
    pub column: String,
    pub operator: String,
    pub value: String,
}

// ─────────────────────────────────────────────────────────────────────────
//  State — cache of live connections keyed by workspace path (cwd).
// ─────────────────────────────────────────────────────────────────────────

/// Live connection cache entry. Only the config is kept: every query
/// reopens its own connection.
struct LiveConn {
    config: DbConfig,
}

#[derive(Default)]
pub struct DbManager {
    connections: Mutex<HashMap<String, LiveConn>>,
}

impl DbManager {
    pub fn new() -> Self {
        Self::default()
    }
}

// ─────────────────────────────────────────────────────────────────────────
//  Storage helpers — storage path, per-workspace key, load/save of the store.
// ─────────────────────────────────────────────────────────────────────────

/// Storage directory → `<userData>/db-explorer` (created if missing).
fn storage_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir not available: {e}"))?
        .join("db-explorer");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Per-workspace storage key: every non-alphanumeric char of cwd → '_'.
fn storage_key(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

fn store_file(app: &tauri::AppHandle, cwd: &str) -> Result<PathBuf, String> {
    Ok(storage_dir(app)?.join(format!("{}.json", storage_key(cwd))))
}

/// Display name derived from a connection config.
fn derive_name(config: &DbConfig) -> String {
    if let Some(db) = config.database.as_ref().filter(|s| !s.is_empty()) {
        return db.clone();
    }
    if let Some(p) = config.path.as_ref().filter(|s| !s.is_empty()) {
        return basename(p);
    }
    if let Some(uri) = config.uri.as_ref().filter(|s| !s.is_empty()) {
        // uri.replace(/:\/\/.*@/, '://').slice(0, 40)
        let stripped = strip_uri_creds(uri);
        return stripped.chars().take(40).collect();
    }
    if let Some(host) = config.host.as_ref().filter(|s| !s.is_empty()) {
        let port = config.port.map(|p| p.to_string()).unwrap_or_default();
        return format!("{host}:{port}");
    }
    config.db_type.clone()
}

/// path.basename(p).
fn basename(p: &str) -> String {
    let trimmed = p.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(p)
        .to_string()
}

/// uri.replace(/:\/\/.*@/, '://') — removes credentials between `://` and the last `@`.
fn strip_uri_creds(uri: &str) -> String {
    if let Some(scheme_end) = uri.find("://") {
        let after = &uri[scheme_end + 3..];
        if let Some(at) = after.rfind('@') {
            // greedy `.*@` ⇒ match up to the last @
            return format!("{}://{}", &uri[..scheme_end], &after[at + 1..]);
        }
    }
    uri.to_string()
}

/// Loads the store — reads the version-2 format, migrates the legacy single-config format.
/// Saved connections hold passwords and URIs, so they live in the encrypted
/// local store (`local_store.rs`), one record per workspace. Older versions
/// wrote `<userData>/db-explorer/<key>.json` in clear: it is imported once and removed.
const STORE_COLLECTION: &str = "db_connections";

fn load_store(app: &tauri::AppHandle, cwd: &str) -> DbStore {
    let key = storage_key(cwd);
    if let Some(value) = crate::local_store::get().and_then(|s| s.get(STORE_COLLECTION, &key)) {
        return serde_json::from_value(value).unwrap_or_default();
    }
    let path = match store_file(app, cwd) {
        Ok(p) => p,
        Err(_) => return DbStore::default(),
    };
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return DbStore::default(),
    };
    let data: JsonValue = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return DbStore::default(),
    };
    let store = legacy_store(app, cwd, data);
    save_store(app, cwd, &store);
    let _ = std::fs::remove_file(&path);
    store
}

/// Reads the plain file format of older versions.
fn legacy_store(app: &tauri::AppHandle, cwd: &str, data: JsonValue) -> DbStore {
    // v2 multi-connection format
    if data.get("version").and_then(|v| v.as_u64()) == Some(2)
        && data
            .get("connections")
            .map(|c| c.is_array())
            .unwrap_or(false)
    {
        if let Ok(store) = serde_json::from_value::<DbStore>(data.clone()) {
            return store;
        }
    }

    // Migrate the legacy single-config format → one saved connection.
    if data.get("type").and_then(|t| t.as_str()).is_some() {
        if let Ok(cfg) = serde_json::from_value::<DbConfig>(data.clone()) {
            let id = Uuid::new_v4().to_string();
            let name = derive_name(&cfg);
            let migrated = DbStore {
                version: 2,
                connections: vec![SavedDbConfig {
                    id: id.clone(),
                    name,
                    config: cfg,
                }],
                active_id: Some(id),
            };
            save_store(app, cwd, &migrated);
            return migrated;
        }
    }

    DbStore::default()
}

/// Saves the store — best effort.
fn save_store(_app: &tauri::AppHandle, cwd: &str, store: &DbStore) {
    if let (Some(local), Ok(value)) = (crate::local_store::get(), serde_json::to_value(store)) {
        let _ = local.put(STORE_COLLECTION, &storage_key(cwd), value);
    }
}

/// Active saved connection for the workspace.
fn get_active_config(app: &tauri::AppHandle, cwd: &str) -> Option<SavedDbConfig> {
    let store = load_store(app, cwd);
    let active = store.active_id.as_ref()?;
    store.connections.into_iter().find(|c| &c.id == active)
}

/// True when two configs point to the same database.
fn same_target(a: &DbConfig, b: &DbConfig) -> bool {
    let s = |o: &Option<String>| o.clone().unwrap_or_default();
    let p = |o: &Option<u32>| o.unwrap_or(0);
    a.db_type == b.db_type
        && s(&a.host) == s(&b.host)
        && p(&a.port) == p(&b.port)
        && s(&a.database) == s(&b.database)
        && s(&a.path) == s(&b.path)
        && s(&a.uri) == s(&b.uri)
}

/// Upserts a config (optional name and id) → id. Adds/updates, activates, persists.
fn upsert_config(
    app: &tauri::AppHandle,
    cwd: &str,
    config: &DbConfig,
    name: Option<&str>,
    id: Option<&str>,
) -> String {
    let mut store = load_store(app, cwd);

    if let Some(id) = id {
        if let Some(idx) = store.connections.iter().position(|c| c.id == id) {
            let kept_name = store.connections[idx].name.clone();
            store.connections[idx] = SavedDbConfig {
                id: id.to_string(),
                name: name
                    .map(|n| n.to_string())
                    .filter(|n| !n.is_empty())
                    .unwrap_or(kept_name),
                config: config.clone(),
            };
            store.active_id = Some(id.to_string());
            save_store(app, cwd, &store);
            return id.to_string();
        }
    }

    // De-dupe identical connections.
    if let Some(idx) = store
        .connections
        .iter()
        .position(|c| same_target(&c.config, config))
    {
        store.connections[idx].config = config.clone();
        if let Some(n) = name.filter(|n| !n.is_empty()) {
            store.connections[idx].name = n.to_string();
        }
        let existing_id = store.connections[idx].id.clone();
        store.active_id = Some(existing_id.clone());
        save_store(app, cwd, &store);
        return existing_id;
    }

    let new_id = Uuid::new_v4().to_string();
    let resolved_name = name
        .map(|n| n.to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| derive_name(config));
    store.connections.push(SavedDbConfig {
        id: new_id.clone(),
        name: resolved_name,
        config: config.clone(),
    });
    store.active_id = Some(new_id.clone());
    save_store(app, cwd, &store);
    new_id
}

/// Config without secrets — { type, host, port, database }.
fn sanitize_config(config: &DbConfig) -> JsonValue {
    let database = config
        .database
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| config.path.clone().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "unknown".to_string());
    json!({
        "type": config.db_type,
        "host": config.host,
        "port": config.port,
        "database": database,
    })
}

/// Saved connections — { connections: [{ id, name, type, host, port, database }], activeId }.
fn list_saved(app: &tauri::AppHandle, cwd: &str) -> JsonValue {
    let store = load_store(app, cwd);
    let connections: Vec<JsonValue> = store
        .connections
        .iter()
        .map(|c| {
            let mut obj = sanitize_config(&c.config);
            // { id, name, ...sanitizeConfig(c) } — id/name come first but are
            // distinct keys, so the order doesn't change the JSON result.
            if let Some(map) = obj.as_object_mut() {
                map.insert("id".to_string(), json!(c.id));
                map.insert("name".to_string(), json!(c.name));
            }
            obj
        })
        .collect();
    json!({ "connections": connections, "activeId": store.active_id })
}

// ─────────────────────────────────────────────────────────────────────────
//  Tauri commands — one command per database-explorer IPC call.
//  They return `serde_json::Value` envelopes (`{ ok, ... }`).
// ─────────────────────────────────────────────────────────────────────────

/// db:detect — DB config (storage → .env → AI), test + persist.
#[tauri::command]
pub async fn db_detect(
    app: tauri::AppHandle,
    cwd: String,
    provider: Option<String>,
    force_refresh: Option<bool>,
) -> Result<JsonValue, String> {
    let force = force_refresh.unwrap_or(false);

    // 1. active saved config (skipped on force refresh).
    if !force {
        if let Some(stored) = get_active_config(&app, &cwd) {
            return Ok(json!({
                "ok": true,
                "config": sanitize_config(&stored.config),
                "id": stored.id,
                "fromStorage": true,
            }));
        }
    }

    // 2. fast-path scan of .env.
    if let Some(env_config) = detect_from_env_files(&cwd) {
        if test_connection(&env_config, &cwd).await.is_ok() {
            let id = upsert_config(&app, &cwd, &env_config, None, None);
            return Ok(json!({
                "ok": true,
                "config": sanitize_config(&env_config),
                "id": id,
                "fromStorage": false,
            }));
        }
        // .env didn't work → fall through to the AI.
    }

    // 3. AI provider scan.
    let provider = match provider {
        Some(p) if !p.is_empty() => p,
        _ => {
            return Ok(json!({
                "ok": false,
                "error": "No database configuration found. AI scan requires a provider.",
            }));
        }
    };

    let ai_config = detect_with_ai(&cwd, &provider).await;
    let ai_config = match ai_config {
        Some(c) => c,
        None => {
            return Ok(json!({
                "ok": false,
                "error": "AI could not find any database configuration in this project.",
            }));
        }
    };

    // 4. test of the config found by the AI.
    if let Err(e) = test_connection(&ai_config, &cwd).await {
        return Ok(json!({ "ok": false, "error": e }));
    }

    // 5. persist.
    let id = upsert_config(&app, &cwd, &ai_config, None, None);
    // Credit the 'db-ai-detect' AI prompt — only the AI path counts.
    crate::commands::session::credit_ai_utility(&app, "db-ai-detect", None, Some(&cwd));
    Ok(json!({
        "ok": true,
        "config": sanitize_config(&ai_config),
        "id": id,
        "fromStorage": false,
    }))
}

/// db:connect — connects using the saved active config.
#[tauri::command]
pub async fn db_connect(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<DbManager>>,
    cwd: String,
) -> Result<JsonValue, String> {
    let config = match get_active_config(&app, &cwd) {
        Some(c) => c,
        None => {
            return Ok(json!({
                "ok": false,
                "error": "No stored database configuration. Run detect first.",
            }));
        }
    };

    if let Err(e) = test_connection(&config.config, &cwd).await {
        return Ok(json!({ "ok": false, "error": e }));
    }

    let db = active_database_label(&config.config);
    let db_type = config.config.db_type.clone();
    manager.connections.lock().insert(
        cwd,
        LiveConn {
            config: config.config,
        },
    );
    Ok(json!({ "ok": true, "type": db_type, "database": db, "id": config.id }))
}

/// db:list-configs — saved connections + activeId.
#[tauri::command]
pub fn db_list_configs(app: tauri::AppHandle, cwd: String) -> Result<JsonValue, String> {
    let mut envelope = list_saved(&app, &cwd);
    if let Some(map) = envelope.as_object_mut() {
        map.insert("ok".to_string(), json!(true));
    }
    Ok(envelope)
}

/// db:switch-config — activates a saved connection (with test).
#[tauri::command]
pub async fn db_switch_config(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<DbManager>>,
    cwd: String,
    id: String,
) -> Result<JsonValue, String> {
    let mut store = load_store(&app, &cwd);
    let target = match store.connections.iter().find(|c| c.id == id).cloned() {
        Some(t) => t,
        None => return Ok(json!({ "ok": false, "error": "Connection not found." })),
    };

    if let Err(e) = test_connection(&target.config, &cwd).await {
        return Ok(json!({ "ok": false, "error": e }));
    }

    store.active_id = Some(id.clone());
    save_store(&app, &cwd, &store);
    let db = active_database_label(&target.config);
    manager.connections.lock().insert(
        cwd,
        LiveConn {
            config: target.config.clone(),
        },
    );
    Ok(json!({ "ok": true, "type": target.config.db_type, "database": db, "id": id }))
}

/// db:delete-config — removes a saved connection, recomputes activeId.
#[tauri::command]
pub fn db_delete_config(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<DbManager>>,
    cwd: String,
    id: String,
) -> Result<JsonValue, String> {
    let mut store = load_store(&app, &cwd);
    store.connections.retain(|c| c.id != id);
    if store.active_id.as_deref() == Some(id.as_str()) {
        store.active_id = store.connections.first().map(|c| c.id.clone());
        manager.connections.lock().remove(&cwd);
    }
    save_store(&app, &cwd, &store);

    let mut envelope = list_saved(&app, &cwd);
    if let Some(map) = envelope.as_object_mut() {
        map.insert("ok".to_string(), json!(true));
    }
    Ok(envelope)
}

/// db:tables — list of tables / collections of the live connection.
#[tauri::command]
pub async fn db_tables(
    manager: tauri::State<'_, Arc<DbManager>>,
    cwd: String,
) -> Result<JsonValue, String> {
    let config = {
        let guard = manager.connections.lock();
        match guard.get(&cwd) {
            Some(entry) => entry.config.clone(),
            None => return Ok(json!({ "ok": false, "error": "Not connected" })),
        }
    };
    match list_tables(&config, &cwd).await {
        Ok(tables) => Ok(json!({ "ok": true, "tables": tables })),
        Err(e) => Ok(json!({ "ok": false, "error": e })),
    }
}

/// db:query — paginated/filtered/sorted read-only SELECT.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn db_query(
    manager: tauri::State<'_, Arc<DbManager>>,
    cwd: String,
    table: String,
    limit: Option<i64>,
    offset: Option<i64>,
    filters: Option<Vec<Filter>>,
    order_by: Option<String>,
    order_dir: Option<String>,
) -> Result<JsonValue, String> {
    let config = {
        let guard = manager.connections.lock();
        match guard.get(&cwd) {
            Some(entry) => entry.config.clone(),
            None => return Ok(json!({ "ok": false, "error": "Not connected" })),
        }
    };

    let result = query_table(
        &config,
        &cwd,
        &table,
        limit.unwrap_or(50),
        offset.unwrap_or(0),
        filters.as_deref(),
        order_by.as_deref(),
        order_dir.as_deref(),
    )
    .await;

    match result {
        Ok(r) => Ok(json!({ "ok": true, "columns": r.columns, "rows": r.rows, "total": r.total })),
        Err(e) => Ok(json!({ "ok": false, "error": e })),
    }
}

/// db:nl-query — natural-language question → a read-only query
/// generated by the AI provider, validated and executed (port of DB_NL_QUERY).
/// Result always { ok, ... } (never reject).
#[tauri::command]
pub async fn db_nl_query(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<DbManager>>,
    cwd: String,
    question: String,
    provider: Option<String>,
) -> Result<JsonValue, String> {
    let config = {
        let guard = manager.connections.lock();
        match guard.get(&cwd) {
            Some(entry) => entry.config.clone(),
            None => return Ok(json!({ "ok": false, "error": "Not connected" })),
        }
    };
    let question = question.trim().to_string();
    if question.is_empty() {
        return Ok(json!({ "ok": false, "error": "Empty question" }));
    }
    let Some(provider) = provider.filter(|p| !p.is_empty()) else {
        return Ok(json!({
            "ok": false,
            "error": "AI provider required to translate natural language."
        }));
    };

    // 1. Schema snapshot for AI grounding.
    let schema = schema_context(&config, &cwd).await;

    // 2. NL → query via provider CLI (blocking: outside the async runtime).
    let prompt = build_nl_prompt(&config.db_type, &schema, &question);
    let ai_cwd = cwd.clone();
    let raw = tauri::async_runtime::spawn_blocking(move || {
        crate::commands::providers::spawn_provider(&provider, &prompt, &ai_cwd)
    })
    .await
    .map_err(|e| e.to_string())?;
    let generated = match raw {
        Ok(text) => clean_generated_query(&text),
        Err(e) => {
            eprintln!("[db:nl-query] AI translation failed: {e}");
            None
        }
    };
    let Some(query) = generated else {
        return Ok(json!({
            "ok": false,
            "error": "AI could not generate a query for that request."
        }));
    };

    // 3. Read-only guardrail.
    if let Err(e) = assert_read_only(&query, &config.db_type) {
        return Ok(json!({ "ok": false, "error": e }));
    }

    // 4. Execution + 'db-nl-query' prompt credit (only the successful AI
    //    path counts).
    match run_raw_query(&config, &cwd, &query).await {
        Ok(r) => {
            crate::commands::session::credit_ai_utility_with_text(
                &app,
                "db-nl-query",
                None,
                Some(&cwd),
                Some(&question),
            );
            Ok(json!({
                "ok": true,
                "query": query,
                "columns": r.columns,
                "rows": r.rows,
                "total": r.total
            }))
        }
        Err(e) => Ok(json!({ "ok": false, "error": e })),
    }
}

/// `table(col:type, ...)` schema for the NL prompt (cap 60 tables).
/// Best-effort: on error it degrades to table names only.
async fn schema_context(config: &DbConfig, cwd: &str) -> String {
    let tables: Vec<String> = list_tables(config, cwd)
        .await
        .unwrap_or_default()
        .into_iter()
        .take(60)
        .collect();
    let cols_by_table: std::collections::HashMap<String, Vec<String>> =
        match config.db_type.as_str() {
            "mysql" => {
                mysql_schema_columns(
                    &mysql_url(config),
                    "SELECT TABLE_NAME AS t, CONCAT(COLUMN_NAME, ':', DATA_TYPE) AS c \
                 FROM information_schema.columns WHERE table_schema = DATABASE() \
                 ORDER BY TABLE_NAME, ORDINAL_POSITION",
                )
                .await
            }
            "pgsql" => {
                pgsql_schema_columns(
                    &pgsql_url(config),
                    "SELECT table_name AS t, column_name || ':' || data_type AS c \
                 FROM information_schema.columns WHERE table_schema = 'public' \
                 ORDER BY table_name, ordinal_position",
                )
                .await
            }
            "sqlite" => sqlite_schema_columns(config, cwd, &tables).await,
            _ => Default::default(), // mongodb: collection names only
        };
    tables
        .iter()
        .map(|t| match cols_by_table.get(t) {
            Some(cols) if !cols.is_empty() => format!("{t}({})", cols.join(", ")),
            _ => t.clone(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Columns per table in a single query (rows { t, c }) — MySQL.
async fn mysql_schema_columns(url: &str, sql: &str) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = Default::default();
    let Ok(pool) = connect_mysql(url).await else {
        return out;
    };
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql.to_owned()))
        .fetch_all(&pool)
        .await;
    pool.close().await;
    let Ok(rows) = rows else { return out };
    let total = rows.len() as i64;
    collect_schema_columns(mysql_rows_to_result(&rows, total), &mut out);
    out
}

/// Same for PostgreSQL.
async fn pgsql_schema_columns(url: &str, sql: &str) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = Default::default();
    let Ok(pool) = connect_pgsql(url).await else {
        return out;
    };
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql.to_owned()))
        .fetch_all(&pool)
        .await;
    pool.close().await;
    let Ok(rows) = rows else { return out };
    let total = rows.len() as i64;
    collect_schema_columns(pgsql_rows_to_result(&rows, total), &mut out);
    out
}

fn collect_schema_columns(res: QueryResult, out: &mut HashMap<String, Vec<String>>) {
    for row in res.rows {
        if let (Some(t), Some(c)) = (
            row.get("t").and_then(|v| v.as_str()),
            row.get("c").and_then(|v| v.as_str()),
        ) {
            out.entry(t.to_string()).or_default().push(c.to_string());
        }
    }
}

/// SQLite: pragma_table_info per table on a single pool.
async fn sqlite_schema_columns(
    config: &DbConfig,
    cwd: &str,
    tables: &[String],
) -> std::collections::HashMap<String, Vec<String>> {
    let mut out: std::collections::HashMap<String, Vec<String>> = Default::default();
    let db_path = resolve_sqlite_path(config, cwd);
    let Ok(pool) = connect_sqlite(&sqlite_url(&db_path)).await else {
        return out;
    };
    for t in tables {
        let sql = format!(
            "SELECT name || ':' || type AS c FROM pragma_table_info('{}')",
            t.replace('\'', "''")
        );
        if let Ok(rows) = sqlx::query(sqlx::AssertSqlSafe(sql.clone()))
            .fetch_all(&pool)
            .await
        {
            let total = rows.len() as i64;
            let cols: Vec<String> = sqlite_rows_to_result(&rows, total)
                .rows
                .iter()
                .filter_map(|r| r.get("c").and_then(|v| v.as_str()).map(str::to_string))
                .collect();
            if !cols.is_empty() {
                out.insert(t.clone(), cols);
            }
        }
    }
    pool.close().await;
    out
}

/// NL→query prompt.
fn build_nl_prompt(db_type: &str, schema: &str, question: &str) -> String {
    let dialect = match db_type {
        "pgsql" => "PostgreSQL",
        "sqlite" => "SQLite",
        "mongodb" => "MongoDB (mongosh)",
        _ => "MySQL",
    };
    let hint = if db_type == "mongodb" {
        "Reply with ONLY one JSON object (MongoDB Extended JSON, e.g. {\"$date\":\"2026-01-01T00:00:00Z\"} or {\"$oid\":\"...\"} for dates and ids), no JavaScript, in one of these shapes:\n\
{\"collection\":\"name\",\"op\":\"find\",\"filter\":{...},\"projection\":{...},\"sort\":{...},\"limit\":N}\n\
{\"collection\":\"name\",\"op\":\"aggregate\",\"pipeline\":[...]}\n\
{\"collection\":\"name\",\"op\":\"countDocuments\",\"filter\":{...}}\n\
{\"collection\":\"name\",\"op\":\"distinct\",\"field\":\"name\",\"filter\":{...}}\n\
Read-only: no $out, $merge, $where, $function or $accumulator. Limit at most 500."
    } else {
        "Reply with ONLY a single read-only SQL SELECT statement (a leading WITH ... SELECT is allowed). No INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE. Add a sensible LIMIT (max 500) if none is implied."
    };
    format!(
        "You translate natural-language questions into a {dialect} query.\n\n\
         Database schema (table(columns)):\n{schema}\n\n\
         User question: \"{question}\"\n\n\
         {hint}\n\
         No explanation, no markdown, no code fences — output the query only."
    )
}

/// AI output cleanup: fences, "sql:" label, trailing semicolon.
fn clean_generated_query(raw: &str) -> Option<String> {
    let fence_start = regex::Regex::new(r"^```[a-zA-Z]*\s*").unwrap();
    let fence_end = regex::Regex::new(r"```\s*$").unwrap();
    let label = regex::Regex::new(r"(?i)^(query|sql|mongo(db)?)\s*[:=]\s*").unwrap();
    let semi = regex::Regex::new(r";\s*$").unwrap();

    let mut cleaned = raw.trim().to_string();
    cleaned = fence_start.replace(&cleaned, "").to_string();
    cleaned = fence_end.replace(&cleaned, "").trim().to_string();
    cleaned = label.replace(&cleaned, "").trim().to_string();
    if cleaned.is_empty() {
        return None;
    }
    Some(semi.replace(&cleaned, "").to_string())
}

/// Read-only guardrail for generated queries. For MySQL and PostgreSQL the
/// session is read-only anyway (see `connect_mysql`); for MongoDB this check
/// is the only barrier, so it is an allowlist, not a blocklist.
fn assert_read_only(query: &str, db_type: &str) -> Result<(), String> {
    if db_type == "mongodb" {
        return parse_mongo_spec(query).map(|_| ());
    }
    if query.contains(';') {
        return Err("Only a single statement is allowed.".into());
    }
    if !regex::Regex::new(r"(?i)^\s*(select|with)\b")
        .unwrap()
        .is_match(query)
    {
        return Err("Only SELECT queries are allowed.".into());
    }
    // A read-only transaction still lets a SELECT call functions with side
    // effects outside the data: ending other sessions, reloading the server
    // configuration, reading server files, holding locks, sleeping, opening
    // connections to other servers. The prompt carries text read from the
    // database (table names), so the model's answer is not trusted either.
    let forbidden = regex::Regex::new(
        r"(?i)\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|merge|call|exec|execute|attach|detach|pragma|into|copy|lock|vacuum|reindex|load_file|load_extension|outfile|dumpfile|set_config|nextval|setval|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_promote|pg_switch_wal|pg_create_restore_point|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_sleep\w*|pg_(?:try_)?advisory\w*|dblink\w*|lo_\w+|sleep|benchmark|get_lock|release_lock|release_all_locks|sys_exec|sys_eval)\b",
    )
    .unwrap();
    if forbidden.is_match(query) {
        return Err("Only read-only queries are allowed.".into());
    }
    Ok(())
}

/// A generated MongoDB query, validated. mongosh runs JavaScript, and the
/// model's prompt carries text read from the database (collection names), so
/// generated text is never evaluated: the model answers with JSON, the JSON is
/// checked here, and a FIXED script receives it as a string literal and only
/// parses it (`EJSON.parse`). Nothing in the answer can become code.
#[derive(Debug, Clone, PartialEq)]
struct MongoSpec {
    collection: String,
    op: &'static str,
    filter: JsonValue,
    projection: JsonValue,
    sort: JsonValue,
    pipeline: JsonValue,
    field: String,
    limit: i64,
}

/// Most rows a generated query may return.
const MONGO_NL_MAX_ROWS: i64 = 500;

/// Operators that run JavaScript on the server or write: refused at any depth.
/// `$code`/`$scope` are the Extended JSON forms of a JavaScript value.
const MONGO_FORBIDDEN_KEYS: &[&str] = &[
    "$where",
    "$function",
    "$accumulator",
    "$out",
    "$merge",
    "$code",
    "$scope",
];

fn parse_mongo_spec(text: &str) -> Result<MongoSpec, String> {
    let refuse = |why: &str| {
        Err(format!(
            "Only read-only find/aggregate queries are allowed ({why})."
        ))
    };
    let Ok(JsonValue::Object(obj)) = serde_json::from_str::<JsonValue>(text.trim()) else {
        return refuse("the answer is not a JSON query object");
    };
    if let Some(key) = forbidden_mongo_key(&JsonValue::Object(obj.clone())) {
        return refuse(&format!("{key} is not allowed"));
    }
    let collection = obj.get("collection").and_then(|v| v.as_str()).unwrap_or("");
    if !is_collection_name(collection) {
        return refuse("invalid collection name");
    }
    let op = match obj.get("op").and_then(|v| v.as_str()) {
        Some("find") => "find",
        Some("aggregate") => "aggregate",
        Some("countDocuments") | Some("count") => "countDocuments",
        Some("distinct") => "distinct",
        _ => return refuse("unknown operation"),
    };
    let object_or_empty = |key: &str| -> Result<JsonValue, String> {
        match obj.get(key) {
            None | Some(JsonValue::Null) => Ok(json!({})),
            Some(v @ JsonValue::Object(_)) => Ok(v.clone()),
            Some(_) => Err(format!(
                "Only read-only find/aggregate queries are allowed ({key} must be an object)."
            )),
        }
    };
    let filter = object_or_empty("filter")?;
    let projection = object_or_empty("projection")?;
    let sort = object_or_empty("sort")?;
    let mut pipeline = match obj.get("pipeline") {
        None | Some(JsonValue::Null) if op != "aggregate" => json!([]),
        Some(JsonValue::Array(stages)) if stages.iter().all(|s| s.is_object()) => {
            JsonValue::Array(stages.clone())
        }
        _ => return refuse("pipeline must be an array of stages"),
    };
    if op == "aggregate" {
        // Same cap as find, whatever the pipeline asks.
        if let Some(stages) = pipeline.as_array_mut() {
            stages.push(json!({ "$limit": MONGO_NL_MAX_ROWS }));
        }
    }
    let field = obj
        .get("field")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if op == "distinct"
        && (field.is_empty()
            || field.starts_with('$')
            || field.len() > 128
            || !field
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | '-')))
    {
        return refuse("invalid distinct field");
    }
    let limit = obj
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(100)
        .clamp(1, MONGO_NL_MAX_ROWS);
    Ok(MongoSpec {
        collection: collection.to_string(),
        op,
        filter,
        projection,
        sort,
        pipeline,
        field,
        limit,
    })
}

/// First forbidden operator found at any depth (object keys only).
fn forbidden_mongo_key(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::Object(map) => map.iter().find_map(|(k, v)| {
            if MONGO_FORBIDDEN_KEYS
                .iter()
                .any(|f| k.trim().eq_ignore_ascii_case(f))
            {
                Some(k.clone())
            } else {
                forbidden_mongo_key(v)
            }
        }),
        JsonValue::Array(items) => items.iter().find_map(forbidden_mongo_key),
        _ => None,
    }
}

/// The mongosh script for a validated spec. The only variable part is one
/// JSON string literal that the fixed code parses; it is never evaluated.
fn mongo_spec_script(spec: &MongoSpec) -> String {
    let payload = json!({
        "collection": spec.collection,
        "op": spec.op,
        "filter": spec.filter,
        "projection": spec.projection,
        "sort": spec.sort,
        "pipeline": spec.pipeline,
        "field": spec.field,
        "limit": spec.limit,
    })
    .to_string();
    let literal = serde_json::to_string(&payload).unwrap_or_else(|_| "\"{}\"".into());
    format!(
        "const __po = EJSON.parse({literal}, {{ relaxed: true }});\n\
         const __c = db.getCollection(__po.collection);\n\
         let __r;\n\
         if (__po.op === 'find') __r = __c.find(__po.filter, __po.projection).sort(__po.sort).limit(__po.limit).toArray();\n\
         else if (__po.op === 'aggregate') __r = __c.aggregate(__po.pipeline).toArray();\n\
         else if (__po.op === 'countDocuments') __r = [{{ count: __c.countDocuments(__po.filter) }}];\n\
         else if (__po.op === 'distinct') __r = __c.distinct(__po.field, __po.filter).slice(0, __po.limit).map(v => ({{ value: v }}));\n\
         else __r = [];\n\
         JSON.stringify(__r)"
    )
}

/// Raw execution of the generated query (port of runRawQuery).
async fn run_raw_query(config: &DbConfig, cwd: &str, query: &str) -> Result<QueryResult, String> {
    match config.db_type.as_str() {
        "mysql" => raw_mysql(&mysql_url(config), query).await,
        "pgsql" => raw_pgsql(&pgsql_url(config), query).await,
        "sqlite" => {
            let db_path = resolve_sqlite_path(config, cwd);
            raw_sqlite(&sqlite_url(&db_path), query).await
        }
        "mongodb" => raw_mongo(config, query),
        other => Err(format!("Unsupported DB type: {other}")),
    }
}

async fn raw_mysql(url: &str, query: &str) -> Result<QueryResult, String> {
    let pool = connect_mysql(url).await?;
    let rows = sqlx::query(sqlx::AssertSqlSafe(query.to_owned()))
        .fetch_all(&pool)
        .await;
    pool.close().await;
    let rows = rows.map_err(|e| e.to_string())?;
    let total = rows.len() as i64;
    Ok(mysql_rows_to_result(&rows, total))
}

async fn raw_pgsql(url: &str, query: &str) -> Result<QueryResult, String> {
    let pool = connect_pgsql(url).await?;
    let rows = sqlx::query(sqlx::AssertSqlSafe(query.to_owned()))
        .fetch_all(&pool)
        .await;
    pool.close().await;
    let rows = rows.map_err(|e| e.to_string())?;
    let total = rows.len() as i64;
    Ok(pgsql_rows_to_result(&rows, total))
}

async fn raw_sqlite(url: &str, query: &str) -> Result<QueryResult, String> {
    let pool = connect_sqlite(url).await?;
    let rows = sqlx::query(sqlx::AssertSqlSafe(query.to_owned()))
        .fetch_all(&pool)
        .await;
    pool.close().await;
    let rows = rows.map_err(|e| e.to_string())?;
    let total = rows.len() as i64;
    Ok(sqlite_rows_to_result(&rows, total))
}

fn raw_mongo(config: &DbConfig, query: &str) -> Result<QueryResult, String> {
    let uri = config.uri.clone().unwrap_or_default();
    // Validated again here: this path never runs text it has not parsed.
    let spec = parse_mongo_spec(query)?;
    let raw = run_mongosh(&uri, &mongo_spec_script(&spec), 20_000)?;
    let trimmed = raw.trim();
    match serde_json::from_str::<JsonValue>(trimmed) {
        Ok(parsed) => {
            let docs: Vec<JsonValue> = match parsed {
                JsonValue::Array(a) => a,
                v => vec![v],
            };
            let columns: Vec<String> = docs
                .first()
                .and_then(|d| d.as_object())
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_else(|| vec!["value".into()]);
            let rows: Vec<JsonValue> = docs
                .into_iter()
                .map(|d| {
                    if d.is_object() {
                        d
                    } else {
                        json!({ "value": d })
                    }
                })
                .collect();
            let total = rows.len() as i64;
            Ok(QueryResult {
                columns,
                rows,
                total,
            })
        }
        Err(_) => Ok(QueryResult {
            columns: vec!["result".into()],
            rows: vec![json!({ "result": trimmed })],
            total: 1,
        }),
    }
}

/// db:manual-connect — user-provided config: validates, tests, saves, activates.
#[tauri::command]
pub async fn db_manual_connect(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<DbManager>>,
    cwd: String,
    config: DbConfig,
    name: Option<String>,
    id: Option<String>,
) -> Result<JsonValue, String> {
    let valid_types = ["mysql", "pgsql", "sqlite", "mongodb"];
    if !valid_types.contains(&config.db_type.as_str()) {
        return Ok(json!({ "ok": false, "error": "Invalid database type." }));
    }

    if let Err(e) = test_connection(&config, &cwd).await {
        return Ok(json!({ "ok": false, "error": e }));
    }

    let saved_id = upsert_config(&app, &cwd, &config, name.as_deref(), id.as_deref());
    let db = active_database_label(&config);
    manager.connections.lock().insert(
        cwd,
        LiveConn {
            config: config.clone(),
        },
    );

    Ok(json!({ "ok": true, "type": config.db_type, "database": db, "id": saved_id }))
}

/// db:disconnect — removes the live connection.
#[tauri::command]
pub fn db_disconnect(
    manager: tauri::State<'_, Arc<DbManager>>,
    cwd: String,
) -> Result<JsonValue, String> {
    manager.connections.lock().remove(&cwd);
    Ok(json!({ "ok": true }))
}

/// `config.database || config.path || 'unknown'` — DB label for the envelopes.
fn active_database_label(config: &DbConfig) -> String {
    config
        .database
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| config.path.clone().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "unknown".to_string())
}

// ─────────────────────────────────────────────────────────────────────────
//  AI detection — gathers project context and asks the provider CLI.
// ─────────────────────────────────────────────────────────────────────────

async fn detect_with_ai(cwd: &str, provider: &str) -> Option<DbConfig> {
    // Secret values never leave the machine: the agent sees markers, the
    // real values are put back into the configuration it returns.
    let mut secrets = SecretRedactor::default();
    let context = gather_project_context(cwd, &mut secrets)?;

    let prompt = format!(
        "You are analyzing a project to find its database connection configuration.\n\n\
Here are relevant files from the project at \"{cwd}\":\n\n\
{context}\n\n\
Based on these files, extract the database connection details. Reply with ONLY a JSON object, no explanation, no markdown, no code fences. The JSON must have these fields:\n\
- \"type\": one of \"mysql\", \"pgsql\", \"sqlite\", \"mongodb\"\n\
- \"host\": hostname (optional for sqlite/mongodb)\n\
- \"port\": port number (optional for sqlite/mongodb)\n\
- \"database\": database name or path\n\
- \"username\": username (optional for sqlite/mongodb)\n\
- \"password\": password (optional for sqlite/mongodb)\n\
- \"uri\": connection URI (for mongodb or DATABASE_URL style)\n\
- \"path\": file path (for sqlite)\n\n\
Secret values in these files were replaced by markers like [redacted:1]. Where a secret belongs \
(password, or the password inside a URI), copy its marker exactly as written.\n\
If you find multiple databases, pick the primary/default one.\n\
If you cannot find any database configuration, reply with exactly: null"
    );

    let raw = match spawn_provider(provider, &prompt, cwd, 90_000) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[db:detect] AI detection failed: {e}");
            return None;
        }
    };

    // raw.trim().replace(/^```json\s*/i,'').replace(/```\s*$/,'').trim()
    let mut cleaned = raw.trim().to_string();
    if let Some(rest) = strip_json_fence_prefix(&cleaned) {
        cleaned = rest;
    }
    if let Some(rest) = strip_fence_suffix(&cleaned) {
        cleaned = rest;
    }
    let cleaned = cleaned.trim();

    if cleaned == "null" || cleaned.is_empty() {
        return None;
    }

    let mut parsed: JsonValue = serde_json::from_str(cleaned).ok()?;
    secrets.restore_json(&mut parsed);
    let db_type = parsed.get("type").and_then(|t| t.as_str())?;
    let valid_types = ["mysql", "pgsql", "sqlite", "mongodb"];
    if !valid_types.contains(&db_type) {
        return None;
    }
    serde_json::from_value::<DbConfig>(parsed).ok()
}

/// Strips an optional ```json prefix (case-insensitive) + spaces.
fn strip_json_fence_prefix(s: &str) -> Option<String> {
    let lower = s.to_ascii_lowercase();
    if lower.starts_with("```json") {
        Some(s[7..].trim_start().to_string())
    } else {
        None
    }
}

/// Strips an optional ``` suffix + spaces.
fn strip_fence_suffix(s: &str) -> Option<String> {
    let trimmed = s.trim_end();
    trimmed
        .strip_suffix("```")
        .map(|rest| rest.trim_end().to_string())
}

/// The first `max` bytes of `s`, cut back to a character boundary: slicing a
/// UTF-8 string inside a character panics.
fn head_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    &s[..cut]
}

/// True when `file` resolves (symlinks followed) to a place inside `root`.
/// A repository can ship `.env -> ~/.aws/credentials` or
/// `config/database.yml -> ../../.netrc`: those must never reach the agent.
fn resolves_inside(root: &Path, file: &Path) -> bool {
    match file.canonicalize() {
        Ok(real) => real.starts_with(root),
        Err(_) => false,
    }
}

fn gather_project_context(cwd: &str, secrets: &mut SecretRedactor) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    let root = Path::new(cwd).canonicalize().ok()?;

    let config_files = [
        ".env",
        ".env.local",
        ".env.development",
        ".env.production",
        "config/database.php",
        "config/database.js",
        "config/database.ts",
        "docker-compose.yml",
        "docker-compose.yaml",
        "knexfile.js",
        "knexfile.ts",
        "ormconfig.json",
        "ormconfig.js",
        "ormconfig.ts",
        "prisma/schema.prisma",
        "src/config/database.ts",
        "src/config/database.js",
        "settings.py",
        "config/settings.py",
        "config/settings/base.py",
        "application.properties",
        "application.yml",
        "src/main/resources/application.properties",
        "src/main/resources/application.yml",
        "appsettings.json",
        "appsettings.Development.json",
        "database.yml",
        "config/database.yml",
        "sequelize.config.js",
        "sequelize.config.ts",
        "typeorm.config.ts",
        "typeorm.config.js",
        "drizzle.config.ts",
        "drizzle.config.js",
        "mikro-orm.config.ts",
        "datasource.ts",
        "src/datasource.ts",
        "package.json",
    ];

    for file in config_files {
        let file_path = Path::new(cwd).join(file);
        if file_path.is_file() && resolves_inside(&root, &file_path) {
            if let Ok(mut content) = std::fs::read_to_string(&file_path) {
                if content.len() > 3000 {
                    content = format!("{}\n...(truncated)", head_bytes(&content, 3000));
                }
                let content = secrets.redact(&content);
                parts.push(format!("--- {file} ---\n{content}"));
            }
        }
    }

    // Scan root for further .env* not already covered.
    if let Ok(entries) = std::fs::read_dir(cwd) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(".env") && !config_files.contains(&name.as_str()) {
                let p = entry.path();
                if p.is_file() && resolves_inside(&root, &p) {
                    if let Ok(mut content) = std::fs::read_to_string(&p) {
                        if content.len() > 3000 {
                            content = format!("{}\n...(truncated)", head_bytes(&content, 3000));
                        }
                        let content = secrets.redact(&content);
                        parts.push(format!("--- {name} ---\n{content}"));
                    }
                }
            }
        }
    }

    if parts.is_empty() {
        return None;
    }

    // Total cap at 15000.
    let mut total = String::new();
    for p in &parts {
        if total.len() + p.len() > 15000 {
            break;
        }
        total.push_str(p);
        total.push_str("\n\n");
    }

    if total.is_empty() {
        None
    } else {
        Some(total)
    }
}

// ─────────────────────────────────────────────────────────────────────────
//  Secret redaction for the AI detection context.
// ─────────────────────────────────────────────────────────────────────────

/// Replaces secret values (passwords, tokens, keys, salts, the password of a
/// URL, PEM private keys) with `[redacted:N]` markers before project files go
/// to the agent CLI, and keeps the real values here so the configuration the
/// agent returns can be completed locally. Hosts, ports, database and user
/// names stay readable: the agent needs them to find the configuration.
#[derive(Default)]
struct SecretRedactor {
    values: Vec<String>,
}

/// Key names whose value is a secret (lowercase, matched as a substring;
/// `pass` and `pw` only as a whole name segment: DB_PASS, MYSQL_PW).
const SECRET_KEY_PARTS: &[&str] = &[
    "password",
    "passwd",
    "pwd",
    "secret",
    "token",
    "apikey",
    "api_key",
    "api-key",
    "privatekey",
    "private_key",
    "accesskey",
    "access_key",
    "credential",
    "salt",
    "app_key",
    "auth_key",
    "signing_key",
    "encryption_key",
];

fn is_secret_key(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SECRET_KEY_PARTS.iter().any(|p| lower.contains(p))
        || lower
            .split(|c: char| !c.is_ascii_alphanumeric())
            .any(|seg| seg == "pass" || seg == "pw")
}

/// A value that only points at another variable (`${DB_PASSWORD}`,
/// `$DB_PASSWORD`, `env('DB_PASSWORD')`, `process.env.DB_PASSWORD`): no secret in it.
fn is_reference(value: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r#"^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|process\.env\.[A-Za-z_][A-Za-z0-9_]*|(?:env|getenv|os\.getenv)\(\s*["'][A-Za-z_][A-Za-z0-9_]*["']\s*\)|os\.environ\[\s*["'][A-Za-z_][A-Za-z0-9_]*["']\s*\]|%env\([A-Za-z_][A-Za-z0-9_]*\)%)[,;]?$"#,
        )
        .unwrap()
    })
    .is_match(value.trim())
}

impl SecretRedactor {
    fn mark(&mut self, secret: &str) -> String {
        let n = match self.values.iter().position(|v| v == secret) {
            Some(i) => i + 1,
            None => {
                self.values.push(secret.to_string());
                self.values.len()
            }
        };
        format!("[redacted:{n}]")
    }

    fn redact(&mut self, text: &str) -> String {
        static PEM: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        static URL_CREDS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        static QUERY: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        static KNOWN_TOKEN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let pem = PEM.get_or_init(|| {
            regex::Regex::new(
                r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
            )
            .unwrap()
        });
        let url_creds = URL_CREDS.get_or_init(|| {
            regex::Regex::new(r#"([A-Za-z][A-Za-z0-9+.\-]*://[^:/?#@\s'"]*):([^@/?#\s'"]+)@"#)
                .unwrap()
        });
        let query = QUERY.get_or_init(|| {
            regex::Regex::new(r#"(?i)([?&;](?:password|passwd|pwd|pass|token|secret|api_?key|access_?key)=)([^&;\s'"]+)"#)
                .unwrap()
        });
        let known_token = KNOWN_TOKEN.get_or_init(|| {
            regex::Regex::new(
                r"\b(?:sk-[A-Za-z0-9_\-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9\-]{10,}|AIza[0-9A-Za-z_\-]{30,})\b",
            )
            .unwrap()
        });

        let text = pem
            .replace_all(text, |c: &regex::Captures| self.mark(&c[0]))
            .into_owned();
        let text = url_creds
            .replace_all(&text, |c: &regex::Captures| {
                format!("{}:{}@", &c[1], self.mark(&c[2]))
            })
            .into_owned();
        let text = query
            .replace_all(&text, |c: &regex::Captures| {
                format!("{}{}", &c[1], self.mark(&c[2]))
            })
            .into_owned();
        let text = known_token
            .replace_all(&text, |c: &regex::Captures| self.mark(&c[0]))
            .into_owned();
        text.lines()
            .map(|line| self.redact_assignment(line))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// `KEY=value`, `key: value`, `"key": "value"`, `'key' => value`,
    /// `- KEY=value` (compose), `export KEY=value`, `key = "value"` (TOML,
    /// Prisma, Python): the value of a secret-named key becomes a marker.
    fn redact_assignment(&mut self, line: &str) -> String {
        static ASSIGN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        static LITERAL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let assign = ASSIGN.get_or_init(|| {
            regex::Regex::new(
                r#"^(\s*(?:-\s*)?(?:export\s+)?["']?([A-Za-z0-9_.\-]+)["']?\s*(?:=>|=|:)\s*)(.*)$"#,
            )
            .unwrap()
        });
        let literal = LITERAL.get_or_init(|| regex::Regex::new(r#""([^"]*)"|'([^']*)'"#).unwrap());
        let Some(c) = assign.captures(line) else {
            return line.to_string();
        };
        let (prefix, key, value) = (&c[1], &c[2], &c[3]);
        if !is_secret_key(key) {
            return line.to_string();
        }
        let trimmed = value.trim();
        if trimmed.is_empty() || trimmed.contains("[redacted:") || is_reference(trimmed) {
            return line.to_string();
        }
        if trimmed.starts_with('"') || trimmed.starts_with('\'') {
            // Quoted value: only the text inside the first pair of quotes.
            let quote = trimmed.chars().next().unwrap();
            let inner = &trimmed[1..];
            let (secret, rest) = match inner.find(quote) {
                Some(end) => (&inner[..end], &inner[end + 1..]),
                None => (inner, ""),
            };
            if secret.is_empty() {
                return line.to_string();
            }
            let marker = self.mark(secret);
            return format!("{prefix}{quote}{marker}{quote}{rest}");
        }
        if literal.is_match(trimmed) {
            // Code with string literals (`env('DB_PASSWORD', 'forge')`,
            // `process.env.X || 'abc'`): every literal that is not a variable
            // name is a candidate secret.
            let replaced = literal
                .replace_all(value, |l: &regex::Captures| {
                    let (q, inner) = match l.get(1) {
                        Some(m) => ('"', m.as_str()),
                        None => ('\'', l.get(2).map_or("", |m| m.as_str())),
                    };
                    let is_name = !inner.is_empty()
                        && inner
                            .chars()
                            .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_');
                    if inner.is_empty() || is_name {
                        l[0].to_string()
                    } else {
                        format!("{q}{}{q}", self.mark(inner))
                    }
                })
                .into_owned();
            return format!("{prefix}{replaced}");
        }
        // Bare value: up to a comment, a separator or the end of the line.
        let end = trimmed
            .find(|ch: char| ch.is_whitespace() || ch == ',' || ch == ';')
            .unwrap_or(trimmed.len());
        let (secret, rest) = trimmed.split_at(end);
        let marker = self.mark(secret);
        format!("{prefix}{marker}{rest}")
    }

    /// Puts the real values back into every string of the agent's answer.
    fn restore_json(&self, value: &mut JsonValue) {
        match value {
            JsonValue::String(s) if s.contains("[redacted:") => *s = self.restore(s),
            JsonValue::Array(items) => items.iter_mut().for_each(|v| self.restore_json(v)),
            JsonValue::Object(map) => map.values_mut().for_each(|v| self.restore_json(v)),
            _ => {}
        }
    }

    fn restore(&self, text: &str) -> String {
        static MARK: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let mark = MARK.get_or_init(|| regex::Regex::new(r"\[redacted:(\d+)\]").unwrap());
        mark.replace_all(text, |c: &regex::Captures| {
            c[1].parse::<usize>()
                .ok()
                .and_then(|n| n.checked_sub(1))
                .and_then(|i| self.values.get(i))
                .cloned()
                .unwrap_or_default()
        })
        .into_owned()
    }
}

/// Provider CLI for the DB AI features: the app's one headless pipeline
/// (`providers::spawn_provider_timeout`), so a timeout ends the CLI's whole
/// process group instead of only the shell, and Windows gets PowerShell with
/// the prompt passed through an environment variable instead of cmd.exe with
/// POSIX quotes.
fn spawn_provider(
    provider: &str,
    prompt: &str,
    cwd: &str,
    timeout_ms: u64,
) -> Result<String, String> {
    crate::commands::providers::spawn_provider_timeout(
        provider,
        prompt,
        cwd,
        timeout_ms.div_ceil(1000),
        None,
    )
}

#[cfg(unix)]
fn child_pid(child: &std::process::Child) -> Option<i32> {
    Some(child.id() as i32)
}

#[cfg(not(unix))]
fn child_pid(_child: &std::process::Child) -> Option<u32> {
    None
}

#[cfg(unix)]
fn kill_pid(pid: i32) {
    // SIGKILL via libc-free path: use the system `kill` to avoid adding deps.
    let _ = crate::commands::util_cmd::cmd("kill")
        .arg("-9")
        .arg(pid.to_string())
        .output();
}

#[cfg(not(unix))]
fn kill_pid(_pid: u32) {}

// ─────────────────────────────────────────────────────────────────────────
//  .env fast-path — detection from the .env files of the workspace.
// ─────────────────────────────────────────────────────────────────────────

fn detect_from_env_files(cwd: &str) -> Option<DbConfig> {
    for env_file in [".env", ".env.local", ".env.development"] {
        if let Some(cfg) = parse_env_file(&Path::new(cwd).join(env_file)) {
            return Some(cfg);
        }
    }
    None
}

fn parse_env_file(env_path: &Path) -> Option<DbConfig> {
    if !env_path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(env_path).ok()?;
    let vars = parse_env(&content);

    let get = |k: &str| vars.get(k).cloned();

    // MongoDB.
    let mongo_uri = get("MONGO_URI")
        .or_else(|| get("MONGODB_URI"))
        .or_else(|| get("MONGO_URL"))
        .or_else(|| get("DATABASE_URL"));
    if let Some(uri) = &mongo_uri {
        if uri.starts_with("mongodb") {
            return Some(DbConfig {
                db_type: "mongodb".into(),
                uri: Some(uri.clone()),
                ..Default::default()
            });
        }
    }

    let connection = get("DB_CONNECTION").unwrap_or_default().to_lowercase();

    if connection == "sqlite" {
        // DB_DATABASE || join(envPath, '..', 'database', 'database.sqlite')
        let db_path = get("DB_DATABASE")
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                env_path
                    .parent()
                    .map(|p| p.join("database").join("database.sqlite"))
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "database/database.sqlite".to_string())
            });
        return Some(DbConfig {
            db_type: "sqlite".into(),
            path: Some(db_path),
            database: get("DB_DATABASE"),
            ..Default::default()
        });
    }

    if connection == "mysql" || connection == "mariadb" {
        return Some(DbConfig {
            db_type: "mysql".into(),
            host: Some(
                get("DB_HOST")
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "127.0.0.1".into()),
            ),
            port: Some(parse_port(get("DB_PORT").as_deref(), 3306)),
            database: Some(get("DB_DATABASE").unwrap_or_default()),
            username: Some(
                get("DB_USERNAME")
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "root".into()),
            ),
            password: Some(get("DB_PASSWORD").unwrap_or_default()),
            ..Default::default()
        });
    }

    if connection == "pgsql" || connection == "postgres" || connection == "postgresql" {
        return Some(DbConfig {
            db_type: "pgsql".into(),
            host: Some(
                get("DB_HOST")
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "127.0.0.1".into()),
            ),
            port: Some(parse_port(get("DB_PORT").as_deref(), 5432)),
            database: Some(get("DB_DATABASE").unwrap_or_default()),
            username: Some(
                get("DB_USERNAME")
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "postgres".into()),
            ),
            password: Some(get("DB_PASSWORD").unwrap_or_default()),
            ..Default::default()
        });
    }

    let database_url = get("DATABASE_URL").unwrap_or_default();
    if database_url.starts_with("postgres") {
        return Some(DbConfig {
            db_type: "pgsql".into(),
            uri: Some(database_url),
            database: Some("from URL".into()),
            ..Default::default()
        });
    }
    if database_url.starts_with("mysql") {
        return Some(DbConfig {
            db_type: "mysql".into(),
            uri: Some(database_url),
            database: Some("from URL".into()),
            ..Default::default()
        });
    }

    None
}

/// parseInt(value || default, 10) — NaN-tolerant like parseInt.
fn parse_port(value: Option<&str>, default: u32) -> u32 {
    match value {
        Some(v) if !v.is_empty() => {
            // parseInt accepts a numeric prefix ("3306abc" → 3306).
            let digits: String = v
                .trim()
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '-')
                .collect();
            digits.parse::<u32>().unwrap_or(default)
        }
        _ => default,
    }
}

fn parse_env(content: &str) -> HashMap<String, String> {
    let mut vars = HashMap::new();
    for line in content.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(eq) = trimmed.find('=') else {
            continue;
        };
        let key = trimmed[..eq].trim().to_string();
        let mut value = trimmed[eq + 1..].trim().to_string();
        if (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
            || (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
        {
            value = value[1..value.len() - 1].to_string();
        }
        vars.insert(key, value);
    }
    vars
}

// ─────────────────────────────────────────────────────────────────────────
//  Connection testing.
//  MySQL/Postgres/SQLite via sqlx; MongoDB via shell-out to mongosh.
// ─────────────────────────────────────────────────────────────────────────

async fn test_connection(config: &DbConfig, cwd: &str) -> Result<(), String> {
    match config.db_type.as_str() {
        "mysql" => test_mysql(&mysql_url(config)).await,
        "pgsql" => test_pgsql(&pgsql_url(config)).await,
        "sqlite" => test_sqlite(config, cwd).await,
        "mongodb" => test_mongodb(config),
        other => Err(format!("Unsupported database type: {other}")),
    }
}

async fn test_mysql(url: &str) -> Result<(), String> {
    let pool = connect_mysql(url).await?;
    let res = sqlx::query("SELECT 1").execute(&pool).await;
    pool.close().await;
    res.map(|_| ())
        .map_err(|e| format!("MySQL connection failed: {e}"))
}

async fn test_pgsql(url: &str) -> Result<(), String> {
    let pool = connect_pgsql(url).await?;
    let res = sqlx::query("SELECT 1").execute(&pool).await;
    pool.close().await;
    res.map(|_| ())
        .map_err(|e| format!("PostgreSQL connection failed: {e}"))
}

async fn test_sqlite(config: &DbConfig, cwd: &str) -> Result<(), String> {
    let db_path = resolve_sqlite_path(config, cwd);
    if !Path::new(&db_path).exists() {
        return Err(format!("SQLite database not found: {db_path}"));
    }
    let pool = connect_sqlite(&sqlite_url(&db_path)).await?;
    let res = sqlx::query("SELECT 1").execute(&pool).await;
    pool.close().await;
    res.map(|_| ())
        .map_err(|e| format!("SQLite connection failed: {e}"))
}

fn test_mongodb(config: &DbConfig) -> Result<(), String> {
    let uri = config.uri.clone().unwrap_or_default();
    let out = run_mongosh(&uri, "db.runCommand({ ping: 1 })", 10_000)?;
    let _ = out;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────
//  List tables.
// ─────────────────────────────────────────────────────────────────────────

async fn list_tables(config: &DbConfig, cwd: &str) -> Result<Vec<String>, String> {
    match config.db_type.as_str() {
        "mysql" => list_mysql_tables(config).await,
        "pgsql" => list_pgsql_tables(config).await,
        "sqlite" => list_sqlite_tables(config, cwd).await,
        "mongodb" => list_mongo_collections(config),
        _ => Ok(vec![]),
    }
}

async fn list_mysql_tables(config: &DbConfig) -> Result<Vec<String>, String> {
    let pool = connect_mysql(&mysql_url(config)).await?;
    // SHOW TABLES → first column of each row (Object.values(r)[0]).
    let rows = sqlx::query("SHOW TABLES").fetch_all(&pool).await;
    pool.close().await;
    let rows = rows.map_err(|e| e.to_string())?;
    Ok(rows.iter().filter_map(mysql_first_column_string).collect())
}

async fn list_pgsql_tables(config: &DbConfig) -> Result<Vec<String>, String> {
    let pool = connect_pgsql(&pgsql_url(config)).await?;
    let rows = sqlx::query(
        "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    )
    .fetch_all(&pool)
    .await;
    pool.close().await;
    let rows = rows.map_err(|e| e.to_string())?;
    Ok(rows.iter().filter_map(pgsql_first_column_string).collect())
}

async fn list_sqlite_tables(config: &DbConfig, cwd: &str) -> Result<Vec<String>, String> {
    let db_path = resolve_sqlite_path(config, cwd);
    let pool = connect_sqlite(&sqlite_url(&db_path)).await?;
    // Equivalent of `.tables`: table+view names of the schema (.tables order).
    let rows = sqlx::query(
        "SELECT name FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .fetch_all(&pool)
    .await;
    pool.close().await;
    let rows = rows.map_err(|e| e.to_string())?;
    Ok(rows.iter().filter_map(sqlite_first_column_string).collect())
}

fn list_mongo_collections(config: &DbConfig) -> Result<Vec<String>, String> {
    let uri = config.uri.clone().unwrap_or_default();
    let raw = run_mongosh(&uri, "db.getCollectionNames().join('\\n')", 10_000)?;
    Ok(raw
        .trim()
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
        .collect())
}

// ─────────────────────────────────────────────────────────────────────────
//  Query table + WHERE/ORDER builders.
// ─────────────────────────────────────────────────────────────────────────

struct QueryResult {
    columns: Vec<String>,
    rows: Vec<JsonValue>,
    total: i64,
}

#[allow(clippy::too_many_arguments)]
async fn query_table(
    config: &DbConfig,
    cwd: &str,
    table: &str,
    limit: i64,
    offset: i64,
    filters: Option<&[Filter]>,
    order_by: Option<&str>,
    order_dir: Option<&str>,
) -> Result<QueryResult, String> {
    if !is_ident(table) {
        return Err("Invalid table name".to_string());
    }
    let (limit, offset) = clamp_page(limit, offset);
    match config.db_type.as_str() {
        "mysql" => query_mysql(config, table, limit, offset, filters, order_by, order_dir).await,
        "pgsql" => query_pgsql(config, table, limit, offset, filters, order_by, order_dir).await,
        "sqlite" => {
            query_sqlite(
                config, cwd, table, limit, offset, filters, order_by, order_dir,
            )
            .await
        }
        "mongodb" => query_mongo(config, table, limit, offset, filters),
        other => Err(format!("Unsupported DB type: {other}")),
    }
}

/// Largest page the explorer asks for in one query.
const MAX_PAGE_ROWS: i64 = 1000;

/// Page bounds from the renderer, made safe: 1..=1000 rows, offset >= 0.
fn clamp_page(limit: i64, offset: i64) -> (i64, i64) {
    (limit.clamp(1, MAX_PAGE_ROWS), offset.max(0))
}

/// /^[\w.]+$/ — \w = [A-Za-z0-9_].
fn is_ident(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

fn allowed_op(op: &str) -> &str {
    match op {
        "=" | "like" | ">" | "<" | ">=" | "<=" => op,
        _ => "=",
    }
}

/// buildWhereClause — backtick (MySQL). Values travel as bound parameters:
/// MySQL treats a backslash in a quoted literal as an escape, so doubling the
/// quotes alone would let a value end the string early.
fn build_where_clause_mysql(filters: Option<&[Filter]>) -> Result<(String, Vec<String>), String> {
    let Some(filters) = filters.filter(|f| !f.is_empty()) else {
        return Ok((String::new(), Vec::new()));
    };
    let mut conds = Vec::new();
    let mut binds = Vec::new();
    for f in filters {
        if !is_ident(&f.column) {
            return Err("Invalid column name in filter".to_string());
        }
        let op = allowed_op(&f.operator);
        if op == "like" {
            conds.push(format!("`{}` LIKE ?", f.column));
            binds.push(format!("%{}%", f.value));
        } else {
            conds.push(format!("`{}` {} ?", f.column, op));
            binds.push(f.value.clone());
        }
    }
    Ok((format!(" WHERE {}", conds.join(" AND ")), binds))
}

/// WHERE builder for Postgres/SQLite — double quotes, ILIKE.
fn build_where_clause_pgsql(filters: Option<&[Filter]>) -> Result<String, String> {
    let Some(filters) = filters.filter(|f| !f.is_empty()) else {
        return Ok(String::new());
    };
    let mut conds = Vec::new();
    for f in filters {
        if !is_ident(&f.column) {
            return Err("Invalid column name in filter".to_string());
        }
        let safe_val = f.value.replace('\'', "''");
        let op = allowed_op(&f.operator);
        if op == "like" {
            conds.push(format!("\"{}\" ILIKE '%{}%'", f.column, safe_val));
        } else {
            conds.push(format!("\"{}\" {} '{}'", f.column, op, safe_val));
        }
    }
    Ok(format!(" WHERE {}", conds.join(" AND ")))
}

/// buildOrderClause — backtick (MySQL).
fn build_order_clause_mysql(order_by: Option<&str>, order_dir: Option<&str>) -> String {
    match order_by {
        Some(col) if is_ident(col) => {
            let dir = if order_dir == Some("DESC") {
                "DESC"
            } else {
                "ASC"
            };
            format!(" ORDER BY `{col}` {dir}")
        }
        _ => String::new(),
    }
}

/// buildOrderClausePgsql — double quotes (Postgres/SQLite).
fn build_order_clause_pgsql(order_by: Option<&str>, order_dir: Option<&str>) -> String {
    match order_by {
        Some(col) if is_ident(col) => {
            let dir = if order_dir == Some("DESC") {
                "DESC"
            } else {
                "ASC"
            };
            format!(" ORDER BY \"{col}\" {dir}")
        }
        _ => String::new(),
    }
}

#[allow(clippy::too_many_arguments)]
async fn query_mysql(
    config: &DbConfig,
    table: &str,
    limit: i64,
    offset: i64,
    filters: Option<&[Filter]>,
    order_by: Option<&str>,
    order_dir: Option<&str>,
) -> Result<QueryResult, String> {
    let (where_c, binds) = build_where_clause_mysql(filters)?;
    let order_c = build_order_clause_mysql(order_by, order_dir);
    let pool = connect_mysql(&mysql_url(config)).await?;

    let count_sql = format!("SELECT COUNT(*) as cnt FROM `{table}`{where_c}");
    let mut count_q = sqlx::query(sqlx::AssertSqlSafe(count_sql.clone()));
    for b in &binds {
        count_q = count_q.bind(b);
    }
    let count_row = count_q.fetch_one(&pool).await;
    let total = match count_row {
        Ok(r) => mysql_first_column_i64(&r).unwrap_or(0),
        Err(e) => {
            pool.close().await;
            return Err(e.to_string());
        }
    };

    let sql = format!("SELECT * FROM `{table}`{where_c}{order_c} LIMIT {limit} OFFSET {offset}");
    let mut rows_q = sqlx::query(sqlx::AssertSqlSafe(sql.clone()));
    for b in &binds {
        rows_q = rows_q.bind(b);
    }
    let rows = rows_q.fetch_all(&pool).await;
    pool.close().await;
    let rows = rows.map_err(|e| e.to_string())?;
    Ok(mysql_rows_to_result(&rows, total))
}

#[allow(clippy::too_many_arguments)]
async fn query_pgsql(
    config: &DbConfig,
    table: &str,
    limit: i64,
    offset: i64,
    filters: Option<&[Filter]>,
    order_by: Option<&str>,
    order_dir: Option<&str>,
) -> Result<QueryResult, String> {
    let where_c = build_where_clause_pgsql(filters)?;
    let order_c = build_order_clause_pgsql(order_by, order_dir);
    let pool = connect_pgsql(&pgsql_url(config)).await?;

    let count_sql = format!("SELECT COUNT(*) FROM \"{table}\"{where_c}");
    let count_row = sqlx::query(sqlx::AssertSqlSafe(count_sql.clone()))
        .fetch_one(&pool)
        .await;
    let total = match count_row {
        Ok(r) => pgsql_first_column_i64(&r).unwrap_or(0),
        Err(e) => {
            pool.close().await;
            return Err(e.to_string());
        }
    };

    let sql = format!("SELECT * FROM \"{table}\"{where_c}{order_c} LIMIT {limit} OFFSET {offset}");
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql.clone()))
        .fetch_all(&pool)
        .await;
    pool.close().await;
    let rows = rows.map_err(|e| e.to_string())?;
    Ok(pgsql_rows_to_result(&rows, total))
}

#[allow(clippy::too_many_arguments)]
async fn query_sqlite(
    config: &DbConfig,
    cwd: &str,
    table: &str,
    limit: i64,
    offset: i64,
    filters: Option<&[Filter]>,
    order_by: Option<&str>,
    order_dir: Option<&str>,
) -> Result<QueryResult, String> {
    // SQLite uses the pgsql builders (double quotes, ILIKE). SQLite has no ILIKE but
    // LIKE is case-insensitive by default on ASCII; we keep ILIKE→LIKE.
    let where_c = build_where_clause_pgsql(filters)?.replace(" ILIKE ", " LIKE ");
    let order_c = build_order_clause_pgsql(order_by, order_dir);
    let db_path = resolve_sqlite_path(config, cwd);
    let pool = connect_sqlite(&sqlite_url(&db_path)).await?;

    let count_sql = format!("SELECT COUNT(*) FROM \"{table}\"{where_c}");
    let count_row = sqlx::query(sqlx::AssertSqlSafe(count_sql.clone()))
        .fetch_one(&pool)
        .await;
    let total = match count_row {
        Ok(r) => sqlite_first_column_i64(&r).unwrap_or(0),
        Err(e) => {
            pool.close().await;
            return Err(e.to_string());
        }
    };

    let sql = format!("SELECT * FROM \"{table}\"{where_c} {order_c} LIMIT {limit} OFFSET {offset}");
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql.clone()))
        .fetch_all(&pool)
        .await;
    pool.close().await;
    let rows = rows.map_err(|e| e.to_string())?;
    Ok(sqlite_rows_to_result(&rows, total))
}

fn query_mongo(
    config: &DbConfig,
    collection: &str,
    limit: i64,
    offset: i64,
    filters: Option<&[Filter]>,
) -> Result<QueryResult, String> {
    let uri = config.uri.clone().unwrap_or_default();
    // /^[A-Za-z_][\w.-]{0,127}$/
    if !is_collection_name(collection) {
        return Err("Invalid collection name".to_string());
    }
    // Math.max(1, Math.min(10000, Math.floor(Number(limit) || 100)))
    let base_limit = if limit == 0 { 100 } else { limit }; // Number(limit) || 100
    let safe_limit = base_limit.clamp(1, 10_000);
    // Math.max(0, Math.floor(Number(offset) || 0))
    let safe_offset = offset.max(0);

    let mut filter_obj = "{}".to_string();
    if let Some(filters) = filters.filter(|f| !f.is_empty()) {
        let mut parts = serde_json::Map::new();
        for f in filters {
            if !is_ident(&f.column) {
                return Err("Invalid field name".to_string());
            }
            let val = JsonValue::String(f.value.clone());
            let entry = match f.operator.as_str() {
                "=" => val,
                "like" => json!({ "$regex": f.value, "$options": "i" }),
                ">" => json!({ "$gt": f.value }),
                "<" => json!({ "$lt": f.value }),
                ">=" => json!({ "$gte": f.value }),
                "<=" => json!({ "$lte": f.value }),
                _ => continue,
            };
            parts.insert(f.column.clone(), entry);
        }
        filter_obj = serde_json::to_string(&parts).unwrap_or_else(|_| "{}".to_string());
    }

    let coll_json = serde_json::to_string(collection).unwrap_or_default();

    let count_script = format!("db.getCollection({coll_json}).countDocuments({filter_obj})");
    let count_raw = run_mongosh(&uri, &count_script, 10_000)?;
    let total = count_raw.trim().parse::<i64>().unwrap_or(0);

    let query_script = format!(
        "JSON.stringify(db.getCollection({coll_json}).find({filter_obj}).skip({safe_offset}).limit({safe_limit}).toArray())"
    );
    let raw = run_mongosh(&uri, &query_script, 15_000)?;

    match serde_json::from_str::<JsonValue>(raw.trim()) {
        Ok(JsonValue::Array(docs)) => {
            let columns: Vec<String> = docs
                .first()
                .and_then(|d| d.as_object())
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default();
            Ok(QueryResult {
                columns,
                rows: docs,
                total,
            })
        }
        _ => Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            total: 0,
        }),
    }
}

/// /^[A-Za-z_][\w.-]{0,127}$/
fn is_collection_name(s: &str) -> bool {
    let mut chars = s.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    let rest: Vec<char> = chars.collect();
    if rest.len() > 127 {
        return false;
    }
    rest.iter()
        .all(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.' || *c == '-')
}

// ─────────────────────────────────────────────────────────────────────────
//  sqlx helpers — URL building, connection, row → JSON mapping.
// ─────────────────────────────────────────────────────────────────────────

// Native drivers (not `Any`): the Any driver can't map DATE/DATETIME/
// TIMESTAMP/DECIMAL/JSON and fails the whole fetch with
// "Any driver does not support MySql type ...".
async fn connect_mysql(url: &str) -> Result<MySqlPool, String> {
    use sqlx::Executor as _;
    MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        // Every session is read-only: a write that slips past the query
        // checks is refused by the server itself.
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                conn.execute("SET SESSION TRANSACTION READ ONLY").await?;
                Ok(())
            })
        })
        .connect(url)
        .await
        .map_err(|e| format!("MySQL connection failed: {e}"))
}

async fn connect_pgsql(url: &str) -> Result<PgPool, String> {
    use sqlx::Executor as _;
    PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                conn.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
                    .await?;
                Ok(())
            })
        })
        .connect(url)
        .await
        .map_err(|e| format!("PostgreSQL connection failed: {e}"))
}

/// SQLite files are opened read-only (and never created).
async fn connect_sqlite(url: &str) -> Result<SqlitePool, String> {
    use std::str::FromStr as _;
    let options = sqlx::sqlite::SqliteConnectOptions::from_str(url)
        .map_err(|e| format!("SQLite connection failed: {e}"))?
        .read_only(true)
        .create_if_missing(false);
    SqlitePoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(options)
        .await
        .map_err(|e| format!("SQLite connection failed: {e}"))
}

/// MySQL URL: uses `config.uri` if present, otherwise built from the fields.
fn mysql_url(config: &DbConfig) -> String {
    if let Some(uri) = config.uri.as_ref().filter(|s| !s.is_empty()) {
        return uri.clone();
    }
    let host = config
        .host
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "127.0.0.1".into());
    let port = config.port.unwrap_or(3306);
    let user = config
        .username
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "root".into());
    let pass = config.password.clone().unwrap_or_default();
    let db = config.database.clone().unwrap_or_default();
    format!(
        "mysql://{}:{}@{}:{}/{}",
        urlencode(&user),
        urlencode(&pass),
        host,
        port,
        db
    )
}

/// Postgres URL: `config.uri` or built.
fn pgsql_url(config: &DbConfig) -> String {
    if let Some(uri) = config.uri.as_ref().filter(|s| !s.is_empty()) {
        return uri.clone();
    }
    let host = config
        .host
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "127.0.0.1".into());
    let port = config.port.unwrap_or(5432);
    let user = config
        .username
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "postgres".into());
    let pass = config.password.clone().unwrap_or_default();
    let db = config.database.clone().unwrap_or_default();
    format!(
        "postgres://{}:{}@{}:{}/{}",
        urlencode(&user),
        urlencode(&pass),
        host,
        port,
        db
    )
}

fn sqlite_url(path: &str) -> String {
    format!("sqlite://{path}")
}

/// minimal percent-encode for user/pass in connection strings.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// resolveSqlitePath(config, cwd).
fn resolve_sqlite_path(config: &DbConfig, cwd: &str) -> String {
    let raw = config
        .path
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| config.database.clone().filter(|s| !s.is_empty()))
        .unwrap_or_default();
    if raw.is_empty() {
        return Path::new(cwd)
            .join("database")
            .join("database.sqlite")
            .to_string_lossy()
            .to_string();
    }
    if raw.starts_with('/') {
        return raw;
    }
    Path::new(cwd).join(raw).to_string_lossy().to_string()
}

/// Generates the row → JSON mappers for each driver. Types are tried
/// in the declared order: numerics before bool so that
/// TINYINT(1) maps to a number.
macro_rules! define_row_mappers {
    (
        $row:ty, $val_fn:ident, $rows_fn:ident, $first_str:ident, $first_i64:ident,
        [ $($ty:ty => $conv:expr),* $(,)? ]
    ) => {
        /// Converts column `idx` to JSON (best-effort on the driver types).
        fn $val_fn(row: &$row, idx: usize) -> JsonValue {
            match row.try_get_raw(idx) {
                Ok(raw) if raw.is_null() => return JsonValue::Null,
                Err(_) => return JsonValue::Null,
                _ => {}
            }
            $(
                if let Ok(v) = row.try_get::<$ty, _>(idx) {
                    let conv: fn($ty) -> JsonValue = $conv;
                    return conv(v);
                }
            )*
            // Unhandled type: placeholder with the type name, never an error.
            match row.try_get_raw(idx) {
                Ok(raw) => JsonValue::String(format!("<{}>", raw.type_info().name())),
                Err(_) => JsonValue::Null,
            }
        }

        /// Maps a set of rows → { columns, rows: [ {col: val} ], total }.
        fn $rows_fn(rows: &[$row], total: i64) -> QueryResult {
            if rows.is_empty() {
                return QueryResult { columns: vec![], rows: vec![], total };
            }
            let columns: Vec<String> =
                rows[0].columns().iter().map(|c| c.name().to_string()).collect();
            let mapped: Vec<JsonValue> = rows
                .iter()
                .map(|row| {
                    let mut obj = serde_json::Map::new();
                    for (i, col) in columns.iter().enumerate() {
                        obj.insert(col.clone(), $val_fn(row, i));
                    }
                    JsonValue::Object(obj)
                })
                .collect();
            QueryResult { columns, rows: mapped, total }
        }

        /// First column of a row as a string (Object.values(r)[0]).
        fn $first_str(row: &$row) -> Option<String> {
            if row.columns().is_empty() {
                return None;
            }
            match $val_fn(row, 0) {
                JsonValue::Null => None,
                JsonValue::String(s) => Some(s),
                other => Some(other.to_string()),
            }
        }

        #[allow(dead_code)]
        fn $first_i64(row: &$row) -> Option<i64> {
            if row.columns().is_empty() {
                return None;
            }
            match $val_fn(row, 0) {
                JsonValue::Number(n) => n.as_i64(),
                JsonValue::String(s) => s.trim().parse::<i64>().ok(),
                _ => None,
            }
        }
    };
}

fn f64_to_json(v: f64) -> JsonValue {
    serde_json::Number::from_f64(v)
        .map(JsonValue::Number)
        .unwrap_or(JsonValue::Null)
}

fn blob_to_json(v: Vec<u8>) -> JsonValue {
    // Blob → lossy UTF-8 string.
    JsonValue::String(String::from_utf8_lossy(&v).to_string())
}

define_row_mappers!(
    MySqlRow,
    mysql_value_to_json,
    mysql_rows_to_result,
    mysql_first_column_string,
    mysql_first_column_i64,
    [
        i64 => |v| JsonValue::Number(v.into()),
        u64 => |v| JsonValue::Number(v.into()),
        f64 => f64_to_json,
        bool => JsonValue::Bool,
        String => JsonValue::String,
        chrono::NaiveDateTime => |v| JsonValue::String(v.to_string()),
        chrono::DateTime<chrono::Utc> => |v| JsonValue::String(v.to_rfc3339()),
        chrono::NaiveDate => |v| JsonValue::String(v.to_string()),
        chrono::NaiveTime => |v| JsonValue::String(v.to_string()),
        bigdecimal::BigDecimal => |v| JsonValue::String(v.to_string()),
        JsonValue => |v| v,
        Vec<u8> => blob_to_json,
    ]
);

define_row_mappers!(
    PgRow,
    pgsql_value_to_json,
    pgsql_rows_to_result,
    pgsql_first_column_string,
    pgsql_first_column_i64,
    [
        i64 => |v| JsonValue::Number(v.into()),
        i32 => |v| JsonValue::Number((v as i64).into()),
        i16 => |v| JsonValue::Number((v as i64).into()),
        f64 => f64_to_json,
        f32 => |v| f64_to_json(v as f64),
        bool => JsonValue::Bool,
        String => JsonValue::String,
        chrono::DateTime<chrono::Utc> => |v| JsonValue::String(v.to_rfc3339()),
        chrono::NaiveDateTime => |v| JsonValue::String(v.to_string()),
        chrono::NaiveDate => |v| JsonValue::String(v.to_string()),
        chrono::NaiveTime => |v| JsonValue::String(v.to_string()),
        uuid::Uuid => |v| JsonValue::String(v.to_string()),
        bigdecimal::BigDecimal => |v| JsonValue::String(v.to_string()),
        JsonValue => |v| v,
        Vec<String> => |v| JsonValue::Array(v.into_iter().map(JsonValue::String).collect()),
        Vec<u8> => blob_to_json,
    ]
);

define_row_mappers!(
    SqliteRow,
    sqlite_value_to_json,
    sqlite_rows_to_result,
    sqlite_first_column_string,
    sqlite_first_column_i64,
    [
        i64 => |v| JsonValue::Number(v.into()),
        f64 => f64_to_json,
        bool => JsonValue::Bool,
        String => JsonValue::String,
        chrono::NaiveDateTime => |v| JsonValue::String(v.to_string()),
        Vec<u8> => blob_to_json,
    ]
);

// ─────────────────────────────────────────────────────────────────────────
//  mongosh shell-out.
// ─────────────────────────────────────────────────────────────────────────

/// Environment variable that carries the MongoDB URI to mongosh.
const MONGO_URI_ENV: &str = "PROMPTOPS_MONGO_URI";

/// mongosh invocation for `eval`. The URI (which usually holds the password)
/// travels in the child's environment, never in its arguments: arguments are
/// visible to every local user through `ps`, the environment is not.
fn mongosh_command(uri: &str, eval: &str) -> std::process::Command {
    let mut command = crate::commands::util_cmd::cmd("mongosh");
    command
        .arg("--nodb")
        .arg("--quiet")
        .arg("--eval")
        .arg(format!(
            "db = connect(process.env.{MONGO_URI_ENV} || 'mongodb://127.0.0.1:27017/test');\n{eval}"
        ))
        .env(MONGO_URI_ENV, uri)
        .env("PATH", build_path(default_extra_paths()))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    command
}

fn run_mongosh(uri: &str, eval: &str, timeout_ms: u64) -> Result<String, String> {
    let child = mongosh_command(uri, eval)
        .spawn()
        .map_err(|e| format!("MongoDB connection failed: {e}"))?;
    let output = wait_with_deadline(child, Duration::from_millis(timeout_ms))
        .map_err(|e| format!("MongoDB connection failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!(
            "MongoDB connection failed: {}",
            if err.is_empty() {
                "mongosh failed".into()
            } else {
                err
            }
        ))
    }
}

/// Waits for `child` and kills it if it outlives `timeout`. The watchdog
/// gives up as soon as the child has been reaped: after that its pid can be
/// reused by an unrelated process, which must never be killed.
fn wait_with_deadline(
    child: std::process::Child,
    timeout: Duration,
) -> std::io::Result<std::process::Output> {
    use std::sync::atomic::{AtomicBool, Ordering};
    let done = Arc::new(AtomicBool::new(false));
    if let Some(pid) = child_pid(&child) {
        let done = done.clone();
        std::thread::spawn(move || {
            let started = std::time::Instant::now();
            while started.elapsed() < timeout {
                if done.load(Ordering::SeqCst) {
                    return;
                }
                let left = timeout.saturating_sub(started.elapsed());
                std::thread::sleep(left.min(Duration::from_millis(100)));
            }
            if !done.load(Ordering::SeqCst) {
                kill_pid(pid);
            }
        });
    }
    let output = child.wait_with_output();
    done.store(true, Ordering::SeqCst);
    output
}

// ─────────────────────────────────────────────────────────────────────────
//  Utility — shell / PATH / time.
// ─────────────────────────────────────────────────────────────────────────

fn home_dir() -> String {
    if cfg!(windows) {
        std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into())
    } else {
        std::env::var("HOME").unwrap_or_else(|_| ".".into())
    }
}

fn default_extra_paths() -> Vec<String> {
    let home = home_dir();
    if cfg!(windows) {
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

fn build_path(extra_dirs: Vec<String>) -> String {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let fallback = if cfg!(windows) { "" } else { "/usr/bin:/bin" };
    let current = std::env::var("PATH").unwrap_or_else(|_| fallback.to_string());
    format!("{}{}{}", extra_dirs.join(sep), sep, current)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "promptops-db-{tag}-{}",
            crate::local_store::new_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn long_multibyte_config_files_are_cut_on_a_character() {
        assert_eq!(head_bytes("\u{e0}\u{e0}", 3), "\u{e0}");
        assert_eq!(head_bytes("abc", 10), "abc");
        let dir = tmp_dir("ctx");
        // 2 bytes per character: byte 3000 falls inside one at some point.
        std::fs::write(dir.join(".env"), format!("A{}", "\u{e9}".repeat(2000))).unwrap();
        std::fs::write(
            dir.join(".env.custom"),
            format!("B{}", "\u{20ac}".repeat(2000)),
        )
        .unwrap();
        let ctx =
            gather_project_context(dir.to_str().unwrap(), &mut SecretRedactor::default()).unwrap();
        assert!(ctx.contains("...(truncated)"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detection_context_sends_no_secret_and_the_answer_gets_them_back() {
        let dir = tmp_dir("redact");
        std::fs::write(
            dir.join(".env"),
            "DB_HOST=db.internal\nDB_PORT=5433\nDB_DATABASE=shop\nDB_USERNAME=app\n\
             DB_PASSWORD=s3cr3t-pw # local\nDB_PASS='quoted pw'\nAPP_KEY=base64:QUJDREVG\n\
             DATABASE_URL=postgres://app:url-pw@db.internal:5433/shop?sslmode=require\n\
             JDBC=jdbc:mysql://db.internal/shop?user=app&password=query-pw\n\
             OPENAI_TOKEN=sk-abcdefghijklmnopqrstuvwx\nREDIS_PASSWORD=${REDIS_PASSWORD}\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("docker-compose.yml"),
            "services:\n  db:\n    image: postgres:16\n    ports:\n      - \"5433:5432\"\n    environment:\n      - POSTGRES_PASSWORD=compose-pw\n      MYSQL_ROOT_PASSWORD: \"root-pw\"\n",
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("config")).unwrap();
        std::fs::write(
            dir.join("config/database.php"),
            "'password' => env('DB_PASSWORD', 'php-default'),\n'host' => env('DB_HOST', '127.0.0.1'),\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("appsettings.json"),
            "{\n  \"ConnectionStrings\": { \"Default\": \"Server=db.internal;Database=shop\" },\n  \"Password\": \"json-pw\",\n  \"ApiKey\": \"json-key\"\n}\n",
        )
        .unwrap();

        let mut secrets = SecretRedactor::default();
        let ctx = gather_project_context(dir.to_str().unwrap(), &mut secrets).unwrap();
        for secret in [
            "s3cr3t-pw",
            "quoted pw",
            "QUJDREVG",
            "url-pw",
            "query-pw",
            "sk-abcdefghijklmnopqrstuvwx",
            "compose-pw",
            "root-pw",
            "php-default",
            "json-pw",
            "json-key",
        ] {
            assert!(!ctx.contains(secret), "{secret} leaked:\n{ctx}");
        }
        // What the agent needs to find the database stays readable.
        for kept in [
            "DB_HOST=db.internal",
            "DB_PORT=5433",
            "DB_DATABASE=shop",
            "DB_USERNAME=app",
            "postgres://app:[redacted:",
            "@db.internal:5433/shop?sslmode=require",
            "REDIS_PASSWORD=${REDIS_PASSWORD}",
            "env('DB_PASSWORD', '[redacted:",
            "env('DB_HOST', '127.0.0.1')",
            "\"5433:5432\"",
        ] {
            assert!(ctx.contains(kept), "{kept} missing:\n{ctx}");
        }

        // The agent copies markers; the configuration gets the real values.
        let pw_marker = ctx
            .lines()
            .find(|l| l.starts_with("DB_PASSWORD="))
            .and_then(|l| l.split_whitespace().next())
            .unwrap()
            .trim_start_matches("DB_PASSWORD=")
            .to_string();
        let url = ctx
            .lines()
            .find(|l| l.starts_with("DATABASE_URL="))
            .unwrap()
            .trim_start_matches("DATABASE_URL=")
            .to_string();
        let mut answer =
            json!({ "type": "pgsql", "host": "db.internal", "password": pw_marker, "uri": url });
        secrets.restore_json(&mut answer);
        assert_eq!(answer["password"], "s3cr3t-pw");
        assert_eq!(
            answer["uri"],
            "postgres://app:url-pw@db.internal:5433/shop?sslmode=require"
        );
        assert_eq!(secrets.restore("[redacted:999]"), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A repository can point its config files at files elsewhere on the
    /// machine; the detection context reads only what resolves inside the
    /// workspace (in-repo symlinks keep working).
    #[cfg(unix)]
    #[test]
    fn detection_context_never_follows_symlinks_out_of_the_workspace() {
        let outside = tmp_dir("outside");
        std::fs::write(outside.join("credentials"), "aws_region = OUTSIDE_MARK\n").unwrap();
        std::fs::write(outside.join("netrc"), "machine h login u OUTSIDE_NETRC\n").unwrap();
        let repo = tmp_dir("repo");
        std::os::unix::fs::symlink(outside.join("credentials"), repo.join(".env")).unwrap();
        std::os::unix::fs::symlink(outside.join("credentials"), repo.join(".env.extra")).unwrap();
        std::fs::create_dir_all(repo.join("config")).unwrap();
        std::os::unix::fs::symlink("../../../netrc-missing", repo.join("config/database.php")).ok();
        std::os::unix::fs::symlink(outside.join("netrc"), repo.join("config/database.yml"))
            .unwrap();
        std::fs::write(
            repo.join("docker-compose.yml"),
            "services: { db: { image: pg_INSIDE } }\n",
        )
        .unwrap();
        std::os::unix::fs::symlink(repo.join("docker-compose.yml"), repo.join(".env.local"))
            .unwrap();

        let ctx =
            gather_project_context(repo.to_str().unwrap(), &mut SecretRedactor::default()).unwrap();
        assert!(!ctx.contains("OUTSIDE_MARK"), "{ctx}");
        assert!(!ctx.contains("OUTSIDE_NETRC"), "{ctx}");
        assert!(ctx.contains("--- docker-compose.yml ---"), "{ctx}");
        // A symlink that stays inside the repository is still read.
        assert!(ctx.contains("--- .env.local ---"), "{ctx}");
        let _ = std::fs::remove_dir_all(&outside);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn page_bounds_from_the_renderer_are_clamped() {
        assert_eq!(clamp_page(50, 0), (50, 0));
        assert_eq!(clamp_page(0, -5), (1, 0));
        assert_eq!(clamp_page(i64::MAX, 10), (MAX_PAGE_ROWS, 10));
        assert_eq!(clamp_page(-1, i64::MIN), (1, 0));
    }

    #[test]
    fn mysql_filter_values_are_bound_not_spliced() {
        let filters = vec![
            Filter {
                column: "name".into(),
                operator: "=".into(),
                value: "\\' OR 1=1 -- ".into(),
            },
            Filter {
                column: "note".into(),
                operator: "like".into(),
                value: "50%".into(),
            },
        ];
        let (clause, binds) = build_where_clause_mysql(Some(&filters)).unwrap();
        assert_eq!(clause, " WHERE `name` = ? AND `note` LIKE ?");
        assert_eq!(
            binds,
            vec!["\\' OR 1=1 -- ".to_string(), "%50%%".to_string()]
        );
        let bad = vec![Filter {
            column: "a`b".into(),
            operator: "=".into(),
            value: "x".into(),
        }];
        assert!(build_where_clause_mysql(Some(&bad)).is_err());
    }

    #[test]
    fn generated_sql_must_be_one_read_only_select() {
        assert!(assert_read_only("SELECT id FROM users LIMIT 5", "pgsql").is_ok());
        assert!(assert_read_only("WITH t AS (SELECT 1) SELECT * FROM t", "mysql").is_ok());
        // Names that only contain a refused word stay usable.
        assert!(assert_read_only(
            "SELECT sleep_minutes, lot_size, locked_at FROM pg_stats_backends",
            "pgsql"
        )
        .is_ok());
        for q in [
            "SELECT 1; DROP TABLE users",
            "DELETE FROM users",
            "SELECT * INTO backup FROM users",
            "SELECT * FROM users INTO OUTFILE '/tmp/x'",
            "SELECT load_file('/etc/passwd')",
            "SELECT nextval('seq')",
            "SELECT set_config('a','b',false)",
            "SELECT * FROM users FOR UPDATE NOWAIT LOCK",
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity",
            "SELECT pg_cancel_backend(1)",
            "SELECT pg_reload_conf()",
            "SELECT pg_read_file('/etc/passwd')",
            "SELECT pg_advisory_lock(1)",
            "SELECT pg_try_advisory_xact_lock(1)",
            "SELECT pg_sleep(600)",
            "SELECT * FROM dblink('host=evil', 'select 1') AS t(x int)",
            "SELECT lo_export(1, '/tmp/x')",
            "SELECT SLEEP(600)",
            "SELECT BENCHMARK(100000000, MD5('x'))",
            "SELECT GET_LOCK('a', 10)",
        ] {
            assert!(assert_read_only(q, "pgsql").is_err(), "{q}");
        }
    }

    #[test]
    fn generated_mongo_queries_are_json_specs_never_code() {
        for ok in [
            r#"{"collection":"users","op":"find","filter":{"age":{"$gt":30}},"limit":10}"#,
            r#"{"collection":"orders","op":"aggregate","pipeline":[{"$match":{"s":1}},{"$limit":5}]}"#,
            r#"{"collection":"events","op":"countDocuments","filter":{"at":{"$gte":{"$date":"2026-01-01T00:00:00Z"}}}}"#,
            r#"{"collection":"events","op":"distinct","field":"kind"}"#,
            // `;` inside a JSON string is data, not a second statement.
            r#"{"collection":"notes","op":"find","filter":{"body":"a; b"}}"#,
        ] {
            assert!(assert_read_only(ok, "mongodb").is_ok(), "{ok}");
        }
        for bad in [
            // The old regex guard let these through: comments before `(`.
            r#"db.getCollection("a").find({}).limit(require/**/("child_process").execSync/**/("touch /tmp/pwn"))"#,
            r#"db.getCollection("a").find({})"#,
            r#"{"collection":"a","op":"find","filter":{"$where":"sleep(10000)"}}"#,
            r#"{"collection":"a","op":"find","filter":{"x":{"$elemMatch":{"$WHERE ":"1"}}}}"#,
            r#"{"collection":"a","op":"aggregate","pipeline":[{"$out":"b"}]}"#,
            r#"{"collection":"a","op":"aggregate","pipeline":[{"$merge":{"into":"b"}}]}"#,
            r#"{"collection":"a","op":"aggregate","pipeline":[{"$group":{"_id":1,"x":{"$accumulator":{}}}}]}"#,
            r#"{"collection":"a","op":"find","filter":{"$expr":{"$function":{"body":"x","args":[],"lang":"js"}}}}"#,
            r#"{"collection":"a","op":"find","filter":{"c":{"$code":"process.exit()"}}}"#,
            r#"{"collection":"a","op":"deleteMany","filter":{}}"#,
            r#"{"collection":"a","op":"drop"}"#,
            r#"{"collection":"a\"); db.dropDatabase(); (\"","op":"find"}"#,
            r#"{"collection":"a","op":"distinct","field":"$x"}"#,
            r#"{"collection":"a","op":"find","filter":"this.x"}"#,
            r#"{"collection":"a","op":"aggregate","pipeline":"[]"}"#,
            r#"[{"collection":"a","op":"find"}]"#,
        ] {
            assert!(assert_read_only(bad, "mongodb").is_err(), "{bad}");
        }
        let spec = parse_mongo_spec(r#"{"collection":"a","op":"find","limit":100000}"#).unwrap();
        assert_eq!(spec.limit, MONGO_NL_MAX_ROWS);
        let agg = parse_mongo_spec(r#"{"collection":"a","op":"aggregate","pipeline":[]}"#).unwrap();
        assert_eq!(agg.pipeline, json!([{ "$limit": MONGO_NL_MAX_ROWS }]));
    }

    /// The script mongosh receives holds the spec only as a string literal:
    /// hostile text inside the spec (quotes, `*/`, `${}`, U+2028) is data.
    /// Runs the real mongosh with a stub `db` when it is installed.
    #[test]
    fn mongo_spec_script_carries_the_spec_as_data() {
        let hostile = "x\"); require('child_process').execSync('touch /tmp/po-pwn'); (\" */ ${process.exit(9)} \u{2028} `";
        let spec = parse_mongo_spec(
            &json!({ "collection": "users", "op": "find", "filter": { "name": hostile }, "limit": 3 }).to_string(),
        )
        .unwrap();
        let script = mongo_spec_script(&spec);
        assert!(script.starts_with("const __po = EJSON.parse(\""));
        if crate::commands::util_cmd::find_in_path(
            "mongosh",
            &std::env::var_os("PATH").unwrap_or_default(),
        )
        .is_none()
        {
            return;
        }
        // mongosh refuses to rebind `db`: the stub answers under another name.
        let script = script.replace("db.getCollection(", "stubdb.getCollection(");
        let stub = "const stubdb = { getCollection: (n) => ({ find: (f, p) => ({ sort: (s) => ({ limit: (l) => ({ toArray: () => [{ n, f, p, s, l }] }) }) }) }) };\n";
        let out = crate::commands::util_cmd::cmd("mongosh")
            .args(["--nodb", "--quiet", "--eval", &format!("{stub}{script}")])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let rows: JsonValue = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(rows[0]["n"], "users");
        assert_eq!(rows[0]["f"]["name"], hostile);
        assert_eq!(rows[0]["l"], 3);
        assert!(!std::path::Path::new("/tmp/po-pwn").exists());
    }

    /// Against a real server: `PO_TEST_MONGO_URI=mongodb://127.0.0.1:27999/po
    /// cargo test --lib -- --ignored nl_mongo_specs_run_on_a_real_server`.
    #[test]
    #[ignore]
    fn nl_mongo_specs_run_on_a_real_server() {
        let Ok(uri) = std::env::var("PO_TEST_MONGO_URI") else {
            return;
        };
        let config: DbConfig =
            serde_json::from_value(json!({ "type": "mongodb", "uri": uri })).unwrap();
        run_mongosh(
            config.uri.as_deref().unwrap(),
            "db.getCollection('people').drop(); db.getCollection('people').insertMany([{n:'a',age:20,at:new Date('2026-01-02')},{n:'b',age:40,at:new Date('2025-01-02')},{n:'c',age:50,at:new Date('2026-03-01')}]).insertedIds ? 1 : 0",
            20_000,
        )
        .unwrap();
        let r = raw_mongo(&config, r#"{"collection":"people","op":"find","filter":{"age":{"$gt":30}},"projection":{"_id":0,"n":1},"sort":{"age":-1},"limit":5}"#).unwrap();
        assert_eq!(r.rows, vec![json!({"n":"c"}), json!({"n":"b"})]);
        let r = raw_mongo(&config, r#"{"collection":"people","op":"countDocuments","filter":{"at":{"$gte":{"$date":"2026-01-01T00:00:00Z"}}}}"#).unwrap();
        assert_eq!(r.rows, vec![json!({"count":2})]);
        let r = raw_mongo(&config, r#"{"collection":"people","op":"aggregate","pipeline":[{"$group":{"_id":null,"avg":{"$avg":"$age"}}},{"$project":{"_id":0}}]}"#).unwrap();
        assert_eq!(r.rows[0]["avg"].as_f64().map(|v| v.round()), Some(37.0));
        let r = raw_mongo(
            &config,
            r#"{"collection":"people","op":"distinct","field":"n"}"#,
        )
        .unwrap();
        assert_eq!(r.rows.len(), 3);
        assert!(raw_mongo(
            &config,
            r#"{"collection":"people","op":"aggregate","pipeline":[{"$out":"x"}]}"#
        )
        .is_err());
    }

    #[test]
    fn mongo_uri_is_not_in_the_process_arguments() {
        let uri = "mongodb://admin:hunter2@db.example:27017/app";
        let cmd = mongosh_command(uri, "db.runCommand({ ping: 1 })");
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(args.iter().all(|a| !a.contains("hunter2")), "{args:?}");
        let env: Vec<(String, String)> = cmd
            .get_envs()
            .filter_map(|(k, v)| Some((k.to_str()?.into(), v?.to_str()?.into())))
            .collect();
        assert!(env.contains(&(MONGO_URI_ENV.to_string(), uri.to_string())));
    }

    #[cfg(unix)]
    #[test]
    fn deadline_kills_a_child_that_runs_too_long() {
        let child = std::process::Command::new("sleep")
            .arg("30")
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let started = std::time::Instant::now();
        let out = wait_with_deadline(child, Duration::from_millis(200)).unwrap();
        assert!(!out.status.success());
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn sqlite_files_are_opened_read_only() {
        let dir = tmp_dir("sqlite");
        let path = dir.join("app.sqlite");
        {
            use std::str::FromStr as _;
            let opts =
                sqlx::sqlite::SqliteConnectOptions::from_str(&sqlite_url(path.to_str().unwrap()))
                    .unwrap()
                    .create_if_missing(true);
            let pool = SqlitePoolOptions::new().connect_with(opts).await.unwrap();
            sqlx::query("CREATE TABLE t (x INTEGER)")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
        }
        let url = sqlite_url(path.to_str().unwrap());
        let res = raw_sqlite(&url, "SELECT count(*) AS n FROM t").await;
        assert!(res.is_ok());
        let pool = connect_sqlite(&url).await.unwrap();
        let write = sqlx::query("INSERT INTO t VALUES (1)").execute(&pool).await;
        pool.close().await;
        assert!(write.is_err(), "a write went through a read-only explorer");
        // A missing file is never created.
        assert!(
            connect_sqlite(&sqlite_url(dir.join("nope.sqlite").to_str().unwrap()))
                .await
                .is_err()
        );
        assert!(!dir.join("nope.sqlite").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Against a real PostgreSQL: `PROMPTOPS_TEST_PG_URL=postgres://… cargo
    /// test --lib db::tests::pg_session -- --ignored`. Nothing is written: the
    /// write is refused by the server.
    #[tokio::test]
    #[ignore]
    async fn pg_session_is_read_only() {
        let url = std::env::var("PROMPTOPS_TEST_PG_URL").expect("PROMPTOPS_TEST_PG_URL");
        let pool = connect_pgsql(&url).await.unwrap();
        let res = sqlx::query("CREATE TEMP TABLE po_ro_probe (x int)")
            .execute(&pool)
            .await;
        pool.close().await;
        let err = res.expect_err("write accepted").to_string();
        assert!(err.contains("read-only"), "{err}");
    }
}
