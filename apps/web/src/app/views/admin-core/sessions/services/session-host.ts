import { Injectable, inject, signal } from '@angular/core';
import { SessionService } from './session.service';

/**
 * Session host — the machine a session runs on. It sits ABOVE the folder
 * choice: first "where" (this computer or a remote machine), then "which
 * folder" on that machine.
 *
 *  - local   → the folder is picked/created/cloned on this computer.
 *  - ssh     → saved SSH connection (russh), cwd `ssh://<connId><path>`.
 *  - command → connect command kept alive in the session PTY (`ssh user@host`,
 *              `aws ssm start-session …`), cwd `cmd://<path>` + the command in
 *              `config.remoteCommand`.
 *
 * The native side still routes on the cwd scheme: this layer only decides
 * which transport the wizard drives, it adds no new wire format.
 */
export const LOCAL_HOST_KEY = 'local';

export interface RemoteHost {
  /** Stable identity: `ssh:<connId>` or `cmd:<normalized command>`. */
  key: string;
  kind: 'ssh' | 'command';
  /** Short label (connection name, or the host taken from the command). */
  name: string;
  /** Second line: `user@host[:port]` or the full connect command. */
  detail: string;
  connId?: string;
  command?: string;
}

export interface SshConnectionSummary {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
}

/** Connect commands remembered on this device (most recent first). */
export const REMOTE_COMMANDS_STORAGE_KEY = 'po.sessionHosts.commands';
export const MAX_REMEMBERED_COMMANDS = 20;

/** Trim + collapse inner whitespace, so the same command typed twice is one host. */
export function normalizeCommand(command: string | null | undefined): string {
  return String(command ?? '').trim().replace(/\s+/g, ' ');
}

/** Human host taken from a connect command: `user@HOST`, `--target ID`, else the last word. */
export function commandHostLabel(command: string): string {
  const cmd = normalizeCommand(command);
  const at = /@([\w.\-]+)/.exec(cmd);
  if (at) return at[1];
  const target = /--target[= ]+(\S+)/.exec(cmd);
  if (target) return target[1];
  return 'remote';
}

export function sshHostKey(connId: string): string {
  return `ssh:${connId}`;
}

export function commandHostKey(command: string): string {
  return `cmd:${normalizeCommand(command)}`;
}

export function sshHost(conn: SshConnectionSummary): RemoteHost {
  const port = conn.port && conn.port !== 22 ? `:${conn.port}` : '';
  return {
    key: sshHostKey(conn.id),
    kind: 'ssh',
    name: conn.name || conn.host,
    detail: `${conn.username}@${conn.host}${port}`,
    connId: conn.id,
  };
}

export function commandHost(command: string): RemoteHost {
  const cmd = normalizeCommand(command);
  return {
    key: commandHostKey(cmd),
    kind: 'command',
    name: commandHostLabel(cmd),
    detail: cmd,
    command: cmd,
  };
}

/** Saved SSH connections first, then the remembered connect commands. */
export function buildRemoteHosts(
  connections: ReadonlyArray<SshConnectionSummary>,
  commands: ReadonlyArray<string>,
): RemoteHost[] {
  const out: RemoteHost[] = [];
  const seen = new Set<string>();
  const push = (host: RemoteHost): void => {
    if (seen.has(host.key)) return;
    seen.add(host.key);
    out.push(host);
  };
  for (const conn of connections) {
    if (conn?.id) push(sshHost(conn));
  }
  for (const command of commands) {
    if (normalizeCommand(command)) push(commandHost(command));
  }
  return out;
}

/** Tolerant read of the stored list: anything that is not a clean string array is dropped. */
export function parseStoredCommands(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return dedupeCommands(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return [];
  }
}

function dedupeCommands(commands: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const command of commands) {
    const cmd = normalizeCommand(command);
    if (cmd && !out.includes(cmd)) out.push(cmd);
    if (out.length >= MAX_REMEMBERED_COMMANDS) break;
  }
  return out;
}

/** Puts `command` first (most recent), without duplicates, capped. */
export function rememberCommandIn(commands: ReadonlyArray<string>, command: string): string[] {
  const cmd = normalizeCommand(command);
  if (!cmd) return dedupeCommands(commands);
  return dedupeCommands([cmd, ...commands]);
}

export function forgetCommandIn(commands: ReadonlyArray<string>, command: string): string[] {
  const cmd = normalizeCommand(command);
  return dedupeCommands(commands).filter((c) => c !== cmd);
}

/**
 * Remote machines configured on this device: saved SSH connections (native
 * store, secrets never reach the renderer) + connect commands already used
 * (localStorage: device-local on purpose, like the SSH store).
 */
@Injectable({ providedIn: 'root' })
export class SessionHostsService {
  private readonly sessionService = inject(SessionService);

  readonly remoteHosts = signal<RemoteHost[]>([]);
  readonly loading = signal(false);

  private connections: SshConnectionSummary[] = [];

  /** Remote hosts exist only in the Tauri desktop. */
  get supported(): boolean {
    return this.sessionService.isTauri;
  }

  /** Reloads the SSH connections and rebuilds the list. Never throws. */
  async refresh(): Promise<RemoteHost[]> {
    if (!this.supported) {
      this.remoteHosts.set([]);
      return [];
    }
    this.loading.set(true);
    try {
      this.connections = await this.sessionService.listSshConnections();
    } catch {
      // Listing failed: keep the last known connections, the commands still show.
    } finally {
      this.loading.set(false);
    }
    return this.rebuild();
  }

  rememberCommand(command: string): RemoteHost | null {
    const cmd = normalizeCommand(command);
    if (!cmd) return null;
    this.writeCommands(rememberCommandIn(this.readCommands(), cmd));
    this.rebuild();
    return commandHost(cmd);
  }

  forgetCommand(command: string): void {
    this.writeCommands(forgetCommandIn(this.readCommands(), command));
    this.rebuild();
  }

  find(key: string): RemoteHost | null {
    return this.remoteHosts().find((h) => h.key === key) ?? null;
  }

  private rebuild(): RemoteHost[] {
    const hosts = buildRemoteHosts(this.connections, this.readCommands());
    this.remoteHosts.set(hosts);
    return hosts;
  }

  /** Set only when localStorage refuses the write: the list then lives in memory. */
  private memoryCommands: string[] | null = null;

  private readCommands(): string[] {
    if (this.memoryCommands) return this.memoryCommands;
    try {
      return parseStoredCommands(localStorage.getItem(REMOTE_COMMANDS_STORAGE_KEY));
    } catch {
      return [];
    }
  }

  private writeCommands(commands: string[]): void {
    try {
      localStorage.setItem(REMOTE_COMMANDS_STORAGE_KEY, JSON.stringify(commands));
      this.memoryCommands = null;
    } catch {
      this.memoryCommands = commands;
    }
  }
}
