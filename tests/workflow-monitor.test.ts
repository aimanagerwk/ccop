import { describe, expect, it } from "vitest";
import { extractUsageFromResult, usageStatusFields } from "../src/usage.js";
import {
  asSubagentRows,
  asTaskRows,
  buildMonitorSnapshot,
  clipDisplay,
  formatDuration,
  formatTokens,
  formatUsd,
  liveDurationMs,
  parseTaskUsage,
  taskStatusLabel,
} from "../web/src/lib/workflow-monitor.js";

const NOW_MS = 1_787_403_760_000;

function ev(
  summary: string,
  extra: Record<string, unknown> = {},
  kind = "working",
  ts = 1_787_403_750,
) {
  return { kind, summary, extra, ts };
}

describe("parseTaskUsage", () => {
  it("reads observed task_notification usage keys only", () => {
    expect(parseTaskUsage({ total_tokens: 13828, tool_uses: 3, duration_ms: 15029 })).toEqual({
      total_tokens: 13828,
      tool_uses: 3,
      duration_ms: 15029,
    });
  });

  it("ignores non-objects and non-finite numbers", () => {
    expect(parseTaskUsage(null)).toBeUndefined();
    expect(parseTaskUsage("x")).toBeUndefined();
    expect(parseTaskUsage({ total_tokens: "nope", tool_uses: Number.NaN })).toBeUndefined();
  });
});

describe("asTaskRows / asSubagentRows", () => {
  it("accepts tasks RPC envelope and a bare array", () => {
    const row = { task_id: "wq80ltdqd", status: "running", summary: "review", tool_use_id: "call-1" };
    expect(asTaskRows({ ok: true, tasks: [row] })).toEqual([row]);
    expect(asTaskRows([row])).toEqual([row]);
  });

  it("drops rows without task_id and non-objects", () => {
    expect(asTaskRows({ tasks: [null, 1, { status: "running" }, { task_id: "t1", status: "running" }] })).toEqual([
      { task_id: "t1", status: "running" },
    ]);
  });

  it("keeps only the first line of a long task summary", () => {
    const rows = asTaskRows([
      { task_id: "t1", status: "completed", summary: "# Operator web UI map\n\nSingle-page Next/React console." },
    ]);
    expect(rows[0].summary).toBe("# Operator web UI map");
    expect(rows[0].summary?.includes("\n")).toBe(false);
  });

  it("reads sdk string ids and tracked objects", () => {
    expect(asSubagentRows({ source: "sdk", subagents: ["a4b038649de76b741"] })).toEqual([
      { agent_id: "a4b038649de76b741", status: "running" },
    ]);
    expect(
      asSubagentRows({
        source: "tracked",
        subagents: [{ agent_id: "a1", agent_type: "workflow-subagent", status: "stopped" }],
      }),
    ).toEqual([{ agent_id: "a1", agent_type: "workflow-subagent", status: "stopped" }]);
  });

  it("ignores prototype-polluting keys and functions", () => {
    const polluted = JSON.parse('{"task_id":"t1","status":"running","__proto__":{"hacked":true}}');
    const rows = asTaskRows([polluted]);
    expect(rows[0].task_id).toBe("t1");
    expect(Object.prototype.hasOwnProperty.call(rows[0], "hacked")).toBe(false);
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
    expect(asSubagentRows({ subagents: [{ agent_id: () => "no", status: "running" }] })).toEqual([]);
  });
});

