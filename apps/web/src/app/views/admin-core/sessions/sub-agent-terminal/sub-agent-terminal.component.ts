import {
  Component,
  ElementRef,
  HostListener,
  Input,
  Output,
  EventEmitter,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
  AfterViewInit,
  inject,
  signal,
  computed,
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
import { SubAgentService } from '../services/sub-agent.service';
import { ProviderLimitService } from '../services/provider-limit.service';
import { SessionModelService } from '../services/session-model.service';
import { SessionService } from '../services/session.service';
import { SessionAssetsService } from '../services/session-assets.service';
import { readClipboardImageAsFile } from '@core/helper/terminal-clipboard-image';
import { PtyDimsRegistry } from '../services/pty-dims-registry.service';
import { TerminalCommandGuard } from '../services/terminal-command-guard';
import { createTerminalLinkHandler, joinWrappedUrl, openTerminalLink } from '@core/helper/terminal-link-handler';
import { decideTerminalClipboardAction } from '@core/helper/terminal-clipboard';
import { decideTerminalMacLineKey } from '@core/helper/terminal-mac-line-keys';
import { buildTerminalOptions, watchTerminalAppearance } from '@core/helper/terminal-appearance';
import { createTerminalWriteBatcher, TerminalWriteBatcher } from '@core/helper/terminal-write-batcher';
import { TerminalAssistComponent } from '../terminal-assist/terminal-assist.component';

/**
 * Terminal component for a sub-agent.
 * Similar to SessionTerminalComponent but uses sub-agent IPC channels
 * for I/O, buffer replay, and resize.
 */
@Component({
  selector: 'app-sub-agent-terminal',
  standalone: true,
  imports: [TranslateModule, TerminalAssistComponent],
  template: `
    <div #terminalContainer class="terminal-container" (contextmenu)="onContextMenu($event)"></div>
    <!-- ↓ new output + find in output. -->
    <app-terminal-assist #assist />
    <!-- Spawn overlay: while the provider TUI is still booting the prompt is not
         yet injected and the terminal is interactive — this black veil blocks
         input so the user can't type into the boot screen and clobber the paste. -->
    @if (isSpawning()) {
      <div class="spawn-overlay">
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
        radial-gradient(120% 90% at 50% 45%, rgba(168, 85, 247, 0.10) 0%, transparent 60%),
        rgba(6, 7, 12, 0.94);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
      cursor: wait;
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
      color: #c084fc;
      text-shadow: 0 0 12px rgba(168, 85, 247, 0.55);
    }
    .spawn-brand {
      margin: 0;
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
      font-size: 13px;
      letter-spacing: 4px;
      text-transform: lowercase;
      color: rgba(210, 168, 255, 0.85);
    }
    .terminal-container {
      width: 100%;
      height: 100%;
      overflow: hidden;
      padding: 8px 4px 6px 10px;
      background:
        radial-gradient(120% 90% at 50% 0%, rgba(168, 85, 247, 0.05) 0%, transparent 55%),
        #10121a;
    }
    /* xterm DOM is created at runtime → needs ::ng-deep to pierce scoping */
    :host ::ng-deep .xterm-viewport {
      background: transparent !important;
      scrollbar-width: thin;
      scrollbar-color: rgba(168, 85, 247, 0.35) transparent;
    }
    :host ::ng-deep .xterm-viewport::-webkit-scrollbar {
      width: 8px;
    }
    :host ::ng-deep .xterm-viewport::-webkit-scrollbar-track {
      background: transparent;
    }
    :host ::ng-deep .xterm-viewport::-webkit-scrollbar-thumb {
      background: rgba(168, 85, 247, 0.28);
      border-radius: 4px;
    }
    :host ::ng-deep .xterm-viewport::-webkit-scrollbar-thumb:hover {
      background: rgba(168, 85, 247, 0.5);
    }
    .ctx-menu {
      position: fixed;
      z-index: 10000;
      min-width: 150px;
      background: rgba(23, 24, 36, 0.92);
      backdrop-filter: blur(14px) saturate(1.4);
      -webkit-backdrop-filter: blur(14px) saturate(1.4);
      border: 1px solid rgba(168, 85, 247, 0.25);
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
      background: rgba(168, 85, 247, 0.22);
    }
  `,
})
export class SubAgentTerminalComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input({ required: true }) subAgentId!: string;
  /** When true, ESC key collapses the expansion instead of being sent to xterm */
  @Input() expanded = false;
  @Output() escapePressed = new EventEmitter<void>();
  /** Emits a file path (no `:line` suffix) when the user clicks a CLI file link. */
  @Output() openFileRequest = new EventEmitter<string>();
  @ViewChild('terminalContainer', { static: true }) containerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('assist', { static: true }) assist!: TerminalAssistComponent;

  private subAgentService = inject(SubAgentService);
  private translate = inject(TranslateService);
  private sessionModels = inject(SessionModelService);
  private providerLimit = inject(ProviderLimitService);
  private sessionService = inject(SessionService);
  private assetsService = inject(SessionAssetsService);
  private zone = inject(NgZone);
  private guard = new TerminalCommandGuard();
  private xterm!: Terminal;
  private fitAddon!: FitAddon;
  private fileLinkProvider: IDisposable | null = null;
  /** ▶ on Claude's `! <command>` lines (Claude provider only). */
  private bangRunner: IDisposable | null = null;
  private linkCopier: IDisposable | null = null;
  contextMenu = signal<{ x: number; y: number; link?: string | null } | null>(null);

  /** Braille spinner frames for the spawn overlay. */
  readonly spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  spinnerFrame = signal(0);
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * True from the moment the user spawns this sub-agent until its auto-prompt is
   * actually submitted (the `promptPending` flag). Drives the black
   * overlay + input lock so the still-booting provider TUI can't be typed into
   * before the pending paste lands — independent of session 'running' status,
   * which can flip early when the child PTY spawns fast.
   */
  isSpawning = computed(() =>
    !!this.subAgentService.activeSubAgents().find(a => a.id === this.subAgentId)?.promptPending,
  );

  // Lock stdin + animate the spinner only while spawning; release the moment the
  // prompt is injected (status flips to running / waiting_input / error).
  private spawnGuard = effect(() => {
    const spawning = this.isSpawning();
    if (this.xterm) {
      this.xterm.options.disableStdin = spawning;
      if (spawning) this.xterm.blur();
    }
    if (spawning && this.spinnerTimer === null) {
      this.spinnerTimer = setInterval(
        () => this.spinnerFrame.update(f => (f + 1) % this.spinnerFrames.length),
        90,
      );
    } else if (!spawning && this.spinnerTimer !== null) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  });

  @HostListener('document:click')
  closeContextMenu(): void { this.contextMenu.set(null); }

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
    const text = await this.readClipboard();
    // No text in the clipboard: under Tauri there may be an image, which
    // WKWebView doesn't expose to the DOM (see readClipboardImageAsFile). Text
    // first and then the image — same criterion as session-view#onSaPaste: a
    // text Cmd+V must not pick up a screenshot left in the clipboard.
    if (!text) {
      if (this.sessionService.isTauri && (await this.tryPasteImageAsAsset())) {
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
      if (result.forward) this.subAgentService.writeToSubAgent(this.subAgentId, result.forward);
      if (result.intercept) {
        const parentSessionId = this.getParentSessionId();
        if (!parentSessionId) {
          this.subAgentService.writeToSubAgent(this.subAgentId, result.intercept.command);
        } else {
          const choice = await this.subAgentService.showSmartActionModalForTerminal(
            parentSessionId,
            result.intercept.command,
            this.getWorkspacePath(),
            true,
          );
          if (choice === 'continue') {
            this.subAgentService.writeToSubAgent(this.subAgentId, result.intercept.command);
          }
        }
      }
    }
    this.contextMenu.set(null);
    this.xterm?.focus();
  }

  /**
   * Pasted screenshot: it goes into the session assets and its relative
   * path is written into the prompt, ready to send to the CLI (which runs with
   * its cwd on the workspace). Returns false if there's no image to paste.
   */
  private async tryPasteImageAsAsset(): Promise<boolean> {
    const ws = this.getWorkspacePath();
    const file = await readClipboardImageAsFile();
    if (!file) return false;
    if (!ws) {
      this.xterm?.write(
        '\r\n\x1b[31m[PromptOps] No workspace: image cannot be saved\x1b[0m\r\n',
      );
      return true; // handled: the paste must not continue on the text branch
    }
    try {
      const uploaded = await this.assetsService.uploadFiles(ws, [file]);
      const paths = uploaded.map((a) => a.relativePath).join(' ');
      if (!paths) return true;
      // Path generated by us: direct write, without going through the
      // TerminalCommandGuard (it's not a command typed by the user).
      this.subAgentService.writeToSubAgent(this.subAgentId, `\x1b[200~${paths}\x1b[201~`);
    } catch {
      this.xterm?.write('\r\n\x1b[31m[PromptOps] Asset upload failed\x1b[0m\r\n');
    }
    return true;
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
    // Tauri: native IPC first (see session-terminal.component.ts).
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
  private resizeObserver!: ResizeObserver;
  /** Observer used only before attach, for panes that start hidden. */
  private visibilityObserver: ResizeObserver | null = null;
  /** False until xterm is opened on the container: before then fit/focus
   *  would operate on a nonexistent renderer. */
  private attached = false;
  /** Live output coalesced per frame (see terminal-write-batcher). */
  private writeBatcher: TerminalWriteBatcher | null = null;
  /** Font/size/line height applied live from settings. */
  private unwatchAppearance: (() => void) | null = null;
  /** The terminal font was already re-measured after document.fonts.ready. */
  private fontMeasured = false;
  /** Grid + DPR of the last settled repaint (skips no-op ones). */
  private lastSettledKey = '';
  private unsubOutput: (() => void) | null = null;
  /** Tracks whether xterm was opened while its container had 0 dimensions */
  private needsVisibilityRefresh = false;
  /** Debounce timer for PTY size notifications — coalesces drag/transition storms */
  private ptyResizeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSentCols = -1;
  private lastSentRows = -1;
  private dimsRegistry = inject(PtyDimsRegistry);
  /** Set on destroy; async callbacks (buffer replay, forced repaint) must bail. */
  private disposed = false;
  /** True while the raw replay buffer is being parsed by xterm. Every fit()
   *  path holds off until it clears — a grid change mid-parse would garble
   *  the cursor-addressed replay content. */
  private replayInFlight = false;
  private replayGateTimer: ReturnType<typeof setTimeout> | null = null;
  private tuiRepaintTimer: ReturnType<typeof setTimeout> | null = null;
  /** At most one forced TUI repaint per component instance. */
  private tuiRepaintDone = false;

  private getParentSessionId(): string | undefined {
    return this.subAgentService.activeSubAgents().find(a => a.id === this.subAgentId)?.parentSessionId;
  }

  /**
   * The component has no workspace @Input: the path is already tracked by the
   * service for the current session (trackSession). Needed to save a pasted
   * image to the assets. Nothing changes for the smart-action guard:
   * it received `undefined` and fell back to this same value anyway.
   */
  private getWorkspacePath(): string | undefined {
    return this.subAgentService.workspacePath();
  }

  ngOnInit(): void {
    // Terminal performance toggles (default on) — see app settings.
    const perf = readTerminalPerfPrefs();
    // Same user preferences, palette and scrollback as the main terminal:
    // it used to be pinned to 13px / line height 1.0 with another palette.
    this.xterm = new Terminal({
      ...buildTerminalOptions(),
      // Clicks on OSC 8 links (full URLs) → browser; Option+drag
      // selects even when the TUI captures the mouse (Claude fullscreen).
      linkHandler: createTerminalLinkHandler((uri) => { this.hoveredLink = uri; }),
      macOptionClickForcesSelection: true,
      cursorBlink: perf.cursorBlink,
    });

    this.fitAddon = new FitAddon();
    this.xterm.loadAddon(this.fitAddon);
    // CLI copies via OSC 52 (remote hosts: no pbcopy) → local clipboard.
    attachOsc52Clipboard(this.xterm, (text) => this.writeClipboard(text));
    attachUnicode11(this.xterm);
    if (perf.links) this.xterm.loadAddon(new WebLinksAddon(openTerminalLink));
  }

  async ngAfterViewInit(): Promise<void> {
    const el = this.containerRef.nativeElement;

    // Virtualization: a pane that starts hidden (inactive tab)
    // doesn't mount xterm. Every live instance parses VT on EVERY chunk even when
    // it's invisible, and with 5+ sub-agents that's pure wasted work on the
    // webview thread. The state stays where it was anyway — in the Rust buffer — and is
    // replayed when the pane actually appears (the bridge's byte-precise dedup
    // covers the chunks that arrived in the meantime).
    if (!this.isElementVisible(el)) {
      this.attachWhenVisible(el);
      return;
    }
    await this.attach(el);
  }

  /** display:none, collapsed pane or layout not computed yet. */
  private isElementVisible(el: HTMLElement): boolean {
    return el.getClientRects().length > 0 && el.offsetWidth > 0 && el.offsetHeight > 0;
  }

  /**
   * Waits for the container to get real dimensions, then mounts the terminal.
   * ResizeObserver also reports the display:none → visible transition, which is
   * exactly the "user opened this tab" moment.
   */
  private attachWhenVisible(el: HTMLElement): void {
    this.visibilityObserver = new ResizeObserver(() => {
      if (this.disposed || this.attached) return;
      if (!this.isElementVisible(el)) return;
      this.visibilityObserver?.disconnect();
      this.visibilityObserver = null;
      void this.attach(el);
    });
    this.visibilityObserver.observe(el);
  }

  private async attach(el: HTMLElement): Promise<void> {
    if (this.disposed || this.attached) return;
    this.attached = true;
    const perf = readTerminalPerfPrefs();
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
    this.writeBatcher = createTerminalWriteBatcher(this.xterm, {
      element: () => el,
      runOutside: (fn) => this.zone.runOutsideAngular(fn),
    });
    this.fitAddon.fit();
    // Lock input immediately if the pane opens mid-boot (effect may not have run yet).
    this.xterm.options.disableStdin = this.isSpawning();

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
      isEnabled: () =>
        this.subAgentService.activeSubAgents().find((a) => a.id === this.subAgentId)?.provider === 'claude-code-cli',
      runLabel: (command) => this.translate.instant('TERMINAL_HELPERS.Run command', { command }),
      write: (data) => this.subAgentService.writeToSubAgent(this.subAgentId, data),
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

    // Intercept ESC when pane is expanded + clipboard shortcuts. On Windows/Linux
    // xterm forwards Ctrl+C/V to the PTY (SIGINT / raw ^V); decideTerminalClipboardAction
    // adds Ctrl/Cmd+Shift+C/V and Ctrl/Shift+Insert on all platforms, plus plain
    // Ctrl+C (copy only with a selection, else SIGINT) and Ctrl+V on Windows/Linux.
    this.xterm.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.key === 'Escape' && this.expanded) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        this.escapePressed.emit();
        return false;
      }
      if (TerminalAssistComponent.isSearchShortcut(ev, (window as any).promptops?.platform)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        this.assist?.openSearch();
        return false;
      }
      // Tauri: plain Cmd+C/V too (native WKWebView breaks lines at visual
      // wraps and pastes multi-line as separate submits).
      const metaClipboard = this.sessionService.isTauri;
      const action = decideTerminalClipboardAction(
        ev,
        (window as any).promptops?.platform,
        () => !!this.xterm?.getSelection(),
        metaClipboard,
      );
      if (action && metaClipboard) ev.preventDefault();
      if (action === 'copy') { void this.copySelection(); return false; }
      if (action === 'paste') { void this.pasteClipboard(); return false; }
      // Shift+Enter → insert a newline instead of submitting. preventDefault()
      // is required: returning false alone lets xterm's hidden textarea still
      // emit the Enter as \r (which submits). Ctrl+J (\n) is the universal newline.
      // Cmd as line modifier (macOS): Cmd+←/→ → Ctrl+A/E, Cmd+Backspace → Ctrl+U.
      // xterm drops Cmd+arrow, so without this nothing would reach the PTY.
      const seq = decideTerminalMacLineKey(ev, (window as any).promptops?.platform);
      if (seq) {
        ev.preventDefault();
        this.subAgentService.writeToSubAgent(this.subAgentId, seq);
        return false;
      }
      const ctrl = ev.ctrlKey || ev.metaKey;
      if (ev.shiftKey && !ctrl && !ev.altKey && (ev.key === 'Enter' || ev.code === 'Enter')) {
        ev.preventDefault();
        this.subAgentService.writeToSubAgent(this.subAgentId, '\n');
        return false;
      }
      return true;
    });

    // Track if container had 0 dimensions at open time (tab-mode display:none
    // or flex layout not yet computed). When this happens, xterm's canvas
    // renderer initializes with 0×0 and needs a full refresh once visible.
    this.needsVisibilityRefresh = el.offsetWidth === 0 || el.offsetHeight === 0;

    // No jump to the bottom on focus: clicking to copy or read must not lose
    // the user's place. Typing (scrollOnUserInput) or the ↓ button go back down.

    // Subscribe BEFORE fetching the replay, queueing live chunks.
    // Same shape as session-terminal: the bytes arriving between the buffer
    // snapshot and the subscription would otherwise be lost on every attach.
    // The bridge dedupes byte-precisely against the replay endOffset (the frame
    // carries its own absolute offset), so flushing the queue afterwards cannot
    // duplicate anything.
    let replayDone = false;
    const queuedOutput: string[] = [];
    const batcher = this.writeBatcher!;
    this.unsubOutput = this.subAgentService.onSubAgentOutput((event) => {
      if (event.subAgentId !== this.subAgentId) return;
      this.sniffModelAnnouncement(event.data);
      if (!replayDone) {
        queuedOutput.push(event.data);
        return;
      }
      batcher.write(event.data);
    });

    // Replay existing buffer — retry once after a delay if empty (sub-agent
    // may still be spawning after an app restart/update)
    let gotBuffer = false;
    try {
      const buffer = await this.subAgentService.getBuffer(this.subAgentId);
      if (this.disposed) return;
      if (buffer) {
        this.writeReplay(buffer);
        gotBuffer = true;
      }
    } catch {
      // No buffer yet
    }
    if (this.disposed) return;

    replayDone = true;
    for (const chunk of queuedOutput) batcher.write(chunk);
    queuedOutput.length = 0;

    // Retry buffer load after 3s if initial was empty (covers restore timing)
    if (!gotBuffer) {
      setTimeout(async () => {
        if (this.disposed) return;
        try {
          const buffer = await this.subAgentService.getBuffer(this.subAgentId);
          if (this.disposed) return;
          if (buffer) {
            this.writeReplay(buffer);
          }
        } catch { /* still no buffer */ }
      }, 3000);
    }

    // User types -> forward to sub-agent terminal
    // Strip terminal auto-responses that xterm.js sends back (DA, CPR, DSR,
    // Focus In/Out). They may arrive concatenated in a single onData call.
    const TERM_RESPONSE_RE = /\x1b\[[\?>=]?[0-9;]*[cRnIO]/g;
    this.xterm.onData(async (data) => {
      // Belt-and-suspenders with disableStdin: never forward keystrokes while the
      // provider TUI is still booting, or they'd race the auto-prompt paste.
      if (this.isSpawning()) return;
      const cleaned = data.replace(TERM_RESPONSE_RE, '');
      if (!cleaned) return;

      const result = this.guard.processOutbound(cleaned);
      if (result.forward) {
        this.subAgentService.writeToSubAgent(this.subAgentId, result.forward);
      }

      if (result.intercept) {
        const parentSessionId = this.getParentSessionId();
        if (!parentSessionId) {
          // Fallback: forward what we held back so the user is not stuck.
          this.subAgentService.writeToSubAgent(
            this.subAgentId,
            result.intercept.isPaste ? result.intercept.command : '\r',
          );
          return;
        }
        const choice = await this.subAgentService.showSmartActionModalForTerminal(
          parentSessionId,
          result.intercept.command,
          this.getWorkspacePath(),
          result.intercept.isPaste,
        );
        if (choice === 'continue') {
          this.subAgentService.writeToSubAgent(
            this.subAgentId,
            result.intercept.isPaste ? result.intercept.command : '\r',
          );
        }
        // 'terminal' or 'cancel' → do not forward (design choice B: no rollback)
      }
    });

    // Auto-resize — also handles visibility transitions (display:none → visible).
    // fit() runs every tick so the canvas stays aligned with the container,
    // but the PTY ioctl is debounced via schedulePtyResize() to avoid the
    // SIGWINCH storm that scrambles TUI redraws during a splitter drag.
    this.resizeObserver = new ResizeObserver((entries) => {
      if (!this.xterm || !this.fitAddon) return;
      const rect = entries[0]?.contentRect;
      // Skip while container is collapsed/zero-sized — fit() with 0×0 would
      // push absurd cols/rows to the PTY and corrupt the running program.
      if (!rect || rect.width === 0 || rect.height === 0) return;
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

    // Multi-stage visibility refresh: check at 150ms, 500ms, and 1500ms.
    // Needed because sub-agent panes may be hidden in tabs/collapsed panels
    // and the container gains real dimensions at unpredictable times.
    const scheduleRefresh = (delay: number) => {
      setTimeout(() => {
        if (this.replayInFlight) return;
        if (this.needsVisibilityRefresh && el.offsetWidth > 0 && el.offsetHeight > 0) {
          this.needsVisibilityRefresh = false;
          this.fitAddon.fit();
          this.xterm.refresh(0, this.xterm.rows - 1);
        }
        this.schedulePtyResize();
      }, delay);
    };
    scheduleRefresh(150);
    scheduleRefresh(500);
    scheduleRefresh(1500);

    // Custom font may not be loaded when xterm opens.
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
        if (!this.xterm || this.disposed) return;
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
      const el = this.containerRef?.nativeElement;
      if (this.disposed || this.replayInFlight || !xterm || !this.fitAddon || !el) return;
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
    const subAgentId = this.subAgentId;
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
      this.dimsRegistry.set(`sa:${subAgentId}`, cols, rows);
      this.subAgentService.resizeSubAgent(subAgentId, cols, rows);
    }, 120);
  }

  focus(): void {
    setTimeout(() => {
      // Pane still virtualized: fit() would run on a nonexistent renderer.
      // Attach starts on its own as soon as the container becomes visible.
      if (!this.attached) return;
      if (this.replayInFlight) { this.xterm?.focus(); return; }
      this.fitAddon.fit();
      if (this.needsVisibilityRefresh) {
        this.needsVisibilityRefresh = false;
        this.xterm.refresh(0, this.xterm.rows - 1);
      }
      this.schedulePtyResize();
      this.xterm.focus();
    });
  }

  /**
   * Force a full re-render against the current container size.
   * Mirror of SessionTerminalComponent.refit() — see that for rationale.
   */
  refit(): void {
    if (!this.attached || this.replayInFlight) return;
    const xterm = this.xterm;
    const fit = this.fitAddon;
    const el = this.containerRef?.nativeElement;
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
   * Write the raw replay buffer at the PTY's own grid size.
   * The buffer is a cursor-addressed byte stream generated at the PTY's real
   * cols/rows; parsing it on a different grid (container mid-layout, hidden
   * tab → xterm default 80×24) garbles it permanently. So: resize the grid
   * to the last dims actually sent to this PTY (PtyDimsRegistry), parse the
   * replay with every fit() path gated, then let finishReplay() re-fit to
   * the container.
   */
  private writeReplay(buffer: string): void {
    // The 3 s retry can land after live output already queued: keep it first.
    this.writeBatcher?.flush();
    const known = this.dimsRegistry.get(`sa:${this.subAgentId}`);
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
    this.replayGateTimer = setTimeout(() => this.finishReplay(!!known), 10_000);
    this.xterm.write(buffer, () => this.finishReplay(!!known));
  }

  private finishReplay(hadKnownDims: boolean): void {
    if (this.disposed || !this.replayInFlight) return;
    this.replayInFlight = false;
    if (this.replayGateTimer !== null) {
      clearTimeout(this.replayGateTimer);
      this.replayGateTimer = null;
    }

    const replayCols = this.xterm.cols;
    const replayRows = this.xterm.rows;
    // Re-fit to the container + font re-measure + full refresh + PTY notify
    // (no-op while the container is hidden — the ResizeObserver picks it up).
    this.refit();

    // If the container now yields a different grid, refit() just queued a
    // REAL size change to the PTY — the kernel raises SIGWINCH and the TUI
    // repaints itself. A same-size resize never signals, so when nothing
    // changed (or we replayed blind, without known dims) the TUI must be
    // bounced explicitly or the user keeps staring at a garbled frame.
    const dimsUnchanged = this.xterm.cols === replayCols && this.xterm.rows === replayRows;
    const status = this.subAgentService.activeSubAgents()
      .find(a => a.id === this.subAgentId)?.status;
    const ptyAlive = status !== 'completed' && status !== 'error' && status !== 'exited';
    if ((dimsUnchanged || !hadKnownDims) && ptyAlive
        && !(window as unknown as Record<string, unknown>)['__PO_SAFE_TERMINAL__']) {
      if (this.tuiRepaintTimer !== null) clearTimeout(this.tuiRepaintTimer);
      this.tuiRepaintTimer = setTimeout(() => void this.forceTuiRepaint(), 300);
    }
  }

  /**
   * Force the running TUI to repaint by bouncing the PTY one row smaller and
   * back — the automated equivalent of the user's manual splitter drag, kept
   * in lockstep with the xterm grid so the intermediate frame renders clean.
   */
  private async forceTuiRepaint(): Promise<void> {
    this.tuiRepaintTimer = null;
    if (this.disposed || this.replayInFlight || this.tuiRepaintDone) return;
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
    await this.subAgentService.resizeSubAgent(this.subAgentId, cols, rows - 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    if (this.disposed || !this.xterm) return;

    // Step back to the container-fitted grid.
    const el = this.containerRef?.nativeElement;
    if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
      this.fitAddon.fit();
    } else {
      this.xterm.resize(cols, rows);
    }
    this.lastSentCols = this.xterm.cols;
    this.lastSentRows = this.xterm.rows;
    this.dimsRegistry.set(`sa:${this.subAgentId}`, this.xterm.cols, this.xterm.rows);
    await this.subAgentService.resizeSubAgent(this.subAgentId, this.xterm.cols, this.xterm.rows);
  }

  /**
   * `/model` inside the TUI answers with "Set model to …" on screen, before
   * any transcript or hook knows about it — so the model badge listens to the
   * stream itself. The service is keyed by session id, which this component
   * doesn't have: resolve it once and cache it.
   */
  private modelSessionId: string | null = null;
  private sniffModelAnnouncement(data: string): void {
    // Limit detection rides the same live stream (never the replay).
    this.providerLimit.sniffOutput(
      `sa:${this.subAgentId}`,
      this.subAgentService.activeSubAgents().find((a) => a.id === this.subAgentId)?.provider,
      data,
    );
    if (!this.modelSessionId) {
      this.modelSessionId =
        this.subAgentService.activeSubAgents().find((a) => a.id === this.subAgentId)?.sessionId ?? null;
      if (!this.modelSessionId) return;
    }
    this.sessionModels.noteTerminalOutput(this.modelSessionId, data);
  }

  ngOnDestroy(): void {
    this.disposed = true;
    if (this.replayGateTimer !== null) {
      clearTimeout(this.replayGateTimer);
      this.replayGateTimer = null;
    }
    if (this.tuiRepaintTimer !== null) {
      clearTimeout(this.tuiRepaintTimer);
      this.tuiRepaintTimer = null;
    }
    if (this.spinnerTimer !== null) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    if (this.settledRepaintTimer !== null) clearTimeout(this.settledRepaintTimer);
    this.resizeObserver?.disconnect();
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
    if (this.ptyResizeTimer !== null) {
      clearTimeout(this.ptyResizeTimer);
      this.ptyResizeTimer = null;
    }
    this.unsubOutput?.();
    this.writeBatcher?.dispose();
    this.writeBatcher = null;
    this.unwatchAppearance?.();
    this.unwatchAppearance = null;
    this.assist?.detach();
    this.fileLinkProvider?.dispose();
    this.fileLinkProvider = null;
    this.bangRunner?.dispose();
    this.bangRunner = null;
    this.linkCopier?.dispose();
    this.linkCopier = null;
    this.xterm?.dispose();
  }
}
