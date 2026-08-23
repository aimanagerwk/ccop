import { describe, expect, it } from "vitest";
import { buildMonitorSnapshot, clipDisplay } from "../web/src/lib/workflow-monitor.js";
import { assignSwimlanes, buildDagDomain, buildDagGraph, clockTicks, groupTracksByWorkflow } from "../web/src/lib/workflow-dag.js";

const NOW_MS = 1_787_403_760_000;

function ev(
  summary: string,
  extra: Record<string, unknown> = {},
  kind = "working",
  ts = 1_787_403_750,
) {
  return { kind, summary, extra, ts };
}

function session(id = "s1") {
  return { id, name: "n", title: null, pending: [], last_turn: null, last_task: null };
}

describe("workflow-dag security — F1", () => {
  it("keeps only allowlisted node keys from a proto-polluted extra/usage", () => {
    const extra = JSON.parse(
      '{"task_id":"wq80ltdqd","task_type":"local_workflow","workflow_name":"auth-session-dashboard-review","eval":"no","extra_secret":"drop","__proto__":{"hacked":true}}',
    );
    const events = [ev("task_started", extra, "working", 1_787_403_740)];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: {
        tasks: [
          {
            task_id: "wq80ltdqd",
            status: "running",
            usage: JSON.parse('{"total_tokens":1,"extra_secret":"x","__proto__":{"hacked":true}}'),
          },
        ],
      },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.nodes).toHaveLength(1);
    expect(Object.keys(g.nodes[0]).sort()).toEqual(
      [
        "duration_ms",
        "id",
        "kind",
        "label",
        "live",
        "ref_id",
        "series",
        "start_ts",
        "status",
        "status_tone",
        "task_type",
        "track_id",
        "usage",
        "workflow_name",
      ].sort(),
    );
    expect((g.nodes[0] as { eval?: string }).eval).toBeUndefined();
    expect((g.nodes[0] as { extra_secret?: string }).extra_secret).toBeUndefined();
    expect(g.nodes[0].usage).toEqual({ total_tokens: 1 });
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it("drops function / empty / non-string task_id", () => {
    const events = [
      ev("task_started", { task_id: "", task_type: "local_workflow", workflow_name: "n" }),
      ev("task_started", { task_id: "   ", task_type: "local_workflow", workflow_name: "n" }),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: {
        tasks: [
          { task_id: "", status: "running" },
          { status: "running" },
          { task_id: "ok", status: "running" },
        ],
      },
      events: [ev("task_started", { task_id: "ok", task_type: "local_workflow", workflow_name: "n" })],
    });
    const g = buildDagGraph({ snapshot: snap, events: [ev("task_started", { task_id: "ok", task_type: "local_workflow", workflow_name: "n" })] });
    expect(g.nodes.map((n) => n.ref_id)).toEqual(["ok"]);
    void events;
  });

  it("stores a raw HTML label and never wraps it as markup", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const events = [ev("task_started", { task_id: "t1", task_type: "local_workflow", workflow_name: payload })];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "t1", status: "running" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.nodes[0].label).toBe(payload);
    expect(clipDisplay(g.nodes[0].label, 80)).toBe(payload);
  });

  it("does not forward extra.input.script or unknown patch keys onto the node", () => {
    const events = [
      ev("tool Workflow", { tool: "Workflow", tool_use_id: "call-1", input: { script: "export const meta = {}" } }),
      ev(
        "task_started",
        { task_id: "t1", tool_use_id: "call-1", task_type: "local_workflow", workflow_name: "n", spawn_depth: 1 },
        "working",
        10,
      ),
      ev("task_updated", {
        task_id: "t1",
        patch: { status: "killed", end_time: 1_787_403_750_285, secret: "nope", start_time: 1 },
      }),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "t1", status: "stopped" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.nodes).toHaveLength(1);
    expect((g.nodes[0] as { script?: string }).script).toBeUndefined();
    expect((g.nodes[0] as { secret?: string }).secret).toBeUndefined();
    expect((g.nodes[0] as { spawn_depth?: number }).spawn_depth).toBeUndefined();
    expect((g.nodes[0] as { start_time?: number }).start_time).toBeUndefined();
    expect(g.nodes[0].status).toBe("killed");
    expect(g.nodes[0].end_ts).toBeCloseTo(1_787_403_750.285, 5);
  });
});

