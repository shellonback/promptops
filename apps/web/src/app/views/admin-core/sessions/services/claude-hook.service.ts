import { Injectable, inject, signal, computed, effect, EffectRef, Injector, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { getActiveSessionId } from '../../../../../store/sessions/session.selectors';
import { wakeSession } from '../../../../../store/sessions/session.actions';
import { SessionService } from './session.service';
import { InteractionService } from './interaction.service';
import { SubAgentService } from './sub-agent.service';
import { SessionTokenStats } from '../../../../../store/token-efficiency/token-efficiency.state';
import { UiStyleService } from '../../../../core/services/ui-style.service';

export interface HookEvent {
  type: string;
  sessionId: string;
  workspace: string;
  timestamp: string;
  message?: string;
  title?: string;
  notificationType?: string;
  lastMessage?: string;
  hookEvent?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /** Optional CTA rendered by the toast instead of only "Go to Session". */
  action?: 'compact';
  /** Set when the CTA targets a sub-agent of `sessionId` (its own PTY). */
  subAgentId?: string;
}

export interface ToolContext {
  toolName: string;
  toolInput: Record<string, unknown>;
  timestamp: string;
}

export interface PendingHookInteraction {
  id: string;
  sessionId: string;
  sessionName: string;
  workspace: string;
  workspaceName: string;
  message: string;
  title: string;
  notificationType: string;
  timestamp: string;
  toolContext?: ToolContext;
  /** Auto-dismiss duration snapshot at enqueue time; undefined = pinned (no auto-dismiss) */
  durationMs?: number;
  action?: 'compact';
  subAgentId?: string;
}

const AUTO_NAV_KEY = 'promptops_auto_nav_sessions';
/** Below this context size a cold resume costs too little to interrupt the user. */
const COLD_RESUME_MIN_CONTEXT = 60_000;
const TOAST_PREFS_KEY = 'promptops_toast_prefs';
const TOAST_DURATION_DEFAULT_MS = 5000;
const TOAST_DURATION_MIN_MS = 3000;
const TOAST_DURATION_MAX_MS = 30000;
/** Compact CTA toasts (context pressure, cold resume) never outlive this, even when pinned. */
const COMPACT_CTA_MAX_MS = 15000;

export interface ToastPrefs {
  durationMs: number;
  pinned: boolean;
  pauseOnHover: boolean;
  /** Compact CTA toasts (context pressure, cold resume). */
  compactSuggestions: boolean;
}

/** Load toast preferences from localStorage — defaults preserve today's behavior on missing/corrupt data */
export function loadToastPrefs(): ToastPrefs {
  const defaults: ToastPrefs = {
    durationMs: TOAST_DURATION_DEFAULT_MS,
    pinned: false,
    pauseOnHover: false,
    compactSuggestions: true,
  };
  try {
    const raw = localStorage.getItem(TOAST_PREFS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<ToastPrefs>;
    return {
      durationMs:
        typeof parsed.durationMs === 'number' && Number.isFinite(parsed.durationMs)
          ? Math.min(Math.max(parsed.durationMs, TOAST_DURATION_MIN_MS), TOAST_DURATION_MAX_MS)
          : defaults.durationMs,
      pinned: typeof parsed.pinned === 'boolean' ? parsed.pinned : defaults.pinned,
      pauseOnHover: typeof parsed.pauseOnHover === 'boolean' ? parsed.pauseOnHover : defaults.pauseOnHover,
      compactSuggestions: typeof parsed.compactSuggestions === 'boolean' ? parsed.compactSuggestions : defaults.compactSuggestions,
    };
  } catch {
    return defaults;
  }
}

interface ToastTimerEntry {
  /** null while paused (hover) */
  timeout: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  remainingMs: number;
}

@Injectable({ providedIn: 'root' })
export class ClaudeHookService implements OnDestroy {
  private sessionService = inject(SessionService);
  private router = inject(Router);
  private store = inject(Store);
  private uiStyle = inject(UiStyleService);
  private injector = inject(Injector);
  private interactionService = inject(InteractionService);

  private unsubscribe: (() => void) | null = null;
  private unsubscribeNav: (() => void) | null = null;
  private unsubscribeAaDisabled: (() => void) | null = null;
  private residualEffect: EffectRef | null = null;
  private unsubscribeCtxPressure: (() => void) | null = null;
  private coldResumeWarned = new Set<string>();
  private unsubscribeResumeFallback: (() => void) | null = null;
  private recentToolUse = new Map<string, ToolContext>();
  private activeSessionId: string | null = null;
  private activeSessionSub: { unsubscribe(): void } | null = null;
  private autoDismissTimers = new Map<string, ToastTimerEntry>();

  /** Auto-navigation toggle — persisted in localStorage */
  readonly autoNavigate = signal(localStorage.getItem(AUTO_NAV_KEY) === 'true');

  /** Toast preferences — persisted in localStorage (device-local) */
  private readonly initialToastPrefs = loadToastPrefs();
  readonly toastDurationMs = signal(this.initialToastPrefs.durationMs);
  readonly toastPinned = signal(this.initialToastPrefs.pinned);
  readonly toastPauseOnHover = signal(this.initialToastPrefs.pauseOnHover);
  readonly compactSuggestions = signal(this.initialToastPrefs.compactSuggestions);

  /** Queue of pending hook interactions (FIFO) — used when autoNavigate is OFF */
  readonly pendingQueue = signal<PendingHookInteraction[]>([]);

  /** Whether any toast should be shown */
  readonly showGlobalModal = computed(() => this.pendingQueue().length > 0);

  /** Number of pending interactions in queue */
  readonly pendingCount = computed(() => this.pendingQueue().length);

  /** The session ID that currently needs focus (for auto-navigation) */
  readonly focusSessionId = signal<string | null>(null);

  /** All hook events log (last 50) */
  readonly hookEvents = signal<HookEvent[]>([]);

  init(): void {
    if (!this.sessionService.isDesktop) return;

    // Track active session from store to suppress notifications for the current session
    // and auto-dismiss queued notifications when the user enters a session
    this.activeSessionSub = this.store.select(getActiveSessionId).subscribe((id) => {
      this.activeSessionId = id;
      // Compact toasts belong to the session on screen: drop them on switch.
      // Every other toast is dropped when the user enters its session.
      const entering = !!id && this.router.url.startsWith('/admin/sessions');
      const drop = (q: PendingHookInteraction) =>
        q.action === 'compact' ? q.sessionId !== id : entering && q.sessionId === id;
      this.pendingQueue.update((queue) => {
        queue.filter(drop).forEach((q) => this.clearAutoDismissTimer(q.id));
        return queue.filter((q) => !drop(q));
      });
    });

    // Listen for system notification clicks — navigate via Angular Router
    this.unsubscribeNav = this.sessionService.onNavigateSession((sessionId: string) => {
      this.goToSession(sessionId);
    });

    // Auto-approve switched OFF on a provider that received a native bypass
    // flag at spawn (codex --dangerously-bypass-approvals-and-sandbox, gemini
    // --yolo). Our injections stop immediately but the CLI keeps approving on
    // its own until the session respawns — say so, or "off" is a lie.
    this.residualEffect?.destroy();
    this.residualEffect = effect(() => {
      const residual = this.interactionService.nativeResidualWarning();
      if (!residual) return;
      this.interactionService.nativeResidualWarning.set(null);
      if (this.uiStyle.style() !== 'minimal') return;
      void this.enqueueInteraction({
        type: 'aa-native-residual',
        sessionId: residual.sessionId,
        workspace: '',
        timestamp: new Date().toISOString(),
        title: 'Auto-approve off — CLI still bypassing',
        message: `PromptOps stopped auto-answering, but the running ${residual.provider} CLI was started with its own bypass flag and keeps approving until the session is restarted.`,
        notificationType: 'aa-native-residual',
      });
    }, { injector: this.injector });

    // Y-streak trip-wire: the main process auto-disabled auto-approve for a
    // session. Without this toast the user only sees the toggle silently flip
    // off, which reads as "auto-approve is broken". Minimal UI only — classic
    // is frozen.
    this.unsubscribeAaDisabled = this.sessionService.onTailerAutoApproveDisabled((data) => {
      if (this.uiStyle.style() !== 'minimal') return;
      void this.enqueueInteraction({
        type: 'aa-auto-disabled',
        sessionId: data.sessionId,
        workspace: '',
        timestamp: new Date().toISOString(),
        title: 'Auto-approve disabled',
        message: `Auto-approve was turned off on "${data.sessionName}" after repeated identical confirmations (${data.matchedLine}).`,
        notificationType: 'aa-auto-disabled',
      });
    });

    // Resume fallback: the main process could not reopen a sub-agent's
    // previous conversation. Startup restores stop without replaying the
    // original prompt. Without this toast the fallback looks like a
    // successful resume. Minimal UI only — classic is frozen.
    this.unsubscribeResumeFallback = this.sessionService.onSubAgentResumeFallback((data) => {
      if (this.uiStyle.style() !== 'minimal') return;
      void this.enqueueInteraction({
        type: 'subagent-resume-fallback',
        sessionId: data.parentSessionId,
        workspace: '',
        timestamp: new Date().toISOString(),
        title: data.restarted === false ? 'Agent conversation could not be restored' : 'Agent restarted from its first prompt',
        message: data.restarted === false
          ? `The provider couldn't reopen the previous conversation for "${data.title}". The task was not restarted. Send a new message when you want to continue.`
          : `The provider couldn't reopen the previous conversation for "${data.title}" — it was relaunched and is starting over from its original prompt.`,
        notificationType: 'subagent-resume-fallback',
      });
    });

    // Context pressure: the main process detected a bloated context window
    // (input tokens above threshold on a single prompt). Suggest /compact.
    // Minimal UI only — classic is frozen.
    this.unsubscribeCtxPressure = this.sessionService.onTokenContextPressure((data) => {
      if (this.uiStyle.style() !== 'minimal' || !this.compactSuggestions()) return;
      // Only for the session on screen: the CTA acts on what the user sees.
      if (!this.isViewingSession(data.sessionId)) return;
      // Shown: the main process starts the cooldown only now, so a session that
      // was off screen gets the notice when the user comes back.
      void this.sessionService.tokenContextPressureShown(data.sessionId, data.subAgentId);
      const kTokens = Math.round(data.inputTokens / 1000);
      void this.enqueueInteraction({
        type: 'context-pressure',
        sessionId: data.sessionId,
        workspace: '',
        timestamp: new Date().toISOString(),
        title: data.subAgentId ? 'Agent context window is getting heavy' : 'Context window is getting heavy',
        message: `This ${data.subAgentId ? 'agent' : 'session'} is sending ~${kTokens}K input tokens per prompt. Running /compact (or starting a fresh session) will cut cost and improve responses.`,
        notificationType: 'context-pressure',
        action: 'compact',
        subAgentId: data.subAgentId ?? undefined,
      });
    });

    this.unsubscribe = this.sessionService.onHookEvent((data: HookEvent) => {
      // Log the event
      this.hookEvents.update((events) => [data, ...events].slice(0, 50));

      // Track PreToolUse events for context enrichment (no modal/navigation)
      if (data.type === 'tool-use' && data.hookEvent === 'PreToolUse' && data.toolName) {
        this.recentToolUse.set(data.sessionId, {
          toolName: data.toolName,
          toolInput: data.toolInput ?? {},
          timestamp: data.timestamp,
        });
        return;
      }

      // Handle Notification events — Claude needs human attention
      if (data.type === 'notification') {
        // Skip notification if the user is already viewing this session
        if (this.isViewingSession(data.sessionId)) {
          return;
        }

        if (this.autoNavigate()) {
          // Auto-navigate: go directly to the session with focus
          this.goToSession(data.sessionId);
        } else {
          // Manual: show modal so the user can choose to go
          this.enqueueInteraction(data);
        }
      }
    });
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribeNav?.();
    this.unsubscribeAaDisabled?.();
    this.residualEffect?.destroy();
    this.unsubscribeCtxPressure?.();
    this.unsubscribeResumeFallback?.();
    this.activeSessionSub?.unsubscribe();
    this.autoDismissTimers.forEach((entry) => {
      if (entry.timeout !== null) clearTimeout(entry.timeout);
    });
    this.autoDismissTimers.clear();
  }

  /** Toggle auto-navigation on/off */
  toggleAutoNavigate(): void {
    const newVal = !this.autoNavigate();
    this.autoNavigate.set(newVal);
    localStorage.setItem(AUTO_NAV_KEY, String(newVal));
  }

  /** Set toast auto-dismiss duration (clamped) — applies to new toasts only */
  setToastDurationMs(ms: number): void {
    const clamped = Math.min(Math.max(Math.round(ms), TOAST_DURATION_MIN_MS), TOAST_DURATION_MAX_MS);
    this.toastDurationMs.set(clamped);
    this.persistToastPrefs();
  }

  /** Pin toasts: no auto-dismiss, close only via X / Escape / entering the session */
  setToastPinned(pinned: boolean): void {
    this.toastPinned.set(pinned);
    this.persistToastPrefs();
  }

  /** Pause the auto-dismiss countdown while hovering a toast */
  setToastPauseOnHover(pause: boolean): void {
    this.toastPauseOnHover.set(pause);
    this.persistToastPrefs();
  }

  /** Compact suggestions on/off — turning them off also drops the ones on screen */
  setCompactSuggestions(enabled: boolean): void {
    this.compactSuggestions.set(enabled);
    this.persistToastPrefs();
    if (enabled) return;
    this.pendingQueue.update((queue) => {
      queue.filter((q) => q.action === 'compact').forEach((q) => this.clearAutoDismissTimer(q.id));
      return queue.filter((q) => q.action !== 'compact');
    });
  }

  private persistToastPrefs(): void {
    const prefs: ToastPrefs = {
      durationMs: this.toastDurationMs(),
      pinned: this.toastPinned(),
      pauseOnHover: this.toastPauseOnHover(),
      compactSuggestions: this.compactSuggestions(),
    };
    try {
      localStorage.setItem(TOAST_PREFS_KEY, JSON.stringify(prefs));
    } catch { /* storage unavailable — prefs stay in-memory for this run */ }
  }

  /** Pause a toast's auto-dismiss countdown (hover) — no-op unless pause-on-hover is enabled */
  pauseAutoDismiss(id: string): void {
    if (!this.toastPauseOnHover()) return;
    const entry = this.autoDismissTimers.get(id);
    if (!entry || entry.timeout === null) return;
    clearTimeout(entry.timeout);
    entry.remainingMs -= Date.now() - entry.startedAt;
    entry.timeout = null;
  }

  /** Resume a paused auto-dismiss countdown with the remaining time */
  resumeAutoDismiss(id: string): void {
    const entry = this.autoDismissTimers.get(id);
    if (!entry || entry.timeout !== null) return;
    this.armDismissTimer(id, Math.max(entry.remainingMs, 0));
  }

  /** Check if the user is currently viewing a specific session */
  private isViewingSession(sessionId: string): boolean {
    return (
      this.activeSessionId === sessionId &&
      this.router.url.startsWith('/admin/sessions')
    );
  }

  /** Navigate to the session — uses in-app navigation when possible to avoid white-screen crashes */
  /** Toast CTA: run /compact in the session (measured as a PromptOps saving in the desktop app). */
  async compactSession(sessionId: string, subAgentId?: string): Promise<void> {
    if (await this.sessionService.compactSession(sessionId, subAgentId)) return;
    if (subAgentId) return;
    // Parked / no live PTY: wake (idempotent on main), then retry while the
    // provider boots with --resume — same recovery as PromptInjectionService.
    this.store.dispatch(wakeSession({ sessionId }));
    for (const delay of [2500, 2500, 3000]) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (await this.sessionService.compactSession(sessionId)) return;
    }
  }

  /**
   * Cold resume warning: the provider prompt cache expired while the session
   * sat idle, so the next message re-sends the whole context at cache-write
   * price. Shown once per idle period when the context is large enough.
   * The main and each live agent have their own conversation and cache: the
   * toast names the heaviest cold one and Compact goes to that PTY.
   */
  maybeWarnColdResume(stats: Pick<SessionTokenStats, 'sessionId' | 'lastContextTokens' | 'lastActivityMs' | 'cacheTtlMs' | 'agentContexts'> | null): void {
    if (!stats || this.uiStyle.style() !== 'minimal' || !this.compactSuggestions()) return;
    if (!this.isViewingSession(stats.sessionId)) return;
    const agents = this.injector.get(SubAgentService).activeSubAgents()
      .filter((a) => a.parentSessionId === stats.sessionId);
    const candidates = [
      { subAgentId: undefined as string | undefined, title: '', ctx: stats },
      ...agents.map((a) => ({ subAgentId: a.id, title: a.title, ctx: stats.agentContexts?.[a.id] })),
    ];
    const now = Date.now();
    const cold = candidates
      .map((c) => ({
        ...c,
        tokens: c.ctx?.lastContextTokens ?? 0,
        last: c.ctx?.lastActivityMs ?? 0,
        ttl: c.ctx?.cacheTtlMs || 300_000,
      }))
      .filter((c) => c.tokens >= COLD_RESUME_MIN_CONTEXT && c.last && now - c.last > c.ttl
        && !this.coldResumeWarned.has(`${stats.sessionId}:${c.subAgentId ?? ''}:${c.last}`))
      .sort((a, b) => b.tokens - a.tokens)[0];
    if (!cold) return;
    this.coldResumeWarned.add(`${stats.sessionId}:${cold.subAgentId ?? ''}:${cold.last}`);
    const kTokens = Math.round(cold.tokens / 1000);
    const idleMin = Math.round((now - cold.last) / 60000);
    void this.enqueueInteraction({
      type: 'cold-resume',
      sessionId: stats.sessionId,
      workspace: '',
      timestamp: new Date().toISOString(),
      title: cold.subAgentId ? `Provider cache expired · ${cold.title}` : 'Provider cache expired',
      message: `Idle for ${idleMin} min: the next message ${cold.subAgentId ? 'to this agent ' : ''}will re-send ~${kTokens}K tokens at full cache-write price. Compact first to resend only a summary.`,
      notificationType: 'cold-resume',
      action: 'compact',
      subAgentId: cold.subAgentId,
    });
  }

  goToSession(sessionId: string): void {
    // Drop any toast related to this session — the user is handling it
    this.pendingQueue.update((queue) => {
      queue.filter((q) => q.sessionId === sessionId).forEach((q) => this.clearAutoDismissTimer(q.id));
      return queue.filter((q) => q.sessionId !== sessionId);
    });

    if (this.router.url.startsWith('/admin/sessions')) {
      // Already on sessions page: switch session via signal (no reload needed)
      this.focusSessionId.set(sessionId);
    } else {
      // Different page: navigate via router with query params so session-view picks it up
      this.router.navigate(['/admin/sessions'], {
        queryParams: { session: sessionId, focus: true },
      });
    }
  }

  /** Dismiss a specific toast by id (or the oldest if id omitted) */
  dismissModal(id?: string): void {
    this.pendingQueue.update((queue) => {
      if (!id) {
        const [first, ...rest] = queue;
        if (first) this.clearAutoDismissTimer(first.id);
        return rest;
      }
      this.clearAutoDismissTimer(id);
      return queue.filter((q) => q.id !== id);
    });
  }

  /** Dismiss all pending interactions */
  dismissAll(): void {
    this.pendingQueue().forEach((q) => this.clearAutoDismissTimer(q.id));
    this.pendingQueue.set([]);
  }

  private clearAutoDismissTimer(id: string): void {
    const entry = this.autoDismissTimers.get(id);
    if (entry) {
      if (entry.timeout !== null) clearTimeout(entry.timeout);
      this.autoDismissTimers.delete(id);
    }
  }

  private armDismissTimer(id: string, ms: number): void {
    const timeout = setTimeout(() => {
      this.autoDismissTimers.delete(id);
      this.pendingQueue.update((queue) => queue.filter((q) => q.id !== id));
    }, ms);
    this.autoDismissTimers.set(id, { timeout, startedAt: Date.now(), remainingMs: ms });
  }

  private hookToastSeq = 0;

  private async enqueueInteraction(data: HookEvent): Promise<void> {
    const workspaceName = data.workspace?.split('/').pop() ?? data.workspace ?? '';
    let sessionName = data.sessionId?.substring(0, 8) ?? '';

    try {
      const session = await this.sessionService.getSession(data.sessionId);
      if (session?.name) sessionName = session.name;
    } catch { /* fallback */ }

    // The user may have opened this session while its name was looked up:
    // a "needs your attention" toast for the session on screen is noise.
    if (data.type === 'notification' && this.isViewingSession(data.sessionId)) return;

    // Attach tool context if recent
    let toolContext: ToolContext | undefined;
    const recent = this.recentToolUse.get(data.sessionId);
    if (recent) {
      const toolTime = new Date(recent.timestamp).getTime();
      const notifTime = new Date(data.timestamp).getTime();
      if (notifTime - toolTime < 10000) {
        toolContext = recent;
      }
      this.recentToolUse.delete(data.sessionId);
    }

    const interaction: PendingHookInteraction = {
      // Unique even for two hooks in the same millisecond: dismissing one
      // toast must not take the other (and its timer) with it.
      id: `hook-${Date.now()}-${++this.hookToastSeq}`,
      sessionId: data.sessionId,
      sessionName,
      workspace: data.workspace ?? '',
      workspaceName,
      message: data.message ?? 'Claude requires your input',
      title: data.title ?? 'Claude requires input',
      notificationType: data.notificationType || 'notification',
      timestamp: data.timestamp,
      toolContext,
      // Token-saving tips carry a CTA: give them a bit longer, but they go away on their own.
      durationMs: data.action ? COMPACT_CTA_MAX_MS : this.toastPinned() ? undefined : this.toastDurationMs(),
      action: data.action,
      subAgentId: data.subAgentId,
    };

    // Deduplicate within 2 seconds
    let added = false;
    this.pendingQueue.update((queue) => {
      const isDuplicate = queue.some(
        (q) =>
          q.sessionId === interaction.sessionId &&
          q.subAgentId === interaction.subAgentId &&
          Math.abs(new Date(q.timestamp).getTime() - new Date(interaction.timestamp).getTime()) < 2000,
      );
      if (isDuplicate) return queue;
      added = true;
      return [...queue, interaction];
    });

    if (added && interaction.durationMs) {
      this.armDismissTimer(interaction.id, interaction.durationMs);
    }
  }
}
