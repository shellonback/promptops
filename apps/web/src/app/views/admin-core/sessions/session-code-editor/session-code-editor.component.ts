import {
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  inject,
  signal,
  computed,
  input,
  Input,
  OnInit,
  OnDestroy,
  HostListener,
  ViewChild,
  ElementRef,
  AfterViewInit,
  NgZone,
  effect,
  ChangeDetectionStrategy
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { NgbActiveModal, NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { TooltipDirective } from '../../../../common/tooltip.directive';
import { TerminalBootLoaderComponent } from '../../terminal/terminal-boot-loader.component';
import { GitService, GitFile } from '../services/git.service';
import { SessionService } from '../services/session.service';
import { SessionTerminalComponent } from '../session-terminal/session-terminal.component';
import { isPdfPath, isRasterImagePath, toDataUrl } from '../services/image-file.util';
import { SwalService } from '@core/services/swal.service';

/* ───────────────────── Interfaces ───────────────────── */

interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileNode[];
  expanded?: boolean;
  level: number;
  gitStatus?: string;
  gitIgnored?: boolean;
}

interface OpenFile {
  path: string;
  name: string;
  content: string;
  originalContent: string;
  modified: boolean;
  language: string;
  kind?: 'text' | 'image' | 'pdf' | 'binary'; // absent = text (backward compatible)
  imageDataUrl?: string;
  /** Blob URL of a PDF tab (revoked on close) + its sanitized form for the iframe. */
  pdfBlobUrl?: string;
  pdfSafeUrl?: SafeResourceUrl;
  sizeBytes?: number;
  binaryError?: string;
}

type LineDiffType = 'added' | 'modified' | 'deleted-below';

interface SearchResult {
  filePath: string;
  line: number;
  content: string;
  column: number;
  /** Match length (UTF-16 units) — set by the backend; missing on legacy substring-only backends. */
  length?: number;
  /** Display parts computed client-side: context before / matched text / context after. */
  pre?: string;
  match?: string;
  post?: string;
}

interface SearchResultGroup {
  filePath: string;
  fileName: string;
  /** Directory part of filePath ('' for root files) — shown dimmed next to the name. */
  dirPath: string;
  results: SearchResult[];
  expanded: boolean;
}

/* ───────────────── Helper: promptops bridge ─────────── */

const api = () => (window as any).promptops;

/* ───────────────── Helper: file icon map ────────────── */

const EXT_ICON_MAP: Record<string, string> = {
  ts: 'vscode-icons:file-type-typescript',
  tsx: 'vscode-icons:file-type-typescript',
  js: 'vscode-icons:file-type-js',
  jsx: 'vscode-icons:file-type-js',
  json: 'vscode-icons:file-type-json',
  html: 'vscode-icons:file-type-html',
  css: 'vscode-icons:file-type-css',
  scss: 'vscode-icons:file-type-scss',
  less: 'vscode-icons:file-type-less',
  md: 'vscode-icons:file-type-markdown',
  py: 'vscode-icons:file-type-python',
  php: 'vscode-icons:file-type-php',
  rb: 'vscode-icons:file-type-ruby',
  rs: 'vscode-icons:file-type-rust',
  go: 'vscode-icons:file-type-go',
  java: 'vscode-icons:file-type-java',
  yaml: 'vscode-icons:file-type-yaml',
  yml: 'vscode-icons:file-type-yaml',
  xml: 'vscode-icons:file-type-xml',
  sh: 'vscode-icons:file-type-shell',
  bash: 'vscode-icons:file-type-shell',
  zsh: 'vscode-icons:file-type-shell',
  dockerfile: 'vscode-icons:file-type-docker',
  svg: 'vscode-icons:file-type-svg',
  png: 'vscode-icons:file-type-image',
  jpg: 'vscode-icons:file-type-image',
  gif: 'vscode-icons:file-type-image',
  gitignore: 'vscode-icons:file-type-git',
  env: 'vscode-icons:file-type-dotenv',
  vue: 'vscode-icons:file-type-vue',
  sql: 'vscode-icons:file-type-sql',
  graphql: 'vscode-icons:file-type-graphql',
  lock: 'solar:file-lock-bold',
  toml: 'vscode-icons:file-type-toml',
};

/* ───────────────── Helper: language detection ───────── */

const EXT_LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  json: 'json', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', py: 'python', php: 'php', rb: 'ruby', rs: 'rust', go: 'go',
  java: 'java', yaml: 'yaml', yml: 'yaml', xml: 'xml', sh: 'shell', bash: 'shell',
  zsh: 'shell', dockerfile: 'dockerfile', sql: 'sql', graphql: 'graphql',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp', swift: 'swift',
  kt: 'kotlin', r: 'r', lua: 'lua', perl: 'perl', pl: 'perl',
  svg: 'xml', vue: 'html', env: 'ini', toml: 'ini', ini: 'ini',
  bat: 'bat', ps1: 'powershell', makefile: 'makefile',
};

function detectLanguage(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile') return 'makefile';
  const ext = lower.split('.').pop() ?? '';
  return EXT_LANG_MAP[ext] ?? 'plaintext';
}

function fileIcon(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return EXT_ICON_MAP['dockerfile'];
  const ext = lower.split('.').pop() ?? '';
  return EXT_ICON_MAP[ext] ?? 'mdi:file-outline';
}

function folderIcon(expanded: boolean): string {
  return expanded ? 'mdi:folder-open' : 'mdi:folder';
}

/** Tabs reopened per workspace on return (text files only). */
const MAX_RESTORED_TABS = 15;

/* ───────────────── Monaco loader ────────────────────── */

let monacoLoaded = false;
let monacoLoadPromise: Promise<void> | null = null;

/**
 * Monaco's WebKit clipboard workaround pre-arms `navigator.clipboard.write`
 * with a still-pending text item on every click/keydown anywhere in the page.
 * The Tauri WebKit webview refuses those writes (NotAllowedError): Monaco
 * logged each refusal as an error, and the pending promise it cancels on the
 * next click became an unhandled rejection (through WebKit's own handlers).
 * Only items carrying a PROMISE (Monaco's pattern; the app's own copies pass
 * ready Blobs or strings) are affected; everything else behaves as before.
 */
function quietMonacoWebKitClipboard(): void {
  const w = window as any;
  const clipboard = navigator.clipboard as any;
  if (!clipboard?.write || !w.ClipboardItem || clipboard.__poMonacoQuiet) return;
  const deferredItems = new WeakSet<object>();
  const NativeClipboardItem = w.ClipboardItem;
  const isThenable = (v: unknown): v is PromiseLike<unknown> => typeof (v as any)?.then === 'function';
  class TrackedClipboardItem extends NativeClipboardItem {
    constructor(items: Record<string, unknown>, options?: unknown) {
      const entries = Object.entries(items ?? {});
      const deferred = entries.some(([, v]) => isThenable(v));
      // WebKit chains its own handlers on the item's promise: when Monaco
      // cancels that promise on the next click (after WebKit refused the
      // write), the rejection surfaced as an unhandled one. WebKit gets a
      // copy that settles with the value but never with the cancellation.
      super(
        deferred
          ? Object.fromEntries(entries.map(([k, v]) => [k, isThenable(v)
            ? Promise.resolve(v).then((x) => x, () => new Promise<never>(() => {}))
            : v]))
          : items,
        options,
      );
      if (deferred) deferredItems.add(this);
    }
  }
  w.ClipboardItem = TrackedClipboardItem;
  const write = clipboard.write.bind(clipboard);
  clipboard.write = (items: object[]) =>
    write(items).catch((err: unknown) => {
      const deferred = Array.isArray(items) && items.length > 0 && items.every((i) => deferredItems.has(i));
      if (deferred && (err as { name?: string })?.name === 'NotAllowedError') return;
      throw err;
    });
  clipboard.__poMonacoQuiet = true;
}

function loadMonaco(): Promise<void> {
  if (monacoLoaded) return Promise.resolve();
  if (monacoLoadPromise) return monacoLoadPromise;
  try { quietMonacoWebKitClipboard(); } catch { /* never block the editor */ }

  monacoLoadPromise = new Promise<void>((resolve, reject) => {
    const baseUrl = 'assets/monaco-editor/min';

    // Configure AMD loader
    (window as any).require = (window as any).require || {};
    (window as any).require.paths = { vs: baseUrl + '/vs' };

    // Load the Monaco loader script
    const loaderScript = document.createElement('script');
    loaderScript.src = `${baseUrl}/vs/loader.js`;
    loaderScript.onload = () => {
      (window as any).require(['vs/editor/editor.main'], () => {
        monacoLoaded = true;
        // Set theme immediately
        setupMonacoTheme();
        resolve();
      });
    };
    loaderScript.onerror = () => reject(new Error('Failed to load Monaco editor'));
    document.head.appendChild(loaderScript);
  });

  return monacoLoadPromise;
}

function setupMonacoTheme(): void {
  const monaco = (window as any).monaco;
  if (!monaco) return;

  monaco.editor.defineTheme('promptops-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6a737d', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'ff7b72' },
      { token: 'string', foreground: 'a5d6ff' },
      { token: 'number', foreground: '79c0ff' },
      { token: 'type', foreground: 'ffa657' },
      { token: 'function', foreground: 'd2a8ff' },
      { token: 'variable', foreground: 'ffa657' },
      { token: 'constant', foreground: '79c0ff' },
      { token: 'tag', foreground: '7ee787' },
      { token: 'attribute.name', foreground: '79c0ff' },
      { token: 'attribute.value', foreground: 'a5d6ff' },
      { token: 'delimiter', foreground: 'c9d1d9' },
    ],
    colors: {
      'editor.background': '#1e1f27',
      'editor.foreground': '#e6edf3',
      'editor.lineHighlightBackground': '#2a2b35',
      'editor.selectionBackground': '#264f78',
      'editor.inactiveSelectionBackground': '#264f7833',
      'editorLineNumber.foreground': '#484f58',
      'editorLineNumber.activeForeground': '#e6edf3',
      'editorCursor.foreground': '#58a6ff',
      'editor.findMatchBackground': '#ffd33d44',
      'editor.findMatchHighlightBackground': '#ffd33d22',
      'editorWidget.background': '#15161e',
      'editorWidget.border': '#30363d',
      'input.background': '#1e1f27',
      'input.border': '#30363d',
      'input.foreground': '#e6edf3',
      'editorGutter.addedBackground': '#3fb95066',
      'editorGutter.modifiedBackground': '#d2992266',
      'editorGutter.deletedBackground': '#f8514966',
      'scrollbar.shadow': '#00000033',
      'scrollbarSlider.background': '#484f5833',
      'scrollbarSlider.hoverBackground': '#484f5866',
      'scrollbarSlider.activeBackground': '#484f5899',
      'minimap.background': '#1e1f27',
      'editorOverviewRuler.addedForeground': '#3fb950',
      'editorOverviewRuler.modifiedForeground': '#d29922',
      'editorOverviewRuler.deletedForeground': '#f85149',
    },
  });
}

/* ─────────────────────── Component ──────────────────── */

