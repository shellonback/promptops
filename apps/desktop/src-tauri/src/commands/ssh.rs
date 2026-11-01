//! SSH domain: saved connections and interactive SSH sessions.
//!
//! Two responsibilities:
//!  1. CRUD of saved connections (`ssh:list/save/delete/test`), persisted
//!     on disk in a JSON file under the app data dir. The on-disk shape
//!     follows `SshFileShape` = `{ version: 1, connections: [...] }`.
//!  2. Interactive SSH sessions (`ssh:spawn/write/resize/close/list-active`):
//!     a real SSH client via `russh`, with a shell-style PTY channel. The output
//!     is streamed to the renderer over a `tauri::ipc::Channel`, and the
//!     `closed` / `error` events are emitted on the same typed channel.
//!
//! Notes:
//!  - connections, passwords, private keys and passphrases live in one record
//!    of the encrypted local store (`local_store.rs`, AES-256-GCM): never in a
//!    plain file, never returned to the renderer;
//!  - every network step has a deadline (handshake, authentication, channel
//!    setup), so a host that stops answering never hangs the app;
//!  - push events (`ssh:output|closed|error`) are unified into a single `Channel`
//!    with a `kind` field, as terminal.rs does for output.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::Manager;
use uuid::Uuid;

use russh::client;
use russh::ChannelMsg;
use tokio::sync::mpsc;

// =====================================================================
//  Data model — persistent store
// =====================================================================

/// Authentication type: `'password' | 'key'`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthType {
    Password,
    Key,
}

/// Full on-disk record (`SshConnectionRecord`).
/// WARNING: contains the secrets. It must NEVER be returned to the renderer (use
/// `redact()` → `SshConnectionPublic`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SshConnectionRecord {
    pub id: String,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(rename = "authType")]
    pub auth_type: AuthType,
    /// password or PEM private key, depending on `auth_type`.
    pub secret: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub passphrase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cwd: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// Input of `ssh:save` (`SshConnectionInput`).
#[derive(Clone, Debug, Deserialize)]
pub struct SshConnectionInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(rename = "sessionId", default)]
    pub session_id: Option<String>,
    pub name: String,
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    pub username: String,
    #[serde(rename = "authType")]
    pub auth_type: AuthType,
    pub secret: String,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

/// Redacted view returned to the renderer (`SshConnectionPublic`).
#[derive(Clone, Debug, Serialize)]
pub struct SshConnectionPublic {
    pub id: String,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(rename = "authType")]
    pub auth_type: AuthType,
    #[serde(rename = "hasPassphrase")]
    pub has_passphrase: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// On-disk file shape (`SshFileShape`).
#[derive(Clone, Debug, Serialize, Deserialize)]
struct SshFileShape {
    version: u32,
    connections: Vec<SshConnectionRecord>,
}

impl Default for SshFileShape {
    fn default() -> Self {
        Self {
            version: 1,
            connections: Vec::new(),
        }
    }
}

fn redact(rec: &SshConnectionRecord) -> SshConnectionPublic {
    SshConnectionPublic {
        id: rec.id.clone(),
        session_id: rec.session_id.clone(),
        name: rec.name.clone(),
        host: rec.host.clone(),
        port: rec.port,
        username: rec.username.clone(),
        auth_type: rec.auth_type,
        has_passphrase: rec.passphrase.is_some(),
        cwd: rec.cwd.clone(),
        created_at: rec.created_at.clone(),
        updated_at: rec.updated_at.clone(),
    }
}

// =====================================================================
//  Store: one record of the encrypted local store
// =====================================================================

const STORE_COLLECTION: &str = "ssh";
const STORE_ID: &str = "connections";

