import { Injectable, inject, signal } from '@angular/core';
import { OrgPolicyService } from '@core/services/org-policy.service';
import { ProviderCapability, ProviderId, ProviderTier } from '../providers/provider-capability';
import { User } from '@core/models/user';

declare global {
  interface Window {
    promptops?: {
      listProviderCapabilities?: () => Promise<{ ok: boolean; data: ProviderCapability[] }>;
      detectProviders?: (force?: boolean) => Promise<{ ok: boolean; data: ProviderId[] }>;
    };
  }
}

/**
 * Fallback manifest used when running outside the desktop app (browser dev, tests,
 * web manager) or before the IPC detection resolves. Mirrors the full desktop
 * registry so every provider — including hermes — shows up in pickers; CLI
 * detection is disabled (`detectable: false`) so nothing spawns in the browser.
 */
const BROWSER_FALLBACK: ProviderCapability[] = [
  {
    id: 'claude-code-cli', displayName: 'Claude Code', tier: 'cloud',
    requiresApiKey: true, offlineCapable: false,
    cli: { command: 'claude', installHintKey: 'PROVIDERS.CLAUDE.INSTALL_HINT', detectable: false },
    capabilities: { reasoning: true, execution: true, longContext: true, toolUse: true },
    i18n: {
      bestForKey: 'PROVIDERS.CLAUDE.BEST_FOR',
      limitationsKey: 'PROVIDERS.CLAUDE.LIMITATIONS',
      microcopyKey: 'PROVIDERS.CLAUDE.MICROCOPY',
    },
    ui: { icon: 'ti-sparkles', accent: 'indigo', badgeKey: 'PROVIDERS.BADGE.RECOMMENDED' },
  },
  {
    id: 'codex', displayName: 'Codex', tier: 'cloud',
    requiresApiKey: true, offlineCapable: false,
    cli: { command: 'codex', installHintKey: 'PROVIDERS.CODEX.INSTALL_HINT', detectable: false },
    capabilities: { reasoning: true, execution: true, longContext: false, toolUse: true },
    i18n: {
      bestForKey: 'PROVIDERS.CODEX.BEST_FOR',
      limitationsKey: 'PROVIDERS.CODEX.LIMITATIONS',
      microcopyKey: 'PROVIDERS.CODEX.MICROCOPY',
    },
    ui: { icon: 'ti-brand-openai', accent: 'purple' },
  },
  {
    id: 'gemini-cli', displayName: 'Gemini', tier: 'cloud',
    requiresApiKey: true, offlineCapable: false,
    cli: { command: 'gemini', installHintKey: 'PROVIDERS.GEMINI.INSTALL_HINT', detectable: false },
    capabilities: { reasoning: true, execution: true, longContext: true, toolUse: true },
    i18n: {
      bestForKey: 'PROVIDERS.GEMINI.BEST_FOR',
      limitationsKey: 'PROVIDERS.GEMINI.LIMITATIONS',
      microcopyKey: 'PROVIDERS.GEMINI.MICROCOPY',
    },
    ui: { icon: 'ti-brand-google', accent: 'violet' },
  },
  {
    id: 'antigravity', displayName: 'Antigravity', tier: 'cloud',
    requiresApiKey: true, offlineCapable: false,
    cli: { command: 'agy', installHintKey: 'PROVIDERS.ANTIGRAVITY.INSTALL_HINT', detectable: false },
    capabilities: { reasoning: true, execution: true, longContext: true, toolUse: true },
    i18n: {
      bestForKey: 'PROVIDERS.ANTIGRAVITY.BEST_FOR',
      limitationsKey: 'PROVIDERS.ANTIGRAVITY.LIMITATIONS',
      microcopyKey: 'PROVIDERS.ANTIGRAVITY.MICROCOPY',
    },
    ui: { icon: 'ti-rocket', accent: 'cyan', badgeKey: 'PROVIDERS.BADGE.NEW' },
  },
  {
    id: 'copilot', displayName: 'GitHub Copilot', tier: 'cloud',
    requiresApiKey: true, offlineCapable: false,
    cli: { command: 'copilot', installHintKey: 'PROVIDERS.COPILOT.INSTALL_HINT', detectable: false },
    capabilities: { reasoning: true, execution: true, longContext: false, toolUse: true },
    i18n: {
      bestForKey: 'PROVIDERS.COPILOT.BEST_FOR',
      limitationsKey: 'PROVIDERS.COPILOT.LIMITATIONS',
      microcopyKey: 'PROVIDERS.COPILOT.MICROCOPY',
    },
    ui: { icon: 'ti-brand-github', accent: 'fuchsia' },
  },
  {
    id: 'cursor', displayName: 'Cursor', tier: 'cloud',
    requiresApiKey: true, offlineCapable: false,
    cli: { command: 'cursor-agent', installHintKey: 'PROVIDERS.CURSOR.INSTALL_HINT', detectable: false },
    capabilities: { reasoning: true, execution: true, longContext: false, toolUse: true },
    i18n: {
      bestForKey: 'PROVIDERS.CURSOR.BEST_FOR',
      limitationsKey: 'PROVIDERS.CURSOR.LIMITATIONS',
      microcopyKey: 'PROVIDERS.CURSOR.MICROCOPY',
    },
    ui: { icon: 'ti-cursor-text', accent: 'purple' },
  },
  {
    id: 'grok', displayName: 'Grok', tier: 'cloud',
    requiresApiKey: true, offlineCapable: false,
    cli: { command: 'grok', installHintKey: 'PROVIDERS.GROK.INSTALL_HINT', detectable: false },
    capabilities: { reasoning: true, execution: true, longContext: true, toolUse: true },
    i18n: {
      bestForKey: 'PROVIDERS.GROK.BEST_FOR',
      limitationsKey: 'PROVIDERS.GROK.LIMITATIONS',
      microcopyKey: 'PROVIDERS.GROK.MICROCOPY',
    },
    ui: { icon: 'ti-brand-x', accent: 'slate', badgeKey: 'PROVIDERS.BADGE.NEW' },
  },
  {
    id: 'hermes', displayName: 'Hermes', tier: 'cloud',
    requiresApiKey: true, offlineCapable: false,
    cli: { command: 'hermes', installHintKey: 'PROVIDERS.HERMES.INSTALL_HINT', detectable: false },
    capabilities: { reasoning: true, execution: true, longContext: true, toolUse: true },
    i18n: {
      bestForKey: 'PROVIDERS.HERMES.BEST_FOR',
      limitationsKey: 'PROVIDERS.HERMES.LIMITATIONS',
      microcopyKey: 'PROVIDERS.HERMES.MICROCOPY',
    },
    ui: { icon: 'ti-feather', accent: 'violet', badgeKey: 'PROVIDERS.BADGE.NEW' },
  },
  {
    id: 'muse', displayName: 'Muse Code', tier: 'cloud',
    requiresApiKey: true, offlineCapable: false,
    cli: { command: 'muse', installHintKey: 'PROVIDERS.MUSE.INSTALL_HINT', detectable: false },
    capabilities: { reasoning: true, execution: true, longContext: true, toolUse: true },
    i18n: {
      bestForKey: 'PROVIDERS.MUSE.BEST_FOR',
      limitationsKey: 'PROVIDERS.MUSE.LIMITATIONS',
      microcopyKey: 'PROVIDERS.MUSE.MICROCOPY',
    },
    ui: { icon: 'ti-brand-meta', accent: 'violet', badgeKey: 'PROVIDERS.BADGE.NEW' },
  },
  {
    id: 'zai', displayName: 'Z.AI', tier: 'cloud',
    requiresApiKey: true, offlineCapable: false,
    cli: { command: 'claude', installHintKey: 'PROVIDERS.ZAI.INSTALL_HINT', detectable: false },
    capabilities: { reasoning: true, execution: true, longContext: true, toolUse: true },
    i18n: {
      bestForKey: 'PROVIDERS.ZAI.BEST_FOR',
      limitationsKey: 'PROVIDERS.ZAI.LIMITATIONS',
      microcopyKey: 'PROVIDERS.ZAI.MICROCOPY',
    },
    ui: { icon: 'ti-letter-z', accent: 'cyan', badgeKey: 'PROVIDERS.BADGE.NEW' },
  },
  {
    id: 'kimi', displayName: 'Kimi', tier: 'cloud',
    requiresApiKey: true, offlineCapable: false,
    cli: { command: 'claude', installHintKey: 'PROVIDERS.KIMI.INSTALL_HINT', detectable: false },
    capabilities: { reasoning: true, execution: true, longContext: true, toolUse: true },
    i18n: {
      bestForKey: 'PROVIDERS.KIMI.BEST_FOR',
      limitationsKey: 'PROVIDERS.KIMI.LIMITATIONS',
      microcopyKey: 'PROVIDERS.KIMI.MICROCOPY',
    },
    ui: { icon: 'ti-letter-k', accent: 'violet', badgeKey: 'PROVIDERS.BADGE.NEW' },
  },
  {
    id: 'opencode', displayName: 'Opencode', tier: 'local',
    requiresApiKey: false, offlineCapable: true,
    cli: { command: 'opencode', installHintKey: 'PROVIDERS.OPENCODE.INSTALL_HINT', detectable: false },
    capabilities: { reasoning: false, execution: true, longContext: false, toolUse: true },
    i18n: {
      bestForKey: 'PROVIDERS.OPENCODE.BEST_FOR',
      limitationsKey: 'PROVIDERS.OPENCODE.LIMITATIONS',
      microcopyKey: 'PROVIDERS.OPENCODE.MICROCOPY',
    },
    ui: { icon: 'ti-bolt', accent: 'emerald', badgeKey: 'PROVIDERS.BADGE.FREE' },
  },
  {
    id: 'kora', displayName: 'Kora', tier: 'local',
    requiresApiKey: false, offlineCapable: false,
    cli: { command: 'kora', installHintKey: 'PROVIDERS.KORA.INSTALL_HINT', detectable: false },
    capabilities: { reasoning: true, execution: true, longContext: false, toolUse: true },
    suggestionWeights: { refactor: 0.85, debug: 0.7, planning: 0.7, explore: 0.6 },
    i18n: {
      bestForKey: 'PROVIDERS.KORA.BEST_FOR',
      limitationsKey: 'PROVIDERS.KORA.LIMITATIONS',
      microcopyKey: 'PROVIDERS.KORA.MICROCOPY',
    },
    ui: { icon: 'ti-sparkles', accent: 'violet', badgeKey: 'PROVIDERS.BADGE.NEW' },
  },
  {
    id: 'promptops-cli', displayName: 'PromptOps CLI', tier: 'local',
    requiresApiKey: false, offlineCapable: true,
    cli: { command: 'promptops-cli', installHintKey: 'PROVIDERS.PROMPTOPS_CLI.INSTALL_HINT', detectable: false },
    capabilities: { reasoning: true, execution: true, longContext: false, toolUse: true },
    i18n: {
      bestForKey: 'PROVIDERS.PROMPTOPS_CLI.BEST_FOR',
      limitationsKey: 'PROVIDERS.PROMPTOPS_CLI.LIMITATIONS',
      microcopyKey: 'PROVIDERS.PROMPTOPS_CLI.MICROCOPY',
    },
    ui: { icon: 'ti-terminal', accent: 'emerald', badgeKey: 'PROVIDERS.BADGE.FREE' },
  },
  {
    id: 'generic-shell', displayName: 'Plain Shell', tier: 'local',
    requiresApiKey: false, offlineCapable: true,
    cli: { command: 'sh', installHintKey: 'PROVIDERS.GENERIC_SHELL.INSTALL_HINT', detectable: false },
    capabilities: { reasoning: false, execution: true, longContext: false, toolUse: false },
    i18n: {
      bestForKey: 'PROVIDERS.GENERIC_SHELL.BEST_FOR',
      limitationsKey: 'PROVIDERS.GENERIC_SHELL.LIMITATIONS',
      microcopyKey: 'PROVIDERS.GENERIC_SHELL.MICROCOPY',
    },
    ui: { icon: 'ti-terminal-2', accent: 'slate' },
  },
];

