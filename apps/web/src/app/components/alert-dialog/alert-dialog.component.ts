import { AfterViewInit, CUSTOM_ELEMENTS_SCHEMA, Component, ElementRef, HostListener, OnDestroy, ViewChild, inject, ChangeDetectionStrategy } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { TranslateModule } from "@ngx-translate/core";

export type AlertVariant = "success" | "error" | "warning" | "info" | "danger";

export interface AlertDialogOptions {
  variant?: AlertVariant;
  title?: string;
  /**
   * Message, with light formatting from translations (strong, em, code, lists).
   * Callers interpolate names, paths and error texts into it, so it is reduced
   * to that small set of tags with sanitizeDialogHtml() before rendering.
   */
  html?: string;
  confirmText?: string;
  confirmClass?: string;
  cancelText?: string;
  /** Second choice next to confirm; resolves with `isDenied`. */
  denyText?: string;
  /** Shows a text field; the dialog then resolves with its value. */
  input?: { value: string };
  /** Closes by itself after this many milliseconds, with a progress bar. */
  timerMs?: number;
  /** Seconds shown and counted down in the body (rate limit). */
  countdown?: { seconds: number; label: string };
  /** False: no close button, Esc and backdrop do nothing. */
  dismissible?: boolean;
}

export interface AlertDialogResult {
  isConfirmed: boolean;
  isDenied?: boolean;
  value?: string;
}

/** Formatting tags a dialog message may keep; everything else becomes plain text. */
const ALLOWED_TAGS = new Set(["B", "STRONG", "I", "EM", "BR", "CODE", "SMALL", "P", "UL", "OL", "LI", "SPAN"]);
const DROPPED_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

/**
 * Keeps only simple formatting tags (no attributes but a plain class list) and
 * turns every other element into its text. Dialog messages carry session
 * names, file paths and error texts written by agents, repositories or the
 * system: an image, a link or a form among them must never render. Parsing
 * happens in an inert <template>, so nothing loads while it is cleaned.
 */
export function sanitizeDialogHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const out = document.createElement("div");
  const copy = (from: Node, to: Node): void => {
    from.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        to.appendChild(document.createTextNode(node.textContent ?? ""));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as Element;
      if (DROPPED_TAGS.has(element.tagName)) return;
      if (!ALLOWED_TAGS.has(element.tagName)) {
        copy(element, to);
        return;
      }
      const clean = document.createElement(element.tagName.toLowerCase());
      const classes = element.getAttribute("class");
      if (classes && /^[\w\s-]+$/.test(classes)) clean.setAttribute("class", classes);
      copy(element, clean);
      to.appendChild(clean);
    });
  };
  copy(template.content, out);
  return out.innerHTML;
}

const ICONS: Record<AlertVariant, string> = {
  success: "solar:check-circle-bold",
  error: "solar:close-circle-bold",
  warning: "solar:danger-triangle-bold",
  info: "solar:info-circle-bold",
  danger: "solar:trash-bin-trash-bold",
};

