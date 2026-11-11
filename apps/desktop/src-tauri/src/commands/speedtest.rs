//! Speed Test — model baselines, local run history and the
//! `speedtest:list-models` command.
//!
//! In this module: catalog of testable models, hand-curated reference
//! bands, in/out-of-band classification of the measurement, local
//! per-machine history (rolling median) and the `speedtest:list-models` command
//! that merges catalog + CLI availability + baseline + history.
//!
//! `speedtest_run`/`speedtest_abort` (at the bottom) run the speed round and emit
//! `speedtest:progress` events.
//! TODO: graded analysis round with ground truth computed on the
//! workspace, cost estimate.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ── Model baselines ──────────────────────────────────────────────────────

/// Expected end-to-end throughput band (output tokens ÷ wall time), NOT the
/// raw API streaming speed: these are the numbers a healthy machine
/// actually observes through the same `claude -p` / `codex exec` path.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedTps {
    pub min: f64,
    pub max: f64,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelBaseline {
    /// "fast" | "balanced" | "reasoning" — dedicated vocabulary (it is neither the
    /// local ModelTier nor the machine's PerformanceLevel).
    pub tier: &'static str,
    pub expected_tps: ExpectedTps,
}

const fn baseline(tier: &'static str, min: f64, max: f64) -> ModelBaseline {
    ModelBaseline {
        tier,
        expected_tps: ExpectedTps { min, max },
    }
}

/// Keyed by SPEED_TEST_MODELS id — keep the two in sync.
pub(crate) fn model_baseline(model_id: &str) -> Option<ModelBaseline> {
    Some(match model_id {
        "claude-haiku-4-5" => baseline("fast", 60.0, 110.0),
        "claude-sonnet-5" => baseline("balanced", 40.0, 80.0),
        // Max raised 60 → 70 after real end-to-end runs (~65 tok/s, 2026-07-16).
        "claude-fable-5-2" => baseline("reasoning", 25.0, 70.0),
        "claude-fable-5-1" => baseline("reasoning", 25.0, 70.0),
        "claude-fable-5" => baseline("reasoning", 25.0, 70.0),
        "claude-opus-5-5" => baseline("reasoning", 25.0, 60.0),
        "claude-opus-5" => baseline("reasoning", 25.0, 60.0),
        "claude-opus-4-8" => baseline("reasoning", 25.0, 55.0),
        // GPT-6 Astra = frontier flagship.
        "gpt-6-astra" | "gpt-6-sol" => baseline("reasoning", 20.0, 60.0),
        "gpt-6-luna" => baseline("fast", 50.0, 100.0),
        // Famiglia GPT-5.6: Sol = frontier, Terra = balanced, Luna = fast.
        "gpt-5.6-sol" => baseline("reasoning", 20.0, 55.0),
        "gpt-5.6-terra" => baseline("balanced", 30.0, 70.0),
        "gpt-5.6-luna" => baseline("fast", 50.0, 100.0),
        "gpt-5.5" | "gpt-5.4-mini" => baseline("reasoning", 20.0, 50.0),
        _ => return None,
    })
}

/// classifyTps — places a measurement inside/outside the model's band.
/// "unknown" = no measurement (failed speed round) or no baseline.
pub fn classify_tps(measured: Option<f64>, baseline: Option<ModelBaseline>) -> &'static str {
    let (Some(b), Some(m)) = (baseline, measured) else {
        return "unknown";
    };
    if !m.is_finite() || m <= 0.0 {
        return "unknown";
    }
    if m < b.expected_tps.min {
        "below"
    } else if m > b.expected_tps.max {
        "above"
    } else {
        "within"
    }
}

// ── Model catalog (SPEED_TEST_MODELS, public part) ──────────────────────────

/// Catalog entry exposed to the renderer. `command`/`analysisCommand` stay
/// internal to the runner and are never part of the response.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedTestModelInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub provider: &'static str,
    pub provider_label: &'static str,
    pub api: ModelApi,
}

#[derive(Clone, Copy, Serialize)]
pub struct ModelApi {
    pub vendor: &'static str,
    pub model: &'static str,
}

