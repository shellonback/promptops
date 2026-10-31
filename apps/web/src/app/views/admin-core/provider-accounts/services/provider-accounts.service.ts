import { DestroyRef, Injectable, inject, signal } from "@angular/core";

export type ProviderId =
  | "claude-code-cli"
  | "codex"
  | "gemini-cli"
  | "copilot"
  | "cursor"
  | "grok"
  | "opencode"
  | "antigravity"
  | "hermes"
  | "muse"
  | "zai"
  | "kimi"
  | "opencode"
  | "kora"
  | "promptops-cli"
  | "generic-shell";

export interface ProviderAccount {
  id: string;
  name: string;
  provider: ProviderId;
  configDir: string;
  commandAlias?: string;
  color?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderCapability {
  envVar: string | null;
  defaultDirName: string;
  /** The path the CLI uses when no env var is set — i.e. the user's standard installation. */
  defaultCliPath: string | null;
  support: "native" | "partial" | "unsupported";
}

export type CapabilitiesMap = Record<ProviderId, ProviderCapability>;

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  "claude-code-cli": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  kora: "Kora",
  antigravity: "Antigravity",
  hermes: "Hermes",
  muse: "Muse Code",
  zai: "Z.ai",
  kimi: "Kimi",
  "promptops-cli": "PromptOps CLI",
  "generic-shell": "Shell",
};

type OkResult<T> = { ok: true } & T;
type ErrResult = { ok: false; error: string };
type Result<T> = OkResult<T> | ErrResult;

interface ProviderAccountApi {
  listProviderAccounts?: () => Promise<Result<{ accounts: ProviderAccount[] }>>;
  listProviderAccountsBy?: (provider: string) => Promise<Result<{ accounts: ProviderAccount[] }>>;
  getProviderAccount?: (id: string) => Promise<Result<{ account: ProviderAccount | null }>>;
  getActiveProviderAccount?: (provider: string) => Promise<Result<{ account: ProviderAccount | null }>>;
  setActiveProviderAccount?: (id: string | null, provider?: string) => Promise<Result<{}>>;
  createProviderAccount?: (input: {
    name: string;
    provider: string;
    color?: string;
    notes?: string;
    commandAlias?: string;
  }) => Promise<Result<{ account: ProviderAccount }>>;
  duplicateProviderAccount?: (id: string, newName: string) => Promise<Result<{ account: ProviderAccount }>>;
  renameProviderAccount?: (id: string, name: string) => Promise<Result<{ account: ProviderAccount }>>;
  updateProviderAccount?: (
    id: string,
    patch: { name?: string; color?: string; notes?: string },
  ) => Promise<Result<{ account: ProviderAccount }>>;
  deleteProviderAccount?: (id: string, opts: { deleteFiles: boolean }) => Promise<Result<{}>>;
  openProviderAccountFolder?: (id: string) => Promise<Result<{}>>;
  importProviderAccount?: (args: {
    name: string;
    provider: string;
    sourceDir?: string;
  }) => Promise<Result<{ account: ProviderAccount }>>;
  getProviderAccountCapabilities?: () => Promise<Result<{ capabilities: CapabilitiesMap }>>;
  onProviderAccountActiveChanged?: (
    cb: (ev: unknown, data: { provider: string; accountId: string | null }) => void,
  ) => () => void;
  onProviderAccountListChanged?: (
    cb: (ev: unknown, data: { accounts: ProviderAccount[] }) => void,
  ) => () => void;
}

@Injectable({ providedIn: "root" })
export class ProviderAccountsService {
  private readonly destroyRef = inject(DestroyRef);

  readonly accounts = signal<ProviderAccount[]>([]);
  readonly activeByProvider = signal<Partial<Record<ProviderId, string>>>({});
  readonly capabilities = signal<CapabilitiesMap | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  private readonly api = (): ProviderAccountApi | undefined => {
    const w = window as unknown as { promptops?: ProviderAccountApi };
    return w.promptops;
  };
  private initialized = false;

  get isDesktop(): boolean {
    return !!this.api();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const api = this.api();
    if (!api) {
      this.error.set("Desktop runtime not available");
      return;
    }

    this.loading.set(true);
    try {
      await Promise.all([this.reloadAccounts(), this.reloadCapabilities()]);
      this.registerPushListeners();
    } finally {
      this.loading.set(false);
    }
  }

  async reloadAccounts(): Promise<void> {
    const api = this.api();
    if (!api?.listProviderAccounts) return;
    const res = await api.listProviderAccounts();
    if (!res.ok) {
      this.error.set(res.error);
      return;
    }
    this.accounts.set(res.accounts);
    this.recomputeActive(res.accounts);
  }

  async reloadCapabilities(): Promise<void> {
    const api = this.api();
    if (!api?.getProviderAccountCapabilities) return;
    const res = await api.getProviderAccountCapabilities();
    if (res.ok) this.capabilities.set(res.capabilities);
  }

