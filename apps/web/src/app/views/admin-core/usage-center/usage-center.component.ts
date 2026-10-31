import { Component, OnDestroy, OnInit, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { SwalService } from '@core/services/swal.service';

type UsageWindow = '24h' | '7d' | '30d' | 'all';

interface UsageBreakdown {
  key: string;
  label: string;
  tokens: number;
  cost: number;
  share: number;
}

interface UsageSessionRow {
  sessionId: string;
  name: string;
  provider: string;
  model: string;
  workspaceName: string | null;
  tokens: number;
  saved: number;
  cost: number;
  efficiency: number;
  lastSeen: number;
}

interface UsageTrendPoint {
  bucket: string;
  tokens: number;
  cost: number;
}

interface UsageSummary {
  window: UsageWindow;
  generatedAt: number;
  totals: {
    tokens: number;
    tokensSaved: number;
    cost: number;
    efficiency: number;
    sessions: number;
    prompts: number;
  };
  byProvider: UsageBreakdown[];
  byModel: UsageBreakdown[];
  topSessions: UsageSessionRow[];
  trend: UsageTrendPoint[];
}

const EMPTY_SUMMARY: UsageSummary = {
  window: '7d',
  generatedAt: 0,
  totals: { tokens: 0, tokensSaved: 0, cost: 0, efficiency: 0, sessions: 0, prompts: 0 },
  byProvider: [],
  byModel: [],
  topSessions: [],
  trend: [],
};

const LEGEND_STORAGE_KEY = 'usageCenter.legendOpen';

function readLegendPref(): boolean {
  try {
    const v = localStorage.getItem(LEGEND_STORAGE_KEY);
    if (v === null) return true;
    return v === '1';
  } catch {
    return true;
  }
}

@Component({
  selector: 'app-usage-center',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  template: `
    <div class="uc-page">
      <div class="uc-header">
        <div>
          <h2 class="uc-title">{{ 'USAGE_CENTER.Title' | translate }}</h2>
          <p class="uc-subtitle">{{ 'USAGE_CENTER.Subtitle' | translate }}</p>
        </div>
        <div class="uc-actions">
          <div class="uc-segmented" role="tablist">
            @for (w of windows; track w) {
              <button
                type="button"
                class="uc-seg-btn"
                [class.active]="selectedWindow() === w.key"
                (click)="onWindowChange(w.key)">
                {{ w.label | translate }}
              </button>
            }
          </div>
          <button type="button" class="uc-btn primary" (click)="onScan()" [disabled]="!isDesktop || scanning()">
            <i class="ti" [class.ti-refresh]="!scanning()" [class.ti-loader-2]="scanning()"></i>
            {{ scanning() ? ('USAGE_CENTER.Scanning' | translate) : ('USAGE_CENTER.Scan' | translate) }}
          </button>
          <button type="button" class="uc-btn" (click)="onExport('json')" [disabled]="!isDesktop">
            <i class="ti ti-download"></i> JSON
          </button>
          <button type="button" class="uc-btn" (click)="onExport('csv')" [disabled]="!isDesktop">
            <i class="ti ti-file-spreadsheet"></i> CSV
          </button>
        </div>
      </div>

      @if (exportNotice(); as n) {
        <div class="uc-export-notice" [class.error]="!n.ok" role="status">
          @if (n.ok) {
            <i class="ti ti-circle-check"></i>
            <span class="uc-export-path">{{ 'USAGE_CENTER.ExportSaved' | translate: { path: n.path } }}</span>
            <button type="button" class="uc-btn-link" (click)="showExport(n.path)">{{ 'USAGE_CENTER.ShowInFolder' | translate }}</button>
          } @else {
            <i class="ti ti-alert-triangle"></i>
            <span>{{ 'USAGE_CENTER.ExportFailed' | translate: { error: n.error } }}</span>
          }
          <button type="button" class="uc-btn-link" (click)="exportNotice.set(null)" [attr.aria-label]="'BUTTONS.Close' | translate">
            <i class="ti ti-x"></i>
          </button>
        </div>
      }

      @if (scanReport(); as report) {
        <div class="uc-scan-report">
          <i class="ti ti-database"></i>
          @for (src of scanSources(); track src) {
            <span>
              <strong>{{ sourceLabel(src.key) }}</strong>:
              {{ src.filesScanned }} {{ 'USAGE_CENTER.Sources.Scanned' | translate }} ·
              {{ src.linesParsed }} {{ 'USAGE_CENTER.Sources.Lines' | translate }}@if (src.error) {
              <span class="err"> — {{ src.error }}</span>
            }
          </span>
        }
        <span class="uc-scan-meta">{{ report.totalEntries }} {{ 'USAGE_CENTER.Sources.Entries' | translate }} · {{ report.durationMs }} ms</span>
      </div>
    }

    <div class="uc-legend" [class.open]="legendOpen()">
      <button type="button" class="uc-legend-toggle" (click)="toggleLegend()" [attr.aria-expanded]="legendOpen()">
        <i class="ti ti-info-circle"></i>
        <span>{{ 'USAGE_CENTER.Legend.Title' | translate }}</span>
        <i class="ti uc-legend-chev" [class.ti-chevron-down]="!legendOpen()" [class.ti-chevron-up]="legendOpen()"></i>
      </button>
      @if (legendOpen()) {
        <div class="uc-legend-body">
          <div class="uc-legend-item">
            <span class="uc-legend-dot indigo"></span>
            <div>
              <div class="uc-legend-term">{{ 'USAGE_CENTER.Cards.Tokens' | translate }}</div>
              <div class="uc-legend-desc">{{ 'USAGE_CENTER.Legend.Tokens' | translate }}</div>
            </div>
          </div>
          <div class="uc-legend-item">
            <span class="uc-legend-dot purple"></span>
            <div>
              <div class="uc-legend-term">{{ 'USAGE_CENTER.Cards.Cost' | translate }}</div>
              <div class="uc-legend-desc">{{ 'USAGE_CENTER.Legend.Cost' | translate }}</div>
              <div class="uc-legend-formula">
                <code>{{ 'USAGE_CENTER.Legend.CostFormula' | translate }}</code>
              </div>
              <div class="uc-legend-note">
                <i class="ti ti-alert-triangle"></i>
                {{ 'USAGE_CENTER.Legend.CostDisclaimer' | translate }}
              </div>
            </div>
          </div>
          <div class="uc-legend-item">
            <span class="uc-legend-dot emerald"></span>
            <div>
              <div class="uc-legend-term">{{ 'USAGE_CENTER.Cards.Saved' | translate }}</div>
              <div class="uc-legend-desc">{{ 'USAGE_CENTER.Legend.Saved' | translate }}</div>
            </div>
          </div>
          <div class="uc-legend-item">
            <span class="uc-legend-dot amber"></span>
            <div>
              <div class="uc-legend-term">{{ 'USAGE_CENTER.Cards.Efficiency' | translate }}</div>
              <div class="uc-legend-desc">{{ 'USAGE_CENTER.Legend.Efficiency' | translate }}</div>
              <div class="uc-legend-formula">
                <code>{{ 'USAGE_CENTER.Legend.EfficiencyFormula' | translate }}</code>
              </div>
            </div>
          </div>
        </div>
      }
    </div>

    @if (!isDesktop) {
      <div class="uc-empty">
        <i class="ti ti-info-circle"></i>
        {{ 'USAGE_CENTER.DesktopOnly' | translate }}
      </div>
    }

    @if (isDesktop) {
      <div class="uc-grid uc-cards">
        <div class="uc-card accent-indigo">
          <div class="uc-card-label">{{ 'USAGE_CENTER.Cards.Tokens' | translate }}</div>
          <div class="uc-card-value">{{ formatNumber(summary().totals.tokens) }}</div>
          <div class="uc-card-hint">
            {{ summary().totals.prompts }} {{ 'USAGE_CENTER.Cards.Prompts' | translate }}
          </div>
        </div>
        <div class="uc-card accent-purple">
          <div class="uc-card-label">
            {{ 'USAGE_CENTER.Cards.Cost' | translate }}
            <button type="button" class="uc-info-pin" (click)="toggleLegend()"
              [attr.title]="'USAGE_CENTER.Legend.OpenHint' | translate"
              [attr.aria-label]="'USAGE_CENTER.Legend.OpenHint' | translate">
              <i class="ti ti-info-circle"></i>
            </button>
          </div>
          <div class="uc-card-value">
            \${{ summary().totals.cost.toFixed(2) }}
            <span class="uc-estimate-tag">{{ 'USAGE_CENTER.Legend.EstimateTag' | translate }}</span>
          </div>
          <div class="uc-card-hint">
            {{ summary().totals.sessions }} {{ 'USAGE_CENTER.Cards.Sessions' | translate }}
          </div>
        </div>
        <div class="uc-card accent-emerald">
          <div class="uc-card-label">{{ 'USAGE_CENTER.Cards.Saved' | translate }}</div>
          <div class="uc-card-value">{{ formatNumber(summary().totals.tokensSaved) }}</div>
          <div class="uc-card-hint">
            {{ 'USAGE_CENTER.Cards.SavedHint' | translate }}
          </div>
        </div>
        <div class="uc-card accent-amber">
          <div class="uc-card-label">{{ 'USAGE_CENTER.Cards.Efficiency' | translate }}</div>
          <div class="uc-card-value">{{ summary().totals.efficiency }}%</div>
          <div class="uc-card-hint">{{ efficiencyHint() }}</div>
        </div>
      </div>
      <div class="uc-grid uc-two-col">
        <div class="uc-panel">
          <div class="uc-panel-title">
            <i class="ti ti-stack-2"></i>
            {{ 'USAGE_CENTER.Panels.ByProvider' | translate }}
          </div>
          @if (summary().byProvider.length) {
            <div class="uc-breakdown">
              @for (row of summary().byProvider; track row) {
                <div class="uc-bar-row">
                  <div class="uc-bar-label">
                    <span>{{ row.label }}</span>
                    <span class="uc-bar-count">{{ formatNumber(row.tokens) }}</span>
                  </div>
                  <div class="uc-bar-track">
                    <div class="uc-bar-fill indigo" [style.width.%]="row.share * 100"></div>
                  </div>
                  <div class="uc-bar-meta">
                    {{ (row.share * 100) | number: '1.0-1' }}% · \${{ row.cost.toFixed(2) }}
                  </div>
                </div>
              }
            </div>
          } @else {
            <div class="uc-empty-inline">
              <i class="ti ti-hourglass"></i>
              {{ 'USAGE_CENTER.NoData' | translate }}
            </div>
          }
        </div>
        <div class="uc-panel">
          <div class="uc-panel-title">
            <i class="ti ti-cpu"></i>
            {{ 'USAGE_CENTER.Panels.ByModel' | translate }}
          </div>
          @if (summary().byModel.length) {
            <div class="uc-breakdown">
              @for (row of summary().byModel; track row) {
                <div class="uc-bar-row">
                  <div class="uc-bar-label">
                    <span>{{ row.label }}</span>
                    <span class="uc-bar-count">{{ formatNumber(row.tokens) }}</span>
                  </div>
                  <div class="uc-bar-track">
                    <div class="uc-bar-fill purple" [style.width.%]="row.share * 100"></div>
                  </div>
                  <div class="uc-bar-meta">
                    {{ (row.share * 100) | number: '1.0-1' }}% · \${{ row.cost.toFixed(2) }}
                  </div>
                </div>
              }
            </div>
          } @else {
            <div class="uc-empty-inline">
              <i class="ti ti-hourglass"></i>
              {{ 'USAGE_CENTER.NoData' | translate }}
            </div>
          }
        </div>
      </div>
      <div class="uc-panel">
        <div class="uc-panel-title">
          <i class="ti ti-chart-line"></i>
          {{ 'USAGE_CENTER.Panels.Trend' | translate }}
          <span class="uc-panel-hint">{{ trendHint() }}</span>
        </div>
        @if (trendMax() > 0) {
          <div class="uc-trend">
            <svg [attr.viewBox]="'0 0 ' + trendWidth() + ' 80'" preserveAspectRatio="none" class="uc-trend-svg">
              <polyline
                [attr.points]="trendLine()"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"></polyline>
              <polygon
                [attr.points]="trendArea()"
                class="uc-trend-area"></polygon>
            </svg>
            <div class="uc-trend-axis">
              @for (p of trendAxisLabels(); track p) {
                <span>{{ p }}</span>
              }
            </div>
          </div>
        } @else {
          <div class="uc-empty-inline">
            <i class="ti ti-hourglass"></i>
            {{ 'USAGE_CENTER.NoData' | translate }}
          </div>
        }
      </div>
      <div class="uc-panel">
        <div class="uc-panel-title">
          <i class="ti ti-list-details"></i>
          {{ 'USAGE_CENTER.Panels.TopSessions' | translate }}
        </div>
        @if (summary().topSessions.length) {
          <div class="table-responsive po-table-sticky-first">
            <table class="uc-table po-table-min-lg">
              <thead>
                <tr>
                  <th>{{ 'USAGE_CENTER.Table.Session' | translate }}</th>
                  <th>{{ 'USAGE_CENTER.Table.Provider' | translate }}</th>
                  <th class="d-none d-md-table-cell">{{ 'USAGE_CENTER.Table.Workspace' | translate }}</th>
                  <th class="num">{{ 'USAGE_CENTER.Table.Tokens' | translate }}</th>
                  <th class="num">{{ 'USAGE_CENTER.Table.Saved' | translate }}</th>
                  <th class="num d-none d-md-table-cell">{{ 'USAGE_CENTER.Table.Cost' | translate }}</th>
                  <th class="num">{{ 'USAGE_CENTER.Table.Efficiency' | translate }}</th>
                </tr>
              </thead>
              <tbody>
                @for (s of summary().topSessions; track s) {
                  <tr>
                    <td>
                      <div class="uc-session-name">{{ s.name || ('USAGE_CENTER.Untitled session' | translate) }}</div>
                      <div class="uc-session-id" [title]="s.sessionId">{{ s.sessionId.slice(0, 8) }}</div>
                    </td>
                    <td>{{ providerLabel(s.provider) }}</td>
                    <td class="muted d-none d-md-table-cell">{{ s.workspaceName ?? '—' }}</td>
                    <td class="num mono">{{ formatNumber(s.tokens) }}</td>
                    <td class="num mono pos">{{ formatNumber(s.saved) }}</td>
                    <td class="num mono d-none d-md-table-cell">\${{ s.cost.toFixed(3) }}</td>
                    <td class="num">
                      <span class="uc-eff-badge" [class]="efficiencyClass(s.efficiency)">
                        {{ s.efficiency | number: '1.0-0' }}%
                      </span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <div class="uc-empty-inline">
            <i class="ti ti-hourglass"></i>
            {{ 'USAGE_CENTER.NoData' | translate }}
          </div>
        }
      </div>
      <div class="uc-footer">
        <div class="uc-privacy">
          <i class="ti ti-lock"></i>
          {{ 'USAGE_CENTER.Privacy' | translate }}
        </div>
        <button type="button" class="uc-btn-link" (click)="onClear()">
          <i class="ti ti-trash"></i> {{ 'USAGE_CENTER.Clear' | translate }}
        </button>
      </div>
    }

    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    :host { display: block; height: 100%; min-height: calc(100vh - 70px); overflow-y: auto; }

    .uc-page { padding: 1.25rem; display: flex; flex-direction: column; gap: 1rem; }

    .uc-header {
      display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;
      flex-wrap: wrap;
    }
    .uc-title { margin: 0; font-size: 1.25rem; font-weight: 700; }
    .uc-subtitle { margin: 0.1rem 0 0; font-size: 0.78rem; color: var(--po-text-secondary, #6c7a8d); }
    .uc-actions { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }

    .uc-segmented {
      display: inline-flex; padding: 2px; border-radius: 8px;
      background: rgba(99,102,241,0.08); border: 1px solid rgba(99,102,241,0.12);
    }
    .uc-seg-btn {
      background: transparent; border: 0; padding: 0.3rem 0.7rem;
      font-size: 0.72rem; font-weight: 600;
      color: var(--po-text-secondary, #9ca3af); cursor: pointer; border-radius: 6px;
      transition: all 0.15s;
    }
    .uc-seg-btn:hover { color: var(--bs-body-color); }
    .uc-seg-btn.active {
      background: rgba(99,102,241,0.18); color: var(--bs-primary, #6366f1);
    }

    .uc-btn {
      display: inline-flex; align-items: center; gap: 0.35rem;
      background: transparent; border: 1px solid var(--bs-border-color);
      color: var(--bs-body-color); font-size: 0.72rem; font-weight: 600;
      padding: 0.3rem 0.65rem; border-radius: 6px; cursor: pointer;
      transition: all 0.15s;
    }
    .uc-btn:hover:not(:disabled) { border-color: var(--bs-primary, #6366f1); color: var(--bs-primary, #6366f1); }
    .uc-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .uc-btn.primary {
      background: linear-gradient(90deg, #6366f1, #818cf8);
      border-color: transparent; color: #fff;
    }
    .uc-btn.primary:hover:not(:disabled) { filter: brightness(1.05); color: #fff; }
    .uc-btn .ti-loader-2 { animation: uc-spin 0.8s linear infinite; }
    @keyframes uc-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

    .uc-scan-report {
      display: flex; flex-wrap: wrap; gap: 0.9rem; align-items: center;
      padding: 0.5rem 0.75rem; border-radius: 8px; border: 1px solid var(--bs-border-color);
      background: rgba(99,102,241,0.04);
      font-size: 0.68rem; color: var(--po-text-secondary, #6c7a8d);
    }
    .uc-scan-report i { color: var(--bs-primary, #6366f1); }
    .uc-scan-report strong { color: var(--bs-body-color); font-weight: 700; }
    .uc-scan-report .err { color: #ef4444; margin-left: 0.25rem; }
    .uc-scan-meta { margin-left: auto; font-family: monospace; }

    .uc-btn-link {
      background: transparent; border: 0; color: var(--po-text-secondary, #6c7a8d);
      font-size: 0.7rem; cursor: pointer; display: inline-flex; align-items: center; gap: 0.3rem;
      padding: 0.25rem 0.5rem; border-radius: 4px;
    }
    .uc-btn-link:hover { color: #ef4444; background: rgba(239,68,68,0.08); }

    .uc-legend {
      border: 1px solid rgba(99,102,241,0.18);
      border-radius: 10px;
      background: linear-gradient(180deg, rgba(99,102,241,0.04), rgba(167,139,250,0.03));
      overflow: hidden;
    }
    .uc-legend.open { background: linear-gradient(180deg, rgba(99,102,241,0.06), rgba(167,139,250,0.04)); }
    .uc-legend-toggle {
      display: flex; align-items: center; gap: 0.5rem; width: 100%;
      background: transparent; border: 0; cursor: pointer;
      padding: 0.55rem 0.85rem; font-size: 0.74rem; font-weight: 600;
      color: var(--bs-body-color); text-align: left;
    }
    .uc-legend-toggle i:first-child { color: var(--bs-primary, #6366f1); font-size: 0.95rem; }
    .uc-legend-toggle .uc-legend-chev { margin-left: auto; color: var(--po-text-secondary, #6c7a8d); font-size: 0.85rem; }
    .uc-legend-toggle:hover { background: rgba(99,102,241,0.05); }
    .uc-legend-body {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.85rem 1.2rem;
      padding: 0.5rem 0.95rem 0.95rem;
      border-top: 1px dashed rgba(99,102,241,0.18);
    }
    @media (max-width: 720px) { .uc-legend-body { grid-template-columns: 1fr; } }
    .uc-legend-item {
      display: flex; gap: 0.55rem; align-items: flex-start;
    }
    .uc-legend-dot {
      width: 8px; height: 8px; border-radius: 50%; margin-top: 0.4rem; flex-shrink: 0;
      box-shadow: 0 0 0 3px rgba(99,102,241,0.08);
    }
    .uc-legend-dot.indigo  { background: #6366f1; }
    .uc-legend-dot.purple  { background: #a78bfa; box-shadow: 0 0 0 3px rgba(167,139,250,0.12); }
    .uc-legend-dot.emerald { background: #3fb950; box-shadow: 0 0 0 3px rgba(63,185,80,0.12); }
    .uc-legend-dot.amber   { background: #d29922; box-shadow: 0 0 0 3px rgba(210,153,34,0.12); }
    .uc-legend-term {
      font-size: 0.72rem; font-weight: 700; color: var(--bs-body-color);
      margin-bottom: 0.15rem;
    }
    .uc-legend-desc {
      font-size: 0.7rem; color: var(--po-text-secondary, #6c7a8d);
      line-height: 1.4;
    }
    .uc-legend-formula {
      margin-top: 0.3rem;
    }
    .uc-legend-formula code {
      display: inline-block;
      font-size: 0.65rem;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      background: rgba(99,102,241,0.08);
      color: var(--bs-primary, #6366f1);
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      border: 1px solid rgba(99,102,241,0.15);
    }
    .uc-legend-note {
      margin-top: 0.35rem; display: flex; align-items: center; gap: 0.3rem;
      font-size: 0.65rem; color: #d29922; font-style: italic;
    }
    .uc-legend-note i { font-size: 0.8rem; }

    .uc-info-pin {
      background: transparent; border: 0; padding: 0; margin-left: 0.3rem;
      cursor: pointer; color: var(--po-text-secondary, #6c7a8d);
      display: inline-flex; align-items: center; vertical-align: middle;
      transition: color 0.15s;
    }
    .uc-info-pin:hover { color: var(--bs-primary, #6366f1); }
    .uc-info-pin i { font-size: 0.78rem; }

    .uc-estimate-tag {
      display: inline-block; vertical-align: middle;
      margin-left: 0.45rem;
      font-size: 0.55rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 1px 6px; border-radius: 6px;
      background: rgba(167,139,250,0.15); color: #a78bfa;
      font-family: 'Inter', system-ui, sans-serif;
    }

    .uc-grid { display: grid; gap: 0.75rem; }
    .uc-cards { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .uc-two-col { grid-template-columns: repeat(2, minmax(0, 1fr)); }

    @media (max-width: 900px) {
      .uc-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .uc-two-col { grid-template-columns: 1fr; }
    }

    .uc-card {
      border: 1px solid var(--bs-border-color);
      border-radius: 10px; padding: 0.85rem 1rem;
      background: var(--bs-card-bg, var(--bs-body-bg));
      display: flex; flex-direction: column; gap: 0.25rem;
      border-left: 3px solid rgba(99,102,241,0.5);
    }
    .uc-card.accent-indigo  { border-left-color: #6366f1; }
    .uc-card.accent-purple  { border-left-color: #a78bfa; }
    .uc-card.accent-emerald { border-left-color: #3fb950; }
    .uc-card.accent-amber   { border-left-color: #d29922; }

    .uc-card-label {
      font-size: 0.6rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--po-text-secondary, #6c7a8d);
    }
    .uc-card-value {
      font-size: 1.35rem; font-weight: 700;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      color: var(--bs-body-color);
    }
    .uc-card-hint { font-size: 0.68rem; color: var(--po-text-secondary, #6c7a8d); }

    .uc-panel {
      border: 1px solid var(--bs-border-color);
      border-radius: 10px; padding: 0.95rem 1rem;
      background: var(--bs-card-bg, var(--bs-body-bg));
    }
    .uc-panel-title {
      display: flex; align-items: center; gap: 0.4rem;
      font-size: 0.78rem; font-weight: 700; margin-bottom: 0.75rem;
      color: var(--bs-body-color);
    }
    .uc-panel-title i { color: var(--bs-primary, #6366f1); }
    .uc-panel-hint {
      margin-left: auto; font-weight: 500; font-size: 0.68rem;
      color: var(--po-text-secondary, #6c7a8d);
    }

    .uc-breakdown { display: flex; flex-direction: column; gap: 0.55rem; }
    .uc-bar-row { display: grid; grid-template-columns: 1fr 2fr auto; gap: 0.5rem; align-items: center; }
    .uc-bar-label {
      display: flex; flex-direction: column; font-size: 0.72rem; font-weight: 600;
    }
    .uc-bar-count { font-size: 0.65rem; color: var(--po-text-secondary, #6c7a8d); font-family: monospace; }
    .uc-bar-track {
      height: 6px; background: rgba(99,102,241,0.08); border-radius: 3px; overflow: hidden;
    }
    .uc-bar-fill { height: 100%; transition: width 0.3s; border-radius: 3px; }
    .uc-bar-fill.indigo { background: linear-gradient(90deg, #6366f1, #818cf8); }
    .uc-bar-fill.purple { background: linear-gradient(90deg, #a78bfa, #c4b5fd); }
    .uc-bar-meta {
      font-size: 0.65rem; color: var(--po-text-secondary, #6c7a8d); font-family: monospace;
      min-width: 80px; text-align: right;
    }

    .uc-trend {
      display: flex; flex-direction: column; gap: 0.4rem;
      color: var(--bs-primary, #6366f1);
    }
    .uc-trend-svg { width: 100%; height: 80px; }
    .uc-trend-area { fill: rgba(99,102,241,0.12); }
    .uc-trend-axis {
      display: flex; justify-content: space-between;
      font-size: 0.58rem; color: var(--po-text-secondary, #6c7a8d);
      font-family: monospace;
    }

    .uc-table { width: 100%; border-collapse: collapse; font-size: 0.76rem; }
    .uc-table th, .uc-table td {
      padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--bs-border-color);
      text-align: left;
    }
    .uc-table th {
      font-weight: 700; font-size: 0.6rem; text-transform: uppercase;
      letter-spacing: 0.06em; color: var(--po-text-secondary, #6c7a8d);
    }
    .uc-table td.num, .uc-table th.num { text-align: right; }
    .uc-table td.muted { color: var(--po-text-secondary, #6c7a8d); }
    .uc-table td.mono { font-family: 'JetBrains Mono', 'Fira Code', monospace; }
    .uc-table td.pos { color: #3fb950; }
    .uc-session-name { font-weight: 600; }
    .uc-session-id {
      font-size: 0.58rem; font-family: monospace;
      color: var(--po-text-secondary, #6c7a8d);
    }

    .uc-eff-badge {
      display: inline-block; padding: 1px 7px; border-radius: 10px;
      font-size: 0.62rem; font-weight: 700;
    }
    .uc-eff-badge.high   { background: rgba(63,185,80,0.12);  color: #3fb950; }
    .uc-eff-badge.medium { background: rgba(210,153,34,0.12); color: #d29922; }
    .uc-eff-badge.low    { background: rgba(139,148,158,0.12); color: #8b949e; }

    .uc-empty, .uc-empty-inline {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 1.5rem; justify-content: center;
      color: var(--po-text-secondary, #6c7a8d); font-size: 0.8rem;
      border: 1px dashed var(--bs-border-color); border-radius: 8px;
    }
    .uc-empty-inline { padding: 1rem; border: 0; }

    .uc-footer {
      display: flex; justify-content: space-between; align-items: center;
      padding-top: 0.5rem; margin-top: 0.5rem;
      border-top: 1px solid var(--bs-border-color);
    }
    .uc-privacy {
      display: flex; align-items: center; gap: 0.4rem;
      font-size: 0.68rem; color: var(--po-text-secondary, #6c7a8d);
      font-style: italic;
    }
    .uc-privacy i { color: #3fb950; }
    .uc-export-notice {
      display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
      margin: 0 0 0.75rem; padding: 0.45rem 0.7rem; border-radius: 8px;
      font-size: 0.75rem; border: 1px solid rgba(63,185,80,0.35);
      background: rgba(63,185,80,0.08);
    }
    .uc-export-notice.error { border-color: rgba(239,68,68,0.35); background: rgba(239,68,68,0.08); }
    .uc-export-notice > i { color: #3fb950; }
    .uc-export-notice.error > i { color: #ef4444; }
    .uc-export-path { flex: 1 1 12rem; min-width: 0; overflow-wrap: anywhere; }
  `],
})
export class UsageCenterComponent implements OnInit, OnDestroy {
  private translate = inject(TranslateService);
  private swal = inject(SwalService);

