/** Fold raw ClassifiedEvents into conversation rows. Does not mutate input. */

import { lastPathSeg } from "./depot-store";

export type FoldEvent = {
  kind: string;
  summary: string;
  extra?: Record<string, unknown> | null;
};

export type FoldedRow =
  | { type: "thinking"; n: number }
  | { type: "thinking_text"; text: string }
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool"; name: string; detail: string; input: Record<string, unknown> }
  | { type: "needs_decision"; text: string }
  | { type: "needs_info"; text: string }
  | { type: "failed"; text: string }
  | { type: "dead"; text: string }
  | { type: "task_done"; text: string }
  | { type: "system"; items: string[] };

const PLACEHOLDER = new Set([
  "assistant",
  "thinking_tokens",
  "init",
  "connected",
  "query sent",
  "commands_changed",
  "result message (turn, not task)",
  "turn complete, waiting",
  "interrupt",
  "lock=operator",
]);

const HIDE_SUMMARIES = new Set([
  "connected",
  "init",
  "query sent",
  "commands_changed",
]);

const HIDE_KINDS = new Set(["idle", "held", "interrupted"]);

const SILENT_SUMMARIES = new Set(["PreToolUse", "PostToolUse", "Stop hook", "Stop", "Object"]);

const SYSTEM_LABEL: Record<string, string> = {
  connected: "已连接",
  init: "初始化",
  "query sent": "已发送查询",
  commands_changed: "命令更新",
  idle: "空闲",
  held: "已挂起",
  interrupted: "已中断",
  PreToolUse: "工具前",
  PostToolUse: "工具后",
  PostToolUseFailure: "工具失败",
  "Stop hook": "停止钩子",
  Stop: "停止钩子",
  SubagentStart: "子代理开始",
  SubagentStop: "子代理结束",
  Notification: "通知",
  task_started: "任务开始",
  task_progress: "任务进度",
  task_updated: "任务更新",
  background_tasks_changed: "后台任务",
  Object: "系统",
};

function extraOf(e: FoldEvent): Record<string, unknown> {
  return e.extra && typeof e.extra === "object" && !Array.isArray(e.extra) ? e.extra : {};
}

