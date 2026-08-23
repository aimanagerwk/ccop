import { describe, expect, it } from "vitest";
import * as classify from "../src/classify.js";
import { foldTranscript, toolCardPresentation, type FoldEvent } from "../web/src/lib/fold-transcript.js";

function ev(partial: Partial<FoldEvent> & { kind: string; summary: string }): FoldEvent {
  return { extra: {}, ...partial };
}

describe("tool result security", () => {
  it("treats tool_response and content as text, not markup", () => {
    const payload = "<script>alert(1)</script>";
    const classified = classify.fromHook("PostToolUse", {
      tool_name: "Bash",
      tool_use_id: "xss",
      tool_response: payload,
    });
    expect(classified[0].extra.tool_response).toBe(payload);

    const rows = foldTranscript([
      ev({
        kind: "working",
        summary: "tool Bash",
        extra: { tool: "Bash", tool_use_id: "xss", input: { command: "echo" } },
      }),
      ev({
        kind: "working",
        summary: "PostToolUse",
        extra: { tool_use_id: "xss", tool_response: payload },
      }),
    ]);
    expect(rows[0]).toMatchObject({ type: "tool", output: payload });
    const presented = toolCardPresentation({}, payload);
    expect(presented.outputText).toBe(payload);
    expect(presented.outputText).toContain("<script>");
    expect(presented.outputText).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it("fromHook allowlist drops __proto__, constructor, and extra hook keys", () => {
    const polluted = JSON.parse(
      '{"tool_name":"Read","tool_use_id":"p1","tool_response":{"ok":true},"__proto__":{"hacked":true},"constructor":{"name":"hack"},"transcript_path":"/secret","cwd":"/tmp","eval":"no"}',
    );
    const evs = classify.fromHook("PostToolUse", polluted);
    const extra = evs[0].extra;
    expect(Object.keys(extra).sort()).toEqual(["hook", "tool_name", "tool_response", "tool_use_id"]);
    expect((extra as { eval?: string }).eval).toBeUndefined();
    expect((extra as { transcript_path?: string }).transcript_path).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(extra, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(extra, "constructor")).toBe(false);
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it("clips multi-MB file.content / stdout in the tool card", () => {
    const huge = "A".repeat(3 * 1024 * 1024);
    const presented = toolCardPresentation({}, { type: "text", file: { content: huge } });
    expect(presented.outputText.length).toBeLessThan(200_000);
    expect(presented.outputText.endsWith("…") || presented.outputText.length < huge.length).toBe(true);
    const stdout = toolCardPresentation({}, { stdout: huge, stderr: "" });
    expect(stdout.outputText.length).toBeLessThan(200_000);
  });

  it("does not dump image / non-text content arrays unbounded", () => {
    const blob = "B".repeat(2 * 1024 * 1024);
    const content = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: blob } },
      { type: "text", text: "ok" },
    ];
    const presented = toolCardPresentation({}, content);
    expect(presented.outputText.length).toBeLessThan(200_000);
    expect(presented.outputText.includes(blob)).toBe(false);
  });
});
