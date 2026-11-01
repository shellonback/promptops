//! Sub-agent IPC domain: commands, lifecycle and headless worker runner.
//!
//! A sub-agent is a "child session": a provider CLI process
//! (claude-code-cli, codex, gemini-cli, …) launched inside a PTY next
//! to the parent session. The user talks only to the parent session; the main
//! agent orchestrates the sub-agents.
//!
//! Like `terminal.rs`, each PTY lives in a pool held by a `SubAgentManager`
//! (Arc + parking_lot::Mutex), with a **per-agent output buffer** that is
//! replayed on `subagent:buffer`. Live output and lifecycle events
//! (created/status/destroyed/output/worker-item) are pushed to the renderer via
//! `tauri::ipc::Channel<T>` (a style faithful to terminal.rs's `on_output`)
//! or via `AppHandle::emit`.
//!
//! Covered commands:
//!   - spawn / destroy / list / write / buffer / resize / list-archived /
//!     clear-archived / worker-transcript / worker-send / worker-cancel /
//!     get-suggestions.
//!   - review-* is a separate domain (SubAgentReviewer) → NOT handled here.
//!   - the parts that call an AI model (suggestion-engine, worker
//!     TurnRunner, materializer/context-transfer) are not implemented yet and are
//!     marked `// TODO:`; the command signatures are already in place.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use portable_pty::{
    ChildKiller, CommandBuilder, MasterPty, NativePtySystem, PtyPair, PtySize, PtySystem,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Emitter;
use uuid::Uuid;

// ── Parity constants ───────────────────────────────────────────────
/// `SubAgentManager.MAX_ARCHIVED_PER_PARENT`.
const MAX_ARCHIVED_PER_PARENT: usize = 50;
/// `WorkerAgentRunner.MAX_TRANSCRIPT_ITEMS`.
const MAX_TRANSCRIPT_ITEMS: usize = 500;
/// `WorkerAgentRunner.MAX_BUFFER_BYTES`.
const MAX_WORKER_BUFFER_BYTES: usize = 256 * 1024;
/// Default PTY geometry for a sub-agent (`config: { cols: 120, rows: 24 }`).
const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 24;
/// Bracketed-paste markers — prompt injection pastes the text as a
/// single paste, so inner `\r` characters don't submit it early.
pub(crate) const BPM_START: &str = "\x1b[200~";
pub(crate) const BPM_END: &str = "\x1b[201~";

// ── Domain types (shared with the web UI) ─────────────────────────

/// `SubAgentStatus`.
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubAgentStatus {
    Spawning,
    Running,
    WaitingInput,
    /// Turn open: UserPromptSubmit/tool-use hook, or sustained PTY output
    /// for providers without hooks.
    InProgress,
    /// Alive and idle: turn closed (Stop hook) or PTY silent.
    Idle,
    Completed,
    Error,
    Exited,
}

/// `SubAgentExecutionMode`.
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionMode {
    #[default]
    Interactive,
    Worker,
}

/// `SpawnSubAgentRequest` — the payload of `subagent:spawn` / `subagent:spawn-request`.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSubAgentRequest {
    pub parent_session_id: String,
    pub role: String,
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub provider: Option<String>,
    /// Model override (spawn picker) — launch flag only for
    /// providers whose CLI accepts it (claude --model, codex -m).
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    /// The web UI treats it as a `SubAgentMode` enum; here it stays an opaque string
    /// (mode→config resolution happens on the AI/preamble side).
    #[serde(default)]
    pub mode: Option<String>,
    /// `Partial<SubAgentConfig>` — snake_case keys (reasoning_depth, …).
    #[serde(default)]
    pub custom_config: Option<std::collections::HashMap<String, String>>,
    /// Soft skill (free-form instructions on top of the mode preamble) — sanitized
    /// at spawn.
    #[serde(default)]
    pub soft_skill: Option<crate::commands::subagent_modes::SoftSkill>,
    #[serde(default)]
    pub claude_session_id: Option<String>,
    #[serde(default)]
    pub defer_prompt: Option<bool>,
    #[serde(default)]
    pub eco_level: Option<String>,
    #[serde(default)]
    pub provider_account_id: Option<String>,
    #[serde(default)]
    pub restored: Option<bool>,
    #[serde(default)]
    pub ephemeral: Option<bool>,
    #[serde(default)]
    pub workspace_override: Option<String>,
    #[serde(default)]
    pub execution_mode: Option<ExecutionMode>,
    /// "Goal" runtime (implies worker): the prompt is a GOAL and the
    /// GoalLoopEngine drives the turns autonomously.
    #[serde(default)]
    pub goal_spec: Option<crate::commands::goal_loop::GoalLoopSpec>,
    /// Does the initial prompt credit the prompt counter? `None` = yes (user
    /// spawn). Never deserialized: only the control plane sets it
    /// (`agent_ctl`), which goes through an anti-farming cap.
    #[serde(skip)]
    pub credit_prompt: Option<bool>,
}

/// `SubAgent` — the serialized view returned to the renderer.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAgentView {
    pub id: String,
    pub role: String,
    pub title: String,
    pub parent_session_id: String,
    pub session_id: String,
    pub status: SubAgentStatus,
    pub auto_prompt: String,
    pub user_prompt: String,
    pub provider: String,
    pub icon: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub defer_prompt: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored: Option<bool>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// Custom mode config (the SubAgent `config` field):
    /// needed for the stash round-trip, or restore loses the customizations.
    #[serde(rename = "config", skip_serializing_if = "Option::is_none")]
    pub custom_config: Option<std::collections::HashMap<String, String>>,
    /// Soft skill the agent was born with: stash round-trip + provider switch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub soft_skill: Option<crate::commands::subagent_modes::SoftSkill>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ephemeral: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<ExecutionMode>,
    /// Model the CLI was launched with (spawn picker). It is only the
    /// INITIAL model: a `/model` inside the TUI changes the real one, which the
    /// renderer resolves separately (`session_current_model`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub prompt_pending: bool,
    /// 1-based, populated only by `subagent:list`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot: Option<usize>,
    /// True when the worker runs under the GoalLoopEngine (autonomous turns).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal_driven: Option<bool>,
}

/// `PersistedSubAgent` reduced to what `list-archived` exposes
/// (`ArchivedSubAgentEntry`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedSubAgentEntry {
    pub index: usize,
    pub role: String,
    pub title: String,
    pub user_prompt: String,
    pub icon: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub soft_skill: Option<crate::commands::subagent_modes::SoftSkill>,
    /// Provider is not stored on PersistedSubAgent → default provider.
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_session_id: Option<String>,
    pub archived_at: String,
    pub parent_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    pub can_resume: bool,
}

/// `WorkerTranscriptItem` — one row of the worker chat (no PTY).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerTranscriptItem {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String, // "user" | "assistant" | "tool" | "error" | "notice"
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    pub at: String,
}

// ── Push event payloads (subagent:created/status/destroyed/output/worker-item) ──

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedEvent {
    pub sub_agent: SubAgentView,
    pub parent_session_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    pub sub_agent_id: String,
    pub parent_session_id: String,
    pub status: SubAgentStatus,
    pub prompt_pending: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestroyedEvent {
    pub sub_agent_id: String,
    pub parent_session_id: String,
}

// Sub-agent PTY output travels RAW on the global channel registered by the
// bridge with `subagent_output_channel` (frame: [1B idLen][id][1B parentLen]
// [parent][8B offset u64 LE][chunk]) — no base64 or JSON per chunk. The
// `subagent:output` emit was removed. The offset is that of the chunk's first byte
// in the stream since spawn: same space as `subagent_buffer`'s endOffset,
// used by the bridge for replay↔live dedup.

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerItemEvent {
    pub sub_agent_id: String,
    pub parent_session_id: String,
    pub item: WorkerTranscriptItem,
    pub replace: bool,
}

// ── Resumable stash ────────────────────────────────────────────────────────
// The renderer persists restartable agents per session in localStorage;
// here we push slim snapshots on `subagent:stash-updated` on every roster
// change and receive the stash back with `subagent_restore_stash`.

/// `MAX_STASH_ENTRIES` / string caps.
const MAX_STASH_ENTRIES: usize = 12;
const MAX_STASH_PROMPT: usize = 2000;
const MAX_STASH_TITLE: usize = 200;
const MAX_STASH_ROLE: usize = 100;

fn cap_str(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// Slim entry pushed to the renderer (never the autoPrompt: spawn rebuilds the
/// preamble from the mode; a real resume via claudeSessionId re-injects nothing).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub execution_mode: Option<ExecutionMode>,
    pub role: String,
    pub title: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_prompt: Option<String>,
    pub icon: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<std::collections::HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub soft_skill: Option<crate::commands::subagent_modes::SoftSkill>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// CLI cwd: `claude --resume` is tied to the project dir — on restore
    /// the sub-agent must be reborn there even if the current workspace is another
    /// one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    pub status: String,
}

impl StashEntry {
    fn from_entry(entry: &AgentEntry) -> Self {
        let view = &entry.view;
        let user_prompt = if view.user_prompt.is_empty() {
            None
        } else {
            Some(cap_str(&view.user_prompt, MAX_STASH_PROMPT))
        };
        StashEntry {
            model: view.model.clone(),
            effort: view.effort.clone(),
            execution_mode: view.execution_mode,
            role: cap_str(&view.role, MAX_STASH_ROLE),
            title: cap_str(&view.title, MAX_STASH_TITLE),
            prompt: user_prompt.clone().unwrap_or_default(),
            user_prompt,
            icon: cap_str(&view.icon, MAX_STASH_TITLE),
            mode: view.mode.clone(),
            config: view.custom_config.clone(),
            soft_skill: view.soft_skill.clone(),
            provider: Some(cap_str(&view.provider, MAX_STASH_ROLE)),
            claude_session_id: view.claude_session_id.clone(),
            session_id: Some(view.session_id.clone()),
            workspace_path: entry.cwd.clone(),
            status: "active".into(),
        }
    }
}

/// Payload of `subagent:stash-updated` (StashUpdatePayload).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashUpdatedEvent {
    pub session_id: String,
    pub db_id: Option<String>,
    pub session_name: String,
    pub frozen: bool,
    pub sub_agents: Vec<StashEntry>,
}

/// Pushes the slim snapshot of a parent's live roster to the renderer.
/// Called after created/destroyed and when the claudeSessionId is captured.
pub(crate) fn push_stash_snapshot(
    app: &tauri::AppHandle,
    manager: &Arc<SubAgentManager>,
    parent_session_id: &str,
) {
    use tauri::Manager;
    if manager.push_suppressed() {
        return;
    }
    let sessions = app.state::<Arc<crate::commands::session::SessionManager>>();
    // Parent parked → the park snapshot stays authoritative.
    if sessions.is_standby(parent_session_id) {
        return;
    }
    let session_name = sessions
        .parent_info(parent_session_id)
        .and_then(|i| i.name)
        .unwrap_or_default();
    let db_id = sessions.db_id_of(parent_session_id);
    if db_id.is_none() && session_name.is_empty() {
        return; // no stable key for the renderer
    }
    let mut with_created: Vec<(String, StashEntry)> = {
        let agents = manager.agents.lock();
        agents
            .values()
            .filter(|e| {
                e.view.parent_session_id == parent_session_id
                    && !e.view.ephemeral.unwrap_or(false)
                    // Only active entries: a
                    // dead PTY must not be re-indexed by the next restore.
                    && !matches!(
                        e.view.status,
                        SubAgentStatus::Exited | SubAgentStatus::Error
                    )
            })
            .map(|e| (e.view.created_at.clone(), StashEntry::from_entry(e)))
            .collect()
    };
    with_created.sort_by(|a, b| a.0.cmp(&b.0));
    let sub_agents: Vec<StashEntry> = with_created
        .into_iter()
        .take(MAX_STASH_ENTRIES)
        .map(|(_, e)| e)
        .collect();
    let _ = app.emit(
        "subagent:stash-updated",
        StashUpdatedEvent {
            session_id: parent_session_id.to_string(),
            db_id,
            session_name,
            frozen: false,
            sub_agents,
        },
    );
}

/// `frozen:true` snapshot on park (session standby): must be emitted BEFORE
/// killing the sub-agents, when the standby
/// marker is already set — hence no is_standby guard here. Gotcha:
/// no push with 0 active subs, or a lazy-parked session
/// that was never woken would wipe the previous run's mirror.
pub(crate) fn push_stash_frozen(
    app: &tauri::AppHandle,
    manager: &Arc<SubAgentManager>,
    parent_session_id: &str,
) {
    use tauri::Manager;
    if manager.push_suppressed() {
        return;
    }
    let sessions = app.state::<Arc<crate::commands::session::SessionManager>>();
    let session_name = sessions
        .parent_info(parent_session_id)
        .and_then(|i| i.name)
        .unwrap_or_default();
    let db_id = sessions.db_id_of(parent_session_id);
    if db_id.is_none() && session_name.is_empty() {
        return;
    }
    let mut with_created: Vec<(String, StashEntry)> = {
        let agents = manager.agents.lock();
        agents
            .values()
            .filter(|e| {
                e.view.parent_session_id == parent_session_id
                    && !e.view.ephemeral.unwrap_or(false)
                    && !matches!(
                        e.view.status,
                        SubAgentStatus::Exited | SubAgentStatus::Error
                    )
            })
            .map(|e| (e.view.created_at.clone(), StashEntry::from_entry(e)))
            .collect()
    };
    if with_created.is_empty() {
        return;
    }
    with_created.sort_by(|a, b| a.0.cmp(&b.0));
    let sub_agents: Vec<StashEntry> = with_created
        .into_iter()
        .take(MAX_STASH_ENTRIES)
        .map(|(_, e)| e)
        .collect();
    let _ = app.emit(
        "subagent:stash-updated",
        StashUpdatedEvent {
            session_id: parent_session_id.to_string(),
            db_id,
            session_name,
            frozen: true,
            sub_agents,
        },
    );
}

/// Kills all sub-agents of a session
/// (park, session close). NO stash push here — on park the frozen
/// snapshot has already gone out and the is_standby guard blocks later pushes;
/// on close the renderer removes the envelope.
pub(crate) fn destroy_by_parent(
    app: &tauri::AppHandle,
    manager: &Arc<SubAgentManager>,
    parent_session_id: &str,
    emit_events: bool,
) {
    let ids: Vec<String> = manager
        .parent_index
        .lock()
        .remove(parent_session_id)
        .unwrap_or_default();
    if ids.is_empty() {
        return;
    }
    for id in ids {
        let entry = manager.agents.lock().remove(&id);
        let Some(entry) = entry else { continue };
        if let Some(tailer) = crate::commands::session_tailer::global_tailer() {
            tailer.stop_tailing(&id);
        }
        let ephemeral = entry.view.ephemeral.unwrap_or(false);
        // Explicit kill + drop (master/writer closed → SIGHUP to children).
        kill_entry(entry);
        crate::commands::goal_loop::detach(manager, &id);
        if emit_events && !ephemeral {
            let _ = app.emit(
                "subagent:destroyed",
                DestroyedEvent {
                    sub_agent_id: id,
                    parent_session_id: parent_session_id.to_string(),
                },
            );
        }
    }
    manager.restoring.lock().remove(parent_session_id);
    // Squad with no agents left: the shared context dies with the roster
    // (the store is cleared when the parent's agents are destroyed).
    manager.squad_context.clear(parent_session_id);
}

// ── SquadSummarizer ───────────────────────────────────────────────
// Headless haiku turn (read-only, no session persistence) with the merge
// rules; coalescing per squad: one run in flight, turns arriving in the
// meantime collapse into the next drain.

const SUMMARIZER_MODEL: &str = "haiku";
const SUMMARIZER_TIMEOUT_MS: u64 = 60_000;
/// Headless worker turn watchdog (45 min):
/// without it the turn fell back to turn_runner's DEFAULT_TIMEOUT_MS (2 min)
/// and every non-trivial goal died with "Turn timed out".
const WORKER_TURN_TIMEOUT_MS: u64 = 45 * 60_000;

fn enqueue_squad_summarize(
    app: &tauri::AppHandle,
    manager: &Arc<SubAgentManager>,
    parent_session_id: &str,
    cwd: &str,
    turn_input: String,
    turn_output: String,
) {
    manager
        .squad_sum_queue
        .lock()
        .entry(parent_session_id.to_string())
        .or_default()
        .push((turn_input, turn_output));
    drain_squad_summarize(app, manager, parent_session_id, cwd);
}

fn drain_squad_summarize(
    app: &tauri::AppHandle,
    manager: &Arc<SubAgentManager>,
    parent_session_id: &str,
    cwd: &str,
) {
    use crate::commands::squad_context as sq;
    if manager
        .squad_sum_inflight
        .lock()
        .contains(parent_session_id)
    {
        return;
    }
    let pending = {
        let mut queue = manager.squad_sum_queue.lock();
        match queue.get_mut(parent_session_id) {
            Some(list) if !list.is_empty() => std::mem::take(list),
            _ => return,
        }
    };
    let Some(runner) = crate::commands::turn_runner::global_runner().cloned() else {
        return;
    };

    // Coalesce the queued turns into a single call.
    let turn_input = pending
        .iter()
        .map(|(i, _)| i.as_str())
        .collect::<Vec<_>>()
        .join("\n---\n");
    let turn_output = pending
        .iter()
        .map(|(_, o)| o.as_str())
        .collect::<Vec<_>>()
        .join("\n---\n");

    manager
        .squad_sum_inflight
        .lock()
        .insert(parent_session_id.to_string());

    static RUN_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = RUN_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let run_id = format!("squadsum-{parent_session_id}-{n}");

    let prompt = sq::build_summarizer_user_prompt(
        &manager.squad_context.get(parent_session_id),
        &turn_input,
        &turn_output,
    );
    let opts = crate::commands::turn_runner::TurnSpawnOptions {
        run_id,
        provider: "claude-code-cli".into(),
        cwd: cwd.to_string(),
        prompt,
        model: Some(SUMMARIZER_MODEL.into()),
        // Active account (AI Accounts): same login as new sessions.
        env: crate::commands::provider_account::utility_account_vars("claude-code-cli")
            .into_iter()
            .collect(),
        system_prompt: Some(sq::SUMMARIZER_SYSTEM_PROMPT.into()),
        permission_mode: Some("plan".into()),
        no_session_persistence: true,
        timeout_ms: Some(SUMMARIZER_TIMEOUT_MS),
        ..Default::default()
    };

    let raw = Arc::new(Mutex::new(String::new()));
    let raw_ev = Arc::clone(&raw);
    let app_ex = app.clone();
    let mgr_ex = Arc::clone(manager);
    let parent_ex = parent_session_id.to_string();
    let cwd_ex = cwd.to_string();

    let spawned = runner.spawn(
        opts,
        move |event| {
            if let crate::commands::turn_runner::TurnEvent::AssistantText { delta, .. } = event {
                raw_ev.lock().push_str(&delta);
            }
        },
        move |result| {
            mgr_ex.squad_sum_inflight.lock().remove(&parent_ex);
            if turn_exit_message(&result).is_none() {
                let upserts = sq::parse_summarizer_response(&raw.lock());
                if !upserts.is_empty() {
                    let slots = mgr_ex.squad_context.apply_upserts(&parent_ex, &upserts);
                    let _ = app_ex.emit(
                        "squad-context:updated",
                        serde_json::json!({ "parentSessionId": parent_ex, "slots": slots }),
                    );
                    eprintln!(
                        "[SquadSummarizer] {} slot(s) updated for squad {parent_ex}",
                        upserts.len()
                    );
                }
            } else {
                eprintln!("[SquadSummarizer] summarize failed — slots unchanged");
            }
            // More turns may have arrived while we were running.
            drain_squad_summarize(&app_ex, &mgr_ex, &parent_ex, &cwd_ex);
        },
    );
    if let Err(err) = spawned {
        manager.squad_sum_inflight.lock().remove(parent_session_id);
        eprintln!("[SquadSummarizer] spawn failed: {err}");
    }
}

/// SILENT teardown of all sub-agents (profile switch): no events
/// or pushes — the renderer reloads the roster via `session-profile:changed` and
/// the localStorage mirror must stay intact (suppress active from the caller).
pub(crate) fn teardown_all(manager: &Arc<SubAgentManager>) {
    let ids: Vec<String> = manager.agents.lock().keys().cloned().collect();
    for id in &ids {
        if let Some(tailer) = crate::commands::session_tailer::global_tailer() {
            tailer.stop_tailing(id);
        }
    }
    for (_, entry) in manager.agents.lock().drain() {
        kill_entry(entry);
    }
    for id in &ids {
        crate::commands::goal_loop::detach(manager, id);
    }
    manager.parent_index.lock().clear();
    manager.parents.lock().clear();
    manager.restoring.lock().clear();
    manager.squad_context.clear_all();
}

// ── Internal state ────────────────────────────────────────────────────

/// An interactive (PTY-backed) sub-agent. Holds the pair, the writer and the
/// output buffer replayed on `subagent:buffer`.
/// Sub-agent PTY: local (portable-pty; also the "command" remote
/// transport, where the local PTY runs `ssh …`) or a native SSH channel
/// (`ssh://<connId>/…` sessions).
enum AgentPty {
    Local(PtyPair),
    Remote {
        ctl: crate::commands::remote::RemoteShellCtl,
        size: Mutex<(u16, u16)>,
    },
    /// PTY owned by termd (key = conversation id).
    Termd {
        key: String,
        size: Mutex<(u16, u16)>,
    },
}

impl AgentPty {
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        match self {
            AgentPty::Local(pair) => pair
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string()),
            AgentPty::Remote { ctl, size } => {
                ctl.resize(cols, rows);
                *size.lock() = (cols, rows);
                Ok(())
            }
            AgentPty::Termd { key, size } => {
                crate::commands::termd_link::resize(key, cols, rows);
                *size.lock() = (cols, rows);
                Ok(())
            }
        }
    }

    fn size(&self) -> Option<(u16, u16)> {
        match self {
            AgentPty::Local(pair) => pair.master.get_size().ok().map(|s| (s.cols, s.rows)),
            AgentPty::Remote { size, .. } | AgentPty::Termd { size, .. } => Some(*size.lock()),
        }
    }

    fn raw_mode(&self) -> Option<bool> {
        match self {
            AgentPty::Local(pair) => slave_in_raw_mode(pair.master.as_ref()),
            AgentPty::Remote { .. } | AgentPty::Termd { .. } => None,
        }
    }
}

/// Sub-agent remote transport, inherited from the parent session's cwd.
enum SubRemote {
    /// `ssh://<connId>/<path>` — saved connection (russh).
    Ssh { conn_id: String, path: String },
    /// `cmd://<path>` — the user's connect command in the local PTY.
    Cmd { command: String, path: String },
}

struct InteractiveAgent {
    pty: AgentPty,
    /// PTY writer behind its own mutex: writes happen OUTSIDE
    /// the `agents` lock, so a blocked write (full tty queue, TUI not
    /// reading stdin) does not wedge the output pump or the other commands.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// Cumulative PTY output buffer (replay on buffer/resize-less),
    /// capped at SUB_BUFFER_CAP (it used to grow without limit).
    buffer: Vec<u8>,
    /// Total bytes seen since PTY spawn = endOffset of the replay contract,
    /// identical to the sessions' `OutputBuffer.total`. Used by the bridge to
    /// dedup the replay against the live stream byte-precisely: without it, every
    /// attach/re-attach of a pane can lose or duplicate chunks that arrive between
    /// the snapshot and the subscription.
    buffer_total: usize,
    /// Host-side emulated screen (term_state): its own mutex, so parsing
    /// does not happen under the global `agents` lock.
    vt: Arc<Mutex<crate::commands::term_state::TermState>>,
    /// Size requested during startup but too small for the TUI to draw:
    /// applied as soon as the agent leaves 'spawning' (see resize_agent).
    deferred_size: Option<(u16, u16)>,
    /// Child killer (clone_killer): explicit kill on destroy for
    /// providers that ignore the SIGHUP from the master close; the reap (wait)
    /// is done by the reader thread at EOF.
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// Start of the backup-Enter window: the spawn, then the moment the native
    /// injection submitted (and credited) the initial prompt. The renderer
    /// sends a "backup" Enter a few seconds after every spawn; that lone `\r`
    /// must not credit a prompt (a second time, or at all on a restore).
    auto_submitted_at_ms: Option<u64>,
}

/// After an auto-submitted prompt, a lone Enter within this window (with no
/// typed text in between) is the renderer's backup Enter, not a new prompt.
const BACKUP_ENTER_WINDOW_MS: u64 = 10_000;

/// Whether a write to a sub-agent counts as a submitted prompt.
///
/// A lone Enter does not count while the agent is still spawning (the
/// injection owns the input and credits the prompt itself) or right after an
/// auto-submitted prompt (the renderer's backup Enter): counting it gave every
/// composer spawn two credits.
fn write_counts_as_prompt(
    data: &str,
    status: &SubAgentStatus,
    auto_submitted_at_ms: Option<u64>,
    now_ms: u64,
) -> bool {
    let has_enter = data.contains('\r');
    let waiting = matches!(status, SubAgentStatus::WaitingInput);
    let is_dialog_answer =
        !has_enter && waiting && crate::commands::session::is_dialog_answer_input(data);
    if !(has_enter || is_dialog_answer) {
        return false;
    }
    // A dialog answer (waiting_input) always counts, as before.
    if data == "\r" && !waiting {
        if matches!(status, SubAgentStatus::Spawning) {
            return false;
        }
        if auto_submitted_at_ms.is_some_and(|t| now_ms.saturating_sub(t) <= BACKUP_ENTER_WINDOW_MS)
        {
            return false;
        }
    }
    true
}

