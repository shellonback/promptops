import {
  ChangeDetectionStrategy,
  Component,
  computed,
  CUSTOM_ELEMENTS_SCHEMA,
  EventEmitter,
  inject,
  Input,
  OnInit,
  Output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { ProviderService } from '@core/services/provider.service';
import {
  ProviderCapability,
  ProviderId,
  ProviderTier,
} from '@core/providers/provider-capability';

interface ProviderGroup {
  tier: ProviderTier;
  titleKey: string;
  subtitleKey: string;
  items: ProviderCapability[];
}

@Component({
  selector: 'app-provider-picker',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslateModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <div class="provider-picker">
      <div class="provider-columns">
        @for (group of groups(); track group.tier) {
          <section class="provider-group" [attr.data-tier]="group.tier">
            <header class="group-header">
              <div class="group-title-row">
                <span class="group-icon" [attr.data-tier]="group.tier" aria-hidden="true">
                  @if (group.tier === 'cloud') {
                    <i class="ti ti-cloud"></i>
                  } @else {
                    <i class="ti ti-device-desktop"></i>
                  }
                </span>
                <h4 class="group-title">
                  {{ group.titleKey | translate }}
                </h4>
                @if (group.tier === 'local') {
                  <span class="badge-free" [title]="'PROVIDERS.BADGE.FREE_TOOLTIP' | translate">
                    {{ 'PROVIDERS.BADGE.FREE' | translate }}
                  </span>
                } @else {
                  <span class="badge-pro" [title]="'PROVIDERS.BADGE.CLOUD_TOOLTIP' | translate">
                    {{ 'PROVIDERS.BADGE.CLOUD' | translate }}
                  </span>
                }
              </div>
              <p class="group-subtitle">{{ group.subtitleKey | translate }}</p>
            </header>

            <div class="provider-tiles">
              @for (p of group.items; track p.id) {
                <button
                  type="button"
                  class="provider-tile"
                  [class.is-selected]="value === p.id"
                  [attr.aria-pressed]="value === p.id"
                  [class.is-unavailable]="p.cli.detectable && !isDetected(p.id)"
                  [attr.data-accent]="p.ui.accent"
                  [disabled]="disabled"
                  [title]="(p.cli.detectable && !isDetected(p.id)) ? (p.cli.installHintKey | translate) : (p.i18n.bestForKey | translate)"
                  (click)="select(p.id)"
                >
                  <img class="tile-logo" [src]="logoFor(p.id)" alt="" />
                  <span class="tile-name">{{ p.displayName }}</span>
                  @if (p.cli.detectable && isDetected(p.id)) {
                    <span class="tile-dot tile-dot-ok" [title]="'PROVIDERS.STATUS.INSTALLED' | translate" aria-hidden="true"></span>
                    <span class="visually-hidden">{{ 'PROVIDERS.STATUS.INSTALLED' | translate }}</span>
                  } @else if (p.cli.detectable && !isDetected(p.id)) {
                    <span class="tile-dot tile-dot-warn" [title]="'PROVIDERS.STATUS.NOT_INSTALLED' | translate" aria-hidden="true"></span>
                    <span class="visually-hidden">{{ 'PROVIDERS.STATUS.NOT_INSTALLED' | translate }}</span>
                  }
                  @if (value === p.id) {
                    <i class="ti ti-check tile-check-inline" aria-hidden="true"></i>
                  }
                </button>
              }
            </div>
          </section>
        }
      </div>

      @if (selected(); as p) {
        <aside class="provider-microcopy" [attr.data-tier]="p.tier">
          <i class="ti ti-info-circle"></i>
          <span>{{ p.i18n.microcopyKey | translate }}</span>
        </aside>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }

    .provider-picker {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    /* Two-column 50/50 layout: Cloud on the left, Free local on the right.
       Stacks below 540px so the modal stays usable on narrow screens. */
    .provider-columns {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    @media (max-width: 540px) {
      .provider-columns { grid-template-columns: 1fr; }
    }

    .provider-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
      border-radius: 10px;
      border: 1px solid var(--bs-border-color, rgba(0, 0, 0, 0.08));
      background: var(--bs-tertiary-bg, rgba(255, 255, 255, 0.02));
      min-width: 0;
    }
    .provider-group[data-tier="cloud"] {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.04), rgba(168, 85, 247, 0.03));
      border-color: rgba(99, 102, 241, 0.18);
    }
    .provider-group[data-tier="local"] {
      background: linear-gradient(135deg, rgba(16, 185, 129, 0.04), rgba(52, 211, 153, 0.03));
      border-color: rgba(16, 185, 129, 0.18);
    }

    .group-header { display: flex; flex-direction: column; gap: 4px; }
    .group-title-row {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .group-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 6px;
      color: #fff;
      font-size: 13px;
      flex-shrink: 0;
    }
    .group-icon[data-tier="cloud"] {
      background: linear-gradient(135deg, #6366f1, #a855f7);
    }
    .group-icon[data-tier="local"] {
      background: linear-gradient(135deg, #10b981, #34d399);
    }
    .group-title {
      font-size: 12.5px;
      font-weight: 700;
      letter-spacing: .02em;
      color: var(--bs-body-color, #1f2937);
      margin: 0;
      flex: 1 1 auto;
      min-width: 0;
    }
    .group-subtitle {
      font-size: 11.5px;
      color: var(--bs-secondary-color, #6c757d);
      margin: 0;
      line-height: 1.35;
    }

    .badge-free, .badge-pro {
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 999px;
      color: #fff;
      flex-shrink: 0;
    }
    .badge-free {
      background: linear-gradient(135deg, #10b981, #34d399);
    }
    .badge-pro {
      background: linear-gradient(135deg, #6366f1, #a855f7);
    }

    .provider-tiles {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .provider-tile {
      position: relative;
      text-align: start;
      background: var(--bs-tertiary-bg, #f8f9fa);
      border: 1.5px solid var(--bs-border-color, rgba(0, 0, 0, 0.06));
      border-radius: 8px;
      padding: 6px 8px;
      cursor: pointer;
      transition: transform .12s ease, box-shadow .15s ease, border-color .12s ease, background .15s ease;
      font: inherit;
      color: inherit;
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 34px;
    }

    .provider-tile:hover:not([disabled]) {
      border-color: rgba(99, 102, 241, 0.45);
      background: var(--bs-body-bg, #fff);
    }

    .provider-tile.is-selected {
      border-color: #6366f1;
      box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.18);
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.08), rgba(168, 85, 247, 0.08));
    }

    .provider-tile.is-unavailable { opacity: .7; }
    .provider-tile[disabled] { cursor: not-allowed; opacity: .5; }

    .tile-check-inline {
      color: #6366f1;
      font-size: 14px;
      flex-shrink: 0;
      margin-inline-start: auto;
    }

    .tile-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      flex-shrink: 0;
      margin-inline-start: auto;
    }
    .tile-dot-ok { background: var(--promptops-success, #198754); box-shadow: 0 0 0 2px rgba(25, 135, 84, 0.18); }
    .tile-dot-warn { background: var(--promptops-warning, #ffc107); box-shadow: 0 0 0 2px rgba(255, 193, 7, 0.2); }

    .provider-tile.is-selected .tile-dot + .tile-check-inline,
    .provider-tile.is-selected .tile-check-inline {
      margin-inline-start: 2px;
    }
    .provider-tile.is-selected .tile-dot { margin-inline-start: auto; }

    .tile-logo {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      object-fit: contain;
      flex-shrink: 0;
    }

    .tile-name {
      font-size: 12.5px;
      font-weight: 600;
      line-height: 1.2;
      color: var(--bs-body-color, #1f2937);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      flex: 1 1 auto;
    }

    .provider-microcopy {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 10px;
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.08), rgba(168, 85, 247, 0.08));
      border: 1px solid rgba(99, 102, 241, 0.18);
      color: var(--bs-body-color, #1f2937);
      font-size: 12.5px;
      line-height: 1.4;
    }
    .provider-microcopy[data-tier="local"] {
      background: rgba(16, 185, 129, 0.10);
      border-color: rgba(16, 185, 129, 0.22);
    }
    .provider-microcopy i {
      color: #6366f1;
      font-size: 14px;
      flex-shrink: 0;
    }
    .provider-microcopy[data-tier="local"] i { color: #10b981; }
  `],
})
export class ProviderPickerComponent implements OnInit {
  private readonly providers = inject(ProviderService);

  /** Signal-backed so `selected()` (the microcopy) follows every change: a plain
   *  field is invisible to `computed`, which kept describing the first pick. */
  private readonly valueSig = signal<ProviderId>('claude-code-cli');
  @Input() set value(v: ProviderId) { this.valueSig.set(v); }
  get value(): ProviderId { return this.valueSig(); }
  @Input() disabled = false;
  @Output() valueChange = new EventEmitter<ProviderId>();

  readonly manifests = signal<ProviderCapability[]>([]);
  readonly detected = this.providers.detected;

  readonly groups = computed<ProviderGroup[]>(() => {
    const ms = this.manifests();
    const groups: ProviderGroup[] = [
      {
        tier: 'cloud',
        titleKey: 'PROVIDERS.GROUP.RECOMMENDED',
        subtitleKey: 'PROVIDERS.GROUP.RECOMMENDED_SUB',
        items: ms.filter((p) => p.tier === 'cloud'),
      },
      {
        tier: 'local',
        titleKey: 'PROVIDERS.GROUP.FREE_LOCAL',
        subtitleKey: 'PROVIDERS.GROUP.FREE_LOCAL_SUB',
        items: ms.filter((p) => p.tier === 'local'),
      },
    ];
    return groups.filter((g) => g.items.length > 0);
  });

  readonly selected = computed<ProviderCapability | null>(() => {
    const ms = this.manifests();
    const value = this.valueSig();
    return ms.find((p) => p.id === value) ?? null;
  });

  async ngOnInit(): Promise<void> {
    const list = await this.providers.listProviders();
    this.manifests.set(list);
  }

  /** Brand logos — same assets as the spawn provider select. */
  private static readonly LOGO: Record<string, string> = {
    'claude-code-cli': 'assets/providers/claude.svg',
    'codex': 'assets/providers/openai.svg',
    'gemini-cli': 'assets/providers/gemini.svg',
    'antigravity': 'assets/providers/antigravity.svg',
    'copilot': 'assets/providers/copilot.svg',
    'cursor': 'assets/providers/cursor.svg',
    'grok': 'assets/providers/grok.svg',
    'hermes': 'assets/providers/hermes.svg',
    'muse': 'assets/providers/muse.svg',
    'zai': 'assets/providers/zai.svg',
    'kimi': 'assets/providers/kimi.svg',
    'opencode': 'assets/providers/terminal.svg',
    'kora': 'assets/providers/kora.svg',
    'promptops-cli': 'assets/providers/terminal.svg',
    'generic-shell': 'assets/providers/terminal.svg',
  };

  logoFor(id: ProviderId): string {
    return ProviderPickerComponent.LOGO[id] ?? 'assets/providers/terminal.svg';
  }

  isDetected(id: ProviderId): boolean {
    return this.detected().has(id);
  }

  select(id: ProviderId): void {
    if (this.disabled || this.value === id) return;
    this.value = id;
    this.valueChange.emit(id);
  }
}
