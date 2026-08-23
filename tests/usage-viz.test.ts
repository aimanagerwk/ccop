import { describe, expect, it } from "vitest";
import {
  burnRate,
  cacheHit,
  formatBurnRate,
  formatCacheHit,
  modelCostPie,
  parseUsageHistory,
  sparkLayout,
  tokenSpark,
  usageFreshness,
  UNSETTLED_LABEL,
  STALE_LABEL,
  SETTLED_LABEL,
  INCOMPLETE_LABEL,
  OTHER_LABEL,
} from "../web/src/lib/usage-viz.js";

import { buildMonitorSnapshot } from "../web/src/lib/workflow-monitor.js";

const a = {
  ts: 10,
  cost_usd: 0.12,
  input_tokens: 150,
  output_tokens: 28,
  cache_read_input_tokens: 6,
  cache_creation_input_tokens: 3,
};
const b = {
  ts: 20,
  cost_usd: 0.4,
  input_tokens: 400,
  output_tokens: 80,
  cache_read_input_tokens: 10,
  cache_creation_input_tokens: 6,
};

describe("usageFreshness", () => {
  it("is unsettled when there is no Result timestamp", () => {
    expect(usageFreshness({ usage_updated_ts: null, last_kind: "working" })).toEqual({
      state: "unsettled",
      label: UNSETTLED_LABEL,
      updated_ts: null,
    });
    expect(usageFreshness({ last_kind: "turn_done" }).state).toBe("unsettled");
    expect(usageFreshness({ usage_updated_ts: Number.NaN, last_kind: "idle" }).state).toBe("unsettled");
    expect(usageFreshness({ usage_updated_ts: Number.POSITIVE_INFINITY }).state).toBe("unsettled");
  });

  it("is stale as soon as the next turn starts", () => {
    expect(usageFreshness({ usage_updated_ts: 10, last_kind: "working" }).label).toBe(STALE_LABEL);
    expect(usageFreshness({ usage_updated_ts: 10, last_kind: "sent" }).state).toBe("stale");
    expect(usageFreshness({ usage_updated_ts: 10, last_kind: "needs_decision" }).state).toBe("stale");
    expect(usageFreshness({ usage_updated_ts: 10, last_kind: "needs_info" }).state).toBe("stale");
    expect(usageFreshness({ usage_updated_ts: 10, last_kind: "held" }).state).toBe("stale");
    expect(usageFreshness({ usage_updated_ts: 10, last_kind: "interrupted" }).state).toBe("stale");
  });

  it("is settled on turn_done / idle / dead — never a clock-age guess", () => {
    expect(usageFreshness({ usage_updated_ts: 10, last_kind: "turn_done" })).toMatchObject({
      state: "settled",
      label: SETTLED_LABEL,
    });
    expect(usageFreshness({ usage_updated_ts: 10, last_kind: "idle" }).state).toBe("settled");
    expect(usageFreshness({ usage_updated_ts: 10, last_kind: "dead" }).state).toBe("settled");
    expect(usageFreshness({ usage_updated_ts: 10, last_kind: "task_done" }).state).toBe("settled");
    expect(usageFreshness({ usage_updated_ts: 1, last_kind: "idle" }).state).toBe("settled");
  });

  it("does not treat a mid-turn kind without a Result as stale — that is 尚未结算", () => {
    expect(usageFreshness({ usage_updated_ts: null, last_kind: "working" }).label).toBe(UNSETTLED_LABEL);
    expect(usageFreshness({ usage_updated_ts: null, last_kind: "sent" }).state).toBe("unsettled");
  });

  it("is 缺数据 when live numbers exist but there is no Result timestamp", () => {
    expect(usageFreshness({ usage_updated_ts: null, last_kind: "working", has_snapshot: true })).toEqual({
      state: "incomplete",
      label: INCOMPLETE_LABEL,
      updated_ts: null,
    });
    expect(usageFreshness({ last_kind: "idle", has_snapshot: true }).state).toBe("incomplete");
    expect(usageFreshness({ usage_updated_ts: null, has_snapshot: false }).state).toBe("unsettled");
  });
});

