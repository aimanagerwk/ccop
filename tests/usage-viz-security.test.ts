import { describe, expect, it } from "vitest";
import {
  burnRate,
  cacheHit,
  cacheMeterClass,
  formatBurnRate,
  formatCacheHit,
  freshnessClass,
  isBurnClass,
  isCacheMeterClass,
  isFreshnessClass,
  isPieSliceClass,
  isPieWrapClass,
  isSparkClass,
  modelCostPie,
  parseUsageHistory,
  pieSliceClass,
  pieWrapClass,
  sparkClass,
  tokenSpark,
  usageFreshness,
} from "../web/src/lib/usage-viz.js";

import { buildMonitorSnapshot } from "../web/src/lib/workflow-monitor.js";

describe("usage-viz security", () => {
  it("history parser keeps only the six known keys", () => {
    const dirty = JSON.parse(
      '{"ts":1,"cost_usd":0.1,"input_tokens":2,"output_tokens":3,"cache_read_input_tokens":4,"cache_creation_input_tokens":5,"eval":"no","__proto__":{"hacked":true}}',
    );
    const hist = parseUsageHistory([dirty]);
    expect(Object.keys(hist[0]).sort()).toEqual([
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "cost_usd",
      "input_tokens",
      "output_tokens",
      "ts",
    ]);
    expect((hist[0] as { eval?: string }).eval).toBeUndefined();
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it("does not treat inherited proto fields as token totals", () => {
    (Object.prototype as { input_tokens?: number }).input_tokens = 999999;
    try {
      const hist = parseUsageHistory([{ ts: 1, output_tokens: 3 }]);
      expect(hist[0].input_tokens).toBe(0);
      const spark = tokenSpark(hist, usageFreshness({ usage_updated_ts: 1, last_kind: "turn_done" }));
      expect(spark.headline).toBe(3);
    } finally {
      delete (Object.prototype as { input_tokens?: unknown }).input_tokens;
    }
  });

  it("spark SVG class stays on the allowlist", () => {
    expect(isSparkClass(sparkClass("settled"))).toBe(true);
    expect(isSparkClass(sparkClass("stale"))).toBe(true);
    expect(isSparkClass(sparkClass("unsettled"))).toBe(true);
    expect(isSparkClass("spark onerror=alert(1)")).toBe(false);
  });

  it("spark path is numeric SVG commands only", () => {
    const spark = tokenSpark(
      [
        { ts: 1, cost_usd: 0.1, input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        { ts: 2, cost_usd: 0.2, input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ],
      usageFreshness({ usage_updated_ts: 2, last_kind: "turn_done" }),
    );
    expect(spark.path).toMatch(/^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
    expect(spark.path).not.toMatch(/<|>|javascript:/i);
  });

  it("snapshot spark ignores a polluted usage_history row", () => {
    const snap = buildMonitorSnapshot({
      session: { id: "s1", name: "n", title: null, pending: [], last_turn: null, last_task: null, last_kind: "turn_done" },
      info: {
        usage_updated_ts: 1,
        usage_history: [
          JSON.parse('{"ts":1,"input_tokens":4,"output_tokens":1,"constructor":{"name":"hack"},"__proto__":{"x":1}}'),
        ],
      },
    });
    expect(snap.spark.headline).toBe(5);
    expect(Object.keys(snap.usage_history[0]).includes("constructor")).toBe(false);
    expect(({} as { x?: number }).x).toBeUndefined();
  });

  it("burn rate ignores inherited cost and extra keys", () => {
    (Object.prototype as { cost_usd?: number }).cost_usd = 999;
    try {
      const dirty = JSON.parse(
        '{"ts":10,"input_tokens":1,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"eval":"no"}',
      );
      const later = JSON.parse(
        '{"ts":20,"cost_usd":0.2,"input_tokens":2,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"__proto__":{"hacked":true}}',
      );
      const rate = burnRate([dirty, later], usageFreshness({ usage_updated_ts: 20, last_kind: "turn_done" }));
      expect(rate.usd_per_min).toBeCloseTo(((0.2 - 0) / 10) * 60, 8);
      expect(rate.usd_per_min).not.toBeCloseTo(((0.2 - 999) / 10) * 60, 4);
      expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
    } finally {
      delete (Object.prototype as { cost_usd?: unknown }).cost_usd;
    }
  });

  it("non-finite Δt or cost never becomes a number the UI can print", () => {
    const settled = usageFreshness({ usage_updated_ts: 2, last_kind: "turn_done" });
    const inf = burnRate(
      [
        { ts: 1, cost_usd: 0.1, input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        { ts: Number.POSITIVE_INFINITY, cost_usd: 0.2, input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ],
      settled,
    );
    expect(inf.usd_per_min).toBeNull();
    expect(formatBurnRate(inf.usd_per_min)).toBe("—");
    expect(formatBurnRate(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatBurnRate(Number.NEGATIVE_INFINITY)).toBe("—");
    expect(formatBurnRate(1.5)).not.toMatch(/<|>|javascript:/i);
  });

  it("freshness / burn class names stay on the allowlist", () => {
    expect(isFreshnessClass(freshnessClass("settled"))).toBe(true);
    expect(isFreshnessClass(freshnessClass("stale"))).toBe(true);
    expect(isFreshnessClass(freshnessClass("unsettled"))).toBe(true);
    expect(isFreshnessClass("pill freshness settled onerror=alert(1)")).toBe(false);
    expect(isBurnClass("burn")).toBe(true);
    expect(isBurnClass("burn stale")).toBe(true);
    expect(isBurnClass("burn stale onclick=alert(1)")).toBe(false);
  });

  it("freshness ignores a polluted last_kind / non-own timestamp", () => {
    const snap = buildMonitorSnapshot({
      session: {
        id: "s1",
        name: "n",
        title: null,
        pending: [],
        last_turn: null,
        last_task: null,
        last_kind: "<script>working</script>",
      },
      info: { usage_updated_ts: Number.NaN },
    });
    expect(snap.freshness.state).toBe("unsettled");
    expect(snap.freshness.label).toBe("尚未结算");
    expect(snap.freshness.label).not.toMatch(/<|>|script/i);
    expect(freshnessClass(snap.freshness.state)).not.toMatch(/<|>|javascript:/i);
  });

  it("cache hit ignores inherited cache_read and extra keys", () => {
    (Object.prototype as { cache_read_input_tokens?: number }).cache_read_input_tokens = 999999;
    try {
      const dirty = JSON.parse(
        '{"ts":1,"input_tokens":10,"output_tokens":0,"cache_creation_input_tokens":0,"eval":"no","__proto__":{"hacked":true}}',
      );
      const hit = cacheHit([dirty], usageFreshness({ usage_updated_ts: 1, last_kind: "turn_done" }));
      expect(hit.read).toBe(0);
      expect(hit.ratio).toBe(0);
      expect(hit.ratio).not.toBeCloseTo(999999 / (10 + 999999), 4);
      expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
    } finally {
      delete (Object.prototype as { cache_read_input_tokens?: unknown }).cache_read_input_tokens;
    }
  });

  it("cache meter class stays on the allowlist and format never emits markup", () => {
    expect(isCacheMeterClass(cacheMeterClass("settled"))).toBe(true);
    expect(isCacheMeterClass(cacheMeterClass("stale"))).toBe(true);
    expect(isCacheMeterClass(cacheMeterClass("unsettled"))).toBe(true);
    expect(isCacheMeterClass("cache-meter onerror=alert(1)")).toBe(false);
    expect(formatCacheHit(0.5)).toBe("50%");
    expect(formatCacheHit(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatCacheHit(Number.NaN)).toBe("—");
  });

  it("pie ignores inherited cost and proto model names", () => {
    (Object.prototype as { cost_usd?: number }).cost_usd = 999;
    try {
      const pie = modelCostPie(
        [
          JSON.parse('{"model":"claude-opus-4-6","input":10,"eval":"no"}'),
          JSON.parse('{"model":"__proto__","cost_usd":4}'),
          JSON.parse('{"model":"constructor","cost_usd":3}'),
          JSON.parse('{"model":"<script>x</script>","cost_usd":2}'),
        ],
        usageFreshness({ usage_updated_ts: 1, last_kind: "turn_done" }),
      );
      expect(pie.form).toBe("empty");
      expect(pie.slices).toEqual([]);
      expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
    } finally {
      delete (Object.prototype as { cost_usd?: unknown }).cost_usd;
    }
  });

  it("pie class names stay on the allowlist and paths stay numeric", () => {
    expect(isPieSliceClass(pieSliceClass(1))).toBe(true);
    expect(isPieSliceClass(pieSliceClass(2))).toBe(true);
    expect(isPieSliceClass(pieSliceClass(3))).toBe(true);
    expect(isPieSliceClass(pieSliceClass("other"))).toBe(true);
    expect(isPieSliceClass("pie-slice s1 onerror=alert(1)")).toBe(false);
    expect(isPieWrapClass(pieWrapClass("settled"))).toBe(true);
    expect(isPieWrapClass(pieWrapClass("stale"))).toBe(true);
    expect(isPieWrapClass(pieWrapClass("unsettled"))).toBe(true);
    expect(isPieWrapClass("pie-wrap onclick=alert(1)")).toBe(false);
    const pie = modelCostPie(
      [
        { model: "claude-opus-4-6", cost_usd: 0.4 },
        { model: "claude-sonnet-4-6", cost_usd: 0.2 },
      ],
      usageFreshness({ usage_updated_ts: 1, last_kind: "turn_done" }),
    );
    expect(pie.paths.length).toBeGreaterThan(0);
    for (const p of pie.paths) {
      expect(p.d).toMatch(/^[MLAZ0-9.\s-]+$/i);
      expect(p.d).not.toMatch(/<|>|javascript:/i);
      expect(isPieSliceClass(p.className)).toBe(true);
    }
    expect(pie.slices[0].label).not.toMatch(/<|>|script/i);
  });

  it("snapshot pie skips a polluted model_usage key", () => {
    const snap = buildMonitorSnapshot({
      session: { id: "s1", name: "n", title: null, pending: [], last_turn: null, last_task: null, last_kind: "turn_done" },
      info: {
        usage_updated_ts: 1,
        model_usage: JSON.parse(
          '{"claude-opus-4-6":{"cost_usd":0.3},"__proto__":{"cost_usd":9},"constructor":{"cost_usd":8}}',
        ),
      },
    });
    expect(snap.pie.form).toBe("tile");
    expect(snap.pie.slices.map((s) => s.key)).toEqual(["claude-opus-4-6"]);
    expect(snap.models.every((m) => m.model !== "__proto__" && m.model !== "constructor")).toBe(true);
  });
});
