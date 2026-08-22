/** Live WEB-E2E driver. Real results only. No invented coverage. */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

const ROOT = "/workspace/ccop";
const HELLO = "/workspace/hello-cc";
const TOKEN = process.env.CCOP_TOKEN || process.env.CCOP_E2E_TOKEN || "e2e-web-token-do-not-commit";
const WS_HOST = "127.0.0.1";
const WS_PORT = Number(process.env.CCOP_E2E_WS_PORT || 8787);
const WEB_PORT = Number(process.env.CCOP_E2E_WEB_PORT || 3000);
const OUT = join(ROOT, "WEB-E2E.md");

const cases = [];

function row(name, result, detail) {
  cases.push({ name, result, detail: String(detail).slice(0, 800) });
  console.log(JSON.stringify({ name, result, detail: String(detail).slice(0, 400) }));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function rawUpgrade(port, path, extraHeaders) {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: WS_HOST, port });
    const chunks = [];
    sock.on("connect", () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: ${WS_HOST}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extraHeaders}\r\n`,
      );
    });
    sock.on("data", (c) => {
      chunks.push(Buffer.from(c));
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.includes("\r\n\r\n")) {
        sock.destroy();
        resolve(text);
      }
    });
    sock.on("error", reject);
    sock.setTimeout(4000, () => {
      sock.destroy();
      reject(new Error("upgrade timeout"));
    });
  });
}

function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitMsg(ws, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("msg timeout")), ms);
    ws.once("message", (data) => {
      clearTimeout(t);
      resolve(JSON.parse(String(data)));
    });
    ws.once("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

function openAuthed(headers) {
  return new WebSocket(`ws://${WS_HOST}:${WS_PORT}/v1`, { headers });
}

async function rpc(ws, req, timeout = 120000) {
  const req_id = req.req_id ?? `r-${Date.now()}-${Math.random()}`;
  ws.send(JSON.stringify({ ...req, req_id }));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const msg = await waitMsg(ws, Math.min(timeout, 120000));
    if (msg && msg.type === "event") continue;
    if (msg && msg.req_id === req_id) return msg;
  }
  throw new Error(`rpc timeout ${req.cmd}`);
}

function writeReport() {
  const lines = [
    "# WEB-E2E",
    "",
    "Live results against the ccop WebSocket and the `web/` Next.js proxy.",
    "A row is only PASS if that case actually ran and matched the expected outcome.",
    "",
    `| case | result | detail |`,
    `| --- | --- | --- |`,
    ...cases.map((c) => `| ${c.name} | ${c.result} | ${c.detail.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
    "",
    `Ran: ${new Date().toISOString()}`,
    "",
  ];
  writeFileSync(OUT, lines.join("\n"));
}

async function runCli(args, env) {
  const child = spawn("npx", ["tsx", "src/cli.ts", ...args], { cwd: ROOT, env, stdio: "pipe" });
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += c.toString();
  });
  child.stderr.on("data", (c) => {
    buf += c.toString();
  });
  const code = await new Promise((r) => child.on("close", r));
  let parsed = null;
  try {
    parsed = JSON.parse(buf.trim().split("\n").pop() || "{}");
  } catch {
    parsed = { raw: buf };
  }
  return { code, buf, parsed };
}

async function ensureDaemon() {
  // Ping/status first. Reuse a live daemon. Never `ccop down` / restart.
  const env = {
    ...process.env,
    CCOP_TOKEN: TOKEN,
    CCOP_WS_HOST: WS_HOST,
    CCOP_WS_PORT: String(WS_PORT),
  };
  process.env.CCOP_TOKEN = TOKEN;
  process.env.CCOP_WS_HOST = WS_HOST;
  process.env.CCOP_WS_PORT = String(WS_PORT);
  const st = await runCli(["status"], env);
  if (st.code === 0 && st.parsed?.ok) {
    return { ...st.parsed, already: true };
  }
  const up = await runCli(["up"], env);
  if (up.code !== 0 || !up.parsed?.ok) {
    throw new Error(`daemon up failed: ${up.buf.slice(-500)}`);
  }
  return up.parsed;
}

async function startWeb() {
  const env = {
    ...process.env,
    PORT: String(WEB_PORT),
    HOST: "127.0.0.1",
    NODE_ENV: "development",
  };
  const child = spawn("npx", ["tsx", "server.ts"], {
    cwd: join(ROOT, "web"),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => {
    log += c.toString();
  });
  child.stderr.on("data", (c) => {
    log += c.toString();
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${WEB_PORT}/api/health`);
      if (r.ok) return { child, log };
    } catch {
      /* not up */
    }
    if (child.exitCode != null) throw new Error(`web exited: ${log.slice(-800)}`);
    await sleep(300);
  }
  throw new Error(`web did not listen: ${log.slice(-800)}`);
}

