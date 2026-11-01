//! Conversation id capture for providers WITHOUT hooks.
//!
//! claude announces its id by itself (SessionStart hook). The others don't: the id
//! exists and the CLI can resume it, but nobody reports it. Here we go and
//! fetch it after the spawn, one strategy per provider, and hand it to the
//! SessionManager, which persists it in `config.providerSessionIds`.
//!
//! Capabilities verified on the installed CLIs (June 2026):
//!   grok      `-r, --resume [<SESSION_ID>]`  → dir under `~/.grok/sessions/<cwd url-encoded>/`
//!   opencode  `-s, --session <id>`           → `opencode session list --format json`
//!   hermes    `--resume <ID|title>`          → `hermes sessions list` (the id carries the timestamp)
//!   codex     `resume <id>`                  → rollout under `CODEX_HOME`
//!   gemini    `-r, --resume latest|<index>`  → NOT by-id: the index is positional.
//!
//! Best-effort everywhere: if the probe finds nothing the provider restarts as
//! before, without resume.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Does the provider have a probe? (≠ "has a resume": gemini has resume but not by-id)
pub fn has_session_probe(provider: &str) -> bool {
    matches!(provider, "grok" | "opencode" | "hermes" | "codex")
}

/// Clock tolerance: the session may be born a moment before our
/// spawn timestamp is recorded.
const CLOCK_SKEW_MS: u128 = 2_000;
/// How long after the spawn OUR session can be born. Beyond that, it belongs to
/// someone else (or the clock is lying).
const MAX_SESSION_AGE_MS: u128 = 10 * 60 * 1_000;
const PROBE_TIMEOUT_MS: u128 = 25_000;

/// Poll cadence, per provider. grok is read from the filesystem (one readdir,
/// negligible cost); opencode and hermes require LAUNCHING their CLI,
/// so we poll less often: one process per second for 25s, on every session
/// spawn, would be a glaring waste.
fn poll_interval_ms(provider: &str) -> u64 {
    match provider {
        "grok" => 1_000,
        _ => 2_500,
    }
}

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Waits for the provider to materialize its session and returns its id.
/// Blocking: must be called from a dedicated thread, never from the spawn path.
/// Account-aware variant: for Codex `provider_home` is the CODEX_HOME
/// actually injected into the child process.
pub fn probe_provider_session_id_in_home(
    provider: &str,
    cwd: &str,
    spawned_at_ms: u128,
    provider_home: Option<&str>,
) -> Option<String> {
    let deadline = now_ms() + PROBE_TIMEOUT_MS;
    let poll_ms = poll_interval_ms(provider);
    while now_ms() < deadline {
        std::thread::sleep(Duration::from_millis(poll_ms));
        let found = match provider {
            "grok" => probe_grok(cwd, spawned_at_ms),
            "opencode" => probe_opencode(cwd, spawned_at_ms),
            "hermes" => probe_hermes(cwd, spawned_at_ms),
            "codex" => probe_codex(cwd, spawned_at_ms, provider_home),
            _ => None,
        };
        // codex claims its rollout inside probe_codex; the others pick "the
        // newest after the spawn", so two sessions started together in the same
        // cwd would both take it and resume each other's conversation.
        if let Some(id) = found {
            if provider == "codex" || claim_session_id(provider, &id) {
                return Some(id);
            }
        }
    }
    None
}

static CLAIMED_CODEX_ROLLOUTS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
static CLAIMED_SESSION_IDS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// First caller wins a `(provider, id)` pair for this run of the app.
fn claim_session_id(provider: &str, id: &str) -> bool {
    CLAIMED_SESSION_IDS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map(|mut set| set.insert(format!("{provider}\u{0}{id}")))
        .unwrap_or(false)
}

/// Binds the Codex TUI to the rollout born after the spawn. The claim prevents
/// two sessions started almost together in the same cwd from getting the same id.
fn probe_codex(cwd: &str, spawned_at_ms: u128, codex_home: Option<&str>) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let root = codex_home
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(&home).join(".codex"))
        .join("sessions");
    let claimed = CLAIMED_CODEX_ROLLOUTS.get_or_init(|| Mutex::new(HashSet::new()));
    let claimed_now = claimed.lock().ok()?.clone();
    let mut candidates: Vec<(u128, PathBuf, String)> = Vec::new();

    let mut years = child_dirs(&root, 4);
    years.sort_by(|a, b| b.cmp(a));
    let mut days_seen = 0usize;
    'years: for year in years {
        let mut months = child_dirs(&year, 2);
        months.sort_by(|a, b| b.cmp(a));
        for month in months {
            let mut days = child_dirs(&month, 2);
            days.sort_by(|a, b| b.cmp(a));
            for day in days {
                if days_seen >= 3 {
                    break 'years;
                }
                days_seen += 1;
                let Ok(entries) = std::fs::read_dir(day) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if !name.starts_with("rollout-")
                        || !name.ends_with(".jsonl")
                        || claimed_now.contains(&path)
                    {
                        continue;
                    }
                    let Ok(meta) = entry.metadata() else { continue };
                    let at = meta
                        .created()
                        .or_else(|_| meta.modified())
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis())
                        .unwrap_or(0);
                    if at + CLOCK_SKEW_MS < spawned_at_ms {
                        continue;
                    }
                    if let Some((sid, rollout_cwd, source)) = read_codex_meta(&path) {
                        if source.as_deref() == Some("exec") || !same_dir(&rollout_cwd, cwd) {
                            continue;
                        }
                        candidates.push((at, path, sid));
                    }
                }
            }
        }
    }
    candidates.sort_by_key(|(at, _, _)| *at);
    let mut claimed = claimed.lock().ok()?;
    for (_, path, sid) in candidates {
        if claimed.insert(path) {
            return Some(sid);
        }
    }
    None
}

