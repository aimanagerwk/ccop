import { describe, expect, it } from "vitest";
import { buildMonitorSnapshot } from "../web/src/lib/workflow-monitor.js";
import {
  assignSwimlanes,
  buildDagDomain,
  buildDagGraph,
  clockTicks,
  groupTracksByWorkflow,
  xOf,
} from "../web/src/lib/workflow-dag.js";
import { formatClock, liveDurationMs } from "../web/src/lib/workflow-monitor.js";

/** Shapes taken from WF-COVERAGE.md / wf-evidence.json — host RPC, not invented. */

const NOW_MS = 1_787_403_760_000;

function ev(
  summary: string,
  extra: Record<string, unknown> = {},
  kind = "working",
  ts = 1_787_403_750,
) {
  return { kind, summary, extra, ts };
}

function session(id = "cee5cd27-209d-496e-9835-075e8d317b5f") {
  return { id, name: "wf", title: null, pending: [], last_turn: null, last_task: null, alive: true };
}

describe("buildDagGraph — F1 unit", () => {
  it("returns an empty graph and copies session_id", () => {
    const snap = buildMonitorSnapshot({ session: session("s1") });
    const graph = buildDagGraph({ snapshot: snap });
    expect(graph).toEqual({
      session_id: "s1",
      nodes: [],
      edges: [],
      tracks: [],
      lanes: [],
      domain: {},
    });
  });

  it("emits one workflow node for the observed auth-session-dashboard-review invocation", () => {
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: {
        tasks: [
          {
            task_id: "wq80ltdqd",
            status: "running",
            summary: "Code-review Next.js auth, session, and dashboard paths",
            tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0",
          },
        ],
      },
      events: [
        ev("tool Workflow", { tool: "Workflow", tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0" }),
        ev(
          "task_started",
          {
            task_id: "wq80ltdqd",
            tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0",
            task_type: "local_workflow",
            workflow_name: "auth-session-dashboard-review",
          },
          "working",
          1_787_403_740,
        ),
      ],
      now: NOW_MS,
    });
    const events = [
      ev("tool Workflow", { tool: "Workflow", tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0" }),
      ev(
        "task_started",
        {
          task_id: "wq80ltdqd",
          tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0",
          task_type: "local_workflow",
          workflow_name: "auth-session-dashboard-review",
        },
        "working",
        1_787_403_740,
      ),
    ];
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]).toMatchObject({
      id: "wf:wq80ltdqd",
      kind: "workflow",
      ref_id: "wq80ltdqd",
      label: "auth-session-dashboard-review",
      workflow_name: "auth-session-dashboard-review",
      task_type: "local_workflow",
      tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0",
      status: "running",
      status_tone: "running",
      live: true,
      track_id: "wq80ltdqd",
    });
    expect(g.edges).toEqual([]);
    expect(g.lanes).toEqual([]);
    expect(g.domain.start_ts).toBe(1_787_403_740);
    expect(g.domain.end_ts).toBe(1_787_403_760);
  });

  it("emits a succeeds edge from the killed review to the later dashboard-only-review", () => {
    const events = [
      ev("tool Workflow", { tool: "Workflow", tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0" }),
      ev(
        "task_started",
        {
          task_id: "wq80ltdqd",
          tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0",
          task_type: "local_workflow",
          workflow_name: "auth-session-dashboard-review",
        },
        "working",
        1_787_403_740,
      ),
      ev("task_updated", { task_id: "wq80ltdqd", patch: { status: "killed", end_time: 1_787_403_750_285 } }),
      ev("tool Workflow", { tool: "Workflow", tool_use_id: "call-7c901579-b19c-4d30-9f76-b6caf54675f7-3" }),
      ev(
        "task_started",
        {
          task_id: "whsrtu0a3",
          tool_use_id: "call-7c901579-b19c-4d30-9f76-b6caf54675f7-3",
          task_type: "local_workflow",
          workflow_name: "dashboard-only-review",
        },
        "working",
        1_787_403_752,
      ),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: {
        tasks: [
          { task_id: "wq80ltdqd", status: "stopped", tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0" },
          { task_id: "whsrtu0a3", status: "running", tool_use_id: "call-7c901579-b19c-4d30-9f76-b6caf54675f7-3" },
        ],
      },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.nodes.map((n) => n.id)).toEqual(["wf:wq80ltdqd", "wf:whsrtu0a3"]);
    expect(g.edges).toEqual([
      { id: "succeeds:wf:wq80ltdqd->wf:whsrtu0a3", from: "wf:wq80ltdqd", to: "wf:whsrtu0a3", kind: "succeeds" },
    ]);
  });

  it("does not edge overlapping same-name local_workflow siblings", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "tA", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev(
        "task_started",
        { task_id: "tB", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_741,
      ),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: {
        tasks: [
          { task_id: "tA", status: "running" },
          { task_id: "tB", status: "running" },
        ],
      },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toEqual([]);
  });

  it("does not emit nodes from an RPC-only tasks envelope", () => {
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: {
        ok: true,
        tasks: [
          {
            task_id: "wq80ltdqd",
            status: "running",
            summary: "Code-review Next.js auth, session, and dashboard paths",
            tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0",
            usage: { total_tokens: 0, tool_uses: 0, duration_ms: 3264 },
          },
        ],
      },
    });
    const g = buildDagGraph({ snapshot: snap });
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });

  it("drops local_agent task_started even when an Agent tool_use is present", () => {
    const events = [
      ev("tool Agent", { tool: "Agent", tool_use_id: "call-agent-1" }),
      ev(
        "task_started",
        { task_id: "a6377826949f1d6b2", tool_use_id: "call-agent-1", task_type: "local_agent", spawn_depth: 1 },
        "working",
        1_787_403_740,
      ),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "a6377826949f1d6b2", status: "running", tool_use_id: "call-agent-1" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.nodes).toEqual([]);
  });

  it("copies last_tool as a breadcrumb and does not mint a phase or extra edge", () => {
    const events = [
      ev(
        "task_started",
        {
          task_id: "wq80ltdqd",
          task_type: "local_workflow",
          workflow_name: "auth-session-dashboard-review",
        },
        "working",
        1_787_403_740,
      ),
      ev("task_progress", {
        task_id: "wq80ltdqd",
        description: "Review: review-auth-session",
        last_tool_name: "review-auth-session",
      }),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0].last_tool).toBe("review-auth-session");
    expect(g.nodes.every((n) => n.kind !== "phase")).toBe(true);
    expect(g.edges).toEqual([]);
  });

  it("ignores background_tasks_changed even when task_id matches", () => {
    const events = [
      ev("background_tasks_changed", {
        n: 1,
        tasks: [{ task_id: "ghost", type: "local_workflow", name: "invented", description: "nope" }],
      }),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "ghost", status: "running" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.nodes).toEqual([]);
  });

  it("keeps wf:${task_id} / succeeds:${from}->${to} across a tasks-array reshuffle", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("task_updated", { task_id: "wq80ltdqd", patch: { status: "killed", end_time: 1_787_403_750_285 } }),
      ev(
        "task_started",
        { task_id: "whsrtu0a3", task_type: "local_workflow", workflow_name: "dashboard-only-review" },
        "working",
        1_787_403_752,
      ),
    ];
    const forward = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "stopped" }, { task_id: "whsrtu0a3", status: "running" }] },
      events,
    });
    const reverse = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "whsrtu0a3", status: "running" }, { task_id: "wq80ltdqd", status: "stopped" }] },
      events,
    });
    const a = buildDagGraph({ snapshot: forward, events });
    const b = buildDagGraph({ snapshot: reverse, events });
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id));
    expect(a.edges).toEqual(b.edges);
    expect(a.edges[0].id).toBe("succeeds:wf:wq80ltdqd->wf:whsrtu0a3");
  });

  it("maps known statuses to tones and leaves mystery without a tone", () => {
    const events = [
      ev("task_started", { task_id: "a", task_type: "local_workflow", workflow_name: "n" }, "working", 10),
      ev("task_started", { task_id: "b", task_type: "local_workflow", workflow_name: "n" }, "working", 20),
      ev("task_started", { task_id: "c", task_type: "local_workflow", workflow_name: "n" }, "working", 30),
      ev("task_started", { task_id: "d", task_type: "local_workflow", workflow_name: "n" }, "working", 40),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: {
        tasks: [
          { task_id: "a", status: "pending" },
          { task_id: "b", status: "completed" },
          { task_id: "c", status: "failed" },
          { task_id: "d", status: "mystery" },
        ],
      },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    const byId = Object.fromEntries(g.nodes.map((n) => [n.ref_id, n]));
    expect(byId.a.status_tone).toBe("running");
    expect(byId.b.status_tone).toBe("done");
    expect(byId.c.status_tone).toBe("failed");
    expect(byId.d.status).toBe("mystery");
    expect(byId.d.status_tone).toBeUndefined();
  });

  it("does not edge overlapping intervals of different workflow_name", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev(
        "task_started",
        { task_id: "whsrtu0a3", task_type: "local_workflow", workflow_name: "dashboard-only-review" },
        "working",
        1_787_403_741,
      ),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: {
        tasks: [
          { task_id: "wq80ltdqd", status: "running" },
          { task_id: "whsrtu0a3", status: "running" },
        ],
      },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toEqual([]);
  });
});

