import { Component, CUSTOM_ELEMENTS_SCHEMA, ElementRef, inject, input, output, signal, computed, effect, viewChild, OnDestroy, ChangeDetectionStrategy } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { SessionSummary } from '../../../../../store/sessions/session.state';
import { ClaudeHookService } from '../services/claude-hook.service';
import { SessionService } from '../services/session.service';
import { SmartActionService } from '../services/smart-action.service';
import { DevLinksService } from '@core/services/dev-links.service';
import { FeatureFlagService } from '@core/services/feature-flag.service';
import { UiStyleService } from '@core/services/ui-style.service';
import { TooltipDirective } from '../../../../common/tooltip.directive';
import { EscCloseDirective } from '../../../../common/esc-close.directive';
import { User } from '@core/models/user';
import { ProviderAccountSwitcherComponent } from '../../provider-accounts/switcher/provider-account-switcher.component';
import { ProviderId } from '../../provider-accounts/services/provider-accounts.service';


import { PluginSessionButtonsComponent } from '../../plugins/plugin-session-buttons.component';
import { PluginRuntimeService } from '../../plugins/plugin-runtime.service';
import { BuiltinPluginsService } from '../../plugins/builtin-plugins.service';
import { canDetach } from '@/app/detached/detached-window';
/** Path → segments, separator-agnostic (POSIX, Windows, \\wsl.localhost). */
function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

