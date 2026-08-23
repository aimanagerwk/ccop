import { describe, expect, it } from "vitest";
import { isSessionHot, partitionTreeNodes, sessionActiveTs } from "../web/src/lib/session-active.js";
import type { SessionRow } from "../web/src/lib/protocol.js";

const NOW_SEC = 1_787_403_760;

const working: SessionRow = {
  id: "cee5cd27-209d-496e-9835-075e8d317b5f",
  name: "wf",
  title: null,
  cwd: "/workspace",
  pending: [],
  last_turn: null,
  last_task: null,
  alive: true,
  last_kind: "working",
  cost_usd: 0.270088,
  updated_ts: 1_787_403_740,
};

const dead: SessionRow = {
  id: "8d73892c-6b6f-46a5-bfdc-50f1af87496a",
  name: "old",
  title: null,
  cwd: "/workspace/old",
  pending: [],
  last_turn: null,
  last_task: null,
  alive: false,
  last_kind: "dead",
  cost_usd: null,
  updated_ts: 1_787_403_700,
};

describe("session-active integration against status shapes", () => {
  it("reads updated_ts from a live status row and not from a bare {id}", () => {
    expect(sessionActiveTs(working)).toBe(1_787_403_740);
    expect(sessionActiveTs({ id: working.id } as { updated_ts?: unknown })).toBeNull();
  });

  it("splits a working row from a dead row without inventing host fields", () => {
    expect(isSessionHot(working, NOW_SEC)).toBe(true);
    expect(isSessionHot(dead, NOW_SEC)).toBe(false);
    const { visible, idleCwds } = partitionTreeNodes([working, dead], [], NOW_SEC);
    expect(visible.map((p) => p.cwd)).toEqual(["/workspace"]);
    expect(visible[0].hot.map((s) => s.id)).toEqual([working.id]);
    expect(idleCwds.map((p) => p.cwd)).toEqual(["/workspace/old"]);
    expect(idleCwds[0].idle.map((s) => s.id)).toEqual([dead.id]);
    expect("idle_since" in working).toBe(false);
    expect("idle_since" in dead).toBe(false);
  });
});
