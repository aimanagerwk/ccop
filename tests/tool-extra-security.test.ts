import { readFileSync } from "node:fs";
import { describe, expect, it, afterEach } from "vitest";
import * as classify from "../src/classify.js";
import { foldTranscript, toolCardPresentation, type FoldEvent } from "../web/src/lib/fold-transcript.js";

function ev(partial: Partial<FoldEvent> & { kind: string; summary: string }): FoldEvent {
  return { extra: {}, ...partial };
}

afterEach(() => {
  delete (Object.prototype as { hacked?: unknown }).hacked;
  delete (Object.prototype as { polluted?: unknown }).polluted;
});

describe("tool extra / hook payload prototype pollution", () => {
  it("fromHook does not copy JSON __proto__ or constructor onto extra", () => {
    const payload = JSON.parse(
      '{"tool_name":"Read","tool_use_id":"p1","tool_response":{"ok":true},"__proto__":{"hacked":true},"constructor":{"name":"hack"}}',
    );
    const extra = classify.fromHook("PostToolUse", payload)[0].extra;
    expect(Object.keys(extra).sort()).toEqual(["hook", "tool_name", "tool_response", "tool_use_id"]);
    expect(Object.prototype.hasOwnProperty.call(extra, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(extra, "constructor")).toBe(false);
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it("fromHook ignores inherited proto keys and does not pollute Object.prototype", () => {
    const proto = {
      tool_name: "Injected",
      tool_use_id: "victim",
      tool_response: "stolen",
      error: "nope",
      is_interrupt: true,
      duration_ms: 99,
      agent_id: "evil",
      mystery: "drop",
    };
    const payload = Object.create(proto) as Record<string, unknown>;
    payload.tool_name = "Bash";
    payload.tool_use_id = "own";
    const extra = classify.fromHook("PostToolUse", payload)[0].extra;
    expect(extra.tool_name).toBe("Bash");
    expect(extra.tool_use_id).toBe("own");
    expect(extra.tool_response).toBeUndefined();
    expect(extra.error).toBeUndefined();
    expect(extra.is_interrupt).toBeUndefined();
    expect(extra.duration_ms).toBeUndefined();
    expect(extra.agent_id).toBeUndefined();
    expect((extra as { mystery?: string }).mystery).toBeUndefined();
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it("PermissionRequest / PostToolUseFailure ignore inherited tool_name", () => {
    const proto = { tool_name: "Write", tool_use_id: "inj", error: "boom" };
    const empty = Object.create(proto) as Record<string, unknown>;
    const perm = classify.fromHook("PermissionRequest", empty)[0];
    expect(perm.kind).toBe("needs_decision");
    expect(perm.extra.tool).toBe("");
    expect(perm.extra.tool_use_id).toBe("");
    const fail = classify.fromHook("PostToolUseFailure", empty)[0];
    expect(fail.summary).toBe("PostToolUseFailure ");
    expect(fail.extra.error).toBeUndefined();
    expect(fail.extra.tool_name).toBeUndefined();
  });

  it("sanitize / presentation does not assign __proto__ or constructor onto Object.prototype", () => {
    const polluted = JSON.parse('{"__proto__":{"hacked":true},"constructor":{"prototype":{"polluted":true}},"ok":1}');
    const presented = toolCardPresentation({}, polluted);
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(presented.outputText).toContain('"ok": 1');
    expect(presented.outputText).not.toContain("hacked");
    expect(presented.outputText).not.toMatch(/"constructor"\s*:/);
  });
});

describe("unknown hook keys are not copied blindly", () => {
  it("drops transcript_path, cwd, session_id, and unknown keys", () => {
    const extra = classify.fromHook("PostToolUse", {
      tool_name: "Read",
      tool_use_id: "r1",
      tool_response: { type: "text" },
      transcript_path: "/secret.jsonl",
      cwd: "/leak",
      permission_mode: "bypassPermissions",
      session_id: "sess",
      prompt_id: "p1",
      eval: "no",
      mystery: "drop-me",
    })[0].extra;
    expect(Object.keys(extra).sort()).toEqual(["hook", "tool_name", "tool_response", "tool_use_id"]);
    expect(extra.transcript_path).toBeUndefined();
    expect(extra.cwd).toBeUndefined();
    expect((extra as { eval?: string }).eval).toBeUndefined();
    expect((extra as { mystery?: string }).mystery).toBeUndefined();
    expect(extra.permission_mode).toBeUndefined();
    expect(extra.session_id).toBeUndefined();
  });

  it("PostToolUseFailure allowlist is still closed", () => {
    const extra = classify.fromHook("PostToolUseFailure", {
      tool_name: "Write",
      tool_use_id: "w1",
      error: "EACCES",
      is_interrupt: false,
      duration_ms: 3,
      stack: "secret",
      cwd: "/tmp",
    })[0].extra;
    expect(Object.keys(extra).sort()).toEqual([
      "duration_ms",
      "error",
      "hook",
      "is_interrupt",
      "tool_name",
      "tool_use_id",
    ]);
    expect((extra as { stack?: string }).stack).toBeUndefined();
  });
});

describe("HTML / script in tool output is not markup", () => {
  it("keeps tags as literal text in presentation", () => {
    const payload = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    const presented = toolCardPresentation({}, payload);
    expect(presented.outputText).toBe(payload);
    expect(presented.outputText).toContain("<script>");
    expect(presented.outputText).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it("ToolCard interpolates output as a React text child of <pre>", () => {
    const src = readFileSync(new URL("../web/src/components/Transcript.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    expect(src).toMatch(/<pre className="think-body">\{presented\.outputText\}<\/pre>/);
    expect(src).toMatch(/<pre className="think-body">\{presented\.inputText\}<\/pre>/);
  });

  it("fold attach does not turn HTML into a second interpreted row", () => {
    const payload = "<b>not-bold</b>";
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
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "tool", output: payload });
  });
});

describe("output size clip", () => {
  it("clips multi-MB file.content and stdout in the tool card", () => {
    const huge = "A".repeat(3 * 1024 * 1024);
    const presented = toolCardPresentation({}, { type: "text", file: { content: huge } });
    expect(presented.outputText.length).toBeLessThan(200_000);
    expect(presented.outputText.length).toBeLessThan(huge.length);
    const stdout = toolCardPresentation({}, { stdout: huge, stderr: "" });
    expect(stdout.outputText.length).toBeLessThan(200_000);
  });

  it("omits image / non-text content arrays instead of dumping them", () => {
    const blob = "B".repeat(2 * 1024 * 1024);
    const presented = toolCardPresentation({}, [
      { type: "image", source: { type: "base64", media_type: "image/png", data: blob } },
      { type: "text", text: "ok" },
    ]);
    expect(presented.outputText.length).toBeLessThan(200_000);
    expect(presented.outputText.includes(blob)).toBe(false);
    expect(presented.outputText).toContain("ok");
  });
});

describe("tool_use_id attach does not cross ids", () => {
  it("does not attach a result for B onto tool A", () => {
    const rows = foldTranscript([
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
        extra: { tool_use_id: "b", tool_response: "ONLY-B" },
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ type: "tool", tool_use_id: "a" });
    expect(rows[0]).not.toHaveProperty("output");
    expect(rows[1]).toMatchObject({ type: "tool", tool_use_id: "b", output: "ONLY-B" });
  });

  it("does not attach on mismatched, empty, inherited, or non-string ids", () => {
    const inherited = Object.create({ tool_use_id: "keep", tool_response: "from-proto" }) as Record<string, unknown>;
    const rows = foldTranscript([
      ev({
        kind: "working",
        summary: "tool Bash",
        extra: { tool: "Bash", tool_use_id: "keep", input: { command: "ls" } },
      }),
      ev({
        kind: "working",
        summary: "PostToolUse",
        extra: { tool_use_id: "other", tool_response: "nope" },
      }),
      ev({
        kind: "working",
        summary: "PostToolUse",
        extra: { tool_response: "no-id" },
      }),
      ev({
        kind: "working",
        summary: "PostToolUse",
        extra: { tool_use_id: "", tool_response: "empty" },
      }),
      ev({
        kind: "working",
        summary: "PostToolUse",
        extra: { tool_use_id: 1 as unknown as string, tool_response: "numeric" },
      }),
      ev({
        kind: "working",
        summary: "PostToolUse",
        extra: inherited,
      }),
    ]);
    expect(rows).toEqual([
      { type: "tool", name: "Bash", detail: "ls", input: { command: "ls" }, tool_use_id: "keep" },
    ]);
  });
});
