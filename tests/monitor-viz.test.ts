import { describe, expect, it } from "vitest";
import {
  formatClock,
  progressShares,
  sessionKindLabel,
  tokenShares,
} from "../web/src/lib/workflow-monitor.js";

describe("progressShares", () => {
  it("emits only positive segments in fixed order", () => {
    expect(
      progressShares({ total: 4, running: 2, done: 1, failed: 1, agents_running: 0, agents_total: 0 }),
    ).toEqual([
      { key: "running", label: "进行中", n: 2 },
      { key: "done", label: "已完成", n: 1 },
      { key: "failed", label: "失败", n: 1 },
    ]);
  });

  it("drops zeros and clamps negatives", () => {
    expect(
      progressShares({ total: 1, running: 0, done: 1, failed: 0, agents_running: 0, agents_total: 0 }),
    ).toEqual([{ key: "done", label: "已完成", n: 1 }]);
    expect(
      progressShares({ total: 0, running: -3, done: 0, failed: 0, agents_running: 0, agents_total: 0 }),
    ).toEqual([]);
  });
});

describe("tokenShares", () => {
  it("keeps the four observed usage fields, skipping null/zero", () => {
    expect(
      tokenShares({
        input_tokens: 46542,
        output_tokens: 1490,
        cache_read_input_tokens: 256,
        cache_creation_input_tokens: 0,
        cost_usd: 0.27,
      }),
    ).toEqual([
      { key: "input", label: "输入", n: 46542 },
      { key: "output", label: "输出", n: 1490 },
      { key: "cache_read", label: "缓存读", n: 256 },
    ]);
  });

  it("returns empty when every field is missing", () => {
    expect(
      tokenShares({
        input_tokens: null,
        output_tokens: null,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        cost_usd: null,
      }),
    ).toEqual([]);
  });

  it("does not invent a context window or a fourth hue past cache_creation", () => {
    const shares = tokenShares({
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
      cost_usd: 1,
    });
    expect(shares.map((s) => s.key)).toEqual(["input", "output", "cache_read", "cache_creation"]);
    expect(shares.every((s) => s.n > 0)).toBe(true);
  });
});

describe("sessionKindLabel / formatClock", () => {
  it("labels only protocol kinds", () => {
    expect(sessionKindLabel("working")).toBe("工作中");
    expect(sessionKindLabel("needs_decision")).toBe("待决定");
    expect(sessionKindLabel("dead")).toBe("已结束");
    expect(sessionKindLabel("not-a-kind")).toBe("not-a-kind");
  });

  it("formats epoch seconds as a clock and rejects junk", () => {
    expect(formatClock(undefined)).toBe("—");
    expect(formatClock(Number.NaN)).toBe("—");
    const label = formatClock(1_787_403_750.285);
    expect(label).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
