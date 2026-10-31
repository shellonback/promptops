//! termd server: owns the PTYs and their VT screen, serves clients on the local socket.
//!
//! Guarantees:
//! - no byte goes to a client before a `hello` with the right token;
//! - snapshot + attach under the same PTY lock: live output resumes exactly
//!   from the snapshot offset (no gaps, no duplicates);
//! - a slow client cannot grow memory: past `CLIENT_QUEUE_BYTES` it is
//!   disconnected and gets a fresh snapshot on reattach;
//! - input has a per-PTY queue: a TUI that does not read stdin does not block the others;
//! - child exit is watched by a dedicated thread (ConPTY does not deliver EOF on its own).
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use interprocess::local_socket::{prelude::*, ListenerOptions, Stream};
use parking_lot::Mutex;
use po_vt::TermState;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::paths;
use crate::proto::*;

/// Bytes queued for a single client before it is disconnected.
const CLIENT_QUEUE_BYTES: usize = 32 * 1024 * 1024;
/// Input bytes queued for a single PTY (huge pastes into a stalled TUI).
const PTY_INPUT_QUEUE_BYTES: usize = 8 * 1024 * 1024;
/// Time a connection is given to authenticate.
const AUTH_DEADLINE: Duration = Duration::from_secs(5);
/// Check interval (stop, auth, idle) in blocking threads.
const POLL: Duration = Duration::from_millis(250);
/// After the child exits, the longest wait for the PTY EOF (a background
/// process can keep the slave open forever).
const EXIT_DRAIN: Duration = Duration::from_secs(2);

pub struct ServerConfig {
    pub dir: PathBuf,
    /// Exits on its own when there are no clients and no live PTYs for this long.
    pub idle_exit: Option<Duration>,
    /// No clients for this long while PTYs are still alive = the app crashed and
    /// was never reopened: closes all PTYs and exits. Agents survive an app
    /// crash or restart, but do not run forever without it.
    pub orphan_timeout: Option<Duration>,
}

struct Shared {
    token: String,
    ptys: Mutex<HashMap<String, Arc<Pty>>>,
    clients: AtomicUsize,
    stop: AtomicBool,
    next_client: AtomicU64,
}

struct Client {
    tx: mpsc::Sender<Vec<u8>>,
    queued: AtomicUsize,
    dead: AtomicBool,
}

impl Client {
    /// false = client dead or too slow (must be detached).
    fn send(&self, frame: Vec<u8>) -> bool {
        if self.dead.load(Ordering::Relaxed) {
            return false;
        }
        let len = frame.len();
        if self.queued.fetch_add(len, Ordering::Relaxed) + len > CLIENT_QUEUE_BYTES {
            self.dead.store(true, Ordering::Relaxed);
            return false;
        }
        if self.tx.send(frame).is_err() {
            self.dead.store(true, Ordering::Relaxed);
            return false;
        }
        true
    }
}

struct Pty {
    pid: Option<u32>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    input: mpsc::Sender<Vec<u8>>,
    input_queued: Arc<AtomicUsize>,
    state: Mutex<PtyState>,
}

struct PtyState {
    vt: TermState,
    attached: Vec<Arc<Client>>,
    reader_done: bool,
    exit: Option<Option<u32>>,
    exited_sent: bool,
    cols: u16,
    rows: u16,
}

impl PtyState {
    fn alive(&self) -> bool {
        !self.exited_sent
    }

    /// Exited is sent only once, when the child has exited AND the output has
    /// been drained (or EXIT_DRAIN expired): the last output arrives first.
    fn maybe_emit_exit(&mut self, id: &str, force: bool) {
        if self.exited_sent || self.exit.is_none() || !(self.reader_done || force) {
            return;
        }
        self.exited_sent = true;
        let frame = encode_control(&Reply::Exited {
            id: id.to_string(),
            code: self.exit.flatten(),
        });
        self.attached.retain(|c| c.send(frame.clone()));
    }
}