  accountsFor(provider: ProviderId): ProviderAccount[] {
    return this.accounts().filter((a) => a.provider === provider);
  }

  activeFor(provider: ProviderId): ProviderAccount | null {
    const id = this.activeByProvider()[provider];
    if (!id) return null;
    return this.accounts().find((a) => a.id === id) ?? null;
  }

  capabilityFor(provider: ProviderId): ProviderCapability | null {
    const caps = this.capabilities();
    return caps ? caps[provider] : null;
  }

  async create(input: {
    name: string;
    provider: ProviderId;
    color?: string;
    notes?: string;
    commandAlias?: string;
  }): Promise<ProviderAccount | null> {
    const api = this.api();
    if (!api?.createProviderAccount) return null;
    // An invoke that rejects (e.g. signature mismatch with the native runtime) must not
    // die as an unhandled rejection: the user would see a "dead" button.
    let res: Result<{ account: ProviderAccount }>;
    try {
      res = await api.createProviderAccount(input);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
      return null;
    }
    if (!res.ok) {
      this.error.set(res.error);
      return null;
    }
    return res.account;
  }

  async rename(id: string, name: string): Promise<boolean> {
    const api = this.api();
    if (!api?.renameProviderAccount) return false;
    const res = await api.renameProviderAccount(id, name);
    if (!res.ok) this.error.set(res.error);
    return res.ok;
  }

  async updateMetadata(
    id: string,
    patch: { name?: string; color?: string; notes?: string },
  ): Promise<boolean> {
    const api = this.api();
    if (!api?.updateProviderAccount) return false;
    const res = await api.updateProviderAccount(id, patch);
    if (!res.ok) this.error.set(res.error);
    return res.ok;
  }

  async duplicate(id: string, newName: string): Promise<ProviderAccount | null> {
    const api = this.api();
    if (!api?.duplicateProviderAccount) return null;
    const res = await api.duplicateProviderAccount(id, newName);
    if (!res.ok) {
      this.error.set(res.error);
      return null;
    }
    return res.account;
  }

  async delete(id: string, opts: { deleteFiles: boolean }): Promise<boolean> {
    const api = this.api();
    if (!api?.deleteProviderAccount) return false;
    const res = await api.deleteProviderAccount(id, opts);
    if (!res.ok) this.error.set(res.error);
    return res.ok;
  }

  async setActive(id: string | null, provider?: ProviderId): Promise<boolean> {
    const api = this.api();
    if (!api?.setActiveProviderAccount) return false;
    const res = await api.setActiveProviderAccount(id, provider);
    if (!res.ok) this.error.set(res.error);
    return res.ok;
  }

  async openFolder(id: string): Promise<void> {
    const api = this.api();
    if (!api?.openProviderAccountFolder) return;
    await api.openProviderAccountFolder(id);
  }

  async importExisting(args: {
    name: string;
    provider: ProviderId;
    sourceDir?: string;
  }): Promise<ProviderAccount | null> {
    const api = this.api();
    if (!api?.importProviderAccount) return null;
    const res = await api.importProviderAccount(args);
    if (!res.ok) {
      if (res.error !== "Import canceled") this.error.set(res.error);
      return null;
    }
    return res.account;
  }

  clearError(): void {
    this.error.set(null);
  }

  private registerPushListeners(): void {
    const api = this.api();
    if (!api) return;
    const unsubs: Array<() => void> = [];
    if (api.onProviderAccountListChanged) {
      unsubs.push(
        api.onProviderAccountListChanged((_ev, data) => {
          const accounts = data.accounts as ProviderAccount[];
          this.accounts.set(accounts);
          this.recomputeActive(accounts);
        }),
      );
    }
    if (api.onProviderAccountActiveChanged) {
      unsubs.push(
        api.onProviderAccountActiveChanged((_ev, data) => {
          const prev = this.activeByProvider();
          const next = { ...prev };
          if (data.accountId === null) {
            delete next[data.provider as ProviderId];
          } else {
            next[data.provider as ProviderId] = data.accountId;
          }
          this.activeByProvider.set(next);
        }),
      );
    }
    this.destroyRef.onDestroy(() => unsubs.forEach((fn) => fn()));
  }

  private async recomputeActive(accounts: ProviderAccount[]): Promise<void> {
    const providers = Array.from(new Set(accounts.map((a) => a.provider)));
    const api = this.api();
    if (!api?.getActiveProviderAccount) return;
    const next: Partial<Record<ProviderId, string>> = {};
    await Promise.all(
      providers.map(async (p) => {
        const res = await api.getActiveProviderAccount!(p);
        if (res.ok && res.account) next[p] = res.account.id;
      }),
    );
    this.activeByProvider.set(next);
  }
}
