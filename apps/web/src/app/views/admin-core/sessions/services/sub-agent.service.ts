import { agentOrderKeys, orderAgents, rememberAgentOrder } from './agent-display-order';
import { Injectable, inject, signal, computed, effect, untracked } from '@angular/core';
import { OrgPolicyService } from '@core/services/org-policy.service';
import { firstValueFrom, filter, take, timeout } from 'rxjs';
import { Store } from '@ngrx/store';
import { Actions, ofType } from '@ngrx/effects';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { SessionHistoryService } from './session-history.service';
import { SessionEventService } from './session-event.service';
import { SmartActionService, SmartActionResult } from './smart-action.service';
import { DesktopSessionApiService } from './desktop-session-api.service';
import { PtyDimsRegistry } from './pty-dims-registry.service';
import { ExtensionSelectionPayload } from './agent-inject.service';
import { SubAgentStashService } from './sub-agent-stash.service';
import { getActiveSession, getSessions } from '../../../../../store/sessions/session.selectors';
import { wakeSession, wakeSessionFailure, wakeSessionSuccess } from '../../../../../store/sessions/session.actions';
import { SessionSummary } from '../../../../../store/sessions/session.state';

/** localStorage key prefix for per-session benched sub-agent identities. */
import { BENCHED_SUB_AGENTS_KEY_PREFIX, LOCKED_SUB_AGENTS_KEY_PREFIX } from './sub-agent-bench-storage';

/**
 * `eco` is a composer-only pseudo-mode: it carries no config overrides of its
 * own and is translated to `clean` + an ECO level at spawn time (see
 * {@link SubAgentService.spawnCustom}), so the sub-agent alone runs in Eco.
 */
export type SubAgentMode = 'clean' | 'plan_only' | 'sprint' | 'architect' | 'detective' | 'refactor' | 'paranoid' | 'minimal' | 'eco';

export type ReasoningDepth = 'LOW' | 'MEDIUM' | 'HIGH' | 'MAX';
export type Verbosity = 'ZERO' | 'MINIMAL' | 'MEDIUM' | 'STRUCTURED';
export type Exploration = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME' | 'FOCUSED';
export type SpeedPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'MAX';
export type RiskTolerance = 'ZERO' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface SubAgentConfig {
  reasoning_depth: ReasoningDepth;
  verbosity: Verbosity;
  exploration: Exploration;
  speed_priority: SpeedPriority;
  risk_tolerance: RiskTolerance;
}

export interface ModePreset {
  mode: SubAgentMode;
  label: string;
  icon: string;
  config: SubAgentConfig;
}

/**
 * Soft skill forwarded on spawn: free-text behavioral instructions that ride
 * on top of the mode preamble (prompt-side, so they work on every provider
 * and on both the PTY and the worker runtime). Built-in modes are the
 * "preset" soft skills; this carries a user-written or catalog-derived one.
 */
export interface SoftSkillPayload {
  /** Stable id (`custom:<uuid>` | `catalog:<itemId>`) — display/dedupe only. */
  id?: string;
  name: string;
  instructions: string;
}

export const MODE_PRESETS: Record<SubAgentMode, ModePreset> = {
  clean:     { mode: 'clean',     label: 'Clean',     icon: '\u2728',       config: { reasoning_depth: 'MEDIUM', verbosity: 'MEDIUM',     exploration: 'MEDIUM',  speed_priority: 'MEDIUM', risk_tolerance: 'MEDIUM' } },
  plan_only: { mode: 'plan_only', label: 'Plan Only', icon: '\uD83D\uDCCB', config: { reasoning_depth: 'HIGH',   verbosity: 'STRUCTURED', exploration: 'HIGH',    speed_priority: 'LOW',    risk_tolerance: 'ZERO'   } },
  sprint:    { mode: 'sprint',    label: 'Sprint',    icon: '\u26A1', config: { reasoning_depth: 'LOW',    verbosity: 'MINIMAL',    exploration: 'NONE',    speed_priority: 'MAX',    risk_tolerance: 'MEDIUM' } },
  architect: { mode: 'architect', label: 'Architect', icon: '\uD83E\uDDE0', config: { reasoning_depth: 'MAX',    verbosity: 'STRUCTURED', exploration: 'HIGH',    speed_priority: 'LOW',    risk_tolerance: 'LOW'    } },
  detective: { mode: 'detective', label: 'Detective', icon: '\uD83D\uDC1B', config: { reasoning_depth: 'HIGH',   verbosity: 'MEDIUM',     exploration: 'FOCUSED',  speed_priority: 'LOW',    risk_tolerance: 'LOW'    } },
  refactor:  { mode: 'refactor',  label: 'Refactor',  icon: '\uD83D\uDEE0', config: { reasoning_depth: 'MEDIUM', verbosity: 'STRUCTURED', exploration: 'LOW',     speed_priority: 'MEDIUM', risk_tolerance: 'LOW'    } },
  paranoid:  { mode: 'paranoid',  label: 'Paranoid',  icon: '\uD83E\uDDEA', config: { reasoning_depth: 'HIGH',   verbosity: 'MEDIUM',     exploration: 'EXTREME',  speed_priority: 'LOW',    risk_tolerance: 'ZERO'   } },
  minimal:   { mode: 'minimal',   label: 'Minimal',   icon: '\uD83C\uDFAF', config: { reasoning_depth: 'LOW',    verbosity: 'ZERO',       exploration: 'NONE',     speed_priority: 'MAX',    risk_tolerance: 'MEDIUM' } },
  // Pseudo-mode: no config overrides (same as clean) \u2014 the ECO directive does the work.
  eco:       { mode: 'eco',       label: 'Eco',       icon: '\uD83C\uDF31', config: { reasoning_depth: 'MEDIUM', verbosity: 'MEDIUM',     exploration: 'MEDIUM',   speed_priority: 'MEDIUM', risk_tolerance: 'MEDIUM' } },
};

export interface SubAgentSuggestion {
  id: string;
  role: string;
  title: string;
  description: string;
  incentive: string;
  autoPrompt: string;
  relevanceScore: number;
  icon: string;
  category: 'quality' | 'speed' | 'safety';
  parentSessionId: string;
  mode?: SubAgentMode;
}

export type SubAgentStatus = 'spawning' | 'running' | 'in_progress' | 'idle' | 'waiting_input' | 'completed' | 'error' | 'exited';

export type SubAgentProvider = 'claude-code-cli' | 'codex' | 'gemini-cli' | 'antigravity' | 'copilot' | 'cursor' | 'grok' | 'hermes' | 'muse' | 'zai' | 'kimi' | 'opencode' | 'kora' | 'promptops-cli' | 'generic-shell';

export interface SubAgent {
  id: string;
  role: string;
  title: string;
  parentSessionId: string;
  sessionId: string;
  status: SubAgentStatus;
  autoPrompt: string;
  /** The original user-typed prompt, without mode preamble injection. */
  userPrompt?: string;
  provider: SubAgentProvider;
  icon: string;
  createdAt?: string;
  mode?: SubAgentMode;
  config?: SubAgentConfig;
  /** Soft skill the agent was spawned with (see {@link SoftSkillPayload}). */
  softSkill?: SoftSkillPayload;
  /** 'worker' = headless turn loop rendered as a chat; default PTY otherwise. */
  executionMode?: 'interactive' | 'worker';
  /** True when the worker runs under the autonomous goal loop ("Goal" runtime). */
  goalDriven?: boolean;
  /**
   * Model the CLI was launched with (spawn picker). Absent = provider default.
   * It is only the STARTING model: `/model` inside the TUI changes the real one,
   * which SessionModelService resolves from the provider's own session log.
   */
  model?: string;
  effort?: string;
  /**
   * True from spawn until the auto-prompt is actually submitted to the TUI (or
   * handed to the user when deferred). Drives the terminal's black boot overlay.
   */
  promptPending?: boolean;
}

/**
 * An archived sub-agent entry (from a previously completed/destroyed session).
 * Contains all metadata needed to identify and resume the sub-agent.
 */
