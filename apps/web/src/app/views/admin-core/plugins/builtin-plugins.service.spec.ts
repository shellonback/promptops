import { TestBed } from '@angular/core/testing';
import { OrgPolicyService } from '@core/services/org-policy.service';
import { InteractionService } from '../sessions/services/interaction.service';
import { BuiltinPluginsService } from './builtin-plugins.service';

describe('BuiltinPluginsService: Auto Approve off by default', () => {
  beforeEach(() => {
    localStorage.removeItem('po.builtinPlugins.off');
    localStorage.removeItem('po.builtinPlugins.on');
    TestBed.configureTestingModule({
      providers: [{ provide: OrgPolicyService, useValue: { autoApproveAllowed: () => true, canEnableBuiltinPlugins: () => true } }],
    });
  });
  afterEach(() => ['on', 'off'].forEach((k) => localStorage.removeItem('po.builtinPlugins.' + k)));

  it('starts off while the other built-ins stay on', () => {
    const builtins = TestBed.inject(BuiltinPluginsService);
    expect(builtins.isOn('auto-approve')).toBeFalse();
    expect(builtins.isOn('docker')).toBeTrue();
  });

  it('stays on after an explicit choice and turns off again', () => {
    const builtins = TestBed.inject(BuiltinPluginsService);
    builtins.setOn('auto-approve', true);
    expect(builtins.isOn('auto-approve')).toBeTrue();
    expect(JSON.parse(localStorage.getItem('po.builtinPlugins.on')!)).toEqual(['auto-approve']);
    builtins.setOn('auto-approve', false);
    expect(builtins.isOn('auto-approve')).toBeFalse();
  });

  it('rejects the flags and stops armed ones when the plugin is off', async () => {
    const interactions = TestBed.inject(InteractionService);
    await interactions.setFlags('s1', { quick: true });
    expect(interactions.isAutoApproved('s1')).toBeFalse();

    const builtins = TestBed.inject(BuiltinPluginsService);
    builtins.setOn('auto-approve', true);
    await interactions.setFlags('s1', { quick: true });
    expect(interactions.isAutoApproved('s1')).toBeTrue();

    builtins.setOn('auto-approve', false);
    TestBed.flushEffects();
    expect(interactions.isAutoApproved('s1')).toBeFalse();
  });
});

describe('BuiltinPluginsService: Agents Dashboard and Floor Plan', () => {
  beforeEach(() => {
    localStorage.removeItem('po.builtinPlugins.off');
    localStorage.removeItem('po.builtinPlugins.on');
    TestBed.configureTestingModule({
      providers: [{ provide: OrgPolicyService, useValue: { autoApproveAllowed: () => true, canEnableBuiltinPlugins: () => true } }],
    });
  });
  afterEach(() => ['on', 'off'].forEach((k) => localStorage.removeItem('po.builtinPlugins.' + k)));

  it('starts with Agents Dashboard on and Floor Plan off', () => {
    const builtins = TestBed.inject(BuiltinPluginsService);
    expect(builtins.isOn('agents-dashboard')).toBeTrue();
    expect(builtins.isOn('floor-plan')).toBeFalse();
  });

  it('turns Floor Plan on with an explicit choice, and an explicit off wins over the default', () => {
    const builtins = TestBed.inject(BuiltinPluginsService);
    builtins.setOn('floor-plan', true);
    expect(builtins.isOn('floor-plan')).toBeTrue();
    builtins.setOn('docker', false);
    expect(builtins.isOn('docker')).toBeFalse();
    builtins.setOn('docker', true);
    expect(builtins.isOn('docker')).toBeTrue();
  });
});
