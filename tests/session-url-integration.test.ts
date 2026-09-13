import { describe, expect, it } from "vitest";
import { parseSessionUrl } from "../web/src/lib/session-url.js";
import type { SessionRow } from "../web/src/lib/protocol.js";

/** Real status-shaped row from workflow-panel-integration / WF-COVERAGE. */
const session: SessionRow = {
  id: "cee5cd27-209d-496e-9835-075e8d317b5f",
  name: "wf",
  title: null,
  cwd: "/workspace",
  pending: [{ tool_use_id: "call-7355", tool: "Workflow" }],
  last_turn: null,
  last_task: null,
  alive: true,
  last_kind: "working",
  cost_usd: 0.270088,
};

const SID = "s-127.0.0.1-8787";

describe("session-url integration against status rows", () => {
  it("hits only by exact UUID in that server's status list", () => {
    const parsed = parseSessionUrl(`?s=${SID}&id=${session.id}`);
    expect(parsed).toEqual({ serverId: SID, sessionId: session.id });
    const sessionsByServer: Record<string, SessionRow[]> = { [SID]: [session] };
    const hit = (sessionsByServer[parsed.serverId!] || []).find((s) => s.id === parsed.sessionId);
    expect(hit?.id).toBe(session.id);
  });

  it("a well-formed s= that is not in the depot is not a status lookup key", () => {
    const parsed = parseSessionUrl(`?s=s-10.0.0.9-8787&id=${session.id}`);
    expect(parsed.serverId).toBe("s-10.0.0.9-8787");
    const depotIds = new Set([SID]);
    expect(depotIds.has(parsed.serverId!)).toBe(false);
  });

  it("a name in the query never selects the row", () => {
    const parsed = parseSessionUrl(`?s=${SID}&id=${encodeURIComponent(session.name)}`);
    expect(parsed.sessionId).toBeNull();
    const sessionsByServer: Record<string, SessionRow[]> = { [SID]: [session] };
    const byName = (sessionsByServer[SID] || []).find((s) => s.name === "wf");
    expect(byName?.id).toBe(session.id);
    expect(parsed.sessionId === byName?.id).toBe(false);
  });
});
