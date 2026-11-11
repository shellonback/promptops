import { Injectable, computed, effect, signal } from '@angular/core';
import { sanitizeDialogHtml } from '@/app/components/alert-dialog/alert-dialog.component';

export type ArtifactType = 'mail' | 'documentation' | 'changelog' | 'report' | 'handover' | 'estimate';
export type WriterTone = 'professional' | 'formal' | 'informal';
export type WriterLanguage = 'auto' | 'en' | 'it' | 'de' | 'fr' | 'es';

/** Static traits of each artifact type. Order = display order (mail first). */
export interface ArtifactTypeDef {
  type: ArtifactType;
  icon: string;
  /** Tone selector applies (mail only — documents have a fixed register). */
  usesTone: boolean;
  /** Recipient field applies (mail only). */
  usesRecipient: boolean;
  /** The artifact can be generated from git context alone, with no draft. */
  draftOptionalWithContext: boolean;
  /** Default file name prefix for docs/<prefix>-<date>.md */
  filePrefix: string;
  /** A linked repo is mandatory (the artifact is derived from the codebase). */
  requiresContext?: boolean;
  /** Run the provider CLI inside the linked repo so it can explore the code. */
  studiesCodebase?: boolean;
}

export const ARTIFACT_TYPES: ArtifactTypeDef[] = [
  { type: 'mail', icon: 'ti-mail', usesTone: true, usesRecipient: true, draftOptionalWithContext: false, filePrefix: 'mail' },
  { type: 'documentation', icon: 'ti-book-2', usesTone: false, usesRecipient: false, draftOptionalWithContext: true, filePrefix: 'documentation' },
  { type: 'changelog', icon: 'ti-list-details', usesTone: false, usesRecipient: false, draftOptionalWithContext: true, filePrefix: 'changelog' },
  { type: 'report', icon: 'ti-report', usesTone: false, usesRecipient: false, draftOptionalWithContext: true, filePrefix: 'report' },
  { type: 'handover', icon: 'ti-transfer', usesTone: false, usesRecipient: false, draftOptionalWithContext: true, filePrefix: 'handover' },
  { type: 'estimate', icon: 'ti-calculator', usesTone: false, usesRecipient: false, draftOptionalWithContext: false, filePrefix: 'estimate', requiresContext: true, studiesCodebase: true },
];

/** Switchable models per provider — mirrors SPAWN_MODELS (action-center) /
 * SPEED_TEST_MODELS (speed-test-runner.ts). KEEP IN SYNC. Providers not
 * listed here (gemini, grok) run with their CLI default. */
