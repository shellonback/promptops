import { isAgentLive, normalizeLastClosure } from './sub-agent.service';

describe('last closure — normalizeLastClosure', () => {
  it('returns null when there is nothing to show', () => {
    expect(normalizeLastClosure(null)).toBeNull();
    expect(normalizeLastClosure({ sessions: [] })).toBeNull();
    expect(normalizeLastClosure({ sessions: 'x' })).toBeNull();
  });

  it('maps stash-shaped agents onto archive entries without a parent', () => {
    const closure = normalizeLastClosure({
      savedAt: '2026-11-10T10:00:00.000Z',
      cleanExit: false,
      sessions: [
        {
          name: 'api',
          sessionId: 'local-1',
          dbId: 'db-1',
          workspacePath: '/w/api',
          standby: true,
          agents: [
            { role: 'reviewer', title: 'Review', prompt: 'check it', claudeSessionId: 'c-1', workspacePath: '/w/api/wt' },
            { role: 'tester', title: 'Tests' },
            null,
          ],
        },
        { sessionId: 'nameless' },
      ],
    })!;
    expect(closure.cleanExit).toBeFalse();
    expect(closure.sessions.length).toBe(1);
    const [first, second] = closure.sessions[0].agents;
    expect(closure.sessions[0].agents.length).toBe(2);
    // Not an archive row: clearing after a resume must not touch the archive.
    expect(first.parentSessionId).toBe('');
    expect(first.parentSessionName).toBe('api');
    expect(first.userPrompt).toBe('check it');
    expect(first.canResume).toBeTrue();
    expect(first.workspacePath).toBe('/w/api/wt');
    expect(second.canResume).toBeFalse();
    expect(second.workspacePath).toBe('/w/api');
    expect(second.provider).toBe('claude-code-cli');
  });
});

describe('last closure — which sessions count as open', () => {
  it('drops parked sessions without agents and keeps awake ones', () => {
    const closure = normalizeLastClosure({
      sessions: [
        { name: 'parked-empty', standby: true, agents: [] },
        { name: 'awake-empty', standby: false, agents: [] },
        { name: 'parked-with-agents', standby: true, agents: [{ role: 'r', title: 't' }] },
      ],
    })!;
    expect(closure.sessions.map((s) => s.name)).toEqual(['awake-empty', 'parked-with-agents']);
    expect(normalizeLastClosure({ sessions: [{ name: 'p', standby: true, agents: [] }] })).toBeNull();
  });
});

describe('last closure — isAgentLive', () => {
  const agent = (over: object) =>
    ({ role: 'reviewer', title: 'Review', ...over }) as any;

  it('matches by conversation id when both sides have one', () => {
    expect(isAgentLive(agent({ claudeSessionId: 'c-1' }), [{ claudeSessionId: 'c-1', role: 'x', title: 'y' }])).toBeTrue();
    expect(isAgentLive(agent({ claudeSessionId: 'c-1' }), [{ claudeSessionId: 'c-2', role: 'reviewer', title: 'Review' }])).toBeFalse();
  });

  it('falls back to role and title when an id is missing', () => {
    expect(isAgentLive(agent({}), [{ claudeSessionId: 'c-9', role: 'reviewer', title: 'Review' }])).toBeTrue();
    expect(isAgentLive(agent({}), [{ role: 'reviewer', title: 'Other' }])).toBeFalse();
    expect(isAgentLive(agent({}), [])).toBeFalse();
  });
});
