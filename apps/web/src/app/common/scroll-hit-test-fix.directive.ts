import { Directive, ElementRef, NgZone, OnDestroy, OnInit, inject } from '@angular/core';

/** How long to wait after the last wheel/scroll before touching scrollTop. */
const SCROLL_IDLE_MS = 150;

/**
 * Realigns the WKWebView hit-test (macOS, desktop app) with the actual scroll
 * position of a scrollable container.
 *
 * When the content changes height while the container is scrolled (expanding
 * or collapsing a folder/workspace, resizing the window), WebKit keeps
 * hit-testing against the old offset: the pointer highlights one row and the
 * click opens the one below. Reassigning scrollTop (with a different step,
 * otherwise WebKit ignores it) brings the two back in sync.
 *
 * It only kicks in when scrollHeight/clientHeight actually change, so state
 * updates (badges, timers) do not trigger it, and never during an ongoing
 * scroll: reassigning scrollTop would stop trackpad inertia. Everything runs
 * outside the Angular zone.
 */
@Directive({
  selector: '[appScrollHitTestFix]',
  standalone: true,
})
export class ScrollHitTestFixDirective implements OnInit, OnDestroy {
  private el = inject<ElementRef<HTMLElement>>(ElementRef);
  private zone = inject(NgZone);
  private abort = new AbortController();
  private mutations: MutationObserver | null = null;
  private resizes: ResizeObserver | null = null;
  private raf = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastScrollAt = 0;
  private lastScrollHeight = 0;
  private lastClientHeight = 0;

  ngOnInit(): void {
    const node = this.el.nativeElement;
    this.lastScrollHeight = node.scrollHeight;
    this.lastClientHeight = node.clientHeight;

    this.zone.runOutsideAngular(() => {
      const markScroll = () => { this.lastScrollAt = performance.now(); };
      const opts = { passive: true, signal: this.abort.signal };
      node.addEventListener('wheel', markScroll, opts);
      node.addEventListener('scroll', markScroll, opts);

      this.mutations = new MutationObserver(() => this.schedule());
      this.mutations.observe(node, { childList: true, subtree: true });
      this.resizes = new ResizeObserver(() => this.schedule());
      this.resizes.observe(node);
    });
  }

  ngOnDestroy(): void {
    this.abort.abort();
    this.mutations?.disconnect();
    this.resizes?.disconnect();
    cancelAnimationFrame(this.raf);
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }

  private schedule(): void {
    if (this.raf || this.idleTimer) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.realign();
    });
  }

  private realign(): void {
    const node = this.el.nativeElement;
    const sh = node.scrollHeight;
    const ch = node.clientHeight;
    if (sh === this.lastScrollHeight && ch === this.lastClientHeight) return;

    const sinceScroll = performance.now() - this.lastScrollAt;
    if (sinceScroll < SCROLL_IDLE_MS) {
      // Scroll in progress: retry once the gesture ends, without updating the measurements.
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this.realign();
      }, SCROLL_IDLE_MS - sinceScroll);
      return;
    }

    this.lastScrollHeight = sh;
    this.lastClientHeight = ch;
    const top = node.scrollTop;
    if (top === 0) return;
    node.scrollTop = top - 1;
    node.scrollTop = top;
  }
}
