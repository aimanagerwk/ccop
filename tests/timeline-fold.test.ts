import { describe, expect, it } from "vitest";
import { foldTranscript, type FoldEvent } from "../web/src/lib/fold-transcript.js";
import { sharePercents, tokenBarShares } from "../web/src/lib/workflow-monitor.js";

function ev(partial: Partial<FoldEvent> & { kind: string; summary: string }): FoldEvent {
  return { extra: {}, ...partial };
}

describe("foldTranscript timestamps", () => {
  it("copies finite ts onto user / assistant / tool / status rows", () => {
    const rows = foldTranscript([
      ev({ kind: "sent", summary: "你好", ts: 10.5 }),
      ev({
        kind: "working",
        summary: "tool Read",
        extra: { tool: "Read", input: { file_path: "/a/b.ts" } },
        ts: 11,
      }),
      ev({ kind: "turn_done", summary: "result message (turn, not task)", extra: { result: "ok" }, ts: 12 }),
      ev({ kind: "needs_decision", summary: "ask", extra: { reason: "ask" }, ts: 13 }),
    ]);
    expect(rows).toEqual([
      { type: "user", text: "你好", ts: 10.5 },
      { type: "tool", name: "Read", detail: "b.ts", input: { file_path: "/a/b.ts" }, ts: 11 },
      { type: "assistant", text: "ok", ts: 12 },
      { type: "needs_decision", text: "需要批准", ts: 13 },
    ]);
  });

  it("uses the first tick ts for a folded thinking group", () => {
    const rows = foldTranscript([
      ev({ kind: "working", summary: "thinking_tokens", ts: 20 }),
      ev({ kind: "working", summary: "thinking_tokens", ts: 21 }),
    ]);
    expect(rows).toEqual([{ type: "thinking", n: 2, ts: 20 }]);
  });

  it("does not invent ts when the event has none", () => {
    expect(foldTranscript([ev({ kind: "sent", summary: "x" })])).toEqual([{ type: "user", text: "x" }]);
  });
});

describe("sharePercents / tokenBarShares", () => {
  it("normalizes to 100 without a fourth hue", () => {
    const segs = sharePercents([
      { key: "input", label: "输入", n: 80 },
      { key: "output", label: "输出", n: 20 },
    ]);
    expect(segs.map((s) => s.pct)).toEqual([80, 20]);
    expect(sharePercents([])).toEqual([]);
    expect(sharePercents([{ key: "x", label: "x", n: 0 }])).toEqual([]);
  });

  it("merges cache read+write into one bar series", () => {
    expect(
      tokenBarShares({
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
        cost_usd: 0.1,
      }),
    ).toEqual([
      { key: "input", label: "输入", n: 10 },
      { key: "output", label: "输出", n: 4 },
      { key: "cache", label: "缓存", n: 3 },
    ]);
  });
});
