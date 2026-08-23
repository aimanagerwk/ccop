/** Pure snapshot of status / info / tasks / workflows / subagents + task_* events. */

import type { ClassifiedEvent, SessionRow } from "./protocol";
import {
  burnRate,
  cacheHit,
  modelCostPie,
  parseUsageHistory,
  tokenSpark,
  usageFreshness,
  type BurnRate,
  type CacheHit,
  type Freshness,
  type HistoryPoint,
  type ModelCostPie,
  type TokenSpark,
} from "./usage-viz";

export type TaskUsage = {
  total_tokens?: number;
  tool_uses?: number;
  duration_ms?: number;
};

export type TaskRow = {
  task_id: string;
  status: string;
  summary?: string;
  tool_use_id?: string;
  usage?: unknown;
};

export type SubagentRow = {
  agent_id: string;
  agent_type?: string;
  status: string;
};

export type MonitorTask = {
  task_id: string;
  status: string;
  live: boolean;
  summary: string;
  tool_use_id?: string;
  workflow_name?: string;
  task_type?: string;
  last_tool?: string;
  started_ts?: number;
  ended_ts?: number;
  duration_ms?: number;
  usage?: TaskUsage;
};

export type MonitorAgent = {
  agent_id: string;
  agent_type?: string;
  status: string;
  live: boolean;
};

export type MonitorProgress = {
  total: number;
  running: number;
  done: number;
  failed: number;
  agents_running: number;
  agents_total: number;
};

export type MonitorTokens = {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cost_usd: number | null;
};

export type MonitorContext = {
  used: number | null;
  input: number | null;
  cache_read: number | null;
  cache_creation: number | null;
};

export type MonitorModel = {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  cost_usd?: number;
};

export type MonitorAdvertise = {
  skills: string[];
  slash_commands: string[];
  plugins: unknown[];
  note?: string;
};

export type MonitorSnapshot = {
  session_id: string;
  alive: boolean;
  kind: string;
  enable_workflows: boolean | null;
  effort: string | null;
  progress: MonitorProgress;
  context: MonitorContext;
  tokens: MonitorTokens;
  tasks: MonitorTask[];
  agents: MonitorAgent[];
  models: MonitorModel[];
  advertise: MonitorAdvertise;
  pending: number;
  usage_updated_ts: number | null;
  usage_history: HistoryPoint[];
  freshness: Freshness;
  spark: TokenSpark;
  burn: BurnRate;
  cache: CacheHit;
  pie: ModelCostPie;
};

export type MonitorInput = {
  session: SessionRow;
  info?: Record<string, unknown> | null;
  tasks?: unknown;
  subagents?: unknown;
  workflows?: Record<string, unknown> | null;
  events?: ReadonlyArray<Pick<ClassifiedEvent, "kind" | "summary" | "extra" | "ts">>;
  now?: number;
};

const STATUS_ZH: Record<string, string> = {
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  killed: "已终止",
  stopped: "已停止",
  pending: "排队",
  background_gone: "已退出",
};

const LIVE_STATUS = new Set(["running", "pending"]);
const DONE_STATUS = new Set(["completed"]);
const FAIL_STATUS = new Set(["failed", "killed", "stopped"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function finiteNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function extraOf(e: { extra?: Record<string, unknown> | null }): Record<string, unknown> {
  return isRecord(e.extra) ? e.extra : {};
}

/** Epoch seconds. Accepts seconds or millisecond timestamps. */
function asEpochSec(v: unknown): number | undefined {
  const n = finiteNum(v);
  if (n === undefined) return undefined;
  return n > 1e12 ? n / 1000 : n;
}

export function parseTaskUsage(raw: unknown): TaskUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const out: TaskUsage = {};
  const total = finiteNum(raw.total_tokens);
  const uses = finiteNum(raw.tool_uses);
  const dur = finiteNum(raw.duration_ms);
  if (total !== undefined) out.total_tokens = total;
  if (uses !== undefined) out.tool_uses = uses;
  if (dur !== undefined) out.duration_ms = dur;
  return Object.keys(out).length ? out : undefined;
}

export function asTaskRows(raw: unknown): TaskRow[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.tasks) ? raw.tasks : [];
  const out: TaskRow[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const task_id = str(item.task_id);
    if (!task_id) continue;
    const row: TaskRow = { task_id, status: str(item.status) || "" };
    const summary = str(item.summary);
    const tool_use_id = str(item.tool_use_id);
    if (summary) row.summary = summary.split(/\r?\n/, 1)[0].slice(0, 160);
    if (tool_use_id) row.tool_use_id = tool_use_id;
    if ("usage" in item) row.usage = item.usage;
    out.push(row);
  }
  return out;
}

