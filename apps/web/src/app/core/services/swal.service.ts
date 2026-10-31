import { DestroyRef, Injectable, inject } from "@angular/core";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { TranslateService } from "@ngx-translate/core";
import {
  AlertDialogComponent,
  AlertDialogOptions,
  AlertDialogResult,
} from "@components/alert-dialog/alert-dialog.component";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Alerts, confirmations and short prompts. The name stays from the library
 * it used to wrap; the dialogs are our own (AlertDialogComponent).
 */
@Injectable({
  providedIn: "root",
})
export class SwalService {
  private modal = inject(NgbModal);
  private translate = inject(TranslateService);

  /**
   * Opens a dialog; resolves `{ isConfirmed: false }` when it is dismissed.
   * With `closeWith`, the dialog is dismissed when that owner is destroyed
   * (for example a page left while its confirmation is still open).
   */
  open(options: AlertDialogOptions, closeWith?: DestroyRef): Promise<AlertDialogResult> {
    const dismissible = options.dismissible !== false;
    const ref = this.modal.open(AlertDialogComponent, {
      centered: true,
      size: "sm",
      windowClass: "alert-dialog-window",
      backdrop: dismissible ? true : "static",
      keyboard: dismissible,
    });
    ref.componentInstance.options = options;
    if (closeWith) {
      const unregister = closeWith.onDestroy(() => ref.dismiss());
      ref.result.then(unregister, unregister);
    }
    return ref.result.then(
      (result: AlertDialogResult) => result ?? { isConfirmed: false },
      () => ({ isConfirmed: false }),
    );
  }

  showSuccess(_title: string, message: string) {
    this.success(message);
  }

  success(message: string) {
    void this.open({ variant: "success", html: message, confirmText: this.translate.instant("BUTTONS.Ok"), confirmClass: "btn-success" });
  }

  showError(_title: string, errorMessage: string) {
    this.error(errorMessage);
  }

  error(errorMessage: string) {
    void this.open({ variant: "error", html: errorMessage, confirmText: this.translate.instant("BUTTONS.Ok"), confirmClass: "btn-danger" });
  }

  confirm(title: string, message: string, onConfirm: () => void, closeWith?: DestroyRef) {
    this.showConfirm(title, message, closeWith).then((result) => {
      if (result.isConfirmed) onConfirm();
    });
  }

  confirmDanger(title: string, message: string, onConfirm: () => void) {
    // [Tauri] Destructive actions go through the system dialog: it is the kind of
    // confirmation the user expects to be modal and native. Everything else
    // stays in-app.
    if (this.nativeDialogs) {
      (window as any).promptops
        .dialogConfirm({
          title,
          message,
          confirmLabel: this.translate.instant("BUTTONS.Confirm"),
          cancelLabel: this.translate.instant("BUTTONS.Cancel"),
          danger: true,
        })
        .then((confirmed: boolean) => {
          if (confirmed) onConfirm();
        })
        .catch(() => this.confirmDangerInApp(title, message, onConfirm));
      return;
    }
    this.confirmDangerInApp(title, message, onConfirm);
  }

  /** True only in the Tauri desktop app, where the native command exists. */
  private get nativeDialogs(): boolean {
    return !!(window as any).__TAURI__ && typeof (window as any).promptops?.dialogConfirm === "function";
  }

  private confirmDangerInApp(title: string, message: string, onConfirm: () => void) {
    this.open({
      variant: "danger",
      title,
      html: message,
      confirmText: this.translate.instant("BUTTONS.Confirm"),
      confirmClass: "btn-danger",
      cancelText: this.translate.instant("BUTTONS.Cancel"),
    }).then((result) => {
      if (result.isConfirmed) onConfirm();
    });
  }

  showConfirm(title: string, message: string, closeWith?: DestroyRef): Promise<AlertDialogResult> {
    return this.open({
      variant: "warning",
      title,
      html: message,
      confirmText: this.translate.instant("BUTTONS.Confirm"),
      cancelText: this.translate.instant("BUTTONS.Cancel"),
    }, closeWith);
  }

  /** Three-way choice: primary, secondary (deny) or dismiss. Inputs are plain text. */
  choose(options: {
    title: string;
    message: string;
    confirmText: string;
    denyText: string;
  }): Promise<"confirm" | "deny" | "cancel"> {
    return this.open({
      variant: "warning",
      title: options.title,
      html: escapeHtml(options.message),
      confirmText: options.confirmText,
      denyText: options.denyText,
      cancelText: this.translate.instant("BUTTONS.Cancel"),
    }).then((r) => (r.isConfirmed ? "confirm" : r.isDenied ? "deny" : "cancel"));
  }

  /**
   * Text-input dialog. Replacement for `window.prompt`, which is not
   * implemented in every webview. Resolves with the trimmed value,
   * or null if the user cancels or submits an empty string.
   */
  promptText(options: {
    title: string;
    message?: string;
    defaultValue?: string;
    confirmText?: string;
  }): Promise<string | null> {
    return this.open({
      variant: "info",
      title: options.title,
      html: options.message ? escapeHtml(options.message) : undefined,
      input: { value: options.defaultValue ?? "" },
      confirmText: options.confirmText ?? this.translate.instant("BUTTONS.Confirm"),
      cancelText: this.translate.instant("BUTTONS.Cancel"),
    }).then((result) => {
      if (!result.isConfirmed) return null;
      const value = typeof result.value === "string" ? result.value.trim() : "";
      return value || null;
    });
  }

  private rateLimitOpen = false;

  rateLimited(retryAfterSeconds: number) {
    // Avoid duplicate dialogs if one is already visible
    if (this.rateLimitOpen) return;
    this.rateLimitOpen = true;
    void this.open({
      variant: "warning",
      title: this.translate.instant("ALERT.Rate limit title"),
      html: this.translate.instant("ALERT.Rate limit message"),
      countdown: { seconds: retryAfterSeconds, label: this.translate.instant("ALERT.Rate limit seconds") },
      timerMs: retryAfterSeconds * 1000,
      dismissible: false,
    }).finally(() => (this.rateLimitOpen = false));
  }

  autoClose(title: string, html: string) {
    void this.open({ variant: "info", title, html, timerMs: 2000 });
  }
}