/// Testable catalog — Claude Code and Codex, 2026-07 lineup. The ids go
/// straight to the CLI (`--model` / `-m`): every entry is a REAL model.
/// KEEP IN SYNC with the webapp's FALLBACK_MODELS and with the baselines above.
pub fn speed_test_models() -> Vec<SpeedTestModelInfo> {
    let claude = |id: &'static str, label: &'static str| SpeedTestModelInfo {
        id,
        label,
        provider: "claude-code-cli",
        provider_label: "Claude Code",
        api: ModelApi {
            vendor: "anthropic",
            model: id,
        },
    };
    let codex = |id: &'static str, label: &'static str| SpeedTestModelInfo {
        id,
        label,
        provider: "codex",
        provider_label: "Codex",
        api: ModelApi {
            vendor: "openai",
            model: id,
        },
    };
    vec![
        claude("claude-fable-5-2", "Claude Fable 5.2"),
        claude("claude-fable-5-1", "Claude Fable 5.1"),
        claude("claude-fable-5", "Claude Fable 5"),
        claude("claude-opus-5-5", "Claude Opus 5.5"),
        claude("claude-opus-5", "Claude Opus 5"),
        claude("claude-opus-4-8", "Claude Opus 4.8"),
        claude("claude-sonnet-5", "Claude Sonnet 5"),
        claude("claude-haiku-4-5", "Claude Haiku 4.5"),
        codex("gpt-6-astra", "GPT-6-Astra"),
        codex("gpt-6-sol", "GPT-6-Sol"),
        codex("gpt-6-luna", "GPT-6-Luna"),
        codex("gpt-5.6-sol", "GPT-5.6-Sol"),
        codex("gpt-5.6-terra", "GPT-5.6-Terra"),
        codex("gpt-5.6-luna", "GPT-5.6-Luna"),
        codex("gpt-5.5", "GPT-5.5"),
        codex("gpt-5.4-mini", "GPT-5.4-Mini"),
    ]
}

// ── Speed test history ───────────────────────────────────────────────────

const MAX_ENTRIES_PER_MODEL: usize = 20;

/// A recorded run (the "normal for your machine" next to the static
/// bands: throughput is local to machine and network by definition).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedTestHistoryEntry {
    pub ts: String,
    pub mode_id: String,
    pub cwd: String,
    pub tokens_per_sec: f64,
    pub output_tokens: i64,
    /// True when the tokens come from the chars/4 fallback → excluded from medians.
    pub tokens_estimated: bool,
    pub speed_sample_ms: i64,
    pub analysis_ms: Option<i64>,
    pub accuracy_pct: Option<f64>,
    pub wall_ms: i64,
}

#[derive(Default, Serialize, Deserialize)]
struct HistoryFile {
    #[serde(default = "one")]
    version: u32,
    #[serde(default)]
    models: HashMap<String, Vec<SpeedTestHistoryEntry>>,
}

fn one() -> u32 {
    1
}

fn history_path() -> PathBuf {
    crate::commands::hook::hook_data_dir().join("speed-test-history.json")
}

