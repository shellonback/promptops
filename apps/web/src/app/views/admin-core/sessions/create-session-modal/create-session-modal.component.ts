import { Component, CUSTOM_ELEMENTS_SCHEMA, inject, signal, OnInit, ViewChild, ElementRef, Injector, ChangeDetectionStrategy, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { Store } from '@ngrx/store';
import { firstValueFrom } from 'rxjs';
import { RemoteProbeResult, SessionService } from '../services/session.service';
import { SessionHistoryService } from '../services/session-history.service';
import { DataBackend, scoped$, isDataError, type DataError } from '@core/data/data-backend';
import { SwalService } from '@core/services/swal.service';
import { UiStyleService } from '@core/services/ui-style.service';
import { AuthenticationService } from '@core/services/auth.service';
import { ProviderService } from '@core/services/provider.service';
import { ProjectFolderImportService, ProjectFolderScan } from '../services/project-folder-import.service';
import { ProviderId } from '@core/providers/provider-capability';
import { getUser } from '@/store/authentication/authentication.selector';
import { TooltipDirective } from '../../../../common/tooltip.directive';
import { ProviderPickerComponent } from '../../../../common/provider-picker/provider-picker.component';
import { environment } from '@environment/environment';

import { SpawnSelectionService } from '../services/spawn-selection.service';
import { LOCAL_HOST_KEY, RemoteHost, SessionHostsService, commandHostLabel, sshHostKey } from '../services/session-host';
interface TeamOption {
  id: number;
  name: string;
}

interface ProjectOption {
  id: number;
  name: string;
}

/** `session_name_taken`: the requested name belongs to another of the
 *  user's sessions (deleted ones included). */
function isSessionNameTaken(err: unknown): err is DataError {
  return isDataError(err, 'session_name_taken');
}

import { BuiltinPluginsService } from '../../plugins/builtin-plugins.service';
@Component({
  selector: 'app-create-session-modal',
  standalone: true,
  imports: [FormsModule, TranslateModule, TooltipDirective, ProviderPickerComponent],
  templateUrl: './create-session-modal.component.html',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    :host ::ng-deep .modal-dialog.modal-lg { max-width: 860px; }
    /* Header + footer stay visible, only the body scrolls (remote / clone
       forms can be taller than the viewport). Tooltips are appended to
       <body>, so nothing inside needs overflow: visible. */
    :host {
      display: flex;
      flex-direction: column;
      max-height: calc(100vh - 2 * var(--bs-modal-margin, 1.75rem));
      max-height: calc(100dvh - 2 * var(--bs-modal-margin, 1.75rem));
      min-height: 0;
    }
    :host > .modal-header,
    :host > .modal-footer { flex-shrink: 0; }

    .create-session-body {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px 20px;
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
    }

    .form-section {
      background: var(--bs-body-bg, #fff);
      border: 1px solid var(--bs-border-color, rgba(0, 0, 0, 0.08));
      border-radius: 12px;
      padding: 14px 14px;
    }

    .provider-section {
      background: linear-gradient(180deg, rgba(99, 102, 241, 0.03), rgba(168, 85, 247, 0.02));
      border-color: rgba(99, 102, 241, 0.18);
    }

    .section-head {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }

    .section-head-icon {
      width: 28px;
      height: 28px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      background: linear-gradient(135deg, #6366f1, #a855f7);
      color: #fff;
    }

    .section-head-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }

    .section-title {
      font-size: 13.5px;
      font-weight: 700;
      margin: 0;
      color: var(--bs-body-color, #1f2937);
    }

    .section-hint {
      font-size: 12px;
      margin: 0;
      color: var(--bs-secondary-color, #6c757d);
      line-height: 1.35;
    }

    .form-grid-2 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
    }

    .advanced-toggle {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-top: 8px;
      color: #6366f1;
      text-decoration: none;
      font-weight: 500;
    }
    .advanced-toggle:hover { text-decoration: underline; }

    /* ── Path mode toggle ── */
    .path-mode-toggle {
      display: flex;
      gap: 0;
      border: 1px solid var(--bs-border-color, rgba(0, 0, 0, 0.1));
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 10px;
    }
    .path-mode-btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 7px 12px;
      background: transparent;
      border: none;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--bs-secondary-color, #6c757d);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .path-mode-btn:not(:last-child) {
      border-inline-end: 1px solid var(--bs-border-color, rgba(0, 0, 0, 0.1));
    }
    .path-mode-btn:hover:not(.is-active) {
      background: rgba(99, 102, 241, 0.04);
      color: var(--bs-body-color, #1f2937);
    }
    .path-mode-btn.is-active {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(168, 85, 247, 0.06));
      color: #6366f1;
    }

    /* ── Clone form inside create modal ── */
    .clone-inline-form {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .clone-inline-field label {
      display: block;
      font-size: 12px;
      font-weight: 500;
      color: var(--bs-secondary-color, #6c757d);
      margin-bottom: 3px;
    }
    .clone-inline-field input {
      font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
    }
    .clone-dest-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .clone-dest-row .form-control {
      font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
    }
    .clone-progress-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
      font-size: 12.5px;
      color: var(--bs-secondary-color, #6c757d);
    }
    .clone-error-msg {
      font-size: 12px;
      color: var(--bs-danger, #dc3545);
      margin-top: 2px;
    }

    /* ── Remote (SSH) folder picker — beta ── */
    .remote-dir-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 180px;
      overflow-y: auto;
      border: 1px solid var(--bs-border-color, #dee2e6);
      border-radius: 8px;
      padding: 4px;
    }
    .remote-dir-item {
      display: flex;
      align-items: center;
      gap: 6px;
      border: 0;
      background: transparent;
      text-align: start;
      padding: 4px 8px;
      border-radius: 6px;
      font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12.5px;
      color: var(--bs-body-color);
      cursor: pointer;
    }
    .remote-dir-item:hover {
      background: var(--bs-tertiary-bg, rgba(0, 0, 0, 0.05));
    }
    .remote-dir-loading {
      display: flex;
      justify-content: center;
      padding: 10px 0;
    }
    .remote-conn-form {
      display: flex;
      flex-direction: column;
      gap: 8px;
      border: 1px dashed var(--bs-border-color, #dee2e6);
      border-radius: 8px;
      padding: 10px;
    }
    .remote-conn-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .remote-conn-grid .remote-key-input {
      grid-column: 1 / -1;
      font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11.5px;
    }
    .remote-example-chips {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin: 6px 0 2px;
    }
    .remote-example-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 1px solid rgba(99, 102, 241, 0.3);
      background: rgba(99, 102, 241, 0.06);
      color: #6366f1;
      border-radius: 999px;
      padding: 2px 10px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
    }
    .remote-example-chip:hover {
      background: rgba(99, 102, 241, 0.12);
    }
    .remote-steps {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
    }
    .remote-step {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--bs-secondary-color, #6c757d);
    }
    .remote-step.is-active { color: var(--bs-body-color); }
    .remote-step.is-done { color: var(--bs-success, #198754); }
    .remote-step-num {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border-radius: 999px;
      font-size: 11px;
      border: 1px solid currentColor;
    }
    .remote-step.is-active .remote-step-num {
      background: #6366f1;
      border-color: #6366f1;
      color: #fff;
    }
    .remote-step-sep {
      flex: 0 0 24px;
      height: 1px;
      background: var(--bs-border-color, #dee2e6);
    }
    .remote-probe-card {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 12.5px;
      border: 1px solid var(--bs-border-color, #dee2e6);
    }
    .remote-probe-card.is-pending { align-items: center; color: var(--bs-secondary-color, #6c757d); }
    .remote-probe-card.is-ok {
      border-color: rgba(25, 135, 84, 0.35);
      background: rgba(25, 135, 84, 0.06);
    }
    .remote-probe-icon { color: var(--bs-success, #198754); margin-top: 1px; }
    .remote-probe-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .remote-probe-title code { font-size: 12px; }
    .remote-probe-meta { display: flex; flex-wrap: wrap; gap: 4px; }
    .remote-probe-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border-radius: 999px;
      padding: 1px 8px;
      font-size: 11px;
      font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: var(--bs-tertiary-bg, rgba(0, 0, 0, 0.05));
    }
    .remote-probe-chip.is-cli { color: var(--bs-success, #198754); }
    .remote-probe-warn {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11.5px;
      color: var(--bs-warning-text-emphasis, #997404);
    }
    .remote-folder-tabs { margin-bottom: 6px; }
    .remote-current-path {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      margin-bottom: 4px;
      min-width: 0;
    }
    .remote-current-path code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .remote-use-path {
      color: inherit;
      opacity: 0.85;
      font-size: 11px;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .remote-term {
      border-radius: 8px;
      background: #0a0a0a;
      color: #e5e7eb;
      font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      padding: 8px 10px;
      cursor: text;
    }
    .remote-term-out {
      max-height: 180px;
      min-height: 60px;
      overflow-y: auto;
      margin-bottom: 4px;
    }
    .remote-term-line { white-space: pre-wrap; word-break: break-all; }
    .remote-term-line.is-cmd { color: #a5b4fc; }
    .remote-term-line.is-err { color: #f87171; }
    .remote-term-line.is-hint { color: #6b7280; }
    .remote-term-prompt { display: flex; align-items: center; gap: 6px; }
    .remote-term-ps1 { color: #a5b4fc; white-space: nowrap; max-width: 45%; overflow: hidden; text-overflow: ellipsis; }
    .remote-term-prompt input {
      flex: 1;
      min-width: 0;
      background: transparent;
      border: 0;
      outline: none;
      color: inherit;
      font: inherit;
    }

    @media (max-width: 576px) {
      .create-session-body { padding: 14px; gap: 10px; }
      .form-section { padding: 12px; }
    }

    /* ── Wizard stepper ── */
    .wizard-stepper {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
    }
    .wizard-step {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border: 1.5px solid var(--bs-border-color, rgba(0, 0, 0, 0.1));
      background: transparent;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      color: var(--bs-secondary-color, #6c757d);
      cursor: pointer;
      transition: all 0.15s ease;
      flex: 0 1 auto;
    }
    .wizard-step:hover:not([disabled]) {
      border-color: rgba(99, 102, 241, 0.4);
      color: var(--bs-body-color, #1f2937);
    }
    .wizard-step.is-active {
      background: linear-gradient(135deg, #6366f1, #a855f7);
      border-color: transparent;
      color: #fff;
      box-shadow: 0 2px 8px rgba(99, 102, 241, 0.25);
    }
    .wizard-step.is-done {
      border-color: rgba(99, 102, 241, 0.4);
      color: #6366f1;
    }
    .wizard-step[disabled] {
      cursor: not-allowed;
      opacity: 0.5;
    }
    .wizard-step .step-num {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.18);
      font-size: 11px;
      font-weight: 700;
    }
    .wizard-step.is-active .step-num {
      background: rgba(255, 255, 255, 0.25);
    }
    .wizard-step:not(.is-active) .step-num {
      background: var(--bs-tertiary-bg, rgba(0, 0, 0, 0.05));
      color: var(--bs-secondary-color, #6c757d);
    }
    .wizard-step.is-done .step-num {
      background: rgba(99, 102, 241, 0.12);
      color: #6366f1;
    }
    .wizard-step-divider {
      flex: 1 1 auto;
      height: 2px;
      background: var(--bs-border-color, rgba(0, 0, 0, 0.08));
      border-radius: 999px;
      min-width: 16px;
    }

    /* ── Provider read-only row (edit mode) ── */
    .project-container-hint {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0.65rem;
      border-radius: 8px;
      font-size: 0.8rem;
      border: 1px solid color-mix(in oklab, var(--po-accent, #6366F1) 35%, transparent);
      background: color-mix(in oklab, var(--po-accent, #6366F1) 8%, transparent);
    }
    .project-container-hint iconify-icon { color: var(--po-accent, #6366F1); flex-shrink: 0; }
    .provider-readonly {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
    }
    .provider-readonly-text {
      flex: 1 1 auto;
      min-width: 0;
      line-height: 1.3;
    }
    .provider-readonly-text strong {
      font-size: 13.5px;
      font-weight: 500;
      color: var(--bs-body-color, #1f2937);
    }
    .provider-readonly-text small {
      font-size: 11.5px;
      margin-top: 2px;
    }
    .provider-readonly-text code {
      background: var(--bs-tertiary-bg, rgba(0, 0, 0, 0.05));
      padding: 1px 5px;
      border-radius: 4px;
      font-size: 11px;
    }
    .context-file-prompt {
      display: flex;
      flex-direction: column;
      gap: 10px;
      border: 1px solid rgba(245, 158, 11, 0.45);
      background: rgba(245, 158, 11, 0.08);
      border-radius: 12px;
      padding: 12px 14px;
    }

    .context-file-prompt-text {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      font-size: 0.85rem;
    }

    .context-file-prompt-text iconify-icon {
      color: #f59e0b;
      flex-shrink: 0;
      margin-top: 2px;
    }

    .context-file-prompt-text p {
      margin: 4px 0 0;
      opacity: 0.85;
    }

    .context-file-prompt-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }

    /* ═══ Minimal monochrome look: the whole modal in gray,
       only the provider logos (.tile-logo) stay in color. ═══ */
    .form-section,
    .provider-section {
      background: transparent;
      border: 0;
      border-radius: 0;
      padding: 0;
    }
    .section-head-icon {
      background: var(--bs-secondary-bg, #e9ecef);
      color: var(--bs-secondary-color, #6c757d);
    }
    .advanced-toggle { color: var(--bs-secondary-color, #6c757d); }
    .path-mode-btn:hover:not(.is-active) {
      background: var(--bs-secondary-bg, rgba(0, 0, 0, 0.05));
      color: var(--bs-body-color, #1f2937);
    }
    .path-mode-btn.is-active {
      background: var(--bs-secondary-bg, #e9ecef);
      color: var(--bs-body-color, #1f2937);
    }
    .wizard-step:hover:not([disabled]) {
      border-color: var(--bs-secondary-color, #6c757d);
      color: var(--bs-body-color, #1f2937);
    }
    .wizard-step.is-active {
      background: var(--bs-secondary-bg, #e9ecef);
      border-color: var(--bs-border-color, rgba(0, 0, 0, 0.15));
      color: var(--bs-body-color, #1f2937);
      box-shadow: none;
    }
    .wizard-step.is-done {
      border-color: var(--bs-border-color, rgba(0, 0, 0, 0.15));
      color: var(--bs-body-color, #1f2937);
    }
    .wizard-step .step-num,
    .wizard-step.is-active .step-num,
    .wizard-step:not(.is-active) .step-num,
    .wizard-step.is-done .step-num {
      background: var(--bs-tertiary-bg, rgba(0, 0, 0, 0.05));
      color: var(--bs-secondary-color, #6c757d);
    }
    .context-file-prompt {
      border: 1px solid var(--bs-border-color, rgba(0, 0, 0, 0.1));
      background: transparent;
    }
    .context-file-prompt-text iconify-icon { color: var(--bs-secondary-color, #6c757d); }
    .clone-error-msg { color: var(--bs-secondary-color, #6c757d); }

    /* Bootstrap classes inside the modal → gray */
    :host ::ng-deep .text-danger,
    :host ::ng-deep .text-success,
    :host ::ng-deep .text-warning,
    :host ::ng-deep .text-info,
    :host ::ng-deep .text-primary {
      color: var(--bs-secondary-color, #6c757d) !important;
    }
    :host ::ng-deep .btn-primary,
    :host ::ng-deep .btn-success {
      --bs-btn-color: #f8f9fa;
      --bs-btn-bg: #495057;
      --bs-btn-border-color: #495057;
      --bs-btn-hover-color: #f8f9fa;
      --bs-btn-hover-bg: #3d444b;
      --bs-btn-hover-border-color: #3d444b;
      --bs-btn-active-color: #f8f9fa;
      --bs-btn-active-bg: #343a40;
      --bs-btn-active-border-color: #343a40;
      --bs-btn-disabled-color: #f8f9fa;
      --bs-btn-disabled-bg: #495057;
      --bs-btn-disabled-border-color: #495057;
      --bs-btn-focus-shadow-rgb: 108, 117, 125;
    }
    :host ::ng-deep .btn-outline-primary,
    :host ::ng-deep .btn-outline-success,
    :host ::ng-deep .btn-outline-danger {
      --bs-btn-color: var(--bs-secondary-color, #6c757d);
      --bs-btn-border-color: var(--bs-border-color, #adb5bd);
      --bs-btn-hover-color: var(--bs-body-color, #1f2937);
      --bs-btn-hover-bg: var(--bs-secondary-bg, #e9ecef);
      --bs-btn-hover-border-color: var(--bs-border-color, #adb5bd);
      --bs-btn-active-color: #f8f9fa;
      --bs-btn-active-bg: #495057;
      --bs-btn-active-border-color: #495057;
      --bs-btn-focus-shadow-rgb: 108, 117, 125;
    }
    :host ::ng-deep .btn-link { color: var(--bs-secondary-color, #6c757d); }
    :host ::ng-deep .badge.text-bg-primary,
    :host ::ng-deep .badge.text-bg-secondary,
    :host ::ng-deep .badge.text-bg-success,
    :host ::ng-deep .badge.text-bg-info,
    :host ::ng-deep .badge.text-bg-warning {
      background-color: var(--bs-secondary-bg, #e9ecef) !important;
      color: var(--bs-secondary-color, #495057) !important;
    }
    :host ::ng-deep .alert-info {
      --bs-alert-bg: transparent;
      --bs-alert-border-color: var(--bs-border-color, #dee2e6);
      --bs-alert-color: var(--bs-body-color, #1f2937);
    }
    :host ::ng-deep .form-check-input:checked {
      background-color: #495057;
      border-color: #495057;
    }
    :host ::ng-deep .form-control:focus,
    :host ::ng-deep .form-select:focus {
      border-color: var(--bs-secondary-color, #adb5bd);
      box-shadow: 0 0 0 0.2rem rgba(108, 117, 125, 0.15);
    }

    /* Provider picker → gray (the .tile-logo logos stay in color) */
    :host ::ng-deep .provider-picker .provider-group[data-tier] {
      background: transparent !important;
      border-color: var(--bs-border-color, rgba(0, 0, 0, 0.08)) !important;
    }
    :host ::ng-deep .provider-picker .group-icon[data-tier] {
      background: var(--bs-secondary-bg, #e9ecef) !important;
      color: var(--bs-secondary-color, #6c757d) !important;
    }
    :host ::ng-deep .provider-picker .badge-free,
    :host ::ng-deep .provider-picker .badge-pro {
      background: var(--bs-secondary-bg, #e9ecef) !important;
      color: var(--bs-secondary-color, #495057) !important;
    }
    :host ::ng-deep .provider-picker .provider-tile:hover:not([disabled]) {
      border-color: var(--bs-secondary-color, #6c757d) !important;
      background: var(--bs-body-bg, #fff) !important;
    }
    :host ::ng-deep .provider-picker .provider-tile.is-selected {
      border-color: var(--bs-secondary-color, #6c757d) !important;
      box-shadow: 0 0 0 2px var(--bs-secondary-bg, rgba(0, 0, 0, 0.08)) !important;
      background: var(--bs-secondary-bg, rgba(0, 0, 0, 0.06)) !important;
    }
    :host ::ng-deep .provider-picker .tile-check-inline {
      color: var(--bs-body-color, #1f2937) !important;
    }
    /* Installed vs missing must stay distinguishable in the neutral picker. */
    :host ::ng-deep .provider-picker .tile-dot-ok {
      background: var(--promptops-success, #198754) !important;
      box-shadow: 0 0 0 2px rgba(25, 135, 84, 0.18) !important;
    }
    :host ::ng-deep .provider-picker .tile-dot-warn {
      background: var(--promptops-warning, #ffc107) !important;
      box-shadow: 0 0 0 2px rgba(255, 193, 7, 0.2) !important;
    }
    :host ::ng-deep .provider-picker .provider-microcopy[data-tier] {
      background: transparent !important;
      border-color: var(--bs-border-color, rgba(0, 0, 0, 0.08)) !important;
    }
    :host ::ng-deep .provider-picker .provider-microcopy[data-tier] i {
      color: var(--bs-secondary-color, #6c757d) !important;
    }

    /* ── Host picker (step 1): this computer / remote machines ── */
    .host-section { margin-bottom: 4px; }
    .host-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 300px;
      overflow-y: auto;
    }
    .host-group-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .04em;
      text-transform: uppercase;
      color: var(--po-text-secondary, #6c757d);
      margin-top: 6px;
    }
    .host-group-label:first-child { margin-top: 0; }
    .host-row-wrap { display: flex; align-items: center; gap: 4px; }
    .host-row {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      text-align: left;
      background: transparent;
      border: 1px solid var(--promptops-border-color, rgba(128, 128, 128, 0.25));
      border-radius: 8px;
      color: inherit;
      cursor: pointer;
      transition: background-color 0.15s ease, border-color 0.15s ease;
    }
    .host-row:hover:not(:disabled):not(.is-active) {
      background: var(--promptops-tertiary-bg, rgba(128, 128, 128, 0.08));
    }
    .host-row:focus-visible {
      outline: 2px solid var(--po-accent, #6366F1);
      outline-offset: 1px;
    }
    .host-row.is-active {
      border-color: var(--po-accent, #6366F1);
      background: rgba(99, 102, 241, 0.08);
    }
    .host-row:disabled { cursor: progress; opacity: .7; }
    .host-row.host-add { border-style: dashed; }
    .host-add-wrap { margin-top: 4px; }
    .host-row-icon { flex-shrink: 0; color: var(--po-text-secondary, #6c757d); }
    .host-row.is-active .host-row-icon,
    .host-row-check { color: var(--po-accent, #6366F1); }
    .host-row-check { flex-shrink: 0; margin-left: auto; }
    .host-row-text { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
    .host-row-name {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      font-size: 13px;
      font-weight: 600;
    }
    .host-row-name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .host-row-detail {
      font-size: 12px;
      color: var(--po-text-secondary, #6c757d);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .host-row-detail.is-mono { font-family: var(--promptops-font-monospace, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; }
    .host-kind {
      flex-shrink: 0;
      font-size: 10px;
      font-weight: 600;
      padding: 0 6px;
      border-radius: 999px;
      border: 1px solid var(--promptops-border-color, rgba(128, 128, 128, 0.3));
      color: var(--po-text-secondary, #6c757d);
    }
    .host-forget {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 0;
      border-radius: 6px;
      color: var(--po-text-secondary, #6c757d);
      cursor: pointer;
    }
    .host-forget:hover:not(:disabled) { color: var(--po-error, #f85149); background: var(--promptops-tertiary-bg, rgba(128, 128, 128, 0.08)); }
    .host-forget:focus-visible { outline: 2px solid var(--po-accent, #6366F1); }
    .host-detail { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
    .host-summary {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      font-size: 12.5px;
      color: var(--po-text-secondary, #6c757d);
    }
    .host-summary-name { font-weight: 600; color: var(--promptops-body-color, inherit); white-space: nowrap; }
    .host-summary-detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; }
  `],
})
export class CreateSessionModalComponent implements OnInit {
  modal = inject(NgbActiveModal);
  private spawnSelection = inject(SpawnSelectionService);
  private sessionService = inject(SessionService);
  private historyService = inject(SessionHistoryService);
  private localData = inject(DataBackend);
  private injector = inject(Injector);
  private swalService = inject(SwalService);
  private translateService = inject(TranslateService);
  private auth = inject(AuthenticationService);
  private providers = inject(ProviderService);
  private folderImport = inject(ProjectFolderImportService);
  private store = inject(Store);
  private uiStyle = inject(UiStyleService);
  private hosts = inject(SessionHostsService);

  /** Set via componentInstance for edit mode */
  editSession: {
    id: string;
    name: string;
    provider: string;
    workspace?: { path: string; name: string };
    teamId?: number | null;
    projectId?: number | null;
    categoryId?: number | null;
    workspaceId?: string | null;
  } | null = null;

  /** Set via componentInstance to inherit workspace context for new sessions */
  presetWorkspace: { id: string; path: string; name: string } | null = null;

  /**
   * Workspace-first UI feature flag — wired through environment so it can be
   * flipped without redeploying. When false, the modal renders exactly as it
   * did before the rollout (zero visual diff).
   */
  readonly workspaceFirstUI = !!(environment as any).workspaceFirstUI;

  /**
   * Bivio mode (only used when workspaceFirstUI is true). Persisted in
   * localStorage so the user's last choice is remembered across sessions.
   * Default = 'workspace' on first run after the flag is enabled.
   */
  mode: 'workspace' | 'standalone' = 'workspace';

  /**
   * Set via componentInstance to lock the mode (e.g. opened from the
   * dedicated "New Workspace" sidebar button). null = user-controlled.
   */
  forceMode: 'workspace' | 'standalone' | null = null;

  /**
   * Set via componentInstance to make the modal create only the workspace
   * (skip session creation). Used by the dedicated "New Workspace" button.
   * Combined with `createInitialSession` (template toggle) the user can
   * opt-in to also spawn an initial session inside the new workspace.
   */
  skipSessionCreation = false;

  /**
   * Template-bound toggle used when `skipSessionCreation` is true. When ON,
   * the "New Workspace" flow also spawns an initial session inside the new
   * workspace and opens it. Default ON because most users want this.
   */
  createInitialSession = true;

  /**
   * Edit-mode toggle: when set, the standalone session being edited will be
   * promoted to a workspace on submit. Only meaningful when the session has
   * no workspace_id yet and the workspace-first UI is on.
   */
  promoteToWorkspaceOnEdit = false;

  /**
   * Template-bound toggle: spawn the session with auto-approve ON. Maps to
   * `config.autoApprove`, which makes the provider CLI launch with its native
   * "approve everything" flag (and arms Claude's hook-based auto-approve).
   * OFF by default — auto-approve is high-blast-radius and must be opt-in.
   */
  autoApprove = false;

  /**
   * Two-step wizard state (create-only). Edit mode keeps the legacy single
   * page so users can change one field and save without clicking Next.
   *   1 = Provider picker
   *   2 = Path / type / name / team / project
   */
  readonly currentStep = signal<number>(1);

  /**
   * Steps of the create wizard, one decision each. The "host" step exists
   * only where a remote machine can be picked (see hostPickerVisible).
   */
  get wizardSteps(): Array<'host' | 'provider' | 'config'> {
    return this.hostPickerVisible ? ['host', 'provider', 'config'] : ['provider', 'config'];
  }

  get totalSteps(): number {
    return this.wizardSteps.length;
  }

  /** The step currently shown ('config' is also the whole edit page). */
  get stepId(): 'host' | 'provider' | 'config' {
    return this.wizardSteps[this.currentStep() - 1] ?? 'config';
  }

  stepTitleKey(step: 'host' | 'provider' | 'config'): string {
    if (step === 'host') return 'SESSIONS.HOST.Step title';
    return step === 'provider' ? 'SESSIONS.Step provider title' : 'SESSIONS.Step config title';
  }

  stepShortKey(step: 'host' | 'provider' | 'config'): string {
    if (step === 'host') return 'SESSIONS.HOST.Step short';
    return step === 'provider' ? 'SESSIONS.Step provider short' : 'SESSIONS.Step config short';
  }

  /** A step can be left only when its own choice is made. */
  private canLeaveStep(step: 'host' | 'provider' | 'config'): boolean {
    // A remote host being added is not a host yet: it must connect (or be
    // explicitly continued without verification) before moving on.
    if (step === 'host') return !this.addingHost();
    if (step === 'provider') return !!this.provider;
    return true;
  }

  /** Step `n` (1-based) is reachable when every step before it is complete. */
  canReachStep(n: number): boolean {
    return this.wizardSteps.slice(0, n - 1).every((s) => this.canLeaveStep(s));
  }

  goToStep(step: number): void {
    if (step < 1 || step > this.totalSteps || !this.canReachStep(step)) return;
    this.currentStep.set(step);
  }

  goToStepId(step: 'host' | 'provider' | 'config'): void {
    const index = this.wizardSteps.indexOf(step);
    if (index >= 0) this.goToStep(index + 1);
  }

  goNextStep(): void {
    if (this.canGoNext) this.goToStep(this.currentStep() + 1);
  }

  goPrevStep(): void {
    this.goToStep(this.currentStep() - 1);
  }

  /** Whether to render the wizard chrome (header stepper + Next/Back). */
  get useWizard(): boolean {
    return !this.isEdit;
  }

  /** True when the current step's data is valid enough to proceed. */
  get canGoNext(): boolean {
    return this.canLeaveStep(this.stepId);
  }

  // ── Host (where the session runs) — Tauri only, create wizard only ────

  readonly localHostKey = LOCAL_HOST_KEY;
  /** Selected host: `local`, or the key of a configured remote machine. */
  readonly hostKey = signal<string>(LOCAL_HOST_KEY);
  /** True while the "add remote host" form is open in step 1. */
  readonly addingHost = signal(false);
  readonly remoteHosts = this.hosts.remoteHosts;

  /**
   * The host picker replaces the "Remote folder" path mode in the create
   * wizard. Not shown in edit mode (single page, legacy path modes) nor when
   * a workspace is preset: there the workspace already decides the machine.
   */
  get hostPickerVisible(): boolean {
    return this.remoteAvailable && this.useWizard && !this.presetWorkspace;
  }

  /** True when the wizard is driving a remote machine (selected or being added). */
  get isRemoteHost(): boolean {
    return this.hostPickerVisible && (this.addingHost() || this.hostKey() !== LOCAL_HOST_KEY);
  }

  get selectedRemoteHost(): RemoteHost | null {
    return this.remoteHosts().find((h) => h.key === this.hostKey()) ?? null;
  }

  /** Changing machine drops the folder picked on the previous one. */
  private clearWorkspaceForHostChange(): void {
    if (this.workspace && this.name === this.workspace.name) this.name = '';
    this.workspace = null;
    this.contextDecisionDone = false;
    this.contextFilePrompt.set(null);
    this.projectContainer.set(null);
    this.remoteError.set(null);
  }

  selectLocalHost(): void {
    if (this.hostKey() === LOCAL_HOST_KEY && !this.addingHost()) return;
    this.clearWorkspaceForHostChange();
    this.addingHost.set(false);
    this.hostKey.set(LOCAL_HOST_KEY);
    this.pathMode.set('browse');
    this.resetRemoteProbe();
  }

  /** Picks a configured remote machine and verifies the connection right away. */
  async selectRemoteHost(host: RemoteHost): Promise<void> {
    if (this.hostKey() === host.key && !this.addingHost()) return;
    this.clearWorkspaceForHostChange();
    this.addingHost.set(false);
    this.hostKey.set(host.key);
    this.pathMode.set('remote');
    this.remoteBrowserPath.set('');
    if (host.kind === 'command') {
      this.remoteType.set('command');
      this.remoteConnId.set(null);
      this.remoteCommand.set(host.command ?? '');
      await this.remoteConnect();
      return;
    }
    this.remoteType.set('ssh');
    this.remoteCommand.set('');
    // The connection record is needed later for the workspace label.
    if (!this.remoteConnections().some((c) => c.id === host.connId)) {
      try {
        this.remoteConnections.set(await this.sessionService.listSshConnections());
      } catch { /* label falls back to the folder name */ }
    }
    await this.pickRemoteConnection(host.connId ?? null);
  }

  /** Opens the "add remote host" form: nothing is selected until it connects. */
  startAddHost(): void {
    if (this.addingHost()) return;
    this.clearWorkspaceForHostChange();
    this.addingHost.set(true);
    this.hostKey.set('');
    this.pathMode.set('remote');
    this.remoteType.set('command');
    this.remoteCommand.set('');
    this.remoteConnId.set(null);
    this.remoteBrowserPath.set('');
    this.remoteNewConn.set(false);
    this.resetRemoteProbe();
  }

  cancelAddHost(): void {
    if (!this.addingHost()) return;
    this.addingHost.set(false);
    this.selectLocalHostAfterCancel();
  }

  private selectLocalHostAfterCancel(): void {
    this.hostKey.set(LOCAL_HOST_KEY);
    this.pathMode.set('browse');
    this.remoteCommand.set('');
    this.remoteConnId.set(null);
    this.remoteError.set(null);
    this.resetRemoteProbe();
  }

  /** The host being added is now usable: it joins the configured machines. */
  private async commitAddedHost(): Promise<void> {
    if (!this.addingHost()) return;
    if (this.remoteType() === 'command') {
      const host = this.hosts.rememberCommand(this.remoteCommand());
      if (!host) return;
      this.hostKey.set(host.key);
    } else {
      const id = this.remoteConnId();
      if (!id) return;
      await this.hosts.refresh();
      this.hostKey.set(sshHostKey(id));
    }
    this.addingHost.set(false);
  }

  /** Forgets a remembered connect command (SSH connections are managed in the SSH panel). */
  forgetRemoteHost(host: RemoteHost, event?: Event): void {
    event?.stopPropagation();
    if (host.kind !== 'command' || !host.command) return;
    const wasSelected = this.hostKey() === host.key;
    this.hosts.forgetCommand(host.command);
    if (wasSelected) {
      this.clearWorkspaceForHostChange();
      this.selectLocalHostAfterCancel();
    }
  }

  /**
   * Set via componentInstance when the session/new-tab belongs to a workspace
   * that has team/project configured. These values are read-only.
   */
  workspaceTeamId: number | null = null;
  workspaceTeamName: string | null = null;
  workspaceProjectId: number | null = null;
  workspaceProjectName: string | null = null;

  name = '';
  provider: ProviderId = 'claude-code-cli';
  workspace: { path: string; name: string } | null = null;
  teamId: number | null = null;
  projectId: number | null = null;
  cols = 120;
  rows = 30;
  showAdvanced = signal(false);
  saving = signal(false);

  /**
   * Windows-only terminal shell selection. The select is fed by the desktop
   * shell detection (PowerShell / pwsh / cmd / Git Bash / one entry per WSL
   * distro); the detect button probes ON DEMAND in which of those shells the
   * selected provider's CLI is installed. Hidden on macOS/Linux and in the
   * browser build.
   */
  shellId = CreateSessionModalComponent.defaultShellId();

  /**
   * '' = no per-session override — the native side falls back to the
   * Settings default at every spawn/wake (uniform system).
   */
  private static defaultShellId(): string {
    return '';
  }

  get isTauriDesktop(): boolean {
    return this.sessionService.isTauri;
  }
  terminalShells = signal<Array<{ id: string; kind: string; label: string; distro?: string }>>([]);
  shellProbe = signal<{ command: string | null; results: Record<string, boolean> } | null>(null);
  probingShells = signal(false);

  get isWindowsDesktop(): boolean {
    return this.sessionService.isWindowsDesktop;
  }

  /**
   * Curated provider context files (CLAUDE.md, AGENTS.md, …) found at the
   * picked path. When set, the modal shows an inline question asking whether
   * PromptOps may update them or must leave them untouched. Submit is halted
   * until the user decides; the decision is persisted per-workspace.
   */
  contextFilePrompt = signal<string[] | null>(null);
  private contextDecisionDone = false;

  /** Clone mode state */
  pathMode = signal<'browse' | 'clone' | 'new' | 'remote'>('browse');
  cloneUrl = signal('');
  cloneBranch = signal('');
  cloneDestination = signal<string | null>(null);
  cloning = signal(false);
  cloneError = signal<string | null>(null);

  /**
   * Remote Folder mode state — beta, Tauri only. Two transports:
   *  - 'command' (PREFERRED, default): the user's connect command (`ssh
   *    user@host`, `aws ssm start-session --target i-…`) runs in the session
   *    PTY and is kept alive; cwd = `cmd://<remote path>` + the command is
   *    persisted in config.remoteCommand. Folder browsing runs THROUGH the
   *    command (`ssh host '<script>'`) when it supports a remote-command
   *    argument, else the path is typed manually.
   *  - 'ssh': saved SSH connection (russh) → cwd = `ssh://<connId>/<path>`.
   * The native side routes the session onto the right transport from the cwd
   * scheme; everything else in this modal flows unchanged.
   */
  remoteType = signal<'command' | 'ssh'>('command');
  remoteCommand = signal('');
  remoteConnections = signal<Array<{ id: string; name: string; host: string; port: number; username: string }>>([]);
  remoteConnId = signal<string | null>(null);
  remoteBrowserPath = signal('');
  remoteEntries = signal<Array<{ name: string; isDir: boolean }>>([]);
  remoteLoading = signal(false);
  remoteError = signal<string | null>(null);
  remoteNewConn = signal(false);
  remoteNewFolderName = signal('');
  remoteSavingConn = signal(false);
  /**
   * Guided 2-step setup: (1) connection verified with a probe
   * (OS/arch/home/CLI) → (2) folder from the dropdown, by hand or from the mini-terminal.
   * `remoteSkipProbe`: commands without a remote argument (AWS SSM) cannot
   * be verified → we continue with the hand-typed path.
   */
  remoteProbe = signal<RemoteProbeResult | null>(null);
  remoteProbing = signal(false);
  remoteSkipProbe = signal(false);
  remoteFolderMode = signal<'browse' | 'manual' | 'terminal'>('browse');
  remoteTermLines = signal<Array<{ kind: 'cmd' | 'out' | 'err'; text: string }>>([]);
  remoteTermInput = signal('');
  remoteTermBusy = signal(false);
  @ViewChild('remoteTermOut') remoteTermOut?: ElementRef<HTMLElement>;
  remoteConnForm: {
    name: string; host: string; port: number; username: string;
    authType: 'password' | 'key'; secret: string; passphrase: string;
  } = { name: '', host: '', port: 22, username: '', authType: 'password', secret: '', passphrase: '' };

  /** New-folder mode state: pick a parent directory + type the folder name */
  newFolderParent = signal<string | null>(null);
  newFolderName = signal('');
  creatingFolder = signal(false);
  newFolderError = signal<string | null>(null);
  teams = signal<TeamOption[]>([]);
  projects = signal<ProjectOption[]>([]);
  creatingTeam = signal(false);
  savingTeam = signal(false);
  teamError = signal<string | null>(null);
  newTeamName = '';
  creatingProject = signal(false);
  savingProject = signal(false);
  projectError = signal<string | null>(null);
  newProjectName = '';

  @ViewChild('newTeamInput') newTeamInput!: ElementRef<HTMLInputElement>;
  @ViewChild('newProjectInput') newProjectInput!: ElementRef<HTMLInputElement>;

  /** True when team/project are inherited from the workspace and should not be changed here */
  get lockedByWorkspace(): boolean {
    return !!(this.workspaceTeamId || this.workspaceProjectId);
  }

  get isEdit(): boolean {
    return !!this.editSession;
  }

  /** Translated UI text for messages built in TS (errors shown inline). */
  private t(key: string, params?: Record<string, unknown>): string {
    return this.translateService.instant(key, params);
  }

  /**
   * Enter = primary action (Next before the last step, Create/Save otherwise), only when
   * it is safe: not from a textarea/button/select/link, not from the inline
   * sub-forms that have their own action (clone, new folder, remote), not
   * while the context-file question is open and never when the primary
   * button is disabled.
   */
  @HostListener('keydown.enter', ['$event'])
  onEnter(event: Event): void {
    const ev = event as KeyboardEvent;
    if (ev.defaultPrevented || ev.isComposing || ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const target = ev.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'A') return;
    if (target?.closest?.('.clone-inline-form, .remote-conn-form, .context-file-prompt')) return;
    if (this.contextFilePrompt()) return;
    if (this.useWizard && this.stepId !== 'config') {
      if (!this.canGoNext) return;
      ev.preventDefault();
      this.goNextStep();
      return;
    }
    if (this.submitDisabled) return;
    ev.preventDefault();
    void this.submit();
  }

  async ngOnInit(): Promise<void> {
    // Fresh detection at every open: the cached one could say "Not installed"
    // for a CLI installed since (or detected before PATH was resolved).
    if ((window as unknown as { __TAURI__?: unknown }).__TAURI__) void this.providers.refreshDetection();
    // Configured remote machines for the host picker (step 1). Best effort.
    if (this.hostPickerVisible) void this.hosts.refresh();
    // Resolve the bivio mode (only meaningful when workspaceFirstUI is on).
    // Priority: forceMode (programmatic) > preset workspace > localStorage > default.
    if (this.workspaceFirstUI) {
      if (this.forceMode) {
        this.mode = this.forceMode;
      } else if (this.presetWorkspace) {
        this.mode = 'workspace';
      } else {
        try {
          const stored = localStorage.getItem('lastUsedSessionMode');
          this.mode = stored === 'standalone' ? 'standalone' : 'workspace';
        } catch { /* localStorage may be unavailable */ }
      }
    }

    // Resolve default provider from user preference / local detection.
    // Edit mode keeps its original provider — do not override.
    // The spawn-input pick is the app-wide reference (no per-session default
    // provider any more); the preference/detection chain only fills the gap
    // when the user never picked anything.
    if (!this.editSession) {
      const picked = this.spawnSelection.provider();
      if (picked) {
        this.provider = picked as ProviderId;
      } else {
        try {
          const user = await firstValueFrom(this.store.select(getUser));
          this.provider = await this.providers.resolveDefaultProvider(user ?? null);
        } catch { /* keep fallback */ }
      }
    }

    // Windows: populate the terminal-shell select (cached detection, cheap).
    // The provider probe stays on demand — only the detect button triggers it.
    if (this.isWindowsDesktop) {
      void this.loadTerminalShells();
    }

    // If workspace locks team/project, apply those values
    if (this.workspaceTeamId) {
      this.teamId = this.workspaceTeamId;
    }
    if (this.workspaceProjectId) {
      this.projectId = this.workspaceProjectId;
    }

    // Auto-fill workspace from preset (active workspace context)
    if (!this.editSession && this.presetWorkspace) {
      this.workspace = { path: this.presetWorkspace.path, name: this.presetWorkspace.name };
    }

    if (this.editSession) {
      this.name = this.editSession.name;
      this.provider = this.editSession.provider as ProviderId;
      this.workspace = this.editSession.workspace ?? null;
      this.teamId = this.editSession.teamId ?? null;
      this.projectId = this.editSession.projectId ?? null;

      // Current shell of the live desktop session (Windows only) — the
      // config lives in main, not in the stored summary the caller holds.
      if (this.isWindowsDesktop) {
        try {
          const live = await this.sessionService.getSession(this.editSession.id);
          if (live?.config?.shell) this.shellId = live.config.shell;
        } catch { /* session not live — keep the default */ }
      }

      // Read the stored record (the in-memory state may be stale)
      try {
        const sessions = (await firstValueFrom(scoped$<any[]>(this.localData, this.injector, 'sessions.list'))) ?? [];
        const match = sessions.find((s: any) => s.name === this.editSession!.name);
        if (match) {
          this.teamId = match.team_id ?? null;
          this.projectId = match.project_id ?? null;
          if (match.workspace_path) {
            this.workspace = { path: match.workspace_path, name: match.workspace_name || match.workspace_path.split('/').pop() || '' };
          }

          // Check if workspace locks team/project
          if (match.workspace_id) {
            try {
              const ws = await this.localData.call<any>('workspaces.get', { id: match.workspace_id });
              if (ws) {
                if (ws.team_id) {
                  this.workspaceTeamId = ws.team_id;
                  this.workspaceTeamName = ws.team?.name ?? null;
                  this.teamId = ws.team_id;
                }
                if (ws.project_id) {
                  this.workspaceProjectId = ws.project_id;
                  this.workspaceProjectName = ws.project?.name ?? null;
                  this.projectId = ws.project_id;
                }
              }
            } catch { /* workspace fetch failed, allow editing */ }
          }
        } else {
        }
      } catch (err) {
      }
    }
  }

  onProviderChange(id: ProviderId): void {
    this.provider = id;
    // Probe results belong to the previous provider — invalidate them.
    this.shellProbe.set(null);
    // Persist as user preference (fire-and-forget: failure does not block session creation).
    this.auth.setPreferredProvider(id).subscribe({ error: () => { /* ignore */ } });
  }

  // ── Windows terminal shell (PowerShell / pwsh / cmd / Git Bash / WSL) ──

  private async loadTerminalShells(): Promise<void> {
    try {
      const res = await this.sessionService.listTerminalShells();
      if (res?.ok && res.shells?.length) {
        this.terminalShells.set(res.shells);
        // A persisted WSL distro may have been uninstalled meanwhile.
        if (this.shellId && !res.shells.some((s) => s.id === this.shellId)) {
          this.shellId = CreateSessionModalComponent.defaultShellId();
        }
        // Preferred default from Settings not detected on this machine → PowerShell
        // (already handled above since shellId starts from the pref).
      }
    } catch { /* select stays hidden (empty list) */ }
  }

  /** Detect button: probe on demand in which shells the provider CLI exists. */
  async detectProviderShells(): Promise<void> {
    if (this.probingShells()) return;
    this.probingShells.set(true);
    this.shellProbe.set(null);
    try {
      const res = await this.sessionService.probeProviderInShells(this.provider);
      if (res?.ok) {
        const results: Record<string, boolean> = {};
        for (const r of res.results ?? []) results[r.shellId] = r.installed;
        this.shellProbe.set({ command: res.command, results });
      }
    } catch { /* probe is best-effort */ } finally {
      this.probingShells.set(false);
    }
  }

  /** null = not probed yet; true/false = probe outcome for that shell. */
  shellInstalled(shellId: string): boolean | null {
    const probe = this.shellProbe();
    if (!probe || probe.command === null) return null;
    return probe.results[shellId] ?? null;
  }

  /** Decoration for the <option> labels after a probe ("… — claude ✓"). */
  shellProbeSuffix(shellId: string): string {
    const probe = this.shellProbe();
    const installed = this.shellInstalled(shellId);
    if (!probe || installed === null) return '';
    return installed ? ` — ${probe.command} ✓` : ` — ${probe.command} ✗`;
  }

  /**
   * Value persisted in SessionConfig.shell (Windows desktop only).
   * Tauri: '' (Default option) → null = no override, the session follows the
   * Settings default natively at every spawn/wake.
   */
  private shellForConfig(): string | null | undefined {
    if (!this.isWindowsDesktop || !this.terminalShells().length) return undefined;
    return this.shellId || null;
  }

  /**
   * Set when the picked folder holds several projects (and is not one itself):
   * the modal then offers "import as folder" → one workspace per project.
   */
  readonly projectContainer = signal<ProjectFolderScan | null>(null);

  private async checkProjectContainer(path: string): Promise<void> {
    this.projectContainer.set(null);
    if (this.isEdit || this.presetWorkspace || !this.folderImport.supported) return;
    const scan = await this.folderImport.scan(path);
    if (this.workspace?.path !== path) return; // user picked another folder meanwhile
    this.projectContainer.set(this.folderImport.isProjectContainer(scan) ? scan : null);
  }

  importAsProjectFolder(): void {
    const scan = this.projectContainer();
    if (scan) this.modal.close({ mode: 'import-project-folder', scan });
  }

  async selectWorkspace(): Promise<void> {
    if (this.pathLocked) return;
    try {
      const result = await this.sessionService.selectWorkspace();
      if (result) {
        this.workspace = result;
        // New path — the curated-context-file question must be re-evaluated
        this.contextDecisionDone = false;
        this.contextFilePrompt.set(null);
        if (!this.name && result.name) {
          this.name = result.name;
        }
        void this.checkProjectContainer(result.path);
      }
    } catch (err) {
    }
  }

  setPathMode(mode: 'browse' | 'clone' | 'new' | 'remote'): void {
    if (this.pathLocked) return;
    this.pathMode.set(mode);
    this.cloneError.set(null);
    this.newFolderError.set(null);
    this.remoteError.set(null);
    if (mode === 'remote' && this.remoteType() === 'ssh') void this.loadRemoteConnections();
  }

  // ── Remote Folder mode — beta (command PREFERRED, ssh secondary) ─────

  /** The Remote Folder path mode is always offered in the Tauri desktop. */
  get remoteAvailable(): boolean {
    return this.sessionService.isTauri;
  }

  /** Clickable examples for the connect command (documentation IPs). */
  readonly remoteCommandExamples: Array<{ label: string; labelKey?: string; cmd: string }> = [
    { label: 'ssh', cmd: 'ssh ubuntu@203.0.113.10' },
    { label: 'ssh + key', labelKey: 'SESSIONS.REMOTE.Example ssh key', cmd: 'ssh -i ~/.ssh/mykey.pem ec2-user@203.0.113.10' },
    { label: 'AWS SSM', cmd: 'aws ssm start-session --target i-0123456789abcdef0' },
  ];

  setRemoteType(t: 'command' | 'ssh'): void {
    this.remoteType.set(t);
    this.remoteError.set(null);
    this.remoteEntries.set([]);
    this.remoteBrowserPath.set('');
    this.resetRemoteProbe();
    if (t === 'ssh') void this.loadRemoteConnections();
  }

  fillRemoteExample(cmd: string): void {
    this.onRemoteCommandChange(cmd);
  }

  /** A changed command invalidates the check: we restart from step 1. */
  onRemoteCommandChange(cmd: string): void {
    if (cmd === this.remoteCommand()) return;
    this.remoteCommand.set(cmd);
    this.remoteError.set(null);
    this.resetRemoteProbe();
  }

  private resetRemoteProbe(): void {
    this.remoteProbe.set(null);
    this.remoteSkipProbe.set(false);
    this.remoteEntries.set([]);
    this.remoteTermLines.set([]);
    this.remoteFolderMode.set('browse');
  }

  /** Step 1 passed: connection verified, or check skipped (hand-typed path). */
  get remoteConnected(): boolean {
    return !!this.remoteProbe()?.ok || this.remoteSkipProbe();
  }

  /** OS/arch label for the connection card (e.g. "Ubuntu 24.04 · x86_64"). */
  get remotePlatformLabel(): string {
    const p = this.remoteProbe();
    if (!p?.ok) return '';
    return [p.distro || p.os, p.arch].filter(Boolean).join(' · ');
  }

  /** CLI binary name of the chosen provider, for the check on the remote host. */
  private get providerCliName(): string {
    const map: Record<string, string> = {
      'claude-code-cli': 'claude',
      'codex': 'codex',
      'gemini-cli': 'gemini',
      'antigravity': 'agy',
      'muse': 'muse',
      'cursor': 'cursor-agent',
      'promptops-cli': 'promptops-cli',
      'zai': 'claude',
      'kimi': 'claude',
    };
    return map[this.provider] ?? String(this.provider).replace(/-cli$/, '');
  }

  /** Provider CLI missing on the host: warning (doesn't block — the login PATH may differ). */
  get remoteProviderMissing(): string | null {
    const p = this.remoteProbe();
    if (!p?.ok) return null;
    const cli = this.providerCliName;
    return p.clis.includes(cli) ? null : cli;
  }

  /**
   * Step 1 — connection check + architecture detection. On OK opens the
   * browser on the remote home (step 2).
   */
  async remoteConnect(): Promise<void> {
    const isCmd = this.remoteType() === 'command';
    const cmd = this.remoteCommand().trim();
    const id = this.remoteConnId();
    if (isCmd ? !cmd : !id) {
      this.remoteError.set(this.t(isCmd ? 'SESSIONS.REMOTE.Type command first' : 'SESSIONS.REMOTE.Pick connection first'));
      return;
    }
    this.remoteProbing.set(true);
    this.remoteError.set(null);
    this.resetRemoteProbe();
    try {
      const res = await this.sessionService.remoteProbe(isCmd ? null : id, isCmd ? cmd : null);
      if (!res.ok) {
        this.remoteError.set(res.error ?? this.t('SESSIONS.REMOTE.Connection failed'));
        return;
      }
      this.remoteProbe.set(res);
      await this.commitAddedHost();
      await this.remoteBrowse(this.remoteBrowserPath().trim() || res.home);
    } catch (e: any) {
      this.remoteError.set(String(e?.message ?? e));
    } finally {
      this.remoteProbing.set(false);
    }
  }

  /** Command that can't be verified (e.g. AWS SSM): we continue with the hand-typed path. */
  remoteContinueWithoutProbe(): void {
    this.remoteError.set(null);
    this.remoteSkipProbe.set(true);
    this.remoteFolderMode.set('manual');
    void this.commitAddedHost();
  }

  setRemoteFolderMode(mode: 'browse' | 'manual' | 'terminal'): void {
    this.remoteFolderMode.set(mode);
    this.remoteError.set(null);
    // Back to the dropdown after a `cd` from the terminal/hand-typed path: refreshed list.
    if (mode === 'browse' && this.remoteProbe()?.ok) void this.remoteBrowse(this.remoteBrowserPath());
    if (mode === 'terminal') setTimeout(() => this.scrollRemoteTerm());
  }

  /** Dropdown: '..' = parent folder, otherwise enters the subfolder. */
  remotePickDir(name: string): void {
    if (!name) return;
    if (name === '..') this.remoteUp();
    else this.remoteEnter(name);
  }

  /** Mini-terminal: runs a line in the remote cwd; `cd` moves the chosen folder. */
  async remoteTermRun(): Promise<void> {
    const line = this.remoteTermInput().trim();
    if (!line || this.remoteTermBusy()) return;
    this.remoteTermInput.set('');
    if (line === 'clear') {
      this.remoteTermLines.set([]);
      return;
    }
    const isCmd = this.remoteType() === 'command';
    this.remoteTermLines.update((l) => [...l, { kind: 'cmd', text: `${this.remoteBrowserPath() || '~'} $ ${line}` }]);
    this.remoteTermBusy.set(true);
    try {
      const res = await this.sessionService.remoteShellExec(
        isCmd ? null : this.remoteConnId(),
        isCmd ? this.remoteCommand().trim() : null,
        this.remoteBrowserPath(),
        line,
      );
      if (!res.ok) {
        this.remoteTermLines.update((l) => [...l, { kind: 'err', text: res.error ?? this.t('SESSIONS.REMOTE.Command failed') }]);
      } else {
        if (res.output) this.remoteTermLines.update((l) => [...l, { kind: 'out', text: res.output }]);
        if (res.cwd) this.remoteBrowserPath.set(res.cwd);
      }
    } catch (e: any) {
      this.remoteTermLines.update((l) => [...l, { kind: 'err', text: String(e?.message ?? e) }]);
    } finally {
      this.remoteTermBusy.set(false);
      setTimeout(() => this.scrollRemoteTerm());
    }
  }

  private scrollRemoteTerm(): void {
    const el = this.remoteTermOut?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  /**
   * The connect command goes into config ONLY for command sessions
   * (cwd `cmd://…`): Rust uses it for spawn and wake (config.remoteCommand).
   */
  private remoteCommandForConfig(): string | undefined {
    return this.workspace?.path?.startsWith('cmd://')
      ? this.remoteCommand().trim() || undefined
      : undefined;
  }

  /** "Human" host extracted from the command (for labels): user@HOST or --target ID. */
  private remoteHostLabel(): string {
    return commandHostLabel(this.remoteCommand());
  }

  /** Sub-directories of the current remote listing (the picker is dir-only). */
  get remoteDirs(): Array<{ name: string; isDir: boolean }> {
    return this.remoteEntries().filter((e) => e.isDir);
  }

  /** Browser/actions visible: command mode with a typed command, or ssh connected. */
  get remoteReady(): boolean {
    return this.remoteConnected;
  }

  get isRemoteWorkspace(): boolean {
    return this.sessionService.isRemotePath(this.workspace?.path);
  }

  async loadRemoteConnections(): Promise<void> {
    try {
      const conns = await this.sessionService.listSshConnections();
      this.remoteConnections.set(conns);
      // Single saved connection → pre-select and browse its home directly.
      if (conns.length === 1 && !this.remoteConnId() && !this.addingHost()) {
        await this.pickRemoteConnection(conns[0].id);
      }
    } catch (e: any) {
      this.remoteError.set(String(e?.message ?? e ?? this.t('SESSIONS.REMOTE.Load connections failed')));
    }
  }

  async pickRemoteConnection(id: string | null): Promise<void> {
    this.remoteConnId.set(id);
    this.remoteError.set(null);
    this.remoteEntries.set([]);
    this.remoteBrowserPath.set('');
    this.resetRemoteProbe();
    if (!id) return;
    // Connection chosen = automatic step 1 (check + architecture).
    await this.remoteConnect();
    // A saved connection is already a configured machine, even if it is not answering right now.
    await this.commitAddedHost();
  }

  /**
   * Remote listing — routed over the active transport. In command mode the
   * listing travels THROUGH the command (`ssh host '<script>'`): if the
   * command doesn't support a remote argument (e.g. `aws ssm start-session`)
   * the error stays inline and the path is typed by hand in the editable field.
   */
  async remoteBrowse(path: string): Promise<void> {
    this.remoteLoading.set(true);
    this.remoteError.set(null);
    try {
      let res: { ok: boolean; path: string; entries: Array<{ name: string; isDir: boolean }>; error?: string };
      if (this.remoteType() === 'command') {
        const cmd = this.remoteCommand().trim();
        if (!cmd) {
          this.remoteError.set(this.t('SESSIONS.REMOTE.Type command first'));
          return;
        }
        res = await this.sessionService.remoteCmdListDir(cmd, path.trim() || undefined);
      } else {
        const id = this.remoteConnId();
        if (!id) return;
        res = await this.sessionService.remoteListDir(id, path);
      }
      if (!res.ok) {
        this.remoteError.set(res.error ?? this.t('SESSIONS.REMOTE.Listing failed'));
        return;
      }
      this.remoteBrowserPath.set(res.path);
      this.remoteEntries.set(res.entries);
    } catch (e: any) {
      this.remoteError.set(String(e?.message ?? e));
    } finally {
      this.remoteLoading.set(false);
    }
  }

  remoteEnter(name: string): void {
    const base = this.remoteBrowserPath();
    if (!base) return;
    void this.remoteBrowse((base.endsWith('/') ? base : base + '/') + name);
  }

  remoteUp(): void {
    const base = this.remoteBrowserPath();
    if (base && base !== '/') void this.remoteBrowse(base + '/..');
  }

  async remoteMkdir(): Promise<void> {
    const name = this.remoteNewFolderName().trim();
    if (!name || !this.remoteBrowserPath()) return;
    this.remoteLoading.set(true);
    this.remoteError.set(null);
    try {
      let res: { ok: boolean; path?: string; error?: string };
      if (this.remoteType() === 'command') {
        const cmd = this.remoteCommand().trim();
        if (!cmd) return;
        res = await this.sessionService.remoteCmdCreateFolder(cmd, this.remoteBrowserPath(), name);
      } else {
        const id = this.remoteConnId();
        if (!id) return;
        res = await this.sessionService.remoteCreateFolder(id, this.remoteBrowserPath(), name);
      }
      if (!res.ok || !res.path) {
        this.remoteError.set(res.error ?? this.t('SESSIONS.REMOTE.Folder creation failed'));
        return;
      }
      this.remoteNewFolderName.set('');
      await this.remoteBrowse(res.path);
    } catch (e: any) {
      // Called from a template click: a rejected bridge call must surface
      // inline instead of becoming an unhandled rejection.
      this.remoteError.set(String(e?.message ?? e ?? this.t('SESSIONS.REMOTE.Folder creation failed')));
    } finally {
      this.remoteLoading.set(false);
    }
  }

  /**
   * Picks the current remote folder as the session cwd. Command mode: the
   * path can also be typed by hand (empty = remote home) — cwd `cmd://<path>`
   * + the connect command travels in config.remoteCommand at submit.
   */
  remoteSelectCurrent(): void {
    if (this.remoteType() === 'command') {
      const cmd = this.remoteCommand().trim();
      if (!cmd) {
        this.remoteError.set(this.t('SESSIONS.REMOTE.Type command first'));
        return;
      }
      const path = this.remoteBrowserPath().trim();
      const host = this.remoteHostLabel();
      const base = path.split('/').filter(Boolean).pop() ?? '';
      const label = base ? `${base} @ ${host}` : host;
      this.workspace = { path: `cmd://${path}`, name: label };
      this.contextDecisionDone = false;
      this.contextFilePrompt.set(null);
      if (!this.name) this.name = label;
      // A command that reached the folder step is a configured machine.
      if (this.hosts.supported) this.hosts.rememberCommand(cmd);
      return;
    }
    const id = this.remoteConnId();
    const path = this.remoteBrowserPath();
    if (!id || !path) return;
    const conn = this.remoteConnections().find((c) => c.id === id);
    const base = path.split('/').filter(Boolean).pop() ?? path;
    const label = conn ? `${base} @ ${conn.host}` : base;
    this.workspace = { path: `ssh://${id}${path}`, name: label };
    this.contextDecisionDone = false;
    this.contextFilePrompt.set(null);
    if (!this.name) this.name = label;
  }

  toggleRemoteNewConn(): void {
    this.remoteNewConn.set(!this.remoteNewConn());
    this.remoteError.set(null);
  }

  get canSaveRemoteConnection(): boolean {
    const f = this.remoteConnForm;
    return !!(f.name.trim() && f.host.trim() && f.username.trim() && f.secret) && !this.remoteSavingConn();
  }

  async saveRemoteConnection(): Promise<void> {
    if (!this.canSaveRemoteConnection) return;
    const f = this.remoteConnForm;
    this.remoteSavingConn.set(true);
    this.remoteError.set(null);
    try {
      const saved = await this.sessionService.saveSshConnection({
        sessionId: null,
        name: f.name.trim(),
        host: f.host.trim(),
        port: Number(f.port) || 22,
        username: f.username.trim(),
        authType: f.authType,
        secret: f.secret,
        passphrase: f.passphrase || undefined,
      });
      // The bridge returns the redacted record directly; a { ok, connection }
      // wrapper is tolerated too.
      const savedId: string | null = saved?.id ?? saved?.connection?.id ?? null;
      this.remoteNewConn.set(false);
      this.remoteConnForm = { name: '', host: '', port: 22, username: '', authType: 'password', secret: '', passphrase: '' };
      await this.loadRemoteConnections();
      if (savedId) await this.pickRemoteConnection(savedId);
    } catch (e: any) {
      this.remoteError.set(String(e?.message ?? e));
    } finally {
      this.remoteSavingConn.set(false);
    }
  }

  async selectNewFolderParent(): Promise<void> {
    try {
      const result = await this.sessionService.selectWorkspace();
      if (result) {
        this.newFolderParent.set(result.path);
        this.newFolderError.set(null);
      }
    } catch {
      this.newFolderError.set(this.t('SESSIONS.DEVICE_WORKSPACE.Select destination failed'));
    }
  }

  get newFolderPreview(): string {
    const parent = this.newFolderParent();
    const name = this.newFolderName().trim();
    if (!parent) return '';
    return parent + (parent.endsWith('/') || parent.endsWith('\\') ? '' : '/') + name;
  }

  get canCreateFolder(): boolean {
    return !!this.newFolderParent() && !!this.newFolderName().trim();
  }

  /**
   * Creates `<parent>/<name>` on disk and picks it as the session workspace, so
   * the session is created inside the folder the user just made.
   */
  async createFolderAndSelect(): Promise<void> {
    const parent = this.newFolderParent();
    const name = this.newFolderName().trim();
    if (!parent || !name) return;

    this.creatingFolder.set(true);
    this.newFolderError.set(null);

    try {
      const result = await this.sessionService.createWorkspaceFolder(parent, name);
      if (!result?.ok || !result.workspace) {
        this.newFolderError.set(result?.error || this.t('SESSIONS.DEVICE_WORKSPACE.Create folder failed'));
        return;
      }

      this.workspace = result.workspace;
      // New path — the curated-context-file question must be re-evaluated
      this.contextDecisionDone = false;
      this.contextFilePrompt.set(null);
      if (!this.name) {
        this.name = result.workspace.name;
      }
      this.pathMode.set('browse');
      this.newFolderParent.set(null);
      this.newFolderName.set('');
    } catch (err: any) {
      this.newFolderError.set(err?.message || this.t('SESSIONS.DEVICE_WORKSPACE.Create folder failed'));
    } finally {
      this.creatingFolder.set(false);
    }
  }

  async selectCloneDestination(): Promise<void> {
    try {
      const result = await this.sessionService.selectWorkspace();
      if (result) {
        this.cloneDestination.set(result.path);
        this.cloneError.set(null);
      }
    } catch {
      this.cloneError.set(this.t('SESSIONS.DEVICE_WORKSPACE.Select destination failed'));
    }
  }

  async cloneAndSelect(): Promise<void> {
    const rawUrl = this.cloneUrl().trim();
    const dest = this.cloneDestination();
    if (!rawUrl || !dest) return;

    const cloneUrl = this.normalizeGitUrl(rawUrl);
    const repoName = this.extractRepoName(cloneUrl);
    const fullDest = dest + (dest.endsWith('/') ? '' : '/') + repoName;

    this.cloning.set(true);
    this.cloneError.set(null);

    try {
      const branch = this.cloneBranch().trim() || undefined;
      const result = await this.sessionService.gitClone(cloneUrl, fullDest, branch);

      if (!result.ok) {
        this.cloneError.set(result.error || this.t('SESSIONS.DEVICE_WORKSPACE.Clone failed'));
        this.cloning.set(false);
        return;
      }

      const clonedPath = result.path || fullDest;
      this.workspace = { path: clonedPath, name: repoName };
      if (!this.name) {
        this.name = repoName;
      }
      this.pathMode.set('browse');
      this.cloning.set(false);
    } catch (err: any) {
      this.cloning.set(false);
      this.cloneError.set(err?.message || this.t('SESSIONS.DEVICE_WORKSPACE.Clone failed'));
    }
  }

  get canClone(): boolean {
    return !!this.cloneUrl().trim() && !!this.cloneDestination() && !this.cloning();
  }

  private normalizeGitUrl(url: string): string {
    // AWS CodeCommit console URL → HTTPS clone URL
    const ccMatch = url.match(
      /console\.aws\.amazon\.com\/codesuite\/codecommit\/repositories\/([^/?#]+)/,
    );
    if (ccMatch) {
      const regionMatch = url.match(/region=([\w-]+)/) || url.match(/^https:\/\/([\w-]+)\.console/);
      const region = regionMatch?.[1] || 'us-east-1';
      return `https://git-codecommit.${region}.amazonaws.com/v1/repos/${ccMatch[1]}`;
    }

    // GitHub browser URL → clone URL (https://github.com/user/repo/tree/... → https://github.com/user/repo.git)
    const ghMatch = url.match(/github\.com\/([^/?#]+\/[^/?#]+?)(?:\/(?:tree|blob|commit|pull|issues).*)?$/);
    if (ghMatch) {
      const repo = ghMatch[1].replace(/\.git$/, '');
      return `https://github.com/${repo}.git`;
    }

    // GitLab browser URL → clone URL
    const glMatch = url.match(/gitlab\.com\/([^/?#]+(?:\/[^/?#]+)+?)(?:\/-\/.*)?$/);
    if (glMatch) {
      const repo = glMatch[1].replace(/\.git$/, '');
      return `https://gitlab.com/${repo}.git`;
    }

    // Bitbucket browser URL → clone URL
    const bbMatch = url.match(/bitbucket\.org\/([^/?#]+\/[^/?#]+?)(?:\/(?:src|commits|pull-requests).*)?$/);
    if (bbMatch) {
      const repo = bbMatch[1].replace(/\.git$/, '');
      return `https://bitbucket.org/${repo}.git`;
    }

    // Strip query params from URLs that look like git URLs (safety net)
    if (url.includes('?') && !url.includes('.git')) {
      return url.split('?')[0];
    }

    return url;
  }

  private extractRepoName(url: string): string {
    const cleaned = url.replace(/\.git\s*$/, '').replace(/\/+$/, '');
    const parts = cleaned.split('/');
    return parts[parts.length - 1] || 'repo';
  }

  /**
   * Whether the submit button should be disabled given the current bivio mode.
   * Used by the template when workspaceFirstUI is on.
   *
   * Under workspaceFirstUI the path is **always required**: any session —
   * standalone or workspace, create or edit — must have a project folder
   * picked. Legacy clients (workspaceFirstUI off) keep the pre-rollout
   * behavior where the path is optional.
   */
  get submitDisabled(): boolean {
    if (this.saving()) return true;
    if (this.workspaceFirstUI && !this.workspace?.path) {
      return true;
    }
    return false;
  }

  /**
   * True when the modal is editing a session that is still standalone (no
   * workspace_id) and the workspace-first UI is enabled. Used by the template
   * to render the "Promote to Workspace" section in edit mode.
   */
  get canPromoteOnEdit(): boolean {
    return (
      this.workspaceFirstUI &&
      this.isEdit &&
      !!this.editSession &&
      !this.editSession.workspaceId
    );
  }

  /**
   * True when editing a session that is already bound to a workspace. The
   * project folder of a workspace is owned by the workspace itself and shared
   * by every session bound to it, so it must not be re-pointed from the
   * session editor. The template locks the path picker (no toggle, no folder
   * browse, no clone) and the picker methods below no-op as a second guard.
   */
  get pathLocked(): boolean {
    return this.isEdit && !!this.editSession?.workspaceId;
  }

  /**
   * Returns the type label to show in the badge next to the path:
   *   - 'workspace' when the session is (or will be) bound to a workspace
   *   - 'standalone' otherwise
   * Handles every scenario: create with toggle on/off, edit of bound vs
   * standalone, edit + promote toggle.
   */
  sessionTypeBadge(): 'workspace' | 'standalone' {
    if (this.isEdit) {
      if (this.editSession?.workspaceId) return 'workspace';
      // Standalone session being edited: promoted at save if toggle is on.
      return this.promoteToWorkspaceOnEdit ? 'workspace' : 'standalone';
    }
    // New session: presetWorkspace / forceMode='workspace' mean a workspace
    // context is enforced; otherwise rely on the user-controlled `mode`.
    if (this.presetWorkspace || this.forceMode === 'workspace') return 'workspace';
    if (this.forceMode === 'standalone') return 'standalone';
    return this.mode === 'workspace' ? 'workspace' : 'standalone';
  }

  /**
   * Auto-approve toggle visibility. Hidden entirely in the minimal UI —
   * auto-approve is managed post-creation there (action center / sidebar /
   * intent modal). Classic keeps the pre-rollout rule: hidden only while
   * creating a brand new workspace under the workspace-first UI. Submit
   * paths gate on this too, so a stale `autoApprove` value can never leak
   * into the session config while the toggle is invisible.
   */
  private builtins = inject(BuiltinPluginsService);

  autoApproveVisible(): boolean {
    // Auto Approve is a built-in plugin: turned off from the Plugins page, it disappears here too.
    if (!this.builtins.isOn('auto-approve')) return false;
    if (this.uiStyle.style() === 'minimal') return false;
    return !this.workspaceFirstUI || !!this.presetWorkspace || this.sessionTypeBadge() !== 'workspace';
  }

  /**
   * Persist the last used mode so the next open defaults to it.
   * Wrapped in try/catch — localStorage may be unavailable (private mode, etc.).
   */
  private persistMode(): void {
    if (!this.workspaceFirstUI) return;
    try {
      localStorage.setItem('lastUsedSessionMode', this.mode);
    } catch { /* ignore */ }
  }

  /**
   * User answered the curated-context-file question. Persist the choice on
   * the workspace, then resume the halted submit.
   *  - 'allow'    → PromptOps updates the file(s) with its managed context
   *  - 'preserve' → PromptOps never touches them
   */
  async resolveContextFileDecision(mode: 'allow' | 'preserve'): Promise<void> {
    const files = this.contextFilePrompt() ?? [];
    this.contextFilePrompt.set(null);
    this.contextDecisionDone = true;
    if (this.workspace?.path) {
      try {
        await this.sessionService.setWorkspaceContextPolicy(this.workspace.path, mode, files);
      } catch { /* best effort */ }
    }
    await this.submit();
  }

  async submit(): Promise<void> {
    // Workspace-first guard: when on, enforce the bivio rules locally before
    // emitting the close payload. Local store rules also enforce these — UI is a
    // courtesy layer.
    if (this.workspaceFirstUI && this.mode === 'workspace' && !this.workspace?.path) {
      return;
    }
    this.persistMode();

    // Guard curated context files: when the picked folder already has a
    // CLAUDE.md (or the provider's own context file, e.g. AGENTS.md/GEMINI.md)
    // curated by the user, ask before letting PromptOps touch it. The answer
    // is persisted in the workspace (.promptops/context-policy.json) so it is
    // asked only once per path.
    const creatingWorkspace = !this.isEdit || (this.canPromoteOnEdit && this.promoteToWorkspaceOnEdit);
    if (creatingWorkspace && this.workspace?.path && !this.contextDecisionDone) {
      try {
        const check = await this.sessionService.checkWorkspaceContextFile(this.workspace.path, this.provider);
        if (check.ok && check.needsDecision && check.curatedFiles?.length) {
          this.contextFilePrompt.set(check.curatedFiles);
          return; // wait for the user's choice — resolveContextFileDecision() resumes submit
        }
      } catch { /* best effort — never block creation on the check */ }
      this.contextDecisionDone = true;
    }

    // Dedicated "New Workspace" flow: create the workspace, then optionally
    // spawn an initial session inside it based on the `createInitialSession`
    // toggle. The caller receives one of two close payloads:
    //   - mode: 'create-workspace-only' → just refresh the workspaces list
    //   - mode: 'create-workspace-and-session' → dispatch createSession too
    if (this.skipSessionCreation && this.workspaceFirstUI && this.mode === 'workspace' && this.workspace?.path) {
      this.saving.set(true);
      try {
        const workspace = (await firstValueFrom(
          scoped$<any>(this.localData, this.injector, 'workspaces.findOrCreate', {
            project_path: this.workspace.path,
            name: this.workspace.name,
          }),
        )) ?? null;

        if (this.createInitialSession && workspace?.id) {
          const sessionName = this.name || workspace.name || this.workspace.name || 'Session';
          const categoryId = await this.historyService.createSessionCategory(sessionName);
          this.modal.close({
            mode: 'create-workspace-and-session',
            workspace,
            name: sessionName,
            provider: this.provider,
            workspaceId: workspace.id,
            config: {
              cwd: workspace.project_path ?? this.workspace.path,
              cols: this.cols,
              rows: this.rows,
              shell: this.shellForConfig(),
              autoApprove: this.autoApproveVisible() ? this.autoApprove : false,
            },
            categoryId,
            teamId: this.teamId,
            projectId: this.projectId,
          });
        } else {
          this.modal.close({
            mode: 'create-workspace-only',
            workspace,
          });
        }
      } catch (err: any) {
        // findOrCreate / category failure: keep the modal open and tell the
        // user (was an unhandled rejection with no feedback).
        this.swalService.error(err?.message || this.t('MESSAGE.Generic error'));
      } finally {
        this.saving.set(false);
      }
      return;
    }

    // Edit-mode promotion: the user toggled "Promote to Workspace" on a
    // standalone session and picked a folder. Defer to the parent so it can
    // dispatch promoteSessionToWorkspace via NgRx.
    if (this.canPromoteOnEdit && this.promoteToWorkspaceOnEdit && this.workspace?.path) {
      this.modal.close({
        mode: 'edit-promote',
        sessionId: this.editSession!.id,
        projectPath: this.workspace.path,
        workspaceName: this.workspace.name,
      });
      return;
    }

    const sessionName = this.name || this.workspace?.name || 'Session';
    this.saving.set(true);

    try {
      if (this.isEdit) {
        // Update the stored session (by name first, then by id).
        // `provider` is persisted on the DB so the *next* time the session is
        // spawned it uses the new engine. Already-running terminals and
        // sub-agents are NOT killed — they keep their original provider.
        const data: Record<string, unknown> = {
          name: sessionName,
          provider: this.provider,
          team_id: this.teamId,
          project_id: this.projectId,
        };
        if (this.workspace?.path) {
          data['workspace_path'] = this.workspace.path;
          data['workspace_name'] = this.workspace.name;
        }

        // Names are unique per user — soft-deleted rows included, they still
        // occupy the index — so renaming onto the name of a closed session
        // comes back as `session_name_taken`. That verdict used to fall
        // into the generic catch below: modal left open, no message, nothing
        // saved ("rename fails silently"). Ask whether to force instead, like
        // the tab-rename flow: the store frees the name by suffixing the
        // conflicting session, then assigns it here.
        const err = await this.persistEdit(data);
        if (err) {
          if (isSessionNameTaken(err)) {
            const conflictName = (err.details?.['conflict_name'] as string | undefined) ?? sessionName;
            this.swalService.confirm(
              this.translateService.instant('USERS_ADMIN.Session name taken'),
              this.translateService.instant('USERS_ADMIN.Force rename conflict', { name: conflictName }),
              () => { void this.submitForcedEdit({ ...data, force_rename: true }, sessionName); },
            );
            return;
          }
          this.reportEditFailure(err);
          return;
        }

        this.closeEdit(sessionName);
      } else {
        // Create new session. When the workspace-first toggle is on and a
        // folder is picked, create (or find) the workspace inline so the new
        // session is born already attached to it — no findOrCreate side-effect
        // later.
        let workspaceId: string | null = null;
        let cwd = this.workspace?.path;
        // Remote (ssh://) paths never become stored workspaces: the binding
        // is device-local (the SSH connection lives only on this machine).
        if (
          this.workspaceFirstUI &&
          this.mode === 'workspace' &&
          this.workspace?.path &&
          !this.sessionService.isRemotePath(this.workspace.path)
        ) {
          try {
            const ws = (await firstValueFrom(
              scoped$<any>(this.localData, this.injector, 'workspaces.findOrCreate', {
                project_path: this.workspace.path,
                name: this.workspace.name,
              }),
            )) ?? null;
            if (ws?.id) {
              workspaceId = ws.id;
              cwd = ws.project_path ?? cwd;
            }
          } catch {
            // Best effort: if find-or-create fails the session is created
            // standalone — same as the pre-rollout behavior.
          }
        }

        const categoryId = await this.historyService.createSessionCategory(sessionName);

        this.modal.close({
          mode: 'create',
          name: sessionName,
          provider: this.provider,
          workspaceId,
          config: {
            cwd,
            cols: this.cols,
            rows: this.rows,
            shell: this.shellForConfig(),
            autoApprove: this.autoApproveVisible() ? this.autoApprove : false,
            remoteCommand: this.remoteCommandForConfig(),
          },
          categoryId,
          teamId: this.teamId,
          projectId: this.projectId,
        });
      }
    } catch {
      // Edit failures are handled (and surfaced) inline above; only the
      // create path falls back to closing with the local payload.
      if (!this.isEdit) {
        this.modal.close({
          mode: 'create',
          name: sessionName,
          provider: this.provider,
          config: { cwd: this.workspace?.path, cols: this.cols, rows: this.rows, shell: this.shellForConfig(), autoApprove: this.autoApproveVisible() ? this.autoApprove : false, remoteCommand: this.remoteCommandForConfig() },
          categoryId: null,
          teamId: this.teamId,
        });
      }
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Saves the edit: by-name lookup first (the id the renderer holds may be
   * the local one, not the stored id), id fallback for records the name
   * lookup can't see. Resolves to the error when both attempts fail so the
   * caller can tell a name conflict from another failure — never throws.
   */
  private async persistEdit(data: Record<string, unknown>): Promise<DataError | null> {
    try {
      await this.localData.call('sessions.updateByName', { ...data, lookup_name: this.editSession!.name });
      return null;
    } catch (byNameErr) {
      // A name-conflict verdict is final: retrying by id would repeat it.
      if (isSessionNameTaken(byNameErr)) return byNameErr;
      try {
        await this.localData.call('sessions.update', { ...data, id: this.editSession!.id });
        return null;
      } catch (byIdErr) {
        return isDataError(byIdErr) ? byIdErr : { code: 'internal', message: String(byIdErr) };
      }
    }
  }

  /** Forced retry after the user accepted the name-conflict prompt. */
  private async submitForcedEdit(data: Record<string, unknown>, sessionName: string): Promise<void> {
    this.saving.set(true);
    try {
      const err = await this.persistEdit(data);
      if (err) {
        this.reportEditFailure(err);
        return;
      }
      this.closeEdit(sessionName);
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Surface a failed edit instead of leaving the modal silently open; a
   * still-taken name after a forced attempt (rare race) gets the dedicated
   * message.
   */
  private reportEditFailure(err: DataError): void {
    const message = err.code === 'session_name_taken'
      ? this.translateService.instant('USERS_ADMIN.Session name taken')
      : err.message;
    this.swalService.error(message);
  }

  private closeEdit(sessionName: string): void {
    this.modal.close({
      mode: 'edit',
      name: sessionName,
      provider: this.provider,
      teamId: this.teamId,
      projectId: this.projectId,
      workspace: this.workspace,
      // Windows shell: the caller pushes it to the live desktop session
      // via updateSessionMeta (applied at the next spawn/wake).
      shell: this.shellForConfig(),
    });
  }
}
