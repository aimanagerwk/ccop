import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/parse.js";

describe("parseArgs host-gap flags", () => {
  it("mcp ID", () => {
    expect(parseArgs(["mcp", "sess-1"])).toEqual({ cmd: "mcp", args: { id: "sess-1" } });
  });

  it("mcp-set ID --json object", () => {
    expect(parseArgs(["mcp-set", "sess-1", "--json", '{"stdio":{"type":"stdio","command":"echo"}}'])).toEqual({
      cmd: "mcp-set",
      args: { id: "sess-1", json: '{"stdio":{"type":"stdio","command":"echo"}}' },
    });
  });

  it("mcp-set ID --json empty object", () => {
    expect(parseArgs(["mcp-set", "sess-1", "--json", "{}"])).toEqual({
      cmd: "mcp-set",
      args: { id: "sess-1", json: "{}" },
    });
  });

  it("mcp-set ID without --json leaves json unset (stdin)", () => {
    expect(parseArgs(["mcp-set", "sess-1"])).toEqual({ cmd: "mcp-set", args: { id: "sess-1" } });
  });

  it("mcp-reconnect ID SERVER", () => {
    expect(parseArgs(["mcp-reconnect", "sess-1", "github"])).toEqual({
      cmd: "mcp-reconnect",
      args: { id: "sess-1", server: "github" },
    });
  });

  it("mcp-toggle --on", () => {
    expect(parseArgs(["mcp-toggle", "sess-1", "github", "--on"])).toEqual({
      cmd: "mcp-toggle",
      args: { id: "sess-1", server: "github", enabled: true },
    });
  });

  it("mcp-toggle --off", () => {
    expect(parseArgs(["mcp-toggle", "sess-1", "github", "--off"])).toEqual({
      cmd: "mcp-toggle",
      args: { id: "sess-1", server: "github", enabled: false },
    });
  });

  it("mcp-toggle without on/off leaves enabled unset", () => {
    expect(parseArgs(["mcp-toggle", "sess-1", "github"])).toEqual({
      cmd: "mcp-toggle",
      args: { id: "sess-1", server: "github" },
    });
  });

  it("plugins-reload ID", () => {
    expect(parseArgs(["plugins-reload", "sess-1"])).toEqual({
      cmd: "plugins-reload",
      args: { id: "sess-1" },
    });
  });

  it("skills-reload ID", () => {
    expect(parseArgs(["skills-reload", "sess-1"])).toEqual({
      cmd: "skills-reload",
      args: { id: "sess-1" },
    });
  });
});

describe("parseArgs wait", () => {
  it("wait ID", () => {
    expect(parseArgs(["wait", "sess-1"])).toEqual({ cmd: "wait", args: { id: "sess-1" } });
  });

  it("wait ID --kind a,b --timeout SEC", () => {
    expect(parseArgs(["wait", "sess-1", "--kind", "turn_done,failed", "--timeout", "12"])).toEqual({
      cmd: "wait",
      args: { id: "sess-1", kind: "turn_done,failed", timeout: 12 },
    });
  });
});