function extraStr(extra: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = extra[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function extraNum(extra: Record<string, unknown>): number | undefined {
  for (const k of ["tokens", "n", "count", "thinking_tokens", "delta"]) {
    const v = extra[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

function extraType(extra: Record<string, unknown>): string {
  return String(extra.type ?? extra.block_type ?? "").toLowerCase();
}

function thinkingText(e: FoldEvent): string | undefined {
  const extra = extraOf(e);
  const t = extraType(extra);
  if (t === "thinking" || /thinking/i.test(e.summary || "")) {
    return extraStr(extra, ["text", "thinking", "content", "result"]);
  }
  return extraStr(extra, ["thinking"]);
}

export function isThinkingTick(e: FoldEvent): boolean {
  if (thinkingText(e)) return false;
  const extra = extraOf(e);
  const t = extraType(extra);
  const s = e.summary || "";
  return /thinking/i.test(s) || /thinking/i.test(t);
}

function isPlaceholderSummary(s: string): boolean {
  return PLACEHOLDER.has(s.trim());
}

function toolName(e: FoldEvent): string | undefined {
  const extra = extraOf(e);
  if (typeof extra.tool === "string" && extra.tool.trim()) return extra.tool;
  const m = /^(?:tool\s+)(.+)$/i.exec((e.summary || "").trim());
  if (m) return m[1].trim();
  return undefined;
}

function hookToolName(e: FoldEvent): string | undefined {
  const extra = extraOf(e);
  if (typeof extra.tool_name === "string" && extra.tool_name.trim()) return extra.tool_name;
  return undefined;
}

function isEmptyAssistant(e: FoldEvent): boolean {
  const extra = extraOf(e);
  const s = (e.summary || "").trim();
  if (s === "assistant" && !extraStr(extra, ["result", "text", "content"])) return true;
  return false;
}

function isSilent(e: FoldEvent): boolean {
  return HIDE_KINDS.has(e.kind) || isEmptyAssistant(e) || SILENT_SUMMARIES.has((e.summary || "").trim());
}

function inputOf(e: FoldEvent): Record<string, unknown> {
  const raw = extraOf(e).input;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

function pathOf(input: Record<string, unknown>): string {
  for (const k of ["file_path", "path"]) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

function headLine(s: string, max = 80): string {
  const line = s.split(/\r?\n/, 1)[0].replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max)}…`;
}

export function toolDetail(name: string, input: Record<string, unknown>): string {
  const path = pathOf(input);
  if (name === "Read" && path) return lastPathSeg(path);
  if ((name === "Write" || name === "Edit") && path) return path;
  if (name === "Bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    if (cmd) return headLine(cmd);
  }
  if (name === "Task" || name.startsWith("Task")) {
    for (const k of ["description", "subject", "summary", "prompt"]) {
      const v = input[k];
      if (typeof v === "string" && v.trim()) return headLine(v);
    }
  }
  return "";
}

function toolRow(name: string, e: FoldEvent): Extract<FoldedRow, { type: "tool" }> {
  const input = inputOf(e);
  return { type: "tool", name, detail: toolDetail(name, input), input };
}

function isNoise(e: FoldEvent): boolean {
  if (isSilent(e)) return true;
  const s = (e.summary || "").trim();
  if (HIDE_SUMMARIES.has(s)) return true;
  if (SYSTEM_LABEL[s]) return true;
  return false;
}

function systemLabel(e: FoldEvent): string {
  const s = (e.summary || "").trim();
  if (SYSTEM_LABEL[s]) return SYSTEM_LABEL[s];
  if (SYSTEM_LABEL[e.kind]) return SYSTEM_LABEL[e.kind];
  return s || e.kind;
}

function visibleText(e: FoldEvent, keys: string[]): string {
  return extraStr(extraOf(e), keys) || (isPlaceholderSummary(e.summary) ? "" : e.summary) || "";
}

export function decisionLabel(e: FoldEvent): string {
  const extra = extraOf(e);
  const s = (e.summary || "").trim();
  const named =
    toolName(e) ||
    hookToolName(e) ||
    /PermissionRequest\s+(\S+)/i.exec(s)?.[1] ||
    /can_use_tool parked\s+(\S+)/i.exec(s)?.[1] ||
    "";
  if (named) return `需要批准：${named}`;
  if (s === "ask" || extra.reason === "ask") return "需要批准";
  return visibleText(e, ["result", "text", "error"]) || s || "需要批准";
}

export function foldTranscript(events: readonly FoldEvent[]): FoldedRow[] {
  const rows: FoldedRow[] = [];
  let i = 0;
  while (i < events.length) {
    const e = events[i];

    if (isThinkingTick(e)) {
      let count = 0;
      let token: number | undefined;
      while (i < events.length && isThinkingTick(events[i])) {
        count += 1;
        const n = extraNum(extraOf(events[i]));
        if (n !== undefined) token = n;
        i += 1;
      }
      rows.push({ type: "thinking", n: token ?? count });
      continue;
    }

    const think = thinkingText(e);
    if (think) {
      rows.push({ type: "thinking_text", text: think });
      i += 1;
      continue;
    }

    if (e.kind === "sent") {
      rows.push({ type: "user", text: e.summary || extraStr(extraOf(e), ["text"]) || "" });
      i += 1;
      continue;
    }

    if (e.kind === "needs_decision" || e.kind === "needs_info" || e.kind === "failed" || e.kind === "dead") {
      const text =
        e.kind === "needs_decision"
          ? decisionLabel(e)
          : visibleText(e, ["result", "text", "error"]) || e.summary;
      rows.push({ type: e.kind, text });
      i += 1;
      continue;
    }

    if (e.kind === "task_done") {
      rows.push({ type: "task_done", text: visibleText(e, ["result", "text", "summary"]) || e.summary });
      i += 1;
      continue;
    }

    if (e.kind === "turn_done") {
      const text = extraStr(extraOf(e), ["result", "text"]) || (isPlaceholderSummary(e.summary) ? "" : e.summary);
      if (text) rows.push({ type: "assistant", text });
      i += 1;
      continue;
    }

    const tool = toolName(e);
    if (tool) {
      rows.push(toolRow(tool, e));
      i += 1;
      continue;
    }

    if (isNoise(e)) {
      const items: string[] = [];
      while (i < events.length && isNoise(events[i]) && !isThinkingTick(events[i]) && !thinkingText(events[i])) {
        if (!isSilent(events[i])) items.push(systemLabel(events[i]));
        i += 1;
      }
      if (items.length) rows.push({ type: "system", items });
      continue;
    }

    const extra = extraOf(e);
    const prose = extraStr(extra, ["result", "text"]) || (!isPlaceholderSummary(e.summary) ? e.summary : "");
    if (prose) {
      rows.push({ type: "assistant", text: prose });
      i += 1;
      continue;
    }

    const hookTool = hookToolName(e);
    if (hookTool) {
      rows.push(toolRow(hookTool, e));
      i += 1;
      continue;
    }

    rows.push({ type: "system", items: [systemLabel(e)] });
    i += 1;
  }
  return rows;
}
