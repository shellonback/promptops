//! Terminal host: the "server" side of session PTYs, separate from the renderer.
//!
//! First step toward a detachable host: the PTY lives in Rust and the renderer
//! is a client that can detach and reattach. Each session PTY has a
//! REPLACEABLE slot for the main window's channel: after a webview reload the
//! old Channel is dead and `session_output_attach` hooks a new one onto the
//! still-running PTY, without a respawn.
//!
//! Each frame carries the absolute offset of its first byte (u64 LE, counted
//! from spawn like `OutputBuffer.total`): the renderer dedupes byte-exactly
//! against the `session_buffer` replay, whenever the attach happens.
//! Frame: [offset u64 LE][data].
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::commands::terminal::PumpState;

/// Main window channel for a PTY. `None` = no client attached (dead channel,
/// waiting for reattach): the flusher keeps draining so the reader does not
/// block and offsets stay aligned.
type Sink = Arc<Mutex<Option<Channel<InvokeResponseBody>>>>;

fn sinks() -> &'static Mutex<HashMap<String, Sink>> {
    static S: OnceLock<Mutex<HashMap<String, Sink>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// Frame [offset u64 LE][data].
pub(crate) fn frame(offset: u64, chunk: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + chunk.len());
    out.extend_from_slice(&offset.to_le_bytes());
    out.extend_from_slice(chunk);
    out
}

/// Starts the flusher for a freshly spawned session PTY. Replaces the slot of
/// any previous PTY of the same session (wake/respawn): its flusher keeps its
/// own Arc and ends at EOF.
pub(crate) fn spawn_session_flusher(
    session_id: &str,
    pump_state: Arc<PumpState>,
    on_output: Channel<InvokeResponseBody>,
) {
    let sink: Sink = Arc::new(Mutex::new(Some(on_output)));
    sinks().lock().insert(session_id.to_string(), sink.clone());
    let fl_session_id = session_id.to_string();
    std::thread::spawn(move || {
        let mut offset: u64 = 0;
        while let Some(chunk) = pump_state.next_chunk() {
            let len = chunk.len() as u64;
            let framed = frame(offset, &chunk);
            offset += len;
            crate::commands::output_watchers::send_session(&fl_session_id, &framed);
            let mut slot = sink.lock();
            if let Some(ch) = slot.as_ref() {
                if ch.send(InvokeResponseBody::Raw(framed)).is_err() {
                    // Webview reloaded or closed: wait for reattach.
                    *slot = None;
                }
            }
            drop(slot);
            std::thread::sleep(crate::commands::terminal::COALESCE);
        }
        pump_state.mark_dead();
        // Remove the slot only if it is still ours (a wake may have replaced it already).
        let mut map = sinks().lock();
        if map
            .get(&fl_session_id)
            .is_some_and(|s| Arc::ptr_eq(s, &sink))
        {
            map.remove(&fl_session_id);
        }
    });
}

/// Reattaches the main window to a session's live PTY (webview reload). The
/// renderer then reads `session_buffer` and dedupes by offset.
/// Returns false if the session has no live PTY (parked: use wake instead).
#[tauri::command]
pub fn session_output_attach(
    window: tauri::WebviewWindow,
    session_id: String,
    on_output: Channel<InvokeResponseBody>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err(
            "only the main window reattaches (child windows use session_output_watch)".into(),
        );
    }
    let sink = sinks().lock().get(&session_id).cloned();
    match sink {
        Some(sink) => {
            *sink.lock() = Some(on_output);
            Ok(true)
        }
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_prefixes_absolute_offset() {
        let f = frame(0x0102_0304_0506_0708, b"hi");
        assert_eq!(&f[..8], &0x0102_0304_0506_0708u64.to_le_bytes());
        assert_eq!(&f[8..], b"hi");
    }
}
