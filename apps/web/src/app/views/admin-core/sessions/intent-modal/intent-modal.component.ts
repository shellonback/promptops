import {
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  HostListener,
  inject,
  signal,
  OnInit,
  ChangeDetectionStrategy
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { IntentService, IntentPlan, IntentAgent, EnhanceDepth } from '../services/intent.service';
import { SubAgentProvider } from '../services/sub-agent.service';

const DEPTH_OPTIONS: { value: EnhanceDepth; labelKey: string; hintKey: string; icon: string }[] = [
  { value: 'short', labelKey: 'SESSIONS.INTENT.Depth short', hintKey: 'SESSIONS.INTENT.Depth short hint', icon: 'solar:minimalistic-magnifer-bold-duotone' },
  { value: 'medium', labelKey: 'SESSIONS.INTENT.Depth medium', hintKey: 'SESSIONS.INTENT.Depth medium hint', icon: 'solar:magnifer-bold-duotone' },
  { value: 'strong', labelKey: 'SESSIONS.INTENT.Depth strong', hintKey: 'SESSIONS.INTENT.Depth strong hint', icon: 'solar:magnifer-zoom-in-bold-duotone' },
];

const PROVIDERS: { value: SubAgentProvider; label: string; icon: string }[] = [
  { value: 'claude-code-cli', label: 'Claude Code', icon: 'solar:magic-stick-3-bold-duotone' },
  { value: 'codex', label: 'Codex', icon: 'solar:code-square-bold-duotone' },
  { value: 'gemini-cli', label: 'Gemini CLI', icon: 'solar:star-bold-duotone' },
  { value: 'antigravity', label: 'Antigravity', icon: 'solar:rocket-bold-duotone' },
  { value: 'copilot', label: 'Copilot', icon: 'solar:ghost-bold-duotone' },
  { value: 'cursor', label: 'Cursor', icon: 'solar:cursor-bold-duotone' },
  { value: 'grok', label: 'Grok', icon: 'solar:black-hole-bold-duotone' },
  { value: 'hermes', label: 'Hermes', icon: 'solar:plain-bold-duotone' },
  { value: 'muse', label: 'Muse Code', icon: 'simple-icons:meta' },
  { value: 'zai', label: 'Z.AI', icon: 'solar:planet-bold-duotone' },
  { value: 'kimi', label: 'Kimi', icon: 'solar:moon-bold-duotone' },
  { value: 'opencode', label: 'Opencode', icon: 'solar:bolt-bold-duotone' },
  { value: 'kora', label: 'Kora', icon: 'solar:atom-bold-duotone' },
];

const ROLE_COLORS: Record<string, string> = {
  backend: '#3fb950',
  frontend: '#bc8cff',
  refactor: '#f0883e',
  debug: '#f85149',
  test: '#39c5cf',
  docs: '#8b949e',
  devops: '#4285f4',
};

const ROLE_ICONS: Record<string, string> = {
  backend: 'solar:server-bold-duotone',
  frontend: 'solar:monitor-bold-duotone',
  refactor: 'solar:refresh-bold-duotone',
  debug: 'solar:bug-bold-duotone',
  test: 'solar:test-tube-bold-duotone',
  docs: 'solar:document-text-bold-duotone',
  devops: 'solar:settings-bold-duotone',
};

const ROLE_LEGEND: { role: string; labelKey: string }[] = [
  { role: 'backend',  labelKey: 'SESSIONS.INTENT.Role backend' },
  { role: 'frontend', labelKey: 'SESSIONS.INTENT.Role frontend' },
  { role: 'refactor', labelKey: 'SESSIONS.INTENT.Role refactor' },
  { role: 'debug',    labelKey: 'SESSIONS.INTENT.Role debug' },
  { role: 'test',     labelKey: 'SESSIONS.INTENT.Role test' },
  { role: 'docs',     labelKey: 'SESSIONS.INTENT.Role docs' },
  { role: 'devops',   labelKey: 'SESSIONS.INTENT.Role devops' },
];

/** Static example intents shown under the textarea to seed first-time usage. */
const EXAMPLE_INTENTS: { i18nKey: string }[] = [
  { i18nKey: 'SESSIONS.INTENT.Example login' },
  { i18nKey: 'SESSIONS.INTENT.Example refactor api' },
  { i18nKey: 'SESSIONS.INTENT.Example add tests' },
];

@Component({
  selector: 'app-intent-modal',
  standalone: true,
  imports: [FormsModule, TranslateModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <div class="modal-header">
      <div class="modal-title-block">
        <h5 class="modal-title">
          <iconify-icon icon="fluent:people-team-24-filled" width="20"></iconify-icon>
          {{ 'SESSIONS.INTENT.Title' | translate }}
          <span class="intent-new-badge">{{ 'SESSIONS.New' | translate }}</span>
        </h5>
        @if (intentService.phase() === 'input' || intentService.phase() === 'review') {
          <p class="modal-tagline">{{ 'SESSIONS.INTENT.Tagline' | translate }}</p>
        }
      </div>
      @if (intentService.phase() === 'executing') {
        <span class="intent-minimize-hint" [title]="'SESSIONS.INTENT.Background hint' | translate">
          <iconify-icon icon="solar:minimize-square-bold-duotone" width="14"></iconify-icon>
          {{ 'SESSIONS.INTENT.Minimize' | translate }}
        </span>
      }
      <button type="button" class="btn-close" (click)="minimize()" [title]="'SESSIONS.INTENT.Close keep background' | translate"
        [attr.aria-label]="'SESSIONS.INTENT.Close keep background' | translate"></button>
    </div>

    <div class="modal-body">
      @switch (intentService.phase()) {

        @case ('input') {
          <div class="intent-input-phase">
            <!-- How-it-works expandable explainer -->
            <button type="button" class="hiw-toggle" (click)="toggleHowItWorks()" [attr.aria-expanded]="showHowItWorks()">
              <iconify-icon [icon]="showHowItWorks() ? 'solar:alt-arrow-up-bold' : 'solar:alt-arrow-down-bold'" width="12"></iconify-icon>
              <iconify-icon icon="solar:info-circle-bold-duotone" width="13"></iconify-icon>
              <span>{{ 'SESSIONS.INTENT.How it works' | translate }}</span>
            </button>
            @if (showHowItWorks()) {
              <div class="hiw-panel">
                <div class="hiw-step">
                  <span class="hiw-wave">1</span>
                  <div class="hiw-text">
                    <strong>{{ 'SESSIONS.INTENT.HIW Wave1 title' | translate }}</strong>
                    <span>{{ 'SESSIONS.INTENT.HIW Wave1 body' | translate }}</span>
                  </div>
                </div>
                <div class="hiw-step">
                  <span class="hiw-wave">2</span>
                  <div class="hiw-text">
                    <strong>{{ 'SESSIONS.INTENT.HIW Wave2 title' | translate }}</strong>
                    <span>{{ 'SESSIONS.INTENT.HIW Wave2 body' | translate }}</span>
                  </div>
                </div>
                <div class="hiw-step">
                  <span class="hiw-wave">3</span>
                  <div class="hiw-text">
                    <strong>{{ 'SESSIONS.INTENT.HIW Wave3 title' | translate }}</strong>
                    <span>{{ 'SESSIONS.INTENT.HIW Wave3 body' | translate }}</span>
                  </div>
                </div>
              </div>
            }

            <label class="field-label" for="intent-textarea">{{ 'SESSIONS.INTENT.Goal label' | translate }}</label>
            <div class="textarea-wrapper">
              <textarea
                id="intent-textarea"
                ngbAutofocus
                class="intent-textarea"
                [class.enhancing]="enhancing()"
                [ngModel]="intentText"
                (ngModelChange)="onIntentTextChange($event)"
                [placeholder]="'SESSIONS.INTENT.Goal placeholder' | translate"
                rows="5"
                [disabled]="enhancing()"
                (keydown.meta.Enter)="generate()"
                (keydown.control.Enter)="generate()"
              ></textarea>
              <div class="enhance-wrapper">
                @if (showDepthPicker() && !enhancing()) {
                  <div class="depth-popover" (click)="$event.stopPropagation()">
                    <div class="depth-title">{{ 'SESSIONS.INTENT.Depth title' | translate }}</div>
                    <div class="depth-options">
                      @for (opt of depthOptions; track opt.value) {
                        <button
                          class="depth-option"
                          type="button"
                          (click)="runEnhance(opt.value)"
                          [title]="opt.hintKey | translate"
                        >
                          <iconify-icon [icon]="opt.icon" width="16"></iconify-icon>
                          <span class="depth-label">{{ opt.labelKey | translate }}</span>
                          <span class="depth-hint">{{ opt.hintKey | translate }}</span>
                        </button>
                      }
                    </div>
                  </div>
                }
                <button
                  class="btn-enhance"
                  [class.active]="showDepthPicker()"
                  [disabled]="!intentText.trim() || enhancing()"
                  (click)="onEnhanceClick($event)"
                  [title]="'SESSIONS.INTENT.Enhance tooltip' | translate"
                >
                  @if (enhancing()) {
                    <div class="btn-spinner"></div>
                  } @else {
                    <iconify-icon icon="solar:magic-stick-3-bold-duotone" width="14"></iconify-icon>
                  }
                  {{ enhancing() ? ('SESSIONS.INTENT.Enhancing' | translate) : ('SESSIONS.INTENT.Enhance' | translate) }}
                </button>
              </div>
            </div>

            <!-- Click-to-fill example intents -->
            @if (!intentText.trim()) {
              <div class="example-row">
                <span class="example-row-label">
                  <iconify-icon icon="solar:lightbulb-bold-duotone" width="12"></iconify-icon>
                  {{ 'SESSIONS.INTENT.Examples label' | translate }}
                </span>
                @for (ex of exampleIntents; track ex.i18nKey) {
                  <button type="button" class="example-chip" (click)="useExample(ex.i18nKey)">
                    {{ ex.i18nKey | translate }}
                  </button>
                }
              </div>
            }

            <div class="intent-options">
              <div class="option-row">
                <div class="option-text">
                  <label class="option-label" for="intent-provider-select">{{ 'SESSIONS.INTENT.Provider label' | translate }}</label>
                  <span class="option-hint">{{ 'SESSIONS.INTENT.Provider hint' | translate }}</span>
                </div>
                <select id="intent-provider-select" class="provider-select" [ngModel]="selectedProvider" (ngModelChange)="onProviderChange($event)">
                  @for (p of providers; track p.value) {
                    <option [value]="p.value">{{ p.label }}</option>
                  }
                </select>
              </div>

              <div class="option-row">
                <div class="option-text">
                  <span class="option-label" id="intent-auto-approve-label">{{ 'SESSIONS.INTENT.Auto approve label' | translate }}</span>
                  <span class="option-hint">{{ 'SESSIONS.INTENT.Auto approve hint' | translate }}</span>
                </div>
                <div class="toggle-switch" [class.active]="autoApprove()" (click)="toggleAutoApprove()"
                  role="switch" tabindex="0" aria-labelledby="intent-auto-approve-label" [attr.aria-checked]="autoApprove()"
                  (keydown.enter)="$event.preventDefault(); toggleAutoApprove()"
                  (keydown.space)="$event.preventDefault(); toggleAutoApprove()">
                  <div class="toggle-thumb"></div>
                </div>
              </div>
            </div>

            <button
              type="button"
              class="btn-generate"
              [disabled]="!intentText.trim()"
              (click)="generate()"
            >
              <iconify-icon icon="solar:atom-bold-duotone" width="16"></iconify-icon>
              {{ 'SESSIONS.INTENT.Generate plan' | translate }}
            </button>
          </div>
        }

        @case ('generating') {
          <div class="intent-loading">
            <div class="loading-spinner"></div>
            <p class="loading-text">{{ 'SESSIONS.INTENT.Generating' | translate }}</p>
          </div>
        }

        @case ('review') {
          @if (intentService.currentPlan(); as plan) {
            <div class="intent-review-phase">
              <!-- Single compact header line -->
              <div class="plan-header-compact">
                <iconify-icon icon="solar:document-text-bold-duotone" width="13"></iconify-icon>
                <span class="plan-header-summary">{{ plan.summary }}</span>
                <span class="plan-header-meta">
                  {{ 'SESSIONS.INTENT.Plan meta' | translate: { agents: plan.agents.length, waves: waveGroups(plan).length } }}
                </span>
                <button type="button" class="role-legend-toggle" (click)="toggleRoleLegend()" [attr.aria-expanded]="showRoleLegend()" [title]="'SESSIONS.INTENT.Roles legend' | translate">
                  <iconify-icon icon="solar:question-circle-bold-duotone" width="13"></iconify-icon>
                  <span>{{ 'SESSIONS.INTENT.Roles' | translate }}</span>
                </button>
              </div>

              @if (showRoleLegend()) {
                <div class="role-legend">
                  @for (r of roleLegend; track r.role) {
                    <span class="role-legend-item">
                      <span class="agent-icon" [style.background]="getRoleColor(r.role) + '18'" [style.color]="getRoleColor(r.role)">
                        <iconify-icon [icon]="getRoleIcon(r.role)" width="11"></iconify-icon>
                      </span>
                      <span class="role-legend-name" [style.color]="getRoleColor(r.role)">{{ r.role }}</span>
                      <span class="role-legend-desc">{{ r.labelKey | translate }}</span>
                    </span>
                  }
                </div>
              }

              <!-- Pipeline view — horizontal waves, vertical parallel -->
              <div class="plan-pipeline">
                @for (wave of waveGroups(plan); track wave.wave; let lastWave = $last) {
                  <div class="wave-column" [attr.data-status]="waveStatus(wave.wave)">
                    <div class="wave-header">
                      <div class="wave-header-main">
                        <span class="wave-label">{{ 'SESSIONS.INTENT.Wave label' | translate: { wave: wave.wave } }}</span>
                        <span class="wave-mode">
                          {{ wave.agents.length > 1
                            ? ('SESSIONS.INTENT.Wave parallel' | translate: { count: wave.agents.length })
                            : ('SESSIONS.INTENT.Wave single' | translate) }}
                        </span>
                      </div>
                      @if (waveStatus(wave.wave) === 'running') {
                        <span class="wave-status running">
                          <div class="wave-spinner"></div> {{ 'SESSIONS.INTENT.Wave running' | translate }}
                        </span>
                      } @else if (waveStatus(wave.wave) === 'done') {
                        <span class="wave-status done">
                          <iconify-icon icon="solar:check-circle-bold" width="12"></iconify-icon> {{ 'SESSIONS.INTENT.Wave done' | translate }}
                        </span>
                      } @else if (waveStatus(wave.wave) === 'waiting') {
                        <span class="wave-status waiting">
                          <iconify-icon icon="solar:hourglass-bold-duotone" width="12"></iconify-icon> {{ 'SESSIONS.INTENT.Waiting' | translate }}
                        </span>
                      }
                    </div>

                    <div class="wave-agents">
                      @for (agent of wave.agents; track agent.name) {
                        @let i = agentIndex(plan, agent);
                        <div class="agent-card compact" [class.expanded]="expandedAgent() === i">
                          <div class="agent-card-header" (click)="toggleExpand(i)" role="button" tabindex="0"
                            [attr.aria-expanded]="expandedAgent() === i"
                            (keydown.enter)="$event.target === $event.currentTarget && toggleExpand(i)"
                            (keydown.space)="$event.target === $event.currentTarget && ($event.preventDefault() || toggleExpand(i))">
                            <div class="agent-icon" [style.background]="getRoleColor(agent.role) + '18'" [style.color]="getRoleColor(agent.role)">
                              <iconify-icon [icon]="getRoleIcon(agent.role)" width="12"></iconify-icon>
                            </div>
                            <span class="agent-name" [title]="agent.name + ' — ' + agent.goal">{{ agent.name }}</span>
                            <span class="agent-role-badge" [style.background]="getRoleColor(agent.role) + '20'" [style.color]="getRoleColor(agent.role)">
                              {{ agent.role }}
                            </span>
                            <iconify-icon class="card-chevron" [icon]="expandedAgent() === i ? 'solar:alt-arrow-up-bold' : 'solar:alt-arrow-down-bold'" width="11"></iconify-icon>
                            @if (plan.agents.length > 1 && intentService.phase() === 'review') {
                              <button type="button" class="agent-remove-btn" (click)="removeAgent(i); $event.stopPropagation()"
                                [title]="'SESSIONS.INTENT.Remove agent' | translate" [attr.aria-label]="'SESSIONS.INTENT.Remove agent' | translate">
                                <iconify-icon icon="solar:close-circle-bold" width="12"></iconify-icon>
                              </button>
                            }
                          </div>

                          @if (expandedAgent() === i) {
                            <p class="agent-goal">{{ agent.goal }}</p>

                            @if (agent.tasks?.length) {
                              <div class="agent-detail-section">
                                <span class="detail-label">
                                  <iconify-icon icon="solar:checklist-minimalistic-bold" width="11"></iconify-icon>
                                  {{ 'SESSIONS.INTENT.Tasks' | translate }}
                                </span>
                                <ul class="task-list">
                                  @for (t of agent.tasks; track t) {
                                    <li>{{ t }}</li>
                                  }
                                </ul>
                              </div>
                            }

                            @if (agent.scope?.length) {
                              <div class="agent-detail-section">
                                <span class="detail-label">
                                  <iconify-icon icon="solar:folder-open-bold" width="11"></iconify-icon>
                                  {{ 'SESSIONS.INTENT.Scope' | translate }}
                                </span>
                                <div class="detail-tags">
                                  @for (s of agent.scope; track s) {
                                    <span class="scope-tag">{{ s }}</span>
                                  }
                                </div>
                              </div>
                            }

                            @if (agent.boundaries?.length) {
                              <div class="agent-detail-section boundaries-section">
                                <span class="detail-label detail-label-warn">
                                  <iconify-icon icon="solar:shield-warning-bold" width="11"></iconify-icon>
                                  {{ 'SESSIONS.INTENT.Boundaries' | translate }}
                                </span>
                                <ul class="boundary-list">
                                  @for (b of agent.boundaries; track b) {
                                    <li>{{ b }}</li>
                                  }
                                </ul>
                              </div>
                            }

                            <div class="agent-prompt-preview">
                              <pre class="prompt-code">{{ getPromptPreview(plan, i) }}</pre>
                            </div>
                          }
                        </div>
                      }
                    </div>
                  </div>

                  @if (!lastWave) {
                    <div class="wave-arrow" aria-hidden="true">
                      <iconify-icon icon="solar:arrow-right-bold" width="18"></iconify-icon>
                    </div>
                  }
                }
              </div>

              <div class="review-actions">
                <button class="btn-cancel" (click)="cancel()">{{ 'SESSIONS.INTENT.Cancel' | translate }}</button>
                <button class="btn-execute" (click)="execute()">
                  <iconify-icon icon="solar:play-bold" width="14"></iconify-icon>
                  {{ 'SESSIONS.INTENT.Execute' | translate: { count: plan.agents.length } }}
                </button>
              </div>
            </div>
          }
        }

        @case ('executing') {
          @if (intentService.currentPlan(); as plan) {
            <div class="intent-review-phase">
              <div class="plan-header-compact">
                <div class="wave-spinner"></div>
                <span class="plan-header-summary">
                  {{ 'SESSIONS.INTENT.Executing wave' | translate: { current: intentService.currentWave() ?? 1, total: waveGroups(plan).length } }}
                  @if (intentService.waitingAgents().length) {
                    · {{ 'SESSIONS.INTENT.Waiting' | translate }}: {{ intentService.waitingAgents().join(', ') }}
                  }
                </span>
              </div>

              <div class="plan-pipeline">
                @for (wave of waveGroups(plan); track wave.wave; let lastWave = $last) {
                  <div class="wave-column" [attr.data-status]="waveStatus(wave.wave)">
                    <div class="wave-header">
                      <div class="wave-header-main">
                        <span class="wave-label">{{ 'SESSIONS.INTENT.Wave label' | translate: { wave: wave.wave } }}</span>
                        <span class="wave-mode">
                          {{ wave.agents.length > 1
                            ? ('SESSIONS.INTENT.Wave parallel' | translate: { count: wave.agents.length })
                            : ('SESSIONS.INTENT.Wave single' | translate) }}
                        </span>
                      </div>
                      @if (waveStatus(wave.wave) === 'running') {
                        <span class="wave-status running">
                          <div class="wave-spinner"></div> {{ 'SESSIONS.INTENT.Wave running' | translate }}
                        </span>
                      } @else if (waveStatus(wave.wave) === 'done') {
                        <span class="wave-status done">
                          <iconify-icon icon="solar:check-circle-bold" width="12"></iconify-icon> {{ 'SESSIONS.INTENT.Wave done' | translate }}
                        </span>
                      } @else if (waveStatus(wave.wave) === 'waiting') {
                        <span class="wave-status waiting">
                          <iconify-icon icon="solar:hourglass-bold-duotone" width="12"></iconify-icon> {{ 'SESSIONS.INTENT.Waiting' | translate }}
                        </span>
                      }
                    </div>

                    <div class="wave-agents">
                      @for (agent of wave.agents; track agent.name) {
                        <div class="agent-card compact">
                          <div class="agent-card-header">
                            <div class="agent-icon" [style.background]="getRoleColor(agent.role) + '18'" [style.color]="getRoleColor(agent.role)">
                              <iconify-icon [icon]="getRoleIcon(agent.role)" width="12"></iconify-icon>
                            </div>
                            <span class="agent-name" [title]="agent.name + ' — ' + agent.goal">{{ agent.name }}</span>
                            <span class="agent-role-badge" [style.background]="getRoleColor(agent.role) + '20'" [style.color]="getRoleColor(agent.role)">
                              {{ agent.role }}
                            </span>
                          </div>
                        </div>
                      }
                    </div>
                  </div>

                  @if (!lastWave) {
                    <div class="wave-arrow" aria-hidden="true">
                      <iconify-icon icon="solar:arrow-right-bold" width="18"></iconify-icon>
                    </div>
                  }
                }
              </div>

              <div class="review-actions">
                <span class="exec-bg-hint">
                  <iconify-icon icon="solar:info-circle-bold-duotone" width="13"></iconify-icon>
                  {{ 'SESSIONS.INTENT.Background running' | translate }}
                </span>
                <button class="btn-cancel btn-stop" (click)="stopExecution()" [title]="'SESSIONS.INTENT.Stop tooltip' | translate">
                  <iconify-icon icon="solar:stop-circle-bold-duotone" width="14"></iconify-icon>
                  {{ 'SESSIONS.INTENT.Stop' | translate }}
                </button>
                <button class="btn-cancel btn-stop-delete" (click)="stopAndDelete()" [title]="'SESSIONS.INTENT.Stop delete tooltip' | translate">
                  <iconify-icon icon="solar:trash-bin-trash-bold-duotone" width="14"></iconify-icon>
                  {{ 'SESSIONS.INTENT.Stop and delete' | translate }}
                </button>
                <button class="btn-execute" (click)="minimize()">
                  <iconify-icon icon="solar:minimize-square-bold-duotone" width="14"></iconify-icon>
                  {{ 'SESSIONS.INTENT.Minimize' | translate }}
                </button>
              </div>
            </div>
          } @else {
            <div class="intent-loading">
              <div class="loading-spinner"></div>
              <p class="loading-text">{{ 'SESSIONS.INTENT.Spawning' | translate }}</p>
            </div>
          }
        }

        @case ('stopped') {
          @if (intentService.currentPlan(); as plan) {
            <div class="intent-review-phase">
              <div class="plan-header-compact stopped">
                <iconify-icon icon="solar:stop-circle-bold-duotone" width="13"></iconify-icon>
                <span class="plan-header-summary">{{ 'SESSIONS.INTENT.Execution stopped' | translate }} — {{ plan.summary }}</span>
                <span class="plan-header-meta">
                  {{ 'SESSIONS.INTENT.Plan meta' | translate: { agents: plan.agents.length, waves: waveGroups(plan).length } }}
                </span>
              </div>

              <div class="plan-pipeline">
                @for (wave of waveGroups(plan); track wave.wave; let lastWave = $last) {
                  <div class="wave-column" [attr.data-status]="waveStatus(wave.wave)">
                    <div class="wave-header">
                      <div class="wave-header-main">
                        <span class="wave-label">{{ 'SESSIONS.INTENT.Wave label' | translate: { wave: wave.wave } }}</span>
                        <span class="wave-mode">
                          {{ wave.agents.length > 1
                            ? ('SESSIONS.INTENT.Wave parallel' | translate: { count: wave.agents.length })
                            : ('SESSIONS.INTENT.Wave single' | translate) }}
                        </span>
                      </div>
                    </div>
                    <div class="wave-agents">
                      @for (agent of wave.agents; track agent.name) {
                        <div class="agent-card compact">
                          <div class="agent-card-header">
                            <div class="agent-icon" [style.background]="getRoleColor(agent.role) + '18'" [style.color]="getRoleColor(agent.role)">
                              <iconify-icon [icon]="getRoleIcon(agent.role)" width="12"></iconify-icon>
                            </div>
                            <span class="agent-name" [title]="agent.name + ' — ' + agent.goal">{{ agent.name }}</span>
                            <span class="agent-role-badge" [style.background]="getRoleColor(agent.role) + '20'" [style.color]="getRoleColor(agent.role)">
                              {{ agent.role }}
                            </span>
                          </div>
                        </div>
                      }
                    </div>
                  </div>
                  @if (!lastWave) {
                    <div class="wave-arrow" aria-hidden="true">
                      <iconify-icon icon="solar:arrow-right-bold" width="18"></iconify-icon>
                    </div>
                  }
                }
              </div>

              <div class="review-actions">
                <span class="exec-bg-hint">
                  <iconify-icon icon="solar:info-circle-bold-duotone" width="13"></iconify-icon>
                  {{ 'SESSIONS.INTENT.Stopped hint' | translate }}
                </span>
                <button class="btn-cancel" (click)="minimize()">{{ 'SESSIONS.INTENT.Minimize' | translate }}</button>
                <button class="btn-execute btn-delete" (click)="deleteIntent()">
                  <iconify-icon icon="solar:trash-bin-trash-bold" width="14"></iconify-icon>
                  {{ 'SESSIONS.INTENT.Delete' | translate }}
                </button>
              </div>
            </div>
          }
        }

        @case ('done') {
          <div class="intent-done">
            <iconify-icon icon="solar:check-circle-bold" width="40" style="color: var(--po-success)"></iconify-icon>
            <p class="done-text">{{ 'SESSIONS.INTENT.Done title' | translate }}</p>
            <p class="done-sub">{{ 'SESSIONS.INTENT.Done sub' | translate }}</p>
            <div class="review-actions">
              <button class="btn-cancel" (click)="startNewIntent()">
                <iconify-icon icon="solar:add-circle-bold-duotone" width="14"></iconify-icon>
                {{ 'SESSIONS.INTENT.New squad' | translate }}
              </button>
              <button class="btn-execute" (click)="closeDone()">{{ 'SESSIONS.INTENT.Close' | translate }}</button>
            </div>
          </div>
        }

        @case ('error') {
          <div class="intent-done">
            <iconify-icon icon="solar:danger-triangle-bold" width="40" style="color: var(--po-error)"></iconify-icon>
            <p class="done-text">{{ 'SESSIONS.INTENT.Error title' | translate }}</p>
            <p class="done-sub">{{ intentService.error() }}</p>
            <div class="review-actions">
              <button class="btn-cancel" (click)="cancel()">{{ 'SESSIONS.INTENT.Back' | translate }}</button>
              <button class="btn-execute" (click)="execute()">{{ 'SESSIONS.INTENT.Retry' | translate }}</button>
            </div>
          </div>
        }
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .modal-header {
      border-bottom: 1px solid var(--po-border-subtle);
      padding: 0.75rem 1rem;
    }
    .modal-title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 1rem;
      font-weight: 600;
      margin: 0;
    }
    .intent-new-badge {
      font-size: 0.55rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--po-success-bg);
      color: var(--po-success);
      line-height: 1;
      text-transform: uppercase;
    }
    .modal-body {
      padding: 0.75rem 1rem;
      min-height: 160px;
    }

    /* ── Modal title block: title + tagline ── */
    .modal-title-block {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      flex: 1;
      min-width: 0;
    }
    .modal-tagline {
      margin: 0;
      font-size: 0.74rem;
      line-height: 1.35;
      color: var(--po-text-secondary);
      font-weight: 400;
    }

    /* ── How it works expandable explainer ── */
    .hiw-toggle {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      background: transparent;
      border: 1px dashed var(--po-border-subtle);
      border-radius: 6px;
      padding: 0.25rem 0.55rem;
      font-size: 0.7rem;
      color: var(--po-text-secondary);
      cursor: pointer;
      margin-bottom: 0.6rem;
      transition: all 0.15s;
    }
    .hiw-toggle:hover {
      color: var(--po-text-primary);
      border-color: var(--po-accent);
    }
    .hiw-panel {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      background: var(--po-bg-2);
      border: 1px solid var(--po-border-subtle);
      border-radius: 8px;
      padding: 0.6rem 0.7rem;
      margin-bottom: 0.6rem;
    }
    .hiw-step {
      display: flex;
      align-items: flex-start;
      gap: 0.6rem;
    }
    .hiw-wave {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--po-accent-muted-bg);
      color: var(--po-accent);
      font-size: 0.72rem;
      font-weight: 700;
    }
    .hiw-text {
      display: flex;
      flex-direction: column;
      gap: 0.1rem;
      font-size: 0.74rem;
      line-height: 1.4;
      color: var(--po-text-secondary);
    }
    .hiw-text strong {
      color: var(--po-text-primary);
      font-weight: 600;
      font-size: 0.76rem;
    }

    /* ── Field label & option helper text ── */
    .field-label {
      display: block;
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--po-text-secondary);
      margin-bottom: 0.35rem;
    }
    .option-text {
      display: flex;
      flex-direction: column;
      gap: 0.1rem;
      min-width: 0;
      flex: 1;
      padding-inline-end: 0.75rem;
    }
    .option-hint {
      font-size: 0.68rem;
      color: var(--po-text-tertiary);
      line-height: 1.35;
    }

    /* ── Example chips ── */
    .example-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.35rem;
      margin: 0.4rem 0 0.2rem;
    }
    .example-row-label {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      font-size: 0.68rem;
      color: var(--po-text-tertiary);
      margin-inline-end: 0.15rem;
    }
    .example-chip {
      background: var(--po-bg-2);
      border: 1px solid var(--po-border-subtle);
      border-radius: 999px;
      padding: 0.2rem 0.6rem;
      font-size: 0.7rem;
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: all 0.15s;
    }
    .example-chip:hover {
      border-color: var(--po-accent);
      color: var(--po-accent);
      background: var(--po-accent-muted-bg);
    }

    /* ── Role legend (review phase) ── */
    .role-legend-toggle {
      margin-inline-start: auto;
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      background: transparent;
      border: 1px solid var(--po-border-subtle);
      border-radius: 5px;
      padding: 1px 6px;
      font-size: 10px;
      color: var(--po-text-secondary);
      cursor: pointer;
      transition: all 0.15s;
    }
    .role-legend-toggle:hover {
      color: var(--po-accent);
      border-color: var(--po-accent);
    }
    .role-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem 0.75rem;
      background: var(--po-bg-2);
      border: 1px solid var(--po-border-subtle);
      border-radius: 6px;
      padding: 0.45rem 0.6rem;
      margin: 0.35rem 0 0.6rem;
    }
    .role-legend-item {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.7rem;
      color: var(--po-text-secondary);
    }
    .role-legend-item .agent-icon {
      width: 18px;
      height: 18px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .role-legend-name {
      font-weight: 600;
      text-transform: capitalize;
    }
    .role-legend-desc {
      color: var(--po-text-tertiary);
    }

    /* ── Input Phase ── */
    .intent-textarea {
      width: 100%;
      background: var(--po-bg-2);
      border: 1px solid var(--po-border-subtle);
      border-radius: 8px;
      color: var(--po-text-primary);
      padding: 0.75rem;
      font-size: 0.85rem;
      font-family: inherit;
      resize: vertical;
      outline: none;
      transition: border-color 0.2s;
    }
    .intent-textarea:focus {
      border-color: rgba(99, 102, 241, 0.5);
    }
    .intent-textarea::placeholder {
      color: var(--po-text-secondary);
    }
    .intent-textarea.enhancing {
      opacity: 0.5;
      pointer-events: none;
    }

    .intent-options {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      margin: 0.75rem 0;
    }
    .option-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .option-label {
      font-size: 0.8rem;
      color: var(--po-text-secondary);
      font-weight: 500;
    }
    .provider-select {
      background: var(--po-bg-2);
      border: 1px solid var(--po-border-subtle);
      border-radius: 6px;
      color: var(--po-text-primary);
      padding: 0.3rem 0.6rem;
      font-size: 0.78rem;
      outline: none;
    }

    .toggle-switch {
      position: relative;
      width: 36px;
      height: 20px;
      background: var(--po-bg-2);
      border-radius: 10px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .toggle-switch.active {
      background: var(--po-accent);
    }
    .toggle-thumb {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #fff;
      transition: transform 0.2s;
    }
    .toggle-switch.active .toggle-thumb {
      transform: translateX(16px);
    }

    .textarea-wrapper {
      position: relative;
    }
    .enhance-wrapper {
      position: absolute;
      bottom: 8px;
      inset-inline-end: 8px;
      z-index: 2;
    }
    .btn-enhance.active {
      border-color: rgba(251, 191, 36, 0.6);
      background: rgba(251, 191, 36, 0.12);
    }
    .depth-popover {
      position: absolute;
      bottom: calc(100% + 6px);
      inset-inline-end: 0;
      min-width: 220px;
      padding: 8px;
      background: var(--po-bg-2);
      border: 1px solid rgba(251, 191, 36, 0.35);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      animation: depth-pop-in 0.12s ease-out;
    }
    @keyframes depth-pop-in {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .depth-title {
      font-size: 0.68rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--po-text-secondary);
      margin: 0 0 6px;
      padding: 0 4px;
    }
    .depth-options {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .depth-option {
      display: grid;
      grid-template-columns: 16px 1fr;
      grid-template-rows: auto auto;
      column-gap: 8px;
      row-gap: 1px;
      align-items: center;
      padding: 6px 8px;
      border: none;
      background: transparent;
      color: var(--po-text-primary);
      border-radius: 6px;
      cursor: pointer;
      text-align: start;
      transition: background 0.12s;
    }
    .depth-option iconify-icon {
      grid-row: 1 / span 2;
      color: #fbbf24;
    }
    .depth-option:hover {
      background: rgba(251, 191, 36, 0.1);
    }
    .depth-label {
      font-size: 0.78rem;
      font-weight: 600;
    }
    .depth-hint {
      font-size: 0.68rem;
      color: var(--po-text-secondary);
    }
    .btn-enhance {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.3rem;
      height: 28px;
      padding: 0 10px;
      font-size: 0.72rem;
      font-weight: 600;
      border: 1px solid var(--po-border-subtle);
      border-radius: 6px;
      background: var(--po-bg-2);
      color: #fbbf24;
      cursor: pointer;
      transition: opacity 0.2s, transform 0.1s, border-color 0.2s, background 0.2s;
      z-index: 1;
    }
    .btn-enhance:hover:not(:disabled) {
      border-color: rgba(251, 191, 36, 0.5);
      background: rgba(251, 191, 36, 0.1);
    }
    .btn-enhance:active:not(:disabled) {
      transform: scale(0.92);
    }
    .btn-enhance:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }
    .btn-spinner {
      width: 14px;
      height: 14px;
      border: 2px solid var(--po-border-subtle);
      border-top-color: #fbbf24;
      border-radius: 50%;
      animation: intent-spin 0.8s linear infinite;
    }
    .btn-generate {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      padding: 0.6rem;
      border: none;
      border-radius: 8px;
      background: var(--po-accent);
      color: #fff;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s, transform 0.1s;
    }
    .btn-generate:hover:not(:disabled) {
      opacity: 0.9;
    }
    .btn-generate:active:not(:disabled) {
      transform: scale(0.98);
    }
    .btn-generate:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* ── Loading ── */
    .intent-loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
      gap: 1rem;
    }
    .loading-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--po-border-subtle);
      border-top-color: var(--po-accent);
      border-radius: 50%;
      animation: intent-spin 0.8s linear infinite;
    }
    @keyframes intent-spin {
      to { transform: rotate(360deg); }
    }
    .loading-text {
      font-size: 0.82rem;
      color: var(--po-text-secondary);
      margin: 0;
    }

    /* ── Review Phase — redesigned for plan consultation ── */

    /* Plan summary — prominente */
    .plan-summary-box {
      display: flex;
      gap: 8px;
      padding: 8px 10px;
      background: var(--po-accent-muted-bg);
      border: 1px solid var(--po-border-subtle);
      border-radius: 7px;
      margin-bottom: 6px;
      align-items: flex-start;
    }
    .plan-summary-box > iconify-icon {
      color: var(--po-accent);
      flex-shrink: 0;
      margin-top: 2px;
    }
    .plan-summary-content { flex: 1; min-width: 0; }
    .plan-summary-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--po-accent);
      display: block;
      margin-bottom: 4px;
    }
    .plan-summary-text {
      font-size: 0.8125rem;
      color: var(--po-text-primary);
      margin: 0;
      line-height: 1.5;
    }

    /* Overview bar */
    .plan-overview-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 3px 0 5px;
      margin-bottom: 4px;
      border-bottom: 1px solid var(--po-border-subtle);
    }
    .plan-overview-stat {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 600;
      color: var(--po-text-secondary);
      white-space: nowrap;
    }
    .plan-overview-roles {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .plan-role-chip {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 1px 6px;
      border-radius: 4px;
    }

    /* Agent cards */
    .agents-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 12px;
    }

    .agent-card {
      background: var(--po-bg-2);
      border: 1px solid var(--po-border-subtle);
      border-radius: 8px;
      padding: 10px 12px;
      transition: border-color var(--po-duration-fast) var(--po-ease-out);
    }
    .agent-card.expanded {
      border-color: var(--po-accent);
    }
    .agent-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    .agent-number {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--po-bg-0);
      color: var(--po-text-tertiary);
      font-size: 10px;
      font-weight: 700;
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
    }
    .agent-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      flex-shrink: 0;
    }
    .agent-info {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 0;
    }
    .agent-name {
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--po-text-primary);
    }
    .agent-role-badge {
      font-size: 10px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .agent-goal {
      font-size: 0.8125rem;
      color: var(--po-text-primary);
      margin: 0 0 4px;
      line-height: 1.45;
    }

    /* Detail sections */
    .agent-detail-section {
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px solid var(--po-border-subtle);
    }
    .detail-label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--po-text-tertiary);
      margin-bottom: 4px;
    }
    .detail-label-warn {
      color: var(--po-warning);
    }
    .detail-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .scope-tag {
      font-size: 11px;
      font-family: var(--po-font-mono);
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--po-bg-0);
      color: var(--po-text-primary);
      border: 1px solid var(--po-border-subtle);
    }
    .task-list, .boundary-list {
      margin: 0;
      padding-inline-start: 0;
      list-style: none;
    }
    .task-list li {
      font-size: 0.78rem;
      color: var(--po-text-primary);
      padding-block: 3px;
      padding-inline: 18px 0;
      position: relative;
      line-height: 1.45;
    }
    .task-list li::before {
      content: '';
      position: absolute;
      inset-inline-start: 0;
      top: 0.55em;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--po-success);
    }
    .boundary-list li {
      font-size: 0.78rem;
      color: var(--po-text-secondary);
      padding-block: 3px;
      padding-inline: 18px 0;
      position: relative;
      line-height: 1.45;
    }
    .boundary-list li::before {
      content: '';
      position: absolute;
      inset-inline-start: 0;
      top: 0.55em;
      width: 6px;
      height: 6px;
      border-radius: 2px;
      background: var(--po-warning);
    }
    .boundaries-section {
      background: var(--po-warning-bg);
      margin-left: -12px;
      margin-right: -12px;
      margin-bottom: -10px;
      padding: 8px 12px;
      border-radius: 0 0 7px 7px;
      border-top: 1px solid var(--po-border-subtle);
    }

    /* Prompt toggle — inline text button */
    .prompt-toggle-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-top: 6px;
      padding: 3px 8px;
      border: 1px solid var(--po-border-subtle);
      border-radius: 4px;
      background: transparent;
      color: var(--po-text-tertiary);
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: color var(--po-duration-fast) var(--po-ease-out),
                  background var(--po-duration-fast) var(--po-ease-out);
    }
    .prompt-toggle-btn:hover {
      background: var(--po-accent-muted-bg);
      color: var(--po-accent);
      border-color: var(--po-accent);
    }

    /* Prompt Preview */
    .agent-prompt-preview {
      margin-top: 8px;
      border: 1px solid var(--po-border-subtle);
      border-radius: 6px;
      overflow: hidden;
    }
    .prompt-code {
      margin: 0;
      padding: 10px 12px;
      font-size: 11px;
      font-family: var(--po-font-mono);
      line-height: 1.55;
      color: var(--po-text-primary);
      background: var(--po-bg-0);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 350px;
      overflow-y: auto;
    }

    .review-actions {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
      /* Stays visible while the plan scrolls (the modal body is the scroller). */
      position: sticky;
      bottom: 0;
      z-index: 3;
      padding-block: 0.5rem 0.1rem;
      background: var(--bs-modal-bg, var(--po-bg-2));
    }
    .exec-bg-hint {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      margin-inline-end: auto;
      font-size: 0.7rem;
      color: var(--po-text-secondary);
      line-height: 1.3;
    }
    .exec-bg-hint iconify-icon {
      color: var(--po-accent);
      flex-shrink: 0;
    }
    .intent-minimize-hint {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      margin-inline-start: auto;
      margin-inline-end: 8px;
      font-size: 0.65rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--po-text-tertiary);
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(99, 102, 241, 0.1);
    }
    .btn-cancel {
      padding: 0.45rem 1rem;
      border: 1px solid var(--po-border-subtle);
      border-radius: 6px;
      background: transparent;
      color: var(--po-text-secondary);
      font-size: 0.8rem;
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn-cancel:hover {
      background: var(--po-bg-2);
    }
    .btn-execute {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.45rem 1rem;
      border: none;
      border-radius: 6px;
      background: var(--po-success);
      color: var(--po-accent-on);
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .btn-execute:hover {
      opacity: 0.9;
    }
    .btn-stop {
      color: #fbbf24;
      border-color: rgba(251, 191, 36, 0.4);
    }
    .btn-stop:hover {
      background: rgba(251, 191, 36, 0.1);
    }
    .btn-stop-delete {
      color: var(--po-error);
      border-color: rgba(248, 81, 73, 0.4);
    }
    .btn-stop-delete:hover {
      background: rgba(248, 81, 73, 0.1);
    }
    .btn-delete {
      background: var(--po-error);
    }
    .plan-header-compact.stopped {
      background: rgba(248, 81, 73, 0.1);
      border-color: rgba(248, 81, 73, 0.3);
    }
    .plan-header-compact.stopped > iconify-icon {
      color: var(--po-error);
    }

    /* ── Done / Error ── */
    .intent-done {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
      gap: 0.5rem;
      text-align: center;
    }
    .agent-remove-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: none;
      background: transparent;
      color: var(--po-text-secondary);
      border-radius: 4px;
      cursor: pointer;
      margin-inline-start: auto;
      transition: background 0.15s, color 0.15s;
      flex-shrink: 0;
    }
    .agent-remove-btn:hover {
      background: var(--po-error-bg);
      color: var(--po-error);
    }

    .done-text {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--po-text-primary);
      margin: 0;
    }
    .done-sub {
      font-size: 0.78rem;
      color: var(--po-text-secondary);
      margin: 0 0 0.5rem;
    }

    /* ── Ultra-compact plan header ── */
    .plan-header-compact {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 8px;
      background: var(--po-accent-muted-bg);
      border: 1px solid var(--po-border-subtle);
      border-radius: 6px;
      margin-bottom: 4px;
      font-size: 0.72rem;
      color: var(--po-text-primary);
      min-width: 0;
    }
    .plan-header-compact > iconify-icon {
      color: var(--po-accent);
      flex-shrink: 0;
    }
    .plan-header-summary {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .plan-header-meta {
      font-size: 0.65rem;
      font-weight: 700;
      color: var(--po-text-secondary);
      white-space: nowrap;
      padding: 1px 5px;
      background: var(--po-bg-0);
      border-radius: 4px;
    }

    /* ── Pipeline view: horizontal waves, vertical parallel ── */
    .plan-pipeline {
      display: flex;
      flex-direction: row;
      align-items: stretch;
      gap: 0.4rem;
      padding: 0.15rem 0;
      margin: 0.5rem 0;
      min-width: 0;
    }
    .wave-column {
      display: flex;
      flex-direction: column;
      flex: 1 1 0;
      min-width: 0;
      background: var(--po-bg-2);
      border: 1px solid var(--po-border-subtle);
      border-radius: 9px;
      padding: 0.4rem;
      position: relative;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .wave-column[data-status="running"] {
      border-color: rgba(99, 102, 241, 0.5);
      box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.25), 0 0 12px rgba(99, 102, 241, 0.15);
    }
    .wave-column[data-status="done"] {
      border-color: rgba(63, 185, 80, 0.4);
      opacity: 0.85;
    }
    .wave-column[data-status="waiting"] {
      opacity: 0.6;
    }

    .wave-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.3rem;
      padding: 0.15rem 0.25rem 0.35rem;
      border-bottom: 1px dashed var(--po-border-subtle);
      margin-bottom: 0.35rem;
    }
    .wave-header-main {
      display: flex;
      flex-direction: column;
      gap: 0.1rem;
      min-width: 0;
    }
    .wave-label {
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--po-text-primary);
    }
    .wave-mode {
      font-size: 0.65rem;
      color: var(--po-text-secondary);
    }
    .wave-status {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      font-size: 0.65rem;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 999px;
      white-space: nowrap;
    }
    .wave-status.running {
      background: rgba(99, 102, 241, 0.15);
      color: #8b91ff;
    }
    .wave-status.done {
      background: rgba(63, 185, 80, 0.15);
      color: #3fb950;
    }
    .wave-status.waiting {
      background: rgba(139, 148, 158, 0.12);
      color: var(--po-text-secondary);
    }
    .wave-spinner {
      width: 10px;
      height: 10px;
      border: 2px solid rgba(99, 102, 241, 0.25);
      border-top-color: #8b91ff;
      border-radius: 50%;
      animation: wave-spin 0.7s linear infinite;
    }
    @keyframes wave-spin {
      to { transform: rotate(360deg); }
    }

    .wave-agents {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }
    .wave-agents .agent-card {
      margin: 0;
    }
    /* Ultra-compact card — single-line header, details expand on click */
    .wave-agents .agent-card.compact {
      padding: 4px 6px;
      border-radius: 6px;
    }
    .wave-agents .agent-card.compact.expanded {
      padding: 6px 8px;
    }
    .wave-agents .agent-card.compact .agent-card-header {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-bottom: 0;
      cursor: pointer;
      min-width: 0;
    }
    .wave-agents .agent-card.compact .agent-icon {
      width: 18px;
      height: 18px;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .wave-agents .agent-card.compact .agent-name {
      flex: 1;
      font-size: 0.73rem;
      font-weight: 600;
      color: var(--po-text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .wave-agents .agent-card.compact .agent-role-badge {
      font-size: 9px;
      padding: 1px 4px;
      flex-shrink: 0;
    }
    .wave-agents .agent-card.compact .card-chevron {
      color: var(--po-text-tertiary);
      flex-shrink: 0;
      transition: transform 0.15s;
    }
    .wave-agents .agent-card.compact.expanded .card-chevron {
      color: var(--po-accent);
    }
    .wave-agents .agent-card.compact .agent-goal {
      font-size: 0.72rem;
      margin: 6px 0 3px;
      line-height: 1.35;
      color: var(--po-text-secondary);
    }
    .wave-agents .agent-card.compact .prompt-toggle-btn {
      margin-top: 2px;
      padding: 2px 6px;
      font-size: 10px;
    }
    .wave-agents .agent-card.compact .agent-detail-section {
      margin-top: 5px;
      padding-top: 4px;
    }
    .wave-agents .agent-card.compact .task-list li,
    .wave-agents .agent-card.compact .boundary-list li {
      font-size: 0.72rem;
      padding-block: 2px;
      padding-inline: 14px 0;
      line-height: 1.35;
    }
    .wave-agents .agent-card.compact .task-list li::before,
    .wave-agents .agent-card.compact .boundary-list li::before {
      width: 5px;
      height: 5px;
      top: 0.5em;
    }
    .wave-agents .agent-card.compact .detail-label {
      font-size: 9px;
      margin-bottom: 2px;
    }
    .wave-agents .agent-card.compact .scope-tag {
      font-size: 10px;
      padding: 1px 6px;
    }
    .wave-agents .agent-card.compact .agent-prompt-preview .prompt-code {
      max-height: 200px;
      font-size: 10px;
      padding: 8px 10px;
    }
    .wave-agents .agent-card.compact .boundaries-section {
      margin-left: -9px;
      margin-right: -9px;
      margin-bottom: -7px;
      padding: 5px 9px;
    }
    .wave-agents .agent-card.compact .agent-remove-btn {
      width: 18px;
      height: 18px;
    }

    .wave-arrow {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--po-text-secondary);
      opacity: 0.6;
      align-self: center;
      flex: 0 0 auto;
      padding: 0 0.15rem;
    }
    :host-context([dir="rtl"]) .wave-arrow iconify-icon { transform: scaleX(-1); }
  `,
})
export class IntentModalComponent implements OnInit {
  modal = inject(NgbActiveModal);
  intentService = inject(IntentService);
  private translate = inject(TranslateService);

  providers = PROVIDERS;
  depthOptions = DEPTH_OPTIONS;
  exampleIntents = EXAMPLE_INTENTS;
  roleLegend = ROLE_LEGEND;
  intentText = '';
  selectedProvider: SubAgentProvider = 'claude-code-cli';
  autoApprove = signal(false);
  enhancing = signal(false);
  showDepthPicker = signal(false);
  showHowItWorks = signal(false);
  showRoleLegend = signal(false);
  expandedAgent = signal<number | null>(null);

  // Injected by the parent when opening the modal
  parentSessionId = '';
  sessionProvider: SubAgentProvider = 'claude-code-cli';
  sessionContext = '';
  projectStructure = '';

  ngOnInit(): void {
    const sameSession = this.intentService.activeSessionId() === this.parentSessionId;
    const inFlight = this.intentService.hasInFlightState();

    // Reopening on the same session with state in flight (review/executing/done/error or a plan still loaded)
    // → restore instead of wiping. This is what makes the modal "minimizable" via the X button.
    if (sameSession && inFlight) {
      this.intentText = this.intentService.draftIntent();
      this.selectedProvider = this.intentService.draftProvider() ?? this.sessionProvider ?? 'claude-code-cli';
      this.autoApprove.set(this.intentService.draftAutoApprove());
      return;
    }

    // Different session, or nothing in flight → start fresh.
    this.intentService.hardReset();
    this.intentService.activeSessionId.set(this.parentSessionId);
    if (this.sessionProvider) {
      this.selectedProvider = this.sessionProvider;
      this.intentService.draftProvider.set(this.sessionProvider);
    }
  }

  removeAgent(index: number): void {
    const plan = this.intentService.currentPlan();
    if (!plan || plan.agents.length <= 1) return;
    const updated = { ...plan, agents: plan.agents.filter((_, i) => i !== index) };
    this.intentService.currentPlan.set(updated);
  }

  toggleAutoApprove(): void {
    this.autoApprove.update(v => !v);
    this.intentService.draftAutoApprove.set(this.autoApprove());
  }

  toggleHowItWorks(): void {
    this.showHowItWorks.update(v => !v);
  }

  toggleRoleLegend(): void {
    this.showRoleLegend.update(v => !v);
  }

  useExample(i18nKey: string): void {
    const text = this.translate.instant(i18nKey);
    this.onIntentTextChange(text);
  }

  onIntentTextChange(value: string): void {
    this.intentText = value;
    this.intentService.draftIntent.set(value);
  }

  onProviderChange(value: SubAgentProvider): void {
    this.selectedProvider = value;
    this.intentService.draftProvider.set(value);
  }

  /** Reopen-friendly close. Dismiss = minimize: keep state, do NOT cancel execution. */
  minimize(): void {
    this.modal.dismiss();
  }

  /** Stop wave execution but keep the intent (and the spawned agents) around. */
  stopExecution(): void {
    this.intentService.stop();
  }

  /** Stop and wipe the intent state from the panel. */
  stopAndDelete(): void {
    this.intentService.stop();
    this.intentService.hardReset();
    this.modal.dismiss();
  }

  /** Wipe a stopped/done intent from the panel. */
  deleteIntent(): void {
    this.intentService.hardReset();
    this.modal.dismiss();
  }

  /** Discard everything and close — only when there is nothing executing. */
  discardAndClose(): void {
    this.intentService.hardReset();
    this.modal.dismiss();
  }

  startNewIntent(): void {
    this.intentService.hardReset();
    this.intentText = '';
    this.intentService.activeSessionId.set(this.parentSessionId);
    this.intentService.draftProvider.set(this.selectedProvider);
  }

  closeDone(): void {
    this.intentService.hardReset();
    this.modal.close('done');
  }

  onEnhanceClick(event: MouseEvent): void {
    event.stopPropagation();
    if (!this.intentText.trim() || this.enhancing()) return;
    this.showDepthPicker.update(v => !v);
  }

  @HostListener('document:click')
  closeDepthPicker(): void {
    if (this.showDepthPicker()) {
      this.showDepthPicker.set(false);
    }
  }

  async runEnhance(depth: EnhanceDepth): Promise<void> {
    if (!this.intentText.trim() || this.enhancing()) return;
    this.showDepthPicker.set(false);
    this.enhancing.set(true);
    try {
      // Minimum visible delay so user sees the spinner
      const [result] = await Promise.all([
        this.intentService.enhancePrompt(
          this.intentText.trim(),
          this.selectedProvider,
          this.sessionContext || undefined,
          this.projectStructure || undefined,
          depth,
        ),
        new Promise(r => setTimeout(r, 600)),
      ]);
      // A failed enhancement must never wipe what the user typed.
      if (typeof result === 'string' && result.trim()) this.onIntentTextChange(result);
    } catch {
      // Keep the original text: enhancing is optional sugar.
    } finally {
      // Otherwise a rejection leaves the textarea disabled forever.
      this.enhancing.set(false);
    }
  }

  async generate(): Promise<void> {
    if (!this.intentText.trim()) return;
    this.intentService.draftIntent.set(this.intentText);
    this.intentService.draftProvider.set(this.selectedProvider);
    this.intentService.activeSessionId.set(this.parentSessionId);
    try {
      await this.intentService.generatePlan(
        this.intentText.trim(),
        this.selectedProvider,
        this.sessionContext || undefined,
        this.projectStructure || undefined,
      );
    } catch (err) {
      this.showError(err);
    }
  }

  async execute(): Promise<void> {
    const plan = this.intentService.currentPlan();
    if (!plan || !this.parentSessionId) return;
    try {
      await this.intentService.executeInDedicatedSession(
        this.parentSessionId,
        plan,
        this.selectedProvider,
        this.autoApprove(),
      );
    } catch (err) {
      this.showError(err);
    }
  }

  /** Surface an unexpected failure in the modal's error state (Back / Retry). */
  private showError(err: unknown): void {
    const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    this.intentService.error.set(message || this.translate.instant('MESSAGE.Generic error'));
    this.intentService.phase.set('error');
  }

  cancel(): void {
    // From review/error: go back to input but KEEP the typed intent so the user can tweak it.
    const draft = this.intentService.draftIntent();
    this.intentService.reset();
    this.intentService.draftIntent.set(draft);
    this.intentText = draft;
  }

  toggleExpand(index: number): void {
    this.expandedAgent.update(v => v === index ? null : index);
  }

  getPromptPreview(plan: IntentPlan, agentIndex: number): string {
    const previews = this.intentService.getAgentPromptPreview(plan, this.autoApprove());
    return previews[agentIndex]?.prompt ?? '';
  }

  getRoleColor(role: string): string {
    return ROLE_COLORS[role] ?? '#8391a2';
  }

  getRoleIcon(role: string): string {
    return ROLE_ICONS[role] ?? 'solar:cpu-bolt-bold-duotone';
  }

  /**
   * Group agents by wave for the pipeline layout.
   * Waves become columns (horizontal), agents within a wave stack (vertical).
   */
  waveGroups(plan: IntentPlan): Array<{ wave: number; agents: IntentAgent[] }> {
    const map = new Map<number, IntentAgent[]>();
    for (const a of plan.agents) {
      const w = a.wave ?? 1;
      if (!map.has(w)) map.set(w, []);
      map.get(w)!.push(a);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a - b)
      .map(([wave, agents]) => ({ wave, agents }));
  }

  /** Index of an agent within plan.agents — used to key expanded-prompt state. */
  agentIndex(plan: IntentPlan, agent: IntentAgent): number {
    return plan.agents.findIndex(a => a.name === agent.name);
  }

  /**
   * Status of a wave relative to the running execution.
   * Returns 'idle' during review (no execution yet).
   */
  waveStatus(wave: number): 'idle' | 'running' | 'done' | 'waiting' {
    const phase = this.intentService.phase();
    if (phase === 'review') return 'idle';
    if (phase === 'done') return 'done';
    if (phase === 'stopped' || phase === 'error') return 'idle';
    const current = this.intentService.currentWave();
    if (current === null) return 'done';
    if (wave < current) return 'done';
    if (wave === current) return 'running';
    return 'waiting';
  }
}
