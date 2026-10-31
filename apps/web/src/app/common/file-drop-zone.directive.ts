import {
  Directive,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnDestroy,
  OnInit,
  Output,
  inject,
} from '@angular/core';

function isLinux(): boolean {
  return /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);
}

/**
 * Absolute local paths from a drop's text/uri-list (file:// only). Fallback for
 * WebKitGTK, where OS file drops may have an empty dataTransfer.files.
 */
export function fileUrisFromDrop(e: DragEvent): string[] {
  if (!isLinux()) return [];
  const list = e.dataTransfer?.getData('text/uri-list') || '';
  return list
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && l.startsWith('file://'))
    .map(l => {
      try {
        return decodeURIComponent(new URL(l).pathname);
      } catch {
        return '';
      }
    })
    .filter(p => p.startsWith('/'));
}

/**
 * Shared OS-file drop zone.
 *
 * Fixes two chronic problems of naive (dragover)/(dragleave) template
 * bindings, which show up badly in Tauri/WKWebView:
 * 1. Listeners are attached OUTSIDE the Angular zone — dragover fires 60+/s
 *    and each zone-patched event triggers app-wide change detection, which
 *    lags heavy views (terminals). We re-enter the zone only on state changes.
 * 2. dragleave fires when the cursor crosses INTO a child element (including
 *    the drop overlay itself), and WKWebKit often reports relatedTarget=null
 *    even for those internal crossings — so the highlight flickers off/on and
 *    drops feel hard to trigger. Real leaves (relatedTarget outside the zone)
 *    reset immediately; ambiguous ones (null) only reset after a short grace
 *    period that any subsequent dragover cancels.
 *
 * Only reacts to drags carrying OS files ('Files' type), so internal HTML5
 * DnD (tab/folder reorder via text/plain) is untouched.
 */
@Directive({
  selector: '[appFileDropZone]',
  standalone: true,
})
export class FileDropZoneDirective implements OnInit, OnDestroy {
  /** Disable entirely (e.g. classic UI where the zone must stay inert). */
  @Input() fileDropDisabled = false;
  /** Emits true when a file drag is over the zone, false when it leaves. */
  @Output() fileDropOver = new EventEmitter<boolean>();
  /** Emits the raw DragEvent on drop (default already prevented). */
  @Output() fileDropped = new EventEmitter<DragEvent>();

  private el = inject<ElementRef<HTMLElement>>(ElementRef);
  private zone = inject(NgZone);
  private abort = new AbortController();
  private over = false;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timestamp of the last dragover seen: feeds the watchdog. */
  private lastSeen = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    const node = this.el.nativeElement;
    const opts = { signal: this.abort.signal };

    this.zone.runOutsideAngular(() => {
      node.addEventListener('dragenter', (e: DragEvent) => {
        if (!this.accepts(e)) return;
        e.preventDefault();
        e.stopPropagation();
        this.cancelLeave();
        this.setOver(true);
      }, opts);

      node.addEventListener('dragover', (e: DragEvent) => {
        if (!this.accepts(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        this.cancelLeave();
        this.setOver(true);
      }, opts);

      node.addEventListener('dragleave', (e: DragEvent) => {
        if (!this.accepts(e)) return;
        const rt = e.relatedTarget as Node | null;
        // Crossing into a child of the zone is not a real leave.
        if (rt && node.contains(rt)) return;
        if (rt) {
          this.reset();
        } else {
          // WKWebView: null relatedTarget is ambiguous (child crossing OR
          // window exit). Wait a beat — a following dragover cancels this.
          this.scheduleLeave();
        }
      }, opts);

      node.addEventListener('drop', (e: DragEvent) => {
        if (!this.accepts(e)) return;
        e.preventDefault();
        e.stopPropagation();
        this.reset();
        if (e.dataTransfer?.files?.length || fileUrisFromDrop(e).length) {
          this.zone.run(() => this.fileDropped.emit(e));
        }
      }, opts);

      // Drag canceled (Esc) or dropped elsewhere: clear any stale highlight.
      // Capture phase: a drop on another drop-zone calls stopPropagation(),
      // so in the bubbling phase these listeners would never be reached.
      const cap = { signal: this.abort.signal, capture: true };
      window.addEventListener('dragend', () => this.reset(), cap);
      window.addEventListener('drop', () => this.reset(), cap);
      window.addEventListener('dragleave', (e: DragEvent) => {
        // Leaving the window: relatedTarget null and target = documentElement.
        if (!e.relatedTarget) this.scheduleLeave();
      }, cap);
      // Escape hatch: if we go back to interacting with mouse/keyboard the drag has
      // necessarily ended (WKWebView sometimes emits neither drop nor dragend).
      const bail = () => { if (this.over) this.reset(); };
      window.addEventListener('mousemove', bail, cap);
      window.addEventListener('pointerdown', bail, cap);
      window.addEventListener('keydown', bail, cap);
      window.addEventListener('blur', bail, cap);
      document.addEventListener('visibilitychange', bail, cap);
    });
  }

  ngOnDestroy(): void {
    this.abort.abort();
    this.cancelLeave();
    this.stopWatchdog();
  }

  private accepts(e: DragEvent): boolean {
    if (this.fileDropDisabled) return false;
    const types = e.dataTransfer?.types;
    if (!types) return false;
    // WebKitGTK (Linux): a drag from the file manager may arrive only as
    // text/uri-list, without 'Files'. In-app HTML5 drag and drop uses text/plain.
    return types.includes('Files') || (isLinux() && types.includes('text/uri-list'));
  }

  private setOver(v: boolean): void {
    if (v) this.lastSeen = Date.now();
    if (this.over === v) return;
    this.over = v;
    if (v) this.startWatchdog();
    else this.stopWatchdog();
    this.zone.run(() => this.fileDropOver.emit(v));
  }

  /**
   * Safety net: while a drag is over the zone, dragover fires ~60/s.
   * If it stops arriving for over half a second the drag ended without
   * the webview emitting drop/dragleave/dragend (recurring bug in
   * Tauri/WKWebView) and the overlay would stay stuck forever.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastSeen > 500) this.reset();
    }, 250);
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private scheduleLeave(): void {
    this.cancelLeave();
    this.leaveTimer = setTimeout(() => this.reset(), 120);
  }

  private cancelLeave(): void {
    if (this.leaveTimer !== null) {
      clearTimeout(this.leaveTimer);
      this.leaveTimer = null;
    }
  }

  private reset(): void {
    this.cancelLeave();
    this.stopWatchdog();
    this.setOver(false);
  }
}
