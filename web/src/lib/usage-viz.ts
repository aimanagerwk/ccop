/** Settled-usage charts. Mid-turn numbers are never drawn. */

export const UNSETTLED_LABEL = "尚未结算";
export const STALE_LABEL = "过期";
export const SETTLED_LABEL = "已结算";
export const INCOMPLETE_LABEL = "缺数据";

export type FreshnessState = "unsettled" | "stale" | "settled" | "incomplete";

export type Freshness = {
  state: FreshnessState;
  label: string;
  updated_ts: number | null;
};

export type HistoryPoint = {
  ts: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

export type SparkPoint = { ts: number; tokens: number };

export type TokenSpark = {
  state: FreshnessState;
  label: string;
  headline: number | null;
  points: SparkPoint[];
  path: string | null;
  last: { x: number; y: number } | null;
  width: number;
  height: number;
};

export type BurnRate = {
  state: FreshnessState;
  label: string;
  usd_per_min: number | null;
};

export type CacheHit = {
  state: FreshnessState;
  label: string;
  ratio: number | null;
  read: number;
  billed: number;
};

const SKIP_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const IN_TURN = new Set(["sent", "working", "needs_decision", "needs_info", "held", "interrupted"]);

export const SPARK_W = 64;
export const SPARK_H = 20;
export const SPARK_PAD = 4;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function own(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function ownFinite(r: Record<string, unknown>, key: string): number | null {
  if (!own(r, key)) return null;
  const v = r[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function ownNum(r: Record<string, unknown>, key: string): number {
  return ownFinite(r, key) ?? 0;
}

export function parseUsageHistory(raw: unknown): HistoryPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryPoint[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const ts = ownFinite(item, "ts");
    if (ts === null) continue;
    out.push({
      ts,
      cost_usd: ownNum(item, "cost_usd"),
      input_tokens: ownNum(item, "input_tokens"),
      output_tokens: ownNum(item, "output_tokens"),
      cache_read_input_tokens: ownNum(item, "cache_read_input_tokens"),
      cache_creation_input_tokens: ownNum(item, "cache_creation_input_tokens"),
    });
  }
  return out;
}

export function pointTokens(p: HistoryPoint): number {
  return p.input_tokens + p.output_tokens + p.cache_read_input_tokens + p.cache_creation_input_tokens;
}

export type LiveUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

function liveFinite(live: object, key: string): number | null {
  if (!own(live, key)) return null;
  const v = (live as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function liveTokenTotal(live?: LiveUsage | null): number | null {
  if (!live || typeof live !== "object") return null;
  const keys = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;
  let any = false;
  let sum = 0;
  for (const k of keys) {
    const n = liveFinite(live, k);
    if (n === null) continue;
    any = true;
    sum += n;
  }
  return any ? sum : null;
}

export function usageFreshness(input: {
  usage_updated_ts?: number | null;
  last_kind?: string | null;
  has_snapshot?: boolean;
}): Freshness {
  const ts =
    typeof input.usage_updated_ts === "number" && Number.isFinite(input.usage_updated_ts)
      ? input.usage_updated_ts
      : null;
  if (ts === null) {
    if (input.has_snapshot) {
      return { state: "incomplete", label: INCOMPLETE_LABEL, updated_ts: null };
    }
    return { state: "unsettled", label: UNSETTLED_LABEL, updated_ts: null };
  }
  const kind = typeof input.last_kind === "string" ? input.last_kind : "";
  if (IN_TURN.has(kind)) {
    return { state: "stale", label: STALE_LABEL, updated_ts: ts };
  }
  return { state: "settled", label: SETTLED_LABEL, updated_ts: ts };
}

export function sparkLayout(
  points: SparkPoint[],
  width = SPARK_W,
  height = SPARK_H,
  pad = SPARK_PAD,
): { path: string | null; last: { x: number; y: number } | null } {
  if (!points.length) return { path: null, last: null };
  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.tokens);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);
  const coords = points.map((p, i) => {
    const x =
      maxX === minX
        ? pad + (points.length === 1 ? innerW / 2 : (i / Math.max(1, points.length - 1)) * innerW)
        : pad + ((p.ts - minX) / (maxX - minX)) * innerW;
    const y =
      maxY === minY ? pad + innerH / 2 : pad + (1 - (p.tokens - minY) / (maxY - minY)) * innerH;
    return { x, y };
  });
  const last = coords[coords.length - 1];
  if (coords.length < 2) return { path: null, last };
  const d = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(" ");
  return { path: d, last };
}

export function tokenSpark(
  history: unknown,
  freshness: Freshness,
  size?: { width?: number; height?: number },
  live?: LiveUsage | null,
): TokenSpark {
  const width = size?.width ?? SPARK_W;
  const height = size?.height ?? SPARK_H;
  const empty = (state: FreshnessState, label: string): TokenSpark => ({
    state,
    label,
    headline: null,
    points: [],
    path: null,
    last: null,
    width,
    height,
  });
  if (freshness.state === "unsettled") return empty("unsettled", UNSETTLED_LABEL);
  const points = parseUsageHistory(history).map((p) => ({ ts: p.ts, tokens: pointTokens(p) }));
  if (!points.length) {
    const headline = freshness.state === "incomplete" ? liveTokenTotal(live) : null;
    if (headline === null) {
      return empty(
        freshness.state === "incomplete" ? "incomplete" : "unsettled",
        freshness.state === "incomplete" ? INCOMPLETE_LABEL : UNSETTLED_LABEL,
      );
    }
    const fallback = [{ ts: 0, tokens: headline }];
    const layout = sparkLayout(fallback, width, height);
    return {
      state: "incomplete",
      label: INCOMPLETE_LABEL,
      headline,
      points: fallback,
      path: null,
      last: layout.last,
      width,
      height,
    };
  }
  const layout = sparkLayout(points, width, height);
  const headline = points[points.length - 1].tokens;
  const label =
    freshness.state === "stale" ? STALE_LABEL : freshness.state === "incomplete" ? INCOMPLETE_LABEL : SETTLED_LABEL;
  return {
    state: freshness.state,
    label,
    headline,
    points,
    path: layout.path,
    last: layout.last,
    width,
    height,
  };
}

export function sparkClass(state: FreshnessState): string {
  if (state === "stale") return "spark stale";
  if (state === "incomplete") return "spark incomplete";
  if (state === "unsettled") return "spark empty";
  return "spark";
}

/** Adjacent settled costs only. Never wall-clock extrapolate. */
export function burnRate(history: unknown, freshness: Freshness): BurnRate {
  const missing = (): BurnRate => {
    if (freshness.state === "incomplete") {
      return { state: "incomplete", label: INCOMPLETE_LABEL, usd_per_min: null };
    }
    return { state: "unsettled", label: UNSETTLED_LABEL, usd_per_min: null };
  };
  const points = parseUsageHistory(history);
  if (points.length < 2) return missing();
  const prev = points[points.length - 2];
  const last = points[points.length - 1];
  const dt = last.ts - prev.ts;
  if (!(dt > 0) || !Number.isFinite(prev.cost_usd) || !Number.isFinite(last.cost_usd)) {
    return missing();
  }
  const usd_per_min = ((last.cost_usd - prev.cost_usd) / dt) * 60;
  if (!Number.isFinite(usd_per_min)) return missing();
  if (freshness.state === "unsettled") {
    return { state: "unsettled", label: UNSETTLED_LABEL, usd_per_min: null };
  }
  if (freshness.state === "stale") {
    return { state: "stale", label: STALE_LABEL, usd_per_min };
  }
  if (freshness.state === "incomplete") {
    return { state: "incomplete", label: INCOMPLETE_LABEL, usd_per_min };
  }
  return { state: "settled", label: SETTLED_LABEL, usd_per_min };
}

export function formatBurnRate(usdPerMin: number | null | undefined): string {
  if (usdPerMin === null || usdPerMin === undefined || !Number.isFinite(usdPerMin)) return "—";
  const abs = Math.abs(usdPerMin);
  const digits = abs !== 0 && abs < 0.01 ? 4 : 2;
  const sign = usdPerMin < 0 ? "-" : "";
  return `${sign}$${abs.toFixed(digits)}/分`;
}

export function freshnessClass(state: FreshnessState): string {
  if (state === "stale") return "pill freshness stale";
  if (state === "incomplete") return "pill freshness incomplete";
  if (state === "unsettled") return "pill freshness unsettled";
  return "pill freshness settled";
}

export function isFreshnessClass(cls: string): boolean {
  return (
    cls === "pill freshness settled" ||
    cls === "pill freshness stale" ||
    cls === "pill freshness incomplete" ||
    cls === "pill freshness unsettled"
  );
}

export function isBurnClass(cls: string): boolean {
  return cls === "burn" || cls === "burn stale" || cls === "burn incomplete";
}

function cacheFromParts(read: number, input: number, creation: number): { ratio: number; read: number; billed: number } | null {
  const billed = input + read + creation;
  if (!(billed > 0) || !Number.isFinite(read) || !Number.isFinite(billed)) return null;
  const ratio = read / billed;
  if (!Number.isFinite(ratio)) return null;
  return { ratio, read, billed };
}

/** cache_read / (input + cache_read + cache_creation) from the last Result, else live snapshot. */
export function cacheHit(history: unknown, freshness: Freshness, live?: LiveUsage | null): CacheHit {
  const empty = (state: FreshnessState, label: string): CacheHit => ({
    state,
    label,
    ratio: null,
    read: 0,
    billed: 0,
  });
  if (freshness.state === "unsettled") return empty("unsettled", UNSETTLED_LABEL);
  const points = parseUsageHistory(history);
  if (points.length) {
    const last = points[points.length - 1];
    const parts = cacheFromParts(last.cache_read_input_tokens, last.input_tokens, last.cache_creation_input_tokens);
    if (!parts) {
      return empty(
        freshness.state === "stale" ? "stale" : freshness.state === "incomplete" ? "incomplete" : "unsettled",
        freshness.state === "stale" ? STALE_LABEL : freshness.state === "incomplete" ? INCOMPLETE_LABEL : UNSETTLED_LABEL,
      );
    }
    if (freshness.state === "stale") return { state: "stale", label: STALE_LABEL, ...parts };
    if (freshness.state === "incomplete") return { state: "incomplete", label: INCOMPLETE_LABEL, ...parts };
    return { state: "settled", label: SETTLED_LABEL, ...parts };
  }
  if (freshness.state !== "incomplete" || !live || typeof live !== "object") {
    return empty(
      freshness.state === "incomplete" ? "incomplete" : "unsettled",
      freshness.state === "incomplete" ? INCOMPLETE_LABEL : UNSETTLED_LABEL,
    );
  }
  const read = liveFinite(live, "cache_read_input_tokens") ?? 0;
  const input = liveFinite(live, "input_tokens") ?? 0;
  const creation = liveFinite(live, "cache_creation_input_tokens") ?? 0;
  const any =
    liveFinite(live, "cache_read_input_tokens") !== null ||
    liveFinite(live, "input_tokens") !== null ||
    liveFinite(live, "cache_creation_input_tokens") !== null;
  if (!any) return empty("incomplete", INCOMPLETE_LABEL);
  const parts = cacheFromParts(read, input, creation);
  if (!parts) return empty("incomplete", INCOMPLETE_LABEL);
  return { state: "incomplete", label: INCOMPLETE_LABEL, ...parts };
}

export function formatCacheHit(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${Math.round(ratio * 100)}%`;
}

export function cacheMeterClass(state: FreshnessState): string {
  if (state === "stale") return "cache-meter stale";
  if (state === "incomplete") return "cache-meter incomplete";
  if (state === "unsettled") return "cache-meter empty";
  return "cache-meter";
}

export function isCacheMeterClass(cls: string): boolean {
  return (
    cls === "cache-meter" ||
    cls === "cache-meter stale" ||
    cls === "cache-meter incomplete" ||
    cls === "cache-meter empty"
  );
}

export function isSparkClass(cls: string): boolean {
  return cls === "spark" || cls === "spark stale" || cls === "spark incomplete" || cls === "spark empty";
}

export function ownHistoryKeys(p: HistoryPoint): string[] {
  return Object.keys(p).sort();
}

export type PieSlot = 1 | 2 | 3 | "other";

export type PieSlice = {
  key: string;
  label: string;
  cost_usd: number;
  share: number;
  slot: PieSlot;
  className: string;
};

export type ModelCostPie = {
  state: FreshnessState;
  label: string;
  form: "empty" | "tile" | "pie";
  total: number | null;
  slices: PieSlice[];
  paths: { key: string; d: string; className: string }[];
  width: number;
  height: number;
};

export const PIE_W = 72;
export const PIE_H = 72;
export const PIE_R_OUTER = 32;
export const PIE_R_INNER = 18;
export const PIE_GAP_PX = 2;
export const OTHER_LABEL = "其他";

const MODEL_KEY_OK = /^[A-Za-z0-9._:-]{1,64}$/;

export function sanitizeModelKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (SKIP_KEYS.has(raw)) return null;
  if (!MODEL_KEY_OK.test(raw)) return null;
  return raw;
}

export function pieSliceClass(slot: PieSlot): string {
  if (slot === "other") return "pie-slice other";
  if (slot === 2) return "pie-slice s2";
  if (slot === 3) return "pie-slice s3";
  return "pie-slice s1";
}

export function isPieSliceClass(cls: string): boolean {
  return cls === "pie-slice s1" || cls === "pie-slice s2" || cls === "pie-slice s3" || cls === "pie-slice other";
}

export function pieWrapClass(state: FreshnessState): string {
  if (state === "stale") return "pie-wrap stale";
  if (state === "incomplete") return "pie-wrap incomplete";
  if (state === "unsettled") return "pie-wrap empty";
  return "pie-wrap";
}

export function isPieWrapClass(cls: string): boolean {
  return cls === "pie-wrap" || cls === "pie-wrap stale" || cls === "pie-wrap incomplete" || cls === "pie-wrap empty";
}

function freshnessLabel(state: FreshnessState): string {
  if (state === "stale") return STALE_LABEL;
  if (state === "incomplete") return INCOMPLETE_LABEL;
  if (state === "settled") return SETTLED_LABEL;
  return UNSETTLED_LABEL;
}

function emptyPie(state: FreshnessState = "unsettled"): ModelCostPie {
  return {
    state,
    label: freshnessLabel(state),
    form: "empty",
    total: null,
    slices: [],
    paths: [],
    width: PIE_W,
    height: PIE_H,
  };
}

/** Settled model costs only. Never price tokens from a table. */
function parseModelCosts(models: unknown): { key: string; label: string; cost_usd: number }[] {
  if (!Array.isArray(models)) return [];
  const out: { key: string; label: string; cost_usd: number }[] = [];
  for (const item of models) {
    if (!isRecord(item)) continue;
    const key = sanitizeModelKey(item.model);
    if (!key) continue;
    const cost = ownFinite(item, "cost_usd") ?? ownFinite(item, "costUSD");
    if (cost === null || !(cost > 0)) continue;
    out.push({ key, label: key, cost_usd: cost });
  }
  out.sort((a, b) => b.cost_usd - a.cost_usd);
  return out;
}

function polar(cx: number, cy: number, r: number, a: number): { x: number; y: number } {
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function piePaths(slices: PieSlice[]): { key: string; d: string; className: string }[] {
  const cx = PIE_W / 2;
  const cy = PIE_H / 2;
  const gap = PIE_GAP_PX / PIE_R_OUTER;
  let a0 = -Math.PI / 2;
  const out: { key: string; d: string; className: string }[] = [];
  for (const s of slices) {
    const sweep = s.share * Math.PI * 2;
    const start = a0 + gap / 2;
    const end = a0 + sweep - gap / 2;
    a0 += sweep;
    if (!(end > start) || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    const large = end - start > Math.PI ? 1 : 0;
    const o0 = polar(cx, cy, PIE_R_OUTER, start);
    const o1 = polar(cx, cy, PIE_R_OUTER, end);
    const i1 = polar(cx, cy, PIE_R_INNER, end);
    const i0 = polar(cx, cy, PIE_R_INNER, start);
    const d = [
      `M${o0.x.toFixed(2)} ${o0.y.toFixed(2)}`,
      `A${PIE_R_OUTER} ${PIE_R_OUTER} 0 ${large} 1 ${o1.x.toFixed(2)} ${o1.y.toFixed(2)}`,
      `L${i1.x.toFixed(2)} ${i1.y.toFixed(2)}`,
      `A${PIE_R_INNER} ${PIE_R_INNER} 0 ${large} 0 ${i0.x.toFixed(2)} ${i0.y.toFixed(2)}`,
      "Z",
    ].join(" ");
    out.push({ key: s.key, d, className: s.className });
  }
  return out;
}

/** Last settled model_usage costs only. Mid-turn rows stay hidden. */
export function modelCostPie(models: unknown, freshness: Freshness): ModelCostPie {
  if (freshness.state === "unsettled") return emptyPie("unsettled");
  const parsed = parseModelCosts(models);
  if (!parsed.length) {
    return emptyPie(freshness.state === "stale" ? "stale" : freshness.state === "incomplete" ? "incomplete" : "unsettled");
  }
  const named = parsed.slice(0, 3);
  const folded = parsed.slice(3);
  const otherCost = folded.reduce((a, m) => a + m.cost_usd, 0);
  const raw: { key: string; label: string; cost_usd: number; slot: PieSlot }[] = named.map((m, i) => ({
    ...m,
    slot: (i + 1) as 1 | 2 | 3,
  }));
  if (otherCost > 0 && Number.isFinite(otherCost)) {
    raw.push({ key: "other", label: OTHER_LABEL, cost_usd: otherCost, slot: "other" });
  }
  const total = raw.reduce((a, s) => a + s.cost_usd, 0);
  if (!(total > 0) || !Number.isFinite(total)) {
    return emptyPie(freshness.state === "stale" ? "stale" : freshness.state === "incomplete" ? "incomplete" : "unsettled");
  }
  const slices: PieSlice[] = raw.map((s) => ({
    key: s.key,
    label: s.label,
    cost_usd: s.cost_usd,
    share: s.cost_usd / total,
    slot: s.slot,
    className: pieSliceClass(s.slot),
  }));
  const state: FreshnessState =
    freshness.state === "stale" ? "stale" : freshness.state === "incomplete" ? "incomplete" : "settled";
  const label = freshnessLabel(state);
  if (slices.length === 1) {
    return { state, label, form: "tile", total, slices, paths: [], width: PIE_W, height: PIE_H };
  }
  return { state, label, form: "pie", total, slices, paths: piePaths(slices), width: PIE_W, height: PIE_H };
}

export { SKIP_KEYS };
