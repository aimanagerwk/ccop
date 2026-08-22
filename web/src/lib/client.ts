/** Browser helpers for the HTTP proxy. */

export async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, error: text || `http ${r.status}` };
  }
}

export function rpc(cmd: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return postJson("/api/rpc", { cmd, ...args });
}
