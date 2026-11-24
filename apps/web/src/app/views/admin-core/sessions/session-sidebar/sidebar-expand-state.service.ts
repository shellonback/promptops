import { Injectable, signal } from '@angular/core';
import { applyManualToggle, isExpanded, parseIdSet } from './workspace-expand-state';

const WORKSPACE_KEY = 'promptops_workspace_expanded';
const AUTO_KEY = 'promptops_workspace_autocollapsed';
const FOLDER_KEY = 'promptops_folder_expanded';

/**
 * Open/closed state of the folders and workspaces in the sessions sidebar, shared with whoever shows the
 * same groups (Agents Dashboard): opening or closing on one side applies to the other too. Same
 * localStorage keys as always, so previously saved state stays valid.
 */
@Injectable({ providedIn: 'root' })
export class SidebarExpandStateService {
  readonly workspaces = signal<Map<string, boolean>>(loadMap(WORKSPACE_KEY));
  readonly folders = signal<Map<string, boolean>>(loadMap(FOLDER_KEY));
  /** Workspaces closed by the auto-collapse (not by the user): the only ones a wake may reopen. */
  auto: Set<string> = load(() => parseIdSet(localStorage.getItem(AUTO_KEY)), new Set<string>());

  isWorkspaceOpen(id: string): boolean {
    return isExpanded(this.workspaces(), id);
  }

  isFolderOpen(id: string): boolean {
    return this.folders().get(id) ?? true;
  }

  /** Manual choice: from now on the workspace state belongs to the user, never touched by a wake again. */
  toggleWorkspace(id: string): void {
    const next = applyManualToggle({ expanded: this.workspaces(), auto: this.auto }, id);
    this.auto = next.auto;
    this.workspaces.set(next.expanded);
    saveMap(WORKSPACE_KEY, next.expanded);
    save(AUTO_KEY, JSON.stringify([...next.auto]));
  }

  setWorkspaceOpen(id: string, open: boolean): void {
    if (this.isWorkspaceOpen(id) !== open) this.toggleWorkspace(id);
  }

  toggleFolder(id: string): void {
    const next = new Map(this.folders());
    next.set(id, !this.isFolderOpen(id));
    this.folders.set(next);
    saveMap(FOLDER_KEY, next);
  }

  setFolderOpen(id: string, open: boolean): void {
    if (this.isFolderOpen(id) !== open) this.toggleFolder(id);
  }
}

function load<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

function loadMap(key: string): Map<string, boolean> {
  return load(() => {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    const map = new Map<string, boolean>();
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'boolean') map.set(k, v);
    }
    return map;
  }, new Map<string, boolean>());
}

function saveMap(key: string, map: Map<string, boolean>): void {
  save(key, JSON.stringify(Object.fromEntries(map)));
}

function save(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* localStorage unavailable: stays in memory */ }
}