describe("buildDagGraph — F2 unit", () => {
  it("emits 3 agent nodes and lanes for the observed workflow-subagent starts, no wf↔ag edges", () => {
    const events = [
      ev(
        "task_started",
        {
          task_id: "wq80ltdqd",
          task_type: "local_workflow",
          workflow_name: "auth-session-dashboard-review",
        },
        "working",
        1_787_403_740,
      ),
      ev("SubagentStart", { agent_id: "a4b038649de76b741", agent_type: "workflow-subagent" }, "working", 1_787_403_741),
      ev("SubagentStart", { agent_id: "ad7590958a54e1418", agent_type: "workflow-subagent" }, "working", 1_787_403_742),
      ev("SubagentStart", { agent_id: "ab5ca444586b035f7", agent_type: "workflow-subagent" }, "working", 1_787_403_743),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    const agents = g.nodes.filter((n) => n.kind === "agent");
    expect(agents.map((n) => n.id)).toEqual([
      "ag:a4b038649de76b741",
      "ag:ad7590958a54e1418",
      "ag:ab5ca444586b035f7",
    ]);
    expect(g.lanes).toHaveLength(3);
    expect(g.lanes.every((l) => l.track_id === "wq80ltdqd")).toBe(true);
    expect(g.edges.every((e) => e.from.startsWith("wf:") && e.to.startsWith("wf:"))).toBe(true);
    expect(g.nodes.every((n) => n.kind !== "phase")).toBe(true);
  });

  it("assignSwimlanes places those three lanes at y_top 52, 76, 100 with series-1..3", () => {
    const events = [
      ev(
        "task_started",
        {
          task_id: "wq80ltdqd",
          task_type: "local_workflow",
          workflow_name: "auth-session-dashboard-review",
        },
        "working",
        1_787_403_740,
      ),
      ev("SubagentStart", { agent_id: "a4b038649de76b741", agent_type: "workflow-subagent" }, "working", 1_787_403_741),
      ev("SubagentStart", { agent_id: "ad7590958a54e1418", agent_type: "workflow-subagent" }, "working", 1_787_403_742),
      ev("SubagentStart", { agent_id: "ab5ca444586b035f7", agent_type: "workflow-subagent" }, "working", 1_787_403_743),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const layout = assignSwimlanes({ tasks: snap.tasks, agents: snap.agents, events, now: NOW_MS });
    expect(layout.lanes.map((l) => l.lane_index)).toEqual([0, 1, 2]);
    expect(layout.lanes.map((l) => l.color_class)).toEqual(["series-1", "series-2", "series-3"]);
    expect(layout.lanes.every((l) => l.group_key === "wq80ltdqd")).toBe(true);
    expect(layout.lanes.map((l) => l.y_top)).toEqual([52, 76, 100]);
  });

  it("control session a6377826949f1d6b2 / wd3eoqk8l is one lane series-1 overflow 0", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wd3eoqk8l", task_type: "local_workflow", workflow_name: "login-page-review" },
        "working",
        1_787_403_740,
      ),
      ev("SubagentStart", { agent_id: "a6377826949f1d6b2", agent_type: "workflow-subagent" }, "working", 1_787_403_741),
    ];
    const snap = buildMonitorSnapshot({
      session: session("6da9c30c-a520-4d0e-ada7-75cb34e38cfc"),
      tasks: { tasks: [{ task_id: "wd3eoqk8l", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    const layout = assignSwimlanes({ tasks: snap.tasks, agents: snap.agents, events, now: NOW_MS });
    expect(g.lanes).toHaveLength(1);
    expect(g.lanes[0].series).toBe("series-1");
    expect(layout.tracks[0].overflow_n).toBe(0);
  });

  it("joins a start inside the window and not a start after the killed end_time", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("task_updated", { task_id: "wq80ltdqd", patch: { status: "killed", end_time: 1_787_403_750_285 } }),
      ev("SubagentStart", { agent_id: "a4b038649de76b741", agent_type: "workflow-subagent" }, "working", 1_787_403_741),
      ev("SubagentStart", { agent_id: "ad7590958a54e1418", agent_type: "workflow-subagent" }, "working", 1_787_403_751),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "stopped" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    const byId = Object.fromEntries(g.lanes.map((l) => [l.lane_id, l]));
    expect(byId.a4b038649de76b741.track_id).toBe("wq80ltdqd");
    expect(byId.ad7590958a54e1418.track_id).toBeUndefined();
  });

  it("later track whsrtu0a3 is a new band; first-band lane_index stays 0,1,2", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("task_updated", { task_id: "wq80ltdqd", patch: { status: "killed", end_time: 1_787_403_750_285 } }),
      ev("SubagentStart", { agent_id: "a4b038649de76b741", agent_type: "workflow-subagent" }, "working", 1_787_403_741),
      ev("SubagentStart", { agent_id: "ad7590958a54e1418", agent_type: "workflow-subagent" }, "working", 1_787_403_742),
      ev("SubagentStart", { agent_id: "ab5ca444586b035f7", agent_type: "workflow-subagent" }, "working", 1_787_403_743),
      ev(
        "task_started",
        { task_id: "whsrtu0a3", task_type: "local_workflow", workflow_name: "dashboard-only-review" },
        "working",
        1_787_403_752,
      ),
      ev("SubagentStart", { agent_id: "a6377826949f1d6b2", agent_type: "workflow-subagent" }, "working", 1_787_403_753),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: {
        tasks: [
          { task_id: "wq80ltdqd", status: "stopped" },
          { task_id: "whsrtu0a3", status: "running" },
        ],
      },
      events,
      now: NOW_MS,
    });
    const layout = assignSwimlanes({ tasks: snap.tasks, agents: snap.agents, events, now: NOW_MS });
    const first = layout.lanes.filter((l) => l.group_key === "wq80ltdqd");
    const second = layout.lanes.filter((l) => l.group_key === "whsrtu0a3");
    expect(first.map((l) => l.lane_index)).toEqual([0, 1, 2]);
    expect(second.map((l) => l.lane_index)).toEqual([0]);
    expect(layout.tracks).toHaveLength(2);
  });

  it("omits track_id when one agent overlaps two live workflows", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev(
        "task_started",
        { task_id: "whsrtu0a3", task_type: "local_workflow", workflow_name: "dashboard-only-review" },
        "working",
        1_787_403_741,
      ),
      ev("SubagentStart", { agent_id: "a4b038649de76b741", agent_type: "workflow-subagent" }, "working", 1_787_403_742),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: {
        tasks: [
          { task_id: "wq80ltdqd", status: "running" },
          { task_id: "whsrtu0a3", status: "running" },
        ],
      },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    const layout = assignSwimlanes({ tasks: snap.tasks, agents: snap.agents, events, now: NOW_MS });
    expect(g.lanes[0].track_id).toBeUndefined();
    expect(layout.lanes[0].group_key).toBe("ungrouped");
  });

  it("collapses the 9th agent into one overflow row class other", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ...Array.from({ length: 9 }, (_, i) =>
        ev("SubagentStart", { agent_id: `agent-${i}`, agent_type: "workflow-subagent" }, "working", 1_787_403_741 + i),
      ),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const layout = assignSwimlanes({ tasks: snap.tasks, agents: snap.agents, events, now: NOW_MS });
    const visible = layout.lanes.filter((l) => !l.overflow);
    const overflow = layout.lanes.filter((l) => l.overflow);
    expect(visible).toHaveLength(8);
    expect(overflow).toHaveLength(1);
    expect(overflow[0].color_class).toBe("other");
    expect(overflow[0].overflow_n).toBe(1);
    expect(overflow[0].y_top).toBe(visible[7].y_top + 22 + 2);
  });

  it("4th global agent is color_class other and still owns a lane", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("SubagentStart", { agent_id: "a1", agent_type: "workflow-subagent" }, "working", 1_787_403_741),
      ev("SubagentStart", { agent_id: "a2", agent_type: "workflow-subagent" }, "working", 1_787_403_742),
      ev("SubagentStart", { agent_id: "a3", agent_type: "workflow-subagent" }, "working", 1_787_403_743),
      ev("SubagentStart", { agent_id: "a4", agent_type: "workflow-subagent" }, "working", 1_787_403_744),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const layout = assignSwimlanes({ tasks: snap.tasks, agents: snap.agents, events, now: NOW_MS });
    expect(layout.lanes.map((l) => l.color_class)).toEqual(["series-1", "series-2", "series-3", "other"]);
    expect(layout.lanes[3].lane_index).toBe(3);
  });

  it("hiding the first agent at render keeps the survivors on slots 2 and 3", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("SubagentStart", { agent_id: "a1", agent_type: "workflow-subagent" }, "working", 1_787_403_741),
      ev("SubagentStart", { agent_id: "a2", agent_type: "workflow-subagent" }, "working", 1_787_403_742),
      ev("SubagentStart", { agent_id: "a3", agent_type: "workflow-subagent" }, "working", 1_787_403_743),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const full = assignSwimlanes({ tasks: snap.tasks, agents: snap.agents, events, now: NOW_MS });
    const survivors = full.lanes.filter((l) => l.lane_id !== "a1");
    expect(survivors.map((l) => l.color_class)).toEqual(["series-2", "series-3"]);
  });

  it("sdk string ids during a local_workflow become lanes without agent_type; RPC-only with no workflow is 未分组", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
    ];
    const withWf = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      subagents: { source: "sdk", subagents: ["a4b038649de76b741", "ad7590958a54e1418"] },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: withWf, events, now: NOW_MS });
    expect(g.lanes).toHaveLength(2);
    expect(g.lanes.every((l) => l.agent_type === undefined)).toBe(true);

    const rpcOnly = buildMonitorSnapshot({
      session: session(),
      subagents: { source: "sdk", subagents: ["a4b038649de76b741"] },
    });
    const empty = buildDagGraph({ snapshot: rpcOnly });
    expect(empty.lanes).toEqual([]);
    const ungrouped = assignSwimlanes({ tasks: rpcOnly.tasks, agents: rpcOnly.agents, now: NOW_MS });
    expect(ungrouped.workflows[0].workflow_key).toBe("ungrouped");
    expect(ungrouped.lanes[0].color_class).toBe("series-1");
  });

  it("duplicate Start is one lane; Stop-only is one lane; empty is 0", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("SubagentStart", { agent_id: "a4b038649de76b741", agent_type: "workflow-subagent" }, "working", 1_787_403_741),
      ev("SubagentStart", { agent_id: "a4b038649de76b741", agent_type: "workflow-subagent" }, "working", 1_787_403_742),
      ev("SubagentStop", { agent_id: "ad7590958a54e1418", agent_type: "workflow-subagent" }, "working", 1_787_403_743),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.lanes.map((l) => l.lane_id)).toEqual(["a4b038649de76b741", "ad7590958a54e1418"]);
    expect(assignSwimlanes({ tasks: [], agents: [], events: [] }).lanes).toEqual([]);
  });

  it("drops local_agent / Explore SubagentStart", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("SubagentStart", { agent_id: "explore-1", agent_type: "Explore" }, "working", 1_787_403_741),
      ev("task_started", { task_id: "local-a", task_type: "local_agent", spawn_depth: 1 }, "working", 1_787_403_741),
      ev("SubagentStart", { agent_id: "local-a", agent_type: "local_agent" }, "working", 1_787_403_741),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }, { task_id: "local-a", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.nodes.filter((n) => n.kind === "agent")).toEqual([]);
    expect(g.lanes).toEqual([]);
  });

  it("live vs stopped does not reorder or recolor", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("SubagentStart", { agent_id: "a1", agent_type: "workflow-subagent" }, "working", 1_787_403_741),
      ev("SubagentStart", { agent_id: "a2", agent_type: "workflow-subagent" }, "working", 1_787_403_742),
      ev("SubagentStop", { agent_id: "a1" }, "working", 1_787_403_743),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const layout = assignSwimlanes({ tasks: snap.tasks, agents: snap.agents, events, now: NOW_MS });
    expect(layout.lanes.map((l) => l.lane_id)).toEqual(["a1", "a2"]);
    expect(layout.lanes.map((l) => l.color_class)).toEqual(["series-1", "series-2"]);
  });

  it("agent timestamps come only from SubagentStart/Stop e.ts", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("SubagentStart", { agent_id: "a4b038649de76b741", agent_type: "workflow-subagent" }, "working", 1_787_403_741.5),
      ev("SubagentStop", { agent_id: "a4b038649de76b741" }, "working", 1_787_403_748),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      subagents: { subagents: [{ agent_id: "a4b038649de76b741", agent_type: "workflow-subagent", status: "stopped" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.nodes.find((n) => n.kind === "agent")).toMatchObject({
      start_ts: 1_787_403_741.5,
      end_ts: 1_787_403_748,
      live: false,
    });
    const rpcOnly = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      subagents: { subagents: [{ agent_id: "ad7590958a54e1418", agent_type: "workflow-subagent", status: "running" }] },
      events: [
        ev(
          "task_started",
          { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
          "working",
          1_787_403_740,
        ),
      ],
    });
    const g2 = buildDagGraph({
      snapshot: rpcOnly,
      events: [
        ev(
          "task_started",
          { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
          "working",
          1_787_403_740,
        ),
      ],
    });
    expect(g2.nodes.find((n) => n.kind === "agent")?.start_ts).toBeUndefined();
  });

  it("keeps literal constructor as ag:constructor and drops empty / __proto__", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("SubagentStart", { agent_id: "constructor", agent_type: "workflow-subagent" }, "working", 1_787_403_741),
      ev("SubagentStart", { agent_id: "__proto__", agent_type: "workflow-subagent" }, "working", 1_787_403_742),
      ev("SubagentStart", { agent_id: "", agent_type: "workflow-subagent" }, "working", 1_787_403_743),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.nodes.filter((n) => n.kind === "agent").map((n) => n.id)).toEqual(["ag:constructor"]);
  });
});

