import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as classify from "../src/classify.js";
import { toEpochMs } from "../web/src/lib/format-ts.js";
import { foldTranscript, type FoldedRow } from "../web/src/lib/fold-transcript.js";
import {
  QUERY_MAX_LEN,
  filterGroups,
  filterRows,
  haystackHas,
  rowVisibleText,
  sanitizeQuery,
} from "../web/src/lib/timeline-filter.js";
import { flattenTimeline, groupTurns } from "../web/src/lib/timeline-turn.js";
import * as virt from "../web/src/lib/timeline-virtual.js";
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

  it("endScrollTop is 0 for a single row, last page for many rows, and 0 when empty", () => {
    expect(typeof virt.endScrollTop).toBe("function");
    const endScrollTop = virt.endScrollTop as (p: {
      count: number;
      viewportHeight: number;
      rowHeight: number;
    }) => number;
    expect(endScrollTop({ count: 1, viewportHeight: 400, rowHeight: 72 })).toBe(0);
    expect(endScrollTop({ count: 80, viewportHeight: 400, rowHeight: 72 })).toBe(80 * 72 - 400);
    expect(endScrollTop({ count: 0, viewportHeight: 400, rowHeight: 72 })).toBe(0);
  });

  it("sanitizeQuery trims before clipping so leading spaces keep the needle", () => {
    expect(sanitizeQuery({ q: `${" ".repeat(200)}needle` }).needle).toBe("needle");
    const clipped = sanitizeQuery({ q: `${" ".repeat(199)}ab` }).needle;
    expect(clipped).toBe("ab");
    expect(clipped).not.toBe("a");
  });

  it("sanitizeQuery strips leading zero-width fillers so the trailing word survives the clip", () => {
    const q = `${"\u200b".repeat(195)}needle`;
    const { needle } = sanitizeQuery({ q });
    expect(needle).toBe("needle");
    expect(needle.length).toBeLessThanOrEqual(QUERY_MAX_LEN);
  });

  it("sanitizeQuery does not leave a lone surrogate when clipping just before a thumbs-up", () => {
    const thumb = "\u{1F44D}";
    const q = `${"x".repeat(199)}${thumb}`;
    expect(q.length).toBe(201);
    const { needle } = sanitizeQuery({ q });
    expect(needle).not.toBe("");
    expect(needle).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(needle).not.toMatch(/^[\uDC00-\uDFFF]/);
    expect(needle.endsWith(thumb) || haystackHas(thumb, needle)).toBe(true);
    expect(needle.includes("\uD83D") && !needle.includes(thumb)).toBe(false);
  });

  it("sanitizeQuery strips ZWNJ ZWJ BOM and word-joiner before clipping the trailing word", () => {
    const q = `${"‌".repeat(40)}${"‍".repeat(40)}${"﻿".repeat(40)}${"⁠".repeat(75)}needle`;
    const { needle } = sanitizeQuery({ q });
    expect(needle).toBe("needle");
    expect(needle).not.toBe("");
  });

  it("sanitizeQuery NFC-normalizes before limiting length so a combining mark is not dropped", () => {
    const q = `${"x".repeat(199)}e\u0301`;
    const { needle } = sanitizeQuery({ q });
    expect(needle).toBe(needle.normalize("NFC"));
    expect(needle.includes("\u00e9")).toBe(true);
    expect(needle.length).toBeLessThanOrEqual(QUERY_MAX_LEN + 2);
  });

  it("sanitizeQuery does not clip a flag to a half regional-indicator that matches another flag", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const q = `${"x".repeat(198)}${china}`;
    const { needle } = sanitizeQuery({ q });
    expect(needle).not.toBe("");
    expect(needle.includes(china) || needle.endsWith(china)).toBe(true);
    expect(needle.includes("\u{1F1E8}") && !needle.includes(china)).toBe(false);
    expect(haystackHas(canada, "\u{1F1E8}")).toBe(false);
    expect(haystackHas(canada, needle)).toBe(false);
    expect(filterRows([{ type: "user", text: canada }], { q })).toEqual([]);
    expect(filterRows([{ type: "user", text: q }], { q }).length).toBe(1);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("a budget-filling prefix plus a lone regional indicator cannot match any flag", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const letter = "\u{1F1E8}";
    const q = `${"x".repeat(199)}${letter}`;
    const { needle } = sanitizeQuery({ q });
    expect(needle.endsWith(letter)).toBe(false);
    expect(haystackHas(china, letter)).toBe(false);
    expect(haystackHas(canada, letter)).toBe(false);
    expect(haystackHas(china, needle)).toBe(false);
    expect(haystackHas(canada, needle)).toBe(false);
    expect(filterRows([{ type: "user", text: china }], { q })).toEqual([]);
    expect(filterRows([{ type: "user", text: canada }], { q })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: letter })).toEqual([]);
  });

  it("a lone regional letter cannot match any complete flag", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const letterC = "\u{1F1E8}";
    const letterN = "\u{1F1F3}";
    expect(haystackHas(china, letterC)).toBe(false);
    expect(haystackHas(canada, letterC)).toBe(false);
    expect(haystackHas(us, letterC)).toBe(false);
    expect(haystackHas(china, letterN)).toBe(false);
    expect(haystackHas(canada, letterN)).toBe(false);
    expect(haystackHas(us, letterN)).toBe(false);
    expect(haystackHas(china, china)).toBe(true);
    expect(haystackHas(canada, canada)).toBe(true);
    expect(filterRows([{ type: "user", text: canada }], { q: letterC })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: letterC })).toEqual([]);
    expect(filterRows([{ type: "user", text: us }], { q: letterC })).toEqual([]);
    expect(filterRows([{ type: "user", text: canada }], { q: letterN })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: letterN })).toEqual([]);
    expect(filterRows([{ type: "user", text: us }], { q: letterN })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("the first UTF-16 half of a flag cannot match any complete flag", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const half = china.slice(0, 1);
    expect(half).toBe("\uD83C");
    expect(haystackHas(china, half)).toBe(false);
    expect(haystackHas(canada, half)).toBe(false);
    expect(haystackHas(us, half)).toBe(false);
    expect(filterRows([{ type: "user", text: china }], { q: half })).toEqual([]);
    expect(filterRows([{ type: "user", text: canada }], { q: half })).toEqual([]);
    expect(filterRows([{ type: "user", text: us }], { q: half })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("a clipped leftover prefix or first-half flag cannot match other flags", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const half = "\uD83C";
    const q199 = `${"x".repeat(199)}${half}`;
    const q200 = `${"x".repeat(200)}${half}`;
    expect(q199.length).toBe(200);
    expect(q200.length).toBe(201);
    expect(filterRows([{ type: "user", text: `${"x".repeat(199)}${canada}` }], { q: q199 })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(199)}${china}` }], { q: q199 })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(199)}${us}` }], { q: q199 })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(200)}${canada}` }], { q: q200 })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(200)}${us}` }], { q: q200 })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(200)}${china}` }], { q: q200 })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(200)}${canada}` }], { q: "x".repeat(200) }).length).toBe(1);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("clipped leftover second-half flag cannot match padded Canada or US via the prefix", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const secondHalf = china.slice(1, 2);
    const q200 = `${"x".repeat(200)}${secondHalf}`;
    const q201 = `${"x".repeat(201)}${secondHalf}`;
    expect(filterRows([{ type: "user", text: `${"x".repeat(200)}${canada}` }], { q: q200 })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(200)}${us}` }], { q: q200 })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(200)}${china}` }], { q: q200 })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(200)}${canada}` }], { q: q201 })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(200)}${us}` }], { q: q201 })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(200)}${canada}` }], { q: "x".repeat(200) }).length).toBe(1);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("200 x's then a half flag cannot match another padded flag via the leftover prefix", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const letter = "\u{1F1E8}";
    const prefix = "x".repeat(200);
    const qHalf = `${prefix}${letter}`;
    const qFull = `${prefix}${china}`;
    expect(qHalf.length).toBe(202);
    expect(qFull.length).toBe(204);
    const paddedCanada: FoldedRow = { type: "user", text: `${prefix}${canada}` };
    const paddedUs: FoldedRow = { type: "user", text: `${prefix}${us}` };
    const paddedChina: FoldedRow = { type: "user", text: `${prefix}${china}` };
    expect(haystackHas(paddedCanada.text, letter)).toBe(false);
    expect(haystackHas(paddedUs.text, letter)).toBe(false);
    expect(filterRows([paddedCanada, paddedUs, paddedChina], { q: qHalf })).toEqual([]);
    expect(filterRows([paddedCanada], { q: qHalf })).toEqual([]);
    expect(filterRows([paddedUs], { q: qHalf })).toEqual([]);
    expect(filterRows([paddedCanada], { q: qFull })).toEqual([]);
    expect(filterRows([paddedUs], { q: qFull })).toEqual([]);
    expect(filterRows([{ type: "user", text: canada }], { q: qHalf })).toEqual([]);
    expect(filterRows([{ type: "user", text: us }], { q: qFull })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
    expect(filterRows([paddedCanada], { q: prefix }).length).toBe(1);
  });

  it("a single regional indicator U+1F1E8 cannot match any complete flag", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const france = "\u{1F1EB}\u{1F1F7}";
    const letter = "\u{1F1E8}";
    expect(haystackHas(china, letter)).toBe(false);
    expect(haystackHas(canada, letter)).toBe(false);
    expect(haystackHas(us, letter)).toBe(false);
    expect(haystackHas(france, letter)).toBe(false);
    expect(
      filterRows(
        [
          { type: "user", text: china },
          { type: "user", text: canada },
          { type: "user", text: us },
          { type: "user", text: france },
        ],
        { q: letter },
      ),
    ).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("after clip, leftover prefix or dropped half-flag tail cannot match other flags", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const letter = "\u{1F1E8}";
    const half = "\uD83C";
    const padded200: FoldedRow[] = [
      { type: "user", text: `${"x".repeat(200)}${canada}` },
      { type: "user", text: `${"x".repeat(200)}${us}` },
      { type: "user", text: `${"x".repeat(200)}${china}` },
    ];
    const q201c = `${"x".repeat(201)}${letter}`;
    const q201hi = `${"x".repeat(201)}${half}`;
    const q201cn = `${"x".repeat(201)}${china}`;
    const q202c = `${"x".repeat(202)}${letter}`;
    expect(q201c.length).toBe(203);
    expect(sanitizeQuery({ q: q201c }).droppedRegional).toBeTruthy();
    expect(sanitizeQuery({ q: q201hi }).droppedRegional).toBeTruthy();
    expect(sanitizeQuery({ q: q201cn }).droppedRegional).toBeTruthy();
    expect(filterRows(padded200, { q: q201c })).toEqual([]);
    expect(filterRows(padded200, { q: q201hi })).toEqual([]);
    expect(
      filterRows(padded200, { q: q201cn }).some(
        (r) => r.type === "user" && (r.text.includes(canada) || r.text.includes(us)),
      ),
    ).toBe(false);
    expect(filterRows(padded200, { q: q202c })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(199)}${canada}` }], { q: `${"x".repeat(199)}${letter}` })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(197)}${canada}` }], { q: `${"x".repeat(197)} a${letter}` })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("198x+🇨 and 199x+🇨 cannot prefix-match a padded Canada flag", () => {
    const canada = "\u{1F1E8}\u{1F1E6}";
    const china = "\u{1F1E8}\u{1F1F3}";
    const letter = "\u{1F1E8}";
    const q198 = `${"x".repeat(198)}${letter}`;
    const q199 = `${"x".repeat(199)}${letter}`;
    const padded198: FoldedRow = { type: "user", text: `${"x".repeat(198)}${canada}` };
    const padded199: FoldedRow = { type: "user", text: `${"x".repeat(199)}${canada}` };
    expect(haystackHas(padded198.text, letter)).toBe(false);
    expect(haystackHas(padded199.text, letter)).toBe(false);
    expect(filterRows([padded198], { q: q198 })).toEqual([]);
    expect(filterRows([padded199], { q: q199 })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(198)}${china}` }], { q: q198 })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("sanitizeQuery strips soft hyphens before clipping so the trailing word survives", () => {
    const q = `${"­".repeat(195)}needle`;
    const { needle } = sanitizeQuery({ q });
    expect(needle).toBe("needle");
    expect(needle).not.toBe("");
    expect(needle.length).toBeLessThanOrEqual(QUERY_MAX_LEN);
  });

  it("sanitizeQuery keeps a ZWJ family sequence so the original row still matches", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const q = `${"x".repeat(190)}${family}`;
    const { needle } = sanitizeQuery({ q });
    expect(needle).toContain("‍");
    expect(needle).toContain(family);
    expect(haystackHas(q, family)).toBe(true);
    const row: FoldedRow = { type: "user", text: q };
    expect(filterRows([row], { q })).toEqual([row]);
    const familyRow: FoldedRow = { type: "user", text: `family ${family}` };
    expect(filterRows([familyRow], { q: family })).toEqual([familyRow]);
    expect(filterRows([{ type: "user", text: "no family here" }], { q: family })).toEqual([]);
  });

  it("sanitizeQuery word-clips so a mid-word cut does not keep half of world", () => {
    const padded = `hello world${"y".repeat(200)}`;
    const paddedNeedle = sanitizeQuery({ q: padded }).needle;
    expect(paddedNeedle === "hello" || paddedNeedle === "hello world").toBe(true);
    expect(paddedNeedle).not.toMatch(/worldy/);
    expect(paddedNeedle.endsWith("worl")).toBe(false);
    expect(paddedNeedle.length).toBeLessThanOrEqual(QUERY_MAX_LEN);

    const midWord = `${"a".repeat(190)} hello world`;
    const midNeedle = sanitizeQuery({ q: midWord }).needle;
    expect(midNeedle.endsWith("hello")).toBe(true);
    expect(midNeedle.endsWith("wor")).toBe(false);
    expect(midNeedle).not.toMatch(/wo$/);
    expect(midNeedle).not.toContain("wor");
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

  it("rowVisibleText and filterRows see the tail of a system item longer than ITEM_CLIP", () => {
    const tail = "TAIL_TOKEN";
    const long = `${"a".repeat(300)}${tail}`;
    const row: FoldedRow = { type: "system", items: [long] };
    const hay = rowVisibleText(row).join("\n");
    expect(hay).toContain(tail);
    expect(hay).toContain(long);
    expect(filterRows([row], { q: tail })).toEqual([row]);
    expect(filterRows([{ type: "system", items: ["已连接"] }], { q: "已连接" })).toEqual([
      { type: "system", items: ["已连接"] },
    ]);
  });

  it("groupTurns startTs is min and endTs is max when row ts descend", () => {
    const [g] = groupTurns([
      { type: "user", text: "a", ts: 12 },
      { type: "assistant", text: "b", ts: 10 },
    ]);
    expect(g.startTs).toBe(10);
    expect(g.endTs).toBe(12);
  });

  it("groupTurns mixed second and millisecond ts keep chronological start/end as original row ts", () => {
    const laterSec = 1_787_404_000;
    const earlierMs = 1_787_403_750_285;
    expect(toEpochMs(laterSec)!).toBeGreaterThan(toEpochMs(earlierMs)!);
    const [g] = groupTurns([
      { type: "user", text: "later-sec", ts: laterSec },
      { type: "assistant", text: "earlier-ms", ts: earlierMs },
    ]);
    expect(g.startTs).toBe(earlierMs);
    expect(g.endTs).toBe(laterSec);
    expect(toEpochMs(g.startTs)!).toBeLessThanOrEqual(toEpochMs(g.endTs)!);
    expect(g.startTs).not.toBe(laterSec);
    expect(g.endTs).not.toBe(earlierMs);
  });

  it("makeGroup and rebuildGroup compare timestamps through toEpochMs", () => {
    const turnSrc = readFileSync(new URL("../web/src/lib/timeline-turn.ts", import.meta.url), "utf8");
    const filterSrc = readFileSync(new URL("../web/src/lib/timeline-filter.ts", import.meta.url), "utf8");
    expect(turnSrc).toMatch(/toEpochMs\s*\(/);
    expect(filterSrc).toMatch(/toEpochMs\s*\(/);
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

  it("198x+🇨🇳 (q.length=202) keeps the full flag and cannot match 🇨🇦 via a half RI", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const q = `${"x".repeat(198)}${china}`;
    expect(q.length).toBe(202);
    const { needle } = sanitizeQuery({ q });
    expect(needle).not.toBe("");
    expect(needle.includes(china)).toBe(true);
    expect(needle.endsWith(china)).toBe(true);
    expect(needle.includes("\u{1F1E8}") && !needle.includes(china)).toBe(false);
    expect(haystackHas(canada, "\u{1F1E8}")).toBe(false);
    expect(haystackHas(canada, needle)).toBe(false);
    const paddedCanada = `${"x".repeat(198)}${canada}`;
    expect(haystackHas(paddedCanada, needle)).toBe(false);
    expect(filterRows([{ type: "user", text: canada }], { q })).toEqual([]);
    expect(filterRows([{ type: "user", text: paddedCanada }], { q })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
    expect(filterRows([{ type: "user", text: q }], { q }).length).toBe(1);
  });

  it("195x U+00AD plus needle keeps the full word, never needl or pure SHY", () => {
    const q = `${"­".repeat(195)}needle`;
    const { needle } = sanitizeQuery({ q });
    expect(needle).toBe("needle");
    expect(needle).not.toBe("needl");
    expect(needle).not.toBe("­".repeat(195));
    expect(needle).not.toBe("");
    const miss: FoldedRow = { type: "user", text: "nothing relevant" };
    const hit: FoldedRow = { type: "user", text: "has needle inside" };
    expect(filterRows([miss], { q })).toEqual([]);
    expect(filterRows([hit], { q })).toEqual([hit]);
  });

  it("200x U+00AD plus needle still leaves needle after the clip budget is spent", () => {
    const q = `${"­".repeat(200)}needle`;
    const { needle } = sanitizeQuery({ q });
    expect(needle).toBe("needle");
    expect(needle).not.toBe("needl");
    expect(needle).not.toMatch(/­/);
    expect(filterRows([{ type: "user", text: "has needle inside" }], { q }).length).toBe(1);
  });

  it("ZWJ family 👨‍👩‍👧 stays whole so the original row matches and a lone 👨 does not", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const stripped = "\u{1F468}\u{1F469}\u{1F467}";
    const q = `${"x".repeat(190)}${family}`;
    const { needle } = sanitizeQuery({ q });
    expect(needle).toContain("‍");
    expect(needle).toContain(family);
    expect(needle).not.toBe(stripped);
    expect(haystackHas(family, needle.includes(family) ? family : needle)).toBe(true);
    const familyRow: FoldedRow = { type: "user", text: family };
    expect(filterRows([familyRow], { q: family })).toEqual([familyRow]);
    expect(filterRows([{ type: "user", text: q }], { q })).toEqual([{ type: "user", text: q }]);
    expect(filterRows([{ type: "user", text: "\u{1F468}" }], { q: family })).toEqual([]);
    expect(filterRows([{ type: "user", text: stripped }], { q: family })).toEqual([]);
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

  it("195 zero-width spaces plus needle still finds only the real hit", () => {
    const q = `${"\u200b".repeat(195)}needle`;
    const s = sanitizeQuery({ q });
    expect(s.needle).toBe("needle");
    expect(s.needle).not.toBe("");
    const miss: FoldedRow = { type: "user", text: "nothing relevant" };
    const hit: FoldedRow = { type: "user", text: "has needle inside" };
    expect(filterRows([miss], { q })).toEqual([]);
    expect(filterRows([hit], { q })).toEqual([hit]);
  });

  it("soft-hyphen padded needle still finds only the real hit", () => {
    const q = `${"­".repeat(195)}needle`;
    const s = sanitizeQuery({ q });
    expect(s.needle).toBe("needle");
    expect(s.needle).not.toBe("");
    const miss: FoldedRow = { type: "user", text: "nothing relevant" };
    const hit: FoldedRow = { type: "user", text: "has needle inside" };
    expect(filterRows([miss], { q })).toEqual([]);
    expect(filterRows([hit], { q })).toEqual([hit]);
  });

  it("half a clipped flag never matches a different flag row", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const q = `${"x".repeat(198)}${china}`;
    const s = sanitizeQuery({ q });
    expect(s.needle).not.toBe("");
    expect(s.needle.includes(china)).toBe(true);
    expect(haystackHas(canada, "\u{1F1E8}")).toBe(false);
    expect(haystackHas(canada, s.needle)).toBe(false);
    expect(filterRows([{ type: "user", text: canada }], { q })).toEqual([]);
    expect(filterRows([{ type: "user", text: q }], { q }).length).toBe(1);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("ZWJ family query matches the original family row and not a lone adult", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const q = `${"x".repeat(190)}${family}`;
    const s = sanitizeQuery({ q });
    expect(s.needle).toContain("‍");
    expect(s.needle).toContain(family);
    const familyRow: FoldedRow = { type: "user", text: family };
    const adult: FoldedRow = { type: "user", text: "\u{1F468}" };
    expect(filterRows([familyRow], { q: family })).toEqual([familyRow]);
    expect(filterRows([{ type: "user", text: q }], { q })).toEqual([{ type: "user", text: q }]);
    expect(filterRows([adult], { q: family })).toEqual([]);
  });

  it("sanitizeQuery source never builds a RegExp from user input", () => {
    const src = readFileSync(new URL("../web/src/lib/timeline-filter.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/new RegExp/);
    expect(src).not.toMatch(/RegExp\s*\(/);
    const s = sanitizeQuery({ q: ".*+?^${}()|[]\\" });
    expect(s.needle).toBe(".*+?^${}()|[]\\");
    expect(s.needle).not.toBeInstanceOf(RegExp);
  });

  it("endScrollTop and virtualWindow survive NaN Infinity and huge scroll", () => {
    expect(typeof virt.endScrollTop).toBe("function");
    const endScrollTop = virt.endScrollTop as (p: {
      count: number;
      viewportHeight: number;
      rowHeight: number;
    }) => number;
    expect(() =>
      endScrollTop({
        count: Number.NaN,
        viewportHeight: Number.POSITIVE_INFINITY,
        rowHeight: Number.NEGATIVE_INFINITY,
      }),
    ).not.toThrow();
    const fromNaN = endScrollTop({
      count: Number.NaN,
      viewportHeight: 400,
      rowHeight: 72,
    });
    expect(Number.isFinite(fromNaN)).toBe(true);
    expect(fromNaN).toBe(0);
    const fromHuge = endScrollTop({
      count: 80,
      viewportHeight: 400,
      rowHeight: 72,
    });
    expect(Number.isFinite(fromHuge)).toBe(true);
    expect(fromHuge).toBeGreaterThanOrEqual(0);
    const win = virtualWindow({
      scrollTop: Number.POSITIVE_INFINITY,
      viewportHeight: 400,
      rowHeight: 72,
      count: 20,
    });
    expect(Number.isFinite(win.start)).toBe(true);
    expect(Number.isFinite(win.end)).toBe(true);
    expect(win.start).toBeLessThan(20);
    expect(win.end).toBeGreaterThan(win.start);
  });

  it("Transcript pins open switch and clear-q, not count or mid-query away from latest", () => {
    const src = readFileSync(new URL("../web/src/components/Transcript.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/endScrollTop/);
    expect(src).toMatch(/el\.scrollTop/);
    expect(src).toMatch(/listRef/);
    expect(src).toMatch(/setScroll/);
    expect(src).toMatch(/nextScrollTop/);
    expect(src).toMatch(/setQ\(""\)/);
    expect(src).toMatch(/reason:\s*["']session["']/);
    expect(src).toMatch(/reason:\s*["']clear-q["']/);
    expect(src).not.toMatch(
      /useEffect\(\(\) => \{\s*const top = endScrollTop\([\s\S]*?\}, \[q, items\.length, viewportHeight\]\)/,
    );
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

  it("mixed-unit startTs/endTs stay chronological after toEpochMs and keep raw row ts", () => {
    const laterSec = 1_787_404_000;
    const earlierMs = 1_787_403_750_285;
    const [g] = groupTurns([
      { type: "user", text: "a", ts: laterSec },
      { type: "assistant", text: "b", ts: Number.NaN },
      { type: "assistant", text: "c", ts: earlierMs },
      { type: "assistant", text: "d", ts: Number.POSITIVE_INFINITY },
    ]);
    expect(g.startTs).toBe(earlierMs);
    expect(g.endTs).toBe(laterSec);
    expect(toEpochMs(g.startTs)!).toBeLessThanOrEqual(toEpochMs(g.endTs)!);
    const sameSec = 1_787_403_750;
    const sameMs = 1_787_403_750_000;
    expect(toEpochMs(sameSec)).toBe(toEpochMs(sameMs));
    const [same] = groupTurns([
      { type: "user", text: "s", ts: sameSec },
      { type: "assistant", text: "m", ts: sameMs },
    ]);
    expect([same.startTs, same.endTs].sort()).toEqual([sameSec, sameMs].sort());
    expect(toEpochMs(same.startTs)!).toBeLessThanOrEqual(toEpochMs(same.endTs)!);
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

  it("never compiles user q as RegExp; filler table has U+00AD and not ZWJ", () => {
    const src = readFileSync(new URL("../web/src/lib/timeline-filter.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/new RegExp/);
    expect(src).not.toMatch(/RegExp\s*\(/);
    const filler = src.match(/function isFillerCode\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(filler.length).toBeGreaterThan(0);
    expect(filler).toMatch(/0x00ad/i);
    expect(filler).not.toMatch(/0x200d/i);
    const s = sanitizeQuery({ q: ".*+?^${}()|[]\\" });
    expect(s.needle).toBe(".*+?^${}()|[]\\");
    expect(s.needle).not.toBeInstanceOf(RegExp);
  });

  it("half a China flag from a 202-unit padded q never matches Canada", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const q = `${"x".repeat(198)}${china}`;
    expect(q.length).toBe(202);
    const s = sanitizeQuery({ q });
    expect(s.needle).not.toBe("");
    expect(s.needle.includes(china)).toBe(true);
    expect(s.needle.includes("\u{1F1E8}") && !s.needle.includes(china)).toBe(false);
    expect(haystackHas(canada, "\u{1F1E8}")).toBe(false);
    expect(haystackHas(canada, s.needle)).toBe(false);
    const paddedCanada = `${"x".repeat(198)}${canada}`;
    expect(haystackHas(paddedCanada, s.needle)).toBe(false);
    expect(filterRows([{ type: "user", text: canada }], { q })).toEqual([]);
    expect(filterRows([{ type: "user", text: paddedCanada }], { q })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("a lone regional letter is not a wildcard for every flag row", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const letterC = "\u{1F1E8}";
    const letterN = "\u{1F1F3}";
    expect(haystackHas(china, letterC)).toBe(false);
    expect(haystackHas(canada, letterC)).toBe(false);
    expect(haystackHas(us, letterC)).toBe(false);
    expect(haystackHas(china, letterN)).toBe(false);
    expect(filterRows([{ type: "user", text: canada }], { q: letterC })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: letterC })).toEqual([]);
    expect(filterRows([{ type: "user", text: us }], { q: letterC })).toEqual([]);
    expect(filterRows([{ type: "user", text: canada }, { type: "user", text: china }, { type: "user", text: us }], { q: letterN })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("filling the budget then appending a half or full flag cannot hit another padded flag", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const letter = "\u{1F1E8}";
    const prefix = "x".repeat(200);
    const qHalf = `${prefix}${letter}`;
    const qFull = `${prefix}${china}`;
    const src = readFileSync(new URL("../web/src/lib/timeline-filter.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/new RegExp/);
    expect(src).not.toMatch(/RegExp\s*\(/);
    expect(filterRows([{ type: "user", text: `${prefix}${canada}` }], { q: qHalf })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${prefix}${us}` }], { q: qHalf })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${prefix}${canada}` }], { q: qFull })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${prefix}${us}` }], { q: qFull })).toEqual([]);
    expect(filterRows([{ type: "user", text: canada }], { q: qHalf })).toEqual([]);
    expect(filterRows([{ type: "user", text: us }], { q: qFull })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(199)}${canada}` }], { q: `${"x".repeat(199)}${letter}` })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("a single regional indicator U+1F1E8 is not a wildcard for every flag row", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const france = "\u{1F1EB}\u{1F1F7}";
    const letter = "\u{1F1E8}";
    const src = readFileSync(new URL("../web/src/lib/timeline-filter.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/new RegExp/);
    expect(src).not.toMatch(/RegExp\s*\(/);
    expect(haystackHas(china, letter)).toBe(false);
    expect(haystackHas(canada, letter)).toBe(false);
    expect(haystackHas(us, letter)).toBe(false);
    expect(haystackHas(france, letter)).toBe(false);
    expect(
      filterRows(
        [
          { type: "user", text: china },
          { type: "user", text: canada },
          { type: "user", text: us },
          { type: "user", text: france },
        ],
        { q: letter },
      ),
    ).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("leftover prefix after a dropped half-flag tail cannot hit every padded flag", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const letter = "\u{1F1E8}";
    const half = "\uD83C";
    const src = readFileSync(new URL("../web/src/lib/timeline-filter.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/new RegExp/);
    expect(src).not.toMatch(/RegExp\s*\(/);
    const padded200: FoldedRow[] = [
      { type: "user", text: `${"x".repeat(200)}${canada}` },
      { type: "user", text: `${"x".repeat(200)}${us}` },
      { type: "user", text: `${"x".repeat(200)}${china}` },
    ];
    expect(sanitizeQuery({ q: `${"x".repeat(201)}${letter}` }).droppedRegional).toBeTruthy();
    expect(filterRows(padded200, { q: `${"x".repeat(201)}${letter}` })).toEqual([]);
    expect(filterRows(padded200, { q: `${"x".repeat(201)}${half}` })).toEqual([]);
    expect(
      filterRows(padded200, { q: `${"x".repeat(201)}${china}` }).some(
        (r) => r.type === "user" && (r.text.includes(canada) || r.text.includes(us)),
      ),
    ).toBe(false);
    expect(filterRows(padded200, { q: `${"x".repeat(202)}${letter}` })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(197)}${canada}` }], { q: `${"x".repeat(197)} a${letter}` })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("U+00AD padding cannot eat the budget down to needl or a SHY-only needle", () => {
    const q = `${"­".repeat(195)}needle`;
    const s = sanitizeQuery({ q });
    expect(s.needle).toBe("needle");
    expect(s.needle).not.toBe("needl");
    expect(s.needle).not.toBe("");
    expect(s.needle).not.toMatch(/^­+$/);
    const miss: FoldedRow = { type: "user", text: "nothing relevant" };
    const hit: FoldedRow = { type: "user", text: "has needle inside" };
    expect(filterRows([miss], { q })).toEqual([]);
    expect(filterRows([hit], { q })).toEqual([hit]);
    expect(filterRows([miss, hit], { q })).toEqual([hit]);
  });

  it("ZWJ inside 👨‍👩‍👧 is not stripped as a zero-width filler", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const q = `${"x".repeat(190)}${family}`;
    const s = sanitizeQuery({ q });
    expect(s.needle).toContain("‍");
    expect(s.needle).toContain(family);
    const familyRow: FoldedRow = { type: "user", text: family };
    const adult: FoldedRow = { type: "user", text: "\u{1F468}" };
    expect(filterRows([familyRow], { q: family })).toEqual([familyRow]);
    expect(filterRows([{ type: "user", text: q }], { q })).toEqual([{ type: "user", text: q }]);
    expect(filterRows([adult], { q: family })).toEqual([]);
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

  it("multi-hit filter plus endScrollTop puts the latest matching turn in the window", () => {
    const rows: FoldedRow[] = [];
    for (let i = 0; i < 80; i++) rows.push({ type: "user", text: `hit-${i}` });
    const last: FoldedRow = { type: "user", text: "hit-latest-turn" };
    rows.push(last);
    const filtered = filterRows(rows, { q: "hit-" });
    expect(filtered.length).toBeGreaterThan(10);
    expect(filtered[filtered.length - 1]).toBe(last);
    expect(typeof virt.endScrollTop).toBe("function");
    const endScrollTop = virt.endScrollTop as (p: {
      count: number;
      viewportHeight: number;
      rowHeight: number;
    }) => number;
    const staleTop = virtualWindow({
      scrollTop: 0,
      viewportHeight: 400,
      rowHeight: 72,
      count: filtered.length,
      overscan: 0,
    });
    expect(visibleSlice(filtered, staleTop)).not.toContain(last);
    const win = virtualWindow({
      scrollTop: endScrollTop({ count: filtered.length, viewportHeight: 400, rowHeight: 72 }),
      viewportHeight: 400,
      rowHeight: 72,
      count: filtered.length,
      overscan: 0,
    });
    const slice = visibleSlice(filtered, win);
    expect(slice).toContain(last);
    expect(slice[slice.length - 1]).toBe(last);
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

  it("filterGroups with soft-hyphen-padded q still keeps only the needle turn", () => {
    const connected = { kind: "working" as const, summary: "connected", extra: {} };
    const s1 = classify.fromSent({ text: "alpha-turn-unique" })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: "beta-other" })[0];
    const done2 = classify.fromResult({ is_error: false, result: "reply-two" });
    const groups = groupTurns(foldTranscript([connected, s1, ...done1, s2, ...done2]));
    const q = `${"­".repeat(195)}alpha-turn-unique`;
    expect(sanitizeQuery({ q }).needle).toBe("alpha-turn-unique");
    const filtered = filterGroups(groups, { q });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes("alpha-turn-unique"))).toBe(
      true,
    );
  });

  it("filterGroups with a padded ZWJ family keeps only the family turn", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const s1 = classify.fromSent({ text: `see ${family}` })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: "beta-other" })[0];
    const done2 = classify.fromResult({ is_error: false, result: "reply-two" });
    const groups = groupTurns(foldTranscript([s1, ...done1, s2, ...done2]));
    const q = `${"x".repeat(190)}${family}`;
    expect(sanitizeQuery({ q }).needle).toContain(family);
    const filtered = filterGroups(groups, { q: family });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(family))).toBe(true);
  });

  it("filterGroups with a padded China flag does not keep a Canada-flag turn", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const s1 = classify.fromSent({ text: `visit ${canada}` })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: `visit ${china}` })[0];
    const done2 = classify.fromResult({ is_error: false, result: "reply-two" });
    const groups = groupTurns(foldTranscript([s1, ...done1, s2, ...done2]));
    const padded = `${"x".repeat(198)}${china}`;
    expect(sanitizeQuery({ q: padded }).needle.includes(china)).toBe(true);
    expect(filterGroups(groups, { q: padded }).some((g) => g.rows.some((r) => r.type === "user" && r.text.includes(canada)))).toBe(false);
    const filtered = filterGroups(groups, { q: china });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(china))).toBe(true);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(canada))).toBe(false);
  });

  it("filterGroups with zero-width-padded q still keeps only the needle turn", () => {
    const connected = { kind: "working" as const, summary: "connected", extra: {} };
    const s1 = classify.fromSent({ text: "alpha-turn-unique" })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: "beta-other" })[0];
    const done2 = classify.fromResult({ is_error: false, result: "reply-two" });
    const groups = groupTurns(foldTranscript([connected, s1, ...done1, s2, ...done2]));
    const q = `${"\u200b".repeat(195)}alpha-turn-unique`;
    expect(sanitizeQuery({ q }).needle).toBe("alpha-turn-unique");
    const filtered = filterGroups(groups, { q });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes("alpha-turn-unique"))).toBe(
      true,
    );
  });

  it("filterGroups finds a token that only exists past the first 256 chars of a system item", () => {
    const tail = "SYS_TAIL_VISIBLE_TOKEN";
    const sys: FoldedRow = { type: "system", items: [`${"a".repeat(300)}${tail}`] };
    const user: FoldedRow = { type: "user", text: "unrelated-user" };
    const groups = groupTurns([sys, user]);
    const filtered = filterGroups(groups, { q: tail });
    expect(rowVisibleText(sys).join("")).toContain(tail);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].turnId).toBe(0);
    expect(filtered[0].rows).toEqual([sys]);
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

  it("classify-or-fold then groupTurns mixed sec/ms does not invert start/end after toEpochMs", () => {
    const laterSec = 1_787_404_000;
    const earlierMs = 1_787_403_750_285;
    const sent = withTs(classify.fromSent({ text: "keep-mixed" })[0], laterSec);
    const done = classify.fromResult({ is_error: false, result: "keep-ok" }).map((e) => withTs(e, earlierMs));
    const [g] = groupTurns(foldTranscript([sent, ...done]));
    expect(g.startTs).toBe(earlierMs);
    expect(g.endTs).toBe(laterSec);
    expect(toEpochMs(g.startTs)!).toBeLessThanOrEqual(toEpochMs(g.endTs)!);
    const [onlyUser] = filterGroups([g], { q: "mixed" });
    expect(onlyUser.startTs).toBe(laterSec);
    expect(onlyUser.endTs).toBe(laterSec);
    const [both] = filterGroups([g], { q: "keep" });
    expect(toEpochMs(both.startTs)!).toBeLessThanOrEqual(toEpochMs(both.endTs)!);
    expect(both.startTs).toBe(earlierMs);
    expect(both.endTs).toBe(laterSec);
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

  it("filterGroups: 198x+🇨🇳 (len 202) must not leave a 🇨🇦 turn", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const s1 = classify.fromSent({ text: `visit ${canada}` })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: `visit ${china}` })[0];
    const done2 = classify.fromResult({ is_error: false, result: "reply-two" });
    const groups = groupTurns(foldTranscript([s1, ...done1, s2, ...done2]));
    const padded = `${"x".repeat(198)}${china}`;
    expect(padded.length).toBe(202);
    expect(sanitizeQuery({ q: padded }).needle.includes(china)).toBe(true);
    const paddedCanada = `${"x".repeat(198)}${canada}`;
    expect(haystackHas(paddedCanada, sanitizeQuery({ q: padded }).needle)).toBe(false);
    expect(
      filterGroups(groups, { q: padded }).some((g) =>
        g.rows.some((r) => r.type === "user" && r.text.includes(canada)),
      ),
    ).toBe(false);
    const paddedCanadaGroups = groupTurns([
      { type: "user", text: paddedCanada },
      { type: "user", text: padded },
    ]);
    expect(
      filterGroups(paddedCanadaGroups, { q: padded }).some((g) =>
        g.rows.some((r) => r.type === "user" && r.text === paddedCanada),
      ),
    ).toBe(false);
    const letter = "\u{1F1E8}";
    const half = `${"x".repeat(199)}${letter}`;
    expect(sanitizeQuery({ q: half }).needle.endsWith(letter)).toBe(false);
    expect(filterGroups(groups, { q: half })).toEqual([]);
    expect(filterGroups(groups, { q: letter })).toEqual([]);
    const filtered = filterGroups(groups, { q: china });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(china))).toBe(true);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(canada))).toBe(false);
  });

  it("filterGroups: a lone regional letter does not keep every flag turn", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const letterC = "\u{1F1E8}";
    const letterN = "\u{1F1F3}";
    const s1 = classify.fromSent({ text: `visit ${canada}` })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: `visit ${china}` })[0];
    const done2 = classify.fromResult({ is_error: false, result: "reply-two" });
    const s3 = classify.fromSent({ text: `visit ${us}` })[0];
    const done3 = classify.fromResult({ is_error: false, result: "reply-three" });
    const groups = groupTurns(foldTranscript([s1, ...done1, s2, ...done2, s3, ...done3]));
    expect(filterGroups(groups, { q: letterC })).toEqual([]);
    expect(filterGroups(groups, { q: letterN })).toEqual([]);
    const filtered = filterGroups(groups, { q: china });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(china))).toBe(true);
  });

  it("filterGroups: the first UTF-16 half of a flag does not keep every flag turn", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const half = china.slice(0, 1);
    const s1 = classify.fromSent({ text: `visit ${canada}` })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: `visit ${china}` })[0];
    const done2 = classify.fromResult({ is_error: false, result: "reply-two" });
    const s3 = classify.fromSent({ text: `visit ${us}` })[0];
    const done3 = classify.fromResult({ is_error: false, result: "reply-three" });
    const groups = groupTurns(foldTranscript([s1, ...done1, s2, ...done2, s3, ...done3]));
    expect(filterGroups(groups, { q: half })).toEqual([]);
    const filtered = filterGroups(groups, { q: china });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(china))).toBe(true);
  });

  it("filterGroups: clipped leftover prefix or first-half flag must not keep another padded flag turn", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const half = "\uD83C";
    const groups = groupTurns([
      { type: "user", text: `${"x".repeat(199)}${canada}` },
      { type: "user", text: `${"x".repeat(200)}${us}` },
      { type: "user", text: `${"x".repeat(200)}${china}` },
    ]);
    expect(filterGroups(groups, { q: `${"x".repeat(199)}${half}` })).toEqual([]);
    expect(filterGroups(groups, { q: `${"x".repeat(200)}${half}` })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("filterGroups: 200x then a half or full flag must not keep another padded flag turn", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const letter = "\u{1F1E8}";
    const prefix = "x".repeat(200);
    const qHalf = `${prefix}${letter}`;
    const qFull = `${prefix}${china}`;
    const s1 = classify.fromSent({ text: `${prefix}${canada}` })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: `${prefix}${us}` })[0];
    const done2 = classify.fromResult({ is_error: false, result: "reply-two" });
    const s3 = classify.fromSent({ text: `${prefix}${china}` })[0];
    const done3 = classify.fromResult({ is_error: false, result: "reply-three" });
    const groups = groupTurns(foldTranscript([s1, ...done1, s2, ...done2, s3, ...done3]));
    expect(
      filterGroups(groups, { q: qHalf }).some((g) =>
        g.rows.some((r) => r.type === "user" && (r.text.includes(canada) || r.text.includes(us))),
      ),
    ).toBe(false);
    expect(
      filterGroups(groups, { q: qFull }).some((g) =>
        g.rows.some((r) => r.type === "user" && (r.text.includes(canada) || r.text.includes(us))),
      ),
    ).toBe(false);
    expect(filterGroups(groups, { q: qHalf })).toEqual([]);
    // fromSent clips summaries at 200 units, so the folded rows no longer
    // contain the flag. Complete 🇨🇳 must still match a row that kept it.
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("filterGroups: clipped leftover second-half flag must not keep padded Canada or US turns", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const secondHalf = china.slice(1, 2);
    const groups = groupTurns([
      { type: "user", text: `${"x".repeat(200)}${canada}` },
      { type: "user", text: `${"x".repeat(200)}${us}` },
      { type: "user", text: `${"x".repeat(200)}${china}` },
    ]);
    expect(filterGroups(groups, { q: `${"x".repeat(200)}${secondHalf}` })).toEqual([]);
    expect(filterGroups(groups, { q: `${"x".repeat(201)}${secondHalf}` })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("filterGroups: a single regional indicator U+1F1E8 does not keep any complete flag turn", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const france = "\u{1F1EB}\u{1F1F7}";
    const letter = "\u{1F1E8}";
    const s1 = classify.fromSent({ text: `visit ${canada}` })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: `visit ${china}` })[0];
    const done2 = classify.fromResult({ is_error: false, result: "reply-two" });
    const s3 = classify.fromSent({ text: `visit ${us}` })[0];
    const done3 = classify.fromResult({ is_error: false, result: "reply-three" });
    const s4 = classify.fromSent({ text: `visit ${france}` })[0];
    const groups = groupTurns(foldTranscript([s1, ...done1, s2, ...done2, s3, ...done3, s4]));
    expect(filterGroups(groups, { q: letter })).toEqual([]);
    const filtered = filterGroups(groups, { q: china });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(china))).toBe(true);
  });

  it("filterGroups: leftover prefix after a dropped half-flag tail must not keep other flags", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const letter = "\u{1F1E8}";
    const half = "\uD83C";
    const groups = groupTurns([
      { type: "user", text: `${"x".repeat(200)}${canada}` },
      { type: "user", text: `${"x".repeat(200)}${us}` },
      { type: "user", text: `${"x".repeat(200)}${china}` },
    ]);
    expect(filterGroups(groups, { q: `${"x".repeat(201)}${letter}` })).toEqual([]);
    expect(filterGroups(groups, { q: `${"x".repeat(201)}${half}` })).toEqual([]);
    expect(filterGroups(groups, { q: `${"x".repeat(202)}${letter}` })).toEqual([]);
    expect(
      filterGroups(groups, { q: `${"x".repeat(201)}${china}` }).some((g) =>
        g.rows.some((r) => r.type === "user" && (r.text.includes(canada) || r.text.includes(us))),
      ),
    ).toBe(false);
    const wordGroups = groupTurns([
      { type: "user", text: `${"x".repeat(197)}${canada}` },
      { type: "user", text: `${"x".repeat(197)}${us}` },
    ]);
    expect(filterGroups(wordGroups, { q: `${"x".repeat(197)} a${letter}` })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("filterGroups: 195x U+00AD + alpha-turn-unique keeps only that turn", () => {
    const connected = { kind: "working" as const, summary: "connected", extra: {} };
    const s1 = classify.fromSent({ text: "alpha-turn-unique" })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: "beta-other" })[0];
    const done2 = classify.fromResult({ is_error: false, result: "reply-two" });
    const groups = groupTurns(foldTranscript([connected, s1, ...done1, s2, ...done2]));
    const q = `${"­".repeat(195)}alpha-turn-unique`;
    expect(sanitizeQuery({ q }).needle).toBe("alpha-turn-unique");
    expect(sanitizeQuery({ q }).needle).not.toBe("alpha-turn-uniqu");
    const filtered = filterGroups(groups, { q });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes("alpha-turn-unique"))).toBe(
      true,
    );
  });

  it("filterGroups: 👨‍👩‍👧 query keeps the family turn and drops a lone-👨 turn", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const s1 = classify.fromSent({ text: `see ${family}` })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: `adult \u{1F468}` })[0];
    const done2 = classify.fromResult({ is_error: false, result: "reply-two" });
    const groups = groupTurns(foldTranscript([s1, ...done1, s2, ...done2]));
    const q = `${"x".repeat(190)}${family}`;
    expect(sanitizeQuery({ q }).needle).toContain("‍");
    expect(sanitizeQuery({ q }).needle).toContain(family);
    const filtered = filterGroups(groups, { q: family });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(family))).toBe(true);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes("adult"))).toBe(false);
  });
});
