import { describe, expect, it } from "vitest";
import * as classify from "../src/classify.js";
import { foldTranscript, type FoldedRow } from "../web/src/lib/fold-transcript.js";
import {
  filterGroups,
  filterRows,
  rowVisibleText,
  sanitizeQuery,
} from "../web/src/lib/timeline-filter.js";
import { flattenTimeline, groupTurns } from "../web/src/lib/timeline-turn.js";
import { virtualWindow, visibleSlice } from "../web/src/lib/timeline-virtual.js";

const localTs = (y: number, m: number, d: number, h: number, min: number): number =>
  new Date(y, m, d, h, min, 0).getTime() / 1000;

function withTs<T extends object>(ev: T, ts: number): T & { ts: number } {
  return { ...ev, ts };
}

describe("holes / unit", () => {
  it("virtualWindow with huge scrollTop and count=1 is a non-empty half-open window", () => {
    const win = virtualWindow({
      scrollTop: 10000,
      viewportHeight: 72,
      rowHeight: 72,
      count: 1,
    });
    expect(win.start).toBeLessThan(1);
    expect(win.end).toBeGreaterThan(win.start);
    expect(visibleSlice(["only"], win)).toEqual(["only"]);
  });

  it("sanitizeQuery trims before clipping so leading spaces keep the needle", () => {
    expect(sanitizeQuery({ q: `${" ".repeat(200)}needle` }).needle).toBe("needle");
    const clipped = sanitizeQuery({ q: `${" ".repeat(199)}ab` }).needle;
    expect(clipped).toBe("ab");
    expect(clipped).not.toBe("a");
  });

  it("rowVisibleText includes clipped tool card input/output and text past 4096", () => {
    const pathToken = "searchable-file-path-token";
    const outToken = "searchable-tool-output-token";
    const tool: FoldedRow = {
      type: "tool",
      name: "Read",
      detail: "x.ts",
      input: { file_path: `/tmp/${pathToken}/x.ts` },
      output: outToken,
    };
    const toolHay = rowVisibleText(tool).join("\n");
    expect(toolHay).toContain(pathToken);
    expect(toolHay).toContain(outToken);
    expect(filterRows([tool], { q: pathToken })).toEqual([tool]);
    expect(filterRows([tool], { q: outToken })).toEqual([tool]);

    const near5000 = "NEAR5000UNIQ";
    const longText = `${"n".repeat(4990)}${near5000}${"n".repeat(80)}`;
    const user: FoldedRow = { type: "user", text: longText };
    const textHay = rowVisibleText(user).join("");
    expect(textHay).toContain(near5000);
    expect(filterRows([user], { q: near5000 })).toEqual([user]);
  });

  it("groupTurns startTs is min and endTs is max when row ts descend", () => {
    const [g] = groupTurns([
      { type: "user", text: "a", ts: 12 },
      { type: "assistant", text: "b", ts: 10 },
    ]);
    expect(g.startTs).toBe(10);
    expect(g.endTs).toBe(12);
  });

  it("flattenTimeline inserts a day header before each in-turn local-day change", () => {
    const t22 = localTs(2026, 7, 22, 23, 50);
    const t23 = localTs(2026, 7, 23, 0, 10);
    const user: FoldedRow = { type: "user", text: "before midnight", ts: t22 };
    const asst: FoldedRow = { type: "assistant", text: "after midnight", ts: t23 };
    const groups = groupTurns([user, asst]);
    expect(groups).toHaveLength(1);
    const items = flattenTimeline(groups);
    const days = items.filter((it) => it.kind === "day");
    expect(days).toHaveLength(2);
    expect(days.map((d) => d.dayKey)).toEqual(["2026-08-22", "2026-08-23"]);
    const idx22 = items.findIndex((it) => it.kind === "day" && it.dayKey === "2026-08-22");
    const idx23 = items.findIndex((it) => it.kind === "day" && it.dayKey === "2026-08-23");
    const row22 = items.findIndex((it) => it.kind === "row" && it.row === user);
    const row23 = items.findIndex((it) => it.kind === "row" && it.row === asst);
    expect(idx22).toBeGreaterThanOrEqual(0);
    expect(idx23).toBeGreaterThanOrEqual(0);
    expect(row22).toBeGreaterThanOrEqual(0);
    expect(row23).toBeGreaterThanOrEqual(0);
    expect(idx22).toBeLessThan(row22);
    expect(idx23).toBeLessThan(row23);
    expect(idx22).toBeLessThan(idx23);
  });
});

