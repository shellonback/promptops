//! Model ACTUALLY in use by a terminal.
//!
//! The launch flag (`claude --model`, `codex -m`) only says how the CLI
//! started: after the first `/model` inside the TUI that value is wrong and the CLI does not
//! tell us. But every turn ends up in the provider's session log,
//! tagged with the model that produced it:
//!
//!   claude  ~/.claude/projects/<escaped-cwd>/<conversation-id>.jsonl
//!           → last `{"type":"assistant","message":{"model":…}}` line
//!   codex   <CODEX_HOME>/sessions/<Y>/<M>/<D>/rollout-<ts>-<uuid>.jsonl
//!           → last `turn_context` line with `payload.model`
//!
//! Cost constraints: pull-only (no polling), per-session cache, `stat` before
//! reading (an idle terminal costs one stat and zero reads), and only the tail
//! of the file (TAIL_BYTES). Any error → `None`: the renderer falls back to the
//! spawn model.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Within this window the cached answer is reused as is.
const CACHE_TTL_MS: u64 = 10_000;
/// How much of the log tail to analyze (enough for quite a few real turns).
const TAIL_BYTES: u64 = 128 * 1024;
/// Cap on scanning rollout directories (codex): only recent days.
const MAX_ROLLOUT_DAYS: usize = 7;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelResult {
    pub model: Option<String>,
    /// 'transcript' (claude) | 'rollout' (codex) | absent if not resolved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Why there is no model: without this an empty badge is indistinguishable
    /// from an unsupported provider, and diagnosing it requires the devtools.
    /// `unsupported-provider` | `no-conversation-id` | `log-not-found` |
    /// `no-model-in-tail`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone)]
struct CacheEntry {
    model: Option<String>,
    /// Log the answer came from: avoids searching for it every time.
    file: Option<PathBuf>,
    /// File size at the last parse.
    size: u64,
    at_ms: u64,
    /// Account-specific root of the log (Codex); invalidates the cache on account change.
    scope: Option<PathBuf>,
}

static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Entries are tiny, but a long-lived app opens many terminals.
const MAX_CACHE_ENTRIES: usize = 200;

/// Eviction from the oldest: finished sessions simply stop being
/// queried.
fn prune(map: &mut HashMap<String, CacheEntry>) {
    if map.len() <= MAX_CACHE_ENTRIES {
        return;
    }
    let mut ages: Vec<(String, u64)> = map.iter().map(|(k, v)| (k.clone(), v.at_ms)).collect();
    ages.sort_by_key(|(_, at)| *at);
    for (key, _) in ages.into_iter().take(map.len() - MAX_CACHE_ENTRIES) {
        map.remove(&key);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Providers whose model we know: from the session log (claude, codex) or
/// from hooks (antigravity: every event carries `modelName`).
pub fn can_resolve(provider: &str) -> bool {
    matches!(provider, "claude-code-cli" | "codex" | "antigravity")
}

/// Last model announced by the hooks, per terminal.
fn hook_models() -> &'static Mutex<HashMap<String, String>> {
    static MODELS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    MODELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Hook server → model in use (only sane slugs: it ends up in a badge).
pub fn record_hook_model(session_id: &str, model: &str) {
    let ok = !session_id.is_empty()
        && !model.is_empty()
        && model.len() <= 80
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | ' ' | '(' | ')'));
    if ok {
        hook_models()
            .lock()
            .insert(session_id.to_string(), model.to_string());
    }
}

/// Forgets the state of a terminal that no longer exists.
pub fn forget(session_id: &str) {
    cache().lock().remove(session_id);
    hook_models().lock().remove(session_id);
}

/// Blocking on I/O: must be called inside `spawn_blocking`, never on the main thread.
pub fn resolve(
    session_id: &str,
    provider: &str,
    cwd: Option<&str>,
    provider_session_id: Option<&str>,
    provider_home: Option<&str>,
) -> ModelResult {
    if session_id.is_empty() || !can_resolve(provider) {
        return ModelResult {
            reason: Some("unsupported-provider".into()),
            ..Default::default()
        };
    }
    if provider == "antigravity" {
        let model = hook_models().lock().get(session_id).cloned();
        return result_of(model, "hook", "no-conversation-id");
    }
    let source = if provider == "codex" {
        "rollout"
    } else {
        "transcript"
    };
    let scope = (provider == "codex").then(|| codex_sessions_root(provider_home));
    let cached = cache()
        .lock()
        .get(session_id)
        .cloned()
        .filter(|entry| entry.scope == scope);
    let now = now_ms();

    if let Some(entry) = &cached {
        if now.saturating_sub(entry.at_ms) < CACHE_TTL_MS {
            return result_of(entry.model.clone(), source, "no-model-in-tail");
        }
    }

    let file = match cached.as_ref().and_then(|e| e.file.clone()) {
        Some(f) => Some(f),
        None => find_log_file(provider, cwd, provider_session_id, provider_home),
    };
    let Some(file) = file else {
        let model = cached.as_ref().and_then(|e| e.model.clone());
        cache().lock().insert(
            session_id.to_string(),
            CacheEntry {
                model: model.clone(),
                file: None,
                size: 0,
                at_ms: now,
                scope: scope.clone(),
            },
        );
        // No conversation id = the CLI has not announced the session yet
        // (SessionStart hook / rollout tracker); with an id but no file, the log
        // is not where we expect it (cwd different from the launch one).
        let reason = if provider_session_id.is_none() {
            "no-conversation-id"
        } else {
            "log-not-found"
        };
        return result_of(model, source, reason);
    };

    // Nothing appended since the last parse → the answer cannot have changed.
    let size = match fs::metadata(&file) {
        Ok(m) => m.len(),
        Err(_) => {
            cache().lock().remove(session_id);
            return result_of(
                cached.as_ref().and_then(|e| e.model.clone()),
                source,
                "log-not-found",
            );
        }
    };
    if let Some(entry) = &cached {
        if entry.size == size && entry.file.is_some() {
            cache().lock().insert(
                session_id.to_string(),
                CacheEntry {
                    at_ms: now,
                    ..entry.clone()
                },
            );
            return result_of(entry.model.clone(), source, "no-model-in-tail");
        }
    }

    let parsed = read_tail_lines(&file, TAIL_BYTES)
        .ok()
        .and_then(|lines| model_from_lines(&lines, provider));

    // A tail without lines carrying the model (very long tool output) must not
    // erase what we already knew.
    let model = parsed.or_else(|| cached.as_ref().and_then(|e| e.model.clone()));
    {
        let mut guard = cache().lock();
        guard.insert(
            session_id.to_string(),
            CacheEntry {
                model: model.clone(),
                file: Some(file),
                size,
                at_ms: now,
                scope,
            },
        );
        prune(&mut guard);
    }
    result_of(model, source, "no-model-in-tail")
}

/// Last messages written by the USER in the conversation (claude
/// transcript / codex rollout), from oldest to newest. They feed
/// the switch handoff: rules given "only in conversation" must
/// reach the new provider (UX audit 10/2026, item 3). Excluded:
/// tool results, system/meta messages (`<…>`) and the handoffs themselves.
pub fn recent_user_messages(
    provider: &str,
    cwd: Option<&str>,
    provider_session_id: Option<&str>,
    provider_home: Option<&str>,
    max: usize,
) -> Vec<String> {
    let Some(file) = find_log_file(provider, cwd, provider_session_id, provider_home) else {
        return Vec::new();
    };
    let Ok(lines) = read_tail_lines(&file, 4 * 1024 * 1024) else {
        return Vec::new();
    };
    let mut out = user_messages_from_lines(&lines, provider);
    if out.len() > max {
        out.drain(..out.len() - max);
    }
    out
}

fn user_messages_from_lines(lines: &[String], provider: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in lines {
        if !line.contains("\"user\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let content = if provider == "codex" {
            let p = v.get("payload");
            let is_user = p.and_then(|p| p.get("type")).and_then(|t| t.as_str()) == Some("message")
                && p.and_then(|p| p.get("role")).and_then(|r| r.as_str()) == Some("user");
            if !is_user {
                continue;
            }
            p.and_then(|p| p.get("content")).cloned()
        } else {
            if v.get("type").and_then(|t| t.as_str()) != Some("user")
                || v.get("isMeta").and_then(|m| m.as_bool()) == Some(true)
            {
                continue;
            }
            v.get("message").and_then(|m| m.get("content")).cloned()
        };
        let text = match content {
            Some(serde_json::Value::String(s)) => s,
            Some(serde_json::Value::Array(parts)) => parts
                .iter()
                .filter(|p| {
                    matches!(
                        p.get("type").and_then(|t| t.as_str()),
                        Some("text") | Some("input_text")
                    )
                })
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => continue,
        };
        let text = text.trim();
        if text.is_empty() || text.starts_with('<') || text.starts_with("# Handoff") {
            continue;
        }
        out.push(text.chars().take(1_500).collect());
    }
    out
}

fn result_of(model: Option<String>, source: &str, reason: &str) -> ModelResult {
    if model.is_some() {
        return ModelResult {
            model,
            source: Some(source.to_string()),
            reason: None,
        };
    }
    ModelResult {
        model: None,
        source: None,
        reason: Some(reason.to_string()),
    }
}

/// Last complete lines of the file: the first partial one is dropped.
fn read_tail_lines(path: &Path, tail_bytes: u64) -> std::io::Result<Vec<String>> {
    let mut f = fs::File::open(path)?;
    let size = f.metadata()?.len();
    let offset = size.saturating_sub(tail_bytes);
    let len = (size - offset) as usize;
    if len == 0 {
        return Ok(Vec::new());
    }
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf)?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    if offset > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    Ok(lines)
}

