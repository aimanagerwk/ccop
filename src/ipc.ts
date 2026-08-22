/** Unix-socket JSON request/response. */

import { createConnection } from "node:net";
import { SOCK_PATH } from "./paths.js";

export function sendReq(req: Record<string, unknown>, timeout = 30): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(SOCK_PATH);
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      sock.destroy();
      if (!settled) {
        settled = true;
        reject(new Error("timeout"));
      }
    }, timeout * 1000);
    sock.on("connect", () => {
      sock.write(JSON.stringify(req) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.includes("\n")) {
        clearTimeout(timer);
        sock.end();
        if (!settled) {
          settled = true;
          const raw = buf;
          if (!raw.trim()) resolve({ ok: false, error: "empty daemon response" });
          else resolve(JSON.parse(raw));
        }
      }
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    sock.on("end", () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        if (!buf.trim()) resolve({ ok: false, error: "empty daemon response" });
        else {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(e);
          }
        }
      }
    });
  });
}

export async function ping(): Promise<boolean> {
  try {
    const r = await sendReq({ cmd: "ping" }, 2);
    return Boolean(r.ok);
  } catch {
    return false;
  }
}
