/** npx tsx src/cli.ts — JSON-in/JSON-out operator CLI for the parent assistant. */

import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOG_PATH, PID_PATH, ROOT, SOCK_PATH, ensureData } from "./paths.js";
import { parseArgs } from "./parse.js";

const here = dirname(fileURLToPath(import.meta.url));

function out(obj: Record<string, unknown>, code = 0): never {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(code);
}

async function daemonAlive(): Promise<number | null> {
  const { ping } = await import("./ipc.js");
  if (await ping()) {
    if (existsSync(PID_PATH)) {
      try {
        return parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
      } catch {
        return 0;
      }
    }
    return 0;
  }
  return null;
}

function resolveTsx(): string {
  const req = createRequire(join(ROOT, "package.json"));
  try {
    return req.resolve("tsx/cli");
  } catch {
    try {
      return req.resolve("tsx/dist/cli.mjs");
    } catch {
      return join(ROOT, "node_modules/tsx/dist/cli.mjs");
    }
  }
}

async function cmdUp(): Promise<void> {
  ensureData();
  const pid = await daemonAlive();
  if (pid !== null) out({ ok: true, pid, already: true });
  const logFd = openSync(LOG_PATH, "a");
  const cli = join(here, "cli.ts");
  const tsx = resolveTsx();
  const proc = spawn(process.execPath, [tsx, cli, "_serve"], {
    cwd: ROOT,
    env: process.env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  writeFileSync(PID_PATH, String(proc.pid) + "\n");
  proc.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if ((await daemonAlive()) !== null) out({ ok: true, pid: proc.pid, already: false });
    try {
      process.kill(proc.pid!, 0);
    } catch {
      let tail = "";
      if (existsSync(LOG_PATH)) tail = readFileSync(LOG_PATH, "utf8").slice(-2000);
      out({ ok: false, error: "daemon exited", log_tail: tail }, 1);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  out({ ok: false, error: "daemon did not open socket" }, 1);
}

async function cmdDown(): Promise<void> {
  const { ping, sendReq } = await import("./ipc.js");
  if (await ping()) {
    try {
      await sendReq({ cmd: "shutdown" }, 5);
    } catch {
      /* ignore */
    }
  }
  let pid: number | null = null;
  if (existsSync(PID_PATH)) {
    try {
      pid = parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
    } catch {
      pid = null;
    }
  }
  if (pid) {
    for (let i = 0; i < 20; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  if (existsSync(SOCK_PATH)) {
    try {
      unlinkSync(SOCK_PATH);
    } catch {
      /* ignore */
    }
  }
  out({ ok: true });
}

async function rpc(req: Record<string, unknown>, timeout = 60): Promise<void> {
  const { sendReq } = await import("./ipc.js");
  try {
    const res = await sendReq(req, timeout);
    out(res, res.ok ? 0 : 1);
  } catch (exc: any) {
    out({ ok: false, error: `daemon not reachable: ${exc}` }, 1);
  }
}

function readStdinText(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(Buffer.from(c)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function parseJsonObject(raw: string, label: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (exc: any) {
    out({ ok: false, error: `${label}: invalid JSON (${exc?.message || exc})` }, 1);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    out({ ok: false, error: `${label}: expected a JSON object` }, 1);
  }
  return parsed as Record<string, unknown>;
}

export async function main(argv?: string[]): Promise<void> {
  const a = parseArgs(argv ?? process.argv.slice(2));
  const { cmd, args } = a;
  if (cmd === "up") return cmdUp();
  if (cmd === "down") return cmdDown();
  if (cmd === "_serve") {
    const { main: serveMain } = await import("./daemon.js");
    serveMain();
    return;
  }
  if (cmd === "status") return rpc({ cmd: "status" });
  if (cmd === "start") {
    return rpc(
      {
        cmd: "start",
        name: args.name ?? "",
        cwd: args.cwd,
        prompt: args.prompt,
        resume_id: args.resume_id ?? null,
        permission_mode: args.permission_mode ?? "auto",
      },
      120,
    );
  }
  if (cmd === "send") return rpc({ cmd: "send", id: args.id, text: args.text });
  if (["interrupt", "hold", "release", "stop", "info", "workflows", "tasks", "subagents"].includes(cmd)) {
    return rpc({ cmd, id: args.id });
  }
  if (cmd === "task-stop") return rpc({ cmd: "task-stop", id: args.id, task_id: args.task_id });
  if (cmd === "task-bg") return rpc({ cmd: "task-bg", id: args.id, tool_use_id: args.tool_use_id ?? null });
  if (cmd === "approve") return rpc({ cmd: "approve", id: args.id, tool_use_id: args.tool_use_id });
  if (cmd === "deny") return rpc({ cmd: "deny", id: args.id, tool_use_id: args.tool_use_id });
  if (cmd === "events") return rpc({ cmd: "events", id: args.id, tail: args.tail ?? null });
  if (cmd === "mcp") return rpc({ cmd: "mcp", id: args.id });
  if (cmd === "mcp-set") {
    let raw: string;
    if (typeof args.json === "string") raw = args.json;
    else raw = await readStdinText();
    const servers = await parseJsonObject(raw || "", "mcp-set");
    return rpc({ cmd: "mcp-set", id: args.id, servers }, 120);
  }
  if (cmd === "mcp-reconnect") return rpc({ cmd: "mcp-reconnect", id: args.id, server: args.server });
  if (cmd === "mcp-toggle") {
    if (args.enabled !== true && args.enabled !== false) {
      out({ ok: false, error: "mcp-toggle requires --on or --off" }, 1);
    }
    return rpc({ cmd: "mcp-toggle", id: args.id, server: args.server, enabled: args.enabled });
  }
  if (cmd === "plugins-reload") return rpc({ cmd: "plugins-reload", id: args.id }, 120);
  if (cmd === "skills-reload") return rpc({ cmd: "skills-reload", id: args.id }, 120);
  out({ ok: false, error: `unknown cmd ${cmd}` }, 1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain || process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js")) {
  void main();
}
