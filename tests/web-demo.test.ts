import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startWsServer } from "../src/ws.js";
import {
  KINDS,
  encodeFrame,
  isReply,
  isWatchEvent,
  nextReqId,
  parseFrame,
  toastPriority,
} from "../web/src/lib/protocol.js";
import { CcopWsBridge } from "../web/src/lib/ws-proxy.js";

describe("web protocol helpers", () => {
  it("toastPriority matches WS.md for every kind", () => {
    const map: Record<string, ReturnType<typeof toastPriority>> = {
      needs_decision: "interrupt",
      needs_info: "interrupt",
      failed: "interrupt",
      dead: "interrupt",
      turn_done: "badge",
      task_done: "badge",
      working: "badge",
      sent: "silent",
      idle: "silent",
      interrupted: "silent",
      held: "silent",
    };
    expect(KINDS.slice().sort()).toEqual(Object.keys(map).sort());
    for (const [k, v] of Object.entries(map)) expect(toastPriority(k)).toBe(v);
  });

  it("isWatchEvent / isReply", () => {
    expect(isWatchEvent({ type: "event", id: "s", event: { kind: "sent" } })).toBe(true);
    expect(isWatchEvent({ ok: true, req_id: 1 })).toBe(false);
    expect(isReply({ ok: true, req_id: 1 })).toBe(true);
    expect(isReply({ type: "event", id: "s", event: {} })).toBe(false);
    expect(isReply(null)).toBe(false);
    expect(isWatchEvent(["event"])).toBe(false);
  });

  it("encodeFrame / parseFrame", () => {
    const obj = { cmd: "ping", req_id: "a1" };
    expect(parseFrame(encodeFrame(obj))).toEqual(obj);
  });

  it("nextReqId uniqueness", () => {
    const ids = new Set(Array.from({ length: 20 }, () => nextReqId()));
    expect(ids.size).toBe(20);
  });
});

describe("CcopWsBridge against in-process ws", () => {
  const token = "bridge-test-token";
  let closer: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (closer) {
      await closer();
      closer = null;
    }
  });

  it("pings and receives a watch event", async () => {
    const listeners = new Set<(id: string, ev: Record<string, unknown>) => void>();
    const handle = await startWsServer({
      token,
      host: "127.0.0.1",
      port: 0,
      dispatch: async (req) => {
        if (req.cmd === "ping") return { ok: true, pid: 1 };
        return { ok: true };
      },
      onEvent: (cb) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
    });
    closer = handle.close;
    const bridge = new CcopWsBridge();
    const conn = await bridge.connect({ host: "127.0.0.1", port: handle.port, token });
    expect(conn.ok).toBe(true);
    if (conn.ok) expect(conn.ping.ok).toBe(true);

    const got: unknown[] = [];
    const off = bridge.watch((e) => got.push(e));
    await new Promise((r) => setTimeout(r, 50));
    for (const cb of listeners) cb("aaa", { kind: "needs_decision", summary: "parked", extra: {}, ts: 1 });
    const deadline = Date.now() + 2000;
    while (!got.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(got[0]).toEqual({
      type: "event",
      id: "aaa",
      event: { kind: "needs_decision", summary: "parked", extra: {}, ts: 1 },
    });
    off();
    await bridge.disconnect();
    expect(bridge.isConnected()).toBe(false);
  });

  it("does not leak token into ping reply", async () => {
    const handle = await startWsServer({
      token,
      host: "127.0.0.1",
      port: 0,
      dispatch: async () => ({ ok: true, pid: 2 }),
      onEvent: () => () => {},
    });
    closer = handle.close;
    const bridge = new CcopWsBridge();
    const conn = await bridge.connect({ host: "127.0.0.1", port: handle.port, token });
    expect(conn.ok).toBe(true);
    if (conn.ok) expect(JSON.stringify(conn.ping)).not.toContain(token);
    await bridge.disconnect();
    void WebSocket;
  });
});
