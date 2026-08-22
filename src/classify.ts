/** P2/P6 event classifier. Pure functions — unit-tested, no live API. */

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

export type Event = {
  kind: Kind;
  summary: string;
  extra: Record<string, unknown>;
};

function ev(kind: Kind, summary: string, extra?: Record<string, unknown> | null): Event {
  if (!KINDS.includes(kind)) throw new Error(`unknown kind ${kind}`);
  return { kind, summary, extra: extra || {} };
}

export function fromResult(args: {
  is_error: boolean;
  session_id?: string | null;
  result?: string | null;
}): Event[] {
  const extra = {
    session_id: args.session_id ?? null,
    result: args.result ?? null,
    is_error: args.is_error,
  };
  const out = [ev("turn_done", "result message (turn, not task)", extra)];
  if (args.is_error) out.push(ev("failed", "result is_error", extra));
  else out.push(ev("idle", "turn complete, waiting", extra));
  return out;
}

export function fromTaskNotification(args: {
  status: string;
  summary?: string;
  task_id?: string;
}): Event[] {
  const extra = { status: args.status, task_id: args.task_id || "" };
  const st = (args.status || "").toLowerCase();
  if (st === "completed") return [ev("task_done", args.summary || "task completed", extra)];
  if (st === "failed" || st === "killed") return [ev("failed", args.summary || `task ${st}`, extra)];
  if (st === "stopped") return [ev("interrupted", args.summary || "task stopped", extra)];
  return [ev("working", args.summary || `task ${st}`, extra)];
}

export function fromToolUse(args: {
  name: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown> | null;
}): Event[] {
  const extra = {
    tool: args.name,
    tool_use_id: args.tool_use_id || "",
    input: args.tool_input || {},
  };
  if (args.name === "AskUserQuestion") {
    return [
      ev("needs_info", "AskUserQuestion", extra),
      ev("needs_decision", "AskUserQuestion parked", extra),
    ];
  }
  return [ev("working", `tool ${args.name}`, extra)];
}

export function fromPermissionRequest(args: { tool_name: string; tool_use_id?: string }): Event[] {
  const extra = { tool: args.tool_name, tool_use_id: args.tool_use_id || "" };
  return [ev("needs_decision", `PermissionRequest ${args.tool_name}`, extra)];
}

export function fromParkedCanUseTool(args: {
  tool_name: string;
  tool_use_id?: string;
  reason?: string;
}): Event[] {
  const extra = {
    tool: args.tool_name,
    tool_use_id: args.tool_use_id || "",
    reason: args.reason || "ask",
  };
  const evs = [ev("needs_decision", `can_use_tool parked ${args.tool_name}`, extra)];
  if (args.tool_name === "AskUserQuestion") {
    evs.unshift(ev("needs_info", "AskUserQuestion", extra));
  }
  return evs;
}

export function fromProcessDeath(args?: { error?: string }): Event[] {
  const error = args?.error || "";
  const extra = { error };
  return [ev("failed", error || "process death", extra), ev("dead", "receive loop ended", extra)];
}

export function fromSent(args?: { text?: string }): Event[] {
  return [ev("sent", (args?.text || "").slice(0, 200), {})];
}

export function fromInterrupted(): Event[] {
  return [ev("interrupted", "interrupt", {})];
}

export function fromHeld(): Event[] {
  return [ev("held", "lock=operator", {})];
}

export function fromHook(hookEventName: string, payload?: Record<string, unknown> | null): Event[] {
  const p = payload || {};
  const name = hookEventName;
  const extra: Record<string, unknown> = { hook: name };
  if ("tool_name" in p) extra.tool_name = p.tool_name;
  if ("tool_use_id" in p) extra.tool_use_id = p.tool_use_id;
  if (name === "PermissionRequest") {
    return fromPermissionRequest({
      tool_name: String(p.tool_name || ""),
      tool_use_id: String(p.tool_use_id || ""),
    });
  }
  if (name === "PostToolUseFailure") {
    return [ev("working", `PostToolUseFailure ${p.tool_name || ""}`, extra)];
  }
  if (name === "PreToolUse" || name === "PostToolUse" || name === "SubagentStart" || name === "Notification") {
    return [ev("working", name, extra)];
  }
  if (name === "Stop") return [ev("working", "Stop hook", extra)];
  if (name === "SubagentStop") return [ev("working", "SubagentStop", extra)];
  return [ev("working", name, extra)];
}
