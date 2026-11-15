import { HARD_PATTERNS, MODEL_SCOPED_PATTERNS, defaultNameAfterSwitch, formatMainHandoff, stripAnsi } from './provider-limit.service';

const isLimit = (text: string) => {
  const clean = stripAnsi(text);
  return HARD_PATTERNS.some((re) => re.test(clean)) && !MODEL_SCOPED_PATTERNS.some((re) => re.test(clean));
};

describe('ProviderLimitService — limit messages', () => {
  it('recognizes the real quota messages of the CLIs we ship', () => {
    expect(isLimit('Claude usage limit reached. Your limit will reset at 5pm')).toBeTrue();
    expect(isLimit("\u001b[31m■ You've hit your usage limit. Upgrade to Pro or try again in 2 days 3 hours.\u001b[0m")).toBeTrue();
    expect(isLimit('stream error: usage_limit_reached')).toBeTrue();
    expect(isLimit('Quota exceeded for quota metric \'Gemini 2.5 Pro Requests\'')).toBeTrue();
    expect(isLimit('You have exhausted your daily quota on this model.')).toBeTrue();
    expect(isLimit('You have exceeded your premium request allowance.')).toBeTrue();
    expect(isLimit('Error 429: {"error":{"code":"insufficient_quota"}}')).toBeTrue();
  });

  it('ignores transient rate limits and model-bucket fallbacks', () => {
    expect(isLimit('Rate limited, retrying in 5s…')).toBeFalse();
    expect(isLimit('429 Too Many Requests')).toBeFalse();
    expect(isLimit('Opus weekly limit reached · now using Sonnet')).toBeFalse();
  });
});

describe('ProviderLimitService — switch helpers', () => {
  it('renames only default-style names', () => {
    expect(defaultNameAfterSwitch('Claude 2', 'Claude Code', 'Codex')).toBe('Codex 2');
    expect(defaultNameAfterSwitch('Claude Code', 'Claude Code', 'Codex')).toBe('Codex');
    expect(defaultNameAfterSwitch('claude 3', 'Claude Code', 'Gemini CLI')).toBe('Gemini CLI 3');
    expect(defaultNameAfterSwitch('Refactor auth', 'Claude Code', 'Codex')).toBeNull();
    expect(defaultNameAfterSwitch('Claude refactor', 'Claude Code', 'Codex')).toBeNull();
    expect(defaultNameAfterSwitch('Codex 2', 'Codex', 'Codex')).toBeNull();
  });

  it('carries the user instructions, files and tail into the handoff', () => {
    const text = formatMainHandoff({
      sessionName: 'Test-project',
      fromLabel: 'Claude Code',
      manual: true,
      userMessages: ['list shows newest first', 'done moves items\nto archivio.json'],
      changedFiles: ' M ux-test/todo.py',
      subAgents: [],
      tail: 'last output',
    });
    expect(text).toContain('(the user switched provider)');
    expect(text).toContain('- list shows newest first');
    expect(text).toContain('- done moves items to archivio.json');
    expect(text).toContain('M ux-test/todo.py');
    expect(text).toContain('last output');
    expect(text).not.toContain('Sub-agents');
  });

  it('puts the session state first, and leaves the handoff unchanged without it', () => {
    const base = { sessionName: 's', fromLabel: 'Claude Code', manual: true, userMessages: ['keep tests green'], changedFiles: '', subAgents: [], tail: '' };
    const without = formatMainHandoff(base);
    expect(formatMainHandoff({ ...base, sessionState: null })).toBe(without);
    expect(formatMainHandoff({ ...base, sessionState: '   ' })).toBe(without);
    const text = formatMainHandoff({ ...base, sessionState: '### state.md\nStatus: IN_PROGRESS', restart: true });
    expect(text).toContain('clean restart');
    const state = text.indexOf('## Session state kept by the previous agent');
    const asked = text.indexOf('## What the user asked so far');
    expect(state).toBeGreaterThan(0);
    expect(state).toBeLessThan(asked);
    expect(text).toContain('Status: IN_PROGRESS');
  });

  it('says "usage limit" only when the switch comes from a limit', () => {
    const base = { sessionName: 's', fromLabel: 'Codex', userMessages: [], changedFiles: '', subAgents: [], tail: '' };
    expect(formatMainHandoff({ ...base, manual: false })).toContain('it hit its usage limit');
    expect(formatMainHandoff({ ...base, manual: true })).not.toContain('usage limit');
  });
});
