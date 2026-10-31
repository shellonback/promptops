//! Remote sessions over SSH (beta, opt-in) — the session cwd is a virtual
//! path `ssh://<connectionId>/<absolute remote path>`.
//!
//! Design (see the "remote sessions" plan): the local flow stays UNCHANGED —
//! session.rs diverts to this module only when the cwd has the `ssh://` scheme.
//! This module holds:
//!  1. `RemotePool` — pool of russh connections keyed on connectionId: the
//!     first session connects+authenticates, later ones (same connection)
//!     only open a new channel on the same handle. A closed handle
//!     (network dropped) is discarded and recreated on next use.
//!  2. Remote browsing for the modal's picker (list dir / home / mkdir):
//!     exec-based (`ls -1A` + test `[ -d ]`), NO new dependency — the
//!     SFTP subsystem is the phase 2 upgrade.
//!  3. `open_shell_on` — interactive login shell INSIDE the remote cwd
//!     (`cd <q> && exec "${SHELL:-/bin/sh}" -l` via exec with PTY), pumped over
//!     mpsc channels so session.rs treats it like any other PTY.
//!
//! Connection records/secrets are those of the existing SSH panel
//! (`commands/ssh.rs`, on-disk store) — reused here via `load_connection`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use russh::client;
use russh::ChannelMsg;
use tokio::sync::mpsc;

use crate::commands::ssh::{channel_step, ClientHandler};

/// Scheme of remote virtual paths — native SSH transport (russh, connection
/// saved in the SSH panel): `ssh://<connId>/<path>`.
pub const REMOTE_SCHEME: &str = "ssh://";

/// Scheme of remote virtual paths — "command" transport (PREFERRED): the local
/// PTY runs the user's connection command (`ssh user@host`,
/// `aws ssm start-session --target i-…`, …) and keeps it alive; the remote path
/// lives after the scheme: `cmd://<absolute remote path>` (empty = home).
/// The command itself lives in `SessionConfig.remote_command` (persisted).
pub const CMD_SCHEME: &str = "cmd://";

/// True if the (config/cwd) path points to a remote host (either transport).
pub fn is_remote_path(path: Option<&str>) -> bool {
    path.map(|p| p.starts_with(REMOTE_SCHEME) || p.starts_with(CMD_SCHEME))
        .unwrap_or(false)
}

/// `cmd://<path>` → Some(remote path, "" = home). None for non-cmd paths.
pub fn parse_cmd_path(path: &str) -> Option<String> {
    path.strip_prefix(CMD_SCHEME).map(str::to_string)
}

/// `ssh://<connId>/<absolute path>` → (connId, "/absolute path").
/// Remote paths are always POSIX; a URI without a path resolves to home ("").
pub fn parse_remote_path(path: &str) -> Option<(String, String)> {
    let rest = path.strip_prefix(REMOTE_SCHEME)?;
    match rest.find('/') {
        Some(idx) => {
            let (conn, p) = rest.split_at(idx);
            if conn.is_empty() {
                return None;
            }
            Some((conn.to_string(), p.to_string()))
        }
        None if !rest.is_empty() => Some((rest.to_string(), String::new())),
        None => None,
    }
}

/// POSIX single-quote quoting (`'` → `'\''`): the only safe way to pass
/// arbitrary paths to a remote `sh -c`.
pub(crate) fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

// =====================================================================
//  Connection pool
// =====================================================================

/// Pool keyed on connectionId. The lock is tokio (held across the connect
/// awaits): two concurrent spawns on the same connection are serialized
/// instead of opening two handshakes.
#[derive(Default)]
pub struct RemotePool {
    conns: tokio::sync::Mutex<HashMap<String, Arc<client::Handle<ClientHandler>>>>,
}

impl RemotePool {
    pub fn new() -> Self {
        Self::default()
    }

    /// Live handle for the connection: reuses the pooled one if still open,
    /// otherwise connects and authenticates under the deadlines of ssh.rs
    /// (handshake 15s, authentication 30s), so a silent host cannot hold the
    /// pool lock for ever.
    pub async fn get_or_connect(
        &self,
        app: &tauri::AppHandle,
        conn_id: &str,
    ) -> Result<Arc<client::Handle<ClientHandler>>, String> {
        let mut guard = self.conns.lock().await;
        if let Some(h) = guard.get(conn_id) {
            if !h.is_closed() {
                return Ok(h.clone());
            }
            guard.remove(conn_id);
        }

        let conn = crate::commands::ssh::load_connection(app, conn_id)?;
        let handler = ClientHandler::new(app, &conn.host, conn.port);
        let handle = crate::commands::ssh::connect_authenticated(
            handler,
            &conn,
            crate::commands::ssh::HANDSHAKE_TIMEOUT,
            crate::commands::ssh::AUTH_TIMEOUT,
        )
        .await
        .map_err(|f| crate::commands::ssh::connect_failure_text(f, &conn, app))?;

        let handle = Arc::new(handle);
        guard.insert(conn_id.to_string(), handle.clone());
        Ok(handle)
    }
}

// =====================================================================
//  Exec helper (one-shot commands: browsing, provider check, mkdir)
// =====================================================================

