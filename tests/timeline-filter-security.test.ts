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
    expect(s.needle).toBe("z".repeat(QUERY_MAX_LEN));
    expect(s.needle).not.toContain(unique);
    const row: FoldedRow = { type: "user", text: unique };
    expect(filterRows([row], { q })).toEqual([]);
    expect(filterRows([row], { q: unique })).toEqual([row]);
  });

  it("3MB tool output is not scanned and does not appear in rowVisibleText", () => {
    const blob = "A".repeat(3 * 1024 * 1024);
    const row: FoldedRow = {
      type: "tool",
      name: "Read",
      detail: "huge.bin",
      input: {},
      output: blob,
    };
    const texts = rowVisibleText(row);
    expect(texts).toEqual(["Read", "huge.bin"]);
    expect(texts.join("")).not.toContain("AAA");
    expect(filterRows([row], { q: "AAA" })).toEqual([]);
    expect(filterRows([row], { q: "huge.bin" })).toEqual([row]);
  });

  it("base64 data field is not visible text", () => {
    const b64 = "YmFzZTY0c2VjcmV0";
    const user = Object.assign({ type: "user" as const, text: "hi" }, { data: b64, source: b64 });
    const tool: FoldedRow = {
      type: "tool",
      name: "Read",
      detail: "x",
      input: { data: b64, source: b64 },
      output: { data: b64, base64: b64 },
    };
    expect(rowVisibleText(user as FoldedRow).join("")).not.toContain(b64);
    expect(rowVisibleText(tool).join("")).not.toContain(b64);
    expect(filterRows([user as FoldedRow, tool], { q: b64 })).toEqual([]);
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
});
