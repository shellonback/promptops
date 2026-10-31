//! Providers / AI domain — IPC commands:
//!
//!   - `providers:list`      -> `providers_list`
//!   - `providers:detect`    -> `providers_detect`
//!   - `ai:generate-text`    -> `ai_generate_text`
//!
//! NOTE: `provider:check` lives elsewhere, so it is NOT included here.
//!
//! The static manifest holds the provider ids/fields/i18n keys/icons/accent/weights;
//! `detect` probes the CLI binaries on PATH with `which`/`where`;
//! `ai:generate-text` runs the provider CLI via `cat <tmpfile> | <cli>` in
//! a login shell with an enriched PATH (`spawn_provider`).
//!
//! The return shapes match exactly those expected by the renderer:
//!   - list/detect: `{ ok: true, data: … }`
//!   - generate-text: `{ ok: true, text }` or `{ ok: false, error }`
//!
//! Standalone file: does NOT touch mod.rs / lib.rs / Cargo.toml.

use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Serialize;

// ─────────────────────────────────────────────────────────────────────────────
// DTO — faithful port of `ProviderCapability` (provider-capability.ts).
// All optional fields use `skip_serializing_if = Option::is_none` so
// the JSON object contains ONLY the keys the TS would have included (e.g. the
// `badgeKey` present only on some providers, `suggestionWeights` absent on
// generic-shell).
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct ProviderCli {
    /// Binary name used for `which <command>` detection.
    pub command: &'static str,
    /// i18n key with install/auth hint shown when CLI is not detected.
    #[serde(rename = "installHintKey")]
    pub install_hint_key: &'static str,
    /// When false, skip detection and assume available (e.g. generic-shell).
    pub detectable: bool,
}

#[derive(Clone, Serialize)]
pub struct ProviderCapabilities {
    pub reasoning: bool,
    pub execution: bool,
    #[serde(rename = "longContext")]
    pub long_context: bool,
    #[serde(rename = "toolUse")]
    pub tool_use: bool,
}

#[derive(Clone, Serialize)]
pub struct SuggestionWeights {
    pub refactor: f64,
    pub debug: f64,
    pub planning: f64,
    pub explore: f64,
}

#[derive(Clone, Serialize)]
pub struct ProviderI18n {
    #[serde(rename = "bestForKey")]
    pub best_for_key: &'static str,
    #[serde(rename = "limitationsKey")]
    pub limitations_key: &'static str,
    #[serde(rename = "microcopyKey")]
    pub microcopy_key: &'static str,
}

#[derive(Clone, Serialize)]
pub struct ProviderUi {
    pub icon: &'static str,
    pub accent: &'static str,
    #[serde(rename = "badgeKey", skip_serializing_if = "Option::is_none")]
    pub badge_key: Option<&'static str>,
}

#[derive(Clone, Serialize)]
pub struct ProviderCapability {
    pub id: &'static str,
    #[serde(rename = "displayName")]
    pub display_name: &'static str,
    pub tier: &'static str,
    #[serde(rename = "requiresApiKey")]
    pub requires_api_key: bool,
    #[serde(rename = "offlineCapable")]
    pub offline_capable: bool,
    pub cli: ProviderCli,
    pub capabilities: ProviderCapabilities,
    #[serde(rename = "suggestionWeights", skip_serializing_if = "Option::is_none")]
    pub suggestion_weights: Option<SuggestionWeights>,
    pub i18n: ProviderI18n,
    pub ui: ProviderUi,
}

// ─────────────────────────────────────────────────────────────────────────────
// Static manifest — verbatim copy of MANIFESTS (provider-capability-registry.ts)
// in the same order. Do NOT change ids/fields without aligning the TS.
// ─────────────────────────────────────────────────────────────────────────────

const DETECTION_TIMEOUT_MS: u64 = 500;
const DETECTION_CACHE_TTL_MS: u128 = 60_000;

