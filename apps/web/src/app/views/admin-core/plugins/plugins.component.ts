import { Component, CUSTOM_ELEMENTS_SCHEMA, OnDestroy, OnInit, computed, effect, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { SessionsGuideOverlayComponent } from '../sessions/sessions-guide/sessions-guide-overlay.component';
import { PluginsGuideService } from './plugins-guide.service';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  AuditEntry,
  InstalledPlugin,
  PLUGIN_CATEGORIES,
  PluginRegistryService,
  RegistryPlugin,
  describePermission,
} from './plugin-registry.service';
import { PluginConfigFormComponent } from './plugin-config-form.component';
import { GITHUB_ISSUES_URL, openExternal } from '@core/local-mode';
import { PROVIDERS_SHOWN, PluginProvider, declaredProviders } from './plugin-providers';
import { PluginRuntimeService } from './plugin-runtime.service';
import { PluginButtonPolicyComponent } from './plugin-button-policy.component';
import { ABSORBED_BY_BUILTIN, BUILTIN_PLUGINS, BuiltinKey, BuiltinPluginsService, PROMPTOPS_PUBLISHER } from './builtin-plugins.service';
import { InteractionService } from '../sessions/services/interaction.service';
import { VerifiedBadgeComponent } from './verified-badge.component';
import { Store } from '@ngrx/store';
import { toSignal } from '@angular/core/rxjs-interop';
import { getUser } from '../../../../store/authentication/authentication.selector';
import { TEMPLATES_REPO } from './plugin-section-guide';
import { SwalService } from '@core/services/swal.service';

const PLUGINS_LAYOUT_KEY = 'po.plugins.layout';

/** Catalog section where each built-in plugin appears. */
const BUILTIN_SECTION: Record<BuiltinKey, string> = {
  'agent-evals': 'pages', 'git-writer': 'pages', browser: 'pages',
  ssh: 'data', database: 'data', docker: 'data', 'multi-session': 'agent',
  'ai-squad': 'agent', goal: 'agent', worker: 'agent', 'auto-approve': 'agent', 'floor-plan': 'pages', 'agents-dashboard': 'agent',
};

/** Publishers shown for the official plugins (see publisherOf). */
const OFFICIAL_PUBLISHERS: Record<string, { handle: string; avatar: string | null; verified: boolean; kind: 'user' | 'team' }> = {
  'promptops.clickup': { handle: 'shellonback', avatar: 'https://github.com/shellonback.png?size=64', verified: true, kind: 'team' },
  'promptops.trello': { handle: 'shellonback', avatar: 'https://github.com/shellonback.png?size=64', verified: true, kind: 'team' },
  'promptops.jira': { handle: 'shellonback', avatar: 'https://github.com/shellonback.png?size=64', verified: true, kind: 'team' },
  'promptops.agent-evals': { handle: 'promptops', avatar: null, verified: true, kind: 'team' },
  'promptops.git-writer': { handle: 'promptops', avatar: null, verified: true, kind: 'team' },
};

