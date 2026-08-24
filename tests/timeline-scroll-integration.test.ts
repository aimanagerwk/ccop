import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as classify from "../src/classify.js";
import { foldTranscript } from "../web/src/lib/fold-transcript.js";
import { filterGroups } from "../web/src/lib/timeline-filter.js";
import { flattenTimeline, groupTurns } from "../web/src/lib/timeline-turn.js";
import {
  DEFAULT_ROW_HEIGHT,
  endScrollTop,
  nearLatest,
  nextScrollTop,
  virtualWindow,
  visibleSlice,
} from "../web/src/lib/timeline-virtual.js";

function readWeb(rel: string): string {
  return readFileSync(new URL(`../web/src/${rel}`, import.meta.url), "utf8");
}

function pinEffects(src: string): Array<{ body: string; deps: string }> {
  return [...src.matchAll(/use(?:Layout)?Effect\(\(\) => \{([\s\S]*?)\}, \[([^\]]*)\]\)/g)].flatMap((m) => {
    const body = m[1] ?? "";
    const deps = m[2] ?? "";
    if (!/endScrollTop|nextScrollTop|el\.scrollTop/.test(body)) return [];
    return [{ body, deps }];
  });
}

describe("timeline scroll wiring", () => {
  it("page passes sessionId and Transcript clears q before pinning a switch", () => {
    const page = readWeb("app/page.tsx");
    const tx = readWeb("components/Transcript.tsx");
    expect(page).toMatch(/<Transcript\b[\s\S]*sessionId=\{current\.id\}/);
    expect(tx).toMatch(/sessionId/);
    expect(tx).toMatch(/setQ\(""\)/);
    expect(tx).toMatch(/nextScrollTop/);
    expect(tx).toMatch(/reason:\s*["']session["']/);
  });

  it("Transcript does not jump to endScrollTop just because items.length changed", () => {
    const tx = readWeb("components/Transcript.tsx");
    expect(tx).toMatch(/nextScrollTop/);
    expect(tx).toMatch(/reason:\s*["']count["']/);
    const effects = pinEffects(tx);
    expect(effects.length).toBeGreaterThan(0);
    for (const { body, deps } of effects) {
      if (/\bitems\.length\b/.test(deps)) {
        expect(body).toMatch(/nextScrollTop/);
        expect(body).toMatch(/reason:\s*["']count["']/);
      }
    }
    expect(tx).not.toMatch(
      /useEffect\(\(\) => \{\s*const top = endScrollTop\([\s\S]*?\}, \[q, items\.length, viewportHeight\]\)/,
    );
  });

  it("mid-query and a new live row pin only when still near latest", () => {
    const tx = readWeb("components/Transcript.tsx");
    expect(tx).toMatch(/reason:\s*["']query["']/);
    expect(tx).toMatch(/reason:\s*["']count["']/);
    expect(tx).toMatch(/reason:\s*["']clear-q["']/);
    expect(tx).toMatch(/nearLatest|nextScrollTop/);
    const effects = pinEffects(tx);
    for (const { body, deps } of effects) {
      if (/\bq\b/.test(deps) || /\bitems\.length\b/.test(deps)) {
        expect(body).toMatch(/nextScrollTop/);
      }
    }
  });

  it("open switch and clear-q land the filtered-or-full window on the last page", () => {
    const events = [];
    for (let i = 0; i < 40; i++) {
      events.push(classify.fromSent({ text: `keep-${i}` })[0]);
      events.push(...classify.fromResult({ is_error: false, result: `reply ${i}` }));
    }
    const items = flattenTimeline(filterGroups(groupTurns(foldTranscript(events)), { q: "" }));
    expect(items.length).toBeGreaterThan(10);
    const last = items[items.length - 1];
    const endTop = endScrollTop({
      count: items.length,
      viewportHeight: 240,
      rowHeight: DEFAULT_ROW_HEIGHT,
    });
    const pinned = nextScrollTop({ reason: "session", scrollTop: 0, endTop });
    expect(pinned).toBe(endTop);
    const cleared = nextScrollTop({ reason: "clear-q", scrollTop: 72, endTop });
    expect(cleared).toBe(endTop);
    const win = virtualWindow({
      scrollTop: pinned,
      viewportHeight: 240,
      rowHeight: DEFAULT_ROW_HEIGHT,
      count: items.length,
      overscan: 0,
    });
    expect(visibleSlice(items, win)).toContain(last);
  });

  it("a new row after leaving latest vicinity keeps the previous scrollTop", () => {
    const viewportHeight = 240;
    const n = 50;
    const endBefore = endScrollTop({ count: n, viewportHeight, rowHeight: DEFAULT_ROW_HEIGHT });
    const mid = 144;
    expect(nearLatest(mid, endBefore)).toBe(false);
    const endAfter = endScrollTop({ count: n + 1, viewportHeight, rowHeight: DEFAULT_ROW_HEIGHT });
    expect(
      nextScrollTop({
        reason: "count",
        scrollTop: mid,
        endTop: endAfter,
      }),
    ).toBe(mid);
  });

  it("a shorter real viewport still lands the last item; default-800 pin leaves it below", () => {
    const events = [];
    for (let i = 0; i < 40; i++) {
      events.push(classify.fromSent({ text: `keep-${i}` })[0]);
      events.push(...classify.fromResult({ is_error: false, result: `reply ${i}` }));
    }
    const items = flattenTimeline(filterGroups(groupTurns(foldTranscript(events)), { q: "" }));
    const last = items[items.length - 1];
    const fake = endScrollTop({
      count: items.length,
      viewportHeight: 800,
      rowHeight: DEFAULT_ROW_HEIGHT,
    });
    const real = endScrollTop({
      count: items.length,
      viewportHeight: 240,
      rowHeight: DEFAULT_ROW_HEIGHT,
    });
    expect(real).toBeGreaterThan(fake);
    const fakeWin = virtualWindow({
      scrollTop: fake,
      viewportHeight: 240,
      rowHeight: DEFAULT_ROW_HEIGHT,
      count: items.length,
      overscan: 0,
    });
    expect(visibleSlice(items, fakeWin)).not.toContain(last);
    const pinned = nextScrollTop({ reason: "session", scrollTop: 0, endTop: real });
    expect(pinned).toBe(real);
    const realWin = virtualWindow({
      scrollTop: pinned,
      viewportHeight: 240,
      rowHeight: DEFAULT_ROW_HEIGHT,
      count: items.length,
      overscan: 0,
    });
    expect(visibleSlice(items, realWin)).toContain(last);
    const cleared = nextScrollTop({ reason: "clear-q", scrollTop: fake, endTop: real });
    expect(cleared).toBe(real);
    const tx = readWeb("components/Transcript.tsx");
    expect(tx).not.toMatch(/viewportHeight\s*>\s*0\s*\?\s*scroll\.viewportHeight\s*:\s*800/);
    expect(tx).toMatch(/clientHeight/);
    expect(tx).toMatch(/if\s*\(\s*measured\s*<=\s*0\s*\)\s*return/);
    expect(tx).toMatch(/viewportHeight:\s*measured/);
    expect(tx).toMatch(/heightChanged/);
  });

  it("after a taller first pin, remasure to a shorter real window still lands the last item", () => {
    const events = [];
    for (let i = 0; i < 40; i++) {
      events.push(classify.fromSent({ text: `keep-${i}` })[0]);
      events.push(...classify.fromResult({ is_error: false, result: `reply ${i}` }));
    }
    const items = flattenTimeline(filterGroups(groupTurns(foldTranscript(events)), { q: "" }));
    const last = items[items.length - 1];
    const fake = endScrollTop({
      count: items.length,
      viewportHeight: 800,
      rowHeight: DEFAULT_ROW_HEIGHT,
    });
    const real = endScrollTop({
      count: items.length,
      viewportHeight: 240,
      rowHeight: DEFAULT_ROW_HEIGHT,
    });
    const first = nextScrollTop({ reason: "session", scrollTop: 0, endTop: fake });
    expect(first).toBe(fake);
    const remasured = nextScrollTop({
      reason: "count",
      scrollTop: first,
      endTop: real,
      prevEndTop: fake,
    });
    expect(remasured).toBe(real);
    const realWin = virtualWindow({
      scrollTop: remasured,
      viewportHeight: 240,
      rowHeight: DEFAULT_ROW_HEIGHT,
      count: items.length,
      overscan: 0,
    });
    expect(visibleSlice(items, realWin)).toContain(last);
    const left = 144;
    expect(
      nextScrollTop({
        reason: "count",
        scrollTop: left,
        endTop: real,
        prevEndTop: fake,
      }),
    ).toBe(left);
    const tx = readWeb("components/Transcript.tsx");
    expect(tx).toMatch(/heightChanged/);
    expect(tx).toMatch(/if\s*\(\s*measured\s*<=\s*0\s*\)\s*return/);
    expect(tx).not.toMatch(/:\s*800\b/);
  });

  it("row height used by Transcript and CSS stays 72", () => {
    expect(DEFAULT_ROW_HEIGHT).toBe(72);
    const tx = readWeb("components/Transcript.tsx");
    const css = readWeb("app/globals.css");
    expect(tx).toMatch(/DEFAULT_ROW_HEIGHT/);
    expect(tx).not.toMatch(/rowHeight:\s*(?!DEFAULT_ROW_HEIGHT)\d+/);
    expect(css).toMatch(/min-height:\s*72px/);
  });

  it("operator path: open pins latest, leave stays, new row and mid-query do not drag, clear and switch pin", () => {
    const viewportHeight = 240;
    const h = DEFAULT_ROW_HEIGHT;
    const events = [];
    for (let i = 0; i < 30; i++) {
      events.push(classify.fromSent({ text: `keep-${i}` })[0]);
      events.push(...classify.fromResult({ is_error: false, result: `reply ${i}` }));
    }
    const items = flattenTimeline(filterGroups(groupTurns(foldTranscript(events)), { q: "" }));
    const endOpen = endScrollTop({ count: items.length, viewportHeight, rowHeight: h });
    let scrollTop = nextScrollTop({ reason: "session", scrollTop: 0, endTop: endOpen });
    expect(scrollTop).toBe(endOpen);
    expect(
      visibleSlice(
        items,
        virtualWindow({
          scrollTop,
          viewportHeight,
          rowHeight: h,
          count: items.length,
          overscan: 0,
        }),
      ),
    ).toContain(items[items.length - 1]);

    const mid = 144;
    scrollTop = mid;
    expect(nearLatest(scrollTop, endOpen)).toBe(false);

    const grown = flattenTimeline(
      filterGroups(
        groupTurns(
          foldTranscript([
            ...events,
            classify.fromSent({ text: "live-new" })[0],
          ]),
        ),
        { q: "" },
      ),
    );
    const endGrown = endScrollTop({ count: grown.length, viewportHeight, rowHeight: h });
    scrollTop = nextScrollTop({
      reason: "count",
      scrollTop,
      endTop: endGrown,
      prevEndTop: endOpen,
    });
    expect(scrollTop).toBe(mid);

    const filtered = flattenTimeline(filterGroups(groupTurns(foldTranscript(events)), { q: "keep-1" }));
    const endQuery = endScrollTop({ count: filtered.length, viewportHeight, rowHeight: h });
    scrollTop = nextScrollTop({
      reason: "query",
      scrollTop: mid,
      endTop: endQuery,
      prevEndTop: endGrown,
    });
    expect(scrollTop).toBe(mid);

    const endCleared = endScrollTop({ count: items.length, viewportHeight, rowHeight: h });
    scrollTop = nextScrollTop({ reason: "clear-q", scrollTop, endTop: endCleared });
    expect(scrollTop).toBe(endCleared);

    const other = flattenTimeline(
      filterGroups(groupTurns(foldTranscript([classify.fromSent({ text: "other-session" })[0]])), { q: "" }),
    );
    const endSwitch = endScrollTop({ count: other.length, viewportHeight, rowHeight: h });
    scrollTop = nextScrollTop({ reason: "session", scrollTop, endTop: endSwitch });
    expect(scrollTop).toBe(endSwitch);
  });
});
