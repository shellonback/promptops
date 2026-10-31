import { TestBed } from '@angular/core/testing';
import { provideMockActions } from '@ngrx/effects/testing';
import { Observable, of, throwError, firstValueFrom } from 'rxjs';
import { Action } from '@ngrx/store';
import { WorkspaceEffects } from './workspace.effects';
import { loadWorkspaces, loadWorkspacesFailure, loadWorkspacesSuccess } from './workspace.actions';
import { workspacesReducer } from './workspace.reducer';
import { initialWorkspacesState, readWorkspacesCache, WorkspaceSummary, writeWorkspacesCache } from './workspace.state';
import { WorkspaceApiService } from '../../app/views/admin-core/sessions/services/workspace-api.service';

const ws: WorkspaceSummary = {
  id: 'ws-1',
  name: 'Repo',
  projectPath: '/tmp/repo',
  activeSessionsCount: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('WorkspaceEffects loadWorkspaces offline', () => {
  let actions$: Observable<Action>;
  let fetchList: jasmine.Spy;
  let savedCache: string | null;

  beforeEach(() => {
    savedCache = localStorage.getItem('promptops_workspaces_cache_v1');
    fetchList = jasmine.createSpy('fetchList');
    TestBed.configureTestingModule({
      providers: [
        WorkspaceEffects,
        provideMockActions(() => actions$),
        { provide: WorkspaceApiService, useValue: { fetchList } },
      ],
    });
  });

  afterEach(() => {
    if (savedCache === null) localStorage.removeItem('promptops_workspaces_cache_v1');
    else localStorage.setItem('promptops_workspaces_cache_v1', savedCache);
  });

  it('fails instead of loading an empty list, and leaves the cache alone', async () => {
    writeWorkspacesCache([ws]);
    fetchList.and.returnValue(throwError(() => new Error('offline')));
    actions$ = of(loadWorkspaces());
    const action = await firstValueFrom(TestBed.inject(WorkspaceEffects).loadWorkspaces$);
    expect(action.type).toBe(loadWorkspacesFailure.type);
    expect(readWorkspacesCache()).toEqual([ws]);
  });

  it('refreshes the cache on success', async () => {
    writeWorkspacesCache([]);
    fetchList.and.returnValue(of([ws]));
    actions$ = of(loadWorkspaces());
    const action = await firstValueFrom(TestBed.inject(WorkspaceEffects).loadWorkspaces$);
    expect(action).toEqual(loadWorkspacesSuccess({ workspaces: [ws] }));
    expect(readWorkspacesCache()).toEqual([ws]);
  });

  it('the reducer keeps the workspaces it had on a failure', () => {
    const state = { ...initialWorkspacesState, workspaces: [ws] };
    const next = workspacesReducer(state, loadWorkspacesFailure({ error: 'offline' }));
    expect(next.workspaces).toEqual([ws]);
  });
});
