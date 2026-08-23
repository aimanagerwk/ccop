import { describe, expect, it } from "vitest";
import * as classify from "../src/classify.js";
import { foldTranscript } from "../web/src/lib/fold-transcript.js";
import { dayBreaks, formatDateTimeAttr, toEpochMs } from "../web/src/lib/format-ts.js";
import { filterGroups } from "../web/src/lib/timeline-filter.js";
import { flattenTimeline, groupTurns } from "../web/src/lib/timeline-turn.js";
import { DEFAULT_ROW_HEIGHT, virtualWindow, visibleSlice } from "../web/src/lib/timeline-virtual.js";
import { formatClock } from "../web/src/lib/workflow-monitor.js";

describe("timeline timestamp integration", () => {
  it("folded rows keep finite ts through formatDateTimeAttr and formatClock still prints HH:MM:SS", () => {
    const ts = 1_787_403_750.285;
    const rows = foldTranscript([{ kind: "sent", summary: "hi", ts }]);
    expect(rows).toEqual([{ type: "user", text: "hi", ts }]);
    expect(formatDateTimeAttr(rows[0].ts)).toBe(new Date(ts * 1000).toISOString());
    expect(formatClock(rows[0].ts)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("dayBreaks aligns with two rows on different local days", () => {
    const t1 = new Date(2026, 7, 22, 12, 0, 0).getTime() / 1000;
    const t2 = new Date(2026, 7, 23, 12, 0, 0).getTime() / 1000;
    const rows = foldTranscript([
      { kind: "sent", summary: "a", ts: t1 },
      { kind: "sent", summary: "b", ts: t2 },
    ]);
    const marks = dayBreaks(rows);
    expect(marks).toHaveLength(2);
    expect(marks[0]).toEqual({ index: 0, label: "2026-08-22", dayKey: "2026-08-22" });
    expect(marks[1]).toEqual({ index: 1, label: "2026-08-23", dayKey: "2026-08-23" });
  });
});

function withTs<T extends { extra: Record<string, unknown> }>(ev: T, ts: number): T & { ts: number } {
  return { ...ev, ts };
}

describe("classify-or-fold then groupTurns", () => {
  it("sent then tool then turn_done folds into one turn after the prelude", () => {
    const connected = { kind: "working" as const, summary: "connected", extra: {} };
    const sent = classify.fromSent({ text: "read it" })[0];
    const tool = classify.fromToolUse({
      name: "Read",
      tool_use_id: "tu1",
      tool_input: { file_path: "/a.ts" },
    })[0];
    const done = classify.fromResult({ is_error: false, result: "ok" });
    const rows = foldTranscript([connected, sent, tool, ...done]);
    const groups = groupTurns(rows);
    expect(groups.map((g) => g.turnId)).toEqual([0, 1]);
    expect(groups[0].rows.every((r) => r.type !== "user")).toBe(true);
    expect(groups[1].rows[0]).toMatchObject({ type: "user", text: "read it" });
    expect(groups[1].rows.some((r) => r.type === "tool")).toBe(true);
    expect(groups[1].rows.some((r) => r.type === "assistant")).toBe(true);
  });

  it("two sent events produce two turns with tools staying in the first", () => {
    const s1 = classify.fromSent({ text: "first" })[0];
    const tool = classify.fromToolUse({
      name: "Bash",
      tool_use_id: "b1",
      tool_input: { command: "echo hi" },
    })[0];
    const done = classify.fromResult({ is_error: false, result: "done" });
    const s2 = classify.fromSent({ text: "second" })[0];
    const rows = foldTranscript([s1, tool, ...done, s2]);
    const groups = groupTurns(rows);
    expect(groups.map((g) => g.turnId)).toEqual([1, 2]);
    expect(groups[0].rows[0]).toMatchObject({ type: "user", text: "first" });
    expect(groups[0].rows.some((r) => r.type === "tool")).toBe(true);
    expect(groups[1].rows).toHaveLength(1);
    expect(groups[1].rows[0]).toMatchObject({ type: "user", text: "second" });
  });

  it("leading connected init noise lands in turn 0 then user opens turn 1", () => {
    const connected = { kind: "working" as const, summary: "connected", extra: {} };
    const init = { kind: "working" as const, summary: "init", extra: {} };
    const sent = classify.fromSent({ text: "hello" })[0];
    const rows = foldTranscript([connected, init, sent]);
    const groups = groupTurns(rows);
    expect(groups.map((g) => g.turnId)).toEqual([0, 1]);
    expect(groups[0].rows[0].type).toBe("system");
    expect(groups[1].rows[0]).toMatchObject({ type: "user", text: "hello" });
  });

  it("timestamps survive classify-or-fold then groupTurns", () => {
    const tsUser = 1_787_403_750.285;
    const tsTool = tsUser + 1;
    const tsDone = tsUser + 2;
    const sent = withTs(classify.fromSent({ text: "hi" })[0], tsUser);
    const tool = withTs(
      classify.fromToolUse({
        name: "Read",
        tool_use_id: "t1",
        tool_input: { file_path: "/x.ts" },
      })[0],
      tsTool,
    );
    const done = classify.fromResult({ is_error: false, result: "ok" }).map((e, i) =>
      withTs(e, tsDone + i * 0.01),
    );
    const rows = foldTranscript([sent, tool, ...done]);
    const groups = groupTurns(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].startTs).toBe(tsUser);
    expect(typeof groups[0].endTs).toBe("number");
    expect(groups[0].endTs).toBeGreaterThanOrEqual(tsDone);
    expect(groups[0].rows[0].ts).toBe(tsUser);
    expect(formatDateTimeAttr(groups[0].startTs)).toBe(new Date(tsUser * 1000).toISOString());
  });

  it("mixed second and millisecond event ts stay chronological after classify-or-fold", () => {
    const laterSec = 1_787_404_000;
    const earlierMs = 1_787_403_750_285;
    const sent = withTs(classify.fromSent({ text: "hi" })[0], laterSec);
    const tool = withTs(
      classify.fromToolUse({
        name: "Read",
        tool_use_id: "t-mix",
        tool_input: { file_path: "/x.ts" },
      })[0],
      earlierMs,
    );
    const rows = foldTranscript([sent, tool]);
    const [g] = groupTurns(rows);
    expect(g.startTs).toBe(earlierMs);
    expect(g.endTs).toBe(laterSec);
    expect(toEpochMs(g.startTs)!).toBeLessThanOrEqual(toEpochMs(g.endTs)!);
    expect(g.startTs).not.toBe(laterSec);
  });
});

describe("filter then virtualWindow pipeline", () => {
  it("filterGroups after groupTurns keeps turnId and drops empty turns", () => {
    const connected = { kind: "working" as const, summary: "connected", extra: {} };
    const s1 = classify.fromSent({ text: "alpha" })[0];
    const tool = classify.fromToolUse({
      name: "Read",
      tool_use_id: "r1",
      tool_input: { file_path: "/a.ts" },
    })[0];
    const done = classify.fromResult({ is_error: false, result: "ok" });
    const s2 = classify.fromSent({ text: "beta" })[0];
    const rows = foldTranscript([connected, s1, tool, ...done, s2]);
    const groups = groupTurns(rows);
    expect(groups.map((g) => g.turnId)).toEqual([0, 1, 2]);
    const filtered = filterGroups(groups, { q: "alpha" });
    expect(filtered.map((g) => g.turnId)).toEqual([1]);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text === "alpha")).toBe(true);
    expect(filtered.every((g) => g.rows.length > 0)).toBe(true);
  });

  it("virtualWindow on flattenTimeline after filter stays inside item bounds", () => {
    const events = [];
    for (let i = 0; i < 40; i++) {
      events.push(classify.fromSent({ text: i % 2 === 0 ? `keep-${i}` : `drop-${i}` })[0]);
      events.push(...classify.fromResult({ is_error: false, result: `reply ${i}` }));
    }
    const rows = foldTranscript(events);
    const filtered = filterGroups(groupTurns(rows), { q: "keep" });
    const items = flattenTimeline(filtered);
    expect(items.length).toBeGreaterThan(0);
    const win = virtualWindow({
      scrollTop: 400,
      viewportHeight: 240,
      rowHeight: DEFAULT_ROW_HEIGHT,
      count: items.length,
    });
    expect(win.start).toBeGreaterThanOrEqual(0);
    expect(win.end).toBeLessThanOrEqual(items.length);
    expect(win.start).toBeLessThanOrEqual(win.end);
    const slice = visibleSlice(items, win);
    expect(slice.length).toBe(win.end - win.start);
    expect(slice.every((it) => items.includes(it))).toBe(true);
    for (const it of slice) {
      if (it.kind === "row") expect(it.turnId).toBeGreaterThanOrEqual(1);
    }
  });

  it("endScrollTop after a multi-hit filter includes the last flattened item", async () => {
    const { endScrollTop } = await import("../web/src/lib/timeline-virtual.js");
    expect(typeof endScrollTop).toBe("function");
    const events = [];
    for (let i = 0; i < 40; i++) {
      events.push(classify.fromSent({ text: `keep-${i}` })[0]);
      events.push(...classify.fromResult({ is_error: false, result: `reply ${i}` }));
    }
    const items = flattenTimeline(filterGroups(groupTurns(foldTranscript(events)), { q: "keep" }));
    expect(items.length).toBeGreaterThan(10);
    const last = items[items.length - 1];
    const stale = virtualWindow({
      scrollTop: 0,
      viewportHeight: 240,
      rowHeight: DEFAULT_ROW_HEIGHT,
      count: items.length,
      overscan: 0,
    });
    expect(visibleSlice(items, stale)).not.toContain(last);
    const win = virtualWindow({
      scrollTop: endScrollTop({
        count: items.length,
        viewportHeight: 240,
        rowHeight: DEFAULT_ROW_HEIGHT,
      }),
      viewportHeight: 240,
      rowHeight: DEFAULT_ROW_HEIGHT,
      count: items.length,
      overscan: 0,
    });
    expect(visibleSlice(items, win)).toContain(last);
  });
});