describe("tokenSpark", () => {
  it("does not draw a line for a single settled point", () => {
    const spark = tokenSpark([a], usageFreshness({ usage_updated_ts: 10, last_kind: "turn_done" }));
    expect(spark.headline).toBe(187);
    expect(spark.points).toHaveLength(1);
    expect(spark.path).toBeNull();
    expect(spark.last).not.toBeNull();
    expect(spark.label).toBe(SETTLED_LABEL);
  });

  it("draws only settled Result points and keeps the latest headline", () => {
    const spark = tokenSpark([a, b], usageFreshness({ usage_updated_ts: 20, last_kind: "turn_done" }));
    expect(spark.headline).toBe(496);
    expect(spark.points.map((p) => p.tokens)).toEqual([187, 496]);
    expect(spark.path).toMatch(/^M/);
    expect(spark.path).toContain(" L");
  });

  it("keeps the last settled spark when the current turn is stale — no mid-turn point", () => {
    const spark = tokenSpark([a], usageFreshness({ usage_updated_ts: 10, last_kind: "working" }));
    expect(spark.state).toBe("stale");
    expect(spark.label).toBe(STALE_LABEL);
    expect(spark.headline).toBe(187);
    expect(spark.points).toHaveLength(1);
    expect(spark.path).toBeNull();
  });

  it("is unsettled with no history — no invented slope", () => {
    const spark = tokenSpark([], usageFreshness({ usage_updated_ts: null }));
    expect(spark.headline).toBeNull();
    expect(spark.points).toEqual([]);
    expect(spark.path).toBeNull();
    expect(spark.last).toBeNull();
    expect(spark.label).toBe(UNSETTLED_LABEL);
  });

  it("uses live status/info tokens as a one-point headline when history is missing", () => {
    const spark = tokenSpark(
      [],
      usageFreshness({ usage_updated_ts: null, has_snapshot: true }),
      undefined,
      { input_tokens: 46542, output_tokens: 1490, cache_read_input_tokens: 256, cache_creation_input_tokens: 0 },
    );
    expect(spark.state).toBe("incomplete");
    expect(spark.label).toBe(INCOMPLETE_LABEL);
    expect(spark.headline).toBe(46542 + 1490 + 256);
    expect(spark.points).toHaveLength(1);
    expect(spark.path).toBeNull();
    expect(spark.last).not.toBeNull();
  });

  it("does not treat assistant-shaped junk as a history point", () => {
    expect(parseUsageHistory([{ input_tokens: 64038, output_tokens: 2201 }])).toEqual([]);
    expect(parseUsageHistory({ type: "assistant", usage: { input_tokens: 9 } })).toEqual([]);
  });
});

describe("sparkLayout", () => {
  it("returns no path for 0–1 points", () => {
    expect(sparkLayout([]).path).toBeNull();
    expect(sparkLayout([{ ts: 1, tokens: 10 }]).path).toBeNull();
    expect(sparkLayout([{ ts: 1, tokens: 10 }]).last).not.toBeNull();
  });
});