describe("formatters", () => {
  it("labels known statuses in Chinese and leaves unknown as-is", () => {
    expect(taskStatusLabel("running")).toBe("进行中");
    expect(taskStatusLabel("completed")).toBe("已完成");
    expect(taskStatusLabel("failed")).toBe("失败");
    expect(taskStatusLabel("killed")).toBe("已终止");
    expect(taskStatusLabel("stopped")).toBe("已停止");
    expect(taskStatusLabel("pending")).toBe("排队");
    expect(taskStatusLabel("background_gone")).toBe("已退出");
    expect(taskStatusLabel("mystery")).toBe("mystery");
  });

  it("formats duration / tokens / usd without inventing a unit", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(800)).toBe("0.8 秒");
    expect(formatDuration(12400)).toBe("12.4 秒");
    expect(formatDuration(185000)).toBe("3 分 05 秒");
    expect(formatDuration(3723000)).toBe("1 小时 02 分");
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(13828)).toBe("13,828");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(0.270088)).toBe("$0.27");
  });

  it("clips display text and never returns raw HTML wrappers", () => {
    expect(clipDisplay("<img src=x onerror=alert(1)>", 80)).toBe("<img src=x onerror=alert(1)>");
    expect(clipDisplay("a".repeat(50), 8)).toBe("aaaaaaa…");
  });
});

describe("buildMonitorSnapshot — unit", () => {
  it("returns empty progress when nothing is present", () => {
    const snap = buildMonitorSnapshot({ session: { id: "s1", name: "n", title: null, pending: [], last_turn: null, last_task: null } });
    expect(snap.session_id).toBe("s1");
    expect(snap.progress).toEqual({
      total: 0,
      running: 0,
      done: 0,
      failed: 0,
      agents_running: 0,
      agents_total: 0,
    });
    expect(snap.context.used).toBeNull();
    expect(snap.tokens.cost_usd).toBeNull();
  });

  it("prefers info token fields over status", () => {
    const snap = buildMonitorSnapshot({
      session: {
        id: "s1",
        name: "n",
        title: null,
        pending: [],
        last_turn: null,
        last_task: null,
        input_tokens: 1,
        output_tokens: 2,
        cost_usd: 0.01,
      },
      info: {
        input_tokens: 46542,
        output_tokens: 1490,
        cache_read_input_tokens: 256,
        cache_creation_input_tokens: 0,
        cost_usd: 0.270088,
        enable_workflows: true,
        effort: "max",
      },
    });
    expect(snap.tokens.input_tokens).toBe(46542);
    expect(snap.tokens.output_tokens).toBe(1490);
    expect(snap.context.used).toBe(46800 - 2);
    expect(snap.context.used).toBe(46542 + 256 + 0);
    expect(snap.enable_workflows).toBe(true);
    expect(snap.effort).toBe("max");
  });

  it("computes live duration from started_ts when usage has no duration_ms", () => {
    const snap = buildMonitorSnapshot({
      session: { id: "s1", name: "n", title: null, pending: [], last_turn: null, last_task: null, alive: true },
      tasks: { tasks: [{ task_id: "t1", status: "running", summary: "go" }] },
      events: [ev("task_started", { task_id: "t1", workflow_name: "login-page-review", task_type: "local_workflow" }, "working", 1_787_403_750)],
      now: NOW_MS,
    });
    expect(snap.tasks[0].live).toBe(true);
    expect(snap.tasks[0].workflow_name).toBe("login-page-review");
    expect(snap.tasks[0].task_type).toBe("local_workflow");
    expect(liveDurationMs(snap.tasks[0], NOW_MS)).toBe(10_000);
  });

  it("uses usage.duration_ms for a completed task", () => {
    const snap = buildMonitorSnapshot({
      session: { id: "s1", name: "n", title: null, pending: [], last_turn: null, last_task: null },
      tasks: {
        tasks: [
          {
            task_id: "wd3eoqk8l",
            status: "completed",
            usage: { total_tokens: 13828, tool_uses: 3, duration_ms: 15029 },
          },
        ],
      },
    });
    expect(snap.tasks[0].live).toBe(false);
    expect(snap.tasks[0].duration_ms).toBe(15029);
    expect(snap.progress.done).toBe(1);
  });
});

