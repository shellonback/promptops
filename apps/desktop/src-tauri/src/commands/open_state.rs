//! Local record of what is open (`open-state.json`).
//!
//! Written continuously (scheduler tick + every roster change), so it
//! survives a crash or a force-quit. It decides NOTHING: the session store
//! stays the source of truth for which sessions exist, and the restore at
//! boot does not read it. It only feeds the "Last closure" tab of the resume
//! modal, which shows the sessions and agents open in the previous run.
//!
//! On first access the content of the file (previous run) becomes
//! `previous`; the current run starts from scratch and carries `previous`
//! along until it has at least one session of its own to replace it with at
//! the next boot.
//!
//! Kill switch: `PROMPTOPS_OPEN_STATE=0` turns off both writes and reads
//! (the command returns `null`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

const FILE_VERSION: u32 = 1;

/// Session row supplied by the SessionManager (main sessions only).
#[derive(Clone, Debug, PartialEq)]
pub struct SessionRow {
    pub session_id: String,
    pub db_id: Option<String>,
    pub name: String,
    pub provider: String,
    pub workspace_path: Option<String>,
    pub workspace_name: Option<String>,
    pub standby: bool,
    pub created_at: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSession {
    pub name: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub db_id: Option<String>,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub workspace_name: Option<String>,
    #[serde(default)]
    pub standby: bool,
    /// Open agents, in the slim stash shape (`StashEntry`). Kept as opaque
    /// JSON: this module does not depend on the sub-agent types.
    #[serde(default)]
    pub agents: Vec<JsonValue>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(default)]
    pub saved_at: String,
    #[serde(default)]
    pub clean_exit: bool,
    #[serde(default)]
    pub sessions: Vec<OpenSession>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileV1 {
    #[serde(default)]
    version: u32,
    #[serde(flatten)]
    current: Snapshot,
    #[serde(default)]
    previous: Option<Snapshot>,
}

#[derive(Default)]
struct State {
    /// Previous run (what the modal shows).
    previous: Option<Snapshot>,
    /// Rosters of the current run, by local session id.
    rosters: HashMap<String, Vec<JsonValue>>,
    /// Rosters inherited from the previous run, by session name: they hold
    /// until the session publishes a roster of its own (lazy restore: a
    /// session that was never woken must not lose the agents it had).
    inherited: HashMap<String, Vec<JsonValue>>,
    rows: Vec<SessionRow>,
    last_written: Option<Vec<OpenSession>>,
    /// No writes after the clean exit: the shutdown kills would empty the
    /// rosters.
    frozen: bool,
}

fn enabled() -> bool {
    std::env::var("PROMPTOPS_OPEN_STATE")
        .map(|v| v != "0")
        .unwrap_or(true)
}

fn file_path() -> PathBuf {
    crate::commands::hook::hook_data_dir().join("open-state.json")
}

/// Which snapshot of the file is "the last closure": the previous run if it
/// had sessions, otherwise the one before it (a run that died before the
/// restore must not erase the memory of the good one).
fn pick_previous(file: FileV1) -> Option<Snapshot> {
    if !file.current.sessions.is_empty() {
        Some(file.current)
    } else {
        file.previous.filter(|p| !p.sessions.is_empty())
    }
}

fn inherited_from(previous: &Option<Snapshot>) -> HashMap<String, Vec<JsonValue>> {
    previous
        .iter()
        .flat_map(|p| p.sessions.iter())
        .filter(|s| !s.agents.is_empty())
        .map(|s| (s.name.clone(), s.agents.clone()))
        .collect()
}

fn load() -> State {
    let previous = if enabled() {
        std::fs::read_to_string(file_path())
            .ok()
            .and_then(|s| serde_json::from_str::<FileV1>(&s).ok())
            .and_then(pick_previous)
    } else {
        None
    };
    State {
        inherited: inherited_from(&previous),
        previous,
        ..State::default()
    }
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(load()))
}

/// Sessions open right now, in creation order, each with its roster (the
/// current run's if published, otherwise the one inherited by name).
fn build_sessions(
    rows: &[SessionRow],
    rosters: &HashMap<String, Vec<JsonValue>>,
    inherited: &HashMap<String, Vec<JsonValue>>,
) -> Vec<OpenSession> {
    let mut ordered: Vec<&SessionRow> = rows.iter().collect();
    ordered.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.name.cmp(&b.name)));
    ordered
        .into_iter()
        .map(|r| OpenSession {
            name: r.name.clone(),
            session_id: r.session_id.clone(),
            db_id: r.db_id.clone(),
            provider: r.provider.clone(),
            workspace_path: r.workspace_path.clone(),
            workspace_name: r.workspace_name.clone(),
            standby: r.standby,
            agents: rosters
                .get(&r.session_id)
                .or_else(|| inherited.get(&r.name))
                .cloned()
                .unwrap_or_default(),
        })
        .collect()
}

fn write_file(file: &FileV1) {
    let path = file_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let Ok(json) = serde_json::to_vec(file) else {
        return;
    };
    // Atomic and synced: never a half-written file after a crash.
    let tmp = path.with_extension("json.tmp");
    let written = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600); // holds prompt excerpts
        }
        let mut f = options.open(&tmp)?;
        f.write_all(&json)?;
        f.sync_all()
    })();
    if written.is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    } else {
        let _ = std::fs::remove_file(&tmp);
    }
}

