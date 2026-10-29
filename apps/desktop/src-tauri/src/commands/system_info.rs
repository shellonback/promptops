//! System info: four IPC domains in a single module of Tauri 2 commands:
//!
//!   - `storage:*`         → storage audit and cleanup
//!   - `diagnostics:*`     → memory diagnostics
//!   - `hardware:*`        → hardware scan (detector, LLM recommender,
//!                            model catalog)
//!   - `background-task:*` → background task registry
//!
//! Channel → command map (snake_case):
//!   storage:audit          → storage_audit
//!   storage:cleanup        → storage_cleanup
//!   storage:get-last-audit → storage_get_last_audit
//!   diagnostics:memory     → diagnostics_memory
//!   hardware:scan          → hardware_scan
//!   background-task:list   → background_task_list
//!   background-task:update → background_task_update   (push via AppHandle::emit)
//!
//! Implementation choices:
//!   - `hardware:scan` uses the `sysinfo` crate for CPU/RAM (+ best-effort GPU via
//!     platform commands), then the pure recommender.
//!   - `diagnostics:memory` uses `sysinfo` for the process/system snapshot:
//!     the `main`, `appProcesses`/`appProcessTotals` fields (the native
//!     process + its children), `terminals`, and `nativeTree` (Windows).
//!   - `storage:audit/cleanup` walk the folders the app really writes
//!     (`StorageRoots`), measure them all and clean only caches and exports.
//!   - `background-task:list/update` are push: `BackgroundTaskManager` (Arc +
//!     parking_lot::Mutex) holds the `sessionId:taskId` store, and
//!     `background_task_update` re-emits `background-task:update` to the renderer.
//!
//! The only extra crate beyond the base set is `sysinfo`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
// NB: we only use the stable (cross-version) subset of `sysinfo`:
// `System::new_all()`, `processes()`, `process.memory()/name()/parent()/run_time()`,
// `total_memory()/free_memory()/cpus()/cpu.brand()`. We avoid the `RefreshKind`
// constructors/`refresh_processes` signatures that change between minors.
use sysinfo::{Pid, System};
use tauri::{AppHandle, Emitter, Manager};

// ═══════════════════════════════════════════════════════════════════════════
//  Channel constants
// ═══════════════════════════════════════════════════════════════════════════

/// `background-task:update` — main → renderer (push).
const BACKGROUND_TASK_UPDATE: &str = "background-task:update";

// ───────────────────────────────────────────────────────────────────────────
//  Common helper: <userData> (app_data_dir). Mirror of app.getPath('userData').
// ───────────────────────────────────────────────────────────────────────────

fn user_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app data dir not available: {e}"))
}

fn now_iso() -> String {
    // ISO-8601 UTC to the millisecond, like `new Date().toISOString()`.
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let millis = dur.subsec_millis();
    // Minimal epoch → calendar conversion (proleptic Gregorian, UTC).
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

/// Howard Hinnant's days→civil (proleptic Gregorian). days = 0 → 1970-01-01.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

// ═══════════════════════════════════════════════════════════════════════════
//  STORAGE — audit and cleanup
// ═══════════════════════════════════════════════════════════════════════════

// ── Types ───────────────────────────────────────────────────────────────────

/// `StorageAuditEntry`. `area` is the stable id the renderer translates
/// (`label` is the English fallback); `cleanable` says whether the cleanup
/// touches this area at all.
#[derive(Clone, Serialize)]
pub struct StorageAuditEntry {
    pub area: String,
    pub label: String,
    pub path: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "itemCount")]
    pub item_count: u64,
    #[serde(rename = "overThreshold")]
    pub over_threshold: bool,
    pub cleanable: bool,
}

/// `StorageAudit`.
#[derive(Clone, Serialize)]
pub struct StorageAudit {
    pub timestamp: String,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "needsCleanup")]
    pub needs_cleanup: bool,
    pub entries: Vec<StorageAuditEntry>,
}

/// The areas the cleanup may touch: caches the app rebuilds on its own and
/// usage exports. Everything else (sessions, terminal history, usage history,
/// backups, logs) is only measured.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CleanupArea {
    SemanticIndex,
    ContextSnapshots,
    WebviewCache,
    UsageExports,
}

impl CleanupArea {
    const ALL: [CleanupArea; 4] = [
        CleanupArea::SemanticIndex,
        CleanupArea::ContextSnapshots,
        CleanupArea::WebviewCache,
        CleanupArea::UsageExports,
    ];

    fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "semantic-index" => CleanupArea::SemanticIndex,
            "context-snapshots" => CleanupArea::ContextSnapshots,
            "webview-cache" => CleanupArea::WebviewCache,
            "usage-exports" => CleanupArea::UsageExports,
            _ => return None,
        })
    }

    fn id(self) -> &'static str {
        match self {
            CleanupArea::SemanticIndex => "semantic-index",
            CleanupArea::ContextSnapshots => "context-snapshots",
            CleanupArea::WebviewCache => "webview-cache",
            CleanupArea::UsageExports => "usage-exports",
        }
    }
}

/// `CleanupResult`.
#[derive(Clone, Serialize)]
pub struct CleanupResult {
    pub area: String,
    #[serde(rename = "freedBytes")]
    pub freed_bytes: u64,
    #[serde(rename = "removedItems")]
    pub removed_items: u64,
    #[serde(rename = "error", skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `CleanupReport`.
#[derive(Clone, Serialize)]
pub struct CleanupReport {
    pub timestamp: String,
    #[serde(rename = "totalFreedBytes")]
    pub total_freed_bytes: u64,
    pub results: Vec<CleanupResult>,
    pub partial: bool,
}

/// Thresholds of the audit and age limits of the cleanup.
#[derive(Clone, Copy)]
pub struct StorageThresholds {
    pub total_max_bytes: u64,
    pub cache_max_bytes: u64,
    pub semantic_index_max_age_days: f64,
    pub context_snapshot_max_age_days: f64,
    pub export_max_age_days: f64,
}

impl Default for StorageThresholds {
    fn default() -> Self {
        Self {
            total_max_bytes: 1024 * 1024 * 1024, // 1 GB (voice models alone can be 500 MB)
            cache_max_bytes: 200 * 1024 * 1024,  // 200 MB
            semantic_index_max_age_days: 7.0,
            context_snapshot_max_age_days: 7.0,
            export_max_age_days: 7.0,
        }
    }
}

/// Folders the app really writes (Tauri layout, not the Electron one).
#[derive(Clone, Debug)]
pub struct StorageRoots {
    /// `<data>/promptops-oss` (hook_data_dir): local store, terminal history,
    /// usage, semantic index, context snapshots, hook backups.
    pub data: PathBuf,
    /// `app_data_dir()` (the bundle identifier): plugins, voice models, CLI.
    pub app_data: PathBuf,
    /// `app_log_dir()`: diagnostic reports.
    pub logs: Option<PathBuf>,
    /// WebView caches (safe to delete: the webview rebuilds them).
    pub webview_caches: Vec<PathBuf>,
    /// WebView website data (localStorage, IndexedDB): measured, never deleted.
    pub webview_data: Option<PathBuf>,
}

impl StorageRoots {
    fn from_app(app: &AppHandle) -> Result<Self, String> {
        let app_data = user_data_dir(app)?;
        let identifier = app.config().identifier.clone();
        let mut webview_caches = Vec::new();
        let mut webview_data = None;
        if cfg!(target_os = "windows") {
            // WebView2 keeps caches and website data side by side under
            // EBWebView: only the cache folders are listed here.
            if let Ok(local) = app.path().app_local_data_dir() {
                let profile = local.join("EBWebView").join("Default");
                for name in ["Cache", "Code Cache", "GPUCache"] {
                    webview_caches.push(profile.join(name));
                }
                webview_data = Some(local.join("EBWebView"));
            }
        } else {
            if let Ok(cache) = app.path().app_cache_dir() {
                webview_caches.push(cache);
            }
            if cfg!(target_os = "macos") {
                if let Ok(home) = app.path().home_dir() {
                    webview_data = Some(home.join("Library/WebKit").join(&identifier));
                }
            }
        }
        Ok(Self {
            data: crate::commands::hook::hook_data_dir(),
            app_data,
            logs: app.path().app_log_dir().ok(),
            webview_caches,
            webview_data,
        })
    }

    fn usage_dir(&self) -> PathBuf {
        self.data.join("promptops")
    }
}

// ── fs helpers ──────────────────────────────────────────────────────────────

/// Recursive sum (bytes, files). Errors are ignored (best-effort). Symlinks
/// are not followed.
fn dir_size(dir: &Path) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut count = 0u64;
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return (0, 0),
    };
    for entry in entries.flatten() {
        let full = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => {
                let (b, c) = dir_size(&full);
                bytes += b;
                count += c;
            }
            Ok(ft) if ft.is_file() => {
                if let Ok(meta) = std::fs::symlink_metadata(&full) {
                    bytes += meta.len();
                    count += 1;
                }
            }
            _ => { /* symlinks and unreadable entries are skipped */ }
        }
    }
    (bytes, count)
}

