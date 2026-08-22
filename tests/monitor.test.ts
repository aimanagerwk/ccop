import { describe, expect, it } from "vitest";
import { DEFAULT_WAIT_KINDS } from "../src/wait.js";
import {
  DEFAULT_MONITOR_KINDS,
  DEFAULT_MONITOR_STALL_SEC,
  futureEvents,
  isOddSubtle,
  isPostToolUseFailure,
  matchMonitorEvent,
  matchMonitorPoll,
  matchMonitorStall,
  matchMonitorStart,
  monitorOk,
  parseMonitorStall,
  parseMonitorTimeout,
} from "../src/monitor.js";

const ev = (ts: number, kind: string, extra?: Record<string, unknown>) => ({
  ts,
  kind,
  summary: kind,
  extra: extra ?? {},
});

describe("parseMonitor", () => {
  it("stall defaults to 180, timeout to 3600", () => {
    expect(parseMonitorStall(undefined)).toBe(DEFAULT_MONITOR_STALL_SEC);
    expect(parseMonitorStall("")).toBe(180);
    expect(parseMonitorStall(-3)).toBe(180);
    expect(parseMonitorStall(12)).toBe(12);
    expect(parseMonitorStall("90")).toBe(90);
    expect(parseMonitorTimeout(undefined)).toBe(3600);
    expect(parseMonitorTimeout("15")).toBe(15);
  });

  it("default kinds match wait defaults", () => {
    expect(DEFAULT_MONITOR_KINDS).toEqual(DEFAULT_WAIT_KINDS);
    expect(DEFAULT_MONITOR_KINDS).toContain("turn_done");
  });
});

describe("odd matcher", () => {
  it("PostToolUseFailure in summary or hook", () => {
    expect(isPostToolUseFailure({ kind: "working", summary: "PostToolUseFailure Bash", extra: { hook: "PostToolUseFailure" } })).toBe(
      true,
    );
    expect(isPostToolUseFailure({ kind: "working", summary: "tool", extra: { hook: "PostToolUseFailure" } })).toBe(true);
    expect(isOddSubtle({ kind: "working", summary: "PostToolUseFailure", extra: {} })).toBe(true);
    expect(isPostToolUseFailure({ kind: "working", summary: "PostToolUse", extra: { hook: "PostToolUse" } })).toBe(false);
  });

  it("normal progress kinds are not subtle-odd", () => {
    for (const kind of ["working", "sent", "idle", "turn_done", "task_done", "interrupted", "held"]) {
      expect(isOddSubtle(ev(1, kind))).toBe(false);
    }
    expect(isOddSubtle({ kind: "working", summary: "thinking_tokens", extra: {} })).toBe(false);
  });

  it("turn_done is a wait-kind wake (not continue-only)", () => {
    const e = ev(5, "turn_done");
    const hit = matchMonitorEvent(e, DEFAULT_MONITOR_KINDS, 1);
    expect(hit).toMatchObject({ hit: true, woke: "turn_done", reason: "turn_done", event: e });
  });

  it("working PostToolUseFailure wakes even though working is not a wait kind", () => {
    const e = { ts: 9, kind: "working", summary: "PostToolUseFailure Write", extra: { hook: "PostToolUseFailure" } };
    const hit = matchMonitorEvent(e, DEFAULT_MONITOR_KINDS, 1);
    expect(hit).toMatchObject({ hit: true, woke: "PostToolUseFailure", reason: "PostToolUseFailure" });
  });

  it("future-only: history at afterTs is ignored", () => {
    expect(matchMonitorEvent(ev(10, "turn_done"), DEFAULT_MONITOR_KINDS, 10).hit).toBe(false);
    expect(futureEvents([ev(10, "sent"), ev(11, "working")], 10)).toEqual([ev(11, "working")]);
  });
});

describe("stall", () => {
  it("fires when alive and no new event for stall seconds", () => {
    const m = matchMonitorStall({ alive: true, found: true }, 1000, 1000 + 180_000, 180);
    expect(m).toMatchObject({ hit: true, woke: "stall", reason: "stall" });
  });

  it("does not fire before the stall window", () => {
    expect(matchMonitorStall({ alive: true, found: true }, 1000, 1000 + 179_999, 180).hit).toBe(false);
  });

  it("does not fire when session is dead (dead is a separate wake)", () => {
    expect(matchMonitorStall({ alive: false, found: true }, 0, 1_000_000, 1).hit).toBe(false);
  });

  it("poll: new non-wake events reset stall this tick", () => {
    const events = [ev(1, "sent"), ev(2, "working")];
    const r = matchMonitorPoll(
      { events, pending: [], alive: true, found: true },
      DEFAULT_MONITOR_KINDS,
      1,
      0,
      1_000_000,
      1,
    );
    expect(r.news).toEqual([ev(2, "working")]);
    expect(r.match.hit).toBe(false);
  });

  it("poll: no news + elapsed stall wakes stall", () => {
    const r = matchMonitorPoll(
      { events: [ev(1, "working")], pending: [], alive: true, found: true },
      DEFAULT_MONITOR_KINDS,
      1,
      0,
      5000,
      1,
    );
    expect(r.news).toEqual([]);
    expect(r.match).toMatchObject({ hit: true, woke: "stall" });
  });
});

describe("matchMonitor start/poll/ok", () => {
  it("start: dead or pending", () => {
    expect(
      matchMonitorStart({ events: [ev(1, "sent")], pending: [], alive: false, found: true }),
    ).toMatchObject({ hit: true, woke: "dead", reason: "dead" });
    const pending = [{ tool_use_id: "toolu_1", tool: "Write" }];
    expect(
      matchMonitorStart({ events: [ev(1, "needs_decision")], pending, alive: true, found: true }),
    ).toMatchObject({ hit: true, woke: "needs_decision", reason: "pending", pending });
  });

  it("poll: turn_done among future events", () => {
    const events = [ev(5, "working"), ev(6, "turn_done")];
    const r = matchMonitorPoll({ events, pending: [], alive: true, found: true }, DEFAULT_MONITOR_KINDS, 5, 100, 110, 180);
    expect(r.match).toMatchObject({ hit: true, woke: "turn_done", reason: "turn_done" });
  });

  it("monitorOk shape includes reason", () => {
    const event = ev(9, "failed");
    expect(monitorOk("sess", { hit: true, woke: "failed", reason: "failed", event })).toEqual({
      ok: true,
      id: "sess",
      woke: "failed",
      reason: "failed",
      event,
    });
  });
});
