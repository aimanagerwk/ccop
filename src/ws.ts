/** WebSocket JSON RPC beside the unix socket. Header token only. */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

export const WS_PATH = "/v1";

export type DispatchFn = (req: Record<string, unknown>) => Promise<Record<string, unknown>>;

export type EventCb = (sessionId: string, event: Record<string, unknown>) => void;

export type OnEvent = (cb: EventCb) => () => void;

export type WsListen = { host: string; port: number };

export type WsServerHandle = WsListen & { close: () => Promise<void> };

export function readWsEnv(): { token: string; host: string; port: number } {
  const token = process.env.CCOP_TOKEN ?? "";
  const host = process.env.CCOP_WS_HOST || "127.0.0.1";
  const raw = process.env.CCOP_WS_PORT || "8787";
  const port = Number(raw);
  return { token, host, port: Number.isFinite(port) ? port : 8787 };
}

function headerVal(headers: IncomingMessage["headers"], name: string): string | undefined {
  const v = headers[name];
  if (Array.isArray(v)) return v[0];
  return typeof v === "string" ? v : undefined;
}

/** Bearer or x-ccop-token. Does not log. */
export function tokenFromHeaders(headers: IncomingMessage["headers"]): string | undefined {
  const auth = headerVal(headers, "authorization");
  if (auth) {
    const m = /^Bearer\s+(\S+)/i.exec(auth.trim());
    if (m) return m[1];
  }
  const x = headerVal(headers, "x-ccop-token");
  if (x !== undefined && x !== "") return x;
  return undefined;
}

export function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (!expected || provided === undefined) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function authorizeUpgrade(headers: IncomingMessage["headers"], expected: string): boolean {
  return tokensMatch(tokenFromHeaders(headers), expected);
}

function echoIds(req: Record<string, unknown>, res: Record<string, unknown>): Record<string, unknown> {
  const out = { ...res };
  if (req.req_id !== undefined && out.req_id === undefined) out.req_id = req.req_id;
  if (req.id !== undefined && out.id === undefined) out.id = req.id;
  return out;
}

function rejectHttp(socket: { write: (s: string) => void; destroy: () => void }, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function attachSocket(
  ws: WebSocket,
  dispatch: DispatchFn,
  onEvent: OnEvent,
): void {
  let watching = false;
  let filterId: string | null = null;
  const off = onEvent((sessionId, event) => {
    if (!watching) return;
    if (filterId !== null && filterId !== sessionId) return;
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "event", id: sessionId, event }));
  });

  ws.on("close", () => {
    watching = false;
    off();
  });

  ws.on("message", async (data, isBinary) => {
    if (isBinary) {
      ws.send(JSON.stringify({ ok: false, error: "binary unused" }));
      return;
    }
    const text = typeof data === "string" ? data : data.toString("utf8");
    let req: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        ws.send(JSON.stringify({ ok: false, error: "bad json: expected object" }));
        return;
      }
      req = parsed as Record<string, unknown>;
    } catch (exc: any) {
      ws.send(JSON.stringify({ ok: false, error: `bad json: ${exc?.message || exc}` }));
      return;
    }

    const cmd = String(req.cmd ?? "");
    if (cmd === "watch") {
      watching = true;
      filterId = typeof req.id === "string" && req.id ? req.id : null;
      ws.send(JSON.stringify(echoIds(req, { ok: true })));
      return;
    }
    if (cmd === "unwatch") {
      watching = false;
      filterId = null;
      const res: Record<string, unknown> = { ok: true };
      if (req.req_id !== undefined) res.req_id = req.req_id;
      ws.send(JSON.stringify(res));
      return;
    }

    let res: Record<string, unknown>;
    try {
      res = await dispatch(req);
    } catch (exc: any) {
      res = { ok: false, error: `${exc?.name || "Error"}: ${exc?.message || exc}` };
    }
    ws.send(JSON.stringify(echoIds(req, res)));
  });
}

export async function startWsServer(opts: {
  token: string;
  host: string;
  port: number;
  dispatch: DispatchFn;
  onEvent: OnEvent;
}): Promise<WsServerHandle> {
  const http = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== WS_PATH) {
      rejectHttp(socket, 404, "Not Found");
      return;
    }
    if (!authorizeUpgrade(req.headers, opts.token)) {
      rejectHttp(socket, 401, "Unauthorized");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachSocket(ws, opts.dispatch, opts.onEvent);
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host, () => resolve());
  });

  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  const host = typeof addr === "object" && addr ? addr.address : opts.host;

  return {
    host,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close();
        http.close(() => resolve());
      }),
  };
}
