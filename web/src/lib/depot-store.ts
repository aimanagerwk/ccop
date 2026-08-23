/** Browser persistence for the depot tagboard (servers + pinned cwds). */

export type DepotServer = {
  id: string;
  label: string;
  host: string;
  port: number;
  token: string;
};

export type DepotState = {
  servers: DepotServer[];
  pinnedCwds: Record<string, string[]>;
  collapsed: boolean;
};

const KEY = "ccop.depot.v1";

export function serverKey(host: string, port: number): string {
  const h = host.trim() || "127.0.0.1";
  return `s-${h.replace(/[^a-zA-Z0-9.-]/g, "_")}-${port}`;
}

export function emptyDepot(): DepotState {
  return { servers: [], pinnedCwds: {}, collapsed: false };
}

export function loadDepot(): DepotState {
  if (typeof window === "undefined") return emptyDepot();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return emptyDepot();
    const parsed = JSON.parse(raw) as DepotState;
    if (!parsed || !Array.isArray(parsed.servers)) return emptyDepot();
    return {
      servers: parsed.servers.filter(
        (s) => s && typeof s.id === "string" && typeof s.host === "string" && Number.isFinite(s.port),
      ),
      pinnedCwds: parsed.pinnedCwds && typeof parsed.pinnedCwds === "object" ? parsed.pinnedCwds : {},
      collapsed: Boolean(parsed.collapsed),
    };
  } catch {
    return emptyDepot();
  }
}

export function saveDepot(state: DepotState): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(state));
}

export function pinCwd(state: DepotState, serverId: string, cwd: string): DepotState {
  const cur = state.pinnedCwds[serverId] || [];
  if (cur.includes(cwd)) return state;
  return { ...state, pinnedCwds: { ...state.pinnedCwds, [serverId]: [...cur, cwd] } };
}

export function lastPathSeg(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

export function sessLabel(s: { title?: string | null; name?: string; id: string }): string {
  return s.title || s.name || s.id.slice(0, 8);
}
