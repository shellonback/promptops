import { Injectable, signal } from '@angular/core';

/** Session actions with a remappable key. The modifier stays fixed (⌘⌥ on
 *  macOS, Alt elsewhere) and 1-9 / Esc are not touched: here you only choose the key. */
export type SessionShortcutAction = 'focusMain' | 'prevAgent' | 'nextAgent' | 'nextWaiting' | 'expandAgent' | 'lockAgent' | 'focusMode';

export type SessionShortcutBindings = Record<SessionShortcutAction, string>;

export const DEFAULT_SESSION_SHORTCUTS: SessionShortcutBindings = {
  focusMain: 'Digit0',
  prevAgent: 'BracketLeft',
  nextAgent: 'BracketRight',
  nextWaiting: 'KeyA',
  expandAgent: 'KeyE',
  lockAgent: 'KeyL',
  focusMode: 'KeyF',
};

const STORAGE_KEY = 'promptops.sessionShortcuts.v1';

const PUNCTUATION: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
};

/**
 * ⌘⌥ combinations already taken by macOS or the webview: assignable, but with
 * a warning. Values name SESSIONS.SHORTCUTS "Reason <id>" keys (what the system does).
 */
export const MAC_RESERVED_SHORTCUTS: Record<string, string> = {
  KeyH: 'HideOthers',
  KeyM: 'MinimizeAll',
  KeyD: 'ToggleDock',
  KeyW: 'CloseAll',
  KeyI: 'WebInspector',
  KeyJ: 'JsConsole',
  KeyC: 'InspectElement',
  KeyU: 'PageSource',
  Equal: 'ZoomIn',
  Minus: 'ZoomOut',
};

/** On Windows/Linux Alt+key reaches the terminal as Meta (ESC+key):
 *  it collides with readline/zsh and with the provider CLIs' shortcuts. On macOS
 *  the ⌘ in the combination keeps it out of the pty, so it doesn't apply there.
 *  Values name SESSIONS.SHORTCUTS "Reason <id>" keys. */
export const TERMINAL_RESERVED_SHORTCUTS: Record<string, string> = {
  KeyB: 'WordBack',
  KeyF: 'WordForward',
  KeyD: 'DeleteWord',
  KeyU: 'Uppercase',
  KeyL: 'Lowercase',
  KeyC: 'Capitalize',
  KeyT: 'Transpose',
  KeyP: 'ModelPicker',
  KeyN: 'HistoryForward',
  KeyY: 'KillRing',
  KeyR: 'RevertLine',
  Period: 'LastArgument',
};

export type ShortcutPlatform = 'mac' | 'windows' | 'linux';

/** A discouraged key: `message` and `reason` are SESSIONS.SHORTCUTS keys, `key` the key label. */
export interface ShortcutConflict {
  message: 'ConflictMac' | 'ConflictTerminal';
  reason: string;
  key: string;
}

/** Why `code` is discouraged on that platform, null if it is free. */
export function shortcutConflict(code: string, platform: ShortcutPlatform): ShortcutConflict | null {
  const key = shortcutKeyLabel(code) ?? code;
  if (platform === 'mac') {
    const why = MAC_RESERVED_SHORTCUTS[code];
    return why ? { message: 'ConflictMac', reason: `Reason ${why}`, key } : null;
  }
  const why = TERMINAL_RESERVED_SHORTCUTS[code];
  return why ? { message: 'ConflictTerminal', reason: `Reason ${why}`, key } : null;
}

/** event.code → key label, null if the key is not assignable. */
export function shortcutKeyLabel(code: string): string | null {
  const letter = code.match(/^Key([A-Z])$/);
  if (letter) return letter[1];
  if (code === 'Digit0') return '0';
  return PUNCTUATION[code] ?? null;
}

@Injectable({ providedIn: 'root' })
export class SessionShortcutsService {
  readonly bindings = signal<SessionShortcutBindings>(this.load());

  /** Action bound to an event.code, if any. */
  actionFor(code: string): SessionShortcutAction | null {
    const b = this.bindings();
    return (Object.keys(b) as SessionShortcutAction[]).find(a => b[a] === code) ?? null;
  }

  /** Assigns `code` to `action`; if it already belonged to another action the two swap. */
  set(action: SessionShortcutAction, code: string): SessionShortcutAction | null {
    if (!shortcutKeyLabel(code)) return null;
    const next = { ...this.bindings() };
    const clash = this.actionFor(code);
    if (clash && clash !== action) next[clash] = next[action];
    next[action] = code;
    this.save(next);
    return clash && clash !== action ? clash : null;
  }

  reset(): void {
    this.save({ ...DEFAULT_SESSION_SHORTCUTS });
  }

  isDefault(): boolean {
    const b = this.bindings();
    return (Object.keys(DEFAULT_SESSION_SHORTCUTS) as SessionShortcutAction[])
      .every(a => b[a] === DEFAULT_SESSION_SHORTCUTS[a]);
  }

  private save(next: SessionShortcutBindings): void {
    this.bindings.set(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* storage off: applies for the session */ }
  }

  private load(): SessionShortcutBindings {
    const out = { ...DEFAULT_SESSION_SHORTCUTS };
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<SessionShortcutBindings>;
      const used = new Set<string>();
      const actions = Object.keys(out) as SessionShortcutAction[];
      for (const a of actions) {
        const code = raw[a];
        if (typeof code === 'string' && shortcutKeyLabel(code) && !used.has(code)) out[a] = code;
        used.add(out[a]);
      }
      // A new action (missing from the saved map) whose default the user already
      // gave to another one takes the first free letter instead of resetting all.
      for (const a of actions) {
        if (typeof raw[a] === 'string') continue;
        if (actions.some(o => o !== a && out[o] === out[a])) {
          const taken = new Set(actions.filter(o => o !== a).map(o => out[o]));
          const free = 'ABGKOQSVXZ'.split('').map(c => `Key${c}`).find(c => !taken.has(c));
          if (free) out[a] = free;
        }
      }
      // Two actions on the same key (corrupted data) → back to the defaults.
      if (new Set(Object.values(out)).size !== Object.keys(out).length) return { ...DEFAULT_SESSION_SHORTCUTS };
    } catch { /* default */ }
    return out;
  }
}
