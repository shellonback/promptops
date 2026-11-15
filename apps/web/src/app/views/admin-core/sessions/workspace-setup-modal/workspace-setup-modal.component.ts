import { Component, CUSTOM_ELEMENTS_SCHEMA, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { SessionService } from '../services/session.service';
import { DeviceWorkspaceStatus } from '@/store/sessions/session.state';

@Component({
  selector: 'app-workspace-setup-modal',
  standalone: true,
  imports: [FormsModule, TranslateModule],
  templateUrl: './workspace-setup-modal.component.html',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .session-info-card {
      background: var(--po-bg-2);
      border-radius: 0.5rem;
      padding: 0.75rem 1rem;
      margin-bottom: 1rem;
    }

    .info-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.2rem 0;
    }

    .info-label {
      font-size: 0.75rem;
      color: var(--po-text-secondary);
      min-width: 60px;
    }

    .info-value {
      font-size: 0.82rem;
      font-weight: 500;
      color: var(--po-text-primary);
    }

    .provider-badge {
      font-size: 0.7rem;
      padding: 1px 8px;
      border-radius: 4px;
      background: rgba(99, 102, 241, 0.12);
      color: var(--po-accent);
    }

    .alert-banner {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.6rem 0.85rem;
      border-radius: 0.5rem;
      font-size: 0.8rem;
      margin-bottom: 1rem;
    }

    .alert-banner.warning {
      background: var(--po-warning-bg);
      color: var(--po-warning);
      border: 1px solid rgba(210, 153, 34, 0.2);
    }

    .alert-banner.error {
      background: var(--po-error-bg);
      color: var(--po-error);
      border: 1px solid rgba(248, 81, 73, 0.2);
    }

    .selected-path {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0.75rem;
      background: var(--po-success-bg);
      border: 1px solid rgba(63, 185, 80, 0.2);
      border-radius: 0.5rem;
      margin-bottom: 1rem;
      color: var(--po-success);
    }

    .path-text {
      flex: 1;
      font-size: 0.78rem;
      font-family: monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .btn-clear {
      background: none;
      border: none;
      color: var(--po-text-secondary);
      cursor: pointer;
      padding: 0;
      display: flex;
    }

    .action-cards {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .action-card {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.85rem 1rem;
      background: var(--po-bg-2);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 0.5rem;
      cursor: pointer;
      transition: all var(--po-duration-fast);
      text-align: start;
      color: var(--po-text-primary);
      width: 100%;
    }

    .action-card:hover:not(:disabled) {
      background: rgba(99, 102, 241, 0.06);
      border-color: rgba(99, 102, 241, 0.2);
    }

    .action-card:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .action-card iconify-icon {
      color: var(--po-accent);
      flex-shrink: 0;
    }

    .action-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex: 1;
      min-width: 0;
    }

    .action-text strong {
      font-size: 0.82rem;
      font-weight: 600;
    }

    .action-text span {
      font-size: 0.7rem;
      color: var(--po-text-secondary);
    }

    .clone-form {
      background: var(--po-bg-2);
      border: 1px solid rgba(99, 102, 241, 0.2);
      border-radius: 0.5rem;
      padding: 0.85rem 1rem;
    }

    .clone-form-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.75rem;
    }

    .clone-form-header iconify-icon {
      color: var(--po-accent);
    }

    .clone-form-header strong {
      font-size: 0.82rem;
      font-weight: 600;
    }

    .clone-form-header .btn-back {
      margin-inline-start: auto;
      background: none;
      border: none;
      color: var(--po-text-secondary);
      cursor: pointer;
      padding: 2px;
      display: flex;
      transition: color var(--po-duration-fast);
    }

    .clone-form-header .btn-back:hover {
      color: var(--po-text-primary);
    }

    .clone-field {
      margin-bottom: 0.6rem;
    }

    .clone-field label {
      display: block;
      font-size: 0.72rem;
      color: var(--po-text-secondary);
      margin-bottom: 0.25rem;
      font-weight: 500;
    }

    .clone-field input {
      width: 100%;
      padding: 0.45rem 0.65rem;
      background: var(--po-bg-1);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 0.35rem;
      color: var(--po-text-primary);
      font-size: 0.8rem;
      font-family: monospace;
      outline: none;
      transition: border-color var(--po-duration-fast);
    }

    .clone-field input:focus {
      border-color: rgba(99, 102, 241, 0.4);
    }

    .clone-field input::placeholder {
      color: var(--po-text-secondary);
      opacity: 0.5;
    }

    .clone-destination {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .clone-destination .dest-path {
      flex: 1;
      font-size: 0.78rem;
      font-family: monospace;
      color: var(--po-text-primary);
      padding: 0.45rem 0.65rem;
      background: var(--po-bg-1);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 0.35rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .clone-destination .dest-path.placeholder {
      color: var(--po-text-secondary);
      opacity: 0.5;
    }

    .btn-browse {
      padding: 0.4rem 0.7rem;
      background: rgba(99, 102, 241, 0.1);
      border: 1px solid rgba(99, 102, 241, 0.2);
      border-radius: 0.35rem;
      color: var(--po-accent);
      font-size: 0.75rem;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: all var(--po-duration-fast);
    }

    .btn-browse:hover {
      background: rgba(99, 102, 241, 0.18);
    }

    .clone-progress {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0;
      font-size: 0.78rem;
      color: var(--po-text-secondary);
    }

    .repo-url {
      font-family: monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .shell-field {
      margin-bottom: 1rem;
    }

    .shell-field label {
      display: block;
      font-size: 0.72rem;
      color: var(--po-text-secondary);
      margin-bottom: 0.25rem;
      font-weight: 500;
    }

    .shell-field .shell-hint {
      display: block;
      font-size: 0.68rem;
      color: var(--po-text-secondary);
      margin-top: 0.25rem;
      opacity: 0.8;
    }
  `,
})
export class WorkspaceSetupModalComponent implements OnInit {
  modal = inject(NgbActiveModal);
  private sessionService = inject(SessionService);
  private translate = inject(TranslateService);

  private t(key: string): string {
    return this.translate.instant('SESSIONS.DEVICE_WORKSPACE.' + key);
  }

  /** Set via componentInstance */
  sessionId = '';
  sessionName = '';
  sessionProvider = '';
  repoUrl: string | null = null;
  repoBranch: string | null = null;
  deviceWorkspaceId: string | null = null;

  /** 'not_configured' when no device workspace exists, 'invalid_path' when path is missing */
  mode = signal<DeviceWorkspaceStatus>('not_configured');
  selectedPath = signal<string | null>(null);
  saving = signal(false);
  cloning = signal(false);
  error = signal<string | null>(null);

  /** New-folder form state: pick a parent directory + type the folder name */
  showNewFolderForm = signal(false);
  newFolderParent = signal<string | null>(null);
  newFolderName = signal('');
  creatingFolder = signal(false);

  /** Clone form state */
  showCloneForm = signal(false);
  cloneUrl = signal('');
  cloneBranch = signal('');
  cloneDestination = signal<string | null>(null);

  /**
   * Windows-only terminal shell for this session (PowerShell / pwsh / cmd /
   * Git Bash / WSL). Fed by the desktop's cached shell detection; hidden on
   * macOS/Linux and in the browser build. Default comes from Settings.
   */
  shellId = signal<string>('powershell');
  terminalShells = signal<Array<{ id: string; kind: string; label: string; distro?: string }>>([]);

  get isWindowsDesktop(): boolean {
    return this.sessionService.isWindowsDesktop;
  }

  get isTauriDesktop(): boolean {
    return this.sessionService.isTauri;
  }

  ngOnInit(): void {
    if (this.isWindowsDesktop) {
      if (this.isTauriDesktop) {
        // Tauri: '' = follow the Settings default natively (uniform system).
        this.shellId.set('');
      } else {
        const pref = (window as any).__PO_UI_PREFS__?.terminal_default_shell;
        if (typeof pref === 'string' && pref) this.shellId.set(pref);
      }
      void this.loadTerminalShells();
    }
  }

  private async loadTerminalShells(): Promise<void> {
    try {
      // Current shell of the live desktop session wins over the Settings default.
      const live = await this.sessionService.getSession(this.sessionId).catch(() => null);
      if (live?.config?.shell) this.shellId.set(live.config.shell);

      const res = await this.sessionService.listTerminalShells();
      if (res?.ok && res.shells?.length) {
        this.terminalShells.set(res.shells);
        if (this.shellId() && !res.shells.some((s) => s.id === this.shellId())) {
          this.shellId.set(this.isTauriDesktop ? '' : 'powershell');
        }
      }
    } catch { /* detection unavailable — select stays hidden */ }
  }

  async selectFolder(): Promise<void> {
    try {
      const result = await this.sessionService.selectWorkspace();
      if (result) {
        this.selectedPath.set(result.path);
        this.error.set(null);
      }
    } catch (err) {
      this.error.set(this.t('Error select folder'));
    }
  }

  openCloneForm(): void {
    this.showCloneForm.set(true);
    if (this.repoUrl) {
      this.cloneUrl.set(this.repoUrl);
    }
    if (this.repoBranch) {
      this.cloneBranch.set(this.repoBranch);
    }
  }

  closeCloneForm(): void {
    this.showCloneForm.set(false);
    this.cloneDestination.set(null);
    this.error.set(null);
  }

  async selectCloneDestination(): Promise<void> {
    try {
      const result = await this.sessionService.selectWorkspace();
      if (result) {
        this.cloneDestination.set(result.path);
        this.error.set(null);
      }
    } catch (err) {
      this.error.set(this.t('Error select destination'));
    }
  }

  async cloneRepository(): Promise<void> {
    const rawUrl = this.cloneUrl().trim();
    const dest = this.cloneDestination();
    if (!rawUrl || !dest) return;

    const cloneUrl = this.normalizeGitUrl(rawUrl);
    const repoName = this.extractRepoName(cloneUrl);
    const fullDest = dest + (dest.endsWith('/') ? '' : '/') + repoName;

    this.cloning.set(true);
    this.error.set(null);

    try {
      const branch = this.cloneBranch().trim() || undefined;
      const result = await this.sessionService.gitClone(cloneUrl, fullDest, branch);

      if (!result.ok) {
        this.error.set(result.error || this.t('Error clone'));
        this.cloning.set(false);
        return;
      }

      this.selectedPath.set(result.path || fullDest);
      this.showCloneForm.set(false);
      this.cloning.set(false);
    } catch (err: any) {
      this.cloning.set(false);
      this.error.set(err?.message || this.t('Error clone'));
    }
  }

  openNewFolderForm(): void {
    this.showNewFolderForm.set(true);
    this.error.set(null);
  }

  closeNewFolderForm(): void {
    this.showNewFolderForm.set(false);
    this.newFolderParent.set(null);
    this.newFolderName.set('');
    this.error.set(null);
  }

  async selectNewFolderParent(): Promise<void> {
    try {
      const result = await this.sessionService.selectWorkspace();
      if (result) {
        this.newFolderParent.set(result.path);
        this.error.set(null);
      }
    } catch (err) {
      this.error.set(this.t('Error select folder'));
    }
  }

  /** Creates `<parent>/<name>` on disk and selects it as the workspace path. */
  async createNewFolder(): Promise<void> {
    const parent = this.newFolderParent();
    const name = this.newFolderName().trim();
    if (!parent || !name) return;

    this.creatingFolder.set(true);
    this.error.set(null);

    try {
      const result = await this.sessionService.createWorkspaceFolder(parent, name);
      if (!result?.ok || !result.workspace) {
        this.error.set(result?.error || this.t('Error create folder'));
        return;
      }
      this.selectedPath.set(result.workspace.path);
      this.showNewFolderForm.set(false);
      this.newFolderParent.set(null);
      this.newFolderName.set('');
    } catch (err: any) {
      this.error.set(err?.message || this.t('Error create folder'));
    } finally {
      this.creatingFolder.set(false);
    }
  }

  get newFolderPreview(): string {
    const parent = this.newFolderParent();
    const name = this.newFolderName().trim();
    if (!parent) return '';
    return parent + (parent.endsWith('/') || parent.endsWith('\\') ? '' : '/') + name;
  }

  get canCreateFolder(): boolean {
    return !!this.newFolderParent() && !!this.newFolderName().trim();
  }

  clearSelection(): void {
    this.selectedPath.set(null);
  }

  async confirm(): Promise<void> {
    const path = this.selectedPath();
    if (!path) return;

    this.saving.set(true);
    this.error.set(null);

    try {
      const validation = await this.sessionService.validateWorkspacePath(path);
      if (!validation.valid) {
        this.error.set(this.t('Error invalid path'));
        this.saving.set(false);
        return;
      }

      if (this.deviceWorkspaceId && this.mode() === 'invalid_path') {
        await this.sessionService.updateDeviceWorkspace(this.deviceWorkspaceId, path);
      } else {
        await this.sessionService.upsertDeviceWorkspace(this.sessionId, path);
      }

      // The live desktop session keeps its own copy of the folder: push the
      // new one too, or the next spawn/wake still starts in the old path.
      const folderName = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      await this.sessionService
        .updateSessionMeta(this.sessionId, { workspace: { path, name: folderName } })
        .catch(() => { /* session not live in the desktop app — path is saved anyway */ });

      // Windows: persist the chosen shell on the session (applied at next
      // spawn/wake). Tauri: '' (Default) → null = clear the override so the
      // session follows the Settings default.
      if (this.isWindowsDesktop && this.terminalShells().length) {
        await this.sessionService
          .updateSessionMeta(this.sessionId, { shell: this.shellId() || null })
          .catch(() => { /* session not live in the desktop app — path is saved anyway */ });
      }

      this.modal.close({ localPath: path });
    } catch (err) {
      this.error.set(this.t('Error save'));
    } finally {
      this.saving.set(false);
    }
  }

  get canClone(): boolean {
    return !!this.cloneUrl().trim() && !!this.cloneDestination();
  }

  private normalizeGitUrl(url: string): string {
    const ccMatch = url.match(
      /console\.aws\.amazon\.com\/codesuite\/codecommit\/repositories\/([^/?#]+)/,
    );
    if (ccMatch) {
      const regionMatch = url.match(/region=([\w-]+)/) || url.match(/^https:\/\/([\w-]+)\.console/);
      const region = regionMatch?.[1] || 'us-east-1';
      return `https://git-codecommit.${region}.amazonaws.com/v1/repos/${ccMatch[1]}`;
    }

    const ghMatch = url.match(/github\.com\/([^/?#]+\/[^/?#]+?)(?:\/(?:tree|blob|commit|pull|issues).*)?$/);
    if (ghMatch) {
      return `https://github.com/${ghMatch[1].replace(/\.git$/, '')}.git`;
    }

    const glMatch = url.match(/gitlab\.com\/([^/?#]+(?:\/[^/?#]+)+?)(?:\/-\/.*)?$/);
    if (glMatch) {
      return `https://gitlab.com/${glMatch[1].replace(/\.git$/, '')}.git`;
    }

    const bbMatch = url.match(/bitbucket\.org\/([^/?#]+\/[^/?#]+?)(?:\/(?:src|commits|pull-requests).*)?$/);
    if (bbMatch) {
      return `https://bitbucket.org/${bbMatch[1].replace(/\.git$/, '')}.git`;
    }

    if (url.includes('?') && !url.includes('.git')) {
      return url.split('?')[0];
    }

    return url;
  }

  private extractRepoName(url: string): string {
    const cleaned = url.replace(/\.git\s*$/, '').replace(/\/+$/, '');
    const parts = cleaned.split('/');
    return parts[parts.length - 1] || 'repo';
  }
}
