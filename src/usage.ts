/** Extract SDK ResultMessage usage. Latest result wins — do not sum results. */

export type ModelUsageRow = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD?: number;
};

export type SessionUsage = {
  cost_usd: number;
  model_usage: Record<string, ModelUsageRow>;
  last_turn_usage: unknown;
  updated_ts: number;
};

export type UsageTotals = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function normalizeModelUsage(raw: unknown): Record<string, ModelUsageRow> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ModelUsageRow> = {};
  for (const [model, row] of Object.entries(raw as Record<string, unknown>)) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const rec: ModelUsageRow = {
      inputTokens: num(r.inputTokens ?? r.input_tokens),
      outputTokens: num(r.outputTokens ?? r.output_tokens),
      cacheReadInputTokens: num(r.cacheReadInputTokens ?? r.cache_read_input_tokens),
      cacheCreationInputTokens: num(r.cacheCreationInputTokens ?? r.cache_creation_input_tokens),
    };
    const cost = r.costUSD ?? r.cost_usd;
    if (typeof cost === "number") rec.costUSD = cost;
    out[model] = rec;
  }
  return out;
}

/**
 * Pull usage from a single ResultMessage-shaped object.
 * total_cost_usd and modelUsage are cumulative on the streaming query();
 * the caller must keep the latest result, not sum across results.
 */
export function extractUsageFromResult(result: unknown): SessionUsage | null {
  if (!result || typeof result !== "object") return null;
  const m = result as Record<string, unknown>;
  if (m.type != null && m.type !== "result") return null;
  const costRaw = m.total_cost_usd ?? m.totalCostUsd;
  const modelRaw = m.modelUsage ?? m.model_usage;
  const turnUsage = m.usage;
  if (costRaw == null && modelRaw == null && turnUsage == null) return null;
  return {
    cost_usd: num(costRaw),
    model_usage: normalizeModelUsage(modelRaw),
    last_turn_usage: turnUsage ?? null,
    updated_ts: Date.now() / 1000,
  };
}

export function sumModelUsageTokens(modelUsage: Record<string, ModelUsageRow> | null | undefined): UsageTotals {
  const totals: UsageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  if (!modelUsage) return totals;
  for (const row of Object.values(modelUsage)) {
    totals.input_tokens += row.inputTokens || 0;
    totals.output_tokens += row.outputTokens || 0;
    totals.cache_read_input_tokens += row.cacheReadInputTokens || 0;
    totals.cache_creation_input_tokens += row.cacheCreationInputTokens || 0;
  }
  return totals;
}

export function usageStatusFields(usage: SessionUsage | null | undefined): Record<string, unknown> {
  if (!usage) {
    return {
      cost_usd: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      model_usage: null,
    };
  }
  const t = sumModelUsageTokens(usage.model_usage);
  return {
    cost_usd: usage.cost_usd,
    input_tokens: t.input_tokens,
    output_tokens: t.output_tokens,
    cache_read_input_tokens: t.cache_read_input_tokens,
    cache_creation_input_tokens: t.cache_creation_input_tokens,
    model_usage: usage.model_usage,
  };
}
