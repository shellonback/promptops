//! App ↔ termd link (phase 5 of the terminal host).
//!
//! With the flag on, session PTYs do not live in the app process but in
//! `promptops-termd`: a crash, an update restart or a dev server restart does
//! not kill them, and on reopen the app reattaches with the screen snapshot.
//! On a normal app QUIT, however, they all stop (product decision):
//! `shutdown_on_exit`.
//!
//! The app stays the single source of truth for buffers, replay, hooks and
//! states: termd forwards the bytes, which enter the same OutputBuffer/pump as
//! a local PTY. With the flag off, nothing in this module is used.
use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use termd::client::{Client, ClientTx, Event};
use termd::proto::{PtyInfo, Reply, Request};

/// Time termd gives the app to come back after a crash before it closes the
/// agents left without an app on its own.
const ORPHAN_TIMEOUT_SECS: u64 = 15 * 60;
const CONNECT_BUDGET: Duration = Duration::from_secs(5);
const REPLY_TIMEOUT: Duration = Duration::from_secs(10);

/// External terminal host (beta). On by default on macOS and Linux, off on
/// Windows until it is tested on real machines. Per-device setting saved in
/// `termd/enabled` (read by Rust at boot, before the renderer, so restores at
/// startup honor it too). Override: `PROMPTOPS_TERMD=1|0`. Applies to PTYs
/// created from then on: already live ones stay where they are. Without the
/// binary next to the app, everything stays in-process.
pub(crate) const DEFAULT_ENABLED: bool = cfg!(not(windows));
static ENABLED: OnceLock<std::sync::atomic::AtomicBool> = OnceLock::new();

fn enabled_flag() -> &'static std::sync::atomic::AtomicBool {
    ENABLED.get_or_init(|| {
        let on = match std::fs::read_to_string(termd_dir().join("enabled")) {
            Ok(v) => v.trim() == "1",
            Err(_) => DEFAULT_ENABLED,
        };
        std::sync::atomic::AtomicBool::new(on)
    })
}

pub(crate) fn enabled() -> bool {
    match std::env::var("PROMPTOPS_TERMD").ok().as_deref() {
        Some("1") => return true,
        Some("0") => return false,
        _ => {}
    }
    enabled_flag().load(Ordering::Relaxed) && termd_bin().is_some()
}

/// "Agents survive crashes and updates" setting (beta).
#[tauri::command]
pub fn termd_set_enabled(enabled: bool) -> Result<bool, String> {
    let dir = termd_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("enabled"), if enabled { "1" } else { "0" })
        .map_err(|e| e.to_string())?;
    enabled_flag().store(enabled, Ordering::Relaxed);
    Ok(self::enabled())
}

/// Receiver of a termd PTY's output (the app session).
pub(crate) trait TermdSink: Send + Sync {
    fn output(&self, data: &[u8]);
    fn exited(&self, code: Option<u32>);
}

struct Link {
    tx: Mutex<Option<Arc<ClientTx>>>,
    sinks: Mutex<HashMap<String, Arc<dyn TermdSink>>>,
    /// Pending replies by id (spawn) and for the list.
    pending: Mutex<HashMap<String, mpsc::Sender<Reply>>>,
    list_waiter: Mutex<Option<mpsc::Sender<Vec<PtyInfo>>>>,
    reconnecting: AtomicBool,
    keep_alive_on_exit: AtomicBool,
}

fn link() -> &'static Link {
    static L: OnceLock<Link> = OnceLock::new();
    L.get_or_init(|| Link {
        tx: Mutex::new(None),
        sinks: Mutex::new(HashMap::new()),
        pending: Mutex::new(HashMap::new()),
        list_waiter: Mutex::new(None),
        reconnecting: AtomicBool::new(false),
        keep_alive_on_exit: AtomicBool::new(false),
    })
}

fn termd_dir() -> PathBuf {
    crate::commands::hook::hook_data_dir().join("termd")
}

/// Binary: `PROMPTOPS_TERMD_BIN` (dev), otherwise next to the app executable
/// (where Tauri puts `externalBin` sidecars).
fn termd_bin() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("PROMPTOPS_TERMD_BIN") {
        return Some(PathBuf::from(p));
    }
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(windows) {
        "promptops-termd.exe"
    } else {
        "promptops-termd"
    };
    let p = exe.parent()?.join(name);
    if p.exists() {
        return Some(p);
    }
    // Dev build: the binary built in the sibling crate.
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../termd/target/release")
            .join(name);
        if dev.exists() {
            return Some(dev);
        }
    }
    None
}

/// Launches termd detached from the app: it survives the app exiting
/// (crash/update), no console on Windows, stderr to `termd.log`.
fn launch_termd() -> io::Result<()> {
    let bin = termd_bin().ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "promptops-termd binary not found")
    })?;
    let dir = termd_dir();
    std::fs::create_dir_all(&dir)?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("termd.log"))?;
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("serve")
        .arg("--dir")
        .arg(&dir)
        .arg("--orphan-timeout-secs")
        .arg(ORPHAN_TIMEOUT_SECS.to_string())
        .arg("--idle-exit-secs")
        .arg("60")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group: signals to the app's group (Ctrl+C in the dev
        // server terminal, group kill) do not reach it.
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    cmd.spawn()?;
    Ok(())
}

