import { mergeLiveWithSaved } from './session-merge';
import { SessionSummary } from './session.state';

function session(id: string, name: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    name,
    provider: 'generic-shell' as SessionSummary['provider'],
    status: 'idle' as SessionSummary['status'],
    workspaceId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    pendingInteractionCount: 0,
    ...extra,
  };
}

describe('mergeLiveWithSaved', () => {
  it('online: takes the backend row id as dbId', () => {
    const live = [session('local-1', 'A', { dbId: 'db-1' })];
    const saved = [session('db-1', 'A', { workspaceId: 'ws-1' })];
    const merged = mergeLiveWithSaved(live, saved, true);
    expect(merged.length).toBe(1);
    expect(merged[0].id).toBe('local-1');
    expect(merged[0].dbId).toBe('db-1');
    expect(merged[0].workspaceId).toBe('ws-1');
  });

  it('offline: against the boot cache it keeps the backend dbId, not the local id', () => {
    const live = [session('local-2', 'A', { dbId: 'db-1' })];
    // Boot cache = previous merged list: local id in `id`, backend id in `dbId`.
    const cache = [session('local-1', 'A', { dbId: 'db-1', workspaceId: 'ws-1' })];
    const merged = mergeLiveWithSaved(live, cache, true);
    expect(merged.length).toBe(1);
    expect(merged[0].id).toBe('local-2');
    expect(merged[0].dbId).toBe('db-1');
    expect(merged[0].workspaceId).toBe('ws-1');
  });

  it('offline: a renamed live session is not duplicated by its cached row', () => {
    const live = [session('local-2', 'Renamed', { dbId: 'db-1' })];
    const cache = [session('local-1', 'Old name', { dbId: 'db-1' })];
    const merged = mergeLiveWithSaved(live, cache, true);
    expect(merged.map((s) => s.id)).toEqual(['local-2']);
    expect(merged[0].dbId).toBe('db-1');
  });

  it('keeps cached sessions that have no live counterpart', () => {
    const live = [session('local-2', 'A', { dbId: 'db-1' })];
    const cache = [session('local-1', 'A', { dbId: 'db-1' }), session('db-2', 'Parked')];
    const merged = mergeLiveWithSaved(live, cache, true);
    expect(merged.map((s) => s.id)).toEqual(['local-2', 'db-2']);
  });

  it('Electron (byDbId false) merges by name only', () => {
    const live = [session('local-1', 'A', { dbId: 'db-x' })];
    const saved = [session('db-1', 'A', { workspaceId: 'ws-1' })];
    const merged = mergeLiveWithSaved(live, saved, false);
    expect(merged.length).toBe(1);
    expect(merged[0].dbId).toBe('db-1');
    expect(merged[0].createdAt).toBe(live[0].createdAt);
  });
});
