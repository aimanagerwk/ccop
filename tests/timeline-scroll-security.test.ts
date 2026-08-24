import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import * as virt from "../web/src/lib/timeline-virtual.js";
import {
  DEFAULT_ROW_HEIGHT,
  endScrollTop,
  nearLatest,
  nextScrollTop,
} from "../web/src/lib/timeline-virtual.js";

afterEach(() => {
  delete (Object.prototype as { reason?: unknown }).reason;
  delete (Object.prototype as { scrollTop?: unknown }).scrollTop;
  delete (Object.prototype as { endTop?: unknown }).endTop;
  delete (Object.prototype as { prevEndTop?: unknown }).prevEndTop;
  delete (Object.prototype as { hacked?: unknown }).hacked;
});

describe("timeline scroll security", () => {
  it("Transcript does not pin open/switch/clear-q with a high default viewport height", () => {
    const tx = readFileSync(new URL("../web/src/components/Transcript.tsx", import.meta.url), "utf8");
    expect(tx).not.toMatch(/viewportHeight\s*>\s*0\s*\?\s*scroll\.viewportHeight\s*:\s*800/);
    expect(tx).not.toMatch(/:\s*800\b/);
    expect(tx).toMatch(/clientHeight/);
    expect(tx).toMatch(/if\s*\(\s*measured\s*<=\s*0\s*\)\s*return/);
    expect(tx).toMatch(/viewportHeight:\s*measured/);
    expect(tx).toMatch(/heightChanged/);
    expect(tx).toMatch(/setQ\(""\)/);
    expect(DEFAULT_ROW_HEIGHT).toBe(72);
  });

  it("DEFAULT_ROW_HEIGHT and the virt CSS stay 72", () => {
    expect(DEFAULT_ROW_HEIGHT).toBe(72);
    const css = readFileSync(new URL("../web/src/app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.tl-virt \.tl-item[\s\S]*?min-height:\s*72px/);
  });

  it("nearLatest never throws and treats hostile numbers as not near", () => {
    expect(typeof nearLatest).toBe("function");
    const hostiles: Array<[number, number]> = [
      [Number.NaN, 400],
      [0, Number.NaN],
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, 400],
      [0, Number.POSITIVE_INFINITY],
      [-1, 400],
    ];
    for (const [scrollTop, endTop] of hostiles) {
      expect(() => nearLatest(scrollTop, endTop)).not.toThrow();
      expect(nearLatest(scrollTop, endTop)).toBe(false);
    }
  });

  it("nextScrollTop never throws on NaN Infinity huge counts or missing args", () => {
    expect(typeof nextScrollTop).toBe("function");
    const huge = endScrollTop({ count: 1e16, viewportHeight: 400, rowHeight: 72 });
    const hostiles: unknown[] = [
      { reason: "count", scrollTop: Number.NaN, endTop: Number.POSITIVE_INFINITY },
      { reason: "query", scrollTop: Number.NEGATIVE_INFINITY, endTop: Number.NaN, prevEndTop: Number.NaN },
      { reason: "session", scrollTop: 1e20, endTop: huge },
      { reason: "clear-q", scrollTop: Number.POSITIVE_INFINITY, endTop: Number.NEGATIVE_INFINITY },
      { reason: "layout", scrollTop: 0, endTop: Number.NaN },
      { reason: "count", scrollTop: 0, endTop: 0, prevEndTop: Number.POSITIVE_INFINITY },
      null,
      undefined,
      {},
      { reason: 1, scrollTop: "x", endTop: false },
    ];
    for (const p of hostiles) {
      expect(() => nextScrollTop(p as Parameters<typeof nextScrollTop>[0])).not.toThrow();
      const v = nextScrollTop(p as Parameters<typeof nextScrollTop>[0]);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("inherited reason cannot force a pin away from the user's scrollTop", () => {
    Object.prototype.reason = "session";
    Object.prototype.endTop = 99999;
    const mid = 240;
    const p = { scrollTop: mid, endTop: 5000 };
    expect(nextScrollTop(p as Parameters<typeof nextScrollTop>[0])).toBe(mid);
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it("inherited prevEndTop cannot force a mid-list count change to the last page", () => {
    Object.prototype.prevEndTop = 200;
    const mid = 200;
    const endTop = 5000;
    expect(
      nextScrollTop({
        reason: "count",
        scrollTop: mid,
        endTop,
      }),
    ).toBe(mid);
    expect(
      nextScrollTop({
        reason: "query",
        scrollTop: mid,
        endTop,
      }),
    ).toBe(mid);
  });

  it("unknown or hostile reason leaves a mid-list scroll unchanged", () => {
    const endTop = endScrollTop({ count: 80, viewportHeight: 400, rowHeight: DEFAULT_ROW_HEIGHT });
    const mid = 180;
    expect(nextScrollTop({ reason: "nope" as "count", scrollTop: mid, endTop })).toBe(mid);
    expect(nextScrollTop({ reason: "" as "count", scrollTop: mid, endTop })).toBe(mid);
    const fromHostileEnd = nextScrollTop({
      reason: "count",
      scrollTop: mid,
      endTop: Number.POSITIVE_INFINITY,
    });
    expect(Number.isFinite(fromHostileEnd)).toBe(true);
    expect(fromHostileEnd).toBeGreaterThanOrEqual(0);
    expect(fromHostileEnd).not.toBe(endTop);
  });
});
