/** Fold raw ClassifiedEvents into conversation rows. Does not mutate input. */

import { lastPathSeg } from "./depot-store";

export type FoldEvent = {
  kind: string;
  summary: string;
  extra?: Record<string, unknown> | null;
  ts?: number;
};

export type FoldedRow =
  | { type: "thinking"; n: number; ts?: number }
  | { type: "thinking_text"; text: string; ts?: number }
  | { type: "user"; text: string; ts?: number }
  | { type: "assistant"; text: string; ts?: number }
  | {
      type: "tool";
      name: string;
      detail: string;
      input: Record<string, unknown>;
      tool_use_id?: string;
      output?: unknown;
      is_error?: boolean;
      ts?: number;
    }
  | { type: "needs_decision"; text: string; ts?: number }
  | { type: "needs_info"; text: string; ts?: number }
  | { type: "failed"; text: string; ts?: number }
  | { type: "dead"; text: string; ts?: number }
  | { type: "task_done"; text: string; ts?: number }
  | { type: "system"; items: string[]; ts?: number };

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

const SILENT_SUMMARIES = new Set(["PreToolUse", "PostToolUse", "Stop hook", "Stop", "Object", "tool_result"]);

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

function own(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function tsOf(e: FoldEvent): number | undefined {
  return typeof e.ts === "number" && Number.isFinite(e.ts) ? e.ts : undefined;
}

function withTs<T extends object>(row: T, ts?: number): T {
  return ts === undefined ? row : { ...row, ts };
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

function toolUseIdOf(extra: Record<string, unknown>): string {
  if (!own(extra, "tool_use_id")) return "";
  return typeof extra.tool_use_id === "string" ? extra.tool_use_id.trim() : "";
}

function hasAttachableOutput(extra: Record<string, unknown>): boolean {
  return own(extra, "tool_response") || own(extra, "tool_use_result") || own(extra, "content") || own(extra, "error");
}

function pickAttachedOutput(extra: Record<string, unknown>): unknown {
  if (own(extra, "tool_response")) return extra.tool_response;
  if (own(extra, "tool_use_result")) return extra.tool_use_result;
  if (own(extra, "content")) return extra.content;
  return extra.error;
}

function tryAttachToolOutput(
  e: FoldEvent,
  toolsById: Map<string, Extract<FoldedRow, { type: "tool" }>>,
): boolean {
  const extra = extraOf(e);
  if (!hasAttachableOutput(extra)) return false;
  const id = toolUseIdOf(extra);
  if (id) {
    const row = toolsById.get(id);
    if (row) {
      row.output = pickAttachedOutput(extra);
      if ((own(extra, "error") && extra.error !== undefined) || (own(extra, "is_error") && extra.is_error === true)) {
        row.is_error = true;
      }
    }
  }
  return true;
}

function toolRow(name: string, e: FoldEvent): Extract<FoldedRow, { type: "tool" }> {
  const input = inputOf(e);
  const id = toolUseIdOf(extraOf(e));
  return withTs(
    { type: "tool", name, detail: toolDetail(name, input), input, ...(id ? { tool_use_id: id } : {}) },
    tsOf(e),
  );
}

export const TOOL_OUTPUT_CLIP = 64_000;

export function clipToolText(text: string, max = TOOL_OUTPUT_CLIP): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function isNonTextBlock(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const t = (value as Record<string, unknown>).type;
  return t === "image" || t === "document" || t === "audio" || t === "video" || t === "base64";
}

function sanitizeToolOutput(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return clipToolText(value);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (depth > 8) return "[omitted]";
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (isNonTextBlock(item)) {
        return { type: item.type, omitted: true };
      }
      return sanitizeToolOutput(item, depth + 1);
    });
  }
  const rec = value as Record<string, unknown>;
  if (isNonTextBlock(rec)) return { type: rec.type, omitted: true };
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(rec)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if ((k === "data" || k === "source") && typeof v === "string" && v.length > 256) {
      out[k] = "[omitted]";
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = v as Record<string, unknown>;
      if (inner.type === "base64" || typeof inner.data === "string") {
        out[k] = {
          type: inner.type,
          media_type: inner.media_type,
          omitted: true,
        };
        continue;
      }
    }
    out[k] = sanitizeToolOutput(v, depth + 1);
  }
  return out;
}