/// mtime in ms, 0 if unreadable.
fn file_mtime_ms(path: &Path) -> f64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Newest mtime of the files under `dir` (a directory's own mtime does not
/// change when a file in it is rewritten in place).
/// An empty folder falls back to its own mtime.
fn newest_mtime_ms(dir: &Path) -> f64 {
    let mut newest = 0.0f64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let full = entry.path();
            let t = match entry.file_type() {
                Ok(ft) if ft.is_dir() => newest_mtime_ms(&full),
                _ => file_mtime_ms(&full),
            };
            newest = newest.max(t);
        }
    }
    if newest == 0.0 {
        file_mtime_ms(dir)
    } else {
        newest
    }
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn age_days(mtime_ms: f64) -> f64 {
    if mtime_ms == 0.0 {
        return f64::INFINITY;
    }
    (now_ms() - mtime_ms) / (1000.0 * 60.0 * 60.0 * 24.0)
}

/// Removes a file, returns the bytes freed (0 on failure).
fn safe_unlink(path: &Path) -> u64 {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    match std::fs::remove_file(path) {
        Ok(_) => size,
        Err(_) => 0,
    }
}

/// Removes a dir and its contents, returns the bytes freed.
fn safe_rmdir(path: &Path) -> u64 {
    let (bytes, _) = dir_size(path);
    match std::fs::remove_dir_all(path) {
        Ok(_) => bytes,
        Err(_) => 0,
    }
}

fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// Files directly in `dir` whose name satisfies `keep`.
fn files_in(dir: &Path, keep: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .filter(|e| keep(&e.file_name().to_string_lossy()))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default()
}

fn is_usage_export(name: &str) -> bool {
    name.starts_with("promptops-usage-") && (name.ends_with(".json") || name.ends_with(".csv"))
}

fn sum_files(files: &[PathBuf]) -> (u64, u64) {
    (files.iter().map(|f| file_size(f)).sum(), files.len() as u64)
}

// ── audit ───────────────────────────────────────────────────────────────────

fn entry(
    area: &str,
    label: &str,
    path: &Path,
    (size_bytes, item_count): (u64, u64),
    over_threshold: bool,
    cleanable: bool,
) -> StorageAuditEntry {
    StorageAuditEntry {
        area: area.into(),
        label: label.into(),
        path: path.to_string_lossy().into_owned(),
        size_bytes,
        item_count,
        over_threshold,
        cleanable,
    }
}

fn run_audit(roots: &StorageRoots, thresholds: &StorageThresholds) -> StorageAudit {
    let mut entries: Vec<StorageAuditEntry> = Vec::new();
    let usage = roots.usage_dir();

    // ── Cleanable: caches the app rebuilds, and usage exports ──
    let semantic = roots.data.join(crate::commands::semantic::INDEX_STORE_DIR);
    let size = dir_size(&semantic);
    entries.push(entry(
        "semantic-index",
        "Semantic search index",
        &semantic,
        size,
        size.0 > thresholds.cache_max_bytes,
        true,
    ));

    let snapshots = roots.data.join("context-snapshots");
    let size = dir_size(&snapshots);
    entries.push(entry(
        "context-snapshots",
        "Project context snapshots",
        &snapshots,
        size,
        false,
        true,
    ));

    let mut cache = (0u64, 0u64);
    for dir in &roots.webview_caches {
        let (b, c) = dir_size(dir);
        cache.0 += b;
        cache.1 += c;
    }
    let cache_path = roots.webview_caches.first().cloned().unwrap_or_default();
    entries.push(entry(
        "webview-cache",
        "Web view cache",
        &cache_path,
        cache,
        cache.0 > thresholds.cache_max_bytes,
        true,
    ));

    let exports = files_in(&usage, is_usage_export);
    entries.push(entry(
        "usage-exports",
        "Usage exports",
        &usage,
        sum_files(&exports),
        false,
        true,
    ));

    // ── Measured only ──
    let history: Vec<PathBuf> = [
        "token-efficiency-history.json",
        "usage.json",
        "usage-scan-index.json",
    ]
    .iter()
    .map(|n| usage.join(n))
    .filter(|p| p.is_file())
    .collect();
    entries.push(entry(
        "usage-history",
        "Usage history",
        &usage,
        sum_files(&history),
        false,
        false,
    ));

    let parked = roots.data.join("parked-buffers");
    entries.push(entry(
        "terminal-history",
        "Terminal history",
        &parked,
        dir_size(&parked),
        false,
        false,
    ));

    let store = roots.data.join("local-store.json");
    entries.push(entry(
        "local-data",
        "Sessions and settings",
        &store,
        sum_files(
            &[store.clone()]
                .into_iter()
                .filter(|p| p.is_file())
                .collect::<Vec<_>>(),
        ),
        false,
        false,
    ));

    let pre_import = files_in(&roots.data, |n| n.starts_with("local-store.pre-import-"));
    entries.push(entry(
        "pre-import-copies",
        "Copies kept before a restore",
        &roots.data,
        sum_files(&pre_import),
        false,
        false,
    ));

    let backups = roots.data.join("config-backups");
    entries.push(entry(
        "config-backups",
        "Agent config backups",
        &backups,
        dir_size(&backups),
        false,
        false,
    ));

    let plugins = roots.app_data.join("plugins");
    let audit_logs = files_in(&plugins, |n| n == "audit.log" || n == "audit.log.1");
    entries.push(entry(
        "plugin-audit-log",
        "Plugin activity log",
        &plugins.join("audit.log"),
        sum_files(&audit_logs),
        false,
        false,
    ));

    let models = roots.app_data.join("models");
    entries.push(entry(
        "voice-models",
        "Voice models",
        &models,
        dir_size(&models),
        false,
        false,
    ));

    if let Some(logs) = &roots.logs {
        let reports = logs.join("reports");
        entries.push(entry(
            "diagnostic-reports",
            "Diagnostic reports",
            &reports,
            dir_size(&reports),
            false,
            false,
        ));
    }

    if let Some(data) = &roots.webview_data {
        entries.push(entry(
            "webview-data",
            "Web view data",
            data,
            dir_size(data),
            false,
            false,
        ));
    }

    let total_bytes: u64 = entries.iter().map(|e| e.size_bytes).sum();
    let needs_cleanup = entries.iter().any(|e| e.over_threshold && e.cleanable)
        || total_bytes > thresholds.total_max_bytes;

    StorageAudit {
        timestamp: now_iso(),
        total_bytes,
        needs_cleanup,
        entries,
    }
}

// ── cleanup ─────────────────────────────────────────────────────────────────

fn result(area: CleanupArea, freed_bytes: u64, removed_items: u64) -> CleanupResult {
    CleanupResult {
        area: area.id().into(),
        freed_bytes,
        removed_items,
        error: None,
    }
}

/// Per-workspace semantic index folders not used for `max_age_days`.
fn cleanup_semantic_index(roots: &StorageRoots, max_age_days: f64) -> CleanupResult {
    let dir = roots.data.join(crate::commands::semantic::INDEX_STORE_DIR);
    let (mut freed, mut removed) = (0u64, 0u64);
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let full = e.path();
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if age_days(newest_mtime_ms(&full)) > max_age_days {
                freed += safe_rmdir(&full);
                removed += 1;
            }
        }
    }
    result(CleanupArea::SemanticIndex, freed, removed)
}

/// Files directly in `dir` matching `keep` and older than `max_age_days`.
fn cleanup_old_files(
    area: CleanupArea,
    dir: &Path,
    keep: impl Fn(&str) -> bool,
    max_age_days: f64,
) -> CleanupResult {
    let (mut freed, mut removed) = (0u64, 0u64);
    for f in files_in(dir, keep) {
        if age_days(file_mtime_ms(&f)) > max_age_days {
            freed += safe_unlink(&f);
            removed += 1;
        }
    }
    result(area, freed, removed)
}

/// Empties the web view cache folders (the folders themselves stay).
fn cleanup_webview_cache(roots: &StorageRoots) -> CleanupResult {
    let (mut freed, mut removed) = (0u64, 0u64);
    for dir in &roots.webview_caches {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for e in entries.flatten() {
            let full = e.path();
            match e.file_type() {
                Ok(t) if t.is_dir() => {
                    let (_, c) = dir_size(&full);
                    let b = safe_rmdir(&full);
                    if b > 0 || !full.exists() {
                        freed += b;
                        removed += c;
                    }
                }
                Ok(_) => {
                    freed += safe_unlink(&full);
                    removed += 1;
                }
                Err(_) => {}
            }
        }
    }
    result(CleanupArea::WebviewCache, freed, removed)
}

fn cleanup_area(area: CleanupArea, roots: &StorageRoots, thr: &StorageThresholds) -> CleanupResult {
    match area {
        CleanupArea::SemanticIndex => {
            cleanup_semantic_index(roots, thr.semantic_index_max_age_days)
        }
        CleanupArea::ContextSnapshots => cleanup_old_files(
            area,
            &roots.data.join("context-snapshots"),
            |n| n.ends_with(".json"),
            thr.context_snapshot_max_age_days,
        ),
        CleanupArea::WebviewCache => cleanup_webview_cache(roots),
        CleanupArea::UsageExports => cleanup_old_files(
            area,
            &roots.usage_dir(),
            is_usage_export,
            thr.export_max_age_days,
        ),
    }
}