async function main() {
  const up = await ensureDaemon();
  console.log("daemon", JSON.stringify(up));

  // 1. reject missing token
  try {
    const text = await rawUpgrade(WS_PORT, "/v1", "");
    const ok = text.startsWith("HTTP/1.1 401");
    row("reject missing token", ok ? "PASS" : "FAIL", text.split("\r\n")[0]);
  } catch (e) {
    row("reject missing token", "FAIL", e);
  }

  // 2. reject wrong token
  try {
    const text = await rawUpgrade(WS_PORT, "/v1", "Authorization: Bearer nope\r\n");
    const ok = text.startsWith("HTTP/1.1 401");
    row("reject wrong token", ok ? "PASS" : "FAIL", text.split("\r\n")[0]);
  } catch (e) {
    row("reject wrong token", "FAIL", e);
  }

  // 3. Bearer connect ping
  let bearer;
  try {
    bearer = openAuthed({ Authorization: `Bearer ${TOKEN}` });
    await waitOpen(bearer);
    const pong = await rpc(bearer, { cmd: "ping", req_id: "ping-b" }, 8000);
    const ok = pong.ok === true && pong.req_id === "ping-b";
    row("Bearer connect ping", ok ? "PASS" : "FAIL", JSON.stringify(pong));
  } catch (e) {
    row("Bearer connect ping", "FAIL", e);
  }

  // 4. x-ccop-token connect
  try {
    const ws = openAuthed({ "x-ccop-token": TOKEN });
    await waitOpen(ws);
    const pong = await rpc(ws, { cmd: "ping", req_id: "ping-x" }, 8000);
    const ok = pong.ok === true && pong.req_id === "ping-x";
    row("x-ccop-token connect", ok ? "PASS" : "FAIL", JSON.stringify(pong));
    ws.close();
  } catch (e) {
    row("x-ccop-token connect", "FAIL", e);
  }

  // 5. watch + start hello-cc + see events
  let sessionId = null;
  const seen = [];
  try {
    if (!bearer || bearer.readyState !== bearer.OPEN) {
      bearer = openAuthed({ Authorization: `Bearer ${TOKEN}` });
      await waitOpen(bearer);
    }
    bearer.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg.type === "event") seen.push(msg);
      } catch {
        /* ignore */
      }
    });
    const w = await rpc(bearer, { cmd: "watch", req_id: "w1" }, 8000);
    if (!w.ok) throw new Error(`watch failed ${JSON.stringify(w)}`);
    const started = await rpc(
      bearer,
      {
        cmd: "start",
        cwd: HELLO,
        prompt:
          "Create or overwrite /workspace/hello-cc/hello.py with a one-line print('hello'). Do not use sudo. Stay in this directory.",
        name: "web-e2e",
        permission_mode: "default",
        req_id: "start1",
      },
      180000,
    );
    if (!started.ok) throw new Error(`start failed ${JSON.stringify(started)}`);
    sessionId = started.id;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && seen.filter((e) => e.id === sessionId).length < 1) {
      await sleep(200);
    }
    const mine = seen.filter((e) => e.id === sessionId);
    const ok = mine.length > 0;
    row(
      "watch plus start hello-cc and see events",
      ok ? "PASS" : "FAIL",
      `id=${sessionId} n=${mine.length} kinds=${mine.map((e) => e.event?.kind).slice(0, 12).join(",")}`,
    );
  } catch (e) {
    row("watch plus start hello-cc and see events", "FAIL", e);
  }

  // 6. approve or deny if parked
  try {
    if (!sessionId) throw new Error("no session from start");
    let parked = null;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !parked) {
      const st = await rpc(bearer, { cmd: "status", req_id: `st-${Date.now()}` }, 15000);
      const sess = (st.sessions || []).find((s) => s.id === sessionId);
      const pending = (sess && sess.pending) || [];
      if (pending.length) parked = pending[0];
      else await sleep(800);
    }
    if (!parked) {
      row(
        "approve or deny if parked",
        "SKIP",
        "no pending tool_use_id within 120s (auto-pass or model did not park)",
      );
    } else {
      const res = await rpc(
        bearer,
        { cmd: "deny", id: sessionId, tool_use_id: parked.tool_use_id, req_id: "deny1" },
        20000,
      );
      const ok = res.ok === true && res.allowed === false;
      row(
        "approve or deny if parked",
        ok ? "PASS" : "FAIL",
        `deny ${parked.tool} ${parked.tool_use_id} → ${JSON.stringify(res)}`,
      );
    }
  } catch (e) {
    row("approve or deny if parked", "FAIL", e);
  }

  // 7. web proxy connect
  let web;
  try {
    if (!existsSync(join(ROOT, "web", "server.ts"))) {
      throw new Error("web/server.ts missing");
    }
    web = await startWeb();
    const health0 = await fetch(`http://127.0.0.1:${WEB_PORT}/api/health`).then((r) => r.json());
    const conn = await fetch(`http://127.0.0.1:${WEB_PORT}/api/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, host: WS_HOST, port: WS_PORT }),
    }).then((r) => r.json());
    const health1 = await fetch(`http://127.0.0.1:${WEB_PORT}/api/health`).then((r) => r.json());
    const ping = await fetch(`http://127.0.0.1:${WEB_PORT}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "ping" }),
    }).then((r) => r.json());
    const leaked = JSON.stringify({ health0, conn, health1, ping }).includes(TOKEN);
    const ok = conn.ok === true && health1.connected === true && ping.ok === true && !leaked;
    row(
      "web proxy connect",
      ok ? "PASS" : "FAIL",
      JSON.stringify({ health0, conn, health1, ping, leaked }),
    );
  } catch (e) {
    row("web proxy connect", "FAIL", e);
  } finally {
    if (web?.child) web.child.kill("SIGTERM");
  }

  if (sessionId && bearer && bearer.readyState === bearer.OPEN) {
    try {
      await rpc(bearer, { cmd: "stop", id: sessionId, req_id: "stop1" }, 20000);
    } catch {
      /* ignore */
    }
  }
  if (bearer) bearer.close();

  writeReport();
  const failed = cases.filter((c) => c.result === "FAIL");
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  row("driver", "FAIL", e);
  writeReport();
  process.exit(1);
});
