import {
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  NgZone,
  Output,
  OnDestroy,
  OnChanges,
  SimpleChanges,
  ViewChild,
  AfterViewInit,
  inject,
  signal,
  effect,
  ChangeDetectionStrategy
} from '@angular/core';
import { isPaneResizing } from '../pane-resize-flag';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Terminal, IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { attachUnicode11, attachWebglRenderer, clearTextureAtlasShared, readTerminalPerfPrefs } from '../../../../core/helper/xterm-renderer';
import { createFileLinkProvider } from '@core/helper/terminal-file-link-provider';
import { attachBangCommandRunner } from '@core/helper/terminal-bang-command-runner';
import { attachLinkCopier } from '@core/helper/terminal-link-copier';
import { attachOsc52Clipboard } from '@core/helper/terminal-osc52-clipboard';
import { SessionService } from '../services/session.service';
import { ProviderLimitService } from '../services/provider-limit.service';
import { SessionModelService } from '../services/session-model.service';
import { SessionHistoryService } from '../services/session-history.service';
import { SessionAssetsService } from '../services/session-assets.service';
import { UiPreferencesService } from '@core/services/ui-preferences.service';
import { SubAgentService } from '../services/sub-agent.service';
import { PtyDimsRegistry } from '../services/pty-dims-registry.service';
import { TerminalCommandGuard } from '../services/terminal-command-guard';
import { createTerminalLinkHandler, joinWrappedUrl, openTerminalLink } from '@core/helper/terminal-link-handler';
import { decideTerminalClipboardAction } from '@core/helper/terminal-clipboard';
import { decideTerminalMacLineKey } from '@core/helper/terminal-mac-line-keys';
import { TerminalReplayStream, TerminalReplayChunk } from '@core/helper/terminal-replay-stream';
import { readClipboardImageAsFile } from '@core/helper/terminal-clipboard-image';
import { buildTerminalOptions, watchTerminalAppearance } from '@core/helper/terminal-appearance';
import { createTerminalWriteBatcher, TerminalWriteBatcher } from '@core/helper/terminal-write-batcher';
import { TerminalAssistComponent } from '../terminal-assist/terminal-assist.component';

/**
 * The outgoing terminal during a double-buffered swap: unsubscribed from the
 * live stream (it must not paint anymore) but still on screen, so the user
 * keeps looking at the previous frame instead of a black panel.
 */
interface DetachedTerminal {
  xterm: Terminal;
  fileLinkProvider: IDisposable | null;
  unsubPaste: (() => void) | null;
}

/**
 * Single-session terminal panel.
 * Reacts to sessionId input changes via OnChanges — tears down the old
 * terminal and initializes a new one bound to the incoming session.
 * No page reload required for session switching.
 */
