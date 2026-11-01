/**
 * AI providers a plugin can declare in its manifest (`providers`, optional).
 * It is the author's statement: "works with these". The catalog shows the first three as small icons.
 * Aligned with `PROVIDERS` in promptops-plugin-templates/playground/lib/policy.mjs and `PluginCodeScanner::PROVIDERS`.
 * The logos are the same as in AI Accounts and the spawn picker.
 */
export interface PluginProvider { id: string; label: string; logo: string }

const KNOWN: Record<string, [label: string, logo: string]> = {
  'claude-code-cli': ['Claude Code', 'claude'], codex: ['Codex', 'openai'], 'gemini-cli': ['Gemini', 'gemini'], antigravity: ['Antigravity', 'antigravity'],
  copilot: ['GitHub Copilot', 'copilot'], cursor: ['Cursor', 'cursor'], grok: ['Grok', 'grok'], hermes: ['Hermes', 'hermes'], muse: ['Muse Code', 'muse'], zai: ['Z.AI', 'zai'],
  kimi: ['Kimi', 'kimi'], opencode: ['Opencode', 'terminal'], kora: ['Kora', 'kora'],
};

/** How many icons fit in the catalog card. The rest become "+N". */
export const PROVIDERS_SHOWN = 3;

/** Only known ids, no duplicates, in the order chosen by the author. The value comes from a manifest: it is external data. */
export function declaredProviders(raw: unknown): PluginProvider[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PluginProvider[] = [];
  for (const id of raw) {
    if (typeof id !== 'string' || seen.has(id) || !(id in KNOWN)) continue;
    seen.add(id);
    out.push({ id, label: KNOWN[id][0], logo: `assets/providers/${KNOWN[id][1]}.svg` });
  }
  return out;
}
