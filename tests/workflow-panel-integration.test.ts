import { describe, expect, it } from "vitest";
import { foldTranscript } from "../web/src/lib/fold-transcript.js";
import {
  buildMonitorSnapshot,
  formatClock,
  formatDuration,
  progressShares,
  sharePercents,
  taskStatusLabel,
  tokenBarShares,
} from "../web/src/lib/workflow-monitor.js";
import {
  formatBurnRate,
  formatCacheHit,
  INCOMPLETE_LABEL,
  STALE_LABEL,
  UNSETTLED_LABEL,
} from "../web/src/lib/usage-viz.js";


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
    expect(snap.spark.label).toBe(INCOMPLETE_LABEL);
    expect(snap.spark.headline).toBe(46542 + 1490 + 256);
    expect(snap.spark.path).toBeNull();
    expect(snap.burn.label).toBe(INCOMPLETE_LABEL);
    expect(snap.burn.usd_per_min).toBeNull();
    expect(formatBurnRate(snap.burn.usd_per_min)).toBe("—");
    expect(snap.freshness.state).toBe("incomplete");
    expect(snap.freshness.label).toBe(INCOMPLETE_LABEL);
    expect(snap.cache.ratio).toBeCloseTo(256 / (46542 + 256 + 0), 8);
    expect(snap.cache.label).toBe(INCOMPLETE_LABEL);
    expect(formatCacheHit(snap.cache.ratio)).toMatch(/^\d+%$/);
    expect(snap.pie.form).toBe("empty");
    expect(snap.pie.label).toBe(INCOMPLETE_LABEL);
  });

  it("token spark uses only Result history; working without a new result is stale", () => {
    const snap = buildMonitorSnapshot({
      session: { ...session, last_kind: "working", usage_updated_ts: 1_787_403_750 },
      info: {
        usage_updated_ts: 1_787_403_750,
        usage_history: [
          {
            ts: 1_787_403_740,
            cost_usd: 0.12,
            input_tokens: 150,
            output_tokens: 28,
            cache_read_input_tokens: 6,
            cache_creation_input_tokens: 3,
          },
          {
            ts: 1_787_403_750,
            cost_usd: 0.270088,
            input_tokens: 46542,
            output_tokens: 1490,
            cache_read_input_tokens: 256,
            cache_creation_input_tokens: 0,
          },
        ],
      },
      tasks: {
        tasks: [{ task_id: "wq80ltdqd", status: "running", usage: { total_tokens: 13828 } }],
      },
    });
    expect(snap.freshness.state).toBe("stale");
    expect(snap.freshness.label).toBe(STALE_LABEL);
    expect(snap.freshness.updated_ts).toBe(1_787_403_750);
    expect(snap.spark.state).toBe("stale");
    expect(snap.spark.headline).toBe(46542 + 1490 + 256 + 0);
    expect(snap.spark.headline).not.toBe(13828);
    expect(snap.spark.points).toHaveLength(2);
    expect(snap.spark.path).toMatch(/^M/);
    expect(snap.spark.last).not.toBeNull();
    expect(snap.burn.state).toBe("stale");
    expect(snap.burn.label).toBe(STALE_LABEL);
    expect(snap.burn.usd_per_min).toBeCloseTo(((0.270088 - 0.12) / 10) * 60, 6);
    expect(formatBurnRate(snap.burn.usd_per_min)).toMatch(/^\$[\d.]+\/分$/);
    expect(snap.burn.usd_per_min).not.toBeCloseTo(0.270088 / ((Date.now() / 1000) - 1_787_403_750), 4);
    expect(snap.cache.state).toBe("stale");
    expect(snap.cache.ratio).toBeCloseTo(256 / (46542 + 256 + 0), 8);
    expect(snap.cache.ratio).not.toBeCloseTo(13828 / (46542 + 256), 4);
    expect(formatCacheHit(snap.cache.ratio)).toMatch(/^\d+%$/);
    expect(snap.pie.form).toBe("empty");
  });

  it("burn rate stays 尚未结算 until a second Result lands", () => {
    const snap = buildMonitorSnapshot({
      session: { ...session, last_kind: "turn_done", usage_updated_ts: 1_787_403_750 },
      info: {
        usage_updated_ts: 1_787_403_750,
        usage_history: [
          {
            ts: 1_787_403_750,
            cost_usd: 0.270088,
            input_tokens: 46542,
            output_tokens: 1490,
            cache_read_input_tokens: 256,
            cache_creation_input_tokens: 0,
          },
        ],
      },
    });
    expect(snap.freshness.state).toBe("settled");
    expect(snap.freshness.label).toBe("已结算");
    expect(snap.spark.headline).toBe(46542 + 1490 + 256);
    expect(snap.burn.usd_per_min).toBeNull();
    expect(snap.burn.label).toBe(UNSETTLED_LABEL);
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

  it("working without history/ts still draws live model_usage and labels 缺数据", () => {
    const snap = buildMonitorSnapshot({
      session: { ...session, last_kind: "working" },
      info: {
        cost_usd: 0.270088,
        input_tokens: 46542,
        output_tokens: 1490,
        cache_read_input_tokens: 256,
        cache_creation_input_tokens: 0,
        model_usage: {
          "claude-opus-4-6": { cost_usd: 0.18, input_tokens: 100 },
          "claude-sonnet-4-6": { cost_usd: 0.09, input_tokens: 40 },
        },
      },
    });
    expect(snap.freshness.state).toBe("incomplete");
    expect(snap.freshness.label).toBe(INCOMPLETE_LABEL);
    expect(snap.pie.form).toBe("pie");
    expect(snap.pie.state).toBe("incomplete");
    expect(snap.pie.slices).toHaveLength(2);
    expect(snap.pie.label).toBe(INCOMPLETE_LABEL);
    expect(snap.pie.total).toBeCloseTo(0.27, 8);
  });

  it("turn_done with two model costs draws a pie", () => {
    const snap = buildMonitorSnapshot({
      session: { ...session, last_kind: "turn_done", usage_updated_ts: 1_787_403_750 },
      info: {
        usage_updated_ts: 1_787_403_750,
        model_usage: {
          "claude-opus-4-6": { cost_usd: 0.18 },
          "claude-sonnet-4-6": { cost_usd: 0.09 },
        },
      },
    });
    expect(snap.freshness.state).toBe("settled");
    expect(snap.pie.form).toBe("pie");
    expect(snap.pie.slices).toHaveLength(2);
    expect(snap.pie.total).toBeCloseTo(0.27, 8);
    expect(snap.pie.paths).toHaveLength(2);
  });

  it("working after a Result keeps the last pie and marks it 过期", () => {
    const snap = buildMonitorSnapshot({
      session: { ...session, last_kind: "working", usage_updated_ts: 1_787_403_750 },
      info: {
        usage_updated_ts: 1_787_403_750,
        model_usage: {
          "claude-opus-4-6": { cost_usd: 0.18 },
          "claude-sonnet-4-6": { cost_usd: 0.09 },
        },
      },
    });
    expect(snap.freshness.state).toBe("stale");
    expect(snap.pie.state).toBe("stale");
    expect(snap.pie.label).toBe(STALE_LABEL);
    expect(snap.pie.form).toBe("pie");
    expect(snap.pie.slices).toHaveLength(2);
  });
});
