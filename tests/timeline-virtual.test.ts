import { describe, expect, it } from "vitest";
import * as virt from "../web/src/lib/timeline-virtual.js";
import {
  DEFAULT_OVERSCAN,
  DEFAULT_ROW_HEIGHT,
  virtualWindow,
  visibleSlice,
} from "../web/src/lib/timeline-virtual.js";

describe("virtualWindow", () => {
  it("virtualWindow empty count returns a zero window", () => {
    const win = virtualWindow({
      scrollTop: 240,
      viewportHeight: 400,
      rowHeight: 72,
      count: 0,
    });
    expect(win).toEqual({
      start: 0,
      end: 0,
      offsetTop: 0,
      totalHeight: 0,
      overscan: DEFAULT_OVERSCAN,
    });
  });

  it("virtualWindow start is floor scrollTop over rowHeight minus overscan", () => {
    const win = virtualWindow({
      scrollTop: 720,
      viewportHeight: 144,
      rowHeight: 72,
      count: 100,
      overscan: 2,
    });
    expect(win.start).toBe(Math.floor(720 / 72) - 2);
    expect(win.start).toBe(8);
  });

  it("virtualWindow end includes viewport plus overscan", () => {
    const win = virtualWindow({
      scrollTop: 0,
      viewportHeight: 144,
      rowHeight: 72,
      count: 100,
      overscan: 2,
    });
    expect(win.end).toBe(Math.ceil((0 + 144) / 72) + 2);
    expect(win.end).toBe(4);
  });

  it("virtualWindow clamps start to 0", () => {
    const win = virtualWindow({
      scrollTop: 0,
      viewportHeight: 72,
      rowHeight: 72,
      count: 20,
      overscan: 6,
    });
    expect(win.start).toBe(0);
  });

  it("virtualWindow clamps end to count", () => {
    const win = virtualWindow({
      scrollTop: 0,
      viewportHeight: 10_000,
      rowHeight: 72,
      count: 3,
      overscan: 6,
    });
    expect(win.end).toBe(3);
    expect(win.start).toBe(0);
  });

  it("virtualWindow default overscan is 6", () => {
    const win = virtualWindow({
      scrollTop: 0,
      viewportHeight: 72,
      rowHeight: 72,
      count: 50,
    });
    expect(win.overscan).toBe(6);
    expect(win.overscan).toBe(DEFAULT_OVERSCAN);
    expect(win.end - win.start).toBe(Math.ceil(72 / 72) + DEFAULT_OVERSCAN);
  });

  it("virtualWindow offsetTop equals start times rowHeight", () => {
    const win = virtualWindow({
      scrollTop: 720,
      viewportHeight: 144,
      rowHeight: 72,
      count: 100,
      overscan: 2,
    });
    expect(win.start).toBe(8);
    expect(win.offsetTop).toBe(8 * 72);
    expect(Number.isFinite(win.offsetTop)).toBe(true);
  });

  it("endScrollTop pins a long list to the last page and a short list to 0", () => {
    expect(typeof virt.endScrollTop).toBe("function");
    const endScrollTop = virt.endScrollTop as (p: {
      count: number;
      viewportHeight: number;
      rowHeight: number;
    }) => number;
    expect(endScrollTop({ count: 1, viewportHeight: 400, rowHeight: 72 })).toBe(0);
    expect(endScrollTop({ count: 80, viewportHeight: 400, rowHeight: 72 })).toBe(80 * 72 - 400);
    expect(endScrollTop({ count: 0, viewportHeight: 400, rowHeight: 72 })).toBe(0);
  });

  it("virtualWindow totalHeight equals count times rowHeight", () => {
    const win = virtualWindow({
      scrollTop: 0,
      viewportHeight: 200,
      rowHeight: DEFAULT_ROW_HEIGHT,
      count: 40,
    });
    expect(win.totalHeight).toBe(40 * DEFAULT_ROW_HEIGHT);
    expect(Number.isFinite(win.totalHeight)).toBe(true);
  });
});

describe("visibleSlice", () => {
  it("visibleSlice returns items from start inclusive to end exclusive", () => {
    const items = ["a", "b", "c", "d", "e"];
    const win = virtualWindow({
      scrollTop: 72,
      viewportHeight: 144,
      rowHeight: 72,
      count: items.length,
      overscan: 0,
    });
    expect(win.start).toBe(1);
    expect(win.end).toBe(3);
    expect(visibleSlice(items, win)).toEqual(["b", "c"]);
  });

  it("visibleSlice does not mutate items", () => {
    const items = ["a", "b", "c"];
    const snapshot = items.slice();
    Object.freeze(items);
    const win = virtualWindow({
      scrollTop: 0,
      viewportHeight: 72,
      rowHeight: 72,
      count: items.length,
      overscan: 0,
    });
    const out = visibleSlice(items, win);
    expect(out).toEqual(["a"]);
    expect(out).not.toBe(items);
    expect(items).toEqual(snapshot);
    expect(Object.isFrozen(items)).toBe(true);
  });
});