/// Runs a command over an exec channel and captures stdout+stderr (lossy UTF-8)
/// and the exit status. Overall timeout so the caller never hangs.
pub(crate) async fn exec_capture(
    handle: &client::Handle<ClientHandler>,
    cmd: &str,
    timeout_secs: u64,
) -> Result<(String, Option<u32>), String> {
    exec_capture_io(handle, cmd, None, timeout_secs).await
}

/// Like `exec_capture`, but with an optional `stdin` written to the channel and closed
/// with EOF: binary files (asset upload) travel here and not in argv, which on
/// Linux truncates at 128 KB per argument.
pub(crate) async fn exec_capture_io(
    handle: &client::Handle<ClientHandler>,
    cmd: &str,
    stdin: Option<&[u8]>,
    timeout_secs: u64,
) -> Result<(String, Option<u32>), String> {
    // One deadline for the whole command, channel setup and stdin included.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
    let timed_out = || "remote command timed out".to_string();
    let mut channel = tokio::time::timeout_at(
        deadline,
        channel_step("channel open", handle.channel_open_session()),
    )
    .await
    .map_err(|_| timed_out())??;
    tokio::time::timeout_at(deadline, channel_step("exec", channel.exec(true, cmd)))
        .await
        .map_err(|_| timed_out())??;
    if let Some(bytes) = stdin {
        tokio::time::timeout_at(deadline, async {
            channel.data(bytes).await?;
            channel.eof().await
        })
        .await
        .map_err(|_| timed_out())?
        .map_err(|e| format!("SSH write failed: {e}"))?;
    }

    let mut out: Vec<u8> = Vec::new();
    let mut exit: Option<u32> = None;
    loop {
        let msg = match tokio::time::timeout_at(deadline, channel.wait()).await {
            Ok(m) => m,
            Err(_) => return Err("remote command timed out".into()),
        };
        match msg {
            Some(ChannelMsg::Data { data }) => out.extend_from_slice(&data),
            Some(ChannelMsg::ExtendedData { data, .. }) => out.extend_from_slice(&data),
            Some(ChannelMsg::ExitStatus { exit_status }) => exit = Some(exit_status),
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    Ok((String::from_utf8_lossy(&out).into_owned(), exit))
}

// =====================================================================
//  Remote shell for the session PTY
// =====================================================================

/// Commands to the task that owns the shell channel.
#[derive(Debug)]
pub(crate) enum RemoteCmd {
    Write(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

/// Messages from the shell channel to the session.rs reader.
pub(crate) enum RemoteShellMsg {
    Data(Vec<u8>),
    /// Channel closed (remote process exit OR connection dropped).
    Exit(Option<u32>),
}

/// Cloneable controller of the remote shell — the part session.rs keeps
/// inside SessionPty (resize) and inside writer/killer.
#[derive(Clone, Debug)]
pub(crate) struct RemoteShellCtl {
    tx: mpsc::UnboundedSender<RemoteCmd>,
}

impl RemoteShellCtl {
    pub(crate) fn write(&self, data: &[u8]) {
        let _ = self.tx.send(RemoteCmd::Write(data.to_vec()));
    }
    pub(crate) fn resize(&self, cols: u16, rows: u16) {
        let _ = self.tx.send(RemoteCmd::Resize { cols, rows });
    }
    pub(crate) fn close(&self) {
        let _ = self.tx.send(RemoteCmd::Close);
    }
}

pub(crate) struct RemoteShell {
    pub(crate) ctl: RemoteShellCtl,
    pub(crate) output_rx: mpsc::UnboundedReceiver<RemoteShellMsg>,
}

/// Opens the interactive remote shell inside `remote_cwd`: xterm-256color PTY +
/// `cd <q> && exec "${SHELL:-/bin/sh}" -l` (no `cd` typed on screen).
/// The owning task multiplexes input (RemoteCmd) and output (RemoteShellMsg)
/// like the ssh.rs pump; when the channel closes it ALWAYS sends Exit — that is the
/// signal session.rs turns into exited→standby (same UX as a crash of
/// a local provider).
pub(crate) async fn open_shell_on(
    handle: &client::Handle<ClientHandler>,
    remote_cwd: &str,
    cols: u16,
    rows: u16,
) -> Result<RemoteShell, String> {
    let mut channel = channel_step("channel open", handle.channel_open_session()).await?;
    channel_step(
        "pty request",
        channel.request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[]),
    )
    .await?;
    let launch = if remote_cwd.is_empty() {
        r#"exec "${SHELL:-/bin/sh}" -l"#.to_string()
    } else {
        format!(
            r#"cd {} && exec "${{SHELL:-/bin/sh}}" -l"#,
            sh_quote(remote_cwd)
        )
    };
    channel_step("shell start", channel.exec(true, launch)).await?;

    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<RemoteCmd>();
    let (out_tx, out_rx) = mpsc::unbounded_channel::<RemoteShellMsg>();

    tauri::async_runtime::spawn(async move {
        let mut exit_code: Option<u32> = None;
        loop {
            tokio::select! {
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(RemoteCmd::Write(data)) => {
                            let _ = channel.data(&data[..]).await;
                        }
                        Some(RemoteCmd::Resize { cols, rows }) => {
                            let _ = channel
                                .window_change(cols as u32, rows as u32, 0, 0)
                                .await;
                        }
                        Some(RemoteCmd::Close) | None => {
                            let _ = channel.eof().await;
                            break;
                        }
                    }
                }
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            let _ = out_tx.send(RemoteShellMsg::Data(data.to_vec()));
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            let _ = out_tx.send(RemoteShellMsg::Data(data.to_vec()));
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            exit_code = Some(exit_status);
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                }
            }
        }
        let _ = out_tx.send(RemoteShellMsg::Exit(exit_code));
    });

    Ok(RemoteShell {
        ctl: RemoteShellCtl { tx: cmd_tx },
        output_rx: out_rx,
    })
}

