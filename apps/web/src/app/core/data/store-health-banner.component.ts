import { ChangeDetectionStrategy, Component, computed, CUSTOM_ELEMENTS_SCHEMA, inject, OnInit, signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { DataBackend } from './data-backend';

/** What `store.health` reports about the local data file (local_store.rs `StoreHealth`). */
export interface StoreHealth {
  /** Where an unreadable data file was moved when the app had to start empty. */
  quarantined?: string;
  /** Why changes are not saved (data from a newer version, another running copy). */
  readOnly?: string;
  /** Records this device cannot open; they stay on disk, sealed. */
  unreadable: number;
  formatVersion: number;
}

export type ReadOnlyKind = 'newer' | 'busy' | 'other';

/** Maps the desktop shell's read-only reason to a translated message. */
export function readOnlyKind(reason: string): ReadOnlyKind {
  if (/newer version/i.test(reason)) return 'newer';
  if (/another copy/i.test(reason)) return 'busy';
  return 'other';
}

/** localStorage key: how many unreadable records the user already acknowledged. */
export const UNREADABLE_ACK_KEY = 'promptops.storeHealth.unreadableAck';

/**
 * True when the only news is records this device cannot open: nothing is
 * lost or blocked, so it is an information, not an error.
 */
export function storeHealthIsInfoOnly(h: StoreHealth): boolean {
  return !h.quarantined && !h.readOnly && (h.unreadable ?? 0) > 0;
}

/** True when the report has something the user must know. */
export function storeHealthNeedsNotice(h: StoreHealth | null | undefined): h is StoreHealth {
  return !!h && (!!h.quarantined || !!h.readOnly || (h.unreadable ?? 0) > 0);
}

/**
 * Tells the user, once per start, when the local data file could not be used
 * as-is: it was unreadable and set aside (the app started empty), it is
 * read-only (newer format, or another copy of the app holds it), or some
 * records cannot be opened on this device. Without this the app would just
 * look empty or silently drop changes.
 */
@Component({
  selector: 'app-store-health-banner',
  standalone: true,
  imports: [TranslateModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (health(); as h) {
      @if (!dismissed()) {
        <div class="store-health-banner" [class.info]="info()" [attr.role]="info() ? 'status' : 'alert'" data-testid="store-health-banner">
          <div class="d-flex align-items-start gap-2">
            <iconify-icon [attr.icon]="info() ? 'solar:info-circle-bold-duotone' : 'solar:folder-error-bold-duotone'" width="20"
                          [style.color]="info() ? '#2563eb' : '#dc2626'" aria-hidden="true"></iconify-icon>
            <div class="flex-grow-1">
              <strong>{{ 'STORE_HEALTH.Title' | translate }}</strong>
              @if (h.quarantined) {
                <div data-testid="store-health-quarantined">
                  {{ 'STORE_HEALTH.Quarantined' | translate }}
                  <code class="store-health-path">{{ h.quarantined }}</code>
                </div>
              }
              @if (h.readOnly) {
                <div data-testid="store-health-read-only">
                  @switch (kind(h.readOnly)) {
                    @case ('newer') { {{ 'STORE_HEALTH.Read only newer' | translate }} }
                    @case ('busy') { {{ 'STORE_HEALTH.Read only busy' | translate }} }
                    @default { {{ 'STORE_HEALTH.Read only other' | translate }} <code>{{ h.readOnly }}</code> }
                  }
                </div>
              }
              @if (h.unreadable > 0) {
                <div data-testid="store-health-unreadable">
                  {{ 'STORE_HEALTH.Unreadable' | translate: { count: h.unreadable } }}
                  @if (info()) { <span class="store-health-hint">{{ 'STORE_HEALTH.Unreadable hint' | translate }}</span> }
                </div>
              }
            </div>
            <button type="button" class="btn btn-sm btn-link text-muted" (click)="dismiss()"
                    [attr.aria-label]="'BUTTONS.Close' | translate" [title]="'BUTTONS.Close' | translate">
              <iconify-icon icon="solar:close-circle-linear" width="18"></iconify-icon>
            </button>
          </div>
        </div>
      }
    }
  `,
  styles: [`
    .store-health-banner {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 9999;
      padding: 10px 20px;
      font-size: 0.88rem;
      /* Fixed light background with dark text, readable under every skin. */
      color: #1e293b;
      background: #fef2f2;
      border-bottom: 1px solid #fca5a5;
    }
    .store-health-banner.info {
      background: #eff6ff;
      border-bottom-color: #bfdbfe;
    }
    .store-health-hint { color: #475569; }
    .store-health-banner strong { color: #111827; }
    .store-health-banner .text-muted { color: #6b7280 !important; }
    .store-health-banner code {
      font-size: 0.78rem;
      background: #f3f4f6;
      color: #b91c1c;
      padding: 2px 6px;
      border-radius: 4px;
      word-break: break-all;
    }
  `],
})
export class StoreHealthBannerComponent implements OnInit {
  private data = inject(DataBackend);

  readonly health = signal<StoreHealth | null>(null);
  readonly dismissed = signal(false);
  readonly kind = readOnlyKind;
  readonly info = computed(() => {
    const h = this.health();
    return !!h && storeHealthIsInfoOnly(h);
  });

  ngOnInit(): void {
    this.data
      .call<StoreHealth>('store.health')
      .then((h) => {
        if (!storeHealthNeedsNotice(h)) return;
        // Records already acknowledged: show again only if there are more.
        if (storeHealthIsInfoOnly(h) && h.unreadable <= this.acknowledged()) return;
        this.health.set(h);
      })
      // Outside the desktop shell there is no store to report on.
      .catch(() => undefined);
  }

  dismiss(): void {
    const h = this.health();
    if (h && storeHealthIsInfoOnly(h)) {
      try { localStorage.setItem(UNREADABLE_ACK_KEY, String(h.unreadable)); } catch { /* storage off */ }
    }
    this.dismissed.set(true);
  }

  private acknowledged(): number {
    try { return Number(localStorage.getItem(UNREADABLE_ACK_KEY)) || 0; } catch { return 0; }
  }
}