export interface ArchivedSubAgentEntry {
  index: number;
  /** Stable ID assigned at archive time — preferred over index for clear/resume. */
  archiveId?: string;
  role: string;
  title: string;
  userPrompt: string;
  icon: string;
  mode?: SubAgentMode;
  config?: SubAgentConfig;
  softSkill?: SoftSkillPayload;
  provider: SubAgentProvider;
  claudeSessionId?: string;
  archivedAt: string;
  parentSessionId: string;
  parentSessionName?: string;
  workspacePath?: string;
  canResume: boolean;
  /** Which store the entry came from in the hybrid merge. */
  source?: 'ipc' | 'stored';
}

/** Stable dedup key for archive entries: archiveId → claudeSessionId → identity fields. */
export function archivedEntryKey(e: ArchivedSubAgentEntry): string {
  return e.archiveId
    ?? e.claudeSessionId
    ?? `${e.role}|${e.title}|${e.workspacePath ?? e.parentSessionName ?? ''}`;
}

/**
 * Merge local store (historic, survives restarts) and desktop IPC (fresh, current
 * run) archive entries. On key collision the IPC entry wins: its
 * parentSessionId/index are the live ones the desktop clear/resume APIs
 * understand, and it still carries the local-only userPrompt.
 */
export function mergeArchivedEntries(
  stored: ArchivedSubAgentEntry[],
  ipc: ArchivedSubAgentEntry[],
): ArchivedSubAgentEntry[] {
  const byKey = new Map<string, ArchivedSubAgentEntry>();
  for (const e of stored) byKey.set(archivedEntryKey(e), { ...e, source: 'stored' });
  for (const e of ipc) byKey.set(archivedEntryKey(e), { ...e, source: 'ipc' });
  return [...byKey.values()].sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

/**
 * Angular service for sub-agent management.
 * Wraps the desktop bridge API (window.promptops) and maintains reactive state.
 *
 * The user communicates only through the main session.
 * Sub-agents are visible as additional terminal panes within the session.
 */
@Injectable({ providedIn: 'root' })
export class SubAgentService {
  private orgPolicy = inject(OrgPolicyService);
  private historyService = inject(SessionHistoryService);
  private eventService = inject(SessionEventService);
  private store = inject(Store);
  private desktopSessionApi = inject(DesktopSessionApiService);
  private smartActionService = inject(SmartActionService);
  private modalService = inject(NgbModal);
  private dimsRegistry = inject(PtyDimsRegistry);
  private subAgentStash = inject(SubAgentStashService);
  private actions$ = inject(Actions, { optional: true });

  private get api(): any {
    return (window as any).promptops;
  }

  get isDesktop(): boolean {
    return !!this.api;
  }

  /** True in the Tauri v2 desktop app (the bridge exposes `promptops` anyway). */
  get isTauri(): boolean {
    return !!(window as any).__TAURI__;
  }

  // ── Reactive state ─────────────────────────────────────────────

  /** Suggestions for the active session */
  suggestions = signal<SubAgentSuggestion[]>([]);

  /** Active sub-agents for the active session */
  activeSubAgents = signal<SubAgent[]>([]);

  /** Max sub-agents allowed on the bench (panchinari) — they stay active. */
  readonly MAX_BENCH = 5;

  /**
   * Stable identities of the sub-agents on the bench.
   *
   * NOT the runtime ids: those are regenerated on every app restart (and on
   * every restore from the parked stash), so an id-keyed bench silently lost
   * every panchinaro across a relaunch — the agent came back in the active
   * roster instead. Same convention as the stash dedupe: role|title.
   */
  benchedKeys = signal<string[]>([]);

  /** Stable bench identity of a sub-agent (survives restarts and re-spawns). */
  private benchKeyOf(sa: Pick<SubAgent, 'role' | 'title'>): string {
    return `${sa.role}|${sa.title}`;
  }

  /** Resolve a runtime id to its stable bench key, if the agent is known. */
  private benchKeyForId(subAgentId: string): string | null {
    const sa = this.activeSubAgents().find((s) => s.id === subAgentId)
      ?? this.allSubAgents().find((s) => s.id === subAgentId);
    return sa ? this.benchKeyOf(sa) : null;
  }

  /** Active roster = active sub-agents currently NOT on the bench. */
  activeRoster = computed(() =>
    this.activeSubAgentsBySlot().filter((sa) => !this.benchedKeys().includes(this.benchKeyOf(sa)))
  );

  /** Benched sub-agents (panchinari) — active sub-agents parked on the bench. */
  benchedSubAgents = computed(() =>
    this.activeSubAgentsBySlot().filter((sa) => this.benchedKeys().includes(this.benchKeyOf(sa)))
  );

  /** True when the bench has reached MAX_BENCH. */
  benchFull = computed(() => this.benchedSubAgents().length >= this.MAX_BENCH);

  isBenched(subAgentId: string): boolean {
    const key = this.benchKeyForId(subAgentId);
    return !!key && this.benchedKeys().includes(key);
  }

  /** Send a sub-agent to the bench (stays active). No-op if full or already benched. */
  bench(subAgentId: string): void {
    const key = this.benchKeyForId(subAgentId);
    if (!key || this.benchedKeys().includes(key) || this.benchFull()) return;
    this.benchedKeys.update((keys) => [...keys, key]);
    this.persistBenched();
  }

  /**
   * Bring a sub-agent back from the bench into the active roster.
   * Accepts the runtime id; falls back to a known identity when the agent has
   * already been dropped from the lists (destroy path).
   */
  unbench(subAgentId: string, identity?: Pick<SubAgent, 'role' | 'title'>): void {
    const key = this.benchKeyForId(subAgentId) ?? (identity ? this.benchKeyOf(identity) : null);
    if (!key) return;
    this.benchedKeys.update((keys) => keys.filter((k) => k !== key));
    this.persistBenched();
  }

  /**
   * Bench request from the PromptOps MCP (`ctl:agent-bench`). Keyed by
   * role|title from the event, so it works before `subagent:created` lands
   * and for a session that is not on screen (its bench lives in storage).
   */
  applyCtlBench(request: { parentSessionId: string; role: string; title: string; benched: boolean }): void {
    const key = this.benchKeyOf(request);
    if (request.parentSessionId === this.currentParentId()) {
      const keys = this.benchedKeys();
      if (request.benched === keys.includes(key)) return;
      if (request.benched && keys.length >= this.MAX_BENCH) return;
      this.benchedKeys.set(request.benched ? [...keys, key] : keys.filter((k) => k !== key));
      this.persistBenched();
      return;
    }
    const keys = this.loadBenchedKeys(request.parentSessionId);
    if (request.benched === keys.includes(key)) return;
    if (request.benched && keys.length >= this.MAX_BENCH) return;
    const next = request.benched ? [...keys, key] : keys.filter((k) => k !== key);
    const [preferred] = this.benchCandidateKeys(request.parentSessionId);
    try {
      if (next.length === 0) localStorage.removeItem(preferred);
      else localStorage.setItem(preferred, JSON.stringify(next));
    } catch {
      /* localStorage full/unavailable — non-fatal */
    }
  }

  /**
   * Storage keys a session's bench may live under, most stable first.
   * The stored id survives restarts and renames; the local desktop id does
   * not, so it is only a fallback for never-synced sessions. The session NAME
   * is deliberately not a key: it is not an identity, and a new session that
   * reuses a deleted one's name must not inherit its bench.
   */
  private benchCandidateKeys(parentSessionId: string): string[] {
    const keys: string[] = [];
    const session = this.getActiveSessionSnapshot();
    if (session && session.id === parentSessionId && session.dbId) {
      keys.push(BENCHED_SUB_AGENTS_KEY_PREFIX + session.dbId);
    }
    keys.push(BENCHED_SUB_AGENTS_KEY_PREFIX + parentSessionId);
    return [...new Set(keys)];
  }

  /** Load the persisted bench identities for a session from localStorage. */
  private loadBenchedKeys(parentSessionId: string): string[] {
    for (const key of this.benchCandidateKeys(parentSessionId)) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) continue;
        // Legacy envelopes held runtime ids (no '|'): they can never match
        // again, so treat them as an empty bench and let the next persist
        // rewrite the entry in the stable format.
        const keys = arr.filter((v: unknown) => typeof v === 'string' && v.includes('|'));
        if (keys.length > 0) return keys as string[];
      } catch {
        /* corrupt entry — fall through to the next candidate */
      }
    }
    return [];
  }

  /**
   * Persist the current bench against the active parent session, if any.
   * Writes under the most stable key available and retires the others so a
   * stale copy can never resurrect a bench the user already emptied.
   */
  private persistBenched(): void {
    const parentSessionId = this.currentParentId();
    if (!parentSessionId) return;
    const [preferred, ...legacy] = this.benchCandidateKeys(parentSessionId);
    try {
      const keys = this.benchedKeys();
      if (keys.length === 0) localStorage.removeItem(preferred);
      else localStorage.setItem(preferred, JSON.stringify(keys));
      for (const key of legacy) localStorage.removeItem(key);
    } catch {
      /* localStorage full/unavailable — non-fatal */
    }
  }

  // ── Lock: agents protected from closing ──────────────────────────────
  /**
   * Stable identities (role|title) of locked agents, same convention
   * as the bench: runtime ids change on every restart/restore, the
   * identities don't. The registry lives HERE and not in the view so every way
   * of closing (pane header, Action Center, panel) goes through the same
   * guard in {@link destroy}: before, the lock was only in the session-view and
   * the Action Center's "Terminate" ignored it.
   */
  lockedKeys = signal<string[]>([]);

  /**
   * The lead/main pane of the flat roster is not a sub-agent (it isn't in
   * `activeSubAgents`): it has a fixed id and a fixed lock identity, which
   * survives session renames and the role naming difference
   * (`main` / `lead`).
   */
  static readonly MAIN_PANE_ID = '__main__';
  static readonly MAIN_LOCK_KEY = 'main|__main__';

  /** Lock identity of a pane (sub-agent or lead). */
  lockKeyOf(sa: Pick<SubAgent, 'id' | 'role' | 'title'>): string {
    if (sa.id === SubAgentService.MAIN_PANE_ID) return SubAgentService.MAIN_LOCK_KEY;
    return `${sa.role}|${sa.title}`;
  }

  private lockKeyForId(subAgentId: string): string | null {
    if (subAgentId === SubAgentService.MAIN_PANE_ID) return SubAgentService.MAIN_LOCK_KEY;
    const sa = this.activeSubAgents().find((s) => s.id === subAgentId)
      ?? this.allSubAgents().find((s) => s.id === subAgentId);
    return sa ? this.lockKeyOf(sa) : null;
  }

  /**
   * View by id (the one used by templates): active ids whose identity is locked,
   * plus `__main__` when the lead is locked.
   */
  lockedIds = computed<Set<string>>(() => {
    const keys = this.lockedKeys();
    const set = new Set<string>();
    if (keys.length === 0) return set;
    if (keys.includes(SubAgentService.MAIN_LOCK_KEY)) set.add(SubAgentService.MAIN_PANE_ID);
    for (const sa of this.activeSubAgents()) {
      if (keys.includes(this.lockKeyOf(sa))) set.add(sa.id);
    }
    return set;
  });

  isLocked(subAgentId: string): boolean {
    const key = this.lockKeyForId(subAgentId);
    return !!key && this.lockedKeys().includes(key);
  }

  /** Lock/unlock a pane by runtime id (sub-agent or `__main__`). */
  toggleLock(subAgentId: string): void {
    const key = this.lockKeyForId(subAgentId);
    if (!key) return;
    this.lockedKeys.update((keys) => keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]);
    this.persistLocked();
  }

  /**
   * localStorage keys under which a session's lock can live, from the
   * most stable: the stored id (`dbId`) survives restarts and renames,
   * the local id doesn't and is only the fallback for never-synced sessions.
   * Explicit `dbId` to query a NON-active session (delete from the sidebar).
   */
  private lockCandidateKeys(parentSessionId: string, dbId?: string | null): string[] {
    const keys: string[] = [];
    const session = this.getActiveSessionSnapshot();
    const stable = dbId ?? (session && session.id === parentSessionId ? session.dbId : null);
    if (stable) keys.push(LOCKED_SUB_AGENTS_KEY_PREFIX + stable);
    keys.push(LOCKED_SUB_AGENTS_KEY_PREFIX + parentSessionId);
    return [...new Set(keys)];
  }

  /** Persisted locked identities of a session. Legacy entries (runtime id, without '|') are ignored. */
  loadLockedKeys(parentSessionId: string, dbId?: string | null): string[] {
    for (const key of this.lockCandidateKeys(parentSessionId, dbId)) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) continue;
        const keys = arr.filter((v: unknown): v is string => typeof v === 'string' && v.includes('|'));
        if (keys.length > 0) return keys;
      } catch {
        /* corrupted entry — move on to the next candidate */
      }
    }
    return [];
  }

  /** Writes under the most stable key and retires the others (no stale copies). */
  private persistLocked(): void {
    const parentSessionId = this.currentParentId();
    if (!parentSessionId) return;
    const [preferred, ...legacy] = this.lockCandidateKeys(parentSessionId);
    try {
      const keys = this.lockedKeys();
      if (keys.length === 0) localStorage.removeItem(preferred);
      else localStorage.setItem(preferred, JSON.stringify(keys));
      for (const key of legacy) localStorage.removeItem(key);
    } catch {
      /* localStorage full/unavailable — non-fatal */
    }
  }

  /** All known sub-agent session IDs (persists across session switches) */
  allSubAgentSessionIds = signal<Set<string>>(new Set());

  /** All known sub-agents across all sessions (persists across session switches) */
  allSubAgents = signal<SubAgent[]>([]);

  /** ID of the last spawned sub-agent (used for auto-focus) */
  lastSpawnedId = signal<string | null>(null);

  /** Per-session display order: runtime IDs from the API or stable identities from the local cache. */
  private customOrder = signal<string[]>([]);
  private orderCache = new Map<string, string[]>();
  private orderWrites = new Map<string, Promise<void>>();
  private orderReady = signal(false);

  private orderStorageKeys(parentSessionId: string): string[] {
    return this.benchCandidateKeys(parentSessionId).map(key =>
      key.replace(BENCHED_SUB_AGENTS_KEY_PREFIX, 'promptops_agent_order_v1_'));
  }

  private readAgentOrder(parentSessionId: string): string[] | null {
    for (const key of this.orderStorageKeys(parentSessionId)) {
      const cached = this.orderCache.get(key);
      if (cached) return cached;
      try {
        const value = JSON.parse(localStorage.getItem(key) ?? 'null');
        if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value;
      } catch { /* A corrupt cache must not prevent loading the session. */ }
    }
    return null;
  }

  private rememberOrder(parentSessionId: string, order: string[]): void {
    const agents = [...new Map([...this.allSubAgents(), ...this.activeSubAgents()]
      .filter(agent => agent.parentSessionId === parentSessionId).map(agent => [agent.id, agent])).values()];
    const stable = rememberAgentOrder(agents, order);
    const serialized = JSON.stringify(stable);
    for (const key of this.orderStorageKeys(parentSessionId)) {
      if (JSON.stringify(this.orderCache.get(key)) === serialized) continue;
      this.orderCache.set(key, stable);
      try { localStorage.setItem(key, serialized); } catch { /* Keep memory fallback. */ }
    }
  }

  /**
   * Removes a closed agent from the saved order. The stable key is
   * role|title: without pruning a new agent with the same title (e.g. the
   * "Terminal" terminals) inherited the position of the closed one, often the first.
   */
  private forgetOrder(subAgentId: string, identity?: Pick<SubAgent, 'role' | 'title' | 'parentSessionId' | 'createdAt'>): void {
    // Only the closed agent's own key: its twins (same role and title) keep theirs.
    let key: string | undefined;
    if (identity) {
      const siblings = [...new Map([...this.allSubAgents(), ...this.activeSubAgents()]
        .filter(agent => agent.parentSessionId === identity.parentSessionId && agent.id !== subAgentId)
        .map(agent => [agent.id, agent])).values()];
      key = agentOrderKeys([...siblings, { ...identity, id: subAgentId }]).get(subAgentId);
    }
    const drop = new Set([subAgentId, ...(key ? [key] : [])]);
    const order = this.customOrder();
    if (order.some(key => drop.has(key))) this.customOrder.set(order.filter(key => !drop.has(key)));
  }

  // Remember the displayed order, including agents opened without a manual drag.
  private rememberVisibleOrder = effect(() => {
    const parent = this.currentParentId();
    const ready = this.orderReady();
    const agents = this.activeSubAgents();
    const order = this.customOrder();
    if (!parent || !ready || agents.length === 0) return;
    untracked(() => {
      this.rememberOrder(parent, order);
      const stable = this.readAgentOrder(parent) ?? order;
      if (JSON.stringify(stable) !== JSON.stringify(order)) this.customOrder.set(stable);
    });
  });

  /** Loading state */
  loading = signal(false);

  /** The session ID we're currently tracking */
  private currentParentId = signal<string | null>(null);

  /** Category ID for saving sub-agent prompts */
  currentCategoryId = signal<number | null>(null);

  /**
   * When true, the next trackSession() call will skip desktop IPC for sub-agents
   * because they've already been populated from the stored state snapshot.
   */
  private restoredFromStore = false;

  /**
   * True while the pre-subagent execution guard is running detection.
   * UI can bind to this to show "Analyzing best execution..." on buttons.
   */
  analyzing = signal(false);

  /** Quick computed for UI */
  hasActiveSubAgents = computed(() => this.activeSubAgents().length > 0);
  subAgentCount = computed(() => this.activeSubAgents().length);

  /**
   * Active sub-agents annotated with a 1-based `slot`, used by
   * voice-command-router.service.ts to resolve "focus sub-agent N" → subAgentId.
   * The badge in the UI MUST reflect this order.
   *
   * - If `customOrder` is empty → fallback to createdAt ASC (matches the
   *   native FocusTracker order).
   * - Otherwise → customOrder IDs first (skipping any that no longer exist),
   *   then remaining agents appended by createdAt ASC.
   */
  activeSubAgentsBySlot = computed(() =>
    orderAgents(this.activeSubAgents(), this.customOrder())
      .map((sa, idx) => ({ ...sa, slot: idx + 1 }))
  );

  /**
   * The sub-agent currently focused via voice. Cleared when:
   *  - the user opens the main terminal via voice ("focus terminale")
   *  - the active session changes
   *  - the focused sub-agent is destroyed
   */
  voiceFocusedSubAgentId = signal<string | null>(null);

  setVoiceFocus(subAgentId: string | null): void {
    this.voiceFocusedSubAgentId.set(subAgentId);
  }

  private cleanupFns: Array<() => void> = [];

  /**
   * Initialize listeners for push events from the desktop app.
   * Call once on app startup.
   */
  initListeners(): void {
    if (!this.isDesktop) return;

    this.cleanupFns.push(
      this.api.onSubAgentCreated((_event: unknown, data: { subAgent: SubAgent; parentSessionId: string }) => {
        // Track this sub-agent globally
        if (data.subAgent?.sessionId) {
          this.allSubAgentSessionIds.update(ids => new Set([...ids, data.subAgent.sessionId]));
          this.allSubAgents.update(list => {
            const filtered = list.filter(sa => {
              if (sa.id === data.subAgent.id) return false;
              // Same parent + role + title = same logical agent: sub-agent ids are
              // regenerated on every (re)spawn, so a copy restored from a stored
              // snapshot carries a stale id that would otherwise live on forever.
              if (sa.parentSessionId === data.parentSessionId && sa.role === data.subAgent.role && sa.title === data.subAgent.title) return false;
              return true;
            });
            return [...filtered, data.subAgent];
          });
        }
        // Accept if we're tracking this parent, or accept all if no parent set
        const parentMatch = !this.currentParentId() || data.parentSessionId === this.currentParentId();
        if (parentMatch) {
          this.activeSubAgents.update((list) => {
            // Replace by exact ID, or reconcile placeholder IDs created at restore (prefix 'backend-')
            // that cause black terminals: the terminal subscribes by subAgentId, so the ID
            // must match what the desktop sub-agent manager uses for output forwarding
            const filtered = list.filter(sa => {
              if (sa.id === data.subAgent.id) return false;
              if (sa.id.startsWith('backend-') && sa.role === data.subAgent.role && sa.title === data.subAgent.title) return false;
              return true;
            });
            return [...filtered, data.subAgent];
          });
        }
        // Log spawn event in session history + structured timeline, signal for auto-focus
        if (data.subAgent) {
          this.historyService.logSpawn(data.subAgent.title, data.subAgent.autoPrompt ?? '');
          this.eventService.recordSpawn(
            data.subAgent.id,
            data.subAgent.title,
            data.subAgent.autoPrompt ?? '',
            data.subAgent.mode,
          );
          this.lastSpawnedId.set(data.subAgent.id);
        }
      }),
    );

    this.cleanupFns.push(
      this.api.onSubAgentStatus((_event: unknown, data: { subAgentId: string; parentSessionId: string; status: string; promptPending?: boolean }) => {
        const updateStatus = (list: SubAgent[]) =>
          list.map((sa) => sa.id === data.subAgentId
            ? { ...sa, status: data.status as SubAgentStatus, promptPending: data.promptPending ?? false }
            : sa);
        this.activeSubAgents.update(updateStatus);
        this.allSubAgents.update(updateStatus);
        // Record status change in structured timeline
        const sa = this.activeSubAgents().find(a => a.id === data.subAgentId)
          ?? this.allSubAgents().find(a => a.id === data.subAgentId);
        if (sa) {
          this.eventService.recordStatus(data.subAgentId, sa.title, data.status);
          if (data.status === 'error') {
            this.eventService.recordError(data.subAgentId, sa.title, `Agent "${sa.title}" entered error state`);
          }
        }
      }),
    );

    // In-place provider switch (Tauri): merge the refreshed meta by id.
    if (this.api.onSubAgentUpdated) {
      this.cleanupFns.push(
        this.api.onSubAgentUpdated((_event: unknown, data: { subAgent: SubAgent; parentSessionId: string }) => {
          const merge = (list: SubAgent[]) =>
            list.map((sa) => sa.id === data.subAgent.id ? { ...sa, ...data.subAgent } : sa);
          this.activeSubAgents.update(merge);
          this.allSubAgents.update(merge);
        }),
      );
    }

    this.cleanupFns.push(
      this.api.onSubAgentDestroyed((_event: unknown, data: { subAgentId: string; parentSessionId: string }) => {
        // Log merge event before removing from lists
        const sa = this.activeSubAgents().find((a) => a.id === data.subAgentId)
          ?? this.allSubAgents().find((a) => a.id === data.subAgentId);
        if (sa) {
          this.historyService.logMerge(sa.title);
          this.eventService.recordMerge(data.subAgentId, sa.title);
        }
        this.activeSubAgents.update((list) => list.filter((sa) => sa.id !== data.subAgentId));
        this.allSubAgents.update((list) => list.filter((sa) => sa.id !== data.subAgentId));
        // Keep the bench (and its localStorage copy) free of destroyed agents.
        // `sa` is captured above: the lists no longer hold the identity here.
        // Bench and order belong to the tracked session: an agent closed in
        // another session must not touch them (a same-titled agent here
        // would lose its bench or its place).
        if (!this.currentParentId() || data.parentSessionId === this.currentParentId()) {
          this.unbench(data.subAgentId, sa ?? undefined);
          this.forgetOrder(data.subAgentId, sa ?? undefined);
        }
        // Drop the remembered PTY grid — the PTY is gone with the agent.
        this.dimsRegistry.remove(`sa:${data.subAgentId}`);
      }),
    );
  }

  /**
   * Clean up listeners.
   */
  destroyListeners(): void {
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
  }

  /**
   * Scan all sessions to discover sub-agent session IDs.
   * Call at startup so the sidebar can filter them out immediately.
   */
  async discoverAllSubAgents(sessionIds: string[]): Promise<void> {
    if (!this.isDesktop) return;
    const allIds = new Set<string>();
    const allAgents: SubAgent[] = [];
    if (this.api?.listAllSubAgents) {
      // Tauri: one IPC for every parent instead of one per session.
      try {
        const result = await this.api.listAllSubAgents();
        if (result.ok && result.subAgents) {
          for (const sa of result.subAgents) {
            if (sa.sessionId) allIds.add(sa.sessionId);
            allAgents.push(sa);
          }
        }
      } catch { /* ignore */ }
    } else {
      await Promise.all(
        sessionIds.map(async (parentId) => {
          try {
            const result = await this.api.listSubAgents(parentId);
            if (result.ok && result.subAgents) {
              for (const sa of result.subAgents) {
                if (sa.sessionId) allIds.add(sa.sessionId);
                allAgents.push(sa);
              }
            }
          } catch { /* ignore */ }
        }),
      );
    }
    if (allIds.size) {
      this.allSubAgentSessionIds.update(ids => new Set([...ids, ...allIds]));
    }
    if (allAgents.length) {
      this.allSubAgents.update(existing => {
        const existingIds = new Set(existing.map(sa => sa.id));
        return [...existing, ...allAgents.filter(sa => !existingIds.has(sa.id))];
      });
    }
  }

  // ── Local store restore ─────────────────────────────────────────────

  /**
   * Populate active sub-agents from stored state snapshot data.
   * Called during hot-reload restore BEFORE trackSession fires.
   * Sets the restoredFromStore flag so trackSession skips the IPC
   * listSubAgents call (desktop IPC may return stale/wrong data).
   */
  populateFromStore(
    backendAgents: any[],
    parentSessionId: string,
    subAgentsOrder?: string[] | null,
  ): void {
    if (!backendAgents || backendAgents.length === 0) return;

    const mapped: SubAgent[] = backendAgents.map((a: any) => ({
      id: a.id ?? `backend-${a.role}`,
      role: a.role ?? 'custom',
      title: a.title ?? 'Untitled',
      parentSessionId: a.parentSessionId ?? parentSessionId,
      sessionId: a.sessionId ?? '',
      status: (a.status ?? 'running') as SubAgentStatus,
      autoPrompt: a.autoPrompt ?? a.prompt ?? '',
      userPrompt: a.userPrompt ?? a.user_prompt ?? '',
      provider: (a.provider ?? 'claude-code-cli') as SubAgentProvider,
      icon: a.icon ?? 'solar:cpu-bolt-bold-duotone',
      createdAt: a.createdAt ?? a.created_at ?? new Date().toISOString(),
      mode: a.mode,
      config: a.config,
    }));

    this.activeSubAgents.set(mapped);
    // NOTE: do NOT set currentParentId here — trackSession needs to see
    // a different value so it doesn't early-return before checking the flag.

    // Register session IDs globally
    const newIds = mapped.map(sa => sa.sessionId).filter(id => !!id);
    if (newIds.length) {
      this.allSubAgentSessionIds.update(ids => new Set([...ids, ...newIds]));
    }
    this.allSubAgents.update(existing => {
      const existingIds = new Set(existing.map(sa => sa.id));
      return [...existing, ...mapped.filter(sa => !existingIds.has(sa.id))];
    });

    this.restoredFromStore = true;

    const order = this.readAgentOrder(parentSessionId) ?? subAgentsOrder ?? [];
    this.customOrder.set(order);
    // An incomplete snapshot must not mask an order still being loaded from the API.
    if (order.length > 0) this.rememberOrder(parentSessionId, order);
  }

  // ── Session tracking ───────────────────────────────────────────

  /**
   * Switch to tracking a different parent session.
   * Loads suggestions and active sub-agents for the new session.
   *
   * ALWAYS queries desktop IPC for sub-agents (the source of truth for IDs).
   * Local store data from populateFromStore() is kept as initial display but gets
   * reconciled with the desktop's live data to ensure IDs match for terminal output.
   */
  async trackSession(parentSessionId: string, workspacePath?: string, categoryId?: number | null): Promise<void> {
    if (parentSessionId === this.currentParentId()) {
      // Always update workspace path even on re-track (guard needs it)
      if (workspacePath) this.currentWorkspacePath.set(workspacePath);
      return;
    }

    const previousParent = this.currentParentId();
    if (previousParent && this.orderReady()) this.rememberOrder(previousParent, this.customOrder());
    this.orderReady.set(false);
    this.currentParentId.set(parentSessionId);
    this.customOrder.set(this.readAgentOrder(parentSessionId) ?? []);
    // Restore this session's bench from localStorage; also replaces the previous
    // session's bench so the panchina stays isolated per session.
    this.benchedKeys.set(this.loadBenchedKeys(parentSessionId));
    // Same isolation for locks: those of the previous session disappear.
    this.lockedKeys.set(this.loadLockedKeys(parentSessionId));
    this.currentCategoryId.set(categoryId ?? null);
    this.currentWorkspacePath.set(workspacePath);
    this.suggestions.set([]);

    // Link the event service to this session's DB ID for structured timeline
    this.eventService.setSession(parentSessionId);

    // If restored from local store, keep sub-agents as initial display but
    // ALWAYS reconcile with desktop IPC to get correct live IDs.
    // Without this, terminal output subscriptions use wrong IDs → black terminals.
    const hadStoredData = this.restoredFromStore;
    if (this.restoredFromStore) {
      this.restoredFromStore = false;
    }

    // IDs seeded from the cross-session cache: the post-IPC branches use them
    // to tell cache entries apart from agents spawned while the round-trip
    // below was still in flight (those carry fresh ids and must survive).
    let seededIds: string[] = [];

    if (!hadStoredData) {
      // Seed synchronously from the global cache instead of blanking the list:
      // the sub-agent panes (and the cover-main takeover in session-view) must
      // render in the same change-detection cycle as the switch. The cache is
      // kept fresh by the created/status/destroyed push events, so it is the
      // best known truth until the desktop answers below.
      const seeded = this.allSubAgents().filter(sa => sa.parentSessionId === parentSessionId);
      seededIds = seeded.map(sa => sa.id);
      this.activeSubAgents.set(seeded);
    } else {
      // Defensive: local store data may belong to a previously tracked session.
      // Keep only agents whose parentSessionId matches the session we're
      // switching to, so stale entries from the previous parent don't leak.
      this.activeSubAgents.update(list => list.filter(sa => sa.parentSessionId === parentSessionId));
    }

    if (!this.isDesktop) {
      this.orderReady.set(true);
      return;
    }

    this.loading.set(true);

    try {
      // Load suggestions, active sub-agents, and session order in parallel
      const [suggestionsResult, subAgentsResult, sessionSummary] = await Promise.all([
        this.api.getSubAgentSuggestions(parentSessionId, workspacePath),
        this.api.listSubAgents(parentSessionId),
        firstValueFrom(this.desktopSessionApi.show(parentSessionId)).catch(() => null),
      ]);

      // Bail if the user switched again while we awaited: applying this stale
      // response would clobber the state seeded/loaded for the newer session.
      // (scheduleReconciliation applies the same guard on every retry.)
      if (this.currentParentId() !== parentSessionId) return;

      if (suggestionsResult.ok) {
        this.suggestions.set(suggestionsResult.suggestions);
      }
      if (subAgentsResult.ok && subAgentsResult.subAgents.length > 0) {
        // Replace local store data with the desktop's live data (correct IDs)
        this.activeSubAgents.set(subAgentsResult.subAgents);
        // Register all sub-agent session IDs globally
        const newIds = subAgentsResult.subAgents
          .map((sa: SubAgent) => sa.sessionId)
          .filter((id: string) => !!id);
        if (newIds.length) {
          this.allSubAgentSessionIds.update(ids => new Set([...ids, ...newIds]));
        }
        this.allSubAgents.update(existing => {
          // The desktop is the source of truth for this parent: drop every prior
          // entry of the session (stale snapshot ids included), not just id matches.
          const filtered = existing.filter(sa => sa.parentSessionId !== parentSessionId);
          return [...filtered, ...subAgentsResult.subAgents];
        });
      } else if (subAgentsResult.ok && !hadStoredData && seededIds.length > 0) {
        // The desktop authoritatively reports zero live agents for this parent:
        // the seed was stale (e.g. leftover snapshot/placeholder entries).
        // Surgically drop ONLY the seeded ids — agents spawned while the
        // round-trip was in flight carry fresh ids and are kept.
        this.activeSubAgents.update(list => list.filter(sa => !seededIds.includes(sa.id)));
        this.allSubAgents.update(list => list.filter(sa => !seededIds.includes(sa.id)));
      } else if (hadStoredData && this.activeSubAgents().length > 0) {
        // The desktop returned empty but we have local store data — sub-agents may
        // still be spawning. Schedule a retry to reconcile once they're ready.
        this.scheduleReconciliation(parentSessionId, workspacePath);
      }

      // Prefer this device's latest order; the HTTP response may predate a drag.
      const order = this.readAgentOrder(parentSessionId) ?? sessionSummary?.subAgentsOrder ?? [];
      this.customOrder.set(order);
    } catch (err) {
      // If we had local store data (or showed a cache seed) and IPC failed,
      // schedule retries so the display converges with the desktop's truth.
      if (hadStoredData || seededIds.length > 0) {
        this.scheduleReconciliation(parentSessionId, workspacePath);
      }
    } finally {
      if (this.currentParentId() === parentSessionId) {
        this.orderReady.set(true);
        this.loading.set(false);
      }
    }
  }

  /**
   * Retry listSubAgents after a delay to reconcile local store data with the desktop.
   * Sub-agents may still be spawning after app restart/update.
   */
  private scheduleReconciliation(parentSessionId: string, _workspacePath?: string): void {
    const retryDelays = [3000, 8000, 15000]; // 3s, 8s, 15s
    for (const delay of retryDelays) {
      setTimeout(async () => {
        // Bail if user switched to a different session
        if (this.currentParentId() !== parentSessionId) return;

        try {
          const result = await this.api.listSubAgents(parentSessionId);
          if (result.ok && result.subAgents.length > 0) {
            this.activeSubAgents.set(result.subAgents);
            const newIds = result.subAgents.map((sa: SubAgent) => sa.sessionId).filter((id: string) => !!id);
            if (newIds.length) {
              this.allSubAgentSessionIds.update(ids => new Set([...ids, ...newIds]));
            }
            this.allSubAgents.update(existing => {
              // Same rule as trackSession: the desktop list replaces ALL entries
              // for this parent so stale snapshot ids can't duplicate the sidebar.
              const filtered = existing.filter((sa: SubAgent) => sa.parentSessionId !== parentSessionId);
              return [...filtered, ...result.subAgents];
            });
          }
        } catch { /* retry silently */ }
      }, delay);
    }
  }

  // ── Pre-Subagent Execution Guard ────────────────────────────────

  /** Workspace path for the current session (set externally by trackSession). */
  private currentWorkspacePath = signal<string | undefined>(undefined);

  /**
   * Read-only view of the current session's workspace path. The sub-agent
   * terminal needs it to upload a pasted image into the session assets: it has
   * no workspace @Input of its own, and the value is already tracked here.
   */
  readonly workspacePath = this.currentWorkspacePath.asReadonly();

  /**
   * Pre-Subagent Smart Execution Guard.
   *
   * Runs a fast check (<2s) to detect if the prompt can be executed via terminal
   * instead of using AI. If yes, shows a modal to let the user choose.
   *
   * @returns
   *   - 'proceed' → continue with AI subagent spawn
   *   - 'terminal' → command was run in terminal, skip AI
   *   - 'cancel' → user canceled the action
   */
  async runExecutionGuard(
    sessionId: string,
    prompt: string,
    workspacePath?: string,
  ): Promise<'proceed' | 'terminal' | 'cancel'> {
    const ws = workspacePath ?? this.currentWorkspacePath() ?? '';
    if (!this.smartActionService.isDesktop) {
      return 'proceed';
    }

    this.analyzing.set(true);
    try {
      // Run detection with a 2-second timeout
      const result = await Promise.race<SmartActionResult | null>([
        this.smartActionService.detect(prompt, ws),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 2000)),
      ]);


      if (!result?.detected || !result.command || result.confidence === 'low') {
        return 'proceed';
      }

      // Show the modal
      const { SmartActionModalComponent } = await import('../smart-action-modal/smart-action-modal.component');
      const modalRef = this.modalService.open(SmartActionModalComponent, {
        centered: true,
        size: result.alternatives?.length ? 'md' : 'sm',
      });
      modalRef.componentInstance.command = result.command;
      modalRef.componentInstance.label = result.label ?? '';
      modalRef.componentInstance.source = result.source ?? '';
      modalRef.componentInstance.prompt = prompt;
      modalRef.componentInstance.alternatives = result.alternatives ?? [];

      try {
        const choice = await modalRef.result;
        // New format: { action: 'terminal', command: string } or 'agent'
        if (typeof choice === 'object' && choice.action === 'terminal') {
          await this.spawnTerminalCommand(sessionId, result.label ?? 'Terminal', choice.command);
          return 'terminal';
        }
        if (choice === 'terminal') {
          // Backwards compat: single-folder (no alternatives)
          await this.spawnTerminalCommand(sessionId, result.label ?? 'Terminal', result.command);
          return 'terminal';
        }
        // choice === 'agent' → proceed with AI
        return 'proceed';
      } catch {
        // Modal dismissed → cancel
        return 'cancel';
      }
    } catch {
      // Guard failed → proceed with AI (no interruption rule)
      return 'proceed';
    } finally {
      this.analyzing.set(false);
    }
  }

  /**
   * Spawns a generic-shell sub-agent to execute a terminal command directly.
   * Used by the execution guard when user chooses "Run in Terminal".
   */
  async spawnTerminalCommand(sessionId: string, label: string, command: string): Promise<void> {
    if (!this.isDesktop) return;

    // Parent session from the store: its id picks the right one when two
    // sessions share a name (the name stays for older desktop builds).
    let sessionName: string | null = null;
    let parentId: string | null = null;
    this.store.select(getActiveSession).subscribe((s) => {
      sessionName = s?.name ?? null;
      parentId = s?.id ?? null;
    }).unsubscribe();

    if (!sessionName) {
      return;
    }

    try {
      const result = await this.api.runSmartActionTerminal(sessionName, label, command, parentId ?? sessionId);
      if (!result?.ok) console.warn('[sub-agent] run in terminal failed', result?.error);
    } catch (err) {
      console.warn('[sub-agent] run in terminal failed', err);
    }
  }

  /**
   * Pre-execution guard for terminal-side input (typed or pasted commands
   * inside an xterm). Returns:
   *   - 'terminal' → user chose Run in Terminal; a generic-shell sub-agent
   *                  has already been spawned with the command. Caller MUST NOT
   *                  forward Enter/paste to the PTY.
   *   - 'continue' → user chose to keep the command in the AI prompt (or
   *                  detection failed/timed out). Caller MUST forward the
   *                  original input (typed Enter or paste block) to the PTY.
   *   - 'cancel'   → user dismissed the modal. Caller MUST NOT forward.
   *                  (Behavior B from the design: no PTY rollback.)
   */
  async showSmartActionModalForTerminal(
    sessionId: string,
    command: string,
    workspacePath?: string,
    isPaste = false,
  ): Promise<'terminal' | 'continue' | 'cancel'> {
    const ws = workspacePath ?? this.currentWorkspacePath() ?? '';
    if (!this.smartActionService.isDesktop) {
      return 'continue';
    }
    try {
      const result = await Promise.race<SmartActionResult | null>([
        this.smartActionService.detect(command, ws),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 2000)),
      ]);
      if (!result?.detected || !result.command || result.confidence === 'low') {
        return 'continue';
      }

      const { SmartActionModalComponent } = await import('../smart-action-modal/smart-action-modal.component');
      const modalRef = this.modalService.open(SmartActionModalComponent, {
        centered: true,
        size: result.alternatives?.length ? 'md' : 'sm',
      });
      modalRef.componentInstance.command = result.command;
      modalRef.componentInstance.label = result.label ?? '';
      modalRef.componentInstance.source = result.source ?? '';
      modalRef.componentInstance.prompt = command;
      modalRef.componentInstance.alternatives = result.alternatives ?? [];

      try {
        const choice = await modalRef.result;
        if (typeof choice === 'object' && choice?.action === 'terminal') {
          await this.spawnTerminalCommand(sessionId, result.label ?? 'Terminal', choice.command);
          return 'terminal';
        }
        if (choice === 'terminal') {
          await this.spawnTerminalCommand(sessionId, result.label ?? 'Terminal', result.command);
          return 'terminal';
        }
        // 'agent' → continue with PTY; isPaste used by caller to decide what to send
        void isPaste;
        return 'continue';
      } catch {
        return 'cancel';
      }
    } catch {
      return 'continue';
    }
  }

  // ── Actions ────────────────────────────────────────────────────

  /**
   * Spawn a sub-agent from a suggestion.
   * Runs the pre-subagent execution guard before spawning.
   */
  async spawnFromSuggestion(suggestion: SubAgentSuggestion): Promise<SubAgent | null> {
    if (!this.isDesktop) return null;

    // Pre-subagent execution guard
    const guardResult = await this.runExecutionGuard(
      suggestion.parentSessionId,
      suggestion.autoPrompt,
    );
    if (guardResult !== 'proceed') return null;

    try {
      await this.ensureParentAwake(suggestion.parentSessionId);
      const ecoLevel = localStorage.getItem('po-eco-mode') === 'true'
        ? (localStorage.getItem('po-eco-level') || 'full')
        : undefined;
      const result = await this.api.requestSpawnSubAgent({
        parentSessionId: suggestion.parentSessionId,
        role: suggestion.role,
        title: suggestion.title,
        prompt: suggestion.autoPrompt,
        icon: suggestion.icon,
        ...(suggestion.mode ? { mode: suggestion.mode } : {}),
        ...(ecoLevel ? { ecoLevel } : {}),
      });

      if (result?.ok && result.subAgent) {
        // The push event will add it to activeSubAgents
        return result.subAgent;
      }
      // If pendingSpawnId is present, the context-transfer modal is handling
      // the decision. The sub-agent will arrive via SUBAGENT_CREATED push.
    } catch (err) {
      console.warn('[SubAgentService] spawn from suggestion failed', err);
    }
    return null;
  }

  /**
   * Spawn a sub-agent with a custom prompt (e.g., from main agent orchestration).
   * Throws on spawn failure (the main process reports it as {ok:false, error});
   * resolves null when no spawn occurred (guard declined, context-transfer
   * pending, not in the desktop app).
   */
  async spawnCustom(
    parentSessionId: string,
    role: string,
    title: string,
    prompt: string,
    provider?: SubAgentProvider,
    mode?: SubAgentMode,
    customConfig?: Partial<SubAgentConfig>,
    workspacePath?: string,
    providerAccountId?: string | null,
    extensionSelection?: ExtensionSelectionPayload,
    executionMode?: 'interactive' | 'worker',
    model?: string,
    ecoLevelOverride?: string,
    goalSpec?: { maxIterations?: number; maxTotalTokens?: number; stuckThreshold?: number; native?: boolean },
    effort?: string,
    softSkill?: SoftSkillPayload,
  ): Promise<SubAgent | null> {
    if (!this.isDesktop) return null;
    // Organization policy (Enterprise): refuse providers the admin disallowed.
    if (provider && !this.orgPolicy.isProviderAllowed(provider)) {
      throw new Error(this.orgPolicy.deniedMessage(provider));
    }

    // Pre-subagent execution guard (skip for generic-shell / smart-action — already terminal)
    if (provider !== 'generic-shell' && role !== 'smart-action') {
      const guardResult = await this.runExecutionGuard(parentSessionId, prompt, workspacePath);
      if (guardResult !== 'proceed') return null;
    }

    // A parked parent must be woken before a new sub-agent joins it: on
    // standby the native side keeps the park-time stash authoritative and
    // does not record new sub-agents, so one spawned into a parked session
    // was lost on the next restart. Waking also restores its parked
    // sub-agents, as any other wake does.
    await this.ensureParentAwake(parentSessionId);

    // The tracked parent is NOT switched here: the session on screen keeps
    // its bench, locks and roster (switching only the id made the next
    // trackSession() skip loading them, and the old session's bench/locks
    // were then saved under this one). The created push event carries the
    // parent id and fills the cross-session cache.

    // Eco can arrive two ways: the global toggle, or the composer's Eco
    // pseudo-mode (explicit override) which greens up ONLY this sub-agent.
    const ecoLevel = ecoLevelOverride
      ?? (mode === 'eco' ? (localStorage.getItem('po-eco-level') || 'full') : undefined)
      ?? (localStorage.getItem('po-eco-mode') === 'true'
        ? (localStorage.getItem('po-eco-level') || 'full')
        : undefined);
    // 'eco' is UI-only — the runtime gets a neutral mode plus the ECO directive.
    const spawnMode = mode === 'eco' ? 'clean' : mode;
    const result = await this.api.requestSpawnSubAgent({
      parentSessionId,
      role,
      title,
      prompt,
      ...(provider ? { provider } : {}),
      // A saved workspace command must execute in its source folder, including
      // when the active workspace is a monorepo root or another project.
      ...(provider === 'generic-shell' && workspacePath ? { workspaceOverride: workspacePath } : {}),
      ...(spawnMode ? { mode: spawnMode } : {}),
      ...(customConfig ? { customConfig } : {}),
      ...(ecoLevel ? { ecoLevel } : {}),
      ...(providerAccountId !== undefined ? { providerAccountId } : {}),
      ...(extensionSelection && extensionSelection.items.length > 0 ? { extensionSelection } : {}),
      ...(executionMode ? { executionMode } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(goalSpec ? { goalSpec } : {}),
      // Soft skill rides the mode preamble on the desktop side — never as a textual prompt injection from here.
      ...(softSkill?.instructions?.trim() ? { softSkill: { ...(softSkill.id ? { id: softSkill.id } : {}), name: softSkill.name, instructions: softSkill.instructions } } : {}),
    });

    if (result?.ok && result.subAgent) {
      // Push event (SUBAGENT_CREATED) will add it to the list
      return result.subAgent;
    }
    if (result && result.ok === false) {
      // The main process wraps spawn errors as {ok:false, error} (it never
      // rejects the invoke) — e.g. provider CLI binary missing. Surface it.
      throw new Error(result.error || 'Agent spawn failed');
    }
    // If pendingSpawnId is present, the context-transfer modal is handling
    // the decision. The sub-agent will arrive via SUBAGENT_CREATED push.
    return null;
  }

  /**
   * Wakes the parent when it is parked and waits for the outcome. Throws an
   * Error with `wakeFailed: true` when the wake fails (the wake effect has
   * already told the user why), so the caller keeps the prompt.
   */
  private async ensureParentAwake(parentSessionId: string): Promise<void> {
    const sessions = await firstValueFrom(this.store.select(getSessions));
    const parent = (Array.isArray(sessions) ? sessions : []).find((s) => s.id === parentSessionId || s.dbId === parentSessionId);
    if (!parent?.standbyAt || !this.actions$) return;
    const outcome = firstValueFrom(
      this.actions$.pipe(
        ofType(wakeSessionSuccess, wakeSessionFailure),
        filter((a) => a.sessionId === parent.id),
        take(1),
        timeout(30_000),
      ),
    );
    this.store.dispatch(wakeSession({ sessionId: parent.id }));
    let result: Awaited<typeof outcome>;
    try {
      result = await outcome;
    } catch {
      // No outcome in time (e.g. a detached window hands the wake to the
      // main window): spawn anyway rather than block the user.
      console.warn('[SubAgentService] parent wake not confirmed in time; spawning anyway');
      return;
    }
    if (result.type === wakeSessionFailure.type) {
      throw Object.assign(new Error((result as { error?: string }).error || 'Session wake failed'), { wakeFailed: true });
    }
  }

  /** Save every drag in sequence; a late response must never move another session. */
  async reorderSubAgents(parentSessionId: string, orderedIds: string[]): Promise<void> {
    const order = [...orderedIds];
    if (!this.currentParentId() || this.currentParentId() === parentSessionId) {
      this.customOrder.set(order);
    }
    this.rememberOrder(parentSessionId, order);
    const previous = this.orderWrites.get(parentSessionId) ?? Promise.resolve();
    const write = previous.then(async () => {
      try {
        await firstValueFrom(this.desktopSessionApi.updateSubAgentsOrder(parentSessionId, order));
      } catch {
        // The device retains the requested order even when saving fails.
        console.error('[SubAgentService] Could not sync agent order; kept locally');
      }
    });
    this.orderWrites.set(parentSessionId, write);
    await write;
    if (this.orderWrites.get(parentSessionId) === write) this.orderWrites.delete(parentSessionId);
  }

  /**
   * Switch a running sub-agent to another provider IN THE SAME terminal
   * (Tauri v2): the CLI is exited, the new one launched in the same login
   * shell, and `prompt` injected as the handoff. Returns false when the
   * desktop has no such command so callers can fall back.
   */
  async switchProvider(
    subAgentId: string,
    provider: SubAgentProvider,
    prompt: string,
    model?: string,
  ): Promise<boolean> {
    if (!this.isDesktop || !this.api.switchSubAgentProvider) return false;
    try {
      const res = await this.api.switchSubAgentProvider({ subAgentId, provider, prompt, ...(model ? { model } : {}) });
      if (!res?.ok) {
        console.error('[SubAgentService] switchProvider failed:', res?.error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('[SubAgentService] switchProvider threw:', err);
      return false;
    }
  }

  /** Send a chat turn to a headless worker sub-agent. */
  async sendWorkerMessage(subAgentId: string, text: string): Promise<boolean> {
    if (!this.isDesktop || !this.api.sendWorkerMessage) return false;
    try {
      const res = await this.api.sendWorkerMessage(subAgentId, text);
      return !!res?.ok;
    } catch { return false; }
  }

  /**
   * Destroy a sub-agent.
   * Always removes from local state even if IPC fails (stale ID, already gone).
   */
  async destroy(subAgentId: string): Promise<void> {
    // Locked agent: no way of closing it (header, Action Center, panel)
    // takes it down. The guard lives here, not in the individual buttons.
    if (this.isLocked(subAgentId)) return;

    // Scrub the parked stash FIRST, synchronously: main's mirror push is
    // debounced (500ms) and a sessions reload landing inside that window
    // would resurrect the agent via the restore machinery.
    const sa = this.allSubAgents().find((s) => s.id === subAgentId)
      ?? this.activeSubAgents().find((s) => s.id === subAgentId);
    if (sa && this.isDesktop) {
      const session = this.getActiveSessionSnapshot();
      const parentId = this.currentParentId();
      if (session && (!parentId || sa.parentSessionId === parentId)) {
        this.subAgentStash.removeEntry(session, {
          sessionId: sa.sessionId,
          role: sa.role,
          title: sa.title,
        });
      }
    }

    // Immediately remove from UI — don't wait for push event.
    // This ensures the close button always works, even when the desktop
    // sub-agent was already destroyed or has a mismatched ID after restore.
    this.activeSubAgents.update((list) => list.filter((s) => s.id !== subAgentId));
    this.allSubAgents.update((list) => list.filter((s) => s.id !== subAgentId));
    this.unbench(subAgentId, sa ?? undefined);
    this.forgetOrder(subAgentId, sa ?? undefined);

    if (!this.isDesktop) return;

    try {
      await this.api.destroySubAgent(subAgentId);
    } catch (err) {
    }
  }

  /** Synchronous snapshot of the active session (store select + unsubscribe). */
  private getActiveSessionSnapshot(): SessionSummary | null {
    let snap: SessionSummary | null = null;
    this.store.select(getActiveSession).subscribe((s) => {
      snap = s ?? null;
    }).unsubscribe();
    return snap;
  }

  /**
   * Write data to a sub-agent's terminal.
   */
  async writeToSubAgent(subAgentId: string, data: string): Promise<void> {
    if (!this.isDesktop) return;
    await this.api.writeSubAgent(subAgentId, data);
  }

  /**
   * Get terminal buffer for a sub-agent.
   */
  async getBuffer(subAgentId: string): Promise<string> {
    if (!this.isDesktop) return '';
    const result = await this.api.getSubAgentBuffer(subAgentId);
    return result.ok ? result.data : '';
  }

  /**
   * Resize a sub-agent's terminal.
   */
  async resizeSubAgent(subAgentId: string, cols: number, rows: number): Promise<void> {
    if (!this.isDesktop) return;
    await this.api.resizeSubAgent(subAgentId, cols, rows);
  }

  // ── Archive / Resume ───────────────────────────────────────

  /**
   * List archived sub-agents from BOTH stores (hybrid):
   * - desktop IPC in-memory archive: entries closed in the current app run;
   * - stored records: entries persisted across restarts.
   * Deduped via mergeArchivedEntries (IPC wins on collision).
   */
  async listArchived(): Promise<ArchivedSubAgentEntry[]> {
    const [storedEntries, ipcEntries] = await Promise.all([
      this.listArchivedFromStore(),
      this.listArchivedFromIpc(),
    ]);
    return mergeArchivedEntries(storedEntries, ipcEntries);
  }

  private async listArchivedFromStore(): Promise<ArchivedSubAgentEntry[]> {
    try {
      const storedEntries = await firstValueFrom(this.desktopSessionApi.listSubAgentArchive());
      return (storedEntries ?? [])
        // Older backends also return the currently ACTIVE sub-agents — only
        // archived/history entries belong in the resume modal.
        .filter((e: any) => ['archived', 'history'].includes(e.status ?? 'archived'))
        .map((e: any) => ({
          index: e.index ?? 0,
          archiveId: e.archive_id ?? undefined,
          role: e.role ?? 'custom',
          title: e.title ?? 'Untitled',
          userPrompt: e.user_prompt ?? e.prompt ?? '',
          icon: e.icon ?? 'solar:cpu-bolt-bold-duotone',
          mode: e.mode,
          config: e.config,
          softSkill: e.soft_skill ?? e.softSkill,
          provider: (e.provider ?? 'claude-code-cli') as SubAgentProvider,
          claudeSessionId: e.claude_session_id,
          archivedAt: e.archived_at ?? e.updated_at ?? new Date().toISOString(),
          parentSessionId: e.parent_session_id ?? '',
          parentSessionName: e.parent_session_name,
          workspacePath: e.workspace_path,
          canResume: !!e.can_resume,
        }));
    } catch (err) {
      return [];
    }
  }

  private async listArchivedFromIpc(): Promise<ArchivedSubAgentEntry[]> {
    if (!this.isDesktop) return [];
    try {
      const result = await this.api.listArchivedSubAgents();
      return result?.ok ? (result.archived ?? []) : [];
    } catch (err) {
      return [];
    }
  }

  /**
   * Resume an archived sub-agent by spawning a new sub-agent with its
   * claudeSessionId (enables --resume) or its original prompt (re-spawn).
   */
  async resumeArchived(
    parentSessionId: string,
    archived: ArchivedSubAgentEntry,
  ): Promise<SubAgent | null> {
    if (!this.isDesktop) return null;
    if (!this.orgPolicy.isProviderAllowed((archived as any).provider)) {
      throw new Error(this.orgPolicy.deniedMessage(String((archived as any).provider)));
    }

    // The tracked parent is NOT switched here: the session on screen keeps
    // its bench, locks and roster (switching only the id made the next
    // trackSession() skip loading them, and the old session's bench/locks
    // were then saved under this one). The created push event carries the
    // parent id and fills the cross-session cache.

    try {
      // Same as spawnCustom: a sub-agent resumed into a parked session would
      // be lost on the next restart.
      await this.ensureParentAwake(parentSessionId);
      const result = await this.api.spawnSubAgent({
        parentSessionId,
        role: archived.role,
        title: archived.title,
        // Older desktops can hand back entries without prompt text (privacy
        // strip in the local store) — never forward undefined to the TUI.
        prompt: archived.userPrompt ?? '',
        provider: archived.provider,
        icon: archived.icon,
        ...(archived.mode ? { mode: archived.mode } : {}),
        ...(archived.config ? { customConfig: archived.config } : {}),
        ...(archived.softSkill?.instructions ? { softSkill: archived.softSkill } : {}),
        ...(archived.claudeSessionId ? { claudeSessionId: archived.claudeSessionId } : {}),
        // --resume is bound to the provider's project dir — resume in the
        // sub-agent's original workspace even if the current one differs.
        ...(archived.workspacePath ? { workspaceOverride: archived.workspacePath } : {}),
        deferPrompt: true,
      });

      if (result.ok && result.subAgent) {
        // Clear the archived entry since it's been resumed
        await this.clearArchived(archived);
        return result.subAgent;
      }
      return null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Clear an archived sub-agent entry from BOTH stores of the hybrid archive:
   * the desktop in-memory Map (fresh entries) and the stored record (persisted).
   */
  async clearArchived(entry: ArchivedSubAgentEntry): Promise<void> {
    if (this.isDesktop) {
      try {
        await this.api.clearArchivedSubAgent(entry.parentSessionId, entry.index, entry.archiveId);
      } catch (err) {
      }
    }
    try {
      await firstValueFrom(this.desktopSessionApi.clearSubAgentArchiveEntry({
        archive_id: entry.archiveId,
        claude_session_id: entry.claudeSessionId,
        title: entry.title,
        archived_at: entry.archivedAt,
      }));
    } catch (err) {
    }
  }

  /**
   * Register a callback for sub-agent output.
   */
  onSubAgentOutput(callback: (data: { subAgentId: string; parentSessionId: string; data: string }) => void): () => void {
    if (!this.isDesktop) return () => {};
    return this.api.onSubAgentOutput((_event: unknown, data: any) => callback(data));
  }
}