fn load_history() -> HistoryFile {
    std::fs::read_to_string(history_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_history(file: &HistoryFile) {
    let path = history_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(file) {
        let _ = std::fs::write(&path, json);
    }
}

/// Serializes read-modify-write of the history file: up to three models race
/// at once and can finish in the same instant; without it one run would
/// overwrite another's.
static HISTORY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// record — adds a run and trims to MAX_ENTRIES_PER_MODEL.
pub fn record_run(model_id: &str, entry: SpeedTestHistoryEntry) {
    let _guard = HISTORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = load_history();
    let entries = file.models.entry(model_id.to_string()).or_default();
    entries.push(entry);
    while entries.len() > MAX_ENTRIES_PER_MODEL {
        entries.remove(0);
    }
    save_history(&file);
}

/// Median tokens/sec of the NON-estimated runs (chars/4 fallbacks skew it).
fn median_tps(entries: &[SpeedTestHistoryEntry]) -> (Option<f64>, usize) {
    let mut values: Vec<f64> = entries
        .iter()
        .filter(|e| !e.tokens_estimated && e.tokens_per_sec > 0.0)
        .map(|e| e.tokens_per_sec)
        .collect();
    let runs = values.len();
    if runs == 0 {
        return (None, 0);
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = runs / 2;
    let median = if runs.is_multiple_of(2) {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    };
    (Some(median), runs)
}

/// summarize — { runs, medianTps, lastRunAt } for a model.
pub fn summarize(model_id: &str) -> Value {
    let file = load_history();
    let entries = file.models.get(model_id).cloned().unwrap_or_default();
    let (median, runs) = median_tps(&entries);
    json!({
        "runs": runs,
        "medianTps": median,
        "lastRunAt": entries.last().map(|e| e.ts.clone()),
    })
}

// ── Speed probe (part of the runner) ─────────────────────────────────────
// Measurement: output tokens declared by the provider ÷ total time,
// N samples, the MEDIAN is reported. The prompt belongs to the app and is fixed: whoever asks for a measurement
// (even a plugin, via `ai:benchmark`) only picks the model and only gets numbers back.

pub const SPEED_PROMPT: &str =
    "Write a plain-text, single-paragraph explanation (about 250 words) of what a \
code review is and why teams do it. No lists, no markdown, no headings.";
pub const SPEED_SAMPLES: usize = 3;
const SPEED_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedSample {
    pub wall_ms: u64,
    pub output_tokens: i64,
    /// True when the provider did not declare the tokens and we fell back to characters ÷ 4.
    pub tokens_estimated: bool,
    pub tokens_per_sec: f64,
}

/// FIXED command per model. The id comes from the app's catalog, never from outside.
/// Claude starts without tools; Codex read-only. In both cases the folder is empty.
pub fn speed_command(model: &SpeedTestModelInfo) -> String {
    match model.provider {
        "codex" => format!("codex exec --skip-git-repo-check --color never --sandbox read-only --ephemeral --json -m '{}' -", model.id),
        _ => format!(
            "claude -p --output-format json --model '{}' --tools '' --strict-mcp-config --disable-slash-commands --no-session-persistence",
            model.id
        ),
    }
}

/// From the CLI JSON: (declared output tokens, text characters). A provider error becomes Err.
pub fn parse_speed_output(provider: &str, stdout: &str) -> Result<(Option<i64>, usize), String> {
    if provider == "codex" {
        let (mut tokens, mut chars, mut failure) = (None, 0usize, None);
        for line in stdout.lines() {
            let Ok(ev) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            match ev["type"].as_str().unwrap_or("") {
                "turn.completed" => {
                    let get = |k: &str| ev["usage"][k].as_i64().unwrap_or(0);
                    let sum = get("output_tokens") + get("reasoning_output_tokens");
                    if sum > 0 {
                        tokens = Some(sum);
                    }
                }
                "item.completed" if ev["item"]["type"] == "agent_message" => {
                    chars += ev["item"]["text"]
                        .as_str()
                        .map(|t| t.chars().count())
                        .unwrap_or(0)
                }
                "error" | "turn.failed" => {
                    failure = failure.or_else(|| Some(provider_error_text(&ev)))
                }
                _ => {}
            }
        }
        return match (tokens, chars, failure) {
            (None, 0, Some(msg)) => Err(msg),
            (None, 0, None) => Err("the provider returned nothing".into()),
            (t, c, _) => Ok((t, c)),
        };
    }
    let doc: Value =
        serde_json::from_str(stdout).map_err(|_| "unreadable provider response".to_string())?;
    // `--output-format json` can be a single object or a list of events ending with the result.
    let result = match &doc {
        Value::Array(items) => items
            .iter()
            .rev()
            .find(|v| v["type"] == "result")
            .cloned()
            .unwrap_or(Value::Null),
        other => other.clone(),
    };
    if result["is_error"] == true {
        return Err(result["result"]
            .as_str()
            .unwrap_or("provider error")
            .chars()
            .take(300)
            .collect());
    }
    let chars = result["result"]
        .as_str()
        .map(|t| t.chars().count())
        .unwrap_or(0);
    let tokens = result["usage"]["output_tokens"].as_i64().filter(|t| *t > 0);
    if tokens.is_none() && chars == 0 {
        return Err("the provider returned nothing".into());
    }
    Ok((tokens, chars))
}

/// Codex's message is often JSON inside a string: the useful text is extracted.
fn provider_error_text(ev: &Value) -> String {
    let raw = ev["message"]
        .as_str()
        .or_else(|| ev["error"]["message"].as_str())
        .unwrap_or("provider error");
    let inner = serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string));
    inner
        .unwrap_or_else(|| raw.to_string())
        .chars()
        .take(300)
        .collect()
}

pub fn sample_from(wall_ms: u64, tokens: Option<i64>, chars: usize) -> SpeedSample {
    let output_tokens = tokens.unwrap_or((chars as f64 / 4.0).round() as i64);
    let secs = (wall_ms.max(1)) as f64 / 1000.0;
    SpeedSample {
        wall_ms,
        output_tokens,
        tokens_estimated: tokens.is_none(),
        tokens_per_sec: ((output_tokens as f64 / secs) * 10.0).round() / 10.0,
    }
}

/// The median sample by tokens per second. With an even count the one below the middle is taken.
pub fn median_sample(samples: &[SpeedSample]) -> Option<SpeedSample> {
    let mut sorted: Vec<&SpeedSample> = samples.iter().collect();
    sorted.sort_by(|a, b| {
        a.tokens_per_sec
            .partial_cmp(&b.tokens_per_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    sorted
        .get(sorted.len().saturating_sub(1) / 2)
        .map(|s| (*s).clone())
}

pub async fn speed_probe(model: &SpeedTestModelInfo) -> Result<SpeedSample, String> {
    let out = crate::commands::providers::spawn_cli_isolated(
        &speed_command(model),
        SPEED_PROMPT,
        SPEED_TIMEOUT,
    )
    .await?;
    match parse_speed_output(model.provider, &out.stdout) {
        Ok((tokens, chars)) => Ok(sample_from(out.wall_ms, tokens, chars)),
        Err(e) if out.success => Err(e),
        Err(e) => Err(if out.stderr.is_empty() || !e.starts_with("unreadable") {
            e
        } else {
            out.stderr.chars().take(300).collect()
        }),
    }
}

/// Measures a model: `SPEED_SAMPLES` samples, median, updated history. Returns ONLY numbers.
/// `on_sample(done, total)` is for callers that want to show progress.
pub async fn benchmark_model<F: FnMut(usize, usize)>(model_id: &str, mut on_sample: F) -> Value {
    let Some(model) = speed_test_models().into_iter().find(|m| m.id == model_id) else {
        return json!({ "id": model_id, "ok": false, "error": "model not in catalog" });
    };
    let started = std::time::Instant::now();
    let mut samples: Vec<SpeedSample> = Vec::new();
    let mut last_error = None;
    for i in 0..SPEED_SAMPLES {
        match speed_probe(&model).await {
            Ok(s) => samples.push(s),
            Err(e) => {
                last_error = Some(e);
                // A model the provider rejects doesn't get better on the second attempt.
                if samples.is_empty() {
                    on_sample(SPEED_SAMPLES, SPEED_SAMPLES);
                    break;
                }
            }
        }
        on_sample(i + 1, SPEED_SAMPLES);
    }
    let base = json!({ "id": model.id, "label": model.label, "provider": model.provider, "providerLabel": model.provider_label, "baseline": model_baseline(model.id) });
    let Some(median) = median_sample(&samples) else {
        return merge(
            base,
            json!({ "ok": false, "error": last_error.unwrap_or_else(|| "no measurement".into()), "classification": "unknown", "history": summarize(model.id) }),
        );
    };
    record_run(
        model.id,
        SpeedTestHistoryEntry {
            ts: chrono::Utc::now().to_rfc3339(),
            mode_id: "speed".into(),
            cwd: String::new(),
            tokens_per_sec: median.tokens_per_sec,
            output_tokens: median.output_tokens,
            tokens_estimated: median.tokens_estimated,
            speed_sample_ms: median.wall_ms as i64,
            analysis_ms: None,
            accuracy_pct: None,
            wall_ms: started.elapsed().as_millis() as i64,
        },
    );
    merge(
        base,
        json!({
            "ok": true,
            "tokensPerSec": median.tokens_per_sec,
            "outputTokens": median.output_tokens,
            "tokensEstimated": median.tokens_estimated,
            "sampleMs": median.wall_ms,
            "samples": samples,
            "wallMs": started.elapsed().as_millis() as u64,
            "classification": classify_tps(Some(median.tokens_per_sec), model_baseline(model.id)),
            "history": summarize(model.id),
        }),
    )
}

fn merge(mut a: Value, b: Value) -> Value {
    if let (Some(a), Some(b)) = (a.as_object_mut(), b.as_object()) {
        for (k, v) in b {
            a.insert(k.clone(), v.clone());
        }
    }
    a
}

// ── Commands ──────────────────────────────────────────────────────────────

/// speedtest:list-models — catalog + CLI availability (one probe per
/// distinct provider) + reference band + local history.
#[tauri::command]
pub async fn speedtest_list_models() -> Value {
    tauri::async_runtime::spawn_blocking(|| {
        let models = speed_test_models();
        // A single probe per distinct provider (a missing CLI costs
        // up to ~2.5s on the first uncached call).
        let mut availability: HashMap<&str, bool> = HashMap::new();
        for m in &models {
            availability
                .entry(m.provider)
                .or_insert_with(|| crate::commands::session::check_provider(m.provider).installed);
        }

        let data: Vec<Value> = models
            .iter()
            .map(|m| {
                let baseline = model_baseline(m.id);
                json!({
                    "id": m.id,
                    "label": m.label,
                    "provider": m.provider,
                    "providerLabel": m.provider_label,
                    "api": m.api,
                    // A failed probe must not hide the models.
                    "available": availability.get(m.provider).copied().unwrap_or(true),
                    "baseline": baseline,
                    "history": summarize(m.id),
                })
            })
            .collect();

        // TODO: fill `modes` from SPEED_TEST_MODES (sub-agent
        // MODE_PRESETS, not wired yet) — empty list until then.
        json!({ "ok": true, "data": data, "modes": [] })
    })
    .await
    .unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string(), "data": [], "modes": [] }))
}

// ── speedtest:run / speedtest:abort (native AI Agent Evals page) ─────────
//
// Only the "speed" round is implemented. It emits `speedtest:progress` events
// (queue, model-start, round-start, progress, round-done, model-done,
// done|aborted) for the native page. The "analysis" round (accuracy on the
// workspace) is NOT implemented: `cwd` and `modeId` are accepted and ignored.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};

const PROGRESS_EVENT: &str = "speedtest:progress";
const MAX_RUN_MODELS: usize = 3;
static RUN_ACTIVE: AtomicBool = AtomicBool::new(false);
static RUN_ABORTED: AtomicBool = AtomicBool::new(false);
static RUN_TASKS: Mutex<Vec<tokio::task::AbortHandle>> = Mutex::new(Vec::new());

fn emit_progress(app: &AppHandle, payload: Value) {
    let _ = app.emit(PROGRESS_EVENT, payload);
}

/// Aborts the task when dropped. Dropping a plain `JoinHandle` detaches the
/// task instead: when Stop aborted `run_model`, its progress heartbeat kept
/// emitting events for that model every 500 ms until the app quit, and the
/// next run's page picked them up.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn cli_missing_result(model: &SpeedTestModelInfo) -> Value {
    json!({
        "modelId": model.id, "label": model.label, "provider": model.provider,
        "ok": false, "error": format!("{} CLI not found on PATH", model.provider_label),
        "rounds": [], "wallMs": 0,
        "avgTtftMs": 0, "avgTotalMs": 0, "totalChars": 0, "avgCharsPerSec": 0, "accuracyPct": 0,
    })
}

