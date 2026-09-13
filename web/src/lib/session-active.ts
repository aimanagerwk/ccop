/** Last-active clock and hot/idle partition for the session tree. */

import type { SessionRow } from "./protocol";

export const IDLE_WINDOW_SEC = 30 * 60;

export type ActiveAgo = { text: string; title: string };

export type CwdPartition = {
  cwd: string;
  pinned: boolean;
  hot: SessionRow[];
  idle: SessionRow[];
};

/** Epoch seconds. Only the session-level status field — never usage.updated_ts. */
export function sessionActiveTs(s: { updated_ts?: unknown }): number | null {
  const n = s.updated_ts;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return n;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function localYmd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function localStamp(d: Date): string {
  return `${localYmd(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatActiveAgo(ts: number | null, nowMs: number): ActiveAgo {
  if (ts === null || !Number.isFinite(ts) || ts <= 0 || !Number.isFinite(nowMs)) {
    return { text: "", title: "" };
  }
  const thenMs = ts > 1e12 ? ts : ts * 1000;
  if (!Number.isFinite(thenMs)) return { text: "", title: "" };
  const d = new Date(thenMs);
  if (Number.isNaN(d.getTime())) return { text: "", title: "" };
  const title = localStamp(d);
  const delta = nowMs - thenMs;
  if (!Number.isFinite(delta) || delta < 0) return { text: "刚刚", title };
  if (delta < 10_000) return { text: "刚刚", title };
  if (delta < 60_000) return { text: `${Math.floor(delta / 1000)} 秒前`, title };
  if (delta < 60 * 60_000) return { text: `${Math.floor(delta / 60_000)} 分钟前`, title };
  if (delta < 24 * 60 * 60_000) return { text: `${Math.floor(delta / 3_600_000)} 小时前`, title };
  const today0 = startOfLocalDay(nowMs);
  const yday0 = today0 - 24 * 60 * 60_000;
  if (thenMs >= yday0 && thenMs < today0) return { text: "昨天", title };
  return { text: localYmd(d), title };
}

export function sessionKind(s: { last_kind?: unknown; state?: unknown }): string {
  const k = s.last_kind;
  if (typeof k === "string" && k) return k;
  const st = s.state;
  if (typeof st === "string" && st) return st;
  return "";
}

/** Hot = needs attention or recently active. Independent of sessionDotClass. */
export function isSessionHot(
  s: {
    alive?: unknown;
    pending?: unknown;
    last_kind?: unknown;
    state?: unknown;
    updated_ts?: unknown;
  },
  nowSec: number,
): boolean {
  const pending = Array.isArray(s.pending) ? s.pending.length : 0;
  if (pending > 0) return true;
  if (s.alive !== true) return false;
  const kind = sessionKind(s);
  if (kind === "working" || kind === "failed" || kind === "needs_info") return true;
  const ts = sessionActiveTs(s);
  if (ts === null || !Number.isFinite(nowSec)) return false;
  return nowSec - ts < IDLE_WINDOW_SEC;
}

function sortByActiveDesc(rows: SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) => {
    const ta = sessionActiveTs(a) ?? 0;
    const tb = sessionActiveTs(b) ?? 0;
    if (tb !== ta) return tb - ta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function partitionTreeNodes(
  sessions: SessionRow[],
  pinnedCwds: string[],
  nowSec: number,
  selectedSessionId?: string | null,
): { visible: CwdPartition[]; idleCwds: CwdPartition[] } {
  const cwdSet = new Set<string>(pinnedCwds);
  const pinned = new Set<string>(pinnedCwds);
  for (const s of sessions) {
    if (s.cwd) cwdSet.add(s.cwd);
  }
  const cwds = [...cwdSet].sort();
  const visible: CwdPartition[] = [];
  const idleCwds: CwdPartition[] = [];
  for (const cwd of cwds) {
    const here = sessions.filter((s) => (s.cwd || "") === cwd);
    const hot: SessionRow[] = [];
    const idle: SessionRow[] = [];
    for (const s of here) {
      if (isSessionHot(s, nowSec)) hot.push(s);
      else idle.push(s);
    }
    const part: CwdPartition = {
      cwd,
      pinned: pinned.has(cwd),
      hot: sortByActiveDesc(hot),
      idle: sortByActiveDesc(idle),
    };
    const selectedHere = Boolean(selectedSessionId && here.some((s) => s.id === selectedSessionId));
    if (part.hot.length > 0 || part.pinned || selectedHere) visible.push(part);
    else if (part.idle.length > 0) idleCwds.push(part);
  }
  return { visible, idleCwds };
}
