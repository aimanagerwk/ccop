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
      { type: "tool", name: "Bash", detail: "", input: {} },
      { type: "needs_decision", text: "需要批准：Bash" },
      { type: "failed", text: "boom" },
    ]);
  });

  it("rewrites ask / PermissionRequest into 需要批准", () => {
    expect(
      foldTranscript([ev({ kind: "needs_decision", summary: "ask", extra: { reason: "ask" } })]),
    ).toEqual([{ type: "needs_decision", text: "需要批准" }]);
    expect(
      foldTranscript([
        ev({ kind: "needs_decision", summary: "PermissionRequest Write", extra: { tool: "Write" } }),
      ]),
    ).toEqual([{ type: "needs_decision", text: "需要批准：Write" }]);
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
      { type: "tool", name: "Read", detail: "", input: {} },
      { type: "thinking", n: 1 },
    ]);
  });

  it("labels Read/Bash/Write/Edit/Task from extra.input", () => {
    expect(
      foldTranscript([
        ev({
          kind: "working",
          summary: "tool Read",
          extra: { tool: "Read", input: { file_path: "/workspace/ccop/web/src/lib/session-dot.ts" } },
        }),
      ]),
    ).toEqual([
      {
        type: "tool",
        name: "Read",
        detail: "session-dot.ts",
        input: { file_path: "/workspace/ccop/web/src/lib/session-dot.ts" },
      },
    ]);
    expect(
      foldTranscript([
        ev({
          kind: "working",
          summary: "tool Bash",
          extra: { tool: "Bash", input: { command: "ls -la /tmp\necho more" } },
        }),
      ]),
    ).toEqual([
      { type: "tool", name: "Bash", detail: "ls -la /tmp", input: { command: "ls -la /tmp\necho more" } },
    ]);
    expect(
      foldTranscript([
        ev({
          kind: "working",
          summary: "tool Write",
          extra: { tool: "Write", input: { file_path: "/workspace/ccop/web/src/foo.ts", content: "x" } },
        }),
      ]),
    ).toEqual([
      {
        type: "tool",
        name: "Write",
        detail: "/workspace/ccop/web/src/foo.ts",
        input: { file_path: "/workspace/ccop/web/src/foo.ts", content: "x" },
      },
    ]);
    expect(
      foldTranscript([
        ev({
          kind: "working",
          summary: "tool Edit",
          extra: { tool: "Edit", input: { file_path: "/workspace/ccop/a.ts" } },
        }),
      ]),
    ).toEqual([
      { type: "tool", name: "Edit", detail: "/workspace/ccop/a.ts", input: { file_path: "/workspace/ccop/a.ts" } },
    ]);
    expect(
      foldTranscript([
        ev({
          kind: "working",
          summary: "tool Task",
          extra: { tool: "Task", input: { description: "扫一遍测试", prompt: "long" } },
        }),
      ]),
    ).toEqual([
      {
        type: "tool",
        name: "Task",
        detail: "扫一遍测试",
        input: { description: "扫一遍测试", prompt: "long" },
      },
    ]);
  });

  it("hides Pre/Post tool hooks, empty Object, and Stop hooks", () => {
    const events = [
      ev({ kind: "working", summary: "PreToolUse", extra: { tool_name: "Read" } }),
      ev({ kind: "working", summary: "PostToolUse", extra: { tool_name: "Read" } }),
      ev({ kind: "working", summary: "Object" }),
      ev({ kind: "working", summary: "Stop hook" }),
      ev({ kind: "working", summary: "Stop" }),
      ev({ kind: "working", summary: "init" }),
    ];
    expect(foldTranscript(events)).toEqual([{ type: "system", items: ["初始化"] }]);
    expect(
      foldTranscript([
        ev({ kind: "working", summary: "PreToolUse" }),
        ev({ kind: "working", summary: "Object" }),
        ev({ kind: "working", summary: "Stop hook" }),
      ]),
    ).toEqual([]);
  });

  it("attaches PostToolUse tool_response onto the matching tool row", () => {
    const events = [
      ev({
        kind: "working",
        summary: "tool Bash",
        extra: { tool: "Bash", tool_use_id: "tu_1", input: { command: "echo hi" } },
        ts: 10,
      }),
      ev({
        kind: "working",
        summary: "PostToolUse",
        extra: {
          hook: "PostToolUse",
          tool_name: "Bash",
          tool_use_id: "tu_1",
          tool_response: { stdout: "hi\n", stderr: "", interrupted: false },
        },
        ts: 11,
      }),
    ];
    expect(foldTranscript(events)).toEqual([
      {
        type: "tool",
        name: "Bash",
        detail: "echo hi",
        input: { command: "echo hi" },
        tool_use_id: "tu_1",
        output: { stdout: "hi\n", stderr: "", interrupted: false },
        ts: 10,
      },
    ]);
  });

  it("attaches parallel PostToolUse results only by tool_use_id", () => {
    const events = [
      ev({
        kind: "working",
        summary: "tool Read",
        extra: { tool: "Read", tool_use_id: "a", input: { file_path: "/a.ts" } },
      }),
      ev({
        kind: "working",
        summary: "tool Read",
        extra: { tool: "Read", tool_use_id: "b", input: { file_path: "/b.ts" } },
      }),
      ev({
        kind: "working",
        summary: "PostToolUse",
        extra: { tool_use_id: "b", tool_response: { type: "text", file: { content: "B" } } },
      }),
      ev({
        kind: "working",
        summary: "PostToolUse",
        extra: { tool_use_id: "a", tool_response: { type: "text", file: { content: "A" } } },
      }),
    ];
    const rows = foldTranscript(events);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ type: "tool", tool_use_id: "a", output: { type: "text", file: { content: "A" } } });
    expect(rows[1]).toMatchObject({ type: "tool", tool_use_id: "b", output: { type: "text", file: { content: "B" } } });
  });

  it("does not attach mismatched or empty tool_use_id", () => {
    const events = [
      ev({
        kind: "working",
        summary: "tool Bash",
        extra: { tool: "Bash", tool_use_id: "keep", input: { command: "ls" } },
      }),
      ev({
        kind: "working",
        summary: "PostToolUse",
        extra: { tool_use_id: "other", tool_response: { stdout: "nope" } },
      }),
      ev({
        kind: "working",
        summary: "PostToolUse",
        extra: { tool_response: { stdout: "latest?" } },
      }),
      ev({
        kind: "working",
        summary: "PostToolUse",
        extra: { tool_use_id: "", tool_response: { stdout: "empty-id" } },
      }),
    ];
    expect(foldTranscript(events)).toEqual([
      { type: "tool", name: "Bash", detail: "ls", input: { command: "ls" }, tool_use_id: "keep" },
    ]);
  });

  it("attaches PostToolUseFailure error without a second tool row", () => {
    const events = [
      ev({
        kind: "working",
        summary: "tool Write",
        extra: { tool: "Write", tool_use_id: "w1", input: { file_path: "/a.ts" } },
      }),
      ev({
        kind: "working",
        summary: "PostToolUseFailure Write",
        extra: { hook: "PostToolUseFailure", tool_name: "Write", tool_use_id: "w1", error: "EACCES" },
      }),
    ];
    expect(foldTranscript(events)).toEqual([
      {
        type: "tool",
        name: "Write",
        detail: "/a.ts",
        input: { file_path: "/a.ts" },
        tool_use_id: "w1",
        output: "EACCES",
        is_error: true,
      },
    ]);
  });

  it("attaches user tool_result content / tool_use_result by id", () => {
    const events = [
      ev({
        kind: "working",
        summary: "tool Bash",
        extra: { tool: "Bash", tool_use_id: "u1", input: { command: "pwd" } },
      }),
      ev({
        kind: "working",
        summary: "tool_result",
        extra: { tool_use_id: "u1", content: "denied", is_error: true },
      }),
    ];
    expect(foldTranscript(events)).toEqual([
      {
        type: "tool",
        name: "Bash",
        detail: "pwd",
        input: { command: "pwd" },
        tool_use_id: "u1",
        output: "denied",
        is_error: true,
      },
    ]);
  });

  it("prefers tool_response over tool_use_result over content over error", () => {
    const events = [
      ev({
        kind: "working",
        summary: "tool Read",
        extra: { tool: "Read", tool_use_id: "p1", input: { file_path: "/x" } },
      }),
      ev({
        kind: "working",
        summary: "PostToolUse",
        extra: {
          tool_use_id: "p1",
          tool_response: { ok: 1 },
          tool_use_result: { ok: 2 },
          content: "text",
          error: "err",
        },
      }),
    ];
    expect(foldTranscript(events)[0]).toMatchObject({ output: { ok: 1 } });
  });

  it("does not mutate input events when attaching output", () => {
    const events = [
      ev({
        kind: "working",
        summary: "tool Bash",
        extra: { tool: "Bash", tool_use_id: "m1", input: { command: "echo" } },
        ts: 1,
      }),
      ev({
        kind: "working",
        summary: "PostToolUse",
        extra: { tool_use_id: "m1", tool_response: { stdout: "x" } },
        ts: 2,
      }),
    ];
    const copy = JSON.parse(JSON.stringify(events));
    foldTranscript(events);
    expect(events).toEqual(copy);
    expect(events[0].extra).not.toHaveProperty("output");
    expect(events[0].extra).not.toHaveProperty("tool_response");
  });

  it("keeps the tool-use timestamp, not the PostToolUse timestamp", () => {
    const rows = foldTranscript([
      ev({
        kind: "working",
        summary: "tool Read",
        extra: { tool: "Read", tool_use_id: "t1", input: { file_path: "/a.ts" } },
        ts: 40,
      }),
      ev({
        kind: "working",
        summary: "PostToolUse",
        extra: { tool_use_id: "t1", tool_response: { type: "text", file: { content: "z" } } },
        ts: 99,
      }),
    ]);
    expect(rows).toEqual([
      {
        type: "tool",
        name: "Read",
        detail: "a.ts",
        input: { file_path: "/a.ts" },
        tool_use_id: "t1",
        output: { type: "text", file: { content: "z" } },
        ts: 40,
      },
    ]);
  });
});

describe("toolCardPresentation", () => {
  it("opens when input has keys, output is present, or both; closed when neither", async () => {
    const { toolCardPresentation } = await import("../web/src/lib/fold-transcript.js");
    expect(toolCardPresentation({ command: "ls" }, undefined).open).toBe(true);
    expect(toolCardPresentation({}, "stdout").open).toBe(true);
    expect(toolCardPresentation({ command: "ls" }, { stdout: "x" }).open).toBe(true);
    expect(toolCardPresentation({}, undefined).open).toBe(false);
    expect(toolCardPresentation({}, null).open).toBe(false);
  });

  it("formats string output as text and objects as JSON", async () => {
    const { toolCardPresentation } = await import("../web/src/lib/fold-transcript.js");
    expect(toolCardPresentation({}, "plain").outputText).toBe("plain");
    expect(toolCardPresentation({}, { stdout: "x" }).outputText).toBe(JSON.stringify({ stdout: "x" }, null, 2));
    expect(toolCardPresentation({ a: 1 }, undefined).inputText).toBe(JSON.stringify({ a: 1 }, null, 2));
  });
});