fn aborted_result(model: &SpeedTestModelInfo) -> Value {
    json!({
        "modelId": model.id, "label": model.label, "provider": model.provider,
        "ok": false, "error": "Run aborted",
        "rounds": [], "wallMs": 0,
        "avgTtftMs": 0, "avgTotalMs": 0, "totalChars": 0, "avgCharsPerSec": 0, "accuracyPct": 0,
    })
}

/// One model: speed round with a progress heartbeat every 500 ms, then the result in the shape
/// of the webapp's `SpeedTestModelResult` (`speed` round only, no `cost`).
async fn run_model(
    app: AppHandle,
    model: SpeedTestModelInfo,
    position: usize,
    total: usize,
) -> Value {
    emit_progress(
        &app,
        json!({ "type": "model-start", "modelId": model.id, "label": model.label, "position": position, "totalModels": total }),
    );
    emit_progress(
        &app,
        json!({ "type": "round-start", "modelId": model.id, "round": "speed", "prompt": SPEED_PROMPT, "samplesTotal": SPEED_SAMPLES }),
    );

    let started = std::time::Instant::now();
    let done_samples = Arc::new(AtomicUsize::new(0));
    let sample_started = Arc::new(Mutex::new(std::time::Instant::now()));

    let heartbeat = {
        let app = app.clone();
        let model_id = model.id;
        let done_samples = done_samples.clone();
        let sample_started = sample_started.clone();
        AbortOnDrop(tokio::spawn(async move {
            loop {
                let done = done_samples.load(Ordering::SeqCst);
                let sample_elapsed = sample_started
                    .lock()
                    .map(|s| s.elapsed().as_millis() as u64)
                    .unwrap_or(0);
                emit_progress(
                    &app,
                    json!({
                        "type": "progress", "modelId": model_id, "round": "speed",
                        "elapsedMs": sample_elapsed, "timeoutMs": SPEED_TIMEOUT.as_millis() as u64,
                        "modelElapsedMs": started.elapsed().as_millis() as u64,
                        "phase": { "kind": "speed", "sample": (done + 1).min(SPEED_SAMPLES), "samplesTotal": SPEED_SAMPLES },
                    }),
                );
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }))
    };

    let bench = benchmark_model(model.id, |done, _total| {
        done_samples.store(done, Ordering::SeqCst);
        if let Ok(mut s) = sample_started.lock() {
            *s = std::time::Instant::now();
        }
    })
    .await;
    drop(heartbeat);

    let wall_ms = started.elapsed().as_millis() as u64;
    let ok = bench["ok"] == true;
    let samples = bench["samples"].as_array().cloned().unwrap_or_default();
    let sum_u64 = |k: &str| {
        samples
            .iter()
            .map(|s| s[k].as_u64().unwrap_or(0))
            .sum::<u64>()
    };
    let sum_i64 = |k: &str| {
        samples
            .iter()
            .map(|s| s[k].as_i64().unwrap_or(0))
            .sum::<i64>()
    };
    let sample_ms = bench["sampleMs"].as_u64().unwrap_or(0).max(1);
    let output_tokens = bench["outputTokens"].as_i64().unwrap_or(0);
    // The engine reports tokens, not characters: estimate 4 characters per token, like the webapp.
    let output_chars = output_tokens.saturating_mul(4);
    let chars_per_sec = ((output_chars as f64 / sample_ms as f64) * 1000.0).round() as i64;
    let metrics = if ok {
        json!({
            "round": "speed", "ok": true,
            "ttftMs": sample_ms, "totalMs": sample_ms,
            "outputChars": output_chars, "charsPerSec": chars_per_sec,
            "outputTokens": output_tokens, "tokensPerSec": bench["tokensPerSec"],
            "tokensEstimated": bench["tokensEstimated"],
            "speedSamples": samples.len(), "samplesWallMs": sum_u64("wallMs"), "samplesOutputTokens": sum_i64("outputTokens"),
        })
    } else {
        json!({
            "round": "speed", "ok": false, "error": bench["error"],
            "ttftMs": 0, "totalMs": wall_ms, "outputChars": 0, "charsPerSec": 0,
        })
    };
    emit_progress(
        &app,
        json!({ "type": "round-done", "modelId": model.id, "metrics": metrics }),
    );

    let baseline = model_baseline(model.id).map(|b| json!({
        "tier": b.tier, "expectedTps": b.expected_tps,
        "classification": bench["classification"],
        "measuredTps": if ok { bench["tokensPerSec"].clone() } else { Value::Null },
        "tokensEstimated": bench["tokensEstimated"] == true,
        "historyMedianTps": bench["history"]["medianTps"], "historyRuns": bench["history"]["runs"],
    }));
    let result = json!({
        "modelId": model.id, "label": model.label, "provider": model.provider,
        "ok": ok,
        "error": if ok { Value::Null } else { bench["error"].clone() },
        "rounds": [metrics],
        "wallMs": wall_ms,
        "baseline": baseline,
        "avgTtftMs": if ok { sample_ms } else { 0 }, "avgTotalMs": if ok { sample_ms } else { 0 },
        "totalChars": if ok { output_chars } else { 0 }, "avgCharsPerSec": if ok { chars_per_sec } else { 0 },
        "accuracyPct": 0,
    });
    emit_progress(
        &app,
        json!({ "type": "model-done", "modelId": model.id, "result": result }),
    );
    result
}

/// speedtest:run — up to 3 models racing (they start together), results in the webapp's shape.
/// `cwd` and `mode_id` are accepted but unused: the analysis round is not implemented.
#[tauri::command]
pub async fn speedtest_run(
    app: AppHandle,
    model_ids: Vec<String>,
    cwd: Option<String>,
    mode_id: Option<String>,
) -> Value {
    let _ = (cwd, mode_id);
    if RUN_ACTIVE.swap(true, Ordering::SeqCst) {
        return json!({ "ok": false, "error": "A speed test is already running" });
    }
    RUN_ABORTED.store(false, Ordering::SeqCst);
    let catalog = speed_test_models();
    let models: Vec<SpeedTestModelInfo> = model_ids
        .iter()
        .take(MAX_RUN_MODELS)
        .filter_map(|id| catalog.iter().find(|m| m.id == id).cloned())
        .collect();
    if models.is_empty() {
        RUN_ACTIVE.store(false, Ordering::SeqCst);
        return json!({ "ok": false, "error": "No model selected" });
    }

    let mut queue: Vec<Value> = models
        .iter()
        .enumerate()
        .map(|(i, m)| json!({ "modelId": m.id, "label": m.label, "position": i, "status": "running" }))
        .collect();
    let emit_queue = |app: &AppHandle, queue: &[Value]| {
        emit_progress(app, json!({ "type": "queue", "entries": queue }))
    };

    // Pre-flight: one probe per distinct provider, so a missing CLI is a clear verdict.
    let providers: Vec<&'static str> = {
        let mut v: Vec<&'static str> = models.iter().map(|m| m.provider).collect();
        v.dedup();
        v
    };
    let availability: HashMap<&'static str, bool> =
        tauri::async_runtime::spawn_blocking(move || {
            providers
                .into_iter()
                .map(|p| (p, crate::commands::session::check_provider(p).installed))
                .collect()
        })
        .await
        .unwrap_or_default();

    let mut results: Vec<Value> = Vec::new();
    let mut tasks: Vec<(usize, tokio::task::JoinHandle<Value>)> = Vec::new();
    let total = models.len();
    for (i, model) in models.iter().enumerate() {
        if availability.get(model.provider).copied() == Some(false) {
            queue[i]["status"] = json!("cli-missing");
            let result = cli_missing_result(model);
            emit_progress(
                &app,
                json!({ "type": "model-done", "modelId": model.id, "result": result }),
            );
            results.push(result);
        } else {
            let handle = tokio::spawn(run_model(app.clone(), model.clone(), i, total));
            if let Ok(mut t) = RUN_TASKS.lock() {
                t.push(handle.abort_handle());
            }
            tasks.push((i, handle));
        }
    }
    emit_queue(&app, &queue);

    // Race: all together, at the same instant, on the same machine.
    for (i, handle) in tasks {
        let result = match handle.await {
            Ok(r) => r,
            Err(_) => {
                emit_progress(
                    &app,
                    json!({ "type": "model-done", "modelId": models[i].id, "result": aborted_result(&models[i]) }),
                );
                aborted_result(&models[i])
            }
        };
        queue[i]["status"] = json!(if result["ok"] == true {
            "done"
        } else {
            "failed"
        });
        emit_queue(&app, &queue);
        results.push(result);
    }
    if let Ok(mut t) = RUN_TASKS.lock() {
        t.clear();
    }
    RUN_ACTIVE.store(false, Ordering::SeqCst);

    let aborted = RUN_ABORTED.load(Ordering::SeqCst);
    emit_progress(
        &app,
        json!({ "type": if aborted { "aborted" } else { "done" }, "results": results }),
    );
    json!({ "ok": true, "results": results })
}

