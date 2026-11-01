import { formatUiDate } from '@core/helper/ui-locale';
import {
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  inject,
  OnInit,
  OnDestroy,
  signal,
  computed,
  ChangeDetectionStrategy,
  HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { GitService, GitWorktree } from '../services/git.service';
import { GitSetupService } from '../services/git-setup.service';
import { GitSetupModalComponent } from '../git-setup-modal/git-setup-modal.component';
import { BranchMergeModalComponent } from '../branch-merge-modal/branch-merge-modal.component';
import { GitSettingsModalComponent } from '../git-settings-modal/git-settings-modal.component';
import { GitSettingsService } from '../services/git-settings.service';
import { TooltipDirective } from '../../../../common/tooltip.directive';
import { EscCloseDirective } from '../../../../common/esc-close.directive';
import { isRasterImagePath, toDataUrl } from '../services/image-file.util';
import { buildFileTree, visibleTreeRows, FileTreeNode, TreePage } from './git-file-tree';

interface GitCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  relativeDate: string;
  refs: string[];
  message: string;
  col?: number;
  color?: string;
}

interface RefBadge {
  label: string;                                   // clean display name (no origin/, no HEAD ->)
  full: string;                                    // original ref, used as track key
  type: 'head' | 'local' | 'remote' | 'tag';
  icon: string;
  synced: boolean;                                 // local branch that also exists on origin
  tooltip: string;
  ctxBranch: string;                               // branch name used for filter/checkout actions
}

interface TipInfo {
  isTip: boolean;                                  // commit is the tip of at least one branch (tags excluded)
  kind: 'none' | 'head' | 'synced' | 'local' | 'remote';  // badge variant, precedence head > synced > local > remote
  branches: string[];                              // ctxBranch values (local names + 'origin/x' for remote-only)
  synced: boolean;                                 // any local tip in sync with origin
  label: string;                                   // primary branch display name shown on the graph badge
  icon: string;                                    // graph badge icon, precomputed so the template stays dumb
  tooltip: string;
}

interface DiffFile {
  path: string;
  status: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
  expanded: boolean;
  isBinary?: boolean;
  isImage?: boolean; // raster image with no text hunks → render as preview
  oldImageUrl?: string | null;
  newImageUrl?: string | null;
  imagesLoaded?: boolean;
  loading?: boolean;
  error?: string;
  truncated?: boolean;
  linePage?: number;
}

interface DiffLine {
  type: 'add' | 'del' | 'context' | 'hunk';
  prefix: string;
  text: string;
  oldNum: number | null;
  newNum: number | null;
}

/** A review comment pinned to a single diff line, shipped back to the agent as a prompt. */
interface DiffNote {
  key: string;            // `${file}#${lineIndex}` — stable within one rendered diff
  file: string;
  line: number | null;    // new-side line number when available, else old-side
  code: string;           // the diff line content, so the agent sees what we pointed at
  text: string;           // what the user wrote
  scope: string | null;   // 'wt' for uncommitted changes, else the commit short hash
}

interface CommitStats {
  files: { path: string; changes: string }[];
  summary: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** One argument for the git mini-terminal: single-quoted, `'` written as `'"'"'`. */
export function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, `'"'"'`)}'`;
}

/** Paths to unstage: a staged rename must also unstage its source, or the
 *  deletion of the old name stays staged while the new name turns untracked. */
export function withRenameSources(files: { path: string; origPath?: string }[], fallback?: string): string[] {
  const out = files.flatMap(f => (f.origPath ? [f.path, f.origPath] : [f.path]));
  if (out.length === 0 && fallback) out.push(fallback);
  return out;
}

const GRAPH_COLORS = [
  '#58a6ff', '#3fb950', '#f0883e', '#bc8cff', '#f85149',
  '#39c5cf', '#d29922', '#a5b4fc', '#ff7eb6', '#7ee787',
  '#ffa657', '#79c0ff', '#d2a8ff', '#ff9bce', '#56d4dd',
];