  readonly windows: Array<{ key: UsageWindow; label: string }> = [
    { key: '24h', label: 'USAGE_CENTER.Window.24h' },
    { key: '7d',  label: 'USAGE_CENTER.Window.7d' },
    { key: '30d', label: 'USAGE_CENTER.Window.30d' },
    { key: 'all', label: 'USAGE_CENTER.Window.All' },
  ];

  readonly selectedWindow = signal<UsageWindow>('7d');
  readonly summary = signal<UsageSummary>(EMPTY_SUMMARY);
  readonly isDesktop = !!(window as any).promptops;
  readonly scanning = signal(false);
  /** Outcome of the last export: the file lands in the app data folder, so say where. */
  readonly exportNotice = signal<{ ok: true; path: string } | { ok: false; error: string } | null>(null);
  readonly legendOpen = signal<boolean>(readLegendPref());
  readonly scanReport = signal<{ totalEntries: number; durationMs: number; sources: Record<string, { filesScanned: number; filesSkipped: number; linesParsed: number; durationMs: number; error?: string }> } | null>(null);

  readonly scanSources = computed(() => {
    const r = this.scanReport();
    if (!r) return [];
    return Object.entries(r.sources).map(([key, v]) => ({ key, ...v }));
  });

  private unsubUpdate: (() => void) | null = null;
  private unsubScan: (() => void) | null = null;
  private refreshDebounce: ReturnType<typeof setTimeout> | null = null;