/// SYNCHRONOUS opening (dedicated thread/spawn_blocking) of a remote shell on a
/// saved connection: provider binary + folder check, then login shell
/// inside `remote_cwd`. Used by sub-agents (sessions have their own copy
/// in session.rs with typed errors for wake).
pub(crate) fn open_remote_shell_blocking(
    app: &tauri::AppHandle,
    conn_id: &str,
    remote_cwd: &str,
    expected_cmd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<RemoteShell, String> {
    use tauri::Manager as _;
    let pool = app.state::<Arc<RemotePool>>().inner().clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let async_app = app.clone();
    let conn = conn_id.to_string();
    let cwd = remote_cwd.to_string();
    tauri::async_runtime::spawn(async move {
        let result: Result<RemoteShell, String> = async {
            let handle = pool.get_or_connect(&async_app, &conn).await?;
            if let Some(cmd) = &expected_cmd {
                if !check_remote_command(&handle, cmd).await? {
                    return Err(format!(
                        "Provider binary \"{cmd}\" not found on the remote host. Install it (and log in) there before starting an agent."
                    ));
                }
            }
            if !check_remote_dir(&handle, &cwd).await? {
                return Err(format!("Remote folder not found: {cwd}"));
            }
            open_shell_on(&handle, &cwd, cols, rows).await
        }
        .await;
        let _ = tx.send(result);
    });
    rx.recv_timeout(Duration::from_secs(60))
        .map_err(|_| "Remote agent setup timed out".to_string())?
}

/// Blocking `Read` over the remote shell output: lets pumps designed
/// for a local PTY (`reader.read(&mut buf)`) also serve the
/// SSH transport. Exit/channel closed → `Ok(0)` (EOF).
pub(crate) struct RemoteShellReader {
    rx: mpsc::UnboundedReceiver<RemoteShellMsg>,
    pending: Vec<u8>,
}

impl RemoteShellReader {
    pub(crate) fn new(rx: mpsc::UnboundedReceiver<RemoteShellMsg>) -> Self {
        Self {
            rx,
            pending: Vec::new(),
        }
    }
}

impl std::io::Read for RemoteShellReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        while self.pending.is_empty() {
            match self.rx.blocking_recv() {
                Some(RemoteShellMsg::Data(d)) => self.pending = d,
                Some(RemoteShellMsg::Exit(_)) | None => return Ok(0),
            }
        }
        let n = buf.len().min(self.pending.len());
        buf[..n].copy_from_slice(&self.pending[..n]);
        self.pending.drain(..n);
        Ok(n)
    }
}

// =====================================================================
//  Tauri commands — browsing for the modal's picker
// =====================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteListResult {
    pub ok: bool,
    /// Canonical path resolved by the server (after `cd`, so without `..`).
    pub path: String,
    pub entries: Vec<RemoteEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn list_err(msg: impl Into<String>) -> RemoteListResult {
    RemoteListResult {
        ok: false,
        path: String::new(),
        entries: Vec::new(),
        error: Some(msg.into()),
    }
}

/// POSIX listing script, shared by both transports. First line
/// `p<TAB><canonical pwd>`, then `d|f<TAB><name>` per entry; `[ -d ]` follows
/// symlinks so a symlink→dir stays navigable. Empty path or `~` = home.
fn listing_script(path: Option<&str>) -> String {
    let cd = match path {
        None => "cd".to_string(),
        Some(p) if p.is_empty() || p == "~" => "cd".to_string(),
        Some(p) => format!("cd {}", sh_quote(p)),
    };
    format!(
        "{cd} 2>/dev/null || {{ echo '__PO_NOCD__'; exit 0; }}; printf 'p\\t%s\\n' \"$PWD\"; LC_ALL=C ls -1A | while IFS= read -r f; do if [ -d \"$f\" ]; then printf 'd\\t%s\\n' \"$f\"; else printf 'f\\t%s\\n' \"$f\"; fi; done"
    )
}

/// Parser for the output of `listing_script`.
fn parse_listing(out: &str, requested: &str) -> RemoteListResult {
    if out.contains("__PO_NOCD__") {
        return list_err(format!("Remote folder not accessible: {requested}"));
    }
    let mut resolved = String::new();
    let mut entries: Vec<RemoteEntry> = Vec::new();
    for line in out.lines() {
        let Some((kind, value)) = line.split_once('\t') else {
            continue;
        };
        match kind {
            "p" => resolved = value.to_string(),
            "d" => entries.push(RemoteEntry {
                name: value.to_string(),
                is_dir: true,
            }),
            "f" => entries.push(RemoteEntry {
                name: value.to_string(),
                is_dir: false,
            }),
            _ => {}
        }
    }
    if resolved.is_empty() {
        return list_err("unexpected remote listing output");
    }
    RemoteListResult {
        ok: true,
        path: resolved,
        entries,
        error: None,
    }
}

