import {
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  inject,
  OnInit,
  signal,
  ChangeDetectionStrategy
} from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import { FormsModule } from "@angular/forms";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import { Store } from "@ngrx/store";
import { filter, first } from "rxjs/operators";
import { getUser } from "@/store/authentication/authentication.selector";
import { UiPreferencesService, type ResolvedUiPreferences } from "@core/services/ui-preferences.service";
import { SwalService } from "@core/services/swal.service";
import type { UiPreferences } from "@core/models/user";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { VoiceOnboardingModalComponent } from "@/app/components/voice-agent/voice-onboarding-modal.component";
import { ClaudeHookService } from "@/app/views/admin-core/sessions/services/claude-hook.service";
import { SessionService } from "@/app/views/admin-core/sessions/services/session.service";
import { SystemCleanupComponent } from "@components/system-cleanup/system-cleanup.component";
import { AboutCardComponent } from "@components/about-card/about-card.component";
import { BackupRestoreCardComponent } from "@components/backup-restore-card/backup-restore-card.component";

const FONT_OPTIONS = [
  "Geist",
  "Inter",
  "Instrument Sans",
  "SF Pro",
  "Roboto",
  "Nunito",
  "System Default",
];

const MONO_FONT_OPTIONS = [
  "Geist Mono",
  "Cascadia Code",
  "JetBrains Mono",
  "Fira Code",
  "Source Code Pro",
  "IBM Plex Mono",
  "System Default",
];