/// Connections, passwords and keys live in the encrypted local store
/// (`local_store.rs`, AES-256-GCM). Older versions wrote them in clear to
/// `<app_data_dir>/ssh/connections.json`: that file is imported once and removed.
fn load_store(app: &tauri::AppHandle) -> Result<SshFileShape, String> {
    let store = crate::local_store::get().ok_or("local store not ready")?;
    if let Some(value) = store.get(STORE_COLLECTION, STORE_ID) {
        return serde_json::from_value(value).map_err(|e| e.to_string());
    }
    let legacy = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir unavailable: {e}"))?
        .join("ssh")
        .join("connections.json");
    let Ok(bytes) = std::fs::read(&legacy) else {
        return Ok(SshFileShape::default());
    };
    // A file that does not parse is left where it is: deleting it would lose
    // the user's connections for good.
    let Ok(data) = serde_json::from_slice::<SshFileShape>(&bytes) else {
        eprintln!("[ssh] legacy connections file is not readable; left in place");
        return Ok(SshFileShape::default());
    };
    save_store(app, &data)?;
    let _ = std::fs::remove_file(&legacy);
    Ok(data)
}

fn save_store(_app: &tauri::AppHandle, data: &SshFileShape) -> Result<(), String> {
    let store = crate::local_store::get().ok_or("local store not ready")?;
    let value = serde_json::to_value(data).map_err(|e| e.to_string())?;
    store.put(STORE_COLLECTION, STORE_ID, value)
}

/// FULL record (with secrets) of a saved connection — main-only, never
/// to the renderer. Used by the remote sessions pool (commands/remote.rs).
pub(crate) fn load_connection(
    app: &tauri::AppHandle,
    conn_id: &str,
) -> Result<SshConnectionRecord, String> {
    let store = load_store(app)?;
    store
        .connections
        .iter()
        .find(|c| c.id == conn_id)
        .cloned()
        .ok_or_else(|| "SSH connection not found".to_string())
}

fn now_iso() -> String {
    // ISO-8601 UTC without extra dependencies (chrono): milliseconds since the epoch
    // formatted as a timestamp. TODO: switch to a real ISO-8601 string
    // (format `2026-06-22T...Z`).
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{ms}")
}

// =====================================================================
//  Interactive sessions (SshRuntimeManager)
// =====================================================================

/// Target of a session (`SshTarget`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SshTarget {
    Agent {
        #[serde(rename = "agentId")]
        agent_id: String,
    },
    Terminal {
        #[serde(rename = "terminalId")]
        terminal_id: String,
    },
}

/// Push event to the renderer. Unifies the three channels
/// (`ssh:output|closed|error`) into a single typed `Channel`.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SshEvent {
    Output {
        #[serde(rename = "sessionId")]
        session_id: String,
        target: SshTarget,
        data: String,
    },
    Closed {
        #[serde(rename = "sessionId")]
        session_id: String,
        target: SshTarget,
    },
    Error {
        #[serde(rename = "sessionId")]
        session_id: String,
        target: SshTarget,
        error: String,
    },
}

/// Commands sent to the async task that owns the SSH session.
enum SessionCmd {
    Write(String),
    Resize { cols: u16, rows: u16 },
    Close,
}

/// In-memory handle of a live session.
struct ActiveSession {
    conn_id: String,
    target: SshTarget,
    created_at: String,
    tx: mpsc::UnboundedSender<SessionCmd>,
}

/// Entry returned by `ssh:list-active`.
#[derive(Clone, Debug, Serialize)]
pub struct ActiveSessionInfo {
    pub id: String,
    #[serde(rename = "connId")]
    pub conn_id: String,
    pub target: SshTarget,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// Managed state (Arc + parking_lot::Mutex), like TerminalManager.
#[derive(Default)]
pub struct SshManager {
    sessions: Mutex<HashMap<String, ActiveSession>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn insert(&self, id: String, s: ActiveSession) {
        self.sessions.lock().insert(id, s);
    }

    fn remove(&self, id: &str) -> Option<ActiveSession> {
        self.sessions.lock().remove(id)
    }

    fn send(&self, id: &str, cmd: SessionCmd) {
        if let Some(s) = self.sessions.lock().get(id) {
            let _ = s.tx.send(cmd);
        }
    }

    fn list(&self) -> Vec<ActiveSessionInfo> {
        self.sessions
            .lock()
            .iter()
            .map(|(id, s)| ActiveSessionInfo {
                id: id.clone(),
                conn_id: s.conn_id.clone(),
                target: s.target.clone(),
                created_at: s.created_at.clone(),
            })
            .collect()
    }