/// `areas`: ids from the audit; unknown or measured-only ids are ignored, so
/// nothing outside the cleanable areas can ever be deleted.
fn run_cleanup(
    roots: &StorageRoots,
    areas: Option<Vec<String>>,
    thr: &StorageThresholds,
) -> CleanupReport {
    let target_areas: Vec<CleanupArea> = match areas {
        Some(list) => {
            let mut out: Vec<CleanupArea> = Vec::new();
            for a in list.iter().filter_map(|a| CleanupArea::from_str(a)) {
                if !out.contains(&a) {
                    out.push(a);
                }
            }
            out
        }
        None => CleanupArea::ALL.to_vec(),
    };
    let results: Vec<CleanupResult> = target_areas
        .into_iter()
        .map(|area| cleanup_area(area, roots, thr))
        .collect();
    let total_freed: u64 = results.iter().map(|r| r.freed_bytes).sum();
    CleanupReport {
        timestamp: now_iso(),
        total_freed_bytes: total_freed,
        results,
        partial: false,
    }
}

// ── STORAGE commands ─────────────────────────────────────────────────────────

/// Shared storage state: thresholds + `lastAudit` cache (mirror of the
/// `thresholds` / `lastAudit` members of StorageManager).
pub struct StorageManagerState {
    thresholds: StorageThresholds,
    last_audit: Mutex<Option<StorageAudit>>,
}

impl Default for StorageManagerState {
    fn default() -> Self {
        Self {
            thresholds: StorageThresholds::default(),
            last_audit: Mutex::new(None),
        }
    }
}

impl StorageManagerState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// storage:audit — run a lightweight storage audit. Mirror of the handler that
/// returns `null` on error (here `Ok(None)`).
#[tauri::command]
pub async fn storage_audit(
    app: AppHandle,
    storage: tauri::State<'_, Arc<StorageManagerState>>,
) -> Result<Option<StorageAudit>, String> {
    let roots = match StorageRoots::from_app(&app) {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    // Off the async workers: the audit walks whole directory trees.
    let storage = storage.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let audit = run_audit(&roots, &storage.thresholds);
        *storage.last_audit.lock() = Some(audit.clone());
        Some(audit)
    })
    .await
    .map_err(|e| e.to_string())
}

/// storage:cleanup — run cleanup (optionally scoped to specific areas). Only
/// the cleanable areas exist here (caches and usage exports): sessions,
/// terminal history and backups are never touched, so the active session ids
/// the renderer may still pass are accepted and ignored.
#[tauri::command]
pub async fn storage_cleanup(
    app: AppHandle,
    storage: tauri::State<'_, Arc<StorageManagerState>>,
    areas: Option<Vec<String>>,
    active_session_ids: Option<Vec<String>>,
) -> Result<Option<CleanupReport>, String> {
    let _ = active_session_ids;
    let roots = match StorageRoots::from_app(&app) {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    let thresholds = storage.thresholds;
    tauri::async_runtime::spawn_blocking(move || Some(run_cleanup(&roots, areas, &thresholds)))
        .await
        .map_err(|e| e.to_string())
}

/// storage:get-last-audit — return cached audit without re-running.
#[tauri::command]
pub async fn storage_get_last_audit(
    storage: tauri::State<'_, Arc<StorageManagerState>>,
) -> Result<Option<StorageAudit>, String> {
    // Tauri gotcha: an async command with State MUST return Result — the
    // bridge doesn't change, invoke unwraps the Ok.
    Ok(storage.last_audit.lock().clone())
}

// ═══════════════════════════════════════════════════════════════════════════
//  DIAGNOSTICS — memory snapshot
// ═══════════════════════════════════════════════════════════════════════════
//
// There's no V8 in Tauri, so the snapshot (`MemorySnapshot`) is built with
// `sysinfo`: `main` = current native process; `appProcesses` = process
// + children; `terminals` from the PTY pool; `nativeTree` (Windows) from the
// descendant tree.

#[derive(Clone, Serialize)]
pub struct MainMemory {
    #[serde(rename = "rssBytes")]
    pub rss_bytes: u64,
    #[serde(rename = "heapUsedBytes")]
    pub heap_used_bytes: u64,
    #[serde(rename = "heapTotalBytes")]
    pub heap_total_bytes: u64,
    #[serde(rename = "externalBytes")]
    pub external_bytes: u64,
    #[serde(rename = "arrayBuffersBytes")]
    pub array_buffers_bytes: u64,
}

#[derive(Clone, Serialize)]
pub struct AppProcessMetric {
    #[serde(rename = "type")]
    pub kind: String,
    pub pid: i64,
    #[serde(rename = "workingSetSizeKB")]
    pub working_set_size_kb: u64,
    #[serde(rename = "peakWorkingSetSizeKB")]
    pub peak_working_set_size_kb: u64,
    #[serde(rename = "privateBytesKB")]
    pub private_bytes_kb: Option<u64>,
}

#[derive(Clone, Serialize)]
pub struct AppProcessTotals {
    pub count: u64,
    #[serde(rename = "workingSetSizeKB")]
    pub working_set_size_kb: u64,
}

#[derive(Clone, Serialize)]
pub struct NativeTreeGroup {
    pub name: String,
    pub count: u64,
    #[serde(rename = "rssBytes")]
    pub rss_bytes: u64,
}

#[derive(Clone, Serialize)]
pub struct NativeTree {
    #[serde(rename = "rootPid")]
    pub root_pid: i64,
    #[serde(rename = "totalProcesses")]
    pub total_processes: u64,
    #[serde(rename = "totalRssBytes")]
    pub total_rss_bytes: u64,
    #[serde(rename = "byName")]
    pub by_name: Vec<NativeTreeGroup>,
    #[serde(rename = "conhostCount")]
    pub conhost_count: u64,
    #[serde(rename = "conhostRssBytes")]
    pub conhost_rss_bytes: u64,
}

#[derive(Clone, Serialize)]
pub struct TerminalsInfo {
    pub count: u64,
    pub pids: Vec<i64>,
}

#[derive(Clone, Serialize)]
pub struct ProbeInfo {
    #[serde(rename = "activeProcPid")]
    pub active_proc_pid: Option<i64>,
    pub probing: bool,
    #[serde(rename = "cliSnapshotCount")]
    pub cli_snapshot_count: u64,
    #[serde(rename = "tokenSnapshotCount")]
    pub token_snapshot_count: u64,
    #[serde(rename = "lastProbeProviderCount")]
    pub last_probe_provider_count: u64,
    #[serde(rename = "subAgentProviderCount")]
    pub sub_agent_provider_count: u64,
}

#[derive(Clone, Serialize)]
pub struct SemanticInfo {
    #[serde(rename = "isReady")]
    pub is_ready: bool,
    #[serde(rename = "chunkCount")]
    pub chunk_count: u64,
    #[serde(rename = "embeddingCount")]
    pub embedding_count: u64,
}

#[derive(Clone, Serialize)]
pub struct MemorySnapshot {
    pub ts: String,
    pub platform: String,
    #[serde(rename = "uptimeSec")]
    pub uptime_sec: u64,
    pub main: MainMemory,
    #[serde(rename = "appProcesses")]
    pub app_processes: Vec<AppProcessMetric>,
    #[serde(rename = "appProcessTotals")]
    pub app_process_totals: AppProcessTotals,
    pub terminals: TerminalsInfo,
    pub probe: ProbeInfo,
    pub semantic: SemanticInfo,
    #[serde(rename = "nativeTree", skip_serializing_if = "Option::is_none")]
    pub native_tree: Option<NativeTree>,
}

/// `{ ok, snapshot }` / `{ ok, error }` (mirror of the diagnostics handler).
#[derive(Clone, Serialize)]
pub struct DiagnosticsMemoryResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<MemorySnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn platform_label() -> String {
    // Mirror of the NodeJS.Platform values.
    if cfg!(target_os = "macos") {
        "darwin".into()
    } else if cfg!(target_os = "windows") {
        "win32".into()
    } else if cfg!(target_os = "linux") {
        "linux".into()
    } else {
        std::env::consts::OS.into()
    }
}

/// Builds the snapshot via sysinfo. `terminal_pids` = PIDs of the live PTYs
/// (passed by the pool, mirror of `terminalManager.pids()`).
fn build_memory_snapshot(terminal_pids: Vec<i64>) -> MemorySnapshot {
    // `new_all()` populates processes + memory + CPU; signature stable across versions.
    let sys = System::new_all();

    let self_pid_u = std::process::id();
    let self_pid = Pid::from_u32(self_pid_u);

    // ── main: footprint of the current process. ──
    // sysinfo reports memory()=RSS in bytes; there's no V8 heap natively,
    // so heap*/external/arrayBuffers stay 0 (fields kept for the renderer's shape).
    let main = match sys.process(self_pid) {
        Some(p) => MainMemory {
            rss_bytes: p.memory(),
            heap_used_bytes: 0,
            heap_total_bytes: 0,
            external_bytes: 0,
            array_buffers_bytes: 0,
        },
        None => MainMemory {
            rss_bytes: 0,
            heap_used_bytes: 0,
            heap_total_bytes: 0,
            external_bytes: 0,
            array_buffers_bytes: 0,
        },
    };

    // ── appProcesses: current process + all its descendants. ──
    let descendants = collect_descendants(&sys, self_pid_u);
    let mut app_processes: Vec<AppProcessMetric> = Vec::new();
    for pid in std::iter::once(self_pid_u).chain(descendants.iter().copied()) {
        if let Some(p) = sys.process(Pid::from_u32(pid)) {
            let ws_kb = p.memory() / 1024;
            app_processes.push(AppProcessMetric {
                kind: p.name().to_string_lossy().into_owned(),
                pid: pid as i64,
                working_set_size_kb: ws_kb,
                peak_working_set_size_kb: ws_kb,
                private_bytes_kb: None,
            });
        }
    }
    let app_process_totals = AppProcessTotals {
        count: app_processes.len() as u64,
        working_set_size_kb: app_processes.iter().map(|p| p.working_set_size_kb).sum(),
    };

    let uptime_sec = sys.process(self_pid).map(|p| p.run_time()).unwrap_or(0);

    MemorySnapshot {
        ts: now_iso(),
        platform: platform_label(),
        uptime_sec,
        main,
        app_processes,
        app_process_totals,
        terminals: TerminalsInfo {
            count: terminal_pids.len() as u64,
            pids: terminal_pids,
        },
        // probe/semantic: no usage probe nor embedding engine wired
        // to this module yet → defensive defaults are returned.
        // See the TODO section at the end.
        probe: ProbeInfo {
            active_proc_pid: None,
            probing: false,
            cli_snapshot_count: 0,
            token_snapshot_count: 0,
            last_probe_provider_count: 0,
            sub_agent_provider_count: 0,
        },
        semantic: SemanticInfo {
            is_ready: false,
            chunk_count: 0,
            embedding_count: 0,
        },
        native_tree: if cfg!(target_os = "windows") {
            Some(build_native_tree(&sys, self_pid_u))
        } else {
            None
        },
    }
}

/// BFS over children starting from `root_pid` (pid-reuse guard via `seen`).
fn collect_descendants(sys: &System, root_pid: u32) -> Vec<u32> {
    // parent → children index.
    let mut children_by_parent: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, proc_) in sys.processes() {
        if let Some(parent) = proc_.parent() {
            children_by_parent
                .entry(parent.as_u32())
                .or_default()
                .push(pid.as_u32());
        }
    }

    let mut descendants: Vec<u32> = Vec::new();
    let mut seen: Vec<u32> = vec![root_pid];
    let mut queue: Vec<u32> = vec![root_pid];
    while let Some(cur) = queue.pop() {
        if let Some(kids) = children_by_parent.get(&cur) {
            for &k in kids {
                if seen.contains(&k) {
                    continue;
                }
                seen.push(k);
                descendants.push(k);
                queue.push(k);
            }
        }
    }
    descendants
}

