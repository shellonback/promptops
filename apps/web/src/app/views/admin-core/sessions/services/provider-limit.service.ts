import { Injectable, effect, inject, isDevMode, signal } from '@angular/core';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { Store } from '@ngrx/store';
import { toSignal } from '@angular/core/rxjs-interop';
import { getSessions, getActiveSessionId } from '../../../../../store/sessions/session.selectors';
import { getAllProviderUsage } from '../../../../../store/token-efficiency/token-efficiency.selectors';
import { ProviderUsageSnapshot } from '../../../../../store/token-efficiency/token-efficiency.state';
import { ProviderType, SessionSummary } from '../../../../../store/sessions/session.state';
import { SubAgent, SubAgentService } from './sub-agent.service';
import { ProviderSwitchService } from './provider-switch.service';
import { SessionService } from './session.service';
import { PROVIDER_LOGOS, SPAWN_PROVIDERS } from './spawn-providers.const';
import { TranslateService } from '@ngx-translate/core';
import { SwalService } from '../../../../core/services/swal.service';
import { ProviderService } from '../../../../core/services/provider.service';
import { DesktopSessionApiService } from './desktop-session-api.service';
import { updateSessionSuccess } from '../../../../../store/sessions/session.actions';
import { firstValueFrom } from 'rxjs';

/** Providers that are AI agents (never offer the plain shell as a fallback). */
const AI_PROVIDERS: ReadonlyArray<ProviderType> = SPAWN_PROVIDERS
  .map((p) => p.value)
  .filter((v) => v !== 'generic-shell');

/**
 * Free / no-subscription / reduced-limit providers among the ones PromptOps
 * ships. Order = recommendation priority (OmniRoute-style "free tier" cascade:
 * generous documented free tiers first, keyless local options next).
 */
export interface FreeTierProvider {
  id: ProviderType;
  /** i18n key with the short description (limits, what's free). */
  descKey: string;
  /** i18n key with the "why we recommend it" sentence. */
  whyKey: string;
}
// Gemini CLI is not listed: personal Google sign-in is retired for it
// (PROVIDERS.GEMINI.LIMITATIONS), so "free with a Google account" was untrue.
export const FREE_TIER_PROVIDERS: ReadonlyArray<FreeTierProvider> = [
  { id: 'opencode', descKey: 'SUBAGENTS.LIMIT.FREE.opencode', whyKey: 'SUBAGENTS.LIMIT.WHY.opencode' },
  { id: 'zai', descKey: 'SUBAGENTS.LIMIT.FREE.zai', whyKey: 'SUBAGENTS.LIMIT.WHY.zai' },
  { id: 'kimi', descKey: 'SUBAGENTS.LIMIT.FREE.kimi', whyKey: 'SUBAGENTS.LIMIT.WHY.kimi' },
  { id: 'copilot', descKey: 'SUBAGENTS.LIMIT.FREE.copilot', whyKey: 'SUBAGENTS.LIMIT.WHY.copilot' },
  { id: 'grok', descKey: 'SUBAGENTS.LIMIT.FREE.grok', whyKey: 'SUBAGENTS.LIMIT.WHY.grok' },
  { id: 'promptops-cli', descKey: 'SUBAGENTS.LIMIT.FREE.promptops-cli', whyKey: 'SUBAGENTS.LIMIT.WHY.promptops-cli' },
];

/** What the modal hands back. */
export interface ProviderLimitDecision {
  provider: ProviderType;
  /** 'restart' = respawn the affected sub-agents now; 'new' = only future spawns. */
  scope: 'restart' | 'new';
  /** "Open now" from the free-tier block: spawn one agent right away when nothing gets restarted. */
  openNow?: boolean;
  /** Handoff for the main session as edited by the user in the draft. */
  handoff?: string;
}

export interface ProviderCandidate {
  id: ProviderType;
  label: string;
  logo: string;
  installed: boolean;
  usedBefore: boolean;
  /** This candidate is itself in a lockout window (hit its limit recently). */
  limited: boolean;
}

export interface ProviderLimitContext {
  exhausted: ProviderType;
  exhaustedLabel: string;
  parentSessionId: string | null;
  /** Human "resets at …" label when known (usage snapshot), else ''. */
  resetsLabel: string;
  /** Sub-agents of the active session running on the exhausted provider. */
  affected: SubAgent[];
  /** The active MAIN session itself, when it runs on the exhausted provider (live PTY). */
  affectedMain: SessionSummary | null;
  candidates: ProviderCandidate[];
  free: Array<FreeTierProvider & ProviderCandidate & { recommended: boolean }>;
  /** Manual entry (model-badge menu): one pane only, no limit involved. */
  manual?: { targetLabel: string };
  /** Editable handoff draft for the main session (in-place switch only):
   *  task, user decisions, files touched and last output, shown BEFORE send. */
  handoffDraft?: string;
}

/** Pane targeted by the manual "Switch provider…" entry. */
export interface SwitchTarget {
  sessionId: string;
  /** Sub-agent pane, or null for the main session. */
  sa: SubAgent | null;
  provider: ProviderType;
}

interface Lockout { until: number; resets: string }

