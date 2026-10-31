import { Component, HostListener, OnDestroy, OnInit, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Store } from '@ngrx/store';
import { getActiveSession, getActiveSessionId } from '@/store/sessions/session.selectors';
import { TerminalManagerService } from '../terminal/services/terminal-manager.service';
import { TerminalInstanceComponent } from '../terminal/terminal-instance/terminal-instance.component';
import { TerminalBootLoaderComponent } from '../terminal/terminal-boot-loader.component';
import { AuditEntry, HIDDEN_PLUGIN_CATEGORIES } from './plugin-registry.service';
import { PluginRuntimeService, StudioPlugin, StudioZone } from './plugin-runtime.service';
import { PluginSessionButtonsComponent } from './plugin-session-buttons.component';
import { PluginPageComponent } from './plugin-page.component';
import { PluginConfigFormComponent } from './plugin-config-form.component';
import { PluginButtonPolicyComponent } from './plugin-button-policy.component';
import { TEMPLATES_REPO } from './plugin-section-guide';
import { terminalSafe } from './plugin-session-action';
import { PROVIDER_LOGOS } from '../sessions/services/spawn-providers.const';
import { MODEL_FLAGS, spawnModels } from '../sessions/services/model-labels';
import { effortOptions } from '../sessions/services/reasoning-effort';

type Tab = 'preview' | 'settings' | 'guide' | 'checks';
/** title: English name used for the draft folder, slug and agent prompt; the UI shows PLUGIN_STUDIO.Zone.<id> and ZoneInfo.<id>.*. */
interface ZoneInfo { id: StudioZone; title: string; icon: string }
interface Check { id: string; label: string; state: 'ok' | 'fail' | 'warn' | 'idle'; detail: string }

const ZONES: ZoneInfo[] = [
  { id: 'session-buttons', title: 'Terminal buttons', icon: 'ti-layout-bottombar' },
  { id: 'header-buttons', title: 'Session header', icon: 'ti-layout-navbar' },
  { id: 'composer-buttons', title: 'Spawn composer', icon: 'ti-writing' },
  { id: 'runtime-buttons', title: 'Squad · Goal · Worker row', icon: 'ti-layout-columns' },
  { id: 'page', title: 'Menu page', icon: 'ti-layout-sidebar' },
  { id: 'sidebar', title: 'Session sidebar', icon: 'ti-layout-sidebar-left-expand' },
  { id: 'tasks', title: 'Sprint board source', icon: 'ti-layout-kanban' },
];

const SESSION_GUIDE = {
    what: 'PLUGIN_STUDIO.Guide.Session what',
    code: `promptops.session.registerButtons({
  async action(buttonId, ctx) {
    // ctx.paneAgentId, ctx.agents, ctx.composerText (with composer:read)
    return { prompt: 'Review the last change', target: ctx.paneAgentId };
    // or { insert }, { spawn: { prompt, provider, mode } }, { panel }, { toast }
  },
});`,
    notes: [
      'PLUGIN_STUDIO.Guide.Session note recipient',
      'PLUGIN_STUDIO.Guide.Session note confirm',
      'PLUGIN_STUDIO.Guide.Session note output',
    ],
  };

const GUIDE: Record<StudioZone, { what: string; code: string; notes: string[] }> = {
  'session-buttons': SESSION_GUIDE,
  'header-buttons': { ...SESSION_GUIDE, notes: ['PLUGIN_STUDIO.Guide.Header note', ...SESSION_GUIDE.notes.slice(1)] },
  'composer-buttons': { ...SESSION_GUIDE, notes: ['PLUGIN_STUDIO.Guide.Composer note', ...SESSION_GUIDE.notes.slice(1)] },
  'runtime-buttons': { ...SESSION_GUIDE, notes: ['PLUGIN_STUDIO.Guide.Runtime note', ...SESSION_GUIDE.notes.slice(1)] },
  page: {
    what: 'PLUGIN_STUDIO.Guide.Page what',
    code: `promptops.pages.register({
  async open(pageId) { return { title: 'Hello', blocks: [{ type: 'text', text: 'Hi' }] }; },
  async event(pageId, ev, sdk) { /* ev.type: action | change, ev.values */ },
});`,
    notes: [
      'PLUGIN_STUDIO.Guide.Page note permissions',
      'PLUGIN_STUDIO.Guide.Page note confirm',
    ],
  },
  sidebar: {
    what: 'PLUGIN_STUDIO.Guide.Sidebar what',
    code: `promptops.pages.register({
  async open(pageId, ctx) {
    const ws = ctx.workspace; // { folders, workspaces, sessions: [{ id, name, status, agents }] }
    return { title: 'Floor plan', blocks: [{ type: 'floorplan', rooms: [
      { title: 'Work', desks: ws.sessions.map((s) => ({ title: s.name, status: s.status, session: s.id, agents: s.agents })) },
    ] }] };
  },
  async event(pageId, ev) { /* ev.values, ev.workspace */ },
});`,
    notes: [
      'PLUGIN_STUDIO.Guide.Sidebar note desk',
      'PLUGIN_STUDIO.Guide.Sidebar note status',
    ],
  },
  tasks: {
    what: 'PLUGIN_STUDIO.Guide.Tasks what',
    code: `promptops.tasks.registerSource({
  async validate(sdk) { /* check the token */ },
  async listContainers(parentId, sdk) { return [{ id: 'list:1', name: 'Sprint', hasChildren: false }]; },
  async listStatuses(containerId, sdk) { /* … */ },
  async listTasks(containerId, opts, sdk) { /* … */ },
});`,
    notes: ['PLUGIN_STUDIO.Guide.Tasks note http', 'PLUGIN_STUDIO.Guide.Tasks note fixtures'],
  },
};

/** Manual guide per zone: template repo folder and the first changes to make. */
const SESSION_MANUAL = { section: 'session', template: 'terminal buttons', makeItYours: [
    'PLUGIN_STUDIO.Manual.Session rename',
    'PLUGIN_STUDIO.Manual.Session action',
    'PLUGIN_STUDIO.Manual.Session service',
    'PLUGIN_STUDIO.Manual.Session tests',
  ] };

const MANUAL: Record<StudioZone, { section: string; template: string; makeItYours: string[] }> = {
  'session-buttons': SESSION_MANUAL,
  'header-buttons': { ...SESSION_MANUAL, makeItYours: ['PLUGIN_STUDIO.Manual.Header place', ...SESSION_MANUAL.makeItYours] },
  'composer-buttons': { ...SESSION_MANUAL, makeItYours: ['PLUGIN_STUDIO.Manual.Composer place', ...SESSION_MANUAL.makeItYours] },
  'runtime-buttons': { ...SESSION_MANUAL, makeItYours: ['PLUGIN_STUDIO.Manual.Runtime place', ...SESSION_MANUAL.makeItYours] },
  page: { section: 'pages', template: 'Release Notes', makeItYours: [
    'PLUGIN_STUDIO.Manual.Page entry',
    'PLUGIN_STUDIO.Manual.Page open',
    'PLUGIN_STUDIO.Manual.Page event',
    'PLUGIN_STUDIO.Manual.Page permissions',
  ] },
  sidebar: { section: 'pages', template: 'Release Notes (as a sidebar entry)', makeItYours: [
    'PLUGIN_STUDIO.Manual.Sidebar place',
    'PLUGIN_STUDIO.Manual.Sidebar permission',
    'PLUGIN_STUDIO.Manual.Sidebar floorplan',
    'PLUGIN_STUDIO.Manual.Sidebar remove',
  ] },
  tasks: { section: 'tasks', template: 'GitHub Issues', makeItYours: [
    'PLUGIN_STUDIO.Manual.Tasks host',
    'PLUGIN_STUDIO.Manual.Tasks helper',
    'PLUGIN_STUDIO.Manual.Tasks map',
    'PLUGIN_STUDIO.Manual.Tasks readonly',
  ] },
};

