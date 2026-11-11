import { LOCAL_HOST_KEY, commandHostKey, normalizeCommand, sshHostKey } from '../services/session-host';

/**
 * Machine level of the session sidebar: the tree becomes
 *   machine → folders → workspaces → sessions
 * Each machine owns its folders; a workspace or session always sits under the
 * machine it runs on (taken from its cwd scheme), never under another one.
 *
 * Pure functions only — the component feeds them the already-built folder
 * sections and flat lists and renders what comes back.
 */
export const LOCAL_MACHINE = LOCAL_HOST_KEY;
/** `cmd://` session whose connect command is not known (yet). */
export const UNKNOWN_REMOTE_MACHINE = 'cmd:?';

export interface TreeSession {
  id: string;
  workspace?: { path: string } | null;
}

export interface TreeGroup<S extends TreeSession> {
  workspace: { id: string; projectPath?: string | null };
  sessions: S[];
}

export interface TreeFolderSection<G, S> {
  folder: { id: string };
  groups: G[];
  standalone: S[];
}

export interface MachineBucket<F, G, S> {
  key: string;
  folders: F[];
  groups: G[];
  standalone: S[];
}

/** Machine of a cwd: `ssh://<connId>/…`, `cmd://…` (+ its connect command), else this computer. */
export function machineKeyForPath(path: string | null | undefined, remoteCommand?: string | null): string {
  if (!path) return LOCAL_MACHINE;
  if (path.startsWith('ssh://')) {
    const connId = path.slice('ssh://'.length).split('/')[0];
    return connId ? sshHostKey(connId) : LOCAL_MACHINE;
  }
  if (path.startsWith('cmd://')) {
    return normalizeCommand(remoteCommand) ? commandHostKey(remoteCommand!) : UNKNOWN_REMOTE_MACHINE;
  }
  return LOCAL_MACHINE;
}

export function isRemoteMachine(key: string): boolean {
  return key !== LOCAL_MACHINE;
}

/**
 * A workspace group normally lives on one machine. Two `cmd://` sessions with
 * the same remote path on different hosts share the stored workspace: the
 * group is then shown once per machine, each with its own sessions.
 */
export function splitGroupByMachine<S extends TreeSession, G extends TreeGroup<S>>(
  group: G,
  machineOf: (session: S) => string,
): Array<{ machine: string; group: G }> {
  if (group.sessions.length === 0) {
    return [{ machine: machineKeyForPath(group.workspace.projectPath), group }];
  }
  const byMachine = new Map<string, S[]>();
  for (const session of group.sessions) {
    const machine = machineOf(session);
    const list = byMachine.get(machine);
    if (list) list.push(session);
    else byMachine.set(machine, [session]);
  }
  if (byMachine.size === 1) {
    return [{ machine: byMachine.keys().next().value as string, group }];
  }
  return [...byMachine.entries()].map(([machine, sessions]) => ({ machine, group: { ...group, sessions } }));
}

/**
 * Machine a folder belongs to: the remembered one, else the machine all of its
 * content runs on, else this computer (empty or mixed folders).
 */
export function resolveFolderHome(remembered: string | undefined, contentMachines: ReadonlyArray<string>): string {
  if (remembered) return remembered;
  const distinct = new Set(contentMachines);
  return distinct.size === 1 ? (distinct.values().next().value as string) : LOCAL_MACHINE;
}

export interface MachineTreeInput<S extends TreeSession, G extends TreeGroup<S>, F extends TreeFolderSection<G, S>> {
  folderSections: ReadonlyArray<F>;
  groups: ReadonlyArray<G>;
  standalone: ReadonlyArray<S>;
  machineOf: (session: S) => string;
  /** folderId → machine key remembered for that folder. */
  folderHomes: ReadonlyMap<string, string>;
  /** Preferred order of the remote machines (configured hosts); the rest follows. */
  machineOrder?: ReadonlyArray<string>;
}

export interface MachineTree<F, G, S> {
  /** This computer first, then the remote machines. Empty machines included only if they own a folder. */
  machines: Array<MachineBucket<F, G, S>>;
  /** folderId → machine it is rendered under. */
  folderMachine: Map<string, string>;
  /** Folders whose machine was inferred from their content (worth remembering). */
  inferredHomes: Map<string, string>;
}

export function buildMachineTree<S extends TreeSession, G extends TreeGroup<S>, F extends TreeFolderSection<G, S>>(
  input: MachineTreeInput<S, G, F>,
): MachineTree<F, G, S> {
  const buckets = new Map<string, MachineBucket<F, G, S>>();
  const bucket = (key: string): MachineBucket<F, G, S> => {
    let b = buckets.get(key);
    if (!b) {
      b = { key, folders: [], groups: [], standalone: [] };
      buckets.set(key, b);
    }
    return b;
  };
  bucket(LOCAL_MACHINE);

  const folderMachine = new Map<string, string>();
  const inferredHomes = new Map<string, string>();

  for (const section of input.folderSections) {
    const groups = section.groups.flatMap((g) => splitGroupByMachine<S, G>(g, input.machineOf));
    const standalone = section.standalone.map((s) => ({ machine: input.machineOf(s), session: s }));
    const contentMachines = [...groups.map((g) => g.machine), ...standalone.map((s) => s.machine)];
    const remembered = input.folderHomes.get(section.folder.id);
    const home = resolveFolderHome(remembered, contentMachines);
    if (!remembered && contentMachines.length > 0) inferredHomes.set(section.folder.id, home);
    folderMachine.set(section.folder.id, home);

    bucket(home).folders.push({
      ...section,
      groups: groups.filter((g) => g.machine === home).map((g) => g.group),
      standalone: standalone.filter((s) => s.machine === home).map((s) => s.session),
    });
    // Content running elsewhere never follows the folder onto another machine.
    for (const g of groups) if (g.machine !== home) bucket(g.machine).groups.push(g.group);
    for (const s of standalone) if (s.machine !== home) bucket(s.machine).standalone.push(s.session);
  }

  for (const group of input.groups) {
    for (const part of splitGroupByMachine<S, G>(group, input.machineOf)) bucket(part.machine).groups.push(part.group);
  }
  for (const session of input.standalone) bucket(input.machineOf(session)).standalone.push(session);

  const order = input.machineOrder ?? [];
  const rank = (key: string): number => {
    if (key === LOCAL_MACHINE) return -1;
    const i = order.indexOf(key);
    return i < 0 ? order.length : i;
  };
  const machines = [...buckets.values()]
    .map((b, index) => ({ b, index }))
    .sort((a, z) => rank(a.b.key) - rank(z.b.key) || a.index - z.index)
    .map(({ b }) => b);

  return { machines, folderMachine, inferredHomes };
}

export function bucketItemCount<F extends { groups: unknown[]; standalone: unknown[] }, G, S>(b: MachineBucket<F, G, S>): number {
  return (
    b.groups.length +
    b.standalone.length +
    b.folders.reduce((n, f) => n + f.groups.length + f.standalone.length, 0)
  );
}

/** The machine level shows only when something lives on a remote machine. */
export function hasRemoteContent<F, G, S>(machines: ReadonlyArray<MachineBucket<F, G, S>>): boolean {
  return machines.some((b) => isRemoteMachine(b.key) && b.folders.length + b.groups.length + b.standalone.length > 0);
}
