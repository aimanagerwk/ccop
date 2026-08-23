import { describe, expect, it } from "vitest";
import * as classify from "../src/classify.js";
import type { FoldedRow } from "../web/src/lib/fold-transcript.js";
import { foldTranscript } from "../web/src/lib/fold-transcript.js";
import { filterGroups, filterRows, rowVisibleText, sanitizeQuery } from "../web/src/lib/timeline-filter.js";
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

  it("soft-hyphen padded unique user text still selects that turn", () => {
    const s1 = classify.fromSent({ text: "alpha-turn-unique" })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: "beta-other" })[0];
    const groups = groupTurns(foldTranscript([s1, ...done1, s2]));
    const q = `${"­".repeat(195)}alpha-turn-unique`;
    expect(sanitizeQuery({ q }).needle).toBe("alpha-turn-unique");
    const filtered = filterGroups(groups, { q });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes("alpha-turn-unique"))).toBe(
      true,
    );
  });

  it("padded ZWJ family still selects that turn", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const s1 = classify.fromSent({ text: `see ${family}` })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: "beta-other" })[0];
    const groups = groupTurns(foldTranscript([s1, ...done1, s2]));
    const q = `${"x".repeat(190)}${family}`;
    expect(sanitizeQuery({ q }).needle).toContain(family);
    const filtered = filterGroups(groups, { q: family });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(family))).toBe(true);
  });

  it("padded China flag does not select a Canada-flag turn", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const s1 = classify.fromSent({ text: `visit ${canada}` })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: `visit ${china}` })[0];
    const groups = groupTurns(foldTranscript([s1, ...done1, s2]));
    const padded = `${"x".repeat(198)}${china}`;
    expect(sanitizeQuery({ q: padded }).needle.includes(china)).toBe(true);
    expect(filterGroups(groups, { q: padded }).some((g) => g.rows.some((r) => r.type === "user" && r.text.includes(canada)))).toBe(false);
    const filtered = filterGroups(groups, { q: china });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(china))).toBe(true);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(canada))).toBe(false);
  });

  it("198x+🇨🇳 (q.length=202) must not leave a 🇨🇦 turn", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const s1 = classify.fromSent({ text: `visit ${canada}` })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: `visit ${china}` })[0];
    const groups = groupTurns(foldTranscript([s1, ...done1, s2]));
    const padded = `${"x".repeat(198)}${china}`;
    expect(padded.length).toBe(202);
    expect(sanitizeQuery({ q: padded }).needle.includes(china)).toBe(true);
    const paddedCanada = `${"x".repeat(198)}${canada}`;
    expect(
      filterGroups(groups, { q: padded }).some((g) =>
        g.rows.some((r) => r.type === "user" && r.text.includes(canada)),
      ),
    ).toBe(false);
    const paddedCanadaTurn = classify.fromSent({ text: paddedCanada })[0];
    const paddedChinaTurn = classify.fromSent({ text: padded })[0];
    const paddedGroups = groupTurns(foldTranscript([paddedCanadaTurn, paddedChinaTurn]));
    expect(
      filterGroups(paddedGroups, { q: padded }).some((g) =>
        g.rows.some((r) => r.type === "user" && r.text.includes(canada)),
      ),
    ).toBe(false);
    const filtered = filterGroups(groups, { q: china });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(china))).toBe(true);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(canada))).toBe(false);
  });

  it("a lone regional indicator after a full budget does not select every flag turn", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const letter = "\u{1F1E8}";
    const s1 = classify.fromSent({ text: `visit ${canada}` })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: `visit ${china}` })[0];
    const groups = groupTurns(foldTranscript([s1, ...done1, s2]));
    const q = `${"x".repeat(199)}${letter}`;
    expect(sanitizeQuery({ q }).needle.endsWith(letter)).toBe(false);
    expect(filterGroups(groups, { q })).toEqual([]);
    expect(filterGroups(groups, { q: letter })).toEqual([]);
  });

  it("a lone regional letter does not select 🇨🇦 🇨🇳 or 🇺🇸 turns", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const letterC = "\u{1F1E8}";
    const letterN = "\u{1F1F3}";
    const s1 = classify.fromSent({ text: `visit ${canada}` })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: `visit ${china}` })[0];
    const done2 = classify.fromResult({ is_error: false, result: "reply-two" });
    const s3 = classify.fromSent({ text: `visit ${us}` })[0];
    const groups = groupTurns(foldTranscript([s1, ...done1, s2, ...done2, s3]));
    expect(filterGroups(groups, { q: letterC })).toEqual([]);
    expect(filterGroups(groups, { q: letterN })).toEqual([]);
    const filtered = filterGroups(groups, { q: china });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(china))).toBe(true);
  });

  it("the first UTF-16 half of a flag does not select 🇨🇦 🇨🇳 or 🇺🇸 turns", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const half = china.slice(0, 1);
    const s1 = classify.fromSent({ text: `visit ${canada}` })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: `visit ${china}` })[0];
    const done2 = classify.fromResult({ is_error: false, result: "reply-two" });
    const s3 = classify.fromSent({ text: `visit ${us}` })[0];
    const groups = groupTurns(foldTranscript([s1, ...done1, s2, ...done2, s3]));
    expect(filterGroups(groups, { q: half })).toEqual([]);
    const filtered = filterGroups(groups, { q: china });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(china))).toBe(true);
  });

  it("clipped leftover prefix or first-half flag does not select another padded flag turn", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const half = "\uD83C";
    const groups = groupTurns([
      { type: "user", text: `${"x".repeat(199)}${canada}` },
      { type: "user", text: `${"x".repeat(200)}${us}` },
      { type: "user", text: `${"x".repeat(200)}${china}` },
    ]);
    expect(filterGroups(groups, { q: `${"x".repeat(199)}${half}` })).toEqual([]);
    expect(filterGroups(groups, { q: `${"x".repeat(200)}${half}` })).toEqual([]);
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("200x then a half or full flag does not select another padded flag turn", () => {
    const china = "\u{1F1E8}\u{1F1F3}";
    const canada = "\u{1F1E8}\u{1F1E6}";
    const us = "\u{1F1FA}\u{1F1F8}";
    const letter = "\u{1F1E8}";
    const prefix = "x".repeat(200);
    const s1 = classify.fromSent({ text: `${prefix}${canada}` })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: `${prefix}${us}` })[0];
    const done2 = classify.fromResult({ is_error: false, result: "reply-two" });
    const s3 = classify.fromSent({ text: `${prefix}${china}` })[0];
    const groups = groupTurns(foldTranscript([s1, ...done1, s2, ...done2, s3]));
    expect(filterGroups(groups, { q: `${prefix}${letter}` })).toEqual([]);
    expect(
      filterGroups(groups, { q: `${prefix}${china}` }).some((g) =>
        g.rows.some((r) => r.type === "user" && (r.text.includes(canada) || r.text.includes(us))),
      ),
    ).toBe(false);
    // fromSent clips summaries at 200 units, so the folded rows no longer
    // contain the flag. Complete 🇨🇳 must still match a row that kept it.
    expect(filterRows([{ type: "user", text: china }], { q: china }).length).toBe(1);
  });

  it("195x U+00AD + alpha-turn-unique keeps only that turn and not a truncated word", () => {
    const s1 = classify.fromSent({ text: "alpha-turn-unique" })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: "beta-other" })[0];
    const groups = groupTurns(foldTranscript([s1, ...done1, s2]));
    const q = `${"­".repeat(195)}alpha-turn-unique`;
    expect(sanitizeQuery({ q }).needle).toBe("alpha-turn-unique");
    expect(sanitizeQuery({ q }).needle).not.toBe("alpha-turn-uniqu");
    const filtered = filterGroups(groups, { q });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes("alpha-turn-unique"))).toBe(
      true,
    );
  });

  it("ZWJ family 👨‍👩‍👧 keeps the family turn and drops a lone-👨 turn", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const s1 = classify.fromSent({ text: `see ${family}` })[0];
    const done1 = classify.fromResult({ is_error: false, result: "reply-one" });
    const s2 = classify.fromSent({ text: `adult \u{1F468}` })[0];
    const groups = groupTurns(foldTranscript([s1, ...done1, s2]));
    const q = `${"x".repeat(190)}${family}`;
    expect(sanitizeQuery({ q }).needle).toContain("‍");
    expect(sanitizeQuery({ q }).needle).toContain(family);
    const filtered = filterGroups(groups, { q: family });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes(family))).toBe(true);
    expect(filtered[0].rows.some((r) => r.type === "user" && r.text.includes("adult"))).toBe(false);
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
