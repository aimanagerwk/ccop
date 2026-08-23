/** Shared WS / Host.dispatch types. Do not invent cmds or kinds. */

export const KINDS = [
  "working",
  "needs_decision",
  "needs_info",
  "turn_done",
  "task_done",
  "failed",
  "idle",
  "held",
  "dead",
  "sent",
  "interrupted",
] as const;

export type Kind = (typeof KINDS)[number];

/** Host.dispatch cmd names. watch/unwatch are WS-only. */
export const HOST_CMDS = [
  "ping",
  "start",
  "send",
  "interrupt",
  "hold",
  "release",
  "approve",
  "deny",
  "stop",
  "status",
  "events",
  "info",
  "workflows",
  "tasks",
  "task-stop",
  "task-bg",
  "subagents",
  "mcp",
  "mcp-set",
  "mcp-reconnect",
  "mcp-toggle",
  "plugins-reload",
  "skills-reload",
  "wait",
  "monitor",
  "shutdown",
] as const;

export type HostCmd = (typeof HOST_CMDS)[number];

export const WS_ONLY_CMDS = ["watch", "unwatch"] as const;

export type WsOnlyCmd = (typeof WS_ONLY_CMDS)[number];

export type WsCmd = HostCmd | WsOnlyCmd;

export type WsListen = { host: string; port: number };

export type PendingTool = {
  tool_use_id: string;
  tool?: string;
  reason?: string;
};

export type StatusMark = {
  kind: string;
  ts: number;
  summary: string;
};

/** Row from `status`. Extra disk fields may also be present. */
export type SessionRow = {
  id: string;
  name: string;
  title: string | null;
  cwd?: string;
  alive?: boolean;
  lock?: string | null;
  pending: PendingTool[];
  last_turn: StatusMark | null;
  last_task: StatusMark | null;
  cost_usd: number | null;
  sdk_session_id?: string;
  effort?: string;
  enable_workflows?: boolean;
  permission_mode?: string;
  skills?: string[];
  slash_commands?: string[];
  plugins?: unknown[];
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  model_usage?: unknown;
  usage?: unknown;
  last_error?: StatusMark | null;
  state?: string;
  last_kind?: string;
  /** Epoch seconds. Disk field from upsertSession, passed through status. */
  updated_ts?: number;
};

export type ClassifiedEvent = {
  ts: number;
  id: string;
  name?: string;
  kind: Kind;
  summary: string;
  extra: Record<string, unknown>;
};

export type WatchEvent = {
  type: "event";
  id: string;
  event: ClassifiedEvent;
};

export type WsRequest = {
  cmd: WsCmd;
  req_id?: unknown;
  id?: string;
  [k: string]: unknown;
};

export type WsReply = {
  ok: boolean;
  req_id?: unknown;
  error?: string;
  [k: string]: unknown;
};

let reqSeq = 0;

/** Monotonic request id. Not Date.now / Math.random. */
export function nextReqId(): number {
  reqSeq += 1;
  return reqSeq;
}

export function isWatchEvent(msg: unknown): msg is WatchEvent {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return false;
  const m = msg as { type?: unknown; id?: unknown; event?: unknown };
  return (
    m.type === "event" &&
    typeof m.id === "string" &&
    !!m.event &&
    typeof m.event === "object" &&
    !Array.isArray(m.event)
  );
}

export function isReply(msg: unknown): msg is WsReply {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return false;
  const m = msg as { type?: unknown; ok?: unknown };
  return m.type !== "event" && typeof m.ok === "boolean";
}

export type ToastPriority = "interrupt" | "badge" | "silent";

const INTERRUPT_KINDS: ReadonlySet<string> = new Set([
  "needs_decision",
  "needs_info",
  "failed",
  "dead",
]);
const BADGE_KINDS: ReadonlySet<string> = new Set(["turn_done", "task_done", "working"]);

/** Remote UI priority from WS.md §7. */
export function toastPriority(kind: string): ToastPriority {
  if (INTERRUPT_KINDS.has(kind)) return "interrupt";
  if (BADGE_KINDS.has(kind)) return "badge";
  return "silent";
}

export function encodeFrame(obj: unknown): string {
  return JSON.stringify(obj);
}

export function parseFrame(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("bad json: expected object");
  }
  return parsed as Record<string, unknown>;
}