export function asSubagentRows(raw: unknown): SubagentRow[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.subagents) ? raw.subagents : [];
  const out: SubagentRow[] = [];
  for (const item of list) {
    if (typeof item === "string" && item.trim()) {
      out.push({ agent_id: item, status: "running" });
      continue;
    }
    if (!isRecord(item)) continue;
    const agent_id = str(item.agent_id);
    if (!agent_id) continue;
    const row: SubagentRow = { agent_id, status: str(item.status) || "running" };
    const agent_type = str(item.agent_type);
    if (agent_type) row.agent_type = agent_type;
    out.push(row);
  }
  return out;
}

export function taskStatusLabel(status: string): string {
  return STATUS_ZH[status] || status;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const sec = Math.floor(ms / 1000);
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  if (hours > 0) return `${hours} 小时 ${String(minutes).padStart(2, "0")} 分`;
  return `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

export function clipDisplay(text: string, max: number): string {
  if (max <= 1 || text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function liveDurationMs(task: Pick<MonitorTask, "live" | "started_ts" | "ended_ts" | "duration_ms">, nowMs: number): number | undefined {
  if (task.duration_ms !== undefined) return task.duration_ms;
  if (task.started_ts === undefined) return undefined;
  const endMs = task.ended_ts !== undefined ? task.ended_ts * 1000 : nowMs;
  const d = endMs - task.started_ts * 1000;
  return d >= 0 ? d : undefined;
}

export type ShareSeg = { key: string; label: string; n: number };

const KIND_ZH: Record<string, string> = {
  working: "工作中",
  needs_decision: "待决定",
  needs_info: "需补充",
  turn_done: "一轮结束",
  task_done: "任务完成",
  failed: "失败",
  idle: "空闲",
  held: "已挂起",
  dead: "已结束",
  sent: "已发送",
  interrupted: "已中断",
};

export function sessionKindLabel(kind: string): string {
  return KIND_ZH[kind] || kind;
}

export function formatClock(ts?: number): string {
  if (ts === undefined || !Number.isFinite(ts)) return "—";
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function positiveShares(rows: Array<{ key: string; label: string; n: number | null | undefined }>): ShareSeg[] {
  const out: ShareSeg[] = [];
  for (const r of rows) {
    const n = typeof r.n === "number" && Number.isFinite(r.n) ? r.n : 0;
    if (n > 0) out.push({ key: r.key, label: r.label, n });
  }
  return out;
}

export function progressShares(p: MonitorProgress): ShareSeg[] {
  return positiveShares([
    { key: "running", label: "进行中", n: p.running },
    { key: "done", label: "已完成", n: p.done },
    { key: "failed", label: "失败", n: p.failed },
  ]);
}

export function tokenShares(t: MonitorTokens): ShareSeg[] {
  return positiveShares([
    { key: "input", label: "输入", n: t.input_tokens },
    { key: "output", label: "输出", n: t.output_tokens },
    { key: "cache_read", label: "缓存读", n: t.cache_read_input_tokens },
    { key: "cache_creation", label: "缓存写", n: t.cache_creation_input_tokens },
  ]);
}

/** Merge cache read+write so a stacked bar stays at 3 series (all-pairs safe). */
export function tokenBarShares(t: MonitorTokens): ShareSeg[] {
  const cache =
    (typeof t.cache_read_input_tokens === "number" && Number.isFinite(t.cache_read_input_tokens)
      ? t.cache_read_input_tokens
      : 0) +
    (typeof t.cache_creation_input_tokens === "number" && Number.isFinite(t.cache_creation_input_tokens)
      ? t.cache_creation_input_tokens
      : 0);
  return positiveShares([
    { key: "input", label: "输入", n: t.input_tokens },
    { key: "output", label: "输出", n: t.output_tokens },
    { key: "cache", label: "缓存", n: cache || null },
  ]);
}

export type PctSeg = ShareSeg & { pct: number };

export function sharePercents(segs: ShareSeg[]): PctSeg[] {
  const clean = segs.filter((s) => typeof s.n === "number" && Number.isFinite(s.n) && s.n > 0);
  const total = clean.reduce((a, s) => a + s.n, 0);
  if (!total) return [];
  return clean.map((s) => ({ ...s, pct: (s.n / total) * 100 }));
}

function pickNum(info: Record<string, unknown> | null | undefined, session: SessionRow, key: keyof SessionRow): number | null {
  if (info && key in info) return finiteOrNull(info[key as string]);
  return finiteOrNull(session[key]);
}

function mergeUsage(prev: TaskUsage | undefined, next: unknown): TaskUsage | undefined {
  const parsed = parseTaskUsage(next);
  if (!parsed) return prev;
  return { ...prev, ...parsed };
}

function isLiveStatus(status: string): boolean {
  return LIVE_STATUS.has(status);
}

function ownFinite(row: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, k)) continue;
    const n = finiteNum(row[k]);
    if (n !== undefined) return n;
  }
  return undefined;
}

function modelsFrom(raw: unknown): MonitorModel[] {
  if (!isRecord(raw)) return [];
  const out: MonitorModel[] = [];
  for (const [model, row] of Object.entries(raw)) {
    if (model === "__proto__" || model === "constructor" || model === "prototype") continue;
    if (!isRecord(row)) continue;
    const cost = ownFinite(row, "costUSD", "cost_usd");
    out.push({
      model,
      input: ownFinite(row, "inputTokens", "input_tokens") ?? 0,
      output: ownFinite(row, "outputTokens", "output_tokens") ?? 0,
      cache_read: ownFinite(row, "cacheReadInputTokens", "cache_read_input_tokens") ?? 0,
      cache_creation: ownFinite(row, "cacheCreationInputTokens", "cache_creation_input_tokens") ?? 0,
      ...(cost !== undefined ? { cost_usd: cost } : {}),
    });
  }
  return out;
}

function stringsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

export function buildMonitorSnapshot(input: MonitorInput): MonitorSnapshot {
  const session = input.session;
  const info = isRecord(input.info) ? input.info : null;
  const workflows = isRecord(input.workflows) ? input.workflows : null;
  const events = input.events || [];
  const now = input.now ?? 0;

  const byId = new Map<string, MonitorTask>();
  for (const row of asTaskRows(input.tasks)) {
    const usage = parseTaskUsage(row.usage);
    byId.set(row.task_id, {
      task_id: row.task_id,
      status: row.status,
      live: isLiveStatus(row.status),
      summary: row.summary || "",
      ...(row.tool_use_id ? { tool_use_id: row.tool_use_id } : {}),
      ...(usage ? { usage, ...(usage.duration_ms !== undefined ? { duration_ms: usage.duration_ms } : {}) } : {}),
    });
  }

  const agents = new Map<string, MonitorAgent>();
  for (const row of asSubagentRows(input.subagents)) {
    agents.set(row.agent_id, {
      agent_id: row.agent_id,
      status: row.status,
      live: isLiveStatus(row.status),
      ...(row.agent_type ? { agent_type: row.agent_type } : {}),
    });
  }

  for (const e of events) {
    const extra = extraOf(e);
    const summary = (e.summary || "").trim();
    const taskId = str(extra.task_id);
    if (taskId) {
      const prev = byId.get(taskId) || {
        task_id: taskId,
        status: "",
        live: false,
        summary: "",
      };
      if (summary === "task_started") {
        prev.status = prev.status || "running";
        prev.started_ts = asEpochSec(e.ts) ?? prev.started_ts;
        const wf = str(extra.workflow_name);
        const typ = str(extra.task_type);
        const tool = str(extra.tool_use_id);
        const desc = str(extra.description);
        if (wf) prev.workflow_name = wf;
        if (typ) prev.task_type = typ;
        if (tool) prev.tool_use_id = tool;
        if (desc && !prev.summary) prev.summary = desc;
      } else if (summary === "task_progress") {
        const desc = str(extra.description);
        const last = str(extra.last_tool_name);
        if (desc) prev.summary = prev.summary || desc;
        if (last) prev.last_tool = last;
        prev.usage = mergeUsage(prev.usage, extra.usage);
        if (prev.usage?.duration_ms !== undefined) prev.duration_ms = prev.usage.duration_ms;
        if (!prev.status) prev.status = "running";
      } else if (summary === "task_updated") {
        const patch = isRecord(extra.patch) ? extra.patch : {};
        const st = str(patch.status);
        if (st) prev.status = st;
        const end = asEpochSec(patch.end_time);
        if (end !== undefined) prev.ended_ts = end;
        const desc = str(patch.description) || str(patch.error);
        if (desc) prev.summary = desc;
      } else if (e.kind === "task_done" || str(extra.status) === "completed") {
        prev.status = str(extra.status) || prev.status || "completed";
        prev.usage = mergeUsage(prev.usage, extra.usage);
        if (prev.usage?.duration_ms !== undefined) prev.duration_ms = prev.usage.duration_ms;
      }
      prev.live = isLiveStatus(prev.status);
      if (prev.started_ts !== undefined && prev.ended_ts !== undefined && prev.duration_ms === undefined) {
        const d = (prev.ended_ts - prev.started_ts) * 1000;
        if (d >= 0) prev.duration_ms = d;
      }
      byId.set(taskId, prev);
    }

    if (summary === "SubagentStart") {
      const id = str(extra.agent_id);
      if (id) {
        const prev = agents.get(id) || { agent_id: id, status: "running", live: true };
        const typ = str(extra.agent_type);
        if (typ) prev.agent_type = typ;
        prev.status = "running";
        prev.live = true;
        agents.set(id, prev);
      }
    } else if (summary === "SubagentStop") {
      const id = str(extra.agent_id);
      if (id) {
        const prev = agents.get(id) || { agent_id: id, status: "stopped", live: false };
        prev.status = "stopped";
        prev.live = false;
        agents.set(id, prev);
      }
    }
  }

  const tasks = [...byId.values()];
  if (now) {
    for (const t of tasks) {
      if (t.live && t.duration_ms === undefined) {
        const live = liveDurationMs(t, now);
        if (live !== undefined) t.duration_ms = live;
      }
    }
  }

  const agentList = [...agents.values()];
  const progress: MonitorProgress = {
    total: tasks.length,
    running: tasks.filter((t) => t.live).length,
    done: tasks.filter((t) => DONE_STATUS.has(t.status)).length,
    failed: tasks.filter((t) => FAIL_STATUS.has(t.status)).length,
    agents_running: agentList.filter((a) => a.live).length,
    agents_total: agentList.length,
  };

  const tokens: MonitorTokens = {
    input_tokens: pickNum(info, session, "input_tokens"),
    output_tokens: pickNum(info, session, "output_tokens"),
    cache_read_input_tokens: pickNum(info, session, "cache_read_input_tokens"),
    cache_creation_input_tokens: pickNum(info, session, "cache_creation_input_tokens"),
    cost_usd: pickNum(info, session, "cost_usd"),
  };

  const parts = [tokens.input_tokens, tokens.cache_read_input_tokens, tokens.cache_creation_input_tokens];
  const context: MonitorContext = {
    used: parts.every((n) => n === null) ? null : parts.reduce<number>((a, n) => a + (n || 0), 0),
    input: tokens.input_tokens,
    cache_read: tokens.cache_read_input_tokens,
    cache_creation: tokens.cache_creation_input_tokens,
  };

  const modelRaw = (info && "model_usage" in info ? info.model_usage : undefined) ?? session.model_usage;
  const skills = stringsOf(workflows?.skills ?? info?.skills ?? session.skills);
  const slash = stringsOf(workflows?.slash_commands ?? info?.slash_commands ?? session.slash_commands);
  const plugins = Array.isArray(workflows?.plugins)
    ? workflows!.plugins
    : Array.isArray(info?.plugins)
      ? info!.plugins
      : Array.isArray(session.plugins)
        ? session.plugins
        : [];

  const enable =
    info && "enable_workflows" in info
      ? info.enable_workflows === true
      : typeof session.enable_workflows === "boolean"
        ? session.enable_workflows
        : null;
  const effort = str(info?.effort) || str(session.effort) || null;
  const usage_updated_ts =
    info && "usage_updated_ts" in info ? finiteOrNull(info.usage_updated_ts) : finiteOrNull(session.usage_updated_ts);
  const usage_history = parseUsageHistory(info && "usage_history" in info ? info.usage_history : undefined);
  const freshness = usageFreshness({
    usage_updated_ts,
    last_kind: str(session.last_kind) || str(session.state) || "",
  });
  const spark = tokenSpark(usage_history, freshness);
  const burn = burnRate(usage_history, freshness);
  const cache = cacheHit(usage_history, freshness);
  const models = modelsFrom(modelRaw);
  const pie = modelCostPie(models, freshness);

  return {
    session_id: session.id,
    alive: Boolean(session.alive),
    kind: str(session.last_kind) || str(session.state) || "",
    enable_workflows: enable,
    effort,
    progress,
    context,
    tokens,
    tasks,
    agents: agentList,
    models,
    advertise: {
      skills,
      slash_commands: slash,
      plugins,
      ...(str(workflows?.note) ? { note: str(workflows?.note) } : {}),
    },
    pending: session.pending?.length ?? 0,
    usage_updated_ts,
    usage_history,
    freshness,
    spark,
    burn,
    cache,
    pie,
  };
}