/// Mirror of `readWindowsNativeTree`: aggregate by image name of the whole
/// descendant tree of the main process, with `conhost.exe` spotlight.
fn build_native_tree(sys: &System, root_pid: u32) -> NativeTree {
    let descendants = collect_descendants(sys, root_pid);

    let mut by_name_map: HashMap<String, NativeTreeGroup> = HashMap::new();
    let mut total_rss = 0u64;
    let mut conhost_count = 0u64;
    let mut conhost_rss = 0u64;

    for pid in &descendants {
        if let Some(p) = sys.process(Pid::from_u32(*pid)) {
            let name = {
                let n = p.name().to_string_lossy();
                if n.is_empty() {
                    "unknown".to_string()
                } else {
                    n.to_lowercase()
                }
            };
            let rss = p.memory();
            total_rss += rss;
            let g = by_name_map.entry(name.clone()).or_insert(NativeTreeGroup {
                name: name.clone(),
                count: 0,
                rss_bytes: 0,
            });
            g.count += 1;
            g.rss_bytes += rss;
            if name == "conhost.exe" {
                conhost_count += 1;
                conhost_rss += rss;
            }
        }
    }

    let mut by_name: Vec<NativeTreeGroup> = by_name_map.into_values().collect();
    by_name.sort_by_key(|b| std::cmp::Reverse(b.rss_bytes));

    NativeTree {
        root_pid: root_pid as i64,
        total_processes: descendants.len() as u64,
        total_rss_bytes: total_rss,
        by_name,
        conhost_count,
        conhost_rss_bytes: conhost_rss,
    }
}

/// diagnostics:memory — fresh process/system memory snapshot.
///
/// `terminal_pids`: optional, PIDs of the live PTYs known to the renderer (mirror of
/// `terminalManager.pids()`). Read-only.
#[tauri::command]
pub async fn diagnostics_memory(terminal_pids: Option<Vec<i64>>) -> DiagnosticsMemoryResult {
    // Mirror of the handler's try/catch: any failure → { ok:false, error }.
    // Blocking thread: System::new_all() enumerates every process.
    let result = tauri::async_runtime::spawn_blocking(move || {
        build_memory_snapshot(terminal_pids.unwrap_or_default())
    })
    .await;
    match result {
        Ok(snapshot) => DiagnosticsMemoryResult {
            ok: true,
            snapshot: Some(snapshot),
            error: None,
        },
        Err(_) => DiagnosticsMemoryResult {
            ok: false,
            snapshot: None,
            error: Some("memory snapshot failed".into()),
        },
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  HARDWARE — scan service + detector + recommender + catalog
// ═══════════════════════════════════════════════════════════════════════════

// ── Hardware types ──────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct GpuInfo {
    pub vendor: String, // GpuVendor: nvidia|amd|apple|intel|unknown
    pub model: String,
    #[serde(rename = "vramMb")]
    pub vram_mb: u64,
    #[serde(rename = "unifiedMemory")]
    pub unified_memory: bool,
}

#[derive(Clone, Serialize)]
pub struct CpuInfo {
    pub model: String,
    pub cores: u64,
    #[serde(rename = "hasAvx")]
    pub has_avx: Option<bool>,
}

#[derive(Clone, Serialize)]
pub struct MemoryInfo {
    #[serde(rename = "totalMb")]
    pub total_mb: u64,
    #[serde(rename = "freeMb")]
    pub free_mb: u64,
}

#[derive(Clone, Serialize)]
pub struct OsInfo {
    pub platform: String,
    pub arch: String,
    pub release: String,
    pub label: String,
}

#[derive(Clone, Serialize)]
pub struct HardwareProfile {
    pub os: OsInfo,
    pub cpu: CpuInfo,
    pub memory: MemoryInfo,
    pub gpus: Vec<GpuInfo>,
    pub accelerator: String, // nvidia|amd|apple|intel|cpu
    #[serde(rename = "effectiveVramMb")]
    pub effective_vram_mb: u64,
    pub warnings: Vec<String>,
}

#[derive(Clone, Serialize)]
pub struct ModelRecommendation {
    pub id: String,
    pub name: String,
    pub family: String,
    pub compatibility: i64,
    #[serde(rename = "compatibilityLabel")]
    pub compatibility_label: String,
    #[serde(rename = "performanceLevel")]
    pub performance_level: String,
    #[serde(rename = "estimatedTokensPerSec")]
    pub estimated_tokens_per_sec: i64,
    pub fit: String, // gpu|partial|cpu
    #[serde(rename = "requiredRamGb")]
    pub required_ram_gb: f64,
    #[serde(rename = "requiredVramGb")]
    pub required_vram_gb: f64,
    #[serde(rename = "quantLabel")]
    pub quant_label: String,
    pub tasks: Vec<String>,
    pub reasons: Vec<String>,
    #[serde(rename = "setupHint")]
    pub setup_hint: String,
    pub score: f64,
}

#[derive(Clone, Serialize)]
pub struct HardwareScanResult {
    pub hardware: HardwareProfile,
    pub recommendations: Vec<ModelRecommendation>,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
}

/// `{ ok:true, data }` / `{ ok:false, error }` (mirror of the hardware handler).
#[derive(Clone, Serialize)]
pub struct HardwareScanResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<HardwareScanResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Deserialize, Default)]
pub struct HardwareScanOptions {
    pub limit: Option<usize>,
    pub task: Option<String>, // 'general'|'coding'|'reasoning'|'vision'
}

const BYTES_PER_MB: u64 = 1024 * 1024;

// ── Model catalog (frozen) ──────────────────────────────────────────────────

struct CatalogModel {
    id: &'static str,
    name: &'static str,
    family: &'static str,
    params_b: f64,
    active_params_b: Option<f64>,
    quality: f64,
    quant_bits: f64,
    quant_label: &'static str,
    context_k: f64,
    tasks: &'static [&'static str],
    setup_hint: &'static str,
}