const LOCKOUT_KEY = 'po-provider-limit-lockouts';
const SHOWN_KEY = 'po-provider-limit-shown-at';
/** The limit modal shows at most once per this window (any provider). */
const SHOW_EVERY_MS = 10 * 60 * 1000;
/**
 * A certain signal must repeat this many times before the modal shows
 * (one stray 100% reading opened it while the user still had
 * plenty of credit and kept working).
 */
const CONFIRMATIONS_NEEDED = 3;
/** Rolling window the confirmations must fall into (stale hits age out). */
const CONFIRM_WINDOW_MS = 30 * 60 * 1000;
/** Signals closer than this are ONE observation (output bursts, several panes printing the same line). */
const MIN_HIT_GAP_MS = 20_000;
/** After the user actually switched away, keep the provider marked as limited (picker tag). */
const SWITCHED_LOCKOUT_MS = 60 * 60 * 1000;
/** Tail of a terminal buffer forwarded to the replacement agent as shared context. */
const HANDOFF_TAIL_CHARS = 2500;

/** Hard "you're out of quota" messages — every CLI we ship prints one of these. */
export const HARD_PATTERNS: RegExp[] = [
  /usage limit (reached|exceeded)/i,               // Claude Code
  /you'?ve (hit|reached) (your|the) [\w -]{0,24}limit/i, // Claude / Codex / Cursor
  /limit will reset at/i,                          // Claude Code
  /quota exceeded/i,                               // Gemini
  /exhausted your [\w ]{0,24}quota/i,              // Gemini
  /RESOURCE_EXHAUSTED/,                            // Gemini / Google APIs
  // Gemini CLI with a personal Google login: Code Assist for individuals was
  // retired ("migrate to Antigravity") — as blocking as an empty quota.
  /IneligibleTierError|no longer supported for Gemini Code Assist/i,
  /usage_limit_reached|rate_limit_exceeded|rate_limit_error/i,
  /(out of|insufficient|no remaining) (free )?(credits?|quota)/i,
  /credits? (exhausted|depleted)/i,
  /daily (request )?limit (reached|exceeded)/i,
  /weekly limit (reached|exceeded)/i,
  // GitHub Copilot CLI: premium requests / monthly allowance used up.
  /exceeded your (monthly |premium )?(premium )?(request )?(allowance|quota)/i,
  // OpenAI-compatible APIs (grok, opencode, hermes…): billing quota error code.
  /\binsufficient_quota\b/i,
];

/**
 * A model-bucket limit is not a provider outage: the CLI falls back to
 * another model on its own (e.g. "Opus weekly limit reached · now using
 * Sonnet") and the session keeps working.
 */
export const MODEL_SCOPED_PATTERNS: RegExp[] = [
  /\b(opus|fable|haiku)\b[^\n]{0,48}\blimit\b/i,
  /\blimit\b[^\n]{0,48}\b(opus|fable|haiku)\b/i,
  /(switch(?:ing|ed)? to|now using|fall(?:ing)? back to) (claude[- ])?(sonnet|haiku|opus|fable)/i,
];

/**
 * Name after a provider switch: only default-style names ("Claude", "Claude
 * Code 2") follow the provider; anything the user chose returns null.
 */
export function defaultNameAfterSwitch(name: string, fromLabel: string, toLabel: string): string | null {
  const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labels = [...new Set([fromLabel, fromLabel.split(' ')[0]])].filter(Boolean);
  const match = name.match(new RegExp(`^(?:${labels.map(escape).join('|')})(\\s+\\d+)?$`, 'i'));
  if (!match) return null;
  const next = `${toLabel}${match[1] ?? ''}`;
  return next === name ? null : next;
}

export interface MainHandoffInput {
  sessionName: string;
  fromLabel: string;
  manual: boolean;
  userMessages: string[];
  changedFiles: string;
  subAgents: Array<{ title: string; prompt?: string | null }>;
  tail: string;
}