/// Instance lock: one per folder. Released by the OS even if the process dies
/// (flock on Unix, exclusive sharing mode on Windows).
pub struct InstanceLock {
    _file: std::fs::File,
}

impl InstanceLock {
    pub fn acquire(dir: &std::path::Path) -> io::Result<Self> {
        let path = dir.join("termd.lock");
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            let file = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(false)
                .open(&path)?;
            // SAFETY: fd is valid for the whole lifetime of `file`.
            let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if rc != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "termd already running",
                ));
            }
            Ok(Self { _file: file })
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let file = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(false)
                .share_mode(0)
                .open(&path)
                .map_err(|_| io::Error::new(io::ErrorKind::AddrInUse, "termd already running"))?;
            Ok(Self { _file: file })
        }
    }
}

pub struct Server {
    shared: Arc<Shared>,
    listener: interprocess::local_socket::Listener,
    idle_exit: Option<Duration>,
    orphan_timeout: Option<Duration>,
    dir: PathBuf,
    _lock: InstanceLock,
}

/// Stops a server started in a thread (tests, clean shutdown).
#[derive(Clone)]
pub struct ServerHandle {
    shared: Arc<Shared>,
    dir: PathBuf,
}

impl ServerHandle {
    pub fn stop(&self) {
        self.shared.stop.store(true, Ordering::Relaxed);
        // Unblock the blocking accept with an empty connection.
        if let Ok(name) = paths::socket_name(&self.dir) {
            let _ = Stream::connect(name);
        }
    }
}

impl Server {
    pub fn bind(cfg: ServerConfig) -> io::Result<Self> {
        paths::ensure_private_dir(&cfg.dir)?;
        let lock = InstanceLock::acquire(&cfg.dir)?;
        // New token ONLY after the lock: never break the clients of an
        // already running termd.
        let token = paths::write_new_token(&cfg.dir)?;
        let name = paths::socket_name(&cfg.dir)?;
        // With the lock held, an existing socket is necessarily stale.
        let listener = ListenerOptions::new()
            .name(name)
            .try_overwrite(true)
            .create_sync()?;
        Ok(Self {
            shared: Arc::new(Shared {
                token,
                ptys: Mutex::new(HashMap::new()),
                clients: AtomicUsize::new(0),
                stop: AtomicBool::new(false),
                next_client: AtomicU64::new(1),
            }),
            listener,
            idle_exit: cfg.idle_exit,
            orphan_timeout: cfg.orphan_timeout,
            dir: cfg.dir,
            _lock: lock,
        })
    }

    pub fn handle(&self) -> ServerHandle {
        ServerHandle {
            shared: self.shared.clone(),
            dir: self.dir.clone(),
        }
    }

    /// Blocks until `stop` or the idle exit.
    pub fn run(self) -> io::Result<()> {
        if self.idle_exit.is_some() || self.orphan_timeout.is_some() {
            let handle = self.handle();
            let (idle, orphan) = (self.idle_exit, self.orphan_timeout);
            std::thread::spawn(move || lifetime_watch(handle, idle, orphan));
        }
        for conn in self.listener.incoming() {
            if self.shared.stop.load(Ordering::Relaxed) {
                break;
            }
            let Ok(conn) = conn else { continue };
            let shared = self.shared.clone();
            std::thread::spawn(move || {
                shared.clients.fetch_add(1, Ordering::Relaxed);
                let id = shared.next_client.fetch_add(1, Ordering::Relaxed);
                if let Err(e) = serve_client(&shared, conn) {
                    eprintln!("[termd] client {id}: {e}");
                }
                shared.clients.fetch_sub(1, Ordering::Relaxed);
            });
        }
        // Shutdown: PTYs close with the process (SIGHUP/ClosePseudoConsole).
        Ok(())
    }
}

