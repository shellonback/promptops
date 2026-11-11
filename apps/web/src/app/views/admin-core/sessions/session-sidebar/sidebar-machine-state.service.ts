import { Injectable, inject, signal } from '@angular/core';
import { SessionService } from '../services/session.service';
import { normalizeCommand } from '../services/session-host';

/**
 * What the sidebar remembers about the machine level, on this device (remote
 * machines are device-local: SSH connections and connect commands never leave
 * it, so their tree state does not either):
 *  - which machine each folder belongs to
 *  - which machine sections are collapsed
 *  - the connect command of each `cmd://` session (the summary does not carry
 *    it), so the tree is already grouped at boot
 */
export const FOLDER_MACHINE_STORAGE_KEY = 'promptops_sidebar_folder_machine_v1';
export const MACHINE_EXPANDED_STORAGE_KEY = 'promptops_sidebar_machine_expanded_v1';
export const SESSION_COMMAND_STORAGE_KEY = 'promptops_sidebar_session_command_v1';
const MAX_SESSION_COMMANDS = 500;

function readRecord<T>(key: string, isValue: (v: unknown) => v is T): Map<string, T> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    const out = new Map<string, T>();
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValue(v)) out.set(k, v);
    }
    return out;
  } catch {
    return new Map();
  }
}

function writeRecord<T>(key: string, map: ReadonlyMap<string, T>): void {
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(map)));
  } catch { /* storage unavailable: the state lives for this run only */ }
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

@Injectable({ providedIn: 'root' })
export class SidebarMachineStateService {
  private readonly sessionService = inject(SessionService);

  readonly folderHomes = signal<Map<string, string>>(readRecord(FOLDER_MACHINE_STORAGE_KEY, isString));
  readonly expanded = signal<Map<string, boolean>>(readRecord(MACHINE_EXPANDED_STORAGE_KEY, isBoolean));
  /** session key (dbId, else local id) → connect command. */
  readonly sessionCommands = signal<Map<string, string>>(readRecord(SESSION_COMMAND_STORAGE_KEY, isString));

  private readonly resolving = new Set<string>();

  setFolderHome(folderId: string, machine: string): void {
    this.setFolderHomes(new Map([[folderId, machine]]));
  }

  /** Remembers several folder → machine pairs at once; no write when nothing changes. */
  setFolderHomes(homes: ReadonlyMap<string, string>): void {
    const current = this.folderHomes();
    let next: Map<string, string> | null = null;
    for (const [id, machine] of homes) {
      if (!id || !machine || current.get(id) === machine) continue;
      next ??= new Map(current);
      next.set(id, machine);
    }
    if (!next) return;
    this.folderHomes.set(next);
    writeRecord(FOLDER_MACHINE_STORAGE_KEY, next);
  }

  /** Machines never seen start open. */
  isExpanded(machine: string): boolean {
    return this.expanded().get(machine) ?? true;
  }

  toggle(machine: string): void {
    const next = new Map(this.expanded());
    next.set(machine, !this.isExpanded(machine));
    this.expanded.set(next);
    writeRecord(MACHINE_EXPANDED_STORAGE_KEY, next);
  }

  commandOf(sessionKey: string | null | undefined): string | null {
    return (sessionKey && this.sessionCommands().get(sessionKey)) || null;
  }

  /**
   * Looks up the connect command of `cmd://` sessions not known yet (once per
   * session and run). Best effort: an unresolved session stays under the
   * generic "remote machine" section.
   */
  async resolveCommands(sessions: ReadonlyArray<{ id: string; key: string }>): Promise<void> {
    const todo = sessions.filter((s) => s.key && !this.sessionCommands().has(s.key) && !this.resolving.has(s.key));
    if (todo.length === 0) return;
    for (const s of todo) this.resolving.add(s.key);
    const found = new Map<string, string>();
    await Promise.all(
      todo.map(async (s) => {
        try {
          const live = await this.sessionService.getSession(s.id);
          const command = normalizeCommand(live?.config?.remoteCommand);
          if (command) found.set(s.key, command);
        } catch { /* session not live: stays unresolved */ }
      }),
    );
    if (found.size === 0) return;
    const merged = new Map([...this.sessionCommands(), ...found]);
    // Oldest entries go first when the cache outgrows its cap.
    const next = new Map([...merged].slice(-MAX_SESSION_COMMANDS));
    this.sessionCommands.set(next);
    writeRecord(SESSION_COMMAND_STORAGE_KEY, next);
  }
}