pub(crate) fn manifests() -> Vec<ProviderCapability> {
    vec![
        ProviderCapability {
            id: "claude-code-cli",
            display_name: "Claude Code",
            tier: "cloud",
            requires_api_key: true,
            offline_capable: false,
            cli: ProviderCli {
                command: "claude",
                install_hint_key: "PROVIDERS.CLAUDE.INSTALL_HINT",
                detectable: true,
            },
            capabilities: ProviderCapabilities {
                reasoning: true,
                execution: true,
                long_context: true,
                tool_use: true,
            },
            suggestion_weights: Some(SuggestionWeights {
                refactor: 0.75,
                debug: 0.85,
                planning: 0.95,
                explore: 0.9,
            }),
            i18n: ProviderI18n {
                best_for_key: "PROVIDERS.CLAUDE.BEST_FOR",
                limitations_key: "PROVIDERS.CLAUDE.LIMITATIONS",
                microcopy_key: "PROVIDERS.CLAUDE.MICROCOPY",
            },
            ui: ProviderUi {
                icon: "ti-sparkles",
                accent: "indigo",
                badge_key: Some("PROVIDERS.BADGE.RECOMMENDED"),
            },
        },
        ProviderCapability {
            id: "codex",
            display_name: "Codex",
            tier: "cloud",
            requires_api_key: true,
            offline_capable: false,
            cli: ProviderCli {
                command: "codex",
                install_hint_key: "PROVIDERS.CODEX.INSTALL_HINT",
                detectable: true,
            },
            capabilities: ProviderCapabilities {
                reasoning: true,
                execution: true,
                long_context: false,
                tool_use: true,
            },
            suggestion_weights: Some(SuggestionWeights {
                refactor: 0.8,
                debug: 0.75,
                planning: 0.7,
                explore: 0.65,
            }),
            i18n: ProviderI18n {
                best_for_key: "PROVIDERS.CODEX.BEST_FOR",
                limitations_key: "PROVIDERS.CODEX.LIMITATIONS",
                microcopy_key: "PROVIDERS.CODEX.MICROCOPY",
            },
            ui: ProviderUi {
                icon: "ti-brand-openai",
                accent: "purple",
                badge_key: None,
            },
        },
        ProviderCapability {
            id: "gemini-cli",
            display_name: "Gemini",
            tier: "cloud",
            requires_api_key: true,
            offline_capable: false,
            cli: ProviderCli {
                command: "gemini",
                install_hint_key: "PROVIDERS.GEMINI.INSTALL_HINT",
                detectable: true,
            },
            capabilities: ProviderCapabilities {
                reasoning: true,
                execution: true,
                long_context: true,
                tool_use: true,
            },
            suggestion_weights: Some(SuggestionWeights {
                refactor: 0.7,
                debug: 0.7,
                planning: 0.8,
                explore: 0.85,
            }),
            i18n: ProviderI18n {
                best_for_key: "PROVIDERS.GEMINI.BEST_FOR",
                limitations_key: "PROVIDERS.GEMINI.LIMITATIONS",
                microcopy_key: "PROVIDERS.GEMINI.MICROCOPY",
            },
            ui: ProviderUi {
                icon: "ti-brand-google",
                accent: "violet",
                badge_key: None,
            },
        },
        ProviderCapability {
            id: "antigravity",
            display_name: "Antigravity",
            tier: "cloud",
            requires_api_key: true,
            offline_capable: false,
            cli: ProviderCli {
                command: "agy",
                install_hint_key: "PROVIDERS.ANTIGRAVITY.INSTALL_HINT",
                detectable: true,
            },
            capabilities: ProviderCapabilities {
                reasoning: true,
                execution: true,
                long_context: true,
                tool_use: true,
            },
            suggestion_weights: Some(SuggestionWeights {
                refactor: 0.8,
                debug: 0.8,
                planning: 0.85,
                explore: 0.9,
            }),
            i18n: ProviderI18n {
                best_for_key: "PROVIDERS.ANTIGRAVITY.BEST_FOR",
                limitations_key: "PROVIDERS.ANTIGRAVITY.LIMITATIONS",
                microcopy_key: "PROVIDERS.ANTIGRAVITY.MICROCOPY",
            },
            ui: ProviderUi {
                icon: "ti-rocket",
                accent: "cyan",
                badge_key: Some("PROVIDERS.BADGE.NEW"),
            },
        },
        ProviderCapability {
            id: "copilot",
            display_name: "GitHub Copilot",
            tier: "cloud",
            requires_api_key: true,
            offline_capable: false,
            cli: ProviderCli {
                command: "copilot",
                install_hint_key: "PROVIDERS.COPILOT.INSTALL_HINT",
                detectable: true,
            },
            capabilities: ProviderCapabilities {
                reasoning: true,
                execution: true,
                long_context: false,
                tool_use: true,
            },
            suggestion_weights: Some(SuggestionWeights {
                refactor: 0.75,
                debug: 0.7,
                planning: 0.65,
                explore: 0.6,
            }),
            i18n: ProviderI18n {
                best_for_key: "PROVIDERS.COPILOT.BEST_FOR",
                limitations_key: "PROVIDERS.COPILOT.LIMITATIONS",
                microcopy_key: "PROVIDERS.COPILOT.MICROCOPY",
            },
            ui: ProviderUi {
                icon: "ti-brand-github",
                accent: "fuchsia",
                badge_key: None,
            },
        },
        ProviderCapability {
            id: "cursor",
            display_name: "Cursor",
            tier: "cloud",
            requires_api_key: true,
            offline_capable: false,
            cli: ProviderCli {
                command: "cursor-agent",
                install_hint_key: "PROVIDERS.CURSOR.INSTALL_HINT",
                detectable: true,
            },
            capabilities: ProviderCapabilities {
                reasoning: true,
                execution: true,
                long_context: false,
                tool_use: true,
            },
            suggestion_weights: Some(SuggestionWeights {
                refactor: 0.7,
                debug: 0.75,
                planning: 0.6,
                explore: 0.65,
            }),
            i18n: ProviderI18n {
                best_for_key: "PROVIDERS.CURSOR.BEST_FOR",
                limitations_key: "PROVIDERS.CURSOR.LIMITATIONS",
                microcopy_key: "PROVIDERS.CURSOR.MICROCOPY",
            },
            ui: ProviderUi {
                icon: "ti-cursor-text",
                accent: "purple",
                badge_key: None,
            },
        },
        ProviderCapability {
            id: "grok",
            display_name: "Grok",
            tier: "cloud",
            requires_api_key: true,
            offline_capable: false,
            cli: ProviderCli {
                command: "grok",
                install_hint_key: "PROVIDERS.GROK.INSTALL_HINT",
                detectable: true,
            },
            capabilities: ProviderCapabilities {
                reasoning: true,
                execution: true,
                long_context: true,
                tool_use: true,
            },
            suggestion_weights: Some(SuggestionWeights {
                refactor: 0.75,
                debug: 0.8,
                planning: 0.8,
                explore: 0.85,
            }),
            i18n: ProviderI18n {
                best_for_key: "PROVIDERS.GROK.BEST_FOR",
                limitations_key: "PROVIDERS.GROK.LIMITATIONS",
                microcopy_key: "PROVIDERS.GROK.MICROCOPY",
            },
            ui: ProviderUi {
                icon: "ti-brand-x",
                accent: "slate",
                badge_key: Some("PROVIDERS.BADGE.NEW"),
            },
        },
        ProviderCapability {
            id: "hermes",
            display_name: "Hermes",
            tier: "cloud",
            requires_api_key: true,
            offline_capable: false,
            cli: ProviderCli {
                command: "hermes",
                install_hint_key: "PROVIDERS.HERMES.INSTALL_HINT",
                detectable: true,
            },
            capabilities: ProviderCapabilities {
                reasoning: true,
                execution: true,
                long_context: true,
                tool_use: true,
            },
            suggestion_weights: Some(SuggestionWeights {
                refactor: 0.75,
                debug: 0.8,
                planning: 0.8,
                explore: 0.85,
            }),
            i18n: ProviderI18n {
                best_for_key: "PROVIDERS.HERMES.BEST_FOR",
                limitations_key: "PROVIDERS.HERMES.LIMITATIONS",
                microcopy_key: "PROVIDERS.HERMES.MICROCOPY",
            },
            ui: ProviderUi {
                icon: "ti-feather",
                accent: "violet",
                badge_key: Some("PROVIDERS.BADGE.NEW"),
            },
        },
        ProviderCapability {
            id: "muse",
            display_name: "Muse Code",
            tier: "cloud",
            requires_api_key: true,
            offline_capable: false,
            cli: ProviderCli {
                command: "muse",
                install_hint_key: "PROVIDERS.MUSE.INSTALL_HINT",
                detectable: true,
            },
            capabilities: ProviderCapabilities {
                reasoning: true,
                execution: true,
                long_context: true,
                tool_use: true,
            },
            suggestion_weights: Some(SuggestionWeights {
                refactor: 0.75,
                debug: 0.8,
                planning: 0.8,
                explore: 0.85,
            }),
            i18n: ProviderI18n {
                best_for_key: "PROVIDERS.MUSE.BEST_FOR",
                limitations_key: "PROVIDERS.MUSE.LIMITATIONS",
                microcopy_key: "PROVIDERS.MUSE.MICROCOPY",
            },
            ui: ProviderUi {
                icon: "ti-brand-meta",
                accent: "violet",
                badge_key: Some("PROVIDERS.BADGE.NEW"),
            },
        },
        ProviderCapability {
            id: "opencode",
            display_name: "Opencode",
            tier: "local",
            requires_api_key: false,
            offline_capable: true,
            cli: ProviderCli {
                command: "opencode",
                install_hint_key: "PROVIDERS.OPENCODE.INSTALL_HINT",
                detectable: true,
            },
            capabilities: ProviderCapabilities {
                reasoning: false,
                execution: true,
                long_context: false,
                tool_use: true,
            },
            suggestion_weights: Some(SuggestionWeights {
                refactor: 0.9,
                debug: 0.55,
                planning: 0.2,
                explore: 0.35,
            }),
            i18n: ProviderI18n {
                best_for_key: "PROVIDERS.OPENCODE.BEST_FOR",
                limitations_key: "PROVIDERS.OPENCODE.LIMITATIONS",
                microcopy_key: "PROVIDERS.OPENCODE.MICROCOPY",
            },
            ui: ProviderUi {
                icon: "ti-bolt",
                accent: "emerald",
                badge_key: Some("PROVIDERS.BADGE.FREE"),
            },
        },
        ProviderCapability {
            id: "kora",
            display_name: "Kora",
            tier: "local",
            requires_api_key: false,
            offline_capable: false,
            cli: ProviderCli {
                command: "kora",
                install_hint_key: "PROVIDERS.KORA.INSTALL_HINT",
                detectable: true,
            },
            capabilities: ProviderCapabilities {
                reasoning: true,
                execution: true,
                long_context: false,
                tool_use: true,
            },
            suggestion_weights: Some(SuggestionWeights {
                refactor: 0.85,
                debug: 0.7,
                planning: 0.7,
                explore: 0.6,
            }),
            i18n: ProviderI18n {
                best_for_key: "PROVIDERS.KORA.BEST_FOR",
                limitations_key: "PROVIDERS.KORA.LIMITATIONS",
                microcopy_key: "PROVIDERS.KORA.MICROCOPY",
            },
            ui: ProviderUi {
                icon: "ti-sparkles",
                accent: "violet",
                badge_key: Some("PROVIDERS.BADGE.NEW"),
            },
        },
        ProviderCapability {
            id: "promptops-cli",
            display_name: "PromptOps CLI",
            tier: "local",
            requires_api_key: false,
            offline_capable: true,
            cli: ProviderCli {
                command: "promptops-cli",
                install_hint_key: "PROVIDERS.PROMPTOPS_CLI.INSTALL_HINT",
                detectable: false,
            },
            capabilities: ProviderCapabilities {
                reasoning: true,
                execution: true,
                long_context: false,
                tool_use: true,
            },
            suggestion_weights: Some(SuggestionWeights {
                refactor: 0.6,
                debug: 0.5,
                planning: 0.4,
                explore: 0.5,
            }),
            i18n: ProviderI18n {
                best_for_key: "PROVIDERS.PROMPTOPS_CLI.BEST_FOR",
                limitations_key: "PROVIDERS.PROMPTOPS_CLI.LIMITATIONS",
                microcopy_key: "PROVIDERS.PROMPTOPS_CLI.MICROCOPY",
            },
            ui: ProviderUi {
                icon: "ti-terminal",
                accent: "emerald",
                badge_key: Some("PROVIDERS.BADGE.FREE"),
            },
        },
        ProviderCapability {
            id: "generic-shell",
            display_name: "Plain Shell",
            tier: "local",
            requires_api_key: false,
            offline_capable: true,
            cli: ProviderCli {
                command: "sh",
                install_hint_key: "PROVIDERS.GENERIC_SHELL.INSTALL_HINT",
                detectable: false,
            },
            capabilities: ProviderCapabilities {
                reasoning: false,
                execution: true,
                long_context: false,
                tool_use: false,
            },
            // generic-shell has no suggestionWeights in the TS — it stays absent.
            suggestion_weights: None,
            i18n: ProviderI18n {
                best_for_key: "PROVIDERS.GENERIC_SHELL.BEST_FOR",
                limitations_key: "PROVIDERS.GENERIC_SHELL.LIMITATIONS",
                microcopy_key: "PROVIDERS.GENERIC_SHELL.MICROCOPY",
            },
            ui: ProviderUi {
                icon: "ti-terminal-2",
                accent: "slate",
                badge_key: None,
            },
        },
    ]
}

