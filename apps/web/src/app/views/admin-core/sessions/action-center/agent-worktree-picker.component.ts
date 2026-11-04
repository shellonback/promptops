import { Component, CUSTOM_ELEMENTS_SCHEMA, HostListener, computed, effect, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { EscCloseDirective } from '../../../../common/esc-close.directive';
import { TooltipDirective } from '../../../../common/tooltip.directive';
import { AgentWorktreeService } from '../services/agent-worktree.service';
import { GitWorktree } from '../services/git.service';
import { SubAgent } from '../services/sub-agent.service';
import { WorktreeCreateFormComponent } from './worktree-create-form.component';

/** Worktree row of the agent card in the right sidebar. */
@Component({
  selector: 'app-agent-worktree-picker',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, TooltipDirective, EscCloseDirective, WorktreeCreateFormComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    @if (list(); as worktrees) {
      <div class="wt-picker" (click)="$event.stopPropagation()">
        @if (showSelected()) {
          <button
            class="wt-chip"
            [class.open]="open()"
            [disabled]="!canOpen()"
            (click)="toggle()"
            [appTooltip]="service.cwdOf(agent()) || ''"
          >
            <iconify-icon icon="mdi:pine-tree" width="12"></iconify-icon>
            <span class="wt-chip-name">{{ current() ? service.title(current()!) : '' }}</span>
            @if (current(); as wt) {
              @if (wt.ahead) { <span class="wt-sync">↑{{ wt.ahead }}</span> }
              @if (wt.behind) { <span class="wt-sync">↓{{ wt.behind }}</span> }
              @if (wt.changes) { <span class="wt-chip-changes">{{ wt.changes }}</span> }
            }
            @if (shared() > 1) {
              <span class="wt-chip-shared" [appTooltip]="'SESSIONS.AGENT_WORKTREE.SharedTip' | translate">
                {{ 'SESSIONS.AGENT_WORKTREE.Shared' | translate: { count: shared() } }}
              </span>
            }
          </button>
        }

        @if (open()) {
          <div class="wt-bar" appEscClose (escClose)="close()">
            @if (creating()) {
              <app-worktree-create-form
                [cwd]="listCwd()!"
                [preferredRepo]="current()?.repoPath"
                [disabled]="busy() || service.isBusy(agent())"
                (created)="onCreated($event)"
                (canceled)="creating.set(false)"
              >
                <span class="wt-note">{{ (service.losesConversation(agent()) ? 'SESSIONS.AGENT_WORKTREE.CreateRestartHint' : 'SESSIONS.AGENT_WORKTREE.CreateHint') | translate }}</span>
              </app-worktree-create-form>
            } @else {
              <div class="wt-row">
                <select
                  class="wt-input"
                  [ngModel]="selectedPath()"
                  (ngModelChange)="onSelect($event)"
                  [disabled]="busy() || service.isBusy(agent())"
                  [appTooltip]="service.isBusy(agent()) ? ('SESSIONS.AGENT_WORKTREE.Busy' | translate) : ''"
                >
                  @if (!current()) {
                    <option value="" disabled>{{ 'SESSIONS.AGENT_WORKTREE.Select' | translate }}</option>
                  }
                  @for (wt of list(); track wt.path) {
                    <option [value]="wt.path" [disabled]="wt.prunable">{{ optionLabel(wt) }}</option>
                  }
                </select>
                <button class="wt-add" (click)="creating.set(true)" [appTooltip]="'SESSIONS.WORKTREES.New' | translate">
                  <iconify-icon icon="mdi:plus" width="14"></iconify-icon>
                </button>
              </div>
              @if (confirming(); as wt) {
                <div class="wt-confirm">
                  <span>{{ 'SESSIONS.AGENT_WORKTREE.RestartConfirm' | translate }}</span>
                  <div class="wt-actions">
                    <button class="wt-btn" (click)="confirming.set(null)">{{ 'SESSIONS.WORKTREES.Cancel' | translate }}</button>
                    <button class="wt-btn primary" [disabled]="busy()" (click)="apply(wt)">{{ 'SESSIONS.AGENT_WORKTREE.Switch' | translate }}</button>
                  </div>
                </div>
              }
            }
            @if (error()) { <div class="wt-error">{{ error() }}</div> }
          </div>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: block; flex: 0 0 100%; min-width: 0; order: 1; }
    .wt-picker { min-width: 0; }
    .wt-chip {
      display: flex; align-items: center; gap: 0.3rem; width: 100%; min-width: 0; margin-top: 0.25rem;
      padding: 0.15rem 0.35rem; font-size: 0.68rem; color: var(--po-text-secondary, #9ca3af);
      background: var(--po-bg-1, transparent); border: 1px solid var(--po-border-subtle, #30363d);
      border-radius: 4px; cursor: pointer;
    }
    .wt-chip:hover:not(:disabled), .wt-chip.open { border-color: var(--po-accent, #6366F1); }
    .wt-chip:disabled { cursor: default; }
    .wt-chip-name { flex: 1; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wt-chip-changes { color: var(--po-warning, #d29922); font-variant-numeric: tabular-nums; }
    .wt-chip-shared { color: var(--po-warning, #d29922); white-space: nowrap; }
    .wt-bar { margin-top: 0.25rem; min-width: 0; }
    .wt-row { display: flex; align-items: center; gap: 0.25rem; min-width: 0; }
    .wt-add {
      flex: none; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;
      color: var(--po-accent, #6366F1); background: transparent;
      border: 1px solid var(--po-border, #30363d); border-radius: 4px; cursor: pointer;
    }
    .wt-add:hover { border-color: var(--po-accent, #6366F1); }
    .wt-sync { flex: none; color: var(--po-text-secondary, #9ca3af); font-variant-numeric: tabular-nums; }
    .wt-confirm { display: flex; flex-direction: column; gap: 0.25rem; padding: 0.3rem 0.35rem; font-size: 0.66rem; color: var(--po-text-secondary, #9ca3af); }
    .wt-actions { display: flex; justify-content: flex-end; gap: 0.25rem; }
    .wt-btn {
      padding: 0.12rem 0.45rem; font-size: 0.66rem; color: var(--po-text-primary, inherit);
      background: transparent; border: 1px solid var(--po-border, #30363d); border-radius: 4px; cursor: pointer;
    }
    .wt-btn.primary { color: var(--po-accent-on, #fff); background: var(--po-accent, #6366F1); border-color: var(--po-accent, #6366F1); }
    .wt-btn:disabled { opacity: 0.5; cursor: default; }
    .wt-input {
      flex: 1; width: 100%; min-width: 0; height: 24px; padding: 0 0.3rem; font-size: 0.68rem; color: var(--po-text-primary, inherit);
      background: var(--po-bg-1, transparent); border: 1px solid var(--po-border, #30363d); border-radius: 4px; outline: none;
    }
    .wt-input:focus { border-color: var(--po-accent, #6366F1); }
    .wt-note { padding: 0 0.1rem; font-size: 0.64rem; color: var(--po-text-secondary, #9ca3af); }
    .wt-error { padding: 0 0.35rem; font-size: 0.64rem; color: var(--po-error, #f85149); overflow-wrap: anywhere; }
  `],
})
export class AgentWorktreePickerComponent {
  protected service = inject(AgentWorktreeService);

  agent = input.required<SubAgent>();
  agents = input<SubAgent[]>([]);
  /** Session folder: while the agent is there, there is no selection to show. */
  defaultCwd = input<string | undefined>();

  open = signal(false);
  creating = signal(false);
  busy = signal(false);
  confirming = signal<GitWorktree | null>(null);
  error = signal<string | null>(null);
  /** Switch in progress: the select shows it until the outcome is known. */
  private attempt = signal<GitWorktree | null>(null);

  list = computed(() => {
    const agent = this.agent();
    const list = this.service.supports(agent) ? this.service.listFor(agent, this.defaultCwd()) : null;
    return list?.length ? list : null;
  });
  current = computed(() => this.service.currentOf(this.agent(), this.defaultCwd()));
  listCwd = computed(() => this.service.listCwd(this.agent(), this.defaultCwd()));
  selectedPath = computed(() =>
    this.attempt()?.path ?? this.confirming()?.path ?? this.current()?.path ?? '');
  available = computed(() => !!this.list());
  canOpen = computed(() => this.service.canSwitch(this.agent()));
  /** A specific selection stays visible on the card. */
  showSelected = computed(() => {
    const current = this.current();
    if (!current) return false;
    return !current.main || this.service.cwdOf(this.agent()) !== this.defaultCwd();
  });
  shared = computed(() => this.service.sharedCount(this.agent(), this.agents(), this.defaultCwd()));

  constructor() {
    // Agent status is a dependency: changes differ at the end of a turn.
    effect(() => {
      const agent = this.agent();
      const cwd = this.service.cwdOf(agent);
      const root = this.defaultCwd();
      if (cwd && this.service.supports(agent)) void this.service.load(cwd);
      if (root && root !== cwd && this.service.supports(agent)) void this.service.load(root);
    });
  }

  @HostListener('document:click')
  closeOnOutsideClick(): void {
    if (this.open()) this.close();
  }

  toggle(): void {
    if (this.open()) {
      this.close();
      return;
    }
    this.open.set(true);
    const cwd = this.listCwd();
    if (cwd) void this.service.load(cwd, true);
  }

  close(): void {
    this.open.set(false);
    this.creating.set(false);
    this.confirming.set(null);
    this.error.set(null);
  }

  optionLabel(wt: GitWorktree): string {
    const other = this.service.occupant(wt, this.agent(), this.agents(), this.defaultCwd());
    const name = this.service.title(wt);
    return other ? `${name} · ${other.title}` : name;
  }

  onSelect(path: string): void {
    const wt = this.list()?.find(w => w.path === path);
    if (wt && !wt.current) this.pick(wt);
  }

  pick(wt: GitWorktree): void {
    this.error.set(null);
    if (this.service.losesConversation(this.agent())) this.confirming.set(wt);
    else void this.apply(wt);
  }

  async apply(wt: GitWorktree): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.attempt.set(wt);
    try {
      const res = await this.service.switchTo(this.agent(), wt);
      if (res.ok) this.close();
      else this.error.set(res.error ?? 'Worktree switch failed');
    } finally {
      this.attempt.set(null);
      this.confirming.set(null);
      this.busy.set(false);
    }
  }

  /** The new worktree becomes the agent's. */
  async onCreated(wt: GitWorktree): Promise<void> {
    this.creating.set(false);
    await this.apply(wt);
  }
}
