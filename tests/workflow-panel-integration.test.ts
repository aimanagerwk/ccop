import { describe, expect, it } from "vitest";
import { foldTranscript } from "../web/src/lib/fold-transcript.js";
import {
  buildDagDomain,
  buildDagGraph,
  clockTicks,
  groupTracksByWorkflow,
  xOf,
} from "../web/src/lib/workflow-dag.js";
import {
  buildMonitorSnapshot,
  clipDisplay,
  formatClock,
  formatDuration,
  progressShares,
  sharePercents,
  taskStatusLabel,
  tokenBarShares,
} from "../web/src/lib/workflow-monitor.js";

/** Shapes taken from WF-COVERAGE.md / wf-evidence.json — host RPC, not invented. */
const session = {
  id: "cee5cd27-209d-496e-9835-075e8d317b5f",
  name: "wf",
  title: null,
  pending: [{ tool_use_id: "call-7355", tool: "Workflow" }],
  last_turn: null,
  last_task: null,
  alive: true,
  last_kind: "working",
  enable_workflows: true,
  effort: "max",
  cost_usd: 0.270088,
  input_tokens: 46542,
  output_tokens: 1490,
  cache_read_input_tokens: 256,
  cache_creation_input_tokens: 0,
};

describe("panel integration: snapshot → labels a Chinese operator would see", () => {
  it("renders progress / duration / tokens from live tasks + info", () => {
    const snap = buildMonitorSnapshot({
      session,
      info: {
        enable_workflows: true,
        effort: "max",
        cost_usd: 0.270088,
        input_tokens: 46542,
        output_tokens: 1490,
        cache_read_input_tokens: 256,
        cache_creation_input_tokens: 0,
      },
      tasks: {
        ok: true,
        tasks: [
          {
            task_id: "wq80ltdqd",
            status: "running",
            summary: "Code-review Next.js auth, session, and dashboard paths",
            tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0",
          },
        ],
      },
      subagents: { ok: true, source: "sdk", subagents: ["a4b038649de76b741", "ad7590958a54e1418"] },
      workflows: {
        ok: true,
        slash_commands: ["__remote-workflow", "workflow-launch-exec"],
        skills: ["code-review"],
        plugins: [],
      },
      events: [
        {
          kind: "working",
          summary: "task_started",
          ts: 1_787_403_740,
          extra: {
            task_id: "wq80ltdqd",
            workflow_name: "auth-session-dashboard-review",
            task_type: "local_workflow",
          },
        },
      ],
      now: 1_787_403_760_000,
    });

    expect(taskStatusLabel(snap.tasks[0].status)).toBe("进行中");
    expect(formatDuration(snap.tasks[0].duration_ms)).toBe("20.0 秒");
    expect(sharePercents(progressShares(snap.progress))).toEqual([
      { key: "running", label: "进行中", n: 1, pct: 100 },
    ]);
    expect(tokenBarShares(snap.tokens).map((s) => s.key)).toEqual(["input", "output", "cache"]);
    expect(snap.agents).toHaveLength(2);
    expect(snap.pending).toBe(1);
  });

  it("timeline rows keep clock + tool card fields from classified events", () => {
    const rows = foldTranscript([
      { kind: "sent", summary: "ultracode: review auth", ts: 1_787_403_750.285 },
      {
        kind: "working",
        summary: "tool Workflow",
        ts: 1_787_403_751,
        extra: { tool: "Workflow", input: { name: "auth-session-dashboard-review" } },
      },
      {
        kind: "turn_done",
        summary: "result message (turn, not task)",
        ts: 1_787_403_760,
        extra: { result: "**WS.** done" },
      },
    ]);
    expect(rows[0]).toMatchObject({ type: "user", ts: 1_787_403_750.285 });
    expect(formatClock(rows[0].ts)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(rows[1]).toMatchObject({ type: "tool", name: "Workflow" });
    expect(rows[2]).toMatchObject({ type: "assistant", text: "**WS.** done" });
  });
});

describe("panel integration: snapshot → DAG labels a Chinese operator would see", () => {
  const NOW_MS = 1_787_403_760_000;

  it("two sequential reviews become two stacked boards with HH:MM:SS ticks", () => {
    const events = [
      {
        kind: "working",
        summary: "tool Workflow",
        ts: 1_787_403_739,
        extra: { tool: "Workflow", tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0" },
      },
      {
        kind: "working",
        summary: "task_started",
        ts: 1_787_403_740,
        extra: {
          task_id: "wq80ltdqd",
          tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0",
          task_type: "local_workflow",
          workflow_name: "auth-session-dashboard-review",
        },
      },
      {
        kind: "working",
        summary: "SubagentStart",
        ts: 1_787_403_741,
        extra: { agent_id: "a4b038649de76b741", agent_type: "workflow-subagent" },
      },
      {
        kind: "working",
        summary: "SubagentStart",
        ts: 1_787_403_742,
        extra: { agent_id: "ad7590958a54e1418", agent_type: "workflow-subagent" },
      },
      {
        kind: "working",
        summary: "SubagentStart",
        ts: 1_787_403_743,
        extra: { agent_id: "ab5ca444586b035f7", agent_type: "workflow-subagent" },
      },
      {
        kind: "working",
        summary: "task_updated",
        ts: 1_787_403_750.285,
        extra: { task_id: "wq80ltdqd", patch: { status: "killed", end_time: 1_787_403_750_285 } },
      },
      {
        kind: "working",
        summary: "tool Workflow",
        ts: 1_787_403_751,
        extra: { tool: "Workflow", tool_use_id: "call-7c901579-b19c-4d30-9f76-b6caf54675f7-3" },
      },
      {
        kind: "working",
        summary: "task_started",
        ts: 1_787_403_752,
        extra: {
          task_id: "whsrtu0a3",
          tool_use_id: "call-7c901579-b19c-4d30-9f76-b6caf54675f7-3",
          task_type: "local_workflow",
          workflow_name: "dashboard-only-review",
        },
      },
    ];
    const snap = buildMonitorSnapshot({
      session,
      tasks: {
        tasks: [
          { task_id: "wq80ltdqd", status: "stopped", tool_use_id: "call-7355f38b-a24e-4c11-81e3-fb50b8248049-0" },
          { task_id: "whsrtu0a3", status: "running", tool_use_id: "call-7c901579-b19c-4d30-9f76-b6caf54675f7-3" },
        ],
      },
      events,
      now: NOW_MS,
    });
    const dag = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    const domain = buildDagDomain(dag, NOW_MS);
    const ticks = clockTicks(domain);
    const boards = groupTracksByWorkflow(dag, NOW_MS);

    expect(taskStatusLabel(dag.tracks[0].status)).toBe("已终止");
    expect(taskStatusLabel(dag.tracks[1].status)).toBe("进行中");
    expect(boards.map((b) => b.workflow_name)).toEqual([
      "auth-session-dashboard-review",
      "dashboard-only-review",
    ]);
    expect(boards.every((b) => b.layout === "single")).toBe(true);
    expect(boards[0].tracks[0].lane_ids).toHaveLength(3);
    expect(dag.edges).toEqual([
      { id: "succeeds:wf:wq80ltdqd->wf:whsrtu0a3", from: "wf:wq80ltdqd", to: "wf:whsrtu0a3", kind: "succeeds" },
    ]);
    expect(domain).toEqual({ empty: false, min: 1_787_403_740, max: 1_787_403_760 });
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((t) => t.label === formatClock(t.ts) && /^\d{2}:\d{2}:\d{2}$/.test(t.label))).toBe(true);
    expect(xOf(domain, 1_787_403_740)).toBe(0);
    expect(xOf(domain, 1_787_403_760)).toBe(1);
  });

  it("overlapping same-name runs share one side-by-side board and keep series-1", () => {
    const events = [
      {
        kind: "working",
        summary: "task_started",
        ts: 1_787_403_740,
        extra: { task_id: "tA", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
      },
      {
        kind: "working",
        summary: "task_started",
        ts: 1_787_403_741,
        extra: { task_id: "tB", task_type: "local_workflow", workflow_name: "auth-session-dashboard-review" },
      },
    ];
    const snap = buildMonitorSnapshot({
      session,
      tasks: { tasks: [{ task_id: "tA", status: "running" }, { task_id: "tB", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const dag = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    const boards = groupTracksByWorkflow(dag, NOW_MS);
    expect(boards).toHaveLength(1);
    expect(boards[0].layout).toBe("side-by-side");
    expect(boards[0].tracks.every((t) => t.series === "series-1")).toBe(true);
    expect(clipDisplay(boards[0].workflow_name, 64)).toBe("auth-session-dashboard-review");
  });

  it("HTML workflow_name stays clipped text, never a markup wrapper", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const events = [
      {
        kind: "working",
        summary: "task_started",
        ts: 1_787_403_740,
        extra: { task_id: "wq80ltdqd", task_type: "local_workflow", workflow_name: payload },
      },
    ];
    const snap = buildMonitorSnapshot({
      session,
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "running" }] },
      events,
      now: NOW_MS,
    });
    const dag = buildDagGraph({ snapshot: snap, events, now: NOW_MS });
    const boards = groupTracksByWorkflow(dag, NOW_MS);
    expect(boards[0].workflow_name).toBe(payload);
    expect(clipDisplay(boards[0].workflow_name, 64)).toBe(payload);
    expect(clockTicks(buildDagDomain(dag, NOW_MS)).every((t) => !t.label.includes("<"))).toBe(true);
  });
});
