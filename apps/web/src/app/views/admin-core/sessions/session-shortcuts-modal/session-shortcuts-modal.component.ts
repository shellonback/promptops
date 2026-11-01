import { Component, CUSTOM_ELEMENTS_SCHEMA, HostListener, OnDestroy, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  SessionShortcutAction,
  SessionShortcutsService,
  ShortcutPlatform,
  shortcutConflict,
  ShortcutConflict,
  shortcutKeyLabel,
} from '../services/session-shortcuts.service';

type Platform = ShortcutPlatform;

interface Shortcut { keys: string[]; label: string; hint?: string; action?: SessionShortcutAction; conflict?: string }
interface ShortcutGroup { title: string; icon: string; items: Shortcut[] }

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'windows';
  const p = `${navigator.platform} ${navigator.userAgent}`;
  if (/Mac|iPhone|iPad/.test(p)) return 'mac';
  if (/Linux|X11/.test(p) && !/Android/.test(p)) return 'linux';
  return 'windows';
}

/**
 * Cheat sheet (and editor) of the session/sub-agent shortcuts (handler in
 * SessionViewComponent.onSubAgentKeyDown). On macOS the modifier is ⌘⌥
 * because ⌥ alone composes characters ([ ] on IT/DE layouts).
 */
@Component({
  selector: 'app-session-shortcuts-modal',
  standalone: true,
  imports: [TranslateModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <div class="modal-header">
      <h4 class="modal-title">
        <iconify-icon icon="solar:keyboard-bold-duotone" width="22"></iconify-icon>
        {{ 'SESSIONS.SHORTCUTS.Title' | translate }}
      </h4>
      <button type="button" class="btn-close" [attr.aria-label]="'COMMON.Close' | translate" (click)="activeModal.dismiss()"></button>
    </div>

    <div class="modal-body">
      <div class="ss-platforms" role="tablist" [attr.aria-label]="'SESSIONS.SHORTCUTS.Platform' | translate">
        @for (p of platforms; track p.id) {
          <button type="button" role="tab" class="ss-platform"
                  [class.active]="platform() === p.id" [attr.aria-selected]="platform() === p.id"
                  (click)="platform.set(p.id)">
            <iconify-icon [attr.icon]="p.icon" width="14"></iconify-icon>
            {{ p.label }}
            @if (p.id === detected) { <span class="ss-yours">{{ 'SESSIONS.SHORTCUTS.Yours' | translate }}</span> }
          </button>
        }
      </div>

      @for (g of groups(); track g.title) {
        <section class="ss-group">
          <h6><iconify-icon [attr.icon]="g.icon" width="15"></iconify-icon> {{ g.title }}</h6>
          <ul>
            @for (s of g.items; track s.label) {
              <li [class.recording]="s.action && recording() === s.action">
                <span class="ss-label">
                  {{ s.label }}
                  @if (s.hint) { <small>{{ s.hint }}</small> }
                </span>
                @if (s.action) {
                  <button type="button" class="ss-keys ss-edit" (click)="startRecording(s.action)"
                          [attr.aria-label]="'SESSIONS.SHORTCUTS.ChangeShortcut' | translate: { label: s.label }" [title]="'SESSIONS.SHORTCUTS.ClickToChange' | translate">
                    @if (recording() === s.action) {
                      <span class="ss-press">{{ 'SESSIONS.SHORTCUTS.PressKey' | translate }}</span>
                    } @else {
                      @for (k of s.keys; track $index; let last = $last) {
                        <kbd>{{ k }}</kbd>@if (!last) {<span class="ss-plus">+</span>}
                      }
                    }
                    @if (s.conflict && recording() !== s.action) {
                      <iconify-icon icon="solar:danger-triangle-bold" width="14" class="ss-conflict"
                                    [attr.title]="s.conflict"></iconify-icon>
                    }
                    <iconify-icon icon="solar:pen-2-linear" width="13" class="ss-pen"></iconify-icon>
                  </button>
                } @else {
                  <span class="ss-keys">
                    @for (k of s.keys; track $index; let last = $last) {
                      <kbd>{{ k }}</kbd>@if (!last) {<span class="ss-plus">+</span>}
                    }
                    <span class="ss-pen-spacer"></span>
                  </span>
                }
              </li>
            }
          </ul>
        </section>
      }

      @if (notice(); as n) {
        <p class="ss-notice" [class.warn]="n.warn">{{ n.text }}</p>
      }

      <p class="ss-note">
        {{ 'SESSIONS.SHORTCUTS.NoteChange' | translate: { mod: modLabel() } }}
        {{ 'SESSIONS.SHORTCUTS.NoteTerminal' | translate }}
        @if (platform() === 'mac') { {{ 'SESSIONS.SHORTCUTS.NoteMac' | translate }} }
      </p>
    </div>

    <div class="modal-footer">
      <button type="button" class="btn btn-link me-auto" [disabled]="shortcuts.isDefault()" (click)="resetDefaults()">
        {{ 'SESSIONS.SHORTCUTS.Reset' | translate }}
      </button>
      <button type="button" class="btn btn-primary" (click)="activeModal.close()">{{ 'SESSIONS.SHORTCUTS.GotIt' | translate }}</button>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    :host { display: flex; flex-direction: column; max-height: 85vh; }
    .modal-title { display: flex; align-items: center; gap: 8px; }
    .modal-body { overflow-y: auto; }
    .modal-footer { flex-shrink: 0; }
    .ss-platforms {
      display: inline-flex; gap: 2px; padding: 3px; margin-bottom: 16px;
      border-radius: var(--po-radius-lg); background: var(--po-bg-1);
      border: 1px solid var(--po-border-subtle);
    }
    .ss-platform {
      display: inline-flex; align-items: center; gap: 6px;
      border: 1px solid transparent; background: transparent; color: var(--po-text-secondary);
      padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600;
      cursor: pointer; transition: background .15s, color .15s;
    }
    .ss-platform:hover { color: var(--po-text-primary); background: var(--po-bg-3); }
    .ss-platform.active {
      background: var(--po-accent-muted-bg); color: var(--po-accent-hover);
      border-color: color-mix(in oklch, var(--po-accent) 40%, transparent);
    }
    .ss-yours {
      font-size: 10px; font-weight: 600; padding: 0 5px; border-radius: 4px;
      background: var(--po-bg-4); color: var(--po-text-secondary);
    }
    .ss-platform.active .ss-yours { background: var(--po-accent); color: var(--po-accent-on); }
    .ss-group + .ss-group { margin-top: 14px; }
    .ss-group h6 {
      display: flex; align-items: center; gap: 6px; margin: 0 0 6px;
      font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--po-text-tertiary);
    }
    ul { list-style: none; margin: 0; padding: 0; }
    li {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 7px 0; border-bottom: 1px solid var(--po-border-subtle);
    }
    li:last-child { border-bottom: 0; }
    .ss-label { font-size: 13px; }
    .ss-label small { display: block; font-size: 11px; color: var(--po-text-tertiary); }
    .ss-keys { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; }
    .ss-plus { font-size: 11px; color: var(--po-text-tertiary); }
    kbd {
      min-width: 22px; padding: 2px 6px; text-align: center;
      font: 600 11px/1.5 var(--po-font-mono);
      color: var(--po-text-primary); background: var(--po-bg-1);
      border: 1px solid var(--po-border-strong); border-bottom-width: 2px; border-radius: 5px;
    }
    .ss-edit {
      background: transparent; border: 1px dashed transparent; border-radius: 6px;
      padding: 2px 4px; margin: -3px -5px; cursor: pointer; color: inherit;
    }
    .ss-edit:hover, .ss-edit:focus-visible { border-color: var(--po-border-strong); background: var(--po-bg-2); outline: none; }
    .ss-conflict { color: var(--po-warning, oklch(75% 0.16 75)); margin-inline-start: 4px; }
    .ss-pen, .ss-pen-spacer { width: 13px; margin-inline-start: 4px; }
    .ss-pen { color: var(--po-text-tertiary); opacity: 0; transition: opacity .15s; }
    .ss-edit:hover .ss-pen, .ss-edit:focus-visible .ss-pen { opacity: 1; }
    li.recording .ss-edit { border-color: var(--po-accent); background: var(--po-accent-muted-bg); }
    .ss-press { font-size: 12px; font-weight: 600; color: var(--po-accent-hover); padding: 2px 4px; }
    .ss-notice {
      margin: 12px 0 0; padding: 6px 10px; font-size: 12px; border-radius: 6px;
      background: var(--po-accent-muted-bg); color: var(--po-text-primary);
    }
    .ss-notice.warn { background: var(--po-warning-bg); }
    .ss-note { margin: 14px 0 0; font-size: 11px; color: var(--po-text-tertiary); }
  `],
})
export class SessionShortcutsModalComponent implements OnDestroy {
  readonly activeModal = inject(NgbActiveModal);
  readonly shortcuts = inject(SessionShortcutsService);
  private readonly translate = inject(TranslateService);
  private t(key: string, params?: Record<string, unknown>): string {
    return this.translate.instant('SESSIONS.SHORTCUTS.' + key, params);
  }

  /** Translated sentence for a discouraged key. */
  private conflictText(c: ShortcutConflict): string {
    return this.t(c.message, { key: c.key, why: this.t(c.reason) });
  }

  /** Action waiting for the new key. */
  readonly recording = signal<SessionShortcutAction | null>(null);
  readonly notice = signal<{ text: string; warn: boolean } | null>(null);

  readonly detected = detectPlatform();
  readonly platform = signal<Platform>(this.detected);
  readonly platforms: { id: Platform; label: string; icon: string }[] = [
    { id: 'mac', label: 'macOS', icon: 'mdi:apple' },
    { id: 'windows', label: 'Windows', icon: 'mdi:microsoft-windows' },
    { id: 'linux', label: 'Linux', icon: 'mdi:linux' },
  ];

  readonly groups = computed<ShortcutGroup[]>(() => {
    const mod = this.platform() === 'mac' ? ['⌘', '⌥'] : ['Alt'];
    const k = (...keys: string[]) => [...mod, ...keys];
    const b = this.shortcuts.bindings();
    const key = (a: SessionShortcutAction) => shortcutKeyLabel(b[a]) ?? '?';
    const platform = this.platform();
    // Inline warning on rows whose key collides with the OS, shell or provider CLI.
    const withConflicts = (items: Shortcut[]) => items.map(it => {
      const conflict = it.action ? shortcutConflict(b[it.action], platform) : null;
      return conflict ? { ...it, conflict: this.t('NotRecommended', { reason: this.conflictText(conflict) }) } : it;
    });
    return [
      {
        title: this.t('GroupMove'),
        icon: 'solar:transfer-horizontal-bold',
        items: withConflicts([
          { keys: k(key('focusMain')), label: this.t('FocusMain'), action: 'focusMain' },
          { keys: k('1 … 9'), label: this.t('FocusByPosition'), hint: this.t('FocusByPositionHint') },
          { keys: k(key('prevAgent')), label: this.t('PrevAgent'), action: 'prevAgent' },
          { keys: k(key('nextAgent')), label: this.t('NextAgent'), action: 'nextAgent' },
          { keys: k(key('nextWaiting')), label: this.t('NextWaiting'), action: 'nextWaiting' },
        ]),
      },
      {
        title: this.t('GroupSingle'),
        icon: 'solar:maximize-square-bold',
        items: withConflicts([
          { keys: k(key('expandAgent')), label: this.t('ExpandFocused'), action: 'expandAgent' },
          { keys: ['Esc'], label: this.t('CloseExpanded') },
          { keys: k(key('lockAgent')), label: this.t('LockFocused'), action: 'lockAgent' },
        ]),
      },
      {
        title: this.t('GroupLayout'),
        icon: 'solar:widget-bold',
        items: withConflicts([
          { keys: k(key('focusMode')), label: this.t('ToggleFocusMode'), hint: this.t('FocusModeHint'), action: 'focusMode' },
          { keys: ['Esc'], label: this.t('ExitFocusMode') },
        ]),
      },
    ];
  });

  readonly modLabel = computed(() => this.platform() === 'mac' ? '⌘⌥' : 'Alt');

  private readonly labelKeys: Record<SessionShortcutAction, string> = {
    focusMain: 'FocusMain', prevAgent: 'PrevAgent', nextAgent: 'NextAgent', nextWaiting: 'NextWaiting',
    expandAgent: 'LabelExpand', lockAgent: 'LabelLock', focusMode: 'LabelFocusMode',
  };
  private label(action: SessionShortcutAction): string { return this.t(this.labelKeys[action]); }

  /** Capture on window: it arrives before the session view (which would run
   *  the action), ngb's close-on-Esc and the modal's Enter. */
  private readonly onRecordKey = (event: KeyboardEvent) => {
    const action = this.recording();
    if (!action) return;
    if (['Shift', 'Alt', 'Meta', 'Control'].includes(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.code === 'Escape') { this.stopRecording(); return; }
    if (/^Digit[1-9]$/.test(event.code)) {
      this.notice.set({ text: this.t('DigitsReserved'), warn: true });
      return;
    }
    const label = shortcutKeyLabel(event.code);
    if (!label) {
      this.notice.set({ text: this.t('InvalidKey'), warn: true });
      return;
    }
    const swapped = this.shortcuts.set(action, event.code);
    // Count the real system, not the tab shown: that's where the combination collides.
    const reserved = shortcutConflict(event.code, this.detected);
    const parts = [swapped
      ? this.t('Swapped', { key: label, other: this.label(swapped) })
      : this.t('Assigned', { action: this.label(action), mod: this.modLabel(), key: label })];
    if (reserved) parts.push(this.t('ReservedWarn', { reason: this.conflictText(reserved) }));
    this.notice.set({ text: parts.join(' '), warn: !!swapped || !!reserved });
    this.stopRecording();
  };

  constructor() {
    window.addEventListener('keydown', this.onRecordKey, true);
  }

  ngOnDestroy(): void {
    window.removeEventListener('keydown', this.onRecordKey, true);
  }

  startRecording(action: SessionShortcutAction): void {
    this.notice.set(null);
    this.recording.update(cur => cur === action ? null : action);
  }

  private stopRecording(): void {
    this.recording.set(null);
  }

  resetDefaults(): void {
    this.shortcuts.reset();
    this.stopRecording();
    this.notice.set({ text: this.t('Restored'), warn: false });
  }

  @HostListener('keydown.enter', ['$event'])
  onEnter(event: Event): void {
    // Enter on a key to edit activates it, it doesn't close the modal.
    if ((event.target as HTMLElement | null)?.closest('.ss-edit, .btn-link')) return;
    event.preventDefault();
    this.activeModal.close();
  }
}
