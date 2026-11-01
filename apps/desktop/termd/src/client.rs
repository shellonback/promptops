//! termd client (used by the app and the tests): authenticated connection,
//! commands, incoming events on a channel.
use std::io;
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use interprocess::local_socket::{prelude::*, Stream};
use parking_lot::Mutex;

use crate::paths;
use crate::proto::*;

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Reply(Reply),
    Output {
        id: String,
        offset: u64,
        data: Vec<u8>,
    },
    /// VT snapshot: the `po_vt::vt_replay_payload` payload, already split up.
    Replay {
        id: String,
        end_offset: u64,
        cols: u16,
        rows: u16,
        snapshot: Vec<u8>,
    },
    Closed,
}

pub struct Client {
    pub tx: ClientTx,
    pub events: mpsc::Receiver<Event>,
    pub server_pid: u32,
}

/// Send side of a connection: shareable across threads (the app holds it in an
/// Arc while a router consumes `events`).
pub struct ClientTx {
    stream: Arc<Stream>,
    /// Serializes writes: frames never interleave.
    write_lock: Mutex<()>,
    /// Set by Drop: the reader thread exits and the stream really closes
    /// (otherwise its reference would keep the connection open forever).
    closed: Arc<AtomicBool>,
}

impl Drop for ClientTx {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Relaxed);
    }
}

impl ClientTx {
    pub fn request(&self, req: &Request) -> io::Result<()> {
        let _w = self.write_lock.lock();
        write_frame(&mut &*self.stream, &encode_control(req))
    }

    pub fn input(&self, id: &str, bytes: &[u8]) -> io::Result<()> {
        let _w = self.write_lock.lock();
        write_frame(
            &mut &*self.stream,
            &encode_tagged(KIND_INPUT, id, &[], bytes),
        )
    }
}

const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

impl Client {
    /// Connects and authenticates with the folder's token. Fails if termd is not
    /// running, the token is wrong, or the protocol version does not match.
    pub fn connect(dir: &Path) -> io::Result<Self> {
        let token = paths::read_token(dir)?;
        let conn = Stream::connect(paths::socket_name(dir)?)?;
        conn.set_recv_timeout(Some(Duration::from_millis(250)))?;
        let stream = Arc::new(conn);
        write_frame(
            &mut &*stream,
            &encode_control(&Request::Hello {
                version: PROTOCOL_VERSION,
                token,
            }),
        )?;
        let rstream = stream.clone();
        let closed = Arc::new(AtomicBool::new(false));
        let rclosed = closed.clone();

        let (ev_tx, events) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = FrameReader::default();
            loop {
                match reader.next(&mut &*rstream) {
                    Ok(ReadOutcome::Frame(kind, payload)) => {
                        let Some(ev) = decode_event(kind, &payload) else {
                            continue;
                        };
                        if ev_tx.send(ev).is_err() {
                            return;
                        }
                    }
                    Ok(ReadOutcome::Idle) => {
                        if rclosed.load(Ordering::Relaxed) {
                            return;
                        }
                    }
                    Ok(ReadOutcome::Closed) | Err(_) => {
                        let _ = ev_tx.send(Event::Closed);
                        return;
                    }
                }
            }
        });

        let deadline = Instant::now() + HELLO_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match events.recv_timeout(left) {
                Ok(Event::Reply(Reply::HelloOk { pid, .. })) => {
                    let tx = ClientTx {
                        stream,
                        write_lock: Mutex::new(()),
                        closed,
                    };
                    return Ok(Self {
                        tx,
                        events,
                        server_pid: pid,
                    });
                }
                Ok(Event::Reply(Reply::Error { message, .. })) => {
                    return Err(io::Error::new(io::ErrorKind::Unsupported, message))
                }
                Ok(Event::Closed) => {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "termd closed the connection",
                    ))
                }
                Ok(_) => continue,
                Err(_) => return Err(io::Error::new(io::ErrorKind::TimedOut, "no reply to hello")),
            }
        }
    }

    pub fn request(&self, req: &Request) -> io::Result<()> {
        self.tx.request(req)
    }

    pub fn input(&self, id: &str, bytes: &[u8]) -> io::Result<()> {
        self.tx.input(id, bytes)
    }

    /// First event matching `pred` within `timeout` (others are discarded).
    pub fn wait_for(
        &self,
        timeout: Duration,
        mut pred: impl FnMut(&Event) -> bool,
    ) -> Option<Event> {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.events.recv_timeout(left) {
                Ok(ev) if pred(&ev) => return Some(ev),
                Ok(Event::Closed) => return None,
                Ok(_) => continue,
                Err(_) => return None,
            }
        }
    }
}

fn decode_event(kind: u8, payload: &[u8]) -> Option<Event> {
    match kind {
        KIND_CONTROL => serde_json::from_slice(payload).ok().map(Event::Reply),
        KIND_OUTPUT => {
            let (id, rest) = split_tagged(payload).ok()?;
            let offset = u64::from_le_bytes(rest.get(..8)?.try_into().ok()?);
            Some(Event::Output {
                id,
                offset,
                data: rest[8..].to_vec(),
            })
        }
        KIND_REPLAY => {
            let (id, rest) = split_tagged(payload).ok()?;
            let head = u64::from_le_bytes(rest.get(..8)?.try_into().ok()?);
            let cols = u16::from_le_bytes(rest.get(8..10)?.try_into().ok()?);
            let rows = u16::from_le_bytes(rest.get(10..12)?.try_into().ok()?);
            Some(Event::Replay {
                id,
                end_offset: head & !po_vt::VT_SNAPSHOT_FLAG,
                cols,
                rows,
                snapshot: rest[12..].to_vec(),
            })
        }
        _ => None,
    }
}
