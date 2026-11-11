import {
  LOCAL_MACHINE,
  UNKNOWN_REMOTE_MACHINE,
  bucketItemCount,
  buildMachineTree,
  hasRemoteContent,
  isRemoteMachine,
  machineKeyForPath,
  resolveFolderHome,
  splitGroupByMachine,
} from './machine-tree';

interface S { id: string; workspace?: { path: string } | null; cmd?: string }
interface G { workspace: { id: string; projectPath?: string | null }; sessions: S[]; expanded: boolean }
interface F { folder: { id: string }; groups: G[]; standalone: S[] }

const s = (id: string, path?: string, cmd?: string): S => ({ id, workspace: path ? { path } : null, cmd });
const g = (id: string, sessions: S[], projectPath?: string): G => ({ workspace: { id, projectPath }, sessions, expanded: true });
const f = (id: string, groups: G[] = [], standalone: S[] = []): F => ({ folder: { id }, groups, standalone });
const machineOf = (x: S): string => machineKeyForPath(x.workspace?.path, x.cmd);
const build = (input: { folderSections?: F[]; groups?: G[]; standalone?: S[]; homes?: Record<string, string>; order?: string[] }) =>
  buildMachineTree<S, G, F>({
    folderSections: input.folderSections ?? [],
    groups: input.groups ?? [],
    standalone: input.standalone ?? [],
    machineOf,
    folderHomes: new Map(Object.entries(input.homes ?? {})),
    machineOrder: input.order,
  });

const SSH = 'ssh://c1/srv/app';
const CMD = 'ssh ubuntu@10.0.0.1';

