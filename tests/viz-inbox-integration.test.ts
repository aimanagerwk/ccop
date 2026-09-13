import { describe, expect, it } from "vitest";
import { collectPendingInbox, inboxRpcArgs } from "../web/src/lib/pending-inbox.js";
import { partitionTreeNodes, sessionActiveTs } from "../web/src/lib/session-active.js";
import { buildSessionUrl, parseSessionUrl } from "../web/src/lib/session-url.js";
import type { SessionRow } from "../web/src/lib/protocol.js";

const SID = "s-127.0.0.1-8787";
const NOW_SEC = 1_787_403_760;

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

const dead: SessionRow = {
  id: "8d73892c-6b6f-46a5-bfdc-50f1af87496a",
  name: "old",
  title: null,
  cwd: "/workspace/old",
  alive: false,
  pending: [],
  last_turn: null,
  last_task: null,
  last_kind: "dead",
  updated_ts: 1_787_400_000,
  cost_usd: null,
};

describe("inbox + tree + deep-link against one status snapshot", () => {
  const sessionsByServer = { [SID]: [live, dead] };
  const liveMap = { [SID]: true };

  it("inbox only surfaces the parked live tool and emits the rpc triple", () => {
    const items = collectPendingInbox(sessionsByServer, liveMap);
    expect(items.map((i) => i.tool_use_id)).toEqual(["call-7355"]);
    expect(inboxRpcArgs("approve", items[0])).toEqual({
      cmd: "approve",
      id: live.id,
      tool_use_id: "call-7355",
      serverId: SID,
    });
  });

  it("deep-link hits the live row by UUID and ignores the name", () => {
    const href = buildSessionUrl({ serverId: SID, sessionId: live.id });
    expect(href).toBe(`/?s=${SID}&id=${live.id}`);
    expect(parseSessionUrl(href)).toEqual({ serverId: SID, sessionId: live.id });
    expect(parseSessionUrl(`?s=${SID}&id=wf`).sessionId).toBeNull();
    const parsed = parseSessionUrl(href);
    const hit = (sessionsByServer[parsed.serverId!] || []).find((s) => s.id === parsed.sessionId);
    expect(hit?.id).toBe(live.id);
  });

  it("tree keeps the working cwd visible and folds the dead cwd", () => {
    expect(sessionActiveTs(live)).toBe(live.updated_ts);
    const { visible, idleCwds } = partitionTreeNodes(sessionsByServer[SID], [], NOW_SEC);
    expect(visible.map((p) => p.cwd)).toEqual(["/workspace"]);
    expect(visible[0].hot.map((s) => s.id)).toEqual([live.id]);
    expect(idleCwds.map((p) => p.cwd)).toEqual(["/workspace/old"]);
    expect(idleCwds[0].idle.map((s) => s.id)).toEqual([dead.id]);
  });
});
