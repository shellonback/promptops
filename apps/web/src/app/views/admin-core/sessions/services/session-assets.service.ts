import { Injectable, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

export interface AssetInfo {
  name: string;
  relativePath: string;
  size: number;
  mimeType: string;
  isImage: boolean;
  createdAt: string;
  modifiedAt: string;
}

/** Task-oriented AI intents the user can run on selected assets. */
export type AssetIntent = 'implement' | 'fix' | 'explain' | 'extract' | 'compare' | 'custom';

/**
 * Angular service wrapping the desktop bridge API (`window.promptops`) for session assets.
 * Manages file uploads, listing, deletion, and AI prompt generation.
 */
@Injectable({ providedIn: 'root' })
export class SessionAssetsService {
  private readonly translate = inject(TranslateService, { optional: true });

  private get api(): any {
    const api = (window as any).promptops;
    if (!api) throw new Error(this.text('ASSETS.Desktop only', 'available only in the desktop app'));
    return api;
  }

  /** Detail shown inside the panel's translated "… failed: {{error}}" banner. */
  private text(key: string, fallback: string): string {
    const out = this.translate?.instant(key);
    return typeof out === 'string' && out && out !== key ? out : fallback;
  }

  private unknownError(): string {
    return this.text('ASSETS.Unknown error', 'unknown error');
  }

  assets = signal<AssetInfo[]>([]);
  loading = signal(false);
  lastUploadedNames = signal<string[]>([]);

  /** Bumped by each loadAssets(): only the latest answer is shown. */
  private loadSeq = 0;

  async loadAssets(cwd: string): Promise<void> {
    const seq = ++this.loadSeq;
    this.loading.set(true);
    try {
      const result = await this.api.listAssets(cwd);
      // A slower answer for the previous session must not replace this one's list.
      if (seq !== this.loadSeq) return;
      this.assets.set(result.ok ? (result.assets ?? []) : []);
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
    }
  }

  async uploadFiles(cwd: string, files: File[]): Promise<AssetInfo[]> {
    const filePayloads: Array<{ name: string; dataBase64: string }> = [];

    for (const file of files) {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);
      filePayloads.push({ name: file.name, dataBase64: base64 });
    }

    const result = await this.api.uploadAssets(cwd, filePayloads);
    if (result.ok) {
      await this.loadAssets(cwd);
      const names = (result.assets as AssetInfo[]).map(a => a.name);
      this.lastUploadedNames.set(names);
      return result.assets;
    }
    throw new Error(result.error || this.unknownError());
  }

  /**
   * Import local files by absolute path (Linux/WebKitGTK drops that carry only
   * text/uri-list, no File objects). Returns null when the desktop build
   * doesn't expose the IPC.
   */
  async importPaths(cwd: string, paths: string[]): Promise<AssetInfo[] | null> {
    if (typeof this.api.importAssetPaths !== 'function') return null;
    const result = await this.api.importAssetPaths(cwd, paths);
    if (result.ok) {
      await this.loadAssets(cwd);
      const names = (result.assets as AssetInfo[]).map(a => a.name);
      this.lastUploadedNames.set(names);
      return result.assets;
    }
    throw new Error(result.error || 'Upload failed');
  }

  /**
   * Download a remote file (e.g. a presigned S3 attachment URL) into the
   * assets folder via the main process — a renderer fetch() would be blocked
   * by CORS. Returns null when the desktop build doesn't expose the IPC yet.
   */
  async importFromUrl(cwd: string, url: string, fileName: string): Promise<AssetInfo | null> {
    if (typeof this.api.importAssetFromUrl !== 'function') return null;
    const result = await this.api.importAssetFromUrl(cwd, url, fileName);
    if (result?.ok) return result.asset as AssetInfo;
    throw new Error(result?.error || this.unknownError());
  }

  async deleteAsset(cwd: string, fileName: string): Promise<void> {
    const result = await this.api.deleteAsset(cwd, fileName);
    if (!result.ok) throw new Error(result.error || this.unknownError());
    this.assets.update(list => list.filter(a => a.name !== fileName));
  }

  async renameAsset(cwd: string, oldName: string, newName: string): Promise<AssetInfo> {
    const result = await this.api.renameAsset(cwd, oldName, newName);
    if (result.ok) {
      await this.loadAssets(cwd);
      return result.asset;
    }
    throw new Error(result.error || this.unknownError());
  }

  async readAssetBase64(cwd: string, fileName: string): Promise<{ data: string; mimeType: string }> {
    const result = await this.api.readAssetBase64(cwd, fileName);
    if (result.ok) {
      return { data: result.data, mimeType: result.mimeType };
    }
    throw new Error(result.error || this.unknownError());
  }

  async openFolder(cwd: string): Promise<void> {
    await this.api.openAssetsFolder(cwd);
  }

  /**
   * Remote session (cwd `cmd://` / `ssh://`): download a host file (absolute
   * or session-relative) into Downloads/PromptOps and open it locally.
   */
  async fetchRemoteFile(cwd: string, path: string, open = true): Promise<string> {
    const result = await this.api.fetchRemoteFile(cwd, path, open);
    if (result?.ok && result.localPath) return result.localPath;
    throw new Error(result?.error || this.unknownError());
  }

  /**
   * Copy text to the clipboard, preferring the desktop bridge and
   * falling back to the Web Clipboard API (e.g. in the browser preview).
   * Returns false when both paths failed, so the caller can tell the user —
   * previously the bridge result was ignored and an `{ ok: false }` passed as
   * success, never reaching the fallback.
   */
  async copyToClipboard(text: string): Promise<boolean> {
    const api = (window as any).promptops;
    try {
      if (api?.clipboardWrite) {
        // `{ ok }` or `{ ok, error }` (old binaries: undefined,
        // resolved promise = success).
        const res = await api.clipboardWrite(text);
        if (!res || typeof res !== 'object' || res.ok !== false) return true;
      }
    } catch {
      /* fall through to the web clipboard */
    }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* clipboard unavailable — nothing else we can do */
      return false;
    }
  }

  async readAssetText(cwd: string, fileName: string): Promise<string> {
    const result = await this.api.readAsset(cwd, fileName);
    if (result.ok) {
      return result.content;
    }
    throw new Error(result.error || this.unknownError());
  }

  /**
   * Build a strong, asset-aware AI prompt for a given task intent.
   * The result is a starting point the user can edit and/or enhance.
   */
  buildIntentPrompt(assets: AssetInfo[], intent: AssetIntent): string {
    const fileList = assets
      .map(a => `- ${a.relativePath} (${a.isImage ? 'image' : a.mimeType}, ${this.formatSize(a.size)})`)
      .join('\n');

    if (intent === 'custom') {
      const paths = assets.map(a => `- ${a.relativePath}`).join('\n');
      return `Files (in the project's .promptops-assets/ directory):\n${paths}\n\n`;
    }

    const instructions: Record<Exclude<AssetIntent, 'custom'>, string> = {
      implement: `Build the UI/feature shown in the attached file(s) using this project's existing stack, components and conventions.
- Match the layout, spacing and styles as closely as possible.
- Reuse existing components where they exist; create new ones consistently.
- When done, summarize the files you created or changed.`,
      fix: `Reproduce and fix the problem shown in the attached file(s) (error screenshot, log or stack trace).
- Identify the root cause and explain briefly why it happens.
- Apply the fix directly in the codebase.
- Tell me how to verify the fix.`,
      explain: `Explain the attached file(s) (diagram, screenshot or document).
- Describe what each represents and how the parts relate.
- Map it to the relevant parts of this codebase.
- Be concise and concrete.`,
      extract: `Extract the content from the attached file(s).
- Transcribe all visible text verbatim.
- Pull out any structured data (tables, key/values, color hex codes, measurements).
- Return the result as clean Markdown.`,
      compare: `Compare the attached file(s) and report the meaningful differences.
- Cover visual, structural and content changes.
- Summarize what changed and the likely impact.`,
    };

    return `Act as a senior developer working in this project.

${instructions[intent]}

Files:
${fileList}

Read the file(s) now and proceed.`;
  }

  /**
   * Order the available intents for the selected assets. `custom` (free-form)
   * comes first and is the default tab; the task intents follow, sorted by
   * relevance to the assets. `compare` only appears for 2+ assets.
   */
  orderIntents(assets: AssetInfo[]): AssetIntent[] {
    const names = assets.map(a => a.name.toLowerCase()).join(' ');
    const anyImage = assets.some(a => a.isImage);
    const looksError =
      /(error|err|bug|exception|fail|crash|stack|trace|\.log)/.test(names) ||
      assets.some(a => a.mimeType.startsWith('text/'));
    const looksDesign = /(mock|design|figma|ui|screen|wireframe|layout|page|component|button)/.test(names);

    const score: Record<AssetIntent, number> = {
      implement: 0, fix: 0, explain: 0, extract: 0, compare: 0, custom: -100,
    };
    if (looksError) score.fix += 4;
    if (looksDesign && anyImage) score.implement += 3;
    if (anyImage && !looksError) score.implement += 1;
    if (anyImage) { score.extract += 1; score.explain += 1; }
    if (!anyImage) score.explain += 1;

    const list: AssetIntent[] = ['implement', 'fix', 'explain', 'extract'];
    if (assets.length >= 2) list.push('compare');
    list.sort((a, b) => score[b] - score[a]);
    return ['custom', ...list];
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
