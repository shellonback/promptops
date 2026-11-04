import { Component, CUSTOM_ELEMENTS_SCHEMA, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { ProjectFolderScan, ScannedProject } from '../services/project-folder-import.service';
import { SPAWN_PROVIDERS } from '../services/spawn-providers.const';
import { ProviderType } from '../../../../../store/sessions/session.state';

export interface ImportProjectFolderResult {
  folderName: string;
  projects: ScannedProject[];
  startSessions: boolean;
  provider: ProviderType;
}

/**
 * Preview of a "folder of projects" import: the parent folder becomes a sidebar
 * folder, every detected child project becomes a workspace inside it.
 */
@Component({
  selector: 'app-import-project-folder-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <div class="modal-header">
      <h5 class="modal-title d-flex align-items-center gap-2">
        <iconify-icon icon="solar:folder-with-files-linear" width="20"></iconify-icon>
        {{ 'SESSIONS.IMPORT_FOLDER.Title' | translate }}
      </h5>
      <button type="button" class="btn-close" (click)="modal.dismiss()" [attr.aria-label]="'BUTTONS.Cancel' | translate"></button>
    </div>

    <div class="modal-body">
      <p class="intro">
        {{ 'SESSIONS.IMPORT_FOLDER.Intro' | translate: { count: scan.projects.length } }}
      </p>
      <div class="root-path" [title]="scan.root">{{ scan.root }}</div>

      <label class="form-label mt-3" for="import-folder-name">{{ 'SESSIONS.IMPORT_FOLDER.Folder name' | translate }}</label>
      <input id="import-folder-name" class="form-control" [(ngModel)]="folderName" maxlength="100" />

      <div class="list-head mt-3">
        <span class="form-label mb-0">{{ 'SESSIONS.IMPORT_FOLDER.Workspaces' | translate }} ({{ selectedCount() }}/{{ scan.projects.length }})</span>
        <button type="button" class="btn btn-link btn-sm p-0" (click)="toggleAll()">
          {{ (allSelected() ? 'SESSIONS.IMPORT_FOLDER.Select none' : 'SESSIONS.IMPORT_FOLDER.Select all') | translate }}
        </button>
      </div>
      <ul class="project-list">
        @for (p of scan.projects; track p.path) {
          <li>
            <label class="project-row">
              <input type="checkbox" class="form-check-input" [checked]="selected().has(p.path)" (change)="toggle(p.path)" />
              <iconify-icon [attr.icon]="p.marker === 'git' ? 'solar:branching-paths-up-linear' : 'solar:folder-linear'" width="16" class="row-icon"></iconify-icon>
              <span class="project-name">{{ p.name }}</span>
              @if (existing.has(norm(p.path))) {
                <span class="tag tag-existing">{{ 'SESSIONS.IMPORT_FOLDER.Already workspace' | translate }}</span>
              }
              <span class="tag">{{ p.marker }}</span>
            </label>
          </li>
        }
      </ul>

      <div class="form-check form-switch mt-3">
        <input class="form-check-input" type="checkbox" role="switch" id="import-start-sessions" [(ngModel)]="startSessions" />
        <label class="form-check-label" for="import-start-sessions">{{ 'SESSIONS.IMPORT_FOLDER.Start sessions' | translate }}</label>
      </div>
      @if (startSessions) {
        <label class="form-label mt-2" for="import-provider">{{ 'SESSIONS.IMPORT_FOLDER.Provider' | translate }}</label>
        <select id="import-provider" class="form-select" [(ngModel)]="provider">
          @for (opt of providers; track opt.value) {
            <option [value]="opt.value">{{ opt.labelKey | translate }}</option>
          }
        </select>
      }
    </div>

    <div class="modal-footer">
      <button type="button" class="btn btn-light" (click)="modal.dismiss()">{{ 'BUTTONS.Cancel' | translate }}</button>
      <button type="button" class="btn btn-primary" [disabled]="selectedCount() === 0" (click)="confirm()">
        {{ 'SESSIONS.IMPORT_FOLDER.Confirm' | translate: { count: selectedCount() } }}
      </button>
    </div>
  `,
  styles: [`
    .intro { font-size: 0.85rem; color: var(--po-text-secondary, #6b7280); margin-bottom: 0.35rem; }
    .root-path {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.75rem;
      color: var(--po-text-secondary, #6b7280);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .list-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.35rem; }
    .project-list {
      list-style: none; margin: 0; padding: 0;
      border: 1px solid var(--po-border, rgba(127, 127, 127, 0.25));
      border-radius: 8px;
      max-height: 300px; overflow-y: auto;
    }
    .project-list li + li { border-top: 1px solid var(--po-border, rgba(127, 127, 127, 0.18)); }
    .project-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.45rem 0.65rem; margin: 0; cursor: pointer; }
    .project-row .form-check-input { margin: 0; flex-shrink: 0; }
    .row-icon { color: var(--po-text-secondary, #6b7280); flex-shrink: 0; }
    .project-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.85rem; }
    .tag {
      font-size: 0.68rem; padding: 0.05rem 0.4rem; border-radius: 4px; flex-shrink: 0;
      color: var(--po-text-secondary, #6b7280);
      border: 1px solid var(--po-border, rgba(127, 127, 127, 0.25));
    }
    .tag-existing { color: var(--po-accent, #6366F1); border-color: color-mix(in oklab, var(--po-accent, #6366F1) 40%, transparent); }
  `],
})
export class ImportProjectFolderModalComponent {
  modal = inject(NgbActiveModal);

  /** Set by the opener. */
  scan!: ProjectFolderScan;
  /** Normalised paths of workspaces that already exist (reused, not duplicated). */
  existing = new Set<string>();
  defaultProvider: ProviderType = 'claude-code-cli';

  readonly providers = SPAWN_PROVIDERS;
  folderName = '';
  startSessions = false;
  provider: ProviderType = 'claude-code-cli';

  readonly selected = signal<Set<string>>(new Set());
  readonly selectedCount = computed(() => this.selected().size);

  /** Called by the opener after setting the inputs. */
  init(): void {
    this.folderName = this.scan.rootName;
    this.provider = this.defaultProvider;
    this.selected.set(new Set(this.scan.projects.map((p) => p.path)));
  }

  norm(p: string): string {
    return (p ?? '').replace(/[\\/]+$/, '').trim();
  }

  allSelected(): boolean {
    return this.selectedCount() === this.scan.projects.length;
  }

  toggle(path: string): void {
    this.selected.update((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  toggleAll(): void {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.scan.projects.map((p) => p.path)));
  }

  confirm(): void {
    const sel = this.selected();
    if (sel.size === 0) return;
    const result: ImportProjectFolderResult = {
      folderName: this.folderName.trim() || this.scan.rootName,
      projects: this.scan.projects.filter((p) => sel.has(p.path)),
      startSessions: this.startSessions,
      provider: this.provider,
    };
    this.modal.close(result);
  }
}
