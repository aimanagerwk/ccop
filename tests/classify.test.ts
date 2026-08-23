import { describe, expect, it } from "vitest";
import * as classify from "../src/classify.js";

describe("classify", () => {
  it("result is turn not task", () => {
    const evs = classify.fromResult({ is_error: false, session_id: "abc", result: "ok" });
    const kinds = evs.map((e) => e.kind);
    expect(kinds).toContain("turn_done");
    expect(kinds).not.toContain("task_done");
    expect(kinds).toContain("idle");
  });

  it("result error failed", () => {
    const evs = classify.fromResult({ is_error: true, session_id: "x" });
    const kinds = evs.map((e) => e.kind);
    expect(kinds).toContain("turn_done");
    expect(kinds).toContain("failed");
    expect(kinds).not.toContain("task_done");
  });

  it("task completed is task_done", () => {
    const evs = classify.fromTaskNotification({ status: "completed", summary: "done", task_id: "t1" });
    expect(evs[0].kind).toBe("task_done");
    expect(evs[0].extra.task_id).toBe("t1");
  });

  it("task failed", () => {
    const evs = classify.fromTaskNotification({ status: "failed", summary: "boom" });
    expect(evs[0].kind).toBe("failed");
  });

  it("ask user question", () => {
    const evs = classify.fromToolUse({ name: "AskUserQuestion", tool_use_id: "u1" });
    const kinds = evs.map((e) => e.kind);
    expect(kinds).toContain("needs_info");
    expect(kinds).toContain("needs_decision");
  });

  it("permission request", () => {
    const evs = classify.fromPermissionRequest({ tool_name: "Write", tool_use_id: "w1" });
    expect(evs[0].kind).toBe("needs_decision");
  });

  it("parked canUseTool", () => {
    let evs = classify.fromParkedCanUseTool({ tool_name: "Bash", tool_use_id: "b1", reason: "ask" });
    expect(evs[0].kind).toBe("needs_decision");
    evs = classify.fromParkedCanUseTool({ tool_name: "AskUserQuestion", tool_use_id: "q1" });
    const kinds = evs.map((e) => e.kind);
    expect(kinds).toContain("needs_info");
    expect(kinds).toContain("needs_decision");
  });

  it("process death", () => {
    const evs = classify.fromProcessDeath({ error: "boom" });
    expect(evs.map((e) => e.kind)).toEqual(["failed", "dead"]);
  });

  it("sent interrupted held", () => {
    expect(classify.fromSent({ text: "hi" })[0].kind).toBe("sent");
    expect(classify.fromInterrupted()[0].kind).toBe("interrupted");
    expect(classify.fromHeld()[0].kind).toBe("held");
  });

  it("hook permission request", () => {
    const evs = classify.fromHook("PermissionRequest", { tool_name: "Edit" });
    expect(evs[0].kind).toBe("needs_decision");
  });

  it("hook tools working", () => {
    expect(classify.fromHook("PreToolUse", { tool_name: "Read" })[0].kind).toBe("working");
    expect(classify.fromHook("PostToolUse", {})[0].kind).toBe("working");
  });

  it("PostToolUse copies tool_response onto extra without a new kind", () => {
    const evs = classify.fromHook("PostToolUse", {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "tu_1",
      tool_response: { stdout: "hi", stderr: "", interrupted: false },
      duration_ms: 12,
      transcript_path: "/tmp/t.jsonl",
      cwd: "/workspace/ccop",
      permission_mode: "auto",
      tool_input: { command: "echo hi" },
    });
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe("working");
    expect(evs[0].summary).toBe("PostToolUse");
    expect(evs[0].extra).toEqual({
      hook: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "tu_1",
      tool_response: { stdout: "hi", stderr: "", interrupted: false },
      duration_ms: 12,
    });
    expect(classify.KINDS).not.toContain("PostToolUse");
    expect(classify.KINDS).not.toContain("tool_result");
  });

  it("PostToolUseFailure copies error and is_interrupt", () => {
    const evs = classify.fromHook("PostToolUseFailure", {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Write",
      tool_use_id: "tu_w",
      error: "EACCES",
      is_interrupt: false,
      duration_ms: 3,
      transcript_path: "/secret.jsonl",
      cwd: "/tmp",
    });
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe("working");
    expect(evs[0].summary).toContain("PostToolUseFailure");
    expect(evs[0].summary).toContain("Write");
    expect(evs[0].extra).toEqual({
      hook: "PostToolUseFailure",
      tool_name: "Write",
      tool_use_id: "tu_w",
      error: "EACCES",
      is_interrupt: false,
      duration_ms: 3,
    });
  });

  it("fromHook does not copy transcript_path, cwd, or unknown keys", () => {
    const evs = classify.fromHook("PostToolUse", {
      tool_name: "Read",
      tool_use_id: "r1",
      tool_response: { type: "text", file: { filePath: "/a.ts", content: "x" } },
      transcript_path: "/leak/path",
      cwd: "/leak/cwd",
      permission_mode: "bypassPermissions",
      session_id: "sess",
      prompt_id: "p1",
      mystery: "drop-me",
    });
    const keys = Object.keys(evs[0].extra).sort();
    expect(keys).toEqual(["hook", "tool_name", "tool_response", "tool_use_id"]);
    expect(evs[0].extra.transcript_path).toBeUndefined();
    expect(evs[0].extra.cwd).toBeUndefined();
    expect(evs[0].extra.mystery).toBeUndefined();
    expect(evs[0].extra.permission_mode).toBeUndefined();
  });
});
