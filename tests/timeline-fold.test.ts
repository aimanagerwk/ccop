import { describe, expect, it } from "vitest";
import { foldTranscript, type FoldEvent, type FoldedRow } from "../web/src/lib/fold-transcript.js";
import {
  dayBreaks,
  formatDateTimeAttr,
  formatDayLabel,
  toEpochMs,
} from "../web/src/lib/format-ts.js";
import { sharePercents, tokenBarShares } from "../web/src/lib/workflow-monitor.js";

function ev(partial: Partial<FoldEvent> & { kind: string; summary: string }): FoldEvent {
  return { extra: {}, ...partial };
}

describe("foldTranscript timestamps", () => {
  it("copies finite ts onto user / assistant / tool / status rows", () => {
    const rows = foldTranscript([
      ev({ kind: "sent", summary: "你好", ts: 10.5 }),
      ev({
        kind: "working",
        summary: "tool Read",
        extra: { tool: "Read", input: { file_path: "/a/b.ts" } },
        ts: 11,
      }),
      ev({ kind: "turn_done", summary: "result message (turn, not task)", extra: { result: "ok" }, ts: 12 }),
      ev({ kind: "needs_decision", summary: "ask", extra: { reason: "ask" }, ts: 13 }),
    ]);
    expect(rows).toEqual([
      { type: "user", text: "你好", ts: 10.5 },
      { type: "tool", name: "Read", detail: "b.ts", input: { file_path: "/a/b.ts" }, ts: 11 },
      { type: "assistant", text: "ok", ts: 12 },
      { type: "needs_decision", text: "需要批准", ts: 13 },
    ]);
  });

  it("uses the first tick ts for a folded thinking group", () => {
    const rows = foldTranscript([
      ev({ kind: "working", summary: "thinking_tokens", ts: 20 }),
      ev({ kind: "working", summary: "thinking_tokens", ts: 21 }),
    ]);
    expect(rows).toEqual([{ type: "thinking", n: 2, ts: 20 }]);
  });

  it("does not invent ts when the event has none", () => {
    expect(foldTranscript([ev({ kind: "sent", summary: "x" })])).toEqual([{ type: "user", text: "x" }]);
  });
});

describe("format-ts", () => {
  const localNoon = (y: number, m: number, d: number): number =>
    new Date(y, m, d, 12, 0, 0).getTime() / 1000;

  it("toEpochMs treats values above 1e12 as milliseconds", () => {
    const ms = 1_787_403_750_285;
    expect(toEpochMs(ms)).toBe(ms);
    expect(toEpochMs(1_787_403_750.285)).toBeCloseTo(1_787_403_750.285 * 1000);
    expect(toEpochMs(1e12)).toBe(1e12 * 1000);
  });

  it("toEpochMs returns undefined for NaN Infinity and non-numbers", () => {
    expect(toEpochMs(Number.NaN)).toBeUndefined();
    expect(toEpochMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(toEpochMs(Number.NEGATIVE_INFINITY)).toBeUndefined();
    expect(toEpochMs(undefined)).toBeUndefined();
    expect(toEpochMs("1787403750" as unknown as number)).toBeUndefined();
    expect(toEpochMs(null as unknown as number)).toBeUndefined();
    expect(toEpochMs(Number.MAX_VALUE)).toBeUndefined();
  });

  it("formatDateTimeAttr returns ISO for finite epoch seconds", () => {
    const ts = 1_787_403_750.285;
    const iso = formatDateTimeAttr(ts);
    expect(iso).toBe(new Date(ts * 1000).toISOString());
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("formatDateTimeAttr returns undefined for missing or non-finite ts", () => {
    expect(formatDateTimeAttr()).toBeUndefined();
    expect(formatDateTimeAttr(undefined)).toBeUndefined();
    expect(formatDateTimeAttr(Number.NaN)).toBeUndefined();
    expect(formatDateTimeAttr(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(formatDateTimeAttr(Number.NEGATIVE_INFINITY)).toBeUndefined();
  });

  it("formatDayLabel returns local YYYY-MM-DD and does not invent on missing ts", () => {
    const ts = localNoon(2026, 7, 23);
    expect(formatDayLabel(ts)).toBe("2026-08-23");
    expect(formatDayLabel()).toBeUndefined();
    expect(formatDayLabel(Number.NaN)).toBeUndefined();
  });

  it("dayBreaks marks the first row of a new local day", () => {
    const rows: FoldedRow[] = [
      { type: "user", text: "a", ts: localNoon(2026, 7, 22) },
      { type: "assistant", text: "b", ts: localNoon(2026, 7, 22) },
      { type: "user", text: "c", ts: localNoon(2026, 7, 23) },
    ];
    expect(dayBreaks(rows)).toEqual([
      { index: 0, label: "2026-08-22", dayKey: "2026-08-22" },
      { index: 2, label: "2026-08-23", dayKey: "2026-08-23" },
    ]);
  });

  it("dayBreaks skips rows without ts and does not invent a day", () => {
    const day1 = localNoon(2026, 7, 22);
    const day2 = localNoon(2026, 7, 23);
    const rows: FoldedRow[] = [
      { type: "user", text: "no-ts" },
      { type: "user", text: "first", ts: day1 },
      { type: "assistant", text: "gap" },
      { type: "user", text: "same", ts: day1 },
      { type: "user", text: "next", ts: day2 },
    ];
    expect(dayBreaks(rows)).toEqual([
      { index: 1, label: "2026-08-22", dayKey: "2026-08-22" },
      { index: 4, label: "2026-08-23", dayKey: "2026-08-23" },
    ]);
  });

  it("dayBreaks does not mutate input", () => {
    const rows: FoldedRow[] = [
      { type: "user", text: "a", ts: localNoon(2026, 7, 22) },
      { type: "user", text: "b", ts: localNoon(2026, 7, 23) },
    ];
    const snapshot = structuredClone(rows);
    Object.freeze(rows);
    Object.freeze(rows[0]);
    Object.freeze(rows[1]);
    const marks = dayBreaks(rows);
    expect(marks).toHaveLength(2);
    expect(rows).toEqual(snapshot);
    expect(rows[0]).toBe(snapshot[0] ? rows[0] : rows[0]);
    expect(Object.isFrozen(rows)).toBe(true);
  });
});

describe("sharePercents / tokenBarShares", () => {
  it("normalizes to 100 without a fourth hue", () => {
    const segs = sharePercents([
      { key: "input", label: "输入", n: 80 },
      { key: "output", label: "输出", n: 20 },
    ]);
    expect(segs.map((s) => s.pct)).toEqual([80, 20]);
    expect(sharePercents([])).toEqual([]);
    expect(sharePercents([{ key: "x", label: "x", n: 0 }])).toEqual([]);
  });

  it("merges cache read+write into one bar series", () => {
    expect(
      tokenBarShares({
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
        cost_usd: 0.1,
      }),
    ).toEqual([
      { key: "input", label: "输入", n: 10 },
      { key: "output", label: "输出", n: 4 },
      { key: "cache", label: "缓存", n: 3 },
    ]);
  });
});
