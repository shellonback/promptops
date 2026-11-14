import { Injectable, inject, signal } from '@angular/core';
import { SessionService } from './session.service';

export interface SessionStateInfo {
  /** Settings → Context management (off by default). */
  global: boolean;
  available: boolean;
  enabled: boolean;
  /** 'not_git' | 'ignored' | 'not_ignored' */
  git: string;
}

export interface SessionStateStatus {
  /** Workspace turned on and the session has its backend id. */
  active: boolean;
  /** The instructions are already in the system prompt of the running CLI. */
  instructed: boolean;
}

type Bridge = {
  getSessionStateGlobal?: () => Promise<boolean>;
  setSessionStateGlobal?: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  getSessionStateInfo?: (workspacePath: string) => Promise<SessionStateInfo>;
  setSessionState?: (workspacePath: string, enabled: boolean, exclusion?: string | null) => Promise<{ ok: boolean; error?: string }>;
  getSessionStateStatus?: (sessionId: string) => Promise<SessionStateStatus>;
  getSessionStateInstructions?: (sessionId: string) => Promise<string | null>;
};

const OFF: SessionStateInfo = { global: false, available: false, enabled: false, git: 'not_git' };

/**
 * Session state (plan "Context management", phase 1). Off by default per
 * workspace; every call is a no-op on an older bridge. Nothing here polls:
 * values are read when the user opens the menu.
 */
@Injectable({ providedIn: 'root' })
export class SessionStateService {
  private sessionService = inject(SessionService);
  /** Sessions that received the instructions by message in this run. */
  private sentByMessage = new Set<string>();

  /** Settings → Context management. Off by default; the source of truth is the desktop app. */
  readonly globalEnabled = signal(false);
  /** The desktop bridge knows the feature (false in the browser or on older builds). */
  readonly supported = signal(false);
  private loaded = false;

  async loadGlobal(): Promise<void> {
    const fn = this.bridge?.getSessionStateGlobal;
    this.supported.set(!!fn);
    if (!fn || this.loaded) return;
    try { this.globalEnabled.set(!!(await fn())); this.loaded = true; } catch { this.globalEnabled.set(false); }
  }

  async setGlobal(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const fn = this.bridge?.setSessionStateGlobal;
    if (!fn) return { ok: false, error: 'unavailable' };
    try {
      const res = await fn(enabled);
      if (res?.ok) this.globalEnabled.set(enabled);
      return res ?? { ok: false };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  private get bridge(): Bridge | null {
    if (!this.sessionService.isTauri) return null;
    return ((window as unknown as { promptops?: Bridge }).promptops) ?? null;
  }

  async info(workspacePath: string | undefined | null): Promise<SessionStateInfo> {
    const fn = this.bridge?.getSessionStateInfo;
    if (!fn || !workspacePath) return OFF;
    try { return (await fn(workspacePath)) ?? OFF; } catch { return OFF; }
  }

  async set(workspacePath: string, enabled: boolean, exclusion?: 'info_exclude' | 'gitignore'): Promise<{ ok: boolean; error?: string }> {
    const fn = this.bridge?.setSessionState;
    if (!fn) return { ok: false, error: 'unavailable' };
    try { return await fn(workspacePath, enabled, exclusion ?? null); } catch (e) { return { ok: false, error: String(e) }; }
  }

  async status(sessionId: string): Promise<SessionStateStatus> {
    const fn = this.bridge?.getSessionStateStatus;
    const none = { active: false, instructed: false };
    if (!fn) return none;
    try {
      const s = (await fn(sessionId)) ?? none;
      return { ...s, instructed: s.instructed || this.sentByMessage.has(sessionId) };
    } catch { return none; }
  }

  /**
   * Sends the instructions to an already-open session as one message. Only
   * on the user's click, and only while the agent is idle: the main PTY has
   * no guard of its own against typing in the middle of a turn.
   */
  async sendInstructions(sessionId: string, sessionStatus: string | undefined): Promise<boolean> {
    if (sessionStatus !== 'idle') return false;
    const fn = this.bridge?.getSessionStateInstructions;
    if (!fn) return false;
    let text: string | null = null;
    try { text = await fn(sessionId); } catch { text = null; }
    if (!text) return false;
    await this.sessionService.writeSession(sessionId, `\x1b[200~${text}\x1b[201~`);
    await new Promise((r) => setTimeout(r, 120));
    await this.sessionService.writeSession(sessionId, '\r');
    this.sentByMessage.add(sessionId);
    return true;
  }
}
