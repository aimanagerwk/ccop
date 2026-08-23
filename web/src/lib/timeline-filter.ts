/** Filter folded transcript rows / turn groups. Does not mutate input. */

import { toolCardPresentation, TOOL_OUTPUT_CLIP, type FoldedRow } from "./fold-transcript";
import type { TurnGroup } from "./timeline-turn";
import { localDayKey } from "./format-ts";

export const QUERY_MAX_LEN = 200;
export const TEXT_CLIP = TOOL_OUTPUT_CLIP;
export const ITEM_CLIP = 256;

export type FilterQuery = {
  q?: string;
  types?: readonly FoldedRow["type"][];
};

export type SanitizedQuery = {
  needle: string;
  types: ReadonlySet<FoldedRow["type"]> | null;
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
  for (const row of rows) {
    const ts = finiteTs(row);
    if (ts === undefined) continue;
    if (startTs === undefined || ts < startTs) startTs = ts;
    if (endTs === undefined || ts > endTs) endTs = ts;
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
  if (own(raw, "q")) {
    const q = (raw as { q?: unknown }).q;
    if (typeof q === "string") {
      needle = q.trim().slice(0, QUERY_MAX_LEN);
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
  return { needle, types };
}

export function haystackHas(haystack: string, needle: string): boolean {
  if (needle === "") return true;
  if (typeof haystack !== "string") return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
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
  for (let i = 0; i < texts.length; i++) {
    if (haystackHas(texts[i], q.needle)) return true;
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
