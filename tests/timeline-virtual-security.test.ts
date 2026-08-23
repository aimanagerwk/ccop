import { describe, expect, it } from "vitest";
import * as virt from "../web/src/lib/timeline-virtual.js";
import {
  DEFAULT_OVERSCAN,
  DEFAULT_ROW_HEIGHT,
  MAX_COUNT,
  MAX_WINDOW,
  sanitizeVirtualParams,
  virtualWindow,
  visibleSlice,
} from "../web/src/lib/timeline-virtual.js";

describe("timeline-virtual security", () => {
  it("virtualWindow NaN scrollTop does not produce NaN indices", () => {
    const win = virtualWindow({
      scrollTop: Number.NaN,
      viewportHeight: 300,
      rowHeight: 72,
      count: 20,
    });
    expect(Number.isNaN(win.start)).toBe(false);
    expect(Number.isNaN(win.end)).toBe(false);
    expect(Number.isFinite(win.start)).toBe(true);
    expect(Number.isFinite(win.end)).toBe(true);
    expect(Number.isFinite(win.offsetTop)).toBe(true);
    expect(Number.isFinite(win.totalHeight)).toBe(true);
    expect(win.start).toBeGreaterThanOrEqual(0);
    expect(win.end).toBeGreaterThanOrEqual(win.start);
  });

  it("virtualWindow Infinity count is clamped", () => {
    const s = sanitizeVirtualParams({
      scrollTop: 0,
      viewportHeight: 300,
      rowHeight: 72,
      count: Number.POSITIVE_INFINITY,
    });
    expect(s.count).toBe(0);
    expect(s.count).toBeLessThanOrEqual(MAX_COUNT);
    const win = virtualWindow({
      scrollTop: 0,
      viewportHeight: 300,
      rowHeight: 72,
      count: Number.POSITIVE_INFINITY,
    });
    expect(win.start).toBe(0);
    expect(win.end).toBe(0);
    expect(win.end).toBeLessThanOrEqual(s.count);
    expect(win.end - win.start).toBeLessThanOrEqual(MAX_WINDOW);
    expect(Number.isFinite(win.totalHeight)).toBe(true);
    expect(win.totalHeight).toBe(0);
  });

  it("virtualWindow negative rowHeight falls back to default", () => {
    const win = virtualWindow({
      scrollTop: 144,
      viewportHeight: 144,
      rowHeight: -20,
      count: 30,
      overscan: 0,
    });
    const s = sanitizeVirtualParams({
      scrollTop: 144,
      viewportHeight: 144,
      rowHeight: -20,
      count: 30,
      overscan: 0,
    });
    expect(s.rowHeight).toBe(DEFAULT_ROW_HEIGHT);
    expect(win.start).toBe(Math.floor(144 / DEFAULT_ROW_HEIGHT));
    expect(win.offsetTop).toBe(win.start * DEFAULT_ROW_HEIGHT);
    expect(win.totalHeight).toBe(30 * DEFAULT_ROW_HEIGHT);
  });

  it("virtualWindow end minus start never exceeds MAX_WINDOW", () => {
    const win = virtualWindow({
      scrollTop: 0,
      viewportHeight: 1e12,
      rowHeight: 1,
      count: MAX_COUNT,
      overscan: 50,
    });
    expect(win.end - win.start).toBeLessThanOrEqual(MAX_WINDOW);
    expect(win.end - win.start).toBe(MAX_WINDOW);
  });

  it("virtualWindow start and end stay inside 0 count", () => {
    const hostiles: Array<Parameters<typeof virtualWindow>[0]> = [
      { scrollTop: Number.NaN, viewportHeight: Number.NaN, rowHeight: Number.NaN, count: Number.NaN },
      { scrollTop: -1e20, viewportHeight: -5, rowHeight: 0, count: -10 },
      {
        scrollTop: Number.POSITIVE_INFINITY,
        viewportHeight: Number.POSITIVE_INFINITY,
        rowHeight: Number.POSITIVE_INFINITY,
        count: Number.POSITIVE_INFINITY,
      },
      {
        scrollTop: Number.NEGATIVE_INFINITY,
        viewportHeight: Number.NEGATIVE_INFINITY,
        rowHeight: Number.NEGATIVE_INFINITY,
        count: Number.NEGATIVE_INFINITY,
      },
      { scrollTop: 1e20, viewportHeight: 1e20, rowHeight: Number.MIN_VALUE, count: MAX_COUNT },
      { scrollTop: 0, viewportHeight: 0, rowHeight: 72, count: 4, overscan: 999 },
    ];
    for (const p of hostiles) {
      const s = sanitizeVirtualParams(p);
      const w = virtualWindow(p);
      expect(Number.isFinite(w.start)).toBe(true);
      expect(Number.isFinite(w.end)).toBe(true);
      expect(w.start).toBeGreaterThanOrEqual(0);
      expect(w.end).toBeGreaterThanOrEqual(w.start);
      expect(w.end).toBeLessThanOrEqual(s.count);
      expect(w.end - w.start).toBeLessThanOrEqual(MAX_WINDOW);
      if (s.count > 0) {
        expect(w.start).toBeLessThan(w.end);
        expect(w.start).toBeLessThan(s.count);
      }
    }
  });

  it("virtualWindow totalHeight is finite for huge count", () => {
    const win = virtualWindow({
      scrollTop: 0,
      viewportHeight: 400,
      rowHeight: 72,
      count: 1e16,
    });
    expect(Number.isFinite(win.totalHeight)).toBe(true);
    expect(win.totalHeight).toBe(MAX_COUNT * 72);
    expect(win.totalHeight).not.toBe(Number.POSITIVE_INFINITY);
  });

  it("visibleSlice does not throw when end exceeds length", () => {
    const items = ["a", "b"];
    expect(() =>
      visibleSlice(items, {
        start: 0,
        end: 50,
        offsetTop: 0,
        totalHeight: 144,
        overscan: DEFAULT_OVERSCAN,
      }),
    ).not.toThrow();
    expect(
      visibleSlice(items, {
        start: 0,
        end: 50,
        offsetTop: 0,
        totalHeight: 144,
        overscan: DEFAULT_OVERSCAN,
      }),
    ).toEqual(["a", "b"]);
  });

  it("endScrollTop never throws on NaN Infinity or huge counts", () => {
    expect(typeof virt.endScrollTop).toBe("function");
    const endScrollTop = virt.endScrollTop as (p: {
      count: number;
      viewportHeight: number;
      rowHeight: number;
    }) => number;
    const hostiles = [
      { count: Number.NaN, viewportHeight: 400, rowHeight: 72 },
      { count: Number.POSITIVE_INFINITY, viewportHeight: Number.POSITIVE_INFINITY, rowHeight: 72 },
      { count: 80, viewportHeight: Number.NaN, rowHeight: Number.NEGATIVE_INFINITY },
      { count: 1e16, viewportHeight: 400, rowHeight: 72 },
    ];
    for (const p of hostiles) {
      expect(() => endScrollTop(p)).not.toThrow();
      const v = endScrollTop(p);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("virtualWindow overscan above cap is clamped", () => {
    const s = sanitizeVirtualParams({
      scrollTop: 0,
      viewportHeight: 72,
      rowHeight: 72,
      count: 80,
      overscan: 999,
    });
    expect(s.overscan).toBe(50);
    const win = virtualWindow({
      scrollTop: 0,
      viewportHeight: 72,
      rowHeight: 72,
      count: 80,
      overscan: 999,
    });
    expect(win.overscan).toBe(50);
    expect(win.end).toBe(Math.ceil(72 / 72) + 50);
  });
});