/// Typed text (not just terminal reports such as focus in/out, which start
/// with ESC) ends the backup-Enter window: the next Enter is the user's.
fn is_typed_text(data: &str) -> bool {
    data.starts_with(BPM_START)
        || (!data.starts_with('\u{1b}') && data.chars().any(|c| !c.is_control()))
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Replay buffer cap per sub-agent (same limit as main sessions).
const SUB_BUFFER_CAP: usize = 512 * 1024;

fn push_capped(buf: &mut Vec<u8>, chunk: &[u8]) {
    buf.extend_from_slice(chunk);
    if buf.len() > SUB_BUFFER_CAP {
        let cut = buf.len() - SUB_BUFFER_CAP;
        buf.drain(..cut);
    }
}

/// Runtime teardown of an entry: explicit kill of the interactive child
/// before the drop (which closes master/writer → SIGHUP to the leader's children).
fn kill_entry(entry: AgentEntry) {
    if let Some(inter) = &entry.interactive {
        let _ = inter.killer.lock().kill();
    }
    drop(entry);
}

/// A worker sub-agent (headless, no PTY): holds the structured transcript
/// and a text buffer.
struct WorkerAgent {
    transcript: Vec<WorkerTranscriptItem>,
    buffer: String,
    input_line: String,
    /// True when a turn is already in flight (sendWorkerMessage → false if busy).
    turn_in_flight: bool,
    /// Provider/cwd for spawning the headless turn (TurnRunner).
    provider: String,
    cwd: String,
    /// Vendor conversation id captured from provider_session_init: later
    /// turns resume the same thread.
    provider_session_id: Option<String>,
    /// runId of the in-flight turn (for cancel).
    current_run_id: Option<String>,
    /// Turn options from the mode: native system
    /// prompt, effort, permission-mode, tool gating.
    turn_system_prompt: Option<String>,
    turn_effort: Option<String>,
    turn_permission_mode: Option<String>,
    turn_disallowed: Vec<String>,
    /// Extra env for every turn (provider account resolved at spawn).
    turn_env: std::collections::HashMap<String, String>,
    /// Model override from the spawn picker.
    model: Option<String>,
    /// Accumulators of the current turn, for the squad summarizer
    /// (enqueued to the squad summarizer when the turn completes).
    current_turn_input: String,
    current_turn_output: String,
}

/// The sub-agent meta (the counterpart of the web UI's `SubAgent` on the manager side).
struct AgentEntry {
    view: SubAgentView,
    /// Present only for interactive agents.
    interactive: Option<InteractiveAgent>,
    /// Present only for workers.
    worker: Option<WorkerAgent>,
    /// Directory the CLI runs in: used to resolve the provider's session log
    /// (claude transcript), which is indexed by cwd.
    cwd: Option<String>,
    provider_account_id: Option<Option<String>>,
}

impl AgentEntry {
    fn is_worker(&self) -> bool {
        self.worker.is_some()
    }
}

/// Per-sub-agent state of the activity monitor (lives in the monitor thread).
#[derive(Default)]
pub struct SubActivity {
    pub total: usize,
    pub last_change_ms: u64,
    pub active_ticks: u8,
}

/// Snapshot of a parent session (workspace + provider + account) needed
/// for spawn. The caller provides or registers it. // TODO: wire to the native SessionManager.
#[derive(Clone, Default)]
struct ParentContext {
    workspace_path: Option<String>,
    provider: Option<String>,
    provider_account_id: Option<String>,
    session_name: Option<String>,
    /// Parent autoApprove: non-Claude subs inherit the native bypass flag
    /// at spawn (for Claude, tailer + hooks take care of it).
    auto_approve: bool,
}

/// Prompt credit callback towards the SessionManager: (parentSessionId, n).
pub type CreditPromptFn = Arc<dyn Fn(&str, u64) + Send + Sync>;

#[derive(Default)]
pub struct SubAgentManager {
    /// subAgentId -> entry.
    agents: Mutex<HashMap<String, AgentEntry>>,
    /// subAgentId -> (provider family -> conversation id) of the providers already
    /// used by that sub-agent: switching back to a provider resumes
    /// ITS conversation (UX audit 10/2026). In memory only.
    provider_conversations: Mutex<HashMap<String, HashMap<String, String>>>,
    /// parentSessionId -> set of subAgentId (replica of `parentIndex`).
    parent_index: Mutex<HashMap<String, Vec<String>>>,
    /// parentSessionId -> archived list (replica of `archivedSubAgents`).
    archived: Mutex<HashMap<String, Vec<ArchivedSubAgentEntry>>>,
    /// Known parent context (workspace/provider) for spawn.
    parents: Mutex<HashMap<String, ParentContext>>,
    /// Prompt credit to the parent (wired in lib.rs → SessionManager). The
    /// sub-agent PTY is local, so the credit is explicit.
    credit_fn: Mutex<Option<CreditPromptFn>>,
    /// Parents with a restore-stash in flight (guard against double invoke).
    restoring: Mutex<std::collections::HashSet<String>>,
    /// Profile-switch teardown guard: bursts
    /// of destroys must not wipe the renderer's localStorage mirror.
    suppress_push: std::sync::atomic::AtomicBool,
    /// Shared squad context per parent (SquadContextStore).
    squad_context: crate::commands::squad_context::SquadContextStore,
    /// SquadSummarizer: coalescing per squad — one summarize in flight, at most
    /// one batch queued (rapid turns collapse into a single call).
    squad_sum_inflight: Mutex<std::collections::HashSet<String>>,
    squad_sum_queue: Mutex<HashMap<String, Vec<(String, String)>>>,
    /// Global RAW channel for the PTY output of ALL sub-agents (registered
    /// by the bridge at boot, REPLACED on every webview reload). None/dead →
    /// chunks are dropped, the subagent_buffer replay covers the gap.
    output_channel: Mutex<Option<Channel<InvokeResponseBody>>>,
    /// Autonomy loop of goal-driven workers (GoalLoopEngine).
    pub(crate) goal_loops: crate::commands::goal_loop::GoalLoopStore,
}

/// `title` if it is not taken, otherwise the first free "title N" from 2 up.
fn free_title(taken: &std::collections::HashSet<&str>, title: &str) -> String {
    if !taken.contains(title) {
        return title.to_string();
    }
    (2..)
        .map(|n| format!("{title} {n}"))
        .find(|candidate| !taken.contains(candidate.as_str()))
        .expect("an unused number always exists")
}

impl SubAgentManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// All non-ephemeral sub-agents, with their parent.
    pub fn all_non_ephemeral(&self) -> Vec<SubAgentView> {
        let agents = self.agents.lock();
        let mut out: Vec<SubAgentView> = agents
            .values()
            .filter(|e| !e.view.ephemeral.unwrap_or(false))
            .map(|e| e.view.clone())
            .collect();
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        out
    }

    /// Number of existing sub-agent panes of a parent, ANY status
    /// the restore gate must
    /// also count Completed/Exited ones still on screen, or it would duplicate.
    pub fn live_pane_count(&self, parent_session_id: &str) -> usize {
        let ids = self.child_ids(parent_session_id);
        let agents = self.agents.lock();
        ids.iter()
            .filter_map(|id| agents.get(id))
            .filter(|e| !e.view.ephemeral.unwrap_or(false))
            .count()
    }

    /// The parent's sub-agent ids, copied with `parent_index` released.
    ///
    /// Lock order: code that needs both locks takes `agents` first and
    /// `parent_index` second (destroy, list). Holding `parent_index` while
    /// waiting for `agents` deadlocked against them, freezing every agent
    /// pane and the commands that touch them.
    fn child_ids(&self, parent_session_id: &str) -> Vec<String> {
        self.parent_index
            .lock()
            .get(parent_session_id)
            .cloned()
            .unwrap_or_default()
    }

    /// suppressStashPush: on during the profile-switch teardown.
    pub fn set_suppress_push(&self, on: bool) {
        self.suppress_push
            .store(on, std::sync::atomic::Ordering::SeqCst);
    }

    fn push_suppressed(&self) -> bool {
        self.suppress_push.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Number of live sub-agents of a parent (spawn cap).
    pub fn alive_count(&self, parent_session_id: &str) -> usize {
        let ids = self.child_ids(parent_session_id);
        let agents = self.agents.lock();
        ids.iter()
            .filter_map(|id| agents.get(id))
            .filter(|e| !e.view.ephemeral.unwrap_or(false))
            .count()
    }

    /// Registers the prompt credit callback (called once at setup).
    pub fn set_credit_fn(&self, credit: CreditPromptFn) {
        *self.credit_fn.lock() = Some(credit);
    }

    /// (provider, cwd, conversation id) of a sub-agent's child session.
    /// Sub sessions are NOT in the SessionManager: without this lookup
    /// the `session_current_model` command would never find a sub-agent and the
    /// badge would stay stuck on the spawn model.
    pub(crate) fn model_lookup(
        &self,
        session_id: &str,
    ) -> Option<(
        String,
        Option<String>,
        Option<String>,
        Option<Option<String>>,
    )> {
        self.agents
            .lock()
            .values()
            .find(|e| e.view.session_id == session_id)
            .map(|e| {
                (
                    e.view.provider.clone(),
                    e.cwd.clone(),
                    e.view.claude_session_id.clone(),
                    e.provider_account_id.clone(),
                )
            })
    }

    /// Parent session of a live sub-agent (for shared crediting).
    /// Attaches the claudeSessionId (from the SessionStart hook) to the sub-agent whose
    /// child session matches; returns the parent for the stash push.
    pub fn set_claude_session_id(&self, session_id: &str, sid: &str) -> Option<String> {
        if !crate::commands::session::is_safe_session_id(sid) {
            return None;
        }
        crate::commands::session_model::forget(session_id);
        let mut agents = self.agents.lock();
        for entry in agents.values_mut() {
            if entry.view.session_id == session_id {
                entry.view.claude_session_id = Some(sid.to_string());
                return Some(entry.view.parent_session_id.clone());
            }
        }
        None
    }

    pub fn parent_of(&self, sub_agent_id: &str) -> Option<String> {
        self.agents
            .lock()
            .get(sub_agent_id)
            .map(|e| e.view.parent_session_id.clone())
    }

    /// Write to a sub-agent's PTY (renderer + remote access data plane).
    ///
    /// With `count_prompt=true` it counts prompts the same way a main session
    /// does: Enter always counts, click/digit
    /// count with the dialog open (waiting_input); the credit goes to the parent.
    /// `count_prompt=false` is for injections already credited elsewhere
    /// (auto-approve tailer, overlay interaction).
    pub fn write_to(
        &self,
        sub_agent_id: &str,
        data: &str,
        count_prompt: bool,
    ) -> Result<(), String> {
        let (writer, credit_target) = {
            let mut agents = self.agents.lock();
            let entry = agents
                .get_mut(sub_agent_id)
                .ok_or_else(|| format!("Agent not found: {sub_agent_id}"))?;

            let auto_submitted_at = entry
                .interactive
                .as_ref()
                .and_then(|i| i.auto_submitted_at_ms);
            let should_count = count_prompt
                && write_counts_as_prompt(data, &entry.view.status, auto_submitted_at, epoch_ms());
            if let Some(inter) = entry.interactive.as_mut() {
                if is_typed_text(data) {
                    inter.auto_submitted_at_ms = None;
                }
            }

            let writer = entry.interactive.as_ref().map(|i| i.writer.clone());
            let credit = if should_count {
                Some(entry.view.parent_session_id.clone())
            } else {
                None
            };
            (writer, credit)
        };
        // PTY write outside the agents lock: if the child doesn't drain stdin,
        // write_all can block, and holding the lock it would also block the
        // output pump (deadlock: child stuck in write → never reads again).
        if let Some(writer) = writer {
            let mut w = writer.lock();
            w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
            let _ = w.flush();
        }
        // Credit outside the agents lock (lock order: subagent → session).
        if let Some(parent) = credit_target {
            if let Some(credit) = self.credit_fn.lock().clone() {
                credit(&parent, 1);
            }
        }
        Ok(())
    }

    /// Replay buffer of a sub-agent.
    pub fn buffer_of(&self, sub_agent_id: &str) -> String {
        let agents = self.agents.lock();
        agents
            .get(sub_agent_id)
            .and_then(|e| e.interactive.as_ref())
            .map(|i| String::from_utf8_lossy(&i.buffer).to_string())
            .unwrap_or_default()
    }

    // ── Control plane (`promptops ctl`, see agent_ctl.rs) ───────────────

    /// Non-ephemeral sub-agents of a parent, in creation order.
    pub(crate) fn ctl_views(&self, parent_session_id: &str) -> Vec<SubAgentView> {
        let mut views: Vec<SubAgentView> = self
            .agents
            .lock()
            .values()
            .filter(|e| e.view.parent_session_id == parent_session_id)
            .filter(|e| !e.view.ephemeral.unwrap_or(false))
            .map(|e| e.view.clone())
            .collect();
        views.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        views
    }

    pub(crate) fn ctl_view(&self, sub_agent_id: &str) -> Option<SubAgentView> {
        self.agents.lock().get(sub_agent_id).map(|e| e.view.clone())
    }

    /// Total bytes emitted by the PTY: growth is the activity signal for
    /// providers without hooks.
    pub(crate) fn ctl_buffer_total(&self, sub_agent_id: &str) -> usize {
        self.agents
            .lock()
            .get(sub_agent_id)
            .and_then(|e| e.interactive.as_ref())
            .map(|i| i.buffer_total)
            .unwrap_or(0)
    }

    /// Claude hooks of a child session → sub-agent state. They used to be
    /// discarded along with the noise-leak and an interactive agent stayed "running"
    /// forever after the first turn (no Stop reached the view).
    pub fn hook_status(
        &self,
        app: &tauri::AppHandle,
        session_id: &str,
        event_name: &str,
        event: &serde_json::Value,
    ) {
        let next = match event_name {
            "UserPromptSubmit" | "PreToolUse" | "PostToolUse" => SubAgentStatus::InProgress,
            "Stop" => SubAgentStatus::Idle,
            "Notification" => match event
                .get("notification_type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
            {
                // Parity with the main sessions (hook.rs): human input needed.
                "permission_prompt" | "idle_prompt" | "elicitation_dialog" => {
                    SubAgentStatus::WaitingInput
                }
                _ => return,
            },
            _ => return,
        };
        let mut agents = self.agents.lock();
        let Some((id, status)) = agents
            .iter()
            .find(|(_, e)| e.interactive.is_some() && e.view.session_id == session_id)
            .map(|(id, e)| (id.clone(), e.view.status))
        else {
            return;
        };
        // Boot (veil) and terminal outcomes are not touched.
        if status == next
            || matches!(
                status,
                SubAgentStatus::Spawning
                    | SubAgentStatus::Completed
                    | SubAgentStatus::Error
                    | SubAgentStatus::Exited
            )
        {
            return;
        }
        update_status(app, &mut agents, &id, next);
    }

    /// User input on a waiting sub-agent (Enter or a dialog answer)
    /// → turn open. Parity with session.rs's `was_waiting` branch.
    pub fn note_user_input(&self, app: &tauri::AppHandle, sub_agent_id: &str, data: &str) {
        let mut agents = self.agents.lock();
        let Some(entry) = agents.get(sub_agent_id) else {
            return;
        };
        if entry.view.status != SubAgentStatus::WaitingInput {
            return;
        }
        let answered =
            data.contains('\r') || crate::commands::session::is_dialog_answer_input(data);
        if answered {
            update_status(app, &mut agents, sub_agent_id, SubAgentStatus::InProgress);
        }
    }

    /// Activity monitor tick (see `session::start_activity_monitor`):
    /// same rule as the main sessions applied to interactive agents.
    pub fn activity_tick(
        &self,
        app: &tauri::AppHandle,
        now_ms: u64,
        track: &mut HashMap<String, SubActivity>,
    ) {
        let mut agents = self.agents.lock();
        track.retain(|id, _| agents.contains_key(id));
        let mut changes: Vec<(String, SubAgentStatus)> = Vec::new();
        for (id, e) in agents.iter() {
            let Some(inter) = e.interactive.as_ref() else {
                continue;
            };
            let current = match e.view.status {
                SubAgentStatus::Running => "running",
                SubAgentStatus::Idle => "idle",
                SubAgentStatus::InProgress => "in_progress",
                _ => continue,
            };
            let t = track.entry(id.clone()).or_insert_with(|| SubActivity {
                total: inter.buffer_total,
                last_change_ms: now_ms,
                active_ticks: 0,
            });
            let active = inter.buffer_total != t.total;
            if active {
                t.total = inter.buffer_total;
                t.last_change_ms = now_ms;
                t.active_ticks = t.active_ticks.saturating_add(1);
            } else {
                t.active_ticks = 0;
            }
            let quiet = now_ms.saturating_sub(t.last_change_ms)
                >= crate::commands::session::ACTIVITY_QUIET_MS;
            let next = crate::commands::session::next_activity_status(
                current,
                &e.view.provider,
                active,
                t.active_ticks,
                quiet,
            );
            match next {
                Some("idle") => changes.push((id.clone(), SubAgentStatus::Idle)),
                Some("in_progress") => changes.push((id.clone(), SubAgentStatus::InProgress)),
                _ => {}
            }
        }
        for (id, status) in changes {
            update_status(app, &mut agents, &id, status);
        }
    }

    /// Raw buffer + PTY size, for the vt100 rendering of `ctl read`.
    pub(crate) fn ctl_screen(&self, sub_agent_id: &str) -> Option<(Vec<u8>, u16, u16)> {
        let agents = self.agents.lock();
        let inter = agents.get(sub_agent_id)?.interactive.as_ref()?;
        let size = inter.pty.size();
        Some((
            inter.buffer.clone(),
            size.map(|s| s.0).unwrap_or(120),
            size.map(|s| s.1).unwrap_or(40),
        ))
    }

    /// Prompt to an already-live sub-agent: BPM-paste → enterDelay → Enter, like
    /// `inject_prompt` but without waiting for boot. Does NOT credit the prompt
    /// counter: the sender is an agent, not the user (anti-farming).
    /// True if writing to the PTY amounts to running commands: raw shell, or
    /// dead provider TUI with the shell prompt visible.
    pub(crate) fn ctl_is_raw_shell(&self, sub_agent_id: &str) -> bool {
        let agents = self.agents.lock();
        let Some(entry) = agents.get(sub_agent_id) else {
            return false;
        };
        entry.view.provider == "generic-shell"
            || entry
                .interactive
                .as_ref()
                .is_some_and(|inter| shell_prompt_visible(&inter.buffer))
    }

    /// `count`: the Enter credits the prompt to the parent (decided by the control
    /// plane, which applies the anti-farming cap).
    pub(crate) fn ctl_prompt(
        &self,
        app: &tauri::AppHandle,
        sub_agent_id: &str,
        prompt: &str,
        count: bool,
    ) -> Result<(), String> {
        let provider = {
            let agents = self.agents.lock();
            let entry = agents
                .get(sub_agent_id)
                .ok_or_else(|| format!("Agent not found: {sub_agent_id}"))?;
            let inter = entry
                .interactive
                .as_ref()
                .ok_or("Worker agents cannot be prompted through ctl")?;
            // Same guard as spawn: with the TUI dead the paste would be
            // EXECUTED line by line by the shell.
            if entry.view.provider != "generic-shell" && shell_prompt_visible(&inter.buffer) {
                return Err("Provider TUI is not running (shell prompt visible)".into());
            }
            entry.view.provider.clone()
        };
        let profile = crate::commands::tui_injection::injection_profile(&provider);
        self.write_to(
            sub_agent_id,
            &format!("{BPM_START}{prompt}{BPM_END}"),
            false,
        )?;
        std::thread::sleep(std::time::Duration::from_millis(profile.enter_delay_ms));
        self.write_to(sub_agent_id, "\r", count)?;
        let mut agents = self.agents.lock();
        update_status(app, &mut agents, sub_agent_id, SubAgentStatus::InProgress);
        Ok(())
    }

    /// True if the parent has live sub-agents (spawning/running/waiting_input):
    /// used by auto-standby to avoid parking sessions with active children.
    pub fn has_active_children(&self, parent_session_id: &str) -> bool {
        let child_ids = self.child_ids(parent_session_id);
        let agents = self.agents.lock();
        child_ids.iter().any(|id| {
            agents.get(id).is_some_and(|e| {
                matches!(
                    e.view.status,
                    SubAgentStatus::Spawning
                        | SubAgentStatus::Running
                        | SubAgentStatus::WaitingInput
                        | SubAgentStatus::InProgress
                        | SubAgentStatus::Idle
                )
            })
        })
    }

    /// JSON snapshot of the archived agents for the local store (the session's
    /// `sub_agents` field, keyed by parentSessionId). Prompt fields
    /// are stripped (guardrail: user prompt text is never stored).
    pub fn archived_snapshot_json(
        &self,
    ) -> std::collections::HashMap<String, Vec<serde_json::Value>> {
        self.archived
            .lock()
            .iter()
            .map(|(parent, list)| {
                let vals = list
                    .iter()
                    .map(|e| {
                        let mut v = serde_json::to_value(e).unwrap_or(serde_json::Value::Null);
                        if let Some(obj) = v.as_object_mut() {
                            obj.remove("userPrompt");
                            obj.remove("autoPrompt");
                            // The store lists (and keeps across restarts) only
                            // entries marked archived; without the mark they
                            // were invisible after the next start.
                            obj.insert("status".into(), serde_json::json!("archived"));
                        }
                        v
                    })
                    .collect();
                (parent.clone(), vals)
            })
            .collect()
    }

    /// Hook server `resolveToParent`: a sessionId belonging to a
    /// sub-agent (id, PTY session or claude session) resolves to its parent.
    pub fn resolve_parent_session(&self, session_id: &str) -> Option<String> {
        self.agents.lock().values().find_map(|e| {
            let v = &e.view;
            let matches = v.id == session_id
                || v.session_id == session_id
                || v.claude_session_id.as_deref() == Some(session_id);
            if matches {
                Some(v.parent_session_id.clone())
            } else {
                None
            }
        })
    }

    /// Child session id (or claude session id) → sub-agent id.
    pub fn resolve_sub_agent_id(&self, session_id: &str) -> Option<String> {
        self.agents.lock().values().find_map(|e| {
            let v = &e.view;
            (v.id == session_id
                || v.session_id == session_id
                || v.claude_session_id.as_deref() == Some(session_id))
            .then(|| v.id.clone())
        })
    }

    /// The requested title, or "title 2", "title 3"… when an agent of the same
    /// session already has it. The UI keys bench, order and lock by role and
    /// title, so two agents named alike would move together.
    fn unique_title(&self, parent_session_id: &str, title: &str) -> String {
        let agents = self.agents.lock();
        let taken: std::collections::HashSet<&str> = agents
            .values()
            .filter(|e| e.view.parent_session_id == parent_session_id)
            .map(|e| e.view.title.as_str())
            .collect();
        free_title(&taken, title)
    }

    fn parent_for_spawn(
        &self,
        parent_session_id: &str,
        info: Option<crate::commands::session::ParentSessionInfo>,
    ) -> Result<ParentContext, String> {
        let info = info.ok_or_else(|| format!("Parent session not found: {parent_session_id}"))?;
        let context = ParentContext {
            workspace_path: info.workspace_path,
            provider: info.provider,
            provider_account_id: info.provider_account_id,
            session_name: info.name,
            auto_approve: info.auto_approve,
        };
        // Keep the display cache fresh, but use only live state for spawning.
        self.parents
            .lock()
            .insert(parent_session_id.to_string(), context.clone());
        Ok(context)
    }
}

// ── Helpers ──────────────────────────────────────────────────────────

fn now_iso() -> String {
    // ISO-8601 UTC with no extra dependencies: epoch seconds in RFC3339-ish format.
    // Enough for lexicographic ordering (as createdAt.localeCompare does).
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    // Keep monotonicity: use seconds.millis for granularity.
    format!("{:020}.{:03}", dur.as_secs(), dur.subsec_millis())
}

/// Maps the provider id to the CLI binary to launch in the PTY.
/// Minimal form: the mode/native flags are not added here (AI/preamble side).
fn provider_binary(provider: &str) -> String {
    match provider {
        "claude-code-cli" => "claude".into(),
        "codex" => "codex".into(),
        "gemini-cli" => "gemini".into(),
        "antigravity" => "agy".into(),
        "copilot" => "copilot".into(),
        "cursor" => "cursor-agent".into(),
        "grok" => "grok".into(),
        "hermes" => "hermes".into(),
        "muse" => "muse".into(),
        "opencode" => "opencode".into(),
        "promptops-cli" => "promptops-cli".into(),
        // generic-shell runs raw commands → the default shell.
        "generic-shell" => default_shell(),
        // The id ends up verbatim in the PTY's shell line and may come
        // from untrusted sources (synced stash, control plane): only what
        // can be part of a command NAME is kept, never shell syntax.
        other => {
            let name: String = other
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                .collect();
            if name.is_empty() {
                "true".into()
            } else {
                name
            }
        }
    }
}

/// Shells whose CLI cannot reach the local `promptops` MCP server through the
/// app's config (Windows paths inside a WSL distro).
fn mcp_unreachable_shell(shell: Option<&str>) -> bool {
    crate::commands::windows_shells::wsl_distro_of(shell).is_some()
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

/// Truncates a prompt for the preview (200 chars + ellipsis, as in the
/// list-pending handler; reused where needed).
#[allow(dead_code)]
fn prompt_preview(prompt: &str) -> String {
    if prompt.chars().count() > 200 {
        let truncated: String = prompt.chars().take(197).collect();
        format!("{}…", truncated.trim_end())
    } else {
        prompt.to_string()
    }
}

/// Emits `subagent:status` and updates `promptPending`/`status`
/// (replica of `SubAgentManager.updateStatus`).
fn update_status(
    app: &tauri::AppHandle,
    agents: &mut HashMap<String, AgentEntry>,
    sub_agent_id: &str,
    status: SubAgentStatus,
) {
    let Some(entry) = agents.get_mut(sub_agent_id) else {
        return;
    };
    entry.view.status = status;
    // Releasing the boot overlay: once out of 'spawning' the prompt
    // is no longer pending.
    if status != SubAgentStatus::Spawning {
        entry.view.prompt_pending = false;
        // Startup done: the small size requested by the pane can now reach the PTY.
        if let Some(inter) = entry.interactive.as_mut() {
            if let Some((cols, rows)) = inter.deferred_size.take() {
                let _ = inter.pty.resize(cols, rows);
                inter.vt.lock().resize(cols, rows);
            }
        }
    }
    let ephemeral = entry.view.ephemeral.unwrap_or(false);
    let payload = StatusEvent {
        sub_agent_id: sub_agent_id.to_string(),
        parent_session_id: entry.view.parent_session_id.clone(),
        status,
        prompt_pending: entry.view.prompt_pending,
    };
    // Ephemeral agents (one-shot reviewers) stay invisible to the renderer.
    if !ephemeral {
        let _ = app.emit("subagent:status", payload);
    }
}

/// Provider launch line inside the sub-agent's login shell.
/// generic-shell → no launch (plain shell). claude-code-cli handles
/// resume (`--resume <sid>`), previously missing in the bare-binary branch.
/// Model from the renderer → shell-safe fragment: character whitelist and cap,
/// never interpolate arbitrary strings into a shell command.
pub(crate) fn sanitize_model_flag(model: Option<&str>) -> Option<String> {
    let m = model?.trim();
    // `-m --yolo`: yargs/commander CLIs read a value that starts with `-` as
    // another flag, so a "model" could switch on auto-approve.
    if m.is_empty()
        || m.len() > 64
        || m.starts_with('-')
        || !m
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-' | '/'))
    {
        return None;
    }
    Some(m.to_string())
}

/// Conversation id imposed on `claude` at spawn (`--session-id <uuid>`).
///
/// Used to know WHERE the CLI will write the transcript without depending on
/// hooks: the SessionStart hook is the only other source of the id, and a stale
/// `settings.local.json` (port of another installation) is enough for it
/// never to arrive — with the result that the model in use stays undetectable.
/// By imposing it ourselves, the log path is known from the very first instant.
///
/// Applies only to NEW spawns: on `--resume` the id already exists and is that one.
fn new_claude_session_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// `--session-id` exists in recent CLIs: on an old one it would be an unknown
/// flag and the CLI would not start. Checked ONCE per run, inside
/// a login shell (the user's PATH), and when in doubt the answer is NO:
/// losing model detection is a nuisance, failing to start a
/// sub-agent is real damage.
pub(crate) fn claude_supports_session_id() -> bool {
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    *SUPPORTED.get_or_init(|| crate::commands::session::cli_help_mentions("claude", "--session-id"))
}

fn valid_effort<'a>(
    provider: &str,
    effort: Option<&'a str>,
    model: Option<&str>,
) -> Option<&'a str> {
    let effort = effort?;
    if provider == "claude-code-cli" && !model.unwrap_or("").contains("haiku") {
        return matches!(effort, "low" | "medium" | "high" | "xhigh" | "max").then_some(effort);
    }
    // agy ≥ 1.3.4: `--effort` on the BASE slug. A slug that already carries the
    // level (`…-high`, or a model without variants) doesn't want another one.
    if provider == "antigravity" {
        let pinned = model.is_some_and(|m| {
            m.rsplit_once('-')
                .is_some_and(|(_, s)| matches!(s, "low" | "medium" | "high" | "xhigh" | "max"))
        });
        return (!pinned && matches!(effort, "low" | "medium" | "high" | "xhigh" | "max"))
            .then_some(effort);
    }
    // `--help` (October 2026): grok `--effort low|medium|high|xhigh|max`,
    // copilot `--effort low|medium|high|xhigh`.
    if provider == "grok" {
        return matches!(effort, "low" | "medium" | "high" | "xhigh" | "max").then_some(effort);
    }
    (matches!(provider, "codex" | "copilot")
        && matches!(effort, "low" | "medium" | "high" | "xhigh"))
    .then_some(effort)
}

fn apply_effort_depth(cfg: &mut crate::commands::subagent_modes::ModeConfig, effort: Option<&str>) {
    if let Some(e) = effort {
        cfg[0] = match e {
            "low" => "LOW",
            "medium" => "MEDIUM",
            "high" => "HIGH",
            _ => "MAX",
        }
        .into();
    }
}

fn build_subagent_launch(
    provider: &str,
    claude_session_id: Option<&str>,
    launch_flags: &str,
    model: Option<&str>,
    effort: Option<&str>,
    auto_approve: bool,
    // fresh_session_id: id to IMPOSE when nothing is being resumed (None = don't impose it).
    fresh_session_id: Option<&str>,
    command_alias: Option<&str>,
    // Id of the sub-agent that registers the `promptops` MCP server in the CLI
    // (None = no registration, e.g. tests).
    mcp_session: Option<&str>,
) -> Option<String> {
    let mcp = |family: &str| {
        mcp_session
            .and_then(|sid| crate::commands::promptops_cli::mcp_launch_fragment(family, sid))
            .unwrap_or_default()
    };
    let effort = valid_effort(provider, effort, model);
    let model = sanitize_model_flag(model);
    // Native bypass flag inherited from the parent (parent auto-approve):
    // for Claude AA goes through tailer + hooks, no flag.
    let aa_flag = if auto_approve {
        crate::commands::session::native_auto_approve_flag(provider)
    } else {
        None
    };
    // Resume only for those that resume a SPECIFIC conversation given the id:
    // gemini/antigravity resume "the latest" and on a sub-agent would pick
    // the wrong conversation, so for them we stick with re-injecting
    // the prompt (idempotent). The id comes from renderer/stash: never put in a
    // shell line without validation.
    let claude_session_id = claude_session_id
        .filter(|_| crate::commands::session::provider_resumes_by_id(provider))
        .filter(|sid| crate::commands::session::is_safe_session_id(sid));
    let launch = match crate::commands::session::provider_resume_family(provider) {
        "generic-shell" => None,
        // zai/kimi spawn the same `claude` CLI (compatible endpoint via
        // env): same builder, same resume.
        "claude-code-cli" => {
            let mut cmd = String::from("claude");
            if let Some(sid) = claude_session_id {
                cmd.push_str(&format!(" --resume {sid}"));
            } else if let Some(fresh) =
                fresh_session_id.filter(|s| crate::commands::session::is_safe_session_id(s))
            {
                cmd.push_str(&format!(" --session-id {fresh}"));
            }
            // Native mode flags (risk→permission-mode, exploration→tools) —
            // fragment already quoted by build_native_mode_flags.
            if !launch_flags.is_empty() {
                cmd.push_str(&format!(" {launch_flags}"));
            }
            if let Some(m) = model {
                cmd.push_str(&format!(" --model {m}"));
            }
            if let Some(e) = effort {
                cmd.push_str(&format!(" --effort {e}"));
            }
            let mcp = mcp("claude-code-cli");
            if !mcp.is_empty() {
                cmd.push_str(&format!(" {mcp}"));
            }
            // Hooks per process (`--settings`): local agents only, like the MCP.
            if let Some(settings) = mcp_session
                .and_then(|_| crate::commands::session::claude_settings_fragment(provider))
            {
                cmd.push_str(&format!(" {settings}"));
            }
            cmd.push('\r');
            Some(cmd)
        }
        "codex" => {
            let mut cmd = provider_binary("codex").to_string();
            // Inline mode: without it, Codex's alt screen makes the pane history
            // unreachable in xterm (see codex_no_alt_screen_flag).
            let no_alt = crate::commands::session::codex_no_alt_screen_flag();
            if !no_alt.is_empty() {
                cmd.push_str(&format!(" {no_alt}"));
            }
            if let Some(m) = model {
                cmd.push_str(&format!(" -m {m}"));
            }
            if let Some(flag) = aa_flag {
                cmd.push_str(&format!(" {flag}"));
            }
            if let Some(e) = effort {
                cmd.push_str(&format!(" -c 'model_reasoning_effort=\"{e}\"'"));
            }
            let mcp = mcp("codex");
            if !mcp.is_empty() {
                cmd.push_str(&format!(" {mcp}"));
            }
            // `resume` is a SUBCOMMAND and global options must precede it
            // (same as the main session's Codex launch command): it goes last.
            if let Some(sid) = claude_session_id {
                cmd.push_str(&format!(" resume {sid}"));
            }
            cmd.push('\r');
            Some(cmd)
        }
        other => {
            let mut cmd = provider_binary(other).to_string();
            if let (Some(m), Some(flag)) = (
                model.as_deref(),
                crate::commands::session::model_flag(other),
            ) {
                cmd.push_str(&format!(" {flag} {m}"));
            }
            if matches!(other, "antigravity" | "grok" | "copilot") {
                if let Some(e) = effort {
                    cmd.push_str(&format!(" --effort {e}"));
                }
            }
            if let Some(flag) = aa_flag {
                cmd.push_str(&format!(" {flag}"));
            }
            // grok `--resume <id>`, opencode `--session <id>`, hermes
            // `--resume <id>`: without this, a restore with a resume key
            // would suppress the prompt replay (is_resume=true in do_spawn)
            // WITHOUT resuming anything — a mute sub-agent with no context.
            if let Some(sid) = claude_session_id {
                if let Some(flag) = crate::commands::session::resume_by_id_flag(other, sid) {
                    cmd.push_str(&format!(" {flag}"));
                }
            }
            cmd.push('\r');
            Some(cmd)
        }
    };
    launch.map(|line| {
        let line = crate::commands::provider_account::override_launch_command(line, command_alias);
        if provider == "promptops-cli" {
            crate::commands::promptops_cli::launch_line(line)
        } else {
            line
        }
    })
}

/// inject_when_ready on the sub-agent buffer:
/// writes `command` once the shell has produced visible output and has
/// settled, with floor/ceiling. Best-effort, never blocks.
/// Pacing of inject_launch_when_ready: `SHELL` = local login shell;
/// `SLOW_CONNECT` = the PTY is still connecting to the remote host (same
/// values as the sessions' InjectPacing::SlowConnect).
#[derive(Clone, Copy)]
struct LaunchPacing {
    floor_ms: u128,
    quiet_ms: u128,
    ceiling_ms: u128,
}

impl LaunchPacing {
    const SHELL: Self = Self {
        floor_ms: 250,
        quiet_ms: 250,
        ceiling_ms: 4_000,
    };
    const SLOW_CONNECT: Self = Self {
        floor_ms: 2_000,
        quiet_ms: 1_500,
        ceiling_ms: 45_000,
    };
}

fn inject_launch_when_ready(
    manager: &Arc<SubAgentManager>,
    sub_agent_id: &str,
    command: &str,
    pacing: LaunchPacing,
) {
    let LaunchPacing {
        floor_ms,
        quiet_ms,
        ceiling_ms,
    } = pacing;
    const POLL_MS: u64 = 50;

    let start = std::time::Instant::now();
    let mut last_len: isize = -1;
    let mut last_change = std::time::Instant::now();

    loop {
        let buf = {
            let agents = manager.agents.lock();
            match agents
                .get(sub_agent_id)
                .and_then(|e| e.interactive.as_ref())
            {
                Some(inter) => String::from_utf8_lossy(&inter.buffer).into_owned(),
                None => return, // destroyed during cold start
            }
        };

        let elapsed = start.elapsed().as_millis();
        let len = buf.len() as isize;
        if len != last_len {
            last_len = len;
            last_change = std::time::Instant::now();
        }
        let has_visible = !crate::commands::session::strip_ansi(&buf).trim().is_empty();
        let quiet_for = last_change.elapsed().as_millis();

        if crate::commands::session::should_inject_launch(
            elapsed,
            quiet_for,
            has_visible,
            floor_ms,
            quiet_ms,
            ceiling_ms,
        ) {
            let writer = {
                let agents = manager.agents.lock();
                agents
                    .get(sub_agent_id)
                    .and_then(|e| e.interactive.as_ref())
                    .map(|i| i.writer.clone())
            };
            if let Some(w) = writer {
                // Same guard as the main session: kill-line before the
                // command, against leftover mouse-tracking garbage.
                let line = crate::commands::session::guarded_launch_line(command);
                let _ = w.lock().write_all(line.as_bytes());
                spawn_mark(sub_agent_id, "launch-typed");
            }
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
    }
}

/// Per-phase spawn timings (`[spawn-timing] <id> <phase> +<ms>`): they show
/// where the seconds go between the click and a usable agent.
fn spawn_timing() -> &'static Mutex<HashMap<String, std::time::Instant>> {
    static T: std::sync::OnceLock<Mutex<HashMap<String, std::time::Instant>>> =
        std::sync::OnceLock::new();
    T.get_or_init(Default::default)
}

fn spawn_timing_start(id: &str) {
    let mut t = spawn_timing().lock();
    // Old entries (finished spawns) are no longer needed: no growth.
    t.retain(|_, start| start.elapsed() < std::time::Duration::from_secs(120));
    t.insert(id.to_string(), std::time::Instant::now());
}

fn spawn_mark(id: &str, phase: &str) {
    if let Some(start) = spawn_timing().lock().get(id) {
        eprintln!(
            "[spawn-timing] {id} {phase} +{}ms",
            start.elapsed().as_millis()
        );
    }
}

/// Relaunch plans when a sub-agent's resume is rejected by the
/// CLI (same as the main sessions' ResumeRecovery, session.rs).
struct SubAgentResumeRecovery {
    /// The id the resume tried (and failed) to reopen.
    sid: String,
    /// Startup/wake restores must never turn a failed resume into a new task.
    restored: bool,
    /// Relaunch that PRESERVES identity (`--session-id <sid>`): the
    /// conversation is reborn with the same id, reopenable by future resumes.
    /// claude family only, IdNotFound only.
    keep_id: Option<String>,
    /// Clean relaunch without resume.
    plain: Option<String>,
    /// Original prompt (preamble included) to re-inject after the relaunch:
    /// the resume had suppressed injection; without replay the reborn CLI
    /// would stay empty and without context.
    prompt: String,
    provider: String,
    /// True = paste without submitting (deferred prompt on archived resume).
    defer_prompt: bool,
}

/// recover_failed_subagent_resume — if the sub-agent resume fails,
/// relaunch the CLI and re-inject the original prompt ("start over" becomes the
/// automatic plan B instead of a mute pane), then notify the renderer with
/// `subagent:resume-fallback` so the user knows the context did not come back.
///
/// Same window/grid as recover_failed_resume (session.rs): a single
/// attempt, only output arriving AFTER the launch injection is examined.
fn recover_failed_subagent_resume(
    app: &tauri::AppHandle,
    manager: &Arc<SubAgentManager>,
    sub_agent_id: &str,
    recovery: &SubAgentResumeRecovery,
) {
    use crate::commands::session::{resume_failure_in_window, ResumeFailureKind};
    // Wide window for "id not found" (CLI slow to boot on cold start),
    // narrow for a corrupted line — same grid as session.rs.
    const WINDOW_MS: u128 = crate::commands::session::NOT_FOUND_WINDOW_MS;
    const POLL_MS: u64 = 150;
    const TAIL_BYTES: usize = 8 * 1024;

    // Baseline: ONLY output after the launch is evaluated (a shell profile
    // that prints "command not found" must not trigger the fallback).
    let baseline_total = {
        let agents = manager.agents.lock();
        match agents
            .get(sub_agent_id)
            .and_then(|e| e.interactive.as_ref())
        {
            Some(inter) => inter.buffer_total,
            None => return,
        }
    };

    let start = std::time::Instant::now();
    let mut failure_tracker = ResumeFailureTracker::default();
    while start.elapsed().as_millis() < WINDOW_MS {
        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
        let (total, tail) = {
            let agents = manager.agents.lock();
            match agents
                .get(sub_agent_id)
                .and_then(|e| e.interactive.as_ref())
            {
                Some(inter) => {
                    let fresh = inter
                        .buffer_total
                        .saturating_sub(baseline_total)
                        .min(TAIL_BYTES);
                    let from = inter.buffer.len().saturating_sub(fresh);
                    (inter.buffer_total, inter.buffer[from..].to_vec())
                }
                None => return, // destroyed while waiting
            }
        };
        if tail.is_empty() {
            continue;
        }
        let kind = match failure_tracker.sample(start.elapsed().as_millis(), total, &tail) {
            Some(kind) => kind,
            None => continue,
        };
        if !resume_failure_in_window(&kind, start.elapsed().as_millis()) {
            continue;
        }
        if recovery.restored {
            // Preserve the resume ID and history. A failed restore is not
            // permission to recreate the conversation or execute its old task.
            let mut agents = manager.agents.lock();
            if let Some(entry) = agents.get(sub_agent_id) {
                if !entry.view.ephemeral.unwrap_or(false) {
                    let _ = app.emit(
                        "subagent:resume-fallback",
                        serde_json::json!({
                            "subAgentId": sub_agent_id,
                            "parentSessionId": entry.view.parent_session_id,
                            "title": entry.view.title,
                            "keptId": true,
                            "restarted": false,
                        }),
                    );
                }
            }
            update_status(app, &mut agents, sub_agent_id, SubAgentStatus::Error);
            return;
        }
        // Plain message + relaunch. Bare `echo` with no quotes/`&&`/`[]`
        // (identical on zsh/bash/PowerShell/cmd, same as the main sessions).
        let (notice, cmd) = match kind {
            ResumeFailureKind::IdNotFound => match (&recovery.keep_id, &recovery.plain) {
                (Some(keep), _) => (
                    Some(format!(
                        "echo PromptOps: conversation {} not found - recreating it with the same ID and restarting from the initial prompt\r",
                        recovery.sid
                    )),
                    keep.clone(),
                ),
                (None, Some(plain)) => (
                    Some(format!(
                        "echo PromptOps: conversation {} not found - restarting from the initial prompt\r",
                        recovery.sid
                    )),
                    plain.clone(),
                ),
                (None, None) => return,
            },
            // CLI never started (corrupted launch line): silent relaunch; the
            // transcript may still exist, so the identity stays.
            ResumeFailureKind::LaunchGarbled => match &recovery.plain {
                Some(plain) => (None, plain.clone()),
                None => return,
            },
        };
        let keeps_id = match kind {
            ResumeFailureKind::IdNotFound => recovery.keep_id.is_some(),
            // Identity intact: the clean relaunch opens a new conversation
            // but the old one may still exist on disk.
            ResumeFailureKind::LaunchGarbled => true,
        };
        let writer = {
            let agents = manager.agents.lock();
            agents
                .get(sub_agent_id)
                .and_then(|e| e.interactive.as_ref())
                .map(|i| i.writer.clone())
        };
        let Some(w) = writer else { return };
        {
            let mut w = w.lock();
            if let Some(notice) = &notice {
                let _ = w.write_all(notice.as_bytes());
            }
            let _ = w.write_all(cmd.as_bytes());
        }
        // Identity bookkeeping: with IdNotFound without keep_id the transcript no
        // longer exists anywhere — the stale id in the stash would make every
        // future restart fail (and recover).
        let (parent_id, title, ephemeral) = {
            let mut agents = manager.agents.lock();
            match agents.get_mut(sub_agent_id) {
                Some(entry) => {
                    if !keeps_id {
                        entry.view.claude_session_id = None;
                    }
                    (
                        entry.view.parent_session_id.clone(),
                        entry.view.title.clone(),
                        entry.view.ephemeral.unwrap_or(false),
                    )
                }
                None => return,
            }
        };
        // "Start over" plan B: re-inject the original prompt once the reborn CLI
        // is ready (inject_prompt waits for the TUI and has the
        // dead-shell guard). A restore is not a user send: count=false.
        inject_prompt(
            app,
            manager,
            sub_agent_id,
            &recovery.provider,
            &recovery.prompt,
            recovery.defer_prompt,
            false,
        );
        // Notify the renderer (toast): without it, the fallback looks like a successful
        // resume and the user only finds out later that the context is gone.
        // Ephemeral agents stay invisible (same as update_status).
        if !ephemeral {
            let _ = app.emit(
                "subagent:resume-fallback",
                serde_json::json!({
                    "subAgentId": sub_agent_id,
                    "parentSessionId": parent_id,
                    "title": title,
                    "keptId": keeps_id,
                }),
            );
        }
        // localStorage mirror refreshed (id possibly cleared).
        push_stash_snapshot(app, manager, &parent_id);
        eprintln!(
            "[SubAgentManager] resume rejected by the provider for {sub_agent_id} — relaunching and re-injecting the original prompt (keeps_id={keeps_id})"
        );
        return;
    }
}

/// A resumed TUI can repaint old errors verbatim. Only treat those words as
/// a failed launch after the shell prompt has returned and output has settled.
/// Use the cumulative byte count: the bounded replay buffer can stay full
/// while the provider is still producing output.
#[derive(Default)]
struct ResumeFailureTracker {
    last_total: usize,
    last_change_ms: u128,
}

#[cfg(test)]
mod resume_failure_tests {
    use super::*;
    use crate::commands::session::ResumeFailureKind;

    #[test]
    fn restored_error_history_does_not_fail_a_live_tui() {
        for message in [
            "No conversation found with session ID: old-id",
            "session not found",
            "zsh: command not found: missing-tool",
        ] {
            let output = format!("{message}\r\nResumed conversation\r\n> ");
            let mut tracker = ResumeFailureTracker::default();
            assert!(tracker.sample(0, output.len(), output.as_bytes()).is_none());
            assert!(tracker
                .sample(1000, output.len(), output.as_bytes())
                .is_none());
        }
    }

    #[test]
    fn actual_resume_failure_requires_a_settled_shell_prompt() {
        let output = b"\x1b[31mNo conversation found with session ID: missing\x1b[0m\r\nuser@host project % ";
        let mut tracker = ResumeFailureTracker::default();
        assert!(tracker.sample(100, output.len(), output).is_none());
        assert!(tracker.sample(699, output.len(), output).is_none());
        assert!(matches!(
            tracker.sample(700, output.len(), output),
            Some(ResumeFailureKind::IdNotFound)
        ));
    }

    #[test]
    fn garbled_launch_is_still_detected_after_shell_returns() {
        let output = b"bash: broken-cli: command not found\r\nuser@host:~/project$ ";
        let mut tracker = ResumeFailureTracker::default();
        assert!(tracker.sample(0, output.len(), output).is_none());
        assert!(matches!(
            tracker.sample(600, output.len(), output),
            Some(ResumeFailureKind::LaunchGarbled)
        ));
    }

    #[test]
    fn continuing_replay_resets_settle_time_even_with_a_full_buffer() {
        let output = b"session not found\r\nuser@host project % ";
        let mut tracker = ResumeFailureTracker::default();
        assert!(tracker.sample(0, 8192, output).is_none());
        assert!(tracker.sample(500, 16384, output).is_none());
        assert!(tracker.sample(1000, 16384, output).is_none());
        // The next redraw replaces the apparent shell prompt with TUI input.
        let ready = b"session not found\r\n> ";
        assert!(tracker.sample(1100, 16400, ready).is_none());
        assert!(tracker.sample(2000, 16400, ready).is_none());
    }

    #[test]
    fn shell_prompt_without_resume_error_is_not_a_failure() {
        let output = b"user@host project % ";
        let mut tracker = ResumeFailureTracker::default();
        assert!(tracker.sample(0, output.len(), output).is_none());
        assert!(tracker.sample(1000, output.len(), output).is_none());
    }
}

impl ResumeFailureTracker {
    fn sample(
        &mut self,
        elapsed_ms: u128,
        total: usize,
        tail: &[u8],
    ) -> Option<crate::commands::session::ResumeFailureKind> {
        if total != self.last_total {
            self.last_total = total;
            self.last_change_ms = elapsed_ms;
        }
        if elapsed_ms.saturating_sub(self.last_change_ms) < 600 || !shell_prompt_visible(tail) {
            return None;
        }
        crate::commands::session::resume_failure_kind(&crate::commands::session::strip_ansi(
            &String::from_utf8_lossy(tail),
        ))
    }
}

/// Bridge diagnostic probe: lands webview messages in the Rust log
/// (the bridge has no visible console in headless dev).
#[tauri::command]
pub fn bridge_debug(message: String) {
    eprintln!("[bridge] {message}");
}

// ── Commands: spawn ───────────────────────────────────────────────────

/// subagent:spawn — creates a sub-agent (child session) inside a parent.
///
/// Faithfully ports the PTY part: derives provider/cwd/account from the parent, opens
/// the provider PTY, registers the entry, indexes by parent, emits
/// `subagent:created` and starts the prompt injection (BPM paste + Enter).
#[tauri::command]
pub async fn subagent_spawn(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SubAgentManager>>,
    request: SpawnSubAgentRequest,
    _on_output: Channel<InvokeResponseBody>,
) -> Result<SubAgentView, String> {
    // The bridge's per-spawn channel stays for signature compat but is ignored:
    // output travels on the global subagent_output_channel channel.
    do_spawn(&app, manager.inner(), request)
}

/// Registers (or REPLACES, on every webview reload) the global RAW channel
/// that carries the PTY output of all sub-agents.
#[tauri::command]
pub fn subagent_output_channel(
    manager: tauri::State<'_, Arc<SubAgentManager>>,
    on_output: Channel<InvokeResponseBody>,
) {
    *manager.output_channel.lock() = Some(on_output);
}

/// subagent:spawn-request — spawn with a cross-provider gate on context-transfer.
///
/// If the requested provider differs from the parent and the
/// shared-context file does not exist yet, the full flow emits `subagent:context-transfer-required`
/// and returns a `pendingSpawnId`. Context materialization is
/// AI-side. // TODO: implement the materializer, spawn queue and
/// context-transfer resolution; here we always proceed with a direct spawn.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequestResult {
    /// `{ok, subAgent}` wrapper: the renderer returns the
    /// sub-agent only if `ok && subAgent`.
    pub ok: bool,
    pub sub_agent: Option<SubAgentView>,
    pub pending_spawn_id: Option<String>,
}

