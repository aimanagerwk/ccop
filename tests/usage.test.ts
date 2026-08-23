import { describe, expect, it, afterEach } from "vitest";
import {
  appendUsageHistory,
  extractUsageFromResult,
  normalizeSessionUsage,
  normalizeUsageHistory,
  sumModelUsageTokens,
  usageHistoryPoint,
  usageStatusFields,
  USAGE_HISTORY_CAP,
} from "../src/usage.js";

afterEach(() => {
  delete (Object.prototype as { inputTokens?: unknown }).inputTokens;
  delete (Object.prototype as { outputTokens?: unknown }).outputTokens;
  delete (Object.prototype as { costUSD?: unknown }).costUSD;
  delete (Object.prototype as { hacked?: unknown }).hacked;
});

const resultA = {
  type: "result",
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

const resultB = {
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

describe("extractUsageFromResult", () => {
  it("reads one result (latest wins — do not sum results)", () => {
    const a = extractUsageFromResult(resultA);
    const b = extractUsageFromResult(resultB);
    expect(a?.cost_usd).toBe(0.12);
    expect(b?.cost_usd).toBe(0.4);
    expect(b?.cost_usd).not.toBe((a?.cost_usd ?? 0) + (b?.cost_usd ?? 0));
    expect(b?.model_usage["claude-opus"].inputTokens).toBe(400);
    expect(b?.last_turn_usage).toEqual({ input_tokens: 3, output_tokens: 1 });
    expect(typeof b?.updated_ts).toBe("number");
  });

  it("accepts snake_case model_usage rows", () => {
    const u = extractUsageFromResult({
      total_cost_usd: 1,
      model_usage: {
        m: {
          input_tokens: 2,
          output_tokens: 3,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 5,
          cost_usd: 0.01,
        },
      },
    });
    expect(u?.model_usage.m).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 5,
      costUSD: 0.01,
    });
  });

  it("returns null for non-result objects", () => {
    expect(extractUsageFromResult(null)).toBeNull();
    expect(extractUsageFromResult({ type: "assistant" })).toBeNull();
    expect(extractUsageFromResult({ type: "system", subtype: "init" })).toBeNull();
  });

  it("does not treat assistant message.usage as session totals", () => {
    expect(
      extractUsageFromResult({
        type: "assistant",
        message: {
          usage: {
            input_tokens: 64038,
            output_tokens: 2201,
            cache_read_input_tokens: 56448,
            cache_creation_input_tokens: 0,
          },
        },
      }),
    ).toBeNull();
  });

  it("does not treat stream_event message_delta.usage as session totals", () => {
    expect(
      extractUsageFromResult({
        type: "stream_event",
        event: {
          type: "message_delta",
          usage: { output_tokens: 12, input_tokens: 3 },
        },
      }),
    ).toBeNull();
  });

  it("does not treat thinking_tokens estimates as session totals", () => {
    expect(
      extractUsageFromResult({
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 48,
        estimated_tokens_delta: 6,
      }),
    ).toBeNull();
  });

  it("does not treat task_progress usage as session totals", () => {
    expect(
      extractUsageFromResult({
        type: "system",
        subtype: "task_progress",
        usage: { total_tokens: 13828, tool_uses: 3, duration_ms: 15029 },
      }),
    ).toBeNull();
  });

  it("extracts a result that only has per-turn usage (cost becomes 0)", () => {
    const u = extractUsageFromResult({
      type: "result",
      usage: { input_tokens: 7, output_tokens: 1 },
    });
    expect(u).not.toBeNull();
    expect(u?.cost_usd).toBe(0);
    expect(u?.model_usage).toEqual({});
    expect(u?.last_turn_usage).toEqual({ input_tokens: 7, output_tokens: 1 });
  });

  it("ignores __proto__ and constructor model keys", () => {
    const modelUsage: Record<string, unknown> = {
      "claude-opus": {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 5,
      },
    };
    Object.defineProperty(modelUsage, "__proto__", {
      value: { inputTokens: 9, outputTokens: 9, cacheReadInputTokens: 9, cacheCreationInputTokens: 9 },
      enumerable: true,
    });
    Object.defineProperty(modelUsage, "constructor", {
      value: { inputTokens: 8, outputTokens: 8, cacheReadInputTokens: 8, cacheCreationInputTokens: 8 },
      enumerable: true,
    });
    const u = extractUsageFromResult({ type: "result", total_cost_usd: 1, modelUsage });
    expect(u?.model_usage["claude-opus"]).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 5,
    });
    expect(Object.prototype.hasOwnProperty.call(u?.model_usage, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(u?.model_usage, "constructor")).toBe(false);
    expect(Object.keys(u?.model_usage || {})).toEqual(["claude-opus"]);
  });

  it("ignores non-finite and non-numeric usage numbers", () => {
    const u = extractUsageFromResult({
      type: "result",
      total_cost_usd: Number.POSITIVE_INFINITY,
      usage: {
        input_tokens: Number.NaN,
        output_tokens: "12",
        cache_read_input_tokens: Number.NEGATIVE_INFINITY,
        extra: "drop",
      },
      modelUsage: {
        "claude-opus": {
          inputTokens: "999999",
          outputTokens: Number.POSITIVE_INFINITY,
          cacheReadInputTokens: Number.NaN,
          cacheCreationInputTokens: null,
          costUSD: Number.NaN,
        },
        "claude-haiku": {
          input_tokens: 4,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cost_usd: Number.POSITIVE_INFINITY,
        },
      },
    });
    expect(u?.cost_usd).toBe(0);
    expect(u?.model_usage["claude-opus"]).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    expect(u?.model_usage["claude-opus"]).not.toHaveProperty("costUSD");
    expect(u?.model_usage["claude-haiku"]).toEqual({
      inputTokens: 4,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    expect(u?.model_usage["claude-haiku"]).not.toHaveProperty("costUSD");
    expect(u?.last_turn_usage).toEqual({});
    expect(sumModelUsageTokens(u?.model_usage)).toEqual({
      input_tokens: 4,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("does not read inherited prototype fields on modelUsage rows", () => {
    (Object.prototype as { inputTokens?: number }).inputTokens = 999999;
    (Object.prototype as { costUSD?: number }).costUSD = 77;
    const u = extractUsageFromResult({
      type: "result",
      total_cost_usd: 1,
      modelUsage: {
        "claude-opus": {
          outputTokens: 3,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    });
    expect(u?.model_usage["claude-opus"].inputTokens).toBe(0);
    expect(u?.model_usage["claude-opus"]).not.toHaveProperty("costUSD");
    expect(sumModelUsageTokens(u?.model_usage).input_tokens).toBe(0);
  });

  it("does not copy unexpected keys from a polluted modelUsage row", () => {
    const row = JSON.parse(
      '{"inputTokens":2,"outputTokens":3,"cacheReadInputTokens":4,"cacheCreationInputTokens":5,"costUSD":0.01,"eval":"no","__proto__":{"hacked":true}}',
    );
    const u = extractUsageFromResult({ type: "result", total_cost_usd: 0.01, modelUsage: { "claude-opus": row } });
    expect(Object.keys(u?.model_usage["claude-opus"] || {}).sort()).toEqual([
      "cacheCreationInputTokens",
      "cacheReadInputTokens",
      "costUSD",
      "inputTokens",
      "outputTokens",
    ]);
    expect((u?.model_usage["claude-opus"] as { eval?: string }).eval).toBeUndefined();
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it("does not sum incremental junk; a later result replaces the earlier snapshot", () => {
    const first = extractUsageFromResult({
      type: "result",
      total_cost_usd: 0.01,
      modelUsage: {
        "claude-opus": {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    });
    const junk = [
      extractUsageFromResult({
        type: "assistant",
        message: { usage: { input_tokens: 64038, output_tokens: 2201 } },
      }),
      extractUsageFromResult({
        type: "system",
        subtype: "task_progress",
        usage: { total_tokens: 999999 },
      }),
      extractUsageFromResult({
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 1e12,
      }),
    ];
    expect(junk.every((x) => x === null)).toBe(true);
    const latest = extractUsageFromResult({
      type: "result",
      total_cost_usd: 0.02,
      modelUsage: {
        "claude-opus": {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    });
    const kept = latest ?? first;
    expect(sumModelUsageTokens(kept?.model_usage).input_tokens).toBe(12);
    expect(sumModelUsageTokens(kept?.model_usage).input_tokens).not.toBe(
      (first?.model_usage["claude-opus"].inputTokens ?? 0) + 12,
    );
    expect(kept?.cost_usd).toBe(0.02);
  });
});

describe("sumModelUsageTokens", () => {
  it("sums input/output/cache across models on one snapshot", () => {
    const u = extractUsageFromResult(resultA)!;
    expect(sumModelUsageTokens(u.model_usage)).toEqual({
      input_tokens: 150,
      output_tokens: 28,
      cache_read_input_tokens: 6,
      cache_creation_input_tokens: 3,
    });
  });
});

describe("usageStatusFields", () => {
  it("nulls historical sessions without usage", () => {
    expect(usageStatusFields(null)).toEqual({
      cost_usd: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      model_usage: null,
      usage_updated_ts: null,
    });
    expect(usageStatusFields(undefined).model_usage).toBeNull();
  });

  it("exposes cost_usd, token totals, and model_usage", () => {
    const fields = usageStatusFields(extractUsageFromResult(resultA));
    expect(fields.cost_usd).toBe(0.12);
    expect(fields.input_tokens).toBe(150);
    expect(fields.model_usage).toHaveProperty("claude-opus");
  });

  it("never leaks unexpected keys", () => {
    const expected = [
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "cost_usd",
      "input_tokens",
      "model_usage",
      "output_tokens",
      "usage_updated_ts",
    ];
    expect(Object.keys(usageStatusFields(null)).sort()).toEqual(expected);
    const dirty = {
      cost_usd: 1,
      model_usage: {
        "claude-opus": {
          inputTokens: 2,
          outputTokens: 3,
          cacheReadInputTokens: 4,
          cacheCreationInputTokens: 5,
          costUSD: 1,
          eval: "no",
        },
      },
      last_turn_usage: { input_tokens: 1, secret: "x" },
      updated_ts: 1,
      extra_secret: "drop-me",
      constructor: { name: "hack" },
    };
    const fields = usageStatusFields(dirty as never);
    expect(Object.keys(fields).sort()).toEqual(expected);
    expect((fields as { extra_secret?: string }).extra_secret).toBeUndefined();
    expect((fields as { last_turn_usage?: unknown }).last_turn_usage).toBeUndefined();
    expect((fields as { updated_ts?: number }).updated_ts).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(fields, "constructor")).toBe(false);
    expect(Object.keys((fields.model_usage as Record<string, object>)["claude-opus"]).sort()).toEqual([
      "cacheCreationInputTokens",
      "cacheReadInputTokens",
      "costUSD",
      "inputTokens",
      "outputTokens",
    ]);
  });

  it("ignores non-finite totals and prototype model keys on a dirty usage object", () => {
    const modelUsage: Record<string, unknown> = {
      "claude-opus": {
        inputTokens: 2,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    };
    Object.defineProperty(modelUsage, "__proto__", {
      value: { inputTokens: 9e15, outputTokens: 9e15, cacheReadInputTokens: 9e15, cacheCreationInputTokens: 9e15 },
      enumerable: true,
    });
    const fields = usageStatusFields({
      cost_usd: Number.POSITIVE_INFINITY,
      model_usage: modelUsage as never,
      last_turn_usage: null,
      updated_ts: 1,
    });
    expect(fields.cost_usd).toBe(0);
    expect(fields.input_tokens).toBe(2);
    expect(Object.keys(fields.model_usage as object)).toEqual(["claude-opus"]);
    expect(Object.prototype.hasOwnProperty.call(fields.model_usage as object, "__proto__")).toBe(false);
  });

  it("mid-turn snapshot with numbers stays non-null through extract (no ResultMessage yet)", () => {
    const midTurn = {
      last_kind: "working",
      total_cost_usd: 0.12,
      usage: { input_tokens: 10, output_tokens: 4 },
      modelUsage: resultA.modelUsage,
    };
    const extracted = extractUsageFromResult(midTurn);
    const fields = usageStatusFields(extracted);
    expect(extracted).not.toBeNull();
    expect(fields.cost_usd).toBe(0.12);
    expect(fields.input_tokens).toBe(150);
    expect(fields.output_tokens).toBe(28);
    expect([fields.cost_usd, fields.input_tokens, fields.output_tokens].every((n) => n == null)).toBe(false);
  });

  it("replaces mid-turn extract with a later ResultMessage (latest wins — do not sum)", () => {
    let usage = extractUsageFromResult({
      last_kind: "working",
      total_cost_usd: 0.12,
      usage: { input_tokens: 10, output_tokens: 4 },
      modelUsage: resultA.modelUsage,
    });
    usage = extractUsageFromResult({
      type: "assistant",
      message: { usage: { input_tokens: 64038, output_tokens: 2201 } },
    }) ?? usage;
    usage = extractUsageFromResult(resultB) ?? usage;
    const fields = usageStatusFields(usage);
    expect(fields.cost_usd).toBe(0.4);
    expect(fields.input_tokens).toBe(400);
    expect(fields.cost_usd).not.toBe(0.52);
    expect(fields.input_tokens).not.toBe(550);
  });

  it("exposes usage_updated_ts from a settled snapshot and nulls a missing one", () => {
    const u = extractUsageFromResult(resultA)!;
    expect(typeof usageStatusFields(u).usage_updated_ts).toBe("number");
    expect(usageStatusFields({ ...u, updated_ts: Number.NaN }).usage_updated_ts).toBeNull();
  });
});

describe("usage history", () => {
  it("appends each Result snapshot without summing tokens or cost", () => {
    const a = extractUsageFromResult(resultA)!;
    a.updated_ts = 10;
    const b = extractUsageFromResult(resultB)!;
    b.updated_ts = 20;
    const hist = appendUsageHistory(appendUsageHistory([], a), b);
    expect(hist).toHaveLength(2);
    expect(hist[0].input_tokens).toBe(150);
    expect(hist[1].input_tokens).toBe(400);
    expect(hist[1].cost_usd).toBe(0.4);
    expect(hist[1].cost_usd).not.toBe(0.52);
    expect(hist[1].input_tokens).not.toBe(550);
  });

  it("does not invent a history point from assistant / thinking / task_progress", () => {
    expect(extractUsageFromResult({ type: "assistant", message: { usage: { input_tokens: 9 } } })).toBeNull();
    expect(normalizeUsageHistory([{ ts: Number.NaN, input_tokens: 9 }])).toEqual([]);
    expect(normalizeUsageHistory("nope")).toEqual([]);
    expect(usageHistoryPoint({ cost_usd: 1, model_usage: {}, last_turn_usage: null, updated_ts: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("caps history and drops prototype / extra keys", () => {
    const seed = extractUsageFromResult(resultA)!;
    let hist: ReturnType<typeof appendUsageHistory> = [];
    for (let i = 0; i < USAGE_HISTORY_CAP + 4; i++) {
      hist = appendUsageHistory(hist, { ...seed, updated_ts: i + 1 });
    }
    expect(hist).toHaveLength(USAGE_HISTORY_CAP);
    expect(hist[0].ts).toBe(5);
    const dirty = JSON.parse(
      '{"ts":1,"cost_usd":0.1,"input_tokens":2,"output_tokens":3,"cache_read_input_tokens":4,"cache_creation_input_tokens":5,"eval":"no","__proto__":{"hacked":true}}',
    );
    const clean = normalizeUsageHistory([dirty]);
    expect(Object.keys(clean[0]).sort()).toEqual([
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "cost_usd",
      "input_tokens",
      "output_tokens",
      "ts",
    ]);
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
  });

  it("normalizeSessionUsage drops unexpected keys from a disk snapshot", () => {
    const dirty = JSON.parse(
      '{"cost_usd":0.1,"model_usage":{"claude-opus":{"inputTokens":2,"outputTokens":3,"cacheReadInputTokens":0,"cacheCreationInputTokens":0}},"last_turn_usage":{"input_tokens":1},"updated_ts":9,"eval":"no","__proto__":{"hacked":true}}',
    );
    const u = normalizeSessionUsage(dirty);
    expect(u?.cost_usd).toBe(0.1);
    expect(Object.keys(u || {}).sort()).toEqual(["cost_usd", "last_turn_usage", "model_usage", "updated_ts"]);
    expect((u as { eval?: string } | null)?.eval).toBeUndefined();
    expect(({} as { hacked?: boolean }).hacked).toBeUndefined();
    expect(normalizeSessionUsage(null)).toBeNull();
    expect(normalizeSessionUsage("x")).toBeNull();
  });
});
