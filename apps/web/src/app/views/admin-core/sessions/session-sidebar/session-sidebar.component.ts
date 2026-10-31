import { Component, CUSTOM_ELEMENTS_SCHEMA, DestroyRef, ElementRef, inject, input, output, computed, signal, effect, untracked, viewChild, HostListener, ChangeDetectionStrategy } from '@angular/core';
import { homeRelativePath } from '../services/home-relative-path';
import { readDismissedMains } from '../services/dismissed-mains';
import { AGENTS_MODEL } from '../agents/agents-model.token';
import { AgentRosterService } from '../agents/agent-roster.service';
import { CommonModule } from '@angular/common';
import { Store } from '@ngrx/store';
import { firstValueFrom } from 'rxjs';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { SessionSummary, DeviceWorkspaceStatus } from '../../../../../store/sessions/session.state';
import { WorkspaceSummary } from '../../../../../store/workspaces/workspace.state';
import { loadSessions } from '../../../../../store/sessions/session.actions';
import { SubAgentService, SubAgent } from '../services/sub-agent.service';
import { SessionService } from '../services/session.service';
import { DesktopSessionApiService } from '../services/desktop-session-api.service';
import { InteractionService } from '../services/interaction.service';
import { EcoModeService } from '../services/eco-mode.service';
import { TooltipDirective } from '../../../../common/tooltip.directive';
import { FileDropZoneDirective } from '../../../../common/file-drop-zone.directive';
import { ScrollHitTestFixDirective } from '../../../../common/scroll-hit-test-fix.directive';
import { UiStyleService } from '@core/services/ui-style.service';
import { SessionProfileSwitcherComponent } from '../session-profile-switcher/session-profile-switcher.component';
import { SidebarFoldersService } from '../services/sidebar-folders.service';
import { applyManualToggle, applyParkTransitions, isExpanded, parseIdSet } from './workspace-expand-state';
import { SidebarFolder } from '../services/sidebar-folder-api.service';
import { environment } from '@environment/environment';
import { BuiltinPluginsService } from '../../plugins/builtin-plugins.service';
import { PluginMenuPage, PluginRuntimeService } from '../../plugins/plugin-runtime.service';
import { Router } from '@angular/router';
import { FloorPlanService } from '../floor-plan/floor-plan.service';
import { SessionWindowsService } from '../services/session-windows.service';
import { canDetach } from '@/app/detached/detached-window';
import { PROVIDER_LOGO } from '../provider-logos';
import { FloorPlanViewComponent } from '../floor-plan/floor-plan-view.component';

export interface WorkspaceGroup {
  workspace: WorkspaceSummary;
  sessions: SessionSummary[];
  expanded: boolean;
}

/** One collapsible folder section in the sidebar (minimal UI only). */
export /** Entries waiting for input inside a container (workspace/folder) and the timestamp of the oldest one. */
interface AttentionInfo {
  count: number;
  since: number;
}

interface FolderSection {
  folder: SidebarFolder;
  groups: WorkspaceGroup[];
  standalone: SessionSummary[];
}

/** Item being dragged inside the sidebar (folders DnD — minimal UI only).
 *  For sessions, `id` is the stored dbId (the join key of folder assignments). */
export interface DraggedSidebarItem {
  kind: 'workspace' | 'session' | 'folder';
  id: string;
}

export type ContextMenuTarget =
  | { type: 'workspace'; workspace: WorkspaceSummary }
  | { type: 'session'; session: SessionSummary }
  | { type: 'folder'; folder: SidebarFolder };


/** Shared empty result: never mutated by callers. */
const NO_SUB_AGENTS: SubAgent[] = [];

