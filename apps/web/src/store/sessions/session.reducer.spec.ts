import { sessionsReducer } from './session.reducer';
import { loadSessionsSuccess } from './session.actions';
import { initialSessionsState, SessionSummary, SessionsState } from './session.state';

function session(id: string, name: string, workspaceId: string | null = 'ws-1'): SessionSummary {
  return {
    id,
    name,
    provider: 'generic-shell' as SessionSummary['provider'],
    status: 'idle' as SessionSummary['status'],
    workspaceId,
    createdAt: '2026-01-01T00:00:00Z',
    pendingInteractionCount: 0,
  };
}

function stateWith(sessions: SessionSummary[], activeSessionId: string | null): SessionsState {
  return { ...initialSessionsState, sessions, activeSessionId };
}

describe('sessionsReducer loadSessionsSuccess', () => {
  it('follows the active session when the refreshed list gives it a new id', () => {
    const state = stateWith([session('old-id', 'QA session'), session('other', 'Other')], 'old-id');
    const next = sessionsReducer(state, loadSessionsSuccess({ sessions: [session('new-id', 'QA session'), session('other', 'Other')] }));
    expect(next.activeSessionId).toBe('new-id');
  });

  it('keeps the active id when it is still in the list', () => {
    const state = stateWith([session('a', 'A'), session('b', 'B')], 'b');
    const next = sessionsReducer(state, loadSessionsSuccess({ sessions: [session('a', 'A'), session('b', 'B'), session('c', 'C')] }));
    expect(next.activeSessionId).toBe('b');
  });

  it('prefers the session with the same name in the same workspace', () => {
    const state = stateWith([session('old-id', 'main', 'ws-2')], 'old-id');
    const next = sessionsReducer(state, loadSessionsSuccess({ sessions: [session('x', 'main', 'ws-1'), session('y', 'main', 'ws-2')] }));
    expect(next.activeSessionId).toBe('y');
  });

  it('does not guess between several sessions with the same name elsewhere', () => {
    const state = stateWith([session('old-id', 'main', 'ws-3')], 'old-id');
    const next = sessionsReducer(state, loadSessionsSuccess({ sessions: [session('x', 'main', 'ws-1'), session('y', 'main', 'ws-2')] }));
    expect(next.activeSessionId).toBe('old-id');
  });
});

describe('sessionsReducer loadSessionsSuccess layoutMode', () => {
  it('keeps the layout mode a poll does not carry, and keeps the same array', () => {
    const prev = { ...session('a', 'A'), layoutMode: 'code' as const };
    const state = stateWith([prev], 'a');
    const next = sessionsReducer(state, loadSessionsSuccess({ sessions: [session('a', 'A')] }));
    expect(next.sessions[0].layoutMode).toBe('code');
    expect(next.sessions).toBe(state.sessions);
  });

  it('takes the saved layout from the view state when the store has none', () => {
    const state = stateWith([], null);
    const polled = { ...session('a', 'A'), viewState: { layoutMode: 'code' } as any };
    const next = sessionsReducer(state, loadSessionsSuccess({ sessions: [polled] }));
    expect(next.sessions[0].layoutMode).toBe('code');
  });
});

describe('sessionsReducer loadSessionsSuccess folder relink', () => {
  const bound = (path: string, status: 'configured' | 'invalid_path'): SessionSummary => ({
    ...session('a', 'A'),
    workspace: { path, name: path.split('/').pop()! },
    deviceWorkspace: { id: '', localPath: path, status, updatedAt: '2026-01-01T00:00:00Z' },
  });

  it('takes the new folder after a relink, dropping the invalid path state', () => {
    const state = stateWith([bound('/home/user/old', 'invalid_path')], 'a');
    const next = sessionsReducer(state, loadSessionsSuccess({ sessions: [bound('/home/user/new', 'configured')] }));
    expect(next.sessions[0].workspace?.path).toBe('/home/user/new');
    expect(next.sessions[0].deviceWorkspace?.status).toBe('configured');
  });

  it('keeps the same array when only the validity status differs (same folder)', () => {
    const state = stateWith([bound('/home/user/old', 'invalid_path')], 'a');
    const next = sessionsReducer(state, loadSessionsSuccess({ sessions: [bound('/home/user/old', 'configured')] }));
    expect(next.sessions).toBe(state.sessions);
  });
});
