import { OrgPolicyService } from '@core/services/org-policy.service';
import { readDismissedMains, writeDismissedMains } from '../services/dismissed-mains';
import {
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  ElementRef,
  inject,
  NgZone,
  OnInit,
  OnDestroy,
  ViewChild,
  ViewChildren,
  QueryList,
  computed,
  effect,
  signal,
  untracked,
  HostListener,
  isDevMode,
  ChangeDetectionStrategy
} from '@angular/core';
import { AGENTS_MODEL } from '../agents/agents-model.token';
import { AgentRosterService } from '../agents/agent-roster.service';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { trigger, transition, style, animate } from '@angular/animations';
import { ActivatedRoute } from '@angular/router';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { attachWebglRenderer } from '../../../../core/helper/xterm-renderer';
import { Store } from '@ngrx/store';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { SessionService } from '../services/session.service';
import { InteractionService } from '../services/interaction.service';
import { EcoModeService } from '../services/eco-mode.service';
import { ClaudeHookService } from '../services/claude-hook.service';
import { SubAgentService, SubAgent } from '../services/sub-agent.service';
import { SessionModelService } from '../services/session-model.service';
import { SessionEffortService } from '../services/session-effort.service';
import { effortOptions, validEffort } from '../services/reasoning-effort';
import { formatModelLabel, liveModels, MODEL_TRACKED_PROVIDERS } from '../services/model-labels';
import { SubAgentStashService } from '../services/sub-agent-stash.service';
import { AgentActionNoticeService } from '../services/agent-action-notice.service';
import { SubAgentReviewService } from '../services/sub-agent-review.service';
import { CheckWithProviderModalComponent } from '../check-with-provider-modal/check-with-provider-modal.component';
import { buildInstallScript, npmInstallCommand } from './install-scripts';
import { captureExpandedSubAgentEscape } from './expanded-sub-agent-escape';
import { SessionShortcutAction, SessionShortcutsService, shortcutKeyLabel } from '../services/session-shortcuts.service';
import { setPaneResizing } from '../pane-resize-flag';
import { SessionHistoryService } from '../services/session-history.service';
import { SessionSidebarComponent } from '../session-sidebar/session-sidebar.component';
import { SessionHeaderComponent } from '../session-header/session-header.component';
import { SessionTerminalComponent } from '../session-terminal/session-terminal.component';
import { SubAgentTerminalComponent } from '../sub-agent-terminal/sub-agent-terminal.component';
import { WorkerChatComponent } from '../worker-chat/worker-chat.component';
import { ActionCenterComponent } from '../action-center/action-center.component';
import { SessionGitPanelComponent } from '../session-git-panel/session-git-panel.component';
import { SessionSshPanelComponent } from '../session-ssh-panel/session-ssh-panel.component';
import { SessionAssetsPanelComponent } from '../session-assets-panel/session-assets-panel.component';
import { SessionDatabaseExplorerComponent } from '../session-database-explorer/session-database-explorer.component';
import { SessionDockerPanelComponent } from '../session-docker-panel/session-docker-panel.component';
import { TerminalViewComponent } from '../../terminal/terminal-view/terminal-view.component';
import { BrowserModeModalComponent } from '../../browser/browser-mode-modal.component';
import { TerminalManagerService } from '../../terminal/services/terminal-manager.service';
import { CreateSessionModalComponent } from '../create-session-modal/create-session-modal.component';
import { ContextSnapshotModalComponent } from '../context-snapshot-modal/context-snapshot-modal.component';
import { RenameSessionModalComponent } from '../rename-session-modal/rename-session-modal.component';
import { ResumeSubAgentModalComponent } from '../resume-subagent-modal/resume-subagent-modal.component';
import { IntentModalComponent } from '../intent-modal/intent-modal.component';
import { WorkspaceSetupModalComponent } from '../workspace-setup-modal/workspace-setup-modal.component';
import { SessionCodeEditorComponent } from '../session-code-editor/session-code-editor.component';
import {
  loadSessions,
  setActiveSession,
  activateSavedSession,
  sessionStatusChanged,
  destroySession,
  createSession,
  updateSessionSuccess,
  reorderSessions,
  setLayoutMode,
  updateSessionViewState,
  promoteSessionToWorkspace,
  standbySession,
  wakeSession,
  wakeSessionSuccess,
  standbyWorkspace,
  wakeWorkspace,
} from '../../../../../store/sessions/session.actions';
import {
  getSessions,
  getActiveSessionId,
  getActiveSession,
  getActiveSessionInteractions,
  getSessionsHasLoadedOnce,
  getSessionsListLoadFailed,
  getSessionsLoading,
} from '../../../../../store/sessions/session.selectors';
import { hasEverHadSessions } from '../../../../../store/sessions/session.state';
import { SessionSummary, LayoutMode, SessionViewState, ProviderType } from '../../../../../store/sessions/session.state';
import {
  loadWorkspaces,
} from '../../../../../store/workspaces/workspace.actions';
import { getProviderUsage } from '../../../../../store/token-efficiency/token-efficiency.selectors';
import { loadProviderUsage } from '../../../../../store/token-efficiency/token-efficiency.actions';
import { ProviderUsageSnapshot } from '../../../../../store/token-efficiency/token-efficiency.state';
import {
  getWorkspaces,
  getActiveWorkspaceId,
  getActiveWorkspace,
} from '../../../../../store/workspaces/workspace.selectors';
import { getUser } from '../../../../../store/authentication/authentication.selector';
import { WorkspaceApiService } from '../services/workspace-api.service';
import { ActionSlotService } from '../services/action-slot.service';
import { SwalService } from '@core/services/swal.service';
import { DesktopSessionApiService } from '../services/desktop-session-api.service';
import { ProviderSwitchService } from '../services/provider-switch.service';
import { ProviderLimitService } from '../services/provider-limit.service';
import { SPAWN_PROVIDERS } from '../services/spawn-providers.const';
import { toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Actions, ofType } from '@ngrx/effects';
import { TranslateService } from '@ngx-translate/core';
import { Subscription, firstValueFrom, first, timeout } from 'rxjs';
import { TutorialService } from '@/app/components/tutorial/tutorial.service';
import { SessionsGuideService } from '../sessions-guide/sessions-guide.service';
import { SessionsGuideOverlayComponent } from '../sessions-guide/sessions-guide-overlay.component';
import { TooltipDirective } from '../../../../common/tooltip.directive';
import { FileDropZoneDirective } from '../../../../common/file-drop-zone.directive';
import { FeatureFlagService } from '@core/services/feature-flag.service';
import { ConsentCheckService } from '@core/services/consent-check.service';
import { AddNoteModalComponent } from '@components/add-note-modal/add-note-modal.component';
import { ProjectBriefModalComponent } from '@components/project-brief-modal/project-brief-modal.component';
import { DevLinksModalComponent } from '@components/dev-links-modal/dev-links-modal.component';
import { TodoModalComponent } from '@components/todo-modal/todo-modal.component';
import { DesktopDownloadCtaComponent } from '@components/desktop-download-cta/desktop-download-cta.component';
import { SessionAssetsService } from '../services/session-assets.service';
import { RemoteBridgeService, escapeHtml } from '../services/remote-bridge.service';
import { PollingHubService } from '@core/services/polling-hub.service';
import { isDataError } from '@core/data/data-backend';
import { NativeMenuService, type NativeMenuCommand } from '@core/services/native-menu.service';

const ACTIVE_SESSION_KEY = 'promptops_active_session';
const ACTIVE_SESSION_NAME_KEY = 'promptops_active_session_name';
const RESIZE_STORAGE_KEY = 'promptops_resize_state';

import { PluginSessionButtonsComponent } from '../../plugins/plugin-session-buttons.component';
import { PluginRuntimeService } from '../../plugins/plugin-runtime.service';
import { FloorPlanService } from '../floor-plan/floor-plan.service';
import { SessionWindowsService } from '../services/session-windows.service';
import { sessionWindowId, tauri } from '@/app/detached/detached-window';
import { FloorPlanViewComponent } from '../floor-plan/floor-plan-view.component';
import { BuiltinPluginsService } from '../../plugins/builtin-plugins.service';
import { ForwardPortsPanelComponent } from '../forward-ports-panel/forward-ports-panel.component';
import { ForwardPortsService } from '@core/services/forward-ports.service';
import { CloudFeatureModalComponent } from '@components/cloud-feature-modal/cloud-feature-modal.component';

/** View state as saved for a session, plus its layout mode (standard / code). */
type ViewStateWithLayout = SessionViewState & { layoutMode?: LayoutMode };


/**
 * localStorage write that never throws: a full or blocked storage must not
 * break a session switch or a layout change (the value is a convenience).
 */
function safeSetItem(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage full or blocked */ }
}

