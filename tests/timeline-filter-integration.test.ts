import { describe, expect, it } from "vitest";
import * as classify from "../src/classify.js";
import type { FoldedRow } from "../web/src/lib/fold-transcript.js";
import { foldTranscript } from "../web/src/lib/fold-transcript.js";
import { filterGroups, rowVisibleText, sanitizeQuery } from "../web/src/lib/timeline-filter.js";
import { groupTurns } from "../web/src/lib/timeline-turn.js";

describe("fold then groupTurns then filterGroups", () => {
  it("keeps matching tool inside its turn", () => {
    const s1 = classify.fromSent({ text: "first" })[0];
    const tool = classify.fromToolUse({
      name: "Bash",
      tool_use_id: "b1",
      tool_input: { command: "echo hi" },
    })[0];
    const done = classify.fromResult({ is_error: false, result: "done" });
    const s2 = classify.fromSent({ text: "second" })[0];
    const rows = foldTranscript([s1, tool, ...done, s2]);
    const groups = groupTurns(rows);
    const filtered = filterGroups(groups, { q: "Bash" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].turnId).toBe(1);
    expect(filtered[0].rows.some((r) => r.type === "tool" && r.name === "Bash")).toBe(true);
    expect(filtered[0].rows.every((r) => r.type !== "user")).toBe(true);
  });

  it("query matching only prelude system rows leaves only turn 0", () => {
    const connected = { kind: "working" as const, summary: "connected", extra: {} };
    const init = { kind: "working" as const, summary: "init", extra: {} };
    const sent = classify.fromSent({ text: "hello" })[0];
    const rows = foldTranscript([connected, init, sent]);
    const groups = groupTurns(rows);
    expect(groups.map((g) => g.turnId)).toEqual([0, 1]);
    const filtered = filterGroups(groups, { q: "已连接" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].turnId).toBe(0);
    expect(filtered[0].rows[0].type).toBe("system");
  });

  it("query matching the visible tail of a long system item keeps that prelude turn", () => {
    const tail = "SYS_TAIL_VISIBLE_TOKEN";
    const sys: FoldedRow = { type: "system", items: [`${"n".repeat(300)}${tail}`] };
    const sent = classify.fromSent({ text: "hello" })[0];
    const groups = groupTurns([sys, ...foldTranscript([sent])]);
    expect(rowVisibleText(sys).join("")).toContain(tail);
    const filtered = filterGroups(groups, { q: tail });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].turnId).toBe(0);
    expect(filtered[0].rows[0]).toBe(sys);
  });

  it("zero-width padded unique user text still selects that turn", () => {
    const s1 = classify.fromSent({ text: "alpha-turn-unique" })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: "beta-other" })[0];
    const groups = groupTurns(foldTranscript([s1, ...done1, s2]));
    const q = `${"\u200b".repeat(195)}alpha-turn-unique`;
    expect(sanitizeQuery({ q }).needle).toBe("alpha-turn-unique");
    const filtered = filterGroups(groups, { q });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes("alpha-turn-unique"))).toBe(
      true,
    );
  });

  it("type filter tool plus needle on name survives the pipeline", () => {
    const sent = classify.fromSent({ text: "please Read this" })[0];
    const tool = classify.fromToolUse({
      name: "Read",
      tool_use_id: "r1",
      tool_input: { file_path: "/a.ts" },
    })[0];
    const done = classify.fromResult({ is_error: false, result: "Read finished" });
    const rows = foldTranscript([sent, tool, ...done]);
    const groups = groupTurns(rows);
    const filtered = filterGroups(groups, { q: "Read", types: ["tool"] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].turnId).toBe(1);
    expect(filtered[0].rows).toHaveLength(1);
    expect(filtered[0].rows[0]).toMatchObject({ type: "tool", name: "Read" });
  });

  it("empty query after fold and group is identity on turn structure", () => {
    const connected = { kind: "working" as const, summary: "connected", extra: {} };
    const sent = classify.fromSent({ text: "hi" })[0];
    const tool = classify.fromToolUse({
      name: "Read",
      tool_use_id: "t1",
      tool_input: { file_path: "/x.ts" },
    })[0];
    const done = classify.fromResult({ is_error: false, result: "ok" });
    const rows = foldTranscript([connected, sent, tool, ...done]);
    const groups = groupTurns(rows);
    const filtered = filterGroups(groups);
    expect(filtered).not.toBe(groups);
    expect(filtered.map((g) => g.turnId)).toEqual(groups.map((g) => g.turnId));
    expect(filtered.map((g) => g.rows.length)).toEqual(groups.map((g) => g.rows.length));
    for (let i = 0; i < groups.length; i++) {
      expect(filtered[i]).toBe(groups[i]);
      expect(filtered[i].rows).toBe(groups[i].rows);
      for (let j = 0; j < groups[i].rows.length; j++) {
        expect(filtered[i].rows[j]).toBe(groups[i].rows[j]);
      }
    }
  });
});
