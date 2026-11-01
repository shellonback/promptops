import { Injectable, inject } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { of } from 'rxjs';
import { map, mergeMap, switchMap, catchError, tap } from 'rxjs/operators';
import { clearSessions } from '../sessions/session.actions';
import { clearWorkspacesCache, writeWorkspacesCache } from './workspace.state';
import { clearSidebarFoldersCache } from '../../app/views/admin-core/sessions/services/sidebar-folders.service';
import {
  loadWorkspaces,
  loadWorkspacesSuccess,
  loadWorkspacesFailure,
  createWorkspace,
  createWorkspaceSuccess,
  createWorkspaceFailure,
  updateWorkspace,
  updateWorkspaceSuccess,
  deleteWorkspace,
  deleteWorkspaceSuccess,
} from './workspace.actions';
import { WorkspaceApiService } from '../../app/views/admin-core/sessions/services/workspace-api.service';

@Injectable()
export class WorkspaceEffects {
  private actions$ = inject(Actions);
  private apiService = inject(WorkspaceApiService);

  loadWorkspaces$ = createEffect(() =>
    this.actions$.pipe(
      ofType(loadWorkspaces),
      switchMap(() =>
        // fetchList, not list: on a network failure the reducer keeps the
        // hydrated/previous workspaces and the cache is not overwritten with [].
        this.apiService.fetchList().pipe(
          tap((workspaces) => writeWorkspacesCache(workspaces)),
          map((workspaces) => loadWorkspacesSuccess({ workspaces })),
          catchError((err) => of(loadWorkspacesFailure({ error: err.message }))),
        ),
      ),
    ),
  );

  createWorkspace$ = createEffect(() =>
    this.actions$.pipe(
      ofType(createWorkspace),
      mergeMap(({ name, projectPath }) =>
        this.apiService.findOrCreate({ name, project_path: projectPath }).pipe(
          map((workspace) => {
            if (!workspace) {
              return createWorkspaceFailure({ error: 'Failed to create workspace' });
            }
            return createWorkspaceSuccess({ workspace });
          }),
          catchError((err) => of(createWorkspaceFailure({ error: err.message }))),
        ),
      ),
    ),
  );

  updateWorkspace$ = createEffect(() =>
    this.actions$.pipe(
      ofType(updateWorkspace),
      mergeMap(({ workspaceId, name }) =>
        this.apiService.update(workspaceId, { name }).pipe(
          map((workspace) => {
            if (!workspace) {
              return { type: '[Workspaces] Update Workspace Failure' };
            }
            return updateWorkspaceSuccess({ workspace });
          }),
          catchError(() => of({ type: '[Workspaces] Update Workspace Failure' })),
        ),
      ),
    ),
  );

  deleteWorkspace$ = createEffect(() =>
    this.actions$.pipe(
      ofType(deleteWorkspace),
      // mergeMap: deleting two workspaces in a row deletes both.
      mergeMap(({ workspaceId }) =>
        this.apiService.destroy(workspaceId).pipe(
          // Not deleted (destroy() reports false): reload the list so the
          // sidebar shows what is stored, instead of hiding a workspace that
          // comes back at the next start.
          map((deleted) => (deleted ? deleteWorkspaceSuccess({ workspaceId }) : loadWorkspaces())),
          catchError(() => of(loadWorkspaces())),
        ),
      ),
    ),
  );

  // Logout empties the sessions store (clearSessions) — drop the workspaces
  // cache with it so the next login doesn't paint another account's list.
  clearWorkspacesCache$ = createEffect(
    () => this.actions$.pipe(
      ofType(clearSessions),
      tap(() => {
        clearWorkspacesCache();
        clearSidebarFoldersCache();
      }),
    ),
    { dispatch: false },
  );
}
