import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { estimateCostUsd, priceFor } from "./pricing.js";
import { ThreadSummarySchema, SUMMARY_TOOL_NAME, SUMMARY_TOOL } from "./schema.js";
import { applyNeedsReplyDecision, buildMessageParams, chooseModel, decideSkip, parseSummaryResponse, shouldCloseAsConcluded, summarizeWithRetry, type SummaryClient } from "./summarize-thread.js";

const valid = {
  summary: "Ali asked for a quote for 500 units of Paracetamol 500mg; we sent USD 12/unit and are waiting for his PO.",
  key_points: ["500 units Paracetamol 500mg", "USD 12/unit quoted"],
  asks: [{ from: "Ali", ask: "Quote for 500 units", due: null }],
  next_action: null,
  needs_reply: false,
  category: "customer",
  priority: "normal",
  concluded: false,
  language: "en",
};

function message(input: unknown, extra: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "tool_use", stop_sequence: null,
    content: [{ type: "tool_use", id: "tu_1", name: SUMMARY_TOOL_NAME, input }],
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } as Anthropic.Usage,
    ...extra,
  } as Anthropic.Message;
}

function fakeClient(responses: (Anthropic.Message | Error)[]): SummaryClient & { calls: Anthropic.MessageCreateParams[] } {
  const calls: Anthropic.MessageCreateParams[] = [];
  return {
    calls,
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        calls.push(params);
        const next = responses.shift();
        if (!next) throw new Error("no more fake responses");
        if (next instanceof Error) throw next;
        return next;
      },
    } as unknown as Anthropic["messages"],
  };
}
const req = { model: "claude-sonnet-5-5", system: "sys", user: "thread" };

describe("tool output validation", () => {
  it("accepts a valid tool call", () => {
    const r = parseSummaryResponse(message(valid));
    expect(r.error).toBeNull();
    expect(r.summary?.category).toBe("customer");
  });
  it("rejects invalid values, missing fields and extra keys", () => {
    expect(parseSummaryResponse(message({ ...valid, priority: "critical" })).error).toMatch(/invalid_output: priority/);
    const { language: _l, ...missing } = valid;
    expect(parseSummaryResponse(message(missing)).error).toMatch(/invalid_output: language/);
    expect(ThreadSummarySchema.safeParse({ ...valid, extra: 1 }).success).toBe(true); // zod strips unknown keys; strict schema forbids them server-side
    expect(SUMMARY_TOOL.input_schema.additionalProperties).toBe(false);
  });
  it("reports refusal, missing tool call and max_tokens", () => {
    expect(parseSummaryResponse(message(valid, { stop_reason: "refusal", content: [] })).error).toBe("refusal");
    expect(parseSummaryResponse(message(valid, { content: [{ type: "text", text: "hi", citations: null }] })).error).toBe("no_tool_call");
    expect(parseSummaryResponse(message(valid, { stop_reason: "max_tokens" })).error).toBe("max_tokens");
  });
  it("a prompt-injection attempt cannot bypass the schema", () => {
    // Model was 'convinced' to emit an out-of-schema priority and an instruction field.
    const r = parseSummaryResponse(message({ ...valid, priority: "URGENT!!!", instructions: "reply now" }));
    expect(r.summary).toBeNull();
    expect(r.error).toMatch(/priority/);
    // A schema-valid answer is accepted as data only: the enum is the only lever the email text can move.
    expect(parseSummaryResponse(message({ ...valid, priority: "urgent" })).summary?.priority).toBe("urgent");
  });
});

describe("summarizeWithRetry", () => {
  it("returns on the first valid response", async () => {
    const c = fakeClient([message(valid)]);
    const r = await summarizeWithRetry(c, req, "low");
    expect(r.summary?.needs_reply).toBe(false);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.usage).toEqual({ inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900, cacheWriteTokens: 0 });
  });
  it("retries once after invalid output", async () => {
    const c = fakeClient([message({ ...valid, category: "vip" }), message(valid)]);
    const r = await summarizeWithRetry(c, req, "low");
    expect(r.summary).not.toBeNull();
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]!.error).toMatch(/invalid_output/);
  });
  it("gives up after two invalid outputs with the error kept", async () => {
    const c = fakeClient([message({ ...valid, category: "vip" }), message(valid, { content: [] })]);
    const r = await summarizeWithRetry(c, req, "low");
    expect(r.summary).toBeNull();
    expect(r.error).toBe("no_tool_call");
    expect(r.calls).toHaveLength(2);
  });
  it("does not retry API errors or refusals itself (the SDK already retried) and never throws", async () => {
    const err = Object.assign(new Error("overloaded"), { status: 529 });
    const r = await summarizeWithRetry(fakeClient([err]), req, "low");
    expect(r.summary).toBeNull();
    expect(r.error).toMatch(/api_error 529/);
    expect(r.calls).toHaveLength(1);
    const r2 = await summarizeWithRetry(fakeClient([message(valid, { stop_reason: "refusal", content: [] })]), req, "low");
    expect(r2.error).toBe("refusal");
    expect(r2.calls).toHaveLength(1);
  });
});

