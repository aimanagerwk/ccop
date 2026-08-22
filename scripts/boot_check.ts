import { spawn } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "../src/paths.js";

function run(argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(ROOT, "node_modules/tsx/dist/cli.mjs"), join(ROOT, "src/cli.ts"), ...argv], {
      cwd: ROOT,
      stdio: "inherit",
    });
    p.on("exit", (c) => resolve(c ?? 1));
  });
}

const c0 = await run(["up"]);
console.error("UP_CODE", 0, c0);
const c1 = await run(["up"]);
console.error("UP_CODE", 1, c1);
const cs = await run(["status"]);
console.error("STATUS_CODE", cs);
