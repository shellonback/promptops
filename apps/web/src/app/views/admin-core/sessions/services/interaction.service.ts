import { Injectable, signal, computed, inject, effect, untracked } from '@angular/core';
import { BuiltinPluginsService } from '../../plugins/builtin-plugins.service';
import { Interaction } from '../../../../../store/sessions/session.state';

export interface AutoApproveFlags {
  modal: boolean;
  quick: boolean;
  ai: boolean;
}

export interface TailerResponseReady {
  sessionId: string;
  terminalId: string;
  type: string;   // 'ai' | 'heuristic' | 'quick' | 'fast-path'
  prompt: string;
  response: string;
}

@Injectable({ providedIn: 'root' })
export class InteractionService {
  private builtins = inject(BuiltinPluginsService);
  private _pendingInteractions = signal<Interaction[]>([]);
  private unsubCreated: (() => void) | null = null;
  private unsubResolved: (() => void) | null = null;
  private unsubAutoApprove: (() => void) | null = null;
  private unsubTailerReady: (() => void) | null = null;
  private unsubTailerThinking: (() => void) | null = null;

  /** Per-session auto-approve flags. */
  readonly sessionFlags = signal<Map<string, AutoApproveFlags>>(new Map());

  /** Plugin off = no Auto Approve, not even one already armed (sessions opened before the update,
   *  flags from the native process): with its controls hidden it could no longer be stopped. */
  private readonly stopWhenPluginOff = effect(() => {
    if (this.builtins.isOn('auto-approve')) return;
    for (const [id, f] of this.sessionFlags()) {
      if (f.quick || f.ai || f.modal) untracked(() => void this.setAutoApprove(id, false));
    }
  });

  /** Latest tailer response ready for preview (null = no pending preview). */
  readonly tailerResponse = signal<TailerResponseReady | null>(null);

  /** Set of session IDs where the AI is currently generating a response. */
  readonly thinkingSessions = signal<Set<string>>(new Set());

  /**
   * Last "auto-approve turned off but the CLI keeps its native bypass" event.
   * Codex (`--dangerously-bypass-approvals-and-sandbox`) and Gemini (`--yolo`)
   * receive the flag at spawn and cannot have it revoked on a live process:
   * the toggle stops our injections, the CLI itself keeps auto-approving until
   * the session respawns. Consumed by the UI to warn the user.
   */
  readonly nativeResidualWarning = signal<{ sessionId: string; provider: string } | null>(null);

  /** @deprecated — use getFlags(sessionId) for per-session checks. */
  readonly autoApproveEnabled = computed(() => {
    for (const [, f] of this.sessionFlags()) {
      if (f.quick || f.ai) return true;
    }
    return false;
  });

  /** All pending interactions across all sessions. */
  readonly pendingInteractions = this._pendingInteractions.asReadonly();

  /** Total count of pending interactions. */
  readonly pendingCount = computed(() => this._pendingInteractions().length);

  private get api(): any {
    return (window as any).promptops;
  }

  /** Get flags for a session. */
  getFlags(sessionId: string): AutoApproveFlags {
    return this.sessionFlags().get(sessionId) ?? { modal: false, quick: false, ai: false };
  }

  /** Check if any auto-approve flag is active for a session. */
  isAutoApproved(sessionId: string): boolean {
    const f = this.getFlags(sessionId);
    return f.quick || f.ai;
  }