describe("burnRate", () => {
  const settled = usageFreshness({ usage_updated_ts: 20, last_kind: "turn_done" });
  const stale = usageFreshness({ usage_updated_ts: 20, last_kind: "working" });

  it("needs two settled points — one point is 尚未结算", () => {
    const rate = burnRate([a], settled);
    expect(rate.state).toBe("unsettled");
    expect(rate.label).toBe(UNSETTLED_LABEL);
    expect(rate.usd_per_min).toBeNull();
  });

  it("is the adjacent Δcost / Δt, not a wall-clock slope", () => {
    const rate = burnRate([a, b], settled);
    expect(rate.state).toBe("settled");
    expect(rate.label).toBe(SETTLED_LABEL);
    expect(rate.usd_per_min).toBeCloseTo(((0.4 - 0.12) / 10) * 60, 8);
    expect(rate.usd_per_min).not.toBeCloseTo(0.4 / (Date.now() / 1000), 4);
  });

  it("keeps the last settled slope when the current turn is stale", () => {
    const rate = burnRate([a, b], stale);
    expect(rate.state).toBe("stale");
    expect(rate.label).toBe(STALE_LABEL);
    expect(rate.usd_per_min).toBeCloseTo(((0.4 - 0.12) / 10) * 60, 8);
  });

  it("does not invent a rate from empty history or a zero Δt", () => {
    expect(burnRate([], settled).usd_per_min).toBeNull();
    expect(burnRate([], settled).label).toBe(UNSETTLED_LABEL);
    const incomplete = usageFreshness({ usage_updated_ts: null, has_snapshot: true });
    expect(burnRate([], incomplete).usd_per_min).toBeNull();
    expect(burnRate([], incomplete).label).toBe(INCOMPLETE_LABEL);
    expect(burnRate([], incomplete).state).toBe("incomplete");
    const sameTs = [
      { ...a, ts: 10 },
      { ...b, ts: 10 },
    ];
    expect(burnRate(sameTs, settled).usd_per_min).toBeNull();
    expect(burnRate(sameTs, settled).label).toBe(UNSETTLED_LABEL);
  });

  it("uses only the last two Result points, never a mid-turn cost", () => {
    const c = { ...b, ts: 40, cost_usd: 0.7 };
    const rate = burnRate([a, b, c], settled);
    expect(rate.usd_per_min).toBeCloseTo(((0.7 - 0.4) / 20) * 60, 8);
    expect(rate.usd_per_min).not.toBeCloseTo(((0.7 - 0.12) / 30) * 60, 8);
  });

  it("formats $/min without inventing a number", () => {
    expect(formatBurnRate(null)).toBe("—");
    expect(formatBurnRate(undefined)).toBe("—");
    expect(formatBurnRate(Number.NaN)).toBe("—");
    expect(formatBurnRate(1.68)).toBe("$1.68/分");
    expect(formatBurnRate(0.0012)).toBe("$0.0012/分");
  });
});

