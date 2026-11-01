import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import {
  PROVIDER_LABELS,
  ProviderAccount,
  ProviderAccountsService,
  ProviderId,
} from "./services/provider-accounts.service";
import { ActivatedRoute } from "@angular/router";
import { SwalService } from "@core/services/swal.service";
import { FccSetupComponent } from "../fcc-setup/fcc-setup.component";
import { TranslateModule, TranslateService } from "@ngx-translate/core";

type CreateDraft = { name: string; color: string; notes: string; commandAlias: string };

const PROVIDER_ORDER: ProviderId[] = [
  "claude-code-cli",
  "codex",
  "copilot",
  "gemini-cli",
  "opencode",
  "cursor",
  "grok",
  "hermes",
  "muse",
  "antigravity",
  "zai",
  "kimi",
  "opencode",
  "kora",
  "promptops-cli",
];

const DEFAULT_ACCOUNT_COLOR = "#737373";

@Component({
  selector: "po-provider-accounts",
  standalone: true,
  imports: [FormsModule, FccSetupComponent, TranslateModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="accounts-page">
      <header><h1>{{ 'MENU.AI Accounts' | translate }}</h1><p>{{ 'PROVIDER_ACCOUNTS.Subtitle' | translate }}</p></header>
      <nav class="account-tabs" [attr.aria-label]="'PROVIDER_ACCOUNTS.Tabs label' | translate">
        <button type="button" [class.selected]="activeTab() === 'accounts'" [attr.aria-current]="activeTab() === 'accounts' ? 'page' : null" (click)="activeTab.set('accounts')">{{ 'PROVIDER_ACCOUNTS.Accounts' | translate }}</button>
        <button type="button" [class.selected]="activeTab() === 'cli'" [attr.aria-current]="activeTab() === 'cli' ? 'page' : null" (click)="activeTab.set('cli')">PromptOps CLI <small>Beta</small></button>
      </nav>
      @if (activeTab() === 'cli') {
        <app-fcc-setup></app-fcc-setup>
      } @else {
        <p class="page-hint">{{ 'PROVIDER_ACCOUNTS.Page hint' | translate }}</p>
        @if (!svc.isDesktop) { <p class="notice" role="status">{{ 'PROVIDER_ACCOUNTS.Desktop only' | translate }}</p> }
        @if (svc.error(); as err) {
          <div class="notice notice-error" role="alert"><span><strong>{{ 'PROVIDER_ACCOUNTS.Error title' | translate }}</strong> {{ err }}</span><button type="button" class="text-button" (click)="svc.clearError()">{{ 'PROVIDER_ACCOUNTS.Dismiss' | translate }}</button></div>
        }
        <div class="provider-list">
          @for (provider of orderedProviders(); track provider) {
            <section class="provider" [attr.aria-labelledby]="'provider-title-' + provider">
              <div class="provider-heading">
                <img class="provider-logo" [src]="logoFor(provider)" alt="" width="28" height="28" />
                <h2 class="provider-name" [id]="'provider-title-' + provider">{{ label(provider) }}</h2>
                <span class="provider-current">{{ svc.activeFor(provider)?.name || ('PROVIDER_ACCOUNTS.Standard' | translate) }}</span>
              </div>
              <div class="provider-content">
                <label class="account-row" [class.is-active]="!svc.activeFor(provider)">
                  <input type="radio" [name]="'active-' + provider" [checked]="!svc.activeFor(provider)" [disabled]="!svc.isDesktop" (change)="svc.setActive(null, provider)" />
                  <span class="account-info"><span class="account-name">{{ 'PROVIDER_ACCOUNTS.Standard' | translate }}</span><span class="account-detail">{{ 'PROVIDER_ACCOUNTS.Standard detail' | translate }}</span></span>
                  @if (!svc.activeFor(provider)) { <span class="active-label">{{ 'PROVIDER_ACCOUNTS.Active' | translate }}</span> }
                </label>
                @for (acc of svc.accountsFor(provider); track acc.id) {
                  <div class="saved-account" [class.is-active]="svc.activeFor(provider)?.id === acc.id">
                    <label class="account-row">
                      <input type="radio" [name]="'active-' + provider" [checked]="svc.activeFor(provider)?.id === acc.id" (change)="svc.setActive(acc.id, provider)" />
                      <span class="account-info"><span class="account-name">{{ acc.name }}</span><span class="account-detail">{{ acc.commandAlias || ('PROVIDER_ACCOUNTS.Managed profile' | translate) }}</span></span>
                      @if (svc.activeFor(provider)?.id === acc.id) { <span class="active-label">{{ 'PROVIDER_ACCOUNTS.Active' | translate }}</span> }
                    </label>
                    <details class="account-options">
                      <summary [attr.aria-label]="'PROVIDER_ACCOUNTS.Options for' | translate: { name: acc.name }">{{ 'PROVIDER_ACCOUNTS.Options' | translate }}</summary>
                      @if (acc.notes) { <p>{{ acc.notes }}</p> }
                      <div class="account-actions">
                        <button type="button" class="text-button" (click)="onRename(acc)">{{ 'PROVIDER_ACCOUNTS.Rename' | translate }}</button>
                        @if (!acc.commandAlias) {
                          <button type="button" class="text-button" (click)="svc.openFolder(acc.id)">{{ 'PROVIDER_ACCOUNTS.Open folder' | translate }}</button>
                          <button type="button" class="text-button" (click)="onDuplicate(acc)">{{ 'PROVIDER_ACCOUNTS.Duplicate' | translate }}</button>
                        }
                        <button type="button" class="text-button" [disabled]="svc.activeFor(provider)?.id === acc.id" [title]="(svc.activeFor(provider)?.id === acc.id ? 'PROVIDER_ACCOUNTS.Remove active hint' : 'PROVIDER_ACCOUNTS.Remove account') | translate" (click)="onDelete(acc)">{{ 'PROVIDER_ACCOUNTS.Remove' | translate }}</button>
                      </div>
                    </details>
                  </div>
                }
                @if (creatingFor() === provider) {
                  <form class="create-account" (ngSubmit)="submitCreate(provider)">
                    <fieldset [disabled]="busy()">
                      <legend>{{ 'PROVIDER_ACCOUNTS.Alias question' | translate }}</legend>
                      <div class="alias-choice" role="group" [attr.aria-label]="'PROVIDER_ACCOUNTS.Alias setup' | translate">
                        <button type="button" class="choice" [class.selected]="aliasMode() === 'existing'" [attr.aria-pressed]="aliasMode() === 'existing'" (click)="aliasMode.set('existing')">{{ 'PROVIDER_ACCOUNTS.Use mine' | translate }}</button>
                        <button type="button" class="choice" [class.selected]="aliasMode() === 'managed'" [attr.aria-pressed]="aliasMode() === 'managed'" [disabled]="supportOf(provider) === 'unsupported'" (click)="aliasMode.set('managed')">{{ 'PROVIDER_ACCOUNTS.Create one' | translate }}</button>
                      </div>
                      @if (supportOf(provider) === 'unsupported') { <p class="field-hint">{{ 'PROVIDER_ACCOUNTS.Alias only' | translate }}</p> }
                      @if (aliasMode() === 'existing') {
                        <label class="field-label" [for]="'alias-' + provider">{{ 'PROVIDER_ACCOUNTS.Alias' | translate }}</label>
                        <input class="text-input" [id]="'alias-' + provider" name="commandAlias" type="text" [placeholder]="'PROVIDER_ACCOUNTS.Alias placeholder' | translate" autocomplete="off" spellcheck="false" maxlength="128" [ngModel]="draft().commandAlias" (ngModelChange)="updateDraft('commandAlias', $event)" [attr.aria-describedby]="'alias-help-' + provider" [attr.aria-invalid]="!!draft().commandAlias && !validAlias()" />
                        <p class="field-hint" [id]="'alias-help-' + provider">
                          @if (draft().commandAlias && !validAlias()) { {{ 'PROVIDER_ACCOUNTS.Alias invalid' | translate }} }
                          @else { {{ 'PROVIDER_ACCOUNTS.Alias hint' | translate }} }
                        </p>
                      } @else if (aliasMode() === 'managed') {
                        <label class="field-label" [for]="'name-' + provider">{{ 'PROVIDER_ACCOUNTS.Account name' | translate }}</label>
                        <input class="text-input" [id]="'name-' + provider" name="name" type="text" [placeholder]="'PROVIDER_ACCOUNTS.Name placeholder' | translate" [ngModel]="draft().name" (ngModelChange)="updateDraft('name', $event)" />
                        <p class="field-hint">{{ 'PROVIDER_ACCOUNTS.Managed hint' | translate }}</p>
                        @if (supportOf(provider) === 'partial') { <p class="field-hint">{{ 'PROVIDER_ACCOUNTS.Partial hint' | translate }}</p> }
                      }
                      @if (aliasMode()) {
                        <details class="optional-fields">
                          <summary>{{ 'PROVIDER_ACCOUNTS.Optional details' | translate }}</summary>
                          @if (aliasMode() === 'existing') {
                            <label class="field-label" [for]="'name-' + provider">{{ 'PROVIDER_ACCOUNTS.Display name' | translate }}</label>
                            <input class="text-input" [id]="'name-' + provider" name="name" type="text" [placeholder]="'PROVIDER_ACCOUNTS.Name placeholder' | translate" [ngModel]="draft().name" (ngModelChange)="updateDraft('name', $event)" />
                          }
                          <label class="field-label" [for]="'notes-' + provider">{{ 'PROVIDER_ACCOUNTS.Notes' | translate }}</label>
                          <input class="text-input" [id]="'notes-' + provider" name="notes" type="text" [ngModel]="draft().notes" (ngModelChange)="updateDraft('notes', $event)" />
                        </details>
                      }
                      <div class="form-actions">
                        <button type="button" class="text-button" (click)="cancelCreate()">{{ 'BUTTONS.Cancel' | translate }}</button>
                        @if (aliasMode()) { <button type="submit" class="primary-button" [disabled]="!canCreate() || busy()">{{ (busy() ? 'PROVIDER_ACCOUNTS.Saving' : aliasMode() === 'existing' ? 'PROVIDER_ACCOUNTS.Add alias' : 'PROVIDER_ACCOUNTS.Create profile') | translate }}</button> }
                      </div>
                    </fieldset>
                  </form>
                } @else if (svc.isDesktop) {
                  <button type="button" class="add-account text-button" (click)="toggleCreate(provider)"><span aria-hidden="true">+</span> {{ 'PROVIDER_ACCOUNTS.Add account' | translate }}</button>
                }
              </div>
            </section>
          }
        </div>
        <p class="local-note">{{ 'PROVIDER_ACCOUNTS.Local note' | translate }}</p>
      }
    </section>
  `,
  styles: [`
    :host {
      display: block;
      --account-bg: var(--po-page-surface, var(--po-bg-2));
      --account-soft: var(--po-page-soft, var(--po-bg-3));
      --account-hover: var(--po-bg-4);
      --account-text: var(--po-page-ink, var(--po-text-primary));
      --account-muted: var(--po-page-muted, var(--po-text-secondary));
      --account-line: var(--po-page-border, var(--po-border-subtle));
    }
    .accounts-page { padding: 24px 12px; color: var(--account-text); }
    h1 { margin: 0 0 6px; font-size: 1.25rem; font-weight: 600; letter-spacing: -.4px; }
    header p, .page-hint, .local-note { color: var(--account-muted); font-size: 13px; line-height: 1.6; margin: 0; }
    button { font: inherit; cursor: pointer; }
    .account-tabs { display: flex; gap: 24px; border-bottom: 1px solid var(--account-line); margin: 24px 0 18px; }
    .account-tabs button { padding: 0 0 12px; background: none; border: 0; border-bottom: 2px solid transparent; color: var(--account-muted); font-size: 13px; }
    .account-tabs button.selected { border-bottom-color: var(--account-text); color: var(--account-text); }
    .account-tabs small { margin-left: 5px; font-size: 10px; color: var(--account-muted); }
    .page-hint { margin-bottom: 20px; }
    .provider-list { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; align-items: start; }
    .provider { min-width: 0; border: 1px solid var(--account-line); border-radius: var(--po-radius-lg); background: var(--account-bg); overflow: hidden; }
    .provider-heading { display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: center; column-gap: 10px; row-gap: 3px; padding: 16px; min-height: 80px; }
    .provider-logo { grid-row: 1 / 3; width: 28px; height: 28px; object-fit: contain; }
    .provider-name { margin: 0; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
    .provider-current { grid-column: 2; grid-row: 2; color: var(--account-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .provider-content { padding: 0 12px 12px; }
    .account-row { display: flex; align-items: center; gap: 12px; padding: 11px 12px; margin: 0; cursor: pointer; border-radius: var(--po-radius-md); }
    .account-row:hover { background: var(--account-soft); }
    .is-active { background: var(--account-soft); border-radius: var(--po-radius-md); }
    input[type="radio"] { width: 15px; height: 15px; flex-shrink: 0; accent-color: var(--account-text); }
    .account-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .account-name { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
    .account-detail { color: var(--account-muted); font-size: 12px; overflow-wrap: anywhere; }
    .active-label { font-size: 11px; color: var(--account-muted); }
    .saved-account { margin-top: 4px; }
    .account-options { padding: 0 12px 8px 39px; font-size: 12px; color: var(--account-muted); }
    .account-options summary, .optional-fields summary { cursor: pointer; width: fit-content; }
    .account-options p { margin: 8px 0; overflow-wrap: anywhere; }
    .account-actions { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 8px; }
    .text-button { background: none; border: 0; padding: 4px 0; color: var(--account-muted); font-size: 12px; }
    .text-button:hover:not(:disabled) { color: var(--account-text); text-decoration: underline; text-underline-offset: 3px; }
    .add-account { display: flex; gap: 7px; align-items: center; margin: 12px 12px 0; color: var(--account-text); }
    .create-account { background: var(--account-soft); border: 1px solid var(--account-line); border-radius: var(--po-radius-lg); padding: 18px; margin-top: 12px; }
    fieldset { margin: 0; padding: 0; border: 0; min-width: 0; }
    legend { float: none; width: auto; font-size: 13px; font-weight: 600; margin: 0 0 12px; }
    .alias-choice { display: flex; flex-direction: column; gap: 8px; }
    .choice, .primary-button { border: 1px solid var(--account-line); border-radius: var(--po-radius-md); padding: 9px 13px; font-size: 12px; background: var(--account-bg); color: var(--account-text); }
    .choice:hover:not(:disabled) { background: var(--account-hover); }
    .choice.selected, .primary-button { border-color: var(--account-text); background: var(--account-text); color: var(--account-bg); }
    .primary-button:hover:not(:disabled) { opacity: .85; }
    .field-label { display: block; font-size: 12px; font-weight: 500; margin: 16px 0 6px; }
    .text-input { display: block; width: 100%; border: 1px solid var(--account-line); border-radius: var(--po-radius-md); padding: 10px 12px; background: var(--account-bg); color: var(--account-text); font-size: 13px; }
    .text-input::placeholder { color: var(--account-muted); }
    .text-input[aria-invalid="true"] { border-color: var(--account-text); border-style: dashed; }
    .field-hint { font-size: 12px; color: var(--account-muted); line-height: 1.5; margin: 8px 0 0; }
    .optional-fields { margin-top: 16px; color: var(--account-muted); font-size: 12px; }
    .form-actions { display: flex; align-items: center; justify-content: flex-end; gap: 18px; margin-top: 18px; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    button:focus-visible, summary:focus-visible, input:focus-visible { outline: 2px solid var(--account-text); outline-offset: 3px; }
    .notice { border: 1px solid var(--account-line); border-radius: var(--po-radius-md); background: var(--account-soft); padding: 12px; margin-bottom: 16px; font-size: 12px; }
    .notice-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-left: 3px solid var(--account-text); }
    .local-note { margin-top: 16px; font-size: 12px; }
    @media (max-width: 1199px) { .provider-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 576px) {
      .provider-list { grid-template-columns: minmax(0, 1fr); }
      .accounts-page { padding: 20px 12px; }
      .provider-heading { padding: 15px 12px; }
      .provider-content { padding: 0 6px 8px; }
      .create-account { padding: 14px; }
      .alias-choice { flex-direction: column; }
      .account-tabs { gap: 18px; }
    }
  `],
})
export class ProviderAccountsComponent implements OnInit {
  readonly svc = inject(ProviderAccountsService);
  private readonly swal = inject(SwalService);
  private readonly translate = inject(TranslateService);
  private readonly route = inject(ActivatedRoute);
  readonly orderedProviders = computed<ProviderId[]>(() => PROVIDER_ORDER);

  readonly activeTab = signal<"accounts" | "cli">("accounts");
  readonly creatingFor = signal<ProviderId | null>(null);
  readonly draft = signal<CreateDraft>({ name: "", color: DEFAULT_ACCOUNT_COLOR, notes: "", commandAlias: "" });
  readonly busy = signal(false);
  readonly aliasMode = signal<'existing' | 'managed' | null>(null);
  readonly validAlias = computed(() => /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(this.draft().commandAlias.trim()));
  readonly canCreate = computed(() => this.aliasMode() === 'existing' ? this.validAlias() : this.aliasMode() === 'managed' && !!this.draft().name.trim());

  ngOnInit(): void {
    if (this.route.snapshot.queryParamMap.get("tab") === "cli") this.activeTab.set("cli");
    void this.svc.init();
  }

  logoFor(provider: ProviderId): string {
    if (provider === "promptops-cli") return "assets/logos/compact-logo-v3.png";
    const logos: Partial<Record<ProviderId, string>> = {
      "claude-code-cli": "claude", codex: "openai", "gemini-cli": "gemini",
      antigravity: "antigravity", copilot: "copilot", cursor: "cursor",
      grok: "grok", hermes: "hermes", muse: "muse", zai: "zai", kimi: "kimi",
      kora: "kora",
    };
    return `assets/providers/${logos[provider] ?? "terminal"}.svg`;
  }

  label(provider: ProviderId): string {
    return PROVIDER_LABELS[provider];
  }

  supportOf(provider: ProviderId): "native" | "partial" | "unsupported" {
    return this.svc.capabilityFor(provider)?.support ?? "unsupported";
  }

  toggleCreate(provider: ProviderId): void {
    const current = this.creatingFor();
    if (current === provider) {
      this.cancelCreate();
      return;
    }
    this.creatingFor.set(provider);
    this.aliasMode.set(null);
    this.draft.set({ name: "", color: DEFAULT_ACCOUNT_COLOR, notes: "", commandAlias: "" });
  }

  cancelCreate(): void {
    this.creatingFor.set(null);
    this.aliasMode.set(null);
    this.draft.set({ name: "", color: DEFAULT_ACCOUNT_COLOR, notes: "", commandAlias: "" });
  }

  updateDraft<K extends keyof CreateDraft>(key: K, value: CreateDraft[K]): void {
    this.draft.update((d) => ({ ...d, [key]: value }));
  }

  async submitCreate(provider: ProviderId): Promise<void> {
    const d = this.draft();
    if (!this.canCreate() || this.busy()) return;
    this.busy.set(true);
    try {
      const created = await this.svc.create({
        name: d.name.trim() || d.commandAlias.trim(),
        commandAlias: this.aliasMode() === 'existing' ? d.commandAlias.trim() : undefined,
        provider,
        color: d.color,
        notes: d.notes.trim() || undefined,
      });
      if (created) this.cancelCreate();
    } finally {
      this.busy.set(false);
    }
  }

  // window.prompt/confirm are not reliable in the desktop webview — use Swal dialogs.
  async onRename(acc: ProviderAccount): Promise<void> {
    const next = await this.swal.promptText({
      title: this.translate.instant("PROVIDER_ACCOUNTS.Rename title"),
      message: this.translate.instant("PROVIDER_ACCOUNTS.Rename message", { name: acc.name }),
      defaultValue: acc.name,
    });
    if (!next || next === acc.name) return;
    await this.svc.rename(acc.id, next);
  }

  async onDuplicate(acc: ProviderAccount): Promise<void> {
    const next = await this.swal.promptText({
      title: this.translate.instant("PROVIDER_ACCOUNTS.Duplicate title"),
      message: this.translate.instant("PROVIDER_ACCOUNTS.Duplicate message", { name: acc.name }),
      defaultValue: this.translate.instant("PROVIDER_ACCOUNTS.Copy suffix", { name: acc.name }),
    });
    if (!next) return;
    await this.svc.duplicate(acc.id, next);
  }

  onDelete(acc: ProviderAccount): void {
    // The desktop side erases only folders PromptOps created under
    // ~/.promptops/provider-accounts: an imported folder is kept, so the
    // dialog must not promise (or threaten) to erase it.
    const managed = !acc.commandAlias && /[\\/]\.promptops[\\/]provider-accounts[\\/]/.test(acc.configDir);
    const message = acc.commandAlias
      ? this.translate.instant("PROVIDER_ACCOUNTS.Delete alias", { alias: acc.commandAlias })
      : managed
        ? this.translate.instant("PROVIDER_ACCOUNTS.Delete managed", { path: acc.configDir })
        : this.translate.instant("PROVIDER_ACCOUNTS.Delete imported", { path: acc.configDir });
    this.swal.confirmDanger(
      this.translate.instant("PROVIDER_ACCOUNTS.Delete title", { name: acc.name }),
      message,
      () => void this.svc.delete(acc.id, { deleteFiles: managed }),
    );
  }
}