#[tauri::command]
pub async fn subagent_spawn_request(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SubAgentManager>>,
    request: SpawnSubAgentRequest,
    _on_output: Channel<InvokeResponseBody>,
) -> Result<SpawnRequestResult, String> {
    // TODO: gate on context-transfer (materializer/spawn-queue). For
    // now we only handle the "same provider / no materializer" branch:
    // direct spawn.
    let view = do_spawn(&app, manager.inner(), request)?;
    Ok(SpawnRequestResult {
        ok: true,
        sub_agent: Some(view),
        pending_spawn_id: None,
    })
}

pub(crate) fn do_spawn(
    app: &tauri::AppHandle,
    manager: &Arc<SubAgentManager>,
    mut request: SpawnSubAgentRequest,
) -> Result<SubAgentView, String> {
    let sub_agent_id = Uuid::new_v4().to_string();
    spawn_timing_start(&sub_agent_id);
    let now = now_iso();
    // Restores and resumes keep the title they had.
    if request.restored != Some(true) && request.claude_session_id.is_none() {
        request.title = manager.unique_title(&request.parent_session_id, &request.title);
    }

    // Resolve again at every spawn/restore: account switches update the live
    // session, so the cached context must never select authentication.
    use tauri::Manager;
    let session_manager = app.state::<Arc<crate::commands::session::SessionManager>>();
    let parent = manager.parent_for_spawn(
        &request.parent_session_id,
        session_manager.parent_info(&request.parent_session_id),
    )?;

    let parent_provider = parent
        .provider
        .clone()
        .unwrap_or_else(|| "claude-code-cli".into());
    let provider = request.provider.clone().unwrap_or(parent_provider);
    let cwd = request
        .workspace_override
        .clone()
        .or_else(|| parent.workspace_path.clone());

    // Remote sessions (beta): the sub-agent is born on the SAME host as the
    // parent session — same transport (native ssh or connect command).
    let remote: Option<SubRemote> = match cwd.as_deref() {
        Some(c) => {
            if let Some((conn_id, path)) = crate::commands::remote::parse_remote_path(c) {
                Some(SubRemote::Ssh { conn_id, path })
            } else if let Some(path) = crate::commands::remote::parse_cmd_path(c) {
                let command = session_manager
                    .remote_command_of(&request.parent_session_id)
                    .ok_or_else(|| {
                        "Remote session has no connect command configured (config.remoteCommand)."
                            .to_string()
                    })?;
                Some(SubRemote::Cmd { command, path })
            } else {
                None
            }
        }
        None => None,
    };
    // Deleted/moved workspace folder: refuse the spawn instead of letting the
    // PTY fall back to home (portable-pty silently ignores a missing cwd).
    // UNC paths (\\wsl.localhost…) keep the historical behavior.
    if remote.is_none() && !cwd.as_deref().unwrap_or("").starts_with("\\\\") {
        if let Some(err) = crate::commands::session::missing_workspace_error(cwd.as_deref(), &|p| {
            std::path::Path::new(p).is_dir()
        }) {
            return Err(err);
        }
    }

    // The explicit account wins; otherwise it inherits from the parent
    // (resolved into env at PTY spawn).
    let account_explicit: Option<Option<String>> = request
        .provider_account_id
        .clone()
        .or_else(|| parent.provider_account_id.clone())
        .map(Some);

    let ephemeral = request.ephemeral.unwrap_or(false);
    // A "real" resume suppresses prompt re-injection: it only applies if the
    // provider can actually resume that id, otherwise the sub-agent
    // would restart mute and without context.
    // Mirrors EXACTLY build_subagent_launch's filter (resume-by-id +
    // sane id): a sid discarded by the builder with is_resume=true would suppress
    // the prompt replay WITHOUT resuming anything — mute pane without context.
    let is_resume = request.claude_session_id.as_deref().is_some_and(|sid| {
        crate::commands::session::provider_resumes_by_id(&provider)
            && crate::commands::session::is_safe_session_id(sid)
    });
    // Restoring an AI prompt can repeat real side effects too (e.g. deploy).
    // Startup/wake only reopen history; a new task needs a new user message.
    let skip_prompt_replay = request.restored.unwrap_or(false);

    // Mode→config + buildModePreamble + squad context (mode-filtered) +
    // native mode flags (subagent_modes / squad_context).
    let mode = request.mode.clone().unwrap_or_else(|| {
        crate::commands::subagent_modes::default_mode_for_role(&request.role).to_string()
    });
    // NATIVE goal: the goal travels as a Claude Code `/loop` command in an
    // interactive PTY. The slash must be the FIRST character of the paste,
    // so no preamble; only claude-code-cli has the loop skill.
    let goal_native = request
        .goal_spec
        .as_ref()
        .and_then(|s| s.native)
        .unwrap_or(false)
        && provider == "claude-code-cli";

    let soft_skill =
        crate::commands::subagent_modes::sanitize_soft_skill(request.soft_skill.clone());
    let (full_prompt, launch_flags) = if provider == "generic-shell" {
        (request.prompt.clone(), String::new())
    } else {
        let mut cfg =
            crate::commands::subagent_modes::resolve_config(&mode, request.custom_config.as_ref());
        apply_effort_depth(
            &mut cfg,
            valid_effort(
                &provider,
                request.effort.as_deref(),
                request.model.as_deref(),
            ),
        );
        let preamble = crate::commands::subagent_modes::build_mode_preamble(
            &mode,
            &cfg,
            request.eco_level.as_deref(),
            &provider,
            soft_skill.as_ref(),
        );
        let context_preamble = crate::commands::squad_context::build_context_preamble(
            &manager.squad_context.get(&request.parent_session_id),
            &mode,
        );
        let flags = crate::commands::subagent_modes::build_native_mode_flags(&cfg, &provider);
        (
            format!("{}{}{}", preamble, context_preamble, request.prompt),
            flags,
        )
    };
    let full_prompt = if goal_native {
        crate::commands::goal_loop::build_goal_native_loop_prompt(
            &request.prompt,
            request.goal_spec.as_ref().unwrap(),
        )
    } else {
        full_prompt
    };

    // ── Worker branch (headless): no PTY ──────────────────────────
    // Only stream-capable providers qualify; the others
    // fall back to interactive. A goalSpec implies the worker: the goal loop
    // can only drive headless turns — unless the goal travels the
    // NATIVE way (/loop), which is interactive by definition.
    if !goal_native
        && remote.is_none()
        && (matches!(request.execution_mode, Some(ExecutionMode::Worker))
            || request.goal_spec.is_some())
        && is_stream_capable_provider(&provider)
    {
        return spawn_worker(
            app,
            manager,
            &request,
            &sub_agent_id,
            &now,
            &provider,
            account_explicit,
        );
    }

    // ── Interactive branch (PTY) ──────────────────────────────────────
    // Windows shell inherited from the parent (subs run in the
    // same shell as the parent session), with the distro inferred from a
    // \\wsl.localhost\… workspace and the Settings default as fallback.
    let parent_shell = {
        use tauri::Manager;
        let session_manager = app.state::<Arc<crate::commands::session::SessionManager>>();
        session_manager.effective_shell_of(&request.parent_session_id)
    };

    // Like spawn_session_pty: validate the binary before opening a PTY that
    // would die silently (the GUI app doesn't inherit the user shell's PATH).
    // Skipped for cross-env shells (WSL/Git Bash): the CLI may exist only there.
    // Remote: the binary lives on the host (ssh: remote check when the
    // shell opens; command: not verifiable before connecting).
    if remote.is_none()
        && !crate::commands::windows_shells::is_cross_env_shell(parent_shell.as_deref())
    {
        let check = crate::commands::session::check_provider(&provider);
        if !check.installed {
            return Err(format!(
                "Provider binary \"{}\" not found on PATH. Please install it before starting an agent.",
                check.command
            ));
        }
    }

    let session_id = format!(
        "{}{}",
        if ephemeral { "review-" } else { "sub-" },
        Uuid::new_v4()
    );

    // Conversation id imposed when NOTHING is resumed: from here on
    // we know where claude writes the transcript, so the model in use is
    // readable even if the SessionStart hook never arrives.
    let fresh_claude_session_id = (request.claude_session_id.is_none()
        && remote.is_none()
        && crate::commands::session::provider_resume_family(&provider) == "claude-code-cli"
        && claude_supports_session_id())
    .then(new_claude_session_id);

    // Re-attach to an agent still alive in termd (app crash/restart).
    let mut reattached = false;

    // Native SSH transport: remote shell in the cwd, no local PTY.
    // Everything else (pump, buffer, injection) is identical thanks to AgentPty
    // + RemoteShellReader.
    let shell: String;
    let mut account_vars = Vec::new();
    let pty: AgentPty;
    let mut reader: Box<dyn Read + Send>;
    let writer: Arc<Mutex<Box<dyn Write + Send>>>;
    let killer: Mutex<Box<dyn ChildKiller + Send + Sync>>;
    let mut child: Option<Box<dyn portable_pty::Child + Send + Sync>>;
    if let Some(SubRemote::Ssh { conn_id, path }) = &remote {
        let expected_cmd = (provider != "generic-shell")
            .then(|| crate::commands::session::provider_command(&provider).map(str::to_string))
            .flatten();
        let rshell = crate::commands::remote::open_remote_shell_blocking(
            app,
            conn_id,
            path,
            expected_cmd,
            DEFAULT_COLS,
            DEFAULT_ROWS,
        )?;
        shell = "/bin/sh".into();
        writer = Arc::new(Mutex::new(Box::new(
            crate::commands::session::RemoteWriter {
                ctl: rshell.ctl.clone(),
            },
        )));
        killer = Mutex::new(Box::new(crate::commands::session::RemoteKiller {
            ctl: rshell.ctl.clone(),
        }));
        reader = Box::new(crate::commands::remote::RemoteShellReader::new(
            rshell.output_rx,
        ));
        child = None;
        pty = AgentPty::Remote {
            ctl: rshell.ctl,
            size: Mutex::new((DEFAULT_COLS, DEFAULT_ROWS)),
        };
    } else {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows: DEFAULT_ROWS,
                cols: DEFAULT_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        // TODO: native mode flags + provider options (extension selection
        // materializer, account env injection). Login shell + injection of the launch
        // command, like spawn_session_pty: the bare binary doesn't resolve from the
        // minimal PATH of GUI apps (macOS: /usr/bin:/bin), and the login shell loads
        // the user profile (nvm/volta/homebrew).
        let resolved = crate::commands::windows_shells::resolve_shell_spawn(
            parent_shell.as_deref(),
            cwd.as_deref(),
        );
        let (local_shell, shell_args, pty_cwd, is_wsl) =
            if let Some(SubRemote::Cmd { command, .. }) = &remote {
                // Command transport: the local PTY runs the connect command
                // from the login shell (like spawn_session_pty), starting from home.
                if cfg!(windows) {
                    (
                        "powershell.exe".to_string(),
                        crate::commands::windows_shells::ps_connect_args(command),
                        Some(crate::commands::session::home_dir()),
                        false,
                    )
                } else {
                    (
                        crate::commands::session::login_shell(),
                        vec!["-l".to_string(), "-c".to_string(), command.clone()],
                        Some(crate::commands::session::home_dir()),
                        false,
                    )
                }
            } else {
                match &resolved {
                    Some(r) => (
                        r.file.clone(),
                        r.args.clone(),
                        r.cwd.clone().or_else(|| cwd.clone()),
                        r.is_wsl,
                    ),
                    None => (
                        crate::commands::session::login_shell(),
                        crate::commands::session::login_args(),
                        cwd.clone(),
                        false,
                    ),
                }
            };
        let mut cmd = CommandBuilder::new(&local_shell);
        for arg in shell_args {
            cmd.arg(arg);
        }
        if let Some(ref c) = pty_cwd {
            cmd.cwd(c);
        }
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }
        crate::commands::session::strip_inherited_agent_env(&mut cmd);
        cmd.env_remove("CLAUDECODE");
        cmd.env_remove("CLAUDE_CODE");
        crate::commands::session::apply_terminal_env(&mut cmd);

        // Claude Code hooks: same per-process attribution as spawn_session_pty.
        // Without PROMPTOPS_SESSION_ID the shim POSTs an empty sessionId: SessionStart
        // never attaches the claudeSessionId to the view and the stash persists without
        // a resume key (restore would respawn a sub-agent without context).
        // WSL shell inherited from the parent → same hook plan as the parent session
        // (shim path /mnt/c/…, reachable host; see hook::wsl_hook_plan).
        // Hooks/account: LOCAL paths — skipped on remote transports.
        if provider == "claude-code-cli" && remote.is_none() {
            let mut hook_env: Vec<(String, String)> = Vec::new();
            let hook_port = crate::commands::hook::global_port();
            if hook_port != 0 {
                if let Some(ref c) = cwd {
                    if is_wsl {
                        let distro =
                            crate::commands::windows_shells::wsl_distro_of(parent_shell.as_deref())
                                .unwrap_or_default();
                        match crate::commands::hook::wsl_hook_plan(app, &distro, hook_port) {
                            crate::commands::hook::WslHookPlan::Http { host } => {
                                if let Err(err) = crate::commands::hook::write_hook_settings(
                                    c,
                                    "",
                                    hook_port,
                                    true,
                                    Some(&host),
                                ) {
                                    eprintln!("[hooks] write settings failed: {err}");
                                }
                            }
                            crate::commands::hook::WslHookPlan::Command { script_path, hosts } => {
                                if let Err(err) = crate::commands::hook::write_hook_settings(
                                    c,
                                    &script_path,
                                    hook_port,
                                    false,
                                    None,
                                ) {
                                    eprintln!("[hooks] write settings failed: {err}");
                                }
                                hook_env.push(("PROMPTOPS_HOOK_HOSTS".into(), hosts));
                            }
                            crate::commands::hook::WslHookPlan::Skip => {
                                crate::commands::hook::cleanup_hook_settings(c);
                            }
                        }
                    } else {
                        // Per-process `--settings` file (repository untouched),
                        // same as the main session (session::install_claude_hooks).
                        match crate::commands::hook::ensure_hook_script() {
                            Ok(script) => crate::commands::session::install_claude_hooks(
                                c,
                                &script.to_string_lossy(),
                                hook_port,
                            ),
                            Err(err) => eprintln!("[hooks] script materialization failed: {err}"),
                        }
                    }
                }
                hook_env.push(("PROMPTOPS_HOOK_PORT".into(), hook_port.to_string()));
                hook_env.push((
                    crate::commands::agent_ctl::TOKEN_ENV.into(),
                    crate::commands::agent_ctl::token().into(),
                ));
            }
            hook_env.push(("PROMPTOPS_SESSION_ID".into(), session_id.clone()));
            if let Some(ref c) = cwd {
                hook_env.push(("PROMPTOPS_WORKSPACE".into(), c.clone()));
            }
            for (k, v) in &hook_env {
                cmd.env(k, v);
            }
            // WSL: without WSLENV the PROMPTOPS_* vars don't cross the distro
            // boundary (parallel fix to spawn_session_pty).
            if is_wsl {
                if let Some(v) = crate::commands::windows_shells::build_wsl_env_value(
                    std::env::var("WSLENV").ok().as_deref(),
                    None,
                    &hook_env,
                    &["PROMPTOPS_WORKSPACE"],
                ) {
                    cmd.env("WSLENV", v);
                }
            }
        }

        // Resolved provider account (explicit or inherited from the parent) → CLI
        // env.
        if let Some((env_var, config_dir, account_id)) = remote
            .is_none()
            .then(|| {
                crate::commands::provider_account::resolve_account_env(
                    &provider,
                    account_explicit.clone(),
                )
            })
            .flatten()
        {
            account_vars = crate::commands::provider_account::account_env_vars(
                env_var,
                &config_dir,
                &account_id,
            );
            crate::commands::provider_account::apply_account_env(&mut cmd, &account_vars);
        }

        // Native gemini/agy hooks (global CLI config): same
        // per-process attribution as claude above, so pane state
        // and resume key (agy `--conversation <id>`) reach sub-agents too.
        if remote.is_none() && !is_wsl {
            let gemini_home = account_vars
                .iter()
                .find(|(k, _)| k == "GEMINI_CLI_HOME")
                .map(|(_, v)| v.as_str());
            let provider_env = crate::commands::hook::provider_hook_env(&provider, gemini_home);
            if !provider_env.is_empty() {
                for (k, v) in &provider_env {
                    cmd.env(k, v);
                }
                cmd.env("PROMPTOPS_SESSION_ID", &session_id);
                if let Some(ref c) = cwd {
                    cmd.env("PROMPTOPS_WORKSPACE", c);
                }
            }
        }

        // Child kept for the reap (wait at EOF: no zombies) + killer for the
        // explicit teardown (same as spawn_session_pty).
        if crate::commands::termd_link::enabled() && !ephemeral {
            // PTY in termd: survives app crashes and restarts. Key =
            // conversation id (stable across restarts, unlike the
            // sub-agent id): a restored agent finds it again.
            let key = request
                .claude_session_id
                .clone()
                .or_else(|| fresh_claude_session_id.clone())
                .unwrap_or_else(|| sub_agent_id.clone());
            let (sink, termd_reader) = crate::commands::termd_link::reader_pair();
            let alive = request.claude_session_id.is_some()
                && crate::commands::termd_link::list()
                    .iter()
                    .any(|p| p.id == key && p.alive);
            if alive {
                crate::commands::termd_link::attach(&key, sink)?;
                reattached = true;
                eprintln!("[termd] re-attached to live agent {key}");
            } else {
                let argv = cmd.get_argv();
                let program = argv
                    .first()
                    .map(|a| a.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let args = argv
                    .iter()
                    .skip(1)
                    .map(|a| a.to_string_lossy().into_owned())
                    .collect();
                let spawn_cwd = cmd.get_cwd().map(|c| c.to_string_lossy().into_owned());
                let env = cmd
                    .iter_full_env_as_str()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect();
                crate::commands::termd_link::spawn(
                    &key,
                    program,
                    args,
                    spawn_cwd,
                    env,
                    DEFAULT_COLS,
                    DEFAULT_ROWS,
                    sink,
                )?;
            }
            drop(pair);
            killer = Mutex::new(Box::new(crate::commands::termd_link::TermdKiller(
                key.clone(),
            )));
            child = None;
            reader = Box::new(termd_reader);
            writer = Arc::new(Mutex::new(Box::new(
                crate::commands::termd_link::TermdWriter(key.clone()),
            )));
            shell = local_shell;
            pty = AgentPty::Termd {
                key,
                size: Mutex::new((DEFAULT_COLS, DEFAULT_ROWS)),
            };
        } else {
            let spawned = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
            killer = Mutex::new(spawned.clone_killer());
            child = Some(spawned);

            reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
            writer = Arc::new(Mutex::new(
                pair.master.take_writer().map_err(|e| e.to_string())?,
            ));
            shell = local_shell;
            pty = AgentPty::Local(pair);
        }
    }

    let view = SubAgentView {
        id: sub_agent_id.clone(),
        role: request.role.clone(),
        title: request.title.clone(),
        parent_session_id: request.parent_session_id.clone(),
        session_id: session_id.clone(),
        // A freshly spawned session starts as 'spawning' until the TUI is ready
        // and the prompt has been injected.
        status: SubAgentStatus::Spawning,
        auto_prompt: full_prompt.clone(),
        user_prompt: request.prompt.clone(),
        provider: provider.clone(),
        icon: request.icon.clone().unwrap_or_else(|| {
            if provider == "generic-shell" {
                "solar:terminal-bold-duotone".into()
            } else {
                "solar:cpu-bolt-bold-duotone".into()
            }
        }),
        // The imposed id is for all intents the conversation id: it serves
        // as the resume key and as the transcript key.
        claude_session_id: request
            .claude_session_id
            .clone()
            .or_else(|| fresh_claude_session_id.clone()),
        defer_prompt: request.defer_prompt,
        restored: request.restored,
        created_at: now.clone(),
        mode: Some(mode.clone()),
        custom_config: request.custom_config.clone(),
        soft_skill: soft_skill.clone(),
        ephemeral: request.ephemeral,
        execution_mode: None,
        model: sanitize_model_flag(request.model.as_deref()),
        effort: valid_effort(
            &provider,
            request.effort.as_deref(),
            request.model.as_deref(),
        )
        .map(str::to_string),
        // Boot overlay active until the pane is actually usable.
        // AI TUIs still need to boot and repaint history during restore.
        // Only a restored plain shell has no provider UI to wait for.
        prompt_pending: !(skip_prompt_replay && provider == "generic-shell"),
        slot: None,
        goal_driven: if goal_native { Some(true) } else { None },
    };

    spawn_mark(&sub_agent_id, "pty-ready");

    // Register the entry + index by parent BEFORE the pump starts: the pump
    // stops at its first read when it finds no entry ("destroyed"), so a
    // shell that printed before the insert used to leave a pane that never
    // showed any output.
    let (vt_cols, vt_rows) = pty.size().unwrap_or((120, 30));
    manager.agents.lock().insert(
        sub_agent_id.clone(),
        AgentEntry {
            view: view.clone(),
            interactive: Some(InteractiveAgent {
                pty,
                writer,
                buffer: Vec::new(),
                buffer_total: 0,
                vt: Arc::new(Mutex::new(crate::commands::term_state::TermState::new(
                    vt_cols, vt_rows,
                ))),
                deferred_size: None,
                killer,
                // The spawn opens the backup-Enter window too: the renderer
                // sends its Enter to restored panes as well, where nothing
                // was submitted.
                auto_submitted_at_ms: Some(epoch_ms()),
            }),
            worker: None,
            cwd: cwd.clone(),
            provider_account_id: account_explicit.clone(),
        },
    );
    manager
        .parent_index
        .lock()
        .entry(request.parent_session_id.clone())
        .or_default()
        .push(sub_agent_id.clone());

    // Output pump: dedicated thread. Updates the cumulative buffer and pushes
    // chunks to the renderer on `subagent:output`.
    let pump_id = sub_agent_id.clone();
    let pump_parent = request.parent_session_id.clone();
    let pump_manager = Arc::clone(manager);
    let pump_app = app.clone();
    let pump_ephemeral = ephemeral;
    // Reader→flusher coalescing (same pattern as terminal.rs): no send
    // per single micro-read, otherwise xterm renders partial TUI frames
    // (graphical glitches). The flusher drains coalesced chunks at COALESCE pace.
    let pump_state = Arc::new(crate::commands::terminal::PumpState::default());
    let rd_state = pump_state.clone();
    std::thread::spawn(move || {
        // 64KB like terminal.rs: fewer syscalls/locks on TUI redraw bursts.
        let mut buf = [0u8; 65536];
        let mut pty_exited = false;
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    pty_exited = true;
                    break;
                }
                Ok(n) => {
                    let chunk = &buf[..n];
                    // Accumulate in the agent's buffer (replay on subagent:buffer).
                    let vt = {
                        let mut agents = pump_manager.agents.lock();
                        if let Some(entry) = agents.get_mut(&pump_id) {
                            if let Some(ref mut inter) = entry.interactive {
                                push_capped(&mut inter.buffer, chunk);
                                // The total counts the bytes SEEN, not those
                                // retained: the cap trims the head but
                                // the live stream offset never goes back.
                                inter.buffer_total += chunk.len();
                                Some(inter.vt.clone())
                            } else {
                                None
                            }
                        } else {
                            // Entry gone → agent destroyed, stop.
                            break;
                        }
                    };
                    // Host screen outside the global lock (it counts its own bytes: `fed`).
                    if let Some(vt) = vt {
                        vt.lock().feed(chunk);
                    }
                    // SessionTailer: auto-approve on sub-agents too.
                    if let Some(tailer) = crate::commands::session_tailer::global_tailer() {
                        tailer.on_output(&pump_id, chunk);
                    }
                    // Ephemeral agents don't forward output (it goes to the review channel).
                    if !pump_ephemeral {
                        let _ = rd_state.push(chunk);
                    }
                }
            }
        }
        rd_state.mark_eof();
        // Child reap: without wait() every closed sub-agent stays a zombie
        // until the app closes (squads pile up dozens of them).
        if let Some(mut c) = child.take() {
            let _ = c.wait();
        }
        if pty_exited {
            // PTY closed → 'exited' (replica of session:status exited).
            {
                let mut agents = pump_manager.agents.lock();
                update_status(&pump_app, &mut agents, &pump_id, SubAgentStatus::Exited);
            }
            // Refresh the mirror: a dead agent must not come back
            // from the next restore (same as the push on status-changed).
            push_stash_snapshot(&pump_app, &pump_manager, &pump_parent);
        }
    });

    // Flusher: coalesced chunks → RAW frames on the global channel registered by the
    // bridge ([1B idLen][id][1B parentLen][parent][8B offset LE][chunk]):
    // no base64 or JSON per chunk (before: emit subagent:output with base64).
    // Channel missing/dead (webview reload) → drop, the replay covers the gap.
    //
    // The offset is that of the chunk's FIRST byte in the stream since spawn, i.e.
    // the same space as the `buffer_total` served by subagent_buffer: the bridge
    // uses it to dedup the replay against live without keeping its own counters (which a
    // webview reload would reset, while the PTY keeps going).
    let fl_id = sub_agent_id.clone();
    let fl_parent = request.parent_session_id.clone();
    let fl_manager = Arc::clone(manager);
    std::thread::spawn(move || {
        let id_b = fl_id.into_bytes();
        let parent_b = fl_parent.into_bytes();
        let framable = id_b.len() <= 255 && parent_b.len() <= 255;
        let mut sent_total: u64 = 0;
        while let Some(chunk) = pump_state.next_chunk() {
            let offset = sent_total;
            // ALWAYS advance, even if the channel is dead: the offset describes the
            // stream, not what was delivered.
            sent_total += chunk.len() as u64;
            let ch = fl_manager.output_channel.lock().clone();
            let watched = crate::commands::output_watchers::has_subagent_watchers();
            if framable && (ch.is_some() || watched) {
                let mut frame = Vec::with_capacity(10 + id_b.len() + parent_b.len() + chunk.len());
                frame.push(id_b.len() as u8);
                frame.extend_from_slice(&id_b);
                frame.push(parent_b.len() as u8);
                frame.extend_from_slice(&parent_b);
                frame.extend_from_slice(&offset.to_le_bytes());
                frame.extend_from_slice(&chunk);
                // Child windows (session opened in its own window): same copy of the frame.
                if watched {
                    crate::commands::output_watchers::send_subagent(&frame);
                }
                if let Some(ch) = ch {
                    let _ = ch.send(InvokeResponseBody::Raw(frame));
                }
            }
            std::thread::sleep(crate::commands::terminal::COALESCE);
        }
        pump_state.mark_dead();
    });

    // SessionTailer: auto-approve on the sub-agent PTY too (keyed by
    // subAgentId — the same id used by the output tap above).
    // Skipped on remote transports: it reads transcripts on the LOCAL fs.
    if remote.is_none() {
        if let Some(tailer) = crate::commands::session_tailer::global_tailer() {
            tailer.start_tailing(&sub_agent_id, &view.provider, cwd.as_deref().unwrap_or(""));
        }
    }

    // Emit creation (ephemeral agents invisible to the renderer).
    if !ephemeral {
        let emit_result = app.emit(
            "subagent:created",
            CreatedEvent {
                sub_agent: view.clone(),
                parent_session_id: request.parent_session_id.clone(),
            },
        );
        eprintln!(
            "[SubAgentManager] spawned {} (provider {}, parent {}) — emit created: {:?}",
            sub_agent_id,
            provider,
            request.parent_session_id,
            emit_result
                .err()
                .map(|e| e.to_string())
                .unwrap_or_else(|| "ok".into())
        );
        push_stash_snapshot(app, manager, &request.parent_session_id);
    }

    // Provider launch command inside the login shell (same as
    // spawn_session_pty → inject_when_ready). generic-shell stays a plain shell.
    // Parent AA read FRESH (the toggle can change after the first spawn:
    // the ParentContext cache would keep a stale value).
    let parent_auto_approve = {
        use tauri::Manager;
        app.state::<Arc<crate::commands::session::SessionManager>>()
            .parent_info(&request.parent_session_id)
            .map(|i| i.auto_approve)
            .unwrap_or(parent.auto_approve)
    };
    // Remote: account aliases and the `promptops` MCP server are LOCAL paths/processes
    // (the MCP config doesn't exist on the host and the app isn't reachable from there).
    let command_alias = remote
        .is_none()
        .then(|| {
            crate::commands::provider_account::resolve_account_command(
                &provider,
                account_explicit.clone(),
            )
        })
        .flatten();
    // WSL: the CLI runs inside the distro, where the MCP config path and the
    // node entry it names are Windows paths that do not resolve: no MCP rather
    // than a CLI that fails to start its servers.
    let mcp_sid = (remote.is_none() && !mcp_unreachable_shell(parent_shell.as_deref()))
        .then_some(session_id.as_str());
    let provider_spawned_at_ms = crate::commands::provider_session_probe::now_ms();
    // Re-attach to a live agent in termd: the provider is already running, the
    // launch line would land INSIDE the TUI.
    let launch_line = if reattached {
        None
    } else {
        build_subagent_launch(
            &provider,
            request.claude_session_id.as_deref(),
            &launch_flags,
            request.model.as_deref(),
            request.effort.as_deref(),
            parent_auto_approve,
            fresh_claude_session_id.as_deref(),
            command_alias.as_deref(),
            mcp_sid,
        )
    };
    if let Some(launch) = launch_line {
        let launch = match &remote {
            // Command: the line lands in the freshly connected REMOTE shell →
            // `cd` into the parent session's folder.
            Some(SubRemote::Cmd { path, .. }) if !path.is_empty() => {
                format!("cd {} && {launch}", crate::commands::remote::sh_quote(path))
            }
            Some(_) => launch,
            None => {
                match crate::commands::provider_account::account_shell_prefix(&account_vars, &shell)
                {
                    Some(prefix) => format!("{prefix} && {launch}"),
                    None => launch,
                }
            }
        };
        // Connection in progress (ssh/SSM): no injection during the handshake.
        let pacing = if remote.is_some() {
            LaunchPacing::SLOW_CONNECT
        } else {
            LaunchPacing::SHELL
        };
        // Fallback plans if the resume is rejected (same as the main sessions'
        // ResumeRecovery): without them, a `--resume` on a missing transcript
        // leaves the pane on a bare shell, mute and without context.
        let recovery = is_resume
            .then(|| request.claude_session_id.clone())
            .flatten()
            .map(|sid| SubAgentResumeRecovery {
                keep_id: (remote.is_none()
                    && crate::commands::session::provider_resume_family(&provider)
                        == "claude-code-cli"
                    && claude_supports_session_id())
                .then(|| {
                    build_subagent_launch(
                        &provider,
                        None,
                        &launch_flags,
                        request.model.as_deref(),
                        request.effort.as_deref(),
                        parent_auto_approve,
                        Some(&sid),
                        command_alias.as_deref(),
                        mcp_sid,
                    )
                })
                .flatten(),
                plain: build_subagent_launch(
                    &provider,
                    None,
                    &launch_flags,
                    request.model.as_deref(),
                    request.effort.as_deref(),
                    parent_auto_approve,
                    None,
                    command_alias.as_deref(),
                    mcp_sid,
                ),
                sid,
                restored: skip_prompt_replay,
                prompt: full_prompt.clone(),
                provider: provider.clone(),
                defer_prompt: request.defer_prompt.unwrap_or(false),
            });
        let launch_manager = Arc::clone(manager);
        let launch_id = sub_agent_id.clone();
        let launch_app = app.clone();
        std::thread::spawn(move || {
            inject_launch_when_ready(&launch_manager, &launch_id, &launch, pacing);
            if let Some(recovery) = recovery {
                recover_failed_subagent_resume(&launch_app, &launch_manager, &launch_id, &recovery);
            }
        });
    }

    if remote.is_none() && crate::commands::provider_session_probe::has_session_probe(&provider) {
        let probe_manager = Arc::clone(manager);
        let probe_app = app.clone();
        let probe_session_id = session_id.clone();
        let probe_parent_id = request.parent_session_id.clone();
        let probe_provider = provider.clone();
        let probe_cwd = cwd.clone().unwrap_or_default();
        let provider_home = crate::commands::provider_account::resolve_account_env(
            &provider,
            account_explicit.clone(),
        )
        .and_then(|(env_var, dir, _)| (env_var == Some("CODEX_HOME")).then_some(dir));
        std::thread::spawn(move || {
            if let Some(id) =
                crate::commands::provider_session_probe::probe_provider_session_id_in_home(
                    &probe_provider,
                    &probe_cwd,
                    provider_spawned_at_ms,
                    provider_home.as_deref(),
                )
            {
                if probe_manager
                    .set_claude_session_id(&probe_session_id, &id)
                    .is_some()
                {
                    push_stash_snapshot(&probe_app, &probe_manager, &probe_parent_id);
                }
            }
        });
    }

    // Only a fresh user request may inject the initial prompt. Restores
    // without a usable resume ID remain idle rather than repeat the task.
    if should_inject_initial_prompt(skip_prompt_replay, is_resume) {
        inject_prompt(
            app,
            manager,
            &sub_agent_id,
            &provider,
            &full_prompt,
            request.defer_prompt.unwrap_or(false),
            request.credit_prompt.unwrap_or(true),
        );
    } else if skip_prompt_replay && provider == "generic-shell" {
        // Listener restored → 'running': shell ready,
        // control to the user, no replay.
        let mgr = Arc::clone(manager);
        let id = sub_agent_id.clone();
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let mut agents = mgr.agents.lock();
            update_status(&app2, &mut agents, &id, SubAgentStatus::Idle);
        });
    } else {
        // Resume/restore: no injection, but the TUI still has to
        // boot (and redraw the history if available). We keep the veil until
        // it's ready, otherwise the pane reappears interactive on a
        // half-drawn boot screen. Safety timeout inside
        // wait_for_tui_ready: the veil never stays stuck.
        let mgr = Arc::clone(manager);
        let id = sub_agent_id.clone();
        let app2 = app.clone();
        let prov = provider.clone();
        std::thread::spawn(move || {
            let profile = crate::commands::tui_injection::injection_profile(&prov);
            if !wait_for_tui_ready(&mgr, &id, &prov, profile, profile.max_wait_ms) {
                return; // destroyed while waiting
            }
            let mut agents = mgr.agents.lock();
            // Resume failure detection runs concurrently with TUI readiness.
            // Do not overwrite its error (or a real turn's status).
            if agents
                .get(&id)
                .is_some_and(|e| e.view.status == SubAgentStatus::Spawning)
            {
                update_status(&app2, &mut agents, &id, SubAgentStatus::Idle);
            }
        });
    }

    Ok(view)
}

