/** Live smoke: start, hold/send, approve, wait for hello.py + turn_done. */

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "../src/paths.js";
import { readEvents } from "../src/store.js";

const HELLO = "/workspace/hello-cc/hello.py";
const PROMPT =
  "Create or overwrite hello.py that prints Hello, world! then run it with python3.";

function rpc(argv: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const p = spawn(
      process.execPath,
      [join(ROOT, "node_modules/tsx/dist/cli.mjs"), join(ROOT, "src/cli.ts"), ...argv],
      { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    p.stdout.on("data", (c) => {
      out += c.toString();
    });
    p.on("exit", (code) => {
      let obj: Record<string, unknown>;
      const text = out.trim();
      try {
        obj = text ? JSON.parse(text) : { ok: false, error: "empty" };
      } catch {
        obj = { ok: false, error: "non-json", raw: text.slice(0, 500) };
      }
      obj._code = code ?? 1;
      resolve(obj);
    });
  });
}

function kinds(name: string): Set<string> {
  return new Set(readEvents(name).map((e) => String(e.kind)));
}

async function mainSmoke(): Promise<number> {
  console.log("== up");
  console.log(await rpc(["up"]));
  console.log("== up again (idempotent)");
  console.log(await rpc(["up"]));
  console.log("== start smoke");
  const st = await rpc(["start", "--cwd", "/workspace/hello-cc", "--prompt", PROMPT, "--name", "smoke"]);
  const shown: Record<string, unknown> = {};
  for (const k of Object.keys(st)) if (k !== "trace") shown[k] = st[k];
  console.log(shown);
  if (!st.ok) {
    const log = join(ROOT, "data/daemon.log");
    if (existsSync(log)) {
      let tail = readFileSync(log, "utf8").slice(-3000);
      for (const tok of ["ANTHROPIC_AUTH_TOKEN", "sk-ant-", "Bearer "]) {
        if (tail.includes(tok)) {
          tail = "[log redacted: contains secret-like token]";
          break;
        }
      }
      console.log("daemon.log tail:", tail);
    }
    return 1;
  }
  const id = String(st.id);
  console.log("== hold");
  console.log(await rpc(["hold", id]));
  console.log("== send while held (expect error)");
  const held = await rpc(["send", id, "ignore this"]);
  console.log(held);
  if (held.ok || held.error !== "held") {
    console.log("FAIL: expected held error");
    return 1;
  }
  console.log("== release");
  console.log(await rpc(["release", id]));

  const deadline = Date.now() + 240000;
  const approved = new Set<string>();
  let helloOk = false;
  while (Date.now() < deadline) {
    const status = await rpc(["status"]);
    const sessions = Object.fromEntries(
      ((status.sessions as Record<string, unknown>[]) || []).map((s) => [s.id, s]),
    );
    const s = (sessions[id] || {}) as Record<string, unknown>;
    const pending = (s.pending as { tool_use_id?: string; tool?: string; reason?: string }[]) || [];
    for (const p of pending) {
      const tid = p.tool_use_id;
      if (tid && !approved.has(tid)) {
        console.log("approve", tid, p.tool, p.reason);
        console.log(await rpc(["approve", id, tid]));
        approved.add(tid);
      }
    }
    const ks = kinds(id);
    if (existsSync(HELLO)) {
      const text = readFileSync(HELLO, "utf8");
      if (text.includes("Hello")) helloOk = true;
    }
    if (helloOk && (ks.has("turn_done") || ks.has("task_done"))) {
      console.log("== done kinds", [...ks].sort());
      break;
    }
    if (ks.has("dead") && !helloOk) {
      console.log("session dead early", [...ks].sort());
      console.log("last events", readEvents(id).slice(-8));
      return 1;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (Date.now() >= deadline) {
    console.log("TIMEOUT kinds", [...kinds(id)].sort());
    console.log("status", await rpc(["status"]));
    console.log("events tail", readEvents(id).slice(-15));
    return 1;
  }
  console.log("== hello.py");
  console.log(readFileSync(HELLO, "utf8"));
  console.log("== status");
  const status = await rpc(["status"]);
  console.log(JSON.stringify(status, null, 2).slice(0, 4000));
  const smoke = ((status.sessions as Record<string, unknown>[]) || []).find((x) => x.id === id)!;
  if (!("last_turn" in smoke) || !("last_task" in smoke)) throw new Error("missing last_turn/last_task");
  console.log("== stop");
  console.log(await rpc(["stop", id]));
  console.log("== down");
  console.log(await rpc(["down"]));
  console.log("SMOKE_OK");
  return 0;
}

process.exit(await mainSmoke());
