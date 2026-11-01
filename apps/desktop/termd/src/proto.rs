//! termd protocol: binary frames over a local socket.
//!
//! Frame: [len u32 LE][kind u8][payload], `len` = 1 + payload, never above
//! `MAX_FRAME`. Commands travel as JSON (CONTROL); PTY output and input as
//! binary, so terminal bytes never go through a text encoding.
use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

/// Protocol version: app and termd must match, otherwise the app falls back to
/// in-process PTYs (never a half-working state).
pub const PROTOCOL_VERSION: u32 = 1;

/// Frame size cap: a peer that declares more is broken or hostile.
pub const MAX_FRAME: usize = 16 * 1024 * 1024;

pub const KIND_CONTROL: u8 = 1;
/// s→c: [idLen u16][id][offset u64][bytes]. Offset = PTY bytes since spawn.
pub const KIND_OUTPUT: u8 = 2;
/// s→c: [idLen u16][id][VT payload from po_vt::vt_replay_payload].
pub const KIND_REPLAY: u8 = 3;
/// c→s: [idLen u16][id][bytes to write to the PTY].
pub const KIND_INPUT: u8 = 4;

/// Client requests.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Hello {
        version: u32,
        token: String,
    },
    /// `env` is the process's FULL environment (termd does not pass on its own):
    /// the app computes it, since it knows accounts, hooks and PATH.
    Spawn {
        id: String,
        program: String,
        args: Vec<String>,
        cwd: Option<String>,
        env: Vec<(String, String)>,
        cols: u16,
        rows: u16,
    },
    Resize {
        id: String,
        cols: u16,
        rows: u16,
    },
    Kill {
        id: String,
    },
    /// Screen snapshot (REPLAY), then live output from that offset.
    Attach {
        id: String,
    },
    Detach {
        id: String,
    },
    /// Removes the PTY from termd (kills it if still alive).
    Remove {
        id: String,
    },
    List,
}

/// Server replies and events.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Reply {
    HelloOk { version: u32, pid: u32 },
    Ok { id: String },
    Spawned { id: String, pid: Option<u32> },
    Exited { id: String, code: Option<u32> },
    List { ptys: Vec<PtyInfo> },
    Error { id: Option<String>, message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PtyInfo {
    pub id: String,
    pub pid: Option<u32>,
    pub alive: bool,
    pub exit_code: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    /// Bytes emitted since spawn.
    pub total: u64,
}

pub fn encode(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.extend_from_slice(&((payload.len() + 1) as u32).to_le_bytes());
    out.push(kind);
    out.extend_from_slice(payload);
    out
}

pub fn encode_control<T: Serialize>(msg: &T) -> Vec<u8> {
    encode(
        KIND_CONTROL,
        &serde_json::to_vec(msg).expect("control serialization"),
    )
}

/// [idLen u16][id][rest]
pub fn encode_tagged(kind: u8, id: &str, head: &[u8], body: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(2 + id.len() + head.len() + body.len());
    payload.extend_from_slice(&(id.len() as u16).to_le_bytes());
    payload.extend_from_slice(id.as_bytes());
    payload.extend_from_slice(head);
    payload.extend_from_slice(body);
    encode(kind, &payload)
}

/// Splits [idLen u16][id][rest] → (id, rest).
pub fn split_tagged(payload: &[u8]) -> io::Result<(String, &[u8])> {
    if payload.len() < 2 {
        return Err(invalid("frame too short"));
    }
    let n = u16::from_le_bytes([payload[0], payload[1]]) as usize;
    if payload.len() < 2 + n {
        return Err(invalid("id past the end of the frame"));
    }
    let id = std::str::from_utf8(&payload[2..2 + n]).map_err(|_| invalid("id is not UTF-8"))?;
    Ok((id.to_string(), &payload[2 + n..]))
}

pub fn invalid(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.to_string())
}

/// Frame reader that survives read timeouts: partial bytes stay in the buffer,
/// so a `recv_timeout` (used to check for stop) never splits a frame.
#[derive(Default)]
pub struct FrameReader {
    buf: Vec<u8>,
}

pub enum ReadOutcome {
    Frame(u8, Vec<u8>),
    /// Timeout without a complete frame: the caller checks its flags and retries.
    Idle,
    Closed,
}

impl FrameReader {
    pub fn next<R: Read>(&mut self, r: &mut R) -> io::Result<ReadOutcome> {
        loop {
            if let Some(frame) = self.take_frame()? {
                return Ok(frame);
            }
            let mut chunk = [0u8; 64 * 1024];
            match r.read(&mut chunk) {
                Ok(0) => return Ok(ReadOutcome::Closed),
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    return Ok(ReadOutcome::Idle)
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::BrokenPipe
                            | io::ErrorKind::ConnectionReset
                            | io::ErrorKind::UnexpectedEof
                    ) =>
                {
                    return Ok(ReadOutcome::Closed)
                }
                Err(e) => return Err(e),
            }
        }
    }

    fn take_frame(&mut self) -> io::Result<Option<ReadOutcome>> {
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_le_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
        if len == 0 || len > MAX_FRAME {
            return Err(invalid("invalid frame length"));
        }
        if self.buf.len() < 4 + len {
            return Ok(None);
        }
        let kind = self.buf[4];
        let payload = self.buf[5..4 + len].to_vec();
        self.buf.drain(..4 + len);
        Ok(Some(ReadOutcome::Frame(kind, payload)))
    }
}

pub fn write_frame<W: Write>(w: &mut W, frame: &[u8]) -> io::Result<()> {
    w.write_all(frame)?;
    w.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_survive_byte_by_byte_delivery() {
        let mut wire = encode_control(&Request::List);
        wire.extend(encode_tagged(KIND_OUTPUT, "a", &7u64.to_le_bytes(), b"hi"));
        struct Drip(Vec<u8>, usize);
        impl Read for Drip {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                if self.1 >= self.0.len() {
                    return Ok(0);
                }
                // One byte at a time: frames still reassemble.
                buf[0] = self.0[self.1];
                self.1 += 1;
                Ok(1)
            }
        }
        let mut r = Drip(wire, 0);
        let mut fr = FrameReader::default();
        let ReadOutcome::Frame(k, p) = fr.next(&mut r).unwrap() else {
            panic!()
        };
        assert_eq!(k, KIND_CONTROL);
        assert_eq!(
            serde_json::from_slice::<Request>(&p).unwrap(),
            Request::List
        );
        let ReadOutcome::Frame(k, p) = fr.next(&mut r).unwrap() else {
            panic!()
        };
        assert_eq!(k, KIND_OUTPUT);
        let (id, rest) = split_tagged(&p).unwrap();
        assert_eq!(id, "a");
        assert_eq!(&rest[..8], &7u64.to_le_bytes());
        assert_eq!(&rest[8..], b"hi");
        assert!(matches!(fr.next(&mut r).unwrap(), ReadOutcome::Closed));
    }

    #[test]
    fn oversized_frame_is_rejected() {
        let mut wire = ((MAX_FRAME + 1) as u32).to_le_bytes().to_vec();
        wire.push(KIND_CONTROL);
        let mut fr = FrameReader::default();
        assert!(fr.next(&mut io::Cursor::new(wire)).is_err());
    }

    #[test]
    fn truncated_tag_is_rejected() {
        assert!(split_tagged(&[5, 0, b'a']).is_err());
    }
}