@Component({
  selector: 'app-session-sidebar',
  standalone: true,
  imports: [CommonModule, TranslateModule, TooltipDirective, FileDropZoneDirective, ScrollHitTestFixDirective, SessionProfileSwitcherComponent, FloorPlanViewComponent],
  templateUrl: './session-sidebar.component.html',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    /* ── Plugin entries ("sidebar" zone): detached from the list, with a thin border and puzzle icon ── */
    .plugin-entries { display: flex; flex-direction: column; gap: 4px; padding: 2px 8px 8px; margin-bottom: 4px;
      border-bottom: 1px dashed var(--promptops-border-color, rgba(127,127,127,.25)); }
    .plugin-entry { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border-radius: 8px; font-size: 12.5px;
      border: 1px solid var(--promptops-border-color, rgba(127,127,127,.25)); background: transparent; color: inherit; text-align: left; cursor: pointer;
      transition: background .12s, border-color .12s; }
    .plugin-entry:hover { background: rgba(99,102,241,.08); border-color: rgba(99,102,241,.45); }
    .plugin-entry.active { background: rgba(99,102,241,.12); border-color: rgba(99,102,241,.6); }
    .collapsed-plugin-entry.active { background: rgba(99,102,241,.14); }
    .plugin-entry:focus-visible { outline: 2px solid var(--promptops-primary, #6366f1); outline-offset: 1px; }
    .plugin-entry > .ti:first-child { font-size: 16px; color: var(--promptops-primary, #6366f1); flex: none; }
    .plugin-entry-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
    .plugin-entry-puzzle { font-size: 12px; opacity: .5; flex: none; }
    .collapsed-plugin-entry { position: relative; }
    .plugin-entry-alert { font-size: 10px; font-weight: 700; min-width: 16px; padding: 0 5px; border-radius: 8px; text-align: center;
      background: rgba(245,158,11,.18); color: #d97706; border: 1px solid rgba(245,158,11,.45); flex: none; }
    .collapsed-plugin-alert { position: absolute; top: 3px; right: 3px; width: 7px; height: 7px; border-radius: 50%; background: #f59e0b; }
    .collapsed-plugin-entry .plugin-entry-puzzle { position: absolute; right: 1px; bottom: 0; font-size: 9px; }

    /* ── Base ── */
    .session-sidebar {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--po-bg-2);
      border-right: 1px solid rgba(255, 255, 255, 0.06);
      overflow-x: hidden;
      position: relative;
    }

    /* ── Drag a folder onto the sidebar (minimal UI) ── */
    .session-sidebar.drag-over {
      outline: 2px dashed var(--po-accent, #2dd4bf);
      outline-offset: -4px;
    }

    .drop-overlay {
      position: absolute;
      inset: 0;
      z-index: 30;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 1rem;
      text-align: center;
      background: color-mix(in srgb, var(--po-bg-2) 78%, transparent);
      backdrop-filter: blur(2px);
      color: var(--po-accent, #2dd4bf);
      font-size: 0.78rem;
      font-weight: 600;
      pointer-events: none;
    }

    .drop-overlay iconify-icon {
      color: var(--po-accent, #2dd4bf);
    }

    /* ── Header ── */
    .sidebar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.4rem;
      padding: 0.65rem 0.75rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    .sidebar-header-left {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      min-width: 0;
      flex: 1 1 auto;
    }

    /* The title gives way, not the switcher: its dropdown hangs below, so no overflow clip here. */
    .sidebar-header-left app-session-profile-switcher {
      flex-shrink: 0;
    }

    .sidebar-title {
      margin: 0;
      font-weight: 700;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--po-text-secondary);
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .sidebar-header-actions {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      flex-shrink: 0;
    }

    .btn-new-session {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      height: 26px;
      padding: 0 0.6rem;
      border: 1px solid var(--po-accent);
      border-radius: 5px;
      background: var(--po-accent-muted-bg);
      color: var(--po-accent);
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 0.02em;
      line-height: 1;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s;
    }
    .btn-new-session iconify-icon {
      font-size: 0;
    }
    .btn-new-session:hover {
      background: var(--po-accent);
      border-color: var(--po-accent-hover);
      color: var(--po-accent-on);
      box-shadow: 0 0 0 3px var(--po-accent-muted-bg);
    }
    .btn-new-session:active {
      transform: translateY(0.5px);
    }

    /* ── Compact header buttons (minimal UI only — classic keeps btn-new-session) ── */
    .btn-new-vert {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1px;
      width: 34px;
      height: 32px;
      padding: 0;
      border: 1px solid var(--po-accent);
      border-radius: 6px;
      background: var(--po-accent-muted-bg);
      color: var(--po-accent);
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s;
    }
    .btn-new-vert iconify-icon {
      font-size: 0;
    }
    .btn-new-vert-label {
      font-size: 0.5rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      line-height: 1;
    }
    .btn-new-vert:hover {
      background: var(--po-accent);
      border-color: var(--po-accent-hover);
      color: var(--po-accent-on);
      box-shadow: 0 0 0 3px var(--po-accent-muted-bg);
    }
    .btn-new-vert:active {
      transform: translateY(0.5px);
    }

    .btn-new-folder {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 32px;
      padding: 0;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      background: transparent;
      color: var(--po-text-secondary);
      font-size: 0;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .btn-new-folder:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.22);
      color: var(--po-text-primary);
    }
    .btn-new-folder:active {
      transform: translateY(0.5px);
    }

    .btn-toggle-sidebar {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
      flex-shrink: 0;
      transition: all 0.15s;
    }
    .btn-toggle-sidebar:hover {
      background: rgba(255, 255, 255, 0.06);
      color: var(--po-text-primary);
    }

    /* ── Session list ── */
    .sidebar-floor-plan { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .session-list {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 0.35rem 0;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.08) transparent;
    }
    .session-list::-webkit-scrollbar { width: 4px; }
    .session-list::-webkit-scrollbar-track { background: transparent; }
    .session-list::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 4px;
    }

    /* ── Section label ── */
    .section-label {
      padding: 0.5rem 0.75rem 0.25rem;
      font-size: 0.62rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--po-text-secondary);
      opacity: 0.7;
    }

    /* ── Workspace group ── */
    .workspace-group {
      margin-bottom: 0.15rem;
    }

    .workspace-header {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.4rem 0.75rem;
      cursor: pointer;
      user-select: none;
      border-radius: 6px;
      margin: 0 0.35rem;
      transition: background 0.12s;
    }
    .workspace-header:hover {
      background: rgba(255, 255, 255, 0.05);
    }

    .workspace-chevron {
      flex-shrink: 0;
      color: var(--po-text-secondary);
      font-size: 0;
    }

    .workspace-icon {
      flex-shrink: 0;
      color: var(--po-accent);
    }

    .workspace-name {
      font-size: 0.78rem;
      font-weight: 600;
      color: var(--po-text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      min-width: 0;
    }

    .workspace-badge {
      font-size: 0.58rem;
      font-weight: 700;
      min-width: 16px;
      text-align: center;
      padding: 1px 5px;
      border-radius: 10px;
      background: var(--po-accent-muted-bg);
      color: var(--po-accent);
      flex-shrink: 0;
    }

    .workspace-sessions {
      padding: 0.1rem 0 0.15rem 0;
    }

    /* "Single" workspace (multi-session plugin off): the folder row is the session */
    .workspace-header.solo {
      border-left: 2px solid transparent;
    }
    .workspace-header.solo.active {
      background: var(--po-accent-muted-bg);
      border-left-color: var(--po-accent);
    }
    .workspace-header.solo.standby .workspace-icon,
    .workspace-header.solo.standby .workspace-name {
      opacity: 0.7;
    }
    .workspace-chevron-btn {
      cursor: pointer;
      border-radius: 3px;
    }
    .workspace-chevron-btn:hover {
      color: var(--po-text-primary);
      background: rgba(255, 255, 255, 0.08);
    }
    .workspace-group.solo .sub-agent-item {
      padding-left: 1.9rem;
    }

    /* ── Sidebar folders (minimal UI only — the markup never renders in classic) ── */
    .folder-section {
      margin-bottom: 0.15rem;
      border-radius: 8px;
      border: 1px dashed transparent;
      transition: background 0.12s, border-color 0.12s;
    }
    .folder-section.drop-target {
      background: var(--po-accent-muted-bg);
      border-color: var(--po-accent);
    }

    .folder-header {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.42rem 0.75rem;
      cursor: pointer;
      user-select: none;
      border-radius: 6px;
      margin: 0 0.35rem;
      transition: background 0.12s;
    }
    .folder-header:hover {
      background: rgba(255, 255, 255, 0.05);
    }

    .folder-chevron {
      flex-shrink: 0;
      color: var(--po-text-secondary);
      font-size: 0;
    }

    .folder-icon {
      flex-shrink: 0;
      color: var(--po-accent);
    }

    .folder-name {
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--po-text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      min-width: 0;
    }

    .folder-badge {
      font-size: 0.58rem;
      font-weight: 700;
      min-width: 16px;
      text-align: center;
      padding: 1px 5px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.07);
      color: var(--po-text-secondary);
      flex-shrink: 0;
    }

    /* Indented content with a subtle left rail, echoing the sub-agent connector */
    .folder-content {
      margin-left: 0.85rem;
      padding-left: 0.15rem;
      border-left: 1px solid rgba(255, 255, 255, 0.07);
    }

    .folder-empty-hint {
      padding: 0.35rem 0.75rem 0.45rem;
      font-size: 0.68rem;
      font-style: italic;
      color: var(--po-text-secondary);
      opacity: 0.7;
    }

    .folder-edit-input {
      flex: 1;
      min-width: 0;
      font-size: 0.72rem;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
      border: 1px solid var(--po-accent);
      background: rgba(0, 0, 0, 0.25);
      color: var(--po-text-primary);
      outline: none;
    }

    .folder-unfile-zone {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      margin: 0.15rem 0.35rem 0.3rem;
      padding: 0.4rem 0.75rem;
      border: 1px dashed rgba(255, 255, 255, 0.18);
      border-radius: 8px;
      font-size: 0.68rem;
      font-weight: 600;
      color: var(--po-text-secondary);
      transition: background 0.12s, border-color 0.12s, color 0.12s;
    }
    .folder-unfile-zone.drop-target {
      background: var(--po-accent-muted-bg);
      border-color: var(--po-accent);
      color: var(--po-accent);
    }

    /* ── Session item ── */
    .session-item {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      padding: 0.4rem 0.75rem;
      margin: 1px 0.35rem;
      cursor: pointer;
      border-radius: 6px;
      transition: all 0.12s;
      border-left: 2px solid transparent;
    }

    .session-item:hover {
      background: rgba(255, 255, 255, 0.05);
    }

    .session-item.active {
      background: var(--po-accent-muted-bg);
      border-left-color: var(--po-accent);
    }
    .session-item.active .session-name {
      color: var(--po-text-primary);
    }

    .session-item.nested {
      padding-left: 1.75rem;
      margin-left: 0.5rem;
    }

    .session-icon {
      flex-shrink: 0;
      color: var(--po-text-secondary);
      display: flex;
      align-items: center;
    }
    .session-item.active .session-icon {
      color: var(--po-accent);
    }

    .session-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .session-name {
      font-size: 0.8rem;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--po-text-secondary);
    }

    .session-workspace {
      font-size: 0.65rem;
      color: var(--po-text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .session-meta {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 0.3rem;
    }

    /* ── Status dots ── */
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      display: inline-block;
    }
    .status-idle { background: rgba(108, 117, 125, 0.5); }
    .status-running { background: var(--po-success); box-shadow: 0 0 4px rgba(63, 185, 80, 0.4); }
    .status-in_progress { background: #8b5cf6; box-shadow: 0 0 4px rgba(139, 92, 246, 0.4); }
    .status-waiting_input { background: var(--po-warning); box-shadow: 0 0 4px rgba(210, 153, 34, 0.4); }
    .status-completed { background: var(--po-info); }
    .status-error { background: var(--po-error); box-shadow: 0 0 4px rgba(248, 81, 73, 0.4); }
    .status-exited { background: var(--po-text-secondary); }

    /* Minimal: per-status glyph (shape + color), never color alone. */
    .status-glyph {
      display: inline-flex; align-items: center; justify-content: center;
      width: 13px; height: 13px; background: none !important; box-shadow: none !important;
    }
    .status-glyph.status-idle { color: var(--po-text-secondary, #5b6475); }
    .status-glyph.status-running,
    .status-glyph.status-in_progress { color: #7c3aed; }
    .status-glyph.status-completed { color: var(--po-info, #2563eb); }
    .status-glyph.status-error { color: var(--po-error, #dc2626); }
    .status-glyph.status-exited { color: var(--po-text-secondary, #5b6475); }

    .status-dot.small {
      width: 5px;
      height: 5px;
      flex-shrink: 0;
      box-shadow: none;
    }

    .attention-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--po-warning);
      flex-shrink: 0;
      animation: pulse-attention 1.5s ease-in-out infinite;
      box-shadow: 0 0 4px var(--po-warning);
    }

    @keyframes pulse-attention {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    /* ── Attention timer: how long a session/sub-agent has been waiting for input (minimal UI) ── */
    .attention-timer,
    .attention-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 16px;
      padding: 0 5px;
      border-radius: 8px;
      font-size: 0.58rem;
      font-weight: 700;
      line-height: 1;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      color: var(--po-warning);
      background: color-mix(in oklab, var(--po-warning) 16%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--po-warning) 35%, transparent);
      flex-shrink: 0;
    }
    .attention-badge .attention-dot { width: 5px; height: 5px; box-shadow: none; }
    .session-item.needs-attention .session-name,
    .workspace-header.needs-attention .workspace-name,
    .folder-header.needs-attention .folder-name {
      color: var(--po-warning);
    }
    .workspace-header.needs-attention .workspace-icon {
      color: var(--po-warning);
    }
    .session-item.needs-attention:not(.active) {
      box-shadow: inset 2px 0 0 var(--po-warning);
    }

    /* ── Device workspace status (icon-based, distinct from session status dot) ── */
    .device-status-icon {
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      font-size: 0;
    }
    .device-status-icon.device-configured { color: var(--po-success); }
    .device-status-icon.device-not_configured { color: var(--po-warning); }
    .device-status-icon.device-invalid_path { color: var(--po-error); }

    /* ── Sub-agents ── */
    .sub-agent-item {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.15rem 0.75rem 0.15rem 2.5rem;
      font-size: 0.68rem;
      color: var(--po-text-secondary);
      cursor: pointer;
      user-select: none;
      overflow: hidden;
      max-width: 100%;
      transition: background-color 0.15s ease;
    }
    .sub-agent-item:hover {
      background: rgba(255, 255, 255, 0.04);
    }
    .sub-agent-item.active {
      background: linear-gradient(90deg, rgba(99, 102, 241, 0.18), rgba(168, 85, 247, 0.12));
      color: var(--po-text-primary);
    }

    .sub-agent-connector {
      width: 8px;
      height: 1px;
      background: rgba(255, 255, 255, 0.1);
      flex-shrink: 0;
    }

    .sub-agent-title {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      flex-shrink: 1;
    }

    .sub-agent-item.needs-attention {
      color: var(--po-warning);
    }

    .provider-logo {
      object-fit: contain;
      opacity: 0.85;
      flex-shrink: 0;
    }
    .sub-agent-item:hover .provider-logo {
      opacity: 1;
    }

    /* ── Empty state ── */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 24px 16px;
      text-align: center;
    }
    .empty-state iconify-icon { color: var(--po-text-tertiary); }
    .empty-title {
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--po-text-secondary);
    }
    .empty-hint {
      font-size: 0.75rem;
      color: var(--po-text-tertiary);
      max-width: 200px;
      line-height: 1.4;
    }

    /* ── Collapsed sidebar ── */
    .session-sidebar.collapsed {
      width: 100%;
    }

    .collapsed-bar {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 0.5rem 0;
      gap: 0.25rem;
      height: 100%;
    }

    .btn-collapsed-action {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: var(--po-accent);
      cursor: pointer;
      margin-bottom: 0.5rem;
      transition: background 0.15s;
    }
    .btn-collapsed-action:hover {
      background: var(--po-accent-muted-bg);
    }

    .collapsed-sessions {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      flex: 1;
      overflow-y: auto;
      width: 100%;
      padding: 0 2px;
    }

    .collapsed-session-icon {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      border-radius: 8px;
      cursor: pointer;
      color: var(--po-text-secondary);
      transition: all 0.15s;
      /* Neutral by default; the accent left-border only appears on the active session. */
      border-left: 2px solid transparent;
    }
    /* Session icons nested under a workspace avatar are subordinate → slightly smaller. */
    .collapsed-session-icon.in-group {
      width: 26px;
      height: 26px;
      border-radius: 6px;
    }
    .collapsed-session-icon:hover {
      background: rgba(255, 255, 255, 0.06);
      color: var(--po-text-primary);
    }
    .collapsed-session-icon.active {
      background: var(--po-accent-muted-bg);
      color: var(--po-accent);
      border-left-color: var(--po-accent);
    }
    .collapsed-session-icon.attention {
      color: var(--po-warning);
    }
    /* Real provider logo for the session item (replaces the stylized glyph). Desaturated to B&W. */
    .collapsed-session-logo {
      width: 16px;
      height: 16px;
      object-fit: contain;
      filter: grayscale(1);
    }

    .collapsed-attention-dot {
      position: absolute;
      top: 4px;
      right: 4px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--po-warning);
      box-shadow: 0 0 4px var(--po-warning);
      animation: pulse-attention 1.5s ease-in-out infinite;
    }

    /* ── Collapsed rail: workspace groups & monogram avatars ── */
    .collapsed-ws-group {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 100%;
      margin-bottom: 7px;
    }

    /* Folder / workspace nodes: same glyphs as the expanded tree, never letters. */
    .collapsed-node {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 28px;
      border-radius: 7px;
      color: var(--po-text-secondary);
      cursor: pointer;
      user-select: none;
      transition: background 0.15s, color 0.15s, box-shadow 0.15s;
    }
    .collapsed-node:hover {
      background: color-mix(in oklab, var(--po-text-secondary) 12%, transparent);
      color: var(--po-text-primary);
    }
    .collapsed-ws-node { color: var(--po-accent); }
    .collapsed-ws-node.standby { opacity: 0.55; }
    .collapsed-ws-node.attention { color: var(--po-warning); }
    .collapsed-folder-node { color: var(--rail-folder-color, var(--po-text-secondary)); }
    .collapsed-node.active {
      background: var(--po-accent-muted-bg);
      box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--po-accent) 45%, transparent);
    }
    /* Provider badge on a single-session workspace. */
    .collapsed-ws-provider {
      position: absolute;
      bottom: 1px;
      right: 1px;
      width: 10px;
      height: 10px;
      padding: 1px;
      box-sizing: content-box;
      border-radius: 3px;
      background: var(--po-bg-2);
      object-fit: contain;
      filter: grayscale(1);
    }

    .collapsed-folder {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 100%;
      margin-bottom: 6px;
    }
    /* Children hang off a vertical guide line, like the tree's indentation. */
    .collapsed-children {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      width: calc(100% - 8px);
      margin: 2px 0 0 8px;
      padding: 2px 0 2px 2px;
      border-left: 1px solid color-mix(in oklab, var(--po-text-secondary) 28%, transparent);
    }
    .collapsed-folder-children {
      border-left-color: color-mix(in oklab, var(--rail-folder-color, var(--po-text-secondary)) 45%, transparent);
    }
    .collapsed-rail-sep {
      width: 18px;
      height: 1px;
      margin: 4px 0 6px;
      background: color-mix(in oklab, var(--po-text-secondary) 30%, transparent);
    }

    .collapsed-ws-count {
      position: absolute;
      bottom: -3px;
      right: -3px;
      min-width: 14px;
      height: 14px;
      padding: 0 3px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.55rem;
      font-weight: 700;
      line-height: 1;
      color: var(--po-text-primary);
      background: var(--po-bg-1, var(--po-bg-2));
      border: 1px solid color-mix(in oklab, var(--po-text-secondary) 22%, transparent);
      border-radius: 8px;
    }

    /* Sub-agents in the collapsed rail: subordinate to their session → smallest item, real provider logo. */
    .collapsed-subagent-icon {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 6px;
      cursor: pointer;
      opacity: 0.72;
      transition: opacity 0.15s, background 0.15s, box-shadow 0.15s;
    }
    .collapsed-subagent-icon:hover {
      opacity: 1;
      background: color-mix(in oklab, var(--po-text-secondary) 12%, transparent);
    }
    .collapsed-subagent-icon.active {
      opacity: 1;
      background: var(--po-accent-muted-bg);
      box-shadow: inset 0 0 0 1px var(--po-accent);
    }
    .collapsed-subagent-icon.attention {
      opacity: 1;
    }
    .collapsed-subagent-logo {
      width: 13px;
      height: 13px;
      object-fit: contain;
      filter: grayscale(1);
    }

    /* ── Auto-Approve warning indicator ── */
    .aa-indicator {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: var(--po-error);
      filter: drop-shadow(0 0 3px rgba(248, 81, 73, 0.55));
      animation: aa-indicator-pulse 1.6s ease-in-out infinite;
    }
    .aa-indicator.small {
      font-size: 0;
    }

    @keyframes aa-indicator-pulse {
      0%, 100% {
        opacity: 1;
        filter: drop-shadow(0 0 3px rgba(248, 81, 73, 0.55));
      }
      50% {
        opacity: 0.72;
        filter: drop-shadow(0 0 6px rgba(248, 81, 73, 0.85));
      }
    }

    /* ── Eco Mode indicator ── */
    .eco-indicator {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: var(--po-success);
      filter: drop-shadow(0 0 2px rgba(63, 185, 80, 0.4));
    }
    .eco-indicator.small {
      font-size: 0;
    }

    .session-item.aa-on {
      background: rgba(248, 81, 73, 0.06);
    }
    .session-item.aa-on:hover {
      background: rgba(248, 81, 73, 0.1);
    }
    .session-item.active.aa-on {
      background: var(--po-error-bg);
      border-left-color: var(--po-error);
    }

    .sub-agent-item.aa-on {
      color: var(--po-error);
    }

    .collapsed-session-icon.aa-on {
      color: var(--po-error);
      border-left-color: rgba(248, 81, 73, 0.7);
    }
    .collapsed-aa-dot {
      position: absolute;
      top: 4px;
      left: 4px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--po-error);
      box-shadow: 0 0 5px rgba(248, 81, 73, 0.8);
      animation: aa-indicator-pulse 1.6s ease-in-out infinite;
    }

    /* ── Context menu ── */
    .ctx-backdrop {
      position: fixed;
      inset: 0;
      z-index: 999;
    }

    .ctx-menu {
      position: fixed;
      z-index: 1000;
      min-width: 170px;
      max-height: calc(100vh - 16px);
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 0.35rem;
      background: var(--po-bg-2);
      border: 1px solid color-mix(in oklab, var(--po-text-secondary) 20%, transparent);
      border-radius: 0.5rem;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    }

    .ctx-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      padding: 0.4rem 0.65rem;
      border: none;
      border-radius: 0.35rem;
      background: transparent;
      color: var(--po-text-primary);
      font-size: 0.78rem;
      cursor: pointer;
      transition: background 0.1s;
      text-align: left;
    }
    .ctx-item:hover {
      background: color-mix(in oklab, var(--po-text-secondary) 12%, transparent);
    }
    .ctx-item iconify-icon {
      color: var(--po-text-secondary);
      flex-shrink: 0;
    }

    .ctx-divider {
      height: 1px;
      margin: 0.25rem 0.5rem;
      background: color-mix(in oklab, var(--po-text-secondary) 16%, transparent);
    }

    .ctx-item-danger {
      color: var(--po-error);
    }
    .ctx-item-danger:hover {
      background: var(--po-error-bg);
    }
    .ctx-item-danger iconify-icon {
      color: var(--po-error);
    }

    /* ── Folder entries in the context menu ── */
    .ctx-grow {
      flex: 1;
      min-width: 0;
    }

    .ctx-folder-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .ctx-folder-name {
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .ctx-color-row {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.3rem 0.65rem 0.35rem;
    }

    .ctx-color-swatch {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      border: 1px solid color-mix(in oklab, var(--po-text-secondary) 30%, transparent);
      padding: 0;
      cursor: pointer;
      transition: transform 0.1s, border-color 0.1s;
    }
    .ctx-color-swatch:hover {
      transform: scale(1.15);
    }
    .ctx-color-swatch.selected {
      border-color: var(--po-text-primary);
      box-shadow: 0 0 0 1.5px var(--po-accent);
    }
    /* "No color" swatch: accent-tinted with a diagonal cut */
    .ctx-color-swatch.none {
      background:
        linear-gradient(135deg, transparent 44%, color-mix(in oklab, var(--po-text-primary) 55%, transparent) 46%, color-mix(in oklab, var(--po-text-primary) 55%, transparent) 54%, transparent 56%),
        var(--po-accent-muted-bg);
    }

    /* ── Pending interaction badge ── */
    .pending-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      font-size: 0.65rem;
      font-weight: 700;
      line-height: 1;
      color: #fff;
      background: linear-gradient(135deg, #f59e0b, #f97316);
      border-radius: 9px;
      box-shadow: 0 0 8px rgba(245, 158, 11, 0.5), 0 0 2px rgba(245, 158, 11, 0.3);
      animation: badge-glow 2s ease-in-out infinite;
      flex-shrink: 0;
    }

    @keyframes badge-glow {
      0%, 100% { box-shadow: 0 0 8px rgba(245, 158, 11, 0.5), 0 0 2px rgba(245, 158, 11, 0.3); }
      50% { box-shadow: 0 0 14px rgba(245, 158, 11, 0.7), 0 0 4px rgba(245, 158, 11, 0.5); }
    }

    /* ── Standby (parked) — minimal UI only ── */
    .standby-icon {
      display: inline-flex;
      align-items: center;
      color: var(--po-text-secondary);
      opacity: 0.85;
    }
    /* Sleeping "zzz" in place of the provider icon: same muted tone as the moon badge */
    .session-item.standby .session-icon {
      color: var(--po-text-secondary);
      opacity: 0.85;
    }
    /* Standby: no opacity on the whole row (the name dropped to ~3:1,
       UX audit 10/2026). The state is conveyed by the moon + the secondary text
       color, which stays ≥ 4.5:1; only the provider icon is dimmed. */
    :host-context([data-po-ui='minimal']) .session-item.standby .session-name {
      color: var(--po-text-secondary, #5b6475);
    }
    :host-context([data-po-ui='minimal']) .session-item.standby .session-icon,
    :host-context([data-po-ui='minimal']) .collapsed-session-icon.standby {
      opacity: 0.6;
      filter: grayscale(0.4);
    }
    :host-context([data-po-ui='minimal']) .session-item.standby:hover,
    :host-context([data-po-ui='minimal']) .collapsed-session-icon.standby:hover {
      opacity: 0.8;
    }
  `,
})
export class SessionSidebarComponent {
  sessions = input.required<SessionSummary[]>();
  workspaces = input<WorkspaceSummary[]>([]);
  activeSessionId = input<string | null>(null);
  collapsed = input<boolean>(false);

  selectSession = output<string>();
  /**
   * Emitted when the user clicks a sub-agent row/icon: the parent opens the
   * sub-agent's parent session and focuses its terminal pane.
   */
  selectSubAgent = output<SubAgent>();
  onCreateSession = output<void>();
  /**
   * Emitted when the user clicks the dedicated "New Workspace" button.
   * Flag-gated by workspaceFirstUI — only rendered when on.
   */
  onCreateWorkspace = output<void>();
  /**
   * Emitted when the user picks "Promote to Workspace" from a standalone
   * session's context menu. Flag-gated by workspaceFirstUI.
   */
  onPromoteSession = output<string>();
  toggleCollapse = output<void>();
  onEditSession = output<string>();
  onDestroySession = output<string>();
  onEditWorkspace = output<string>();
  onDestroyWorkspace = output<string>();
  onConfigureSession = output<string>();
  onOpenTerminal = output<string>();
  // Standby (park to save resources) / Wake — minimal UI only.
  onStandbySession = output<string>();
  onWakeSession = output<string>();
  /** Agents model: reopens the lead (session PTY) closed by the user. */
  onReopenLead = output<string>();
  onStandbyWorkspace = output<string>();
  onWakeWorkspace = output<string>();
  /**
   * Emitted with the absolute path of a folder dragged from the OS file
   * manager onto the sidebar. The parent decides whether to open an existing
   * session/workspace or create a new standalone one. Minimal UI only.
   */
  onDropFolder = output<string>();

  /** Workspace-first UI flag — see environment.ts */
  readonly workspaceFirstUI = !!(environment as any).workspaceFirstUI;

  private subAgentService = inject(SubAgentService);
  /** Agents model (desktop only): roster from the adapter; when off, the classic branch is used. */
  private readonly agentsEnabled = inject(AGENTS_MODEL);
  private agentRoster = inject(AgentRosterService);
  private sessionService = inject(SessionService);
  private apiService = inject(DesktopSessionApiService);
  private interactionService = inject(InteractionService);
  protected ecoService = inject(EcoModeService);
  protected builtins = inject(BuiltinPluginsService);
  private pluginRuntime = inject(PluginRuntimeService);
  private router = inject(Router);
  /** `place: "sidebar"` entries of active plugins, at the top of the list. Desktop app only: empty elsewhere. */
  readonly pluginEntries = computed(() => this.pluginRuntime.sidebarPages());
  protected floorPlan = inject(FloorPlanService);
  private sessionWindows = inject(SessionWindowsService);
  readonly hasTopEntries = computed(() => this.builtins.isOn('floor-plan') || this.pluginEntries().length > 0);

  toggleFloorPlan(): void {
    if (this.floorPlan.mode() === 'full') this.floorPlan.close();
    else this.floorPlan.showFull();
  }

  openPluginEntry(entry: PluginMenuPage): void {
    void this.router.navigate(['/admin/plugin-page', entry.pluginId, entry.pageId]);
  }
  /** Sidebar folders (stored) — minimal UI only. */
  protected foldersService = inject(SidebarFoldersService);
  private uiStyle = inject(UiStyleService);
  private store = inject(Store);
  private translateService = inject(TranslateService);

  /** Per-status glyph in minimal: a distinct shape on top of color. */
  protected statusIcon(status: string): string {
    switch (status) {
      case 'running':
      case 'in_progress': return 'solar:play-circle-bold';
      case 'completed': return 'solar:check-circle-bold';
      case 'error': return 'solar:danger-circle-bold';
      case 'exited': return 'solar:stop-circle-bold';
      default: return 'solar:pause-circle-linear';
    }
  }

  /** True only while the minimal UI is active — gates the standby controls. */
  readonly minimal = computed(() => this.uiStyle.style() === 'minimal');

  /** Feature flag for the session-profile switcher (off when disabled in the environment). */
  readonly profilesEnabled = environment.sessionProfiles;

  // ── Drag a folder onto the sidebar → create a standalone session ──
  /** True while an OS folder is being dragged over the sidebar (minimal only). */
  readonly dragOver = signal(false);

  /** Only react to drags that carry OS files/folders, not internal DnD. */
  private isFileDrag(e: DragEvent): boolean {
    return !!e.dataTransfer?.types?.includes('Files');
  }

  /** Drop handled by appFileDropZone (disabled outside minimal UI). */
  onFolderDrop(e: DragEvent): void {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    // Resolve the absolute path via the desktop bridge. Outside the desktop
    // app the bridge is absent.
    const bridge = (window as { promptops?: { getDroppedPath?: (f: File) => string } }).promptops;
    if (!bridge?.getDroppedPath) return;

    // Only directories create sessions — ignore plain files.
    const entry = e.dataTransfer?.items?.[0]?.webkitGetAsEntry?.();
    if (entry && !entry.isDirectory) return;

    const path = bridge.getDroppedPath(files[0]);
    if (path) this.onDropFolder.emit(path);
  }

  /**
   * Window-level guards: without these, dropping a folder anywhere on the
   * window makes Chromium navigate to the file:// URL (white page / app loss).
   * We only cancel the default for OS file drags so internal HTML5 DnD (tab
   * reorder, which uses text/plain) is unaffected.
   */
  @HostListener('window:dragover', ['$event'])
  onWindowDragOver(e: DragEvent): void {
    if (this.isFileDrag(e)) e.preventDefault();
  }

  @HostListener('window:drop', ['$event'])
  onWindowDrop(e: DragEvent): void {
    if (this.isFileDrag(e)) e.preventDefault();
  }

  // ── Context menu state ──
  /** What was right-clicked, as captured at that moment. */
  private ctxTargetRaw = signal<ContextMenuTarget | null>(null);
  /**
   * The right-clicked item as it is NOW: a session that parks or wakes (or
   * a workspace renamed) while the menu is open shows, and acts on, its
   * current state; one that is gone closes the menu.
   */
  ctxTarget = computed<ContextMenuTarget | null>(() => {
    const raw = this.ctxTargetRaw();
    if (!raw) return null;
    if (raw.type === 'session') {
      const session = this.sessionsById().get(raw.session.id);
      return session ? { type: 'session', session } : null;
    }
    if (raw.type === 'workspace') {
      const workspace = this.workspaces().find(w => w.id === raw.workspace.id);
      return workspace ? { type: 'workspace', workspace } : null;
    }
    return raw;
  });
  ctxPos = signal<{ x: number; y: number }>({ x: 0, y: 0 });

  /** localStorage key for persisting per-workspace expand/collapse state */
  private static readonly WORKSPACE_EXPAND_STORAGE_KEY = 'promptops_workspace_expanded';

  /** Track expanded/collapsed state per workspace (signal so computeds re-run on toggle) */
  private expandedMap = signal<Map<string, boolean>>(this.loadExpandedFromStorage());

  /** Workspaces closed by the auto-collapse (not by the user): the only ones a wake may reopen. */
  private static readonly WORKSPACE_AUTO_COLLAPSED_STORAGE_KEY = 'promptops_workspace_autocollapsed';
  private autoCollapsed = new Set<string>(this.loadAutoCollapsedFromStorage());

  /**
   * Sessions grouped by workspace — deliberately does NOT read expandedMap,
   * so the auto-collapse effect below can write expandedMap without looping.
   */
  private groupedSessions = computed<Omit<WorkspaceGroup, 'expanded'>[]>(() => {
    const wsList = this.workspaces();
    const sessions = this.sessions();
    const assigned = new Set<string>();

    // Immutable workspace keys also keep older servers (updated_at order)
    // from moving groups while their sessions are used or restored.
    return [...wsList]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(ws => ({
        workspace: ws,
        sessions: sessions
          .filter(s => {
            if (assigned.has(s.id)) return false;
            const belongs =
              s.workspaceId === ws.id ||
              (s.workspace?.path && s.workspace.path === ws.projectPath);
            if (belongs) assigned.add(s.id);
            return belongs;
          })
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.name.localeCompare(b.name)),
      }))
      // Workspace positions must not depend on activity in their sessions.
      .filter(g => g.sessions.length > 0);
  });

  /** Sessions grouped by workspace, plus standalone sessions */
  workspaceGroups = computed<WorkspaceGroup[]>(() => {
    const expanded = this.expandedMap();
    return this.groupedSessions().map(g => ({
      ...g,
      expanded: expanded.get(g.workspace.id) ?? true,
    }));
  });

  /** wsId → "every session of the workspace is parked" (empty groups never appear). */
  private wsAllParked = computed<Map<string, boolean>>(() => {
    const m = new Map<string, boolean>();
    for (const g of this.groupedSessions()) {
      m.set(g.workspace.id, g.sessions.every(s => !!s.standbyAt));
    }
    return m;
  });

  /**
   * Previous parked-state per workspace — plain field, not a signal, so the
   * effect below only depends on wsAllParked/minimal and a manual toggle of
   * expandedMap can never be overridden until the workspace transitions again.
   */
  private lastAllParked: Map<string, boolean> | null = null;
  /** Window after startup during which auto-collapse is suspended (lazy restore in standby). */
  private static readonly AUTO_COLLAPSE_BOOT_GRACE_MS = 20_000;
  private readonly createdAt = Date.now();

  /** session / sub-agent id → epoch ms when it entered `waiting_input`. Source of the "how long" timer. */
  private readonly waitingSince = signal<Map<string, number>>(new Map());
  /** Tick (15s) that recomputes the timer labels without touching state. */
  private readonly attentionNow = signal(Date.now());

  constructor() {
    // Attention timer: records WHEN each session/sub-agent entered
    // waiting_input (first observation) and forgets the id as soon as it leaves. Sessions
    // in standby do not count: they are parked, not waiting.
    effect(() => {
      const sessions = this.sessions();
      const subs = this.subAgentService.allSubAgents();
      const prev = untracked(() => this.waitingSince());
      const next = new Map<string, number>();
      const now = Date.now();
      let changed = false;
      const track = (id: string) => {
        if (!prev.has(id)) changed = true;
        next.set(id, prev.get(id) ?? now);
      };
      for (const s of sessions) if (s.status === 'waiting_input' && !s.standbyAt) track(s.id);
      for (const sa of subs) if (sa.status === 'waiting_input') track(this.attentionKey(sa));
      if (changed || next.size !== prev.size) untracked(() => this.waitingSince.set(next));
    });
    const tick = setInterval(() => this.attentionNow.set(Date.now()), 15_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));

    // Auto-collapse a workspace when ALL its sessions go into standby (grace
    // period or manual park) and re-expand it when at least one wakes.
    // Transition-based: acting only on parked-state changes keeps a manual
    // expand/collapse stable afterwards. Minimal UI only — classic is frozen.
    effect(() => {
      const state = this.wsAllParked();
      const minimal = this.minimal();
      const prev = this.lastAllParked;
      this.lastAllParked = state;
      if (!minimal) return;

      const collapse: string[] = [];
      const expand: string[] = [];
      // Boot (restart/update): sessions all go back to lazy standby together —
      // this is not the user parking them, so no collapse: the saved state stays.
      const booting = Date.now() - this.createdAt < SessionSidebarComponent.AUTO_COLLAPSE_BOOT_GRACE_MS;
      for (const [wsId, allParked] of state) {
        const was = prev?.get(wsId);
        // Live transitions only: a workspace that shows up already parked
        // (initial load / late hydration) keeps its persisted state.
        if (allParked && was === false && !booting) collapse.push(wsId);
        else if (!allParked && was === true) expand.push(wsId);
      }
      if (collapse.length === 0 && expand.length === 0) return;

      // A manual choice wins: a wake only reopens what a park closed.
      // Persisted, so coming back to the view or restarting never reopens workspaces.
      untracked(() => {
        const next = applyParkTransitions(
          { expanded: this.expandedMap(), auto: this.autoCollapsed },
          collapse,
          expand,
        );
        if (!next.changed) return;
        this.autoCollapsed = next.auto;
        this.expandedMap.set(next.expanded);
        this.saveExpandedToStorage(next.expanded);
        this.saveAutoCollapsedToStorage(next.auto);
      });
    });
  }

  /** Sessions that don't belong to any workspace */
  standaloneSessions = computed(() => {
    const grouped = new Set<string>();
    for (const g of this.workspaceGroups()) {
      for (const s of g.sessions) {
        grouped.add(s.id);
      }
    }
    return this.sessions()
      .filter(s => !grouped.has(s.id))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || a.name.localeCompare(b.name));
  });

  /**
   * Built-in "Multi-session workspace" plugin off and a single session in the workspace: the sidebar
   * does not repeat the session under the folder, it shows the workspace as a clickable row with the sub-agents
   * below. With more sessions (created while the plugin was on) the normal tree stays.
   */
  soloSession(group: WorkspaceGroup): SessionSummary | null {
    if (this.builtins.isOn('multi-session')) return null;
    return group.sessions.length === 1 ? group.sessions[0] : null;
  }

  toggleWorkspace(wsId: string): void {
    const next = applyManualToggle({ expanded: this.expandedMap(), auto: this.autoCollapsed }, wsId);
    this.autoCollapsed = next.auto;
    this.expandedMap.set(next.expanded);
    this.saveExpandedToStorage(next.expanded);
    this.saveAutoCollapsedToStorage(next.auto);
  }

  isWorkspaceExpanded(wsId: string): boolean {
    return isExpanded(this.expandedMap(), wsId);
  }

  private loadAutoCollapsedFromStorage(): Set<string> {
    try {
      return parseIdSet(localStorage.getItem(SessionSidebarComponent.WORKSPACE_AUTO_COLLAPSED_STORAGE_KEY));
    } catch {
      return new Set();
    }
  }

  private saveAutoCollapsedToStorage(ids: Set<string>): void {
    try {
      localStorage.setItem(SessionSidebarComponent.WORKSPACE_AUTO_COLLAPSED_STORAGE_KEY, JSON.stringify([...ids]));
    } catch {
      /* localStorage may be unavailable (private mode, quota) — fail silently */
    }
  }

  private loadExpandedFromStorage(): Map<string, boolean> {
    try {
      const raw = localStorage.getItem(SessionSidebarComponent.WORKSPACE_EXPAND_STORAGE_KEY);
      if (!raw) return new Map();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return new Map();
      const map = new Map<string, boolean>();
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'boolean') map.set(k, v);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private saveExpandedToStorage(map: Map<string, boolean>): void {
    try {
      const obj: Record<string, boolean> = {};
      for (const [k, v] of map.entries()) obj[k] = v;
      localStorage.setItem(SessionSidebarComponent.WORKSPACE_EXPAND_STORAGE_KEY, JSON.stringify(obj));
    } catch {
      /* localStorage may be unavailable (private mode, quota) — fail silently */
    }
  }

  // ── Sidebar folders (minimal UI only — classic is frozen) ──

  /** localStorage key for persisting per-folder expand/collapse state (device-local). */
  private static readonly FOLDER_EXPAND_STORAGE_KEY = 'promptops_folder_expanded';

  private folderExpandedMap = signal<Map<string, boolean>>(
    this.loadBooleanMapFromStorage(SessionSidebarComponent.FOLDER_EXPAND_STORAGE_KEY),
  );

  /**
   * The folder sections rendered above the flat list. Folders always render,
   * even when empty, so a freshly created one is a usable drop target.
   */
  folderSections = computed<FolderSection[]>(() => {
    if (!this.minimal()) return [];
    const folders = this.foldersService.folders();
    if (folders.length === 0) return [];
    const groups = this.workspaceGroups();
    const standalone = this.standaloneSessions();
    return folders.map((folder) => {
      const wsSet = new Set(folder.workspaceIds);
      const sessionSet = new Set(folder.sessionIds);
      return {
        folder,
        groups: groups.filter((g) => wsSet.has(g.workspace.id)),
        standalone: standalone.filter((s) => !!s.dbId && sessionSet.has(s.dbId)),
      };
    });
  });

  /**
   * Workspace groups not assigned to any folder. In classic (or with zero
   * folders) this IS workspaceGroups() — the pre-feature flat list.
   */
  ungroupedWorkspaceGroups = computed<WorkspaceGroup[]>(() => {
    const all = this.workspaceGroups();
    if (!this.minimal()) return all;
    const map = this.foldersService.workspaceFolderMap();
    if (map.size === 0) return all;
    return all.filter((g) => !map.has(g.workspace.id));
  });

  /** Standalone sessions not assigned to any folder (see ungroupedWorkspaceGroups). */
  ungroupedStandalone = computed<SessionSummary[]>(() => {
    const all = this.standaloneSessions();
    if (!this.minimal()) return all;
    const map = this.foldersService.sessionFolderMap();
    if (map.size === 0) return all;
    return all.filter((s) => !s.dbId || !map.has(s.dbId));
  });

  /** Projects (workspaces + standalone sessions) shown on the folder badge. */
  folderItemCount(fs: FolderSection): number {
    return fs.groups.length + fs.standalone.length;
  }

  toggleFolder(folderId: string): void {
    const current = this.folderExpandedMap();
    const next = new Map(current);
    next.set(folderId, !(current.get(folderId) ?? true));
    this.folderExpandedMap.set(next);
    this.saveBooleanMapToStorage(SessionSidebarComponent.FOLDER_EXPAND_STORAGE_KEY, next);
  }

  isFolderExpanded(folderId: string): boolean {
    return this.folderExpandedMap().get(folderId) ?? true;
  }

  private loadBooleanMapFromStorage(key: string): Map<string, boolean> {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return new Map();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return new Map();
      const map = new Map<string, boolean>();
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'boolean') map.set(k, v);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private saveBooleanMapToStorage(key: string, map: Map<string, boolean>): void {
    try {
      const obj: Record<string, boolean> = {};
      for (const [k, v] of map.entries()) obj[k] = v;
      localStorage.setItem(key, JSON.stringify(obj));
    } catch {
      /* localStorage may be unavailable (private mode, quota) — fail silently */
    }
  }

  // ── Folder inline rename ──

  folderEditingId = signal<string | null>(null);

  startFolderRename(folderId: string): void {
    this.folderEditingId.set(folderId);
    // The input is inserted by @if on the next CD cycle — focus it afterwards.
    setTimeout(() => {
      const el = document.getElementById(`po-folder-edit-${folderId}`) as HTMLInputElement | null;
      el?.focus();
      el?.select();
    });
  }

  commitFolderRename(folderId: string, value: string): void {
    if (this.folderEditingId() !== folderId) return;
    this.folderEditingId.set(null);
    const name = value.trim();
    const current = this.foldersService.folders().find((f) => f.id === folderId);
    if (!name || !current || name === current.name) return;
    void this.foldersService.renameFolder(folderId, name);
  }

  cancelFolderRename(): void {
    this.folderEditingId.set(null);
  }

  // ── Folders drag & drop (native HTML5, text/plain — the window-level OS-file
  //    guards above ignore it by design, same as the tab-reorder DnD) ──

  readonly draggedItem = signal<DraggedSidebarItem | null>(null);
  /** Folder id currently highlighted as drop target, or UNFILE_ZONE. */
  readonly dropTargetFolderId = signal<string | null>(null);
  /** Sentinel drop-target id for the "remove from folder" zone. */
  readonly UNFILE_ZONE = '__unfile__';

  /** True while dragging a workspace/session that currently sits in a folder. */
  readonly draggedItemInFolder = computed<boolean>(() => {
    const d = this.draggedItem();
    if (!d) return false;
    if (d.kind === 'workspace') return this.foldersService.workspaceFolderMap().has(d.id);
    if (d.kind === 'session') return this.foldersService.sessionFolderMap().has(d.id);
    return false;
  });

  onItemDragStart(e: DragEvent, kind: DraggedSidebarItem['kind'], id: string | null | undefined): void {
    // Sessions without a stored dbId (not yet persisted) can't be assigned.
    if (!this.minimal() || !id) {
      e.preventDefault();
      return;
    }
    this.draggedItem.set({ kind, id });
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `po-sidebar-item:${kind}:${id}`);
    }
  }

  onItemDragEnd(): void {
    this.draggedItem.set(null);
    this.dropTargetFolderId.set(null);
  }

  onFolderTargetDragOver(e: DragEvent, folderId: string): void {
    const d = this.draggedItem();
    if (!d) return; // OS file drags keep their own sidebar-level handling
    if (d.kind === 'folder' && d.id === folderId) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    this.dropTargetFolderId.set(folderId);
  }

  onFolderTargetDragLeave(e: DragEvent, folderId: string): void {
    // WKWebView fires dragleave with relatedTarget=null when crossing child
    // elements — clearing there makes the highlight flicker. Only clear on a
    // real exit; dragend/drop reset the state anyway.
    const rt = e.relatedTarget as Node | null;
    if (!rt || (e.currentTarget as HTMLElement).contains(rt)) return;
    if (this.dropTargetFolderId() === folderId) this.dropTargetFolderId.set(null);
  }

  onFolderTargetDrop(e: DragEvent, folderId: string): void {
    const d = this.draggedItem();
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    this.draggedItem.set(null);
    this.dropTargetFolderId.set(null);
    if (d.kind === 'folder') {
      if (d.id !== folderId) void this.moveFolderBefore(d.id, folderId);
      return;
    }
    void this.assignItem(d, folderId);
  }

  onUnfileDragOver(e: DragEvent): void {
    const d = this.draggedItem();
    if (!d || d.kind === 'folder') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    this.dropTargetFolderId.set(this.UNFILE_ZONE);
  }

  onUnfileDrop(e: DragEvent): void {
    const d = this.draggedItem();
    if (!d || d.kind === 'folder') return;
    e.preventDefault();
    e.stopPropagation();
    this.draggedItem.set(null);
    this.dropTargetFolderId.set(null);
    void this.assignItem(d, null);
  }

  private assignItem(d: DraggedSidebarItem, folderId: string | null): Promise<void> {
    return d.kind === 'workspace'
      ? this.foldersService.assignWorkspace(d.id, folderId)
      : this.foldersService.assignSession(d.id, folderId);
  }

  /** Reorder folders so `dragId` takes the position of `targetId`. */
  private moveFolderBefore(dragId: string, targetId: string): Promise<void> {
    const order = this.foldersService.folders().map((f) => f.id);
    const from = order.indexOf(dragId);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return Promise.resolve();
    order.splice(from, 1);
    order.splice(to, 0, dragId);
    return this.foldersService.reorderFolders(order);
  }

  private static readonly PROVIDER_LOGO: Record<string, string> = PROVIDER_LOGO;
  private static readonly PROVIDER_LABEL: Record<string, string> = {
    'claude-code-cli': 'Claude Code',
    'codex': 'Codex',
    'gemini-cli': 'Gemini CLI',
    'antigravity': 'Antigravity',
    'muse': 'Muse Code',
    'copilot': 'GitHub Copilot',
    'cursor': 'Cursor',
    'generic-shell': 'Shell',
  };
  getProviderLogo(provider: string): string {
    return SessionSidebarComponent.PROVIDER_LOGO[provider] ?? 'assets/providers/terminal.svg';
  }
  getProviderLabel(provider: string): string {
    return SessionSidebarComponent.PROVIDER_LABEL[provider] ?? 'Shell';
  }

  // ── Collapsed rail: workspace identity helpers ──

  /** Collapsed rail: a closed folder carries the active-session ring of anything inside it. */
  folderHasActive(fs: FolderSection): boolean {
    const id = this.activeSessionId();
    return !!id && (fs.standalone.some(s => s.id === id) || fs.groups.some(g => g.sessions.some(s => s.id === id)));
  }

  /** Collapsed rail: a closed folder surfaces the attention dot of anything inside it. */
  folderNeedsAttention(fs: FolderSection): boolean {
    return this.folderAttention(fs) !== null;
  }

  /** Whether any session (or sub-agent) in the group is waiting for input (surfaced on the collapsed avatar). */
  groupNeedsAttention(group: WorkspaceGroup): boolean {
    return this.groupAttention(group) !== null;
  }

  // ── Attention timer ────────────────────────────────────────────────────

  /** Stable key for a sub-agent: its session if it has one, otherwise the id. */
  private attentionKey(sa: SubAgent): string {
    return sa.sessionId || sa.id;
  }

  /** Compact label ("<1m", "7m", "2h 05m", "3d 4h") of how long `id` has been waiting for input; null if not waiting. */
  waitingFor(id: string): string | null {
    const since = this.waitingSince().get(id);
    return since == null ? null : this.formatElapsed(this.attentionNow() - since);
  }

  /** Like `waitingFor`, for a sub-agent. */
  subAgentWaitingFor(sa: SubAgent): string | null {
    return this.waitingFor(this.attentionKey(sa));
  }

  /** How many entries are waiting for input inside a workspace (sessions + their sub-agents) and how long the oldest has waited. */
  groupAttention(group: WorkspaceGroup): AttentionInfo | null {
    const ids: string[] = [];
    for (const s of group.sessions) {
      ids.push(s.id);
      for (const sa of this.getSubAgents(s.id)) ids.push(this.attentionKey(sa));
    }
    return this.attentionFor(ids);
  }

  /** Like `groupAttention`, over the whole content of a folder. */
  folderAttention(fs: FolderSection): AttentionInfo | null {
    const ids: string[] = [];
    for (const s of fs.standalone) {
      ids.push(s.id);
      for (const sa of this.getSubAgents(s.id)) ids.push(this.attentionKey(sa));
    }
    for (const g of fs.groups) {
      for (const s of g.sessions) {
        ids.push(s.id);
        for (const sa of this.getSubAgents(s.id)) ids.push(this.attentionKey(sa));
      }
    }
    return this.attentionFor(ids);
  }

  /** Folder/workspace badge text: "3 · 12m" or just "12m" with a single entry. */
  attentionLabel(a: AttentionInfo): string {
    const t = this.formatElapsed(this.attentionNow() - a.since);
    return a.count > 1 ? `${a.count} · ${t}` : t;
  }

  /** Localized tooltip for badges and rail nodes. */
  attentionTooltip(a: AttentionInfo): string {
    return this.translateService.instant('SESSIONS.ATTENTION.Group tooltip', {
      count: a.count,
      time: this.formatElapsed(this.attentionNow() - a.since),
    });
  }

  /** " · ⚠ …" suffix to append to the collapsed rail tooltips; empty string if nothing is waiting. */
  railAttentionSuffix(a: AttentionInfo | null): string {
    return a ? ' · ' + this.attentionTooltip(a) : '';
  }

  private attentionFor(ids: string[]): AttentionInfo | null {
    const map = this.waitingSince();
    let count = 0;
    let since = Infinity;
    for (const id of ids) {
      const t = map.get(id);
      if (t == null) continue;
      count++;
      if (t < since) since = t;
    }
    return count > 0 ? { count, since } : null;
  }

  private formatElapsed(ms: number): string {
    const totalMin = Math.max(0, Math.floor(ms / 60_000));
    if (totalMin < 1) return '<1m';
    if (totalMin < 60) return `${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    if (h < 24) return `${h}h ${String(totalMin % 60).padStart(2, '0')}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }

  /** Whether any session in the group has auto-approve active (surfaced on the collapsed avatar). */
  groupHasAutoApprove(group: WorkspaceGroup): boolean {
    return group.sessions.some(s => this.hasAutoApprove(s.id));
  }

  /** Whether the currently active session belongs to this group. */
  isActiveInGroup(group: WorkspaceGroup): boolean {
    const id = this.activeSessionId();
    return !!id && group.sessions.some(s => s.id === id);
  }

  /**
   * Sub-agents grouped by parent session, rebuilt only when the list changes.
   * The template asks for a session's sub-agents several times per row on
   * every change detection (attention, auto-approve, panes): filtering the
   * whole list each time cost sessions x sub-agents per call.
   */
  private readonly subAgentsByParent = computed(() => {
    const map = new Map<string, SubAgent[]>();
    for (const sa of this.subAgentService.allSubAgents()) {
      const list = map.get(sa.parentSessionId);
      if (list) list.push(sa); else map.set(sa.parentSessionId, [sa]);
    }
    return map;
  });

  private readonly sessionsById = computed(() => new Map(this.sessions().map(s => [s.id, s] as const)));

  getSubAgents(sessionId: string): SubAgent[] {
    return this.subAgentsByParent().get(sessionId) ?? NO_SUB_AGENTS;
  }

  /** Id of the pseudo-entry representing the demoted main (= session-view). */
  static readonly MAIN_PANE_ID = '__main__';

  isMainPane(id: string): boolean {
    return id === SessionSidebarComponent.MAIN_PANE_ID;
  }

  /**
   * Sub-agents of a session, plus the main when it has been demoted.
   *
   * The main appears as the first entry, drawn EXACTLY like the other
   * roster agents (same connector, same indicators): from the first spawn
   * it is a pane like all the others. It disappears if the user closed it.
   */
  getSessionPanes(sessionId: string): SubAgent[] {
    const subs = this.getSubAgents(sessionId);
    if (this.agentsEnabled) {
      // The lead shows up even on its own: a session with an agent at work
      // must list it, not leave the session row with no entries under it.
      this.agentRoster.ensureLoaded(sessionId);
      return this.agentRoster.rosterFor(this.sessionsById().get(sessionId) ?? null, subs, true);
    }
    if (subs.length === 0) return subs;
    const dismissed = readDismissedMains();
    if (dismissed.includes(sessionId)) return subs;
    const session = this.sessionsById().get(sessionId);
    if (!session) return subs;
    const main = {
      id: SessionSidebarComponent.MAIN_PANE_ID,
      role: 'main',
      title: session.name || 'Main',
      parentSessionId: sessionId,
      sessionId,
      // Status passed as is: attention dot on waiting_input and
      // status-<x> classes work the same as for sub-agent entries.
      status: session.status,
      autoPrompt: '',
      provider: session.provider,
      icon: 'solar:monitor-bold',
    } as unknown as SubAgent;
    return [main, ...subs];
  }

  /**
   * Whether a session should show the auto-approve warning indicator in the sidebar.
   * Returns true if the session itself, or ANY of its sub-agents, has auto-approve enabled.
   */
  hasAutoApprove(sessionId: string): boolean {
    if (this.interactionService.isAutoApproved(sessionId)) return true;
    const subs = this.getSubAgents(sessionId);
    for (const sa of subs) {
      if (sa.sessionId && this.interactionService.isAutoApproved(sa.sessionId)) return true;
    }
    return false;
  }

  /** Whether a specific sub-agent has auto-approve enabled. */
  isSubAgentAutoApproved(sa: SubAgent): boolean {
    return !!sa.sessionId && this.interactionService.isAutoApproved(sa.sessionId);
  }

  /** Get the device workspace status for a session. Returns null if no workspace binding exists at all. */
  getDeviceStatus(session: SessionSummary): DeviceWorkspaceStatus | null {
    if (!session.deviceWorkspace) {
      // No device workspace and no legacy workspace_path → no workspace concept
      if (!session.workspace?.path) return null;
      // Has a workspace path but no device_workspace record → not configured on this device
      return 'not_configured';
    }
    return session.deviceWorkspace.status;
  }

  /** Handle click on a sub-agent: open its parent session with the pane focused. */
  onSubAgentClick(sa: SubAgent): void {
    // Main/lead like the other agents: opens the session and focuses its
    // pane. Only a parked session goes through onSessionClick (wake).
    if (this.isMainPane(sa.id)) {
      const session = this.sessions().find(s => s.id === sa.parentSessionId);
      if (session?.standbyAt) {
        void this.onSessionClick(session);
        return;
      }
    }
    this.selectSubAgent.emit(sa);
  }

  /** Handle click on a session: always select it, then prompt to configure if needed. */
  async onSessionClick(session: SessionSummary): Promise<void> {
    // Parked session → wake it (re-spawn the provider) instead of selecting a
    // dead terminal. "Until further notice" = it only wakes on this explicit click.
    if (session.standbyAt) {
      this.onWakeSession.emit(session.id);
      return;
    }

    const dws = this.getDeviceStatus(session);

    // Always select the session first so the terminal opens
    this.selectSession.emit(session.id);

    // If not configured on this device, notify parent to show config modal
    if (dws === 'not_configured') {
      setTimeout(() => this.onConfigureSession.emit(session.id), 400);
    }
  }

  getDeviceStatusTooltip(status: DeviceWorkspaceStatus): string {
    return this.translateService.instant(`SESSIONS.DEVICE_WORKSPACE.Tooltip ${status}`);
  }

  getDeviceStatusIcon(status: DeviceWorkspaceStatus): string {
    switch (status) {
      case 'configured': return 'solar:monitor-bold';
      case 'not_configured': return 'solar:monitor-smartphone-line-duotone';
      case 'invalid_path': return 'solar:danger-triangle-bold';
    }
  }

  // ── Context menu ──

  /** 'main' = regular items; 'move' = the "move to folder" picker (minimal only). */
  ctxView = signal<'main' | 'move'>('main');
  /** Two-click folder delete confirmation (first click arms, second deletes). */
  ctxDeleteArmed = signal(false);

  private ctxMenuEl = viewChild<ElementRef<HTMLElement>>('ctxMenuEl');

  private openCtxMenu(event: MouseEvent, target: ContextMenuTarget): void {
    event.preventDefault();
    event.stopPropagation();
    this.ctxView.set('main');
    this.ctxDeleteArmed.set(false);
    this.ctxTargetRaw.set(target);
    this.ctxPos.set({ x: event.clientX, y: event.clientY });
    this.scheduleCtxClamp();
  }

  /** Re-position after render so the menu never overflows the viewport (its height
   *  varies by target type / view, so measure the real element instead of guessing). */
  private scheduleCtxClamp(): void {
    setTimeout(() => {
      const el = this.ctxMenuEl()?.nativeElement;
      if (!el) return;
      const pad = 8;
      const rect = el.getBoundingClientRect();
      const { x, y } = this.ctxPos();
      const cx = Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad));
      const cy = Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad));
      if (cx !== x || cy !== y) this.ctxPos.set({ x: cx, y: cy });
    });
  }

  onWorkspaceContext(event: MouseEvent, workspace: WorkspaceSummary): void {
    this.openCtxMenu(event, { type: 'workspace', workspace });
  }

  onSessionContext(event: MouseEvent, session: SessionSummary): void {
    this.openCtxMenu(event, { type: 'session', session });
  }

  onFolderContext(event: MouseEvent, folder: SidebarFolder): void {
    if (!this.minimal()) return;
    this.openCtxMenu(event, { type: 'folder', folder });
  }

  closeCtxMenu(): void {
    this.ctxTargetRaw.set(null);
    this.ctxView.set('main');
    this.ctxDeleteArmed.set(false);
  }

  /** Desktop: the session in its child window, without sidebar. */
  readonly canOpenSessionWindow = canDetach();

  /** Session that "Open in a dedicated window" would open: the clicked row, or for a workspace
   *  its active session, otherwise the first one not in standby, otherwise the first one. */
  readonly ctxWindowSession = computed<SessionSummary | null>(() => {
    const target = this.ctxTarget();
    if (target?.type === 'session') return target.session;
    if (target?.type !== 'workspace') return null;
    const sessions = this.workspaceGroups().find((g) => g.workspace.id === target.workspace.id)?.sessions ?? [];
    const active = this.activeSessionId();
    return sessions.find((s) => s.id === active) ?? sessions.find((s) => !s.standbyAt) ?? sessions[0] ?? null;
  });

  ctxOpenSessionWindow(): void {
    const session = this.ctxWindowSession();
    if (session) void this.sessionWindows.open(session);
    this.closeCtxMenu();
  }

  ctxEdit(): void {
    const target = this.ctxTarget();
    if (!target) return;
    if (target.type === 'workspace') {
      this.onEditWorkspace.emit(target.workspace.id);
    } else if (target.type === 'session') {
      this.onEditSession.emit(target.session.id);
    }
    this.closeCtxMenu();
  }

  ctxDestroy(): void {
    const target = this.ctxTarget();
    if (!target) return;
    if (target.type === 'workspace') {
      this.onDestroyWorkspace.emit(target.workspace.id);
    } else if (target.type === 'session') {
      this.onDestroySession.emit(target.session.id);
    }
    this.closeCtxMenu();
  }

  // ── Folder context actions (minimal UI only) ──

  /** Preset palette for folder colors; null = accent default (no explicit color). */
  readonly folderColors: (string | null)[] = [
    null, '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b', '#10b981', '#3b82f6',
  ];

  /** True when the ctx target can be moved into a folder (minimal UI, has a stored id). */
  ctxCanMoveToFolder(): boolean {
    if (!this.minimal()) return false;
    const t = this.ctxTarget();
    if (t?.type === 'workspace') return true;
    if (t?.type === 'session') return !!t.session.dbId;
    return false;
  }

  /** Folder currently containing the ctx target (null = none). */
  ctxCurrentFolderId(): string | null {
    const t = this.ctxTarget();
    if (t?.type === 'workspace') {
      return this.foldersService.workspaceFolderMap().get(t.workspace.id) ?? null;
    }
    if (t?.type === 'session' && t.session.dbId) {
      return this.foldersService.sessionFolderMap().get(t.session.dbId) ?? null;
    }
    return null;
  }

  ctxOpenMoveView(): void {
    this.ctxView.set('move');
    this.scheduleCtxClamp();
  }

  ctxMoveTo(folderId: string | null): void {
    const t = this.ctxTarget();
    this.closeCtxMenu();
    if (t?.type === 'workspace') {
      void this.foldersService.assignWorkspace(t.workspace.id, folderId);
    } else if (t?.type === 'session' && t.session.dbId) {
      void this.foldersService.assignSession(t.session.dbId, folderId);
    }
  }

  /** Create a folder, move the target into it, then open the inline rename. */
  async ctxMoveToNewFolder(): Promise<void> {
    const t = this.ctxTarget();
    this.closeCtxMenu();
    const name = this.translateService.instant('SESSIONS.FOLDERS.Default name');
    const folder = await this.foldersService.createFolder(name);
    if (!folder) return;
    if (t?.type === 'workspace') {
      await this.foldersService.assignWorkspace(t.workspace.id, folder.id);
    } else if (t?.type === 'session' && t.session.dbId) {
      await this.foldersService.assignSession(t.session.dbId, folder.id);
    }
    this.startFolderRename(folder.id);
  }

  /** Narrowing helper for the template's folder-specific ctx branch. */
  ctxFolder(): SidebarFolder | null {
    const t = this.ctxTarget();
    return t?.type === 'folder' ? t.folder : null;
  }

  /** Create an empty folder and open its inline rename (header button + ctx menu). */
  async createFolderInline(): Promise<void> {
    const name = this.translateService.instant('SESSIONS.FOLDERS.Default name');
    const folder = await this.foldersService.createFolder(name);
    if (folder) this.startFolderRename(folder.id);
  }

  ctxCreateFolder(): void {
    this.closeCtxMenu();
    void this.createFolderInline();
  }

  ctxRenameFolder(): void {
    const t = this.ctxTarget();
    this.closeCtxMenu();
    if (t?.type === 'folder') this.startFolderRename(t.folder.id);
  }

  ctxSetFolderColor(color: string | null): void {
    const t = this.ctxTarget();
    this.closeCtxMenu();
    if (t?.type === 'folder') void this.foldersService.setFolderColor(t.folder.id, color);
  }

  /** First click arms the confirmation, second one deletes (contents survive). */
  ctxDeleteFolder(): void {
    const t = this.ctxTarget();
    if (t?.type !== 'folder') return;
    if (!this.ctxDeleteArmed()) {
      this.ctxDeleteArmed.set(true);
      return;
    }
    this.closeCtxMenu();
    void this.foldersService.deleteFolder(t.folder.id);
  }

  // ── Standby (park/wake) context actions — minimal UI only ──

  /** Sessions belonging to a workspace (FK or legacy path match). */
  private workspaceSessions(ws: WorkspaceSummary): SessionSummary[] {
    return this.sessions().filter(
      (s) => s.workspaceId === ws.id || (!!s.workspace?.path && s.workspace.path === ws.projectPath),
    );
  }

  /** True when the context target session is currently parked. */
  ctxIsStandby(): boolean {
    const t = this.ctxTarget();
    return t?.type === 'session' ? !!t.session.standbyAt : false;
  }

  /** True when every session of the target workspace is parked (→ show "Wake all"). */
  ctxWorkspaceAllStandby(): boolean {
    const t = this.ctxTarget();
    if (t?.type !== 'workspace') return false;
    const list = this.workspaceSessions(t.workspace);
    return list.length > 0 && list.every((s) => !!s.standbyAt);
  }

  /**
   * Agents model: the lead (session PTY) was closed by the user. Loads the
   * meta once per session, so the indicator also shows for
   * sessions without sub-agents. Always false outside Tauri.
   */
  isLeadClosed(sessionId: string): boolean {
    if (!this.agentsEnabled) return false;
    this.agentRoster.ensureLoaded(sessionId);
    return this.agentRoster.leadClosed(sessionId);
  }

  /** True when the context target session has its lead closed (agents model). */
  ctxIsLeadClosed(): boolean {
    const t = this.ctxTarget();
    return t?.type === 'session' ? this.isLeadClosed(t.session.id) : false;
  }

  ctxReopenLead(): void {
    const t = this.ctxTarget();
    if (!t || t.type !== 'session') return;
    this.onReopenLead.emit(t.session.id);
    this.closeCtxMenu();
  }

  ctxToggleStandby(): void {
    const t = this.ctxTarget();
    if (!t || t.type !== 'session') return;
    if (t.session.standbyAt) {
      this.onWakeSession.emit(t.session.id);
    } else {
      this.onStandbySession.emit(t.session.id);
    }
    this.closeCtxMenu();
  }

  ctxToggleWorkspaceStandby(): void {
    const t = this.ctxTarget();
    if (!t || t.type !== 'workspace') return;
    if (this.ctxWorkspaceAllStandby()) {
      this.onWakeWorkspace.emit(t.workspace.id);
    } else {
      this.onStandbyWorkspace.emit(t.workspace.id);
    }
    this.closeCtxMenu();
  }

  /**
   * Returns true only when the context menu target is a standalone session,
   * i.e. eligible for the Workspace-first "Promote to Workspace" action.
   * Used by the template to hide the entry for bound sessions and workspaces.
   */
  canPromoteCtxTarget(): boolean {
    if (!this.workspaceFirstUI) return false;
    const target = this.ctxTarget();
    if (!target || target.type !== 'session') return false;
    return !target.session.workspaceId;
  }

  ctxPromote(): void {
    const target = this.ctxTarget();
    if (!target || target.type !== 'session') return;
    this.onPromoteSession.emit(target.session.id);
    this.closeCtxMenu();
  }

  // ── Path-related context menu actions ──

  private getTargetPath(): string | null {
    const target = this.ctxTarget();
    if (!target) return null;
    if (target.type === 'workspace') return target.workspace.projectPath;
    if (target.type === 'session') return target.session.workspace?.path ?? null;
    return null;
  }

  ctxOpenTerminal(): void {
    const p = this.getTargetPath();
    if (p) {
      this.onOpenTerminal.emit(p);
    }
    this.closeCtxMenu();
  }

  ctxCopyPath(): void {
    const p = this.getTargetPath();
    if (p) this.sessionService.clipboardWrite(p);
    this.closeCtxMenu();
  }

  ctxCopyRelativePath(): void {
    const p = this.getTargetPath();
    if (p) {
      this.sessionService.clipboardWrite(homeRelativePath(p));
    }
    this.closeCtxMenu();
  }

  ctxRevealInFinder(): void {
    const p = this.getTargetPath();
    if (p) {
      this.sessionService.showInFolder(p)
        .then((r) => { if (!r.ok) console.warn('[reveal-in-finder] failed:', r.error, p); })
        .catch((err) => console.warn('[reveal-in-finder] error:', err, p));
    }
    this.closeCtxMenu();
  }
}