  init(): void {
    // Called by the main layout and by the Sessions view: a second call added
    // another set of listeners (every interaction counted twice) and leaked
    // the first set, which destroy() can no longer remove.
    if (!this.api || this.unsubCreated) return;

    this.unsubCreated = this.api.onInteractionCreated((_event: unknown, data: { interaction: Interaction }) => {
      this._pendingInteractions.update((list) =>
        list.some((i) => i.id === data.interaction.id) ? list : [...list, data.interaction]);
    });

    this.unsubResolved = this.api.onInteractionResolved((_event: unknown, data: { interactionId: string }) => {
      this._pendingInteractions.update((list) =>
        list.filter((i) => i.id !== data.interactionId),
      );
    });

    // Sync flags from the desktop host. The native side keys the tailer by LOCAL
    // session id while this map may be keyed by the stored id (woken or
    // DB-restored sessions) — write BOTH ids or the UI reads a stale "off"
    // and the toggle re-enables instead of disabling.
    if (typeof this.api.onAutoApproveChanged === 'function') {
      this.unsubAutoApprove = this.api.onAutoApproveChanged((_event: unknown, data: { sessionId: string; dbId?: string; nativeResidual?: string; flags: AutoApproveFlags }) => {
        this.sessionFlags.update(map => {
          const next = new Map(map);
          next.set(data.sessionId, data.flags);
          if (data.dbId) next.set(data.dbId, { ...data.flags });
          return next;
        });
        if (data.nativeResidual) {
          this.nativeResidualWarning.set({ sessionId: data.dbId ?? data.sessionId, provider: data.nativeResidual });
        }
      });
    }

    // Load initial flags
    if (typeof this.api.getAutoApproveFlags === 'function') {
      this.api.getAutoApproveFlags().then((allFlags: Record<string, AutoApproveFlags>) => {
        if (allFlags && typeof allFlags === 'object') {
          const map = new Map<string, AutoApproveFlags>();
          for (const [id, flags] of Object.entries(allFlags)) {
            map.set(id, flags);
          }
          if (map.size > 0) this.sessionFlags.set(map);
        }
      }).catch(() => {});
    }

    // Listen for tailer response-ready events
    if (typeof this.api.onTailerResponseReady === 'function') {
      this.unsubTailerReady = this.api.onTailerResponseReady((_event: unknown, data: TailerResponseReady) => {
        this.tailerResponse.set(data);
      });
    }

    // Listen for tailer thinking state changes
    if (typeof this.api.onTailerThinking === 'function') {
      this.unsubTailerThinking = this.api.onTailerThinking((_event: unknown, data: { sessionId: string; thinking: boolean }) => {
        this.thinkingSessions.update(set => {
          const next = new Set(set);
          if (data.thinking) {
            next.add(data.sessionId);
          } else {
            next.delete(data.sessionId);
          }
          return next;
        });
      });
    }
  }

  destroy(): void {
    this.unsubCreated?.();
    this.unsubResolved?.();
    this.unsubAutoApprove?.();
    this.unsubTailerReady?.();
    this.unsubTailerThinking?.();
    this.unsubCreated = null;
    this.unsubResolved = null;
    this.unsubAutoApprove = null;
    this.unsubTailerReady = null;
    this.unsubTailerThinking = null;
  }

  /** Set one or more auto-approve flags for a session. */
  async setFlags(sessionId: string, flags: Partial<AutoApproveFlags>): Promise<void> {
    // Plugin off: it can only be turned off.
    if (!this.builtins.isOn('auto-approve')) {
      flags = { modal: false, quick: false, ai: false };
    }
    // Optimistic update
    this.sessionFlags.update(map => {
      const next = new Map(map);
      const current = next.get(sessionId) ?? { modal: false, quick: false, ai: false };
      next.set(sessionId, { ...current, ...flags });
      return next;
    });

    if (typeof this.api?.setAutoApproveFlags === 'function') {
      this.api.setAutoApproveFlags(sessionId, flags).catch(() => {});
    }
  }

  /** Legacy toggle for backwards compat. */
  async setAutoApprove(sessionId: string, enabled: boolean): Promise<boolean> {
    await this.setFlags(sessionId, enabled ? { quick: true } : { modal: false, quick: false, ai: false });
    return enabled;
  }

  /** Inject the tailer response into the terminal. */
  async injectTailerResponse(): Promise<void> {
    const data = this.tailerResponse();
    if (!data || !this.api) return;
    await this.api.tailerInject(data.sessionId, data.response);
    this.tailerResponse.set(null);
  }

  /** Dismiss the tailer response preview. */
  dismissTailerResponse(): void {
    this.tailerResponse.set(null);
  }

  async listPending(sessionId?: string): Promise<Interaction[]> {
    if (!this.api) return [];
    return this.api.listInteractions(sessionId);
  }

  async respond(interactionId: string, value: string): Promise<{ ok: boolean }> {
    return this.api.respondToInteraction({ interactionId, action: 'respond', value });
  }

  async approve(interactionId: string): Promise<{ ok: boolean }> {
    return this.api.respondToInteraction({ interactionId, action: 'approve' });
  }

  async deny(interactionId: string): Promise<{ ok: boolean }> {
    return this.api.respondToInteraction({ interactionId, action: 'deny' });
  }

  pendingForSession(sessionId: string): Interaction[] {
    return this._pendingInteractions().filter((i) => i.sessionId === sessionId);
  }
}
