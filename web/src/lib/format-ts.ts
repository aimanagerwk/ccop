/** Epoch / calendar helpers for transcript timestamps. Does not mutate input. */

import type { FoldedRow } from "./fold-transcript";

function asFiniteNumber(ts?: number): number | undefined {
  return typeof ts === "number" && Number.isFinite(ts) ? ts : undefined;
}

/** epoch 秒（可小数）或毫秒（>1e12）→ ms；非有限返回 undefined，不编造 */
export function toEpochMs(ts?: number): number | undefined {
  const n = asFiniteNumber(ts);
  if (n === undefined) return undefined;
  const ms = n > 1e12 ? n : n * 1000;
  if (Number.isNaN(new Date(ms).getTime())) return undefined;
  return ms;
}

/** 给 <time dateTime>：合法则 ISO-8601，否则 undefined。禁止 String(ts) */
export function formatDateTimeAttr(ts?: number): string | undefined {
  const ms = toEpochMs(ts);
  if (ms === undefined) return undefined;
  const iso = new Date(ms).toISOString();
  return iso;
}

function localYmd(ms: number): string | undefined {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return undefined;
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 本地日历日 YYYY-MM-DD；无有效 ts → undefined */
export function formatDayLabel(ts?: number): string | undefined {
  const ms = toEpochMs(ts);
  if (ms === undefined) return undefined;
  return localYmd(ms);
}

/** 本地日键，供跨日比较；无有效 ts → undefined */
export function localDayKey(ts?: number): string | undefined {
  const ms = toEpochMs(ts);
  if (ms === undefined) return undefined;
  return localYmd(ms);
}

export type DayMark = { index: number; label: string; dayKey: string };

/** 在 rows 里标出「相对上一有效日发生跨日」的下标。无 ts 的行不发明日、不打断已有日 */
export function dayBreaks(rows: readonly FoldedRow[]): DayMark[] {
  const marks: DayMark[] = [];
  let prev: string | undefined;
  for (let i = 0; i < rows.length; i++) {
    const dayKey = localDayKey(rows[i].ts);
    if (dayKey === undefined) continue;
    if (dayKey === prev) continue;
    const label = formatDayLabel(rows[i].ts);
    if (label === undefined) continue;
    marks.push({ index: i, label, dayKey });
    prev = dayKey;
  }
  return marks;
}
