"use client";

import type { PendingTool } from "../lib/protocol";
import { rpc } from "../lib/client";

export function PendingBar(props: {
  id: string;
  serverId: string | null;
  pending: PendingTool[];
  onDone: () => void;
}) {
  if (!props.pending.length) return null;

  async function act(cmd: "approve" | "deny", tool_use_id: string) {
    await rpc(cmd, { id: props.id, tool_use_id }, props.serverId || undefined);
    props.onDone();
  }

  return (
    <div className="pending">
      {props.pending.map((p) => (
        <div key={p.tool_use_id} className="row" style={{ marginBottom: 6 }}>
          <div className="grow">
            等待批准 {p.tool || "?"} {p.reason ? `（${p.reason}）` : ""}
          </div>
          <button className="ok" onClick={() => void act("approve", p.tool_use_id)}>
            批准
          </button>
          <button className="deny" onClick={() => void act("deny", p.tool_use_id)}>
            拒绝
          </button>
        </div>
      ))}
    </div>
  );
}
