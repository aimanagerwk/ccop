/** Group folded transcript rows into turns. Does not mutate input. */

import type { FoldedRow } from "./fold-transcript";
import { formatDayLabel, localDayKey, toEpochMs } from "./format-ts";

export type TurnGroup = {
  turnId: number;
  startTs?: number;
  endTs?: number;
  dayKey?: string;
  rows: FoldedRow[];
};

export type TimelineItem =
  | { kind: "day"; dayKey: string; label: string }
  | { kind: "turn-head"; turnId: number; startTs?: number; count: number }
  | { kind: "row"; row: FoldedRow; turnId: number };

function own(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isUserRow(row: unknown): boolean {
  if (!row || typeof row !== "object") return false;
  if (!own(row, "type")) return false;
  return (row as { type?: unknown }).type === "user";
}

function finiteTs(row: unknown): number | undefined {
  if (!row || typeof row !== "object") return undefined;
  if (!own(row, "ts")) return undefined;
  const ts = (row as { ts?: unknown }).ts;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : undefined;
}

function makeGroup(turnId: number, rows: FoldedRow[]): TurnGroup {
  const group: TurnGroup = { turnId, rows };
  let startTs: number | undefined;
  let endTs: number | undefined;
  let startMs: number | undefined;
  let endMs: number | undefined;
  for (const row of rows) {
    const ts = finiteTs(row);
    if (ts === undefined) continue;
    const ms = toEpochMs(ts);
    if (ms === undefined) continue;
    if (startMs === undefined || endMs === undefined) {
      startTs = ts;
      endTs = ts;
      startMs = ms;
      endMs = ms;
      continue;
    }
    if (ms < startMs) {
      startMs = ms;
      startTs = ts;
    } else if (ms > endMs) {
      endMs = ms;
      endTs = ts;
    } else if (ms === startMs || ms === endMs) {
      if (ts !== startTs && startTs === endTs) endTs = ts;
    }
  }
  if (startTs !== undefined) group.startTs = startTs;
  if (endTs !== undefined) group.endTs = endTs;
  if (startTs !== undefined) {
    const dayKey = localDayKey(startTs);
    if (dayKey !== undefined) group.dayKey = dayKey;
  }
  return group;
}

export function groupTurns(rows: readonly FoldedRow[]): TurnGroup[] {
  if (!rows.length) return [];
  const groups: TurnGroup[] = [];
  let buf: FoldedRow[] = [];
  let seenUser = false;
  let currentTurnId = 0;

  for (const row of rows) {
    if (isUserRow(row)) {
      if (buf.length) groups.push(makeGroup(currentTurnId, buf));
      if (!seenUser) {
        seenUser = true;
        currentTurnId = 1;
      } else {
        currentTurnId += 1;
      }
      buf = [row];
      continue;
    }
    buf.push(row);
  }
  if (buf.length) groups.push(makeGroup(seenUser ? currentTurnId : 0, buf));
  return groups;
}

function ownFiniteTs(group: object): number | undefined {
  if (!own(group, "startTs")) return undefined;
  const ts = (group as { startTs?: unknown }).startTs;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : undefined;
}

export function flattenTimeline(groups: readonly TurnGroup[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let lastDay: string | undefined;

  for (const group of groups) {
    const startTs = ownFiniteTs(group);
    const head: Extract<TimelineItem, { kind: "turn-head" }> = {
      kind: "turn-head",
      turnId: group.turnId,
      count: group.rows.length,
    };
    if (startTs !== undefined) head.startTs = startTs;
    items.push(head);
    for (const row of group.rows) {
      const ts = finiteTs(row);
      const dayKey = ts !== undefined ? localDayKey(ts) : undefined;
      if (dayKey !== undefined && dayKey !== lastDay) {
        const label = formatDayLabel(ts) || dayKey;
        items.push({ kind: "day", dayKey, label });
        lastDay = dayKey;
      }
      items.push({ kind: "row", row, turnId: group.turnId });
    }
  }
  return items;
}
