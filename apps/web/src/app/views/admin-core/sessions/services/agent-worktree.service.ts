import { Injectable, inject, signal } from '@angular/core';
import { GitService, GitWorktree } from './git.service';
import { SubAgent, SubAgentService } from './sub-agent.service';

const CLAUDE_FAMILY = ['claude-code-cli', 'zai', 'kimi'];
const BUSY_STATUSES = ['spawning', 'in_progress', 'waiting_input'];
const LIST_TTL_MS = 5000;
const LEAD_CWDS_KEY = 'po:agent-worktree:lead';

/** Per-agent worktree selection: the choice is the folder the agent works in. */
@Injectable({ providedIn: 'root' })
export class AgentWorktreeService {
  private git = inject(GitService);
  private subAgents = inject(SubAgentService);

  /** List per cwd; null = folder without a git repository. */
  private lists = signal<Record<string, GitWorktree[] | null>>({});
  /** Main session folder after a switch: the session keeps its workspace. */
  private leadCwds = signal<Record<string, string>>(this.readLeadCwds());
  private loadedAt = new Map<string, number>();
  /** Real git error (not "folder without a repo"): a single line in the sidebar. */
  loadError = signal<string | null>(null);

  cwdOf(agent: SubAgent): string | undefined {
    if (agent.id === '__main__') return this.leadCwds()[agent.sessionId] ?? agent.cwd;
    return agent.cwd;
  }

  /** A plain shell has no worktree: every agent with a provider does. */
  hasProvider(agent: SubAgent): boolean {
    return agent.provider !== ('generic-shell' as SubAgent['provider']);
  }

  /** Local agents with a folder only. */
  supports(agent: SubAgent): boolean {
    const cwd = this.cwdOf(agent);
    return !!cwd && this.hasProvider(agent) && !/^(ssh|cmd):\/\//.test(cwd);
  }

  listOf(cwd: string | undefined): GitWorktree[] | null {
    return cwd ? this.lists()[cwd] ?? null : null;
  }

  /** Does the session folder hold several repos? */
  isMultiRepo(root: string | undefined): boolean {
    return !!this.listOf(root)?.some(w => w.repoPath);
  }

  /** Folder to list and create from: with several repos, the session's. */
  listCwd(agent: SubAgent, root: string | undefined): string | undefined {
    return this.isMultiRepo(root) ? root : this.cwdOf(agent);
  }

  /** With several repos the agent can move between them: the list stays complete. */
  listFor(agent: SubAgent, root: string | undefined): GitWorktree[] | null {
    const cwd = this.cwdOf(agent);
    if (!this.isMultiRepo(root)) return this.listOf(cwd);
    return this.listOf(root)!.map(w => ({ ...w, current: w.path === cwd }));
  }

  currentOf(agent: SubAgent, root?: string): GitWorktree | null {
    return this.listFor(agent, root)?.find(w => w.current) ?? null;
  }

  /** Folder + branch with several repos, otherwise just the branch. */
  title(wt: GitWorktree): string {
    const branch = wt.branch ?? wt.shortHead;
    return wt.repo ? `${wt.repo} · ${branch}` : branch;
  }

  isBusy(agent: SubAgent): boolean {
    return BUSY_STATUSES.includes(agent.status);
  }

  /** Does the switch start a new conversation? */
  losesConversation(agent: SubAgent): boolean {
    return !CLAUDE_FAMILY.includes(agent.provider) || agent.executionMode === 'worker';
  }

  /** The main session keeps its PTY: only the Claude family can move today. */
  canSwitch(agent: SubAgent): boolean {
    return agent.id !== '__main__' || CLAUDE_FAMILY.includes(agent.provider);
  }

  /** Roster agents working in the same linked worktree. */
  sharedCount(agent: SubAgent, agents: SubAgent[], root?: string): number {
    const current = this.currentOf(agent, root);
    if (!current || current.main) return 0;
    return agents.filter(a => this.currentOf(a, root)?.path === current.path).length;
  }

  async load(cwd: string, force = false): Promise<void> {
    const last = this.loadedAt.get(cwd) ?? 0;
    if (!force && Date.now() - last < LIST_TTL_MS) return;
    this.loadedAt.set(cwd, Date.now());
    const res = await this.git.listWorktrees(cwd);
    let list: GitWorktree[] | null = res.ok ? res.worktrees ?? [] : null;
    if (res.ok || /not a git repository/i.test(res.error ?? '')) {
      this.loadError.set(null);
      if (!res.ok) list = await this.listNestedRepos(cwd);
    } else {
      this.loadError.set(res.error ?? 'Worktree list failed');
    }
    this.lists.update(all => ({ ...all, [cwd]: list }));
    if (!list) this.forgetLeadCwd(cwd);
  }