describe("cacheHit", () => {
  const settled = usageFreshness({ usage_updated_ts: 20, last_kind: "turn_done" });
  const stale = usageFreshness({ usage_updated_ts: 20, last_kind: "working" });

  it("is 尚未结算 with no Result history", () => {
    const hit = cacheHit([], settled);
    expect(hit.ratio).toBeNull();
    expect(hit.label).toBe(UNSETTLED_LABEL);
    expect(formatCacheHit(hit.ratio)).toBe("—");
  });

  it("uses only the last settled point: cache_read / billed input", () => {
    const hit = cacheHit([a, b], settled);
    expect(hit.state).toBe("settled");
    expect(hit.read).toBe(10);
    expect(hit.billed).toBe(400 + 10 + 6);
    expect(hit.ratio).toBeCloseTo(10 / 416, 8);
    expect(hit.ratio).not.toBeCloseTo(6 / 187, 4);
    expect(formatCacheHit(hit.ratio)).toBe(`${Math.round((10 / 416) * 100)}%`);
  });

  it("keeps the last settled ratio when the current turn is stale", () => {
    const hit = cacheHit([b], stale);
    expect(hit.state).toBe("stale");
    expect(hit.label).toBe(STALE_LABEL);
    expect(hit.ratio).toBeCloseTo(10 / 416, 8);
  });

  it("does not invent a hit rate from mid-turn session tokens", () => {
    expect(cacheHit(undefined, usageFreshness({ usage_updated_ts: null, last_kind: "working" })).ratio).toBeNull();
    const zero = cacheHit(
      [{ ...a, input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
      settled,
    );
    expect(zero.ratio).toBeNull();
  });

  it("uses live billed tokens when history is missing and marks 缺数据", () => {
    const hit = cacheHit(
      [],
      usageFreshness({ usage_updated_ts: null, has_snapshot: true }),
      { input_tokens: 46542, cache_read_input_tokens: 256, cache_creation_input_tokens: 0 },
    );
    expect(hit.state).toBe("incomplete");
    expect(hit.label).toBe(INCOMPLETE_LABEL);
    expect(hit.ratio).toBeCloseTo(256 / (46542 + 256 + 0), 8);
  });
});

describe("modelCostPie", () => {
  const settled = usageFreshness({ usage_updated_ts: 20, last_kind: "turn_done" });
  const stale = usageFreshness({ usage_updated_ts: 20, last_kind: "working" });
  const m1 = { model: "claude-opus-4-6", cost_usd: 0.4 };
  const m2 = { model: "claude-sonnet-4-6", cost_usd: 0.2 };
  const m3 = { model: "claude-haiku-4-5", cost_usd: 0.1 };

  it("is empty when there are no models or freshness is unsettled", () => {
    const empty = modelCostPie([], settled);
    expect(empty.form).toBe("empty");
    expect(empty.total).toBeNull();
    expect(empty.label).toBe(UNSETTLED_LABEL);
    expect(empty.slices).toEqual([]);
    const mid = modelCostPie([m1, m2], usageFreshness({ usage_updated_ts: null, last_kind: "working" }));
    expect(mid.form).toBe("empty");
    expect(mid.slices).toEqual([]);
    expect(mid.label).toBe(UNSETTLED_LABEL);
    const live = modelCostPie([m1, m2], usageFreshness({ usage_updated_ts: null, has_snapshot: true }));
    expect(live.form).toBe("pie");
    expect(live.state).toBe("incomplete");
    expect(live.label).toBe(INCOMPLETE_LABEL);
    expect(live.slices).toHaveLength(2);
  });

  it("is a tile for a single settled model — no pie path", () => {
    const pie = modelCostPie([m1], settled);
    expect(pie.form).toBe("tile");
    expect(pie.paths).toEqual([]);
    expect(pie.slices).toHaveLength(1);
    expect(pie.slices[0].cost_usd).toBe(0.4);
    expect(pie.slices[0].slot).toBe(1);
    expect(pie.total).toBe(0.4);
    expect(pie.label).toBe(SETTLED_LABEL);
  });

  it("draws 2–3 slices in fixed series slots", () => {
    const pie = modelCostPie([m3, m1, m2], settled);
    expect(pie.form).toBe("pie");
    expect(pie.slices.map((s) => s.key)).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
    expect(pie.slices.map((s) => s.slot)).toEqual([1, 2, 3]);
    expect(pie.slices.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 8);
    expect(pie.paths).toHaveLength(3);
    expect(pie.paths.every((p) => /^[MLAZ0-9.\s-]+$/i.test(p.d))).toBe(true);
  });

  it("folds the 4th+ models into 其他 by cost", () => {
    const pie = modelCostPie(
      [m1, m2, m3, { model: "claude-sonnet-4-5", cost_usd: 0.05 }, { model: "other-model", cost_usd: 0.02 }],
      settled,
    );
    expect(pie.slices).toHaveLength(4);
    expect(pie.slices[3].key).toBe("other");
    expect(pie.slices[3].label).toBe(OTHER_LABEL);
    expect(pie.slices[3].slot).toBe("other");
    expect(pie.slices[3].cost_usd).toBeCloseTo(0.07, 8);
    expect(pie.slices.slice(0, 3).map((s) => s.cost_usd)).toEqual([0.4, 0.2, 0.1]);
    expect(pie.paths).toHaveLength(4);
  });

  it("skips non-finite or non-positive cost and never prices tokens", () => {
    const pie = modelCostPie(
      [
        { model: "bad", cost_usd: Number.NaN },
        { model: "zero", cost_usd: 0 },
        { model: "neg", cost_usd: -1 },
        { model: "tokens-only", input: 9_000_000, output: 1000 },
        m2,
      ],
      settled,
    );
    expect(pie.form).toBe("tile");
    expect(pie.slices).toHaveLength(1);
    expect(pie.slices[0].key).toBe("claude-sonnet-4-6");
    expect(pie.total).toBe(0.2);
  });

  it("keeps last slices when the current turn is stale", () => {
    const pie = modelCostPie([m1, m2], stale);
    expect(pie.state).toBe("stale");
    expect(pie.label).toBe(STALE_LABEL);
    expect(pie.form).toBe("pie");
    expect(pie.slices).toHaveLength(2);
    expect(pie.total).toBeCloseTo(0.6, 8);
  });
});

describe("snapshot spark", () => {
  it("leaves spark empty when info has no usage_history and no live numbers", () => {
    const snap = buildMonitorSnapshot({
      session: { id: "s1", name: "n", title: null, pending: [], last_turn: null, last_task: null },
    });
    expect(snap.spark.headline).toBeNull();
    expect(snap.spark.label).toBe(UNSETTLED_LABEL);
    expect(snap.usage_history).toEqual([]);
    expect(snap.burn.usd_per_min).toBeNull();
    expect(snap.burn.label).toBe(UNSETTLED_LABEL);
    expect(snap.cache.ratio).toBeNull();
    expect(snap.cache.label).toBe(UNSETTLED_LABEL);
    expect(snap.pie.form).toBe("empty");
    expect(snap.pie.label).toBe(UNSETTLED_LABEL);
  });

  it("draws live status/info numbers and labels 缺数据 when history/ts are missing", () => {
    const snap = buildMonitorSnapshot({
      session: {
        id: "s1",
        name: "n",
        title: null,
        pending: [],
        last_turn: null,
        last_task: null,
        last_kind: "working",
        cost_usd: 0.27,
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 0,
      },
      info: {
        cost_usd: 0.27,
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 0,
        model_usage: { "claude-opus-4-6": { cost_usd: 0.27 } },
      },
    });
    expect(snap.freshness.state).toBe("incomplete");
    expect(snap.freshness.label).toBe(INCOMPLETE_LABEL);
    expect(snap.freshness.updated_ts).toBeNull();
    expect(snap.spark.headline).toBe(130);
    expect(snap.spark.path).toBeNull();
    expect(snap.spark.label).toBe(INCOMPLETE_LABEL);
    expect(snap.burn.usd_per_min).toBeNull();
    expect(snap.burn.label).toBe(INCOMPLETE_LABEL);
    expect(snap.cache.ratio).toBeCloseTo(10 / 110, 8);
    expect(snap.cache.label).toBe(INCOMPLETE_LABEL);
    expect(snap.pie.form).toBe("tile");
    expect(snap.pie.state).toBe("incomplete");
    expect(snap.pie.label).toBe(INCOMPLETE_LABEL);
  });

  it("does not pull mid-turn task tokens into the spark", () => {
    const snap = buildMonitorSnapshot({
      session: {
        id: "s1",
        name: "n",
        title: null,
        pending: [],
        last_turn: null,
        last_task: null,
        last_kind: "working",
      },
      tasks: { tasks: [{ task_id: "t1", status: "running", usage: { total_tokens: 13828 } }] },
    });
    expect(snap.spark.headline).toBeNull();
    expect(snap.tokens.input_tokens).toBeNull();
    expect(snap.freshness.state).toBe("unsettled");
    expect(snap.freshness.label).toBe(UNSETTLED_LABEL);
  });

  it("snapshot freshness is stale when a prior Result exists and a new turn is open", () => {
    const snap = buildMonitorSnapshot({
      session: {
        id: "s1",
        name: "n",
        title: null,
        pending: [],
        last_turn: null,
        last_task: null,
        last_kind: "working",
        usage_updated_ts: 10,
      },
      info: { usage_updated_ts: 10, usage_history: [a] },
    });
    expect(snap.freshness.state).toBe("stale");
    expect(snap.freshness.label).toBe(STALE_LABEL);
    expect(snap.freshness.updated_ts).toBe(10);
  });
});
