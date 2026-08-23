import { describe, expect, it } from "vitest";
import type { FoldedRow } from "../web/src/lib/fold-transcript.js";
import {
  QUERY_MAX_LEN,
  filterGroups,
  filterRows,
  sanitizeQuery,
} from "../web/src/lib/timeline-filter.js";
import { groupTurns } from "../web/src/lib/timeline-turn.js";

describe("sanitizeQuery", () => {
  it("clips q to QUERY_MAX_LEN", () => {
    const q = "x".repeat(QUERY_MAX_LEN + 50);
    const s = sanitizeQuery({ q });
    expect(s.needle).toBe("x".repeat(QUERY_MAX_LEN));
    expect(s.needle.length).toBe(QUERY_MAX_LEN);
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
});
