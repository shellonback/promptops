import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { AGENTS_MODEL } from './agents-model.token';
import { AgentRosterService, AgentsMeta } from './agent-roster.service';
import type { SubAgent } from '../services/sub-agent.service';

describe('AgentRosterService', () => {
  let service: AgentRosterService;

  beforeEach(() => {
    (window as any).promptops = { agentsMetaGet: () => Promise.resolve({ leadClosed: false, order: [] }) };
    TestBed.configureTestingModule({ providers: [
      { provide: AGENTS_MODEL, useValue: true },
      { provide: TranslateService, useValue: { instant: (key: string) => `t:${key}` } },
    ] });
    service = TestBed.inject(AgentRosterService);
  });

  afterEach(() => { delete (window as any).promptops; });

  it('titles an unnamed lead with the translated label', async () => {
    await service.load('s1');
    const roster = service.rosterFor({ id: 's1', name: '' }, [{ id: 'a1' } as any]);
    expect(roster[0].id).toBe(AgentRosterService.LEAD_PANE_ID);
    expect(roster[0].title).toBe('t:SUBAGENTS.Lead');
  });

  it('keeps the session name when there is one', async () => {
    await service.load('s1');
    const roster = service.rosterFor({ id: 's1', name: 'api' }, [{ id: 'a1' } as any]);
    expect(roster[0].title).toBe('api');
  });
  it('reports a failed close or reopen of the lead (and rolls the tile back)', async () => {
    (window as any).promptops.agentsCloseLead = () => Promise.reject('ipc down');
    (window as any).promptops.agentsReopenLead = () => Promise.reject('ipc down');
    expect(await service.closeLead('s1')).toBeFalse();
    expect(service.leadClosed('s1')).toBeFalse();
    (window as any).promptops.agentsCloseLead = () => Promise.resolve({ leadClosed: true, order: [] });
    expect(await service.closeLead('s1')).toBeTrue();
    expect(await service.reopenLead('s1')).toBeFalse();
    expect(service.leadClosed('s1')).toBeTrue();
  });
});

describe('AgentRosterService rosterFor', () => {
  let roster: AgentRosterService;
  let savedApi: unknown;
  const session = { id: 's1', name: 'Solo', status: 'running', provider: 'claude-code-cli' };
  const sub = { id: 'sa-1', role: 'custom', title: 'Worker', parentSessionId: 's1' } as SubAgent;

  async function loadMeta(meta: Partial<AgentsMeta>): Promise<void> {
    (window as any).promptops = { agentsMetaGet: () => Promise.resolve(meta) };
    await roster.load('s1');
  }

  beforeEach(() => {
    savedApi = (window as any).promptops;
    TestBed.configureTestingModule({ providers: [
      { provide: AGENTS_MODEL, useValue: true },
      { provide: TranslateService, useValue: { instant: (key: string) => `t:${key}` } },
    ] });
    roster = TestBed.inject(AgentRosterService);
  });

  afterEach(() => {
    (window as any).promptops = savedApi;
  });

  it('shows a lone lead when asked to, once the meta are loaded', async () => {
    await loadMeta({});
    const panes = roster.rosterFor(session, [], true);
    expect(panes.map((p) => p.id)).toEqual([AgentRosterService.LEAD_PANE_ID]);
    expect(panes[0].status).toBe('running' as SubAgent['status']);
  });

  it('keeps a lone session as a single pane without the flag', async () => {
    await loadMeta({});
    expect(roster.rosterFor(session, [])).toEqual([]);
  });

  it('never shows a lead the user closed', async () => {
    await loadMeta({ leadClosed: true });
    expect(roster.rosterFor(session, [], true)).toEqual([]);
    expect(roster.rosterFor(session, [sub], true)).toEqual([sub]);
  });

  it('hides the lead until the meta are loaded', () => {
    (window as any).promptops = { agentsMetaGet: () => new Promise(() => {}) };
    expect(roster.rosterFor(session, [], true)).toEqual([]);
  });

  it('puts the lead first when there are members', async () => {
    await loadMeta({});
    expect(roster.rosterFor(session, [sub]).map((p) => p.id)).toEqual([AgentRosterService.LEAD_PANE_ID, 'sa-1']);
  });

  it('carries waiting_input over to the lead', async () => {
    await loadMeta({});
    const panes = roster.rosterFor({ ...session, status: 'waiting_input' }, [], true);
    expect(panes[0].status).toBe('waiting_input' as SubAgent['status']);
  });
});
