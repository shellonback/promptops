import { Injectable, inject, Injector } from '@angular/core';
import { Observable, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { DataBackend, call$, scoped$ } from '@core/data/data-backend';
import { WorkspaceSummary } from '@/store/workspaces/workspace.state';

export interface WorkspaceDto {
  id: string;
  name: string;
  project_path: string;
  active_sessions_count?: number;
  team_id?: number | null;
  team?: { id: number; name: string } | null;
  project_id?: number | null;
  project?: { id: number; name: string } | null;
  created_at: string;
  updated_at: string;
}

/** Workspaces (project folders that group sessions), kept on this device. */
@Injectable({ providedIn: 'root' })
export class WorkspaceApiService {
  private data = inject(DataBackend);
  private injector = inject(Injector);

  /**
   * Workspaces of the active profile. Propagates errors: resolving [] on a
   * transient failure made the store (and its start-up cache) forget every
   * workspace; the load effect keeps the current list on failure instead.
   */
  list(): Observable<WorkspaceSummary[]> {
    return this.fetchList();
  }

  /** Same as list(): kept for the store load, which keeps the cached workspaces on failure. */
  fetchList(): Observable<WorkspaceSummary[]> {
    return scoped$<WorkspaceDto[]>(this.data, this.injector, 'workspaces.list').pipe(
      map((list) => (list ?? []).map((dto) => this.toSummary(dto))),
    );
  }

  create(data: { name: string; project_path: string }): Observable<WorkspaceSummary | null> {
    return scoped$<WorkspaceDto>(this.data, this.injector, 'workspaces.create', data).pipe(
      map((dto) => this.toSummary(dto)),
      catchError(() => of(null)),
    );
  }

  findOrCreate(data: { project_path: string; name?: string }): Observable<WorkspaceSummary | null> {
    return scoped$<WorkspaceDto>(this.data, this.injector, 'workspaces.findOrCreate', data).pipe(
      map((dto) => this.toSummary(dto)),
      catchError(() => of(null)),
    );
  }

  update(id: string, data: { name?: string; team_id?: number | null; project_id?: number | null }): Observable<WorkspaceSummary | null> {
    return call$<WorkspaceDto>(this.data, 'workspaces.update', { ...data, id }).pipe(
      map((dto) => this.toSummary(dto)),
      catchError(() => of(null)),
    );
  }

  destroy(id: string): Observable<boolean> {
    return call$(this.data, 'workspaces.delete', { id }).pipe(
      map(() => true),
      catchError(() => of(false)),
    );
  }

  private toSummary(dto: WorkspaceDto): WorkspaceSummary {
    return {
      id: dto.id,
      name: dto.name,
      projectPath: dto.project_path,
      activeSessionsCount: dto.active_sessions_count ?? 0,
      teamId: dto.team_id ?? dto.team?.id ?? null,
      teamName: dto.team?.name ?? null,
      projectId: dto.project_id ?? dto.project?.id ?? null,
      projectName: dto.project?.name ?? null,
      createdAt: dto.created_at,
      updatedAt: dto.updated_at,
    };
  }
}