@Component({
  selector: "app-user-settings",
  standalone: true,
  imports: [FormsModule, TranslateModule, SystemCleanupComponent, AboutCardComponent, BackupRestoreCardComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <div class="settings-container">
      <div class="settings-header">
        <h4 class="settings-title">
          <iconify-icon icon="solar:settings-minimalistic-bold-duotone" width="24"></iconify-icon>
          {{ "SETTINGS.Title" | translate }}
        </h4>
        <p class="settings-subtitle">{{ "SETTINGS.Subtitle" | translate }}</p>
      </div>

      @if (loading()) {
        <div class="settings-loading">
          <div class="spinner-border spinner-border-sm text-primary" role="status"></div>
        </div>
      } @else {
        <div class="settings-grid">

          <!-- ─── Appearance ─────────────────────────────────────── -->
          <div class="settings-card">
            <div class="card-section-title">
              <iconify-icon icon="solar:pallete-2-bold-duotone" width="16"></iconify-icon>
              {{ "SETTINGS.Appearance" | translate }}
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Theme" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Theme Hint" | translate }}</span>
              </div>
              <div class="theme-picker">
                @for (opt of themeOptions; track opt.value) {
                  <button
                    class="theme-btn"
                    [class.active]="form.theme === opt.value"
                    (click)="form.theme = opt.value; previewAndSave()"
                  >
                    <iconify-icon [icon]="opt.icon" width="16"></iconify-icon>
                    {{ "SETTINGS." + opt.labelKey | translate }}
                  </button>
                }
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Sidebar" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Sidebar Hint" | translate }}</span>
              </div>
              <select
                class="form-select form-select-sm setting-select"
                [(ngModel)]="form.sidebar_size"
                (ngModelChange)="previewAndSave()"
              >
                @for (opt of sidebarOptions; track opt.value) {
                  <option [value]="opt.value">{{ "SETTINGS." + opt.labelKey | translate }}</option>
                }
              </select>
            </div>
          </div>

          <!-- ─── Typography ─────────────────────────────────────── -->
          <div class="settings-card">
            <div class="card-section-title">
              <iconify-icon icon="solar:text-bold-bold-duotone" width="16"></iconify-icon>
              {{ "SETTINGS.Typography" | translate }}
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Font" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Font Hint" | translate }}</span>
              </div>
              <select
                class="form-select form-select-sm setting-select"
                [(ngModel)]="form.font_family"
                (ngModelChange)="previewAndSave()"
              >
                @for (f of fontOptions; track f) {
                  <option [value]="f">{{ f }}</option>
                }
              </select>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Font Size" | translate }}</span>
                <span class="setting-hint">{{ form.font_size }}px</span>
              </div>
              <div class="range-group">
                <span class="range-label">10</span>
                <input
                  type="range"
                  class="form-range setting-range"
                  [min]="10"
                  [max]="24"
                  [step]="1"
                  [(ngModel)]="form.font_size"
                  (ngModelChange)="previewAndSave()"
                />
                <span class="range-label">24</span>
              </div>
            </div>
          </div>

          <!-- ─── Terminal ───────────────────────────────────────── -->
          <div class="settings-card">
            <div class="card-section-title">
              <iconify-icon icon="solar:monitor-bold-duotone" width="16"></iconify-icon>
              {{ "SETTINGS.Terminal" | translate }}
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Terminal Font" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Terminal Font Hint" | translate }}</span>
              </div>
              <select
                class="form-select form-select-sm setting-select"
                [(ngModel)]="form.terminal_font_family"
                (ngModelChange)="previewAndSave()"
              >
                @for (f of monoFontOptions; track f) {
                  <option [value]="f">{{ f }}</option>
                }
              </select>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Terminal Font Size" | translate }}</span>
                <span class="setting-hint">{{ form.terminal_font_size }}px</span>
              </div>
              <div class="range-group">
                <span class="range-label">10</span>
                <input
                  type="range"
                  class="form-range setting-range"
                  [min]="10"
                  [max]="28"
                  [step]="1"
                  [(ngModel)]="form.terminal_font_size"
                  (ngModelChange)="previewAndSave()"
                />
                <span class="range-label">28</span>
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Cursor Style" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Cursor Style Hint" | translate }}</span>
              </div>
              <div class="cursor-picker">
                @for (opt of cursorOptions; track opt.value) {
                  <button
                    class="cursor-btn"
                    [class.active]="form.terminal_cursor_style === opt.value"
                    (click)="form.terminal_cursor_style = opt.value; previewAndSave()"
                  >
                    <span class="cursor-preview" [attr.data-cursor]="opt.value"></span>
                    {{ "SETTINGS." + opt.labelKey | translate }}
                  </button>
                }
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Terminal Line Height" | translate }}</span>
                <span class="setting-hint">{{ form.terminal_line_height }}</span>
              </div>
              <div class="range-group">
                <span class="range-label">1.0</span>
                <input
                  type="range"
                  class="form-range setting-range"
                  [min]="1.0"
                  [max]="2.5"
                  [step]="0.1"
                  [(ngModel)]="form.terminal_line_height"
                  (ngModelChange)="previewAndSave()"
                />
                <span class="range-label">2.5</span>
              </div>
            </div>

            <!-- Windows-only: default terminal shell for new sessions -->
            @if (isWindowsDesktop && terminalShells.length) {
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Terminal Default Shell" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Terminal Default Shell Hint" | translate }}</span>
              </div>
              <select
                class="form-select form-select-sm setting-select"
                [(ngModel)]="form.terminal_default_shell"
                (ngModelChange)="previewAndSave()"
              >
                @for (s of terminalShells; track s.id) {
                  <option [value]="s.id">{{ s.label }}</option>
                }
              </select>
            </div>
            }

            <!-- Terminal Preview -->
            <div class="terminal-preview"
              [style.font-family]="'&quot;' + form.terminal_font_family + '&quot;, ui-monospace, monospace'"
              [style.font-size.px]="form.terminal_font_size"
              [style.line-height]="form.terminal_line_height"
            >
              <div class="terminal-bar">
                <span class="terminal-dot red"></span>
                <span class="terminal-dot yellow"></span>
                <span class="terminal-dot green"></span>
                <span class="terminal-title">{{ "SETTINGS.Terminal Preview" | translate }}</span>
              </div>
              <div class="terminal-body">
                <span class="t-prompt">$</span> git status<br/>
                <span class="t-green">On branch</span> <span class="t-accent">develop</span><br/>
                <span class="t-muted">Changes not staged for commit:</span><br/>
                <span class="t-red">&nbsp;&nbsp;modified: src/settings.ts</span><br/>
                <span class="t-prompt">$</span> <span class="t-cursor" [attr.data-cursor]="form.terminal_cursor_style">&nbsp;</span>
              </div>
            </div>
          </div>

          <!-- ─── Terminal Functionalities ───────────────────────── -->
          <div class="settings-card">
            <div class="card-section-title">
              <iconify-icon icon="solar:tuning-2-bold-duotone" width="16"></iconify-icon>
              {{ "SETTINGS.Terminal Functionalities" | translate }}
            </div>
            <p class="card-section-desc">
              {{ "SETTINGS.Terminal Functionalities Hint" | translate }}
            </p>

            @if (isWindows) {
            <div class="setting-row safe-mode-row" [class.safe-mode-active]="form.terminal_safe_mode">
              <div class="setting-info">
                <span class="setting-label">
                  <iconify-icon icon="solar:shield-check-bold-duotone" width="15"></iconify-icon>
                  {{ "SETTINGS.Terminal Safe Mode" | translate }}
                </span>
                <span class="setting-hint">{{ "SETTINGS.Terminal Safe Mode Hint" | translate }}</span>
              </div>
              <label class="po-switch">
                <input type="checkbox" [(ngModel)]="form.terminal_safe_mode" (ngModelChange)="previewAndSave()">
                <span class="po-switch-slider"></span>
              </label>
            </div>
            }

            @if (isDesktopV2) {
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">
                  {{ "SETTINGS.Terminal Persistent Agents" | translate }}
                  <span class="setting-beta">beta</span>
                </span>
                <span class="setting-hint">{{ "SETTINGS.Terminal Persistent Agents Hint" | translate }}</span>
              </div>
              <label class="po-switch">
                <input type="checkbox" [(ngModel)]="form.terminal_persistent_agents" (ngModelChange)="previewAndSave()">
                <span class="po-switch-slider"></span>
              </label>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Terminal Host Screen" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Terminal Host Screen Hint" | translate }}</span>
              </div>
              <label class="po-switch">
                <input type="checkbox" [(ngModel)]="form.terminal_host_screen" (ngModelChange)="previewAndSave()">
                <span class="po-switch-slider"></span>
              </label>
            </div>
            }

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Terminal GPU" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Terminal GPU Hint" | translate }}</span>
              </div>
              <label class="po-switch">
                <input type="checkbox" [(ngModel)]="form.terminal_gpu_acceleration" (ngModelChange)="previewAndSave()">
                <span class="po-switch-slider"></span>
              </label>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Terminal Cursor Blink" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Terminal Cursor Blink Hint" | translate }}</span>
              </div>
              <label class="po-switch">
                <input type="checkbox" [(ngModel)]="form.terminal_cursor_blink" (ngModelChange)="previewAndSave()">
                <span class="po-switch-slider"></span>
              </label>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Terminal Link Detection" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Terminal Link Detection Hint" | translate }}</span>
              </div>
              <label class="po-switch">
                <input type="checkbox" [(ngModel)]="form.terminal_link_detection" (ngModelChange)="previewAndSave()">
                <span class="po-switch-slider"></span>
              </label>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Terminal Command Detection" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Terminal Command Detection Hint" | translate }}</span>
              </div>
              <label class="po-switch">
                <input type="checkbox" [(ngModel)]="form.terminal_command_detection" (ngModelChange)="previewAndSave()" [disabled]="isWindows && form.terminal_safe_mode">
                <span class="po-switch-slider"></span>
              </label>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Terminal Input Detection" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Terminal Input Detection Hint" | translate }}</span>
              </div>
              <label class="po-switch">
                <input type="checkbox" [(ngModel)]="form.terminal_input_detection" (ngModelChange)="previewAndSave()" [disabled]="isWindows && form.terminal_safe_mode">
                <span class="po-switch-slider"></span>
              </label>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Terminal Activity Tail" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Terminal Activity Tail Hint" | translate }}</span>
              </div>
              <label class="po-switch">
                <input type="checkbox" [(ngModel)]="form.terminal_activity_tail" (ngModelChange)="previewAndSave()" [disabled]="isWindows && form.terminal_safe_mode">
                <span class="po-switch-slider"></span>
              </label>
            </div>
          </div>

          <!-- ─── General / Startup ──────────────────────────────── -->
          @if (isDesktop) {
          <div class="settings-card">
            <div class="card-section-title">
              <iconify-icon icon="solar:power-bold-duotone" width="16"></iconify-icon>
              {{ "SETTINGS.General Title" | translate }}
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Launch At Login" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Launch At Login Hint" | translate }}</span>
              </div>
              <label class="po-switch">
                <input type="checkbox" [checked]="autoLaunchEnabled()" (change)="toggleAutoLaunch($any($event.target).checked)">
                <span class="po-switch-slider"></span>
              </label>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Auto Standby" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Auto Standby Hint" | translate }}</span>
              </div>
              <select class="form-select form-select-sm setting-select"
                      [ngModel]="autoStandbyMinutes()" (ngModelChange)="onAutoStandbyChange($event)">
                @for (opt of autoStandbyOptions; track opt) {
                  <option [ngValue]="opt">{{ opt === 0 ? ("SETTINGS.Auto Standby Never" | translate) : opt + " min" }}</option>
                }
              </select>
            </div>
          </div>
          }

          <!-- ─── Notifications ──────────────────────────────────── -->
          @if (isDesktop) {
          <div class="settings-card">
            <div class="card-section-title">
              <iconify-icon icon="solar:bell-bold-duotone" width="16"></iconify-icon>
              {{ "SETTINGS.Notifications Title" | translate }}
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Toast Duration" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Toast Duration Hint" | translate }} · {{ hookService.toastDurationMs() / 1000 }}s</span>
              </div>
              <input
                type="range"
                class="hold-slider"
                min="3"
                max="30"
                step="1"
                [disabled]="hookService.toastPinned()"
                [value]="hookService.toastDurationMs() / 1000"
                (input)="onToastDurationInput($any($event.target).value)"
              />
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Toast Pinned" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Toast Pinned Hint" | translate }}</span>
              </div>
              <label class="po-switch">
                <input type="checkbox" [checked]="hookService.toastPinned()" (change)="hookService.setToastPinned($any($event.target).checked)">
                <span class="po-switch-slider"></span>
              </label>
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Toast Pause On Hover" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Toast Pause On Hover Hint" | translate }}</span>
              </div>
              <label class="po-switch">
                <input type="checkbox" [checked]="hookService.toastPauseOnHover()" [disabled]="hookService.toastPinned()" (change)="hookService.setToastPauseOnHover($any($event.target).checked)">
                <span class="po-switch-slider"></span>
              </label>
            </div>
            <div class="setting-row" id="setting-compact-suggestions" [class.highlighted]="highlightRow() === 'compact-suggestions'">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Compact Suggestions" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Compact Suggestions Hint" | translate }}</span>
              </div>
              <label class="po-switch">
                <input type="checkbox" [checked]="hookService.compactSuggestions()" (change)="hookService.setCompactSuggestions($any($event.target).checked)">
                <span class="po-switch-slider"></span>
              </label>
            </div>
          </div>
          }

          <!-- ─── Voice / Microphone ─────────────────────────────── -->
          @if (isDesktop) {
          <div class="settings-card">
            <div class="card-section-title">
              <iconify-icon icon="solar:microphone-3-bold-duotone" width="16"></iconify-icon>
              {{ "SETTINGS.Voice Title" | translate }}
            </div>
            <p class="setting-hint" style="margin: 0 0 0.75rem 0;">
              {{ "SETTINGS.Voice Subtitle" | translate }}
            </p>

            <div class="setting-row" style="flex-direction: column; align-items: stretch; gap: 0.5rem;">
              <div class="setting-info" style="width: 100%;">
                <span class="setting-label">{{ "SETTINGS.Voice API Key Label" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Voice API Key Hint" | translate }}</span>
              </div>

              @if (voiceMaskedKey()) {
                <div class="voice-status success">
                  <iconify-icon icon="solar:check-circle-bold" width="14"></iconify-icon>
                  {{ "SETTINGS.Voice Key Configured" | translate: { masked: voiceMaskedKey() } }}
                </div>
              }

              <div class="voice-input-row">
                <input
                  type="password"
                  class="form-control form-control-sm"
                  [placeholder]="'SETTINGS.Voice API Key Placeholder' | translate"
                  [(ngModel)]="voiceApiKey"
                  autocomplete="off"
                />
                <button
                  type="button"
                  class="btn btn-sm btn-outline-primary"
                  [disabled]="!voiceApiKey || voiceTesting()"
                  (click)="testVoiceKey()"
                >
                  @if (voiceTesting()) {
                    <span class="spinner-border spinner-border-sm" role="status" style="width:0.8rem;height:0.8rem;"></span>
                  } @else {
                    {{ "SETTINGS.Voice Test" | translate }}
                  }
                </button>
                <button
                  type="button"
                  class="btn btn-sm btn-primary"
                  [disabled]="!voiceApiKey"
                  (click)="saveVoiceKey()"
                >
                  {{ "SETTINGS.Voice Save" | translate }}
                </button>
                @if (voiceKeySource() === 'user') {
                  <button
                    type="button"
                    class="btn btn-sm btn-outline-danger"
                    (click)="removeVoiceKey()"
                  >
                    {{ "SETTINGS.Voice Remove" | translate }}
                  </button>
                }
              </div>

              @if (voiceFeedback()) {
                <div class="voice-status" [class.success]="voiceFeedbackKind() === 'ok'" [class.error]="voiceFeedbackKind() === 'err'">
                  <iconify-icon
                    [icon]="voiceFeedbackKind() === 'ok' ? 'solar:check-circle-bold' : 'solar:close-circle-bold'"
                    width="14"
                  ></iconify-icon>
                  {{ voiceFeedback() }}
                </div>
              }

              <a
                href="https://console.groq.com/keys"
                target="_blank"
                rel="noopener"
                class="voice-link"
                (click)="openExternal($event, 'https://console.groq.com/keys')"
              >
                <iconify-icon icon="solar:square-arrow-right-up-bold" width="14"></iconify-icon>
                {{ "SETTINGS.Voice Get Key" | translate }}
              </a>
            </div>

            <!-- Global push-to-talk shortcut -->
            <div class="shortcut-divider"></div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Voice Shortcut Enabled" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Voice Shortcut Enabled Hint" | translate }}</span>
              </div>
              <label class="po-switch">
                <input type="checkbox" [checked]="shortcutEnabled()" (change)="toggleShortcut($any($event.target).checked)">
                <span class="po-switch-slider"></span>
              </label>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">{{ "SETTINGS.Voice Shortcut Hold" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Voice Shortcut Hold Hint" | translate: { ms: shortcutHoldMs() } }}</span>
              </div>
              <input
                type="range"
                class="hold-slider"
                min="500"
                max="5000"
                step="100"
                [disabled]="!shortcutEnabled()"
                [value]="shortcutHoldMs()"
                (input)="onHoldInput($any($event.target).value)"
                (change)="commitHold()"
              />
            </div>

            <div class="setting-row" style="flex-direction: column; align-items: stretch; gap: 0.5rem;">
              <div class="setting-info" style="width: 100%;">
                <span class="setting-label">{{ "SETTINGS.Voice Shortcut Help" | translate }}</span>
                <span class="setting-hint">{{ "SETTINGS.Voice Shortcut Help Hint" | translate }}</span>
              </div>
              <div class="shortcut-actions">
                <button type="button" class="btn btn-sm btn-outline-primary" (click)="reopenOnboarding()">
                  <iconify-icon icon="solar:question-circle-bold" width="14"></iconify-icon>
                  {{ "SETTINGS.Voice Reopen Wizard" | translate }}
                </button>
                @if (isMacOS) {
                  <button type="button" class="btn btn-sm btn-outline-secondary" (click)="openMacSettings('accessibility')">
                    <iconify-icon icon="solar:shield-keyhole-bold" width="14"></iconify-icon>
                    {{ "SETTINGS.Voice Open Accessibility Settings" | translate }}
                  </button>
                }
              </div>
            </div>
          </div>
          }

          <!-- ─── Storage cleanup ────────────────────────────────── -->
          @if (isDesktop) {
          <div class="settings-card">
            <div class="card-section-title">
              <iconify-icon icon="solar:trash-bin-minimalistic-bold-duotone" width="16"></iconify-icon>
              {{ "SECURITY.System Cleanup" | translate }}
            </div>
            <app-system-cleanup />
          </div>
          }

          <!-- ─── Backup & restore (next to the Session Vault info in About) ── -->
          @if (isDesktop) {
          <div class="settings-card" data-qa="backup-card">
            <div class="card-section-title">
              <iconify-icon icon="solar:shield-check-bold-duotone" width="16"></iconify-icon>
              {{ "BACKUP.Title" | translate }}
            </div>
            <app-backup-restore-card />
          </div>
          }

          <!-- ─── About ──────────────────────────────────────────── -->
          <div class="settings-card">
            <div class="card-section-title">
              <iconify-icon icon="solar:info-circle-bold-duotone" width="16"></iconify-icon>
              {{ "ABOUT.Title" | translate }}
            </div>
            <app-about-card />
          </div>

        </div>

        <!-- Status bar -->
        @if (saving()) {
          <div class="save-status saving">
            <div class="spinner-border spinner-border-sm" role="status"></div>
            {{ "SETTINGS.Saving" | translate }}
          </div>
        }
        @if (saved()) {
          <div class="save-status saved">
            <iconify-icon icon="solar:check-circle-bold" width="16"></iconify-icon>
            {{ "SETTINGS.Preferences Saved" | translate }}
          </div>
        }
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .settings-container {
      width: 100%;
      max-width: 720px;
      margin: 0 auto;
      padding: 1.5rem;
    }

    .settings-header { margin-bottom: 1.5rem; }
    .settings-title {
      font-size: 1.3rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin: 0 0 0.25rem 0;
    }
    .settings-subtitle {
      font-size: 0.82rem;
      color: var(--po-text-secondary);
      margin: 0;
    }

    .settings-loading {
      display: flex;
      justify-content: center;
      padding: 4rem 0;
    }

    .settings-grid {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .settings-card {
      background: rgba(255, 255, 255, 0.7);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(79, 70, 229, 0.08);
      border-radius: 16px;
      padding: 1.25rem;
    }
    :host-context([data-bs-theme="dark"]) .settings-card {
      background: rgba(30, 41, 59, 0.7);
      border-color: rgba(99, 102, 241, 0.12);
    }

    .card-section-title {
      font-size: 0.73rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--po-text-tertiary);
      margin-bottom: 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .card-section-desc {
      font-size: 0.8rem;
      color: var(--po-text-tertiary);
      margin: -0.25rem 0 0.75rem;
      line-height: 1.4;
    }

    .setting-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.65rem 0;
      border-bottom: 1px solid rgba(100, 116, 139, 0.06);
      gap: 1rem;
    }
    .setting-row:last-child { border-bottom: none; }

    /* Deep link (?highlight=<row>): glow on the row the user was sent to */
    .setting-row.highlighted {
      border-radius: 10px;
      margin: 0 -0.5rem;
      padding-left: 0.5rem;
      padding-right: 0.5rem;
      background: rgba(99, 102, 241, 0.08);
      animation: settingHighlight 2.5s ease-out forwards;
    }
    @keyframes settingHighlight {
      0% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0); }
      20% { box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.45); }
      100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0); background: transparent; }
    }

    .setting-info {
      display: flex;
      flex-direction: column;
      gap: 0.1rem;
      min-width: 0;
    }
    .setting-label {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--po-text-primary);
    }
    .setting-beta {
      margin-left: 0.35rem;
      padding: 0.05rem 0.4rem;
      border-radius: 999px;
      font-size: 0.62rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      vertical-align: middle;
      color: var(--po-accent);
      border: 1px solid color-mix(in srgb, var(--po-accent) 45%, transparent);
    }
    .setting-hint {
      font-size: 0.72rem;
      color: var(--po-text-tertiary);
    }

    .setting-select {
      width: 180px;
      font-size: 0.82rem;
      border-radius: 8px;
      flex-shrink: 0;
    }

    /* Theme picker */
    .theme-picker {
      display: flex;
      gap: 0.35rem;
      flex-shrink: 0;
    }
    .theme-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.35rem 0.7rem;
      border-radius: 8px;
      font-size: 0.78rem;
      font-weight: 500;
      background: rgba(100, 116, 139, 0.06);
      border: 1px solid rgba(100, 116, 139, 0.1);
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: all 0.2s;
    }
    .theme-btn:hover {
      background: rgba(99, 102, 241, 0.08);
      border-color: rgba(99, 102, 241, 0.15);
    }
    .theme-btn.active {
      background: rgba(99, 102, 241, 0.12);
      border-color: rgba(99, 102, 241, 0.3);
      color: var(--po-accent);
      font-weight: 600;
    }

    /* Cursor picker */
    .cursor-picker {
      display: flex;
      gap: 0.35rem;
      flex-shrink: 0;
    }
    .cursor-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.35rem 0.6rem;
      border-radius: 8px;
      font-size: 0.75rem;
      font-weight: 500;
      background: rgba(100, 116, 139, 0.06);
      border: 1px solid rgba(100, 116, 139, 0.1);
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: all 0.2s;
    }
    .cursor-btn:hover {
      background: rgba(99, 102, 241, 0.08);
    }
    .cursor-btn.active {
      background: rgba(99, 102, 241, 0.12);
      border-color: rgba(99, 102, 241, 0.3);
      color: var(--po-accent);
      font-weight: 600;
    }

    .cursor-preview {
      display: inline-block;
      width: 8px;
      height: 14px;
    }
    .cursor-preview[data-cursor="block"] {
      background: var(--po-accent);
      border-radius: 1px;
    }
    .cursor-preview[data-cursor="underline"] {
      border-bottom: 2px solid var(--po-accent);
    }
    .cursor-preview[data-cursor="bar"] {
      border-left: 2px solid var(--po-accent);
    }

    /* Range group */
    .range-group {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-shrink: 0;
      width: 200px;
    }
    .range-label {
      font-size: 0.7rem;
      color: var(--po-text-tertiary);
      min-width: 22px;
      text-align: center;
    }
    .setting-range {
      flex: 1;
    }

    /* Terminal preview */
    .terminal-preview {
      margin-top: 0.75rem;
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid rgba(100, 116, 139, 0.1);
    }
    .terminal-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 12px;
      background: rgba(0, 0, 0, 0.15);
    }
    .terminal-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .terminal-dot.red { background: #ff5f57; }
    .terminal-dot.yellow { background: #febc2e; }
    .terminal-dot.green { background: #28c840; }
    .terminal-title {
      margin-left: auto;
      font-size: 0.7rem;
      color: var(--po-text-tertiary);
    }
    .terminal-body {
      padding: 12px 14px;
      background: var(--po-bg-0);
      color: var(--po-text-primary);
    }
    .t-prompt { color: var(--po-accent); font-weight: 600; }
    .t-green { color: var(--po-success); }
    .t-red { color: var(--po-error); }
    .t-accent { color: var(--po-accent); }
    .t-muted { color: var(--po-text-tertiary); }
    .t-cursor[data-cursor="block"] {
      background: var(--po-accent);
      color: var(--po-accent);
      animation: blink 1s step-end infinite;
    }
    .t-cursor[data-cursor="underline"] {
      border-bottom: 2px solid var(--po-accent);
      animation: blink 1s step-end infinite;
    }
    .t-cursor[data-cursor="bar"] {
      border-left: 2px solid var(--po-accent);
      animation: blink 1s step-end infinite;
    }
    @keyframes blink {
      50% { opacity: 0; }
    }

    /* Save status */
    .save-status {
      position: fixed;
      bottom: 48px;
      right: 24px;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.5rem 1rem;
      border-radius: 10px;
      font-size: 0.82rem;
      font-weight: 600;
      z-index: 1100;
      animation: slideUp 0.3s ease-out;
    }
    .save-status.saving {
      background: var(--po-bg-3);
      border: 1px solid var(--po-border-subtle);
      color: var(--po-text-secondary);
    }
    .save-status.saved {
      background: var(--po-success-bg);
      border: 1px solid var(--po-success);
      color: var(--po-success);
    }
    @keyframes slideUp {
      from { transform: translateY(12px); opacity: 0; }
      to   { transform: translateY(0); opacity: 1; }
    }

    /* Voice */
    .voice-input-row {
      display: flex;
      gap: 0.4rem;
      flex-wrap: wrap;
      align-items: stretch;
    }
    .voice-input-row .form-control {
      flex: 1 1 240px;
      min-width: 200px;
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 0.78rem;
    }
    .voice-status {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.3rem 0.55rem;
      border-radius: 8px;
      font-size: 0.76rem;
      font-weight: 500;
      width: fit-content;
    }
    .voice-status.success {
      background: rgba(34, 197, 94, 0.1);
      color: rgb(21, 128, 61);
    }
    .voice-status.error {
      background: rgba(239, 68, 68, 0.1);
      color: rgb(185, 28, 28);
    }
    .voice-status.info {
      background: rgba(99, 102, 241, 0.1);
      color: rgb(67, 56, 202);
    }
    :host-context([data-bs-theme="dark"]) .voice-status.success { color: rgb(74, 222, 128); }
    :host-context([data-bs-theme="dark"]) .voice-status.error { color: rgb(248, 113, 113); }
    :host-context([data-bs-theme="dark"]) .voice-status.info { color: rgb(165, 180, 252); }
    .voice-link {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.76rem;
      color: var(--po-primary, rgb(99, 102, 241));
      text-decoration: none;
      width: fit-content;
    }
    .voice-link:hover { text-decoration: underline; }

    /* Global shortcut sub-section */
    .shortcut-divider {
      height: 1px;
      background: linear-gradient(to right, transparent, rgba(99,102,241,0.18), transparent);
      margin: 1rem 0 0.75rem;
    }
    .po-switch {
      position: relative; display: inline-block;
      width: 38px; height: 22px;
    }
    .po-switch input { opacity: 0; width: 0; height: 0; }
    .po-switch-slider {
      position: absolute; cursor: pointer;
      inset: 0; border-radius: 22px;
      background: rgba(139,148,158,0.3);
      transition: 0.2s;
    }
    .po-switch-slider::before {
      content: ''; position: absolute;
      width: 16px; height: 16px;
      left: 3px; top: 3px; border-radius: 50%;
      background: #fff;
      transition: 0.2s;
    }
    .po-switch input:checked + .po-switch-slider {
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
    }
    .po-switch input:checked + .po-switch-slider::before { transform: translateX(16px); }

    /* Safe terminal — diagnostic callout (Windows only). */
    .safe-mode-row {
      border: 1px solid rgba(99, 102, 241, 0.35);
      border-radius: 10px;
      padding: 0.65rem 0.8rem;
      margin-bottom: 0.6rem;
      background: rgba(99, 102, 241, 0.06);
    }
    .safe-mode-row .setting-label { display: inline-flex; align-items: center; gap: 0.35rem; }
    .safe-mode-row.safe-mode-active {
      border-color: rgba(139, 92, 246, 0.7);
      background: rgba(139, 92, 246, 0.12);
    }

    .hold-slider {
      width: 180px; cursor: pointer;
      accent-color: #6366f1;
    }
    .hold-slider:disabled { opacity: 0.4; cursor: not-allowed; }

    .shortcut-actions {
      display: flex; gap: 0.4rem; flex-wrap: wrap;
    }
    .shortcut-actions .btn { display: inline-flex; align-items: center; gap: 0.3rem; }
  `,
})
export class UserSettingsComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly uiPrefs = inject(UiPreferencesService);
  private readonly swal = inject(SwalService);
  private readonly translate = inject(TranslateService);
  // Session/sub-agent toast prefs live here (localStorage-only) — must never
  // enter the saved ui-preferences payload.
  protected readonly hookService = inject(ClaudeHookService);
  private readonly sessionService = inject(SessionService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  /** Row named by ?highlight=<row>: scrolled into view and lit up on arrival. */
  protected readonly highlightRow = signal<string | null>(null);

  /** Windows-only roster for the default-shell select (PowerShell/pwsh/cmd/Git Bash/WSL). */
  protected terminalShells: Array<{ id: string; kind: string; label: string; distro?: string }> = [];

  protected loading = signal(true);
  protected saving = signal(false);
  protected saved = signal(false);

  protected form: ResolvedUiPreferences = this.uiPrefs.defaults;

  protected readonly fontOptions = FONT_OPTIONS;
  protected readonly monoFontOptions = MONO_FONT_OPTIONS;

  protected readonly themeOptions = [
    { value: "light" as const, labelKey: "Theme Light", icon: "solar:sun-bold" },
    { value: "dark" as const, labelKey: "Theme Dark", icon: "solar:moon-bold" },
    { value: "system" as const, labelKey: "Theme System", icon: "solar:monitor-bold" },
  ];

  protected readonly sidebarOptions = [
    { value: "default", labelKey: "Sidebar Default" },
    { value: "compact", labelKey: "Sidebar Compact" },
    { value: "condensed", labelKey: "Sidebar Condensed" },
    { value: "sm-hover", labelKey: "Sidebar Hover" },
    { value: "sm-hover-active", labelKey: "Sidebar Hover Active" },
    { value: "fullscreen", labelKey: "Sidebar Hidden" },
  ];

  protected readonly cursorOptions = [
    { value: "block" as const, labelKey: "Cursor Block" },
    { value: "underline" as const, labelKey: "Cursor Underline" },
    { value: "bar" as const, labelKey: "Cursor Bar" },
  ];

  private saveTimeout: any = null;

  // ── Voice ─────────────────────────────────────────────────
  protected voiceApiKey = "";
  protected voiceMaskedKey = signal<string | null>(null);
  // Only a key saved in the app is used: environment variables are ignored
  // and this edition has no transcription server.
  protected voiceKeySource = signal<"user" | null>(null);
  protected voiceTesting = signal(false);
  protected voiceFeedback = signal<string>("");
  protected voiceFeedbackKind = signal<"ok" | "err" | "">("");

  // ── App startup (launch at login) ────────────────────────
  // Off until loadAutoLaunch() reads the real OS state: the app never turns
  // launch at login on by itself.
  protected autoLaunchEnabled = signal(false);

  // ── Auto-standby (park non-active sessions) ──────────────
  // 0 = Never (feature off). Stored by the native desktop process (app data
  // JSON) because the lazy-boot restore reads it before the renderer exists.
  protected autoStandbyMinutes = signal(60);
  protected readonly autoStandbyOptions = [0, 1, 5, 10, 15, 30, 60];

  // ── Voice global shortcut ────────────────────────────────
  protected shortcutEnabled = signal(true);
  protected shortcutHoldMs = signal(2000);
  private holdSaveTimeout: any = null;
  private modalService = inject(NgbModal);

  protected get isDesktop(): boolean {
    return !!(window as any).promptops?.getVoiceApiKey;
  }

  protected get isMacOS(): boolean {
    return navigator.userAgent.includes("Macintosh");
  }

  /** True only inside the desktop app on Windows. Gates the Windows-only
   *  "Safe terminal" diagnostic toggle so it never appears on macOS/Linux. */
  protected get isWindows(): boolean {
    const plat = (window as any).promptops?.platform;
    if (plat) return plat === "win32";
    return navigator.userAgent.includes("Windows");
  }

  /** Desktop v2 (Tauri): the host keeps terminal screens, so the toggle exists only there. */
  protected get isDesktopV2(): boolean {
    return typeof (window as any).promptops?.setTerminalHostScreen === "function";
  }

  /** Windows desktop: gates the default-shell select (needs shell detection IPC). */
  protected get isWindowsDesktop(): boolean {
    return this.sessionService.isWindowsDesktop;
  }

  ngOnInit(): void {
    this.store
      .select(getUser)
      .pipe(
        filter((u): u is NonNullable<typeof u> => !!u),
        first()
      )
      .subscribe((user) => {
        this.form = this.uiPrefs.resolve(user.ui_preferences);
        this.loading.set(false);
        this.applyHighlight();
      });

    this.loadVoiceKey();
    this.loadShortcutConfig();
    this.loadAutoLaunch();
    this.loadAutoStandbyConfig();
    this.loadTerminalShells();
  }

  /**
   * Deep link from a toast (?highlight=compact-suggestions): once the page is
   * rendered, scroll the row into view and glow it, then drop the param so a
   * reload doesn't replay it.
   */
  private applyHighlight(): void {
    const row = this.route.snapshot.queryParamMap.get("highlight");
    if (!row) return;
    this.highlightRow.set(row);
    setTimeout(() => {
      document.getElementById(`setting-${row}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
    setTimeout(() => this.highlightRow.set(null), 2600);
    void this.router.navigate([], { relativeTo: this.route, queryParams: { highlight: null }, queryParamsHandling: "merge", replaceUrl: true });
  }

  /** Windows-only: populate the default-shell select (cached detection, cheap). */
  private async loadTerminalShells(): Promise<void> {
    if (!this.isWindowsDesktop) return;
    try {
      const res = await this.sessionService.listTerminalShells();
      if (res?.ok && res.shells?.length) {
        this.terminalShells = res.shells;
        // Saved default no longer detected (e.g. WSL distro removed) → PowerShell.
        if (!res.shells.some((s) => s.id === this.form.terminal_default_shell)) {
          this.form.terminal_default_shell = "powershell";
        }
      }
    } catch { /* detection unavailable — select stays hidden */ }
  }

  private async loadAutoStandbyConfig(): Promise<void> {
    const api = (window as any).promptops;
    if (!api?.getAutoStandbyConfig) return;
    try {
      const res = await api.getAutoStandbyConfig();
      if (res?.ok && res.config) {
        this.autoStandbyMinutes.set(res.config.graceMinutes ?? 60);
      }
    } catch { /* ignore */ }
  }

  protected async onAutoStandbyChange(value: number): Promise<void> {
    const previous = this.autoStandbyMinutes();
    const minutes = Number(value);
    if (!Number.isFinite(minutes)) return;
    this.autoStandbyMinutes.set(minutes);
    const api = (window as any).promptops;
    if (!api?.setAutoStandbyConfig) return;
    try {
      await api.setAutoStandbyConfig({ graceMinutes: minutes });
    } catch (err: any) {
      this.autoStandbyMinutes.set(previous);
      this.swal.error(err?.message || this.translate.instant("SETTINGS.Save Error"));
    }
  }

  protected onToastDurationInput(value: string): void {
    const sec = parseInt(value, 10);
    if (Number.isFinite(sec)) this.hookService.setToastDurationMs(sec * 1000);
  }

  private async loadAutoLaunch(): Promise<void> {
    const api = (window as any).promptops;
    if (!api?.getAutoLaunch) return;
    try {
      this.autoLaunchEnabled.set(!!(await api.getAutoLaunch()));
    } catch { /* ignore */ }
  }

  protected async toggleAutoLaunch(enabled: boolean): Promise<void> {
    this.autoLaunchEnabled.set(enabled);
    const api = (window as any).promptops;
    if (!api?.setAutoLaunch) return;
    try {
      await api.setAutoLaunch(enabled);
    } catch {
      // Revert UI if the OS call failed
      this.autoLaunchEnabled.set(!enabled);
    }
  }

  private async loadShortcutConfig(): Promise<void> {
    const api = (window as any).promptops;
    if (!api?.getVoiceShortcutConfig) return;
    try {
      const res = await api.getVoiceShortcutConfig();
      if (res?.ok && res.config) {
        this.shortcutEnabled.set(!!res.config.enabled);
        this.shortcutHoldMs.set(res.config.holdMs ?? 2000);
      }
    } catch { /* ignore */ }
  }

  protected async toggleShortcut(enabled: boolean): Promise<void> {
    this.shortcutEnabled.set(enabled);
    const api = (window as any).promptops;
    if (!api?.setVoiceShortcutConfig) return;
    try {
      await api.setVoiceShortcutConfig({ enabled });
    } catch (err: any) {
      // Revert UI if local store rejected
      this.shortcutEnabled.set(!enabled);
      this.swal.error(err?.message || this.translate.instant("SETTINGS.Save Error"));
    }
  }

  protected onHoldInput(value: string): void {
    const ms = parseInt(value, 10);
    if (Number.isFinite(ms)) this.shortcutHoldMs.set(ms);
  }

  protected commitHold(): void {
    if (this.holdSaveTimeout) clearTimeout(this.holdSaveTimeout);
    this.holdSaveTimeout = setTimeout(async () => {
      const api = (window as any).promptops;
      if (!api?.setVoiceShortcutConfig) return;
      try {
        await api.setVoiceShortcutConfig({ holdMs: this.shortcutHoldMs() });
      } catch (err: any) {
        this.swal.error(err?.message || this.translate.instant("SETTINGS.Save Error"));
      }
    }, 200);
  }

  protected reopenOnboarding(): void {
    // Clear the "onboarded" flag so the wizard knows the user wants a refresher.
    localStorage.removeItem("voice_onboarded");
    this.modalService.open(VoiceOnboardingModalComponent, {
      size: "md",
      centered: true,
      backdrop: "static",
    });
  }

  protected async openMacSettings(pane: "accessibility"): Promise<void> {
    const api = (window as any).promptops;
    if (api?.openVoiceSystemSettings) {
      await api.openVoiceSystemSettings(pane);
    }
  }

  private async loadVoiceKey(): Promise<void> {
    const api = (window as any).promptops;
    if (!api?.getVoiceApiKey) return;
    try {
      const res = await api.getVoiceApiKey();
      this.voiceMaskedKey.set(res?.hasKey ? res.masked : null);
      this.voiceKeySource.set(res?.source === "user" ? "user" : null);
    } catch { /* ignore */ }
  }

  private flashVoiceFeedback(msg: string, kind: "ok" | "err"): void {
    this.voiceFeedback.set(msg);
    this.voiceFeedbackKind.set(kind);
    setTimeout(() => { this.voiceFeedback.set(""); this.voiceFeedbackKind.set(""); }, 4000);
  }

  protected async testVoiceKey(): Promise<void> {
    const api = (window as any).promptops;
    if (!api?.testVoiceApiKey || !this.voiceApiKey) return;
    this.voiceTesting.set(true);
    try {
      const res = await api.testVoiceApiKey(this.voiceApiKey);
      if (res?.ok) {
        this.flashVoiceFeedback(this.translate.instant("SETTINGS.Voice Key Valid"), "ok");
      } else {
        this.flashVoiceFeedback(
          this.translate.instant("SETTINGS.Voice Key Invalid", { error: res?.error || "?" }),
          "err"
        );
      }
    } catch (err: any) {
      this.flashVoiceFeedback(
        this.translate.instant("SETTINGS.Voice Key Invalid", { error: err.message || "?" }),
        "err"
      );
    } finally {
      this.voiceTesting.set(false);
    }
  }

  protected async saveVoiceKey(): Promise<void> {
    const api = (window as any).promptops;
    if (!api?.setVoiceApiKey || !this.voiceApiKey) return;
    try {
      const res = await api.setVoiceApiKey(this.voiceApiKey);
      // The store write can fail ({ok:false}): the key must not look saved.
      if (res && res.ok === false) {
        this.flashVoiceFeedback(this.translate.instant("SETTINGS.Voice Key Save Failed", { error: res.error ?? "" }), "err");
        return;
      }
      this.voiceApiKey = "";
      await this.loadVoiceKey();
      this.flashVoiceFeedback(this.translate.instant("SETTINGS.Voice Key Saved"), "ok");
    } catch (err: any) {
      this.flashVoiceFeedback(err.message || "error", "err");
    }
  }

  protected async removeVoiceKey(): Promise<void> {
    const api = (window as any).promptops;
    if (!api?.setVoiceApiKey) return;
    try {
      const res = await api.setVoiceApiKey(null);
      if (res && res.ok === false) {
        this.flashVoiceFeedback(this.translate.instant("SETTINGS.Voice Key Save Failed", { error: res.error ?? "" }), "err");
        return;
      }
      await this.loadVoiceKey();
      this.flashVoiceFeedback(this.translate.instant("SETTINGS.Voice Key Removed"), "ok");
    } catch (err: any) {
      this.flashVoiceFeedback(err.message || "error", "err");
    }
  }

  protected openExternal(ev: Event, url: string): void {
    const api = (window as any).promptops;
    if (api?.openExternal) {
      ev.preventDefault();
      api.openExternal(url);
    }
  }

  /** Debounced auto-save + live preview. */
  protected previewAndSave(): void {
    // Live preview
    this.uiPrefs.apply(this.form);

    // Debounce the API call
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this.persistToServer(), 600);
  }

  private async persistToServer(): Promise<void> {
    this.saving.set(true);
    this.saved.set(false);
    try {
      await this.uiPrefs.save({ ...this.form });
      this.saved.set(true);
      setTimeout(() => this.saved.set(false), 2000);
    } catch (err: any) {
      this.swal.error(
        err?.message || this.translate.instant("SETTINGS.Save Error")
      );
    } finally {
      this.saving.set(false);
    }
  }
}
