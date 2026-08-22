/** Wait for a future classified event. Shared by CLI poll and daemon cmdWait. */

import { KINDS, type Kind } from "./classify.js";

export const DEFAULT_WAIT_KINDS: Kind[] = [
  "needs_decision",
  "needs_info",
  "turn_done",
  "failed",
  "dead",
];

export const DEFAULT_WAIT_TIMEOUT_SEC = 3600;
export const WAIT_POLL_MS = 400;

export type PendingTool = {
  tool_use_id?: string;
  tool?: string;
  reason?: string;
  [k: string]: unknown;
};

export type WaitSnap = {
  events: Record<string, unknown>[];
  pending: PendingTool[];
  alive: boolean;
  found: boolean;
};

export type WaitHit = {
  hit: true;
  woke: string;
  event: Record<string, unknown>;
  pending?: PendingTool[];
};

export type WaitMiss = { hit: false };

export type WaitMatch = WaitHit | WaitMiss;

export function parseWaitKinds(raw: unknown): { ok: true; kinds: Kind[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, kinds: [...DEFAULT_WAIT_KINDS] };
  }
  const parts = Array.isArray(raw) ? raw.map(String) : String(raw).split(",");
  const kinds: Kind[] = [];
  for (const p of parts) {
    const k = p.trim();
    if (!k) continue;
    if (!(KINDS as readonly string[]).includes(k)) {
      return { ok: false, error: `unknown kind ${k}` };
    }
    if (!kinds.includes(k as Kind)) kinds.push(k as Kind);
  }
  if (!kinds.length) return { ok: true, kinds: [...DEFAULT_WAIT_KINDS] };
  return { ok: true, kinds };
}

export function parseWaitTimeout(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_WAIT_TIMEOUT_SEC;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_WAIT_TIMEOUT_SEC;
  return n;
}

export function newestEventTs(events: Array<{ ts?: unknown }>): number {
  let max = 0;
  for (const e of events) {
    const ts = typeof e.ts === "number" ? e.ts : Number(e.ts);
    if (Number.isFinite(ts) && ts > max) max = ts;
  }
  return max;
}

export function waitOk(id: string, match: WaitHit): Record<string, unknown> {
  const out: Record<string, unknown> = { ok: true, id, woke: match.woke, event: match.event };
  if (match.pending) out.pending = match.pending;
  return out;
}

/** Start-of-wait: already-dead, or pending tools when needs_decision is watched. */
export function matchWaitStart(snap: WaitSnap, kinds: readonly string[]): WaitMatch {
  if (!snap.found || !snap.alive) {
    return {
      hit: true,
      woke: "dead",
      event: { kind: "dead", summary: snap.found ? "session not live" : "session not found" },
    };
  }
  if (kinds.includes("needs_decision") && snap.pending.length > 0) {
    const last = [...snap.events].reverse().find((e) => e.kind === "needs_decision");
    return {
      hit: true,
      woke: "needs_decision",
      event: last ?? { kind: "needs_decision", summary: "pending tools", extra: {} },
      pending: snap.pending,
    };
  }
  return { hit: false };
}

/** Future-only: ts strictly greater than afterTs. First matching kind wins (jsonl order). */
export function matchWaitEvents(
  events: Record<string, unknown>[],
  kinds: readonly string[],
  afterTs: number,
  pending?: PendingTool[],
): WaitMatch {
  for (const e of events) {
    const ts = typeof e.ts === "number" ? e.ts : Number(e.ts);
    if (!Number.isFinite(ts) || !(ts > afterTs)) continue;
    const kind = String(e.kind ?? "");
    if (!kinds.includes(kind)) continue;
    const hit: WaitHit = { hit: true, woke: kind, event: e };
    if (kind === "needs_decision" && pending && pending.length) hit.pending = pending;
    return hit;
  }
  return { hit: false };
}

/** Poll tick after wait-start: future events, or death if dead is watched. */
export function matchWaitPoll(snap: WaitSnap, kinds: readonly string[], afterTs: number): WaitMatch {
  const ev = matchWaitEvents(snap.events, kinds, afterTs, snap.pending);
  if (ev.hit) return ev;
  if ((!snap.found || !snap.alive) && kinds.includes("dead")) {
    const last = [...snap.events].reverse().find((e) => e.kind === "dead");
    return {
      hit: true,
      woke: "dead",
      event: last ?? { kind: "dead", summary: "session not live" },
    };
  }
  return { hit: false };
}

export function isUnknownWaitCmd(res: Record<string, unknown>): boolean {
  return res.ok === false && /unknown cmd\s+wait\b/i.test(String(res.error || ""));
}