/// Authenticated connection, launching termd if needed.
fn connect() -> io::Result<Client> {
    let dir = termd_dir();
    if let Ok(c) = Client::connect(&dir) {
        return Ok(c);
    }
    launch_termd()?;
    let deadline = Instant::now() + CONNECT_BUDGET;
    loop {
        std::thread::sleep(Duration::from_millis(100));
        match Client::connect(&dir) {
            Ok(c) => return Ok(c),
            Err(e) if Instant::now() >= deadline => return Err(e),
            Err(_) => {}
        }
    }
}

/// Send side, connecting (and launching termd) on first use.
fn tx() -> io::Result<Arc<ClientTx>> {
    let l = link();
    let mut slot = l.tx.lock();
    if let Some(tx) = slot.as_ref() {
        return Ok(tx.clone());
    }
    let client = connect()?;
    eprintln!("[termd] connected (pid {})", client.server_pid);
    let tx = Arc::new(client.tx);
    *slot = Some(tx.clone());
    let events = client.events;
    std::thread::spawn(move || route(events));
    Ok(tx)
}

fn route(events: mpsc::Receiver<Event>) {
    let l = link();
    for ev in events {
        match ev {
            Event::Output { id, data, .. } => {
                let sink = l.sinks.lock().get(&id).cloned();
                if let Some(sink) = sink {
                    sink.output(&data);
                }
            }
            // The snapshot only arrives after an Attach (reattach): it enters as
            // output, preceded by a screen clear so it does not stack on the old one.
            Event::Replay { id, snapshot, .. } => {
                let sink = l.sinks.lock().get(&id).cloned();
                if let Some(sink) = sink {
                    let mut data = b"\x1b[0m\x1b[H\x1b[2J".to_vec();
                    data.extend_from_slice(&snapshot);
                    sink.output(&data);
                }
            }
            Event::Reply(Reply::Exited { id, code }) => {
                let sink = l.sinks.lock().remove(&id);
                if let Some(sink) = sink {
                    sink.exited(code);
                }
            }
            Event::Reply(Reply::List { ptys }) => {
                if let Some(w) = l.list_waiter.lock().take() {
                    let _ = w.send(ptys);
                }
            }
            Event::Reply(reply @ (Reply::Spawned { .. } | Reply::Error { id: Some(_), .. })) => {
                let id = match &reply {
                    Reply::Spawned { id, .. } | Reply::Error { id: Some(id), .. } => id.clone(),
                    _ => unreachable!(),
                };
                match l.pending.lock().remove(&id) {
                    Some(w) => {
                        let _ = w.send(reply);
                    }
                    None => {
                        if let Reply::Error { message, .. } = reply {
                            eprintln!("[termd] {id}: {message}");
                            // Reattach to a PTY termd no longer has (it died
                            // with termd): the session exits instead of hanging.
                            if message == "unknown PTY" {
                                let sink = l.sinks.lock().remove(&id);
                                if let Some(sink) = sink {
                                    sink.exited(None);
                                }
                            }
                        }
                    }
                }
            }
            Event::Reply(_) => {}
            Event::Closed => break,
        }
    }
    // Connection lost (termd restarted or died): reconnect and reattach.
    *l.tx.lock() = None;
    reconnect();
}

fn reconnect() {
    let l = link();
    if l.reconnecting.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        let l = link();
        for attempt in 0..30 {
            std::thread::sleep(Duration::from_millis(if attempt == 0 { 200 } else { 1000 }));
            let Ok(tx) = tx() else { continue };
            let ids: Vec<String> = l.sinks.lock().keys().cloned().collect();
            for id in ids {
                // A vanished PTY (termd really died) replies with an error:
                // the session converges to exit like a provider exit.
                if tx.request(&Request::Attach { id: id.clone() }).is_err() {
                    break;
                }
            }
            l.reconnecting.store(false, Ordering::SeqCst);
            return;
        }
        eprintln!("[termd] unable to reconnect: linked sessions are marked closed");
        let sinks: Vec<_> = l.sinks.lock().drain().map(|(_, s)| s).collect();
        for s in sinks {
            s.exited(None);
        }
        l.reconnecting.store(false, Ordering::SeqCst);
    });
}

fn wait_reply(id: &str, send: impl FnOnce(&ClientTx) -> io::Result<()>) -> Result<Reply, String> {
    let tx = tx().map_err(|e| format!("termd unavailable: {e}"))?;
    let (w, r) = mpsc::channel();
    link().pending.lock().insert(id.to_string(), w);
    if let Err(e) = send(&tx) {
        link().pending.lock().remove(id);
        return Err(e.to_string());
    }
    r.recv_timeout(REPLY_TIMEOUT).map_err(|_| {
        link().pending.lock().remove(id);
        "termd did not reply".to_string()
    })
}

