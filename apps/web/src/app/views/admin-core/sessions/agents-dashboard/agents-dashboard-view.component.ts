import { NgTemplateOutlet } from '@angular/common';
import { Component, ElementRef, HostListener, computed, effect, inject, signal, viewChild } from '@angular/core';
import { AwayAgent, STATUS_LABEL, STATUS_ORDER, AgentsDashboardService } from './agents-dashboard.service';
import { PROVIDER_LOGO } from '../provider-logos';
import { PROVIDER_LABELS } from '../services/provider-limit.service';

/**
 * Built-in "Agents Dashboard" plugin in the sessions view: it takes the place of the agents.
 * All the active agents, grouped by workspace or in a pipeline by status, with "Go to terminal".
 * Keyboard: / searches, ↑↓ moves, Enter opens the terminal, Esc clears the search or closes.
 */
@Component({
  selector: 'app-agents-dashboard-view',
  standalone: true,
  imports: [NgTemplateOutlet],
  template: `
    <div class="wa">
      <header class="wa-head">
        <div class="wa-title">
          <i class="ti ti-brain" aria-hidden="true"></i>
          <div class="wa-title-text">
            <div class="wa-title-row"><h2>Agents Dashboard</h2><span class="wa-new">New</span></div>
            <p>{{ subtitle() }}</p>
          </div>
        </div>
        <div class="wa-actions">
          <div class="wa-seg" role="tablist" aria-label="View">
            <button type="button" role="tab" [class.on]="wa.view() === 'list'" [attr.aria-selected]="wa.view() === 'list'" (click)="wa.setView('list')"><i class="ti ti-folders" aria-hidden="true"></i> Workspaces</button>
            <button type="button" role="tab" [class.on]="wa.view() === 'pipeline'" [attr.aria-selected]="wa.view() === 'pipeline'" (click)="wa.setView('pipeline')"><i class="ti ti-layout-kanban" aria-hidden="true"></i> Pipeline</button>
          </div>
          <button type="button" class="wa-icon" (click)="wa.close()" title="Close (Esc)" aria-label="Close"><i class="ti ti-x" aria-hidden="true"></i></button>
        </div>
      </header>

      <div class="wa-toolbar">
        <label class="wa-search">
          <i class="ti ti-search" aria-hidden="true"></i>
          <input #search type="search" placeholder="Search agents, sessions, workspaces" aria-label="Search agents"
                 [value]="wa.query()" (input)="wa.query.set($any($event.target).value)" (keydown)="onSearchKey($event)">
          @if (!wa.query()) { <kbd>/</kbd> }
        </label>
        <div class="wa-filters" role="group" aria-label="Filter by status">
          <button type="button" class="wa-filter" [class.on]="wa.filter() === 'all'" (click)="wa.setFilter('all')">All <b>{{ wa.counts().all }}</b></button>
          @for (s of statuses; track s) {
            <button type="button" class="wa-filter" [class.on]="wa.filter() === s" [disabled]="!wa.counts()[s] && wa.filter() !== s" (click)="wa.setFilter(s)">
              <span class="wa-dot" [class]="'wa-dot d-' + s" aria-hidden="true"></span>{{ label[s] }} <b>{{ wa.counts()[s] }}</b>
            </button>
          }
          @if (wa.counts().fresh || wa.filter() === 'fresh') {
            <button type="button" class="wa-filter" [class.on]="wa.filter() === 'fresh'" (click)="wa.setFilter('fresh')"><i class="ti ti-sparkles" aria-hidden="true"></i> Changed <b>{{ wa.counts().fresh }}</b></button>
          }
        </div>
        @if (wa.view() === 'list' && wa.groups().length > 1 && !wa.query()) {
          <button type="button" class="wa-link" (click)="wa.setAllOpen(allCollapsed())" title="Opens or closes folders and workspaces in the session sidebar too">{{ allCollapsed() ? 'Expand all' : 'Collapse all' }}</button>
        }
      </div>

      <div class="wa-body" #body>
        @if (!wa.agents().length) {
          <div class="wa-empty">
            <i class="ti ti-moon-stars" aria-hidden="true"></i>
            <strong>No active agents</strong>
            <p>Sessions in standby or stopped are not listed. Start or wake a session and it shows up here.</p>
          </div>
        } @else if (!wa.visible().length) {
          <div class="wa-empty">
            <i class="ti ti-filter-off" aria-hidden="true"></i>
            <strong>Nothing matches</strong>
            <button type="button" class="wa-link" (click)="reset()">Clear search and filters</button>
          </div>
        } @else if (wa.view() === 'list') {
          @for (sec of wa.sections(); track sec.key) {
            <section class="wa-section">
              @if (wa.sections().length > 1 || sec.folderId) {
                @if (sec.folderId) {
                  <button type="button" class="wa-section-head" (click)="wa.toggleSection(sec)" [attr.aria-expanded]="sec.open">
                    <i class="ti wa-chev" [class.ti-chevron-down]="sec.open" [class.ti-chevron-right]="!sec.open" aria-hidden="true"></i>
                    <i class="ti wa-folder-ic" [class.ti-folder-open]="sec.open" [class.ti-folder]="!sec.open" [style.color]="sec.color || null" aria-hidden="true"></i>
                    <span class="wa-section-title">{{ sec.title }}</span>
                    <ng-container *ngTemplateOutlet="countsTpl; context: { $implicit: sec.counts }" />
                  </button>
                } @else {
                  <div class="wa-section-head static"><i class="ti wa-folder-ic ti-folders" aria-hidden="true"></i><span class="wa-section-title">{{ sec.title }}</span>
                    <ng-container *ngTemplateOutlet="countsTpl; context: { $implicit: sec.counts }" /></div>
                }
              }
              @if (sec.open) {
                <div class="wa-section-body" [class.flat]="!sec.folderId && wa.sections().length === 1">
                  @for (g of sec.groups; track g.key) {
                    <div class="wa-group">
                      @if (g.workspaceId) {
                        <button type="button" class="wa-group-head" (click)="wa.toggleGroup(g)" [attr.aria-expanded]="g.open">
                          <i class="ti wa-chev" [class.ti-chevron-down]="g.open" [class.ti-chevron-right]="!g.open" aria-hidden="true"></i>
                          <i class="ti ti-box wa-ws-ic" aria-hidden="true"></i>
                          <span class="wa-group-title">{{ g.title }}</span>
                          <ng-container *ngTemplateOutlet="countsTpl; context: { $implicit: g.counts }" />
                        </button>
                      } @else {
                        <div class="wa-group-head static"><i class="ti ti-terminal-2 wa-ws-ic" aria-hidden="true"></i><span class="wa-group-title">{{ g.title }}</span>
                          <small class="wa-group-folder">no workspace</small>
                          <ng-container *ngTemplateOutlet="countsTpl; context: { $implicit: g.counts }" /></div>
                      }
                      @if (g.open) {
                        <ul class="wa-rows">
                          @for (a of g.agents; track a.key) {
                            <li class="wa-row" [class.sel]="selected() === a.key" [attr.data-key]="a.key"
                                (click)="pick(a.key)" (dblclick)="wa.goTo(a)">
                              <span class="wa-status" [class]="'wa-status s-' + a.status"><span class="wa-dot" [class]="'wa-dot d-' + a.status"></span>{{ label[a.status] }}</span>
                              <span class="wa-logo-wrap">@if (logo(a); as src) { <img [src]="src" alt="" width="16" height="16"> }</span>
                              <span class="wa-who">
                                <strong>{{ a.isMain ? 'Main' : a.name }}@if (a.fresh) { <span class="wa-fresh-tag">changed</span> }</strong>
                                <small>@if (a.session !== g.title) { {{ a.session }} · }{{ providerName(a) }}</small>
                              </span>
                              <span class="wa-since">{{ a.since ? ago(a.since) : '' }}</span>
                              <button type="button" class="wa-go" title="Go to terminal" aria-label="Go to terminal" (click)="$event.stopPropagation(); wa.goTo(a)">
                                <i class="ti ti-terminal-2" aria-hidden="true"></i><span>Go to terminal</span>
                              </button>
                            </li>
                          }
                        </ul>
                      }
                    </div>
                  }
                </div>
              }
            </section>
          }
          <ng-template #countsTpl let-c>
            <span class="wa-group-counts">
              @for (st of statuses; track st) {
                @if (c[st]) { <span class="wa-count" [title]="c[st] + ' ' + label[st]"><span class="wa-dot" [class]="'wa-dot d-' + st"></span>{{ c[st] }}</span> }
              }
            </span>
          </ng-template>
        } @else {
          <div class="wa-board">
            @for (c of wa.columns(); track c.status) {
              <section class="wa-col">
                <header [title]="c.hint"><span class="wa-dot" [class]="'wa-dot d-' + c.status"></span><span>{{ c.title }}</span><small>{{ c.agents.length }}</small></header>
                <div class="wa-col-body">
                  @for (a of c.agents; track a.key) {
                    <article class="wa-card" [class.sel]="selected() === a.key" [attr.data-key]="a.key"
                             (click)="pick(a.key)" (dblclick)="wa.goTo(a)">
                      <div class="wa-card-top">
                        @if (logo(a); as src) { <img [src]="src" alt="" width="16" height="16"> }
                        <strong>{{ a.isMain ? a.session : a.name }}</strong>
                        @if (a.fresh) { <span class="wa-fresh-tag">changed</span> }
                      </div>
                      <small class="wa-card-ws">
                        <span class="wa-folder-dot" [style.background]="a.folderColor || null" aria-hidden="true"></span>{{ a.workspace }}@if (!a.isMain) { · {{ a.session }} }
                      </small>
                      <div class="wa-card-foot">
                        <span class="wa-since">{{ a.since ? ago(a.since) : providerName(a) }}</span>
                        <button type="button" class="wa-go" title="Go to terminal" aria-label="Go to terminal" (click)="$event.stopPropagation(); wa.goTo(a)"><i class="ti ti-terminal-2" aria-hidden="true"></i><span>Go to terminal</span></button>
                      </div>
                    </article>
                  } @empty {
                    <p class="wa-col-empty">Nobody here</p>
                  }
                </div>
              </section>
            }
          </div>
        }
      </div>

      <footer class="wa-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>⏎</kbd> go to terminal</span><span><kbd>/</kbd> search</span><span><kbd>Esc</kbd> close</span>
        <span class="wa-foot-brand" title="Integrated plugin by PromptOps. Turn it off in Plugins."><i class="ti ti-puzzle" aria-hidden="true"></i> PromptOps</span>
      </footer>
    </div>
  `,
  styles: [`
    :host { display: flex; flex-direction: column; min-height: 0; min-width: 0;
      --wa-accent: var(--po-accent, #6366F1); --wa-warning: var(--po-warning, #d29922); --wa-error: var(--po-error, #f85149);
      --wa-success: var(--po-success, #3fb950); --wa-border: var(--po-border-subtle, rgba(127,127,127,.22));
      --wa-muted: var(--po-text-secondary, rgba(127,127,127,.9)); --wa-faint: var(--po-text-tertiary, rgba(127,127,127,.7));
      --wa-hover: var(--po-bg-2, rgba(127,127,127,.08)); --wa-raised: var(--po-bg-1, transparent); }
    .wa { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; }

    .wa-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 18px 10px; }
    .wa-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .wa-title > .ti { font-size: 22px; color: var(--wa-accent); }
    .wa-title-text { min-width: 0; }
    .wa-title-row { display: flex; align-items: center; gap: 8px; }
    .wa-title h2 { margin: 0; font-size: 16px; font-weight: 700; white-space: nowrap; }
    .wa-title p { margin: 1px 0 0; font-size: 12px; color: var(--wa-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wa-new { font-size: 9.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: 1px 7px; border-radius: 10px;
      background: var(--wa-accent); color: var(--po-accent-on, #fff); }
    .wa-actions { display: flex; align-items: center; gap: 6px; }
    .wa-seg { display: inline-flex; padding: 2px; gap: 2px; border: 1px solid var(--wa-border); border-radius: 9px; }
    .wa-seg button { border: 0; background: transparent; color: var(--wa-muted); font-size: 12.5px; padding: 4px 10px; border-radius: 7px;
      display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
    .wa-seg button.on { background: var(--po-accent-muted-bg, rgba(99,102,241,.14)); color: var(--wa-accent); font-weight: 600; }
    .wa-icon { width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--wa-border); background: transparent; color: inherit;
      display: inline-grid; place-items: center; cursor: pointer; }
    .wa-icon:hover, .wa-seg button:not(.on):hover { background: var(--wa-hover); }

    .wa-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 0 18px 10px; border-bottom: 1px solid var(--wa-border); }
    .wa-search { flex: 1 1 240px; max-width: 360px; display: flex; align-items: center; gap: 7px; padding: 5px 10px; border-radius: 8px; margin: 0;
      border: 1px solid var(--wa-border); background: var(--wa-raised); }
    .wa-search:focus-within { border-color: var(--wa-accent); }
    .wa-search .ti { color: var(--wa-faint); }
    .wa-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: inherit; font-size: 13px; }
    .wa-filters { display: flex; flex-wrap: wrap; gap: 6px; }
    .wa-filter { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 4px 10px; border-radius: 999px; cursor: pointer;
      border: 1px solid var(--wa-border); background: transparent; color: var(--wa-muted); }
    .wa-filter b { font-weight: 600; color: var(--po-text-primary, inherit); font-variant-numeric: tabular-nums; }
    .wa-filter:hover:not(:disabled) { background: var(--wa-hover); }
    .wa-filter.on { border-color: var(--wa-accent); color: var(--wa-accent); background: var(--po-accent-muted-bg, rgba(99,102,241,.12)); }
    .wa-filter.on b { color: var(--wa-accent); }
    .wa-filter:disabled { opacity: .45; cursor: default; }
    .wa-link { border: 0; background: transparent; color: var(--wa-accent); font-size: 12px; cursor: pointer; padding: 4px 2px; margin-left: auto; }
    .wa-link:hover { text-decoration: underline; }

    .wa-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; display: inline-block; }
    .d-waiting { background: var(--wa-warning); } .d-error { background: var(--wa-error); }
    .d-idle { background: var(--wa-accent); } .d-working { background: var(--wa-success); }

    .wa-body { flex: 1; min-height: 0; overflow: auto; padding: 10px 18px 14px; }
    .wa-empty { height: 100%; min-height: 220px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; text-align: center; color: var(--wa-muted); }
    .wa-empty .ti { font-size: 30px; color: var(--wa-faint); }
    .wa-empty strong { color: var(--po-text-primary, inherit); font-size: 14px; }
    .wa-empty p { margin: 0; font-size: 12.5px; max-width: 42ch; }
    .wa-empty .wa-link { margin: 0; }

    .wa-section + .wa-section { margin-top: 10px; }
    .wa-section-head { width: 100%; display: flex; align-items: center; gap: 8px; padding: 6px; border: 0; border-radius: 7px; color: inherit;
      cursor: pointer; text-align: left; background: transparent; font-size: 11.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
    .wa-section-head.static { cursor: default; }
    .wa-section-head:not(.static):hover { background: var(--wa-hover); }
    .wa-section-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; color: var(--wa-muted); }
    .wa-folder-ic { font-size: 15px; color: var(--wa-faint); }
    .wa-section-head .wa-group-counts { text-transform: none; letter-spacing: 0; font-weight: 500; }
    .wa-section-body { padding-left: 18px; display: flex; flex-direction: column; gap: 4px; margin-top: 2px; }
    .wa-section-body.flat { padding-left: 0; }
    .wa-ws-ic { font-size: 14px; color: var(--wa-faint); }
    .wa-group-head.static { cursor: default; }
    .wa-section-head.static, .wa-group-head.static { padding-left: 28px; }
    .wa-group-head { width: 100%; display: flex; align-items: center; gap: 8px; padding: 6px; border: 0; border-radius: 7px;
      color: inherit; cursor: pointer; text-align: left; background: transparent; }
    .wa-group-head:not(.static):hover { background: var(--wa-hover); }
    .wa-chev { font-size: 14px; color: var(--wa-faint); }
    .wa-folder-dot { width: 8px; height: 8px; border-radius: 2px; flex: none; background: var(--wa-faint); display: inline-block; }
    .wa-group-title { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .wa-group-folder { font-size: 11.5px; color: var(--wa-faint); white-space: nowrap; }
    .wa-group-counts { margin-left: auto; display: flex; gap: 10px; flex: none; }
    .wa-count { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--wa-muted); font-variant-numeric: tabular-nums; }

    .wa-rows { list-style: none; margin: 2px 0 0; padding: 0 0 0 22px; display: flex; flex-direction: column; }
    .wa-row { display: grid; grid-template-columns: 104px 18px minmax(0, 1fr) auto auto; align-items: center; gap: 10px; padding: 6px 8px;
      border-radius: 8px; border: 1px solid transparent; }
    .wa-row:hover { background: var(--wa-hover); }
    .wa-row.sel { border-color: var(--wa-accent); background: var(--po-accent-muted-bg, rgba(99,102,241,.08)); }
    .wa-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; white-space: nowrap; }
    .s-waiting { color: var(--wa-warning); } .s-error { color: var(--wa-error); } .s-idle { color: var(--wa-accent); } .s-working { color: var(--wa-success); }
    .wa-logo-wrap { width: 18px; display: inline-grid; place-items: center; }
    .wa-logo-wrap img, .wa-card-top img { border-radius: 4px; flex: none; }
    .wa-who { display: flex; flex-direction: column; min-width: 0; }
    .wa-who strong, .wa-card-top strong { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wa-who small { font-size: 11.5px; color: var(--wa-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wa-fresh-tag { margin-left: 6px; font-size: 9.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; padding: 0 6px; border-radius: 6px;
      color: var(--wa-warning); background: var(--po-warning-bg, rgba(210,153,34,.14)); vertical-align: 1px; }
    .wa-since { font-size: 11.5px; color: var(--wa-faint); white-space: nowrap; font-variant-numeric: tabular-nums; }
    .wa-go { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 4px 10px; border-radius: 7px; cursor: pointer; white-space: nowrap;
      border: 1px solid var(--wa-border); background: transparent; color: var(--po-text-primary, inherit); }
    .wa-row:hover .wa-go, .wa-row.sel .wa-go, .wa-card:hover .wa-go, .wa-card.sel .wa-go { border-color: var(--wa-accent); color: var(--wa-accent); }
    .wa-go:hover { background: var(--wa-accent) !important; color: var(--po-accent-on, #fff) !important; border-color: var(--wa-accent) !important; }

    .wa-board { display: grid; grid-template-columns: repeat(4, minmax(200px, 1fr)); gap: 12px; min-height: 100%; }
    .wa-col { display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--wa-border); border-radius: 10px; }
    .wa-col > header { display: flex; align-items: center; gap: 7px; padding: 9px 12px; font-size: 12.5px; font-weight: 600; border-bottom: 1px solid var(--wa-border); }
    .wa-col > header small { margin-left: auto; font-weight: 600; color: var(--wa-faint); font-variant-numeric: tabular-nums; }
    .wa-col-body { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
    .wa-card { display: flex; flex-direction: column; gap: 5px; padding: 10px; border-radius: 8px; min-width: 0; border: 1px solid var(--wa-border); background: var(--wa-raised); }
    .wa-card:hover { background: var(--wa-hover); }
    .wa-card.sel { border-color: var(--wa-accent); }
    .wa-card-top { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .wa-card-top .wa-fresh-tag { margin-left: auto; }
    .wa-card-ws { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--wa-muted); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wa-card-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 3px; }
    .wa-col-empty { margin: 0; font-size: 12px; color: var(--wa-faint); padding: 6px 4px; }

    .wa-foot { display: flex; align-items: center; gap: 14px; padding: 7px 18px; border-top: 1px solid var(--wa-border); font-size: 11.5px; color: var(--wa-faint); flex-wrap: wrap; }
    .wa-foot-brand { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; }
    kbd { font: 600 10.5px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 0 5px; border-radius: 4px; border: 1px solid var(--wa-border); color: var(--wa-muted); background: transparent; margin-right: 3px; box-shadow: none; }

    @media (max-width: 980px) {
      .wa-board { grid-template-columns: repeat(2, minmax(180px, 1fr)); }
      .wa-row { grid-template-columns: 92px minmax(0, 1fr) auto; }
      .wa-row .wa-logo-wrap, .wa-row .wa-since { display: none; }
      .wa-go span { display: none; }
      .wa-foot span:not(.wa-foot-brand) { display: none; }
    }
  `],
})
export class AgentsDashboardViewComponent {
  readonly wa = inject(AgentsDashboardService);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly statuses = STATUS_ORDER;
  readonly label = STATUS_LABEL;
  readonly selected = signal<string | null>(null);
  /** A row was picked by the user (click or arrows). */
  private picked = false;
  private searchRef = viewChild<ElementRef<HTMLInputElement>>('search');
  private bodyRef = viewChild<ElementRef<HTMLElement>>('body');