describe("buildDagGraph — F3 unit", () => {
  it("one task_id + 3 SubagentStart is 1 track with 3 lane_ids; last_tool is a crumb", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("task_progress", { task_id: "wq80ltdqd", last_tool_name: "review-auth-session" }),
      ev("SubagentStart", { agent_id: "a4b038649de76b741", agent_type: "workflow-subagent" }, "working", 1_787_403_741),
      ev("SubagentStart", { agent_id: "ad7590958a54e1418", agent_type: "workflow-subagent" }, "working", 1_787_403_742),
      ev("SubagentStart", { agent_id: "ab5ca444586b035f7", agent_type: "workflow-subagent" }, "working", 1_787_403_743),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.tracks).toHaveLength(1);
    expect(g.tracks[0].track_id).toBe("wq80ltdqd");
    expect(g.tracks[0].lane_ids).toHaveLength(3);
    expect(g.nodes[0].last_tool).toBe("review-auth-session");
  });

  it("a later last_tool on the same task_id is still 1 track", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("task_progress", { task_id: "wq80ltdqd", last_tool_name: "review-auth-session" }),
      ev("task_progress", { task_id: "wq80ltdqd", last_tool_name: "review-dashboard" }),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.tracks).toHaveLength(1);
    expect(g.nodes[0].last_tool).toBe("review-dashboard");
  });

  it("two sequential names become 2 tracks / 2 boards / different series keys", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("task_updated", { task_id: "wq80ltdqd", patch: { status: "killed", end_time: 1_787_403_750_285 } }),
      ev(
        "task_started",
        { task_id: "whsrtu0a3", task_type: "local_workflow", workflow_name: "dashboard-only-review" },
        "working",
        1_787_403_752,
      ),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: {
        tasks: [
          { task_id: "wq80ltdqd", status: "stopped" },
          { task_id: "whsrtu0a3", status: "running" },
        ],
      },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.tracks.map((t) => t.track_id)).toEqual(["wq80ltdqd", "whsrtu0a3"]);
    expect(g.tracks.map((t) => t.series)).toEqual(["series-1", "series-2"]);
    const boards = groupTracksByWorkflow(g, NOW_MS);
    expect(boards.map((b) => b.workflow_name)).toEqual(["auth-session-dashboard-review", "dashboard-only-review"]);
    expect(boards.every((b) => b.tracks.length === 1)).toBe(true);
    expect(boards.every((b) => b.layout === "single")).toBe(true);
  });

  it("overlapping same-name local_workflow siblings are 2 tracks both series-1, one side-by-side board", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "tA", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev(
        "task_started",
        { task_id: "tB", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_741,
      ),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "tA", status: "running" }, { task_id: "tB", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.tracks).toHaveLength(2);
    expect(g.edges).toEqual([]);
    expect(g.tracks.every((t) => t.series === "series-1")).toBe(true);
    const boards = groupTracksByWorkflow(g, NOW_MS);
    expect(boards).toHaveLength(1);
    expect(boards[0].layout).toBe("side-by-side");
  });

  it("non-overlapping same-name re-runs share one single-column board", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "tA", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("task_updated", { task_id: "tA", patch: { status: "completed", end_time: 1_787_403_750_000 } }),
      ev(
        "task_started",
        { task_id: "tB", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_752,
      ),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "tA", status: "completed" }, { task_id: "tB", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    const boards = groupTracksByWorkflow(g, NOW_MS);
    expect(boards).toHaveLength(1);
    expect(boards[0].layout).toBe("single");
    expect(boards[0].tracks).toHaveLength(2);
  });

  it("RPC-only tasks envelope yields 0 tracks and 0 named boards", () => {
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running", summary: "review" }] },
    });
    const g = buildDagGraph({ snapshot: snap });
    expect(g.tracks).toEqual([]);
    expect(groupTracksByWorkflow(g)).toEqual([]);
  });

  it("4 distinct workflow_name take series-1,2,3,other and filter does not recolor", () => {
    const names = ["auth-session-dashboard-review", "dashboard-only-review", "login-page-review", "fourth-review"];
    const events = names.map((workflow_name, i) =>
      ev(
        "task_started",
        { task_id: `t${i}`, task_type: "local_workflow", workflow_name },
        "working",
        1_787_403_740 + i * 20,
      ),
    );
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: names.map((_, i) => ({ task_id: `t${i}`, status: "completed" })) },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.tracks.map((t) => t.series)).toEqual(["series-1", "series-2", "series-3", "other"]);
    const survivors = g.tracks.filter((t) => t.track_id !== "t0");
    expect(survivors.map((t) => t.series)).toEqual(["series-2", "series-3", "other"]);
  });

  it("4 overlapping same-name task_ids stay one series key", () => {
    const events = Array.from({ length: 4 }, (_, i) =>
      ev(
        "task_started",
        { task_id: `t${i}`, task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740 + i,
      ),
    );
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: events.map((_, i) => ({ task_id: `t${i}`, status: "running" })) },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.tracks.every((t) => t.series === "series-1")).toBe(true);
    expect(groupTracksByWorkflow(g, NOW_MS)[0].layout).toBe("side-by-side");
  });

  it("local_agent in the same session is excluded from tracks/boards", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("task_started", { task_id: "local-a", task_type: "local_agent", spawn_depth: 1 }, "working", 1_787_403_741),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }, { task_id: "local-a", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.tracks.map((t) => t.track_id)).toEqual(["wq80ltdqd"]);
  });

  it("unjoined agent is not in any track.lane_ids and is listed on the board", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("task_updated", { task_id: "wq80ltdqd", patch: { status: "killed", end_time: 1_787_403_750_285 } }),
      ev("SubagentStart", { agent_id: "ad7590958a54e1418", agent_type: "workflow-subagent" }, "working", 1_787_403_751),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "stopped" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.tracks[0].lane_ids).toEqual([]);
    const boards = groupTracksByWorkflow(g);
    expect(boards[0].unjoined_lane_ids).toEqual(["ad7590958a54e1418"]);
  });
});

