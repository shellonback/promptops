import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { AgentWorktreeService } from '../services/agent-worktree.service';
import { GitWorktree } from '../services/git.service';

/** Worktree creation: same form on the agent card and in the spawn composer. */
@Component({
  selector: 'app-worktree-create-form',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  template: `
    <div class="wt-create" (click)="$event.stopPropagation()">
      @if (repos().length > 1) {
        <label class="wt-field">
          <span>{{ 'SESSIONS.AGENT_WORKTREE.Repo' | translate }}</span>
          <select class="wt-input" [ngModel]="repoPath()" (ngModelChange)="selectRepo($event)">
            @for (repo of repos(); track repo.path) {
              <option [ngValue]="repo.path">{{ repo.name }}</option>
            }
          </select>
        </label>
      }
      <input
        class="wt-input"
        type="text"
        [(ngModel)]="branch"
        [placeholder]="'SESSIONS.AGENT_WORKTREE.NamePlaceholder' | translate"
        (keydown.enter)="$event.stopPropagation(); submit()"
      />
      <label class="wt-field">
        <span>{{ 'SESSIONS.AGENT_WORKTREE.StartFrom' | translate }}</span>
        <select class="wt-input" [ngModel]="startFrom()" (ngModelChange)="startFrom.set($event)">
          @for (ref of startPoints(); track ref) {
            <option [ngValue]="ref">{{ ref }}</option>
          }
        </select>
      </label>
      <ng-content></ng-content>
      <div class="wt-actions">
        <button type="button" class="wt-btn" (click)="canceled.emit()">{{ 'SESSIONS.WORKTREES.Cancel' | translate }}</button>
        <button type="button" class="wt-btn primary" [disabled]="!branch.trim() || busy() || disabled()" (click)="submit()">
          {{ 'SESSIONS.WORKTREES.Create' | translate }}
        </button>
      </div>
      @if (error()) { <div class="wt-error">{{ error() }}</div> }
    </div>
  `,
  styles: [`
    .wt-create { display: flex; flex-direction: column; gap: 0.25rem; padding: 0.3rem 0.35rem; font-size: 0.66rem; color: var(--po-text-secondary, #9ca3af); }
    .wt-field { display: flex; align-items: center; gap: 0.35rem; margin: 0; }
    .wt-field span { flex: none; }
    .wt-input {
      width: 100%; min-width: 0; padding: 0.2rem 0.35rem; font-size: 0.68rem; color: var(--po-text-primary, inherit);
      background: var(--po-bg-0, transparent); border: 1px solid var(--po-border, #30363d); border-radius: 4px; outline: none;
    }
    .wt-input:focus { border-color: var(--po-accent, #6366F1); }
    .wt-actions { display: flex; justify-content: flex-end; gap: 0.25rem; }
    .wt-btn {
      padding: 0.12rem 0.45rem; font-size: 0.66rem; color: var(--po-text-primary, inherit);
      background: transparent; border: 1px solid var(--po-border, #30363d); border-radius: 4px; cursor: pointer;
    }
    .wt-btn.primary { color: var(--po-accent-on, #fff); background: var(--po-accent, #6366F1); border-color: var(--po-accent, #6366F1); }
    .wt-btn:disabled { opacity: 0.5; cursor: default; }
    .wt-error { font-size: 0.64rem; color: var(--po-error, #f85149); overflow-wrap: anywhere; }
  `],
})
export class WorktreeCreateFormComponent implements OnInit {
  private service = inject(AgentWorktreeService);

  cwd = input.required<string>();
  disabled = input(false);
  /** Suggested repo: the one the agent already works in. */
  preferredRepo = input<string | undefined>();
  created = output<GitWorktree>();
  canceled = output<void>();

  branch = '';
  busy = signal(false);
  error = signal<string | null>(null);
  repoPath = signal('');
  startFrom = signal('');

  repos = computed(() => this.service.reposOf(this.cwd()));
  startPoints = computed(() => this.service.startPoints(this.cwd(), this.repoPath()));

  ngOnInit(): void {
    const repos = this.repos();
    this.selectRepo(repos.find(r => r.path === this.preferredRepo())?.path ?? repos[0]?.path ?? '');
  }

  selectRepo(path: string): void {
    this.repoPath.set(path);
    this.startFrom.set(this.startPoints()[0] ?? '');
  }

  async submit(): Promise<void> {
    if (!this.branch.trim() || this.busy() || this.disabled()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await this.service.create(this.cwd(), this.repoPath(), this.branch, this.startFrom());
      if (res.ok && res.worktree) this.created.emit(res.worktree);
      else this.error.set(res.error ?? 'Worktree add failed');
    } finally {
      this.busy.set(false);
    }
  }
}
