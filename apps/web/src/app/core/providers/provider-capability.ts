export type ProviderTier = 'cloud' | 'local';
export type ProviderAccent = 'indigo' | 'purple' | 'violet' | 'fuchsia' | 'emerald' | 'slate' | 'cyan';

export type ProviderId =
  | 'claude-code-cli'
  | 'codex'
  | 'gemini-cli'
  | 'antigravity'
  | 'copilot'
  | 'cursor'
  | 'grok'
  | 'hermes'
  | 'muse'
  | 'zai'
  | 'kimi'
  | 'opencode'
  | 'kora'
  | 'promptops-cli'
  | 'generic-shell';

export interface ProviderCapability {
  id: ProviderId;
  displayName: string;
  tier: ProviderTier;
  requiresApiKey: boolean;
  offlineCapable: boolean;
  cli: {
    command: string;
    installHintKey: string;
    detectable: boolean;
  };
  capabilities: {
    reasoning: boolean;
    execution: boolean;
    longContext: boolean;
    toolUse: boolean;
  };
  suggestionWeights?: {
    refactor: number;
    debug: number;
    planning: number;
    explore: number;
  };
  i18n: {
    bestForKey: string;
    limitationsKey: string;
    microcopyKey: string;
  };
  ui: {
    icon: string;
    accent: ProviderAccent;
    badgeKey?: string;
  };
}
