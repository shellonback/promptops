import { Injectable, computed, signal } from '@angular/core';

/**
 * Model Speed Test — bridges the desktop speed-test IPC (window.promptops)
 * and keeps run state in signals so the page survives route changes.
 *
 * Desktop-only feature: in plain browser mode the catalog falls back to a
 * static list and the run button stays disabled.
 *
 * Models run SEQUENTIALLY in the main process (a queue, never in parallel) so
 * timings are comparable; the `queue` event drives per-model pending/running/
 * done/skipped/cli-missing states, and `modelElapsedMs` is the cumulative
 * per-model clock (never resets across samples/rounds).
 */

export type SpeedTestModelTier = 'fast' | 'balanced' | 'reasoning';

/** Hand-curated expected CLI throughput band (desktop `model_baseline`). */
export interface SpeedTestModelBaseline {
  tier: SpeedTestModelTier;
  expectedTps: { min: number; max: number };
}

/** This machine's recorded-run summary for a model. */
export interface SpeedTestHistorySummary {
  runs: number;
  medianTps: number | null;
  lastRunAt: string | null;
}

export interface SpeedTestModelInfo {
  id: string;
  label: string;
  provider: string;
  providerLabel: string;
  /** False when the provider CLI is not installed (desktop pre-flight). */
  available?: boolean;
  baseline?: SpeedTestModelBaseline | null;
  history?: SpeedTestHistorySummary;
}

/** Test typology = a session sub-agent mode. */
export interface SpeedTestModeInfo {
  id: string;
  label: string;
  icon: string;
  /** The mode's dedicated graded exercise (e.g. "Rapid recon"). */
  exercise?: string;
  /** One-line description of what the exercise actually asks. */
  exerciseBrief?: string;
}

/** Per-question audit row: expected vs the model's answer, plus correctness. */
export interface AccuracyItem {
  id: string;
  question: string;
  expected: string;
  answer: string;
  correct: boolean;
}

export interface SpeedTestRoundMetrics {
  round: string;
  ok: boolean;
  error?: string;
  ttftMs: number;
  totalMs: number;
  outputChars: number;
  charsPerSec: number;
  questionsTotal?: number;
  questionsCorrect?: number;
  accuracyBreakdown?: AccuracyItem[];
  outputTokens?: number;
  tokensPerSec?: number;
  /** True when tokens are a chars/4 estimate (usage event missing) — shown as "~". */
  tokensEstimated?: boolean;
  speedSamples?: number;
  /** True cumulative wall time of all speed samples (incl. failed ones). */
  samplesWallMs?: number;
  /** Total output tokens across all speed samples (feeds the run cost). */
  samplesOutputTokens?: number;
}

/** Cost estimate priced with the SAME table as the Usage page. */
export interface SpeedTestCostEstimate {
  pricingLabel: string;
  inputPerM: number;
  outputPerM: number;
  estOutputTokens: number;
  estInputTokens: number;
  estRunCostUsd: number;
}

/** Measured vs expected — attached to each result by the main process. */
export interface SpeedTestBaselineVerdict {
  tier: SpeedTestModelTier;
  expectedTps: { min: number; max: number };
  classification: 'below' | 'within' | 'above' | 'unknown';
  measuredTps: number | null;
  tokensEstimated: boolean;
  historyMedianTps: number | null;
  historyRuns: number;
}

export interface SpeedTestModelResult {
  modelId: string;
  label: string;
  provider: string;
  ok: boolean;
  error?: string;
  rounds: SpeedTestRoundMetrics[];
  /** True wall time from model-start to model-done (all samples + analysis). */
  wallMs: number;
  baseline?: SpeedTestBaselineVerdict;
  /** Usage-page-rate cost estimate for this model's whole run. */
  cost?: SpeedTestCostEstimate;
  /** @deprecated unused by the UI — kept for payload compatibility. */
  avgTtftMs: number;
  /** @deprecated see avgTtftMs. */
  avgTotalMs: number;
  /** @deprecated see avgTtftMs. */
  totalChars: number;
  /** @deprecated see avgTtftMs. */
  avgCharsPerSec: number;
  accuracyPct: number;
}

/** Workspace/session the read-only analysis round runs against. */
export interface SpeedTestTarget {
  key: string;   // 'workspace:<id>' | 'session:<id>'
  name: string;
  path: string;
}

/** Sub-state of a running model ("speed sample 2/3" / analysis). */
export type SpeedTestPhase =
  | { kind: 'speed'; sample: number; samplesTotal: number }
  | { kind: 'analysis' };

export type SpeedTestLiveStatus =
  | 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cli-missing';

