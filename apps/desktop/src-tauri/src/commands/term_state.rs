//! Host-side VT state (phase 2 of the terminal host, see term_host.rs).
//!
//! The emulator and the snapshot live in the `po-vt` crate (shared with termd);
//! what stays here is the setting that picks what to serve the renderer, plus the command.
//!
//! Migration: the `session_buffer` contract is unchanged
//! ([endOffset u64][bytes]); only WHAT the bytes are changes.
pub(crate) use po_vt::{vt_replay_payload, TermState};

/// Renderer replay (and the screen saved on park) from the VT snapshot instead
/// of the raw bytes. The VT state is ALWAYS updated, on or off: the flag only
/// picks what gets served, so it can be toggled live without gaps.
/// User setting (`term_vt_replay_set`, on by default);
/// `PROMPTOPS_VT_REPLAY=0` turns it off regardless (emergency kill switch).
static VT_REPLAY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

fn vt_replay_env_kill() -> bool {
    static KILL: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *KILL.get_or_init(|| std::env::var("PROMPTOPS_VT_REPLAY").is_ok_and(|v| v == "0"))
}

pub(crate) fn vt_replay_enabled() -> bool {
    !vt_replay_env_kill() && VT_REPLAY.load(std::sync::atomic::Ordering::Relaxed)
}

/// "Terminal screen kept by the app" setting (renderer → host).
#[tauri::command]
pub fn term_vt_replay_set(enabled: bool) -> bool {
    VT_REPLAY.store(enabled, std::sync::atomic::Ordering::Relaxed);
    vt_replay_enabled()
}
