import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../web/src/app/globals.css"),
  "utf8",
);

function block(name: string): string {
  const i = css.indexOf(`.${name} {`);
  expect(i).toBeGreaterThanOrEqual(0);
  const j = css.indexOf("}", i);
  return css.slice(i, j + 1);
}

describe("inbox layout cap", () => {
  it("caps .inbox with a pixel max-height and scrolls internally", () => {
    const inbox = block("inbox");
    expect(inbox).toMatch(/max-height:\s*168px/);
    expect(inbox).toMatch(/overflow:\s*auto/);
    expect(inbox).not.toMatch(/max-height:\s*40%/);
  });

  it("does not let .inbox grow without bound in the main column", () => {
    const inbox = block("inbox");
    expect(inbox).toMatch(/min-height:\s*0/);
    expect(inbox).toMatch(/flex:\s*0 1 auto/);
  });
});