  readonly allCollapsed = computed(() => {
    const g = this.wa.groups();
    return g.length > 0 && this.wa.sections().every((sec) => !sec.open || sec.groups.every((x) => !x.open || !x.workspaceId));
  });

  readonly subtitle = computed(() => {
    const c = this.wa.counts();
    const ws = new Set(this.wa.agents().map((a) => a.groupKey)).size;
    if (!c.all) return 'Nothing running right now';
    const parts = [`${c.all} active ${c.all === 1 ? 'agent' : 'agents'} in ${ws} ${ws === 1 ? 'workspace' : 'workspaces'}`];
    if (c.waiting) parts.push(`${c.waiting} ${c.waiting === 1 ? 'needs' : 'need'} you`);
    if (c.fresh) parts.push(`${c.fresh} changed since your last look`);
    return parts.join(' · ');
  });

  constructor() {
    // The selection stays valid: if the agent disappears or is filtered out, it moves to the first visible one.
    effect(() => {
      const order = this.wa.navOrder();
      const sel = this.selected();
      if (!order.length) { if (sel) this.selected.set(null); return; }
      // Until the user picks one, the selection follows the first (most urgent) row.
      if (!this.picked || !sel || !order.some((a) => a.key === sel)) this.selected.set(order[0].key);
    });
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    const typing = !!t?.closest('input, textarea, select, [contenteditable="true"], .xterm');
    if (e.key === 'Escape' && !typing) { this.wa.close(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    // Only with the focus in the panel or nowhere: Enter on a button elsewhere belongs to that button.
    if (t && t !== document.body && !this.host.nativeElement.contains(t)) return;
    if (t?.closest('button') && e.key === 'Enter') return;
    if (e.key === '/') { e.preventDefault(); this.searchRef()?.nativeElement.focus(); return; }
    this.navigate(e);
  }

  onSearchKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (this.wa.query()) this.wa.query.set('');
      else (e.target as HTMLInputElement).blur();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') this.navigate(e);
  }

  private navigate(e: KeyboardEvent): void {
    const order = this.wa.navOrder();
    if (!order.length) return;
    const i = Math.max(0, order.findIndex((a) => a.key === this.selected()));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = order[Math.min(order.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      this.pick(next.key);
      queueMicrotask(() => this.bodyRef()?.nativeElement.querySelector(`[data-key="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: 'nearest' }));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.wa.goTo(order[i]);
    }
  }

  pick(key: string): void {
    this.picked = true;
    this.selected.set(key);
  }

  reset(): void {
    this.wa.query.set('');
    this.wa.filter.set('all');
  }

  logo(a: AwayAgent): string | null {
    return PROVIDER_LOGO[a.provider] ?? null;
  }

  providerName(a: AwayAgent): string {
    return PROVIDER_LABELS[a.provider] ?? a.provider;
  }

  ago(ms: number): string {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h} h ${m % 60} min ago` : `${Math.floor(h / 24)} d ago`;
  }
}