function formatClippedToolOutput(output: unknown): string {
  if (typeof output === "string") return clipToolText(output);
  try {
    return clipToolText(JSON.stringify(sanitizeToolOutput(output), null, 2));
  } catch {
    return clipToolText(String(output));
  }
}

export function toolCardPresentation(
  input: Record<string, unknown>,
  output?: unknown | null,
): { open: boolean; inputText: string; outputText: string } {
  const hasInput = Object.keys(input).length > 0;
  const hasOutput = output !== undefined && output !== null;
  return {
    open: hasInput || hasOutput,
    inputText: formatClippedToolOutput(input),
    outputText: hasOutput ? formatClippedToolOutput(output) : "",
  };
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
  const toolsById = new Map<string, Extract<FoldedRow, { type: "tool" }>>();
  let i = 0;
  while (i < events.length) {
    const e = events[i];

    if (isThinkingTick(e)) {
      let count = 0;
      let token: number | undefined;
      const firstTs = tsOf(e);
      while (i < events.length && isThinkingTick(events[i])) {
        count += 1;
        const n = extraNum(extraOf(events[i]));
        if (n !== undefined) token = n;
        i += 1;
      }
      rows.push(withTs({ type: "thinking", n: token ?? count }, firstTs));
      continue;
    }

    const think = thinkingText(e);
    if (think) {
      rows.push(withTs({ type: "thinking_text", text: think }, tsOf(e)));
      i += 1;
      continue;
    }

    if (e.kind === "sent") {
      rows.push(withTs({ type: "user", text: e.summary || extraStr(extraOf(e), ["text"]) || "" }, tsOf(e)));
      i += 1;
      continue;
    }

    if (e.kind === "needs_decision" || e.kind === "needs_info" || e.kind === "failed" || e.kind === "dead") {
      const text =
        e.kind === "needs_decision"
          ? decisionLabel(e)
          : visibleText(e, ["result", "text", "error"]) || e.summary;
      rows.push(withTs({ type: e.kind, text }, tsOf(e)));
      i += 1;
      continue;
    }

    if (e.kind === "task_done") {
      rows.push(withTs({ type: "task_done", text: visibleText(e, ["result", "text", "summary"]) || e.summary }, tsOf(e)));
      i += 1;
      continue;
    }

    if (e.kind === "turn_done") {
      const text = extraStr(extraOf(e), ["result", "text"]) || (isPlaceholderSummary(e.summary) ? "" : e.summary);
      if (text) rows.push(withTs({ type: "assistant", text }, tsOf(e)));
      i += 1;
      continue;
    }

    const tool = toolName(e);
    if (tool) {
      const row = toolRow(tool, e);
      rows.push(row);
      if (row.tool_use_id) toolsById.set(row.tool_use_id, row);
      i += 1;
      continue;
    }

    if (tryAttachToolOutput(e, toolsById)) {
      i += 1;
      continue;
    }

    if (isNoise(e)) {
      const items: string[] = [];
      const firstTs = tsOf(e);
      while (i < events.length && isNoise(events[i]) && !isThinkingTick(events[i]) && !thinkingText(events[i])) {
        if (tryAttachToolOutput(events[i], toolsById)) {
          i += 1;
          continue;
        }
        if (!isSilent(events[i])) items.push(systemLabel(events[i]));
        i += 1;
      }
      if (items.length) rows.push(withTs({ type: "system", items }, firstTs));
      continue;
    }

    const extra = extraOf(e);
    const prose = extraStr(extra, ["result", "text"]) || (!isPlaceholderSummary(e.summary) ? e.summary : "");
    if (prose) {
      rows.push(withTs({ type: "assistant", text: prose }, tsOf(e)));
      i += 1;
      continue;
    }

    const hookTool = hookToolName(e);
    if (hookTool) {
      const row = toolRow(hookTool, e);
      rows.push(row);
      if (row.tool_use_id) toolsById.set(row.tool_use_id, row);
      i += 1;
      continue;
    }

    rows.push(withTs({ type: "system", items: [systemLabel(e)] }, tsOf(e)));
    i += 1;
  }
  return rows;
}
