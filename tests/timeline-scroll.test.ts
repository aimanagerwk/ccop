import { describe, expect, it } from "vitest";
import * as virt from "../web/src/lib/timeline-virtual.js";
import {
  DEFAULT_ROW_HEIGHT,
  endScrollTop,
  nearLatest,
  nextScrollTop,
} from "../web/src/lib/timeline-virtual.js";

describe("timeline scroll policy", () => {
  it("DEFAULT_ROW_HEIGHT stays 72", () => {
    expect(DEFAULT_ROW_HEIGHT).toBe(72);
    expect(virt.DEFAULT_ROW_HEIGHT).toBe(72);
  });

  it("nearLatest is true only when 贴底 / already on the last page", () => {
    expect(typeof nearLatest).toBe("function");
    expect(nearLatest(5360, 5360)).toBe(true);
    expect(nearLatest(5288, 5360)).toBe(false);
    expect(nearLatest(0, 5360)).toBe(false);
    expect(nearLatest(200, 5360)).toBe(false);
  });

  it("item count change alone does not force a mid-list scroll to the last page", () => {
    const viewportHeight = 400;
    const endBefore = endScrollTop({ count: 80, viewportHeight, rowHeight: DEFAULT_ROW_HEIGHT });
    const mid = 200;
    expect(mid).toBeLessThan(endBefore - DEFAULT_ROW_HEIGHT);
    const endAfter = endScrollTop({ count: 81, viewportHeight, rowHeight: DEFAULT_ROW_HEIGHT });
    expect(endAfter).toBe(endBefore + DEFAULT_ROW_HEIGHT);
    expect(
      nextScrollTop({
        reason: "count",
        scrollTop: mid,
        endTop: endAfter,
      }),
    ).toBe(mid);
    expect(
      nextScrollTop({
        reason: "count",
        scrollTop: mid,
        endTop: endAfter,
      }),
    ).not.toBe(endAfter);
  });

  it("a new row still pins when the user is already on the last page", () => {
    const viewportHeight = 400;
    const endBefore = endScrollTop({ count: 80, viewportHeight, rowHeight: DEFAULT_ROW_HEIGHT });
    const endAfter = endScrollTop({ count: 81, viewportHeight, rowHeight: DEFAULT_ROW_HEIGHT });
    expect(nearLatest(endBefore, endAfter)).toBe(false);
    expect(nearLatest(endBefore, endBefore)).toBe(true);
    expect(
      nextScrollTop({
        reason: "count",
        scrollTop: endBefore,
        endTop: endAfter,
        prevEndTop: endBefore,
      }),
    ).toBe(endAfter);
  });

  it("open switch and clear-q always land on endScrollTop even from mid-list", () => {
    const endTop = endScrollTop({ count: 80, viewportHeight: 400, rowHeight: DEFAULT_ROW_HEIGHT });
    const mid = 144;
    expect(nextScrollTop({ reason: "session", scrollTop: mid, endTop })).toBe(endTop);
    expect(nextScrollTop({ reason: "clear-q", scrollTop: mid, endTop })).toBe(endTop);
    expect(nextScrollTop({ reason: "layout", scrollTop: 0, endTop })).toBe(endTop);
  });

  it("changing search text does not drag a scrolled-away user", () => {
    const endTop = endScrollTop({ count: 40, viewportHeight: 400, rowHeight: DEFAULT_ROW_HEIGHT });
    const mid = 72;
    expect(nearLatest(mid, endTop)).toBe(false);
    expect(
      nextScrollTop({
        reason: "query",
        scrollTop: mid,
        endTop,
      }),
    ).toBe(mid);
  });

  it("changing search text still pins when the user is in the latest vicinity", () => {
    const endTop = endScrollTop({ count: 40, viewportHeight: 400, rowHeight: DEFAULT_ROW_HEIGHT });
    expect(
      nextScrollTop({
        reason: "query",
        scrollTop: endTop,
        endTop,
      }),
    ).toBe(endTop);
    expect(
      nextScrollTop({
        reason: "query",
        scrollTop: endTop,
        endTop,
        prevEndTop: endTop,
      }),
    ).toBe(endTop);
    expect(
      nextScrollTop({
        reason: "query",
        scrollTop: endTop - DEFAULT_ROW_HEIGHT,
        endTop,
        prevEndTop: endTop,
      }),
    ).toBe(endTop - DEFAULT_ROW_HEIGHT);
  });

  it("a new row after leaving the previous last page keeps scrollTop", () => {
    const viewportHeight = 400;
    const endBefore = endScrollTop({ count: 80, viewportHeight, rowHeight: DEFAULT_ROW_HEIGHT });
    const endAfter = endScrollTop({ count: 81, viewportHeight, rowHeight: DEFAULT_ROW_HEIGHT });
    const left = endBefore - 1;
    expect(nearLatest(left, endBefore)).toBe(false);
    expect(
      nextScrollTop({
        reason: "count",
        scrollTop: left,
        endTop: endAfter,
        prevEndTop: endBefore,
      }),
    ).toBe(left);
  });
});
