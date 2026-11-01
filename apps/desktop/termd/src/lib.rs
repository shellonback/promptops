//! termd: the process that owns the PromptOps agent PTYs.
//!
//! Terminals live here, not in the app: restarting or updating the app does
//! not kill them. The app reattaches and receives the screen snapshot (po-vt)
//! plus the live output from the right offset. See `proto` for the protocol
//! and `server` for the guarantees.
pub mod client;
pub mod paths;
pub mod proto;
pub mod server;