    /// Ids of the sessions using a given connection (for `ssh:delete`).
    fn ids_for_conn(&self, conn_id: &str) -> Vec<String> {
        self.sessions
            .lock()
            .iter()
            .filter(|(_, s)| s.conn_id == conn_id)
            .map(|(id, _)| id.clone())
            .collect()
    }
}

/// `russh` client handler: checks the server's host key like OpenSSH with
/// `StrictHostKeyChecking=accept-new`. A key already recorded, in the user's
/// `~/.ssh/known_hosts` or in the app's own `ssh/known_hosts`, must match, or
/// the connection is refused. A host seen for the first time is recorded in
/// the app's file and accepted.
/// pub(crate): reused by the remote sessions pool (commands/remote.rs).
pub(crate) struct ClientHandler {
    host: String,
    port: u16,
    known_hosts: Option<PathBuf>,
}

impl ClientHandler {
    pub(crate) fn new(app: &tauri::AppHandle, host: &str, port: u16) -> Self {
        let known_hosts = app
            .path()
            .app_data_dir()
            .ok()
            .map(|d| d.join("ssh").join("known_hosts"));
        Self {
            host: host.to_string(),
            port,
            known_hosts,
        }
    }
}

/// Message for a refused host key, with the file to edit when the change is expected.
pub(crate) fn host_key_error(host: &str, port: u16, app: &tauri::AppHandle) -> String {
    let file = app
        .path()
        .app_data_dir()
        .map(|d| d.join("ssh").join("known_hosts").display().to_string())
        .unwrap_or_else(|_| "ssh/known_hosts".into());
    format!(
        "The host key of {host}:{port} does not match the one recorded. This can mean someone is intercepting the connection. If the server key really changed, remove its line from ~/.ssh/known_hosts or {file} and connect again."
    )
}

/// Deadline for the TCP connect and the SSH handshake.
pub(crate) const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// Deadline for authentication (key decoding included).
pub(crate) const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
/// Deadline for opening a channel and starting a shell or a command on it.
pub(crate) const CHANNEL_TIMEOUT: Duration = Duration::from_secs(15);

/// Why a connection could not be opened.
#[derive(Debug)]
pub(crate) enum ConnectFailure {
    /// The host key does not match the recorded one.
    HostKey,
    HandshakeTimeout,
    AuthTimeout,
    Handshake(String),
    BadKey(String),
    AuthRejected,
}

/// Connects to `conn` and authenticates, each step under its own deadline.
pub(crate) async fn connect_authenticated(
    handler: ClientHandler,
    conn: &SshConnectionRecord,
    handshake_timeout: Duration,
    auth_timeout: Duration,
) -> Result<client::Handle<ClientHandler>, ConnectFailure> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    });
    let addr = (conn.host.as_str(), conn.port);
    let mut handle =
        match tokio::time::timeout(handshake_timeout, client::connect(config, addr, handler)).await
        {
            Ok(Ok(h)) => h,
            Ok(Err(russh::Error::UnknownKey)) => return Err(ConnectFailure::HostKey),
            Ok(Err(e)) => return Err(ConnectFailure::Handshake(e.to_string())),
            Err(_) => return Err(ConnectFailure::HandshakeTimeout),
        };
    let auth = async {
        match conn.auth_type {
            AuthType::Password => Ok(handle
                .authenticate_password(&conn.username, &conn.secret)
                .await
                .map(|r| r.success())
                .unwrap_or(false)),
            AuthType::Key => {
                let key = russh::keys::decode_secret_key(&conn.secret, conn.passphrase.as_deref())
                    .map_err(|e| ConnectFailure::BadKey(e.to_string()))?;
                // RSA keys sign with the best hash the server accepts (rsa-sha2-512/256).
                let hash_alg = handle
                    .best_supported_rsa_hash()
                    .await
                    .ok()
                    .flatten()
                    .flatten();
                let key = russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg);
                Ok(handle
                    .authenticate_publickey(&conn.username, key)
                    .await
                    .map(|r| r.success())
                    .unwrap_or(false))
            }
        }
    };
    match tokio::time::timeout(auth_timeout, auth).await {
        Ok(Ok(true)) => Ok(handle),
        Ok(Ok(false)) => Err(ConnectFailure::AuthRejected),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(ConnectFailure::AuthTimeout),
    }
}

