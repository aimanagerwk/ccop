/** Pure DAG of observed local_workflow tasks. No journal, no invented parents. */

import type { ClassifiedEvent } from "./protocol";
import {
  asEpochSec,
  formatClock,
  liveDurationMs,
  parseTaskUsage,
  type MonitorAgent,
  type MonitorSnapshot,
  type MonitorTask,
  type TaskUsage,
} from "./workflow-monitor";

export type DagKind = "workflow" | "phase" | "agent";
export type DagStatusTone = "running" | "done" | "failed";
export type DagSeries = "series-1" | "series-2" | "series-3" | "other";
export type DagEdgeKind = "succeeds";

export type DagNode = {
  id: string;
  kind: DagKind;
  ref_id: string;
  label: string;
  status: string;
  status_tone?: DagStatusTone;
  live: boolean;
  track_id?: string;
  workflow_name?: string;
  task_type?: string;
  tool_use_id?: string;
  last_tool?: string;
  lane_id?: string;
  agent_type?: string;
  start_ts?: number;
  end_ts?: number;
  duration_ms?: number;
  usage?: TaskUsage;
  series?: DagSeries;
};

export type DagEdge = {
  id: string;
  from: string;
  to: string;
  kind: DagEdgeKind;
};

export type DagTrack = {
  track_id: string;
  workflow_name?: string;
  tool_use_id?: string;
  start_ts?: number;
  end_ts?: number;
  status: string;
  live: boolean;
  series: DagSeries;
  node_id: string;
  lane_ids: string[];
};

export type DagLane = {
  lane_id: string;
  agent_type?: string;
  status: string;
  live: boolean;
  start_ts?: number;
  end_ts?: number;
  track_id?: string;
  series: DagSeries;
  node_id: string;
};

export type DagGraph = {
  session_id: string;
  nodes: DagNode[];
  edges: DagEdge[];
  tracks: DagTrack[];
  lanes: DagLane[];
  domain: { start_ts?: number; end_ts?: number };
};

export type DagEvent = Pick<ClassifiedEvent, "kind" | "summary" | "extra" | "ts">;

export type DagInput = {
  snapshot: MonitorSnapshot;
  events?: ReadonlyArray<DagEvent>;
  now?: number;
};

const DONE_STATUS = new Set(["completed"]);
const FAIL_STATUS = new Set(["failed", "killed", "stopped"]);
const RUN_STATUS = new Set(["running", "pending"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function extraOf(e: { extra?: Record<string, unknown> | null }): Record<string, unknown> {
  return isRecord(e.extra) ? e.extra : {};
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0];
}

function statusTone(status: string): DagStatusTone | undefined {
  if (RUN_STATUS.has(status)) return "running";
  if (DONE_STATUS.has(status)) return "done";
  if (FAIL_STATUS.has(status)) return "failed";
  return undefined;
}

function workflowToolUseIds(events: ReadonlyArray<DagEvent>): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    const extra = extraOf(e);
    const id = str(extra.tool_use_id);
    if (!id) continue;
    const tool = str(extra.tool);
    const summary = (e.summary || "").trim();
    if (tool === "Workflow" || summary === "tool Workflow") ids.add(id);
  }
  return ids;
}

function isWorkflowTask(task: MonitorTask, wfTools: Set<string>): boolean {
  if (task.task_type === "local_workflow") return true;
  if (str(task.workflow_name)) return true;
  if (task.tool_use_id && wfTools.has(task.tool_use_id)) return true;
  return false;
}

function workflowNode(task: MonitorTask, now?: number): DagNode | null {
  const taskId = str(task.task_id);
  if (!taskId) return null;
  const label = str(task.workflow_name) || (task.summary ? firstLine(task.summary) : "") || taskId;
  const tone = statusTone(task.status);
  const start = asEpochSec(task.started_ts);
  const end = asEpochSec(task.ended_ts);
  const usage = parseTaskUsage(task.usage);
  const duration =
    task.duration_ms !== undefined
      ? task.duration_ms
      : liveDurationMs({ live: task.live, started_ts: start, ended_ts: end, duration_ms: task.duration_ms }, now ?? 0);
  const node: DagNode = {
    id: `wf:${taskId}`,
    kind: "workflow",
    ref_id: taskId,
    label,
    status: task.status,
    live: Boolean(task.live),
    track_id: taskId,
  };
  if (tone) node.status_tone = tone;
  const wf = str(task.workflow_name);
  if (wf) node.workflow_name = wf;
  if (task.task_type === "local_workflow") node.task_type = "local_workflow";
  const tool = str(task.tool_use_id);
  if (tool) node.tool_use_id = tool;
  const last = str(task.last_tool);
  if (last) node.last_tool = last;
  if (start !== undefined) node.start_ts = start;
  if (end !== undefined) node.end_ts = end;
  if (duration !== undefined) node.duration_ms = duration;
  if (usage) node.usage = usage;
  return node;
}

