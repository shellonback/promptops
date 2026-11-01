import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import type { Terminal } from '@xterm/xterm';
import { SearchAddon } from '@xterm/addon-search';
import { attachScrollFollow, ScrollFollowHandle } from '@core/helper/terminal-scroll-follow';

/**
 * Layer above an agent terminal: a "↓ new output" button while the user reads
 * further up, and a find-in-output bar (⌘F / Ctrl+Shift+F).
 *
 * The terminal component hooks it with `attach(xterm)` after `open()` and
 * unhooks it with `detach()` on teardown; nothing else goes through it.
 */
@Component({
  selector: 'app-terminal-assist',
  standalone: true,
  imports: [TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (searchOpen()) {
      <div class="ta-search" (keydown)="onSearchKey($event)">
        <i class="ti ti-search ta-search-icon"></i>
        <input #searchInput class="ta-search-input" type="text" spellcheck="false" autocomplete="off"
               [placeholder]="'TERMINAL.Find in output' | translate"
               [value]="query()" (input)="onQuery($any($event.target).value)" />
        <span class="ta-search-count">
          @if (query()) {
            @if (resultCount() > 0) {
              {{ resultIndex() + 1 }}/{{ resultCount() }}
            } @else {
              {{ 'TERMINAL.No results' | translate }}
            }
          }
        </span>
        <button class="ta-btn" type="button" [title]="'TERMINAL.Previous match' | translate" (click)="findPrevious()">
          <i class="ti ti-chevron-up"></i>
        </button>
        <button class="ta-btn" type="button" [title]="'TERMINAL.Next match' | translate" (click)="findNext()">
          <i class="ti ti-chevron-down"></i>
        </button>
        <button class="ta-btn" type="button" [title]="'TERMINAL.Close search' | translate" (click)="closeSearch()">
          <i class="ti ti-x"></i>
        </button>
      </div>
    }
    @if (away()) {
      <button class="ta-follow" type="button" (click)="scrollToBottom()"
              [title]="'TERMINAL.Scroll to bottom' | translate">
        <i class="ti ti-arrow-down"></i>
        @if (newLines() > 0) {
          <span>{{ 'TERMINAL.New output' | translate: { count: newLines() } }}</span>
        }
      </button>
    }
  `,
  styles: `
    :host {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 20;
    }
    .ta-search {
      position: absolute;
      top: 8px;
      right: 14px;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 4px 4px 10px;
      pointer-events: auto;
      /* The terminal is always dark: fixed surface, not the theme token. */
      background: #1a1c28;
      border: 1px solid rgba(99, 102, 241, 0.3);
      border-radius: 8px;
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
      max-width: calc(100% - 28px);
    }
    .ta-search-icon { color: rgba(205, 214, 244, 0.6); font-size: 14px; }
    .ta-search-input {
      width: 180px;
      min-width: 60px;
      flex: 1 1 auto;
      background: transparent;
      border: none;
      outline: none;
      color: #cdd6f4;
      font-size: 13px;
      padding: 3px 4px;
    }
    .ta-search-count {
      min-width: 44px;
      text-align: right;
      color: rgba(205, 214, 244, 0.6);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .ta-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      background: none;
      border: none;
      border-radius: 5px;
      color: #cdd6f4;
      cursor: pointer;
    }
    .ta-btn:hover { background: rgba(99, 102, 241, 0.22); }
    .ta-btn:focus-visible { outline: 1px solid var(--po-accent, #6366F1); }
    .ta-follow {
      position: absolute;
      right: 18px;
      bottom: 14px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 11px;
      pointer-events: auto;
      background: var(--po-accent, #6366F1);
      border: none;
      border-radius: 999px;
      color: var(--po-accent-on, #fff);
      font-size: 12px;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
      animation: ta-in 0.14s ease-out;
    }
    .ta-follow:hover { filter: brightness(1.08); }
    @keyframes ta-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .ta-follow { animation: none; }
    }
  `,
})
export class TerminalAssistComponent implements OnDestroy {
  @ViewChild('searchInput') private searchInput?: ElementRef<HTMLInputElement>;

  private zone = inject(NgZone);
  private xterm: Terminal | null = null;
  private search: SearchAddon | null = null;
  private follow: ScrollFollowHandle | null = null;
  private resultsSub: { dispose(): void } | null = null;

  readonly away = signal(false);
  readonly newLines = signal(0);
  readonly searchOpen = signal(false);
  readonly query = signal('');
  readonly resultIndex = signal(-1);
  readonly resultCount = signal(0);

  attach(xterm: Terminal): void {
    this.detach();
    this.xterm = xterm;
    this.follow = attachScrollFollow(xterm, (s) => this.zone.run(() => {
      this.away.set(s.away);
      this.newLines.set(s.newLines);
    }));
    try {
      this.search = new SearchAddon();
      xterm.loadAddon(this.search);
      this.resultsSub = this.search.onDidChangeResults((r) => this.zone.run(() => {
        this.resultIndex.set(r.resultIndex);
        this.resultCount.set(r.resultCount);
      }));
    } catch {
      this.search = null;
    }
  }

  detach(): void {
    this.follow?.dispose();
    this.follow = null;
    this.resultsSub?.dispose();
    this.resultsSub = null;
    try { this.search?.dispose(); } catch { /* terminal already disposed */ }
    this.search = null;
    this.xterm = null;
    this.away.set(false);
    this.newLines.set(0);
    this.searchOpen.set(false);
    this.query.set('');
    this.resultIndex.set(-1);
    this.resultCount.set(0);
  }

  ngOnDestroy(): void {
    this.detach();
  }

  scrollToBottom(): void {
    this.follow?.scrollToBottom();
    this.xterm?.focus();
  }

  /** ⌘F on macOS, Ctrl+Shift+F elsewhere (plain Ctrl+F stays with the shell). */
  static isSearchShortcut(ev: KeyboardEvent, platform: string | undefined): boolean {
    if (ev.type !== 'keydown' || ev.altKey) return false;
    if (ev.code !== 'KeyF' && ev.key?.toLowerCase() !== 'f') return false;
    const mac = platform ? platform === 'darwin' : /Mac/i.test(navigator.platform);
    return mac ? ev.metaKey && !ev.ctrlKey && !ev.shiftKey : ev.ctrlKey && ev.shiftKey && !ev.metaKey;
  }

  openSearch(): void {
    if (!this.search) return;
    this.zone.run(() => {
      const sel = this.xterm?.getSelection();
      if (sel && !sel.includes('\n') && sel.length <= 200) this.query.set(sel);
      this.searchOpen.set(true);
      setTimeout(() => {
        const input = this.searchInput?.nativeElement;
        input?.focus();
        input?.select();
        if (this.query()) this.findNext(true);
      });
    });
  }

  closeSearch(): void {
    this.search?.clearDecorations();
    this.searchOpen.set(false);
    this.resultIndex.set(-1);
    this.resultCount.set(0);
    this.xterm?.focus();
  }

  onQuery(value: string): void {
    this.query.set(value);
    if (!value) {
      this.search?.clearDecorations();
      this.resultIndex.set(-1);
      this.resultCount.set(0);
      return;
    }
    this.findNext(true);
  }

  findNext(incremental = false): void {
    const q = this.query();
    if (!q || !this.search) return;
    this.search.findNext(q, { incremental, decorations: SEARCH_DECORATIONS });
  }

  findPrevious(): void {
    const q = this.query();
    if (!q || !this.search) return;
    this.search.findPrevious(q, { decorations: SEARCH_DECORATIONS });
  }

  onSearchKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      this.closeSearch();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.shiftKey) this.findPrevious(); else this.findNext();
    }
  }
}

const SEARCH_DECORATIONS = {
  matchBackground: '#3b3f8f',
  matchBorder: '#6366f1',
  matchOverviewRuler: '#818cf8',
  activeMatchBackground: '#e3b341',
  activeMatchBorder: '#f0c74f',
  activeMatchColorOverviewRuler: '#f0c74f',
};
