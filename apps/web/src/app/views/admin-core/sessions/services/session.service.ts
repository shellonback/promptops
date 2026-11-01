import { Injectable, inject } from '@angular/core';
import { OrgPolicyService } from '@core/services/org-policy.service';
import { SessionSummary, AgentProfile } from '../../../../../store/sessions/session.state';

/**
 * Angular service wrapping the desktop bridge API (`window.promptops`) for
 * sessions, profiles, and workspaces.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private orgPolicy = inject(OrgPolicyService);
  private get api(): any {
    const api = (window as any).promptops;
    if (!api) throw new Error('Not running inside the desktop app');
    return api;
  }

  get isDesktop(): boolean {
    return !!(window as any).promptops;
  }

  /** True in the Tauri v2 desktop app (the bridge also sets `promptops`). */
  get isTauri(): boolean {
    return !!(window as any).__TAURI__;
  }

  // ── Provider check ──────────────────────────────────────────────────

  checkProvider(provider: string, force = false, sessionId?: string): Promise<{ installed: boolean; platform: string; command: string; provider: string }> {
    return this.api.checkProvider(provider, force, sessionId);
  }

  // ── Windows terminal shells (PowerShell / pwsh / cmd / Git Bash / WSL) ──

  /** True only in the desktop app on Windows. */
  get isWindowsDesktop(): boolean {
    return this.isDesktop && (window as any).promptops?.platform === 'win32';
  }

  listTerminalShells(force = false): Promise<{ ok: boolean; shells: Array<{ id: string; kind: string; label: string; distro?: string }> }> {
    return this.api.listTerminalShells({ force });
  }

  /** On-demand probe: is the provider's CLI installed inside each detected shell? */
  probeProviderInShells(provider: string): Promise<{ ok: boolean; provider: string; command: string | null; results: Array<{ shellId: string; installed: boolean }> }> {
    return this.api.probeProviderInShells(provider);
  }

  // ── Sessions ─���─────────────��────────────────────────────────���──────

  createSession(request: { name?: string; provider: string; config?: Record<string, unknown>; workspaceId?: string | null }): Promise<{ ok: boolean; session?: SessionSummary; error?: string }> {
    // Organization policy (Enterprise) is checked at the single spawn chokepoint.
    if (!this.orgPolicy.isProviderAllowed(request.provider)) {
      return Promise.resolve({ ok: false, error: this.orgPolicy.deniedMessage(request.provider) });
    }
    if (!this.orgPolicy.autoApproveAllowed() && request.config?.['autoApprove']) {
      request = { ...request, config: { ...request.config, autoApprove: false } };
    }
    return this.api.createSession(request);
  }

  destroySession(sessionId: string): Promise<{ ok: boolean }> {
    return this.api.destroySession(sessionId);
  }

  /** Park a session: kill its provider process, keep the record. */
  standbySession(sessionId: string): Promise<{ ok: boolean; session?: SessionSummary; error?: string }> {
    return this.api.standbySession(sessionId);
  }

  /**
   * Wake a parked session: re-spawn its provider with --resume. The optional
   * stash is the localStorage snapshot of the session's parked sub-agents —
   * main respawns them after the wake (post-restart resume path). `dims` are
   * the current xterm cols/rows so the new PTY spawns at the right grid.
   */
  wakeSession(sessionId: string, parkedSubAgents?: unknown[], dims?: { cols: number; rows: number }): Promise<{ ok: boolean; session?: SessionSummary; error?: string }> {
    return this.api.wakeSession(sessionId, parkedSubAgents, dims);
  }

  listSessions(): Promise<SessionSummary[]> {
    return this.api.listSessions();
  }

  getSession(sessionId: string): Promise<any> {
    return this.api.getSession(sessionId);
  }

  writeSession(sessionId: string, data: string, opts?: { countPrompt?: boolean }): Promise<{ ok: boolean }> {
    return this.api.writeSession(sessionId, data, opts);
  }

  /**
   * Sends /compact to a Claude session. In the desktop app the request is flagged first so
   * the compaction that follows is measured as a PromptOps saving.
   * With `subAgentId` the command goes to that agent's PTY; the saving stays
   * on the parent, where the agent's metrics are attributed.
   * Resolves false when the terminal refused the write (parked / no live PTY).
   */
  async compactSession(sessionId: string, subAgentId?: string): Promise<boolean> {
    try { await this.api.requestTokenCompact?.(sessionId); } catch { /* older bridge: still compact */ }
    const write = (data: string): Promise<{ ok?: boolean } | undefined> => subAgentId
      ? this.api.writeSubAgent(subAgentId, data)
      : this.writeSession(sessionId, data, { countPrompt: false });
    try {
      const res = await write('/compact');
      if (res?.ok === false) return false;
    } catch {
      return false;
    }
    // Text then Enter as separate writes: the TUI treats a single chunk as a paste.
    setTimeout(() => { write('\r').catch(() => {}); }, 120);
    return true;
  }

  resizeSession(sessionId: string, cols: number, rows: number): Promise<{ ok: boolean }> {
    return this.api.resizeSession(sessionId, cols, rows);
  }

  /** `vtSnapshot`: the bytes are the host's VT screen picture (exact), not the raw PTY tail. */
  getSessionBuffer(sessionId: string): Promise<{ ok: boolean; data: string; bytes?: Uint8Array; endOffset?: number; vtSnapshot?: boolean; cols?: number; rows?: number }> {
    return this.api.getSessionBuffer(sessionId);
  }

  renameSession(sessionId: string, name: string): Promise<{ ok: boolean }> {
    return this.api.renameSession(sessionId, name);
  }

  updateSessionMeta(
    sessionId: string,
    updates: {
      name?: string;
      workspaceId?: string | null;
      layoutMode?: string;
      viewState?: Record<string, unknown>;
      providerAccountId?: string | null;
      /** True = remove the account pin (follow the global active account). */
      inheritProviderAccount?: boolean;
      shell?: string | null;
    },
  ): Promise<{ ok: boolean }> {
    return this.api.updateSessionMeta(sessionId, updates);
  }

  /**
   * Workspace-wide account switch: pins the provider account on every session
   * of the workspace AND their sub-agents (same provider only). Running
   * terminals are never interrupted — the new account applies from the next
   * relaunch of each terminal. `undefined` removes the pins so the sessions
   * follow the global active account again.
   */
  applyAccountToWorkspace(
    workspaceId: string,
    provider: string,
    providerAccountId: string | null | undefined,
  ): Promise<{ ok: boolean; updatedSessionIds: string[] }> {
    return this.api.applyAccountToWorkspace({
      workspaceId,
      provider,
      providerAccountId: providerAccountId ?? null,
      inherit: providerAccountId === undefined,
    });
  }

  onSessionStatus(callback: (data: { sessionId: string; status: string }) => void): () => void {
    return this.api.onSessionStatus((_event: unknown, data: any) => callback(data));
  }

  onSessionOutput(callback: (data: { sessionId: string; data: string; bytes?: Uint8Array; endOffset?: number }) => void): () => void {
    return this.api.onSessionOutput((_event: unknown, data: any) => callback(data));
  }

  onSessionStandbyChanged(callback: (data: { sessionId: string; standbyAt: string | null }) => void): () => void {
    if (!this.isDesktop) return () => {};
    return this.api.onSessionStandbyChanged((_event: unknown, data: any) => callback(data));
  }

  // ── Profiles ───────────────────────────────────────────────────────

  listProfiles(): Promise<AgentProfile[]> {
    return this.api.listProfiles();
  }

  getProfile(profileId: string): Promise<AgentProfile> {
    return this.api.getProfile(profileId);
  }

  createProfile(data: { name: string; provider: string; config?: Record<string, unknown>; description?: string }): Promise<{ ok: boolean; profile?: AgentProfile }> {
    return this.api.createProfile(data);
  }

  updateProfile(profileId: string, updates: Record<string, unknown>): Promise<{ ok: boolean; profile?: AgentProfile }> {
    return this.api.updateProfile(profileId, updates);
  }

  deleteProfile(profileId: string): Promise<{ ok: boolean }> {
    return this.api.deleteProfile(profileId);
  }

  // ── Workspace ──────────────────────────────────────────────────────

  selectWorkspace(): Promise<{ path: string; name: string } | null> {
    return this.api.selectWorkspace();
  }

  getRecentWorkspaces(): Promise<Array<{ path: string; name: string }>> {
    return this.api.getRecentWorkspaces();
  }

  /**
   * Create a new folder inside `parentPath` and return it as a workspace.
   * Used by the "create folder" flow of the workspace pickers.
   */
  createWorkspaceFolder(
    parentPath: string,
    folderName: string,
  ): Promise<{ ok: boolean; workspace?: { path: string; name: string }; error?: string }> {
    return this.api.createWorkspaceFolder({ parentPath, folderName });
  }

  // ── Remote sessions (SSH, beta — Tauri only) ─────────────────────────

  /** True for the virtual remote cwd scheme (`ssh://<connId>/<path>`). */
  isRemotePath(path: string | null | undefined): boolean {
    return !!path && path.startsWith('ssh://');
  }

  /**
   * Saved SSH connections (redacted — no secrets). Shape-tolerant: accepts both
   * the bare array returned by the bridge and a `{ ok, connections }` wrapper.
   */
  listSshConnections(): Promise<
    Array<{ id: string; name: string; host: string; port: number; username: string; cwd?: string }>
  > {
    return this.api
      .sshList(null)
      .then((res: any) => (Array.isArray(res) ? res : (res?.connections ?? [])));
  }

  /** Upsert of a saved SSH connection (Tauri returns the redacted record). */
  saveSshConnection(input: {
    sessionId: string | null;
    name: string;
    host: string;
    port?: number;
    username: string;
    authType: 'password' | 'key';
    secret: string;
    passphrase?: string;
  }): Promise<any> {
    return this.api.sshSave(input);
  }

  remoteListDir(
    connId: string,
    path?: string,
  ): Promise<{ ok: boolean; path: string; entries: Array<{ name: string; isDir: boolean }>; error?: string }> {
    return this.api.remoteListDir(connId, path);
  }

  remoteHomeDir(connId: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    return this.api.remoteHomeDir(connId);
  }

  remoteCreateFolder(
    connId: string,
    parentPath: string,
    folderName: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    return this.api.remoteCreateFolder(connId, parentPath, folderName);
  }

  remoteTestConnection(connId: string): Promise<{ ok: boolean; error?: string }> {
    return this.api.remoteTestConnection(connId);
  }

  /**
   * Remote listing THROUGH the user's connection command
   * (`ssh host '<script>'`): the "command" transport, the preferred one.
   */
  remoteCmdListDir(
    command: string,
    path?: string,
  ): Promise<{ ok: boolean; path: string; entries: Array<{ name: string; isDir: boolean }>; error?: string }> {
    return this.api.remoteCmdListDir(command, path);
  }

  /**
   * Guided setup: connection check + host OS/arch/home/CLI detection.
   * Transport: `connId` (saved ssh) or `command` (connection command).
   */
  remoteProbe(connId: string | null, command: string | null): Promise<RemoteProbeResult> {
    return this.api.remoteProbe(connId, command);
  }

  /** The modal's mini-terminal: one line run in the remote cwd → output + new cwd. */
  remoteShellExec(
    connId: string | null,
    command: string | null,
    cwd: string,
    line: string,
  ): Promise<{ ok: boolean; output: string; cwd: string; error?: string }> {
    return this.api.remoteShellExec(connId, command, cwd, line);
  }

  remoteCmdCreateFolder(
    command: string,
    parentPath: string,
    folderName: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    return this.api.remoteCmdCreateFolder(command, parentPath, folderName);
  }

  /**
   * Detect user-curated provider context files (CLAUDE.md, AGENTS.md, …) at a
   * workspace path. `needsDecision` is true when the user must be asked
   * whether PromptOps may update them or must leave them untouched.
   */
  checkWorkspaceContextFile(path: string, provider: string): Promise<{
    ok: boolean;
    curatedFiles?: string[];
    needsDecision?: boolean;
    policy?: 'allow' | 'preserve' | null;
    error?: string;
  }> {
    if (!this.isDesktop || typeof this.api.checkWorkspaceContextFile !== 'function') {
      return Promise.resolve({ ok: false, needsDecision: false });
    }
    return this.api.checkWorkspaceContextFile({ path, provider });
  }

  /** Persist the user's decision for the workspace ('allow' | 'preserve'). */
  setWorkspaceContextPolicy(path: string, mode: 'allow' | 'preserve', files?: string[]): Promise<{ ok: boolean; error?: string }> {
    if (!this.isDesktop || typeof this.api.setWorkspaceContextPolicy !== 'function') {
      return Promise.resolve({ ok: false });
    }
    return this.api.setWorkspaceContextPolicy({ path, mode, files });
  }

  // ── Editor ───────────────────────────────────────────────────────

  detectEditors(): Promise<{ ok: boolean; editors: Array<{ id: string; name: string; command: string; icon: string; available: boolean }> }> {
    return this.api.detectEditors();
  }

  openInEditor(editorCommand: string, cwd: string): Promise<{ ok: boolean; error?: string }> {
    return this.api.openInEditor(editorCommand, cwd);
  }

  // ── Raw terminal (for provider install) ────────────────────────────

  openTerminal(options?: { cols?: number; rows?: number; sessionId?: string }): Promise<{ ok: boolean; terminalId?: string }> {
    return this.api.openTerminal(options);
  }

  writeTerminal(terminalId: string, data: string): Promise<{ ok: boolean }> {
    return this.api.writeTerminal(terminalId, data);
  }

  closeTerminal(terminalId: string): Promise<{ ok: boolean }> {
    return this.api.closeTerminal(terminalId);
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<{ ok: boolean }> {
    return this.api.resizeTerminal(terminalId, cols, rows);
  }

  onTerminalOutput(callback: (data: { terminalId: string; data: string }) => void): () => void {
    return this.api.onTerminalOutput((_event: unknown, data: any) => callback(data));
  }

  // ── Shell utilities ──────────────────────────────────────────────

  showInFolder(folderPath: string): Promise<{ ok: boolean; error?: string }> {
    return this.api.showInFolder(folderPath);
  }

  openTerminalInFolder(cwd: string): Promise<{ ok: boolean; error?: string }> {
    return this.api.openTerminalInFolder(cwd);
  }

  /**
   * The bridge resolves with `undefined` (the Rust command is a
   * `Result<(), String>`). We normalize here so callers can always check
   * `.ok`; an object result is passed through unchanged.
   */
  async clipboardWrite(text: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.api.clipboardWrite(text);
      if (res && typeof res === 'object') return res;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
  }

  /**
   * Writes the provider auto-installer script to the app cache dir and returns
   * its path (macOS/Linux only). null when unsupported (Windows) or on
   * failure: the caller falls back to typing the script.
   */
  async installerWriteScript(content: string): Promise<string | null> {
    try {
      const fn = (window as any).promptops?.installerWriteScript;
      if (!fn) return null;
      const res = await fn(content);
      return typeof res?.path === 'string' && res.path ? res.path : null;
    } catch {
      return null;
    }
  }

  /**
   * The bridge resolves with the **bare string** of the Rust command. Without this normalization the terminals read
   * `res.text === undefined` and under Tauri paste always pastes empty.
   */
  async clipboardRead(): Promise<{ ok: boolean; text?: string; error?: string }> {
    try {
      const res = await this.api.clipboardRead();
      if (typeof res === 'string') return { ok: true, text: res };
      if (res && typeof res === 'object') return res;
      return { ok: false, text: '' };
    } catch (err) {
      return { ok: false, text: '', error: (err as Error)?.message ?? String(err) };
    }
  }

  // ── Device Workspaces ──────────────────────────────────────────────

  getDeviceWorkspace(sessionId: string): Promise<{ ok: boolean; deviceWorkspace?: any }> {
    return this.api.getDeviceWorkspace(sessionId);
  }

  listDeviceWorkspaces(): Promise<{ ok: boolean; deviceWorkspaces?: any[] }> {
    return this.api.listDeviceWorkspaces();
  }

  upsertDeviceWorkspace(sessionId: string, localPath: string): Promise<{ ok: boolean; deviceWorkspace?: any }> {
    return this.api.upsertDeviceWorkspace(sessionId, localPath);
  }

  updateDeviceWorkspace(id: string, localPath: string): Promise<{ ok: boolean; deviceWorkspace?: any }> {
    return this.api.updateDeviceWorkspace(id, localPath);
  }

  deleteDeviceWorkspace(id: string): Promise<{ ok: boolean }> {
    return this.api.deleteDeviceWorkspace(id);
  }

  migrateDeviceWorkspaces(): Promise<{ ok: boolean; migrated?: number; total?: number }> {
    return this.api.migrateDeviceWorkspaces();
  }

  validateWorkspacePath(localPath: string): Promise<{ ok: boolean; valid: boolean }> {
    return this.api.validateWorkspacePath(localPath);
  }

  // ── Git ──────────────────────────────────────────────────────────

  gitClone(url: string, destination: string, branch?: string): Promise<{ ok: boolean; output?: string; path?: string; error?: string }> {
    return this.api.gitClone(url, destination, branch);
  }

  // ── Claude Hooks ──────────────────────────────────────────────────

  onHookEvent(callback: (data: any) => void): () => void {
    if (!this.isDesktop) return () => {};
    return this.api.onHookEvent((_event: unknown, data: any) => callback(data));
  }

  onNavigateSession(callback: (sessionId: string) => void): () => void {
    if (!this.isDesktop) return () => {};
    return this.api.onNavigateSession((_event: unknown, sessionId: string) => callback(sessionId));
  }

  onTailerAutoApproveDisabled(
    callback: (data: { sessionId: string; sessionName: string; reason: string; matchedLine: string }) => void,
  ): () => void {
    if (!this.isDesktop || !this.api.onTailerAutoApproveDisabled) return () => {};
    return this.api.onTailerAutoApproveDisabled((_event: unknown, data: any) => callback(data));
  }

  /** Sub-agent resume rejected by the CLI (Tauri v2 only). Restores remain stopped. */
  onSubAgentResumeFallback(
    callback: (data: { subAgentId: string; parentSessionId: string; title: string; keptId: boolean; restarted?: boolean }) => void,
  ): () => void {
    if (!this.isDesktop || !this.api.onSubAgentResumeFallback) return () => {};
    return this.api.onSubAgentResumeFallback((_event: unknown, data: any) => callback(data));
  }

  // ── Token Efficiency ──────────────────────────────────────────────

  getTokenStats(sessionId: string): Promise<any> {
    return this.api.getTokenStats(sessionId);
  }

  getAllTokenStats(): Promise<Record<string, any>> {
    return this.api.getAllTokenStats();
  }

  recordTokenUsage(sessionId: string, data: { inputTokens: number; outputTokens: number; totalTokens: number; provider: string }): Promise<{ ok: boolean; record?: any }> {
    return this.api.recordTokenUsage(sessionId, data);
  }

  setTokenFlags(sessionId: string, flags: Record<string, boolean>): Promise<{ ok: boolean }> {
    return this.api.setTokenFlags(sessionId, flags);
  }

  onTokenUsageUpdated(callback: (data: { sessionId: string; stats: any }) => void): () => void {
    if (!this.isDesktop) return () => {};
    return this.api.onTokenUsageUpdated((_event: unknown, data: any) => callback(data));
  }

  onTokenContextPressure(callback: (data: { sessionId: string; subAgentId?: string | null; inputTokens: number; threshold: number }) => void): () => void {
    if (!this.isDesktop || !this.api.onTokenContextPressure) return () => {};
    return this.api.onTokenContextPressure((_event: unknown, data: any) => callback(data));
  }

  // ── Desktop State (session resume after update) ────────────────

  saveDesktopState(data: { activeSessionName: string | null; subAgentsExpanded: boolean; focusedSubAgentRole: string | null }): Promise<{ ok: boolean }> {
    return this.api.saveDesktopState(data);
  }

  getDesktopState(): Promise<{ activeSessionName: string | null; subAgentsExpanded: boolean; focusedSubAgentRole: string | null; savedAt: string } | null> {
    return this.api.getDesktopState();
  }

  // ── Optimization Controls ──────────────────────────────────────

  getOptimizationStatus(sessionId: string): Promise<any> {
    return this.api.getOptimizationStatus(sessionId);
  }

  refreshOptimizationContext(sessionId: string): Promise<{ ok: boolean; contextLength?: number }> {
    return this.api.refreshOptimizationContext(sessionId);
  }

  getFileCacheStats(sessionId: string): Promise<any> {
    return this.api.getFileCacheStats(sessionId);
  }

  // ── Context Snapshot ──────────────────────────────────────────────

  async generateContextSnapshot(workspacePath: string): Promise<{ ok: boolean; snapshot?: any; filePath?: string; error?: string }> {
    try {
      const result = await this.api.generateContextSnapshot(workspacePath);
      return result;
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  getContextSnapshotStatus(workspacePath: string): Promise<{ status: string; filePath: string | null; snapshot?: any }> {
    return this.api.getContextSnapshotStatus(workspacePath);
  }

  getContextSnapshot(workspacePath: string): Promise<{ ok: boolean; snapshot?: any }> {
    return this.api.getContextSnapshot(workspacePath);
  }

  refreshContextSnapshot(workspacePath: string): Promise<{ ok: boolean; snapshot?: any; filePath?: string; error?: string }> {
    return this.api.refreshContextSnapshot(workspacePath);
  }

  onContextSnapshotProgress(callback: (data: { workspacePath: string; step: number; totalSteps: number; label: string; status: string }) => void): () => void {
    if (!this.isDesktop) return () => {};
    return this.api.onContextSnapshotProgress((_event: unknown, data: any) => callback(data));
  }

  onContextSnapshotComplete(callback: (data: { workspacePath: string; status: string }) => void): () => void {
    if (!this.isDesktop) return () => {};
    return this.api.onContextSnapshotComplete((_event: unknown, data: any) => callback(data));
  }
}

export interface RemoteProbeResult {
  ok: boolean;
  os: string;
  arch: string;
  kernel: string;
  distro: string;
  home: string;
  user: string;
  host: string;
  shell: string;
  clis: string[];
  error?: string;
}
