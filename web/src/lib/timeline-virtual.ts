/** Deterministic virtual-window math. Does not mutate input. No DOM. */

export const DEFAULT_OVERSCAN = 6;
export const DEFAULT_ROW_HEIGHT = 72;
export const MAX_WINDOW = 500;
export const MAX_COUNT = 1_000_000;
export const MAX_ROW_HEIGHT = 400;
export const MAX_OVERSCAN = 50;

export type VirtualParams = {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  count: number;
  overscan?: number;
};

export type VirtualWindow = {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
  overscan: number;
};

function own(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function ownNumber(obj: object, key: string): number | undefined {
  if (!own(obj, key)) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

function clampIndex(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return n === Number.POSITIVE_INFINITY ? hi : lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function finiteOrZero(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function sanitizeVirtualParams(p: VirtualParams): Required<VirtualParams> {
  const obj = p && typeof p === "object" && !Array.isArray(p) ? p : {};

  const rawH = ownNumber(obj, "rowHeight");
  let rowHeight = DEFAULT_ROW_HEIGHT;
  if (rawH !== undefined && Number.isFinite(rawH) && rawH > 0) {
    rowHeight = rawH > MAX_ROW_HEIGHT ? MAX_ROW_HEIGHT : rawH;
  }

  const rawC = ownNumber(obj, "count");
  let count = 0;
  if (rawC !== undefined && Number.isFinite(rawC) && rawC >= 0) {
    count = Math.min(MAX_COUNT, Math.floor(rawC));
  }

  const rawS = ownNumber(obj, "scrollTop");
  let scrollTop = 0;
  if (rawS !== undefined && Number.isFinite(rawS) && rawS >= 0) {
    scrollTop = rawS;
  }

  const rawV = ownNumber(obj, "viewportHeight");
  let viewportHeight = 0;
  if (rawV !== undefined && Number.isFinite(rawV) && rawV > 0) {
    viewportHeight = rawV;
  }

  const rawO = ownNumber(obj, "overscan");
  let overscan = DEFAULT_OVERSCAN;
  if (rawO !== undefined && Number.isFinite(rawO) && rawO >= 0) {
    overscan = Math.min(MAX_OVERSCAN, Math.floor(rawO));
  }

  const contentHeight = count * rowHeight;
  const maxScroll = Number.isFinite(contentHeight)
    ? Math.max(0, contentHeight - viewportHeight)
    : 0;
  scrollTop = Math.min(scrollTop, maxScroll);

  return { scrollTop, viewportHeight, rowHeight, count, overscan };
}

/** Last-page scrollTop so the newest rows sit in view. Hostile numbers become 0. */
export function endScrollTop(p: {
  count: number;
  viewportHeight: number;
  rowHeight: number;
}): number {
  const obj = p && typeof p === "object" && !Array.isArray(p) ? p : {};
  const s = sanitizeVirtualParams({
    scrollTop: 0,
    viewportHeight: ownNumber(obj, "viewportHeight") ?? 0,
    rowHeight: ownNumber(obj, "rowHeight") ?? 0,
    count: ownNumber(obj, "count") ?? 0,
  });
  const contentHeight = s.count * s.rowHeight;
  if (!Number.isFinite(contentHeight)) return 0;
  return Math.max(0, contentHeight - s.viewportHeight);
}

export function virtualWindow(p: VirtualParams): VirtualWindow {
  const s = sanitizeVirtualParams(p);
  if (s.count === 0) {
    return { start: 0, end: 0, offsetTop: 0, totalHeight: 0, overscan: s.overscan };
  }

  let start = Math.floor(s.scrollTop / s.rowHeight) - s.overscan;
  start = clampIndex(start, 0, s.count - 1);

  let end = Math.ceil((s.scrollTop + s.viewportHeight) / s.rowHeight) + s.overscan;
  end = clampIndex(end, start + 1, s.count);
  if (end - start > MAX_WINDOW) end = start + MAX_WINDOW;

  const offsetTop = finiteOrZero(start * s.rowHeight);
  const totalHeight = finiteOrZero(s.count * s.rowHeight);

  return { start, end, offsetTop, totalHeight, overscan: s.overscan };
}

export function visibleSlice<T>(items: readonly T[], win: VirtualWindow): T[] {
  if (!Array.isArray(items)) return [];
  if (!win || typeof win !== "object") return items.slice();
  const start = ownNumber(win, "start");
  const end = ownNumber(win, "end");
  const from = typeof start === "number" && Number.isFinite(start) ? Math.max(0, start) : 0;
  const toRaw = typeof end === "number" && Number.isFinite(end) ? end : items.length;
  const to = Math.min(toRaw, items.length);
  return items.slice(from, to);
}
