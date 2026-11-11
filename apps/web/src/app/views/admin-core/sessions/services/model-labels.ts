/**
 * Model ids → short human labels.
 *
 * Two consumers, one source: the spawn picker (action-center) lists the
 * models a provider can be launched with, and the terminal toolbar badge
 * has to label whatever the provider reports at runtime — which may be a
 * model that never appears in the picker (`/model` inside the TUI, an
 * account default, a dated snapshot id). Hence the heuristic fallback:
 * an unknown id still renders as something readable instead of blank.
 */

import { signal } from '@angular/core';

/** Switchable launch models per provider — mirrors SPEED_TEST_MODELS (speed-test-runner.ts). */
export const SPAWN_MODELS: Record<string, ReadonlyArray<{ id: string; label: string }>> = {
  'claude-code-cli': [
    { id: 'claude-fable-5-2', label: 'Fable 5.2' },
    { id: 'claude-fable-5-1', label: 'Fable 5.1' },
    { id: 'claude-fable-5', label: 'Fable 5' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ],
  'codex': [
    { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
    { id: 'gpt-6-sol', label: 'GPT-6-Sol' },
    { id: 'gpt-6-luna', label: 'GPT-6-Luna' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
  ],
  // gemini -m: aliases follow the account's access (auto/pro → 3.x Pro
  // preview or 2.5 Pro as fallback; flash → 3.x Flash); explicit ids
  // force the model (gemini-cli ≥ 0.63).
  'gemini-cli': [
    { id: 'auto', label: 'Auto (Gemini)' },
    { id: 'pro', label: 'Gemini Pro' },
    { id: 'flash', label: 'Gemini Flash' },
    { id: 'flash-lite', label: 'Gemini Flash-Lite' },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
    { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
  // agy: fallback when `agy models` does not respond (see AGY_FALLBACK_MODELS).
  'antigravity': [],
  'muse': [
    { id: 'muse-spark-1.3', label: 'Muse Spark 1.3' },
    { id: 'muse-spark-1.2', label: 'Muse Spark 1.2' },
    { id: 'muse-wonder-1.0', label: 'Muse Wonder 1.0' },
  ],
};

/** A launch model plus the `--effort` levels it accepts (empty = none). */
export interface ProviderModel { id: string; label: string; efforts: string[] }

/**
 * Antigravity fallback, used only until/unless `agy models` answers. agy slugs
 * carry the thinking level as a suffix (`gemini-4-argon-high`); agy ≥ 1.3.4
 * takes the BASE slug + `--effort`, so variants fold into one model with its
 * efforts — the same model+effort picker as Claude Code and Codex.
 * Availability is per plan (Gemini 4 Argon = Ultra/Enterprise): the live list
 * from the account always wins.
 */
const AGY_FALLBACK_MODELS: ProviderModel[] = [
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon', efforts: ['medium', 'high'] },
  { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro', efforts: [] },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)', efforts: [] },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', efforts: [] },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', efforts: [] },
];
SPAWN_MODELS['antigravity'] = AGY_FALLBACK_MODELS.map(({ id, label }) => ({ id, label }));

/** Providers whose CLI can list the models the ACCOUNT may use (`providers_models`). */
const DYNAMIC_MODEL_PROVIDERS: ReadonlySet<string> = new Set(['antigravity']);
const FALLBACK_MODELS: Record<string, ProviderModel[]> = { antigravity: AGY_FALLBACK_MODELS };
const dynamicModels = signal<Record<string, ProviderModel[]>>({});
const modelsInFlight = new Set<string>();
/** Providers already asked once: an empty answer is not asked again on every change detection. */
const modelsAsked = new Set<string>();

type ModelsBridge = { listProviderModels?: (provider: string, force?: boolean) => Promise<unknown> };

/** Ask the CLI for the account's models (cached host-side; [] keeps the fallback). */
export function loadProviderModels(provider: string, force = false): void {
  if (!DYNAMIC_MODEL_PROVIDERS.has(provider) || modelsInFlight.has(provider)) return;
  if (!force && (dynamicModels()[provider] || modelsAsked.has(provider))) return;
  const api = (window as unknown as { promptops?: ModelsBridge }).promptops?.listProviderModels;
  if (!api) return;
  modelsInFlight.add(provider);
  Promise.resolve(api(provider, force))
    .then((res) => {
      const raw = Array.isArray(res) ? res : (res as { data?: unknown })?.data;
      const list = (Array.isArray(raw) ? raw : []).filter(
        (m): m is ProviderModel => !!m && typeof m.id === 'string' && typeof m.label === 'string',
      ).map((m) => ({ id: m.id, label: m.label, efforts: Array.isArray(m.efforts) ? m.efforts : [] }));
      if (list.length) dynamicModels.update((all) => ({ ...all, [provider]: list }));
    })
    .catch(() => { /* fallback list stays */ })
    .finally(() => { modelsInFlight.delete(provider); modelsAsked.add(provider); });
}

function providerModels(provider: string): ProviderModel[] | null {
  loadProviderModels(provider);
  return dynamicModels()[provider] ?? FALLBACK_MODELS[provider] ?? null;
}

/** Launch picker models: the account's live list when the CLI exposes one, else the static list. */
export function spawnModels(provider: string): ReadonlyArray<{ id: string; label: string }> {
  return providerModels(provider) ?? SPAWN_MODELS[provider] ?? [];
}

const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;

/** `--effort` levels for a model id — base slug or a level-suffixed variant. null = provider not model-driven. */
export function modelEfforts(provider: string, model?: string | null): string[] | null {
  const list = providerModels(provider);
  if (!list) return null;
  if (!model) return [];
  const exact = list.find((m) => m.id === model);
  if (exact) return exact.efforts;
  const base = model.replace(EFFORT_SUFFIX, '');
  return list.find((m) => m.id === base)?.efforts ?? [];
}

/**
 * Models a LIVE terminal can be switched to with `/model <id>`. agy's TUI
 * wants the full level-suffixed slug, so folded models expand back.
 */
export function liveModels(provider: string): ReadonlyArray<{ id: string; label: string }> {
  const list = providerModels(provider);
  if (!list) return SPAWN_MODELS[provider] ?? [];
  return list.flatMap((m) => m.efforts.length
    ? m.efforts.map((e) => ({ id: `${m.id}-${e}`, label: `${m.label} (${e.charAt(0).toUpperCase()}${e.slice(1)})` }))
    : [{ id: m.id, label: m.label }]);
}

/** Launch flag each provider CLI takes the model with — mirrors model_flag (session.rs). */
export const MODEL_FLAGS: Readonly<Record<string, string>> = {
  'claude-code-cli': '--model',
  'codex': '-m',
  'gemini-cli': '-m',
  'antigravity': '--model',
  'muse': '--model',
  'promptops-cli': '--model',
  // Mirrors session.rs model_flag.
  'grok': '-m',
  'copilot': '--model',
  'opencode': '-m',
  'hermes': '-m',
};

/** Providers whose model id we can actually resolve at runtime (own session log). */
export const MODEL_TRACKED_PROVIDERS: ReadonlySet<string> = new Set(['claude-code-cli', 'codex', 'antigravity']);

const MAX_LABEL_LEN = 22;

function titleCase(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

/**
 * Readable label for an id we don't know about — dated snapshots and
 * aliases included. Never throws, always returns something printable.
 *
 *   claude-opus-4-5-20250929 → Opus 4.5
 *   claude-3-5-haiku         → Haiku 3.5
 *   gpt-5.6-sol              → GPT-5.6-Sol
 *   o3-mini                  → O3-Mini
 */
export function prettifyModelId(raw: string): string {
  const id = raw.trim().replace(/^(anthropic|openai|models)\//, '');
  // Dated snapshot suffix (…-20250929) carries no meaning for a badge.
  const undated = id.replace(/-\d{8}$/, '');

  const claude = undated.match(/^claude-(.+)$/i);
  if (claude) {
    const parts = claude[1].split('-').filter(Boolean);
    const familyIdx = parts.findIndex((p) => /^[a-z]+$/i.test(p));
    if (familyIdx >= 0) {
      const family = titleCase(parts[familyIdx]);
      const version = parts.filter((_, i) => i !== familyIdx).join('.');
      return (version ? `${family} ${version}` : family).slice(0, MAX_LABEL_LEN);
    }
  }

  if (/^gpt[-.]/i.test(undated)) {
    return ('GPT' + undated.slice(3).split('-').map((p, i) => (i === 0 ? p : titleCase(p))).join('-'))
      .slice(0, MAX_LABEL_LEN);
  }

  return undated.split('-').map(titleCase).join('-').slice(0, MAX_LABEL_LEN);
}

/**
 * Short label for a model id, preferring the provider's own picker naming.
 * Returns null for an empty id so callers can hide the badge entirely.
 */
export function formatModelLabel(provider: string | undefined, id: string | null | undefined): string | null {
  if (!id) return null;
  const live = liveModels(provider ?? '').find((m) => m.id === id);
  if (live) return live.label;
  const known = (SPAWN_MODELS[provider ?? ''] ?? []).find((m) => m.id === id || id.startsWith(m.id + '-'));
  if (known) return known.label;
  // The id may come from a provider the picker doesn't cover — scan them all
  // before falling back to the heuristic.
  for (const list of Object.values(SPAWN_MODELS)) {
    const hit = list.find((m) => m.id === id || id.startsWith(m.id + '-'));
    if (hit) return hit.label;
  }
  return prettifyModelId(id);
}
