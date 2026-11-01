import {
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  inject,
  signal,
  computed,
  effect,
  ChangeDetectionStrategy
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import {
  AgentInjectService,
  CatalogItem,
  CatalogSecretSpec,
  ExtensionSelectionPayload,
} from '../services/agent-inject.service';

type ExtTab = 'mcp' | 'skill' | 'plugin';

@Component({
  selector: 'app-inject-agent-modal',
  standalone: true,
  imports: [FormsModule, TranslateModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <div class="modal-header">
      <h5 class="modal-title">
        <iconify-icon icon="solar:plug-circle-bold-duotone" width="18"></iconify-icon>
        {{ 'INJECT.Title' | translate }}
        <span class="provider-chip">{{ providerLabel() }}</span>
      </h5>
      <button type="button" class="btn-close" (click)="modal.dismiss()" [attr.aria-label]="'COMMON.Close' | translate"></button>
    </div>

    <div class="modal-body">
      <!-- Tabs -->
      <div class="inject-tabs">
        <button class="inject-tab" [class.active]="activeTab() === 'mcp'" (click)="activeTab.set('mcp')">
          <iconify-icon icon="solar:plug-circle-bold-duotone" width="15"></iconify-icon>
          {{ 'INJECT.Tools' | translate }}
          @if (countFor('mcp') > 0) { <span class="tab-badge">{{ countFor('mcp') }}</span> }
        </button>
        <button
          class="inject-tab"
          [class.active]="activeTab() === 'skill'"
          [class.disabled]="!supportsSkills()"
          [attr.title]="supportsSkills() ? null : ('INJECT.Only Claude' | translate)"
          (click)="supportsSkills() && activeTab.set('skill')"
        >
          <iconify-icon icon="solar:magic-stick-3-bold-duotone" width="15"></iconify-icon>
          {{ 'INJECT.Skills' | translate }}
          @if (countFor('skill') > 0) { <span class="tab-badge">{{ countFor('skill') }}</span> }
        </button>
        <button
          class="inject-tab"
          [class.active]="activeTab() === 'plugin'"
          [class.disabled]="!supportsPlugins()"
          [attr.title]="supportsPlugins() ? null : ('INJECT.Only Claude' | translate)"
          (click)="supportsPlugins() && activeTab.set('plugin')"
        >
          <iconify-icon icon="solar:widget-2-bold-duotone" width="15"></iconify-icon>
          {{ 'INJECT.Plugins' | translate }}
          @if (countFor('plugin') > 0) { <span class="tab-badge">{{ countFor('plugin') }}</span> }
        </button>
      </div>

      <div class="tab-content">
        <!-- GitHub import (skills only) -->
        @if (activeTab() === 'skill') {
          <div class="import-box" [class.expanded]="importOpen()">
            <button class="import-toggle" (click)="toggleImport()">
              <iconify-icon icon="simple-icons:github" width="14"></iconify-icon>
              <span>{{ 'INJECT.Import from GitHub' | translate }}</span>
              <iconify-icon
                [icon]="importOpen() ? 'solar:alt-arrow-up-linear' : 'solar:alt-arrow-down-linear'"
                width="12" class="import-chevron"></iconify-icon>
            </button>
            @if (importOpen()) {
              <div class="import-panel">
                <div class="import-row">
                  <input
                    type="text" class="import-input"
                    [attr.aria-label]="'INJECT.Import from GitHub' | translate"
                    [placeholder]="'INJECT.GitHub URL placeholder' | translate"
                    [ngModel]="importUrl()"
                    (ngModelChange)="onImportUrlChange($event)"
                    (keydown.enter)="submitImport()"
                    [disabled]="injectService.importingSkill()" />
                  <button class="btn btn-primary btn-sm import-btn"
                    [disabled]="injectService.importingSkill() || !importUrl().trim()"
                    (click)="submitImport()">
                    @if (injectService.importingSkill()) {
                      <iconify-icon icon="solar:refresh-bold" width="13" class="spin"></iconify-icon>
                    } @else {
                      <iconify-icon icon="solar:download-minimalistic-linear" width="13"></iconify-icon>
                    }
                    {{ 'INJECT.Import' | translate }}
                  </button>
                </div>
                @if (injectService.importError()) {
                  <div class="import-error">
                    <iconify-icon icon="solar:danger-triangle-linear" width="13"></iconify-icon>
                    {{ injectService.importError() }}
                  </div>
                }
                <div class="import-hint">{{ 'INJECT.GitHub hint' | translate }}</div>
              </div>
            }
          </div>
        }

        <!-- Search -->
        <div class="search-bar">
          <iconify-icon icon="solar:magnifer-linear" width="14" class="search-icon"></iconify-icon>
          <input
            type="text" class="search-input" ngbAutofocus
            [attr.aria-label]="'INJECT.Search' | translate"
            [placeholder]="'INJECT.Search' | translate"
            [ngModel]="search()" (ngModelChange)="search.set($event)" />
        </div>

        @if (injectService.loadingCatalog()) {
          <div class="loading-row">
            <iconify-icon icon="solar:refresh-bold" width="16" class="spin"></iconify-icon>
            {{ 'INJECT.Loading' | translate }}
          </div>
        } @else {
          <div class="item-grid">
            @for (item of currentItems(); track item.itemId) {
              <div class="inject-card" [class.selected]="isSelected(item)" (click)="toggleItem(item)"
                role="checkbox" tabindex="0" [attr.aria-checked]="isSelected(item)" [attr.aria-label]="item.name"
                (keydown.space)="$event.preventDefault(); toggleItem(item)">
                <div class="card-check">
                  <iconify-icon [icon]="isSelected(item) ? 'solar:check-circle-bold' : 'solar:record-circle-linear'" width="18"
                    [style.color]="isSelected(item) ? '#6366f1' : 'rgba(100,116,139,0.3)'"></iconify-icon>
                </div>
                <div class="card-icon">
                  <iconify-icon [icon]="kindIcon(item)" width="22"></iconify-icon>
                </div>
                <div class="card-info">
                  <div class="card-name-row">
                    <span class="card-name">{{ item.name }}</span>
                    @if (item.trust) {
                      <span class="trust-badge" [class]="'trust-' + item.trust">{{ 'INJECT.Trust ' + item.trust | translate }}</span>
                    }
                    @if (item.requiresSecrets?.length) {
                      <iconify-icon icon="solar:key-minimalistic-bold" width="11" class="key-icon"
                        [attr.title]="'INJECT.Needs a secret' | translate"></iconify-icon>
                    }
                  </div>
                  <span class="card-desc">{{ item.description }}</span>
                </div>
                <span class="card-author">{{ item.sector }}</span>
              </div>
            } @empty {
              <div class="empty-state">{{ 'INJECT.Nothing here' | translate }}</div>
            }
          </div>
        }

        <!-- Secrets required by the current selection -->
        @if (requiredSecrets().length > 0) {
          <div class="secret-box">
            <div class="secret-head">
              <iconify-icon icon="solar:key-minimalistic-bold-duotone" width="14"></iconify-icon>
              {{ 'INJECT.Secrets' | translate }}
            </div>
            <div class="secret-note">{{ 'INJECT.Secrets note' | translate }}</div>
            @for (spec of requiredSecrets(); track spec.envVar) {
              <div class="secret-row">
                <label class="secret-label" [attr.for]="'inject-secret-' + spec.envVar">{{ spec.label }}</label>
                <input
                  type="password" class="secret-input" autocomplete="off" [id]="'inject-secret-' + spec.envVar"
                  [placeholder]="spec.envVar"
                  [ngModel]="secrets()[spec.envVar] || ''"
                  (ngModelChange)="setSecret(spec.envVar, $event)" />
              </div>
            }
          </div>
        }
      </div>

      @if (totalSelected() > 0) {
        <div class="selection-summary">
          <iconify-icon icon="solar:checklist-bold-duotone" width="14"></iconify-icon>
          <span>{{ totalSelected() }} {{ 'INJECT.selected' | translate }}</span>
          <button class="clear-btn" (click)="clearAll()">{{ 'INJECT.Clear all' | translate }}</button>
        </div>
      }
    </div>

    <div class="modal-footer">
      <button class="btn btn-outline-secondary btn-sm" (click)="modal.dismiss()">
        {{ 'SESSIONS.Cancel' | translate }}
      </button>
      <button class="btn btn-primary btn-sm" [disabled]="totalSelected() === 0" (click)="confirm()">
        <iconify-icon icon="solar:plug-circle-bold-duotone" width="14" class="me-1"></iconify-icon>
        {{ 'INJECT.Apply selection' | translate }} ({{ totalSelected() }})
      </button>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .modal-title { display: flex; align-items: center; gap: 0.4rem; }
    .provider-chip {
      font-size: 0.6rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em;
      padding: 0.1rem 0.45rem; border-radius: 8px;
      background: rgba(99,102,241,0.1); color: #6366f1;
    }
    .inject-tabs {
      display: flex; gap: 0.25rem; margin-bottom: 0.75rem;
      border-bottom: 1px solid rgba(100,116,139,0.1);
    }
    .inject-tab {
      flex: 1; display: flex; align-items: center; justify-content: center; gap: 0.35rem;
      padding: 0.55rem 0.5rem; font-size: 0.78rem; font-weight: 600;
      border: none; background: transparent; color: var(--bs-secondary-color, rgba(100,116,139,0.8)); cursor: pointer;
      border-bottom: 2px solid transparent; transition: all 0.15s;
    }
    .inject-tab:hover:not(.disabled) { color: #6366f1; }
    .inject-tab.active { color: #6366f1; border-bottom-color: #6366f1; }
    .inject-tab.disabled { opacity: 0.4; cursor: not-allowed; }
    .tab-badge {
      font-size: 0.6rem; font-weight: 700; padding: 0.05rem 0.35rem; border-radius: 10px;
      background: #6366f1; color: white; min-width: 16px; text-align: center;
    }
    .tab-content { min-height: 280px; }
    .search-bar { position: relative; margin-bottom: 0.5rem; }
    .search-icon { position: absolute; inset-inline-start: 0.6rem; top: 50%; transform: translateY(-50%); color: rgba(100,116,139,0.4); }
    .search-input {
      width: 100%; padding-block: 0.4rem; padding-inline: 2rem 0.5rem; font-size: 0.75rem; border-radius: 6px;
      border: 1px solid rgba(100,116,139,0.15); background: transparent; color: inherit; outline: none;
    }
    .search-input:focus { border-color: rgba(99,102,241,0.4); }
    .item-grid { display: flex; flex-direction: column; gap: 0.3rem; max-height: 240px; overflow-y: auto; }
    .inject-card {
      display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.65rem; border-radius: 8px;
      border: 1px solid rgba(100,116,139,0.1); cursor: pointer; transition: all 0.15s;
    }
    .inject-card:hover { background: rgba(99,102,241,0.03); border-color: rgba(99,102,241,0.15); }
    .inject-card.selected { background: rgba(99,102,241,0.06); border-color: rgba(99,102,241,0.25); }
    .card-check { flex-shrink: 0; display: flex; }
    .card-icon {
      flex-shrink: 0; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;
      border-radius: 8px; background: rgba(99,102,241,0.06); color: #6366f1;
    }
    .inject-card.selected .card-icon { background: rgba(99,102,241,0.12); }
    .card-info { flex: 1; display: flex; flex-direction: column; gap: 0.05rem; min-width: 0; }
    .card-name { font-size: 0.78rem; font-weight: 600; }
    .card-desc { font-size: 0.68rem; color: var(--bs-secondary-color, rgba(100,116,139,0.8)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .card-author { flex-shrink: 0; font-size: 0.62rem; font-weight: 600; color: var(--bs-secondary-color, rgba(100,116,139,0.8)); text-transform: capitalize; }
    .card-name-row { display: flex; align-items: center; gap: 0.35rem; }
    .key-icon { color: #f59e0b; }
    .trust-badge {
      padding: 0.05rem 0.35rem; border-radius: 8px; font-size: 0.55rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.03em;
    }
    .trust-official { background: rgba(99,102,241,0.12); color: #6366f1; }
    .trust-verified { background: rgba(16,185,129,0.12); color: #10b981; }
    .trust-community { background: rgba(100,116,139,0.12); color: rgba(100,116,139,0.8); }

    .import-box {
      margin-bottom: 0.55rem; border-radius: 8px; border: 1px dashed rgba(99,102,241,0.25);
      background: rgba(99,102,241,0.03); overflow: hidden;
    }
    .import-box.expanded { border-style: solid; }
    .import-toggle {
      width: 100%; display: flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0.6rem;
      background: transparent; border: none; font-size: 0.72rem; font-weight: 600; color: #6366f1; cursor: pointer;
    }
    .import-toggle:hover { background: rgba(99,102,241,0.04); }
    .import-chevron { margin-inline-start: auto; }
    .import-panel { padding: 0.5rem 0.6rem 0.6rem; border-top: 1px solid rgba(99,102,241,0.12); display: flex; flex-direction: column; gap: 0.4rem; }
    .import-row { display: flex; gap: 0.35rem; }
    .import-input {
      flex: 1; padding: 0.35rem 0.5rem; font-size: 0.72rem; border-radius: 6px;
      border: 1px solid rgba(100,116,139,0.15); background: transparent; color: inherit; outline: none;
      font-family: 'JetBrains Mono', monospace;
    }
    .import-input:focus { border-color: rgba(99,102,241,0.4); }
    .import-btn { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.72rem; font-weight: 600; padding: 0.3rem 0.65rem; }
    .import-error { display: flex; align-items: center; gap: 0.35rem; font-size: 0.68rem; font-weight: 500; padding: 0.3rem 0.45rem; border-radius: 5px; background: rgba(248,81,73,0.08); color: #f85149; }
    .import-hint { font-size: 0.65rem; color: var(--bs-secondary-color, rgba(100,116,139,0.8)); font-family: 'JetBrains Mono', monospace; }

    .secret-box {
      margin-top: 0.6rem; padding: 0.55rem 0.65rem; border-radius: 8px;
      border: 1px solid rgba(245,158,11,0.25); background: rgba(245,158,11,0.04);
      display: flex; flex-direction: column; gap: 0.4rem;
    }
    .secret-head { display: flex; align-items: center; gap: 0.35rem; font-size: 0.72rem; font-weight: 700; color: #f59e0b; }
    .secret-note { font-size: 0.64rem; color: var(--bs-secondary-color, rgba(100,116,139,0.8)); }
    .secret-row { display: flex; align-items: center; gap: 0.5rem; }
    .secret-label { flex: 0 0 40%; font-size: 0.68rem; font-weight: 600; margin: 0; }
    .secret-input {
      flex: 1; padding: 0.3rem 0.5rem; font-size: 0.7rem; border-radius: 6px;
      border: 1px solid rgba(100,116,139,0.18); background: transparent; color: inherit; outline: none;
      font-family: 'JetBrains Mono', monospace;
    }
    .secret-input:focus { border-color: rgba(245,158,11,0.5); }

    .loading-row { display: flex; align-items: center; justify-content: center; gap: 0.5rem; padding: 2rem; font-size: 0.78rem; color: var(--bs-secondary-color, rgba(100,116,139,0.8)); }
    .empty-state { text-align: center; padding: 2rem; font-size: 0.78rem; color: var(--bs-secondary-color, rgba(100,116,139,0.8)); }
    .selection-summary {
      display: flex; align-items: center; gap: 0.4rem; margin-top: 0.65rem; padding: 0.4rem 0.6rem;
      border-radius: 6px; font-size: 0.72rem; font-weight: 600; background: rgba(99,102,241,0.06); color: #6366f1;
    }
    .clear-btn { margin-inline-start: auto; font-size: 0.65rem; font-weight: 600; background: none; border: none; color: rgba(100,116,139,0.5); cursor: pointer; text-decoration: underline; }
    .clear-btn:hover { color: #f85149; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spin { animation: spin 1s linear infinite; }
  `,
})
export class InjectAgentModalComponent {
  modal = inject(NgbActiveModal);
  protected injectService = inject(AgentInjectService);

  /** Provider of the agent being spawned. Set by the opener before display. */
  provider = signal<string>('claude-code-cli');

  activeTab = signal<ExtTab>('mcp');
  search = signal('');

  // Catalog items per kind (from the curated catalog).
  mcpItems = signal<CatalogItem[]>([]);
  skillItems = signal<CatalogItem[]>([]);
  pluginItems = signal<CatalogItem[]>([]);

  // Selection (across all tabs) + entered secret values.
  selectedItems = signal<CatalogItem[]>([]);
  secrets = signal<Record<string, string>>({});

  // GitHub custom-skill import
  importOpen = signal(false);
  importUrl = signal('');

  supportsSkills = computed(() => this.provider() === 'claude-code-cli');
  supportsPlugins = computed(() => this.provider() === 'claude-code-cli');

  providerLabel = computed(() => {
    const map: Record<string, string> = {
      'claude-code-cli': 'Claude Code',
      'gemini-cli': 'Gemini',
      'antigravity': 'Antigravity',
      'codex': 'Codex',
      'cursor': 'Cursor',
      'copilot': 'Copilot',
      'grok': 'Grok',
      'hermes': 'Hermes',
      'muse': 'Muse Code',
      'zai': 'Z.AI',
      'kimi': 'Kimi',
      'kora': 'Kora',
    };
    return map[this.provider()] ?? this.provider();
  });

  totalSelected = computed(() => this.selectedItems().length);

  currentItems = computed(() => {
    const tab = this.activeTab();
    const list = tab === 'mcp' ? this.mcpItems() : tab === 'skill' ? this.skillItems() : this.pluginItems();
    const search = this.search().toLowerCase().trim();
    if (!search) return list;
    return list.filter(i =>
      i.name.toLowerCase().includes(search) ||
      (i.description ?? '').toLowerCase().includes(search),
    );
  });

  requiredSecrets = computed(() => {
    const map = new Map<string, CatalogSecretSpec>();
    for (const item of this.selectedItems()) {
      for (const spec of item.requiresSecrets ?? []) map.set(spec.envVar, spec);
    }
    return [...map.values()];
  });

  constructor() {
    // Reactively (re)load the catalog whenever the provider changes.
    effect(() => {
      const provider = this.provider();
      void this.loadCatalogs(provider);
    });
  }

  private async loadCatalogs(provider: string): Promise<void> {
    const [mcp, skill, plugin] = await Promise.all([
      this.injectService.fetchCatalog('mcp', provider),
      this.injectService.fetchCatalog('skill', provider),
      this.injectService.fetchCatalog('plugin', provider),
    ]);
    // The provider changed while loading: a newer load owns the lists.
    if (provider !== this.provider()) return;
    this.mcpItems.set(mcp);
    this.skillItems.set(skill);
    this.pluginItems.set(plugin);
  }

  countFor(kind: ExtTab): number {
    return this.selectedItems().filter(i => i.kind === kind).length;
  }

  kindIcon(item: CatalogItem): string {
    if (item.kind === 'skill') return 'solar:magic-stick-3-bold-duotone';
    if (item.kind === 'plugin') return 'solar:widget-2-bold-duotone';
    return 'solar:plug-circle-bold-duotone';
  }

  isSelected(item: CatalogItem): boolean {
    return this.selectedItems().some(i => i.itemId === item.itemId);
  }

  toggleItem(item: CatalogItem): void {
    this.selectedItems.update(list =>
      this.isSelected(item)
        ? list.filter(i => i.itemId !== item.itemId)
        : [...list, item],
    );
  }

  setSecret(envVar: string, value: string): void {
    this.secrets.update(s => ({ ...s, [envVar]: value }));
  }

  clearAll(): void {
    this.selectedItems.set([]);
    this.secrets.set({});
  }

  toggleImport(): void {
    this.importOpen.update(v => !v);
    if (this.importOpen()) this.injectService.importError.set(null);
  }

  onImportUrlChange(value: string): void {
    this.importUrl.set(value);
    if (this.injectService.importError()) this.injectService.importError.set(null);
  }

  async submitImport(): Promise<void> {
    const url = this.importUrl().trim();
    if (!url || this.injectService.importingSkill()) return;
    try {
      const skill = await this.injectService.importCustomSkillFromGithub(url);
      const item: CatalogItem = {
        itemId: `skill.custom.${skill.slug}`,
        kind: 'skill',
        name: skill.name,
        description: skill.description,
        sector: 'custom',
        trust: 'community',
        install: {
          'claude-code-cli': {
            strategy: 'skill-folder',
            targetRelPath: `.claude/skills/${skill.slug}/SKILL.md`,
            format: 'markdown',
            payload: `---\nname: ${skill.slug}\ndescription: ${skill.description}\n---\n\n${skill.prompt_template ?? ''}\n`,
          },
        },
      };
      this.importUrl.set('');
      this.skillItems.update(list => [item, ...list.filter(i => i.itemId !== item.itemId)]);
      this.selectedItems.update(list => [...list.filter(i => i.itemId !== item.itemId), item]);
    } catch {
      // error surfaced via injectService.importError
    }
  }

  confirm(): void {
    const payload: ExtensionSelectionPayload = this.injectService.buildExtensionSelection(
      this.selectedItems(),
      this.secrets(),
    );
    this.modal.close(payload);
  }
}
