import { ProviderType } from '../../../../../store/sessions/session.state';

/** Single source for the spawn/switch provider choices (composer chip + install-guide escape hatch). */
export const SPAWN_PROVIDERS: ReadonlyArray<{ value: ProviderType; labelKey: string }> = [
  { value: 'claude-code-cli', labelKey: 'SESSIONS.Claude Code CLI' },
  { value: 'codex', labelKey: 'SESSIONS.Codex' },
  { value: 'gemini-cli', labelKey: 'SESSIONS.Gemini CLI' },
  { value: 'antigravity', labelKey: 'SESSIONS.Antigravity' },
  { value: 'copilot', labelKey: 'SESSIONS.Copilot' },
  { value: 'cursor', labelKey: 'SESSIONS.Cursor' },
  { value: 'grok', labelKey: 'SESSIONS.Grok' },
  { value: 'hermes', labelKey: 'SESSIONS.Hermes' },
  { value: 'muse', labelKey: 'SESSIONS.Muse Code' },
  { value: 'zai', labelKey: 'SESSIONS.ZAI' },
  { value: 'kimi', labelKey: 'SESSIONS.Kimi' },
  { value: 'opencode', labelKey: 'SESSIONS.Opencode' },
  { value: 'kora', labelKey: 'SESSIONS.Kora' },
  { value: 'promptops-cli', labelKey: 'SESSIONS.PromptOps CLI' },
  { value: 'generic-shell', labelKey: 'SESSIONS.Generic Shell' },
];

/** Provider logos (assets/providers/*.svg) — shared by the spawn chip and the limit modal. */
export const PROVIDER_LOGOS: Record<string, string> = {
  'claude-code-cli': 'assets/providers/claude.svg',
  'codex': 'assets/providers/openai.svg',
  'gemini-cli': 'assets/providers/gemini.svg',
  'antigravity': 'assets/providers/antigravity.svg',
  'copilot': 'assets/providers/copilot.svg',
  'cursor': 'assets/providers/cursor.svg',
  'grok': 'assets/providers/grok.svg',
  'hermes': 'assets/providers/hermes.svg',
  'muse': 'assets/providers/muse.svg',
  'zai': 'assets/providers/zai.svg',
  'kimi': 'assets/providers/kimi.svg',
  'opencode': 'assets/providers/terminal.svg',
  'kora': 'assets/providers/kora.svg',
  'promptops-cli': 'assets/providers/terminal.svg',
  'generic-shell': 'assets/providers/terminal.svg',
};
