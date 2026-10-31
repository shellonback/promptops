import { OrgPolicyService } from '@core/services/org-policy.service';
import { SwalService } from '@core/services/swal.service';
import { Component, CUSTOM_ELEMENTS_SCHEMA, ElementRef, HostListener, inject, input, output, signal, computed, effect, OnInit, OnDestroy, ViewChild, viewChild, untracked, ChangeDetectionStrategy } from '@angular/core';
import { VoiceAgentService } from '@/app/components/voice-agent/voice-agent.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  CdkDragDrop,
  CdkDrag,
  CdkDropList,
  CdkDragHandle,
  CdkDragPlaceholder,
  moveItemInArray,
} from '@angular/cdk/drag-drop';
import { Store } from '@ngrx/store';
import { toSignal } from '@angular/core/rxjs-interop';
import { Interaction, ProviderType } from '../../../../../store/sessions/session.state';
import { getActiveSessionId, getActiveSession } from '../../../../../store/sessions/session.selectors';
import { updateSessionSuccess } from '../../../../../store/sessions/session.actions';
import { DesktopSessionApiService } from '../services/desktop-session-api.service';
import { ProviderSwitchService } from '../services/provider-switch.service';
import { ProviderLimitService } from '../services/provider-limit.service';
import { SPAWN_PROVIDERS } from '../services/spawn-providers.const';
import { spawnModels } from '../services/model-labels';
import { effortOptions, validEffort } from '../services/reasoning-effort';
import { firstValueFrom } from 'rxjs';
import { ActionSlotService, ActionSlot } from '../services/action-slot.service';
import { InteractionService } from '../services/interaction.service';
import { EcoModeService } from '../services/eco-mode.service';
import { SessionService } from '../services/session.service';
import { SubAgent, SubAgentService, SubAgentMode, SubAgentConfig, ModePreset, MODE_PRESETS, SoftSkillPayload } from '../services/sub-agent.service';
import { SoftSkill, SoftSkillService } from '../services/soft-skill.service';
import { IntentService, EnhanceDepth } from '../services/intent.service';
import { SessionHistoryService } from '../services/session-history.service';
import { SessionAssetsService } from '../services/session-assets.service';
import { GitService } from '../services/git.service';
import { GitSettingsService } from '../services/git-settings.service';
import { GitSettingsModalComponent } from '../git-settings-modal/git-settings-modal.component';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { PromptPickerModalComponent } from '../../../../layouts/sidebar/quick-access/prompt-picker-modal/prompt-picker-modal.component';
import { SmartActionService } from '../services/smart-action.service';
import { readCommandAction } from '../services/quick-action-command';
import { QuickCreatePromptModalComponent } from '../quick-create-prompt-modal/quick-create-prompt-modal.component';
import { ResumeSubAgentModalComponent } from '../resume-subagent-modal/resume-subagent-modal.component';
import { InjectAgentModalComponent } from '../inject-agent-modal/inject-agent-modal.component';
import { SoftSkillModalComponent, SoftSkillModalResult } from '../soft-skill-modal/soft-skill-modal.component';
import { ExtensionSelectionPayload } from '../services/agent-inject.service';
import { TooltipDirective } from '../../../../common/tooltip.directive';
import { MentionAutocompleteComponent } from '../../../../components/mention-autocomplete/mention-autocomplete.component';
import { CommandAutocompleteComponent } from '../../../../components/command-autocomplete/command-autocomplete.component';
import { getActiveWorkspace } from '../../../../../store/workspaces/workspace.selectors';
import { ProviderAccountSwitcherComponent } from '../../provider-accounts/switcher/provider-account-switcher.component';
import { ProviderAccountsService } from '../../provider-accounts/services/provider-accounts.service';
import { FeatureFlagService } from '@core/services/feature-flag.service';
import { getProviderUsage, getProviderUsageError } from '../../../../../store/token-efficiency/token-efficiency.selectors';
import { probeProviderUsage, clearProviderUsageProbeError } from '../../../../../store/token-efficiency/token-efficiency.actions';
import { getLatestProviderUsageForProvider } from '../../../../../store/token-efficiency/token-efficiency.selectors';
import { ActivityMetrics, ProviderUsageSnapshot, ProviderUsageProbeError } from '../../../../../store/token-efficiency/token-efficiency.state';

import { SpawnSelectionService } from '../services/spawn-selection.service';
import { PluginRuntimeService } from '../../plugins/plugin-runtime.service';
import { BuiltinPluginsService } from '../../plugins/builtin-plugins.service';
import { PluginSessionButtonsComponent } from '../../plugins/plugin-session-buttons.component';
/** An IME is turning keystrokes into text: Enter belongs to it (keyCode 229 covers older WebKit). */
export function isImeComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** Providers the composer chip can spawn with. */
type SpawnProviderId = 'claude-code-cli' | 'codex' | 'gemini-cli' | 'antigravity' | 'copilot' | 'cursor' | 'grok' | 'hermes' | 'muse' | 'zai' | 'kimi' | 'opencode' | 'kora' | 'promptops-cli' | 'generic-shell';

