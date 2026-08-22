/** Monitor = wait + live event stream + extra odd wakes. CLI poll; no daemon RPC. */

import {
  DEFAULT_WAIT_KINDS,
  matchWaitEvents,
  matchWaitStart,
  type PendingTool,
  type WaitHit,
  type WaitSnap,
} from "./wait.js";

export const DEFAULT_MONITOR_KINDS = [...DEFAULT_WAIT_KINDS];
export const DEFAULT_MONITOR_STALL_SEC = 180;
export const DEFAULT_MONITOR_TIMEOUT_SEC = 3600;

export type MonitorHit = {
  hit: true;
  woke: string;
  reason: string;
  event?: Record<string, unknown>;
  pending?: PendingTool[];
};

export type MonitorMiss = { hit: false };

export type MonitorMatch = MonitorHit | MonitorMiss;

export function parseMonitorStall(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MONITOR_STALL_SEC;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MONITOR_STALL_SEC;
  return n;
}

export function parseMonitorTimeout(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MONITOR_TIMEOUT_SEC;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MONITOR_TIMEOUT_SEC;
  return n;
}

export function isPostToolUseFailure(event: Record<string, unknown>): boolean {
  const extra = event.extra && typeof event.extra === "object" && !Array.isArray(event.extra)
    ? (event.extra as Record<string, unknown>)
    : {};
  const parts = [event.summary, event.hook, extra.hook, extra.hookEventName, extra.hook_event_name];
  return parts.some((p) => typeof p === "string" && p.includes("PostToolUseFailure"));
}

export function isOddSubtle(event: Record<string, unknown>): boolean {
  return isPostToolUseFailure(event);
}

export function futureEvents(
  events: Record<string, unknown>[],
  afterTs: number,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const e of events) {
    const ts = typeof e.ts === "number" ? e.ts : Number(e.ts);
    if (!Number.isFinite(ts) || !(ts > afterTs)) continue;
    out.push(e);
  }
  return out;
}

function fromWaitHit(match: WaitHit, reason?: string): MonitorHit {
  const hit: MonitorHit = {
    hit: true,
    woke: match.woke,
    reason: reason ?? match.woke,
    event: match.event,
  };
  if (match.pending) hit.pending = match.pending;
  return hit;
}

/** Start: already-dead, or pending tools (odd, same as needs_decision). */
export function matchMonitorStart(snap: WaitSnap): MonitorMatch {
  const start = matchWaitStart(snap, ["needs_decision", "dead"]);
  if (start.hit) {
    const reason = start.woke === "needs_decision" ? "pending" : start.woke;
    return fromWaitHit(start, reason);
  }
  return { hit: false };
}

/** First future event that is a wait kind or PostToolUseFailure. */
export function matchMonitorEvent(
  event: Record<string, unknown>,
  kinds: readonly string[],
  afterTs: number,
  pending?: PendingTool[],
): MonitorMatch {
  const wait = matchWaitEvents([event], kinds, afterTs, pending);
  if (wait.hit) return fromWaitHit(wait);
  const ts = typeof event.ts === "number" ? event.ts : Number(event.ts);
  if (!Number.isFinite(ts) || !(ts > afterTs)) return { hit: false };
  if (isPostToolUseFailure(event)) {
    return { hit: true, woke: "PostToolUseFailure", reason: "PostToolUseFailure", event };
  }
  return { hit: false };
}

export function matchMonitorStall(
  snap: Pick<WaitSnap, "alive" | "found">,
  lastNewMs: number,
  nowMs: number,
  stallSec: number,
): MonitorMatch {
  if (!snap.found || !snap.alive) return { hit: false };
  if (stallSec < 0) return { hit: false };
  if (nowMs - lastNewMs < stallSec * 1000) return { hit: false };
  return {
    hit: true,
    woke: "stall",
    reason: "stall",
    event: { kind: "working", summary: `no new event for ${stallSec}s`, extra: { stall_sec: stallSec } },
  };
}

/** After start: future events (caller prints), then dead / pending / stall. */
export function matchMonitorPoll(
  snap: WaitSnap,
  kinds: readonly string[],
  afterTs: number,
  lastNewMs: number,
  nowMs: number,
  stallSec: number,
): { news: Record<string, unknown>[]; match: MonitorMatch } {
  const news = futureEvents(snap.events, afterTs);
  for (const e of news) {
    const hit = matchMonitorEvent(e, kinds, afterTs, snap.pending);
    if (hit.hit) return { news, match: hit };
  }
  if (!snap.found || !snap.alive) {
    const last = [...snap.events].reverse().find((e) => e.kind === "dead");
    return {
      news,
      match: {
        hit: true,
        woke: "dead",
        reason: "dead",
        event: last ?? { kind: "dead", summary: "session not live" },
      },
    };
  }
  if (snap.pending.length > 0) {
    const last = [...snap.events].reverse().find((e) => e.kind === "needs_decision");
    return {
      news,
      match: {
        hit: true,
        woke: "needs_decision",
        reason: "pending",
        event: last ?? { kind: "needs_decision", summary: "pending tools", extra: {} },
        pending: snap.pending,
      },
    };
  }
  if (news.length) return { news, match: { hit: false } };
  const stall = matchMonitorStall(snap, lastNewMs, nowMs, stallSec);
  return { news, match: stall };
}

export function monitorOk(id: string, match: MonitorHit): Record<string, unknown> {
  const out: Record<string, unknown> = { ok: true, id, woke: match.woke, reason: match.reason };
  if (match.event) out.event = match.event;
  if (match.pending) out.pending = match.pending;
  return out;
}