describe("holes / security", () => {
  it("virtualWindow 1e20 scrollTop never yields start===count when count>0", () => {
    const count = 20;
    const huge = virtualWindow({
      scrollTop: 1e20,
      viewportHeight: 400,
      rowHeight: 72,
      count,
    });
    expect(huge.start === count).toBe(false);
    expect(huge.start).toBeLessThan(count);
    expect(huge.end).toBeGreaterThan(huge.start);
    const labels = Array.from({ length: count }, (_, i) => `r${i}`);
    expect(visibleSlice(labels, huge).length).toBeGreaterThan(0);

    const h = 72;
    const endWin = virtualWindow({
      scrollTop: count * h,
      viewportHeight: 0,
      rowHeight: h,
      count,
      overscan: 0,
    });
    expect(endWin.start === count).toBe(false);
    expect(endWin.start).toBeLessThan(count);
    expect(endWin.end).toBeGreaterThan(endWin.start);
    expect(visibleSlice(labels, endWin)).toEqual(labels.slice(endWin.start, endWin.end));
    expect(visibleSlice(labels, endWin).length).toBeGreaterThan(0);
  });

  it("200 leading spaces plus needle does not sanitize to empty and match all rows", () => {
    const q = `${" ".repeat(200)}needle`;
    const s = sanitizeQuery({ q });
    expect(s.needle).toBe("needle");
    expect(s.needle).not.toBe("");
    const miss: FoldedRow = { type: "user", text: "nothing relevant" };
    const hit: FoldedRow = { type: "user", text: "has needle inside" };
    expect(filterRows([miss], { q })).toEqual([]);
    expect(filterRows([hit], { q })).toEqual([hit]);
    expect(filterRows([miss, hit], { q })).toEqual([hit]);
  });

  it("3MB tool output haystack is ~64k clipped prefix, not the raw blob", () => {
    const unique = "UNIQUE_PAST_64K";
    const prefix = "A".repeat(64_000);
    const rest = 3 * 1024 * 1024 - prefix.length - unique.length;
    const blob = `${prefix}${unique}${"A".repeat(rest)}`;
    const row: FoldedRow = {
      type: "tool",
      name: "Read",
      detail: "huge.bin",
      input: {},
      output: blob,
    };
    const joined = rowVisibleText(row).join("");
    expect(joined.length).toBeLessThan(100_000);
    expect(joined.length).toBeGreaterThan(50_000);
    expect(joined).toContain("AAA");
    expect(joined).not.toContain(unique);
    expect(filterRows([row], { q: "AAA" })).toEqual([row]);
    expect(filterRows([row], { q: unique })).toEqual([]);
  });

  it("descending finite ts never produce startTs greater than endTs", () => {
    const [g] = groupTurns([
      { type: "user", text: "a", ts: 30 },
      { type: "assistant", text: "b", ts: Number.NaN },
      { type: "assistant", text: "c", ts: 20 },
      { type: "assistant", text: "d", ts: Number.POSITIVE_INFINITY },
      { type: "assistant", text: "e", ts: 15 },
    ]);
    expect(g.startTs).toBe(15);
    expect(g.endTs).toBe(30);
    expect(g.startTs!).toBeLessThanOrEqual(g.endTs!);
  });

  it("flattenTimeline ignores non-finite ts and still emits both reversed local days", () => {
    const t23 = localTs(2026, 7, 23, 12, 0);
    const t22 = localTs(2026, 7, 22, 12, 0);
    const first: FoldedRow = { type: "user", text: "later-day-first", ts: t23 };
    const nanRow: FoldedRow = { type: "assistant", text: "no-day", ts: Number.NaN };
    const last: FoldedRow = { type: "assistant", text: "earlier-day-last", ts: t22 };
    const items = flattenTimeline(groupTurns([first, nanRow, last]));
    const days = items.filter((it) => it.kind === "day");
    expect(days).toHaveLength(2);
    expect(days.map((d) => d.dayKey)).toEqual(["2026-08-23", "2026-08-22"]);
    const nanIdx = items.findIndex((it) => it.kind === "row" && it.row === nanRow);
    expect(nanIdx).toBeGreaterThanOrEqual(0);
    const dayImmediatelyBeforeNan = [...items.slice(0, nanIdx)].reverse().find((it) => it.kind === "day");
    expect(dayImmediatelyBeforeNan?.kind === "day" ? dayImmediatelyBeforeNan.dayKey : undefined).not.toBe(
      "Invalid Date",
    );
    expect(items.some((it) => it.kind === "day" && !/^\d{4}-\d{2}-\d{2}$/.test(it.dayKey))).toBe(false);
    const idx23 = items.findIndex((it) => it.kind === "day" && it.dayKey === "2026-08-23");
    const idx22 = items.findIndex((it) => it.kind === "day" && it.dayKey === "2026-08-22");
    const row23 = items.findIndex((it) => it.kind === "row" && it.row === first);
    const row22 = items.findIndex((it) => it.kind === "row" && it.row === last);
    expect(idx23).toBeGreaterThanOrEqual(0);
    expect(idx22).toBeGreaterThanOrEqual(0);
    expect(idx23).toBeLessThan(row23);
    expect(idx22).toBeLessThan(row22);
    expect(idx23).toBeLessThan(idx22);
  });
});

