import {
  Directive,
  ElementRef,
  Input,
  OnDestroy,
  OnChanges,
  HostListener,
  Renderer2,
} from '@angular/core';

@Directive({
  selector: '[appTooltip]',
  standalone: true,
})
export class TooltipDirective implements OnDestroy, OnChanges {
  @Input('appTooltip') text = '';
  /** 'right': beside the host instead of above it (lists the tooltip must not cover). */
  @Input() appTooltipPlacement: 'top' | 'right' = 'top';

  private tooltipEl: HTMLElement | null = null;
  private showTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private el: ElementRef, private renderer: Renderer2) {}

  ngOnChanges(): void {
    if (this.tooltipEl) {
      this.tooltipEl.textContent = this.text;
    }
  }

  @HostListener('mouseenter')
  onMouseEnter(): void {
    if (!this.text) return;
    this.show();
  }

  @HostListener('mouseleave')
  onMouseLeave(): void {
    this.hide();
  }

  @HostListener('click')
  onClick(): void {
    this.hide();
  }

  ngOnDestroy(): void {
    this.hide();
  }

  private show(): void {
    if (this.tooltipEl) return;

    const tip = this.renderer.createElement('div') as HTMLElement;
    tip.textContent = this.text;
    tip.className = 'po-tooltip';
    this.renderer.appendChild(document.body, tip);
    this.tooltipEl = tip;

    // Position after render
    requestAnimationFrame(() => {
      if (!this.tooltipEl) return;
      const rect = this.el.nativeElement.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();

      let top = rect.top - tipRect.height - 8;
      let left = rect.left + rect.width / 2 - tipRect.width / 2;
      const beside = this.appTooltipPlacement === 'right' && rect.right + 8 + tipRect.width <= window.innerWidth - 4;
      if (beside) {
        top = rect.top;
        left = rect.right + 8;
      }

      // Flip below if no space above
      if (!beside && top < 4) {
        top = rect.bottom + 8;
      }

      // Clamp vertically if overflows bottom
      if (top + tipRect.height > window.innerHeight - 4) {
        top = window.innerHeight - tipRect.height - 4;
      }

      // Clamp horizontally
      if (left < 4) left = 4;
      if (left + tipRect.width > window.innerWidth - 4) {
        left = window.innerWidth - tipRect.width - 4;
      }

      tip.style.top = `${top}px`;
      tip.style.left = `${left}px`;
      tip.classList.add('po-tooltip-visible');
    });
  }

  private hide(): void {
    if (this.showTimer) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
    if (this.tooltipEl) {
      this.tooltipEl.remove();
      this.tooltipEl = null;
    }
  }
}