@Component({
  selector: 'app-session-terminal',
  standalone: true,
  imports: [TranslateModule, TerminalAssistComponent],
  template: `
    <!-- [Tauri] Double-buffered slots: a switch/wake builds the new xterm in the
         back slot and only swaps once its replay is painted, so the previous
         frame stays on screen instead of a black flash. Without Tauri only slot A
         is used (the back slot stays empty and invisible). -->
    <div #slotA class="terminal-container" [class.term-back]="visibleSlot() !== 'a'"
         (contextmenu)="onContextMenu($event)"></div>
    <div #slotB class="terminal-container" [class.term-back]="visibleSlot() !== 'b'"
         (contextmenu)="onContextMenu($event)"></div>
    <!-- ↓ new output + find in output, above the visible slot. -->
    <app-terminal-assist #assist />
    <!-- Resume overlay: after a wake the provider TUI is still booting with
         --resume/--continue — this veil hides the boot garbage and blocks
         input until the resumed conversation is actually painted. Same look
         as the sub-agent spawn overlay. On Tauri the boot garbage lands in the
         hidden back slot, so the veil is translucent: the parked frame stays
         readable underneath while the session resumes. -->
    @if (resuming() || switching()) {
      <div class="spawn-overlay" [class.soft]="doubleBuffer && !switching()">
        <div class="spawn-box">
          <span class="spawn-spinner">{{ spinnerFrames[spinnerFrame()] }}</span>
          <pre class="spawn-brand">promptops</pre>
        </div>
      </div>
    }
    @if (contextMenu(); as menu) {
      <div class="ctx-menu" [style.left.px]="menu.x" [style.top.px]="menu.y">
        @if (menu.link) {
          <button class="ctx-item" (click)="copyLink(menu.link)">
            <i class="ti ti-link"></i> {{ 'TERMINAL.Copy link' | translate }}
          </button>
          <button class="ctx-item" (click)="openLink(menu.link)">
            <i class="ti ti-external-link"></i> {{ 'TERMINAL.Open link' | translate }}
          </button>
        }
        <button class="ctx-item" (click)="copySelection()">
          <i class="ti ti-copy"></i> {{ 'TERMINAL.Copy' | translate }}
        </button>
        <button class="ctx-item" (click)="pasteClipboard()">
          <i class="ti ti-clipboard"></i> {{ 'TERMINAL.Paste' | translate }}
        </button>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
      background: #10121a;
    }
    .spawn-overlay {
      position: absolute;
      inset: 0;
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: center;
      background:
        radial-gradient(120% 90% at 50% 45%, rgba(99, 102, 241, 0.10) 0%, transparent 60%),
        rgba(6, 7, 12, 0.94);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
      cursor: wait;
    }
    /* [Tauri] Snapshot-first: let the previous frame show through the veil. */
    .spawn-overlay.soft {
      background:
        radial-gradient(120% 90% at 50% 45%, rgba(99, 102, 241, 0.10) 0%, transparent 60%),
        rgba(6, 7, 12, 0.55);
    }
    .spawn-box {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      user-select: none;
    }
    .spawn-spinner {
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
      font-size: 26px;
      line-height: 1;
      color: #a5b4fc;
      text-shadow: 0 0 12px rgba(99, 102, 241, 0.55);
    }
    .spawn-brand {
      margin: 0;
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
      font-size: 13px;
      letter-spacing: 4px;
      text-transform: lowercase;
      color: rgba(165, 180, 252, 0.85);
    }
    .terminal-container {
      position: absolute;
      inset: 0;
      overflow: hidden;
      padding: 10px 4px 6px 12px;
      z-index: 2;
      opacity: 1;
      background:
        radial-gradient(120% 90% at 50% 0%, rgba(99, 102, 241, 0.05) 0%, transparent 55%),
        #10121a;
    }
    /* Back slot: laid out (so fit() measures the real size) but invisible and
       click-through until it is promoted by commitSwap(). */
    .terminal-container.term-back {
      z-index: 1;
      opacity: 0;
      pointer-events: none;
    }
    /* xterm DOM is created at runtime → needs ::ng-deep to pierce scoping */
    :host ::ng-deep .xterm-viewport {
      background: transparent !important;
      scrollbar-width: thin;
      scrollbar-color: rgba(99, 102, 241, 0.35) transparent;
    }
    :host ::ng-deep .xterm-viewport::-webkit-scrollbar {
      width: 8px;
    }
    :host ::ng-deep .xterm-viewport::-webkit-scrollbar-track {
      background: transparent;
    }
    :host ::ng-deep .xterm-viewport::-webkit-scrollbar-thumb {
      background: rgba(99, 102, 241, 0.28);
      border-radius: 4px;
    }
    :host ::ng-deep .xterm-viewport::-webkit-scrollbar-thumb:hover {
      background: rgba(99, 102, 241, 0.5);
    }
    .ctx-menu {
      position: fixed;
      z-index: 10000;
      min-width: 150px;
      background: rgba(23, 24, 36, 0.92);
      backdrop-filter: blur(14px) saturate(1.4);
      -webkit-backdrop-filter: blur(14px) saturate(1.4);
      border: 1px solid rgba(99, 102, 241, 0.25);
      border-radius: 10px;
      padding: 5px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.05);
    }
    .ctx-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 7px 12px;
      background: none;
      border: none;
      border-radius: 6px;
      color: #cdd6f4;
      font-size: 13px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.12s;
    }
    .ctx-item:hover {
      background: rgba(99, 102, 241, 0.22);
    }
  `,
})
export class SessionTerminalComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) sessionId!: string;
  @Input() workspacePath?: string | null;
  /** Emits a file path (no `:line` suffix) when the user clicks a CLI file link. */
  @Output() openFileRequest = new EventEmitter<string>();
  @ViewChild('slotA', { static: true }) slotARef!: ElementRef<HTMLDivElement>;
  @ViewChild('slotB', { static: true }) slotBRef!: ElementRef<HTMLDivElement>;
  @ViewChild('assist', { static: true }) assist!: TerminalAssistComponent;

  /** Slot receiving live output; visibility changes only when replay commits. */
  activeSlot = signal<'a' | 'b'>('a');
  visibleSlot = signal<'a' | 'b'>('a');

  /** Container the live xterm is attached to (or is being built into). */
  private get containerEl(): HTMLDivElement {
    return (this.activeSlot() === 'a' ? this.slotARef : this.slotBRef).nativeElement;
  }

  private sessionService = inject(SessionService);
  private translate = inject(TranslateService);
  private sessionModels = inject(SessionModelService);
  private providerLimit = inject(ProviderLimitService);
  private zone = inject(NgZone);
  private historyService = inject(SessionHistoryService);
  private assetsService = inject(SessionAssetsService);
  private uiPrefs = inject(UiPreferencesService);
  private subAgentService = inject(SubAgentService);
  private guard = new TerminalCommandGuard();
  private xterm: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private fileLinkProvider: IDisposable | null = null;
  /** ▶ on Claude's `! <command>` lines (Claude provider only). */
  private bangRunner: IDisposable | null = null;
  private linkCopier: IDisposable | null = null;
  contextMenu = signal<{ x: number; y: number; link?: string | null } | null>(null);

  /** Braille spinner frames for the resume overlay (same as sub-agent spawn). */
  readonly spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  spinnerFrame = signal(0);
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  /** True from wake-respawn until the resumed provider TUI settles. */
  resuming = signal(false);
  /**
   * In-place provider switch of THIS session (limit modal → Rust
   * `session_switch_provider`): veil + stdin lock from `started` to
   * `ready`/`error`, independent of the resume quiet-timer — the exit/relaunch
   * phases have long quiet gaps that would drop the resume veil early.
   */
  switching = signal(false);
  private switchVeil = effect(() => {
    const on = this.providerLimit.isSwitchingSession(this.sessionId);
    if (on === this.switching()) return;
    this.switching.set(on);
    if (on) {
      if (this.spinnerTimer === null) {
        this.spinnerTimer = setInterval(
          () => this.spinnerFrame.update(f => (f + 1) % this.spinnerFrames.length),
          90,
        );
      }
      if (this.xterm) this.xterm.options.disableStdin = true;
    } else if (!this.resuming()) {
      if (this.spinnerTimer !== null) { clearInterval(this.spinnerTimer); this.spinnerTimer = null; }
      if (this.xterm) { this.xterm.options.disableStdin = false; this.xterm.focus(); }
    }
  });
  /** Quiet-period debounce: live output stopped = resume painted. */
  private resumeQuietTimer: ReturnType<typeof setTimeout> | null = null;
  /** Safety valve: never leave the veil up if the provider emits nothing. */
  private resumeCapTimer: ReturnType<typeof setTimeout> | null = null;

  @HostListener('document:click')
  closeContextMenu(): void { this.contextMenu.set(null); }

  private getWorkspacePath(): string | undefined {
    return this.workspacePath ?? undefined;
  }

  onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenu.set({ x: event.clientX, y: event.clientY, link: this.hoveredLink });
  }

  /** OSC 8 link under the mouse (full URL, even if it's split on screen). */
  private hoveredLink: string | null = null;

  async copyLink(uri: string): Promise<void> {
    await this.writeClipboard(uri);
    this.contextMenu.set(null);
    this.xterm?.focus();
  }

  openLink(uri: string): void {
    openTerminalLink(new MouseEvent('click'), uri);
    this.contextMenu.set(null);
  }

  async copySelection(): Promise<void> {
    const text = this.xterm?.getSelection();
    if (text) await this.writeClipboard(joinWrappedUrl(text));
    this.contextMenu.set(null);
    this.xterm?.focus();
  }

  async pasteClipboard(): Promise<void> {
    const isTauri = this.sessionService.isTauri;
    // Non-Tauri hosts: navigator.clipboard.read() sees native images, so the
    // asset upload is tried first. Tauri/WKWebView doesn't, and that call
    // would show the system "Allow Paste" prompt (see
    // readClipboard): there the text is read first via IPC and the image is tried
    // only if the clipboard has no text — same criterion as
    // session-view.component.ts#onSaPaste.
    if (!isTauri && (await this.tryPasteAsAsset())) {
      this.contextMenu.set(null);
      this.xterm?.focus();
      return;
    }
    const text = await this.readClipboard();
    if (!text) {
      if (isTauri && (await this.tryPasteImageFromNativeClipboard())) {
        this.contextMenu.set(null);
        this.xterm?.focus();
        return;
      }
      // Neither text nor image: without this line the failure is silent and it looks
      // like paste is broken.
      this.xterm?.write('\r\n\x1b[38;5;244m[PromptOps] Clipboard empty\x1b[0m\r\n');
    }
    if (text) {
      const wrapped = `\x1b[200~${text}\x1b[201~`;
      const result = this.guard.processOutbound(wrapped);
      if (result.forward) this.sessionService.writeSession(this.sessionId, result.forward);
      if (result.intercept) {
        const choice = await this.subAgentService.showSmartActionModalForTerminal(
          this.sessionId,
          result.intercept.command,
          this.getWorkspacePath(),
          true,
        );
        if (choice === 'continue') {
          this.sessionService.writeSession(this.sessionId, result.intercept.command);
        }
      }
    }
    this.contextMenu.set(null);
    this.xterm?.focus();
  }

  /** If clipboard holds images/files, upload them to session assets. */
  private async tryPasteAsAsset(): Promise<boolean> {
    if (!this.workspacePath) return false;
    try {
      const items = await (navigator.clipboard as any).read?.();
      if (!items || !items.length) return false;
      const files: File[] = [];
      for (const item of items as any[]) {
        for (const type of item.types as string[]) {
          if (!type.startsWith('image/')) continue;
          const blob = await item.getType(type);
          const ext = (type.split('/')[1] || 'png').split('+')[0];
          files.push(new File([blob], `pasted-${Date.now()}.${ext}`, { type }));
        }
      }
      if (files.length === 0) return false;
      await this.uploadFilesToAssets(files);
      return true;
    } catch { return false; }
  }

  /**
   * Tauri variant of tryPasteAsAsset: WKWebView doesn't expose native images
   * to navigator.clipboard, so we go through the Rust command. Same pattern as
   * session-view.component.ts#pasteImageFromNativeClipboard.
   */
  private async tryPasteImageFromNativeClipboard(): Promise<boolean> {
    if (!this.workspacePath) return false;
    const file = await readClipboardImageAsFile();
    if (!file) return false;
    await this.uploadFilesToAssets([file]);
    return true;
  }

  /**
   * Saves the files to the session assets and writes their relative paths into the
   * prompt: the CLI runs with its cwd on the workspace, so the path is directly
   * usable and the user doesn't have to go look for it in the ASSETS panel.
   * We generate the path ourselves, so it bypasses the TerminalCommandGuard.
   */
  private async uploadFilesToAssets(files: File[]): Promise<void> {
    const ws = this.workspacePath;
    if (!ws) return;
    try {
      const uploaded = await this.assetsService.uploadFiles(ws, files);
      const paths = uploaded.map(a => a.relativePath).join(' ');
      if (paths) {
        this.sessionService.writeSession(this.sessionId, `\x1b[200~${paths}\x1b[201~`);
      }
    } catch {
      this.xterm?.write(`\r\n\x1b[31m[PromptOps] Asset upload failed\x1b[0m\r\n`);
    }
  }

  /** Write clipboard with IPC fallback (Windows app:// may block navigator.clipboard). */
  private async writeClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      await this.sessionService.clipboardWrite(text);
    }
  }

  private async readClipboard(): Promise<string> {
    // Tauri: native IPC first — in WKWebView navigator.clipboard.readText
    // opens the system "Allow Paste" prompt or returns normalized text.
    if (!this.sessionService.isTauri) {
      try {
        const t = await navigator.clipboard.readText();
        if (t) return t;
      } catch { /* fall through to IPC */ }
    }
    try {
      const res = await this.sessionService.clipboardRead();
      return res?.text ?? '';
    } catch { return ''; }
  }
  private resizeObserver: ResizeObserver | null = null;
  private unsubOutput: (() => void) | null = null;
  /** Live output coalesced per frame (see terminal-write-batcher). */
  private writeBatcher: TerminalWriteBatcher | null = null;
  /** Font/size/line height applied live from settings. */
  private unwatchAppearance: (() => void) | null = null;
  /** The terminal font was already re-measured after document.fonts.ready. */
  private fontMeasured = false;
  /** Grid + DPR of the last settled repaint (skips no-op ones). */
  private lastSettledKey = '';
  private unsubPaste: (() => void) | null = null;
  private inputBuffer = '';
  /** Guards against stale async operations when session changes rapidly */
  private setupGeneration = 0;
  private initialized = false;
  /** Tracks whether xterm was opened while its container had 0 dimensions */
  private needsVisibilityRefresh = false;
  /** Debounce timer for PTY size notifications — coalesces drag/transition storms */
  private ptyResizeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSentCols = -1;
  private lastSentRows = -1;
  private dimsRegistry = inject(PtyDimsRegistry);

  // ── Double buffering (Tauri only) ────────────────────────
  /** The outgoing terminal, frozen on screen until the new one is painted. */
  private detached: DetachedTerminal | null = null;
  /** Safety valve: never leave a frozen frame on screen if the swap never commits. */
  private swapCapTimer: ReturnType<typeof setTimeout> | null = null;
  /** Generation the pending swap belongs to — a newer init supersedes it. */
  private swapGen = -1;

  /**
   * [Tauri] Build the incoming terminal in the hidden slot and keep the old
   * frame on screen until the replay is painted. Non-Tauri hosts use the plain
   * teardown-then-init flow.
   */
  get doubleBuffer(): boolean {
    return this.sessionService.isTauri;
  }
  /** True while the raw replay buffer is being parsed by xterm. Every fit()
   *  path holds off until it clears — a grid change mid-parse would garble
   *  the cursor-addressed replay content. */
  private replayInFlight = false;
  private replayGateTimer: ReturnType<typeof setTimeout> | null = null;
  private tuiRepaintTimer: ReturnType<typeof setTimeout> | null = null;
  /** At most one forced TUI repaint per terminal init. */
  private tuiRepaintDone = false;

  ngAfterViewInit(): void {
    this.initialized = true;
    void this.initTerminal();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['sessionId'] && !changes['sessionId'].firstChange && this.initialized) {
      console.debug(
        '[SessionTerminal] Session switch:',
        changes['sessionId'].previousValue, '→', changes['sessionId'].currentValue,
      );
      this.endResumeVeil();
      if (this.doubleBuffer) {
        this.detachCurrent();
      } else {
        this.teardown();
      }
      void this.initTerminal();
    }
  }

  /**
   * [Tauri] Freeze the live terminal on screen and hand the component over to
   * the empty slot: the incoming xterm is built there, invisible, and only
   * takes over in commitSwap() once its replay has painted.
   *
   * Everything that reacts to the outside world is torn down here (output
   * subscription, ResizeObserver, timers) — the frozen instance is a picture,
   * not a running terminal. Only its DOM survives, for a few hundred ms.
   */
  private detachCurrent(): void {
    const xterm = this.xterm;
    if (!xterm) { this.teardown(); return; }

    // A previous swap that never committed: its frame is stale now.
    this.disposeDetached();

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.unsubOutput?.();
    this.unsubOutput = null;
    this.disposeLiveExtras();
    if (this.ptyResizeTimer !== null) { clearTimeout(this.ptyResizeTimer); this.ptyResizeTimer = null; }
    if (this.settledRepaintTimer !== null) { clearTimeout(this.settledRepaintTimer); this.settledRepaintTimer = null; }
    if (this.replayGateTimer !== null) { clearTimeout(this.replayGateTimer); this.replayGateTimer = null; }
    if (this.tuiRepaintTimer !== null) { clearTimeout(this.tuiRepaintTimer); this.tuiRepaintTimer = null; }

    xterm.options.disableStdin = true;
    this.bangRunner?.dispose();
    this.bangRunner = null;
    this.linkCopier?.dispose();
    this.linkCopier = null;
    this.detached = {
      xterm,
      fileLinkProvider: this.fileLinkProvider,
      unsubPaste: this.unsubPaste,
    };

    this.xterm = null;
    this.fitAddon = null;
    this.fileLinkProvider = null;
    this.unsubPaste = null;
    this.replayInFlight = false;
    this.tuiRepaintDone = false;
    this.lastSentCols = -1;
    this.lastSentRows = -1;
    this.inputBuffer = '';
    this.needsVisibilityRefresh = false;

    // The incoming terminal builds into the other slot.
    this.activeSlot.update(s => (s === 'a' ? 'b' : 'a'));
  }

  /**
   * Promote the freshly painted slot and drop the frozen frame. Idempotent and
   * generation-guarded: a swap superseded by a newer init never fires.
   */
  private commitSwap(gen: number): void {
    if (!this.detached || gen !== this.swapGen || gen !== this.setupGeneration) return;
    this.swapGen = -1;
    if (this.swapCapTimer !== null) { clearTimeout(this.swapCapTimer); this.swapCapTimer = null; }
    // Commit visibility only after parsing. Dispose synchronously so a rapid
    // A → B → A switch cannot reopen a slot still holding an old xterm.
    this.visibleSlot.set(this.activeSlot());
    const outgoing = this.detached;
    this.detached = null;
    this.disposeDetachedInstance(outgoing);
  }

  /** Batcher, appearance watcher and overlay bound to the live xterm. */
  private disposeLiveExtras(): void {
    this.writeBatcher?.flush();
    this.writeBatcher?.dispose();
    this.writeBatcher = null;
    this.unwatchAppearance?.();
    this.unwatchAppearance = null;
    this.assist?.detach();
    this.fontMeasured = false;
    this.lastSettledKey = '';
  }

  private disposeDetached(): void {
    const d = this.detached;
    this.detached = null;
    if (this.swapCapTimer !== null) { clearTimeout(this.swapCapTimer); this.swapCapTimer = null; }
    this.swapGen = -1;
    if (d) this.disposeDetachedInstance(d);
  }

  private disposeDetachedInstance(d: DetachedTerminal): void {
    d.unsubPaste?.();
    d.fileLinkProvider?.dispose();
    d.xterm.dispose();
  }

  /**
   * [Tauri] Full re-attach after a wake respawned the PTY: same path as a
   * session switch (fresh xterm, early-subscribe, buffer replay on the new
   * PTY, refit + forced TUI repaint). Called by the view on wakeSessionSuccess
   * — ngOnChanges can't fire because the sessionId didn't change.
   */
  resyncAfterWake(): void {
    if (!this.initialized) return;
    if (this.doubleBuffer) {
      // Snapshot-first: the parked frame stays on screen (under a translucent
      // veil) while the respawned PTY boots into the hidden slot.
      this.detachCurrent();
    } else {
      this.teardown();
    }
    this.beginResumeVeil();
    void this.initTerminal();
  }

  /**
   * Show the resume overlay + lock stdin. Cleared when live PTY output goes
   * quiet for a beat (the resumed TUI finished painting) or by the hard cap.
   */
  private beginResumeVeil(): void {
    this.resuming.set(true);
    if (this.spinnerTimer === null) {
      this.spinnerTimer = setInterval(
        () => this.spinnerFrame.update(f => (f + 1) % this.spinnerFrames.length),
        90,
      );
    }
    if (this.resumeCapTimer !== null) clearTimeout(this.resumeCapTimer);
    this.resumeCapTimer = setTimeout(() => this.endResumeVeil(), 20_000);
  }

  private endResumeVeil(): void {
    if (this.resumeQuietTimer !== null) { clearTimeout(this.resumeQuietTimer); this.resumeQuietTimer = null; }
    if (this.resumeCapTimer !== null) { clearTimeout(this.resumeCapTimer); this.resumeCapTimer = null; }
    if (this.spinnerTimer !== null) { clearInterval(this.spinnerTimer); this.spinnerTimer = null; }
    if (!this.resuming()) return;
    this.resuming.set(false);
    if (this.xterm) {
      this.xterm.options.disableStdin = false;
      this.xterm.focus();
    }
  }

  /**
   * Live PTY chunk arrived while the veil is up: (re)arm the quiet-period
   * timer — once the boot/repaint burst stops, the resume is applied.
   */
  private noteLiveOutputForResume(): void {
    if (!this.resuming()) return;
    if (this.resumeQuietTimer !== null) clearTimeout(this.resumeQuietTimer);
    this.resumeQuietTimer = setTimeout(() => this.endResumeVeil(), 500);
  }

  focus(): void {
    const gen = this.setupGeneration;
    setTimeout(() => {
      if (gen !== this.setupGeneration) return;
      if (this.replayInFlight) { this.xterm?.focus(); return; }
      if (this.containerEl.offsetWidth === 0 || this.containerEl.offsetHeight === 0) return;
      this.fitAddon?.fit();
      if (this.needsVisibilityRefresh) {
        this.needsVisibilityRefresh = false;
        this.xterm?.refresh(0, this.xterm.rows - 1);
      }
      this.schedulePtyResize();
      this.xterm?.focus();
    });
  }

  /**
   * Force a full re-render against the current container size.
   *
   * Used when returning to a session after the terminal was hidden:
   * fit() re-measures cols/rows, re-assigning fontFamily re-triggers
   * xterm's CharSizeService (recovers from a stale cell width if the
   * custom font loaded after open()), and refresh() repaints the buffer.
   * Idempotent — does not steal focus.
   */
  refit(): void {
    if (this.replayInFlight) return;
    const xterm = this.xterm;
    const fit = this.fitAddon;
    const el = this.containerEl;
    if (!xterm || !fit || !el) return;
    if (el.offsetWidth === 0 || el.offsetHeight === 0) return;
    fit.fit();
    // Re-measure the cell only until the real font has been measured: doing
    // it on every refit changed the cell for one frame (the jump after a switch).
    if (!this.fontMeasured) {
      const ff = xterm.options.fontFamily;
      if (ff) xterm.options.fontFamily = ff;
      fit.fit();
      if (document.fonts?.status === 'loaded') this.fontMeasured = true;
    }
    xterm.refresh(0, xterm.rows - 1);
    this.schedulePtyResize();
  }

  /**
   * Repaint once the resize is done. fit() during a resize changes the grid but the
   * renderer (WebGL especially) can keep the atlas/canvas of the previous
   * frame: the text looks "stretched" to the old size (typical
   * when the pane grid suddenly changes columns). When the container
   * stops moving: refit, regenerated atlas, full repaint.
   */
  private settledRepaintTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleSettledRepaint(): void {
    if (this.settledRepaintTimer !== null) clearTimeout(this.settledRepaintTimer);
    this.settledRepaintTimer = setTimeout(() => {
      this.settledRepaintTimer = null;
      const xterm = this.xterm;
      const el = this.containerEl;
      if (this.replayInFlight || !xterm || !this.fitAddon || !el) return;
      if (el.offsetWidth === 0 || el.offsetHeight === 0) return;
      this.fitAddon.fit();
      // The atlas is shared: clearing it redraws the glyphs of EVERY pane.
      // Only when the grid or the DPR actually changed since the last repaint.
      const key = `${xterm.cols}x${xterm.rows}@${window.devicePixelRatio}`;
      if (key !== this.lastSettledKey) {
        this.lastSettledKey = key;
        clearTextureAtlasShared(xterm);
        xterm.refresh(0, xterm.rows - 1);
      }
      this.schedulePtyResize();
    }, 180);
  }

  /**
   * Trailing-edge debounce for PTY ioctl(TIOCSWINSZ).
   * The ResizeObserver can fire 60+ times during a splitter drag or a CSS
   * width transition; each ioctl raises SIGWINCH, which makes TUIs (Claude
   * Code, bash prompt, vim) redraw at intermediate sizes and leaves residue
   * frames in the xterm buffer. We let xterm.fit() run on every observer
   * tick (so the canvas keeps up visually) but only push the final size to
   * the PTY once the user stops resizing.
   */
  private schedulePtyResize(): void {
    if (this.ptyResizeTimer !== null) clearTimeout(this.ptyResizeTimer);
    const sessionId = this.sessionId;
    this.ptyResizeTimer = setTimeout(() => {
      this.ptyResizeTimer = null;
      const xterm = this.xterm;
      if (!xterm) return;
      const cols = xterm.cols;
      const rows = xterm.rows;
      if (cols < 2 || rows < 2) return;
      if (cols === this.lastSentCols && rows === this.lastSentRows) return;
      this.lastSentCols = cols;
      this.lastSentRows = rows;
      this.dimsRegistry.set(`session:${sessionId}`, cols, rows);
      this.sessionService.resizeSession(sessionId, cols, rows);
    }, 120);
  }

  /**
   * Write the raw replay buffer at the PTY's own grid size, then re-fit and
   * (when nothing changed) bounce the PTY so the TUI repaints. Mirror of
   * SubAgentTerminalComponent.writeReplay() — see that for the rationale.
   * Guarded by `gen` instead of a disposed flag (this component re-inits in
   * place on session switch).
   */
  private writeReplay(gen: number, sessionId: string, buffer: string): void {
    if (!this.xterm) return;
    const known = this.dimsRegistry.get(`session:${sessionId}`);
    this.replayInFlight = true;
    if (this.ptyResizeTimer !== null) {
      clearTimeout(this.ptyResizeTimer);
      this.ptyResizeTimer = null;
    }
    if (known && (known.cols !== this.xterm.cols || known.rows !== this.xterm.rows)) {
      this.xterm.resize(known.cols, known.rows);
    }
    // Safety valve: never leave the fit gate stuck if the write callback is
    // lost (e.g. terminal disposed mid-parse).
    if (this.replayGateTimer !== null) clearTimeout(this.replayGateTimer);
    this.replayGateTimer = setTimeout(() => this.finishReplay(gen, sessionId, !!known), 10_000);
    this.xterm.write(buffer, () => this.finishReplay(gen, sessionId, !!known));
  }

  private finishReplay(gen: number, sessionId: string, hadKnownDims: boolean): void {
    if (gen !== this.setupGeneration || !this.xterm || !this.replayInFlight) return;
    this.replayInFlight = false;
    // The incoming terminal now shows the same content the frozen frame does:
    // swap before the refit below, so the resize happens on the visible slot.
    this.commitSwap(gen);
    if (this.replayGateTimer !== null) {
      clearTimeout(this.replayGateTimer);
      this.replayGateTimer = null;
    }

    const replayCols = this.xterm.cols;
    const replayRows = this.xterm.rows;
    // Re-fit to the container + font re-measure + full refresh + PTY notify
    // (no-op while the container is hidden — the ResizeObserver picks it up).
    this.refit();

    // If the grid changed, refit() just queued a REAL size change → SIGWINCH
    // → the TUI repaints itself. A same-size resize never signals, so when
    // nothing changed (or we replayed blind) the TUI must be bounced.
    const dimsUnchanged = this.xterm.cols === replayCols && this.xterm.rows === replayRows;
    if ((dimsUnchanged || !hadKnownDims)
        && !(window as unknown as Record<string, unknown>)['__PO_SAFE_TERMINAL__']) {
      if (this.tuiRepaintTimer !== null) clearTimeout(this.tuiRepaintTimer);
      this.tuiRepaintTimer = setTimeout(() => void this.forceTuiRepaint(gen, sessionId), 300);
    }
  }

  /**
   * Force the running TUI to repaint by bouncing the PTY one row smaller and
   * back — the automated equivalent of the user's manual splitter drag, kept
   * in lockstep with the xterm grid so the intermediate frame renders clean.
   * A resize on a dead/standby PTY fails silently on the native side — harmless.
   */
  private async forceTuiRepaint(gen: number, sessionId: string): Promise<void> {
    this.tuiRepaintTimer = null;
    if (gen !== this.setupGeneration || this.replayInFlight || this.tuiRepaintDone) return;
    if (!this.xterm) return;
    const cols = this.xterm.cols;
    const rows = this.xterm.rows;
    if (cols < 2 || rows < 3) return;
    this.tuiRepaintDone = true;
    this.writeBatcher?.flush();

    // Step down one row, PTY in lockstep (bypasses the debounce on purpose).
    this.xterm.resize(cols, rows - 1);
    this.lastSentCols = cols;
    this.lastSentRows = rows - 1;
    await this.sessionService.resizeSession(sessionId, cols, rows - 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    if (gen !== this.setupGeneration || !this.xterm) return;

    // Step back to the container-fitted grid.
    const el = this.containerEl;
    if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
      this.fitAddon?.fit();
    } else {
      this.xterm.resize(cols, rows);
    }
    this.lastSentCols = this.xterm.cols;
    this.lastSentRows = this.xterm.rows;
    this.dimsRegistry.set(`session:${sessionId}`, this.xterm.cols, this.xterm.rows);
    await this.sessionService.resizeSession(sessionId, this.xterm.cols, this.xterm.rows);
  }

  ngOnDestroy(): void {
    this.setupGeneration++;
    this.endResumeVeil();
    this.disposeDetached();
    this.teardown();
  }

  // ── Private ──────────────────────────────────────────────

  private async initTerminal(): Promise<void> {
    const gen = ++this.setupGeneration;
    const sessionId = this.sessionId;

    // A frozen frame is on screen: this init owns the swap. Cap it so a failed
    // buffer fetch (or a session with no buffer at all) can't leave the old
    // picture up forever.
    if (this.detached) {
      this.swapGen = gen;
      if (this.swapCapTimer !== null) clearTimeout(this.swapCapTimer);
      this.swapCapTimer = setTimeout(() => this.commitSwap(gen), 1_500);
    }


    // Terminal performance toggles (default on) — see app settings.
    const perf = readTerminalPerfPrefs();

    // Open straight at the PTY's own grid when we know it: the replay then
    // lands already wrapped correctly and the user never sees the 80×24
    // default reflow into the real size.
    const knownDims = this.dimsRegistry.get(`session:${sessionId}`);

    // Create xterm instance
    // Font, palette, scrollback and scrolling: shared with sub-agents.
    this.xterm = new Terminal({
      ...buildTerminalOptions(),
      // Clicks on OSC 8 links (full URLs) → browser; Option+drag
      // selects even when the TUI captures the mouse (Claude fullscreen).
      linkHandler: createTerminalLinkHandler((uri) => { this.hoveredLink = uri; }),
      macOptionClickForcesSelection: true,
      ...(knownDims ? { cols: knownDims.cols, rows: knownDims.rows } : {}),
      cursorBlink: perf.cursorBlink,
    });
    // Wake in flight: keep the boot screen untypeable until the resume lands.
    if (this.resuming()) this.xterm.options.disableStdin = true;

    this.fitAddon = new FitAddon();
    this.xterm.loadAddon(this.fitAddon);
    // CLI copies via OSC 52 (remote hosts: no pbcopy) → local clipboard.
    attachOsc52Clipboard(this.xterm, (text) => this.writeClipboard(text));
    attachUnicode11(this.xterm);
    if (perf.links) this.xterm.loadAddon(new WebLinksAddon(openTerminalLink));
    const el = this.containerEl;
    this.xterm.open(el);
    // Cmd/Ctrl+C from the app menu: a URL split by the TUI over several lines is
    // copied joined back together (same treatment as the context menu).
    if (!el.dataset['poJoinCopy']) {
      el.dataset['poJoinCopy'] = '1';
      el.addEventListener('copy', (ev: ClipboardEvent) => {
        const sel = this.xterm?.getSelection();
        if (!sel || !ev.clipboardData) return;
        const joined = joinWrappedUrl(sel);
        if (joined === sel) return;
        ev.clipboardData.setData('text/plain', joined);
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }, true);
    }
    if (perf.gpu) attachWebglRenderer(this.xterm);
    this.assist?.attach(this.xterm);
    this.unwatchAppearance = watchTerminalAppearance(this.xterm, () => {
      this.fontMeasured = false;
      this.refit();
    });
    // With known dims the grid is already right for the replay — fitting here
    // would only bounce it to the container size and back (writeReplay resets
    // it), and finishReplay() re-fits for real once the buffer is painted.
    if (!knownDims) this.fitAddon.fit();

    // CLI file links → open in the integrated code editor. Runs inside the
    // Angular zone so the parent's openFile handler triggers change detection.
    if (perf.links) {
      this.fileLinkProvider = this.xterm.registerLinkProvider(
        createFileLinkProvider(this.xterm, (filePath) =>
          this.zone.run(() => this.openFileRequest.emit(filePath)),
        ),
      );
    }

    this.bangRunner = attachBangCommandRunner(this.xterm, {
      isEnabled: () => this.providerLimit.sessionProvider(sessionId) === 'claude-code-cli',
      runLabel: (command) => this.translate.instant('TERMINAL_HELPERS.Run command', { command }),
      write: (data) => this.sessionService.writeSession(sessionId, data),
    });
    // Long links split by the TUI (e.g. `/login` URLs): Copy button with
    // the full reconstructed URL.
    this.linkCopier = attachLinkCopier(this.xterm, {
      isEnabled: () => true,
      copy: (text) => this.writeClipboard(text),
      labels: {
        copy: this.translate.instant('TERMINAL_HELPERS.Copy'),
        copied: this.translate.instant('TERMINAL_HELPERS.Copied'),
        copyLink: this.translate.instant('TERMINAL_HELPERS.Copy link'),
      },
    });

    // Clipboard shortcuts. On Windows/Linux xterm forwards Ctrl+C/V to the PTY
    // (SIGINT / raw ^V), so copy/paste never happen. decideTerminalClipboardAction
    // adds Ctrl/Cmd+Shift+C/V and Ctrl/Shift+Insert on all platforms, plus plain
    // Ctrl+C (copy only with a selection, else SIGINT) and Ctrl+V on Windows/Linux.
    // macOS keeps Cmd via the app menu; plain Ctrl stays SIGINT/raw there.
    // Under Tauri (WKWebView) plain Cmd+C/V is handled too: the native one
    // copies/pastes the DOM row-by-row, injecting a newline at every visual
    // wrap. preventDefault() stops WKWebView from also running its own paste.
    const metaClipboard = this.sessionService.isTauri;
    this.xterm.attachCustomKeyEventHandler((ev) => {
      if (gen !== this.setupGeneration) return false;
      if (ev.type !== 'keydown') return true;
      if (TerminalAssistComponent.isSearchShortcut(ev, (window as any).promptops?.platform)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        this.assist?.openSearch();
        return false;
      }
      const action = decideTerminalClipboardAction(
        ev,
        (window as any).promptops?.platform,
        () => !!this.xterm?.getSelection(),
        metaClipboard,
      );
      if (action && metaClipboard) ev.preventDefault();
      if (action === 'copy') { void this.copySelection(); return false; }
      if (action === 'paste') { void this.pasteClipboard(); return false; }
      // Shift+Enter → insert a newline instead of submitting. xterm maps both
      // Enter and Shift+Enter to \r, so the provider sees a submit. ESC+CR is
      // the sequence Claude Code (and Option+Enter) reads as "newline, no submit".
      // Cmd as line modifier (macOS): Cmd+←/→ → Ctrl+A/E, Cmd+Backspace → Ctrl+U.
      // xterm drops Cmd+arrow, so without this nothing would reach the PTY.
      const seq = decideTerminalMacLineKey(ev, (window as any).promptops?.platform);
      if (seq) {
        ev.preventDefault();
        this.sessionService.writeSession(sessionId, seq);
        return false;
      }
      const ctrl = ev.ctrlKey || ev.metaKey;
      if (ev.shiftKey && !ctrl && !ev.altKey && (ev.key === 'Enter' || ev.code === 'Enter')) {
        // Insert a newline instead of submitting. preventDefault() is required:
        // returning false alone lets xterm's hidden textarea still emit the
        // Enter as \r (which submits). Ctrl+J (\n) is the universal newline.
        ev.preventDefault();
        this.sessionService.writeSession(sessionId, '\n');
        return false;
      }
      return true;
    });

    // Intercept native paste: if clipboard carries files/images, upload them
    // to session assets instead of letting xterm paste them as garbled text.
    const pasteHandler = async (ev: ClipboardEvent) => {
      if (gen !== this.setupGeneration) return;
      const dt = ev.clipboardData;
      if (!dt || !this.workspacePath) return;
      const files: File[] = [];
      if (dt.files && dt.files.length) {
        for (const f of Array.from(dt.files)) files.push(f);
      } else if (dt.items) {
        for (const item of Array.from(dt.items)) {
          if (item.kind === 'file') {
            const f = item.getAsFile();
            if (f) files.push(f);
          }
        }
      }
      if (files.length === 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      await this.uploadFilesToAssets(files);
    };
    el.addEventListener('paste', pasteHandler, true);
    this.unsubPaste = () => el.removeEventListener('paste', pasteHandler, true);

    // Track if container had 0 dimensions at open time (IDE right panel
    // collapsed or flex layout not yet computed). xterm's canvas renderer
    // initializes with 0×0 and needs a full refresh once visible.
    this.needsVisibilityRefresh = el.offsetWidth === 0 || el.offsetHeight === 0;

    // No jump to the bottom on focus: clicking to copy or read must not lose
    // the user's place. Typing (scrollOnUserInput) or the ↓ button go back down.

    // [Tauri v2] Subscribe BEFORE fetching the replay, queueing live chunks:
    // Reconcile queued AND future bytes against this renderer's snapshot
    // offset. Bridge-global dedup cannot remove chunks already queued here.
    // Non-Tauri hosts use the plain fetch-then-subscribe flow.
    const earlySubscribe = this.sessionService.isTauri;
    let replayDone = false;
    const queuedOutput: TerminalReplayChunk[] = [];
    const replayStream = new TerminalReplayStream();
    // Fit must wait for the snapshot fetch too, not just its parsing.
    this.replayInFlight = true;
    const batcher = createTerminalWriteBatcher(this.xterm, {
      element: () => el,
      runOutside: (fn) => this.zone.runOutsideAngular(fn),
      passthrough: !this.sessionService.isTauri,
    });
    this.writeBatcher = batcher;
    if (earlySubscribe) {
      this.unsubOutput = this.sessionService.onSessionOutput((event) => {
        if (event.sessionId !== sessionId) return;
        this.noteLiveOutputForResume();
        this.sessionModels.noteTerminalOutput(sessionId, event.data);
        this.providerLimit.sniffOutput(sessionId, null, event.data);
        if (!replayDone) {
          queuedOutput.push(event);
          return;
        }
        const data = replayStream.output(event);
        if (data) batcher.write(data);
      });
    }

    // Replay existing buffer so the terminal shows previous output
    let replayed = false;
    try {
      const result = await this.sessionService.getSessionBuffer(sessionId);
      if (gen !== this.setupGeneration) return; // Session changed while awaiting
      if (result.ok && result.data) {
        let replay = replayStream.snapshot(result);
        // Parse the queued suffix at the replay grid too. Otherwise the replay
        // callback can refit before these already-produced ANSI bytes are parsed.
        for (const chunk of queuedOutput) replay += replayStream.output(chunk);
        queuedOutput.length = 0;
        this.writeReplay(gen, sessionId, replay);
        replayed = true;
      }
    } catch {
      // No buffer yet (new session) — that's fine
    }
    if (gen !== this.setupGeneration) return;

    // Nothing to paint (fresh session): the frozen frame has no reason to stay
    // up. With a replay, finishReplay() commits once the buffer is on screen.
    if (!replayed) {
      this.replayInFlight = false;
      this.commitSwap(gen);
      this.refit();
    }

    // Capture xterm reference for closures (survives rapid session switches)
    const xterm = this.xterm;

    if (earlySubscribe) {
      replayDone = true;
      for (const chunk of queuedOutput) {
        const data = replayStream.output(chunk);
        if (data) batcher.write(data);
      }
      queuedOutput.length = 0;
    }

    // User types → send to session terminal + track prompts
    // Strip terminal auto-responses that xterm.js sends back (DA, CPR, DSR,
    // Focus In/Out). They may arrive concatenated in a single onData call.
    const TERM_RESPONSE_RE = /\x1b\[[\?>=]?[0-9;]*[cRnIO]/g;
    xterm.onData(async (data) => {
      if (gen !== this.setupGeneration) return;
      const cleaned = data.replace(TERM_RESPONSE_RE, '');
      if (!cleaned) return;

      const result = this.guard.processOutbound(cleaned);
      if (result.forward) {
        this.sessionService.writeSession(sessionId, result.forward);
      }

      if (result.intercept) {
        const choice = await this.subAgentService.showSmartActionModalForTerminal(
          sessionId,
          result.intercept.command,
          this.getWorkspacePath(),
          result.intercept.isPaste,
        );
        if (choice === 'continue') {
          this.sessionService.writeSession(
            sessionId,
            result.intercept.isPaste ? result.intercept.command : '\r',
          );
        }
      }

      if (data === '\x7f') {
        this.inputBuffer = this.inputBuffer.slice(0, -1);
      } else if (data.includes('\r') || data.includes('\n')) {
        // Enter pressed or pasted text containing a newline — flush buffer as prompt
        const full = (this.inputBuffer + data.replace(/[\r\n]+/g, '')).trim();
        if (full.length > 0) {
          this.historyService.logPrompt(full);
        }
        this.inputBuffer = '';
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.inputBuffer += data;
      } else if (data.length > 1 && !data.startsWith('\x1b')) {
        this.inputBuffer += data;
      }
    });

    // Session output → write to xterm (non-Tauri hosts: subscription starts
    // here, after the replay — the Tauri path subscribed earlier with queueing).
    if (!earlySubscribe) {
      this.unsubOutput = this.sessionService.onSessionOutput((event) => {
        if (event.sessionId === sessionId) {
          this.noteLiveOutputForResume();
          this.sessionModels.noteTerminalOutput(sessionId, event.data);
        this.providerLimit.sniffOutput(sessionId, null, event.data);
          batcher.write(event.data);
        }
      });
    }

    // Auto-resize — also handles visibility transitions (collapsed → visible).
    // fit() runs every tick so the canvas stays aligned with the container,
    // but the PTY ioctl is debounced via schedulePtyResize() to avoid the
    // SIGWINCH storm that scrambles TUI redraws during a splitter drag.
    this.resizeObserver = new ResizeObserver((entries) => {
      if (!this.xterm || !this.fitAddon) return;
      const rect = entries[0]?.contentRect;
      // Skip while container is collapsed/zero-sized — fit() with 0×0 would
      // push absurd cols/rows to the PTY and corrupt the running program.
      if (!rect || rect.width === 0 || rect.height === 0) {
        this.needsVisibilityRefresh = true;
        return;
      }
      if (this.replayInFlight) return;
      // Manual resize in progress: no fit on every frame, realign when the gesture ends.
      if (isPaneResizing()) { this.scheduleSettledRepaint(); return; }

      // Queued output was produced at the previous grid.
      this.writeBatcher?.flush();
      this.fitAddon.fit();

      // When transitioning from hidden (0 dimensions) to visible,
      // force a full xterm re-render so buffered content appears.
      if (this.needsVisibilityRefresh) {
        this.needsVisibilityRefresh = false;
        this.xterm.refresh(0, this.xterm.rows - 1);
      }

      this.schedulePtyResize();
      this.scheduleSettledRepaint();
    });
    this.resizeObserver.observe(el);

    // Trigger a resize to force shell/program to redraw, then focus
    setTimeout(() => {
      if (gen !== this.setupGeneration) return;
      if (this.replayInFlight) { this.xterm?.focus(); return; }
      // Re-check: container may have gained dimensions after a render cycle
      if (this.needsVisibilityRefresh && el.offsetWidth > 0 && el.offsetHeight > 0) {
        this.needsVisibilityRefresh = false;
        this.fitAddon?.fit();
        this.xterm?.refresh(0, this.xterm.rows - 1);
      }
      this.schedulePtyResize();
      this.xterm?.focus();
    }, 100);

    // Custom font (--po-terminal-font) may not be loaded when xterm opens.
    // xterm.open() measures the character cell ONCE against whatever font is
    // currently rendered (the fallback). After the custom face arrives the
    // measured cell width stays stuck — the wider glyphs of the real font
    // then overflow/squish inside the narrower cells. Reload-the-app fixes
    // it because the font is already cached on the second pass.
    //
    // Recovery: once fonts settle, re-assign options.fontFamily to itself.
    // That triggers xterm's CharSizeService to re-measure the cell against
    // the now-loaded font, then a fit() picks up the new metrics and we
    // notify the PTY of the resulting cols/rows.
    if ('fonts' in document) {
      document.fonts.ready.then(() => {
        if (gen !== this.setupGeneration || !this.xterm) return;
        if (this.replayInFlight) return; // finishReplay()'s refit() re-measures the font
        if (el.offsetWidth === 0 || el.offsetHeight === 0) return;
        const ff = this.xterm.options.fontFamily;
        if (ff) this.xterm.options.fontFamily = ff;
        this.fontMeasured = true;
        this.fitAddon?.fit();
        this.xterm.refresh(0, this.xterm.rows - 1);
        this.schedulePtyResize();
      }).catch(() => { /* fonts API unavailable */ });
    }

    this.initialized = true;
  }

  private teardown(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.settledRepaintTimer !== null) { clearTimeout(this.settledRepaintTimer); this.settledRepaintTimer = null; }
    if (this.ptyResizeTimer !== null) {
      clearTimeout(this.ptyResizeTimer);
      this.ptyResizeTimer = null;
    }
    if (this.replayGateTimer !== null) {
      clearTimeout(this.replayGateTimer);
      this.replayGateTimer = null;
    }
    if (this.tuiRepaintTimer !== null) {
      clearTimeout(this.tuiRepaintTimer);
      this.tuiRepaintTimer = null;
    }
    this.replayInFlight = false;
    this.tuiRepaintDone = false;
    this.lastSentCols = -1;
    this.lastSentRows = -1;
    this.unsubOutput?.();
    this.unsubOutput = null;
    this.disposeLiveExtras();
    this.unsubPaste?.();
    this.unsubPaste = null;
    this.fileLinkProvider?.dispose();
    this.fileLinkProvider = null;
    this.bangRunner?.dispose();
    this.bangRunner = null;
    this.linkCopier?.dispose();
    this.linkCopier = null;
    this.xterm?.dispose();
    this.xterm = null;
    this.fitAddon = null;
    this.inputBuffer = '';
    this.needsVisibilityRefresh = false;
  }
}
