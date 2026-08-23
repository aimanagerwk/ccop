import { describe, expect, it } from "vitest";
import { sessionDotClass } from "../web/src/lib/session-dot.js";

describe("sessionDotClass", () => {
  it("pending is warn even when alive", () => {
    expect(sessionDotClass({ alive: true, pending: [{}], last_kind: "idle" })).toBe("warn");
  });

  it("dead is ended, not idle", () => {
    expect(sessionDotClass({ alive: false, last_kind: "dead" })).toBe("ended");
    expect(sessionDotClass({ alive: false, last_kind: "idle" })).toBe("ended");
  });

  it("alive idle / turn_done is hollow idle, not halt", () => {
    expect(sessionDotClass({ alive: true, last_kind: "idle" })).toBe("idle");
    expect(sessionDotClass({ alive: true, last_kind: "turn_done" })).toBe("idle");
    expect(sessionDotClass({ alive: true, state: "idle" })).toBe("idle");
  });

  it("alive working is live", () => {
    expect(sessionDotClass({ alive: true, last_kind: "working" })).toBe("live");
  });

  it("alive failed is halt", () => {
    expect(sessionDotClass({ alive: true, last_kind: "failed" })).toBe("halt");
  });
});
