import { Injectable } from '@angular/core';

/**
 * Project Brief — aggregation of the coding agents' memories for a workspace
 * (CLAUDE.md/AGENTS.md/GEMINI.md, Claude Code per-project memory files,
 * .promptops artifacts), collected by the native desktop side.
 *
 * Everything is local-only: memory content never leaves the device.
 */

export interface BriefContextFile {
  fileName: string;
  curated: boolean;
  excerpt: string;
  updatedAt?: string;
}

export interface BriefMemoryEntry {
  title: string;
  hook: string;
  file?: string;
}

export interface BriefActivityEntry {
  category: string;
  content: string;
  timestamp: number;
  relatedFiles: string[];
}

export interface ProjectBriefData {
  workspacePath: string;
  projectName: string;
  generatedAt: string;
  frameworks: string[];
  languages: string[];
  summary?: string;
  contextFiles: BriefContextFile[];
  agentMemories: {
    dir: string | null;
    entries: BriefMemoryEntry[];
    fileCount: number;
  };
  recentActivity: BriefActivityEntry[];
  aiSource: string;
}

/** File read by an AI provider (instructions, settings, MCP, commands, sub-agents, skills, rules). */
export interface ProviderFileEntry {
  provider: 'claude' | 'codex' | 'gemini' | 'other';
  scope: 'project' | 'global';
  kind: 'instructions' | 'settings' | 'mcp' | 'command' | 'agent' | 'skill' | 'rule';
  root: string;
  rel: string;
  name: string;
  description?: string | null;
  readBy: string[];
  exists: boolean;
  size: number;
  modifiedMs?: number | null;
}

@Injectable({ providedIn: 'root' })
export class ProjectBriefService {
  get isDesktop(): boolean {
    return !!(window as any).promptops;
  }

  private get api(): any {
    return (window as any).promptops;
  }

  /** Feature-detect against older preload builds. */
  get isAvailable(): boolean {
    return this.isDesktop && typeof this.api.collectProjectBrief === 'function';
  }

  async collect(workspacePath: string): Promise<ProjectBriefData> {
    if (!this.isAvailable) throw new Error('desktop_only');
    const res = await this.api.collectProjectBrief({ workspacePath });
    if (!res?.ok) throw new Error(res?.error || 'collect_failed');
    return res.data as ProjectBriefData;
  }

  /** Inventory of the provider files (project + active account home); [] on older bridges. */
  async providerFiles(workspacePath: string): Promise<ProviderFileEntry[]> {
    if (!this.isDesktop || typeof this.api.listProviderFiles !== 'function') return [];
    try {
      const res = await this.api.listProviderFiles({ workspacePath });
      return res?.ok ? (res.files as ProviderFileEntry[]) : [];
    } catch {
      return [];
    }
  }

  /** Reads a text file under `root` (same sandbox as the editor: nothing outside root). */
  async readText(root: string, rel: string): Promise<string | null> {
    if (!this.isDesktop || typeof this.api.fsReadFile !== 'function') throw new Error('desktop_only');
    const res = await this.api.fsReadFile(root, rel);
    return res?.ok ? (res.content ?? '') : null;
  }

  async writeText(root: string, rel: string, content: string): Promise<void> {
    if (!this.isDesktop || typeof this.api.fsWriteFile !== 'function') throw new Error('desktop_only');
    const res = await this.api.fsWriteFile(root, rel, content);
    if (!res?.ok) throw new Error(res?.error || 'write_failed');
  }

  /** Direct entries of a folder under `root`; [] when it does not exist. */
  async listDir(root: string, rel: string): Promise<{ name: string; isDir: boolean }[]> {
    if (!this.isDesktop || typeof this.api.fsListDirShallow !== 'function') return [];
    try {
      const res = await this.api.fsListDirShallow(root, rel);
      return res?.ok ? (res.entries ?? []).map((e: any) => ({ name: e.name, isDir: !!e.isDir })) : [];
    } catch {
      return [];
    }
  }

  /** One-shot LLM call through the session's provider CLI (local, nothing else is called). */
  async generateAiBrief(prompt: string, provider: string, cwd?: string): Promise<string> {
    if (!this.isDesktop || typeof this.api.aiGenerateText !== 'function') {
      throw new Error('desktop_only');
    }
    const res = await this.api.aiGenerateText(prompt, provider, cwd);
    if (!res?.ok) throw new Error(res?.error || 'generate_failed');
    return res.text as string;
  }
}
