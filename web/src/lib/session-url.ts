/** Session deep-link helpers. Query is a projection of TreeSel — never a lookup key. */

export type SessionUrlSel = {
  serverId: string | null;
  sessionId: string | null;
};

/** RFC 4122-shaped Claude session UUID. Rejects names, titles, paths, javascript:. */
export function isClaudeSessionId(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  if (raw.length !== 36) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw);
}

/** Aligns with depot-store.serverKey: `s-<host>-<port>`. */
export function isDepotServerId(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  if (raw.length > 80) return false;
  return /^s-[a-zA-Z0-9._-]+-\d{1,5}$/.test(raw);
}

export function parseSessionUrl(search: string): SessionUrlSel {
  let raw = search;
  if (raw.startsWith("/")) {
    const q = raw.indexOf("?");
    raw = q >= 0 ? raw.slice(q + 1) : "";
  } else if (raw.startsWith("?")) {
    raw = raw.slice(1);
  }
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return { serverId: null, sessionId: null };
  }
  const s = params.get("s");
  const id = params.get("id");
  return {
    serverId: isDepotServerId(s) ? s : null,
    sessionId: isClaudeSessionId(id) ? id : null,
  };
}

export function buildSessionUrl(sel: SessionUrlSel, path = "/"): string {
  const serverId = isDepotServerId(sel.serverId) ? sel.serverId : null;
  const sessionId = isClaudeSessionId(sel.sessionId) ? sel.sessionId : null;
  const base = path || "/";
  if (!serverId && !sessionId) return base;
  const params = new URLSearchParams();
  if (serverId) params.set("s", serverId);
  if (sessionId) params.set("id", sessionId);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
