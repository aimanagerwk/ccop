import { describe, expect, it } from "vitest";
import { canActOnInboxItem, collectPendingInbox, inboxItemsForView, inboxRpcArgs } from "../web/src/lib/pending-inbox.js";
import type { SessionRow } from "../web/src/lib/protocol.js";

const SID = "s-127.0.0.1-8787";

/** Live cmdStatus mapping — no input. */
const live: SessionRow = {
  id: "cee5cd27-209d-496e-9835-075e8d317b5f",
  name: "wf",
  title: null,
  cwd: "/workspace",
  alive: true,
  pending: [{ tool_use_id: "call-7355", tool: "Workflow" }],
  last_turn: null,
  last_task: null,
  last_kind: "working",
  updated_ts: 1_787_403_740,
  cost_usd: 0.270088,
};

/** Disk residue — may carry input, not actionable. */
const residue: SessionRow = {
  id: "8d73892c-6b6f-46a5-bfdc-50f1af87496a",
  name: "old",
  title: null,
  cwd: "/workspace/old",
  alive: false,
  pending: [
    {
      tool_use_id: "call-old",
      tool: "Write",
      reason: "ask",
      input: { path: "/secret" },
    } as SessionRow["pending"][number] & { input: { path: string } },
  ],
  last_turn: null,
  last_task: null,
  last_kind: "dead",
  cost_usd: null,
};

describe("pending-inbox integration against status shapes", () => {
  it("live pending is actionable and rpc args match /api/rpc", () => {
    const items = collectPendingInbox({ [SID]: [live] }, { [SID]: true });
    expect(items).toHaveLength(1);
    expect(items[0].tool).toBe("Workflow");
    expect(items[0].actionable).toBe(true);
    expect(canActOnInboxItem(items[0])).toBe(true);
    expect(inboxRpcArgs("approve", items[0])).toEqual({
      cmd: "approve",
      id: live.id,
      tool_use_id: "call-7355",
      serverId: SID,
    });
    expect(inboxRpcArgs("deny", items[0])).toEqual({
      cmd: "deny",
      id: live.id,
      tool_use_id: "call-7355",
      serverId: SID,
    });
    const args = inboxRpcArgs("approve", items[0]);
    expect(args && "name" in args).toBe(false);
    expect(args && "title" in args).toBe(false);
    expect(args && "token" in args).toBe(false);
  });

  it("disk residue is shown without input and cannot be approved", () => {
    const items = collectPendingInbox({ [SID]: [residue] }, { [SID]: true });
    expect(items).toHaveLength(1);
    expect(items[0].actionable).toBe(false);
    expect((items[0] as { input?: unknown }).input).toBeUndefined();
    expect(JSON.stringify(items[0])).not.toContain("/secret");
    expect(inboxRpcArgs("approve", items[0])).toBeNull();
  });

  it("opening the live session leaves only the session bar actionable", () => {
    const items = collectPendingInbox({ [SID]: [live, residue] }, { [SID]: true });
    expect(items).toHaveLength(2);
    const view = inboxItemsForView(items, { serverId: SID, sessionId: live.id });
    expect(view.map((i) => i.sessionId)).toEqual([residue.id]);
    expect(view.every((i) => i.tool_use_id !== "call-7355")).toBe(true);
    expect(inboxRpcArgs("approve", view[0])).toBeNull();
  });
});

