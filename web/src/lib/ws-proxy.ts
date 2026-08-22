/** Server-side WS proxy. Browser cannot set Authorization. */

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { encodeFrame, isWatchEvent, nextReqId, parseFrame, type WatchEvent } from "./protocol";

export type ProxyTarget = { host: string; port: number; token: string };

export type ProxySession = { target: ProxyTarget; connected: boolean };

const RPC_TIMEOUT_MS = 120_000;
const WS_PATH = "/v1";

function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

function frameText(data: WebSocket.RawData, isBinary: boolean): string | null {
  if (isBinary) return null;
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function waitOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onErr = (e: Error) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("error", onErr);
    };
    ws.once("open", onOpen);
    ws.once("error", onErr);
  });
}

function rejectHttp(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

type PendingRpc = {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CcopWsBridge {
  private target: ProxyTarget | null = null;
  private socket: WebSocket | null = null;
  private pending = new Map<string, PendingRpc>();
  private watchers = new Set<(ev: WatchEvent) => void>();
  private frames = new Set<(text: string) => void>();
  private watchSent = false;

  constructor() {}

  getTarget(): ProxyTarget | null {
    return this.target;
  }

  isConnected(): boolean {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN);
  }

  async connect(
    target: ProxyTarget,
  ): Promise<{ ok: true; ping: Record<string, unknown> } | { ok: false; error: string }> {
    await this.disconnect();
    const ws = new WebSocket(`ws://${target.host}:${target.port}${WS_PATH}`, {
      headers: { Authorization: `Bearer ${target.token}` },
    });
    try {
      await waitOpen(ws);
    } catch (e) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      return { ok: false, error: errText(e) };
    }
    this.target = { host: target.host, port: target.port, token: target.token };
    this.socket = ws;
    ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    ws.on("close", () => this.onSocketClosed());
    ws.on("error", () => {
      /* do not log; token must not appear */
    });
    try {
      const ping = await this.rpc({ cmd: "ping" });
      if (ping.ok !== true) {
        const error = typeof ping.error === "string" ? ping.error : "ping failed";
        await this.disconnect();
        return { ok: false, error };
      }
      this.flushWatch();
      return { ok: true, ping };
    } catch (e) {
      await this.disconnect();
      return { ok: false, error: errText(e) };
    }
  }

  async disconnect(): Promise<void> {
    const ws = this.socket;
    this.socket = null;
    this.target = null;
    this.watchSent = false;
    this.failPending("disconnected");
    if (!ws) return;
    if (ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      ws.once("close", done);
      try {
        ws.close();
      } catch {
        resolve();
        return;
      }
      setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        resolve();
      }, 500);
    });
  }

  async rpc(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("not connected");
    const req_id = req.req_id === undefined ? nextReqId() : req.req_id;
    const key = String(req_id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error("rpc timeout"));
      }, RPC_TIMEOUT_MS);
      this.pending.set(key, { resolve, reject, timer });
      try {
        ws.send(encodeFrame({ ...req, req_id }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(e instanceof Error ? e : new Error(errText(e)));
      }
    });
  }

  watch(cb: (ev: WatchEvent) => void): () => void {
    this.watchers.add(cb);
    this.flushWatch();
    return () => {
      this.watchers.delete(cb);
    };
  }

  /** Every daemon text frame. Used by the browser pipe. */
  onFrame(cb: (text: string) => void): () => void {
    this.frames.add(cb);
    return () => {
      this.frames.delete(cb);
    };
  }

  sendFrame(text: string): void {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(text);
  }

  private flushWatch(): void {
    if (this.watchSent || this.watchers.size === 0 || !this.isConnected()) return;
    this.watchSent = true;
    void this.rpc({ cmd: "watch" }).catch(() => {
      this.watchSent = false;
    });
  }

  private onMessage(data: WebSocket.RawData, isBinary: boolean): void {
    const text = frameText(data, isBinary);
    if (text === null) return;
    for (const cb of this.frames) cb(text);
    let msg: Record<string, unknown>;
    try {
      msg = parseFrame(text);
    } catch {
      return;
    }
    if (isWatchEvent(msg)) {
      for (const cb of this.watchers) cb(msg);
      return;
    }
    if (msg.req_id === undefined) return;
    const key = String(msg.req_id);
    const wait = this.pending.get(key);
    if (!wait) return;
    clearTimeout(wait.timer);
    this.pending.delete(key);
    wait.resolve(msg);
  }

  private onSocketClosed(): void {
    this.socket = null;
    this.target = null;
    this.watchSent = false;
    this.failPending("disconnected");
  }

  private failPending(reason: string): void {
    const err = new Error(reason);
    for (const wait of this.pending.values()) {
      clearTimeout(wait.timer);
      wait.reject(err);
    }
    this.pending.clear();
  }
}

export function attachWsProxy(httpServer: HttpServer, bridge: CcopWsBridge): () => void {
  const wss = new WebSocketServer({ noServer: true });
  const browsers = new Set<WebSocket>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/v1" && url.pathname !== "/api/ws") return;
    if (!bridge.isConnected()) {
      rejectHttp(socket, 503, "Service Unavailable");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      browsers.add(ws);
      ws.on("close", () => browsers.delete(ws));
      ws.on("error", () => {
        browsers.delete(ws);
      });
      ws.on("message", (data, isBinary) => {
        const text = frameText(data, isBinary);
        if (text === null) return;
        bridge.sendFrame(text);
      });
    });
  };

  const offFrame = bridge.onFrame((text) => {
    for (const b of browsers) {
      if (b.readyState === WebSocket.OPEN) b.send(text);
    }
  });

  httpServer.on("upgrade", onUpgrade);

  return () => {
    httpServer.off("upgrade", onUpgrade);
    offFrame();
    for (const b of browsers) {
      try {
        b.close();
      } catch {
        /* ignore */
      }
    }
    browsers.clear();
    wss.close();
  };
}

