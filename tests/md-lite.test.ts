import { describe, expect, it } from "vitest";
import { parseMdLite } from "../web/src/lib/md-lite.js";

describe("parseMdLite", () => {
  it("splits bold, code, and newlines", () => {
    expect(parseMdLite("**WS.** `src/ws.ts`\n**Tests.**")).toEqual([
      { t: "bold", v: "WS." },
      { t: "text", v: " " },
      { t: "code", v: "src/ws.ts" },
      { t: "br" },
      { t: "bold", v: "Tests." },
    ]);
  });

  it("leaves plain text alone", () => {
    expect(parseMdLite("hello")).toEqual([{ t: "text", v: "hello" }]);
  });
});