@Component({
  selector: 'app-plugins',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, RouterLink, VerifiedBadgeComponent, PluginConfigFormComponent, PluginButtonPolicyComponent, SessionsGuideOverlayComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <div class="plg hp">
      <header class="hp-header">
        <div>
          <h1>{{ 'PLUGINS_PAGE.Title' | translate }}</h1>
          <p>{{ 'PLUGINS_PAGE.Intro' | translate }}</p>
        </div>
        <div class="hp-header-actions">
          <button type="button" class="hp-btn" (click)="startGuide()" [title]="'PLUGINS_PAGE.Tour hint' | translate">{{ 'PLUGINS_PAGE.Tour' | translate }}</button>
          <button type="button" class="hp-primary" (click)="startCreate()">{{ 'PLUGINS_PAGE.Create plugin' | translate }}</button>
        </div>
      </header>
      <app-sessions-guide-overlay [controller]="guide" />

      <nav class="hp-tabs" [attr.aria-label]="'PLUGINS_PAGE.Title' | translate">
        <button type="button" [class.selected]="view() === 'catalog'" (click)="view.set('catalog')">{{ 'PLUGINS_PAGE.Catalog' | translate }} <small>{{ catalog().length + catalogBuiltins().length }}</small></button>
        @if (runtime.available) {
          <button type="button" [class.selected]="view() === 'installed'" (click)="view.set('installed')">
            {{ 'PLUGINS_PAGE.Installed' | translate }} <small>{{ visibleInstalled().length + installedBuiltins().length }}</small>
            @if (runtime.updates().length) { <small>{{ 'PLUGINS_PAGE.Updates count' | translate: { count: runtime.updates().length } }}</small> }
          </button>
        }
        <button type="button" [class.selected]="view() === 'mine'" (click)="openMine()">{{ 'PLUGINS_PAGE.My plugins' | translate }} @if (devPlugins().length) { <small>{{ devPlugins().length }}</small> }</button>
        <!-- Grid or list: applies to all tabs, remembered on this device -->
        <span class="hp-layout" role="group" [attr.aria-label]="'PLUGINS_PAGE.Layout' | translate">
          <button type="button" [class.on]="!isList()" (click)="setLayout('grid')" [title]="'PLUGINS_PAGE.Grid' | translate" [attr.aria-label]="'PLUGINS_PAGE.Show as a grid' | translate"><iconify-icon icon="solar:widget-4-linear" width="16" aria-hidden="true"></iconify-icon></button>
          <button type="button" [class.on]="isList()" (click)="setLayout('list')" [title]="'PLUGINS_PAGE.List' | translate" [attr.aria-label]="'PLUGINS_PAGE.Show as a list' | translate"><iconify-icon icon="solar:hamburger-menu-linear" width="16" aria-hidden="true"></iconify-icon></button>
        </span>
      </nav>

      <ng-template #builtinCard let-b>
          <article class="hp-card" [class.is-installed]="builtin.isInstalled(b.key)" [class.is-off]="builtin.isInstalled(b.key) && !builtin.isOn(b.key)">
            <div class="hp-card-head">
              <div class="hp-lead-row">
                @let pub = b.publisher ?? promptopsPublisher;
                <span class="hp-avatar-wrap">
                  <img class="hp-avatar" [class.hp-avatar-brand]="pub.label === 'promptops'" [src]="pub.avatar" alt="" width="28" height="28">
                  @if (pub.verified) { <span class="hp-avatar-check"><app-verified-badge [verified]="true" [kind]="pub.kind" [size]="13" /></span> }
                </span>
                @let bName = 'BUILTIN_PLUGINS.' + b.key + '.Name' | translate;
                <div class="hp-title" [attr.title]="pub.label + '/' + bName">
                  <span class="hp-owner">{{ pub.label }}/</span><span class="hp-name">{{ bName }}</span>
                </div>
                @if (b.isNew) { <span class="hp-new" title="New in PromptOps">New</span> }
              </div>
            </div>
            <div class="hp-subrow">
              <span class="hp-sub">{{ 'BUILTIN_PLUGINS.Category.' + b.category | translate }} · {{ 'PLUGINS_PAGE.built in' | translate }}</span>
            </div>
            <p class="hp-desc">{{ 'BUILTIN_PLUGINS.' + b.key + '.Description' | translate }}</p>
            <div class="hp-meta"><span class="hp-tagline" [title]="'PLUGINS_PAGE.Built in hint' | translate">{{ 'PLUGINS_PAGE.Built into PromptOps' | translate }}</span><span>{{ 'BUILTIN_PLUGINS.' + b.key + '.Where' | translate }}</span></div>
            <div class="hp-card-actions">
              @if (builtin.isInstalled(b.key)) {
                <label class="hp-switch" [attr.title]="(builtin.isOn(b.key) ? 'PLUGINS_PAGE.Turn off builtin' : 'PLUGINS_PAGE.Turn it on') | translate">
                  <input class="form-check-input" type="checkbox" role="switch" [checked]="builtin.isOn(b.key)" (change)="setBuiltin(b.key, $any($event.target).checked)" [attr.aria-label]="'PLUGINS_PAGE.Enable name' | translate: { name: bName }">
                  <span>{{ (builtin.isOn(b.key) ? 'PLUGINS_PAGE.On' : 'PLUGINS_PAGE.Off') | translate }}</span>
                </label>
                <span class="hp-grow"></span>
                <button type="button" class="hp-btn" [title]="'PLUGINS_PAGE.Uninstall builtin hint' | translate" (click)="installBuiltin(b.key, false)">{{ 'PLUGINS_PAGE.Uninstall' | translate }}</button>
              } @else {
                <span class="hp-grow"></span>
                <button type="button" class="hp-primary sm" (click)="installBuiltin(b.key, true)">{{ 'PLUGINS_PAGE.Install' | translate }}</button>
              }
            </div>
          </article>
      </ng-template>
      <ng-template #card let-p let-zone="zone">
        <!-- With the approval panel open the card takes the whole row: the neighbors keep their height. -->
        <article class="hp-card" [class.is-installed]="!!installedAny(p.plugin_id)" [class.wide]="isApproving(p, zone)">
          <div class="hp-card-head">
            <div class="hp-lead-row">
              <!-- The blue check sits on the logo icon, in the bottom-right corner -->
              <span class="hp-avatar-wrap">
                @if (publisherAvatar(p); as src) { <img class="hp-avatar" [class.hp-avatar-brand]="publisherOf(p).handle === 'promptops'" [src]="src" alt="" loading="lazy" width="28" height="28" (error)="avatarFailed(src)"> }
                @else { <span class="hp-avatar hp-avatar-fallback">{{ publisherOf(p).handle.charAt(0) }}</span> }
                @if (publisherOf(p).verified) { <span class="hp-avatar-check"><app-verified-badge [verified]="true" [kind]="publisherOf(p).kind" [size]="13" /></span> }
              </span>
              <div class="hp-title" [attr.title]="publisherOf(p).handle + '/' + p.name">
                <span class="hp-owner">{{ publisherOf(p).handle }}/</span><span class="hp-name">{{ p.name }}</span>
              </div>
            </div>
          </div>
          <div class="hp-subrow">
            <span class="hp-sub">{{ categoryLabel(p.category) }} · v{{ p.version }}</span>
            <span class="hp-side">
              @if (p.repo_url) { <a class="hp-go" [href]="p.repo_url" target="_blank" rel="noopener noreferrer" [title]="'PLUGINS_PAGE.Source hint' | translate">{{ 'PLUGINS_PAGE.Source' | translate }}</a> }
            </span>
          </div>
          <p class="hp-desc" [class.is-empty]="!p.description">{{ p.description || ('PLUGINS_PAGE.No description' | translate) }}</p>
          <div class="hp-meta">
            <span>{{ (p.publisher.kind === 'team' ? 'PLUGINS_PAGE.Company' : 'PLUGINS_PAGE.User') | translate }}</span>
            <span>{{ ago(p.updated_at) }}</span>
            @if (providersOf($safeNavigationMigration(p.manifest?.providers)); as works) {
              @if (works.length) {
                <span class="hp-works" [attr.title]="'PLUGINS_PAGE.Works with hint' | translate: { names: providerNames(works) }" [attr.aria-label]="'PLUGINS_PAGE.Works with' | translate: { names: providerNames(works) }">
                  @for (pr of works.slice(0, providersShown); track pr.id) { <img [src]="pr.logo" alt="" width="16" height="16" /> }
                  @if (works.length > providersShown) { <small>+{{ works.length - providersShown }}</small> }
                </span>
              }
            }
          </div>

          @if (isApproving(p, zone)) {
            <!-- Explicit approval of the permissions, before downloading anything -->
            <div class="hp-approve">
              <div class="hp-approve-title">{{ 'PLUGINS_PAGE.Will be able to' | translate: { name: p.name } }}</div>
              <ul>
                @for (perm of p.manifest?.permissions || []; track perm) { <li>{{ describe(perm) }}</li> }
                @if (!(p.manifest?.permissions || []).length) { <li>{{ 'PLUGINS_PAGE.Nothing outside sandbox' | translate }}</li> }
              </ul>
              <div class="hp-approve-never">{{ 'PLUGINS_PAGE.Never reads' | translate }}</div>
              @if (error()) { <div class="hp-error">{{ error() }}</div> }
              <div class="hp-approve-actions">
                <button type="button" class="hp-btn" (click)="approving.set(null)">{{ 'PLUGINS_PAGE.Cancel' | translate }}</button>
                <button type="button" class="hp-primary" [disabled]="saving()" (click)="install(p)">{{ 'PLUGINS_PAGE.Install and enable' | translate }}</button>
              </div>
            </div>
          } @else if (runtime.available) {
            <!-- Fixed footer: status on the left, actions on the right -->
            <div class="hp-card-actions">
              @if (installedAny(p.plugin_id); as inst) {
                <span class="hp-installed-chip" [attr.title]="inst.dev ? ('PLUGINS_PAGE.Linked from folder' | translate) : ('PLUGINS_PAGE.Installed version' | translate: { version: inst.version })">
                  <iconify-icon icon="solar:check-circle-bold" width="14"></iconify-icon>
                  {{ (inst.dev ? 'PLUGINS_PAGE.Installed local' : 'PLUGINS_PAGE.Installed') | translate }}
                </span>
                <span class="hp-grow"></span>
                @if (!inst.dev && inst.bundleSha256 !== p.bundle_sha256) {
                  <button type="button" class="hp-primary sm" [attr.title]="'PLUGINS_PAGE.Update to version' | translate: { version: p.version }" (click)="startInstall(p, zone)">{{ 'PLUGINS_PAGE.Update' | translate }}</button>
                }
                <button type="button" class="hp-btn" [title]="'PLUGINS_PAGE.Feedback hint' | translate" (click)="askFeedback(p)">{{ 'PLUGINS_PAGE.Feedback' | translate }}</button>
                <button type="button" class="hp-btn" [disabled]="saving()" (click)="uninstallFromCatalog(inst)">{{ 'PLUGINS_PAGE.Uninstall' | translate }}</button>
              } @else {
                <!-- No feedback here: you only write about a plugin you installed and tried -->
                <span class="hp-grow"></span>
                <button type="button" class="hp-primary sm" (click)="startInstall(p, zone)">{{ 'PLUGINS_PAGE.Install' | translate }}</button>
              }
            </div>
          }
        </article>
      </ng-template>

      <!-- Catalog -->
      @if (view() === 'catalog') {
        @if (loading()) {
          <p class="hp-hint">{{ 'PLUGINS_PAGE.Loading' | translate }}</p>
        } @else if (registryMissing()) {
          <div class="plg-empty">
            <iconify-icon icon="solar:server-square-cloud-linear" width="28"></iconify-icon>
            <div>{{ 'PLUGINS_PAGE.Catalog unreachable' | translate }}</div>
            <div class="small text-muted">{{ 'PLUGINS_PAGE.Catalog unreachable hint' | translate }}</div>
          </div>
        } @else {
          @if (error() && !approving()) { <div class="hp-error" role="alert">{{ error() }}</div> }
          @if (showHighlights()) {
            @if (verifiedPlugins().length) {
              <section class="hp-section">
                <div class="hp-section-head"><h2>{{ 'PLUGINS_PAGE.Verified publishers' | translate }}</h2><span>{{ 'PLUGINS_PAGE.Verified publishers hint' | translate }}</span></div>
                <div class="hp-grid" [class.is-list]="isList()">
                  @for (p of verifiedPlugins(); track p.id) { <ng-container *ngTemplateOutlet="card; context: { $implicit: p, zone: 'verified' }" /> }
                </div>
              </section>
            }
            <section class="hp-section">
              <div class="hp-section-head"><h2>{{ 'PLUGINS_PAGE.Recently updated' | translate }}</h2><span>{{ 'PLUGINS_PAGE.Recently updated hint' | translate }}</span></div>
              <div class="hp-grid" [class.is-list]="isList()">
                @for (p of recentPlugins(); track p.id) { <ng-container *ngTemplateOutlet="card; context: { $implicit: p, zone: 'recent' }" /> }
              </div>
            </section>
          }

          <section class="hp-section">
            <div class="hp-section-head"><h2>{{ 'PLUGINS_PAGE.All plugins' | translate }}</h2><span>{{ 'PLUGINS_PAGE.All plugins hint' | translate }}</span></div>
            <div class="hp-toolbar">
              <input class="hp-search" [placeholder]="'PLUGINS_PAGE.Search plugins' | translate" [ngModel]="query()" (ngModelChange)="query.set($event)" (keyup.enter)="loadCatalog()" [attr.aria-label]="'PLUGINS_PAGE.Search plugins' | translate">
              <div class="hp-filterbar">
                <div class="hp-filters">
                  <button type="button" class="hp-chip" [class.on]="!category()" (click)="pickCategory('')">{{ 'PLUGINS_PAGE.All' | translate }}</button>
                  @for (c of categories; track c.id) {
                    <button type="button" class="hp-chip" [class.on]="category() === c.id" (click)="pickCategory(c.id)" [attr.title]="'PLUGINS_PAGE.Category.' + c.id + ' hint' | translate">{{ 'PLUGINS_PAGE.Category.' + c.id | translate }}</button>
                  }
                </div>
                <label class="hp-sort" [title]="'PLUGINS_PAGE.Sort order' | translate">
                  <iconify-icon icon="solar:sort-vertical-linear" width="16" aria-hidden="true"></iconify-icon>
                  <select class="hp-select" [ngModel]="sort()" (ngModelChange)="sort.set($event)" [attr.aria-label]="'PLUGINS_PAGE.Sort order' | translate">
                    @for (o of sorts; track o.id) { <option [value]="o.id">{{ 'PLUGINS_PAGE.Sort.' + o.id | translate }}</option> }
                  </select>
                </label>
              </div>
            </div>

            @if (!catalog().length && !catalogBuiltins().length) {
              <div class="plg-empty">
                <iconify-icon icon="solar:box-minimalistic-linear" width="28"></iconify-icon>
                <div>{{ 'PLUGINS_PAGE.No plugins' | translate }}</div>
                <div class="small text-muted">{{ 'PLUGINS_PAGE.No plugins hint' | translate }}</div>
              </div>
            } @else {
              <div class="hp-grid" [class.is-list]="isList()">
                @for (b of catalogBuiltins(); track b.key) { <ng-container *ngTemplateOutlet="builtinCard; context: { $implicit: b }" /> }
                @for (p of sortedCatalog(); track p.id) { <ng-container *ngTemplateOutlet="card; context: { $implicit: p, zone: 'all' }" /> }
              </div>
            }
          </section>

          <p class="hp-note">{{ 'PLUGINS_PAGE.Want listed' | translate }}
            <button type="button" class="hp-btn" (click)="startCreate()">{{ 'PLUGINS_PAGE.Create a plugin' | translate }}</button></p>
        }
      }

      <!-- Installed in the desktop runtime -->
      @if (view() === 'installed') {
        @if (error()) { <div class="alert alert-danger py-2 small">{{ error() }}</div> }
        <!-- Updates: versions approved by the registry. With new permissions the user always decides. -->
        <div class="hp-updates">
          <label class="hp-switch" [title]="'PLUGINS_PAGE.Auto update hint' | translate">
            <input class="form-check-input" type="checkbox" role="switch" [checked]="runtime.autoUpdate()" (change)="runtime.setAutoUpdate(!runtime.autoUpdate())" [attr.aria-label]="'PLUGINS_PAGE.Update plugins automatically' | translate">
            <span>{{ 'PLUGINS_PAGE.Update automatically' | translate }}</span>
          </label>
          <span class="hp-grow"></span>
          @if (updateNote(); as n) { <span class="hp-updates-note">{{ n }}</span> }
          <button type="button" class="hp-btn" [disabled]="checkingUpdates()" (click)="checkUpdates()">{{ (checkingUpdates() ? 'PLUGINS_PAGE.Checking' : 'PLUGINS_PAGE.Check for updates') | translate }}</button>
        </div>
        <div class="hp-grid" [class.is-list]="isList()">
        <!-- PromptOps built-in plugins: part of the app, no repository. They start enabled and can be switched off. -->
        @for (b of installedBuiltins(); track b.key) { <ng-container *ngTemplateOutlet="builtinCard; context: { $implicit: b }" /> }
        @for (inst of visibleInstalled(); track inst.pluginId) {
          <!-- Same card as the catalog. With a panel open it takes the whole row, so the content has room. -->
          <article class="hp-card is-installed" [class.wide]="panelOpen(inst)" [class.is-off]="!inst.enabled">
              <div class="hp-card-head">
                <div class="hp-lead-row">
                  <span class="hp-avatar-wrap">
                    @let ip = installedPublisher(inst);
                    @if (ip.avatar; as src) { <img class="hp-avatar" [class.hp-avatar-brand]="ip.handle === 'promptops'" [src]="src" alt="" loading="lazy" width="28" height="28" (error)="avatarFailed(src)"> }
                    @else { <span class="hp-avatar hp-avatar-fallback">{{ ip.handle.charAt(0) }}</span> }
                    @if (ip.verified) { <span class="hp-avatar-check"><app-verified-badge [verified]="true" [kind]="ip.kind" [size]="13" /></span> }
                  </span>
                  <div class="hp-title" [attr.title]="ip.handle + '/' + inst.name">
                    <span class="hp-owner">{{ ip.handle }}/</span><span class="hp-name">{{ inst.name }}</span>
                  </div>
                </div>
              </div>
              <div class="hp-subrow">
                <span class="hp-sub">{{ categoryLabel(inst.category) }} · v{{ inst.version }}</span>
                <span class="hp-side">
                  @if (inst.repository) { <a class="hp-go" [href]="inst.repository" target="_blank" rel="noopener noreferrer" [title]="'PLUGINS_PAGE.Source hint' | translate">{{ 'PLUGINS_PAGE.Source' | translate }}</a> }
                </span>
              </div>
              <p class="hp-desc" [class.is-empty]="!catalogOf(inst.pluginId)?.description">{{ catalogOf(inst.pluginId)?.description || inst.pluginId }}</p>
              @if (inst.disabledReason) { <div class="hp-error">{{ inst.disabledReason }}</div> }
              <div class="hp-meta">
                @if (inst.dev) { <span class="hp-tagline" [title]="'PLUGINS_PAGE.Local folder hint' | translate">{{ 'PLUGINS_PAGE.Local folder' | translate }}</span> }
                @if (catalogOf(inst.pluginId); as cp) { <button type="button" class="hp-go hp-fb" [title]="'PLUGINS_PAGE.Feedback hint' | translate" (click)="askFeedback(cp)">{{ 'PLUGINS_PAGE.Feedback' | translate }}</button> }
                @else if (!inst.dev) { <span>{{ 'PLUGINS_PAGE.Installed from catalog' | translate }}</span> }
                @if (providersOf(inst.providers); as works) {
                  @if (works.length) {
                    <span class="hp-works" [attr.title]="'PLUGINS_PAGE.Works with hint' | translate: { names: providerNames(works) }">
                      @for (pr of works.slice(0, providersShown); track pr.id) { <img [src]="pr.logo" alt="" width="16" height="16" /> }
                      @if (works.length > providersShown) { <small>+{{ works.length - providersShown }}</small> }
                    </span>
                  }
                }
              </div>
              <!-- Footer as in the catalog: status on the left, on the right the button that leads to where the plugin works -->
              <div class="hp-card-actions">
                <label class="hp-switch" [attr.title]="(inst.enabled ? 'PLUGINS_PAGE.Turn it off' : 'PLUGINS_PAGE.Turn it on') | translate">
                  <input class="form-check-input" type="checkbox" role="switch" [checked]="inst.enabled" (change)="toggle(inst)" [attr.aria-label]="'PLUGINS_PAGE.Enable name' | translate: { name: inst.name }">
                  <span>{{ (inst.enabled ? 'PLUGINS_PAGE.On' : 'PLUGINS_PAGE.Off') | translate }}</span>
                </label>
                <span class="hp-grow"></span>
                @if (updateOf(inst.pluginId); as u) {
                  <button type="button" class="hp-primary sm" [disabled]="runtime.updating().includes(inst.pluginId)" [attr.title]="'PLUGINS_PAGE.Installed and available' | translate: { installed: u.installed, available: u.available }" (click)="updateInstalled(inst)">
                    {{ runtime.updating().includes(inst.pluginId) ? ('PLUGINS_PAGE.Updating' | translate) : ('PLUGINS_PAGE.Update to version' | translate: { version: u.available }) }}
                  </button>
                }
                @if (openTarget(inst); as go) {
                  <a class="hp-primary sm" [class.disabled]="!inst.enabled" [routerLink]="inst.enabled ? go.link : null" [attr.aria-disabled]="!inst.enabled || null"
                    [attr.title]="inst.enabled ? go.hint : ('PLUGINS_PAGE.Turn on first' | translate)">{{ go.label }}</a>
                }
              </div>
              <div class="hp-more">
                <button type="button" class="hp-btn" (click)="openConfig(inst)">{{ 'PLUGINS_PAGE.Configure' | translate }}</button>
                <button type="button" class="hp-btn" (click)="openActivity(inst)">{{ 'PLUGINS_PAGE.Activity' | translate }}</button>
                @if (inst.enabled) { <button type="button" class="hp-btn" (click)="openTester(inst)">{{ 'PLUGINS_PAGE.Test' | translate }}</button> }
                <span class="hp-grow"></span>
                <button type="button" class="hp-btn" (click)="uninstall(inst)">{{ 'PLUGINS_PAGE.Uninstall' | translate }}</button>
              </div>

              @if (configuring()?.pluginId === inst.pluginId) {
                <div class="plg-newpub mt-2">
                  <app-plugin-button-policy [pluginId]="inst.pluginId" />
                  <app-plugin-config-form [pluginId]="inst.pluginId" (saved)="configuring.set(null)" />
                  <button class="btn btn-light btn-sm mt-2" (click)="configuring.set(null)">{{ 'PLUGINS_PAGE.Close' | translate }}</button>
                </div>
              }

              @if (testing()?.pluginId === inst.pluginId) {
                <div class="plg-newpub mt-2">
                  <div class="d-flex align-items-center mb-2">
                    <span class="small fw-semibold">{{ 'PLUGINS_PAGE.Call contract' | translate: { category: inst.category } }}</span>
                    <span class="flex-grow-1"></span>
                    <button class="btn btn-light btn-sm" (click)="testing.set(null)">{{ 'PLUGINS_PAGE.Close' | translate }}</button>
                  </div>
                  @if (!testMethods().length) {
                    <div class="small text-muted">{{ 'PLUGINS_PAGE.No contract' | translate: { category: inst.category } }}</div>
                  } @else {
                    <div class="row g-2">
                      <div class="col-md-4">
                        <label class="form-label small">{{ 'PLUGINS_PAGE.Method' | translate }}</label>
                        <select class="form-select form-select-sm font-monospace" [(ngModel)]="test.method">
                          @for (m of testMethods(); track m) { <option [value]="m">{{ m }}</option> }
                        </select>
                      </div>
                      <div class="col-md-8">
                        <label class="form-label small">{{ 'PLUGINS_PAGE.Arguments' | translate }}</label>
                        <input class="form-control form-control-sm font-monospace" [(ngModel)]="test.args" placeholder='[] or [{"resourceId":"users","limit":5}]'>
                      </div>
                    </div>
                    <div class="d-flex justify-content-end mt-2">
                      <button class="btn btn-primary btn-sm" [disabled]="saving()" (click)="runTest(inst)">{{ 'PLUGINS_PAGE.Run' | translate }}</button>
                    </div>
                    @if (test.result !== null) { <pre class="plg-audit font-monospace mt-2 mb-0">{{ test.result }}</pre> }
                  }
                </div>
              }

              @if (activityOf()?.pluginId === inst.pluginId) {
                <div class="plg-newpub mt-2">
                  <div class="d-flex align-items-center mb-1">
                    <span class="small fw-semibold">{{ 'PLUGINS_PAGE.Activity title' | translate }}</span>
                    <span class="flex-grow-1"></span>
                    <button class="btn btn-light btn-sm" (click)="activityOf.set(null)">{{ 'PLUGINS_PAGE.Close' | translate }}</button>
                  </div>
                  <div class="plg-audit font-monospace">
                    @for (a of activity(); track $index) {
                      <div [class.text-danger]="!a.ok">
                        {{ a.ts * 1000 | date: 'HH:mm:ss' }} {{ a.method }} {{ a.target || '' }} {{ a.ok ? '' : ('PLUGINS_PAGE.Denied' | translate: { error: a.error }) }}
                      </div>
                    } @empty { <div class="text-muted">{{ 'PLUGINS_PAGE.No activity' | translate }}</div> }
                  </div>
                </div>
              }
          </article>
        }
        </div>

      }

      <!-- My plugins: the ones you build on this computer -->
      @if (view() === 'mine') {
        <div class="hp-mine-intro">
          <p class="hp-note">{{ 'PLUGINS_PAGE.Mine intro' | translate }}</p>
          <button type="button" class="hp-primary sm" (click)="startCreate()">{{ 'PLUGINS_PAGE.Create a plugin' | translate }}</button>
        </div>

        <div class="plg-newpub mt-3">
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" id="devmode" [checked]="runtime.developerMode()" (change)="toggleDeveloperMode()">
            <label class="form-check-label small fw-semibold" for="devmode">{{ 'PLUGINS_PAGE.Developer mode' | translate }}</label>
          </div>
          <div class="small text-muted">
            {{ 'PLUGINS_PAGE.Developer mode hint' | translate }}
          </div>
          @if (runtime.developerMode()) {
            <div class="d-flex gap-2 mt-2">
              <input class="form-control form-control-sm font-monospace" placeholder="/path/to/plugin-folder" [(ngModel)]="linkPath">
              <button class="btn btn-outline-primary btn-sm text-nowrap" (click)="linkLocal()">{{ 'PLUGINS_PAGE.Link folder' | translate }}</button>
            </div>
          }
        </div>

        @if (devPlugins().length) {
          <div class="hp-dev-list mt-3">
            @for (inst of devPlugins(); track inst.pluginId) {
              <div class="hp-dev-row">
                <iconify-icon icon="solar:folder-with-files-linear" width="18" aria-hidden="true"></iconify-icon>
                <div class="hp-dev-text">
                  <span class="hp-name">{{ inst.name }}</span>
                  <span class="hp-sub">{{ inst.pluginId }} · v{{ inst.version }}</span>
                </div>
                <span class="hp-installed-chip">{{ 'PLUGINS_PAGE.Local folder' | translate }}</span>
                <button type="button" class="hp-btn" (click)="view.set('installed')">{{ 'PLUGINS_PAGE.Settings' | translate }}</button>
              </div>
            }
          </div>
        }

        <p class="hp-note mt-3">{{ 'PLUGINS_PAGE.Share before' | translate }}
          <a [href]="registryRepoUrl" target="_blank" rel="noopener noreferrer">{{ 'PLUGINS_PAGE.plugin registry' | translate }}</a>{{ 'PLUGINS_PAGE.Share after' | translate }}</p>
      }
    </div>

  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    /* Same language as AI Accounts: full width, app font, neutral tones with
       ink instead of the accent, underlined tabs, cards with the app radius. */
    :host { display: block; --hp-bg: var(--po-page-surface, var(--po-bg-2)); --hp-soft: var(--po-page-soft, var(--po-bg-3)); --hp-hover: var(--po-bg-4);
      --hp-ink: var(--po-page-ink, var(--po-text-primary)); --hp-muted: var(--po-page-muted, var(--po-text-secondary)); --hp-line: var(--po-page-border, var(--po-border-subtle)); }
    .hp { padding: 24px 12px; color: var(--hp-ink); }
    .hp button { font: inherit; cursor: pointer; }
    .hp-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .hp-mine-intro { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .hp-dev-list { display: flex; flex-direction: column; gap: 8px; }
    .hp-dev-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border: 1px solid var(--hp-line); border-radius: var(--po-radius-lg, 12px); background: var(--hp-bg); }
    .hp-dev-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
    .hp-dev-text .hp-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hp-header-actions { display: flex; align-items: center; gap: 8px; }
    .hp-header h1 { margin: 0 0 6px; font-size: 1.25rem; font-weight: 600; letter-spacing: -.4px; }
    .hp-header p, .hp-hint, .hp-note { color: var(--hp-muted); font-size: 13px; line-height: 1.6; margin: 0; }
    .hp-hint { margin-bottom: 20px; } .hp-note { margin-top: 20px; font-size: 12px; }

    .hp-tabs { display: flex; gap: 24px; border-bottom: 1px solid var(--hp-line); margin: 24px 0 18px; }
    .hp-tabs button { padding: 0 0 12px; background: none; border: 0; border-bottom: 2px solid transparent; color: var(--hp-muted); font-size: 13px; }
    .hp-tabs button.selected { border-bottom-color: var(--hp-ink); color: var(--hp-ink); }
    .hp-tabs small { margin-left: 5px; font-size: 10px; color: var(--hp-muted); }
    .hp-tabs .hp-layout { margin-left: auto; align-self: flex-start; display: inline-flex; border: 1px solid var(--hp-line); border-radius: var(--po-radius-md, 6px); overflow: hidden; }
    .hp-tabs .hp-layout button { padding: 5px 8px; border: 0; border-radius: 0; line-height: 0; color: var(--hp-muted); }
    .hp-tabs .hp-layout button + button { border-left: 1px solid var(--hp-line); }
    .hp-tabs .hp-layout button.on { background: var(--hp-soft); color: var(--hp-ink); }
    .hp-tabs .hp-layout button:focus-visible { outline-offset: -2px; }

    .hp-primary { border: 1px solid var(--hp-ink); border-radius: var(--po-radius-md, 6px); padding: 9px 13px; font-size: 12px; background: var(--hp-ink); color: var(--hp-bg); white-space: nowrap; }
    .hp-primary:hover:not(:disabled) { opacity: .85; }
    .hp-btn { background: none; border: 0; padding: 4px 0; color: var(--hp-muted); font-size: 12px; white-space: nowrap; }
    .hp-btn:hover:not(:disabled) { color: var(--hp-ink); text-decoration: underline; text-underline-offset: 3px; }
    .hp button:disabled { opacity: .45; cursor: not-allowed; }
    .hp button:focus-visible, .hp a:focus-visible, .hp input:focus-visible { outline: 2px solid var(--hp-ink); outline-offset: 3px; }

    .hp-section { margin-bottom: 28px; }
    .hp-section-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
    .hp-section-head h2 { font-size: 14px; font-weight: 600; margin: 0; } .hp-section-head span { font-size: 12px; color: var(--hp-muted); }
    /* All cards equal: same height in the row, same lines inside, footer anchored at the bottom.
       At most four per row and never narrower than 280px, so the footer doesn't overflow the card with the sidebar open. */
    .hp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(max(280px, (100% - 48px) / 4), 1fr)); gap: 16px; align-items: stretch; }
    .hp-installed { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
    @media (max-width: 1199px) { .hp-installed { grid-template-columns: minmax(0, 1fr); } }
    @media (max-width: 576px) { .hp-grid { grid-template-columns: minmax(0, 1fr); } .hp { padding: 20px 12px; } }
    /* List: one card per row. From 900px up the card is a row with fixed columns, so rows line up:
       name · section · description (one line) · where it appears · actions. Below that it stays the normal single-column card. */
    .hp-grid.is-list { grid-template-columns: minmax(0, 1fr); gap: 8px; }
    @media (min-width: 900px) {
      .hp-grid.is-list .hp-card { display: grid; grid-template-columns: minmax(200px, 250px) minmax(150px, 200px) minmax(0, 1fr) minmax(0, 260px) auto; align-items: center; gap: 0 18px; padding: 10px 16px; }
      .hp-grid.is-list .hp-subrow { gap: 12px; }
      .hp-grid.is-list .hp-side { min-height: 0; }
      .hp-grid.is-list .hp-desc { -webkit-line-clamp: 1; min-height: 0; }
      .hp-grid.is-list .hp-meta { min-height: 0; }
      .hp-grid.is-list .hp-card-actions { margin: 0; border-top: 0; padding-top: 0; height: auto; justify-content: flex-end; }
      .hp-grid.is-list .hp-card-actions .hp-grow { display: none; }
      .hp-grid.is-list .hp-approve, .hp-grid.is-list .hp-more { grid-column: 1 / -1; }
    }
    .hp-card { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 16px; border: 1px solid var(--hp-line); border-radius: var(--po-radius-lg, 8px); background: var(--hp-bg); }
    .hp-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .hp-lead-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .hp-avatar { width: 28px; height: 28px; flex: none; border-radius: var(--po-radius-md, 6px); object-fit: contain; background: var(--hp-soft); }
    .hp-avatar-wrap { position: relative; display: inline-flex; flex: none; }
    .hp-avatar-brand { object-fit: contain; background: #fff; padding: 2px; }
    .hp-avatar-check { position: absolute; right: -5px; bottom: -5px; display: inline-flex; border-radius: 50%; background: var(--hp-bg); box-shadow: 0 0 0 1.5px var(--hp-bg); line-height: 0; }
    .hp-card.is-installed .hp-avatar-check { background: var(--hp-soft); box-shadow: 0 0 0 1.5px var(--hp-soft); }
    .hp-avatar-fallback { display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; text-transform: uppercase; color: var(--hp-muted); }
    .hp-new { flex: none; font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; padding: 1px 7px; border-radius: 10px; background: var(--promptops-primary, #6366f1); color: #fff; }
    .hp-title { font-size: 14px; line-height: 1.3; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hp-owner { color: var(--hp-muted); } .hp-name { font-weight: 600; margin-right: 4px; }
    .hp-go { font-size: 12px; color: var(--hp-muted); text-decoration: none; flex: none; } .hp-go:hover { color: var(--hp-ink); text-decoration: underline; text-underline-offset: 3px; }
    .hp-subrow { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .hp-side { display: flex; flex-direction: column; align-items: flex-end; justify-content: flex-start; gap: 2px; flex: none; min-height: 38px; }
    .hp-installs { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; color: var(--hp-ink); white-space: nowrap; flex: none; }
    .hp-sub, .hp-id, .hp-tagline { font-size: 12px; color: var(--hp-muted); overflow-wrap: anywhere; }
    .hp-id { font-family: var(--po-font-mono, ui-monospace, monospace); font-size: 11px; }
    .hp-tagline { border: 1px solid var(--hp-line); border-radius: var(--po-radius-sm, 4px); padding: 0 7px; line-height: 18px; font-size: 11px; }
    .hp-works { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; flex: none; }
    .hp-works img, .hp-works-item img { width: 16px; height: 16px; object-fit: contain; border-radius: 4px; }
    .hp-works small { font-size: 11px; font-weight: 600; color: var(--hp-muted); }
    .hp-works-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
    .hp-works-item { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--hp-ink); }
    .hp-unread { background: var(--hp-ink); color: var(--hp-bg); border-radius: 999px; padding: 1px 7px; font-weight: 600; }
    .hp-pages { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
    .hp-page-link { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: var(--hp-ink); text-decoration: none; border: 1px solid var(--hp-line); border-radius: var(--po-radius-md, 8px); padding: 4px 10px; }
    .hp-page-link:hover { border-color: var(--hp-ink); }
    .hp-desc { margin: 0; font-size: 13px; line-height: 1.55; color: var(--hp-muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: calc(2 * 1.55em); }
    .hp-desc.is-empty { font-style: italic; }
    .hp-desc-note { color: var(--hp-ink); }
    .hp-installed-chip.is-muted iconify-icon { color: var(--hp-muted); }
    .hp-fb strong { color: var(--hp-ink); font-weight: 600; margin-left: 3px; }
    /* If the row is too short the text gives way, never the provider icons. */
    .hp-meta > span:not(.hp-works):not(.hp-tagline) { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .hp-fb { flex: none; } button.hp-go { background: none; border: 0; padding: 0; } .hp button.hp-go { font-size: 12px; }
    .hp-card.is-off .hp-desc.hp-desc-note { opacity: 1; }
    .hp-note a { color: var(--hp-ink); text-underline-offset: 3px; }
    .hp-meta { display: flex; align-items: center; gap: 14px; flex-wrap: nowrap; min-height: 22px; font-size: 11px; color: var(--hp-muted); white-space: nowrap; overflow: hidden; }
    .hp-installed-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--hp-muted); white-space: nowrap; }
    .hp-installed-chip iconify-icon { color: var(--po-success, #1a9d5c); }
    .hp-card.is-installed { background: var(--hp-soft); }
    .hp-card-actions { display: flex; align-items: center; gap: 12px; height: 46px; box-sizing: border-box; border-top: 1px solid var(--hp-line); padding-top: 10px; margin-top: auto; }
    .hp-grow { flex: 1; }
    .hp-primary.sm { padding: 6px 12px; }
    .hp-inst-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    /* Installed tab: same card as the catalog */
    .hp-card.wide { grid-column: 1 / -1; }
    .hp-card.is-off .hp-avatar, .hp-card.is-off .hp-title, .hp-card.is-off .hp-desc { opacity: .55; }
    .hp-updates { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; padding: 10px 14px; border: 1px solid var(--hp-line); border-radius: 10px; }
    .hp-updates .hp-switch { font-size: 13px; color: var(--hp-ink); }
    .hp-updates-note { font-size: 12px; color: var(--hp-muted); }
    .hp-switch { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--hp-muted); margin: 0; cursor: pointer; }
    .hp-switch .form-check-input { margin: 0; width: 2.1em; height: 1.15em; cursor: pointer; float: none; border-radius: 2em; background-position: left center; }
    .hp-switch .form-check-input:checked { background-position: right center; }
    .hp-more { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    a.hp-primary { text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
    a.hp-primary.disabled { opacity: .45; pointer-events: none; }
    .hp-perms { display: flex; flex-wrap: wrap; gap: 6px; } .hp-perm { font-family: var(--po-font-mono, ui-monospace, monospace); font-size: 11px; color: var(--hp-muted); border: 1px solid var(--hp-line); border-radius: var(--po-radius-sm, 4px); padding: 1px 7px; }
    .hp-installed .hp-meta { gap: 16px; font-size: 12px; }

    .hp-approve { border-top: 1px solid var(--hp-line); padding-top: 12px; font-size: 13px; }
    .hp-approve-title { font-weight: 600; margin-bottom: 6px; } .hp-approve ul { margin: 0 0 8px; padding-left: 18px; color: var(--hp-muted); }
    .hp-approve-never { font-size: 12px; color: var(--hp-muted); margin-bottom: 12px; }
    .hp-approve-actions { display: flex; align-items: center; justify-content: flex-end; gap: 18px; }
    .hp-error, .hp-notice { border: 1px solid var(--hp-line); border-radius: var(--po-radius-md, 6px); background: var(--hp-soft); padding: 12px; margin: 0 0 16px; font-size: 12px; }
    .hp-error { border-left: 3px solid var(--hp-ink); }

    .hp-toolbar { display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px; }
    .hp-search { display: block; width: 100%; border: 1px solid var(--hp-line); border-radius: var(--po-radius-md, 6px); padding: 10px 12px; background: var(--hp-bg); color: var(--hp-ink); font-size: 13px; }
    .hp-search::placeholder { color: var(--hp-muted); }
    .hp-filterbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .hp-filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .hp-sort { display: inline-flex; align-items: center; gap: 6px; margin: 0; color: var(--hp-muted); flex: none; }
    .hp-select { border: 1px solid var(--hp-line); border-radius: var(--po-radius-md, 6px); padding: 6px 28px 6px 10px; font-size: 12px; background-color: var(--hp-bg); color: var(--hp-ink); cursor: pointer; }
    .hp-chip { border: 1px solid var(--hp-line); border-radius: var(--po-radius-md, 6px); padding: 6px 11px; font-size: 12px; background: var(--hp-bg); color: var(--hp-ink); }
    .hp-chip:hover:not(:disabled) { background: var(--hp-hover); }
    .hp-chip.on { border-color: var(--hp-ink); background: var(--hp-ink); color: var(--hp-bg); }

    .plg-tabs .nav-link { cursor: pointer; padding: .3rem .8rem; font-size: .85rem; }
    .plg-chip { border: 1px solid var(--promptops-border-color); background: transparent; color: inherit; border-radius: 999px;
      padding: .2rem .7rem; font-size: .8rem; display: inline-flex; align-items: center; gap: .3rem; }
    .plg-chip.on { background: var(--po-accent, #4f46e5); border-color: var(--po-accent, #4f46e5); color: var(--po-accent-on, #fff); }
    .plg-search { width: 200px; }
    .plg-avatar { width: 34px; height: 34px; border-radius: 8px; object-fit: cover; flex: none; }
    .plg-kind { font-size: .68rem; text-transform: uppercase; letter-spacing: .04em; opacity: .7; flex: none; }
    .plg-desc { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; min-height: 3.6em; }
    .plg-newpub { border: 1px dashed var(--promptops-border-color); border-radius: 8px; padding: .75rem; }
    .plg-empty { border: 1px dashed var(--promptops-border-color); border-radius: 12px; padding: 2.5rem 1rem; text-align: center;
      display: flex; flex-direction: column; align-items: center; gap: .35rem; }
    .min-w-0 { min-width: 0; }
    .plg-audit { font-size: .72rem; max-height: 220px; overflow: auto; white-space: pre-wrap; }
  `],
})
export class PluginsComponent implements OnInit, OnDestroy {
  readonly guide = inject(PluginsGuideService);
  private guideTimer: ReturnType<typeof setTimeout> | null = null;
  private api = inject(PluginRegistryService);
  private translate = inject(TranslateService);
  private swal = inject(SwalService);
  readonly runtime = inject(PluginRuntimeService);
  readonly builtin = inject(BuiltinPluginsService);
  readonly builtins = BUILTIN_PLUGINS;
  readonly promptopsPublisher = PROMPTOPS_PUBLISHER;
  /** Installed ones minus those that are the engine of a built-in section (a single entry for the person). */
  /** Built-in plugins are in the catalog too: all of them, filtered by section and search like the others. */
  readonly catalogBuiltins = computed(() => {
    const q = this.query().trim().toLowerCase();
    const cat = this.category();
    return this.builtins.filter((b) => (!cat || BUILTIN_SECTION[b.key] === cat)
      && (!q || this.builtinSearchText(b).includes(q)));
  });
  /** Plugins linked from a folder on this computer (developer mode). */
  readonly devPlugins = computed(() => this.runtime.installed().filter((p) => p.dev));
  /** English and UI-language text of a built-in card, lowercased, for the search box. */
  private builtinSearchText(b: { key: string; name: string; description: string; where: string }): string {
    const t = (f: string) => this.translate.instant(`BUILTIN_PLUGINS.${b.key}.${f}`);
    return `${b.name} ${b.description} ${b.where} ${t('Name')} ${t('Description')} ${t('Where')}`.toLowerCase();
  }
  readonly installedBuiltins = computed(() => this.builtins.filter((b) => this.builtin.isInstalled(b.key)));
  readonly visibleInstalled = computed(() => this.runtime.installed().filter((p) => !ABSORBED_BY_BUILTIN[p.pluginId]));
  private interactions = inject(InteractionService);

  /** Turning off Auto Approve doesn't just hide the commands: it stops it on every session where it was active. */
  setBuiltin(key: BuiltinKey, on: boolean): void {
    this.builtin.setOn(key, on);
    if (key === 'auto-approve' && !on) {
      for (const [id, f] of this.interactions.sessionFlags()) {
        if (f.quick || f.ai || f.modal) void this.interactions.setAutoApprove(id, false);
      }
    }
  }
  installBuiltin(key: BuiltinKey, installed: boolean): void {
    this.builtin.setInstalled(key, installed);
    this.setBuiltin(key, installed);
  }
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  readonly categories = PLUGIN_CATEGORIES;
  /** Where a plugin works, section by section: the "Open" button on the Installed tab leads there. */
  private static readonly OPEN_IN: Record<string, { label: string; link: string; hint: string }> = {
    // label and hint are PLUGINS_PAGE i18n keys.
    tasks: { label: 'Open Teams', link: '/admin/teams', hint: 'Open hint.tasks' },
    code: { label: 'Open Sessions', link: '/admin/sessions', hint: 'Open hint.code' },
    data: { label: 'Open Sessions', link: '/admin/sessions', hint: 'Open hint.data' },
    agent: { label: 'Open Sessions', link: '/admin/sessions', hint: 'Open hint.agent' },
    providers: { label: 'Open Usage', link: '/admin/usage', hint: 'Open hint.providers' },
    context: { label: 'Open Prompts', link: '/admin/prompt-library', hint: 'Open hint.context' },
    notify: { label: 'Open Notifications', link: '/admin/notifications', hint: 'Open hint.notify' },
  };

  /** A page of its own opens directly; for the other sections you go where the plugin appears. */
  openTarget(inst: InstalledPlugin): { label: string; link: string | unknown[]; hint: string } | null {
    const page = inst.pages?.[0];
    const t = (key: string, params?: object) => this.translate.instant('PLUGINS_PAGE.' + key, params);
    if (inst.category === 'pages') return page ? { label: t('Open'), link: ['/admin/plugin-page', inst.pluginId, page.id], hint: t('Open page', { title: page.title }) } : null;
    const target = PluginsComponent.OPEN_IN[inst.category];
    return target ? { ...target, label: t(target.label), hint: t(target.hint) } : null;
  }

  catalogOf(pluginId: string): RegistryPlugin | undefined {
    return this.catalog().find((p) => p.plugin_id === pluginId);
  }

  panelOpen(inst: InstalledPlugin): boolean {
    const id = inst.pluginId;
    return this.configuring()?.pluginId === id || this.testing()?.pluginId === id || this.activityOf()?.pluginId === id;
  }


  /** Feedback goes to the plugin's own repository, where its author and users can see it. */
  askFeedback(p: RegistryPlugin): void {
    openExternal(this.issuesUrl(p.repo_url));
  }

  /** New-issue page of a plugin repository on GitHub, or of PromptOps when unknown. */
  issuesUrl(repoUrl: string | null | undefined): string {
    const m = (repoUrl ?? "").match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/);
    return m ? `https://github.com/${m[1]}/${m[2].replace(/\.git$/, "")}/issues/new` : GITHUB_ISSUES_URL;
  }

  readonly providersShown = PROVIDERS_SHOWN;
  readonly providersOf = declaredProviders;
  providerNames = (list: PluginProvider[]): string => list.map((p) => p.label).join(', ');
  readonly describe = (p: string): string => describePermission(p, (key, params) => this.translate.instant(key, params));

  view = signal<'catalog' | 'installed' | 'mine'>('catalog');
  /** Grid (default) or list, one card per row. Chosen per device. */
  readonly layout = signal<'grid' | 'list'>(this.loadLayout());
  readonly isList = computed(() => this.layout() === 'list');
  category = signal<string>('');
  query = signal<string>('');
  verifiedOnly = signal(false);
  loading = signal(false);
  saving = signal(false);
  error = signal<string | null>(null);

  catalog = signal<RegistryPlugin[]>([]);
  registryMissing = signal(false);
  /** The catalog comes from the official index on GitHub: this server's registry does not exist yet. */

  // ── marketplace-style presentation ──
  readonly sorts = [{ id: 'name', label: 'Name' }, { id: 'updated', label: 'Recently updated' }, { id: 'verified', label: 'Verified first' }] as const;
  sort = signal<'name' | 'updated' | 'verified'>('name');
  private brokenAvatars = signal<string[]>([]);

  publisherCount = computed(() => new Set(this.catalog().map((p) => p.publisher.id)).size);
  /** The featured sections only make sense with a large enough catalog and no filters. */
  showHighlights = computed(() => this.catalog().length > 6 && !this.category() && !this.query().trim() && !this.verifiedOnly());
  verifiedPlugins = computed(() => this.catalog().filter((p) => p.publisher.verified).slice(0, 6));
  recentPlugins = computed(() => [...this.catalog()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 6));
  sortedCatalog = computed(() => {
    const list = [...this.catalog()];
    if (this.sort() === 'updated') return list.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    if (this.sort() === 'verified') return list.sort((a, b) => Number(b.publisher.verified) - Number(a.publisher.verified) || a.name.localeCompare(b.name));
    return list.sort((a, b) => a.name.localeCompare(b.name));
  });

  /** GitHub owner derived from the repository address; if missing, the fallback value. */
  ownerOf(repoUrl: string | null | undefined, fallback: string): string {
    return /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]*)\//.exec(String(repoUrl ?? '') + '/')?.[1] ?? fallback;
  }

  /** Publisher of an installed plugin: same criterion as the catalog, then repository owner or id prefix. */
  installedPublisher(inst: InstalledPlugin): { handle: string; avatar: string | null; verified: boolean; kind: 'user' | 'team' } {
    const cat = this.catalogOf(inst.pluginId);
    if (cat) {
      const pub = this.publisherOf(cat);
      return { ...pub, avatar: this.publisherAvatar(cat) };
    }
    const o = OFFICIAL_PUBLISHERS[inst.pluginId];
    if (o) return { ...o, avatar: o.handle === 'promptops' ? 'assets/logos/compact-logo-v3.png' : o.avatar };
    const handle = this.ownerOf(inst.repository, inst.pluginId.split('.')[0]);
    return { handle, avatar: this.avatarOf(inst.repository, null), verified: false, kind: 'user' };
  }

  /** Publisher avatar: compact logo for PromptOps, otherwise the publisher's or the GitHub owner's. */
  publisherAvatar(p: RegistryPlugin): string | null {
    const shown = this.publisherOf(p);
    if (shown.handle === 'promptops') return 'assets/logos/compact-logo-v3.png';
    return shown.avatar ?? this.avatarOf(p.repo_url, null);
  }

  /**
   * Who signs the official plugins in the card. The production registry has them all under `promptops`:
   * until the publishers change there, the three board ones belong to Shellonback, AI Git Writer to Luca.
   */
  publisherOf(p: RegistryPlugin): { handle: string; avatar: string | null; verified: boolean; kind: 'user' | 'team' } {
    const o = OFFICIAL_PUBLISHERS[p.plugin_id];
    if (o) return o;
    return { handle: p.publisher.handle, avatar: p.publisher.avatar_url ?? null, verified: !!p.publisher.verified, kind: p.publisher.kind };
  }

  /** Owner avatar on GitHub. If the image doesn't load we fall back to the initial. */
  avatarOf(repoUrl: string | null | undefined, fallback: string | null): string | null {
    const owner = this.ownerOf(repoUrl, '');
    const src = owner ? `https://github.com/${owner}.png?size=64` : fallback;
    return src && !this.brokenAvatars().includes(src) ? src : null;
  }

  avatarFailed(src: string): void {
    this.brokenAvatars.update((l) => [...l, src]);
  }

  ago(iso: string | null | undefined): string {
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t)) return '';
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days < 1) return this.translate.instant('PLUGINS_PAGE.Updated today');
    if (days < 30) return this.translate.instant('PLUGINS_PAGE.Updated days ago', { n: days });
    if (days < 365) return this.translate.instant('PLUGINS_PAGE.Updated months ago', { n: Math.floor(days / 30) });
    return this.translate.instant('PLUGINS_PAGE.Updated years ago', { n: Math.floor(days / 365) });
  }

  approving = signal<RegistryPlugin | null>(null);
  configuring = signal<InstalledPlugin | null>(null);
  activityOf = signal<InstalledPlugin | null>(null);
  activity = signal<AuditEntry[]>([]);
  testing = signal<InstalledPlugin | null>(null);
  test: { method: string; args: string; result: string | null } = { method: '', args: '[]', result: null };
  linkPath = '';


  ngOnInit(): void {
    this.loadCatalog();
    this.runtime.start().catch(() => undefined);
    // Back from the creation page: land on "My plugins".
    if (this.route.snapshot.queryParamMap.get('view') === 'mine') this.view.set('mine');
    // First visit: page tour (on the catalog, where all the shown zones are).
    else if (!this.guide.seen()) this.guideTimer = setTimeout(() => this.guide.maybeStart(), 700);
  }

  private readonly guideCreate = (() => {
    let last = this.guide.createPluginRequest();
    return effect(() => {
      const req = this.guide.createPluginRequest();
      if (req !== last) { last = req; this.startCreate(); }
    });
  })();

  startGuide(): void {
    this.view.set('catalog');
    this.guide.start();
  }

  ngOnDestroy(): void {
    if (this.guideTimer) clearTimeout(this.guideTimer);
    this.guide.close();
  }

  /** Present in the runtime in ANY way: installed from the catalog or linked from a folder. */
  installedAny(pluginId: string): InstalledPlugin | undefined {
    return this.runtime.installed().find((i) => i.pluginId === pluginId);
  }

  /** Uninstalls from the catalog card. For a local link it removes the link, not the folder. */
  uninstallFromCatalog(inst: InstalledPlugin): void {
    this.confirmUninstall(inst, () => void this.doUninstallFromCatalog(inst));
  }

  /**
   * window.confirm() returns false at once in the macOS webview (no JS dialog
   * delegate), so uninstall silently did nothing: use the app's confirmation,
   * which calls back only on confirm.
   */
  private confirmUninstall(inst: InstalledPlugin, onConfirm: () => void): void {
    const params = { name: inst.name };
    this.swal.confirmDanger(
      this.translate.instant(inst.dev ? 'PLUGINS_PAGE.Unlink title' : 'PLUGINS_PAGE.Uninstall'),
      this.translate.instant(inst.dev ? 'PLUGINS_PAGE.Confirm unlink' : 'PLUGINS_PAGE.Confirm uninstall', params),
      onConfirm,
    );
  }

  private async doUninstallFromCatalog(inst: InstalledPlugin): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.runtime.uninstall(inst.pluginId);
    } catch (e: any) {
      this.error.set(typeof e === 'string' ? e : e?.message || this.translate.instant('PLUGINS_PAGE.Could not uninstall'));
    } finally {
      this.saving.set(false);
    }
  }

  /** Section where installation was requested: the same plugin can appear in several sections. */
  private approvingZone = 'all';

  startInstall(p: RegistryPlugin, zone = 'all'): void {
    this.error.set(null);
    this.approvingZone = zone;
    this.approving.set(p);
  }

  isApproving(p: RegistryPlugin, zone = 'all'): boolean {
    return this.approving()?.id === p.id && this.approvingZone === zone;
  }

  /** The user read and approved the permissions: Rust downloads, verifies hash and manifest, then it activates. */
  async install(p: RegistryPlugin): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.runtime.install(p);
      await this.runtime.setEnabled(p.plugin_id, true);
      this.approving.set(null);
      // Only installs from the catalog count; local links don't.
    } catch (e: any) {
      this.error.set(typeof e === 'string' ? e : e?.message || this.translate.instant('PLUGINS_PAGE.Install failed'));
    } finally {
      this.saving.set(false);
    }
  }

  readonly checkingUpdates = signal(false);
  readonly updateNote = signal<string | null>(null);

  updateOf(pluginId: string): { installed: string; available: string } | undefined {
    return this.runtime.updates().find((u) => u.pluginId === pluginId);
  }

  async checkUpdates(): Promise<void> {
    this.checkingUpdates.set(true);
    this.error.set(null);
    this.updateNote.set(null);
    try {
      await this.runtime.syncWithRegistry();
      const n = this.runtime.updates().length;
      this.updateNote.set(n ? this.translate.instant('PLUGINS_PAGE.Updates available', { count: n }) : this.translate.instant('PLUGINS_PAGE.Up to date'));
    } catch (e: any) {
      this.error.set(typeof e === 'string' ? e : e?.message || this.translate.instant('PLUGINS_PAGE.Check failed'));
    } finally {
      this.checkingUpdates.set(false);
    }
  }

  /** Updates in place. If the new version asks for extra permissions we switch to the Catalog, where the user reads and approves them. */
  async updateInstalled(inst: InstalledPlugin): Promise<void> {
    this.error.set(null);
    try {
      const res = await this.runtime.update(inst.pluginId);
      if (res === 'needs-approval') {
        const p = (await this.api.catalog(inst.category)).find((c) => c.plugin_id === inst.pluginId);
        if (!p) throw new Error(this.translate.instant('PLUGINS_PAGE.Not in catalog'));
        this.view.set('catalog');
        this.startInstall(p);
        this.updateNote.set(null);
        return;
      }
      this.updateNote.set(res === 'updated' ? this.translate.instant('PLUGINS_PAGE.Plugin updated', { name: inst.name }) : this.translate.instant('PLUGINS_PAGE.Up to date'));
    } catch (e: any) {
      this.error.set(typeof e === 'string' ? e : e?.message || this.translate.instant('PLUGINS_PAGE.Update failed'));
    }
  }

  private async guarded(fn: () => Promise<void>): Promise<void> {
    this.error.set(null);
    try {
      await fn();
    } catch (e: any) {
      this.error.set(typeof e === 'string' ? e : e?.message || this.translate.instant('PLUGINS_PAGE.Operation failed'));
    }
  }

  toggle(inst: InstalledPlugin): Promise<void> {
    return this.guarded(() => this.runtime.setEnabled(inst.pluginId, !inst.enabled));
  }

  uninstall(inst: InstalledPlugin): void {
    this.confirmUninstall(inst, () => void this.guarded(async () => {
      await this.runtime.uninstall(inst.pluginId);
    }));
  }

  openConfig(inst: InstalledPlugin): void {
    this.configuring.set(this.configuring()?.pluginId === inst.pluginId ? null : inst);
  }

  openActivity(inst: InstalledPlugin): Promise<void> {
    return this.guarded(async () => {
      this.activity.set((await this.runtime.audit(inst.pluginId, 150)).reverse());
      this.activityOf.set(inst);
    });
  }

  /** Methods the plugin registered for its OWN section. */
  testMethods(): string[] {
    const inst = this.testing();
    if (!inst) return [];
    return this.runtime.contributions()[inst.pluginId]?.contributions.find((c) => c.kind === inst.category)?.methods ?? [];
  }

  openTester(inst: InstalledPlugin): Promise<void> {
    return this.guarded(async () => {
      await this.runtime.refresh();
      this.testing.set(inst);
      this.test = { method: this.testMethods()[0] ?? '', args: '[]', result: null };
    });
  }

  async runTest(inst: InstalledPlugin): Promise<void> {
    let args: unknown;
    try {
      args = JSON.parse(this.test.args || '[]');
    } catch {
      args = null;
    }
    if (!Array.isArray(args)) {
      this.test.result = 'Arguments must be a JSON array, for example [] or ["abc"].';
      return;
    }
    this.saving.set(true);
    try {
      const out = await this.runtime.invokeContract(inst.pluginId, inst.category, this.test.method, args);
      // Shown as text: what comes back from a plugin is never interpreted as HTML.
      this.test.result = JSON.stringify(out, null, 2).slice(0, 20000);
    } catch (e: any) {
      this.test.result = 'Error: ' + (typeof e === 'string' ? e : e?.message || 'failed');
    } finally {
      this.saving.set(false);
    }
  }

  toggleDeveloperMode(): Promise<void> {
    return this.guarded(() => this.runtime.setDeveloperMode(!this.runtime.developerMode()));
  }

  linkLocal(): Promise<void> {
    return this.guarded(async () => {
      await this.runtime.linkLocal(this.linkPath.trim());
      this.linkPath = '';
    });
  }

  categoryLabel(id: string): string {
    const key = `PLUGINS_PAGE.Category.${id}`;
    const label = this.translate.instant(key);
    return label === key ? id : label;
  }

  setLayout(layout: 'grid' | 'list'): void {
    this.layout.set(layout);
    try { localStorage.setItem(PLUGINS_LAYOUT_KEY, layout); } catch { /* stays in memory */ }
  }

  private loadLayout(): 'grid' | 'list' {
    try { return localStorage.getItem(PLUGINS_LAYOUT_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
  }

  pickCategory(id: string): void {
    this.category.set(id);
    this.loadCatalog();
  }

  async loadCatalog(): Promise<void> {
    this.loading.set(true);
    try {
      this.catalog.set((await this.api.catalog(this.category(), this.query().trim(), this.verifiedOnly())).filter((p) => !ABSORBED_BY_BUILTIN[p.plugin_id]));
      this.registryMissing.set(false);
    } catch (e: any) {
      this.catalog.set([]);
      // 404 = this server doesn't have the registry yet: say so, instead of "no plugins".
      // Neither the registry nor the official index is reachable.
      this.registryMissing.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  openMine(): void {
    this.view.set('mine');
  }

  /** Where plugins are shared: a pull request to the public registry. */
  readonly registryRepoUrl = TEMPLATES_REPO;

  /** Creation has its own page. Start from the section filtered in the catalog, if any. */
  startCreate(): void {
    this.router.navigate(['/admin/plugins/create'], { queryParams: this.category() ? { section: this.category() } : {} });
  }

}
