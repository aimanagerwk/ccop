import { describe, expect, it } from "vitest";
import type { FoldedRow } from "../web/src/lib/fold-transcript.js";
import { toEpochMs } from "../web/src/lib/format-ts.js";
import {
  QUERY_MAX_LEN,
  filterGroups,
  filterRows,
  haystackHas,
  sanitizeQuery,
} from "../web/src/lib/timeline-filter.js";
import { groupTurns } from "../web/src/lib/timeline-turn.js";

describe("sanitizeQuery", () => {
  it("clips q to QUERY_MAX_LEN", () => {
    const q = "x".repeat(QUERY_MAX_LEN + 50);
    const s = sanitizeQuery({ q });
    expect(s.needle.length).toBeLessThanOrEqual(QUERY_MAX_LEN);
    expect(s.needle).toMatch(/^x+$/);
    expect(s.needle).not.toHaveLength(QUERY_MAX_LEN + 50);
  });

  it("strips U+200B fillers before clipping so a trailing word is kept", () => {
    const q = `${"\u200b".repeat(195)}needle`;
    expect(sanitizeQuery({ q }).needle).toBe("needle");
  });

  it("keeps a complete thumbs-up grapheme that sits just past QUERY_MAX_LEN", () => {
    const thumb = "\u{1F44D}";
    const q = `${"x".repeat(199)}${thumb}`;
    const needle = sanitizeQuery({ q }).needle;
    expect(needle).not.toBe("");
    expect(needle.endsWith(thumb) || haystackHas("\u{1F44D}", needle)).toBe(true);
    expect(needle).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("strips soft hyphens before clipping so a trailing word is kept", () => {
    const q = `${"­".repeat(195)}needle`;
    expect(sanitizeQuery({ q }).needle).toBe("needle");
  });

  it("keeps a complete flag grapheme so a half indicator cannot match another flag", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const q = `${"x".repeat(198)}${china}`;
    const needle = sanitizeQuery({ q }).needle;
    expect(needle.includes(china)).toBe(true);
    expect(needle.includes("\u{1F1E8}") && !needle.includes(china)).toBe(false);
    expect(filterRows([{ type: "user", text: canada }], { q })).toEqual([]);
    expect(filterRows([{ type: "user", text: q }], { q }).length).toBe(1);
  });

  it("a lone regional indicator after a full budget cannot match every flag", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const letter = "\u{1F1E8}";
    const q = `${"x".repeat(199)}${letter}`;
    const needle = sanitizeQuery({ q }).needle;
    expect(needle.endsWith(letter)).toBe(false);
    expect(haystackHas(china, letter)).toBe(false);
    expect(haystackHas(canada, letter)).toBe(false);
    expect(filterRows([{ type: "user", text: china }], { q })).toEqual([]);
    expect(filterRows([{ type: "user", text: canada }], { q })).toEqual([]);
  });

  it("a lone regional letter cannot match 🇨🇳 🇨🇦 or 🇺🇸", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const letterC = "\u{1F1E8}";
    const letterN = "\u{1F1F3}";
    expect(haystackHas(china, letterC)).toBe(false);
    expect(haystackHas(canada, letterC)).toBe(false);
    expect(haystackHas(us, letterC)).toBe(false);
    expect(haystackHas(china, letterN)).toBe(false);
    expect(haystackHas(china, china)).toBe(true);
    expect(filterRows([{ type: "user", text: canada }], { q: letterC })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: letterC })).toEqual([]);
    expect(filterRows([{ type: "user", text: us }], { q: letterC })).toEqual([]);
    expect(filterRows([{ type: "user", text: canada }], { q: letterN })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("the first UTF-16 half of a flag cannot match 🇨🇳 🇨🇦 or 🇺🇸", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const half = china.slice(0, 1);
    expect(haystackHas(china, half)).toBe(false);
    expect(haystackHas(canada, half)).toBe(false);
    expect(haystackHas(us, half)).toBe(false);
    expect(filterRows([{ type: "user", text: canada }], { q: half })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: half })).toEqual([]);
    expect(filterRows([{ type: "user", text: us }], { q: half })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("clipped leftover prefix or first-half flag cannot match other flags", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const half = "\uD83C";
    const q199 = `${"x".repeat(199)}${half}`;
    const q200 = `${"x".repeat(200)}${half}`;
    expect(filterRows([{ type: "user", text: `${"x".repeat(199)}${canada}` }], { q: q199 })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(199)}${us}` }], { q: q199 })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(200)}${canada}` }], { q: q200 })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(200)}${us}` }], { q: q200 })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(200)}${canada}` }], { q: "x".repeat(200) }).length).toBe(1);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("200x then a half or full flag cannot match another padded flag", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const letter = "\u{1F1E8}";
    const prefix = "x".repeat(200);
    const qHalf = `${prefix}${letter}`;
    const qFull = `${prefix}${china}`;
    expect(filterRows([{ type: "user", text: `${prefix}${canada}` }], { q: qHalf })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${prefix}${us}` }], { q: qHalf })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${prefix}${canada}` }], { q: qFull })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${prefix}${us}` }], { q: qFull })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(198)}${canada}` }], { q: `${"x".repeat(198)}${letter}` })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(199)}${canada}` }], { q: `${"x".repeat(199)}${letter}` })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
    expect(filterRows([{ type: "user", text: `${prefix}${canada}` }], { q: prefix }).length).toBe(1);
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

  it("after clip, a leftover prefix or dropped half-flag tail cannot match other flags", () => {
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
    const q199c = `${"x".repeat(199)}${letter}`;
    const qWord = `${"x".repeat(197)} a${letter}`;
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
    expect(filterRows([{ type: "user", text: `${"x".repeat(199)}${canada}` }], { q: q199c })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(197)}${canada}` }], { q: qWord })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(197)}${us}` }], { q: qWord })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("keeps ZWJ inside a family emoji so the original row matches", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const q = `${"x".repeat(190)}${family}`;
    expect(sanitizeQuery({ q }).needle).toContain(family);
    const row: FoldedRow = { type: "user", text: family };
    expect(filterRows([row], { q: family })).toEqual([row]);
    expect(filterRows([{ type: "user", text: q }], { q })).toEqual([{ type: "user", text: q }]);
  });

  it("198x+🇨🇳 (q.length=202) cannot match 🇨🇦 via a leftover half RI", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const q = `${"x".repeat(198)}${china}`;
    expect(q.length).toBe(202);
    const needle = sanitizeQuery({ q }).needle;
    expect(needle).not.toBe("");
    expect(needle.includes(china)).toBe(true);
    expect(needle.includes("\u{1F1E8}") && !needle.includes(china)).toBe(false);
    expect(haystackHas(canada, "\u{1F1E8}")).toBe(false);
    expect(haystackHas(canada, needle)).toBe(false);
    const paddedCanada = `${"x".repeat(198)}${canada}`;
    expect(haystackHas(paddedCanada, needle)).toBe(false);
    expect(filterRows([{ type: "user", text: canada }], { q })).toEqual([]);
    expect(filterRows([{ type: "user", text: paddedCanada }], { q })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("195x U+00AD plus needle is the full word, not needl or pure SHY", () => {
    const q = `${"­".repeat(195)}needle`;
    const needle = sanitizeQuery({ q }).needle;
    expect(needle).toBe("needle");
    expect(needle).not.toBe("needl");
    expect(needle).not.toMatch(/^­+$/);
    expect(filterRows([{ type: "user", text: "nothing relevant" }], { q })).toEqual([]);
    expect(filterRows([{ type: "user", text: "has needle inside" }], { q }).length).toBe(1);
  });

  it("ZWJ family 👨‍👩‍👧 is kept whole so a lone 👨 does not match", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const q = `${"x".repeat(190)}${family}`;
    const needle = sanitizeQuery({ q }).needle;
    expect(needle).toContain("‍");
    expect(needle).toContain(family);
    const familyRow: FoldedRow = { type: "user", text: family };
    expect(filterRows([familyRow], { q: family })).toEqual([familyRow]);
    expect(filterRows([{ type: "user", text: "\u{1F468}" }], { q: family })).toEqual([]);
  });

  it("treats non-string q as empty needle", () => {
    expect(sanitizeQuery({ q: 12 as unknown as string }).needle).toBe("");
    expect(sanitizeQuery({ q: null as unknown as string }).needle).toBe("");
    expect(sanitizeQuery({ q: { x: 1 } as unknown as string }).needle).toBe("");
  });

  it("drops unknown types", () => {
    const s = sanitizeQuery({
      types: ["user", "nope", "tool", "constructor"] as unknown as FoldedRow["type"][],
    });
    expect(s.types).not.toBeNull();
    expect([...s.types!].sort()).toEqual(["tool", "user"]);
  });

  it("empty raw matches everything", () => {
    expect(sanitizeQuery(undefined)).toEqual({ needle: "", types: null });
    expect(sanitizeQuery(null)).toEqual({ needle: "", types: null });
    expect(sanitizeQuery("hi")).toEqual({ needle: "", types: null });
    expect(sanitizeQuery({})).toEqual({ needle: "", types: null });
    expect(sanitizeQuery({ types: [] })).toEqual({ needle: "", types: null });
  });
});

describe("filterRows", () => {
  it("is case insensitive", () => {
    const row: FoldedRow = { type: "user", text: "Hello World" };
    expect(filterRows([row], { q: "hello" })).toEqual([row]);
    expect(filterRows([row], { q: "WORLD" })).toEqual([row]);
  });

  it("matches user text", () => {
    const row: FoldedRow = { type: "user", text: "please read a.ts" };
    expect(filterRows([row], { q: "read a.ts" })).toEqual([row]);
    expect(filterRows([row], { q: "missing" })).toEqual([]);
  });

  it("matches assistant text", () => {
    const row: FoldedRow = { type: "assistant", text: "done with the patch" };
    expect(filterRows([row], { q: "PATCH" })).toEqual([row]);
  });

  it("matches tool name, detail, and clipped card input/output", () => {
    const row: FoldedRow = {
      type: "tool",
      name: "Read",
      detail: "a.ts",
      input: { file_path: "/secret/hidden.ts" },
    };
    expect(filterRows([row], { q: "Read" })).toEqual([row]);
    expect(filterRows([row], { q: "a.ts" })).toEqual([row]);
    expect(filterRows([row], { q: "hidden" })).toEqual([row]);
  });

  it("matches tool input JSON", () => {
    const row: FoldedRow = {
      type: "tool",
      name: "Bash",
      detail: "echo hi",
      input: { command: "cat /etc/shadow", secret: "needle-in-input" },
    };
    expect(filterRows([row], { q: "needle-in-input" })).toEqual([row]);
    expect(filterRows([row], { q: "shadow" })).toEqual([row]);
  });

  it("matches clipped tool output but not omitted long data/source", () => {
    const row: FoldedRow = {
      type: "tool",
      name: "Read",
      detail: "img.png",
      input: {},
      output: { content: "AAAA", data: "YmFzZTY0c2VjcmV0", source: "blob" },
    };
    expect(filterRows([row], { q: "AAAA" })).toEqual([row]);
    const longB64 = "B".repeat(300);
    const omitted: FoldedRow = {
      type: "tool",
      name: "Read",
      detail: "img.png",
      input: {},
      output: { data: longB64, source: longB64 },
    };
    expect(filterRows([omitted], { q: longB64.slice(0, 40) })).toEqual([]);
  });

  it("matches system items", () => {
    const row: FoldedRow = { type: "system", items: ["已连接", "初始化"] };
    expect(filterRows([row], { q: "已连接" })).toEqual([row]);
    expect(filterRows([row], { q: "初始化" })).toEqual([row]);
    expect(filterRows([row], { q: "idle" })).toEqual([]);
  });

  it("matches the visible tail of a system item longer than 256 code units", () => {
    const tail = "TAIL_TOKEN";
    const row: FoldedRow = { type: "system", items: [`${"a".repeat(300)}${tail}`] };
    expect(filterRows([row], { q: tail })).toEqual([row]);
    expect(filterRows([row], { q: "已连接" })).toEqual([]);
  });

  it("matches thinking label", () => {
    const row: FoldedRow = { type: "thinking", n: 3 };
    expect(filterRows([row], { q: "思考" })).toEqual([row]);
    expect(filterRows([row], { q: "思考 · 3" })).toEqual([row]);
    expect(filterRows([row], { q: "思考 · 9" })).toEqual([]);
  });

  it("types filter is ANDed with needle", () => {
    const user: FoldedRow = { type: "user", text: "Read this" };
    const tool: FoldedRow = { type: "tool", name: "Read", detail: "a.ts", input: {} };
    const asst: FoldedRow = { type: "assistant", text: "Read done" };
    const rows = [user, tool, asst];
    expect(filterRows(rows, { q: "Read", types: ["tool"] })).toEqual([tool]);
    expect(filterRows(rows, { q: "Read", types: ["user"] })).toEqual([user]);
    expect(filterRows(rows, { q: "missing", types: ["tool"] })).toEqual([]);
  });

  it("does not mutate input", () => {
    const rows: FoldedRow[] = [
      { type: "user", text: "hi" },
      { type: "assistant", text: "ok" },
    ];
    const snapshot = structuredClone(rows);
    Object.freeze(rows);
    Object.freeze(rows[0]);
    Object.freeze(rows[1]);
    const out = filterRows(rows, { q: "hi" });
    expect(out).toEqual([rows[0]]);
    expect(out[0]).toBe(rows[0]);
    expect(rows).toEqual(snapshot);
    expect(Object.isFrozen(rows)).toBe(true);
    const ident = filterRows(rows);
    expect(ident).toEqual(rows);
    expect(ident).not.toBe(rows);
    expect(ident[0]).toBe(rows[0]);
  });
});

describe("filterGroups", () => {
  it("drops groups with no remaining rows", () => {
    const u1: FoldedRow = { type: "user", text: "alpha" };
    const u2: FoldedRow = { type: "user", text: "beta" };
    const groups = groupTurns([u1, u2]);
    const out = filterGroups(groups, { q: "alpha" });
    expect(out).toHaveLength(1);
    expect(out[0].turnId).toBe(1);
    expect(out[0].rows).toEqual([u1]);
    expect(out[0].rows[0]).toBe(u1);
  });

  it("recomputes startTs from remaining rows", () => {
    const rows: FoldedRow[] = [
      { type: "user", text: "keep", ts: 10 },
      { type: "assistant", text: "drop me", ts: 11 },
      { type: "assistant", text: "keep later", ts: 12 },
    ];
    const [g] = groupTurns(rows);
    expect(g.startTs).toBe(10);
    expect(g.endTs).toBe(12);
    const [out] = filterGroups([g], { q: "keep" });
    expect(out.startTs).toBe(10);
    expect(out.endTs).toBe(12);
    const [onlyLater] = filterGroups([g], { q: "later" });
    expect(onlyLater.startTs).toBe(12);
    expect(onlyLater.endTs).toBe(12);
    const noTs: FoldedRow[] = [
      { type: "user", text: "x", ts: 5 },
      { type: "assistant", text: "y" },
    ];
    const [g2] = groupTurns(noTs);
    const [filtered] = filterGroups([g2], { q: "y" });
    expect(filtered).not.toHaveProperty("startTs");
    expect(filtered).not.toHaveProperty("endTs");
    expect(filtered).not.toHaveProperty("dayKey");
  });

  it("rebuilds startTs/endTs from mixed second and millisecond remaining rows", () => {
    const laterSec = 1_787_404_000;
    const earlierMs = 1_787_403_750_285;
    const rows: FoldedRow[] = [
      { type: "user", text: "keep-sec", ts: laterSec },
      { type: "assistant", text: "drop me", ts: 11 },
      { type: "assistant", text: "keep-ms", ts: earlierMs },
    ];
    const [g] = groupTurns(rows);
    const [out] = filterGroups([g], { q: "keep" });
    expect(out.startTs).toBe(earlierMs);
    expect(out.endTs).toBe(laterSec);
    expect(toEpochMs(out.startTs)!).toBeLessThanOrEqual(toEpochMs(out.endTs)!);
  });

  it("keeps turnId of a partial hit", () => {
    const sys: FoldedRow = { type: "system", items: ["已连接"] };
    const u1: FoldedRow = { type: "user", text: "one" };
    const asst: FoldedRow = { type: "assistant", text: "reply-one" };
    const u2: FoldedRow = { type: "user", text: "two" };
    const groups = groupTurns([sys, u1, asst, u2]);
    expect(groups.map((g) => g.turnId)).toEqual([0, 1, 2]);
    const out = filterGroups(groups, { q: "reply-one" });
    expect(out).toHaveLength(1);
    expect(out[0].turnId).toBe(1);
    expect(out[0].rows).toEqual([asst]);
    expect(out[0]).not.toBe(groups[1]);
  });

  it("filterGroups: padded 🇨🇳 must not leave a 🇨🇦 turn", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const groups = groupTurns([
      { type: "user", text: `visit ${canada}` },
      { type: "user", text: `visit ${china}` },
    ]);
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
    expect(filterGroups(groups, { q: paddedCanada }).some((g) =>
      g.rows.some((r) => r.type === "user" && r.text.includes(china)),
    )).toBe(false);
    const filtered = filterGroups(groups, { q: china });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(china))).toBe(true);
  });

  it("filterGroups: a lone regional letter does not keep every flag turn", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const letterC = "\u{1F1E8}";
    const groups = groupTurns([
      { type: "user", text: `visit ${canada}` },
      { type: "user", text: `visit ${china}` },
      { type: "user", text: `visit ${us}` },
    ]);
    expect(filterGroups(groups, { q: letterC })).toEqual([]);
    expect(filterGroups(groups, { q: "\u{1F1F3}" })).toEqual([]);
    const filtered = filterGroups(groups, { q: china });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(china))).toBe(true);
  });

  it("filterGroups: 200x then a half or full flag must not keep another padded flag", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const letter = "\u{1F1E8}";
    const prefix = "x".repeat(200);
    const groups = groupTurns([
      { type: "user", text: `${prefix}${canada}` },
      { type: "user", text: `${prefix}${us}` },
      { type: "user", text: `${prefix}${china}` },
    ]);
    expect(filterGroups(groups, { q: `${prefix}${letter}` })).toEqual([]);
    expect(
      filterGroups(groups, { q: `${prefix}${china}` }).some((g) =>
        g.rows.some((r) => r.type === "user" && (r.text.includes(canada) || r.text.includes(us))),
      ),
    ).toBe(false);
    const filtered = filterGroups(groups, { q: china });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(china))).toBe(true);
  });

  it("filterGroups: a single regional indicator U+1F1E8 cannot keep any complete flag turn", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const france = "\u{1F1EB}\u{1F1F7}";
    const letter = "\u{1F1E8}";
    const groups = groupTurns([
      { type: "user", text: `visit ${canada}` },
      { type: "user", text: `visit ${china}` },
      { type: "user", text: `visit ${us}` },
      { type: "user", text: `visit ${france}` },
    ]);
    expect(filterGroups(groups, { q: letter })).toEqual([]);
    const filtered = filterGroups(groups, { q: china });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(china))).toBe(true);
  });

  it("filterGroups: leftover prefix after a dropped half-flag tail cannot keep other flags", () => {
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
    expect(filterGroups(groups, { q: `${"x".repeat(199)}${letter}` })).toEqual([]);
    const wordGroups = groupTurns([
      { type: "user", text: `${"x".repeat(197)}${canada}` },
      { type: "user", text: `${"x".repeat(197)}${us}` },
    ]);
    expect(filterGroups(wordGroups, { q: `${"x".repeat(197)} a${letter}` })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("filterGroups: 195x U+00AD + alpha-turn-unique keeps only that turn", () => {
    const groups = groupTurns([
      { type: "user", text: "alpha-turn-unique" },
      { type: "user", text: "beta-other" },
    ]);
    const q = `${"­".repeat(195)}alpha-turn-unique`;
    expect(sanitizeQuery({ q }).needle).toBe("alpha-turn-unique");
    const filtered = filterGroups(groups, { q });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes("alpha-turn-unique"))).toBe(
      true,
    );
  });

  it("filterGroups: 👨‍👩‍👧 query keeps only the family turn", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const groups = groupTurns([
      { type: "user", text: `see ${family}` },
      { type: "user", text: "adult \u{1F468}" },
    ]);
    const q = `${"x".repeat(190)}${family}`;
    expect(sanitizeQuery({ q }).needle).toContain(family);
    const filtered = filterGroups(groups, { q: family });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(family))).toBe(true);
  });
});
