import { Injectable, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import type { SubAgent } from '../services/sub-agent.service';
import { AGENTS_MODEL } from './agents-model.token';

/** Per-session metadata kept by Rust (`commands/agents.rs`), keyed by dbId. */
export interface AgentsMeta {
  /** Lead preference; null/missing = session PTY. */
  leadId?: string | null;
  order: string[];
  /** The session PTY was closed by the user: it does not come back until they reopen it. */
  leadClosed: boolean;
}

const EMPTY_META: AgentsMeta = { leadId: null, order: [], leadClosed: false };

/** The minimum needed from a store session to draw the lead. */
export interface AgentSessionLike {
  id: string;
  name?: string | null;
  status?: string | null;
  provider?: unknown;
}

/**
 * Agents model (Tauri only) — the main session is an agent like the others.
 *
 * Adapter, not a rewrite: the members stay the sub-agents of `SubAgentService`
 * (spawn/destroy/stash/bench unchanged); this service adds the lead
 * (= session PTY) to the roster, the lead pointer and the REAL close of the
 * lead (Rust kills the PTY, the session stays as the members' container).
 *
 * The lead in the roster uses the id `__main__`, the same as the legacy pseudo-entry:
 * so the template's 4 render points keep mounting
 * `app-session-terminal` without a new branch.
 *
 * Outside Tauri (`AGENTS_MODEL` false) every method is a no-op.
 */
@Injectable({ providedIn: 'root' })
export class AgentRosterService {
  static readonly LEAD_PANE_ID = '__main__';

  readonly enabled = inject(AGENTS_MODEL);
  private translate = inject(TranslateService);

  private metas = signal<Record<string, AgentsMeta>>({});
  private loading = new Set<string>();
  private unlisten: (() => void) | null = null;

  private get api(): any {
    return (window as any).promptops;
  }

  /** Idempotent, no-op outside the agents model. Listens to `agents:changed` from Rust. */
  init(): void {
    // Kill-switch off on Tauri: revoke the closed leads, so the classic flow
    // sees all the mains again on the next wake instead of a dead PTY.
    if (!this.enabled && (window as any).__TAURI__ && typeof this.api?.agentsClearLeadClosedAll === 'function') {
      void Promise.resolve(this.api.agentsClearLeadClosedAll()).catch(() => {});
      return;
    }
    if (!this.enabled || this.unlisten || typeof this.api?.onAgentsChanged !== 'function') return;
    this.unlisten = this.api.onAgentsChanged((_: unknown, payload: any) => {
      if (payload?.sessionId && payload.meta) this.put(payload.sessionId, payload.meta);
    });
  }

  private put(sessionId: string, meta: Partial<AgentsMeta>): void {
    this.metas.update((m) => ({ ...m, [sessionId]: { ...EMPTY_META, ...(m[sessionId] ?? {}), ...meta } }));
  }

  meta(sessionId: string): AgentsMeta {
    return this.metas()[sessionId] ?? EMPTY_META;
  }

  /** Loads the meta once per session (callable from template/effect). */
  ensureLoaded(sessionId: string): void {
    if (!this.enabled || this.metas()[sessionId] || this.loading.has(sessionId)) return;
    this.loading.add(sessionId);
    void this.load(sessionId).finally(() => this.loading.delete(sessionId));
  }

  async load(sessionId: string): Promise<void> {
    if (!this.enabled) return;
    // Bridge without the command: mark it "loaded" with the default, otherwise the
    // main would stay hidden waiting for meta that will never arrive.
    if (typeof this.api?.agentsMetaGet !== 'function') { this.put(sessionId, {}); return; }
    try {
      const meta = await this.api.agentsMetaGet(sessionId);
      this.put(sessionId, meta ?? {});
    } catch {
      this.put(sessionId, {}); // default: lead open
    }
  }

  /** True when the session's Rust meta has arrived (even with the default). */
  isLoaded(sessionId: string): boolean {
    return !!this.metas()[sessionId];
  }

  leadClosed(sessionId: string): boolean {
    return this.meta(sessionId).leadClosed;
  }

  /**
   * Flat roster: lead (session PTY) + members. The lead is included only if it
   * was not closed and at least one member exists — a single session stays the
   * classic pane, exactly as before.
   */
  rosterFor(session: AgentSessionLike | null, subs: SubAgent[], includeLoneLead = false): SubAgent[] {
    // includeLoneLead: the sidebar shows the lead even when it's the only agent;
    // the session-view grid stays a single pane until there are sub-agents.
    if (!session || (subs.length === 0 && !includeLoneLead)) return subs;
    // Meta not yet read from Rust: when in doubt the lead stays out. Showing it
    // with the "open" default made a lead the user had closed reappear for a moment
    // (and get mounted).
    if (!this.isLoaded(session.id)) {
      this.ensureLoaded(session.id);
      return subs;
    }
    if (this.leadClosed(session.id)) return subs;
    const lead: SubAgent = {
      id: AgentRosterService.LEAD_PANE_ID,
      role: 'lead',
      title: session.name || this.translate.instant('SUBAGENTS.Lead'),
      parentSessionId: session.id,
      sessionId: session.id,
      // waiting_input passes through as is: without it, a lead waiting for input
      // showed as "idle" (no attention dot/timer in the sidebar, no highlight on the pane).
      status: (session.status === 'running' || session.status === 'in_progress' || session.status === 'waiting_input'
        ? session.status : 'idle') as SubAgent['status'],
      autoPrompt: '',
      provider: session.provider as SubAgent['provider'],
      icon: 'solar:monitor-bold',
      executionMode: 'interactive',
    };
    return [lead, ...subs];
  }

  /**
   * Effective lead: the preference if it is still in the roster, otherwise the first
   * remaining pane ("the last one left becomes the main"). No state to
   * reconcile when a lead is closed: the pointer resolves itself.
   */
  effectiveLeadId(sessionId: string, roster: SubAgent[]): string | null {
    const pref = this.meta(sessionId).leadId;
    if (pref && roster.some((p) => p.id === pref)) return pref;
    return roster[0]?.id ?? null;
  }

  async setLead(sessionId: string, leadId: string | null): Promise<void> {
    if (!this.enabled) return;
    this.put(sessionId, { leadId });
    try {
      const meta = await this.api?.agentsSetLead?.(sessionId, leadId);
      if (meta) this.put(sessionId, meta);
    } catch {
      /* the preference stays local until the next load */
    }
  }

  /**
   * REAL close of the lead: Rust kills the session PTY, the members stay.
   * Resolves false when the close failed (the tile comes back): the caller tells the user.
   */
  async closeLead(sessionId: string): Promise<boolean> {
    if (!this.enabled) return false;
    this.put(sessionId, { leadClosed: true }); // optimistic: the tile disappears right away
    try {
      const meta = await this.api?.agentsCloseLead?.(sessionId);
      if (meta) this.put(sessionId, meta);
      return true;
    } catch {
      this.put(sessionId, { leadClosed: false });
      return false;
    }
  }

  /** The only way back: respawn of the session PTY with resume (via wake). */
  async reopenLead(sessionId: string, dims?: { cols: number; rows: number }): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      await this.api?.agentsReopenLead?.(sessionId, dims);
      this.put(sessionId, { leadClosed: false });
      return true;
    } catch {
      return false; // stays closed: the caller says so, the user can retry
    }
  }
}
