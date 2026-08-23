import { describe, expect, it } from "vitest";
import * as classify from "../src/classify.js";
import {
  foldTranscript,
  toolCardPresentation,
  type FoldedRow,
} from "../web/src/lib/fold-transcript.js";

function toolRow(rows: FoldedRow[], id?: string): Extract<FoldedRow, { type: "tool" }> {
  const row = rows.find((r): r is Extract<FoldedRow, { type: "tool" }> => {
    if (r.type !== "tool") return false;
    return id ? r.tool_use_id === id : true;
  });
  if (!row) throw new Error(`expected tool row${id ? ` ${id}` : ""}`);
  return row;
}

describe("tool-extra integration: classify → fold → ToolCard", () => {
  it("Bash tool_use then PostToolUse folds into one open card with stdout", () => {
    const use = classify.fromToolUse({
      name: "Bash",
      tool_use_id: "tu_bash",
      tool_input: { command: "echo hi" },
    });
    const post = classify.fromHook("PostToolUse", {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "tu_bash",
      tool_response: { stdout: "hi\n", stderr: "", interrupted: false },
      duration_ms: 12,
      transcript_path: "/tmp/t.jsonl",
      cwd: "/workspace/ccop",
    });

    expect(use).toHaveLength(1);
    expect(use[0]).toMatchObject({
      kind: "working",
      summary: "tool Bash",
      extra: { tool: "Bash", tool_use_id: "tu_bash", input: { command: "echo hi" } },
    });
    expect(post).toHaveLength(1);
    expect(post[0].kind).toBe("working");
    expect(post[0].summary).toBe("PostToolUse");
    expect(post[0].extra).toMatchObject({
      hook: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "tu_bash",
      tool_response: { stdout: "hi\n", stderr: "", interrupted: false },
    });

    const rows = foldTranscript([...use, ...post]);
    expect(rows).toHaveLength(1);
    const row = toolRow(rows, "tu_bash");
    expect(row).toMatchObject({
      type: "tool",
      name: "Bash",
      detail: "echo hi",
      input: { command: "echo hi" },
      tool_use_id: "tu_bash",
      output: { stdout: "hi\n", stderr: "", interrupted: false },
    });
    expect(row).not.toHaveProperty("is_error");

    const presented = toolCardPresentation(row.input, row.output);
    expect(presented.open).toBe(true);
    expect(presented.inputText).toContain("echo hi");
    expect(presented.outputText).toContain("hi\\n");
    expect(presented.outputText).toContain("stdout");
  });

  it("Read tool_use then PostToolUse folds file content for the card", () => {
    const use = classify.fromToolUse({
      name: "Read",
      tool_use_id: "tu_read",
      tool_input: { file_path: "/workspace/ccop/web/src/lib/session-dot.ts" },
    });
    const post = classify.fromHook("PostToolUse", {
      tool_name: "Read",
      tool_use_id: "tu_read",
      tool_response: {
        type: "text",
        file: { filePath: "/workspace/ccop/web/src/lib/session-dot.ts", content: "export const DOT = 1;\n" },
      },
    });

    const rows = foldTranscript([...use, ...post]);
    expect(rows).toHaveLength(1);
    const row = toolRow(rows, "tu_read");
    expect(row.name).toBe("Read");
    expect(row.detail).toBe("session-dot.ts");
    expect(row.input).toEqual({ file_path: "/workspace/ccop/web/src/lib/session-dot.ts" });
    expect(row.output).toEqual({
      type: "text",
      file: { filePath: "/workspace/ccop/web/src/lib/session-dot.ts", content: "export const DOT = 1;\n" },
    });

    const presented = toolCardPresentation(row.input, row.output);
    expect(presented.open).toBe(true);
    expect(presented.inputText).toContain("session-dot.ts");
    expect(presented.outputText).toContain("export const DOT = 1;");
  });

  it("parallel Read + Bash attach only by tool_use_id and both cards open", () => {
    const events = [
      ...classify.fromToolUse({
        name: "Read",
        tool_use_id: "a",
        tool_input: { file_path: "/a.ts" },
      }),
      ...classify.fromToolUse({
        name: "Bash",
        tool_use_id: "b",
        tool_input: { command: "ls -la /tmp\necho more" },
      }),
      ...classify.fromHook("PostToolUse", {
        tool_name: "Bash",
        tool_use_id: "b",
        tool_response: { stdout: "ok\n", stderr: "", interrupted: false },
      }),
      ...classify.fromHook("PostToolUse", {
        tool_name: "Read",
        tool_use_id: "a",
        tool_response: { type: "text", file: { content: "A" } },
      }),
    ];

    const rows = foldTranscript(events);
    expect(rows).toHaveLength(2);
    const read = toolRow(rows, "a");
    const bash = toolRow(rows, "b");
    expect(read).toMatchObject({
      type: "tool",
      name: "Read",
      detail: "a.ts",
      input: { file_path: "/a.ts" },
      output: { type: "text", file: { content: "A" } },
    });
    expect(bash).toMatchObject({
      type: "tool",
      name: "Bash",
      detail: "ls -la /tmp",
      input: { command: "ls -la /tmp\necho more" },
      output: { stdout: "ok\n", stderr: "", interrupted: false },
    });

    const readCard = toolCardPresentation(read.input, read.output);
    const bashCard = toolCardPresentation(bash.input, bash.output);
    expect(readCard.open).toBe(true);
    expect(bashCard.open).toBe(true);
    expect(readCard.outputText).toContain("A");
    expect(bashCard.outputText).toContain("ok\\n");
  });

  it("PostToolUseFailure attaches error so the card opens as is_error", () => {
    const events = [
      ...classify.fromToolUse({
        name: "Write",
        tool_use_id: "w1",
        tool_input: { file_path: "/workspace/ccop/web/src/foo.ts", content: "x" },
      }),
      ...classify.fromHook("PostToolUseFailure", {
        hook_event_name: "PostToolUseFailure",
        tool_name: "Write",
        tool_use_id: "w1",
        error: "EACCES",
        is_interrupt: false,
      }),
    ];
    const rows = foldTranscript(events);
    expect(rows).toHaveLength(1);
    const row = toolRow(rows, "w1");
    expect(row).toMatchObject({
      type: "tool",
      name: "Write",
      input: { file_path: "/workspace/ccop/web/src/foo.ts", content: "x" },
      output: "EACCES",
      is_error: true,
    });
    const presented = toolCardPresentation(row.input, row.output);
    expect(presented.open).toBe(true);
    expect(presented.outputText).toBe("EACCES");
  });

  it("user tool_result content attaches when PostToolUse is absent", () => {
    const use = classify.fromToolUse({
      name: "Bash",
      tool_use_id: "u1",
      tool_input: { command: "pwd" },
    });
    const result = {
      kind: "working" as const,
      summary: "tool_result",
      extra: { tool_use_id: "u1", content: "denied", is_error: true },
    };
    const rows = foldTranscript([...use, result]);
    const row = toolRow(rows, "u1");
    expect(row).toMatchObject({
      type: "tool",
      name: "Bash",
      input: { command: "pwd" },
      output: "denied",
      is_error: true,
    });
    const presented = toolCardPresentation(row.input, row.output);
    expect(presented.open).toBe(true);
    expect(presented.outputText).toBe("denied");
  });

  it("hides Pre/Post hooks without attachable output and still opens input-only cards", () => {
    const events = [
      ...classify.fromHook("PreToolUse", { tool_name: "Read", tool_use_id: "r1" }),
      ...classify.fromToolUse({
        name: "Read",
        tool_use_id: "r1",
        tool_input: { file_path: "/workspace/ccop/web/src/lib/session-dot.ts" },
      }),
      ...classify.fromHook("PostToolUse", { tool_name: "Read", tool_use_id: "r1" }),
    ];
    const rows = foldTranscript(events);
    expect(rows).toHaveLength(1);
    const row = toolRow(rows, "r1");
    expect(row).not.toHaveProperty("output");
    const presented = toolCardPresentation(row.input, row.output);
    expect(presented.open).toBe(true);
    expect(presented.inputText).toContain("file_path");
    expect(presented.outputText).toBe("");
  });
});