/** Agents that can write the plugin in the Studio terminal: same list and same flags as the spawn. */
const STUDIO_PROVIDERS: { id: string; label: string; binary: string; ready: RegExp | null }[] = [
  { id: 'claude-code-cli', label: 'Claude Code', binary: 'claude', ready: /Claude Code|Welcome to Claude|for shortcuts|\/help for help|shift\+tab to cycle/ },
  { id: 'codex', label: 'Codex', binary: 'codex', ready: /OpenAI Codex|Codex \(v|Codex v/ },
  { id: 'gemini-cli', label: 'Gemini CLI', binary: 'gemini', ready: null },
  { id: 'antigravity', label: 'Antigravity', binary: 'agy', ready: null },
  { id: 'copilot', label: 'GitHub Copilot', binary: 'copilot', ready: null },
  { id: 'cursor', label: 'Cursor', binary: 'cursor-agent', ready: null },
  { id: 'grok', label: 'Grok', binary: 'grok', ready: null },
  { id: 'hermes', label: 'Hermes', binary: 'hermes', ready: null },
  { id: 'muse', label: 'Muse Code', binary: 'muse', ready: null },
  { id: 'opencode', label: 'OpenCode', binary: 'opencode', ready: null },
  { id: 'kora', label: 'Kora', binary: 'kora', ready: null },
];
const CLI_KEY = 'po.pluginStudio.cli';
/** Model and effort only from known lists: they end up in a shell line. */
const SAFE_ARG = /^[A-Za-z0-9._-]{1,64}$/;

const CURRENT_KEY = 'po.pluginStudio.current';
const SHELL_PROMPT_RE = /\x1b\[\?2004h/;
/** The CLI found nothing to resume (claude: "No conversation found to continue"). */
const RESUME_FAILED_RE = /No\s*conversation\s*found|No\s*(recent\s*)?sessions?\s*(found|to\s*resume)|nothing\s*to\s*(resume|continue)|command not found|unknown (option|argument)/i;

/**
 * Plugin Studio. On the left a real terminal with Claude Code in the plugin folder and the
 * prompt already pasted (the person presses Enter); on the right a preview of the chosen zone,
 * settings as whoever installs it will see them, guide and checks. The plugin runs in the same
 * sandbox as published plugins: the Studio has no extra privileges.
 */
@Component({
  selector: 'app-plugin-studio',
  standalone: true,
  imports: [TranslateModule, TerminalInstanceComponent, TerminalBootLoaderComponent, PluginSessionButtonsComponent, PluginPageComponent, PluginConfigFormComponent, PluginButtonPolicyComponent],
  template: `
    @if (!runtime.available) {
      <div class="ps-wrap"><div class="ps-notice">{{ 'PLUGIN_STUDIO.Desktop only' | translate }}</div></div>
    } @else {
      <div class="ps-studio">
        <header class="ps-top">
          <div class="ps-title">
            <label class="ps-zone-pick">
              <span class="ps-cap-inline">{{ 'PLUGIN_STUDIO.Where it acts' | translate }}</span>
              <select class="form-select form-select-sm" [disabled]="busy()" (change)="changeZone($any($event.target).value)" [attr.aria-label]="'PLUGIN_STUDIO.Where the plugin acts' | translate">
                @for (z of zones; track z.id) { <option [value]="z.id" [selected]="plugin()?.zone === z.id">{{ 'PLUGIN_STUDIO.Zone.' + z.id | translate }}</option> }
              </select>
            </label>
            <button type="button" class="ps-info" (click)="zonesOpen.set(true)" [attr.aria-label]="'PLUGIN_STUDIO.What each zone is' | translate" [title]="'PLUGIN_STUDIO.What each zone is' | translate"><i class="ti ti-info-circle" aria-hidden="true"></i></button>
            @if (plugin(); as p) {
              <span class="ps-name"><i class="ti ti-puzzle" aria-hidden="true"></i> <strong>{{ p.name }}</strong></span>
              <span class="ps-id">{{ p.pluginId }}</span>
              <span class="ps-path" [title]="p.path">{{ p.path }}</span>
            } @else if (busy()) { <span class="ps-id">{{ 'PLUGIN_STUDIO.Preparing folder' | translate }}</span> }
          </div>
          <div class="ps-top-actions">
            <button type="button" class="ps-btn" (click)="reload()" [disabled]="reloading() || !plugin()" [title]="'PLUGIN_STUDIO.Reload hint' | translate">
              <i class="ti ti-refresh" aria-hidden="true"></i> {{ (reloading() ? 'PLUGIN_STUDIO.Reloading' : 'PLUGIN_STUDIO.Reload') | translate }}
            </button>
            <button type="button" class="ps-btn ghost" (click)="newDraft(plugin()?.zone ?? 'session-buttons')" [disabled]="busy()">{{ 'PLUGIN_STUDIO.New plugin' | translate }}</button>
          </div>
        </header>
        @if (error()) { <div class="ps-error">{{ error() }}</div> }

        @if (zonesOpen()) {
          <div class="ps-backdrop" (click)="zonesOpen.set(false)"></div>
          <div class="ps-modal" role="dialog" aria-modal="true" aria-labelledby="ps-zones-title">
            <div class="ps-modal-head"><strong id="ps-zones-title">{{ 'PLUGIN_STUDIO.Zones title' | translate }}</strong>
              <button type="button" class="ps-x" (click)="zonesOpen.set(false)" [attr.aria-label]="'PLUGIN_STUDIO.Close' | translate"><i class="ti ti-x" aria-hidden="true"></i></button></div>
            <div class="ps-modal-body">
              <p class="ps-lead muted">{{ 'PLUGIN_STUDIO.Zones lead' | translate }}</p>
              @for (z of zones; track z.id) {
                <div class="ps-zone-row" [class.on]="plugin()?.zone === z.id">
                  <div class="ps-zone-icon"><i class="ti {{ z.icon }}" aria-hidden="true"></i></div>
                  <div class="ps-zone-text">
                    <strong>{{ 'PLUGIN_STUDIO.Zone.' + z.id | translate }}</strong>
                    <p>{{ 'PLUGIN_STUDIO.ZoneInfo.' + z.id + '.Blurb' | translate }}</p>
                    <p class="muted"><b>{{ 'PLUGIN_STUDIO.Where you see it' | translate }}</b> {{ 'PLUGIN_STUDIO.ZoneInfo.' + z.id + '.Where' | translate }}</p>
                    <p class="muted"><b>{{ 'PLUGIN_STUDIO.Example' | translate }}</b> {{ 'PLUGIN_STUDIO.ZoneInfo.' + z.id + '.Example' | translate }}</p>
                  </div>
                  <button type="button" class="ps-btn" [disabled]="busy()" (click)="zonesOpen.set(false); changeZone(z.id)">{{ (plugin()?.zone === z.id ? 'PLUGIN_STUDIO.Current' : 'PLUGIN_STUDIO.Use this') | translate }}</button>
                </div>
              }
            </div>
          </div>
        }

        @if (plugin()) {
        <div class="ps-split">
          <section class="ps-left" [attr.aria-label]="'PLUGIN_STUDIO.Cli.Terminal' | translate">
            <!-- Same block as the spawn composer: provider, model, effort. Changing it restarts the CLI in the terminal. -->
            <div class="ps-cli-bar">
              <label class="ps-cli-chip" [title]="'PLUGIN_STUDIO.Cli.Agent' | translate: { agent: cliLabel() }">
                <img [src]="cliLogo()" width="14" height="14" alt="">
                <span>{{ cliLabel() }}</span>
                <i class="ti ti-chevron-down" aria-hidden="true"></i>
                <select (change)="setCli($any($event.target).value, null, null)" [attr.aria-label]="'PLUGIN_STUDIO.Cli.Agent select' | translate">
                  @for (p of cliProviders; track p.id) { <option [value]="p.id" [selected]="p.id === cliProvider()">{{ p.label }}</option> }
                </select>
              </label>
              @if (cliModels().length) {
                <label class="ps-cli-chip" [title]="'PLUGIN_STUDIO.Cli.Model' | translate">
                  <span>{{ cliModelLabel() || ('PLUGIN_STUDIO.Default model' | translate) }}</span><i class="ti ti-chevron-down" aria-hidden="true"></i>
                  <select (change)="setCli(cliProvider(), $any($event.target).value || null, cliEffort())" [attr.aria-label]="'PLUGIN_STUDIO.Cli.Model' | translate">
                    <option value="" [selected]="!cliModel()">{{ 'PLUGIN_STUDIO.Default model' | translate }}</option>
                    @for (m of cliModels(); track m.id) { <option [value]="m.id" [selected]="m.id === cliModel()">{{ m.label }}</option> }
                  </select>
                </label>
              }
              @if (cliEfforts().length) {
                <label class="ps-cli-chip" [title]="'PLUGIN_STUDIO.Cli.Effort' | translate">
                  <span>{{ cliEffort() || ('PLUGIN_STUDIO.Effort' | translate) }}</span><i class="ti ti-chevron-down" aria-hidden="true"></i>
                  <select (change)="setCli(cliProvider(), cliModel(), $any($event.target).value || null)" [attr.aria-label]="'PLUGIN_STUDIO.Cli.Effort' | translate">
                    <option value="" [selected]="!cliEffort()">{{ 'PLUGIN_STUDIO.Default effort' | translate }}</option>
                    @for (e of cliEfforts(); track e) { <option [value]="e" [selected]="e === cliEffort()">{{ e }}</option> }
                  </select>
                </label>
              }
              <span class="ps-cli-line" [title]="launchLine()">{{ launchLine() }}</span>
            </div>
            <div class="ps-term-body">
              @if (terminalId(); as id) {
                <app-terminal-instance [terminalId]="id" />
              }
              @if (terminalError()) {
                <div class="ps-term-empty">{{ terminalError() }}</div>
              } @else if (booting()) {
                <app-terminal-boot-loader [label]="'PLUGIN_STUDIO.Starting agent' | translate: { agent: cliLabel() }" />
              }
            </div>
            <div class="ps-left-hint">{{ 'PLUGIN_STUDIO.Agent runs here' | translate: { agent: cliLabel() } }}</div>
          </section>

          <section class="ps-right">
            <nav class="ps-tabs" role="tablist">
              @for (t of tabs; track t.id) {
                <button type="button" role="tab" [class.selected]="tab() === t.id" [attr.aria-selected]="tab() === t.id" (click)="openTab(t.id)">
                  {{ 'PLUGIN_STUDIO.Tab.' + t.id | translate }}@if (t.id === 'checks' && failures()) { <small class="ps-badge">{{ failures() }}</small> }
                  @if (t.id === 'preview' && build()?.state === 'ready' && tab() !== 'preview') { <span class="ps-dot" role="img" [attr.aria-label]="'PLUGIN_STUDIO.Cli.Ready dot' | translate"></span> }
                </button>
              }
            </nav>

            <!-- Build status: the agent writes → the Studio reloads and tests on its own → notice. -->
            @if (build(); as b) {
              <div class="ps-build" [class]="'ps-build ps-build-' + b.state" role="status" aria-live="polite">
                @switch (b.state) {
                  @case ('writing') {
                    <span class="ps-build-ic"><span class="ps-spin"></span></span>
                    <div class="ps-build-text"><strong>{{ 'PLUGIN_STUDIO.Building' | translate }}</strong>
                      <span>{{ 'PLUGIN_STUDIO.Files changed' | translate: { count: b.files } }}</span></div>
                  }
                  @case ('verifying') {
                    <span class="ps-build-ic"><span class="ps-spin"></span></span>
                    <div class="ps-build-text"><strong>{{ 'PLUGIN_STUDIO.Checking' | translate }}</strong><span>{{ 'PLUGIN_STUDIO.Checking hint' | translate }}</span></div>
                  }
                  @case ('ready') {
                    <span class="ps-build-ic"><i class="ti ti-circle-check-filled" aria-hidden="true"></i></span>
                    <div class="ps-build-text"><strong>{{ 'PLUGIN_STUDIO.Ready' | translate }}</strong>
                      <span>{{ (b.tests ? 'PLUGIN_STUDIO.Loaded tests passed' : 'PLUGIN_STUDIO.Loaded') | translate: { count: b.tests } }} @if (tryHint(); as h) { {{ h.key | translate: h.params }} }</span></div>
                    <div class="ps-build-actions">
                      <button type="button" class="ps-btn ps-btn-solid" (click)="tryIt()">{{ 'PLUGIN_STUDIO.Try it' | translate }}</button>
                      <button type="button" class="ps-btn ghost" (click)="openTab('checks')">{{ 'PLUGIN_STUDIO.Tab.checks' | translate }}</button>
                    </div>
                    <button type="button" class="ps-x" (click)="build.set(null)" [attr.aria-label]="'PLUGIN_STUDIO.Dismiss' | translate"><i class="ti ti-x" aria-hidden="true"></i></button>
                  }
                  @case ('failing') {
                    <span class="ps-build-ic"><i class="ti ti-alert-triangle-filled" aria-hidden="true"></i></span>
                    <div class="ps-build-text"><strong>{{ 'PLUGIN_STUDIO.Not ready' | translate }}</strong><span>{{ b.detail }}</span></div>
                    <div class="ps-build-actions">
                      <button type="button" class="ps-btn" (click)="openTab('checks')">{{ 'PLUGIN_STUDIO.See checks' | translate }}</button>
                      <button type="button" class="ps-btn ghost" (click)="sendFailures()">{{ 'PLUGIN_STUDIO.Send to agent' | translate }}</button>
                    </div>
                  }
                }
              </div>
            }

            <div class="ps-panel" [class.ps-flash]="flash()">
              @switch (tab()) {
                @case ('preview') {
                  @if (linkError()) { <div class="ps-error">{{ 'PLUGIN_STUDIO.Preview.Did not load' | translate: { error: linkError() } }} <button type="button" class="ps-link" (click)="sendToAgent('PromptOps could not load the plugin: ' + linkError() + '. Fix it.')">{{ 'PLUGIN_STUDIO.Send to agent' | translate }}</button></div> }
                  @switch (plugin()!.zone) {
                    @case ('session-buttons') {
                      <p class="ps-lead">{{ activeSession()?.name ? ('PLUGIN_STUDIO.Preview.Terminal lead named' | translate: { name: activeSession()!.name }) : ('PLUGIN_STUDIO.Preview.Terminal lead' | translate) }}</p>
                      @if (!activeSessionId()) { <div class="ps-notice">{{ 'PLUGIN_STUDIO.Preview.Open session buttons' | translate }}</div> }
                      <div class="ps-cap">{{ 'PLUGIN_STUDIO.Preview.Agent terminal' | translate }}</div>
                      <div class="ps-mock-term"><span>$ {{ activeSession()?.provider || 'claude' }}</span></div>
                      <div class="ps-mock-bar">
                        <span class="ps-mock-model">◆ {{ activeSession()?.provider || 'claude-code-cli' }}</span>
                        <i class="ti ti-leaf ps-mock-ic" aria-hidden="true"></i>
                        <app-plugin-session-buttons variant="toolbar" [onlyPluginId]="plugin()!.pluginId" paneAgentId="main"
                          [sessionId]="activeSessionId()" [sessionName]="activeSession()?.name ?? ''" [provider]="activeSession()?.provider ?? ''"
                          [sessionStatus]="activeSession()?.status ?? ''" [workspaceName]="workspaceName()" />
                        <i class="ti ti-shield-check ps-mock-ic" aria-hidden="true"></i>
                      </div>
                      <p class="ps-lead muted ps-after">{{ 'PLUGIN_STUDIO.Preview.Terminal after' | translate }}</p>
                      @if (!buttonCount()) { <div class="ps-notice">{{ 'PLUGIN_STUDIO.Preview.No button' | translate }}</div> }
                    }
                    @case ('header-buttons') {
                      <p class="ps-lead">{{ 'PLUGIN_STUDIO.Preview.Header lead' | translate }}</p>
                      @if (!activeSessionId()) { <div class="ps-notice">{{ 'PLUGIN_STUDIO.Preview.Open session badges' | translate }}</div> }
                      <div class="ps-mock-header">
                        <span class="pm-folder"><i class="ti ti-folder" aria-hidden="true"></i> {{ workspaceName() || 'my-project' }}</span>
                        <span class="pm-grow"></span>
                        <span class="pm-badge pm-ssh"><i class="ti ti-server-2" aria-hidden="true"></i> SSH</span>
                        <span class="pm-badge pm-db"><i class="ti ti-database" aria-hidden="true"></i> {{ 'SESSIONS.Database label' | translate }}</span>
                        <span class="pm-badge pm-docker"><i class="ti ti-brand-docker" aria-hidden="true"></i> Docker</span>
                        <app-plugin-session-buttons variant="header" place="header" [onlyPluginId]="plugin()!.pluginId" paneAgentId="main"
                          [sessionId]="activeSessionId()" [sessionName]="activeSession()?.name ?? ''" [provider]="activeSession()?.provider ?? ''"
                          [sessionStatus]="activeSession()?.status ?? ''" [workspaceName]="workspaceName()" />
                      </div>
                      @if (!placeCount('header')) { <div class="ps-notice">{{ 'PLUGIN_STUDIO.Preview.No header button' | translate }}</div> }
                    }
                    @case ('composer-buttons') {
                      <p class="ps-lead">{{ 'PLUGIN_STUDIO.Preview.Composer lead' | translate }}</p>
                      <div class="ps-mock-composer">
                        <textarea class="pm-prompt" [value]="previewPrompt()" (input)="previewPrompt.set($any($event.target).value)" [placeholder]="'PLUGIN_STUDIO.Preview.Prompt placeholder' | translate" rows="3"></textarea>
                        <div class="pm-tools">
                          <span class="pm-tool pm-provider" [class.pm-set]="previewSpawn()?.provider">✳ <span>{{ previewProviderLabel() }}</span></span>
                          @if (previewSpawn()?.mode; as m) { <span class="pm-tool pm-provider pm-set" [title]="'PLUGIN_STUDIO.Preview.Mode set' | translate"><i class="ti ti-adjustments-horizontal" aria-hidden="true"></i> {{ m }}</span> }
                          <span class="pm-tool"><i class="ti ti-paperclip" aria-hidden="true"></i></span>
                          <span class="pm-tool"><i class="ti ti-history" aria-hidden="true"></i></span>
                          <span class="pm-tool"><i class="ti ti-list-check" aria-hidden="true"></i></span>
                          <span class="pm-tool"><i class="ti ti-microphone" aria-hidden="true"></i></span>
                          <app-plugin-session-buttons variant="composer" place="composer" [onlyPluginId]="plugin()!.pluginId" paneAgentId="main"
                            [sessionId]="activeSessionId()" [sessionName]="activeSession()?.name ?? ''" [provider]="activeSession()?.provider ?? ''"
                            [sessionStatus]="activeSession()?.status ?? ''" [workspaceName]="workspaceName()" [composerText]="previewPrompt()" [preview]="true"
                            (insertText)="previewPrompt.set(previewPrompt() ? previewPrompt() + ' ' + $event : $event)"
                            (spawnPreview)="onSpawnPreview($event)" />
                          <span class="pm-grow"></span>
                          <span class="pm-spawn"><i class="ti ti-player-play-filled" aria-hidden="true"></i> {{ 'PLUGIN_STUDIO.Preview.Spawn' | translate }}</span>
                        </div>
                      </div>
                      @if (previewSpawn(); as sp) {
                        <div class="ps-notice">{{ 'PLUGIN_STUDIO.Preview.Prepared' | translate: { name: sp.name ? ' “' + sp.name + '”' : '', details: preparedDetails(sp) } }}</div>
                      }
                      @if (!placeCount('composer')) { <div class="ps-notice">{{ 'PLUGIN_STUDIO.Preview.No composer button' | translate }}</div> }
                    }
                    @case ('runtime-buttons') {
                      <p class="ps-lead">{{ 'PLUGIN_STUDIO.Preview.Runtime lead' | translate }}</p>
                      <div class="ps-mock-runtime">
                        <span class="pm-chip pm-squad"><i class="ti ti-users-group" aria-hidden="true"></i> {{ 'SESSIONS.HELP.Squad' | translate }}</span>
                        <span class="pm-chip"><span class="pm-knob"></span><i class="ti ti-target" aria-hidden="true"></i> {{ 'SESSIONS.ACTION_CENTER.Goal' | translate }}</span>
                        <span class="pm-chip"><span class="pm-knob"></span><i class="ti ti-bolt" aria-hidden="true"></i> {{ 'SESSIONS.ACTION_CENTER.Worker' | translate }}</span>
                        <app-plugin-session-buttons variant="chip" place="runtime" [onlyPluginId]="plugin()!.pluginId" paneAgentId="main"
                          [sessionId]="activeSessionId()" [sessionName]="activeSession()?.name ?? ''" [provider]="activeSession()?.provider ?? ''"
                          [sessionStatus]="activeSession()?.status ?? ''" [workspaceName]="workspaceName()" [composerText]="previewPrompt()"
                          [preview]="true" (insertText)="previewPrompt.set($event)" (spawnPreview)="onSpawnPreview($event)" />
                      </div>
                      @if (previewPrompt()) { <div class="ps-cap">{{ 'PLUGIN_STUDIO.Preview.Written' | translate }}</div><pre class="ps-pre">{{ previewPrompt() }}</pre> }
                      @if (!placeCount('runtime')) { <div class="ps-notice">{{ 'PLUGIN_STUDIO.Preview.No runtime button' | translate }}</div> }
                    }
                    @case ('sidebar') {
                      @if (firstPageId(); as pageId) {
                        <div class="ps-embed"><app-plugin-page [embedPluginId]="plugin()!.pluginId" [embedPageId]="pageId" [reloadKey]="reloadKey()" /></div>
                      } @else {
                        <div class="ps-notice">{{ 'PLUGIN_STUDIO.Preview.No page' | translate }}</div>
                      }
                    }
                    @case ('page') {
                      @if (firstPageId(); as pageId) {
                        <div class="ps-embed"><app-plugin-page [embedPluginId]="plugin()!.pluginId" [embedPageId]="pageId" [reloadKey]="reloadKey()" /></div>
                      } @else {
                        <div class="ps-notice">{{ 'PLUGIN_STUDIO.Preview.No page' | translate }}</div>
                      }
                    }
                    @case ('tasks') {
                      <p class="ps-lead">{{ 'PLUGIN_STUDIO.Preview.Tasks lead' | translate }}</p>
                      <div class="ps-calls">
                        @for (m of taskMethods; track m.id) {
                          <button type="button" class="ps-btn" [disabled]="calling()" (click)="callTasks(m.id, m.args)">{{ m.label }}</button>
                        }
                      </div>
                      @if (callResult()) { <pre class="ps-pre">{{ callResult() }}</pre> }
                    }
                  }
                }
                @case ('settings') {
                  <div class="ps-banner">{{ 'PLUGIN_STUDIO.Settings.Banner' | translate }}</div>

                  <div class="ps-cap">{{ 'PLUGIN_STUDIO.Settings.Own cap' | translate }}</div>
                  <p class="ps-lead muted">{{ 'PLUGIN_STUDIO.Settings.Own lead' | translate }}</p>
                  <app-plugin-config-form [pluginId]="plugin()!.pluginId" [saveLabel]="'PLUGIN_STUDIO.Settings.Save test values' | translate" />

                  @if (buttonCount()) {
                    <div class="ps-cap">{{ 'PLUGIN_STUDIO.Settings.Added cap' | translate }}</div>
                    <p class="ps-lead muted">{{ 'PLUGIN_STUDIO.Settings.Added lead' | translate }}</p>
                    <app-plugin-button-policy [pluginId]="plugin()!.pluginId" />
                  }
                }
                @case ('guide') {
                  <div class="ps-cap">{{ 'PLUGIN_STUDIO.GuideTab.What' | translate }}</div>
                  <p class="ps-lead">{{ guide().what | translate }}</p>
                  <pre class="ps-pre">{{ guide().code }}</pre>
                  <ul class="ps-notes">@for (n of guide().notes; track n) { <li>{{ n | translate }}</li> }</ul>
                  <p class="ps-lead">{{ 'PLUGIN_STUDIO.GuideTab.Reference' | translate }}</p>
                  <div class="ps-cap">{{ 'PLUGIN_STUDIO.GuideTab.Changes' | translate }}</div>
                  @if (changes().length) {
                    <ul class="ps-changes">@for (c of changes(); track c.path) { <li><code>{{ c.status || '?' }}</code> {{ c.path }}</li> }</ul>
                  } @else { <p class="ps-lead muted">{{ 'PLUGIN_STUDIO.GuideTab.No changes' | translate }}</p> }
                }
                @case ('checks') {
                  <div class="ps-calls"><button type="button" class="ps-primary sm" [disabled]="checking()" (click)="runChecks()">{{ (checking() ? 'PLUGIN_STUDIO.Checks.Running' : 'PLUGIN_STUDIO.Checks.Run') | translate }}</button></div>
                  @for (c of checks(); track c.id) {
                    <div class="ps-check" [attr.data-state]="c.state">
                      <div class="ps-check-head"><span class="ps-dot"></span><strong>{{ c.label | translate }}</strong>
                        @if (c.state === 'fail') { <button type="button" class="ps-link" (click)="sendToAgent(checkName(c) + ' failed in the PromptOps Plugin Studio:\\n' + c.detail + '\\nFix it.')">{{ 'PLUGIN_STUDIO.Send to agent' | translate }}</button> }
                      </div>
                      @if (c.detail) { <pre class="ps-pre">{{ c.detail }}</pre> }
                    </div>
                  }
                  <div class="ps-cap">{{ 'PLUGIN_STUDIO.Checks.Activity' | translate }}</div>
                  @if (activity().length) {
                    <ul class="ps-activity">
                      @for (a of activity(); track $index) {
                        <li [class.bad]="!a.ok"><code>{{ a.method }}</code> {{ a.target }} @if (a.error) { <span>· {{ a.error }}</span> }</li>
                      }
                    </ul>
                  } @else { <p class="ps-lead muted">{{ 'PLUGIN_STUDIO.Checks.Nothing yet' | translate }}</p> }
                }
              }
            </div>
          </section>
        </div>

        <!-- Same thing by hand, without an agent: the template repo, the playground and the tools. -->
        <section class="ps-manual" aria-labelledby="ps-manual-title">
          <button type="button" class="ps-manual-toggle" (click)="manualOpen.set(!manualOpen())" [attr.aria-expanded]="manualOpen()" id="ps-manual-title">
            <i class="ti" [class.ti-chevron-right]="!manualOpen()" [class.ti-chevron-down]="manualOpen()" aria-hidden="true"></i>
            {{ 'PLUGIN_STUDIO.Manual.Toggle' | translate }}
          </button>
          @if (manualOpen()) {
          <p class="ps-lead muted">{{ 'PLUGIN_STUDIO.Manual.Lead' | translate }}
            {{ 'PLUGIN_STUDIO.Manual.Templates' | translate }} <a [href]="templatesRepo" target="_blank" rel="noopener noreferrer">{{ templatesRepo.replace('https://github.com/', '') }}</a></p>
          <ol class="ps-steps">
            @for (step of manualSteps(); track step.title; let i = $index) {
              <li>
                <div class="ps-step-head"><span class="ps-step-n">{{ i + 1 }}</span><strong>{{ step.title | translate: step.params }}</strong></div>
                <p class="ps-lead muted">{{ step.note | translate: step.params }}</p>
                <div class="ps-cmd"><pre>{{ step.lines }}</pre>
                  <button type="button" class="ps-copy" (click)="copy(step.lines)">{{ (copied() === step.lines ? 'PLUGIN_STUDIO.Manual.Copied' : 'PLUGIN_STUDIO.Manual.Copy') | translate }}</button></div>
                @if (step.files) {
                  <ul class="ps-files">
                    <li><code>promptops-plugin.json</code> {{ 'PLUGIN_STUDIO.Manual.File manifest' | translate }}</li>
                    <li><code>src/plugin.js</code> {{ 'PLUGIN_STUDIO.Manual.File code' | translate }}</li>
                    <li><code>fixtures.json</code> / <code>test/</code> {{ 'PLUGIN_STUDIO.Manual.File fixtures' | translate }}</li>
                  </ul>
                  <div class="ps-cap">{{ 'PLUGIN_STUDIO.Manual.Make template yours' | translate: { template: manual().template } }}</div>
                  <ul class="ps-notes">@for (m of manual().makeItYours; track m) { <li>{{ m | translate }}</li> }</ul>
                }
              </li>
            }
          </ol>
          }
        </section>
        }
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    :host { display: block; }
    .ps-wrap { padding: 24px 12px; max-width: 980px; }
    .ps-h1 { font-size: 1.25rem; font-weight: 600; letter-spacing: -.4px; margin: 0 0 4px; }
    .ps-sub { font-size: 13px; color: var(--po-page-muted, var(--po-text-secondary)); margin: 0 0 20px; max-width: 640px; }
    .ps-cap { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--po-page-muted, var(--po-text-secondary)); margin: 14px 0 6px; }
    .ps-zones { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    @media (max-width: 900px) { .ps-zones { grid-template-columns: 1fr; } }
    .ps-zone { display: flex; flex-direction: column; gap: 6px; text-align: left; padding: 14px; border: 1px solid var(--po-page-border, var(--promptops-border-color)); border-radius: var(--po-radius-lg, 10px); background: transparent; color: inherit; }
    .ps-zone i { font-size: 20px; }
    .ps-zone span { font-size: 12px; color: var(--po-page-muted, var(--po-text-secondary)); line-height: 1.45; }
    .ps-zone.on { border-color: var(--po-page-ink, currentColor); box-shadow: inset 0 0 0 1px var(--po-page-ink, currentColor); }
    .ps-form { max-width: 560px; margin-top: 8px; }
    .ps-hint { font-size: 12px; color: var(--po-page-muted, var(--po-text-secondary)); margin-top: 4px; font-family: var(--po-font-mono, ui-monospace, monospace); }
    .ps-actions { margin-top: 16px; }
    .ps-primary { border: 0; border-radius: 8px; padding: 8px 16px; background: var(--po-page-ink, #111); color: var(--po-page-surface, #fff); font-weight: 600; font-size: 13px; }
    .ps-primary.sm { padding: 5px 12px; }
    .ps-primary:disabled { opacity: .4; }
    .ps-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--po-page-border, var(--promptops-border-color)); border-radius: 8px; padding: 5px 10px; background: transparent; color: inherit; font-size: 12px; }
    .ps-btn.ghost { border-color: transparent; color: var(--po-page-muted, var(--po-text-secondary)); }
    .ps-btn:disabled { opacity: .5; }
    .ps-link { border: 0; background: none; padding: 0; margin-left: 8px; color: inherit; text-decoration: underline; font-size: 12px; }
    .ps-error { border: 1px solid var(--po-error, #cf222e); border-radius: 8px; padding: 8px 12px; font-size: 12px; margin: 8px 0; }
    .ps-notice, .ps-banner { border: 1px solid var(--po-page-border, var(--promptops-border-color)); border-radius: 8px; padding: 8px 12px; font-size: 12px; margin: 8px 0; background: var(--po-page-soft, transparent); }
    .ps-banner { font-weight: 500; }
    .ps-studio { display: flex; flex-direction: column; padding: 12px; gap: 10px; }
    .ps-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .ps-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
    .ps-id, .ps-path { font-size: 12px; color: var(--po-page-muted, var(--po-text-secondary)); }
    .ps-path { font-family: var(--po-font-mono, ui-monospace, monospace); max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ps-top-actions { display: flex; gap: 6px; }
    .ps-zone-pick { display: inline-flex; align-items: center; gap: 8px; margin: 0; }
    .ps-zone-pick select { width: auto; min-width: 190px; }
    .ps-cap-inline { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--po-page-muted, var(--po-text-secondary)); }
    .ps-info { border: 0; background: none; color: var(--po-page-muted, var(--po-text-secondary)); font-size: 18px; padding: 0 4px; line-height: 1; }
    .ps-info:hover { color: inherit; }
    .ps-name { margin-left: 8px; }
    .ps-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 2001; }
    .ps-modal { position: fixed; z-index: 2002; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(640px, calc(100vw - 32px)); max-height: min(80vh, 720px);
      display: flex; flex-direction: column; background: var(--promptops-body-bg); color: var(--promptops-body-color); border: 1px solid var(--promptops-border-color); border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
    .ps-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--promptops-border-color); }
    .ps-x { border: 0; background: none; color: inherit; font-size: 16px; }
    .ps-modal-body { padding: 12px 16px; overflow: auto; }
    .ps-zone-row { display: grid; grid-template-columns: 40px 1fr auto; gap: 12px; align-items: start; padding: 12px; border: 1px solid var(--promptops-border-color); border-radius: 10px; margin-bottom: 10px; }
    .ps-zone-row.on { border-color: var(--po-page-ink, currentColor); }
    .ps-zone-icon { width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 20px; background: var(--po-page-soft, rgba(127,127,127,.12)); }
    .ps-zone-text p { font-size: 12px; margin: 4px 0 0; line-height: 1.45; }
    @media (max-width: 560px) { .ps-zone-row { grid-template-columns: 1fr; } }
    /* Its own height: the manual guide below must never squash terminal and preview. */
    .ps-split { flex: none; height: calc(100vh - 150px); min-height: 520px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 12px; }
    @media (max-width: 1000px) { .ps-split { grid-template-columns: 1fr; grid-template-rows: none; grid-auto-rows: minmax(420px, auto); height: auto; } }
    .ps-left { display: flex; flex-direction: column; min-height: 0; border: 1px solid #30363d; border-radius: 10px; overflow: hidden; background: #0d1117; }
    /* Like the Browser page: the terminal fills a container of definite height. */
    .ps-cli-bar { flex: none; display: flex; align-items: center; gap: 4px; padding: 6px 8px; border-bottom: 1px solid #30363d; }
    .ps-cli-chip { position: relative; display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px; margin: 0; border-radius: 8px;
      color: #c9d1d9; font-size: 12px; cursor: pointer; }
    .ps-cli-chip:hover { background: rgba(129, 140, 248, .12); color: #a5b4fc; }
    .ps-cli-chip .ti-chevron-down { font-size: 10px; opacity: .6; }
    .ps-cli-chip select { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    .ps-cli-line { margin-left: auto; font-family: var(--po-font-mono, ui-monospace, monospace); font-size: 11px; color: #6e7681; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }
    .ps-term-body { flex: 1 1 auto; min-height: 0; position: relative; padding: 4px 0 0 4px; }
    .ps-term-body app-terminal-instance { position: absolute; inset: 4px 0 0 4px; }
    .ps-term-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #8b949e; font-size: 13px; padding: 16px; text-align: center; }
    .ps-left-hint { flex: none; font-size: 11px; color: #8b949e; padding: 6px 10px; border-top: 1px solid #30363d; }
    .ps-right { display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--po-page-border, var(--promptops-border-color)); border-radius: 10px; }
    .ps-tabs { display: flex; gap: 20px; padding: 0 14px; border-bottom: 1px solid var(--po-page-border, var(--promptops-border-color)); flex: none; }
    .ps-tabs button { border: 0; background: none; color: var(--po-page-muted, var(--po-text-secondary)); padding: 10px 0; font-size: 13px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
    .ps-tabs button.selected { color: inherit; border-bottom-color: var(--po-page-ink, currentColor); font-weight: 600; }
    .ps-badge { margin-left: 4px; padding: 0 5px; border-radius: 8px; background: var(--po-error, #cf222e); color: #fff; font-size: 10px; }
    .ps-panel { flex: 1 1 auto; overflow: auto; padding: 12px 14px; }
    .ps-build { position: relative; display: flex; align-items: center; gap: 10px; margin: 10px 14px 0; padding: 10px 12px; border: 1px solid var(--po-page-border, var(--promptops-border-color)); border-radius: 8px; background: var(--po-page-soft, transparent); font-size: 12px; flex: none; }
    .ps-build-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
    .ps-build-text strong { font-size: 13px; }
    .ps-build-text span { color: var(--po-page-muted, var(--po-text-secondary)); line-height: 1.4; }
    .ps-build-ic { flex: none; width: 22px; display: flex; justify-content: center; font-size: 20px; }
    .ps-build-actions { display: flex; gap: 6px; flex: none; }
    .ps-build .ps-x { position: static; }
    .ps-build-ready { border-color: var(--po-success, #1a7f37); box-shadow: inset 3px 0 0 var(--po-success, #1a7f37); animation: ps-pop .35s ease-out; }
    .ps-build-ready .ps-build-ic { color: var(--po-success, #1a7f37); }
    .ps-build-failing { border-color: var(--po-warning, #bf8700); box-shadow: inset 3px 0 0 var(--po-warning, #bf8700); }
    .ps-build-failing .ps-build-ic { color: var(--po-warning, #bf8700); }
    .ps-btn-solid { background: var(--po-page-ink, #111); color: var(--po-page-surface, #fff); border-color: transparent; font-weight: 600; }
    .ps-spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; opacity: .6; animation: ps-rot .8s linear infinite; }
    .ps-dot { display: inline-block; width: 7px; height: 7px; margin-left: 5px; border-radius: 50%; background: var(--po-success, #1a7f37); vertical-align: middle; }
    .ps-flash { animation: ps-glow 1.6s ease-out; }
    @keyframes ps-rot { to { transform: rotate(360deg); } }
    @keyframes ps-pop { from { transform: translateY(-4px); opacity: 0; } to { transform: none; opacity: 1; } }
    @keyframes ps-glow { 0% { box-shadow: inset 0 0 0 2px var(--po-success, #1a7f37); } 100% { box-shadow: inset 0 0 0 2px transparent; } }
    @media (prefers-reduced-motion: reduce) { .ps-build-ready, .ps-flash, .ps-spin { animation: none; } }
    .ps-lead { font-size: 13px; line-height: 1.5; margin: 0 0 8px; }
    .muted { color: var(--po-page-muted, var(--po-text-secondary)); }
    .ps-mock-term { height: 56px; background: #0d1117; border: 1px solid #30363d; border-bottom: 0; border-radius: 8px 8px 0 0; display: flex; align-items: flex-end; padding: 6px 10px; }
    .ps-mock-term span { color: #6e7681; font-size: 11px; font-family: var(--po-font-mono, ui-monospace, monospace); }
    .ps-mock-bar { display: flex; align-items: center; justify-content: flex-end; gap: 4px; padding: 3px 6px; background: rgba(13, 17, 23, .92); border: 1px solid #30363d; border-radius: 0 0 8px 8px; color: #c9d1d9; }
    .ps-mock-model { margin-right: auto; font-size: 11px; opacity: .8; }
    .ps-after { margin-top: 8px; }
    .ps-manual { margin-top: 4px; padding: 0 2px 32px; max-width: 980px; }
    .ps-manual-toggle { border: 0; background: none; padding: 4px 0; color: var(--po-page-muted, var(--po-text-secondary)); font-size: 13px; display: inline-flex; align-items: center; gap: 6px; }
    .ps-manual-toggle:hover { color: inherit; }
    .ps-h2 { font-size: 1rem; font-weight: 600; margin: 0 0 4px; }
    .ps-manual a { color: inherit; text-decoration: underline; }
    .ps-steps { list-style: none; padding: 0; margin: 12px 0 0; display: grid; gap: 12px; }
    .ps-steps > li { border: 1px solid var(--po-page-border, var(--promptops-border-color)); border-radius: 10px; padding: 12px 14px; }
    .ps-step-head { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; font-size: 13px; }
    .ps-step-n { width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; background: var(--po-page-soft, rgba(127,127,127,.15)); }
    .ps-cmd { display: flex; align-items: flex-start; gap: 8px; background: #0d1117; border-radius: 8px; padding: 8px 10px; }
    .ps-cmd pre { flex: 1; margin: 0; color: #c9d1d9; font-size: 12px; white-space: pre; overflow-x: auto; font-family: var(--po-font-mono, ui-monospace, monospace); }
    .ps-copy { flex: none; border: 1px solid #30363d; background: transparent; color: #c9d1d9; border-radius: 6px; font-size: 11px; padding: 2px 8px; }
    .ps-files { font-size: 12px; padding-left: 18px; margin: 8px 0 0; }
    .ps-mock-ic { width: 24px; text-align: center; opacity: .4; font-size: 14px; }
    /* Faithful replicas of the zones: same colors and sizes as the app components. */
    .ps-mock-header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--po-border-subtle, #30363d); border-radius: 8px; background: var(--po-bg-1, #161b22); color: var(--po-text-primary, #c9d1d9); }
    .pm-folder { font-size: 12px; opacity: .8; }
    .pm-grow { flex: 1 1 auto; }
    .pm-badge { display: flex; align-items: center; gap: .3rem; padding: .2rem .5rem; border-radius: 6px; background: transparent; font-size: .72rem; font-weight: 600; }
    .pm-ssh { border: 1px solid rgba(99,102,241,.3); color: #818cf8; }
    .pm-db { border: 1px solid rgba(240,136,62,.25); color: #f0883e; }
    .pm-docker { border: 1px solid rgba(36,150,237,.25); color: #2496ed; }
    .ps-mock-composer { border: 1px solid var(--po-border-subtle, #30363d); border-radius: 12px; padding: 8px; background: var(--po-bg-1, #161b22); }
    .pm-prompt { width: 100%; border: 0; background: transparent; color: var(--po-text-primary, #c9d1d9); resize: none; outline: none; font-size: 13px; }
    .pm-tools { display: flex; align-items: center; gap: 4px; }
    .pm-tool { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; color: var(--po-text-secondary, #8b949e); font-size: 15px; }
    .pm-provider { width: auto; padding: 0 6px; gap: 4px; font-size: 12px; }
    .pm-set { color: inherit; background: var(--po-page-soft, rgba(127,127,127,.14)); box-shadow: inset 0 0 0 1px var(--po-success, #1a7f37); }
    .pm-spawn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 10px; background: #6366f1; color: #fff; font-size: 12px; font-weight: 600; }
    .ps-mock-runtime { display: flex; gap: 6px; padding: 8px; border: 1px solid var(--po-border-subtle, #30363d); border-radius: 10px; background: var(--po-bg-1, #161b22); }
    .pm-chip { flex: 1 1 0; min-width: 0; height: 28px; display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 2px 8px; border-radius: 999px;
      background: var(--po-bg-2, #21262d); border: 1px solid var(--po-border-subtle, #30363d); color: var(--po-text-secondary, #8b949e); font-size: .68rem; font-weight: 600; white-space: nowrap; }
    .pm-knob { width: 14px; height: 8px; border-radius: 8px; background: var(--po-border-subtle, #30363d); }
    .ps-embed { border: 1px dashed var(--po-page-border, var(--promptops-border-color)); border-radius: 8px; overflow: hidden; }
    .ps-calls { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 10px; }
    .ps-pre { font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 10px; padding: 10px; border-radius: 8px; background: #0d1117; color: #c9d1d9; font-family: var(--po-font-mono, ui-monospace, monospace); max-height: 320px; overflow: auto; }
    .ps-notes, .ps-changes, .ps-activity { font-size: 12px; padding-left: 18px; margin: 0 0 10px; }
    .ps-changes, .ps-activity { list-style: none; padding: 0; }
    .ps-changes li, .ps-activity li { padding: 3px 0; border-bottom: 1px solid var(--po-page-border, var(--promptops-border-color)); overflow-wrap: anywhere; }
    .ps-activity li.bad { color: var(--po-error, #cf222e); }
    .ps-check { border: 1px solid var(--po-page-border, var(--promptops-border-color)); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
    .ps-check-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .ps-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--po-page-muted, #888); }
    .ps-check[data-state="ok"] .ps-dot { background: var(--po-success, #1a7f37); }
    .ps-check[data-state="fail"] .ps-dot { background: var(--po-error, #cf222e); }
    .ps-check[data-state="warn"] .ps-dot { background: var(--po-warning, #d29922); }
  `],
})
export class PluginStudioComponent implements OnInit, OnDestroy {
  readonly runtime = inject(PluginRuntimeService);
  private terminals = inject(TerminalManagerService);
  private store = inject(Store);
  private translate = inject(TranslateService);

  /** Zones whose host exists in this edition (no Teams board in local mode). */
  readonly zones = ZONES.filter((z) => !HIDDEN_PLUGIN_CATEGORIES.includes(z.id));
  readonly tabs: { id: Tab; label: string }[] = [
    { id: 'preview', label: 'Preview' }, { id: 'settings', label: 'Settings' }, { id: 'guide', label: 'Guide' }, { id: 'checks', label: 'Checks' },
  ];
  readonly taskMethods = [
    { id: 'validate', label: 'validate()', args: [] as unknown[] },
    { id: 'listContainers', label: 'listContainers()', args: [null] },
    { id: 'listStatuses', label: 'listStatuses(first)', args: ['__first__'] },
    { id: 'listTasks', label: 'listTasks(first)', args: ['__first__', {}] },
  ];

  readonly zonesOpen = signal(false);
  readonly cliProviders = STUDIO_PROVIDERS;
  readonly cliProvider = signal<string>('claude-code-cli');
  readonly cliModel = signal<string | null>(null);
  readonly cliEffort = signal<string | null>(null);
  readonly cliLabel = computed(() => STUDIO_PROVIDERS.find((p) => p.id === this.cliProvider())?.label ?? 'Claude Code');
  readonly cliLogo = computed(() => PROVIDER_LOGOS[this.cliProvider()] ?? 'assets/providers/terminal.svg');
  readonly cliModels = computed(() => spawnModels(this.cliProvider()));
  readonly cliModelLabel = computed(() => this.cliModels().find((m) => m.id === this.cliModel())?.label ?? null);
  readonly cliEfforts = computed(() => effortOptions(this.cliProvider(), this.cliModel()) as readonly string[]);
  /** Line launched in the terminal: provider binary plus model/effort, with the same flags as the spawn. */
  readonly launchLine = computed(() => {
    const p = STUDIO_PROVIDERS.find((x) => x.id === this.cliProvider()) ?? STUDIO_PROVIDERS[0];
    const model = this.cliModel() && SAFE_ARG.test(this.cliModel()!) ? this.cliModel() : null;
    const effort = this.cliEffort() && SAFE_ARG.test(this.cliEffort()!) ? this.cliEffort() : null;
    let line = p.binary;
    if (p.id === 'claude-code-cli') {
      if (model) line += ` --model ${model}`;
      if (effort) line += ` --effort ${effort}`;
    } else if (p.id === 'codex') {
      if (model) line += ` -m ${model}`;
      if (effort) line += ` -c 'model_reasoning_effort="${effort}"'`;
    } else if (model && MODEL_FLAGS[p.id]) {
      line += ` ${MODEL_FLAGS[p.id]} ${model}`;
      if (p.id === 'antigravity' && effort) line += ` --effort ${effort}`;
    }
    return line;
  });
  /**
   * Line that resumes the last conversation in the plugin folder (every plugin has its own folder,
   * so "the last one" is the Studio's). null = the CLI cannot resume: start over.
   */
  readonly resumeLine = computed(() => {
    const line = this.launchLine();
    switch (this.cliProvider()) {
      case 'claude-code-cli': return `${line} --continue`;
      case 'codex': return line.replace(/^codex/, 'codex resume --last');
      case 'opencode': return `${line} --continue`;
      case 'gemini-cli': return `${line} --resume latest`;
      case 'antigravity': return `${line} --continue`;
      default: return null;
    }
  });
  /** Manual guide: collapsed, one line under the Studio. */
  readonly manualOpen = signal(false);
  readonly templatesRepo = TEMPLATES_REPO;
  readonly copied = signal<string | null>(null);
  /** Manual guide for the current zone: repo template, what to change. */
  readonly manual = computed(() => MANUAL[this.plugin()?.zone ?? 'session-buttons']);
  readonly manualSteps = computed(() => {
    const p = this.plugin();
    const m = this.manual();
    const slug = (p?.pluginId ?? 'local.my-plugin').replace(/^local\./, '');
    const folder = `../${slug}`;
    const name = (p?.name ?? 'My plugin').replace(/"/g, '');
    // Titles and notes are i18n keys (PLUGIN_STUDIO.Manual.*), translated in the template with `params`.
    const params = { template: m.template, section: m.section, folder };
    return [
      { title: 'PLUGIN_STUDIO.Manual.Step download', lines: `git clone ${this.templatesRepo}.git\ncd promptops-plugin-templates`, note: 'PLUGIN_STUDIO.Manual.Step download note', params, files: false },
      { title: 'PLUGIN_STUDIO.Manual.Step look', lines: 'node playground/server.mjs', note: 'PLUGIN_STUDIO.Manual.Step look note', params, files: false },
      { title: 'PLUGIN_STUDIO.Manual.Step create', lines: `node tools/new-plugin.mjs ${m.section} ${folder} your-handle.${slug} "${name}"`, note: 'PLUGIN_STUDIO.Manual.Step create note', params, files: false },
      { title: 'PLUGIN_STUDIO.Manual.Step yours', lines: `node playground/server.mjs --plugin ${folder}`, note: 'PLUGIN_STUDIO.Manual.Step yours note', params, files: true },
      { title: 'PLUGIN_STUDIO.Manual.Step check', lines: `node tools/validate.mjs ${folder}`, note: 'PLUGIN_STUDIO.Manual.Step check note', params, files: false },
    ];
  });
  readonly busy = signal(false);
  readonly error = signal('');

  readonly plugin = signal<StudioPlugin | null>(null);
  readonly terminalId = signal<string | null>(null);
  readonly terminalError = signal('');
  /** Startup veil: from the terminal opening until the Claude Code banner (45 s max). */
  readonly booting = signal(false);
  readonly tab = signal<Tab>('preview');
  readonly reloadKey = signal(0);
  readonly reloading = signal(false);
  readonly linkError = signal('');
  readonly changes = signal<{ status: string; path: string }[]>([]);
  readonly checks = signal<Check[]>([]);
  readonly checking = signal(false);
  readonly activity = signal<AuditEntry[]>([]);
  readonly calling = signal(false);
  readonly callResult = signal('');
  /** Notice on the right: the agent writes, the Studio checks, then ready or needs fixing. */
  readonly build = signal<{ state: 'writing' | 'verifying' | 'ready' | 'failing'; files: number; tests?: number; detail?: string } | null>(null);
  readonly flash = signal(false);
  private lastOutputAt = 0;
  /** Bytes written by the terminal since the last check: the TUI's minimal redraws do not count. */
  private outputSinceVerify = 0;
  private agentSaidReload = false;
  /**
   * The notice is armed only once the CLI is ready: the startup output, the resume and the first pasted prompt
   * (which itself contains "press Reload") are not the agent's work.
   */
  private armed = false;
  private untapActivity: (() => void) | null = null;
  private buildTimer: ReturnType<typeof setInterval> | null = null;
  private firstContainer: string | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  readonly activeSessionId = toSignal(this.store.select(getActiveSessionId), { initialValue: null });
  readonly activeSession = toSignal(this.store.select(getActiveSession), { initialValue: null });
  readonly workspaceName = computed(() => (this.activeSession()?.workspace?.path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '');

  readonly installedSelf = computed(() => this.runtime.installed().find((p) => p.pluginId === this.plugin()?.pluginId) ?? null);
  readonly firstPageId = computed(() => this.installedSelf()?.pages?.[0]?.id ?? null);
  readonly buttonCount = computed(() => this.runtime.sessionButtons().filter((b) => b.pluginId === this.plugin()?.pluginId).length);
  readonly previewPrompt = signal('');
  /** Last `spawn` proposed by the plugin in the preview: prompt, provider and mode end up in the fake composer. */
  readonly previewSpawn = signal<{ prompt: string; provider: string | null; mode: string | null; name: string | null } | null>(null);
  readonly previewProviderLabel = computed(() => {
    const id = this.previewSpawn()?.provider;
    if (!id) return 'Opus 5';
    return STUDIO_PROVIDERS.find((p) => p.id === id)?.label ?? id;
  });
  onSpawnPreview(sp: { prompt: string; provider: string | null; mode: string | null; name: string | null }): void {
    this.previewSpawn.set(sp);
    this.previewPrompt.set(sp.prompt);
  }
  placeCount(place: string): number {
    return this.runtime.sessionButtons().filter((b) => b.pluginId === this.plugin()?.pluginId && (b.button.place ?? 'terminal') === place).length;
  }
  readonly zoneTitle = computed(() => ZONES.find((z) => z.id === this.plugin()?.zone)?.title ?? '');
  readonly guide = computed(() => GUIDE[this.plugin()?.zone ?? 'session-buttons']);
  readonly failures = computed(() => this.checks().filter((c) => c.state === 'fail').length + (this.linkError() ? 1 : 0));

  ngOnInit(): void {
    if (!this.runtime.available) return;
    void this.runtime.start();
    // Route the output of generic terminals to xterm (like the Browser page): without it, the terminal stays empty.
    this.terminals.init();
    try {
      const cli = JSON.parse(localStorage.getItem(CLI_KEY) || 'null') as { provider?: string; model?: string | null; effort?: string | null } | null;
      if (cli?.provider && STUDIO_PROVIDERS.some((p) => p.id === cli.provider)) {
        this.cliProvider.set(cli.provider);
        this.cliModel.set(cli.model ?? null);
        this.cliEffort.set(cli.effort ?? null);
      }
    } catch { /* default: Claude Code */ }
    let saved: StudioPlugin | null = null;
    try { saved = JSON.parse(localStorage.getItem(CURRENT_KEY) || 'null') as StudioPlugin | null; } catch { /* nothing to reopen */ }
    // All in one page: reopen the last plugin, otherwise start a draft right away.
    if (saved?.path && saved.pluginId) void this.open(saved);
    else void this.newDraft('session-buttons');
  }

  /** Changing zone = new plugin in that zone (the current draft stays in its folder). */
  changeZone(value: string): void {
    const zone = this.zones.find((z) => z.id === value)?.id;
    if (!zone || zone === this.plugin()?.zone) return;
    void this.newDraft(zone);
  }

  /** Draft ready right away: folder from the zone template, Claude Code open, you write the goal in the terminal. */
  async newDraft(zone: StudioZone): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    const title = ZONES.find((z) => z.id === zone)?.title ?? 'plugin';
    try {
      const slug = 'my-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const prepared = await this.runtime.studioPrepare({ zone, name: 'My ' + title.toLowerCase(), slug, goal: '', unique: true });
      this.resetView();
      await this.open(prepared, true);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }

  private resetView(): void {
    this.terminalId.set(null);
    this.terminalError.set('');
    this.checks.set([]);
    this.changes.set([]);
    this.build.set(null);
    this.outputSinceVerify = 0;
    this.agentSaidReload = false;
    this.callResult.set('');
    this.previewSpawn.set(null);
    this.linkError.set('');
    this.tab.set('preview');
  }

  /** Change of agent, model or effort: remembered on this device and the CLI restarts in the terminal. */
  setCli(provider: string, model: string | null, effort: string | null): void {
    const changedProvider = provider !== this.cliProvider();
    this.cliProvider.set(provider);
    this.cliModel.set(changedProvider ? null : model);
    const efforts = effortOptions(provider, changedProvider ? null : model) as readonly string[];
    this.cliEffort.set(!changedProvider && effort && efforts.includes(effort) ? effort : null);
    try { localStorage.setItem(CLI_KEY, JSON.stringify({ provider, model: this.cliModel(), effort: this.cliEffort() })); } catch { /* ok */ }
    void this.restartCli();
  }

  /** Exits the running CLI (Ctrl+C twice), waits for the shell and relaunches with the new line. */
  private async restartCli(): Promise<void> {
    const id = this.terminalId();
    if (!id) return;
    this.booting.set(true);
    const back = this.waitFor(id, SHELL_PROMPT_RE, 4000);
    this.terminals.write(id, '\x03');
    await this.sleep(150);
    this.terminals.write(id, '\x03');
    await back;
    await this.resumeOrStart(id);
    this.booting.set(false);
  }

  /**
   * Resumes the agent's conversation in the plugin folder. If it fails (no conversation:
   * the first prompt was never sent, or the CLI cannot resume) it starts over with the first prompt.
   */
  private async resumeOrStart(id: string): Promise<void> {
    this.armed = false;
    try { await this.resumeOrStartInner(id); } finally { this.armBuildWatch(); }
  }

  /** After startup the count is reset: from here on the output is the agent's work (or answer). */
  private armBuildWatch(): void {
    setTimeout(() => {
      this.outputSinceVerify = 0;
      this.agentSaidReload = false;
      this.armed = true;
    }, 2000);
  }

  private async resumeOrStartInner(id: string): Promise<void> {
    const line = this.resumeLine();
    if (line) {
      const p = STUDIO_PROVIDERS.find((x) => x.id === this.cliProvider()) ?? STUDIO_PROVIDERS[0];
      const failed = this.waitFor(id, RESUME_FAILED_RE, 45000);
      const ready = p.ready ? this.waitFor(id, p.ready, 45000) : this.sleep(6000).then(() => true);
      this.terminals.write(id, `${line}\r`);
      const outcome = await Promise.race([failed.then((f) => (f ? 'failed' : 'timeout')), ready.then((r) => (r ? 'ready' : 'timeout'))]);
      if (outcome !== 'failed') {
        // The banner arrives before any error: wait a moment to notice it.
        const lateFail = await Promise.race([failed, this.sleep(2500).then(() => false)]);
        if (!lateFail) return;
      }
      await this.waitFor(id, SHELL_PROMPT_RE, 4000);
    }
    const up = await this.launchCli(id);
    if (!up) return;
    await this.sleep(1500);
    const p = this.plugin();
    if (p && this.terminalId() === id) this.terminals.write(id, `\x1b[200~${this.firstPrompt(p)}\x1b[201~`);
  }

  /** Launches the chosen CLI and waits for its banner (or a few seconds, for CLIs without a known banner). */
  private async launchCli(id: string): Promise<boolean> {
    const p = STUDIO_PROVIDERS.find((x) => x.id === this.cliProvider()) ?? STUDIO_PROVIDERS[0];
    const ready = p.ready ? this.waitFor(id, p.ready, 45000) : this.sleep(6000).then(() => true);
    this.terminals.write(id, `${this.launchLine()}\r`);
    return ready;
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(text);
      setTimeout(() => this.copied.set(null), 1500);
    } catch { /* clipboard unavailable */ }
  }

  @HostListener('document:keydown.escape')
  closeZones(): void {
    this.zonesOpen.set(false);
  }

  ngOnDestroy(): void {
    if (this.poll) clearInterval(this.poll);
    if (this.buildTimer) clearInterval(this.buildTimer);
    this.untapActivity?.();
  }

  /**
   * Listens to the agent's terminal: any output = it is working. When it stops (8 s of quiet)
   * with changed files, or when it says to press Reload, the Studio checks on its own.
   */
  private watchActivity(id: string): void {
    this.untapActivity?.();
    let tail = '';
    this.untapActivity = this.terminals.tapOutput(id, (data) => {
      this.lastOutputAt = Date.now();
      this.outputSinceVerify += data.length;
      // TUIs split words with cursor sequences: compare without escapes or spaces.
      tail = (tail + data.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '').replace(/\s+/g, '')).slice(-600);
      if (/pressreload/i.test(tail)) { this.agentSaidReload = true; tail = ''; }
    });
    if (!this.buildTimer) this.buildTimer = setInterval(() => void this.buildTick(), 2000);
  }

  private async buildTick(): Promise<void> {
    const b = this.build();
    if (b?.state === 'verifying' || this.checking() || this.booting() || !this.armed || !this.plugin()) return;
    const files = this.changes().length;
    if (!files) return;
    const quiet = Date.now() - this.lastOutputAt > 8000;
    const worked = this.outputSinceVerify > 400;
    if (worked && (this.agentSaidReload || quiet)) {
      await this.verifyBuild(files);
    } else if (worked && !quiet && b?.state !== 'writing') {
      this.build.set({ state: 'writing', files });
    } else if (b?.state === 'writing' && b.files !== files) {
      this.build.set({ state: 'writing', files });
    }
  }

  /** Same checks as the Checks tab, then preview reloaded and notice. */
  private async verifyBuild(files: number): Promise<void> {
    this.agentSaidReload = false;
    this.outputSinceVerify = 0;
    this.build.set({ state: 'verifying', files });
    await this.runChecks();
    this.reloadKey.update((k) => k + 1);
    const failed = this.checks().filter((c) => c.state === 'fail');
    if (failed.length) {
      this.build.set({ state: 'failing', files, detail: this.translate.instant('PLUGIN_STUDIO.Checks.Failed', { checks: failed.map((c) => this.translate.instant(c.label)).join(' · ') }) });
      return;
    }
    const tests = this.checks().find((c) => c.id === 'tests')?.detail.match(/#\s*pass\s+(\d+)/)?.[1];
    this.build.set({ state: 'ready', files, tests: tests ? Number(tests) : undefined });
  }

  /** Hint after a successful build: i18n key + params, translated in the template. */
  readonly tryHint = computed<{ key: string; params?: Record<string, string> } | null>(() => {
    const p = this.plugin();
    if (!p) return null;
    const title = this.runtime.sessionButtons().find((b) => b.pluginId === p.pluginId)?.button.title;
    const button = title ? '“' + title + '”' : this.translate.instant('PLUGIN_STUDIO.Try.Your button');
    switch (p.zone) {
      case 'composer-buttons': return { key: 'PLUGIN_STUDIO.Try.Composer', params: { button } };
      case 'page': case 'sidebar': return { key: 'PLUGIN_STUDIO.Try.Page' };
      case 'tasks': return { key: 'PLUGIN_STUDIO.Try.Tasks' };
      default: return { key: 'PLUGIN_STUDIO.Try.Default', params: { button } };
    }
  });

  /** English name of a check, for the prompts sent to the agent (those stay in English). */
  checkName(c: Check): string {
    return ({ manifest: 'Manifest and permissions', tests: 'Tests (node --test)', denials: 'Calls PromptOps refused' } as Record<string, string>)[c.id] ?? c.id;
  }

  /** Provider and mode of the agent a plugin prepared, in the UI language. */
  preparedDetails(sp: { provider: string | null; mode: string | null }): string {
    const provider = sp.provider
      ? this.translate.instant('PLUGIN_STUDIO.Preview.Prepared provider', { provider: this.previewProviderLabel() })
      : this.translate.instant('PLUGIN_STUDIO.Preview.Prepared current');
    return provider + (sp.mode ? this.translate.instant('PLUGIN_STUDIO.Preview.Prepared mode', { mode: sp.mode }) : '');
  }

  tryIt(): void {
    this.tab.set('preview');
    this.flash.set(false);
    queueMicrotask(() => this.flash.set(true));
    setTimeout(() => this.flash.set(false), 1700);
  }

  sendFailures(): void {
    const failed = this.checks().filter((c) => c.state === 'fail');
    this.sendToAgent('The PromptOps Plugin Studio checks failed:\n' + failed.map((c) => `- ${this.checkName(c)}: ${c.detail.split('\n').slice(-12).join('\n')}`).join('\n') + '\nFix it.');
  }

  /** Links the folder in developer mode, opens the terminal with Claude Code and (if new) pastes the first prompt. */
  private async open(p: StudioPlugin, fresh = false): Promise<void> {
    this.plugin.set(p);
    this.build.set(null);
    this.armed = false;
    try { localStorage.setItem(CURRENT_KEY, JSON.stringify(p)); } catch { /* ok */ }
    if (!this.runtime.developerMode()) await this.runtime.setDeveloperMode(true).catch(() => undefined);
    await this.link();
    await this.refreshSide();
    if (this.poll) clearInterval(this.poll);
    this.poll = setInterval(() => void this.refreshSide(), 5000);
    await this.ensureTerminal(fresh);
  }

  private async link(): Promise<void> {
    const p = this.plugin();
    if (!p) return;
    try {
      await this.runtime.linkLocal(p.path);
      this.linkError.set('');
    } catch (e) {
      this.linkError.set(e instanceof Error ? e.message : String(e));
    }
  }

  async reload(): Promise<void> {
    this.reloading.set(true);
    await this.link();
    this.reloadKey.update((k) => k + 1);
    await this.refreshSide();
    this.reloading.set(false);
  }

  private async refreshSide(): Promise<void> {
    const p = this.plugin();
    if (!p) return;
    this.changes.set(await this.runtime.studioChanges(p.path).catch(() => []));
    this.activity.set((await this.runtime.audit(p.pluginId, 40).catch(() => [] as AuditEntry[])).slice().reverse());
  }

  openTab(t: Tab): void {
    this.tab.set(t);
    if (t === 'checks' && !this.checks().length) void this.runChecks();
  }

  async runChecks(): Promise<void> {
    const p = this.plugin();
    if (!p) return;
    this.checking.set(true);
    await this.link();
    const out: Check[] = [];
    out.push(this.linkError()
      ? { id: 'manifest', label: 'PLUGIN_STUDIO.Checks.Manifest', state: 'fail', detail: this.linkError() }
      : { id: 'manifest', label: 'PLUGIN_STUDIO.Checks.Manifest', state: 'ok', detail: '' });
    try {
      const t = await this.runtime.studioRunTests(p.path);
      out.push({ id: 'tests', label: 'PLUGIN_STUDIO.Checks.Tests', state: t.ok ? 'ok' : 'fail', detail: t.output.trim().split('\n').slice(-30).join('\n') });
    } catch (e) {
      out.push({ id: 'tests', label: 'PLUGIN_STUDIO.Checks.Tests', state: 'fail', detail: e instanceof Error ? e.message : String(e) });
    }
    await this.refreshSide();
    const denied = this.activity().filter((a) => !a.ok);
    out.push(denied.length
      ? { id: 'denials', label: 'PLUGIN_STUDIO.Checks.Denials', state: 'warn', detail: denied.slice(0, 8).map((a) => `${a.method} ${a.target ?? ''} · ${a.error ?? ''}`).join('\n') }
      : { id: 'denials', label: 'PLUGIN_STUDIO.Checks.Denials', state: 'ok', detail: '' });
    this.checks.set(out);
    this.checking.set(false);
  }

  async callTasks(method: string, args: unknown[]): Promise<void> {
    const p = this.plugin();
    if (!p) return;
    this.calling.set(true);
    try {
      const real = args.map((a) => (a === '__first__' ? this.firstContainer : a));
      const res = await this.runtime.invokeContract(p.pluginId, 'tasks', method, real);
      if (method === 'listContainers' && Array.isArray(res) && res[0] && typeof res[0] === 'object') this.firstContainer = String((res[0] as { id?: unknown }).id ?? '');
      this.callResult.set(JSON.stringify(res, null, 2).slice(0, 20000));
    } catch (e) {
      this.callResult.set(this.translate.instant('PLUGIN_STUDIO.Preview.Call error', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      this.calling.set(false);
      void this.refreshSide();
    }
  }

  /** Writes a message into Claude Code's input, WITHOUT sending: the person sends it. */
  sendToAgent(text: string): void {
    const id = this.terminalId();
    if (!id) return;
    // The text carries plugin output (audit errors, test output): no control characters, so it
    // cannot end the bracketed paste and type into the agent on its own.
    this.terminals.write(id, `\x1b[200~${terminalSafe(text)}\x1b[201~`);
  }

  private terminalKey(): string {
    return `plugin-studio:${this.plugin()?.pluginId ?? ''}`;
  }

  private async ensureTerminal(fresh: boolean): Promise<void> {
    const p = this.plugin();
    if (!p) return;
    const existing = this.terminals.activeIdForSession(this.terminalKey());
    if (existing) { this.terminalId.set(existing); this.watchActivity(existing); this.armBuildWatch(); return; }
    this.booting.set(true);
    try {
      const id = await this.terminals.create({ sessionId: this.terminalKey(), cwd: p.path });
      this.terminalId.set(id);
      this.watchActivity(id);
      await this.waitFor(id, SHELL_PROMPT_RE, 4000);
      if (!fresh) {
        await this.resumeOrStart(id);
        return;
      }
      const up = await this.launchCli(id);
      this.booting.set(false);
      if (!up) return;
      await this.sleep(1500);
      if (this.terminalId() === id) this.terminals.write(id, `\x1b[200~${this.firstPrompt(p)}\x1b[201~`);
    } catch (e) {
      this.terminalError.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.armBuildWatch();
      this.booting.set(false);
    }
  }

  /** Prompt pasted WITHOUT sending and left open: the person completes it with what they want and presses Enter. */
  private firstPrompt(p: StudioPlugin): string {
    return `You are building the PromptOps plugin ${p.pluginId} in this folder. ` +
      `Where it acts: ${ZONES.find((z) => z.id === p.zone)?.title}. Read CLAUDE.md and the part of PLUGIN_GUIDE.md for this zone. ` +
      `Change src/plugin.js and the manifest (give it a proper name), add tests and run node --test until they pass. ` +
      `When a change is ready, tell me to press Reload in the Plugin Studio. What the plugin should do: `;
  }

  private waitFor(id: string, re: RegExp, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let tail = '';
      let done = false;
      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        untap();
        resolve(ok);
      };
      const untap = this.terminals.tapOutput(id, (data) => {
        tail = (tail + data).slice(-4096);
        // TUIs split the text with cursor sequences: also try on the cleaned-up text.
        if (re.test(tail) || re.test(tail.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, ' '))) finish(true);
      });
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  private sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
}