/// A restore is display-only, including when the provider cannot resume by ID.
fn should_inject_initial_prompt(restored: bool, is_resume: bool) -> bool {
    !restored && !is_resume
}

/// Prompt injection: ports the waitForTuiReady sequence (measured
/// per-provider profiles, see tui_injection.rs) → BPM-paste → Enter (with
/// submitWithRetry for verified providers) of `SubAgentManager.injectPrompt`.
fn inject_prompt(
    app: &tauri::AppHandle,
    manager: &Arc<SubAgentManager>,
    sub_agent_id: &str,
    provider: &str,
    auto_prompt: &str,
    defer_prompt: bool,
    count_prompt: bool,
) {
    let app = app.clone();
    let manager = Arc::clone(manager);
    let id = sub_agent_id.to_string();
    let provider = provider.to_string();
    let prompt = auto_prompt.to_string();

    std::thread::spawn(move || {
        // Keep the agent in 'spawning' for the whole injection (boot overlay).
        {
            let mut agents = manager.agents.lock();
            update_status(&app, &mut agents, &id, SubAgentStatus::Spawning);
        }

        let profile = crate::commands::tui_injection::injection_profile(&provider);
        // claude family: verified paste (marker "[Pasted text …]" or the
        // prompt's opening in the buffer) with bounded re-paste. A paste
        // arriving while the TUI showed a dialog (e.g. Chrome startup with
        // "Claude in Chrome" enabled by default) is silently
        // discarded: without verification the Enter fired on the dialog and the sub-agent
        // was left without a prompt.
        let verify_paste = paste_verification_enabled(&provider);
        let mut landed = !verify_paste;
        let mut budget_ms = profile.max_wait_ms;
        for attempt in 0..PASTE_MAX_ATTEMPTS {
            if !wait_for_tui_ready(&manager, &id, &provider, profile, budget_ms) {
                return; // destroyed while waiting
            }

            // Guard: if the provider died and the shell got the prompt back,
            // pasting the prompt here would EXECUTE it line by line as
            // commands. Better a pane in error than an accidental `git reset`.
            if provider != "generic-shell" {
                let at_shell = {
                    let agents = manager.agents.lock();
                    match agents.get(&id).and_then(|e| e.interactive.as_ref()) {
                        Some(inter) => shell_prompt_visible(&inter.buffer),
                        None => return,
                    }
                };
                if at_shell {
                    eprintln!("[SubAgentManager] {provider} TUI not running for {id} (shell prompt visible) — prompt NOT injected");
                    let mut agents = manager.agents.lock();
                    update_status(&app, &mut agents, &id, SubAgentStatus::Error);
                    return;
                }
                // Trust/update dialog: the choice is the user's.
                // Pane in waiting_input until they answer, then the injection
                // restarts from scratch (readiness included). Only before the
                // FIRST paste: afterwards the buffer contains the prompt itself, which
                // may quote those texts (handoff with earlier output). On
                // re-pastes the paste check applies: no blind Enter.
                let gate = if attempt == 0 {
                    wait_out_startup_dialog(&app, &manager, &id, &provider)
                } else {
                    DialogGate::None
                };
                match gate {
                    DialogGate::Abort => return,
                    DialogGate::Waited => {
                        if !wait_for_tui_ready(
                            &manager,
                            &id,
                            &provider,
                            profile,
                            PASTE_RETRY_BUDGET_MS,
                        ) {
                            return;
                        }
                    }
                    DialogGate::None => {}
                }
            }

            // BPM paste: the TUI treats the text as a single paste (without it, an inner
            // \r would submit halfway).
            let payload = format!("{}{}{}", BPM_START, prompt, BPM_END);
            // Writer cloned and agents lock released BEFORE the
            // write: a KB-sized paste can block until the TUI reads, and
            // the PTY reader needs the same lock to drain
            // the output (otherwise cross deadlock).
            let (paste_mark, writer) = {
                let agents = manager.agents.lock();
                match agents.get(&id).and_then(|e| e.interactive.as_ref()) {
                    Some(inter) => (inter.buffer.len(), inter.writer.clone()),
                    None => return, // destroyed halfway
                }
            };
            let _ = writer.lock().write_all(payload.as_bytes());

            if !verify_paste {
                break;
            }
            if wait_for_paste_evidence(&manager, &id, paste_mark, &prompt) {
                landed = true;
                if attempt > 0 {
                    eprintln!(
                        "[SubAgentManager] prompt paste landed on attempt {} for {id}",
                        attempt + 1
                    );
                    spawn_mark(&id, "prompt-landed");
                }
                break;
            }
            eprintln!(
                "[SubAgentManager] prompt paste NOT visible in {provider} TUI for {id} (attempt {}/{PASTE_MAX_ATTEMPTS}) — swallowed by a dialog or boot state, retrying",
                attempt + 1
            );
            budget_ms = PASTE_RETRY_BUDGET_MS;
        }

        if !landed {
            // Never seen in the TUI: no blind Enter (on a dialog it would
            // select the default). Control to the user.
            eprintln!("[SubAgentManager] prompt NOT injected for {id} after {PASTE_MAX_ATTEMPTS} attempts — handing control to the user");
            let mut agents = manager.agents.lock();
            update_status(&app, &mut agents, &id, SubAgentStatus::WaitingInput);
            return;
        }

        if defer_prompt {
            // Pasted but NOT submitted — control to the user (their
            // Enter will go through subagent_write, which already counts).
            let mut agents = manager.agents.lock();
            if let Some(inter) = agents.get_mut(&id).and_then(|e| e.interactive.as_mut()) {
                inter.auto_submitted_at_ms = None;
            }
            update_status(&app, &mut agents, &id, SubAgentStatus::WaitingInput);
            return;
        }

        // The Enter goes out only after enterDelayMs: the TUI must leave
        // bracketed-paste mode or the \r gets swallowed by the paste handler.
        std::thread::sleep(std::time::Duration::from_millis(profile.enter_delay_ms));
        if profile.submit_retry {
            submit_with_retry(&app, &manager, &id);
        } else {
            let writer = {
                let agents = manager.agents.lock();
                agents
                    .get(&id)
                    .and_then(|e| e.interactive.as_ref())
                    .map(|i| i.writer.clone())
            };
            if let Some(w) = writer {
                let _ = w.lock().write_all(b"\r");
            }
            let mut agents = manager.agents.lock();
            update_status(&app, &mut agents, &id, SubAgentStatus::InProgress);
        }
        // Auto-submitted prompt = a send for all intents: credit to the
        // parent (only once — submit retries don't come back through here).
        if count_prompt {
            crate::commands::session::credit_prompt_for(&app, &id, 1);
        }
        if let Some(inter) = manager
            .agents
            .lock()
            .get_mut(&id)
            .and_then(|e| e.interactive.as_mut())
        {
            inter.auto_submitted_at_ms = Some(epoch_ms());
        }
    });
}

