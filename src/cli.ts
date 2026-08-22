/** npx tsx src/cli.ts — JSON-in/JSON-out operator CLI for the parent assistant. */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOG_PATH, PID_PATH, ROOT, SOCK_PATH, ensureData } from "./paths.js";
import { parseArgs } from "./parse.js";
import {
  WAIT_POLL_MS,
  isUnknownWaitCmd,
  matchWaitPoll,
  matchWaitStart,
  newestEventTs,
  parseWaitKinds,
  parseWaitTimeout,
  waitOk,
  type PendingTool,
  type WaitSnap,
} from "./wait.js";
import {
  isUnknownMonitorCmd,
  matchMonitorEvent,
  matchMonitorPoll,
  matchMonitorStart,
  monitorOk,
  parseMonitorStall,
  parseMonitorTimeout,
} from "./monitor.js";

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

async function pingDaemon(): Promise<Record<string, unknown> | null> {
  try {
    const { sendReq } = await import("./ipc.js");
    return await sendReq({ cmd: "ping" }, 2);
  } catch {
    return null;
  }
}

function wsFromPing(p: Record<string, unknown> | null): { ws?: unknown } {
  if (p && p.ws) return { ws: p.ws };
  return {};
}

async function cmdUp(): Promise<void> {
  ensureData();
  const pid = await daemonAlive();
  if (pid !== null) {
    const extra = wsFromPing(await pingDaemon());
    out({ ok: true, pid, already: true, ...extra });
  }
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
    if ((await daemonAlive()) !== null) {
      const extra = wsFromPing(await pingDaemon());
      out({ ok: true, pid: proc.pid, already: false, ...extra });
    }
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

function logDown(why: string): void {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} shutdown ${why}\n`);
  } catch {
    /* ignore */
  }
}

async function cmdDown(): Promise<void> {
  logDown("cmd=down");
  const { ping, sendReq } = await import("./ipc.js");
  if (await ping()) {
    try {
      await sendReq({ cmd: "shutdown", reason: "cmd=down" }, 5);
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
  if (cmd === "wait") return cmdWaitCli(args);
  if (cmd === "monitor") return cmdMonitorCli(args);
  out({ ok: false, error: `unknown cmd ${cmd}` }, 1);
}

async function fetchWaitSnap(id: unknown): Promise<{ ok: true; id: string; snap: WaitSnap } | { ok: false; error: string }> {
  const { sendReq } = await import("./ipc.js");
  const evRes = await sendReq({ cmd: "events", id }, 30);
  if (!evRes.ok) return { ok: false, error: String(evRes.error || "events failed") };
  const resolvedId = String(evRes.id || id);
  const events = Array.isArray(evRes.events) ? (evRes.events as Record<string, unknown>[]) : [];
  let pending: PendingTool[] = [];
  let alive = false;
  try {
    const st = await sendReq({ cmd: "status" }, 30);
    if (st.ok && Array.isArray(st.sessions)) {
      const row = (st.sessions as Record<string, unknown>[]).find((s) => String(s.id) === resolvedId);
      if (row) {
        alive = Boolean(row.alive);
        pending = Array.isArray(row.pending) ? (row.pending as PendingTool[]) : [];
      }
    }
  } catch {
    /* status optional; events already resolved the id */
  }
  try {
    const info = await sendReq({ cmd: "info", id: resolvedId }, 30);
    if (info.ok) {
      if (typeof info.alive === "boolean") alive = info.alive;
      if (Array.isArray(info.pending)) pending = info.pending as PendingTool[];
    }
  } catch {
    /* info may omit pending/alive */
  }
  return { ok: true, id: resolvedId, snap: { events, pending, alive, found: true } };
}

async function pollWait(id: unknown, kinds: string[], timeoutSec: number): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  let fetched = await fetchWaitSnap(id);
  if (!fetched.ok) out({ ok: false, error: fetched.error }, 1);
  const start = matchWaitStart(fetched.snap, kinds);
  if (start.hit) out(waitOk(fetched.id, start));
  const afterTs = newestEventTs(fetched.snap.events);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    fetched = await fetchWaitSnap(id);
    if (!fetched.ok) out({ ok: false, error: fetched.error }, 1);
    const hit = matchWaitPoll(fetched.snap, kinds, afterTs);
    if (hit.hit) out(waitOk(fetched.id, hit));
  }
  out({ ok: false, error: "wait timeout" }, 1);
}

async function cmdWaitCli(args: Record<string, unknown>): Promise<void> {
  const parsed = parseWaitKinds(args.kind);
  if (!parsed.ok) out({ ok: false, error: parsed.error }, 1);
  const timeoutSec = parseWaitTimeout(args.timeout);
  const { sendReq } = await import("./ipc.js");
  try {
    const res = await sendReq(
      { cmd: "wait", id: args.id, kinds: parsed.kinds, timeout: timeoutSec },
      timeoutSec + 10,
    );
    if (isUnknownWaitCmd(res)) return pollWait(args.id, parsed.kinds, timeoutSec);
    out(res, res.ok ? 0 : 1);
  } catch (exc: any) {
    const msg = String(exc?.message || exc);
    if (/unknown cmd/i.test(msg)) return pollWait(args.id, parsed.kinds, timeoutSec);
    out({ ok: false, error: `daemon not reachable: ${exc}` }, 1);
  }
}


function emitLine(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function pollMonitor(id: unknown, kinds: string[], timeoutSec: number, stallSec: number): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  let fetched = await fetchWaitSnap(id);
  if (!fetched.ok) out({ ok: false, error: fetched.error }, 1);
  const start = matchMonitorStart(fetched.snap);
  if (start.hit) out(monitorOk(fetched.id, start));
  let afterTs = newestEventTs(fetched.snap.events);
  let lastNewMs = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    fetched = await fetchWaitSnap(id);
    if (!fetched.ok) out({ ok: false, error: fetched.error }, 1);
    const now = Date.now();
    const { news, match } = matchMonitorPoll(fetched.snap, kinds, afterTs, lastNewMs, now, stallSec);
    for (const e of news) {
      emitLine(e);
      const evHit = matchMonitorEvent(e, kinds, afterTs, fetched.snap.pending);
      if (evHit.hit) out(monitorOk(fetched.id, evHit));
    }
    if (news.length) {
      afterTs = newestEventTs(fetched.snap.events);
      lastNewMs = now;
    }
    if (match.hit) out(monitorOk(fetched.id, match));
  }
  out({ ok: false, error: "monitor timeout" }, 1);
}

async function cmdMonitorCli(args: Record<string, unknown>): Promise<void> {
  const parsed = parseWaitKinds(args.kind);
  if (!parsed.ok) out({ ok: false, error: parsed.error }, 1);
  const timeoutSec = parseMonitorTimeout(args.timeout);
  const stallSec = parseMonitorStall(args.stall);
  const { sendReq } = await import("./ipc.js");
  try {
    const res = await sendReq(
      { cmd: "monitor", id: args.id, kinds: parsed.kinds, timeout: timeoutSec, stall: stallSec },
      timeoutSec + 5,
    );
    if (isUnknownMonitorCmd(res)) return pollMonitor(args.id, parsed.kinds, timeoutSec, stallSec);
    out(res, res.ok ? 0 : 1);
  } catch (exc: any) {
    const msg = String(exc?.message || exc);
    if (/unknown cmd/i.test(msg)) return pollMonitor(args.id, parsed.kinds, timeoutSec, stallSec);
    out({ ok: false, error: `daemon not reachable: ${exc}` }, 1);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain || process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js")) {
  void main();
}