// ─────────────────────────────────────────────────────────────────────────────
// State: detection cache — port of the registry's `CachedDetection`.
// `at` (epoch ms) + list of detected provider ids. 60s TTL, bypassable with
// `force`. Must be registered in lib.rs as `tauri::State<ProviderRegistryState>`.
// ─────────────────────────────────────────────────────────────────────────────

struct CachedDetection {
    at: u128,
    detected: Vec<String>,
}

#[derive(Default)]
pub struct ProviderRegistryState {
    detection_cache: Mutex<Option<CachedDetection>>,
}

impl ProviderRegistryState {
    pub fn new() -> Self {
        Self::default()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wrapped return DTOs — `{ ok, data }` shape expected by the renderer.
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ProvidersListResult {
    pub ok: bool,
    pub data: Vec<ProviderCapability>,
}

#[derive(Serialize)]
pub struct ProvidersDetectResult {
    pub ok: bool,
    pub data: Vec<String>,
}

#[derive(Serialize)]
pub struct AiGenerateTextResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// providers:list — returns the static capability manifest.
// TS: `{ ok: true, data: registry.list() }`.
// ─────────────────────────────────────────────────────────────────────────────

/// providers:list — UI manifest of the provider capabilities.
#[tauri::command]
pub async fn providers_list() -> ProvidersListResult {
    ProvidersListResult {
        ok: true,
        data: manifests(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// providers:detect — ids of the providers whose CLI is available on PATH.
// TS: `registry.detectAll(force)`:
//   - 60s cache (bypass with force=true)
//   - providers with detectable=false are ALWAYS considered available
//   - the others: `which <cmd>` (true if found)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// providers:models — models the ACCOUNT can actually use, asked to the CLI.
//
// The picker's static list (model-labels.ts) goes stale with every release and doesn't
// know what the user's plan enables (Gemini 4 Argon = Ultra/Enterprise only):
// where the CLI exposes it, the CLI is the source. Today: `agy models` →
// `<slug>\t<Name>`, one per line. The slugs carry the thinking level as a
// suffix (`gemini-3.8-flash-high`); agy ≥ 1.3.4 accepts the base slug +
// `--effort`, so the variants merge into one model with its efforts —
// the same model+effort picker as Claude Code and Codex.
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    pub label: String,
    /// Efforts accepted with `--effort` (empty = the model has none).
    pub efforts: Vec<String>,
}

const MODELS_TTL_MS: u128 = 10 * 60 * 1000;
const MODELS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);
const EFFORT_SUFFIXES: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

fn models_cache() -> &'static Mutex<std::collections::HashMap<String, (u128, Vec<ProviderModel>)>> {
    static CACHE: std::sync::OnceLock<
        Mutex<std::collections::HashMap<String, (u128, Vec<ProviderModel>)>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// `<slug>\t<label>` → models, effort variants merged into the base slug.
pub(crate) fn parse_agy_models(out: &str) -> Vec<ProviderModel> {
    let rows: Vec<(String, String)> = out
        .lines()
        .filter_map(|l| {
            let (id, label) = l.trim().split_once('\t')?;
            let id = id.trim();
            let ok = !id.is_empty()
                && id.len() <= 80
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'));
            ok.then(|| (id.to_string(), label.trim().to_string()))
        })
        .collect();
    let split = |id: &str| -> Option<(String, String)> {
        let (base, suffix) = id.rsplit_once('-')?;
        EFFORT_SUFFIXES
            .contains(&suffix)
            .then(|| (base.to_string(), suffix.to_string()))
    };
    let mut models: Vec<ProviderModel> = Vec::new();
    for (id, label) in &rows {
        // Merge only if the same base has AT LEAST two levels: a single
        // `gpt-oss-120b-medium` stays as is (the base might not exist).
        let grouped = split(id).filter(|(base, _)| {
            rows.iter()
                .filter(|(other, _)| split(other).is_some_and(|(b, _)| &b == base))
                .count()
                >= 2
        });
        match grouped {
            Some((base, effort)) => {
                if let Some(m) = models.iter_mut().find(|m| m.id == base) {
                    m.efforts.push(effort);
                } else {
                    // "Gemini 3.8 Flash (High)" → "Gemini 3.8 Flash"
                    let clean = label
                        .rsplit_once(" (")
                        .map(|(l, _)| l.to_string())
                        .unwrap_or_else(|| label.clone());
                    models.push(ProviderModel {
                        id: base,
                        label: clean,
                        efforts: vec![effort],
                    });
                }
            }
            None => models.push(ProviderModel {
                id: id.clone(),
                label: label.clone(),
                efforts: vec![],
            }),
        }
    }
    for m in &mut models {
        m.efforts
            .sort_by_key(|e| EFFORT_SUFFIXES.iter().position(|s| s == e));
    }
    models
}

fn run_with_timeout(program: &str, args: &[&str]) -> Option<String> {
    let home = home_dir();
    let mut extra = default_extra_paths();
    extra.push(format!("{home}/.local/bin"));
    let mut child = crate::commands::util_cmd::cmd(program)
        .args(args)
        .env("PATH", build_path(&extra))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                use std::io::Read;
                child.stdout.take()?.read_to_string(&mut out).ok()?;
                return status.success().then_some(out);
            }
            Ok(None) if started.elapsed() < MODELS_TIMEOUT => {
                std::thread::sleep(std::time::Duration::from_millis(100))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// providers:models — dynamic list (empty = use the picker's static one).
#[tauri::command]
pub async fn providers_models(provider: String, force: Option<bool>) -> Vec<ProviderModel> {
    if provider != "antigravity" {
        return Vec::new();
    }
    let now = now_ms();
    if force != Some(true) {
        if let Some((at, list)) = models_cache().lock().get(&provider) {
            if now.saturating_sub(*at) < MODELS_TTL_MS {
                return list.clone();
            }
        }
    }
    let list = tauri::async_runtime::spawn_blocking(|| {
        run_with_timeout("agy", &["models"])
            .map(|out| parse_agy_models(&out))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default();
    // Only successes are cached: a network error must not freeze the picker.
    if !list.is_empty() {
        models_cache().lock().insert(provider, (now, list.clone()));
    }
    list
}

/// Readable provider name (notifications, messages).
pub(crate) fn provider_display_name(id: &str) -> String {
    manifests()
        .into_iter()
        .find(|m| m.id == id)
        .map(|m| m.display_name.to_string())
        .unwrap_or_else(|| id.to_string())
}

/// providers:detect — currently available providers (CLI on PATH).
#[tauri::command]
pub async fn providers_detect(
    registry: tauri::State<'_, ProviderRegistryState>,
    force: Option<bool>,
) -> Result<ProvidersDetectResult, String> {
    let force = force.unwrap_or(false);
    if !force {
        if let Some(hit) = cached_detection(&registry) {
            return Ok(ProvidersDetectResult {
                ok: true,
                data: hit,
            });
        }
    }
    // The probes can open a login shell per provider (enriched PATH
    // fallback): never on the async worker, and in parallel.
    let detected = tauri::async_runtime::spawn_blocking(probe_all)
        .await
        .map_err(|e| e.to_string())?;
    *registry.detection_cache.lock() = Some(CachedDetection {
        at: now_ms(),
        detected: detected.clone(),
    });
    Ok(ProvidersDetectResult {
        ok: true,
        data: detected,
    })
}

fn cached_detection(registry: &ProviderRegistryState) -> Option<Vec<String>> {
    let cache = registry.detection_cache.lock();
    cache
        .as_ref()
        .filter(|c| now_ms().saturating_sub(c.at) < DETECTION_CACHE_TTL_MS)
        .map(|c| c.detected.clone())
}

/// Port of `ProviderCapabilityRegistry.detectAll`: non-detectable
/// providers are always included; the others if the CLI responds.
fn probe_all() -> Vec<String> {
    // Overall budget: a shell rc that hangs must not block
    // the wizard (before, `which` answered in ~500 ms). Whoever doesn't answer in
    // time stays out of this round; its probe finishes in the background
    // and populates the provider_check cache for the next round.
    const BUDGET: std::time::Duration = std::time::Duration::from_millis(4_000);
    let (tx, rx) = std::sync::mpsc::channel::<(usize, bool)>();
    let all = manifests();
    for (idx, m) in all.iter().cloned().enumerate() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let found = !m.cli.detectable
                || which(m.cli.command)
                // App launched from Finder/Dock: minimal process PATH. Same
                // probe as the switch (enriched PATH + login shell), so
                // wizard and switch don't contradict each other (UX audit 10/2026).
                || (crate::commands::session::provider_command(m.id).is_some()
                    && crate::commands::session::check_provider(m.id).installed);
            let _ = tx.send((idx, found));
        });
    }
    drop(tx);
    let deadline = std::time::Instant::now() + BUDGET;
    let mut found = vec![false; all.len()];
    let mut received = 0;
    while received < all.len() {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(left) {
            Ok((idx, ok)) => {
                found[idx] = ok;
                received += 1;
            }
            Err(_) => break,
        }
    }
    all.iter()
        .zip(found)
        .filter(|(m, ok)| *ok || !m.cli.detectable)
        .map(|(m, _)| m.id.to_string())
        .collect()
}

/// The registry's `which(command)`: `which`/`where <command>`, true if exit 0 and
/// stdout not empty. PATH = process environment (the registry does NOT enrich the
/// PATH — that's `provider-check.ts`, ported elsewhere). 500ms timeout.
fn which(command: &str) -> bool {
    let bin = if cfg!(windows) { "where" } else { "which" };

    // std::process::Command has no native timeout. To replicate the TS's 500ms
    // timeout (execFile { timeout }) we launch the child and kill it if it
    // exceeds the threshold, then read its output.
    let child = crate::commands::util_cmd::cmd(bin)
        .arg(command)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(_) => return false,
    };

    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(DETECTION_TIMEOUT_MS);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // exit 0 + non-empty stdout (the TS checks `!err && !!stdout.trim()`).
                let out = child.wait_with_output();
                return match out {
                    Ok(o) => {
                        status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty()
                    }
                    Err(_) => false,
                };
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(_) => return false,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ai:generate-text — generic text generation via provider CLI.
// Runs the prompt in `cwd` (or the process cwd) and returns the trimmed stdout as
// `{ ok: true, text }`, or `{ ok: false, error }` on failure.
// Pure CLI pipeline: no HTTP call on this channel.
// ─────────────────────────────────────────────────────────────────────────────

/// Timeout the caller asked for (the Git Writer's estimate), kept between
/// 10 s and 15 min; 300 s when absent.
fn generate_timeout_secs(timeout_ms: Option<u64>) -> u64 {
    timeout_ms
        .map(|ms| ms.div_ceil(1000).clamp(10, 900))
        .unwrap_or(crate::commands::git::PROVIDER_TIMEOUT_SECS)
}

/// ai:generate-text — runs a prompt on the provider CLI, returns stdout.
#[tauri::command]
pub async fn ai_generate_text(
    app: tauri::AppHandle,
    prompt: String,
    provider: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    model: Option<String>,
) -> AiGenerateTextResult {
    // `cwd || process.cwd()`
    let work_dir = match cwd {
        Some(c) if !c.is_empty() => c,
        _ => std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    };

    // The CLI can run for minutes: never on an async worker thread.
    let run = {
        let (provider, prompt, work_dir) = (provider.clone(), prompt.clone(), work_dir.clone());
        let timeout_secs = generate_timeout_secs(timeout_ms);
        tauri::async_runtime::spawn_blocking(move || {
            spawn_provider_timeout(
                &provider,
                &prompt,
                &work_dir,
                timeout_secs,
                model.as_deref(),
            )
        })
        .await
        .unwrap_or_else(|e| Err(format!("Provider task failed: {e}")))
    };
    match run {
        // `text: result.trim()`
        Ok(result) => {
            // creditAiPrompt('ai-generate-text') — git-handlers.ts.
            crate::commands::session::credit_ai_utility_with_text(
                &app,
                "ai-generate-text",
                None,
                Some(&work_dir),
                Some(&prompt),
            );
            AiGenerateTextResult {
                ok: true,
                text: Some(result.trim().to_string()),
                error: None,
            }
        }
        Err(e) => AiGenerateTextResult {
            ok: false,
            text: None,
            error: Some(e),
        },
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// spawnProvider — one headless pipeline for the whole app (git.rs owns it):
// prompt in a private temp file referenced through an environment variable,
// the CLI in its own process group, the whole group killed on timeout.
// ─────────────────────────────────────────────────────────────────────────────

/// `spawnProvider(provider, prompt, cwd)` — returns the provider's answer.
/// Stops the CLI after 300 s (a login prompt or a dead network used to hang
/// smart context, the DB explorer AI and the session tailer forever).
pub(crate) fn spawn_provider(provider: &str, prompt: &str, cwd: &str) -> Result<String, String> {
    spawn_provider_timeout(
        provider,
        prompt,
        cwd,
        crate::commands::git::PROVIDER_TIMEOUT_SECS,
        None,
    )
}

/// Same, with a caller-chosen timeout and an optional model (dropped unless
/// it is a plain model id).
pub(crate) fn spawn_provider_timeout(
    provider: &str,
    prompt: &str,
    cwd: &str,
    timeout_secs: u64,
    model: Option<&str>,
) -> Result<String, String> {
    crate::commands::git::spawn_provider_with(
        provider,
        prompt,
        cwd,
        &crate::commands::git::ProviderShell::user(),
        timeout_secs.max(1),
        model,
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Generation for PLUGINS (`pages` section, `ai:generate` permission).
// The prompt comes from third-party code and may contain hostile text (a diff, an
// issue): so the CLI starts without tools, without MCP servers and without skills, in
// an empty folder created for the occasion. It can only return text.
// Claude only: it is the only CLI whose no-tools mode we have verified.
// ─────────────────────────────────────────────────────────────────────────────

/// Fixed arguments of the isolated CLI. Tested: they must never lose `--tools ''`.
pub(crate) fn claude_isolated_command(model: Option<&str>) -> String {
    let mut cmd = String::from("claude -p --output-format text --tools '' --strict-mcp-config --disable-slash-commands --no-session-persistence");
    if let Some(m) = model {
        // `m` is already validated by the caller: letters, digits, dot, dash, underscore.
        cmd.push_str(&format!(" --model '{m}'"));
    }
    cmd
}

pub(crate) async fn spawn_claude_isolated(
    prompt: &str,
    model: Option<&str>,
    timeout: std::time::Duration,
) -> Result<String, String> {
    let out = spawn_cli_isolated(&claude_isolated_command(model), prompt, timeout).await?;
    if out.success && !out.stdout.is_empty() {
        return Ok(out.stdout);
    }
    Err(if !out.stderr.is_empty() {
        out.stderr.chars().take(400).collect()
    } else if out.stdout.is_empty() {
        "Provider returned empty response".to_string()
    } else {
        format!("Provider exited with code {}", out.code)
    })
}

pub(crate) struct IsolatedOutput {
    pub success: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub wall_ms: u64,
}

/// Launches a CLI with a FIXED command chosen by the app, in an empty folder created for the occasion,
/// with the prompt on stdin and the `PROMPTOPS_*` variables removed. The measured time goes from start to finish.
pub(crate) async fn spawn_cli_isolated(
    command_line: &str,
    prompt: &str,
    timeout: std::time::Duration,
) -> Result<IsolatedOutput, String> {
    if is_windows() {
        // PowerShell drops empty arguments: `--tools ''` would disappear and with it the isolation.
        return Err("not available on Windows yet".into());
    }
    use tokio::io::AsyncWriteExt;

    let work_dir = std::env::temp_dir().join(format!(
        "promptops-plugin-ai-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&work_dir)
        .map_err(|e| format!("cannot create the work folder: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&work_dir, std::fs::Permissions::from_mode(0o700));
    }

    let home = home_dir();
    let mut extra = default_extra_paths();
    extra.push(format!("{home}/.nvm/versions/node/current/bin"));
    extra.push(format!("{home}/.npm-global/bin"));

    let mut command = crate::commands::util_cmd::tokio_cmd(get_shell());
    command
        .args(get_run_args(command_line))
        .current_dir(&work_dir)
        .env("PATH", build_path(&extra))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // A child must never write to someone else's PromptOps session.
    for (key, _) in std::env::vars() {
        if key.starts_with("PROMPTOPS_") {
            command.env_remove(key);
        }
    }

    let started = std::time::Instant::now();
    let run = async {
        let mut child = command
            .spawn()
            .map_err(|e| format!("Failed to spawn provider: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .await
                .map_err(|e| format!("prompt not sent: {e}"))?;
            drop(stdin);
        }
        child
            .wait_with_output()
            .await
            .map_err(|e| format!("provider interrupted: {e}"))
    };
    let outcome = tokio::time::timeout(timeout, run).await;
    let wall_ms = started.elapsed().as_millis() as u64;
    let _ = std::fs::remove_dir_all(&work_dir);

    let output = outcome.map_err(|_| "the provider did not answer in time".to_string())??;
    Ok(IsolatedOutput {
        success: output.status.success(),
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        wall_ms,
    })
}

// ── shell utils (aligned with git.rs) ───────────────────────────────────────

fn is_windows() -> bool {
    cfg!(windows)
}

/// `getShell()` — powershell.exe on Windows, $SHELL || /bin/zsh elsewhere.
fn get_shell() -> String {
    if is_windows() {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

/// `getRunArgs(cmd)` — args to run a single command via the shell.
fn get_run_args(cmd: &str) -> Vec<String> {
    if is_windows() {
        crate::commands::util_cmd::powershell_args(cmd)
    } else {
        vec!["-l".to_string(), "-c".to_string(), cmd.to_string()]
    }
}

/// `homeDir()`.
fn home_dir() -> String {
    #[allow(deprecated)]
    std::env::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// `defaultExtraPaths()` — common extra directories for CLI tools.
fn default_extra_paths() -> Vec<String> {
    let home = home_dir();
    if is_windows() {
        vec![
            format!("{home}\\AppData\\Local\\Programs"),
            format!("{home}\\AppData\\Roaming\\npm"),
            format!("{home}\\.local\\bin"),
        ]
    } else {
        vec![
            format!("{home}/.local/bin"),
            "/usr/local/bin".to_string(),
            "/opt/homebrew/bin".to_string(),
        ]
    }
}

/// `buildPath(extraDirs)` — join with the platform separator + current PATH.
fn build_path(extra_dirs: &[String]) -> String {
    let sep = if is_windows() { ";" } else { ":" };
    let fallback = if is_windows() { "" } else { "/usr/bin:/bin" };
    let current = std::env::var("PATH").unwrap_or_else(|_| fallback.to_string());
    format!("{}{}{}", extra_dirs.join(sep), sep, current)
}

/// Epoch in milliseconds (equivalent of `Date.now()`).
fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod isolated_cli_tests {
    use super::claude_isolated_command;

    /// The isolation lives entirely in these arguments: if one disappears, the test must fail.
    #[test]
    fn isolated_claude_always_runs_without_tools() {
        for cmd in [
            claude_isolated_command(None),
            claude_isolated_command(Some("claude-fable-5-1")),
        ] {
            for must in [
                "claude -p ",
                "--tools '' ",
                "--strict-mcp-config",
                "--disable-slash-commands",
                "--no-session-persistence",
            ] {
                assert!(cmd.contains(must), "manca `{must}` in `{cmd}`");
            }
            assert!(!cmd.contains("dangerously") && !cmd.contains("bypassPermissions"));
        }
        assert!(claude_isolated_command(Some("claude-fable-5-1"))
            .ends_with("--model 'claude-fable-5-1'"));
    }
}

#[cfg(test)]
mod generate_text_tests {
    #[test]
    fn writer_timeout_is_honored_within_bounds() {
        assert_eq!(super::generate_timeout_secs(None), 300);
        assert_eq!(super::generate_timeout_secs(Some(600_000)), 600);
        assert_eq!(super::generate_timeout_secs(Some(1)), 10);
        assert_eq!(super::generate_timeout_secs(Some(u64::MAX)), 900);
    }
}

#[cfg(test)]
mod models_tests {
    use super::*;

    #[test]
    fn agy_models_fold_effort_variants() {
        let out = "Fetching available models...\n\
gemini-4-argon-high\tGemini 4 Argon (High)\n\
gemini-4-argon-medium\tGemini 4 Argon (Medium)\n\
gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n\
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n\
claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n\
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n\
bad id; rm -rf\tEvil\n";
        let models = parse_agy_models(out);
        assert_eq!(models.len(), 4);
        assert_eq!(
            models[0],
            ProviderModel {
                id: "gemini-4-argon".into(),
                label: "Gemini 4 Argon".into(),
                efforts: vec!["medium".into(), "high".into()]
            }
        );
        assert_eq!(
            models[1].efforts,
            vec!["low".to_string(), "high".to_string()]
        );
        assert_eq!(models[2].id, "claude-opus-4-6-thinking");
        assert_eq!(
            models[3],
            ProviderModel {
                id: "gpt-oss-120b-medium".into(),
                label: "GPT-OSS 120B (Medium)".into(),
                efforts: vec![]
            }
        );
    }
}