/// speedtest:abort — stops the race in progress: the tasks are canceled and with them
/// the child CLIs die (`kill_on_drop`).
#[tauri::command]
pub async fn speedtest_abort() -> Value {
    RUN_ABORTED.store(true, Ordering::SeqCst);
    if let Ok(mut t) = RUN_TASKS.lock() {
        for h in t.drain(..) {
            h.abort();
        }
    }
    json!({ "ok": true })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stop aborts the task running a model; its heartbeat must die with it
    /// instead of emitting progress for that model until the app quits.
    #[tokio::test]
    async fn the_heartbeat_dies_with_the_aborted_model_task() {
        let ticks = Arc::new(AtomicUsize::new(0));
        let outer = {
            let ticks = ticks.clone();
            tokio::spawn(async move {
                let ticks = ticks.clone();
                let _heartbeat = AbortOnDrop(tokio::spawn(async move {
                    loop {
                        ticks.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    }
                }));
                std::future::pending::<()>().await;
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        outer.abort();
        let _ = outer.await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let after_abort = ticks.load(Ordering::SeqCst);
        assert!(after_abort > 0);
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        assert_eq!(
            ticks.load(Ordering::SeqCst),
            after_abort,
            "heartbeat still running"
        );
    }

    #[test]
    fn classifies_a_measure_against_its_band() {
        let b = model_baseline("claude-haiku-4-5");
        assert_eq!(classify_tps(Some(30.0), b), "below");
        assert_eq!(classify_tps(Some(80.0), b), "within");
        assert_eq!(classify_tps(Some(200.0), b), "above");
        assert_eq!(classify_tps(None, b), "unknown");
        assert_eq!(classify_tps(Some(80.0), None), "unknown");
        assert_eq!(classify_tps(Some(0.0), b), "unknown");
    }

    #[test]
    fn speed_commands_are_fixed_and_isolated() {
        for m in speed_test_models() {
            let cmd = speed_command(&m);
            assert!(cmd.contains(&format!("'{}'", m.id)), "{cmd}");
            match m.provider {
                "codex" => assert!(
                    cmd.contains("--sandbox read-only")
                        && cmd.contains("--ephemeral")
                        && cmd.contains("--json"),
                    "{cmd}"
                ),
                _ => assert!(
                    cmd.contains("--tools '' ")
                        && cmd.contains("--strict-mcp-config")
                        && cmd.contains("--output-format json"),
                    "{cmd}"
                ),
            }
            assert!(
                !cmd.contains("dangerously") && !cmd.contains("bypass"),
                "{cmd}"
            );
        }
    }

    #[test]
    fn provider_output_becomes_numbers_only() {
        let claude = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":8507,"result":"A code review is…","usage":{"input_tokens":10,"output_tokens":588}}"#;
        assert_eq!(
            parse_speed_output("claude-code-cli", claude).unwrap(),
            (Some(588), 17)
        );
        let as_list = format!("[{{\"type\":\"system\"}},{claude}]");
        assert_eq!(
            parse_speed_output("claude-code-cli", &as_list).unwrap().0,
            Some(588)
        );
        assert!(parse_speed_output(
            "claude-code-cli",
            r#"{"type":"result","is_error":true,"result":"Credit balance is too low"}"#
        )
        .unwrap_err()
        .contains("Credit"));
        assert!(parse_speed_output("claude-code-cli", "not json").is_err());

        let codex = "{\"type\":\"thread.started\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"abcd\"}}\n{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":9,\"output_tokens\":300,\"reasoning_output_tokens\":40}}";
        assert_eq!(parse_speed_output("codex", codex).unwrap(), (Some(340), 4));
        let refused = r#"{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.\"}}"}"#;
        assert!(parse_speed_output("codex", refused)
            .unwrap_err()
            .starts_with("The 'gpt-5.4-mini' model is not supported"));
    }

    #[test]
    fn samples_fall_back_to_an_estimate_and_the_median_wins() {
        let real = sample_from(10_000, Some(500), 2000);
        assert_eq!((real.tokens_per_sec, real.tokens_estimated), (50.0, false));
        let guessed = sample_from(10_000, None, 2000);
        assert_eq!(
            (guessed.output_tokens, guessed.tokens_estimated),
            (500, true)
        );
        let picked = median_sample(&[
            sample_from(1000, Some(90), 0),
            sample_from(1000, Some(10), 0),
            sample_from(1000, Some(50), 0),
        ])
        .unwrap();
        assert_eq!(picked.tokens_per_sec, 50.0);
        assert!(median_sample(&[]).is_none());
    }

    #[test]
    fn every_catalog_model_has_a_baseline() {
        for m in speed_test_models() {
            assert!(
                model_baseline(m.id).is_some(),
                "missing baseline for {}",
                m.id
            );
        }
    }

    #[test]
    fn median_excludes_estimated_runs() {
        let mk = |tps: f64, estimated: bool| SpeedTestHistoryEntry {
            ts: "2026-08-02T00:00:00Z".into(),
            mode_id: "sprint".into(),
            cwd: "/tmp".into(),
            tokens_per_sec: tps,
            output_tokens: 100,
            tokens_estimated: estimated,
            speed_sample_ms: 1000,
            analysis_ms: None,
            accuracy_pct: None,
            wall_ms: 2000,
        };
        // 999 is estimated → it must stay out of the median.
        let entries = vec![
            mk(10.0, false),
            mk(20.0, false),
            mk(999.0, true),
            mk(30.0, false),
        ];
        let (median, runs) = median_tps(&entries);
        assert_eq!(runs, 3);
        assert_eq!(median, Some(20.0));
    }

    #[test]
    fn median_of_even_sample_averages_the_middle() {
        let mk = |tps: f64| SpeedTestHistoryEntry {
            ts: "t".into(),
            mode_id: "m".into(),
            cwd: "/".into(),
            tokens_per_sec: tps,
            output_tokens: 0,
            tokens_estimated: false,
            speed_sample_ms: 0,
            analysis_ms: None,
            accuracy_pct: None,
            wall_ms: 0,
        };
        let (median, runs) = median_tps(&[mk(10.0), mk(20.0), mk(30.0), mk(40.0)]);
        assert_eq!(runs, 4);
        assert_eq!(median, Some(25.0));
    }
}
