import { describe, expect, it } from "vitest";
import {
  buildSessionUrl,
  isClaudeSessionId,
  isDepotServerId,
  parseSessionUrl,
} from "../web/src/lib/session-url.js";

const UUID = "cee5cd27-209d-496e-9835-075e8d317b5f";
const SID = "s-127.0.0.1-8787";

describe("isClaudeSessionId", () => {
  it("accepts RFC 4122-shaped UUIDs", () => {
    expect(isClaudeSessionId(UUID)).toBe(true);
    expect(isClaudeSessionId("8d73892c-6b6f-46a5-bfdc-50f1af87496a")).toBe(true);
  });

  it("rejects names, titles, paths, and junk", () => {
    expect(isClaudeSessionId("alpha")).toBe(false);
    expect(isClaudeSessionId("wf")).toBe(false);
    expect(isClaudeSessionId("../x")).toBe(false);
    expect(isClaudeSessionId("javascript:alert(1)")).toBe(false);
    expect(isClaudeSessionId("")).toBe(false);
    expect(isClaudeSessionId(null)).toBe(false);
    expect(isClaudeSessionId(12)).toBe(false);
    expect(isClaudeSessionId("not-a-uuid-at-all-xxxxxxxxxxxxxxxx")).toBe(false);
  });
});

describe("isDepotServerId", () => {
  it("accepts serverKey shape", () => {
    expect(isDepotServerId(SID)).toBe(true);
    expect(isDepotServerId("s-host.example-443")).toBe(true);
  });

  it("rejects empty, token-like, and overlong values", () => {
    expect(isDepotServerId("")).toBe(false);
    expect(isDepotServerId("default")).toBe(false);
    expect(isDepotServerId("s-x-999999")).toBe(false);
    expect(isDepotServerId(`s-${"a".repeat(90)}-1`)).toBe(false);
  });
});

describe("parseSessionUrl / buildSessionUrl", () => {
  it("round-trips a real depot id + UUID", () => {
    const href = buildSessionUrl({ serverId: SID, sessionId: UUID });
    expect(href).toBe(`/?s=${SID}&id=${UUID}`);
    expect(parseSessionUrl(href)).toEqual({ serverId: SID, sessionId: UUID });
    expect(parseSessionUrl(href.replace(/^\//, ""))).toEqual({ serverId: SID, sessionId: UUID });
    expect(parseSessionUrl(`?s=${SID}&id=${UUID}`)).toEqual({ serverId: SID, sessionId: UUID });
  });

  it("drops illegal UUID / name / path / javascript", () => {
    expect(parseSessionUrl(`?s=${SID}&id=alpha`).sessionId).toBeNull();
    expect(parseSessionUrl(`?s=${SID}&id=../x`).sessionId).toBeNull();
    expect(parseSessionUrl(`?s=${SID}&id=javascript:alert(1)`).sessionId).toBeNull();
    expect(parseSessionUrl(`?s=not-a-server&id=${UUID}`).serverId).toBeNull();
  });

  it("strips token and never writes it back", () => {
    const parsed = parseSessionUrl(`?s=${SID}&id=${UUID}&token=secret`);
    expect(parsed).toEqual({ serverId: SID, sessionId: UUID });
    expect(buildSessionUrl(parsed)).not.toContain("token");
    expect(buildSessionUrl(parsed)).not.toContain("secret");
  });

  it("empty / no query is both-null and builds /", () => {
    expect(parseSessionUrl("")).toEqual({ serverId: null, sessionId: null });
    expect(parseSessionUrl("?")).toEqual({ serverId: null, sessionId: null });
    expect(buildSessionUrl({ serverId: null, sessionId: null })).toBe("/");
  });

  it("keeps a lone valid server id", () => {
    expect(parseSessionUrl(`?s=${SID}`)).toEqual({ serverId: SID, sessionId: null });
    expect(buildSessionUrl({ serverId: SID, sessionId: null })).toBe(`/?s=${SID}`);
  });

  it("treats a name in the query as not a session id", () => {
    const parsed = parseSessionUrl(`?s=${SID}&id=wf&name=wf`);
    expect(parsed.sessionId).toBeNull();
    expect(buildSessionUrl(parsed)).toBe(`/?s=${SID}`);
  });
});
