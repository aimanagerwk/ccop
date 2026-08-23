import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { formatDateTimeAttr, formatDayLabel, toEpochMs } from "../web/src/lib/format-ts.js";
import type { FoldedRow } from "../web/src/lib/fold-transcript.js";
import { flattenTimeline, groupTurns } from "../web/src/lib/timeline-turn.js";

afterEach(() => {
  delete (Object.prototype as { hacked?: unknown }).hacked;
  delete (Object.prototype as { polluted?: unknown }).polluted;
});

describe("timeline timestamp security", () => {
  it("formatDateTimeAttr never returns a non-ISO string for hostile numeric ts", () => {
    const hostiles = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      -1,
      0,
      1e16,
      1e20,
      8.64e15 + 1,
      1e12 + 0.5,
    ];
    for (const ts of hostiles) {
      const v = formatDateTimeAttr(ts);
      if (v !== undefined) {
        expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
        expect(v).toBe(new Date(v).toISOString());
        expect(v).not.toBe(String(ts));
      }
    }
    expect(formatDateTimeAttr(Number.NaN)).toBeUndefined();
    expect(formatDateTimeAttr(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("formatDayLabel output is plain text and contains no markup", () => {
    const label = formatDayLabel(1_787_403_750.285);
    expect(label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(label).not.toMatch(/[<>&'"/\\]/);
    expect(formatDayLabel()).toBeUndefined();
    expect(formatDayLabel(Number.NaN)).toBeUndefined();
  });

  it("toEpochMs ignores inherited ts on poisoned objects", () => {
    const poisoned = Object.create({ ts: 1_787_403_750 });
    expect(toEpochMs(poisoned as unknown as number)).toBeUndefined();
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it("Transcript.tsx dateTime 源码扫描", () => {
    const src = readFileSync(new URL("../web/src/components/Transcript.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    expect(src).toMatch(/formatDateTimeAttr\(row\.ts\)/);
    expect(src).not.toMatch(/String\(row\.ts\)/);
  });
});

const GROUP_ALLOW = new Set(["turnId", "startTs", "endTs", "dayKey", "rows"]);

describe("groupTurns security", () => {
  it("ignores inherited type on poisoned row prototype", () => {
    const proto = { type: "user", text: "inherited" };
    const poisoned = Object.create(proto) as FoldedRow;
    Object.defineProperty(poisoned, "items", { value: ["sys"], enumerable: true });
    const user: FoldedRow = { type: "user", text: "real" };
    const groups = groupTurns([poisoned, user]);
    expect(groups).toHaveLength(2);
    expect(groups[0].turnId).toBe(0);
    expect(groups[0].rows[0]).toBe(poisoned);
    expect(groups[1].turnId).toBe(1);
    expect(groups[1].rows[0]).toBe(user);
  });

  it("group keys are only the allowlist", () => {
    const groups = groupTurns([
      { type: "user", text: "a", ts: 10 },
      { type: "assistant", text: "b", ts: 11 },
    ]);
    expect(groups).toHaveLength(1);
    expect(Object.keys(groups[0]).every((k) => GROUP_ALLOW.has(k))).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(groups[0], "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(groups[0], "constructor")).toBe(false);
  });

  it("does not copy tool input output or extra onto the group", () => {
    const tool: FoldedRow = {
      type: "tool",
      name: "Read",
      detail: "a.ts",
      input: { file_path: "/secret" },
      output: { content: "stolen" },
      tool_use_id: "t1",
    };
    const extraRow = Object.assign({ type: "user", text: "hi" }, { extra: { token: "x" } }) as FoldedRow;
    const [g] = groupTurns([extraRow, tool]);
    expect(g).not.toHaveProperty("input");
    expect(g).not.toHaveProperty("output");
    expect(g).not.toHaveProperty("extra");
    expect(g).not.toHaveProperty("tool_use_id");
    expect(g).not.toHaveProperty("name");
    expect(g).not.toHaveProperty("text");
    expect(Object.keys(g).every((k) => GROUP_ALLOW.has(k))).toBe(true);
  });

  it("JSON proto payload cannot pollute Object.prototype", () => {
    const payload = JSON.parse(
      '{"type":"user","text":"hi","__proto__":{"hacked":true},"constructor":{"prototype":{"polluted":true}}}',
    ) as FoldedRow;
    const groups = groupTurns([payload]);
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(groups[0], "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(groups[0], "constructor")).toBe(false);
    expect(Object.keys(groups[0]).every((k) => GROUP_ALLOW.has(k))).toBe(true);
  });

  it("does not read constructor or prototype as grouping keys", () => {
    const row = {
      type: "assistant",
      text: "nope",
      constructor: "user",
      prototype: "user",
    } as unknown as FoldedRow;
    const groups = groupTurns([row]);
    expect(groups).toHaveLength(1);
    expect(groups[0].turnId).toBe(0);
    expect(groups[0].rows[0]).toBe(row);
  });
});

describe("flattenTimeline security", () => {
  it("items never include __proto__ or constructor keys", () => {
    const groups = groupTurns([
      { type: "system", items: ["已连接"], ts: 10 },
      { type: "user", text: "hi", ts: 11 },
    ]);
    const items = flattenTimeline(groups);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(Object.prototype.hasOwnProperty.call(item, "__proto__")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(item, "constructor")).toBe(false);
      expect(Object.keys(item)).not.toContain("__proto__");
      expect(Object.keys(item)).not.toContain("constructor");
    }
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
  });
});
