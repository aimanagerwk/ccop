import { describe, expect, it } from "vitest";
import { resolveUnderCwd, safeBasename, uniqueDest } from "../web/src/lib/safe-path.js";

describe("safe-path", () => {
  it("rejects traversal and relative cwd", () => {
    expect(resolveUnderCwd("/workspace/app", "../etc/passwd")).toBe("/workspace/app/passwd");
    expect(resolveUnderCwd("/workspace/app", "/etc/passwd")).toBe("/workspace/app/passwd");
    expect(resolveUnderCwd("/workspace/app", "..")).toBeNull();
    expect(resolveUnderCwd("/workspace/app", ".")).toBeNull();
    expect(resolveUnderCwd("workspace/app", "a.txt")).toBeNull();
    expect(safeBasename("")).toBeNull();
    expect(safeBasename("ok.bin")).toBe("ok.bin");
  });

  it("uniqueDest increments", () => {
    const have = new Set(["/cwd/a.txt", "/cwd/a-2.txt"]);
    expect(uniqueDest("/cwd/a.txt", (p) => have.has(p))).toBe("/cwd/a-3.txt");
    expect(uniqueDest("/cwd/b.txt", () => false)).toBe("/cwd/b.txt");
  });
});