enum DialogGate {
    /// No dialog: proceed.
    None,
    /// The user answered: redo readiness before the paste.
    Waited,
    /// Injection abandoned (pane destroyed, CLI exited, timeout).
    Abort,
}

/// If the TUI shows a startup dialog, hand control to the user
/// (waiting_input) and wait for their answer without sending keys.
fn wait_out_startup_dialog(
    app: &tauri::AppHandle,
    manager: &Arc<SubAgentManager>,
    id: &str,
    provider: &str,
) -> DialogGate {
    let sample = || {
        let agents = manager.agents.lock();
        agents
            .get(id)
            .and_then(|e| e.interactive.as_ref())
            .map(|inter| {
                (
                    startup_dialog_visible(&inter.buffer, provider),
                    shell_prompt_visible(&inter.buffer),
                )
            })
    };
    match sample() {
        Some((true, false)) => {}
        Some(_) => return DialogGate::None,
        None => return DialogGate::Abort,
    }
    eprintln!("[SubAgentManager] {provider} startup dialog visible for {id} — waiting for the user, no keys sent");
    {
        let mut agents = manager.agents.lock();
        update_status(app, &mut agents, id, SubAgentStatus::WaitingInput);
    }
    match wait_startup_dialog_cleared(&sample) {
        DialogWait::Destroyed => DialogGate::Abort,
        DialogWait::TimedOut => {
            eprintln!("[SubAgentManager] startup dialog still open for {id} — prompt NOT injected");
            // Never leave the pane in waiting_input for an expired wait.
            let mut agents = manager.agents.lock();
            update_status(app, &mut agents, id, SubAgentStatus::Idle);
            DialogGate::Abort
        }
        DialogWait::Cleared => {
            let at_shell = sample().is_none_or(|(_, at_shell)| at_shell);
            let mut agents = manager.agents.lock();
            if at_shell {
                // "No, quit" or update with exit: no paste into the shell.
                update_status(app, &mut agents, id, SubAgentStatus::Error);
                return DialogGate::Abort;
            }
            update_status(app, &mut agents, id, SubAgentStatus::Spawning);
            DialogGate::Waited
        }
    }
}