/// Last useful line wins: it is the most recent turn.
fn model_from_lines(lines: &[String], provider: &str) -> Option<String> {
    for line in lines.iter().rev() {
        // Pre-filter: the real cost would be parsing every line of the tail.
        if !line.contains("\"model\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let model = if provider == "codex" {
            v.get("payload")
                .and_then(|p| p.get("model"))
                .and_then(|m| m.as_str())
        } else {
            v.get("message")
                .and_then(|m| m.get("model"))
                .and_then(|m| m.as_str())
        };
        if let Some(m) = model {
            if !m.is_empty() && m != "<synthetic>" {
                return Some(m.to_string());
            }
        }
    }
    None
}

fn find_log_file(
    provider: &str,
    cwd: Option<&str>,
    provider_session_id: Option<&str>,
    provider_home: Option<&str>,
) -> Option<PathBuf> {
    let sid = provider_session_id?;
    if provider == "codex" {
        find_codex_rollout(sid, provider_home)
    } else {
        find_claude_transcript(&claude_config_dir(provider_home), cwd?, sid)
    }
}

/// Claude's config folder: the account's CLAUDE_CONFIG_DIR when the session runs
/// on a managed account, then the env, then `~/.claude`. Transcripts live in its
/// `projects/` folder, so a fixed `~/.claude` missed every managed account.
fn claude_config_dir(provider_home: Option<&str>) -> PathBuf {
    provider_home
        .filter(|v| !v.trim().is_empty())
        .map(str::to_string)
        .or_else(|| std::env::var("CLAUDE_CONFIG_DIR").ok())
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".claude"))
}

