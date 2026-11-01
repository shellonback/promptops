//! Browser agent — mirror of the REAL Chrome inside the app ("Browser" page).
//!
//! Chrome runs with `--remote-debugging-port` (dedicated profile: since Chrome 136
//! the default profile rejects remote debugging). The right panel
//! of the Browser page is a CDP screencast (`Page.startScreencast`) of the
//! chosen tab: JPEG frames arrive on the Channel, mouse/keyboard/URL go
//! back as CDP commands (`Input.*`, `Page.navigate`…). The provider
//! (Claude Code / Codex) works on the same tab through its Chrome
//! extension, so the user sees in the app exactly what the agent is doing.

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

pub const DEFAULT_PORT: u16 = 9222;

// ─────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────

struct Mirror {
    tx: mpsc::UnboundedSender<String>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
pub struct BrowserMirrorManager {
    mirrors: Mutex<HashMap<String, Mirror>>,
    /// "Window" mirror (My Chrome mode): stop flag for the capture loop.
    window_mirrors: Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
}

impl BrowserMirrorManager {
    pub fn new() -> Self {
        Self::default()
    }
}

// ─────────────────────────────────────────────────────────────────────────
// DTO
// ─────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeTarget {
    pub id: String,
    pub title: String,
    pub url: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub web_socket_debugger_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeStatus {
    pub reachable: bool,
    pub port: u16,
    pub browser: Option<String>,
    pub targets: Vec<ChromeTarget>,
    pub error: Option<String>,
    /// Chrome binary found on the system.
    pub chrome_installed: bool,
    /// A Chrome process is running (even without a debug port).
    pub chrome_running: bool,
    /// Why it is NOT reachable, in words (null when reachable).
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MirrorEvent {
    /// Base64 JPEG frame + CSS viewport geometry (Input.* coordinates).
    Frame {
        data: String,
        device_width: f64,
        device_height: f64,
        page_scale: f64,
        scroll_x: f64,
        scroll_y: f64,
    },
    /// Main frame navigation (address bar URL).
    Nav { url: String },
    /// Reply to a command sent with `browser_mirror_send` (same id).
    Result { id: u64, result: Value },
    /// Window mirror status (no Chrome window, missing permission…).
    Status { message: String, permission: bool },
    /// Socket closed / target gone.
    Closed { reason: String },
}

// ─────────────────────────────────────────────────────────────────────────
// Chrome: status + launch
// ─────────────────────────────────────────────────────────────────────────

fn devtools_base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// browser_chrome_status — `GET /json/list` + `/json/version` on the DevTools
/// endpoint. `reachable=false` = Chrome not listening on the port.
#[tauri::command]
pub async fn browser_chrome_status(port: Option<u16>) -> Result<ChromeStatus, String> {
    let port = port.unwrap_or(DEFAULT_PORT);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())?;
    let base = devtools_base(port);
    let list = client.get(format!("{base}/json/list")).send().await;
    let list = match list {
        Ok(r) => r,
        Err(e) => {
            let chrome_installed = chrome_binary().is_some();
            let chrome_running = chrome_process_running();
            let reason = if !chrome_installed {
                "Google Chrome is not installed (no binary found). Install Chrome, then launch the agent profile from here.".to_string()
            } else if chrome_running {
                format!("Chrome is running, but without remote debugging on port {port}. Chrome ≥ 136 ignores --remote-debugging-port on the default profile, so launch the dedicated agent profile from here (it runs side by side with your normal Chrome).")
            } else {
                format!("Chrome is not running: nothing listens on port {port}. Launch the agent profile from here.")
            };
            return Ok(ChromeStatus {
                reachable: false,
                port,
                browser: None,
                targets: Vec::new(),
                error: Some(e.to_string()),
                chrome_installed,
                chrome_running,
                reason: Some(reason),
            });
        }
    };
    let targets: Vec<ChromeTarget> = list.json().await.map_err(|e| e.to_string())?;
    let targets = targets.into_iter().filter(|t| t.kind == "page").collect();
    let browser = match client.get(format!("{base}/json/version")).send().await {
        Ok(r) => r.json::<Value>().await.ok().and_then(|v| {
            v.get("Browser")
                .and_then(|b| b.as_str())
                .map(|s| s.to_string())
        }),
        Err(_) => None,
    };
    Ok(ChromeStatus {
        reachable: true,
        port,
        browser,
        targets,
        error: None,
        chrome_installed: true,
        chrome_running: true,
        reason: None,
    })
}

/// A live Chrome/Chromium process (sysinfo), excluding our own binary.
fn chrome_process_running() -> bool {
    use sysinfo::System;
    let sys = System::new_all();
    sys.processes().values().any(|p| {
        let n = p.name().to_string_lossy().to_lowercase();
        (n.contains("google chrome")
            || n == "chrome"
            || n == "chrome.exe"
            || n.starts_with("chromium"))
            && !n.contains("crashpad")
            && !n.contains("helper")
    })
}

/// Chrome binary per platform (first one that exists).
fn chrome_binary() -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            PathBuf::from(
                "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
            ),
            PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        ]
    } else if cfg!(target_os = "windows") {
        let mut v = Vec::new();
        for base in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
            if let Ok(dir) = std::env::var(base) {
                v.push(PathBuf::from(&dir).join("Google/Chrome/Application/chrome.exe"));
            }
        }
        v
    } else {
        [
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
        ]
        .iter()
        .filter_map(|name| which_on_path(name))
        .collect()
    };
    candidates.into_iter().find(|p| p.exists())
}

fn which_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

/// Chrome profile dedicated to the agent (Chrome ≥136 rejects remote
/// debugging on the default profile). The provider's extension must be installed
/// ONCE in this profile.
fn agent_profile_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join(crate::APP_DIR_NAME));
    base.join("chrome-agent-profile")
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeLaunchResult {
    pub binary: String,
    pub profile_dir: String,
    pub port: u16,
}