const MODEL_CATALOG: &[CatalogModel] = &[
    CatalogModel {
        id: "llama3.2:1b",
        name: "Llama 3.2 1B",
        family: "Llama",
        params_b: 1.0,
        active_params_b: None,
        quality: 41.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 8.0,
        tasks: &["general"],
        setup_hint: "ollama pull llama3.2:1b",
    },
    CatalogModel {
        id: "gemma3:1b",
        name: "Gemma 3 1B",
        family: "Gemma",
        params_b: 1.0,
        active_params_b: None,
        quality: 44.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 8.0,
        tasks: &["general"],
        setup_hint: "ollama pull gemma3:1b",
    },
    CatalogModel {
        id: "qwen2.5:3b",
        name: "Qwen2.5 3B",
        family: "Qwen",
        params_b: 3.0,
        active_params_b: None,
        quality: 52.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 32.0,
        tasks: &["general", "coding"],
        setup_hint: "ollama pull qwen2.5:3b",
    },
    CatalogModel {
        id: "llama3.2:3b",
        name: "Llama 3.2 3B",
        family: "Llama",
        params_b: 3.0,
        active_params_b: None,
        quality: 53.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 8.0,
        tasks: &["general"],
        setup_hint: "ollama pull llama3.2:3b",
    },
    CatalogModel {
        id: "phi4-mini",
        name: "Phi-4 Mini (3.8B)",
        family: "Phi",
        params_b: 3.8,
        active_params_b: None,
        quality: 60.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 16.0,
        tasks: &["general", "reasoning"],
        setup_hint: "ollama pull phi4-mini",
    },
    CatalogModel {
        id: "qwen2.5-coder:7b",
        name: "Qwen2.5 Coder 7B",
        family: "Qwen",
        params_b: 7.0,
        active_params_b: None,
        quality: 68.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 32.0,
        tasks: &["coding", "general"],
        setup_hint: "ollama pull qwen2.5-coder:7b",
    },
    CatalogModel {
        id: "llama3.1:8b",
        name: "Llama 3.1 8B",
        family: "Llama",
        params_b: 8.0,
        active_params_b: None,
        quality: 66.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 32.0,
        tasks: &["general"],
        setup_hint: "ollama pull llama3.1:8b",
    },
    CatalogModel {
        id: "mistral:7b",
        name: "Mistral 7B",
        family: "Mistral",
        params_b: 7.0,
        active_params_b: None,
        quality: 62.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 32.0,
        tasks: &["general"],
        setup_hint: "ollama pull mistral:7b",
    },
    CatalogModel {
        id: "qwen2.5-coder:14b",
        name: "Qwen2.5 Coder 14B",
        family: "Qwen",
        params_b: 14.0,
        active_params_b: None,
        quality: 76.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 32.0,
        tasks: &["coding", "general"],
        setup_hint: "ollama pull qwen2.5-coder:14b",
    },
    CatalogModel {
        id: "phi4:14b",
        name: "Phi-4 14B",
        family: "Phi",
        params_b: 14.0,
        active_params_b: None,
        quality: 74.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 16.0,
        tasks: &["general", "reasoning"],
        setup_hint: "ollama pull phi4",
    },
    CatalogModel {
        id: "gemma3:12b",
        name: "Gemma 3 12B",
        family: "Gemma",
        params_b: 12.0,
        active_params_b: None,
        quality: 72.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 32.0,
        tasks: &["general", "vision"],
        setup_hint: "ollama pull gemma3:12b",
    },
    CatalogModel {
        id: "gpt-oss:20b",
        name: "GPT-OSS 20B (MoE)",
        family: "GPT-OSS",
        params_b: 20.0,
        active_params_b: Some(3.6),
        quality: 78.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 32.0,
        tasks: &["general", "reasoning"],
        setup_hint: "ollama pull gpt-oss:20b",
    },
    CatalogModel {
        id: "qwen2.5:32b",
        name: "Qwen2.5 32B",
        family: "Qwen",
        params_b: 32.0,
        active_params_b: None,
        quality: 82.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 32.0,
        tasks: &["general", "reasoning"],
        setup_hint: "ollama pull qwen2.5:32b",
    },
    CatalogModel {
        id: "qwen2.5-coder:32b",
        name: "Qwen2.5 Coder 32B",
        family: "Qwen",
        params_b: 32.0,
        active_params_b: None,
        quality: 84.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 32.0,
        tasks: &["coding", "general"],
        setup_hint: "ollama pull qwen2.5-coder:32b",
    },
    CatalogModel {
        id: "gemma3:27b",
        name: "Gemma 3 27B",
        family: "Gemma",
        params_b: 27.0,
        active_params_b: None,
        quality: 81.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 32.0,
        tasks: &["general", "vision"],
        setup_hint: "ollama pull gemma3:27b",
    },
    CatalogModel {
        id: "deepseek-r1:32b",
        name: "DeepSeek-R1 32B",
        family: "DeepSeek",
        params_b: 32.0,
        active_params_b: None,
        quality: 85.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 32.0,
        tasks: &["reasoning", "coding"],
        setup_hint: "ollama pull deepseek-r1:32b",
    },
    CatalogModel {
        id: "llama3.3:70b",
        name: "Llama 3.3 70B",
        family: "Llama",
        params_b: 70.0,
        active_params_b: None,
        quality: 88.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 32.0,
        tasks: &["general", "reasoning"],
        setup_hint: "ollama pull llama3.3:70b",
    },
    CatalogModel {
        id: "qwen2.5:72b",
        name: "Qwen2.5 72B",
        family: "Qwen",
        params_b: 72.0,
        active_params_b: None,
        quality: 89.0,
        quant_bits: 4.5,
        quant_label: "Q4_K_M",
        context_k: 32.0,
        tasks: &["general", "reasoning", "coding"],
        setup_hint: "ollama pull qwen2.5:72b",
    },
];

// ── LLM recommender (pure) ───────────────────────────────────────────────

const FRAMEWORK_OVERHEAD_GB: f64 = 0.5;
const USABLE_RAM_FRACTION: f64 = 0.7;

fn fit_multiplier(fit: &str) -> f64 {
    match fit {
        "gpu" => 1.0,
        "partial" => 0.72,
        _ => 0.5, // cpu
    }
}

fn clampf(n: f64, min: f64, max: f64) -> f64 {
    n.max(min).min(max)
}

fn round1(n: f64) -> f64 {
    (n * 10.0).round() / 10.0
}

fn estimate_required_gb(m: &CatalogModel) -> f64 {
    let bytes_per_weight = m.quant_bits / 8.0;
    let weights_gb = (m.params_b * 1e9 * bytes_per_weight) / 1024f64.powi(3);
    let kv_cache_gb = clampf(m.params_b * 0.0625 * (m.context_k / 8.0), 0.2, 12.0);
    round1(weights_gb + kv_cache_gb + FRAMEWORK_OVERHEAD_GB)
}

/// `classifyFit` → (fit, capacityGb) or None if it doesn't fit.
fn classify_fit(required_gb: f64, hw: &HardwareProfile) -> Option<(&'static str, f64)> {
    let eff_gpu_gb = hw.effective_vram_mb as f64 / 1024.0;
    let usable_ram_gb = (hw.memory.total_mb as f64 * USABLE_RAM_FRACTION) / 1024.0;

    if hw.accelerator == "apple" {
        if required_gb <= eff_gpu_gb {
            return Some(("gpu", eff_gpu_gb));
        }
        if required_gb <= usable_ram_gb {
            return Some(("partial", usable_ram_gb));
        }
        return None;
    }

    if (hw.accelerator == "nvidia" || hw.accelerator == "amd") && eff_gpu_gb > 0.0 {
        if required_gb <= eff_gpu_gb {
            return Some(("gpu", eff_gpu_gb));
        }
        if required_gb <= eff_gpu_gb + usable_ram_gb * 0.8 {
            return Some(("partial", eff_gpu_gb + usable_ram_gb));
        }
        if required_gb <= usable_ram_gb {
            return Some(("cpu", usable_ram_gb));
        }
        return None;
    }

    if required_gb <= usable_ram_gb {
        return Some(("cpu", usable_ram_gb));
    }
    None
}

fn compatibility_score(required_gb: f64, capacity_gb: f64, fit: &str) -> i64 {
    let util = if capacity_gb > 0.0 {
        required_gb / capacity_gb
    } else {
        1.0
    };
    let base = if fit == "gpu" {
        100.0 - util * 22.0
    } else if fit == "partial" {
        70.0 - util * 12.0
    } else {
        58.0 - util * 10.0
    };
    clampf(base, 20.0, 99.0).round() as i64
}

fn compatibility_label(score: i64, fit: &str) -> &'static str {
    if score >= 80 && fit == "gpu" {
        return "Excellent";
    }
    if score >= 60 {
        return "Good";
    }
    if score >= 38 {
        return "Limited";
    }
    "Not recommended"
}

fn estimate_tokens_per_sec(m: &CatalogModel, hw: &HardwareProfile, fit: &str) -> i64 {
    let size_for_speed = m.active_params_b.unwrap_or(m.params_b);
    let size_factor = (7.0 / size_for_speed.max(1.0)).sqrt();
    let backbone_tps = if fit == "gpu" {
        if hw.accelerator == "apple" {
            22.0
        } else {
            55.0
        }
    } else if fit == "partial" {
        16.0
    } else {
        6.0
    };
    (backbone_tps * size_factor).round().max(1.0) as i64
}

fn performance_level(tps: i64) -> &'static str {
    if tps >= 30 {
        "Fast"
    } else if tps >= 15 {
        "Good"
    } else if tps >= 7 {
        "Moderate"
    } else {
        "Slow"
    }
}

