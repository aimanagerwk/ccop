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

export function rpc(
  cmd: string,
  args: Record<string, unknown> = {},
  serverId?: string,
): Promise<Record<string, unknown>> {
  return postJson("/api/rpc", serverId ? { cmd, ...args, serverId } : { cmd, ...args });
}

export type HealthServer = {
  id: string;
  host: string;
  port: number;
  connected: boolean;
};

export type Health = {
  ok: boolean;
  connected: boolean;
  target: { host: string; port: number } | null;
  activeId: string | null;
  servers: HealthServer[];
};

export async function fetchHealth(): Promise<Health> {
  const r = await fetch("/api/health");
  const j = (await r.json()) as Health;
  return {
    ok: Boolean(j.ok),
    connected: Boolean(j.connected),
    target: j.target ?? null,
    activeId: j.activeId ?? null,
    servers: Array.isArray(j.servers) ? j.servers : [],
  };
}