/// browser_chrome_launch — starts Chrome with the agent profile and remote
/// debugging on the port. Idempotent from the user's side: if Chrome is already listening,
/// it only opens a new tab.
#[tauri::command]
pub async fn browser_chrome_launch(
    app: tauri::AppHandle,
    url: Option<String>,
    port: Option<u16>,
) -> Result<ChromeLaunchResult, String> {
    let port = port.unwrap_or(DEFAULT_PORT);
    let url = url.unwrap_or_else(|| "about:blank".to_string());
    // The URL is the last argv entry: one starting with `-` would be a Chrome
    // switch (`--renderer-cmd-prefix=…` runs a program).
    if url.trim_start().starts_with('-') {
        return Err("Invalid URL".to_string());
    }
    if browser_chrome_status(Some(port)).await?.reachable {
        browser_chrome_open_tab(Some(url), Some(port)).await?;
        return Ok(ChromeLaunchResult {
            binary: String::new(),
            profile_dir: agent_profile_dir(&app).to_string_lossy().into_owned(),
            port,
        });
    }
    let binary = chrome_binary().ok_or_else(|| {
        "Google Chrome not found — install Chrome or launch it manually with --remote-debugging-port".to_string()
    })?;
    let profile = agent_profile_dir(&app);
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(&binary);
    cmd.arg(format!("--remote-debugging-port={port}"))
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        // No --remote-allow-origins: the mirror connects from Rust without an
        // Origin header, so web pages stay unable to open the DevTools socket.
        // The Chrome window sits behind PromptOps: without these flags Chrome
        // stops painting occluded/background windows and the
        // screencast freezes on the last frame ("blurry" and frozen mirror).
        .arg("--disable-backgrounding-occluded-windows")
        .arg("--disable-renderer-backgrounding")
        .arg("--disable-background-timer-throttling")
        // End of switches: whatever follows is a URL, never an option.
        .arg("--")
        .arg(&url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd.spawn()
        .map_err(|e| format!("Cannot launch Chrome: {e}"))?;
    // Waits for the DevTools endpoint to respond (max ~8s).
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if browser_chrome_status(Some(port)).await?.reachable {
            break;
        }
    }
    Ok(ChromeLaunchResult {
        binary: binary.to_string_lossy().into_owned(),
        profile_dir: profile.to_string_lossy().into_owned(),
        port,
    })
}

/// browser_chrome_open_tab — `PUT /json/new?url` (Chrome ≥ 100 requires PUT).
#[tauri::command]
pub async fn browser_chrome_open_tab(
    url: Option<String>,
    port: Option<u16>,
) -> Result<ChromeTarget, String> {
    let port = port.unwrap_or(DEFAULT_PORT);
    let url = url.unwrap_or_else(|| "about:blank".to_string());
    let client = reqwest::Client::new();
    let target: ChromeTarget = client
        .put(format!("{}/json/new?{}", devtools_base(port), url))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(target)
}