fn size_bonus(params_b: f64) -> f64 {
    clampf((params_b + 1.0).log2() * 6.0, 0.0, 35.0)
}

fn build_reasons(
    m: &CatalogModel,
    hw: &HardwareProfile,
    fit: &str,
    required_gb: f64,
    compatibility: i64,
) -> Vec<String> {
    let mut reasons: Vec<String> = Vec::new();

    if fit == "gpu" {
        if hw.accelerator == "apple" {
            reasons.push(format!(
                "Fits in your unified memory (~{} GB of {} GB).",
                round1(required_gb),
                (hw.memory.total_mb as f64 / 1024.0).round() as i64
            ));
        } else {
            reasons.push(format!(
                "Fits fully in your GPU VRAM (~{} GB of {} GB).",
                round1(required_gb),
                round1(hw.effective_vram_mb as f64 / 1024.0)
            ));
        }
    } else if fit == "partial" {
        reasons.push(format!(
            "Runs with partial GPU offload (~{} GB needed) — some layers use system RAM.",
            round1(required_gb)
        ));
    } else {
        reasons.push(format!(
            "Runs on CPU using system RAM (~{} GB needed) — slower but works without a GPU.",
            round1(required_gb)
        ));
    }

    if let Some(active) = m.active_params_b {
        reasons.push(format!(
            "Mixture-of-Experts: only ~{}B params active per token, so it stays fast for its size.",
            fmt_num(active)
        ));
    }

    if m.tasks.contains(&"coding") {
        reasons.push("Strong on coding tasks — well suited to PromptOps CLI.".into());
    } else if m.tasks.contains(&"reasoning") {
        reasons.push("Tuned for step-by-step reasoning.".into());
    }

    reasons.push(format!(
        "Recommended quantization {} balances quality and footprint.",
        m.quant_label
    ));
    reasons.push(format!(
        "Estimated {}% compatibility with this machine.",
        compatibility
    ));

    reasons
}

/// Formats a float like JS (`3.6` → "3.6", `3.0` → "3").
fn fmt_num(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        let s = format!("{n}");
        s
    }
}

fn recommend_models(
    hw: &HardwareProfile,
    options: &HardwareScanOptions,
) -> Vec<ModelRecommendation> {
    let limit = options.limit.unwrap_or(6);
    let mut recs: Vec<ModelRecommendation> = Vec::new();

    for m in MODEL_CATALOG {
        if let Some(task) = options.task.as_deref() {
            if !m.tasks.contains(&task) {
                continue;
            }
        }

        let required_gb = estimate_required_gb(m);
        let (fit, capacity_gb) = match classify_fit(required_gb, hw) {
            Some(x) => x,
            None => continue,
        };

        let compatibility = compatibility_score(required_gb, capacity_gb, fit);
        let tps = estimate_tokens_per_sec(m, hw, fit);

        let quant_retention = 0.85 + 0.15 * (m.quant_bits / 8.0);
        let fit_mult = fit_multiplier(fit);
        let score = m.quality * fit_mult * quant_retention
            + size_bonus(m.params_b) * 0.4
            + compatibility as f64 * 0.15;

        recs.push(ModelRecommendation {
            id: m.id.into(),
            name: m.name.into(),
            family: m.family.into(),
            compatibility,
            compatibility_label: compatibility_label(compatibility, fit).into(),
            performance_level: performance_level(tps).into(),
            estimated_tokens_per_sec: tps,
            fit: fit.into(),
            required_ram_gb: required_gb,
            required_vram_gb: required_gb,
            quant_label: m.quant_label.into(),
            tasks: m.tasks.iter().map(|t| t.to_string()).collect(),
            reasons: build_reasons(m, hw, fit, required_gb, compatibility),
            setup_hint: m.setup_hint.into(),
            score: (score * 10.0).round() / 10.0,
        });
    }

    recs.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    recs.truncate(limit);
    recs
}

// ── Hardware detector ────────────────────────────────────────────────────

const CMD_TIMEOUT_MS: u64 = 6000;

/// `run(cmd,args)` — trimmed stdout, or None on failure or after
/// CMD_TIMEOUT_MS. A hung `nvidia-smi` (driver reset) or `system_profiler`
/// used to hold the hardware scan, and its worker thread, forever.
fn run_cmd(cmd: &str, args: &[&str]) -> Option<String> {
    run_cmd_with_timeout(cmd, args, std::time::Duration::from_millis(CMD_TIMEOUT_MS))
}

fn run_cmd_with_timeout(cmd: &str, args: &[&str], timeout: std::time::Duration) -> Option<String> {
    use std::io::Read;
    use std::process::Stdio;
    let mut child = crate::commands::util_cmd::cmd(cmd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // Drain stdout on its own thread: a full pipe must not stall the child.
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let out = reader.join().unwrap_or_default();
    if !status?.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out).trim().to_string())
}

fn detect_os() -> OsInfo {
    let platform = platform_label();
    let arch = std::env::consts::ARCH.to_string(); // x86_64 / aarch64 …
    let pretty = match platform.as_str() {
        "darwin" => "macOS",
        "win32" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    OsInfo {
        release: os_release(),
        label: format!("{pretty} ({arch})"),
        platform,
        arch,
    }
}

fn os_release() -> String {
    // Approximate mirror of os.release().
    #[cfg(unix)]
    {
        run_cmd("uname", &["-r"]).unwrap_or_default()
    }
    #[cfg(not(unix))]
    {
        run_cmd("cmd", &["/C", "ver"]).unwrap_or_default()
    }
}

fn detect_memory(sys: &System) -> MemoryInfo {
    MemoryInfo {
        total_mb: (sys.total_memory() as f64 / BYTES_PER_MB as f64).round() as u64,
        free_mb: (sys.free_memory() as f64 / BYTES_PER_MB as f64).round() as u64,
    }
}

fn detect_cpu(sys: &System) -> CpuInfo {
    let cpus = sys.cpus();
    let model = cpus
        .first()
        .map(|c| {
            let brand = c.brand().trim();
            if brand.is_empty() {
                "Unknown CPU".to_string()
            } else {
                brand.to_string()
            }
        })
        .unwrap_or_else(|| "Unknown CPU".to_string());
    // os.cpus().length → number of logical CPUs.
    let cores = cpus.len().max(1) as u64;

    let arch = std::env::consts::ARCH;
    let mut has_avx: Option<bool> = None;
    if cfg!(target_os = "macos") {
        if arch == "aarch64" {
            has_avx = Some(true); // NEON SIMD always present
        } else {
            has_avx = run_cmd("sysctl", &["-n", "machdep.cpu.features"])
                .map(|feats| feats.to_uppercase().contains("AVX"));
        }
    } else if cfg!(target_os = "linux") {
        has_avx = std::fs::read_to_string("/proc/cpuinfo").ok().map(|info| {
            let lower = info.to_lowercase();
            lower.contains(" avx ")
                || lower.contains(" avx2 ")
                || lower.contains("\tavx\t")
                || lower.contains("avx2")
        });
    } else if cfg!(target_os = "windows") {
        has_avx = None; // left unknown
    }

    CpuInfo {
        model,
        cores,
        has_avx,
    }
}

fn classify_vendor(model: &str) -> &'static str {
    let m = model.to_lowercase();
    if m.contains("nvidia") || m.contains("geforce") || m.contains("rtx") || m.contains("gtx") {
        "nvidia"
    } else if m.contains("amd") || m.contains("radeon") {
        "amd"
    } else if m.contains("intel") {
        "intel"
    } else {
        "unknown"
    }
}

fn detect_nvidia() -> Vec<GpuInfo> {
    let out = match run_cmd(
        "nvidia-smi",
        &[
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ],
    ) {
        Some(o) if !o.is_empty() => o,
        _ => return Vec::new(),
    };
    let mut gpus = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
        let name = parts.first().copied().unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let vram = parts.get(1).and_then(|v| v.parse::<f64>().ok());
        gpus.push(GpuInfo {
            vendor: "nvidia".into(),
            model: name.to_string(),
            vram_mb: vram.map(|v| v.round() as u64).unwrap_or(0),
            unified_memory: false,
        });
    }
    gpus
}