@Injectable({ providedIn: 'root' })
export class ProviderService {
  private orgPolicy = inject(OrgPolicyService);
  private readonly _manifests = signal<ProviderCapability[]>([]);
  private readonly _detected = signal<Set<ProviderId>>(new Set());
  private loadPromise: Promise<void> | null = null;

  readonly manifests = this._manifests.asReadonly();
  readonly detected = this._detected.asReadonly();

  async listProviders(): Promise<ProviderCapability[]> {
    await this.load();
    // Organization policy (Enterprise): only the providers the admin allows.
    return this.orgPolicy.filterProviders(this._manifests(), (p) => p.id);
  }

  async getProvidersByTier(tier: ProviderTier): Promise<ProviderCapability[]> {
    return (await this.listProviders()).filter((p) => p.tier === tier);
  }

  isDetected(id: ProviderId): boolean {
    return this._detected().has(id);
  }

  /**
   * Resolve the default provider for the user:
   *   1. explicit user.preferred_provider
   *   2. 'opencode' if the local CLI is detected and no cloud CLI is
   *   3. 'claude-code-cli' as the historical fallback
   */
  async resolveDefaultProvider(user: User | null): Promise<ProviderId> {
    const resolved = await this.resolveDefaultProviderUnchecked(user);
    if (this.orgPolicy.isProviderAllowed(resolved)) return resolved;
    // The usual default is forbidden by the organization: first allowed one.
    return (this.orgPolicy.policy()?.allowed_providers?.[0] as ProviderId) ?? resolved;
  }

