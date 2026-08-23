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
