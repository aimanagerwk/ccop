import { afterEach, describe, expect, it } from "vitest";
import { canActOnInboxItem, collectPendingInbox, inboxRpcArgs } from "../web/src/lib/pending-inbox.js";
import type { SessionRow } from "../web/src/lib/protocol.js";

const A = "s-127.0.0.1-8787";
const ID = "cee5cd27-209d-496e-9835-075e8d317b5f";

afterEach(() => {
  delete (Object.prototype as { hacked?: unknown }).hacked;
  delete (Object.prototype as { polluted?: unknown }).polluted;
});

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

describe("pending-inbox security", () => {
  it("does not copy __proto__ / constructor rows or pollute Object.prototype", () => {
    const protoRow = JSON.parse(
      '{"id":"cee5cd27-209d-496e-9835-075e8d317b5f","pending":[{"tool_use_id":"call-1","__proto__":{"hacked":true},"constructor":{"name":"hack"}}],"alive":true}',
    );
    const items = collectPendingInbox({ [A]: [protoRow] }, { [A]: true });
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]).sort()).toEqual([
      "actionable",
      "alive",
      "label",
      "serverId",
      "sessionId",
      "tool_use_id",
    ]);
    expect(Object.prototype.hasOwnProperty.call(items[0], "__proto__")).toBe(false);
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it("strips pending.input and never copies token", () => {
    const items = collectPendingInbox(
      {
        [A]: [
          sess({
            id: ID,
            pending: [{ tool_use_id: "call-1", tool: "Write", input: { path: "/secret" } } as never],
          }),
        ],
      },
      { [A]: true },
    );
    expect(items).toHaveLength(1);
    expect((items[0] as { input?: unknown }).input).toBeUndefined();
    expect(JSON.stringify(items[0])).not.toContain("/secret");
    expect((items[0] as { token?: string }).token).toBeUndefined();
  });

  it("keeps tool/reason as plain strings including script text", () => {
    const payload = "<script>alert(1)</script>";
    const items = collectPendingInbox(
      { [A]: [sess({ id: ID, pending: [{ tool_use_id: "call-1", tool: payload, reason: payload }] })] },
      { [A]: true },
    );
    expect(items[0].tool).toBe(payload);
    expect(items[0].reason).toBe(payload);
  });

  it("drops bad server ids and session names", () => {
    expect(
      collectPendingInbox(
        { "": [sess({ id: ID, pending: [{ tool_use_id: "call-1" }] })] } as Record<string, SessionRow[]>,
        { "": true } as Record<string, boolean>,
      ),
    ).toEqual([]);
    expect(
      collectPendingInbox(
        { forged: [sess({ id: ID, pending: [{ tool_use_id: "call-1" }] })] },
        { forged: true },
      ),
    ).toEqual([]);
    expect(
      collectPendingInbox({ [A]: [sess({ id: "alpha", pending: [{ tool_use_id: "call-1" }] })] }, { [A]: true }),
    ).toEqual([]);
    expect(
      collectPendingInbox({ [A]: [sess({ id: ID, pending: [{ tool_use_id: "" }] })] }, { [A]: true }),
    ).toEqual([]);
  });

  it("canActOnInboxItem is false when any key is missing", () => {
    const base = {
      serverId: A,
      sessionId: ID,
      tool_use_id: "call-1",
      label: "x",
      alive: true,
      actionable: true,
    };
    expect(canActOnInboxItem({ ...base, serverId: "" })).toBe(false);
    expect(canActOnInboxItem({ ...base, sessionId: "wf" })).toBe(false);
    expect(canActOnInboxItem({ ...base, tool_use_id: "" })).toBe(false);
    expect(canActOnInboxItem({ ...base, actionable: false })).toBe(false);
    expect(inboxRpcArgs("approve", { ...base, serverId: "" })).toBeNull();
  });
});