@Component({
  selector: 'app-session-git-explorer',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, TooltipDirective, EscCloseDirective, GitSetupModalComponent, BranchMergeModalComponent, GitSettingsModalComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <div class="git-explorer">
      <!-- Top bar -->
      <div class="git-topbar">
        <div class="git-topbar-left">
          <iconify-icon icon="mdi:git" width="20" class="git-icon"></iconify-icon>
          <span class="git-title">Git</span>
          @if (discoveredRepos().length > 1) {
            <div class="repo-switcher">
              <select class="repo-select" [ngModel]="activeRepoPath()" (ngModelChange)="onRepoSwitch($event)">
                @for (repo of discoveredRepos(); track repo.path) {
                  <option [value]="repo.path">{{ repo.name }} ({{ repo.branch }})</option>
                }
              </select>
            </div>
          } @else if (discoveredRepos().length === 1) {
            <span class="repo-name-badge">
              <iconify-icon icon="mdi:folder-outline" width="12"></iconify-icon>
              {{ discoveredRepos()[0].name }}
            </span>
          }
          @if (currentBranch()) {
            <div class="branch-switcher">
              <button
                class="git-branch-badge branch-switch-btn"
                [class.open]="branchMenuOpen()"
                (click)="toggleBranchMenu()"
                [appTooltip]="'GIT_EXPLORER.Switch branch tooltip' | translate"
              >
                <iconify-icon icon="mdi:source-branch" width="12"></iconify-icon>
                {{ currentBranch() }}
                <iconify-icon
                  [icon]="switchingBranch() ? 'mdi:loading' : 'mdi:chevron-down'"
                  width="11"
                  [class.spinning]="switchingBranch()"
                ></iconify-icon>
              </button>
              @if (branchMenuOpen()) {
                <div class="branch-menu-backdrop" (click)="closeBranchMenu()"></div>
                <div class="branch-menu">
                  <div class="branch-menu-search">
                    <iconify-icon icon="mdi:magnify" width="13"></iconify-icon>
                    <input
                      class="branch-menu-search-input"
                      [placeholder]="'GIT_EXPLORER.Filter branches' | translate"
                      [(ngModel)]="branchFilter"
                    />
                  </div>
                  <div class="branch-menu-list">
                    <div class="branch-menu-group">{{ 'GIT_EXPLORER.Local' | translate }}</div>
                    @for (b of filteredLocalBranches(); track b) {
                      <button
                        class="branch-menu-item"
                        [class.current]="b === currentBranch()"
                        [disabled]="switchingBranch() || b === currentBranch()"
                        (click)="checkoutBranch(b)"
                      >
                        <iconify-icon
                          [icon]="b === currentBranch() ? 'mdi:check' : 'mdi:source-branch'"
                          width="12"
                        ></iconify-icon>
                        <span class="bmi-name">{{ b }}</span>
                        @if (b === currentBranch()) {
                          <span class="bmi-current">{{ 'GIT_EXPLORER.Current' | translate }}</span>
                        }
                      </button>
                    }
                    @if (filteredRemoteOnlyBranches().length > 0) {
                      <div class="branch-menu-group">{{ 'GIT_EXPLORER.Remote only' | translate }}</div>
                      @for (b of filteredRemoteOnlyBranches(); track b) {
                        <button
                          class="branch-menu-item remote"
                          [disabled]="switchingBranch()"
                          (click)="checkoutBranch(b)"
                          [appTooltip]="'GIT_EXPLORER.Checkout as local' | translate: { branch: b }"
                        >
                          <iconify-icon icon="mdi:cloud-outline" width="12"></iconify-icon>
                          <span class="bmi-name">{{ stripRemote(b) }}</span>
                        </button>
                      }
                    }
                    @if (filteredLocalBranches().length === 0 && filteredRemoteOnlyBranches().length === 0) {
                      <div class="branch-menu-empty">{{ 'GIT_EXPLORER.No branches match' | translate: { filter: branchFilter } }}</div>
                    }
                  </div>
                  <div class="branch-menu-footer">
                    @if (!createBranchOpen()) {
                      <button class="btn-new-branch" (click)="createBranchOpen.set(true)">
                        <iconify-icon icon="mdi:plus" width="13"></iconify-icon>
                        <span [innerHTML]="'GIT_EXPLORER.New branch from' | translate: { branch: esc(currentBranch()) }"></span>
                      </button>
                    } @else {
                      <div class="new-branch-form">
                        <input
                          class="new-branch-input"
                          placeholder="feature/my-branch"
                          [ngModel]="git.newBranchName()"
                          (ngModelChange)="git.newBranchName.set($event)"
                          (keydown.enter)="doCreateBranch()"
                        />
                        @if (provider) {
                          <button
                            class="btn-branch-ai"
                            (click)="generateBranchName()"
                            [disabled]="git.generatingBranchName()"
                            [appTooltip]="'GIT_EXPLORER.AI branch name' | translate"
                          >
                            <iconify-icon icon="solar:magic-stick-3-bold-duotone" width="13" [class.spinning]="git.generatingBranchName()"></iconify-icon>
                          </button>
                        }
                        <button
                          class="btn-branch-create"
                          (click)="doCreateBranch()"
                          [disabled]="!git.newBranchName().trim() || creatingBranch()"
                        >
                          <iconify-icon [icon]="creatingBranch() ? 'mdi:loading' : 'mdi:check'" width="13" [class.spinning]="creatingBranch()"></iconify-icon>
                          {{ 'GIT_EXPLORER.Create' | translate }}
                        </button>
                      </div>
                      <div class="new-branch-hint">
                        <span [innerHTML]="'GIT_EXPLORER.Created from' | translate: { branch: esc(currentBranch()) }"></span>
                      </div>
                      @if (git.syncError()) {
                        <div class="new-branch-error">{{ git.syncError() }}</div>
                      }
                    }
                  </div>
                </div>
              }
            </div>
          }
          @if (isRepo()) {
            <div class="branch-switcher">
              <button
                class="git-branch-badge branch-switch-btn wt-switch-btn"
                [class.open]="worktreeMenuOpen()"
                [class.in-linked]="activeWorktree() && !activeWorktree()!.main"
                (click)="toggleWorktreeMenu()"
                [appTooltip]="'SESSIONS.WORKTREES.Tooltip' | translate"
              >
                <iconify-icon icon="mdi:file-tree-outline" width="12"></iconify-icon>
                @if (activeWorktree() && !activeWorktree()!.main) {
                  {{ activeWorktree()!.name }}
                } @else {
                  {{ 'SESSIONS.WORKTREES.Button' | translate }}
                }
                @if (worktrees().length > 1) {
                  <span class="wt-count">{{ worktrees().length }}</span>
                }
                <iconify-icon icon="mdi:chevron-down" width="11"></iconify-icon>
              </button>
              @if (worktreeMenuOpen()) {
                <div class="branch-menu-backdrop" (click)="closeWorktreeMenu()"></div>
                <div class="branch-menu wt-menu" appEscClose (escClose)="closeWorktreeMenu()">
                  <div class="branch-menu-list">
                    <div class="branch-menu-group wt-group">
                      <span>{{ 'SESSIONS.WORKTREES.Title' | translate }}</span>
                      <button class="wt-icon-btn" (click)="loadWorktrees()" [disabled]="worktreesLoading()" [appTooltip]="'SESSIONS.WORKTREES.Refresh' | translate">
                        <iconify-icon icon="mdi:refresh" width="12" [class.spinning]="worktreesLoading()"></iconify-icon>
                      </button>
                    </div>
                    @if (worktreesLoading() && worktrees().length === 0) {
                      <div class="branch-menu-empty">{{ 'SESSIONS.WORKTREES.Loading' | translate }}</div>
                    }
                    @for (wt of worktrees(); track wt.path) {
                      <div class="wt-row" [class.current]="wt.current" [class.missing]="wt.prunable">
                        <button
                          class="branch-menu-item wt-main"
                          [disabled]="wt.current || wt.prunable || wt.bare || !!wtBusy()"
                          (click)="openWorktree(wt)"
                          [appTooltip]="wt.path"
                        >
                          <iconify-icon [icon]="wt.current ? 'mdi:check' : 'mdi:folder-outline'" width="12"></iconify-icon>
                          <span class="wt-text">
                            <span class="bmi-name">{{ wt.name }}</span>
                            <span class="wt-sub">
                              <iconify-icon icon="mdi:source-branch" width="10"></iconify-icon>
                              {{ wt.branch || (('SESSIONS.WORKTREES.Detached' | translate) + ' ' + wt.shortHead) }}
                            </span>
                          </span>
                          @if (wt.main) { <span class="wt-tag">{{ 'SESSIONS.WORKTREES.Main' | translate }}</span> }
                          @if (wt.current) { <span class="bmi-current">{{ 'SESSIONS.WORKTREES.Current' | translate }}</span> }
                          @if (wt.locked) {
                            <iconify-icon class="wt-lock" icon="mdi:lock-outline" width="11" [appTooltip]="wt.lockReason || ('SESSIONS.WORKTREES.Locked' | translate)"></iconify-icon>
                          }
                          @if (wt.prunable) {
                            <span class="wt-tag warn">{{ 'SESSIONS.WORKTREES.Missing' | translate }}</span>
                          } @else if (wt.changes !== null) {
                            <span class="wt-changes" [class.dirty]="wt.changes > 0">
                              {{ wt.changes > 0 ? ('SESSIONS.WORKTREES.Changes' | translate: { count: wt.changes }) : ('SESSIONS.WORKTREES.Clean' | translate) }}
                            </span>
                          }
                        </button>
                        @if (!wt.main && !wt.current && !wt.prunable) {
                          <button class="wt-icon-btn danger" [disabled]="!!wtBusy()" (click)="askRemoveWorktree(wt)" [appTooltip]="'SESSIONS.WORKTREES.Remove' | translate">
                            <iconify-icon icon="mdi:trash-can-outline" width="13"></iconify-icon>
                          </button>
                        }
                      </div>
                      @if (wtConfirm()?.path === wt.path) {
                        <div class="wt-confirm">
                          <span>{{ (wtConfirm()!.force ? 'SESSIONS.WORKTREES.ConfirmForce' : 'SESSIONS.WORKTREES.ConfirmRemove') | translate: { name: wt.name } }}</span>
                          <div class="wt-confirm-actions">
                            <button class="wt-btn" (click)="wtConfirm.set(null)">{{ 'SESSIONS.WORKTREES.Cancel' | translate }}</button>
                            <button class="wt-btn danger" [disabled]="!!wtBusy()" (click)="removeWorktree(wt, wtConfirm()!.force)">
                              <iconify-icon [icon]="wtBusy() === wt.path ? 'mdi:loading' : 'mdi:trash-can-outline'" width="12" [class.spinning]="wtBusy() === wt.path"></iconify-icon>
                              {{ (wtConfirm()!.force ? 'SESSIONS.WORKTREES.ForceBtn' : 'SESSIONS.WORKTREES.RemoveBtn') | translate }}
                            </button>
                          </div>
                        </div>
                      }
                    }
                    @if (!worktreesLoading() && worktrees().length === 1) {
                      <div class="branch-menu-empty">{{ 'SESSIONS.WORKTREES.Empty' | translate }}</div>
                    } @else if (worktrees().length > 1) {
                      <div class="wt-hint">{{ 'SESSIONS.WORKTREES.Hint' | translate }}</div>
                    }
                  </div>
                  <div class="branch-menu-footer">
                    @if (hasPrunable()) {
                      <button class="wt-btn" [disabled]="!!wtBusy()" (click)="pruneWorktrees()">
                        <iconify-icon icon="mdi:broom" width="12"></iconify-icon>
                        {{ 'SESSIONS.WORKTREES.Prune' | translate }}
                      </button>
                    }
                    @if (!wtCreateOpen()) {
                      <button class="btn-new-branch" (click)="openWorktreeCreate()">
                        <iconify-icon icon="mdi:plus" width="13"></iconify-icon>
                        {{ 'SESSIONS.WORKTREES.New' | translate }}
                      </button>
                    } @else {
                      <input
                        class="new-branch-input"
                        [placeholder]="'feature/my-branch'"
                        [(ngModel)]="wtBranch"
                        (ngModelChange)="onWorktreeBranchChange()"
                        (keydown.enter)="createWorktree()"
                      />
                      <input
                        class="new-branch-input"
                        [placeholder]="'SESSIONS.WORKTREES.PathPlaceholder' | translate"
                        [(ngModel)]="wtPath"
                        (ngModelChange)="wtPathTouched = true"
                        (keydown.enter)="createWorktree()"
                      />
                      <label class="wt-check">
                        <input type="checkbox" [(ngModel)]="wtNewBranch" />
                        {{ 'SESSIONS.WORKTREES.NewBranch' | translate: { base: currentBranch() } }}
                      </label>
                      <div class="new-branch-form">
                        <button class="wt-btn" (click)="wtCreateOpen.set(false)">{{ 'SESSIONS.WORKTREES.Cancel' | translate }}</button>
                        <button
                          class="btn-branch-create"
                          (click)="createWorktree()"
                          [disabled]="!wtBranch.trim() || !wtPath.trim() || wtBusy() === 'create'"
                        >
                          <iconify-icon [icon]="wtBusy() === 'create' ? 'mdi:loading' : 'mdi:check'" width="13" [class.spinning]="wtBusy() === 'create'"></iconify-icon>
                          {{ 'SESSIONS.WORKTREES.Create' | translate }}
                        </button>
                      </div>
                    }
                    @if (wtError()) {
                      <div class="new-branch-error">{{ wtError() }}</div>
                    }
                  </div>
                </div>
              }
            </div>
          }
          @if (commits().length > 0) {
            <span class="git-count-badge">{{ 'GIT_EXPLORER.Commits count' | translate: { count: commits().length } }}</span>
            <iconify-icon
              icon="mdi:help-circle-outline" width="14" class="graph-legend-hint"
              [appTooltip]="graphLegendText"
            ></iconify-icon>
          }
          @if ((git.totalChanges() ?? 0) > 0) {
            <span class="git-changes-badge">{{ 'GIT_EXPLORER.Changes count' | translate: { count: git.totalChanges() ?? 0 } }}</span>
          }
          @if (originRemote(); as r) {
            <span class="git-origin-badge" [class.ssh]="r.type === 'ssh'" [class.https]="r.type === 'https'" [appTooltip]="r.url">
              <iconify-icon [icon]="r.type === 'ssh' ? 'mdi:shield-key' : 'mdi:web'" width="12"></iconify-icon>
              <span class="git-origin-host">{{ r.host || 'origin' }}</span>
              <span class="git-origin-type">{{ r.type }}</span>
            </span>
          }
        </div>

        <!-- Center: Stash / Pop / Pull / Push -->
        <div class="git-topbar-center">
          <div class="topbar-actions-group">
            <button class="btn-topbar-square" (click)="doStash()" [disabled]="stashing()" [appTooltip]="'SESSIONS.TOOLTIPS.Stash' | translate">
              <iconify-icon icon="mdi:tray-arrow-down" width="17" [class.spinning]="stashing()"></iconify-icon>
              <span class="btn-square-label">{{ 'GIT_EXPLORER.Stash' | translate }}</span>
            </button>
            <button class="btn-topbar-square" (click)="doStashPop()" [disabled]="stashPopping()" [appTooltip]="'SESSIONS.TOOLTIPS.Stash pop' | translate">
              <iconify-icon icon="mdi:tray-arrow-up" width="17" [class.spinning]="stashPopping()"></iconify-icon>
              <span class="btn-square-label">{{ 'GIT_EXPLORER.Pop' | translate }}</span>
            </button>
            <button class="btn-topbar-square" (click)="doPull()" [disabled]="git.pulling()" [appTooltip]="'SESSIONS.TOOLTIPS.Pull' | translate">
              <iconify-icon icon="mdi:arrow-down-bold" width="17" [class.spinning]="git.pulling()"></iconify-icon>
              <span class="btn-square-label">{{ 'GIT_EXPLORER.Pull' | translate }}</span>
              @if ((syncInfo()?.behind ?? 0) > 0) {
                <span class="sync-count-badge behind">{{ syncInfo()!.behind }}</span>
              }
            </button>
            <button class="btn-topbar-square" (click)="doPush()" [disabled]="git.pushing()" [appTooltip]="'SESSIONS.TOOLTIPS.Push' | translate">
              <iconify-icon icon="mdi:arrow-up-bold" width="17" [class.spinning]="git.pushing()"></iconify-icon>
              <span class="btn-square-label">{{ 'GIT_EXPLORER.Push' | translate }}</span>
              @if ((syncInfo()?.ahead ?? 0) > 0) {
                <span class="sync-count-badge ahead">{{ syncInfo()!.ahead }}</span>
              }
            </button>
          </div>
          @if (isRepo()) {
            <button class="git-sync-chip" (click)="syncNow()" [disabled]="fetching()"
                    [appTooltip]="syncInfo() ? ('GIT_EXPLORER.Fetch vs' | translate: { upstream: syncInfo()!.upstream }) : ('GIT_EXPLORER.Fetch from remote' | translate)">
              <iconify-icon [icon]="fetching() ? 'mdi:loading' : 'mdi:cloud-sync-outline'" width="13" [class.spinning]="fetching()"></iconify-icon>
              @if (syncInfo(); as s) {
                <span class="chip-ahead" [class.zero]="s.ahead === 0">↑{{ s.ahead }}</span>
                <span class="chip-behind" [class.zero]="s.behind === 0">↓{{ s.behind }}</span>
              } @else {
                <span class="chip-label">{{ 'GIT_EXPLORER.Fetch' | translate }}</span>
              }
            </button>
          }
          @if (isRepo()) {
            <button class="btn-topbar-square btn-fix-topbar" (click)="openGitSetup()" [appTooltip]="'GIT_EXPLORER.Fix setup tooltip' | translate">
              <iconify-icon icon="mdi:wrench" width="17"></iconify-icon>
              <span class="btn-square-label">{{ 'GIT_EXPLORER.Fix setup short' | translate }}</span>
            </button>
          } @else {
            <button class="btn-topbar-square btn-clone-topbar" (click)="showClonePanel.set(!showClonePanel())" [class.active]="showClonePanel()" [appTooltip]="'GIT_EXPLORER.Clone repository' | translate">
              <iconify-icon icon="mdi:source-repository" width="17"></iconify-icon>
              <span class="btn-square-label">{{ 'GIT_EXPLORER.Clone' | translate }}</span>
            </button>
          }
        </div>

        <div class="git-topbar-right">
          <div class="git-search-box">
            <iconify-icon icon="mdi:magnify" width="14"></iconify-icon>
            <input class="git-search-input" [placeholder]="'GIT_EXPLORER.Search placeholder' | translate" [(ngModel)]="searchQuery" />
            @if (searchQuery.trim()) {
              <span class="search-match-count" [class.none]="matchCount() === 0">{{ matchCount() }}</span>
            }
          </div>
          <button class="btn-git-icon" (click)="loadMore()" [appTooltip]="'SESSIONS.TOOLTIPS.Load more' | translate" [disabled]="loading()">
            <iconify-icon icon="mdi:plus-circle-outline" width="16"></iconify-icon>
          </button>
          <button class="btn-git-icon" (click)="refresh()" [appTooltip]="'SESSIONS.TOOLTIPS.Refresh' | translate" [disabled]="loading()">
            <iconify-icon icon="mdi:refresh" width="16" [class.spinning]="loading()"></iconify-icon>
          </button>
          <button class="btn-git-icon" (click)="gitSettings.open()" [appTooltip]="'GIT_EXPLORER.Git settings' | translate" [attr.aria-label]="'GIT_EXPLORER.Git settings' | translate">
            <iconify-icon icon="mdi:cog-outline" width="16"></iconify-icon>
          </button>
          <button class="btn-git-close" (click)="close()" [appTooltip]="'SESSIONS.TOOLTIPS.Close' | translate">
            <iconify-icon icon="solar:close-circle-bold" width="18"></iconify-icon>
          </button>
        </div>
      </div>

      <!-- Sync feedback -->
      @if (git.syncError()) {
        <div class="sync-banner error">
          <iconify-icon icon="mdi:alert-circle" width="14"></iconify-icon>
          <span class="sync-error-text">{{ git.syncError() }}</span>
          <button class="btn-ai-resolver-inline"
                  (click)="aiResolveSync()"
                  [disabled]="git.aiResolving()"
                  [appTooltip]="'SESSIONS.GIT_PANEL.AI resolver hint' | translate">
            <iconify-icon icon="solar:magic-stick-3-bold-duotone" width="13" [class.spinning]="git.aiResolving()"></iconify-icon>
            {{ (git.aiResolving() ? 'SESSIONS.GIT_PANEL.Resolving' : 'SESSIONS.GIT_PANEL.AI resolver') | translate }}
          </button>
          @if (isSetupError(git.syncError())) {
            <button class="btn-open-terminal btn-fix-inline" (click)="openGitSetup()">
              <iconify-icon icon="mdi:wrench" width="13"></iconify-icon>
              {{ 'SESSIONS.GIT_PANEL.Fix setup' | translate }}
            </button>
          }
          @if (!git.miniTerminalOpen()) {
            <button class="btn-open-terminal" (click)="git.openMiniTerminal()">
              <iconify-icon icon="mdi:console" width="13"></iconify-icon>
              {{ 'GIT_EXPLORER.Terminal' | translate }}
            </button>
          }
          <button class="btn-dismiss-error" (click)="git.syncError.set(null); git.closeMiniTerminal()" [attr.aria-label]="'SESSIONS.GIT_PANEL.Dismiss' | translate">
            <iconify-icon icon="mdi:close" width="12"></iconify-icon>
          </button>
        </div>
        @if (git.miniTerminalOpen()) {
          <div class="mini-terminal">
            <div class="mini-terminal-output" #miniTerminalOutput>
              @for (line of git.miniTerminalOutput(); track $index) {
                <div class="mini-terminal-line" [class.cmd]="line.startsWith('$ ')">{{ line }}</div>
              }
            </div>
            <div class="mini-terminal-input-row">
              <span class="mini-terminal-prompt">$</span>
              <input
                class="mini-terminal-input"
                placeholder="git ..."
                [(ngModel)]="miniTerminalCmd"
                (keydown.enter)="execMiniTerminal()"
                [disabled]="git.miniTerminalRunning()"
                #miniTerminalInput
              />
              <button class="btn-mini-run" (click)="execMiniTerminal()" [disabled]="git.miniTerminalRunning()">
                <iconify-icon [icon]="git.miniTerminalRunning() ? 'mdi:loading' : 'mdi:play'" width="14" [class.spinning]="git.miniTerminalRunning()"></iconify-icon>
              </button>
            </div>
          </div>
        }
      }
      <!-- AI Resolver activity: live phase while working, checked steps when done.
           Standalone so it survives the error banner clearing on success. -->
      @if (git.aiResolving() || git.aiResolveSteps().length > 0) {
        <div class="ai-resolver-log">
          @if (git.aiResolving()) {
            <div class="ai-resolver-working">
              <iconify-icon icon="solar:magic-stick-3-bold-duotone" width="14" class="spinning"></iconify-icon>
              <span>{{ git.aiResolvePhase() || ('GIT_SETUP.Working on it' | translate) }}</span>
              <span class="ai-resolver-dots"><i></i><i></i><i></i></span>
            </div>
          }
          @for (s of git.aiResolveSteps(); track $index) {
            <div class="ai-resolver-step done">
              <iconify-icon icon="mdi:check" width="12"></iconify-icon>
              <span>{{ s }}</span>
            </div>
          }
        </div>
      }
      @if (git.syncSuccess()) {
        <div class="sync-banner success">
          <iconify-icon icon="mdi:check-circle" width="14"></iconify-icon>
          {{ git.syncSuccess() }}
        </div>
      }

      <!-- Clone panel -->
      @if (showClonePanel()) {
        <div class="clone-panel">
          <div class="clone-panel-body">
            <div class="clone-field-row">
              <div class="clone-field clone-field-url">
                <label class="clone-label">{{ 'GIT_EXPLORER.Repository url' | translate }}</label>
                <input class="clone-input" placeholder="https://github.com/user/repo.git  or  git@github.com:user/repo.git" [(ngModel)]="cloneUrl" (input)="onCloneUrlChange()" />
              </div>
              <div class="clone-field clone-field-branch">
                <label class="clone-label">{{ 'GIT_EXPLORER.Branch' | translate }}</label>
                <input class="clone-input" [placeholder]="'GIT_EXPLORER.Default' | translate" [(ngModel)]="cloneBranch" />
              </div>
            </div>
            <div class="clone-field-row">
              <div class="clone-field clone-field-dest">
                <label class="clone-label">{{ 'GIT_EXPLORER.Destination' | translate }}</label>
                <div class="clone-path-row">
                  <input class="clone-input clone-path-input" [value]="getCloneFullPath()" readonly [placeholder]="'GIT_EXPLORER.Select parent folder' | translate" />
                  <button class="btn-clone-browse" (click)="pickCloneDestination()">
                    <iconify-icon icon="mdi:folder-open" width="14"></iconify-icon>
                  </button>
                </div>
              </div>
              <div class="clone-field clone-field-name">
                <label class="clone-label">{{ 'GIT_EXPLORER.Folder name' | translate }}</label>
                <input class="clone-input" [(ngModel)]="cloneDirName" />
              </div>
              <div class="clone-field clone-field-action">
                <label class="clone-label">&nbsp;</label>
                <button class="btn-clone-exec" (click)="doClone()" [disabled]="!cloneUrl.trim() || !getCloneFullPath() || git.cloning()">
                  <iconify-icon [icon]="git.cloning() ? 'mdi:loading' : 'mdi:source-repository'" width="15" [class.spinning]="git.cloning()"></iconify-icon>
                  {{ (git.cloning() ? 'GIT_EXPLORER.Cloning' : 'GIT_EXPLORER.Clone') | translate }}
                </button>
              </div>
            </div>
            @if (git.cloneError()) {
              <div class="clone-feedback error">
                <iconify-icon icon="mdi:alert-circle" width="13"></iconify-icon>
                {{ git.cloneError() }}
              </div>
            }
            @if (cloneSuccess()) {
              <div class="clone-feedback success">
                <iconify-icon icon="mdi:check-circle" width="13"></iconify-icon>
                {{ cloneSuccess() }}
              </div>
            }
          </div>
        </div>
      }

      <!-- Main 3-column layout -->
      <div class="git-content">

        <!-- ═══ LEFT SIDEBAR: Branches ═══ -->
        <div class="sidebar-left">
          <!-- LOCAL branches -->
          <div class="sb-section">
            <div class="sb-section-header" (click)="localExpanded = !localExpanded">
              <iconify-icon [icon]="localExpanded ? 'mdi:chevron-down' : 'mdi:chevron-right'" width="14"></iconify-icon>
              <iconify-icon icon="mdi:laptop" width="13"></iconify-icon>
              <span>{{ 'GIT_EXPLORER.Local' | translate }}</span>
              <span class="sb-count">{{ localBranches().length }}</span>
              <button
                class="sb-merge-btn sb-new-branch-btn"
                (click)="$event.stopPropagation(); openBranchMenuWithCreate()"
                [appTooltip]="'GIT_EXPLORER.Create branch aria' | translate"
                [attr.aria-label]="'GIT_EXPLORER.Create branch aria' | translate"
              >
                <iconify-icon icon="mdi:plus" width="11"></iconify-icon>
                {{ 'GIT_EXPLORER.New' | translate }}
              </button>
              <button
                class="sb-merge-btn"
                (click)="$event.stopPropagation(); openMergeModal()"
                [appTooltip]="'GIT_EXPLORER.Merge branches aria' | translate"
                [attr.aria-label]="'GIT_EXPLORER.Merge branches aria' | translate"
              >
                <iconify-icon icon="mdi:source-merge" width="11"></iconify-icon>
                {{ 'GIT_EXPLORER.Merge' | translate }}
              </button>
            </div>
            @if (localExpanded) {
              <div class="sb-section-body">
                @for (b of localBranches(); track b) {
                  <div
                    class="sb-branch-item"
                    [class.current]="b === currentBranch()"
                    [class.active]="selectedBranch() === b"
                    (click)="selectBranch(b)"
                    (dblclick)="checkoutBranch(b)"
                    (contextmenu)="onBranchContextMenu($event, b)"
                  >
                    <iconify-icon
                      [icon]="b === currentBranch() ? 'mdi:source-branch-check' : 'mdi:source-branch'"
                      width="12"
                      [style.color]="b === currentBranch() ? '#3fb950' : ''"
                    ></iconify-icon>
                    <span class="sb-branch-name">{{ b }}</span>
                    @if (b === currentBranch()) {
                      <span class="head-badge">HEAD</span>
                    } @else {
                      <button
                        class="sb-checkout-btn"
                        (click)="$event.stopPropagation(); checkoutBranch(b)"
                        [disabled]="switchingBranch()"
                        [appTooltip]="'GIT_EXPLORER.Checkout branch' | translate: { branch: b }"
                      >
                        <iconify-icon icon="mdi:source-branch-sync" width="11"></iconify-icon>
                      </button>
                    }
                  </div>
                }
              </div>
            }
          </div>

          <!-- REMOTE branches -->
          <div class="sb-section">
            <div class="sb-section-header" (click)="remoteExpanded = !remoteExpanded">
              <iconify-icon [icon]="remoteExpanded ? 'mdi:chevron-down' : 'mdi:chevron-right'" width="14"></iconify-icon>
              <iconify-icon icon="mdi:cloud-outline" width="13"></iconify-icon>
              <span>{{ 'GIT_EXPLORER.Remote' | translate }}</span>
              <span class="sb-count">{{ remoteBranches().length }}</span>
            </div>
            @if (remoteExpanded) {
              <div class="sb-section-body">
                @for (b of remoteBranches(); track b) {
                  <div
                    class="sb-branch-item remote"
                    [class.active]="selectedBranch() === b"
                    (click)="selectBranch(b)"
                    (contextmenu)="onBranchContextMenu($event, b)"
                  >
                    <iconify-icon icon="mdi:source-branch" width="12"></iconify-icon>
                    <span class="sb-branch-name">{{ b.replace('origin/', '') }}</span>
                    <button
                      class="sb-checkout-btn"
                      (click)="$event.stopPropagation(); checkoutBranch(b)"
                      [disabled]="switchingBranch()"
                      [appTooltip]="'GIT_EXPLORER.Checkout as local' | translate: { branch: stripRemote(b) }"
                    >
                      <iconify-icon icon="mdi:source-branch-sync" width="11"></iconify-icon>
                    </button>
                  </div>
                }
                @if (remoteBranches().length === 0) {
                  <div class="sb-empty">{{ 'GIT_EXPLORER.No remote branches' | translate }}</div>
                }
              </div>
            }
          </div>

          <!-- TAGS -->
          <div class="sb-section">
            <div class="sb-section-header" (click)="tagsExpanded = !tagsExpanded">
              <iconify-icon [icon]="tagsExpanded ? 'mdi:chevron-down' : 'mdi:chevron-right'" width="14"></iconify-icon>
              <iconify-icon icon="mdi:tag-outline" width="13"></iconify-icon>
              <span>{{ 'GIT_EXPLORER.Tags' | translate }}</span>
              <span class="sb-count">{{ tags().length }}</span>
            </div>
            @if (tagsExpanded && tags().length > 0) {
              <div class="sb-section-body">
                @for (t of tags(); track t) {
                  <div class="sb-branch-item tag">
                    <iconify-icon icon="mdi:tag" width="12"></iconify-icon>
                    <span class="sb-branch-name">{{ t }}</span>
                  </div>
                }
              </div>
            }
          </div>
        </div>

        <!-- ═══ CENTER: Commit graph + list ═══ -->
        <div class="center-panel">
          @if (historyError()) {
            <div class="center-loading">
              <iconify-icon icon="mdi:alert-circle" width="32" style="color:var(--po-error)"></iconify-icon>
              <p style="color:var(--po-error); font-size:0.75rem">{{ historyError() }}</p>
              <button class="btn-wr-commit btn-do-commit" (click)="loadHistory()" style="margin-top:0.5rem">
                <iconify-icon icon="mdi:refresh" width="14"></iconify-icon> {{ 'GIT_EXPLORER.Retry' | translate }}
              </button>
            </div>
          } @else if (loading() && commits().length === 0) {
            <div class="center-loading">
              <iconify-icon icon="mdi:refresh" width="24" class="spinning"></iconify-icon>
              <p>{{ 'GIT_EXPLORER.Loading history' | translate }}</p>
              <p style="font-size:0.6rem; color:var(--po-text-secondary); margin-top:0.5rem">cwd: {{ cwd || ('GIT_EXPLORER.Empty' | translate) }}</p>
            </div>
          } @else if (commits().length === 0) {
            <div class="center-loading">
              <iconify-icon icon="mdi:source-commit" width="32" class="text-muted"></iconify-icon>
              <p>{{ 'GIT_EXPLORER.No commits' | translate }}</p>
              <button class="btn-wr-commit btn-do-commit" (click)="loadHistory()" style="margin-top:0.5rem">
                <iconify-icon icon="mdi:refresh" width="14"></iconify-icon> {{ 'GIT_EXPLORER.Load history' | translate }}
              </button>
            </div>
          } @else {
            <div class="commit-list-scroll">
              <!-- Search/Solo never remove rows: non-matches are dimmed so the graph
                   topology (and the row↔lines pairing) stays intact. -->
              @for (commit of commits(); track commit.hash; let i = $index) {
                <div
                  class="commit-row"
                  [class.selected]="selectedCommit()?.hash === commit.hash"
                  [class.dim-row]="isDimmed(commit)"
                  (click)="selectCommit(commit)"
                >
                  <!-- Graph column -->
                  <div class="graph-cell" [style.width.px]="graphWidth()">
                    <svg [attr.width]="graphWidth()" height="38" class="graph-svg">
                      @for (line of getCommitLines(i); track $index) {
                        <line
                          [attr.x1]="line.x1" [attr.y1]="line.y1"
                          [attr.x2]="line.x2" [attr.y2]="line.y2"
                          [attr.stroke]="line.color"
                          [attr.stroke-width]="line.current ? 3 : 2"
                          [attr.opacity]="line.current || !hasCurrentChain() ? 1 : 0.55"
                          stroke-linecap="round"
                        />
                      }
                      @if (!tipInfo(commit).isTip) {
                        <!-- ordinary commit: plain dot (branch tips render the graph badge instead) -->
                        <circle
                          [attr.cx]="getCommitX(commit)" cy="19" r="5"
                          [attr.fill]="commit.color || '#58a6ff'"
                          [attr.stroke]="selectedCommit()?.hash === commit.hash ? '#fff' : 'transparent'"
                          stroke-width="2"
                        />
                        @if ((commit.parents?.length || 0) > 1) {
                          <circle
                            [attr.cx]="getCommitX(commit)" cy="19" r="8"
                            fill="none" [attr.stroke]="commit.color || '#58a6ff'"
                            stroke-width="1.5" opacity="0.5"
                          />
                        }
                        <!-- enlarged invisible hit target: right-click = commit actions -->
                        <circle
                          class="dot-hit"
                          [attr.cx]="getCommitX(commit)" cy="19" r="11" fill="transparent"
                          (click)="onDotClick($event, commit)"
                          (dblclick)="onDotDblClick($event, commit)"
                          (contextmenu)="onDotContextMenu($event, commit)"
                        >
                          <title>{{ 'GIT_EXPLORER.Commit hint' | translate: { hash: commit.shortHash } }}</title>
                        </circle>
                      }
                    </svg>
                    @if (tipInfo(commit); as tip) {
                      @if (tip.isTip) {
                        <!-- branch tip: minimal badge with the branch name, replaces the dot -->
                        <span
                          class="graph-tip-badge"
                          [class.k-head]="tip.kind === 'head'"
                          [class.k-local]="tip.kind === 'local'"
                          [class.k-synced]="tip.kind === 'synced'"
                          [class.k-remote]="tip.kind === 'remote'"
                          [class.ref-filtered]="!!selectedBranch() && tip.branches.includes(selectedBranch()!)"
                          [style.left.px]="getCommitX(commit) - 7"
                          [appTooltip]="tip.tooltip"
                          (click)="onTipBadgeClick($event, commit)"
                          (dblclick)="onDotDblClick($event, commit)"
                          (contextmenu)="onDotContextMenu($event, commit)"
                        >
                          <iconify-icon [icon]="tip.icon" width="9"></iconify-icon>
                          <span class="gtb-name">{{ tip.label }}</span>
                          @if (tip.branches.length > 1) {
                            <span class="gtb-more">+{{ tip.branches.length - 1 }}</span>
                          }
                          @if (tip.synced) {
                            <iconify-icon icon="mdi:cloud-check-outline" width="9" class="gtb-sync"></iconify-icon>
                          }
                        </span>
                      }
                    }
                  </div>

                  <!-- Commit info -->
                  <div class="commit-info">
                    <div class="commit-top">
                      @for (badge of commitBadges(commit); track badge.full) {
                        <span
                          class="ref-badge"
                          [class.ref-head]="badge.type === 'head'"
                          [class.ref-tag]="badge.type === 'tag'"
                          [class.ref-remote]="badge.type === 'remote'"
                          [class.ref-local]="badge.type === 'local'"
                          [class.ref-synced]="badge.synced"
                          [class.ref-filtered]="selectedBranch() === badge.ctxBranch"
                          [appTooltip]="badge.tooltip"
                          (click)="onBadgeClick($event, badge)"
                          (contextmenu)="onBadgeContextMenu($event, badge, commit)"
                        >
                          <iconify-icon [icon]="badge.icon" width="10"></iconify-icon>
                          {{ badge.label }}
                          @if (badge.synced) {
                            <iconify-icon icon="mdi:cloud-check-outline" width="10" class="ref-sync-icon"></iconify-icon>
                          }
                        </span>
                      }
                      @if (hiddenBadges(commit).length > 0) {
                        <span class="ref-badge ref-more" [appTooltip]="hiddenBadgesTooltip(commit)">
                          +{{ hiddenBadges(commit).length }}
                        </span>
                      }
                      @if ((commit.parents?.length || 0) > 1) {
                        <span class="merge-badge">
                          <iconify-icon icon="mdi:source-merge" width="10"></iconify-icon>
                          {{ 'GIT_EXPLORER.Merge badge' | translate }}
                        </span>
                      }
                      <span class="commit-msg">{{ commit.message }}</span>
                    </div>
                    <div class="commit-bottom">
                      <span class="commit-hash">{{ commit.shortHash }}</span>
                      <span class="commit-author">
                        <iconify-icon [icon]="providerIcon" width="13" class="commit-provider-icon" [style.color]="providerColor"></iconify-icon>
                        <span class="avatar-circle" [style.background]="getAvatarColor(commit.author)">{{ getInitials(commit.author) }}</span>
                        {{ commit.author }}
                      </span>
                      <span class="commit-date">{{ commit.relativeDate }}</span>
                    </div>
                  </div>
                </div>
              }
              @if (loading()) {
                <div class="loading-more">
                  <iconify-icon icon="mdi:refresh" width="14" class="spinning"></iconify-icon> {{ 'GIT_EXPLORER.Loading' | translate }}
                </div>
              }
            </div>
          }

          <!-- Commit detail expandable (bottom of center) -->
          @if (selectedCommit(); as commit) {
            <div class="commit-detail-pane">
              <div class="detail-pane-header">
                <span class="detail-pane-title">
                  <iconify-icon icon="mdi:source-commit" width="14"></iconify-icon>
                  {{ commit.shortHash }} — {{ commit.message | slice:0:80 }}
                </span>
                <div class="detail-pane-actions">
                  @if (commitStats(); as stats) {
                    <span class="detail-stats-mini">
                      <span class="dsm-files">{{ (stats.filesChanged === 1 ? 'GIT_EXPLORER.File count one' : 'GIT_EXPLORER.File count many') | translate: { count: stats.filesChanged } }}</span>
                      @if (stats.insertions > 0) { <span class="dsm-add">+{{ stats.insertions }}</span> }
                      @if (stats.deletions > 0) { <span class="dsm-del">-{{ stats.deletions }}</span> }
                    </span>
                  }
                  <button class="btn-git-icon-sm" (click)="closeCommitDetail()">
                    <iconify-icon icon="mdi:close" width="14"></iconify-icon>
                  </button>
                </div>
              </div>
              <div class="detail-pane-body">
                <!-- Meta info -->
                <div class="detail-meta-grid">
                  <div class="detail-meta-row">
                    <span class="dm-label">{{ 'GIT_EXPLORER.Author' | translate }}</span>
                    <span class="dm-value">
                      <span class="avatar-circle-sm" [style.background]="getAvatarColor(commit.author)">{{ getInitials(commit.author) }}</span>
                      {{ commit.author }} &lt;{{ commit.email }}&gt;
                    </span>
                  </div>
                  <div class="detail-meta-row">
                    <span class="dm-label">{{ 'GIT_EXPLORER.Date' | translate }}</span>
                    <span class="dm-value">{{ formatDate(commit.date) }}</span>
                  </div>
                  <div class="detail-meta-row">
                    <span class="dm-label">SHA</span>
                    <span class="dm-value mono">
                      {{ commit.hash }}
                      <button class="btn-copy-sha" (click)="copySha(commit.hash)" [appTooltip]="(copiedSha() ? 'GIT_EXPLORER.Copied' : 'GIT_EXPLORER.Copy sha') | translate">
                        <iconify-icon [icon]="copiedSha() ? 'mdi:check' : 'mdi:content-copy'" width="11"></iconify-icon>
                      </button>
                    </span>
                  </div>
                  @if ((commit.parents?.length || 0) > 0) {
                    <div class="detail-meta-row">
                      <span class="dm-label">{{ 'GIT_EXPLORER.Parent' | translate }}</span>
                      <span class="dm-value mono">
                        @for (p of (commit.parents || []); track p; let last = $last) {
                          <span class="parent-link" (click)="goToCommit(p)">{{ p.substring(0, 7) }}</span>{{ last ? '' : ' ' }}
                        }
                      </span>
                    </div>
                  }
                </div>

                <!-- Full commit body -->
                @if (commitBody() && commitBody() !== commit.message) {
                  <div class="commit-body-section">
                    <pre class="commit-body-text">{{ commitBody() }}</pre>
                  </div>
                }

                <!-- Stats summary bar -->
                @if (commitStats(); as stats) {
                  <div class="stats-summary-bar">
                    <div class="stats-summary-left">
                      <iconify-icon icon="mdi:file-multiple-outline" width="14"></iconify-icon>
                      <span>{{ (stats.filesChanged === 1 ? 'GIT_EXPLORER.Files changed one' : 'GIT_EXPLORER.Files changed many') | translate: { count: stats.filesChanged } }}</span>
                      @if (stats.insertions > 0) { <span class="stats-add-badge">+{{ stats.insertions }}</span> }
                      @if (stats.deletions > 0) { <span class="stats-del-badge">-{{ stats.deletions }}</span> }
                    </div>
                    <div class="stats-bar-visual">
                      <span class="bar-segment bar-add" [style.flex]="stats.insertions"></span>
                      <span class="bar-segment bar-del" [style.flex]="stats.deletions"></span>
                    </div>
                  </div>
                }

                <!-- Diff files -->
                @if (diffLoading()) {
                  <div class="diff-loading-inline"><iconify-icon icon="mdi:refresh" width="14" class="spinning"></iconify-icon> {{ 'SESSIONS.GIT_PANEL.Loading diff' | translate }}</div>
                } @else {
                  @if (commitError()) { <div class="diff-binary-note">{{ commitError() }}</div> }
                  @if (parsedDiffFiles().length > 0) {
                    <div class="stats-summary-bar history-file-controls">
                      <input type="search" [attr.aria-label]="'GIT_EXPLORER.Filter changed files' | translate" [placeholder]="'GIT_EXPLORER.Filter files' | translate"
                        [ngModel]="commitFileFilter()" (ngModelChange)="filterCommitFiles($event)" />
                      <button class="history-page-btn" [disabled]="commitFilePage() === 0" (click)="changeCommitFilePage(-1)">{{ 'GIT_EXPLORER.Previous' | translate }}</button>
                      <span>{{ commitFilePage() + 1 }} / {{ commitFilePageCount() }} · {{ (filteredCommitFiles().length === 1 ? 'GIT_EXPLORER.File count one' : 'GIT_EXPLORER.File count many') | translate: { count: filteredCommitFiles().length } }}</span>
                      <button class="history-page-btn" [disabled]="commitFilePage() + 1 >= commitFilePageCount()" (click)="changeCommitFilePage(1)">{{ 'GIT_EXPLORER.Next' | translate }}</button>
                    </div>
                    @if ((commit.parents?.length || 0) > 1) {
                      <div class="diff-binary-note">{{ 'GIT_EXPLORER.First parent' | translate }}</div>
                    }
                  }
                  @for (file of visibleCommitFiles(); track file.path) {
                    <div class="diff-file">
                      <div class="diff-file-header" (click)="toggleDiffFile(file)">
                        <iconify-icon [icon]="file.expanded ? 'mdi:chevron-down' : 'mdi:chevron-right'" width="13"></iconify-icon>
                        <iconify-icon [icon]="file.status === 'added' ? 'mdi:file-plus' : file.status === 'deleted' ? 'mdi:file-remove' : file.status === 'renamed' ? 'mdi:file-swap' : 'mdi:file-document-edit'" width="12"
                          [class]="'dficon-' + file.status"></iconify-icon>
                        <span class="diff-file-name" [title]="file.path">{{ file.path }}</span>
                        <span class="diff-file-stats">
                          @if (file.additions > 0) { <span class="stat-a">+{{ file.additions }}</span> }
                          @if (file.deletions > 0) { <span class="stat-d">-{{ file.deletions }}</span> }
                        </span>
                        <span class="diff-file-bar">
                          <span class="dfbar-add" [style.width.px]="getBarWidth(file.additions, file)"></span>
                          <span class="dfbar-del" [style.width.px]="getBarWidth(file.deletions, file)"></span>
                        </span>
                      </div>
                      @if (file.expanded) {
                        <div class="diff-file-body">
                          @if (file.loading) {
                            <div class="diff-loading-inline">{{ 'GIT_EXPLORER.Loading file' | translate }}</div>
                          } @else if (file.error) {
                            <div class="diff-binary-note">{{ file.error }}</div>
                          } @else if (file.isImage) {
                            <div class="img-diff-compare">
                              @if (!file.imagesLoaded) {
                                <div class="img-diff-empty"><iconify-icon icon="mdi:refresh" width="14" class="spinning"></iconify-icon> {{ 'GIT_EXPLORER.Loading preview' | translate }}</div>
                              } @else {
                                @if (file.oldImageUrl) {
                                  <div class="img-diff-pane">
                                    <div class="img-diff-label old">{{ (file.status === 'deleted' ? 'GIT_EXPLORER.Deleted' : 'GIT_EXPLORER.Before') | translate }}</div>
                                    <img [src]="file.oldImageUrl" [alt]="'GIT_EXPLORER.Before' | translate" />
                                  </div>
                                }
                                @if (file.newImageUrl) {
                                  <div class="img-diff-pane">
                                    <div class="img-diff-label new">{{ (file.status === 'added' ? 'GIT_EXPLORER.Added' : 'GIT_EXPLORER.After') | translate }}</div>
                                    <img [src]="file.newImageUrl" [alt]="'GIT_EXPLORER.After' | translate" />
                                  </div>
                                }
                                @if (!file.oldImageUrl && !file.newImageUrl) {
                                  <div class="img-diff-empty">{{ 'GIT_EXPLORER.Preview not available' | translate }}</div>
                                }
                              }
                            </div>
                          } @else if (file.isBinary) {
                            <div class="diff-binary-note">{{ 'GIT_EXPLORER.Binary not shown' | translate }}</div>
                          } @else {
                            @if (file.truncated) {
                              <div class="diff-binary-note">{{ 'GIT_EXPLORER.Partial preview' | translate }}</div>
                            }
                            @if (file.lines.length > 200) {
                              <div class="stats-summary-bar">
                                <button class="history-page-btn" [disabled]="!file.linePage" (click)="changeDiffLinePage(file, -1)">{{ 'GIT_EXPLORER.Previous lines' | translate }}</button>
                                <span>{{ (file.linePage || 0) * 200 + 1 }}–{{ Math.min(((file.linePage || 0) + 1) * 200, file.lines.length) }} / {{ file.lines.length }}</span>
                                <button class="history-page-btn" [disabled]="((file.linePage || 0) + 1) * 200 >= file.lines.length" (click)="changeDiffLinePage(file, 1)">{{ 'GIT_EXPLORER.Next lines' | translate }}</button>
                              </div>
                            }
                            @for (line of file.lines | slice:(file.linePage || 0)*200:((file.linePage || 0)+1)*200; track $index) {
                              <div class="dline-row">
                                <div class="dline" [class]="'dline-' + line.type" [class.dline-noted]="!!noteAt(file.path, (file.linePage || 0) * 200 + $index)">
                                  @if (line.type !== 'hunk') {
                                    <span class="dnote-btn" [class.has]="!!noteAt(file.path, (file.linePage || 0) * 200 + $index)"
                                      (click)="toggleNote(file.path, (file.linePage || 0) * 200 + $index, line)"
                                      [appTooltip]="(noteAt(file.path, (file.linePage || 0) * 200 + $index) ? 'GIT_EXPLORER.Edit comment' : 'GIT_EXPLORER.Comment line') | translate">
                                      <iconify-icon [icon]="noteAt(file.path, (file.linePage || 0) * 200 + $index) ? 'mdi:comment' : 'mdi:plus'" width="9"></iconify-icon>
                                    </span>
                                  } @else {
                                    <span class="dnote-btn spacer"></span>
                                  }
                                  <span class="dln">{{ line.oldNum || '' }}</span>
                                  <span class="dln">{{ line.newNum || '' }}</span>
                                  <span class="dlpfx">{{ line.prefix }}</span>
                                  <span class="dltxt">{{ line.text }}</span>
                                </div>
                                <ng-container [ngTemplateOutlet]="noteSlotTpl"
                                  [ngTemplateOutletContext]="{ key: noteKey(file.path, (file.linePage || 0) * 200 + $index) }"></ng-container>
                              </div>
                            }
                          }
                        </div>
                      }
                    </div>
                  }
                  @if (parsedDiffFiles().length === 0 && !diffLoading() && !commitError()) {
                    <div class="diff-empty">
                      <iconify-icon icon="mdi:file-outline" width="20" style="opacity:0.4"></iconify-icon>
                      <span>{{ 'GIT_EXPLORER.No file changes' | translate }}</span>
                    </div>
                  }
                }
              </div>
            </div>
          }
        </div>

        <!-- ═══ RIGHT SIDEBAR: Working directory changes + Commit ═══ -->
        <div class="sidebar-right">
          <!-- Unstaged changes -->
          <div class="wr-section">
            <div class="wr-section-header">
              <span class="wr-section-title">
                <iconify-icon icon="mdi:file-edit-outline" width="13"></iconify-icon>
                {{ 'GIT_EXPLORER.Unstaged' | translate }}
                <span class="wr-count">{{ git.unstagedFiles()?.length ?? 0 }}</span>
              </span>
              <button class="btn-wr-action btn-discard-all" (click)="askDiscard($event, null)" [disabled]="(git.unstagedFiles()?.length ?? 0) === 0" [appTooltip]="'SESSIONS.TOOLTIPS.Discard all' | translate">
                <iconify-icon icon="mdi:undo-variant" width="13"></iconify-icon>
              </button>
              <button class="btn-wr-action btn-stage-all" (click)="stageAll()" [disabled]="(git.unstagedFiles()?.length ?? 0) === 0" [appTooltip]="'SESSIONS.TOOLTIPS.Stage all' | translate">
                <iconify-icon icon="mdi:plus" width="13"></iconify-icon>
              </button>
            </div>
            <div class="wr-file-list">
              @if ((git.unstagedFiles()?.length ?? 0) > 0) {
                <div class="stats-summary-bar history-file-controls">
                  <input type="search" [attr.aria-label]="'GIT_EXPLORER.Filter unstaged' | translate" [placeholder]="'GIT_EXPLORER.Filter files folders' | translate"
                    [ngModel]="unstagedFileFilter()" (ngModelChange)="filterWorkingFiles('unstaged', $event)" />
                  <span>{{ (unstagedTree().totalFiles === 1 ? 'GIT_EXPLORER.File count one' : 'GIT_EXPLORER.File count many') | translate: { count: unstagedTree().totalFiles } }}</span>
                </div>
              }
              @for (row of unstagedTreeRows(); track row.key) {
                @if (row.folder; as node) {
                  <div class="wr-folder-row" [style.padding-left.px]="6 + row.depth * 14"
                    role="button" tabindex="0" [attr.aria-expanded]="isNodeExpanded('unstaged', node.fullPath)"
                    (keydown.enter)="toggleExpandNode('unstaged', node.fullPath)"
                    (click)="toggleExpandNode('unstaged', node.fullPath)">
                    <iconify-icon [icon]="isNodeExpanded('unstaged', node.fullPath) ? 'mdi:chevron-down' : 'mdi:chevron-right'" width="12" class="wr-folder-chevron"></iconify-icon>
                    <iconify-icon [icon]="isNodeExpanded('unstaged', node.fullPath) ? 'mdi:folder-open-outline' : 'mdi:folder-outline'" width="13" class="wr-folder-icon"></iconify-icon>
                    <span class="wr-folder-name" [title]="node.fullPath">{{ node.name }}</span>
                    <span class="wr-folder-count">{{ node.totalFiles }}</span>
                    <button class="btn-wr-file-action folder-action" (keydown.enter)="$event.stopPropagation()"
                      (click)="stageTreeNode($event, node)" [appTooltip]="'GIT_EXPLORER.Stage folder' | translate" [attr.aria-label]="'GIT_EXPLORER.Stage folder' | translate">
                      <iconify-icon icon="mdi:plus" width="12"></iconify-icon>
                    </button>
                  </div>
                } @if (row.file; as file) {
                  <div class="wr-file-row" [class.staged]="'unstaged' === 'staged'" [style.padding-left.px]="6 + row.depth * 14"
                    (click)="viewFileDiff(file.path)" (contextmenu)="onFileContext($event, file)">
                    <span class="wr-file-status" [class]="'wst-' + file.status">{{ statusIcon(file.status) }}</span>
                    <span class="wr-file-name" [title]="file.path">{{ fileName(file.path) }}</span>
                      <button class="btn-wr-file-action discard" (click)="askDiscard($event, file)" [appTooltip]="'GIT_EXPLORER.Discard changes' | translate" [attr.aria-label]="'GIT_EXPLORER.Discard changes' | translate">
                        <iconify-icon icon="mdi:undo-variant" width="12"></iconify-icon>
                      </button>
                    <button class="btn-wr-file-action" (click)="stageFile($event, file.path)" [appTooltip]="'GIT_EXPLORER.Stage file' | translate" [attr.aria-label]="'GIT_EXPLORER.Stage file' | translate">
                      <iconify-icon icon="mdi:plus" width="12"></iconify-icon>
                    </button>
                  </div>
                } @if (row.pagination; as page) {
                  <div class="stats-summary-bar history-file-controls" [style.margin-left.px]="row.depth * 14" [attr.aria-label]="'GIT_EXPLORER.Pages in' | translate: { path: page.path || ('GIT_EXPLORER.Root' | translate) }">
                    <button class="history-page-btn" [disabled]="page.page === 0" (click)="changeTreePage('unstaged', page, -1)">{{ 'GIT_EXPLORER.Previous' | translate }}</button>
                    <span>{{ page.start }}–{{ page.end }} / {{ page.total }} · {{ page.page + 1 }}/{{ page.pages }}</span>
                    <button class="history-page-btn" [disabled]="page.page + 1 >= page.pages" (click)="changeTreePage('unstaged', page, 1)">{{ 'GIT_EXPLORER.Next' | translate }}</button>
                  </div>
                }
              }
              @if (unstagedTree().totalFiles === 0) {
                <div class="wr-empty">{{ (unstagedFileFilter() ? 'GIT_EXPLORER.No matching files' : 'GIT_EXPLORER.No unstaged') | translate }}</div>
              }
            </div>
          </div>

          <!-- Staged changes -->
          <div class="wr-section">
            <div class="wr-section-header">
              <span class="wr-section-title">
                <iconify-icon icon="mdi:check-circle-outline" width="13" style="color:var(--po-success)"></iconify-icon>
                {{ 'GIT_EXPLORER.Staged' | translate }}
                <span class="wr-count staged">{{ git.stagedFiles()?.length ?? 0 }}</span>
              </span>
              <button class="btn-wr-action btn-unstage-all" (click)="unstageAll()" [disabled]="(git.stagedFiles()?.length ?? 0) === 0" [appTooltip]="'SESSIONS.TOOLTIPS.Unstage all' | translate">
                <iconify-icon icon="mdi:minus" width="13"></iconify-icon>
              </button>
            </div>
            <div class="wr-file-list">
              @if ((git.stagedFiles()?.length ?? 0) > 0) {
                <div class="stats-summary-bar history-file-controls">
                  <input type="search" [attr.aria-label]="'GIT_EXPLORER.Filter staged' | translate" [placeholder]="'GIT_EXPLORER.Filter files folders' | translate"
                    [ngModel]="stagedFileFilter()" (ngModelChange)="filterWorkingFiles('staged', $event)" />
                  <span>{{ (stagedTree().totalFiles === 1 ? 'GIT_EXPLORER.File count one' : 'GIT_EXPLORER.File count many') | translate: { count: stagedTree().totalFiles } }}</span>
                </div>
              }
              @for (row of stagedTreeRows(); track row.key) {
                @if (row.folder; as node) {
                  <div class="wr-folder-row" [style.padding-left.px]="6 + row.depth * 14"
                    role="button" tabindex="0" [attr.aria-expanded]="isNodeExpanded('staged', node.fullPath)"
                    (keydown.enter)="toggleExpandNode('staged', node.fullPath)"
                    (click)="toggleExpandNode('staged', node.fullPath)">
                    <iconify-icon [icon]="isNodeExpanded('staged', node.fullPath) ? 'mdi:chevron-down' : 'mdi:chevron-right'" width="12" class="wr-folder-chevron"></iconify-icon>
                    <iconify-icon [icon]="isNodeExpanded('staged', node.fullPath) ? 'mdi:folder-open-outline' : 'mdi:folder-outline'" width="13" class="wr-folder-icon"></iconify-icon>
                    <span class="wr-folder-name" [title]="node.fullPath">{{ node.name }}</span>
                    <span class="wr-folder-count">{{ node.totalFiles }}</span>
                    <button class="btn-wr-file-action folder-action" (keydown.enter)="$event.stopPropagation()"
                      (click)="unstageTreeNode($event, node)" [appTooltip]="'GIT_EXPLORER.Unstage folder' | translate" [attr.aria-label]="'GIT_EXPLORER.Unstage folder' | translate">
                      <iconify-icon icon="mdi:minus" width="12"></iconify-icon>
                    </button>
                  </div>
                } @if (row.file; as file) {
                  <div class="wr-file-row" [class.staged]="'staged' === 'staged'" [style.padding-left.px]="6 + row.depth * 14"
                    (click)="viewFileDiff(file.path)" (contextmenu)="onFileContext($event, file)">
                    <span class="wr-file-status" [class]="'wst-' + file.status">{{ statusIcon(file.status) }}</span>
                    <span class="wr-file-name" [title]="file.path">{{ fileName(file.path) }}</span>

                    <button class="btn-wr-file-action" (click)="unstageFile($event, file.path)" [appTooltip]="'GIT_EXPLORER.Unstage file' | translate" [attr.aria-label]="'GIT_EXPLORER.Unstage file' | translate">
                      <iconify-icon icon="mdi:minus" width="12"></iconify-icon>
                    </button>
                  </div>
                } @if (row.pagination; as page) {
                  <div class="stats-summary-bar history-file-controls" [style.margin-left.px]="row.depth * 14" [attr.aria-label]="'GIT_EXPLORER.Pages in' | translate: { path: page.path || ('GIT_EXPLORER.Root' | translate) }">
                    <button class="history-page-btn" [disabled]="page.page === 0" (click)="changeTreePage('staged', page, -1)">{{ 'GIT_EXPLORER.Previous' | translate }}</button>
                    <span>{{ page.start }}–{{ page.end }} / {{ page.total }} · {{ page.page + 1 }}/{{ page.pages }}</span>
                    <button class="history-page-btn" [disabled]="page.page + 1 >= page.pages" (click)="changeTreePage('staged', page, 1)">{{ 'GIT_EXPLORER.Next' | translate }}</button>
                  </div>
                }
              }
              @if (stagedTree().totalFiles === 0) {
                <div class="wr-empty">{{ (stagedFileFilter() ? 'GIT_EXPLORER.No matching files' : 'GIT_EXPLORER.No staged') | translate }}</div>
              }
            </div>
          </div>

          <!-- Commit section -->
          <div class="wr-commit-section">
            <textarea
              class="wr-commit-input"
              [placeholder]="'SESSIONS.GIT_PANEL.Commit placeholder' | translate"
              rows="3"
              [ngModel]="git.commitMessage()"
              (ngModelChange)="git.commitMessage.set($event)"
              (keydown.control.enter)="doCommit()"
            ></textarea>
            <div class="wr-commit-actions">
              <button class="btn-wr-commit btn-ai-msg" (click)="generateMessage()" [disabled]="git.generatingMessage()" [appTooltip]="'SESSIONS.TOOLTIPS.AI commit message' | translate">
                <iconify-icon icon="solar:magic-stick-3-bold-duotone" width="14" [class.spinning]="git.generatingMessage()"></iconify-icon>
                {{ (git.generatingMessage() ? 'GIT_EXPLORER.Generating' : 'SESSIONS.GIT_PANEL.AI message') | translate }}
              </button>
              <button class="btn-wr-commit btn-do-commit" (click)="doCommit()" [disabled]="!git.commitMessage() || git.committing()">
                <iconify-icon icon="mdi:check-circle" width="14"></iconify-icon>
                {{ (git.committing() ? 'GIT_EXPLORER.Committing' : ((git.stagedFiles()?.length ?? 0) > 0 ? 'SESSIONS.GIT_PANEL.Commit' : 'GIT_EXPLORER.Stage all commit')) | translate }}
              </button>
            </div>
            @if (git.commitError()) {
              <div class="wr-feedback error">{{ git.commitError() }}</div>
            }
            @if (git.generateError()) {
              <div class="wr-feedback error">{{ git.generateError() }}</div>
            }
          </div>
        </div>
      </div>
    </div>

    <!-- ── File context menu ── -->
    @if (ctxMenuVisible()) {
      <div class="git-ctx-backdrop" (click)="closeCtxMenu()" (contextmenu)="$event.preventDefault(); closeCtxMenu()"></div>
      <div class="git-ctx-menu file-ctx" [style.left.px]="ctxMenuX()" [style.top.px]="ctxMenuY()">
        <div class="git-ctx-header">{{ fileName(ctxMenuFile()?.path || '') }}</div>
        @if (ctxMenuFile(); as f) {
          @if (!f.staged) {
            <button class="git-ctx-item" (click)="ctxDiscardChanges()">
              <iconify-icon icon="mdi:undo-variant" width="14"></iconify-icon>
              {{ 'GIT_EXPLORER.Discard changes' | translate }}
            </button>
          }
        }
        <button class="git-ctx-item danger" (click)="ctxDeleteFile()">
          <iconify-icon icon="mdi:trash-can-outline" width="14"></iconify-icon>
          {{ 'GIT_EXPLORER.Delete file' | translate }}
        </button>
      </div>
    }

    <!-- ── Discard confirm popup ── -->
    @if (discardCtx(); as dc) {
      <div class="git-ctx-backdrop" (click)="closeDiscardConfirm()" (contextmenu)="$event.preventDefault(); closeDiscardConfirm()"></div>
      <div class="git-ctx-menu discard-confirm" [style.left.px]="dc.x" [style.top.px]="dc.y" (click)="$event.stopPropagation()">
        <div class="git-ctx-header">
          <iconify-icon icon="mdi:alert-outline" width="12"></iconify-icon>
          {{ dc.file ? fileName(dc.file.path) : ('GIT_EXPLORER.All unstaged' | translate) }}
        </div>
        <div class="bcm-confirm-text">
          @if (dc.file) {
            {{ (dc.file.status === 'untracked' ? 'GIT_EXPLORER.Confirm delete untracked' : 'GIT_EXPLORER.Confirm discard file') | translate }}
          } @else {
            {{ 'GIT_EXPLORER.Confirm discard all' | translate }}
          }
        </div>
        <div class="bcm-form-actions">
          <button class="bcm-btn" (click)="closeDiscardConfirm()">{{ 'COMMON.Cancel' | translate }}</button>
          <button class="bcm-btn danger" [disabled]="discardBusy()" (click)="doDiscard()">{{ 'GIT_EXPLORER.Discard enter' | translate }}</button>
        </div>
      </div>
    }

    <!-- ── File diff overlay ── -->
    @if (diffOverlayFile()) {
      <div class="diff-overlay" (click)="closeDiffOverlay()">
        <div class="diff-overlay-panel" (click)="$event.stopPropagation()">
          <div class="diff-overlay-header">
            <div class="diff-overlay-title">
              <iconify-icon icon="mdi:file-document-outline" width="16"></iconify-icon>
              {{ diffOverlayFile() }}
            </div>
            <button class="btn-git-icon" (click)="closeDiffOverlay()">
              <iconify-icon icon="mdi:close" width="16"></iconify-icon>
            </button>
          </div>
          <div class="diff-overlay-body">
            @if (diffOverlayLoading()) {
              <div class="center-loading"><iconify-icon icon="mdi:refresh" width="16" class="spinning"></iconify-icon> {{ 'GIT_EXPLORER.Loading' | translate }}</div>
            } @else {
              @if (diffOverlayImage(); as img) {
                <div class="img-diff-compare overlay">
                  @if (img.oldUrl) {
                    <div class="img-diff-pane">
                      <div class="img-diff-label old">{{ img.newUrl ? 'HEAD' : ('GIT_EXPLORER.Head deleted' | translate) }}</div>
                      <img [src]="img.oldUrl" alt="HEAD" />
                    </div>
                  }
                  @if (img.newUrl) {
                    <div class="img-diff-pane">
                      <div class="img-diff-label new">{{ 'GIT_EXPLORER.Working tree' | translate }}</div>
                      <img [src]="img.newUrl" [alt]="'GIT_EXPLORER.Working tree' | translate" />
                    </div>
                  }
                  @if (!img.oldUrl && !img.newUrl) {
                    <div class="img-diff-empty">{{ 'GIT_EXPLORER.Preview not available' | translate }}</div>
                  }
                </div>
              } @else {
                @if (overlayDiffLines(); as olines) {
                  @if (olines.length > 0) {
                    <div class="diff-file-body overlay-body">
                      @for (line of olines; track $index) {
                        <div class="dline-row">
                          <div class="dline" [class]="'dline-' + line.type" [class.dline-noted]="!!wtNoteAt(diffOverlayFile()!, $index)">
                            @if (line.type !== 'hunk') {
                              <span class="dnote-btn" [class.has]="!!wtNoteAt(diffOverlayFile()!, $index)"
                                (click)="toggleNote(diffOverlayFile()!, $index, line, 'wt')"
                                [appTooltip]="(wtNoteAt(diffOverlayFile()!, $index) ? 'GIT_EXPLORER.Edit comment' : 'GIT_EXPLORER.Comment line') | translate">
                                <iconify-icon [icon]="wtNoteAt(diffOverlayFile()!, $index) ? 'mdi:comment' : 'mdi:plus'" width="9"></iconify-icon>
                              </span>
                            } @else {
                              <span class="dnote-btn spacer"></span>
                            }
                            <span class="dln">{{ line.oldNum || '' }}</span>
                            <span class="dln">{{ line.newNum || '' }}</span>
                            <span class="dlpfx">{{ line.prefix }}</span>
                            <span class="dltxt">{{ line.text }}</span>
                          </div>
                          <ng-container [ngTemplateOutlet]="noteSlotTpl"
                            [ngTemplateOutletContext]="{ key: wtNoteKey(diffOverlayFile()!, $index) }"></ng-container>
                        </div>
                      }
                    </div>
                  } @else {
                    <pre class="diff-overlay-pre">@for (line of diffOverlayLines(); track $index) {<span [class]="diffLineClass(line)">{{ line }}
</span>}</pre>
                  }
                }
              }
            }
          </div>
        </div>
      </div>
    }

    <!-- ── Review notes: inline editor slot, reused by both diff views ── -->
    <ng-template #noteSlotTpl let-key="key">
      @if (editingKey() === key) {
        <div class="dnote-box" (click)="$event.stopPropagation()">
          <textarea class="dnote-input" rows="2" [(ngModel)]="noteDraft"
            [placeholder]="'GIT_EXPLORER.Note placeholder' | translate"
            (keydown)="onNoteKeydown($event)"></textarea>
          <div class="dnote-actions">
            @if (noteByKey(key)) {
              <button class="dnote-btn-act danger" (click)="deleteNote(key)">{{ 'GIT_EXPLORER.Delete' | translate }}</button>
            }
            <button class="dnote-btn-act" (click)="cancelNote()">{{ 'COMMON.Cancel' | translate }}</button>
            <button class="dnote-btn-act primary" [disabled]="!noteDraft.trim()" (click)="saveNote()">{{ 'GIT_EXPLORER.Save enter' | translate }}</button>
          </div>
        </div>
      } @else {
        @if (noteByKey(key); as note) {
        <div class="dnote-chip" (click)="editNote(key)">
          <iconify-icon icon="mdi:comment-text-outline" width="11"></iconify-icon>
          <span class="dnote-chip-text">{{ note.text }}</span>
          <button class="dnote-chip-x" (click)="$event.stopPropagation(); deleteNote(key)">
            <iconify-icon icon="mdi:close" width="10"></iconify-icon>
          </button>
        </div>
        }
      }
    </ng-template>

    <!-- ── Review bar: ships every note back to the agent as one prompt ── -->
    @if (notes().length > 0) {
      <div class="dnote-bar">
        <iconify-icon icon="mdi:comment-multiple-outline" width="14"></iconify-icon>
        <span class="dnote-bar-count">{{ (notes().length === 1 ? 'GIT_EXPLORER.Comments one' : 'GIT_EXPLORER.Comments many') | translate: { count: notes().length } }}</span>
        <span class="dnote-bar-files">{{ (notedFilesCount() === 1 ? 'GIT_EXPLORER.On files one' : 'GIT_EXPLORER.On files many') | translate: { count: notedFilesCount() } }}</span>
        <button class="dnote-bar-btn" (click)="clearNotes()">{{ 'GIT_EXPLORER.Clear' | translate }}</button>
        <button class="dnote-bar-btn primary" (click)="sendNotesToAgent()">
          <iconify-icon icon="mdi:send" width="12"></iconify-icon>
          {{ 'GIT_EXPLORER.Send to agent' | translate }}
        </button>
      </div>
    }

    <app-git-setup-modal />
    <app-git-settings-modal />

    <!-- Branch/commit context menu (GitKraken-style: right-click on a branch, badge or graph dot) -->
    @if (branchCtxVisible()) {
      <div
        class="branch-ctx-menu"
        [style.left.px]="branchCtxX()"
        [style.top.px]="branchCtxY()"
        (click)="$event.stopPropagation()"
      >
        @if (ctxConfirm(); as confirm) {
          <!-- Two-step confirm for destructive actions -->
          <div class="bcm-header bcm-danger-header">
            <iconify-icon icon="mdi:alert-outline" width="12"></iconify-icon>
            <span class="bcm-branch-name">{{ 'GIT_EXPLORER.Confirm' | translate }}</span>
          </div>
          <div class="bcm-confirm-text">{{ confirm.text }}</div>
          <div class="bcm-form-actions">
            <button class="bcm-btn" (click)="ctxConfirm.set(null)">{{ 'COMMON.Cancel' | translate }}</button>
            <button class="bcm-btn danger" [disabled]="!!ctxBusy()" (click)="confirm.run()">{{ confirm.confirmLabel }}</button>
          </div>
        } @else if (ctxMode() === 'branch-input') {
          <!-- Inline input: create branch at this commit -->
          <div class="bcm-header">
            <iconify-icon icon="mdi:source-branch-plus" width="12"></iconify-icon>
            <span class="bcm-branch-name">{{ 'GIT_EXPLORER.New branch at' | translate: { hash: branchCtxCommit()?.shortHash } }}</span>
          </div>
          <div class="bcm-form">
            <input class="bcm-input" [(ngModel)]="ctxInputName" placeholder="branch-name" (keydown.enter)="doCreateBranchHere()" />
            <div class="bcm-form-actions">
              <button class="bcm-btn" (click)="ctxMode.set('menu')">{{ 'COMMON.Cancel' | translate }}</button>
              <button class="bcm-btn primary" [disabled]="!ctxInputName.trim() || !!ctxBusy()" (click)="doCreateBranchHere()">{{ 'GIT_EXPLORER.Create checkout enter' | translate }}</button>
            </div>
          </div>
        } @else if (ctxMode() === 'tag-input') {
          <!-- Inline input: create tag at this commit -->
          <div class="bcm-header">
            <iconify-icon icon="mdi:tag-plus-outline" width="12"></iconify-icon>
            <span class="bcm-branch-name">{{ 'GIT_EXPLORER.New tag at' | translate: { hash: branchCtxCommit()?.shortHash } }}</span>
          </div>
          <div class="bcm-form">
            <input class="bcm-input" [(ngModel)]="ctxInputName" placeholder="v1.2.3" (keydown.enter)="doCreateTagHere()" />
            <input class="bcm-input" [(ngModel)]="ctxInputMsg" [placeholder]="'GIT_EXPLORER.Tag message placeholder' | translate" (keydown.enter)="doCreateTagHere()" />
            <div class="bcm-form-actions">
              <button class="bcm-btn" (click)="ctxMode.set('menu')">{{ 'COMMON.Cancel' | translate }}</button>
              <button class="bcm-btn primary" [disabled]="!ctxInputName.trim() || !!ctxBusy()" (click)="doCreateTagHere()">{{ 'GIT_EXPLORER.Create tag enter' | translate }}</button>
            </div>
          </div>
        } @else if (ctxMode() === 'rename-input') {
          <!-- Inline input: rename a local branch -->
          <div class="bcm-header">
            <iconify-icon icon="mdi:rename-box-outline" width="12"></iconify-icon>
            <span class="bcm-branch-name">{{ 'GIT_EXPLORER.Rename title' | translate: { branch: branchCtxBranch() } }}</span>
          </div>
          <div class="bcm-form">
            <input class="bcm-input" [(ngModel)]="ctxInputName" placeholder="new-name" (keydown.enter)="doRenameBranch()" />
            <div class="bcm-form-actions">
              <button class="bcm-btn" (click)="ctxMode.set('menu')">{{ 'COMMON.Cancel' | translate }}</button>
              <button class="bcm-btn primary" [disabled]="!ctxInputName.trim() || !!ctxBusy()" (click)="doRenameBranch()">{{ 'GIT_EXPLORER.Rename enter' | translate }}</button>
            </div>
          </div>
        } @else if (ctxMode() === 'reword-input') {
          <!-- Inline input: edit the last commit message (amend) -->
          <div class="bcm-header">
            <iconify-icon icon="mdi:pencil-outline" width="12"></iconify-icon>
            <span class="bcm-branch-name">{{ 'GIT_EXPLORER.Edit last message' | translate }}</span>
          </div>
          <div class="bcm-form">
            <input class="bcm-input" [(ngModel)]="ctxInputMsg" [placeholder]="'GIT_EXPLORER.Commit message placeholder' | translate" (keydown.enter)="doRewordHead(false)" />
            <div class="bcm-form-actions">
              <button class="bcm-btn" (click)="ctxMode.set('menu')">{{ 'COMMON.Cancel' | translate }}</button>
              <button class="bcm-btn primary" [disabled]="!ctxInputMsg.trim() || !!ctxBusy()" (click)="doRewordHead(false)">{{ 'GIT_EXPLORER.Update enter' | translate }}</button>
            </div>
          </div>
        } @else if (branchCtxList()) {
          <!-- Multiple branches on the same dot: pick one first -->
          <div class="bcm-header">
            <iconify-icon icon="mdi:source-branch" width="12"></iconify-icon>
            <span class="bcm-branch-name">{{ 'GIT_EXPLORER.Branches at commit' | translate: { count: branchCtxList()!.length } }}</span>
          </div>
          @for (b of branchCtxList()!; track b) {
            <button class="bcm-item" (click)="pickCtxBranch(b)">
              <iconify-icon [icon]="b.startsWith('origin/') ? 'mdi:cloud-outline' : 'mdi:laptop'" width="13"></iconify-icon>
              <strong>{{ b }}</strong>
              <iconify-icon icon="mdi:chevron-right" width="13" class="bcm-chevron"></iconify-icon>
            </button>
          }
        } @else {
          <!-- Header: branch or bare commit -->
          @if (branchCtxBranch(); as b) {
            <div class="bcm-header">
              <iconify-icon [icon]="b.startsWith('origin/') ? 'mdi:cloud-outline' : 'mdi:laptop'" width="12"></iconify-icon>
              <span class="bcm-branch-name">{{ b }}</span>
            </div>
          } @else {
            @if (branchCtxCommit(); as c) {
              <div class="bcm-header">
                <iconify-icon icon="mdi:source-commit" width="12"></iconify-icon>
                <span class="bcm-branch-name">{{ c.shortHash }} · {{ c.message }}</span>
              </div>
            }
          }

          @if (branchCtxBranch() && branchCtxBranch() !== currentBranch()) {
            @if (currentBranch() && currentBranch() !== 'HEAD') {
              <button class="bcm-item" [disabled]="!!ctxBusy()" (click)="doFastForward(branchCtxBranch()!)">
                <iconify-icon icon="mdi:fast-forward" width="13"></iconify-icon>
                <span [innerHTML]="'GIT_EXPLORER.Ctx fast forward' | translate: { current: esc(currentBranch()), branch: esc(branchCtxBranch()) }"></span>
              </button>
              <button class="bcm-item" (click)="mergeIntoCurrent(branchCtxBranch()!); closeBranchCtx()">
                <iconify-icon icon="mdi:source-merge" width="13"></iconify-icon>
                <span [innerHTML]="'GIT_EXPLORER.Ctx merge into' | translate: { current: esc(currentBranch()), branch: esc(branchCtxBranch()) }"></span>
              </button>
              <button class="bcm-item" (click)="openMergeModalWithSource(branchCtxBranch()!); closeBranchCtx()">
                <iconify-icon icon="mdi:tune" width="13"></iconify-icon>
                <span [innerHTML]="'GIT_EXPLORER.Ctx merge options' | translate: { branch: esc(branchCtxBranch()) }"></span>
              </button>
              <button class="bcm-item" [disabled]="!!ctxBusy()" (click)="doRebase(branchCtxBranch()!)">
                <iconify-icon icon="mdi:source-branch-refresh" width="13"></iconify-icon>
                <span [innerHTML]="'GIT_EXPLORER.Ctx rebase onto' | translate: { current: esc(currentBranch()), branch: esc(branchCtxBranch()) }"></span>
              </button>
              <div class="bcm-sep"></div>
            }
            <button class="bcm-item" (click)="checkoutBranch(branchCtxBranch()!); closeBranchCtx()">
              <iconify-icon icon="mdi:source-branch-sync" width="13"></iconify-icon>
              <span [innerHTML]="'GIT_EXPLORER.Ctx checkout' | translate: { branch: esc(branchCtxBranch()) }"></span>
            </button>
            @if (!branchCtxBranch()!.startsWith('origin/')) {
              <button class="bcm-item" (click)="ctxInputName = branchCtxBranch()!; ctxMode.set('rename-input')">
                <iconify-icon icon="mdi:rename-box-outline" width="13"></iconify-icon>
                <span [innerHTML]="'GIT_EXPLORER.Ctx rename' | translate: { branch: esc(branchCtxBranch()) }"></span>
              </button>
            }
            <button class="bcm-item bcm-danger" (click)="askDeleteBranch()">
              <iconify-icon icon="mdi:delete-outline" width="13"></iconify-icon>
              <span [innerHTML]="(branchCtxBranch()!.startsWith('origin/') ? 'GIT_EXPLORER.Ctx delete origin' : 'GIT_EXPLORER.Ctx delete') | translate: { branch: esc(branchCtxBranch()) }"></span>
            </button>
          } @else if (branchCtxBranch()) {
            <div class="bcm-empty">{{ 'GIT_EXPLORER.Current branch note' | translate }}</div>
            <button class="bcm-item" (click)="openMergeModal(); closeBranchCtx()">
              <iconify-icon icon="mdi:source-merge" width="13"></iconify-icon>
              <span [innerHTML]="'GIT_EXPLORER.Ctx merge others' | translate: { current: esc(currentBranch()) }"></span>
            </button>
            @if (!branchCtxBranch()!.startsWith('origin/')) {
              <button class="bcm-item" (click)="ctxInputName = branchCtxBranch()!; ctxMode.set('rename-input')">
                <iconify-icon icon="mdi:rename-box-outline" width="13"></iconify-icon>
                <span [innerHTML]="'GIT_EXPLORER.Ctx rename' | translate: { branch: esc(branchCtxBranch()) }"></span>
              </button>
            }
          }

          @if (branchCtxCommit(); as c) {
            <div class="bcm-sep"></div>
            <button class="bcm-item" (click)="ctxInputName = ''; ctxMode.set('branch-input')">
              <iconify-icon icon="mdi:source-branch-plus" width="13"></iconify-icon>
              {{ 'GIT_EXPLORER.Create branch here' | translate }}
            </button>
            <button class="bcm-item" [disabled]="!!ctxBusy()" (click)="doCherryPick()">
              <iconify-icon icon="mdi:fruit-cherries" width="13"></iconify-icon>
              {{ 'GIT_EXPLORER.Cherry pick' | translate }}
            </button>
            <button class="bcm-item" [disabled]="!!ctxBusy()" (click)="doRevert()">
              <iconify-icon icon="mdi:undo-variant" width="13"></iconify-icon>
              {{ 'GIT_EXPLORER.Revert' | translate }}
            </button>
            @if (currentBranch() && currentBranch() !== 'HEAD') {
              <button class="bcm-item" (click)="ctxResetOpen.set(!ctxResetOpen())">
                <iconify-icon icon="mdi:backup-restore" width="13"></iconify-icon>
                <span [innerHTML]="'GIT_EXPLORER.Ctx reset' | translate: { current: esc(currentBranch()) }"></span>
                <iconify-icon [icon]="ctxResetOpen() ? 'mdi:chevron-down' : 'mdi:chevron-right'" width="13" class="bcm-chevron"></iconify-icon>
              </button>
              @if (ctxResetOpen()) {
                <button class="bcm-item bcm-sub" (click)="askReset('soft')">{{ 'GIT_EXPLORER.Reset soft' | translate }}</button>
                <button class="bcm-item bcm-sub" (click)="askReset('mixed')">{{ 'GIT_EXPLORER.Reset mixed' | translate }}</button>
                <button class="bcm-item bcm-sub bcm-danger" (click)="askReset('hard')">{{ 'GIT_EXPLORER.Reset hard' | translate }}</button>
              }
            }
            <button class="bcm-item" (click)="ctxInputName = ''; ctxInputMsg = ''; ctxMode.set('tag-input')">
              <iconify-icon icon="mdi:tag-plus-outline" width="13"></iconify-icon>
              {{ 'GIT_EXPLORER.Create tag here' | translate }}
            </button>
            @if (isHeadCommit(c)) {
              <button class="bcm-item" (click)="ctxInputMsg = c.message; ctxMode.set('reword-input')">
                <iconify-icon icon="mdi:pencil-outline" width="13"></iconify-icon>
                {{ 'GIT_EXPLORER.Edit last message menu' | translate }}
              </button>
            }
          }

          <div class="bcm-sep"></div>
          @if (branchCtxBranch(); as b) {
            <button class="bcm-item" (click)="selectBranch(b); closeBranchCtx()">
              <iconify-icon icon="mdi:filter-outline" width="13"></iconify-icon>
              <span [innerHTML]="'GIT_EXPLORER.Ctx solo' | translate: { branch: esc(stripRemote(b)) }"></span>
            </button>
            <button class="bcm-item" (click)="copyCtxText(stripRemote(b))">
              <iconify-icon icon="mdi:content-copy" width="13"></iconify-icon>
              {{ 'GIT_EXPLORER.Copy branch name' | translate }}
            </button>
          }
          @if (branchCtxCommit(); as c) {
            <button class="bcm-item" (click)="copyCtxText(c.hash)">
              <iconify-icon icon="mdi:content-copy" width="13"></iconify-icon>
              {{ 'GIT_EXPLORER.Copy commit sha' | translate }}
            </button>
          }
          @if (originRemote(); as remote) {
            @if (branchCtxCommit()) {
              <button class="bcm-item" (click)="copyRemoteLink('commit')">
                <iconify-icon icon="mdi:link-variant" width="13"></iconify-icon>
                {{ 'GIT_EXPLORER.Copy commit link' | translate: { host: remote.host || 'origin' } }}
              </button>
            }
            @if (branchCtxBranch()) {
              <button class="bcm-item" (click)="copyRemoteLink('branch')">
                <iconify-icon icon="mdi:link-variant" width="13"></iconify-icon>
                {{ 'GIT_EXPLORER.Copy branch link' | translate: { host: remote.host || 'origin' } }}
              </button>
            }
          }
        }
      </div>
    }

    <!-- Feedback toast for context-menu git operations -->
    @if (gitToast(); as toast) {
      <div class="git-toast" [class.err]="toast.kind === 'err'">
        <iconify-icon [icon]="toast.kind === 'err' ? 'mdi:alert-circle-outline' : 'mdi:check-circle-outline'" width="14"></iconify-icon>
        <span>{{ toast.text }}</span>
        @if (toast.action; as action) {
          <button class="git-toast-action" (click)="gitToast.set(null); action.run()">{{ action.label }}</button>
        }
      </div>
    }

    <!-- Multi-branch merge modal -->
    <app-branch-merge-modal
      [open]="mergeModalOpen()"
      [cwd]="cwd"
      [branches]="allBranches()"
      [currentBranch]="currentBranch()"
      [initialSource]="mergeInitialSource()"
      (closed)="closeMergeModal()"
      (completed)="onMergeCompleted()"
    />
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    /* ═════ ROOT ═════ */
    .git-explorer {
      display: flex; flex-direction: column;
      height: 100vh; width: 100vw;
      background: var(--po-bg-0);
      color: var(--po-text-primary);
    }

    /* ═════ TOP BAR ═════ */
    .git-topbar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0.45rem 1rem;
      background: rgba(255,255,255,0.03);
      border-bottom: 1px solid var(--po-border-subtle);
      flex-shrink: 0;
    }
    .git-topbar-left { display: flex; align-items: center; gap: 0.5rem; }
    .git-topbar-center { display: flex; align-items: center; justify-content: center; }
    .git-topbar-right { display: flex; align-items: center; gap: 0.4rem; }
    .git-icon { color: #f0883e; }
    .git-title { font-size: 0.85rem; font-weight: 700; }

    .repo-switcher {
      display: inline-flex; align-items: center;
    }
    .repo-select {
      font-size: 0.65rem; font-weight: 600; font-family: monospace;
      padding: 2px 6px; border-radius: 4px; border: 1px solid var(--po-border-subtle);
      background: rgba(255,255,255,0.05); color: var(--po-text-primary);
      cursor: pointer; outline: none; max-width: 200px;
    }
    .repo-select:hover { border-color: var(--po-info); }
    .repo-select:focus { border-color: var(--po-info); box-shadow: 0 0 0 1px rgba(88,166,255,0.3); }
    .repo-select option {
      background: var(--po-bg-surface); color: var(--po-text-primary);
    }
    .repo-name-badge {
      display: inline-flex; align-items: center; gap: 3px;
      font-size: 0.65rem; font-weight: 600; padding: 2px 8px; border-radius: 4px;
      background: rgba(240,136,62,0.12); color: #f0883e; font-family: monospace;
    }

    .git-branch-badge {
      display: inline-flex; align-items: center; gap: 3px;
      font-size: 0.65rem; font-weight: 600; padding: 2px 8px; border-radius: 4px;
      background: rgba(88,166,255,0.12); color: var(--po-info); font-family: monospace;
    }

    /* ── Worktree switcher (topbar) ── */
    .wt-switch-btn.in-linked { background: rgba(210,153,34,0.14); color: var(--po-warning, #d29922); }
    .wt-count {
      font-size: 0.55rem; font-weight: 700; padding: 0 4px; border-radius: 3px;
      background: rgba(127,127,127,0.18); color: inherit;
    }
    .wt-menu { width: 360px; max-height: 480px; }
    .wt-group { display: flex; align-items: center; justify-content: space-between; }
    .wt-row { display: flex; align-items: center; padding-right: 0.35rem; }
    .wt-row.missing { opacity: 0.6; }
    .wt-main { flex: 1; min-width: 0; }
    .wt-main:disabled { color: var(--po-text-primary); }
    .wt-row.current .wt-main { color: var(--po-success, #3fb950); }
    .wt-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .wt-sub {
      display: inline-flex; align-items: center; gap: 2px; min-width: 0;
      font-family: monospace; font-size: 0.6rem; color: var(--po-text-secondary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .wt-tag {
      font-size: 0.5rem; font-weight: 700; text-transform: uppercase; flex-shrink: 0;
      padding: 1px 5px; border-radius: 3px;
      background: rgba(127,127,127,0.15); color: var(--po-text-secondary);
    }
    .wt-tag.warn { background: rgba(210,153,34,0.15); color: var(--po-warning, #d29922); }
    .wt-lock { color: var(--po-text-secondary); flex-shrink: 0; }
    .wt-changes { font-size: 0.58rem; flex-shrink: 0; color: var(--po-text-secondary); }
    .wt-changes.dirty { color: var(--po-warning, #d29922); font-weight: 600; }
    .wt-icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; flex-shrink: 0; padding: 0;
      background: transparent; border: none; border-radius: 4px;
      color: var(--po-text-secondary); cursor: pointer;
    }
    .wt-icon-btn:hover:not(:disabled) { background: rgba(127,127,127,0.15); color: var(--po-text-primary); }
    .wt-icon-btn.danger:hover:not(:disabled) { color: var(--po-error, #f85149); }
    .wt-confirm {
      margin: 0.15rem 0.6rem 0.35rem; padding: 0.4rem 0.5rem;
      border: 1px solid rgba(248,81,73,0.35); border-radius: 5px;
      font-size: 0.65rem; color: var(--po-text-primary);
      display: flex; flex-direction: column; gap: 0.35rem;
    }
    .wt-confirm-actions { display: flex; justify-content: flex-end; gap: 0.3rem; }
    .wt-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 0.25rem;
      padding: 0.25rem 0.55rem; border-radius: 4px; cursor: pointer;
      font-size: 0.65rem; font-weight: 600;
      background: transparent; border: 1px solid var(--po-border-subtle);
      color: var(--po-text-primary);
    }
    .wt-btn:hover:not(:disabled) { background: rgba(127,127,127,0.12); }
    .wt-btn.danger { border-color: rgba(248,81,73,0.45); color: var(--po-error, #f85149); }
    .wt-btn.danger:hover:not(:disabled) { background: rgba(248,81,73,0.1); }
    .wt-hint { padding: 0.35rem 0.6rem 0.2rem; font-size: 0.6rem; color: var(--po-text-secondary); }
    .wt-check {
      display: flex; align-items: center; gap: 0.35rem;
      font-size: 0.65rem; color: var(--po-text-secondary); cursor: pointer;
    }
    .wt-menu .new-branch-form { justify-content: flex-end; }

    /* ── Branch switcher (topbar) ── */
    .branch-switcher { position: relative; display: inline-flex; }
    .branch-switch-btn {
      border: 1px solid transparent; cursor: pointer;
      transition: all var(--po-duration-fast);
    }
    .branch-switch-btn:hover, .branch-switch-btn.open {
      background: rgba(88,166,255,0.22); border-color: rgba(88,166,255,0.4);
    }
    .branch-menu-backdrop { position: fixed; inset: 0; z-index: 1080; }
    .branch-menu {
      position: absolute; top: calc(100% + 6px); left: 0; z-index: 1081;
      width: 300px; max-height: 420px;
      display: flex; flex-direction: column;
      background: var(--po-bg-1, #161b22);
      border: 1px solid var(--po-border-subtle);
      border-radius: 8px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      overflow: hidden;
    }
    .branch-menu-search {
      display: flex; align-items: center; gap: 0.3rem;
      padding: 0.4rem 0.6rem;
      border-bottom: 1px solid var(--po-border-subtle);
      color: var(--po-text-secondary); flex-shrink: 0;
    }
    .branch-menu-search-input {
      flex: 1; background: transparent; border: none; outline: none;
      color: var(--po-text-primary); font-size: 0.72rem;
    }
    .branch-menu-search-input::placeholder { color: var(--po-text-secondary); }
    .branch-menu-list { flex: 1; overflow-y: auto; min-height: 0; padding: 0.25rem 0; }
    .branch-menu-group {
      padding: 0.3rem 0.6rem 0.15rem;
      font-size: 0.55rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.05em; color: var(--po-text-secondary);
    }
    .branch-menu-item {
      display: flex; align-items: center; gap: 0.4rem;
      width: 100%; padding: 0.32rem 0.6rem;
      background: transparent; border: none; text-align: left;
      color: var(--po-text-primary); cursor: pointer;
      transition: background var(--po-duration-instant);
    }
    .branch-menu-item:hover:not(:disabled) { background: rgba(88,166,255,0.1); }
    .branch-menu-item:disabled { cursor: default; }
    .branch-menu-item.current { color: var(--po-success); }
    .branch-menu-item.remote { color: var(--po-text-secondary); }
    .bmi-name {
      flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font-family: monospace; font-size: 0.68rem;
    }
    .bmi-current {
      font-size: 0.5rem; font-weight: 700; text-transform: uppercase;
      padding: 1px 5px; border-radius: 3px;
      background: var(--po-success-bg); color: var(--po-success); flex-shrink: 0;
    }
    .branch-menu-empty {
      padding: 0.6rem; font-size: 0.65rem; color: var(--po-text-secondary);
      text-align: center; font-style: italic;
    }
    .branch-menu-footer {
      border-top: 1px solid var(--po-border-subtle);
      padding: 0.4rem 0.5rem; flex-shrink: 0;
      display: flex; flex-direction: column; gap: 0.3rem;
    }
    .btn-new-branch {
      display: flex; align-items: center; gap: 0.3rem;
      width: 100%; padding: 0.35rem 0.5rem;
      background: rgba(63,185,80,0.08); border: 1px solid rgba(63,185,80,0.3);
      border-radius: 5px; color: var(--po-success);
      font-size: 0.68rem; font-weight: 600; cursor: pointer;
      transition: background var(--po-duration-fast);
    }
    .btn-new-branch:hover { background: rgba(63,185,80,0.18); }
    .btn-new-branch strong { font-family: monospace; }
    .new-branch-form { display: flex; gap: 0.3rem; align-items: center; }
    .new-branch-input {
      flex: 1; min-width: 0;
      background: var(--po-bg-0); border: 1px solid var(--po-border-subtle);
      border-radius: 4px; padding: 0.3rem 0.45rem;
      color: var(--po-text-primary); font-size: 0.68rem; font-family: monospace; outline: none;
    }
    .new-branch-input:focus { border-color: rgba(63,185,80,0.5); }
    .new-branch-input::placeholder { color: var(--po-text-secondary); }
    .btn-branch-ai {
      display: flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; flex-shrink: 0;
      background: rgba(188,140,255,0.08); border: 1px solid rgba(188,140,255,0.3);
      border-radius: 4px; color: #bc8cff; cursor: pointer;
    }
    .btn-branch-ai:hover:not(:disabled) { background: rgba(188,140,255,0.18); }
    .btn-branch-ai:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-branch-create {
      display: flex; align-items: center; gap: 0.2rem; flex-shrink: 0;
      padding: 0 0.55rem; height: 28px;
      background: rgba(63,185,80,0.08); border: 1px solid rgba(63,185,80,0.3);
      border-radius: 4px; color: var(--po-success);
      font-size: 0.65rem; font-weight: 600; cursor: pointer;
    }
    .btn-branch-create:hover:not(:disabled) { background: rgba(63,185,80,0.18); }
    .btn-branch-create:disabled { opacity: 0.4; cursor: not-allowed; }
    .new-branch-hint { font-size: 0.6rem; color: var(--po-text-secondary); }
    .new-branch-hint strong { font-family: monospace; color: var(--po-text-primary); }
    .new-branch-error { font-size: 0.62rem; color: var(--po-error); word-break: break-word; }
    .git-count-badge, .git-changes-badge {
      font-size: 0.6rem; font-weight: 500; color: var(--po-text-secondary);
    }
    .git-changes-badge { color: var(--po-warning); }

    .topbar-actions-group {
      display: flex; align-items: center; gap: 2px;
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--po-border-subtle);
      border-radius: 6px; padding: 2px;
    }
    .btn-topbar-square {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 1px; width: 44px; height: 38px; border: none; border-radius: 4px;
      background: transparent; color: var(--po-text-secondary);
      cursor: pointer; transition: all var(--po-duration-fast);
    }
    .btn-topbar-square:hover:not(:disabled) {
      background: rgba(255,255,255,0.08); color: var(--po-text-primary);
    }
    .btn-topbar-square:disabled { opacity: 0.35; cursor: not-allowed; }
    .btn-topbar-square { position: relative; }
    .sync-count-badge {
      position: absolute; top: 1px; right: 2px;
      min-width: 13px; height: 13px; padding: 0 3px;
      border-radius: 7px; font-size: 0.55rem; font-weight: 700; line-height: 13px;
      text-align: center;
    }
    .sync-count-badge.behind { background: rgba(210,153,34,0.25); color: var(--po-warning); }
    .sync-count-badge.ahead { background: rgba(63,185,80,0.25); color: var(--po-success); }

    .git-sync-chip {
      display: inline-flex; align-items: center; gap: 4px;
      margin-left: 0.3rem; padding: 3px 8px; height: 24px;
      border-radius: 12px; font-size: 0.65rem; cursor: pointer;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--po-border-subtle);
      color: var(--po-text-secondary);
      transition: all var(--po-duration-fast);
    }
    .git-sync-chip:hover:not(:disabled) { background: rgba(255,255,255,0.09); color: var(--po-text-primary); }
    .git-sync-chip:disabled { opacity: 0.6; cursor: wait; }
    .git-sync-chip .chip-ahead { color: var(--po-success); font-weight: 700; }
    .git-sync-chip .chip-behind { color: var(--po-warning); font-weight: 700; }
    .git-sync-chip .zero { color: var(--po-text-secondary); font-weight: 400; opacity: 0.5; }
    .git-sync-chip .chip-label {
      font-size: 0.55rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
    }
    .btn-square-label {
      font-size: 0.52rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.03em; line-height: 1;
    }
    .btn-clone-topbar { margin-left: 0.3rem; }
    .btn-clone-topbar.active { background: rgba(88,166,255,0.12); color: var(--po-info); }

    .btn-fix-topbar {
      margin-left: 0.3rem;
      background: rgba(188,140,255,0.08);
      border-color: rgba(188,140,255,0.3);
      color: #bc8cff;
    }
    .btn-fix-topbar:hover { background: rgba(188,140,255,0.2); }

    .btn-fix-inline {
      background: rgba(188,140,255,0.1) !important;
      border-color: rgba(188,140,255,0.4) !important;
      color: #bc8cff !important;
    }
    .btn-fix-inline:hover { background: rgba(188,140,255,0.22) !important; }

    .git-origin-badge {
      display: inline-flex; align-items: center; gap: 0.3rem;
      padding: 2px 8px; border-radius: 4px; font-size: 0.68rem;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      color: var(--po-text-secondary);
      max-width: 240px;
    }
    .git-origin-badge.ssh { background: rgba(63,185,80,0.08); border-color: rgba(63,185,80,0.3); color: var(--po-success); }
    .git-origin-badge.https { background: rgba(210,153,34,0.08); border-color: rgba(210,153,34,0.3); color: var(--po-warning); }
    .git-origin-host {
      font-family: monospace; font-weight: 500;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .git-origin-type {
      font-size: 0.6rem; text-transform: uppercase; font-weight: 700;
      opacity: 0.7;
    }

    /* ═════ CLONE PANEL ═════ */
    .clone-panel {
      flex-shrink: 0;
      border-bottom: 1px solid var(--po-border-subtle);
      background: rgba(88,166,255,0.03);
    }
    .clone-panel-body { padding: 0.5rem 0.8rem; display: flex; flex-direction: column; gap: 0.4rem; }
    .clone-field-row { display: flex; gap: 0.5rem; align-items: flex-end; }
    .clone-field { display: flex; flex-direction: column; gap: 0.2rem; }
    .clone-field-url { flex: 3; }
    .clone-field-branch { flex: 1; }
    .clone-field-dest { flex: 3; }
    .clone-field-name { flex: 1.5; }
    .clone-field-action { flex-shrink: 0; }
    .clone-label { font-size: 0.58rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; color: var(--po-text-secondary); }
    .clone-input {
      background: var(--po-bg-0);
      border: 1px solid var(--po-border-subtle); border-radius: 4px;
      color: var(--po-text-primary); font-size: 0.72rem; padding: 0.3rem 0.5rem;
      font-family: monospace; outline: none; width: 100%;
    }
    .clone-input:focus { border-color: rgba(88,166,255,0.5); }
    .clone-input::placeholder { color: var(--po-text-secondary); font-size: 0.65rem; }
    .clone-path-row { display: flex; gap: 0.3rem; }
    .clone-path-input { flex: 1; min-width: 0; }
    .btn-clone-browse {
      display: flex; align-items: center; justify-content: center;
      width: 32px; height: 30px; border: 1px solid var(--po-border-subtle); border-radius: 4px;
      background: rgba(255,255,255,0.03); color: var(--po-text-secondary);
      cursor: pointer; flex-shrink: 0; transition: all var(--po-duration-fast);
    }
    .btn-clone-browse:hover { background: rgba(255,255,255,0.08); color: var(--po-text-primary); }
    .btn-clone-exec {
      display: flex; align-items: center; gap: 0.3rem;
      font-size: 0.72rem; font-weight: 600; padding: 0.3rem 1rem;
      border: 1px solid rgba(88,166,255,0.3); border-radius: 4px;
      background: rgba(88,166,255,0.1); color: var(--po-info); cursor: pointer;
      transition: all var(--po-duration-fast); white-space: nowrap; height: 30px;
    }
    .btn-clone-exec:hover:not(:disabled) { background: rgba(88,166,255,0.2); }
    .btn-clone-exec:disabled { opacity: 0.4; cursor: not-allowed; }
    .clone-feedback {
      display: flex; align-items: center; gap: 0.3rem;
      font-size: 0.65rem; padding: 0.2rem 0;
    }
    .clone-feedback.error { color: var(--po-error); }
    .clone-feedback.success { color: var(--po-success); }

    .topbar-divider { width: 1px; height: 28px; background: var(--po-border-subtle); margin: 0 0.2rem; }

    .git-search-box {
      display: flex; align-items: center; gap: 0.25rem;
      padding: 3px 8px; border-radius: 4px;
      border: 1px solid var(--po-border-subtle);
      background: rgba(255,255,255,0.03);
      color: var(--po-text-secondary);
    }
    .git-search-input {
      background: transparent; border: none; color: var(--po-text-primary);
      font-size: 0.72rem; outline: none; width: 150px;
    }
    .git-search-input::placeholder { color: var(--po-text-secondary); }

    .btn-git-icon {
      display: flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border: none; border-radius: 4px;
      background: transparent; color: var(--po-text-secondary); cursor: pointer;
    }
    .btn-git-icon:hover:not(:disabled) { background: rgba(255,255,255,0.08); color: var(--po-text-primary); }
    .btn-git-icon:disabled { opacity: 0.4; }
    .btn-git-close {
      display: flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border: none; border-radius: 4px;
      background: transparent; color: var(--po-text-secondary); cursor: pointer;
    }
    .btn-git-close:hover { background: rgba(248,81,73,0.15); color: var(--po-error); }

    .sync-banner {
      display: flex; align-items: center; gap: 0.4rem;
      padding: 0.3rem 1rem; font-size: 0.7rem; flex-shrink: 0;
    }
    .sync-banner.error {
      background: var(--po-error-bg); color: var(--po-error); border-bottom: 1px solid rgba(248,81,73,0.15);
      justify-content: flex-start;
    }
    .sync-banner.success { background: var(--po-success-bg); color: var(--po-success); border-bottom: 1px solid rgba(63,185,80,0.15); }
    .sync-error-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .btn-open-terminal {
      display: flex; align-items: center; gap: 0.25rem;
      background: rgba(248,81,73,0.12); border: 1px solid rgba(248,81,73,0.25);
      color: var(--po-error); border-radius: 4px; padding: 0.15rem 0.5rem;
      font-size: 0.65rem; cursor: pointer; white-space: nowrap; flex-shrink: 0;
    }
    .btn-open-terminal:hover { background: rgba(248,81,73,0.2); }
    .btn-dismiss-error {
      background: none; border: none; color: var(--po-error); cursor: pointer; padding: 0.1rem;
      opacity: 0.6; flex-shrink: 0;
    }
    .btn-dismiss-error:hover { opacity: 1; }

    .btn-ai-resolver-inline {
      display: flex; align-items: center; gap: 0.25rem;
      background: linear-gradient(90deg, rgba(110,86,207,0.22), rgba(166,114,255,0.22));
      border: 1px solid rgba(166,114,255,0.45);
      color: #cbb6ff; border-radius: 4px; padding: 0.15rem 0.55rem;
      font-size: 0.65rem; cursor: pointer; white-space: nowrap; flex-shrink: 0;
    }
    .btn-ai-resolver-inline:hover:not(:disabled) {
      background: linear-gradient(90deg, rgba(110,86,207,0.34), rgba(166,114,255,0.34));
    }
    .btn-ai-resolver-inline:disabled { opacity: 0.6; cursor: not-allowed; }
    .ai-resolver-log {
      background: var(--po-bg-0); border-bottom: 1px solid rgba(166,114,255,0.18);
      padding: 0.35rem 1rem; font-size: 0.65rem; display: flex; flex-direction: column; gap: 0.2rem;
    }
    .ai-resolver-step { display: flex; align-items: center; gap: 0.25rem; color: var(--po-text-secondary); }
    .ai-resolver-step iconify-icon { color: #a672ff; flex-shrink: 0; }
    .ai-resolver-step.done { color: var(--po-text-secondary); animation: aiStepIn 0.25s ease; }
    .ai-resolver-step.done iconify-icon { color: var(--po-success); }
    @keyframes aiStepIn { from { opacity: 0; transform: translateX(-3px); } to { opacity: 1; transform: none; } }
    .ai-resolver-working {
      display: flex; align-items: center; gap: 0.35rem;
      color: #cbb6ff; font-weight: 500; padding-bottom: 0.1rem;
    }
    .ai-resolver-working iconify-icon { color: #a672ff; flex-shrink: 0; }
    .ai-resolver-dots { display: inline-flex; gap: 2px; margin-left: 1px; }
    .ai-resolver-dots i {
      width: 3px; height: 3px; border-radius: 50%; background: #a672ff;
      display: inline-block; animation: aiDot 1.2s infinite ease-in-out both;
    }
    .ai-resolver-dots i:nth-child(2) { animation-delay: 0.18s; }
    .ai-resolver-dots i:nth-child(3) { animation-delay: 0.36s; }
    @keyframes aiDot { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }

    /* Mini terminal */
    .mini-terminal {
      background: var(--po-bg-0); border-bottom: 1px solid rgba(248,81,73,0.15);
      display: flex; flex-direction: column; max-height: 180px; flex-shrink: 0;
    }
    .mini-terminal-output {
      flex: 1; overflow-y: auto; padding: 0.4rem 0.6rem; font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.65rem; line-height: 1.5; min-height: 0;
    }
    .mini-terminal-line { color: var(--po-text-secondary); white-space: pre-wrap; word-break: break-all; }
    .mini-terminal-line.cmd { color: var(--po-info); }
    .mini-terminal-input-row {
      display: flex; align-items: center; gap: 0.3rem;
      padding: 0.3rem 0.6rem; border-top: 1px solid rgba(139,148,158,0.15);
      background: rgba(13,17,23,0.6);
    }
    .mini-terminal-prompt { color: var(--po-success); font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.65rem; }
    .mini-terminal-input {
      flex: 1; background: none; border: none; outline: none; color: var(--po-text-primary);
      font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.65rem;
    }
    .mini-terminal-input::placeholder { color: rgba(139,148,158,0.4); }
    .btn-mini-run {
      background: none; border: none; color: var(--po-success); cursor: pointer; padding: 0.1rem;
      display: flex; align-items: center;
    }
    .btn-mini-run:hover { color: var(--po-success); }
    .btn-mini-run:disabled { color: var(--po-text-tertiary); cursor: not-allowed; }

    /* ═════ MAIN 3-COL ═════ */
    .git-content { flex: 1; display: flex; min-height: 0; }

    /* ═════ LEFT SIDEBAR ═════ */
    .sidebar-left {
      width: 200px; flex-shrink: 0; display: flex; flex-direction: column;
      border-right: 1px solid var(--po-border-subtle);
      background: rgba(255,255,255,0.01); overflow-y: auto;
    }

    .sb-section {}
    .sb-section-header {
      display: flex; align-items: center; gap: 0.3rem;
      padding: 0.4rem 0.6rem; font-size: 0.7rem; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.04em;
      color: var(--po-text-secondary); cursor: pointer;
      user-select: none; transition: background var(--po-duration-instant);
    }
    .sb-section-header:hover { background: rgba(255,255,255,0.04); }
    .sb-count { font-size: 0.58rem; font-weight: 400; opacity: 0.6; }
    .sb-merge-btn {
      margin-left: auto;
      display: inline-flex; align-items: center; gap: 0.2rem;
      background: rgba(139, 92, 246, 0.12);
      border: 1px solid rgba(139, 92, 246, 0.3);
      color: rgba(196, 181, 253, 1);
      padding: 0.1rem 0.4rem; border-radius: 10px;
      font-size: 0.55rem; font-weight: 600;
      text-transform: none; letter-spacing: 0;
      cursor: pointer; transition: background 0.12s ease, border-color 0.12s ease;
    }
    .sb-merge-btn:hover {
      background: rgba(139, 92, 246, 0.22);
      border-color: rgba(139, 92, 246, 0.5);
      color: white;
    }

    /* Branch right-click context menu (GitKraken-style) */
    .branch-ctx-menu {
      position: fixed; z-index: 1090;
      min-width: 240px; max-width: 320px;
      max-height: min(70vh, 520px); overflow-y: auto;
      background: var(--po-surface, #161b22);
      border: 1px solid var(--po-border, #30363d);
      border-radius: 8px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.45);
      padding: 0.3rem;
      font-size: 0.75rem;
      color: var(--po-text, #e6edf3);
    }
    .bcm-header {
      display: flex; align-items: center; gap: 0.3rem;
      padding: 0.35rem 0.5rem;
      font-size: 0.65rem; font-weight: 600;
      color: var(--po-text-secondary, #8b949e);
      text-transform: uppercase; letter-spacing: 0.04em;
      border-bottom: 1px solid var(--po-border-subtle, rgba(255,255,255,0.05));
      margin-bottom: 0.25rem;
    }
    .bcm-branch-name {
      text-transform: none; letter-spacing: 0;
      color: var(--po-text, #e6edf3);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .bcm-item {
      display: flex; align-items: center; gap: 0.45rem;
      width: 100%; padding: 0.45rem 0.55rem;
      background: transparent; border: 0;
      color: var(--po-text, #e6edf3);
      font-size: 0.75rem; text-align: left;
      cursor: pointer; border-radius: 5px;
    }
    .bcm-item:hover { background: rgba(99, 102, 241, 0.1); }
    .bcm-item strong { color: rgba(196, 181, 253, 1); font-weight: 600; }
    .bcm-item:disabled { opacity: 0.45; cursor: default; }
    .bcm-item.bcm-danger { color: #f85149; }
    .bcm-item.bcm-danger strong { color: #f85149; }
    .bcm-item.bcm-danger:hover { background: rgba(248, 81, 73, 0.12); }
    .bcm-item.bcm-sub { padding-left: 2rem; font-size: 0.7rem; }
    .bcm-chevron { margin-left: auto; opacity: 0.5; flex-shrink: 0; }
    .bcm-sep { height: 1px; background: var(--po-border-subtle, rgba(255,255,255,0.06)); margin: 0.25rem 0.2rem; }
    .bcm-danger-header { color: #f85149; }
    .bcm-confirm-text {
      padding: 0.45rem 0.55rem;
      font-size: 0.7rem; line-height: 1.4;
      color: var(--po-text-secondary, #8b949e);
      max-width: 280px; white-space: normal;
    }
    .bcm-form { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.4rem 0.5rem; }
    .bcm-input {
      width: 100%; padding: 0.3rem 0.45rem;
      background: var(--po-bg, #0d1117);
      border: 1px solid var(--po-border, #30363d);
      border-radius: 5px;
      color: var(--po-text, #e6edf3);
      font-size: 0.72rem;
    }
    .bcm-input:focus { outline: none; border-color: rgba(99, 102, 241, 0.6); }
    .bcm-form-actions { display: flex; gap: 0.35rem; justify-content: flex-end; padding: 0.2rem 0.5rem 0.3rem; }
    .bcm-btn {
      padding: 0.28rem 0.6rem; border-radius: 5px;
      background: rgba(255,255,255,0.05);
      border: 1px solid var(--po-border, #30363d);
      color: var(--po-text, #e6edf3);
      font-size: 0.68rem; font-weight: 600; cursor: pointer;
    }
    .bcm-btn:hover { background: rgba(255,255,255,0.1); }
    .bcm-btn.primary {
      background: rgba(99, 102, 241, 0.2);
      border-color: rgba(99, 102, 241, 0.45);
      color: rgba(196, 181, 253, 1);
    }
    .bcm-btn.primary:hover { background: rgba(99, 102, 241, 0.35); }
    .bcm-btn.danger {
      background: rgba(248, 81, 73, 0.15);
      border-color: rgba(248, 81, 73, 0.4);
      color: #f85149;
    }
    .bcm-btn.danger:hover { background: rgba(248, 81, 73, 0.28); }
    .bcm-btn:disabled { opacity: 0.5; cursor: default; }
    .bcm-empty {
      padding: 0.4rem 0.55rem;
      font-size: 0.7rem; color: var(--po-text-secondary, #8b949e);
      font-style: italic;
    }

    /* Feedback toast for context-menu git operations */
    .git-toast {
      position: fixed; z-index: 1100;
      bottom: 22px; left: 50%; transform: translateX(-50%);
      display: flex; align-items: center; gap: 0.4rem;
      max-width: min(80vw, 560px);
      padding: 0.45rem 0.8rem; border-radius: 8px;
      background: var(--po-surface, #161b22);
      border: 1px solid rgba(63, 185, 80, 0.45);
      color: var(--po-success, #3fb950);
      font-size: 0.72rem; font-weight: 500;
      box-shadow: 0 10px 30px rgba(0,0,0,0.45);
    }
    .git-toast.err { border-color: rgba(248, 81, 73, 0.45); color: #f85149; }
    .git-toast span { white-space: normal; }
    .git-toast-action {
      flex-shrink: 0; margin-left: 0.3rem;
      padding: 0.15rem 0.55rem; border-radius: 6px;
      border: 1px solid currentColor; background: transparent;
      color: inherit; font-size: 0.68rem; font-weight: 600; cursor: pointer;
    }
    .git-toast-action:hover { background: rgba(255,255,255,0.06); }

    .sb-section-body {}

    .sb-branch-item {
      display: flex; align-items: center; gap: 0.3rem;
      padding: 0.2rem 0.6rem 0.2rem 1.4rem; font-size: 0.68rem;
      cursor: pointer; transition: background var(--po-duration-instant);
      color: var(--po-text-primary);
    }
    .sb-branch-item:hover { background: rgba(255,255,255,0.04); }
    .sb-branch-item.active { background: rgba(88,166,255,0.1); color: var(--po-info); }
    .sb-branch-item.current { font-weight: 600; }
    .sb-branch-item.remote { color: var(--po-text-secondary); }
    .sb-branch-item.tag { color: var(--po-warning); }
    .sb-branch-name {
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font-family: monospace; font-size: 0.66rem; min-width: 0;
    }
    .head-badge {
      font-size: 0.48rem; font-weight: 700; padding: 1px 4px; border-radius: 3px;
      background: var(--po-success-bg); color: var(--po-success); text-transform: uppercase;
      flex-shrink: 0;
    }
    .sb-new-branch-btn {
      background: rgba(63,185,80,0.12);
      border-color: rgba(63,185,80,0.3);
      color: var(--po-success);
    }
    .sb-new-branch-btn:hover {
      background: rgba(63,185,80,0.22);
      border-color: rgba(63,185,80,0.5);
      color: white;
    }
    .sb-checkout-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; flex-shrink: 0; margin-left: auto;
      background: transparent; border: none; border-radius: 3px;
      color: var(--po-info); cursor: pointer;
      opacity: 0; transition: opacity var(--po-duration-instant);
    }
    .sb-branch-item:hover .sb-checkout-btn { opacity: 1; }
    .sb-checkout-btn:hover { background: rgba(88,166,255,0.15); }
    .sb-checkout-btn:disabled { opacity: 0.3; cursor: not-allowed; }
    .sb-empty { padding: 0.5rem 1.4rem; font-size: 0.65rem; color: var(--po-text-secondary); }

    /* ═════ CENTER PANEL ═════ */
    .center-panel { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .center-loading {
      flex: 1; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 0.5rem; font-size: 0.8rem;
      color: var(--po-text-secondary);
    }

    .commit-list-scroll { flex: 1; overflow-y: auto; min-height: 0; }

    .commit-row {
      display: flex; align-items: center; border-bottom: 1px solid rgba(48,54,61,0.35);
      cursor: pointer; transition: background var(--po-duration-instant); height: 38px;
    }
    .commit-row:hover { background: rgba(255,255,255,0.03); }
    .commit-row.selected { background: var(--po-accent-muted-bg); }

    .graph-cell { flex-shrink: 0; height: 38px; overflow: hidden; position: relative; }
    .graph-svg { display: block; }
    .dot-hit { cursor: context-menu; }
    .graph-legend-hint { color: var(--po-text-secondary); cursor: help; opacity: 0.7; flex-shrink: 0; }

    /* Branch-tip badge on the graph (replaces the dot at branch tips) */
    .graph-tip-badge {
      position: absolute; top: 50%; transform: translateY(-50%);
      z-index: 2;
      display: inline-flex; align-items: center; gap: 3px;
      max-width: 96px; height: 16px;
      padding: 1px 5px; border-radius: 8px;
      font-size: 0.55rem; font-weight: 700; line-height: 1;
      background: var(--po-surface, #161b22);   /* opaque: masks the lane lines behind */
      border: 1px solid rgba(88,166,255,0.35); color: var(--po-info);
      white-space: nowrap; cursor: pointer;
      transition: filter var(--po-duration-fast);
    }
    .graph-tip-badge:hover { filter: brightness(1.35); }
    .gtb-name { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .gtb-more { opacity: 0.7; flex-shrink: 0; }
    .gtb-sync { color: var(--po-success); flex-shrink: 0; }
    .graph-tip-badge.k-head { border-color: rgba(63,185,80,0.6); color: var(--po-success); }
    .graph-tip-badge.k-local { border-color: rgba(99,102,241,0.55); color: #a5b4fc; border-style: dashed; }
    .graph-tip-badge.k-synced { border-color: rgba(88,166,255,0.45); color: var(--po-info); }
    .graph-tip-badge.k-remote { border-color: rgba(139,148,158,0.45); color: var(--po-text-secondary); border-style: dashed; }
    .graph-tip-badge.ref-filtered { box-shadow: 0 0 0 1px var(--po-info); }

    .commit-info {
      flex: 1; min-width: 0; padding: 0 0.6rem;
      display: flex; flex-direction: column; justify-content: center; gap: 1px;
    }
    .commit-top { display: flex; align-items: center; gap: 0.3rem; min-width: 0; }
    .commit-bottom { display: flex; align-items: center; gap: 0.45rem; }

    .ref-badge {
      display: inline-flex; align-items: center; gap: 3px;
      font-size: 0.56rem; font-weight: 700; padding: 1px 6px; border-radius: 9px;
      background: rgba(88,166,255,0.12); color: var(--po-info);
      border: 1px solid rgba(88,166,255,0.25);
      white-space: nowrap; flex-shrink: 0;
      max-width: 160px; overflow: hidden; text-overflow: ellipsis;
      cursor: pointer; transition: background var(--po-duration-fast);
    }
    .ref-badge:hover { background: rgba(88,166,255,0.25); }
    .ref-badge.ref-head {
      background: var(--po-success-bg); color: var(--po-success);
      border-color: rgba(63,185,80,0.35);
    }
    .ref-badge.ref-head:hover { background: rgba(63,185,80,0.25); }
    .ref-badge.ref-tag {
      background: var(--po-warning-bg); color: var(--po-warning);
      border-color: rgba(210,153,34,0.3); cursor: default;
    }
    .ref-badge.ref-remote {
      background: rgba(139,148,158,0.1); color: var(--po-text-secondary);
      border-color: rgba(139,148,158,0.25);
      border-style: dashed;                        /* dashed border = exists on one side only */
    }
    .ref-badge.ref-remote:hover { background: rgba(139,148,158,0.2); }
    .ref-badge.ref-local {
      background: rgba(99,102,241,0.14); color: #a5b4fc;
      border-color: rgba(99,102,241,0.35);
      border-style: dashed;                        /* local-only: not pushed yet */
    }
    .ref-badge.ref-local:hover { background: rgba(99,102,241,0.28); }
    .ref-badge.ref-synced { border-style: solid; } /* synced with origin: solid border */
    .ref-badge.ref-filtered { box-shadow: 0 0 0 1px var(--po-info); }
    .ref-badge.ref-more {
      background: rgba(255,255,255,0.06); color: var(--po-text-secondary);
      border-color: var(--po-border-subtle);
    }
    .ref-sync-icon { opacity: 1; color: var(--po-success); flex-shrink: 0; }

    .commit-msg {
      font-size: 0.74rem; font-weight: 500; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; min-width: 0;
    }
    .commit-hash { font-size: 0.6rem; font-family: monospace; color: var(--po-info); flex-shrink: 0; }
    .commit-author {
      display: flex; align-items: center; gap: 0.2rem;
      font-size: 0.6rem; color: var(--po-text-secondary); flex-shrink: 0;
    }
    .avatar-circle {
      width: 15px; height: 15px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.42rem; font-weight: 700; color: #fff; flex-shrink: 0;
    }
    .avatar-circle-sm {
      width: 17px; height: 17px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 0.48rem; font-weight: 700; color: #fff; flex-shrink: 0;
    }
    .commit-provider-icon { flex-shrink: 0; opacity: 0.6; }
    .merge-badge {
      display: inline-flex; align-items: center; gap: 2px;
      font-size: 0.5rem; font-weight: 700; padding: 1px 5px; border-radius: 3px;
      background: rgba(188,140,255,0.12); color: #bc8cff;
      text-transform: uppercase; white-space: nowrap; flex-shrink: 0;
    }
    .commit-date { font-size: 0.6rem; color: var(--po-text-secondary); white-space: nowrap; }
    .loading-more {
      display: flex; align-items: center; justify-content: center; gap: 0.4rem;
      padding: 0.5rem; font-size: 0.7rem; color: var(--po-text-secondary);
    }

    /* ── Commit detail pane (bottom of center) ── */
    .commit-detail-pane {
      border-top: 2px solid var(--po-info); max-height: 45vh;
      display: flex; flex-direction: column; flex-shrink: 0;
    }
    .detail-pane-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0.35rem 0.6rem; background: var(--po-accent-muted-bg); flex-shrink: 0;
    }
    .detail-pane-title {
      display: flex; align-items: center; gap: 0.3rem;
      font-size: 0.72rem; font-weight: 600; color: var(--po-info);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1;
    }
    .detail-pane-actions {
      display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;
    }
    .detail-stats-mini {
      display: flex; align-items: center; gap: 0.3rem; font-size: 0.6rem;
    }
    .dsm-files { color: var(--po-text-secondary); }
    .dsm-add { color: var(--po-success); font-weight: 700; }
    .dsm-del { color: var(--po-error); font-weight: 700; }
    .btn-git-icon-sm {
      display: flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; border: none; border-radius: 3px;
      background: transparent; color: var(--po-text-secondary); cursor: pointer;
    }
    .btn-git-icon-sm:hover { background: rgba(255,255,255,0.08); color: var(--po-text-primary); }

    .detail-pane-body { flex: 1; overflow-y: auto; }

    .detail-meta-grid {
      padding: 0.3rem 0; border-bottom: 1px solid rgba(48,54,61,0.4);
    }
    .detail-meta-row {
      display: flex; align-items: center; gap: 0.4rem;
      padding: 0.15rem 0.6rem; font-size: 0.65rem;
    }
    .dm-label {
      width: 50px; flex-shrink: 0; font-weight: 600; text-transform: uppercase;
      font-size: 0.58rem; color: var(--po-text-secondary); letter-spacing: 0.03em;
    }
    .dm-value {
      flex: 1; min-width: 0; display: flex; align-items: center; gap: 0.25rem; flex-wrap: wrap;
    }
    .dm-value.mono { font-family: monospace; font-size: 0.6rem; color: var(--po-text-secondary); word-break: break-all; }
    .btn-copy-sha {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; border: none; border-radius: 3px;
      background: transparent; color: var(--po-text-secondary);
      cursor: pointer; transition: all var(--po-duration-fast); flex-shrink: 0;
    }
    .btn-copy-sha:hover { background: rgba(255,255,255,0.08); color: var(--po-info); }
    .parent-link { color: var(--po-info); cursor: pointer; font-family: monospace; }
    .parent-link:hover { text-decoration: underline; }

    /* Commit body */
    .commit-body-section {
      padding: 0.35rem 0.6rem; border-bottom: 1px solid rgba(48,54,61,0.4);
    }
    .commit-body-text {
      margin: 0; font-size: 0.68rem; line-height: 1.6; white-space: pre-wrap;
      word-break: break-word; color: var(--po-text-primary);
      font-family: inherit; background: none;
    }

    /* Stats summary bar */
    .stats-summary-bar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0.35rem 0.6rem; gap: 0.6rem;
      background: rgba(255,255,255,0.02);
      border-bottom: 1px solid rgba(48,54,61,0.4);
    }
    .history-file-controls {
      flex-wrap: wrap; min-width: 0;
      font-size: 0.65rem; color: var(--po-text-secondary);
    }
    .history-file-controls > span { white-space: nowrap; flex-shrink: 0; }
    .history-file-controls input {
      flex: 1 1 120px; width: 0; min-width: 0; max-width: 100%; box-sizing: border-box;
      padding: 4px 8px; border-radius: 4px;
      background: var(--po-bg-primary); color: var(--po-text-primary);
      border: 1px solid var(--po-border-subtle); font-size: 0.7rem;
    }
    .history-page-btn {
      flex-shrink: 0; padding: 4px 8px; border-radius: 4px;
      border: 1px solid var(--po-border-subtle); background: transparent;
      color: var(--po-text-primary); font-size: 0.7rem; cursor: pointer;
    }
    .history-page-btn:disabled { opacity: 0.4; cursor: default; }
    .stats-summary-left {
      display: flex; align-items: center; gap: 0.35rem;
      font-size: 0.65rem; color: var(--po-text-secondary); flex-shrink: 0;
    }
    .stats-add-badge {
      font-size: 0.6rem; font-weight: 700; color: var(--po-success);
      padding: 1px 5px; border-radius: 3px; background: var(--po-success-bg);
    }
    .stats-del-badge {
      font-size: 0.6rem; font-weight: 700; color: var(--po-error);
      padding: 1px 5px; border-radius: 3px; background: var(--po-error-bg);
    }
    .stats-bar-visual {
      display: flex; height: 6px; border-radius: 3px; overflow: hidden;
      flex: 1; max-width: 150px; background: rgba(255,255,255,0.05);
    }
    .bar-segment { min-width: 0; transition: flex 0.3s; }
    .bar-segment.bar-add { background: var(--po-success); }
    .bar-segment.bar-del { background: var(--po-error); }

    /* File diff bar */
    .diff-file-bar {
      display: flex; gap: 1px; flex-shrink: 0; margin-left: 0.3rem;
    }
    .dfbar-add { height: 8px; background: var(--po-success); border-radius: 1px; min-width: 0; }
    .dfbar-del { height: 8px; background: var(--po-error); border-radius: 1px; min-width: 0; }

    .diff-empty {
      display: flex; align-items: center; justify-content: center; gap: 0.4rem;
      padding: 1.5rem; font-size: 0.7rem; color: var(--po-text-secondary);
    }

    .diff-loading-inline {
      display: flex; align-items: center; gap: 0.4rem; padding: 0.6rem;
      font-size: 0.7rem; color: var(--po-text-secondary);
    }
    .diff-file { border-top: 1px solid var(--po-border-subtle); }
    .diff-file-header {
      display: flex; align-items: center; gap: 0.3rem;
      padding: 0.3rem 0.6rem; font-size: 0.68rem;
      cursor: pointer; background: rgba(255,255,255,0.02);
    }
    .diff-file-header:hover { background: rgba(255,255,255,0.04); }
    .diff-file-name {
      font-family: monospace; font-size: 0.65rem; flex: 1; min-width: 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .dficon-added { color: var(--po-success); }
    .dficon-deleted { color: var(--po-error); }
    .dficon-modified { color: var(--po-warning); }
    .diff-file-stats { display: flex; gap: 0.3rem; font-size: 0.6rem; font-weight: 700; flex-shrink: 0; }
    .stat-a { color: var(--po-success); }
    .stat-d { color: var(--po-error); }

    .diff-file-body { font-family: monospace; font-size: 0.63rem; line-height: 1.5; overflow-x: auto; }
    .dline { display: flex; white-space: pre; min-width: fit-content; }
    .dln { width: 34px; text-align: right; padding-right: 5px; flex-shrink: 0; color: var(--po-text-tertiary); user-select: none; }
    .dlpfx { width: 12px; flex-shrink: 0; text-align: center; user-select: none; }
    .dltxt { flex: 1; padding-right: 0.5rem; }
    .dline-add { background: var(--po-success-bg); }
    .dline-add .dlpfx { color: var(--po-success); }
    .dline-del { background: var(--po-error-bg); }
    .dline-del .dlpfx { color: var(--po-error); }
    .dline-hunk { background: rgba(88,166,255,0.08); color: var(--po-info); font-style: italic; }

    /* ── Review notes (annotate the agent's diff) ── */
    .dline-row { min-width: fit-content; }
    .dnote-btn {
      width: 14px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
      cursor: pointer; color: var(--po-text-tertiary); opacity: 0; transition: opacity .12s, color .12s;
      user-select: none;
    }
    .dnote-btn.spacer { cursor: default; }
    .dline:hover .dnote-btn { opacity: 0.55; }
    .dnote-btn:hover { opacity: 1 !important; color: var(--po-primary); }
    .dnote-btn.has { opacity: 1; color: var(--po-primary); }
    .dline-noted { box-shadow: inset 2px 0 0 var(--po-primary); }
    .dnote-box {
      margin: 3px 0 4px 14px; padding: 6px; border: 1px solid var(--po-border);
      border-left: 2px solid var(--po-primary); border-radius: 5px;
      background: var(--po-bg-elevated, var(--po-bg-secondary)); max-width: 620px;
    }
    .dnote-input {
      width: 100%; resize: vertical; font-family: inherit; font-size: 0.66rem; line-height: 1.4;
      color: var(--po-text-primary); background: var(--po-bg-primary);
      border: 1px solid var(--po-border); border-radius: 4px; padding: 5px 6px;
    }
    .dnote-input:focus { outline: none; border-color: var(--po-primary); }
    .dnote-actions { display: flex; gap: 5px; justify-content: flex-end; margin-top: 5px; }
    .dnote-btn-act {
      padding: 3px 9px; font-size: 0.62rem; border-radius: 4px; cursor: pointer;
      border: 1px solid var(--po-border); background: transparent; color: var(--po-text-secondary);
    }
    .dnote-btn-act:hover { color: var(--po-text-primary); border-color: var(--po-text-tertiary); }
    .dnote-btn-act.primary { background: var(--po-primary); border-color: var(--po-primary); color: #fff; }
    .dnote-btn-act.primary:disabled { opacity: 0.45; cursor: not-allowed; }
    .dnote-btn-act.danger { color: var(--po-error); }
    .dnote-chip {
      display: flex; align-items: center; gap: 5px; margin: 2px 0 3px 14px; padding: 3px 7px;
      max-width: 620px; border-radius: 4px; cursor: pointer; white-space: normal;
      background: rgba(99,102,241,0.10); border-left: 2px solid var(--po-primary);
      color: var(--po-text-secondary); font-size: 0.63rem; font-family: var(--po-font, inherit);
    }
    .dnote-chip:hover { background: rgba(99,102,241,0.18); }
    .dnote-chip-text { flex: 1; }
    .dnote-chip-x {
      background: none; border: none; padding: 0; cursor: pointer; color: var(--po-text-tertiary);
      display: flex; align-items: center;
    }
    .dnote-chip-x:hover { color: var(--po-error); }
    .dnote-bar {
      position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 10010;
      display: flex; align-items: center; gap: 9px; padding: 8px 12px;
      border-radius: 9px; border: 1px solid var(--po-border);
      background: var(--po-bg-elevated, var(--po-bg-secondary));
      box-shadow: 0 8px 26px rgba(0,0,0,0.35); font-size: 0.7rem; color: var(--po-text-primary);
    }
    .dnote-bar-count { font-weight: 600; }
    .dnote-bar-files { color: var(--po-text-tertiary); }
    .dnote-bar-btn {
      display: flex; align-items: center; gap: 4px; padding: 4px 10px; font-size: 0.66rem;
      border-radius: 5px; cursor: pointer; border: 1px solid var(--po-border);
      background: transparent; color: var(--po-text-secondary);
    }
    .dnote-bar-btn:hover { color: var(--po-text-primary); }
    .dnote-bar-btn.primary { background: var(--po-primary); border-color: var(--po-primary); color: #fff; }
    .dnote-bar-btn.primary:hover { filter: brightness(1.1); color: #fff; }
    .overlay-body { padding: 0.35rem 0.5rem; }

    /* ═════ RIGHT SIDEBAR ═════ */
    .sidebar-right {
      width: 280px; flex-shrink: 0; display: flex; flex-direction: column;
      border-left: 1px solid var(--po-border-subtle);
      background: rgba(255,255,255,0.01);
    }

    .wr-section { display: flex; flex-direction: column; min-height: 0; flex: 1; }
    .wr-section-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0.4rem 0.6rem;
      border-bottom: 1px solid var(--po-border-subtle);
      flex-shrink: 0;
    }
    .wr-section-title {
      display: flex; align-items: center; gap: 0.3rem;
      font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
      color: var(--po-text-secondary);
    }
    .wr-count {
      font-size: 0.55rem; min-width: 16px; height: 16px; border-radius: 8px;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--po-warning-bg); color: var(--po-warning); font-weight: 700;
    }
    .wr-count.staged { background: var(--po-success-bg); color: var(--po-success); }

    .btn-wr-action {
      display: flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; border: none; border-radius: 3px;
      background: transparent; cursor: pointer; transition: all var(--po-duration-fast);
    }
    .btn-wr-action:disabled { opacity: 0.3; cursor: not-allowed; }
    .btn-stage-all { color: var(--po-success); }
    .btn-stage-all:hover:not(:disabled) { background: var(--po-success-bg); }
    .btn-unstage-all { color: var(--po-warning); }
    .btn-unstage-all:hover:not(:disabled) { background: var(--po-warning-bg); }
    .btn-discard-all { color: var(--po-error); }
    .btn-discard-all:hover:not(:disabled) { background: var(--po-error-bg); }

    .wr-file-list { flex: 1; overflow-y: auto; overflow-x: hidden; min-height: 0; min-width: 0; }

    .wr-folder-row {
      display: flex; align-items: center; gap: 0.3rem;
      padding: 0.22rem 0.4rem; font-size: 0.68rem; cursor: pointer;
      transition: background var(--po-duration-instant); user-select: none;
    }
    .wr-folder-row:hover { background: rgba(255,255,255,0.04); }
    .wr-folder-row:hover .folder-action { opacity: 1; }
    .wr-folder-chevron { flex-shrink: 0; color: var(--po-text-secondary); }
    .wr-folder-icon { flex-shrink: 0; color: var(--po-warning); }
    .wr-folder-icon.staged { color: var(--po-success); }
    .wr-folder-name {
      flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font-family: monospace; font-size: 0.63rem; font-weight: 600;
      color: var(--po-text-primary);
    }
    .wr-folder-count {
      font-size: 0.52rem; min-width: 14px; height: 14px; border-radius: 7px;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--po-warning-bg); color: var(--po-warning); font-weight: 700; flex-shrink: 0;
    }
    .wr-folder-count.staged { background: var(--po-success-bg); color: var(--po-success); }
    .folder-action { opacity: 0; transition: opacity var(--po-duration-instant); }

    .wr-file-row {
      display: flex; align-items: center; gap: 0.3rem;
      padding: 0.18rem 0.6rem; font-size: 0.68rem; cursor: pointer;
      transition: background var(--po-duration-instant);
    }
    .wr-file-row:hover { background: rgba(255,255,255,0.04); }
    .wr-file-row.staged { background: rgba(63,185,80,0.03); }

    .wr-file-status {
      font-size: 0.6rem; font-weight: 700; width: 14px; text-align: center; flex-shrink: 0;
    }
    .wst-modified { color: var(--po-warning); }
    .wst-added, .wst-untracked { color: var(--po-success); }
    .wst-deleted { color: var(--po-error); }
    .wst-renamed { color: var(--po-info); }
    .wst-conflict { color: var(--po-error); }

    .wr-file-name {
      flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font-family: monospace; font-size: 0.65rem;
    }

    .btn-wr-file-action {
      display: flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; border: none; border-radius: 3px;
      background: transparent; color: var(--po-success); cursor: pointer;
      opacity: 0; transition: all var(--po-duration-instant); flex-shrink: 0;
    }
    .btn-wr-file-action.unstage { color: var(--po-warning); }
    .btn-wr-file-action.discard { color: var(--po-error); }
    .btn-wr-file-action.discard:hover { background: var(--po-error-bg); }
    .wr-file-row:hover .btn-wr-file-action { opacity: 1; }
    .btn-wr-file-action:hover { background: var(--po-success-bg); }
    .btn-wr-file-action.unstage:hover { background: var(--po-warning-bg); }

    .wr-empty {
      display: flex; align-items: center; justify-content: center; gap: 0.3rem;
      padding: 0.6rem; font-size: 0.68rem; color: var(--po-text-secondary);
    }

    /* ── Commit block ── */
    .wr-commit-section {
      border-top: 1px solid var(--po-border-subtle);
      padding: 0.5rem 0.6rem; flex-shrink: 0;
    }
    .wr-commit-input {
      width: 100%; background: var(--po-bg-0);
      border: 1px solid var(--po-border-subtle); border-radius: 4px;
      color: var(--po-text-primary); font-size: 0.72rem; padding: 0.3rem 0.4rem;
      resize: none; font-family: inherit;
    }
    .wr-commit-input::placeholder { color: var(--po-text-secondary); }
    .wr-commit-input:focus { outline: none; border-color: rgba(88,166,255,0.5); }

    .wr-commit-actions { display: flex; gap: 0.3rem; margin-top: 0.35rem; }

    .btn-wr-commit {
      display: flex; align-items: center; gap: 0.2rem;
      font-size: 0.68rem; font-weight: 600; padding: 4px 10px;
      border: 1px solid; border-radius: 4px; cursor: pointer; transition: all var(--po-duration-fast);
    }
    .btn-wr-commit:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-ai-msg { border-color: rgba(188,140,255,0.3); background: rgba(188,140,255,0.08); color: #bc8cff; }
    .btn-ai-msg:hover:not(:disabled) { background: rgba(188,140,255,0.18); }
    .btn-do-commit { border-color: rgba(63,185,80,0.3); background: rgba(63,185,80,0.08); color: var(--po-success); flex: 1; justify-content: center; }
    .btn-do-commit:hover:not(:disabled) { background: rgba(63,185,80,0.18); }

    .wr-feedback { font-size: 0.63rem; padding: 0.2rem 0; margin-top: 0.2rem; }
    .wr-feedback.error { color: var(--po-error); }

    /* ═════ DIFF OVERLAY ═════ */
    .diff-overlay {
      position: fixed; inset: 0; z-index: 10000;
      background: rgba(0,0,0,0.6);
      display: flex; align-items: center; justify-content: center;
    }
    .diff-overlay-panel {
      width: 80vw; max-width: 900px; max-height: 80vh;
      background: var(--po-bg-0);
      border: 1px solid var(--po-border-subtle); border-radius: 8px;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    .diff-overlay-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--po-border-subtle); flex-shrink: 0;
    }
    .diff-overlay-title {
      display: flex; align-items: center; gap: 0.3rem;
      font-size: 0.78rem; font-weight: 600; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .diff-overlay-body { flex: 1; overflow: auto; min-height: 0; }
    .diff-overlay-pre {
      margin: 0; padding: 0.5rem; font-size: 0.7rem; line-height: 1.5;
      font-family: 'SF Mono', 'Fira Code', monospace; white-space: pre;
    }
    .diff-overlay-pre span { display: block; padding: 0 0.5rem; }
    .diff-line-add { background: var(--po-success-bg); color: var(--po-success); }
    .diff-line-del { background: var(--po-error-bg); color: var(--po-error); }
    .diff-line-hunk { color: #bc8cff; font-weight: 600; background: rgba(188,140,255,0.06); }
    .diff-line-meta { color: var(--po-text-secondary); }
    .diff-line-ctx { color: var(--po-text-primary); }

    /* ═════ IMAGE DIFF PREVIEW ═════ */
    .img-diff-compare {
      display: flex; gap: 12px; align-items: stretch; justify-content: center;
      padding: 12px; flex-wrap: wrap;
    }
    .img-diff-compare.overlay { min-height: 200px; align-items: center; }
    .img-diff-pane {
      display: flex; flex-direction: column; align-items: center; gap: 6px;
      flex: 1 1 0; min-width: 120px; max-width: 48%;
    }
    .img-diff-pane img {
      max-width: 100%; max-height: 45vh; object-fit: contain;
      border: 1px solid var(--po-border-subtle); border-radius: 4px;
      background: repeating-conic-gradient(#23242e 0% 25%, #1a1b23 0% 50%) 0 0 / 16px 16px;
    }
    .img-diff-label {
      font-size: 0.63rem; font-weight: 600; padding: 1px 8px; border-radius: 8px;
      border: 1px solid var(--po-border-subtle); color: var(--po-text-secondary);
    }
    .img-diff-label.old { color: var(--po-error); border-color: rgba(248,81,73,0.35); background: var(--po-error-bg); }
    .img-diff-label.new { color: var(--po-success); border-color: rgba(63,185,80,0.35); background: var(--po-success-bg); }
    .img-diff-empty {
      display: flex; align-items: center; gap: 6px;
      font-size: 0.7rem; color: var(--po-text-secondary); padding: 16px;
    }
    .diff-binary-note {
      font-size: 0.7rem; color: var(--po-text-secondary);
      padding: 10px 12px; font-style: italic;
    }

    /* ═════ FILE CONTEXT MENU ═════ */
    .git-ctx-backdrop {
      position: fixed; inset: 0; z-index: 9998;
    }
    .git-ctx-menu {
      position: fixed; z-index: 9999;
      min-width: 180px;
      max-width: min(300px, calc(100vw - 16px));
      background: var(--po-bg-1, #1e1e2e);
      border: 1px solid var(--po-border-subtle);
      border-radius: 6px;
      box-shadow: 0 6px 20px rgba(0,0,0,0.5);
      padding: 4px 0;
      overflow: hidden;
    }
    .git-ctx-header {
      padding: 0.3rem 0.65rem;
      font-size: 0.6rem; font-weight: 600;
      color: var(--po-text-secondary);
      font-family: monospace;
      border-bottom: 1px solid var(--po-border-subtle);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      max-width: 220px;
    }
    .git-ctx-item {
      display: flex; align-items: center; gap: 0.4rem;
      width: 100%; padding: 0.35rem 0.65rem;
      background: none; border: none;
      font-size: 0.72rem; color: var(--po-text-primary);
      cursor: pointer; transition: background var(--po-duration-instant);
      text-align: left;
    }
    .git-ctx-item:hover { background: rgba(255,255,255,0.06); }
    .git-ctx-item.danger { color: var(--po-error); }
    .git-ctx-item.danger:hover { background: rgba(248,81,73,0.1); }

    /* Search/Solo dimming: rows stay in place (graph topology intact), non-matches fade. */
    .commit-row { transition: opacity 0.15s ease; }
    .commit-row.dim-row { opacity: 0.22; }
    .commit-row.dim-row:hover { opacity: 0.6; }

    .search-match-count {
      margin-left: 4px; padding: 1px 6px; border-radius: 8px;
      font-size: 0.6rem; font-weight: 700;
      background: rgba(63,185,80,0.15); color: var(--po-success);
    }
    .search-match-count.none { background: rgba(248,81,73,0.15); color: var(--po-error); }

    /* ═════ UTILS ═════ */
    .spinning { animation: spin 1s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .text-muted { color: var(--po-text-secondary) !important; }
  `,
})
export class SessionGitExplorerComponent implements OnInit, OnDestroy {
  private modal = inject(NgbActiveModal);
  protected git = inject(GitService);
  protected setup = inject(GitSetupService);
  protected gitSettings = inject(GitSettingsService);
  private readonly translate = inject(TranslateService);

  /** Translated GIT_EXPLORER string. */
  private tr(key: string, params?: Record<string, unknown>): string {
    return this.translate.instant('GIT_EXPLORER.' + key, params);
  }

  /** Escapes branch names interpolated into translated HTML ([innerHTML] labels). */
  esc(value: unknown): string {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Origin info (loaded via diagnose)
  originRemote = signal<{ url: string; type: 'ssh' | 'https' | 'unknown'; host: string | null } | null>(null);

  isRepo = computed(() => !!this.currentBranch());

  // Multi-repo discovery
  discoveredRepos = signal<{ name: string; path: string; branch: string }[]>([]);
  activeRepoPath = signal<string | null>(null);
  private _originalCwd = '';

  private _cwd = '';
  get cwd(): string { return this._cwd; }
  set cwd(value: string) {
    this._cwd = value;
    if (!this._originalCwd) this._originalCwd = value;
    this.git.reset();
    this.commits.set([]);
    this.allBranches.set([]);
    this.currentBranch.set('');
    this.closeCommitDetail();
    this.expandedStagedFolders.set(new Set());
    this.expandedUnstagedFolders.set(new Set());
    this.filterWorkingFiles('staged', '');
    this.filterWorkingFiles('unstaged', '');
    this.selectedBranch.set(null);
    this.parsedDiffFiles.set([]);
    this.commitBody.set('');
    this.commitStats.set(null);
    this.historyError.set(null);
    this.diffOverlayFile.set(null);
    this.diffOverlayContent.set('');
    this.clearNotes();
    this.columnMap.clear();
    this.maxCol.set(0);
    this.syncInfo.set(null);
    this.searchQuery = '';
    this.closeBranchMenu();
    this.worktrees.set([]);
    this.closeWorktreeMenu();
    this.showClonePanel.set(false);
    this.cloneUrl = '';
    this.cloneBranch = '';
    this.cloneDirName = '';
    this.cloneParentDir.set('');
    this.cloneSuccess.set(null);
    if (value) {
      this.loadHistoryAndDiscover();
    }
  }

  private async loadHistoryAndDiscover(): Promise<void> {
    await this.loadHistory();
    this.git.refresh(this._cwd);
    // Fetch once on open so counters/notifications start from fresh remote state.
    if (this.isRepo()) void this.syncNow();
    if (this.isRepo()) void this.loadWorktrees();
    // If not a repo, try discovering repos in subfolders
    if (!this.isRepo()) {
      const root = this._cwd;
      const repos = await this.git.discoverRepos(root);
      this.discoveredRepos.set(repos);
      if (repos.length > 0) {
        // Restore the repo picked last time (here or in the sidebar quick-commit);
        // fall back to the first one discovered.
        const remembered = this.git.rememberedRepoPick(root);
        this.switchToRepo(repos.find(r => r.path === remembered) ?? repos[0]);
      }
    } else {
      this.discoveredRepos.set([]);
    }
  }

  onRepoSwitch(path: string): void {
    const repo = this.discoveredRepos().find(r => r.path === path);
    if (repo) this.switchToRepo(repo);
  }

  switchToRepo(repo: { name: string; path: string; branch: string }): void {
    // Persist the pick and mirror it on the sidebar quick-commit dropdown.
    // _cwd is about to become the repo path, so key on the workspace root.
    this.git.rememberRepoPick(this._originalCwd || this._cwd, repo.path);
    this.activeRepoPath.set(repo.path);
    this.loadRepoAt(repo.path);
  }

  /** Point the explorer at another repo/worktree path and reload everything. */
  private loadRepoAt(path: string): void {
    this._cwd = path;
    this.worktrees.set([]);
    this.closeWorktreeMenu();
    this.git.reset();
    this.commits.set([]);
    this.allBranches.set([]);
    this.currentBranch.set('');
    this.closeCommitDetail();
    this.expandedStagedFolders.set(new Set());
    this.expandedUnstagedFolders.set(new Set());
    this.filterWorkingFiles('staged', '');
    this.filterWorkingFiles('unstaged', '');
    this.selectedBranch.set(null);
    this.parsedDiffFiles.set([]);
    this.commitBody.set('');
    this.commitStats.set(null);
    this.historyError.set(null);
    this.diffOverlayFile.set(null);
    this.diffOverlayContent.set('');
    this.columnMap.clear();
    this.maxCol.set(0);
    this.syncInfo.set(null);
    this.searchQuery = '';
    this.closeBranchMenu();
    void this.loadHistory().then(() => { if (this.isRepo()) void this.loadWorktrees(); });
    this.git.refresh(path);
  }
  provider = '';

  // History state
  commits = signal<GitCommit[]>([]);
  allBranches = signal<string[]>([]);
  currentBranch = signal('');
  selectedCommit = signal<GitCommit | null>(null);
  selectedBranch = signal<string | null>(null);
  loading = signal(false);
  diffLoading = signal(false);
  stashing = signal(false);
  stashPopping = signal(false);
  parsedDiffFiles = signal<DiffFile[]>([]);
  readonly Math = Math;
  commitError = signal('');
  commitFileFilter = signal('');
  commitFilePage = signal(0);
  filteredCommitFiles = computed(() => {
    const query = this.commitFileFilter().toLowerCase();
    return this.parsedDiffFiles().filter(file => file.path.toLowerCase().includes(query));
  });
  commitFilePageCount = computed(() => Math.max(1, Math.ceil(this.filteredCommitFiles().length / 50)));
  visibleCommitFiles = computed(() => this.filteredCommitFiles().slice(this.commitFilePage() * 50, (this.commitFilePage() + 1) * 50));
  private detailRequest = 0;
  private previewRequest = 0;
  private previewBusy = false;
  private queuedPreview: DiffFile | null = null;
  commitBody = signal('');
  commitStats = signal<CommitStats | null>(null);
  copiedSha = signal(false);

  // Folders start closed; each directory (including root) has its own page.
  private expandedUnstagedFolders = signal<Set<string>>(new Set());
  private expandedStagedFolders = signal<Set<string>>(new Set());
  private unstagedFolderPages = signal<Map<string, number>>(new Map());
  private stagedFolderPages = signal<Map<string, number>>(new Map());
  unstagedFileFilter = signal('');
  stagedFileFilter = signal('');
  unstagedTree = computed(() => buildFileTree(this.git.unstagedFiles() ?? [], this.unstagedFileFilter()));
  stagedTree = computed(() => buildFileTree(this.git.stagedFiles() ?? [], this.stagedFileFilter()));
  unstagedTreeRows = computed(() => visibleTreeRows(this.unstagedTree(), this.expandedUnstagedFolders(), this.unstagedFolderPages()));
  stagedTreeRows = computed(() => visibleTreeRows(this.stagedTree(), this.expandedStagedFolders(), this.stagedFolderPages()));

  filterWorkingFiles(section: 'staged' | 'unstaged', query: string): void {
    (section === 'staged' ? this.stagedFileFilter : this.unstagedFileFilter).set(query);
    (section === 'staged' ? this.stagedFolderPages : this.unstagedFolderPages).set(new Map());
  }

  changeTreePage(section: 'staged' | 'unstaged', page: TreePage, delta: number): void {
    (section === 'staged' ? this.stagedFolderPages : this.unstagedFolderPages).update(pages => {
      const next = new Map(pages);
      next.set(page.path, Math.max(0, Math.min(page.pages - 1, page.page + delta)));
      return next;
    });
  }

  // Context menu for file rows
  ctxMenuVisible = signal(false);
  ctxMenuX = signal(0);
  ctxMenuY = signal(0);
  ctxMenuFile = signal<{ path: string; status: string; staged: boolean } | null>(null);
  private ctxCloseListener: (() => void) | null = null;

  // Diff overlay (for working directory files)
  diffOverlayFile = signal<string | null>(null);
  diffOverlayContent = signal('');
  diffOverlayLoading = signal(false);
  diffOverlayImage = signal<{ status: string; oldUrl: string | null; newUrl: string | null } | null>(null);

  // Mini terminal
  miniTerminalCmd = '';

  // Clone panel
  showClonePanel = signal(false);
  cloneUrl = '';
  cloneBranch = '';
  cloneDirName = '';
  cloneParentDir = signal('');
  cloneSuccess = signal<string | null>(null);

  searchQuery = '';
  localExpanded = true;
  remoteExpanded = true;
  tagsExpanded = false;

  private loadLimit = 100;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  // Graph state
  private columnMap = new Map<string, number>();
  private maxCol = signal(0);
  // +108px label gutter: room for the branch-tip badges (max-width 96px) next to the lanes
  graphWidth = computed(() => Math.max((this.maxCol() + 1) * 24 + 16, 60) + 108);

  // Computed: split branches
  localBranches = computed(() => this.allBranches().filter(b => !b.startsWith('origin/')));
  remoteBranches = computed(() => this.allBranches().filter(b => b.startsWith('origin/')));

  // Tags extracted from commit refs
  tags = computed(() => {
    const tagSet = new Set<string>();
    for (const c of this.commits()) {
      for (const r of c.refs) {
        if (r.startsWith('tag:')) tagSet.add(r.replace(/^tag:\s*/, ''));
      }
    }
    return Array.from(tagSet);
  });

  ngOnInit(): void {
    this.refreshInterval = setInterval(() => {
      // Windows "Safe terminal": pause the git-status poll (main-thread blocking
      // git status is the prime Windows-lag suspect). Only ever true on Windows.
      if ((window as any).__PO_SAFE_TERMINAL__) return;
      if (this._cwd) this.git.refresh(this._cwd);
      void this.reloadHistoryIfRefsMoved();
    }, 10000);
    // Background auto-fetch: keeps ahead/behind counters fresh and notifies
    // when new upstream commits land. Skipped while hidden or already fetching.
    this.fetchTimer = setInterval(() => {
      if ((window as any).__PO_SAFE_TERMINAL__) return;
      if (document.hidden || !this._cwd || !this.isRepo() || this.fetching()) return;
      void this.syncNow();
    }, 180000);
    window.addEventListener('focus', this.onWindowFocus);
    document.addEventListener('visibilitychange', this.onWindowFocus);
  }

  /** Back to the app after git ran elsewhere (terminal, other client): resync now, not in 10s. */
  private onWindowFocus = (): void => {
    if (document.hidden || !this._cwd || (window as any).__PO_SAFE_TERMINAL__) return;
    this.git.refresh(this._cwd);
    void this.reloadHistoryIfRefsMoved();
  };

  ngOnDestroy(): void {
    this.closeCommitDetail();
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    window.removeEventListener('focus', this.onWindowFocus);
    document.removeEventListener('visibilitychange', this.onWindowFocus);
    if (this.fetchTimer) clearInterval(this.fetchTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.closeCtxMenu();
    this.closeBranchCtx();
  }

  // ── Sync status: ahead/behind vs upstream + background fetch ──

  syncInfo = signal<{ ahead: number; behind: number; upstream: string } | null>(null);
  fetching = signal(false);
  private fetchTimer: ReturnType<typeof setInterval> | null = null;

  /** Refresh the ↑/↓ counters only (no network). */
  private async refreshSyncCounters(): Promise<void> {
    if (!this._cwd || !this.isRepo()) { this.syncInfo.set(null); return; }
    const res = await this.git.aheadBehind(this._cwd);
    if (res.ok) {
      this.syncInfo.set({ ahead: res.ahead ?? 0, behind: res.behind ?? 0, upstream: res.upstream || 'upstream' });
    } else {
      this.syncInfo.set(null);
    }
  }

  /** Fetch from remote, refresh counters, and notify when new upstream commits landed. */
  async syncNow(): Promise<void> {
    if (!this._cwd || this.fetching()) return;
    this.fetching.set(true);
    try {
      const prevBehind = this.syncInfo()?.behind ?? 0;
      const fetched = await this.git.fetchRemote(this._cwd);
      await this.refreshSyncCounters();
      const behind = this.syncInfo()?.behind ?? 0;
      if (fetched.ok && behind > prevBehind) {
        const fresh = behind - prevBehind;
        this.showGitToast('ok', this.tr(fresh === 1 ? 'New commits one' : 'New commits many', { count: fresh, upstream: this.syncInfo()?.upstream || 'upstream' }));
        this.loadHistory(); // upstream moved: refresh so origin/* tips are current
      } else if (fetched.ok) {
        await this.reloadHistoryIfRefsMoved(); // other origin/* tips may have moved
      }
    } finally {
      this.fetching.set(false);
    }
  }

  // ── History ──

  // ── Search / Solo dimming ──
  // Rows are never removed (that would desync the graph lines, which are indexed
  // on the full commit list): non-matching rows are dimmed instead, keeping the
  // topology readable while searching — same pattern as dedicated git clients.
  private dimCacheKey = '';
  private dimSetCache: Set<string> | null = null;   // null = no filter active

  private dimSet(): Set<string> | null {
    const q = this.searchQuery.toLowerCase().trim();
    const solo = this.selectedBranch() || '';
    const list = this.commits();
    const key = `${q}|${solo}|${list.length}|${list[0]?.hash || ''}`;
    if (key === this.dimCacheKey) return this.dimSetCache;
    this.dimCacheKey = key;
    if (!q && !solo) { this.dimSetCache = null; return null; }

    // Solo: true ancestor set (BFS over all parents) from the branch tip —
    // dims commits unreachable from the selected branch.
    let soloSet: Set<string> | null = null;
    if (solo) {
      const byHash = new Map(list.map(c => [c.hash, c]));
      const tip = list.find(c =>
        c.refs.some(r => r === solo || r === `HEAD -> ${solo}` || r.endsWith(`/${solo}`))
      );
      soloSet = new Set<string>();
      const queue = tip ? [tip.hash] : [];
      while (queue.length) {
        const h = queue.pop()!;
        if (soloSet.has(h)) continue;
        soloSet.add(h);
        for (const p of byHash.get(h)?.parents || []) {
          if (byHash.has(p)) queue.push(p);
        }
      }
    }

    const dim = new Set<string>();
    for (const c of list) {
      const okSolo = !soloSet || soloSet.has(c.hash);
      const okQuery = !q ||
        c.message.toLowerCase().includes(q) ||
        c.shortHash.includes(q) ||
        c.hash.includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.refs.some(r => r.toLowerCase().includes(q));
      if (!(okSolo && okQuery)) dim.add(c.hash);
    }
    this.dimSetCache = dim;
    return dim;
  }

  isDimmed(c: GitCommit): boolean {
    const s = this.dimSet();
    return !!s && s.has(c.hash);
  }

  matchCount(): number {
    const s = this.dimSet();
    return s ? this.commits().length - s.size : this.commits().length;
  }

  historyError = signal<string | null>(null);

  async loadHistory(): Promise<void> {
    if (!this._cwd) {
      this.historyError.set(this.tr('No workspace path'));
      return;
    }
    this.loading.set(true);
    this.historyError.set(null);

    // Safety timeout - if IPC hangs, stop loading after 15s
    const safetyTimer = setTimeout(() => {
      if (this.loading()) {
        this.loading.set(false);
        this.historyError.set(this.tr('Log timeout'));
      }
    }, 15000);

    try {
      const cwd = this._cwd;
      const [result, fingerprint] = await Promise.all([
        this.git.fetchLog(cwd, this.loadLimit),
        this.git.refsFingerprint(cwd),
      ]);
      if (fingerprint !== null) { this.refsFingerprint = fingerprint; this.refsFingerprintCwd = cwd; }
      clearTimeout(safetyTimer);
      if (result?.ok) {
        const commits = this.assignGraphColumns(result.commits || []);
        this.badgeCache.clear();
        this.tipCache.clear();
        this.commits.set(commits);
        this.allBranches.set(result.branches || []);
        this.currentBranch.set(result.currentBranch || '');
        this.loadRemoteInfo();
        void this.refreshSyncCounters();
      } else {
        this.historyError.set(result?.error || 'Failed to load history');
      }
    } catch (err: any) {
      clearTimeout(safetyTimer);
      this.historyError.set(err?.message || 'Failed to load history');
    }
    this.loading.set(false);
  }

  private refsFingerprint: string | null = null;
  private refsFingerprintCwd: string | null = null;

  /** Poll hook: reload the graph when HEAD or any ref moved outside the explorer
   *  (checkout/merge/pull from the git panel, the terminal or an agent). */
  private async reloadHistoryIfRefsMoved(): Promise<void> {
    const cwd = this._cwd;
    if (!cwd || this.loading() || document.hidden || !this.commits().length) return;
    const fingerprint = await this.git.refsFingerprint(cwd);
    if (fingerprint === null || cwd !== this._cwd || this.loading()) return;
    const prev = this.refsFingerprintCwd === cwd ? this.refsFingerprint : null;
    this.refsFingerprint = fingerprint;
    this.refsFingerprintCwd = cwd;
    if (prev !== null && prev !== fingerprint) await this.loadHistory();
  }

  refresh(): void {
    this.loadLimit = 100;
    this.loadHistory();
    if (this.cwd) this.git.refresh(this.cwd);
  }

  loadMore(): void {
    this.loadLimit += 100;
    this.loadHistory();
  }

  // ── Worktrees ──

  worktrees = signal<GitWorktree[]>([]);
  worktreesLoading = signal(false);
  worktreeMenuOpen = signal(false);
  wtCreateOpen = signal(false);
  wtBusy = signal<string | null>(null);
  wtError = signal<string | null>(null);
  wtConfirm = signal<{ path: string; force: boolean } | null>(null);
  wtBranch = '';
  wtPath = '';
  wtNewBranch = true;
  wtPathTouched = false;
  private wtRequest = 0;
  activeWorktree = computed(() => this.worktrees().find(w => w.current) ?? null);
  hasPrunable = computed(() => this.worktrees().some(w => w.prunable));

  async loadWorktrees(): Promise<void> {
    const cwd = this._cwd;
    if (!cwd) return;
    const id = ++this.wtRequest;
    this.worktreesLoading.set(true);
    try {
      const res = await this.git.listWorktrees(cwd);
      if (id !== this.wtRequest || cwd !== this._cwd) return;
      this.worktrees.set(res.ok ? res.worktrees ?? [] : []);
      if (!res.ok && this.worktreeMenuOpen()) this.wtError.set(res.error || null);
    } finally {
      if (id === this.wtRequest) this.worktreesLoading.set(false);
    }
  }

  toggleWorktreeMenu(): void {
    if (this.worktreeMenuOpen()) {
      this.closeWorktreeMenu();
      return;
    }
    this.closeBranchMenu();
    this.wtError.set(null);
    this.wtConfirm.set(null);
    this.wtCreateOpen.set(false);
    this.worktreeMenuOpen.set(true);
    void this.loadWorktrees();
  }

  /** Esc closes the worktree menu (first the open confirmation or form, then the menu). */
  @HostListener('document:keydown.escape', ['$event'])
  onWorktreeEscape(evt: Event): void {
    if (!this.worktreeMenuOpen()) return;
    evt.preventDefault();
    evt.stopPropagation();
    if (this.wtConfirm()) this.wtConfirm.set(null);
    else if (this.wtCreateOpen()) this.wtCreateOpen.set(false);
    else this.closeWorktreeMenu();
  }

  closeWorktreeMenu(): void {
    this.worktreeMenuOpen.set(false);
    this.wtCreateOpen.set(false);
    this.wtConfirm.set(null);
  }

  openWorktree(wt: GitWorktree): void {
    if (wt.current || wt.prunable || wt.bare) return;
    this.loadRepoAt(wt.path);
    this.showGitToast('ok', this.translate.instant('SESSIONS.WORKTREES.Opened', { name: wt.name }));
  }

  openWorktreeCreate(): void {
    this.wtBranch = '';
    this.wtPath = '';
    this.wtPathTouched = false;
    this.wtNewBranch = true;
    this.wtError.set(null);
    this.wtCreateOpen.set(true);
  }

  /** Suggest a sibling folder named after the main worktree and the branch, until the user edits the path. */
  onWorktreeBranchChange(): void {
    if (this.wtPathTouched) return;
    const main = this.worktrees().find(w => w.main);
    const base = main?.name || 'worktree';
    const slug = this.wtBranch.trim().replace(/[\\/\s]+/g, '-').replace(/[^A-Za-z0-9._-]/g, '');
    this.wtPath = slug ? `../${base}-${slug}` : '';
  }

  async createWorktree(): Promise<void> {
    const branch = this.wtBranch.trim();
    const path = this.wtPath.trim();
    if (!branch || !path || this.wtBusy()) return;
    this.wtBusy.set('create');
    this.wtError.set(null);
    try {
      const res = await this.git.addWorktree(this.cwd, path, branch, this.wtNewBranch, this.wtNewBranch ? this.currentBranch() || undefined : undefined);
      if (!res.ok) {
        this.wtError.set(res.error || 'Worktree add failed');
        return;
      }
      this.wtCreateOpen.set(false);
      this.showGitToast('ok', this.translate.instant('SESSIONS.WORKTREES.Created', { path: res.path || path }));
      await this.loadWorktrees();
      this.loadHistory();
    } finally {
      this.wtBusy.set(null);
    }
  }

  askRemoveWorktree(wt: GitWorktree): void {
    this.wtError.set(null);
    // Dirty worktrees go straight to the "changes will be lost" confirmation.
    this.wtConfirm.set({ path: wt.path, force: (wt.changes ?? 0) > 0 || wt.locked });
  }

  async removeWorktree(wt: GitWorktree, force: boolean): Promise<void> {
    if (this.wtBusy()) return;
    this.wtBusy.set(wt.path);
    this.wtError.set(null);
    try {
      const res = await this.git.removeWorktree(this.cwd, wt.path, force);
      if (!res.ok) {
        if (!force && (res.dirty || res.locked)) {
          this.wtConfirm.set({ path: wt.path, force: true });
          return;
        }
        this.wtError.set(res.error || 'Worktree remove failed');
        return;
      }
      this.wtConfirm.set(null);
      this.showGitToast('ok', this.translate.instant('SESSIONS.WORKTREES.Removed'));
      await this.loadWorktrees();
    } finally {
      this.wtBusy.set(null);
    }
  }

  async pruneWorktrees(): Promise<void> {
    if (this.wtBusy()) return;
    this.wtBusy.set('prune');
    try {
      const res = await this.git.pruneWorktrees(this.cwd);
      if (!res.ok) {
        this.wtError.set(res.error || 'Worktree prune failed');
        return;
      }
      this.showGitToast('ok', this.translate.instant('SESSIONS.WORKTREES.Pruned', { count: res.pruned ?? 0 }));
      await this.loadWorktrees();
    } finally {
      this.wtBusy.set(null);
    }
  }

  // ── Branch interactions ──

  branchMenuOpen = signal(false);
  createBranchOpen = signal(false);
  branchFilter = '';
  switchingBranch = signal(false);
  creatingBranch = signal(false);

  selectBranch(branch: string): void {
    this.selectedBranch.set(this.selectedBranch() === branch ? null : branch);
  }

  toggleBranchMenu(): void {
    this.branchMenuOpen() ? this.closeBranchMenu() : this.openBranchMenu();
  }

  openBranchMenu(withCreate = false): void {
    this.closeWorktreeMenu();
    this.branchFilter = '';
    this.createBranchOpen.set(withCreate);
    this.branchMenuOpen.set(true);
  }

  closeBranchMenu(): void {
    this.branchMenuOpen.set(false);
    this.createBranchOpen.set(false);
  }

  openBranchMenuWithCreate(): void {
    this.openBranchMenu(true);
  }

  stripRemote(branch: string): string {
    return branch.replace(/^origin\//, '');
  }

  filteredLocalBranches(): string[] {
    const q = this.branchFilter.toLowerCase().trim();
    const list = this.localBranches();
    return q ? list.filter(b => b.toLowerCase().includes(q)) : list;
  }

  /** Remote branches that have no local counterpart (checkout creates a tracking branch). */
  filteredRemoteOnlyBranches(): string[] {
    const locals = new Set(this.localBranches());
    const q = this.branchFilter.toLowerCase().trim();
    return this.remoteBranches()
      .filter(b => !locals.has(this.stripRemote(b)))
      .filter(b => !q || b.toLowerCase().includes(q));
  }

  async checkoutBranch(branch: string): Promise<void> {
    if (!this.cwd || this.switchingBranch()) return;
    const target = this.stripRemote(branch);
    if (target === this.currentBranch()) return;
    this.switchingBranch.set(true);
    try {
      await this.git.checkout(this.cwd, target);
      const err = this.git.syncError();
      if (!err) {
        this.closeBranchMenu();
        this.selectedBranch.set(null);
        await this.loadHistory();
      } else if (this.isDirtyCheckoutError(err)) {
        // GitKraken: uncommitted changes block the switch → offer to stash them first
        this.showGitToast('err', this.tr('Dirty checkout', { target }), {
          label: this.tr('Stash checkout'),
          run: () => void this.stashAndCheckout(target),
        });
      }
    } finally {
      this.switchingBranch.set(false);
    }
  }

  private isDirtyCheckoutError(msg: string): boolean {
    const m = msg.toLowerCase();
    // Untracked collisions are left out: the stash below doesn't take untracked files
    if (m.includes('untracked working tree files')) return false;
    return m.includes('would be overwritten') || m.includes('commit your changes or stash');
  }

  /** Stash the tracked changes, then switch.
   *  Like GitKraken the stash is NOT auto-popped: it stays on the source branch's work. */
  async stashAndCheckout(target: string): Promise<void> {
    if (!this.cwd) return;
    const api = (window as any).promptops;
    try {
      const res = await api.gitStash(this.cwd);
      if (!res?.ok) { this.showGitToast('err', res?.error || this.tr('Stash failed')); return; }
    } catch (e: any) {
      this.showGitToast('err', e?.message || this.tr('Stash failed'));
      return;
    }
    this.git.syncError.set(null);
    await this.checkoutBranch(target);
    if (!this.git.syncError()) this.showGitToast('ok', this.tr('Stashed switched', { target }));
    else await this.loadHistory(); // stash landed anyway: show it in the graph
  }

  async doCreateBranch(): Promise<void> {
    if (!this.cwd || !this.git.newBranchName().trim() || this.creatingBranch()) return;
    this.creatingBranch.set(true);
    try {
      await this.git.createBranch(this.cwd);
      if (!this.git.syncError()) {
        this.closeBranchMenu();
        this.selectedBranch.set(null);
        await this.loadHistory();
      }
    } finally {
      this.creatingBranch.set(false);
    }
  }

  generateBranchName(): void {
    if (this.cwd && this.provider) {
      this.git.generateBranchName(this.cwd, this.provider as any);
    }
  }

  // ── Merge: modal + context menu ──

  mergeModalOpen = signal(false);
  mergeInitialSource = signal<string | null>(null);

  branchCtxVisible = signal(false);
  branchCtxX = signal(0);
  branchCtxY = signal(0);
  branchCtxBranch = signal<string | null>(null);
  branchCtxCommit = signal<GitCommit | null>(null);      // commit the menu was opened on (null from sidebar)
  branchCtxList = signal<string[] | null>(null);          // multi-branch dot: pick a branch first
  ctxMode = signal<'menu' | 'branch-input' | 'tag-input' | 'rename-input' | 'reword-input'>('menu');
  ctxConfirm = signal<{ text: string; confirmLabel: string; run: () => void } | null>(null);
  ctxResetOpen = signal(false);
  ctxBusy = signal<string | null>(null);
  ctxInputName = '';
  ctxInputMsg = '';
  gitToast = signal<{ kind: 'ok' | 'err'; text: string; action?: { label: string; run: () => void } } | null>(null);
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private branchCtxCloseListener: (() => void) | null = null;

  openMergeModal(): void {
    this.mergeInitialSource.set(null);
    this.mergeModalOpen.set(true);
  }

  openMergeModalWithSource(source: string): void {
    this.mergeInitialSource.set(source);
    this.mergeModalOpen.set(true);
  }

  closeMergeModal(): void {
    this.mergeModalOpen.set(false);
    this.mergeInitialSource.set(null);
  }

  onMergeCompleted(): void {
    this.loadHistory();
    if (this.cwd) this.git.refresh(this.cwd);
  }

  /** Quick action: merge a source branch directly into the current branch with default strategy. */
  async mergeIntoCurrent(source: string): Promise<void> {
    if (!this.cwd || !this.currentBranch() || source === this.currentBranch()) return;
    const result = await this.git.merge(this.cwd, [source], this.currentBranch(), 'default', undefined, false);
    if (!result.ok && (result.dirty || result.conflict)) {
      // Open the modal so the user can review state and decide (auto-stash, abort, resolve)
      this.openMergeModalWithSource(source);
      return;
    }
    if (result.ok) this.onMergeCompleted();
  }

  onBranchContextMenu(evt: MouseEvent, branch: string, commit?: GitCommit): void {
    this.branchCtxBranch.set(branch);
    this.branchCtxCommit.set(commit ?? null);
    this.branchCtxList.set(null);
    this.openCtxAt(evt);
  }

  /** Right-click on a graph dot: commit actions always, branch actions when the dot is a tip. */
  openCommitCtx(evt: MouseEvent, branch: string | null, commit: GitCommit): void {
    this.branchCtxBranch.set(branch);
    this.branchCtxCommit.set(commit);
    this.branchCtxList.set(null);
    this.openCtxAt(evt);
  }

  /** Multiple branches point at the same dot: show a pick list first. */
  openBranchListCtx(evt: MouseEvent, branches: string[], commit: GitCommit): void {
    this.branchCtxBranch.set(null);
    this.branchCtxCommit.set(commit);
    this.branchCtxList.set(branches);
    this.openCtxAt(evt);
  }

  /** In-menu branch pick: swap the list for the standard actions (menu stays open — root stops propagation). */
  pickCtxBranch(branch: string): void {
    this.branchCtxList.set(null);
    this.branchCtxBranch.set(branch);
  }

  private openCtxAt(evt: MouseEvent): void {
    evt.preventDefault();
    evt.stopPropagation();
    this.ctxMode.set('menu');
    this.ctxConfirm.set(null);
    this.ctxResetOpen.set(false);
    // Keep the (potentially tall) menu inside the viewport.
    let y = evt.clientY;
    if (window.innerHeight - y < 340) y = Math.max(8, window.innerHeight - 348);
    this.branchCtxX.set(Math.max(8, Math.min(evt.clientX, window.innerWidth - 330)));
    this.branchCtxY.set(y);
    this.branchCtxVisible.set(true);
    if (!this.branchCtxCloseListener) {
      const close = () => this.closeBranchCtx();
      document.addEventListener('click', close, { once: true });
      document.addEventListener('contextmenu', close, { once: true });
      this.branchCtxCloseListener = () => {
        document.removeEventListener('click', close);
        document.removeEventListener('contextmenu', close);
      };
    }
  }

  closeBranchCtx(): void {
    this.branchCtxVisible.set(false);
    this.branchCtxBranch.set(null);
    this.branchCtxCommit.set(null);
    this.branchCtxList.set(null);
    this.ctxConfirm.set(null);
    this.ctxMode.set('menu');
    this.ctxResetOpen.set(false);
    if (this.branchCtxCloseListener) {
      this.branchCtxCloseListener();
      this.branchCtxCloseListener = null;
    }
  }

  // ── Context-menu git operations ──

  showGitToast(kind: 'ok' | 'err', text: string, action?: { label: string; run: () => void }): void {
    this.gitToast.set({ kind, text, action });
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.gitToast.set(null), action ? 12000 : kind === 'err' ? 6000 : 3000);
  }

  /** Shared runner: busy guard, toast feedback, close menu, refresh history on completion. */
  private async runCtxAction(
    label: string,
    fn: () => Promise<{ ok: boolean; error?: string; conflict?: boolean; dirty?: boolean }>,
    opts?: { successMsg?: string; conflictMsg?: string },
  ): Promise<void> {
    if (this.ctxBusy()) return;
    this.ctxBusy.set(label);
    try {
      const res = await fn();
      this.closeBranchCtx();
      if (res.ok) {
        this.showGitToast('ok', opts?.successMsg || this.tr('Action done', { label }));
        this.onMergeCompleted();
      } else if (res.dirty) {
        this.showGitToast('err', res.error || this.tr('Action dirty', { label }));
      } else if (res.conflict) {
        this.showGitToast('err', opts?.conflictMsg || this.tr('Action conflicts', { label }));
      } else {
        this.showGitToast('err', res.error || this.tr('Action failed', { label }));
      }
    } finally {
      this.ctxBusy.set(null);
    }
  }

  doFastForward(branch: string): void {
    const current = this.currentBranch();
    void this.runCtxAction(
      this.tr('Label fast forward', { current }),
      () => this.git.merge(this.cwd, [branch], current, 'ff-only'),
      { successMsg: this.tr('Fast forwarded', { current, branch }) },
    );
  }

  doRebase(branch: string): void {
    const current = this.currentBranch();
    void this.runCtxAction(
      this.tr('Label rebase', { current }),
      () => this.git.rebase(this.cwd, branch),
      {
        successMsg: this.tr('Rebased', { current, branch }),
        conflictMsg: this.tr('Rebase conflicts'),
      },
    );
  }

  doCherryPick(): void {
    const c = this.branchCtxCommit();
    if (!c) return;
    void this.runCtxAction(this.tr('Label cherry pick', { hash: c.shortHash }), () => this.git.cherryPick(this.cwd, c.hash), {
      successMsg: this.tr('Cherry picked', { hash: c.shortHash, current: this.currentBranch() }),
      conflictMsg: this.tr('Cherry conflicts', { hash: c.shortHash }),
    });
  }

  doRevert(): void {
    const c = this.branchCtxCommit();
    if (!c) return;
    void this.runCtxAction(this.tr('Label revert', { hash: c.shortHash }), () => this.git.revert(this.cwd, c.hash), {
      successMsg: this.tr('Reverted', { hash: c.shortHash }),
      conflictMsg: this.tr('Revert conflicts', { hash: c.shortHash }),
    });
  }

  askReset(mode: 'soft' | 'mixed' | 'hard'): void {
    const c = this.branchCtxCommit();
    if (!c) return;
    const current = this.currentBranch();
    const detail = mode === 'hard'
      ? this.tr('Reset hard detail')
      : mode === 'soft'
        ? this.tr('Reset soft detail')
        : this.tr('Reset mixed detail');
    this.ctxConfirm.set({
      text: this.tr('Reset confirm', { current, hash: c.shortHash, mode, detail }),
      confirmLabel: `Reset --${mode}`,
      run: () => {
        this.ctxConfirm.set(null);
        void this.runCtxAction(this.tr('Label reset', { current }), () => this.git.resetToCommit(this.cwd, c.hash, mode), {
          successMsg: this.tr('Reset done', { current, hash: c.shortHash, mode }),
        });
      },
    });
  }

  askDeleteBranch(): void {
    const branch = this.branchCtxBranch();
    if (!branch) return;
    const isRemote = branch.startsWith('origin/');
    this.ctxConfirm.set({
      text: isRemote
        ? this.tr('Delete remote confirm', { branch })
        : this.tr('Delete local confirm', { branch }),
      confirmLabel: this.tr('Delete'),
      run: () => void this.doDeleteBranch(branch, isRemote, false),
    });
  }

  private async doDeleteBranch(branch: string, remote: boolean, force: boolean): Promise<void> {
    if (this.ctxBusy()) return;
    this.ctxBusy.set(`Delete ${branch}`);
    try {
      const res = await this.git.deleteBranch(this.cwd, branch, { force, remote });
      if (res.ok) {
        this.closeBranchCtx();
        this.showGitToast('ok', this.tr(remote ? 'Deleted branch origin' : 'Deleted branch', { branch }));
        this.onMergeCompleted();
      } else if (res.notMerged && !remote && !force) {
        // Escalation: keep the menu open and ask again for a force delete.
        this.ctxConfirm.set({
          text: this.tr('Not merged confirm', { branch }),
          confirmLabel: this.tr('Force delete'),
          run: () => void this.doDeleteBranch(branch, remote, true),
        });
      } else {
        this.closeBranchCtx();
        this.showGitToast('err', res.error || this.tr('Delete failed', { branch }));
      }
    } finally {
      this.ctxBusy.set(null);
    }
  }

  doCreateBranchHere(): void {
    const c = this.branchCtxCommit();
    const name = this.ctxInputName.trim();
    if (!c || !name || this.ctxBusy()) return;
    void this.runCtxAction(this.tr('Label create branch', { name }), () => this.git.createBranchAt(this.cwd, name, c.hash), {
      successMsg: this.tr('Created branch', { name, hash: c.shortHash }),
    });
  }

  doCreateTagHere(): void {
    const c = this.branchCtxCommit();
    const name = this.ctxInputName.trim();
    if (!c || !name || this.ctxBusy()) return;
    void this.runCtxAction(this.tr('Label create tag', { name }), () => this.git.createTag(this.cwd, name, c.hash, this.ctxInputMsg.trim() || undefined), {
      successMsg: this.tr('Created tag', { name, hash: c.shortHash }),
    });
  }

  /** The commit HEAD points at — the only one whose message can be amended. */
  isHeadCommit(c: GitCommit): boolean {
    return c.refs.some(r => r === 'HEAD' || r.startsWith('HEAD ->'));
  }

  doRenameBranch(): void {
    const branch = this.branchCtxBranch();
    const newName = this.ctxInputName.trim();
    if (!branch || !newName || newName === branch || this.ctxBusy()) return;
    void this.runCtxAction(this.tr('Rename title', { branch }), () => this.git.renameBranch(this.cwd, branch, newName), {
      successMsg: this.tr('Renamed', { branch, name: newName }),
    });
  }

  /** Amend the HEAD commit message. When it's already on a remote, the handler
   *  refuses and the menu escalates to an explicit history-rewrite confirm. */
  async doRewordHead(allowPushed: boolean): Promise<void> {
    const msg = this.ctxInputMsg.trim();
    if (!msg || this.ctxBusy()) return;
    this.ctxBusy.set('Amend last commit');
    try {
      const res = await this.git.amendCommit(this.cwd, msg, allowPushed);
      if (res.ok) {
        this.closeBranchCtx();
        this.showGitToast('ok', this.tr('Message updated'));
        this.onMergeCompleted();
      } else if (res.pushed && !allowPushed) {
        this.ctxConfirm.set({
          text: this.tr('Amend published confirm'),
          confirmLabel: this.tr('Amend anyway'),
          run: () => { this.ctxConfirm.set(null); void this.doRewordHead(true); },
        });
      } else {
        this.closeBranchCtx();
        this.showGitToast('err', res.error || this.tr('Amend failed'));
      }
    } finally {
      this.ctxBusy.set(null);
    }
  }

  copyCtxText(text: string): void {
    navigator.clipboard?.writeText(text);
    this.closeBranchCtx();
    this.showGitToast('ok', this.tr('Copied clipboard'));
  }

  async copyRemoteLink(kind: 'commit' | 'branch'): Promise<void> {
    const commit = this.branchCtxCommit();
    const branch = this.branchCtxBranch();
    this.closeBranchCtx();
    const res = await this.git.remoteUrl(this.cwd);
    const base = res.ok ? res.webUrl : null;
    if (!base) {
      this.showGitToast('err', this.tr('Origin unrecognized'));
      return;
    }
    const url = kind === 'commit' && commit
      ? `${base}/commit/${commit.hash}`
      : `${base}/tree/${encodeURIComponent(this.stripRemote(branch || ''))}`;
    navigator.clipboard?.writeText(url);
    this.showGitToast('ok', this.tr('Link copied'));
  }

  // ── Graph dot interactions ──

  /** Single click on a dot: select the commit WITHOUT the toggle behavior of the row click,
   *  and stop propagation so the row's (click) doesn't double-fire during a dblclick. */
  onDotClick(evt: MouseEvent, commit: GitCommit): void {
    evt.stopPropagation();
    if (this.selectedCommit()?.hash !== commit.hash) this.selectCommit(commit);
  }

  /** Double click on a branch-tip dot: checkout. One branch = straight switch; more = pick menu. */
  onDotDblClick(evt: MouseEvent, commit: GitCommit): void {
    evt.preventDefault();
    evt.stopPropagation();
    const tip = this.tipInfo(commit);
    if (!tip.isTip) return;
    if (tip.branches.length === 1) {
      this.checkoutBranch(tip.branches[0]);
      return;
    }
    this.openBranchListCtx(evt, tip.branches, commit);
  }

  /** Right-click on any dot: context menu with commit actions; branch actions when it's a tip. */
  onDotContextMenu(evt: MouseEvent, commit: GitCommit): void {
    const tip = this.tipInfo(commit);
    if (tip.branches.length > 1) {
      this.openBranchListCtx(evt, tip.branches, commit);
      return;
    }
    this.openCommitCtx(evt, tip.branches[0] ?? null, commit);
  }

  // ── Commit detail ──

  closeCommitDetail(): void {
    this.detailRequest++;
    this.clearCommitPreviews();
    this.selectedCommit.set(null);
    this.parsedDiffFiles.set([]);
    this.commitBody.set('');
    this.commitStats.set(null);
    this.diffLoading.set(false);
  }

  private clearCommitPreviews(): void {
    this.previewRequest++;
    this.queuedPreview = null;
    for (const file of this.parsedDiffFiles()) {
      file.expanded = false;
      file.lines = [];
      file.oldImageUrl = file.newImageUrl = null;
      file.imagesLoaded = false;
      file.loading = false;
      file.linePage = 0;
    }
  }

  filterCommitFiles(query: string): void {
    this.clearCommitPreviews();
    this.commitFileFilter.set(query);
    this.commitFilePage.set(0);
  }

  changeCommitFilePage(delta: number): void {
    this.clearCommitPreviews();
    this.commitFilePage.update(page => Math.max(0, Math.min(this.commitFilePageCount() - 1, page + delta)));
  }

  changeDiffLinePage(file: DiffFile, delta: number): void {
    file.linePage = Math.max(0, Math.min(Math.ceil(file.lines.length / 200) - 1, (file.linePage || 0) + delta));
    this.parsedDiffFiles.update(files => [...files]);
  }

  async selectCommit(commit: GitCommit): Promise<void> {
    const wasSelected = this.selectedCommit()?.hash === commit.hash;
    this.closeCommitDetail();
    if (wasSelected) return;
    const request = this.detailRequest;
    const cwd = this.cwd;
    this.selectedCommit.set(commit);
    this.diffLoading.set(true);
    this.commitError.set('');
    this.commitFileFilter.set('');
    this.commitFilePage.set(0);
    this.detailCommitHash = commit.hash;
    this.detailParentHash = commit.parents?.[0] ?? null;
    const current = () => request === this.detailRequest && cwd === this.cwd && this.selectedCommit()?.hash === commit.hash;
    try {
      const result = await (window as any).promptops.gitCommitFiles(cwd, commit.hash);
      if (!current()) return;
      if (!result.ok) throw new Error(result.error || 'Unable to load changed files');
      this.commitBody.set(result.body || '');
      this.parsedDiffFiles.set(result.files.map((file: { path: string; status: string }) => ({
        ...file, lines: [], additions: 0, deletions: 0, expanded: false,
      })));
      this.commitStats.set({ files: [], summary: '', filesChanged: result.files.length, insertions: 0, deletions: 0 });
    } catch (error) {
      if (current()) this.commitError.set(String(error));
    } finally {
      if (current()) this.diffLoading.set(false);
    }
  }

  private detailCommitHash: string | null = null;
  private detailParentHash: string | null = null;

  async toggleDiffFile(file: DiffFile): Promise<void> {
    if (file.expanded) {
      this.clearCommitPreviews();
      return;
    }
    // Keep at most one preview request in flight, including image decoding.
    if (this.previewBusy) {
      this.queuedPreview = file;
      return;
    }
    this.clearCommitPreviews();
    const request = this.previewRequest;
    const hash = this.detailCommitHash;
    const cwd = this.cwd;
    const current = () => request === this.previewRequest && cwd === this.cwd && this.selectedCommit()?.hash === hash;
    file.expanded = true;
    file.loading = true;
    file.error = '';
    this.previewBusy = true;
    try {
      const result = await (window as any).promptops.gitCommitFileDiff(cwd, hash, file.path);
      if (!current()) return;
      if (!result.ok) throw new Error(result.error || 'Unable to load file');
      const parsed = this.parseDiff(result.diff)[0];
      file.lines = parsed?.lines || [];
      file.additions = parsed?.additions || 0;
      file.deletions = parsed?.deletions || 0;
      file.isBinary = parsed?.isBinary;
      file.isImage = isRasterImagePath(file.path) && file.lines.length === 0 && !result.truncated;
      file.truncated = !!result.truncated;
      if (file.isImage) await this.loadCommitFileImages(file);
    } catch (error) {
      if (current()) file.error = String(error);
    } finally {
      this.previewBusy = false;
      if (current()) {
        file.loading = false;
        this.parsedDiffFiles.update(files => [...files]);
      }
      const queued = this.queuedPreview;
      this.queuedPreview = null;
      if (queued && this.parsedDiffFiles().includes(queued)) void this.toggleDiffFile(queued);
    }
  }

  /** Lazy-load old/new image previews for a committed raster file. */
  private async loadCommitFileImages(file: DiffFile): Promise<void> {
    const hash = this.detailCommitHash;
    if (!hash || file.imagesLoaded) return;
    const parent = this.detailParentHash;
    const cwd = this.cwd;
    const request = this.previewRequest;
    const current = () => request === this.previewRequest && cwd === this.cwd && this.selectedCommit()?.hash === hash;
    try {
      if (file.status !== 'deleted') {
        const res = await this.git.showFileBase64(cwd, hash, file.path);
        if (!current()) return;
        file.newImageUrl = res.ok && res.exists && res.data && res.mimeType ? toDataUrl(res.mimeType, res.data) : null;
      } else {
        file.newImageUrl = null;
      }
      if (file.status !== 'added' && parent) {
        const res = await this.git.showFileBase64(cwd, parent, file.path);
        if (!current()) return;
        file.oldImageUrl = res.ok && res.exists && res.data && res.mimeType ? toDataUrl(res.mimeType, res.data) : null;
      } else {
        file.oldImageUrl = null;
      }
    } catch {
      file.oldImageUrl = file.oldImageUrl ?? null;
      file.newImageUrl = file.newImageUrl ?? null;
    }
    if (!current()) return;
    file.imagesLoaded = true;
    this.parsedDiffFiles.update(arr => [...arr]);
  }

  goToCommit(hash: string): void {
    const c = this.commits().find(x => x.hash.startsWith(hash));
    if (c) this.selectCommit(c);
  }

  // ── Working directory actions ──

  async stageAll(): Promise<void> {
    if (!this.cwd) return;
    const paths = (this.git.unstagedFiles() ?? []).map(f => f.path);
    if (paths.length === 0) return;
    const api = (window as any).promptops;
    await api.gitStage(this.cwd, paths);
    this.git.refresh(this.cwd);
  }

  async unstageAll(): Promise<void> {
    if (!this.cwd) return;
    const paths = withRenameSources(this.git.stagedFiles() ?? []);
    if (paths.length === 0) return;
    const api = (window as any).promptops;
    await api.gitUnstage(this.cwd, paths);
    this.git.refresh(this.cwd);
  }

  async stageFile(e: Event, path: string): Promise<void> {
    e.stopPropagation();
    if (!this.cwd) return;
    const api = (window as any).promptops;
    await api.gitStage(this.cwd, [path]);
    this.git.refresh(this.cwd);
  }

  async unstageFile(e: Event, path: string): Promise<void> {
    e.stopPropagation();
    if (!this.cwd) return;
    const api = (window as any).promptops;
    await api.gitUnstage(this.cwd, withRenameSources((this.git.stagedFiles() ?? []).filter(f => f.path === path), path));
    this.git.refresh(this.cwd);
  }

  async doCommit(): Promise<void> {
    if (!this.cwd) return;
    const result = await this.git.commit(this.cwd);
    if (result.ok) {
      this.loadHistory(); // refresh history
    }
  }

  generateMessage(): void {
    if (this.cwd && this.provider) {
      this.git.generateCommitMessage(this.cwd, this.provider as any);
    }
  }

  async doPull(): Promise<void> {
    if (!this.cwd) return;
    await this.git.pull(this.cwd);
    void this.refreshSyncCounters();
    await this.loadHistory(); // realign graph: local tip and merged upstream commits
  }

  async doPush(): Promise<void> {
    if (!this.cwd) return;
    await this.git.push(this.cwd);
    void this.refreshSyncCounters();
    if (!this.git.syncError()) await this.loadHistory(); // realign graph: origin/* tips follow the push
    const err = this.git.syncError();
    if (err && this.isSetupError(err)) {
      this.setup.open(this.cwd, err, this.provider as any);
    }
  }

  openGitSetup(): void {
    if (this.cwd) this.setup.open(this.cwd, this.git.syncError() || undefined, this.provider as any);
  }

  aiResolveSync(): void {
    if (!this.cwd) return;
    const op: 'pull' | 'push' | 'auto' =
      this.git.pulling() ? 'pull'
      : this.git.pushing() ? 'push'
      : 'auto';
    this.git.aiResolveSync(this.cwd, op, this.provider as any, this.git.syncError() || undefined);
  }

  isSetupError(msg: string | null): boolean {
    if (!msg) return false;
    const m = msg.toLowerCase();
    return (
      m.includes('permission denied') ||
      m.includes('publickey') ||
      m.includes('authentication failed') ||
      m.includes('could not read username') ||
      m.includes('host key verification') ||
      m.includes('please tell me who you are') ||
      m.includes('no configured push destination') ||
      m.includes('no such remote')
    );
  }

  async loadRemoteInfo(): Promise<void> {
    if (!this.cwd) { this.originRemote.set(null); return; }
    try {
      const api = (window as any).promptops;
      if (!api?.gitSetupDiagnose) return;
      const d = await api.gitSetupDiagnose(this.cwd);
      if (d?.remote) {
        this.originRemote.set({ url: d.remote.url, type: d.remote.type, host: d.remote.host });
      } else {
        this.originRemote.set(null);
      }
    } catch { this.originRemote.set(null); }
  }

  execMiniTerminal(): void {
    const cmd = this.miniTerminalCmd.trim();
    if (!cmd || !this.cwd) return;
    this.miniTerminalCmd = '';
    this.git.exec(this.cwd, cmd).then(() => this.loadHistory());
  }

  async doStash(): Promise<void> {
    if (!this.cwd) return;
    this.stashing.set(true);
    this.git.syncError.set(null);
    this.git.syncSuccess.set(null);
    try {
      const api = (window as any).promptops;
      const result = await api.gitStash(this.cwd);
      if (result.ok) {
        this.git.syncSuccess.set(result.output || 'Stash created');
        this.git.refresh(this.cwd);
        void this.loadHistory();
      } else {
        this.git.syncError.set(result.error || 'Stash failed');
      }
    } catch (err: any) {
      this.git.syncError.set(err.message || 'Stash failed');
    } finally {
      this.stashing.set(false);
      setTimeout(() => this.git.syncSuccess.set(null), 3000);
    }
  }

  async doStashPop(): Promise<void> {
    if (!this.cwd) return;
    this.stashPopping.set(true);
    this.git.syncError.set(null);
    this.git.syncSuccess.set(null);
    try {
      const api = (window as any).promptops;
      const result = await api.gitStashPop(this.cwd);
      if (result.ok) {
        this.git.syncSuccess.set(result.output || 'Stash applied');
        this.git.refresh(this.cwd);
        void this.loadHistory();
      } else {
        this.git.syncError.set(result.error || 'Stash pop failed');
      }
    } catch (err: any) {
      this.git.syncError.set(err.message || 'Stash pop failed');
    } finally {
      this.stashPopping.set(false);
      setTimeout(() => this.git.syncSuccess.set(null), 3000);
    }
  }

  // ── Clone ──

  getCloneFullPath(): string {
    const parent = this.cloneParentDir();
    const name = this.cloneDirName.trim();
    if (!parent || !name) return '';
    return parent.endsWith('/') ? parent + name : parent + '/' + name;
  }

  onCloneUrlChange(): void {
    const url = this.cloneUrl.trim();
    if (!url) { this.cloneDirName = ''; return; }
    // Extract repo name from URL (handles both HTTPS and SSH)
    const match = url.match(/[/:]([^/]+?)(?:\.git)?$/);
    if (match) this.cloneDirName = match[1];
  }

  async pickCloneDestination(): Promise<void> {
    try {
      const api = (window as any).promptops;
      const result = await api.selectWorkspace();
      if (result?.path) {
        this.cloneParentDir.set(result.path);
      }
    } catch { /* canceled */ }
  }

  async doClone(): Promise<void> {
    const fullPath = this.getCloneFullPath();
    if (!fullPath || !this.cloneUrl.trim()) return;

    this.cloneSuccess.set(null);
    const result = await this.git.clone(this.cloneUrl.trim(), fullPath, this.cloneBranch.trim() || undefined);
    if (result.ok) {
      this.cloneSuccess.set(this.tr('Cloned to', { path: fullPath }));
      // Switch to cloned repo and close clone panel
      setTimeout(() => {
        this.showClonePanel.set(false);
        this.cloneSuccess.set(null);
        // Close modal with the new path so session-view can update workspace
        this.modal.close({ action: 'clone', path: fullPath, name: this.cloneDirName });
      }, 1500);
    }
  }

  // ── File diff overlay ──

  async viewFileDiff(filePath: string): Promise<void> {
    this.diffOverlayFile.set(filePath);
    this.diffOverlayContent.set('');
    this.diffOverlayImage.set(null);
    this.diffOverlayLoading.set(true);

    if (isRasterImagePath(filePath)) {
      try {
        await this.loadImageDiffOverlay(filePath);
      } catch { /* ignore */ }
      this.diffOverlayLoading.set(false);
      return;
    }

    try {
      const api = (window as any).promptops;
      const result = await api.gitFileDiff(this.cwd, filePath);
      if (result.ok) this.diffOverlayContent.set(result.diff);
    } catch { /* ignore */ }
    this.diffOverlayLoading.set(false);
  }

  /** Image preview for a working-dir file: HEAD version vs worktree version. */
  private async loadImageDiffOverlay(filePath: string): Promise<void> {
    const entry = [...(this.git.stagedFiles() ?? []), ...(this.git.unstagedFiles() ?? [])]
      .find(f => f.path === filePath);
    const code = entry?.statusCode ?? '';

    // Renames: `path` is the new name, `origPath` the one at HEAD.
    const worktreePath = filePath;
    const headPath: string = (entry as { origPath?: string } | undefined)?.origPath || filePath;

    const isDeleted = code.includes('D');
    const isNew = code.includes('?') || code.includes('A');

    let newUrl: string | null = null;
    if (!isDeleted) {
      const res = await this.git.readFileBase64(this.cwd, worktreePath);
      if (res.ok && res.data && res.mimeType) newUrl = toDataUrl(res.mimeType, res.data);
    }
    let oldUrl: string | null = null;
    if (!isNew) {
      const res = await this.git.showFileBase64(this.cwd, 'HEAD', headPath);
      if (res.ok && res.exists && res.data && res.mimeType) oldUrl = toDataUrl(res.mimeType, res.data);
    }
    this.diffOverlayImage.set({ status: code, oldUrl, newUrl });
  }

  diffOverlayLines(): string[] {
    return this.diffOverlayContent().split('\n');
  }

  /** Structured lines for the working-file overlay, so its rows are annotatable too. */
  overlayDiffLines = computed<DiffLine[]>(() => {
    const raw = this.diffOverlayContent();
    if (!raw.trim()) return [];
    try {
      return this.parseDiff(raw)[0]?.lines ?? [];
    } catch {
      return [];
    }
  });

  // ── Review notes ──────────────────────────────────────────────────────────
  // Pin a comment to a diff line, then ship every comment back to the agent as
  // one prompt — the file/line context is already on screen, no need to retype it.

  notes = signal<DiffNote[]>([]);
  editingKey = signal<string | null>(null);
  noteDraft = '';
  private noteLineCtx: { file: string; line: number | null; code: string; scope: string | null } | null = null;

  private notesIndex = computed(() => {
    const map = new Map<string, DiffNote>();
    for (const n of this.notes()) map.set(n.key, n);
    return map;
  });

  notedFilesCount = computed(() => new Set(this.notes().map(n => n.file)).size);

  /**
   * Notes are keyed by scope so a commit diff and the working-tree overlay can
   * both be annotated without their line indexes colliding.
   * Scope is the commit hash, or 'wt' for uncommitted changes.
   */
  noteKey(file: string, idx: number, scope?: string): string {
    return `${scope ?? this.selectedCommit()?.hash ?? 'head'}|${file}#${idx}`;
  }

  wtNoteKey(file: string, idx: number): string {
    return this.noteKey(file, idx, 'wt');
  }

  noteAt(file: string, idx: number, scope?: string): DiffNote | undefined {
    return this.notesIndex().get(this.noteKey(file, idx, scope));
  }

  wtNoteAt(file: string, idx: number): DiffNote | undefined {
    return this.noteAt(file, idx, 'wt');
  }

  noteByKey(key: string): DiffNote | undefined {
    return this.notesIndex().get(key);
  }

  toggleNote(file: string, idx: number, line: DiffLine, scope?: string): void {
    const key = this.noteKey(file, idx, scope);
    if (this.editingKey() === key) { this.cancelNote(); return; }
    this.noteLineCtx = {
      file,
      line: line.newNum ?? line.oldNum,
      code: `${line.prefix}${line.text}`.trimEnd(),
      scope: scope ?? this.selectedCommit()?.shortHash ?? null,
    };
    this.noteDraft = this.notesIndex().get(key)?.text ?? '';
    this.editingKey.set(key);
    this.focusNoteInput();
  }

  editNote(key: string): void {
    const note = this.notesIndex().get(key);
    if (!note) return;
    this.noteLineCtx = { file: note.file, line: note.line, code: note.code, scope: note.scope };
    this.noteDraft = note.text;
    this.editingKey.set(key);
    this.focusNoteInput();
  }

  private focusNoteInput(): void {
    setTimeout(() => {
      const el = document.querySelector<HTMLTextAreaElement>('.dnote-input');
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  }

  saveNote(): void {
    const key = this.editingKey();
    const text = this.noteDraft.trim();
    if (!key || !this.noteLineCtx || !text) return;
    const ctx = this.noteLineCtx;
    this.notes.update(list => {
      const rest = list.filter(n => n.key !== key);
      return [...rest, { key, file: ctx.file, line: ctx.line, code: ctx.code, text, scope: ctx.scope }];
    });
    this.cancelNote();
  }

  cancelNote(): void {
    this.editingKey.set(null);
    this.noteDraft = '';
    this.noteLineCtx = null;
  }

  deleteNote(key: string): void {
    this.notes.update(list => list.filter(n => n.key !== key));
    if (this.editingKey() === key) this.cancelNote();
  }

  clearNotes(): void {
    this.notes.set([]);
    this.cancelNote();
  }

  onNoteKeydown(evt: KeyboardEvent): void {
    if (evt.key === 'Enter' && !evt.shiftKey) {
      evt.preventDefault();
      evt.stopPropagation();
      this.saveNote();
      return;
    }
    if (evt.key === 'Escape') {
      evt.preventDefault();
      evt.stopPropagation();
      this.cancelNote();
    }
  }

  /** Group the notes per file and hand the modal owner a ready-to-send prompt. */
  buildNotesPrompt(): string {
    // Same path reviewed in two scopes stays two blocks — the agent needs to know which.
    const groups: { file: string; scope: string | null; notes: DiffNote[] }[] = [];
    for (const n of this.notes()) {
      const group = groups.find(g => g.file === n.file && g.scope === n.scope);
      if (group) group.notes.push(n);
      else groups.push({ file: n.file, scope: n.scope, notes: [n] });
    }

    const blocks: string[] = [];
    for (const { file, scope, notes: list } of groups) {
      const where = !scope || scope === 'wt' ? '' : ` (in commit ${scope})`;
      const sorted = [...list].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
      const body = sorted
        .map(n => `  L${n.line ?? '?'}: ${n.code}\n  → ${n.text}`)
        .join('\n');
      blocks.push(`${file}${where}\n${body}`);
    }

    const total = this.notes().length;
    return [
      `Code review — ${total} comment${total === 1 ? '' : 's'} on the current diff:`,
      '',
      blocks.join('\n\n'),
      '',
      'Apply the requested changes. Ask before doing anything a comment does not cover.',
    ].join('\n');
  }

  sendNotesToAgent(): void {
    if (this.notes().length === 0) return;
    const prompt = this.buildNotesPrompt();
    const count = this.notes().length;
    this.clearNotes();
    this.modal.close({ action: 'annotate', prompt, count });
  }

  closeDiffOverlay(): void {
    this.diffOverlayFile.set(null);
    this.diffOverlayContent.set('');
    this.diffOverlayImage.set(null);
  }

  diffLineClass(line: string): string {
    if (line.startsWith('+++') || line.startsWith('---')) return 'diff-line-meta';
    if (line.startsWith('@@')) return 'diff-line-hunk';
    if (line.startsWith('+')) return 'diff-line-add';
    if (line.startsWith('-')) return 'diff-line-del';
    return 'diff-line-ctx';
  }

  // ── Graph logic ──

  // First-parent chains used for graph readability: the checked-out branch line
  // is highlighted, main/master keeps a fixed reserved color.
  private currentChain = new Set<string>();
  private mainChain = new Set<string>();
  hasCurrentChain = signal(false);

  /** Walk parents[0] from a tip hash (bounded by the loaded commits). */
  private firstParentChain(byHash: Map<string, GitCommit>, tip?: string): Set<string> {
    const chain = new Set<string>();
    let h = tip;
    while (h && byHash.has(h) && !chain.has(h)) {
      chain.add(h);
      h = byHash.get(h)!.parents?.[0];
    }
    return chain;
  }

  private assignGraphColumns(commits: GitCommit[]): GitCommit[] {
    this.columnMap.clear();
    const byHash = new Map(commits.map(c => [c.hash, c]));
    // Current branch tip = the commit HEAD points at (git log marks it "HEAD -> …").
    const headTip = commits.find(c => c.refs.some(r => r === 'HEAD' || r.startsWith('HEAD ->')));
    this.currentChain = this.firstParentChain(byHash, headTip?.hash);
    this.hasCurrentChain.set(this.currentChain.size > 0);
    // Main/master tip — prefer the local head, fall back to the remote one.
    const isMain = (n: string) => n === 'main' || n === 'master';
    const mainTip =
      commits.find(c => c.refs.some(r => isMain(r) || isMain(r.replace(/^HEAD -> /, '')))) ||
      commits.find(c => c.refs.some(r => r.endsWith('/main') || r.endsWith('/master')));
    this.mainChain = this.firstParentChain(byHash, mainTip?.hash);

    const activeCols: (string | null)[] = [];
    let maxC = 0;
    for (const commit of commits) {
      let col = activeCols.indexOf(commit.hash);
      if (col === -1) {
        col = activeCols.indexOf(null);
        if (col === -1) { col = activeCols.length; activeCols.push(commit.hash); }
        else { activeCols[col] = commit.hash; }
      }
      commit.col = col;
      // GRAPH_COLORS[0] is reserved for the main/master line so it looks the same
      // in every state; all other lanes cycle the rest of the palette.
      commit.color = this.mainChain.has(commit.hash)
        ? GRAPH_COLORS[0]
        : GRAPH_COLORS[1 + (col % (GRAPH_COLORS.length - 1))];
      this.columnMap.set(commit.hash, col);
      if (col > maxC) maxC = col;
      activeCols[col] = null;
      for (let i = 0; i < (commit.parents?.length || 0); i++) {
        const parent = commit.parents[i];
        if (activeCols.indexOf(parent) !== -1) continue;
        if (i === 0) { activeCols[col] = parent; }
        else {
          const e = activeCols.indexOf(null);
          if (e !== -1) activeCols[e] = parent;
          else activeCols.push(parent);
        }
      }
      const used = activeCols.filter(c => c !== null).length;
      if (used > maxC) maxC = used;
    }
    this.maxCol.set(maxC);
    this.buildGraphLines(commits);
    return commits;
  }

  getCommitX(commit: GitCommit): number {
    return (commit.col ?? 0) * 24 + 16;
  }

  // Pre-computed graph lines for all rows (built once after assignGraphColumns)
  private allGraphLines: { x1: number; y1: number; x2: number; y2: number; color: string; current?: boolean }[][] = [];

  getCommitLines(rowIdx: number): { x1: number; y1: number; x2: number; y2: number; color: string; current?: boolean }[] {
    return this.allGraphLines[rowIdx] || [];
  }

  /**
   * Build all graph lines for every row at once.
   * Tracks "active rails" — columns occupied by in-progress edges.
   * Each rail is { col, color, targetHash }.
   */
  private buildGraphLines(commits: GitCommit[]): void {
    const COL_W = 24;
    const OFF = 16;
    const ROW_H = 38;
    const MID = 19;
    const xOf = (col: number) => col * COL_W + OFF;

    // hashIndex: quick lookup hash → row index
    const hashIndex = new Map<string, number>();
    for (let i = 0; i < commits.length; i++) hashIndex.set(commits[i].hash, i);

    // Active rails: each rail tracks a "pipe" going from some commit above
    // down to a parent commit below. { col, color, targetHash, current }
    type Rail = { col: number; color: string; targetHash: string; current?: boolean };
    let rails: Rail[] = [];

    this.allGraphLines = new Array(commits.length);

    for (let row = 0; row < commits.length; row++) {
      const commit = commits[row];
      const lines: { x1: number; y1: number; x2: number; y2: number; color: string; current?: boolean }[] = [];

      // ── Step 1: Which rails terminate at this commit? ──
      const arrivingRails: Rail[] = [];
      const passingRails: Rail[] = [];
      for (const rail of rails) {
        if (rail.targetHash === commit.hash) {
          arrivingRails.push(rail);
        } else {
          passingRails.push(rail);
        }
      }

      // ── Step 2: Draw arriving rails (line from top → commit dot) ──
      const commitX = xOf(commit.col ?? 0);
      for (const rail of arrivingRails) {
        const railX = xOf(rail.col);
        lines.push({ x1: railX, y1: 0, x2: commitX, y2: MID, color: rail.color, current: rail.current });
      }

      // ── Step 3: Draw pass-through rails (vertical top → bottom) ──
      for (const rail of passingRails) {
        const railX = xOf(rail.col);
        lines.push({ x1: railX, y1: 0, x2: railX, y2: ROW_H, color: rail.color, current: rail.current });
      }

      // ── Step 4: Start new rails for this commit's parents ──
      // Remove arrived rails, keep passing rails
      rails = [...passingRails];
      const usedCols = new Set(rails.map(r => r.col));

      const parents = commit.parents || [];
      for (let pi = 0; pi < parents.length; pi++) {
        const parentHash = parents[pi];
        const parentRow = hashIndex.get(parentHash);
        if (parentRow === undefined) continue; // parent not in visible commits
        if (parentRow <= row) continue; // parent already shown (shouldn't happen)

        // First-parent edge between two current-chain commits = the active branch line.
        const isCurrent = pi === 0 && this.currentChain.has(commit.hash) && this.currentChain.has(parentHash);

        // Already have a rail for this parent? Skip duplicate
        if (rails.some(r => r.targetHash === parentHash)) {
          // Still draw the line from commit to that rail's column
          const existing = rails.find(r => r.targetHash === parentHash)!;
          lines.push({ x1: commitX, y1: MID, x2: xOf(existing.col), y2: ROW_H, color: existing.color, current: isCurrent });
          continue;
        }

        // Pick column: first parent reuses commit's column, others get a free column
        let col: number;
        if (pi === 0 && !usedCols.has(commit.col ?? 0)) {
          col = commit.col ?? 0;
        } else {
          col = 0;
          while (usedCols.has(col)) col++;
        }
        usedCols.add(col);

        // First-parent edges continue the commit's own line; merge edges take the
        // color of the branch line they come from (the parent's), so a merge reads
        // as "that colored line flowing in" instead of a random palette pick.
        const parentColor = commits[parentRow]?.color;
        const color = pi === 0
          ? (commit.color || GRAPH_COLORS[1 + ((commit.col ?? 0) % (GRAPH_COLORS.length - 1))])
          : (parentColor || GRAPH_COLORS[1 + (col % (GRAPH_COLORS.length - 1))]);

        rails.push({ col, color, targetHash: parentHash, current: isCurrent });

        // Draw line from commit dot down to this rail's column
        lines.push({ x1: commitX, y1: MID, x2: xOf(col), y2: ROW_H, color, current: isCurrent });
      }

      this.allGraphLines[row] = lines;
    }
  }

  // ── Stat parsing ──

  private parseStat(raw: string): CommitStats {
    const lines = raw.split('\n').filter(l => l.trim());
    const files: { path: string; changes: string }[] = [];
    let summary = '';
    let filesChanged = 0, insertions = 0, deletions = 0;
    for (const line of lines) {
      const summaryMatch = line.match(/(\d+) files? changed/);
      if (summaryMatch) {
        summary = line.trim();
        filesChanged = parseInt(summaryMatch[1], 10);
        const insMatch = line.match(/(\d+) insertions?\(\+\)/);
        const delMatch = line.match(/(\d+) deletions?\(-\)/);
        if (insMatch) insertions = parseInt(insMatch[1], 10);
        if (delMatch) deletions = parseInt(delMatch[1], 10);
      } else {
        const fileMatch = line.match(/^\s*(.+?)\s+\|\s+(.+)$/);
        if (fileMatch) {
          files.push({ path: fileMatch[1].trim(), changes: fileMatch[2].trim() });
        }
      }
    }
    return { files, summary, filesChanged, insertions, deletions };
  }

  copySha(hash: string): void {
    navigator.clipboard.writeText(hash);
    this.copiedSha.set(true);
    setTimeout(() => this.copiedSha.set(false), 2000);
  }

  getBarWidth(count: number, file: DiffFile): number {
    const total = file.additions + file.deletions;
    if (total === 0) return 0;
    return Math.max(2, Math.round((count / total) * 50));
  }

  // ── Diff parsing ──

  private parseDiff(raw: string): DiffFile[] {
    const files: DiffFile[] = [];
    const parts = raw.split(/^diff --git /m);
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const lines = part.split('\n');
      const hm = lines[0].match(/a\/(.+?) b\/(.+)/);
      const path = hm ? hm[2] : lines[0];
      let status = 'modified';
      if (part.includes('new file mode')) status = 'added';
      else if (part.includes('deleted file mode')) status = 'deleted';
      const diffLines: DiffLine[] = [];
      let oN = 0, nN = 0, add = 0, del = 0;
      for (const line of lines) {
        if (line.startsWith('@@')) {
          const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
          if (m) { oN = parseInt(m[1], 10); nN = parseInt(m[2], 10); }
          diffLines.push({ type: 'hunk', prefix: '', text: line, oldNum: null, newNum: null });
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          add++; diffLines.push({ type: 'add', prefix: '+', text: line.substring(1), oldNum: null, newNum: nN++ });
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          del++; diffLines.push({ type: 'del', prefix: '-', text: line.substring(1), oldNum: oN++, newNum: null });
        } else if (line.startsWith(' ')) {
          diffLines.push({ type: 'context', prefix: ' ', text: line.substring(1), oldNum: oN++, newNum: nN++ });
        }
      }
      const isBinary = lines.some(l => l.startsWith('Binary files ') && l.trimEnd().endsWith(' differ'));
      files.push({
        path, status, lines: diffLines, additions: add, deletions: del, expanded: files.length < 5,
        isBinary,
        // Raster file with no text hunks (git emits the binary marker, or nothing) → render as preview
        isImage: isRasterImagePath(path) && diffLines.length === 0,
      });
    }
    return files;
  }

  // ── Ref badges (timeline) ──

  private static MAX_BADGES = 3;
  private badgeCache = new Map<string, RefBadge[]>();

  /** Parse, dedupe and order the refs of a commit into display badges.
   *  A local branch that also exists on origin collapses into a single badge marked as synced. */
  private parseRefBadges(commit: GitCommit): RefBadge[] {
    const locals = new Map<string, boolean>(); // name → isHead
    const remotes: string[] = [];
    const tags: string[] = [];
    for (const raw of commit.refs || []) {
      const ref = raw.trim();
      if (!ref || ref === 'HEAD') continue;
      if (ref.startsWith('tag:')) {
        tags.push(ref.replace(/^tag:\s*/, ''));
      } else if (ref.startsWith('HEAD -> ')) {
        locals.set(ref.replace(/^HEAD -> /, ''), true);
      } else if (ref.startsWith('origin/')) {
        remotes.push(ref);
      } else if (!locals.has(ref)) {
        locals.set(ref, false);
      }
    }

    const badges: RefBadge[] = [];
    const syncedRemotes = new Set<string>();
    for (const r of remotes) {
      if (locals.has(this.stripRemote(r))) syncedRemotes.add(r);
    }
    const sortedLocals = Array.from(locals.entries()).sort((a, b) => Number(b[1]) - Number(a[1]));
    for (const [name, isHead] of sortedLocals) {
      const synced = remotes.some(r => this.stripRemote(r) === name);
      badges.push({
        label: name,
        full: (isHead ? 'HEAD -> ' : '') + name,
        type: isHead ? 'head' : 'local',
        icon: isHead ? 'mdi:source-branch-check' : 'mdi:laptop',
        synced,
        tooltip: this.tr(isHead ? 'Tip current' : 'Tip local', { name }) + (synced ? this.tr('Tip synced', { name }) : this.tr('Tip not origin')),
        ctxBranch: name,
      });
    }
    for (const r of remotes) {
      if (syncedRemotes.has(r)) continue;
      badges.push({
        label: this.stripRemote(r),
        full: r,
        type: 'remote',
        icon: 'mdi:cloud-outline',
        synced: false,
        tooltip: r,
        ctxBranch: r,
      });
    }
    for (const t of tags) {
      badges.push({
        label: t,
        full: `tag: ${t}`,
        type: 'tag',
        icon: 'mdi:tag',
        synced: false,
        tooltip: `tag: ${t}`,
        ctxBranch: '',
      });
    }
    return badges;
  }

  private allBadges(commit: GitCommit): RefBadge[] {
    let badges = this.badgeCache.get(commit.hash);
    if (!badges) {
      badges = this.parseRefBadges(commit);
      this.badgeCache.set(commit.hash, badges);
    }
    return badges;
  }

  // Branch names live on the graph tip badges; the commit row only shows tags.
  commitBadges(commit: GitCommit): RefBadge[] {
    return this.allBadges(commit).filter(b => b.type === 'tag').slice(0, SessionGitExplorerComponent.MAX_BADGES);
  }

  hiddenBadges(commit: GitCommit): RefBadge[] {
    return this.allBadges(commit).filter(b => b.type === 'tag').slice(SessionGitExplorerComponent.MAX_BADGES);
  }

  hiddenBadgesTooltip(commit: GitCommit): string {
    return this.hiddenBadges(commit).map(b => b.full).join('\n');
  }

  // ── Branch-tip info (drives dot decorations + dot interactions) ──

  graphLegendText =
    'Branch badges mark where each branch is: green = HEAD (you are here) · dashed indigo = local only (not pushed) · solid + cloud = in sync with origin · dashed gray = remote only · click a badge: filter · double-click: checkout · right-click: actions';

  private static readonly TIP_NONE: TipInfo = { isTip: false, kind: 'none', branches: [], synced: false, label: '', icon: '', tooltip: '' };
  private tipCache = new Map<string, TipInfo>();

  tipInfo(commit: GitCommit): TipInfo {
    let info = this.tipCache.get(commit.hash);
    if (!info) {
      info = this.computeTipInfo(commit);
      this.tipCache.set(commit.hash, info);
    }
    return info;
  }

  private computeTipInfo(commit: GitCommit): TipInfo {
    // Tags never make a tip; origin/HEAD is a pointer artifact, not a branch.
    const badges = this.allBadges(commit).filter(
      b => b.type !== 'tag' && !(b.type === 'remote' && b.label === 'HEAD'),
    );
    if (badges.length === 0) return SessionGitExplorerComponent.TIP_NONE;
    const isHead = badges.some(b => b.type === 'head');
    const hasLocal = badges.some(b => b.type === 'head' || b.type === 'local');
    const synced = badges.some(b => b.type !== 'remote' && b.synced);
    const kind: TipInfo['kind'] = isHead ? 'head' : synced ? 'synced' : hasLocal ? 'local' : 'remote';
    const names = badges.map(b => (b.type === 'remote' ? b.full : b.label)).join(' · ');
    const desc =
      kind === 'head' ? this.tr('Tip desc head')
      : kind === 'synced' ? this.tr('Tip desc synced')
      : kind === 'local' ? this.tr('Tip desc local')
      : this.tr('Tip desc remote');
    return {
      isTip: true,
      kind,
      branches: badges.map(b => b.ctxBranch),
      synced,
      label: badges[0].label,
      icon: kind === 'head' ? 'mdi:source-branch-check' : kind === 'remote' ? 'mdi:cloud-outline' : 'mdi:laptop',
      tooltip: `${names} — ${desc}\n${this.tr('Tip hint')}`,
    };
  }

  /** Click on a graph tip badge: filter the timeline on the primary branch (same semantics as the old row badges). */
  onTipBadgeClick(evt: MouseEvent, commit: GitCommit): void {
    evt.stopPropagation();
    const tip = this.tipInfo(commit);
    if (tip.branches.length > 0) this.selectBranch(tip.branches[0]);
  }

  /** Click on a branch badge filters the timeline from that branch; tags are inert. */
  onBadgeClick(evt: Event, badge: RefBadge): void {
    evt.stopPropagation();
    if (badge.type === 'tag') return;
    this.selectBranch(badge.ctxBranch);
  }

  onBadgeContextMenu(evt: MouseEvent, badge: RefBadge, commit?: GitCommit): void {
    if (badge.type === 'tag') return;
    this.onBranchContextMenu(evt, badge.ctxBranch, commit);
  }

  // ── Helpers ──

  statusIcon(status: string): string {
    switch (status) {
      case 'modified': return 'M';
      case 'added': return 'A';
      case 'deleted': return 'D';
      case 'renamed': return 'R';
      case 'untracked': return 'U';
      case 'conflict': return 'C';
      default: return '?';
    }
  }

  fileName(path: string): string {
    const idx = path.lastIndexOf('/');
    return idx >= 0 ? path.substring(idx + 1) : path;
  }

  // ── File tree helpers ──

  isNodeExpanded(section: string, fullPath: string): boolean {
    const expanded = section === 'staged' ? this.expandedStagedFolders() : this.expandedUnstagedFolders();
    return expanded.has(fullPath);
  }

  toggleExpandNode(section: string, fullPath: string): void {
    const sig = section === 'staged' ? this.expandedStagedFolders : this.expandedUnstagedFolders;
    sig.update(s => {
      const next = new Set(s);
      next.has(fullPath) ? next.delete(fullPath) : next.add(fullPath);
      return next;
    });
  }

  async stageTreeNode(e: Event, node: FileTreeNode): Promise<void> {
    e.stopPropagation();
    if (!this.cwd) return;
    const paths = (this.git.unstagedFiles() ?? []).filter(f => f.path.startsWith(node.fullPath + '/')).map(f => f.path);
    if (paths.length === 0) return;
    const api = (window as any).promptops;
    await api.gitStage(this.cwd, paths);
    this.git.refresh(this.cwd);
  }

  async unstageTreeNode(e: Event, node: FileTreeNode): Promise<void> {
    e.stopPropagation();
    if (!this.cwd) return;
    const paths = withRenameSources((this.git.stagedFiles() ?? []).filter(f => f.path.startsWith(node.fullPath + '/')));
    if (paths.length === 0) return;
    const api = (window as any).promptops;
    await api.gitUnstage(this.cwd, paths);
    this.git.refresh(this.cwd);
  }

  getInitials(name: string): string {
    return name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  }

  private static PROVIDER_MAP: Record<string, { icon: string; color: string }> = {
    'claude-code-cli': { icon: 'simple-icons:anthropic', color: '#d4a27f' },
    'codex':           { icon: 'simple-icons:openai',    color: '#74aa9c' },
    'gemini-cli':      { icon: 'simple-icons:google',    color: '#8ab4f8' },
    'antigravity':     { icon: 'simple-icons:google',    color: '#06b6d4' },
    'copilot':         { icon: 'simple-icons:github',    color: '#8b949e' },
    'cursor':          { icon: 'simple-icons:cursor',    color: '#00bfff' },
    'generic-shell':   { icon: 'mdi:terminal',           color: '#8b949e' },
  };
  private static DEFAULT_PROVIDER = { icon: 'mdi:terminal', color: '#8b949e' };

  get providerIcon(): string {
    return (SessionGitExplorerComponent.PROVIDER_MAP[this.provider] ?? SessionGitExplorerComponent.DEFAULT_PROVIDER).icon;
  }

  get providerColor(): string {
    return (SessionGitExplorerComponent.PROVIDER_MAP[this.provider] ?? SessionGitExplorerComponent.DEFAULT_PROVIDER).color;
  }

  getAvatarColor(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return GRAPH_COLORS[Math.abs(hash) % GRAPH_COLORS.length];
  }

  formatDate(iso: string): string {
    try {
      return formatUiDate(iso, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch { return iso; }
  }

  // ── Context menu ──

  /** Clamp popup coords inside the viewport using an estimated size (pre-render). */
  private clampToViewport(x: number, y: number, estW: number, estH: number): { x: number; y: number } {
    return {
      x: Math.max(8, Math.min(x, window.innerWidth - estW - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - estH - 8)),
    };
  }

  /** After render, measure the real popup and re-clamp if it still overflows. */
  private reclampAfterRender(selector: string, apply: (x: number, y: number) => void): void {
    setTimeout(() => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      let x = r.left, y = r.top, moved = false;
      if (r.right > window.innerWidth - 8) { x = Math.max(8, window.innerWidth - r.width - 8); moved = true; }
      if (r.bottom > window.innerHeight - 8) { y = Math.max(8, window.innerHeight - r.height - 8); moved = true; }
      if (moved) apply(x, y);
    });
  }

  onFileContext(e: MouseEvent, file: { path: string; status: string; staged: boolean }): void {
    e.preventDefault();
    e.stopPropagation();
    this.ctxMenuFile.set(file);
    const pos = this.clampToViewport(e.clientX, e.clientY, 200, 150);
    this.ctxMenuX.set(pos.x);
    this.ctxMenuY.set(pos.y);
    this.ctxMenuVisible.set(true);
    this.reclampAfterRender('.git-ctx-menu.file-ctx', (x, y) => { this.ctxMenuX.set(x); this.ctxMenuY.set(y); });
    // Close on next click anywhere
    this.ctxCloseListener = () => this.closeCtxMenu();
    setTimeout(() => document.addEventListener('click', this.ctxCloseListener!, { once: true }));
  }

  closeCtxMenu(): void {
    this.ctxMenuVisible.set(false);
    this.ctxMenuFile.set(null);
    if (this.ctxCloseListener) {
      document.removeEventListener('click', this.ctxCloseListener);
      this.ctxCloseListener = null;
    }
  }

  async ctxDeleteFile(): Promise<void> {
    const file = this.ctxMenuFile();
    if (!file || !this.cwd) return;
    this.closeCtxMenu();
    try {
      const api = (window as any).promptops;
      await api.fsDelete(this.cwd, file.path);
      this.git.refresh(this.cwd);
    } catch { /* ignore */ }
  }

  ctxDiscardChanges(): void {
    const file = this.ctxMenuFile();
    const x = this.ctxMenuX();
    const y = this.ctxMenuY();
    this.closeCtxMenu();
    if (!file) return;
    this.openDiscardConfirm(x, y, file);
  }

  // ── Discard changes (with confirm) ──

  discardCtx = signal<{ x: number; y: number; file: { path: string; status: string } | null } | null>(null);
  discardBusy = signal(false);
  private discardKeyListener: ((e: KeyboardEvent) => void) | null = null;

  askDiscard(e: MouseEvent, file: { path: string; status: string } | null): void {
    e.stopPropagation();
    e.preventDefault();
    this.openDiscardConfirm(e.clientX, e.clientY, file);
  }

  private openDiscardConfirm(x: number, y: number, file: { path: string; status: string } | null): void {
    const pos = this.clampToViewport(x, y, 280, 160);
    this.discardCtx.set({ x: pos.x, y: pos.y, file });
    this.reclampAfterRender('.git-ctx-menu.discard-confirm', (nx, ny) => {
      const cur = this.discardCtx();
      if (cur) this.discardCtx.set({ ...cur, x: nx, y: ny });
    });
    this.removeDiscardKeyListener();
    this.discardKeyListener = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); this.doDiscard(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.closeDiscardConfirm(); }
    };
    document.addEventListener('keydown', this.discardKeyListener);
  }

  private removeDiscardKeyListener(): void {
    if (this.discardKeyListener) {
      document.removeEventListener('keydown', this.discardKeyListener);
      this.discardKeyListener = null;
    }
  }

  closeDiscardConfirm(): void {
    this.discardCtx.set(null);
    this.removeDiscardKeyListener();
  }

  async doDiscard(): Promise<void> {
    const ctx = this.discardCtx();
    if (!ctx || !this.cwd || this.discardBusy()) return;
    this.discardBusy.set(true);
    try {
      const api = (window as any).promptops;
      const files = ctx.file ? [ctx.file] : (this.git.unstagedFiles() ?? []);
      const tracked = files.filter(f => f.status !== 'untracked').map(f => f.path);
      const untracked = files.filter(f => f.status === 'untracked').map(f => f.path);
      if (tracked.length > 0) {
        // Single-quoted words: the mini-terminal splits them without a shell, so a
        // name like `$(cmd).txt` stays a file name. (The old line lacked the
        // leading "git" — refused by the backend, so Discard did nothing.)
        await this.git.exec(this.cwd, `git checkout -- ${tracked.map(quoteArg).join(' ')}`);
      }
      for (const p of untracked) {
        try { await api.fsDelete(this.cwd, p); } catch { /* ignore */ }
      }
      this.git.refresh(this.cwd);
    } catch { /* ignore */ }
    this.discardBusy.set(false);
    this.closeDiscardConfirm();
  }

  close(): void { this.modal.dismiss(); }
}
