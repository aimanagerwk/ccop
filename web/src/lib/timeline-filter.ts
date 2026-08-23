/** Filter folded transcript rows / turn groups. Does not mutate input. */

import { toolCardPresentation, TOOL_OUTPUT_CLIP, type FoldedRow } from "./fold-transcript";
import type { TurnGroup } from "./timeline-turn";
import { localDayKey, toEpochMs } from "./format-ts";

export const QUERY_MAX_LEN = 200;
export const TEXT_CLIP = TOOL_OUTPUT_CLIP;
export const ITEM_CLIP = TEXT_CLIP;

export type FilterQuery = {
  q?: string;
  types?: readonly FoldedRow["type"][];
};

export type SanitizedQuery = {
  needle: string;
  types: ReadonlySet<FoldedRow["type"]> | null;
  /** Regional indicators clipped off an over-budget query. Absent when none. */
  droppedRegional?: string;
};

const ROW_TYPES = new Set<FoldedRow["type"]>([
  "thinking",
  "thinking_text",
  "user",
  "assistant",
  "tool",
  "needs_decision",
  "needs_info",
  "failed",
  "dead",
  "task_done",
  "system",
]);

const TEXT_TYPES = new Set<FoldedRow["type"]>([
  "user",
  "assistant",
  "thinking_text",
  "needs_decision",
  "needs_info",
  "failed",
  "dead",
  "task_done",
]);