/** Live per-model state during a run. */
export interface SpeedTestLiveState {
  status: SpeedTestLiveStatus;
  round: string | null;
  phase: SpeedTestPhase | null;
  /** Per-round elapsed — drives the timeout ring only (may restart per sample). */
  elapsedMs: number;
  timeoutMs: number;
  /** Cumulative since this model's turn started — never resets. */
  modelElapsedMs: number;
  /** 0-based position in the sequential queue. */
  queuePosition?: number;
  /** Final true wall time, set on model-done. */
  wallMs?: number;
  accuracyPct?: number;
  /**
   * Wall-clock of the last progress event (renderer clock). Lets the UI tick
   * the timer smoothly between IPC heartbeats instead of jumping on arrival.
   */
  lastProgressAt?: number;
  /** Renderer clock of the last streamed CLI chunk — drives the "live" dot. */
  lastOutputAt?: number;
  /** Renderer clock when the model crossed the line — drives the celebration. */
  finishedAt?: number;
}

interface SpeedTestQueueEntry {
  modelId: string;
  label: string;
  position: number;
  status: SpeedTestLiveStatus;
}

interface SpeedTestEvent {
  type: 'queue' | 'model-start' | 'round-start' | 'output' | 'progress'
    | 'round-done' | 'model-done' | 'done' | 'aborted';
  entries?: SpeedTestQueueEntry[];
  modelId?: string;
  label?: string;
  round?: string;
  prompt?: string;
  chunk?: string;
  elapsedMs?: number;
  timeoutMs?: number;
  modelElapsedMs?: number;
  phase?: SpeedTestPhase;
  metrics?: SpeedTestRoundMetrics;
  result?: SpeedTestModelResult;
  results?: SpeedTestModelResult[];
}