  readonly efficiencyHint = computed(() => {
    const eff = this.summary().totals.efficiency;
    if (eff >= 60) return this.translate.instant('USAGE_CENTER.Cards.EfficiencyHigh');
    if (eff >= 30) return this.translate.instant('USAGE_CENTER.Cards.EfficiencyMedium');
    return this.translate.instant('USAGE_CENTER.Cards.EfficiencyLow');
  });

  readonly trendMax = computed(() => {
    const max = Math.max(0, ...this.summary().trend.map((p) => p.tokens));
    return max;
  });

  readonly trendWidth = computed(() => Math.max(100, this.summary().trend.length * 10));

  readonly trendLine = computed(() => {
    const points = this.summary().trend;
    const max = this.trendMax() || 1;
    const w = this.trendWidth();
    const h = 80;
    return points
      .map((p, i) => {
        const x = (i / Math.max(1, points.length - 1)) * w;
        const y = h - (p.tokens / max) * (h - 6) - 3;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  });

  readonly trendArea = computed(() => {
    const line = this.trendLine();
    if (!line) return '';
    const w = this.trendWidth();
    return `0,80 ${line} ${w},80`;
  });

  readonly trendAxisLabels = computed(() => {
    const trend = this.summary().trend;
    if (trend.length === 0) return [];
    if (trend.length <= 6) return trend.map((p) => p.bucket);
    return [trend[0].bucket, trend[Math.floor(trend.length / 2)].bucket, trend[trend.length - 1].bucket];
  });

  readonly trendHint = computed(() => {
    const w = this.selectedWindow();
    return this.translate.instant(`USAGE_CENTER.TrendHint.${w}`);
  });

  async ngOnInit(): Promise<void> {
    if (!this.isDesktop) return;
    await this.refresh();

    const api = (window as any).promptops;
    this.unsubUpdate = api?.onUsageUpdated?.(() => this.scheduleRefresh());
    this.unsubScan = api?.onUsageScanStatus?.((_e: unknown, data: any) => {
      if (data?.phase === 'scanning') this.scanning.set(true);
      if (data?.phase === 'idle') {
        this.scanning.set(false);
        if (data?.lastReport) this.scanReport.set(data.lastReport);
        void this.refresh();
      }
    });

    // First-open auto-scan (only if ring is empty) so users see real data immediately.
    if (this.summary().totals.tokens === 0) {
      void this.onScan();
    }
  }

  ngOnDestroy(): void {
    if (this.unsubUpdate) this.unsubUpdate();
    if (this.unsubScan) this.unsubScan();
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
  }

  async onScan(): Promise<void> {
    if (!this.isDesktop || this.scanning()) return;
    this.scanning.set(true);
    try {
      const res = await (window as any).promptops.runUsageScan();
      if (res?.report) this.scanReport.set(res.report);
      await this.refresh();
    } finally {
      this.scanning.set(false);
    }
  }

  sourceLabel(key: string): string {
    const map: Record<string, string> = {
      'claude-code': 'Claude Code',
      codex: 'Codex',
    };
    return map[key] ?? key;
  }

  onWindowChange(w: UsageWindow): void {
    this.selectedWindow.set(w);
    void this.refresh();
  }

  async onExport(format: 'json' | 'csv'): Promise<void> {
    if (!this.isDesktop) return;
    this.exportNotice.set(null);
    try {
      const res = await (window as any).promptops.exportUsage({ window: this.selectedWindow(), format });
      if (res?.ok && res.path) this.exportNotice.set({ ok: true, path: res.path });
      else this.exportNotice.set({ ok: false, error: res?.error || this.translate.instant('USAGE_CENTER.ExportUnknownError') });
    } catch (e: any) {
      this.exportNotice.set({ ok: false, error: String(e?.message ?? e) });
    }
  }

  showExport(path: string): void {
    void (window as any).promptops?.showInFolder?.(path);
  }

  onClear(): void {
    if (!this.isDesktop) return;
    // window.confirm() returns false at once in the macOS webview (no JS
    // dialog delegate): the app's confirmation calls back only on confirm.
    this.swal.confirmDanger(
      this.translate.instant('USAGE_CENTER.Clear'),
      this.translate.instant('USAGE_CENTER.ConfirmClear'),
      () => void this.clearHistory(),
    );
  }

  private async clearHistory(): Promise<void> {
    await (window as any).promptops.clearUsage();
    await this.refresh();
  }

  private scheduleRefresh(): void {
    if (this.refreshDebounce) return;
    this.refreshDebounce = setTimeout(() => {
      this.refreshDebounce = null;
      void this.refresh();
    }, 800);
  }

  private async refresh(): Promise<void> {
    try {
      const api = (window as any).promptops;
      const data = await api?.getUsageSummary?.(this.selectedWindow());
      if (data) this.summary.set(data);
    } catch {
      /* best-effort */
    }
  }

  formatNumber(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  }

  providerLabel(id: string): string {
    const map: Record<string, string> = {
      'claude-code-cli': 'Claude Code',
      codex: 'Codex',
      'gemini-cli': 'Gemini',
      antigravity: 'Antigravity',
      copilot: 'Copilot',
      cursor: 'Cursor',
      grok: 'Grok',
      hermes: 'Hermes',
      muse: 'Muse Code',
      zai: 'Z.AI',
      kimi: 'Kimi',
      opencode: 'OpenCode',
      kora: 'Kora',
      'promptops-cli': 'PromptOps',
      'generic-shell': 'Shell',
    };
    return map[id] ?? id;
  }

  efficiencyClass(e: number): string {
    if (e >= 60) return 'high';
    if (e >= 30) return 'medium';
    return 'low';
  }

  toggleLegend(): void {
    const next = !this.legendOpen();
    this.legendOpen.set(next);
    try {
      localStorage.setItem(LEGEND_STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* storage unavailable, ignore */
    }
  }
}
