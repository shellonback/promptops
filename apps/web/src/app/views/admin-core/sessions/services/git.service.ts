import { Injectable, Injector, inject, signal, computed } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { SwalService } from '@core/services/swal.service';
import { ProviderType } from '../../../../../store/sessions/session.state';

/** Writable-signal-like value tagged with the workspace it belongs to.
 *  GitService is a root singleton shared by every session: without a tag, the
 *  outcome of a pull/push/AI-resolve started in session A (error, step log,
 *  "Resolving…" spinner) showed up verbatim in session B. Reads return the
 *  value only while its workspace is the active one; `set` tags the write with
 *  the op's cwd (defaults to the active workspace for UI-driven writes). */
export interface ScopedSignal<T> {
  (): T;
  set(value: T, cwd?: string | null): void;
  update(fn: (value: T) => T, cwd?: string | null): void;
  /** Value regardless of the active workspace (for the op that owns it). */
  raw(): T;
}

function scopedSignal<T>(active: () => string | null, initial: T): ScopedSignal<T> {
  const inner = signal<{ cwd: string | null; value: T }>({ cwd: null, value: initial });
  const view = computed(() => {
    const s = inner();
    return s.cwd === null || s.cwd === active() ? s.value : initial;
  });
  const fn = (() => view()) as ScopedSignal<T>;
  fn.set = (value, cwd) => inner.set({ cwd: cwd ?? active(), value });
  fn.update = (f, cwd) => inner.update(s => ({ cwd: cwd ?? active(), value: f(s.value) }));
  fn.raw = () => inner().value;
  return fn;
}

export interface GitFile {
  path: string;
  status: string;
  statusCode: string;
  staged: boolean;
}

export interface GitStatusResult {
  ok: boolean;
  files: GitFile[];
  branch?: string;
  diffStat?: string;
  counts?: {
    modified: number;
    added: number;
    deleted: number;
    renamed: number;
    conflict: number;
    total: number;
  };
  error?: string;
}

export interface GitFolder {
  folder: string;
  files: GitFile[];
  allSelected: boolean;
  someSelected: boolean;
}

export interface GitWorktree {
  path: string;
  name: string;
  head: string;
  shortHead: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason?: string | null;
  prunable: boolean;
  /** First entry of `git worktree list`: the repository's own working tree. */
  main: boolean;
  /** The worktree `cwd` belongs to. */
  current: boolean;
  /** Changed files (porcelain status lines); null when unreadable (missing/bare). */
  changes: number | null;
}

export interface DiscoveredRepo {
  name: string;
  path: string;
  branch: string;
}

@Injectable({ providedIn: 'root' })
export class GitService {
  private get api(): any {
    return (window as any).promptops;
  }

  private readonly translate = inject(TranslateService, { optional: true });
  private readonly injector = inject(Injector);