/** Provider-neutral handoff of the main session (shown as an editable draft). */
export function formatMainHandoff(h: MainHandoffInput): string {
  const why = h.manual ? 'the user switched provider' : 'it hit its usage limit';
  const lines = [
    `# Handoff — you are taking over the MAIN session "${h.sessionName}" from ${h.fromLabel} (${why})`,
    'Same workspace and terminal. Continue the work in progress: check `git status` / `git diff` first and do not redo finished steps.',
  ];
  if (h.userMessages.length > 0) {
    lines.push(
      '', '## What the user asked so far — these instructions and decisions still apply',
      ...h.userMessages.map((m) => `- ${m.replace(/\s*\n\s*/g, ' ')}`),
    );
  }
  if (h.changedFiles.trim()) {
    lines.push('', '## Files touched (git status --short)', '```text', h.changedFiles.trim(), '```');
  }
  if (h.subAgents.length > 0) {
    lines.push('', '## Sub-agents being handed over as well', ...h.subAgents.map((sa) => `- ${sa.title}${sa.prompt ? `: ${sa.prompt.slice(0, 300)}` : ''}`));
  }
  if (h.tail.trim()) {
    lines.push('', '## Last terminal output of the previous provider', '```text', h.tail.trim(), '```');
  }
  lines.push('', 'Summarize the current state in 3 lines, then pick up exactly where it stopped, respecting the instructions above.');
  return lines.join('\n');
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * Detects "provider hit its limit" (terminal output + usage snapshots) and
 * drives the suggest modal: pick another installed / previously-used
 * provider, then either respawn the affected sub-agents with shared context
 * (same slot in the roster) or just move the spawn composer to it.
 *
 * Inspired by OmniRoute's tier cascade (subscription → API → free) and its
 * per-provider cooldown: a provider that tripped stays "limited" for a window
 * so the picker never suggests it back. Triggers are certain signals only —
 * a BLOCKING usage bucket at 100% (provider probe) or the CLI's own limit
 * message — confirmed CONFIRMATIONS_NEEDED times inside CONFIRM_WINDOW_MS,
 * and the modal shows at most once every 10 minutes.
 */
@Injectable({ providedIn: 'root' })
export class ProviderLimitService {
  private store = inject(Store);
  private modal = inject(NgbModal);
  private subAgents = inject(SubAgentService);
  private providerSwitch = inject(ProviderSwitchService);
  private sessionService = inject(SessionService);
  private swal = inject(SwalService);
  private translate = inject(TranslateService);
  private providerService = inject(ProviderService);
  private sessionApi = inject(DesktopSessionApiService);
  /** Main switches launched in Rust and not settled yet: the data side
   *  (chip, local store) moves only once the new provider is actually running. */
  private pendingMainSwitch = new Map<string, { session: SessionSummary; to: ProviderType }>();

  private sessions = toSignal(this.store.select(getSessions), { initialValue: [] });
  private activeSessionId = toSignal(this.store.select(getActiveSessionId), { initialValue: null });
  private allUsage = toSignal(this.store.select(getAllProviderUsage), { initialValue: {} as Record<string, ProviderUsageSnapshot> });

  /**
   * Provider the spawn composer should move to. The action-center consumes it
   * (effect) and resets it to null — one-shot, never a persistent override.
   */
  readonly preferredSpawnProvider = signal<ProviderType | null>(null);
  /** True while a limit modal is open — guards against a second trigger. */
  readonly modalOpen = signal(false);
  /** True while the restart flow respawns agents (UI spinner). */
  readonly restarting = signal(false);
  /** Main sessions whose PTY is mid provider-switch (terminal veil). */
  readonly switchingSessions = signal<ReadonlySet<string>>(new Set());
  isSwitchingSession(sessionId: string | null | undefined): boolean {
    return !!sessionId && this.switchingSessions().has(sessionId);
  }

  private lockouts = this.readLockouts();
  /** Rolling tail per stream so a message split across PTY chunks still matches. */
  private tails = new Map<string, string>();
  /** Confirmed limit signals per provider (epoch-ms, oldest first). */
  private hits = new Map<ProviderType, number[]>();
  /** Last non-empty "resets at …" seen per provider, for the modal label. */
  private lastResets = new Map<ProviderType, string>();
  /** Timestamp of the last counted 100% snapshot per `provider|session`. */
  private countedSnapTs = new Map<string, string>();
  private started = false;
  /** Epoch-ms of the last modal shown (global gate, persisted across reloads). */
  private lastShownAt = this.readShownAt();
  /** QA mode: no gate at all. */
  private gateDisabled = false;

  constructor() {
    // Usage snapshots (Claude `/usage`, Codex `/status`, …): a 100% bucket is
    // an authoritative "limit reached", no regex needed.
    effect(() => {
      const usage = this.allUsage();
      if (!this.started) return;
      for (const snap of Object.values(usage)) this.checkSnapshot(snap);
    });
    if (isDevMode()) this.installDevHooks();
  }

  /**
   * Dev-only QA hooks (stripped from prod builds by isDevMode()):
   *  - `window.__po.simulateProviderLimit('codex', 'at 3:00 PM')` from the inspector
   *  - `?poSimLimit=claude-code-cli` on the dev URL → modal opens 8s after boot
   *    and ~1.5s after every hot-reload (flag kept in sessionStorage), so a
   *    plain file save re-opens it — no dev server restart, no URL re-typing.
   *    `__po.stopSimulateProviderLimit()` stops it.
   */
  private installDevHooks(): void {
    const w = window as unknown as { __po?: Record<string, unknown> };
    w.__po = {
      ...(w.__po ?? {}),
      simulateProviderLimit: (provider: ProviderType = 'claude-code-cli', resets = '') => {
        this.started = true;
        delete this.lockouts[provider];
        void this.open(provider, resets);
      },
    };
    // The flag survives live-reloads (sessionStorage) so QA can re-open the
    // modal after every hot-reload without re-typing the URL.
    const fromUrl = new URLSearchParams(window.location.search).get('poSimLimit');
    if (fromUrl) { try { sessionStorage.setItem('po-sim-limit', fromUrl); } catch { /* noop */ } }
    let p: string | null = fromUrl;
    try { p = p ?? sessionStorage.getItem('po-sim-limit'); } catch { /* noop */ }
    if (p) {
      // QA mode: no cooldowns, so a fake limit line typed in a terminal
      // (e.g. `! echo "usage limit reached"`) re-opens the modal every time.
      this.lockouts = {};
      this.gateDisabled = true;
      try { localStorage.removeItem(LOCKOUT_KEY); localStorage.removeItem(SHOWN_KEY); } catch { /* noop */ }
      this.setLockout = () => { /* disabled in QA mode */ };
      const sim = (w.__po as { simulateProviderLimit: (p: string, r: string) => void }).simulateProviderLimit;
      // Auto-open after boot: 8s on the first visit (URL flag, app still
      // hydrating) and ~1.5s after every hot-reload, where the flag comes from
      // sessionStorage and the router has already dropped the query param.
      // No dev server restart, no re-typing the URL: save a file → modal is back.
      setTimeout(() => sim(p!, 'at 3:00 PM'), fromUrl ? 8000 : 1500);
      // Stop it from the inspector: __po.stopSimulateProviderLimit()
      w.__po = {
        ...(w.__po ?? {}),
        stopSimulateProviderLimit: () => {
          try { sessionStorage.removeItem('po-sim-limit'); } catch { /* noop */ }
        },
      };
      // On-demand trigger without a page reload: poll a JSON served by the
      // dev server (webapp/src/assets/dev-trigger.json, git-ignored) and open the
      // modal whenever its `nonce` changes — session state stays intact.
      let lastNonce: unknown = null;
      let seeded = false;
      setInterval(async () => {
        try {
          const r = await fetch(`/assets/dev-trigger.json?ts=${Date.now()}`, { cache: 'no-store' });
          if (!r.ok) return;
          const j = (await r.json()) as { nonce?: unknown; provider?: string; resets?: string };
          if (!seeded) { seeded = true; lastNonce = j.nonce ?? null; return; }
          if (j.nonce !== lastNonce) {
            lastNonce = j.nonce ?? null;
            sim(j.provider ?? p!, j.resets ?? '');
          }
        } catch { /* dev server gone */ }
      }, 3000);
    }
  }

  /** Called once from AppComponent (desktop only — output streams don't exist on web). */
  start(): void {
    if (!this.sessionService.isDesktop) return;
    this.started = true;
    const api = (window as unknown as { promptops?: Record<string, unknown> }).promptops;
    const onSwitch = api?.['onSessionProviderSwitch'] as
      | ((cb: (ev: unknown, data: { sessionId: string; provider: string; phase: string; reason?: string }) => void) => unknown)
      | undefined;
    onSwitch?.((_ev, data) => {
      // Veil only while PromptOps is driving the terminal: `awaiting-user`
      // (trust/update dialog of the CLI) drops it so the user answers.
      this.switchingSessions.update((set) => {
        const next = new Set(set);
        if (data.phase === 'started') next.add(data.sessionId); else next.delete(data.sessionId);
        return next;
      });
      void this.onMainSwitchPhase(data);
    });
  }

  private async onMainSwitchPhase(data: { sessionId: string; provider: string; phase: string; reason?: string }): Promise<void> {
    const pending = this.pendingMainSwitch.get(data.sessionId);
    const provider = this.label(data.provider as ProviderType);
    switch (data.phase) {
      case 'ready':
      case 'handoff-not-delivered':
        this.pendingMainSwitch.delete(data.sessionId);
        if (pending) {
          await this.providerSwitch.changeSessionProvider(pending.session, pending.to);
          await this.renameDefaultName(data.sessionId, pending.session.provider, pending.to);
        }
        if (data.phase === 'handoff-not-delivered') {
          this.swal.error(this.translate.instant('SUBAGENTS.LIMIT.Switch handoff not delivered', { provider }));
        }
        break;
      case 'error':
        this.pendingMainSwitch.delete(data.sessionId);
        this.switchFailed(data.provider as ProviderType, data.reason);
        break;
    }
  }

  /**
   * A default-style name ("Claude 2") follows the provider ("Codex 2"): the
   * audit found sessions still called "Claude 2" while Codex ran in them.
   * Names the user chose are never touched; a taken name is left alone.
   */
  private async renameDefaultName(sessionId: string, from: ProviderType, to: ProviderType): Promise<void> {
    const current = this.sessions().find((s) => s.id === sessionId);
    if (!current) return;
    const next = defaultNameAfterSwitch(current.name, this.label(from), this.label(to));
    if (!next || this.sessions().some((s) => s.name === next)) return;
    const oldName = current.name;
    const apply = (name: string) => {
      const live = this.sessions().find((s) => s.id === sessionId);
      if (live) this.store.dispatch(updateSessionSuccess({ session: { ...live, name } }));
      void Promise.resolve(this.sessionService.renameSession(sessionId, name)).catch(() => {});
    };
    apply(next);
    try {
      await firstValueFrom(this.sessionApi.rename(sessionId, next, oldName, false));
    } catch {
      apply(oldName); // name taken in the local store or offline: keep the old one
    }
  }

  /** Every switch failure reaches the user, with the install hint when the
   *  CLI never started (audit UX 10/2026: "Restart with Opencode" did nothing). */
  private switchFailed(provider: ProviderType, reason?: string): void {
    const label = this.label(provider);
    const key = reason === 'dialog-timeout' ? 'SUBAGENTS.LIMIT.Switch failed dialog'
      : reason === 'no-target' ? 'SUBAGENTS.LIMIT.Switch failed no target'
      : reason === 'not-started' || reason === 'exited' ? 'SUBAGENTS.LIMIT.Switch failed not started'
      : 'SUBAGENTS.LIMIT.Switch failed';
    let msg = this.translate.instant(key, { provider: label });
    const hintKey = this.providerService.manifests().find((m) => m.id === provider)?.cli?.installHintKey;
    if (hintKey && reason !== 'dialog-timeout' && reason !== 'no-target') {
      const hint = this.translate.instant(hintKey);
      if (hint && hint !== hintKey) msg += `<br><br><small>${hint}</small>`;
    }
    this.swal.error(msg);
  }

  // ── Detection ────────────────────────────────────────────────────

  /** Provider of a main session (null when unknown). */
  sessionProvider(sessionId: string): string | null {
    return this.sessions().find((s) => s.id === sessionId)?.provider ?? null;
  }

  /**
   * Feed live terminal output (never the replay: an old limit message must
   * not re-open the modal on every attach).
   */
  sniffOutput(streamId: string, provider: ProviderType | string | null | undefined, data: string): void {
    if (!this.started) return;
    if (!provider) provider = this.sessions().find((s) => s.id === streamId)?.provider ?? null;
    if (!provider || provider === 'generic-shell') return;
    if (!data || data.length > 20_000) return; // giant frames = replay/resize, skip
    const clean = stripAnsi(data);
    if (!clean.trim()) return;
    const tail = ((this.tails.get(streamId) ?? '') + clean).slice(-600);
    this.tails.set(streamId, tail);

    // Only the provider's OWN "limit reached" message counts: transient 429s
    // and rate-limit retries are noise, not a quota exhausted.
    if (HARD_PATTERNS.some((re) => re.test(tail))) {
      this.tails.set(streamId, '');
      // Model-bucket limit: the CLI already fell back to another model and
      // the session keeps working — not a provider outage.
      if (MODEL_SCOPED_PATTERNS.some((re) => re.test(tail))) return;
      this.recordHit(provider as ProviderType, this.extractResets(tail));
    }
  }

  /**
   * One certain signal for a provider. The modal opens only after
   * CONFIRMATIONS_NEEDED distinct signals inside CONFIRM_WINDOW_MS — a single
   * stray match (the model quoting a rate-limit string in its own output, one
   * misparsed probe) never opens it.
   */
  private recordHit(provider: ProviderType, resets: string): void {
    const now = Date.now();
    if (resets) this.lastResets.set(provider, resets);
    const hits = (this.hits.get(provider) ?? []).filter((t) => now - t < CONFIRM_WINDOW_MS);
    if (hits.length === 0 || now - hits[hits.length - 1] >= MIN_HIT_GAP_MS) hits.push(now);
    const needed = this.gateDisabled ? 1 : CONFIRMATIONS_NEEDED;
    if (hits.length < needed) {
      this.hits.set(provider, hits);
      return;
    }
    this.hits.set(provider, []);
    void this.trigger(provider, resets || this.lastResets.get(provider) || '');
  }

  private checkSnapshot(snap: ProviderUsageSnapshot): void {
    if (!snap?.provider) return;
    // Ignore stale probes (older than 6h) — the window has surely rolled.
    const ts = Date.parse(snap.timestamp);
    if (Number.isFinite(ts) && Date.now() - ts > 6 * 60 * 60 * 1000) return;
    const sections = snap.sections ?? [];
    // Model-scoped weekly buckets ("Current week (Fable)") never block the
    // provider — the CLI falls back to another model on its own — and the
    // "Extra usage" bar is a spend budget, not a quota. Neither is a limit.
    const blocking = sections.filter((s) => !this.isNonBlockingSection(s.label));
    // Extra usage active with budget left: a full session/weekly bucket does
    // not stop the CLI either, it keeps working on the extra budget. The
    // parsed bar is required — Codex sets extraUsageEnabled without having
    // the concept at all.
    const extra = sections.find((s) => /^\s*extra usage/i.test(s.label));
    if (snap.extraUsageEnabled && extra && extra.percentUsed < 100) return;
    const full = snap.sessionPercent >= 100 || snap.weeklyPercent >= 100
      || blocking.some((s) => s.percentUsed >= 100);
    if (!full) return;
    // The store re-emits the same snapshot on every usage update: only a
    // fresh probe (new timestamp) is a new confirmation.
    const key = `${snap.provider}|${snap.sessionId}`;
    if (this.countedSnapTs.get(key) === snap.timestamp) return;
    this.countedSnapTs.set(key, snap.timestamp);
    const resets = snap.sessionPercent >= 100 ? snap.sessionResets
      : snap.weeklyPercent >= 100 ? snap.weeklyResets
      : (blocking.find((s) => s.percentUsed >= 100)?.resetsLabel ?? '');
    this.recordHit(snap.provider as ProviderType, resets ?? '');
  }

  /** "Current week (<model>)" buckets and the "Extra usage" bar never block the provider. */
  private isNonBlockingSection(label: string): boolean {
    const l = (label ?? '').split(' · ')[0].trim().toLowerCase();
    if (l.startsWith('extra usage')) return true;
    const m = l.match(/^current week\s*\((.+)\)$/);
    return !!m && m[1].trim() !== 'all models';
  }

  private extractResets(text: string): string {
    const m = text.match(/reset(?:s)? (?:at|in|on) ([^\n.]{3,40})/i);
    return m ? m[1].trim() : '';
  }

  isLimited(provider: ProviderType): boolean {
    const l = this.lockouts[provider];
    return !!l && l.until > Date.now();
  }

  // ── Modal ────────────────────────────────────────────────────────

  private async trigger(provider: ProviderType, resets: string): Promise<void> {
    if (this.modalOpen()) return;
    const now = Date.now();
    // One modal per SHOW_EVERY_MS, whatever the user does with it: a 100%
    // snapshot keeps coming back on every probe and the CLI keeps printing
    // its limit line — neither must nag.
    if (!this.gateDisabled && now - this.lastShownAt < SHOW_EVERY_MS) return;
    this.lastShownAt = now;
    try { localStorage.setItem(SHOWN_KEY, String(now)); } catch { /* quota */ }
    await this.open(provider, resets);
  }

  /**
   * Manual entry (model-badge menu → "Switch provider…"): same modal and the
   * same in-place restart, scoped to ONE pane. No lockouts, no snooze.
   */
  async openForTarget(target: SwitchTarget): Promise<void> {
    if (this.modalOpen()) return;
    this.modalOpen.set(true);
    try {
      const ctx = await this.buildContext(target.provider, '', target);
      await this.showModal(ctx);
    } finally {
      this.modalOpen.set(false);
    }
  }

  /** Public entry so a header badge / menu can open the picker on demand. */
  async open(provider: ProviderType, resets = ''): Promise<void> {
    if (this.modalOpen()) return;
    this.modalOpen.set(true);
    try {
      const ctx = await this.buildContext(provider, resets);
      await this.showModal(ctx);
    } finally {
      this.modalOpen.set(false);
    }
  }

  private async showModal(ctx: ProviderLimitContext): Promise<void> {
    {
      const { ProviderLimitModalComponent } = await import('../provider-limit-modal/provider-limit-modal.component');
      const ref = this.modal.open(ProviderLimitModalComponent, {
        centered: true,
        size: 'xl',
        windowClass: 'provider-limit-modal',
        backdrop: true,
        keyboard: true,
      });
      (ref.componentInstance as { ctx: ProviderLimitContext }).ctx = ctx;
      let decision: ProviderLimitDecision | undefined;
      try { decision = await ref.result; } catch { decision = undefined; }
      if (decision) await this.apply(ctx, decision);
    }
  }

  private async buildContext(exhausted: ProviderType, resets: string, target?: SwitchTarget): Promise<ProviderLimitContext> {
    const parentSessionId = target?.sessionId ?? this.activeSessionId();
    const usedBefore = new Set<string>();
    for (const s of this.sessions()) if (s.provider) usedBefore.add(s.provider);
    for (const sa of this.subAgents.allSubAgents()) usedBefore.add(sa.provider);
    for (const sa of this.subAgents.activeSubAgents()) usedBefore.add(sa.provider);

    const installed = await Promise.all(
      AI_PROVIDERS.map(async (id) => [id, await this.providerSwitch.isProviderAvailable(id, parentSessionId ?? undefined, this.sessionService.isTauri)] as const),
    );
    const installedSet = new Set(installed.filter(([, ok]) => ok).map(([id]) => id));

    const all: ProviderCandidate[] = AI_PROVIDERS
      .filter((id) => id !== exhausted)
      .map((id) => ({
        id,
        label: this.label(id),
        logo: PROVIDER_LOGOS[id] ?? PROVIDER_LOGOS['generic-shell'],
        installed: installedSet.has(id),
        usedBefore: usedBefore.has(id),
        limited: this.isLimited(id),
      }));
    // Installed or previously used only; fall back to everything so the modal
    // is never empty on a fresh machine.
    let candidates = all.filter((c) => c.installed || c.usedBefore);
    if (candidates.length === 0) candidates = all;
    candidates.sort((a, b) => this.rank(b) - this.rank(a));

    const free = FREE_TIER_PROVIDERS
      .filter((f) => f.id !== exhausted)
      .map((f) => ({ ...f, ...(all.find((c) => c.id === f.id)!), recommended: false }));
    const pick = free.find((f) => f.installed && !f.limited) ?? free.find((f) => !f.limited) ?? free[0];
    if (pick) pick.recommended = true;

    let affected = parentSessionId
      ? this.subAgents.activeSubAgents().filter((sa) =>
          sa.parentSessionId === parentSessionId && sa.provider === exhausted && sa.role !== 'smart-action')
      : [];

    // The main session counts too when it runs on the exhausted provider
    // with a live PTY (parked sessions relaunch with the new provider on wake).
    const active = parentSessionId ? this.sessions().find((s) => s.id === parentSessionId) : undefined;
    let affectedMain = active && active.provider === exhausted && !active.standbyAt
      && active.provider !== 'generic-shell' ? active : null;

    // Manual target: exactly one pane, whatever else runs on that provider.
    let manual: ProviderLimitContext['manual'];
    if (target) {
      affected = target.sa ? [target.sa] : [];
      affectedMain = target.sa ? null : (active ?? null);
      manual = { targetLabel: target.sa ? target.sa.title : (active?.name ?? '') };
    }

    const canSwitchMain = !!(window as unknown as { promptops?: Record<string, unknown> }).promptops?.['switchSessionProvider'];
    const handoffDraft = affectedMain && canSwitchMain
      ? await this.buildMainHandoff(affectedMain, affected, exhausted, !!manual)
      : undefined;

    return {
      ...(manual ? { manual } : {}),
      ...(handoffDraft !== undefined ? { handoffDraft } : {}),
      exhausted,
      exhaustedLabel: this.label(exhausted),
      parentSessionId,
      resetsLabel: resets,
      affected,
      affectedMain,
      candidates,
      free,
    };
  }

  private rank(c: ProviderCandidate): number {
    return (c.installed ? 4 : 0) + (c.usedBefore ? 2 : 0) - (c.limited ? 8 : 0);
  }

  private label(id: ProviderType): string {
    return PROVIDER_LABELS[id] ?? id;
  }

  // ── Apply ────────────────────────────────────────────────────────

  private async apply(ctx: ProviderLimitContext, d: ProviderLimitDecision): Promise<void> {
    if (!ctx.manual) {
      // The exhausted provider stays out of the picker for the full window now
      // that the user has actively moved away from it.
      this.setLockout(ctx.exhausted, SWITCHED_LOCKOUT_MS, ctx.resetsLabel);
      // Always move the composer: "from now on, new spawns go here".
      this.preferredSpawnProvider.set(d.provider);
    }

    if (d.scope === 'restart' && (ctx.affected.length > 0 || ctx.affectedMain) && ctx.parentSessionId) {
      if (ctx.affected.length > 0) {
        await this.restartAffected(ctx.parentSessionId, ctx.affected, ctx.exhausted, d.provider);
      }
      if (ctx.affectedMain) await this.switchMain(ctx.affectedMain, ctx.affected, ctx.exhausted, d.provider, !!ctx.manual, d.handoff);
      return;
    }
    if (ctx.manual && !d.openNow) {
      // Manual "Restart with X" with no pane to restart: never a silent no-op.
      this.switchFailed(d.provider, 'no-target');
      return;
    }
    if (d.openNow && ctx.parentSessionId) {
      await this.spawnFresh(ctx.parentSessionId, ctx.exhausted, d.provider);
    }
  }

  /**
   * Move every affected sub-agent to the new provider IN PLACE: same
   * terminal, same roster slot. The CLI is exited and the new one launched
   * in the same shell with a handoff prompt (original task + tail of the
   * previous output); the pane shows the boot loader meanwhile. If the
   * in-place switch fails, it falls back to destroy + respawn in the same slot.
   */
  private async restartAffected(
    parentSessionId: string,
    affected: SubAgent[],
    from: ProviderType,
    to: ProviderType,
  ): Promise<void> {
    this.restarting.set(true);
    const workspacePath = this.sessions().find((s) => s.id === parentSessionId)?.workspace?.path;
    const order = this.subAgents.activeSubAgents().map((s) => s.id);
    let replacedInPlace = 0;
    let respawned = 0;
    try {
      let failed = 0;
      for (const sa of affected) {
        let tail = '';
        try { tail = stripAnsi(await this.subAgents.getBuffer(sa.id)).slice(-HANDOFF_TAIL_CHARS); } catch { /* no buffer */ }
        const prompt = this.handoffPrompt(sa, from, to, tail);

        const switched = await this.subAgents.switchProvider(sa.id, to, prompt);
        if (switched) {
          replacedInPlace++;
          // Headless worker: Rust only re-points the meta — the handoff is
          // the next chat turn.
          if (sa.executionMode === 'worker') await this.subAgents.sendWorkerMessage(sa.id, prompt);
          continue;
        }

        // Fallback (in-place switch unavailable or failed): close and respawn in the same slot.
        await this.subAgents.destroy(sa.id);
        let spawned: SubAgent | null = null;
        try {
          spawned = await this.subAgents.spawnCustom(
            parentSessionId, sa.role, sa.title, prompt, to, sa.mode, sa.config,
            workspacePath, undefined, undefined, sa.executionMode,
          );
        } catch (err) {
          console.error('[ProviderLimit] respawn failed', sa.title, err);
          failed++;
        }
        if (spawned) {
          const idx = order.indexOf(sa.id);
          if (idx >= 0) order[idx] = spawned.id;
          respawned++;
        }
      }
      if (respawned > 0) await this.subAgents.reorderSubAgents(parentSessionId, order);
      if (failed > 0) this.switchFailed(to);
      console.info(`[ProviderLimit] switched ${replacedInPlace} in place, respawned ${respawned}`);
    } finally {
      this.restarting.set(false);
    }
  }

  /**
   * Main session: same PTY switch via Rust (`session_switch_provider`), then
   * the data-side provider change (store + local store) so the chip, the provider
   * check and future wakes all agree. The terminal veil is driven by the
   * `session:provider-switch` phases.
   */
  private async switchMain(session: SessionSummary, subAgents: SubAgent[], from: ProviderType, to: ProviderType, manual = false, edited?: string): Promise<void> {
    const api = (window as unknown as { promptops?: Record<string, unknown> }).promptops;
    const switchFn = api?.['switchSessionProvider'] as
      | ((req: { sessionId: string; provider: string; prompt: string }) => Promise<{ ok: boolean; error?: string }>)
      | undefined;
    if (!switchFn) return; // No desktop bridge: no in-place switch for the main PTY
    const prompt = edited?.trim() || await this.buildMainHandoff(session, subAgents, from, manual);
    // Data side (store + local store) waits for the `ready` phase: the launch is
    // async in Rust and may still fail (CLI missing, dialog left open).
    this.pendingMainSwitch.set(session.id, { session, to });
    try {
      const res = await switchFn({ sessionId: session.id, provider: to, prompt });
      if (!res?.ok) {
        console.error('[ProviderLimit] main switch failed:', res?.error);
        this.pendingMainSwitch.delete(session.id);
        this.switchFailed(to);
      }
    } catch (err) {
      console.error('[ProviderLimit] main switch threw:', err);
      this.pendingMainSwitch.delete(session.id);
      this.switchFailed(to);
    }
  }

  /**
   * Handoff of the main session: the user's own instructions from the current
   * conversation (rules given only in chat must survive the switch — audit
   * UX 10/2026), files touched, sub-agents and the terminal tail. Provider
   * neutral: the same draft works whichever target the user picks.
   */
  private async buildMainHandoff(session: SessionSummary, subAgents: SubAgent[], from: ProviderType, manual: boolean): Promise<string> {
    const api = (window as unknown as { promptops?: Record<string, unknown> }).promptops;
    let tail = '';
    try {
      const res = await this.sessionService.getSessionBuffer(session.id);
      if (res?.ok && res.data) tail = stripAnsi(res.data).slice(-HANDOFF_TAIL_CHARS);
    } catch { /* no buffer */ }
    let userMessages: string[] = [];
    let changedFiles = '';
    const getCtx = api?.['getSessionHandoffContext'] as
      | ((sessionId: string) => Promise<{ userMessages?: string[]; changedFiles?: string }>)
      | undefined;
    if (getCtx) {
      try {
        const c = await getCtx(session.id);
        userMessages = c?.userMessages ?? [];
        changedFiles = c?.changedFiles ?? '';
      } catch { /* best effort */ }
    }
    return formatMainHandoff({
      sessionName: session.name,
      fromLabel: this.label(from),
      manual,
      userMessages,
      changedFiles,
      subAgents: subAgents.map((sa) => ({ title: sa.title, prompt: sa.userPrompt })),
      tail,
    });
  }

  private async spawnFresh(parentSessionId: string, from: ProviderType, to: ProviderType): Promise<void> {
    const workspacePath = this.sessions().find((s) => s.id === parentSessionId)?.workspace?.path;
    const prompt = [
      `You are taking over from ${this.label(from)}, which just hit its usage limit in this workspace.`,
      'Run a quick `git status` / `git diff --stat` to see the current state, summarize it in 3 lines,',
      'then wait for instructions.',
    ].join(' ');
    try {
      await this.subAgents.spawnCustom(
        parentSessionId, 'assistant', `${this.label(to)} · takeover`, prompt, to,
        undefined, undefined, workspacePath, undefined, undefined, 'interactive',
      );
    } catch (err) {
      console.error('[ProviderLimit] takeover spawn failed', err);
    }
  }

  private handoffPrompt(sa: SubAgent, from: ProviderType, to: ProviderType, tail: string): string {
    const task = (sa.userPrompt ?? sa.autoPrompt ?? '').trim();
    const lines = [
      `# Handoff — continue the work of a ${this.label(from)} sub-agent that hit its usage limit`,
      `You are ${this.label(to)}, taking over the sub-agent "${sa.title}" (role: ${sa.role}) in the SAME workspace and terminal slot.`,
      'The previous agent may have left work half-done: check `git status` / `git diff` first and continue from the current state. Do not redo finished steps.',
      '',
      '## Original task',
      task || '(no prompt text available — infer the task from the terminal tail and the workspace state)',
    ];
    if (tail.trim()) {
      lines.push('', '## Last terminal output of the previous agent (shared context)', '```text', tail.trim(), '```');
    }
    lines.push('', 'Pick up exactly where it stopped.');
    return lines.join('\n');
  }

  // ── Lockouts (persisted) ─────────────────────────────────────────

  private setLockout(provider: ProviderType, ms: number, resets: string): void {
    const until = Date.now() + ms;
    const prev = this.lockouts[provider];
    this.lockouts[provider] = { until: Math.max(until, prev?.until ?? 0), resets: resets || prev?.resets || '' };
    try { localStorage.setItem(LOCKOUT_KEY, JSON.stringify(this.lockouts)); } catch { /* quota */ }
  }

  private readShownAt(): number {
    try { return Number(localStorage.getItem(SHOWN_KEY) ?? 0) || 0; } catch { return 0; }
  }

  private readLockouts(): Partial<Record<ProviderType, Lockout>> {
    try {
      const raw = JSON.parse(localStorage.getItem(LOCKOUT_KEY) ?? '{}') as Partial<Record<ProviderType, Lockout>>;
      const now = Date.now();
      for (const k of Object.keys(raw) as ProviderType[]) if (!raw[k] || raw[k]!.until <= now) delete raw[k];
      return raw;
    } catch { return {}; }
  }
}

export const PROVIDER_LABELS: Record<string, string> = {
  'claude-code-cli': 'Claude Code',
  'codex': 'Codex',
  'gemini-cli': 'Gemini CLI',
  'antigravity': 'Antigravity',
  'copilot': 'GitHub Copilot',
  'cursor': 'Cursor',
  'grok': 'Grok',
  'hermes': 'Hermes',
  'muse': 'Muse Code',
  'zai': 'Z.AI',
  'kimi': 'Kimi',
  'opencode': 'Opencode',
  'kora': 'Kora',
  'promptops-cli': 'PromptOps CLI',
  'generic-shell': 'Shell',
};

