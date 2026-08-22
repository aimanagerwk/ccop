import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  authorizeUpgrade,
  readWsEnv,
  startWsServer,
  tokenFromHeaders,
  tokensMatch,
  type EventCb,
  type OnEvent,
} from "../src/ws.js";

function bus(): { onEvent: OnEvent; fire: EventCb } {
  const listeners = new Set<EventCb>();
  return {
    onEvent(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    fire(id, event) {
      for (const cb of listeners) cb(id, event);
    },
  };
}

async function rawUpgrade(port: number, extraHeaders: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    sock.on("connect", () => {
      sock.write(
        `GET /v1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extraHeaders}\r\n`,
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
    sock.setTimeout(3000, () => {
      sock.destroy();
      reject(new Error("upgrade timeout"));
    });
  });
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitMsg(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("msg timeout")), 3000);
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

describe("ws auth helpers", () => {
  const token = "secret-token";

  it("accepts Authorization Bearer", () => {
    expect(tokenFromHeaders({ authorization: "Bearer secret-token" })).toBe("secret-token");
    expect(authorizeUpgrade({ authorization: "Bearer secret-token" }, token)).toBe(true);
  });

  it("accepts x-ccop-token", () => {
    expect(tokenFromHeaders({ "x-ccop-token": "secret-token" })).toBe("secret-token");
    expect(authorizeUpgrade({ "x-ccop-token": "secret-token" }, token)).toBe(true);
  });

  it("rejects missing and wrong", () => {
    expect(authorizeUpgrade({}, token)).toBe(false);
    expect(authorizeUpgrade({ authorization: "Bearer no" }, token)).toBe(false);
    expect(authorizeUpgrade({ "x-ccop-token": "nope" }, token)).toBe(false);
    expect(tokensMatch(undefined, token)).toBe(false);
    expect(tokensMatch("secret-token", token)).toBe(true);
    expect(tokensMatch("secret-tokeX", token)).toBe(false);
  });

  it("readWsEnv defaults and empty token", () => {
    const prevT = process.env.CCOP_TOKEN;
    const prevH = process.env.CCOP_WS_HOST;
    const prevP = process.env.CCOP_WS_PORT;
    delete process.env.CCOP_TOKEN;
    delete process.env.CCOP_WS_HOST;
    delete process.env.CCOP_WS_PORT;
    const a = readWsEnv();
    expect(a.token).toBe("");
    expect(a.host).toBe("127.0.0.1");
    expect(a.port).toBe(8787);
    process.env.CCOP_TOKEN = "t";
    process.env.CCOP_WS_HOST = "0.0.0.0";
    process.env.CCOP_WS_PORT = "9";
    const b = readWsEnv();
    expect(b.token).toBe("t");
    expect(b.host).toBe("0.0.0.0");
    expect(b.port).toBe(9);
    if (prevT === undefined) delete process.env.CCOP_TOKEN;
    else process.env.CCOP_TOKEN = prevT;
    if (prevH === undefined) delete process.env.CCOP_WS_HOST;
    else process.env.CCOP_WS_HOST = prevH;
    if (prevP === undefined) delete process.env.CCOP_WS_PORT;
    else process.env.CCOP_WS_PORT = prevP;
  });
});

describe("ws server", () => {
  const token = "test-token-xyz";
  let closer: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (closer) {
      await closer();
      closer = null;
    }
  });

  async function listen(
    dispatch: (req: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ev = bus(),
  ) {
    const handle = await startWsServer({
      token,
      host: "127.0.0.1",
      port: 0,
      dispatch,
      onEvent: ev.onEvent,
    });
    closer = handle.close;
    return { ...handle, ev };
  }

  it("rejects missing and wrong token with 401", async () => {
    const { port } = await listen(async () => ({ ok: true }));
    const missing = await rawUpgrade(port, "");
    expect(missing.startsWith("HTTP/1.1 401")).toBe(true);
    const wrong = await rawUpgrade(port, "Authorization: Bearer nope\r\n");
    expect(wrong.startsWith("HTTP/1.1 401")).toBe(true);
  });

  it("dispatches JSON frames and echoes req_id", async () => {
    const { port } = await listen(async (req) => {
      if (req.cmd === "ping") return { ok: true, pid: 1 };
      if (req.cmd === "status") return { ok: true, sessions: [] };
      return { ok: false, error: `unknown cmd ${req.cmd}` };
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await waitOpen(ws);
    ws.send(JSON.stringify({ cmd: "ping", req_id: "a1" }));
    expect(await waitMsg(ws)).toEqual({ ok: true, pid: 1, req_id: "a1" });
    ws.send(JSON.stringify({ cmd: "status", req_id: 2 }));
    expect(await waitMsg(ws)).toEqual({ ok: true, sessions: [], req_id: 2 });
    ws.close();
  });

  it("accepts x-ccop-token and fake dispatcher", async () => {
    const { port } = await listen(async (req) => ({ ok: true, echo: req.cmd }));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1`, {
      headers: { "x-ccop-token": token },
    });
    await waitOpen(ws);
    ws.send(JSON.stringify({ cmd: "info", id: "sess-1", req_id: "r" }));
    expect(await waitMsg(ws)).toEqual({ ok: true, echo: "info", id: "sess-1", req_id: "r" });
    ws.close();
  });

  it("watch all sessions then unwatch", async () => {
    const { port, ev } = await listen(async () => ({ ok: true }));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await waitOpen(ws);
    ws.send(JSON.stringify({ cmd: "watch", req_id: "w1" }));
    expect(await waitMsg(ws)).toEqual({ ok: true, req_id: "w1" });
    ev.fire("aaa", { kind: "needs_decision", summary: "parked", extra: {}, ts: 1 });
    expect(await waitMsg(ws)).toEqual({
      type: "event",
      id: "aaa",
      event: { kind: "needs_decision", summary: "parked", extra: {}, ts: 1 },
    });
    ws.send(JSON.stringify({ cmd: "unwatch", req_id: "u1" }));
    expect(await waitMsg(ws)).toEqual({ ok: true, req_id: "u1" });
    ev.fire("aaa", { kind: "working", summary: "later", extra: {}, ts: 2 });
    const late = await Promise.race([
      waitMsg(ws).then((m) => ({ hit: true as const, m })),
      new Promise<{ hit: false }>((r) => setTimeout(() => r({ hit: false }), 150)),
    ]);
    expect(late.hit).toBe(false);
    ws.close();
  });

  it("watch one session filters others", async () => {
    const { port, ev } = await listen(async () => ({ ok: true }));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await waitOpen(ws);
    ws.send(JSON.stringify({ cmd: "watch", id: "keep", req_id: "w" }));
    expect(await waitMsg(ws)).toEqual({ ok: true, id: "keep", req_id: "w" });
    ev.fire("other", { kind: "failed", summary: "x", extra: {} });
    ev.fire("keep", { kind: "failed", summary: "y", extra: {} });
    expect(await waitMsg(ws)).toEqual({
      type: "event",
      id: "keep",
      event: { kind: "failed", summary: "y", extra: {} },
    });
    ws.close();
  });
});