describe('machine-tree', () => {
  describe('machineKeyForPath', () => {
    it('maps a cwd to its machine', () => {
      expect(machineKeyForPath('/Users/me/app')).toBe(LOCAL_MACHINE);
      expect(machineKeyForPath('C:\\code\\app')).toBe(LOCAL_MACHINE);
      expect(machineKeyForPath(null)).toBe(LOCAL_MACHINE);
      expect(machineKeyForPath(undefined)).toBe(LOCAL_MACHINE);
      expect(machineKeyForPath(SSH)).toBe('ssh:c1');
      expect(machineKeyForPath('ssh://c1')).toBe('ssh:c1');
      expect(machineKeyForPath('cmd:///home/u/app', ` ${CMD} `)).toBe(`cmd:${CMD}`);
    });

    it('keeps a cmd:// session apart while its command is unknown', () => {
      expect(machineKeyForPath('cmd:///home/u/app')).toBe(UNKNOWN_REMOTE_MACHINE);
      expect(machineKeyForPath('cmd:///home/u/app', '  ')).toBe(UNKNOWN_REMOTE_MACHINE);
      expect(isRemoteMachine(UNKNOWN_REMOTE_MACHINE)).toBeTrue();
      expect(isRemoteMachine(LOCAL_MACHINE)).toBeFalse();
    });

    it('never treats a malformed ssh path as remote', () => {
      expect(machineKeyForPath('ssh://')).toBe(LOCAL_MACHINE);
    });
  });

  describe('splitGroupByMachine', () => {
    it('keeps a single-machine group as is (same object)', () => {
      const group = g('w1', [s('a', '/p'), s('b', '/p')]);
      const parts = splitGroupByMachine<S, G>(group, machineOf);
      expect(parts.length).toBe(1);
      expect(parts[0].machine).toBe(LOCAL_MACHINE);
      expect(parts[0].group).toBe(group);
    });

    it('shows a workspace shared by two hosts once per machine, sessions in order', () => {
      const group = g('w1', [s('a', 'cmd:///app', 'ssh u@h1'), s('b', 'cmd:///app', 'ssh u@h2'), s('c', 'cmd:///app', 'ssh u@h1')]);
      const parts = splitGroupByMachine<S, G>(group, machineOf);
      expect(parts.map((p) => p.machine)).toEqual(['cmd:ssh u@h1', 'cmd:ssh u@h2']);
      expect(parts[0].group.sessions.map((x) => x.id)).toEqual(['a', 'c']);
      expect(parts[1].group.sessions.map((x) => x.id)).toEqual(['b']);
      expect(parts[0].group.workspace).toBe(group.workspace);
    });

    it('places an empty workspace from its project path', () => {
      expect(splitGroupByMachine<S, G>(g('w1', [], '/local/p'), machineOf)[0].machine).toBe(LOCAL_MACHINE);
      expect(splitGroupByMachine<S, G>(g('w2', [], SSH), machineOf)[0].machine).toBe('ssh:c1');
      expect(splitGroupByMachine<S, G>(g('w3', []), machineOf)[0].machine).toBe(LOCAL_MACHINE);
    });
  });

  describe('resolveFolderHome', () => {
    it('prefers the remembered machine', () => {
      expect(resolveFolderHome('ssh:c1', [LOCAL_MACHINE])).toBe('ssh:c1');
    });
    it('follows the content when it all runs on one machine', () => {
      expect(resolveFolderHome(undefined, ['ssh:c1', 'ssh:c1'])).toBe('ssh:c1');
    });
    it('falls back to this computer for empty or mixed folders', () => {
      expect(resolveFolderHome(undefined, [])).toBe(LOCAL_MACHINE);
      expect(resolveFolderHome(undefined, ['ssh:c1', LOCAL_MACHINE])).toBe(LOCAL_MACHINE);
    });
  });

  describe('buildMachineTree', () => {
    it('with only local content yields this computer alone, lists untouched', () => {
      const groups = [g('w1', [s('a', '/p')])];
      const standalone = [s('b', '/q'), s('c')];
      const sections = [f('f1', [g('w2', [s('d', '/r')])])];
      const tree = build({ folderSections: sections, groups, standalone });
      expect(tree.machines.length).toBe(1);
      expect(tree.machines[0].key).toBe(LOCAL_MACHINE);
      expect(tree.machines[0].groups).toEqual(groups);
      expect(tree.machines[0].standalone).toEqual(standalone);
      expect(tree.machines[0].folders).toEqual(sections);
      expect(hasRemoteContent(tree.machines)).toBeFalse();
    });

    it('always lists this computer first, even when empty', () => {
      const tree = build({ standalone: [s('a', SSH)] });
      expect(tree.machines.map((m) => m.key)).toEqual([LOCAL_MACHINE, 'ssh:c1']);
      expect(tree.machines[0].standalone).toEqual([]);
      expect(hasRemoteContent(tree.machines)).toBeTrue();
    });

    it('puts every workspace and session under its own machine', () => {
      const tree = build({
        groups: [g('w1', [s('a', '/p')]), g('w2', [s('b', 'cmd:///app', CMD)])],
        standalone: [s('c', SSH), s('d', '/q')],
      });
      const by = new Map(tree.machines.map((m) => [m.key, m]));
      expect(by.get(LOCAL_MACHINE)!.groups.map((x) => x.workspace.id)).toEqual(['w1']);
      expect(by.get(LOCAL_MACHINE)!.standalone.map((x) => x.id)).toEqual(['d']);
      expect(by.get(`cmd:${CMD}`)!.groups.map((x) => x.workspace.id)).toEqual(['w2']);
      expect(by.get('ssh:c1')!.standalone.map((x) => x.id)).toEqual(['c']);
    });

    it('orders remote machines like the configured hosts, unknown ones last', () => {
      const tree = build({
        standalone: [s('a', 'ssh://zzz/x'), s('b', 'cmd:///x', CMD), s('c', SSH)],
        order: ['ssh:c1', `cmd:${CMD}`],
      });
      expect(tree.machines.map((m) => m.key)).toEqual([LOCAL_MACHINE, 'ssh:c1', `cmd:${CMD}`, 'ssh:zzz']);
    });

    it('gives each machine its own folders', () => {
      const tree = build({
        folderSections: [f('work', [g('w1', [s('a', '/p')])]), f('servers', [], [s('b', SSH)])],
        homes: { work: LOCAL_MACHINE, servers: 'ssh:c1' },
      });
      const by = new Map(tree.machines.map((m) => [m.key, m]));
      expect(by.get(LOCAL_MACHINE)!.folders.map((x) => x.folder.id)).toEqual(['work']);
      expect(by.get('ssh:c1')!.folders.map((x) => x.folder.id)).toEqual(['servers']);
      expect(tree.folderMachine.get('servers')).toBe('ssh:c1');
      expect(tree.inferredHomes.size).toBe(0);
    });

    it('keeps an empty folder on the machine it was created on', () => {
      const tree = build({ folderSections: [f('servers')], homes: { servers: 'ssh:c1' } });
      const remote = tree.machines.find((m) => m.key === 'ssh:c1')!;
      expect(remote.folders.map((x) => x.folder.id)).toEqual(['servers']);
      expect(hasRemoteContent(tree.machines)).toBeTrue();
    });

    it('infers the machine of a folder never placed before from its content', () => {
      const tree = build({ folderSections: [f('legacy', [], [s('a', SSH), s('b', SSH)]), f('empty')] });
      expect(tree.folderMachine.get('legacy')).toBe('ssh:c1');
      expect(tree.inferredHomes.get('legacy')).toBe('ssh:c1');
      // Empty folder: this computer, and nothing to remember yet.
      expect(tree.folderMachine.get('empty')).toBe(LOCAL_MACHINE);
      expect(tree.inferredHomes.has('empty')).toBeFalse();
    });

    it('never carries content onto another machine through a folder', () => {
      const tree = build({
        folderSections: [f('mixed', [g('w1', [s('a', '/p')]), g('w2', [s('b', SSH)])], [s('c', SSH), s('d', '/q')])],
        homes: { mixed: LOCAL_MACHINE },
      });
      const by = new Map(tree.machines.map((m) => [m.key, m]));
      const folder = by.get(LOCAL_MACHINE)!.folders[0];
      expect(folder.groups.map((x) => x.workspace.id)).toEqual(['w1']);
      expect(folder.standalone.map((x) => x.id)).toEqual(['d']);
      expect(by.get('ssh:c1')!.folders).toEqual([]);
      expect(by.get('ssh:c1')!.groups.map((x) => x.workspace.id)).toEqual(['w2']);
      expect(by.get('ssh:c1')!.standalone.map((x) => x.id)).toEqual(['c']);
    });

    it('loses no session and duplicates none, whatever the mix', () => {
      const sessions = [s('a', '/p'), s('b', SSH), s('c', 'cmd:///x', CMD), s('d', 'cmd:///x'), s('e'), s('h', 'cmd:///x', 'ssh u@other')];
      const tree = build({
        folderSections: [f('f1', [g('w1', [sessions[0], sessions[1]])], [sessions[2]])],
        groups: [g('w2', [sessions[3], sessions[5]])],
        standalone: [sessions[4]],
      });
      const seen: string[] = [];
      for (const m of tree.machines) {
        for (const x of m.standalone) seen.push(x.id);
        for (const grp of m.groups) for (const x of grp.sessions) seen.push(x.id);
        for (const fs of m.folders) {
          for (const x of fs.standalone) seen.push(x.id);
          for (const grp of fs.groups) for (const x of grp.sessions) seen.push(x.id);
        }
      }
      expect(seen.sort()).toEqual(sessions.map((x) => x.id).sort());
    });

    it('counts the projects of a machine, folders included', () => {
      const tree = build({
        folderSections: [f('f1', [g('w1', [s('a', '/p')])], [s('b', '/q')])],
        groups: [g('w2', [s('c', '/r')])],
        standalone: [s('d', '/s')],
        homes: { f1: LOCAL_MACHINE },
      });
      expect(bucketItemCount(tree.machines[0])).toBe(4);
    });
  });
});
