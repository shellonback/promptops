import { Injectable, inject } from '@angular/core';
import { Store } from '@ngrx/store';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { SwalService } from '@core/services/swal.service';
import { wakeSession } from '../../../../../store/sessions/session.actions';
import { getSessions } from '../../../../../store/sessions/session.selectors';
import { SessionService } from './session.service';

interface AccountCheck {
  mismatch: boolean;
  provider: string;
  /** "" = default config (no PromptOps account). */
  sessionAccountId: string | null;
  sessionAccountName: string | null;
  currentAccountId: string | null;
  currentAccountName: string | null;
}

interface AccountGuardApi {
  checkSessionAccount?: (sessionId: string) => Promise<AccountCheck>;
  prepareSessionAccountRelaunch?: (sessionId: string) => Promise<{ ok: boolean }>;
  onProviderAccountActiveChanged?: (
    cb: (ev: unknown, data: { provider: string; accountId: string | null }) => void,
  ) => () => void;
}

/**
 * Account switch from AI Accounts (Tauri v2). A Claude conversation lives in
 * the config dir of the account that started it, so a session opened with
 * the previous account cannot be resumed on the new one. This guard spots
 * those sessions and lets the user reopen them on the new account (new
 * conversation) or keep them pinned to the old one.
 */
@Injectable({ providedIn: 'root' })
export class SessionAccountGuardService {
  private store = inject(Store);
  private sessionService = inject(SessionService);
  private swal = inject(SwalService);
  private translate = inject(TranslateService);
  /** Sessions already resolved by the user: their next wake skips the check. */
  private resolved = new Set<string>();
  private listening = false;

  private api(): AccountGuardApi | undefined {
    return (window as unknown as { promptops?: AccountGuardApi }).promptops;
  }

  /** Listens for active-account changes and asks about the live sessions left behind. */
  init(): void {
    const api = this.api();
    if (this.listening || !this.sessionService.isTauri || !api?.onProviderAccountActiveChanged) return;
    this.listening = true;
    api.onProviderAccountActiveChanged((_ev, data) => {
      void this.reviewLiveSessions(data.provider);
    });
  }

  /**
   * Called before a wake. Resolves false when the user dismissed the dialog
   * (no wake); true otherwise, with the session already prepared for the
   * chosen account.
   */
  async beforeWake(sessionId: string): Promise<boolean> {
    if (this.resolved.delete(sessionId)) return true;
    const check = await this.check(sessionId);
    if (!check?.mismatch) return true;
    const choice = await this.ask(check, 1);
    if (choice === 'cancel') return false;
    await this.apply(sessionId, check, choice);
    return true;
  }

  private async reviewLiveSessions(provider: string): Promise<void> {
    const sessions = await firstValueFrom(this.store.select(getSessions));
    const live = sessions.filter((s) => s.provider === provider && !s.standbyAt);
    const checks = await Promise.all(live.map(async (s) => ({ id: s.id, check: await this.check(s.id) })));
    const stale = checks.filter((c): c is { id: string; check: AccountCheck } => !!c.check?.mismatch);
    if (!stale.length) return;
    const choice = await this.ask(stale[0].check, stale.length);
    if (choice === 'cancel') return;
    for (const { id, check } of stale) {
      await this.apply(id, check, choice);
      if (choice === 'confirm') {
        this.resolved.add(id);
        this.store.dispatch(wakeSession({ sessionId: id }));
      }
    }
  }

  private async check(sessionId: string): Promise<AccountCheck | null> {
    try {
      return (await this.api()?.checkSessionAccount?.(sessionId)) ?? null;
    } catch {
      return null;
    }
  }

  private ask(check: AccountCheck, count: number): Promise<'confirm' | 'deny' | 'cancel'> {
    const fallback = this.translate.instant('SESSIONS.ACCOUNT_GUARD.DefaultAccount');
    const oldName = check.sessionAccountName || fallback;
    const newName = check.currentAccountName || fallback;
    return this.swal.choose({
      title: this.translate.instant('SESSIONS.ACCOUNT_GUARD.Title'),
      message: this.translate.instant(
        count > 1 ? 'SESSIONS.ACCOUNT_GUARD.MessageMany' : 'SESSIONS.ACCOUNT_GUARD.Message',
        { count, oldName, newName },
      ),
      confirmText: this.translate.instant('SESSIONS.ACCOUNT_GUARD.Reopen', { newName }),
      denyText: this.translate.instant('SESSIONS.ACCOUNT_GUARD.Keep', { oldName }),
    });
  }

  /** confirm = park + fresh conversation on the active account; deny = pin the old account. */
  private async apply(sessionId: string, check: AccountCheck, choice: 'confirm' | 'deny'): Promise<void> {
    try {
      if (choice === 'confirm') {
        await this.api()?.prepareSessionAccountRelaunch?.(sessionId);
      } else {
        // "" = default config → explicit opt-out (null), so the resume keeps using it.
        await this.sessionService.updateSessionMeta(sessionId, {
          providerAccountId: check.sessionAccountId || null,
        });
      }
    } catch {
      /* best-effort: the wake goes on with the current behavior */
    }
  }
}