  /** Remembered worktree is gone: the main session returns to the session folder. */
  private forgetLeadCwd(cwd: string): void {
    const kept = Object.entries(this.leadCwds()).filter(([, path]) => path !== cwd);
    if (kept.length === Object.keys(this.leadCwds()).length) return;
    this.leadCwds.set(Object.fromEntries(kept));
    localStorage.setItem(LEAD_CWDS_KEY, JSON.stringify(this.leadCwds()));
  }

  private readLeadCwds(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(LEAD_CWDS_KEY) ?? '{}');
    } catch {
      return {};
    }
  }

  /** Workspace holding several repos: the choice covers the worktrees of each. */
  private async listNestedRepos(cwd: string): Promise<GitWorktree[] | null> {
    const repos = await this.git.discoverRepos(cwd);
    const lists = await Promise.all(repos.map(repo => this.git.listWorktrees(repo.path)));
    // None is "current": the agent is in the parent folder, outside all of them.
    const all = lists.flatMap((res, i) => (res.ok ? res.worktrees ?? [] : [])
      .map(wt => ({ ...wt, current: false, repo: repos[i].name, repoPath: repos[i].path })));
    return all.length ? all : null;
  }

  async switchTo(agent: SubAgent, wt: GitWorktree): Promise<{ ok: boolean; error?: string }> {
    const res = agent.id === '__main__'
      ? await this.subAgents.switchLeadWorktree(agent.sessionId, wt.path)
      : await this.subAgents.switchWorktree(agent.id, wt.path, this.handoffPrompt(agent, wt));
    if (res.ok && agent.id === '__main__') {
      this.leadCwds.update(all => ({ ...all, [agent.sessionId]: wt.path }));
      localStorage.setItem(LEAD_CWDS_KEY, JSON.stringify(this.leadCwds()));
    }
    if (res.ok) await this.load(wt.path, true);
    return res;
  }

  /** Which other agent already works in this worktree. */
  occupant(wt: GitWorktree, agent: SubAgent, agents: SubAgent[], root?: string): SubAgent | null {
    return agents.find(a => a.id !== agent.id && this.currentOf(a, root)?.path === wt.path) ?? null;
  }

  /** Repositories reachable from this folder: one, or several if it holds them. */
  reposOf(cwd: string): { path: string; name: string }[] {
    return (this.listOf(cwd) ?? [])
      .filter(w => w.main)
      .map(w => ({ path: w.path, name: w.repo ?? w.name }));
  }

  /** Start points in the chosen repo: the current branch first. */
  startPoints(cwd: string, repoPath: string): string[] {
    const inRepo = (this.listOf(cwd) ?? []).filter(w => !w.repoPath || w.repoPath === repoPath);
    const sorted = [...inRepo.filter(w => w.current), ...inRepo.filter(w => !w.current)];
    return [...new Set(sorted.map(w => w.branch).filter((b): b is string => !!b))];
  }

  /** Creates the worktree where Claude Code would, on the typed branch. */
  async create(cwd: string, repoPath: string, branch: string, base?: string): Promise<{ ok: boolean; worktree?: GitWorktree; error?: string }> {
    const name = branch.trim();
    const slug = name.replace(/[\\/\s]+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').replace(/^[-.]+/, '');
    if (!repoPath || !slug) return { ok: false };
    const path = `${repoPath}/.claude/worktrees/${slug}`;
    const res = await this.git.addWorktree(repoPath, path, name, true, base || undefined);
    if (!res.ok) return { ok: false, error: res.error };
    await this.load(cwd, true);
    const worktree = this.listOf(cwd)?.find(w => w.path === res.path || w.path === path);
    return worktree ? { ok: true, worktree } : { ok: false, error: 'Worktree not found' };
  }

  private handoffPrompt(agent: SubAgent, wt: GitWorktree): string {
    const task = agent.userPrompt?.trim();
    return `You have been moved to the git worktree ${wt.path} (branch ${wt.branch ?? wt.shortHead}). `
      + `Work only there.${task ? ` Your task so far: ${task}` : ' Wait for instructions.'}`;
  }
}
