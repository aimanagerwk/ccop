import { getBridge } from "../../../lib/bridge-singleton";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const bridge = getBridge();
  if (!bridge.isConnected()) {
    return new Response(JSON.stringify({ ok: false, error: "not connected" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  const encoder = new TextEncoder();
  let off: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      off = bridge.watch((evt) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
        } catch {
          /* closed */
        }
      });
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: hb\n\n`));
        } catch {
          /* closed */
        }
      }, 15000);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (off) off();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