@Component({
  selector: 'app-session-code-editor',
  standalone: true,
  imports: [FormsModule, TranslatePipe, TooltipDirective, SessionTerminalComponent, TerminalBootLoaderComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <!-- ====== FULLSCREEN WRAPPER ====== -->
    <div class="code-editor-root" [class.inline-mode]="inline()">
      @if (booting()) {
        <app-terminal-boot-loader [label]="'CODE_EDITOR.Opening workspace' | translate" />
      }

      <!-- ── TOP BAR ── -->
      @if (!inline()) {
        <div class="top-bar">
          <div class="top-bar-left">
            <iconify-icon icon="mdi:code-braces" width="18"></iconify-icon>
            <span class="top-bar-title">{{ 'CODE_EDITOR.Title' | translate }}</span>
            @if (activeFile(); as af) {
              <span class="top-bar-path">{{ af.path }}</span>
            }
          </div>
          <div class="top-bar-right">
            <span class="save-status" [class]="'status-' + saveStatus()">
              @switch (saveStatus()) {
                @case ('saved')   { <iconify-icon icon="mdi:check-circle" width="14"></iconify-icon> {{ 'CODE_EDITOR.Saved' | translate }} }
                @case ('saving')  { <iconify-icon icon="mdi:loading" width="14" class="spin"></iconify-icon> {{ 'CODE_EDITOR.Saving' | translate }} }
                @case ('unsaved') { <iconify-icon icon="mdi:circle" width="14"></iconify-icon> {{ 'CODE_EDITOR.Unsaved' | translate }} }
                @case ('error')   { <iconify-icon icon="mdi:alert-circle" width="14"></iconify-icon> {{ 'CODE_EDITOR.Error' | translate }} }
              }
            </span>
            @if (modal) {
              <button class="close-btn" (click)="modal.dismiss()" [attr.aria-label]="'CODE_EDITOR.Close' | translate">
                <iconify-icon icon="mdi:close" width="20"></iconify-icon>
              </button>
            }
          </div>
        </div>
      }

      <!-- ── MAIN BODY ── -->
      <div class="main-body">

        <!-- LEFT: SIDEBAR -->
        <div class="sidebar-wrapper">
          <div class="sidebar">
            <!-- Horizontal tab bar -->
            <div class="sidebar-tabs">
              <button class="sidebar-tab-btn" [class.active]="sidebarTab() === 'search'" (click)="switchToSearchTab()">
                <iconify-icon icon="mdi:magnify" width="14"></iconify-icon> {{ 'CODE_EDITOR.Search' | translate }}
              </button>
              <button class="sidebar-tab-btn" (click)="openSourceTree()">
                <iconify-icon icon="mdi:source-branch" width="14"></iconify-icon> Git
              </button>
              <button class="sidebar-tab-btn" [class.active]="sidebarTab() === 'explorer'" (click)="sidebarTab.set('explorer')">
                <iconify-icon icon="mdi:file-tree" width="14"></iconify-icon> {{ 'CODE_EDITOR.Explorer' | translate }}
              </button>
            </div>
            @if (sidebarTab() === 'explorer') {
              <!-- ═══ EXPLORER TAB ═══ -->
              <div class="sidebar-header">
                <span class="sidebar-title">{{ 'CODE_EDITOR.Explorer' | translate }}</span>
                <button class="icon-btn" (click)="refreshTree()" [appTooltip]="'CODE_EDITOR.Refresh' | translate" [attr.aria-label]="'CODE_EDITOR.Refresh' | translate">
                  <iconify-icon icon="mdi:refresh" width="14"></iconify-icon>
                </button>
              </div>
              <div
                class="file-tree"
                tabindex="0"
                (keydown)="onTreeKeydown($event)"
                #fileTreeEl
              >
                @if (loading() && !booting()) {
                  <div class="tree-loading">
                    <iconify-icon icon="mdi:loading" width="20" class="spin"></iconify-icon>
                    {{ 'CODE_EDITOR.Loading' | translate }}
                  </div>
                }
                @for (node of flatTree(); track node.path) {
                  <div
                    class="tree-node"
                    [attr.data-tree-path]="node.path"
                    [class.active]="activeFilePath() === node.path"
                    [class.focused]="focusedTreePath() === node.path"
                    [class.git-modified]="node.gitStatus === 'M'"
                    [class.git-added]="node.gitStatus === 'A' || node.gitStatus === '?'"
                    [class.git-deleted]="node.gitStatus === 'D'"
                    [class.git-ignored]="node.gitIgnored"
                    [style.paddingLeft.px]="12 + node.level * 16"
                    (click)="onTreeNodeClick(node)"
                    (contextmenu)="onTreeNodeContext($event, node)"
                  >
                    @if (renameTarget()?.path === node.path) {
                      <input
                        class="rename-input"
                        [value]="renameTarget()!.name"
                        (keydown.enter)="confirmRename($event)"
                        (keydown.escape)="cancelRename()"
                        (blur)="confirmRename($event)"
                        #renameInput
                      />
                    } @else {
                      @if (node.isDir) {
                        <iconify-icon
                          [icon]="node.expanded ? 'mdi:chevron-down' : 'mdi:chevron-right'"
                          width="16"
                          class="node-chevron"
                        ></iconify-icon>
                        <iconify-icon [icon]="folderIcon(!!node.expanded)" width="16" class="node-icon folder-icon"></iconify-icon>
                      } @else {
                        <span class="node-chevron-spacer"></span>
                        <iconify-icon [icon]="fileIcon(node.name)" width="16" class="node-icon"></iconify-icon>
                      }
                      <span class="node-name" [class.is-dir]="node.isDir">{{ node.name }}</span>
                      @if (node.gitStatus) {
                        <span class="git-badge git-badge-{{ node.gitStatus === '?' ? 'A' : node.gitStatus }}">{{ node.gitStatus === '?' ? 'U' : node.gitStatus }}</span>
                      }
                    }
                  </div>
                }
              </div>
            } @else if (sidebarTab() === 'search') {
              <!-- ═══ SEARCH TAB ═══ -->
              <div class="sidebar-header">
                <span class="sidebar-title">{{ 'CODE_EDITOR.Search' | translate }}</span>
                @if (globalSearchResults().length > 0) {
                  <span class="search-count-badge">{{ globalSearchResults().length }}</span>
                }
              </div>
              <div class="search-panel">
                <div class="search-field-row">
                  <div class="search-field-wrap">
                    <input
                      class="search-input"
                      [placeholder]="'CODE_EDITOR.Search placeholder' | translate"
                      [(ngModel)]="globalSearchQuery"
                      (ngModelChange)="onGlobalSearchChange($event)"
                      (keydown.enter)="navigateSearchResult(1)"
                      (keydown.escape)="globalSearchQuery = ''; globalSearchResults.set([]); searchResultGroups.set([]); searchTruncated.set(false)"
                      #globalSearchInput
                    />
                    @if (globalSearchQuery.length > 0) {
                      <button class="search-clear-btn" [attr.aria-label]="'CODE_EDITOR.Clear search' | translate" (click)="globalSearchQuery = ''; globalSearchResults.set([]); searchResultGroups.set([]); searchTruncated.set(false)">
                        <iconify-icon icon="mdi:close" width="12"></iconify-icon>
                      </button>
                    }
                  </div>
                </div>
                <div class="search-options-row">
                  <button class="search-option-btn" [class.active]="searchMatchCase()" (click)="searchMatchCase.set(!searchMatchCase()); onGlobalSearchChange(globalSearchQuery)" [appTooltip]="'CODE_EDITOR.Match case' | translate" [attr.aria-label]="'CODE_EDITOR.Match case' | translate" [attr.aria-pressed]="searchMatchCase()">Aa</button>
                  <button class="search-option-btn" [class.active]="searchWholeWord()" (click)="searchWholeWord.set(!searchWholeWord()); onGlobalSearchChange(globalSearchQuery)" [appTooltip]="'CODE_EDITOR.Whole word' | translate" [attr.aria-label]="'CODE_EDITOR.Whole word' | translate" [attr.aria-pressed]="searchWholeWord()"><span class="whole-word-icon">ab</span></button>
                  <button class="search-option-btn" [class.active]="searchUseRegex()" (click)="searchUseRegex.set(!searchUseRegex()); onGlobalSearchChange(globalSearchQuery)" [appTooltip]="'CODE_EDITOR.Regex' | translate" [attr.aria-label]="'CODE_EDITOR.Regex' | translate" [attr.aria-pressed]="searchUseRegex()">.*</button>
                </div>
                <div class="search-field-row">
                  <div class="search-field-wrap">
                    <input class="search-input" [placeholder]="'CODE_EDITOR.Replace placeholder' | translate" [(ngModel)]="replaceQuery" (keydown.enter)="replaceNext()" />
                  </div>
                  <button class="icon-btn replace-btn" (click)="replaceNext()" [appTooltip]="'CODE_EDITOR.Replace next' | translate" [attr.aria-label]="'CODE_EDITOR.Replace next' | translate">
                    <iconify-icon icon="mdi:find-replace" width="14"></iconify-icon>
                  </button>
                  <button class="icon-btn replace-btn" (click)="replaceAll()" [appTooltip]="'CODE_EDITOR.Replace all' | translate" [attr.aria-label]="'CODE_EDITOR.Replace all' | translate">
                    <iconify-icon icon="mdi:text-box-check" width="14"></iconify-icon>
                  </button>
                </div>
                @if (globalSearchResults().length > 0) {
                  <div class="search-nav-bar">
                    <span class="search-nav-count">{{ 'CODE_EDITOR.Results count' | translate: { current: searchActiveIndex() + 1, total: globalSearchResults().length, files: searchResultGroups().length } }}@if (searchTruncated()) {<span class="sr-truncated" [appTooltip]="'CODE_EDITOR.Too many results' | translate">+</span>}</span>
                    <button class="icon-btn" (click)="navigateSearchResult(-1)" [attr.aria-label]="'CODE_EDITOR.Previous result' | translate"><iconify-icon icon="mdi:chevron-up" width="14"></iconify-icon></button>
                    <button class="icon-btn" (click)="navigateSearchResult(1)" [attr.aria-label]="'CODE_EDITOR.Next result' | translate"><iconify-icon icon="mdi:chevron-down" width="14"></iconify-icon></button>
                  </div>
                }
                <div class="search-results-list">
                  @if (searchLoading()) {
                    <div class="tree-loading">
                      <iconify-icon icon="mdi:loading" width="16" class="spin"></iconify-icon>
                      {{ 'CODE_EDITOR.Searching' | translate }}
                    </div>
                  }
                  @for (group of searchResultGroups(); track group.filePath) {
                    <div class="sr-group">
                      <div class="sr-group-header" (click)="toggleSearchGroup(group.filePath)" [appTooltip]="group.filePath">
                        <iconify-icon [icon]="group.expanded ? 'mdi:chevron-down' : 'mdi:chevron-right'" width="14" class="node-chevron"></iconify-icon>
                        <iconify-icon [icon]="fileIcon(group.fileName)" width="14" class="node-icon"></iconify-icon>
                        <span class="sr-group-name">{{ group.fileName }}</span>
                        @if (group.dirPath) {
                          <span class="sr-group-path">{{ group.dirPath }}</span>
                        }
                        <span class="sr-group-count">{{ group.results.length }}</span>
                      </div>
                      @if (group.expanded) {
                        @for (result of group.results; track result.line + ':' + result.column) {
                          <div class="search-result-item"
                               [class.sr-active]="isActiveSearchResult(group.filePath, result.line, result.column)"
                               (click)="goToSearchResult(result)"
                               [appTooltip]="group.filePath + ':' + result.line + ':' + result.column">
                            <span class="sr-line-num">{{ result.line }}<span class="sr-col">:{{ result.column }}</span></span>
                            <span class="sr-text"><span class="sr-pre">{{ result.pre }}</span><mark class="sr-match">{{ result.match }}</mark>{{ result.post }}</span>
                          </div>
                        }
                      }
                    </div>
                  }
                  @if (!searchLoading() && globalSearchResults().length === 0 && globalSearchQuery.length > 1) {
                    <div class="search-empty">{{ 'CODE_EDITOR.No results' | translate }}</div>
                  }
                </div>
              </div>
            }
          </div>
        </div>

        <!-- RIGHT: EDITOR + TERMINAL AREA -->
        <div class="editor-terminal-wrapper">
          <!-- EDITOR AREA -->
          <div class="editor-area" [style.flex]="terminalVisible() ? '1 1 ' + (100 - terminalHeight()) + '%' : '1'">
            <!-- Tabs -->
            <div class="tabs-bar">
              <div class="tabs-scroll">
                @for (file of openFiles(); track file.path) {
                  <div class="tab" [class.active]="activeFilePath() === file.path" (click)="switchTab(file.path)">
                    <iconify-icon [icon]="fileIcon(file.name)" width="14"></iconify-icon>
                    <span class="tab-name">{{ file.name }}</span>
                    @if (file.modified) {
                      <span class="modified-dot"></span>
                    }
                    <button class="tab-close" (click)="closeTab(file.path, $event)" [attr.aria-label]="'CODE_EDITOR.Close tab' | translate">
                      <iconify-icon icon="mdi:close" width="12"></iconify-icon>
                    </button>
                  </div>
                }
              </div>
              <!-- Terminal toggle button -->
              <div class="tabs-actions">
                @if (canDiffActive()) {
                  <button class="icon-btn" [class.active]="diffMode()" (click)="toggleDiff()" [appTooltip]="(diffMode() ? 'CODE_EDITOR.Close diff' : 'CODE_EDITOR.Compare head') | translate" [attr.aria-label]="(diffMode() ? 'CODE_EDITOR.Close diff' : 'CODE_EDITOR.Compare head') | translate">
                    <iconify-icon icon="mdi:file-compare" width="16"></iconify-icon>
                  </button>
                }
                @if (sessionId) {
                  <button class="icon-btn terminal-toggle-btn" (click)="toggleTerminal()" [appTooltip]="(terminalVisible() ? 'CODE_EDITOR.Hide terminal' : 'CODE_EDITOR.Show terminal') | translate" [attr.aria-label]="(terminalVisible() ? 'CODE_EDITOR.Hide terminal' : 'CODE_EDITOR.Show terminal') | translate">
                    <iconify-icon [icon]="terminalVisible() ? 'mdi:chevron-down' : 'mdi:console'" width="16"></iconify-icon>
                  </button>
                }
              </div>
            </div>

            <!-- Monaco editor container -->
            <!-- Always rendered so ViewChild + container dimensions are stable.
                 The empty-state is overlayed when no file is open. -->
            <div class="editor-canvas">
              <div class="monaco-wrapper" #monacoContainer></div>
              <div class="monaco-wrapper diff-wrapper" [class.show]="diffMode()" #diffContainer></div>
              @if (activeFile(); as af) {
                @if (af.kind === 'image') {
                  <div class="image-preview-pane">
                    <img [src]="af.imageDataUrl" [alt]="af.name" (load)="onPreviewImgLoad($event)" />
                    <div class="image-preview-meta">
                      {{ af.name }}
                      @if (imagePreviewDims()) { <span>· {{ imagePreviewDims() }}</span> }
                      @if (af.sizeBytes) { <span>· {{ formatBytes(af.sizeBytes) }}</span> }
                    </div>
                  </div>
                } @else if (af.kind === 'pdf') {
                  <div class="pdf-preview-pane">
                    <iframe [src]="af.pdfSafeUrl" [title]="af.name"></iframe>
                  </div>
                } @else if (af.kind === 'binary') {
                  <div class="editor-empty">
                    <iconify-icon icon="mdi:file-question-outline" width="48" style="opacity:0.2"></iconify-icon>
                    <p>{{ 'CODE_EDITOR.Preview not supported' | translate: { name: af.name, error: af.binaryError } }}</p>
                  </div>
                }
              } @else {
                <div class="editor-empty">
                  <iconify-icon icon="mdi:code-braces" width="48" style="opacity:0.2"></iconify-icon>
                  <p>{{ 'CODE_EDITOR.Empty before' | translate }} <kbd>Cmd+P</kbd> {{ 'CODE_EDITOR.Empty after' | translate }}</p>
                </div>
              }
            </div>
          </div>

          <!-- RESIZE HANDLE -->
          @if (terminalVisible()) {
            <div class="terminal-resize-handle" (mousedown)="onTerminalResizeStart($event)">
              <div class="resize-grip"></div>
            </div>
          }

          <!-- TERMINAL PANEL -->
          @if (visible() && terminalVisible() && sessionId) {
            <div class="terminal-panel" [style.flex]="'0 0 ' + terminalHeight() + '%'">
              <div class="terminal-header">
                <div class="terminal-header-left">
                  <iconify-icon icon="mdi:console" width="14"></iconify-icon>
                  <span>{{ 'CODE_EDITOR.Terminal' | translate }}</span>
                </div>
                <div class="terminal-header-right">
                  <button class="icon-btn" (click)="toggleTerminal()" [attr.aria-label]="'CODE_EDITOR.Hide terminal' | translate">
                    <iconify-icon icon="mdi:close" width="14"></iconify-icon>
                  </button>
                </div>
              </div>
              <div class="terminal-body">
                <app-session-terminal [sessionId]="sessionId" #terminalRef></app-session-terminal>
              </div>
            </div>
          }
        </div>
      </div>

      <!-- ====== FILE CONTEXT MENU ====== -->
      @if (ctxNode()) {
        <div class="ctx-backdrop" (click)="closeCtxMenu()" (contextmenu)="closeCtxMenu()"></div>
        <div class="ctx-menu" [style.left.px]="ctxPos().x" [style.top.px]="ctxPos().y">
          @if (!ctxNode()!.isDir) {
            <button class="ctx-item" (click)="ctxOpenFile()">
              <iconify-icon icon="mdi:file-document-outline" width="14"></iconify-icon> {{ 'CODE_EDITOR.Open' | translate }}
            </button>
          }
          <button class="ctx-item" (click)="ctxCopyPath()">
            <iconify-icon icon="mdi:content-copy" width="14"></iconify-icon> {{ 'CODE_EDITOR.Copy path' | translate }}
          </button>
          <button class="ctx-item" (click)="ctxCopyRelativePath()">
            <iconify-icon icon="mdi:file-link-outline" width="14"></iconify-icon> {{ 'CODE_EDITOR.Copy relative path' | translate }}
          </button>
          <button class="ctx-item" (click)="ctxCopyName()">
            <iconify-icon icon="mdi:text-short" width="14"></iconify-icon> {{ 'CODE_EDITOR.Copy name' | translate }}
          </button>
          <div class="ctx-separator"></div>
          <button class="ctx-item" (click)="ctxRevealInFinder()">
            <iconify-icon icon="mdi:folder-open-outline" width="14"></iconify-icon> {{ 'CODE_EDITOR.Reveal' | translate }}
          </button>
          <button class="ctx-item" (click)="ctxOpenInTerminal()">
            <iconify-icon icon="mdi:console" width="14"></iconify-icon> {{ 'CODE_EDITOR.Open in terminal' | translate }}
          </button>
          <div class="ctx-separator"></div>
          <button class="ctx-item" (click)="ctxNewFile()">
            <iconify-icon icon="mdi:file-plus-outline" width="14"></iconify-icon> {{ 'CODE_EDITOR.New file' | translate }}
          </button>
          <button class="ctx-item" (click)="ctxNewFolder()">
            <iconify-icon icon="mdi:folder-plus-outline" width="14"></iconify-icon> {{ 'CODE_EDITOR.New folder' | translate }}
          </button>
          <div class="ctx-separator"></div>
          <button class="ctx-item" (click)="ctxRename()">
            <iconify-icon icon="mdi:pencil-outline" width="14"></iconify-icon> {{ 'CODE_EDITOR.Rename' | translate }}
          </button>
          @if (!ctxNode()!.isDir) {
            <button class="ctx-item" (click)="ctxDuplicate()">
              <iconify-icon icon="mdi:content-duplicate" width="14"></iconify-icon> {{ 'CODE_EDITOR.Duplicate' | translate }}
            </button>
          }
          <button class="ctx-item ctx-item-danger" (click)="ctxDelete()">
            <iconify-icon icon="mdi:trash-can-outline" width="14"></iconify-icon> {{ 'CODE_EDITOR.Move to trash' | translate }}
          </button>
        </div>
      }

      <!-- ====== QUICK SEARCH OVERLAY (CMD+P) ====== -->
      @if (showQuickSearch()) {
        <div class="quick-search-overlay" (click)="showQuickSearch.set(false)">
          <div class="quick-search-box" (click)="$event.stopPropagation()">
            <div class="qs-input-row">
              <iconify-icon icon="mdi:magnify" width="18"></iconify-icon>
              <input
                class="qs-input"
                [placeholder]="'CODE_EDITOR.Search files' | translate"
                [(ngModel)]="quickSearchQueryText"
                (ngModelChange)="onQuickSearchInput($event)"
                (keydown)="onQuickSearchKeydown($event)"
                #quickSearchInput
              />
            </div>
            <div class="qs-results">
              @for (result of quickSearchResults(); track result; let i = $index) {
                <div class="qs-result" [class.selected]="quickSearchIndex() === i" (click)="openQuickSearchResult(result)" (mouseenter)="quickSearchIndex.set(i)">
                  <iconify-icon [icon]="fileIcon(getFileName(result))" width="16"></iconify-icon>
                  <span class="qs-result-path">{{ result }}</span>
                </div>
              }
              @if (quickSearchResults().length === 0 && quickSearchQueryText.trim().length > 0) {
                <div class="qs-empty">{{ 'CODE_EDITOR.No files' | translate }}</div>
              }
            </div>
          </div>
        </div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    /* ─── Reset & Root ─── */
    :host { display: block; height: 100%; }

    .diff-wrapper { position: absolute; inset: 0; z-index: 2; visibility: hidden; }
    .diff-wrapper.show { visibility: visible; }
    .code-editor-root {
      position: relative;
      height: 100vh;
      width: 100vw;
      display: flex;
      flex-direction: column;
      background: var(--po-bg-1);
      color: var(--po-text-primary);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      overflow: hidden;
    }

    .code-editor-root.inline-mode {
      height: 100%;
      width: 100%;
    }

    /* ─── Top Bar ─── */
    .top-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 40px;
      padding: 0 12px;
      background: #15161e;
      border-bottom: 1px solid var(--po-border-subtle);
      flex-shrink: 0;
      gap: 8px;
      -webkit-app-region: drag;
    }
    .top-bar-left, .top-bar-right {
      display: flex;
      align-items: center;
      gap: 8px;
      -webkit-app-region: no-drag;
    }
    .top-bar-title { font-weight: 600; font-size: 0.8rem; }
    .top-bar-path {
      font-size: 0.72rem;
      color: var(--po-text-secondary);
      max-width: 500px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .save-status {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 0.72rem;
      color: var(--po-text-secondary);
    }
    .status-saved { color: var(--po-success); }
    .status-saving { color: var(--po-warning); }
    .status-unsaved { color: var(--po-warning); }
    .status-error { color: var(--po-error); }
    .close-btn {
      background: none;
      border: none;
      color: var(--po-text-secondary);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
    }
    .close-btn:hover { background: rgba(255,255,255,0.08); color: var(--po-text-primary); }

    /* ─── Main Body ─── */
    .main-body {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    /* ─── Sidebar Wrapper ─── */
    .sidebar-wrapper {
      display: flex;
      flex-shrink: 0;
    }

    /* ─── Sidebar Horizontal Tabs ─── */
    .sidebar-tabs {
      display: flex;
      background: #111219;
      border-bottom: 1px solid var(--po-border-subtle);
      flex-shrink: 0;
    }
    .sidebar-tab-btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 7px 4px;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--po-text-secondary);
      font-size: 0.72rem;
      font-weight: 500;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
      white-space: nowrap;
    }
    .sidebar-tab-btn:hover { color: var(--po-text-primary); }
    .sidebar-tab-btn.active {
      color: var(--po-text-primary);
      border-bottom-color: var(--po-info);
      flex-shrink: 0;
    }

    /* ─── Sidebar ─── */
    .sidebar {
      width: 240px;
      min-width: 180px;
      background: #15161e;
      border-right: 1px solid var(--po-border-subtle);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .sidebar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--po-text-secondary);
      border-bottom: 1px solid var(--po-border-subtle);
      flex-shrink: 0;
    }
    .sidebar-title {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .icon-btn {
      background: none;
      border: none;
      color: var(--po-text-secondary);
      cursor: pointer;
      padding: 2px;
      border-radius: 3px;
      display: flex;
      align-items: center;
    }
    .icon-btn:hover { color: var(--po-text-primary); background: rgba(255,255,255,0.06); }

    /* ─── File Tree ─── */
    .file-tree {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      scrollbar-width: thin;
      scrollbar-color: var(--po-border-subtle) transparent;
    }
    .tree-loading {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 16px;
      font-size: 0.78rem;
      color: var(--po-text-secondary);
    }
    .tree-node {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      cursor: pointer;
      font-size: 0.78rem;
      white-space: nowrap;
      border-left: 2px solid transparent;
    }
    .tree-node:hover { background: rgba(255,255,255,0.04); }
    .tree-node.active {
      background: rgba(88,166,255,0.1);
      border-left-color: var(--po-info);
    }
    .tree-node.focused {
      background: rgba(88,166,255,0.16);
      outline: 1px solid rgba(88,166,255,0.45);
      outline-offset: -1px;
    }
    .file-tree:focus { outline: none; }
    .node-chevron {
      flex-shrink: 0;
      color: var(--po-text-tertiary);
      transition: transform 0.15s ease;
    }
    .tree-node:hover .node-chevron { color: var(--po-text-primary); }
    .node-chevron-spacer { width: 16px; flex-shrink: 0; }
    .node-icon { flex-shrink: 0; }
    .folder-icon { color: var(--po-text-secondary); }
    .node-name { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
    .node-name.is-dir { color: var(--po-text-primary); font-weight: 500; }

    /* ─── Git Status ─── */
    .git-modified .node-name { color: var(--po-warning); }
    .git-added .node-name { color: var(--po-success); }
    .git-deleted .node-name { color: var(--po-error); text-decoration: line-through; }
    .git-ignored .node-name { color: var(--po-text-tertiary); opacity: 0.55; }
    .git-ignored .node-icon { opacity: 0.55; }
    .git-ignored .folder-icon { opacity: 0.55; }
    .git-badge {
      flex-shrink: 0;
      font-size: 0.6rem;
      font-weight: 700;
      padding: 0 4px;
      border-radius: 3px;
      line-height: 1.4;
      margin-left: auto;
    }
    .git-badge-M { color: var(--po-warning); background: var(--po-warning-bg); }
    .git-badge-A { color: var(--po-success); background: var(--po-success-bg); }
    .git-badge-D { color: var(--po-error); background: var(--po-error-bg); }
    .git-badge-R { color: #a371f7; background: rgba(163,113,247,0.12); }

    /* ─── Search Panel ─── */
    .search-panel {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .search-field-row {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
    }
    .search-field-wrap {
      flex: 1;
      position: relative;
      display: flex;
      align-items: center;
    }
    .search-input {
      width: 100%;
      padding: 5px 8px;
      padding-right: 24px;
      background: var(--po-bg-1);
      border: 1px solid var(--po-border-subtle);
      border-radius: 4px;
      color: var(--po-text-primary);
      font-size: 0.78rem;
      outline: none;
    }
    .search-input:focus { border-color: var(--po-info); }
    .search-input::placeholder { color: var(--po-text-tertiary); }
    .search-clear-btn {
      position: absolute;
      right: 4px;
      background: none;
      border: none;
      color: var(--po-text-tertiary);
      cursor: pointer;
      padding: 2px;
      display: flex;
      align-items: center;
      border-radius: 3px;
    }
    .search-clear-btn:hover { color: var(--po-text-primary); }
    .replace-btn { flex-shrink: 0; padding: 3px; }

    /* ─── Search Option Buttons ─── */
    .search-options-row {
      display: flex;
      gap: 2px;
      padding: 0 8px 4px;
    }
    .search-option-btn {
      background: none;
      border: 1px solid var(--po-border-subtle);
      border-radius: 4px;
      color: var(--po-text-tertiary);
      cursor: pointer;
      padding: 2px 6px;
      font-size: 0.68rem;
      font-weight: 600;
      font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
      line-height: 1.3;
      transition: all 0.12s;
    }
    .search-option-btn:hover { color: var(--po-text-primary); border-color: var(--po-text-tertiary); }
    .search-option-btn.active {
      color: #fff;
      background: var(--po-info);
      border-color: var(--po-info);
    }
    .whole-word-icon {
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .search-count-badge {
      background: var(--po-info);
      color: #fff;
      font-size: 0.6rem;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 8px;
      min-width: 18px;
      text-align: center;
    }
    .search-nav-bar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px 4px;
      border-bottom: 1px solid var(--po-border-subtle);
    }
    .search-nav-count {
      flex: 1;
      font-size: 0.68rem;
      color: var(--po-text-secondary);
    }

    /* ─── Search Results ─── */
    .search-results-list {
      flex: 1;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--po-border-subtle) transparent;
    }
    .sr-group-header {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 4px 8px;
      cursor: pointer;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--po-text-primary);
    }
    .sr-group-header:hover { background: rgba(255,255,255,0.04); }
    .sr-group-name { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sr-group-path {
      flex: 1 1 0;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: rtl;
      text-align: left;
      font-size: 0.65rem;
      font-weight: 400;
      color: var(--po-text-tertiary);
    }
    .sr-truncated { margin-left: 2px; color: var(--po-warning, #e0a030); font-weight: 700; cursor: help; }
    .sr-group-count {
      font-size: 0.6rem;
      color: var(--po-text-secondary);
      background: rgba(255,255,255,0.06);
      padding: 0 5px;
      border-radius: 8px;
      font-weight: 600;
    }
    .search-result-item {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 2px 8px 2px 32px;
      font-size: 0.72rem;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
    }
    .search-result-item:hover { background: rgba(255,255,255,0.04); }
    .search-result-item.sr-active { background: var(--po-accent-muted-bg); }
    .sr-line-num {
      color: var(--po-text-tertiary);
      font-size: 0.65rem;
      min-width: 24px;
      text-align: right;
      flex-shrink: 0;
    }
    .sr-col { color: var(--po-text-tertiary); opacity: 0.7; font-size: 0.6rem; }
    .sr-text { color: var(--po-text-primary); overflow: hidden; text-overflow: ellipsis; font-family: var(--po-font-mono, ui-monospace, monospace); white-space: pre; }
    .sr-pre { color: var(--po-text-secondary); }
    .sr-match {
      background: var(--po-accent-muted-bg, rgba(99, 102, 241, 0.22));
      color: var(--po-text-primary);
      border-radius: 2px;
      padding: 0 1px;
      font-weight: 600;
      box-shadow: inset 0 -1px 0 var(--po-info, #6366f1);
    }
    .search-result-item.sr-active .sr-match { background: var(--po-info, #6366f1); color: #fff; }
    .search-empty { padding: 16px; text-align: center; color: var(--po-text-tertiary); font-size: 0.78rem; }

    /* ─── Editor + Terminal Wrapper ─── */
    .editor-terminal-wrapper {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 0;
    }

    /* ─── Editor Area ─── */
    .editor-area {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-height: 120px;
    }

    /* ─── Tabs ─── */
    .tabs-bar {
      display: flex;
      align-items: stretch;
      background: #15161e;
      border-bottom: 1px solid var(--po-border-subtle);
      flex-shrink: 0;
      height: 36px;
    }
    .tabs-scroll {
      display: flex;
      overflow-x: auto;
      scrollbar-width: none;
      flex: 1;
    }
    .tabs-scroll::-webkit-scrollbar { display: none; }
    .tabs-actions {
      display: flex;
      align-items: center;
      padding: 0 8px;
      gap: 4px;
      flex-shrink: 0;
    }
    .terminal-toggle-btn {
      padding: 4px;
    }
    .tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 12px;
      font-size: 0.75rem;
      cursor: pointer;
      white-space: nowrap;
      border-bottom: 2px solid transparent;
      color: var(--po-text-secondary);
      position: relative;
    }
    .tab:hover { background: rgba(255,255,255,0.04); color: var(--po-text-primary); }
    .tab.active {
      color: var(--po-text-primary);
      border-bottom-color: var(--po-info);
      background: var(--po-bg-1);
    }
    .tab-name { max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
    .modified-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--po-warning);
      flex-shrink: 0;
    }
    .tab-close {
      background: none;
      border: none;
      color: var(--po-text-tertiary);
      cursor: pointer;
      padding: 0;
      display: flex;
      align-items: center;
      border-radius: 3px;
    }
    .tab-close:hover { color: var(--po-text-primary); background: rgba(255,255,255,0.1); }

    /* ─── Monaco Wrapper ─── */
    .editor-canvas {
      position: relative;
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
    }
    .monaco-wrapper {
      flex: 1;
      overflow: hidden;
      min-height: 0;
    }

    .editor-empty {
      position: absolute;
      inset: 0;
      background: #1e1f27;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--po-text-tertiary);
      gap: 12px;
      font-size: 0.85rem;
      z-index: 2;
    }
    .editor-empty kbd {
      background: var(--po-border-subtle);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.75rem;
      color: var(--po-text-secondary);
    }

    /* ─── PDF preview (native WebView viewer) ─── */
    .pdf-preview-pane {
      position: absolute;
      inset: 0;
      z-index: 2;
      background: #1e1f27;
    }
    .pdf-preview-pane iframe {
      width: 100%;
      height: 100%;
      border: 0;
    }

    /* ─── Image preview (raster files) ─── */
    .image-preview-pane {
      position: absolute;
      inset: 0;
      z-index: 2;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 24px;
      background: repeating-conic-gradient(#23242e 0% 25%, #1e1f27 0% 50%) 0 0 / 20px 20px;
    }
    .image-preview-pane img {
      max-width: 90%;
      max-height: 85%;
      object-fit: contain;
      border: 1px solid var(--po-border-subtle);
      border-radius: 4px;
    }
    .image-preview-meta {
      font-size: 0.75rem;
      color: var(--po-text-secondary);
      background: #1e1f27;
      padding: 3px 10px;
      border-radius: 10px;
      border: 1px solid var(--po-border-subtle);
      display: flex;
      gap: 6px;
    }

    /* ─── Terminal Resize Handle ─── */
    .terminal-resize-handle {
      height: 4px;
      background: var(--po-border-subtle);
      cursor: ns-resize;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s;
    }
    .terminal-resize-handle:hover {
      background: var(--po-info);
    }
    .resize-grip {
      width: 40px;
      height: 2px;
      background: var(--po-text-tertiary);
      border-radius: 1px;
    }
    .terminal-resize-handle:hover .resize-grip {
      background: #fff;
    }

    /* ─── Terminal Panel ─── */
    .terminal-panel {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-height: 80px;
      background: var(--po-bg-1);
    }
    .terminal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 12px;
      background: #15161e;
      border-top: 1px solid var(--po-border-subtle);
      flex-shrink: 0;
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--po-text-secondary);
    }
    .terminal-header-left, .terminal-header-right {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .terminal-body {
      flex: 1;
      overflow: hidden;
      min-height: 0;
    }

    /* ─── Quick Search Overlay ─── */
    .quick-search-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 9999;
      display: flex;
      justify-content: center;
      padding-top: 80px;
    }
    .quick-search-box {
      width: 520px;
      max-height: 400px;
      background: var(--po-bg-1);
      border: 1px solid var(--po-border-subtle);
      border-radius: 8px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      align-self: flex-start;
    }
    .qs-input-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--po-border-subtle);
    }
    .qs-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: var(--po-text-primary);
      font-size: 0.9rem;
    }
    .qs-input::placeholder { color: var(--po-text-tertiary); }
    .qs-results {
      flex: 1;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--po-border-subtle) transparent;
    }
    .qs-result {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      font-size: 0.8rem;
      cursor: pointer;
    }
    .qs-result:hover, .qs-result.selected { background: rgba(88,166,255,0.1); }
    .qs-result-path { color: var(--po-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .qs-empty { padding: 16px; text-align: center; color: var(--po-text-tertiary); font-size: 0.8rem; }

    /* ─── File Context Menu ─── */
    .ctx-backdrop {
      position: fixed;
      inset: 0;
      z-index: 9998;
    }
    .ctx-menu {
      position: fixed;
      z-index: 9999;
      background: var(--po-bg-1);
      border: 1px solid var(--po-border-subtle);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      padding: 4px 0;
      min-width: 200px;
      max-width: 280px;
    }
    .ctx-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 12px;
      background: none;
      border: none;
      color: var(--po-text-primary);
      font-size: 0.78rem;
      cursor: pointer;
      text-align: left;
      white-space: nowrap;
    }
    .ctx-item:hover { background: rgba(88,166,255,0.12); }
    .ctx-item-danger { color: var(--po-error); }
    .ctx-item-danger:hover { background: var(--po-error-bg); }
    .ctx-separator {
      height: 1px;
      background: var(--po-border-subtle);
      margin: 4px 0;
    }

    /* ─── Rename Input ─── */
    .rename-input {
      flex: 1;
      background: var(--po-bg-1);
      border: 1px solid var(--po-info);
      border-radius: 3px;
      color: var(--po-text-primary);
      font-size: 0.78rem;
      padding: 1px 6px;
      outline: none;
      min-width: 0;
    }

    /* ─── Utilities ─── */
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `,
})
export class SessionCodeEditorComponent implements OnInit, OnDestroy, AfterViewInit {
  modal = inject(NgbActiveModal, { optional: true });
  private modalService = inject(NgbModal);
  private gitService = inject(GitService);
  private sessionService = inject(SessionService);
  private zone = inject(NgZone);
  private swal = inject(SwalService);
  private translate = inject(TranslateService);
  private sanitizer = inject(DomSanitizer);

  inline = input(false);
  visible = input(true);

  @ViewChild('monacoContainer') monacoContainerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('diffContainer') diffContainerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('quickSearchInput') quickSearchInputEl!: ElementRef<HTMLInputElement>;
  @ViewChild('fileTreeEl') fileTreeEl?: ElementRef<HTMLDivElement>;
  @ViewChild('globalSearchInput') globalSearchInputEl!: ElementRef<HTMLInputElement>;
  @ViewChild('terminalRef') terminalRef?: SessionTerminalComponent;

  /** Set by parent — workspace path */
  private _cwd = '';
  @Input() set cwd(val: string) {
    if (this._cwd === val) return;
    this.persistWorkspaceState();
    this._cwd = val;
    this.stateRestoredFor = null;
    this.treeFetchToken++; // invalidate any in-flight tree fetch
    this.pendingFolderFetches.clear();
    this.restartFsWatcher();
    if (val) this.loadFileTree();
  }
  get cwd(): string { return this._cwd; }

  /** Monotonic token bumped on cwd change / refresh — used to drop stale fetches. */
  private treeFetchToken = 0;
  /** Folder paths with an in-flight shallow fetch (dedup rapid expand clicks). */
  private pendingFolderFetches = new Set<string>();
  /** Cached natural-numeric collator for renderer-side sorting. */
  private readonly treeCollator = new Intl.Collator(undefined, {
    sensitivity: 'base',
    numeric: true,
  });
  /** Disposer for the active FS-watch IPC listener. */
  private fsWatchUnsubscribe: (() => void) | null = null;
  /** Coalesces watcher bursts on the renderer side before refresh work. */
  private fsWatchFlushTimer: any = null;
  /** Set of changed relative paths waiting to be applied. */
  private fsWatchPendingPaths = new Set<string>();
  /** cwd the backend watcher was started on (stop only that one, not every session's). */
  private fsWatchCwd: string | null = null;
  /** Trailing throttle for `git status` after FS bursts — expensive on large repos. */
  private gitRefreshTimer: any = null;
  private lastGitRefresh = 0;

  /** Editor keystrokes → openFiles sync is debounced: getValue() on big files per key is costly. */
  private contentSyncTimer: any = null;
  private contentSyncPath: string | null = null;
  /** Single gutter-diff collection, re-set per file instead of stacking new ones. */
  private gutterDecorations: any = null;

  /* ── Diff with HEAD ── */
  diffMode = signal(false);
  private diffEditor: any = null;
  private diffOriginalModel: any = null;
  private diffResizeObserver: ResizeObserver | null = null;
  private diffSeq = 0;
  canDiffActive = computed(() => {
    const af = this.activeFile();
    if (!af || (af.kind ?? 'text') !== 'text') return false;
    if (!api()?.gitFileAtHead) return false;
    return this.diffMode() || !!this.gitStatusMap().get(af.path);
  });

  /* ── Per-workspace state (open tabs, expanded folders, cursor/scroll) ── */
  private stateRestoredFor: string | null = null;
  private persistTimer: any = null;
  private readonly persistEffect = effect(() => {
    this.openFiles();
    this.activeFilePath();
    this.fileTree();
    if (this.stateRestoredFor !== this._cwd) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistWorkspaceState(), 800);
  });

  /** Set by parent — session ID for terminal */
  @Input() sessionId = '';

  /* ── Monaco Editor Instance ── */
  private editor: any = null;
  private editorModels = new Map<string, any>(); // path → ITextModel
  private monacoReady = false;
  private pendingFileSwitch: string | null = null;

  /* ── State Signals ── */
  openFiles = signal<OpenFile[]>([]);
  activeFilePath = signal<string | null>(null);
  fileTree = signal<FileNode[]>([]);
  /** First open of a workspace: whole-editor system loader instead of the tree spinner. */
  booting = computed(() => this.loading() && this.fileTree().length === 0);
  focusedTreePath = signal<string | null>(null);
  loading = signal(false);
  saveStatus = signal<'saved' | 'saving' | 'unsaved' | 'error'>('saved');

  /* Terminal */
  terminalVisible = signal(false);
  terminalHeight = signal(30); // percentage

  /* Git status map */
  gitStatusMap = signal<Map<string, string>>(new Map());

  /* Quick search (CMD+P) */
  showQuickSearch = signal(false);
  quickSearchQueryText = '';
  quickSearchResults = signal<string[]>([]);
  quickSearchIndex = signal(0);

  /* Sidebar tab */
  sidebarTab = signal<'explorer' | 'search'>('explorer');

  /* Search options */
  searchMatchCase = signal(false);
  searchWholeWord = signal(false);
  searchUseRegex = signal(false);

  /* Global search (CMD+SHIFT+F) */
  showGlobalSearch = signal(false);
  globalSearchQuery = '';
  replaceQuery = '';
  globalSearchResults = signal<SearchResult[]>([]);
  searchResultGroups = signal<SearchResultGroup[]>([]);
  searchActiveIndex = signal(0);
  searchLoading = signal(false);
  searchTruncated = signal(false);
  /** Monotonic token so a slow, older search can't overwrite a newer one's results. */
  private globalSearchSeq = 0;

  /* Context menu */
  ctxNode = signal<FileNode | null>(null);
  ctxPos = signal<{ x: number; y: number }>({ x: 0, y: 0 });

  /* Rename inline */
  renameTarget = signal<FileNode | null>(null);

  private quickSearchDebounce: any;
  /** Stale-response guard: only the latest query issued may write the results. */
  private quickSearchSeq = 0;
  private globalSearchDebounce: any;
  private editorResizeObserver: ResizeObserver | null = null;

  /* ── Computed ── */

  activeFile = computed(() => {
    const path = this.activeFilePath();
    return this.openFiles().find(f => f.path === path) ?? null;
  });

  /* ── Image preview ── */

  imagePreviewDims = signal<string | null>(null);

  onPreviewImgLoad(evt: Event): void {
    const img = evt.target as HTMLImageElement;
    this.imagePreviewDims.set(`${img.naturalWidth}×${img.naturalHeight}`);
  }

  formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  flatTree = computed(() => {
    const result: FileNode[] = [];
    const walk = (nodes: FileNode[]) => {
      for (const node of nodes) {
        result.push(node);
        if (node.isDir && node.expanded && node.children) {
          walk(node.children);
        }
      }
    };
    walk(this.fileTree());
    return result;
  });

  /* ── Exposed helpers for template ── */
  fileIcon = fileIcon;
  folderIcon = folderIcon;

  /* ── Lifecycle ── */

  ngOnInit(): void {}

  ngAfterViewInit(): void {
    // Init Monaco eagerly: container is now always in DOM, so the ViewChild
    // is guaranteed available here. Files clicked before the Monaco script
    // finishes loading are queued via pendingFileSwitch and resumed in initMonaco.
    this.initMonaco();
  }

  ngOnDestroy(): void {
    if (this.quickSearchDebounce) clearTimeout(this.quickSearchDebounce);
    if (this.globalSearchDebounce) clearTimeout(this.globalSearchDebounce);
    if (this.fsWatchFlushTimer) clearTimeout(this.fsWatchFlushTimer);
    if (this.gitRefreshTimer) clearTimeout(this.gitRefreshTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.flushContentSync();
    this.persistWorkspaceState();
    this.editorResizeObserver?.disconnect();
    this.disposeDiff();
    this.stopFsWatcher();
    this.disposeEditor();
    for (const f of this.openFiles()) if (f.pdfBlobUrl) URL.revokeObjectURL(f.pdfBlobUrl);
  }

  /* ── FS Watcher ── */

  private restartFsWatcher(): void {
    this.stopFsWatcher();
    if (!this._cwd) return;
    const bridge = api();
    if (!bridge?.fsWatchStart || !bridge?.onFsWatchEvent) return;

    this.fsWatchUnsubscribe = bridge.onFsWatchEvent((payload: { cwd: string; paths: string[] }) => {
      if (payload.cwd !== this._cwd) return;
      for (const p of payload.paths) this.fsWatchPendingPaths.add(p);
      if (this.fsWatchFlushTimer) return;
      // Debounce again on the renderer side — bursts of small events become one update.
      this.fsWatchFlushTimer = setTimeout(() => {
        this.fsWatchFlushTimer = null;
        const batch = Array.from(this.fsWatchPendingPaths);
        this.fsWatchPendingPaths.clear();
        this.applyExternalFsChanges(batch);
      }, 120);
    });

    this.fsWatchCwd = this._cwd;
    bridge.fsWatchStart(this._cwd).catch(() => { /* renderer keeps working without watch */ });
  }

  private stopFsWatcher(): void {
    this.fsWatchPendingPaths.clear();
    if (this.fsWatchFlushTimer) {
      clearTimeout(this.fsWatchFlushTimer);
      this.fsWatchFlushTimer = null;
    }
    if (this.fsWatchUnsubscribe) {
      try { this.fsWatchUnsubscribe(); } catch { /* noop */ }
      this.fsWatchUnsubscribe = null;
    }
    if (!this.fsWatchCwd) return;
    const bridge = api();
    bridge?.fsWatchStop?.(this.fsWatchCwd)?.catch?.(() => { /* noop */ });
    this.fsWatchCwd = null;
  }

  /**
   * Apply a batch of externally-changed paths to the live tree and to open editors.
   * - Folder cache is invalidated only for *currently visible* parents so we don't
   *   blow away children the user never expanded.
   * - Open files that are not locally modified are reloaded from disk.
   */
  private async applyExternalFsChanges(paths: string[]): Promise<void> {
    if (!paths.length || !this._cwd) return;
    const bridge = api();
    if (!bridge?.fsListDirShallow) return;

    // 1) Collect parent folders that need re-listing (only those currently loaded).
    const parents = new Set<string>();
    let rootDirty = false;
    for (const p of paths) {
      const norm = p.replace(/[/\\]+$/, '');
      const sepIdx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
      const parent = sepIdx === -1 ? '' : norm.slice(0, sepIdx);
      if (parent === '') rootDirty = true;
      else parents.add(parent);
    }

    // 2) Refresh parents in parallel, but only ones we have loaded.
    const tree = this.fileTree();
    const refreshTasks: Promise<void>[] = [];

    if (rootDirty) {
      refreshTasks.push((async () => {
        const res = await bridge.fsListDirShallow(this._cwd, '');
        if (!res?.ok || !Array.isArray(res.entries)) return;
        const expanded = this.collectExpandedPaths(this.fileTree());
        this.fileTree.set(this.buildShallowNodes(res.entries, 0));
        if (expanded.length) await this.reexpandPaths(expanded);
      })());
    }

    for (const parent of parents) {
      const node = this.findNode(tree, parent);
      if (!node || !node.isDir) continue;
      if (node.children === undefined) continue; // never loaded — skip, will refetch on next expand
      refreshTasks.push((async () => {
        const res = await bridge.fsListDirShallow(this._cwd, parent);
        if (!res?.ok || !Array.isArray(res.entries)) return;
        const wasExpanded = node.expanded;
        const subExpanded = node.children
          ? this.collectExpandedPaths(node.children)
          : [];
        const kids = this.buildShallowNodes(res.entries, node.level + 1);
        this.updateNode(parent, n => ({ ...n, expanded: wasExpanded, children: kids }));
        if (subExpanded.length) await this.reexpandPaths(subExpanded);
      })());
    }

    await Promise.all(refreshTasks);

    // 3) Reload open files that changed externally and have no local edits.
    const changedSet = new Set(paths);
    const open = this.openFiles();
    for (const f of open) {
      if (!changedSet.has(f.path)) continue;
      if (f.modified) continue; // user has local edits — never silently overwrite
      if (f.kind === 'pdf') {
        // An agent regenerated the PDF: swap in the new bytes (old blob revoked).
        try { await this.reloadPdfTab(f.path); } catch { /* keep last-known preview */ }
        continue;
      }
      if ((f.kind ?? 'text') !== 'text') continue; // images/binary: no text to reload
      try {
        const r = await api().fsReadFile(this._cwd, f.path);
        if (!r?.ok) continue;
        this.openFiles.update(list => list.map(of =>
          of.path === f.path
            ? { ...of, content: r.content, originalContent: r.content, modified: false }
            : of,
        ));
        // Sync the Monaco model in-place so the cursor & selection survive.
        const model = this.editorModels.get(f.path);
        if (model && model.getValue() !== r.content) {
          model.setValue(r.content);
        }
      } catch { /* keep last-known content */ }
    }

    // 4) Refresh git status badges — throttled: agents write in bursts and
    //    `git status` on a large repo costs far more than the listing.
    this.scheduleGitRefresh();
    if (this.diffMode() && this.activeFilePath() && changedSet.has(this.activeFilePath()!)) {
      this.refreshDiff();
    }
  }

  private scheduleGitRefresh(): void {
    if (this.gitRefreshTimer) return;
    const wait = Math.max(0, 1500 - (Date.now() - this.lastGitRefresh));
    this.gitRefreshTimer = setTimeout(async () => {
      this.gitRefreshTimer = null;
      this.lastGitRefresh = Date.now();
      const token = this.treeFetchToken;
      await this.loadGitStatus();
      if (token === this.treeFetchToken) this.applyGitStatusToTree();
    }, wait);
  }

  private disposeEditor(): void {
    this.editorModels.forEach(model => model.dispose());
    this.editorModels.clear();
    this.editor?.dispose();
    this.editor = null;
    this.monacoReady = false;
  }

  /* ── Monaco Init ── */

  private async initMonaco(): Promise<void> {
    await loadMonaco();
    const monaco = (window as any).monaco;
    if (!monaco || !this.monacoContainerRef) return;

    this.editor = monaco.editor.create(this.monacoContainerRef.nativeElement, {
      theme: 'promptops-dark',
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, 'Courier New', monospace",
      fontLigatures: true,
      lineHeight: 20,
      minimap: { enabled: true, maxColumn: 80 },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      padding: { top: 8, bottom: 8 },
      automaticLayout: false, // We'll handle this manually
      bracketPairColorization: { enabled: true },
      guides: {
        bracketPairs: true,
        indentation: true,
      },
      suggest: {
        preview: true,
        showMethods: true,
        showFunctions: true,
        showVariables: true,
        showWords: true,
      },
      wordWrap: 'off',
      tabSize: 2,
      insertSpaces: true,
      renderWhitespace: 'selection',
      folding: true,
      links: true,
      colorDecorators: true,
      contextmenu: true,
      formatOnPaste: true,
      formatOnType: false,
    });

    // Listen for content changes
    this.editor.onDidChangeModelContent(() => {
      const path = this.pathOfModel(this.editor?.getModel());
      if (!path) return;
      if (this.contentSyncPath && this.contentSyncPath !== path) this.flushContentSync();
      this.contentSyncPath = path;
      if (this.contentSyncTimer) clearTimeout(this.contentSyncTimer);
      this.contentSyncTimer = setTimeout(() => this.zone.run(() => this.flushContentSync()), 150);
    });

    // ⌥⌘D: compare with HEAD
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyD, () => {
      this.zone.run(() => { if (this.canDiffActive()) this.toggleDiff(); });
    });

    // Handle save shortcut in Monaco (already captured by HostListener, but belt-and-suspenders)
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      this.zone.run(() => this.saveCurrentFile());
    });

    // Observe container resize for editor layout updates
    this.editorResizeObserver = new ResizeObserver(() => {
      this.editor?.layout();
    });
    this.editorResizeObserver.observe(this.monacoContainerRef.nativeElement);

    this.monacoReady = true;

    // If a file was pending while Monaco was loading, switch to it now
    if (this.pendingFileSwitch) {
      this.switchEditorModel(this.pendingFileSwitch);
      this.pendingFileSwitch = null;
    }
  }

  private switchEditorModel(path: string): void {
    if (!this.monacoReady || !this.editor) {
      this.pendingFileSwitch = path;
      return;
    }

    const monaco = (window as any).monaco;
    const file = this.openFiles().find(f => f.path === path);
    if (!file) return;

    // Get or create model
    let model = this.editorModels.get(path);
    if (!model) {
      // Uri.from keeps the path verbatim: Uri.parse read `#`, `?` and `%` in a
      // file name as fragment/query/escapes, so `C#/Program.cs` became a model
      // for `C` and edits to it were never marked dirty nor saved.
      const uri = monaco.Uri.from({ scheme: 'file', path: '/' + path });
      // Check if model already exists (can happen if Monaco created it)
      model = monaco.editor.getModel(uri);
      if (!model) {
        model = monaco.editor.createModel(file.content, file.language, uri);
      }
      this.editorModels.set(path, model);
    }

    this.flushContentSync();
    // Save view state of current model before switching
    const currentPath = this.editor.getModel()?.uri?.path;
    if (currentPath) {
      const viewState = this.editor.saveViewState();
      if (viewState) {
        this.viewStates.set(currentPath, viewState);
      }
    }

    this.editor.setModel(model);

    // Restore view state if we have one
    const viewState = this.viewStates.get('/' + path);
    if (viewState) {
      this.editor.restoreViewState(viewState);
    }

    this.editor.focus();

    // Apply diff decorations
    this.applyDiffDecorations(path);
    if (this.diffMode()) this.refreshDiff();
  }

  private pathOfModel(model: any): string | null {
    const p: string | undefined = model?.uri?.path;
    return p ? p.slice(1) : null;
  }

  /** Push the pending editor content into openFiles (dirty flag, save, search). */
  private flushContentSync(): void {
    if (this.contentSyncTimer) {
      clearTimeout(this.contentSyncTimer);
      this.contentSyncTimer = null;
    }
    const path = this.contentSyncPath;
    this.contentSyncPath = null;
    if (!path) return;
    const model = this.editorModels.get(path);
    if (!model || model.isDisposed?.()) return;
    const value = model.getValue();
    this.openFiles.update(files =>
      files.map(f =>
        f.path === path
          ? { ...f, content: value, modified: value !== f.originalContent }
          : f
      )
    );
    this.updateSaveStatus();
  }

  /* ── Diff with HEAD ── */

  toggleDiff(): void {
    if (this.diffMode()) {
      this.closeDiff();
      return;
    }
    this.diffMode.set(true);
    this.refreshDiff();
  }

  closeDiff(): void {
    this.diffMode.set(false);
    this.diffSeq++;
    this.diffEditor?.setModel(null);
    this.diffOriginalModel?.dispose();
    this.diffOriginalModel = null;
    this.editor?.focus();
  }

  private async refreshDiff(): Promise<void> {
    const path = this.activeFilePath();
    const monaco = (window as any).monaco;
    const bridge = api();
    if (!path || !monaco || !this.monacoReady || !bridge?.gitFileAtHead || !this.isTextFile(path)) {
      this.closeDiff();
      return;
    }
    const model = this.editorModels.get(path);
    if (!model) return;
    const seq = ++this.diffSeq;
    let res: any;
    try { res = await bridge.gitFileAtHead(this.cwd, path); } catch { res = null; }
    if (seq !== this.diffSeq || !this.diffMode() || this.activeFilePath() !== path) return;
    if (!res?.ok) {
      this.closeDiff();
      this.swal.error(res?.error || this.translate.instant('CODE_EDITOR.Head read failed'));
      return;
    }

    if (!this.diffEditor) {
      this.diffEditor = monaco.editor.createDiffEditor(this.diffContainerRef.nativeElement, {
        theme: 'promptops-dark',
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, 'Courier New', monospace",
        lineHeight: 20,
        automaticLayout: false,
        renderSideBySide: true,
        originalEditable: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        // Big files: fold unchanged regions and cap diff computation time.
        hideUnchangedRegions: { enabled: true },
        maxComputationTime: 2000,
        maxFileSize: 20,
      });
      this.diffResizeObserver = new ResizeObserver(() => this.diffEditor?.layout());
      this.diffResizeObserver.observe(this.diffContainerRef.nativeElement);
    }

    const prevOriginal = this.diffOriginalModel;
    this.diffOriginalModel = monaco.editor.createModel(res.content ?? '', model.getLanguageId());
    // The modified side is the live model: edits in the diff are the real file.
    this.diffEditor.setModel({ original: this.diffOriginalModel, modified: model });
    prevOriginal?.dispose();
    this.diffEditor.layout();
  }

  private disposeDiff(): void {
    this.diffResizeObserver?.disconnect();
    this.diffResizeObserver = null;
    this.diffEditor?.setModel(null);
    this.diffEditor?.dispose();
    this.diffEditor = null;
    this.diffOriginalModel?.dispose();
    this.diffOriginalModel = null;
  }

  /* ── Workspace state persistence ── */

  private stateKey(cwd: string): string {
    return 'po.codeEditor.ws:' + cwd;
  }

  private persistWorkspaceState(): void {
    const cwd = this._cwd;
    if (!cwd || this.stateRestoredFor !== cwd) return;
    try {
      const current = this.pathOfModel(this.editor?.getModel());
      if (current && this.editor) {
        const vs = this.editor.saveViewState();
        if (vs) this.viewStates.set('/' + current, vs);
      }
      const open = this.openFiles()
        .filter(f => (f.kind ?? 'text') === 'text')
        .slice(-MAX_RESTORED_TABS)
        .map(f => f.path);
      const views: Record<string, any> = {};
      for (const p of open) {
        const vs = this.viewStates.get('/' + p);
        if (vs) views[p] = vs;
      }
      const state = {
        open,
        active: this.activeFilePath(),
        expanded: this.collectExpandedPaths(this.fileTree()).slice(0, 200),
        views,
      };
      localStorage.setItem(this.stateKey(cwd), JSON.stringify(state));
    } catch { /* storage full/blocked — state is a convenience */ }
  }

  /** Reopen tabs + folders of the last visit. Tabs are read in parallel; only the active one gets a model. */
  private async restoreWorkspaceState(token: number): Promise<void> {
    const cwd = this._cwd;
    let state: any = null;
    try { state = JSON.parse(localStorage.getItem(this.stateKey(cwd)) || 'null'); } catch { state = null; }
    if (!state || token !== this.treeFetchToken) {
      if (token === this.treeFetchToken) this.stateRestoredFor = cwd;
      return;
    }
    try {
      const views = state.views && typeof state.views === 'object' ? state.views : {};
      for (const p of Object.keys(views)) this.viewStates.set('/' + p, views[p]);

      const bridge = api();
      const paths: string[] = Array.isArray(state.open)
        ? state.open.filter((p: any) => typeof p === 'string' && !isRasterImagePath(p) && !isPdfPath(p)).slice(-MAX_RESTORED_TABS)
        : [];
      const alreadyOpen = new Set(this.openFiles().map(f => f.path));
      const reads = await Promise.all(paths.map(async (p) => {
        if (alreadyOpen.has(p)) return null;
        try {
          const r = await bridge.fsReadFile(cwd, p);
          if (!r?.ok) return null;
          const name = this.getFileName(p);
          return { path: p, name, content: r.content, originalContent: r.content, modified: false, language: detectLanguage(name) } as OpenFile;
        } catch { return null; }
      }));
      if (token !== this.treeFetchToken) return;
      const restored = reads.filter((f): f is OpenFile => !!f);
      if (restored.length) {
        this.openFiles.update(list => [...list, ...restored]);
        if (!this.activeFilePath()) {
          const active = restored.find(f => f.path === state.active)?.path ?? restored[restored.length - 1].path;
          this.activeFilePath.set(active);
          this.switchEditorModel(active);
        }
        this.updateSaveStatus();
      }

      const expanded: string[] = Array.isArray(state.expanded) ? state.expanded.filter((p: any) => typeof p === 'string') : [];
      if (expanded.length) await this.reexpandPaths(expanded);
    } finally {
      if (token === this.treeFetchToken) this.stateRestoredFor = cwd;
    }
  }

  private viewStates = new Map<string, any>();

  private applyDiffDecorations(path: string): void {
    const gitStatus = this.gitStatusMap().get(path);
    if (!this.editor) return;

    // Load diff asynchronously and apply decorations
    this.loadLineDiff(path).then(diffMap => {
      if (!diffMap || !this.editor || this.activeFilePath() !== path) return;

      const monaco = (window as any).monaco;
      const decorations: any[] = [];

      diffMap.forEach((type, lineNum) => {
        let className = '';
        let glyphClassName = '';
        if (type === 'added') {
          className = 'line-added-bg';
          glyphClassName = 'glyph-added';
        } else if (type === 'modified') {
          className = 'line-modified-bg';
          glyphClassName = 'glyph-modified';
        } else if (type === 'deleted-below') {
          className = 'line-deleted-bg';
          glyphClassName = 'glyph-deleted';
        }

        decorations.push({
          range: new monaco.Range(lineNum, 1, lineNum, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: glyphClassName,
            overviewRuler: {
              color: type === 'added' ? '#3fb950' : type === 'modified' ? '#d29922' : '#f85149',
              position: monaco.editor.OverviewRulerLane.Left,
            },
          },
        });
      });

      if (!this.gutterDecorations) this.gutterDecorations = this.editor.createDecorationsCollection();
      this.gutterDecorations.set(decorations);
    });
  }

  /* ── Keyboard shortcuts ── */

  @HostListener('document:keydown', ['$event'])
  handleKeydown(e: KeyboardEvent): void {
    if (!this.visible()) return;
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key === 'p') {
      e.preventDefault();
      this.toggleQuickSearch();
      return;
    }
    if (mod && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      this.switchToSearchTab();
      return;
    }
    if (mod && e.key === 's') {
      e.preventDefault();
      this.saveCurrentFile();
      return;
    }
    // Ctrl+` toggle terminal
    if (e.ctrlKey && e.key === '`') {
      e.preventDefault();
      this.toggleTerminal();
      return;
    }
    if (e.key === 'Escape') {
      if (this.showQuickSearch()) { this.showQuickSearch.set(false); return; }
      if (this.showGlobalSearch()) { this.showGlobalSearch.set(false); return; }
    }
  }

  /* ── Terminal ── */

  toggleTerminal(): void {
    if (!this.sessionId) return;
    this.terminalVisible.update(v => !v);
    // Re-layout Monaco after terminal toggle
    setTimeout(() => {
      this.editor?.layout();
      if (this.terminalVisible() && this.terminalRef) {
        this.terminalRef.focus();
      }
    }, 50);
  }

  onTerminalResizeStart(event: MouseEvent): void {
    event.preventDefault();
    const startY = event.clientY;
    const wrapper = (event.target as HTMLElement).closest('.editor-terminal-wrapper') as HTMLElement;
    if (!wrapper) return;
    const wrapperHeight = wrapper.getBoundingClientRect().height;
    const startPct = this.terminalHeight();

    const onMove = (e: MouseEvent) => {
      const deltaY = startY - e.clientY;
      const deltaPct = (deltaY / wrapperHeight) * 100;
      const newPct = Math.min(80, Math.max(10, startPct + deltaPct));
      this.terminalHeight.set(Math.round(newPct));
      this.editor?.layout();
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      this.editor?.layout();
    };

    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  /* ── File Tree ── */

  async loadFileTree(): Promise<void> {
    if (!this.cwd) return;
    const token = ++this.treeFetchToken;
    this.pendingFolderFetches.clear();
    this.loading.set(true);
    try {
      const bridge = api();
      // Preferred: shallow lazy-load (root only, children fetched on expand).
      if (bridge?.fsListDirShallow) {
        // Git status is slow on large repos: don't block the tree on it,
        // decorate the nodes when it lands.
        const git = this.loadGitStatus().then(() => {
          if (token === this.treeFetchToken) this.applyGitStatusToTree();
        });
        const result = await bridge.fsListDirShallow(this.cwd, '');
        if (token !== this.treeFetchToken) return; // stale — workspace changed
        if (result?.ok) {
          this.fileTree.set(this.buildShallowNodes(result.entries, 0));
        }
        void git;
        if (this.stateRestoredFor !== this.cwd) void this.restoreWorkspaceState(token);
        return;
      }
      // Legacy fallback: full recursive listing.
      if (bridge?.fsListDir) {
        const [result, _] = await Promise.all([
          bridge.fsListDir(this.cwd),
          this.loadGitStatus(),
        ]);
        if (token !== this.treeFetchToken) return;
        if (result?.ok) {
          this.fileTree.set(this.buildTree(result.tree, 0));
        }
      }
    } catch {
      // Swallow — UI already shows empty state when tree is unavailable.
    } finally {
      if (token === this.treeFetchToken) this.loading.set(false);
    }
  }

  private applyGitStatusToTree(): void {
    const gitMap = this.gitStatusMap();
    const walk = (nodes: FileNode[]): FileNode[] =>
      nodes.map(n => ({
        ...n,
        gitStatus: n.isDir ? n.gitStatus : gitMap.get(n.path),
        children: n.children ? walk(n.children) : n.children,
      }));
    this.fileTree.set(walk(this.fileTree()));
  }

  private async loadGitStatus(): Promise<void> {
    try {
      await this.gitService.refresh(this.cwd);
      const map = new Map<string, string>();
      for (const f of this.gitService.files()) {
        map.set(f.path, f.statusCode);
      }
      this.gitStatusMap.set(map);
    } catch (err) {
    }
  }

  private async loadLineDiff(filePath: string): Promise<Map<number, LineDiffType> | null> {
    const gitStatus = this.gitStatusMap().get(filePath);
    if (gitStatus === '?') {
      const af = this.openFiles().find(f => f.path === filePath);
      if (af) {
        const lc = af.content.split('\n').length;
        const map = new Map<number, LineDiffType>();
        for (let i = 1; i <= lc; i++) map.set(i, 'added');
        return map;
      }
      return null;
    }

    try {
      const bridge = api();
      if (!bridge?.gitFileDiff) return null;
      const result = await bridge.gitFileDiff(this.cwd, filePath);
      if (!result?.ok || !result.diff) return null;
      return this.parseUnifiedDiff(result.diff);
    } catch {
      return null;
    }
  }

  private parseUnifiedDiff(diff: string): Map<number, LineDiffType> {
    const map = new Map<number, LineDiffType>();
    const lines = diff.split('\n');
    let newLine = 0;

    for (const line of lines) {
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        newLine = parseInt(hunkMatch[2], 10);
        continue;
      }
      if (newLine === 0) continue;

      if (line.startsWith('+') && !line.startsWith('+++')) {
        map.set(newLine, 'added');
        newLine++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        if (!map.has(newLine)) map.set(newLine, 'deleted-below');
      } else {
        newLine++;
      }
    }

    // Second pass: detect modifications
    newLine = 0;
    let pendingRemoves = 0;

    for (const line of lines) {
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        newLine = parseInt(hunkMatch[2], 10);
        pendingRemoves = 0;
        continue;
      }
      if (newLine === 0) continue;

      if (line.startsWith('-') && !line.startsWith('---')) {
        pendingRemoves++;
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        if (pendingRemoves > 0) {
          map.set(newLine, 'modified');
          pendingRemoves--;
        }
        newLine++;
      } else {
        pendingRemoves = 0;
        newLine++;
      }
    }

    return map;
  }

  async refreshTree(): Promise<void> {
    const expanded = this.collectExpandedPaths(this.fileTree());
    await this.loadFileTree();
    if (expanded.length) await this.reexpandPaths(expanded);
  }

  private collectExpandedPaths(nodes: FileNode[]): string[] {
    const out: string[] = [];
    const walk = (ns: FileNode[]) => {
      for (const n of ns) {
        if (n.isDir && n.expanded) out.push(n.path);
        if (n.children) walk(n.children);
      }
    };
    walk(nodes);
    return out;
  }

  private findNode(nodes: FileNode[], target: string): FileNode | null {
    for (const n of nodes) {
      if (n.path === target) return n;
      if (n.children) {
        const found = this.findNode(n.children, target);
        if (found) return found;
      }
    }
    return null;
  }

  /** Expand a folder, fetching its children if needed. Never collapses. Dedup'd. */
  private async expandFolder(node: FileNode): Promise<void> {
    if (node.children !== undefined) {
      if (!node.expanded) this.updateNode(node.path, n => ({ ...n, expanded: true }));
      return;
    }
    if (this.pendingFolderFetches.has(node.path)) return;
    const bridge = api();
    if (!bridge?.fsListDirShallow) return;
    this.updateNode(node.path, n => ({ ...n, expanded: true, children: [] }));
    this.pendingFolderFetches.add(node.path);
    const token = this.treeFetchToken;
    try {
      const res = await bridge.fsListDirShallow(this.cwd, node.path);
      if (token !== this.treeFetchToken) return;
      const kids = res?.ok && Array.isArray(res.entries)
        ? this.buildShallowNodes(res.entries, node.level + 1)
        : [];
      this.updateNode(node.path, n => ({ ...n, expanded: true, children: kids }));
    } catch {
      if (token === this.treeFetchToken) {
        this.updateNode(node.path, n => ({ ...n, expanded: true, children: [] }));
      }
    } finally {
      this.pendingFolderFetches.delete(node.path);
    }
  }

  /**
   * Re-expand previously expanded folders after a refresh.
   * Sibling folders at the same depth are expanded in parallel; deeper levels wait
   * for their parents (children only become reachable once the parent is loaded).
   */
  private async reexpandPaths(paths: string[]): Promise<void> {
    const depth = (p: string) => p.split(/[/\\]/).length;
    const byDepth = new Map<number, string[]>();
    for (const p of paths) {
      const d = depth(p);
      const bucket = byDepth.get(d) ?? [];
      bucket.push(p);
      byDepth.set(d, bucket);
    }
    const levels = [...byDepth.keys()].sort((a, b) => a - b);
    const startToken = this.treeFetchToken;
    for (const lvl of levels) {
      if (this.treeFetchToken !== startToken) return; // cwd changed
      const bucket = byDepth.get(lvl) ?? [];
      await Promise.all(
        bucket.map(async (p) => {
          const node = this.findNode(this.fileTree(), p);
          if (!node || !node.isDir) return;
          if (node.expanded && node.children) return;
          await this.expandFolder(node);
        }),
      );
    }
  }

  private buildTree(entries: any[], level: number): FileNode[] {
    if (!Array.isArray(entries)) return [];
    const gitMap = this.gitStatusMap();
    const cmp = this.treeCollator.compare;
    return entries
      .map((e: any) => ({
        name: e.name,
        path: e.path,
        isDir: e.isDir,
        children: e.children ? this.buildTree(e.children, level + 1) : undefined,
        expanded: false,
        level,
        gitStatus: !e.isDir ? gitMap.get(e.path) : undefined,
        gitIgnored: e.gitIgnored || undefined,
      }))
      .sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return cmp(a.name, b.name);
      });
  }

  /**
   * Build nodes for a single directory level (lazy mode).
   * Directories arrive with `children: undefined` and are fetched on expand.
   */
  private buildShallowNodes(entries: any[], level: number): FileNode[] {
    if (!Array.isArray(entries)) return [];
    const gitMap = this.gitStatusMap();
    const cmp = this.treeCollator.compare;
    return entries
      .map((e: any) => ({
        name: e.name,
        path: e.path,
        isDir: !!e.isDir,
        children: undefined,
        expanded: false,
        level,
        gitStatus: !e.isDir ? gitMap.get(e.path) : undefined,
        gitIgnored: e.gitIgnored || undefined,
      }))
      .sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return cmp(a.name, b.name);
      });
  }

  /** Replace the matched node in-tree with a producer result; immutable update. */
  private updateNode(targetPath: string, producer: (n: FileNode) => FileNode): void {
    this.fileTree.update(tree => {
      const walk = (nodes: FileNode[]): FileNode[] =>
        nodes.map(n => {
          if (n.path === targetPath) return producer(n);
          if (n.children) return { ...n, children: walk(n.children) };
          return n;
        });
      return walk(tree);
    });
  }

  onTreeNodeClick(node: FileNode): void {
    this.focusedTreePath.set(node.path);
    if (node.isDir) {
      void this.toggleFolder(node);
    } else {
      this.openFile(node.path);
    }
  }

  /**
   * Keyboard navigation inside the file tree.
   * Up/Down: move focus between visible rows.
   * Left: collapse folder, or jump to parent if file/closed.
   * Right: expand folder (fetching children if needed), or jump to first child if open.
   * Enter / Space: open file or toggle folder.
   * Home / End: jump to first / last visible row.
   */
  onTreeKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    // Don't hijack typing inside the rename input.
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

    const flat = this.flatTree();
    if (!flat.length) return;

    const currentPath = this.focusedTreePath();
    let idx = currentPath ? flat.findIndex(n => n.path === currentPath) : -1;

    const setFocus = (i: number) => {
      const n = flat[Math.max(0, Math.min(flat.length - 1, i))];
      this.focusedTreePath.set(n.path);
      this.scrollTreeNodeIntoView(n.path);
    };

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocus(idx < 0 ? 0 : idx + 1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        setFocus(idx <= 0 ? 0 : idx - 1);
        return;
      case 'Home':
        e.preventDefault();
        setFocus(0);
        return;
      case 'End':
        e.preventDefault();
        setFocus(flat.length - 1);
        return;
      case 'Enter':
      case ' ': {
        if (idx < 0) return;
        e.preventDefault();
        const n = flat[idx];
        if (n.isDir) void this.toggleFolder(n);
        else void this.openFile(n.path);
        return;
      }
      case 'ArrowRight': {
        if (idx < 0) return;
        const n = flat[idx];
        e.preventDefault();
        if (n.isDir && !n.expanded) {
          void this.toggleFolder(n);
        } else if (n.isDir && n.expanded) {
          // Jump to first child if present (which is next row when expanded).
          setFocus(idx + 1);
        }
        return;
      }
      case 'ArrowLeft': {
        if (idx < 0) return;
        const n = flat[idx];
        e.preventDefault();
        if (n.isDir && n.expanded) {
          void this.toggleFolder(n);
        } else {
          // Jump to parent folder, if any.
          const sepIdx = Math.max(n.path.lastIndexOf('/'), n.path.lastIndexOf('\\'));
          if (sepIdx === -1) return;
          const parent = n.path.slice(0, sepIdx);
          const parentIdx = flat.findIndex(x => x.path === parent);
          if (parentIdx !== -1) setFocus(parentIdx);
        }
        return;
      }
      default:
        return;
    }
  }

  private scrollTreeNodeIntoView(p: string): void {
    const container = this.fileTreeEl?.nativeElement;
    if (!container) return;
    // Defer one tick so DOM reflects the new focused class / expanded rows.
    queueMicrotask(() => {
      const safe = p.replace(/"/g, '\\"');
      const el = container.querySelector<HTMLElement>(`[data-tree-path="${safe}"]`);
      if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  private async toggleFolder(node: FileNode): Promise<void> {
    const bridge = api();
    // Drop rapid double-clicks while a fetch is in-flight for the same path.
    if (this.pendingFolderFetches.has(node.path)) return;

    const needsFetch =
      node.isDir && node.children === undefined && !!bridge?.fsListDirShallow;

    if (!needsFetch) {
      // Already loaded (or legacy mode): plain expand/collapse.
      this.updateNode(node.path, n => ({ ...n, expanded: !n.expanded }));
      return;
    }

    // Optimistic expand with empty children — the chevron flips immediately.
    this.updateNode(node.path, n => ({ ...n, expanded: true, children: [] }));
    this.pendingFolderFetches.add(node.path);
    const token = this.treeFetchToken;

    try {
      const res = await bridge.fsListDirShallow(this.cwd, node.path);
      if (token !== this.treeFetchToken) return; // workspace changed mid-fetch
      const kids = res?.ok && Array.isArray(res.entries)
        ? this.buildShallowNodes(res.entries, node.level + 1)
        : [];
      this.updateNode(node.path, n => ({ ...n, expanded: true, children: kids }));
    } catch {
      if (token === this.treeFetchToken) {
        this.updateNode(node.path, n => ({ ...n, expanded: true, children: [] }));
      }
    } finally {
      this.pendingFolderFetches.delete(node.path);
    }
  }

  /* ── File Operations ── */

  /** Builds a PDF tab from an fsReadFileBase64 result (or a notice tab on failure). */
  private addPdfTab(tabPath: string, name: string, result: any): void {
    let file: OpenFile;
    if (result?.ok) {
      const pdfBlobUrl = this.pdfBlobUrlFromBase64(result.data);
      file = {
        path: tabPath, name, content: '', originalContent: '', modified: false, language: 'plaintext',
        kind: 'pdf', pdfBlobUrl, pdfSafeUrl: this.sanitizer.bypassSecurityTrustResourceUrl(pdfBlobUrl),
        sizeBytes: result.size,
      };
    } else {
      file = {
        path: tabPath, name, content: '', originalContent: '', modified: false, language: 'plaintext',
        kind: 'binary', binaryError: result?.error || 'Preview failed',
      };
    }
    this.openFiles.update(files => [...files, file]);
    this.activeFilePath.set(tabPath);
    this.updateSaveStatus();
  }

  private pdfBlobUrlFromBase64(data: string): string {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  }

  /** Re-reads a workspace PDF tab after an on-disk change; on failure the old preview stays. */
  private async reloadPdfTab(path: string): Promise<void> {
    const result = await api().fsReadFileBase64(this._cwd, path);
    if (!result?.ok) return;
    const current = this.openFiles().find(f => f.path === path);
    if (!current || current.kind !== 'pdf') return; // closed while reading
    const pdfBlobUrl = this.pdfBlobUrlFromBase64(result.data);
    if (current.pdfBlobUrl) URL.revokeObjectURL(current.pdfBlobUrl);
    this.openFiles.update(list => list.map(of =>
      of.path === path
        ? { ...of, pdfBlobUrl, pdfSafeUrl: this.sanitizer.bypassSecurityTrustResourceUrl(pdfBlobUrl), sizeBytes: result.size }
        : of,
    ));
  }

  /**
   * Read-only preview of a PDF/image that lives OUTSIDE the workspace (e.g. a
   * file an agent wrote to its scratchpad and printed as an absolute path).
   * The read is scoped to the file's own folder; the tab is keyed by the
   * absolute path. Returns false for file types it can't preview.
   */
  async openExternalPreview(absPath: string): Promise<boolean> {
    const pdf = isPdfPath(absPath);
    if (!pdf && !isRasterImagePath(absPath)) return false;
    if (this.openFiles().some(f => f.path === absPath)) {
      this.activeFilePath.set(absPath);
      return true;
    }
    const slash = absPath.lastIndexOf('/');
    const dir = absPath.slice(0, slash) || '/';
    const name = absPath.slice(slash + 1);
    const result = await api().fsReadFileBase64(dir, name);
    if (pdf) {
      this.addPdfTab(absPath, name, result);
    } else {
      const file: OpenFile = result?.ok
        ? {
            path: absPath, name, content: '', originalContent: '', modified: false, language: 'plaintext',
            kind: 'image', imageDataUrl: toDataUrl(result.mimeType, result.data), sizeBytes: result.size,
          }
        : {
            path: absPath, name, content: '', originalContent: '', modified: false, language: 'plaintext',
            kind: 'binary', binaryError: result?.error || 'Preview failed',
          };
      this.openFiles.update(files => [...files, file]);
      this.activeFilePath.set(absPath);
      this.imagePreviewDims.set(null);
      this.updateSaveStatus();
    }
    return true;
  }

  async openFile(path: string): Promise<void> {
    const existing = this.openFiles().find(f => f.path === path);
    if (existing) {
      this.activeFilePath.set(path);
      if ((existing.kind ?? 'text') === 'text') {
        this.switchEditorModel(path);
      }
      return;
    }

    try {
      const name = this.getFileName(path);

      if (isPdfPath(path)) {
        this.addPdfTab(path, name, await api().fsReadFileBase64(this.cwd, path));
        return;
      }

      if (isRasterImagePath(path)) {
        const result = await api().fsReadFileBase64(this.cwd, path);
        const file: OpenFile = result?.ok
          ? {
              path, name, content: '', originalContent: '', modified: false, language: 'plaintext',
              kind: 'image', imageDataUrl: toDataUrl(result.mimeType, result.data), sizeBytes: result.size,
            }
          : {
              path, name, content: '', originalContent: '', modified: false, language: 'plaintext',
              kind: 'binary', binaryError: result?.error || 'Preview failed',
            };
        this.openFiles.update(files => [...files, file]);
        this.activeFilePath.set(path);
        this.imagePreviewDims.set(null);
        this.updateSaveStatus();
        return;
      }

      const result = await api().fsReadFile(this.cwd, path);
      if (!result.ok) {
        // Binary or oversized file: open a notice tab instead of silently ignoring the click
        const file: OpenFile = {
          path, name, content: '', originalContent: '', modified: false, language: 'plaintext',
          kind: 'binary', binaryError: result.error || 'Cannot preview file',
        };
        this.openFiles.update(files => [...files, file]);
        this.activeFilePath.set(path);
        this.updateSaveStatus();
        return;
      }
      const language = detectLanguage(name);
      const file: OpenFile = {
        path,
        name,
        content: result.content,
        originalContent: result.content,
        modified: false,
        language,
      };
      this.openFiles.update(files => [...files, file]);
      this.activeFilePath.set(path);
      this.updateSaveStatus();

      // Monaco is initialized eagerly in ngAfterViewInit; if the script is
      // still loading, switchEditorModel queues this path via pendingFileSwitch.
      this.switchEditorModel(path);
    } catch (err) {
    }
  }

  async openFileAtLine(filePath: string, line: number, column = 1, length = 0): Promise<void> {
    await this.openFile(filePath);
    // After model switch, reveal the line — and select the exact hit when we know its span.
    setTimeout(() => {
      if (!this.editor) return;
      if (length > 0) {
        const range = { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column + length };
        this.editor.setSelection(range);
        this.editor.revealRangeInCenter(range);
      } else {
        this.editor.revealLineInCenter(line);
        this.editor.setPosition({ lineNumber: line, column: Math.max(1, column) });
      }
      this.editor.focus();
    }, 50);
  }

  async saveCurrentFile(): Promise<void> {
    this.flushContentSync();
    const af = this.activeFile();
    if (!af || !af.modified) return;

    this.saveStatus.set('saving');
    try {
      const result = await api().fsWriteFile(this.cwd, af.path, af.content);
      if (!result.ok) throw new Error(result.error);
      this.openFiles.update(files =>
        files.map(f =>
          f.path === af.path
            ? { ...f, originalContent: f.content, modified: false }
            : f
        )
      );
      this.saveStatus.set('saved');
    } catch (err) {
      this.saveStatus.set('error');
    }
  }

  /* ── Tabs ── */

  switchTab(path: string): void {
    this.activeFilePath.set(path);
    this.imagePreviewDims.set(null);
    if (this.isTextFile(path)) {
      this.switchEditorModel(path);
    }
    this.updateSaveStatus();
  }

  /** Image/binary tabs have no Monaco model — never route them to switchEditorModel. */
  private isTextFile(path: string): boolean {
    const f = this.openFiles().find(x => x.path === path);
    return (f?.kind ?? 'text') === 'text';
  }

  closeTab(path: string, event: MouseEvent): void {
    event.stopPropagation();
    const files = this.openFiles();
    const idx = files.findIndex(f => f.path === path);
    if (idx === -1) return;

    this.flushContentSync();
    if (files[idx].pdfBlobUrl) URL.revokeObjectURL(files[idx].pdfBlobUrl!);
    if (this.diffMode() && this.activeFilePath() === path) this.closeDiff();
    // Dispose Monaco model for this file
    const model = this.editorModels.get(path);
    if (model) {
      model.dispose();
      this.editorModels.delete(path);
    }
    this.viewStates.delete('/' + path);

    this.openFiles.update(list => list.filter(f => f.path !== path));

    if (this.activeFilePath() === path) {
      const remaining = this.openFiles();
      if (remaining.length > 0) {
        const newIdx = Math.min(idx, remaining.length - 1);
        const newPath = remaining[newIdx].path;
        this.activeFilePath.set(newPath);
        if (this.isTextFile(newPath)) {
          this.switchEditorModel(newPath);
        }
      } else {
        this.activeFilePath.set(null);
        if (this.editor) {
          this.editor.setModel(null);
        }
      }
    }
    this.updateSaveStatus();
  }

  /* ── Quick Search (CMD+P) ── */

  toggleQuickSearch(): void {
    this.showQuickSearch.update(v => !v);
    if (this.showQuickSearch()) {
      this.quickSearchQueryText = '';
      this.quickSearchResults.set([]);
      this.quickSearchIndex.set(0);
      this.quickSearchSeq++;
      setTimeout(() => this.quickSearchInputEl?.nativeElement?.focus(), 50);
    }
  }

  onQuickSearchInput(query: string): void {
    if (this.quickSearchDebounce) clearTimeout(this.quickSearchDebounce);
    const q = query.trim();
    if (q.length < 1) {
      this.quickSearchResults.set([]);
      return;
    }
    const seq = ++this.quickSearchSeq;
    this.quickSearchDebounce = setTimeout(async () => {
      try {
        const result = await api().fsSearchFiles(this.cwd, q);
        if (seq !== this.quickSearchSeq) return; // stale response: a newer one has been issued
        this.quickSearchResults.set(result.ok && Array.isArray(result.files) ? result.files.slice(0, 50) : []);
        this.quickSearchIndex.set(0);
      } catch {
        if (seq !== this.quickSearchSeq) return;
        this.quickSearchResults.set([]);
      }
    }, 150);
  }

  onQuickSearchKeydown(event: KeyboardEvent): void {
    const results = this.quickSearchResults();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.quickSearchIndex.update(i => Math.min(i + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.quickSearchIndex.update(i => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const idx = this.quickSearchIndex();
      if (results[idx]) this.openQuickSearchResult(results[idx]);
    } else if (event.key === 'Escape') {
      this.showQuickSearch.set(false);
    }
  }

  openQuickSearchResult(path: string): void {
    this.showQuickSearch.set(false);
    this.openFile(path);
  }

  /* ── Global Search (CMD+SHIFT+F) ── */

  switchToSearchTab(): void {
    this.sidebarTab.set('search');
    setTimeout(() => this.globalSearchInputEl?.nativeElement?.focus(), 50);
  }

  openSourceTree(): void {
    if (!this.cwd) return;
    import('../session-git-explorer/session-git-explorer.component').then(({ SessionGitExplorerComponent }) => {
      const modalRef = this.modalService.open(SessionGitExplorerComponent, {
        fullscreen: true,
        windowClass: 'git-explorer-modal',
      });
      modalRef.componentInstance.cwd = this.cwd;

      // Diff review comments come back as one prompt for the session's agent
      modalRef.result.then(async (result: any) => {
        if (result?.action === 'annotate' && result?.prompt && this.sessionId) {
          // Bracketed paste keeps the multi-line block as one message in the agent TUI
          this.terminalVisible.set(true);
          await this.sessionService.writeSession(this.sessionId, `\x1b[200~${result.prompt}\x1b[201~`);
          setTimeout(() => {
            this.terminalRef?.focus();
            void this.sessionService.writeSession(this.sessionId, '\r');
          }, 120);
        }
      }).catch(() => { /* dismissed */ });
    });
  }

  buildSearchRegex(query: string): RegExp | null {
    if (!query) return null;
    try {
      let pattern: string;
      if (this.searchUseRegex()) {
        pattern = query;
      } else {
        pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      if (this.searchWholeWord()) {
        pattern = `\\b${pattern}\\b`;
      }
      const flags = this.searchMatchCase() ? 'g' : 'gi';
      return new RegExp(pattern, flags);
    } catch {
      return null;
    }
  }

  onGlobalSearchChange(query: string): void {
    if (this.globalSearchDebounce) clearTimeout(this.globalSearchDebounce);
    if (query.length < 2) {
      this.globalSearchResults.set([]);
      this.searchResultGroups.set([]);
      this.searchLoading.set(false);
      return;
    }
    this.searchLoading.set(true);
    const seq = ++this.globalSearchSeq;
    this.globalSearchDebounce = setTimeout(async () => {
      try {
        const result = await api().fsSearchContent(this.cwd, query, 1000, {
          matchCase: this.searchMatchCase(),
          wholeWord: this.searchWholeWord(),
          useRegex: this.searchUseRegex(),
        });
        if (seq !== this.globalSearchSeq) return; // stale response — a newer search is in flight
        let results: SearchResult[] = result?.ok && Array.isArray(result.results) ? result.results : [];

        const regex = this.buildSearchRegex(query);
        // Legacy backends (substring-only, no `length`) ignore the options → filter here.
        if (regex && results.some(r => r.length == null)) {
          results = results.filter(r => {
            regex.lastIndex = 0;
            return regex.test(r.content);
          });
        }

        const capped = results.length > 500;
        results = results.slice(0, 500).map(r => this.decorateSearchResult(r, regex));
        this.globalSearchResults.set(results);
        this.searchTruncated.set(capped || result?.truncated === true);
        this.searchActiveIndex.set(0);
        this.buildSearchGroups(results);
      } catch {
        if (seq !== this.globalSearchSeq) return;
        this.globalSearchResults.set([]);
        this.searchResultGroups.set([]);
        this.searchTruncated.set(false);
      } finally {
        if (seq === this.globalSearchSeq) this.searchLoading.set(false);
      }
    }, 300);
  }

  /**
   * Resolve the exact match span (column + length) and split the line into
   * pre / match / post for highlighted rendering. Falls back to re-matching
   * the regex client-side when the backend didn't report `length`.
   */
  private decorateSearchResult(r: SearchResult, regex: RegExp | null): SearchResult {
    const content = r.content ?? '';
    let column = Math.max(1, r.column || 1);
    let length = r.length ?? 0;
    if (!length && regex) {
      const single = new RegExp(regex.source, regex.flags.replace('g', ''));
      const m = content.substring(column - 1).match(single);
      if (m && m.index != null && m[0].length > 0) {
        column += m.index;
        length = m[0].length;
      }
    }
    const start = column - 1;
    const CONTEXT_BEFORE = 28;
    const preRaw = content.substring(0, start);
    const pre = preRaw.length > CONTEXT_BEFORE
      ? '…' + preRaw.slice(-CONTEXT_BEFORE).trimStart()
      : preRaw.trimStart();
    return {
      ...r,
      column,
      length,
      pre,
      match: content.substring(start, start + length),
      post: content.substring(start + length, start + length + 200),
    };
  }

  private buildSearchGroups(results: SearchResult[]): void {
    const map = new Map<string, SearchResult[]>();
    for (const r of results) {
      if (!map.has(r.filePath)) map.set(r.filePath, []);
      map.get(r.filePath)!.push(r);
    }
    const groups: SearchResultGroup[] = [];
    for (const [filePath, items] of map) {
      const sepIdx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
      groups.push({
        filePath,
        fileName: this.getFileName(filePath),
        dirPath: sepIdx > 0 ? filePath.slice(0, sepIdx) : '',
        results: items,
        expanded: true,
      });
    }
    this.searchResultGroups.set(groups);
  }

  toggleSearchGroup(filePath: string): void {
    this.searchResultGroups.update(groups =>
      groups.map(g => g.filePath === filePath ? { ...g, expanded: !g.expanded } : g)
    );
  }

  navigateSearchResult(direction: 1 | -1): void {
    const results = this.globalSearchResults();
    if (results.length === 0) return;
    const newIdx = (this.searchActiveIndex() + direction + results.length) % results.length;
    this.searchActiveIndex.set(newIdx);
    this.goToSearchResult(results[newIdx]);
  }

  goToSearchResult(result: SearchResult): void {
    const idx = this.globalSearchResults().findIndex(
      r => r.filePath === result.filePath && r.line === result.line && r.column === result.column
    );
    if (idx !== -1) this.searchActiveIndex.set(idx);
    this.openFileAtLine(result.filePath, result.line, result.column, result.length ?? 0);
  }

  isActiveSearchResult(filePath: string, line: number, column?: number): boolean {
    const results = this.globalSearchResults();
    const idx = this.searchActiveIndex();
    if (idx >= results.length) return false;
    const active = results[idx];
    return active.filePath === filePath && active.line === line && (column == null || active.column === column);
  }

  /* ── Replace ── */

  private async getFileContent(filePath: string): Promise<string | null> {
    const open = this.openFiles().find(f => f.path === filePath);
    if (open) return open.content;
    try {
      const result = await api().fsReadFile(this.cwd, filePath);
      return result.ok ? result.content : null;
    } catch {
      return null;
    }
  }

  /** Writes and syncs the open tab; false (and an error dialog) when the write failed. */
  private async writeFileContent(filePath: string, newContent: string): Promise<boolean> {
    try {
      const res = await api().fsWriteFile(this.cwd, filePath, newContent);
      if (!res?.ok) {
        this.swal.error(`${filePath}: ${res?.error || this.translate.instant('CODE_EDITOR.Write failed')}`);
        return false;
      }
    } catch (err: any) {
      this.swal.error(`${filePath}: ${err?.message || this.translate.instant('CODE_EDITOR.Write failed')}`);
      return false;
    }
    const isOpen = this.openFiles().some(f => f.path === filePath);
    if (isOpen) {
      this.openFiles.update(files =>
        files.map(f =>
          f.path === filePath
            ? { ...f, content: newContent, originalContent: newContent, modified: false }
            : f
        )
      );
      // Update Monaco model too
      const model = this.editorModels.get(filePath);
      if (model) {
        model.setValue(newContent);
      }
    }
    return true;
  }

  /** Replacement text: literal unless regex mode is on (then `$1`, `$&` apply). */
  private replacementFor(regexMode: boolean): string | (() => string) {
    const text = this.replaceQuery;
    return regexMode ? text : () => text;
  }

  async replaceNext(): Promise<void> {
    const results = this.globalSearchResults();
    if (results.length === 0 || !this.globalSearchQuery) return;

    const idx = this.searchActiveIndex();
    const result = results[idx];
    if (!result) return;

    const content = await this.getFileContent(result.filePath);
    if (content === null) return;

    const lines = content.split('\n');
    const lineIdx = result.line - 1;
    if (lineIdx < 0 || lineIdx >= lines.length) return;

    const regex = this.buildSearchRegex(this.globalSearchQuery);
    if (!regex) return;

    const lineContent = lines[lineIdx];
    const colOffset = Math.max(0, (result.column ?? 1) - 1);
    const subLine = lineContent.substring(colOffset);
    const singleRegex = new RegExp(regex.source, regex.flags.replace('g', ''));
    const match = subLine.match(singleRegex);
    if (!match || match.index === undefined) return;

    const absIdx = colOffset + match.index;
    const replacement = match[0].replace(singleRegex, this.replacementFor(this.searchUseRegex()) as any);
    lines[lineIdx] = lineContent.substring(0, absIdx) + replacement + lineContent.substring(absIdx + match[0].length);
    const newContent = lines.join('\n');

    await this.writeFileContent(result.filePath, newContent);
    await this.openFile(result.filePath);
    this.updateSaveStatus();
    this.onGlobalSearchChange(this.globalSearchQuery);
  }

  async replaceAll(): Promise<void> {
    if (!this.globalSearchQuery) return;
    const results = this.globalSearchResults();
    if (results.length === 0) return;

    const regex = this.buildSearchRegex(this.globalSearchQuery);
    if (!regex) return;

    const filePaths = new Set(results.map(r => r.filePath));
    let replacedCount = 0;

    this.flushContentSync();
    for (const filePath of filePaths) {
      // Open tab first: reading the disk copy and then overwriting the tab threw
      // away its unsaved edits.
      const content = await this.getFileContent(filePath);
      if (content === null) continue;

      regex.lastIndex = 0;
      const newContent = content.replace(regex, this.replacementFor(this.searchUseRegex()) as any);
      if (newContent === content) continue;

      if (await this.writeFileContent(filePath, newContent)) replacedCount++;
    }

    this.updateSaveStatus();
    this.onGlobalSearchChange(this.globalSearchQuery);
  }

  /* ── Context Menu ── */

  onTreeNodeContext(event: MouseEvent, node: FileNode): void {
    event.preventDefault();
    event.stopPropagation();
    this.ctxNode.set(node);
    this.ctxPos.set({ x: event.clientX, y: event.clientY });
  }

  closeCtxMenu(): void {
    this.ctxNode.set(null);
  }

  ctxOpenFile(): void {
    const node = this.ctxNode();
    if (node && !node.isDir) this.openFile(node.path);
    this.closeCtxMenu();
  }

  ctxCopyPath(): void {
    const node = this.ctxNode();
    if (node) {
      const fullPath = this.cwd + '/' + node.path;
      api().clipboardWrite(fullPath);
    }
    this.closeCtxMenu();
  }

  ctxCopyRelativePath(): void {
    const node = this.ctxNode();
    if (node) api().clipboardWrite(node.path);
    this.closeCtxMenu();
  }

  ctxCopyName(): void {
    const node = this.ctxNode();
    if (node) api().clipboardWrite(node.name);
    this.closeCtxMenu();
  }

  ctxRevealInFinder(): void {
    const node = this.ctxNode();
    if (node) {
      const fullPath = this.cwd + '/' + node.path;
      // Surface a diagnostic if the reveal fails (e.g. path no longer exists)
      // instead of silently doing nothing.
      Promise.resolve(api().showInFolder(fullPath))
        .then((r: { ok?: boolean; error?: string } | void) => {
          if (r && r.ok === false) console.warn('[reveal-in-finder] failed:', r.error, fullPath);
        })
        .catch((err: unknown) => console.warn('[reveal-in-finder] error:', err, fullPath));
    }
    this.closeCtxMenu();
  }

  ctxOpenInTerminal(): void {
    const node = this.ctxNode();
    if (node) {
      const folderPath = node.isDir
        ? this.cwd + '/' + node.path
        : this.cwd + '/' + node.path.split('/').slice(0, -1).join('/');
      api().openTerminalInFolder(folderPath || this.cwd);
    }
    this.closeCtxMenu();
  }

  // window.prompt() is not implemented in every webview (it can return null,
  // which made "New File"/"New Folder" silently do nothing) — use a Swal dialog.
  async ctxNewFile(): Promise<void> {
    const node = this.ctxNode();
    this.closeCtxMenu();
    const parentDir = node?.isDir ? node.path : (node?.path.split('/').slice(0, -1).join('/') || '');
    const name = await this.swal.promptText({
      title: this.translate.instant('CODE_EDITOR.New file'),
      message: parentDir ? this.translate.instant('CODE_EDITOR.Create file in', { dir: parentDir }) : this.translate.instant('CODE_EDITOR.Create file'),
    });
    if (!name) return;
    const filePath = parentDir ? parentDir + '/' + name : name;
    const result = await api().fsNewFile(this.cwd, filePath);
    if (result?.ok) {
      await this.loadFileTree();
      this.openFile(filePath);
    } else {
      this.swal.error(result?.error || this.translate.instant('CODE_EDITOR.Create file failed'));
    }
  }

  async ctxNewFolder(): Promise<void> {
    const node = this.ctxNode();
    this.closeCtxMenu();
    const parentDir = node?.isDir ? node.path : (node?.path.split('/').slice(0, -1).join('/') || '');
    const name = await this.swal.promptText({
      title: this.translate.instant('CODE_EDITOR.New folder'),
      message: parentDir ? this.translate.instant('CODE_EDITOR.Create folder in', { dir: parentDir }) : this.translate.instant('CODE_EDITOR.Create folder'),
    });
    if (!name) return;
    const folderPath = parentDir ? parentDir + '/' + name : name;
    const result = await api().fsNewFolder(this.cwd, folderPath);
    if (result?.ok) {
      await this.loadFileTree();
    } else {
      this.swal.error(result?.error || this.translate.instant('CODE_EDITOR.Create folder failed'));
    }
  }

  ctxRename(): void {
    const node = this.ctxNode();
    this.closeCtxMenu();
    if (!node) return;
    this.renameTarget.set(node);
    setTimeout(() => {
      const input = document.querySelector('.rename-input') as HTMLInputElement;
      if (input) {
        input.focus();
        const dotIdx = node.name.lastIndexOf('.');
        input.setSelectionRange(0, dotIdx > 0 ? dotIdx : node.name.length);
      }
    }, 50);
  }

  async confirmRename(event: Event): Promise<void> {
    const target = this.renameTarget();
    if (!target) return;

    const input = event.target as HTMLInputElement;
    const newName = input.value.trim();
    this.renameTarget.set(null);

    if (!newName || newName === target.name) return;

    const parentDir = target.path.split('/').slice(0, -1).join('/');
    const newPath = parentDir ? parentDir + '/' + newName : newName;
    const result = await api().fsRename(this.cwd, target.path, newPath);
    if (result.ok) {
      // Update open tabs if the renamed file was open
      const wasOpen = this.openFiles().find(f => f.path === target.path);
      if (wasOpen) {
        this.openFiles.update(files =>
          files.map(f => f.path === target.path ? { ...f, path: newPath, name: newName } : f)
        );
        if (this.activeFilePath() === target.path) {
          this.activeFilePath.set(newPath);
        }
        // Recreate Monaco model with new URI
        const model = this.editorModels.get(target.path);
        if (model) {
          model.dispose();
          this.editorModels.delete(target.path);
        }
      }
      await this.loadFileTree();
      if (wasOpen) this.switchEditorModel(newPath);
    }
  }

  cancelRename(): void {
    this.renameTarget.set(null);
  }

  async ctxDuplicate(): Promise<void> {
    const node = this.ctxNode();
    this.closeCtxMenu();
    if (!node || node.isDir) return;
    const result = await api().fsDuplicate(this.cwd, node.path);
    if (result.ok) await this.loadFileTree();
  }

  async ctxDelete(): Promise<void> {
    const node = this.ctxNode();
    this.closeCtxMenu();
    if (!node) return;
    // window.confirm() is not reliable in the desktop webview: use the app's
    // confirmation (a native dialog in the desktop app, plain text; the in-app
    // fallback sanitizes HTML), which calls back only on confirm.
    this.swal.confirmDanger(this.translate.instant('CODE_EDITOR.Move to trash'), this.translate.instant('CODE_EDITOR.Move to trash confirm', { name: node.name }), () => void this.trashNode(node));
  }

  private async trashNode(node: FileNode): Promise<void> {
    const result = await api().fsDelete(this.cwd, node.path);
    if (result.ok) {
      // Close tab if file was open
      if (!node.isDir && this.openFiles().some(f => f.path === node.path)) {
        const model = this.editorModels.get(node.path);
        if (model) { model.dispose(); this.editorModels.delete(node.path); }
        this.viewStates.delete('/' + node.path);
        const trashed = this.openFiles().find(f => f.path === node.path);
        if (trashed?.pdfBlobUrl) URL.revokeObjectURL(trashed.pdfBlobUrl);
        this.openFiles.update(list => list.filter(f => f.path !== node.path));
        if (this.activeFilePath() === node.path) {
          const remaining = this.openFiles();
          if (remaining.length > 0) {
            this.activeFilePath.set(remaining[0].path);
            if (this.isTextFile(remaining[0].path)) this.switchEditorModel(remaining[0].path);
          } else {
            this.activeFilePath.set(null);
            this.editor?.setModel(null);
          }
        }
      }
      await this.loadFileTree();
    }
  }

  /* ── Helpers ── */

  getFileName(path: string): string {
    return path.split('/').pop() ?? path;
  }

  private updateSaveStatus(): void {
    const hasModified = this.openFiles().some(f => f.modified);
    if (hasModified) {
      this.saveStatus.set('unsaved');
    } else if (this.saveStatus() !== 'error') {
      this.saveStatus.set('saved');
    }
  }
}
