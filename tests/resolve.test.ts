import { describe, expect, it } from "vitest";
import { resolveSessionId } from "../src/store.js";

const sessions = [
  { id: "11111111-1111-1111-1111-111111111111", name: "alpha", title: "Fix login" },
  { id: "22222222-2222-2222-2222-222222222222", name: "beta", title: "Fix login" },
  { id: "33333333-3333-3333-3333-333333333333", name: "alpha", title: "Other" },
];

describe("resolveSessionId", () => {
  it("prefers exact Claude session UUID even when labels collide", () => {
    const r = resolveSessionId("11111111-1111-1111-1111-111111111111", sessions);
    expect(r).toEqual({ ok: true, id: "11111111-1111-1111-1111-111111111111" });
  });

  it("resolves a unique operator label", () => {
    const r = resolveSessionId("beta", sessions);
    expect(r).toEqual({ ok: true, id: "22222222-2222-2222-2222-222222222222" });
  });

  it("returns ambiguous name when label matches 2+", () => {
    const r = resolveSessionId("alpha", sessions);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("ambiguous name");
      expect(r.ids).toEqual([
        "11111111-1111-1111-1111-111111111111",
        "33333333-3333-3333-3333-333333333333",
      ]);
    }
  });

  it("returns ambiguous name when Claude title matches 2+", () => {
    const r = resolveSessionId("Fix login", sessions);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("ambiguous name");
      expect(r.ids).toEqual([
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ]);
    }
  });

  it("resolves a unique Claude title", () => {
    const r = resolveSessionId("Other", sessions);
    expect(r).toEqual({ ok: true, id: "33333333-3333-3333-3333-333333333333" });
  });

  it("unknown", () => {
    expect(resolveSessionId("nope", sessions)).toEqual({ ok: false, error: "unknown session nope" });
  });

  it("missing key", () => {
    expect(resolveSessionId(undefined, sessions)).toEqual({ ok: false, error: "id required" });
  });
});
