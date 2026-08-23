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

const SKIP_MODEL_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const TURN_USAGE_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function own(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function ownVal(r: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (own(r, k)) return r[k];
  }
  return undefined;
}

function ownNum(r: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    if (!own(r, k)) continue;
    return num(r[k]);
  }
  return 0;
}

function ownFiniteCost(r: Record<string, unknown>): number | undefined {
  for (const k of ["costUSD", "cost_usd"]) {
    if (!own(r, k)) continue;
    const v = r[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

export function normalizeModelUsage(raw: unknown): Record<string, ModelUsageRow> {
  if (!isRecord(raw)) return Object.create(null);
  const out: Record<string, ModelUsageRow> = Object.create(null);
  for (const [model, row] of Object.entries(raw)) {
    if (SKIP_MODEL_KEYS.has(model)) continue;
    if (!isRecord(row)) continue;
    const rec = Object.assign(Object.create(null), {
      inputTokens: ownNum(row, "inputTokens", "input_tokens"),
      outputTokens: ownNum(row, "outputTokens", "output_tokens"),
      cacheReadInputTokens: ownNum(row, "cacheReadInputTokens", "cache_read_input_tokens"),
      cacheCreationInputTokens: ownNum(row, "cacheCreationInputTokens", "cache_creation_input_tokens"),
    }) as ModelUsageRow;
    const cost = ownFiniteCost(row);
    if (cost !== undefined) rec.costUSD = cost;
    out[model] = rec;
  }
  return out;
}

function normalizeTurnUsage(raw: unknown): Record<string, number> | null {
  if (!isRecord(raw)) return raw == null ? null : {};
  const out: Record<string, number> = {};
  for (const k of TURN_USAGE_KEYS) {
    if (!own(raw, k)) continue;
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Pull usage from a single ResultMessage-shaped object.
 * total_cost_usd and modelUsage are cumulative on the streaming query();
 * the caller must keep the latest result, not sum across results.
 */
export function extractUsageFromResult(result: unknown): SessionUsage | null {
  if (!isRecord(result)) return null;
  if (own(result, "type") && result.type !== "result") return null;
  const costRaw = ownVal(result, "total_cost_usd", "totalCostUsd");
  const modelRaw = ownVal(result, "modelUsage", "model_usage");
  const turnUsage = ownVal(result, "usage");
  if (costRaw == null && modelRaw == null && turnUsage == null) return null;
  return {
    cost_usd: num(costRaw),
    model_usage: normalizeModelUsage(modelRaw),
    last_turn_usage: turnUsage == null ? null : normalizeTurnUsage(turnUsage),
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
  for (const [key, row] of Object.entries(modelUsage)) {
    if (SKIP_MODEL_KEYS.has(key) || !row) continue;
    totals.input_tokens += num(row.inputTokens);
    totals.output_tokens += num(row.outputTokens);
    totals.cache_read_input_tokens += num(row.cacheReadInputTokens);
    totals.cache_creation_input_tokens += num(row.cacheCreationInputTokens);
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
  const model_usage = normalizeModelUsage(usage.model_usage);
  const t = sumModelUsageTokens(model_usage);
  return {
    cost_usd: num(usage.cost_usd),
    input_tokens: t.input_tokens,
    output_tokens: t.output_tokens,
    cache_read_input_tokens: t.cache_read_input_tokens,
    cache_creation_input_tokens: t.cache_creation_input_tokens,
    model_usage,
  };
}