describe("buildDagGraph — F4 unit", () => {
  it("empty snapshot with no now yields an empty domain and no ticks", () => {
    const snap = buildMonitorSnapshot({ session: session("s1") });
    const g = buildDagGraph({ snapshot: snap });
    expect(g.domain).toEqual({});
    expect(buildDagDomain(g)).toEqual({ empty: true });
    expect(clockTicks({ empty: true })).toEqual([]);
    expect(formatClock(undefined)).toBe("—");
  });

  it("RPC-only running task without timestamps is empty", () => {
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
    });
    const g = buildDagGraph({ snapshot: snap });
    expect(g.domain).toEqual({});
    expect(buildDagDomain(g)).toEqual({ empty: true });
  });

  it("drops NaN / Infinity / string / null / object timestamps", () => {
    const events = [
      ev("task_started", { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "n" }, "working", Number.NaN),
      ev("task_progress", { task_id: "wq80ltdqd" }, "working", Number.POSITIVE_INFINITY),
      ev("task_updated", { task_id: "wq80ltdqd", patch: { end_time: "1787403750" } }, "working", null as unknown as number),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.domain).toEqual({});
  });

  it("mixes epoch seconds and millisecond end_time", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("task_updated", { task_id: "wq80ltdqd", patch: { status: "killed", end_time: 1_787_403_750_285 } }),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "stopped" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.domain.start_ts).toBeCloseTo(1_787_403_740);
    expect(g.domain.end_ts).toBeCloseTo(1_787_403_750.285, 5);
  });

  it("does not treat usage.duration_ms=15029 as a domain timestamp", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wd3eoqk8l", task_type: "local_workflow", workflow_name: "login-page-review" },
        "working",
        1_787_403_740,
      ),
      ev(
        "task completed",
        { task_id: "wd3eoqk8l", status: "completed", usage: { total_tokens: 13828, duration_ms: 15029 } },
        "task_done",
        1_787_403_870.719,
      ),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: {
        tasks: [
          {
            task_id: "wd3eoqk8l",
            status: "completed",
            usage: { total_tokens: 13828, tool_uses: 3, duration_ms: 15029 },
          },
        ],
      },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.domain.start_ts).toBeGreaterThan(1e9);
    expect(g.domain.end_ts).toBeGreaterThan(1e9);
    expect(Math.abs((g.domain.end_ts || 0) - 15029)).toBeGreaterThan(1e6);
  });

  it("keeps a fractional event ts", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "n" },
        "working",
        1_787_403_750.285,
      ),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "completed" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.nodes[0].start_ts).toBe(1_787_403_750.285);
    expect(g.domain.start_ts).toBe(1_787_403_750.285);
  });

  it("extends a live task to now=NOW_MS", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "n" },
        "working",
        1_787_403_740,
      ),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.domain.end_ts).toBe(1_787_403_760);
    const scale = buildDagDomain(g, NOW_MS);
    expect(scale).toEqual({ empty: false, min: 1_787_403_740, max: 1_787_403_760 });
  });

  it("does not pin 1970 when live now is missing or 0", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "n" },
        "working",
        1_787_403_750,
      ),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: 0 });
    expect(g.domain.start_ts).toBe(1_787_403_750);
    expect(g.domain.end_ts).toBe(1_787_403_751);
    expect((g.domain.end_ts || 0) - (g.domain.start_ts || 0)).toBe(1);
  });

  it("accepts now already in seconds", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "n" },
        "working",
        1_787_403_740,
      ),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
      now: 1_787_403_760,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: 1_787_403_760 });
    expect(g.domain.end_ts).toBe(1_787_403_760);
  });

  it("pads a single finished start to +1s", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "n" },
        "working",
        1_787_403_750,
      ),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "completed" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.domain).toEqual({ start_ts: 1_787_403_750, end_ts: 1_787_403_751 });
  });

  it("tick labels reuse formatClock and stay HH:MM:SS", () => {
    const domain = { empty: false as const, min: 1_787_403_740, max: 1_787_403_760 };
    const ticks = clockTicks(domain);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (const t of ticks) {
      expect(t.label).toBe(formatClock(t.ts));
      expect(t.label).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      expect(t.ts).toBeGreaterThanOrEqual(domain.min);
      expect(t.ts).toBeLessThanOrEqual(domain.max);
    }
    const steps = ticks.slice(1).map((t, i) => t.ts - ticks[i].ts);
    expect(steps.every((s) => s > 0 && s <= 5)).toBe(true);
    expect(new Set(steps).size).toBe(1);
  });

  it("xOf maps empty / min / max / mid and never maps a duration", () => {
    expect(xOf({ empty: true }, 1_787_403_750)).toBeUndefined();
    const d = { empty: false as const, min: 1_787_403_740, max: 1_787_403_760 };
    expect(xOf(d, 1_787_403_740)).toBe(0);
    expect(xOf(d, 1_787_403_760)).toBe(1);
    expect(xOf(d, 1_787_403_750)).toBeCloseTo(0.5);
    expect(xOf(d, 15029)).toBeUndefined();
  });

  it("two sequential tracks share one [first start, last end]", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("task_updated", { task_id: "wq80ltdqd", patch: { status: "killed", end_time: 1_787_403_750_285 } }),
      ev(
        "task_started",
        { task_id: "whsrtu0a3", task_type: "local_workflow", workflow_name: "dashboard-only-review" },
        "working",
        1_787_403_752,
      ),
      ev("task_updated", { task_id: "whsrtu0a3", patch: { status: "completed", end_time: 1_787_403_870_719 } }),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: {
        tasks: [
          { task_id: "wq80ltdqd", status: "stopped" },
          { task_id: "whsrtu0a3", status: "completed" },
        ],
      },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.domain.start_ts).toBe(1_787_403_740);
    expect(g.domain.end_ts).toBeCloseTo(1_787_403_870.719, 5);
  });

  it("SubagentStart contributes e.ts; MonitorAgent fields do not invent an end", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "n" },
        "working",
        1_787_403_740,
      ),
      ev("SubagentStart", { agent_id: "a4b038649de76b741", agent_type: "workflow-subagent" }, "working", 1_787_403_741),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "completed" }] },
      subagents: { subagents: [{ agent_id: "a4b038649de76b741", agent_type: "workflow-subagent", status: "running" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.nodes.find((n) => n.kind === "agent")?.end_ts).toBeUndefined();
    expect(g.domain.start_ts).toBe(1_787_403_740);
    expect(g.domain.end_ts).toBeGreaterThanOrEqual(1_787_403_741);
  });

  it("normalizes task_started seconds and patch.end_time milliseconds onto the node", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "n" },
        "working",
        1_787_403_750,
      ),
      ev("task_updated", { task_id: "wq80ltdqd", patch: { status: "killed", end_time: 1_787_403_750_285 } }),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "stopped" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.nodes[0].start_ts).toBe(1_787_403_750);
    expect(g.nodes[0].end_ts).toBeCloseTo(1_787_403_750.285, 5);
  });
});