/// Lifetime without the app: idle (no clients, no PTYs) and orphans
/// (live PTYs but no client for too long).
fn lifetime_watch(handle: ServerHandle, idle: Option<Duration>, orphan: Option<Duration>) {
    let mut no_clients_since: Option<Instant> = None;
    while !handle.shared.stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(200));
        let has_clients = handle.shared.clients.load(Ordering::Relaxed) > 0;
        let live: Vec<Arc<Pty>> = handle
            .shared
            .ptys
            .lock()
            .values()
            .filter(|p| p.state.lock().alive())
            .cloned()
            .collect();
        if has_clients {
            no_clients_since = None;
            continue;
        }
        let since = *no_clients_since.get_or_insert_with(Instant::now);
        let limit = if live.is_empty() { idle } else { orphan };
        if limit.is_some_and(|l| since.elapsed() >= l) {
            if !live.is_empty() {
                eprintln!(
                    "[termd] no app for {:?}: closing {} PTYs and exiting",
                    since.elapsed(),
                    live.len()
                );
                for pty in &live {
                    let _ = pty.killer.lock().kill();
                }
            } else {
                eprintln!("[termd] idle: exiting");
            }
            handle.stop();
            return;
        }
    }
}

fn serve_client(shared: &Arc<Shared>, conn: Stream) -> io::Result<()> {
    conn.set_recv_timeout(Some(POLL))?;
    // `&Stream` is both Read and Write, on Windows too (overlapped I/O):
    // reader and writer share the stream without blocking each other.
    let conn = Arc::new(conn);
    let wconn = conn.clone();
    let (tx, out_rx) = mpsc::channel::<Vec<u8>>();
    let client = Arc::new(Client {
        tx,
        queued: AtomicUsize::new(0),
        dead: AtomicBool::new(false),
    });

    // Writer: drains the client queue onto the socket.
    let wclient = client.clone();
    let writer = std::thread::spawn(move || loop {
        match out_rx.recv_timeout(POLL) {
            Ok(frame) => {
                wclient.queued.fetch_sub(frame.len(), Ordering::Relaxed);
                if write_frame(&mut &*wconn, &frame).is_err() {
                    wclient.dead.store(true, Ordering::Relaxed);
                    return;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if wclient.dead.load(Ordering::Relaxed) {
                    return;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    });

    let result = client_loop(shared, &client, &mut &*conn);
    client.dead.store(true, Ordering::Relaxed);
    // Detach the client from every PTY right away (not on the next output).
    for pty in shared.ptys.lock().values() {
        pty.state
            .lock()
            .attached
            .retain(|c| !Arc::ptr_eq(c, &client));
    }
    drop(client);
    let _ = writer.join();
    result
}

fn client_loop<R: Read>(shared: &Arc<Shared>, client: &Arc<Client>, rx: &mut R) -> io::Result<()> {
    let mut reader = FrameReader::default();
    let started = Instant::now();
    let mut authed = false;
    loop {
        if shared.stop.load(Ordering::Relaxed) || client.dead.load(Ordering::Relaxed) {
            return Ok(());
        }
        match reader.next(rx)? {
            ReadOutcome::Closed => return Ok(()),
            ReadOutcome::Idle => {
                if !authed && started.elapsed() > AUTH_DEADLINE {
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "no authentication"));
                }
            }
            ReadOutcome::Frame(kind, payload) => {
                if !authed {
                    // Mandatory first frame: hello with the right token. With the
                    // wrong token the connection closes WITHOUT a reply.
                    let hello = if kind == KIND_CONTROL {
                        serde_json::from_slice::<Request>(&payload).ok()
                    } else {
                        None
                    };
                    let Some(Request::Hello { version, token }) = hello else {
                        return Err(invalid("first frame is not a hello"));
                    };
                    if !paths::token_eq(&token, &shared.token) {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "invalid token",
                        ));
                    }
                    if version != PROTOCOL_VERSION {
                        client.send(encode_control(&Reply::Error {
                            id: None,
                            message: format!("protocol version {version} not supported (termd: {PROTOCOL_VERSION})"),
                        }));
                        return Ok(());
                    }
                    authed = true;
                    client.send(encode_control(&Reply::HelloOk {
                        version: PROTOCOL_VERSION,
                        pid: std::process::id(),
                    }));
                    continue;
                }
                match kind {
                    KIND_CONTROL => {
                        let req: Request = serde_json::from_slice(&payload)
                            .map_err(|_| invalid("invalid control message"))?;
                        handle_request(shared, client, req);
                    }
                    KIND_INPUT => {
                        let (id, bytes) = split_tagged(&payload)?;
                        handle_input(shared, client, &id, bytes);
                    }
                    _ => return Err(invalid("unknown frame kind")),
                }
            }
        }
    }
}