fn child_dirs(root: &Path, width: usize) -> Vec<PathBuf> {
    std::fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| {
            let n = e.file_name();
            let n = n.to_string_lossy();
            n.len() == width && n.bytes().all(|b| b.is_ascii_digit())
        })
        .map(|e| e.path())
        .collect()
}

fn read_codex_meta(path: &Path) -> Option<(String, String, Option<String>)> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    file.by_ref().take(256 * 1024).read_to_end(&mut buf).ok()?;
    for line in String::from_utf8_lossy(&buf).lines().take(50) {
        let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if row.get("type").and_then(|v| v.as_str()) != Some("session_meta") {
            continue;
        }
        let payload = row.get("payload")?;
        let sid = payload
            .get("session_id")
            .or_else(|| payload.get("id"))?
            .as_str()?
            .to_string();
        let cwd = payload.get("cwd")?.as_str()?.to_string();
        let source = payload
            .get("source")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| {
                (payload.get("originator").and_then(|v| v.as_str()) == Some("codex_exec"))
                    .then(|| "exec".into())
            });
        return Some((sid, cwd, source));
    }
    None
}

/// grok — `~/.grok/sessions/<cwd url-encoded>/<uuid>/`, one directory per
/// conversation. The cwd is in the path, so the association is exact.
fn probe_grok(cwd: &str, spawned_at_ms: u128) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let root = Path::new(&home)
        .join(".grok")
        .join("sessions")
        .join(encode_cwd(cwd));
    let mut best: Option<(String, u128)> = None;
    for entry in std::fs::read_dir(&root).ok()? {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let at = meta
            .created()
            .or_else(|_| meta.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        if at + CLOCK_SKEW_MS < spawned_at_ms {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if best.as_ref().is_none_or(|(_, best_at)| at > *best_at) {
            best = Some((name, at));
        }
    }
    best.map(|(id, _)| id)
}

/// grok encodes the cwd as a directory name: `/Users/x` → `%2FUsers%2Fx`.
/// Same encoding as `encodeURIComponent`.
pub fn encode_cwd(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len() * 3);
    for byte in cwd.as_bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(*byte as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// opencode — sessions live in a SQLite db, but the CLI already exposes them as
/// JSON: no db access, no native dependency.
fn probe_opencode(cwd: &str, spawned_at_ms: u128) -> Option<String> {
    let out = run(
        cwd,
        Some("opencode"),
        "opencode",
        &["session", "list", "--format", "json", "-n", "10"],
    )?;
    let parsed: serde_json::Value = serde_json::from_str(&out).ok()?;
    let rows = parsed
        .as_array()
        .cloned()
        .or_else(|| parsed.get("sessions").and_then(|v| v.as_array()).cloned())?;

    let mut best: Option<(String, u128)> = None;
    for row in rows {
        let Some(id) = ["id", "sessionID", "sessionId", "session_id"]
            .iter()
            .find_map(|k| row.get(k).and_then(|v| v.as_str()))
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        // If the row carries a directory it must be ours: opencode
        // lists the sessions of ALL projects.
        if let Some(dir) = ["directory", "cwd", "path", "projectPath"]
            .iter()
            .find_map(|k| row.get(k).and_then(|v| v.as_str()))
        {
            if !same_dir(dir, cwd) {
                continue;
            }
        }
        let at = row_time_ms(&row);
        if at.is_some_and(|t| t + CLOCK_SKEW_MS < spawned_at_ms) {
            continue;
        }
        let at = at.unwrap_or(0);
        if best.as_ref().is_none_or(|(_, best_at)| at > *best_at) {
            best = Some((id.to_string(), at));
        }
    }
    best.map(|(id, _)| id)
}

/// hermes — `hermes sessions list` prints a table without cwd, but the ID CARRIES
/// the timestamp (`20260614_124133_3491ac`): that is what ties it to our spawn.
fn probe_hermes(cwd: &str, spawned_at_ms: u128) -> Option<String> {
    let out = run(
        cwd,
        Some("hermes"),
        "hermes",
        &["sessions", "list", "--limit", "10"],
    )?;
    let mut best: Option<(String, u128)> = None;
    for line in out.lines() {
        let Some(id) = extract_hermes_id(&crate::commands::session::strip_ansi(line)) else {
            continue;
        };
        let Some(at) = parse_hermes_id_time(&id) else {
            continue;
        };
        // Window CLOSED on both sides, not just "after the spawn":
        // the local offset comes from `date +%z`, which doesn't exist on Windows
        // (→ 0). With an offset wrong by hours, a lower-bound-only filter
        // would let the WRONG conversation through; this way nothing
        // passes and we stay without resume, which is the right failure.
        if at + CLOCK_SKEW_MS < spawned_at_ms || at > spawned_at_ms + MAX_SESSION_AGE_MS {
            continue;
        }
        if best.as_ref().is_none_or(|(_, best_at)| at > *best_at) {
            best = Some((id, at));
        }
    }
    best.map(|(id, _)| id)
}

/// First token in the row with the `YYYYMMDD_HHMMSS_xxxxxx` format.
pub fn extract_hermes_id(line: &str) -> Option<String> {
    for token in line.split_whitespace() {
        let bytes = token.as_bytes();
        if bytes.len() != 22 {
            continue;
        }
        let shaped = bytes[..8].iter().all(u8::is_ascii_digit)
            && bytes[8] == b'_'
            && bytes[9..15].iter().all(u8::is_ascii_digit)
            && bytes[15] == b'_'
            && bytes[16..].iter().all(u8::is_ascii_hexdigit);
        if shaped {
            return Some(token.to_string());
        }
    }
    None
}

/// `20260614_124133_3491ac` → epoch ms (LOCAL time, as hermes writes it).
pub fn parse_hermes_id_time(id: &str) -> Option<u128> {
    let bytes = id.as_bytes();
    if bytes.len() < 15 {
        return None;
    }
    let num = |range: std::ops::Range<usize>| id.get(range)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(4..6)?, num(6..8)?);
    let (h, mi, s) = (num(9..11)?, num(11..13)?, num(13..15)?);
    // Days since the epoch (Howard Hinnant's civil algorithm).
    let y_adj = if mo <= 2 { y - 1 } else { y };
    let era = y_adj.div_euclid(400);
    let yoe = y_adj - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let local_secs = days * 86_400 + h * 3_600 + mi * 60 + s;
    // Local offset derived from the difference between local time and UTC at the current
    // moment: hermes writes in local time and there is no tz in the format.
    let offset = local_utc_offset_secs();
    let epoch = local_secs - offset;
    if epoch < 0 {
        return None;
    }
    Some(epoch as u128 * 1000)
}

/// Local offset in seconds. Derived without dependencies: `date +%z` is
/// available wherever the app runs (macOS/Linux; on Windows the hermes probe is not
/// active because the CLI is not supported there).
fn local_utc_offset_secs() -> i64 {
    static CACHE: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| {
        let Some(out) = run(".", None, "date", &["+%z"]) else {
            return 0;
        };
        let t = out.trim();
        if t.len() < 5 {
            return 0;
        }
        let sign = if t.starts_with('-') { -1 } else { 1 };
        let hh: i64 = t[1..3].parse().unwrap_or(0);
        let mm: i64 = t[3..5].parse().unwrap_or(0);
        sign * (hh * 3_600 + mm * 60)
    })
}