@Component({
  selector: 'app-action-center',
  standalone: true,
  imports: [
    TranslateModule,
    PluginSessionButtonsComponent,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    CdkDragPlaceholder,
    PromptPickerModalComponent,
    TooltipDirective,
    MentionAutocompleteComponent,
    CommandAutocompleteComponent,
    GitSettingsModalComponent,
    ProviderAccountSwitcherComponent,
  ],
  templateUrl: './action-center.component.html',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .action-center {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--po-bg-2);
      border-left: 1px solid var(--po-border-subtle);
      width: 320px;
      transition: width 0.2s;
      container-type: inline-size;
      container-name: action-center;
    }
    .action-center.composer-only { width: 100%; height: auto; border-left: 0; }
    .action-center.collapsed {
      width: 40px;
    }

    .action-center-scroll {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      min-height: 0;
    }

    .action-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 0.75rem;
      border-bottom: 1px solid var(--po-border-subtle);
      cursor: pointer;
    }
    .action-center.collapsed .action-header {
      padding: 0.75rem 0.5rem;
      justify-content: center;
    }
    .action-center.collapsed .action-title {
      display: none;
    }

    .action-title {
      margin: 0;
      font-weight: 600;
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--po-text-secondary);
      display: flex;
      align-items: center;
      gap: 0.375rem;
    }

    .collapse-icon {
      color: var(--po-text-secondary);
    }

    .action-list {
      flex: 1;
      overflow-y: auto;
      padding: 0.5rem;
    }

    .action-card {
      background: var(--po-bg-0);
      border: 1px solid var(--po-border-subtle);
      border-radius: 8px;
      padding: 0.75rem;
      margin-bottom: 0.5rem;
    }

    .action-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 4px;
      margin-bottom: 0.5rem;
    }
    .action-badge.input {
      background: rgba(88, 166, 255, 0.15);
      color: var(--po-info);
    }
    .action-badge.action {
      background: var(--po-warning-bg);
      color: var(--po-warning);
    }

    .action-prompt {
      font-size: 0.85rem;
      margin-bottom: 0.5rem;
      line-height: 1.4;
    }

    .action-context {
      font-size: 0.72rem;
      font-family: monospace;
      background: rgba(0, 0, 0, 0.25);
      border-left: 2px solid var(--po-border-subtle);
      padding: 4px 8px;
      border-radius: 4px;
      margin-bottom: 0.5rem;
      max-height: 80px;
      overflow-y: auto;
      color: var(--po-text-secondary);
      line-height: 1.3;
    }

    .action-detail {
      display: block;
      font-size: 0.75rem;
      background: rgba(0, 0, 0, 0.3);
      padding: 4px 8px;
      border-radius: 4px;
      margin-bottom: 0.5rem;
      word-break: break-all;
    }

    .action-buttons {
      display: flex;
      gap: 0.375rem;
    }

    .action-input-row {
      display: flex;
      gap: 0.375rem;
    }
    .action-input-row input {
      flex: 1;
    }

    .empty-actions {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }

    /* ── Bottom Accordions (matches assets/git panel style) ── */
    .bottom-accordions {
      display: flex;
      flex-direction: column;
    }

    .accordion-panel {
      border-top: 2px solid rgba(188, 140, 255, 0.3);
      background: var(--po-bg-2);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      flex-shrink: 0;
    }
    .accordion-panel.acc-collapsed {
      height: 36px !important;
    }
    .acc-panel-actions {
      border-top-color: rgba(210, 153, 34, 0.3) !important;
    }
    .acc-panel-usage {
      border-top-color: rgba(88, 166, 255, 0.3) !important;
    }
    .acc-panel-usage .acc-header {
      background: rgba(88, 166, 255, 0.06);
    }
    .acc-panel-usage .acc-header:hover {
      background: rgba(88, 166, 255, 0.12);
    }
    .acc-panel-usage .acc-title {
      color: #58a6ff;
    }

    .acc-resize-handle {
      height: 4px;
      cursor: row-resize;
      background: transparent;
      flex-shrink: 0;
      position: relative;
      z-index: 5;
      transition: background 0.15s;
    }
    .acc-resize-handle:hover,
    .acc-resize-handle:active {
      background: rgba(188, 140, 255, 0.4);
    }
    .acc-panel-actions .acc-resize-handle:hover,
    .acc-panel-actions .acc-resize-handle:active {
      background: rgba(210, 153, 34, 0.4);
    }

    .acc-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.35rem 0.75rem;
      min-height: 34px;
      box-sizing: border-box;
      background: rgba(188, 140, 255, 0.06);
      cursor: pointer;
      user-select: none;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    .acc-header:hover {
      background: rgba(188, 140, 255, 0.12);
    }
    .acc-panel-actions .acc-header {
      background: rgba(210, 153, 34, 0.06);
    }
    .acc-panel-actions .acc-header:hover {
      background: rgba(210, 153, 34, 0.12);
    }

    .acc-title {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #bc8cff;
      margin: 0;
    }
    .acc-panel-actions .acc-title {
      color: var(--po-warning);
    }

    .acc-header-right {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .acc-chevron {
      color: var(--po-text-secondary);
      opacity: 0.6;
      transition: opacity 0.15s;
    }
    .acc-header:hover .acc-chevron {
      opacity: 1;
    }

    .acc-body {
      flex: 1;
      min-height: 0;
      padding: 0.5rem;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      overflow-y: auto;
      animation: accReveal 0.25s ease-out;
    }

    @keyframes accReveal {
      from {
        opacity: 0;
        transform: translateY(8px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    /* Quick Agent items */
    .acc-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.35rem 0.5rem;
      border: 1px solid var(--po-border-subtle);
      border-radius: 8px;
      background: var(--po-bg-0);
      cursor: pointer;
      transition: all 0.15s;
      width: 100%;
      text-align: left;
    }
    .acc-item:hover:not(:disabled) {
      border-color: rgba(88, 166, 255, 0.3);
    }
    .acc-item:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .acc-item.spawning {
      border-color: var(--bs-success);
      animation: quickPulse 0.6s ease;
    }

    .acc-item-icon {
      flex-shrink: 0;
      width: 26px;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      background: rgba(88, 166, 255, 0.1);
    }

    .acc-item-label {
      flex: 1;
      font-size: 0.8rem;
      font-weight: 500;
      color: var(--po-text-primary);
    }

    .acc-item-run {
      color: var(--po-text-secondary);
      opacity: 0;
      transition: opacity 0.15s;
    }
    .acc-item:hover .acc-item-run {
      opacity: 1;
      color: var(--po-success);
    }

    @keyframes quickPulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.03); border-color: var(--po-success); }
      100% { transform: scale(1); }
    }

    .slots-count-badge {
      background: rgba(139, 148, 158, 0.2);
      color: var(--po-text-secondary);
      font-size: 0.65rem;
      font-weight: 700;
      min-width: 16px;
      height: 16px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 4px;
    }
    .slots-count-badge.bg-danger {
      background: var(--po-error-bg, rgba(248, 81, 73, 0.15));
      color: var(--po-error, #f85149);
    }

    /* ── Usage accordion body ── */
    .usage-body {
      padding: 0.5rem 0.65rem !important;
      gap: 0.5rem !important;
    }

    .usage-badge {
      font-size: 0.6rem;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 4px;
      background: rgba(63, 185, 80, 0.15);
      color: #3fb950;
      line-height: 1.4;
    }
    .usage-badge-warn {
      background: rgba(210, 153, 34, 0.15);
      color: #d29922;
    }
    .usage-badge-crit {
      background: rgba(248, 81, 73, 0.15);
      color: #f85149;
      animation: badge-pulse 2s ease-in-out infinite;
    }
    .usage-badge-loading {
      background: rgba(88, 166, 255, 0.1);
      color: #58a6ff;
      display: inline-flex;
      align-items: center;
      padding: 2px 6px;
    }

    @keyframes badge-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.55; }
    }

    .spin-slow {
      animation: spin-slow 1.5s linear infinite;
    }
    @keyframes spin-slow {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .usage-section {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }

    .usage-section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .usage-section-label {
      font-size: 0.68rem;
      color: var(--po-text-secondary);
      font-weight: 500;
    }

    .usage-section-pct {
      font-size: 0.68rem;
      font-weight: 700;
      color: #3fb950;
    }
    .usage-section-pct.warn { color: #d29922; }
    .usage-section-pct.crit { color: #f85149; }

    .usage-bar-track {
      width: 100%;
      height: 5px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.06);
      overflow: hidden;
    }

    .usage-bar-fill {
      height: 100%;
      border-radius: 3px;
      background: linear-gradient(90deg, #238636, #3fb950);
      transition: width 0.4s ease;
    }
    .usage-fill-warn {
      background: linear-gradient(90deg, #9e6a03, #d29922);
    }
    .usage-fill-crit {
      background: linear-gradient(90deg, #da3633, #f85149);
    }

    .usage-resets {
      font-size: 0.58rem;
      color: var(--po-text-tertiary);
      opacity: 0.7;
    }

    /* ── Manual refresh button in the accordion header ── */
    .usage-refresh-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 3px;
      margin-right: 4px;
      background: transparent;
      border: 0;
      border-radius: 4px;
      color: var(--po-text-secondary);
      opacity: 0.55;
      cursor: pointer;
      transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
    }
    .usage-refresh-btn:hover:not(:disabled) {
      opacity: 1;
      color: var(--po-text-primary);
      background: rgba(255, 255, 255, 0.06);
    }
    .usage-refresh-btn:active:not(:disabled) {
      background: rgba(255, 255, 255, 0.1);
    }
    .usage-refresh-btn:disabled {
      cursor: default;
      opacity: 0.4;
    }
    .usage-refresh-cd {
      font-size: 0.55rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      line-height: 1;
      letter-spacing: -0.02em;
    }

    /* ── Activity metrics (Gemini /stats) ── */
    .activity-metrics {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .activity-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.5rem;
      font-size: 0.68rem;
      line-height: 1.35;
      padding: 0.15rem 0;
      border-bottom: 1px dashed rgba(255, 255, 255, 0.04);
    }
    .activity-row:last-child {
      border-bottom: none;
    }
    .activity-label {
      color: var(--po-text-secondary);
      font-weight: 500;
      white-space: nowrap;
    }
    .activity-value {
      color: var(--po-text-primary);
      font-weight: 600;
      text-align: right;
      overflow: hidden;
      text-overflow: ellipsis;
      word-break: break-word;
    }
    .activity-sub {
      font-weight: 500;
      font-size: 0.6rem;
      color: var(--po-text-tertiary);
      margin-left: 0.25rem;
    }
    .activity-sub .ok { color: #3fb950; }
    .activity-sub .err { color: #f85149; }

    .usage-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 0.35rem;
      border-top: 1px solid rgba(255, 255, 255, 0.04);
    }

    .usage-model {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      font-size: 0.62rem;
      font-weight: 600;
      color: var(--po-text-tertiary);
    }

    .usage-extra-off {
      display: flex;
      align-items: center;
      gap: 0.2rem;
      font-size: 0.6rem;
      font-weight: 600;
      color: #d29922;
    }

    /* ── Usage loading skeleton ── */
    .usage-loading-body {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }

    .usage-section-skeleton {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .skel-label {
      width: 55%;
      height: 8px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.04);
      animation: skel-shimmer 1.8s ease-in-out infinite;
    }
    .skel-label.short {
      width: 40%;
    }

    .skel-bar-pulse {
      width: 30%;
      height: 100%;
      border-radius: 3px;
      background: rgba(88, 166, 255, 0.12);
      animation: skel-bar-grow 2s ease-in-out infinite;
    }
    .skel-bar-pulse.delay {
      animation-delay: 0.4s;
    }

    @keyframes skel-shimmer {
      0%, 100% { opacity: 0.5; }
      50% { opacity: 1; }
    }
    @keyframes skel-bar-grow {
      0%, 100% { width: 20%; opacity: 0.5; }
      50% { width: 45%; opacity: 1; }
    }

    .usage-loading-hint {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.6rem;
      color: var(--po-text-tertiary);
      opacity: 0.6;
    }

    /* ── Usage error state ── */
    .usage-error-body {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.4rem;
      padding: 0.5rem 0.25rem;
    }
    .usage-error-icon {
      color: rgb(255 176 76 / 0.9);
    }
    .usage-error-title {
      font-size: 0.7rem;
      font-weight: 600;
      color: var(--po-text-primary);
    }
    .usage-error-hint {
      font-size: 0.62rem;
      line-height: 1.35;
      color: var(--po-text-tertiary);
      opacity: 0.85;
    }
    .usage-retry-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      margin-top: 0.15rem;
      padding: 0.25rem 0.55rem;
      border: 1px solid rgba(88, 166, 255, 0.4);
      border-radius: 4px;
      background: rgba(88, 166, 255, 0.08);
      color: var(--po-text-primary);
      font-size: 0.62rem;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    .usage-retry-btn:hover {
      background: rgba(88, 166, 255, 0.16);
      border-color: rgba(88, 166, 255, 0.6);
    }
    .usage-retry-btn:active {
      transform: translateY(1px);
    }

    .slots-actions {
      display: flex;
      gap: 4px;
    }

    .slots-actions button {
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
    .slots-actions button:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--po-text-primary);
    }

    .slot-card {
      background: var(--po-bg-0);
      border: 1px solid var(--po-border-subtle);
      border-radius: 8px;
      margin-bottom: 0.375rem;
      transition: border-color 0.15s;
    }
    .slot-card:hover {
      border-color: rgba(88, 166, 255, 0.3);
    }
    .slot-card.slot-editing {
      border-color: rgba(88, 166, 255, 0.4);
      background: rgba(88, 166, 255, 0.03);
    }

    .slot-card-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0.625rem;
    }

    .slot-drag-handle {
      cursor: grab;
      color: var(--po-text-secondary);
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 28px;
      border-radius: 4px;
      transition: all 0.15s;
    }
    .slot-drag-handle:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--po-text-primary);
    }
    .slot-drag-handle:active {
      cursor: grabbing;
      background: rgba(88, 166, 255, 0.15);
      color: var(--po-info);
    }

    /* ── Pencil edit button ── */
    .slot-edit-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 28px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
      opacity: 0;
      transition: all 0.15s;
      flex-shrink: 0;
    }
    .slot-card:hover .slot-edit-btn,
    .slot-card.slot-editing .slot-edit-btn {
      opacity: 1;
    }
    .slot-edit-btn:hover {
      background: rgba(88, 166, 255, 0.15);
      color: var(--po-info);
    }
    .slot-card.slot-editing .slot-edit-btn {
      color: var(--po-success);
    }

    /* ── Inline edit panel ── */
    .slot-edit-panel {
      padding: 0 0.625rem 0.5rem;
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
      animation: editSlideDown 0.15s ease;
    }

    @keyframes editSlideDown {
      from { opacity: 0; max-height: 0; }
      to { opacity: 1; max-height: 200px; }
    }

    .slot-edit-textarea {
      width: 100%;
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(88, 166, 255, 0.2);
      border-radius: 6px;
      color: var(--po-text-primary);
      font-size: 0.75rem;
      padding: 0.375rem 0.5rem;
      resize: vertical;
      min-height: 60px;
      font-family: monospace;
      line-height: 1.4;
    }
    .slot-edit-textarea:focus {
      outline: none;
      border-color: var(--po-info);
    }

    .slot-edit-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 0.25rem;
    }

    .slot-edit-hint {
      font-size: 0.62rem;
      color: var(--po-text-secondary);
      margin-right: auto;
    }

    .btn-edit-save {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: none;
      border-radius: 4px;
      background: var(--po-success-bg);
      color: var(--po-success);
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-edit-save:hover {
      background: rgba(63, 185, 80, 0.3);
    }

    .btn-edit-cancel {
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
    .btn-edit-cancel:hover {
      background: var(--po-error-bg);
      color: var(--po-error);
    }

    .slot-icon {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      background: rgba(88, 166, 255, 0.1);
      color: var(--po-info);
      font-size: 0.85rem;
    }

    .slot-info {
      flex: 1;
      min-width: 0;
    }

    .slot-label {
      font-size: 0.8rem;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .slot-card-actions {
      display: flex;
      gap: 2px;
      flex-shrink: 0;
    }

    .slot-card-actions button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s;
      font-size: 0.75rem;
    }

    .btn-run {
      background: var(--po-success-bg);
      color: var(--po-success);
    }
    .btn-run:hover {
      background: rgba(63, 185, 80, 0.3);
    }
    .btn-run:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .btn-remove-slot {
      background: transparent;
      color: var(--po-text-secondary);
    }
    .btn-remove-slot:hover {
      background: var(--po-error-bg);
      color: var(--po-error);
    }

    .slot-placeholder {
      background: rgba(88, 166, 255, 0.05);
      border: 1px dashed rgba(88, 166, 255, 0.3);
      border-radius: 8px;
      height: 42px;
      margin-bottom: 0.375rem;
    }

    .cdk-drag-preview {
      box-sizing: border-box;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    }

    .cdk-drag-animating {
      transition: transform 200ms cubic-bezier(0, 0, 0.2, 1);
    }

    .slots-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 20px 12px;
      text-align: center;
    }
    .slots-empty iconify-icon { color: var(--po-text-tertiary); }
    .slots-empty-title {
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--po-text-secondary);
    }
    .slots-empty-hint {
      font-size: 0.75rem;
      color: var(--po-text-tertiary);
      max-width: 180px;
      line-height: 1.4;
    }

    .no-session-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: rgba(210, 153, 34, 0.95);
      color: #fff;
      padding: 0.5rem 1rem;
      border-radius: 8px;
      font-size: 0.8rem;
      font-weight: 500;
      z-index: 9999;
      display: flex;
      align-items: center;
      gap: 0.375rem;
      animation: slideUp 0.3s ease;
    }

    @keyframes slideUp {
      from { transform: translateY(20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .run-feedback {
      animation: runPulse 0.4s ease;
    }

    @keyframes runPulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.03); border-color: var(--po-success); }
      100% { transform: scale(1); }
    }

    /* ── Composer flow: row 1 (mode·config·plugins) → divider → row 2
       (50% squad · 50% worker) → prompt → toolbar ── */
    .composer-tier {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .tier-controls {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tier-controls .meta-chip { height: 28px; }

    /* Row 1: mode grows, plugins beside it, config icon pinned right */
    .tier-primary .meta-chip.mode-chip { flex: 1 1 120px; min-width: 0; overflow: hidden; }
    .tier-primary .meta-chip.boost-chip { flex: 0 1 auto; }
    .tier-primary .meta-chip.config-icon {
      flex: 0 0 auto;
      width: 28px;
      padding: 0;
      margin-left: auto; /* push to the far right of the row */
    }
    .tier-primary .meta-chip select {
      width: 100%;
      min-width: 0;
      max-width: none;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Dashed divider between the two rows */
    .composer-divider {
      border-top: 1px dashed var(--po-border-subtle);
      margin: 6px 0;
    }

    /* Row 2: Squad and Worker split the width 50/50 */
    .tier-split .tier-controls > .meta-chip { flex: 1 1 0; min-width: 0; }

    /* BOOST chips — labeled icon+text pills, equal weight across the row */
    .boost-chip {
      flex: 1 1 0;
      min-width: 0;
      height: 28px;
      justify-content: center;
      position: relative;
      font-weight: var(--po-weight-semibold);
    }
    .boost-chip iconify-icon { color: var(--po-text-secondary); }
    .boost-chip .boost-chip-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .boost-chip.active {
      border-color: rgba(188, 140, 255, 0.6);
      background: rgba(188, 140, 255, 0.10);
      color: #d8b4fe;
    }
    .boost-chip.active iconify-icon { color: #d8b4fe; }
    .boost-chip.squad-chip {
      border-color: rgba(99, 102, 241, 0.35);
      background: linear-gradient(135deg, rgba(99,102,241,0.10), rgba(139,92,246,0.10));
      color: #c7d2fe;
    }
    .boost-chip.squad-chip iconify-icon { color: #a5b4fc; }
    .boost-chip.squad-chip:hover {
      border-color: rgba(99, 102, 241, 0.65);
      background: linear-gradient(135deg, rgba(99,102,241,0.18), rgba(139,92,246,0.18));
    }
    .boost-chip-badge {
      font-size: 0.5rem;
      font-weight: var(--po-weight-bold);
      letter-spacing: 0.05em;
      padding: 0 4px;
      border-radius: var(--po-radius-pill);
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff;
      flex-shrink: 0;
    }
    .boost-chip-count {
      min-width: 15px;
      height: 15px;
      padding: 0 4px;
      border-radius: 8px;
      background: #6366f1;
      color: #fff;
      font-size: 0.55rem;
      font-weight: var(--po-weight-bold);
      line-height: 15px;
      text-align: center;
      flex-shrink: 0;
    }
    /* Squad label is the first to drop on tight panels; icons always stay */
    @container action-center (max-width: 300px) {
      .boost-chip .boost-chip-label,
      .boost-chip-badge { display: none; }
      /* Spawn collapses to an icon-only play button when the panel is narrow */
      .btn-spawn-primary .btn-spawn-label { display: none; }
      .btn-spawn-primary { padding: 6px 8px; }
      /* Goal/Worker toggles: text swaps for the icon (specificity beats the
         base .chip-toggle-icon{display:none}, which sits later in the file) */
      .meta-chip .chip-toggle-text { display: none; }
      .meta-chip .chip-toggle-icon { display: inline-flex; }
    }

    /* Goal/Worker — the whole chip IS the switch: pill track, label inside, sliding knob */
    .meta-chip.worker-chip {
      flex: 0 0 auto;
      position: relative;
      justify-content: center;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      padding: 0;
      overflow: hidden;
      border-radius: var(--po-radius-pill);
      cursor: pointer;
      font-weight: var(--po-weight-semibold);
      color: var(--po-text-secondary);
      transition: background var(--po-duration-fast) var(--po-ease-out),
                  border-color var(--po-duration-fast) var(--po-ease-out),
                  color var(--po-duration-fast) var(--po-ease-out);
    }
    .meta-chip.worker-chip:hover {
      color: var(--po-text-primary);
      border-color: var(--po-accent);
    }
    .meta-chip.worker-chip.active {
      color: var(--po-accent);
      border-color: var(--po-accent);
      background: var(--po-accent-muted-bg);
    }
    .chip-toggle-knob {
      position: absolute;
      top: 3px;
      left: 3px;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--po-text-secondary);
      opacity: 0.55;
      transition: left var(--po-duration-fast) var(--po-ease-out),
                  background var(--po-duration-fast) var(--po-ease-out),
                  opacity var(--po-duration-fast) var(--po-ease-out);
      pointer-events: none;
    }
    .meta-chip.worker-chip.active .chip-toggle-knob {
      left: calc(100% - 23px);
      background: var(--po-accent);
      opacity: 1;
    }
    .chip-toggle-label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      /* room for the knob on the side it currently occupies */
      padding: 0 8px 0 26px;
      transition: padding var(--po-duration-fast) var(--po-ease-out);
    }
    /* Icon shows only in the compact breakpoint, where the text drops */
    .chip-toggle-icon { display: none; }
    .meta-chip.worker-chip.active .chip-toggle-label {
      padding: 0 26px 0 8px;
    }
    .meta-chip.mode-chip {
      --mode-color: #bc8cff;
      flex: 1;
      width: 100%;
      border-color: color-mix(in srgb, var(--mode-color) 35%, var(--po-border-subtle));
      background: color-mix(in srgb, var(--mode-color) 8%, var(--po-bg-2));
    }
    .meta-chip.mode-chip:hover {
      border-color: color-mix(in srgb, var(--mode-color) 55%, var(--po-border-subtle));
      background: color-mix(in srgb, var(--mode-color) 14%, var(--po-bg-2));
    }
    .meta-chip.mode-chip .mode-chip-trigger iconify-icon {
      color: var(--mode-color);
    }
    .meta-chip.mode-chip { position: relative; }
    .meta-chip.mode-chip .mode-chip-trigger {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 4px;
      background: transparent;
      border: none;
      padding: 0;
      margin: 0;
      cursor: pointer;
      outline: none;
      font-weight: 700;
      font-size: 0.68rem;
      color: var(--mode-color);
    }
    .meta-chip.mode-chip .mode-chip-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: left;
    }
    .meta-chip.mode-chip .mode-chip-caret { color: var(--mode-color); opacity: 0.8; flex-shrink: 0; }
    /* Let the popup escape the chip's overflow clipping while open. */
    .tier-primary .meta-chip.mode-chip.open { overflow: visible; }
    .mode-menu {
      position: absolute;
      bottom: calc(100% + 6px);
      left: 0;
      z-index: 1001;
      min-width: max(100%, 220px);
      max-height: 280px;
      overflow-y: auto;
      padding: 4px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      background: var(--po-bg-2);
      border: 1px solid var(--po-border-subtle);
      border-radius: 10px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    }
    .mode-menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 8px;
      background: transparent;
      border: none;
      border-radius: 7px;
      cursor: pointer;
      text-align: left;
      color: var(--item-color);
      font-size: 0.7rem;
      font-weight: 600;
      transition: background 0.12s;
    }
    .mode-menu-item iconify-icon { color: var(--item-color); flex-shrink: 0; }
    .mode-menu-item:hover { background: color-mix(in srgb, var(--item-color) 14%, transparent); }
    .mode-menu-item.selected { background: color-mix(in srgb, var(--item-color) 20%, transparent); }
    .mode-menu-label { flex-shrink: 0; }
    .mode-menu-hint {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--po-text-secondary);
      font-weight: 500;
    }
    .meta-chip.mode-chip.disabled {
      opacity: 0.55;
      filter: grayscale(0.35);
      transition: opacity 0.15s ease, filter 0.15s ease;
    }
    /* Quick selector groups: soft skills first, then modes. */
    .mode-menu-group {
      padding: 5px 8px 2px;
      font-size: 9px;
      font-weight: 600;
      letter-spacing: .07em;
      text-transform: uppercase;
      color: var(--po-text-tertiary);
    }
    .mode-menu-group + .mode-menu-group { margin-top: 2px; }
    /* Pen (create/edit soft skill) sits right after the chip; the config icon
       follows it flush — only the pen carries the auto margin. */
    .tier-primary .meta-chip.config-icon.skill-pen { margin-left: auto; }
    .tier-primary .meta-chip.config-icon.skill-pen ~ .meta-chip.config-icon { margin-left: 0; }
    .meta-chip.mode-chip.disabled:hover {
      opacity: 0.85;
      filter: grayscale(0.1);
    }
    .meta-chip.mode-chip.disabled .mode-chip-trigger { cursor: not-allowed; }

    .composer-boost {
      display: flex;
      align-items: stretch;
      gap: 6px;
      margin-top: 2px;
    }
    .intent-cta {
      flex: 1;
      height: 30px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 0 10px;
      border: 1px solid rgba(99, 102, 241, 0.35);
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(99,102,241,0.10), rgba(139,92,246,0.10));
      color: #c7d2fe;
      cursor: pointer;
      text-align: left;
      transition: all 0.15s;
    }
    .intent-cta:hover {
      border-color: rgba(99, 102, 241, 0.65);
      background: linear-gradient(135deg, rgba(99,102,241,0.18), rgba(139,92,246,0.18));
      box-shadow: 0 2px 10px rgba(99, 102, 241, 0.18);
    }
    .intent-cta iconify-icon {
      color: #a5b4fc;
      flex-shrink: 0;
    }
    .intent-cta-title {
      flex: 1;
      font-size: 0.74rem;
      font-weight: 700;
      letter-spacing: 0.02em;
      color: #e0e7ff;
    }
    .intent-cta-badge {
      font-size: 0.52rem;
      font-weight: 800;
      letter-spacing: 0.06em;
      padding: 1px 5px;
      border-radius: 10px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff;
      flex-shrink: 0;
    }
    @container action-center (max-width: 260px) {
      .intent-cta-badge,
      .auto-approve-bar .badge-new {
        display: none;
      }
    }

    .composer-boost-tools {
      display: flex;
      gap: 4px;
    }
    .icon-chip {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      border: 1px solid var(--po-border-subtle);
      border-radius: 8px;
      background: var(--po-bg-2);
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: all 0.15s;
    }
    .icon-chip:hover {
      border-color: rgba(188, 140, 255, 0.45);
      color: #d8b4fe;
      background: rgba(188, 140, 255, 0.06);
    }
    .icon-chip.active {
      border-color: rgba(188, 140, 255, 0.6);
      background: rgba(188, 140, 255, 0.10);
      color: #d8b4fe;
    }
    .icon-chip-badge {
      position: absolute;
      top: -3px;
      right: -3px;
      min-width: 14px;
      height: 14px;
      padding: 0 4px;
      border-radius: 8px;
      background: #6366f1;
      color: #fff;
      font-size: 0.55rem;
      font-weight: 700;
      line-height: 14px;
      text-align: center;
    }

    .composer-prompt-zone {
      margin-top: 8px;
      padding-top: 4px;
      border-top: 1px dashed var(--po-border-subtle);
    }
    .composer-prompt-zone .composer-input {
      min-height: 68px;
      padding-top: 6px;
      padding-right: 32px; /* room for the floating enhance button */
    }
    /* Enhance — pinned top-right inside the input. Selector is intentionally
       specific so it beats the later, equal-specificity .tool-btn rule that
       would otherwise reset position to relative. */
    .composer-prompt-zone .enhance-btn-floating {
      position: absolute;
      top: 6px;
      right: 2px;
      width: 26px;
      height: 26px;
      z-index: 4;
    }

    .mode-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.2rem;
      transition: all 0.15s;
    }
    .mode-grid.compact {
      grid-template-columns: repeat(6, 1fr);
      gap: 0.15rem;
    }

    .mode-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.1rem;
      padding: 0.25rem 0.15rem;
      border: 1px solid var(--po-border-subtle);
      border-radius: 8px;
      background: var(--po-bg-0);
      cursor: pointer;
      transition: all 0.15s;
      position: relative;
    }
    .mode-btn:hover {
      border-color: rgba(188, 140, 255, 0.4);
      transform: translateY(-1px);
    }
    .mode-btn.active {
      border-color: #bc8cff;
      background: rgba(188, 140, 255, 0.08);
      box-shadow: 0 0 8px rgba(188, 140, 255, 0.15);
    }

    .mode-icon {
      line-height: 1;
    }

    .mode-label {
      font-size: 0.65rem;
      font-weight: 600;
      letter-spacing: 0.03em;
      color: var(--po-text-primary);
    }

    .mode-hint {
      font-size: 0.55rem;
      color: var(--po-text-secondary);
      line-height: 1.2;
    }

    .mode-btn.active .mode-label {
      color: #bc8cff;
    }
    .mode-btn.active .mode-hint {
      color: rgba(188, 140, 255, 0.7);
    }
    .mode-grid.compact .mode-btn {
      padding: 0.2rem 0.1rem;
    }

    /* ── Custom Config Panel ── */
    .config-toggles-row {
      display: flex;
      gap: 0.35rem;
      margin-top: 0.2rem;
    }
    .config-toggles-row.mode-shortcuts-row {
      margin-top: 0;
      margin-bottom: 0.4rem;
    }
    .config-toggles-row > .custom-config-toggle {
      flex: 1 1 50%;
      min-width: 0;
      margin-top: 0;
    }
    .custom-config-toggle {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.3rem;
      width: 100%;
      margin-top: 0.2rem;
      padding: 0.2rem;
      border: 1px dashed var(--po-border-subtle);
      border-radius: 6px;
      background: transparent;
      color: var(--po-text-secondary);
      font-size: 0.65rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      cursor: pointer;
      transition: all 0.15s;
    }
    .custom-config-toggle:hover {
      border-color: rgba(188, 140, 255, 0.4);
      color: #bc8cff;
    }
    .custom-config-toggle.active {
      border-color: #bc8cff;
      color: #bc8cff;
      background: rgba(188, 140, 255, 0.05);
    }

    .inject-toggle {
      border-style: solid;
      border-color: rgba(99, 102, 241, 0.15);
    }
    .inject-toggle:hover {
      border-color: rgba(99, 102, 241, 0.4);
      color: #6366f1;
    }
    .inject-toggle.active {
      border-color: #6366f1;
      color: #6366f1;
      background: rgba(99, 102, 241, 0.05);
    }
    .inject-badge {
      font-size: 0.55rem;
      font-weight: 700;
      padding: 0.05rem 0.3rem;
      border-radius: 10px;
      background: #6366f1;
      color: white;
      min-width: 14px;
      text-align: center;
      line-height: 1.3;
    }

    .custom-config-panel {
      margin-top: 0.2rem;
      padding: 0.35rem;
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid rgba(188, 140, 255, 0.15);
      border-radius: 8px;
      animation: configSlideDown 0.2s ease;
    }

    @keyframes configSlideDown {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .config-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.2rem;
    }
    .config-row:last-child {
      margin-bottom: 0;
    }

    .config-label {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      font-size: 0.65rem;
      font-weight: 600;
      color: var(--po-text-secondary);
      white-space: nowrap;
      min-width: 80px;
    }

    .config-hint {
      color: var(--po-text-muted, var(--po-text-secondary));
      opacity: 0.6;
      cursor: help;
      flex-shrink: 0;
    }
    .config-hint:hover {
      opacity: 1;
    }

    .config-select {
      background: var(--po-bg-0);
      border: 1px solid var(--po-border-subtle);
      border-radius: 4px;
      color: var(--po-text-primary);
      font-size: 0.65rem;
      font-weight: 500;
      padding: 0.15rem 0.3rem;
      cursor: pointer;
      flex: 1;
      max-width: 120px;
    }
    .config-select:focus {
      outline: none;
      border-color: #bc8cff;
    }

    /* Plugins & Skills entry inside the custom-config panel — opens the
       same selector modal as the toolbar plug button (classic-mode parity). */
    .config-divider {
      height: 1px;
      margin: 0.35rem 0 0.3rem;
      background: rgba(188, 140, 255, 0.15);
    }
    .config-extensions-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 0.2rem 0.15rem;
      background: transparent;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.12s;
    }
    .config-extensions-row:hover {
      background: rgba(188, 140, 255, 0.1);
    }
    .config-extensions-row .config-label {
      cursor: pointer;
    }
    .config-extensions-row.has-selection .config-label {
      color: #d8b4fe;
    }
    .config-extensions-meta {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      color: var(--po-text-muted, var(--po-text-secondary));
    }
    .config-extensions-count {
      min-width: 14px;
      height: 14px;
      padding: 0 4px;
      border-radius: 8px;
      background: #6366f1;
      color: #fff;
      font-size: 0.55rem;
      font-weight: var(--po-weight-bold);
      line-height: 14px;
      text-align: center;
    }

    /* ── Spawn Composer (chat-style input) ── */
    .create-agent-section {
      padding: 0.5rem;
      border-top: 1px solid var(--po-border-subtle);
      background: var(--po-bg-2);
      flex-shrink: 0;
    }

    .spawn-composer {
      --composer-col2: 112px; /* shared width: type chip (row 1) = worker chip (row 2) */
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px;
      background: var(--po-bg-0);
      border: 1px solid var(--po-border-subtle);
      border-radius: 12px;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .spawn-composer:focus-within {
      border-color: rgba(129, 140, 248, 0.55);
      box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.15),
        0 0 0 3px rgba(129, 140, 248, 0.12);
    }
    .spawn-composer.composer-voice-listening {
      border-color: rgba(236, 72, 153, 0.55);
      box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.15),
        0 0 0 3px rgba(236, 72, 153, 0.15);
    }
    .spawn-composer.composer-enhancing {
      border-color: rgba(251, 191, 36, 0.5);
    }

    /* Meta chips (provider + type) */
    .composer-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .meta-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      background: var(--po-bg-2);
      border: 1px solid var(--po-border-subtle);
      border-radius: 999px;
      font-size: 0.68rem;
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
      max-width: 100%;
    }
    .meta-chip:hover {
      background: rgba(129, 140, 248, 0.08);
      border-color: rgba(129, 140, 248, 0.35);
    }
    .meta-chip iconify-icon {
      flex-shrink: 0;
    }
    .meta-chip.provider-chip iconify-icon { color: #bc8cff; }
    .meta-chip.type-chip iconify-icon { color: #818cf8; }
    .meta-chip select {
      appearance: none;
      -webkit-appearance: none;
      background: transparent;
      border: none;
      color: var(--po-text-primary);
      font-size: 0.68rem;
      font-weight: 500;
      padding: 1px 14px 1px 2px;
      cursor: pointer;
      outline: none;
      max-width: 130px;
      text-overflow: ellipsis;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>");
      background-repeat: no-repeat;
      background-position: right 0 center;
      background-size: 9px;
    }
    .meta-chip select option {
      background: var(--po-bg-2);
      color: var(--po-text-primary);
    }

    /* Input area */
    .composer-input-wrapper {
      position: relative;
    }
    .composer-input {
      width: 100%;
      min-height: 56px;
      max-height: 220px;
      padding: 2px 4px;
      background: transparent;
      border: none;
      color: var(--po-text-primary);
      font-family: inherit;
      font-size: 0.82rem;
      line-height: 1.45;
      resize: none;
      overflow-y: auto;
      outline: none;
      transition: height 0.08s ease-out;
    }
    .composer-input::placeholder {
      color: var(--po-text-secondary);
      opacity: 0.6;
    }
    .composer-input.enhancing {
      opacity: 0.55;
      cursor: wait;
    }

    /* Enhance popover */
    .enhance-spinner {
      width: 13px;
      height: 13px;
      border: 2px solid rgba(251, 191, 36, 0.25);
      border-top-color: #fbbf24;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    .enhance-depth-popover {
      position: absolute;
      bottom: calc(100% + 6px);
      left: 0;
      min-width: 220px;
      padding: 8px;
      background: var(--po-bg-2);
      border: 1px solid rgba(251, 191, 36, 0.35);
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      z-index: 10;
      animation: depth-pop-in 0.12s ease-out;
    }
    @keyframes depth-pop-in {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .enhance-depth-title {
      font-size: 0.68rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--po-text-secondary);
      margin: 0 0 6px;
      padding: 0 4px;
    }
    .enhance-depth-options {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .enhance-depth-option {
      display: grid;
      grid-template-columns: 16px 1fr;
      grid-template-rows: auto auto;
      column-gap: 8px;
      row-gap: 1px;
      align-items: center;
      padding: 6px 8px;
      border: none;
      background: transparent;
      color: var(--po-text-primary);
      border-radius: 6px;
      cursor: pointer;
      text-align: left;
      transition: background 0.12s;
    }
    .enhance-depth-option iconify-icon {
      grid-row: 1 / span 2;
      color: #fbbf24;
    }
    .enhance-depth-option:hover {
      background: rgba(251, 191, 36, 0.1);
    }
    .enhance-depth-label {
      font-size: 0.78rem;
      font-weight: 600;
    }
    .enhance-depth-hint {
      font-size: 0.68rem;
      color: var(--po-text-secondary);
    }

    /* Toolbar */
    .composer-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      /* Fixed-width tool buttons (28px × ~7) can't fit a very narrow sidebar.
         Allow wrap so the right cluster (mic + play) drops to its own row instead
         of overflowing past the right edge. */
      flex-wrap: wrap;
      row-gap: 6px;
    }
    .toolbar-left {
      display: flex;
      align-items: center;
      gap: 2px;
      flex: 1 1 auto;
      min-width: 0;
      flex-wrap: wrap;
    }
    .toolbar-right {
      display: flex;
      align-items: center;
      gap: 6px;
      /* Keep mic + play intact and pinned right; wrap as a unit, never clipped. */
      flex-shrink: 0;
      margin-left: auto;
    }
    /* Two stacked tool rows on the left; the Spawn button spans both. */
    .toolbar-main {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1 1 auto;
      min-width: 0;
    }
    /* Minimal UI: the extra TODO button tipped the toolbar over its width at the
       narrowest panel, so flex-wrap dropped the Spawn ("invio") button onto its
       own row. flex-basis:0 makes toolbar-main claim zero base width for line-
       breaking (then grow to fill), so the tool rows wrap internally and the
       Spawn button always stays beside them instead of below. */
    :host-context(html[data-po-ui="minimal"]) .composer-toolbar > .toolbar-main {
      flex-basis: 0;
    }
    .toolbar-row {
      display: flex;
      align-items: center;
      gap: 2px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .btn-spawn-tall {
      align-self: stretch;
      height: auto;
      flex-shrink: 0;
    }
    /* Model quick-switch — stretches across the central space of the top row;
       the attach button stays pinned right, glued to the Spawn button. */
    .tool-btn.provider-tool.model-tool {
      flex: 1 1 112px;
      min-width: 0;
    }
    .model-tool .provider-trigger {
      justify-content: space-between;
    }
    .model-tool .model-chip-label {
      font-size: 0.68rem;
      font-weight: 600;
      color: var(--po-text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .model-tool:not(.effort-tool) .model-chip-label {
      font-size: 0.74rem;
    }
    .tool-btn.provider-tool.effort-tool {
      flex: 0 0 auto;
      min-width: 0;
    }
    .effort-tool .provider-trigger {
      justify-content: center;
    }
    .effort-short { display: none; }
    @container action-center (max-width: 320px) {
      .effort-full { display: none; }
      .effort-short { display: inline; }
    }
    .toolbar-row-top { flex-wrap: nowrap; }
    .provider-menu.effort-menu { min-width: 140px; right: 0; left: auto; }
    .model-menu {
      width: 100%;
      min-width: 150px;
    }
    .toolbar-row-top .attach-btn {
      margin-left: auto;
    }
    .toolbar-row-bottom .voice-btn {
      margin-left: auto;
    }

    .tool-btn {
      position: relative;
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: background 0.15s, color 0.15s, transform 0.1s;
    }
    .tool-btn:hover:not(:disabled) {
      background: rgba(129, 140, 248, 0.12);
      color: #a5b4fc;
    }
    .tool-btn:active:not(:disabled) {
      transform: scale(0.94);
    }
    .tool-btn:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }

    /* Provider — logo icon + caret; a transparent native select overlays it
       so a click opens the provider dropdown. */
    .tool-btn.provider-tool {
      position: relative;
      width: auto;
      gap: 3px;
      padding: 0 5px;
      overflow: hidden;
    }
    .provider-tool .provider-logo {
      width: 16px;
      height: 16px;
      border-radius: 3px;
      object-fit: contain;
      flex-shrink: 0;
    }
    .provider-tool .provider-logo-wrap {
      position: relative;
      display: inline-flex;
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }
    .provider-tool .provider-logo-spinner {
      position: absolute;
      inset: -3px;
      box-sizing: border-box;
      pointer-events: none;
      border: 2px solid transparent;
      border-top-color: var(--po-primary, #6366f1);
      border-radius: 50%;
      animation: po-provider-spin .6s linear infinite;
    }
    @keyframes po-provider-spin { to { transform: rotate(360deg); } }
    .provider-tool .provider-caret {
      color: var(--po-text-tertiary);
      flex-shrink: 0;
    }
    .tool-btn.provider-tool.open { overflow: visible; }
    /* The dropdown is a child of the chip: the press feedback (.tool-btn:active
       → scale) would shrink and shift the OPEN menu under the pointer between
       mousedown and mouseup, so the click lands on the menu padding instead of
       the item (top rows worst). No press transform while a menu is open. */
    .tool-btn.open,
    .tool-btn.open:active:not(:disabled) { transform: none; }
    .provider-tool .provider-trigger {
      display: flex;
      align-items: center;
      gap: 3px;
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      border: none;
      background: transparent;
      cursor: pointer;
      outline: none;
    }
    .provider-menu {
      position: absolute;
      bottom: calc(100% + 6px);
      left: 0;
      z-index: 1001;
      min-width: 200px;
      max-height: 320px;
      overflow-y: auto;
      padding: 4px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      background: var(--po-bg-2);
      border: 1px solid var(--po-border-subtle);
      border-radius: 10px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    }
    .provider-menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 8px;
      background: transparent;
      border: none;
      border-radius: 7px;
      cursor: pointer;
      text-align: left;
      color: var(--po-text-primary);
      font-size: 0.7rem;
      font-weight: 500;
      transition: background 0.12s;
    }
    .provider-menu-item:hover { background: rgba(129, 140, 248, 0.1); }
    .provider-menu-item.selected { background: rgba(129, 140, 248, 0.16); font-weight: 600; }
    .provider-menu-logo {
      width: 16px;
      height: 16px;
      border-radius: 3px;
      object-fit: contain;
      flex-shrink: 0;
    }
    .provider-menu-label { flex: 1; min-width: 0; }
    .provider-menu-check { color: #818cf8; flex-shrink: 0; }

    /* Plugins & Skills chip (row 1) — count badge on the top-right corner */
    .plugins-btn-badge {
      position: absolute;
      top: -2px;
      right: -2px;
      min-width: 14px;
      height: 14px;
      padding: 0 4px;
      border-radius: 8px;
      background: #6366f1;
      color: #fff;
      font-size: 0.55rem;
      font-weight: var(--po-weight-bold);
      line-height: 14px;
      text-align: center;
    }

    .tool-btn.attach-btn { color: var(--po-text-secondary); }
    .tool-btn.attach-btn:hover:not(:disabled) {
      background: rgba(16, 185, 129, 0.14);
      color: #34d399;
    }

    .tool-btn.enhance-btn { color: #fbbf24; }
    .tool-btn.enhance-btn:hover:not(:disabled) {
      background: rgba(251, 191, 36, 0.14);
      color: #fbbf24;
    }
    .tool-btn.enhance-btn.active {
      background: rgba(251, 191, 36, 0.18);
      color: #fbbf24;
    }

    .tool-btn.voice-btn { color: #ec4899; }
    .tool-btn.voice-btn:hover:not(:disabled) {
      background: rgba(236, 72, 153, 0.14);
      color: #ec4899;
    }
    .tool-btn.voice-btn.voice-listening {
      background: rgba(236, 72, 153, 0.22);
      color: #ec4899;
      animation: voice-pulse 1.2s ease-in-out infinite;
    }
    .tool-btn.voice-btn.voice-processing {
      background: var(--po-warning-bg);
      color: var(--po-warning);
    }
    .beta-dot {
      position: absolute;
      top: 3px;
      right: 3px;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #ec4899;
      box-shadow: 0 0 0 1.5px var(--po-bg-0);
    }
    @keyframes voice-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(236, 72, 153, 0.4); }
      50% { box-shadow: 0 0 0 5px rgba(236, 72, 153, 0); }
    }

    .tool-btn.resume-btn { color: #818cf8; }
    .tool-btn.resume-btn:hover:not(:disabled) {
      background: rgba(129, 140, 248, 0.14);
      color: #a5b4fc;
    }

    /* TODO list button — minimal UI only (classic stays untouched) */
    .tool-btn.todo-btn { display: none; color: #34d399; }
    :host-context(html[data-po-ui="minimal"]) .tool-btn.todo-btn { display: inline-flex; }
    .tool-btn.todo-btn:hover:not(:disabled) {
      background: rgba(52, 211, 153, 0.14);
      color: #6ee7b7;
    }

    .tool-btn.account-btn { color: #a5b4fc; position: relative; }
    .tool-btn.account-btn:hover:not(:disabled) {
      background: rgba(99, 102, 241, 0.14);
      color: #c7d2fe;
    }
    .tool-btn.account-btn.account-btn-active {
      background: rgba(99, 102, 241, 0.22);
      color: #c7d2fe;
      box-shadow: inset 0 0 0 1px rgba(99, 102, 241, 0.55);
    }
    .tool-btn .account-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
    }

    /* Keyboard hint */
    .kbd-hint {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.62rem;
      color: var(--po-text-secondary);
      background: var(--po-bg-2);
      border: 1px solid var(--po-border-subtle);
      border-radius: 4px;
      user-select: none;
      animation: fadeIn 0.15s ease;
    }

    /* Primary spawn button */
    .btn-spawn-primary {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 6px 12px;
      border: none;
      border-radius: 8px;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: #fff;
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 2px 6px rgba(99, 102, 241, 0.35);
      transition: transform 0.1s, box-shadow 0.15s, opacity 0.15s, filter 0.15s;
      white-space: nowrap;
    }
    .btn-spawn-primary:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 4px 10px rgba(99, 102, 241, 0.45);
      filter: brightness(1.06);
    }
    .btn-spawn-primary:active:not(:disabled) {
      transform: translateY(0);
    }
    .btn-spawn-primary:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      box-shadow: none;
      filter: grayscale(0.3);
    }
    .btn-spawn-label {
      font-weight: 600;
    }

    .voice-inline-feedback {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.68rem;
      color: #ec4899;
      padding: 0.2rem 0;
      animation: fadeIn 0.2s ease;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .voice-inline-feedback.voice-fb-error {
      color: var(--po-error);
    }
    .voice-inline-feedback.voice-fb-listening {
      color: #ec4899;
    }
    .voice-listening-dots {
      display: inline-flex;
      gap: 2px;
    }
    .voice-listening-dots span {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: #ec4899;
      animation: vdot-bounce 1.2s ease-in-out infinite;
    }
    .voice-listening-dots span:nth-child(2) { animation-delay: 0.2s; }
    .voice-listening-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes vdot-bounce {
      0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
      40% { transform: scale(1); opacity: 1; }
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-2px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* ── Active Agents ── */
    .active-agents-section,
    .bench-section {
      padding: 0.35rem 0.5rem;
      border-bottom: 1px solid var(--po-border-subtle);
      flex-shrink: 0;
    }
    /* No fixed cap: the list grows to fill the available space and
       scrolling starts from the outer container (.action-center-scroll), which
       stops exactly above the pinned quick-commit bar. */
    .bench-section {
      max-height: 220px;
      overflow-y: auto;
    }
    .bench-section .section-label {
      color: var(--po-text-tertiary);
    }

    .section-label {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.68rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--po-text-secondary);
      margin: 0 0 0.2rem;
    }


    .agent-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.2rem 0.4rem;
      background: var(--po-bg-0);
      border: 1px solid var(--po-border-subtle);
      border-radius: 5px;
      margin-bottom: 0.15rem;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    .agent-card:hover {
      background: var(--po-bg-1);
      border-color: var(--po-border);
    }
    .agent-card.active {
      background: linear-gradient(90deg, rgba(99, 102, 241, 0.15), rgba(168, 85, 247, 0.1));
      border-color: rgba(139, 92, 246, 0.6);
    }

    .agent-card-left {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      min-width: 0;
      flex: 1;
    }

    .agent-card-info {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      min-width: 0;
      flex: 1;
    }

    .agent-card-title {
      font-size: 0.7rem;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .agent-card-status {
      font-size: 0.55rem;
      font-weight: 700;
      text-transform: uppercase;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .st-spawning { color: var(--po-warning); }
    .st-running { color: var(--po-success); }
    .st-completed { color: var(--po-info); }
    .st-error { color: var(--po-error); }

    .agent-attention-badge {
      display: flex;
      align-items: center;
      gap: 0.2rem;
      font-size: 0.55rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--po-warning);
      white-space: nowrap;
      flex-shrink: 0;
      animation: badge-pulse 1.2s ease-in-out infinite;
    }

    .agent-attention-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--po-warning);
      box-shadow: 0 0 4px var(--po-warning);
      animation: dot-blink 1s ease-in-out infinite;
    }

    @keyframes badge-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    @keyframes dot-blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.2; }
    }

    .agent-card-actions {
      display: flex;
      align-items: center;
      gap: 0.15rem;
      flex-shrink: 0;
    }

    .btn-agent-aa {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-agent-aa:hover {
      background: var(--po-warning-bg);
      color: var(--po-warning);
    }
    .btn-agent-aa.aa-on {
      background: rgba(248, 81, 73, 0.18);
      color: var(--po-error);
      box-shadow: 0 0 6px rgba(248, 81, 73, 0.35);
      animation: aa-glow 1.5s ease-in-out infinite;
    }
    .btn-agent-aa.aa-on:hover {
      background: rgba(248, 81, 73, 0.3);
    }

    @keyframes aa-glow {
      0%, 100% { box-shadow: 0 0 4px rgba(248, 81, 73, 0.3); }
      50% { box-shadow: 0 0 8px rgba(248, 81, 73, 0.6); }
    }

    .btn-agent-eco {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--po-text-tertiary);
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-agent-eco:hover {
      background: var(--po-success-bg);
      color: var(--po-success);
    }
    .btn-agent-eco.eco-on {
      color: var(--po-success);
    }
    .btn-agent-eco.eco-on:hover {
      background: rgba(248, 81, 73, 0.12);
      color: var(--po-error);
    }

    .btn-agent-bench {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--po-text-tertiary);
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-agent-bench:hover {
      background: rgba(99, 102, 241, 0.15);
      color: var(--po-info);
    }
    .btn-agent-bench:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    .btn-agent-bench.bench-back {
      color: #d946ef;
    }
    .btn-agent-bench.bench-back:hover {
      background: rgba(217, 70, 239, 0.16);
      color: #e879f9;
    }

    .agent-card.benched {
      background: var(--po-bg-2);
      border-color: var(--po-border-subtle);
      filter: saturate(0.6);
    }
    .agent-card.benched:hover {
      background: var(--po-bg-1);
      filter: saturate(1);
    }
    .agent-card.benched .agent-card-title {
      color: var(--po-text-secondary);
    }

    .btn-agent-close {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
    }
    .btn-agent-close:hover {
      background: var(--po-error-bg);
      color: var(--po-error);
    }

    /* ── Interactions Section ── */
    .interactions-section {
      padding: 0.5rem;
      border-bottom: 1px solid var(--po-border-subtle);
    }

    .spin {
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    /* ── Auto-Approve ── */
    .auto-approve-bar {
      padding: 0.4rem 0.5rem;
      border-bottom: 1px solid var(--po-border-subtle);
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      transition: background 0.2s, border-color 0.2s;
    }
    .auto-approve-bar.active {
      background: rgba(248, 81, 73, 0.06);
      border-bottom-color: rgba(248, 81, 73, 0.25);
    }
    .auto-approve-bar.selecting {
      background: rgba(248, 81, 73, 0.10);
      border-bottom-color: rgba(248, 81, 73, 0.45);
      padding: 0.65rem 0.6rem 0.7rem;
    }

    /* ── Sidebar selection-mode UI ──
       Replaces the Auto-Approve button while the user is picking modes
       on the per-pane cards. Shows title + helper + Cancel/Apply. */
    .aa-select-inline {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      animation: aa-inline-pop 0.18s ease;
    }
    @keyframes aa-inline-pop {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .aa-select-inline-head {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--po-error);
      font-size: 0.78rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .aa-select-inline-title {
      color: #fff;
      flex: 1;
      min-width: 0;
    }
    .aa-select-inline-progress {
      font-size: 0.62rem;
      font-weight: 800;
      letter-spacing: 0.05em;
      color: rgba(168, 85, 247, 0.95);
      background: rgba(168, 85, 247, 0.15);
      border: 1px solid rgba(168, 85, 247, 0.35);
      padding: 2px 6px;
      border-radius: 5px;
      white-space: nowrap;
      transition: all 0.2s ease;
    }
    .aa-select-inline-progress.complete {
      color: #4ade80;
      background: rgba(74, 222, 128, 0.14);
      border-color: rgba(74, 222, 128, 0.4);
      box-shadow: 0 0 8px rgba(74, 222, 128, 0.3);
    }
    .aa-select-inline-hint {
      margin: 0;
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 0.68rem;
      font-weight: 500;
      color: var(--po-text-secondary);
      line-height: 1.35;
    }
    .aa-select-inline-hint iconify-icon {
      color: var(--po-accent);
      flex-shrink: 0;
    }
    .aa-select-inline-actions {
      display: flex;
      gap: 6px;
    }
    .btn-aa-cancel,
    .btn-aa-apply {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 7px 10px;
      font-family: inherit;
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      border-radius: 7px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-aa-cancel {
      border: 1px solid rgba(139, 148, 158, 0.35);
      background: transparent;
      color: var(--po-text-secondary);
    }
    .btn-aa-cancel:hover {
      color: var(--po-text-primary);
      border-color: rgba(230, 237, 243, 0.5);
      background: rgba(255, 255, 255, 0.04);
    }
    .btn-aa-apply {
      border: 1px solid var(--po-error);
      background: rgba(248, 81, 73, 0.85);
      color: #fff;
      box-shadow: 0 0 10px rgba(248, 81, 73, 0.35);
    }
    .btn-aa-apply:hover {
      background: var(--po-error);
      box-shadow: 0 0 16px rgba(248, 81, 73, 0.55);
    }

    .btn-auto-approve {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      width: 100%;
      padding: 0.4rem 0.6rem;
      border: 1px solid var(--po-border-subtle);
      border-radius: 6px;
      background: var(--po-bg-0);
      color: var(--po-text-secondary);
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-auto-approve:hover {
      border-color: var(--po-warning);
      color: var(--po-warning);
      background: rgba(210, 153, 34, 0.06);
    }
    .btn-auto-approve.on {
      border-color: var(--po-error);
      color: #fff;
      background: rgba(248, 81, 73, 0.8);
      box-shadow: 0 0 8px rgba(248, 81, 73, 0.25);
    }
    .btn-auto-approve.on:hover {
      background: rgba(248, 81, 73, 0.6);
    }
    .btn-auto-approve-label {
      flex: 1;
      text-align: left;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    /* Status bar (active / thinking) */
    .aa-status-bar {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.65rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 0.2rem 0.4rem;
      border-radius: 4px;
    }
    .aa-status-bar.active {
      color: var(--po-error);
      background: var(--po-error-bg);
      animation: aa-pulse 2s ease-in-out infinite;
    }
    .aa-status-bar.thinking {
      color: var(--po-accent);
      background: rgba(168, 85, 247, 0.1);
    }
    .aa-status-bar.thinking .spin {
      animation: spin 1s linear infinite;
    }
    .aa-status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--po-error);
      animation: aa-dot-blink 1.5s ease-in-out infinite;
    }
    @keyframes aa-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    @keyframes aa-dot-blink {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.8); }
    }

    .badge-new {
      font-size: 0.55rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 1px 5px;
      border-radius: 6px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff;
      line-height: 1.4;
      margin-left: 6px;
    }
    .badge-new-wrapper {
      position: relative;
      overflow: visible;
    }
    .badge-new-corner {
      position: absolute;
      bottom: -6px;
      right: -10px;
      margin-left: 0;
      font-size: 0.5rem;
      padding: 0px 4px;
      box-shadow: 0 1px 4px rgba(99, 102, 241, 0.4);
      pointer-events: none;
    }

    .quick-action-scope { position: relative; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 30px; height: 26px; color: var(--po-text-secondary); }
    .quick-action-scope.global { color: var(--po-info); }
    .quick-action-scope > select { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; margin: 0; padding: 0; opacity: 0; cursor: pointer; }
    .quick-action-scope:focus-within { outline: 2px solid var(--po-info); border-radius: 4px; }
    .quick-actions-mini { display: none; }
    :host-context(html[data-po-ui="minimal"]) .quick-actions-mini {
      display: flex; flex-direction: column; gap: 3px; min-width: 0;
      margin-bottom: 6px; padding: 4px;
      background: var(--po-bg-1); border: 1px solid var(--po-border-subtle);
      border-radius: var(--po-radius-md, 8px);
    }
    :host-context(html[data-po-ui="minimal"]) .acc-panel-actions { display: none; }
    .quick-actions-mini-header, .quick-actions-mini-row, .quick-actions-mini-footer {
      display: flex; align-items: center; gap: 3px; min-width: 0;
    }
    .quick-actions-mini-header > span {
      flex: 1; min-width: 0; padding-left: 3px; font-size: 9px;
      font-weight: 600; letter-spacing: .07em; text-transform: uppercase;
      color: var(--po-text-tertiary);
    }
    .quick-actions-mini button {
      display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0; min-width: 24px; height: 24px; padding: 0 4px;
      border: none; border-radius: 4px; background: transparent;
      color: var(--po-text-secondary); cursor: pointer;
    }
    .quick-actions-mini button:hover:not(:disabled), .quick-actions-mini button.active {
      background: var(--po-bg-3); color: var(--po-text-primary);
    }
    .quick-actions-mini button:disabled { opacity: .4; cursor: not-allowed; }
    .quick-actions-mini button:focus-visible, .quick-actions-mini select:focus-visible {
      outline: 2px solid var(--po-text-secondary); outline-offset: 1px;
    }
    .quick-actions-mini-row > select {
      flex: 1; min-width: 0; width: 0; height: 26px; padding: 0 3px;
      border: 1px solid var(--po-border-subtle); border-radius: 4px;
      background: var(--po-bg-2); color: var(--po-text-primary);
      font-family: inherit; font-size: 11px; text-overflow: ellipsis; cursor: pointer;
    }
    .quick-actions-mini select:disabled { color: var(--po-text-tertiary); cursor: default; }
    .quick-actions-mini-editor { min-width: 0; }
    .quick-actions-mini-textarea { min-height: 64px; max-height: 160px; font-size: 11px; }
    .quick-actions-mini-footer { justify-content: flex-end; }
    .delete-edit-action { color: var(--bs-danger) !important; margin-right: auto; background: none; border: 0; display: inline-flex; align-items: center; gap: 4px; }
    .quick-actions-mini-footer button { font-size: 10px; padding: 0 6px; }

    /* ── Quick git commit bar — detached, above the whole spawn block (minimal UI only) ── */
    .quick-commit-bar { display: none; }
    :host-context(html[data-po-ui="minimal"]) .quick-commit-bar {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 0 0 10px;
      padding: 4px;
      background: var(--po-bg-1);
      border: 1px solid var(--po-border-subtle);
      border-radius: var(--po-radius-md, 8px);
    }
    /* Clean repo (no changes): the bar stays put so Push is still reachable after a
       commit, but reads as idle; it brightens back up on hover/focus. */
    :host-context(html[data-po-ui="minimal"]) .quick-commit-bar.clean { opacity: 0.7; }
    :host-context(html[data-po-ui="minimal"]) .quick-commit-bar.clean:hover,
    :host-context(html[data-po-ui="minimal"]) .quick-commit-bar.clean:focus-within { opacity: 1; }
    .quick-commit-repo {
      display: flex; align-items: center; gap: 5px;
      padding: 0 2px; color: var(--po-text-secondary);
    }
    .quick-commit-repo-select {
      flex: 1; min-width: 0; height: 20px; padding: 0 4px;
      background: var(--po-bg-3); color: var(--po-text-secondary);
      border: none; border-radius: var(--po-radius-sm, 6px);
      font-size: 0.66rem; font-weight: 500; font-family: inherit;
      cursor: pointer; outline: none;
    }
    .quick-commit-repo-select:hover, .quick-commit-repo-select:focus { color: var(--po-text-primary); }
    .quick-commit-row { display: flex; align-items: center; gap: 6px; }
    /* min-width:0 lets the primary CTA actually shrink so the trailing icons
       (push + settings gear) never get shoved past the right edge on a cramped
       sidebar — without it the button keeps its content width and the row overflows. */
    .quick-commit-row .quick-commit-go { flex: 1; min-width: 0; justify-content: center; }
    /* Progressive collapse, keyed to the action-center panel. The panel is width:100%
       of its resizable wrapper (min-width 200px), so this container width == the
       sidebar width the user drags:
       1) ≤300px: drop the verbose "Stage+Commit" label, keep the colored +/~/- breakdown;
       2) ≤235px (sidebar near its minimum): drop the breakdown too and show ONLY the
          summed total (added + modified + deleted) next to the check icon. */
    .quick-commit-total { display: none; flex-shrink: 0; font-variant-numeric: tabular-nums; font-weight: 600; }
    /* NB: selectors are qualified with .quick-commit-go to out-specify the base
       .quick-commit-counts / .quick-commit-total rules declared further down — a
       bare selector here would lose the cascade and the badges would never hide. */
    @container action-center (max-width: 300px) {
      .quick-commit-go .quick-commit-label { display: none; }
    }
    @container action-center (max-width: 235px) {
      .quick-commit-go .quick-commit-counts { display: none; }
      .quick-commit-go .quick-commit-total { display: inline-flex; }
      /* 3) sidebar at its narrowest: collapse the branch chip to its git icon so the
         whole action row (branch · commit · push · gear) stays inside the
         bar — the gear no longer overflows to the right. */
      .quick-commit-row { gap: 4px; }
      .quick-commit-branch { max-width: none; padding: 0 5px; gap: 0; }
      .quick-commit-branch-name { display: none; }
    }
    /* Spinner used by the pull/AI/commit/push icons — without this rule the
       [class.spinning] bindings change the glyph but never actually rotate. */
    .quick-commit-bar .spinning { animation: spin 1s linear infinite; }
    .quick-commit-branch {
      display: inline-flex; align-items: center; gap: 3px;
      max-width: 90px; height: 22px; padding: 0 6px; flex-shrink: 0;
      border: none; border-radius: var(--po-radius-sm, 6px);
      background: var(--po-bg-3); color: var(--po-text-secondary);
      font-size: 0.66rem; font-weight: 500; cursor: pointer;
      transition: background var(--po-duration-fast, 100ms), color var(--po-duration-fast, 100ms);
    }
    .quick-commit-branch:hover:not(:disabled) { color: var(--po-text-primary); }
    .quick-commit-branch-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Input zone: relative anchor for the floating AI wand (top-right, on the
       input line). The textarea reserves right padding so text never runs
       under the button. */
    .quick-commit-input-zone { position: relative; width: 100%; min-width: 0; }
    .quick-commit-input-zone .quick-commit-ai-floating {
      position: absolute; top: 0; right: 0; z-index: 2;
    }
    .quick-commit-input {
      width: 100%; min-width: 0; flex: 0 0 auto; box-sizing: border-box;
      background: transparent; border: none; outline: none;
      color: var(--po-text-primary); font-size: 0.6rem; padding: 2px 26px 2px 2px;
      resize: none; line-height: 1.35; font-family: inherit;
      white-space: pre-wrap; word-break: break-word;
      /* Auto-grow from 2 up to 3 lines, then scroll. */
      field-sizing: content;
      min-height: calc(1.35em * 2 + 4px);
      max-height: calc(1.35em * 3 + 4px);
      overflow-y: auto;
    }
    .quick-commit-input::placeholder { color: var(--po-text-tertiary); }
    /* While the AI is writing the message: lock the field and make it obvious
       something is happening (pulsing accent placeholder + wait cursor). */
    .quick-commit-input:disabled { cursor: progress; }
    .quick-commit-input.generating { color: var(--po-text-tertiary); }
    .quick-commit-input.generating::placeholder {
      color: var(--po-accent);
      animation: quickCommitPulse 1.1s ease-in-out infinite;
    }
    @keyframes quickCommitPulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }
    .quick-commit-error {
      flex-basis: 100%;
      display: inline-flex; align-items: center; gap: 4px;
      min-width: 0; padding: 1px 4px 0;
      color: var(--po-error, #f85149); font-size: 0.66rem;
    }
    .quick-commit-error span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .quick-commit-error iconify-icon { flex-shrink: 0; }
    /* AI Resolver — same purple treatment as the git explorer's inline button. */
    .quick-commit-ai-resolver {
      display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0;
      margin-left: auto;
      background: linear-gradient(90deg, rgba(110,86,207,0.22), rgba(166,114,255,0.22));
      border: 1px solid rgba(166,114,255,0.45);
      color: #cbb6ff; border-radius: var(--po-radius-sm, 6px);
      padding: 1px 6px; height: 18px;
      font-size: 0.62rem; font-weight: 500; cursor: pointer; white-space: nowrap;
      transition: background var(--po-duration-fast, 100ms);
    }
    .quick-commit-ai-resolver:hover:not(:disabled) {
      background: linear-gradient(90deg, rgba(110,86,207,0.34), rgba(166,114,255,0.34));
    }
    .quick-commit-ai-resolver:disabled { opacity: 0.6; cursor: not-allowed; }
    .quick-commit-ai-log {
      flex-basis: 100%;
      display: flex; flex-direction: column; gap: 2px;
      padding: 2px 4px 0; font-size: 0.62rem; min-width: 0;
    }
    .qc-ai-working { display: flex; align-items: center; gap: 5px; color: #cbb6ff; font-weight: 500; }
    .qc-ai-working iconify-icon { color: #a672ff; flex-shrink: 0; }
    .qc-ai-step { display: flex; align-items: center; gap: 4px; color: var(--po-text-secondary); animation: aiStepIn 0.25s ease; }
    .qc-ai-step iconify-icon { color: var(--po-success); flex-shrink: 0; }
    .qc-ai-step span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @keyframes aiStepIn { from { opacity: 0; transform: translateX(-3px); } to { opacity: 1; transform: none; } }
    .qc-ai-dots { display: inline-flex; gap: 2px; margin-left: 1px; }
    .qc-ai-dots i {
      width: 3px; height: 3px; border-radius: 50%; background: #a672ff;
      display: inline-block; animation: aiDot 1.2s infinite ease-in-out both;
    }
    .qc-ai-dots i:nth-child(2) { animation-delay: 0.18s; }
    .qc-ai-dots i:nth-child(3) { animation-delay: 0.36s; }
    @keyframes aiDot { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
    .quick-commit-success {
      flex-basis: 100%;
      display: inline-flex; align-items: center; gap: 4px;
      min-width: 0; padding: 1px 4px 0;
      color: var(--po-success, #3fb950); font-size: 0.66rem;
    }
    .quick-commit-success span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .quick-commit-success iconify-icon { flex-shrink: 0; }
    .quick-commit-icon, .quick-commit-go {
      display: inline-flex; align-items: center; gap: 3px;
      height: 22px; border: none; border-radius: var(--po-radius-sm, 6px);
      background: transparent; color: var(--po-text-secondary);
      cursor: pointer; flex-shrink: 0;
      transition: background var(--po-duration-fast, 100ms), color var(--po-duration-fast, 100ms);
    }
    .quick-commit-icon { width: 22px; justify-content: center; }
    .quick-commit-icon:hover:not(:disabled) { background: var(--po-bg-3); color: var(--po-text-primary); }
    .quick-commit-go {
      padding: 0 8px; gap: 5px;
      background: var(--po-bg-3); color: var(--po-text-secondary);
      border: 1px solid var(--po-border-subtle);
      font-size: 0.66rem; font-weight: 500;
      /* Content-driven overflow guard: with 3-digit counts (+110 ✎134) the inner
         spans used to be wider than the flex-shrunk button and, being centered,
         spilled out on BOTH sides — the check icon slid under the AI wand and the
         "134" glued itself to the push arrow. The button now clips, the icon and
         the colored breakdown never shrink, and only the verbose label gives way
         (ellipsis → nothing) before the sidebar-width container queries kick in. */
      overflow: hidden;
    }
    .quick-commit-go > iconify-icon { flex-shrink: 0; }
    .quick-commit-go:hover:not(:disabled) { background: var(--po-bg-4, var(--po-bg-3)); color: var(--po-text-primary); border-color: var(--po-border, var(--po-border-subtle)); }
    .quick-commit-icon:disabled, .quick-commit-go:disabled { opacity: 0.45; cursor: not-allowed; }
    .quick-commit-label { white-space: nowrap; flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .quick-commit-counts { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; font-variant-numeric: tabular-nums; font-weight: 600; }
    .qc-count { display: inline-flex; align-items: center; gap: 1px; }
    .qc-count iconify-icon { flex-shrink: 0; }
    .qc-count.qc-added { color: var(--po-success, #2ecc71); }
    .qc-count.qc-modified { color: var(--po-warning, #f1c40f); }
    .qc-count.qc-deleted { color: var(--po-danger, #e74c3c); }
    .quick-commit-count { font-variant-numeric: tabular-nums; }

    /* ===== Light theme overrides — the dark theme's indigo/violet pastels do not hold up on a light background.
       Scoped to [data-bs-theme="light"]: dark is NOT touched. ===== */
    :host-context([data-bs-theme="light"]) .boost-chip.squad-chip,
    :host-context([data-bs-theme="light"]) .intent-cta { color: #4338ca; }
    :host-context([data-bs-theme="light"]) .boost-chip.squad-chip iconify-icon,
    :host-context([data-bs-theme="light"]) .intent-cta iconify-icon { color: #4f46e5; }
    :host-context([data-bs-theme="light"]) .intent-cta-title { color: #3730a3; }
    :host-context([data-bs-theme="light"]) .boost-chip.active,
    :host-context([data-bs-theme="light"]) .boost-chip.active iconify-icon,
    :host-context([data-bs-theme="light"]) .icon-chip:hover,
    :host-context([data-bs-theme="light"]) .icon-chip.active,
    :host-context([data-bs-theme="light"]) .config-extensions-row.has-selection .config-label { color: #7c3aed; }
    :host-context([data-bs-theme="light"]) .tool-btn:hover:not(:disabled) { color: #4f46e5; }
    :host-context([data-bs-theme="light"]) .provider-menu-check,
    :host-context([data-bs-theme="light"]) .tool-btn.resume-btn,
    :host-context([data-bs-theme="light"]) .tool-btn.account-btn { color: #4f46e5; }
    :host-context([data-bs-theme="light"]) .tool-btn.resume-btn:hover:not(:disabled),
    :host-context([data-bs-theme="light"]) .tool-btn.account-btn:hover:not(:disabled),
    :host-context([data-bs-theme="light"]) .tool-btn.account-btn.account-btn-active { color: #4338ca; }
    :host-context([data-bs-theme="light"]) .tool-btn.todo-btn { color: #059669; }
    :host-context([data-bs-theme="light"]) .tool-btn.todo-btn:hover:not(:disabled) { color: #047857; }

  `,
})
export class ActionCenterComponent implements OnInit, OnDestroy {
  private orgPolicy = inject(OrgPolicyService);
  composerOnly = input(false);
  interactions = input<Interaction[]>([]);
  /** True while the parent is showing the per-pane selection overlay.
   *  When true, the sidebar replaces the Auto-Approve button with the
   *  Enable/Cancel/Apply controls so the user finishes the flow in the
   *  same place they started. */
  aaSelectMode = input<boolean>(false);
  /** Selection progress: terminals already picked and total available.
   *  Shown as "N / T terminals" in the inline selection header so the
   *  user can tell at a glance how many sub-agents still need a mode. */
  aaPickedCount = input<number>(0);
  aaTotalCount = input<number>(0);

  onApprove = output<string>();
  onDeny = output<string>();
  onRespond = output<{ interactionId: string; value: string }>();
  onFocusTerminal = output<void>();
  onCollapsedChange = output<boolean>();
  /** Emitted when user wants to enable auto-approve — parent opens the graphic
   *  terminal-selection overlay to pick which terminals should receive it. */
  onRequestAutoApproveSelection = output<void>();
  /** Emitted when the user confirms the selection from the sidebar bar. */
  onConfirmAutoApproveSelection = output<void>();
  /** Emitted when the user cancels the selection from the sidebar bar. */
  onCancelAutoApproveSelection = output<void>();
  /** Emitted when the user clicks on an active sub-agent card to open/focus it. */
  onSelectSubAgent = output<SubAgent>();
  /** Emitted when the user clicks the Intent launcher above the mode selector. */
  onOpenIntent = output<void>();
  /** Emitted from the quick-commit bar to open the full Git Explorer (parent opens the modal). */
  onOpenGitExplorer = output<void>();
  /** Emitted from the spawn toolbar to open the TODO list (parent owns the modal). */
  onOpenTodos = output<void>();

  /** ID of the currently focused sub-agent tab (passed by parent to highlight active card). */
  activeSubAgentId = input<string | null>(null);

  /**
   * Roster of the on-screen panes, demoted main included (the parent's
   * `paneRoster()`). The column must show the same tiles as the terminals: if the
   * main is in the roster it must be listed here too. Empty ⇒ fallback to the plain list
   * of real sub-agents (composer-only / uses without a parent).
   */
  roster = input<SubAgent[]>([]);
  /** Effective list of the "Active" section: the parent's roster or fallback. */
  activeAgents = computed<SubAgent[]>(() => {
    const r = this.roster();
    return r.length > 0 ? r : this.subAgentService.activeRoster();
  });
  /** The main tile is not a sub-agent: no bench/destroy on the backend. */
  isMainPane(id: string): boolean {
    return id === '__main__';
  }
  /** Emitted when a tile is closed: the parent redirects the main to dismiss. */
  onCloseAgent = output<SubAgent>();

  /**
   * Parent-driven collapsed state. The parent persists this in localStorage /
   * per-session viewState and restores it on app reload. We mirror it into a
   * local signal so toggleCollapse() can flip it optimistically and emit the
   * new value back via onCollapsedChange — keeping the two in sync avoids the
   * "wrapper collapsed but inner content rendered full-size" desync that made
   * the panel look squished after an update.
   */
  collapsedInput = input<boolean>(false, { alias: 'collapsed' });
  collapsed = signal(this.collapsedInput());
  private _collapsedSyncEffect = effect(() => this.collapsed.set(this.collapsedInput()));

  /**
   * Current panel width in px, driven by the parent's resize handle (200–600).
   * Accordion headers drop their secondary badges below NARROW_PANEL_PX so the
   * title keeps its room — the dropped values stay visible inside the panels.
   */
  panelWidth = input<number>(320);
  private readonly NARROW_PANEL_PX = 300;
  narrowPanel = computed(() => this.panelWidth() < this.NARROW_PANEL_PX);
  editMode = signal(false);
  slotsHeight = signal(240);
  slotsCollapsed = signal(true);
  quickAgentsCollapsed = signal(true);
  quickAgentsHeight = signal(260);
  private slotsExpandedHeight = 240;
  private qaExpandedHeight = 260;

  // Provider Usage
  usageOpen = signal(false);
  usageLoading = signal(false);
  providerUsage = signal<ProviderUsageSnapshot | null>(null);
  usageError = signal<ProviderUsageProbeError | null>(null);
  private usageSub: { unsubscribe: () => void } | null = null;

  /** Usage accordion only for claude-code-cli sessions. */
  isClaudeCodeSession = computed(() => this.activeSession()?.provider === 'claude-code-cli');

  /** Gemini renders session-activity metrics instead of quota bars. */
  isGeminiSession = computed(() => this.activeSession()?.provider === 'gemini-cli');

  /**
   * Providers whose usage/activity can be surfaced. Claude/Codex/Gemini
   * via CLI probe; Copilot/Cursor/OpenCode via token-based fallback
   * (TokenTracker stats rendered as activity rows).
   */
  isUsageSupportedSession = computed(() => {
    const p = this.usageProvider();
    return p === 'claude-code-cli'
      || p === 'codex'
      || p === 'gemini-cli'
      || p === 'copilot'
      || p === 'cursor'
      || p === 'opencode';
  });

  /** Activity metrics for providers that don't expose quota (Gemini + token-based). */
  activityMetrics = computed<ActivityMetrics | null>(() => {
    const pu = this.providerUsage();
    return pu?.activityMetrics ?? null;
  });

  /**
   * True when the snapshot carries token fields populated by the backend's
   * token-based fallback (Copilot/Cursor/OpenCode). Used by the template
   * to render a token-stats card instead of Gemini's timing card.
   */
  hasTokenActivity = computed(() => {
    const m = this.activityMetrics();
    return !!m && m.source === 'token-tracker';
  });

  /** Sanitized usage sections — strips TUI block chars and formats dates. */
  usageSections = computed(() => {
    const pu = this.providerUsage();
    if (!pu?.sections?.length) return [];
    return pu.sections.map(s => ({
      label: this.sanitizeUsageText(s.label),
      pct: s.percentUsed,
      resets: this.formatUsageResets(s.resetsLabel),
    }));
  });

  /**
   * Compact token counts for the bar/cards. 1234 → "1.2K", 1_500_000 → "1.5M".
   * Same shape as the dashboard's existing token formatter.
   */
  formatTokenCount(n: number | null | undefined): string {
    if (n == null || isNaN(n)) return '0';
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(Math.round(n));
  }

  private sanitizeUsageText(text: string): string {
    if (!text) return '';
    return text
      .replace(/[█▌▐░▒▓▏▎▍▋▊▉■□▪▫─│┌┐└┘├┤┬┴┼╭╮╯╰]+/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  private formatUsageResets(text: string): string {
    if (!text) return '';
    let r = this.sanitizeUsageText(text);
    // Remove timezone "(Europe/Rome)" etc.
    r = r.replace(/\s*\([^)]*\)\s*/g, '');
    // "Apr 19 at 10pm" → "Apr 19, 10pm"
    r = r.replace(/\s+at\s+/i, ', ');
    // Strip trailing noise from other sections
    r = r.split(/(?:Current|Extra|Esc)/i)[0].trim();
    if (!r) return '';

    const countdown = this.computeResetCountdown(r);
    return countdown ? `Resets ${r} (${countdown})` : `Resets ${r}`;
  }

  /**
   * Parse a formatted reset date/time into a Date object.
   * Handles both full dates ("Apr 19, 10pm") and time-only ("10pm", "10:30pm")
   * for current-session resets that happen within the same day.
   */
  private parseResetDate(dateStr: string): Date | null {
    const months: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };

    const now = new Date();

    // Try full date+time: "Apr 19, 10pm" / "Apr 19, 10:30pm" / "Apr 19"
    const fullMatch = dateStr.match(/([A-Za-z]{3})\s+(\d{1,2})(?:,?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/i);
    if (fullMatch) {
      const month = months[fullMatch[1].toLowerCase()];
      if (month !== undefined) {
        const day = parseInt(fullMatch[2], 10);
        let hour = fullMatch[3] ? parseInt(fullMatch[3], 10) : 0;
        const minute = fullMatch[4] ? parseInt(fullMatch[4], 10) : 0;
        const ampm = fullMatch[5]?.toLowerCase();
        if (ampm === 'pm' && hour < 12) hour += 12;
        if (ampm === 'am' && hour === 12) hour = 0;

        const result = new Date(now.getFullYear(), month, day, hour, minute);
        if (result.getTime() < now.getTime() - 60_000) {
          result.setFullYear(now.getFullYear() + 1);
        }
        return result;
      }
    }

    // Fallback: time-only "10pm", "10:30pm", "8am" — assume today (or tomorrow if past)
    const timeMatch = dateStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (timeMatch) {
      let hour = parseInt(timeMatch[1], 10);
      const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const ampm = timeMatch[3].toLowerCase();
      if (ampm === 'pm' && hour < 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;

      const result = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
      // If the time already passed today, it means tomorrow
      if (result.getTime() < now.getTime() - 60_000) {
        result.setDate(result.getDate() + 1);
      }
      return result;
    }

    return null;
  }

  /** Compute a human-readable countdown like "in 3h 20m" from a reset date string. */
  private computeResetCountdown(dateStr: string): string {
    const target = this.parseResetDate(dateStr);
    if (!target) return '';

    const diff = target.getTime() - Date.now();
    if (diff <= 0) return '';

    const totalMinutes = Math.floor(diff / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours > 0 && minutes > 0) return `in ${hours}h ${minutes}m`;
    if (hours > 0) return `in ${hours}h`;
    if (minutes > 0) return `in ${minutes}m`;
    return 'in <1m';
  }

  private usageLoadingTimer: ReturnType<typeof setTimeout> | null = null;
  private usageMinLoadingUntil = 0;
  private usageErrorSub: { unsubscribe: () => void } | null = null;

  /** Provider of the active session — memoized so status/name churn doesn't re-run the usage effect. */
  activeSessionProvider = computed(() => this.activeSession()?.provider ?? null);
  /** Provider whose limits the usage panel shows: the composer chip (what the
   * NEXT spawn will use) wins over the session's own provider, so picking Codex
   * on a Claude session shows Codex's bars — the chip no longer rewrites
   * session.provider, so following the session alone kept showing Claude. */
  usageProvider = computed(() => (this.activeSession() ? (this.newAgentProvider() as string) : null) ?? this.activeSessionProvider());
  /** Last (sessionId, provider) the usage effect ran for — detects a provider switch on the same session. */
  private usageLastSessionId: string | null = null;
  private usageLastProvider: string | null = null;
  private usageSwitchTimer: ReturnType<typeof setTimeout> | null = null;
  /** A snapshot younger than this is shown instantly on provider switch (matches the desktop probe cache TTL). */
  private static readonly USAGE_CACHE_TTL_MS = 5 * 60_000;
  /** Re-probe delay after a provider switch: lets the composer settle (and a mis-click revert) before spawning the CLI. */
  private static readonly USAGE_SWITCH_REPROBE_MS = 2500;

  private usageEffect = effect((onCleanup) => {
    const id = this.activeSessionId();
    const supported = this.isUsageSupportedSession();
    const provider = this.usageProvider();
    // Same session, different provider → the composer chip was switched.
    const providerSwitched = !!id && id === this.usageLastSessionId
      && !!this.usageLastProvider && !!provider && provider !== this.usageLastProvider;
    this.usageLastSessionId = id;
    this.usageLastProvider = provider;
    if (this.usageSub) { this.usageSub.unsubscribe(); this.usageSub = null; }
    if (this.usageErrorSub) { this.usageErrorSub.unsubscribe(); this.usageErrorSub = null; }
    if (this.usageLoadingTimer) { clearTimeout(this.usageLoadingTimer); this.usageLoadingTimer = null; }
    if (this.usageSwitchTimer) { clearTimeout(this.usageSwitchTimer); this.usageSwitchTimer = null; }
    onCleanup(() => {
      if (this.usageSwitchTimer) { clearTimeout(this.usageSwitchTimer); this.usageSwitchTimer = null; }
    });
    // Reset manual-refresh cooldown when switching sessions so the new
    // session's usage panel starts with an unlocked button.
    this.usageRefreshLockSec.set(0);
    this.clearRefreshTick();
    if (id && supported && provider) {
      this.usageError.set(null);
      // Last known bars for this provider (any session, < 5 min): show them
      // right away so a switch back is instant; the probe below refreshes.
      const cached = this.freshCachedUsageFor(provider);
      if (cached) {
        this.providerUsage.set({ ...cached, sessionId: id });
        this.usageLoading.set(false);
      } else {
        this.providerUsage.set(null);
        this.usageLoading.set(true);
      }
      const dispatchProbe = () => this.store.dispatch(probeProviderUsage({ sessionId: id, provider }));
      if (providerSwitched) {
        this.usageSwitchTimer = setTimeout(() => {
          this.usageSwitchTimer = null;
          if (!cached) this.usageLoading.set(true);
          dispatchProbe();
        }, ActionCenterComponent.USAGE_SWITCH_REPROBE_MS);
      } else {
        dispatchProbe();
      }
      this.usageSub = this.store.select(getProviderUsage(id)).subscribe(u => {
        // The store entry is keyed by session: right after a switch it still
        // holds the previous provider's bars — never show them as the new one's.
        if (u && u.provider !== provider) return;
        if (u) this.providerUsage.set(u);
        if (u) {
          const remain = this.usageMinLoadingUntil - Date.now();
          const finish = () => {
            this.usageLoading.set(false);
            this.usageError.set(null);
            if (this.usageLoadingTimer) { clearTimeout(this.usageLoadingTimer); this.usageLoadingTimer = null; }
          };
          if (remain > 0) {
            setTimeout(finish, remain);
          } else {
            finish();
          }
        }
      });
      this.usageErrorSub = this.store.select(getProviderUsageError(id)).subscribe(err => {
        if (err && err.provider && err.provider !== provider) return;
        this.usageError.set(err);
        if (err) {
          this.usageLoading.set(false);
          if (this.usageLoadingTimer) { clearTimeout(this.usageLoadingTimer); this.usageLoadingTimer = null; }
        }
      });
      // Stop spinner after 30s even if probe fails silently (longer than backend timeout)
      this.usageLoadingTimer = setTimeout(() => {
        if (this.usageLoading()) this.usageLoading.set(false);
      }, 32_000 + (providerSwitched ? ActionCenterComponent.USAGE_SWITCH_REPROBE_MS : 0));
    } else {
      this.providerUsage.set(null);
      this.usageLoading.set(false);
      this.usageError.set(null);
    }
  });

  /** Newest store snapshot for `provider` if younger than the cache TTL, else null. Synchronous (NgRx select emits on subscribe). */
  private freshCachedUsageFor(provider: string): ProviderUsageSnapshot | null {
    let found: ProviderUsageSnapshot | null = null;
    const sub = this.store.select(getLatestProviderUsageForProvider(provider)).subscribe(v => { found = v; });
    sub.unsubscribe();
    const snap = found as ProviderUsageSnapshot | null;
    if (!snap) return null;
    const age = Date.now() - Date.parse(snap.timestamp);
    return Number.isFinite(age) && age >= 0 && age < ActionCenterComponent.USAGE_CACHE_TTL_MS ? snap : null;
  }

  retryUsageProbe(): void {
    const id = this.activeSessionId();
    if (!id || !this.isUsageSupportedSession()) return;
    if (this.usageLoadingTimer) {
      clearTimeout(this.usageLoadingTimer);
      this.usageLoadingTimer = null;
    }
    this.store.dispatch(clearProviderUsageProbeError({ sessionId: id }));
    this.usageError.set(null);
    this.usageLoading.set(true);
    // Same provider the panel shows (the composer chip's): probing the
    // session's own provider returned bars the panel then discarded.
    this.store.dispatch(probeProviderUsage({ sessionId: id, provider: this.usageProvider() ?? undefined, userInitiated: true }));
    this.usageLoadingTimer = setTimeout(() => {
      if (this.usageLoading()) this.usageLoading.set(false);
    }, 32_000);
  }

  /** Cooldown remaining (seconds) for the manual usage refresh button. */
  usageRefreshLockSec = signal(0);
  private usageRefreshTickHandle: ReturnType<typeof setInterval> | null = null;

  /**
   * Manual refresh from the accordion header. Dispatches a fresh probe and
   * locks the button for 3s with a visible countdown to prevent spamming
   * the CLI ephemeral spawn (and to make rate-limit failures less likely
   * for the CLI-based providers).
   */
  manualRefreshUsage(event: Event): void {
    event.stopPropagation();
    if (this.usageRefreshLockSec() > 0) return;

    const id = this.activeSessionId();
    if (!id || !this.isUsageSupportedSession()) return;

    this.store.dispatch(clearProviderUsageProbeError({ sessionId: id }));
    this.usageError.set(null);
    if (this.usageLoadingTimer) { clearTimeout(this.usageLoadingTimer); this.usageLoadingTimer = null; }
    this.usageLoading.set(true);
    this.usageMinLoadingUntil = Date.now() + 700;
    this.store.dispatch(probeProviderUsage({ sessionId: id, provider: this.usageProvider() ?? undefined, userInitiated: true }));
    this.usageLoadingTimer = setTimeout(() => {
      if (this.usageLoading()) this.usageLoading.set(false);
    }, 32_000);

    this.usageRefreshLockSec.set(3);
    this.clearRefreshTick();
    this.usageRefreshTickHandle = setInterval(() => {
      const v = this.usageRefreshLockSec();
      if (v <= 1) {
        this.usageRefreshLockSec.set(0);
        this.clearRefreshTick();
      } else {
        this.usageRefreshLockSec.set(v - 1);
      }
    }, 1000);
  }

  private clearRefreshTick(): void {
    if (this.usageRefreshTickHandle) {
      clearInterval(this.usageRefreshTickHandle);
      this.usageRefreshTickHandle = null;
    }
  }
  showPromptPicker = signal(false);
  noSessionToast = signal(false);
  runningSlotId = signal<number | null>(null);
  editingSlotId = signal<number | null>(null);
  editingBody = signal('');

  /** Computed: flags for the currently active session. */
  activeSessionFlags = computed(() => {
    const sessionId = this.activeSessionId();
    if (!sessionId) return { modal: false, quick: false, ai: false };
    // Read the signal directly so Angular tracks the dependency
    const allFlags = this.interactionService.sessionFlags();
    return allFlags.get(sessionId) ?? { modal: false, quick: false, ai: false };
  });

  /** Computed: is any auto-approve flag active on the active session OR any
   *  of its sub-agents? Mirrors the "group" semantics of toggleAutoApprove(OFF),
   *  which already clears flags across main + all active sub-agents. Without
   *  this, turning AA on from a sub-agent's per-pane toggle would leave the
   *  top bar stuck on "Off". */
  isActiveSessionAutoApproved = computed(() => {
    const f = this.activeSessionFlags();
    if (f.quick || f.ai) return true;
    for (const sa of this.subAgentService.activeSubAgents()) {
      if (sa.sessionId && this.interactionService.isAutoApproved(sa.sessionId)) return true;
    }
    return false;
  });

  /** Computed: is the AI currently generating a response for the active session? */
  isActiveSessionThinking = computed(() => {
    const sessionId = this.activeSessionId();
    if (!sessionId) return false;
    return this.interactionService.thinkingSessions().has(sessionId);
  });

  private store = inject(Store);
  private voiceAgent = inject(VoiceAgentService);
  private desktopSessionApi = inject(DesktopSessionApiService);
  private providerSwitch = inject(ProviderSwitchService);
  private providerLimit = inject(ProviderLimitService);
  private sessionService = inject(SessionService);
  /** Plugin runtime (desktop app only): plugin buttons appear only if it exists. */
  protected pluginRuntime = inject(PluginRuntimeService);
  /** Integrated plugins that can be turned off from Plugins: AI Squad, Goal, Worker. */
  protected builtins = inject(BuiltinPluginsService);
  /**
   * Composer row 2 (AI Squad · Goal · Worker · `runtime` plugin buttons):
   * disappears with its divider when no chip is visible, otherwise an
   * empty strip would remain above the input.
   */
  protected runtimeRowVisible = computed(() =>
    this.builtins.isOn('ai-squad')
    || (this.goalSupported && this.builtins.isOn('goal'))
    || this.builtins.isOn('worker')
    || (this.pluginRuntime.available && this.pluginRuntime.sessionButtons().some((b) => (b.button.place ?? 'terminal') === 'runtime')));
  protected subAgentService = inject(SubAgentService);
  protected interactionService = inject(InteractionService);
  private historyService = inject(SessionHistoryService);
  protected slotService = inject(ActionSlotService);
  protected deletingSlotId = signal<number | null>(null);
  private slotAlerts = inject(SwalService);
  private smartActions = inject(SmartActionService);
  private modalService = inject(NgbModal);
  protected providerAccountsService = inject(ProviderAccountsService);
  private translateService = inject(TranslateService);
  protected ff = inject(FeatureFlagService);
  protected ecoService = inject(EcoModeService);
  private intentService = inject(IntentService);
  private assetsService = inject(SessionAssetsService);
  protected git = inject(GitService);
  protected gitSettings = inject(GitSettingsService);

  private quickActionsPanel = viewChild<ElementRef<HTMLElement>>('quickActionsPanel');

  constructor() {
    let editingContext: string | null = null;
    effect(() => {
      const key = this.slotService.context()?.key ?? null;
      if (key !== editingContext) {
        editingContext = key;
        untracked(() => { this.cancelEditing(); this.showPromptPicker.set(false); });
      }
    });
    effect((onCleanup) => {
      const addedId = this.slotService.lastAddedSlotId();
      const panel = this.quickActionsPanel()?.nativeElement;
      if (addedId === null || !panel || !panel.getClientRects().length) return;
      const style = getComputedStyle(panel);
      const accent = style.getPropertyValue('--po-info').trim() || '#58a6ff';
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const animation = panel.animate(
        reducedMotion
          ? [{ borderColor: accent }, { borderColor: accent }]
          : [{ borderColor: style.borderColor }, { borderColor: accent }, { borderColor: style.borderColor }],
        { duration: reducedMotion ? 1200 : 650, iterations: reducedMotion ? 1 : 2, easing: 'ease-in-out' },
      );
      animation.finished.then(() => {
        if (this.slotService.lastAddedSlotId() === addedId) this.slotService.lastAddedSlotId.set(null);
      }, () => {});
      onCleanup(() => animation.cancel());
    });

    // Provider-limit modal → "from now on spawn with X": move the composer chip.
    effect(() => {
      const next = this.providerLimit.preferredSpawnProvider();
      if (!next) return;
      this.providerLimit.preferredSpawnProvider.set(null);
      void this.onSpawnProviderChange(next);
    });
    // Keep the minimal quick-commit bar fed even when the full git panel is
    // collapsed. Multi-repo workspaces (root not a repo, repos one level down)
    // resolve to the last repo picked here or in the Git Explorer.
    effect(() => {
      const root = this.activeWorkspacePathValue();
      if (root) void this.git.scopeToWorkspace(root);
    });
  }

  /** cwd for the quick git ops: the repo selected for multi-repo workspaces,
   *  else the workspace root itself. */
  private gitCwd(): string | null {
    return this.git.effectiveCwd() ?? this.activeWorkspacePathValue() ?? null;
  }

  /** Repo picked from the quick-commit dropdown (multi-repo workspace). */
  onQuickRepoSwitch(path: string): void {
    if (path) this.git.selectRepo(path);
  }

  /** Quick git commit (minimal bar above the spawn input). Stages ALL changes
   *  (matching the count badge) and commits — the bar has no per-file selection. */
  quickCommit(): void {
    const cwd = this.gitCwd();
    if (cwd && this.git.commitMessage().trim() && !this.git.committing()) this.git.commitAll(cwd);
  }

  /** Enter in the quick-commit field commits, except while an IME (Japanese,
   *  Chinese, Korean…) is composing: there Enter confirms the candidate. */
  onQuickCommitEnter(event: KeyboardEvent): void {
    if (isImeComposing(event)) return;
    event.preventDefault();
    this.quickCommit();
  }

  /** Generate an AI commit message for the active session's repo. */
  quickGenerateMessage(): void {
    const cwd = this.gitCwd();
    const provider = this.activeSession()?.provider;
    if (cwd && provider && !this.git.generatingMessage()) this.git.generateCommitMessage(cwd, provider);
  }

  /** Push to remote for the active session's repo. */
  quickPush(): void {
    const cwd = this.gitCwd();
    if (cwd) this.git.push(cwd);
  }

  /** One-click AI Resolver from the quick-commit bar — same safe flow as the git
   *  explorer's sync-error resolver (inspect, back up local work, fetch, merge,
   *  resolve conflicts; never reset or force-push). Reuses the shared GitService
   *  signals so the live phase + checked-step log render identically here. */
  aiResolveQuick(): void {
    const cwd = this.gitCwd();
    if (!cwd || this.git.aiResolving()) return;
    const op: 'pull' | 'push' | 'auto' =
      this.git.pulling() ? 'pull'
      : this.git.pushing() ? 'push'
      : 'auto';
    const lastError = this.git.syncError() || this.git.commitError() || undefined;
    const provider = this.activeSession()?.provider ?? 'claude-code-cli';
    this.git.aiResolveSync(cwd, op, provider as any, lastError);
  }

  /** Re-read git status for the active repo. Fired when the user focuses the
   *  quick-commit input so the change count is fresh at the moment of intent.
   *  The bar is always visible while a repo is detected (so Push stays reachable
   *  after a commit), but the count only auto-refreshes on workspace switch — so
   *  we top it up on focus. */
  quickRefresh(): void {
    const cwd = this.gitCwd();
    if (cwd) this.git.refresh(cwd);
  }

  /** Image attach: uploads into .promptops-assets/ and inserts the path. */
  attachingImage = signal(false);

  @ViewChild('imageFileInput') private imageFileInputRef?: ElementRef<HTMLInputElement>;

  /** Open the hidden file picker (attach button next to Spawn). */
  triggerImageAttach(): void {
    this.imageFileInputRef?.nativeElement.click();
  }

  /**
   * Upload picked image(s) into the session assets folder, then insert their
   * .promptops-assets/<name> path(s) at the caret — same link format the assets
   * panel produces when you select a file there.
   */
  async onAttachImagesSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []).filter(f => f.type.startsWith('image/'));
    input.value = ''; // allow re-picking the same file later
    await this.uploadAndInsertAssets(files);
  }

  /**
   * Paste handler on the prompt textarea: if the clipboard carries files
   * (pasted image or file), upload them into assets and insert the path —
   * same flow as the attach button. Plain-text pastes fall through untouched.
   */
  onPromptPaste(event: ClipboardEvent): void {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) {
      // Text paste: the native (input) event sometimes doesn't fire (native
      // paste), leaving newAgentPrompt() stale so the spawn button stays
      // disabled. Sync the signal from the DOM after the paste settles.
      const el = event.target as HTMLTextAreaElement;
      this._promptDirtyForSession = this.activeSessionId();
      queueMicrotask(() => {
        this._promptDirtyForSession = this.activeSessionId();
        this.newAgentPrompt.set(el.value);
        this.autoGrowTextarea(el);
      });
      return;
    }
    event.preventDefault();
    event.stopPropagation(); // don't let the panel-level window:paste re-upload
    void this.uploadAndInsertAssets(files);
  }

  /** Shared: upload files into .promptops-assets/ and insert their paths. */
  private async uploadAndInsertAssets(files: File[]): Promise<void> {
    const ws = this.activeWorkspacePathValue();
    if (files.length === 0 || !ws) return;

    this.attachingImage.set(true);
    try {
      const uploaded = await this.assetsService.uploadFiles(ws, files);
      const paths = uploaded.map(a => a.relativePath).join(' ');
      if (paths) this.insertAtPromptCaret(paths);
    } catch {
      // upload failed — leave the prompt untouched
    } finally {
      this.attachingImage.set(false);
    }
  }

  /** Insert text at the textarea caret (or append), keeping focus + caret sane. */
  private insertAtPromptCaret(text: string): void {
    const el = this.promptTextareaRef?.nativeElement;
    const cur = this.newAgentPrompt();
    if (!el) {
      this.newAgentPrompt.set(cur ? `${cur} ${text}` : text);
      return;
    }
    const start = el.selectionStart ?? cur.length;
    const end = el.selectionEnd ?? cur.length;
    const needsSpaceBefore = start > 0 && !/\s$/.test(cur.slice(0, start));
    const chunk = `${needsSpaceBefore ? ' ' : ''}${text} `;
    const next = cur.slice(0, start) + chunk + cur.slice(end);
    this.newAgentPrompt.set(next);
    queueMicrotask(() => {
      const pos = start + chunk.length;
      el.focus();
      el.setSelectionRange(pos, pos);
      this.autoGrowTextarea(el);
    });
  }

  // Enhance prompt state (magic wand on spawn textarea)
  enhancing = signal(false);
  showEnhanceDepthPicker = signal(false);
  enhanceDepthOptions: { value: EnhanceDepth; labelKey: string; hintKey: string; icon: string }[] = [
    { value: 'short', labelKey: 'SESSIONS.INTENT.Depth short', hintKey: 'SESSIONS.INTENT.Depth short hint', icon: 'solar:minimize-square-bold-duotone' },
    { value: 'medium', labelKey: 'SESSIONS.INTENT.Depth medium', hintKey: 'SESSIONS.INTENT.Depth medium hint', icon: 'solar:magic-stick-3-bold-duotone' },
    { value: 'strong', labelKey: 'SESSIONS.INTENT.Depth strong', hintKey: 'SESSIONS.INTENT.Depth strong hint', icon: 'solar:stars-bold-duotone' },
  ];

  onEnhanceSpawnClick(event: MouseEvent): void {
    event.stopPropagation();
    if (!this.newAgentPrompt().trim() || this.enhancing()) return;
    this.showEnhanceDepthPicker.update(v => !v);
  }

  @HostListener('document:click')
  closeEnhanceDepthPicker(): void {
    this.effortMenuOpen.set(false);
    if (this.showEnhanceDepthPicker()) {
      this.showEnhanceDepthPicker.set(false);
    }
    if (this.providerMenuOpen()) {
      this.providerMenuOpen.set(false);
    }
    if (this.modeMenuOpen()) {
      this.modeMenuOpen.set(false);
    }
    if (this.modelMenuOpen()) {
      this.modelMenuOpen.set(false);
    }
  }

  async runEnhanceSpawn(depth: EnhanceDepth): Promise<void> {
    const prompt = this.newAgentPrompt().trim();
    if (!prompt || this.enhancing()) return;
    this.showEnhanceDepthPicker.set(false);
    this.enhancing.set(true);
    try {
      const [result] = await Promise.all([
        this.intentService.enhancePrompt(prompt, this.newAgentProvider(), undefined, undefined, depth),
        new Promise(r => setTimeout(r, 600)),
      ]);
      this.newAgentPrompt.set(result);
    } finally {
      this.enhancing.set(false);
      // Refocus textarea so the user can press Enter to spawn immediately.
      // Delay lets Angular remove [disabled] binding before focus().
      setTimeout(() => {
        const el = this.promptTextareaRef?.nativeElement;
        if (!el) return;
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }, 0);
    }
  }

  private static readonly PROVIDER_LOGO: Record<string, string> = {
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
    'generic-shell': 'assets/providers/terminal.svg',
  };
  private static readonly PROVIDER_LABEL: Record<string, string> = {
    'claude-code-cli': 'Claude Code',
    'codex': 'Codex',
    'gemini-cli': 'Gemini CLI',
    'antigravity': 'Antigravity',
    'copilot': 'GitHub Copilot',
    'cursor': 'Cursor',
    'grok': 'Grok',
    'hermes': 'Hermes',
    'muse': 'Muse Code',
    'zai': 'Z.AI',
    'kimi': 'Kimi',
    'opencode': 'Opencode',
    'kora': 'Kora',
    'generic-shell': 'Shell',
  };
  getProviderLogo(provider: string): string {
    return ActionCenterComponent.PROVIDER_LOGO[provider] ?? 'assets/providers/terminal.svg';
  }
  getProviderLabel(provider: string): string {
    return ActionCenterComponent.PROVIDER_LABEL[provider] ?? 'Shell';
  }

  /** Providers offered by the spawn dropdown (value + i18n label). */
  /** Spawn choices, narrowed by the organization policy (Enterprise). */
  get spawnProviderList(): ReadonlyArray<{ value: string; labelKey: string }> {
    return this.orgPolicy.filterProviders(SPAWN_PROVIDERS, (p) => p.value);
  }

  /** Open/closed state of the custom provider dropdown. */
  readonly providerMenuOpen = signal(false);

  toggleProviderMenu(event: MouseEvent): void {
    this.effortMenuOpen.set(false);
    event.stopPropagation();
    this.modeMenuOpen.set(false);
    this.modelMenuOpen.set(false);
    this.providerMenuOpen.update(v => !v);
  }

  selectProvider(value: string): void {
    void this.onSpawnProviderChange(value);
    this.providerMenuOpen.set(false);
  }

  activeSessionId = toSignal(this.store.select(getActiveSessionId), { initialValue: null });
  activeSession = toSignal(this.store.select(getActiveSession), { initialValue: null });
  slots = this.slotService.slots;
  selectedQuickSlotId = this.slotService.selectedSlotId;
  selectedQuickSlot = computed(() =>
    this.slots().find(slot => slot.id === (this.editingSlotId() ?? this.selectedQuickSlotId())) ?? this.slots()[0] ?? null
  );

  selectQuickSlot(value: string): void {
    this.selectedQuickSlotId.set(Number(value));
  }

  // Sub-agent form
  newAgentPrompt = signal('');
  newAgentProvider = signal<SpawnProviderId>('claude-code-cli');
  /** Provider-account override for the next spawn. undefined = inherit, null = opt-out, string = specific id. */
  newAgentAccountId = signal<string | null | undefined>(undefined);

  /** Switchable launch models per provider — shared with the terminal model badge. */
  /** Model override for the next spawn. null = provider default (Auto). */
  newAgentModel = signal<string | null>(null);
  /** Last model picked per provider, persisted so the pick survives provider
   * switches and app restarts. Keyed by provider: recalling NEVER leaks a
   * model into a different provider's picker. */
  // Persistence lives in SpawnSelectionService: the chip is the app-wide
  // reference for "which provider/model do I launch with" (board, prompt
  // library, feedback, voice all read it) — there is no per-session default.
  private spawnSelection = inject(SpawnSelectionService);
  private rememberModel(provider: string, id: string | null): void {
    this.spawnSelection.rememberModel(provider, id);
  }
  /** Remembered model for this provider, validated against its own model list. */
  private recallModel(provider: string): string | null {
    return this.spawnSelection.recallModel(provider);
  }
  /** Last provider picked on the composer chip, persisted so the spawn input
   * reopens (session switch, app restart) on the user's last choice — and,
   * through recallModel(), on the model remembered for THAT provider. Only a
   * pick that passed the CLI-availability check is remembered. */
  private rememberProvider(provider: string): void {
    this.spawnSelection.setProvider(provider);
  }
  /** Remembered provider (validated by the service against the chip's option list). */
  private recallProvider(): SpawnProviderId | null {
    return untracked(() => this.spawnSelection.provider()) as SpawnProviderId | null;
  }
  readonly effortMenuOpen = signal(false);
  toggleEffortMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.modelMenuOpen.set(false);
    this.providerMenuOpen.set(false);
    this.modeMenuOpen.set(false);
    this.effortMenuOpen.update(v => !v);
  }
  /** Translation keys for the effort levels (rendered with the translate pipe). */
  readonly effortLabels: Record<string, string> = {
    low: 'SESSIONS.ACTION_CENTER.Effort low',
    medium: 'SESSIONS.ACTION_CENTER.Effort medium',
    high: 'SESSIONS.ACTION_CENTER.Effort high',
    xhigh: 'SESSIONS.ACTION_CENTER.Effort xhigh',
    max: 'SESSIONS.ACTION_CENTER.Effort max',
  };
  readonly effortShortLabels: Record<string, string> = { low: 'L', medium: 'M', high: 'H', xhigh: 'XH', max: 'MAX' };
  readonly effortOptions = computed(() => effortOptions(this.newAgentProvider(), this.newAgentModel()));
  readonly effortRevision = signal(0);
  readonly selectedEffort = computed(() => {
    this.effortRevision();
    return this.spawnSelection.recallEffort(this.newAgentProvider(), this.newAgentModel());
  });
  selectEffort(value: string): void {
    this.spawnSelection.rememberEffort(this.newAgentProvider(), validEffort(this.newAgentProvider(), value, this.newAgentModel()) ?? null);
    this.effortRevision.update(v => v + 1);
    this.effortMenuOpen.set(false);
  }
  readonly modelMenuOpen = signal(false);
  readonly spawnModelOptions = computed(() => spawnModels(this.newAgentProvider()));
  currentModelLabel(): string {
    const id = this.newAgentModel();
    return this.spawnModelOptions().find(m => m.id === id)?.label ?? 'Auto';
  }
  toggleModelMenu(event: MouseEvent): void {
    this.effortMenuOpen.set(false);
    event.stopPropagation();
    this.providerMenuOpen.set(false);
    this.modeMenuOpen.set(false);
    this.modelMenuOpen.update(v => !v);
  }
  selectModel(id: string | null): void {
    this.newAgentModel.set(id);
    this.rememberModel(this.newAgentProvider(), id);
    this.modelMenuOpen.set(false);
  }

  // Static so per-session drafts survive component destruction when the user
  // navigates to another section (e.g. ranking) and comes back.
  private static draftPromptsBySession = new Map<string, string>();
  /** Session id the textarea currently reflects USER input for. Guards the
   * restore below from clobbering a paste/typed value when activeSessionId
   * resolves async after entering a session. */
  private _promptDirtyForSession: string | null = null;
  private syncDraftOnSessionChange = effect(() => {
    const sid = this.activeSessionId();
    const prev = this._prevSessionId;
    // User already typed/pasted into this session's textarea before the change
    // effect flushed — don't overwrite their input with the saved draft.
    if (sid && this._promptDirtyForSession === sid) {
      this._prevSessionId = sid;
      return;
    }
    if (prev && prev !== sid) {
      const txt = this.newAgentPrompt();
      if (txt.trim()) ActionCenterComponent.draftPromptsBySession.set(prev, txt);
      else ActionCenterComponent.draftPromptsBySession.delete(prev);
    }
    this._prevSessionId = sid ?? null;
    if (sid) {
      const saved = ActionCenterComponent.draftPromptsBySession.get(sid) ?? '';
      this.newAgentPrompt.set(saved);
    } else {
      this.newAgentPrompt.set('');
    }
  });
  private _prevSessionId: string | null = null;

  @ViewChild('promptTextarea') private promptTextareaRef?: ElementRef<HTMLTextAreaElement>;

  /** Reactive textarea ref for the @-mention autocomplete (resolved after view init). */
  protected promptTextareaEl = signal<HTMLTextAreaElement | null>(null);

  /** Active workspace path (project root) for fuzzy file lookups in @-mentions.
   * Prefers the path bound to the active session (real cwd of the running terminal);
   * falls back to the active workspace summary if no session is selected. */
  protected activeWorkspaceSummary = toSignal(
    this.store.select(getActiveWorkspace),
    { initialValue: null },
  );
  protected activeWorkspacePathValue = computed(() =>
    this.activeSession()?.workspace?.path ?? this.activeWorkspaceSummary()?.projectPath,
  );

  private syncPromptHeightEffect = effect(() => {
    this.newAgentPrompt();
    queueMicrotask(() => {
      const el = this.promptTextareaRef?.nativeElement;
      if (el) {
        this.autoGrowTextarea(el);
        if (this.promptTextareaEl() !== el) this.promptTextareaEl.set(el);
      }
    });
  });

  /** Enter spawns (Shift+Enter is a new line). While an IME is composing,
   *  Enter only confirms the candidate: spawning there sent half-typed text. */
  onComposerEnter(event: KeyboardEvent): void {
    if (event.shiftKey || isImeComposing(event)) return;
    event.preventDefault();
    void this.spawnFromForm();
  }

  onPromptInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this._promptDirtyForSession = this.activeSessionId();
    this.newAgentPrompt.set(target.value);
    this.autoGrowTextarea(target);
  }

  private autoGrowTextarea(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, 240);
    el.style.height = next + 'px';
  }

  private resetPromptTextareaHeight(): void {
    const el = this.promptTextareaRef?.nativeElement;
    if (el) el.style.height = '';
  }

  // Mode & custom config — restored from localStorage
  private softSkillService = inject(SoftSkillService);
  private savedModeState = ActionCenterComponent.loadModeState();
  selectedMode = signal<SubAgentMode>(this.savedModeState.mode);
  /**
   * Soft skill layered on the selected mode (null = plain mode). The mode
   * stays the base for config + native flags; the skill's instructions are
   * appended to the preamble by the desktop. Stored inline in the mode state
   * so the pick survives even if the skill is later deleted from the list.
   */
  selectedSoftSkill = signal<SoftSkill | null>(this.softSkillService.normalize(this.savedModeState.softSkill ?? {}));
  showCustomConfig = signal(this.savedModeState.custom);
  customReasoningDepth = signal<SubAgentConfig['reasoning_depth']>(this.savedModeState.config.reasoning_depth);
  customVerbosity = signal<SubAgentConfig['verbosity']>(this.savedModeState.config.verbosity);
  customExploration = signal<SubAgentConfig['exploration']>(this.savedModeState.config.exploration);
  customSpeedPriority = signal<SubAgentConfig['speed_priority']>(this.savedModeState.config.speed_priority);
  customRiskTolerance = signal<SubAgentConfig['risk_tolerance']>(this.savedModeState.config.risk_tolerance);

  /**
   * Worker runtime opt-in: sub-agents spawn as a headless turn loop
   * (stream-json, real tokens, native mode flags) instead of a PTY.
   * Providers without a headless mode fall back to interactive.
   */
  workerMode = signal<boolean>(false);

  toggleWorkerMode(): void {
    this.workerMode.set(!this.workerMode());
  }

  /**
   * Goal runtime opt-in: the composer prompt becomes a GOAL and the sub-agent
   * runs unattended — an external loop re-prompts it after every turn with the
   * feedback of an independent evaluator until the goal is reached (or the
   * loop stops on stuck/budget). Implies the worker runtime.
   */
  goalMode = signal<boolean>(false);

  /** Hidden when the running desktop has no goal-loop API (e.g. older builds). */
  readonly goalSupported = !!(window as any).promptops?.getGoalLoopState;

  toggleGoalMode(): void {
    this.goalMode.set(!this.goalMode());
  }

  /** Execution mode forwarded on spawn — undefined keeps the classic PTY path. */
  private spawnExecutionMode(): 'worker' | undefined {
    return this.workerMode() || this.goalMode() ? 'worker' : undefined;
  }

  /**
   * Goal spec forwarded ONLY by spawnFromForm (the free prompt IS the goal) —
   * quick agents and slots keep their classic one-shot behavior. Budgets fall
   * back to the engine defaults (20 iterations, stuck after 3).
   *
   * Worker OFF → `native: true`: the goal rides Claude Code's own `/loop`
   * skill inside an interactive PTY (visible in the terminal, self-evaluated).
   * Worker ON → external engine on the headless worker runtime (HUD, hard
   * budgets). The desktop applies native only to claude-code-cli and falls
   * back to the engine for every other provider.
   */
  private spawnGoalSpec(): { native?: boolean } | undefined {
    if (!this.goalMode() || !this.goalSupported) return undefined;
    return { native: !this.workerMode() };
  }

  private static readonly MODE_STORAGE_KEY = 'promptops:subagent-mode';

  private static loadModeState(): { mode: SubAgentMode; custom: boolean; config: SubAgentConfig; softSkill?: Partial<SoftSkill> } {
    const fallback = { mode: 'sprint' as SubAgentMode, custom: false, config: MODE_PRESETS.sprint.config };
    try {
      const raw = localStorage.getItem(ActionCenterComponent.MODE_STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      if (parsed.mode && MODE_PRESETS[parsed.mode as SubAgentMode]) {
        const softSkill = parsed.softSkill && typeof parsed.softSkill === 'object' ? parsed.softSkill as Partial<SoftSkill> : undefined;
        return {
          mode: parsed.mode,
          custom: !!parsed.custom,
          config: { ...MODE_PRESETS[parsed.mode as SubAgentMode].config, ...(parsed.config ?? {}) },
          ...(softSkill ? { softSkill } : {}),
        };
      }
      return fallback;
    } catch { return fallback; }
  }

  private saveModeState(): void {
    const state = {
      mode: this.selectedMode(),
      custom: this.showCustomConfig(),
      config: this.showCustomConfig() ? {
        reasoning_depth: this.customReasoningDepth(),
        verbosity: this.customVerbosity(),
        exploration: this.customExploration(),
        speed_priority: this.customSpeedPriority(),
        risk_tolerance: this.customRiskTolerance(),
      } : undefined,
      softSkill: this.selectedSoftSkill() ?? undefined,
    };
    localStorage.setItem(ActionCenterComponent.MODE_STORAGE_KEY, JSON.stringify(state));
  }

  /** Exposed for template access (Clean / Plan Only top shortcuts). */
  readonly MODE_PRESETS = MODE_PRESETS;

  readonly modeList: Array<ModePreset & { iconify: string; color: string; hint: string }> = [
    { ...MODE_PRESETS.sprint,    iconify: 'solar:bolt-bold-duotone',              color: '#d29922', hint: 'Fast, minimal reasoning' },
    { ...MODE_PRESETS.architect, iconify: 'solar:buildings-3-bold-duotone',       color: '#db61a2', hint: 'Deep analysis, structured' },
    { ...MODE_PRESETS.detective, iconify: 'solar:magnifer-bug-bold-duotone',      color: '#ffa657', hint: 'Focused investigation' },
    { ...MODE_PRESETS.refactor,  iconify: 'solar:code-bold-duotone',             color: '#3fb950', hint: 'Clean, structured changes' },
    { ...MODE_PRESETS.paranoid,  iconify: 'solar:shield-check-bold-duotone',     color: '#f85149', hint: 'Zero risk, verify all' },
    { ...MODE_PRESETS.minimal,   iconify: 'solar:target-bold-duotone',           color: '#39c5cf', hint: 'Code only, no talk' },
  ];

  /** Full mode list shown in the select dropdown (clean/plan_only as first shortcuts). */
  readonly allModesList: Array<ModePreset & { iconify: string; color: string; hint: string }> = [
    { ...MODE_PRESETS.clean,     iconify: 'solar:magic-stick-3-bold-duotone',     color: '#bc8cff', hint: 'No overrides' },
    { ...MODE_PRESETS.plan_only, iconify: 'solar:clipboard-list-bold-duotone',    color: '#58a6ff', hint: 'Strategy without edits' },
    ...this.modeList,
    { ...MODE_PRESETS.eco,       iconify: 'solar:leaf-bold-duotone',              color: '#3fb950', hint: 'Token-saving, this agent only' },
  ];

  /** Iconify icon for the currently-selected mode / soft skill (drives the chip icon). */
  readonly currentModeIcon = computed<string>(() =>
    this.selectedSoftSkill()?.icon
      ?? this.allModesList.find(m => m.mode === this.selectedMode())?.iconify
      ?? 'solar:settings-minimalistic-bold-duotone'
  );

  /** Brand color for the currently-selected mode (tints the chip icon); soft skills wear the accent violet. */
  readonly currentModeColor = computed<string>(() =>
    this.selectedSoftSkill()
      ? '#a78bfa'
      : (this.allModesList.find(m => m.mode === this.selectedMode())?.color ?? '#bc8cff')
  );

  /** Label of the currently-selected mode / soft skill (shown on the chip trigger). */
  readonly currentModeLabel = computed<string>(() =>
    this.selectedSoftSkill()?.name
      ?? this.allModesList.find(m => m.mode === this.selectedMode())?.label
      ?? 'Mode'
  );

  /** Chip tooltip: "Soft skill · <base mode>" when a skill is active, else the plain mode label. */
  readonly currentModeTooltip = computed<string>(() => {
    const skill = this.selectedSoftSkill();
    const modeLabel = this.allModesList.find(m => m.mode === this.selectedMode())?.label ?? '';
    return skill ? `${skill.name} · ${modeLabel}` : modeLabel;
  });

  /** Open/closed state of the custom mode dropdown. */
  readonly modeMenuOpen = signal(false);

  /** Saved soft skills — listed first in the chip's quick selector. */
  readonly softSkills = this.softSkillService.skills;

  /** Quick selector on the chip: soft skills first, then the built-in modes. */
  toggleModeMenu(event: MouseEvent): void {
    this.effortMenuOpen.set(false);
    event.stopPropagation();
    if (this.showCustomConfig()) return;
    this.providerMenuOpen.set(false);
    this.modeMenuOpen.update(v => !v);
  }

  selectSoftSkillFromMenu(skill: SoftSkill): void {
    this.applySoftSkill(skill);
    this.modeMenuOpen.set(false);
  }

  modeLabelOf(mode: SubAgentMode): string {
    return MODE_PRESETS[mode]?.label ?? mode;
  }

  /**
   * Pen icon next to the chip → Soft skill modal: write/edit a soft skill
   * (foreground) and pick the exact Plugins · Skills · MCP the next sub-agent
   * spawns with. Apply commits both; Cancel discards both.
   */
  async openSoftSkillModal(event?: MouseEvent): Promise<void> {
    event?.stopPropagation();
    this.effortMenuOpen.set(false);
    this.providerMenuOpen.set(false);
    this.modeMenuOpen.set(false);
    const modalRef = this.modalService.open(SoftSkillModalComponent, {
      centered: true,
      size: 'md',
      scrollable: true,
    });
    const comp = modalRef.componentInstance as SoftSkillModalComponent;
    comp.modes = this.allModesList;
    comp.currentMode = this.selectedMode();
    comp.currentSkillId = this.selectedSoftSkill()?.id ?? null;
    comp.provider = this.activeSession()?.provider ?? 'claude-code-cli';
    comp.initialExtensionSelection = this.injectedPayload();
    comp.init();
    try {
      const result: SoftSkillModalResult | undefined = await modalRef.result;
      if (!result) return;
      if (result.clearSkill) {
        this.selectedSoftSkill.set(null);
        this.selectMode(this.selectedMode());
      } else if (result.skill) {
        this.applySoftSkill(result.skill);
      }
      // Extension selection is composer state (same as the Plugins & Skills row).
      this.injectedPayload.set(result.extensionSelection.items.length > 0 ? result.extensionSelection : null);
    } catch {
      // Modal dismissed
    }
  }

  /** Layer a soft skill on its base mode (resets custom config like a mode pick). */
  applySoftSkill(skill: SoftSkill): void {
    this.selectedSoftSkill.set(skill);
    this.showCustomConfig.set(false);
    this.selectMode(skill.baseMode);
  }

  /** Wire payload for the spawn — undefined when a plain mode is selected. */
  private spawnSoftSkill(): SoftSkillPayload | undefined {
    const skill = this.selectedSoftSkill();
    return skill ? this.softSkillService.toPayload(skill) : undefined;
  }

  selectModeFromMenu(mode: SubAgentMode): void {
    this.selectMode(mode);
    this.showCustomConfig.set(false);
    this.modeMenuOpen.set(false);
    // Eco opens the global eco panel so the level can be picked; the mode
    // stays selected either way and only the next sub-agent runs in Eco.
    if (mode === 'eco') this.ecoService.requestOpenModal();
  }

  /**
   * ECO level forwarded on spawn when the composer's Eco mode is selected.
   * Undefined otherwise — the global eco toggle still applies on its own.
   */
  private spawnEcoLevel(): string | undefined {
    return this.selectedMode() === 'eco' ? this.ecoService.level() : undefined;
  }


  /** Sync custom config sliders when mode changes */
  private syncModeEffect = effect(() => {
    const mode = this.selectedMode();
    if (!this.showCustomConfig()) {
      const preset = MODE_PRESETS[mode];
      this.customReasoningDepth.set(preset.config.reasoning_depth);
      this.customVerbosity.set(preset.config.verbosity);
      this.customExploration.set(preset.config.exploration);
      this.customSpeedPriority.set(preset.config.speed_priority);
      this.customRiskTolerance.set(preset.config.risk_tolerance);
    }
  });

  /** Persist custom config changes to localStorage */
  private persistCustomEffect = effect(() => {
    // Read all custom signals to track changes
    this.customReasoningDepth();
    this.customVerbosity();
    this.customExploration();
    this.customSpeedPriority();
    this.customRiskTolerance();
    if (this.showCustomConfig()) {
      this.saveModeState();
    }
  });

  /** Resolved custom config (only meaningful when custom panel is open) */
  resolvedCustomConfig = computed<Partial<SubAgentConfig> | undefined>(() => {
    if (!this.showCustomConfig()) return undefined;
    const preset = MODE_PRESETS[this.selectedMode()].config;
    const custom: Partial<SubAgentConfig> = {};
    if (this.customReasoningDepth() !== preset.reasoning_depth) custom.reasoning_depth = this.customReasoningDepth();
    if (this.customVerbosity() !== preset.verbosity) custom.verbosity = this.customVerbosity();
    if (this.customExploration() !== preset.exploration) custom.exploration = this.customExploration();
    if (this.customSpeedPriority() !== preset.speed_priority) custom.speed_priority = this.customSpeedPriority();
    if (this.customRiskTolerance() !== preset.risk_tolerance) custom.risk_tolerance = this.customRiskTolerance();
    return Object.keys(custom).length > 0 ? custom : undefined;
  });

  /** Align the composer chip with the session's provider — but ONLY when the
   * active session changes (or on first run after mount/remount). Same-session
   * provider flips from store churn (store re-sync via loadSessionsSuccess,
   * ProviderSwitchService rollback) must not clobber an explicit user pick;
   * the failure paths in onSpawnProviderChange revert the chip explicitly. */
  private lastSyncedSessionId?: string;
  private syncProviderEffect = effect(() => {
    const session = this.activeSession();
    if (!session?.provider) return;
    if (session.id === this.lastSyncedSessionId) return;
    if (this.lastSyncedSessionId && this.newAgentProvider() !== session.provider) {
      // Diagnostics: a pick that differs from the session provider is being
      // overridden because the active session id changed (switch/wake/remount).
      console.info('[spawn-provider] chip re-synced to session provider', {
        from: this.newAgentProvider(), to: session.provider,
        prevSessionId: this.lastSyncedSessionId, sessionId: session.id,
      });
    }
    this.lastSyncedSessionId = session.id;
    // The user's last chip pick wins over the session's own provider: the
    // spawn input reopens on what they chose last time (plus that provider's
    // remembered model). No pick yet → follow the session, as before.
    const target = this.recallProvider() ?? (session.provider as SpawnProviderId);
    this.newAgentProvider.set(target);
    this.newAgentModel.set(this.recallModel(target));
  });

  /** Monotonic token: drops stale async guard results when the user clicks fast. */
  private providerSwitchSeq = 0;

  /** Transient feedback for provider-switch outcomes (reuses .no-session-toast styling). */
  providerToast = signal<{ key: string; params?: Record<string, string> } | null>(null);
  private providerToastTimer: ReturnType<typeof setTimeout> | null = null;

  private showProviderToast(key: string, params?: Record<string, string>): void {
    if (this.providerToastTimer) clearTimeout(this.providerToastTimer);
    this.providerToast.set({ key, params });
    this.providerToastTimer = setTimeout(() => this.providerToast.set(null), 4000);
  }

  /**
   * User-triggered provider change on the spawn composer chip.
   *
   * Purely local: this ONLY selects the provider for the NEXT sub-agent spawn
   * (spawnFromForm reads newAgentProvider() synchronously). It must NOT touch
   * session.provider — the session's own provider is edited via the session
   * edit flow, not here. Decoupling this removes the store update / rollback
   * that used to make picks silently revert or get stuck.
   *
   * Guarded: a provider whose CLI is missing on this device is rejected
   * (toast, chip reverted) so a spawn can't fire against a missing CLI. The
   * chip moves optimistically so a send landing during the async check still
   * spawns with the picked provider; it reverts only if the check fails while
   * this pick is still the latest one and the chip still holds it.
   */
  async onSpawnProviderChange(value: string): Promise<void> {
    const next = value as SpawnProviderId;
    const prev = this.newAgentProvider();
    const seq = ++this.providerSwitchSeq;

    this.newAgentProvider.set(next);
    // A model pick belongs to the provider it was made for: recall the one
    // remembered for the NEW provider, never carry over the previous one.
    this.newAgentModel.set(this.recallModel(next));
    // The availability check can take a beat (CLI probe): show a spinner in
    // place of the logo so the chip doesn't look frozen on the old icon.
    this.providerChecking.set(true);
    // The probe is memoized renderer-side, but a cold IPC round-trip can lag
    // for seconds when the native main thread is busy. Cap the ring so the
    // chip never looks stuck; a late negative result still reverts below.
    const ringTimer = setTimeout(() => {
      if (seq === this.providerSwitchSeq) this.providerChecking.set(false);
    }, 2000);

    try {
      if (!(await this.providerSwitch.isProviderAvailable(next as ProviderType, this.activeSessionId() ?? undefined))) {
        // Revert only if this pick is still the latest and still owns the chip.
        if (seq !== this.providerSwitchSeq || this.newAgentProvider() !== next) return;
        console.warn('[spawn-provider] CLI probe negative, chip reverted', { next, prev, probe: this.providerSwitch.lastMiss });
        this.newAgentProvider.set(prev);
        this.newAgentModel.set(this.recallModel(prev));
        this.showProviderToast('SESSIONS.Provider not installed', { provider: this.getProviderLabel(next) });
      } else if (seq === this.providerSwitchSeq && this.newAgentProvider() === next) {
        // Installed and still the current pick → this is the choice to reopen on.
        this.rememberProvider(next);
      }
    } finally {
      clearTimeout(ringTimer);
      // Only the latest pick clears the spinner — an older check finishing
      // late must not unmask a logo a newer pick is still resolving.
      if (seq === this.providerSwitchSeq) this.providerChecking.set(false);
    }
  }
  /** True while the CLI-availability probe for the picked provider is in flight. */
  readonly providerChecking = signal(false);
  spawning = signal(false);
  spawningQuickId = signal<string | null>(null);

  // ── Agent extensions (MCP / Skills / Plugins) ──
  injectedPayload = signal<ExtensionSelectionPayload | null>(null);
  injectedCount = computed(() => this.injectedPayload()?.items.length ?? 0);

  async openInjectModal(): Promise<void> {
    const modalRef = this.modalService.open(InjectAgentModalComponent, {
      centered: true,
      size: 'lg',
    });

    // Tell the modal which agent we're spawning so it filters the catalog.
    modalRef.componentInstance.provider.set(this.activeSession()?.provider ?? 'claude-code-cli');

    // Pre-select previously chosen items + secrets.
    const prev = this.injectedPayload();
    if (prev) {
      modalRef.componentInstance.selectedItems.set(prev.items);
      modalRef.componentInstance.secrets.set({ ...prev.secrets });
    }

    try {
      const result: ExtensionSelectionPayload = await modalRef.result;
      if (result) {
        this.injectedPayload.set(result);
      }
    } catch {
      // Modal dismissed
    }
  }

  // ── Voice input ──
  voiceState = signal<'idle' | 'listening' | 'processing'>('idle');
  voiceFeedback = signal('');

  /** Predefined quick agents */
  readonly quickAgents = [
    {
      id: 'security',
      icon: 'solar:shield-check-bold-duotone',
      color: '#f85149',
      label: 'Security',
      title: 'security',
      prompt: 'Audit the codebase for security vulnerabilities: check for OWASP Top 10, hardcoded secrets, SQL injection, XSS, CSRF, auth bypasses. Report findings with file:line and severity.',
    },
    {
      id: 'tests',
      icon: 'solar:test-tube-bold-duotone',
      color: '#3fb950',
      label: 'Tests',
      title: 'tests',
      prompt: 'Analyze the project test suite. Run existing tests, identify untested code, write missing tests for critical paths. Fix any failing tests.',
    },
    {
      id: 'review',
      icon: 'solar:magnifer-bug-bold-duotone',
      color: '#58a6ff',
      label: 'Review',
      title: 'review',
      prompt: 'Review recent changes (git diff). Check for bugs, code smells, performance issues, and naming inconsistencies. Suggest improvements with file:line references.',
    },
    {
      id: 'docs',
      icon: 'solar:document-text-bold-duotone',
      color: '#d29922',
      label: 'Docs',
      title: 'docs',
      prompt: 'Generate or update project documentation. Document public APIs, configuration options, and setup instructions. Keep it concise and accurate.',
    },
    {
      id: 'refactor',
      icon: 'solar:code-bold-duotone',
      color: '#bc8cff',
      label: 'Refactor',
      title: 'refactor',
      prompt: 'Identify code that can be refactored: duplications, long functions, complex conditionals, dead code. Apply clean code principles and report what was improved.',
    },
    {
      id: 'perf',
      icon: 'solar:rocket-bold-duotone',
      color: '#39c5cf',
      label: 'Perf',
      title: 'performance',
      prompt: 'Profile the application for performance bottlenecks. Check for N+1 queries, unnecessary re-renders, large bundle sizes, slow endpoints. Suggest optimizations.',
    },
  ];

  excludedPromptIds = computed(() =>
    this.slots().map((s) => s.prompt_id)
  );

  ngOnInit(): void {
    // ActionSlotService follows the active standalone/workspace context.
  }

  ngOnDestroy(): void {
    // Persist the in-progress spawn prompt for the active session so it's
    // restored when the user returns to this section.
    const sid = this._prevSessionId;
    if (sid) {
      const txt = this.newAgentPrompt();
      if (txt.trim()) ActionCenterComponent.draftPromptsBySession.set(sid, txt);
      else ActionCenterComponent.draftPromptsBySession.delete(sid);
    }
  }

  // ── Auto-approve flags (per-session) ─────────────────────────────

  /** Toggle auto-approve on/off.
   *  ON → emits onRequestAutoApproveSelection so the parent can show the
   *       graphic terminal-selection overlay (user picks which terminals).
   *  OFF → clears flags on the main session AND every active sub-agent so
   *       the red state lights turn off across the board. */
  toggleAutoApprove(): void {
    const sessionId = this.activeSessionId();
    if (!sessionId) return;

    if (this.isActiveSessionAutoApproved()) {
      // Turning OFF: clear the main session and propagate to all sub-agents
      const off = { modal: false, quick: false, ai: false };
      this.interactionService.setFlags(sessionId, off);
      for (const sa of this.subAgentService.activeSubAgents()) {
        if (sa.sessionId) {
          this.interactionService.setFlags(sa.sessionId, off);
        }
      }
      return;
    }

    // Turning ON: defer to the parent overlay selector
    this.onRequestAutoApproveSelection.emit();
  }

  /** Check if a sub-agent session has auto-approve enabled. */
  isSubAgentAutoApproved(sessionId: string): boolean {
    return this.interactionService.isAutoApproved(sessionId);
  }

  /** Toggle auto-approve for a specific sub-agent session. */
  toggleSubAgentAutoApprove(sessionId: string): void {
    if (!sessionId) return;
    if (this.interactionService.isAutoApproved(sessionId)) {
      this.interactionService.setFlags(sessionId, { modal: false, quick: false, ai: false });
    } else {
      this.interactionService.setFlags(sessionId, { quick: true });
    }
  }

  onSlotsResizeStart(event: MouseEvent): void {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = this.slotsHeight();

    const onMove = (e: MouseEvent) => {
      const delta = startY - e.clientY;
      this.slotsHeight.set(Math.max(60, Math.min(500, startHeight + delta)));
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  toggleSlotsCollapse(): void {
    if (this.slotsCollapsed()) {
      // close quick agents first
      if (!this.quickAgentsCollapsed()) {
        this.qaExpandedHeight = this.quickAgentsHeight();
        this.quickAgentsCollapsed.set(true);
        this.quickAgentsHeight.set(36);
      }
      this.slotsCollapsed.set(false);
      this.slotsHeight.set(this.slotsExpandedHeight);
    } else {
      this.slotsExpandedHeight = this.slotsHeight();
      this.slotsCollapsed.set(true);
      this.slotsHeight.set(36);
    }
  }

  toggleQuickAgentsCollapse(): void {
    if (this.quickAgentsCollapsed()) {
      // close slots first
      if (!this.slotsCollapsed()) {
        this.slotsExpandedHeight = this.slotsHeight();
        this.slotsCollapsed.set(true);
        this.slotsHeight.set(36);
      }
      this.quickAgentsCollapsed.set(false);
      this.quickAgentsHeight.set(this.qaExpandedHeight);
    } else {
      this.qaExpandedHeight = this.quickAgentsHeight();
      this.quickAgentsCollapsed.set(true);
      this.quickAgentsHeight.set(36);
    }
  }

  onQaResizeStart(event: MouseEvent): void {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = this.quickAgentsHeight();
    const onMove = (e: MouseEvent) => {
      const delta = startY - e.clientY;
      this.quickAgentsHeight.set(Math.max(60, Math.min(500, startHeight + delta)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  toggleCollapse(): void {
    this.collapsed.update((v) => !v);
    this.onCollapsedChange.emit(this.collapsed());
  }

  toggleEditMode(): void {
    this.editMode.update((v) => !v);
    this.editingSlotId.set(null);
  }

  startEditing(slot: ActionSlot, compact = false): void {
    if (this.editingSlotId() === slot.id) {
      this.saveEditing(slot);
      return;
    }
    this.editingSlotId.set(slot.id);
    this.editingBody.set(slot.prompt?.body || '');
    setTimeout(() => {
      const el = document.querySelector(compact ? '.quick-actions-mini-textarea' : '.acc-panel-actions .slot-edit-textarea') as HTMLTextAreaElement;
      el?.focus();
    });
  }

  async saveEditing(slot: ActionSlot): Promise<void> {
    if (this.deletingSlotId() !== null) return;
    const body = this.editingBody().trim();
    if (body && body !== slot.prompt?.body) {
      await this.slotService.updatePromptBody(slot, body);
    }
    this.editingSlotId.set(null);
    this.editingBody.set('');
  }

  cancelEditing(): void {
    this.editingSlotId.set(null);
    this.editingBody.set('');
  }

  private promptPickerScope: 'session' | 'global' = 'session';
  private promptPickerSessionId: string | null = null;

  openPromptPicker(sessionId = this.activeSessionId(), scope = this.slotService.scopeMode()): void {
    if (!sessionId) { this.showNoSessionToast(); return; }
    this.promptPickerSessionId = sessionId;
    this.promptPickerScope = scope;
    this.showPromptPicker.set(true);
  }

  async onPromptSelected(event: { promptId: number; label: string }): Promise<void> {
    this.showPromptPicker.set(false);
    if (this.promptPickerSessionId) {
      await this.slotService.addSlot(event.promptId, event.label, 'ti-bolt', this.promptPickerSessionId, { scope: this.promptPickerScope });
    }
  }

  openQuickCreatePrompt(): void {
    const targetSessionId = this.activeSessionId();
    const targetScope = this.slotService.scopeMode();
    if (!targetSessionId) { this.showNoSessionToast(); return; }
    const modalRef = this.modalService.open(QuickCreatePromptModalComponent, {
      centered: true,
      size: 'lg',
      scrollable: true,
      beforeDismiss: () => {
        const comp = modalRef.componentInstance as QuickCreatePromptModalComponent;
        if (comp.saving()) return false;
        if (comp.hasDraftContent()) {
          // window.confirm() returns false at once in the macOS webview, which
          // made a draft impossible to discard: ask with the in-app dialog.
          return this.slotAlerts
            .showConfirm('', this.translateService.instant('PROMPTS.Confirm discard draft'))
            .then((r) => !!r?.isConfirmed);
        }
        return true;
      },
    });

    modalRef.result.then(
      async (result) => {
        if (result?.choosePrompt) {
          this.openPromptPicker(targetSessionId, targetScope);
          return;
        }
        if (result?.chooseCommand) {
          this.smartActions.openCommands();
          return;
        }
        if (result?.addToQuickActions && result?.promptId) {
          await this.slotService.addSlot(result.promptId, result.title, 'ti-bolt', targetSessionId, { scope: targetScope });
        }
      },
      () => {}, // dismissed
    );
  }

  async removeSlot(id: number): Promise<void> {
    if (this.deletingSlotId() !== null) return;
    const context = this.slotService.context();
    if (!context) return;
    this.deletingSlotId.set(id);
    try {
      if (context.scope.type === 'global') {
        const result = await this.slotAlerts.showConfirm(
          this.translateService.instant('QUICK_ACTION_SCOPE.Delete global title'),
          this.translateService.instant('QUICK_ACTION_SCOPE.Delete global warning')
        );
        if (!result.isConfirmed) return;
      }
      // A confirmation applies only to the scope in which it was opened.
      if (this.slotService.context()?.key !== context.key) return;
      const removed = await this.slotService.removeSlot(id);
      if (removed) {
        if (this.editingSlotId() === id) this.cancelEditing();
      } else {
        this.slotAlerts.error(this.translateService.instant('MESSAGE.Generic error'));
      }
    } finally {
      this.deletingSlotId.set(null);
    }
  }

  onSlotDrop(event: CdkDragDrop<ActionSlot[]>): void {
    const items = [...this.slots()];
    moveItemInArray(items, event.previousIndex, event.currentIndex);
    this.slotService.slots.set(items);
    this.slotService.reorder(items.map((s) => s.id));
  }

  // ── Plugin buttons in the terminal bars ───────────────────────────────────
  // A button can propose a new sub-agent: it arrives here and the spawn composer
  // is prefilled. Starting it is left to the user.
  private lastPluginPrefill = 0;
  /** A composer button proposed some text: it goes into the prompt, starting it is left to the user. */
  onPluginInsert(text: string): void {
    this.insertAtPromptCaret(text);
  }

  private pluginPrefillEffect = effect(() => {
    const p = this.pluginRuntime.composerPrefill();
    if (!p || p.seq === this.lastPluginPrefill) return;
    this.lastPluginPrefill = p.seq;
    untracked(() => {
      this.newAgentPrompt.set(p.prompt);
      if (p.provider && SPAWN_PROVIDERS.some((sp) => sp.value === p.provider) && this.orgPolicy.isProviderAllowed(p.provider)) void this.onSpawnProviderChange(p.provider);
      if (p.mode && p.mode in MODE_PRESETS) this.selectMode(p.mode as SubAgentMode);
      queueMicrotask(() => this.promptTextareaRef?.nativeElement?.focus());
    });
  });

  selectMode(mode: SubAgentMode): void {
    this.selectedMode.set(mode);
    this.showCustomConfig.set(false);
    // Sync custom config to new mode defaults
    const preset = MODE_PRESETS[mode];
    this.customReasoningDepth.set(preset.config.reasoning_depth);
    this.customVerbosity.set(preset.config.verbosity);
    this.customExploration.set(preset.config.exploration);
    this.customSpeedPriority.set(preset.config.speed_priority);
    this.customRiskTolerance.set(preset.config.risk_tolerance);
    this.saveModeState();
  }

  toggleCustomConfig(): void {
    const willOpen = !this.showCustomConfig();
    this.showCustomConfig.set(willOpen);
    if (willOpen) {
      // Initialize custom config sliders from current mode defaults
      const preset = MODE_PRESETS[this.selectedMode()];
      this.customReasoningDepth.set(preset.config.reasoning_depth);
      this.customVerbosity.set(preset.config.verbosity);
      this.customExploration.set(preset.config.exploration);
      this.customSpeedPriority.set(preset.config.speed_priority);
      this.customRiskTolerance.set(preset.config.risk_tolerance);
    }
    this.saveModeState();
  }

  async spawnQuickAgent(agent: typeof this.quickAgents[0]): Promise<void> {
    const sessionId = this.activeSessionId();
    if (!sessionId) { this.showNoSessionToast(); return; }

    this.spawningQuickId.set(agent.id);
    try {
      await this.subAgentService.spawnCustom(
        sessionId,
        agent.id,
        agent.title,
        agent.prompt,
        (agent as any).provider,
        this.selectedMode(),
        this.resolvedCustomConfig(),
        this.activeSession()?.workspace?.path,
        undefined,
        this.injectedPayload() ?? undefined,
        this.spawnExecutionMode(),
        undefined,
        this.spawnEcoLevel(),
        undefined,
        undefined,
        this.spawnSoftSkill(),
      );
      // History logging happens via onSubAgentCreated push event in SubAgentService
    } catch (err) {
    } finally {
      setTimeout(() => this.spawningQuickId.set(null), 800);
    }
  }

  async openResumeModal(): Promise<void> {
    const session = this.activeSession();
    const modalRef = this.modalService.open(ResumeSubAgentModalComponent, {
      centered: true,
      size: 'md',
    });
    modalRef.componentInstance.currentSessionName = session?.name ?? '';
    modalRef.componentInstance.currentWorkspacePath = session?.workspace?.path ?? '';
    try {
      const selected = await modalRef.result;
      if (selected) {
        const sessionId = this.activeSessionId();
        if (!sessionId) return;
        await this.subAgentService.resumeArchived(sessionId, selected);
      }
    } catch {
      // Modal dismissed
    }
  }

  // ── Voice recording ──────────────────────────────────────────
  // Records raw PCM via AudioContext → encodes as WAV → sends to main process.
  // Auto-stops when silence detected after speech (1.5s of silence).
  // Ctrl/Cmd+Shift+V is reserved for paste. Start dictation from the mic button.

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    this.effortMenuOpen.set(false);
  }

  async toggleVoice(): Promise<void> {
    if (this.voiceState() === 'listening') {
      this.voiceAgent.stopCapture();
      return;
    }
    if (this.voiceState() !== 'idle') return;

    this.voiceFeedback.set('');
    // Shared hardened pipeline (adaptive VAD, gain norm, lang hint, local
    // whisper). Dictation-friendly trailing silence: pauses don't cut you off.
    const res = await this.voiceAgent.captureAndTranscribe({
      trailingSilenceMs: 1500,
      onState: (st) => this.voiceState.set(st),
    });
    this.voiceState.set('idle');

    if (res.ok && res.text) {
      const current = this.newAgentPrompt().trim();
      this.newAgentPrompt.set(current ? current + ' ' + res.text : res.text);
      this.showVoiceFeedback(res.text);
    } else if (res.error === 'busy') {
      this.showVoiceFeedback(this.translateService.instant('SESSIONS.ACTION_CENTER.Mic busy'));
    } else if (res.noSpeech) {
      this.showVoiceFeedback(this.translateService.instant('SESSIONS.ACTION_CENTER.No speech'));
    } else if (res.error && res.error !== 'mic-denied') {
      this.showVoiceFeedback(res.error);
    }
  }

  private showVoiceFeedback(msg: string): void {
    this.voiceFeedback.set(msg);
    setTimeout(() => this.voiceFeedback.set(''), 5000);
  }

  /**
   * Build a compact sub-agent title from the first part of the prompt that was
   * sent. Replaces the old static feature/fix/bug label: takes the first
   * non-empty line, collapses whitespace and truncates to a chip-friendly length.
   */
  private deriveAgentTitle(prompt: string): string {
    const firstLine = prompt
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
    const collapsed = firstLine.replace(/\s+/g, ' ').trim();
    if (!collapsed) return 'Agent';
    const MAX = 48;
    return collapsed.length > MAX ? collapsed.slice(0, MAX).trimEnd() + '…' : collapsed;
  }

  async spawnFromForm(): Promise<void> {
    const sessionId = this.activeSessionId();
    const prompt = this.newAgentPrompt().trim();
    // The composer no longer carries a separate "type" label (feature/fix/bug);
    // the sub-agent is titled with the first part of the prompt that was sent.
    const title = this.deriveAgentTitle(prompt);

    if (!sessionId) { this.showNoSessionToast(); return; }
    if (!prompt) return;

    this.spawning.set(true);

    const provider = this.newAgentProvider();
    try {
      // Spawn the sub-agent. Selected extensions (MCP/Skills) are materialized
      // for real into the agent at spawn — no prompt-injection preamble.
      await this.subAgentService.spawnCustom(
        sessionId, 'custom', title, prompt, provider,
        this.selectedMode(), this.resolvedCustomConfig(),
        this.activeSession()?.workspace?.path,
        this.newAgentAccountId(),
        this.injectedPayload() ?? undefined,
        this.spawnExecutionMode(),
        this.newAgentModel() ?? undefined,
        this.spawnEcoLevel(),
        this.spawnGoalSpec(),
        this.selectedEffort() ?? undefined,
        this.spawnSoftSkill(),
      );

      // Clear form — inside the try on purpose: on failure the prompt is
      // preserved so the user can retry.
      this.newAgentPrompt.set('');
      this._promptDirtyForSession = null;
      if (sessionId) ActionCenterComponent.draftPromptsBySession.delete(sessionId);
      this.newAgentAccountId.set(undefined);
      this.resetPromptTextareaHeight();
    } catch (err) {
      // Parked session that could not be woken: the wake already showed why,
      // and the prompt stays in the composer.
      if ((err as { wakeFailed?: boolean } | null)?.wakeFailed) return;
      console.error('[ActionCenter] sub-agent spawn failed', err);
      // Remote session: the real reason (connection, CLI missing on the host,
      // folder gone) matters more than the generic "install the CLI".
      if (this.sessionService.isRemotePath(this.activeSession()?.workspace?.path)) {
        const reason = String((err as any)?.message ?? err ?? '').replace(/^Error:\s*/, '');
        this.showProviderToast('SESSIONS.Remote agent spawn failed', { provider: this.getProviderLabel(provider), error: reason });
      } else {
        this.showProviderToast('SESSIONS.Sub-agent spawn failed', { provider: this.getProviderLabel(provider) });
      }
    } finally {
      setTimeout(() => this.spawning.set(false), 800);
    }
  }

  async spawnFromSlot(slot: ActionSlot): Promise<void> {
    const sessionId = this.activeSessionId();
    if (!sessionId) { this.showNoSessionToast(); return; }
    if (this.runningSlotId() !== null) return;
    const workspacePath = this.activeSession()?.workspace?.path;
    this.runningSlotId.set(slot.id);
    try {
      // The slot endpoint deliberately returns a small prompt projection. Read
      // the persisted execution metadata and latest body before choosing a runner.
      const prompt = await this.slotService.getPrompt(slot.prompt_id);
      if (!prompt.body?.trim()) return;
      const command = readCommandAction(prompt.notes);
      await this.subAgentService.spawnCustom(
        sessionId, 'custom', prompt.title || slot.label, prompt.body,
        command ? 'generic-shell' : undefined,
        command ? 'clean' : this.selectedMode(),
        command ? undefined : this.resolvedCustomConfig(),
        command?.directory ?? workspacePath,
        undefined,
        command ? undefined : this.injectedPayload() ?? undefined,
        command ? 'interactive' : this.spawnExecutionMode(),
        undefined,
        command ? undefined : this.spawnEcoLevel(),
        undefined,
        undefined,
        command ? undefined : this.spawnSoftSkill(),
      );
    } catch {
      this.showProviderToast('MESSAGE.Generic error');
    } finally {
      setTimeout(() => this.runningSlotId.set(null), 800);
    }
  }

  private showNoSessionToast(): void {
    this.noSessionToast.set(true);
    setTimeout(() => this.noSessionToast.set(false), 3000);
  }
}