/// remote:list-dir — lists a remote directory. Empty `path` or "~" = home.
/// Never errors to the renderer: `{ok:false, error}` (the modal shows
/// the error inline — it is the picker's "warn if the connection fails").
#[tauri::command]
pub async fn remote_list_dir(
    app: tauri::AppHandle,
    pool: tauri::State<'_, Arc<RemotePool>>,
    conn_id: String,
    path: Option<String>,
) -> Result<RemoteListResult, String> {
    let handle = match pool.get_or_connect(&app, &conn_id).await {
        Ok(h) => h,
        Err(e) => return Ok(list_err(e)),
    };
    let path = path.unwrap_or_default();
    let script = listing_script(Some(&path));
    let (out, _) = match exec_capture(&handle, &script, 20).await {
        Ok(r) => r,
        Err(e) => return Ok(list_err(e)),
    };
    Ok(parse_listing(&out, &path))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOkResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// remote:home-dir — remote user's home (browser start).
#[tauri::command]
pub async fn remote_home_dir(
    app: tauri::AppHandle,
    pool: tauri::State<'_, Arc<RemotePool>>,
    conn_id: String,
) -> Result<RemoteOkResult, String> {
    let handle = match pool.get_or_connect(&app, &conn_id).await {
        Ok(h) => h,
        Err(e) => {
            return Ok(RemoteOkResult {
                ok: false,
                path: None,
                error: Some(e),
            })
        }
    };
    match exec_capture(&handle, "printf '%s' \"$HOME\"", 10).await {
        Ok((out, _)) if !out.trim().is_empty() => Ok(RemoteOkResult {
            ok: true,
            path: Some(out.trim().to_string()),
            error: None,
        }),
        Ok(_) => Ok(RemoteOkResult {
            ok: false,
            path: None,
            error: Some("empty $HOME".into()),
        }),
        Err(e) => Ok(RemoteOkResult {
            ok: false,
            path: None,
            error: Some(e),
        }),
    }
}

/// remote:create-folder — remote mkdir with the SAME rules as
/// workspace_create_folder: single segment, no traversal/separators.
#[tauri::command]
pub async fn remote_create_folder(
    app: tauri::AppHandle,
    pool: tauri::State<'_, Arc<RemotePool>>,
    conn_id: String,
    parent_path: String,
    folder_name: String,
) -> Result<RemoteOkResult, String> {
    let name = folder_name.trim();
    let invalid = name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name
            .chars()
            .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        || name.chars().any(|c| c.is_control());
    if invalid {
        return Ok(RemoteOkResult {
            ok: false,
            path: None,
            error: Some("invalid folder name".into()),
        });
    }
    let handle = match pool.get_or_connect(&app, &conn_id).await {
        Ok(h) => h,
        Err(e) => {
            return Ok(RemoteOkResult {
                ok: false,
                path: None,
                error: Some(e),
            })
        }
    };
    let full = format!("{}/{}", parent_path.trim_end_matches('/'), name);
    let script = format!(
        "mkdir -p {q} && cd {q} && printf 'ok\\t%s\\n' \"$PWD\"",
        q = sh_quote(&full)
    );
    match exec_capture(&handle, &script, 15).await {
        Ok((out, _)) => match out.lines().find_map(|l| l.strip_prefix("ok\t")) {
            Some(p) => Ok(RemoteOkResult {
                ok: true,
                path: Some(p.to_string()),
                error: None,
            }),
            None => Ok(RemoteOkResult {
                ok: false,
                path: None,
                error: Some(format!("mkdir failed: {}", out.trim())),
            }),
        },
        Err(e) => Ok(RemoteOkResult {
            ok: false,
            path: None,
            error: Some(e),
        }),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProviderCheck {
    pub ok: bool,
    pub installed: bool,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// remote:check-provider — `command -v` on the remote host.
#[tauri::command]
pub async fn remote_check_provider(
    app: tauri::AppHandle,
    pool: tauri::State<'_, Arc<RemotePool>>,
    conn_id: String,
    command: String,
) -> Result<RemoteProviderCheck, String> {
    let handle = match pool.get_or_connect(&app, &conn_id).await {
        Ok(h) => h,
        Err(e) => {
            return Ok(RemoteProviderCheck {
                ok: false,
                installed: false,
                command,
                error: Some(e),
            })
        }
    };
    match check_remote_command(&handle, &command).await {
        Ok(installed) => Ok(RemoteProviderCheck {
            ok: true,
            installed,
            command,
            error: None,
        }),
        Err(e) => Ok(RemoteProviderCheck {
            ok: false,
            installed: false,
            command,
            error: Some(e),
        }),
    }
}

/// Remote `command -v <cmd>`, with PATH from a login shell when possible: many
/// CLI installs (npm/bun) live in paths known only to the login profile.
pub(crate) async fn check_remote_command(
    handle: &client::Handle<ClientHandler>,
    command: &str,
) -> Result<bool, String> {
    let direct = format!("command -v {} >/dev/null 2>&1", sh_quote(command));
    let login = format!("\"${{SHELL:-/bin/sh}}\" -lc {}", sh_quote(&direct));
    let script =
        format!("if {direct}; then echo __PO_OK__; elif {login}; then echo __PO_OK__; else echo __PO_NO__; fi");
    let (out, _) = exec_capture(handle, &script, 15).await?;
    Ok(out.contains("__PO_OK__"))
}

/// remote:test-connection — trivial connection+auth+exec, descriptive error.
#[tauri::command]
pub async fn remote_test_connection(
    app: tauri::AppHandle,
    pool: tauri::State<'_, Arc<RemotePool>>,
    conn_id: String,
) -> Result<RemoteOkResult, String> {
    let handle = match pool.get_or_connect(&app, &conn_id).await {
        Ok(h) => h,
        Err(e) => {
            return Ok(RemoteOkResult {
                ok: false,
                path: None,
                error: Some(e),
            })
        }
    };
    match exec_capture(&handle, "true", 10).await {
        Ok(_) => Ok(RemoteOkResult {
            ok: true,
            path: None,
            error: None,
        }),
        Err(e) => Ok(RemoteOkResult {
            ok: false,
            path: None,
            error: Some(e),
        }),
    }
}

/// Checks that the remote folder exists (pre-spawn: typed error instead
/// of a shell that dies immediately with `cd: not found`).
pub(crate) async fn check_remote_dir(
    handle: &client::Handle<ClientHandler>,
    path: &str,
) -> Result<bool, String> {
    let script = format!(
        "[ -d {} ] && echo __PO_OK__ || echo __PO_NO__",
        sh_quote(path)
    );
    let (out, _) = exec_capture(handle, &script, 10).await?;
    Ok(out.contains("__PO_OK__"))
}

// =====================================================================
//  "command" transport — browsing run THROUGH the user's connection
//  command (`ssh user@host '<script>'`). Works with any
//  command that accepts a remote command as an extra argument (ssh and
//  the like); those that don't (e.g. `aws ssm start-session`) fail with a
//  descriptive error and the UI falls back to the hand-typed path.
// =====================================================================

/// Local shell used to compose `<shell> -lc "<connect_cmd> '<script>'"`.
fn local_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".into()
    } else {
        std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/sh".into())
    }
}

/// One remote shell command that runs `remote_script` without quoting it:
/// the script is base64 (no quote, `$` or space for any local shell to
/// interpret), decoded and evaluated by the remote POSIX shell. `IFS=` and
/// `set -f` keep the decoded text one word, unglobbed; the script itself
/// starts by restoring both. stdin stays free for the script (uploads).
pub(crate) fn encoded_remote_command(remote_script: &str) -> String {
    use base64::Engine as _;
    let body = format!("unset IFS; set +f\n{remote_script}");
    let b64 = base64::engine::general_purpose::STANDARD.encode(body.as_bytes());
    format!("IFS=; set -f; eval $(printf %s {b64} | base64 -d)")
}

/// Runs `<connect_cmd> '<remote_script>'` as a local subprocess (stdin
/// closed: never hung interactive prompts), with timeout and kill-on-drop.
/// Returns stdout; stderr goes into the error when the exit is non-zero.
pub(crate) async fn run_via_command(
    connect_cmd: &str,
    remote_script: &str,
    timeout_secs: u64,
) -> Result<String, String> {
    run_via_command_io(connect_cmd, remote_script, None, timeout_secs).await
}

/// Like `run_via_command`, with an optional `stdin` forwarded by the connection
/// command to the remote process (ssh does it natively) and then closed.
pub(crate) async fn run_via_command_io(
    connect_cmd: &str,
    remote_script: &str,
    stdin: Option<&[u8]>,
    timeout_secs: u64,
) -> Result<String, String> {
    let mut cmd = if cfg!(windows) {
        // PowerShell does not understand the POSIX quoting of `sh_quote`
        // ('a'\''b' is three tokens there) and its native argument passing
        // mangles inner `"`. The remote command travels in an environment
        // variable instead, as text made of base64 and fixed words only.
        let mut c = crate::commands::util_cmd::tokio_cmd(local_shell());
        c.args(crate::commands::util_cmd::powershell_args(&format!(
            "{connect_cmd} $env:PO_REMOTE_CMD"
        )))
        .env("PO_REMOTE_CMD", encoded_remote_command(remote_script));
        c
    } else {
        let full = format!("{connect_cmd} {}", sh_quote(remote_script));
        let mut c = crate::commands::util_cmd::tokio_cmd(local_shell());
        c.arg("-lc").arg(&full);
        c
    };
    let stdin_mode = if stdin.is_some() {
        std::process::Stdio::piped()
    } else {
        std::process::Stdio::null()
    };
    cmd.stdin(stdin_mode)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot run connect command: {e}"))?;
    if let (Some(bytes), Some(mut writer)) = (stdin, child.stdin.take()) {
        // Write in a separate task: stdout/stderr are drained in
        // parallel by wait_with_output, so no deadlock on the pipes.
        let bytes = bytes.to_vec();
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt as _;
            let _ = writer.write_all(&bytes).await;
            let _ = writer.shutdown().await;
        });
    }
    let out = tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output())
        .await
        .map_err(|_| {
            "connect command timed out (interactive auth? use keys/agent, or type the path manually)"
                .to_string()
        })?
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.status.success() && stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr.lines().rev().take(3).collect::<Vec<_>>().join(" | ");
        return Err(if tail.trim().is_empty() {
            format!("connect command failed (exit {:?})", out.status.code())
        } else {
            format!("connect command failed: {tail}")
        });
    }
    Ok(stdout)
}