describe("buildDagGraph — integration against observed RPC shapes", () => {
  it("merges tool Workflow + task_started into one node, then a killed→later succeeds edge", () => {
    const first = [
      ev("tool Workflow", { tool: "Workflow", tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0" }),
      ev(
        "task_started",
        {
          task_id: "wq80ltdqd",
          tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0",
          task_type: "local_workflow",
          workflow_name: "auth-session-dashboard-review",
        },
        "working",
        1_787_403_740,
      ),
    ];
    const snap1 = buildMonitorSnapshot({
      session: session(),
      tasks: {
        tasks: [
          {
            task_id: "wq80ltdqd",
            status: "running",
            summary: "Code-review Next.js auth, session, and dashboard paths",
            tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0",
          },
        ],
      },
      events: first,
      now: NOW_MS,
    });
    const g1 = buildDagGraph({ snapshot: snap1, events: first, now: NOW_MS });
    expect(g1.nodes).toHaveLength(1);
    expect(g1.nodes[0].id).toBe("wf:wq80ltdqd");
    expect(g1.edges).toEqual([]);

    const later = [
      ...first,
      ev("task_updated", { task_id: "wq80ltdqd", patch: { status: "killed", end_time: 1_787_403_750_285 } }),
      ev("tool Workflow", { tool: "Workflow", tool_use_id: "call-7c901579-b19c-4d30-9f76-b6caf54675f7-3" }),
      ev(
        "task_started",
        {
          task_id: "whsrtu0a3",
          tool_use_id: "call-7c901579-b19c-4d30-9f76-b6caf54675f7-3",
          task_type: "local_workflow",
          workflow_name: "dashboard-only-review",
        },
        "working",
        1_787_403_752,
      ),
    ];
    const snap2 = buildMonitorSnapshot({
      session: session(),
      tasks: {
        tasks: [
          { task_id: "wq80ltdqd", status: "stopped", tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0" },
          { task_id: "whsrtu0a3", status: "running", tool_use_id: "call-7c901579-b19c-4d30-9f76-b6caf54675f7-3" },
        ],
      },
      events: later,
      now: NOW_MS,
    });
    const g2 = buildDagGraph({ snapshot: snap2, events: later, now: NOW_MS });
    expect(g2.nodes.map((n) => n.id)).toEqual(["wf:wq80ltdqd", "wf:whsrtu0a3"]);
    expect(g2.edges).toEqual([
      { id: "succeeds:wf:wq80ltdqd->wf:whsrtu0a3", from: "wf:wq80ltdqd", to: "wf:whsrtu0a3", kind: "succeeds" },
    ]);
  });

  it("observed 3 SubagentStart extras become 3 ag nodes / 3 lanes / 0 wf↔ag edges", () => {
    const events = [
      ev("tool Workflow", { tool: "Workflow", tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0" }),
      ev(
        "task_started",
        {
          task_id: "wq80ltdqd",
          tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0",
          task_type: "local_workflow",
          workflow_name: "auth-session-dashboard-review",
        },
        "working",
        1_787_403_740,
      ),
      ev("SubagentStart", { agent_id: "a4b038649de76b741", agent_type: "workflow-subagent" }, "working", 1_787_403_741),
      ev("SubagentStart", { agent_id: "ad7590958a54e1418", agent_type: "workflow-subagent" }, "working", 1_787_403_742),
      ev("SubagentStart", { agent_id: "ab5ca444586b035f7", agent_type: "workflow-subagent" }, "working", 1_787_403_743),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: {
        tasks: [
          {
            task_id: "wq80ltdqd",
            status: "running",
            tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0",
          },
        ],
      },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.nodes.filter((n) => n.kind === "agent").map((n) => n.id)).toEqual([
      "ag:a4b038649de76b741",
      "ag:ad7590958a54e1418",
      "ag:ab5ca444586b035f7",
    ]);
    expect(g.lanes).toHaveLength(3);
    expect(g.edges).toEqual([]);
  });

  it("sdk subagents string[] during that session become allowlisted lanes", () => {
    const events = [
      ev(
        "task_started",
        {
          task_id: "wq80ltdqd",
          task_type: "local_workflow",
          workflow_name: "auth-session-dashboard-review",
        },
        "working",
        1_787_403_740,
      ),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      subagents: { ok: true, source: "sdk", subagents: ["a4b038649de76b741", "ad7590958a54e1418"] },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.lanes.map((l) => l.lane_id)).toEqual(["a4b038649de76b741", "ad7590958a54e1418"]);
    expect(g.lanes.every((l) => Object.keys(l).every((k) => ["lane_id", "agent_type", "status", "live", "start_ts", "end_ts", "track_id", "series", "node_id"].includes(k)))).toBe(true);
  });

  it("two sequential names on cee5cd27… stay 2 tracks / 2 boards; 2+1 synthesizer stays 1 track 3 lanes", () => {
    const events = [
      ev("tool Workflow", { tool: "Workflow", tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0" }),
      ev(
        "task_started",
        {
          task_id: "wq80ltdqd",
          tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0",
          task_type: "local_workflow",
          workflow_name: "auth-session-dashboard-review",
        },
        "working",
        1_787_403_740,
      ),
      ev("SubagentStart", { agent_id: "a4b038649de76b741", agent_type: "workflow-subagent" }, "working", 1_787_403_741),
      ev("SubagentStart", { agent_id: "ad7590958a54e1418", agent_type: "workflow-subagent" }, "working", 1_787_403_742),
      ev("SubagentStart", { agent_id: "ab5ca444586b035f7", agent_type: "workflow-subagent" }, "working", 1_787_403_743),
      ev("task_updated", { task_id: "wq80ltdqd", patch: { status: "killed", end_time: 1_787_403_750_285 } }),
      ev("tool Workflow", { tool: "Workflow", tool_use_id: "call-7c901579-b19c-4d30-9f76-b6caf54675f7-3" }),
      ev(
        "task_started",
        {
          task_id: "whsrtu0a3",
          tool_use_id: "call-7c901579-b19c-4d30-9f76-b6caf54675f7-3",
          task_type: "local_workflow",
          workflow_name: "dashboard-only-review",
        },
        "working",
        1_787_403_752,
      ),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: {
        tasks: [
          { task_id: "wq80ltdqd", status: "stopped", tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0" },
          { task_id: "whsrtu0a3", status: "running", tool_use_id: "call-7c901579-b19c-4d30-9f76-b6caf54675f7-3" },
        ],
      },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.tracks).toHaveLength(2);
    expect(g.tracks[0].lane_ids).toHaveLength(3);
    const boards = groupTracksByWorkflow(g, NOW_MS);
    expect(boards.map((b) => b.workflow_name)).toEqual([
      "auth-session-dashboard-review",
      "dashboard-only-review",
    ]);
    expect(boards.every((b) => b.tracks.length === 1)).toBe(true);
    expect(g.session_id).toBe("cee5cd27-209d-496e-9835-075e8d317b5f");
  });

  it("killed and completed windows, live now, and XSS labels stay data not markup", () => {
    const events = [
      ev(
        "task_started",
        {
          task_id: "wq80ltdqd",
          task_type: "local_workflow",
          workflow_name: "<img src=x onerror=alert(1)>",
        },
        "working",
        1_787_403_740,
      ),
      ev("task_updated", { task_id: "wq80ltdqd", patch: { status: "killed", end_time: 1_787_403_750_285 } }),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "stopped" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.domain.end_ts).toBeCloseTo(1_787_403_750.285, 5);
    expect(g.nodes[0].label).toBe("<img src=x onerror=alert(1)>");
    const liveEvents = [
      ev(
        "task_started",
        { task_id: "whsrtu0a3", task_type: "local_workflow", workflow_name: "dashboard-only-review" },
        "working",
        1_787_403_740,
      ),
    ];
    const liveSnap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "whsrtu0a3", status: "running" }] },
      events: liveEvents,
      now: NOW_MS,
    });
    const live = buildDagGraph({ snapshot: liveSnap, events: liveEvents, now: NOW_MS });
    expect(live.domain.end_ts).toBe(1_787_403_760);
    expect(liveDurationMs(liveSnap.tasks[0], NOW_MS)).toBe(20_000);
    const ticks = clockTicks(buildDagDomain(live, NOW_MS));
    expect(ticks.every((t) => /^\d{2}:\d{2}:\d{2}$/.test(t.label))).toBe(true);
  });
});
