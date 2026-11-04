import { OrgPolicyService } from '@core/services/org-policy.service';
import { Injectable, inject, signal } from '@angular/core';

/**
 * PromptOps built-in plugins: native sections of the app presented as plugins.
 * They have no repository or third-party code: they are part of the signed app, start
 * installed and enabled (except DEFAULT_OFF), and can be turned off from the Plugins page. Off = the part
 * disappears from the interface (menu item, badge, button or chip), nothing is deleted.
 * The choice stays on this device.
 */
export type BuiltinKey = 'agent-evals' | 'git-writer' | 'browser' | 'ssh' | 'database' | 'docker' | 'ai-squad' | 'goal' | 'worker' | 'auto-approve' | 'multi-session' | 'floor-plan';

export interface BuiltinPlugin {
  key: BuiltinKey;
  /** Plugin-style id, reserved for the PromptOps publisher. */
  pluginId: string;
  name: string;
  description: string;
  /** Where it shows up in the app: the card displays it. */
  where: string;
  category: string;
  /** Who signs it in the card: PromptOps (verified, compact logo) with some exceptions. */
  publisher?: { label: string; avatar: string; kind: 'user' | 'team'; verified: boolean; ownerEmail?: string };
}

export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  { key: 'floor-plan', pluginId: 'promptops.floor-plan', name: 'Floor Plan', category: 'Session sidebar', where: 'Session sidebar › Floor plan, at the top',
    description: 'Your whole PromptOps from above, as a 3D virtual office: folders are rooms, workspaces are desks, with the agents at work. Click a desk to open it.' },
  { key: 'agent-evals', pluginId: 'promptops.agent-evals-builtin', name: 'AI Agent Evals', category: 'Menu page', where: 'Side menu › AI Agent Evals',
    description: 'Measure how fast your AI models answer, on your own accounts.' },
  { key: 'git-writer', pluginId: 'promptops.git-writer-builtin', name: 'AI Git Writer', category: 'Menu page', where: 'Side menu › AI Git Writer',
    description: 'Write mails, changelogs, reports and handovers from your repositories.' },
  { key: 'browser', pluginId: 'promptops.browser', name: 'Browser', category: 'Menu page + terminal button', where: 'Side menu › Browser, and the Chrome button under each terminal',
    description: 'A terminal next to a live mirror of the Chrome your agent drives.' },
  { key: 'ssh', pluginId: 'promptops.ssh', name: 'SSH connections', category: 'Session header', where: 'Session header › SSH',
    description: 'Saved SSH connections and remote terminals from the session header.' },
  { key: 'database', pluginId: 'promptops.database', name: 'Database explorer', category: 'Session header', where: 'Session header › Database',
    description: 'Browse tables and ask questions in plain words to your project database.' },
  { key: 'multi-session', pluginId: 'promptops.multi-session', name: 'Multi-session workspace', category: 'Session header', where: 'Session header › tabs above the agents',
    description: 'Several sessions side by side on the same workspace, as tabs. Off = one session per workspace, with its agents.' },
  { key: 'docker', pluginId: 'promptops.docker', name: 'Docker containers', category: 'Session header', where: 'Session header › Docker',
    description: 'The containers of your project, from the session header.' },
  { key: 'auto-approve', pluginId: 'promptops.auto-approve', name: 'Auto Approve', category: 'Action Center + terminal toolbar', where: 'Action Center › Auto Approve, and the shield under each terminal',
    description: 'Answers the confirmation prompts of your agents for you, in Quick or AI mode. Off by default: turn it on to get the controls. Turning it off also stops it on every session.' },
  { key: 'ai-squad', pluginId: 'promptops.ai-squad', name: 'AI Squad', category: 'Squad · Goal · Worker row', where: 'Spawn composer › AI Squad',
    description: 'Turns an intent into a small team of agents working in waves.' },
  { key: 'goal', pluginId: 'promptops.goal', name: 'Goal', category: 'Squad · Goal · Worker row', where: 'Spawn composer › Goal',
    description: 'The prompt becomes a goal: the agent works unattended until it is reached.' },
  { key: 'worker', pluginId: 'promptops.worker', name: 'Worker', category: 'Squad · Goal · Worker row', where: 'Spawn composer › Worker',
    description: 'Headless runtime: structured output, real token usage, native mode flags.' },
];