/// remote:cmd-list-dir — remote listing via the connection command.
/// Missing `path` = remote home. Never errors to the renderer: `{ok:false}`.
#[tauri::command]
pub async fn remote_cmd_list_dir(
    command: String,
    path: Option<String>,
) -> Result<RemoteListResult, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Ok(list_err("connect command is empty"));
    }
    let requested = path.clone().unwrap_or_default();
    let script = listing_script(path.as_deref());
    match run_via_command(&command, &script, 25).await {
        Ok(out) => Ok(parse_listing(&out, &requested)),
        Err(e) => Ok(list_err(e)),
    }
}

/// remote:cmd-create-folder — remote mkdir via the connection command,
/// same validation rules as remote_create_folder.
#[tauri::command]
pub async fn remote_cmd_create_folder(
    command: String,
    parent_path: String,
    folder_name: String,
) -> Result<RemoteOkResult, String> {
    let name = folder_name.trim();
    let invalid = name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name
            .chars()
            .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        || name.chars().any(|c| c.is_control());
    if invalid {
        return Ok(RemoteOkResult {
            ok: false,
            path: None,
            error: Some("invalid folder name".into()),
        });
    }
    let command = command.trim().to_string();
    if command.is_empty() {
        return Ok(RemoteOkResult {
            ok: false,
            path: None,
            error: Some("connect command is empty".into()),
        });
    }
    let full = format!("{}/{}", parent_path.trim_end_matches('/'), name);
    let script = format!(
        "mkdir -p {q} && cd {q} && printf 'ok\\t%s\\n' \"$PWD\"",
        q = sh_quote(&full)
    );
    match run_via_command(&command, &script, 20).await {
        Ok(out) => match out.lines().find_map(|l| l.strip_prefix("ok\t")) {
            Some(p) => Ok(RemoteOkResult {
                ok: true,
                path: Some(p.to_string()),
                error: None,
            }),
            None => Ok(RemoteOkResult {
                ok: false,
                path: None,
                error: Some(format!("mkdir failed: {}", out.trim())),
            }),
        },
        Err(e) => Ok(RemoteOkResult {
            ok: false,
            path: None,
            error: Some(e),
        }),
    }
}