/// browser_chrome_close_tab — `GET /json/close/<id>`.
#[tauri::command]
pub async fn browser_chrome_close_tab(target_id: String, port: Option<u16>) -> Result<(), String> {
    let port = port.unwrap_or(DEFAULT_PORT);
    reqwest::get(format!("{}/json/close/{target_id}", devtools_base(port)))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// browser_chrome_activate_tab — brings the tab to the front in the real Chrome.
#[tauri::command]
pub async fn browser_chrome_activate_tab(
    target_id: String,
    port: Option<u16>,
) -> Result<(), String> {
    let port = port.unwrap_or(DEFAULT_PORT);
    reqwest::get(format!("{}/json/activate/{target_id}", devtools_base(port)))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────
// Mirror (screencast CDP)
// ─────────────────────────────────────────────────────────────────────────

static NEXT_CMD_ID: AtomicU64 = AtomicU64::new(1);

fn cdp_msg(id: u64, method: &str, params: Value) -> String {
    json!({ "id": id, "method": method, "params": params }).to_string()
}

/// browser_mirror_start — opens the tab's WS and starts the screencast.
/// Returns the mirror id for `browser_mirror_send` / `browser_mirror_stop`.
#[tauri::command]
pub async fn browser_mirror_start(
    manager: tauri::State<'_, Arc<BrowserMirrorManager>>,
    ws_url: String,
    max_width: Option<u32>,
    max_height: Option<u32>,
    quality: Option<u32>,
    on_event: Channel<MirrorEvent>,
) -> Result<String, String> {
    // Only the local DevTools endpoint: the webview must not be able to point
    // the backend at an arbitrary socket.
    let parsed = reqwest::Url::parse(&ws_url).map_err(|_| "Invalid DevTools URL".to_string())?;
    let local = matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if parsed.scheme() != "ws" || !local || !parsed.path().starts_with("/devtools/") {
        return Err("Only the local Chrome DevTools socket can be mirrored".to_string());
    }
    let id = Uuid::new_v4().to_string();
    let (ws, _) = tokio_tungstenite::connect_async(ws_url.as_str())
        .await
        .map_err(|e| format!("CDP connect failed: {e}"))?;
    let (mut write, mut read) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // Setup: Page.enable + screencast.
    let setup = [
        cdp_msg(
            NEXT_CMD_ID.fetch_add(1, Ordering::Relaxed),
            "Page.enable",
            json!({}),
        ),
        cdp_msg(
            NEXT_CMD_ID.fetch_add(1, Ordering::Relaxed),
            "Page.startScreencast",
            json!({
                "format": "jpeg",
                "quality": quality.unwrap_or(65),
                "maxWidth": max_width.unwrap_or(1600),
                "maxHeight": max_height.unwrap_or(1200),
                "everyNthFrame": 1
            }),
        ),
    ];
    for m in setup {
        write
            .send(Message::Text(m.into()))
            .await
            .map_err(|e| e.to_string())?;
    }

    let task = tokio::spawn(async move {
        let reason = loop {
            tokio::select! {
                out = rx.recv() => match out {
                    Some(text) => {
                        if write.send(Message::Text(text.into())).await.is_err() {
                            break "send failed".to_string();
                        }
                    }
                    None => break "stopped".to_string(),
                },
                incoming = read.next() => {
                    let msg = match incoming {
                        Some(Ok(Message::Text(t))) => t,
                        Some(Ok(Message::Close(_))) | None => break "socket closed".to_string(),
                        Some(Ok(_)) => continue,
                        Some(Err(e)) => break e.to_string(),
                    };
                    let v: Value = match serde_json::from_str(&msg) { Ok(v) => v, Err(_) => continue };
                    match v.get("method").and_then(|m| m.as_str()) {
                        Some("Page.screencastFrame") => {
                            let p = &v["params"];
                            let session_id = p["sessionId"].as_i64().unwrap_or(0);
                            let meta = &p["metadata"];
                            let ev = MirrorEvent::Frame {
                                data: p["data"].as_str().unwrap_or("").to_string(),
                                device_width: meta["deviceWidth"].as_f64().unwrap_or(0.0),
                                device_height: meta["deviceHeight"].as_f64().unwrap_or(0.0),
                                page_scale: meta["pageScaleFactor"].as_f64().unwrap_or(1.0),
                                scroll_x: meta["scrollOffsetX"].as_f64().unwrap_or(0.0),
                                scroll_y: meta["scrollOffsetY"].as_f64().unwrap_or(0.0),
                            };
                            if on_event.send(ev).is_err() { break "channel closed".to_string(); }
                            let ack = cdp_msg(
                                NEXT_CMD_ID.fetch_add(1, Ordering::Relaxed),
                                "Page.screencastFrameAck",
                                json!({ "sessionId": session_id }),
                            );
                            if write.send(Message::Text(ack.into())).await.is_err() { break "ack failed".to_string(); }
                        }
                        Some("Page.frameNavigated") => {
                            let f = &v["params"]["frame"];
                            if f.get("parentId").is_none() {
                                if let Some(url) = f["url"].as_str() {
                                    let _ = on_event.send(MirrorEvent::Nav { url: url.to_string() });
                                }
                            }
                        }
                        Some("Page.navigatedWithinDocument") => {
                            if let Some(url) = v["params"]["url"].as_str() {
                                let _ = on_event.send(MirrorEvent::Nav { url: url.to_string() });
                            }
                        }
                        Some(_) => {}
                        None => {
                            // Reply to a command: forwarded to the renderer (id ≥ 1000 = user).
                            if let Some(id) = v.get("id").and_then(|i| i.as_u64()) {
                                if id >= 1000 {
                                    let result = v.get("result").cloned()
                                        .or_else(|| v.get("error").cloned())
                                        .unwrap_or(Value::Null);
                                    let _ = on_event.send(MirrorEvent::Result { id, result });
                                }
                            }
                        }
                    }
                }
            }
        };
        let _ = on_event.send(MirrorEvent::Closed { reason });
    });

    manager
        .mirrors
        .lock()
        .insert(id.clone(), Mirror { tx, task });
    Ok(id)
}

/// browser_mirror_send — passthrough CDP (Input.dispatchMouseEvent,
/// Input.dispatchKeyEvent, Page.navigate, Page.reload, Runtime.evaluate…).
/// Returns the command id: the reply arrives as `MirrorEvent::Result`.
#[tauri::command]
pub fn browser_mirror_send(
    manager: tauri::State<'_, Arc<BrowserMirrorManager>>,
    id: String,
    method: String,
    params: Option<Value>,
) -> Result<u64, String> {
    let mirrors = manager.mirrors.lock();
    let m = mirrors
        .get(&id)
        .ok_or_else(|| "mirror not found".to_string())?;
    // User ids ≥ 1000 so they don't collide with internal commands (setup/ack).
    let cmd_id = 1000 + NEXT_CMD_ID.fetch_add(1, Ordering::Relaxed);
    m.tx.send(cdp_msg(
        cmd_id,
        &method,
        params.unwrap_or_else(|| json!({})),
    ))
    .map_err(|_| "mirror closed".to_string())?;
    Ok(cmd_id)
}

/// browser_mirror_stop — closes the screencast and the socket.
#[tauri::command]
pub fn browser_mirror_stop(
    manager: tauri::State<'_, Arc<BrowserMirrorManager>>,
    id: String,
) -> Result<(), String> {
    if let Some(m) = manager.mirrors.lock().remove(&id) {
        let _ = m.tx.send(cdp_msg(
            NEXT_CMD_ID.fetch_add(1, Ordering::Relaxed),
            "Page.stopScreencast",
            json!({}),
        ));
        drop(m.tx);
        // The task exits on its own when rx closes; abort = safety net.
        // SYNCHRONOUS command (main thread, no tokio runtime in scope):
        // `tokio::spawn` here panics → app abort. We go through
        // Tauri's runtime, valid from any thread.
        let task = m.task;
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            task.abort();
        });
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────
// Provider integration: CLI + extension in the agent profile + MCP
// ─────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInfo {
    pub id: String,
    pub name: String,
    pub version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationProbe {
    pub provider: String,
    pub cli_installed: bool,
    pub cli_command: String,
    /// Provider extension found in the agent's Chrome profile.
    pub extension: Option<ExtensionInfo>,
    /// All extensions of the agent profile (for the guide).
    pub extensions: Vec<ExtensionInfo>,
    /// A browser MCP (chrome-devtools / playwright) is configured for the CLI.
    pub mcp_configured: bool,
    pub mcp_config_path: String,
    /// Bundled MCP config (Chrome DevTools MCP → agent Chrome) written for
    /// mirror mode; empty if not writable.
    pub bundled_mcp_path: String,
    pub profile_dir: String,
    /// Profiles of the user's NORMAL Chrome where the extension is already
    /// installed (explains "it works from the terminal") — importable into the agent profile.
    pub extension_elsewhere: Vec<ChromeProfileHit>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeProfileHit {
    /// Folder name (`Default`, `Profile 9`…).
    pub dir: String,
    /// Visible profile name (Local State info_cache).
    pub name: String,
    pub last_used: bool,
    pub extension: ExtensionInfo,
}

/// User data dir of the normal Chrome (per platform).
fn chrome_user_data_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        home_dir().join("Library/Application Support/Google/Chrome")
    } else if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData/Local"))
            .join("Google/Chrome/User Data")
    } else {
        home_dir().join(".config/google-chrome")
    }
}

