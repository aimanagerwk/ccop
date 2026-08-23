import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { FoldedRow } from "../web/src/lib/fold-transcript.js";
import {
  QUERY_MAX_LEN,
  filterRows,
  haystackHas,
  rowVisibleText,
  sanitizeQuery,
} from "../web/src/lib/timeline-filter.js";

afterEach(() => {
  delete (Object.prototype as { hacked?: unknown }).hacked;
  delete (Object.prototype as { polluted?: unknown }).polluted;
});

describe("timeline-filter security", () => {
  it("sanitizeQuery does not compile q as a RegExp", () => {
    const src = readFileSync(new URL("../web/src/lib/timeline-filter.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/new RegExp/);
    expect(src).not.toMatch(/RegExp\s*\(/);
    const s = sanitizeQuery({ q: ".*+?^${}()|[]\\" });
    expect(s.needle).toBe(".*+?^${}()|[]\\");
    expect(s.needle).not.toBeInstanceOf(RegExp);
  });

  it("haystackHas is literal and does not backtrack on long repeated characters", () => {
    const hay = "a".repeat(200_000);
    const needle = `${"a".repeat(80)}b`;
    const t0 = performance.now();
    expect(haystackHas(hay, needle)).toBe(false);
    expect(haystackHas(hay, "a")).toBe(true);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it("pathological pattern string is treated as needles not a regex", () => {
    const hay = "a".repeat(80_000);
    const needle = "((((a+)+)+)+)+b";
    const t0 = performance.now();
    expect(haystackHas(hay, needle)).toBe(false);
    expect(haystackHas("((((a+)+)+)+)+b extra", needle)).toBe(true);
    expect(filterRows([{ type: "user", text: hay }], { q: "^(a+)+$" })).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it("script tag in query does not become markup in any return value", () => {
    const q = "<script>alert(1)</script>";
    const s = sanitizeQuery({ q });
    expect(s.needle).toBe(q);
    expect(s.needle).not.toMatch(/<mark>/i);
    expect(JSON.stringify(s)).not.toMatch(/<html/i);
    const row: FoldedRow = { type: "user", text: q };
    const hits = filterRows([row], { q });
    expect(hits).toEqual([row]);
    expect(hits[0]).toBe(row);
    expect(rowVisibleText(row)).toEqual([q]);
  });

  it("query longer than QUERY_MAX_LEN is clipped before scan", () => {
    const unique = "UNIQUE_TAIL_TOKEN";
    const q = `${"z".repeat(QUERY_MAX_LEN)}${unique}`;
    const s = sanitizeQuery({ q });
    expect(s.needle.length).toBeLessThanOrEqual(QUERY_MAX_LEN);
    expect(s.needle).not.toContain(unique);
    const row: FoldedRow = { type: "user", text: unique };
    expect(filterRows([row], { q })).toEqual([]);
    expect(filterRows([row], { q: unique })).toEqual([row]);
  });

  it("zero-width padded query still matches the trailing word and never compiles q as RegExp", () => {
    const src = readFileSync(new URL("../web/src/lib/timeline-filter.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/new RegExp/);
    expect(src).not.toMatch(/RegExp\s*\(/);
    const q = `${"\u200b".repeat(195)}needle`;
    const s = sanitizeQuery({ q });
    expect(s.needle).toBe("needle");
    expect(s.needle).not.toBeInstanceOf(RegExp);
    const miss: FoldedRow = { type: "user", text: "nothing relevant" };
    const hit: FoldedRow = { type: "user", text: "has needle inside" };
    expect(filterRows([miss], { q })).toEqual([]);
    expect(filterRows([hit], { q })).toEqual([hit]);
  });

  it("BOM ZWJ and word-joiner prefixes do not eat the clip budget or match every row", () => {
    const q = `${"\ufeff".repeat(80)}${"\u200d".repeat(80)}${"\u2060".repeat(35)}needle`;
    const s = sanitizeQuery({ q });
    expect(s.needle).toBe("needle");
    expect(s.needle).not.toBe("");
    const miss: FoldedRow = { type: "user", text: "nothing relevant" };
    const hit: FoldedRow = { type: "user", text: "has needle inside" };
    expect(filterRows([miss], { q })).toEqual([]);
    expect(filterRows([hit], { q })).toEqual([hit]);
  });

  it("soft-hyphen padded query still matches the trailing word and never compiles q as RegExp", () => {
    const src = readFileSync(new URL("../web/src/lib/timeline-filter.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/new RegExp/);
    expect(src).not.toMatch(/RegExp\s*\(/);
    const q = `${"­".repeat(195)}needle`;
    const s = sanitizeQuery({ q });
    expect(s.needle).toBe("needle");
    const miss: FoldedRow = { type: "user", text: "nothing relevant" };
    const hit: FoldedRow = { type: "user", text: "has needle inside" };
    expect(filterRows([miss], { q })).toEqual([]);
    expect(filterRows([hit], { q })).toEqual([hit]);
  });

  it("a padded China flag never matches a Canada flag via a half regional indicator", () => {
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
  });

  it("a padded ZWJ family matches the family row and not a stripped adult-only row", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const q = `${"x".repeat(190)}${family}`;
    expect(sanitizeQuery({ q }).needle).toContain("‍");
    expect(sanitizeQuery({ q }).needle).toContain(family);
    const familyRow: FoldedRow = { type: "user", text: family };
    const adult: FoldedRow = { type: "user", text: "\u{1F468}" };
    expect(filterRows([familyRow], { q: family })).toEqual([familyRow]);
    expect(filterRows([{ type: "user", text: q }], { q })).toEqual([{ type: "user", text: q }]);
    expect(filterRows([adult], { q: family })).toEqual([]);
  });

  it("clipping 199 BMP chars plus a thumbs-up does not leave a lone surrogate", () => {
    const thumb = "\u{1F44D}";
    const q = `${"x".repeat(199)}${thumb}`;
    expect(q.length).toBe(201);
    const s = sanitizeQuery({ q });
    expect(s.needle).not.toBe("");
    expect(s.needle).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(s.needle.endsWith(thumb) || haystackHas(thumb, s.needle)).toBe(true);
  });

  it("3MB tool output is clipped to ~64k and not pushed raw", () => {
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
    const texts = rowVisibleText(row);
    const joined = texts.join("");
    expect(joined.length).toBeLessThan(100_000);
    expect(joined.length).toBeGreaterThan(50_000);
    expect(joined).toContain("AAA");
    expect(joined).not.toContain(unique);
    expect(texts.some((t) => t.length > 2 * 1024 * 1024)).toBe(false);
    expect(filterRows([row], { q: "AAA" })).toEqual([row]);
    expect(filterRows([row], { q: unique })).toEqual([]);
    expect(filterRows([row], { q: "huge.bin" })).toEqual([row]);
  });

  it("base64 data field is not visible text", () => {
    const b64 = "YmFzZTY0c2VjcmV0";
    const longB64 = "B".repeat(300);
    const shortShown = "short-shown-token";
    const user = Object.assign({ type: "user" as const, text: "hi" }, { data: b64, source: b64 });
    const tool: FoldedRow = {
      type: "tool",
      name: "Read",
      detail: "x",
      input: { data: longB64, source: longB64 },
      output: { data: longB64 },
    };
    const shown: FoldedRow = {
      type: "tool",
      name: "Read",
      detail: "x",
      input: { note: shortShown },
      output: { content: "AAAA" },
    };
    expect(rowVisibleText(user as FoldedRow).join("")).not.toContain(b64);
    expect(rowVisibleText(tool).join("")).not.toContain(longB64);
    expect(filterRows([user as FoldedRow, tool], { q: b64 })).toEqual([]);
    expect(filterRows([user as FoldedRow, tool], { q: longB64.slice(0, 40) })).toEqual([]);
    expect(filterRows([shown], { q: shortShown })).toEqual([shown]);
    expect(filterRows([shown], { q: "AAAA" })).toEqual([shown]);
  });

  it("inherited proto keys on row are not searched", () => {
    const proto = { text: "secret-inherited", name: "Evil", detail: "leak", type: "user", items: ["proto-item"] };
    const poisoned = Object.create(proto) as FoldedRow;
    Object.defineProperty(poisoned, "type", { value: "thinking", enumerable: true });
    Object.defineProperty(poisoned, "n", { value: 1, enumerable: true });
    expect(rowVisibleText(poisoned).join("")).not.toContain("secret");
    expect(rowVisibleText(poisoned).join("")).not.toContain("Evil");
    expect(rowVisibleText(poisoned).join("")).not.toContain("leak");
    expect(rowVisibleText(poisoned).join("")).not.toContain("proto-item");
    expect(filterRows([poisoned], { q: "secret-inherited" })).toEqual([]);
    expect(filterRows([poisoned], { q: "思考" })).toEqual([poisoned]);
  });

  it("Object.prototype is not polluted by poisoned query objects", () => {
    const payload = JSON.parse(
      '{"q":"hi","types":["user"],"__proto__":{"hacked":true},"constructor":{"prototype":{"polluted":true}}}',
    );
    const s = sanitizeQuery(payload);
    expect(s.needle).toBe("hi");
    filterRows([{ type: "user", text: "hi" }], payload);
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(s, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(s, "constructor")).toBe(false);
  });

  it("types array containing __proto__ is ignored", () => {
    const s = sanitizeQuery({
      types: ["__proto__", "constructor", "prototype", "user"] as unknown as FoldedRow["type"][],
    });
    expect(s.types).not.toBeNull();
    expect([...s.types!]).toEqual(["user"]);
    expect(s.types!.has("user")).toBe(true);
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it("never compiles user input as RegExp; U+00AD is filler and ZWJ is not", () => {
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

  it("198x+🇨🇳 (q.length=202) cannot match 🇨🇦 via a leftover half RI", () => {
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

  it("a lone regional letter cannot match every flag; complete flags still match themselves", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const letterC = "\u{1F1E8}";
    const letterN = "\u{1F1F3}";
    const src = readFileSync(new URL("../web/src/lib/timeline-filter.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/new RegExp/);
    expect(src).not.toMatch(/RegExp\s*\(/);
    expect(haystackHas(china, letterC)).toBe(false);
    expect(haystackHas(canada, letterC)).toBe(false);
    expect(haystackHas(us, letterC)).toBe(false);
    expect(haystackHas(china, letterN)).toBe(false);
    expect(haystackHas(china, china)).toBe(true);
    expect(filterRows([{ type: "user", text: canada }], { q: letterC })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: letterC })).toEqual([]);
    expect(filterRows([{ type: "user", text: us }], { q: letterC })).toEqual([]);
    expect(filterRows([{ type: "user", text: canada }, { type: "user", text: china }, { type: "user", text: us }], { q: letterN })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("200x then a half or full flag cannot match another padded flag via a dropped tail", () => {
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
    expect(filterRows([{ type: "user", text: `${"x".repeat(198)}${canada}` }], { q: `${"x".repeat(198)}${letter}` })).toEqual([]);
    expect(filterRows([{ type: "user", text: `${"x".repeat(199)}${canada}` }], { q: `${"x".repeat(199)}${letter}` })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("195x U+00AD plus needle is the full word, not needl or a SHY-only needle", () => {
    const q = `${"­".repeat(195)}needle`;
    const s = sanitizeQuery({ q });
    expect(s.needle).toBe("needle");
    expect(s.needle).not.toBe("needl");
    expect(s.needle).not.toMatch(/^­+$/);
    const miss: FoldedRow = { type: "user", text: "nothing relevant" };
    const hit: FoldedRow = { type: "user", text: "has needle inside" };
    expect(filterRows([miss], { q })).toEqual([]);
    expect(filterRows([hit], { q })).toEqual([hit]);
  });

  it("ZWJ family 👨‍👩‍👧 stays whole so a lone 👨 does not match", () => {
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