/// waitForTuiReady: polls the buffer every 50ms with the TuiReadinessTracker.
/// Returns false only if the agent was destroyed while waiting.
fn wait_for_tui_ready(
    manager: &Arc<SubAgentManager>,
    sub_agent_id: &str,
    provider: &str,
    profile: &'static crate::commands::tui_injection::TuiInjectionProfile,
    max_wait_ms: u128,
) -> bool {
    use crate::commands::tui_injection::{TuiReadiness, TuiReadinessTracker};
    if provider == "generic-shell" {
        std::thread::sleep(std::time::Duration::from_millis(500));
        return true;
    }
    // Providers with a known input box marker (claude/codex/gemini): the
    // heuristic burst/quiet is not enough — it can fire on a silent boot or
    // while the CLI waits for Chrome — so the marker is required in the tail
    // of the buffer, with a still screen. Budget exhausted = proceed anyway
    // (the post-paste check covers the rest).
    let markers = input_ready_markers(provider);

    const POLL_MS: u64 = 50;
    /// Floor "the PTY produced almost nothing" — independent of min_bytes.
    const NO_OUTPUT_BYTES: usize = 60;
    const NO_OUTPUT_TIMEOUT_MS: u128 = 10_000;

    let mut tracker = TuiReadinessTracker::new(profile);
    let start = std::time::Instant::now();
    let mut heuristic_ready: Option<&'static str> = None;
    let mut canonical_logged = false;

    let mut marker_last_len = 0usize;
    let mut marker_last_change_ms: u128 = 0;
    // Last gate state, to understand WHY a budget runs out.
    let mut last_gate: (bool, Option<bool>, usize, u128) = (false, None, 0, 0);
    loop {
        let elapsed = start.elapsed().as_millis();
        if elapsed >= max_wait_ms {
            let (seen, raw, blen, quiet) = last_gate;
            eprintln!(
                "[SubAgentManager] TUI ready budget ({max_wait_ms}ms) exhausted for {sub_agent_id} ({provider}) — proceeding [marker={seen} raw={raw:?} buffer={blen} quiet={quiet}ms]"
            );
            spawn_mark(sub_agent_id, "tui-budget-exhausted");
            return true; // budget exhausted: proceed anyway
        }
        let (len, raw_mode, marker_seen) = {
            let agents = manager.agents.lock();
            match agents
                .get(sub_agent_id)
                .and_then(|e| e.interactive.as_ref())
            {
                Some(inter) => (
                    inter.buffer.len(),
                    inter.pty.raw_mode(),
                    !markers.is_empty() && tail_has_marker(&inter.buffer, markers),
                ),
                None => return false, // destroyed while waiting
            }
        };
        if !markers.is_empty() {
            if len != marker_last_len {
                marker_last_len = len;
                marker_last_change_ms = elapsed;
            }
            last_gate = (marker_seen, raw_mode, len, elapsed - marker_last_change_ms);
            if marker_gate_ready(
                marker_seen,
                raw_mode,
                elapsed - marker_last_change_ms,
                MARKER_QUIET_MS,
            ) {
                eprintln!(
                    "[SubAgentManager] TUI ready after {elapsed}ms (buffer={len} bytes, input box marker, raw={raw_mode:?}, provider={provider})"
                );
                spawn_mark(sub_agent_id, "tui-ready");
                return true;
            }
            if len < NO_OUTPUT_BYTES && elapsed >= NO_OUTPUT_TIMEOUT_MS {
                eprintln!(
                    "[SubAgentManager] sub-agent produced only {len} bytes after {NO_OUTPUT_TIMEOUT_MS}ms — proceeding"
                );
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
            continue;
        }
        if heuristic_ready.is_none() {
            if let TuiReadiness::Ready(reason) = tracker.sample(elapsed, len) {
                heuristic_ready = Some(reason);
            }
        }
        if let Some(reason) = heuristic_ready {
            // Deterministic gate (unix): the paste goes out only with the slave
            // tty in raw mode. In canonical mode (node booting,
            // Ink hasn't called setRawMode yet) the kernel truncates the line at
            // MAX_INPUT=1024 bytes and drops the rest → prompt pasted halfway.
            if should_paste_now(raw_mode) {
                eprintln!(
                    "[SubAgentManager] TUI ready after {elapsed}ms (buffer={len} bytes, {reason}, raw={raw_mode:?}, provider={provider})"
                );
                return true;
            }
            if !canonical_logged {
                canonical_logged = true;
                eprintln!(
                    "[SubAgentManager] TUI heuristically ready after {elapsed}ms ({reason}) but slave tty still canonical — waiting for raw mode ({provider})"
                );
            }
        }
        if len < NO_OUTPUT_BYTES && elapsed >= NO_OUTPUT_TIMEOUT_MS {
            // Broken spawn or mute provider: don't burn the whole budget.
            eprintln!(
                "[SubAgentManager] sub-agent produced only {len} bytes after {NO_OUTPUT_TIMEOUT_MS}ms — proceeding"
            );
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
    }
}

/// `Some(true)` if the slave tty is in raw mode (ICANON off), i.e. the
/// TUI has taken stdin. On unix tcgetattr on the master returns the slave's
/// termios (BSD/Darwin: shared tty struct; Linux: tty_mode_ioctl
/// resolves `tty->link`). `None` where it can't be determined (Windows/ConPTY).
fn slave_in_raw_mode(master: &dyn MasterPty) -> Option<bool> {
    #[cfg(unix)]
    {
        let fd = master.as_raw_fd()?;
        let mut t: libc::termios = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(fd, &mut t) } != 0 {
            return None;
        }
        Some(t.c_lflag & libc::ICANON == 0)
    }
    #[cfg(not(unix))]
    {
        let _ = master;
        None
    }
}

/// The paste goes out when the tty is in raw mode; if the state can't
/// be determined we stay on the heuristic (previous behavior).
fn should_paste_now(raw_mode: Option<bool>) -> bool {
    raw_mode.unwrap_or(true)
}

/// Paste attempts for the claude family (post-paste check).
const PASTE_MAX_ATTEMPTS: usize = 3;
/// Wait budget for "input box ready" on re-pastes (the first attempt
/// uses `profile.max_wait_ms`).
const PASTE_RETRY_BUDGET_MS: u128 = 15_000;
/// Still screen required with the marker visible before pasting.
const MARKER_QUIET_MS: u128 = 400;
/// Window within which the paste must show up in the TUI.
const PASTE_EVIDENCE_WINDOW_MS: u128 = 2_500;

/// Deterministic gate for providers with a marker: input box seen in the tail,
/// tty raw (or undeterminable) and screen still for `quiet_ms`.
fn marker_gate_ready(
    marker_seen: bool,
    raw_mode: Option<bool>,
    quiet_for_ms: u128,
    quiet_ms: u128,
) -> bool {
    marker_seen && should_paste_now(raw_mode) && quiet_for_ms >= quiet_ms
}

/// Post-paste check only where the paste rendering is known: the claude
/// family collapses long pastes into "[Pasted text #N +M lines]" and shows
/// short ones verbatim in the input box.
pub(crate) fn paste_verification_enabled(provider: &str) -> bool {
    crate::commands::session::provider_resume_family(provider) == "claude-code-cli"
}

/// Comparable text: ANSI removed, all whitespace (NBSP included) removed — the TUI
/// fills with cursor-forward and wraps lines at variable width.
fn squash_for_match(text: &str) -> String {
    crate::commands::session::strip_ansi(text)
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{a0}')
        .collect()
}

/// Did the paste show up in the TUI? Looks for the collapsed-paste marker or
/// the opening of the prompt's first non-empty line in the output produced AFTER
/// the paste.
pub(crate) fn paste_evidence_seen(output_after_paste: &[u8], prompt: &str) -> bool {
    let out = squash_for_match(&String::from_utf8_lossy(output_after_paste));
    if out.contains("[Pastedtext") {
        return true;
    }
    let incipit: String = prompt
        .lines()
        .map(squash_for_match)
        .find(|l| !l.is_empty())
        .unwrap_or_default()
        .chars()
        .take(16)
        .collect();
    !incipit.is_empty() && out.contains(&incipit)
}

/// Polls (50ms) up to PASTE_EVIDENCE_WINDOW_MS: true as soon as the paste is
/// visible in the output after `paste_mark`.
fn wait_for_paste_evidence(
    manager: &Arc<SubAgentManager>,
    sub_agent_id: &str,
    paste_mark: usize,
    prompt: &str,
) -> bool {
    let start = std::time::Instant::now();
    loop {
        {
            let agents = manager.agents.lock();
            let Some(inter) = agents
                .get(sub_agent_id)
                .and_then(|e| e.interactive.as_ref())
            else {
                return false;
            };
            if inter.buffer.len() > paste_mark
                && paste_evidence_seen(&inter.buffer[paste_mark..], prompt)
            {
                return true;
            }
        }
        if start.elapsed().as_millis() >= PASTE_EVIDENCE_WINDOW_MS {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// submitWithRetry: only for providers quiet at idle whose Enter on empty
/// input is a no-op (gemini-cli, antigravity) — a real submit always
/// re-renders, so "buffer still after \r" can only mean a lost Enter.
fn submit_with_retry(app: &tauri::AppHandle, manager: &Arc<SubAgentManager>, sub_agent_id: &str) {
    const MAX_ATTEMPTS: usize = 3;
    const VERIFY_WINDOW_MS: u64 = 1_500;
    const MIN_GROWTH_BYTES: usize = 100;

    for _attempt in 0..MAX_ATTEMPTS {
        let (before, writer) = {
            let agents = manager.agents.lock();
            let Some(inter) = agents
                .get(sub_agent_id)
                .and_then(|e| e.interactive.as_ref())
            else {
                return;
            };
            (inter.buffer.len(), inter.writer.clone())
        };
        let _ = writer.lock().write_all(b"\r");
        std::thread::sleep(std::time::Duration::from_millis(VERIFY_WINDOW_MS));
        let after = {
            let agents = manager.agents.lock();
            match agents
                .get(sub_agent_id)
                .and_then(|e| e.interactive.as_ref())
            {
                Some(inter) => inter.buffer.len(),
                None => return,
            }
        };
        if after.saturating_sub(before) >= MIN_GROWTH_BYTES {
            let mut agents = manager.agents.lock();
            update_status(app, &mut agents, sub_agent_id, SubAgentStatus::InProgress);
            return;
        }
    }
    // Enter never accepted: control passes to the user.
    let mut agents = manager.agents.lock();
    update_status(app, &mut agents, sub_agent_id, SubAgentStatus::WaitingInput);
}

/// Worker spawn (headless): no PTY, structured transcript.
/// The real turn loop runs on TurnRunner (stream-json) → AI-side.
fn spawn_worker(
    app: &tauri::AppHandle,
    manager: &Arc<SubAgentManager>,
    request: &SpawnSubAgentRequest,
    sub_agent_id: &str,
    now: &str,
    provider: &str,
    account_explicit: Option<Option<String>>,
) -> Result<SubAgentView, String> {
    let session_id = format!("worker-{}", sub_agent_id);
    let restored = request.restored.unwrap_or(false);
    let ephemeral = request.ephemeral.unwrap_or(false);
    // Goal loop only with a live first turn: a restored worker starts idle and
    // its loop state died with the previous app.
    let goal_active = request.goal_spec.is_some() && !restored;

    // buildWorkerTurnOptions: the TurnRunner spawns via argv, so the
    // full preamble travels as a native system prompt + effort/permission
    // from the mode. Account env resolved on every turn.
    let mode = request.mode.clone().unwrap_or_else(|| {
        crate::commands::subagent_modes::default_mode_for_role(&request.role).to_string()
    });
    let mut cfg =
        crate::commands::subagent_modes::resolve_config(&mode, request.custom_config.as_ref());
    apply_effort_depth(
        &mut cfg,
        valid_effort(
            provider,
            request.effort.as_deref(),
            request.model.as_deref(),
        ),
    );
    let soft_skill =
        crate::commands::subagent_modes::sanitize_soft_skill(request.soft_skill.clone());
    let turn_opts = crate::commands::subagent_modes::build_worker_turn_options(
        &mode,
        &cfg,
        request.eco_level.as_deref(),
        soft_skill.as_ref(),
    );
    let mut turn_env: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Some((env_var, config_dir, account_id)) =
        crate::commands::provider_account::resolve_account_env(provider, account_explicit.clone())
    {
        turn_env.extend(crate::commands::provider_account::account_env_vars(
            env_var,
            &config_dir,
            &account_id,
        ));
    }

    let view = SubAgentView {
        id: sub_agent_id.to_string(),
        role: request.role.clone(),
        title: request.title.clone(),
        parent_session_id: request.parent_session_id.clone(),
        session_id,
        status: if restored {
            SubAgentStatus::Completed
        } else {
            SubAgentStatus::Running
        },
        auto_prompt: request.prompt.clone(),
        user_prompt: request.prompt.clone(),
        provider: provider.to_string(),
        icon: request
            .icon
            .clone()
            .unwrap_or_else(|| "solar:bolt-circle-bold-duotone".into()),
        claude_session_id: request.claude_session_id.clone(),
        defer_prompt: None,
        restored: request.restored,
        created_at: now.to_string(),
        mode: Some(mode.clone()),
        custom_config: request.custom_config.clone(),
        soft_skill: soft_skill.clone(),
        ephemeral: request.ephemeral,
        execution_mode: Some(ExecutionMode::Worker),
        model: sanitize_model_flag(request.model.as_deref()),
        effort: valid_effort(
            provider,
            request.effort.as_deref(),
            request.model.as_deref(),
        )
        .map(str::to_string),
        prompt_pending: false,
        slot: None,
        goal_driven: if goal_active { Some(true) } else { None },
    };

    manager.agents.lock().insert(
        sub_agent_id.to_string(),
        AgentEntry {
            view: view.clone(),
            interactive: None,
            worker: Some(WorkerAgent {
                transcript: Vec::new(),
                buffer: String::new(),
                input_line: String::new(),
                turn_in_flight: false,
                provider: provider.to_string(),
                cwd: request
                    .workspace_override
                    .clone()
                    .or_else(|| {
                        manager
                            .parents
                            .lock()
                            .get(&request.parent_session_id)
                            .and_then(|p| p.workspace_path.clone())
                    })
                    .unwrap_or_default(),
                provider_session_id: request.claude_session_id.clone(),
                current_run_id: None,
                current_turn_input: String::new(),
                current_turn_output: String::new(),
                turn_system_prompt: Some(turn_opts.system_prompt),
                turn_effort: Some(
                    valid_effort(
                        provider,
                        request.effort.as_deref(),
                        request.model.as_deref(),
                    )
                    .unwrap_or(turn_opts.effort)
                    .to_string(),
                ),
                turn_permission_mode: Some(turn_opts.permission_mode.to_string()),
                turn_disallowed: turn_opts.disallowed_tools,
                turn_env,
                model: sanitize_model_flag(request.model.as_deref()),
            }),
            cwd: request.workspace_override.clone().or_else(|| {
                manager
                    .parents
                    .lock()
                    .get(&request.parent_session_id)
                    .and_then(|p| p.workspace_path.clone())
            }),
            provider_account_id: account_explicit.clone(),
        },
    );
    manager
        .parent_index
        .lock()
        .entry(request.parent_session_id.clone())
        .or_default()
        .push(sub_agent_id.to_string());

    if !ephemeral {
        let _ = app.emit(
            "subagent:created",
            CreatedEvent {
                sub_agent: view.clone(),
                parent_session_id: request.parent_session_id.clone(),
            },
        );
        push_stash_snapshot(app, manager, &request.parent_session_id);
    }

    // Worker start: the first turn starts right away, headless
    // on the TurnRunner. A restored worker does NOT relaunch the original prompt —
    // it only gets the notice and waits for a message (skipFirstTurn).
    if restored {
        push_worker_item(
            app,
            manager,
            sub_agent_id,
            "notice",
            "Worker restored — send a message to continue the conversation.",
            None,
        );
    } else {
        // The mode preamble travels as a native system prompt; the squad
        // context (mode-filtered) is prepended ONLY to the first turn.
        let context_preamble = crate::commands::squad_context::build_context_preamble(
            &manager.squad_context.get(&request.parent_session_id),
            &mode,
        );
        let first_prompt = format!("{}{}", context_preamble, request.prompt);

        if goal_active {
            if let Some(spec) = request.goal_spec.as_ref() {
                let cwd = manager
                    .agents
                    .lock()
                    .get(sub_agent_id)
                    .and_then(|e| e.worker.as_ref().map(|w| w.cwd.clone()))
                    .unwrap_or_default();
                crate::commands::goal_loop::attach(
                    app,
                    manager,
                    sub_agent_id,
                    &request.parent_session_id,
                    &request.prompt,
                    &cwd,
                    spec,
                );
            }
        }

        if let Err(err) = worker_send_internal(app, manager, sub_agent_id, first_prompt) {
            eprintln!("[SubAgentManager] worker first turn failed for {sub_agent_id}: {err}");
        }
    }

    Ok(view)
}

/// Providers that support headless streaming turns: claude-code-cli, codex, gemini-cli, cursor.
fn is_stream_capable_provider(provider: &str) -> bool {
    matches!(
        provider,
        "claude-code-cli" | "codex" | "gemini-cli" | "cursor"
    )
}

// ── Commands: destroy ─────────────────────────────────────────────────

/// subagent:destroy — terminates a sub-agent, archives it (if not ephemeral),
/// cleans up the indexes and emits `subagent:destroyed`.
#[tauri::command]
pub async fn subagent_destroy(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SubAgentManager>>,
    sub_agent_id: String,
) -> Result<(), String> {
    let mut agents = manager.agents.lock();
    let Some(entry) = agents.remove(&sub_agent_id) else {
        // Already destroyed / stale id: emit destroyed anyway so the UI cleans up.
        let _ = app.emit(
            "subagent:destroyed",
            DestroyedEvent {
                sub_agent_id: sub_agent_id.clone(),
                parent_session_id: String::new(),
            },
        );
        return Ok(());
    };

    let parent_session_id = entry.view.parent_session_id.clone();
    if let Some(tailer) = crate::commands::session_tailer::global_tailer() {
        tailer.stop_tailing(&sub_agent_id);
    }
    let ephemeral = entry.view.ephemeral.unwrap_or(false);

    // Archive before destroying (ephemeral agents are never archived).
    if !ephemeral {
        archive_sub_agent(manager.inner(), &entry.view, entry.cwd.clone());
    }

    // Runtime destruction: explicit kill of the child + PTY drop
    // (master/slave/writer); the worker has no PTY.
    kill_entry(entry);

    // Clean up the parent index.
    {
        let mut idx = manager.parent_index.lock();
        if let Some(list) = idx.get_mut(&parent_session_id) {
            list.retain(|id| id != &sub_agent_id);
            if list.is_empty() {
                idx.remove(&parent_session_id);
            }
        }
    }

    drop(agents);

    // Goal loop: drop the state and cancel the in-flight evaluator, if any.
    crate::commands::goal_loop::detach(manager.inner(), &sub_agent_id);

    if !ephemeral {
        let _ = app.emit(
            "subagent:destroyed",
            DestroyedEvent {
                sub_agent_id,
                parent_session_id: parent_session_id.clone(),
            },
        );
        // Immediate push: a deliberate close must never come back from the
        // renderer's stale mirror.
        push_stash_snapshot(&app, manager.inner(), &parent_session_id);
    }
    Ok(())
}

/// Archive timestamp, RFC 3339 UTC with milliseconds (sorts as text too).
fn archived_at_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Archives the sub-agent meta (replica of `archiveSubAgent`, FIFO max 50).
fn archive_sub_agent(manager: &Arc<SubAgentManager>, view: &SubAgentView, cwd: Option<String>) {
    let entry = ArchivedSubAgentEntry {
        index: 0, // recomputed in list-archived
        role: view.role.clone(),
        title: view.title.clone(),
        user_prompt: view.user_prompt.clone(),
        icon: view.icon.clone(),
        mode: view.mode.clone(),
        soft_skill: view.soft_skill.clone(),
        // The agent's own provider: a codex conversation id resumed with
        // `claude --resume` can only fail.
        provider: view.provider.clone(),
        claude_session_id: view.claude_session_id.clone(),
        // RFC 3339: the resume modal shows it as "N minutes ago" and the store
        // ages archived entries out by it (30 days); `now_iso()` here gave
        // "NaN days ago" and entries that never expired.
        archived_at: archived_at_now(),
        parent_session_id: view.parent_session_id.clone(),
        parent_session_name: None,
        // The folder the CLI ran in: its transcript is indexed by it.
        workspace_path: cwd,
        can_resume: view.claude_session_id.is_some(),
    };

    let mut archived = manager.archived.lock();
    let list = archived.entry(view.parent_session_id.clone()).or_default();
    list.push(entry);
    while list.len() > MAX_ARCHIVED_PER_PARENT {
        list.remove(0); // FIFO
    }
}

// ── Commands: list ────────────────────────────────────────────────────

/// subagent:list — sub-agents of a parent, sorted by createdAt ASC, with
/// 1-based `slot` (for voice commands "focus sub-agent 2"). Excludes ephemeral.
#[tauri::command]
pub fn subagent_list(
    manager: tauri::State<'_, Arc<SubAgentManager>>,
    parent_session_id: String,
) -> Result<Vec<SubAgentView>, String> {
    let agents = manager.agents.lock();
    let idx = manager.parent_index.lock();

    let mut ordered: Vec<SubAgentView> = idx
        .get(&parent_session_id)
        .map(|ids| {
            ids.iter()
                .filter_map(|id| agents.get(id))
                .filter(|e| !e.view.ephemeral.unwrap_or(false))
                .map(|e| e.view.clone())
                .collect()
        })
        .unwrap_or_default();

    ordered.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    for (i, sa) in ordered.iter_mut().enumerate() {
        sa.slot = Some(i + 1);
    }
    eprintln!(
        "[subagent_list] parent {} -> {} agent(s)",
        parent_session_id,
        ordered.len()
    );
    Ok(ordered)
}

/// subagent:list-all — all sub-agents of all parents in a single IPC.
/// Used by the webapp boot sweep (discoverAllSubAgents): 1 call
/// instead of one per session. Same ephemeral filter and same per-parent
/// 1-based slot as subagent_list.
#[tauri::command]
pub fn subagent_list_all(
    manager: tauri::State<'_, Arc<SubAgentManager>>,
) -> Result<Vec<SubAgentView>, String> {
    let agents = manager.agents.lock();
    let idx = manager.parent_index.lock();

    let mut all: Vec<SubAgentView> = Vec::new();
    for ids in idx.values() {
        let mut ordered: Vec<SubAgentView> = ids
            .iter()
            .filter_map(|id| agents.get(id))
            .filter(|e| !e.view.ephemeral.unwrap_or(false))
            .map(|e| e.view.clone())
            .collect();
        ordered.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        for (i, sa) in ordered.iter_mut().enumerate() {
            sa.slot = Some(i + 1);
        }
        all.extend(ordered);
    }
    eprintln!("[subagent_list_all] -> {} agent(s)", all.len());
    Ok(all)
}

// ── Commands: write ───────────────────────────────────────────────────

/// subagent:write — writes input into the sub-agent's terminal. Workers
/// get line-buffered input (Enter submits the turn).
#[tauri::command]
pub async fn subagent_write(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SubAgentManager>>,
    sub_agent_id: String,
    data: String,
) -> Result<(), String> {
    let mut agents = manager.agents.lock();
    let entry = agents
        .get_mut(&sub_agent_id)
        .ok_or_else(|| format!("Agent not found: {}", sub_agent_id))?;

    if let Some(ref mut worker) = entry.worker {
        // Worker: line-buffered input with local echo.
        // TODO: submit the turn on Enter (TurnRunner) — AI-side.
        worker.input_line.push_str(&data);
        worker.buffer.push_str(&data);
        if worker.buffer.len() > MAX_WORKER_BUFFER_BYTES {
            let overflow = worker.buffer.len() - MAX_WORKER_BUFFER_BYTES;
            worker.buffer.drain(0..overflow);
        }
        return Ok(());
    }

    if entry.interactive.is_none() {
        return Err("Agent has no PTY".into());
    }
    drop(agents);
    // Counting (Enter / dialog-answer → credit to the parent) lives in write_to.
    manager.write_to(&sub_agent_id, &data, true)?;
    manager.note_user_input(&app, &sub_agent_id, &data);
    Ok(())
}

// ── Commands: in-place provider switch ────────────────────────────────

/// Payload of `subagent:updated` — a sub-agent's meta changed in
/// place (provider/model after a switch): the renderer merges by id.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatedEvent {
    pub sub_agent: SubAgentView,
    pub parent_session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchProviderRequest {
    pub sub_agent_id: String,
    pub provider: String,
    /// Handoff prompt (original task + context). As at spawn, it is
    /// preceded by the mode preamble and the squad context.
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
}

/// Does the buffer tail (ANSI-stripped) end with a shell prompt?
/// Heuristic: `%`/`$`/`#` (zsh/bash/root) — NEVER `>`, which is also the
/// claude/codex input prompt.
pub(crate) fn shell_prompt_visible(buf: &[u8]) -> bool {
    let tail_start = buf.len().saturating_sub(400);
    let tail = crate::commands::session::strip_ansi(&String::from_utf8_lossy(&buf[tail_start..]));
    let Some(line) = tail.trim_end().lines().last() else {
        return false;
    };
    let line = line.trim_end();
    if line.len() > 200 || !(line.ends_with('%') || line.ends_with('$') || line.ends_with('#')) {
        return false;
    }
    // A shell prompt has the form `user@host dir %` / `user@host:~/dir$` /
    // `~/dir $`: without this constraint a TUI status line ending in
    // "40%" would pass for a prompt.
    line.contains('@') || line.starts_with('~') || line.starts_with('/')
}

/// Exits the current TUI while staying in the PTY's login shell: Ctrl+C twice
/// (claude/codex/gemini/copilot/cursor/grok/opencode show
/// "press again to exit" on the first). NEVER Ctrl+D: if the TUI had already exited
/// it would close the shell and with it the sub-agent's PTY. Best-effort: after
/// two attempts we proceed anyway (the launch does kill-line first).
fn exit_tui_in_place(
    manager: &Arc<SubAgentManager>,
    sub_agent_id: &str,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
) {
    let sample = || {
        let agents = manager.agents.lock();
        agents
            .get(sub_agent_id)
            .and_then(|e| e.interactive.as_ref())
            .map(|inter| (inter.buffer.len(), shell_prompt_visible(&inter.buffer)))
    };
    if !exit_tui_with(&sample, writer) {
        eprintln!("[SubAgentManager] switch: shell prompt not detected for {sub_agent_id}, launching anyway");
    }
}

/// Generic version (sub-agent AND main session): `sample` returns
/// (buffer len, shell prompt visible) or None if the PTY is gone.
/// Returns true if the shell got its prompt back.
pub(crate) fn exit_tui_with(
    sample: &dyn Fn() -> Option<(usize, bool)>,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
) -> bool {
    let Some((before, _)) = sample() else {
        return false;
    };
    for _attempt in 0..2 {
        let _ = writer.lock().write_all(b"\x03");
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = writer.lock().write_all(b"\x03");
        let start = std::time::Instant::now();
        let mut last_len = 0usize;
        let mut last_change = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_millis(4_000) {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let Some((len, visible)) = sample() else {
                return false;
            };
            if len != last_len {
                last_len = len;
                last_change = std::time::Instant::now();
            }
            if len > before
                && visible
                && last_change.elapsed() >= std::time::Duration::from_millis(400)
            {
                std::thread::sleep(std::time::Duration::from_millis(200));
                return true;
            }
        }
    }
    false
}

/// Outcome of launching the provider in the PTY's shell.
pub(crate) enum LaunchOutcome {
    /// The TUI is running (output without returning to the shell prompt).
    Alive,
    /// The command exited right away (e.g. self-update "Please restart Codex",
    /// broken binary): the shell got its prompt back.
    Exited,
    Destroyed,
}

/// After `guarded_launch_line`: waits for the TUI to show signs of life or
/// for the shell to get its prompt back. Best-effort, short budget.
fn wait_launch_outcome(manager: &Arc<SubAgentManager>, sub_agent_id: &str) -> LaunchOutcome {
    let sample = || {
        let agents = manager.agents.lock();
        agents
            .get(sub_agent_id)
            .and_then(|e| e.interactive.as_ref())
            .map(|inter| (inter.buffer.len(), shell_prompt_visible(&inter.buffer)))
    };
    wait_launch_outcome_with(&sample)
}

/// Generic version: `sample` → (buffer len, shell prompt visible).
pub(crate) fn wait_launch_outcome_with(
    sample: &dyn Fn() -> Option<(usize, bool)>,
) -> LaunchOutcome {
    const BUDGET_MS: u128 = 12_000;
    const ALIVE_AFTER_MS: u128 = 2_500;
    let start = std::time::Instant::now();
    let mut last_len = 0usize;
    let mut last_change = std::time::Instant::now();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let Some((len, at_shell)) = sample() else {
            return LaunchOutcome::Destroyed;
        };
        if len != last_len {
            last_len = len;
            last_change = std::time::Instant::now();
        }
        let elapsed = start.elapsed().as_millis();
        if at_shell && len > 20 && last_change.elapsed() >= std::time::Duration::from_millis(600) {
            return LaunchOutcome::Exited;
        }
        if !at_shell && len > 100 && elapsed >= ALIVE_AFTER_MS {
            return LaunchOutcome::Alive;
        }
        if elapsed >= BUDGET_MS {
            return if at_shell {
                LaunchOutcome::Exited
            } else {
                LaunchOutcome::Alive
            };
        }
    }
}

/// After a "live" launch: waits for the TUI to be truly ready to read
/// input. In the switch the buffer starts out already full (launch echo, banner)
/// and the spawn tracker would declare "ready" at the first quiet — i.e.
/// while the CLI is still entering raw mode, where it drops input and the
/// paste is lost. Here we wait for: the provider's input box marker (if
/// known) or output still for QUIET_MS, with floor and cap.
fn settle_after_launch(manager: &Arc<SubAgentManager>, sub_agent_id: &str, provider: &str) {
    let sample = |markers: &[&str]| {
        let agents = manager.agents.lock();
        agents
            .get(sub_agent_id)
            .and_then(|e| e.interactive.as_ref())
            .map(|inter| (inter.buffer.len(), tail_has_marker(&inter.buffer, markers)))
    };
    if settle_after_launch_with(provider, &sample) {
        eprintln!("[SubAgentManager] switch: {provider} input box visible for {sub_agent_id}");
    }
}

/// Does the tail (6 KB, ANSI-stripped) contain one of the markers?
pub(crate) fn tail_has_marker(buf: &[u8], markers: &[&str]) -> bool {
    if markers.is_empty() {
        return false;
    }
    let tail_start = buf.len().saturating_sub(6_000);
    let tail = crate::commands::session::strip_ansi(&String::from_utf8_lossy(&buf[tail_start..]));
    markers.iter().any(|m| tail.contains(m))
}

/// "Input box ready" marker per provider family.
pub(crate) fn input_ready_markers(provider: &str) -> &'static [&'static str] {
    match crate::commands::session::provider_resume_family(provider) {
        "codex" => &["Ask Codex"],
        "claude-code-cli" => &["for shortcuts", "bypass permissions", "auto mode"],
        "gemini-cli" => &["Type your message"],
        // agy 1.3: line below the input box (absent in the trust dialog).
        "antigravity" => &["? for shortcuts"],
        _ => &[],
    }
}

/// CLI startup dialogs that ask the user for a DECISION: trust
/// in the folder (codex/claude/gemini/copilot) and update (codex).
/// An Enter injected there picks the default option instead of the user
/// (UX audit 10/2026: "Yes, continue" and "Update now" accepted on their own).
/// Lowercase markers without spaces: compared with `squash_for_match`.
const STARTUP_DIALOG_MARKERS: &[&str] = &["doyoutrust", "trustthisfolder", "yes,continue"];
/// Only codex asks for the update with a dialog; claude prints "Update
/// available" in the footer next to the input box (it's not a dialog).
const CODEX_UPDATE_DIALOG_MARKERS: &[&str] = &["updatenow"];

/// Is a startup dialog on screen? Only if its marker appears AFTER
/// the last input box marker: the buffer keeps the dialog text
/// even after the user has answered and the TUI has drawn the input.
pub(crate) fn startup_dialog_visible(buf: &[u8], provider: &str) -> bool {
    // Without an input box marker there's no way to know whether the dialog was already
    // answered (the text stays in the tail of an idle TUI): no gate,
    // 2.1.7 behavior unchanged for those providers.
    let ready_markers = input_ready_markers(provider);
    if ready_markers.is_empty() {
        return false;
    }
    let tail_start = buf.len().saturating_sub(6_000);
    let tail = squash_for_match(&String::from_utf8_lossy(&buf[tail_start..])).to_lowercase();
    let update_markers: &[&str] =
        if crate::commands::session::provider_resume_family(provider) == "codex" {
            CODEX_UPDATE_DIALOG_MARKERS
        } else {
            &[]
        };
    let Some(dialog_at) = STARTUP_DIALOG_MARKERS
        .iter()
        .chain(update_markers)
        .filter_map(|m| tail.rfind(m))
        .max()
    else {
        return false;
    };
    let ready_at = ready_markers
        .iter()
        .filter_map(|m| tail.rfind(&squash_for_match(m).to_lowercase()))
        .max();
    ready_at.is_none_or(|r| dialog_at > r)
}

pub(crate) enum DialogWait {
    /// Dialog resolved by the user (or the CLI went back to the shell: the
    /// caller checks it).
    Cleared,
    Destroyed,
    TimedOut,
}

/// Waits for the user to answer the startup dialog. `sample` → (dialog
/// visible, shell prompt visible) or None if the PTY is gone. No
/// key is ever sent from here.
pub(crate) fn wait_startup_dialog_cleared(sample: &dyn Fn() -> Option<(bool, bool)>) -> DialogWait {
    const BUDGET: std::time::Duration = std::time::Duration::from_secs(600);
    const STABLE_MS: u128 = 800;
    let start = std::time::Instant::now();
    let mut clear_since: Option<std::time::Instant> = None;
    loop {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let Some((dialog, at_shell)) = sample() else {
            return DialogWait::Destroyed;
        };
        if !dialog || at_shell {
            let since = *clear_since.get_or_insert_with(std::time::Instant::now);
            if since.elapsed().as_millis() >= STABLE_MS {
                return DialogWait::Cleared;
            }
        } else {
            clear_since = None;
        }
        if start.elapsed() >= BUDGET {
            return DialogWait::TimedOut;
        }
    }
}

/// Generic version: `sample(markers)` → (buffer len, marker seen).
/// Returns true if the input marker was seen.
pub(crate) fn settle_after_launch_with(
    provider: &str,
    sample: &dyn Fn(&[&str]) -> Option<(usize, bool)>,
) -> bool {
    const FLOOR_MS: u128 = 1_500;
    const QUIET_MS: u128 = 1_500;
    const CAP_MS: u128 = 10_000;
    const POLL_MS: u64 = 100;
    let markers = input_ready_markers(provider);
    let start = std::time::Instant::now();
    let mut last_len = 0usize;
    let mut last_change = std::time::Instant::now();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
        let Some((len, marker_seen)) = sample(markers) else {
            return false;
        };
        if len != last_len {
            last_len = len;
            last_change = std::time::Instant::now();
        }
        let elapsed = start.elapsed().as_millis();
        let quiet = last_change.elapsed().as_millis();
        if elapsed >= CAP_MS {
            return marker_seen;
        }
        if elapsed < FLOOR_MS {
            continue;
        }
        if marker_seen && quiet >= 400 {
            return true;
        }
        if markers.is_empty() && quiet >= QUIET_MS {
            return false;
        }
        // Known marker not seen yet: a long quiet still counts.
        if quiet >= QUIET_MS * 2 {
            return false;
        }
    }
}

/// subagent:switch-provider — switches a sub-agent's provider IN THE SAME
/// terminal: exits the current TUI, relaunches the new provider in the same
/// login shell (mode flags, model, parent AA) and injects the handoff
/// prompt with the same readiness/BPM as spawn. The pane stays in
/// `spawning` + `promptPending` (boot overlay) until the prompt is
/// submitted. Headless worker: only the meta changes, the next turn
/// (sent by the renderer) starts on the new provider.
#[tauri::command]
pub async fn subagent_switch_provider(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SubAgentManager>>,
    request: SwitchProviderRequest,
) -> Result<SubAgentView, String> {
    let provider = request.provider.clone();
    if provider == "generic-shell" {
        return Err("Cannot switch an agent to generic-shell".into());
    }
    let (parent_session_id, cwd, mode, custom_config, soft_skill, is_worker, writer) = {
        let agents = manager.agents.lock();
        let entry = agents
            .get(&request.sub_agent_id)
            .ok_or_else(|| format!("Agent not found: {}", request.sub_agent_id))?;
        (
            entry.view.parent_session_id.clone(),
            entry.cwd.clone(),
            entry.view.mode.clone().unwrap_or_else(|| {
                crate::commands::subagent_modes::default_mode_for_role(&entry.view.role).to_string()
            }),
            entry.view.custom_config.clone(),
            entry.view.soft_skill.clone(),
            entry.is_worker(),
            entry.interactive.as_ref().map(|i| i.writer.clone()),
        )
    };

    // Full prompt as at spawn: mode preamble (+ soft skill) + squad context.
    let cfg = crate::commands::subagent_modes::resolve_config(&mode, custom_config.as_ref());
    let preamble = crate::commands::subagent_modes::build_mode_preamble(
        &mode,
        &cfg,
        None,
        &provider,
        soft_skill.as_ref(),
    );
    let context_preamble = crate::commands::squad_context::build_context_preamble(
        &manager.squad_context.get(&parent_session_id),
        &mode,
    );
    let full_prompt = format!("{preamble}{context_preamble}{}", request.prompt);
    let launch_flags = crate::commands::subagent_modes::build_native_mode_flags(&cfg, &provider);
    let model = sanitize_model_flag(request.model.as_deref());
    let fresh_sid = (crate::commands::session::provider_resume_family(&provider)
        == "claude-code-cli"
        && claude_supports_session_id())
    .then(new_claude_session_id);
    // Conversation of the provider being left → recorded; that of the
    // target provider, if already used by this sub-agent → resumed.
    let resume_sid = {
        let (old_provider, old_sid) = {
            let agents = manager.agents.lock();
            let entry = agents.get(&request.sub_agent_id);
            (
                entry.map(|e| e.view.provider.clone()).unwrap_or_default(),
                entry.and_then(|e| e.view.claude_session_id.clone()),
            )
        };
        let mut convs = manager.provider_conversations.lock();
        let map = convs.entry(request.sub_agent_id.clone()).or_default();
        if let Some(sid) = old_sid.filter(|s| !s.is_empty()) {
            map.insert(
                crate::commands::session::provider_resume_family(&old_provider).to_string(),
                sid,
            );
        }
        let same_family = crate::commands::session::provider_resume_family(&old_provider)
            == crate::commands::session::provider_resume_family(&provider);
        map.get(crate::commands::session::provider_resume_family(&provider))
            .cloned()
            .filter(|_| !same_family && crate::commands::session::provider_resumes_by_id(&provider))
            .filter(|sid| crate::commands::session::is_safe_session_id(sid))
    };

    let account_id = manager
        .agents
        .lock()
        .get(&request.sub_agent_id)
        .and_then(|entry| entry.provider_account_id.clone());
    let command_alias =
        crate::commands::provider_account::resolve_account_command(&provider, account_id.clone());
    let turn_env = crate::commands::provider_account::resolve_account_env(&provider, account_id)
        .map(|(var, dir, id)| {
            crate::commands::provider_account::account_env_vars(var, &dir, &id)
                .into_iter()
                .collect()
        })
        .unwrap_or_default();

    // Meta updated + veil raised BEFORE touching the PTY.
    let view = {
        let mut agents = manager.agents.lock();
        let entry = agents
            .get_mut(&request.sub_agent_id)
            .ok_or_else(|| format!("Agent not found: {}", request.sub_agent_id))?;
        entry.view.provider = provider.clone();
        entry.view.model = model.clone();
        entry.view.effort = None;
        entry.view.claude_session_id = resume_sid.clone().or_else(|| fresh_sid.clone());
        entry.view.auto_prompt = full_prompt.clone();
        entry.view.status = SubAgentStatus::Spawning;
        entry.view.prompt_pending = true;
        if let Some(w) = entry.worker.as_mut() {
            w.provider = provider.clone();
            w.turn_env = turn_env;
            w.provider_session_id = None;
            w.model = model.clone();
        }
        entry.view.clone()
    };
    let _ = app.emit(
        "subagent:updated",
        UpdatedEvent {
            sub_agent: view.clone(),
            parent_session_id: parent_session_id.clone(),
        },
    );
    {
        let mut agents = manager.agents.lock();
        update_status(
            &app,
            &mut agents,
            &request.sub_agent_id,
            SubAgentStatus::Spawning,
        );
    }
    push_stash_snapshot(&app, manager.inner(), &parent_session_id);

    if is_worker {
        let mut agents = manager.agents.lock();
        update_status(
            &app,
            &mut agents,
            &request.sub_agent_id,
            SubAgentStatus::Running,
        );
        return Ok(view);
    }
    let Some(writer) = writer else {
        return Err("Agent has no PTY".into());
    };

    // Tailer (auto-approve) on the new provider.
    if let Some(tailer) = crate::commands::session_tailer::global_tailer() {
        tailer.stop_tailing(&request.sub_agent_id);
        tailer.start_tailing(
            &request.sub_agent_id,
            &provider,
            cwd.as_deref().unwrap_or(""),
        );
    }
    let parent_auto_approve = {
        use tauri::Manager;
        app.state::<Arc<crate::commands::session::SessionManager>>()
            .parent_info(&parent_session_id)
            .map(|i| i.auto_approve)
            .unwrap_or(false)
    };
    let mcp_sid = {
        use tauri::Manager;
        let shell = app
            .state::<Arc<crate::commands::session::SessionManager>>()
            .effective_shell_of(&parent_session_id);
        (!mcp_unreachable_shell(shell.as_deref())).then_some(request.sub_agent_id.as_str())
    };
    let fresh_launch = build_subagent_launch(
        &provider,
        None,
        &launch_flags,
        model.as_deref(),
        None,
        parent_auto_approve,
        fresh_sid.as_deref(),
        command_alias.as_deref(),
        mcp_sid,
    )
    .ok_or_else(|| format!("No launch command for provider {provider}"))?;
    let resume_launch = resume_sid.as_deref().and_then(|sid| {
        build_subagent_launch(
            &provider,
            Some(sid),
            &launch_flags,
            model.as_deref(),
            None,
            parent_auto_approve,
            None,
            command_alias.as_deref(),
            // Same MCP gate as the fresh launch: no Windows-path config
            // inside a WSL distro.
            mcp_sid,
        )
    });

    let mgr = Arc::clone(manager.inner());
    let id = request.sub_agent_id.clone();
    let app2 = app.clone();
    std::thread::spawn(move || {
        exit_tui_in_place(&mgr, &id, &writer);
        // Launch with retry: a CLI that self-updates and exits ("Update ran
        // successfully! Please restart Codex.") or a broken binary bring
        // the shell back to the prompt — relaunching is the only sensible thing, and NEVER
        // inject the handoff into a shell.
        const MAX_LAUNCH_ATTEMPTS: usize = 3;
        let mut alive = false;
        // Resume the previous conversation if there is one; if the CLI exits right away
        // (transcript gone) we fall back to a fresh launch.
        let mut launch = resume_launch
            .clone()
            .unwrap_or_else(|| fresh_launch.clone());
        for attempt in 1..=MAX_LAUNCH_ATTEMPTS {
            // Buffer reset: the new TUI's readiness tracker counts bytes
            // from the start as on a spawn; buffer_total stays monotonic, so
            // the replay dedup in the bridge doesn't notice anything.
            {
                let mut agents = mgr.agents.lock();
                match agents.get_mut(&id).and_then(|e| e.interactive.as_mut()) {
                    Some(inter) => inter.buffer.clear(),
                    None => return,
                }
            }
            let line = crate::commands::session::guarded_launch_line(&launch);
            let _ = writer.lock().write_all(line.as_bytes());
            match wait_launch_outcome(&mgr, &id) {
                LaunchOutcome::Alive => {
                    alive = true;
                    break;
                }
                LaunchOutcome::Destroyed => return,
                LaunchOutcome::Exited => {
                    eprintln!(
                        "[SubAgentManager] switch: {provider} exited right after launch (attempt {attempt}/{MAX_LAUNCH_ATTEMPTS}) for {id}"
                    );
                    if resume_launch.as_ref() == Some(&launch) {
                        eprintln!("[SubAgentManager] switch: resume failed for {id}, launching a fresh conversation");
                        launch = fresh_launch.clone();
                        if let Some(e) = mgr.agents.lock().get_mut(&id) {
                            e.view.claude_session_id = fresh_sid.clone();
                        }
                        if let Some(map) = mgr.provider_conversations.lock().get_mut(&id) {
                            map.remove(crate::commands::session::provider_resume_family(&provider));
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(700));
                }
            }
        }
        if !alive {
            let mut agents = mgr.agents.lock();
            update_status(&app2, &mut agents, &id, SubAgentStatus::Error);
            return;
        }
        settle_after_launch(&mgr, &id, &provider);
        inject_prompt(&app2, &mgr, &id, &provider, &full_prompt, false, true);
    });
    Ok(view)
}

// ── Commands: buffer ──────────────────────────────────────────────────

/// subagent:buffer — a sub-agent's terminal buffer (replay on
/// reopen). For workers it returns the text buffer.
///
/// RAW response, same contract as `session_buffer`: 8-byte u64 LE
/// endOffset + payload. The endOffset arms the byte-precise dedup of the live channel
/// in the bridge; 0 means "no live stream to dedup" (worker, unknown
/// agent), exactly as for parked sessions.
#[tauri::command]
pub async fn subagent_buffer(
    manager: tauri::State<'_, Arc<SubAgentManager>>,
    sub_agent_id: String,
) -> Result<tauri::ipc::Response, String> {
    // spawn_blocking: up to 512KB copied — jank on the main thread on every
    // pane attach/switch (same class as session_buffer).
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // VT replay: snapshot of the host screen, offset = bytes that produced it.
        if crate::commands::term_state::vt_replay_enabled() {
            let vt = manager
                .agents
                .lock()
                .get(&sub_agent_id)
                .and_then(|e| e.interactive.as_ref())
                .map(|i| i.vt.clone());
            if let Some(vt) = vt {
                let mut vt = vt.lock();
                if vt.fed() > 0 {
                    let payload = crate::commands::term_state::vt_replay_payload(&mut vt);
                    return Ok(tauri::ipc::Response::new(payload));
                }
            }
        }
        let (data, end_offset) = {
            let agents = manager.agents.lock();
            match agents.get(&sub_agent_id) {
                // getBuffer returns '' for an unknown id.
                None => (String::new(), 0u64),
                Some(entry) => {
                    if let Some(ref worker) = entry.worker {
                        (worker.buffer.clone(), 0)
                    } else if let Some(ref inter) = entry.interactive {
                        (
                            String::from_utf8_lossy(&inter.buffer).to_string(),
                            inter.buffer_total as u64,
                        )
                    } else {
                        (String::new(), 0)
                    }
                }
            }
        };
        let bytes = data.into_bytes();
        let mut payload = Vec::with_capacity(8 + bytes.len());
        payload.extend_from_slice(&end_offset.to_le_bytes());
        payload.extend_from_slice(&bytes);
        Ok(tauri::ipc::Response::new(payload))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Commands: resize ──────────────────────────────────────────────────

/// subagent:resize — resizes the sub-agent's PTY (no-op for workers).
#[tauri::command]
pub fn subagent_resize(
    manager: tauri::State<'_, Arc<SubAgentManager>>,
    sub_agent_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut agents = manager.agents.lock();
    let entry = agents
        .get_mut(&sub_agent_id)
        .ok_or_else(|| format!("Agent not found: {}", sub_agent_id))?;
    resize_agent(entry, cols, rows)
}

/// Resizes an agent's PTY. During startup a grid that is too small (many
/// stacked agents: 3-row panes) does not reach the PTY: Claude would not draw
/// its input box, the "ready" detection would not fire and the spawn would
/// wait 20 s. The size is kept in `deferred_size` and applied as soon as the
/// agent leaves 'spawning' (update_status): once running, small panes stay
/// small as before.
fn resize_agent(entry: &mut AgentEntry, cols: u16, rows: u16) -> Result<(), String> {
    let booting = entry.view.status == SubAgentStatus::Spawning;
    let id = entry.view.id.clone();
    let Some(inter) = entry.interactive.as_mut() else {
        return Ok(());
    };
    if booting && !crate::commands::session::pty_size_is_usable(cols, rows) {
        eprintln!("[resize] {cols}x{rows} deferred until startup ends for {id}");
        inter.deferred_size = Some((cols, rows));
        return Ok(());
    }
    inter.deferred_size = None;
    inter.pty.resize(cols, rows)?;
    if cols > 0 && rows > 0 {
        inter.vt.lock().resize(cols, rows);
    }
    Ok(())
}

// ── Commands: archive ─────────────────────────────────────────────────

/// subagent:list-archived — all archived entries across parents, sorted by
/// archivedAt DESC, enriched with the parent context (name/workspace).
#[tauri::command]
pub fn subagent_list_archived(
    manager: tauri::State<'_, Arc<SubAgentManager>>,
) -> Result<Vec<ArchivedSubAgentEntry>, String> {
    let archived = manager.archived.lock();
    let parents = manager.parents.lock();

    let mut entries: Vec<ArchivedSubAgentEntry> = Vec::new();
    for (parent_session_id, list) in archived.iter() {
        let parent = parents.get(parent_session_id);
        for (index, sa) in list.iter().enumerate() {
            let mut e = sa.clone();
            e.index = index;
            e.parent_session_name = parent.and_then(|p| p.session_name.clone());
            if e.workspace_path.is_none() {
                e.workspace_path = parent.and_then(|p| p.workspace_path.clone());
            }
            entries.push(e);
        }
    }
    // archivedAt DESC (most recent first).
    entries.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
    Ok(entries)
}

/// subagent:clear-archived — removes an archived entry by index.
#[tauri::command]
pub fn subagent_clear_archived(
    manager: tauri::State<'_, Arc<SubAgentManager>>,
    parent_session_id: String,
    index: usize,
) -> Result<(), String> {
    let mut archived = manager.archived.lock();
    if let Some(list) = archived.get_mut(&parent_session_id) {
        if index < list.len() {
            list.remove(index);
            if list.is_empty() {
                archived.remove(&parent_session_id);
            }
        }
    }
    Ok(())
}

// ── Commands: worker chat ─────────────────────────────────────────────

/// subagent:worker-transcript — the structured transcript (history on open/reopen).
#[tauri::command]
pub fn subagent_worker_transcript(
    manager: tauri::State<'_, Arc<SubAgentManager>>,
    sub_agent_id: String,
) -> Result<Vec<WorkerTranscriptItem>, String> {
    let agents = manager.agents.lock();
    Ok(agents
        .get(&sub_agent_id)
        .and_then(|e| e.worker.as_ref())
        .map(|w| w.transcript.clone())
        .unwrap_or_default())
}

/// subagent:worker-send — sends a message as the next turn.
/// Returns `false` when a turn is already in flight (replica of sendWorkerMessage).
#[tauri::command]
pub fn subagent_worker_send(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SubAgentManager>>,
    sub_agent_id: String,
    text: String,
) -> Result<bool, String> {
    worker_send_internal(&app, manager.inner(), &sub_agent_id, text)
}

/// Body of worker-send, reusable internally (first turn at spawn,
/// GoalLoopEngine continuations) without going through the Tauri State.
pub(crate) fn worker_send_internal(
    app: &tauri::AppHandle,
    manager: &Arc<SubAgentManager>,
    sub_agent_id: &str,
    text: String,
) -> Result<bool, String> {
    let mut agents = manager.agents.lock();
    let entry = agents
        .get_mut(sub_agent_id)
        .ok_or_else(|| format!("Agent not found: {}", sub_agent_id))?;
    let worker = entry.worker.as_mut().ok_or("Sub-agent is not a worker")?;

    if worker.turn_in_flight {
        return Ok(false); // "A turn is already running".
    }
    worker.turn_in_flight = true;

    // Add the 'user' row to the transcript and emit `subagent:worker-item`.
    let item = WorkerTranscriptItem {
        id: Uuid::new_v4().to_string(),
        kind: "user".into(),
        text: text.clone(),
        tool_name: None,
        at: now_iso(),
    };
    worker.transcript.push(item.clone());
    while worker.transcript.len() > MAX_TRANSCRIPT_ITEMS {
        worker.transcript.remove(0);
    }
    let parent_session_id = entry.view.parent_session_id.clone();
    drop(agents);

    // Read fresh on every turn: the user can turn auto-approve on or off
    // between turns (the session's switch, or the Auto Approve bar on the
    // session or on this agent).
    let auto_approve = crate::commands::interaction::session_auto_approve(app, &parent_session_id)
        || crate::commands::interaction::session_auto_approve(app, sub_agent_id);

    let _ = app.emit(
        "subagent:worker-item",
        WorkerItemEvent {
            sub_agent_id: sub_agent_id.to_string(),
            parent_session_id,
            item,
            replace: false,
        },
    );

    // ── Real turn on the TurnRunner (headless stream-json) ──
    let (provider, cwd, resume_id, sys_prompt, effort, perm_mode, disallowed, extra_env, model) = {
        let agents = manager.agents.lock();
        let w = agents
            .get(sub_agent_id)
            .and_then(|e| e.worker.as_ref())
            .ok_or("Sub-agent is not a worker")?;
        (
            w.provider.clone(),
            w.cwd.clone(),
            w.provider_session_id.clone(),
            w.turn_system_prompt.clone(),
            w.turn_effort.clone(),
            w.turn_permission_mode.clone(),
            w.turn_disallowed.clone(),
            w.turn_env.clone(),
            w.model.clone(),
        )
    };

    if !crate::commands::turn_runner::is_stream_capable(&provider) || cwd.is_empty() {
        // Provider without headless mode: unlock and report it in the transcript.
        finish_worker_turn(
            app,
            manager,
            sub_agent_id,
            "error",
            &format!("Provider \"{provider}\" has no headless (stream-json) mode"),
        );
        return Ok(true);
    }

    let Some(runner) = crate::commands::turn_runner::global_runner().cloned() else {
        finish_worker_turn(
            app,
            manager,
            sub_agent_id,
            "error",
            "TurnRunner unavailable",
        );
        return Ok(true);
    };

    let run_id = Uuid::new_v4().to_string();
    {
        let mut agents = manager.agents.lock();
        if let Some(w) = agents.get_mut(sub_agent_id).and_then(|e| e.worker.as_mut()) {
            w.current_run_id = Some(run_id.clone());
            // New turn: reset the accumulators for the summarizer.
            w.current_turn_input = text.clone();
            w.current_turn_output.clear();
        }
    }

    let opts = crate::commands::turn_runner::TurnSpawnOptions {
        run_id: run_id.clone(),
        provider,
        cwd,
        prompt: text,
        resume_session_id: resume_id,
        // Mode → native turn runtime (worker turn options) +
        // account env resolved at spawn.
        system_prompt: sys_prompt,
        effort,
        // Writing workers skip permission checks only in auto-approve;
        // otherwise they run in accept-edits (or are refused, see
        // `turn_runner::check_turn_supported`).
        permission_mode: perm_mode.map(|base| {
            crate::commands::subagent_modes::worker_turn_permission(&base, auto_approve).to_string()
        }),
        disallowed_tools: disallowed,
        env: extra_env,
        model,
        timeout_ms: Some(WORKER_TURN_TIMEOUT_MS),
        ..Default::default()
    };

    let app_ev = app.clone();
    let mgr_ev = Arc::clone(manager);
    let id_ev = sub_agent_id.to_string();
    let app_ex = app.clone();
    let mgr_ex = Arc::clone(manager);
    let id_ex = sub_agent_id.to_string();

    let spawned = runner.spawn(
        opts,
        move |event| handle_turn_event(&app_ev, &mgr_ev, &id_ev, event),
        move |result| {
            if let Some(err) = turn_exit_message(&result) {
                finish_worker_turn(&app_ex, &mgr_ex, &id_ex, "error", &err);
            } else {
                clear_turn_in_flight(&mgr_ex, &id_ex);
            }
        },
    );
    if let Err(err) = spawned {
        finish_worker_turn(app, manager, sub_agent_id, "error", &err);
    }
    Ok(true)
}

/// Error message for an abnormal exit, or None if the turn went fine
/// (exit 0, or canceled by the user: no error to show).
fn turn_exit_message(result: &crate::commands::turn_runner::TurnExitResult) -> Option<String> {
    if result.canceled {
        return None;
    }
    if result.timed_out {
        return Some("Turn timed out".into());
    }
    match result.exit_code {
        Some(0) => None,
        Some(code) => Some(if result.stderr.is_empty() {
            format!("Turn exited with code {code}")
        } else {
            result.stderr.clone()
        }),
        None => Some(if result.stderr.is_empty() {
            "Turn process failed to start".into()
        } else {
            result.stderr.clone()
        }),
    }
}

fn clear_turn_in_flight(manager: &Arc<SubAgentManager>, sub_agent_id: &str) {
    let mut agents = manager.agents.lock();
    if let Some(w) = agents.get_mut(sub_agent_id).and_then(|e| e.worker.as_mut()) {
        w.turn_in_flight = false;
        w.current_run_id = None;
    }
}

/// Appends a row to the transcript, emits it and (if `kind` is terminal)
/// unlocks the turn.
fn push_worker_item(
    app: &tauri::AppHandle,
    manager: &Arc<SubAgentManager>,
    sub_agent_id: &str,
    kind: &str,
    text: &str,
    tool_name: Option<String>,
) {
    let item = WorkerTranscriptItem {
        id: Uuid::new_v4().to_string(),
        kind: kind.to_string(),
        text: text.to_string(),
        tool_name,
        at: now_iso(),
    };
    let parent_session_id = {
        let mut agents = manager.agents.lock();
        let Some(entry) = agents.get_mut(sub_agent_id) else {
            return;
        };
        if let Some(w) = entry.worker.as_mut() {
            w.transcript.push(item.clone());
            while w.transcript.len() > MAX_TRANSCRIPT_ITEMS {
                w.transcript.remove(0);
            }
        }
        entry.view.parent_session_id.clone()
    };
    let _ = app.emit(
        "subagent:worker-item",
        WorkerItemEvent {
            sub_agent_id: sub_agent_id.to_string(),
            parent_session_id,
            item,
            replace: false,
        },
    );
}

fn finish_worker_turn(
    app: &tauri::AppHandle,
    manager: &Arc<SubAgentManager>,
    sub_agent_id: &str,
    kind: &str,
    text: &str,
) {
    push_worker_item(app, manager, sub_agent_id, kind, text, None);
    clear_turn_in_flight(manager, sub_agent_id);
    // Goal loop: a failed turn triggers the loop's auto-resume (or give-up).
    if kind == "error" && crate::commands::goal_loop::has(manager, sub_agent_id) {
        crate::commands::goal_loop::on_worker_error(app, manager, sub_agent_id, text);
    }
}

/// Normalizes a TurnEvent into transcript rows + sub-agent state.
fn handle_turn_event(
    app: &tauri::AppHandle,
    manager: &Arc<SubAgentManager>,
    sub_agent_id: &str,
    event: crate::commands::turn_runner::TurnEvent,
) {
    use crate::commands::turn_runner::TurnEvent as E;
    match event {
        E::AssistantText { delta, .. } => {
            {
                let mut agents = manager.agents.lock();
                if let Some(w) = agents.get_mut(sub_agent_id).and_then(|e| e.worker.as_mut()) {
                    w.current_turn_output.push_str(&delta);
                }
            }
            push_worker_item(app, manager, sub_agent_id, "assistant", &delta, None)
        }
        E::ToolCallStart { tool_name, .. } => push_worker_item(
            app,
            manager,
            sub_agent_id,
            "tool",
            &format!("→ {tool_name}"),
            Some(tool_name),
        ),
        E::FileEdit {
            path, edit_type, ..
        } => {
            // Squad context files_touched: deterministic append, no
            // LLM (files appended to the context store when the turn completes).
            let parent = {
                let agents = manager.agents.lock();
                agents
                    .get(sub_agent_id)
                    .map(|e| e.view.parent_session_id.clone())
            };
            if let Some(parent) = parent {
                manager
                    .squad_context
                    .append_files(&parent, std::slice::from_ref(&path));
            }
            crate::commands::goal_loop::on_file_edit(manager, sub_agent_id, &path);
            push_worker_item(
                app,
                manager,
                sub_agent_id,
                "notice",
                &format!("{edit_type}: {path}"),
                None,
            );
        }
        E::Error { message, .. } => {
            push_worker_item(app, manager, sub_agent_id, "error", &message, None)
        }
        E::ProviderSessionInit {
            provider_session_id,
            ..
        } => {
            // Persist the conversation id: later turns resume it.
            let mut agents = manager.agents.lock();
            if let Some(entry) = agents.get_mut(sub_agent_id) {
                if let Some(w) = entry.worker.as_mut() {
                    w.provider_session_id = Some(provider_session_id.clone());
                }
                entry.view.claude_session_id = Some(provider_session_id);
            }
        }
        E::Usage { usage, run_id } => {
            // Real provider usage → TokenTracker.
            use tauri::Manager;
            let tracker = app
                .state::<Arc<crate::commands::metrics::TokenTracker>>()
                .inner()
                .clone();
            let (parent, provider) = {
                let agents = manager.agents.lock();
                agents
                    .get(sub_agent_id)
                    .map(|e| (e.view.parent_session_id.clone(), e.view.provider.clone()))
                    .unwrap_or_default()
            };
            // Usage is aggregated on the PARENT (the UI shows the tokens
            // of the main session, the worker has no metrics card).
            if !parent.is_empty() {
                tracker.record_actual_usage_public(
                    app,
                    &parent,
                    usage.input_tokens,
                    usage.output_tokens,
                    usage.input_tokens + usage.output_tokens,
                    &provider,
                    Some(&run_id),
                    &crate::commands::metrics::UsageExtras {
                        cache_read: usage.cached_input_tokens.max(0),
                        ..Default::default()
                    },
                );
            }
            // Goal loop token budget (there is no per-worker
            // counter: usage is aggregated here, event by event).
            crate::commands::goal_loop::on_worker_usage(
                manager,
                sub_agent_id,
                (usage.input_tokens + usage.output_tokens).max(0) as u64,
            );
            // Every worker turn is a real model turn → count it as a
            // prompt on the parent (subagent:worker-turn-usage);
            // workers bypass PTY and tailer, this is
            // their only counter).
            if !parent.is_empty() {
                crate::commands::session::credit_prompt_for(app, &parent, 1);
            }
        }
        E::Done { .. } => {
            let turn = {
                let mut agents = manager.agents.lock();
                update_status(app, &mut agents, sub_agent_id, SubAgentStatus::Completed);
                agents.get_mut(sub_agent_id).and_then(|e| {
                    let parent = e.view.parent_session_id.clone();
                    e.worker.as_mut().map(|w| {
                        (
                            parent,
                            w.cwd.clone(),
                            std::mem::take(&mut w.current_turn_input),
                            std::mem::take(&mut w.current_turn_output),
                        )
                    })
                })
            };
            // Turn complete → squad slot summarizer (coalescing) +
            // goal loop evaluation (if the worker is goal-driven).
            if let Some((parent, cwd, turn_input, turn_output)) = turn {
                if !turn_output.trim().is_empty() {
                    enqueue_squad_summarize(
                        app,
                        manager,
                        &parent,
                        &cwd,
                        turn_input.clone(),
                        turn_output.clone(),
                    );
                }
                if crate::commands::goal_loop::has(manager, sub_agent_id) {
                    crate::commands::goal_loop::on_turn_done(
                        app,
                        manager,
                        sub_agent_id,
                        &turn_input,
                        &turn_output,
                    );
                }
            }
        }
        // tool_call_end / unknown: no transcript row.
        _ => {}
    }
}

/// subagent:worker-cancel — stops the in-flight turn (the worker stays alive).
#[tauri::command]
pub fn subagent_worker_cancel(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SubAgentManager>>,
    sub_agent_id: String,
) -> Result<(), String> {
    let canceled = worker_cancel_internal(manager.inner(), &sub_agent_id);
    // An explicit user stop on the turn also parks the goal loop:
    // without this it would hang in 'running' forever (the canceled
    // turn never produces a Done). The goal's stop() instead calls
    // worker_cancel_internal directly, so it doesn't come back through here.
    if canceled && crate::commands::goal_loop::has(manager.inner(), &sub_agent_id) {
        crate::commands::goal_loop::on_turn_canceled(&app, manager.inner(), &sub_agent_id);
    }
    Ok(())
}

/// Body of cancel, reusable by the GoalLoopEngine (loop stop). Returns
/// true if there really was an in-flight turn to kill.
pub(crate) fn worker_cancel_internal(manager: &Arc<SubAgentManager>, sub_agent_id: &str) -> bool {
    let run_id = {
        let mut agents = manager.agents.lock();
        let mut run_id = None;
        if let Some(entry) = agents.get_mut(sub_agent_id) {
            if let Some(ref mut worker) = entry.worker {
                run_id = worker.current_run_id.take();
                worker.turn_in_flight = false;
            }
        }
        run_id
    };
    // Kill the in-flight turn: onExit will fire with canceled = true.
    if let Some(run_id) = run_id {
        if let Some(runner) = crate::commands::turn_runner::global_runner() {
            runner.cancel(&run_id);
        }
        true
    } else {
        false
    }
}

// ── Commands: suggestions ─────────────────────────────────────────────

/// `SubAgentSuggestion` — the view returned by get-suggestions.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAgentSuggestion {
    pub id: String,
    pub role: String,
    pub title: String,
    pub description: String,
    pub incentive: String,
    pub auto_prompt: String,
    pub relevance_score: f64,
    pub icon: String,
    pub category: String, // "quality" | "speed" | "safety"
    pub parent_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

/// subagent:get-suggestions — contextual suggestions for a session's
/// workspace. The real pipeline is WorkspaceAnalyzer + SuggestionEngine.
///
/// // TODO: implement workspace analysis + suggestion generation
/// (static repo analysis + scoring). For now we return an empty list
/// (always, and in particular when there is no workspace).
#[tauri::command]
pub async fn subagent_get_suggestions(
    manager: tauri::State<'_, Arc<SubAgentManager>>,
    session_id: String,
    workspace_path: Option<String>,
) -> Result<Vec<SubAgentSuggestion>, String> {
    // Resolve the workspace: first from the session, then from the override.
    let resolved_workspace = manager
        .parents
        .lock()
        .get(&session_id)
        .and_then(|p| p.workspace_path.clone())
        .or(workspace_path);

    if resolved_workspace.is_none() {
        // No workspace → no suggestions.
        return Ok(Vec::new());
    }

    // TODO: WorkspaceAnalyzer + SuggestionEngine (AI-side).
    Ok(Vec::new())
}

// ── Command: stash restore (SUBAGENT_RESTORE_STASH) ────────────

/// Stash entry coming back from the renderer. Untrusted IPC input:
/// field whitelist + string caps during sanitize.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreStashEntry {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub execution_mode: Option<ExecutionMode>,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub user_prompt: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    /// Renderer contract: `Record<string, unknown>` — accepts Value and
    /// stringifies afterwards, or a single non-string value would break the
    /// deserialization of the ENTIRE restore command.
    #[serde(default)]
    pub config: Option<serde_json::Value>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub claude_session_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub soft_skill: Option<crate::commands::subagent_modes::SoftSkill>,
}

/// Stash config → spawn string→string map (non-strings are
/// stringified, matching the renderer's `Record<string, unknown>` passthrough).
fn stash_config_to_map(
    value: &serde_json::Value,
) -> Option<std::collections::HashMap<String, String>> {
    let obj = value.as_object()?;
    if obj.is_empty() {
        return None;
    }
    Some(
        obj.iter()
            .map(|(k, v)| {
                let s = match v {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                (k.clone(), s)
            })
            .collect(),
    )
}

/// subagent:restore-stash — the renderer hands back its localStorage stash
/// for a HOT-restored session (boot, wake): respawn of every entry via
/// do_spawn (resume with claudeSessionId when present). Idempotent: skips if
/// the parent already has live sub-agents or a restore in flight.
#[tauri::command]
pub async fn subagent_restore_stash(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SubAgentManager>>,
    session_id: String,
    sub_agents: Vec<RestoreStashEntry>,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let sessions = app
        .state::<Arc<crate::commands::session::SessionManager>>()
        .inner()
        .clone();
    let Some(local_id) = sessions.resolve_local_id(&session_id) else {
        return Ok(serde_json::json!({ "ok": false, "error": "session not found" }));
    };
    if sessions.is_standby(&local_id) {
        // Parked: the wake will pass the stash again via wakeSession → no-op here.
        return Ok(serde_json::json!({ "ok": true, "seeded": false }));
    }
    if manager.live_pane_count(&local_id) > 0 {
        return Ok(serde_json::json!({ "ok": true, "skipped": "live-subs" }));
    }
    // Sanitize: bounds + required fields.
    let clean: Vec<RestoreStashEntry> = sub_agents
        .into_iter()
        .take(MAX_STASH_ENTRIES)
        .filter(|e| !e.role.is_empty() && !e.title.is_empty())
        .collect();
    if clean.is_empty() {
        return Ok(serde_json::json!({ "ok": true, "restored": 0 }));
    }
    // Guard against double invoke (seedRestore runs on every sessions load).
    {
        let mut restoring = manager.restoring.lock();
        if !restoring.insert(local_id.clone()) {
            return Ok(serde_json::json!({ "ok": true, "skipped": "already-restoring" }));
        }
    }
    let restored = clean.len();
    let mgr = manager.inner().clone();
    let app2 = app.clone();
    std::thread::spawn(move || {
        // Wait for the parent to be ready (PTY alive), max 15s.
        let start = std::time::Instant::now();
        loop {
            match sessions.get(&local_id) {
                None => {
                    mgr.restoring.lock().remove(&local_id);
                    return; // session destroyed in the meantime
                }
                Some(s) => {
                    if s.standby_at.is_some() {
                        mgr.restoring.lock().remove(&local_id);
                        return; // re-parked: the stash stays for the wake
                    }
                    if matches!(
                        s.status.as_str(),
                        "running" | "in_progress" | "idle" | "completed" | "waiting_input"
                    ) {
                        break;
                    }
                    // Lead closed = no session PTY to
                    // wait for, sub-agents are restored right away.
                    if crate::commands::agents::is_lead_closed(&sessions, &local_id) {
                        break;
                    }
                }
            }
            if start.elapsed().as_secs() >= 15 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if mgr.live_pane_count(&local_id) == 0 {
            for e in clean {
                let prompt = e
                    .user_prompt
                    .clone()
                    .filter(|p| !p.is_empty())
                    .unwrap_or_else(|| e.prompt.clone());
                let request = SpawnSubAgentRequest {
                    parent_session_id: local_id.clone(),
                    role: cap_str(&e.role, MAX_STASH_ROLE),
                    title: cap_str(&e.title, MAX_STASH_TITLE),
                    prompt: cap_str(&prompt, MAX_STASH_PROMPT),
                    provider: e.provider,
                    model: e.model.clone(),
                    effort: e.effort.clone(),
                    icon: e.icon,
                    mode: e.mode,
                    custom_config: e.config.as_ref().and_then(stash_config_to_map),
                    soft_skill: crate::commands::subagent_modes::sanitize_soft_skill(e.soft_skill),
                    claude_session_id: e.claude_session_id,
                    defer_prompt: None,
                    eco_level: None,
                    provider_account_id: None,
                    restored: Some(true),
                    ephemeral: None,
                    workspace_override: e.workspace_path,
                    execution_mode: e.execution_mode,
                    goal_spec: None,
                    credit_prompt: None,
                };
                if let Err(err) = do_spawn(&app2, &mgr, request) {
                    eprintln!("[SubAgentManager] restore stash spawn failed: {err}");
                }
            }
        }
        mgr.restoring.lock().remove(&local_id);
    });
    Ok(serde_json::json!({ "ok": true, "restored": restored }))
}

#[cfg(test)]
mod reasoning_effort_tests {
    use super::*;

    #[test]
    fn promptops_cli_subagent_uses_registered_binary() {
        assert_eq!(
            build_subagent_launch(
                "promptops-cli",
                None,
                "",
                None,
                None,
                false,
                None,
                None,
                None
            )
            .as_deref(),
            Some("promptops-cli\r")
        );
    }

    #[test]
    fn existing_alias_reaches_launch_and_resume_for_every_provider() {
        for provider in [
            "claude-code-cli",
            "codex",
            "gemini-cli",
            "copilot",
            "cursor",
            "grok",
            "hermes",
            "antigravity",
            "opencode",
            "zai",
            "kimi",
            "promptops-cli",
        ] {
            for resume in [None, Some("12345678-1234-1234-1234-123456789abc")] {
                let default = build_subagent_launch(
                    provider, resume, "", None, None, false, None, None, None,
                )
                .unwrap();
                let custom = build_subagent_launch(
                    provider,
                    resume,
                    "",
                    None,
                    None,
                    false,
                    None,
                    Some("provider-work"),
                    None,
                )
                .unwrap();
                assert!(custom.starts_with("provider-work"));
                assert_eq!(
                    custom.strip_prefix("provider-work").unwrap(),
                    &default[default.find(char::is_whitespace).unwrap()..]
                );
            }
        }
    }

    #[test]
    fn effort_reaches_interactive_launch_and_resume() {
        for provider in ["claude-code-cli", "codex"] {
            for effort in ["low", "medium", "high", "xhigh"] {
                for resume in [None, Some("12345678-1234-1234-1234-123456789abc")] {
                    let command = build_subagent_launch(
                        provider,
                        resume,
                        "",
                        None,
                        Some(effort),
                        false,
                        None,
                        None,
                        None,
                    )
                    .unwrap();
                    let expected = if provider == "codex" {
                        format!("-c 'model_reasoning_effort=\"{effort}\"'")
                    } else {
                        format!("--effort {effort}")
                    };
                    assert!(command.contains(&expected), "{command}");
                    if let Some(id) = resume {
                        assert!(command.contains(id));
                    }
                }
            }
        }
    }

    #[test]
    fn grok_copilot_opencode_hermes_get_model_and_effort() {
        let line = |p: &str, m: &str, e: &str| {
            build_subagent_launch(p, None, "", Some(m), Some(e), false, None, None, None).unwrap()
        };
        let grok = line("grok", "grok-4", "max");
        assert!(grok.starts_with("grok -m grok-4 --effort max"), "{grok}");
        let copilot = line("copilot", "gpt-6", "xhigh");
        assert!(
            copilot.starts_with("copilot --model gpt-6 --effort xhigh"),
            "{copilot}"
        );
        let opencode = line("opencode", "openai/gpt-6", "high");
        assert!(
            opencode.starts_with("opencode -m openai/gpt-6"),
            "{opencode}"
        );
        assert!(!opencode.contains("--effort"), "{opencode}");
        let hermes = line("hermes", "hermes-4", "high");
        assert!(hermes.starts_with("hermes -m hermes-4"), "{hermes}");
        // A level the CLI does not accept is dropped, never passed through.
        assert!(!line("copilot", "gpt-6", "max").contains("--effort"));
    }

    #[test]
    fn effort_validation_and_prompt_precedence() {
        assert_eq!(valid_effort("codex", Some("max"), None), None);
        assert_eq!(valid_effort("grok", Some("max"), None), Some("max"));
        assert_eq!(valid_effort("copilot", Some("xhigh"), None), Some("xhigh"));
        assert_eq!(valid_effort("copilot", Some("max"), None), None);
        assert_eq!(valid_effort("opencode", Some("high"), None), None);
        assert_eq!(
            valid_effort("claude-code-cli", Some("max"), None),
            Some("max")
        );
        assert_eq!(
            valid_effort("claude-code-cli", Some("high"), Some("claude-haiku-4-5")),
            None
        );
        for provider in ["claude-code-cli", "codex", "generic-shell"] {
            assert_eq!(
                valid_effort(provider, Some("high; echo injected"), None),
                None
            );
        }
        let mut cfg = crate::commands::subagent_modes::resolve_config("detective", None);
        apply_effort_depth(&mut cfg, Some("low"));
        let worker = crate::commands::subagent_modes::build_worker_turn_options(
            "detective",
            &cfg,
            None,
            None,
        );
        assert_eq!(worker.effort, "low");
        assert!(worker.system_prompt.contains("reasoning_depth: LOW"));
    }

    #[test]
    fn effort_stash_accepts_old_and_new_entries() {
        let old: RestoreStashEntry =
            serde_json::from_value(serde_json::json!({"role":"custom","title":"Old"})).unwrap();
        assert_eq!(old.effort, None);
        let restored: RestoreStashEntry = serde_json::from_value(serde_json::json!({
            "role":"custom", "title":"New", "provider":"codex", "model":"gpt-5.5",
            "effort":"xhigh", "executionMode":"worker"
        }))
        .unwrap();
        assert_eq!(restored.effort.as_deref(), Some("xhigh"));
        assert_eq!(restored.model.as_deref(), Some("gpt-5.5"));
        assert!(matches!(
            restored.execution_mode,
            Some(ExecutionMode::Worker)
        ));
    }
}

#[cfg(test)]
mod restore_prompt_tests {
    use super::*;

    #[test]
    fn restart_never_replays_a_task_even_without_a_resume_id() {
        assert!(!should_inject_initial_prompt(true, true));
        assert!(!should_inject_initial_prompt(true, false));
        assert!(!should_inject_initial_prompt(false, true));
        assert!(should_inject_initial_prompt(false, false));
    }

    #[test]
    fn paste_waits_for_raw_mode_when_known() {
        assert!(should_paste_now(Some(true)));
        assert!(!should_paste_now(Some(false)));
        assert!(should_paste_now(None));
    }

    #[test]
    fn marker_gate_needs_marker_raw_and_quiet_screen() {
        assert!(marker_gate_ready(true, Some(true), 400, 400));
        assert!(marker_gate_ready(true, None, 400, 400));
        assert!(!marker_gate_ready(false, Some(true), 4_000, 400));
        assert!(!marker_gate_ready(true, Some(false), 4_000, 400));
        assert!(!marker_gate_ready(true, Some(true), 100, 400));
    }

    #[test]
    fn paste_evidence_matches_collapsed_paste_marker() {
        // Real frame: the TUI fills with cursor-forward, spaces disappear.
        let out =
            b"\x1b[2K\r\xe2\x9d\xaf\xc2\xa0[Pasted\x1b[1Ctext\x1b[1C#2\x1b[1C+31\x1b[1Clines]";
        assert!(paste_evidence_seen(
            out,
            "You are a specialized sub-agent\nline 2"
        ));
    }

    #[test]
    fn paste_evidence_matches_wrapped_short_prompt() {
        let out = b"\r\xe2\x9d\xaf Fix the failing\r\n  test in\r\n  version.ts";
        assert!(paste_evidence_seen(
            out,
            "\n\nFix the failing test in version.ts"
        ));
    }

    #[test]
    fn paste_evidence_rejects_unrelated_output() {
        let out = b"\x1b[?2004h Connecting to Chrome... \xe2\x8f\xb5\xe2\x8f\xb5 auto mode on";
        assert!(!paste_evidence_seen(out, "You are a specialized sub-agent"));
        assert!(!paste_evidence_seen(b"", "anything"));
        assert!(!paste_evidence_seen(out, "   \n  "));
    }

    #[test]
    fn paste_verification_only_for_claude_family() {
        assert!(paste_verification_enabled("claude-code-cli"));
        assert!(paste_verification_enabled("zai"));
        assert!(!paste_verification_enabled("codex"));
        assert!(!paste_verification_enabled("gemini-cli"));
        assert!(!paste_verification_enabled("generic-shell"));
    }
}

#[cfg(test)]
mod account_switch_tests {
    use super::*;

    fn parent(account: Option<&str>) -> crate::commands::session::ParentSessionInfo {
        crate::commands::session::ParentSessionInfo {
            workspace_path: Some("/workspace".into()),
            provider: Some("claude-code-cli".into()),
            provider_account_id: account.map(str::to_string),
            name: Some("Session".into()),
            auto_approve: false,
        }
    }

    #[test]
    fn restored_agent_uses_switched_account_without_app_restart() {
        let manager = SubAgentManager::default();
        manager
            .parent_for_spawn("session", Some(parent(Some("personal"))))
            .unwrap();
        let switched = manager
            .parent_for_spawn("session", Some(parent(Some("work"))))
            .unwrap();
        assert_eq!(switched.provider_account_id.as_deref(), Some("work"));
        assert_eq!(
            manager.parents.lock()["session"]
                .provider_account_id
                .as_deref(),
            Some("work")
        );
        let inherited = manager
            .parent_for_spawn("session", Some(parent(None)))
            .unwrap();
        assert_eq!(inherited.provider_account_id, None);
    }

    #[test]
    fn titles_taken_in_the_session_get_a_number() {
        let taken: std::collections::HashSet<&str> =
            ["test", "test 2", "Terminal"].into_iter().collect();
        assert_eq!(free_title(&taken, "review"), "review");
        assert_eq!(free_title(&taken, "test"), "test 3");
        assert_eq!(free_title(&taken, "Terminal"), "Terminal 2");
    }

    #[test]
    fn missing_live_parent_never_uses_cached_account() {
        let manager = SubAgentManager::default();
        manager
            .parent_for_spawn("session", Some(parent(Some("personal"))))
            .unwrap();
        assert!(manager.parent_for_spawn("session", None).is_err());
    }
}

#[cfg(test)]
mod startup_dialog_tests {
    use super::*;

    #[test]
    fn codex_trust_dialog_is_detected() {
        let buf = b"\x1b[1m> You are running Codex in /tmp/Test-project\x1b[0m\r\n  Do you trust the contents of this directory?\r\n\x1b[36m> 1. Yes, continue\x1b[0m\r\n  2. No, quit\r\n";
        assert!(startup_dialog_visible(buf, "codex"));
    }

    #[test]
    fn claude_footer_update_notice_is_not_a_dialog() {
        let buf =
            b"> \r\n  ? for shortcuts      Update available! Run: brew upgrade claude-code\r\n";
        assert!(!startup_dialog_visible(buf, "claude-code-cli"));
    }

    #[test]
    fn providers_without_input_markers_are_never_gated() {
        assert!(!startup_dialog_visible(
            b"Do you trust the files in this folder?\r\n> 1. Yes\r\n",
            "copilot"
        ));
    }

    #[test]
    fn codex_update_dialog_is_detected() {
        let buf = b"\xe2\x9c\xa8 Update available! 0.154.0 -> 0.162.0\r\n> 1. Update now (runs `npm install -g @openai/codex`)\r\n  2. Skip\r\n";
        assert!(startup_dialog_visible(buf, "codex"));
    }

    #[test]
    fn claude_trust_dialog_is_detected() {
        let buf = b" Do you trust the files in this folder?\r\n \xe2\x9d\xaf 1. Yes, proceed\r\n   2. No, exit\r\n";
        assert!(startup_dialog_visible(buf, "claude-code-cli"));
    }

    #[test]
    fn answered_dialog_followed_by_input_box_is_not_visible() {
        let buf = b"Do you trust the contents of this directory?\r\n> 1. Yes, continue\r\n\x1b[2J\x1b[H\r\n\xe2\x80\xba Ask Codex to do anything\r\n";
        assert!(!startup_dialog_visible(buf, "codex"));
    }

    #[test]
    fn plain_input_box_is_not_a_dialog() {
        assert!(!startup_dialog_visible(
            b"> \r\n  ? for shortcuts\r\n",
            "claude-code-cli"
        ));
        assert!(!startup_dialog_visible(b"", "opencode"));
    }
}

#[cfg(test)]
mod prompt_count_tests {
    use super::*;

    #[test]
    fn backup_enter_after_auto_submit_is_not_a_prompt() {
        let now = 1_000_000;
        assert!(!write_counts_as_prompt(
            "\r",
            &SubAgentStatus::InProgress,
            Some(now - 3_000),
            now
        ));
        // Outside the window, the same Enter is the user's again.
        assert!(write_counts_as_prompt(
            "\r",
            &SubAgentStatus::Idle,
            Some(now - BACKUP_ENTER_WINDOW_MS - 1),
            now
        ));
    }

    #[test]
    fn lone_enter_while_spawning_is_not_a_prompt() {
        assert!(!write_counts_as_prompt(
            "\r",
            &SubAgentStatus::Spawning,
            None,
            1
        ));
    }

    #[test]
    fn user_prompts_still_count() {
        assert!(write_counts_as_prompt("\r", &SubAgentStatus::Idle, None, 1));
        assert!(write_counts_as_prompt(
            "ls\r",
            &SubAgentStatus::InProgress,
            Some(1),
            2
        ));
        assert!(write_counts_as_prompt(
            "1",
            &SubAgentStatus::WaitingInput,
            None,
            1
        ));
        // Enter on an open dialog is an answer, even right after the spawn.
        assert!(write_counts_as_prompt(
            "\r",
            &SubAgentStatus::WaitingInput,
            Some(1),
            2
        ));
        assert!(!write_counts_as_prompt("a", &SubAgentStatus::Idle, None, 1));
    }

    #[test]
    fn typed_text_ends_the_backup_window_but_terminal_reports_do_not() {
        assert!(is_typed_text("h"));
        assert!(is_typed_text("\x1b[200~pasted\x1b[201~"));
        assert!(!is_typed_text("\x1b[I"));
        assert!(!is_typed_text("\r"));
    }
}

#[cfg(test)]
mod lock_order_tests {
    use super::*;

    #[test]
    fn counting_children_never_deadlocks_with_destroy_or_list() {
        let m = Arc::new(SubAgentManager::default());
        m.parent_index
            .lock()
            .insert("p".into(), vec!["a".into(), "b".into()]);
        let (tx, rx) = std::sync::mpsc::channel();
        let counter = {
            let (m, tx) = (m.clone(), tx.clone());
            std::thread::spawn(move || {
                for _ in 0..20_000 {
                    let _ = m.has_active_children("p");
                    let _ = m.live_pane_count("p");
                    let _ = m.alive_count("p");
                }
                let _ = tx.send(());
            })
        };
        // subagent_destroy / subagent_list order: agents, then parent_index.
        let lister = {
            let m = m.clone();
            std::thread::spawn(move || {
                for _ in 0..20_000 {
                    let agents = m.agents.lock();
                    let idx = m.parent_index.lock();
                    drop(idx);
                    drop(agents);
                }
                let _ = tx.send(());
            })
        };
        for _ in 0..2 {
            rx.recv_timeout(std::time::Duration::from_secs(30))
                .expect("lock order deadlock");
        }
        counter.join().unwrap();
        lister.join().unwrap();
    }

    #[test]
    fn archived_entries_carry_a_real_date_and_the_archived_mark() {
        let at = archived_at_now();
        assert!(chrono::DateTime::parse_from_rfc3339(&at).is_ok(), "{at}");
        let m = Arc::new(SubAgentManager::default());
        let view = SubAgentView {
            id: "a".into(),
            role: "custom".into(),
            title: "t".into(),
            parent_session_id: "p".into(),
            session_id: "sub-a".into(),
            status: SubAgentStatus::Idle,
            auto_prompt: "SECRET".into(),
            user_prompt: "SECRET".into(),
            provider: "codex".into(),
            icon: String::new(),
            claude_session_id: Some("c1".into()),
            defer_prompt: None,
            restored: None,
            created_at: now_iso(),
            mode: None,
            custom_config: None,
            soft_skill: None,
            ephemeral: None,
            execution_mode: None,
            model: None,
            effort: None,
            prompt_pending: false,
            slot: None,
            goal_driven: None,
        };
        archive_sub_agent(&m, &view, None);
        let snap = m.archived_snapshot_json();
        let entry = &snap["p"][0];
        assert_eq!(entry["status"], "archived");
        assert!(
            chrono::DateTime::parse_from_rfc3339(entry["archivedAt"].as_str().unwrap()).is_ok()
        );
        assert!(!entry.to_string().contains("SECRET"));
    }
}

#[cfg(test)]
mod model_flag_tests {
    use super::{mcp_unreachable_shell, sanitize_model_flag};

    #[test]
    fn wsl_agents_get_no_windows_path_mcp_config() {
        assert!(mcp_unreachable_shell(Some("wsl:Ubuntu")));
        assert!(!mcp_unreachable_shell(Some("powershell")));
        assert!(!mcp_unreachable_shell(None));
    }

    #[test]
    fn model_names_that_look_like_flags_are_dropped() {
        assert_eq!(
            sanitize_model_flag(Some("opus-5.5")).as_deref(),
            Some("opus-5.5")
        );
        assert_eq!(
            sanitize_model_flag(Some("openai/gpt-6:high")).as_deref(),
            Some("openai/gpt-6:high")
        );
        for bad in ["--yolo", "-y", " --approval-mode", "a b", "x;y", "", "m\nx"] {
            assert_eq!(sanitize_model_flag(Some(bad)), None, "{bad:?}");
        }
    }
}
