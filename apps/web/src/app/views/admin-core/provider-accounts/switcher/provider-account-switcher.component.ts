import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  output,
} from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { NgbDropdownModule, NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { TranslatePipe, TranslateService } from "@ngx-translate/core";
import {
  PROVIDER_LABELS,
  ProviderAccount,
  ProviderAccountsService,
  ProviderId,
} from "../services/provider-accounts.service";
import { openManageAccountsModal } from "../modal/manage-accounts-modal.component";
import { PROVIDER_LOGOS } from "../../sessions/services/spawn-providers.const";

type SwitcherMode = "picker" | "global";

/**
 * Unified dropdown for selecting a provider account.
 *
 * - mode="picker":   controlled. Emits valueChange. `value` is:
 *       undefined → inherit the active account for the provider
 *       null      → opt-out (spawn without env injection)
 *       string    → specific account id
 *   Renders the "Inherit" option if showInherit is true.
 *
 * - mode="global":   uncontrolled. Reads the currently active account from the
 *   service and calls setActive() on pick. Good for the top bar.
 */
@Component({
  selector: "po-provider-account-switcher",
  standalone: true,
  imports: [NgbDropdownModule, TranslatePipe],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div ngbDropdown class="d-inline-block" container="body" [placement]="placement()">
      <button
        type="button"
        ngbDropdownToggle
        class="pa-chip"
        [class.pa-chip-compact]="compact()"
        [class.pa-chip-icononly]="iconOnly()"
        [class.pa-chip-disabled]="isDisabled()"
        [class.pa-chip-standard]="!currentAccount() && mode() === 'global'"
        [style.border-color]="iconOnly() ? accountColor() : null"
        [style.color]="iconOnly() ? accountColor() : null"
        [disabled]="isDisabled()"
        [attr.title]="tooltip()"
      >
        @if (logoFor(provider()); as logo) {
          <img [src]="logo" class="pa-provider-logo" width="14" height="14" alt="" />
        } @else {
          <iconify-icon [attr.icon]="iconFor(provider())" width="14"></iconify-icon>
        }
        @if (iconOnly()) {
          @if (accountColor(); as c) {
            <span class="pa-dot pa-dot-badge" [style.background-color]="c"></span>
          }
        } @else {
          @if (currentAccount(); as a) {
            @if (a.color) {
              <span class="pa-dot" [style.background-color]="a.color"></span>
            }
            <span class="pa-label">{{ a.name }}</span>
          } @else {
            <span class="pa-label pa-muted">
              @if (mode() === 'global') {
                {{ providerLabel(provider()) }} · {{ 'PROVIDER_ACCOUNTS.Standard' | translate }}
              } @else {
                {{ 'PROVIDER_ACCOUNTS.SWITCHER.Inherit' | translate }}
              }
            </span>
          }
          <iconify-icon icon="solar:alt-arrow-down-bold" width="10"></iconify-icon>
        }
      </button>

      <div ngbDropdownMenu class="pa-menu">
        <div class="pa-menu-header">
          <small class="text-muted">{{ 'PROVIDER_ACCOUNTS.SWITCHER.Accounts of' | translate: { provider: providerLabel(provider()) } }}</small>
          @if (supportLabel(); as s) {
            <span class="pa-support" [class]="'pa-support-' + s.key">{{ s.label }}</span>
          }
        </div>

        @if (mode() === 'picker' && showInherit()) {
          <button
            type="button"
            ngbDropdownItem
            class="pa-item"
            [class.pa-item-active]="value() === undefined"
            (click)="pick(undefined)"
          >
            <iconify-icon icon="solar:link-bold" width="14"></iconify-icon>
            <div class="pa-item-text">
              <span>{{ 'PROVIDER_ACCOUNTS.SWITCHER.Inherit active' | translate }}</span>
              @if (activeAccount(); as a) {
                <small class="text-muted">{{ 'PROVIDER_ACCOUNTS.SWITCHER.Uses' | translate: { name: a.name } }}</small>
              } @else {
                <small class="text-muted">{{ 'PROVIDER_ACCOUNTS.SWITCHER.Uses standard' | translate }}</small>
              }
            </div>
          </button>
          <div class="pa-divider"></div>
        }

        <!-- Standard / CLI default — your normal installation, no override. -->
        <button
          type="button"
          ngbDropdownItem
          class="pa-item pa-item-standard"
          [class.pa-item-active]="isStandardSelected()"
          (click)="pickStandard()"
        >
          <iconify-icon icon="solar:home-smile-bold-duotone" width="14"></iconify-icon>
          <div class="pa-item-text">
            <span>{{ 'PROVIDER_ACCOUNTS.Standard' | translate }}</span>
            @if (capability()?.defaultCliPath; as p) {
              <small class="text-muted">{{ p }}</small>
            } @else {
              <small class="text-muted">{{ 'PROVIDER_ACCOUNTS.SWITCHER.Normal install' | translate }}</small>
            }
          </div>
          @if (isStandardSelected() && mode() === 'global') {
            <small class="pa-badge-active">{{ 'PROVIDER_ACCOUNTS.Active' | translate }}</small>
          }
        </button>

        @if (accounts().length > 0) {
          <div class="pa-divider"></div>
          <div class="pa-menu-subheader">
            <small class="text-muted">{{ 'PROVIDER_ACCOUNTS.SWITCHER.Managed accounts' | translate }}</small>
          </div>
          @for (a of accounts(); track a.id) {
            <button
              type="button"
              ngbDropdownItem
              class="pa-item"
              [class.pa-item-active]="isSelected(a.id)"
              (click)="pick(a.id)"
            >
              @if (a.color) {
                <span class="pa-dot" [style.background-color]="a.color"></span>
              } @else {
                <iconify-icon icon="solar:user-circle-bold-duotone" width="14"></iconify-icon>
              }
              <span class="flex-grow-1 text-truncate">{{ a.name }}</span>
              @if (isActiveAccount(a.id) && mode() === 'global') {
                <small class="pa-badge-active">{{ 'PROVIDER_ACCOUNTS.Active' | translate }}</small>
              }
            </button>
          }
        }

        <div class="pa-divider"></div>
        <button ngbDropdownItem type="button" class="pa-item" (click)="openManageAccounts()">
          <iconify-icon icon="solar:settings-bold-duotone" width="14"></iconify-icon>
          <span>{{ 'PROVIDER_ACCOUNTS.SWITCHER.Manage accounts' | translate }}</span>
        </button>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: inline-block;
      }
      .pa-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-radius: 999px;
        border: 1px solid rgba(99, 102, 241, 0.3);
        background: rgba(99, 102, 241, 0.08);
        color: inherit;
        font-size: 12px;
        line-height: 1;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease;
      }
      .pa-provider-logo {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        object-fit: contain;
      }
      .pa-chip::after {
        display: none !important;
      }
      .pa-chip:hover:not(:disabled) {
        background: rgba(99, 102, 241, 0.16);
      }
      .pa-chip-compact {
        padding: 3px 6px;
        font-size: 11px;
      }
      .pa-chip-disabled,
      .pa-chip:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .pa-chip-standard {
        border-style: dashed;
        background: transparent;
      }
      .pa-chip-icononly {
        position: relative;
        padding: 4px 6px;
      }
      .pa-dot-badge {
        position: absolute;
        right: -1px;
        bottom: -1px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        border: 1px solid var(--bs-body-bg, #fff);
      }
      .pa-label {
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pa-muted {
        color: var(--bs-secondary-color, #9ca3af);
      }
      .pa-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        display: inline-block;
      }
      .pa-menu {
        min-width: 260px;
        max-width: 320px;
        padding: 6px 0;
      }
      .pa-menu-header {
        padding: 4px 12px 6px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .pa-menu-subheader {
        padding: 2px 12px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 10px;
      }
      .pa-item-text {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        line-height: 1.15;
        flex-grow: 1;
        gap: 1px;
      }
      .pa-item-text small {
        font-size: 10px;
      }
      .pa-item-standard {
        border-left: 2px solid var(--bs-primary, #6366f1);
      }
      .pa-support {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 4px;
      }
      .pa-support-native {
        background: rgba(34, 197, 94, 0.18);
        color: #16a34a;
      }
      .pa-support-partial {
        background: rgba(245, 158, 11, 0.18);
        color: #d97706;
      }
      .pa-support-unsupported {
        background: rgba(107, 114, 128, 0.2);
        color: #9ca3af;
      }
      .pa-item {
        display: flex !important;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
      }
      .pa-item-active {
        background: rgba(99, 102, 241, 0.12);
      }
      .pa-item .pa-dot {
        width: 10px;
        height: 10px;
      }
      .pa-empty {
        padding: 10px 12px;
        font-size: 12px;
        color: var(--bs-secondary-color, #9ca3af);
        text-align: center;
      }
      .pa-divider {
        height: 1px;
        background: var(--bs-border-color, rgba(255, 255, 255, 0.1));
        margin: 4px 0;
      }
      .pa-badge-active {
        background: var(--bs-primary, #6366f1);
        color: #fff;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 10px;
      }
    `,
  ],
})
export class ProviderAccountSwitcherComponent implements OnInit {
  readonly svc = inject(ProviderAccountsService);
  private readonly modalService = inject(NgbModal);
  private readonly translate = inject(TranslateService);
  /** Changes on every language switch: the computed labels below read it so they re-translate. */
  private readonly lang = toSignal(this.translate.onLangChange, { initialValue: null });

  readonly provider = input.required<ProviderId>();
  readonly mode = input<SwitcherMode>("picker");
  readonly value = input<string | null | undefined>(undefined);
  readonly showInherit = input<boolean>(true);
  readonly allowOptOut = input<boolean>(false);
  readonly compact = input<boolean>(false);
  readonly iconOnly = input<boolean>(false);
  readonly placement = input<string>("bottom-end");

  readonly valueChange = output<string | null | undefined>();

  readonly accounts = computed(() => this.svc.accountsFor(this.provider()));
  readonly activeAccount = computed(() => this.svc.activeFor(this.provider()));
  readonly capability = computed(() => this.svc.capabilityFor(this.provider()));
  /** Color of the effective account (inherit resolves to the active one). */
  readonly accountColor = computed(() => this.currentAccount()?.color ?? null);

  readonly currentAccount = computed(() => {
    if (this.mode() === "global") return this.activeAccount();
    const v = this.value();
    if (v === undefined) return this.activeAccount();
    if (v === null) return null;
    return this.accounts().find((a) => a.id === v) ?? null;
  });

  readonly isDisabled = computed(() => {
    const cap = this.svc.capabilityFor(this.provider());
    return cap?.support === "unsupported" && this.accounts().length === 0;
  });

  readonly supportLabel = computed<{ key: string; label: string } | null>(() => {
    this.lang();
    const cap = this.svc.capabilityFor(this.provider());
    if (!cap) return null;
    const map: Record<string, string> = {
      native: this.translate.instant("PROVIDER_ACCOUNTS.SWITCHER.Native"),
      partial: this.translate.instant("PROVIDER_ACCOUNTS.SWITCHER.Partial"),
      unsupported: this.translate.instant("PROVIDER_ACCOUNTS.SWITCHER.Unsupported"),
    };
    return { key: cap.support, label: map[cap.support] ?? cap.support };
  });

  readonly tooltip = computed(() => {
    this.lang();
    const p = this.providerLabel(this.provider());
    const a = this.currentAccount();
    if (this.mode() === "global") {
      return a
        ? this.translate.instant("PROVIDER_ACCOUNTS.SWITCHER.Tip global", { provider: p, name: a.name })
        : this.translate.instant("PROVIDER_ACCOUNTS.SWITCHER.Tip none", { provider: p });
    }
    if (a) return this.translate.instant("PROVIDER_ACCOUNTS.SWITCHER.Tip account", { provider: p, name: a.name });
    return this.translate.instant("PROVIDER_ACCOUNTS.SWITCHER.Tip inherit", { provider: p });
  });

  ngOnInit(): void {
    void this.svc.init();
  }

  providerLabel(p: ProviderId): string {
    return PROVIDER_LABELS[p];
  }

  /** Real provider logo (same assets as the spawn chip); null → fallback icon. */
  logoFor(p: ProviderId): string | null {
    return PROVIDER_LOGOS[p] ?? null;
  }

  iconFor(p: ProviderId): string {
    const map: Partial<Record<ProviderId, string>> = {
      "claude-code-cli": "solar:user-circle-bold-duotone",
      codex: "solar:chat-square-code-bold-duotone",
      "gemini-cli": "solar:stars-bold-duotone",
      antigravity: "solar:rocket-2-bold-duotone",
      copilot: "solar:plain-bold-duotone",
      cursor: "solar:cursor-bold-duotone",
      grok: "solar:black-hole-bold-duotone",
      opencode: "solar:code-square-bold-duotone",
      "generic-shell": "solar:file-terminal-bold-duotone",
    };
    return map[p] ?? "solar:file-terminal-bold-duotone";
  }

  openManageAccounts(): void {
    openManageAccountsModal(this.modalService);
  }

  isSelected(id: string): boolean {
    if (this.mode() === "global") return this.activeAccount()?.id === id;
    return this.value() === id;
  }

  isActiveAccount(id: string): boolean {
    return this.activeAccount()?.id === id;
  }

  /** "Standard" is selected when no managed account is active / chosen. */
  isStandardSelected(): boolean {
    if (this.mode() === "global") return this.activeAccount() === null;
    return this.value() === null;
  }

  /** Click "Standard" — global: clear active; picker: emit null (opt-out). */
  pickStandard(): void {
    if (this.mode() === "global") {
      void this.svc.setActive(null, this.provider());
      return;
    }
    this.valueChange.emit(null);
  }

  pick(value: string | null | undefined): void {
    if (this.mode() === "global") {
      if (value === undefined || value === null) return;
      void this.svc.setActive(value, this.provider());
      return;
    }
    this.valueChange.emit(value);
  }
}