// =====================================================================
//  Guided setup (create session modal): host probe + mini-terminal.
//  They work on BOTH transports: `conn_id` (native ssh) or
//  `command` (the user's connection command).
// =====================================================================

/// Transport of a remote session, derived from its virtual cwd.
pub(crate) enum RemoteTarget {
    /// `cmd://…` — the user's connection command (config.remoteCommand).
    Command(String),
    /// `ssh://<connId>/…` — saved connection, via the russh pool.
    Ssh(String),
}

/// Runs a remote script on the given transport, with optional stdin.
/// Returns stdout (on native ssh it includes stderr too: use markers).
pub(crate) async fn run_on_target(
    app: &tauri::AppHandle,
    target: &RemoteTarget,
    script: &str,
    stdin: Option<&[u8]>,
    timeout_secs: u64,
) -> Result<String, String> {
    match target {
        RemoteTarget::Command(cmd) => run_via_command_io(cmd, script, stdin, timeout_secs).await,
        RemoteTarget::Ssh(conn_id) => {
            use tauri::Manager as _;
            let pool = app.state::<Arc<RemotePool>>();
            let handle = pool.get_or_connect(app, conn_id).await?;
            exec_capture_io(&handle, script, stdin, timeout_secs)
                .await
                .map(|(out, _)| out)
        }
    }
}

/// Runs a remote script on the given transport and returns its stdout.
async fn run_remote_script(
    app: &tauri::AppHandle,
    pool: &RemotePool,
    conn_id: Option<&str>,
    command: Option<&str>,
    script: &str,
    timeout_secs: u64,
) -> Result<String, String> {
    if let Some(cmd) = command.map(str::trim).filter(|c| !c.is_empty()) {
        return run_via_command(cmd, script, timeout_secs).await;
    }
    let Some(id) = conn_id.filter(|c| !c.is_empty()) else {
        return Err("no connection: pick a saved connection or type the connect command".into());
    };
    let handle = pool.get_or_connect(app, id).await?;
    exec_capture(&handle, script, timeout_secs)
        .await
        .map(|(out, _)| out)
}

/// Provider CLIs looked up on the host during the probe (login shell: npm/bun
/// install into paths known only to the profile).
const PROBE_CLIS: &[&str] = &[
    "claude",
    "codex",
    "gemini",
    "agy",
    "muse",
    "opencode",
    "kora",
    "cursor-agent",
    "qwen",
    "copilot",
];

