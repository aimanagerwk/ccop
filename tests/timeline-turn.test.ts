import { describe, expect, it } from "vitest";
import type { FoldedRow } from "../web/src/lib/fold-transcript.js";
import { flattenTimeline, groupTurns } from "../web/src/lib/timeline-turn.js";

const localNoon = (y: number, m: number, d: number): number =>
  new Date(y, m, d, 12, 0, 0).getTime() / 1000;

describe("groupTurns", () => {
  it("does not mutate input", () => {
    const rows: FoldedRow[] = [
      { type: "system", items: ["已连接"] },
      { type: "user", text: "hi" },
      { type: "assistant", text: "ok" },
    ];
    const snapshot = structuredClone(rows);
    Object.freeze(rows);
    Object.freeze(rows[0]);
    Object.freeze(rows[1]);
    Object.freeze(rows[2]);
    const groups = groupTurns(rows);
    expect(groups).toHaveLength(2);
    expect(rows).toEqual(snapshot);
    expect(Object.isFrozen(rows)).toBe(true);
    expect(groups[0].rows[0]).toBe(rows[0]);
    expect(groups[1].rows[0]).toBe(rows[1]);
  });

  it("returns empty array for empty rows", () => {
    expect(groupTurns([])).toEqual([]);
  });

  it("puts leading system and thinking rows into prelude turn 0", () => {
    const sys: FoldedRow = { type: "system", items: ["已连接"] };
    const think: FoldedRow = { type: "thinking", n: 2 };
    const user: FoldedRow = { type: "user", text: "hi" };
    const groups = groupTurns([sys, think, user]);
    expect(groups).toHaveLength(2);
    expect(groups[0].turnId).toBe(0);
    expect(groups[0].rows).toEqual([sys, think]);
    expect(groups[0].rows[0]).toBe(sys);
    expect(groups[0].rows[1]).toBe(think);
    expect(groups[1].turnId).toBe(1);
    expect(groups[1].rows[0]).toBe(user);
  });

  it("starts a new turn on each user row", () => {
    const a: FoldedRow = { type: "user", text: "one" };
    const b: FoldedRow = { type: "user", text: "two" };
    const groups = groupTurns([a, b]);
    expect(groups.map((g) => g.turnId)).toEqual([1, 2]);
    expect(groups[0].rows).toEqual([a]);
    expect(groups[1].rows).toEqual([b]);
  });

  it("keeps tool thinking and assistant rows in the current turn", () => {
    const user: FoldedRow = { type: "user", text: "do" };
    const think: FoldedRow = { type: "thinking", n: 1 };
    const tool: FoldedRow = { type: "tool", name: "Read", detail: "a.ts", input: {} };
    const asst: FoldedRow = { type: "assistant", text: "done" };
    const groups = groupTurns([user, think, tool, asst]);
    expect(groups).toHaveLength(1);
    expect(groups[0].turnId).toBe(1);
    expect(groups[0].rows).toEqual([user, think, tool, asst]);
  });

  it("does not split on assistant that came from turn_done", () => {
    const user: FoldedRow = { type: "user", text: "q" };
    const asst: FoldedRow = { type: "assistant", text: "from turn_done" };
    const groups = groupTurns([user, asst]);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toEqual([user, asst]);
  });

  it("treats the next user as the previous turn boundary", () => {
    const u1: FoldedRow = { type: "user", text: "first" };
    const asst: FoldedRow = { type: "assistant", text: "reply" };
    const u2: FoldedRow = { type: "user", text: "second" };
    const groups = groupTurns([u1, asst, u2]);
    expect(groups).toHaveLength(2);
    expect(groups[0].rows).toEqual([u1, asst]);
    expect(groups[1].rows).toEqual([u2]);
    expect(groups[0].turnId).toBe(1);
    expect(groups[1].turnId).toBe(2);
  });

  it("omits empty prelude when the first row is user", () => {
    const user: FoldedRow = { type: "user", text: "hi" };
    const groups = groupTurns([user]);
    expect(groups).toHaveLength(1);
    expect(groups[0].turnId).toBe(1);
    expect(groups[0].rows[0]).toBe(user);
  });

  it("copies startTs and endTs only from finite row ts", () => {
    const rows: FoldedRow[] = [
      { type: "user", text: "a", ts: 10 },
      { type: "assistant", text: "b" },
      { type: "assistant", text: "c", ts: 12 },
    ];
    const [g] = groupTurns(rows);
    expect(g.startTs).toBe(10);
    expect(g.endTs).toBe(12);
  });

  it("does not invent startTs when no row has ts", () => {
    const [g] = groupTurns([{ type: "user", text: "x" }]);
    expect(g).not.toHaveProperty("startTs");
    expect(g).not.toHaveProperty("endTs");
    expect(g).not.toHaveProperty("dayKey");
  });

  it("assigns incremental turnId starting at 1 after prelude", () => {
    const rows: FoldedRow[] = [
      { type: "system", items: ["init"] },
      { type: "user", text: "one" },
      { type: "user", text: "two" },
      { type: "user", text: "three" },
    ];
    expect(groupTurns(rows).map((g) => g.turnId)).toEqual([0, 1, 2, 3]);
  });
});

describe("flattenTimeline", () => {
  it("inserts a day item when dayKey changes", () => {
    const t1 = localNoon(2026, 7, 22);
    const t2 = localNoon(2026, 7, 23);
    const groups = groupTurns([
      { type: "user", text: "a", ts: t1 },
      { type: "user", text: "b", ts: t2 },
    ]);
    const items = flattenTimeline(groups);
    const days = items.filter((it) => it.kind === "day");
    expect(days).toEqual([
      { kind: "day", dayKey: "2026-08-22", label: "2026-08-22" },
      { kind: "day", dayKey: "2026-08-23", label: "2026-08-23" },
    ]);
  });

  it("emits a turn-head before each group's rows", () => {
    const u1: FoldedRow = { type: "user", text: "a" };
    const asst: FoldedRow = { type: "assistant", text: "b" };
    const u2: FoldedRow = { type: "user", text: "c" };
    const items = flattenTimeline(groupTurns([u1, asst, u2]));
    expect(items.map((it) => it.kind)).toEqual(["turn-head", "row", "row", "turn-head", "row"]);
    expect(items[0]).toMatchObject({ kind: "turn-head", turnId: 1, count: 2 });
    expect(items[1]).toMatchObject({ kind: "row", turnId: 1, row: u1 });
    expect((items[1] as { row: FoldedRow }).row).toBe(u1);
    expect(items[3]).toMatchObject({ kind: "turn-head", turnId: 2, count: 1 });
  });

  it("prelude still emits turn-head for turnId 0", () => {
    const sys: FoldedRow = { type: "system", items: ["已连接"] };
    const items = flattenTimeline(groupTurns([sys]));
    expect(items[0]).toEqual({ kind: "turn-head", turnId: 0, count: 1 });
    expect(items[1]).toMatchObject({ kind: "row", turnId: 0, row: sys });
  });
});