function own(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function isFillerCode(code: number): boolean {
  return (
    code === 0x00ad ||
    code === 0x200b ||
    code === 0x200c ||
    code === 0x2060 ||
    code === 0xfeff
  );
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function codePointAt(s: string, i: number): number | undefined {
  if (i < 0 || i >= s.length) return undefined;
  const hi = s.charCodeAt(i);
  if (isHighSurrogate(hi) && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1);
    if (isLowSurrogate(lo)) return (hi - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
  }
  return hi;
}

function codePointWidth(cp: number): number {
  return cp > 0xffff ? 2 : 1;
}

function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

const ZWJ = 0x200d;
const VS16 = 0xfe0f;
const KEYCAP = 0x20e3;
const TAG_START = 0xe0020;
const TAG_END = 0xe007f;
const SKIN_START = 0x1f3fb;
const SKIN_END = 0x1f3ff;

function isSkinTone(cp: number): boolean {
  return cp >= SKIN_START && cp <= SKIN_END;
}

function isEmojiModifier(cp: number): boolean {
  return cp === VS16 || cp === KEYCAP || isSkinTone(cp) || (cp >= TAG_START && cp <= TAG_END);
}

/** Consume one visible grapheme starting at i. Keeps ZWJ families and RI pairs. */
function graphemeEnd(s: string, i: number): number {
  const first = codePointAt(s, i);
  if (first === undefined) return i;
  let j = i + codePointWidth(first);
  if (isRegionalIndicator(first)) {
    const next = codePointAt(s, j);
    if (next !== undefined && isRegionalIndicator(next)) j += codePointWidth(next);
    return j;
  }
  while (j < s.length) {
    const cp = codePointAt(s, j);
    if (cp === undefined) break;
    if (isEmojiModifier(cp)) {
      j += codePointWidth(cp);
      continue;
    }
    if (cp === ZWJ) {
      const after = codePointAt(s, j + 1);
      if (after === undefined) break;
      j += 1 + codePointWidth(after);
      continue;
    }
    break;
  }
  return j;
}

function stripFillers(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const cp = codePointAt(s, i);
    if (cp === undefined) break;
    const w = codePointWidth(cp);
    if (isFillerCode(cp)) {
      i += w;
      continue;
    }
    if (cp === ZWJ) {
      const next = codePointAt(s, i + w);
      const prev = out.length ? codePointAt(out, out.length - (out.length >= 2 && isLowSurrogate(out.charCodeAt(out.length - 1)) ? 2 : 1)) : undefined;
      if (next !== undefined && prev !== undefined && !isFillerCode(next) && !isFillerCode(prev)) {
        const end = graphemeEnd(s, i);
        out += s.slice(i, end);
        i = end;
        continue;
      }
      i += w;
      continue;
    }
    const end = graphemeEnd(s, i);
    out += s.slice(i, end);
    i = end;
  }
  return out;
}

function isUnpairedRegionalGrapheme(s: string, start: number, end: number): boolean {
  const first = codePointAt(s, start);
  if (first === undefined || !isRegionalIndicator(first)) return false;
  const second = codePointAt(s, start + codePointWidth(first));
  return second === undefined || !isRegionalIndicator(second) || start + codePointWidth(first) + codePointWidth(second) > end;
}

/** Leading run of regional indicators after a clip point (half or full flags). */
function leadingRegionalSequence(s: string): string {
  let i = 0;
  while (i < s.length) {
    const cp = codePointAt(s, i);
    if (cp === undefined || !isRegionalIndicator(cp)) break;
    i += codePointWidth(cp);
  }
  return s.slice(0, i);
}

type NormalizedNeedle = {
  needle: string;
  droppedRegional: string;
};

/** NFC + strip fillers + trim, then clip on grapheme / word bounds. */
function normalizeNeedle(q: string): NormalizedNeedle {
  const s = stripFillers(q.normalize("NFC")).trim();
  if (s.length <= QUERY_MAX_LEN) return { needle: s, droppedRegional: "" };
  let end = 0;
  while (end < s.length) {
    const next = graphemeEnd(s, end);
    if (next > QUERY_MAX_LEN && end > 0) {
      // Keep a complete flag/emoji that sits just past the budget.
      // A lone regional indicator is not a flag — drop it so it cannot
      // includes-match every other flag that shares that letter.
      if (!isUnpairedRegionalGrapheme(s, end, next)) end = next;
      break;
    }
    end = next;
    if (end >= QUERY_MAX_LEN) break;
  }
  let clipped = s.slice(0, end);
  if (end < s.length && /\S/.test(s.charAt(end)) && /\S$/.test(clipped) && /\s/.test(clipped)) {
    clipped = clipped.replace(/\s+\S+$/, "");
  }
  const droppedRegional = leadingRegionalSequence(s.slice(clipped.length));
  return { needle: clipped, droppedRegional };
}

function ownType(row: unknown): FoldedRow["type"] | undefined {
  if (!row || typeof row !== "object") return undefined;
  if (!own(row, "type")) return undefined;
  const t = (row as { type?: unknown }).type;
  if (typeof t === "string" && ROW_TYPES.has(t as FoldedRow["type"])) {
    return t as FoldedRow["type"];
  }
  return undefined;
}

function ownString(row: object, key: string): string | undefined {
  if (!own(row, key)) return undefined;
  const v = (row as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function finiteTs(row: unknown): number | undefined {
  if (!row || typeof row !== "object") return undefined;
  if (!own(row, "ts")) return undefined;
  const ts = (row as { ts?: unknown }).ts;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : undefined;
}

function rebuildGroup(turnId: number, rows: FoldedRow[]): TurnGroup {
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
    } else if (ts !== startTs && startTs === endTs) {
      endTs = ts;
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

export function sanitizeQuery(raw: FilterQuery | unknown): SanitizedQuery {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return { needle: "", types: null };
  }
  let needle = "";
  let droppedRegional = "";
  if (own(raw, "q")) {
    const q = (raw as { q?: unknown }).q;
    if (typeof q === "string") {
      const normalized = normalizeNeedle(q);
      needle = normalized.needle;
      droppedRegional = normalized.droppedRegional;
    }
  }
  let types: Set<FoldedRow["type"]> | null = null;
  if (own(raw, "types")) {
    const rawTypes = (raw as { types?: unknown }).types;
    if (Array.isArray(rawTypes)) {
      const allowed = new Set<FoldedRow["type"]>();
      for (let i = 0; i < rawTypes.length; i++) {
        const t = rawTypes[i];
        if (typeof t === "string" && ROW_TYPES.has(t as FoldedRow["type"])) {
          allowed.add(t as FoldedRow["type"]);
        }
      }
      if (allowed.size > 0) types = allowed;
    }
  }
  if (droppedRegional) return { needle, types, droppedRegional };
  return { needle, types };
}

function hasUnpairedRegionalIndicator(s: string): boolean {
  let i = 0;
  let pending = false;
  while (i < s.length) {
    const cp = codePointAt(s, i);
    if (cp === undefined) break;
    const w = codePointWidth(cp);
    if (isRegionalIndicator(cp)) {
      pending = !pending;
    } else if (pending) {
      return true;
    }
    i += w;
  }
  return pending;
}

function containsRegionalIndicator(s: string): boolean {
  let i = 0;
  while (i < s.length) {
    const cp = codePointAt(s, i);
    if (cp === undefined) break;
    if (isRegionalIndicator(cp)) return true;
    i += codePointWidth(cp);
  }
  return false;
}

/** Advance one atom: a complete RI pair, or a single non-RI code point. */
function atomEnd(s: string, i: number): number {
  const cp = codePointAt(s, i);
  if (cp === undefined) return i;
  const w = codePointWidth(cp);
  if (isRegionalIndicator(cp)) {
    const next = codePointAt(s, i + w);
    if (next !== undefined && isRegionalIndicator(next)) return i + w + codePointWidth(next);
  }
  return i + w;
}

function riAwareIncludes(haystack: string, needle: string): boolean {
  const hay = haystack.toLowerCase();
  const ned = needle.toLowerCase();
  if (ned.length === 0) return true;
  let start = 0;
  while (start < hay.length) {
    let hi = start;
    let ni = 0;
    let ok = true;
    while (ni < ned.length) {
      if (hi >= hay.length) {
        ok = false;
        break;
      }
      const ncp = codePointAt(ned, ni);
      const hcp = codePointAt(hay, hi);
      if (ncp === undefined || hcp === undefined) {
        ok = false;
        break;
      }
      const nEnd = atomEnd(ned, ni);
      const hEnd = atomEnd(hay, hi);
      if (nEnd - ni !== hEnd - hi || ned.slice(ni, nEnd) !== hay.slice(hi, hEnd)) {
        ok = false;
        break;
      }
      ni = nEnd;
      hi = hEnd;
    }
    if (ok) return true;
    start = atomEnd(hay, start);
  }
  return false;
}

export function haystackHas(haystack: string, needle: string): boolean {
  if (needle === "") return true;
  if (typeof haystack !== "string") return false;
  if (hasUnpairedRegionalIndicator(needle)) return false;
  if (!containsRegionalIndicator(needle)) {
    return haystack.toLowerCase().includes(needle.toLowerCase());
  }
  return riAwareIncludes(haystack, needle);
}

export function rowVisibleText(row: FoldedRow): string[] {
  if (!row || typeof row !== "object") return [];
  const type = ownType(row);
  if (type === undefined) return [];
  const out: string[] = [];
  if (TEXT_TYPES.has(type)) {
    const text = ownString(row, "text");
    if (text !== undefined) out.push(clip(text, TEXT_CLIP));
    return out;
  }
  if (type === "thinking") {
    let n: unknown;
    if (own(row, "n")) n = (row as { n?: unknown }).n;
    const label = typeof n === "number" && Number.isFinite(n) ? `思考 · ${n}` : "思考 · ";
    out.push(label);
    return out;
  }
  if (type === "tool") {
    const name = ownString(row, "name");
    const detail = ownString(row, "detail");
    if (name !== undefined) out.push(name);
    if (detail !== undefined) out.push(detail);
    let input: Record<string, unknown> = {};
    if (own(row, "input")) {
      const raw = (row as { input?: unknown }).input;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        input = raw as Record<string, unknown>;
      }
    }
    let output: unknown;
    if (own(row, "output")) output = (row as { output?: unknown }).output;
    const presented = toolCardPresentation(input, output);
    if (presented.inputText) out.push(presented.inputText);
    if (presented.outputText) out.push(presented.outputText);
    return out;
  }
  if (type === "system") {
    if (!own(row, "items")) return out;
    const items = (row as { items?: unknown }).items;
    if (!Array.isArray(items)) return out;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (typeof it === "string") out.push(clip(it, ITEM_CLIP));
    }
  }
  return out;
}

export function rowMatches(row: FoldedRow, q: SanitizedQuery): boolean {
  if (q.types) {
    const t = ownType(row);
    if (t === undefined || !q.types.has(t)) return false;
  }
  if (!q.needle) return true;
  const texts = rowVisibleText(row);
  const matchNeedle = q.droppedRegional ? q.needle + q.droppedRegional : q.needle;
  for (let i = 0; i < texts.length; i++) {
    if (haystackHas(texts[i], matchNeedle)) return true;
  }
  return false;
}

export function filterRows(rows: readonly FoldedRow[], raw?: FilterQuery): FoldedRow[] {
  const q = sanitizeQuery(raw);
  if (!q.needle && q.types === null) return rows.slice();
  const out: FoldedRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (rowMatches(row, q)) out.push(row);
  }
  return out;
}

export function filterGroups(groups: readonly TurnGroup[], raw?: FilterQuery): TurnGroup[] {
  const q = sanitizeQuery(raw);
  if (!q.needle && q.types === null) return groups.slice();
  const out: TurnGroup[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (!group || typeof group !== "object") continue;
    if (!own(group, "turnId") || !own(group, "rows")) continue;
    const turnId = (group as { turnId?: unknown }).turnId;
    const rows = (group as { rows?: unknown }).rows;
    if (typeof turnId !== "number" || !Number.isFinite(turnId) || !Array.isArray(rows)) continue;
    const kept = filterRows(rows, raw);
    if (!kept.length) continue;
    out.push(rebuildGroup(turnId, kept));
  }
  return out;
}