describe("holes / integration", () => {
  it("filter then virtualWindow with stale scrollTop still slices the lone search hit", () => {
    const rows: FoldedRow[] = [];
    for (let i = 0; i < 80; i++) rows.push({ type: "user", text: `noise-${i}` });
    const hit: FoldedRow = { type: "user", text: "the-only-hit-token" };
    rows.push(hit);
    const staleScrollTop = (rows.length - 1) * 72;
    const filtered = filterRows(rows, { q: "the-only-hit-token" });
    expect(filtered).toEqual([hit]);
    const win = virtualWindow({
      scrollTop: staleScrollTop,
      viewportHeight: 400,
      rowHeight: 72,
      count: filtered.length,
    });
    expect(win.start).toBeLessThan(filtered.length);
    expect(win.end).toBeGreaterThan(win.start);
    expect(visibleSlice(filtered, win)).toEqual([hit]);
  });

  it("filterGroups with space-padded over-budget q keeps only the needle turn", () => {
    const connected = { kind: "working" as const, summary: "connected", extra: {} };
    const s1 = classify.fromSent({ text: "alpha-turn-unique" })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: "beta-other" })[0];
    const done2 = classify.fromResult({ is_error: false, result: "reply-two" });
    const groups = groupTurns(foldTranscript([connected, s1, ...done1, s2, ...done2]));
    expect(groups.length).toBeGreaterThan(1);
    const q = `${" ".repeat(200)}alpha-turn-unique`;
    const filtered = filterGroups(groups, { q });
    expect(sanitizeQuery({ q }).needle).toBe("alpha-turn-unique");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes("alpha-turn-unique"))).toBe(
      true,
    );
  });

  it("filterGroups finds a token that only exists in expanded tool input JSON", () => {
    const pathToken = "unique-json-path-token";
    const sent = classify.fromSent({ text: "please read" })[0];
    const tool = classify.fromToolUse({
      name: "Read",
      tool_use_id: "r-json",
      tool_input: { file_path: `/hidden/${pathToken}/file.ts` },
    })[0];
    const done = classify.fromResult({ is_error: false, result: "ok" });
    const groups = groupTurns(foldTranscript([sent, tool, ...done]));
    const filtered = filterGroups(groups, { q: pathToken });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "tool")).toBe(true);
    const toolRow = foldTranscript([tool]).find((r) => r.type === "tool");
    expect(toolRow && toolRow.type === "tool" ? toolRow.detail : "").not.toContain(pathToken);
  });

  it("classify-or-fold then groupTurns with reversed event ts has startTs<=endTs", () => {
    const later = localTs(2026, 7, 23, 12, 0);
    const earlier = localTs(2026, 7, 23, 10, 0);
    const sent = withTs(classify.fromSent({ text: "hi" })[0], later);
    const done = classify.fromResult({ is_error: false, result: "ok" }).map((e) => withTs(e, earlier));
    const [g] = groupTurns(foldTranscript([sent, ...done]));
    expect(g.startTs).toBe(earlier);
    expect(g.endTs).toBe(later);
    expect(g.startTs!).toBeLessThanOrEqual(g.endTs!);
  });

  it("same turn user before midnight and assistant after midnight yields two day items", () => {
    const before = localTs(2026, 7, 22, 23, 50);
    const after = localTs(2026, 7, 23, 0, 10);
    const sent = withTs(classify.fromSent({ text: "before midnight" })[0], before);
    const done = classify.fromResult({ is_error: false, result: "after midnight" }).map((e) =>
      withTs(e, after),
    );
    const groups = groupTurns(foldTranscript([sent, ...done]));
    expect(groups).toHaveLength(1);
    const items = flattenTimeline(groups);
    const days = items.filter((it) => it.kind === "day");
    expect(days).toHaveLength(2);
    expect(days.map((d) => d.dayKey)).toEqual(["2026-08-22", "2026-08-23"]);
    const idx22 = items.findIndex((it) => it.kind === "day" && it.dayKey === "2026-08-22");
    const idx23 = items.findIndex((it) => it.kind === "day" && it.dayKey === "2026-08-23");
    const row22 = items.findIndex(
      (it) => it.kind === "row" && it.row.type === "user" && it.row.ts === before,
    );
    const row23 = items.findIndex(
      (it) => it.kind === "row" && it.row.type === "assistant" && it.row.ts === after,
    );
    expect(idx22).toBeGreaterThanOrEqual(0);
    expect(idx23).toBeGreaterThanOrEqual(0);
    expect(row22).toBeGreaterThanOrEqual(0);
    expect(row23).toBeGreaterThanOrEqual(0);
    expect(idx22).toBeLessThan(row22);
    expect(idx23).toBeLessThan(row23);
  });
});