/// Claude replaces every non-alphanumeric character with '-' in the dir name.
fn claude_project_dir_name(workspace_path: &str) -> String {
    workspace_path
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn find_claude_transcript(config_dir: &Path, cwd: &str, conversation_id: &str) -> Option<PathBuf> {
    // The id becomes a file name: never a path.
    if conversation_id.is_empty()
        || !conversation_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || conversation_id.starts_with('.')
    {
        return None;
    }
    let in_root = |root: &Path| {
        let file = root
            .join("projects")
            .join(claude_project_dir_name(cwd))
            .join(format!("{conversation_id}.jsonl"));
        file.exists().then_some(file)
    };
    // Each claude account has its own config dir and the conversation lives in
    // only one: the session's own dir first, then every known account dir.
    in_root(config_dir).or_else(|| {
        crate::commands::provider_account::claude_config_roots()
            .into_iter()
            .find_map(|(_, root)| in_root(&root))
    })
}

fn codex_sessions_root(provider_home: Option<&str>) -> PathBuf {
    let home = match provider_home
        .filter(|v| !v.trim().is_empty())
        .map(str::to_string)
        .or_else(crate::commands::provider_account::active_codex_home)
        .or_else(|| std::env::var("CODEX_HOME").ok())
    {
        Some(v) if !v.trim().is_empty() => PathBuf::from(v),
        _ => home_dir().join(".codex"),
    };
    home.join("sessions")
}

/// os.homedir() (same resolution as the other domains).
fn home_dir() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    PathBuf::from(std::env::var(var).unwrap_or_else(|_| ".".into()))
}