describe("buildMonitorSnapshot — integration against observed RPC shapes", () => {
  it("merges status/info/tasks/workflows/subagents + task_* events from WF-COVERAGE", () => {
    const snap = buildMonitorSnapshot({
      session: {
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
        input_tokens: 46542,
        output_tokens: 1490,
        cache_read_input_tokens: 256,
        cache_creation_input_tokens: 0,
        cost_usd: 0.270088,
        model_usage: {
          "grok-4.6": {
            inputTokens: 46542,
            outputTokens: 1490,
            cacheReadInputTokens: 256,
            cacheCreationInputTokens: 0,
            costUSD: 0.270088,
          },
        },
      },
      info: {
        enable_workflows: true,
        effort: "max",
        cost_usd: 0.270088,
        input_tokens: 46542,
        output_tokens: 1490,
        cache_read_input_tokens: 256,
        cache_creation_input_tokens: 0,
        model_usage: {
          "grok-4.6": {
            inputTokens: 46542,
            outputTokens: 1490,
            cacheReadInputTokens: 256,
            cacheCreationInputTokens: 0,
            costUSD: 0.270088,
          },
        },
        skills: ["code-review", "run"],
        slash_commands: ["__remote-workflow", "workflow-launch-exec"],
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
        skills: ["code-review", "run"],
        slash_commands: ["__remote-workflow", "workflow-launch-exec"],
        plugins: [],
        note: "listed from session advertise (init); host does not invoke workflows — the model does",
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
        ev("task_progress", {
          task_id: "wq80ltdqd",
          description: "Review: review-auth-session",
          last_tool_name: "review-auth-session",
          usage: { tool_uses: 2 },
        }),
        ev("SubagentStart", { agent_id: "a4b038649de76b741", agent_type: "workflow-subagent" }),
        ev("SubagentStart", { agent_id: "ad7590958a54e1418", agent_type: "workflow-subagent" }),
      ],
      now: NOW_MS,
    });

    expect(snap.session_id).toBe("cee5cd27-209d-496e-9835-075e8d317b5f");
    expect(snap.alive).toBe(true);
    expect(snap.kind).toBe("working");
    expect(snap.enable_workflows).toBe(true);
    expect(snap.tasks).toHaveLength(1);
    expect(snap.tasks[0]).toMatchObject({
      task_id: "wq80ltdqd",
      status: "running",
      live: true,
      workflow_name: "auth-session-dashboard-review",
      task_type: "local_workflow",
      last_tool: "review-auth-session",
    });
    expect(snap.tasks[0].usage?.tool_uses).toBe(2);
    expect(liveDurationMs(snap.tasks[0], NOW_MS)).toBe(20_000);
    expect(snap.agents.map((a) => a.agent_id)).toEqual(["a4b038649de76b741", "ad7590958a54e1418"]);
    expect(snap.agents.every((a) => a.live && a.agent_type === "workflow-subagent")).toBe(true);
    expect(snap.progress).toEqual({
      total: 1,
      running: 1,
      done: 0,
      failed: 0,
      agents_running: 2,
      agents_total: 2,
    });
    expect(snap.context.used).toBe(46798);
    expect(snap.models[0]).toMatchObject({ model: "grok-4.6", input: 46542, output: 1490 });
    expect(snap.advertise.slash_commands).toContain("workflow-launch-exec");
  });

  it("applies task_updated killed + end_time (ms) from a live stop", () => {
    const snap = buildMonitorSnapshot({
      session: { id: "s1", name: "n", title: null, pending: [], last_turn: null, last_task: null, alive: true },
      tasks: { tasks: [{ task_id: "wq80ltdqd", status: "stopped" }] },
      events: [
        ev("task_started", { task_id: "wq80ltdqd", workflow_name: "auth-session-dashboard-review" }, "working", 1_787_403_740.285),
        ev("task_updated", { task_id: "wq80ltdqd", patch: { status: "killed", end_time: 1_787_403_750_285 } }),
      ],
      now: NOW_MS,
    });
    expect(snap.tasks[0].status).toBe("killed");
    expect(snap.tasks[0].live).toBe(false);
    expect(snap.tasks[0].ended_ts).toBeCloseTo(1_787_403_750.285, 5);
    expect(snap.tasks[0].duration_ms).toBe(10_000);
    expect(snap.progress.failed).toBe(1);
  });

  it("keeps a completed notification usage and does not sum later status tokens into the task", () => {
    const snap = buildMonitorSnapshot({
      session: {
        id: "s1",
        name: "n",
        title: null,
        pending: [],
        last_turn: null,
        last_task: null,
        input_tokens: 400,
        output_tokens: 80,
      },
      tasks: {
        tasks: [
          {
            task_id: "wd3eoqk8l",
            status: "completed",
            usage: { total_tokens: 13828, tool_uses: 3, duration_ms: 15029 },
          },
        ],
      },
      events: [
        ev("task completed", { task_id: "wd3eoqk8l", status: "completed", usage: { total_tokens: 13828, duration_ms: 15029 } }, "task_done"),
      ],
    });
    expect(snap.tasks[0].usage?.total_tokens).toBe(13828);
    expect(snap.tokens.input_tokens).toBe(400);
    expect(snap.progress.done).toBe(1);
  });

  it("keeps session cost/tokens null mid-turn when only task usage is present", () => {
    const snap = buildMonitorSnapshot({
      session: { id: "s1", name: "n", title: null, pending: [], last_turn: null, last_task: null },
      info: { cost_usd: null, input_tokens: null, output_tokens: null, model_usage: null },
      tasks: {
        tasks: [
          {
            task_id: "ws1668ueh",
            status: "running",
            usage: { total_tokens: 13828, tool_uses: 3, duration_ms: 15029 },
          },
        ],
      },
    });
    expect(snap.tokens.cost_usd).toBeNull();
    expect(snap.tokens.input_tokens).toBeNull();
    expect(snap.tokens.output_tokens).toBeNull();
    expect(snap.tasks[0].usage?.total_tokens).toBe(13828);
  });

  it("does not sum two tasks' total_tokens into session input_tokens", () => {
    const snap = buildMonitorSnapshot({
      session: { id: "s1", name: "n", title: null, pending: [], last_turn: null, last_task: null },
      tasks: {
        tasks: [
          { task_id: "a", status: "completed", usage: { total_tokens: 100, tool_uses: 1, duration_ms: 10 } },
          { task_id: "b", status: "completed", usage: { total_tokens: 200, tool_uses: 2, duration_ms: 20 } },
        ],
      },
    });
    expect(snap.tokens.input_tokens).toBeNull();
    expect(snap.tokens.cost_usd).toBeNull();
    expect(snap.tasks.map((t) => t.usage?.total_tokens)).toEqual([100, 200]);
  });

  it("replays wf-evidence snap 9 vs snap 10: working+task usage does not fill session cost", () => {
    const mid = buildMonitorSnapshot({
      session: {
        id: "a664542d-ce8d-4b95-b381-e29b589e0ee1",
        name: "wf-review",
        title: null,
        pending: [],
        last_turn: null,
        last_task: null,
        last_kind: "working",
      },
      info: { cost_usd: null, model_usage: null, enable_workflows: true },
      tasks: {
        tasks: [
          {
            task_id: "ws1668ueh",
            status: "running",
            usage: { total_tokens: 0, tool_uses: 0, duration_ms: 3264 },
          },
        ],
      },
    });
    expect(mid.tokens.cost_usd).toBeNull();
    expect(mid.tokens.input_tokens).toBeNull();
    expect(mid.tasks[0].usage).toEqual({ total_tokens: 0, tool_uses: 0, duration_ms: 3264 });

    const after = buildMonitorSnapshot({
      session: {
        id: "a664542d-ce8d-4b95-b381-e29b589e0ee1",
        name: "wf-review",
        title: null,
        pending: [],
        last_turn: null,
        last_task: null,
        last_kind: "working",
      },
      info: {
        cost_usd: 0.403439,
        model_usage: {
          "grok-4.6": {
            inputTokens: 64038,
            outputTokens: 2201,
            cacheReadInputTokens: 56448,
            cacheCreationInputTokens: 0,
            costUSD: 0.403439,
          },
        },
        enable_workflows: true,
      },
      tasks: {
        tasks: [
          {
            task_id: "ws1668ueh",
            status: "stopped",
            usage: { total_tokens: 0, tool_uses: 4, duration_ms: 7578 },
          },
        ],
      },
    });
    expect(after.tokens.cost_usd).toBe(0.403439);
    expect(after.tokens.input_tokens).toBeNull();
    expect(after.models[0]).toMatchObject({ model: "grok-4.6", input: 64038, output: 2201 });
    expect(after.tasks[0].usage?.tool_uses).toBe(4);
  });

  it("mid-turn extract+usageStatusFields keeps tokens/context non-null when the object had numbers", () => {
    const midTurn = {
      last_kind: "working",
      total_cost_usd: 0.12,
      usage: { input_tokens: 10, output_tokens: 4 },
      modelUsage: {
        "claude-opus": {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 3,
          costUSD: 0.1,
        },
        "claude-haiku": {
          inputTokens: 50,
          outputTokens: 8,
          cacheReadInputTokens: 1,
          cacheCreationInputTokens: 0,
          costUSD: 0.02,
        },
      },
    };
    const fields = usageStatusFields(extractUsageFromResult(midTurn));
    const snap = buildMonitorSnapshot({
      session: { id: "s1", name: "n", title: null, pending: [], last_turn: null, last_task: null, last_kind: "working" },
      info: fields,
      tasks: { tasks: [{ task_id: "t1", status: "running", usage: { total_tokens: 13828, tool_uses: 1, duration_ms: 10 } }] },
    });
    const tokenVals = [
      snap.tokens.cost_usd,
      snap.tokens.input_tokens,
      snap.tokens.output_tokens,
      snap.tokens.cache_read_input_tokens,
      snap.tokens.cache_creation_input_tokens,
    ];
    const contextVals = [snap.context.used, snap.context.input, snap.context.cache_read, snap.context.cache_creation];
    expect(tokenVals.every((n) => n == null)).toBe(false);
    expect(contextVals.every((n) => n == null)).toBe(false);
    expect(snap.tokens.cost_usd).toBe(0.12);
    expect(snap.tokens.input_tokens).toBe(150);
    expect(snap.tokens.output_tokens).toBe(28);
    expect(snap.context.used).toBe(150 + 5 + 3 + 1);
    expect(snap.tasks[0].usage?.total_tokens).toBe(13828);
  });

  it("later ResultMessage replaces mid-turn usage (latest wins — do not sum)", () => {
    const midTurn = {
      last_kind: "working",
      total_cost_usd: 0.12,
      usage: { input_tokens: 10, output_tokens: 4 },
      modelUsage: {
        "claude-opus": {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 3,
          costUSD: 0.1,
        },
      },
    };
    let usage = extractUsageFromResult(midTurn);
    usage =
      extractUsageFromResult({
        type: "assistant",
        message: { usage: { input_tokens: 64038, output_tokens: 2201 } },
      }) ?? usage;
    usage =
      extractUsageFromResult({
        type: "system",
        subtype: "task_progress",
        usage: { total_tokens: 13828 },
      }) ?? usage;
    const later = {
      type: "result",
      total_cost_usd: 0.4,
      usage: { input_tokens: 3, output_tokens: 1 },
      modelUsage: {
        "claude-opus": {
          inputTokens: 400,
          outputTokens: 80,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 6,
          costUSD: 0.4,
        },
      },
    };
    usage = extractUsageFromResult(later) ?? usage;
    const snap = buildMonitorSnapshot({
      session: { id: "s1", name: "n", title: null, pending: [], last_turn: null, last_task: null },
      info: usageStatusFields(usage),
    });
    expect(snap.tokens.cost_usd).toBe(0.4);
    expect(snap.tokens.input_tokens).toBe(400);
    expect(snap.tokens.output_tokens).toBe(80);
    expect(snap.tokens.cost_usd).not.toBe(0.52);
    expect(snap.tokens.input_tokens).not.toBe(500);
    expect(snap.context.used).toBe(400 + 10 + 6);
  });
});
