import { describe, expect, it } from "vitest";
import {
  asSubagentRows,
  asTaskRows,
  buildMonitorSnapshot,
  clipDisplay,
  formatDuration,
  formatTokens,
  formatUsd,
  parseTaskUsage,
  progressShares,
  sharePercents,
  tokenBarShares,
} from "../web/src/lib/workflow-monitor.js";

describe("workflow-monitor security", () => {
  it("parseTaskUsage yields only the three known keys", () => {
    const polluted = JSON.parse('{"total_tokens":1,"extra_secret":"x","__proto__":{"hacked":true},"constructor":{"name":"hack"}}');
    expect(parseTaskUsage(polluted)).toEqual({ total_tokens: 1 });
    expect(Object.keys(parseTaskUsage(polluted) || {})).toEqual(["total_tokens"]);
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it("does not copy unknown keys from a task RPC row", () => {
    const rows = asTaskRows([
      {
        task_id: "t1",
        status: "running",
        summary: "ok",
        tool_use_id: "c1",
        usage: { total_tokens: 1 },
        constructor: { name: "hack" },
        proto: "no",
        extra_secret: "drop-me",
      },
    ]);
    expect(Object.keys(rows[0]).sort()).toEqual(["status", "summary", "task_id", "tool_use_id", "usage"]);
    expect((rows[0] as { extra_secret?: string }).extra_secret).toBeUndefined();
  });

  it("does not copy unknown keys from a tracked subagent", () => {
    const rows = asSubagentRows({
      subagents: [{ agent_id: "a1", agent_type: "workflow-subagent", status: "running", token: "leak" }],
    });
    expect(Object.keys(rows[0]).sort()).toEqual(["agent_id", "agent_type", "status"]);
    expect((rows[0] as { token?: string }).token).toBeUndefined();
  });

  it("rejects constructor / prototype as agent ids", () => {
    expect(asSubagentRows({ subagents: [{ agent_id: "constructor", status: "running" }] })[0].agent_id).toBe(
      "constructor",
    );
    const polluted = Object.create(null);
    polluted.agent_id = "a1";
    polluted.status = "running";
    expect(asSubagentRows({ subagents: [polluted] })).toEqual([{ agent_id: "a1", status: "running" }]);
  });

  it("formatters never interpolate untrusted HTML as markup", () => {
    const payload = "<script>alert(1)</script>";
    expect(clipDisplay(payload, 80)).toBe(payload);
    expect(formatDuration(Number(payload))).toBe("—");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatUsd(Number.NaN)).toBe("—");
  });

  it("snapshot only surfaces advertised workflow fields, not the host note as executable", () => {
    const snap = buildMonitorSnapshot({
      session: { id: "s1", name: "n", title: null, pending: [], last_turn: null, last_task: null },
      workflows: {
        skills: ["code-review", 12, null],
        slash_commands: ["workflow-launch-exec", { name: "nope" }],
        plugins: [{ name: "p" }],
        note: "listed from session advertise (init); host does not invoke workflows — the model does",
      },
    });
    expect(snap.advertise.skills).toEqual(["code-review"]);
    expect(snap.advertise.slash_commands).toEqual(["workflow-launch-exec"]);
    expect(snap.advertise.note?.includes("<")).toBe(false);
  });

  it("bar percents stay finite and class keys stay on the allowlist", () => {
    const keys = new Set(["running", "done", "failed", "input", "output", "cache"]);
    const progress = sharePercents(
      progressShares({ total: 3, running: 1, done: 1, failed: 1, agents_running: 0, agents_total: 0 }),
    );
    const tokens = sharePercents(
      tokenBarShares({
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
        cost_usd: 0.1,
      }),
    );
    for (const s of [...progress, ...tokens]) {
      expect(keys.has(s.key)).toBe(true);
      expect(Number.isFinite(s.pct)).toBe(true);
      expect(s.pct).toBeGreaterThan(0);
      expect(s.pct).toBeLessThanOrEqual(100);
    }
  });

  it("does not treat inherited proto fields on model_usage rows as token counts", () => {
    (Object.prototype as { inputTokens?: number }).inputTokens = 999999;
    try {
      const snap = buildMonitorSnapshot({
        session: { id: "s1", name: "n", title: null, pending: [], last_turn: null, last_task: null },
        info: {
          cost_usd: 0.1,
          input_tokens: Number.POSITIVE_INFINITY,
          model_usage: {
            "claude-opus": {
              outputTokens: 3,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costUSD: Number.NaN,
            },
          },
        },
      });
      expect(snap.tokens.input_tokens).toBeNull();
      expect(snap.models[0]).toMatchObject({ model: "claude-opus", input: 0, output: 3 });
      expect(snap.models[0].cost_usd).toBeUndefined();
    } finally {
      delete (Object.prototype as { inputTokens?: unknown }).inputTokens;
    }
  });

  it("does not treat event extra as a source of arbitrary snapshot keys", () => {
    const snap = buildMonitorSnapshot({
      session: { id: "s1", name: "n", title: null, pending: [], last_turn: null, last_task: null },
      events: [
        {
          kind: "working",
          summary: "task_started",
          ts: 10,
          extra: {
            task_id: "t1",
            workflow_name: "login-page-review",
            __proto__: { polluted: true },
            eval: "no",
          },
        },
      ],
    });
    expect(snap.tasks[0].workflow_name).toBe("login-page-review");
    expect((snap.tasks[0] as { eval?: string }).eval).toBeUndefined();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
