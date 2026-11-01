import { inject, Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { wakeSession } from '../../../../../store/sessions/session.actions';
import { SessionSummary } from '../../../../../store/sessions/session.state';
import { SessionService } from './session.service';
import { SubAgentService } from './sub-agent.service';

/**
 * Injects a prompt into a session's terminal, waking the session first when
 * it has no live PTY. The start-to-session flows (feedback detail, task board)
 * target sessions that may be parked (auto-standby) or restored from the DB
 * without a terminal: a bare writeSession resolves { ok: false } and the
 * prompt silently vanishes. Waking goes through the store's wakeSession
 * action — the single choke point that also seeds the sub-agent stash.
 */
@Injectable({ providedIn: 'root' })
export class PromptInjectionService {
  private store = inject(Store);
  private sessionService = inject(SessionService);
  private subAgentService = inject(SubAgentService);

  /**
   * Write a prompt into an existing session, waking it if needed.
   * Resolves true once the terminal accepted the write.
   */
  async injectIntoSession(session: SessionSummary, prompt: string, title?: string): Promise<boolean> {
    if (!this.sessionService.isDesktop) return false;

    // "Start in session" = a NEW sub-agent in that session (same as the
    // board opened from a session), not text typed into the lead terminal,
    // which may be busy, fullscreen or without a PTY. A parked parent is
    // woken first so the sub-agent lands in a live session.
    if (session.standbyAt) {
      this.store.dispatch(wakeSession({ sessionId: session.id }));
      await this.sleep(2500);
    }
    const agentTitle = (title || prompt.split('\n').find((l) => l.trim()) || 'Task').trim().substring(0, 40);
    try {
      const agent = await this.subAgentService.spawnCustom(session.id, 'task', agentTitle, prompt);
      if (agent) return true;
    } catch {
      // Spawn refused by main: fall back to the lead terminal below.
    }

    // Live PTY: write immediately (previous behavior, no extra latency).
    if (!session.standbyAt && (await this.tryWrite(session.id, prompt + '\r'))) {
      return true;
    }

    // Parked or no live terminal: wake (idempotent on main), then retry
    // while the provider boots with --resume.
    this.store.dispatch(wakeSession({ sessionId: session.id }));
    const ok = await this.writeWithRetries(session.id, prompt, [2500, 2500, 3000]);
    if (ok) this.scheduleSubmitRetry(session.id);
    return ok;
  }

  /**
   * Inject the initial prompt into a freshly created session once its
   * provider has had time to boot. Replaces the old flat setTimeout(2000):
   * retries when the PTY isn't up yet and re-sends the submit Enter the TUI
   * can swallow during boot.
   */
  injectIntoNewSession(sessionId: string, prompt: string): void {
    if (!this.sessionService.isDesktop) return;
    setTimeout(async () => {
      const ok = await this.writeWithRetries(sessionId, prompt, [0, 1500, 2500]);
      if (ok) this.scheduleSubmitRetry(sessionId);
    }, 2000);
  }

  private async writeWithRetries(sessionId: string, prompt: string, delays: number[]): Promise<boolean> {
    for (const delay of delays) {
      if (delay > 0) await this.sleep(delay);
      if (await this.tryWrite(sessionId, prompt + '\r')) return true;
    }
    return false;
  }

  private async tryWrite(sessionId: string, data: string): Promise<boolean> {
    try {
      const res = await this.sessionService.writeSession(sessionId, data);
      return !!res?.ok;
    } catch {
      return false;
    }
  }

  /**
   * A provider TUI still booting can swallow the trailing Enter even though
   * the text landed. Re-send a bare Enter after a beat — on an already
   * submitted prompt it is a harmless empty line. countPrompt=false keeps it
   * out of the prompt-count ledger.
   */
  private scheduleSubmitRetry(sessionId: string): void {
    setTimeout(() => {
      this.sessionService.writeSession(sessionId, '\r', { countPrompt: false }).catch(() => {});
    }, 2000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
