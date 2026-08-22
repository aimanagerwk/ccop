import { describe, expect, it } from "vitest";
import { KINDS } from "../src/classify.js";
import {
  DEFAULT_WAIT_KINDS,
  DEFAULT_WAIT_TIMEOUT_SEC,
  isUnknownWaitCmd,
  matchWaitEvents,
  matchWaitPoll,
  matchWaitStart,
  newestEventTs,
  parseWaitKinds,
  parseWaitTimeout,
  waitOk,
} from "../src/wait.js";

describe("parseWaitKinds", () => {
  it("defaults to the five wake kinds", () => {
    expect(parseWaitKinds(undefined)).toEqual({ ok: true, kinds: DEFAULT_WAIT_KINDS });
    expect(parseWaitKinds("")).toEqual({ ok: true, kinds: DEFAULT_WAIT_KINDS });
    expect(parseWaitKinds([])).toEqual({ ok: true, kinds: DEFAULT_WAIT_KINDS });
    expect(DEFAULT_WAIT_KINDS).toEqual(["needs_decision", "needs_info", "turn_done", "failed", "dead"]);
  });

  it("parses comma list and array, rejects invented kinds", () => {
    expect(parseWaitKinds("turn_done,failed")).toEqual({ ok: true, kinds: ["turn_done", "failed"] });
    expect(parseWaitKinds(["needs_info", "dead"])).toEqual({ ok: true, kinds: ["needs_info", "dead"] });
    expect(parseWaitKinds("turn_done, assistant")).toEqual({ ok: false, error: "unknown kind assistant" });
    expect(parseWaitKinds("not_a_kind")).toEqual({ ok: false, error: "unknown kind not_a_kind" });
  });

  it("only accepts classify KINDS", () => {
    for (const k of KINDS) {
      expect(parseWaitKinds(k)).toEqual({ ok: true, kinds: [k] });
    }
  });
});

describe("parseWaitTimeout", () => {
  it("defaults to 3600", () => {
    expect(parseWaitTimeout(undefined)).toBe(DEFAULT_WAIT_TIMEOUT_SEC);
    expect(parseWaitTimeout("")).toBe(3600);
    expect(parseWaitTimeout(-1)).toBe(3600);
    expect(parseWaitTimeout(12)).toBe(12);
    expect(parseWaitTimeout("90")).toBe(90);
  });
});

describe("newestEventTs / matchWait", () => {
  const ev = (ts: number, kind: string) => ({ ts, kind, summary: kind, extra: {} });

  it("newest ts and future-only filter", () => {
    const events = [ev(10, "sent"), ev(20, "working"), ev(20.5, "turn_done")];
    expect(newestEventTs(events)).toBe(20.5);
    expect(matchWaitEvents(events, ["turn_done"], 20.5).hit).toBe(false);
    expect(matchWaitEvents(events, ["turn_done"], 20).hit).toBe(true);
    const hit = matchWaitEvents(events, ["turn_done"], 20);
    if (!hit.hit) throw new Error("expected hit");
    expect(hit.woke).toBe("turn_done");
    expect(hit.event).toEqual(events[2]);
  });

  it("start: dead session returns woke dead even if dead not watched", () => {
    const m = matchWaitStart(
      { events: [ev(1, "sent")], pending: [], alive: false, found: true },
      ["turn_done"],
    );
    expect(m.hit).toBe(true);
    if (m.hit) expect(m.woke).toBe("dead");
  });

  it("start: pending tools + needs_decision returns immediately", () => {
    const pending = [{ tool_use_id: "toolu_1", tool: "Write", reason: "ask" }];
    const events = [ev(1, "sent"), ev(2, "needs_decision")];
    const m = matchWaitStart({ events, pending, alive: true, found: true }, DEFAULT_WAIT_KINDS);
    expect(m).toMatchObject({ hit: true, woke: "needs_decision", pending });
    if (m.hit) expect(m.event.kind).toBe("needs_decision");
  });

  it("start: pending ignored when needs_decision not in kinds", () => {
    const m = matchWaitStart(
      {
        events: [ev(1, "needs_decision")],
        pending: [{ tool_use_id: "x" }],
        alive: true,
        found: true,
      },
      ["turn_done"],
    );
    expect(m.hit).toBe(false);
  });

  it("poll: ignores history at afterTs and wakes on later kind", () => {
    const events = [ev(5, "needs_decision"), ev(6, "turn_done")];
    expect(matchWaitPoll({ events, pending: [], alive: true, found: true }, ["needs_decision", "turn_done"], 5).woke).toBe(
      "turn_done",
    );
    expect(matchWaitPoll({ events, pending: [], alive: true, found: true }, ["needs_decision"], 5).hit).toBe(false);
  });

  it("poll: death mid-wait if dead is watched", () => {
    const m = matchWaitPoll(
      { events: [ev(1, "sent")], pending: [], alive: false, found: true },
      DEFAULT_WAIT_KINDS,
      1,
    );
    expect(m.hit).toBe(true);
    if (m.hit) expect(m.woke).toBe("dead");
  });

  it("waitOk shape", () => {
    const event = ev(9, "failed");
    expect(waitOk("sess", { hit: true, woke: "failed", event })).toEqual({
      ok: true,
      id: "sess",
      woke: "failed",
      event,
    });
  });

  it("detects unknown wait cmd from old daemon", () => {
    expect(isUnknownWaitCmd({ ok: false, error: "unknown cmd wait" })).toBe(true);
    expect(isUnknownWaitCmd({ ok: false, error: "session not live" })).toBe(false);
  });
});