// Mirrors `speed_test_models` in apps/desktop/src-tauri/src/commands/speedtest.rs —
// KEEP IN SYNC. Claude Code + Codex only, current lineup as of 2026-07.
// Fallback entries carry no availability/baseline/history: that data only
// exists on desktop, and its absence here is visible rather than wrong.
const FALLBACK_MODELS: SpeedTestModelInfo[] = [
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2', provider: 'claude-code-cli', providerLabel: 'Claude Code' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', provider: 'claude-code-cli', providerLabel: 'Claude Code' },
  { id: 'claude-fable-5', label: 'Claude Fable 5', provider: 'claude-code-cli', providerLabel: 'Claude Code' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'claude-code-cli', providerLabel: 'Claude Code' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', provider: 'claude-code-cli', providerLabel: 'Claude Code' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'claude-code-cli', providerLabel: 'Claude Code' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'claude-code-cli', providerLabel: 'Claude Code' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'claude-code-cli', providerLabel: 'Claude Code' },
  { id: 'gpt-6-astra', label: 'GPT-6-Astra', provider: 'codex', providerLabel: 'Codex' },
  { id: 'gpt-6-sol', label: 'GPT-6-Sol', provider: 'codex', providerLabel: 'Codex' },
  { id: 'gpt-6-luna', label: 'GPT-6-Luna', provider: 'codex', providerLabel: 'Codex' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', provider: 'codex', providerLabel: 'Codex' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', provider: 'codex', providerLabel: 'Codex' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', provider: 'codex', providerLabel: 'Codex' },
  { id: 'gpt-5.5', label: 'GPT-5.5', provider: 'codex', providerLabel: 'Codex' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', provider: 'codex', providerLabel: 'Codex' },
];

// Mirrors the desktop speed-test modes, derived from the sub-agent mode presets —
// KEEP IN SYNC. clean/plan_only are intentionally hidden; 'sprint' = default.
const FALLBACK_MODES: SpeedTestModeInfo[] = [
  { id: 'sprint', label: 'Sprint', icon: '⚡', exercise: 'Rapid recon', exerciseBrief: 'Get the quick counts right, fast.' },
  { id: 'architect', label: 'Architect', icon: '🧠', exercise: 'Structure mapping', exerciseBrief: 'Map how the codebase is organized.' },
  { id: 'detective', label: 'Detective', icon: '🐛', exercise: 'Fact hunt', exerciseBrief: 'Hunt down specific files and exact counts.' },
  { id: 'refactor', label: 'Refactor', icon: '🛠', exercise: 'Codebase inventory', exerciseBrief: 'Inventory the file types that would shape a cleanup.' },
  { id: 'paranoid', label: 'Paranoid', icon: '🧪', exercise: 'Exhaustive audit', exerciseBrief: 'Verify every answer against the file system before responding.' },
  { id: 'minimal', label: 'Minimal', icon: '🎯', exercise: 'Precision numbers', exerciseBrief: 'Exact numbers, nothing else.' },
];

export const MAX_MODELS = 3;

@Injectable({ providedIn: 'root' })
export class SpeedTestService {
  readonly models = signal<SpeedTestModelInfo[]>(FALLBACK_MODELS);
  readonly modes = signal<SpeedTestModeInfo[]>(FALLBACK_MODES);
  readonly modeId = signal<string>('sprint');
  /** Positional slots (hdblog-compara style): 3 boxes, each holds a model id. */
  readonly slots = signal<(string | null)[]>([null, null, null]);
  readonly selected = computed(
    () => this.slots().filter((s): s is string => !!s),
  );
  readonly target = signal<SpeedTestTarget | null>(null);
  readonly running = signal(false);
  /** Renderer clock at run start — the single global run timer reads this. */
  readonly runStartedAt = signal<number | null>(null);
  readonly logLines = signal<string[]>([]);
  readonly results = signal<SpeedTestModelResult[]>([]);
  readonly error = signal<string | null>(null);

  /**
   * Per-model live state: models run one at a time (sequential queue in the
   * main process), so exactly one card is 'running' while the others show
   * their queue position or final state.
   */
  readonly live = signal<Record<string, SpeedTestLiveState>>({});

  /**
   * Are we inside the desktop app? It exposes `window.promptops` and
   * `__TAURI__`. In the browser neither exists.
   */
  isDesktopHost(): boolean {
    const w = window as any;
    return !!w.promptops || !!w.__TAURI__;
  }

  /**
   * Does the desktop app expose the Evals command? Read every time (not a
   * `computed` without dependencies, which memoized the first value: if the page
   * was evaluated before the bridge it stayed on "open from the desktop app" forever).
   */
  isDesktop(): boolean {
    return !!this.api()?.speedTestRun;
  }
  // No codebase is needed: this edition runs the speed round only (the
  // desktop accepts and ignores a target), so it must not block the run.
  readonly canRun = computed(
    () =>
      this.isDesktop() &&
      !this.running() &&
      this.selected().length >= 1,
  );

  private unlisten: (() => void) | null = null;

  private api(): any {
    return (window as any).promptops;
  }

  async loadModels(): Promise<void> {
    const api = this.api();
    if (!api?.speedTestListModels) return;
    try {
      const res = await api.speedTestListModels();
      if (res?.ok && Array.isArray(res.data) && res.data.length) {
        this.models.set(res.data);
      }
      if (res?.ok && Array.isArray(res.modes) && res.modes.length) {
        this.modes.set(res.modes);
      }
    } catch { /* keep fallback */ }
  }

  setSlot(index: number, modelId: string | null): void {
    if (this.running() || index < 0 || index >= MAX_MODELS) return;
    const slots = [...this.slots()];
    // A model can occupy only one slot — picking it elsewhere moves it.
    if (modelId) {
      for (let i = 0; i < slots.length; i++) {
        if (i !== index && slots[i] === modelId) slots[i] = null;
      }
    }
    slots[index] = modelId;
    this.slots.set(slots);
  }

  async run(): Promise<void> {
    const api = this.api();
    if (!api?.speedTestRun || this.running()) return;

    this.running.set(true);
    this.runStartedAt.set(Date.now());
    this.error.set(null);
    this.results.set([]);
    this.logLines.set([]);
    // Seed a live card per contender — everyone is on track from the gun
    // (race mode: all models start together, one global clock).
    const seed: Record<string, SpeedTestLiveState> = {};
    this.selected().forEach((id, i) => {
      seed[id] = {
        status: 'running', round: null, phase: null,
        elapsedMs: 0, timeoutMs: 0, modelElapsedMs: 0, queuePosition: i,
        lastProgressAt: Date.now(),
      };
    });
    this.live.set(seed);
    const target = this.target();
    this.listen();

    try {
      const res = await api.speedTestRun(this.selected(), target?.path, this.modeId());
      if (res?.ok) {
        this.results.set(res.results ?? []);
      } else {
        this.error.set(res?.error || 'SPEED_TEST.Run failed');
      }
    } catch (err: any) {
      this.error.set(err?.message || 'SPEED_TEST.Run failed');
    } finally {
      this.running.set(false);
      this.unlisten?.();
      this.unlisten = null;
    }
  }

  private patchLive(id: string | undefined, patch: Partial<SpeedTestLiveState>): void {
    // Only the models of the run in progress: a late event about another
    // model (an earlier, stopped run) must not add a ghost card.
    if (!id || !this.live()[id]) return;
    const cur = this.live()[id] ?? {
      status: 'pending', round: null, phase: null,
      elapsedMs: 0, timeoutMs: 0, modelElapsedMs: 0,
    };
    this.live.set({ ...this.live(), [id]: { ...cur, ...patch } });
  }

  async abort(): Promise<void> {
    try { await this.api()?.speedTestAbort?.(); } catch { /* best effort */ }
  }

  /** Relative 0–100 bar width: best value in the group = 100. */
  barPct(value: number, values: number[], lowerIsBetter: boolean): number {
    const valid = values.filter((v) => v > 0);
    if (!valid.length || value <= 0) return 0;
    if (lowerIsBetter) {
      const best = Math.min(...valid);
      return Math.round((best / value) * 100);
    }
    const best = Math.max(...valid);
    return Math.round((value / best) * 100);
  }

  private listen(): void {
    this.unlisten?.();
    this.unlisten = this.api()?.onSpeedTestProgress?.((_e: unknown, evt: SpeedTestEvent) => {
      switch (evt.type) {
        case 'queue':
          // Sequential-queue transitions: keep positions/status in sync and
          // log them, but never clobber a finished card's wallMs/accuracy.
          for (const entry of evt.entries ?? []) {
            const cur = this.live()[entry.modelId];
            if (cur && cur.status !== entry.status) {
              this.pushLog(`→ ${entry.label} [${entry.position + 1}] ${entry.status}`);
            }
            this.patchLive(entry.modelId, {
              status: entry.status,
              queuePosition: entry.position,
            });
          }
          break;
        case 'model-start':
          this.patchLive(evt.modelId, {
            status: 'running', elapsedMs: 0, modelElapsedMs: 0, phase: null,
            lastProgressAt: Date.now(),
          });
          break;
        case 'round-start':
          // New round: the timeout ring restarts, the cumulative model clock
          // (modelElapsedMs) deliberately does NOT — it never resets.
          this.patchLive(evt.modelId, { round: evt.round ?? null, elapsedMs: 0, timeoutMs: 0 });
          break;
        case 'progress':
          // Drives each card's ring + cumulative timer (not a log line).
          this.patchLive(evt.modelId, {
            round: evt.round ?? null,
            elapsedMs: evt.elapsedMs ?? 0,
            timeoutMs: evt.timeoutMs ?? 0,
            lastProgressAt: Date.now(),
            ...(evt.modelElapsedMs != null ? { modelElapsedMs: evt.modelElapsedMs } : {}),
            ...(evt.phase ? { phase: evt.phase } : {}),
          });
          break;
        case 'output':
          // Real CLI stdout only — shown in the small collapsible terminal.
          // The timestamp feeds the card's "live streaming" pulse.
          this.patchLive(evt.modelId, { lastOutputAt: Date.now() });
          this.appendOutput(evt.chunk ?? '');
          break;
        case 'round-done': {
          const m = evt.metrics;
          if (m) {
            const accuracy = m.questionsTotal
              ? ` — accuracy ${m.questionsCorrect}/${m.questionsTotal}`
              : '';
            this.pushLog(
              m.ok
                ? `  [${m.round}] done in ${m.totalMs} ms${accuracy}`
                : `  [${m.round}] FAILED — ${m.error}`,
            );
          }
          break;
        }
        case 'model-done':
          // Accumulate results live so the benchmark table fills column by
          // column as each model completes its turn in the queue.
          if (evt.result) {
            const r = evt.result;
            this.results.set([...this.results(), r]);
            this.patchLive(r.modelId, {
              status: r.ok ? 'done' : 'failed',
              // TRUE watched wall time (all samples + analysis), from the runner.
              wallMs: r.wallMs,
              accuracyPct: r.accuracyPct,
              finishedAt: Date.now(),
            });
          }
          break;
        case 'aborted': {
          this.pushLog('Run aborted.');
          // Defensive: the queue event normally settles every card, but if it
          // is lost make the end state explicit anyway.
          const live = { ...this.live() };
          for (const [id, st] of Object.entries(live)) {
            if (st.status === 'running') live[id] = { ...st, status: 'failed' };
            else if (st.status === 'pending') live[id] = { ...st, status: 'skipped' };
          }
          this.live.set(live);
          break;
        }
      }
    }) ?? null;
  }

  private pushLog(line: string): void {
    this.logLines.set([...this.logLines(), ...line.split('\n')]);
  }

  /** Live CLI output: append to the last line, keep the log bounded. */
  private appendOutput(chunk: string): void {
    if (!chunk) return;
    const lines = [...this.logLines()];
    const last = lines.pop() ?? '';
    const parts = (last + chunk).split('\n');
    const merged = [...lines, ...parts];
    this.logLines.set(merged.length > 400 ? merged.slice(-400) : merged);
  }
}
