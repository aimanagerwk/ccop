"use client";

import type { PendingTool } from "../lib/protocol";
import { rpc } from "../lib/client";

export function PendingBar(props: {
  id: string;
  pending: PendingTool[];
  onDone: () => void;
}) {
  if (!props.pending.length) return null;

  async function act(cmd: "approve" | "deny", tool_use_id: string) {
    await rpc(cmd, { id: props.id, tool_use_id });
    props.onDone();
  }

  return (
    <div className="pending">
      {props.pending.map((p) => (
        <div key={p.tool_use_id} className="row" style={{ marginBottom: 6 }}>
          <div className="grow">
            parked {p.tool || "?"} {p.reason ? `(${p.reason})` : ""} {p.tool_use_id}
          </div>
          <button className="ok" onClick={() => void act("approve", p.tool_use_id)}>
            Approve
          </button>
          <button className="deny" onClick={() => void act("deny", p.tool_use_id)}>
            Deny
          </button>
        </div>
      ))}
    </div>
  );
}
