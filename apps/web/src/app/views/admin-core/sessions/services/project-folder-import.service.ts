import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { WorkspaceApiService } from './workspace-api.service';
import { SidebarFoldersService } from './sidebar-folders.service';
import { SidebarFolderApiService } from './sidebar-folder-api.service';

export interface ScannedProject {
  name: string;
  path: string;
  /** "git" or the manifest file that marked it as a project (package.json, …). */
  marker: string;
}

export interface ProjectFolderScan {
  root: string;
  rootName: string;
  /** Set when the root folder is itself a project. */
  rootMarker: string | null;
  projects: ScannedProject[];
}

export interface ProjectFolderImportResult {
  folderId: string | null;
  workspaces: { id: string; name: string; path: string }[];
  failed: string[];
}

type ScanBridge = {
  fsScanProjects?: (path: string) => Promise<{
    ok: boolean;
    root: string;
    rootName: string;
    rootMarker: string | null;
    projects: ScannedProject[];
    error: string | null;
  }>;
};

/**
 * "Cartella di progetti" import: a parent folder whose children are repos /
 * projects becomes a sidebar folder with one workspace per child.
 * Desktop v2 only (needs the native fs_scan_projects command).
 */
@Injectable({ providedIn: 'root' })
export class ProjectFolderImportService {
  private workspaceApi = inject(WorkspaceApiService);
  private folders = inject(SidebarFoldersService);
  private folderApi = inject(SidebarFolderApiService);

  private bridge(): ScanBridge | undefined {
    return (window as unknown as { promptops?: ScanBridge }).promptops;
  }

  get supported(): boolean {
    return typeof this.bridge()?.fsScanProjects === 'function';
  }

  /** Immediate children of `path` that look like projects. Null when unsupported/failed. */
  async scan(path: string): Promise<ProjectFolderScan | null> {
    const fn = this.bridge()?.fsScanProjects;
    if (!fn || !path || /^(ssh|cmd):\/\//.test(path)) return null;
    try {
      const res = await fn(path);
      if (!res?.ok) return null;
      return {
        root: res.root,
        rootName: res.rootName,
        rootMarker: res.rootMarker ?? null,
        projects: res.projects ?? [],
      };
    } catch {
      return null;
    }
  }

  /**
   * True when the folder should be offered as a multi-project import: it is not
   * a project itself and contains at least two projects.
   */
  isProjectContainer(scan: ProjectFolderScan | null): scan is ProjectFolderScan {
    return !!scan && !scan.rootMarker && scan.projects.length >= 2;
  }

  /**
   * Creates (or reuses, by name) the sidebar folder, then find-or-creates a
   * workspace per project and files it in the folder. Existing workspaces are
   * reused and just moved into the folder — never duplicated.
   */
  async import(folderName: string, projects: ScannedProject[]): Promise<ProjectFolderImportResult> {
    const name = folderName.trim();
    let folderId: string | null = null;
    if (name) {
      const existing = this.folders.folders().find((f) => f.name.trim().toLowerCase() === name.toLowerCase());
      folderId = existing?.id ?? (await this.folders.createFolder(name))?.id ?? null;
    }

    const workspaces: ProjectFolderImportResult['workspaces'] = [];
    const failed: string[] = [];
    for (const p of projects) {
      const ws = await firstValueFrom(this.workspaceApi.findOrCreate({ project_path: p.path, name: p.name }));
      if (!ws) {
        failed.push(p.name);
        continue;
      }
      workspaces.push({ id: ws.id, name: ws.name, path: ws.projectPath ?? p.path });
    }
    if (folderId && workspaces.length) {
      try {
        await firstValueFrom(this.folderApi.assign({ folderId, workspaceIds: workspaces.map((w) => w.id) }));
      } catch {
        /* workspaces exist anyway; they just stay outside the folder */
      }
      await this.folders.load();
    }
    return { folderId, workspaces, failed };
  }
}
