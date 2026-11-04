const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { firstValueFrom, Subject, of, throwError } = require('rxjs');
const dir = path.join(__dirname, '../src/app/views/admin-core/sessions');
const compile = text => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const exportsObject = {};
new Function('exports', compile(fs.readFileSync(path.join(dir, 'services/agent-display-order.ts'), 'utf8')))(exportsObject);
const { agentOrderKey, orderAgents, rememberAgentOrder } = exportsObject;
function methods(file, className, names, deps = {}) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const cls = source.statements.find(node => ts.isClassDeclaration(node) && node.name.text === className);
  const selected = names.map(name => {
    const member = cls.members.find(node => node.name?.getText(source) === name);
    assert.ok(member, name);
    return member.getText(source);
  }).join('\n');
  return new Function(...Object.keys(deps), compile(`class Fixture { ${selected} };`) + '\nreturn Fixture.prototype;')(...Object.values(deps));
}
function signal(initial) {
  let value = initial;
  return Object.assign(() => value, { set: next => { value = next; }, update: f => { value = f(value); } });
}
const agent = (id, title = id, createdAt = '2026-01-01') => ({ id, role: 'custom', title, createdAt, parentSessionId: 'p1' });
const ids = agents => agents.map(a => a.id);
test('saved agent order survives regenerated runtime IDs and changed timestamps', () => {
  const old = [agent('a', 'A'), agent('b', 'B')];
  const saved = rememberAgentOrder(old, ['b', 'a']);
  const restored = [agent('new-a', 'A', '2027'), agent('new-b', 'B', '2028')];
  assert.deepEqual(ids(orderAgents(restored, saved)), ['new-b', 'new-a']);
});
test('partial restore preserves slots for missing agents and appends new agents', () => {
  const saved = rememberAgentOrder([agent('a'), agent('b'), agent('c')], ['c', 'b', 'a']);
  const partial = rememberAgentOrder([agent('new-b', 'b')], saved);
  assert.deepEqual(partial, saved);
  assert.deepEqual(ids(orderAgents([agent('new-a', 'a'), agent('new-b', 'b'), agent('new-c', 'c'), agent('d')], partial)),
    ['new-c', 'new-b', 'new-a', 'd']);
});
test('new agents append even if their timestamps precede existing agents', () => {
  const saved = rememberAgentOrder([agent('a'), agent('b')], []);
  assert.deepEqual(ids(orderAgents([agent('c', 'c', '2000'), agent('a'), agent('b')], saved)), ['a', 'b', 'c']);
});
test('timestamp ties, stale IDs and duplicate order entries are deterministic', () => {
  assert.deepEqual(ids(orderAgents([agent('c'), agent('b'), agent('a')], ['missing', 'b', 'b'])), ['b', 'a', 'c']);
  assert.deepEqual(ids(orderAgents([agent('a'), agent('c')], [])), ids(orderAgents([agent('c'), agent('a')], [])));
});
function agentFixture() {
  const storage = new Map();
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const proto = methods('services/sub-agent.service.ts', 'SubAgentService',
    ['orderStorageKeys', 'readAgentOrder', 'rememberOrder', 'reorderSubAgents', 'trackSession'],
    { firstValueFrom, rememberAgentOrder, localStorage, BENCHED_SUB_AGENTS_KEY_PREFIX: 'bench_', console: { error() {} } });
  const fixture = Object.assign(Object.create(proto), {
    currentParentId: signal('p1'), customOrder: signal([]), activeSubAgents: signal([agent('a'), agent('b'), agent('c')]),
    allSubAgents: signal([]), orderCache: new Map(), orderWrites: new Map(),
    benchCandidateKeys: parent => ['bench_' + parent], desktopSessionApi: { updateSubAgentsOrder: () => of(undefined) },
  });
  return { fixture, storage };
}
test('every rapid drag is saved sequentially, retaining the latest visible order', async () => {
  const { fixture: f } = agentFixture();
  const pending = new Subject(); const calls = [];
  f.desktopSessionApi.updateSubAgentsOrder = (parent, order) => {
    calls.push(order); return calls.length === 1 ? pending : of(undefined);
  };
  const first = f.reorderSubAgents('p1', ['b', 'a', 'c']);
  const second = f.reorderSubAgents('p1', ['c', 'b', 'a']);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.deepEqual(f.customOrder(), ['c', 'b', 'a']);
  pending.next(undefined); pending.complete(); await Promise.all([first, second]);
  assert.deepEqual(calls, [['b', 'a', 'c'], ['c', 'b', 'a']]);
  assert.deepEqual(f.readAgentOrder('p1'), ['c', 'b', 'a'].map(id => agentOrderKey(agent(id))));
});
test('failed save after a session switch preserves both session orders', async () => {
  const { fixture: f } = agentFixture(); const pending = new Subject();
  f.desktopSessionApi.updateSubAgentsOrder = () => pending;
  const save = f.reorderSubAgents('p1', ['b', 'a']); await Promise.resolve();
  f.currentParentId.set('p2'); f.customOrder.set(['other']);
  pending.error(new Error('offline')); await save;
  assert.deepEqual(f.customOrder(), ['other']);
  assert.deepEqual(f.readAgentOrder('p1').slice(0, 2), [agentOrderKey(agent('b')), agentOrderKey(agent('a'))]);
  f.orderCache.clear();
  assert.equal(f.readAgentOrder('p1')[0], agentOrderKey(agent('b')));
});
test('reorder on an inactive parent does not replace the active parent order', async () => {
  const { fixture: f } = agentFixture(); f.customOrder.set(['b', 'a']);
  await f.reorderSubAgents('p2', ['other']);
  assert.deepEqual(f.customOrder(), ['b', 'a']);
});
function folderFixture() {
  const cache = new Map();
  const proto = methods('services/sidebar-folders.service.ts', 'SidebarFoldersService', ['load', 'cacheFolders', 'reorderFolders'],
    { firstValueFrom, FOLDERS_CACHE_KEY: 'folders', localStorage: { setItem: (k, v) => cache.set(k, v) }, console: { error() {} } });
  const f = Object.assign(Object.create(proto), {
    folders: signal([{ id: 'a' }, { id: 'b' }]), loading: signal(false), loadRevision: 0, pendingReorders: 0,
    reorderQueue: Promise.resolve(), profiles: { activeProfileId: signal('profile1') },
    api: { list: () => of([{ id: 'a' }, { id: 'b' }]), reorder: () => of(undefined) },
  });
  return { f, cache };
}
test('folder refresh begun before drag cannot overwrite optimistic order', async () => {
  const { f, cache } = folderFixture(); const stale = new Subject(); const save = new Subject();
  f.api.list = () => stale; f.api.reorder = () => save;
  const load = f.load(); const reorder = f.reorderFolders(['b', 'a']); await Promise.resolve();
  stale.next([{ id: 'a' }, { id: 'b' }]); stale.complete(); await load;
  assert.deepEqual(ids(f.folders()), ['b', 'a']);
  assert.deepEqual(ids(JSON.parse(cache.get('folders'))), ['b', 'a']);
  f.api.list = () => of([{ id: 'b' }, { id: 'a' }]);
  save.next(undefined); save.complete(); await reorder;
  assert.deepEqual(ids(f.folders()), ['b', 'a']); assert.equal(f.loading(), false);
});
test('rapid folder drags serialize and reload only after the final write', async () => {
  const { f } = folderFixture(); const pending = new Subject(); const calls = []; let loads = 0;
  f.api.reorder = order => { calls.push(order); return calls.length === 1 ? pending : of(undefined); };
  f.api.list = () => { loads++; return of([{ id: 'a' }, { id: 'b' }]); };
  const first = f.reorderFolders(['b', 'a']); const second = f.reorderFolders(['a', 'b']);
  await Promise.resolve(); assert.equal(calls.length, 1); assert.deepEqual(ids(f.folders()), ['a', 'b']);
  pending.next(undefined); pending.complete(); await Promise.all([first, second]);
  assert.deepEqual(calls, [['b', 'a'], ['a', 'b']]); assert.equal(loads, 1);
});
test('stale folder loads from an old profile are ignored', async () => {
  const { f } = folderFixture(); const old = new Subject(); f.api.list = () => old;
  const load = f.load(); f.profiles.activeProfileId.set('profile2'); f.folders.set([{ id: 'other' }]);
  old.next([{ id: 'a' }]); old.complete(); await load; assert.deepEqual(ids(f.folders()), ['other']);
});
test('invalid folder order does not write and a failed save reloads authoritative order', async () => {
  const { f } = folderFixture(); let calls = 0;
  f.api.reorder = () => { calls++; return throwError(() => new Error('offline')); };
  await f.reorderFolders(['a', 'a']); assert.equal(calls, 0);
  await f.reorderFolders(['b', 'a']); assert.equal(calls, 1);
  assert.deepEqual(ids(f.folders()), ['a', 'b']); assert.equal(f.pendingReorders, 0);
});
function computedProperty(file, className, name, instance) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const cls = source.statements.find(node => ts.isClassDeclaration(node) && node.name.text === className);
  const property = cls.members.find(node => node.name?.getText(source) === name);
  return new Function('computed', compile('const result = ' + property.initializer.getText(source)) + '; return result;')
    .call(instance, callback => callback);
}
test('workspace positions ignore API order, activity, creation of sessions and timestamp ties', () => {
  const workspaces = signal([
    { id: 'b', createdAt: '2026-02', updatedAt: '2026-04' },
    { id: 'a', createdAt: '2026-01', updatedAt: '2026-03' },
  ]);
  const sessions = signal([
    { id: 'sa', workspaceId: 'a', createdAt: '2026-03' },
    { id: 'sb', workspaceId: 'b', createdAt: '2026-04' },
  ]);
  const groups = computedProperty('session-sidebar/session-sidebar.component.ts', 'SessionSidebarComponent', 'groupedSessions',
    { workspaces, sessions, minimal: () => false });
  assert.deepEqual(groups().map(g => g.workspace.id), ['a', 'b']);
  workspaces.set(workspaces().slice().reverse());
  sessions.set([...sessions(), { id: 'sa2', workspaceId: 'a', createdAt: '2026-09' }]);
  assert.deepEqual(groups().map(g => g.workspace.id), ['a', 'b']);
  assert.deepEqual(ids(groups()[0].sessions), ['sa', 'sa2']);
  workspaces.set([{ id: 'b', createdAt: 'same' }, { id: 'a', createdAt: 'same' }]);
  assert.deepEqual(groups().map(g => g.workspace.id), ['a', 'b']);
});
test('agent grid and bench follow the same order as the numbered agent panel', () => {
  const agents = [agent('c'), agent('a'), agent('b')];
  const instance = {
    activeSubAgentsBySlot: () => agents, benchedKeys: () => ['custom|a'], benchKeyOf: a => `${a.role}|${a.title}`,
  };
  const roster = computedProperty('services/sub-agent.service.ts', 'SubAgentService', 'activeRoster', instance);
  const bench = computedProperty('services/sub-agent.service.ts', 'SubAgentService', 'benchedSubAgents', instance);
  assert.deepEqual(ids(roster()), ['c', 'b']); assert.deepEqual(ids(bench()), ['a']);
});
function trackingFixture() {
  const { fixture: f } = agentFixture();
  Object.assign(f, {
    isDesktop: true, orderReady: signal(true), loading: signal(false), restoredFromBackend: false,
    benchedKeys: signal([]), lockedKeys: signal([]), currentCategoryId: signal(null), currentWorkspacePath: signal(null), suggestions: signal([]),
    allSubAgentSessionIds: signal(new Set()), loadBenchedKeys: () => [], loadLockedKeys: () => [], eventService: { setSession() {} },
    api: { getSubAgentSuggestions: async () => ({ ok: true, suggestions: [] }), listSubAgents: async () => ({ ok: true, subAgents: [] }) },
    scheduleReconciliation() {},
  });
  f.desktopSessionApi.show = () => of({ subAgentsOrder: [] });
  return f;
}
test('switching back restores cached agent order synchronously before the network answers', async () => {
  const f = trackingFixture(); f.rememberOrder('p1', ['b', 'a', 'c']);
  f.currentParentId.set('p2'); f.orderReady.set(false);
  const pending = new Subject(); f.desktopSessionApi.show = () => pending;
  const tracking = f.trackSession('p1');
  assert.equal(f.customOrder()[0], agentOrderKey(agent('b')));
  pending.next({ subAgentsOrder: ['a', 'b', 'c'] }); pending.complete(); await tracking;
  assert.equal(f.customOrder()[0], agentOrderKey(agent('b')));
});
test('a summary requested before a drag cannot overwrite the new order', async () => {
  const f = trackingFixture(); const pending = new Subject();
  f.currentParentId.set(null); f.desktopSessionApi.show = () => pending;
  f.api.listSubAgents = async () => ({ ok: true, subAgents: [agent('a'), agent('b')] });
  const tracking = f.trackSession('p1');
  await f.reorderSubAgents('p1', ['b', 'a']);
  pending.next({ subAgentsOrder: ['a', 'b'] }); pending.complete(); await tracking;
  assert.deepEqual(ids(orderAgents(f.activeSubAgents(), f.customOrder())), ['b', 'a']);
});
test('old session response cannot reset newer session order or loading state', async () => {
  const f = trackingFixture(); const pending = new Subject();
  f.currentParentId.set(null); f.desktopSessionApi.show = () => pending;
  const tracking = f.trackSession('p1');
  f.currentParentId.set('p2'); f.customOrder.set(['other']); f.orderReady.set(false);
  pending.next({ subAgentsOrder: ['b', 'a'] }); pending.complete(); await tracking;
  assert.deepEqual(f.customOrder(), ['other']); assert.equal(f.orderReady(), false); assert.equal(f.loading(), true);
});
test('HTTP summary failure does not prevent loading live agents', async () => {
  const f = trackingFixture(); f.currentParentId.set(null);
  f.desktopSessionApi.show = () => throwError(() => new Error('offline'));
  f.api.listSubAgents = async () => ({ ok: true, subAgents: [agent('a'), agent('b')] });
  await f.trackSession('p1');
  assert.deepEqual(ids(f.activeSubAgents()), ['a', 'b']); assert.equal(f.orderReady(), true);
});
