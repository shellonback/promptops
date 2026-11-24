import {
  CUSTOM_ELEMENTS_SCHEMA,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { TooltipDirective } from '../../../../common/tooltip.directive';
import {
  BriefMemoryEntry,
  ProjectBriefData,
  ProjectBriefService,
  ProviderFileEntry,
} from '../../../../core/services/project-brief.service';
import { SwalService } from '../../../../core/services/swal.service';

type MemoryCategory = 'project' | 'feedback' | 'reference' | 'other';
type MemoryFilter = 'all' | MemoryCategory;
type BriefSection =
  | { kind: 'overview' }
  | { kind: 'doc'; root: string; rel: string; label: string; icon: string }
  | { kind: 'new' }
  | { kind: 'files'; provider: ProviderFilter }
  | { kind: 'memories'; cat: MemoryFilter }
  | { kind: 'activity' };

/** Memory files are named <type>_<slug>.md: the category comes from there. */
function memoryCategoryOf(entry: BriefMemoryEntry): MemoryCategory {
  const source = (entry.file ?? entry.title).toLowerCase();
  if (source.startsWith('project')) return 'project';
  if (source.startsWith('feedback')) return 'feedback';
  if (source.startsWith('reference')) return 'reference';
  return 'other';
}

type ProviderFilter = 'all' | ProviderFileEntry['provider'];
type ScopeFilter = 'all' | ProviderFileEntry['scope'];

const PROVIDER_META: Record<ProviderFileEntry['provider'], { label: string; icon: string }> = {
  claude: { label: 'Claude Code', icon: 'simple-icons:claude' },
  codex: { label: 'Codex', icon: 'simple-icons:openai' },
  gemini: { label: 'Gemini', icon: 'simple-icons:googlegemini' },
  other: { label: 'Cursor · Copilot · Antigravity', icon: 'codicon:extensions' },
};
const KIND_ICON: Record<ProviderFileEntry['kind'], string> = {
  instructions: 'codicon:markdown', settings: 'codicon:settings-gear', mcp: 'codicon:plug',
  command: 'codicon:terminal', agent: 'codicon:hubot', skill: 'codicon:tools', rule: 'codicon:law',
};

type NoteType = 'project' | 'feedback' | 'reference' | 'user';

/** Slug for the note file name: lowercase, dashes, at most 48 characters. */
function slugify(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'note';
}

/** AI summaries cached per workspace (same key as the old modal: no regeneration lost). */
const BRIEF_CACHE_KEY = 'promptops_project_brief_cache';
const BRIEF_CACHE_MAX = 20;
interface CachedAiBrief { text: string; generatedAt: number; }
function readBriefCache(): Record<string, CachedAiBrief> {
  try {
    const parsed = JSON.parse(localStorage.getItem(BRIEF_CACHE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * "Brief" tab next to Editor: agent memories, context files and project activity in a panel that
 * looks like Ports (tree on the left, content on the right). Everything is local: nothing leaves
 * this computer. The actions (refresh, generate, copy) live in the session tab bar.
 */
@Component({
  selector: 'app-project-brief-panel',
  standalone: true,
  imports: [CommonModule, TranslateModule, TooltipDirective],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <div class="pb-root">
      @if (!workspacePath()) {
        <div class="pb-state"><iconify-icon icon="codicon:folder" width="16"></iconify-icon>{{ 'BRIEF.No workspace' | translate }}</div>
      } @else if (loading() && !data()) {
        <div class="pb-state"><iconify-icon class="pb-spin" icon="codicon:loading" width="16"></iconify-icon>{{ 'BRIEF.Reading memories' | translate }}</div>
      } @else if (error()) {
        <div class="pb-state err"><iconify-icon icon="codicon:warning" width="16"></iconify-icon>{{ 'BRIEF.Error' | translate }}</div>
      } @else if (data()) {
        @let d = data()!;
        <!-- Section tree -->
        <nav class="pb-tree" role="tree">
          <button class="pb-node" role="treeitem" [class.active]="section().kind === 'overview'" (click)="section.set({ kind: 'overview' })">
            <iconify-icon icon="codicon:book" width="14"></iconify-icon>
            <span class="pb-node-label">{{ 'BRIEF.Overview' | translate }}</span>
          </button>

          @if (providerFiles().length) {
            <div class="pb-group">{{ 'BRIEF.AI files' | translate }}<span class="pb-badge">{{ existingFiles().length }}</span></div>
            <button class="pb-node child" role="treeitem" [class.active]="isFiles('all')" (click)="section.set({ kind: 'files', provider: 'all' })">
              <iconify-icon icon="codicon:files" width="14"></iconify-icon>
              <span class="pb-node-label">{{ 'BRIEF.All files' | translate }}</span>
            </button>
            @for (p of providerGroups(); track p.key) {
              <button class="pb-node child" role="treeitem" [class.active]="isFiles(p.key)" (click)="section.set({ kind: 'files', provider: p.key })">
                <iconify-icon [icon]="providerMeta[p.key].icon" width="14"></iconify-icon>
                <span class="pb-node-label">{{ providerMeta[p.key].label }}</span>
                <span class="pb-badge">{{ p.count }}</span>
              </button>
            }
          }

          <div class="pb-group">
            {{ 'BRIEF.Agent memories' | translate }}<span class="pb-badge">{{ d.agentMemories.entries.length }}</span>
            @if (d.agentMemories.dir) {
              <button class="pb-act sm" (click)="startNewNote()" [appTooltip]="'BRIEF.New note' | translate">
                <iconify-icon icon="codicon:add" width="13"></iconify-icon>
              </button>
            }
          </div>
          @if (d.agentMemories.dir) {
            <button class="pb-node child" role="treeitem" [class.active]="section().kind === 'new'" (click)="startNewNote()">
              <iconify-icon icon="codicon:new-file" width="14"></iconify-icon>
              <span class="pb-node-label">{{ 'BRIEF.New note' | translate }}</span>
            </button>
            <button class="pb-node child" role="treeitem" [class.active]="isDoc(d.agentMemories.dir, 'MEMORY.md')"
                    (click)="openDoc(d.agentMemories.dir, 'MEMORY.md', 'MEMORY.md', 'codicon:list-tree')">
              <iconify-icon icon="codicon:list-tree" width="14"></iconify-icon>
              <span class="pb-node-label">MEMORY.md</span>
            </button>
          }
          @if (d.agentMemories.entries.length) {
            @for (c of categories(); track c.key) {
              <button class="pb-node child" role="treeitem" [class.active]="isCat(c.key)" (click)="section.set({ kind: 'memories', cat: c.key })">
                <iconify-icon [icon]="catIcon[c.key]" width="14"></iconify-icon>
                <span class="pb-node-label">{{ catLabels[c.key] | translate }}</span>
                <span class="pb-badge">{{ c.count }}</span>
              </button>
            }
          }

          @if (stateSessions().length) {
            <div class="pb-group">{{ 'SETTINGS.Context Management' | translate }}<span class="pb-badge">{{ stateSessions().length }}</span></div>
            @for (st of stateSessions(); track st.id) {
              @for (f of st.files; track f) {
                <button class="pb-node child" role="treeitem" [class.active]="isDoc(d.workspacePath, st.dir + '/' + f)"
                        (click)="openDoc(d.workspacePath, st.dir + '/' + f, '#' + st.id + ' · ' + f, f === 'state.md' ? 'codicon:notebook' : 'codicon:book')">
                  <iconify-icon [icon]="f === 'state.md' ? 'codicon:notebook' : 'codicon:book'" width="14"></iconify-icon>
                  <span class="pb-node-label">#{{ st.id }} · {{ f }}</span>
                </button>
              }
            }
          }

          @if (d.recentActivity.length) {
            <button class="pb-node" role="treeitem" [class.active]="section().kind === 'activity'" (click)="section.set({ kind: 'activity' })">
              <iconify-icon icon="codicon:history" width="14"></iconify-icon>
              <span class="pb-node-label">{{ 'BRIEF.Recent activity' | translate }}</span>
              <span class="pb-badge">{{ d.recentActivity.length }}</span>
            </button>
          }
        </nav>

        <!-- Content -->
        <section class="pb-main">
          @switch (section().kind) {
            @case ('overview') {
              <div class="pb-scroll pb-overview">
                <div class="pb-head">
                  <span class="pb-title">{{ d.projectName }}</span>
                  <span class="pb-path" [attr.title]="d.workspacePath">{{ tildify(d.workspacePath) }}</span>
                </div>
                @if (d.frameworks.length || d.languages.length) {
                  <div class="pb-tags">
                    @for (fw of d.frameworks; track fw) { <span class="pb-tag">{{ fw }}</span> }
                    @for (l of d.languages; track l) { <span class="pb-tag muted">{{ l }}</span> }
                  </div>
                }

                <div class="pb-stats">
                  <button class="pb-stat" [disabled]="!providerFiles().length" (click)="section.set({ kind: 'files', provider: 'all' })">
                    <span class="n">{{ existingFiles().length }}</span><span>{{ 'BRIEF.AI files' | translate }}</span>
                  </button>
                  <button class="pb-stat" [disabled]="!d.agentMemories.entries.length" (click)="section.set({ kind: 'memories', cat: 'all' })">
                    <span class="n">{{ d.agentMemories.entries.length }}</span><span>{{ 'BRIEF.Agent memories' | translate }}</span>
                  </button>
                  <button class="pb-stat" [disabled]="!d.recentActivity.length" (click)="section.set({ kind: 'activity' })">
                    <span class="n">{{ d.recentActivity.length }}</span><span>{{ 'BRIEF.Recent activity' | translate }}</span>
                  </button>
                </div>

                <div class="pb-card">
                  <div class="pb-card-head">
                    <iconify-icon icon="codicon:sparkle" width="14"></iconify-icon>
                    <span>{{ 'BRIEF.AI summary' | translate }}</span>
                    @if (aiGeneratedAt(); as ts) {
                      <span class="pb-muted">· {{ 'BRIEF.Generated at' | translate: { date: formatDate(ts) } }}</span>
                    }
                    <span class="pb-spacer"></span>
                    @if (canGenerateAi()) {
                      <button class="pb-btn" [class.primary]="!aiText()" (click)="generateAi()" [disabled]="aiLoading()">
                        <iconify-icon [icon]="aiLoading() ? 'codicon:loading' : 'codicon:sparkle'" [class.pb-spin]="aiLoading()" width="13"></iconify-icon>
                        {{ (aiLoading() ? 'BRIEF.Generating' : aiText() ? 'BRIEF.Regenerate' : 'BRIEF.Generate') | translate }}
                      </button>
                    }
                  </div>
                  @if (aiError(); as e) { <div class="pb-error">{{ e }}</div> }
                  @if (aiText(); as t) {
                    <div class="pb-ai-text">{{ t }}</div>
                  } @else if (!aiLoading()) {
                    <div class="pb-hint">{{ 'BRIEF.AI hint' | translate }}</div>
                  }
                </div>

                @if (isEmpty()) {
                  <div class="pb-hint">{{ 'BRIEF.Empty' | translate }}</div>
                }
              </div>
            }

            @case ('doc') {
              @if (docSection(); as doc) {
                <div class="pb-bar">
                  <iconify-icon [icon]="doc.icon" width="14"></iconify-icon>
                  <span class="pb-bar-title">{{ doc.label }}</span>
                  @if (docDirty()) { <span class="pb-dirty" [appTooltip]="'BRIEF.Unsaved' | translate">●</span> }
                  <span class="pb-path sm" [attr.title]="doc.root + '/' + doc.rel">{{ tildify(doc.root + '/' + doc.rel) }}</span>
                  <span class="pb-spacer"></span>
                  <button class="pb-act" (click)="copyText(docText())" [appTooltip]="'BRIEF.Copy' | translate">
                    <iconify-icon icon="codicon:copy" width="14"></iconify-icon>
                  </button>
                  <button class="pb-act" (click)="revertDoc()" [disabled]="!docDirty()" [appTooltip]="'BRIEF.Revert' | translate">
                    <iconify-icon icon="codicon:discard" width="14"></iconify-icon>
                  </button>
                  <button class="pb-btn primary" (click)="saveDoc()" [disabled]="!docDirty() || docSaving()">
                    <iconify-icon [icon]="docSaving() ? 'codicon:loading' : 'codicon:save'" [class.pb-spin]="docSaving()" width="13"></iconify-icon>
                    {{ 'BRIEF.Save' | translate }}
                  </button>
                </div>
                @if (docLoading()) {
                  <div class="pb-state"><iconify-icon class="pb-spin" icon="codicon:loading" width="16"></iconify-icon></div>
                } @else {
                  @if (docMissing()) { <div class="pb-hint">{{ 'BRIEF.File will be created' | translate }}</div> }
                  <textarea class="pb-editor" spellcheck="false" [value]="docText()"
                            (input)="docText.set($any($event.target).value)"
                            (keydown)="onEditorKey($event)"></textarea>
                }
              }
            }

            @case ('new') {
              <div class="pb-bar">
                <iconify-icon icon="codicon:new-file" width="14"></iconify-icon>
                <span class="pb-bar-title">{{ 'BRIEF.New note' | translate }}</span>
                <span class="pb-muted">{{ 'BRIEF.New note hint' | translate }}</span>
              </div>
              <div class="pb-scroll pb-form">
                <div class="pb-types" role="radiogroup">
                  @for (t of noteTypes; track t.id) {
                    <button class="pb-type-btn" role="radio" [class.active]="noteType() === t.id" [attr.aria-checked]="noteType() === t.id"
                            (click)="noteType.set(t.id)">
                      <iconify-icon [icon]="t.icon" width="14"></iconify-icon>{{ t.label | translate }}
                    </button>
                  }
                </div>
                <label class="pb-field">
                  <span>{{ 'BRIEF.Col title' | translate }}</span>
                  <input type="text" [value]="noteTitle()" (input)="noteTitle.set($any($event.target).value)"
                         [placeholder]="'BRIEF.Note title placeholder' | translate" />
                </label>
                <label class="pb-field">
                  <span>{{ 'BRIEF.Col description' | translate }}</span>
                  <input type="text" [value]="noteHook()" (input)="noteHook.set($any($event.target).value)"
                         [placeholder]="'BRIEF.Note hook placeholder' | translate" />
                </label>
                <label class="pb-field grow">
                  <span>{{ 'BRIEF.Note body' | translate }}</span>
                  <textarea class="pb-editor boxed" [value]="noteBody()" (input)="noteBody.set($any($event.target).value)"
                            (keydown)="onNoteKey($event)" [placeholder]="'BRIEF.Note body placeholder' | translate"></textarea>
                </label>
                @if (noteError(); as e) { <div class="pb-error">{{ e }}</div> }
                <div class="pb-form-actions">
                  @if (canGenerateAi()) {
                    <button class="pb-btn" (click)="enhanceNote()" [disabled]="noteEnhancing() || !noteBody().trim()">
                      <iconify-icon [icon]="noteEnhancing() ? 'codicon:loading' : 'codicon:sparkle'" [class.pb-spin]="noteEnhancing()" width="13"></iconify-icon>
                      {{ (noteEnhancing() ? 'BRIEF.Enhancing' : 'BRIEF.Enhance with AI') | translate }}
                    </button>
                    @if (noteBeforeEnhance() !== null) {
                      <button class="pb-btn" (click)="undoEnhance()">
                        <iconify-icon icon="codicon:discard" width="13"></iconify-icon>{{ 'BRIEF.Undo' | translate }}
                      </button>
                    }
                  }
                  <span class="pb-spacer"></span>
                  <button class="pb-btn primary" (click)="saveNote()" [disabled]="noteSaving() || !noteTitle().trim() || !noteBody().trim()">
                    <iconify-icon [icon]="noteSaving() ? 'codicon:loading' : 'codicon:save'" [class.pb-spin]="noteSaving()" width="13"></iconify-icon>
                    {{ 'BRIEF.Save note' | translate }}
                  </button>
                </div>
              </div>
            }

            @case ('files') {
              <div class="pb-bar">
                <div class="pb-filter">
                  <iconify-icon icon="codicon:filter" width="13"></iconify-icon>
                  <input type="text" [placeholder]="'BRIEF.Filter files' | translate"
                         [value]="fileQuery()" (input)="fileQuery.set($any($event.target).value)"
                         (keydown.escape)="fileQuery.set('')" />
                </div>
                <div class="pb-seg" role="radiogroup">
                  @for (sc of scopes; track sc.id) {
                    <button role="radio" [class.active]="fileScope() === sc.id" [attr.aria-checked]="fileScope() === sc.id" (click)="fileScope.set(sc.id)">{{ sc.label | translate }}</button>
                  }
                </div>
                <label class="pb-check"><input type="checkbox" [checked]="showMissing()" (change)="showMissing.set(!showMissing())" />{{ 'BRIEF.Show missing' | translate }}</label>
                <span class="pb-spacer"></span>
                <span class="pb-muted" [appTooltip]="'BRIEF.Tokens hint' | translate">≈ {{ formatTokens(filteredFilesTokens()) }} tok</span>
              </div>
              <div class="pb-scroll">
                <table class="pb-table">
                  <thead>
                    <tr>
                      <th class="c-file">{{ 'BRIEF.Col file' | translate }}</th>
                      <th class="c-desc">{{ 'BRIEF.Col description' | translate }}</th>
                      <th class="c-kind">{{ 'BRIEF.Col type' | translate }}</th>
                      <th class="c-scope">{{ 'BRIEF.Col scope' | translate }}</th>
                      <th class="c-size">{{ 'BRIEF.Col size' | translate }}</th>
                      <th class="c-date">{{ 'BRIEF.Col modified' | translate }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (f of filteredFiles(); track f.root + '/' + f.rel) {
                      <tr class="openable" [class.missing]="!f.exists" tabindex="0"
                          (click)="openProviderFile(f)" (keydown.enter)="openProviderFile(f)">
                        <td class="c-file" [attr.title]="f.root + '/' + f.rel">
                          <iconify-icon class="pb-ico" [icon]="providerMeta[f.provider].icon" width="13"></iconify-icon>
                          <span>{{ f.kind === 'skill' ? f.name : f.rel }}</span>
                        </td>
                        <td class="c-desc" [attr.title]="f.description || ''">
                          @if (!f.exists) {
                            <span class="pb-muted">{{ 'BRIEF.Not created' | translate }}</span>
                          } @else {
                            {{ f.description }}
                            @if (f.readBy.length > 1) { <span class="pb-muted">{{ f.description ? '· ' : '' }}{{ 'BRIEF.Read by' | translate }} {{ f.readBy.join(', ') }}</span> }
                          }
                        </td>
                        <td class="c-kind"><span class="pb-type"><iconify-icon [icon]="kindIcon[f.kind]" width="12"></iconify-icon>{{ kindLabels[f.kind] | translate }}</span></td>
                        <td class="c-scope"><span class="pb-type" [attr.data-scope]="f.scope">{{ (f.scope === 'global' ? 'BRIEF.Scope global' : 'BRIEF.Scope project') | translate }}</span></td>
                        <td class="c-size pb-muted" [attr.title]="'≈ ' + formatTokens(f.size / 4) + ' tok'">{{ f.exists ? formatSize(f.size) : '—' }}</td>
                        <td class="c-date pb-muted" [attr.title]="f.modifiedMs ? formatDate(f.modifiedMs) : ''">{{ f.modifiedMs ? formatDay(f.modifiedMs) : '' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
                @if (!filteredFiles().length) { <div class="pb-hint pad">{{ 'BRIEF.No files match' | translate }}</div> }
              </div>
            }

            @case ('memories') {
              <div class="pb-bar">
                <div class="pb-filter">
                  <iconify-icon icon="codicon:filter" width="13"></iconify-icon>
                  <input type="text" [placeholder]="'BRIEF.Filter memories' | translate"
                         [value]="query()" (input)="query.set($any($event.target).value)"
                         (keydown.escape)="query.set('')" />
                </div>
                <span class="pb-muted">{{ filteredMemories().length }} / {{ d.agentMemories.entries.length }}</span>
              </div>
              <div class="pb-scroll">
                <table class="pb-table">
                  <thead>
                    <tr>
                      <th class="c-title">{{ 'BRIEF.Col title' | translate }}</th>
                      <th class="c-desc">{{ 'BRIEF.Col description' | translate }}</th>
                      <th class="c-type">{{ 'BRIEF.Col type' | translate }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (m of filteredMemories(); track $index) {
                      <tr [class.selected]="selected() === m" [class.openable]="!!m.file && !!d.agentMemories.dir" (click)="selected.set(m)"
                          (dblclick)="openMemory(d, m)" (keydown.enter)="openMemory(d, m)" tabindex="0">
                        <td class="c-title" [attr.title]="m.title">{{ m.title }}</td>
                        <td class="c-desc" [attr.title]="m.hook">{{ m.hook }}</td>
                        <td class="c-type">
                          <span class="pb-type" [attr.data-cat]="catOf(m)">{{ catLabels[catOf(m)] | translate }}</span>
                          @if (m.file && d.agentMemories.dir) {
                            <button class="pb-act row-act" (click)="$event.stopPropagation(); openMemory(d, m)" [appTooltip]="'BRIEF.Open' | translate">
                              <iconify-icon icon="codicon:go-to-file" width="13"></iconify-icon>
                            </button>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
                @if (!filteredMemories().length) {
                  <div class="pb-hint pad">{{ 'BRIEF.No matches' | translate }}</div>
                }
              </div>
            }

            @case ('activity') {
              <div class="pb-scroll">
                <table class="pb-table">
                  <thead>
                    <tr>
                      <th class="c-type">{{ 'BRIEF.Col type' | translate }}</th>
                      <th class="c-desc">{{ 'BRIEF.Col description' | translate }}</th>
                      <th class="c-when">{{ 'BRIEF.Col when' | translate }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (a of d.recentActivity; track a.timestamp) {
                      <tr>
                        <td class="c-type"><span class="pb-type">{{ a.category }}</span></td>
                        <td class="c-desc" [attr.title]="a.content">{{ a.content }}</td>
                        <td class="c-when pb-muted">{{ formatDate(a.timestamp) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          }
        </section>
      }
    </div>
  `,
  styles: `
    :host { display: flex; flex: 1; min-height: 0; background: var(--po-bg-0, #0d1117); }
    .pb-root { display: flex; flex: 1; min-width: 0; min-height: 0; font-size: 0.75rem; color: var(--po-text-primary, #e6edf3); }
    .pb-state { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--po-text-secondary, #9da5b4); }
    .pb-state.err { color: var(--po-error, #f85149); }
    .pb-spin { animation: pb-spin 1s linear infinite; }
    @keyframes pb-spin { to { transform: rotate(360deg); } }

    /* tree */
    .pb-tree {
      flex: 0 0 220px; min-width: 0; overflow-y: auto; padding: 6px 0;
      background: var(--po-bg-1, #161b22);
      border-right: 1px solid var(--po-border-subtle, rgba(128,128,128,.25));
    }
    .pb-group {
      display: flex; align-items: center; gap: 6px; margin-top: 8px; padding: 4px 12px;
      font-size: 0.68rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
      color: var(--po-text-secondary, #9da5b4);
    }
    .pb-group .pb-badge { margin-left: auto; }
    .pb-node {
      display: flex; align-items: center; gap: 6px; width: 100%; height: 24px; padding: 0 12px;
      font: inherit; text-align: left; border: none; background: transparent; cursor: pointer;
      color: var(--po-text-primary, #e6edf3);
    }
    .pb-node.child { padding-left: 22px; }
    .pb-node > iconify-icon { flex-shrink: 0; color: var(--po-text-secondary, #9da5b4); }
    .pb-node:hover { background: color-mix(in srgb, var(--po-text-primary, #e6edf3) 6%, transparent); }
    .pb-node.active { background: color-mix(in srgb, var(--po-info, #3b82f6) 22%, transparent); }
    .pb-node.active > iconify-icon { color: var(--po-text-primary, #e6edf3); }
    .pb-node-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pb-badge {
      min-width: 18px; padding: 0 5px; border-radius: 9px; text-align: center; font-size: 0.66rem; line-height: 16px;
      font-variant-numeric: tabular-nums; color: var(--po-text-secondary, #9da5b4);
      background: color-mix(in srgb, var(--po-text-primary, #e6edf3) 10%, transparent);
    }

    /* content */
    .pb-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
    .pb-scroll { flex: 1; min-height: 0; overflow: auto; }
    .pb-bar {
      display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; flex-shrink: 0;
      border-bottom: 1px solid var(--po-border-subtle, rgba(128,128,128,.25));
    }
    .pb-bar > iconify-icon { color: var(--po-text-secondary, #9da5b4); }
    .pb-bar-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; max-width: 45%; }
    .pb-spacer { flex: 1; }
    .pb-muted { color: var(--po-text-secondary, #9da5b4); }
    .pb-act {
      display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0;
      border: none; border-radius: 4px; background: transparent; color: var(--po-text-secondary, #9da5b4); cursor: pointer;
    }
    .pb-act:hover { background: color-mix(in srgb, var(--po-text-primary, #e6edf3) 12%, transparent); color: var(--po-text-primary, #e6edf3); }

    .pb-filter {
      flex: 1; max-width: 420px; display: flex; align-items: center; gap: 6px; height: 22px; padding: 0 6px;
      background: var(--po-bg-1, #161b22); border: 1px solid var(--po-border-subtle, rgba(128,128,128,.25)); border-radius: 3px;
      color: var(--po-text-secondary, #9da5b4);
    }
    .pb-filter:focus-within { border-color: var(--po-info, #3794ff); }
    .pb-filter input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font: inherit; color: var(--po-text-primary, #e6edf3); }

    /* overview */
    .pb-overview { padding: 16px 20px; display: flex; flex-direction: column; gap: 14px; max-width: 920px; }
    .pb-head { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .pb-title { font-size: 1rem; font-weight: 600; }
    .pb-path { font-family: var(--po-font-mono, ui-monospace, Menlo, monospace); font-size: 0.7rem; color: var(--po-text-secondary, #9da5b4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pb-tags { display: flex; flex-wrap: wrap; gap: 4px; }
    .pb-tag {
      padding: 1px 8px; border-radius: 3px; font-size: 0.7rem;
      color: var(--po-text-primary, #e6edf3); background: color-mix(in srgb, var(--po-info, #3b82f6) 16%, transparent);
    }
    .pb-tag.muted { background: color-mix(in srgb, var(--po-text-primary, #e6edf3) 8%, transparent); }
    .pb-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .pb-stat {
      display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px 10px; min-width: 0;
      font: inherit; text-align: left; cursor: pointer; border-radius: 4px;
      color: var(--po-text-secondary, #9da5b4); background: var(--po-bg-1, #161b22);
      border: 1px solid var(--po-border-subtle, rgba(128,128,128,.25));
    }
    .pb-stat:hover:not(:disabled) { border-color: var(--po-info, #3794ff); }
    .pb-stat:disabled { cursor: default; opacity: .6; }
    .pb-stat .n { font-size: 1.05rem; font-weight: 600; color: var(--po-text-primary, #e6edf3); font-variant-numeric: tabular-nums; }
    .pb-card { border: 1px solid var(--po-border-subtle, rgba(128,128,128,.25)); border-radius: 4px; background: var(--po-bg-1, #161b22); }
    .pb-card-head { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border-bottom: 1px solid var(--po-border-subtle, rgba(128,128,128,.25)); }
    .pb-card-head > iconify-icon { color: var(--po-warning, #d29922); }
    .pb-ai-text { padding: 10px 12px; white-space: pre-wrap; line-height: 1.55; font-size: 0.78rem; }
    .pb-hint { padding: 10px 12px; color: var(--po-text-secondary, #9da5b4); }
    .pb-hint.pad { padding: 14px 10px; }
    .pb-error { margin: 8px 10px 0; padding: 4px 8px; color: var(--po-text-primary, #e6edf3); background: var(--po-error-bg, rgba(248,81,73,.15)); border: 1px solid var(--po-error, #f85149); }
    .pb-btn {
      display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 10px; font: inherit; border: none; border-radius: 2px; cursor: pointer;
      color: var(--po-text-primary, #e6edf3); background: color-mix(in srgb, var(--po-text-primary, #e6edf3) 12%, transparent);
    }
    .pb-btn.primary { background: var(--po-info, #0e639c); color: #fff; }
    .pb-btn:hover:not(:disabled) { filter: brightness(1.1); }
    .pb-btn:disabled { opacity: .6; cursor: default; }

    /* file editor */
    .pb-editor {
      flex: 1; min-height: 0; width: 100%; margin: 0; padding: 12px 16px; resize: none; border: none; outline: none;
      font-family: var(--po-font-mono, ui-monospace, Menlo, monospace); font-size: 0.76rem; line-height: 1.6; tab-size: 2;
      color: var(--po-text-primary, #e6edf3); background: var(--po-bg-0, #0d1117);
    }
    .pb-editor.boxed {
      min-height: 160px; padding: 8px 10px; border-radius: 3px;
      border: 1px solid var(--po-border-subtle, rgba(128,128,128,.25)); background: var(--po-bg-1, #161b22);
    }
    .pb-editor.boxed:focus { border-color: var(--po-info, #3794ff); }
    .pb-dirty { color: var(--po-warning, #d29922); font-size: 0.7rem; }
    .pb-path.sm { min-width: 0; flex: 0 1 auto; }
    .pb-act.sm { width: 18px; height: 18px; margin-left: 2px; }
    .pb-act:disabled { opacity: .4; cursor: default; }

    /* new note */
    .pb-form { padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; max-width: 920px; }
    .pb-types { display: flex; flex-wrap: wrap; gap: 4px; }
    .pb-type-btn {
      display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 10px; font: inherit; cursor: pointer; border-radius: 3px;
      color: var(--po-text-secondary, #9da5b4); background: transparent; border: 1px solid var(--po-border-subtle, rgba(128,128,128,.25));
    }
    .pb-type-btn.active { color: var(--po-text-primary, #e6edf3); border-color: var(--po-info, #3794ff); background: color-mix(in srgb, var(--po-info, #3b82f6) 16%, transparent); }
    .pb-field { display: flex; flex-direction: column; gap: 4px; margin: 0; color: var(--po-text-secondary, #9da5b4); }
    .pb-field.grow { flex: 1; }
    .pb-field input {
      height: 26px; padding: 0 8px; font: inherit; outline: none; border-radius: 3px;
      color: var(--po-text-primary, #e6edf3); background: var(--po-bg-1, #161b22); border: 1px solid var(--po-border-subtle, rgba(128,128,128,.25));
    }
    .pb-field input:focus { border-color: var(--po-info, #3794ff); }
    .pb-form-actions { display: flex; align-items: center; gap: 6px; }

    tbody tr.openable { cursor: pointer; }
    tbody tr.missing td { opacity: .6; }
    .c-file { width: 26%; } .c-date { width: 84px; }
    .c-kind { width: 120px; } .c-scope { width: 90px; } .c-size { width: 80px; text-align: right; }
    th.c-size { text-align: right; }
    .pb-ico { vertical-align: -2px; margin-right: 6px; color: var(--po-text-secondary, #9da5b4); }
    .pb-type iconify-icon { vertical-align: -2px; margin-right: 4px; }
    .pb-type[data-scope="global"] { color: var(--po-warning, #d29922); }
    .pb-seg { display: inline-flex; border: 1px solid var(--po-border-subtle, rgba(128,128,128,.25)); border-radius: 3px; overflow: hidden; }
    .pb-seg button { height: 22px; padding: 0 8px; font: inherit; border: none; cursor: pointer; background: transparent; color: var(--po-text-secondary, #9da5b4); }
    .pb-seg button + button { border-left: 1px solid var(--po-border-subtle, rgba(128,128,128,.25)); }
    .pb-seg button.active { background: color-mix(in srgb, var(--po-info, #3b82f6) 22%, transparent); color: var(--po-text-primary, #e6edf3); }
    .pb-check { display: inline-flex; align-items: center; gap: 4px; margin: 0; color: var(--po-text-secondary, #9da5b4); cursor: pointer; white-space: nowrap; }
    td.c-type { position: relative; }
    .row-act { position: absolute; right: 6px; top: 1px; visibility: hidden; }
    tr:hover .row-act, tr.selected .row-act { visibility: visible; }

    /* tables (same sizes as Ports) */
    .pb-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th {
      position: sticky; top: 0; z-index: 1; text-align: left; font-weight: 400; padding: 4px 10px; white-space: nowrap;
      color: var(--po-text-secondary, #9da5b4); background: var(--po-bg-1, #161b22);
      border-bottom: 1px solid var(--po-border-subtle, rgba(128,128,128,.25));
    }
    td { padding: 0 10px; height: 24px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .c-title { width: 32%; } .c-desc { width: auto; } .c-type { width: 130px; } .c-when { width: 130px; }
    tbody tr:hover { background: color-mix(in srgb, var(--po-text-primary, #e6edf3) 6%, transparent); }
    tbody tr.selected { background: color-mix(in srgb, var(--po-info, #3b82f6) 22%, transparent); outline: 1px solid color-mix(in srgb, var(--po-info, #3b82f6) 60%, transparent); outline-offset: -1px; }
    tbody tr.selected td.c-desc { white-space: normal; }
    .pb-type {
      display: inline-block; padding: 0 6px; border-radius: 3px; font-size: 0.68rem; line-height: 16px;
      color: var(--po-text-secondary, #9da5b4); background: color-mix(in srgb, var(--po-text-primary, #e6edf3) 8%, transparent);
    }
    .pb-type[data-cat="project"] { color: var(--po-info, #3794ff); }
    .pb-type[data-cat="feedback"] { color: var(--po-warning, #d29922); }
    .pb-type[data-cat="reference"] { color: var(--po-success, #3fb950); }

    @media (max-width: 720px) {
      .pb-root { flex-direction: column; }
      .pb-tree { flex: 0 0 auto; max-height: 40%; border-right: none; border-bottom: 1px solid var(--po-border-subtle, rgba(128,128,128,.25)); }
      .pb-stats { grid-template-columns: minmax(0, 1fr); }
      .pb-bar { flex-wrap: wrap; height: auto; min-height: 30px; padding: 4px 10px; row-gap: 4px; }
      .pb-filter { flex-basis: 100%; max-width: none; }
      .c-type, .c-when, .c-kind, .c-scope { width: 80px; }
      .c-when, .c-date, .c-desc { display: none; }
    }
  `,
})
export class ProjectBriefPanelComponent {
  workspacePath = input<string | undefined>();
  provider = input<string | undefined>();

  private readonly briefService = inject(ProjectBriefService);
  private readonly swal = inject(SwalService);
  private readonly translate = inject(TranslateService);

  loading = signal(false);
  error = signal(false);
  data = signal<ProjectBriefData | null>(null);
  aiText = signal<string | null>(null);
  aiGeneratedAt = signal<number | null>(null);
  aiLoading = signal(false);
  aiError = signal<string | null>(null);

  section = signal<BriefSection>({ kind: 'overview' });
  query = signal('');
  selected = signal<BriefMemoryEntry | null>(null);

  readonly catLabels: Record<MemoryFilter, string> = {
    all: 'BRIEF.All', project: 'BRIEF.Projects', feedback: 'BRIEF.Feedback', reference: 'BRIEF.References', other: 'BRIEF.Other',
  };
  readonly catIcon: Record<MemoryFilter, string> = {
    all: 'codicon:list-flat', project: 'codicon:project', feedback: 'codicon:feedback', reference: 'codicon:references', other: 'codicon:note',
  };

  curatedFiles = computed(() => (this.data()?.contextFiles ?? []).filter((f) => f.curated));

  // ── AI provider files
  readonly providerMeta = PROVIDER_META;
  readonly kindIcon = KIND_ICON;
  readonly kindLabels: Record<ProviderFileEntry['kind'], string> = {
    instructions: 'BRIEF.Kind instructions', settings: 'BRIEF.Kind settings', mcp: 'BRIEF.Kind mcp',
    command: 'BRIEF.Kind command', agent: 'BRIEF.Kind agent', skill: 'BRIEF.Kind skill', rule: 'BRIEF.Kind rule',
  };
  readonly scopes: { id: ScopeFilter; label: string }[] = [
    { id: 'all', label: 'BRIEF.All files' }, { id: 'project', label: 'BRIEF.Scope project' }, { id: 'global', label: 'BRIEF.Scope global' },
  ];
  providerFiles = signal<ProviderFileEntry[]>([]);
  existingFiles = computed(() => this.providerFiles().filter((f) => f.exists));
  fileQuery = signal('');
  fileScope = signal<ScopeFilter>('all');
  showMissing = signal(true);
  providerGroups = computed(() => {
    const counts = new Map<ProviderFileEntry['provider'], number>();
    for (const f of this.existingFiles()) counts.set(f.provider, (counts.get(f.provider) ?? 0) + 1);
    return (['claude', 'codex', 'gemini', 'other'] as const)
      .filter((k) => counts.has(k) || this.providerFiles().some((f) => f.provider === k && f.kind === 'instructions'))
      .map((key) => ({ key, count: counts.get(key) ?? 0 }));
  });
  filteredFiles = computed(() => {
    const s = this.section();
    const prov: ProviderFilter = s.kind === 'files' ? s.provider : 'all';
    const scope = this.fileScope();
    const q = this.fileQuery().trim().toLowerCase();
    return this.providerFiles().filter((f) =>
      (prov === 'all' || f.provider === prov) && (scope === 'all' || f.scope === scope)
      && (this.showMissing() || f.exists)
      && (!q || f.rel.toLowerCase().includes(q) || f.name.toLowerCase().includes(q) || (f.description ?? '').toLowerCase().includes(q)));
  });
  filteredFilesTokens = computed(() => this.filteredFiles().reduce((n, f) => n + f.size / 4, 0));

  /** Context management state files: `.promptops/sessions/<id>/{state,logbook}.md`. */
  stateSessions = signal<{ id: string; dir: string; files: string[] }[]>([]);

  // ── file editor (context, memories, state)
  docSection = computed(() => { const s = this.section(); return s.kind === 'doc' ? s : null; });
  docText = signal('');
  private docOriginal = signal('');
  docDirty = computed(() => this.docText() !== this.docOriginal());
  docLoading = signal(false);
  docSaving = signal(false);
  docMissing = signal(false);

  // ── new note / reference
  readonly noteTypes: { id: NoteType; label: string; icon: string }[] = [
    { id: 'project', label: 'BRIEF.Note type project', icon: 'codicon:project' },
    { id: 'reference', label: 'BRIEF.Note type reference', icon: 'codicon:references' },
    { id: 'feedback', label: 'BRIEF.Note type feedback', icon: 'codicon:feedback' },
    { id: 'user', label: 'BRIEF.Note type user', icon: 'codicon:account' },
  ];
  noteType = signal<NoteType>('project');
  noteTitle = signal('');
  noteHook = signal('');
  noteBody = signal('');
  noteEnhancing = signal(false);
  noteSaving = signal(false);
  noteError = signal<string | null>(null);
  noteBeforeEnhance = signal<{ title: string; hook: string; body: string } | null>(null);

  categories = computed(() => {
    const entries = this.data()?.agentMemories.entries ?? [];
    const counts: Record<MemoryCategory, number> = { project: 0, feedback: 0, reference: 0, other: 0 };
    for (const e of entries) counts[memoryCategoryOf(e)]++;
    const cats: { key: MemoryFilter; count: number }[] = [{ key: 'all', count: entries.length }];
    for (const k of ['project', 'feedback', 'reference', 'other'] as const) if (counts[k]) cats.push({ key: k, count: counts[k] });
    return cats;
  });

  filteredMemories = computed(() => {
    const s = this.section();
    const cat: MemoryFilter = s.kind === 'memories' ? s.cat : 'all';
    const q = this.query().trim().toLowerCase();
    return (this.data()?.agentMemories.entries ?? []).filter(
      (e) => (cat === 'all' || memoryCategoryOf(e) === cat)
        && (!q || e.title.toLowerCase().includes(q) || e.hook.toLowerCase().includes(q)),
    );
  });

  isEmpty = computed(() => {
    const d = this.data();
    return !!d && !this.curatedFiles().length && !d.agentMemories.entries.length && !d.recentActivity.length;
  });

  constructor() {
    effect(() => {
      const ws = this.workspacePath();
      untracked(() => void this.load(ws, true));
    });
  }

  catOf(e: BriefMemoryEntry): MemoryCategory { return memoryCategoryOf(e); }
  isDoc(root: string | null, rel: string): boolean { const s = this.section(); return s.kind === 'doc' && s.root === root && s.rel === rel; }
  isCat(cat: MemoryFilter): boolean { const s = this.section(); return s.kind === 'memories' && s.cat === cat; }
  openFirstFile(): void {
    const d = this.data();
    const f = d?.contextFiles[0];
    if (d && f) this.openDoc(d.workspacePath, f.fileName, f.fileName, 'codicon:markdown');
  }

  isFiles(p: ProviderFilter): boolean { const s = this.section(); return s.kind === 'files' && s.provider === p; }

  openProviderFile(f: ProviderFileEntry): void {
    const label = `${PROVIDER_META[f.provider].label.split(' ·')[0]} · ${f.kind === 'skill' ? f.name : f.rel}`
      + (f.scope === 'global' ? ` (${this.translate.instant('BRIEF.Scope global')})` : '');
    this.openDoc(f.root, f.rel, label, KIND_ICON[f.kind]);
  }

  /** Path with the home shortened to ~ (shorter, and no user name on screen). */
  tildify(p: string): string {
    return p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~');
  }

  formatSize(bytes: number): string {
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  }

  formatTokens(n: number): string {
    return n < 1000 ? String(Math.round(n)) : `${(n / 1000).toFixed(1)}k`;
  }

  openMemory(d: ProjectBriefData, m: BriefMemoryEntry): void {
    if (!m.file || !d.agentMemories.dir) return;
    this.openDoc(d.agentMemories.dir, m.file, m.title, 'codicon:note');
  }

  /** Opens a file in the panel editor; asks for confirmation if the open one has unsaved changes. */
  openDoc(root: string | null, rel: string, label: string, icon: string): void {
    if (!root) return;
    if (this.isDoc(root, rel)) return;
    const go = () => void this.loadDoc({ kind: 'doc', root, rel, label, icon });
    if (this.docSection() && this.docDirty()) {
      this.swal.confirm(this.translate.instant('BRIEF.Unsaved'), this.translate.instant('BRIEF.Discard changes'), go);
    } else {
      go();
    }
  }

  private async loadDoc(doc: Extract<BriefSection, { kind: 'doc' }>): Promise<void> {
    this.section.set(doc);
    this.docLoading.set(true);
    this.docMissing.set(false);
    try {
      const text = await this.briefService.readText(doc.root, doc.rel);
      if (!this.isDoc(doc.root, doc.rel)) return;
      this.docMissing.set(text === null);
      this.docText.set(text ?? '');
      this.docOriginal.set(text ?? '');
    } catch {
      this.docText.set('');
      this.docOriginal.set('');
      this.docMissing.set(true);
    } finally {
      this.docLoading.set(false);
    }
  }

  revertDoc(): void { this.docText.set(this.docOriginal()); }

  async saveDoc(): Promise<void> {
    const doc = this.docSection();
    if (!doc || this.docSaving()) return;
    this.docSaving.set(true);
    try {
      const text = this.docText();
      await this.briefService.writeText(doc.root, doc.rel, text);
      this.docOriginal.set(text);
      this.docMissing.set(false);
      void this.reloadData();
    } catch (err: any) {
      this.swal.error(`${doc.rel}: ${err?.message || this.translate.instant('MESSAGE.Generic error')}`);
    } finally {
      this.docSaving.set(false);
    }
  }

  onEditorKey(ev: KeyboardEvent): void {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); void this.saveDoc(); }
  }

  onNoteKey(ev: KeyboardEvent): void {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); void this.saveNote(); }
  }

  startNewNote(): void {
    const go = () => {
      this.noteTitle.set(''); this.noteHook.set(''); this.noteBody.set('');
      this.noteError.set(null); this.noteBeforeEnhance.set(null);
      this.section.set({ kind: 'new' });
    };
    if (this.docSection() && this.docDirty()) {
      this.swal.confirm(this.translate.instant('BRIEF.Unsaved'), this.translate.instant('BRIEF.Discard changes'), go);
    } else if (this.section().kind !== 'new') {
      go();
    }
  }

  /** Rewrites the note with the session provider's AI: clean title, description line and text. */
  async enhanceNote(): Promise<void> {
    const provider = this.provider();
    if (!provider || this.noteEnhancing() || !this.noteBody().trim()) return;
    this.noteEnhancing.set(true);
    this.noteError.set(null);
    const before = { title: this.noteTitle(), hook: this.noteHook(), body: this.noteBody() };
    try {
      const lang = this.translate.currentLang || this.translate.defaultLang || 'en';
      const prompt =
        'You improve a note that a developer is saving into the long-term memory of coding agents for this project.\n' +
        `Type of note: ${this.noteType()} (project = ongoing work/decision/constraint, reference = pointer to an external resource, ` +
        'feedback = how the agent should work, user = who the user is).\n' +
        `Write in the language with ISO 639-1 code "${lang}". Keep every fact, link, path, command and name exactly; do not invent anything.\n` +
        'Make it clear and concise for an agent that reads it later. For project/feedback add "Why:" and "How to apply:" lines when the note implies them.\n' +
        'Answer ONLY in this exact format, no markdown fences:\n' +
        'TITLE: <max 8 words>\nDESCRIPTION: <one line, max 20 words>\nBODY:\n<the improved note>\n\n' +
        `=== CURRENT TITLE ===\n${before.title}\n=== CURRENT DESCRIPTION ===\n${before.hook}\n=== NOTE ===\n${before.body}`;
      const out = await this.briefService.generateAiBrief(prompt, provider, this.workspacePath());
      const title = /^TITLE:\s*(.+)$/m.exec(out)?.[1]?.trim();
      const hook = /^DESCRIPTION:\s*(.+)$/m.exec(out)?.[1]?.trim();
      const bodyIdx = out.search(/^BODY:\s*$/m);
      const body = bodyIdx >= 0 ? out.slice(bodyIdx).replace(/^BODY:\s*\n?/, '').trim() : out.trim();
      if (!body) throw new Error(this.translate.instant('MESSAGE.Generic error'));
      this.noteBeforeEnhance.set(before);
      if (title) this.noteTitle.set(title);
      if (hook) this.noteHook.set(hook);
      this.noteBody.set(body);
    } catch (err: any) {
      this.noteError.set(err?.message || this.translate.instant('MESSAGE.Generic error'));
    } finally {
      this.noteEnhancing.set(false);
    }
  }

  undoEnhance(): void {
    const b = this.noteBeforeEnhance();
    if (!b) return;
    this.noteTitle.set(b.title); this.noteHook.set(b.hook); this.noteBody.set(b.body);
    this.noteBeforeEnhance.set(null);
  }

  /**
   * Saves the note as an agent memory: `<type>_<slug>.md` with frontmatter in the project memory folder
   * and a line in MEMORY.md (the same format Claude Code uses, so it reads it back on its own).
   */
  async saveNote(): Promise<void> {
    const dir = this.data()?.agentMemories.dir;
    const title = this.noteTitle().trim();
    const body = this.noteBody().trim();
    if (!dir || !title || !body || this.noteSaving()) return;
    this.noteSaving.set(true);
    this.noteError.set(null);
    try {
      const type = this.noteType();
      const hook = (this.noteHook().trim() || body.split('\n')[0]).replace(/\s+/g, ' ').slice(0, 160);
      const existing = new Set((await this.briefService.listDir(dir, '')).map((e) => e.name));
      const base = `${type}_${slugify(title)}`;
      let file = `${base}.md`;
      for (let i = 2; existing.has(file); i++) file = `${base}-${i}.md`;
      const yaml = (v: string) => JSON.stringify(v);
      const content =
        `---\nname: ${slugify(title)}\ndescription: ${yaml(hook)}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;
      await this.briefService.writeText(dir, file, content);
      const index = (await this.briefService.readText(dir, 'MEMORY.md')) ?? '';
      const line = `- [${title.replace(/[\[\]]/g, '')}](${file}) — ${hook}`;
      await this.briefService.writeText(dir, 'MEMORY.md', index.replace(/\s*$/, '') + (index.trim() ? '\n' : '') + line + '\n');
      await this.reloadData();
      this.section.set({ kind: 'memories', cat: type === 'user' ? 'other' : type });
    } catch (err: any) {
      this.noteError.set(err?.message || this.translate.instant('MESSAGE.Generic error'));
    } finally {
      this.noteSaving.set(false);
    }
  }

  /** Reloads the data without changing section (after a save). */
  private async reloadData(): Promise<void> {
    const ws = this.workspacePath();
    if (!ws) return;
    try {
      const d = await this.briefService.collect(ws);
      if (ws === this.workspacePath()) this.data.set(d);
    } catch { /* the previous data stays */ }
    void this.loadStateFiles(ws);
    void this.loadProviderFiles(ws);
  }

  private async loadProviderFiles(ws: string): Promise<void> {
    const files = await this.briefService.providerFiles(ws);
    if (ws === this.workspacePath()) this.providerFiles.set(files);
  }

  private async loadStateFiles(ws: string): Promise<void> {
    const dirs = (await this.briefService.listDir(ws, '.promptops/sessions')).filter((e) => e.isDir);
    const out: { id: string; dir: string; files: string[] }[] = [];
    for (const e of dirs) {
      const dir = `.promptops/sessions/${e.name}`;
      const files = (await this.briefService.listDir(ws, dir))
        .filter((f) => !f.isDir && (f.name === 'state.md' || f.name === 'logbook.md'))
        .map((f) => f.name)
        .sort();
      if (files.length) out.push({ id: e.name, dir, files });
    }
    out.sort((a, b) => Number(b.id) - Number(a.id) || b.id.localeCompare(a.id));
    if (ws === this.workspacePath()) this.stateSessions.set(out);
  }

  /** Reloads the memories from disk (Refresh action in the tab bar). */
  refresh(): void {
    if (this.docSection() && this.docDirty()) { void this.reloadData(); return; }
    const doc = this.docSection();
    void this.load(this.workspacePath(), false).then(() => { if (doc) void this.loadDoc(doc); });
  }

  private async load(ws: string | undefined, reset: boolean): Promise<void> {
    if (reset) {
      this.data.set(null);
      this.section.set({ kind: 'overview' });
      this.query.set('');
      this.selected.set(null);
      this.aiError.set(null);
      this.loadCachedAi(ws);
      this.stateSessions.set([]);
      this.providerFiles.set([]);
      this.fileQuery.set('');
    }
    this.error.set(false);
    if (!ws) return;
    if (!this.briefService.isAvailable) { this.error.set(true); return; }
    this.loading.set(true);
    try {
      const d = await this.briefService.collect(ws);
      if (ws === this.workspacePath()) this.data.set(d);
      void this.loadStateFiles(ws);
      void this.loadProviderFiles(ws);
    } catch {
      if (ws === this.workspacePath()) this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  canGenerateAi(): boolean {
    const p = this.provider();
    return !!p && p !== 'generic-shell' && this.briefService.isDesktop;
  }

  async generateAi(): Promise<void> {
    const d = this.data();
    const provider = this.provider();
    if (!d || !provider || this.aiLoading()) return;
    this.aiLoading.set(true);
    this.aiError.set(null);
    try {
      const lang = this.translate.currentLang || this.translate.defaultLang || 'en';
      const prompt =
        'You are writing a short project brief to present a software project to a teammate.\n' +
        `Write it in the language with ISO 639-1 code "${lang}".\n` +
        'Maximum ~300 words. Plain text only: short paragraphs and hyphen bullets, no markdown syntax.\n' +
        'Cover: what the project is, its main components, key conventions or guardrails, and current work in progress.\n' +
        'Base it ONLY on the material below; do not invent anything.\n\n' +
        '=== MATERIAL ===\n' + d.aiSource;
      const text = await this.briefService.generateAiBrief(prompt, provider, this.workspacePath());
      const at = Date.now();
      this.aiText.set(text);
      this.aiGeneratedAt.set(at);
      this.saveCachedAi(text, at);
    } catch (err: any) {
      this.aiError.set(err?.message || this.translate.instant('MESSAGE.Generic error'));
    } finally {
      this.aiLoading.set(false);
    }
  }

  /** Copies the whole brief as Markdown (Copy action in the tab bar). */
  async copyAll(): Promise<void> {
    const d = this.data();
    if (!d) return;
    const lines: string[] = [`# ${d.projectName}`, d.workspacePath, ''];
    const ai = this.aiText();
    if (ai) lines.push(ai, '');
    for (const f of this.curatedFiles()) lines.push(`## ${f.fileName}`, f.excerpt, '');
    if (d.agentMemories.entries.length) {
      lines.push(`## ${this.translate.instant('BRIEF.Agent memories')}`);
      for (const e of d.agentMemories.entries) lines.push(`- ${e.title}${e.hook ? ` — ${e.hook}` : ''}`);
      lines.push('');
    }
    if (d.recentActivity.length) {
      lines.push(`## ${this.translate.instant('BRIEF.Recent activity')}`);
      for (const a of d.recentActivity) lines.push(`- [${a.category}] ${a.content}`);
    }
    await this.copyText(lines.join('\n'));
  }

  async copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.swal.autoClose(this.translate.instant('BRIEF.Copied'), this.translate.instant('BRIEF.Copied message'));
    } catch {
      this.swal.error(this.translate.instant('MESSAGE.Generic error'));
    }
  }

  formatDay(ts: number): string {
    const lang = this.translate.currentLang || this.translate.defaultLang || 'en';
    try { return new Date(ts).toLocaleDateString(lang, { dateStyle: 'short' }); }
    catch { return new Date(ts).toLocaleDateString(); }
  }

  formatDate(ts: number): string {
    const lang = this.translate.currentLang || this.translate.defaultLang || 'en';
    try { return new Date(ts).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' }); }
    catch { return new Date(ts).toLocaleString(); }
  }

  private loadCachedAi(ws: string | undefined): void {
    const cached = ws ? readBriefCache()[ws] : undefined;
    this.aiText.set(cached?.text ?? null);
    this.aiGeneratedAt.set(typeof cached?.generatedAt === 'number' ? cached.generatedAt : null);
  }

  private saveCachedAi(text: string, generatedAt: number): void {
    const ws = this.workspacePath();
    if (!ws) return;
    const cache = readBriefCache();
    cache[ws] = { text, generatedAt };
    const paths = Object.keys(cache);
    if (paths.length > BRIEF_CACHE_MAX) {
      paths.sort((a, b) => (cache[a]?.generatedAt ?? 0) - (cache[b]?.generatedAt ?? 0));
      for (const stale of paths.slice(0, paths.length - BRIEF_CACHE_MAX)) delete cache[stale];
    }
    try { localStorage.setItem(BRIEF_CACHE_KEY, JSON.stringify(cache)); } catch { /* quota */ }
  }
}