  /** Translated SESSIONS.GIT_PANEL message; the English fallback keeps headless callers readable. */
  private msg(key: string, fallback: string, params?: Record<string, unknown>): string {
    const full = `SESSIONS.GIT_PANEL.${key}`;
    const out = this.translate?.instant(full, params);
    if (typeof out === 'string' && out && out !== full) return out;
    return fallback.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => String(params?.[k] ?? ''));
  }

  /**
   * Asks before a push. window.confirm() returns false at once in the macOS
   * webview (no JS dialog delegate), which made "confirm before push" block
   * every push without a dialog.
   */
  private async confirmPush(): Promise<boolean> {
    const branch = this.branch() || this.msg('Current branch', 'current');
    try {
      const swal = this.injector.get(SwalService);
      const res = await swal.showConfirm(
        this.msg('Confirm push title', 'Push to remote'),
        this.msg('Confirm push', 'Push to remote on branch "{{branch}}"?', { branch }),
      );
      return !!res?.isConfirmed;
    } catch {
      return false;
    }
  }

  get isDesktop(): boolean {
    return !!(window as any).promptops;
  }

  // State
  files = signal<GitFile[]>([]);
  branch = signal('');
  /** Whether the active workspace is a git repo (last definitive status check).
   *  Drives the always-on minimal quick-commit bar: it must stay visible while a
   *  repo is detected — even with zero changes — so Push stays reachable after a
   *  commit, instead of the whole bar vanishing. */
  isRepo = signal(false);
  loading = signal(false);
  selectedPaths = signal<Set<string>>(new Set());
  commitMessage = signal('');
  committing = signal(false);
  commitError = scopedSignal<string | null>(() => this.effectiveCwd(), null);
  generatingMessage = signal(false);
  generateError = scopedSignal<string | null>(() => this.effectiveCwd(), null);
  // ── Git tooling preferences (persisted in localStorage) ──────────────
  /** Commit-message convention used by AI generation.
   *  'conventional' → Conventional Commits (feat:, fix:, docs:, …); 'plain' → free-form. */
  commitConvention = signal<'conventional' | 'plain'>(
    GitService.loadStr('po:git:commitConvention', 'conventional') === 'plain' ? 'plain' : 'conventional'
  );
  /** Language the AI writes the commit message in. 'auto' = match the repo/diff. */
  commitLanguage = signal<'auto' | 'en' | 'it'>(
    (['en', 'it'].includes(GitService.loadStr('po:git:commitLanguage', 'auto'))
      ? GitService.loadStr('po:git:commitLanguage', 'auto')
      : 'auto') as 'auto' | 'en' | 'it'
  );
  /** Free-form extra instructions appended to the AI commit/branch prompt. */
  commitInstructions = signal<string>(GitService.loadStr('po:git:commitInstructions', ''));
  /** Branch naming style for AI branch-name generation.
   *  'gitflow' → feature/ fix/ hotfix/ release/ ; 'simple' → type/short-desc. */
  branchStyle = signal<'gitflow' | 'simple'>(
    GitService.loadStr('po:git:branchStyle', 'simple') === 'gitflow' ? 'gitflow' : 'simple'
  );
  /** Default base branch for new branches (informational / future use). */
  defaultBaseBranch = signal<string>(GitService.loadStr('po:git:defaultBaseBranch', ''));
  /** Ask for confirmation before every push. */
  confirmBeforePush = signal<boolean>(GitService.loadStr('po:git:confirmBeforePush', '') === '1');
  /** Pull from remote before pushing (abort push if it produces conflicts). */
  autoPullBeforePush = signal<boolean>(GitService.loadStr('po:git:autoPullBeforePush', '') === '1');

  private static loadStr(key: string, def: string): string {
    try { return localStorage.getItem(key) ?? def; } catch { return def; }
  }
  private persist(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  }
  pulling = signal(false);
  pushing = signal(false);
  syncError = scopedSignal<string | null>(() => this.effectiveCwd(), null);
  syncSuccess = scopedSignal<string | null>(() => this.effectiveCwd(), null);
  branches = signal<{ name: string; current: boolean; remote: boolean }[]>([]);
  branchLoading = signal(false);
  showBranchDropdown = signal(false);
  newBranchName = signal('');
  generatingBranchName = signal(false);
  diffViewFile = signal<string | null>(null);
  diffViewContent = signal('');
  diffViewLoading = signal(false);

  // Commit log
  commits = signal<{ hash: string; shortHash: string; author: string; relativeDate: string; message: string }[]>([]);
  showCommitLog = signal(false);
  commitLogLoading = signal(false);
  commitViewHash = signal<string | null>(null);
  commitViewDiff = signal('');
  commitViewLoading = signal(false);

  // Conflicts
  conflictFiles = signal<string[]>([]);
  resolvingFile = signal<string | null>(null);
  hasConflicts = computed(() => this.conflictFiles().length > 0);

  stagedFiles = computed(() => this.files().filter(f => f.staged));
  unstagedFiles = computed(() => this.files().filter(f => !f.staged));
  totalChanges = computed(() => this.files().length);

  // Per-type counts for the quick-commit button badges (green/yellow/red).
  addedCount = computed(() => this.files().filter(f => f.status === 'added' || f.status === 'untracked').length);
  modifiedCount = computed(() => this.files().filter(f => f.status === 'modified' || f.status === 'renamed').length);
  deletedCount = computed(() => this.files().filter(f => f.status === 'deleted').length);

  folders = computed(() => {
    const map = new Map<string, GitFile[]>();
    for (const f of this.files()) {
      const idx = f.path.lastIndexOf('/');
      const folder = idx > 0 ? f.path.substring(0, idx) : '.';
      if (!map.has(folder)) map.set(folder, []);
      map.get(folder)!.push(f);
    }
    const selected = this.selectedPaths();
    const result: GitFolder[] = [];
    for (const [folder, files] of map) {
      const allSelected = files.every(f => selected.has(f.path));
      const someSelected = files.some(f => selected.has(f.path));
      result.push({ folder, files, allSelected, someSelected });
    }
    return result.sort((a, b) => a.folder.localeCompare(b.folder));
  });

  reset(): void {
    this.files.set([]);
    this.branch.set('');
    this.selectedPaths.set(new Set());
    this.commitMessage.set('');
    this.committing.set(false);
    this.commitError.set(null);
    this.generatingMessage.set(false);
    this.generateError.set(null);
    this.pulling.set(false);
    this.pushing.set(false);
    this.syncError.set(null);
    this.syncSuccess.set(null);
    this.aiResolveSteps.set([]);
    this.aiResolvePhase.set('');
    this.branches.set([]);
    this.branchLoading.set(false);
    this.showBranchDropdown.set(false);
    this.newBranchName.set('');
    this.generatingBranchName.set(false);
    this.diffViewFile.set(null);
    this.diffViewContent.set('');
    this.diffViewLoading.set(false);
    this.commits.set([]);
    this.showCommitLog.set(false);
    this.commitLogLoading.set(false);
    this.commitViewHash.set(null);
    this.commitViewDiff.set('');
    this.commitViewLoading.set(false);
    this.conflictFiles.set([]);
    this.resolvingFile.set(null);
    this.miniTerminalOpen.set(false);
    this.miniTerminalOutput.set([]);
    this.miniTerminalRunning.set(false);
    this.cloning.set(false);
    this.cloneError.set(null);
    this.merging.set(false);
    this.mergeError.set(null);
    this.mergeResults.set([]);
  }

  /** The repo of the most recent refresh() call. */
  private latestRefreshCwd: string | null = null;

  /**
   * True when a git answer for `cwd` arrived after the user moved to another
   * repo (or a newer refresh started): writing it would show (and commit)
   * the other repo's files here.
   */
  private isStaleFor(cwd: string): boolean {
    const current = this.effectiveCwd();
    return (!!current && current !== cwd) || this.latestRefreshCwd !== cwd;
  }

  async refresh(cwd: string): Promise<void> {
    if (!this.isDesktop || !cwd) return;
    this.latestRefreshCwd = cwd;
    this.loading.set(true);
    try {
      const result: GitStatusResult = await this.api.getGitStatus(cwd);
      if (this.isStaleFor(cwd)) return;
      this.isRepo.set(result.ok);
      if (result.ok) {
        this.files.set(result.files);
        this.branch.set(result.branch ?? '');
      }
    } catch (err) {
    } finally {
      if (this.latestRefreshCwd === cwd) this.loading.set(false);
    }
  }

  toggleSelect(path: string): void {
    this.selectedPaths.update(s => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  toggleFolder(folder: string): void {
    const folderData = this.folders().find(f => f.folder === folder);
    if (!folderData) return;
    this.selectedPaths.update(s => {
      const next = new Set(s);
      if (folderData.allSelected) {
        folderData.files.forEach(f => next.delete(f.path));
      } else {
        folderData.files.forEach(f => next.add(f.path));
      }
      return next;
    });
  }

  selectAll(): void {
    this.selectedPaths.set(new Set(this.files().map(f => f.path)));
  }

  selectNone(): void {
    this.selectedPaths.set(new Set());
  }

  async stageAll(cwd: string): Promise<void> {
    const allPaths = this.files().map(f => f.path);
    if (!allPaths.length) return;
    try {
      const result = await this.api.gitStage(cwd, allPaths);
      this.selectedPaths.set(new Set());
      await this.refresh(cwd);
    } catch (err) {
    }
  }

  async stage(cwd: string): Promise<void> {
    const paths = Array.from(this.selectedPaths());
    if (!paths.length) return;
    try {
      const result = await this.api.gitStage(cwd, paths);
      this.selectedPaths.set(new Set());
      await this.refresh(cwd);
    } catch (err) {
    }
  }

  async unstage(cwd: string): Promise<void> {
    const paths = Array.from(this.selectedPaths());
    if (!paths.length) return;
    try {
      await this.api.gitUnstage(cwd, paths);
      this.selectedPaths.set(new Set());
      await this.refresh(cwd);
    } catch (err) {
    }
  }

  /**
   * Commit: stages selected files (or all) in the same IPC call, then commits.
   * This is the main commit flow — stage + commit in one atomic operation.
   */
  async commit(cwd: string): Promise<{ ok: boolean; error?: string }> {
    const msg = this.commitMessage().trim();
    if (!msg) return { ok: false, error: 'Empty commit message' };

    this.committing.set(true);
    this.commitError.set(null, cwd);
    try {
      // Determine which paths to stage
      const selected = Array.from(this.selectedPaths());
      const alreadyStaged = this.stagedFiles().map(f => f.path);

      // If there are already staged files and no selection, commit just the staged files
      // If no staged files, stage selected or all
      let pathsToStage: string[];
      if (alreadyStaged.length > 0 && selected.length === 0) {
        pathsToStage = []; // already staged, just commit
      } else if (selected.length > 0) {
        pathsToStage = selected;
      } else {
        pathsToStage = this.files().map(f => f.path);
      }

      // Use the combined stage+commit IPC call
      const result = await this.api.gitCommitWithPaths(cwd, msg, pathsToStage);

      if (result.ok) {
        this.commitMessage.set('');
        this.commitError.set(null, cwd);
        this.selectedPaths.set(new Set());
        await this.refresh(cwd);
      } else {
        this.commitError.set(result.error ?? this.msg('Commit failed', 'Commit failed'), cwd);
      }
      return result;
    } catch (err) {
      const errMsg = (err as Error).message;
      this.commitError.set(errMsg, cwd);
      return { ok: false, error: errMsg };
    } finally {
      this.committing.set(false);
    }
  }

  /**
   * Quick-bar commit: always stages EVERY current change, then commits in one
   * IPC call. Used by the minimal bar above the spawn input, which has no
   * per-file selection — so the commit must match the change-count badge
   * (unlike commit(), which only commits already-staged files when some exist).
   */
  async commitAll(cwd: string): Promise<{ ok: boolean; error?: string }> {
    const msg = this.commitMessage().trim();
    if (!msg) return { ok: false, error: 'Empty commit message' };

    this.committing.set(true);
    this.commitError.set(null, cwd);
    try {
      const pathsToStage = this.files().map(f => f.path);
      const result = await this.api.gitCommitWithPaths(cwd, msg, pathsToStage);

      if (result.ok) {
        this.commitMessage.set('');
        this.commitError.set(null, cwd);
        this.selectedPaths.set(new Set());
        await this.refresh(cwd);
      } else {
        this.commitError.set(result.error ?? this.msg('Commit failed', 'Commit failed'), cwd);
      }
      return result;
    } catch (err) {
      const errMsg = (err as Error).message;
      this.commitError.set(errMsg, cwd);
      return { ok: false, error: errMsg };
    } finally {
      this.committing.set(false);
    }
  }

  // ── Pull ──────────────────────────────────────────────────────────────
  async pull(cwd: string): Promise<void> {
    this.pulling.set(true);
    this.syncError.set(null, cwd);
    this.syncSuccess.set(null, cwd);
    try {
      const result = await this.api.gitPull(cwd);
      if (result.ok) {
        this.syncSuccess.set(result.output || this.msg('Pull successful', 'Pull successful'), cwd);
        await this.refresh(cwd);
        // Check for merge conflicts after pull
        await this.checkConflicts(cwd);
      } else {
        // Pull failed — could be merge conflict
        await this.checkConflicts(cwd);
        if (this.conflictFiles().length > 0) {
          this.syncError.set(this.msg('Merge conflicts count', 'Merge conflicts in {{count}} file(s)', { count: this.conflictFiles().length }), cwd);
        } else if (!(await this.autoResolveSync(cwd, 'pull', result.error))) {
          this.syncError.set(result.error ?? this.msg('Pull failed', 'Pull failed'), cwd);
        }
      }
    } catch (err) {
      this.syncError.set((err as Error).message, cwd);
    } finally {
      this.pulling.set(false);
      setTimeout(() => this.syncSuccess.set(null, cwd), 3000);
    }
  }

  // ── Push ──────────────────────────────────────────────────────────────
  async push(cwd: string): Promise<void> {
    // Safe-push preferences (configured in the Git Settings modal).
    if (this.confirmBeforePush()) {
      if (!(await this.confirmPush())) return;
    }
    if (this.autoPullBeforePush()) {
      await this.pull(cwd);
      // If the pull surfaced conflicts, don't push on top of a broken tree.
      if (this.hasConflicts()) {
        this.syncError.set(this.msg('Auto-pull conflicts', 'Auto-pull produced conflicts: resolve them before pushing.'), cwd);
        return;
      }
    }
    this.pushing.set(true);
    this.syncError.set(null, cwd);
    this.syncSuccess.set(null, cwd);
    try {
      const result = await this.api.gitPush(cwd);
      if (result.ok) {
        this.syncSuccess.set(result.output || this.msg('Push successful', 'Push successful'), cwd);
      } else if (!(await this.autoResolveSync(cwd, 'push', result.error))) {
        this.syncError.set(result.error ?? this.msg('Push failed', 'Push failed'), cwd);
      }
    } catch (err) {
      this.syncError.set((err as Error).message, cwd);
    } finally {
      this.pushing.set(false);
      setTimeout(() => this.syncSuccess.set(null, cwd), 3000);
    }
  }

  // ── Mini terminal (exec arbitrary git command) ───────────────────
  miniTerminalOpen = signal(false);
  miniTerminalOutput = signal<string[]>([]);
  miniTerminalRunning = signal(false);

  async exec(cwd: string, command: string): Promise<void> {
    this.miniTerminalRunning.set(true);
    this.miniTerminalOutput.update(lines => [...lines, `$ ${command}`]);
    try {
      const result = await this.api.gitExec(cwd, command);
      if (result.output) {
        this.miniTerminalOutput.update(lines => [...lines, result.output]);
      }
      if (result.ok) {
        this.syncError.set(null, cwd);
        await this.refresh(cwd);
      }
    } catch (err) {
      this.miniTerminalOutput.update(lines => [...lines, `Error: ${(err as Error).message}`]);
    } finally {
      this.miniTerminalRunning.set(false);
    }
  }

  openMiniTerminal(): void {
    this.miniTerminalOpen.set(true);
  }

  closeMiniTerminal(): void {
    this.miniTerminalOpen.set(false);
    this.miniTerminalOutput.set([]);
  }

  // ── File diff viewer ─────────────────────────────────────────────────
  async viewFileDiff(cwd: string, filePath: string): Promise<void> {
    this.diffViewFile.set(filePath);
    this.diffViewContent.set('');
    this.diffViewLoading.set(true);
    try {
      const result = await this.api.gitFileDiff(cwd, filePath);
      if (result.ok) {
        this.diffViewContent.set(result.diff);
      }
    } catch (err) {
    } finally {
      this.diffViewLoading.set(false);
    }
  }

  closeDiffView(): void {
    this.diffViewFile.set(null);
    this.diffViewContent.set('');
  }

  // ── Base64 file readers (image previews) ────────────────────────────
  async readFileBase64(cwd: string, filePath: string): Promise<{ ok: boolean; data?: string; mimeType?: string; size?: number; error?: string }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.fsReadFileBase64(cwd, filePath);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'fsReadFileBase64 IPC failed' };
    }
  }

  async showFileBase64(cwd: string, rev: string, filePath: string): Promise<{ ok: boolean; exists?: boolean; data?: string; mimeType?: string; size?: number; error?: string }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitShowFileBase64(cwd, rev, filePath);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'gitShowFileBase64 IPC failed' };
    }
  }

  // ── Commit log ──────────────────────────────────────────────────────
  async fetchLog(cwd: string, limit: number = 100): Promise<{ ok: boolean; commits?: any[]; branches?: string[]; currentBranch?: string; error?: string }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitLog(cwd, limit);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'gitLog IPC failed' };
    }
  }

  async loadCommitLog(cwd: string): Promise<void> {
    this.commitLogLoading.set(true);
    try {
      const result = await this.api.gitLog(cwd, 30);
      if (result.ok) this.commits.set(result.commits);
    } catch (err) {
    } finally {
      this.commitLogLoading.set(false);
    }
  }

  async viewCommit(cwd: string, hash: string): Promise<void> {
    this.commitViewHash.set(hash);
    this.commitViewDiff.set('');
    this.commitViewLoading.set(true);
    try {
      const result = await this.api.gitShow(cwd, hash);
      if (result.ok) this.commitViewDiff.set(result.diff);
    } catch (err) {
    } finally {
      this.commitViewLoading.set(false);
    }
  }

  closeCommitView(): void {
    this.commitViewHash.set(null);
    this.commitViewDiff.set('');
  }

  // ── Conflict resolution ─────────────────────────────────────────────
  async checkConflicts(cwd: string): Promise<void> {
    try {
      const result = await this.api.gitConflictFiles(cwd);
      if (result.ok) this.conflictFiles.set(result.files);
    } catch {}
  }

  async resolveConflict(cwd: string, filePath: string, provider: ProviderType): Promise<void> {
    this.resolvingFile.set(filePath);
    this.syncError.set(null, cwd);
    try {
      const result = await this.api.gitResolveConflict(cwd, filePath, provider);
      if (result.ok) {
        this.syncSuccess.set(this.msg('Resolved file', 'Resolved: {{file}}', { file: filePath }), cwd);
        // Refresh conflicts
        await this.checkConflicts(cwd);
        await this.refresh(cwd);
      } else {
        this.syncError.set(result.error ?? this.msg('Resolve failed', 'Failed to resolve conflict'), cwd);
      }
    } catch (err) {
      this.syncError.set((err as Error).message, cwd);
    } finally {
      this.resolvingFile.set(null);
      setTimeout(() => this.syncSuccess.set(null, cwd), 3000);
    }
  }

  async resolveAllConflicts(cwd: string, provider: ProviderType): Promise<void> {
    for (const file of this.conflictFiles()) {
      await this.resolveConflict(cwd, file, provider);
    }
  }

  // ── Branches ──────────────────────────────────────────────────────────
  async loadBranches(cwd: string): Promise<void> {
    this.branchLoading.set(true);
    try {
      const result = await this.api.gitListBranches(cwd);
      if (result.ok) {
        this.branches.set(result.branches);
      }
    } catch (err) {
    } finally {
      this.branchLoading.set(false);
    }
  }

  async checkout(cwd: string, branch: string): Promise<void> {
    this.syncError.set(null, cwd);
    this.syncSuccess.set(null, cwd);
    try {
      const result = await this.api.gitCheckout(cwd, branch);
      if (result.ok) {
        this.syncSuccess.set(this.msg('Switched to', 'Switched to {{branch}}', { branch }), cwd);
        this.showBranchDropdown.set(false);
        await this.refresh(cwd);
        await this.loadBranches(cwd);
      } else {
        this.syncError.set(result.error ?? this.msg('Checkout failed', 'Checkout failed'), cwd);
      }
    } catch (err) {
      this.syncError.set((err as Error).message, cwd);
    } finally {
      setTimeout(() => this.syncSuccess.set(null, cwd), 3000);
    }
  }

  async createBranch(cwd: string): Promise<void> {
    const name = this.newBranchName().trim();
    if (!name) return;
    this.syncError.set(null, cwd);
    this.syncSuccess.set(null, cwd);
    try {
      const result = await this.api.gitCreateBranch(cwd, name);
      if (result.ok) {
        this.syncSuccess.set(this.msg('Created and switched', 'Created and switched to {{branch}}', { branch: name }), cwd);
        this.newBranchName.set('');
        this.showBranchDropdown.set(false);
        await this.refresh(cwd);
        await this.loadBranches(cwd);
      } else {
        this.syncError.set(result.error ?? this.msg('Create branch failed', 'Create branch failed'), cwd);
      }
    } catch (err) {
      this.syncError.set((err as Error).message, cwd);
    } finally {
      setTimeout(() => this.syncSuccess.set(null, cwd), 3000);
    }
  }

  // ── AI branch name generation ────────────────────────────────────────
  async generateBranchName(cwd: string, provider: ProviderType): Promise<void> {
    this.generatingBranchName.set(true);
    this.syncError.set(null, cwd);
    try {
      const result = await this.api.gitGenerateBranchName(cwd, provider, {
        style: this.branchStyle(),
        instructions: this.commitInstructions().trim(),
      });
      if (result.ok && result.name) {
        this.newBranchName.set(result.name);
      } else {
        this.syncError.set(result.error ?? this.msg('Branch name failed', 'Failed to generate branch name'), cwd);
      }
    } catch (err) {
      this.syncError.set((err as Error).message, cwd);
    } finally {
      this.generatingBranchName.set(false);
    }
  }

  // ── Clone ──────────────────────────────────────────────────────────────
  cloning = signal(false);
  cloneError = signal<string | null>(null);

  async clone(url: string, destination: string, branch?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    this.cloning.set(true);
    this.cloneError.set(null);
    try {
      const result = await this.api.gitClone(url, destination, branch || undefined);
      if (!result.ok) this.cloneError.set(result.error ?? this.msg('Clone failed', 'Clone failed'));
      return result;
    } catch (err: any) {
      const msg = err?.message || this.msg('Clone failed', 'Clone failed');
      this.cloneError.set(msg);
      return { ok: false, error: msg };
    } finally {
      this.cloning.set(false);
    }
  }

  // ── Discover repos in subfolders ─────────────────────────────────────
  async discoverRepos(cwd: string): Promise<DiscoveredRepo[]> {
    if (!this.isDesktop || !cwd) return [];
    try {
      const result = await this.api.gitDiscoverRepos(cwd);
      return result?.ok ? result.repos : [];
    } catch {
      return [];
    }
  }

  // ── Multi-repo workspace context (quick-commit ⇄ Git Explorer sync) ──
  /** Workspace root the sidebar git widgets are scoped to (the session cwd). */
  workspaceRoot = signal<string | null>(null);
  /** Repos found in the root's immediate subfolders when the root itself is
   *  not a repo. Empty when the root is a repo (or has none). */
  discoveredRepos = signal<DiscoveredRepo[]>([]);
  /** Selected repo among discoveredRepos; null when the root itself is the repo. */
  activeRepoPath = signal<string | null>(null);
  /** cwd every git widget outside the Git Explorer should target. */
  effectiveCwd = computed(() => this.activeRepoPath() ?? this.workspaceRoot());

  private static readonly REPO_PICKS_KEY = 'po:git:repoPickByRoot';
  private _scopeRoot: string | null = null;
  private _scopePromise: Promise<void> | null = null;

  /** Scope the shared git state to a workspace root: if the root is not a repo,
   *  discover repos one level down and restore the last one picked there (in the
   *  Git Explorer or the quick-commit dropdown). Concurrent calls for the same
   *  root coalesce — the sidebar quick-commit bar and the git panel both react
   *  to the same session switch. */
  scopeToWorkspace(root: string): Promise<void> {
    if (!this.isDesktop || !root) return Promise.resolve();
    if (this._scopeRoot === root && this._scopePromise) return this._scopePromise;
    this._scopeRoot = root;
    const p = this.resolveScope(root).finally(() => {
      if (this._scopePromise === p) this._scopePromise = null;
    });
    this._scopePromise = p;
    return p;
  }

  private async resolveScope(root: string): Promise<void> {
    const rootChanged = this.workspaceRoot() !== root;
    this.workspaceRoot.set(root);
    if (rootChanged) {
      this.reset();
      this.discoveredRepos.set([]);
      this.activeRepoPath.set(null);
    } else if (this.activeRepoPath()) {
      // Already resolved for this root — just top up the status.
      await this.refresh(this.activeRepoPath()!);
      if (this.isRepo()) return;
      // The selected repo vanished (deleted/moved): fall through and re-discover.
      this.activeRepoPath.set(null);
    }
    await this.refresh(root);
    if (this._scopeRoot !== root) return; // workspace switched mid-flight
    if (this.isRepo()) {
      this.discoveredRepos.set([]);
      return;
    }
    const repos = await this.discoverRepos(root);
    if (this._scopeRoot !== root) return;
    this.discoveredRepos.set(repos);
    if (repos.length === 0) return;
    const remembered = this.rememberedRepoPick(root);
    const target = repos.find(r => r.path === remembered) ?? repos[0];
    this.activeRepoPath.set(target.path);
    await this.refresh(target.path);
  }

  /** Repo picked from the quick-commit dropdown: persist, switch, refresh. */
  selectRepo(path: string): void {
    if (!path || path === this.activeRepoPath()) return;
    this.activeRepoPath.set(path);
    const root = this.workspaceRoot();
    if (root) this.persistRepoPick(root, path);
    this.reset();
    void this.refresh(path);
  }

  /** Repo picked inside the Git Explorer: persist it and mirror it on the
   *  sidebar quick-commit (no refresh here — the explorer already refreshes). */
  rememberRepoPick(root: string, path: string): void {
    if (!root || !path) return;
    this.persistRepoPick(root, path);
    if (this.workspaceRoot() === root) this.activeRepoPath.set(path);
  }

  /** Last repo picked under this workspace root, if any. */
  rememberedRepoPick(root: string): string | null {
    return this.loadRepoPicks()[root] ?? null;
  }

  private loadRepoPicks(): Record<string, string> {
    try {
      const raw = localStorage.getItem(GitService.REPO_PICKS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private persistRepoPick(root: string, path: string): void {
    try {
      const picks = this.loadRepoPicks();
      // Re-insert so the map stays ordered oldest-first and can be pruned.
      delete picks[root];
      picks[root] = path;
      const keys = Object.keys(picks);
      if (keys.length > 50) delete picks[keys[0]];
      localStorage.setItem(GitService.REPO_PICKS_KEY, JSON.stringify(picks));
    } catch { /* ignore */ }
  }

  // ── Merge ─────────────────────────────────────────────────────────
  merging = signal(false);
  mergeError = signal<string | null>(null);
  mergeResults = signal<{ source: string; ok: boolean; error?: string; conflict?: boolean }[]>([]);

  async merge(
    cwd: string,
    sources: string[],
    target: string,
    strategy: 'default' | 'no-ff' | 'squash' | 'ff-only' = 'default',
    message?: string,
    autoStash: boolean = false,
  ): Promise<{
    ok: boolean;
    error?: string;
    conflict?: boolean;
    dirty?: boolean;
    stashed?: boolean;
    stashRestored?: boolean;
    results?: { source: string; ok: boolean; error?: string; conflict?: boolean }[];
  }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    this.merging.set(true);
    this.mergeError.set(null);
    this.mergeResults.set([]);
    try {
      const result = await this.api.gitMerge(cwd, sources, target, strategy, message, autoStash);
      this.mergeResults.set(result.results || []);
      if (!result.ok) this.mergeError.set(result.error ?? this.msg('Merge failed', 'Merge failed'));
      await this.refresh(cwd);
      await this.checkConflicts(cwd);
      return result;
    } catch (err: any) {
      const msg = err?.message || this.msg('Merge failed', 'Merge failed');
      this.mergeError.set(msg);
      return { ok: false, error: msg };
    } finally {
      this.merging.set(false);
    }
  }

  async mergeAbort(cwd: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      const result = await this.api.gitMergeAbort(cwd);
      await this.refresh(cwd);
      await this.checkConflicts(cwd);
      return result;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Abort failed' };
    }
  }

  // ── History-graph context-menu operations ──────────────────────────
  // Thin wrappers: no shared signal state — the Git explorer surfaces
  // results/errors locally next to the gesture that triggered them.

  async createBranchAt(cwd: string, name: string, startPoint?: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitCreateBranch(cwd, name, startPoint);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Create branch failed' };
    }
  }

  async cherryPick(cwd: string, hash: string): Promise<{ ok: boolean; error?: string; conflict?: boolean; dirty?: boolean; aborted?: boolean }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitCherryPick(cwd, hash);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Cherry-pick failed' };
    }
  }

  async revert(cwd: string, hash: string): Promise<{ ok: boolean; error?: string; conflict?: boolean; dirty?: boolean; aborted?: boolean }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitRevert(cwd, hash);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Revert failed' };
    }
  }

  async rebase(cwd: string, onto: string): Promise<{ ok: boolean; error?: string; conflict?: boolean; dirty?: boolean; aborted?: boolean }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitRebase(cwd, onto);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Rebase failed' };
    }
  }

  async resetToCommit(cwd: string, hash: string, mode: 'soft' | 'mixed' | 'hard'): Promise<{ ok: boolean; error?: string }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitReset(cwd, hash, mode);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Reset failed' };
    }
  }

  async deleteBranch(cwd: string, branch: string, opts?: { force?: boolean; remote?: boolean }): Promise<{ ok: boolean; error?: string; notMerged?: boolean }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitDeleteBranch(cwd, branch, opts);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Delete branch failed' };
    }
  }

  async renameBranch(cwd: string, branch: string, newName: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitRenameBranch(cwd, branch, newName);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Rename branch failed' };
    }
  }

  async amendCommit(cwd: string, message: string, allowPushed?: boolean): Promise<{ ok: boolean; error?: string; pushed?: boolean }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitCommitAmend(cwd, message, allowPushed);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Amend failed' };
    }
  }

  async fetchRemote(cwd: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitFetch(cwd);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Fetch failed' };
    }
  }

  /** HEAD + every ref with its sha: changes whenever a checkout, merge, commit,
   *  pull or fetch moves something, wherever it ran (explorer, panel, terminal). */
  async refsFingerprint(cwd: string): Promise<string | null> {
    if (!this.isDesktop || !cwd) return null;
    try {
      const res = await this.api.gitExec(cwd, 'git show-ref --head');
      return res?.ok ? (res.output ?? '') : null;
    } catch {
      return null;
    }
  }

  async aheadBehind(cwd: string): Promise<{ ok: boolean; ahead?: number; behind?: number; upstream?: string; noUpstream?: boolean; error?: string }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitAheadBehind(cwd);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Ahead/behind failed' };
    }
  }

  async createTag(cwd: string, name: string, hash: string, message?: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitTag(cwd, name, hash, message);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Create tag failed' };
    }
  }

  async remoteUrl(cwd: string): Promise<{ ok: boolean; url?: string; webUrl?: string | null; error?: string }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitRemoteUrl(cwd);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'No remote' };
    }
  }

  // ── Worktrees ────────────────────────────────────────────────────────
  async listWorktrees(cwd: string): Promise<{ ok: boolean; worktrees?: GitWorktree[]; error?: string }> {
    if (!this.isDesktop || !cwd) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitWorktreeList(cwd);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Worktree list failed' };
    }
  }

  async addWorktree(cwd: string, path: string, branch: string, newBranch: boolean, base?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitWorktreeAdd(cwd, path, branch, newBranch, base);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Worktree add failed' };
    }
  }

  async removeWorktree(cwd: string, path: string, force = false): Promise<{ ok: boolean; error?: string; dirty?: boolean; locked?: boolean }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitWorktreeRemove(cwd, path, force);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Worktree remove failed' };
    }
  }

  async pruneWorktrees(cwd: string): Promise<{ ok: boolean; pruned?: number; error?: string }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    try {
      return await this.api.gitWorktreePrune(cwd);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Worktree prune failed' };
    }
  }

  // ── AI Resolver for pull/push failures ───────────────────────────────
  aiResolving = scopedSignal<boolean>(() => this.effectiveCwd(), false);
  aiResolveSteps = scopedSignal<string[]>(() => this.effectiveCwd(), []);
  aiResolvePhase = scopedSignal<string>(() => this.effectiveCwd(), '');
  private _aiPhaseTimer: any = null;
  private get AI_PHASES(): string[] {
    return [
      this.msg('Phase inspect', 'Inspecting your changes…'),
      this.msg('Phase backup', 'Backing up local work safely…'),
      this.msg('Phase fetch', 'Fetching the latest from origin…'),
      this.msg('Phase merge', 'Merging and resolving conflicts…'),
      this.msg('Phase check', 'Double-checking everything is clean…'),
    ];
  }

  /** Errors the resolver can fix without any decision: remote moved (CI
   *  bump), divergent branches, merge left half-done, stale index.lock,
   *  missing upstream. Auth/network/timeout errors are NOT here — those go
   *  to Fix Git Setup or need the user. */
  private isAutoResolvable(msg?: string | null): boolean {
    if (!msg) return false;
    const m = msg.toLowerCase();
    const blocked = ['permission denied', 'publickey', 'authentication', 'could not read', 'host key',
      'timed out', 'could not resolve host', 'repository not found', 'connection'];
    if (blocked.some(b => m.includes(b))) return false;
    return [
      'rejected', 'non-fast-forward', 'fetch first', 'divergent', 'reconcile',
      'not possible to fast-forward', 'would be overwritten', 'index.lock',
      'not concluded your merge', 'merge_head exists', 'unfinished merge',
      'no tracking information', 'has no upstream',
    ].some(k => m.includes(k));
  }

  /** Tauri only: when a plain pull/push fails for a recoverable reason, run the
   *  resolver in automatic safe mode (no AI edits, no reset, no force-push —
   *  it stops and reports at anything needing a decision). Returns true when
   *  the resolver took over the outcome (success or its own error). */
  private async autoResolveSync(cwd: string, op: 'pull' | 'push', error?: string): Promise<boolean> {
    if (!(window as any).__TAURI__ || this.aiResolving() || !this.isAutoResolvable(error)) return false;
    const r = await this.aiResolveSync(cwd, op, 'claude-code-cli', error, { auto: true });
    if (r.ok && !r.partial) {
      this.syncSuccess.set(op === 'push'
        ? 'Remote had new commits — merged safely and pushed ✓'
        : 'Pull needed a merge — done safely ✓', cwd);
    }
    return true;
  }

  async aiResolveSync(
    cwd: string,
    operation: 'pull' | 'push' | 'auto',
    provider: ProviderType,
    lastError?: string,
    opts?: { auto?: boolean },
  ): Promise<{ ok: boolean; error?: string; steps?: string[]; partial?: boolean }> {
    if (!this.isDesktop) return { ok: false, error: 'Not in the desktop app' };
    this.aiResolving.set(true, cwd);
    this.aiResolveSteps.set([], cwd);
    this.syncError.set(null, cwd);
    // Also clear a prior commit error: the resolver can be launched from the
    // quick-commit bar (which surfaces commitError too), and on success the stale
    // commit error must not linger next to the success message.
    this.commitError.set(null, cwd);
    this.syncSuccess.set(null, cwd);
    // Live "working" feedback: cycle through phases so the user sees activity
    // even though the backend returns all steps at once at the end.
    this.aiResolvePhase.set(this.AI_PHASES[0], cwd);
    if (this._aiPhaseTimer) clearInterval(this._aiPhaseTimer);
    let pi = 0;
    this._aiPhaseTimer = setInterval(() => {
      pi = Math.min(pi + 1, this.AI_PHASES.length - 1);
      this.aiResolvePhase.set(this.AI_PHASES[pi], cwd);
    }, 1400);
    try {
      const result = await this.api.gitAiResolveSync(cwd, operation, provider, lastError, opts);
      this.aiResolveSteps.set(result.steps || [], cwd);
      if (result.ok) {
        this.syncSuccess.set(result.partial
          ? (result.error || this.msg('Sync partial', 'Sync done with a couple of warnings: have a quick look below'))
          : this.msg('Sync resolved', 'All set! Conflicts resolved and your branch is back in sync'), cwd);
      } else {
        this.syncError.set(result.error || this.msg('AI resolver failed', 'AI Resolver failed'), cwd);
      }
      await this.refresh(cwd);
      await this.checkConflicts(cwd);
      return result;
    } catch (err: any) {
      const msg = err?.message || this.msg('AI resolver crashed', 'AI Resolver crashed');
      this.syncError.set(msg, cwd);
      return { ok: false, error: msg };
    } finally {
      this.aiResolving.set(false, cwd);
      this.aiResolvePhase.set('', cwd);
      if (this._aiPhaseTimer) { clearInterval(this._aiPhaseTimer); this._aiPhaseTimer = null; }
      setTimeout(() => {
        this.syncSuccess.set(null, cwd);
        // Keep the step log around on error (it explains what happened);
        // clear it once the success toast fades so the panel stays tidy.
        if (!this.syncError.raw()) this.aiResolveSteps.set([], cwd);
      }, 8000);
    }
  }

  // ── AI commit message generation ──────────────────────────────────────
  setCommitConvention(c: string): void {
    const v: 'conventional' | 'plain' = c === 'plain' ? 'plain' : 'conventional';
    this.commitConvention.set(v);
    this.persist('po:git:commitConvention', v);
  }

  setCommitLanguage(l: string): void {
    const v: 'auto' | 'en' | 'it' = l === 'en' ? 'en' : l === 'it' ? 'it' : 'auto';
    this.commitLanguage.set(v);
    this.persist('po:git:commitLanguage', v);
  }

  setCommitInstructions(text: string): void {
    const v = (text ?? '').slice(0, 500);
    this.commitInstructions.set(v);
    this.persist('po:git:commitInstructions', v);
  }

  setBranchStyle(s: string): void {
    const v: 'gitflow' | 'simple' = s === 'gitflow' ? 'gitflow' : 'simple';
    this.branchStyle.set(v);
    this.persist('po:git:branchStyle', v);
  }

  setDefaultBaseBranch(b: string): void {
    const v = (b ?? '').trim().slice(0, 100);
    this.defaultBaseBranch.set(v);
    this.persist('po:git:defaultBaseBranch', v);
  }

  setConfirmBeforePush(on: boolean): void {
    this.confirmBeforePush.set(on);
    this.persist('po:git:confirmBeforePush', on ? '1' : '0');
  }

  setAutoPullBeforePush(on: boolean): void {
    this.autoPullBeforePush.set(on);
    this.persist('po:git:autoPullBeforePush', on ? '1' : '0');
  }

  /** Options bundle handed to the AI commit-message generator. */
  private commitGenOptions(): { convention: string; language: string; instructions: string } {
    return {
      convention: this.commitConvention(),
      language: this.commitLanguage(),
      instructions: this.commitInstructions().trim(),
    };
  }

  async generateCommitMessage(cwd: string, provider: ProviderType): Promise<void> {
    this.generatingMessage.set(true);
    this.generateError.set(null, cwd);
    try {
      const result = await this.api.gitGenerateCommitMsg(cwd, provider, this.commitGenOptions());
      if (result.ok && result.message) {
        // Another repo is on screen now: its draft must not get this message.
        const current = this.effectiveCwd();
        if (!current || current === cwd) this.commitMessage.set(result.message);
      } else {
        this.generateError.set(result.error ?? this.msg('Commit message failed', 'Failed to generate commit message'), cwd);
      }
    } catch (err) {
      this.generateError.set((err as Error).message, cwd);
    } finally {
      this.generatingMessage.set(false);
    }
  }
}
