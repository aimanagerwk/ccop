import { describe, expect, it } from "vitest";
import {
  IDLE_WINDOW_SEC,
  formatActiveAgo,
  isSessionHot,
  partitionTreeNodes,
  sessionActiveTs,
} from "../web/src/lib/session-active.js";
import { sessionDotClass } from "../web/src/lib/session-dot.js";
import type { SessionRow } from "../web/src/lib/protocol.js";

const NOW_MS = Date.UTC(2026, 7, 23, 12, 0, 0);
const NOW_SEC = NOW_MS / 1000;

function row(partial: Partial<SessionRow> & { id: string }): SessionRow {
  return {
    name: "",
    title: null,
    pending: [],
    last_turn: null,
    last_task: null,
    cost_usd: null,
    ...partial,
  };
}

describe("sessionActiveTs", () => {
  it("only accepts a finite positive updated_ts", () => {
    expect(sessionActiveTs({ updated_ts: 1_787_403_740 })).toBe(1_787_403_740);
    expect(sessionActiveTs({ updated_ts: Number.NaN })).toBeNull();
    expect(sessionActiveTs({ updated_ts: Number.POSITIVE_INFINITY })).toBeNull();
    expect(sessionActiveTs({ updated_ts: "1787403740" })).toBeNull();
    expect(sessionActiveTs({ updated_ts: 0 })).toBeNull();
    expect(sessionActiveTs({})).toBeNull();
  });

  it("ignores last_turn.ts and usage.updated_ts", () => {
    expect(
      sessionActiveTs({
        last_turn: { kind: "turn_done", ts: 9_999_999_999, summary: "x" },
        usage: { updated_ts: 9_999_999_999 },
      } as { updated_ts?: unknown }),
    ).toBeNull();
  });
});

describe("formatActiveAgo", () => {
  it("maps relative buckets with a fixed now", () => {
    expect(formatActiveAgo(NOW_SEC - 9, NOW_MS).text).toBe("刚刚");
    expect(formatActiveAgo(NOW_SEC - 10, NOW_MS).text).toBe("10 秒前");
    expect(formatActiveAgo(NOW_SEC - 59, NOW_MS).text).toBe("59 秒前");
    expect(formatActiveAgo(NOW_SEC - 60, NOW_MS).text).toBe("1 分钟前");
    expect(formatActiveAgo(NOW_SEC - 59 * 60, NOW_MS).text).toBe("59 分钟前");
    expect(formatActiveAgo(NOW_SEC - 60 * 60, NOW_MS).text).toBe("1 小时前");
    expect(formatActiveAgo(NOW_SEC - 23 * 3600, NOW_MS).text).toBe("23 小时前");
  });

  it("uses the local day boundary for 昨天 vs a date", () => {
    const localNow = new Date(2026, 7, 23, 12, 0, 0).getTime();
    const ydayNoon = new Date(2026, 7, 22, 12, 0, 0).getTime() / 1000;
    const twoDays = new Date(2026, 7, 21, 12, 0, 0);
    expect(formatActiveAgo(ydayNoon, localNow).text).toBe("昨天");
    expect(formatActiveAgo(twoDays.getTime() / 1000, localNow).text).toBe("2026-08-21");
    expect(formatActiveAgo(ydayNoon, localNow).title).toMatch(/^2026-08-22 /);
  });

  it("returns empty text for illegal ts", () => {
    expect(formatActiveAgo(null, NOW_MS)).toEqual({ text: "", title: "" });
    expect(formatActiveAgo(Number.NaN, NOW_MS)).toEqual({ text: "", title: "" });
    expect(formatActiveAgo(0, NOW_MS)).toEqual({ text: "", title: "" });
  });

  it("title is a local absolute stamp, not HTML", () => {
    const ago = formatActiveAgo(NOW_SEC - 30, NOW_MS);
    expect(ago.title).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(ago.text.includes("<")).toBe(false);
    expect(ago.title.includes("<")).toBe(false);
  });
});

describe("isSessionHot", () => {
  it("pending / working / failed / needs_info stay hot even when old", () => {
    const old = NOW_SEC - IDLE_WINDOW_SEC - 10;
    expect(isSessionHot({ alive: true, pending: [{}], updated_ts: old, last_kind: "idle" }, NOW_SEC)).toBe(true);
    expect(isSessionHot({ alive: true, pending: [], last_kind: "working", updated_ts: old }, NOW_SEC)).toBe(true);
    expect(isSessionHot({ alive: true, pending: [], last_kind: "failed", updated_ts: old }, NOW_SEC)).toBe(true);
    expect(isSessionHot({ alive: true, pending: [], last_kind: "needs_info", updated_ts: old }, NOW_SEC)).toBe(true);
  });

  it("dead is always cold even when updated_ts is fresh", () => {
    expect(isSessionHot({ alive: false, pending: [], last_kind: "dead", updated_ts: NOW_SEC }, NOW_SEC)).toBe(false);
  });

  it("live turn_done is hot inside the window and cold on the boundary", () => {
    expect(
      isSessionHot({ alive: true, pending: [], last_kind: "turn_done", updated_ts: NOW_SEC - IDLE_WINDOW_SEC + 1 }, NOW_SEC),
    ).toBe(true);
    expect(
      isSessionHot({ alive: true, pending: [], last_kind: "turn_done", updated_ts: NOW_SEC - IDLE_WINDOW_SEC }, NOW_SEC),
    ).toBe(false);
  });

  it("live with no updated_ts is cold", () => {
    expect(isSessionHot({ alive: true, pending: [], last_kind: "idle" }, NOW_SEC)).toBe(false);
  });
});

describe("partitionTreeNodes", () => {
  it("puts a fully-cold unpinned cwd into idleCwds", () => {
    const dead = row({
      id: "11111111-1111-4111-8111-111111111111",
      cwd: "/workspace/old",
      alive: false,
      last_kind: "dead",
      updated_ts: NOW_SEC,
    });
    const { visible, idleCwds } = partitionTreeNodes([dead], [], NOW_SEC);
    expect(visible).toEqual([]);
    expect(idleCwds).toHaveLength(1);
    expect(idleCwds[0].cwd).toBe("/workspace/old");
    expect(idleCwds[0].idle.map((s) => s.id)).toEqual([dead.id]);
  });

  it("keeps a pinned empty cwd visible", () => {
    const { visible, idleCwds } = partitionTreeNodes([], ["/workspace"], NOW_SEC);
    expect(idleCwds).toEqual([]);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ cwd: "/workspace", pinned: true, hot: [], idle: [] });
  });

  it("forces the selected session's cwd to stay visible", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const dead = row({ id, cwd: "/workspace/old", alive: false, last_kind: "dead", updated_ts: NOW_SEC });
    const { visible, idleCwds } = partitionTreeNodes([dead], [], NOW_SEC, id);
    expect(idleCwds).toEqual([]);
    expect(visible[0].idle.map((s) => s.id)).toEqual([id]);
  });
});

describe("sessionDotClass stays independent", () => {
  it("still maps the five states", () => {
    expect(sessionDotClass({ alive: true, pending: [{}], last_kind: "idle" })).toBe("warn");
    expect(sessionDotClass({ alive: false, last_kind: "dead" })).toBe("ended");
    expect(sessionDotClass({ alive: true, last_kind: "working" })).toBe("live");
    expect(sessionDotClass({ alive: true, last_kind: "failed" })).toBe("halt");
    expect(sessionDotClass({ alive: true, last_kind: "idle" })).toBe("idle");
  });
});
