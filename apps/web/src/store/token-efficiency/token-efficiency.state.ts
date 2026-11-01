export interface TokenBreakdown {
  file_reads_estimated: number;
  tool_schema_estimated: number;
  context_estimated: number;
  actual_tokens: number;
}

export interface OptimizationFlags {
  used_context_injection?: boolean;
  used_cache?: boolean;
  used_graph_query?: boolean;
  used_tool_filtering?: boolean;
  used_code_execution?: boolean;
  used_prompt_dedup?: boolean;
  used_diff_only?: boolean;
  used_batch_reads?: boolean;
  used_conversation_pruning?: boolean;
  used_subagent_scoping?: boolean;
  used_semantic_retrieval?: boolean;
  used_session_memory?: boolean;
  [key: string]: boolean | undefined;
}

export interface OptimizationAnalytics {
  tokensSaved: number;
  occurrences: number;
}

export interface SessionTokenStats {
  sessionId: string;
  tokensUsed: number;
  tokensEstimated: number;
  tokensSaved: number;
  efficiencyPercentage: number;
  /** False when no independent savings baseline is available. */
  savingsAvailable?: boolean;
  breakdown: TokenBreakdown | null;
  optimizationFlags: OptimizationFlags | null;
  optimizationAnalytics: Record<string, OptimizationAnalytics> | null;
  promptCount?: number;
  /** Input tokens served from the provider prompt cache (~10% cost). */
  cacheReadTokens?: number;
  /** Share of input side served from cache — health metric for context optimizations. */
  cacheHitPercentage?: number;
  /** Real spend for this session, USD (provider rates). */
  costUsd?: number;
  /** Avoided spend from optimizations, USD (saved tokens at the input rate). */
  costSavedUsd?: number;
  /** Measured saving from prompt caching, USD. */
  cacheSavedUsd?: number;
  /** Context size (input + cache) of the last provider call — from transcript data. */
  lastContextTokens?: number;
  /** Epoch ms of the last provider call. */
  lastActivityMs?: number;
  /** Provider prompt-cache TTL seen in the transcript (0/undefined = unknown). */
  cacheTtlMs?: number;
  /** Same last-call data per agent of this session (key = sub-agent id); the fields above are the main's. */
  agentContexts?: Record<string, { lastContextTokens?: number; lastActivityMs?: number; cacheTtlMs?: number }>;
  /** Resumes after the cache expired, and the tokens re-written to cache. */
  coldResumeCount?: number;
  coldResumeTokens?: number;
  /** /compact runs started from PromptOps (measured saving in optimizationAnalytics.used_compaction). */
  compactionsByPromptops?: number;
}

export interface DashboardTokenStats {
  totalTokensUsed: number;
  totalTokensEstimated: number;
  totalTokensSaved: number;
  averageEfficiency: number;
  sessionCount: number;
  topSessions: Array<{
    name: string;
    provider: string;
    tokens_used: number;
    tokens_saved: number;
    efficiency_percentage: number;
  }>;
}

// ── Provider Usage (parsed from /usage command) ─────────────────

export interface UsageSection {
  label: string;
  percentUsed: number;
  resetsLabel: string;
}

/**
 * Session-activity metrics for providers without a quota/rate-limit
 * model. Two cases:
 *  - Gemini /stats parser populates the timing fields (wallTime, ...)
 *  - Token-based fallback (Copilot/Cursor/OpenCode) populates the token
 *    fields (tokensUsed, costUsd, ...) from TokenTracker
 * Rendered as key/value rows in the UI either way.
 */
export interface ActivityMetrics {
  sessionId?: string;
  authMethod?: string;
  tier?: string;
  toolCalls?: number;
  toolCallsSuccess?: number;
  toolCallsError?: number;
  successRatePct?: number;
  wallTime?: string;
  agentActive?: string;
  apiTime?: string;
  toolTime?: string;
  // ── Token-based fallback (Copilot, Cursor, OpenCode) ───────
  tokensUsed?: number;
  tokensSaved?: number;
  efficiencyPct?: number;
  costUsd?: number;
  promptCount?: number;
  source?: 'cli-probe' | 'token-tracker';
}

export interface ProviderUsageSnapshot {
  sessionId: string;
  provider: string;
  model: string;
  sections: UsageSection[];
  sessionPercent: number;
  sessionResets: string;
  weeklyPercent: number;
  weeklyResets: string;
  /**
   * Weekly quota scoped to one model bucket — Claude `/usage` prints it as
   * `Current week (Fable)`. Optional: an older desktop build
   * simply won't send these fields.
   */
  modelWeeklyLabel?: string;
  modelWeeklyPercent?: number;
  modelWeeklyResets?: string;
  extraUsageEnabled: boolean;
  timestamp: string;
  activityMetrics?: ActivityMetrics;
  /** AI Accounts login the quota was read with; absent = default install (or an older desktop build). */
  accountId?: string;
  accountName?: string;
}

// 'user-action-required': automatic probes never launch the provider CLI;
// the user has to press Retry/Refresh once.
export type ProviderUsageProbeReason = 'command-not-found' | 'timeout' | 'no-output' | 'user-action-required' | 'generic';

export interface ProviderUsageProbeError {
  sessionId: string;
  provider: string;
  reason: ProviderUsageProbeReason;
  detail?: string;
  timestamp: string;
}

// ── Combined State ─────────────────────────────────────────────

export interface TokenEfficiencyState {
  sessionStats: Record<string, SessionTokenStats>;
  dashboard: DashboardTokenStats | null;
  providerUsage: Record<string, ProviderUsageSnapshot>;
  providerUsageErrors: Record<string, ProviderUsageProbeError>;
  loading: boolean;
  error: string | null;
}

export const initialTokenEfficiencyState: TokenEfficiencyState = {
  sessionStats: {},
  dashboard: null,
  providerUsage: {},
  providerUsageErrors: {},
  loading: false,
  error: null,
};