/// Text for a failed connection, as the UI shows it.
pub(crate) fn connect_failure_text(
    failure: ConnectFailure,
    conn: &SshConnectionRecord,
    app: &tauri::AppHandle,
) -> String {
    let (host, port) = (conn.host.as_str(), conn.port);
    match failure {
        ConnectFailure::HostKey => host_key_error(host, port, app),
        ConnectFailure::HandshakeTimeout => format!("SSH connection to {host}:{port} timed out"),
        ConnectFailure::AuthTimeout => {
            format!("SSH authentication on {host}:{port} timed out")
        }
        ConnectFailure::Handshake(e) => format!("SSH connection to {host}:{port} failed: {e}"),
        ConnectFailure::BadKey(e) => format!("invalid private key: {e}"),
        ConnectFailure::AuthRejected => {
            format!("SSH authentication failed for {}@{host}", conn.username)
        }
    }
}

/// Runs one channel setup step (open, pty, shell, exec) under `CHANNEL_TIMEOUT`.
pub(crate) async fn channel_step<T, E: std::fmt::Display>(
    what: &str,
    step: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, String> {
    channel_step_within(CHANNEL_TIMEOUT, what, step).await
}

async fn channel_step_within<T, E: std::fmt::Display>(
    limit: Duration,
    what: &str,
    step: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, String> {
    match tokio::time::timeout(limit, step).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(format!("SSH {what} failed: {e}")),
        Err(_) => Err(format!("SSH {what} timed out")),
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Host certificates are not trusted: only plain keys pinned in known_hosts.
        let russh::keys::PublicKeyOrCertificate::PublicKey {
            key: server_public_key,
            ..
        } = server_key
        else {
            return Ok(false);
        };
        use russh::keys::known_hosts::learn_known_hosts_path;
        use russh::keys::{check_known_hosts, check_known_hosts_path, Error as KeyError};
        let (host, port) = (self.host.as_str(), self.port);
        match check_known_hosts(host, port, server_public_key) {
            Ok(true) => return Ok(true),
            Err(KeyError::KeyChanged { .. }) => return Ok(false),
            _ => {}
        }
        let Some(path) = &self.known_hosts else {
            return Ok(false);
        };
        match check_known_hosts_path(host, port, server_public_key, path) {
            Ok(true) => Ok(true),
            Err(KeyError::KeyChanged { .. }) => Ok(false),
            _ => Ok(learn_known_hosts_path(host, port, server_public_key, path).is_ok()),
        }
    }
}

// =====================================================================
//  Tauri commands — CRUD
// =====================================================================

/// ssh:list — redacted connections for the given session (null = all).
/// Returns only the global ones (sessionId null) + those of the session.
#[tauri::command]
pub fn ssh_list(
    app: tauri::AppHandle,
    session_id: Option<String>,
) -> Result<Vec<SshConnectionPublic>, String> {
    let store = load_store(&app)?;
    let out: Vec<SshConnectionPublic> = store
        .connections
        .iter()
        .filter(|c| match &session_id {
            None => true,
            Some(sid) => c.session_id.as_deref() == Some(sid.as_str()) || c.session_id.is_none(),
        })
        .map(redact)
        .collect();
    Ok(out)
}

/// ssh:save — upsert of a connection. Returns the redacted view.
#[tauri::command]
pub fn ssh_save(
    app: tauri::AppHandle,
    input: SshConnectionInput,
) -> Result<SshConnectionPublic, String> {
    if input.name.trim().is_empty() {
        return Err("name is required".into());
    }
    if input.host.trim().is_empty() {
        return Err("host is required".into());
    }
    if input.username.trim().is_empty() {
        return Err("username is required".into());
    }
    if input.secret.is_empty() {
        return Err("secret is required".into());
    }

    let mut store = load_store(&app)?;
    let now = now_iso();

    let id = input
        .id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let existing_created = store
        .connections
        .iter()
        .find(|c| c.id == id)
        .map(|c| c.created_at.clone());

    let rec = SshConnectionRecord {
        id: id.clone(),
        session_id: input.session_id.clone(),
        name: input.name.trim().to_string(),
        host: input.host.trim().to_string(),
        port: input.port.unwrap_or(22),
        username: input.username.trim().to_string(),
        auth_type: input.auth_type,
        secret: input.secret.clone(),
        passphrase: input.passphrase.filter(|p| !p.is_empty()),
        cwd: input
            .cwd
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty()),
        created_at: existing_created.unwrap_or_else(|| now.clone()),
        updated_at: now,
    };

    if let Some(slot) = store.connections.iter_mut().find(|c| c.id == id) {
        *slot = rec.clone();
    } else {
        store.connections.push(rec.clone());
    }
    save_store(&app, &store)?;
    Ok(redact(&rec))
}