@Component({
  selector: 'app-session-header',
  standalone: true,
  imports: [PluginSessionButtonsComponent, TranslateModule, TooltipDirective, EscCloseDirective, ProviderAccountSwitcherComponent],
  templateUrl: './session-header.component.html',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .session-header-bar {
      display: flex;
      flex-direction: column;
      background: var(--po-bg-2);
      border-bottom: 1px solid var(--po-border-subtle);
    }

    /* ── Device workspace banners ── */
    .device-banner {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4rem 1rem;
      font-size: 0.78rem;
    }
    .device-banner span { flex: 1; }
    .device-banner-warning {
      background: var(--po-warning-bg);
      color: var(--po-warning);
      border-bottom: 1px solid rgba(210, 153, 34, 0.15);
    }
    .device-banner-error {
      background: var(--po-error-bg);
      color: var(--po-error);
      border-bottom: 1px solid rgba(248, 81, 73, 0.15);
    }

    /* ── Row 1: provider + path + status + actions ── */
    .header-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.5rem 1rem;
    }

    .header-title-group {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0;
      flex: 1;
    }

    .workspace-info-col {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
      min-width: 0;
      flex: 1;
    }

    .workspace-path {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.78rem;
      color: var(--po-text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .crumb-icon { flex-shrink: 0; color: var(--po-text-tertiary, var(--po-text-secondary)); }
    .crumb {
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      flex-shrink: 1;
    }
    .crumb-current {
      color: var(--po-text-primary);
      font-weight: 600;
      flex-shrink: 0;
      max-width: 60%;
    }
    .crumb-sep { flex-shrink: 0; opacity: 0.55; }
    .crumb-btn {
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
      padding: 1px 4px;
      margin: 0 -4px;
      border-radius: 5px;
      cursor: pointer;
      white-space: nowrap;
    }
    .crumb-btn:hover, .crumb-btn.open {
      background: color-mix(in oklab, var(--po-text-secondary) 14%, transparent);
      color: var(--po-text-primary);
    }

    /* ── Breadcrumb navigator popover ── */
    .crumb-nav-backdrop { position: fixed; inset: 0; z-index: 1090; }
    .crumb-nav {
      position: fixed;
      z-index: 1091;
      width: 520px;
      max-width: calc(100vw - 16px);
      display: flex;
      flex-direction: column;
      background: var(--po-bg-2);
      color: var(--po-text-primary);
      border: 1px solid color-mix(in oklab, var(--po-text-secondary) 22%, transparent);
      border-radius: 10px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
      outline: none;
      overflow: hidden;
    }
    .crumb-nav-cols { display: flex; min-height: 0; max-height: 320px; }
    .crumb-nav-col { flex: 1; min-width: 0; overflow-y: auto; padding: 6px; }
    .crumb-nav-folders { border-inline-end: 1px solid color-mix(in oklab, var(--po-text-secondary) 16%, transparent); }
    .crumb-nav-label {
      padding: 4px 8px 6px;
      font-size: 0.66rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--po-text-secondary);
    }
    .crumb-nav-item {
      display: flex;
      align-items: center;
      gap: 7px;
      width: 100%;
      padding: 6px 8px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--po-text-primary);
      font-size: 0.8rem;
      text-align: start;
      cursor: pointer;
    }
    .crumb-nav-item iconify-icon { flex-shrink: 0; color: var(--po-accent); }
    .crumb-nav-item:hover { background: color-mix(in oklab, var(--po-text-secondary) 10%, transparent); }
    .crumb-nav-item.selected {
      background: var(--po-accent-muted-bg);
      box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--po-accent) 40%, transparent);
    }
    .crumb-nav-item.current .crumb-nav-name { color: var(--po-text-secondary); }
    .crumb-nav-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .crumb-nav-sub, .crumb-nav-count, .crumb-nav-here {
      flex-shrink: 0;
      font-size: 0.68rem;
      color: var(--po-text-secondary);
    }
    .crumb-nav-sub { max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .crumb-nav-here {
      padding: 0 5px;
      border-radius: 4px;
      background: color-mix(in oklab, var(--po-text-secondary) 14%, transparent);
    }
    .crumb-nav-status {
      flex-shrink: 0;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--po-text-secondary);
    }
    .crumb-nav-status.dot-running, .crumb-nav-status.dot-in_progress { background: var(--po-success, #22c55e); }
    .crumb-nav-status.dot-waiting_input { background: var(--po-warning); }
    .crumb-nav-empty { padding: 10px 8px; font-size: 0.78rem; color: var(--po-text-secondary); }
    .crumb-nav-footer {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-top: 1px solid color-mix(in oklab, var(--po-text-secondary) 16%, transparent);
    }
    .crumb-nav-path {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: rtl;
      text-align: left;
      font-size: 0.7rem;
      color: var(--po-text-secondary);
    }
    .crumb-nav-go {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 5px 14px;
      border: none;
      border-radius: 7px;
      background: var(--po-accent);
      color: #fff;
      font-size: 0.78rem;
      font-weight: 600;
      cursor: pointer;
    }
    .crumb-nav-go:disabled { opacity: 0.4; cursor: default; }

    .session-name {
      font-weight: 600;
      font-size: 0.95rem;
      margin: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-inline {
      display: flex;
      align-items: center;
      gap: 0.3rem;
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .dot-idle { background: var(--po-text-secondary); }
    .dot-running { background: var(--po-success); box-shadow: 0 0 4px rgba(63, 185, 80, 0.5); }
    .dot-in_progress { background: #8b5cf6; box-shadow: 0 0 4px rgba(139, 92, 246, 0.5); animation: po-inprogress-pulse 1.6s ease-in-out infinite; }
    @keyframes po-inprogress-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
    .dot-waiting_input { background: var(--po-warning); box-shadow: 0 0 4px rgba(210, 153, 34, 0.5); }
    .dot-completed { background: var(--po-info); }
    .dot-error { background: var(--po-error); box-shadow: 0 0 4px rgba(248, 81, 73, 0.5); }
    .dot-exited, .dot-standby { background: transparent; border: 1.5px solid var(--po-text-secondary); }

    .status-label {
      font-size: 0.62rem;
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.04em;
      flex-shrink: 0;
    }
    .label-idle { color: var(--po-text-secondary); }
    .label-running { color: var(--po-success); }
    .label-in_progress { color: #8b5cf6; }
    .label-waiting_input { color: var(--po-warning); }
    .label-completed { color: var(--po-info); }
    .label-error { color: var(--po-error); }
    .label-exited, .label-standby { color: var(--po-text-secondary); }

    .meta-tag-team {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-size: 0.65rem;
      padding: 1px 6px;
      border-radius: 999px;
      background: var(--po-accent-muted-bg);
      color: var(--po-accent);
      flex-shrink: 0;
    }

    .context-snapshot-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 5px;
      flex-shrink: 0;
      transition: background var(--po-duration-base), color var(--po-duration-base);
    }
    .csb-basic_ready, .csb-advanced_ready {
      background: var(--po-accent-muted-bg);
      color: var(--po-accent);
    }
    .csb-scanning {
      background: rgba(251, 191, 36, 0.1);
      color: #fbbf24;
      animation: csb-spin 1s linear infinite;
    }
    .csb-error {
      background: var(--po-error-bg);
      color: var(--po-error);
    }
    @keyframes csb-spin {
      to { transform: rotate(360deg); }
    }

    /* ── Layout Mode Toggle (lives in tabs row) ── */
    .tabs-spacer {
      flex: 1;
      min-width: 8px;
    }

    .focus-toggle-btn {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      height: 26px;
      padding: 0 0.5rem;
      border: 1px solid rgba(139, 92, 246, 0.2);
      border-radius: 6px;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: all var(--po-duration-fast);
      margin-inline-end: 4px;
      flex-shrink: 0;
      font-size: 0.7rem;
      font-weight: 500;
      white-space: nowrap;
    }
    .focus-toggle-btn:hover {
      background: rgba(139, 92, 246, 0.12);
      border-color: rgba(139, 92, 246, 0.4);
      color: var(--po-accent);
    }
    .focus-toggle-btn.active {
      background: rgba(139, 92, 246, 0.2);
      border-color: rgba(139, 92, 246, 0.5);
      color: var(--po-accent);
      box-shadow: 0 0 8px rgba(139, 92, 246, 0.25);
    }
    .focus-label {
      font-size: 0.7rem;
      font-weight: 600;
      background: linear-gradient(135deg, #8391a2, #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .focus-toggle-btn.active .focus-label {
      background: linear-gradient(135deg, #c4b5fd, #818cf8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .focus-kbd {
      font-size: 0.58rem;
      font-family: inherit;
      padding: 1px 4px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: inherit;
      opacity: 0.6;
      line-height: 1.2;
    }

    /* ── Intent Button ── */
    .intent-toggle-btn {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      height: 26px;
      padding: 0 0.5rem;
      border: 1px solid rgba(251, 191, 36, 0.2);
      border-radius: 6px;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: all var(--po-duration-fast);
      margin-inline-end: 4px;
      flex-shrink: 0;
      font-size: 0.7rem;
      font-weight: 500;
      white-space: nowrap;
    }
    .intent-toggle-btn:hover {
      background: rgba(251, 191, 36, 0.1);
      border-color: rgba(251, 191, 36, 0.4);
      color: #fbbf24;
    }
    .intent-label {
      font-size: 0.7rem;
      font-weight: 600;
      background: linear-gradient(135deg, #fbbf24, #f59e0b);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .intent-new {
      font-size: 0.5rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      padding: 1px 4px;
      border-radius: 3px;
      background: var(--po-success-bg);
      color: var(--po-success);
      line-height: 1.2;
    }

    /* ── Terminals Button (takes Intent's slot) ── */
    .terminals-toggle-btn {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      height: 26px;
      padding: 0 0.5rem;
      border: 1px solid rgba(57, 197, 207, 0.25);
      border-radius: 6px;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: all var(--po-duration-fast);
      margin-inline-end: 4px;
      flex-shrink: 0;
      font-size: 0.7rem;
      font-weight: 500;
      white-space: nowrap;
    }
    .dedicated-window-btn {
      display: inline-grid;
      place-items: center;
      width: 28px;
      height: 26px;
      margin-inline-end: 4px;
      border: 1px solid var(--po-border-subtle);
      border-radius: 6px;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: all var(--po-duration-fast);
    }
    .dedicated-window-btn:hover {
      background: var(--po-accent-muted-bg);
      border-color: var(--po-accent);
      color: var(--po-accent);
    }
    .terminals-toggle-btn:hover {
      background: rgba(57, 197, 207, 0.12);
      border-color: rgba(57, 197, 207, 0.45);
      color: #39c5cf;
    }
    .terminals-label {
      font-size: 0.7rem;
      font-weight: 600;
      background: linear-gradient(135deg, #39c5cf, #4cc9d4);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    /* ── Actions ── */
    .header-actions {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      flex-shrink: 0;
    }

    .action-divider {
      width: 1px;
      height: 20px;
      background: var(--po-border-subtle);
      margin: 0 0.25rem;
    }

    .icon-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      background: transparent;
      color: var(--po-text-secondary);
      border-radius: 6px;
      cursor: pointer;
      transition: background var(--po-duration-fast), color var(--po-duration-fast);
    }
    .icon-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--po-text-primary);
    }
    .icon-btn-danger:hover {
      background: var(--po-error-bg);
      color: var(--po-error);
    }

    .auto-nav-toggle {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      font-size: 0.72rem;
      color: var(--po-text-secondary);
      cursor: pointer;
      user-select: none;
      padding: 0.2rem 0.5rem;
      border-radius: 6px;
      transition: background var(--po-duration-fast);
    }
    .auto-nav-toggle:hover {
      background: rgba(255, 255, 255, 0.05);
    }

    .toggle-switch {
      position: relative;
      width: 32px;
      height: 18px;
      background: var(--po-bg-2);
      border-radius: 9px;
      transition: background var(--po-duration-base);
      flex-shrink: 0;
    }
    .toggle-switch.active {
      background: var(--po-accent);
    }
    .toggle-switch::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #fff;
      transition: transform var(--po-duration-base);
    }
    .toggle-switch.active::after {
      transform: translateX(14px);
    }

    /* ── Row 2: Session tabs ── */
    .header-tabs-row {
      display: flex;
      align-items: center;
      padding: 0 0.75rem;
      gap: 1px;
      border-top: 1px solid rgba(255, 255, 255, 0.04);
      min-height: 34px;
    }

    .header-tabs-scroll {
      display: flex;
      align-items: center;
      gap: 1px;
      overflow-x: auto;
      scrollbar-width: none;
      min-width: 0;
    }
    .header-tabs-scroll::-webkit-scrollbar { display: none; }

    .session-tab {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0 0.6rem;
      height: 32px;
      cursor: pointer;
      white-space: nowrap;
      font-size: 0.78rem;
      font-weight: 500;
      color: var(--po-text-secondary);
      background: transparent;
      border-bottom: 2px solid transparent;
      transition: background var(--po-duration-instant), color var(--po-duration-instant);
      flex-shrink: 0;
      max-width: 200px;
      user-select: none;
    }
    .session-tab:hover {
      color: var(--po-text-primary);
      background: rgba(255, 255, 255, 0.03);
    }
    .session-tab.active {
      color: var(--po-text-primary);
      border-bottom-color: var(--po-accent);
    }

    .tab-label {
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    .tab-status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .tab-attention-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--po-warning);
      flex-shrink: 0;
      animation: tab-pulse 1s ease-in-out infinite;
      box-shadow: 0 0 4px var(--po-warning);
    }

    @keyframes tab-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    .tab-close {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border: none;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
      border-radius: 3px;
      opacity: 0;
      transition: opacity var(--po-duration-instant), background var(--po-duration-instant);
      flex-shrink: 0;
    }
    .session-tab:hover .tab-close,
    .session-tab.active .tab-close {
      opacity: 1;
    }
    .tab-close:hover {
      background: var(--po-error-bg);
      color: var(--po-error);
    }

    .session-tab.dragging {
      opacity: 0.4;
    }
    .session-tab.drag-over-left {
      box-shadow: inset 3px 0 0 var(--po-accent);
    }
    .session-tab.drag-over-right {
      box-shadow: inset -3px 0 0 var(--po-accent);
    }

    .tab-add-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border: none;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
      border-radius: 4px;
      flex-shrink: 0;
      transition: background var(--po-duration-instant), color var(--po-duration-instant);
      margin-inline-start: 0.25rem;
    }
    .tab-add-btn:hover {
      background: var(--po-accent-muted-bg);
      color: var(--po-accent);
    }

    /* ── Context menu ── */
    .tab-context-backdrop {
      position: fixed;
      inset: 0;
      z-index: 999;
    }

    .tab-context-menu {
      position: fixed;
      z-index: 1000;
      min-width: 160px;
      background: var(--po-bg-2);
      border: 1px solid var(--po-border-subtle);
      border-radius: 8px;
      padding: 0.3rem;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    }

    .ctx-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      padding: 0.4rem 0.6rem;
      border: none;
      background: transparent;
      color: var(--po-text-primary);
      font-size: 0.8rem;
      border-radius: 5px;
      cursor: pointer;
      transition: background 0.1s;
    }
    .ctx-item:hover {
      background: rgba(255, 255, 255, 0.08);
    }
    .ctx-item-danger:hover {
      background: var(--po-error-bg);
      color: var(--po-error);
    }

    /* ── Git badge & panel ── */
    .db-badge {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.2rem 0.5rem;
      border-radius: 6px;
      border: 1px solid rgba(240, 136, 62, 0.25);
      background: transparent;
      color: #f0883e;
      font-size: 0.72rem;
      font-weight: 600;
      cursor: pointer;
      transition: all var(--po-duration-fast);
    }
    .db-badge:hover {
      background: rgba(240, 136, 62, 0.1);
      border-color: rgba(240, 136, 62, 0.4);
    }

    .docker-badge {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.2rem 0.5rem;
      border-radius: 6px;
      border: 1px solid rgba(36, 150, 237, 0.25);
      background: transparent;
      color: #2496ed;
      font-size: 0.72rem;
      font-weight: 600;
      cursor: pointer;
      transition: all var(--po-duration-fast);
    }
    .docker-badge:hover {
      background: rgba(36, 150, 237, 0.1);
      border-color: rgba(36, 150, 237, 0.4);
    }

    .editor-badge {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.2rem 0.5rem;
      border-radius: 6px;
      border: 1px solid rgba(56, 189, 248, 0.25);
      background: transparent;
      color: #38bdf8;
      font-size: 0.72rem;
      font-weight: 600;
      cursor: pointer;
      transition: all var(--po-duration-fast);
    }
    .editor-badge:hover {
      background: rgba(56, 189, 248, 0.1);
      border-color: rgba(56, 189, 248, 0.4);
    }
    /* Dev-links launcher (Row 2, left of the layout toggle) — indigo accent. */
    .dev-links-toggle-btn {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      height: 26px;
      padding: 0 0.5rem;
      border: 1px solid var(--po-border-subtle);
      border-radius: 6px;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: all var(--po-duration-fast);
      margin-inline-end: 4px;
      flex-shrink: 0;
      font-size: 0.7rem;
      font-weight: 500;
      white-space: nowrap;
    }
    .dev-links-toggle-btn:hover {
      background: rgba(255, 255, 255, 0.06);
      color: var(--po-text-primary, var(--po-text-secondary));
    }
    .dev-links-label {
      font-size: 0.7rem;
      font-weight: 600;
    }
    .dev-links-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 15px;
      height: 15px;
      padding: 0 0.25rem;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.1);
      color: inherit;
      font-size: 0.62rem;
      font-weight: 700;
      line-height: 1;
    }
    /* Multi-editor picker. Avoid a transparent native select: WebKit may keep
       its popup detached from the control and fail to emit repeat selections. */
    .editor-picker {
      position: relative;
      display: inline-flex;
    }
    .editor-picker .editor-caret {
      color: #38bdf8;
      opacity: 0.7;
      flex-shrink: 0;
    }
    .editor-menu-backdrop {
      position: fixed;
      inset: 0;
      z-index: 999;
    }
    .editor-menu {
      position: absolute;
      top: calc(100% + 6px);
      inset-inline-end: 0;
      z-index: 1000;
      min-width: 160px;
      padding: 0.3rem;
      background: var(--po-bg-2);
      border: 1px solid var(--po-border-subtle);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    }
    .editor-menu-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      padding: 0.45rem 0.55rem;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: var(--po-text-primary);
      font-size: 0.78rem;
      text-align: start;
      cursor: pointer;
      transition: background var(--po-duration-fast);
    }
    .editor-menu-item:hover,
    .editor-menu-item:focus-visible {
      background: rgba(255, 255, 255, 0.06);
      outline: none;
    }

    .history-badge {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.2rem 0.5rem;
      border-radius: 6px;
      border: 1px solid rgba(188, 140, 255, 0.25);
      background: transparent;
      color: #bc8cff;
      font-size: 0.72rem;
      font-weight: 600;
      cursor: pointer;
      transition: all var(--po-duration-fast);
    }
    .history-badge:hover {
      background: rgba(188, 140, 255, 0.1);
      border-color: rgba(188, 140, 255, 0.4);
    }

    .git-counts-inline {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      margin-inline-start: 0.15rem;
    }

    /* ── Toolbar settings (independent arrow) ── */
    .toolbar-settings {
      position: relative;
      display: inline-flex;
      align-items: center;
      margin-inline-end: 0.15rem;
    }
    .toolbar-settings-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 1px solid var(--po-border-subtle);
      border-radius: 5px;
      background: transparent;
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: all var(--po-duration-fast);
    }
    .toolbar-settings-btn:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.15);
      color: var(--po-text-primary);
    }

    .tools-menu-backdrop {
      position: fixed;
      inset: 0;
      z-index: 999;
    }
    .tools-menu {
      position: absolute;
      top: calc(100% + 6px);
      inset-inline-start: 0;
      z-index: 1000;
      min-width: 220px;
      background: var(--po-bg-2);
      border: 1px solid var(--po-border-subtle);
      border-radius: 8px;
      padding: 0.4rem;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    }
    .tools-menu-title {
      padding: 0.3rem 0.5rem 0.35rem;
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--po-text-secondary);
      font-weight: 600;
    }
    .tools-menu-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      padding: 0.45rem 0.55rem;
      border: none;
      background: transparent;
      color: var(--po-text-primary);
      font-size: 0.78rem;
      border-radius: 5px;
      cursor: pointer;
      transition: background var(--po-duration-fast);
      text-align: start;
    }
    .tools-menu-item:hover {
      background: rgba(255, 255, 255, 0.06);
    }

    /* ── Compact mode: icons only for all badges; git keeps its counts visible ── */
    .header-actions.tools-compact .history-badge:not(.git-badge),
    .header-actions.tools-compact .db-badge,
    .header-actions.tools-compact .docker-badge,
    .header-actions.tools-compact .editor-badge,
    .header-actions.tools-compact .git-badge {
      padding: 0.2rem 0.35rem;
      font-size: 0;
      gap: 0;
      min-width: 0;
    }
    .header-actions.tools-compact .history-badge:not(.git-badge) iconify-icon,
    .header-actions.tools-compact .db-badge iconify-icon,
    .header-actions.tools-compact .docker-badge iconify-icon,
    .header-actions.tools-compact .editor-badge iconify-icon,
    .header-actions.tools-compact .git-badge iconify-icon {
      font-size: initial;
    }
    /* .git-counts-inline stays visible (its .gc children carry their own font-size) */

    .team-badge { border-color: rgba(79,65,250,0.3) !important; color: #8b83ff !important; position: relative; }
    .team-badge-dot { width: 6px; height: 6px; border-radius: 50%; background: #3fb950; flex: none; }
    .header-actions.tools-compact .team-badge-dot { position: absolute; top: 2px; inset-inline-end: 2px; }

    .gc {
      display: inline-flex;
      align-items: center;
      gap: 1px;
      font-size: 0.6rem;
      font-weight: 700;
    }
    .gc-modified { color: var(--po-warning); }
    .gc-added { color: var(--po-success); }
    .gc-deleted { color: var(--po-error); }

    /* ── Responsive: compact header ── */

    /* Step 1: ≤1250px — hide text labels, keep icons only */
    @media (max-width: 1250px) {
      .header-top {
        gap: 0.4rem;
        padding: 0.4rem 0.75rem;
      }

      .header-actions {
        gap: 0.2rem;
      }

      /* Hide text labels on action badges, keep only icons */
      .history-badge,
      .db-badge,
      .docker-badge,
      .editor-badge {
        padding: 0.2rem 0.35rem;
        font-size: 0;
        gap: 0;
        min-width: 0;
      }
      .history-badge iconify-icon,
      .db-badge iconify-icon,
      .docker-badge iconify-icon,
      .editor-badge iconify-icon {
        font-size: initial;
      }

      .focus-label, .focus-kbd {
        display: none;
      }
      .focus-toggle-btn {
        padding: 0 0.35rem;
        gap: 0;
      }

      .auto-nav-toggle span {
        display: none;
      }
      .auto-nav-toggle {
        padding: 0.2rem 0.3rem;
        gap: 0;
      }

      .action-divider {
        margin: 0 0.1rem;
      }

    }

    /* Step 2: ≤1000px — hide more metadata */
    @media (max-width: 1000px) {
      .header-top {
        gap: 0.35rem;
        padding: 0.35rem 0.6rem;
      }

      .header-title-group {
        gap: 0.35rem;
      }

      .workspace-path {
        font-size: 0.72rem;
      }

      .status-inline {
        display: none;
      }

      .meta-tag-team {
        display: none;
      }

    }

    /* Step 3: ≤750px — wrap header rows */
    @media (max-width: 750px) {
      .header-top {
        flex-wrap: wrap;
        gap: 0.3rem;
        padding: 0.3rem 0.5rem;
      }

      .header-title-group {
        flex: 1 1 100%;
        min-width: 0;
      }

      .header-actions {
        flex: 1 1 100%;
        justify-content: flex-end;
        gap: 0.15rem;
      }

      .workspace-path {
        font-size: 0.7rem;
      }

      .icon-btn {
        width: 24px;
        height: 24px;
      }

      .toggle-switch {
        width: 28px;
        height: 16px;
      }
      .toggle-switch::after {
        width: 12px;
        height: 12px;
      }
      .toggle-switch.active::after {
        transform: translateX(12px);
      }

      .header-tabs-row {
        padding: 0 0.4rem;
        min-height: 30px;
      }

      .session-tab {
        padding: 0 0.4rem;
        height: 28px;
        font-size: 0.72rem;
        max-width: 140px;
      }
    }
  `,
})
export class SessionHeaderComponent implements OnDestroy {
  protected hookService = inject(ClaudeHookService);
  protected sessionService = inject(SessionService);
  private devLinksService = inject(DevLinksService);
  private smartActionService = inject(SmartActionService);
  protected ff = inject(FeatureFlagService);
  private readonly uiStyleService = inject(UiStyleService);
  protected readonly uiStyle = this.uiStyleService.style;

  /** Platform-aware modifier key label */
  readonly modKey = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘⌥' : 'Alt';

  session = input<SessionSummary | null>(null);
  protected pluginRuntime = inject(PluginRuntimeService);
  protected builtins = inject(BuiltinPluginsService);
  protected pluginWorkspaceName = computed(() => (this.session()?.workspace?.path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '');
  /** All sessions in the same workspace (tabs). Falls back to [session] if standalone. */
  tabSessions = input<SessionSummary[]>([]);
  activeSessionId = input<string | null>(null);
  /** Built-in plugin "Multi-session workspace": off = a single session per workspace, the tab bar disappears entirely. */
  multiSession = computed(() => this.builtins.isOn('multi-session'));

  private tabsScroll = viewChild<ElementRef<HTMLElement>>('tabsScroll');

  onAddNote = output<void>();
  onProjectBrief = output<void>();
  onAddTab = output<void>();
  onSelectTab = output<string>();
  onCloseTab = output<string>();
  onRenameTab = output<{ sessionId: string; name: string }>();
  onReorderTabs = output<string[]>();
  onOpenDatabase = output<void>();
  onOpenDocker = output<void>();
  onOpenGitExplorer = output<void>();
  onOpenTeamBoard = output<void>();
  onOpenSsh = output<void>();
  onOpenTerminals = output<void>();
  /** Open the session in its dedicated window, or (inside that window) go back to the main one. */
  onDedicatedWindow = output<void>();
  /** This view is the session's dedicated window. */
  dedicatedWindow = input(false);
  readonly canDetach = canDetach();
  onToggleFocusMode = output<void>();
  onOpenIntent = output<void>();
  onSetupWorkspace = output<string>();
  onDevLinks = output<void>();
  focusMode = input<boolean>(false);
  /** false = the Focus toggle lives in the sub-agent bar (next to AUTO/split/tabs) */
  showFocusToggle = input<boolean>(true);

  // User (for PRO badge)
  user = signal<User | null>(null);

  // Available editors
  availableEditors = signal<Array<{ id: string; name: string; command: string; icon: string }>>([]);
  editorMenuOpen = signal(false);

  // Dev links launcher — icon reflects the user's default browser,
  // count is filled by a silent background scan (see effect below).
  browserIcon = signal('solar:global-linear');
  devLinksCount = signal(0);

  // Git state
  gitBranch = signal('');
  gitCounts = signal<{ modified: number; added: number; deleted: number; total: number }>({ modified: 0, added: 0, deleted: 0, total: 0 });

  // Drag & drop state
  dragTabId = signal<string | null>(null);
  dragOverTabId = signal<string | null>(null);

  // Context menu state
  contextMenuTab = signal<SessionSummary | null>(null);
  contextMenuPos = signal<{ x: number; y: number }>({ x: 0, y: 0 });

  // Context snapshot status
  snapshotStatus = signal<string>('idle');

  // Tools view settings — default compact (icons only)
  compactTools = signal<boolean>(typeof localStorage !== 'undefined' ? localStorage.getItem('session-tools-compact') !== 'false' : true);
  toolsMenuOpen = signal<boolean>(false);

  toggleToolsMenu(ev?: Event): void {
    ev?.stopPropagation();
    this.toolsMenuOpen.update(v => !v);
  }

  closeToolsMenu(): void {
    this.toolsMenuOpen.set(false);
  }

  toggleCompactTools(): void {
    const next = !this.compactTools();
    this.compactTools.set(next);
    try { localStorage.setItem('session-tools-compact', next ? 'true' : 'false'); } catch {}
  }



  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private snapshotCompleteUnsub?: () => void;

  // Derived path: only changes when the actual workspace path changes,
  // not on every session object reference update (status/interaction ticks).
  private workspacePath = computed(() => {
    const s = this.session();
    return s?.workspace?.path || s?.deviceWorkspace?.localPath || null;
  });

  constructor() {
    this.user.set(JSON.parse(localStorage.getItem('user')!));

    effect(() => {
      const wsPath = this.workspacePath();
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }
      this.gitBranch.set('');
      this.gitCounts.set({ modified: 0, added: 0, deleted: 0, total: 0 });
      if (wsPath && this.sessionService.isDesktop) {
        this.loadGitStatus(wsPath);
        this.pollInterval = setInterval(() => this.loadGitStatus(wsPath), 10000);

        // Load snapshot status
        this.sessionService.getContextSnapshotStatus(wsPath).then((result) => {
          this.snapshotStatus.set(result.status);
        }).catch(() => {});

        // Auto-scan folders for command mapping at session init. Skipped in
        // Windows "Safe terminal" mode (the fs walk is more of our background
        // work to rule out). Flag only ever true on Windows.
        if (!(window as any).__PO_SAFE_TERMINAL__) {
          this.smartActionService.scanFolders(wsPath).catch(() => {});
          // Silent dev-links prefetch — same idea as the command scan: warms
          // the (TTL-cached, lightweight) scan so the modal opens populated.
          this.prefetchDevLinks(wsPath);
        }
      }
    });

    // Keep the active tab visible inside the scrollable strip.
    effect(() => {
      this.activeSessionId();
      this.tabSessions();
      setTimeout(() => {
        const el = this.tabsScroll()?.nativeElement;
        el?.querySelector('.session-tab.active')
          ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      });
    });

    // Listen for background snapshot completion
    if (this.sessionService.isDesktop) {
      this.snapshotCompleteUnsub = this.sessionService.onContextSnapshotComplete((data) => {
        const s = this.session();
        if (s?.workspace?.path === data.workspacePath) {
          this.snapshotStatus.set(data.status);
        }
      });
    }

    // Detect available editors once
    if (this.sessionService.isDesktop) {
      this.sessionService.detectEditors().then((result) => {
        if (result.ok) {
          this.availableEditors.set(result.editors);
        }
      }).catch(() => {});

      // Default-browser icon for the dev-links launcher.
      this.devLinksService.defaultBrowser().then((b) => this.browserIcon.set(b.icon)).catch(() => {});
    }
  }

  /**
   * Workspace path as breadcrumb segments: home collapsed to "~", only the
   * last 4 segments kept (leading "…" when trimmed). Handles Windows paths too.
   * `depth` = how many real path segments the crumb covers (0 = not navigable).
   */
  pathCrumbItems(path: string): { label: string; depth: number }[] {
    const parts = pathSegments(path);
    let items = parts.map((label, i) => ({ label, depth: i + 1 }));
    if ((parts[0] === 'Users' || parts[0] === 'home') && parts.length >= 2) {
      items = [{ label: '~', depth: 2 }, ...items.slice(2)];
    }
    if (items.length > 4) items = [{ label: '…', depth: 0 }, ...items.slice(-3)];
    return items.length ? items : [{ label: path, depth: 0 }];
  }

  // ── Breadcrumb navigator ──
  // Click a crumb → the folders at that level that hold sessions, pick one →
  // its sessions (also nested ones), then Go switches to the chosen session.

  /** Non-sub-agent sessions the navigator can jump to. */
  navSessions = input<SessionSummary[]>([]);
  onNavigateSession = output<string>();

  crumbNav = signal<{ path: string; depth: number; top: number; left: number } | null>(null);
  crumbFolder = signal<string | null>(null);
  crumbSessionId = signal<string | null>(null);

  /** Folders sibling to the clicked crumb (same parent), each with the sessions under it. */
  crumbFolders = computed(() => {
    const nav = this.crumbNav();
    if (!nav) return [];
    const cur = pathSegments(nav.path);
    const parent = cur.slice(0, nav.depth - 1);
    const map = new Map<string, SessionSummary[]>();
    for (const s of this.navSessions()) {
      const p = s.workspace?.path;
      if (!p) continue;
      const segs = pathSegments(p);
      if (segs.length < nav.depth || !parent.every((x, i) => segs[i] === x)) continue;
      const name = segs[nav.depth - 1];
      (map.get(name) ?? map.set(name, []).get(name)!).push(s);
    }
    return [...map.entries()]
      .map(([name, sessions]) => ({ name, sessions, current: name === cur[nav.depth - 1] }))
      .sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
  });

  /** Sessions of the picked folder, with their sub-path when nested deeper. */
  crumbFolderSessions = computed(() => {
    const nav = this.crumbNav();
    const f = this.crumbFolders().find(x => x.name === this.crumbFolder());
    if (!nav || !f) return [];
    return f.sessions
      .map(session => ({ session, sub: pathSegments(session.workspace!.path).slice(nav.depth).join('/') }))
      .sort((x, y) => x.sub.localeCompare(y.sub) || x.session.name.localeCompare(y.session.name));
  });

  /** Path of the currently selected target, shown in the footer. */
  crumbTargetPath = computed(() => {
    const id = this.crumbSessionId();
    const row = this.crumbFolderSessions().find(r => r.session.id === id);
    return row?.session.workspace?.path ?? '';
  });

  openCrumbNav(ev: MouseEvent, path: string, depth: number): void {
    ev.stopPropagation();
    if (this.crumbNav()?.depth === depth) {
      this.closeCrumbNav();
      return;
    }
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left - 8, window.innerWidth - 520 - 8));
    this.crumbNav.set({ path, depth, top: r.bottom + 6, left });
    this.pickCrumbFolder(pathSegments(path)[depth - 1]);
    setTimeout(() => (document.querySelector('.crumb-nav') as HTMLElement | null)?.focus());
  }

  pickCrumbFolder(name: string): void {
    this.crumbFolder.set(name);
    const rows = this.crumbFolderSessions();
    const active = this.session()?.id;
    const other = rows.find(r => r.session.id !== active);
    this.crumbSessionId.set(other?.session.id ?? rows[0]?.session.id ?? null);
  }

  /**
   * Enter inside the breadcrumb navigator. On the popover itself it means "Go";
   * on one of its buttons (a folder, a session, Go) the button's own click
   * does the job — handling it here as well would jump to the PREVIOUSLY
   * selected session before the folder/session under focus is even picked.
   */
  onCrumbNavEnter(ev: Event): void {
    const target = ev.target as HTMLElement | null;
    if (target && target !== ev.currentTarget && target.closest('button')) return;
    ev.preventDefault();
    this.goCrumbSession();
  }

  goCrumbSession(): void {
    const id = this.crumbSessionId();
    if (!id || id === this.session()?.id) return;
    this.closeCrumbNav();
    this.onNavigateSession.emit(id);
  }

  closeCrumbNav(): void {
    this.crumbNav.set(null);
    this.crumbFolder.set(null);
    this.crumbSessionId.set(null);
  }

  /**
   * Optimistic override of the session's provider account, keyed by session id.
   * The `session` input comes from the store and is NOT refreshed after
   * updateSessionMeta, so without this the picker would keep showing the old
   * account until a full session reload.
   */
  private accountOverride = signal<{ sid: string; value: string | null | undefined } | null>(null);

  /** Read the provider account id this session was spawned with (stored in config). */
  sessionProviderAccountId(): string | null | undefined {
    const s = this.session() as unknown as
      | { id?: string; config?: { providerAccountId?: string | null }; providerAccountId?: string | null }
      | null;
    const ov = this.accountOverride();
    if (ov && ov.sid === s?.id) return ov.value;
    // Store summaries carry the pin top-level (no config object there).
    if (s?.config && 'providerAccountId' in s.config) return s.config.providerAccountId;
    return s?.providerAccountId;
  }

  /** Cast the session provider to the ProviderId union used by the account switcher. */
  providerAsAccountId(): ProviderId | null {
    const p = this.session()?.provider;
    return (p ?? null) as ProviderId | null;
  }

  /**
   * Persist the new provider-account. Scope: the WHOLE workspace — every
   * session of this session's workspace plus their sub-agents (same provider
   * only) switches together; a session without a workspace switches alone.
   * - string: that specific account
   * - null:   opt-out (CLI default)
   * - undefined: follow the global active account for the session's provider
   *
   * NEVER touches running terminals — env is frozen at spawn; each terminal
   * picks the new account up at its next relaunch (wake/respawn).
   */
  async onSessionAccountChange(value: string | null | undefined): Promise<void> {
    const s = this.session();
    if (!s) return;
    this.accountOverride.set({ sid: s.id, value }); // reflect immediately in the picker
    try {
      const workspaceId = (s as { workspaceId?: string | null }).workspaceId ?? null;
      if (workspaceId) {
        await this.sessionService.applyAccountToWorkspace(workspaceId, s.provider, value);
      } else if (value === undefined) {
        // IPC drops undefined — "inherit" travels as an explicit flag.
        await this.sessionService.updateSessionMeta(s.id, { inheritProviderAccount: true });
      } else {
        await this.sessionService.updateSessionMeta(s.id, { providerAccountId: value });
      }
    } catch {
      this.accountOverride.set(null); // revert on failure — picker falls back to config
    }
  }

  openInEditor(command: string): void {
    const cwd = this.workspacePath();
    if (!cwd) return;
    this.sessionService.openInEditor(command, cwd).catch(() => {});
  }

  toggleEditorMenu(event?: Event): void {
    event?.stopPropagation();
    this.editorMenuOpen.update(open => !open);
  }

  closeEditorMenu(): void {
    this.editorMenuOpen.set(false);
  }

  selectEditor(command: string): void {
    this.closeEditorMenu();
    this.openInEditor(command);
  }

  /** Workspaces already prefetched this session — avoid redundant scans. */
  private devLinksPrefetched = new Set<string>();

  /**
   * Silent, deferred dev-links scan. Reads the per-project cache for an instant
   * count, then (once, off the load hot path) refreshes via the TTL-cached
   * main-process scan. Never blocks and never surfaces errors.
   */
  private prefetchDevLinks(wsPath: string): void {
    if (!this.devLinksService.isAvailable) return;
    // Instant count from cache — no IPC.
    const cached = this.devLinksService.getCached(wsPath);
    if (cached) this.devLinksCount.set(cached.links.length);
    if (this.devLinksPrefetched.has(wsPath)) return;
    this.devLinksPrefetched.add(wsPath);
    // Defer so it runs after session load settles.
    setTimeout(() => {
      this.devLinksService
        .prefetch(wsPath)
        .then((links) => {
          if (this.workspacePath() === wsPath) this.devLinksCount.set(links.length);
        })
        .catch(() => {});
    }, 2000);
  }

  ngOnDestroy(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.snapshotCompleteUnsub?.();
  }

  // ── Tab strip scrolling ──

  /** Vertical mouse wheel scrolls the tab strip horizontally. */
  onTabsWheel(event: WheelEvent): void {
    const el = this.tabsScroll()?.nativeElement;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    // Trackpads already emit deltaX for horizontal swipes — only translate
    // when the gesture is predominantly vertical (i.e. a mouse wheel).
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    el.scrollLeft += event.deltaY;
  }

  // ── Drag & drop ──

  onTabDragStart(event: DragEvent, tab: SessionSummary): void {
    this.dragTabId.set(tab.id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', tab.id);
    }
  }

  onTabDragOver(event: DragEvent, tab: SessionSummary): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    if (this.dragTabId() !== tab.id) {
      this.dragOverTabId.set(tab.id);
    }
  }

  onTabDragLeave(event: DragEvent): void {
    // WKWebView fires dragleave with relatedTarget=null when crossing child
    // elements of the tab — clearing there makes the indicator flicker. Only
    // clear on a real exit; otherwise the next dragover (or dragend/drop,
    // which reset state) keeps the indicator correct.
    const rt = event.relatedTarget as Node | null;
    if (!rt || (event.currentTarget as HTMLElement).contains(rt)) return;
    this.dragOverTabId.set(null);
  }

  onTabDrop(event: DragEvent, targetTab: SessionSummary): void {
    event.preventDefault();
    const dragId = this.dragTabId();
    if (!dragId || dragId === targetTab.id) {
      this.resetDragState();
      return;
    }

    const tabs = [...this.tabSessions()];
    const fromIdx = tabs.findIndex(t => t.id === dragId);
    const toIdx = tabs.findIndex(t => t.id === targetTab.id);
    if (fromIdx < 0 || toIdx < 0) {
      this.resetDragState();
      return;
    }

    // Move the dragged tab to the target position
    const [moved] = tabs.splice(fromIdx, 1);
    tabs.splice(toIdx, 0, moved);

    this.onReorderTabs.emit(tabs.map(t => t.id));
    this.resetDragState();
  }

  onTabDragEnd(): void {
    this.resetDragState();
  }

  private resetDragState(): void {
    this.dragTabId.set(null);
    this.dragOverTabId.set(null);
  }

  // ── Context menu ──

  onTabContextMenu(event: MouseEvent, tab: SessionSummary): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenuTab.set(tab);
    this.contextMenuPos.set({ x: event.clientX, y: event.clientY });
  }

  closeContextMenu(): void {
    this.contextMenuTab.set(null);
  }

  contextMenuRename(): void {
    const tab = this.contextMenuTab();
    if (tab) {
      this.onRenameTab.emit({ sessionId: tab.id, name: tab.name });
    }
    this.closeContextMenu();
  }

  contextMenuClose(): void {
    const tab = this.contextMenuTab();
    if (tab) {
      this.onCloseTab.emit(tab.id);
    }
    this.closeContextMenu();
  }

  onCloseTabEvt(event: Event, sessionId: string): void {
    event.stopPropagation();
    this.onCloseTab.emit(sessionId);
  }

  // ── Git ──

  private async loadGitStatus(cwd: string): Promise<void> {
    if (!this.sessionService.isDesktop) return;
    // Windows "Safe terminal": skip git-status polling (the synchronous git
    // status in the main process is the prime Windows-lag suspect). Flag is only
    // ever true on Windows, so macOS/Linux keep polling as before. Manual git
    // actions still work — only this background poll is paused.
    if ((window as any).__PO_SAFE_TERMINAL__) return;

    try {
      const api = (window as any).promptops;
      const result = await api.getGitStatus(cwd);
      if (!result.ok) return;

      const nextBranch = result.branch || '';
      if (this.gitBranch() !== nextBranch) this.gitBranch.set(nextBranch);

      const next = result.counts || { modified: 0, added: 0, deleted: 0, total: 0 };
      const prev = this.gitCounts();
      if (
        prev.modified !== next.modified ||
        prev.added !== next.added ||
        prev.deleted !== next.deleted ||
        prev.total !== next.total
      ) {
        this.gitCounts.set(next);
      }
    } catch {
      // Not in git repo or git not available
    }
  }

}