/** Side menu items governed by a built-in plugin. */
export const BUILTIN_MENU_KEYS: Record<string, BuiltinKey> = {
  'speed-test': 'agent-evals',
  'git-writer': 'git-writer',
  browser: 'browser',
};

/** Default publisher of the built-in plugins. */
export const PROMPTOPS_PUBLISHER = { label: 'promptops', avatar: 'assets/logos/compact-logo-v3.png', kind: 'team' as const, verified: true };

/**
 * Registry plugins superseded by a built-in section (AI Agent Evals, AI Git Writer).
 * For the person there is ONE single item, the built-in one, which opens the usual NATIVE page: these don't
 * show up in the Catalog or in Installed, their pages don't enter the menu and, if they turn out to be installed
 * from the registry, the runtime uninstalls them (PluginRuntimeService.dropAbsorbed).
 */
export const ABSORBED_BY_BUILTIN: Record<string, BuiltinKey> = {
  'promptops.agent-evals': 'agent-evals',
  'promptops.git-writer': 'git-writer',
};

const STORAGE_KEY = 'po.builtinPlugins.off';
/** Built-ins that start off: they turn on only by an explicit choice, saved in ENABLED_KEY. */
const DEFAULT_OFF: ReadonlySet<BuiltinKey> = new Set<BuiltinKey>(['auto-approve']);
const ENABLED_KEY = 'po.builtinPlugins.on';
/** Uninstalled: they disappear from Installed and stay in the Catalog with "Install". They are also off. */
const REMOVED_KEY = 'po.builtinPlugins.removed';

@Injectable({ providedIn: 'root' })
export class BuiltinPluginsService {
  private orgPolicy = inject(OrgPolicyService);
  /** Keys that are off. Everything else is on: built-in plugins start enabled, except DEFAULT_OFF. */
  readonly off = signal<ReadonlySet<BuiltinKey>>(this.load(STORAGE_KEY));
  /** Plugin DEFAULT_OFF accesi dalla persona. */
  readonly enabled = signal<ReadonlySet<BuiltinKey>>(this.load(ENABLED_KEY));
  readonly removed = signal<ReadonlySet<BuiltinKey>>(this.load(REMOVED_KEY));

  isInstalled(key: BuiltinKey): boolean {
    return !this.removed().has(key);
  }

  /** Install puts the card back in Installed and turns it on; Uninstall removes it and turns it off. */
  setInstalled(key: BuiltinKey, installed: boolean): void {
    const next = new Set(this.removed());
    if (installed) next.delete(key); else next.add(key);
    this.removed.set(next);
    try { localStorage.setItem(REMOVED_KEY, JSON.stringify([...next])); } catch { /* stays in memory */ }
    this.setOn(key, installed);
  }

  isOn(key: BuiltinKey): boolean {
    // Organization policy (Enterprise) wins over the local switch.
    if (key === 'auto-approve' && !this.orgPolicy.autoApproveAllowed()) return false;
    if (!this.orgPolicy.canEnableBuiltinPlugins()) return false;
    return DEFAULT_OFF.has(key) ? this.enabled().has(key) : !this.off().has(key);
  }

  setOn(key: BuiltinKey, on: boolean): void {
    if (DEFAULT_OFF.has(key)) {
      const enabled = new Set(this.enabled());
      if (on) enabled.add(key); else enabled.delete(key);
      this.enabled.set(enabled);
      try { localStorage.setItem(ENABLED_KEY, JSON.stringify([...enabled])); } catch { /* stays in memory */ }
      return;
    }
    const next = new Set(this.off());
    if (on) next.delete(key); else next.add(key);
    this.off.set(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...next])); } catch { /* stays in memory */ }
  }

  private load(storageKey: string): ReadonlySet<BuiltinKey> {
    try {
      const keys = JSON.parse(localStorage.getItem(storageKey) || '[]') as string[];
      return new Set(keys.filter((k): k is BuiltinKey => BUILTIN_PLUGINS.some((b) => b.key === k)));
    } catch {
      return new Set();
    }
  }
}
