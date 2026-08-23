import { describe, expect, it } from "vitest";
import {
  canActOnInboxItem,
  collectPendingInbox,
  inboxItemsForView,
  inboxRpcArgs,
} from "../web/src/lib/pending-inbox.js";
import type { SessionRow } from "../web/src/lib/protocol.js";

const A = "s-127.0.0.1-8787";
const B = "s-10.0.0.2-8787";
const ID1 = "cee5cd27-209d-496e-9835-075e8d317b5f";
const ID2 = "8d73892c-6b6f-46a5-bfdc-50f1af87496a";

function sess(partial: Partial<SessionRow> & { id: string }): SessionRow {
  return {
    name: "",
    title: null,
    pending: [],
    last_turn: null,
    last_task: null,
    cost_usd: null,
    alive: true,
    ...partial,
  };
}

describe("collectPendingInbox", () => {
  it("aggregates across two servers and keeps colliding UUIDs as two rows", () => {
    const items = collectPendingInbox(
      {
        [B]: [sess({ id: ID1, name: "b", pending: [{ tool_use_id: "call-b", tool: "Bash" }] })],
        [A]: [sess({ id: ID1, name: "a", pending: [{ tool_use_id: "call-a", tool: "Write" }] })],
      },
      { [A]: true, [B]: true },
    );
    expect(items).toHaveLength(2);
    expect(items.map((i) => [i.serverId, i.tool_use_id])).toEqual([
      [B, "call-b"],
      [A, "call-a"],
    ]);
  });

  it("drops a disconnected server entirely", () => {
    const items = collectPendingInbox(
      { [A]: [sess({ id: ID1, pending: [{ tool_use_id: "call-1" }] })] },
      { [A]: false },
    );
    expect(items).toEqual([]);
  });

  it("keeps dead-session pending but marks it not actionable", () => {
    const items = collectPendingInbox(
      { [A]: [sess({ id: ID2, alive: false, pending: [{ tool_use_id: "call-old", tool: "Write" }] })] },
      { [A]: true },
    );
    expect(items).toHaveLength(1);
    expect(items[0].actionable).toBe(false);
    expect(items[0].alive).toBe(false);
    expect(canActOnInboxItem(items[0])).toBe(false);
  });

  it("returns [] when nothing is parked", () => {
    expect(collectPendingInbox({ [A]: [sess({ id: ID1, pending: [] })] }, { [A]: true })).toEqual([]);
    expect(collectPendingInbox({}, { [A]: true })).toEqual([]);
  });

  it("sorts by serverId, sessionId, tool_use_id", () => {
    const items = collectPendingInbox(
      {
        [A]: [
          sess({
            id: ID2,
            pending: [{ tool_use_id: "z" }, { tool_use_id: "a" }],
          }),
          sess({ id: ID1, pending: [{ tool_use_id: "m" }] }),
        ],
      },
      { [A]: true },
    );
    expect(items.map((i) => [i.sessionId, i.tool_use_id])).toEqual([
      [ID2, "a"],
      [ID2, "z"],
      [ID1, "m"],
    ]);
  });
});

describe("inboxItemsForView", () => {
  it("hides the open session so PendingBar is the only approve row", () => {
    const items = collectPendingInbox(
      {
        [A]: [
          sess({ id: ID1, pending: [{ tool_use_id: "call-a" }] }),
          sess({ id: ID2, pending: [{ tool_use_id: "call-b" }] }),
        ],
      },
      { [A]: true },
    );
    const view = inboxItemsForView(items, { serverId: A, sessionId: ID1 });
    expect(view.map((i) => i.tool_use_id)).toEqual(["call-b"]);
  });

  it("keeps colliding UUIDs on another server", () => {
    const items = collectPendingInbox(
      {
        [A]: [sess({ id: ID1, pending: [{ tool_use_id: "call-a" }] })],
        [B]: [sess({ id: ID1, pending: [{ tool_use_id: "call-b" }] })],
      },
      { [A]: true, [B]: true },
    );
    const view = inboxItemsForView(items, { serverId: A, sessionId: ID1 });
    expect(view).toHaveLength(1);
    expect(view[0].serverId).toBe(B);
    expect(view[0].tool_use_id).toBe("call-b");
  });

  it("shows everything when no session is open", () => {
    const items = collectPendingInbox(
      { [A]: [sess({ id: ID1, pending: [{ tool_use_id: "call-a" }] })] },
      { [A]: true },
    );
    expect(inboxItemsForView(items, { serverId: null, sessionId: null })).toEqual(items);
    expect(inboxItemsForView(items, { serverId: A, sessionId: null })).toEqual(items);
  });
});

describe("inboxRpcArgs", () => {
  it("requires the full triple before emitting rpc args", () => {
    const live = collectPendingInbox(
      { [A]: [sess({ id: ID1, pending: [{ tool_use_id: "call-1" }] })] },
      { [A]: true },
    )[0];
    expect(inboxRpcArgs("approve", live)).toEqual({
      cmd: "approve",
      id: ID1,
      tool_use_id: "call-1",
      serverId: A,
    });
    expect(inboxRpcArgs("deny", { ...live, actionable: false })).toBeNull();
  });
});
