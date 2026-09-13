import { describe, expect, it } from "vitest";
import { formatActiveAgo, isSessionHot, sessionActiveTs } from "../web/src/lib/session-active.js";

describe("session-active security", () => {
  it("does not feed untrusted strings to Date", () => {
    expect(sessionActiveTs({ updated_ts: "2026-08-23T00:00:00Z" })).toBeNull();
    expect(sessionActiveTs({ updated_ts: "<script>alert(1)</script>" })).toBeNull();
    expect(isSessionHot({ alive: true, pending: [], last_kind: "idle", updated_ts: "now" }, 100)).toBe(false);
  });

  it("formatters emit plain text only", () => {
    const ago = formatActiveAgo(1_787_403_740, 1_787_403_800_000);
    expect(ago.text.includes("<")).toBe(false);
    expect(ago.title.includes("<")).toBe(false);
    expect(ago.title).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("does not read usage.updated_ts even if present on the object", () => {
    const s = {
      updated_ts: undefined,
      usage: { updated_ts: 9_999_999_999 },
      last_turn: { ts: 9_999_999_999 },
    };
    expect(sessionActiveTs(s)).toBeNull();
  });
});