fn detect_apple_gpu() -> Vec<GpuInfo> {
    let arch = std::env::consts::ARCH;
    let out = run_cmd("system_profiler", &["SPDisplaysDataType", "-json"]);
    let out = match out {
        Some(o) if !o.is_empty() => o,
        _ => {
            if arch == "aarch64" {
                return vec![GpuInfo {
                    vendor: "apple".into(),
                    model: "Apple Silicon GPU".into(),
                    vram_mb: 0,
                    unified_memory: true,
                }];
            }
            return Vec::new();
        }
    };
    let parsed: JsonValue = match serde_json::from_str(&out) {
        Ok(v) => v,
        Err(_) => {
            if arch == "aarch64" {
                return vec![GpuInfo {
                    vendor: "apple".into(),
                    model: "Apple Silicon GPU".into(),
                    vram_mb: 0,
                    unified_memory: true,
                }];
            }
            return Vec::new();
        }
    };
    let entries = parsed
        .get("SPDisplaysDataType")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut gpus = Vec::new();
    for entry in entries {
        let model = entry
            .get("sppci_model")
            .and_then(|v| v.as_str())
            .or_else(|| entry.get("_name").and_then(|v| v.as_str()))
            .unwrap_or("GPU")
            .to_string();
        let is_apple = model.to_lowercase().contains("apple") || arch == "aarch64";
        let vram_raw = entry
            .get("spdisplays_vram")
            .and_then(|v| v.as_str())
            .or_else(|| entry.get("_spdisplays_vram").and_then(|v| v.as_str()))
            .unwrap_or("");
        let vram_mb = parse_gb_to_mb(vram_raw);
        let vendor = if is_apple {
            "apple".to_string()
        } else {
            classify_vendor(&model).to_string()
        };
        gpus.push(GpuInfo {
            vendor,
            model,
            vram_mb,
            unified_memory: is_apple,
        });
    }
    gpus
}

/// "8 GB" → 8*1024 MB; otherwise 0. Mirror of the `/(\d+)\s*GB/i` match.
fn parse_gb_to_mb(s: &str) -> u64 {
    let lower = s.to_lowercase();
    if let Some(idx) = lower.find("gb") {
        let prefix = &lower[..idx];
        let digits: String = prefix
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_digit() || c.is_whitespace())
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        if let Ok(n) = digits.trim().parse::<u64>() {
            return n * 1024;
        }
    }
    0
}

fn detect_windows_gpu() -> Vec<GpuInfo> {
    let out = match run_cmd(
        "powershell",
        &[
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress",
        ],
    ) {
        Some(o) if !o.is_empty() => o,
        _ => return Vec::new(),
    };
    let parsed: JsonValue = match serde_json::from_str(&out) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let list = match &parsed {
        JsonValue::Array(a) => a.clone(),
        other => vec![other.clone()],
    };
    let mut gpus = Vec::new();
    for item in list {
        let model = item
            .get("Name")
            .and_then(|v| v.as_str())
            .unwrap_or("GPU")
            .to_string();
        let ram_bytes = item
            .get("AdapterRAM")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let vendor = classify_vendor(&model).to_string();
        gpus.push(GpuInfo {
            vram_mb: if ram_bytes > 0.0 {
                (ram_bytes / BYTES_PER_MB as f64).round() as u64
            } else {
                0
            },
            unified_memory: model.to_lowercase().contains("intel"),
            vendor,
            model,
        });
    }
    gpus
}

fn detect_linux_gpu() -> Vec<GpuInfo> {
    let out = match run_cmd("sh", &["-c", "lspci | grep -iE 'vga|3d|display'"]) {
        Some(o) if !o.is_empty() => o,
        _ => return Vec::new(),
    };
    let mut gpus = Vec::new();
    for line in out.lines() {
        // line.replace(/^.*: /, '')
        let model = match line.rfind(": ") {
            Some(idx) => line[idx + 2..].trim().to_string(),
            None => line.trim().to_string(),
        };
        if model.is_empty() {
            continue;
        }
        let vendor = classify_vendor(&model).to_string();
        gpus.push(GpuInfo {
            unified_memory: model.to_lowercase().contains("intel"),
            vram_mb: 0,
            vendor,
            model,
        });
    }
    gpus
}

/// `mergeGpus` — dedup by vendor|model, preferring known VRAM.
fn merge_gpus(lists: Vec<Vec<GpuInfo>>) -> Vec<GpuInfo> {
    let mut by_key: Vec<(String, GpuInfo)> = Vec::new();
    for gpu in lists.into_iter().flatten() {
        let key = format!("{}|{}", gpu.vendor, gpu.model.to_lowercase());
        if let Some(slot) = by_key.iter_mut().find(|(k, _)| *k == key) {
            if gpu.vram_mb > slot.1.vram_mb {
                slot.1 = gpu;
            }
        } else {
            by_key.push((key, gpu));
        }
    }
    by_key.into_iter().map(|(_, g)| g).collect()
}

fn detect_gpus(warnings: &mut Vec<String>) -> Vec<GpuInfo> {
    let nvidia = detect_nvidia();

    let platform_gpus = if cfg!(target_os = "macos") {
        detect_apple_gpu()
    } else if cfg!(target_os = "windows") {
        detect_windows_gpu()
    } else if cfg!(target_os = "linux") {
        detect_linux_gpu()
    } else {
        Vec::new()
    };

    let merged = merge_gpus(vec![nvidia, platform_gpus]);
    if merged.is_empty() {
        warnings.push("No GPU detected. Recommendations assume CPU-only inference.".into());
    }
    merged
}

fn derive_accelerator(gpus: &[GpuInfo], memory: &MemoryInfo) -> (String, u64) {
    let arch = std::env::consts::ARCH;
    // apple = vendor apple OR (unifiedMemory && arm64)
    let apple = gpus
        .iter()
        .find(|g| g.vendor == "apple" || (g.unified_memory && arch == "aarch64"));
    if apple.is_some() {
        return (
            "apple".into(),
            (memory.total_mb as f64 * 0.7).round() as u64,
        );
    }

    let mut discrete: Vec<&GpuInfo> = gpus
        .iter()
        .filter(|g| (g.vendor == "nvidia" || g.vendor == "amd") && g.vram_mb > 0)
        .collect();
    discrete.sort_by_key(|b| std::cmp::Reverse(b.vram_mb));
    if let Some(d) = discrete.first() {
        return (d.vendor.clone(), d.vram_mb);
    }

    if let Some(known) = gpus
        .iter()
        .find(|g| g.vendor == "nvidia" || g.vendor == "amd")
    {
        return (known.vendor.clone(), 0);
    }

    ("cpu".into(), 0)
}

fn detect_hardware() -> HardwareProfile {
    let mut warnings: Vec<String> = Vec::new();

    // `new_all()` gives us total/free memory and the CPU list (for brand+count).
    let sys = System::new_all();

    let os_info = detect_os();
    let memory = detect_memory(&sys);
    let cpu = detect_cpu(&sys);
    let gpus = detect_gpus(&mut warnings);

    let (accelerator, effective_vram_mb) = derive_accelerator(&gpus, &memory);

    if accelerator != "cpu" && accelerator != "apple" && effective_vram_mb == 0 {
        warnings.push(
            "GPU found but its VRAM could not be read; estimates fall back to system RAM.".into(),
        );
    }

    HardwareProfile {
        os: os_info,
        cpu,
        memory,
        gpus,
        accelerator,
        effective_vram_mb,
        warnings,
    }
}

/// hardware:scan — detect local hardware + rank open models. `{ ok, data }`.
#[tauri::command]
pub async fn hardware_scan(options: Option<HardwareScanOptions>) -> HardwareScanResponse {
    let opts = options.unwrap_or_default();
    // Blocking thread: up to three external commands (6 s cap each).
    let Ok(mut hardware) = tauri::async_runtime::spawn_blocking(detect_hardware).await else {
        return HardwareScanResponse {
            ok: false,
            data: None,
            error: Some("hardware scan failed".into()),
        };
    };
    let recommendations = recommend_models(&hardware, &opts);

    if recommendations.is_empty() {
        hardware.warnings.push(
            "No catalog model fits comfortably on this machine. Try freeing up RAM or a smaller quantization.".into(),
        );
    }

    let result = HardwareScanResult {
        hardware,
        recommendations,
        generated_at: now_iso(),
    };

    HardwareScanResponse {
        ok: true,
        data: Some(result),
        error: None,
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  BACKGROUND TASK — task registry
// ═══════════════════════════════════════════════════════════════════════════

/// `BackgroundTaskEntry`. `type` is a string (one of BackgroundTaskType:
/// context_injection|context_snapshot|code_graph|embeddings|session_memory|provider_usage).
#[derive(Clone, Serialize, Deserialize)]
pub struct BackgroundTaskEntry {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "type")]
    pub task_type: String,
    pub label: String,
    pub status: String, // queued|running|completed|failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// Payload of the `background-task:update` push (without `updatedAt`, the shape the
/// renderer expects).
#[derive(Clone, Serialize, Deserialize)]
pub struct BackgroundTaskPayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "type")]
    pub task_type: String,
    pub label: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// In-memory task store, keyed by `sessionId:taskId`. Mirror of `taskStore`.
#[derive(Default)]
pub struct BackgroundTaskManager {
    store: Mutex<HashMap<String, BackgroundTaskEntry>>,
}

impl BackgroundTaskManager {
    pub fn new() -> Self {
        Self::default()
    }
}