/// ssh:delete — deletes the connection and closes the active sessions using it.
#[tauri::command]
pub fn ssh_delete(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SshManager>>,
    id: String,
) -> Result<bool, String> {
    // first terminate the live sessions pointing to this connection
    for sid in manager.ids_for_conn(&id) {
        close_session(&manager, &sid);
    }

    let mut store = load_store(&app)?;
    let before = store.connections.len();
    store.connections.retain(|c| c.id != id);
    if store.connections.len() == before {
        return Ok(false);
    }
    save_store(&app, &store)?;
    Ok(true)
}

/// ssh:test — opens an ephemeral session to verify the handshake, then closes.
/// Spawns with terminal target `test:<ts>`, closes after ~500ms.
#[tauri::command]
pub async fn ssh_test(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SshManager>>,
    id: String,
) -> Result<bool, String> {
    let target = SshTarget::Terminal {
        terminal_id: format!(
            "test:{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ),
    };
    // "Discard-all" channel: the test does not stream output to the renderer.
    let sink = Channel::new(|_msg| Ok(()));
    let session_id =
        spawn_session(&app, manager.inner().clone(), &id, target, None, None, sink).await?;

    let mgr = manager.inner().clone();
    let sid = session_id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        close_session(&mgr, &sid);
    });
    Ok(true)
}

// =====================================================================
//  Tauri commands — interactive sessions
// =====================================================================

/// ssh:spawn — opens an interactive SSH session (PTY shell), streams the output.
/// Returns the `sessionId`.
#[tauri::command]
pub async fn ssh_spawn(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SshManager>>,
    conn_id: String,
    target: SshTarget,
    cols: Option<u16>,
    rows: Option<u16>,
    on_event: Channel<SshEvent>,
) -> Result<String, String> {
    spawn_session(
        &app,
        manager.inner().clone(),
        &conn_id,
        target,
        cols,
        rows,
        on_event,
    )
    .await
}

/// ssh:write — writes data to the remote shell.
#[tauri::command]
pub fn ssh_write(
    manager: tauri::State<'_, Arc<SshManager>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    manager.send(&session_id, SessionCmd::Write(data));
    Ok(())
}

/// ssh:resize — resizes the remote PTY window.
#[tauri::command]
pub fn ssh_resize(
    manager: tauri::State<'_, Arc<SshManager>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.send(&session_id, SessionCmd::Resize { cols, rows });
    Ok(())
}

/// ssh:close — closes the session and removes the handle from the pool.
#[tauri::command]
pub fn ssh_close(
    manager: tauri::State<'_, Arc<SshManager>>,
    session_id: String,
) -> Result<(), String> {
    close_session(&manager, &session_id);
    Ok(())
}

/// ssh:list-active — currently live sessions.
#[tauri::command]
pub fn ssh_list_active(
    manager: tauri::State<'_, Arc<SshManager>>,
) -> Result<Vec<ActiveSessionInfo>, String> {
    Ok(manager.list())
}

// =====================================================================
//  Internal helpers
// =====================================================================

fn close_session(manager: &Arc<SshManager>, session_id: &str) {
    if let Some(s) = manager.remove(session_id) {
        let _ = s.tx.send(SessionCmd::Close);
    }
}