function kindRank(kind: DagKind): number {
  if (kind === "workflow") return 0;
  if (kind === "agent") return 1;
  return 2;
}

function compareNodes(a: DagNode, b: DagNode, order?: Map<string, number>): number {
  const kr = kindRank(a.kind) - kindRank(b.kind);
  if (kr) return kr;
  const aStart = a.start_ts;
  const bStart = b.start_ts;
  if (aStart === undefined && bStart !== undefined) return 1;
  if (aStart !== undefined && bStart === undefined) return -1;
  if (aStart !== undefined && bStart !== undefined && aStart !== bStart) return aStart - bStart;
  if (order && a.kind === "agent" && b.kind === "agent") {
    const ai = order.get(a.ref_id) ?? Number.POSITIVE_INFINITY;
    const bi = order.get(b.ref_id) ?? Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai - bi;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function succeedsEdges(workflowNodes: DagNode[]): DagEdge[] {
  const ordered = [...workflowNodes].sort((a, b) => {
    const aStart = a.start_ts;
    const bStart = b.start_ts;
    if (aStart === undefined && bStart !== undefined) return 1;
    if (aStart !== undefined && bStart === undefined) return -1;
    if (aStart !== undefined && bStart !== undefined && aStart !== bStart) return aStart - bStart;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const edges: DagEdge[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < ordered.length - 1; i++) {
    const from = ordered[i];
    const to = ordered[i + 1];
    if (!from.end_ts || to.start_ts === undefined) continue;
    if (from.end_ts > to.start_ts) continue;
    if (from.id === to.id) continue;
    const id = `succeeds:${from.id}->${to.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push({ id, from: from.id, to: to.id, kind: "succeeds" });
  }
  edges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  return edges;
}

export type SwimlaneInput = {
  tasks: MonitorTask[];
  agents: MonitorAgent[];
  events?: ReadonlyArray<DagEvent>;
  now?: number;
};

export type SwimlaneColorClass = "series-1" | "series-2" | "series-3" | "other";

export type AssignedLane = {
  lane_id: string;
  agent_type?: string;
  group_key: string;
  lane_index: number;
  color_class: SwimlaneColorClass;
  y_top: number;
  y_h: 22;
  y_mid: number;
  overflow?: boolean;
  overflow_n?: number;
};

export type AssignedTrackBand = {
  track_id: string;
  workflow_name?: string;
  y_top: number;
  height: number;
  overflow_n: number;
};

export type AssignedWorkflowBand = {
  workflow_key: string;
  y_top: number;
  height: number;
  track_ids: string[];
};

export type SwimlaneLayout = {
  lanes: AssignedLane[];
  tracks: AssignedTrackBand[];
  workflows: AssignedWorkflowBand[];
  height: number;
};

const SERIES: SwimlaneColorClass[] = ["series-1", "series-2", "series-3"];
const PAD_TOP = 8;
const WF_HEAD = 22;
const TRACK_HEAD = 22;
const LANE_H = 22;
const LANE_GAP = 2;
const TRACK_GAP = 8;
const WF_GAP = 12;
const PAD_BOTTOM = 8;
const MAX_VISIBLE_LANES = 8;

type AgentAcc = {
  agent_id: string;
  agent_type?: string;
  status: string;
  live: boolean;
  start_ts?: number;
  end_ts?: number;
};

function isDroppedAgentType(t?: string): boolean {
  return t === "Explore" || t === "general-purpose" || t === "local_agent";
}

function isUsableAgentId(id: string | undefined): id is string {
  return !!id && id !== "__proto__" && id !== "prototype";
}

function seriesSlot(index: number): DagSeries {
  return SERIES[index] || "other";
}

function nowSecOf(now?: number): number | undefined {
  const n = asEpochSec(now);
  if (n === undefined || n < 1e9) return undefined;
  return n;
}

function windowContains(ts: number | undefined, start?: number, end?: number, now?: number): boolean {
  if (ts === undefined || start === undefined) return false;
  const close = end ?? now;
  if (close === undefined) return false;
  return ts >= start && ts <= close;
}

function collectAgents(snapshotAgents: ReadonlyArray<MonitorAgent> | undefined, events: ReadonlyArray<DagEvent>): Map<string, AgentAcc> {
  const byId = new Map<string, AgentAcc>();
  for (const e of events) {
    const summary = (e.summary || "").trim();
    if (summary !== "SubagentStart" && summary !== "SubagentStop") continue;
    const extra = extraOf(e);
    const id = str(extra.agent_id);
    if (!isUsableAgentId(id)) continue;
    const prev = byId.get(id) || {
      agent_id: id,
      status: summary === "SubagentStart" ? "running" : "stopped",
      live: summary === "SubagentStart",
    };
    const typ = str(extra.agent_type);
    if (typ) prev.agent_type = typ;
    const ts = asEpochSec(e.ts);
    if (summary === "SubagentStart") {
      prev.status = "running";
      prev.live = true;
      if (ts !== undefined && prev.start_ts === undefined) prev.start_ts = ts;
    } else {
      prev.status = "stopped";
      prev.live = false;
      if (ts !== undefined && prev.end_ts === undefined) prev.end_ts = ts;
    }
    byId.set(id, prev);
  }
  for (const a of snapshotAgents || []) {
    const id = str(a.agent_id);
    if (!isUsableAgentId(id)) continue;
    const prev = byId.get(id) || { agent_id: id, status: a.status || "running", live: Boolean(a.live) };
    const typ = str(a.agent_type);
    if (typ && !prev.agent_type) prev.agent_type = typ;
    if (a.status) {
      prev.status = a.status;
      prev.live = Boolean(a.live);
    } else if (!byId.has(id)) {
      prev.live = Boolean(a.live);
    }
    byId.set(id, prev);
  }
  return byId;
}

function firstSeenAgentIds(events: ReadonlyArray<DagEvent>, snapshotAgents: ReadonlyArray<MonitorAgent> | undefined): string[] {
  const starts: Array<{ id: string; ts: number }> = [];
  const stops: Array<{ id: string; ts: number }> = [];
  for (const e of events) {
    const summary = (e.summary || "").trim();
    const extra = extraOf(e);
    const id = str(extra.agent_id);
    if (!isUsableAgentId(id)) continue;
    const ts = asEpochSec(e.ts);
    const t = ts === undefined ? Number.POSITIVE_INFINITY : ts;
    if (summary === "SubagentStart") starts.push({ id, ts: t });
    else if (summary === "SubagentStop") stops.push({ id, ts: t });
  }
  const cmp = (a: { id: string; ts: number }, b: { id: string; ts: number }) =>
    a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  starts.sort(cmp);
  stops.sort(cmp);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of starts) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s.id);
  }
  for (const s of stops) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s.id);
  }
  for (const a of snapshotAgents || []) {
    const id = str(a.agent_id);
    if (!isUsableAgentId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function includeInGraph(a: AgentAcc, hasWorkflow: boolean): boolean {
  if (isDroppedAgentType(a.agent_type)) return false;
  if (a.agent_type === "workflow-subagent") return true;
  if (!a.agent_type) return hasWorkflow;
  return false;
}

function includeInLanes(a: AgentAcc): boolean {
  if (isDroppedAgentType(a.agent_type)) return false;
  if (a.agent_type === "workflow-subagent") return true;
  return !a.agent_type;
}

function joinTrackId(
  agent: Pick<AgentAcc, "start_ts" | "end_ts">,
  workflows: Array<Pick<DagNode, "ref_id" | "start_ts" | "end_ts">>,
  now?: number,
): string | undefined {
  const ts = agent.start_ts ?? agent.end_ts;
  const hits: string[] = [];
  for (const w of workflows) {
    if (windowContains(ts, w.start_ts, w.end_ts, now)) hits.push(w.ref_id);
  }
  return hits.length === 1 ? hits[0] : undefined;
}

function agentNode(a: AgentAcc, trackId: string | undefined, series: DagSeries): DagNode {
  const tone = statusTone(a.status);
  const node: DagNode = {
    id: `ag:${a.agent_id}`,
    kind: "agent",
    ref_id: a.agent_id,
    label: a.agent_id,
    status: a.status,
    live: a.live,
    lane_id: a.agent_id,
    series,
  };
  if (tone) node.status_tone = tone;
  if (a.agent_type) node.agent_type = a.agent_type;
  if (a.start_ts !== undefined) node.start_ts = a.start_ts;
  if (a.end_ts !== undefined) node.end_ts = a.end_ts;
  if (trackId) node.track_id = trackId;
  return node;
}

function agentLane(a: AgentAcc, trackId: string | undefined, series: DagSeries): DagLane {
  const lane: DagLane = {
    lane_id: a.agent_id,
    status: a.status,
    live: a.live,
    series,
    node_id: `ag:${a.agent_id}`,
  };
  if (a.agent_type) lane.agent_type = a.agent_type;
  if (a.start_ts !== undefined) lane.start_ts = a.start_ts;
  if (a.end_ts !== undefined) lane.end_ts = a.end_ts;
  if (trackId) lane.track_id = trackId;
  return lane;
}

function trackHeight(n: number): number {
  return TRACK_HEAD + n * LANE_H + Math.max(0, n - 1) * LANE_GAP;
}

function workflowKeyOf(task: MonitorTask): string {
  return str(task.workflow_name) || "_unnamed";
}

export function assignSwimlanes(input: SwimlaneInput): SwimlaneLayout {
  const events = input.events || [];
  const now = nowSecOf(input.now);
  const wfTools = workflowToolUseIds(events);
  const wfTasks = (input.tasks || []).filter((t) => isWorkflowTask(t, wfTools) && str(t.task_id));
  const collected = collectAgents(input.agents, events);
  const order = firstSeenAgentIds(events, input.agents);
  const color = new Map<string, SwimlaneColorClass>();
  order.forEach((id, i) => color.set(id, seriesSlot(i)));

  const windows = wfTasks.map((t) => ({
    ref_id: t.task_id,
    start_ts: asEpochSec(t.started_ts),
    end_ts: asEpochSec(t.ended_ts),
    workflow_name: str(t.workflow_name),
  }));

  type LaneAcc = AgentAcc & { track_id?: string; color: SwimlaneColorClass };
  const included: LaneAcc[] = [];
  for (const id of order) {
    const a = collected.get(id);
    if (!a || !includeInLanes(a)) continue;
    const track = joinTrackId(a, windows, now);
    included.push({ ...a, ...(track ? { track_id: track } : {}), color: color.get(id) || "other" });
  }

  const byTrack = new Map<string, LaneAcc[]>();
  const ungrouped: LaneAcc[] = [];
  for (const a of included) {
    if (a.track_id) {
      const list = byTrack.get(a.track_id) || [];
      list.push(a);
      byTrack.set(a.track_id, list);
    } else {
      ungrouped.push(a);
    }
  }

  const groups: Array<{ key: string; tracks: Array<{ track_id: string; workflow_name?: string; lanes: LaneAcc[] }> }> = [];
  const grouped = new Map<string, MonitorTask[]>();
  const wfOrder: string[] = [];
  const sortedWf = [...wfTasks].sort((a, b) => {
    const as = asEpochSec(a.started_ts);
    const bs = asEpochSec(b.started_ts);
    if (as === undefined && bs !== undefined) return 1;
    if (as !== undefined && bs === undefined) return -1;
    if (as !== undefined && bs !== undefined && as !== bs) return as - bs;
    return a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0;
  });
  for (const t of sortedWf) {
    const key = workflowKeyOf(t);
    if (!grouped.has(key)) {
      grouped.set(key, []);
      wfOrder.push(key);
    }
    grouped.get(key)!.push(t);
  }
  for (const key of wfOrder) {
    const tracks = (grouped.get(key) || []).map((t) => ({
      track_id: t.task_id,
      workflow_name: str(t.workflow_name),
      lanes: byTrack.get(t.task_id) || [],
    }));
    groups.push({ key, tracks });
  }
  if (ungrouped.length) {
    groups.push({ key: "ungrouped", tracks: [{ track_id: "ungrouped", lanes: ungrouped }] });
  }

  const lanes: AssignedLane[] = [];
  const tracks: AssignedTrackBand[] = [];
  const workflows: AssignedWorkflowBand[] = [];
  let cursor = PAD_TOP;

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const wfTop = cursor;
    cursor += WF_HEAD;
    const trackIds: string[] = [];
    const heights: number[] = [];
    for (let ti = 0; ti < g.tracks.length; ti++) {
      if (ti > 0) cursor += TRACK_GAP;
      const tr = g.tracks[ti];
      const all = tr.lanes;
      const visible = all.slice(0, MAX_VISIBLE_LANES);
      const overflowN = Math.max(0, all.length - MAX_VISIBLE_LANES);
      const n = visible.length + (overflowN ? 1 : 0);
      const th = trackHeight(n);
      const tTop = cursor;
      cursor += TRACK_HEAD;
      const groupKey = g.key === "ungrouped" ? "ungrouped" : tr.track_id;
      visible.forEach((a, i) => {
        const y_top = cursor;
        const row: AssignedLane = {
          lane_id: a.agent_id,
          group_key: groupKey,
          lane_index: i,
          color_class: a.color,
          y_top,
          y_h: 22,
          y_mid: y_top + 11,
        };
        if (a.agent_type) row.agent_type = a.agent_type;
        lanes.push(row);
        cursor += LANE_H;
        if (i < n - 1) cursor += LANE_GAP;
      });
      if (overflowN) {
        const y_top = cursor;
        lanes.push({
          lane_id: `${tr.track_id}::overflow`,
          group_key: groupKey,
          lane_index: MAX_VISIBLE_LANES,
          color_class: "other",
          y_top,
          y_h: 22,
          y_mid: y_top + 11,
          overflow: true,
          overflow_n: overflowN,
        });
        cursor += LANE_H;
      }
      trackIds.push(tr.track_id);
      heights.push(th);
      const band: AssignedTrackBand = {
        track_id: tr.track_id,
        y_top: tTop,
        height: th,
        overflow_n: overflowN,
      };
      if (tr.workflow_name) band.workflow_name = tr.workflow_name;
      tracks.push(band);
    }
    const wfHeight = WF_HEAD + heights.reduce((s, h) => s + h, 0) + Math.max(0, heights.length - 1) * TRACK_GAP;
    workflows.push({ workflow_key: g.key, y_top: wfTop, height: wfHeight, track_ids: trackIds });
    cursor = wfTop + wfHeight;
    if (gi < groups.length - 1) cursor += WF_GAP;
  }

  return { lanes, tracks, workflows, height: groups.length ? cursor + PAD_BOTTOM : PAD_TOP + PAD_BOTTOM };
}

export type DagBoardLayout = "single" | "side-by-side";

export type DagBoard = {
  workflow_name: string;
  tracks: DagTrack[];
  layout: DagBoardLayout;
  lane_ids: string[];
  unjoined_lane_ids: string[];
};

function firstSeenTrackKeys(nodes: DagNode[], events: ReadonlyArray<DagEvent>): Map<string, DagSeries> {
  const keys: string[] = [];
  const seen = new Set<string>();
  const push = (key: string | undefined) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };
  for (const e of events) {
    if ((e.summary || "").trim() !== "task_started") continue;
    const extra = extraOf(e);
    push(str(extra.workflow_name) || str(extra.task_id));
  }
  for (const n of nodes) {
    if (n.kind !== "workflow") continue;
    push(str(n.workflow_name) || n.ref_id);
  }
  const out = new Map<string, DagSeries>();
  keys.forEach((k, i) => out.set(k, seriesSlot(i)));
  return out;
}

function tracksOverlap(a: DagTrack, b: DagTrack, now?: number): boolean {
  const a1 = a.start_ts;
  const a2 = a.end_ts ?? now;
  const b1 = b.start_ts;
  const b2 = b.end_ts ?? now;
  if (a1 === undefined || a2 === undefined || b1 === undefined || b2 === undefined) return false;
  return a1 <= b2 && b1 <= a2;
}

export function groupTracksByWorkflow(graph: DagGraph, now?: number): DagBoard[] {
  const nowSec = nowSecOf(now);
  const boards: DagBoard[] = [];
  const byName = new Map<string, DagTrack[]>();
  const order: string[] = [];
  for (const t of graph.tracks) {
    const name = str(t.workflow_name) || "_unnamed";
    if (!byName.has(name)) {
      byName.set(name, []);
      order.push(name);
    }
    byName.get(name)!.push(t);
  }
  const unjoined = graph.lanes.filter((l) => !l.track_id).map((l) => l.lane_id);
  for (const name of order) {
    const tracks = byName.get(name) || [];
    let side = false;
    for (let i = 0; i < tracks.length && !side; i++) {
      for (let j = i + 1; j < tracks.length; j++) {
        if (tracksOverlap(tracks[i], tracks[j], nowSec)) {
          side = true;
          break;
        }
      }
    }
    const laneIds: string[] = [];
    const seen = new Set<string>();
    for (const t of tracks) {
      for (const id of t.lane_ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        laneIds.push(id);
      }
    }
    boards.push({
      workflow_name: name,
      tracks,
      layout: side ? "side-by-side" : "single",
      lane_ids: laneIds,
      unjoined_lane_ids: name === order[0] ? unjoined : [],
    });
  }
  if (!boards.length && unjoined.length) {
    boards.push({
      workflow_name: "_unnamed",
      tracks: [],
      layout: "single",
      lane_ids: [],
      unjoined_lane_ids: unjoined,
    });
  }
  return boards;
}

export function buildDagGraph(input: DagInput): DagGraph {
  const snapshot = input.snapshot;
  const events = input.events || [];
  const now = nowSecOf(input.now);
  const wfTools = workflowToolUseIds(events);
  const nodes: DagNode[] = [];
  for (const task of snapshot.tasks || []) {
    if (!isWorkflowTask(task, wfTools)) continue;
    const node = workflowNode(task, input.now);
    if (node) nodes.push(node);
  }
  const workflowNodes = nodes.filter((n) => n.kind === "workflow");
  const hasWf = workflowNodes.length > 0;
  const collected = collectAgents(snapshot.agents, events);
  const order = firstSeenAgentIds(events, snapshot.agents);
  const lanes: DagLane[] = [];
  order.forEach((id, i) => {
    const a = collected.get(id);
    if (!a || !includeInGraph(a, hasWf)) return;
    const track = joinTrackId(a, workflowNodes, now);
    const series = seriesSlot(i);
    nodes.push(agentNode(a, track, series));
    lanes.push(agentLane(a, track, series));
  });
  const seen = new Map(order.map((id, i) => [id, i]));
  nodes.sort((a, b) => compareNodes(a, b, seen));
  const seriesByKey = firstSeenTrackKeys(nodes, events);
  const tracks: DagTrack[] = nodes
    .filter((n) => n.kind === "workflow")
    .map((n) => {
      const key = str(n.workflow_name) || n.ref_id;
      const track: DagTrack = {
        track_id: n.ref_id,
        status: n.status,
        live: n.live,
        series: seriesByKey.get(key) || "other",
        node_id: n.id,
        lane_ids: lanes.filter((l) => l.track_id === n.ref_id).map((l) => l.lane_id),
      };
      if (n.workflow_name) track.workflow_name = n.workflow_name;
      if (n.tool_use_id) track.tool_use_id = n.tool_use_id;
      if (n.start_ts !== undefined) track.start_ts = n.start_ts;
      if (n.end_ts !== undefined) track.end_ts = n.end_ts;
      n.series = track.series;
      return track;
    });
  const domain = collectDomain(nodes, events, snapshot, input.now);
  return {
    session_id: snapshot.session_id,
    nodes,
    edges: succeedsEdges(nodes.filter((n) => n.kind === "workflow")),
    tracks,
    lanes,
    domain,
  };
}

export type DagDomainScale = { empty: true } | { empty: false; min: number; max: number };
export type ClockTick = { ts: number; label: string };

const DAG_EVENT_SUMMARIES = new Set([
  "task_started",
  "task_progress",
  "task_updated",
  "task_notification",
  "SubagentStart",
  "SubagentStop",
]);

const CLOCK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

function isDagRelevantEvent(e: DagEvent): boolean {
  const summary = (e.summary || "").trim();
  if (DAG_EVENT_SUMMARIES.has(summary)) return true;
  return !!str(extraOf(e).task_id);
}

function collectDomain(
  nodes: DagNode[],
  events: ReadonlyArray<DagEvent>,
  snapshot: MonitorSnapshot,
  now?: number,
): { start_ts?: number; end_ts?: number } {
  const pts: number[] = [];
  const push = (v: unknown) => {
    const n = asEpochSec(v);
    if (n !== undefined) pts.push(n);
  };
  for (const n of nodes) {
    push(n.start_ts);
    push(n.end_ts);
    if (n.start_ts !== undefined && n.end_ts === undefined && n.duration_ms !== undefined && Number.isFinite(n.duration_ms)) {
      pts.push(n.start_ts + n.duration_ms / 1000);
    }
  }
  for (const t of snapshot.tasks || []) {
    push(t.started_ts);
    push(t.ended_ts);
  }
  for (const e of events) {
    if (!isDagRelevantEvent(e)) continue;
    push(e.ts);
  }
  const live = nodes.some((n) => n.live) || (snapshot.tasks || []).some((t) => t.live) || (snapshot.agents || []).some((a) => a.live);
  const nowSec = nowSecOf(now);
  if (live && nowSec !== undefined) pts.push(nowSec);
  if (!pts.length) return {};
  let min = Math.min(...pts);
  let max = Math.max(...pts);
  if (max <= min) max = min + 1;
  return { start_ts: min, end_ts: max };
}

export function buildDagDomain(graph: Pick<DagGraph, "nodes" | "domain">, now?: number): DagDomainScale {
  const pts: number[] = [];
  const push = (v: unknown) => {
    const n = asEpochSec(v);
    if (n !== undefined) pts.push(n);
  };
  push(graph.domain.start_ts);
  push(graph.domain.end_ts);
  for (const n of graph.nodes || []) {
    push(n.start_ts);
    push(n.end_ts);
  }
  const nowSec = nowSecOf(now);
  if (nowSec !== undefined && (graph.nodes || []).some((n) => n.live)) pts.push(nowSec);
  if (!pts.length) return { empty: true };
  let min = Math.min(...pts);
  let max = Math.max(...pts);
  if (max <= min) max = min + 1;
  return { empty: false, min, max };
}

function alignUp(ts: number, step: number): number {
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return ts;
  if (step >= 3600) {
    d.setMinutes(0, 0, 0);
    let aligned = d.getTime() / 1000;
    if (aligned < ts) aligned += 3600;
    return aligned;
  }
  if (step >= 60) {
    const minutes = d.getMinutes();
    const stepMin = step / 60;
    d.setSeconds(0, 0);
    const next = Math.ceil(minutes / stepMin) * stepMin;
    if (next === minutes && d.getTime() / 1000 < ts) {
      d.setMinutes(minutes + stepMin);
    } else {
      d.setMinutes(next);
    }
    return d.getTime() / 1000;
  }
  const sec = d.getSeconds() + d.getMilliseconds() / 1000;
  const next = Math.ceil(sec / step) * step;
  d.setMilliseconds(0);
  if (next >= 60) {
    d.setSeconds(0);
    d.setMinutes(d.getMinutes() + 1);
    return d.getTime() / 1000;
  }
  d.setSeconds(next);
  let aligned = d.getTime() / 1000;
  if (aligned < ts) aligned += step;
  return aligned;
}

export function clockTicks(domain: DagDomainScale): ClockTick[] {
  if (domain.empty) return [];
  const span = domain.max - domain.min;
  if (!(span > 0) || !Number.isFinite(span)) return [];
  let step = CLOCK_STEPS[CLOCK_STEPS.length - 1];
  for (const s of CLOCK_STEPS) {
    if (span / s <= 4) {
      step = s;
      break;
    }
  }
  const ticks: ClockTick[] = [];
  let t = alignUp(domain.min, step);
  const guard = domain.max + step;
  while (t <= domain.max + 1e-9 && t <= guard) {
    ticks.push({ ts: t, label: formatClock(t) });
    t += step;
  }
  return ticks;
}

export function xOf(domain: DagDomainScale, ts: number | undefined): number | undefined {
  if (domain.empty || ts === undefined || !Number.isFinite(ts)) return undefined;
  const span = domain.max - domain.min;
  if (!(span > 0)) return undefined;
  if (ts < domain.min || ts > domain.max) return undefined;
  return (ts - domain.min) / span;
}