fn flush(st: &mut State, clean_exit: bool) {
    let sessions = build_sessions(&st.rows, &st.rosters, &st.inherited);
    if !clean_exit && st.last_written.as_ref() == Some(&sessions) {
        return;
    }
    write_file(&FileV1 {
        version: FILE_VERSION,
        current: Snapshot {
            saved_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            clean_exit,
            sessions: sessions.clone(),
        },
        previous: st.previous.clone(),
    });
    st.last_written = Some(sessions);
}

/// Scheduler tick: refreshes the session list and writes when it changes.
pub fn tick(rows: Vec<SessionRow>) {
    if !enabled() {
        return;
    }
    let mut st = state().lock();
    if st.frozen {
        return;
    }
    // Rosters of sessions that are gone are no longer needed.
    st.rosters
        .retain(|id, _| rows.iter().any(|r| &r.session_id == id));
    st.rows = rows;
    flush(&mut st, false);
}

/// Change in a session's live roster (same points where the stash snapshot
/// goes out to the renderer, same rules).
pub fn note_roster<T: Serialize>(session_id: &str, agents: &[T]) {
    if !enabled() {
        return;
    }
    let values: Vec<JsonValue> = agents
        .iter()
        .filter_map(|a| serde_json::to_value(a).ok())
        .collect();
    let mut st = state().lock();
    if st.frozen {
        return;
    }
    st.rosters.insert(session_id.to_string(), values);
    if st.rows.iter().any(|r| r.session_id == session_id) {
        flush(&mut st, false);
    }
}

/// Clean exit: one last write with `cleanExit`, then the record stops.
pub fn mark_clean_exit(rows: Vec<SessionRow>) {
    if !enabled() {
        return;
    }
    let mut st = state().lock();
    if st.frozen {
        return;
    }
    st.rows = rows;
    flush(&mut st, true);
    st.frozen = true;
}

/// open_state:last-closure — sessions and agents open in the previous run.
#[tauri::command]
pub fn open_state_last_closure() -> Option<Snapshot> {
    if !enabled() {
        return None;
    }
    state().lock().previous.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(id: &str, name: &str, created: &str, standby: bool) -> SessionRow {
        SessionRow {
            session_id: id.into(),
            db_id: None,
            name: name.into(),
            provider: "claude-code-cli".into(),
            workspace_path: Some("/w".into()),
            workspace_name: None,
            standby,
            created_at: created.into(),
        }
    }

    fn snap(names: &[&str]) -> Snapshot {
        Snapshot {
            saved_at: "t".into(),
            clean_exit: false,
            sessions: names
                .iter()
                .map(|n| OpenSession {
                    name: n.to_string(),
                    ..OpenSession::default()
                })
                .collect(),
        }
    }

    #[test]
    fn previous_is_the_last_run_that_had_sessions() {
        let file = FileV1 {
            version: 1,
            current: snap(&["a"]),
            previous: Some(snap(&["old"])),
        };
        assert_eq!(pick_previous(file).unwrap().sessions[0].name, "a");
    }

    #[test]
    fn a_run_that_died_before_restore_keeps_the_older_closure() {
        let file = FileV1 {
            version: 1,
            current: snap(&[]),
            previous: Some(snap(&["old"])),
        };
        assert_eq!(pick_previous(file).unwrap().sessions[0].name, "old");
        let empty = FileV1 {
            version: 1,
            current: snap(&[]),
            previous: Some(snap(&[])),
        };
        assert!(pick_previous(empty).is_none());
    }

    #[test]
    fn sessions_are_ordered_by_creation_and_carry_their_roster() {
        let rows = vec![
            row("2", "b", "2026-01-02", false),
            row("1", "a", "2026-01-01", true),
        ];
        let mut rosters = HashMap::new();
        rosters.insert("2".to_string(), vec![json!({"title": "live"})]);
        let mut inherited = HashMap::new();
        inherited.insert("a".to_string(), vec![json!({"title": "kept"})]);
        inherited.insert("b".to_string(), vec![json!({"title": "stale"})]);
        let out = build_sessions(&rows, &rosters, &inherited);
        assert_eq!(out[0].name, "a");
        // Never woken in this run: keeps the agents of the previous run.
        assert_eq!(out[0].agents[0]["title"], "kept");
        // Roster published in this run: wins over the inherited one.
        assert_eq!(out[1].agents[0]["title"], "live");
    }

    #[test]
    fn an_emptied_live_roster_does_not_fall_back_to_the_inherited_one() {
        let rows = vec![row("1", "a", "2026-01-01", false)];
        let mut rosters = HashMap::new();
        rosters.insert("1".to_string(), Vec::new());
        let mut inherited = HashMap::new();
        inherited.insert(
            "a".to_string(),
            vec![json!({"title": "closed by the user"})],
        );
        assert!(build_sessions(&rows, &rosters, &inherited)[0]
            .agents
            .is_empty());
    }

    #[test]
    fn file_round_trips_and_tolerates_unknown_and_missing_fields() {
        let file = FileV1 {
            version: 1,
            current: snap(&["a"]),
            previous: Some(snap(&["old"])),
        };
        let text = serde_json::to_string(&file).unwrap();
        let back: FileV1 = serde_json::from_str(&text).unwrap();
        assert_eq!(back.current, file.current);
        assert_eq!(back.previous, file.previous);
        let loose: FileV1 =
            serde_json::from_str(r#"{"sessions":[{"name":"x","future":1}],"extra":true}"#).unwrap();
        assert_eq!(loose.current.sessions[0].name, "x");
    }
}