/// Core of the spawn: resolves the record with secrets, opens the `russh`
/// connection, requests a PTY + shell, and starts the task that pumps the I/O.
async fn spawn_session(
    app: &tauri::AppHandle,
    manager: Arc<SshManager>,
    conn_id: &str,
    target: SshTarget,
    cols: Option<u16>,
    rows: Option<u16>,
    on_event: Channel<SshEvent>,
) -> Result<String, String> {
    // Load the FULL record (with secrets) — main-only, like `getSecret`.
    let store = load_store(app)?;
    let conn = store
        .connections
        .iter()
        .find(|c| c.id == conn_id)
        .cloned()
        .ok_or_else(|| "SSH connection not found".to_string())?;

    let session_id = Uuid::new_v4().to_string();
    let cols = cols.unwrap_or(120);
    let rows = rows.unwrap_or(30);

    let handler = ClientHandler::new(app, &conn.host, conn.port);
    let handle = match connect_authenticated(handler, &conn, HANDSHAKE_TIMEOUT, AUTH_TIMEOUT).await
    {
        Ok(h) => h,
        Err(failure) => {
            let msg = connect_failure_text(failure, &conn, app);
            let _ = on_event.send(SshEvent::Error {
                session_id: session_id.clone(),
                target: target.clone(),
                error: msg.clone(),
            });
            return Err(msg);
        }
    };

    // Channel + PTY + shell (term xterm-256color).
    let mut channel = channel_step("channel open", handle.channel_open_session()).await?;
    channel_step(
        "pty request",
        channel.request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[]),
    )
    .await?;
    channel_step("shell start", channel.request_shell(false)).await?;

    // optional cwd: `cd '<cwd>'` right after the shell opens.
    if let Some(cwd) = conn.cwd.as_ref() {
        let _ = channel.data(cd_line(cwd).as_bytes()).await;
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<SessionCmd>();

    manager.insert(
        session_id.clone(),
        ActiveSession {
            conn_id: conn_id.to_string(),
            target: target.clone(),
            created_at: now_iso(),
            tx,
        },
    );

    // Task that owns the session: multiplexes input (rx) and output (channel).
    let pump_session_id = session_id.clone();
    let pump_target = target.clone();
    let pump_manager = manager.clone();
    tauri::async_runtime::spawn(async move {
        // A multibyte character can be split across two SSH packets: decoding
        // each packet on its own turned both halves into U+FFFD.
        let mut stdout_text = Utf8Carry::default();
        let mut stderr_text = Utf8Carry::default();
        loop {
            tokio::select! {
                cmd = rx.recv() => {
                    match cmd {
                        Some(SessionCmd::Write(data)) => {
                            let _ = channel.data(data.as_bytes()).await;
                        }
                        Some(SessionCmd::Resize { cols, rows }) => {
                            let _ = channel
                                .window_change(cols as u32, rows as u32, 0, 0)
                                .await;
                        }
                        Some(SessionCmd::Close) | None => {
                            let _ = channel.eof().await;
                            break;
                        }
                    }
                }
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            let text = stdout_text.push(&data);
                            if !text.is_empty() {
                                let _ = on_event.send(SshEvent::Output {
                                    session_id: pump_session_id.clone(),
                                    target: pump_target.clone(),
                                    data: text,
                                });
                            }
                        }
                        // stderr extended data → treated as output.
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            let text = stderr_text.push(&data);
                            if !text.is_empty() {
                                let _ = on_event.send(SshEvent::Output {
                                    session_id: pump_session_id.clone(),
                                    target: pump_target.clone(),
                                    data: text,
                                });
                            }
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }
        // Cleanup: remove from the pool and emit `closed`.
        pump_manager.remove(&pump_session_id);
        let _ = on_event.send(SshEvent::Closed {
            session_id: pump_session_id.clone(),
            target: pump_target,
        });
    });

    Ok(session_id)
}

/// Decodes a byte stream as UTF-8 across chunk boundaries: an incomplete
/// character at the end of a chunk waits for the next one; bytes that can
/// never be UTF-8 become U+FFFD as before.
#[derive(Default)]
struct Utf8Carry {
    pending: Vec<u8>,
}