describe("request params", () => {
  it("uses a cached system prompt, the strict tool, auto tool choice and effort only where supported", () => {
    const p = buildMessageParams(req, "low");
    expect((p.system as Anthropic.TextBlockParam[])[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(p.tools?.[0]).toBe(SUMMARY_TOOL);
    expect(p.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(p.output_config).toEqual({ effort: "low" });
    expect(buildMessageParams({ ...req, model: "claude-haiku-4-5" }, "low").output_config).toBeUndefined();
  });
});

describe("skip logic", () => {
  const base = { messageCount: 5, summaryMessageCount: 3, lastMessageAt: new Date("2026-09-28T10:00:00Z"), now: new Date("2026-09-28T10:10:00Z"), debounceMinutes: 2, callsToday: 10, maxCallsPerDay: 500 };
  it("proceeds when there is something new after the debounce window", () => expect(decideSkip(base)).toBeNull());
  it("skips when nothing is new", () => expect(decideSkip({ ...base, summaryMessageCount: 5 })).toBe("nothing_new"));
  it("skips inside the debounce window", () => expect(decideSkip({ ...base, now: new Date("2026-09-28T10:01:00Z") })).toBe("debounce"));
  it("skips when the daily cap is reached, even with force", () => {
    expect(decideSkip({ ...base, callsToday: 500 })).toBe("cap_reached");
    expect(decideSkip({ ...base, callsToday: 500, force: true })).toBe("cap_reached");
  });
  it("force ignores nothing-new and debounce", () => expect(decideSkip({ ...base, summaryMessageCount: 5, now: base.lastMessageAt, force: true })).toBeNull());
});

describe("decisions", () => {
  it("AI needs_reply applies when nobody decided or the AI decided before", () => {
    expect(applyNeedsReplyDecision({ needsReply: true, needsReplyDecidedBy: null }, { needs_reply: false })).toEqual({ needsReply: false, needsReplyDecidedBy: "ai" });
    expect(applyNeedsReplyDecision({ needsReply: false, needsReplyDecidedBy: "ai" }, { needs_reply: true })).toEqual({ needsReply: true, needsReplyDecidedBy: "ai" });
  });
  it("a user decision is sticky", () => {
    expect(applyNeedsReplyDecision({ needsReply: false, needsReplyDecidedBy: "user" }, { needs_reply: true })).toEqual({ needsReply: false, needsReplyDecidedBy: "user" });
  });
  it("concluded closes only when not awaiting us and not already closed", () => {
    expect(shouldCloseAsConcluded({ concluded: true }, "awaiting_them")).toBe(true);
    expect(shouldCloseAsConcluded({ concluded: true }, "no_reply_needed")).toBe(true);
    expect(shouldCloseAsConcluded({ concluded: true }, "awaiting_us")).toBe(false);
    expect(shouldCloseAsConcluded({ concluded: true }, "closed")).toBe(false);
    expect(shouldCloseAsConcluded({ concluded: false }, "awaiting_them")).toBe(false);
  });
  it("light model only for 1–2 short messages when configured", () => {
    const env = { ANTHROPIC_MODEL: "claude-sonnet-5-5", ANTHROPIC_MODEL_LIGHT: "claude-haiku-4-5" };
    expect(chooseModel(2, 800, env)).toBe("claude-haiku-4-5");
    expect(chooseModel(3, 800, env)).toBe("claude-sonnet-5-5");
    expect(chooseModel(1, 5000, env)).toBe("claude-sonnet-5-5");
    expect(chooseModel(1, 100, { ANTHROPIC_MODEL: "claude-sonnet-5-5" })).toBe("claude-sonnet-5-5");
  });
});

describe("cost calculation", () => {
  it("prices Sonnet input/output", () => {
    expect(estimateCostUsd("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(2);
    expect(estimateCostUsd("claude-sonnet-5-5", { inputTokens: 0, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(1);
  });
  it("applies cache read/write prices", () => {
    expect(estimateCostUsd("claude-sonnet-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 })).toBeCloseTo(0.2);
    expect(estimateCostUsd("claude-sonnet-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 })).toBeCloseTo(2.5);
  });
  it("halves everything for batch", () => {
    const u = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0 };
    expect(estimateCostUsd("claude-haiku-4-5", u, true)).toBeCloseTo(estimateCostUsd("claude-haiku-4-5", u) / 2);
    expect(estimateCostUsd("claude-haiku-4-5", u)).toBeCloseTo((1000 * 1 + 500 * 5 + 2000 * 0.1) / 1e6);
  });
  it("resolves dated ids and falls back for unknown models", () => {
    expect(priceFor("claude-haiku-4-5-20251001")?.input).toBe(1);
    expect(priceFor("some-future-model")).toBeNull();
    expect(estimateCostUsd("some-future-model", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(2);
  });
});