export const WRITER_MODELS: Record<string, ReadonlyArray<{ id: string; label: string }>> = {
  'claude-code-cli': [
    { id: 'claude-fable-5-2', label: 'Fable 5.2' },
    { id: 'claude-fable-5-1', label: 'Fable 5.1' },
    { id: 'claude-fable-5', label: 'Fable 5' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ],
  'codex': [
    { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
    { id: 'gpt-6-sol', label: 'GPT-6-Sol' },
    { id: 'gpt-6-luna', label: 'GPT-6-Luna' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
  ],
};

/** Transient link to a session/workspace used to pull git context. Never persisted. */
export interface LinkedTarget {
  kind: 'workspace' | 'session';
  id: string;
  name: string;
  path: string;
}

export interface GitCommitPreview {
  shortHash: string;
  message: string;
  relativeDate: string;
}

/** Loaded git context for one repository (the linked folder or a sub-repo). */
export interface RepoContext {
  name: string;
  path: string;
  branch: string;
  changedFiles: string[];
  commits: GitCommitPreview[];
}

/** A git repo found inside a linked folder that is not itself a repository. */
export interface DiscoveredRepo {
  name: string;
  path: string;
  branch: string;
  selected: boolean;
}

// Same budget the AI commit-message generator uses (git-handlers.ts) so a
// huge working-tree diff cannot blow up the provider prompt. With multiple
// repos linked, the budget is split across them.
const DIFF_CHAR_BUDGET = 6000;
const MIN_REPO_DIFF_BUDGET = 1500;
// Codebase-studying artifacts (estimate) explore the repo before writing, so
// they need far more than the 90s default of the ai:generate-text IPC.
const CODEBASE_STUDY_TIMEOUT_MS = 600_000;
const COMMIT_LIMIT = 5;
const FILE_LIST_LIMIT = 30;

const TONE_INSTRUCTIONS: Record<WriterTone, string> = {
  professional: 'professional but approachable',
  formal: 'formal and respectful',
  informal: 'informal and friendly',
};

const LANGUAGE_NAMES: Record<Exclude<WriterLanguage, 'auto'>, string> = {
  en: 'English',
  it: 'Italian',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
};

const VALID_LANGUAGES: WriterLanguage[] = ['auto', 'en', 'it', 'de', 'fr', 'es'];
// Must stay aligned with the provider cards in git-writer.component.ts.
const VALID_PROVIDERS = ['claude-code-cli', 'codex', 'gemini-cli', 'grok'];
const VALID_TYPES: ArtifactType[] = ARTIFACT_TYPES.map((t) => t.type);

const SETTINGS_STORAGE_KEY = 'promptops_git_writer_settings';
// Pre-rename key: migrate language/provider from the old Mail writer once.
const LEGACY_SETTINGS_STORAGE_KEY = 'promptops_mail_writer_settings';
const CONTENT_STORAGE_KEY = 'promptops_git_writer_content';
// localStorage safety valve: never persist a content blob bigger than this.
const CONTENT_PERSIST_LIMIT = 400_000;

interface StoredWriterSettings {
  language?: WriterLanguage;
  provider?: string;
  tone?: WriterTone;
  /** Last model picked per provider (Auto = absent). Keyed by provider so a
   * recalled model can never leak into a different provider's CLI. */
  models?: Record<string, string>;
}

/** Draft + result snapshot persisted so navigating away never loses work. */
interface StoredWriterContent {
  artifactType?: ArtifactType;
  draft?: string;
  recipient?: string;
  resultSubject?: string;
  resultBody?: string;
  generatedType?: ArtifactType;
  fileName?: string;
}

/** Matches any default file name we generate, so it can be safely replaced. */
const DEFAULT_FILENAME_RE = /^(mail|documentation|changelog|report|handover|estimate)-\d{4}-\d{2}-\d{2}\.md$/;

/**
 * State + generation logic for the AI Git Writer page. Root-provided AND
 * persisted to localStorage, so an in-progress draft survives both in-app
 * navigation and a full app restart.
 *
 * All AI generation goes through the LOCAL provider CLIs via the existing
 * `ai:generate-text` IPC: the git context (diff, changed files, recent commits)
 * is read locally and inlined in the prompt. It is NOT sent to PromptOps' own
 * servers, but — like any prompt to a coding agent — the provider's CLI forwards
 * it to that provider's AI model (Anthropic/OpenAI/Google/xAI). So the phrasing
 * is "code doesn't go to PromptOps", not "code never leaves the machine".
 * Saving writes through the existing `fs:write-file` IPC, which is path-guarded
 * to stay inside the selected repo. (AA-01, audit AI Act/GDPR.)
 */
@Injectable({ providedIn: 'root' })
export class GitWriterService {
  // ── Compose form ──
  readonly artifactType = signal<ArtifactType>('mail');
  readonly draft = signal('');
  readonly tone = signal<WriterTone>('professional');
  readonly language = signal<WriterLanguage>('auto');
  readonly recipient = signal('');
  readonly provider = signal('claude-code-cli');
  /** Model override for the current provider. null = Auto (CLI default). */
  readonly model = signal<string | null>(null);
  /** Per-provider model memory, persisted with the settings. */
  private readonly modelsByProvider = signal<Record<string, string>>({});

  // ── Temporary context link ──
  readonly linked = signal<LinkedTarget | null>(null);
  /** Sub-repos found when the linked folder is not itself a git repo. */
  readonly discoveredRepos = signal<DiscoveredRepo[]>([]);
  /** Git context loaded for the linked repo, or for each selected sub-repo. */
  readonly contexts = signal<RepoContext[]>([]);
  /** True when the linked folder is not a repo and contains none. */
  readonly notARepo = signal(false);
  readonly contextLoading = signal(false);
  readonly includeDiff = signal(true);
  readonly includeCommits = signal(true);
  readonly includeFiles = signal(true);

  // ── Output ──
  // For mail: resultSubject + resultBody as HTML. For the document artifacts:
  // resultBody holds raw Markdown and resultSubject stays empty.
  readonly generating = signal(false);
  readonly refining = signal(false);
  readonly resultSubject = signal('');
  readonly resultBody = signal('');
  /** Artifact type the current result was generated as (save/editor follow this). */
  readonly generatedType = signal<ArtifactType>('mail');
  readonly error = signal('');

  // ── Save to repo docs/ ──
  readonly fileName = signal('');
  readonly saveRepoPath = signal<string | null>(null);
  readonly saving = signal(false);
  /** "<repo>/docs/<file>" of the last successful save, for the confirmation chip. */
  readonly savedPath = signal('');
  readonly saveError = signal('');
  /** Set when the target file already exists: the next save call overwrites. */
  readonly overwritePending = signal(false);

  /** Models pickable for the current provider (empty = no picker shown). */
  readonly modelOptions = computed(() => WRITER_MODELS[this.provider()] ?? []);

  readonly currentDef = computed(
    () => ARTIFACT_TYPES.find((t) => t.type === this.artifactType()) ?? ARTIFACT_TYPES[0],
  );
  readonly generatedDef = computed(
    () => ARTIFACT_TYPES.find((t) => t.type === this.generatedType()) ?? ARTIFACT_TYPES[0],
  );

  /** Documents can be generated from git context alone; mail always needs a draft. */
  readonly canGenerate = computed(() => {
    const def = this.currentDef();
    // Codebase-derived artifacts (estimate) need a linked repo, no exceptions.
    if (def.requiresContext && this.contexts().length === 0) return false;
    if (this.draft().trim()) return true;
    return def.draftOptionalWithContext && this.contexts().length > 0;
  });

  /** Repos the artifact can be saved into (the linked repo or selected sub-repos). */
  readonly saveTargets = computed(() => this.contexts());

  readonly saveTarget = computed(() => {
    const targets = this.saveTargets();
    const chosen = this.saveRepoPath();
    return targets.find((t) => t.path === chosen) ?? targets[0] ?? null;
  });

  constructor() {
    this.restoreSettings();
    this.restoreContent();
    // Persist tool settings on every change so returning users find the tool
    // configured as they left it.
    effect(() => {
      const settings: StoredWriterSettings = {
        language: this.language(),
        provider: this.provider(),
        tone: this.tone(),
        models: this.modelsByProvider(),
      };
      try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
      } catch {
        // Storage full/unavailable: settings simply won't persist.
      }
    });
    // Persist draft + result so leaving the page (or the app) never loses work.
    effect(() => {
      const content: StoredWriterContent = {
        artifactType: this.artifactType(),
        draft: this.draft(),
        recipient: this.recipient(),
        resultSubject: this.resultSubject(),
        resultBody: this.resultBody(),
        generatedType: this.generatedType(),
        fileName: this.fileName(),
      };
      try {
        const raw = JSON.stringify(content);
        if (raw.length <= CONTENT_PERSIST_LIMIT) {
          localStorage.setItem(CONTENT_STORAGE_KEY, raw);
        }
      } catch {
        // Storage full/unavailable: content simply won't persist.
      }
    });
    // Any change to the result or the file name invalidates a previous save
    // confirmation and a pending overwrite check.
    effect(() => {
      this.resultBody();
      this.resultSubject();
      this.fileName();
      this.savedPath.set('');
      this.saveError.set('');
      this.overwritePending.set(false);
    });
  }

  get isDesktop(): boolean {
    return !!(window as any).promptops;
  }

  private get api(): any {
    return (window as any).promptops;
  }

  /** Switch provider and recall the model last used with it (or Auto). */
  selectProvider(value: string): void {
    this.provider.set(value);
    const remembered = this.modelsByProvider()[value];
    const valid = (WRITER_MODELS[value] ?? []).some((m) => m.id === remembered);
    this.model.set(valid ? remembered : null);
  }

  /** Pick a model for the current provider (null = Auto) and remember it. */
  selectModel(id: string | null): void {
    this.model.set(id);
    const provider = this.provider();
    this.modelsByProvider.update((mem) => {
      const next = { ...mem };
      if (id) next[provider] = id;
      else delete next[provider];
      return next;
    });
  }

  async link(target: LinkedTarget): Promise<void> {
    this.linked.set(target);
    this.contexts.set([]);
    this.discoveredRepos.set([]);
    this.notARepo.set(false);
    this.saveRepoPath.set(null);
    if (!this.isDesktop) return;
    this.contextLoading.set(true);
    try {
      const status = await this.api.getGitStatus(target.path);
      if (status?.ok) {
        const ctx = await this.loadRepoContext(target.name, target.path);
        this.contexts.set(ctx ? [ctx] : []);
        return;
      }
      // Not a repo itself: look for repos in its immediate subfolders.
      const discovered = await this.api.gitDiscoverRepos(target.path);
      const repos: { name: string; path: string; branch: string }[] = discovered?.ok
        ? discovered.repos || []
        : [];
      if (repos.length === 0) {
        this.notARepo.set(true);
        return;
      }
      // All discovered repos are included by default; the user can deselect
      // the ones that don't matter for this artifact.
      this.discoveredRepos.set(repos.map((r) => ({ ...r, selected: true })));
      await this.reloadContexts();
    } catch {
      this.notARepo.set(true);
    } finally {
      this.contextLoading.set(false);
    }
  }

  async toggleRepo(path: string): Promise<void> {
    this.discoveredRepos.update((repos) =>
      repos.map((r) => (r.path === path ? { ...r, selected: !r.selected } : r)),
    );
    await this.reloadContexts();
  }

  unlink(): void {
    this.linked.set(null);
    this.discoveredRepos.set([]);
    this.contexts.set([]);
    this.notARepo.set(false);
    this.saveRepoPath.set(null);
  }

  async generate(): Promise<void> {
    if (!this.canGenerate() || this.generating() || !this.isDesktop) return;
    this.generating.set(true);
    this.error.set('');
    try {
      const type = this.artifactType();
      const prompt = await this.buildGeneratePrompt(type);
      // No cwd on purpose: running inside the repo makes the CLI ingest the
      // project instructions (CLAUDE.md etc.) on every run — slow and useless
      // here, since the git context is already inlined in the prompt.
      // Exception: codebase-studying artifacts (estimate) DO run inside the
      // linked folder, so the CLI can explore the actual code before writing.
      const cwd = this.currentDef().studiesCodebase ? this.linked()?.path : undefined;
      const res = await this.api.aiGenerateText(
        prompt,
        this.provider(),
        cwd,
        cwd ? CODEBASE_STUDY_TIMEOUT_MS : undefined,
        this.model() ?? undefined,
      );
      if (!res?.ok) throw new Error(res?.error || 'Generation failed');
      this.applyResult(res.text, type);
    } catch (err: any) {
      this.error.set(err?.message || 'Generation failed');
    } finally {
      this.generating.set(false);
    }
  }

  async refine(instructions: string): Promise<void> {
    if (!instructions.trim() || !this.resultBody().trim() || this.refining() || !this.isDesktop) {
      return;
    }
    this.refining.set(true);
    this.error.set('');
    try {
      const type = this.generatedType();
      const prompt = this.buildRefinePrompt(instructions.trim(), type);
      const res = await this.api.aiGenerateText(
        prompt,
        this.provider(),
        undefined,
        undefined,
        this.model() ?? undefined,
      );
      if (!res?.ok) throw new Error(res?.error || 'Generation failed');
      this.applyResult(res.text, type);
    } catch (err: any) {
      this.error.set(err?.message || 'Generation failed');
    } finally {
      this.refining.set(false);
    }
  }

  /** Clear draft + output, keep type/tone/provider/link so consecutive runs are fast. */
  startOver(): void {
    this.draft.set('');
    this.recipient.set('');
    this.resultSubject.set('');
    this.resultBody.set('');
    this.error.set('');
    this.fileName.set('');
    this.savedPath.set('');
    this.saveError.set('');
    this.overwritePending.set(false);
  }

  /**
   * Save the current artifact into docs/ of the selected repo. First call
   * checks for an existing file and, if found, arms `overwritePending` so the
   * UI can ask for an explicit confirmation; the second call overwrites.
   */
  async saveToRepo(): Promise<void> {
    const target = this.saveTarget();
    if (!target || !this.resultBody().trim() || this.saving() || !this.isDesktop) return;
    const fileName = this.normalizedFileName();
    const relPath = `docs/${fileName}`;
    this.saving.set(true);
    this.saveError.set('');
    try {
      if (!this.overwritePending()) {
        const existing = await this.api.fsReadFile(target.path, relPath);
        const exists =
          !!existing?.ok || /too large|binary/i.test(String(existing?.error || ''));
        if (exists) {
          this.overwritePending.set(true);
          return;
        }
      }
      const res = await this.api.fsWriteFile(target.path, relPath, this.buildFileContent());
      if (!res?.ok) throw new Error(res?.error || 'Save failed');
      this.overwritePending.set(false);
      this.savedPath.set(`${target.name}/${relPath}`);
    } catch (err: any) {
      this.saveError.set(err?.message || 'Save failed');
    } finally {
      this.saving.set(false);
    }
  }

  /** File name with path separators stripped and a .md extension enforced. */
  normalizedFileName(): string {
    let name = this.fileName().trim().replace(/[\\/]+/g, '-').replace(/^\.+/, '');
    if (!name) name = this.defaultFileName(this.generatedType());
    if (!/\.(md|markdown|txt)$/i.test(name)) name += '.md';
    return name;
  }

  defaultFileName(type: ArtifactType): string {
    const def = ARTIFACT_TYPES.find((t) => t.type === type) ?? ARTIFACT_TYPES[0];
    return `${def.filePrefix}-${this.todayStamp()}.md`;
  }

  /** What actually lands in the file: raw Markdown, or a text rendition of the mail. */
  private buildFileContent(): string {
    if (this.generatedType() !== 'mail') {
      return this.resultBody().replace(/\s+$/, '') + '\n';
    }
    const subject = this.resultSubject().trim();
    const body = this.getBodyPlainText();
    return (subject ? `# ${subject}\n\n${body}` : body).replace(/\s+$/, '') + '\n';
  }

  /** Reload git context for the current selection (linked repo or sub-repos). */
  private async reloadContexts(): Promise<void> {
    const linked = this.linked();
    if (!linked) return;
    const targets = this.discoveredRepos().length
      ? this.discoveredRepos()
          .filter((r) => r.selected)
          .map((r) => ({ name: r.name, path: r.path }))
      : [{ name: linked.name, path: linked.path }];
    this.contextLoading.set(true);
    try {
      const loaded = await Promise.all(
        targets.map((t) => this.loadRepoContext(t.name, t.path)),
      );
      this.contexts.set(loaded.filter((c): c is RepoContext => c !== null));
    } finally {
      this.contextLoading.set(false);
    }
  }

  private async loadRepoContext(name: string, path: string): Promise<RepoContext | null> {
    try {
      const [status, log] = await Promise.all([
        this.api.getGitStatus(path),
        this.api.gitLog(path, COMMIT_LIMIT),
      ]);
      if (!status?.ok) return null;
      return {
        name,
        path,
        branch: status.branch || '',
        changedFiles: (status.files || []).map(
          (f: any) => `${f.statusCode || f.status || 'M'} ${f.path}`,
        ),
        commits: log?.ok
          ? (log.commits || []).slice(0, COMMIT_LIMIT).map((c: any) => ({
              shortHash: c.shortHash || '',
              message: c.message || '',
              relativeDate: c.relativeDate || '',
            }))
          : [],
      };
    } catch {
      return null;
    }
  }

  /**
   * Parse the provider output. Mail keeps the "Subject: ..." first-line
   * contract (with localized prefixes tolerated); document artifacts are
   * plain Markdown, so only code fences are stripped.
   */
  private applyResult(text: string, type: ArtifactType): void {
    const cleaned = (text || '')
      .trim()
      .replace(/^```(?:html|markdown|md)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    if (type !== 'mail') {
      // Some CLIs narrate before the document despite the "output only" rule
      // ("Ecco il preventivo. # ..."): cut everything before the first H1.
      const h1 = cleaned.search(/^# /m);
      this.resultSubject.set('');
      this.resultBody.set(h1 > 0 ? cleaned.slice(h1) : cleaned);
    } else {
      const lines = cleaned.split('\n');
      const firstIdx = lines.findIndex((l) => l.trim().length > 0);
      const first = firstIdx >= 0 ? lines[firstIdx].trim() : '';
      const match = first.match(/^(?:subject|oggetto|betreff|objet|asunto)\s*:\s*(.*)$/i);
      if (match) {
        this.resultSubject.set(match[1].trim());
        this.resultBody.set(this.ensureHtml(lines.slice(firstIdx + 1).join('\n').trim()));
      } else {
        this.resultSubject.set('');
        this.resultBody.set(this.ensureHtml(cleaned));
      }
    }
    this.generatedType.set(type);
    // Refresh the suggested file name unless the user typed a custom one.
    const current = this.fileName().trim();
    if (!current || DEFAULT_FILENAME_RE.test(current)) {
      this.fileName.set(this.defaultFileName(type));
    }
  }

  /**
   * Fallback for models that ignore the HTML instruction: wrap plain text in <p>/<br>.
   * HTML from the model is rendered in a contenteditable editor: keep only the
   * formatting tags the prompt allows (no links, images, forms or attributes).
   */
  private ensureHtml(body: string): string {
    if (/<[a-z][\s\S]*>/i.test(body)) return sanitizeDialogHtml(body);
    const escaped = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escaped
      .split(/\n{2,}/)
      .filter((p) => p.trim().length > 0)
      .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  /** Plain-text version of the HTML mail body, for text/plain clipboard fallback. */
  getBodyPlainText(): string {
    let s = this.resultBody()
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/(p|div|ul|ol)>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    const decoder = document.createElement('textarea');
    decoder.innerHTML = s;
    s = decoder.value;
    return s.replace(/\n{3,}/g, '\n\n').trim();
  }

  private restoreSettings(): void {
    try {
      const raw =
        localStorage.getItem(SETTINGS_STORAGE_KEY) ??
        localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw) as StoredWriterSettings;
      if (stored.language && VALID_LANGUAGES.includes(stored.language)) {
        this.language.set(stored.language);
      }
      if (stored.provider && VALID_PROVIDERS.includes(stored.provider)) {
        this.provider.set(stored.provider);
      }
      if (stored.tone && Object.keys(TONE_INSTRUCTIONS).includes(stored.tone)) {
        this.tone.set(stored.tone);
      }
      if (stored.models && typeof stored.models === 'object') {
        // Keep only entries that still match a known provider + model.
        const cleaned: Record<string, string> = {};
        for (const [prov, id] of Object.entries(stored.models)) {
          if ((WRITER_MODELS[prov] ?? []).some((m) => m.id === id)) cleaned[prov] = id;
        }
        this.modelsByProvider.set(cleaned);
        this.model.set(cleaned[this.provider()] ?? null);
      }
    } catch {
      // Corrupt entry: ignore and keep defaults.
    }
  }

  private restoreContent(): void {
    try {
      const raw = localStorage.getItem(CONTENT_STORAGE_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw) as StoredWriterContent;
      if (stored.artifactType && VALID_TYPES.includes(stored.artifactType)) {
        this.artifactType.set(stored.artifactType);
      }
      if (typeof stored.draft === 'string') this.draft.set(stored.draft);
      if (typeof stored.recipient === 'string') this.recipient.set(stored.recipient);
      if (typeof stored.resultSubject === 'string') this.resultSubject.set(stored.resultSubject);
      if (typeof stored.resultBody === 'string') {
        // A stored mail body is HTML for the editor: clean it like a fresh one.
        this.resultBody.set(stored.generatedType === 'mail' ? sanitizeDialogHtml(stored.resultBody) : stored.resultBody);
      }
      if (stored.generatedType && VALID_TYPES.includes(stored.generatedType)) {
        this.generatedType.set(stored.generatedType);
      }
      if (typeof stored.fileName === 'string') this.fileName.set(stored.fileName);
    } catch {
      // Corrupt entry: ignore and keep defaults.
    }
  }

  private languageInstruction(): string {
    const lang = this.language();
    if (lang !== 'auto') return LANGUAGE_NAMES[lang];
    return this.draft().trim()
      ? "the same language as the user's notes below"
      : 'English';
  }

  private todayStamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  private async buildGeneratePrompt(type: ArtifactType): Promise<string> {
    const parts: string[] = [];
    parts.push(...this.artifactInstructions(type));
    if (type === 'mail' && this.recipient().trim()) {
      parts.push(`- The email is addressed to: ${this.recipient().trim()}.`);
    }
    const draft = this.draft().trim();
    if (draft) {
      parts.push(
        '',
        type === 'estimate' ? 'Work requested (the scope to estimate):' : 'User notes / key points:',
        draft,
      );
    } else {
      parts.push(
        '',
        'The user provided no notes: base the document entirely on the development context below.',
      );
    }
    const contextBlock = await this.buildContextBlock(type);
    if (contextBlock) {
      parts.push('', contextBlock);
    }
    return parts.join('\n');
  }

  /** Role + rules block for each artifact type. Mail is HTML; the rest is Markdown. */
  private artifactInstructions(type: ArtifactType): string[] {
    const language = `- Write in ${this.languageInstruction()}.`;
    const markdownRules = [
      '- Output ONLY the Markdown document: no explanations, no surrounding code fences.',
      '- Be precise and grounded: only state what the notes and development context support, never invent behavior, APIs or dates.',
    ];
    switch (type) {
      case 'documentation':
        return [
          'You are an expert technical writer.',
          'Write developer documentation in Markdown for the work described below.',
          '',
          'Rules:',
          language,
          '- Start with a single "# <title>" heading, then well-structured "##" sections.',
          '- Explain what it does, how it works and how to use it; include short code or command examples only where they genuinely help.',
          ...markdownRules,
        ];
      case 'changelog':
        return [
          'You are a release-notes writer.',
          'Write a changelog entry in Markdown for the work described below.',
          '',
          'Rules:',
          language,
          `- Start with "# Changelog — ${this.todayStamp()}", then group entries under "## Added", "## Changed", "## Fixed" (only the groups that apply).`,
          '- One concise bullet per user-visible change; merge related commits into a single entry.',
          '- Skip noise such as merge commits, version bumps and CI chores.',
          ...markdownRules,
        ];
      case 'report':
        return [
          'You are writing a concise status report for stakeholders.',
          'Write it in Markdown based on the work described below.',
          '',
          'Rules:',
          language,
          '- Start with a single "# <title>" heading, then a 2-3 sentence summary, then "## Completed", "## In progress" and "## Next steps" sections ("## Risks" only if the material shows real risks).',
          '- Non-technical readers must understand it: explain impact and progress, not implementation details.',
          ...markdownRules,
        ];
      case 'handover':
        return [
          'You are writing a handover document for a developer taking over this work.',
          'Write it in Markdown based on the work described below.',
          '',
          'Rules:',
          language,
          '- Start with a single "# <title>" heading, then sections: "## Current state", "## What changed", "## Open threads", "## Gotchas", "## Where things live".',
          '- Be concrete: reference the actual files, branches and commits from the context; flag anything unfinished or fragile.',
          ...markdownRules,
        ];
      case 'estimate':
        return [
          'You are a senior software consultant preparing a project quote (effort/cost estimate).',
          'You are running INSIDE the codebase the quote is about: before writing anything, explore it (directory structure, key modules, frameworks, tests, build setup) so the estimate reflects the real state of the project.',
          'Then write the quote in Markdown for the requested work described below.',
          '',
          'Rules:',
          language,
          '- Start with a single "# <title>" heading, then sections: "## Scope", "## Codebase assessment", "## Work breakdown", "## Assumptions", "## Risks", "## Summary".',
          '- "## Codebase assessment": 3-5 sentences on architecture, tech stack and overall state, citing the actual folders/files you inspected — this is what justifies the numbers.',
          '- "## Work breakdown": a Markdown table with columns Task | Description | Effort (person-days, as a min–max range). Base each estimate on what you actually found in the code (existing patterns to reuse, complexity, missing pieces).',
          '- "## Summary": total effort range and, ONLY if the notes below state a rate, the price; never invent rates or prices.',
          '- Be honest about uncertainty: wide ranges plus an assumption beat false precision.',
          ...markdownRules,
        ];
      case 'mail':
      default:
        return [
          'You are an expert business-email writer.',
          `Write a ${TONE_INSTRUCTIONS[this.tone()]} email based on the user's notes below.`,
          '',
          'Rules:',
          language,
          '- Keep it clear and well structured; no filler.',
          '- Start with a single line "Subject: <the subject>" (plain text), then a blank line, then the email body.',
          '- Write the body as simple HTML: <p> for paragraphs, <strong> to highlight the truly important points (deadlines, names, numbers, decisions), <em> for light emphasis, <ul>/<ol> with <li> for lists. No other tags, no inline styles, no <html>/<head>/<body> wrapper.',
          '- Never use markdown: no asterisks, no # headers, no backticks.',
          '- Output ONLY the email (subject line + HTML body). No explanations, no code fences.',
        ];
    }
  }

  private buildRefinePrompt(instructions: string, type: ArtifactType): string {
    if (type !== 'mail') {
      return [
        'Below is a Markdown document. Revise it according to the instructions, keeping its language and overall structure unless the instructions say otherwise.',
        'Output ONLY the revised Markdown document: no explanations, no surrounding code fences.',
        '',
        `Instructions: ${instructions}`,
        '',
        'Document:',
        this.resultBody().trim(),
      ].join('\n');
    }
    const currentEmail = this.resultSubject().trim()
      ? `Subject: ${this.resultSubject().trim()}\n\n${this.resultBody().trim()}`
      : this.resultBody().trim();
    return [
      'You are an expert business-email writer.',
      'Below is an email draft. Revise it according to the instructions, keeping its language and overall intent.',
      'Output ONLY the revised email: a single line "Subject: <the subject>" (plain text), a blank line, then the body.',
      'Write the body as simple HTML: <p> for paragraphs, <strong> for the truly important points, <em> for light emphasis, <ul>/<ol> with <li> for lists. No other tags, no inline styles, no markdown, no code fences. No explanations.',
      '',
      `Instructions: ${instructions}`,
      '',
      'Email draft:',
      currentEmail,
    ].join('\n');
  }

  private async buildContextBlock(type: ArtifactType): Promise<string> {
    const linked = this.linked();
    const ctxs = this.contexts();
    if (!linked || ctxs.length === 0) return '';

    const perRepoDiffBudget = Math.max(
      MIN_REPO_DIFF_BUDGET,
      Math.floor(DIFF_CHAR_BUDGET / ctxs.length),
    );
    const lines: string[] = [
      `Development context from the linked ${linked.kind} "${linked.name}":`,
    ];
    for (const ctx of ctxs) {
      lines.push('', `Repository "${ctx.name}" (git branch "${ctx.branch}"):`);
      if (this.includeFiles() && ctx.changedFiles.length > 0) {
        const files = ctx.changedFiles.slice(0, FILE_LIST_LIMIT);
        lines.push(`Changed files (${ctx.changedFiles.length}):`, ...files.map((f) => `- ${f}`));
        if (ctx.changedFiles.length > FILE_LIST_LIMIT) {
          lines.push(`- ... and ${ctx.changedFiles.length - FILE_LIST_LIMIT} more`);
        }
      }
      if (this.includeCommits() && ctx.commits.length > 0) {
        lines.push(
          'Recent commits:',
          ...ctx.commits.map((c) => `- ${c.shortHash} ${c.message} (${c.relativeDate})`),
        );
      }
      if (this.includeDiff()) {
        const diff = await this.collectDiff(ctx.path, perRepoDiffBudget);
        if (diff) {
          lines.push('Code changes (git diff, may be truncated):', diff);
        }
      }
    }
    lines.push(
      '',
      type === 'mail'
        ? 'Use this context to reference the actual development work where it strengthens the email; do not paste raw code or the diff into the email.'
        : type === 'estimate'
          ? 'This git context is only a snapshot of recent activity: base the estimate on your own exploration of the codebase you are running in, not just on this snapshot.'
          : 'Base the document primarily on this development context. Describe the changes; do not paste the raw diff verbatim.',
    );
    return lines.join('\n');
  }

  private async collectDiff(path: string, budget: number): Promise<string> {
    try {
      const res = await this.api.gitDiff(path);
      const raw: string = res?.ok ? res.diff || '' : '';
      if (!raw.trim()) return '';
      return raw.length > budget ? `${raw.slice(0, budget)}\n[... diff truncated ...]` : raw;
    } catch {
      return '';
    }
  }
}