/// Rollouts are named `rollout-<ISO-ts>-<uuid>.jsonl` in per-date directories:
/// start from the most recent days and stop at MAX_ROLLOUT_DAYS.
fn find_codex_rollout(codex_session_id: &str, provider_home: Option<&str>) -> Option<PathBuf> {
    let root = codex_sessions_root(provider_home);
    let suffix = format!("-{codex_session_id}.jsonl");

    let dirs_desc = |dir: &Path, width: usize| -> Vec<String> {
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.len() == width && n.chars().all(|c| c.is_ascii_digit()))
            .collect();
        names.sort();
        names.reverse();
        names
    };

    let mut days_visited = 0usize;
    for year in dirs_desc(&root, 4) {
        for month in dirs_desc(&root.join(&year), 2) {
            for day in dirs_desc(&root.join(&year).join(&month), 2) {
                if days_visited >= MAX_ROLLOUT_DAYS {
                    return None;
                }
                days_visited += 1;
                let day_dir = root.join(&year).join(&month).join(&day);
                let Ok(entries) = fs::read_dir(&day_dir) else {
                    continue;
                };
                for entry in entries.filter_map(|e| e.ok()) {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.ends_with(&suffix) {
                        return Some(day_dir.join(name));
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_takes_the_last_assistant_model() {
        let lines = vec![
            r#"{"type":"assistant","message":{"model":"claude-opus-5"}}"#.to_string(),
            r#"{"type":"user","message":{"content":"hi"}}"#.to_string(),
            r#"{"type":"assistant","message":{"model":"claude-haiku-4-5"}}"#.to_string(),
        ];
        assert_eq!(
            model_from_lines(&lines, "claude-code-cli").as_deref(),
            Some("claude-haiku-4-5"),
        );
    }

    #[test]
    fn synthetic_model_is_ignored() {
        let lines = vec![r#"{"type":"assistant","message":{"model":"<synthetic>"}}"#.to_string()];
        assert!(model_from_lines(&lines, "claude-code-cli").is_none());
    }

    #[test]
    fn rollout_reads_turn_context_model() {
        let lines = vec![
            r#"{"type":"turn_context","payload":{"model":"gpt-5.5"}}"#.to_string(),
            r#"{"type":"event_msg","payload":{"type":"token_count","info":null}}"#.to_string(),
            r#"{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}"#.to_string(),
        ];
        assert_eq!(
            model_from_lines(&lines, "codex").as_deref(),
            Some("gpt-5.6-sol")
        );
    }

    #[test]
    fn claude_transcript_follows_the_account_config_dir() {
        let root = std::env::temp_dir().join(format!("po-claude-acct-{}", std::process::id()));
        let cwd = "/work/app";
        let dir = root.join("projects").join(claude_project_dir_name(cwd));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("conv-1.jsonl"), "{}\n").unwrap();
        let home = root.to_string_lossy().to_string();
        assert_eq!(
            find_log_file("claude-code-cli", Some(cwd), Some("conv-1"), Some(&home)),
            Some(dir.join("conv-1.jsonl"))
        );
        // Ids are file names, never paths.
        assert!(find_claude_transcript(&root, cwd, "../conv-1").is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn claude_dir_name_matches_cli_escaping() {
        assert_eq!(
            claude_project_dir_name("/Users/me/dev/app"),
            "-Users-me-dev-app"
        );
    }

    /// End-to-end on a REAL transcript written by Claude Code: building the
    /// path from the cwd, reading the tail, parsing. Skips itself when there is no
    /// transcript on this machine (CI, another user).
    #[test]
    fn resolves_a_real_claude_transcript() {
        let root = home_dir().join(".claude").join("projects");
        let Ok(projects) = fs::read_dir(&root) else {
            return;
        };

        for project in projects.filter_map(|e| e.ok()) {
            let dir = project.path();
            let Ok(files) = fs::read_dir(&dir) else {
                continue;
            };
            // The largest in the folder: the one with the most turns in it.
            let Some(biggest) = files
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
                .max_by_key(|e| e.metadata().map(|m| m.len()).unwrap_or(0))
            else {
                continue;
            };
            if biggest.metadata().map(|m| m.len()).unwrap_or(0) < 4096 {
                continue;
            }

            let conversation_id = biggest
                .path()
                .file_stem()
                .unwrap()
                .to_string_lossy()
                .to_string();
            // The folder name IS the escaped cwd: rebuilding it is not
            // possible (the escaping is lossy), so we check the part that
            // matters — tail + parsing — on the file find_claude_transcript
            // would have returned.
            let expected = dir.join(format!("{conversation_id}.jsonl"));
            assert!(expected.exists(), "expected path not found: {expected:?}");

            let lines = read_tail_lines(&expected, TAIL_BYTES).expect("readable tail");
            if let Some(model) = model_from_lines(&lines, "claude-code-cli") {
                assert!(!model.is_empty());
                return; // one real resolved transcript is enough
            }
        }
    }
}

#[cfg(test)]
mod user_messages_tests {
    use super::*;

    #[test]
    fn claude_user_messages_skip_tool_results_and_meta() {
        let lines = vec![
            r#"{"type":"user","message":{"role":"user","content":"list must show newest first"}}"#.to_string(),
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}"#.to_string(),
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"x"}]}}"#.to_string(),
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<command-name>/model</command-name>"}}"#.to_string(),
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"done moves items to archivio.json"}]}}"#.to_string(),
        ];
        assert_eq!(
            user_messages_from_lines(&lines, "claude-code-cli"),
            vec![
                "list must show newest first",
                "done moves items to archivio.json"
            ]
        );
    }

    #[test]
    fn codex_user_messages_skip_environment_context() {
        let lines = vec![
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd</environment_context>"}]}}"#.to_string(),
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"add a remove command"}]}}"#.to_string(),
        ];
        assert_eq!(
            user_messages_from_lines(&lines, "codex"),
            vec!["add a remove command"]
        );
    }
}
