/** Session tree-dot class from status. Idle is not dead. */

export type DotSession = {
  alive?: boolean;
  pending?: unknown[] | null;
  last_kind?: string;
  state?: string;
};

export function sessionDotClass(s: DotSession): string {
  if ((s.pending?.length ?? 0) > 0) return "warn";
  if (!s.alive) return "ended";
  const k = s.last_kind || s.state || "";
  if (k === "working") return "live";
  if (k === "failed") return "halt";
  return "idle";
}
