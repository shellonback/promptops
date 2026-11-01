import { Component, CUSTOM_ELEMENTS_SCHEMA, inject, signal, effect, input, output, ChangeDetectionStrategy } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { VoiceAgentService } from './voice-agent.service';
import { FeatureFlagService } from '@core/services/feature-flag.service';
import { VoiceCommandsGuideModalComponent } from './voice-commands-guide-modal.component';
import { VoiceOnboardingModalComponent } from './voice-onboarding-modal.component';
import { EscCloseDirective } from '@/app/common/esc-close.directive';

@Component({
  selector: 'app-voice-agent',
  standalone: true,
  imports: [TranslateModule, EscCloseDirective],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    @if (ff.canAccess('voice_agent') && variant() === 'fab') {
      <div
        class="voice-dock"
        [class.listening]="voice.state() === 'listening'"
        [class.processing]="voice.state() === 'processing'"
      >
        <!-- Siri-style liquid orb (mic) + shortcut chip + guide. Nothing else. -->
        <div class="orb-row">
          <div class="orb-wrap">
            <button
              class="voice-orb"
              (click)="onToggle($event)"
              (contextmenu)="openGuide($event)"
              [title]="voice.state() === 'listening' ? ('VOICE.Stop' | translate) : ('VOICE.Speak' | translate)"
            >
              @if (voice.state() === 'processing') {
                <iconify-icon icon="solar:refresh-bold" width="15" class="spin"></iconify-icon>
              } @else {
                <iconify-icon icon="solar:microphone-bold" width="15"></iconify-icon>
              }
            </button>
          </div>
          <kbd class="dock-kbd" [class.off]="!shortcutEnabled()" (click)="onShortcutChipClick($event)"
               [title]="(shortcutEnabled() ? 'voice.guide.shortcut_hint' : 'voice.guide.banner_title') | translate">
            {{ shortcutLabel() }}
          </kbd>
          <button class="dock-help" (click)="openGuide($event)" [title]="'voice.guide.open_button' | translate">?</button>
          @if (minimizable()) {
            <button class="dock-min" (click)="onMinimize($event)" [title]="'voice.dock.minimize' | translate">
              <iconify-icon icon="solar:alt-arrow-down-bold" width="11"></iconify-icon>
            </button>
          }
        </div>

        <!-- Transcription + feedback (below the orb — dock sits top center) -->
        @if (voice.state() === 'listening') {
          <div class="voice-feedback fab-bubble listening-hint">
            <div class="listening-dots"><span></span><span></span><span></span></div>
            {{ 'VOICE.Listening' | translate }}
          </div>
        }
        @if (voice.feedback()) {
          <div class="voice-feedback fab-bubble" [class.error]="voice.lastResult()?.intent === 'unknown'" [class.success]="voice.lastResult()?.intent && voice.lastResult()?.intent !== 'unknown'">
            <span class="voice-transcript">{{ voice.feedback() }}</span>
            @if (voice.lastHeard() && voice.lastHeard() !== voice.feedback()) {
              <span class="voice-heard">🎙 "{{ voice.lastHeard() }}"</span>
            }
            @if (voice.showConfirm()) {
              <div class="voice-confirm">
                <button class="vc-yes" (click)="voice.confirmDangerous()">{{ 'VOICE.Execute' | translate }}</button>
                <button class="vc-no" (click)="voice.cancelDangerous()">{{ 'VOICE.Cancel' | translate }}</button>
              </div>
            }
          </div>
        }
      </div>
    }

    @if (ff.canAccess('voice_agent') && variant() === 'inline') {
      <div
        class="voice-fab"
        [class.listening]="voice.state() === 'listening'"
        [class.processing]="voice.state() === 'processing'"
      >
        <div class="voice-mic-wrap">
          <button
            class="voice-btn"
            (click)="onToggle($event)"
            (contextmenu)="openGuide($event)"
            [title]="voice.state() === 'listening' ? ('VOICE.Stop' | translate) : ('VOICE.Speak' | translate)"
          >
            @if (voice.state() === 'processing') {
              <iconify-icon icon="solar:refresh-bold" width="14" class="spin"></iconify-icon>
            } @else if (voice.state() === 'listening') {
              <iconify-icon icon="solar:microphone-bold" width="14"></iconify-icon>
            } @else {
              <iconify-icon icon="solar:microphone-bold-duotone" width="14"></iconify-icon>
            }
          </button>

          <!-- Help badge — top-right corner of the mic (topbar variant only) -->
          @if (!showGuideButton()) {
            <button class="voice-help" (click)="openGuide($event)" [title]="'voice.guide.open_button' | translate">
              ?
            </button>
          }
        </div>

        @if (showGuideButton()) {
          <!-- Bottom-bar variant: shortcut chip + "?" beside the mic -->
          <kbd class="dock-kbd" [class.off]="!shortcutEnabled()" (click)="onShortcutChipClick($event)"
               [title]="(shortcutEnabled() ? 'voice.guide.shortcut_hint' : 'voice.guide.banner_title') | translate">
            {{ shortcutLabel() }}
          </kbd>
          <button class="dock-help" (click)="openGuide($event)" [title]="'voice.guide.open_button' | translate">?</button>
          @if (expandable()) {
            <button class="dock-min" (click)="onExpand($event)" [title]="'voice.dock.expand' | translate">
              <iconify-icon icon="solar:alt-arrow-up-bold" width="11"></iconify-icon>
            </button>
          }
        } @else {
          <!-- Topbar variant: compact chip overlapping the mic's bottom edge -->
          <button type="button"
                class="shortcut-chip"
                [class.disabled]="!shortcutEnabled()"
                (click)="onShortcutChipClick($event)"
                [title]="(shortcutEnabled() ? 'voice.guide.shortcut_hint' : 'voice.guide.banner_title') | translate">
            {{ shortcutLabel() }}
          </button>
        }

        <!-- Transcription + Feedback -->
        @if (voice.state() === 'listening') {
          <div class="voice-feedback listening-hint" [class.above]="bubbleAbove()">
            <div class="listening-dots">
              <span></span><span></span><span></span>
            </div>
            {{ 'VOICE.Listening' | translate }}
          </div>
        }
        @if (voice.feedback()) {
          <div class="voice-feedback" [class.above]="bubbleAbove()" [class.error]="voice.lastResult()?.intent === 'unknown'" [class.success]="voice.lastResult()?.intent && voice.lastResult()?.intent !== 'unknown'">
            <span class="voice-transcript">{{ voice.feedback() }}</span>
            @if (voice.lastHeard() && voice.lastHeard() !== voice.feedback()) {
              <span class="voice-heard">🎙 "{{ voice.lastHeard() }}"</span>
            }
            @if (voice.lastResult()?.intent && voice.lastResult()?.intent !== 'unknown') {
              <span class="voice-intent-badge">{{ voice.lastResult()?.intent === 'navigate_sessions' ? ('VOICE.Navigate' | translate) : voice.lastResult()?.intent === 'open_session' ? ('VOICE.Session intent' | translate) : ('VOICE.Terminal intent' | translate) }}</span>
            }
            @if (voice.showConfirm()) {
              <div class="voice-confirm">
                <button class="vc-yes" (click)="voice.confirmDangerous()">{{ 'VOICE.Execute' | translate }}</button>
                <button class="vc-no" (click)="voice.cancelDangerous()">{{ 'VOICE.Cancel' | translate }}</button>
              </div>
            }
          </div>
        }
      </div>
    }

    <!-- Microphone Permission Modal -->
    @if (voice.micDenied()) {
      <div class="mic-modal-backdrop" (click)="voice.dismissMicModal()">
        <div class="mic-modal" (click)="$event.stopPropagation()" appEscClose (escClose)="voice.dismissMicModal()">
          <div class="mic-modal-icon">
            <iconify-icon icon="mdi:microphone-off" width="40"></iconify-icon>
          </div>
          <h3 class="mic-modal-title">{{ (voice.micGuide()?.title || 'VOICE.Mic access title') | translate }}</h3>
          <ol class="mic-modal-steps">
            @for (step of voice.micGuide()?.steps || []; track step) {
              <li>{{ step | translate }}</li>
            }
          </ol>
          <div class="mic-modal-actions">
            @if (voice.micGuide()?.action === 'open-settings') {
              <button class="mic-btn-primary" (click)="voice.openMicSettings()">
                <iconify-icon icon="solar:settings-bold" width="16"></iconify-icon>
                {{ 'VOICE.OpenSettings' | translate }}
              </button>
            }
            <button class="mic-btn-secondary" (click)="voice.dismissMicModal()">
              {{ 'VOICE.Close' | translate }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      overflow: visible;
    }

    /* ══════ FAB variant — liquid Siri orb, fixed top center ══════ */
    .voice-dock {
      position: fixed;
      top: 2px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 1200;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .orb-row {
      display: inline-flex;
      align-items: center;
      gap: 7px;
    }
    /* Fixed-size wrapper: the orb morphs/scales inside without shifting
       the shortcut/guide neighbors. */
    .orb-wrap {
      position: relative;
      width: 34px;
      height: 34px;
      flex: 0 0 34px;
    }

    /* The orb — conic gradient sphere with breathing aura and glassy
       highlight; liquid-blob morph + ripples while listening. */
    .voice-orb {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      border: none;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      position: relative;
      overflow: visible;
      isolation: isolate;
      transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.25s ease;
      background:
        conic-gradient(from 220deg,
          #6366f1 0%,
          #8b5cf6 25%,
          #ec4899 50%,
          #8b5cf6 75%,
          #6366f1 100%);
      box-shadow:
        0 4px 14px rgba(139,92,246,0.35),
        0 0 0 1px rgba(255,255,255,0.06) inset;
    }
    /* Outer aura that softly breathes — always on */
    .voice-orb::before {
      content: '';
      position: absolute;
      inset: -8px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(139,92,246,0.45) 0%, rgba(99,102,241,0.18) 45%, transparent 70%);
      filter: blur(8px);
      z-index: -1;
      animation: idle-aura 3.2s ease-in-out infinite;
      pointer-events: none;
    }
    /* Inner highlight — glassy depth */
    .voice-orb::after {
      content: '';
      position: absolute;
      inset: 3px;
      border-radius: 50%;
      background: radial-gradient(ellipse at 30% 25%, rgba(255,255,255,0.45) 0%, rgba(255,255,255,0) 55%);
      pointer-events: none;
    }
    .voice-orb:hover {
      transform: scale(1.1);
      box-shadow:
        0 8px 24px rgba(139,92,246,0.55),
        0 0 0 1px rgba(255,255,255,0.10) inset;
    }
    .voice-orb:active { transform: scale(0.95); }
    .voice-orb iconify-icon { position: relative; z-index: 1; }

    /* Listening: liquid blob morph + slow spin + ripple waves */
    .voice-dock.listening .voice-orb {
      animation: liquid-morph 1.6s ease-in-out infinite, orb-rotate 6s linear infinite;
      box-shadow:
        0 0 18px rgba(236,72,153,0.55),
        0 0 44px rgba(139,92,246,0.45);
    }
    .voice-dock.listening .voice-orb iconify-icon {
      animation: counter-spin 6s linear infinite;
    }
    .voice-dock.listening .voice-orb::before {
      inset: -12px;
      background: radial-gradient(circle, rgba(236,72,153,0.55) 0%, rgba(139,92,246,0.30) 45%, transparent 75%);
      filter: blur(11px);
      animation: listen-aura 1.8s ease-in-out infinite;
    }
    /* Concentric ripple waves emitted while listening */
    .orb-wrap::before,
    .orb-wrap::after {
      content: none;
    }
    .voice-dock.listening .orb-wrap::before,
    .voice-dock.listening .orb-wrap::after {
      content: '';
      position: absolute;
      top: 50%; left: 50%;
      width: 0; height: 0;
      border-radius: 50%;
      border: 2px solid rgba(236,72,153,0.55);
      transform: translate(-50%, -50%);
      animation: orb-ripple 1.8s ease-out infinite;
      pointer-events: none;
    }
    .voice-dock.listening .orb-wrap::after {
      animation-delay: 0.9s;
      border-color: rgba(139,92,246,0.55);
    }

    /* Processing: warm conic spin */
    .voice-dock.processing .voice-orb {
      background: conic-gradient(from 0deg, #6366f1, #ec4899, #f59e0b, #ec4899, #6366f1);
      animation: orb-rotate 1.2s linear infinite;
      box-shadow: 0 4px 16px rgba(245,158,11,0.45), 0 0 22px rgba(236,72,153,0.35);
    }
    .voice-dock.processing .voice-orb iconify-icon {
      animation: counter-spin 1.2s linear infinite;
    }
    .voice-dock.processing .voice-orb::before {
      background: radial-gradient(circle, rgba(245,158,11,0.5) 0%, rgba(236,72,153,0.25) 45%, transparent 75%);
    }

    @keyframes orb-rotate { to { transform: rotate(360deg); } }
    @keyframes counter-spin { to { transform: rotate(-360deg); } }
    @keyframes idle-aura {
      0%, 100% { opacity: 0.65; transform: scale(1); }
      50% { opacity: 0.95; transform: scale(1.08); }
    }
    @keyframes listen-aura {
      0%, 100% { opacity: 0.7; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.18); }
    }
    @keyframes liquid-morph {
      0%, 100% { border-radius: 50%; }
      20% { border-radius: 42% 58% 56% 44% / 48% 52% 48% 52%; }
      40% { border-radius: 58% 42% 44% 56% / 52% 48% 52% 48%; }
      60% { border-radius: 50% 50% 38% 62% / 60% 40% 50% 50%; }
      80% { border-radius: 46% 54% 52% 48% / 44% 56% 50% 50%; }
    }
    @keyframes orb-ripple {
      0% { width: 0; height: 0; opacity: 0.7; }
      100% { width: 68px; height: 68px; opacity: 0; }
    }

    /* Shortcut chip + guide beside the orb */
    .dock-kbd {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.58rem;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--po-bg-3, rgba(27,33,41,0.92));
      border: 1px solid rgba(99,102,241,0.35);
      color: rgba(139,156,246,0.95);
      line-height: 1.4;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s, border-color 0.15s;
    }
    .dock-kbd:hover { background: rgba(99,102,241,0.2); border-color: rgba(99,102,241,0.6); }
    .dock-kbd.off { opacity: 0.55; text-decoration: line-through; }

    .dock-help {
      width: 17px;
      height: 17px;
      border-radius: 50%;
      border: none;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      line-height: 1;
      box-shadow: 0 1px 4px rgba(99,102,241,0.45);
      transition: transform 0.15s;
    }
    .dock-help:hover { transform: scale(1.15); }

    /* Inline (bottom-bar) variant reuses the dock chips beside the flat mic */
    .voice-fab .dock-kbd { margin-left: 6px; }
    .voice-fab .dock-help { margin-left: 5px; }
    .voice-fab .dock-min { margin-left: 4px; }

    /* Minimize/expand toggle — dim satellite beside the "?" */
    .dock-min {
      width: 17px;
      height: 17px;
      border-radius: 50%;
      border: 1px solid var(--po-border-subtle, #30363d);
      background: var(--po-bg-3, rgba(27,33,41,0.92));
      color: var(--po-text-secondary, #8b949e);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: color 0.15s, border-color 0.15s, transform 0.15s;
    }
    .dock-min:hover {
      color: #8b9cf6;
      border-color: rgba(99,102,241,0.5);
      transform: scale(1.1);
    }

    /* Feedback bubbles: dock is top center → open BELOW, centered */
    .voice-feedback.fab-bubble {
      position: absolute;
      top: calc(100% + 10px);
      bottom: auto;
      left: 50%;
      right: auto;
      transform: translateX(-50%);
      animation: none;
    }


    .voice-fab {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      overflow: visible;
    }
    .voice-mic-wrap {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      overflow: visible;
    }

    /* Mic — flat tool-btn style, aligned with action-center toolbar mic */
    .voice-btn {
      position: relative;
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: #ec4899;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      transition: background 0.15s, color 0.15s, transform 0.1s;
    }
    .voice-btn:hover:not(:disabled) {
      background: rgba(236, 72, 153, 0.14);
      color: #ec4899;
    }
    .voice-btn:active:not(:disabled) { transform: scale(0.94); }

    .voice-fab.listening .voice-btn {
      background: rgba(236, 72, 153, 0.22);
      color: #ec4899;
      animation: voice-pulse 1.2s ease-in-out infinite;
    }
    .voice-fab.processing .voice-btn {
      background: var(--po-warning-bg);
      color: var(--po-warning);
    }

    @keyframes voice-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(236, 72, 153, 0.4); }
      50% { box-shadow: 0 0 0 5px rgba(236, 72, 153, 0); }
    }

    .voice-btn iconify-icon {
      position: relative;
      z-index: 1;
    }

    /* Help badge — pinned at the top-right corner of the mic */
    .voice-help {
      position: absolute;
      top: -3px;
      right: -3px;
      width: 13px;
      height: 13px;
      border-radius: 50%;
      border: 1.5px solid var(--bs-body-bg, #161b22);
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff;
      font-size: 9px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 1px 3px rgba(99,102,241,0.45);
      transition: transform 0.15s;
      padding: 0;
      line-height: 1;
      z-index: 2;
    }
    .voice-help:hover { transform: scale(1.18); }

    /* Commands list button — sits beside the mic in the bottom-bar variant. */
    .voice-list-btn {
      width: 24px;
      height: 24px;
      margin-left: 2px;
      border: 1px solid rgba(99,102,241,0.28);
      border-radius: 7px;
      background: rgba(99,102,241,0.12);
      color: rgba(99,102,241,0.95);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      transition: background 0.15s, border-color 0.15s, transform 0.1s;
    }
    .voice-list-btn:hover {
      background: rgba(99,102,241,0.22);
      border-color: rgba(99,102,241,0.5);
    }
    .voice-list-btn:active { transform: scale(0.94); }

    /* Shortcut chip — absolute, centered, overlapping the bottom edge of the mic */
    .shortcut-chip {
      position: absolute;
      bottom: 0;
      left: 50%;
      transform: translate(-50%, 50%);
      z-index: 3;
      display: inline-flex;
      align-items: center;
      padding: 0 4px;
      font-size: 0.5rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-weight: 600;
      color: rgba(99,102,241,0.95);
      background: rgba(99,102,241,0.12);
      border: 1px solid rgba(99,102,241,0.28);
      border-radius: 4px;
      white-space: nowrap;
      letter-spacing: 0.02em;
      line-height: 1.4;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .shortcut-chip:hover {
      background: rgba(99,102,241,0.22);
      border-color: rgba(99,102,241,0.5);
    }
    .shortcut-chip.disabled {
      color: rgba(139,148,158,0.85);
      background: rgba(139,148,158,0.10);
      border-color: rgba(139,148,158,0.20);
      opacity: 0.85;
    }
    .shortcut-chip.disabled:hover {
      color: rgba(99,102,241,0.95);
      background: rgba(99,102,241,0.12);
      border-color: rgba(99,102,241,0.4);
      opacity: 1;
    }

    .voice-feedback {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      min-width: 220px;
      max-width: 320px;
      background: var(--bs-body-bg, #0d1117);
      border: 1px solid var(--bs-border-color, #30363d);
      border-radius: 10px;
      padding: 0.6rem 0.75rem;
      font-size: 0.78rem;
      color: var(--bs-body-color, #e6edf3);
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      animation: fadeIn 0.2s ease;
      z-index: 1050;
    }
    /* Bottom-bar variant: flip the bubble ABOVE the mic and anchor to its left
       edge so it isn't pushed off the bottom of the screen. */
    .voice-feedback.above {
      top: auto;
      bottom: calc(100% + 8px);
      left: 0;
      right: auto;
    }
    .voice-feedback.error { border-color: rgba(248,81,73,0.3); }
    .voice-feedback.success { border-color: rgba(236,72,153,0.3); }

    .voice-transcript { display: block; line-height: 1.5; }
    .voice-heard {
      display: block;
      margin-top: 0.3rem;
      font-size: 0.7rem;
      color: var(--bs-secondary-color, #8b949e);
      font-style: italic;
      border-top: 1px dashed rgba(139,148,158,0.2);
      padding-top: 0.3rem;
    }

    .voice-intent-badge {
      display: inline-block;
      margin-top: 0.3rem;
      font-size: 0.62rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 1px 6px;
      border-radius: 4px;
      background: rgba(236,72,153,0.12);
      color: #ec4899;
    }

    .listening-hint {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.75rem;
      color: #ec4899;
      border-color: rgba(236,72,153,0.2);
    }

    .listening-dots {
      display: flex;
      gap: 3px;
    }
    .listening-dots span {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #ec4899;
      animation: dot-bounce 1.2s ease-in-out infinite;
    }
    .listening-dots span:nth-child(2) { animation-delay: 0.2s; }
    .listening-dots span:nth-child(3) { animation-delay: 0.4s; }

    @keyframes dot-bounce {
      0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
      40% { transform: scale(1); opacity: 1; }
    }

    .voice-confirm {
      display: flex;
      gap: 0.4rem;
      margin-top: 0.5rem;
    }
    .vc-yes, .vc-no {
      flex: 1;
      padding: 0.3rem;
      border: none;
      border-radius: 6px;
      font-size: 0.72rem;
      font-weight: 600;
      cursor: pointer;
    }
    .vc-yes { background: rgba(248,81,73,0.15); color: #f85149; }
    .vc-no { background: rgba(139,148,158,0.15); color: #8b949e; }

    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }

    /* Microphone Permission Modal */
    .mic-modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 999999;
      background: rgba(0,0,0,0.6);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      animation: fadeIn 0.2s ease;
    }

    .mic-modal {
      background: var(--bs-body-bg, #161b22);
      border: 1px solid var(--bs-border-color, #30363d);
      border-radius: 16px;
      padding: 2rem;
      max-width: 420px;
      width: 90%;
      box-shadow: 0 24px 64px rgba(0,0,0,0.5);
      text-align: center;
      animation: modalSlideIn 0.3s ease;
    }

    @keyframes modalSlideIn {
      from { opacity: 0; transform: translateY(20px) scale(0.95); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .mic-modal-icon {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      background: rgba(248,81,73,0.1);
      color: #f85149;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.2rem;
    }

    .mic-modal-title {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--bs-body-color, #e6edf3);
      margin: 0 0 1rem;
    }

    .mic-modal-steps {
      text-align: left;
      padding-left: 1.2rem;
      margin: 0 0 1.5rem;
      font-size: 0.85rem;
      color: var(--bs-secondary-color, #8b949e);
      line-height: 1.8;
    }
    .mic-modal-steps li {
      margin-bottom: 0.3rem;
    }

    .mic-modal-actions {
      display: flex;
      gap: 0.6rem;
      justify-content: center;
    }

    .mic-btn-primary {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.55rem 1.2rem;
      border: none;
      border-radius: 8px;
      background: linear-gradient(135deg, #ec4899, #8b5cf6);
      color: #fff;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .mic-btn-primary:hover {
      transform: scale(1.03);
      box-shadow: 0 4px 16px rgba(236,72,153,0.3);
    }

    .mic-btn-secondary {
      padding: 0.55rem 1.2rem;
      border: 1px solid var(--bs-border-color, #30363d);
      border-radius: 8px;
      background: transparent;
      color: var(--bs-secondary-color, #8b949e);
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .mic-btn-secondary:hover {
      background: rgba(139,148,158,0.1);
    }
  `,
})
export class VoiceAgentComponent {
  voice = inject(VoiceAgentService);
  ff = inject(FeatureFlagService);
  private modalService = inject(NgbModal);

  /** 'inline' renders the compact toolbar mic (topbar). 'fab' renders the
   *  floating voice dock (labeled mic pill + quick panel), used by the
   *  minimal bottom bar. */
  variant = input<'inline' | 'fab'>('inline');
  /** When true (minimal bottom bar), render a dedicated button next to the mic
   *  that opens the voice commands guide. The mic itself still records on click. */
  showGuideButton = input(false);
  /** When true, render the transcription/feedback bubble above the mic. */
  bubbleAbove = input(false);
  /** FAB variant: show the minimize toggle (orb → bottom-bar icon). */
  minimizable = input(false);
  /** Inline bottom-bar variant: show the expand toggle (icon → orb). */
  expandable = input(false);
  minimize = output<void>();
  expand = output<void>();

  shortcutEnabled = signal(false);
  shortcutLabel = signal('');

  private lastHelpRequest = 0;

  constructor() {
    this.loadShortcutState();
    effect(() => {
      const tick = this.voice.openHelpRequest();
      if (tick !== this.lastHelpRequest) {
        this.lastHelpRequest = tick;
        if (tick > 0) this.openGuide();
      }
    });
  }

  private async loadShortcutState(): Promise<void> {
    const api = (window as any).promptops;
    this.shortcutLabel.set(this.composeShortcutLabel());
    if (!api?.getVoiceShortcutConfig) return;
    try {
      const res = await api.getVoiceShortcutConfig();
      if (res?.ok && res.config) this.shortcutEnabled.set(!!res.config.enabled);
    } catch { /* ignore */ }
  }

  private composeShortcutLabel(): string {
    // Must mirror `voice_shortcut()` in desktop-app-v2 voice.rs: Alt+M on
    // every OS (⌥+M on macOS). OS from the bridge: the WebKitGTK UA says Mac.
    const p = (window as any).promptops?.platform
      ?? (navigator.userAgent.includes('Macintosh') ? 'darwin' : '');
    return p === 'darwin' ? '⌥M' : 'Alt+M';
  }

  onShortcutChipClick(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    // If shortcut is disabled, open onboarding modal so user can enable it.
    // If enabled, fall back to the commands guide for reference.
    if (!this.shortcutEnabled()) {
      this.modalService.open(VoiceOnboardingModalComponent, {
        size: 'md',
        centered: true,
        backdrop: 'static',
      });
    } else {
      this.openGuide();
    }
  }

  onMinimize(e: MouseEvent): void {
    e.stopPropagation();
    this.minimize.emit();
  }

  onExpand(e: MouseEvent): void {
    e.stopPropagation();
    this.expand.emit();
  }

  onToggle(e: MouseEvent): void {
    e.stopPropagation();
    if (this.voice.state() === 'listening') {
      this.voice.stopListening();
    } else if (this.voice.state() === 'idle') {
      this.voice.startListening();
    }
  }

  openGuide(e?: MouseEvent): void {
    e?.preventDefault();
    e?.stopPropagation();
    this.modalService.open(VoiceCommandsGuideModalComponent, {
      size: 'lg',
      centered: true,
      scrollable: true,
      backdrop: true,
    });
  }
}