/// background-task:update — main → renderer (push) + store update.
///
/// Steps:
///  1. stores the entry with `updatedAt = now`;
///  2. forwards the payload to the renderer via `app.emit(BACKGROUND_TASK_UPDATE)`;
///  3. auto-cleans completed/failed after 2 minutes.
#[tauri::command]
pub async fn background_task_update(
    app: AppHandle,
    manager: tauri::State<'_, Arc<BackgroundTaskManager>>,
    payload: BackgroundTaskPayload,
) -> Result<(), String> {
    let key = format!("{}:{}", payload.session_id, payload.task_id);

    let entry = BackgroundTaskEntry {
        session_id: payload.session_id.clone(),
        task_id: payload.task_id.clone(),
        task_type: payload.task_type.clone(),
        label: payload.label.clone(),
        status: payload.status.clone(),
        error: payload.error.clone(),
        updated_at: now_iso(),
    };
    manager.store.lock().insert(key.clone(), entry);

    // Forward to the renderer.
    let _ = app.emit(BACKGROUND_TASK_UPDATE, &payload);

    // Auto-clean completed/failed after 2 minutes.
    if payload.status == "completed" || payload.status == "failed" {
        let manager_arc = manager.inner().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(2 * 60 * 1000));
            manager_arc.store.lock().remove(&key);
        });
    }

    Ok(())
}

/// background-task:list — active tasks for a session. Mirror of the handler:
/// iterates the store and filters by `sessionId`.
#[tauri::command]
pub async fn background_task_list(
    manager: tauri::State<'_, Arc<BackgroundTaskManager>>,
    session_id: String,
) -> Result<Vec<BackgroundTaskEntry>, String> {
    Ok(manager
        .store
        .lock()
        .values()
        .filter(|e| e.session_id == session_id)
        .cloned()
        .collect())
}

// ═══════════════════════════════════════════════════════════════════════════
//  TODO — known gaps
// ═══════════════════════════════════════════════════════════════════════════
//
//  STORAGE
//   - Logger: audit/cleanup are not logged (the commands stay pure).
//     Inject a state logger if telemetry is needed.
//   - No `cleanupRunning` guard: cleanup is
//     synchronous and single-call. Add an `AtomicBool` flag if multiple
//     concurrent calls become possible. `partial` therefore always stays `false`
//     (the individual helpers are best-effort and don't raise).
//   - `chromiumCache` has no webview cache-clear API in Tauri:
//     only an on-disk rm is done.
//   - `active_session_ids` is passed by the caller instead of coming from
//     the SessionManager (which lives in another module).
//
//  DIAGNOSTICS
//   - `main.heap*/external/arrayBuffers` = 0: there's no V8 in Tauri;
//     `rssBytes` comes from sysinfo. Fields kept
//     for the renderer's shape.
//   - `appProcesses`: the native process + descendants are listed via sysinfo. `type` =
//     image name (not "Browser/Renderer/…"). `peakWorkingSetSizeKB` ≈ current
//     and `privateBytesKB` = null (sysinfo doesn't expose them).
//   - `terminals`: the PIDs come from the caller (`terminal_pids`); wire to the
//     `TerminalManager` in terminal.rs to populate them without arguments.
//   - `probe`/`semantic`: ProviderUsageProbe and EmbeddingEngine are not yet
//     wired to this module → defensive defaults. Wire them
//     when those domains exist.
//   - No persistent jsonl + rotation (`memory-diagnostics.jsonl`) nor periodic
//     "compact summary" logs: the IPC command is on-demand only and
//     read-only. Add a timer snapshot + persistence if history is needed.
//   - `nativeTree`: the tree is rebuilt from sysinfo (cross-platform, no
//     PowerShell `Win32_Process` query), emitted only on Windows.
//
//  HARDWARE
//   - `run_cmd` kills each external command after `CMD_TIMEOUT_MS` (6 s).
//   - `has_avx` on Linux: `/proc/cpuinfo` is read directly with a loose
//     match instead of a strict `\bavx2?\b` regex.
//   - `os.release()` → `uname -r` (unix) / `cmd /C ver` (win): approximation.
//
//  BACKGROUND TASK
//   - The entry point is the `background_task_update` command, which the
//     producer (e.g. session init) must invoke. If an internal Rust event bus is added,
//     hook it here instead of/in addition to the command.
//   - Auto-clean: a thread sleeping 2 min per entry
//     (best-effort; doesn't survive a restart).
//
//  WIRING: lib.rs manages `StorageManagerState` and `BackgroundTaskManager`
//  and registers the commands; `sysinfo` is a direct dependency.

#[cfg(test)]
mod storage_tests {
    use super::*;

    fn roots() -> StorageRoots {
        let base =
            std::env::temp_dir().join(format!("po-storage-{}", crate::local_store::new_id()));
        StorageRoots {
            data: base.join("data"),
            app_data: base.join("app"),
            logs: Some(base.join("logs")),
            webview_caches: vec![base.join("cache")],
            webview_data: Some(base.join("webkit")),
        }
    }

    fn write(path: &Path, bytes: usize) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, vec![b'x'; bytes]).unwrap();
    }

    fn age(path: &Path, days: u64) {
        let t = SystemTime::now() - std::time::Duration::from_secs(days * 86_400);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(t)
            .unwrap();
    }

    #[test]
    fn the_audit_measures_the_folders_the_app_writes() {
        let r = roots();
        write(&r.data.join("semantic-index/abc/code-graph.json"), 100);
        write(&r.data.join("context-snapshots/k.json"), 10);
        write(&r.data.join("promptops/usage.json"), 7);
        write(
            &r.data.join("promptops/promptops-usage-7d-2026-10-01.csv"),
            5,
        );
        write(&r.data.join("parked-buffers/1.sealed"), 3);
        write(&r.data.join("local-store.pre-import-x.json"), 2);
        write(&r.app_data.join("plugins/audit.log"), 4);
        write(&r.app_data.join("models/ggml-base.bin"), 50);
        write(&r.logs.clone().unwrap().join("reports/r.json"), 6);
        write(&r.webview_caches[0].join("WebKit/NetworkCache/a"), 9);
        let audit = run_audit(&r, &StorageThresholds::default());
        let by = |id: &str| audit.entries.iter().find(|e| e.area == id).unwrap();
        assert_eq!(by("semantic-index").size_bytes, 100);
        assert_eq!(by("context-snapshots").size_bytes, 10);
        assert_eq!(by("usage-exports").size_bytes, 5);
        assert_eq!(by("usage-history").size_bytes, 7);
        assert_eq!(by("terminal-history").size_bytes, 3);
        assert_eq!(by("pre-import-copies").size_bytes, 2);
        assert_eq!(by("plugin-audit-log").size_bytes, 4);
        assert_eq!(by("voice-models").size_bytes, 50);
        assert_eq!(by("diagnostic-reports").size_bytes, 6);
        assert_eq!(by("webview-cache").size_bytes, 9);
        // Only caches and exports are offered for cleanup.
        let cleanable: Vec<&str> = audit
            .entries
            .iter()
            .filter(|e| e.cleanable)
            .map(|e| e.area.as_str())
            .collect();
        assert_eq!(
            cleanable,
            [
                "semantic-index",
                "context-snapshots",
                "webview-cache",
                "usage-exports"
            ]
        );
        // Electron-era areas are gone.
        assert!(audit.entries.iter().all(|e| ![
            "sessions",
            "terminal-buffers",
            "chromium-cache",
            "db-explorer"
        ]
        .contains(&e.area.as_str())));
        assert_eq!(audit.total_bytes, 196);
    }

    #[test]
    fn the_cleanup_removes_only_old_caches_and_exports() {
        let r = roots();
        let old_index = r.data.join("semantic-index/old/code-graph.json");
        let new_index = r.data.join("semantic-index/new/code-graph.json");
        let old_snap = r.data.join("context-snapshots/old.json");
        let new_snap = r.data.join("context-snapshots/new.json");
        let old_export = r.data.join("promptops/promptops-usage-7d-2026-09-01.json");
        let history = r.data.join("promptops/usage.json");
        let parked = r.data.join("parked-buffers/1.sealed");
        let cache = r.webview_caches[0].join("WebKit/NetworkCache/a");
        for (p, d) in [
            (&old_index, 30),
            (&new_index, 0),
            (&old_snap, 30),
            (&new_snap, 0),
            (&old_export, 30),
            (&history, 30),
            (&parked, 30),
            (&cache, 0),
        ] {
            write(p, 10);
            age(p, d);
        }
        // An old UI asking for Electron-era or measured-only areas deletes nothing.
        let none = run_cleanup(
            &r,
            Some(vec![
                "sessions".into(),
                "terminal-history".into(),
                "usage-history".into(),
            ]),
            &StorageThresholds::default(),
        );
        assert!(none.results.is_empty() && none.total_freed_bytes == 0);

        let report = run_cleanup(&r, None, &StorageThresholds::default());
        assert_eq!(report.total_freed_bytes, 40);
        assert!(!old_index.exists() && new_index.exists());
        assert!(!old_snap.exists() && new_snap.exists());
        assert!(!old_export.exists());
        assert!(!cache.exists() && r.webview_caches[0].exists());
        assert!(history.exists() && parked.exists());
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn external_commands_are_killed_after_the_timeout() {
        let started = std::time::Instant::now();
        let out = run_cmd_with_timeout("sleep", &["5"], std::time::Duration::from_millis(300));
        assert!(out.is_none());
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn external_commands_return_their_trimmed_output() {
        assert_eq!(
            run_cmd_with_timeout("echo", &["  hi  "], std::time::Duration::from_secs(5)),
            Some("hi".to_string())
        );
        assert_eq!(
            run_cmd_with_timeout("false", &[], std::time::Duration::from_secs(5)),
            None
        );
    }
}
