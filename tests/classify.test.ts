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
});