/// Profiles of the normal Chrome that have an extension matching one of the keywords.
fn extension_in_user_profiles(keywords: &[&str]) -> Vec<ChromeProfileHit> {
    let root = chrome_user_data_dir();
    let local_state: Value = std::fs::read_to_string(root.join("Local State"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let last_used = local_state["profile"]["last_used"]
        .as_str()
        .unwrap_or("Default")
        .to_string();
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return out;
    };
    for e in entries.flatten() {
        let dir = e.file_name().to_string_lossy().into_owned();
        if !(dir == "Default" || dir.starts_with("Profile ")) || !e.path().is_dir() {
            continue;
        }
        let hit = profile_extensions(&e.path()).into_iter().find(|x| {
            let n = x.name.to_lowercase();
            keywords.iter().any(|k| n.contains(k))
        });
        if let Some(extension) = hit {
            let name = local_state["profile"]["info_cache"][&dir]["name"]
                .as_str()
                .unwrap_or(&dir)
                .to_string();
            out.push(ChromeProfileHit {
                last_used: dir == last_used,
                dir,
                name,
                extension,
            });
        }
    }
    // The active profile first: it is the one the user wants to import.
    out.sort_by_key(|h| !h.last_used);
    out
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// "Human" name of a manifest (resolves `__MSG_key__` from _locales).
fn manifest_name(ext_dir: &std::path::Path, manifest: &Value) -> String {
    let raw = manifest["name"].as_str().unwrap_or("").to_string();
    let Some(key) = raw
        .strip_prefix("__MSG_")
        .and_then(|k| k.strip_suffix("__"))
    else {
        return raw;
    };
    let default_locale = manifest["default_locale"]
        .as_str()
        .unwrap_or("en")
        .to_string();
    for loc in [default_locale.as_str(), "en", "en_US"] {
        let p = ext_dir.join("_locales").join(loc).join("messages.json");
        if let Ok(txt) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                // Chrome compares message keys case-insensitively.
                let found = v.as_object().and_then(|o| {
                    o.iter()
                        .find(|(k, _)| k.eq_ignore_ascii_case(key))
                        .and_then(|(_, m)| m["message"].as_str().map(|s| s.to_string()))
                });
                if let Some(m) = found {
                    return m;
                }
            }
        }
    }
    raw
}

/// Extensions installed in a Chrome profile (`<profile>/Extensions/<id>/<ver>/manifest.json`).
/// `profile` is the profile folder (`…/Default`, `…/Profile 9`), NOT the user data dir.
fn profile_extensions(profile: &std::path::Path) -> Vec<ExtensionInfo> {
    let mut out = Vec::new();
    let root = profile.join("Extensions");
    let Ok(ids) = std::fs::read_dir(&root) else {
        return out;
    };
    for id_entry in ids.flatten() {
        let id = id_entry.file_name().to_string_lossy().into_owned();
        let Ok(vers) = std::fs::read_dir(id_entry.path()) else {
            continue;
        };
        // Latest version (lexicographic order is enough for the badge).
        let mut best: Option<ExtensionInfo> = None;
        for v in vers.flatten() {
            let mp = v.path().join("manifest.json");
            let Ok(txt) = std::fs::read_to_string(&mp) else {
                continue;
            };
            let Ok(m) = serde_json::from_str::<Value>(&txt) else {
                continue;
            };
            let info = ExtensionInfo {
                id: id.clone(),
                name: manifest_name(&v.path(), &m),
                version: m["version"].as_str().unwrap_or("").to_string(),
            };
            if best
                .as_ref()
                .map(|b| info.version > b.version)
                .unwrap_or(true)
            {
                best = Some(info);
            }
        }
        if let Some(b) = best {
            out.push(b);
        }
    }
    out
}

/// browser_integration_probe — for the chosen provider: CLI on PATH (same
/// probe as sessions), extension in the agent profile, browser MCP
/// configured (`~/.claude.json` / `~/.codex/config.toml`).
#[tauri::command]
pub async fn browser_integration_probe(
    app: tauri::AppHandle,
    provider: String,
) -> Result<IntegrationProbe, String> {
    let check =
        crate::commands::session::provider_check(app.clone(), provider.clone(), None, None).await;
    let profile = agent_profile_dir(&app);
    let extensions = profile_extensions(&profile.join("Default"));
    let keywords: &[&str] = match provider.as_str() {
        "claude-code-cli" => &["claude"],
        "codex" => &["codex", "chatgpt", "openai"],
        _ => &[],
    };
    let extension = extensions
        .iter()
        .find(|e| {
            let n = e.name.to_lowercase();
            keywords.iter().any(|k| n.contains(k))
        })
        .cloned();
    let (mcp_path, mcp_configured) = match provider.as_str() {
        "claude-code-cli" => {
            let p = home_dir().join(".claude.json");
            let txt = std::fs::read_to_string(&p).unwrap_or_default();
            (
                p,
                txt.contains("chrome-devtools")
                    || txt.contains("playwright")
                    || txt.contains("browser-mcp"),
            )
        }
        "codex" => {
            let p = home_dir().join(".codex").join("config.toml");
            let txt = std::fs::read_to_string(&p).unwrap_or_default();
            (
                p,
                txt.contains("chrome-devtools")
                    || txt.contains("playwright")
                    || txt.contains("browser"),
            )
        }
        _ => (PathBuf::new(), false),
    };
    let extension_elsewhere = if extension.is_none() {
        extension_in_user_profiles(keywords)
    } else {
        Vec::new()
    };
    let bundled_mcp_path = browser_agent_dir(&app)
        .map(|d| d.join(BUNDLED_MCP_FILE).to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(IntegrationProbe {
        provider,
        cli_installed: check.installed,
        cli_command: check.command,
        extension,
        extensions,
        mcp_configured,
        mcp_config_path: mcp_path.to_string_lossy().into_owned(),
        bundled_mcp_path,
        profile_dir: profile.to_string_lossy().into_owned(),
        extension_elsewhere,
    })
}

// ─────────────────────────────────────────────────────────────────────────
// Import of the extension from the user's Chrome profile into the agent profile
// ─────────────────────────────────────────────────────────────────────────
//
// Copies ONLY what Chrome needs to consider the extension installed:
// the extension folder, its storage (`Local Extension Settings`),
// `Extension State`, the `extensions` section of `Preferences` (Web Store
// install signature) and `Secure Preferences` (install record
// with the MACs, valid on the same machine). No cookies, passwords, history,
// autofill data: the user logs into the agent Chrome as in a
// fresh browser, and the login stays in the agent profile.

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let name = entry.file_name();
        if ft.is_symlink() || name == "LOCK" {
            continue;
        }
        if ft.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(&name))?;
        } else {
            // A DB being written may refuse reads: Chrome regenerates it.
            let _ = std::fs::copy(entry.path(), dst.join(&name));
        }
    }
    Ok(())
}

