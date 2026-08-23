"use client";

import { useState } from "react";
import type { InboxItem } from "../lib/pending-inbox";
import { canActOnInboxItem, inboxRpcArgs } from "../lib/pending-inbox";
import { rpc } from "../lib/client";

export function PendingInbox(props: {
  items: InboxItem[];
  serverLabel: (serverId: string) => string;
  onDone: () => void;
  onOpen: (item: InboxItem) => void;
}) {
  const [err, setErr] = useState<Record<string, string>>({});
  if (!props.items.length) return null;

  async function act(cmd: "approve" | "deny", item: InboxItem) {
    const args = inboxRpcArgs(cmd, item);
    if (!args) return;
    const key = `${item.serverId}|${item.sessionId}|${item.tool_use_id}`;
    const res = await rpc(args.cmd, { id: args.id, tool_use_id: args.tool_use_id }, args.serverId);
    if (!res.ok) {
      setErr((m) => ({ ...m, [key]: String(res.error || "失败") }));
      return;
    }
    setErr((m) => {
      const next = { ...m };
      delete next[key];
      return next;
    });
    props.onDone();
  }

  return (
    <div className="inbox" role="region" aria-label="待批准">
      <div className="inbox-head">
        待批准
        <span className="inbox-count">{props.items.length}</span>
      </div>
      {props.items.map((item) => {
        const key = `${item.serverId}|${item.sessionId}|${item.tool_use_id}`;
        const ready = canActOnInboxItem(item);
        return (
          <div key={key} className="row inbox-row">
            <div className="grow">
              <div>
                等待批准 {item.tool || "?"}
                {item.reason ? `（${item.reason}）` : ""}
              </div>
              <div className="tiny" style={{ padding: 0 }}>
                {props.serverLabel(item.serverId)} · {item.label}
                {!item.actionable ? "（已结束，无法批准）" : ""}
              </div>
              {err[key] ? <div className="err">{err[key]}</div> : null}
            </div>
            <button className="ok" disabled={!ready} onClick={() => void act("approve", item)}>
              批准
            </button>
            <button className="deny" disabled={!ready} onClick={() => void act("deny", item)}>
              拒绝
            </button>
            <button className="ghost" onClick={() => props.onOpen(item)}>
              查看
            </button>
          </div>
        );
      })}
    </div>
  );
}