/** Small alert, confirm and prompt dialog, opened through SwalService. */
@Component({
  selector: "alert-dialog",
  standalone: true,
  imports: [FormsModule, TranslateModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <div class="alert-dialog">
      @if (options.dismissible !== false) {
        <button type="button" class="btn-close alert-dialog-close" [attr.aria-label]="'BUTTONS.Close' | translate" (click)="dismiss()"></button>
      }
      <div class="alert-dialog-icon alert-dialog-icon--{{ variant }}">
        <iconify-icon [icon]="icon" width="32"></iconify-icon>
      </div>
      @if (options.title) {
        <h3 class="alert-dialog-title">{{ options.title }}</h3>
      }
      @if (options.html) {
        <div class="alert-dialog-text" [innerHTML]="message"></div>
      }
      @if (options.countdown) {
        <p class="alert-dialog-text"><strong>{{ remaining }}</strong> {{ options.countdown.label }}</p>
      }
      @if (options.input) {
        <input #field class="form-control alert-dialog-input" type="text" [(ngModel)]="options.input.value" (keydown.enter)="confirm()" />
      }
      @if (options.confirmText || options.cancelText) {
        <div class="alert-dialog-actions">
          @if (options.cancelText) {
            <button type="button" class="btn po-btn-ghost" (click)="dismiss()">{{ options.cancelText }}</button>
          }
          @if (options.denyText) {
            <button type="button" class="btn btn-outline-secondary" (click)="deny()">{{ options.denyText }}</button>
          }
          @if (options.confirmText) {
            <button type="button" class="btn {{ options.confirmClass || 'btn-primary' }}" (click)="confirm()">{{ options.confirmText }}</button>
          }
        </div>
      }
      @if (options.timerMs) {
        <div class="alert-dialog-timer" [style.animation-duration.ms]="options.timerMs"></div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .alert-dialog {
      position: relative;
      padding: 28px 24px 22px;
      text-align: center;
      overflow: hidden;
    }
    .alert-dialog-close {
      position: absolute;
      top: 14px;
      right: 14px;
      font-size: 0.7rem;
    }
    :host-context([data-bs-theme="dark"]) .alert-dialog-close {
      filter: invert(1) grayscale(100%) brightness(200%);
    }
    .alert-dialog-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      margin-bottom: 12px;
    }
    .alert-dialog-icon--success { color: var(--promptops-success); background: rgba(25, 135, 84, 0.12); }
    .alert-dialog-icon--error,
    .alert-dialog-icon--danger { color: var(--promptops-danger); background: rgba(220, 53, 69, 0.12); }
    .alert-dialog-icon--warning { color: var(--promptops-warning); background: rgba(255, 193, 7, 0.14); }
    .alert-dialog-icon--info { color: var(--promptops-info); background: rgba(13, 202, 240, 0.12); }
    .alert-dialog-title {
      margin: 0 0 6px;
      font-size: 1.1rem;
      font-weight: 700;
    }
    .alert-dialog-text {
      margin: 0 0 4px;
      font-size: 0.9rem;
      color: var(--promptops-body-color);
      overflow-wrap: anywhere;
    }
    .alert-dialog-input {
      margin-top: 12px;
    }
    .alert-dialog-actions {
      display: flex;
      justify-content: center;
      gap: 8px;
      margin-top: 18px;
    }
    .alert-dialog-timer {
      position: absolute;
      left: 0;
      bottom: 0;
      height: 3px;
      width: 100%;
      background: var(--promptops-primary);
      transform-origin: left;
      animation: alert-dialog-timer linear forwards;
    }
    @keyframes alert-dialog-timer {
      from { transform: scaleX(1); }
      to { transform: scaleX(0); }
    }
  `,
})
export class AlertDialogComponent implements AfterViewInit, OnDestroy {
  private activeModal = inject(NgbActiveModal);
  @ViewChild("field") private field?: ElementRef<HTMLInputElement>;

  options: AlertDialogOptions = {};
  remaining = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];

  get variant(): AlertVariant {
    return this.options.variant ?? "info";
  }

  get icon(): string {
    return ICONS[this.variant];
  }

  private cleanedFrom: string | undefined;
  private cleaned = "";

  /** The message reduced to safe formatting (computed once per text). */
  get message(): string {
    const html = this.options.html ?? "";
    if (html !== this.cleanedFrom) {
      this.cleanedFrom = html;
      this.cleaned = sanitizeDialogHtml(html);
    }
    return this.cleaned;
  }

  ngAfterViewInit(): void {
    if (this.field) {
      const input = this.field.nativeElement;
      setTimeout(() => {
        input.focus();
        input.select();
      });
    }
    if (this.options.timerMs) {
      this.timers.push(setTimeout(() => this.dismiss(), this.options.timerMs));
    }
    if (this.options.countdown) {
      this.remaining = this.options.countdown.seconds;
      const tick = setInterval(() => {
        this.remaining = Math.max(0, this.remaining - 1);
      }, 1000);
      this.timers.push(tick);
    }
  }

  ngOnDestroy(): void {
    this.timers.forEach((t) => clearTimeout(t));
  }

  /** Enter confirms, like the primary button. */
  @HostListener("document:keydown.enter", ["$event"])
  onEnter(event: Event): void {
    if (!this.options.confirmText || this.options.input) return;
    event.preventDefault();
    this.confirm();
  }

  confirm(): void {
    const result: AlertDialogResult = { isConfirmed: true };
    if (this.options.input) result.value = this.options.input.value;
    this.activeModal.close(result);
  }

  deny(): void {
    this.activeModal.close({ isConfirmed: false, isDenied: true });
  }

  dismiss(): void {
    this.activeModal.dismiss();
  }
}