@Component({
  selector: 'app-session-view',
  standalone: true,
  imports: [
    FloorPlanViewComponent,
    PluginSessionButtonsComponent,
    CommonModule,
    TranslateModule,
    SessionSidebarComponent,
    SessionHeaderComponent,
    SessionTerminalComponent,
    SubAgentTerminalComponent,
    WorkerChatComponent,
    ActionCenterComponent,
    SessionGitPanelComponent,
    SessionAssetsPanelComponent,
    SessionCodeEditorComponent,
    AddNoteModalComponent,
    ProjectBriefModalComponent,
    DevLinksModalComponent,
    TodoModalComponent,
    TooltipDirective,
    FileDropZoneDirective,
    DesktopDownloadCtaComponent,
    SessionsGuideOverlayComponent,
    ForwardPortsPanelComponent,
  ],
  templateUrl: './session-view.component.html',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  animations: [
    trigger('layoutFade', [
      transition(':enter', [
        style({ opacity: 0 }),
        animate('200ms ease-out', style({ opacity: 1 })),
      ]),
      transition(':leave', [
        animate('150ms ease-in', style({ opacity: 0 })),
      ]),
    ]),
  ],
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .sessions-page {
      display: flex;
      flex-direction: column;
      height: calc(100vh - var(--po-topbar-h) - var(--po-bottombar-h));
      background: var(--po-bg-1);
    }

    .sessions-layout {
      display: flex;
      flex: 1;
      min-height: 0;
    }

    app-session-sidebar {
      flex-shrink: 0;
      transition: width 0.2s ease;
      overflow: hidden;
    }

    app-session-sidebar.no-transition {
      transition: none;
    }

    .sessions-sidebar-resize {
      flex: 0 0 5px;
      margin: 0 -2px;
      cursor: col-resize;
      z-index: 5;
      transition: background 0.15s;
    }
    .sessions-sidebar-resize:hover,
    .sessions-sidebar-resize.active {
      background: var(--po-accent-muted-bg);
    }

    .sessions-main > .fp-main { flex: 1; }
    .detached-cover { margin: auto; max-width: 420px; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; padding: 24px; }
    .detached-cover iconify-icon { color: var(--po-accent); }
    .detached-cover h5 { margin: 4px 0 0; font-weight: 700; }
    .detached-cover-name { font-size: 14px; }
    .detached-cover p { margin: 0; color: var(--po-text-secondary); font-size: 13px; line-height: 1.5; }
    .detached-cover-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; justify-content: center; }
    .sessions-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .sessions-content {
      flex: 1;
      display: flex;
      min-height: 0;
    }

    .terminal-area {
      flex: 1;
      min-width: 0;
      position: relative;
    }

    .terminal-area.has-subagents {
      display: flex;
      flex-direction: column;
    }

    .terminal-area.has-subagents .main-pane {
      flex: 1;
      min-height: 0;
      position: relative;
      margin: 8px;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid rgba(99, 102, 241, 0.16);
      background: #10121a;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
    }

    /* ── Cover-Main mode: sub-agents take over the entire pane ── */
    .sa-lead-badge {
      display: inline-flex;
      align-items: center;
      color: var(--po-warning, #f5b301);
      padding: 0 2px;
      cursor: default;
    }
    .terminal-area .main-dismissed-empty {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      color: var(--po-text-muted, #8b8fa3);
      text-align: center;
      padding: 24px;
    }
    .terminal-area .main-dismissed-empty .mde-title { font-size: 13px; font-weight: 600; color: var(--po-text, inherit); }
    .terminal-area .main-dismissed-empty .mde-hint { font-size: 12px; max-width: 360px; }
    .terminal-area .main-dismissed-empty .btn { margin-top: 8px; display: inline-flex; align-items: center; gap: 6px; }
    .terminal-area.cover-main .main-pane {
      display: none !important;
    }
    .terminal-area.cover-main .subagents-accordion,
    .terminal-area.cover-main .subagents-accordion.expanded {
      flex: 1;
      max-height: none;
      height: auto !important;
      min-height: 0;
    }
    .terminal-area.cover-main .subagents-resize-handle {
      display: none;
    }


    /* IDE layout: AA overlay top-right */
    .ide-terminal-area {
      position: relative;
    }

    /* ── Standby cover (Tauri lazy landing): parked session, resume on demand ── */
    .standby-cover {
      position: absolute;
      inset: 0;
      z-index: 6;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      background: rgba(16, 18, 26, 0.92);
      backdrop-filter: blur(2px);
      color: #a5b4fc;
      text-align: center;
    }
    .standby-cover .standby-cover-title {
      font-size: 0.95rem;
      font-weight: 600;
      color: #e0e7ff;
    }
    .standby-cover .standby-cover-subtitle {
      font-size: 0.78rem;
      color: rgba(165, 180, 252, 0.7);
      margin-bottom: 8px;
    }

    /* ── Sub-agents accordion with terminals ── */
    .subagents-accordion {
      border-top: 1px solid var(--po-border-subtle, rgba(128, 128, 128, 0.25));
      display: flex;
      flex-direction: column;
      min-height: 0;
      position: relative;
      flex-shrink: 0;
      overflow: hidden;
    }

    .subagents-accordion.expanded {
      flex: none;
      flex-shrink: 1;
      min-height: 120px;
      max-height: 70%;
      /* Fixed-position descendants (.subagent-pane.sa-expanded, backdrop)
         escape this clip — do NOT add transform/filter on ancestors or they
         gain a containing block and get clipped. */
      overflow: hidden;
    }

    .subagents-accordion-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 0.5rem 0 0.25rem;
      min-height: 32px;
      background: var(--po-bg-1, #161b22);
      border-bottom: 1px solid var(--po-border-subtle, rgba(128, 128, 128, 0.25));
      cursor: pointer;
      user-select: none;
      flex-shrink: 0;
    }

    /* Agents | Ports tabs, VS Code panel style: uppercase, active = full text + underline. */
    .sa-panel-tabs {
      display: flex;
      align-items: stretch;
      align-self: stretch;
      gap: 2px;
      min-width: 0;
    }
    .sa-panel-tab {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 0 10px;
      border: none;
      background: transparent;
      color: var(--po-text-secondary, #9da5b4);
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
      white-space: nowrap;
    }
    .sa-panel-tab:hover { color: var(--po-text-primary, #e6edf3); }
    .sa-panel-tab.active { color: var(--po-text-primary, #e6edf3); }
    .sa-panel-tab.active::after {
      content: '';
      position: absolute;
      left: 8px;
      right: 8px;
      bottom: 0;
      height: 2px;
      border-radius: 2px 2px 0 0;
      background: var(--po-text-primary, #e6edf3);
    }
    .sa-panel-tab:focus-visible { outline: 1px solid var(--po-info, #3794ff); outline-offset: -2px; }
    .sa-panel-count {
      min-width: 16px;
      padding: 0 5px;
      border-radius: 8px;
      font-size: 0.62rem;
      font-weight: 600;
      line-height: 16px;
      text-align: center;
      letter-spacing: 0;
      background: color-mix(in srgb, var(--po-text-primary, #e6edf3) 14%, transparent);
      color: var(--po-text-primary, #e6edf3);
    }

    /* Ports view: covers the terminal area; the agent panes stay mounted (xterm must not be unmounted). */
    .sa-ports-view {
      display: flex;
      flex: 1;
      min-height: 0;
      background: var(--po-bg-0, #0d1117);
    }
    .solo-bar { cursor: default; }
    /* Agent | Ports tabs inside the pane header (a single agent): same height as the row. */
    .subagent-pane-header > .sa-panel-tabs {
      flex-shrink: 0;
      margin: -0.25rem 0 -0.25rem -0.55rem;
      padding-right: 0.35rem;
      border-right: 1px solid var(--po-border-subtle, rgba(128, 128, 128, 0.25));
    }
    .btn-sa-mode:disabled { opacity: 0.45; cursor: default; }
    .sa-spin { animation: sa-spin 1s linear infinite; }
    @keyframes sa-spin { to { transform: rotate(360deg); } }
    .sa-ports-view.solo { flex: 1; }
    .main-pane.hidden-by-ports {
      position: absolute;
      inset: 0;
      visibility: hidden;
      pointer-events: none;
    }
    .subagents-accordion.ports-active > .sa-tab-bar,
    .subagents-accordion.ports-active > .subagents-terminals,
    .subagents-accordion.ports-active > .sa-shortcut-bar {
      position: absolute;
      inset: 0;
      visibility: hidden;
      pointer-events: none;
    }

    .subagents-accordion-title {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--po-text-primary, #e6edf3);
    }

    .subagents-header-actions {
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }

    /* Sub-agent bar grafted into the header tab row (multi-session plugin off) */
    .sa-bar-in-header {
      display: flex;
      /* The basis is decided by saBarInHeaderBasis(): right edge aligned with the terminals', so the
         icons (modes + chevron) sit where the agents end. The header spacer takes the rest. */
      flex: 0 1 100%;
      min-width: 0;
      align-self: stretch;
    }
    .sa-bar-in-header .subagents-accordion-header {
      flex: 1;
      min-width: 0;
      padding: 0 0.5rem 0 0;
      background: transparent;
    }
    .sa-bar-in-header .subagents-accordion-header { border-bottom: none; }

    .btn-sa-layout {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 4px;
      background: var(--po-accent-muted-bg);
      color: var(--po-accent);
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .btn-sa-layout:hover {
      background: var(--po-accent-muted-bg);
      color: var(--po-accent);
    }

    .accordion-chevron {
      color: var(--po-text-secondary);
    }

    .subagents-terminals {
      /* Shared with .sa-tab-hidden's inset: hidden panes must resolve to the
         same content-box as the visible (in-flow) pane, or FitAddon measures
         them 14px taller and pushes rows+1 to the PTY. */
      --sa-pad-top: 6px;
      --sa-pad-x: 8px;
      --sa-pad-bottom: 8px;
      flex: 1;
      display: flex;
      min-height: 0;
      gap: 6px;
      padding: var(--sa-pad-top) var(--sa-pad-x) var(--sa-pad-bottom) var(--sa-pad-x);
    }

    .subagents-terminals.list-mode,
    .subagents-terminals.rows-mode {
      flex-direction: column;
    }

    .subagent-pane {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid var(--po-border-subtle, rgba(128, 128, 128, 0.25));
      background: #0c0e16;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
    }

    .sa-h-resize-handle {
      width: 4px;
      cursor: col-resize;
      flex-shrink: 0;
      position: relative;
      z-index: 5;
      transition: background 0.15s;
    }
    .sa-h-resize-handle:hover,
    .sa-h-resize-handle:active {
      background: var(--po-accent-muted-bg);
    }
    .rows-mode > .sa-h-resize-handle {
      width: auto;
      height: 4px;
      cursor: row-resize;
    }

    .subagent-pane-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.35rem;
      padding: 0.25rem 0.55rem;
      background: var(--po-bg-1, #161b22);
      border-bottom: 1px solid var(--po-border-subtle, rgba(128, 128, 128, 0.25));
      flex-shrink: 0;
      min-width: 0;
      overflow: hidden;
    }

    .subagent-pane-title {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.7rem;
      font-weight: 600;
      color: var(--po-accent);
      min-width: 0;
      flex: 1 1 0;
      overflow: hidden;
    }

    .subagent-prompt-hint {
      flex: 1 1 0;
      font-size: 0.65rem;
      font-weight: 400;
      color: var(--po-text-secondary);
      opacity: 0.75;
      font-style: italic;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    .subagent-pane-actions {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      flex-shrink: 0;
    }

    /* ── Collapsed actions (6+ panes on narrow viewports) ──
       The menu comes out of the header (overflow hidden by default), so the header
       with the flyout goes back to visible and rises in stacking above the terminal. */
    .subagent-pane-header:has(.sa-actions-flyout) {
      overflow: visible;
      position: relative;
      z-index: 20;
    }
    .sa-actions-flyout {
      position: relative;
      display: flex;
    }
    .sa-actions-menu {
      display: none;
      position: absolute;
      top: 100%;
      right: -4px;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      padding: 4px;
      background: #0c0e16;
      border: 1px solid rgba(168, 85, 247, 0.3);
      border-radius: 8px;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.45);
      z-index: 40;
    }
    .sa-actions-flyout:hover .sa-actions-menu,
    .sa-actions-flyout:focus-within .sa-actions-menu {
      display: flex;
    }
    .sa-actions-flyout:hover .sa-actions-trigger,
    .sa-actions-flyout:focus-within .sa-actions-trigger {
      background: rgba(99, 102, 241, 0.2);
      color: var(--po-accent);
    }

    .subagent-status {
      font-size: 0.58rem;
      font-weight: 600;
      text-transform: uppercase;
      padding: 1px 4px;
      border-radius: 3px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .sa-status-spawning { background: var(--po-warning-bg); color: var(--po-warning); }
    .sa-status-running { background: var(--po-success-bg); color: var(--po-success); }
    .sa-status-in_progress { background: rgba(139, 92, 246, 0.15); color: #8b5cf6; }
    .sa-status-waiting_input { background: var(--po-warning-bg); color: var(--po-warning); }
    .sa-status-completed { background: var(--po-info-bg); color: var(--po-info); }
    .sa-status-error { background: var(--po-error-bg); color: var(--po-error); }
    .sa-status-exited { background: var(--po-bg-2); color: var(--po-text-secondary); }

    .btn-close-subagent {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
    }
    .btn-close-subagent:hover {
      background: var(--po-error-bg);
      color: var(--po-error);
    }
    .btn-close-subagent.disabled {
      opacity: 0.2;
      pointer-events: none;
      cursor: default;
    }

    .subagent-pane-terminal {
      flex: 1;
      min-height: 0;
      position: relative;
    }

    /* ── Terminal toolbar ──
       A footer strip at the bottom of every pane — model badge + the pane's
       toggles, same order everywhere. In the FLOW, not floating: the terminal
       ends where the bar starts, so nothing is ever covered. xterm derives its
       rows from the box it gets, and the existing ResizeObserver refits it. */
    .term-toolbar {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      /* Narrow panes (3+ sub-agents in grid): wrap instead of overflowing. */
      flex-wrap: wrap;
      gap: 4px;
      width: 100%;
      padding: 3px 6px;
      background: rgba(13, 17, 23, 0.92);
      border-top: 1px solid var(--po-border-subtle);
      user-select: none;
      /* Size container for the model badge: the toolbar spans the pane, so its
         inline size IS the pane width. Safe because nothing inside it is
         positioned any more — the picker renders at page root. */
      container-type: inline-size;
      container-name: term-toolbar;
    }

    /* Panes stack: terminal (fills) + toolbar (its own height). The terminal
       components declare height:100%, which would ignore the flex box and
       push the footer out — hence height:auto here. */
    .subagent-pane-terminal,
    .main-pane,
    .ide-terminal-area {
      display: flex;
      flex-direction: column;
    }
    .subagent-pane-terminal > app-sub-agent-terminal,
    .subagent-pane-terminal > app-session-terminal,
    .subagent-pane-terminal > app-worker-chat,
    .main-pane > app-session-terminal,
    .ide-terminal-area > app-session-terminal {
      flex: 1 1 auto;
      min-height: 0;
      height: auto;
      /* Breathing room above the bar: xterm fits whole rows, so the leftover
         pixels of the last partial row would otherwise slide under it. */
      margin-bottom: 8px;
    }
    /* ── Toolbar buttons: minimal ──
       Bare icons, no frames and no fills. Color is information, so it shows
       up only on hover and on the states that matter (auto-approve armed, eco
       running) — a row of colored boxes reads as noise above the output. */
    .term-toolbar .btn-aa-overlay,
    .term-toolbar .btn-eco-overlay,
    .term-toolbar .btn-cover-overlay,
    .term-toolbar .btn-chrome-overlay,
    .term-toolbar .btn-review-overlay {
      width: 24px;
      height: 24px;
      border: none;
      border-radius: 5px;
      background: transparent;
      box-shadow: none;
      color: var(--po-text-secondary);
      opacity: 0.7;
    }
    .term-toolbar .btn-aa-overlay:hover,
    .term-toolbar .btn-eco-overlay:hover,
    .term-toolbar .btn-cover-overlay:hover,
    .term-toolbar .btn-chrome-overlay:hover,
    .term-toolbar .btn-review-overlay:hover {
      opacity: 1;
      background: var(--po-bg-2);
      box-shadow: none;
    }
    .term-toolbar .btn-review-overlay:hover { color: #ff4da6; }
    .term-toolbar .btn-eco-overlay:hover { color: var(--po-success); }
    .term-toolbar .btn-cover-overlay:hover { color: var(--po-accent); }
    .term-toolbar .btn-aa-overlay:hover { color: var(--po-error); }
    .term-toolbar .btn-chrome-overlay { display: flex; align-items: center; justify-content: center; cursor: pointer; }
    .term-toolbar .btn-chrome-overlay:hover { opacity: 1; }
    /* Eco actually running: keep it green without a filled chip. */
    .term-toolbar .btn-eco-overlay.eco-on {
      opacity: 1;
      color: var(--po-success);
      background: transparent;
      border: none;
    }
    .term-toolbar .btn-eco-overlay.eco-on:hover {
      color: var(--po-error);
      background: var(--po-bg-2);
      box-shadow: none;
    }

    /* ── Model badge ──
       Which model this terminal is actually running. Dim = the model the CLI
       was launched with; accented = resolved from the provider's own session
       log, so it follows a "/model" switch made inside the TUI.
       (No backticks in here: this comment lives inside the styles template
       literal, and a stray backtick would close it mid-CSS.) */
    .tb-model {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex: 0 1 auto;
      min-width: 0;
      height: 26px;
      max-width: 170px;
      padding: 0 7px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-family: inherit;
      font-size: 0.66rem;
      font-weight: 700;
      letter-spacing: 0.03em;
      color: var(--po-text-secondary);
      background: transparent;
      border: none;
      border-radius: 5px;
      cursor: default;
      opacity: 0.8;
      transition: all 0.15s;
    }
    .tb-model-text {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tb-effort-short {
      display: none;
    }
    .tb-model-logo {
      flex: 0 0 auto;
      border-radius: 2px;
    }
    .tb-model.tb-model-actionable {
      cursor: pointer;
    }
    /* Picker open: keep the badge lit, since in icon-only mode there is no
       label to tell the user which pane the floating menu belongs to. */
    .tb-model.tb-model-open {
      color: var(--po-text-primary);
      border-color: var(--po-accent);
      background: var(--po-accent-muted-bg);
    }

    .tb-model.tb-model-actionable:hover {
      opacity: 1;
      color: var(--po-text-primary);
      background: var(--po-bg-2);
    }
    /* Resolved from the provider's own log: accent on the text alone. */
    .tb-model.tb-model-live {
      opacity: 1;
      color: var(--po-accent);
    }
    /* Slash-model sent, provider hasn't confirmed it yet. */
    .tb-model.tb-model-switching {
      opacity: 1;
      color: var(--po-warning);
      animation: tb-model-pulse 1.1s ease-in-out infinite;
    }
    @keyframes tb-model-pulse {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.55; }
    }

    /* ── Narrow panes: logo only ──
       Below this width the model name is unreadable anyway (and it forced the
       toolbar to wrap, costing the terminal a row). The provider logo alone is
       enough to recognize and click the badge; the tooltip still spells the
       model out, and the floating picker shows the full label. */
    @container term-toolbar (max-width: 300px) {
      .tb-model {
        width: 26px;
        padding: 0;
        gap: 0;
        justify-content: center;
      }
      .tb-model-text {
        display: none;
      }
      .tb-effort {
        flex: 0 0 30px;
        width: 30px;
      }
      .tb-effort-short {
        display: inline;
      }
    }

    /* ── Model picker ──
       Rendered at page root, placed in viewport coordinates: a pane clips its
       own overflow, so an in-pane menu vanished the moment the terminal got
       narrow. z-index sits above the expanded-pane modal (1060) — the picker
       can be opened from an expanded pane too. Opens upward or downward
       depending on where the badge is (see toggleModelMenu). */
    .tb-model-menu {
      position: fixed;
      z-index: 1200;
      display: flex;
      flex-direction: column;
      padding: 4px;
      overflow-y: auto;
      border-radius: 8px;
      background: rgba(13, 17, 23, 0.98);
      border: 1px solid var(--po-border-subtle);
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.55);
    }
    .tb-model-menu-head {
      display: flex;
      align-items: center;
      gap: 5px;
      flex: 0 0 auto;
      padding: 3px 7px 5px;
      font-size: 0.6rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--po-text-secondary);
      opacity: 0.8;
    }
    .tb-model-opt {
      display: block;
      flex: 0 0 auto;
      width: 100%;
      padding: 6px 8px;
      font-family: inherit;
      font-size: 0.7rem;
      font-weight: 600;
      text-align: left;
      color: var(--po-text-primary);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      cursor: pointer;
    }
    .tb-model-opt:hover {
      background: var(--po-bg-2);
    }
    .tb-model-opt.active {
      color: var(--po-accent);
      border-color: var(--po-accent);
    }
    .tb-model-switch {
      margin-top: 4px;
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--po-primary, #6366f1);
      border-top: 1px solid var(--po-border-subtle);
      border-radius: 0 0 6px 6px;
    }
    .tb-model-switch:hover { background: var(--po-primary-bg, rgba(99, 102, 241, .12)); }
    .tb-model-menu-foot {
      flex: 0 0 auto;
      padding: 5px 7px 2px;
      font-size: 0.58rem;
      color: var(--po-text-secondary);
      opacity: 0.7;
    }
    .tb-model-menu-foot code {
      color: inherit;
    }
    .tb-model-default-warn {
      display: flex; align-items: flex-start; gap: 4px;
      opacity: 1; line-height: 1.35;
      color: var(--po-warning, #b45309);
    }
    .tb-model-default-warn iconify-icon { flex-shrink: 0; margin-top: 1px; }

    /* ── Auto-Approve toggle ── */
    .btn-aa-overlay {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border: 2px solid rgba(248, 81, 73, 0.35);
      border-radius: 6px;
      background: var(--po-error-bg);
      color: var(--po-error);
      cursor: pointer;
      transition: all 0.2s;
      opacity: 0.85;
    }
    .btn-aa-overlay:hover {
      opacity: 1;
      background: rgba(248, 81, 73, 0.2);
      border-color: rgba(248, 81, 73, 0.5);
      box-shadow: 0 0 10px rgba(248, 81, 73, 0.35);
    }

    /* ── Eco Mode toggle ── */
    .btn-eco-overlay {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border: 2px solid rgba(63, 185, 80, 0.35);
      border-radius: 6px;
      background: var(--po-success-bg);
      color: var(--po-success);
      cursor: pointer;
      transition: all 0.2s;
      opacity: 0.85;
    }
    .btn-eco-overlay:hover {
      opacity: 1;
      background: rgba(63, 185, 80, 0.2);
      border-color: rgba(63, 185, 80, 0.5);
      box-shadow: 0 0 10px rgba(63, 185, 80, 0.35);
    }
    .btn-eco-overlay.eco-on {
      border-color: rgba(63, 185, 80, 0.45);
      background: rgba(63, 185, 80, 0.12);
      color: var(--po-success);
      opacity: 0.85;
    }
    .btn-eco-overlay.eco-on:hover {
      opacity: 1;
      background: rgba(248, 81, 73, 0.15);
      border-color: rgba(248, 81, 73, 0.45);
      color: var(--po-error);
      box-shadow: 0 0 10px rgba(248, 81, 73, 0.3);
    }
    /* ── Hide-main (cover) toggle — shown when sub-agents exist ── */
    .btn-cover-overlay {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border: 2px solid var(--po-border-subtle);
      border-radius: 6px;
      background: var(--po-accent-muted-bg);
      color: var(--po-accent);
      cursor: pointer;
      transition: all 0.2s;
      opacity: 0.85;
    }
    .btn-cover-overlay:hover {
      opacity: 1;
      border-color: var(--po-accent);
      box-shadow: 0 0 10px var(--po-accent-muted-bg);
    }

    .agent-action-notice {
      position: absolute; top: 38px; right: 8px; z-index: 30;
      background: #eee8b9; color: #111; border: 0; border-radius: 4px;
      padding: 3px 6px; font-size: 10px; line-height: 1.3; cursor: pointer;
      max-width: 220px; text-align: left; box-shadow: 0 1px 4px #0001;
    }
    /* ── Check with another provider ── */
    .btn-review-overlay {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border: 2px solid rgba(255, 77, 166, 0.45);
      border-radius: 6px;
      background: rgba(255, 77, 166, 0.12);
      color: #ff4da6;
      cursor: pointer;
      transition: all 0.2s;
      opacity: 0.9;
    }
    .btn-review-overlay:hover {
      opacity: 1;
      background: rgba(255, 77, 166, 0.25);
      border-color: rgba(255, 77, 166, 0.65);
      box-shadow: 0 0 10px rgba(255, 77, 166, 0.35);
    }
    /* ── Per-pane Auto-Approve mode quick-switch ──
       Shown in place of the single shield button when a terminal is
       auto-approved. Lets the user flip between Quick and AI (or turn
       off) without re-entering the selection overlay. Sits inside the
       toolbar, so it just widens the pill instead of covering its
       neighbours the way the old absolute overlay did. */
    .aa-quick-switch {
      display: flex;
      align-items: center;
      gap: 1px;
      padding: 0;
      border-radius: 5px;
      /* Auto-approve armed is worth a hint, not a red frame: a hairline. */
      border: 1px solid rgba(248, 81, 73, 0.25);
      user-select: none;
    }
    .aa-qs-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 7px;
      font-family: inherit;
      font-size: 0.62rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--po-text-secondary);
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .aa-qs-btn iconify-icon {
      font-size: 13px;
    }
    .aa-qs-btn:hover {
      color: var(--po-text-primary);
      background: var(--po-bg-2);
    }
    /* QUICK segment — yellow */
    .aa-qs-btn.quick.active {
      color: var(--po-warning);
      background: rgba(210, 153, 34, 0.14);
      border-color: transparent;
      box-shadow: none;
    }
    .aa-qs-btn.quick:hover:not(.active) {
      color: var(--po-warning);
    }
    /* AI segment — purple */
    .aa-qs-btn.ai.active {
      color: var(--po-accent);
      background: rgba(168, 85, 247, 0.14);
      border-color: transparent;
      box-shadow: none;
    }
    .aa-qs-btn.ai:hover:not(.active) {
      color: var(--po-accent);
    }
    /* Off (✕) segment — red on hover */
    .aa-qs-btn.off {
      padding: 5px 7px;
      color: var(--po-text-secondary);
    }
    .aa-qs-btn.off:hover {
      color: var(--po-error);
      background: var(--po-error-bg);
    }

    /* ── Pane state highlights ──
       Yellow = input required, Green = completed, Purple = focused.
       Rules are ordered so .pane-focused (declared last) wins when the
       user clicks into a pane that is also waiting_input/completed. */
    .main-pane,
    .subagent-pane,
    .ide-terminal-area {
      transition: box-shadow 0.25s ease;
    }

    /* Yellow blink — any sub-agent pane waiting for user input */
    .subagent-pane.pane-input-needed {
      box-shadow: inset 0 0 0 2.5px rgba(234, 179, 8, 0.65),
                  0 0 14px 3px rgba(234, 179, 8, 0.28);
      border-radius: 12px;
      animation: pane-pulse-yellow 1.2s ease-in-out infinite;
    }
    @keyframes pane-pulse-yellow {
      0%, 100% {
        box-shadow: inset 0 0 0 2.5px rgba(234, 179, 8, 0.65),
                    0 0 14px 3px rgba(234, 179, 8, 0.28);
      }
      50% {
        box-shadow: inset 0 0 0 2.5px rgba(234, 179, 8, 0.25),
                    0 0 6px 1px rgba(234, 179, 8, 0.10);
      }
    }

    /* Green blink — sub-agent pane that just completed */
    .subagent-pane.pane-done {
      box-shadow: inset 0 0 0 2.5px rgba(34, 197, 94, 0.60),
                  0 0 14px 3px rgba(34, 197, 94, 0.25);
      border-radius: 12px;
      animation: pane-pulse-green 1.8s ease-in-out infinite;
    }
    @keyframes pane-pulse-green {
      0%, 100% {
        box-shadow: inset 0 0 0 2.5px rgba(34, 197, 94, 0.60),
                    0 0 14px 3px rgba(34, 197, 94, 0.25);
      }
      50% {
        box-shadow: inset 0 0 0 2.5px rgba(34, 197, 94, 0.30),
                    0 0 8px 1px rgba(34, 197, 94, 0.10);
      }
    }

    /* Purple — focused pane (overrides yellow/green via source order) */
    .main-pane.pane-focused,
    .subagent-pane.pane-focused,
    .ide-terminal-area.pane-focused {
      box-shadow: inset 0 0 0 2.5px rgba(139, 92, 246, 0.55),
                  0 0 14px 3px rgba(139, 92, 246, 0.22);
      border-radius: 12px;
      animation: pane-pulse 2s ease-in-out infinite;
    }

    @keyframes pane-pulse {
      0%, 100% {
        box-shadow: inset 0 0 0 2.5px rgba(139, 92, 246, 0.55),
                    0 0 14px 3px rgba(139, 92, 246, 0.22);
      }
      50% {
        box-shadow: inset 0 0 0 2.5px rgba(139, 92, 246, 0.35),
                    0 0 8px 1px rgba(139, 92, 246, 0.10);
      }
    }

    /* Red blink — Auto Approve is ON (takes precedence over other pane states) */
    .main-pane.pane-aa-on,
    .subagent-pane.pane-aa-on,
    .ide-terminal-area.pane-aa-on {
      box-shadow: inset 0 0 0 2.5px rgba(239, 68, 68, 0.70),
                  0 0 16px 3px rgba(239, 68, 68, 0.35) !important;
      border-radius: 12px;
      animation: pane-pulse-red 1s ease-in-out infinite !important;
    }
    @keyframes pane-pulse-red {
      0%, 100% {
        box-shadow: inset 0 0 0 2.5px rgba(239, 68, 68, 0.75),
                    0 0 18px 4px rgba(239, 68, 68, 0.40);
      }
      50% {
        box-shadow: inset 0 0 0 2.5px rgba(239, 68, 68, 0.25),
                    0 0 6px 1px rgba(239, 68, 68, 0.10);
      }
    }

    /* ── Auto-Approve picker card ──
       Compact card: 1-line header (target + step hint) + horizontal row
       of 3 inline buttons (Off / Quick / AI). Designed to stay usable
       even in narrow panes (3-4 sub-agents in split/grid mode).

       Positioned at the BOTTOM of the main pane and at the TOP of
       sub-agent panes so cards cluster near the boundary.

       The .aa-select-overlay wrapper is pointer-events:none so clicks
       on the terminal pass through; only the card itself captures clicks. */
    .aa-select-overlay {
      position: absolute;
      inset: 0;
      z-index: 60;
      display: flex;
      padding: 6px;
      pointer-events: none;
      user-select: none;
    }
    .aa-select-overlay.at-bottom {
      align-items: flex-end;
      justify-content: center;
    }
    .aa-select-overlay.at-top {
      align-items: flex-start;
      justify-content: center;
    }

    .aa-picker-card {
      pointer-events: auto;
      display: flex;
      flex-direction: column;
      gap: 5px;
      width: 100%;
      max-width: 360px;
      min-width: 0;
      padding: 7px 9px 8px;
      border-radius: 9px;
      background: rgba(13, 17, 23, 0.97);
      border: 1px solid rgba(139, 148, 158, 0.3);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55),
                  0 0 0 1px rgba(255, 255, 255, 0.03);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      animation: aa-picker-pop 0.16s ease;
    }
    @keyframes aa-picker-pop {
      from { opacity: 0; transform: translateY(4px) scale(0.98); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .aa-picker-header {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
    }
    .aa-picker-header > iconify-icon {
      font-size: 12px;
      color: var(--po-accent);
      flex-shrink: 0;
    }
    .aa-picker-eyebrow {
      font-size: 0.55rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--po-text-tertiary);
      line-height: 1;
      flex-shrink: 0;
    }
    .aa-picker-sep {
      font-size: 0.6rem;
      color: var(--po-text-tertiary);
      opacity: 0.55;
      flex-shrink: 0;
      line-height: 1;
    }
    .aa-picker-target {
      font-size: 0.7rem;
      font-weight: 700;
      color: var(--po-text-primary);
      letter-spacing: 0.01em;
      line-height: 1.2;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }
    .aa-picker-step {
      font-size: 0.52rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: rgba(168, 85, 247, 0.95);
      background: rgba(168, 85, 247, 0.14);
      padding: 2px 5px;
      border-radius: 4px;
      flex-shrink: 0;
      line-height: 1;
      white-space: nowrap;
    }
    .aa-picker-step.picked {
      color: rgba(74, 222, 128, 0.95);
      background: rgba(74, 222, 128, 0.14);
    }
    .aa-picker-options {
      display: flex;
      gap: 4px;
    }
    .aa-opt {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 6px 5px;
      min-width: 0;
      border: 1.5px solid rgba(139, 148, 158, 0.24);
      border-radius: 6px;
      background: rgba(22, 27, 34, 0.6);
      color: var(--po-text-primary);
      cursor: pointer;
      transition: all 0.15s;
      font-family: inherit;
    }
    .aa-opt iconify-icon {
      font-size: 13px;
      line-height: 1;
      flex-shrink: 0;
      transition: color 0.15s;
    }
    .aa-opt-label {
      font-size: 0.62rem;
      font-weight: 800;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      line-height: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* OFF — neutral gray */
    .aa-opt.off iconify-icon { color: var(--po-text-tertiary); }
    .aa-opt.off:hover {
      border-color: rgba(139, 148, 158, 0.5);
      background: rgba(139, 148, 158, 0.1);
    }
    .aa-opt.off.active {
      border-color: rgba(139, 148, 158, 0.8);
      background: rgba(139, 148, 158, 0.22);
    }
    .aa-opt.off.active iconify-icon { color: var(--po-text-primary); }

    /* QUICK — yellow */
    .aa-opt.quick iconify-icon { color: var(--po-warning); }
    .aa-opt.quick:hover {
      border-color: rgba(210, 153, 34, 0.6);
      background: rgba(210, 153, 34, 0.1);
    }
    .aa-opt.quick.active {
      border-color: var(--po-warning);
      background: rgba(210, 153, 34, 0.3);
      color: #fff;
      box-shadow: 0 0 10px rgba(210, 153, 34, 0.5);
    }
    .aa-opt.quick.active iconify-icon { color: #fff; }

    /* AI — purple */
    .aa-opt.ai iconify-icon { color: var(--po-accent); }
    .aa-opt.ai:hover {
      border-color: rgba(168, 85, 247, 0.6);
      background: rgba(168, 85, 247, 0.1);
    }
    .aa-opt.ai.active {
      border-color: var(--po-accent);
      background: rgba(168, 85, 247, 0.3);
      color: #fff;
      box-shadow: 0 0 10px rgba(168, 85, 247, 0.55);
    }
    .aa-opt.ai.active iconify-icon { color: #fff; }

    /* Narrow panes (grid with 3-4 sub-agents): drop labels, icon-only */
    .aa-picker-card.compact .aa-opt-label { display: none; }
    .aa-picker-card.compact .aa-opt { padding: 6px; }
    .aa-picker-card.compact .aa-picker-step { display: none; }

    /* Picked-pane frames — outline matches the chosen mode so users can
       see at a glance which terminals will run which mode before Apply. */
    .main-pane.aa-picked-quick,
    .subagent-pane.aa-picked-quick,
    .ide-terminal-area.aa-picked-quick {
      box-shadow: inset 0 0 0 3px rgba(210, 153, 34, 0.9),
                  0 0 18px 3px rgba(210, 153, 34, 0.45) !important;
      border-radius: 3px;
    }
    .main-pane.aa-picked-ai,
    .subagent-pane.aa-picked-ai,
    .ide-terminal-area.aa-picked-ai {
      box-shadow: inset 0 0 0 3px rgba(168, 85, 247, 0.9),
                  0 0 18px 3px rgba(168, 85, 247, 0.45) !important;
      border-radius: 3px;
    }

    .sa-attention-badge {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.6rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(210, 153, 34, 0.2);
      color: var(--po-warning);
      animation: badge-pulse 1.2s ease-in-out infinite;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .sa-attention-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--po-warning);
      box-shadow: 0 0 4px var(--po-warning);
      animation: dot-blink 1s ease-in-out infinite;
    }

    @keyframes badge-pulse {
      0%, 100% { background: rgba(210, 153, 34, 0.2); }
      50% { background: rgba(210, 153, 34, 0.35); }
    }

    @keyframes dot-blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.2; }
    }

    /* ── Compact status dot (>3 sub-agents) ── */
    .sa-status-dot-compact {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
      background: rgba(108, 117, 125, 0.5);
    }
    .sadc-running, .sadc-spawning { background: var(--po-success); box-shadow: 0 0 4px rgba(63, 185, 80, 0.4); }
    .sadc-in_progress { background: #8b5cf6; box-shadow: 0 0 4px rgba(139, 92, 246, 0.4); }
    .sadc-waiting_input { background: var(--po-warning); box-shadow: 0 0 4px rgba(210, 153, 34, 0.4); animation: dot-blink 1s ease-in-out infinite; }
    .sadc-completed { background: var(--po-info); }
    .sadc-error { background: var(--po-error); box-shadow: 0 0 4px rgba(248, 81, 73, 0.4); }
    .sadc-exited { background: var(--po-text-tertiary); }
    .sadc-idle { background: rgba(108, 117, 125, 0.5); }

    /* ── Sub-agent expand modal ── */
    .sa-expand-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.65);
      z-index: 1050;
      animation: sa-backdrop-in 0.2s ease-out;
    }
    @keyframes sa-backdrop-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .subagent-pane.sa-expanded {
      position: fixed !important;
      top: 16px;
      left: 16px;
      right: 16px;
      bottom: 16px;
      z-index: 1060;
      width: auto !important;
      height: auto !important;
      flex: none !important;
      border-radius: 8px;
      border: 1px solid rgba(99, 102, 241, 0.35);
      background: var(--po-bg-2);
      box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(99, 102, 241, 0.2);
      animation: sa-expand-in 0.2s ease-out;
    }
    @keyframes sa-expand-in {
      from {
        opacity: 0.8;
        transform: scale(0.95);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }

    .sa-expanded .subagent-pane-header {
      border-radius: 8px 8px 0 0;
      padding: 0.4rem 0.75rem;
    }

    .sa-expanded .subagent-pane-terminal {
      border-radius: 0 0 8px 8px;
    }

    .btn-expand-subagent {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .btn-expand-subagent:hover {
      background: rgba(99, 102, 241, 0.2);
      color: var(--po-accent);
    }
    .btn-expand-subagent.sa-btn-locked {
      color: var(--po-warning);
    }
    .btn-expand-subagent.sa-btn-locked:hover {
      background: rgba(210, 153, 34, 0.15);
      color: var(--po-warning);
    }
    /* Visible lock next to the status when the actions are in the flyout. */
    .sa-lock-indicator {
      background: rgba(210, 153, 34, 0.12);
    }

    /* ── Sub-agent layout mode toggle ── */
    .sa-mode-group {
      display: flex;
      gap: 2px;
      margin-right: 0.35rem;
      background: color-mix(in srgb, var(--po-text-primary, #e6edf3) 5%, transparent);
      border: 1px solid var(--po-border-subtle, rgba(128, 128, 128, 0.25));
      border-radius: 6px;
      padding: 2px;
    }
    .btn-sa-mode {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 22px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    .btn-sa-mode:hover {
      background: color-mix(in srgb, var(--po-text-primary, #e6edf3) 10%, transparent);
      color: var(--po-text-primary, #e6edf3);
    }
    .btn-sa-mode.active {
      background: var(--po-bg-3, rgba(255, 255, 255, 0.14));
      color: var(--po-text-primary, #e6edf3);
      box-shadow: 0 0 0 1px var(--po-border-strong, rgba(128, 128, 128, 0.45));
    }
    /* Full focus toggle next to the layout modes: active = accent, like the old button in the header */
    .btn-sa-mode.sa-focus-btn.active {
      color: var(--po-accent);
      background: rgba(139, 92, 246, 0.2);
      box-shadow: 0 0 0 1px rgba(139, 92, 246, 0.5);
    }
    .btn-sa-mode.sa-focus-btn:hover { color: var(--po-accent); }

    /* ── Sub-agent tab bar ── */
    .sa-tab-bar {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 3px 8px;
      background: var(--po-bg-1, #161b22);
      border-bottom: 1px solid var(--po-border-subtle);
      overflow-x: auto;
      scrollbar-width: none;
      flex-shrink: 0;
    }
    .sa-tab-bar::-webkit-scrollbar { display: none; }

    .sa-tab {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      border: 1px solid transparent;
      border-bottom: none;
      border-radius: 6px 6px 0 0;
      background: transparent;
      color: var(--po-text-secondary);
      font-size: 0.65rem;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s;
      position: relative;
    }
    .sa-tab:hover {
      background: color-mix(in srgb, var(--po-text-primary, #e6edf3) 7%, transparent);
      color: var(--po-text-primary, #e6edf3);
    }
    .sa-tab.sa-tab-active {
      background: var(--po-bg-0, #0d1117);
      border-color: var(--po-border-subtle, rgba(128, 128, 128, 0.25));
      box-shadow: inset 0 2px 0 var(--po-text-primary, #e6edf3);
      color: var(--po-text-primary, #e6edf3);
      font-weight: 600;
    }
    .sa-tab.sa-tab-locked {
      border-color: rgba(210, 153, 34, 0.35);
      border-style: solid;
    }
    .sa-tab.sa-tab-locked .sa-tab-destroy {
      opacity: 0.2;
      pointer-events: none;
    }
    .sa-tab.sa-tab-needs-input {
      animation: sa-tab-glow 1.5s ease-in-out infinite;
      border-color: rgba(210, 153, 34, 0.5) !important;
      opacity: 1 !important;
    }
    @keyframes sa-tab-glow {
      0%, 100% {
        background: rgba(210, 153, 34, 0.1);
        box-shadow: 0 0 8px rgba(210, 153, 34, 0.25);
      }
      50% {
        background: rgba(210, 153, 34, 0.3);
        box-shadow: 0 0 14px rgba(210, 153, 34, 0.5);
      }
    }

    .sa-tab-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .sa-tab-dot.dot-running { background: var(--po-success); }
    .sa-tab-dot.dot-spawning { background: var(--po-warning); }
    .sa-tab-dot.dot-waiting_input { background: var(--po-warning); animation: dot-blink 1s ease-in-out infinite; }
    .sa-tab-dot.dot-completed { background: var(--po-info); }
    .sa-tab-dot.dot-error { background: var(--po-error); }

    .sa-tab-close {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s;
      padding: 0;
    }
    .sa-tab:hover .sa-tab-close {
      opacity: 0.5;
    }
    .sa-tab-close:hover {
      opacity: 1 !important;
      color: var(--po-error);
    }
    .sa-tab-close.disabled {
      opacity: 0.15 !important;
      pointer-events: none;
      cursor: default;
    }

    .sa-tab-shortcut {
      font-size: 0.5rem;
      color: var(--po-text-secondary);
      opacity: 0.4;
      font-family: monospace;
      letter-spacing: 0;
    }

    /* Tab mode: hide non-active panes while keeping xterm rendered with
       real dimensions. Using display:none causes xterm to initialize with
       a 0×0 canvas that never re-renders properly.  Instead we use
       visibility:hidden + position:absolute so the pane is painted
       off-flow but retains its size, allowing ResizeObserver to fire
       when the pane becomes visible again. */
    .subagents-terminals.tab-mode {
      flex-direction: column;
      position: relative;
    }
    .subagents-terminals.tab-mode .subagent-pane {
      border-right: none;
      border-bottom: none;
    }
    .subagents-terminals.tab-mode .subagent-pane.sa-tab-hidden {
      visibility: hidden;
      position: absolute;
      /* Absolute insets resolve against the PADDING box — mirror the
         container's padding so the hidden pane keeps the exact size of the
         visible one (see --sa-pad-* on .subagents-terminals). */
      top: var(--sa-pad-top);
      left: var(--sa-pad-x);
      right: var(--sa-pad-x);
      bottom: var(--sa-pad-bottom);
      pointer-events: none;
      z-index: -1;
    }

    /* ── Minimized strip at bottom ── */
    .sa-minimized-strip {
      display: flex;
      gap: 4px;
      padding: 3px 8px;
      background: rgba(0, 0, 0, 0.15);
      border-top: 1px solid var(--po-border-subtle);
      flex-shrink: 0;
      flex-wrap: wrap;
      align-items: center;
    }
    .sa-minimized-strip-label {
      font-size: 0.55rem;
      text-transform: uppercase;
      color: var(--po-text-secondary);
      opacity: 0.5;
      letter-spacing: 0.04em;
      margin-right: 2px;
    }
    .sa-minimized-chip {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--po-accent-muted-bg);
      border: 1px solid rgba(99, 102, 241, 0.15);
      color: var(--po-text-secondary);
      font-size: 0.62rem;
      cursor: pointer;
      transition: all 0.15s;
    }
    .sa-minimized-chip:hover {
      background: rgba(99, 102, 241, 0.18);
      color: var(--po-accent);
      border-color: rgba(99, 102, 241, 0.35);
    }
    .sa-minimized-chip.chip-needs-input {
      animation: sa-tab-glow 1.5s ease-in-out infinite;
      border-color: rgba(210, 153, 34, 0.5);
      color: var(--po-warning);
    }

    /* ── Locked pane in split/list mode ── */
    .subagent-pane.sa-pane-locked .btn-close-subagent {
      opacity: 0.2;
      pointer-events: none;
    }
    .sa-lock-icon {
      color: var(--po-warning);
      font-size: 11px;
      flex-shrink: 0;
    }

    /* ── Shortcut hints bar ── */
    .sa-shortcut-bar {
      display: flex;
      gap: 14px;
      padding: 4px 10px;
      border-top: 1px solid var(--po-border-subtle);
      flex-shrink: 0;
      align-items: center;
      background: rgba(0, 0, 0, 0.12);
    }
    .sa-shortcut-hint {
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 0.65rem;
      color: var(--po-text-secondary);
      opacity: 0.65;
    }
    .sa-shortcut-hint kbd {
      font-size: 0.62rem;
      padding: 1px 5px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--po-accent);
      font-family: -apple-system, BlinkMacSystemFont, monospace;
      line-height: 1.4;
    }

    /* ── Drop zone (visible only while dragging files) ── */
    .sa-drag-over {
      outline: 2px dashed rgba(99, 102, 241, 0.55);
      outline-offset: -6px;
      border-radius: 14px;
    }
    .sa-drop-overlay {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 80;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.6rem 1.1rem;
      font-size: 0.78rem;
      font-weight: 600;
      color: #e0e7ff;
      background: rgba(23, 24, 36, 0.9);
      backdrop-filter: blur(14px) saturate(1.4);
      -webkit-backdrop-filter: blur(14px) saturate(1.4);
      border: 1px solid rgba(99, 102, 241, 0.4);
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5), 0 0 24px rgba(99, 102, 241, 0.2);
      pointer-events: none;
      user-select: none;
      white-space: nowrap;
    }
    .sa-drop-overlay iconify-icon {
      color: #818cf8;
    }

    /* ── Grid mode: responsive 2D grid ── */
    .subagents-terminals.grid-mode {
      display: grid;
      /* columns/rows come inline from saGridLayout() */
      gap: 6px;
      background: transparent;
    }
    .subagents-terminals.grid-mode {
      position: relative;
    }
    .sa-grid-handle {
      position: absolute;
      z-index: 6;
      transition: background 0.15s;
    }
    .sa-grid-handle-col {
      top: var(--sa-pad-top);
      bottom: var(--sa-pad-bottom);
      width: 8px;
      cursor: col-resize;
    }
    .sa-grid-handle-row {
      left: var(--sa-pad-x);
      right: var(--sa-pad-x);
      height: 8px;
      cursor: row-resize;
    }
    .sa-grid-handle::after {
      content: '';
      position: absolute;
      border-radius: 2px;
      background: transparent;
      transition: background 0.15s;
    }
    .sa-grid-handle-corner {
      width: 16px;
      height: 16px;
      margin: -4px 0 0 -4px;
      cursor: move;
      z-index: 7;
    }
    .sa-grid-handle-corner::after {
      inset: 5px;
      border-radius: 50%;
    }
    .sa-grid-handle-col::after { top: 0; bottom: 0; left: 3px; width: 2px; }
    .sa-grid-handle-row::after { left: 0; right: 0; top: 3px; height: 2px; }
    .sa-grid-handle:hover::after,
    .sa-reordering .sa-grid-handle::after {
      background: rgba(129, 140, 248, 0.55);
    }
    .btn-sa-mode.sa-mode-auto {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      width: auto;
      padding: 0 5px;
    }
    .sa-auto-label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.06em;
      line-height: 1;
    }
    .btn-sa-mode.auto-suspended .sa-auto-label {
      opacity: 0.5;
      text-decoration: line-through;
    }
    .subagents-terminals.grid-mode .sa-drag-handle {
      cursor: grab;
    }
    .subagents-terminals.grid-mode.sa-reordering .subagent-pane-terminal {
      pointer-events: none;
    }
    .subagents-terminals.grid-mode .subagent-pane {
      position: relative;
      transition: opacity 0.22s ease, transform 0.28s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.22s ease;
    }
    .subagents-terminals.grid-mode .subagent-pane.sa-dragging {
      opacity: 0.45;
      transform: scale(0.985);
    }
    /* "Liquid glass" target: translucent veil with a reflection, WITHOUT backdrop-filter
       on the pane (blurring a large WebGL canvas on every frame is expensive). */
    .subagents-terminals.grid-mode .subagent-pane::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s ease;
      background:
        radial-gradient(120% 80% at 20% 0%, rgba(255, 255, 255, 0.14), transparent 55%),
        linear-gradient(160deg, rgba(129, 140, 248, 0.16), rgba(129, 140, 248, 0.04));
      box-shadow: inset 0 0 0 1.5px rgba(165, 180, 252, 0.75), inset 0 1px 0 rgba(255, 255, 255, 0.35);
    }
    .subagents-terminals.grid-mode .subagent-pane.sa-drop-target::after {
      opacity: 1;
    }
    .subagents-terminals.grid-mode .subagent-pane.sa-drop-target {
      transform: scale(0.992);
      box-shadow: 0 0 0 4px rgba(129, 140, 248, 0.14), 0 10px 28px rgba(0, 0, 0, 0.35);
    }
    @media (prefers-reduced-motion: reduce) {
      .subagents-terminals.grid-mode .subagent-pane { transition: none; }
    }
    .subagents-terminals.grid-mode .subagent-pane {
      background: #0c0e16;
    }
    .subagents-terminals.grid-mode .subagent-pane.sa-pane-locked .btn-close-subagent {
      opacity: 0.2;
      pointer-events: none;
    }

    /* ══════ FOCUS MODE: true fullscreen ══════ */
    .sessions-page.focus-mode {
      position: fixed !important;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 2000;
      height: 100vh !important;
      background: var(--po-bg-0);
    }
    .sessions-page.focus-mode .sessions-layout {
      height: 100vh;
    }
    .sessions-page.focus-mode .sessions-layout > app-session-sidebar,
    .sessions-page.focus-mode .sessions-layout > .sessions-sidebar-resize {
      display: none !important;
    }
    .sessions-page.focus-mode .sessions-main > app-session-header {
      display: none !important;
    }
    .sessions-page.focus-mode .sessions-main > app-add-note-modal,
    .sessions-page.focus-mode .sessions-main > app-todo-modal {
      display: none !important;
    }
    .sessions-page.focus-mode .action-center-wrapper {
      display: none !important;
    }
    .sessions-page.focus-mode app-session-assets-panel,
    .sessions-page.focus-mode app-session-git-panel {
      display: none !important;
    }
    .sessions-page.focus-mode .sessions-content {
      padding: 6px;
      gap: 6px;
    }

    /* Main pane border + label in focus mode */
    .sessions-page.focus-mode .terminal-area.has-subagents .main-pane {
      border: 1px solid rgba(99, 102, 241, 0.35);
      border-radius: 8px;
      overflow: hidden;
    }
    .focus-pane-label {
      display: none;
    }
    .sessions-page.focus-mode .focus-pane-label {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 3px 10px;
      font-size: 0.6rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      flex-shrink: 0;
    }
    .sessions-page.focus-mode .focus-pane-label.fpl-main {
      color: rgba(165, 180, 252, 0.7);
      background: rgba(99, 102, 241, 0.06);
      border-bottom: 1px solid rgba(99, 102, 241, 0.15);
    }

    /* Sub-agents group border in focus mode */
    .sessions-page.focus-mode .subagents-accordion {
      border: 1px solid rgba(63, 185, 80, 0.35) !important;
      border-radius: 8px;
      overflow: hidden;
    }
    .sessions-page.focus-mode .subagents-accordion-header {
      background: rgba(63, 185, 80, 0.06);
    }
    .sessions-page.focus-mode .subagents-accordion-header:hover {
      background: rgba(63, 185, 80, 0.12);
    }
    .sessions-page.focus-mode .subagents-accordion-title {
      color: var(--po-success);
    }

    /* Exiting focus when the bar toggle is not on screen: in-flow strip 26px tall, icon only */
    .focus-strip {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      height: 26px;
      flex-shrink: 0;
      padding: 0 6px;
      background: var(--po-bg-1);
      border-bottom: 1px solid var(--po-border-subtle, rgba(128, 128, 128, 0.2));
    }
    .sessions-page.focus-mode.has-focus-strip .sessions-layout {
      height: calc(100vh - 26px);
    }

    /* ── Action center wrapper (resizable) ── */
    .action-center-wrapper {
      position: relative;
      flex-shrink: 0;
      min-width: 200px;
      max-width: 50%;
      height: 100%;
      transition: width 0.2s;
    }
    .action-center-wrapper.ac-collapsed {
      min-width: 40px;
    }
    .action-center-wrapper > app-action-center {
      display: block;
      height: 100%;
    }
    .action-center-wrapper > app-action-center ::ng-deep .action-center {
      width: 100% !important;
    }

    .panel-resize-handle {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 4px;
      cursor: col-resize;
      z-index: 5;
      transition: background 0.15s;
    }
    .panel-resize-handle:hover,
    .panel-resize-handle:active {
      background: var(--po-accent-muted-bg);
    }
    .panel-resize-left {
      left: -2px;
    }

    /* ── Sub-agents resize handle ── */
    .subagents-resize-handle {
      height: 4px;
      cursor: row-resize;
      flex-shrink: 0;
      position: relative;
      z-index: 5;
      transition: background 0.15s;
    }
    .subagents-resize-handle:hover,
    .subagents-resize-handle:active {
      background: var(--po-accent-muted-bg);
    }

    .empty-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }

    /* ═══ BOOTSTRAP LOADER (first sessions fetch, before we know if user has any) ═══ */

    .bootstrap-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 20px;
      padding: 48px 24px;
      background:
        radial-gradient(ellipse at top left, rgba(99, 102, 241, 0.06), transparent 55%),
        radial-gradient(ellipse at bottom right, rgba(168, 85, 247, 0.06), transparent 55%);
      animation: bootstrap-fade-in 240ms ease-out;
    }

    .bootstrap-logo-wrap {
      position: relative;
      width: 96px;
      height: 96px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .bootstrap-halo {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(99, 102, 241, 0.28) 0%, rgba(168, 85, 247, 0.18) 45%, transparent 70%);
      filter: blur(8px);
      animation: bootstrap-halo-pulse 1.6s ease-in-out infinite;
    }

    .bootstrap-logo {
      position: relative;
      width: 72px;
      height: 72px;
      object-fit: contain;
      user-select: none;
      -webkit-user-drag: none;
      animation: bootstrap-logo-pop 1.6s ease-in-out infinite;
      filter: drop-shadow(0 4px 12px rgba(99, 102, 241, 0.22));
    }

    .bootstrap-dots {
      display: inline-flex;
      gap: 6px;
    }

    .bootstrap-dots span {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: linear-gradient(135deg, #6366f1, #a855f7);
      opacity: 0.35;
      animation: bootstrap-dot-bounce 1.2s ease-in-out infinite;
    }
    .bootstrap-dots span:nth-child(2) { animation-delay: 0.15s; }
    .bootstrap-dots span:nth-child(3) { animation-delay: 0.3s; }

    @keyframes bootstrap-fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    @keyframes bootstrap-halo-pulse {
      0%, 100% { transform: scale(0.92); opacity: 0.75; }
      50%      { transform: scale(1.12); opacity: 1; }
    }

    @keyframes bootstrap-logo-pop {
      0%, 100% { transform: scale(1); }
      50%      { transform: scale(1.07); }
    }

    @keyframes bootstrap-dot-bounce {
      0%, 100% { transform: translateY(0);    opacity: 0.35; }
      50%      { transform: translateY(-4px); opacity: 1; }
    }

    @media (prefers-reduced-motion: reduce) {
      .bootstrap-halo,
      .bootstrap-logo,
      .bootstrap-dots span,
      .bootstrap-main { animation: none !important; }
    }

    /* ═══ WELCOME STATE (first-time user, sessions === 0) ═══ */

    .welcome-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 48px 24px;
      gap: 28px;
      background:
        radial-gradient(ellipse at top left, rgba(99, 102, 241, 0.06), transparent 55%),
        radial-gradient(ellipse at bottom right, rgba(168, 85, 247, 0.06), transparent 55%);
    }

    .welcome-hero {
      text-align: center;
      max-width: 560px;
    }

    .welcome-emoji {
      font-size: 40px;
      margin-bottom: 10px;
      display: inline-block;
      animation: welcome-wave 1.8s ease-in-out;
      transform-origin: 70% 70%;
    }

    @keyframes welcome-wave {
      0%, 60%, 100% { transform: rotate(0); }
      10%, 30% { transform: rotate(14deg); }
      20% { transform: rotate(-8deg); }
      40% { transform: rotate(14deg); }
      50% { transform: rotate(-4deg); }
    }

    .welcome-title {
      font-size: 26px;
      font-weight: 700;
      margin: 0 0 8px;
      line-height: 1.25;
      background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      color: transparent;
    }

    .welcome-subtitle {
      font-size: 15px;
      color: var(--bs-secondary-color, #6c757d);
      margin: 0;
      line-height: 1.55;
    }

    .welcome-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      width: 100%;
      max-width: 820px;
    }

    .quickstart-card {
      position: relative;
      text-align: left;
      background: var(--bs-tertiary-bg, #f8f9fa);
      border: 1.5px solid transparent;
      border-radius: 14px;
      padding: 18px 18px 44px;
      cursor: pointer;
      transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
      font: inherit;
      color: inherit;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-height: 150px;
      overflow: hidden;
    }

    .quickstart-card:hover {
      transform: translateY(-3px);
      box-shadow: 0 12px 24px -10px rgba(99, 102, 241, 0.32);
      border-color: rgba(99, 102, 241, 0.35);
    }

    .quickstart-card[data-accent="indigo"] .qs-icon { background: linear-gradient(135deg, #6366f1, #818cf8); }
    .quickstart-card[data-accent="purple"] .qs-icon { background: linear-gradient(135deg, #a855f7, #c084fc); }
    .quickstart-card[data-accent="violet"] .qs-icon { background: linear-gradient(135deg, #7c3aed, #a78bfa); }

    .qs-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      box-shadow: 0 6px 14px -6px rgba(99, 102, 241, 0.55);
      margin-bottom: 4px;
    }

    .qs-title {
      font-size: 15px;
      font-weight: 600;
      margin: 0;
      color: var(--bs-body-color, #1f2937);
    }

    .qs-desc {
      font-size: 13px;
      color: var(--bs-secondary-color, #6c757d);
      margin: 0;
      line-height: 1.45;
    }

    .qs-arrow {
      position: absolute;
      right: 14px;
      bottom: 12px;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: rgba(99, 102, 241, 0.12);
      color: #6366f1;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform .18s ease, background .18s ease;
    }

    .quickstart-card:hover .qs-arrow {
      transform: translateX(3px);
      background: #6366f1;
      color: #fff;
    }

    .welcome-blank-link {
      background: none;
      border: none;
      color: var(--bs-secondary-color, #6c757d);
      font-size: 13px;
      cursor: pointer;
      padding: 6px 14px;
      border-radius: 8px;
      transition: color .18s ease, background .18s ease;
    }

    .welcome-blank-link:hover {
      color: #6366f1;
      background: rgba(99, 102, 241, 0.08);
    }

    @media (max-width: 600px) {
      .welcome-main { padding: 32px 16px; gap: 20px; }
      .welcome-title { font-size: 22px; }
      .welcome-grid { grid-template-columns: 1fr; gap: 12px; }
    }

    /* ═══ IDE LAYOUT ═══ */

    .ide-layout {
      flex: 1;
      display: flex;
      min-height: 0;
      overflow: hidden;
    }

    .ide-panel {
      display: flex;
      flex-direction: column;
      min-height: 0;
      position: relative;
      overflow: hidden;
    }

    .ide-panel.collapsed {
      width: 32px !important;
      min-width: 32px;
      overflow: hidden;
    }

    .ide-panel-center {
      flex: 1;
      min-width: 300px;
    }

    .ide-panel-center > app-session-code-editor {
      display: block;
      height: 100%;
    }

    .ide-panel-right {
      border-left: 1px solid var(--po-border-subtle);
      width: 20%;
      min-width: 200px;
      max-width: 60%;
      transition: width 0.2s ease;
    }
    .ide-panel-right.collapsed {
      min-width: 32px;
    }

    .ide-right-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
    }

    .ide-terminal-area {
      flex: 1;
      min-height: 0;
    }

    .ide-terminal-tabs { display: flex; flex-shrink: 0; overflow-x: auto; border-bottom: 1px solid var(--po-border-subtle); padding-right: 24px; }
    .ide-terminal-tabs button { display: flex; align-items: center; gap: 6px; flex-shrink: 0; max-width: 220px; overflow: hidden; white-space: nowrap; background: transparent; color: var(--po-text-muted); border: 0; border-bottom: 2px solid transparent; padding: 10px 12px; }
    .ide-terminal-tabs button.active { color: var(--po-text-primary); border-bottom-color: #818cf8; }
    .ide-terminal-stack { display: flex; flex-direction: column; flex: 1; min-height: 120px; overflow: hidden; }
    .ide-terminal-stack > .subagent-pane { flex: 1; min-height: 0; }
    .ide-spawn-composer { flex-shrink: 0; max-height: 55%; overflow-y: auto; }

    /* ── IDE Accordion Sections ── */

    .ide-accordion-section {
      border-top: 1px solid var(--po-border-subtle);
      flex-shrink: 0;
      overflow: hidden;
    }
    .ide-accordion-section.open {
      flex: none;
      min-height: 120px;
      max-height: 70%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .ide-accordion-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.35rem;
      padding: 0.35rem 0.6rem;
      background: var(--po-bg-2);
      cursor: pointer;
      user-select: none;
      transition: background 0.12s;
      min-width: 0;
      overflow: hidden;
    }
    .ide-accordion-header:hover {
      background: rgba(255, 255, 255, 0.04);
    }
    .ide-accordion-section.ide-acc-hint:not(.open) .ide-accordion-header {
      background: rgba(var(--bs-primary-rgb, 59, 130, 246), 0.06);
      border-left: 2px solid rgba(var(--bs-primary-rgb, 59, 130, 246), 0.35);
    }
    .ide-accordion-section.ide-acc-hint:not(.open) .ide-accordion-header:hover {
      background: rgba(var(--bs-primary-rgb, 59, 130, 246), 0.10);
    }
    .ide-acc-warning {
      background: rgba(210, 153, 34, 0.08);
    }

    .ide-accordion-title {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--po-text-secondary);
      min-width: 0;
      flex: 1 1 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ide-accordion-title > iconify-icon {
      flex-shrink: 0;
    }

    .ide-acc-badge {
      font-size: 0.58rem;
      font-weight: 700;
      padding: 0px 5px;
      border-radius: 999px;
      color: #fff;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .ide-acc-badge.bg-success { background: rgba(63, 185, 80, 0.8); }
    .ide-acc-badge.bg-primary { background: rgba(99, 102, 241, 0.7); }
    .ide-acc-badge.bg-warning { background: rgba(210, 153, 34, 0.8); }

    .ide-acc-chevron {
      color: var(--po-text-secondary);
      flex-shrink: 0;
    }

    .ide-accordion-body {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 0.4rem 0.5rem;
      scrollbar-width: thin;
      scrollbar-color: var(--po-border-subtle) transparent;
    }

    .ide-empty-section {
      text-align: center;
      padding: 0.75rem;
      font-size: 0.75rem;
      color: var(--po-text-secondary);
      font-style: italic;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Panchinari (benched sub-agents) — IDE sidebar.
       Same visual language as the active panes (radius/padding/layout),
       distinguished by a recessed "disabled" background + muted text. */
    .ide-bench-list {
      margin-top: 0.4rem;
      padding-top: 0.4rem;
      border-top: 1px dashed var(--po-border);
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .ide-bench-label {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.6rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--po-text-tertiary);
      margin-bottom: 0.15rem;
    }
    .ide-bench-item {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.25rem 0.55rem;
      border-radius: 12px;
      border: 1px solid var(--po-border-subtle);
      background: var(--po-bg-2);
      cursor: pointer;
      filter: saturate(0.6);
      transition: background 0.15s, filter 0.15s;
    }
    .ide-bench-item:hover {
      background: var(--po-bg-3);
      filter: saturate(1);
    }
    .ide-bench-name {
      flex: 1;
      min-width: 0;
      font-size: 0.7rem;
      font-weight: 600;
      color: var(--po-text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .btn-expand-subagent.bench-back {
      color: #d946ef;
    }
    .btn-expand-subagent.bench-back:hover {
      color: #e879f9;
    }

    /* Provider usage accordion detail */
    .provider-usage-detail {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      padding: 0.35rem 0.5rem;
      font-size: 0.72rem;
    }
    .pu-row {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    .pu-row-label {
      flex: 0 0 auto;
      min-width: 80px;
      color: var(--po-text-tertiary);
      font-size: 0.66rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pu-bar-wrap {
      flex: 1;
      height: 6px;
      background: var(--po-bg-3, rgba(255,255,255,0.06));
      border-radius: 3px;
      overflow: hidden;
    }
    .pu-bar {
      height: 100%;
      background: var(--po-accent, #818cf8);
      border-radius: 3px;
      transition: width 0.4s ease;
    }
    .pu-bar-warn { background: var(--po-danger, #f85149); }
    .pu-row-pct {
      flex: 0 0 auto;
      min-width: 28px;
      text-align: right;
      font-family: var(--po-font-mono, monospace);
      font-weight: 600;
      font-size: 0.7rem;
      color: var(--po-text-primary);
    }
    .pu-warn { color: var(--po-danger, #f85149) !important; }
    .pu-row-reset {
      color: var(--po-text-tertiary);
      font-size: 0.62rem;
      padding-left: 84px;
      margin-bottom: 0.25rem;
    }
    .pu-row-meta {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding-top: 0.2rem;
      border-top: 1px solid var(--po-border-subtle);
      margin-top: 0.15rem;
      font-size: 0.65rem;
      color: var(--po-text-tertiary);
    }
    .pu-extra-off {
      color: var(--po-text-tertiary);
      opacity: 0.6;
    }

    /* Quick agent grid */
    .ide-quick-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.25rem;
      margin-bottom: 0.4rem;
      overflow: hidden;
    }

    .ide-quick-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.15rem;
      padding: 0.35rem 0.25rem;
      border: 1px solid var(--po-border-subtle);
      border-radius: 6px;
      background: transparent;
      color: var(--po-text-primary);
      font-size: 0.65rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.12s;
      overflow: hidden;
      min-width: 0;
    }
    .ide-quick-btn span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }
    .ide-quick-btn:hover {
      background: var(--po-bg-2);
      border-color: rgba(88, 166, 255, 0.3);
    }

    .ide-active-agents {
      display: flex;
      flex-direction: column;
    }

    /* Quick action slots */
    .ide-slot-card {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.3rem 0.4rem;
      border-radius: 5px;
      transition: background 0.12s;
    }
    .ide-slot-card:hover {
      background: rgba(255, 255, 255, 0.04);
    }

    .ide-slot-icon {
      width: 20px;
      text-align: center;
      flex-shrink: 0;
      color: var(--po-text-secondary);
    }

    .ide-slot-label {
      flex: 1;
      font-size: 0.75rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ide-slot-run {
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
      flex-shrink: 0;
      transition: all 0.12s;
    }
    .ide-slot-run:hover {
      background: rgba(63, 185, 80, 0.15);
      color: var(--po-success);
    }

    /* Interaction cards */
    .ide-interaction-card {
      padding: 0.4rem;
      border: 1px solid var(--po-border-subtle);
      border-radius: 6px;
      margin-bottom: 0.3rem;
      background: rgba(210, 153, 34, 0.05);
    }

    .ide-interaction-prompt {
      font-size: 0.75rem;
      margin: 0 0 0.3rem;
      color: var(--po-text-primary);
      line-height: 1.35;
    }

    .ide-interaction-btns {
      display: flex;
      gap: 0.3rem;
    }

    .ide-interaction-input {
      display: flex;
      gap: 0.3rem;
    }

    .ide-panel-resize {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 4px;
      cursor: col-resize;
      z-index: 5;
      transition: background 0.15s;
    }
    .ide-panel-resize:hover,
    .ide-panel-resize:active {
      background: var(--po-accent-muted-bg);
    }

    .ide-resize-right {
      left: -2px;
    }

    .ide-collapse-btn {
      position: absolute;
      z-index: 6;
      top: 50%;
      transform: translateY(-50%);
      width: 20px;
      height: 40px;
      border: 1px solid var(--po-border-subtle);
      background: var(--po-bg-2);
      color: var(--po-text-secondary);
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }
    .ide-collapse-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--po-text-primary);
    }

    .ide-collapse-right {
      left: -12px;
    }

    /* When collapsed, center the toggle button */
    .ide-panel.collapsed .ide-collapse-btn {
      position: static;
      transform: none;
      width: 100%;
      height: 40px;
      margin-top: auto;
      margin-bottom: auto;
      border: none;
      border-radius: 0;
    }

    /* Responsive: on small screens, collapse right panel */
    @media (max-width: 900px) {
      .ide-panel-right {
        width: 32px !important;
        min-width: 32px;
        overflow: hidden;
      }
    }

    /* ── Provider Install Guide ── */
    .provider-install-guide {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
      overflow-y: auto;
      background: var(--po-bg-1);
    }

    .install-guide-card {
      max-width: 720px;
      width: 100%;
      background: linear-gradient(180deg, rgba(99, 102, 241, 0.04), rgba(139, 92, 246, 0.02));
      border: 1px solid rgba(139, 92, 246, 0.18);
      border-radius: 14px;
      padding: 2rem 2.25rem 1.75rem;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.15);
    }

    .install-guide-header {
      display: flex;
      align-items: flex-start;
      gap: 1rem;
      margin-bottom: 1.25rem;
    }

    .install-guide-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      flex-shrink: 0;
      border-radius: 12px;
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.18), rgba(139, 92, 246, 0.18));
      color: #a78bfa;
    }

    .install-guide-heading {
      flex: 1;
      min-width: 0;
    }

    .install-guide-heading h3 {
      margin: 0;
      font-size: 1.2rem;
      font-weight: 600;
      letter-spacing: -0.01em;
    }

    .install-guide-heading p {
      margin: 0.25rem 0 0;
      font-size: 0.85rem;
      color: rgba(255, 255, 255, 0.5);
    }

    .install-platform-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      background: rgba(139, 92, 246, 0.14);
      color: #c4b5fd;
      border: 1px solid rgba(139, 92, 246, 0.25);
      border-radius: 999px;
      padding: 0.25rem 0.7rem;
      font-size: 0.75rem;
      font-weight: 500;
      white-space: nowrap;
      align-self: center;
    }

    /* ── Install tabs ── */
    .install-tabs {
      display: flex;
      gap: 0.4rem;
      background: rgba(0, 0, 0, 0.25);
      padding: 0.35rem;
      border-radius: 10px;
      margin-bottom: 1.25rem;
    }
    .install-tab {
      flex: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 0.6rem 0.9rem;
      border: none;
      background: transparent;
      color: rgba(255, 255, 255, 0.55);
      border-radius: 8px;
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .install-tab:hover {
      color: rgba(255, 255, 255, 0.85);
      background: rgba(255, 255, 255, 0.04);
    }
    .install-tab.active {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.22), rgba(139, 92, 246, 0.22));
      color: #fff;
      box-shadow: inset 0 0 0 1px rgba(139, 92, 246, 0.4);
    }
    .install-tab-chip {
      font-size: 0.65rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0.1rem 0.45rem;
      border-radius: 4px;
      background: rgba(63, 185, 80, 0.2);
      color: #7ee787;
    }
    .install-tab:not(.active) .install-tab-chip {
      background: rgba(63, 185, 80, 0.1);
    }

    .install-tab-panel {
      animation: install-tab-fade 0.2s ease;
    }
    @keyframes install-tab-fade {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* ── Manual platform picker ── */
    .manual-platform-picker {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
      padding: 0.75rem 0.9rem;
      margin-bottom: 1.25rem;
      background: rgba(0, 0, 0, 0.18);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 10px;
    }
    .manual-platform-label {
      font-size: 0.78rem;
      font-weight: 500;
      color: rgba(255, 255, 255, 0.55);
    }
    .manual-platform-pills {
      display: flex;
      gap: 0.35rem;
      flex: 1;
      flex-wrap: wrap;
    }
    .manual-platform-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.4rem 0.9rem;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.02);
      color: rgba(255, 255, 255, 0.65);
      border-radius: 999px;
      font-size: 0.8rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .manual-platform-pill:hover {
      border-color: rgba(139, 92, 246, 0.35);
      color: #fff;
    }
    .manual-platform-pill.active {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.25), rgba(139, 92, 246, 0.25));
      border-color: rgba(139, 92, 246, 0.55);
      color: #fff;
    }

    /* ── Manual step extras ── */
    .install-step-hint {
      margin-top: 0.4rem !important;
      font-size: 0.76rem !important;
      color: rgba(255, 255, 255, 0.45) !important;
    }
    .install-step-hint a {
      color: #a78bfa;
      text-decoration: underline;
    }
    .install-external-link {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      margin-top: 0.4rem;
      font-size: 0.8rem;
      color: #a78bfa;
      text-decoration: none;
    }
    .install-external-link:hover {
      color: #c4b5fd;
      text-decoration: underline;
    }
    .install-troubleshoot {
      margin-top: 0.75rem;
      padding: 0.7rem 0.85rem;
      background: rgba(250, 204, 21, 0.06);
      border: 1px solid rgba(250, 204, 21, 0.2);
      border-radius: 8px;
    }
    .install-troubleshoot-head {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      color: #fde047;
      margin-bottom: 0.35rem;
    }
    .install-troubleshoot-head strong {
      font-size: 0.82rem;
    }
    .install-troubleshoot p {
      margin: 0 0 0.5rem !important;
      font-size: 0.78rem !important;
      color: rgba(255, 255, 255, 0.6) !important;
    }

    .install-info-box {
      display: flex;
      align-items: flex-start;
      gap: 0.7rem;
      padding: 0.75rem 0.9rem;
      margin-bottom: 1rem;
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(139, 92, 246, 0.06));
      border: 1px solid rgba(139, 92, 246, 0.28);
      border-radius: 8px;
      color: rgba(255, 255, 255, 0.75);
    }
    .install-info-box iconify-icon {
      color: #a78bfa;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .install-info-box strong {
      display: block;
      font-size: 0.85rem;
      color: #ddd6fe;
      margin-bottom: 0.15rem;
    }
    .install-info-box p {
      margin: 0;
      font-size: 0.78rem;
      line-height: 1.45;
      color: rgba(255, 255, 255, 0.65);
    }

    .install-steps {
      list-style: none;
      padding: 0;
      margin: 0 0 1.5rem;
      counter-reset: step;
    }

    .install-steps li {
      counter-increment: step;
      position: relative;
      padding: 0.75rem 0 0.75rem 2.5rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .install-steps li:last-child {
      border-bottom: none;
    }

    .install-steps li::before {
      content: counter(step);
      position: absolute;
      left: 0;
      top: 0.75rem;
      width: 1.6rem;
      height: 1.6rem;
      border-radius: 50%;
      background: var(--po-accent-muted-bg);
      color: var(--po-accent);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.75rem;
      font-weight: 600;
    }

    .install-steps li strong {
      display: block;
      font-size: 0.9rem;
      margin-bottom: 0.25rem;
    }

    .install-steps li p {
      margin: 0;
      font-size: 0.82rem;
      color: rgba(255, 255, 255, 0.55);
    }

    .install-steps code {
      display: inline-block;
      background: rgba(0, 0, 0, 0.35);
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      font-size: 0.82rem;
      color: var(--po-text-primary);
      font-family: 'SF Mono', 'Fira Code', monospace;
      user-select: all;
    }

    .install-switch {
      padding-top: 1rem;
      margin-top: 1rem;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }

    .install-switch-head strong {
      font-size: 0.9rem;
      color: var(--po-text-primary);
    }

    .install-switch-head p {
      margin: 0.25rem 0 0.75rem;
      font-size: 0.82rem;
      color: rgba(255, 255, 255, 0.55);
    }

    .install-switch-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .install-switch-item {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.35rem 0.7rem;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.04);
      color: var(--po-text-primary);
      font-size: 0.82rem;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease;
    }

    .install-switch-item:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .install-switch-item:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .install-switch-logo {
      width: 16px;
      height: 16px;
      object-fit: contain;
    }

    .install-switch-badge {
      font-size: 0.68rem;
      color: rgba(255, 255, 255, 0.4);
    }

    .install-switch-item .spinner-border {
      width: 12px;
      height: 12px;
      border-width: 2px;
    }

    .install-switch-error {
      margin: 0.5rem 0 0;
      font-size: 0.78rem;
      color: #f87171;
    }

    .install-guide-footer {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding-top: 1rem;
      margin-top: 1rem;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      flex-wrap: wrap;
    }

    .install-guide-footer .btn {
      gap: 0.4rem;
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
    }

    .install-guide-footer .spinner-border {
      width: 14px;
      height: 14px;
      border-width: 2px;
    }

    .install-hint {
      flex: 1;
      font-size: 0.76rem;
      color: rgba(255, 255, 255, 0.4);
      line-height: 1.4;
      margin: 0;
      min-width: 240px;
    }


    /* ── Auto-install action ── */
    .install-auto-action {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.25rem;
      padding: 1rem 1.15rem;
      background: linear-gradient(135deg, rgba(63, 185, 80, 0.1), rgba(63, 185, 80, 0.04));
      border: 1px solid rgba(63, 185, 80, 0.25);
      border-radius: 10px;
    }
    .install-auto-text {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      min-width: 0;
    }
    .install-auto-text strong {
      font-size: 0.92rem;
      font-weight: 600;
      color: #7ee787;
    }

    .install-auto-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      white-space: nowrap;
      font-weight: 600;
      padding: 0.55rem 1.1rem;
    }

    .install-auto-btn .spinner-border {
      width: 14px;
      height: 14px;
      border-width: 2px;
    }

    .install-auto-desc {
      font-size: 0.78rem;
      color: rgba(255, 255, 255, 0.55);
      line-height: 1.4;
    }

    /* ── Code row with run button ── */
    .install-code-row {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
    }

    .install-run-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: none;
      border-radius: 4px;
      background: rgba(63, 185, 80, 0.12);
      color: var(--po-success);
      cursor: pointer;
      transition: all 0.15s;
      flex-shrink: 0;
    }
    .install-run-btn:hover {
      background: rgba(63, 185, 80, 0.3);
      color: var(--po-success);
      transform: scale(1.1);
    }

    /* ── Inline install terminal ── */
    .install-terminal-wrapper {
      margin: 1.25rem 0;
      border: 1px solid rgba(63, 185, 80, 0.25);
      border-radius: 8px;
      overflow: hidden;
    }

    .install-terminal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.4rem 0.75rem;
      background: rgba(63, 185, 80, 0.08);
      font-size: 0.78rem;
      font-weight: 600;
      color: var(--po-success);
    }

    .install-terminal-header > span {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .install-terminal-close {
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
      transition: all 0.12s;
    }
    .install-terminal-close:hover {
      background: var(--po-error-bg);
      color: var(--po-error);
    }

    .install-terminal-container {
      height: 300px;
    }

    /* ── Auto-Approve Bouncing Screensaver Overlay ── */
    .aa-terminal-banner {
      position: absolute;
      inset: 0;
      z-index: 5;
      pointer-events: none;
      overflow: hidden;
    }
    .aa-bouncer {
      position: absolute;
      animation: aa-bounce-x 11s linear infinite alternate, aa-bounce-y 7s linear infinite alternate;
    }
    .aa-ascii {
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 8px;
      line-height: 1.15;
      color: rgba(88, 166, 255, 0.18);
      margin: 0;
      white-space: pre;
      letter-spacing: 0.02em;
      text-shadow: 0 0 12px rgba(88, 166, 255, 0.1);
    }
    .aa-terminal-banner.ai-mode .aa-ascii {
      color: rgba(168, 85, 247, 0.22);
      text-shadow: 0 0 12px rgba(168, 85, 247, 0.1);
    }
    @keyframes aa-bounce-x {
      0%   { left: 5%; }
      100% { left: calc(100% - 320px); }
    }
    @keyframes aa-bounce-y {
      0%   { top: 8%; }
      100% { top: calc(100% - 80px); }
    }

    /* Parent needs relative for the absolute overlay */
    .main-pane, .ide-terminal-area {
      position: relative;
    }

    /* ── Tailer Response Preview Modal ── */
    .tailer-preview-overlay {
      position: fixed;
      inset: 0;
      z-index: 9999;
      display: flex;
      align-items: flex-end;
      justify-content: flex-end;
      padding: 24px;
      background: rgba(0, 0, 0, 0.3);
    }
    .tailer-preview-modal {
      background: var(--po-bg-1);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      width: 420px;
      max-height: 400px;
      display: flex;
      flex-direction: column;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }
    .tailer-preview-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      font-size: 13px;
      font-weight: 600;
      color: var(--po-text-primary);
    }
    .tailer-preview-close {
      margin-left: auto;
      background: none;
      border: none;
      color: inherit;
      opacity: 0.5;
      cursor: pointer;
    }
    .tailer-preview-close:hover { opacity: 1; }
    .tailer-preview-badge {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 99px;
      font-weight: 500;
      text-transform: uppercase;
    }
    .tailer-preview-badge.ai {
      background: rgba(88, 166, 255, 0.15);
      color: var(--po-info);
    }
    .tailer-preview-badge.heuristic {
      background: rgba(210, 153, 34, 0.15);
      color: var(--po-warning);
    }
    .tailer-preview-badge.fast-path {
      background: rgba(63, 185, 80, 0.15);
      color: var(--po-success);
    }
    .tailer-preview-body {
      padding: 12px 16px;
      overflow-y: auto;
      flex: 1;
    }
    .tailer-preview-body label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: rgba(255, 255, 255, 0.4);
      margin-bottom: 4px;
      display: block;
    }
    .tailer-detected, .tailer-response {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      background: rgba(255, 255, 255, 0.04);
      border-radius: 6px;
      padding: 8px 12px;
      margin-bottom: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--po-text-primary);
      max-height: 100px;
      overflow-y: auto;
    }
    .tailer-response {
      border-left: 3px solid var(--po-info);
    }
    .tailer-preview-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 10px 16px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }

  `,
})
export class SessionViewComponent implements OnInit, OnDestroy {
  private orgPolicy = inject(OrgPolicyService);
  protected sessionService = inject(SessionService);
  protected interactionService = inject(InteractionService);
  protected ecoService = inject(EcoModeService);
  private sessionShortcuts = inject(SessionShortcutsService);
  private hookService = inject(ClaudeHookService);
  protected subAgentService = inject(SubAgentService);
  protected sessionModels = inject(SessionModelService);
  protected sessionEfforts = inject(SessionEffortService);
  private subAgentStash = inject(SubAgentStashService);
  protected reviewService = inject(SubAgentReviewService);
  protected actionNotices = inject(AgentActionNoticeService);
  protected slotService = inject(ActionSlotService);
  private historyService = inject(SessionHistoryService);
  private workspaceApiService = inject(WorkspaceApiService);
  private desktopSessionApiService = inject(DesktopSessionApiService);
  private providerSwitch = inject(ProviderSwitchService);
  private providerLimit = inject(ProviderLimitService);
  private route = inject(ActivatedRoute);
  private store = inject(Store);
  private actions$ = inject(Actions);
  private modalService = inject(NgbModal);
  private terminalManager = inject(TerminalManagerService);
  private swalService = inject(SwalService);
  private tutorialService = inject(TutorialService);
  protected sessionsGuide = inject(SessionsGuideService);
  private consentCheck = inject(ConsentCheckService);
  /** One-shot guard so the first-run guide is scheduled at most once per view. */
  private guideStartScheduled = false;
  /** Dev-only: render the empty/welcome state regardless of real data (preview). */
  protected simulateEmpty = signal(false);
  protected ff = inject(FeatureFlagService);
  private sessionAssetsService = inject(SessionAssetsService);
  private remoteBridge = inject(RemoteBridgeService);
  private translateService = inject(TranslateService);
  private pollingHub = inject(PollingHubService);
  private nativeMenu = inject(NativeMenuService);
  private routeSub?: Subscription;
  private nativeMenuSub?: Subscription;
  @ViewChild('terminalRef') terminalRef?: SessionTerminalComponent;
  @ViewChild('terminalAreaEl') terminalAreaEl?: ElementRef<HTMLDivElement>;
  @ViewChild(SessionAssetsPanelComponent) assetsPanel?: SessionAssetsPanelComponent;
  @ViewChildren(SessionTerminalComponent) sessionTerminals!: QueryList<SessionTerminalComponent>;
  @ViewChildren(SubAgentTerminalComponent) subAgentTerminals!: QueryList<SubAgentTerminalComponent>;

  /** Install terminal ViewChild — fires when the container is rendered */
  @ViewChild('installTerminalContainer') set installTerminalContainerRef(ref: ElementRef<HTMLDivElement> | undefined) {
    if (ref && this.installerTerminalId() && !this.installXterm) {
      this.initInstallTerminal(ref.nativeElement);
    }
  }

  private savedResize = this.loadResizeState();
  /** Tracks which pane (main | subagent:<id>) currently has focus */
  focusedPaneId = signal<string | null>(null);

  /** Provider install guide state */
  providerMissing = signal(false);
  providerChecking = signal(false);
  providerPlatform = signal<string>('darwin');
  providerCommand = signal<string>('');

  /** Install guide UI state */
  installGuideTab = signal<'auto' | 'manual'>('auto');
  manualPlatform = signal<'darwin' | 'win32' | 'linux'>('darwin');

  /** Provider auto-installer state */
  installerTerminalId = signal<string | null>(null);
  installerRunning = signal(false);
  private installXterm: Terminal | null = null;
  private installFitAddon: FitAddon | null = null;
  private unsubInstallOutput: (() => void) | null = null;
  private installResizeObserver: ResizeObserver | null = null;
  private pendingInstallCmd: string | null = null;

  /** Guard: prevents desktopStateSyncEffect from overwriting state before restore completes */
  private restoreComplete = signal(false);

  sidebarCollapsed = signal(this.savedResize['sidebarCollapsed'] ?? false);
  /** Width of the left sessions sidebar when expanded (drag-resizable). */
  sidebarWidth = signal(this.savedResize['sidebarWidth'] ?? 260);
  /** True while dragging the sidebar splitter — disables the width transition. */
  sidebarResizing = signal(false);
  subAgentsExpanded = signal(true);
  expandedSubAgentId = signal<string | null>(null);
  private removeExpandedEscapeListener?: () => void;
  saDropZoneActive = signal(false);
  subAgentsListMode = signal(false);
  subAgentsHeight = signal(this.savedResize['subAgentsHeight'] ?? 250);

  // ── Sub-agent tab/grid mode & lock ──
  subAgentTabMode = signal(!!this.savedResize['subAgentTabMode'] && !!this.savedResize['userExplicitLayout']);
  subAgentGridMode = signal(this.savedResize['subAgentGridMode'] ?? false);
  /** Former "split" with a new identifier: the old split/list preferences
   *  do not reactivate it, the default for everyone is the AUTO grid. */
  subAgentColumnsMode = signal(this.savedResize['subAgentLayout'] === 'columns');
  /** Vertical view: panes one below the other at full width, resize in height. */
  subAgentRowsMode = signal(this.savedResize['subAgentLayout'] === 'rows');
  /**
   * Legacy preference "cover the main with the sub-agents". It can no longer be driven
   * by the user: since the main moves down into the roster there is no main left to
   * cover. It is still read from the saved state so old profiles do not break.
   */
  private subAgentsCoverMainUser = signal(this.savedResize['subAgentsCoverMain'] ?? false);

  /**
   * True when the sub-agents take the whole terminal area. It is now a
   * consequence of the demotion, not a choice: if the main is in the roster,
   * the space is by definition all theirs.
   */
  subAgentsCoverMain = computed(() => this.mainIsFlattened() || this.subAgentsCoverMainUser());
  /**
   * Integrated "Multi-session workspace" plugin off: the session tab row is empty, and when the
   * sub-agents cover the main their header (title, modes, chevron) moves up there in place of the tabs.
   */
  saBarInHeader = computed(() =>
    !this.builtins.isOn('multi-session') && this.subAgentsCoverMain()
    && this.ff.canAccess('sub_agents') && this.subAgentService.hasActiveSubAgents(),
  );
  /**
   * Width of the bar in the header: it ends where the terminals end, i.e. before the right panel
   * (Action Center: chosen width, 40px collapsed, absent in focus mode). The header row has
   * 0.75rem of right padding that the panel does not have, so it is added back. If the controls on the right
   * of the header are wider than the panel, the bar shrinks (flex-shrink) and ends before them.
   */
  saBarInHeaderBasis = computed(() => {
    const panel = this.focusMode() ? 0 : (this.actionCenterCollapsed() ? 40 : this.actionCenterWidth());
    return `calc(100% + 0.75rem - ${panel}px)`;
  });
  userExplicitLayout = signal(this.savedResize['userExplicitLayout'] ?? false);
  /**
   * Locked panes (sub-agents AND the `__main__` lead), by runtime id. The registry
   * lives in SubAgentService (identity `role|title`, per-session persistence)
   * so the Action Center respects the lock too: here only the view.
   */
  lockedSubAgents = computed<Set<string>>(() => this.subAgentService.lockedIds());
  activeSubAgentTab = signal<string | null>(null);

  /** Below this window width (e.g. 14" MacBook = 1512px logical), 3 split
   *  panes are too narrow for the full "Input required" text badge. */
  private readonly saCompactViewportPx = 1600;
  private viewportWidth = signal(typeof window !== 'undefined' ? window.innerWidth : 1920);
  /** Sub-agent pane headers show the status dot instead of the text badge:
   *  always with 4+ agents, and already with 3 on narrow viewports. */
  saStatusCompact = computed(() => {
    const n = this.subAgentService.activeRoster().length;
    return n > 3 || (n >= 3 && this.viewportWidth() < this.saCompactViewportPx);
  });
  /** When the icons alone do not fit in the header (6+ panes everywhere, already 3+
   *  on narrow viewports like 14") they collapse into a single trigger that
   *  opens them vertically on hover. */
  saActionsCollapsed = computed(() => {
    const n = this.paneRoster().length;
    return n > 5 || (n >= 3 && this.viewportWidth() < this.saCompactViewportPx);
  });
  /** The pane expanded to full screen has a header as wide as the window:
   *  the compact mode (3-dot flyout, status dot) is not needed. */
  saPaneActionsCollapsed(saId: string): boolean {
    return this.saActionsCollapsed() && this.expandedSubAgentId() !== saId;
  }
  saPaneStatusCompact(saId: string): boolean {
    return this.saStatusCompact() && this.expandedSubAgentId() !== saId;
  }

  // ── Focus mode (fullscreen main terminal, no sidebar/action-center) ──
  focusMode = signal(false);

  // ─────────────────────────────────────────────────────────────────────
  // Flat roster: from the first spawn the main stops being a category
  // ─────────────────────────────────────────────────────────────────────

  /** Id of the pseudo-entry that represents the main session inside the roster. */
  static readonly MAIN_PANE_ID = '__main__';

  /**
   * Agents model (Tauri ONLY, kill-switch `promptops_agents_v2=off`): the lead is
   * a real agent, closing it closes its PTY. Outside Tauri it is always
   * false and no `agentsEnabled` branch below is ever taken.
   */
  readonly agentsEnabled = inject(AGENTS_MODEL);
  readonly agentRoster = inject(AgentRosterService);

  /**
   * Sessions whose main was closed by the user. Persisted: a closed main
   * must not reappear, neither on wake nor after a restart. The local store is not
   * touched — the record stays, it only disappears from the UI.
   */
  private dismissedMains = signal<Set<string>>(
    new Set<string>(readDismissedMains()),
  );

  /** True if the main of this session was closed for good. */
  mainDismissed = computed(() => {
    const id = this.activeSessionId();
    if (!id) return false;
    return this.mainPaneClosed(id);
  });

  /** Like `mainDismissed`, but for any session (even a non-active one). */
  private mainPaneClosed(sessionId: string): boolean {
    // Agents model: the flag lives in Rust (closed lead = dead session PTY).
    if (this.agentsEnabled) return this.agentRoster.leadClosed(sessionId);
    return this.dismissedMains().has(sessionId);
  }

  /**
   * Flat roster of the panes: sub-agents + the main as any other tile.
   *
   * The main is included only when at least one sub-agent exists. From then on it
   * no longer has a reserved spot: it sits in the same grid, with the same header,
   * the same tabs and the same close button as the others.
   *
   * It is a pseudo-`SubAgent` on purpose: so the whole template (badge,
   * status dot, tab bar, toolbar) keeps working without duplicates.
   */
  paneRoster = computed<SubAgent[]>(() => this.applyPaneOrder(this.rawPaneRoster()));

  private rawPaneRoster = computed<SubAgent[]>(() => {
    const subs = this.subAgentService.activeRoster();
    const session = this.activeSession();
    // Agents model: roster from the agents adapter (lead = session PTY, same id `__main__`).
    if (this.agentsEnabled) return this.agentRoster.rosterFor(session, subs);
    if (!session || subs.length === 0) return subs;
    if (this.dismissedMains().has(session.id)) return subs;

    const main: SubAgent = {
      id: SessionViewComponent.MAIN_PANE_ID,
      role: 'main',
      // Explicit name: in the roster the tile must be recognized as THE main,
      // not confused with a sub-agent that carries the session name.
      title: 'Main session',
      parentSessionId: session.id,
      sessionId: session.id,
      status: (session.status === 'running' || session.status === 'in_progress' ? session.status : 'idle') as SubAgent['status'],
      autoPrompt: '',
      provider: session.provider as unknown as SubAgent['provider'],
      icon: 'solar:monitor-bold',
      executionMode: 'interactive',
    };
    return [main, ...subs];
  });

  /**
   * True when the classic .main-pane must not exist: either because the main is
   * demoted to a roster tile, or because it was closed by the user.
   *
   * A closed main NEVER comes back on its own: not even when the roster empties
   * (last sub-agent closed, dead sub-agents, empty window at boot/wake
   * before the restore). Previously an empty roster was enough to make it reappear
   * as a large pane — that was the "it always reappears". In its place there is an
   * empty-state with explicit restore (`restoreMain`).
   */
  mainIsFlattened = computed(() =>
    this.paneRoster().some(p => this.isMainPane(p.id)) || this.mainDismissed() || this.leadMetaPending(),
  );

  /**
   * Agents model: session meta not yet read from Rust. Until we know whether the
   * lead is closed the classic .main-pane is NOT mounted — with the "open" default
   * the main the user had closed showed up for an instant.
   */
  private leadMetaPending = computed(() => {
    const id = this.activeSessionId();
    return this.agentsEnabled && !!id && !this.agentRoster.isLoaded(id);
  });

  /** Empty roster and closed main: nothing to show, only the empty-state. */
  mainDismissedEmpty = computed(() =>
    this.mainDismissed() && this.subAgentService.activeRoster().length === 0,
  );

  isMainPane(id: string): boolean {
    return id === SessionViewComponent.MAIN_PANE_ID;
  }

  /**
   * A single pane left ⇒ it takes all the space, whoever it is.
   * There is no special "the main goes back to large" case: it is just arithmetic.
   */
  soloPane = computed(() => this.paneRoster().length === 1);

  /**
   * Closes the demoted main. It does not touch the local store and does not kill the process:
   * the tile disappears and never comes back, the PTY stays alive behind it. No
   * resume will make it reappear.
   */
  dismissMain(event?: MouseEvent): void {
    event?.stopPropagation();
    const id = this.activeSessionId();
    if (!id) return;
    if (this.agentsEnabled) {
      // Agents model: REAL close — Rust kills the session PTY, the members stay.
      // Destructive and barely visible action: confirm first, saying where to
      // reopen it (session menu in the sidebar).
      this.swalService.confirmDanger(
        this.translateService.instant('SUBAGENTS.Close lead confirm title'),
        this.translateService.instant('SUBAGENTS.Close lead confirm text'),
        () => {
          void this.agentRoster.closeLead(id).then((ok) => {
            if (!ok) this.swalService.error(this.translateService.instant('SUBAGENTS.Close lead failed'));
          });
          if (this.activeSubAgentTab() === SessionViewComponent.MAIN_PANE_ID) {
            this.activeSubAgentTab.set(this.subAgentService.activeRoster()[0]?.id ?? null);
          }
          this.subAgentPaneWidths.set({});
        },
      );
      return;
    }
    this.dismissedMains.update(set => {
      const next = new Set(set);
      next.add(id);
      writeDismissedMains(next);
      return next;
    });
    if (this.activeSubAgentTab() === SessionViewComponent.MAIN_PANE_ID) {
      this.activeSubAgentTab.set(this.subAgentService.activeRoster()[0]?.id ?? null);
    }
    this.subAgentPaneWidths.set({});
  }

  // ── Auto-Approve graphic selection mode ──
  /** True while the user is graphically picking which terminals get auto-approve. */
  aaSelectMode = signal(false);
  /** Map of session ID → chosen mode ('quick' | 'ai'). Absence from the map
   *  means the terminal is NOT selected (no auto-approve will be applied). */
  aaSelectedModes = signal<Map<string, 'quick' | 'ai'>>(new Map());

  /** Platform detection for shortcut labels */
  readonly isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  /** Modifier key label for shortcut hints */
  readonly modKey = this.isMac ? '⌘⌥' : 'Alt';
  /** Label of an action's (remappable) key, for the inline hints. */
  shortcutKey(action: SessionShortcutAction): string {
    return shortcutKeyLabel(this.sessionShortcuts.bindings()[action]) ?? '?';
  }
  ideSubAgentsHeight = signal(this.savedResize['ideSubAgentsHeight'] ?? 250);
  actionCenterWidth = signal(this.savedResize['actionCenterWidth'] ?? 320);
  actionCenterCollapsed = signal(this.savedResize['actionCenterCollapsed'] ?? false);

  // IDE layout mode signals
  ideRightWidth = signal<number | null>(this.savedResize['ideRightWidth'] ?? 420);
  ideRightCollapsed = signal(this.savedResize['ideRightCollapsed'] ?? false);

  /** Which accordion section is open in IDE right panel (mutually exclusive) */
  ideAccordion = signal<'usage' | 'subagents' | 'actions' | 'interactions' | null>(null);

  /** Sticky user-intent: when true, suppress auto-open of the sub-agents
   *  accordion (e.g. on new spawn). Cleared when the user re-opens it
   *  manually or switches session. */
  private subagentsAccordionUserClosed = signal(false);

  /** Predefined quick agents for IDE mode */
  readonly ideQuickAgents = [
    { id: 'security', icon: 'solar:shield-check-bold-duotone', color: '#f85149', label: 'Security', title: 'security', prompt: 'Audit the codebase for security vulnerabilities: check for OWASP Top 10, hardcoded secrets, SQL injection, XSS, CSRF, auth bypasses. Report findings with file:line and severity.' },
    { id: 'tests', icon: 'solar:test-tube-bold-duotone', color: '#3fb950', label: 'Tests', title: 'tests', prompt: 'Analyze the project test suite. Run existing tests, identify untested code, write missing tests for critical paths. Fix any failing tests.' },
    { id: 'review', icon: 'solar:magnifer-bug-bold-duotone', color: '#58a6ff', label: 'Review', title: 'review', prompt: 'Review recent changes (git diff). Check for bugs, code smells, performance issues, and naming inconsistencies. Suggest improvements with file:line references.' },
    { id: 'docs', icon: 'solar:document-text-bold-duotone', color: '#d29922', label: 'Docs', title: 'docs', prompt: 'Generate or update project documentation. Document public APIs, configuration options, and setup instructions. Keep it concise and accurate.' },
    { id: 'refactor', icon: 'solar:code-bold-duotone', color: '#bc8cff', label: 'Refactor', title: 'refactor', prompt: 'Identify code that can be refactored: duplications, long functions, complex conditionals, dead code. Apply clean code principles and report what was improved.' },
    { id: 'perf', icon: 'solar:rocket-bold-duotone', color: '#39c5cf', label: 'Perf', title: 'performance', prompt: 'Profile the application for performance bottlenecks. Check for N+1 queries, unnecessary re-renders, large bundle sizes, slow endpoints. Suggest optimizations.' },
  ];

  @ViewChild('inlineEditorRef') inlineEditorRef?: SessionCodeEditorComponent;
  @ViewChild('addNoteModal') addNoteModal?: AddNoteModalComponent;
  @ViewChild('projectBriefModal') projectBriefModal?: ProjectBriefModalComponent;
  @ViewChild('devLinksModal') devLinksModal?: DevLinksModalComponent;
  @ViewChild('todoModal') todoModal?: TodoModalComponent;

  editorSessionId = signal<string | null>(null);
  private ideTerminalTab = signal<string | null>(null);
  ideSelectedTerminal = computed(() => {
    const ids = this.paneRoster().map(sa => sa.id);
    if (!this.mainIsFlattened() && !this.mainDismissed()) ids.unshift('main');
    const selected = this.ideTerminalTab();
    return selected && ids.includes(selected) ? selected : (ids[0] ?? null);
  });

  onIdeTabKeydown(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button[role="tab"]'));
    const current = buttons.indexOf(event.target as HTMLButtonElement);
    if (current < 0 || !buttons.length) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }

  selectIdeTerminal(id: string): void {
    this.ideTerminalTab.set(id);
    this.ideRightCollapsed.set(false);
    if (id === 'main') {
      this.focusedPaneId.set('main');
      setTimeout(() => { this.terminalRef?.focus(); this.nudgeLayoutForRefit(); }, 0);
    } else {
      this.switchSubAgentTab(id);
    }
  }

  /** Current layout mode derived from the active session */
  currentLayoutMode = computed<LayoutMode>(() => {
    const session = this.activeSession();
    return session?.layoutMode ?? 'standard';
  });

  // NgRx selectors as signals
  private allSessions = toSignal(this.store.select(getSessions), { initialValue: [] });
  private sessionsHasLoadedOnce = toSignal(
    this.store.select(getSessionsHasLoadedOnce),
    { initialValue: false },
  );

  /** All sessions excluding sub-agents */
  sessions = computed(() => {
    const subAgentSessionIds = this.subAgentService.allSubAgentSessionIds();
    return this.allSessions().filter(s => !subAgentSessionIds.has(s.id));
  });

  /** True only during the very first loadSessions cycle — used to render a
   *  branded loader instead of flashing the welcome/empty state before we know
   *  whether the user has sessions to restore. */
  isBootstrappingSessions = computed(() => !this.sessionsHasLoadedOnce());

  /** The list fetch failed (offline, local store down) and there is nothing cached
   *  to show: render a retry screen instead of the first-run welcome/guide. */
  private sessionsListLoadFailed = toSignal(
    this.store.select(getSessionsListLoadFailed),
    { initialValue: false },
  );
  sessionsLoadFailed = computed(() => this.sessionsListLoadFailed() && this.sessions().length === 0);
  private sessionsLoading = toSignal(this.store.select(getSessionsLoading), { initialValue: false });
  sessionsRetrying = computed(() => this.sessionsLoadFailed() && this.sessionsLoading());
  private sessionsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionsRetryAttempt = 0;
  private readonly onBrowserOnline = () => { if (this.sessionsLoadFailed()) this.retrySessionsLoad(); };

  /** Read once per view instance: decides welcome vs. "no sessions, refresh". */
  readonly hadSessionsBefore = hasEverHadSessions();

  /** Same as Cmd/Ctrl+R — the recovery most users don't know about. */
  reloadApp(): void {
    window.location.reload();
  }

  retrySessionsLoad(): void {
    if (this.sessionsRetryTimer) { clearTimeout(this.sessionsRetryTimer); this.sessionsRetryTimer = null; }
    this.store.dispatch(loadSessions());
  }

  private currentUser = toSignal(this.store.select(getUser), { initialValue: null });
  userFirstName = computed(() => {
    const u = this.currentUser();
    return u?.first_name?.trim() || u?.username || '';
  });

  activeSessionId = toSignal(this.store.select(getActiveSessionId), { initialValue: null });
  activeSession = toSignal(this.store.select(getActiveSession), { initialValue: null });
  /**
   * Persists the active session (id + name) on every change, not only on click: after a
   * restart (update) the live ids may change, the name stays as a fallback. It writes
   * only once the restore is done, so the boot does not overwrite the saved choice.
   */
  private persistActiveSession = effect(() => {
    const s = this.activeSession();
    if (!s || !this.restoreComplete()) return;
    try {
      safeSetItem(ACTIVE_SESSION_KEY, s.id);
      safeSetItem(ACTIVE_SESSION_NAME_KEY, s.name);
    } catch { /* storage not available */ }
  });
  /** Plugin runtime (desktop app only): the plugin buttons in the terminal bars. */
  protected pluginRuntime = inject(PluginRuntimeService);
  /** Integrated PromptOps plugins that can be turned off from Plugins (e.g. Browser). */
  protected builtins = inject(BuiltinPluginsService);
  protected floorPlan = inject(FloorPlanService);
  /** Sessions opened in their dedicated window: here the placeholder sits in place of the terminals. */
  protected sessionWindows = inject(SessionWindowsService);
  /**
   * Dedicated window of ONE session (child of the main one): same view, no sidebar, locked to
   * this session. No restore, no shared saves (restoreComplete stays false), resume
   * and agent start forwarded to the main window (SessionEffects), output received as a copy.
   */
  protected readonly dedicatedSessionId = sessionWindowId();
  private dedicatedWasParked: boolean | null = null;
  private dedicatedOff: (() => void) | null = null;
  private readonly dedicatedWakeEffect = effect(() => {
    const id = this.dedicatedSessionId;
    if (!id) return;
    const s = this.activeSession();
    if (!s || s.id !== id) return;
    const parked = !!s.standbyAt;
    const was = this.dedicatedWasParked;
    this.dedicatedWasParked = parked;
    // Resume done by the main window: new PTY, we re-attach and the terminal replays.
    if (was === true && !parked) {
      untracked(() => {
        const api = (window as any).promptops;
        // Resync even when the re-attach fails: the terminal must not stay frozen.
        void Promise.resolve(api?.watchSessionOutput?.(id))
          .catch((err: unknown) => console.warn('[session-view] re-attach after wake failed', err))
          .then(() => {
            setTimeout(() => {
              this.terminalRef?.resyncAfterWake();
              this.nudgeLayoutForRefit(250);
            }, 600);
          });
      });
    }
  });

  /** Session requested by the floor plan in a detached window. */
  private readonly floorPlanOpenEffect = effect(() => {
    const id = this.floorPlan.pendingOpen();
    if (!id) return;
    untracked(() => {
      this.floorPlan.pendingOpen.set(null);
      void this.selectSession(id);
    });
  });

  /** Desk clicked in the floor plan: the session opens and the floor plan becomes a side panel. */
  async openFromFloorPlan(sessionId: string): Promise<void> {
    this.floorPlan.dock();
    await this.selectSession(sessionId);
  }
  protected forwardPorts = inject(ForwardPortsService);
  /** Tabs of the bar above the agent terminals: Agents | Ports (VS Code panel style). */
  saPanelTab = signal<'agents' | 'ports'>(this.readSaPanelTab());
  /** Tab bar above the main alone: no active sub-agent, but Ports stays reachable. */
  portsSoloBar = computed(() =>
    this.forwardPorts.isAvailable && !this.mainIsFlattened()
    && !(this.ff.canAccess('sub_agents') && this.subAgentService.hasActiveSubAgents()),
  );

  /**
   * A single agent (or only the main in the roster): the Agent | Ports tabs move up into the pane header,
   * on the same row as the title, instead of taking a row of their own. On Ports or with the panel closed
   * the standard bar comes back, otherwise there would be no way back.
   */
  saTabsInPane = computed(() =>
    this.paneRoster().length === 1 && this.subAgentsExpanded()
    && this.saPanelTab() === 'agents' && !this.saBarInHeader(),
  );

  /** The Full focus toggle in the sub-agent bar is on screen in focus mode (the session header is hidden there). */
  saFocusToggleVisible = computed(() =>
    this.portsSoloBar()
    || (this.ff.canAccess('sub_agents') && this.subAgentService.hasActiveSubAgents()
        && !this.saBarInHeader() && !this.saTabsInPane()),
  );

  private readSaPanelTab(): 'agents' | 'ports' {
    try { return localStorage.getItem('po.saPanelTab') === 'ports' ? 'ports' : 'agents'; } catch { return 'agents'; }
  }

  /** Click on a tab: if it is already active it acts as a header (open/close), otherwise it switches view and opens. */
  selectSaPanelTab(tab: 'agents' | 'ports', ev: Event, solo = false): void {
    ev.stopPropagation();
    if (solo) {
      this.saPanelTab.set(tab);
      try { localStorage.setItem('po.saPanelTab', tab); } catch { /* storage blocked */ }
      if (tab === 'agents') this.nudgeLayoutForRefit(250);
      return;
    }
    if (this.saPanelTab() === tab) {
      this.toggleSubAgentsAccordion();
      return;
    }
    this.saPanelTab.set(tab);
    try { localStorage.setItem('po.saPanelTab', tab); } catch { /* storage blocked */ }
    if (!this.subAgentsExpanded()) this.toggleSubAgentsAccordion();
    else if (tab === 'agents') this.nudgeLayoutForRefit(250);
  }
  /** Only the name of the session folder reaches plugins, never the path. */
  protected pluginWorkspaceName = computed(() => (this.activeSession()?.workspace?.path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '');
  activeInteractions = toSignal(this.store.select(getActiveSessionInteractions), { initialValue: [] });

  /** Provider usage (rate limit, cost, model) for the active session */
  providerUsage = signal<ProviderUsageSnapshot | null>(null);

  // Workspace state
  workspaces = toSignal(this.store.select(getWorkspaces), { initialValue: [] });
  activeWorkspaceId = toSignal(this.store.select(getActiveWorkspaceId), { initialValue: null });
  activeWorkspace = toSignal(this.store.select(getActiveWorkspace), { initialValue: null });

  /**
   * Sessions to show as tabs in the header.
   * - If active session belongs to a workspace (by id or path) → show all siblings
   * - Otherwise → show only the active session (single tab + "+" button)
   */
  tabSessionsForHeader = computed(() => {
    const active = this.activeSession();
    if (!active) return [];

    const all = this.sessions();
    const wsList = this.workspaces();

    // Find the workspace the active session belongs to (same logic as sidebar)
    const activeWs = wsList.find(ws =>
      active.workspaceId === ws.id ||
      (active.workspace?.path && active.workspace.path === ws.projectPath),
    );

    if (activeWs) {
      const siblings = all.filter(s =>
        s.workspaceId === activeWs.id ||
        (s.workspace?.path && s.workspace.path === activeWs.projectPath),
      );
      if (siblings.length > 0) return siblings;
    }

    return [active];
  });

  constructor() {
    // Capture phase: must run before xterm swallows Alt+key (see onSubAgentKeyDown).
    document.addEventListener('keydown', this.keyDownCapture, true);
    // Remote sessions: host ⇄ computer file bridge (MCP send_to_local + out/ box).
    effect(() => {
      // Dedicated window: the remote outbox is collected (and consumed) only by the main window.
      if (this.dedicatedSessionId) return;
      const path = this.activeSession()?.workspace?.path ?? null;
      untracked(() => this.remoteBridge.watch(path));
    });

    // Ports: detection/auto-forward bound to the active session's folder.
    effect(() => {
      if (this.dedicatedSessionId) return;
      const path = this.activeSession()?.workspace?.path ?? null;
      const provider = this.activeSession()?.provider ?? null;
      untracked(() => {
        this.forwardPorts.setWorkspace(path);
        this.forwardPorts.setProvider(provider);
      });
    });
    // Persist collapsed toggles to localStorage
    effect(() => {
      const state = {
        sidebarCollapsed: this.sidebarCollapsed(),
        actionCenterCollapsed: this.actionCenterCollapsed(),
        ideRightCollapsed: this.ideRightCollapsed(),
      };
      // Merge with existing resize values
      const existing = this.loadResizeState();
      safeSetItem(RESIZE_STORAGE_KEY, JSON.stringify({ ...existing, ...state }));
    });

    // Apply per-session view state whenever the active session changes.
    // This restores size, lock, and sub-agent view mode to the values
    // saved for that specific session — each session stays isolated.
    {
      let lastAppliedId: string | null = null;
      effect(() => {
        const id = this.activeSessionId();
        if (id === lastAppliedId) return;
        lastAppliedId = id;
        if (!id) return;
        const session = this.allSessions().find(s => s.id === id);
        this.applySessionViewState(session?.viewState);
      });
    }

    // Agents model: a closed lead NEVER reopens on its own — not even with an empty
    // roster (at boot/wake the sub-agents arrive after the stash, and the last sub
    // closed leaves the window empty). That was the "the main shows up again":
    // the only way back is `restoreMain` / sidebar menu, explicit.

    // Expose session sidebar width as CSS variable for bottom bar alignment
    effect(() => {
      const w = this.sidebarCollapsed() ? '48px' : `${this.sidebarWidth()}px`;
      document.documentElement.style.setProperty('--session-sidebar-w', w);
    });

    // Track provider usage (rate limit, cost) for the active session
    {
      // onCleanup runs before the next run and when the view is destroyed,
      // so the store subscription never outlives the component.
      effect((onCleanup) => {
        const id = this.activeSessionId();
        if (id) {
          this.store.dispatch(loadProviderUsage({ sessionId: id }));
          const sub = this.store.select(getProviderUsage(id)).subscribe(u => this.providerUsage.set(u));
          onCleanup(() => sub.unsubscribe());
        } else {
          this.providerUsage.set(null);
        }
      });
    }

    // React to focusSessionId changes from the hook service
    effect(() => {
      const focusId = this.hookService.focusSessionId();
      if (focusId) {
        this.activateAndFocus(focusId);
      }
    });

    // [Tauri] Wake resolved = new PTY is live: re-attach the terminal of the
    // active session (fresh xterm + buffer replay + refit). ngOnChanges can't
    // fire — the sessionId didn't change — and the optimistic standbyAt flip
    // happens seconds before the PTY exists, so only this action is a safe
    // signal. Single hook for every wake trigger (cover CTA, selectSession on
    // a parked session, sidebar wake, wakeWorkspace fan-out).
    this.actions$.pipe(ofType(wakeSessionSuccess), takeUntilDestroyed()).subscribe(({ sessionId }) => {
      if (!this.sessionService.isTauri) return; // only the Tauri host needs the resync
      if (sessionId !== this.activeSessionId()) return;
      this.terminalRef?.resyncAfterWake();
      this.nudgeLayoutForRefit(250);
    });

    // Discover sub-agent session IDs once sessions are loaded. Incremental:
    // the store emits a new array on every refresh (polling, status updates),
    // and re-sweeping every session each time means N sync IPC calls per
    // emission — only ids never swept before are worth the roundtrip.
    {
      const sweptParents = new Set<string>();
      effect(() => {
        const newIds = this.allSessions()
          .map(s => s.id)
          .filter(id => !sweptParents.has(id));
        if (newIds.length > 0) {
          newIds.forEach(id => sweptParents.add(id));
          this.subAgentService.discoverAllSubAgents(newIds);
        }
      });
    }

    // ── Sessions First-Run Guide (dedicated, separate from the global tutorial) ──
    // Show whenever the user is in the empty state (no sessions). Not a one-shot:
    // it reappears on each visit while empty, but the per-view guard prevents it
    // from re-popping immediately after the user skips it.
    //
    // A freshly-registered user lands here while the consent re-acceptance modal
    // (ToS + Privacy, driven by ConsentCheckService on a 451 from me()) is up, so
    // we also gate on `requiresReacceptance`: the guide must wait until consent is
    // accepted. All signals are read into locals first so the effect tracks them
    // unconditionally — otherwise `&&` short-circuiting could drop the consent
    // subscription and the guide would not auto-start after the user accepts.
    effect(() => {
      const guideActive     = this.sessionsGuide.active();
      const guideSuppressed = this.sessionsGuide.suppressed();
      const tutorialActive  = this.tutorialService.active();
      const bootstrapping   = this.isBootstrappingSessions();
      const loadFailed      = this.sessionsLoadFailed();
      const noSessions      = this.sessions().length === 0;
      const consentPending  = this.consentCheck.requiresReacceptance();

      const eligible =
        !guideActive &&
        !guideSuppressed &&
        !tutorialActive &&
        !bootstrapping &&
        !loadFailed &&
        !this.hadSessionsBefore &&
        noSessions &&
        !consentPending;
      if (eligible && !this.guideStartScheduled) {
        this.guideStartScheduled = true;
        // Defer so the welcome screen (spotlight target) has painted.
        setTimeout(() => {
          // Race guard: the consent modal may have popped during the defer window
          // (me()'s 451 can land after sessions finished loading). Reset the guard
          // so the effect re-schedules the guide once consent is accepted.
          if (this.consentCheck.requiresReacceptance() || this.sessionsLoadFailed()) {
            this.guideStartScheduled = false;
            return;
          }
          this.sessionsGuide.start();
        }, 600);
      }
    });

    // Load-failure recovery: retry on our own (backoff 3s → 30s) and as soon as
    // the OS reports the network back, so users who don't know Cmd+R aren't
    // left on a dead screen.
    window.addEventListener('online', this.onBrowserOnline);
    effect(() => {
      const failed  = this.sessionsLoadFailed();
      const loading = this.sessionsLoading();
      untracked(() => {
        if (!failed) {
          this.sessionsRetryAttempt = 0;
          if (this.sessionsRetryTimer) { clearTimeout(this.sessionsRetryTimer); this.sessionsRetryTimer = null; }
          return;
        }
        if (loading || this.sessionsRetryTimer) return;
        const delay = Math.min(30_000, 3_000 * 2 ** this.sessionsRetryAttempt++);
        this.sessionsRetryTimer = setTimeout(() => {
          this.sessionsRetryTimer = null;
          this.store.dispatch(loadSessions());
        }, delay);
      });
    });

    // Act 3 payoff: when the guide asks to "create your first session", open the
    // real create-session modal (the mock has already been cleaned up).
    // Baseline against the CURRENT counter value: the guide service is a root
    // singleton, so a request consumed by a previous instance of this view is
    // still ≥1 here — starting from 0 would re-open the modal on every
    // navigation back to the Sessions section.
    {
      let lastCreateReq = this.sessionsGuide.createSessionRequest();
      effect(() => {
        const req = this.sessionsGuide.createSessionRequest();
        if (req > lastCreateReq) {
          lastCreateReq = req;
          setTimeout(() => this.openCreateModal(), 150);
        }
      });
    }

    // Restore layout mode on session change: from the saved view state (local
    // store, survives restarts and id changes), else the per-id localStorage copy.
    effect(() => {
      const session = this.activeSession();
      if (session && !session.layoutMode) {
        let savedMode = (session.viewState as ViewStateWithLayout | undefined)?.layoutMode ?? null;
        if (!savedMode) {
          try { savedMode = localStorage.getItem(`promptops_layout_${session.id}`) as LayoutMode | null; } catch { /* storage blocked */ }
        }
        if (savedMode && (savedMode === 'code' || savedMode === 'standard')) {
          this.store.dispatch(setLayoutMode({ sessionId: session.id, layoutMode: savedMode }));
        }
      }
    });

    effect(() => {
      if (this.currentLayoutMode() === 'code') this.editorSessionId.set(this.activeSessionId());
    });

    // Check provider availability when the active session (or its provider)
    // changes — not on every poll or status update of the same session.
    {
      let lastCheckKey: string | null = null;
      effect(() => {
        const session = this.activeSession();
        if (session && session.provider !== 'generic-shell' && this.sessionService.isDesktop) {
          const key = `${session.id}|${session.provider}`;
          if (key === lastCheckKey) return;
          lastCheckKey = key;
          void this.runProviderCheck(session.provider, false, session.id);
        } else {
          lastCheckKey = null;
          this.providerCheckSeq++;
          this.providerChecking.set(false);
          this.providerMissing.set(false);
        }
      });
    }

    // Cleanup install terminal when provider is found
    effect(() => {
      if (!this.providerMissing()) {
        this.closeInstallTerminal();
      }
    });

    // Refresh the escape-hatch availability marks whenever the guide shows
    effect(() => {
      if (this.providerMissing()) void this.loadSwitchAvailability();
    });

    // Track active session for sub-agents + history
    effect(() => {
      const session = this.activeSession();
      if (session) {
        this.subAgentService.trackSession(session.id, session.workspace?.path, session.categoryId);
        this.historyService.setCategory(session.categoryId ?? null, session.name, session.id);

        // Ensure a category exists for this session (auto-create if missing)
        if (!session.categoryId) {
          this.historyService.ensureCategory().then((catId) => {
            if (catId && !session.categoryId) {
              // Update local state so we don't re-create
              this.store.dispatch(updateSessionSuccess({
                session: { ...session, categoryId: catId },
              }));
            }
          });
        }
      }
    });
  }

  /** Persist sub-agent panel state to localStorage for update survival */
  private subAgentStateSyncEffect = effect(() => {
    const expanded = this.subAgentsExpanded();
    safeSetItem('promptops_sa_expanded', String(expanded));

    const focused = this.focusedPaneId();
    if (focused?.startsWith('sa:')) {
      const saId = focused.slice(3);
      const subs = this.subAgentService.activeSubAgents();
      const sa = subs.find((s: any) => s.id === saId);
      if (sa) {
        safeSetItem('promptops_sa_focused_role', sa.role);
      }
    }
  });

  /** Debounce timer for stored state snapshot saves */
  private backendSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tracks last sub-agent count to detect deletions and flush immediately */
  private prevSubAgentCount = -1;

  /**
   * Persist desktop state to the local desktop state file AND local store on every
   * meaningful state change. Includes the full sub-agent list so that
   * hot reload can restore the exact same sub-agents from the local store.
   * Skipped until initial restore completes to prevent overwriting defaults.
   */
  private desktopStateSyncEffect = effect(() => {
    // Guard: don't save until restore is done (avoids overwriting with defaults)
    if (!this.restoreComplete()) return;

    const active = this.activeSession();
    const expanded = this.subAgentsExpanded();
    const focused = this.focusedPaneId();
    // Read sub-agents so the effect re-fires when they change
    const agents = this.subAgentService.activeSubAgents();

    let focusedRole: string | null = null;
    if (focused?.startsWith('sa:')) {
      const saId = focused.slice(3);
      const sa = agents.find((s: any) => s.id === saId);
      if (sa) focusedRole = sa.role;
    }

    // Save to the local desktop state file (fast, survives quit)
    if (this.sessionService.isDesktop) {
      this.sessionService.saveDesktopState({
        activeSessionName: active?.name ?? null,
        subAgentsExpanded: expanded,
        focusedSubAgentRole: focusedRole,
      }).catch(() => {});
    }

    // Serialize sub-agents for local store persistence (including local IDs)
    const subAgentsList = agents.map(sa => ({
      id: sa.id,
      sessionId: sa.sessionId,
      role: sa.role,
      title: sa.title,
      icon: sa.icon,
      mode: sa.mode ?? null,
      config: sa.config ?? null,
      status: sa.status,
      autoPrompt: sa.autoPrompt,
      userPrompt: sa.userPrompt ?? '',
      provider: sa.provider,
      createdAt: sa.createdAt,
      parentSessionId: sa.parentSessionId,
    }));

    // Detect deletion: when count decreases, flush immediately so a fast
    // refresh/section-change after close doesn't restore the destroyed agent
    // from a stale state-snapshot.
    const prev = this.prevSubAgentCount;
    const isDeletion = prev >= 0 && subAgentsList.length < prev;
    this.prevSubAgentCount = subAgentsList.length;

    if (this.backendSaveTimer) clearTimeout(this.backendSaveTimer);
    this.backendSaveTimer = setTimeout(() => {
      // 1. State-snapshot (UI state + sub-agents snapshot)
      this.desktopSessionApiService.saveStateSnapshot({
        active_session_name: active?.name ?? null,
        sub_agents_state: { expanded, focused_role: focusedRole },
        ui_state: { sub_agents: subAgentsList },
      }).subscribe();

      // 2. Also sync sub-agents to the session record itself (redundant backup).
      // Always sync — including an empty list — so closing the last sub-agent
      // is reflected in the local store instead of leaving stale entries.
      if (active?.name) {
        this.desktopSessionApiService.syncSubAgentsByName(
          active.name,
          subAgentsList,
        ).subscribe();
      }
    }, isDeletion ? 0 : 2000);
  });

  /** Reset the sticky "user closed subagents accordion" flag when the
   *  active session changes — each session starts with a clean slate.
   *  Also replays the sub-agents bar drag a few seconds later so terminals
   *  that kept advancing while we were in another session re-render cleanly. */
  private resetSubagentsClosedOnSessionChange = effect(() => {
    this.activeSessionId();
    this.subagentsAccordionUserClosed.set(false);
  });

  /**
   * The spawn already handled before this view existed. `lastSpawnedId` lives
   * in a root service and is never cleared: without this baseline every new
   * Sessions view (back from Settings, window reload) re-ran the focus for
   * the last agent spawned long ago — re-expanding the panel, resetting pane
   * widths and sending it another "backup" Enter.
   */
  private readonly spawnBaseline = this.subAgentService.lastSpawnedId();
  private readonly destroyRef = inject(DestroyRef);
  private spawnFocusTimer: ReturnType<typeof setTimeout> | null = null;

  /** Auto-focus effect: reacts to lastSpawnedId from SubAgentService */
  private autoFocusEffect = effect(() => {
    // Dedicated window: the fallback Enter on the new sub-agent is already sent by the main window (no duplicates).
    if (this.dedicatedSessionId) return;
    const saId = this.subAgentService.lastSpawnedId();
    if (!saId || saId === this.spawnBaseline) return;
    // Only a NEW spawn may run this: the body reads other signals (layout
    // mode, accordion state), and tracking them re-ran the effect on every
    // layout toggle — each run sent another "backup" Enter to the last
    // spawned agent (blank prompt lines in shells, phantom prompt credits).
    untracked(() => this.focusNewSubAgent(saId));
  });

  private focusNewSubAgent(saId: string): void {
    // Expand sub-agents section and set focus state
    this.subAgentsExpanded.set(true);
    // Reset pane widths so all sub-agents get equal space in split mode
    this.subAgentPaneWidths.set({});
    if (this.currentLayoutMode() === 'code' && !this.subagentsAccordionUserClosed()) {
      this.ideAccordion.set('subagents');
    }
    this.focusedPaneId.set('sa:' + saId);
    // Ensure new agent is active tab
    this.activeSubAgentTab.set(saId);
    this.ideTerminalTab.set(saId);

    // Wait for the terminal to render, then focus it and scroll into view
    if (this.spawnFocusTimer) clearTimeout(this.spawnFocusTimer);
    this.spawnFocusTimer = setTimeout(() => {
      this.spawnFocusTimer = null;
      const terminal = this.subAgentTerminals?.find(t => t.subAgentId === saId);
      if (terminal) {
        terminal.focus();
        (terminal as any).containerRef?.nativeElement?.closest('.subagent-pane')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 500);

    // Send a backup Enter after the native prompt injection (2s paste delay + 300ms Enter)
    setTimeout(() => {
      this.subAgentService.writeToSubAgent(saId, '\r');
    }, 3000);
  }

  /** Agents model: meta (lead/closed lead) of the active session, once per session. */
  private agentsMetaLoadEffect = effect(() => {
    const id = this.activeSessionId();
    if (this.agentsEnabled && id) this.agentRoster.ensureLoaded(id);
  });

  /** Auto-select active tab when current one is removed or on first load */
  private autoTabSelectEffect = effect(() => {
    const agents = this.subAgentService.activeSubAgents();
    const tab = this.activeSubAgentTab();
    // If no agents, clear tab
    if (agents.length === 0) {
      if (tab) this.activeSubAgentTab.set(null);
      return;
    }
    // If current tab is gone, select first available. The demoted main is a
    // legitimate tab even though it is not in activeSubAgents(): without this exception
    // it would be deselected on every pass.
    const tabIsMain = !!tab && this.isMainPane(tab) && this.mainIsFlattened();
    if ((!tab || !agents.some(a => a.id === tab)) && !tabIsMain) {
      this.activeSubAgentTab.set(agents[0].id);
    }
  });

  ngOnInit(): void {
    this.removeExpandedEscapeListener = captureExpandedSubAgentEscape(
      () => !!this.expandedSubAgentId(),
      () => this.onEscapeKey(),
    );
    // Native application menu (Tauri only): the items do nothing on their own,
    // they arrive here and reuse the methods this view already has.
    this.nativeMenuSub = this.nativeMenu.sessionAction$.subscribe((cmd) =>
      this.handleNativeMenuCommand(cmd),
    );
    this.subAgentService.initListeners();
    this.agentRoster.init(); // no-op outside Tauri
    if (this.dedicatedSessionId) {
      void this.initDedicatedWindow(this.dedicatedSessionId);
      return;
    }
    // Persist main's parked sub-agent snapshots into localStorage (standby resume).
    this.subAgentStash.init();
    this.store.dispatch(loadSessions());
    this.store.dispatch(loadWorkspaces());

    // Dev-only preview helpers — stripped out of production builds by isDevMode().
    // Never registered for real users; only usable from the DevTools console of the dev server.
    if (isDevMode()) {
      const dbg = window as unknown as {
        __startSessionsGuide?: (s?: number) => void;
        __simulateNoWorkspace?: () => void;
        __exitSimulate?: () => void;
      };
      dbg.__startSessionsGuide = (s = 0) => {
        this.sessionsGuide.reset();
        this.sessionsGuide.start();
        this.sessionsGuide.goTo(s);
      };
      // Render the brand-new "no workspace" welcome state + run the real guide.
      dbg.__simulateNoWorkspace = () => {
        this.simulateEmpty.set(true);
        this.sessionsGuide.reset();
        setTimeout(() => { this.sessionsGuide.start(); }, 350);
      };
      dbg.__exitSimulate = () => {
        this.simulateEmpty.set(false);
        this.sessionsGuide.complete();
      };
      console.debug('%c[SessionsGuide] dev preview — __simulateNoWorkspace() / __startSessionsGuide(step) / __exitSimulate()', 'color:#a855f7;font-weight:bold');
    }

    // Unified restore: always fetch UI state from local store (source of truth),
    // then activate the session from localStorage savedId or local store snapshot.
    // Do not remove the key: if the restore fails or there is no click before the
    // next restart, the last session would be lost.
    const savedId = localStorage.getItem(ACTIVE_SESSION_KEY);
    const savedName = localStorage.getItem(ACTIVE_SESSION_NAME_KEY);
    this.restoreFromStore(savedId, savedName);

    // Keep the sidebar in sync with the local store.
    this.pollingHub.register('sessions', () => this.store.dispatch(loadSessions()), 45_000);

    // Listen for query param navigation (from hook service or system notification)
    this.routeSub = this.route.queryParams.subscribe((params) => {
      if (params['session'] && params['focus']) {
        this.activateAndFocus(params['session']);
      }
    });
  }

  /** Header: opens the active session in its own window, or from the dedicated window goes back to the main one. */
  toggleDedicatedWindow(): void {
    if (this.dedicatedSessionId) {
      void tauri()?.window?.getCurrentWindow().close();
      return;
    }
    const s = this.activeSession();
    if (s) void this.sessionWindows.open(s);
  }

  /** Dedicated window: sessions from the main window, output copy, then the session becomes active. */
  private async initDedicatedWindow(sessionId: string): Promise<void> {
    // Agent permissions and questions (in the main window the layout starts them, and it is not here).
    this.interactionService.init();
    try {
      this.dedicatedOff = await this.sessionWindows.attach(sessionId);
      this.store.dispatch(loadWorkspaces());
      // Output copy first, then the terminal: so nothing is lost between replay and live.
      const api = (window as any).promptops;
      await api?.watchSessionOutput?.(sessionId);
    } catch (err) {
      console.warn('[session-view] dedicated window attach failed', err);
    } finally {
      // Never leave the window blank: show the session even if the attach failed.
      this.store.dispatch(setActiveSession({ sessionId }));
    }
  }

  /**
   * Unified restore: fetch UI state from local store (source of truth),
   * then activate the correct session and restore sub-agent panel state.
   *
   * @param savedId  Session ID/name from localStorage (set by switchToSession) — may be null.
   */
  private async restoreFromStore(savedId: string | null, savedName: string | null = null): Promise<void> {
    try {
      // 1. Fetch state-snapshot from local store (source of truth)
      let snapshot: {
        active_session_name: string | null;
        sub_agents_state: { expanded: boolean; focused_role: string | null } | null;
        ui_state: { sub_agents?: any[] } | null;
      } | null = null;

      try {
        snapshot = await firstValueFrom(this.desktopSessionApiService.getStateSnapshot());
      } catch { /* store unavailable — will try the local fallback */ }

      // 2. Fallback to the local desktop state file when local store returned nothing
      if (!snapshot && this.sessionService.isDesktop) {
        try {
          const local = await this.sessionService.getDesktopState();
          if (local) {
            snapshot = {
              active_session_name: local.activeSessionName,
              sub_agents_state: {
                expanded: local.subAgentsExpanded,
                focused_role: local.focusedSubAgentRole,
              },
              ui_state: null,
            };
          }
        } catch { /* no local state either */ }
      }


      // 3. Restore sub-agent panel UI state (always, regardless of savedId)
      if (snapshot?.sub_agents_state) {
        if (snapshot.sub_agents_state.expanded) {
          this.subAgentsExpanded.set(true);
          safeSetItem('promptops_sa_expanded', 'true');
        }
        if (snapshot.sub_agents_state.focused_role) {
          safeSetItem('promptops_sa_focused_role', snapshot.sub_agents_state.focused_role);
        }
      }

      // 4. Determine which session to activate: saved id, then saved name (live ids
      //    can change across a restart/update), then the local store snapshot name.
      const targetId = savedId ?? null;
      const targetName = savedName ?? null;
      const snapshotName = snapshot?.active_session_name ?? null;

      if (!targetId && !targetName && !snapshotName) {
        this.restoreComplete.set(true);
        return;
      }

      const findMatch = (sessions: SessionSummary[]) =>
        (targetId ? (sessions.find(s => s.id === targetId) ?? sessions.find(s => s.name === targetId)) : undefined)
        ?? (targetName ? sessions.find(s => s.name === targetName) : undefined)
        ?? (snapshotName ? sessions.find(s => s.name === snapshotName) : undefined);

      // 5. Wait until the target session shows up (after a restart the store fills
      //    in steps: the first non-empty emission may not contain it yet), max 15s.
      //    Using first() with predicate to auto-unsubscribe — avoids TDZ error
      //    when the store emits synchronously before subscribe() returns.
      this.store.select(getSessions).pipe(
        first(sessions => !!findMatch(sessions)),
        timeout({ first: 15_000 }),
        // Leaving the view within the 15 s window must not switch sessions
        // or start focus timers on a destroyed view.
        takeUntilDestroyed(this.destroyRef),
      ).subscribe({ error: () => this.restoreComplete.set(true), next: (sessions) => {
        const match = findMatch(sessions);

        if (match) {
          // 6. Populate sub-agents from local store ONLY if restoring the same session
          //    they belong to (snapshot.active_session_name matches the target).
          //    On session switch (switchToSession → savedId set), the snapshot
          //    still has sub-agents from the OLD session — skip those.
          const storedSubAgents = snapshot?.ui_state?.sub_agents;
          const snapshotSessionName = snapshot?.active_session_name;
          const subAgentsBelongToTarget = snapshotSessionName && match.name === snapshotSessionName;
          if (storedSubAgents && storedSubAgents.length > 0 && subAgentsBelongToTarget) {
            this.subAgentService.populateFromStore(storedSubAgents, match.id, match.subAgentsOrder);
          }

          // Parked session restored as active (auto-standby lazy boot, or a
          // park from another device): it is not woken here. The landing stays
          // lazy — no CLI spawn until the user asks (standby cover CTA /
          // wakeParkedSession) — so opening the Sessions section never
          // triggers provider resumes by itself.

          this.store.dispatch(setActiveSession({ sessionId: match.id }));

          // Restore focused sub-agent (immediate — sub-agents are already populated)
          const focusedRole = snapshot?.sub_agents_state?.focused_role;
          if (focusedRole) {
            // Small delay to let the effect cycle propagate
            setTimeout(() => {
              const subs = this.subAgentService.activeSubAgents();
              const saMatch = subs.find((sa: any) => sa.role === focusedRole);
              if (saMatch) {
                this.focusedPaneId.set('sa:' + saMatch.id);
              }
            }, 300);
          }

          // A terminal waiting for input takes priority over the restored
          // role focus — attempts run after the role restore above. No main
          // fallback: startup behavior stays unchanged when nothing waits.
          this.scheduleAutoFocusOnOpen(match.id, {
            delays: [600, 1200, 2200],
            fallbackToMain: false,
          });
        }

        this.restoreComplete.set(true);
      } });
    } catch (err) {
      this.restoreComplete.set(true);
    }
  }

  ngOnDestroy(): void {
    this.remoteBridge.stop();
    window.removeEventListener('online', this.onBrowserOnline);
    if (this.sessionsRetryTimer) { clearTimeout(this.sessionsRetryTimer); this.sessionsRetryTimer = null; }
    this.removeExpandedEscapeListener?.();
    this.saGridObserver?.disconnect();
    this.routeSub?.unsubscribe();
    this.dedicatedOff?.();
    this.nativeMenuSub?.unsubscribe();
    this.pollingHub.unregister('sessions');

    // Flush the pending local store save immediately instead of canceling it,
    // so sub-agent state is preserved for the next navigation back.
    if (this.backendSaveTimer) {
      clearTimeout(this.backendSaveTimer);
      if (!this.dedicatedSessionId) this.flushBackendSave();
    }

    document.removeEventListener('keydown', this.keyDownCapture, true);
    this.cancelAutoFocusOnOpen();
    if (this.spawnFocusTimer) { clearTimeout(this.spawnFocusTimer); this.spawnFocusTimer = null; }
    this.cancelSidebarSubAgentFocus();
    this.subAgentService.destroyListeners();
    this.closeInstallTerminal();
    document.documentElement.style.removeProperty('--session-sidebar-w');
  }

  /** Immediately persist current state to local store (fire-and-forget). */
  private flushBackendSave(): void {
    const active = this.activeSession();
    const agents = this.subAgentService.activeSubAgents();
    if (!active || agents.length === 0) return;

    const expanded = this.subAgentsExpanded();
    const focused = this.focusedPaneId();
    let focusedRole: string | null = null;
    if (focused?.startsWith('sa:')) {
      const saId = focused.slice(3);
      const sa = agents.find((s: any) => s.id === saId);
      if (sa) focusedRole = sa.role;
    }

    const subAgentsList = agents.map(sa => ({
      id: sa.id,
      sessionId: sa.sessionId,
      role: sa.role,
      title: sa.title,
      icon: sa.icon,
      mode: sa.mode ?? null,
      config: sa.config ?? null,
      status: sa.status,
      autoPrompt: sa.autoPrompt,
      userPrompt: sa.userPrompt ?? '',
      provider: sa.provider,
      createdAt: sa.createdAt,
      parentSessionId: sa.parentSessionId,
    }));

    this.desktopSessionApiService.saveStateSnapshot({
      active_session_name: active.name ?? null,
      sub_agents_state: { expanded, focused_role: focusedRole },
      ui_state: { sub_agents: subAgentsList },
    }).subscribe();
  }

  /** Activate a session and focus the terminal */
  private activateAndFocus(sessionId: string): void {
    if (sessionId !== this.activeSessionId()) {
      this.store.dispatch(setActiveSession({ sessionId }));
    }
    this.scheduleAutoFocusOnOpen(sessionId);
    this.nudgeLayoutForRefit();
    this.hookService.focusSessionId.set(null);
  }

  // ── Auto-focus on session open: land on the first terminal waiting for input ──

  private autoFocusTimers: ReturnType<typeof setTimeout>[] = [];

  private cancelAutoFocusOnOpen(): void {
    for (const t of this.autoFocusTimers) clearTimeout(t);
    this.autoFocusTimers = [];
  }

  /**
   * When a session is opened, move focus to the first terminal that is
   * asking for input instead of always landing on main:
   *  1. main terminal, only when visible (not covered by cover-main) and
   *     itself in `waiting_input`;
   *  2. otherwise the first sub-agent in roster (display) order with
   *     status `waiting_input` — expanding the panel/tab to reveal it.
   * Falls back to the previous behavior (focus main) when nothing waits.
   *
   * Runs multiple passes: sub-agents are reloaded asynchronously
   * (trackSession IPC) right after a switch, so their waiting_input status
   * may arrive a moment after the session becomes active. Later passes only
   * move focus if it is not already on a terminal that is asking for input.
   */
  private scheduleAutoFocusOnOpen(
    sessionId: string,
    opts: { delays?: number[]; fallbackToMain?: boolean } = {},
  ): void {
    const delays = opts.delays ?? [200, 700, 1500];
    const fallbackToMain = opts.fallbackToMain ?? true;
    this.cancelAutoFocusOnOpen();
    delays.forEach((delay, i) => {
      const timer = setTimeout(() => {
        if (this.activeSessionId() !== sessionId) {
          this.cancelAutoFocusOnOpen();
          return;
        }
        if (this.tryFocusInputRequired(i === 0 && fallbackToMain)) {
          this.cancelAutoFocusOnOpen();
        }
      }, delay);
      this.autoFocusTimers.push(timer);
    });
  }

  /** One auto-focus pass. Returns true when focus is settled (stop retrying). */
  private tryFocusInputRequired(applyMainFallback: boolean): boolean {
    if (this.tutorialService.active() || this.aaSelectMode()) return true;
    const session = this.activeSession();
    if (!session) return false;

    const roster = this.subAgentService.activeRoster();

    // Focus already sits on a terminal that is asking for input — done.
    const focused = this.focusedPaneId();
    const focusedWaiting = focused === 'main'
      ? session.status === 'waiting_input'
      : !!focused && roster.find(a => 'sa:' + a.id === focused)?.status === 'waiting_input';
    if (focusedWaiting) return true;

    // Single sub-agent expanded fullscreen: it is the only visible terminal.
    // Focus it only when it is the one waiting — never yank the modal around.
    const expandedId = this.expandedSubAgentId();
    if (expandedId && roster.some(a => a.id === expandedId)) {
      if (roster.find(a => a.id === expandedId)?.status === 'waiting_input') {
        this.focusSubAgentForInput(expandedId);
      }
      return true;
    }

    // Main pane visible (not covered by sub-agents) and itself waiting → main wins.
    const mainCovered = this.subAgentsCoverMain() && roster.length > 0;
    if (!mainCovered && session.status === 'waiting_input') {
      this.focusedPaneId.set('main');
      this.terminalRef?.focus();
      return true;
    }

    // First sub-agent in display order waiting for input. In IDE layout,
    // respect the user's explicit collapse of the terminal sidebar.
    const ideClosed = this.currentLayoutMode() === 'code' && this.ideRightCollapsed();
    const waiting = roster.find(a => a.status === 'waiting_input');
    if (waiting && !ideClosed) {
      this.focusSubAgentForInput(waiting.id);
      return true;
    }

    if (applyMainFallback) {
      this.terminalRef?.focus();
    }
    return false;
  }

  /** Reveal + focus a sub-agent terminal: expand panel/accordion, switch tab. */
  private focusSubAgentForInput(id: string): void {
    this.subAgentsExpanded.set(true);
    if (this.currentLayoutMode() === 'code') {
      this.ideRightCollapsed.set(false);
    }
    this.switchSubAgentTab(id);
    setTimeout(() => {
      const terminal = this.subAgentTerminals?.find(t => t.subAgentId === id);
      (terminal as any)?.containerRef?.nativeElement
        ?.closest('.subagent-pane')
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 200);
  }

  /** Re-fit the main terminal (and every visible sub-agent terminal) against
   *  the current container size and force a full canvas refresh. Used when
   *  returning to a session — the terminal may have been hidden, so its
   *  cell metrics / canvas can be stale even if dimensions look unchanged.
   *
   *  Deferred ~800ms and cancelable: if the user navigates away again
   *  before it fires, the refit is dropped (avoids breaking glyphs mid-fit).
   *
   *  Independent of action-center / IDE-right sidebar state — works the same
   *  whether the sub-agents bar is open or closed.
   */
  private nudgeRefitTimer: ReturnType<typeof setTimeout> | null = null;
  private nudgeLayoutForRefit(delay = 800): void {
    // Windows "Safe terminal": skip the post-switch reflow nudge entirely so the
    // renderer does zero extra work on session switch. Flag is only ever true on
    // Windows (set by UiPreferencesService.apply), so macOS/Linux are untouched.
    if ((window as any).__PO_SAFE_TERMINAL__) return;
    // [Tauri] The 800ms nudge below is what makes the grid visibly jump long
    // after the switch already looked finished. Refit once the very next frame
    // has laid out too: by then the panel has its real size, so the late nudge
    // usually has nothing left to change. Other hosts keep only the single late nudge.
    if (this.sessionService.isTauri) {
      requestAnimationFrame(() => {
        if (this.resizing || this.acResizing || this.saResizing || this.saHResizing) return;
        this.terminalRef?.refit();
        this.subAgentTerminals?.forEach((t) => t.refit());
      });
    }
    if (this.nudgeRefitTimer !== null) {
      clearTimeout(this.nudgeRefitTimer);
    }
    this.nudgeRefitTimer = setTimeout(() => {
      this.nudgeRefitTimer = null;
      if (this.resizing || this.acResizing || this.saResizing || this.saHResizing) {
        return;
      }
      this.terminalRef?.refit();
      this.subAgentTerminals?.forEach((t) => t.refit());
    }, delay);
  }

  /** True in the Tauri v2 host — gates the lazy standby cover. */
  get isTauriHost(): boolean {
    return this.sessionService.isTauri;
  }

  /** Standby-cover CTA: resume the parked session on explicit user request. */
  wakeParkedSession(sessionId: string): void {
    this.store.dispatch(wakeSession({ sessionId }));
  }

  /**
   * Select a session.
   * - If idle (saved in DB, no terminal yet), spawn a new terminal first.
   * - Then switch to it via state update (no page reload).
   */
  async selectSession(sessionId: string): Promise<void> {
    // Dedicated window: stay on this session.
    if (this.dedicatedSessionId && sessionId !== this.dedicatedSessionId) return;
    // Full-screen floor plan: opening a session shrinks it to a side panel, and its notice turns off.
    this.floorPlan.dock();
    this.floorPlan.acknowledge(sessionId);
    if (sessionId === this.activeSessionId()) {
      // Active-but-parked (Tauri lazy landing): the early-return would make
      // the session unwakeable by click — wake it here instead.
      const active = this.sessions().find((s) => s.id === sessionId);
      if (active?.standbyAt) this.store.dispatch(wakeSession({ sessionId }));
      return;
    }

    const session = this.sessions().find((s) => s.id === sessionId);
    if (!session) return;

    // Parked session → wake it (re-spawns the provider with --resume), then
    // switch to it. Covers the collapsed-rail click path too.
    if (session.standbyAt) {
      this.store.dispatch(wakeSession({ sessionId }));
      this.switchToSession(sessionId);
      return;
    }

    // If the session is already live (not idle), switch to it
    if (session.status !== 'idle') {
      this.switchToSession(sessionId);
      return;
    }

    // Session is idle (from DB) — need to spawn a terminal
    if (this.sessionService.isDesktop) {
      // A second click (or the floor plan) while the first spawn is in flight
      // would spawn a second terminal for the same record.
      if (this.openingIdleSessions.has(sessionId)) return;
      this.openingIdleSessions.add(sessionId);
      try {
        // Check if there's already a live terminal with this exact name.
        // A live terminal already bound to another row is never reused: with
        // two sessions of the same name the click would open the other one.
        const liveSessions = await this.sessionService.listSessions();
        const bound = new Set(this.sessions().map((s) => s.id));
        const existing = liveSessions.find(
          (ls: any) => ls.name === session.name && !bound.has(ls.id),
        );

        if (existing) {
          // Replace idle session in store with the live one
          this.store.dispatch(activateSavedSession({
            savedSessionId: session.id,
            // Tauri: the real state comes from Rust — never a presumed RUNNING
            // (UX audit 10/2026).
            liveSession: { ...session, id: existing.id, status: existing.status ?? (this.sessionService.isTauri ? 'idle' : 'running') },
          }));
          this.scheduleAutoFocusOnOpen(existing.id);
          this.nudgeLayoutForRefit();
          return;
        }

        // Spawn a new terminal
        const result = await this.sessionService.createSession({
          name: session.name,
          provider: session.provider,
          config: {
            cwd: session.workspace?.path,
          },
        });

        if (result.ok && result.session) {
          // Replace idle session in store with the live one
          this.store.dispatch(activateSavedSession({
            savedSessionId: session.id,
            liveSession: {
              ...session,
              id: result.session.id,
              status: this.sessionService.isTauri ? (result.session.status ?? 'idle') : 'running',
            },
          }));
          if (this.sessionService.isTauri) this.resyncLiveStatus(result.session.id);
          this.scheduleAutoFocusOnOpen(result.session.id);
          this.nudgeLayoutForRefit();
          return;
        }
        this.swalService.error(this.translateService.instant('SESSIONS.Wake_Failed'));
      } catch (err) {
        console.warn('[session-view] could not open saved session', err);
        this.swalService.error(this.translateService.instant('SESSIONS.Wake_Failed'));
      } finally {
        this.openingIdleSessions.delete(sessionId);
      }
    }

    this.switchToSession(sessionId);
  }

  /** Saved sessions whose terminal is being spawned by {@link selectSession}. */
  private readonly openingIdleSessions = new Set<string>();

  /**
   * State-driven session switch (no page reload).
   * Updates the store → terminal component reacts via OnChanges → reinitializes.
   */
  private switchToSession(sessionId: string): void {
    if (this.tutorialService.active()) return;
    if (sessionId === this.activeSessionId()) return;


    // Persist for manual-refresh resilience (read by restoreFromStore on next init)
    if (!this.dedicatedSessionId) safeSetItem(ACTIVE_SESSION_KEY, sessionId);

    // State-driven switch: update store → signals propagate → terminal reinits
    this.store.dispatch(setActiveSession({ sessionId }));

    // Focus the first input-required terminal after the render cycle completes
    this.scheduleAutoFocusOnOpen(sessionId);
    this.nudgeLayoutForRefit();
  }

  /** Quick-start entry from welcome state — pre-fills session name from i18n key. */
  openCreateModalForKind(kind: 'debug' | 'refactor' | 'explore'): void {
    const keyByKind = {
      debug: 'SESSIONS.Quickstart_Debug_Name',
      refactor: 'SESSIONS.Quickstart_Refactor_Name',
      explore: 'SESSIONS.Quickstart_Explore_Name',
    } as const;
    this.openCreateModal(this.translateService.instant(keyByKind[kind]));
  }

  openCreateModal(
    presetName?: string,
    presetFolder?: { path: string; name: string },
  ): void {
    const modalRef = this.modalService.open(CreateSessionModalComponent, {
      centered: true,
      size: 'lg',
    });

    if (presetName) {
      modalRef.componentInstance.name = presetName;
    }

    // Folder dragged onto the sidebar: pre-fill the path and lock the modal to
    // a standalone session (no workspace binding). The provider still defaults
    // to the user's last-used one via the modal's resolveDefaultProvider.
    if (presetFolder) {
      modalRef.componentInstance.forceMode = 'standalone';
      modalRef.componentInstance.presetWorkspace = {
        id: '',
        path: presetFolder.path,
        name: presetFolder.name,
      };
      if (!presetName) {
        modalRef.componentInstance.name = presetFolder.name;
      }
    }

    modalRef.result.then(
      (result) => {
        if (result && result.mode === 'create') {
          // The modal may have created the workspace inline (find-or-create).
          // Refresh the workspaces store so the sidebar groups the new session
          // immediately (mirrors openCreateWorkspaceModal / addTab flows).
          if (result.workspaceId) {
            this.store.dispatch(loadWorkspaces());
          }
          const workspacePath = result.config?.cwd as string | undefined;

          if (workspacePath && this.sessionService.isDesktop) {
            // Show context snapshot modal before creating the session
            const snapshotRef = this.modalService.open(ContextSnapshotModalComponent, {
              centered: true,
              size: 'md',
            });
            snapshotRef.componentInstance.workspacePath = workspacePath;
            snapshotRef.componentInstance.provider = result.provider;

            snapshotRef.result.then(
              () => this.store.dispatch(createSession(result)),
              () => this.store.dispatch(createSession(result)), // create session even if modal dismissed
            );
          } else {
            this.store.dispatch(createSession(result));
          }
        } else if (result) {
          // Edit mode — no snapshot needed
          this.store.dispatch(createSession(result));
        }
      },
      () => {},
    );
  }

  /**
   * A folder was dragged from the OS onto the sessions sidebar (minimal UI).
   * If the path already matches a workspace or a standalone session, offer to
   * open the existing one; otherwise open the create modal pre-filled as a
   * brand-new standalone session.
   */
  onSidebarDropFolder(rawPath: string): void {
    const norm = (p?: string | null) => (p ?? '').replace(/[\\/]+$/, '').trim();
    const target = norm(rawPath);
    if (!target) return;
    const name = target.split(/[\\/]/).pop() || target;

    // Already a workspace at this path (with at least one live session to open)?
    const ws = this.workspaces().find((w) => norm(w.projectPath) === target);
    const wsSession = ws
      ? this.sessions().find((s) => s.workspaceId === ws.id || norm(s.workspace?.path) === target)
      : undefined;
    if (ws && wsSession) {
      this.swalService.confirm(
        this.translateService.instant('SESSIONS.DROP_FOLDER.Workspace exists title'),
        this.translateService.instant('SESSIONS.DROP_FOLDER.Workspace exists message', {
          name: ws.name,
        }),
        () => this.selectSession(wsSession.id),
      );
      return;
    }

    // Already a standalone session at this path?
    const standalone = this.sessions().find(
      (s) => !s.workspaceId && norm(s.workspace?.path) === target,
    );
    if (standalone) {
      this.swalService.confirm(
        this.translateService.instant('SESSIONS.DROP_FOLDER.Session exists title'),
        this.translateService.instant('SESSIONS.DROP_FOLDER.Session exists message', {
          name: standalone.name,
        }),
        () => this.selectSession(standalone.id),
      );
      return;
    }

    // New folder → create a standalone session pre-filled with this path.
    this.openCreateModal(undefined, { path: target, name });
  }

  /**
   * Workspace-first: open the create-session modal in workspace-only mode.
   * Triggered by the dedicated "New Workspace" sidebar button (flag-gated).
   * The modal exposes a toggle "Also create an initial session" — if ON,
   * we receive `mode: 'create-workspace-and-session'` and dispatch a
   * createSession bound to the new workspace.
   */
  openCreateWorkspaceModal(): void {
    const modalRef = this.modalService.open(CreateSessionModalComponent, {
      centered: true,
      size: 'lg',
    });
    modalRef.componentInstance.forceMode = 'workspace';
    modalRef.componentInstance.skipSessionCreation = true;

    modalRef.result.then(
      (result) => {
        if (result?.mode === 'create-workspace-only') {
          // Refresh the workspaces store so the new empty workspace shows up.
          this.store.dispatch(loadWorkspaces());
        } else if (result?.mode === 'create-workspace-and-session') {
          // Workspace already created in the modal — dispatch the initial
          // session creation inside it. loadWorkspaces refreshes the sidebar
          // grouping so the new workspace + session show up together.
          this.store.dispatch(loadWorkspaces());
          this.store.dispatch(createSession({
            name: result.name,
            provider: result.provider,
            config: result.config,
            categoryId: result.categoryId ?? null,
            teamId: result.teamId ?? null,
            projectId: result.projectId ?? null,
            workspaceId: result.workspaceId ?? null,
          }));
        }
      },
      () => {},
    );
  }

  /**
   * Workspace-first: open a promote dialog for a standalone session.
   * Reuses CreateSessionModal in workspace mode + pre-selects the session's
   * existing path if any, then dispatches promoteSessionToWorkspace.
   */
  openPromoteSessionModal(sessionId: string): void {
    const session = this.sessions().find((s) => s.id === sessionId);
    if (!session) return;
    if (session.workspaceId) return; // unidirectional: bound sessions are immutable

    const modalRef = this.modalService.open(CreateSessionModalComponent, {
      centered: true,
      size: 'lg',
    });
    modalRef.componentInstance.forceMode = 'workspace';
    modalRef.componentInstance.skipSessionCreation = true;
    if (session.workspace?.path) {
      modalRef.componentInstance.workspace = {
        path: session.workspace.path,
        name: session.workspace.name ?? '',
      };
    }

    modalRef.result.then(
      (result) => {
        if (result?.mode === 'create-workspace-only' && result.workspace?.project_path) {
          this.store.dispatch(promoteSessionToWorkspace({
            sessionId,
            projectPath: result.workspace.project_path,
            workspaceName: result.workspace.name,
          }));
        }
      },
      () => {},
    );
  }

  /**
   * Add a new tab (session) inside the current workspace.
   * If no workspace exists yet, create one first, link the current session to it,
   * then create the new session.
   */
  async addTabSession(): Promise<void> {
    // Integrated "Multi-session workspace" plugin off: one session per workspace, no new tabs.
    if (!this.builtins.isOn('multi-session')) return;
    const currentSession = this.activeSession();
    if (!currentSession) return;
    // Two quick "+" clicks would both pick the same next number and name.
    if (this.addingTab) return;
    this.addingTab = true;
    try {
      await this.addTabSessionFor(currentSession);
    } finally {
      this.addingTab = false;
    }
  }

  private addingTab = false;

  private async addTabSessionFor(currentSession: SessionSummary): Promise<void> {

    let projectPath = currentSession.workspace?.path;
    let projectName = currentSession.workspace?.name;

    // If the session has no workspace path, ask the user to select one
    if (!projectPath && this.sessionService.isDesktop) {
      try {
        const selected = await this.sessionService.selectWorkspace();
        if (!selected) return;
        projectPath = selected.path;
        projectName = selected.name;
      } catch {
        return;
      }
    }

    if (!projectPath) return;
    if (!projectName) projectName = projectPath.split(/[\\/]/).filter(Boolean).pop() || 'Workspace';

    let workspaceId = currentSession.workspaceId;
    const nameBase = currentSession.name.replace(/\s+\d+$/, '');

    // If the current session doesn't have a workspace yet, create one and rename first session to "Name 1"
    if (!workspaceId) {
      const ws = await firstValueFrom(this.workspaceApiService.findOrCreate({
        project_path: projectPath,
        name: projectName!,
      }));

      if (!ws) return;
      workspaceId = ws.id;

      // Log workspace creation
      this.historyService.logWorkspaceCreated(projectName!, projectPath!);

      const firstName = `${nameBase} 1`;
      // Saving under a name another session already has would overwrite that
      // session (sessions.create replaces the record with the same name).
      const takenBy = (name: string) => this.sessions().some((s) => s.id !== currentSession.id && s.name === name);
      if (firstName !== currentSession.name && takenBy(firstName)) {
        this.swalService.error(this.translateService.instant('USERS_ADMIN.Session name taken'));
        return;
      }

      // Update the saved session (found by id, else by its current name);
      // create it only when it was never saved.
      let saved: SessionSummary | null = null;
      try {
        saved = await firstValueFrom(
          this.desktopSessionApiService.update(currentSession.id, {
            workspace_id: workspaceId,
            name: firstName,
            _lookup_name: currentSession.name,
          }, { rethrow: true }),
        );
      } catch (err) {
        if (isDataError(err, 'session_name_taken')) {
          this.swalService.error(this.translateService.instant('USERS_ADMIN.Session name taken'));
          return;
        }
        if (!isDataError(err, 'not_found')) {
          console.warn('[session-view] could not move the session into a workspace', err);
          this.swalService.error(this.translateService.instant('SESSIONS.Create_Failed'));
          return;
        }
        saved = await firstValueFrom(
          this.desktopSessionApiService.create({
            name: firstName,
            provider: currentSession.provider,
            workspace_path: projectPath,
            workspace_name: projectName,
            workspace_id: workspaceId,
            local_session_id: currentSession.id,
          }),
        );
      }
      if (!saved) {
        this.swalService.error(this.translateService.instant('SESSIONS.Create_Failed'));
        return;
      }

      // Update name and workspaceId in the live desktop session
      if (this.sessionService.isDesktop) {
        try {
          await this.sessionService.updateSessionMeta(currentSession.id, {
            name: firstName,
            workspaceId,
          });
        } catch { /* session might not be live */ }
      }

      // Update local store
      this.store.dispatch(updateSessionSuccess({
        session: { ...currentSession, workspaceId, name: firstName },
      }));
    }

    // Find the next available number
    const allSessions = this.sessions();
    const numbersInUse: number[] = [1];
    for (const s of allSessions) {
      if (s.workspaceId === workspaceId || s.id === currentSession.id) {
        const m = s.name.match(/\s+(\d+)$/);
        if (m) numbersInUse.push(parseInt(m[1], 10));
      }
    }
    let nextNumber = Math.max(...numbersInUse) + 1;
    // A session elsewhere may already use the name: never reuse it (the save
    // would overwrite that session).
    const namesInUse = new Set(allSessions.map((s) => s.name));
    while (namesInUse.has(`${nameBase} ${nextNumber}`)) nextNumber++;
    const sessionName = `${nameBase} ${nextNumber}`;

    // Create session history category
    let categoryId: number | null = null;
    try {
      categoryId = await this.historyService.createSessionCategory(sessionName);
    } catch { /* not critical */ }

    // Log tab addition
    this.historyService.logTabAdded(sessionName);

    // Dispatch creation — spawns a new Claude context
    this.store.dispatch(createSession({
      name: sessionName,
      provider: currentSession.provider,
      config: { cwd: projectPath },
      categoryId,
      workspaceId,
    }));

    this.store.dispatch(loadWorkspaces());
    // createSession effect → createSessionSuccess → sets activeSessionId automatically.
    // Terminal component reacts to the change via OnChanges — no reload needed.
  }

  /** Switch to a tab (sibling session) without page reload */
  switchTab(sessionId: string): void {
    this.switchToSession(sessionId);
  }

  /**
   * Native application menu items (Tauri). Every branch delegates to a method that
   * already exists: the menu does not introduce behavior of its own, otherwise the app
   * would have two different paths for the same action.
   */
  private handleNativeMenuCommand(cmd: NativeMenuCommand): void {
    const activeId = this.activeSessionId();

    switch (cmd.action) {
      case 'session-new':
        this.openCreateModal();
        return;
      case 'session-new-tab':
        // Without the multi-session plugin the native "New Session Tab" menu opens the creation of a new session.
        if (this.builtins.isOn('multi-session')) this.addTabSession(); else this.openCreateModal();
        return;
      case 'session-close':
        if (activeId) this.closeTabSession(activeId);
        return;
      case 'session-rename':
        if (activeId) this.sidebarEditSession(activeId);
        return;
      case 'session-standby':
        if (activeId) this.sidebarStandbySession(activeId);
        return;
      case 'session-prev':
        this.stepSession(-1);
        return;
      case 'session-next':
        this.stepSession(1);
        return;
      case 'subagent-spawn':
        // The spawn lives in the Action Center: the menu opens it, it does not duplicate the form.
        this.setActionCenterCollapsed(false);
        return;
      case 'workspace-open':
        this.openCreateWorkspaceModal();
        return;
      case 'workspace:open-recent':
        if (cmd.payload) this.onSidebarDropFolder(cmd.payload);
        return;
      case 'git-explorer':
        this.openGitExplorer();
        return;
      case 'db-explorer':
        this.openDatabaseExplorer();
        return;
      case 'terminals':
        this.openTerminalsPanel();
        return;
    }
  }

  /** Previous/next session in tab order, with wrap-around. */
  private stepSession(delta: number): void {
    const list = this.sessions();
    if (list.length < 2) return;
    const currentId = this.activeSessionId();
    const currentIndex = list.findIndex((s) => s.id === currentId);
    // No active session: start from the first (delta 1) or from the last (-1).
    const base = currentIndex >= 0 ? currentIndex : delta > 0 ? -1 : 0;
    const next = (base + delta + list.length) % list.length;
    const target = list[next];
    if (target?.id && target.id !== currentId) this.switchTab(target.id);
  }

  /** Reorder tabs via drag & drop */
  reorderTabs(sessionIds: string[]): void {
    this.store.dispatch(reorderSessions({ sessionIds }));

    // Persist the new order to the local store
    const active = this.activeSession();
    if (active?.workspaceId) {
      // reorderSessions resolves false on failure: reload the saved order so
      // the tabs do not show an order that was never stored.
      this.desktopSessionApiService.reorderSessions(active.workspaceId, sessionIds)
        .subscribe((saved) => { if (!saved) this.store.dispatch(loadSessions()); });
    }
  }

  closeTabSession(sessionId: string): void {
    // Delegate to destroySession which handles workspace last-session check
    this.destroySession(sessionId);
  }

  renameTabSession(event: { sessionId: string; name: string }): void {
    const session = this.sessions().find(s => s.id === event.sessionId);
    if (!session) return;

    const modalRef = this.modalService.open(RenameSessionModalComponent, {
      centered: true,
      size: 'sm',
    });
    modalRef.componentInstance.sessionId = session.id;
    modalRef.componentInstance.name = event.name;

    modalRef.result.then(
      async (result: { sessionId: string; name: string }) => {
        if (this.sessionService.isTauri) {
          this.renameTabSessionOptimistic(session.id, session.name, result.name);
          return;
        }
        // Non-Tauri hosts: apply the rename to the store only after the
        // local store accepts it. Store-first means a canceled name conflict never
        // leaves a half-renamed session, so no revert is needed.
        const applyLocal = async () => {
          this.store.dispatch(updateSessionSuccess({
            session: { ...session, name: result.name },
          }));
        };

        // Save it (old name as fallback lookup). force=true resolves a name
        // collision by renaming the conflicting session first.
        const persist = (force: boolean) => {
          this.desktopSessionApiService.rename(result.sessionId, result.name, session.name, force).subscribe({
            next: () => {
              applyLocal();
              // When forced, the other session was renamed too —
              // reload so its new name is reflected in the UI.
              if (force) this.store.dispatch(loadSessions());
            },
            error: (err) => {
              // Name already used by another of the user's sessions (unique per
              // user). Ask whether to force: the store frees the name by
              // renaming the other session first, then assigns it here.
              if (!force && isDataError(err, 'session_name_taken')) {
                const conflictName = (err.details?.['conflict_name'] as string | undefined) ?? result.name;
                this.swalService.confirm(
                  this.translateService.instant('USERS_ADMIN.Session name taken'),
                  this.translateService.instant('USERS_ADMIN.Force rename conflict', { name: conflictName }),
                  () => persist(true),
                );
                return;
              }
              if (isDataError(err, 'session_name_taken') || isDataError(err, 'invalid')) {
                // A forced attempt still failed (rare race): inform, no local change.
                this.swalService.error(
                  this.translateService.instant('USERS_ADMIN.Session name taken'),
                );
                return;
              }
              // Any other failure (for example a storage error): keep the
              // local rename so the UI isn't blocked.
              applyLocal();
            },
          });
        };

        persist(false);
      },
      () => {},
    );
  }

  /**
   * Desktop app (Tauri): optimistic rename. The name changes right away
   * (store + live session in Rust); if saving it is rejected because the name
   * is already used it goes back to the previous name and asks whether to force,
   * reapplying it only after the OK. On any other failure the local name stays
   * (the exit persist recovers it via `name_authoritative`).
   */
  private renameTabSessionOptimistic(sessionId: string, oldName: string, newName: string): void {
    if (!newName || newName === oldName) return;

    const applyLocal = (name: string) => {
      // Always from the current store: an old snapshot would overwrite fields
      // changed in the meantime (standby, workspace…).
      const current = this.sessions().find(s => s.id === sessionId);
      if (current) this.store.dispatch(updateSessionSuccess({ session: { ...current, name } }));
      void Promise.resolve(this.sessionService.renameSession(sessionId, name)).catch(() => {});
    };

    applyLocal(newName);

    const persist = (force: boolean) => {
      this.desktopSessionApiService.rename(sessionId, newName, oldName, force).subscribe({
        next: () => {
          if (force) {
            applyLocal(newName);
            // The other session was renamed too: reload.
            this.store.dispatch(loadSessions());
          }
        },
        error: (err) => {
          if (!isDataError(err, 'session_name_taken') && !isDataError(err, 'invalid')) return; // the local name stays
          applyLocal(oldName);
          if (!force && isDataError(err, 'session_name_taken')) {
            const conflictName = (err.details?.['conflict_name'] as string | undefined) ?? newName;
            this.swalService.confirm(
              this.translateService.instant('USERS_ADMIN.Session name taken'),
              this.translateService.instant('USERS_ADMIN.Force rename conflict', { name: conflictName }),
              () => persist(true),
            );
            return;
          }
          this.swalService.error(this.translateService.instant('USERS_ADMIN.Session name taken'));
        },
      });
    };

    persist(false);
  }

  destroySession(sessionId: string): void {
    const session = this.sessions().find(s => s.id === sessionId);
    if (!session) return;

    // Block deletion if there are locked sub-agents (or a locked lead) in this session
    const locked = this.lockedAgentCount(session);
    if (locked > 0) {
      this.swalService.error(
        this.translateService.instant('SESSIONS.Cannot delete locked subagents', { count: locked }),
      );
      return;
    }

    // Count sessions in the SAME workspace as the session being deleted, with
    // the sidebar's own membership rule (workspaceId OR same path): counting by
    // workspaceId alone saw "last session" while a path-matched sibling was
    // still there, deleted the workspace and dropped that sibling out of its
    // folder as a standalone session.
    if (session.workspaceId) {
      const ws = this.workspaces().find(w => w.id === session.workspaceId);
      const siblingsInWorkspace = this.sessions().filter(
        s => s.workspaceId === session.workspaceId
          || (!!ws?.projectPath && s.workspace?.path === ws.projectPath),
      );
      const isLastInWorkspace = siblingsInWorkspace.length <= 1;

      if (isLastInWorkspace) {
        const workspace = this.workspaces().find(w => w.id === session.workspaceId);
        const wsName = workspace?.name ?? session.workspace?.name ?? '—';
        this.swalService.confirmDanger(
          this.translateService.instant('SESSIONS.Delete last session title'),
          this.translateService.instant('SESSIONS.Delete last session message', { name: wsName }),
          () => this.performDestroySession(sessionId, session.workspaceId!),
        );
        return;
      }
    }

    this.swalService.confirmDanger(
      this.translateService.instant('SESSIONS.Delete session title'),
      this.translateService.instant('SESSIONS.Delete session message', { name: session.name }),
      () => this.performDestroySession(sessionId),
    );
  }

  /** Locked agents (and a locked lead) that still exist in this session. */
  private lockedAgentCount(session: SessionSummary): number {
    const lockedKeys = this.subAgentService.loadLockedKeys(session.id, session.dbId);
    if (lockedKeys.length === 0) return 0;
    const existingKeys = new Set(
      this.subAgentService.allSubAgents()
        .filter(sa => sa.parentSessionId === session.id)
        .map(sa => this.subAgentService.lockKeyOf(sa)),
    );
    if (!this.mainPaneClosed(session.id)) existingKeys.add(SubAgentService.MAIN_LOCK_KEY);
    return lockedKeys.filter(key => existingKeys.has(key)).length;
  }

  private performDestroySession(sessionId: string, workspaceId?: string): void {
    const session = this.sessions().find(s => s.id === sessionId);
    if (session) {
      this.historyService.setCategory(session.categoryId ?? null, session.name, session.id);
      this.historyService.logClose();
    }

    // Eagerly switch to a sibling tab before destroying (instant UX)
    if (sessionId === this.activeSessionId()) {
      const tabs = this.tabSessionsForHeader();
      const remaining = tabs.filter(t => t.id !== sessionId);
      if (remaining.length > 0) {
        this.switchToSession(remaining[0].id);
      }
    }

    // Terminate every terminal owned by this session so no shell process is
    // left orphan when the session is gone.
    this.terminalManager.closeSession(sessionId).catch(() => {});

    // Last-moment guard: the workspace goes away only if NO other session still
    // belongs to it (same rule as the sidebar). Otherwise the survivors would
    // be unlinked by the local store and turn into standalone sessions.
    const ws = workspaceId ? this.workspaces().find(w => w.id === workspaceId) : undefined;
    const survivors = workspaceId
      ? this.sessions().filter(s => s.id !== sessionId && (
          s.workspaceId === workspaceId || (!!ws?.projectPath && s.workspace?.path === ws.projectPath)))
      : [];

    this.store.dispatch(destroySession({ sessionId }));
    if (workspaceId && survivors.length === 0) {
      this.workspaceApiService.destroy(workspaceId).subscribe({
        next: () => this.store.dispatch(loadWorkspaces()),
        error: () => this.store.dispatch(loadWorkspaces()),
      });
    }
    // destroySessionSuccess reducer auto-selects a sibling session.
    // Terminal component reacts to activeSession change — no reload needed.
  }

  // ── IDE Layout Mode ──

  /**
   * A file link in a (sub-agent) terminal was clicked. Open it in the inline
   * code editor, switching to the code (IDE) layout first if necessary. The
   * editor and the FS handlers work in workspace-relative terms and reject
   * anything outside the workspace, so absolute paths are normalized here.
   */
  onTerminalFileLink(rawPath: string): void {
    const session = this.activeSession();
    const cwd = session?.workspace?.path;
    if (!session || !cwd || !this.sessionService.isDesktop) return;

    // Remote session: the file lives on the host and the editor can't reach
    // it → bring it to Downloads/PromptOps and open it with the default app.
    if (cwd.startsWith('cmd://') || cwd.startsWith('ssh://')) {
      void this.fetchRemoteFileLink(cwd, rawPath);
      return;
    }

    const rel = this.toWorkspaceRelative(rawPath, cwd);
    if (rel === null) return;

    const alreadyCode = this.currentLayoutMode() === 'code';
    if (!alreadyCode) this.toggleLayoutMode();

    // When we just switched layouts the editor is created asynchronously; give
    // Angular a tick to instantiate it (matching toggleLayoutMode's own delay).
    setTimeout(() => {
      const editor = this.inlineEditorRef;
      if (!editor) return;
      editor.cwd = cwd;
      editor.sessionId = session.id;
      void editor.openFile(rel);
    }, alreadyCode ? 0 : 200);
  }

  private async fetchRemoteFileLink(cwd: string, rawPath: string): Promise<void> {
    try {
      const localPath = await this.sessionAssetsService.fetchRemoteFile(cwd, rawPath);
      this.swalService.success(this.translateService.instant('SESSIONS.REMOTE.Downloaded', { path: escapeHtml(localPath) }));
    } catch (e: any) {
      this.swalService.error(
        this.translateService.instant('SESSIONS.REMOTE.Download failed', { error: escapeHtml(e?.message ?? String(e)) }),
      );
    }
  }

  /**
   * Convert a CLI-emitted path to a workspace-relative one. Returns null when
   * the path lives outside the workspace (the editor can't open it) or is the
   * workspace root itself.
   */
  private toWorkspaceRelative(rawPath: string, cwd: string): string | null {
    let p = rawPath.trim().replace(/:\d+(?::\d+)?$/, '').replace(/\\/g, '/');
    if (!p) return null;

    const normalize = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
    const nCwd = normalize(cwd);

    // Absolute path (POSIX `/…` or Windows `C:/…`): must sit inside the workspace.
    if (p.startsWith('/') || /^[A-Za-z]:\//.test(p)) {
      const nP = normalize(p);
      if (nP === nCwd) return null;
      const prefix = nCwd + '/';
      return nP.startsWith(prefix) ? nP.slice(prefix.length) : null;
    }

    // Relative path — drop a leading "./".
    return p.replace(/^\.\//, '');
  }

  toggleLayoutMode(): void {
    const session = this.activeSession();
    if (!session) return;

    const newMode: LayoutMode = this.currentLayoutMode() === 'standard' ? 'code' : 'standard';

    // Update in store
    this.store.dispatch(setLayoutMode({ sessionId: session.id, layoutMode: newMode }));

    // Persist to localStorage for immediate cross-reload state
    try { localStorage.setItem(`promptops_layout_${session.id}`, newMode); } catch { /* storage blocked */ }

    // Persist to the local store inside view_state (the store has no
    // layout_mode field: a top-level `layout_mode` was silently dropped).
    // The view-state effect debounces and saves it by id, then by name.
    const viewState: ViewStateWithLayout = { layoutMode: newMode };
    this.store.dispatch(updateSessionViewState({ sessionId: session.id, viewState }));
  }

  // ── Panel Resize ──

  private resizing = false;
  private resizeStartX = 0;
  private resizeStartWidth = 0;

  // Sub-agents vertical resize
  private saResizing = false;
  private saResizeStartY = 0;
  private saResizeStartHeight = 0;
  private saResizeMode: 'standard' | 'ide' = 'standard';

  // Sub-agents horizontal resize (between panes)
  private saHResizing = false;
  private saHResizeStartX = 0;
  /** Rows view: the same resize works on clientY/heights. */
  private saHResizeVertical = false;
  private saHResizeIndex = -1;
  private saHResizeStart: { leftId: string; rightId: string; left: number; right: number } | null = null;
  private saHResizeContainer: HTMLElement | null = null;
  subAgentPaneWidths = signal<Record<string, number>>({});

  /** Columns mode: flex weight of the pane (px measured at resize). A pane
   *  that arrived after the resize takes the average, it does not end up squashed. */
  saColumnFlex(id: string): string | null {
    const widths = this.subAgentPaneWidths();
    const vals = Object.values(widths);
    if (!vals.length) return null;
    const w = widths[id] ?? vals.reduce((a, b) => a + b, 0) / vals.length;
    return `${w} 1 0`;
  }

  // Action center horizontal resize
  private acResizing = false;
  private acResizeStartX = 0;
  private acResizeStartWidth = 0;

  // Left sessions sidebar horizontal resize
  private sbResizeStartX = 0;
  private sbResizeStartWidth = 0;

  /** Start dragging the left sidebar splitter. */
  startSidebarResize(event: MouseEvent): void {
    if (this.sidebarCollapsed()) return;
    event.preventDefault();
    this.sidebarResizing.set(true);
    this.sbResizeStartX = event.clientX;
    this.sbResizeStartWidth = this.sidebarWidth();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  /** Double-click on the splitter resets the sidebar to its default width. */
  resetSidebarWidth(): void {
    this.sidebarWidth.set(260);
    this.saveResizeState();
  }

  startResize(event: MouseEvent, _panel: 'right'): void {
    event.preventDefault();
    this.resizing = true;
    this.resizeStartX = event.clientX;
    const currentWidth = this.ideRightWidth();
    if (currentWidth != null) {
      this.resizeStartWidth = currentWidth;
    } else {
      const el = (event.target as HTMLElement).closest('.ide-panel-right');
      this.resizeStartWidth = el ? el.getBoundingClientRect().width : 300;
    }
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  startActionCenterResize(event: MouseEvent): void {
    event.preventDefault();
    this.acResizing = true;
    this.acResizeStartX = event.clientX;
    this.acResizeStartWidth = this.actionCenterWidth();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  /**
   * Available height for the sub-agents accordion in the standard layout:
   * terminal-area minus assets/git panels minus the main-pane reserve
   * (CSS min 120 + 8px margins ×2 = 136), capped at 600 and at the CSS
   * max-height: 70% so the signal never diverges from what the DOM shows.
   */
  private maxSubAgentsHeightPx(): number {
    const area = this.terminalAreaEl?.nativeElement;
    if (!area) return 600;
    const assets = area.querySelector(':scope > app-session-assets-panel') as HTMLElement | null;
    const git = area.querySelector(':scope > app-session-git-panel') as HTMLElement | null;
    const mainReserve = this.subAgentsCoverMain() ? 0 : 136;
    const avail = area.clientHeight - (assets?.offsetHeight ?? 0) - (git?.offsetHeight ?? 0) - mainReserve;
    return Math.max(120, Math.min(600, Math.floor(area.clientHeight * 0.7), avail));
  }

  /** Accordion header click: on expand, re-clamp the stored height against the
   *  space actually available (assets/git panels may have grown meanwhile). */
  toggleSubAgentsAccordion(): void {
    const expanding = !this.subAgentsExpanded();
    if (expanding) {
      this.subAgentsHeight.update(h => Math.min(h, this.maxSubAgentsHeightPx()));
    }
    this.subAgentsExpanded.set(expanding);
    if (expanding) {
      this.nudgeLayoutForRefit(250);
    }
  }

  /** The assets panel expanded/collapsed/finished a resize: reconcile the
   *  accordion against the new free space, then safety-net refit. The
   *  terminals' own ResizeObservers cover most size changes, but ticks are
   *  dropped during replay gates — this nudge closes that window. */
  onAssetsPanelLayoutChanged(): void {
    // Measure on the next frame so the panel's [style.height] binding has
    // been flushed to the DOM before sibling heights are read.
    requestAnimationFrame(() => {
      if (this.subAgentsExpanded() && !this.subAgentsCoverMain()) {
        this.subAgentsHeight.update(h => Math.min(h, this.maxSubAgentsHeightPx()));
      }
      this.nudgeLayoutForRefit(250);
    });
  }

  private saResizeMaxH = 600;

  startSubAgentsResize(event: MouseEvent, mode: 'standard' | 'ide'): void {
    event.preventDefault();
    event.stopPropagation();
    this.saResizing = true;
    this.saResizeStartY = event.clientY;
    this.saResizeMode = mode;
    this.saResizeStartHeight = mode === 'standard' ? this.subAgentsHeight() : this.ideSubAgentsHeight();
    // Measure once per drag (layout read) instead of on every mousemove.
    this.saResizeMaxH = mode === 'standard' ? this.maxSubAgentsHeightPx() : 600;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }

  startSubAgentHResize(event: MouseEvent, index: number): void {
    event.preventDefault();
    event.stopPropagation();
    this.saHResizing = true;
    setPaneResizing(true);
    this.saHResizeVertical = this.subAgentRowsMode();
    this.saHResizeStartX = this.saHResizeVertical ? event.clientY : event.clientX;
    this.saHResizeIndex = index;
    this.saHResizeContainer = (event.target as HTMLElement).closest('.subagents-terminals') as HTMLElement;
    // Same roster (and same order) that the template draws: the demoted
    // main is a pane like the others. All panes switch to px weights
    // taken from the DOM, so the first drag does not make the ones still at flex:1 jump.
    const panes = this.paneRoster();
    const weights: Record<string, number> = {};
    this.saHResizeContainer?.querySelectorAll<HTMLElement>(':scope > .subagent-pane[data-sa-id]').forEach(el => {
      const r = el.getBoundingClientRect();
      weights[el.dataset['saId']!] = this.saHResizeVertical ? r.height : r.width;
    });
    const leftId = panes[index]?.id, rightId = panes[index + 1]?.id;
    if (!leftId || !rightId || !weights[leftId] || !weights[rightId]) {
      this.saHResizeStart = null;
      return;
    }
    this.subAgentPaneWidths.set(weights);
    this.saHResizeStart = { leftId, rightId, left: weights[leftId], right: weights[rightId] };
    document.body.style.cursor = this.saHResizeVertical ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
  }

  toggleSubAgentsListMode(): void {
    this.subAgentsListMode.update(v => !v);
    this.subAgentPaneWidths.set({});
    this.saveResizeState();
  }

  @HostListener('document:mousemove', ['$event'])
  onResizeMove(event: MouseEvent): void {
    if (this.resizing) {
      const delta = event.clientX - this.resizeStartX;
      this.ideRightWidth.set(Math.max(250, Math.min(900, this.resizeStartWidth - delta)));
    }
    if (this.saResizing) {
      const delta = this.saResizeStartY - event.clientY;
      const newHeight = Math.max(120, Math.min(this.saResizeMaxH, this.saResizeStartHeight + delta));
      if (this.saResizeMode === 'standard') {
        this.subAgentsHeight.set(newHeight);
      } else {
        this.ideSubAgentsHeight.set(newHeight);
      }
    }
    if (this.saHResizing && this.saHResizeStart) {
      // Flex weights in px measured at the start of the gesture: gaps and handles stay out
      // of the count, the sum never overflows and no pane leaves the container.
      const { leftId, rightId, left, right } = this.saHResizeStart;
      const min = this.saHResizeVertical ? 120 : 220;
      const pos = this.saHResizeVertical ? event.clientY : event.clientX;
      const dx = Math.max(min - left, Math.min(right - min, pos - this.saHResizeStartX));
      this.subAgentPaneWidths.set({ ...this.subAgentPaneWidths(), [leftId]: left + dx, [rightId]: right - dx });
    }
    if (this.acResizing) {
      // Dragging left = increase width, dragging right = decrease width
      const delta = this.acResizeStartX - event.clientX;
      this.actionCenterWidth.set(Math.max(200, Math.min(600, this.acResizeStartWidth + delta)));
    }
    if (this.sidebarResizing()) {
      const delta = event.clientX - this.sbResizeStartX;
      this.sidebarWidth.set(Math.max(180, Math.min(520, this.sbResizeStartWidth + delta)));
    }
  }

  @HostListener('document:mouseup')
  onResizeEnd(): void {
    const wasSaDrag = this.saResizing || this.saHResizing;
    if (this.resizing || this.saResizing || this.acResizing || this.saHResizing || this.sidebarResizing()) {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      this.saveResizeState();
    }
    this.resizing = false;
    this.saResizing = false;
    this.acResizing = false;
    this.sidebarResizing.set(false);
    if (this.saHResizing) setPaneResizing(false);
    this.saHResizing = false;
    this.saHResizeStart = null;
    this.saHResizeContainer = null;
    // Final refit after a sub-agent splitter drag: the terminals' RO ticks
    // may have been dropped mid-drag (replay gate) or debounced away.
    if (wasSaDrag) {
      this.nudgeLayoutForRefit(150);
    }
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.viewportWidth.set(window.innerWidth);
    // The picker is placed from a rect taken at click time — a resize moves the
    // badge out from under it, so close rather than leave it floating.
    if (this.modelMenu()) this.modelMenu.set(null);
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.modelMenu()) {
      this.modelMenu.set(null);
    } else if (this.expandedSubAgentId()) {
      this.expandedSubAgentId.set(null);
    } else if (this.focusMode()) {
      this.focusMode.set(false);
    }
  }

  /** Any click outside the picker closes it (its own clicks stop propagation). */
  @HostListener('document:click')
  onDocumentClickCloseModelMenu(): void {
    if (this.modelMenu()) this.modelMenu.set(null);
  }

  /** Toggle IDE accordion — mutually exclusive */
  toggleIdeAccordion(section: 'usage' | 'subagents' | 'actions' | 'interactions'): void {
    const wasOpen = this.ideAccordion() === section;
    this.ideAccordion.update(current => current === section ? null : section);
    if (section === 'subagents') {
      // Remember the user's explicit choice so future auto-opens respect it.
      this.subagentsAccordionUserClosed.set(wasOpen);
    } else if (!wasOpen) {
      // Opening a different section also expresses user intent away from
      // subagents — keep whatever closed state we had.
    }
  }

  /** Open the resume sub-agent modal to recover a previously closed session */
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
        const result = await this.subAgentService.resumeArchived(sessionId, selected);
        if (result) {
          this.subagentsAccordionUserClosed.set(false);
          this.ideAccordion.set('subagents');
        }
      }
    } catch {
      // Modal dismissed
    }
  }

  /** Open the Intent modal to generate and execute an AI-driven plan */
  async openIntentModal(): Promise<void> {
    const session = this.activeSession();
    if (!session) return;

    const modalRef = this.modalService.open(IntentModalComponent, {
      centered: true,
      size: 'lg',
    });
    modalRef.componentInstance.parentSessionId = session.id;
    modalRef.componentInstance.sessionProvider = session.provider ?? 'claude-code-cli';

    try {
      const result = await modalRef.result;
      if (result === 'done') {
        this.subagentsAccordionUserClosed.set(false);
        this.ideAccordion.set('subagents');
      }
    } catch {
      // Modal dismissed
    }
  }

  // ── Provider usage helpers ──────────────────────────────────────

  fmtResetTime(resetsAt: number): string {
    const now = Math.floor(Date.now() / 1000);
    const diff = resetsAt - now;
    if (diff <= 0) return 'now';
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    if (h > 0) return `in ${h}h ${m}m`;
    return `in ${m}m`;
  }

  fmtModel(model: string): string {
    if (!model) return '?';
    return model.replace('claude-', '').replace(/\[.*\]/, '').trim();
  }

  /** Spawn a quick agent from the IDE panel */
  async spawnIdeQuickAgent(agent: { id: string; title: string; prompt: string }): Promise<void> {
    const sessionId = this.activeSessionId();
    if (!sessionId) return;
    try {
      await this.subAgentService.spawnCustom(sessionId, agent.id, agent.title, agent.prompt);
      this.subagentsAccordionUserClosed.set(false);
      this.ideAccordion.set('subagents');
    } catch (err) {
    }
  }

  /** Run a quick action slot in main terminal */
  async runIdeSlot(slot: any): Promise<void> {
    const sessionId = this.activeSessionId();
    if (!sessionId || !slot.prompt?.body) return;
    try {
      await this.sessionService.writeSession(sessionId, slot.prompt.body);
      this.terminalRef?.focus();
    } catch (err) {
    }
  }

  handleApprove(interactionId: string): void {
    this.interactionService.approve(interactionId);
  }

  handleDeny(interactionId: string): void {
    this.interactionService.deny(interactionId);
  }

  handleRespond(event: { interactionId: string; value: string }): void {
    this.interactionService.respond(event.interactionId, event.value);
  }

  /**
   * Terminal toolbar Eco button: flips eco for this terminal (the instruction
   * is injected as a plain prompt, like the model quick-switch) and always
   * pops the eco panel so the level stays one click away.
   */
  toggleTerminalEco(sessionId: string, event: MouseEvent): void {
    event.stopPropagation();
    if (!sessionId) return;
    void this.ecoService.toggleSessionStandalone(sessionId);
    this.ecoService.requestOpenModal();
  }

  toggleAutoApprove(sessionId: string): void {
    if (!sessionId) return;
    if (this.interactionService.isAutoApproved(sessionId)) {
      this.interactionService.setFlags(sessionId, { modal: false, quick: false, ai: false });
    } else {
      this.interactionService.setFlags(sessionId, { quick: true });
    }
  }

  /** Current auto-approve mode for a live terminal (reads from interactionService,
   *  not from the selection-mode map). Used by the per-pane quick-switch. */
  getSessionAaMode(sessionId: string): 'quick' | 'ai' | null {
    if (!sessionId) return null;
    const flags = this.interactionService.getFlags(sessionId);
    if (flags.ai) return 'ai';
    if (flags.quick) return 'quick';
    return null;
  }

  /** Switch a live terminal between Quick and AI without opening the
   *  selection overlay. Writes flags directly to the interactionService. */
  setSessionAaMode(sessionId: string, mode: 'quick' | 'ai'): void {
    if (!sessionId) return;
    this.interactionService.setFlags(sessionId, {
      quick: mode === 'quick',
      ai: mode === 'ai',
    });
  }

  // ── Terminal toolbar ───────────────────────────────────────────────

  /** Memoized labels — the template asks on every change detection cycle. */
  private modelLabelCache = new Map<string, string | null>();

  /**
   * Model id this terminal is running: what the provider reports (survives a
   * `/model` switch inside the TUI) and, until that resolves, the model the
   * sub-agent was launched with. Null when neither is known — the badge is
   * then hidden rather than showing a guess.
   */
  private terminalModelId(sessionId: string, sa?: SubAgent | null): string | null {
    return this.sessionModels.runtimeModel(sessionId) ?? sa?.model ?? null;
  }

  /**
   * Open model picker, or null. Rendered ONCE at page root as a fixed overlay
   * rather than inside the pane: `.subagent-pane` is overflow:hidden, so with
   * 3+ sub-agents side by side an in-pane menu was clipped to an unreadable
   * sliver. Coordinates come from the badge's rect at click time.
   */
  protected modelMenu = signal<{
    kind: 'model' | 'effort';
    sessionId: string;
    sa: SubAgent | null;
    provider: string;
    left: number;
    top: number | null;
    bottom: number | null;
    width: number;
    maxHeight: number;
  } | null>(null);

  /** Models this provider can be switched to from the badge. */
  protected modelOptions(provider?: string): ReadonlyArray<{ id: string; label: string }> {
    return liveModels(provider ?? '');
  }

  /** The badge is a menu for every AI provider — even without switchable
   *  models it still offers "Switch provider…" (in-place restart). */
  protected modelBadgeActionable(provider?: string): boolean {
    return !!provider && provider !== 'generic-shell';
  }

  protected toggleModelMenu(sessionId: string, provider: string | undefined, sa: SubAgent | null | undefined, event: MouseEvent, kind: 'model' | 'effort' = 'model'): void {
    event.stopPropagation();
    if (!this.modelBadgeActionable(provider)) return;
    if (this.modelMenu()?.sessionId === sessionId && this.modelMenu()?.kind === kind) {
      this.modelMenu.set(null);
      return;
    }
    const anchor = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
    if (!anchor) return;

    const margin = 8;
    const width = 200;
    // Right-aligned to the badge, then clamped inside the viewport: in a narrow
    // pane the badge sits closer to the left edge than the menu is wide.
    const left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin));
    const spaceAbove = anchor.top - margin;
    const spaceBelow = window.innerHeight - anchor.bottom - margin;
    const openUp = spaceAbove >= spaceBelow;

    this.modelMenu.set({
      kind,
      sessionId,
      sa: sa ?? null,
      provider: provider ?? '',
      left: Math.round(left),
      top: openUp ? null : Math.round(anchor.bottom + 6),
      bottom: openUp ? Math.round(window.innerHeight - anchor.top + 6) : null,
      width,
      maxHeight: Math.max(120, Math.round((openUp ? spaceAbove : spaceBelow) - 6)),
    });
  }

  protected terminalEffortOptions(sessionId: string, provider?: string, sa?: SubAgent | null): readonly string[] {
    if (sa?.executionMode === 'worker') return [];
    return effortOptions(provider ?? '', this.terminalModelId(sessionId, sa)?.toLowerCase());
  }

  protected terminalEffortLabel(sessionId: string, provider?: string, sa?: SubAgent | null): string {
    // agy: the level is part of the model slug the hooks report (`…-high`).
    if (provider === 'antigravity') {
      const level = this.terminalModelId(sessionId, sa)?.match(/-(low|medium|high|xhigh|max)$/)?.[1];
      return validEffort(provider, level ?? sa?.effort, this.terminalModelId(sessionId, sa)) ?? 'Effort';
    }
    const confirmed = this.sessionEfforts.confirmed()[sessionId];
    const value = confirmed?.provider === provider ? confirmed.effort : sa?.effort;
    return validEffort(provider ?? '', value, this.terminalModelId(sessionId, sa)?.toLowerCase()) ?? 'Effort';
  }

  protected terminalEffortShortLabel(sessionId: string, provider: string, sa: SubAgent | null): string {
    const value = this.sessionEfforts.pending()[sessionId] ?? this.terminalEffortLabel(sessionId, provider, sa);
    const labels: Record<string, string> = { low: 'L', medium: 'M', high: 'H', xhigh: 'XH', max: 'MAX' };
    return labels[value] ?? 'E';
  }

  protected async applyEffort(sessionId: string, provider: string, sa: SubAgent | null, effort: string, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    this.modelMenu.set(null);
    if (!this.terminalEffortOptions(sessionId, provider, sa).includes(effort)) return;
    // agy's `/effort` is an arrow-key slider; `/model <base>-<level>` sets the
    // same thing in one verified command.
    if (provider === 'antigravity') {
      const base = this.terminalModelId(sessionId, sa)?.replace(/-(low|medium|high|xhigh|max)$/, '');
      if (base) await this.applyModel(sessionId, sa, `${base}-${effort}`, event);
      return;
    }
    try {
      await this.sessionEfforts.apply(sessionId, provider, effort, async data => {
        if (sa && !this.isMainPane(sa.id)) {
          await this.subAgentService.writeToSubAgent(sa.id, data);
        } else {
          const result = await this.sessionService.writeSession(sessionId, data, { countPrompt: false });
          if (!result.ok) throw new Error('Terminal write failed');
        }
      });
    } catch {
      this.swalService.error(this.translateService.instant('SESSIONS.MODEL.Effort failed'));
    }
  }

  /**
   * Switch the model of a LIVE terminal the only way the CLIs support it:
   * typing `/model <id>` into the TUI. The badge shows the requested model
   * right away and the provider's log confirms it on the next answer.
   */
  protected async applyModel(sessionId: string, sa: SubAgent | null | undefined, modelId: string, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    this.modelMenu.set(null);
    const command = `/model ${modelId}\r`;
    try {
      // Sub-agent PTYs are addressed by sub-agent id; the main terminal (and
      // the demoted main tile, which IS the main session) by session id.
      if (sa && !this.isMainPane(sa.id)) {
        await this.subAgentService.writeToSubAgent(sa.id, command);
      } else {
        const result = await this.sessionService.writeSession(sessionId, command);
        // Same check as applyEffort: a refused write must not show the model as switching.
        if (!result.ok) throw new Error('Terminal write failed');
      }
      this.sessionModels.markSwitching(sessionId, modelId);
    } catch {
      this.swalService.error(this.translateService.instant('SESSIONS.MODEL.Send failed'));
    }
  }

  /**
   * "Switch provider…" from the model menu: same in-place restart as the
   * limit modal (exit the TUI, relaunch the new provider in the SAME
   * terminal, hand the task over), scoped to this one pane — sub-agent or
   * main (the demoted main tile IS the main session).
   */
  protected openSwitchProviderModal(mm: { sessionId: string; sa: SubAgent | null; provider: string }, event: MouseEvent): void {
    event.stopPropagation();
    this.modelMenu.set(null);
    const sa = mm.sa && !this.isMainPane(mm.sa.id) ? mm.sa : null;
    void this.providerLimit.openForTarget({
      sessionId: sa ? sa.parentSessionId : (this.activeSessionId() ?? mm.sessionId),
      sa,
      provider: mm.provider as ProviderType,
    });
  }

  /**
   * Tauri: the status push for a just-created session can arrive before the
   * store knows its id (the reducer drops it), leaving a stale status. Re-read
   * the live status once the session is in the store.
   */
  private resyncLiveStatus(sessionId: string): void {
    setTimeout(async () => {
      try {
        const live = (await this.sessionService.listSessions()).find((ls: any) => ls.id === sessionId);
        if (live?.status) this.store.dispatch(sessionStatusChanged({ sessionId, status: live.status }));
      } catch { /* best effort */ }
    }, 400);
  }

  /** Claude-family CLIs persist `/model` as the default for every future
   *  session (~/.claude/settings.json), inside and outside PromptOps. */
  protected modelSwitchSavesDefault(provider?: string): boolean {
    return provider === 'claude-code-cli' || provider === 'zai' || provider === 'kimi';
  }

  protected terminalModelLabel(sessionId: string, provider?: string, sa?: SubAgent | null): string | null {
    const switching = this.sessionModels.switchingTo(sessionId);
    if (switching) return formatModelLabel(provider, switching);
    const id = this.terminalModelId(sessionId, sa);
    // Detection pending: show the provider instead of an empty pill — "…" told
    // the user nothing, and no badge at all reads as "feature missing".
    if (!id) return this.modelBadgeActionable(provider) ? this.getProviderLabel(provider ?? '') : null;
    const key = `${provider ?? ''}|${id}`;
    let label = this.modelLabelCache.get(key);
    if (label === undefined) {
      label = formatModelLabel(provider, id);
      this.modelLabelCache.set(key, label);
    }
    return label;
  }

  /** Host diagnostics turned into something a human can act on. */
  private modelReasonText(sessionId: string): string {
    const reason = this.sessionModels.runtimeReason(sessionId) ?? 'detecting';
    const known = ['no-conversation-id', 'log-not-found', 'no-model-in-tail', 'unsupported-provider'];
    const key = known.includes(reason) ? reason : 'detecting';
    return this.translateService.instant(`SESSIONS.MODEL.STATE.${key}`);
  }

  protected terminalModelTooltip(sessionId: string, provider?: string, sa?: SubAgent | null): string {
    const t = (key: string, params?: Record<string, unknown>) =>
      this.translateService.instant(`SESSIONS.MODEL.${key}`, params);

    const switching = this.sessionModels.switchingTo(sessionId);
    if (switching) return t('Switching', { model: switching });

    const runtime = this.sessionModels.runtimeModel(sessionId);
    if (runtime) {
      return t(this.modelOptions(provider).length ? 'In use click' : 'In use', { model: runtime });
    }

    const state = this.modelReasonText(sessionId);
    return sa?.model
      ? t('Launched with', { model: sa.model, state })
      : t('Unknown', { state });
  }

  /**
   * The pill always carries at least the Eco button now, so it is never empty
   * — worker panes included (they just lack auto-approve/review).
   */
  protected showTermToolbar(_sessionId: string, _provider?: string, _sa?: SubAgent | null): boolean {
    return true;
  }

  /**
   * Ask the host which model each visible terminal is really running.
   *
   * Runs off signals the view already reacts to — sub-agent roster/status, the
   * hook stream (a Claude turn just ended, so the transcript has a fresh
   * `model`) and pane focus. No timer: SessionModelService throttles, dedupes
   * and skips providers it cannot read, and the host short-circuits on file
   * size, so a terminal that produced nothing costs one stat.
   */
  private refreshTerminalModels = effect(() => {
    // paneRoster() = the panes actually on screen, demoted main included;
    // activeSession() covers the .main-pane when it is NOT demoted.
    const roster = this.paneRoster();
    // Dependencies only — a hook event or a click into a pane is our cue that
    // a turn boundary may have passed.
    this.hookService.hookEvents();
    this.focusedPaneId();
    const main = this.activeSession();
    untracked(() => {
      if (main?.id) this.sessionModels.refresh(main.id, main.provider);
      for (const sa of roster) this.sessionModels.refresh(sa.sessionId, sa.provider);
    });
  });

  // ── Auto-Approve graphic selection overlay ─────────────────────────
  //
  // Triggered when the user clicks the sidebar "Auto Approve" button while
  // auto-approve is OFF. Lets the user graphically pick which terminals get
  // auto-approve AND which mode (QUICK or AI) each one should run in.
  // Only chosen terminals get the flag set (they light up red via the
  // existing .pane-aa-on class; the outline while picking is yellow for
  // QUICK and purple for AI to preview the chosen mode).

  /** Snapshot of all session IDs currently selectable (main + sub-agents). */
  allAutoApproveTargets(): string[] {
    const ids: string[] = [];
    const mainId = this.activeSession()?.id;
    if (mainId) ids.push(mainId);
    for (const sa of this.subAgentService.activeSubAgents()) {
      if (sa.sessionId) ids.push(sa.sessionId);
    }
    return ids;
  }

  /** Enter selection mode. Pre-populates with sessions that are already ON,
   *  inferring their mode from existing flags (ai wins over quick). If no
   *  session is on, pre-picks the main session in QUICK as a sensible start. */
  startAutoApproveSelection(): void {
    const targets = this.allAutoApproveTargets();
    if (targets.length === 0) return;

    const initial = new Map<string, 'quick' | 'ai'>();
    for (const id of targets) {
      const f = this.interactionService.getFlags(id);
      if (f.ai) initial.set(id, 'ai');
      else if (f.quick) initial.set(id, 'quick');
    }
    if (initial.size === 0) {
      const mainId = this.activeSession()?.id;
      if (mainId) initial.set(mainId, 'quick');
    }
    this.aaSelectedModes.set(initial);
    this.aaSelectMode.set(true);
  }

  /** Get the chosen mode for a terminal, or null if not selected. */
  getAaMode(sessionId: string): 'quick' | 'ai' | null {
    return this.aaSelectedModes().get(sessionId) ?? null;
  }

  aaPickedCount = computed(() => this.aaSelectedModes().size);
  aaTotalCount = computed(() => this.allAutoApproveTargets().length);

  /** Set the mode for a terminal. Clicking the currently-active mode is a
   *  no-op (use the explicit Off radio card to clear). */
  setAaMode(sessionId: string, mode: 'quick' | 'ai'): void {
    if (!sessionId) return;
    this.aaSelectedModes.update((map) => {
      const next = new Map(map);
      next.set(sessionId, mode);
      return next;
    });
  }

  /** Explicit "Off": remove the terminal from the selection so no
   *  auto-approve flag will be applied on confirm. */
  clearAaMode(sessionId: string): void {
    if (!sessionId) return;
    this.aaSelectedModes.update((map) => {
      const next = new Map(map);
      next.delete(sessionId);
      return next;
    });
  }

  /** Exit selection mode without applying changes. */
  cancelAutoApproveSelection(): void {
    this.aaSelectMode.set(false);
    this.aaSelectedModes.set(new Map());
  }

  /** Commit the selection: apply the chosen mode per terminal, clear any
   *  targets that are not selected. This makes the overlay authoritative.
   *  The `modal` (preview) flag is preserved via setFlags' merge semantics. */
  confirmAutoApproveSelection(): void {
    const modes = this.aaSelectedModes();
    for (const id of this.allAutoApproveTargets()) {
      const mode = modes.get(id);
      if (mode === 'quick') {
        this.interactionService.setFlags(id, { quick: true, ai: false });
      } else if (mode === 'ai') {
        this.interactionService.setFlags(id, { quick: false, ai: true });
      } else {
        this.interactionService.setFlags(id, { quick: false, ai: false });
      }
    }
    this.cancelAutoApproveSelection();
  }

  editSession(session: any): void {
    const modalRef = this.modalService.open(CreateSessionModalComponent, {
      centered: true,
      size: 'lg',
    });
    // Resolve workspaceId via path fallback: if the session has a workspace
    // path that matches an existing Workspace, treat it as bound even when
    // the local copy missed the workspaceId (stale merge, legacy session).
    let resolvedWorkspaceId = session.workspaceId ?? null;
    if (!resolvedWorkspaceId && session.workspace?.path) {
      const match = this.workspaces().find((w) => w.projectPath === session.workspace!.path);
      if (match) {
        resolvedWorkspaceId = match.id;
      }
    }
    modalRef.componentInstance.editSession = {
      id: session.id,
      name: session.name,
      provider: session.provider,
      workspace: session.workspace,
      teamId: session.teamId ?? null,
      projectId: session.projectId ?? null,
      categoryId: session.categoryId ?? null,
      // Pass workspaceId so the modal can show the "Promuovi a Workspace"
      // section only for standalone sessions (workspaceId === null).
      workspaceId: resolvedWorkspaceId,
    };
    modalRef.result.then(
      async (result) => {
        if (result?.mode === 'edit-promote') {
          // The user toggled "Promuovi a Workspace" in the edit modal. Dispatch
          // the combined effect: findOrCreate workspace + promote session.
          this.store.dispatch(promoteSessionToWorkspace({
            sessionId: result.sessionId,
            projectPath: result.projectPath,
            workspaceName: result.workspaceName,
          }));
          this.store.dispatch(loadWorkspaces());
          return;
        }
        if (result?.mode === 'edit') {
          const newName = result.name ?? session.name;
          const nameChanged = newName !== session.name;

          // Notify the live desktop session BEFORE refreshing from local store, otherwise the live
          // session keeps the stale name and the next persistToStore() creates
          // a duplicate (the store upserts by name).
          if (nameChanged && this.sessionService.isDesktop) {
            try {
              await this.sessionService.updateSessionMeta(session.id, { name: newName });
            } catch { /* session might not be live — safe to ignore */ }
          }

          // Windows terminal shell: push the (possibly unchanged) selection to
          // the live desktop session — it takes effect at the next spawn
          // (wake from standby or restart), like a provider change.
          if (result.shell !== undefined && this.sessionService.isDesktop) {
            try {
              await this.sessionService.updateSessionMeta(session.id, { shell: result.shell ?? null });
            } catch { /* session might not be live — safe to ignore */ }
          }

          const updated: any = {
            ...session,
            name: newName,
            provider: result.provider ?? session.provider,
            teamId: result.teamId,
            projectId: result.projectId,
          };
          if (result.workspace) {
            updated.workspace = result.workspace;
          }
          this.store.dispatch(updateSessionSuccess({ session: updated }));
          this.store.dispatch(loadSessions());
        }
      },
      () => {},
    );
  }

  openWorkspaceSetupModal(sessionId: string): void {
    const session = this.sessions().find(s => s.id === sessionId);
    if (!session) return;

    const modalRef = this.modalService.open(WorkspaceSetupModalComponent, {
      centered: true,
      size: 'md',
    });
    modalRef.componentInstance.sessionId = session.id;
    modalRef.componentInstance.sessionName = session.name;
    modalRef.componentInstance.sessionProvider = session.provider;
    modalRef.componentInstance.repoUrl = session.repoUrl ?? null;
    modalRef.componentInstance.repoBranch = session.repoBranch ?? null;
    modalRef.componentInstance.deviceWorkspaceId = session.deviceWorkspace?.id ?? null;

    if (session.deviceWorkspace?.status === 'invalid_path') {
      modalRef.componentInstance.mode.set('invalid_path');
    } else {
      modalRef.componentInstance.mode.set('not_configured');
    }

    modalRef.result.then(
      (result) => {
        if (result?.localPath) {
          // Reload sessions to pick up the new device workspace
          this.store.dispatch(loadSessions());
        }
      },
      () => {},
    );
  }

  /**
   * Auto-configure a not_configured session:
   * 1. Show confirmation modal explaining the session is not on the DB
   * 2. On confirm, create/restore the session in DB + bind DeviceWorkspace
   * 3. Refresh store so UI picks up the new status
   */
  retrySessionConfiguration(sessionId: string): void {
    const session = this.sessions().find(s => s.id === sessionId);
    if (!session) return;

    const title = this.translateService.instant('SESSIONS.DEVICE_WORKSPACE.Retry config title');
    const message = this.translateService.instant('SESSIONS.DEVICE_WORKSPACE.Retry config message', { name: session.name });

    this.swalService.confirm(title, message, async () => {
      try {
        // Create/restore the session in DB
        const dbSession = await firstValueFrom(this.desktopSessionApiService.create({
          name: session.name,
          provider: session.provider,
          workspace_path: session.workspace?.path,
          workspace_name: session.workspace?.name,
          workspace_id: session.workspaceId ?? undefined,
          config: session.workspace?.path ? { cwd: session.workspace.path } : undefined,
          team_id: session.teamId,
          project_id: session.projectId,
          category_id: session.categoryId,
          // Re-saves THIS session: overwriting its own live record is the point.
          replace: true,
          local_session_id: session.id,
        }, { rethrowNameTaken: true }));

        // Bind DeviceWorkspace so the status becomes 'configured'
        if (dbSession && session.workspace?.path) {
          await this.sessionService.upsertDeviceWorkspace(dbSession.id, session.workspace.path);
        }

        // Refresh store to pick up restored session + device workspace
        this.store.dispatch(loadSessions());
      } catch (err) {
        // Was silent: the session stayed "not configured" with no word why.
        console.warn('[session-view] retry configuration failed', err);
        this.swalService.error(this.translateService.instant(
          isDataError(err, 'session_name_taken') ? 'USERS_ADMIN.Session name taken' : 'SESSIONS.Create_Failed',
        ));
      }
    });
  }

  openAddNoteModal(sessionId: string): void {
    if (this.addNoteModal) {
      this.addNoteModal.sessionId = sessionId;
      this.addNoteModal.open();
    }
  }

  openProjectBriefModal(sessionId: string): void {
    if (!this.projectBriefModal) return;
    const session = this.sessions().find(s => s.id === sessionId) ?? this.activeSession();
    this.projectBriefModal.workspacePath = session?.workspace?.path;
    this.projectBriefModal.provider = session?.provider;
    this.projectBriefModal.projectName = session?.workspace?.name || session?.name;
    this.projectBriefModal.open();
  }

  openDevLinksModal(sessionId: string): void {
    if (!this.devLinksModal) return;
    const session = this.sessions().find(s => s.id === sessionId) ?? this.activeSession();
    this.devLinksModal.workspacePath = session?.workspace?.path;
    this.devLinksModal.provider = session?.provider;
    this.devLinksModal.projectName = session?.workspace?.name || session?.name;
    this.devLinksModal.open();
  }

  openTodoModal(sessionId?: string): void {
    if (!this.todoModal) return;
    const session = (sessionId ? this.sessions().find(s => s.id === sessionId) : null) ?? this.activeSession();
    if (!session) return;
    this.todoModal.session = session;
    this.todoModal.open();
  }

  openDatabaseExplorer(): void {
    const session = this.activeSession();
    if (!session?.workspace?.path) return;

    const modalRef = this.modalService.open(SessionDatabaseExplorerComponent, {
      fullscreen: true,
      windowClass: 'db-explorer-modal',
    });
    modalRef.componentInstance.cwd = session.workspace.path;
    modalRef.componentInstance.provider = session.provider;
    // Stored id survives app restarts (local id does not); name is the
    // same fallback the sub-agent stash uses for not-yet-persisted sessions.
    modalRef.componentInstance.sessionKey = session.dbId ?? session.name;
  }

  openDockerPanel(): void {
    const session = this.activeSession();
    if (!session?.workspace?.path) return;

    const modalRef = this.modalService.open(SessionDockerPanelComponent, {
      fullscreen: true,
      windowClass: 'docker-panel-modal',
    });
    modalRef.componentInstance.cwd = session.workspace.path;
  }

  /** Team boards connect several people: they are part of PromptOps Desktop. */
  openTeamBoard(): void {
    CloudFeatureModalComponent.open(this.modalService, 'teams');
  }

  openGitExplorer(): void {
    const session = this.activeSession();
    if (!session?.workspace?.path) return;

    import('../session-git-explorer/session-git-explorer.component').then(({ SessionGitExplorerComponent }) => {
      const modalRef = this.modalService.open(SessionGitExplorerComponent, {
        fullscreen: true,
        windowClass: 'git-explorer-modal',
      });
      modalRef.componentInstance.cwd = session.workspace!.path;
      modalRef.componentInstance.provider = session.provider;

      // Handle clone result — bind workspace to cloned path
      modalRef.result.then(async (result: any) => {
        // Diff review comments → one prompt for the agent
        if (result?.action === 'annotate' && result?.prompt) {
          await this.sendReviewPromptToTerminal(result.prompt);
          return;
        }
        if (result?.action === 'clone' && result?.path) {
          try {
            const name = result.name || result.path.split('/').pop();

            // Create or find workspace for the cloned path
            const ws = await firstValueFrom(this.workspaceApiService.findOrCreate({
              project_path: result.path,
              name,
            }));
            const workspaceId = ws?.id;

            // Update session in store
            this.store.dispatch(updateSessionSuccess({
              session: {
                ...session,
                workspace: { path: result.path, name },
                workspaceId: workspaceId || session.workspaceId,
              },
            }));

            // Upsert device workspace
            if (session.id) {
              await this.sessionService.upsertDeviceWorkspace(session.id, result.path);
            }

            this.store.dispatch(loadSessions());
          } catch (err) {
          }
        }
      }).catch(() => { /* dismissed */ });
    });
  }

  openSshPanel(): void {
    this.modalService.open(SessionSshPanelComponent, {
      fullscreen: true,
      windowClass: 'ssh-panel-modal',
    });
  }

  /**
   * Browser mode for one terminal pane: full-screen modal with the agent's
   * terminal + the real Chrome mirror. The modal types the kick-off prompt
   * so the agent answers "Cosa navighiamo?" with a proposal.
   */
  openBrowserMode(sessionId: string, sa: SubAgent | null): void {
    const sessionBacked = !sa || this.isMainPane(sa.id);
    const modalRef = this.modalService.open(BrowserModeModalComponent, {
      fullscreen: true,
      windowClass: 'terminals-panel-modal browser-mode-modal',
      backdrop: true,
      keyboard: true,
    });
    const inst = modalRef.componentInstance as BrowserModeModalComponent;
    inst.sessionId = sessionBacked ? sessionId : null;
    inst.subAgentId = sessionBacked ? null : sa!.id;
    inst.workspacePath = this.activeSession()?.workspace?.path ?? null;
    inst.title = sa?.title || sa?.role || this.activeSession()?.name || 'Agent';
    const providerId = String(sa?.provider ?? this.activeSession()?.provider ?? 'claude-code-cli');
    inst.providerLabel = this.providerDisplayLabel(providerId);
    inst.providerId = providerId === 'codex' ? 'codex' : 'claude-code-cli';
  }

  private providerDisplayLabel(provider: string): string {
    return provider === 'codex' ? 'Codex' : provider === 'claude-code-cli' ? 'Claude Code' : provider;
  }

  openTerminalsPanel(cwd?: string | null): void {
    const session = this.activeSession();
    if (!session) return;

    const initialCwd = cwd ?? session.workspace?.path ?? null;

    const modalRef = this.modalService.open(TerminalViewComponent, {
      fullscreen: true,
      windowClass: 'terminals-panel-modal',
      backdrop: true,
      keyboard: true,
    });
    modalRef.componentInstance.sessionId = session.id;
    modalRef.componentInstance.initialCwd = initialCwd;
  }

  // ── Sidebar context menu handlers ──

  sidebarEditSession(sessionId: string): void {
    const session = this.sessions().find(s => s.id === sessionId);
    if (session) {
      this.editSession(session);
    }
  }

  sidebarDestroySession(sessionId: string): void {
    this.destroySession(sessionId);
  }

  sidebarEditWorkspace(workspaceId: string): void {
    const workspace = this.workspaces().find(w => w.id === workspaceId);
    if (!workspace) return;

    const modalRef = this.modalService.open(RenameSessionModalComponent, {
      centered: true,
      size: 'sm',
    });
    modalRef.componentInstance.sessionId = workspaceId;
    modalRef.componentInstance.name = workspace.name;

    modalRef.result.then(
      (result: { sessionId: string; name: string }) => {
        this.workspaceApiService.update(result.sessionId, { name: result.name }).subscribe({
          next: () => this.store.dispatch(loadWorkspaces()),
          error: () => this.swalService.error(this.translateService.instant('SESSIONS.Workspace rename failed')),
        });
      },
      () => {},
    );
  }

  // ── Standby (park to save resources) / Wake ──

  sidebarStandbySession(sessionId: string): void {
    this.store.dispatch(standbySession({ sessionId }));
  }

  sidebarWakeSession(sessionId: string): void {
    this.store.dispatch(wakeSession({ sessionId }));
    // Bring the woken session into view (the provider respawns in the background).
    this.switchToSession(sessionId);
  }

  sidebarStandbyWorkspace(workspaceId: string): void {
    this.store.dispatch(standbyWorkspace({ workspaceId }));
  }

  sidebarWakeWorkspace(workspaceId: string): void {
    this.store.dispatch(wakeWorkspace({ workspaceId }));
  }

  sidebarDestroyWorkspace(workspaceId: string): void {
    const workspace = this.workspaces().find(w => w.id === workspaceId);
    if (!workspace) return;

    // Same membership rule as the sidebar and destroySession (workspaceId OR
    // same folder): a path-matched session left behind would drop out of the
    // deleted workspace as a standalone session.
    const members = () => this.sessions().filter(
      s => s.workspaceId === workspaceId
        || (!!workspace.projectPath && s.workspace?.path === workspace.projectPath),
    );
    const locked = members().reduce((n, s) => n + this.lockedAgentCount(s), 0);
    if (locked > 0) {
      this.swalService.error(
        this.translateService.instant('SESSIONS.Cannot delete locked subagents', { count: locked }),
      );
      return;
    }

    this.swalService.confirmDanger(
      this.translateService.instant('SESSIONS.Delete workspace title'),
      this.translateService.instant('SESSIONS.Delete workspace message', {
        name: escapeHtml(workspace.name), count: members().length,
      }),
      () => {
        // Destroy all sessions in this workspace, with their terminals.
        for (const s of members()) {
          this.historyService.setCategory(s.categoryId ?? null, s.name, s.id);
          this.historyService.logClose();
          this.terminalManager.closeSession(s.id).catch(() => {});
          this.store.dispatch(destroySession({ sessionId: s.id }));
        }
        // Destroy the workspace
        this.workspaceApiService.destroy(workspaceId).subscribe({
          // Store handles session selection via destroySessionSuccess — no reload needed.
          next: () => this.store.dispatch(loadWorkspaces()),
          error: () => {
            this.store.dispatch(loadWorkspaces());
            this.swalService.error(this.translateService.instant('SESSIONS.Workspace delete failed'));
          },
        });
      },
    );
  }

  /** "Task" id of the review on the main: `main:<sessionId>` (same contract on the Rust side). */
  mainReviewTaskId(sessionId: string): string {
    return `main:${sessionId}`;
  }

  /**
   * Check with another provider on the MAIN session (classic or the flat roster's
   * `__main__` tile). The main is not a sub-agent: we build it
   * a pseudo-task with id `main:<sessionId>` that the reviewer resolves via the
   * session (provider, cwd and PTY transcript).
   */
  openMainCheckModal(sessionId: string, event?: MouseEvent): void {
    event?.stopPropagation();
    const session = this.activeSession();
    if (!session || session.id !== sessionId) return;
    const task: SubAgent = {
      id: this.mainReviewTaskId(sessionId),
      role: 'main',
      title: session.name || 'Main session',
      parentSessionId: sessionId,
      sessionId,
      status: (session.status === 'running' || session.status === 'in_progress' ? session.status : 'idle') as SubAgent['status'],
      autoPrompt: '',
      provider: session.provider as unknown as SubAgent['provider'],
      icon: 'solar:monitor-bold',
      executionMode: 'interactive',
    };
    this.openCheckModal(task);
  }

  openCheckModal(sa: SubAgent, event?: MouseEvent): void {
    event?.stopPropagation();
    const modalRef = this.modalService.open(CheckWithProviderModalComponent, {
      centered: true,
      size: 'lg',
      backdrop: true,
    });
    modalRef.componentInstance.task = sa;
    this.reviewService.registerOpener(sa.id, () => this.openCheckModal(sa));
    modalRef.result.catch(() => {});
  }

  destroySubAgent(subAgentId: string, event?: MouseEvent): void {
    event?.stopPropagation();
    // Locked pane (lead included): the lock blocks every close. It must go
    // BEFORE the main branch, otherwise the locked lead got closed anyway.
    if (this.lockedSubAgents().has(subAgentId)) return;
    // The demoted main uses the same close button as the others, but
    // is not destroyed: it is hidden for good (the local store stays intact).
    if (this.isMainPane(subAgentId)) {
      this.dismissMain(event);
      return;
    }
    // Agents model: a sub-agent promoted to lead closes like all the others.
    // Unhook the lead pointer FIRST (persisted by Rust) so the meta does not
    // stay hanging on a dead id and the ⭐ badge moves right away to the next pane.
    if (this.agentsEnabled) {
      const sid = this.activeSessionId();
      if (sid && this.agentRoster.meta(sid).leadId === subAgentId) {
        void this.agentRoster.setLead(sid, null);
      }
    }
    const goneSessionId = this.subAgentService.activeSubAgents().find(a => a.id === subAgentId)?.sessionId;
    if (goneSessionId) this.sessionModels.forget(goneSessionId);
    if (this.expandedSubAgentId() === subAgentId) {
      this.expandedSubAgentId.set(null);
    }
    // Reset pane widths so remaining sub-agents redistribute evenly
    this.subAgentPaneWidths.set({});
    // If this was the active tab, switch to next available
    if (this.activeSubAgentTab() === subAgentId) {
      const agents = this.subAgentService.activeSubAgents();
      const next = agents.find(a => a.id !== subAgentId);
      this.activeSubAgentTab.set(next?.id ?? null);
    }
    this.subAgentService.destroy(subAgentId);
  }

  /**
   * EXPLICIT restore of the closed main (button in the empty-state).
   * It is the only way back: no automatism revokes it anymore — the
   * old `restoreMainIfAlone` on the last closed sub-agent was one of the
   * reasons why "the main always reappeared".
   */
  restoreMain(event?: MouseEvent): void {
    event?.stopPropagation();
    const id = this.activeSessionId();
    if (!id) return;
    if (this.agentsEnabled) {
      // Agents model: respawn of the session PTY with resume (via wake on the Rust side).
      if (this.agentRoster.leadClosed(id)) void this.reopenLeadOrSay(id);
      return;
    }
    if (!this.dismissedMains().has(id)) return;
    this.dismissedMains.update(set => {
      const next = new Set(set);
      next.delete(id);
      writeDismissedMains(next);
      return next;
    });
  }

  /**
   * Agents model, from the sidebar menu: brings the session to the front and
   * reopens its closed lead (respawn with resume, like `restoreMain`).
   */
  async sidebarReopenLead(sessionId: string): Promise<void> {
    if (!this.agentsEnabled || !this.agentRoster.leadClosed(sessionId)) return;
    await this.selectSession(sessionId);
    await this.reopenLeadOrSay(sessionId);
  }

  /** Reopens the closed lead; a failure was silent (the empty-state just stayed). */
  private async reopenLeadOrSay(sessionId: string): Promise<void> {
    if (!(await this.agentRoster.reopenLead(sessionId))) {
      this.swalService.error(this.translateService.instant('SUBAGENTS.Reopen lead failed'));
    }
  }

  /** Agents model: the pane is the effective lead of the active session. */
  isLeadPane(paneId: string): boolean {
    const id = this.activeSessionId();
    return !!id && this.agentRoster.effectiveLeadId(id, this.paneRoster()) === paneId;
  }

  /** Agents model: moves the lead pointer to this pane (persisted by Rust). */
  promoteToLead(paneId: string, event?: MouseEvent): void {
    event?.stopPropagation();
    const id = this.activeSessionId();
    if (!id) return;
    void this.agentRoster.setLead(id, paneId);
  }

  toggleExpandSubAgent(subAgentId: string): void {
    this.expandedSubAgentId.update(current => current === subAgentId ? null : subAgentId);
  }

  copySubAgentPrompt(sa: SubAgent, event?: MouseEvent): void {
    event?.stopPropagation();
    const text = sa.userPrompt || sa.autoPrompt;
    if (!text) return;
    void this.sessionService.clipboardWrite(text);
  }

  // ── Auto-approve ASCII banners ──
  readonly asciiQuick = [
    '  ____                       _    ___            ',
    ' |  _ \\ _ __ ___  _ __ ___ | |_ / _ \\ _ __  ___ ',
    ' | |_) | \'__/ _ \\| \'_ ` _ \\| __| | | | \'_ \\/ __|',
    ' |  __/| | | (_) | | | | | | |_| |_| | |_) \\__ \\',
    ' |_|   |_|  \\___/|_| |_| |_|\\__|\\___/| .__/|___/',
    '                                      |_|        ',
    '  AUTO-APPROVE ///  QUICK MODE  ///  y + ENTER   ',
  ].join('\n');

  readonly asciiAI = [
    '  ____                       _    ___            ',
    ' |  _ \\ _ __ ___  _ __ ___ | |_ / _ \\ _ __  ___ ',
    ' | |_) | \'__/ _ \\| \'_ ` _ \\| __| | | | \'_ \\/ __|',
    ' |  __/| | | (_) | | | | | | |_| |_| | |_) \\__ \\',
    ' |_|   |_|  \\___/|_| |_| |_|\\__|\\___/| .__/|___/',
    '                                      |_|        ',
    '  AUTO-APPROVE ///  AI MODE  ///  NO HUMAN IN THE LOOP',
  ].join('\n');

  /** Format tailer response for display (escape control chars). */
  formatTailerResponse(response: string): string {
    return response
      .replace(/\r/g, ' ↵')
      .replace(/\x1b\[[^m]*m/g, '')  // strip ANSI
      .replace(/\x1b/g, '')
      || '(empty)';
  }

  // ── Sub-agent tab mode & lock ──

  /** Lock/unlock of a pane: sub-agent or lead (`__main__`), the service resolves the identity. */
  toggleLockSubAgent(id: string, event?: MouseEvent): void {
    event?.stopPropagation();
    this.subAgentService.toggleLock(id);
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
    'generic-shell': 'Shell',
  };
  getProviderLogo(provider: string): string {
    return SessionViewComponent.PROVIDER_LOGO[provider] ?? 'assets/providers/terminal.svg';
  }
  getProviderLabel(provider: string): string {
    return SessionViewComponent.PROVIDER_LABEL[provider] ?? 'Shell';
  }

  switchSubAgentTab(id: string): void {
    this.activeSubAgentTab.set(id);
    this.ideTerminalTab.set(id);
    this.focusedPaneId.set('sa:' + id);
    setTimeout(() => {
      const terminal = this.isMainPane(id)
        ? this.sessionTerminals?.find(t => t.sessionId === this.activeSessionId())
        : this.subAgentTerminals?.find(t => t.subAgentId === id);
      terminal?.focus();
      this.nudgeLayoutForRefit();
    }, 100);
  }

  /** Handle click on a sub-agent in the sessions sidebar: switch to its parent
   *  session first (waking it if parked), then reveal + focus its pane. */
  async onSidebarSelectSubAgent(sa: SubAgent): Promise<void> {
    if (sa.parentSessionId !== this.activeSessionId()) {
      await this.selectSession(sa.parentSessionId);
    }
    this.scheduleSidebarSubAgentFocus(sa);
  }

  private sidebarSaFocusTimers: ReturnType<typeof setTimeout>[] = [];

  private cancelSidebarSubAgentFocus(): void {
    for (const t of this.sidebarSaFocusTimers) clearTimeout(t);
    this.sidebarSaFocusTimers = [];
  }

  /**
   * Focus a sub-agent pane once its terminal exists. Runs multiple passes:
   * right after a session switch the sub-agent list reloads asynchronously
   * (trackSession IPC / stash restore), so the clicked agent may only appear
   * a moment later. IDs are not stable across restores — fall back to
   * role+title matching.
   */
  private scheduleSidebarSubAgentFocus(sa: SubAgent): void {
    const parentId = sa.parentSessionId;
    this.cancelSidebarSubAgentFocus();
    [50, 400, 900, 1800, 3000, 5000].forEach((delay) => {
      const timer = setTimeout(() => {
        if (this.activeSessionId() !== parentId) {
          this.cancelSidebarSubAgentFocus();
          return;
        }
        const agents = this.subAgentService.activeSubAgents();
        const match = agents.find(a => a.id === sa.id)
          ?? agents.find(a => a.role === sa.role && a.title === sa.title);
        if (!match) return; // not loaded yet — retry on the next pass
        this.cancelSidebarSubAgentFocus();
        // The explicit click wins over the waiting_input auto-focus passes.
        this.cancelAutoFocusOnOpen();
        this.onActionCenterSelectSubAgent(match);
      }, delay);
      this.sidebarSaFocusTimers.push(timer);
    });
  }

  /** Handle click on an active sub-agent card in the action-center sidebar:
   *  expand the sub-agents panel, switch to its tab and focus its terminal. */
  onActionCenterSelectSubAgent(sa: SubAgent): void {
    this.subAgentsExpanded.set(true);
    this.subAgentPaneWidths.set({});
    if (this.currentLayoutMode() === 'code') {
      this.subagentsAccordionUserClosed.set(false);
      this.ideRightCollapsed.set(false);
    }
    this.switchSubAgentTab(sa.id);
    setTimeout(() => {
      const terminal = this.subAgentTerminals?.find(t => t.subAgentId === sa.id);
      (terminal as any)?.containerRef?.nativeElement
        ?.closest('.subagent-pane')
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 200);
  }

  /** Layout: AUTO grid (default), columns (former split), rows (vertical) or tabs. */
  setSubAgentLayout(mode: 'grid' | 'columns' | 'rows' | 'tabs'): void {
    this.subAgentTabMode.set(mode === 'tabs');
    this.subAgentGridMode.set(mode === 'grid');
    this.subAgentColumnsMode.set(mode === 'columns');
    this.subAgentRowsMode.set(mode === 'rows');
    this.subAgentsListMode.set(false);
    this.userExplicitLayout.set(true);
    this.subAgentPaneWidths.set({});
    this.saveResizeState();
  }

  getSubAgentLayoutMode(): 'grid' | 'columns' | 'rows' | 'tabs' {
    if (this.subAgentTabMode()) return 'tabs';
    if (this.subAgentColumnsMode()) return 'columns';
    if (this.subAgentRowsMode()) return 'rows';
    return 'grid';
  }

  /** Click on AUTO: enters the grid, or if auto is suspended (manual resize) restores it. */
  onAutoGridClick(): void {
    if (this.getSubAgentLayoutMode() === 'grid') { this.resetSaGridAuto(); return; }
    this.setSubAgentLayout('grid');
  }

  // ── Smart grid: columns/rows chosen on the real space ──

  /** Priority = reading vertically: wrap (new row, half height)
   *  only when the columns would drop below this width (~50 cols).
   *  If the height still stays below SA_GRID_MIN_H we accept narrowing
   *  down to SA_GRID_HARD_MIN_W just to remove a row. */
  private static readonly SA_GRID_MIN_W = 360;
  private static readonly SA_GRID_HARD_MIN_W = 280;
  private static readonly SA_GRID_MIN_H = 240;

  private saGridSize = signal<{ w: number; h: number }>({ w: 0, h: 0 });
  private saGridObserver?: ResizeObserver;

  @ViewChild('saGrid') set saGridRef(ref: ElementRef<HTMLElement> | undefined) {
    this.saGridObserver?.disconnect();
    this.saGridObserver = undefined;
    if (!ref || typeof ResizeObserver === 'undefined') return;
    this.saGridObserver = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      const cur = this.saGridSize();
      // Round: avoids recomputing on every sub-pixel during resizes.
      const w = Math.round(r.width), h = Math.round(r.height);
      if (w !== cur.w || h !== cur.h) this.saGridSize.set({ w, h });
    });
    this.saGridObserver.observe(ref.nativeElement);
  }

  /**
   * Height first: rows = the minimum possible with columns at least
   * SA_GRID_MIN_W wide (if the height is not enough, threshold HARD_MIN_W);
   * columns = balanced split over those rows (fewer empty cells).
   * The incomplete last row widens to fill the width:
   * `tracks` is the lcm of the columns and the panes of the last row, so every pane
   * takes a whole `span`.
   */
  saGridLayout = computed(() => {
    const n = this.paneRoster().length;
    const { w, h } = this.saGridSize();
    const W = w || 1200, H = h || 600;
    const rowsFor = (minW: number) => Math.ceil(n / Math.max(1, Math.floor(W / minW)));
    let rowCount = rowsFor(SessionViewComponent.SA_GRID_MIN_W);
    if (H / rowCount < SessionViewComponent.SA_GRID_MIN_H) {
      rowCount = Math.min(rowCount, rowsFor(SessionViewComponent.SA_GRID_HARD_MIN_W));
    }
    const cols = Math.max(1, Math.ceil(n / Math.max(1, rowCount)));
    const rows = Math.max(1, Math.ceil(n / cols));
    const last = n - (rows - 1) * cols || cols;
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    const tracks = (cols * last) / gcd(cols, last);
    return { cols, rows, last, tracks };
  });

  // ── Manual resize in the grid: suspends AUTO ──
  // Weights per column and per row: dragging an edge resizes the adjacent
  // terminals and the rest recalibrates, but the grid stays aligned (tidy).
  // They apply only to the current shape (columns×rows×panes): if the
  // number of agents changes or the space forces another shape, it goes back to AUTO.

  private static readonly SA_GRID_WEIGHTS_KEY = 'promptops_sa_grid_weights';
  private static readonly SA_GRID_GAP = 6;
  private saGridWeights = signal<Record<string, { sig: string; cols: number[]; rows: number[] }>>(
    (() => { try { return JSON.parse(localStorage.getItem(SessionViewComponent.SA_GRID_WEIGHTS_KEY) || '{}'); } catch { return {}; } })(),
  );
  saGridResizing = signal(false);

  private saGridSig = computed(() => {
    const { cols, rows } = this.saGridLayout();
    return `${cols}x${rows}x${this.paneRoster().length}`;
  });

  /** Manual weights valid for the current shape, otherwise null (= AUTO). */
  private saGridManualWeights = computed(() => {
    const sid = this.activeSessionId();
    const w = sid ? this.saGridWeights()[sid] : undefined;
    return w && w.sig === this.saGridSig() ? w : null;
  });
  saGridManual = computed(() => !!this.saGridManualWeights());

  saGridTemplateCols = computed(() => {
    const { cols, tracks } = this.saGridLayout();
    const w = this.saGridManualWeights();
    if (!w) return `repeat(${tracks}, minmax(0, 1fr))`;
    const k = tracks / cols;
    return Array.from({ length: tracks }, (_, t) => `minmax(0, ${(w.cols[Math.floor(t / k)] / k).toFixed(4)}fr)`).join(' ');
  });

  saGridTemplateRows = computed(() => {
    const { rows } = this.saGridLayout();
    const w = this.saGridManualWeights();
    if (!w) return `repeat(${rows}, minmax(0, 1fr))`;
    return w.rows.map(r => `minmax(0, ${r.toFixed(4)}fr)`).join(' ');
  });

  private saGridWeightsOrEven(): { cols: number[]; rows: number[] } {
    const { cols, rows } = this.saGridLayout();
    const w = this.saGridManualWeights();
    return w ? { cols: [...w.cols], rows: [...w.rows] } : { cols: Array(cols).fill(1), rows: Array(rows).fill(1) };
  }

  /** CSS position of the edge after track `j` (8px-wide handle centered on the gap). */
  private saGridEdge(weights: number[], j: number, padStart: string, padEnd: string): string {
    const sum = weights.reduce((a, b) => a + b, 0);
    const frac = weights.slice(0, j + 1).reduce((a, b) => a + b, 0) / sum;
    const gaps = (weights.length - 1) * SessionViewComponent.SA_GRID_GAP;
    const off = j * SessionViewComponent.SA_GRID_GAP + SessionViewComponent.SA_GRID_GAP / 2 - 4;
    return `calc(${padStart} + (100% - ${padStart} - ${padEnd} - ${gaps}px) * ${frac.toFixed(5)} + ${off}px)`;
  }

  saGridColHandles = computed(() => {
    const { cols, rows, last } = this.saGridLayout();
    if (cols < 2) return [];
    const w = this.saGridWeightsOrEven();
    // Incomplete last row = wider panes: the column edge stops above it.
    let bottom: string | null = null;
    if (rows > 1 && last < cols) {
      const sum = w.rows.reduce((a, b) => a + b, 0);
      const gaps = (rows - 1) * SessionViewComponent.SA_GRID_GAP;
      bottom = `calc(var(--sa-pad-bottom) + (100% - var(--sa-pad-top) - var(--sa-pad-bottom) - ${gaps}px) * ${(w.rows[rows - 1] / sum).toFixed(5)} + ${SessionViewComponent.SA_GRID_GAP}px)`;
    }
    return Array.from({ length: cols - 1 }, (_, j) => ({
      pos: this.saGridEdge(w.cols, j, 'var(--sa-pad-x)', 'var(--sa-pad-x)'),
      bottom,
    }));
  });

  saGridRowHandles = computed(() => {
    const { rows } = this.saGridLayout();
    if (rows < 2) return [];
    const w = this.saGridWeightsOrEven();
    return Array.from({ length: rows - 1 }, (_, j) => this.saGridEdge(w.rows, j, 'var(--sa-pad-top)', 'var(--sa-pad-bottom)'));
  });

  /** Intersections between column edge and row edge: diagonal resize. */
  saGridCornerHandles = computed(() => {
    const { cols, rows } = this.saGridLayout();
    if (cols < 2 || rows < 2) return [];
    const w = this.saGridWeightsOrEven();
    const out: { c: number; r: number; left: string; top: string }[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        out.push({
          c, r,
          left: this.saGridEdge(w.cols, c, 'var(--sa-pad-x)', 'var(--sa-pad-x)'),
          top: this.saGridEdge(w.rows, r, 'var(--sa-pad-top)', 'var(--sa-pad-bottom)'),
        });
      }
    }
    return out;
  });

  /** `col`/`row` move an edge; `both` (intersection) moves column `j` and row `jr` together. */
  startSaGridResize(event: MouseEvent, axis: 'col' | 'row' | 'both', j: number, jr = j): void {
    const sid = this.activeSessionId();
    const grid = (event.target as HTMLElement).closest('.grid-mode') as HTMLElement | null;
    if (!sid || !grid || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const sig = this.saGridSig();
    const w = this.saGridWeightsOrEven();
    const cs = getComputedStyle(grid);
    const rect = grid.getBoundingClientRect();
    const gap = SessionViewComponent.SA_GRID_GAP;

    // An "axis" = weights + edge index + usable space in px + mouse coordinate.
    const makeAxis = (isCol: boolean, idx: number) => {
      const arr = isCol ? w.cols : w.rows;
      const inner = isCol
        ? rect.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - (arr.length - 1) * gap
        : rect.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - (arr.length - 1) * gap;
      const sum = arr.reduce((x, y) => x + y, 0);
      // Readable minimum for the terminal being shrunk.
      const min = sum * ((isCol ? 220 : 120) / inner);
      return { isCol, arr, idx, inner, sum, min, a0: arr[idx], b0: arr[idx + 1], start: isCol ? event.clientX : event.clientY };
    };
    const axes = [
      ...(axis !== 'row' ? [makeAxis(true, j)] : []),
      ...(axis !== 'col' ? [makeAxis(false, axis === 'both' ? jr : j)] : []),
    ];
    if (axes.some(x => x.inner <= 0)) return;

    setPaneResizing(true);
    this.saGridResizing.set(true);
    document.body.style.cursor = axis === 'col' ? 'col-resize' : axis === 'row' ? 'row-resize' : 'move';
    document.body.style.userSelect = 'none';

    // rAF: at most one grid relayout per frame.
    let raf = 0;
    let lastEvt: MouseEvent | null = null;
    const move = (e: MouseEvent) => {
      lastEvt = e;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (lastEvt) apply(lastEvt); });
    };
    const apply = (e: MouseEvent) => {
      let cols = w.cols, rows = w.rows;
      for (const x of axes) {
        const d = (((x.isCol ? e.clientX : e.clientY) - x.start) / x.inner) * x.sum;
        const clamped = Math.max(x.min - x.a0, Math.min(x.b0 - x.min, d));
        const next = [...x.arr];
        next[x.idx] = x.a0 + clamped;
        next[x.idx + 1] = x.b0 - clamped;
        if (x.isCol) cols = next; else rows = next;
      }
      this.saGridWeights.set({ ...this.saGridWeights(), [sid]: { sig, cols, rows } });
    };
    const up = () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (lastEvt) apply(lastEvt);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setPaneResizing(false);
      this.saGridResizing.set(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      this.persistSaGridWeights();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  /** Back to the AUTO grid (click on AUTO or double click on an edge). */
  resetSaGridAuto(): void {
    const sid = this.activeSessionId();
    if (!sid || !this.saGridWeights()[sid]) return;
    const next = { ...this.saGridWeights() };
    delete next[sid];
    this.saGridWeights.set(next);
    this.persistSaGridWeights();
  }

  private persistSaGridWeights(): void {
    try { localStorage.setItem(SessionViewComponent.SA_GRID_WEIGHTS_KEY, JSON.stringify(this.saGridWeights())); } catch { /* storage denied */ }
  }

  saGridSpan(index: number): number {
    const { cols, rows, last, tracks } = this.saGridLayout();
    const inLastRow = index >= (rows - 1) * cols;
    return inLastRow ? tracks / last : tracks / cols;
  }

  // ── Pane order (drag & drop on title + provider icon) ──

  private paneOrder = signal<Record<string, string[]>>(
    (() => { try { return JSON.parse(localStorage.getItem('promptops_sa_pane_order') || '{}'); } catch { return {}; } })(),
  );

  /** Applies the saved order for the session; new panes go to the end. */
  private applyPaneOrder(roster: SubAgent[]): SubAgent[] {
    const sid = this.activeSessionId();
    const order = sid ? this.paneOrder()[sid] : undefined;
    if (!order?.length || roster.length < 2) return roster;
    const pos = new Map(order.map((id, i) => [id, i]));
    return roster
      .map((sa, i) => ({ sa, k: pos.has(sa.id) ? pos.get(sa.id)! : order.length + i }))
      .sort((a, b) => a.k - b.k)
      .map(x => x.sa);
  }

  private movePane(fromId: string, toId: string): void {
    const sid = this.activeSessionId();
    if (!sid || fromId === toId) return;
    const ids = this.paneRoster().map(p => p.id);
    const from = ids.indexOf(fromId), to = ids.indexOf(toId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, fromId);
    const next = { ...this.paneOrder(), [sid]: ids };
    this.paneOrder.set(next);
    try { localStorage.setItem('promptops_sa_pane_order', JSON.stringify(next)); } catch { /* storage full/denied */ }
  }

  saDragId = signal<string | null>(null);
  saDropTargetId = signal<string | null>(null);

  private readonly ngZone = inject(NgZone);

  /**
   * Pointer-based drag (not HTML5 DnD: in the Tauri WebView native drag is
   * intercepted by the file drop). It arms when held down ~180 ms or
   * moved more than 6 px, so a simple click on the title stays a click.
   *
   * Smoothness: pointermove runs outside Angular; the "liquid glass" ghost
   * is a DOM node moved only via transform in rAF (compositor, zero layout,
   * zero change detection). Angular comes back in only when the target changes.
   */
  onSaDragPointerDown(event: PointerEvent, saId: string): void {
    if (event.button !== 0 || this.paneRoster().length < 2 || this.expandedSubAgentId()) return;
    const startX = event.clientX, startY = event.clientY;
    const handle = event.currentTarget as HTMLElement;
    let armed = false;
    let ghost: HTMLElement | null = null;
    let raf = 0;
    let px = startX, py = startY;
    let lastTarget: string | null = null;

    const paint = () => {
      raf = 0;
      if (ghost) ghost.style.transform = `translate3d(${px + 14}px, ${py + 12}px, 0)`;
    };
    const arm = () => {
      if (armed) return;
      armed = true;
      ghost = handle.cloneNode(true) as HTMLElement;
      ghost.className = 'sa-drag-ghost';
      ghost.removeAttribute('id');
      document.body.appendChild(ghost);
      paint();
      requestAnimationFrame(() => ghost?.classList.add('in'));
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      this.ngZone.run(() => this.saDragId.set(saId));
    };
    const holdTimer = setTimeout(arm, 180);
    const move = (e: PointerEvent) => {
      px = e.clientX; py = e.clientY;
      if (!armed && Math.hypot(px - startX, py - startY) > 6) arm();
      if (!armed) return;
      e.preventDefault();
      if (!raf) raf = requestAnimationFrame(paint);
      const el = document.elementFromPoint(px, py) as HTMLElement | null;
      const target = el?.closest('.grid-mode .subagent-pane') as HTMLElement | null;
      const id = target?.dataset['saId'] ?? null;
      const next = id && id !== saId ? id : null;
      if (next !== lastTarget) {
        lastTarget = next;
        this.ngZone.run(() => this.saDropTargetId.set(next));
      }
    };
    const up = () => {
      clearTimeout(holdTimer);
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (ghost) {
        const g = ghost;
        g.classList.remove('in');
        g.classList.add('out');
        setTimeout(() => g.remove(), 180);
      }
      this.ngZone.run(() => {
        if (armed) {
          if (lastTarget) this.animatePaneReorder(() => this.movePane(saId, lastTarget!));
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
        this.saDragId.set(null);
        this.saDropTargetId.set(null);
      });
    };
    this.ngZone.runOutsideAngular(() => {
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  /**
   * FLIP: measures the panes, applies the change, then animates every pane from the old
   * position to the new one. Translate only (no scale: it would stretch the
   * terminals), Web Animations API → runs on the compositor.
   */
  private animatePaneReorder(apply: () => void): void {
    const grid = document.querySelector('.subagents-terminals.grid-mode');
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!grid || reduce) { apply(); return; }
    const before = new Map<string, DOMRect>();
    grid.querySelectorAll<HTMLElement>('.subagent-pane[data-sa-id]').forEach(el => before.set(el.dataset['saId']!, el.getBoundingClientRect()));
    apply();
    // CD runs in the ngZone.run microtask: on the next frame the DOM is already
    // reordered but not yet painted → the inversion starts without a flash.
    requestAnimationFrame(() => {
      grid.querySelectorAll<HTMLElement>('.subagent-pane[data-sa-id]').forEach(el => {
        const old = before.get(el.dataset['saId']!);
        if (!old) return;
        const now = el.getBoundingClientRect();
        const dx = old.left - now.left, dy = old.top - now.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
          { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        );
      });
    });
  }

  /** Toggle "cover main" mode: sub-agents take over the main terminal area.
   *  Persisted per-session via SessionViewState. */
  toggleFocusMode(): void {
    this.focusMode.update(v => !v);
  }

  /** Keyboard shortcuts for sub-agent navigation (uses event.code for cross-platform support).
   *  On macOS Option is the third-level compose key (Option+e-grave = [ on Italian, Option+5 = [ on German),
   *  so bare-Option shortcuts would swallow those characters: require ⌘⌥ there instead.
   *
   *  Registered on `document` in the CAPTURE phase (see constructor): on Windows/Linux
   *  xterm turns Alt+key into ESC+key for the shell and stops the event, so a
   *  bubble-phase listener never saw it while a terminal had focus. A handled
   *  shortcut stops here and never reaches the terminal. */
  private readonly keyDownCapture = (event: KeyboardEvent): void => this.onSubAgentKeyDown(event);

  onSubAgentKeyDown(event: KeyboardEvent): void {
    if (!event.altKey || event.ctrlKey || event.shiftKey) return;
    if (this.isMac ? !event.metaKey : event.metaKey) return;
    // Same list, order and numbering as the panes on screen (tab badges 1…n).
    const agents = this.paneRoster();
    // Keys remappable from the shortcut modal (default: 0 [ ] E L F).
    const action = this.sessionShortcuts.actionFor(event.code);
    const handled = () => { event.preventDefault(); event.stopPropagation(); };

    // Alt/⌥ + 0 = focus main terminal
    if (action === 'focusMain') {
      handled();
      if (this.currentLayoutMode() === 'code') {
        this.selectIdeTerminal(this.mainIsFlattened() ? SessionViewComponent.MAIN_PANE_ID : 'main');
        return;
      }
      if (this.mainIsFlattened()) {
        // The main is a tile in the grid: #terminalRef does not exist then.
        this.subAgentsExpanded.set(true);
        this.switchSubAgentTab(SessionViewComponent.MAIN_PANE_ID);
        return;
      }
      this.focusedPaneId.set('main');
      this.terminalRef?.focus();
      this.nudgeLayoutForRefit();
      return;
    }

    // Alt/⌥ + 1-9 = focus sub-agent by index
    const digitMatch = event.code.match(/^Digit([1-9])$/);
    if (digitMatch) {
      handled();
      const idx = parseInt(digitMatch[1], 10) - 1;
      const agent = agents[idx];
      if (agent) {
        this.subAgentsExpanded.set(true);
        this.switchSubAgentTab(agent.id);
      }
      return;
    }

    // Alt/⌥ + [ = previous sub-agent, Alt/⌥ + ] = next sub-agent
    if (action === 'prevAgent' || action === 'nextAgent') {
      handled();
      if (agents.length === 0) return;
      const currentTab = this.activeSubAgentTab();
      const currentIdx = agents.findIndex(a => a.id === currentTab);
      const nextIdx = action === 'nextAgent'
        ? (currentIdx + 1) % agents.length
        : (currentIdx - 1 + agents.length) % agents.length;
      this.subAgentsExpanded.set(true);
      this.switchSubAgentTab(agents[nextIdx].id);
      return;
    }

    // Alt/⌥ + A = next agent waiting for input (cycles, after the active one)
    if (action === 'nextWaiting') {
      handled();
      const waiting = agents.filter(a => a.status === 'waiting_input');
      if (waiting.length === 0) return;
      const currentIdx = agents.findIndex(a => a.id === this.activeSubAgentTab());
      const target = waiting.find(a => agents.indexOf(a) > currentIdx) ?? waiting[0];
      this.subAgentsExpanded.set(true);
      this.switchSubAgentTab(target.id);
      return;
    }

    // Alt/⌥ + L = lock/unlock focused sub-agent
    if (action === 'lockAgent') {
      const focused = this.focusedPaneId();
      if (focused?.startsWith('sa:')) {
        handled();
        const saId = focused.replace('sa:', '');
        this.toggleLockSubAgent(saId);
      }
      return;
    }

    // Alt/⌥ + E = expand/collapse the focused (or active) sub-agent
    if (action === 'expandAgent') {
      const focused = this.focusedPaneId();
      const saId = focused?.startsWith('sa:') ? focused.replace('sa:', '') : this.activeSubAgentTab();
      if (saId && this.subAgentService.activeSubAgents().some(a => a.id === saId)) {
        handled();
        this.subAgentsExpanded.set(true);
        this.toggleExpandSubAgent(saId);
      }
      return;
    }

    // Alt/⌥ + F = toggle focus mode
    if (action === 'focusMode') {
      handled();
      this.toggleFocusMode();
      return;
    }
  }

  /** Send an AI prompt generated from session assets to the active terminal */
  async sendAssetPromptToTerminal(prompt: string): Promise<void> {
    const sessionId = this.activeSessionId();
    if (!sessionId) return;

    try {
      await this.sessionService.writeSession(sessionId, prompt);
      this.terminalRef?.focus();
    } catch (err) {
    }
  }

  /**
   * Send a multi-line review prompt to the active terminal.
   * Wrapped in bracketed paste so the agent TUI takes the whole block as one
   * message instead of submitting on every newline; the trailing CR sends it.
   */
  async sendReviewPromptToTerminal(prompt: string): Promise<void> {
    const sessionId = this.activeSessionId();
    if (!sessionId) return;

    try {
      await this.sessionService.writeSession(sessionId, `\x1b[200~${prompt}\x1b[201~`);
      this.terminalRef?.focus();
      setTimeout(() => { void this.sessionService.writeSession(sessionId, '\r').catch(() => { /* terminal gone */ }); }, 120);
    } catch {
      /* terminal gone — nothing to send to */
    }
  }

  /** Spawn a sub-agent from an asset prompt */
  async spawnAssetSubAgent(event: { prompt: string; title: string }): Promise<void> {
    const sessionId = this.activeSessionId();
    if (!sessionId) return;

    try {
      await this.subAgentService.spawnCustom(
        sessionId,
        'asset-analyst',
        event.title,
        event.prompt,
      );
      this.subAgentsExpanded.set(true);
    } catch (err) {
    }
  }

  // ── Sub-agent drop zone (enter/leave/highlight handled by appFileDropZone) ──

  onSaDropZoneDrop(event: DragEvent): void {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) this.uploadAssetsFromDrop(files);
  }

  @HostListener('window:paste', ['$event'])
  onSaPaste(event: ClipboardEvent): void {
    // File/image pastes anywhere in the session go to assets. Terminal
    // components intercept their own paste in capture phase, so this only
    // fires when focus is outside a terminal.
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length > 0) {
      event.preventDefault();
      this.uploadAssetsFromDrop(files);
      return;
    }
    // Tauri/WKWebView does not expose native images in clipboardData (unlike
    // Chromium): fallback via the bridge. Only if the
    // clipboard has no text, otherwise a normal text Cmd+V
    // would also upload a stale image left in the clipboard.
    if (this.sessionService.isTauri && !event.clipboardData?.getData('text')) {
      void this.pasteImageFromNativeClipboard();
    }
  }

  private async pasteImageFromNativeClipboard(): Promise<void> {
    const bridge = (window as { promptops?: { clipboardReadImage?: () => Promise<string | null> } }).promptops;
    if (!bridge?.clipboardReadImage) return;
    try {
      const dataUrl = await bridge.clipboardReadImage();
      if (!dataUrl) return;
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], `pasted-image-${Date.now()}.png`, { type: 'image/png' });
      await this.uploadAssetsFromDrop([file]);
    } catch {
      // clipboard without an image or bridge not available: no feedback
    }
  }

  private async uploadAssetsFromDrop(files: File[]): Promise<void> {
    const session = this.activeSession();
    const ws = session?.workspace?.path;
    if (!ws) return;
    try {
      const existingNames = new Set(this.sessionAssetsService.assets().map(a => a.name));
      await this.sessionAssetsService.uploadFiles(ws, files);
      const newNames = this.sessionAssetsService.assets()
        .filter(a => !existingNames.has(a.name))
        .map(a => a.name);
      this.assetsPanel?.expandAndHighlight(newNames);
    } catch (err) {
    }
  }

  // ── Provider Check ──

  /** Bumped by each provider check: only the latest one may write the result. */
  private providerCheckSeq = 0;

  private async runProviderCheck(provider: string, force = false, sessionId?: string): Promise<void> {
    const seq = ++this.providerCheckSeq;
    // A slow check of the previous session must not show (or hide) the
    // install guide on the session the user switched to.
    const stale = () => seq !== this.providerCheckSeq || (!!sessionId && sessionId !== this.activeSessionId());
    this.providerChecking.set(true);
    try {
      const result = await this.sessionService.checkProvider(provider, force, sessionId);
      if (stale()) return;
      this.providerMissing.set(!result.installed);
      this.providerPlatform.set(result.platform);
      this.providerCommand.set(result.command);
      const detected = (result.platform === 'win32' || result.platform === 'linux' || result.platform === 'darwin')
        ? result.platform
        : 'darwin';
      this.manualPlatform.set(detected as 'darwin' | 'win32' | 'linux');
    } catch {
      // If check fails, don't block — assume installed
      if (!stale()) this.providerMissing.set(false);
    } finally {
      if (seq === this.providerCheckSeq) this.providerChecking.set(false);
    }
  }

  async retryProviderCheck(): Promise<void> {
    const session = this.activeSession();
    if (!session) return;
    await this.runProviderCheck(session.provider, true, session.id);
  }

  // ── Provider switch escape hatch (install guide) ──
  // A session can legitimately reference a provider that is no longer
  // installed (or a restored session from another setup). The guide must never be a dead end:
  // it unmounts the composer (and its provider chip), so the switch-back
  // control has to live in the guide itself.

  protected get switchProviders() {
    return this.orgPolicy.filterProviders(SPAWN_PROVIDERS, (p) => p.value);
  }
  readonly switchAvailability = signal<Partial<Record<ProviderType, boolean>>>({});
  readonly switchingProvider = signal<ProviderType | null>(null);
  readonly switchError = signal(false);

  private async loadSwitchAvailability(): Promise<void> {
    // Probe in the session's own shell (WSL / Git Bash on Windows).
    const sessionId = this.activeSession()?.id;
    const entries = await Promise.all(
      SPAWN_PROVIDERS.map(async (p) => [p.value, await this.providerSwitch.isProviderAvailable(p.value, sessionId)] as const),
    );
    this.switchAvailability.set(Object.fromEntries(entries));
  }

  async switchProviderFromGuide(next: ProviderType): Promise<void> {
    const session = this.activeSession();
    if (!session || this.switchingProvider()) return;
    this.switchError.set(false);
    this.switchingProvider.set(next);
    try {
      const res = await this.providerSwitch.changeSessionProvider(session, next);
      if (!res.ok) {
        this.switchError.set(true);
        return;
      }
      // Nothing more to do on success: the store dispatch re-fires the
      // active-session effect → runProviderCheck(next) → guide unmounts.
    } catch (err) {
      console.warn('[session-view] provider switch failed', err);
      this.switchError.set(true);
    } finally {
      this.switchingProvider.set(null);
    }
  }

  // ── Provider auto-installer ──

  /** False when there is no install script for this provider/platform: the guide shows only the manual steps. */
  readonly canAutoInstall = computed(() => {
    const session = this.activeSession();
    return !!session && !!buildInstallScript(session.provider, this.providerPlatform());
  });

  async autoInstallProvider(): Promise<void> {
    const session = this.activeSession();
    if (!session) return;

    const script = buildInstallScript(session.provider, this.providerPlatform());
    if (!script) return;

    if (this.installerTerminalId()) {
      this.sessionService.writeTerminal(this.installerTerminalId()!, script);
    } else {
      this.pendingInstallCmd = script;
      await this.ensureInstallTerminal();
    }
  }

  async runInstallCommand(cmd: string): Promise<void> {
    const cmdWithEnter = cmd + '\r';

    if (this.installerTerminalId()) {
      this.sessionService.writeTerminal(this.installerTerminalId()!, cmdWithEnter);
    } else {
      this.pendingInstallCmd = cmdWithEnter;
      await this.ensureInstallTerminal();
    }
  }

  // Copy-only helper for commands that need a separate elevated PowerShell
  // (e.g. the admin execution-policy fallback) — running them in the current,
  // non-elevated install terminal would just fail with access denied.
  policyAdminCmdCopied = false;
  copyInstallCommand(cmd: string): void {
    void this.sessionService.clipboardWrite(cmd).then((res) => {
      if (!res.ok) return;
      this.policyAdminCmdCopied = true;
      setTimeout(() => this.policyAdminCmdCopied = false, 2000);
    });
  }

  closeInstallTerminal(): void {
    const terminalId = this.installerTerminalId();
    if (terminalId) {
      this.sessionService.closeTerminal(terminalId);
    }
    this.installResizeObserver?.disconnect();
    this.installResizeObserver = null;
    this.unsubInstallOutput?.();
    this.unsubInstallOutput = null;
    this.installXterm?.dispose();
    this.installXterm = null;
    this.installFitAddon = null;
    this.installerTerminalId.set(null);
    this.pendingInstallCmd = null;
  }

  private async ensureInstallTerminal(): Promise<void> {
    if (this.installerTerminalId()) return;

    this.installerRunning.set(true);
    try {
      const result = await this.sessionService.openTerminal({ sessionId: this.activeSession()?.id });
      if (result.ok && result.terminalId) {
        this.unsubInstallOutput = this.sessionService.onTerminalOutput((event) => {
          if (event.terminalId === this.installerTerminalId()) {
            this.installXterm?.write(event.data);
          }
        });
        this.installerTerminalId.set(result.terminalId);
      }
    } finally {
      this.installerRunning.set(false);
    }
  }

  private initInstallTerminal(container: HTMLDivElement): void {
    this.installXterm = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
      theme: {
        background: '#0d1117',
        foreground: '#aab8c5',
        cursor: '#3fb950',
        selectionBackground: '#1a3a2a',
      },
      scrollback: 5000,
      allowProposedApi: true,
    });

    this.installFitAddon = new FitAddon();
    this.installXterm.loadAddon(this.installFitAddon);
    this.installXterm.open(container);
    attachWebglRenderer(this.installXterm);
    this.installFitAddon.fit();

    const terminalId = this.installerTerminalId()!;

    // User input (for sudo password, gh auth, etc.)
    this.installXterm.onData((data) => {
      this.sessionService.writeTerminal(terminalId, data);
    });

    // Auto-resize
    this.installResizeObserver = new ResizeObserver(() => {
      this.installFitAddon?.fit();
      const dims = this.installFitAddon?.proposeDimensions();
      if (dims) {
        this.sessionService.resizeTerminal(terminalId, dims.cols, dims.rows);
      }
    });
    this.installResizeObserver.observe(container);

    // Initial resize + inject pending command
    setTimeout(() => {
      this.installFitAddon?.fit();
      const dims = this.installFitAddon?.proposeDimensions();
      if (dims) {
        this.sessionService.resizeTerminal(terminalId, dims.cols, dims.rows);
      }
      this.installXterm?.focus();

      if (this.pendingInstallCmd) {
        const cmd = this.pendingInstallCmd;
        this.pendingInstallCmd = null;
        this.sessionService.writeTerminal(terminalId, cmd);
      }
    }, 150);
  }

  /** Manual-tab npm install one-liner for the current platform pill. */
  npmInstallCmd(pkg: string): string {
    return npmInstallCommand(this.manualPlatform(), pkg);
  }

  private loadResizeState(): Record<string, any> {
    try {
      return JSON.parse(localStorage.getItem(RESIZE_STORAGE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  /** Toggle the left sessions sidebar and persist (global + per-session local store). */
  toggleSessionsSidebar(): void {
    this.sidebarCollapsed.set(!this.sidebarCollapsed());
    this.saveResizeState();
  }

  /** Set the right action-center / sub-agents sidebar collapse and persist. */
  setActionCenterCollapsed(collapsed: boolean): void {
    this.actionCenterCollapsed.set(collapsed);
    this.saveResizeState();
  }

  private saveResizeState(): void {
    const state: SessionViewState = {
      sidebarCollapsed: this.sidebarCollapsed(),
      sidebarWidth: this.sidebarWidth(),
      subAgentsHeight: this.subAgentsHeight(),
      subAgentsListMode: this.subAgentsListMode(),
      subAgentTabMode: this.subAgentTabMode(),
      subAgentGridMode: this.subAgentGridMode(),
      subAgentLayout: this.subAgentTabMode() ? 'tabs' : this.subAgentColumnsMode() ? 'columns' : this.subAgentRowsMode() ? 'rows' : 'auto',
      subAgentsCoverMain: this.subAgentsCoverMain(),
      userExplicitLayout: this.userExplicitLayout(),
      ideSubAgentsHeight: this.ideSubAgentsHeight(),
      actionCenterWidth: this.actionCenterWidth(),
      actionCenterCollapsed: this.actionCenterCollapsed(),
      ideRightWidth: this.ideRightWidth(),
      ideRightCollapsed: this.ideRightCollapsed(),
    };
    // Legacy global fallback — used when a session has no persisted view_state yet
    // (first open after upgrade) so users keep their previous layout as default.
    safeSetItem(RESIZE_STORAGE_KEY, JSON.stringify(state));

    // Per-session persistence (local store is source of truth; effect debounces writes).
    const sessionId = this.activeSessionId();
    if (sessionId && !this.restoringViewState) {
      this.store.dispatch(updateSessionViewState({ sessionId, viewState: state }));
    }
  }

  /** Guard: true while applying viewState from the store to avoid feedback loops. */
  private restoringViewState = false;

  /**
   * Apply a persisted SessionViewState to local signals.
   * Called when the active session changes so each session restores its own layout.
   * Sub-agent internal panel sizes are intentionally NOT restored — they always
   * start at their native/default flex sizing, per product requirement.
   */
  private applySessionViewState(vs: SessionViewState | undefined): void {
    this.restoringViewState = true;
    try {
      const fallback = this.loadResizeState();
      const pick = <T>(key: keyof SessionViewState, def: T): T => {
        const v = (vs?.[key] ?? fallback[key as string]) as T | undefined;
        return (v === undefined || v === null) ? def : v;
      };

      this.sidebarCollapsed.set(pick('sidebarCollapsed', false));
      this.sidebarWidth.set(pick('sidebarWidth', 260));
      this.subAgentsHeight.set(pick('subAgentsHeight', 250));
      this.subAgentsListMode.set(false);
      // Tabs only if chosen by hand: the auto-switch at >3 agents no longer exists.
      this.subAgentTabMode.set(pick('subAgentTabMode', false) && pick('userExplicitLayout', false));
      this.subAgentGridMode.set(pick('subAgentGridMode', false));
      this.subAgentColumnsMode.set(pick<SessionViewState['subAgentLayout']>('subAgentLayout', 'auto') === 'columns');
      this.subAgentRowsMode.set(pick<SessionViewState['subAgentLayout']>('subAgentLayout', 'auto') === 'rows');
      this.subAgentsCoverMainUser.set(pick('subAgentsCoverMain', false));
      this.userExplicitLayout.set(pick('userExplicitLayout', false));
      this.ideSubAgentsHeight.set(pick('ideSubAgentsHeight', this.ideSubAgentsHeight()));
      this.actionCenterWidth.set(pick('actionCenterWidth', this.actionCenterWidth()));
      this.actionCenterCollapsed.set(pick('actionCenterCollapsed', this.actionCenterCollapsed()));
      this.ideRightWidth.set(pick('ideRightWidth', this.ideRightWidth()));
      this.ideRightCollapsed.set(pick('ideRightCollapsed', this.ideRightCollapsed()));
      // Per-session locks are reloaded by SubAgentService.trackSession.
    } finally {
      this.restoringViewState = false;
    }
  }
}
