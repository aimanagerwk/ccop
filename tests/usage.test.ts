import { describe, expect, it } from "vitest";
import { extractUsageFromResult, sumModelUsageTokens, usageStatusFields } from "../src/usage.js";

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
    expect(usageStatusFields(null).cost_usd).toBeNull();
    expect(usageStatusFields(undefined).model_usage).toBeNull();
  });

  it("exposes cost_usd, token totals, and model_usage", () => {
    const fields = usageStatusFields(extractUsageFromResult(resultA));
    expect(fields.cost_usd).toBe(0.12);
    expect(fields.input_tokens).toBe(150);
    expect(fields.model_usage).toHaveProperty("claude-opus");
  });
});