describe("workflow-dag security — F2", () => {
  it("keeps only allowlisted agent fields from a proto-polluted extra", () => {
    const extra = JSON.parse(
      '{"agent_id":"a4b038649de76b741","agent_type":"workflow-subagent","token":"leak","eval":"no","__proto__":{"hacked":true}}',
    );
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
        "working",
        1_787_403_740,
      ),
      ev("SubagentStart", extra, "working", 1_787_403_741),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.lanes).toHaveLength(1);
    expect(Object.keys(g.lanes[0]).sort()).toEqual(
      ["lane_id", "agent_type", "status", "live", "start_ts", "track_id", "series", "node_id"].sort(),
    );
    expect((g.lanes[0] as { token?: string }).token).toBeUndefined();
    expect((g.nodes.find((n) => n.kind === "agent") as { eval?: string } | undefined)?.eval).toBeUndefined();
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it("drops function agent_id and keeps literal constructor as ag:constructor", () => {
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "n" },
        "working",
        1_787_403_740,
      ),
      ev("SubagentStart", { agent_id: "constructor", agent_type: "workflow-subagent" }, "working", 1_787_403_741),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      subagents: { subagents: [{ agent_id: () => "no", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.nodes.filter((n) => n.kind === "agent").map((n) => n.id)).toEqual(["ag:constructor"]);
  });

  it("color_class stays on the four-string allowlist", () => {
    const allowed = new Set(["series-1", "series-2", "series-3", "other"]);
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "n" },
        "working",
        1_787_403_740,
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        ev("SubagentStart", { agent_id: `a${i}`, agent_type: "workflow-subagent" }, "working", 1_787_403_741 + i),
      ),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const layout = assignSwimlanes({ tasks: snap.tasks, agents: snap.agents, events, now: NOW_MS });
    for (const l of layout.lanes) expect(allowed.has(l.color_class)).toBe(true);
    for (const l of buildDagGraph({ snapshot: snap, events, now: NOW_MS }).lanes) {
      expect(allowed.has(l.series)).toBe(true);
    }
  });
});

describe("workflow-dag security — F3", () => {
  it("keeps only allowlisted track/node keys from a polluted extra", () => {
    const extra = JSON.parse(
      '{"task_id":"wq80ltdqd","task_type":"local_workflow","workflow_name":"auth-session-dashboard-review","eval":"no","extra_secret":"drop","__proto__":{"hacked":true}}',
    );
    const events = [ev("task_started", extra, "working", 1_787_403_740)];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const g = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    expect(g.tracks).toHaveLength(1);
    expect(Object.keys(g.tracks[0]).sort()).toEqual(
      ["track_id", "workflow_name", "start_ts", "status", "live", "series", "node_id", "lane_ids"].sort(),
    );
    expect((g.tracks[0] as { eval?: string }).eval).toBeUndefined();
    expect((g.tracks[0] as { extra_secret?: string }).extra_secret).toBeUndefined();
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it("series stays on the four-string allowlist", () => {
    const allowed = new Set(["series-1", "series-2", "series-3", "other"]);
    const names = ["auth-session-dashboard-review", "dashboard-only-review", "login-page-review", "fourth-review"];
    const events = names.map((workflow_name, i) =>
      ev(
        "task_started",
        { task_id: `t${i}`, task_type: "local_workflow", workflow_name },
        "working",
        1_787_403_740 + i,
      ),
    );
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: names.map((_, i) => ({ task_id: `t${i}`, status: "running" })) },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    for (const t of g.tracks) expect(allowed.has(t.series)).toBe(true);
    for (const b of groupTracksByWorkflow(g)) {
      for (const t of b.tracks) expect(allowed.has(t.series)).toBe(true);
    }
  });

  it("stores a raw HTML workflow_name on the board and never wraps it", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const events = [ev("task_started", { task_id: "t1", task_type: "local_workflow", workflow_name: payload })];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "t1", status: "running" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    expect(g.tracks[0].workflow_name).toBe(payload);
    expect(clipDisplay(g.tracks[0].workflow_name || "", 80)).toBe(payload);
    expect(groupTracksByWorkflow(g)[0].workflow_name).toBe(payload);
  });
});

describe("workflow-dag security — F4", () => {
  it("tick labels are digits and colons only, never workflow_name or extra HTML", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const events = [
      ev(
        "task_started",
        { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: payload },
        "working",
        1_787_403_740,
      ),
      ev("task_updated", { task_id: "wq80ltdqd", patch: { status: "killed", end_time: 1_787_403_760_000 } }),
    ];
    const snap = buildMonitorSnapshot({
      session: session(),
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "stopped" }] },
      events,
    });
    const g = buildDagGraph({ snapshot: snap, events });
    const ticks = clockTicks(buildDagDomain(g));
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t.label).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      expect(t.label.includes("<")).toBe(false);
      expect(t.label.includes("img")).toBe(false);
    }
  });

  it("inherited proto timestamps do not become domain points", () => {
    (Object.prototype as { ts?: number }).ts = 99;
    try {
      const events = [
        ev(
          "task_started",
          { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: "n" },
          "working",
          Number.NaN,
        ),
      ];
      const snap = buildMonitorSnapshot({
        session: session(),
        tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
        events,
      });
      const g = buildDagGraph({ snapshot: snap, events });
      expect(g.domain).toEqual({});
      expect(({} as { ts?: number }).ts).toBe(99);
    } finally {
      delete (Object.prototype as { ts?: unknown }).ts;
    }
  });

  it("now=0 never becomes 1970", () => {
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
    expect(g.domain.start_ts).toBeGreaterThan(1e9);
    expect(g.domain.end_ts).toBeGreaterThan(1e9);
  });
});
