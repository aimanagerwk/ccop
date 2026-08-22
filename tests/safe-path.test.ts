import { describe, expect, it } from "vitest";
import {
  UPLOAD_TMP_ROOT,
  resolveTempUpload,
  resolveUnderCwd,
  safeBasename,
  uniqueDest,
} from "../web/src/lib/safe-path.js";
import { composeAttachMessage, uploadTempNote } from "../web/src/lib/upload-message.js";

describe("safe-path", () => {
  it("rejects traversal and relative cwd", () => {
    expect(resolveUnderCwd("/workspace/app", "../etc/passwd")).toBe("/workspace/app/passwd");
    expect(resolveUnderCwd("/workspace/app", "/etc/passwd")).toBe("/workspace/app/passwd");
    expect(resolveUnderCwd("/workspace/app", "..")).toBeNull();
    expect(resolveUnderCwd("/workspace/app", ".")).toBeNull();
    expect(resolveUnderCwd("workspace/app", "a.txt")).toBeNull();
    expect(safeBasename("")).toBeNull();
    expect(safeBasename("..")).toBeNull();
    expect(safeBasename("ok.bin")).toBe("ok.bin");
  });

  it("uniqueDest increments", () => {
    const have = new Set(["/cwd/a.txt", "/cwd/a-2.txt"]);
    expect(uniqueDest("/cwd/a.txt", (p) => have.has(p))).toBe("/cwd/a-3.txt");
    expect(uniqueDest("/cwd/b.txt", () => false)).toBe("/cwd/b.txt");
  });

  it("resolveTempUpload writes under /tmp/ccop-uploads/<sessionId>/ not cwd", () => {
    const id = "8d73892c-6b6f-46a5-bfdc-50f1af87496a";
    const cwd = "/workspace/app";
    expect(resolveTempUpload(id, "notes.pdf")).toBe(`${UPLOAD_TMP_ROOT}/${id}/notes.pdf`);
    expect(resolveTempUpload(id, "../etc/passwd")).toBe(`${UPLOAD_TMP_ROOT}/${id}/passwd`);
    expect(resolveTempUpload(id, "/etc/passwd")).toBe(`${UPLOAD_TMP_ROOT}/${id}/passwd`);
    expect(resolveTempUpload(id, "..")).toBeNull();
    expect(resolveTempUpload("..", "a.txt")).toBeNull();
    expect(resolveTempUpload("../x", "a.txt")).toBeNull();
    expect(resolveTempUpload("a/b", "a.txt")).toBeNull();
    const dest = resolveTempUpload(id, "x.bin");
    expect(dest?.startsWith(`${UPLOAD_TMP_ROOT}/${id}/`)).toBe(true);
    expect(dest?.startsWith(cwd)).toBe(false);
    expect(dest).not.toContain(cwd);
  });
});

describe("upload-message", () => {
  it("sends @path, or text then @path", () => {
    const p = "/tmp/ccop-uploads/sid/a.txt";
    expect(composeAttachMessage("", p)).toBe(`@${p}`);
    expect(composeAttachMessage("看看这个", p)).toBe(`看看这个\n@${p}`);
    expect(uploadTempNote(p)).toBe(`临时文件 @${p}`);
    expect(uploadTempNote(p)).not.toContain("已写入文件");
  });
});
