/** HTTP upgrade fan-in for every connected daemon. */

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import type { BridgeHub } from "./bridge-hub";

function frameText(data: WebSocket.RawData, isBinary: boolean): string | null {
  if (isBinary) return null;
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function rejectHttp(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachWsHub(httpServer: HttpServer, hub: BridgeHub): () => void {
  const wss = new WebSocketServer({ noServer: true });
  const browsers = new Set<WebSocket>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/v1" && url.pathname !== "/api/ws") return;
    if (!hub.anyConnected()) {
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
        hub.primary().sendFrame(text);
      });
    });
  };

  const offFrame = hub.onAnyFrame((text) => {
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
