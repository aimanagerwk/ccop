/** Aggregate parked tools across connected servers. No new host cmd. */

import type { PendingTool, SessionRow } from "./protocol";
import { sessLabel } from "./depot-store";
import { isClaudeSessionId, isDepotServerId } from "./session-url";

export type InboxItem = {
  serverId: string;
  sessionId: string;
  tool_use_id: string;
  cwd?: string;
  label: string;
  tool?: string;
  reason?: string;
  alive: boolean;
  actionable: boolean;
};

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function ownString(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function pickPending(raw: unknown): PendingTool | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(rec, "tool_use_id")) return null;
  const tid = rec.tool_use_id;
  if (typeof tid !== "string" || !tid) return null;
  if (FORBIDDEN_KEYS.has(tid)) return null;
  const out: PendingTool = { tool_use_id: tid };
  if (Object.prototype.hasOwnProperty.call(rec, "tool")) {
    const tool = ownString(rec.tool);
    if (tool) out.tool = tool;
  }
  if (Object.prototype.hasOwnProperty.call(rec, "reason")) {
    const reason = ownString(rec.reason);
    if (reason) out.reason = reason;
  }
  return out;
}

export function collectPendingInbox(
  sessionsByServer: Record<string, SessionRow[]>,
  live: Record<string, boolean>,
): InboxItem[] {
  const out: InboxItem[] = [];
  if (!sessionsByServer || typeof sessionsByServer !== "object") return out;
  for (const serverId of Object.keys(sessionsByServer)) {
    if (!isDepotServerId(serverId)) continue;
    if (live[serverId] !== true) continue;
    const rows = sessionsByServer[serverId];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      if (!isClaudeSessionId(row.id)) continue;
      if (!Array.isArray(row.pending)) continue;
      const alive = row.alive === true;
      const cwd = typeof row.cwd === "string" && row.cwd ? row.cwd : undefined;
      const label = sessLabel(row);
      for (const raw of row.pending) {
        const p = pickPending(raw);
        if (!p) continue;
        const item: InboxItem = {
          serverId,
          sessionId: row.id,
          tool_use_id: p.tool_use_id,
          label,
          alive,
          actionable: alive,
        };
        if (cwd) item.cwd = cwd;
        if (p.tool) item.tool = p.tool;
        if (p.reason) item.reason = p.reason;
        out.push(item);
      }
    }
  }
  out.sort((a, b) => {
    if (a.serverId !== b.serverId) return a.serverId < b.serverId ? -1 : 1;
    if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
    if (a.tool_use_id !== b.tool_use_id) return a.tool_use_id < b.tool_use_id ? -1 : 1;
    return 0;
  });
  return out;
}

export function canActOnInboxItem(item: InboxItem): boolean {
  return (
    isDepotServerId(item.serverId) &&
    isClaudeSessionId(item.sessionId) &&
    typeof item.tool_use_id === "string" &&
    item.tool_use_id.length > 0 &&
    !FORBIDDEN_KEYS.has(item.tool_use_id) &&
    item.actionable === true
  );
}

/** Shape that must go to POST /api/rpc. Never omit serverId. */
export function inboxRpcArgs(
  cmd: "approve" | "deny",
  item: InboxItem,
): { cmd: "approve" | "deny"; id: string; tool_use_id: string; serverId: string } | null {
  if (!canActOnInboxItem(item)) return null;
  return { cmd, id: item.sessionId, tool_use_id: item.tool_use_id, serverId: item.serverId };
}

/** Drop items already shown on the open session's PendingBar. */
export function inboxItemsForView(
  items: InboxItem[],
  selected: { serverId: string | null; sessionId: string | null },
): InboxItem[] {
  if (!Array.isArray(items)) return [];
  const serverId = selected.serverId;
  const sessionId = selected.sessionId;
  if (!serverId || !sessionId) return items;
  if (!isDepotServerId(serverId) || !isClaudeSessionId(sessionId)) return items;
  return items.filter((i) => i.serverId !== serverId || i.sessionId !== sessionId);
}