fn same_dir(a: &str, b: &str) -> bool {
    let norm = |p: &str| p.trim_end_matches('/').to_string();
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if norm(a) == norm(b) {
        return true;
    }
    // Two paths that do not resolve are NOT the same folder (None == None
    // used to match any vanished cwd with any other).
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

fn row_time_ms(row: &serde_json::Value) -> Option<u128> {
    for key in [
        "created",
        "createdAt",
        "created_at",
        "time",
        "updated",
        "updatedAt",
    ] {
        match row.get(key) {
            Some(serde_json::Value::Number(n)) => {
                let v = n.as_f64()?;
                return Some(if v < 1e12 {
                    (v * 1000.0) as u128
                } else {
                    v as u128
                });
            }
            Some(serde_json::Value::Object(_)) => {
                if let Some(nested) = row.get(key).and_then(row_time_ms) {
                    return Some(nested);
                }
            }
            _ => {}
        }
    }
    None
}

/// Timeout for the probe commands. Without it, a hung CLI would keep
/// the thread stuck forever — `Command::output()` has no deadline.
const RUN_TIMEOUT_MS: u128 = 8_000;

/// Runs a short command capturing its stdout, killing it if it exceeds the
/// timeout. `None` on any problem: the probe is an optimization, not a
/// requirement of the spawn. With `provider` it runs on that provider's active
/// account (AI Accounts).
fn run(cwd: &str, provider: Option<&str>, program: &str, args: &[&str]) -> Option<String> {
    use std::process::Stdio;

    let account_vars = provider
        .map(crate::commands::provider_account::utility_account_vars)
        .unwrap_or_default();
    let program =
        crate::commands::provider_account::utility_base_command(program.to_string(), &account_vars);
    let mut command = crate::commands::util_cmd::cmd(&program);
    for key in crate::commands::provider_account::utility_env_removals(&account_vars) {
        command.env_remove(key);
    }
    let mut child = command
        .envs(account_vars.iter().map(|(k, v)| (k, v)))
        .args(args)
        .current_dir(if Path::new(cwd).is_dir() { cwd } else { "." })
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let deadline = now_ms() + RUN_TIMEOUT_MS;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                break;
            }
            Ok(None) => {
                if now_ms() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait(); // no zombies
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }

    let mut out = String::new();
    use std::io::Read;
    child.stdout.as_mut()?.read_to_string(&mut out).ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_folders_are_never_the_same_folder() {
        assert!(!same_dir("/no/such/dir-a", "/no/such/dir-b"));
        assert!(!same_dir("", ""));
        assert!(same_dir("/no/such/dir-a/", "/no/such/dir-a"));
        let tmp = std::env::temp_dir();
        assert!(same_dir(&tmp.to_string_lossy(), &tmp.to_string_lossy()));
    }

    #[test]
    fn a_session_id_is_claimed_once() {
        let id = format!("probe-claim-{}", now_ms());
        assert!(claim_session_id("grok", &id));
        assert!(!claim_session_id("grok", &id));
        assert!(claim_session_id("opencode", &id));
    }

    #[test]
    fn encodes_cwd_like_encode_uri_component() {
        assert_eq!(
            encode_cwd("/Users/x/prompt-ops"),
            "%2FUsers%2Fx%2Fprompt-ops"
        );
    }

    #[test]
    fn extracts_hermes_id_from_a_table_row() {
        let line = "cosa puoi fare?    2026-06-14    tui    20260614_124133_3491ac";
        assert_eq!(
            extract_hermes_id(line).as_deref(),
            Some("20260614_124133_3491ac")
        );
        assert_eq!(extract_hermes_id("Preview  Last Active  Src  ID"), None);
    }

    #[test]
    fn hermes_id_time_is_monotonic_and_plausible() {
        let earlier = parse_hermes_id_time("20260614_124133_3491ac").unwrap();
        let later = parse_hermes_id_time("20260614_124836_954695").unwrap();
        assert!(later > earlier);
        // 2026-06-14 12:41:33 UTC. The tolerance covers the local time zone: hermes
        // writes in local time and the format carries no timezone.
        let expected = 1_781_440_893_000u128;
        assert!(
            earlier.abs_diff(expected) <= 14 * 3_600_000,
            "parsed {earlier}, expected ~{expected}"
        );
    }

    #[test]
    fn probe_is_limited_to_providers_that_have_one() {
        assert!(has_session_probe("grok"));
        assert!(has_session_probe("opencode"));
        assert!(has_session_probe("hermes"));
        assert!(has_session_probe("codex"));
        assert!(!has_session_probe("gemini-cli"));
        assert!(!has_session_probe("claude-code-cli"));
    }

    #[test]
    fn reads_codex_session_meta() {
        let file = std::env::temp_dir().join(format!(
            "promptops-codex-meta-{}-{}.jsonl",
            std::process::id(),
            now_ms()
        ));
        std::fs::write(
            &file,
            "not-json\n{\"type\":\"session_meta\",\"payload\":{\"session_id\":\"sid-1\",\"cwd\":\"/work\",\"source\":\"cli\"}}\n",
        )
        .unwrap();
        let parsed = read_codex_meta(&file).unwrap();
        assert_eq!(parsed.0, "sid-1");
        assert_eq!(parsed.1, "/work");
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn codex_probe_finds_rollout_in_account_home() {
        let root = std::env::temp_dir().join(format!(
            "promptops-codex-probe-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let day = root.join("sessions/2026/09/05");
        let cwd = root.join("workspace");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let rollout = day.join("rollout-2026-09-05T00-00-00-sid-account.jsonl");
        std::fs::write(
            rollout,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"sid-account\",\"cwd\":{},\"source\":\"cli\"}}}}\n",
                serde_json::to_string(&cwd.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        let sid = probe_codex(
            &cwd.to_string_lossy(),
            now_ms().saturating_sub(1_000),
            Some(&root.to_string_lossy()),
        );
        assert_eq!(sid.as_deref(), Some("sid-account"));
        let _ = std::fs::remove_dir_all(root);
    }
}
