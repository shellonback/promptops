import {
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  inject,
  input,
  output,
  signal,
  computed,
  effect,
  ElementRef,
  ViewChild,
  HostListener,
  ChangeDetectionStrategy
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SessionAssetsService, AssetInfo, AssetIntent } from '../services/session-assets.service';
import { IntentService, EnhanceDepth } from '../services/intent.service';
import { SubAgentProvider } from '../services/sub-agent.service';
import { TooltipDirective } from '../../../../common/tooltip.directive';
import { FileDropZoneDirective, fileUrisFromDrop } from '../../../../common/file-drop-zone.directive';
import { KebabMenuComponent, KebabMenuItem } from '../../../../common/kebab-menu/kebab-menu.component';
import { EscCloseDirective } from '../../../../common/esc-close.directive';

@Component({
  selector: 'app-session-assets-panel',
  standalone: true,
  imports: [FormsModule, TranslateModule, TooltipDirective, KebabMenuComponent, FileDropZoneDirective, EscCloseDirective],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: './session-assets-panel.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    :host {
      display: block;
    }

    .assets-panel {
      border-top: 2px solid rgba(88, 166, 255, 0.3);
      background: var(--po-bg-2);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .assets-resize-handle {
      height: 4px;
      cursor: row-resize;
      background: transparent;
      flex-shrink: 0;
      position: relative;
      z-index: 5;
      transition: background 0.15s;
    }
    .assets-resize-handle:hover,
    .assets-resize-handle:active {
      background: rgba(88, 166, 255, 0.4);
    }

    .assets-panel.collapsed {
      height: 36px !important;
    }

    .assets-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.3rem 0.75rem;
      background: rgba(88, 166, 255, 0.06);
      cursor: pointer;
      user-select: none;
      flex-shrink: 0;
    }
    .assets-header:hover {
      background: rgba(88, 166, 255, 0.12);
    }

    .assets-title {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--po-info);
    }

    .assets-header-actions {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .btn-header-action {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-header-action:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--po-text-primary);
    }

    .assets-body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 0.5rem;
    }

    .assets-error {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      margin-bottom: 0.5rem;
      padding: 0.3rem 0.45rem;
      border-radius: 6px;
      font-size: 0.68rem;
      color: var(--po-error);
      background: var(--po-error-bg);
    }
    .assets-error-text {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .assets-error-close {
      display: flex;
      border: none;
      padding: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }

    /* ── Drop Zone ── */
    .drop-zone {
      border: 2px dashed var(--po-border-subtle);
      border-radius: 8px;
      padding: 1.5rem;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s;
      margin-bottom: 0.5rem;
    }
    .drop-zone:hover,
    .drop-zone.drag-over {
      border-color: #58a6ff;
      background: rgba(88, 166, 255, 0.06);
    }
    .drop-zone.drag-over {
      transform: scale(1.01);
    }

    .drop-zone-icon {
      color: var(--po-info);
      margin-bottom: 0.5rem;
    }

    .drop-zone-text {
      font-size: 0.78rem;
      color: var(--po-text-secondary);
      margin: 0;
    }
    .drop-zone-hint {
      font-size: 0.65rem;
      color: var(--po-text-secondary);
      opacity: 0.7;
      margin: 0.25rem 0 0;
    }

    /* ── Assets Grid ── */
    .assets-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 0.5rem;
    }

    .asset-card {
      background: var(--po-bg-0);
      border: 1px solid var(--po-border-subtle);
      border-radius: 8px;
      overflow: hidden;
      cursor: pointer;
      transition: all 0.15s;
      position: relative;
    }
    .asset-card:hover {
      border-color: rgba(88, 166, 255, 0.4);
      transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    }
    .asset-card.selected {
      border-color: #58a6ff;
      box-shadow: 0 0 0 1px #58a6ff;
    }

    .asset-preview {
      width: 100%;
      height: 80px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.2);
      overflow: hidden;
    }

    .asset-preview img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .asset-preview-icon {
      color: var(--po-text-secondary);
    }

    .asset-info {
      padding: 0.35rem 0.5rem;
    }

    .asset-name {
      font-size: 0.7rem;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--po-text-primary);
    }

    .asset-meta {
      font-size: 0.6rem;
      color: var(--po-text-secondary);
    }

    .asset-checkbox {
      position: absolute;
      top: 4px;
      inset-inline-start: 4px;
      z-index: 2;
    }

    .asset-checkbox input {
      width: 14px;
      height: 14px;
      cursor: pointer;
    }

    .asset-actions {
      position: absolute;
      top: 4px;
      inset-inline-end: 4px;
      display: flex;
      gap: 2px;
      opacity: 0;
      transition: opacity 0.15s;
    }
    .asset-card:hover .asset-actions,
    .asset-card.menu-open .asset-actions {
      opacity: 1;
    }
    /* The copy confirmation stays visible even if the pointer leaves the card. */
    .asset-actions:has(.copied),
    .asset-actions:has(.copy-failed) {
      opacity: 1;
    }

    .btn-asset-action {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border: none;
      border-radius: 3px;
      background: rgba(0, 0, 0, 0.6);
      color: var(--po-text-primary);
      cursor: pointer;
      font-size: 0.65rem;
    }
    .btn-asset-action:hover {
      background: rgba(0, 0, 0, 0.8);
    }
    .btn-asset-action.delete:hover {
      background: rgba(248, 81, 73, 0.8);
    }

    /* ── Esito copia (card, barra selezione, composer) ── */
    .btn-asset-action.copied,
    .sel-btn.copied,
    .composer-close.copied {
      color: #3fb950;
    }
    .btn-asset-action.copy-failed,
    .sel-btn.copy-failed,
    .composer-close.copy-failed {
      color: #f85149;
    }

    /* ── Multi-select Toolbar (Google Drive style) ── */
    .selection-bar {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.45rem 0.5rem;
      border-top: 1px solid var(--po-border-subtle);
      background: rgba(88, 166, 255, 0.08);
      flex-shrink: 0;
      animation: selectionBarIn 0.15s var(--po-ease-out, ease-out);
    }

    @keyframes selectionBarIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .selection-count {
      font-size: 0.68rem;
      font-weight: 600;
      color: var(--po-info);
      white-space: nowrap;
    }

    .selection-actions {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      flex-wrap: wrap;
      flex: 1;
    }

    .sel-btn {
      display: flex;
      align-items: center;
      gap: 0.2rem;
      padding: 0.28rem 0.5rem;
      border: 1px solid var(--po-border-subtle);
      border-radius: 6px;
      font-size: 0.68rem;
      font-weight: 600;
      cursor: pointer;
      background: transparent;
      color: var(--po-text-secondary);
      transition: all 0.15s;
    }
    .sel-btn:hover {
      background: rgba(255, 255, 255, 0.06);
      color: var(--po-text-primary);
    }
    .sel-btn.analyze {
      border-color: rgba(88, 166, 255, 0.3);
      color: var(--po-info);
    }
    .sel-btn.analyze:hover {
      background: rgba(88, 166, 255, 0.12);
      border-color: rgba(88, 166, 255, 0.5);
    }
    .sel-btn.debug {
      border-color: rgba(248, 81, 73, 0.3);
      color: var(--po-error);
    }
    .sel-btn.debug:hover {
      background: var(--po-error-bg);
      border-color: rgba(248, 81, 73, 0.5);
    }
    .sel-btn.explain {
      border-color: rgba(210, 153, 34, 0.3);
      color: var(--po-warning);
    }
    .sel-btn.explain:hover {
      background: var(--po-warning-bg);
      border-color: rgba(210, 153, 34, 0.5);
    }
    .sel-btn.prompt {
      border-color: rgba(163, 113, 247, 0.3);
      color: #a371f7;
    }
    .sel-btn.prompt:hover {
      background: rgba(163, 113, 247, 0.12);
      border-color: rgba(163, 113, 247, 0.5);
    }
    .sel-btn.delete:hover {
      background: rgba(248, 81, 73, 0.15);
      border-color: rgba(248, 81, 73, 0.5);
      color: var(--po-error);
    }

    .sel-clear {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      flex-shrink: 0;
      margin-inline-start: auto;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: all 0.15s;
    }
    .sel-clear:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--po-text-primary);
    }

    /* ── Image Preview Modal ── */
    .preview-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.8);
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }

    .preview-content {
      max-width: 90vw;
      max-height: 90vh;
      position: relative;
    }

    .preview-content img {
      max-width: 100%;
      max-height: 85vh;
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }

    .preview-close {
      position: absolute;
      top: -12px;
      inset-inline-end: -12px;
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 50%;
      background: rgba(248, 81, 73, 0.9);
      color: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .preview-filename {
      text-align: center;
      color: var(--po-text-primary);
      font-size: 0.8rem;
      margin-top: 0.5rem;
    }

    /* ── Rename Input ── */
    .rename-input {
      font-size: 0.7rem;
      padding: 1px 4px;
      background: var(--po-bg-0);
      border: 1px solid #58a6ff;
      border-radius: 3px;
      color: var(--po-text-primary);
      width: 100%;
    }

    /* ── Uploading indicator ── */
    .uploading-overlay {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 0.75rem;
      background: rgba(88, 166, 255, 0.08);
      border-radius: 8px;
      margin-bottom: 0.5rem;
    }
    .uploading-text {
      font-size: 0.75rem;
      color: var(--po-info);
      font-weight: 500;
    }

    /* ── Ask-AI primary button (selection bar) ── */
    .sel-btn.ai {
      border-color: var(--po-accent);
      color: var(--po-accent);
      background: var(--po-accent-muted-bg);
    }
    .sel-btn.ai:hover {
      background: var(--po-accent);
      color: var(--po-accent-on);
      border-color: var(--po-accent);
    }

    /* ── AI Composer ── */
    .ai-composer {
      border-top: 1px solid var(--po-border-subtle);
      padding: 0.55rem 0.6rem;
      background: var(--po-accent-muted-bg);
      flex-shrink: 0;
      animation: selectionBarIn 0.15s var(--po-ease-out, ease-out);
    }

    .composer-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.45rem;
    }
    .composer-title {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.72rem;
      font-weight: 600;
      color: var(--po-accent);
    }
    .composer-count {
      color: var(--po-text-secondary);
      font-weight: 500;
    }
    .composer-head-actions {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .composer-close {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: all 0.15s;
    }
    .composer-close:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--po-text-primary);
    }

    .intent-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
      margin-bottom: 0.5rem;
    }
    .intent-chip {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.22rem 0.55rem;
      border: 1px solid var(--po-border-subtle);
      border-radius: 999px;
      background: transparent;
      color: var(--po-text-secondary);
      font-size: 0.66rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    }
    .intent-chip:hover {
      color: var(--po-text-primary);
      border-color: var(--po-border-strong);
    }
    .intent-chip.active {
      background: var(--po-accent);
      border-color: var(--po-accent);
      color: var(--po-accent-on);
    }

    .prompt-textarea {
      width: 100%;
      min-height: 72px;
      max-height: 160px;
      resize: vertical;
      padding: 0.45rem 0.55rem;
      font-size: 0.72rem;
      font-family: var(--po-font-mono, 'JetBrains Mono', monospace);
      background: var(--po-bg-0);
      border: 1px solid var(--po-border-subtle);
      border-radius: 6px;
      color: var(--po-text-primary);
      line-height: 1.45;
    }
    .prompt-textarea:focus {
      outline: none;
      border-color: var(--po-accent);
      box-shadow: 0 0 0 2px var(--po-accent-muted-bg);
    }
    .prompt-textarea:disabled {
      opacity: 0.6;
    }

    .composer-tools {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.45rem;
    }
    .composer-enhance {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.28rem 0.55rem;
      border: 1px solid rgba(163, 113, 247, 0.35);
      border-radius: 6px;
      background: transparent;
      color: #a371f7;
      font-size: 0.68rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    }
    .composer-enhance:hover:not(:disabled) {
      background: rgba(163, 113, 247, 0.12);
      border-color: rgba(163, 113, 247, 0.6);
    }
    .composer-enhance:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .depth-seg {
      display: inline-flex;
      border: 1px solid var(--po-border-subtle);
      border-radius: 6px;
      overflow: hidden;
    }
    .depth-opt {
      padding: 0.24rem 0.5rem;
      border: none;
      background: transparent;
      color: var(--po-text-secondary);
      font-size: 0.62rem;
      font-weight: 600;
      text-transform: capitalize;
      cursor: pointer;
      transition: all 0.12s;
    }
    .depth-opt:not(:last-child) {
      border-inline-end: 1px solid var(--po-border-subtle);
    }
    .depth-opt.active {
      background: var(--po-accent-muted-bg);
      color: var(--po-accent);
    }
    .depth-opt:hover:not(.active) {
      background: rgba(255, 255, 255, 0.05);
      color: var(--po-text-primary);
    }

    .composer-send {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.55rem;
      flex-wrap: wrap;
    }
    .dest-seg {
      display: inline-flex;
      border: 1px solid var(--po-border-subtle);
      border-radius: 6px;
      overflow: hidden;
    }
    .dest-opt {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.3rem 0.55rem;
      border: none;
      background: transparent;
      color: var(--po-text-secondary);
      font-size: 0.66rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.12s;
    }
    .dest-opt:not(:last-child) {
      border-inline-end: 1px solid var(--po-border-subtle);
    }
    .dest-opt.active {
      background: var(--po-accent-muted-bg);
      color: var(--po-accent);
    }
    .dest-opt:hover:not(.active) {
      background: rgba(255, 255, 255, 0.05);
      color: var(--po-text-primary);
    }

    .composer-send-btn {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.34rem 0.7rem;
      border: none;
      border-radius: 6px;
      background: var(--po-accent);
      color: var(--po-accent-on);
      font-size: 0.7rem;
      font-weight: 600;
      cursor: pointer;
      transition: filter 0.15s, opacity 0.15s;
    }
    .composer-send-btn:hover:not(:disabled) {
      filter: brightness(1.08);
    }
    .composer-send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .composer-send-btn .kbd-hint {
      font-size: 0.58rem;
      padding: 1px 4px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.18);
      color: var(--po-accent-on);
    }
    .composer-cancel {
      margin-inline-start: auto;
      padding: 0.34rem 0.6rem;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--po-text-secondary);
      font-size: 0.68rem;
      cursor: pointer;
      transition: all 0.15s;
    }
    .composer-cancel:hover {
      background: rgba(255, 255, 255, 0.06);
      color: var(--po-text-primary);
    }

    /* ── Highlight glow ── */
    .asset-card.highlighted {
      border-color: #58a6ff;
      box-shadow: 0 0 12px rgba(88, 166, 255, 0.5), 0 0 4px rgba(88, 166, 255, 0.3);
      animation: highlightPulse 1.5s ease-in-out;
    }

    @keyframes highlightPulse {
      0% { box-shadow: 0 0 0 rgba(88, 166, 255, 0); }
      30% { box-shadow: 0 0 16px rgba(88, 166, 255, 0.6), 0 0 6px rgba(88, 166, 255, 0.4); }
      100% { box-shadow: 0 0 0 rgba(88, 166, 255, 0); }
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .spinner {
      animation: spin 1s linear infinite;
    }
  `,
})
export class SessionAssetsPanelComponent {
  workspacePath = input<string | undefined>();
  sessionId = input<string | null>(null);
  sessionProvider = input<string | undefined>();
  onSendToTerminal = output<string>();
  onSpawnSubAgent = output<{ prompt: string; title: string }>();
  /** Fired whenever the panel changes the vertical layout (expand/collapse/
   *  resize end) so the parent can re-clamp siblings and refit terminals. */
  layoutChanged = output<void>();

  protected assetsService = inject(SessionAssetsService);
  private intentService = inject(IntentService);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private translate = inject(TranslateService);
  private destroyRef = inject(DestroyRef);
  @ViewChild('fileInput') fileInputRef!: ElementRef<HTMLInputElement>;

  private static readonly PANEL_HEIGHT_KEY = 'promptops_assets_panel_height';
  private static readonly AI_DEST_KEY = 'promptops_assets_ai_destination';
  private static readonly MIN_HEIGHT = 120;
  private static readonly MAX_HEIGHT = 600;
  private static readonly DEFAULT_HEIGHT = 280;

  collapsed = signal(true);
  panelHeight = signal(SessionAssetsPanelComponent.DEFAULT_HEIGHT);
  private resizing = false;
  private resizeStartY = 0;
  private resizeStartHeight = 0;
  private resizeMaxHeight = SessionAssetsPanelComponent.MAX_HEIGHT;
  dragOver = signal(false);
  uploading = signal(false);
  selectedAssets = signal<Set<string>>(new Set());
  previewAsset = signal<AssetInfo | null>(null);
  previewDataUrl = signal<string | null>(null);
  renamingAsset = signal<string | null>(null);
  renameValue = signal('');
  highlightedAssets = signal<Set<string>>(new Set());
  viewMode = signal<'grid' | 'list'>('grid');
  /** Last failed file operation, shown inline in the panel until dismissed or the next success. */
  actionError = signal<string | null>(null);
  // ── AI Composer state ──
  composerOpen = signal(false);
  composerAssets = signal<AssetInfo[]>([]);
  activeIntent = signal<AssetIntent>('implement');
  composerText = signal('');
  enhanceDepth = signal<EnhanceDepth>('medium');
  enhancing = signal(false);
  aiDestination = signal<'session' | 'subagent'>('session');
  readonly depths: EnhanceDepth[] = ['short', 'medium', 'strong'];

  orderedIntents = computed<AssetIntent[]>(() => this.assetsService.orderIntents(this.composerAssets()));

  assets = this.assetsService.assets;
  thumbnailCache = signal<Map<string, string>>(new Map());

  hasSelection = computed(() => this.selectedAssets().size > 0);
  selectedCount = computed(() => this.selectedAssets().size);
  selectedItems = computed(() => {
    const sel = this.selectedAssets();
    return this.assets().filter(a => sel.has(a.name));
  });

  /** Name of the asset whose kebab menu is currently open (keeps its actions visible). */
  menuOpenAsset = signal<string | null>(null);

  /**
   * Result of the last copy, for the visual confirmation on the button that triggered it.
   * `key` is `card:<name>` for a card's actions, 'selection' or 'composer'
   * for the bars. Without this a successful copy was indistinguishable from a
   * failed one: the button stayed identical in both cases.
   */
  copyState = signal<{ key: string; ok: boolean } | null>(null);
  private copyStateTimer: ReturnType<typeof setTimeout> | null = null;
  private copyStateCleanup = this.destroyRef.onDestroy(() => {
    if (this.copyStateTimer) clearTimeout(this.copyStateTimer);
  });

  /**
   * Per-card kebab items. Same actions for every card; the target asset is
   * provided via the `(select)` handler. Rebuilt on language change.
   */
  cardMenuItems = signal<KebabMenuItem[]>([]);

  private loadEffect = effect(() => {
    const ws = this.workspacePath();
    if (ws) {
      this.assetsService.loadAssets(ws)
        .then(() => this.loadThumbnails())
        .catch(err => {
          // Outside the desktop app there is no bridge: nothing to report.
          if ((window as any).promptops) this.reportError('ASSETS.Load failed', err);
        });
    }
  });

  private externalUploadEffect = effect(() => {
    const names = this.assetsService.lastUploadedNames();
    if (names.length === 0) return;
    if (this.collapsed()) {
      this.expandPanel();
    }
    this.highlightedAssets.set(new Set(names));
    setTimeout(() => this.highlightedAssets.set(new Set()), 1600);
    this.loadThumbnails();
    queueMicrotask(() => this.assetsService.lastUploadedNames.set([]));
  });

  constructor() {
    const saved = localStorage.getItem(SessionAssetsPanelComponent.PANEL_HEIGHT_KEY);
    if (saved) {
      const h = parseInt(saved, 10);
      if (!isNaN(h)) {
        this.panelHeight.set(Math.max(SessionAssetsPanelComponent.MIN_HEIGHT, Math.min(h, SessionAssetsPanelComponent.MAX_HEIGHT)));
      }
    }

    const dest = localStorage.getItem(SessionAssetsPanelComponent.AI_DEST_KEY);
    if (dest === 'session' || dest === 'subagent') {
      this.aiDestination.set(dest);
    }

    this.buildCardMenu();
    this.translate.onLangChange
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.buildCardMenu());

    // Destroyed mid-drag (session switch): don't leave the whole app with a row-resize cursor.
    this.destroyRef.onDestroy(() => {
      if (!this.resizing) return;
      this.resizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  /** Surface a failed file operation inline (translated prefix + bridge message). */
  private reportError(key: string, err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err ?? '');
    this.actionError.set(this.translate.instant(key, { error: detail }));
  }

  /** (Re)build the per-card kebab menu with translated labels. */
  private buildCardMenu(): void {
    const t = (key: string) => this.translate.instant(key);
    this.cardMenuItems.set([
      { id: 'copy-abs', label: t('ASSETS.Copy absolute path'), icon: 'solar:copy-bold-duotone' },
      { id: 'copy-name', label: t('ASSETS.Copy name'), icon: 'solar:tag-bold' },
      { id: 'rename', label: t('SESSIONS.TOOLTIPS.Rename'), icon: 'solar:pen-bold', divider: true },
      { id: 'delete', label: t('SESSIONS.TOOLTIPS.Delete'), icon: 'solar:trash-bin-minimalistic-bold', danger: true },
    ]);
  }

  // ── Vertical Resize ──

  /**
   * Clamp a desired panel height against the real free space of the parent
   * .terminal-area column, so the panel can never squeeze the accordion/main
   * pane into painting terminals under this panel. Reserve constants mirror
   * the CSS minimums in session-view: main-pane 120 + 8px margins ×2 = 136,
   * accordion expanded min-height 120 + handle/header ≈ 150.
   */
  private clampPanelHeight(desired: number): number {
    let max = SessionAssetsPanelComponent.MAX_HEIGHT;
    const area = this.host.nativeElement.parentElement;
    if (area) {
      const accordion = area.querySelector(':scope > .subagents-accordion') as HTMLElement | null;
      const git = area.querySelector(':scope > app-session-git-panel') as HTMLElement | null;
      const accordionReserve = accordion
        ? (accordion.classList.contains('expanded') ? 150 : accordion.offsetHeight)
        : 0;
      const mainReserve = area.classList.contains('cover-main') ? 0 : 136;
      max = Math.min(max, area.clientHeight - accordionReserve - (git?.offsetHeight ?? 0) - mainReserve);
    }
    return Math.max(SessionAssetsPanelComponent.MIN_HEIGHT, Math.min(desired, max));
  }

  /** Expand the panel, clamping its height to the space actually available. */
  private expandPanel(): void {
    this.collapsed.set(false);
    this.panelHeight.update(h => this.clampPanelHeight(h));
    this.layoutChanged.emit();
  }

  startResize(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.resizing = true;
    this.resizeStartY = event.clientY;
    this.resizeStartHeight = this.panelHeight();
    // Measure once per drag: clampPanelHeight reads layout, and mousemove
    // fires 60+/s — caching avoids layout thrash during the drag.
    this.resizeMaxHeight = this.clampPanelHeight(Number.MAX_SAFE_INTEGER);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }

  @HostListener('document:mousemove', ['$event'])
  onResizeMove(event: MouseEvent): void {
    if (!this.resizing) return;
    // Panel grows upward, so dragging up (negative deltaY) increases height
    const deltaY = this.resizeStartY - event.clientY;
    const newHeight = Math.max(
      SessionAssetsPanelComponent.MIN_HEIGHT,
      Math.min(this.resizeStartHeight + deltaY, this.resizeMaxHeight),
    );
    this.panelHeight.set(newHeight);
  }

  @HostListener('document:mouseup')
  onResizeEnd(): void {
    if (!this.resizing) return;
    this.resizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(SessionAssetsPanelComponent.PANEL_HEIGHT_KEY, String(this.panelHeight()));
    this.layoutChanged.emit();
  }

  private async loadThumbnails(): Promise<void> {
    const ws = this.workspacePath();
    if (!ws) return;

    const cache = new Map<string, string>();
    for (const asset of this.assets()) {
      if (asset.isImage) {
        try {
          const { data, mimeType } = await this.assetsService.readAssetBase64(ws, asset.name);
          cache.set(asset.name, `data:${mimeType};base64,${data}`);
        } catch { /* skip */ }
      }
    }
    // Workspace switched while reading: these thumbnails belong to the old one.
    if (ws !== this.workspacePath()) return;
    this.thumbnailCache.set(cache);
  }

  // ── Drop Zone Handlers (enter/leave/highlight via appFileDropZone) ──

  async onDrop(event: DragEvent): Promise<void> {
    const files = event.dataTransfer?.files;
    if (files?.length) {
      await this.handleUpload(Array.from(files));
      return;
    }
    // Linux/WebKitGTK: drop dal file manager con solo text/uri-list.
    const paths = fileUrisFromDrop(event);
    if (paths.length) await this.handlePathUpload(paths);
  }

  private async handlePathUpload(paths: string[]): Promise<void> {
    const ws = this.workspacePath();
    if (!ws) return;
    if (this.collapsed()) {
      this.expandPanel();
    }
    this.uploading.set(true);
    try {
      const added = await this.assetsService.importPaths(ws, paths);
      if (!added) return;
      await this.loadThumbnails();
      const names = added.map(a => a.name);
      if (names.length > 0) {
        this.highlightedAssets.set(new Set(names));
        setTimeout(() => this.highlightedAssets.set(new Set()), 1600);
      }
    } catch (err) {
    } finally {
      this.uploading.set(false);
    }
  }

  openFilePicker(): void {
    this.fileInputRef?.nativeElement.click();
  }

  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    await this.handleUpload(Array.from(input.files));
    input.value = '';
  }

  private async handleUpload(files: File[]): Promise<void> {
    const ws = this.workspacePath();
    if (!ws) return;

    // Auto-expand panel
    if (this.collapsed()) {
      this.expandPanel();
    }

    const existingNames = new Set(this.assets().map(a => a.name));

    this.uploading.set(true);
    this.actionError.set(null);
    try {
      await this.assetsService.uploadFiles(ws, files);
      await this.loadThumbnails();
      // Highlight newly added assets
      const newNames = this.assets()
        .filter(a => !existingNames.has(a.name))
        .map(a => a.name);
      if (newNames.length > 0) {
        this.highlightedAssets.set(new Set(newNames));
        setTimeout(() => this.highlightedAssets.set(new Set()), 1600);
      }
    } catch (err) {
      this.reportError('ASSETS.Upload failed', err);
    } finally {
      this.uploading.set(false);
    }
  }

  /** Expand panel and highlight given asset names */
  expandAndHighlight(names: string[]): void {
    if (this.collapsed()) {
      this.expandPanel();
    }
    if (names.length > 0) {
      this.highlightedAssets.set(new Set(names));
      setTimeout(() => this.highlightedAssets.set(new Set()), 1600);
    }
  }

  // ── Selection ──

  toggleSelect(asset: AssetInfo, event: Event): void {
    event.stopPropagation();
    this.selectedAssets.update(set => {
      const next = new Set(set);
      if (next.has(asset.name)) {
        next.delete(asset.name);
      } else {
        next.add(asset.name);
      }
      return next;
    });
  }

  selectAll(): void {
    this.selectedAssets.set(new Set(this.assets().map(a => a.name)));
  }

  clearSelection(): void {
    this.selectedAssets.set(new Set());
  }

  // ── Clipboard ──

  /** Absolute on-disk path of an asset (workspace + relative path). */
  private absolutePath(asset: AssetInfo): string {
    const ws = this.workspacePath();
    return ws ? `${ws.replace(/\/+$/, '')}/${asset.relativePath}` : asset.relativePath;
  }

  /** True while the copy button identified by `key` shows its outcome. */
  copyOutcome(key: string): 'ok' | 'ko' | null {
    const state = this.copyState();
    if (!state || state.key !== key) return null;
    return state.ok ? 'ok' : 'ko';
  }

  /** Copy + transient outcome badge on the button that triggered it. */
  private async runCopy(key: string, text: string): Promise<void> {
    const ok = await this.assetsService.copyToClipboard(text);
    if (this.copyStateTimer) clearTimeout(this.copyStateTimer);
    this.copyState.set({ key, ok });
    this.copyStateTimer = setTimeout(() => this.copyState.set(null), 1600);
  }

  /** Copy the workspace-relative path — the default, most-used action. */
  copyRelativePath(asset: AssetInfo, event: Event): void {
    event.stopPropagation();
    void this.runCopy(`card:${asset.name}`, asset.relativePath);
  }

  /** Copy the relative paths of all selected assets (one per line). */
  copySelectedPaths(): void {
    const items = this.selectedItems();
    if (items.length === 0) return;
    void this.runCopy('selection', items.map(a => a.relativePath).join('\n'));
  }

  /** Copy the relative paths of the assets in the open composer (one per line). */
  copyComposerPaths(): void {
    const items = this.composerAssets();
    if (items.length === 0) return;
    void this.runCopy('composer', items.map(a => a.relativePath).join('\n'));
  }

  /** Handle a kebab menu selection for a single asset card. */
  onCardMenuSelect(asset: AssetInfo, id: string): void {
    switch (id) {
      case 'copy-abs':
        void this.runCopy(`card:${asset.name}`, this.absolutePath(asset));
        break;
      case 'copy-name':
        void this.runCopy(`card:${asset.name}`, asset.name);
        break;
      case 'rename':
        this.startRename(asset, new Event('click'));
        break;
      case 'delete':
        this.deleteAsset(asset, new Event('click'));
        break;
    }
  }

  /** Keep a card's hover actions visible while its kebab menu is open. */
  onCardMenuOpenChange(asset: AssetInfo, open: boolean): void {
    this.menuOpenAsset.set(open ? asset.name : null);
  }

  // ── Delete ──

  async deleteAsset(asset: AssetInfo, event: Event): Promise<void> {
    event.stopPropagation();
    const ws = this.workspacePath();
    if (!ws) return;

    try {
      await this.assetsService.deleteAsset(ws, asset.name);
    } catch (err) {
      this.reportError('ASSETS.Delete failed', err);
      return;
    }
    this.selectedAssets.update(set => {
      const next = new Set(set);
      next.delete(asset.name);
      return next;
    });
  }

  /** Delete every currently selected asset, then clear the selection. */
  async deleteSelected(): Promise<void> {
    const ws = this.workspacePath();
    if (!ws) return;
    const items = this.selectedItems();
    if (items.length === 0) return;

    try {
      for (const asset of items) {
        await this.assetsService.deleteAsset(ws, asset.name);
      }
    } catch (err) {
      // Keep the selection on what is left so the user can retry.
      this.reportError('ASSETS.Delete failed', err);
      const left = new Set(this.assets().map(a => a.name));
      this.selectedAssets.update(set => new Set([...set].filter(n => left.has(n))));
      return;
    }
    this.clearSelection();
  }

  // ── Rename ──

  startRename(asset: AssetInfo, event: Event): void {
    event.stopPropagation();
    this.renamingAsset.set(asset.name);
    this.renameValue.set(asset.name);
  }

  async confirmRename(event: Event): Promise<void> {
    event.stopPropagation();
    const ws = this.workspacePath();
    const oldName = this.renamingAsset();
    const newName = this.renameValue().trim();
    if (!ws || !oldName || !newName || oldName === newName) {
      this.renamingAsset.set(null);
      return;
    }

    try {
      await this.assetsService.renameAsset(ws, oldName, newName);
    } catch (err) {
      this.reportError('ASSETS.Rename failed', err);
    } finally {
      this.renamingAsset.set(null);
    }
  }

  cancelRename(): void {
    this.renamingAsset.set(null);
  }

  // ── Preview ──

  async openPreview(asset: AssetInfo): Promise<void> {
    if (this.renamingAsset()) return;
    if (!asset.isImage) return;

    const ws = this.workspacePath();
    if (!ws) return;

    try {
      const { data, mimeType } = await this.assetsService.readAssetBase64(ws, asset.name);
      this.previewDataUrl.set(`data:${mimeType};base64,${data}`);
      this.previewAsset.set(asset);
    } catch (err) {
      this.reportError('ASSETS.Preview failed', err);
    }
  }

  closePreview(): void {
    this.previewAsset.set(null);
    this.previewDataUrl.set(null);
  }

  // ── AI Composer ──

  /** Open the composer for the current selection, pre-seeded with the best intent. */
  openComposer(): void {
    const selected = this.selectedItems();
    if (selected.length === 0) return;

    this.composerAssets.set(selected);
    const top = this.assetsService.orderIntents(selected)[0] ?? 'implement';
    this.activeIntent.set(top);
    this.composerText.set(this.assetsService.buildIntentPrompt(selected, top));
    this.composerOpen.set(true);
  }

  /** Switch intent — re-seeds the editable prompt from the new template. */
  selectIntent(intent: AssetIntent): void {
    this.activeIntent.set(intent);
    this.composerText.set(this.assetsService.buildIntentPrompt(this.composerAssets(), intent));
  }

  setDepth(depth: EnhanceDepth): void {
    this.enhanceDepth.set(depth);
  }

  /** AI-refine the current prompt text using the shared enhance engine. */
  async enhanceComposer(): Promise<void> {
    const text = this.composerText().trim();
    if (!text || this.enhancing()) return;

    this.enhancing.set(true);
    const started = Date.now();
    try {
      const enhanced = await this.intentService.enhancePrompt(
        text,
        (this.sessionProvider() || 'claude-code-cli') as SubAgentProvider,
        '',
        '',
        this.enhanceDepth(),
      );
      if (enhanced) this.composerText.set(enhanced);
    } catch {
      /* keep the original text */
    } finally {
      const elapsed = Date.now() - started;
      if (elapsed < 350) await new Promise(r => setTimeout(r, 350 - elapsed));
      this.enhancing.set(false);
    }
  }

  /** Send the composed prompt to the chosen destination and remember the choice. */
  send(dest: 'session' | 'subagent'): void {
    const prompt = this.composerText().trim();
    if (!prompt) return;

    this.aiDestination.set(dest);
    try {
      localStorage.setItem(SessionAssetsPanelComponent.AI_DEST_KEY, dest);
    } catch {
      /* ignore storage failures */
    }

    if (dest === 'session') {
      this.onSendToTerminal.emit(prompt + '\n');
    } else {
      this.onSpawnSubAgent.emit({ prompt, title: this.composerTitle() });
    }
    this.closeComposer();
    this.clearSelection();
  }

  /** Send via the remembered default destination (primary split-button action). */
  sendDefault(): void {
    this.send(this.aiDestination());
  }

  onDestinationPick(id: string): void {
    this.send(id === 'subagent' ? 'subagent' : 'session');
  }

  closeComposer(): void {
    this.composerOpen.set(false);
    this.composerText.set('');
    this.composerAssets.set([]);
  }

  @HostListener('document:keydown', ['$event'])
  onComposerKeydown(event: KeyboardEvent): void {
    if (!this.composerOpen()) return;
    // The image preview sits on top of the composer: its own Esc closes it first.
    if (this.previewAsset()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeComposer();
    } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      this.sendDefault();
    }
  }

  private composerTitle(): string {
    const assets = this.composerAssets();
    const label = this.intentLabel(this.activeIntent());
    return assets.length === 1
      ? `${label}: ${assets[0].name}`
      : `${label}: ${this.translate.instant('ASSETS.N files', { count: assets.length })}`;
  }

  intentLabel(intent: AssetIntent): string {
    return this.translate.instant('ASSETS.intent.' + intent);
  }

  intentIcon(intent: AssetIntent): string {
    const map: Record<AssetIntent, string> = {
      implement: 'solar:code-square-bold',
      fix: 'solar:bug-bold',
      explain: 'solar:chat-round-dots-bold',
      extract: 'solar:document-text-bold',
      compare: 'solar:transfer-horizontal-bold',
      custom: 'solar:pen-new-round-bold',
    };
    return map[intent];
  }

  // ── Open Folder ──

  openAssetsFolder(): void {
    const ws = this.workspacePath();
    if (!ws) return;
    this.assetsService.openFolder(ws).catch(err => this.reportError('ASSETS.Open folder failed', err));
  }

  // ── Toggle ──

  togglePanel(): void {
    if (this.collapsed()) {
      this.expandPanel();
    } else {
      this.collapsed.set(true);
      this.layoutChanged.emit();
    }
  }

  // ── Helpers ──

  formatSize(bytes: number): string {
    return this.assetsService.formatSize(bytes);
  }

  getFileIcon(asset: AssetInfo): string {
    if (asset.isImage) return 'solar:gallery-bold-duotone';
    if (asset.mimeType === 'application/pdf') return 'solar:document-text-bold-duotone';
    if (asset.mimeType === 'application/json') return 'solar:code-bold-duotone';
    return 'solar:file-bold-duotone';
  }
}
