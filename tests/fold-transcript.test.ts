import { describe, expect, it } from "vitest";
import { foldTranscript, isThinkingTick, type FoldEvent } from "../web/src/lib/fold-transcript.js";

function ev(partial: Partial<FoldEvent> & { kind: string; summary: string }): FoldEvent {
  return { extra: {}, ...partial };
}

describe("isThinkingTick", () => {
  it("matches thinking_tokens, /thinking/i, extra.type thinking", () => {
    expect(isThinkingTick(ev({ kind: "working", summary: "thinking_tokens" }))).toBe(true);
    expect(isThinkingTick(ev({ kind: "working", summary: "Thinking" }))).toBe(true);
    expect(isThinkingTick(ev({ kind: "working", summary: "assistant", extra: { type: "thinking" } }))).toBe(true);
    expect(isThinkingTick(ev({ kind: "working", summary: "assistant", extra: { type: "text" } }))).toBe(false);
  });

  it("is not a tick when thinking text is present", () => {
    expect(
      isThinkingTick(ev({ kind: "working", summary: "assistant", extra: { type: "thinking", text: "hmm" } })),
    ).toBe(false);
  });
});

describe("foldTranscript", () => {
  it("does not mutate input", () => {
    const events = [ev({ kind: "working", summary: "thinking_tokens" })];
    const copy = JSON.parse(JSON.stringify(events));
    foldTranscript(events);
    expect(events).toEqual(copy);
  });

  it("folds consecutive thinking ticks into 思考 · N (event count)", () => {
    const events = [
      ev({ kind: "working", summary: "thinking_tokens" }),
      ev({ kind: "working", summary: "thinking_tokens" }),
      ev({ kind: "working", summary: "thinking_tokens" }),
    ];
    expect(foldTranscript(events)).toEqual([{ type: "thinking", n: 3 }]);
  });

  it("uses extra token number when present", () => {
    const events = [
      ev({ kind: "working", summary: "thinking_tokens", extra: { n: 12 } }),
      ev({ kind: "working", summary: "thinking_tokens", extra: { tokens: 48 } }),
    ];
    expect(foldTranscript(events)).toEqual([{ type: "thinking", n: 48 }]);
  });

  it("puts actual thinking text in thinking_text", () => {
    const events = [
      ev({ kind: "working", summary: "assistant", extra: { type: "thinking", text: "先检查策略" } }),
    ];
    expect(foldTranscript(events)).toEqual([{ type: "thinking_text", text: "先检查策略" }]);
  });

  it("shows sent as user and turn_done result as assistant", () => {
    const events = [
      ev({ kind: "sent", summary: "你好" }),
      ev({ kind: "working", summary: "query sent" }),
      ev({ kind: "working", summary: "thinking_tokens" }),
      ev({ kind: "working", summary: "assistant", extra: { type: "text" } }),
      ev({
        kind: "turn_done",
        summary: "result message (turn, not task)",
        extra: { result: "The host denied the call." },
      }),
      ev({ kind: "idle", summary: "turn complete, waiting", extra: { result: "The host denied the call." } }),
    ];
    expect(foldTranscript(events)).toEqual([
      { type: "user", text: "你好" },
      { type: "system", items: ["已发送查询"] },
      { type: "thinking", n: 1 },
      { type: "assistant", text: "The host denied the call." },
    ]);
  });

  it("hides connected/init/query sent/commands_changed/idle/held/interrupted under 系统", () => {
    const events = [
      ev({ kind: "working", summary: "connected" }),
      ev({ kind: "working", summary: "init" }),
      ev({ kind: "working", summary: "query sent" }),
      ev({ kind: "working", summary: "commands_changed" }),
      ev({ kind: "idle", summary: "turn complete, waiting" }),
      ev({ kind: "held", summary: "lock=operator" }),
      ev({ kind: "interrupted", summary: "interrupt" }),
    ];
    const rows = foldTranscript(events);
    expect(rows).toEqual([
      { type: "system", items: ["已连接", "初始化", "已发送查询", "命令更新"] },
    ]);
  });

  it("shows tool lines and decisions/failures", () => {
    const events = [
      ev({ kind: "working", summary: "tool Bash", extra: { tool: "Bash" } }),
      ev({ kind: "needs_decision", summary: "can_use_tool parked Bash", extra: { tool: "Bash" } }),
      ev({ kind: "failed", summary: "process death", extra: { error: "boom" } }),
    ];
    expect(foldTranscript(events)).toEqual([
      { type: "tool", name: "Bash" },
      { type: "needs_decision", text: "can_use_tool parked Bash" },
      { type: "failed", text: "boom" },
    ]);
  });

  it("shows real prose summary, skips placeholder assistant/init/thinking_tokens", () => {
    const events = [
      ev({ kind: "working", summary: "assistant" }),
      ev({ kind: "working", summary: "thinking_tokens" }),
      ev({ kind: "working", summary: "init" }),
      ev({ kind: "working", summary: "正在读取文件" }),
    ];
    expect(foldTranscript(events)).toEqual([
      { type: "thinking", n: 1 },
      { type: "system", items: ["初始化"] },
      { type: "assistant", text: "正在读取文件" },
    ]);
  });

  it("keeps two thinking groups when interrupted by a tool", () => {
    const events = [
      ev({ kind: "working", summary: "thinking_tokens" }),
      ev({ kind: "working", summary: "thinking_tokens" }),
      ev({ kind: "working", summary: "tool Read", extra: { tool: "Read" } }),
      ev({ kind: "working", summary: "thinking_tokens" }),
    ];
    expect(foldTranscript(events)).toEqual([
      { type: "thinking", n: 2 },
      { type: "tool", name: "Read" },
      { type: "thinking", n: 1 },
    ]);
  });
});