  private async resolveDefaultProviderUnchecked(user: User | null): Promise<ProviderId> {
    if (user?.preferred_provider) {
      return user.preferred_provider as ProviderId;
    }
    await this.load();
    const det = this._detected();
    const anyCloudAvailable = det.has('claude-code-cli')
      || det.has('codex')
      || det.has('gemini-cli')
      || det.has('antigravity')
      || det.has('copilot')
      || det.has('cursor')
      || det.has('grok')
      || det.has('hermes')
      || det.has('muse')
      || det.has('zai')
      || det.has('kimi');
    if (det.has('opencode') && !anyCloudAvailable) return 'opencode';
    return 'claude-code-cli';
  }

  /** Force re-detection (e.g. after the user installs a CLI). */
  async refreshDetection(): Promise<void> {
    if (!window.promptops?.detectProviders) return;
    try {
      const res = await window.promptops.detectProviders(true);
      if (res?.ok) this._detected.set(new Set(res.data));
    } catch { /* offline/no desktop bridge */ }
  }

  private load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      const api = window.promptops;
      if (!api?.listProviderCapabilities) {
        this._manifests.set(BROWSER_FALLBACK);
        return;
      }
      try {
        const res = await api.listProviderCapabilities();
        if (res?.ok) this._manifests.set(res.data);
        else this._manifests.set(BROWSER_FALLBACK);
      } catch {
        this._manifests.set(BROWSER_FALLBACK);
      }
      // Detection in background — do not block list consumers
      queueMicrotask(() => { void this.detectAll(); });
    })();
    return this.loadPromise;
  }

  private async detectAll(): Promise<void> {
    if (!window.promptops?.detectProviders) return;
    try {
      const res = await window.promptops.detectProviders(false);
      if (res?.ok) this._detected.set(new Set(res.data));
    } catch { /* best-effort */ }
  }
}
