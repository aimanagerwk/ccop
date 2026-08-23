import { describe, expect, it } from "vitest";
import { buildSessionUrl, parseSessionUrl } from "../web/src/lib/session-url.js";

const UUID = "cee5cd27-209d-496e-9835-075e8d317b5f";
const SID = "s-127.0.0.1-8787";

describe("session-url security", () => {
  it("prototype keys in the query do not pollute the result", () => {
    const parsed = parseSessionUrl(`?__proto__=polluted&constructor=hack&s=${SID}&id=${UUID}`);
    expect(parsed).toEqual({ serverId: SID, sessionId: UUID });
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(false);
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
    expect((parsed as { token?: string }).token).toBeUndefined();
  });

  it("drops HTML / event-handler ids", () => {
    expect(parseSessionUrl(`?s=${SID}&id=${encodeURIComponent("<img onerror=alert(1)>")}`).sessionId).toBeNull();
    expect(parseSessionUrl(`?s=${SID}&id=<img onerror=alert(1)>`).sessionId).toBeNull();
  });

  it("buildSessionUrl search keys are only s and id", () => {
    const href = buildSessionUrl({
      serverId: SID,
      sessionId: UUID,
      token: "secret",
      name: "wf",
    } as { serverId: string; sessionId: string });
    const u = new URL(href, "http://local.test");
    expect([...u.searchParams.keys()].sort()).toEqual(["id", "s"]);
    expect(href).not.toContain("token");
    expect(href).not.toContain("secret");
    expect(href).not.toContain("name");
  });

  it("rejects overlong ids (UUID is 36)", () => {
    expect(parseSessionUrl(`?s=${SID}&id=${"a".repeat(80)}`).sessionId).toBeNull();
    expect(parseSessionUrl(`?s=${SID}&id=${UUID}${UUID}`).sessionId).toBeNull();
  });

  it("does not treat extra query keys as selection", () => {
    const parsed = parseSessionUrl(`?s=${SID}&id=${UUID}&cwd=/etc/passwd&host=evil&title=x`);
    expect(parsed).toEqual({ serverId: SID, sessionId: UUID });
    expect(buildSessionUrl(parsed)).toBe(`/?s=${SID}&id=${UUID}`);
  });
});