fn probe_script() -> String {
    let clis = PROBE_CLIS.join(" ");
    let inner = format!(
        "for c in {clis}; do command -v \"$c\" >/dev/null 2>&1 && printf 'cli\\t%s\\n' \"$c\"; done"
    );
    format!(
        "printf '__PO_PROBE__\\n'; \
         printf 'os\\t%s\\n' \"$(uname -s 2>/dev/null)\"; \
         printf 'arch\\t%s\\n' \"$(uname -m 2>/dev/null)\"; \
         printf 'kernel\\t%s\\n' \"$(uname -r 2>/dev/null)\"; \
         printf 'home\\t%s\\n' \"$HOME\"; \
         printf 'user\\t%s\\n' \"$(id -un 2>/dev/null || whoami 2>/dev/null)\"; \
         printf 'host\\t%s\\n' \"$(hostname 2>/dev/null || uname -n 2>/dev/null)\"; \
         printf 'shell\\t%s\\n' \"${{SHELL:-/bin/sh}}\"; \
         [ -r /etc/os-release ] && printf 'distro\\t%s\\n' \"$(. /etc/os-release 2>/dev/null; echo \"${{PRETTY_NAME:-$NAME}}\")\"; \
         \"${{SHELL:-/bin/sh}}\" -lc {q} 2>/dev/null </dev/null || {inner}",
        q = sh_quote(&inner),
    )
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProbeResult {
    pub ok: bool,
    pub os: String,
    pub arch: String,
    pub kernel: String,
    pub distro: String,
    pub home: String,
    pub user: String,
    pub host: String,
    pub shell: String,
    /// Provider CLIs found on the host (claude, codex, …).
    pub clis: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn parse_probe(out: &str) -> RemoteProbeResult {
    if !out.contains("__PO_PROBE__") {
        let tail: String = out.lines().rev().take(3).collect::<Vec<_>>().join(" | ");
        return RemoteProbeResult {
            ok: false,
            error: Some(if tail.trim().is_empty() {
                "the remote host did not answer the probe (does the command accept a remote command argument?)".into()
            } else {
                format!("unexpected probe output: {tail}")
            }),
            ..Default::default()
        };
    }
    let mut r = RemoteProbeResult {
        ok: true,
        ..Default::default()
    };
    for line in out.lines() {
        let Some((k, v)) = line.split_once('\t') else {
            continue;
        };
        let v = v.trim().to_string();
        match k {
            "os" => r.os = v,
            "arch" => r.arch = v,
            "kernel" => r.kernel = v,
            "distro" => r.distro = v,
            "home" => r.home = v,
            "user" => r.user = v,
            "host" => r.host = v,
            "shell" => r.shell = v,
            "cli" if !v.is_empty() && !r.clis.contains(&v) => r.clis.push(v),
            _ => {}
        }
    }
    r
}

/// remote:probe — connection check + OS/architecture/home/CLI detection.
/// It is step 1 of the guided setup: without an OK probe the modal does not proceed.
#[tauri::command]
pub async fn remote_probe(
    app: tauri::AppHandle,
    pool: tauri::State<'_, Arc<RemotePool>>,
    conn_id: Option<String>,
    command: Option<String>,
) -> Result<RemoteProbeResult, String> {
    match run_remote_script(
        &app,
        &pool,
        conn_id.as_deref(),
        command.as_deref(),
        &probe_script(),
        30,
    )
    .await
    {
        Ok(out) => Ok(parse_probe(&out)),
        Err(e) => Ok(RemoteProbeResult {
            ok: false,
            error: Some(e),
            ..Default::default()
        }),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteShellExecResult {
    pub ok: bool,
    pub output: String,
    /// Remote cwd AFTER the command (a user `cd` moves it).
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

const PWD_MARK: &str = "__PO_PWD__\t";
const MAX_SHELL_OUTPUT: usize = 64 * 1024;

fn shell_exec_script(cwd: &str, line: &str) -> String {
    let cd = if cwd.trim().is_empty() || cwd == "~" {
        "cd".to_string()
    } else {
        format!("cd {} 2>/dev/null || cd", sh_quote(cwd))
    };
    format!("{cd}; {{\n{line}\n}} 2>&1 </dev/null; printf '\\n{PWD_MARK}%s\\n' \"$PWD\"")
}

fn parse_shell_exec(out: &str, fallback_cwd: &str) -> RemoteShellExecResult {
    let (body, cwd) = match out.rfind(PWD_MARK) {
        Some(i) => (&out[..i], out[i + PWD_MARK.len()..].trim().to_string()),
        None => (out, fallback_cwd.to_string()),
    };
    let mut output = body.trim_end_matches('\n').to_string();
    if output.len() > MAX_SHELL_OUTPUT {
        let mut cut = MAX_SHELL_OUTPUT;
        while !output.is_char_boundary(cut) {
            cut -= 1;
        }
        output.truncate(cut);
        output.push_str("\n… (output truncated)");
    }
    RemoteShellExecResult {
        ok: true,
        output,
        cwd,
        error: None,
    }
}

/// remote:shell-exec — the modal's mini-terminal: runs ONE line in the
/// remote `cwd` and returns output + new cwd (so `cd` navigates and the final
/// folder becomes the session cwd). Non-interactive: stdin closed.
#[tauri::command]
pub async fn remote_shell_exec(
    app: tauri::AppHandle,
    pool: tauri::State<'_, Arc<RemotePool>>,
    conn_id: Option<String>,
    command: Option<String>,
    cwd: String,
    line: String,
) -> Result<RemoteShellExecResult, String> {
    let line = line.trim();
    if line.is_empty() {
        return Ok(RemoteShellExecResult {
            ok: true,
            output: String::new(),
            cwd,
            error: None,
        });
    }
    let script = shell_exec_script(&cwd, line);
    match run_remote_script(
        &app,
        &pool,
        conn_id.as_deref(),
        command.as_deref(),
        &script,
        30,
    )
    .await
    {
        Ok(out) => Ok(parse_shell_exec(&out, &cwd)),
        Err(e) => Ok(RemoteShellExecResult {
            ok: false,
            output: String::new(),
            cwd,
            error: Some(e),
        }),
    }
}

// =====================================================================
//  Tests — run on a real local shell (`sh` as the "connection
//  command"): they validate quoting composition, listing script, parser
//  and mkdir end-to-end without needing a remote host.
// =====================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_schemes() {
        assert_eq!(
            parse_remote_path("ssh://abc/home/u/proj"),
            Some(("abc".into(), "/home/u/proj".into()))
        );
        assert_eq!(parse_cmd_path("cmd:///var/www"), Some("/var/www".into()));
        assert_eq!(parse_cmd_path("cmd://"), Some(String::new()));
        assert!(parse_cmd_path("/local/path").is_none());
        assert!(is_remote_path(Some("cmd:///x")));
        assert!(is_remote_path(Some("ssh://a/x")));
        assert!(!is_remote_path(Some("/Users/x")));
    }

    /// The Windows form of a remote command: only base64 and fixed words, and
    /// a remote `sh` runs the original script exactly (quotes, `$`, newlines,
    /// globs) with stdin still available to it.
    #[cfg(unix)]
    #[test]
    fn encoded_remote_command_runs_the_script_verbatim() {
        let script = "x='it'\\''s \"q\" $HOME *'; printf '%s|' \"$x\"; for w in a b; do printf '%s,' \"$w\"; done; cat";
        let encoded = encoded_remote_command(script);
        assert!(
            encoded
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || " =;-$()|+/%".contains(c)),
            "{encoded}"
        );
        let mut child = std::process::Command::new("sh")
            .args(["-c", &encoded])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write as _;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"from-stdin")
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert_eq!(
            String::from_utf8(out.stdout).unwrap(),
            "it's \"q\" $HOME *|a,b,from-stdin"
        );
    }

    #[test]
    fn sh_quote_escapes() {
        assert_eq!(sh_quote("a'b"), "'a'\\''b'");
        assert_eq!(sh_quote("plain"), "'plain'");
    }

    /// `sh` as connection command: `sh 'script'`? No — `sh` reads the
    /// script from stdin (closed). We use `sh -c`, which is the argument form,
    /// just as `ssh host '<script>'` runs the remote argument.
    #[cfg(unix)] // the cmd transport runs sh
    #[tokio::test]
    async fn cmd_transport_lists_real_dir() {
        let tmp = std::env::temp_dir().join(format!("po-remote-test-{}", std::process::id()));
        std::fs::create_dir_all(tmp.join("sub-dir")).unwrap();
        std::fs::write(tmp.join("file.txt"), "x").unwrap();

        let script = listing_script(Some(tmp.to_str().unwrap()));
        let out = run_via_command("sh -c", &script, 15).await.expect("run ok");
        let res = parse_listing(&out, tmp.to_str().unwrap());
        assert!(res.ok, "listing failed: {:?}", res.error);
        assert!(!res.path.is_empty());
        assert!(res.entries.iter().any(|e| e.name == "sub-dir" && e.is_dir));
        assert!(res
            .entries
            .iter()
            .any(|e| e.name == "file.txt" && !e.is_dir));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)] // the cmd transport runs sh
    #[tokio::test]
    async fn cmd_transport_probe_and_shell_exec() {
        let out = run_via_command("sh -c", &probe_script(), 20)
            .await
            .expect("probe run");
        let p = parse_probe(&out);
        assert!(p.ok, "probe failed: {:?}", p.error);
        assert!(!p.os.is_empty() && !p.arch.is_empty() && !p.home.is_empty());

        let tmp = std::env::temp_dir().join(format!("po-remote-sh-{}", std::process::id()));
        std::fs::create_dir_all(tmp.join("dir with spaces")).unwrap();
        let cwd = tmp.to_str().unwrap().to_string();
        let out = run_via_command(
            "sh -c",
            &shell_exec_script(&cwd, "cd 'dir with spaces' && echo hi"),
            15,
        )
        .await
        .expect("exec run");
        let r = parse_shell_exec(&out, &cwd);
        assert_eq!(r.output, "hi");
        assert!(r.cwd.ends_with("dir with spaces"), "cwd = {}", r.cwd);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)] // the cmd transport runs sh
    #[tokio::test]
    async fn cmd_transport_mkdir_and_nocd() {
        let tmp = std::env::temp_dir().join(format!("po-remote-mk-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();

        // mkdir via command
        let full = format!("{}/new folder", tmp.to_str().unwrap());
        let script = format!(
            "mkdir -p {q} && cd {q} && printf 'ok\\t%s\\n' \"$PWD\"",
            q = sh_quote(&full)
        );
        let out = run_via_command("sh -c", &script, 15).await.expect("run ok");
        let created = out
            .lines()
            .find_map(|l| l.strip_prefix("ok\t"))
            .expect("ok line");
        assert!(created.ends_with("new folder"));

        // nonexistent folder → __PO_NOCD__
        let script = listing_script(Some("/definitely/not/here-po"));
        let out = run_via_command("sh -c", &script, 15).await.expect("run ok");
        let res = parse_listing(&out, "/definitely/not/here-po");
        assert!(!res.ok);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