fn reply_error(client: &Client, id: Option<&str>, message: impl Into<String>) {
    client.send(encode_control(&Reply::Error {
        id: id.map(str::to_string),
        message: message.into(),
    }));
}

fn handle_input(shared: &Shared, client: &Client, id: &str, bytes: &[u8]) {
    let Some(pty) = shared.ptys.lock().get(id).cloned() else {
        return reply_error(client, Some(id), "unknown PTY");
    };
    let len = bytes.len();
    if pty.input_queued.fetch_add(len, Ordering::Relaxed) + len > PTY_INPUT_QUEUE_BYTES {
        pty.input_queued.fetch_sub(len, Ordering::Relaxed);
        return reply_error(
            client,
            Some(id),
            "queued input over the limit: the process is not reading",
        );
    }
    if pty.input.send(bytes.to_vec()).is_err() {
        pty.input_queued.fetch_sub(len, Ordering::Relaxed);
        reply_error(client, Some(id), "PTY closed");
    }
}

fn handle_request(shared: &Arc<Shared>, client: &Arc<Client>, req: Request) {
    match req {
        Request::Hello { .. } => reply_error(client, None, "hello already done"),
        Request::Spawn {
            id,
            program,
            args,
            cwd,
            env,
            cols,
            rows,
        } => {
            match spawn_pty(
                shared,
                client,
                &id,
                &program,
                &args,
                cwd.as_deref(),
                &env,
                cols,
                rows,
            ) {
                Ok(pid) => {
                    client.send(encode_control(&Reply::Spawned { id, pid }));
                }
                Err(e) => reply_error(client, Some(&id), e.to_string()),
            }
        }
        Request::Resize { id, cols, rows } => {
            let Some(pty) = shared.ptys.lock().get(&id).cloned() else {
                return reply_error(client, Some(&id), "unknown PTY");
            };
            if cols == 0 || rows == 0 {
                return reply_error(client, Some(&id), "invalid size");
            }
            if let Some(master) = pty.master.lock().as_ref() {
                if let Err(e) = master.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                }) {
                    return reply_error(client, Some(&id), e.to_string());
                }
            }
            let mut st = pty.state.lock();
            st.vt.resize(cols, rows);
            st.cols = cols;
            st.rows = rows;
        }
        Request::Kill { id } => match shared.ptys.lock().get(&id).cloned() {
            Some(pty) => {
                let _ = pty.killer.lock().kill();
                client.send(encode_control(&Reply::Ok { id }));
            }
            None => reply_error(client, Some(&id), "unknown PTY"),
        },
        Request::Attach { id } => {
            let Some(pty) = shared.ptys.lock().get(&id).cloned() else {
                return reply_error(client, Some(&id), "unknown PTY");
            };
            let mut st = pty.state.lock();
            // Snapshot and subscription under the same lock: the next OUTPUT starts
            // exactly at the offset declared in the snapshot.
            let payload = po_vt::vt_replay_payload(&mut st.vt);
            client.send(encode_tagged(KIND_REPLAY, &id, &[], &payload));
            if !st.attached.iter().any(|c| Arc::ptr_eq(c, client)) {
                st.attached.push(client.clone());
            }
            if st.exited_sent {
                client.send(encode_control(&Reply::Exited {
                    id: id.clone(),
                    code: st.exit.flatten(),
                }));
            }
        }
        Request::Detach { id } => {
            if let Some(pty) = shared.ptys.lock().get(&id).cloned() {
                pty.state
                    .lock()
                    .attached
                    .retain(|c| !Arc::ptr_eq(c, client));
            }
            client.send(encode_control(&Reply::Ok { id }));
        }
        Request::Remove { id } => {
            let pty = shared.ptys.lock().remove(&id);
            if let Some(pty) = pty {
                let _ = pty.killer.lock().kill();
                pty.state.lock().attached.clear();
            }
            client.send(encode_control(&Reply::Ok { id }));
        }
        Request::List => {
            let ptys = shared
                .ptys
                .lock()
                .iter()
                .map(|(id, p)| {
                    let st = p.state.lock();
                    PtyInfo {
                        id: id.clone(),
                        pid: p.pid,
                        alive: st.alive(),
                        exit_code: st.exit.flatten(),
                        cols: st.cols,
                        rows: st.rows,
                        total: st.vt.fed(),
                    }
                })
                .collect();
            client.send(encode_control(&Reply::List { ptys }));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_pty(
    shared: &Arc<Shared>,
    // The spawner receives output from the first byte (no Attach needed
    // afterward: output in between would be lost).
    spawner: &Arc<Client>,
    id: &str,
    program: &str,
    args: &[String],
    cwd: Option<&str>,
    env: &[(String, String)],
    cols: u16,
    rows: u16,
) -> io::Result<Option<u32>> {
    if id.is_empty() || id.len() > 256 {
        return Err(invalid("invalid id"));
    }
    if shared
        .ptys
        .lock()
        .get(id)
        .is_some_and(|p| p.state.lock().alive())
    {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "a live PTY already has this id",
        ));
    }
    // ConPTY fails asynchronously on a missing cwd (error 267):
    // better a clear error right away, on every platform.
    if let Some(dir) = cwd {
        if !std::path::Path::new(dir).is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("folder does not exist: {dir}"),
            ));
        }
    }
    let (cols, rows) = (cols.max(2), rows.max(1));
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    cmd.env_clear();
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
    // Only the child keeps the slave: that is what delivers EOF on Unix.
    drop(pair.slave);
    let pid = child.process_id();
    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>();
    let input_queued = Arc::new(AtomicUsize::new(0));
    let pty = Arc::new(Pty {
        pid,
        master: Mutex::new(Some(pair.master)),
        killer: Mutex::new(killer),
        input: input_tx,
        input_queued: input_queued.clone(),
        state: Mutex::new(PtyState {
            vt: TermState::new(cols, rows),
            attached: vec![spawner.clone()],
            reader_done: false,
            exit: None,
            exited_sent: false,
            cols,
            rows,
        }),
    });
    shared.ptys.lock().insert(id.to_string(), pty.clone());

    // Input: blocking writes outside the client threads.
    std::thread::spawn(move || {
        while let Ok(bytes) = input_rx.recv() {
            input_queued.fetch_sub(bytes.len(), Ordering::Relaxed);
            if writer
                .write_all(&bytes)
                .and_then(|_| writer.flush())
                .is_err()
            {
                return;
            }
        }
    });

    // Output: VT screen + forwarding to attached clients, under the same lock.
    let rpty = pty.clone();
    let rid = id.to_string();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    let mut st = rpty.state.lock();
                    let offset = st.vt.fed();
                    st.vt.feed(chunk);
                    if !st.attached.is_empty() {
                        let frame = encode_tagged(KIND_OUTPUT, &rid, &offset.to_le_bytes(), chunk);
                        st.attached.retain(|c| c.send(frame.clone()));
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let mut st = rpty.state.lock();
        st.reader_done = true;
        st.maybe_emit_exit(&rid, false);
    });

    // Child exit: dedicated thread, then close the master (on Windows this is
    // ClosePseudoConsole, the only way to make the reader finish).
    let wpty = pty;
    let wid = id.to_string();
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        wpty.state.lock().exit = Some(code);
        drop(wpty.master.lock().take());
        let deadline = Instant::now() + EXIT_DRAIN;
        loop {
            {
                let mut st = wpty.state.lock();
                if st.reader_done || Instant::now() >= deadline {
                    st.maybe_emit_exit(&wid, true);
                    return;
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });

    Ok(pid)
}
