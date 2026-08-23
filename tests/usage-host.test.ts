import { describe, expect, it } from "vitest";
import { Host, Session } from "../src/daemon.js";
import { extractUsageFromResult } from "../src/usage.js";

const ID = "00000000-0000-4000-8000-usagehost0001";

const resultA = {
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: ID,
  result: "ok",
  total_cost_usd: 0.12,
  usage: { input_tokens: 10, output_tokens: 4 },
  modelUsage: {
    "claude-opus": {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 3,
      costUSD: 0.12,
    },
  },
};

const resultB = {
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: ID,
  result: "ok",
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

const snap10Result = {
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "a664542d-ce8d-4b95-b381-e29b589e0ee1",
  result: "turn",
  total_cost_usd: 0.403439,
  usage: { input_tokens: 10, output_tokens: 4 },
  modelUsage: {
    "grok-4.6": {
      inputTokens: 64038,
      outputTokens: 2201,
      cacheReadInputTokens: 56448,
      cacheCreationInputTokens: 0,
      costUSD: 0.403439,
    },
  },
};

function fakeClient(messages: unknown[]) {
  return {
    async query() {},
    async interrupt() {},
    async disconnect() {},
    receiveMessages() {
      return (async function* () {
        for (const m of messages) yield m;
      })();
    },
    async getServerInfo() {
      return null;
    },
    async stopTask() {},
    async backgroundTasks() {
      return false;
    },
    async mcpServerStatus() {
      throw new Error("mcpServerStatus is not available on this client");
    },
    async setMcpServers() {},
    async reconnectMcpServer() {},
    async toggleMcpServer() {},
    async reloadPlugins() {},
    async reloadSkills() {},
  };
}

function liveSession(id: string, messages: unknown[]) {
  const host = new Host();
  const sess = new Session(id, "/tmp/ccop-usage-host", "usage-host", host);
  sess.persist = () => {};
  const emitted: Array<{ kind: string; summary: string; extra?: Record<string, unknown> }> = [];
  sess.emit = (events) => {
    emitted.push(...events);
  };
  sess.alive = false;
  sess.client = fakeClient(messages);
  host.sessions[id] = sess;
  return { host, sess, emitted };
}

describe("host receiveLoop usage → info/status", () => {
  it("feeds ResultMessage then cmdInfo/cmdStatus expose cost_usd and summed model_usage tokens", async () => {
    const { host, sess } = liveSession(ID, [resultA]);
    await sess.receiveLoop();
    const info = await host.cmdInfo({ id: ID });
    const status = await host.cmdStatus({});
    const row = (status.sessions as Array<Record<string, unknown>>).find((s) => s.id === ID);
    expect(info.cost_usd).toBe(0.12);
    expect(info.input_tokens).toBe(100);
    expect(info.output_tokens).toBe(20);
    expect(info.model_usage).toEqual(extractUsageFromResult(resultA)?.model_usage);
    expect(row?.cost_usd).toBe(0.12);
    expect(row?.input_tokens).toBe(100);
  });

  it("keeps info/status cost_usd and input_tokens null across assistant / task_progress / thinking_tokens", async () => {
    const { host, sess, emitted } = liveSession(ID, [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 64038, output_tokens: 12, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 },
        },
      },
      {
        type: "system",
        subtype: "task_progress",
        task_id: "ws1668ueh",
        description: "review",
        usage: { total_tokens: 0, tool_uses: 0, duration_ms: 3264 },
      },
      {
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 48,
        estimated_tokens_delta: 6,
      },
    ]);
    await sess.receiveLoop();
    const info = await host.cmdInfo({ id: ID });
    const status = await host.cmdStatus({});
    const row = (status.sessions as Array<Record<string, unknown>>).find((s) => s.id === ID);
    expect(info.cost_usd).toBeNull();
    expect(info.input_tokens).toBeNull();
    expect(row?.cost_usd).toBeNull();
    expect(row?.input_tokens).toBeNull();
    const tasks = await host.cmdTasks({ id: ID });
    expect((tasks.tasks as Array<Record<string, unknown>>)[0]).toMatchObject({
      task_id: "ws1668ueh",
      usage: { total_tokens: 0, tool_uses: 0, duration_ms: 3264 },
    });
    const think = emitted.find((e) => e.summary === "thinking_tokens");
    expect(think?.extra).toMatchObject({ estimated_tokens: 48, estimated_tokens_delta: 6 });
  });

  it("replaces the first ResultMessage with the second (no sum)", async () => {
    const { host, sess } = liveSession(ID, [resultA, resultB]);
    await sess.receiveLoop();
    const info = await host.cmdInfo({ id: ID });
    expect(info.cost_usd).toBe(0.4);
    expect(info.input_tokens).toBe(400);
    expect(info.cost_usd).not.toBe(0.52);
  });

  it("replays wf-evidence snap 9 vs snap 10: task usage does not fill session cost until result", async () => {
    const mid = liveSession(ID, [
      {
        type: "system",
        subtype: "task_progress",
        task_id: "ws1668ueh",
        description: "Small code review of auth, session, and dashboard",
        usage: { total_tokens: 0, tool_uses: 0, duration_ms: 3264 },
      },
    ]);
    await mid.sess.receiveLoop();
    const midInfo = await mid.host.cmdInfo({ id: ID });
    expect(midInfo.cost_usd).toBeNull();
    expect(midInfo.input_tokens).toBeNull();
    const midTasks = await mid.host.cmdTasks({ id: ID });
    expect((midTasks.tasks as Array<Record<string, unknown>>)[0]).toMatchObject({
      usage: { total_tokens: 0, tool_uses: 0, duration_ms: 3264 },
    });

    const after = liveSession(ID, [
      {
        type: "system",
        subtype: "task_progress",
        task_id: "ws1668ueh",
        usage: { total_tokens: 0, tool_uses: 4, duration_ms: 7578 },
      },
      snap10Result,
    ]);
    await after.sess.receiveLoop();
    const afterInfo = await after.host.cmdInfo({ id: ID });
    expect(afterInfo.cost_usd).toBe(0.403439);
    expect(afterInfo.input_tokens).toBe(64038);
    expect(afterInfo.output_tokens).toBe(2201);
  });

  it("does not fill session tokens from non-finite result numbers or polluted model keys", async () => {
    const modelUsage: Record<string, unknown> = {
      "claude-opus": {
        inputTokens: 11,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: Number.NaN,
      },
    };
    Object.defineProperty(modelUsage, "__proto__", {
      value: { inputTokens: 9e15, outputTokens: 9e15, cacheReadInputTokens: 9e15, cacheCreationInputTokens: 9e15 },
      enumerable: true,
    });
    const { host, sess } = liveSession(ID, [
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: ID,
        result: "ok",
        total_cost_usd: Number.POSITIVE_INFINITY,
        usage: { input_tokens: Number.NaN, extra: "drop" },
        modelUsage,
      },
    ]);
    await sess.receiveLoop();
    const info = await host.cmdInfo({ id: ID });
    expect(info.cost_usd).toBe(0);
    expect(info.input_tokens).toBe(11);
    expect(Object.keys(info.model_usage as object)).toEqual(["claude-opus"]);
    expect(Object.prototype.hasOwnProperty.call(info.model_usage as object, "__proto__")).toBe(false);
    expect(Object.keys(info).includes("extra_secret")).toBe(false);
    const status = await host.cmdStatus({});
    const row = (status.sessions as Array<Record<string, unknown>>).find((s) => s.id === ID);
    expect(row?.cost_usd).toBe(0);
    expect(row?.input_tokens).toBe(11);
  });
});