impl Utf8Carry {
    fn push(&mut self, data: &[u8]) -> String {
        self.pending.extend_from_slice(data);
        let buf = std::mem::take(&mut self.pending);
        let mut out = String::with_capacity(buf.len());
        let mut start = 0;
        loop {
            match std::str::from_utf8(&buf[start..]) {
                Ok(text) => {
                    out.push_str(text);
                    break;
                }
                Err(e) => {
                    let good = start + e.valid_up_to();
                    out.push_str(&String::from_utf8_lossy(&buf[start..good]));
                    match e.error_len() {
                        Some(bad) => {
                            out.push('\u{FFFD}');
                            start = good + bad;
                        }
                        None => {
                            self.pending = buf[good..].to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }
}

/// The `cd` typed into the remote shell for a connection's default folder.
/// Single quotes: inside double quotes the shell would still expand `$(…)`,
/// backticks and variables in the folder name.
fn cd_line(cwd: &str) -> String {
    format!("cd {}\n", crate::commands::remote::sh_quote(cwd))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(port: u16) -> SshConnectionRecord {
        SshConnectionRecord {
            id: "c1".into(),
            session_id: None,
            name: "t".into(),
            host: "127.0.0.1".into(),
            port,
            username: "u".into(),
            auth_type: AuthType::Password,
            secret: "pw".into(),
            passphrase: None,
            cwd: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn characters_split_across_packets_are_kept_whole() {
        let text = "naïve → 日本 🚀";
        let bytes = text.as_bytes();
        for cut in 0..=bytes.len() {
            let mut carry = Utf8Carry::default();
            let mut out = carry.push(&bytes[..cut]);
            out.push_str(&carry.push(&bytes[cut..]));
            assert_eq!(out, text, "cut at {cut}");
        }
        // One byte at a time.
        let mut carry = Utf8Carry::default();
        let out: String = bytes.iter().map(|b| carry.push(&[*b])).collect();
        assert_eq!(out, text);
        // Invalid bytes still become U+FFFD instead of stalling the stream.
        let mut carry = Utf8Carry::default();
        assert_eq!(carry.push(b"a\xffb"), "a\u{FFFD}b");
    }

    #[test]
    fn default_folder_is_single_quoted() {
        assert_eq!(cd_line("/srv/my app"), "cd '/srv/my app'\n");
        assert_eq!(cd_line("/x/$(touch y)`id`"), "cd '/x/$(touch y)`id`'\n");
        assert_eq!(cd_line("/it's"), "cd '/it'\\''s'\n");
    }

    /// A server that accepts the TCP connection and then says nothing must
    /// not hang the connect: the handshake deadline fires.
    #[tokio::test]
    async fn silent_server_hits_the_handshake_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hold = tokio::spawn(async move {
            let (_sock, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let handler = ClientHandler {
            host: "127.0.0.1".into(),
            port,
            known_hosts: None,
        };
        let started = std::time::Instant::now();
        let res = connect_authenticated(
            handler,
            &record(port),
            Duration::from_millis(300),
            Duration::from_millis(300),
        )
        .await;
        assert!(matches!(res, Err(ConnectFailure::HandshakeTimeout)));
        assert!(started.elapsed() < Duration::from_secs(5));
        hold.abort();
    }

    #[tokio::test]
    async fn refused_port_is_a_prompt_error() {
        // Bind then drop: nothing listens on the port any more.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let handler = ClientHandler {
            host: "127.0.0.1".into(),
            port,
            known_hosts: None,
        };
        let res = connect_authenticated(
            handler,
            &record(port),
            Duration::from_secs(5),
            Duration::from_secs(5),
        )
        .await;
        assert!(matches!(res, Err(ConnectFailure::Handshake(_))));
    }

    #[tokio::test]
    async fn stalled_channel_step_times_out() {
        let never = std::future::pending::<Result<(), String>>();
        let res = tokio::time::timeout(
            Duration::from_secs(5),
            channel_step_within(Duration::from_millis(100), "shell start", never),
        )
        .await
        .expect("channel_step must give up on its own");
        assert_eq!(res.unwrap_err(), "SSH shell start timed out");
    }
}