/// Terminates the agent profile's Chrome (browser process launched by us).
fn kill_agent_chrome(profile: &std::path::Path) -> bool {
    use sysinfo::System;
    let marker = format!("--user-data-dir={}", profile.display());
    let sys = System::new_all();
    let mut killed = false;
    for p in sys.processes().values() {
        let cmd = p.cmd();
        let is_browser = cmd.iter().any(|a| a.to_string_lossy() == marker)
            && !cmd
                .iter()
                .any(|a| a.to_string_lossy().starts_with("--type="));
        if is_browser {
            killed |= p.kill();
        }
    }
    killed
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionImportResult {
    pub source_dir: String,
    pub extension_id: String,
    pub relaunched: bool,
}

/// browser_profile_import_extension — imports the `extension_id` extension from the
/// `source_dir` profile of the normal Chrome into the agent profile and relaunches the
/// agent Chrome. The normal Chrome can stay open.
#[tauri::command]
pub async fn browser_profile_import_extension(
    app: tauri::AppHandle,
    source_dir: String,
    extension_id: String,
    port: Option<u16>,
) -> Result<ExtensionImportResult, String> {
    let port = port.unwrap_or(DEFAULT_PORT);
    let safe = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ');
    if !safe(&source_dir) || !safe(&extension_id) {
        return Err("invalid profile or extension id".into());
    }
    let src = chrome_user_data_dir().join(&source_dir);
    if !src.join("Extensions").join(&extension_id).is_dir() {
        return Err(format!(
            "extension {extension_id} not found in Chrome profile '{source_dir}'"
        ));
    }
    let agent = agent_profile_dir(&app);

    // 1) Agent Chrome down: Chrome would rewrite the Preferences on exit.
    if browser_chrome_status(Some(port)).await?.reachable {
        kill_agent_chrome(&agent);
        for _ in 0..25 {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            if !browser_chrome_status(Some(port)).await?.reachable {
                break;
            }
        }
    }

    // 2) Targeted copy (blocking: LevelDB + extension folder).
    let agent_c = agent.clone();
    let ext_id = extension_id.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let dst = agent_c.join("Default");
        std::fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
        copy_dir_all(
            &src.join("Extensions").join(&ext_id),
            &dst.join("Extensions").join(&ext_id),
        )
        .map_err(|e| format!("extension files: {e}"))?;
        let les = src.join("Local Extension Settings").join(&ext_id);
        if les.is_dir() {
            let _ = copy_dir_all(&les, &dst.join("Local Extension Settings").join(&ext_id));
        }
        if src.join("Extension State").is_dir() {
            let _ = copy_dir_all(&src.join("Extension State"), &dst.join("Extension State"));
        }
        // Preferences: only the `extensions` section (Web Store signature included).
        let src_prefs: Value = std::fs::read_to_string(src.join("Preferences"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| json!({}));
        let mut dst_prefs: Value = std::fs::read_to_string(dst.join("Preferences"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| json!({}));
        if let (Some(ext), Some(obj)) = (src_prefs.get("extensions"), dst_prefs.as_object_mut()) {
            obj.insert("extensions".into(), ext.clone());
        }
        std::fs::write(dst.join("Preferences"), dst_prefs.to_string())
            .map_err(|e| e.to_string())?;
        // Secure Preferences: install record + MAC (same machine).
        std::fs::copy(
            src.join("Secure Preferences"),
            dst.join("Secure Preferences"),
        )
        .map_err(|e| format!("Secure Preferences: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    // 3) Relaunch the agent Chrome on the home page.
    let relaunched = browser_chrome_launch(app, Some("https://www.google.com".into()), Some(port))
        .await
        .is_ok();
    Ok(ExtensionImportResult {
        source_dir,
        extension_id,
        relaunched,
    })
}

// ─────────────────────────────────────────────────────────────────────────
// Browser terminal working folder, already "trusted" for the CLIs
// ─────────────────────────────────────────────────────────────────────────

/// "Bundled" MCP config for mirror mode (`<app_data>/browser-agent/`):
/// the CLI starts with the Chrome DevTools MCP attached to the AGENT Chrome
/// (CDP port), so it surely acts in the mirrored tab — even if
/// the "Claude in Chrome" extension (also) lives in the normal Chrome, where the
/// `--chrome` CLI would end up attaching.
pub const BUNDLED_MCP_FILE: &str = "chrome-devtools.mcp.json";

/// Working folder of the Browser page, with the bundled MCP config always
/// up to date (rewritten only if it changes).
fn browser_agent_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("browser-agent");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cfg = json!({
        "mcpServers": {
            "chrome-devtools": {
                "command": "npx",
                "args": ["-y", "chrome-devtools-mcp@1.10.1", "--browserUrl", format!("http://127.0.0.1:{DEFAULT_PORT}")]
            }
        }
    });
    let txt = serde_json::to_string_pretty(&cfg).unwrap_or_default();
    let file = dir.join(BUNDLED_MCP_FILE);
    if std::fs::read_to_string(&file).ok().as_deref() != Some(txt.as_str()) {
        std::fs::write(&file, txt).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

/// browser_terminal_cwd — dedicated folder (`<app_data>/browser-agent`),
/// marked as trusted for Claude Code (`~/.claude.json`) and Codex
/// (`~/.codex/config.toml`): the CLI starts without the "Do you trust…" dialog
/// (default "No, exit"), so the user can type the request right away.
#[tauri::command]
pub fn browser_terminal_cwd(app: tauri::AppHandle, provider: String) -> Result<String, String> {
    let dir = browser_agent_dir(&app)?;
    let path = dir.to_string_lossy().into_owned();
    match provider.as_str() {
        "claude-code-cli" => trust_claude_project(&path),
        "codex" => trust_codex_project(&path),
        _ => {}
    }
    Ok(path)
}

/// `projects["<path>"].hasTrustDialogAccepted = true` in ~/.claude.json
/// (same effect as answering "Yes" to the dialog).
pub(crate) fn trust_claude_project(path: &str) {
    let trust = TrustFiles::user();
    if !trust.trust_claude(path) {
        eprintln!("[browser] ~/.claude.json left as it is: Claude will ask to trust {path}");
    }
}

/// `[projects."<path>"] trust_level = "trusted"` in ~/.codex/config.toml.
fn trust_codex_project(path: &str) {
    TrustFiles::user().trust_codex(path);
}

/// System cleanup: takes out the trust entries PromptOps added. Returns the
/// files that changed.
pub(crate) fn untrust_projects() -> Vec<PathBuf> {
    TrustFiles::user().untrust_all()
}

/// Folders PromptOps marked as trusted, so System cleanup can undo exactly
/// those entries and nothing the user set.
#[derive(Default, Serialize, Deserialize)]
struct TrustLedger {
    #[serde(default)]
    claude: Vec<ClaudeTrust>,
    #[serde(default)]
    codex: Vec<String>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct ClaudeTrust {
    path: String,
    /// The project entry did not exist before (removed again on cleanup);
    /// otherwise only `hasTrustDialogAccepted` is set back to false.
    created: bool,
}

/// The files the trust entries live in (the user's, or a test folder).
struct TrustFiles {
    claude_json: PathBuf,
    codex_toml: PathBuf,
    ledger: PathBuf,
    backups: PathBuf,
}

impl TrustFiles {
    fn user() -> Self {
        let home = home_dir();
        Self {
            claude_json: home.join(".claude.json"),
            codex_toml: home.join(".codex").join("config.toml"),
            ledger: crate::commands::hook::hook_data_dir().join("trusted-projects.json"),
            backups: crate::commands::hook::config_backups_dir(),
        }
    }

    fn ledger(&self) -> TrustLedger {
        std::fs::read(&self.ledger)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn save_ledger(&self, ledger: &TrustLedger) {
        if let Some(dir) = self.ledger.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(body) = serde_json::to_vec_pretty(ledger) {
            let _ = crate::commands::hook::write_atomic(&self.ledger, body);
        }
    }

    /// Edits ~/.claude.json in place: the one project entry changes, every
    /// other key keeps its value and its position (serde_json
    /// `preserve_order`). A file that is not a JSON object is the user's
    /// problem to fix, never ours to replace: it is left alone (`false`).
    /// The running `claude` rewrites this file often: when it changed between
    /// our read and our write, the edit starts over from the new content.
    fn trust_claude(&self, path: &str) -> bool {
        for _ in 0..3 {
            let before = match std::fs::read(&self.claude_json) {
                Ok(bytes) => Some(bytes),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(_) => return false,
            };
            let mut root: Value = match &before {
                None => json!({}),
                Some(bytes) => match serde_json::from_slice::<Value>(bytes) {
                    Ok(v) if v.is_object() => v,
                    _ => return false,
                },
            };
            let Some(root_obj) = root.as_object_mut() else {
                return false;
            };
            let projects = root_obj.entry("projects").or_insert_with(|| json!({}));
            let Some(projects) = projects.as_object_mut() else {
                return false;
            };
            let created = !projects.contains_key(path);
            let entry = projects
                .entry(path.to_string())
                .or_insert_with(|| json!({}));
            let Some(o) = entry.as_object_mut() else {
                return false;
            };
            if o.get("hasTrustDialogAccepted").and_then(|v| v.as_bool()) == Some(true) {
                return true;
            }
            o.insert("hasTrustDialogAccepted".into(), Value::Bool(true));
            o.entry("allowedTools").or_insert_with(|| json!([]));
            let Ok(body) = serde_json::to_string_pretty(&root) else {
                return false;
            };
            // Recorded before the write: a crash in between leaves a record of
            // an entry that may not exist, which cleanup tolerates.
            let mut ledger = self.ledger();
            let record = ClaudeTrust {
                path: path.to_string(),
                created,
            };
            if !ledger.claude.iter().any(|t| t.path == path) {
                ledger.claude.push(record);
                self.save_ledger(&ledger);
            }
            if before.is_some()
                && crate::commands::hook::backup_before_change(&self.backups, &self.claude_json)
                    .is_err()
            {
                return false;
            }
            if std::fs::read(&self.claude_json).ok() != before {
                continue;
            }
            return crate::commands::hook::write_atomic(&self.claude_json, body).is_ok();
        }
        false
    }

    fn trust_codex(&self, path: &str) {
        let txt = match std::fs::read_to_string(&self.codex_toml) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(_) => return,
        };
        let header = codex_trust_header(path);
        if txt.contains(&header) {
            return;
        }
        if let Some(parent) = self.codex_toml.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut ledger = self.ledger();
        if !ledger.codex.iter().any(|p| p == path) {
            ledger.codex.push(path.to_string());
            self.save_ledger(&ledger);
        }
        let mut out = txt;
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&format!(
            "{}{header}\n{CODEX_TRUST_LINE}\n",
            CODEX_TRUST_SEPARATOR
        ));
        let _ = crate::commands::hook::write_atomic(&self.codex_toml, out);
    }

    fn untrust_all(&self) -> Vec<PathBuf> {
        let ledger = self.ledger();
        let mut changed = Vec::new();
        if !ledger.claude.is_empty() && self.untrust_claude(&ledger.claude) {
            changed.push(self.claude_json.clone());
        }
        if !ledger.codex.is_empty() && self.untrust_codex(&ledger.codex) {
            changed.push(self.codex_toml.clone());
        }
        let _ = std::fs::remove_file(&self.ledger);
        let _ = std::fs::remove_file(crate::commands::hook::backup_path(
            &self.backups,
            &self.claude_json,
        ));
        changed
    }

    fn untrust_claude(&self, entries: &[ClaudeTrust]) -> bool {
        for _ in 0..3 {
            let Ok(before) = std::fs::read(&self.claude_json) else {
                return false;
            };
            let Ok(mut root) = serde_json::from_slice::<Value>(&before) else {
                return false;
            };
            let Some(projects) = root.get_mut("projects").and_then(|p| p.as_object_mut()) else {
                return false;
            };
            let mut touched = false;
            for t in entries {
                if t.created {
                    touched |= projects.shift_remove(&t.path).is_some();
                } else if let Some(o) = projects.get_mut(&t.path).and_then(|e| e.as_object_mut()) {
                    o.insert("hasTrustDialogAccepted".into(), Value::Bool(false));
                    touched = true;
                }
            }
            if !touched {
                return false;
            }
            let Ok(body) = serde_json::to_string_pretty(&root) else {
                return false;
            };
            if std::fs::read(&self.claude_json).ok().as_deref() != Some(before.as_slice()) {
                continue;
            }
            return crate::commands::hook::write_atomic(&self.claude_json, body).is_ok();
        }
        false
    }

    /// Removes exactly the block `trust_codex` appended for each path.
    fn untrust_codex(&self, paths: &[String]) -> bool {
        let Ok(mut txt) = std::fs::read_to_string(&self.codex_toml) else {
            return false;
        };
        let original = txt.clone();
        for path in paths {
            let block = format!("{}\n{CODEX_TRUST_LINE}\n", codex_trust_header(path));
            if let Some(at) = txt.find(&block) {
                let mut start = at;
                if txt[..start].ends_with(CODEX_TRUST_SEPARATOR) {
                    start -= CODEX_TRUST_SEPARATOR.len();
                }
                txt.replace_range(start..at + block.len(), "");
            }
        }
        txt != original && crate::commands::hook::write_atomic(&self.codex_toml, txt).is_ok()
    }
}

const CODEX_TRUST_SEPARATOR: &str = "\n";
const CODEX_TRUST_LINE: &str = "trust_level = \"trusted\"";

/// TOML "basic" string key: backslashes and quotes escaped.
fn codex_trust_header(path: &str) -> String {
    let key = path.replace('\\', "\\\\").replace('"', "\\\"");
    format!("[projects.\"{key}\"]")
}

// ─────────────────────────────────────────────────────────────────────────
// Mirror of the normal Chrome WINDOW ("My Chrome" mode, macOS)
// ─────────────────────────────────────────────────────────────────────────
//
// Chrome ≥136 rejects remote debugging on the default profile, so the
// user's Chrome (where the extension lives and where the agent really acts)
// cannot be mirrored via CDP. We capture its window with `screencapture
// -l <CGWindowID>` at a few fps: it works even if the window is covered by
// PromptOps. Requires the Screen Recording permission (system prompt).

/// PID of the agent profile's Chrome browser (to exclude: here we want the
/// user's NORMAL Chrome).
fn agent_chrome_pids(profile: &std::path::Path) -> Vec<u32> {
    use sysinfo::System;
    let marker = format!("--user-data-dir={}", profile.display());
    let sys = System::new_all();
    sys.processes()
        .iter()
        .filter(|(_, p)| p.cmd().iter().any(|a| a.to_string_lossy() == marker))
        .map(|(pid, _)| pid.as_u32())
        .collect()
}

/// Visible Chrome windows, frontmost first: (CGWindowID, pid, title).
#[cfg(target_os = "macos")]
fn chrome_windows() -> Vec<(u32, u32, String)> {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionOnScreenOnly,
    };
    let mut out = Vec::new();
    let Some(list) = copy_window_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID,
    ) else {
        return out;
    };
    for i in 0..list.len() {
        let Some(item) = list.get(i) else { continue };
        let dict: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(*item as CFDictionaryRef) };
        let get_str = |k: &str| {
            dict.find(CFString::new(k))
                .and_then(|v| v.downcast::<CFString>())
                .map(|s| s.to_string())
        };
        let get_i64 = |k: &str| {
            dict.find(CFString::new(k))
                .and_then(|v| v.downcast::<CFNumber>())
                .and_then(|n| n.to_i64())
        };
        if get_str("kCGWindowOwnerName").as_deref() != Some("Google Chrome") {
            continue;
        }
        if get_i64("kCGWindowLayer").unwrap_or(0) != 0 {
            continue;
        }
        let id = get_i64("kCGWindowNumber").unwrap_or(0) as u32;
        let pid = get_i64("kCGWindowOwnerPID").unwrap_or(0) as u32;
        // Popups/tooltips have tiny windows: keep them out.
        let bounds = dict
            .find(CFString::new("kCGWindowBounds"))
            .and_then(|v| v.downcast::<CFDictionary>());
        if let Some(b) = bounds {
            let b: CFDictionary<CFString, CFType> =
                unsafe { CFDictionary::wrap_under_get_rule(b.as_concrete_TypeRef()) };
            let w = b
                .find(CFString::new("Width"))
                .and_then(|v| v.downcast::<CFNumber>())
                .and_then(|n| n.to_f64())
                .unwrap_or(0.0);
            let h = b
                .find(CFString::new("Height"))
                .and_then(|v| v.downcast::<CFNumber>())
                .and_then(|n| n.to_f64())
                .unwrap_or(0.0);
            if w < 300.0 || h < 200.0 {
                continue;
            }
        }
        out.push((id, pid, get_str("kCGWindowName").unwrap_or_default()));
    }
    out
}

#[cfg(not(target_os = "macos"))]
fn chrome_windows() -> Vec<(u32, u32, String)> {
    Vec::new()
}

/// Screen Recording permission: `true` if already granted; otherwise asks
/// (system prompt, once) and opens the Privacy pane.
#[cfg(target_os = "macos")]
fn ensure_screen_capture_access() -> bool {
    use core_graphics::access::ScreenCaptureAccess;
    let access = ScreenCaptureAccess;
    if access.preflight() {
        return true;
    }
    let granted = access.request();
    if !granted {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn();
    }
    granted
}

#[cfg(not(target_os = "macos"))]
fn ensure_screen_capture_access() -> bool {
    false
}

/// browser_window_mirror_start — periodic capture of the frontmost normal Chrome
/// window; JPEG frames on the Channel (`MirrorEvent::Frame`).
#[tauri::command]
pub async fn browser_window_mirror_start(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<BrowserMirrorManager>>,
    fps: Option<u32>,
    on_event: Channel<MirrorEvent>,
) -> Result<String, String> {
    if !cfg!(target_os = "macos") {
        return Err("Live view of your Chrome window is macOS-only for now".into());
    }
    let id = format!("win-{}", Uuid::new_v4());
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    manager
        .window_mirrors
        .lock()
        .insert(id.clone(), stop.clone());
    let agent_profile = agent_profile_dir(&app);
    let interval = std::time::Duration::from_millis((1000 / fps.unwrap_or(3).clamp(1, 8)) as u64);
    let tmp = std::env::temp_dir().join(format!("promptops-chrome-{id}.jpg"));

    tauri::async_runtime::spawn(async move {
        use base64::Engine;
        use std::sync::atomic::Ordering;
        if !ensure_screen_capture_access() {
            let _ = on_event.send(MirrorEvent::Status {
                message: "PromptOps needs Screen Recording permission to show your Chrome window: allow it in System Settings → Privacy & Security → Screen Recording, then restart the app.".into(),
                permission: true,
            });
        }
        let mut agent_pids = agent_chrome_pids(&agent_profile);
        let mut ticks: u32 = 0;
        let mut last_missing = false;
        while !stop.load(Ordering::Relaxed) {
            ticks += 1;
            if ticks.is_multiple_of(20) {
                agent_pids = agent_chrome_pids(&agent_profile);
            }
            let win = chrome_windows()
                .into_iter()
                .find(|(_, pid, _)| !agent_pids.contains(pid));
            let Some((win_id, _, _)) = win else {
                if !last_missing {
                    let _ = on_event.send(MirrorEvent::Status {
                        message: "No Chrome window on screen — open (or un-minimize) your Chrome."
                            .into(),
                        permission: false,
                    });
                    last_missing = true;
                }
                tokio::time::sleep(interval).await;
                continue;
            };
            last_missing = false;
            let ok = tokio::process::Command::new("/usr/sbin/screencapture")
                .arg("-x")
                .arg("-o")
                .arg(format!("-l{win_id}"))
                .arg("-t")
                .arg("jpg")
                .arg(&tmp)
                .status()
                .await
                .map(|s| s.success())
                .unwrap_or(false);
            if ok {
                if let Ok(bytes) = tokio::fs::read(&tmp).await {
                    let (w, h) = image::load_from_memory(&bytes)
                        .map(|img| (img.width() as f64, img.height() as f64))
                        .unwrap_or((0.0, 0.0));
                    let ev = MirrorEvent::Frame {
                        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
                        device_width: w,
                        device_height: h,
                        page_scale: 1.0,
                        scroll_x: 0.0,
                        scroll_y: 0.0,
                    };
                    if on_event.send(ev).is_err() {
                        break;
                    }
                }
            }
            tokio::time::sleep(interval).await;
        }
        let _ = tokio::fs::remove_file(&tmp).await;
        let _ = on_event.send(MirrorEvent::Closed {
            reason: "stopped".into(),
        });
    });
    Ok(id)
}

/// browser_window_mirror_stop — stops the capture loop.
#[tauri::command]
pub fn browser_window_mirror_stop(
    manager: tauri::State<'_, Arc<BrowserMirrorManager>>,
    id: String,
) -> Result<(), String> {
    if let Some(flag) = manager.window_mirrors.lock().remove(&id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

/// browser_chrome_focus — brings the normal Chrome to the front (to
/// interact by hand: the live view is view-only).
#[tauri::command]
pub fn browser_chrome_focus() -> Result<(), String> {
    if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .args(["-a", "Google Chrome"])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod trust_tests {
    use super::*;

    fn files(dir: &std::path::Path) -> TrustFiles {
        TrustFiles {
            claude_json: dir.join(".claude.json"),
            codex_toml: dir.join(".codex").join("config.toml"),
            ledger: dir.join("app").join("trusted-projects.json"),
            backups: dir.join("app").join("config-backups"),
        }
    }

    #[test]
    fn unparsable_claude_json_is_never_overwritten() {
        let dir = crate::commands::util_cmd::PrivateTempDir::new("po-trust").unwrap();
        let f = files(dir.path());
        for broken in ["{\"oauthAccount\": {\"x\": 1}, ", "[1,2]", "\"text\""] {
            std::fs::write(&f.claude_json, broken).unwrap();
            assert!(!f.trust_claude("/work/browser-agent"));
            assert_eq!(std::fs::read_to_string(&f.claude_json).unwrap(), broken);
        }
    }

    #[test]
    fn trust_is_a_minimal_ordered_edit_and_cleanup_undoes_it() {
        let dir = crate::commands::util_cmd::PrivateTempDir::new("po-trust").unwrap();
        let f = files(dir.path());
        // Keys deliberately out of alphabetical order, as claude writes them.
        let original = "{\n  \"numStartups\": 3,\n  \"oauthAccount\": {\n    \"zeta\": 1,\n    \"alpha\": 2\n  },\n  \"projects\": {\n    \"/mine\": {\n      \"hasTrustDialogAccepted\": true\n    },\n    \"/partly\": {\n      \"hasTrustDialogAccepted\": false,\n      \"allowedTools\": []\n    }\n  },\n  \"autoUpdates\": false\n}";
        std::fs::write(&f.claude_json, original).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&f.claude_json, std::fs::Permissions::from_mode(0o600))
                .unwrap();
        }
        assert!(f.trust_claude("/work/browser-agent"));
        assert!(f.trust_claude("/partly"));
        let after = std::fs::read_to_string(&f.claude_json).unwrap();
        let v: Value = serde_json::from_str(&after).unwrap();
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            ["numStartups", "oauthAccount", "projects", "autoUpdates"]
        );
        let inner: Vec<&String> = v["oauthAccount"].as_object().unwrap().keys().collect();
        assert_eq!(inner, ["zeta", "alpha"]);
        assert_eq!(
            v["projects"]["/work/browser-agent"]["hasTrustDialogAccepted"],
            true
        );
        assert_eq!(v["projects"]["/partly"]["hasTrustDialogAccepted"], true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&f.claude_json)
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // The original bytes are backed up once.
        let backup = crate::commands::hook::backup_path(&f.backups, &f.claude_json);
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), original);

        // Codex: one block appended, removed again by cleanup.
        std::fs::create_dir_all(f.codex_toml.parent().unwrap()).unwrap();
        std::fs::write(&f.codex_toml, "model = \"gpt-6\"\n").unwrap();
        f.trust_codex("C:\\Users\\o\"b\\agent");
        f.trust_codex("C:\\Users\\o\"b\\agent");
        let toml = std::fs::read_to_string(&f.codex_toml).unwrap();
        assert_eq!(toml.matches("trust_level").count(), 1);
        assert!(
            toml.contains("[projects.\"C:\\\\Users\\\\o\\\"b\\\\agent\"]"),
            "{toml}"
        );

        let changed = f.untrust_all();
        assert_eq!(changed.len(), 2);
        let v: Value =
            serde_json::from_str(&std::fs::read_to_string(&f.claude_json).unwrap()).unwrap();
        let projects: Vec<&String> = v["projects"].as_object().unwrap().keys().collect();
        assert_eq!(projects, ["/mine", "/partly"]);
        assert_eq!(v["projects"]["/partly"]["hasTrustDialogAccepted"], false);
        assert_eq!(v["projects"]["/mine"]["hasTrustDialogAccepted"], true);
        assert_eq!(
            std::fs::read_to_string(&f.codex_toml).unwrap(),
            "model = \"gpt-6\"\n"
        );
        assert!(!f.ledger.exists() && !backup.exists());
    }

    #[test]
    fn missing_claude_json_gets_only_the_trust_entry() {
        let dir = crate::commands::util_cmd::PrivateTempDir::new("po-trust").unwrap();
        let f = files(dir.path());
        assert!(f.trust_claude("/x"));
        let v: Value =
            serde_json::from_str(&std::fs::read_to_string(&f.claude_json).unwrap()).unwrap();
        assert_eq!(
            v,
            json!({ "projects": { "/x": { "hasTrustDialogAccepted": true, "allowedTools": [] } } })
        );
    }
}