/// Live PTYs in termd (to reattach after an app crash/restart).
pub(crate) fn list() -> Vec<PtyInfo> {
    let Ok(tx) = tx() else { return Vec::new() };
    let (w, r) = mpsc::channel();
    *link().list_waiter.lock() = Some(w);
    if tx.request(&Request::List).is_err() {
        return Vec::new();
    }
    r.recv_timeout(REPLY_TIMEOUT).unwrap_or_default()
}

/// New PTY in termd; output goes to `sink` right away.
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn(
    id: &str,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Vec<(String, String)>,
    cols: u16,
    rows: u16,
    sink: Arc<dyn TermdSink>,
) -> Result<Option<u32>, String> {
    link().sinks.lock().insert(id.to_string(), sink);
    let req = Request::Spawn {
        id: id.to_string(),
        program,
        args,
        cwd,
        env,
        cols,
        rows,
    };
    match wait_reply(id, |tx| tx.request(&req)) {
        Ok(Reply::Spawned { pid, .. }) => Ok(pid),
        Ok(Reply::Error { message, .. }) => {
            link().sinks.lock().remove(id);
            Err(message)
        }
        Ok(_) => Err("unexpected reply from termd".into()),
        Err(e) => {
            link().sinks.lock().remove(id);
            Err(e)
        }
    }
}

/// Reattach to an already live PTY: output first arrives as a snapshot, then live.
pub(crate) fn attach(id: &str, sink: Arc<dyn TermdSink>) -> Result<(), String> {
    let tx = tx().map_err(|e| e.to_string())?;
    link().sinks.lock().insert(id.to_string(), sink);
    tx.request(&Request::Attach { id: id.to_string() })
        .map_err(|e| e.to_string())
}

pub(crate) fn input(id: &str, bytes: &[u8]) -> io::Result<()> {
    tx()?.input(id, bytes)
}

pub(crate) fn resize(id: &str, cols: u16, rows: u16) {
    if let Ok(tx) = tx() {
        let _ = tx.request(&Request::Resize {
            id: id.to_string(),
            cols,
            rows,
        });
    }
}

/// PTY end requested by the app (standby, session close).
pub(crate) fn remove(id: &str) {
    link().sinks.lock().remove(id);
    if let Ok(tx) = tx() {
        let _ = tx.request(&Request::Remove { id: id.to_string() });
    }
}

/// Normal app quit: agents stop (as without termd).
pub(crate) fn shutdown_on_exit() {
    if link().keep_alive_on_exit.load(Ordering::Relaxed) {
        return;
    }
    // No connection = termd unused in this run: nothing to stop (and no
    // process to launch). With a connection, PTYs are stopped even if the
    // toggle was turned off in the meantime.
    let Some(tx) = link().tx.lock().clone() else {
        return;
    };
    for p in list() {
        let _ = tx.request(&Request::Remove { id: p.id });
    }
}

/// Writer to the termd PTY (for SessionPty.writer).
pub(crate) struct TermdWriter(pub String);

impl io::Write for TermdWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        input(&self.0, buf)?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Killer for the termd PTY (for SessionPty.killer): removes the PTY.
#[derive(Debug, Clone)]
pub(crate) struct TermdKiller(pub String);

impl portable_pty::ChildKiller for TermdKiller {
    fn kill(&mut self) -> io::Result<()> {
        remove(&self.0);
        Ok(())
    }
    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        Box::new(self.clone())
    }
}

/// termd → `Read` bridge: for callers written around a blocking reader (the
/// sub-agent pump, as with native SSH). The process exiting in termd closes
/// the channel, so the reader sees EOF.
pub(crate) struct ChannelSink {
    tx: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
}

impl TermdSink for ChannelSink {
    fn output(&self, data: &[u8]) {
        if let Some(tx) = self.tx.lock().as_ref() {
            let _ = tx.send(data.to_vec());
        }
    }
    fn exited(&self, _code: Option<u32>) {
        self.tx.lock().take();
    }
}

pub(crate) struct TermdReader {
    rx: mpsc::Receiver<Vec<u8>>,
    pending: Vec<u8>,
    pos: usize,
}

impl io::Read for TermdReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.pending.len() {
            match self.rx.recv() {
                Ok(chunk) => {
                    self.pending = chunk;
                    self.pos = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let n = buf.len().min(self.pending.len() - self.pos);
        buf[..n].copy_from_slice(&self.pending[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

pub(crate) fn reader_pair() -> (Arc<ChannelSink>, TermdReader) {
    let (tx, rx) = mpsc::channel();
    (
        Arc::new(ChannelSink {
            tx: Mutex::new(Some(tx)),
        }),
        TermdReader {
            rx,
            pending: Vec::new(),
            pos: 0,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn reader_pair_delivers_in_order_then_eof() {
        let (sink, mut reader) = reader_pair();
        sink.output(b"abc");
        sink.output(b"defgh");
        sink.exited(Some(0));
        let mut out = Vec::new();
        reader.read_to_end(&mut out).unwrap();
        assert_eq!(out, b"abcdefgh");
    }
}
