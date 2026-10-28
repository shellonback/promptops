import { applyManualToggle, applyParkTransitions, isExpanded, parseIdSet, WorkspaceExpandState } from './workspace-expand-state';

describe('workspace expand state', () => {
  const empty = (): WorkspaceExpandState => ({ expanded: new Map(), auto: new Set() });
  const park = (s: WorkspaceExpandState, id: string) => applyParkTransitions(s, [id], []);
  const wake = (s: WorkspaceExpandState, id: string) => applyParkTransitions(s, [], [id]);

  it('keeps a manually collapsed workspace closed across park and wake', () => {
    let s: WorkspaceExpandState = applyManualToggle(empty(), 'ws');
    s = park(s, 'ws');
    s = wake(s, 'ws');
    expect(isExpanded(s.expanded, 'ws')).toBeFalse();
  });

  it('reopens on wake only what park closed automatically', () => {
    let s: WorkspaceExpandState = park(empty(), 'ws');
    expect(isExpanded(s.expanded, 'ws')).toBeFalse();
    expect(s.auto.has('ws')).toBeTrue();
    s = wake(s, 'ws');
    expect(isExpanded(s.expanded, 'ws')).toBeTrue();
    expect(s.auto.has('ws')).toBeFalse();
  });

  it('a manual toggle after an auto-collapse wins over the next wake', () => {
    let s: WorkspaceExpandState = park(empty(), 'ws');
    s = applyManualToggle(s, 'ws'); // opened by hand
    s = applyManualToggle(s, 'ws'); // closed again by hand
    s = wake(s, 'ws');
    expect(isExpanded(s.expanded, 'ws')).toBeFalse();
  });

  it('never opens a workspace on wake when nothing was auto-collapsed', () => {
    const s = wake(applyManualToggle(empty(), 'ws'), 'ws');
    expect(s.changed).toBeFalse();
  });

  it('reports no change for redundant transitions', () => {
    const closed = park(empty(), 'ws');
    expect(park(closed, 'ws').changed).toBeFalse();
    expect(wake(empty(), 'ws').changed).toBeFalse();
  });

  it('does not mutate the input state', () => {
    const s = empty();
    park(s, 'ws');
    applyManualToggle(s, 'ws');
    expect(s.expanded.size).toBe(0);
    expect(s.auto.size).toBe(0);
  });

  it('round-trips the auto set through storage and tolerates garbage', () => {
    const s = park(empty(), 'ws');
    expect(parseIdSet(JSON.stringify([...s.auto]))).toEqual(new Set(['ws']));
    expect(parseIdSet(null).size).toBe(0);
    expect(parseIdSet('{bad').size).toBe(0);
    expect(parseIdSet('{"ws":true}').size).toBe(0);
    expect(parseIdSet('["a",1,null]')).toEqual(new Set(['a']));
  });
});
