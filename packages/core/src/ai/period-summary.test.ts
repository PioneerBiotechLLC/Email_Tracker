import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { buildActivity, buildPeriodInput, callPeriodSummary, formatThreadLine, orderForDigest, parsePeriodResponse, periodRange, periodUserMessage, PERIOD_SUMMARY_TOOL, PERIOD_SUMMARY_TOOL_NAME, type PeriodThread } from "./period-summary.js";
import type { SummaryClient } from "./summarize-thread.js";

const TZ = "Asia/Dubai";
const now = new Date("2026-09-30T08:30:00Z"); // 12:30 Dubai, Wed 30 Sep

describe("periodRange", () => {
  it("starts at the local midnight of the first day of the window", () => {
    expect(periodRange("day", now, TZ).from.toISOString()).toBe("2026-09-29T20:00:00.000Z"); // 30 Sep 00:00 Dubai
    expect(periodRange("week", now, TZ).from.toISOString()).toBe("2026-09-23T20:00:00.000Z"); // 24 Sep 00:00 Dubai (7 days incl. today)
    expect(periodRange("month", now, TZ).from.toISOString()).toBe("2026-08-31T20:00:00.000Z"); // 1 Sep 00:00 Dubai
    expect(periodRange("week", now, TZ).to).toBe(now);
    expect(periodRange("week", now, TZ).label).toBe("Last 7 days");
  });
});

const mailbox = { emailAddress: "sales@x.com", aliases: [] };
const threads = [
  { id: "t1", subject: "PO 4512", category: "customer", priority: "high", status: "awaiting_us", overdueAt: new Date("2026-09-29T00:00:00Z"), summary: "MedCare sent PO 4512.", nextAction: "Confirm delivery", mailbox },
  { id: "t2", subject: "Newsletter", category: "newsletter", priority: "low", status: "no_reply_needed", overdueAt: null, summary: null, nextAction: null, mailbox },
  { id: "t3", subject: "COA batch 1", category: "supplier", priority: "normal", status: "awaiting_them", overdueAt: null, summary: null, nextAction: null, mailbox: { emailAddress: "regulatory@x.com" } },
];
const messages = [
  { threadId: "t1", direction: "inbound" as const, receivedAt: new Date("2026-09-28T06:00:00Z"), repliedAt: null, fromAddress: "buyer@medcare.sa", fromName: "MedCare", toAddresses: [], bodyPreview: "Please confirm PO 4512", mailbox },
  { threadId: "t2", direction: "inbound" as const, receivedAt: new Date("2026-09-29T06:00:00Z"), repliedAt: null, fromAddress: "news@intel.com", fromName: null, toAddresses: [], bodyPreview: "This week in pharma", mailbox },
  { threadId: "t3", direction: "inbound" as const, receivedAt: new Date("2026-09-27T06:00:00Z"), repliedAt: new Date("2026-09-27T08:00:00Z"), fromAddress: "qa@hetero.in", fromName: "Hetero QA", toAddresses: [], bodyPreview: "COA attached", mailbox: { emailAddress: "regulatory@x.com", aliases: [] } },
  { threadId: "t3", direction: "outbound" as const, receivedAt: new Date("2026-09-27T08:00:00Z"), repliedAt: null, fromAddress: "regulatory@x.com", fromName: "Reg", toAddresses: [{ address: "qa@hetero.in", name: "Hetero QA" }], bodyPreview: "Thanks, cleared.", mailbox: { emailAddress: "regulatory@x.com", aliases: [] } },
  { threadId: "missing", direction: "inbound" as const, receivedAt: new Date("2026-09-27T08:00:00Z"), repliedAt: null, fromAddress: "x@y.com", fromName: null, toAddresses: [], bodyPreview: null, mailbox },
];

describe("buildActivity", () => {
  const a = buildActivity(messages, threads, now);
  it("computes the figures from the rows (threads without a row are ignored)", () => {
    expect(a.stats).toEqual({ received: 3, sent: 1, replied: 1, repliedPct: 33.3, awaiting: 1, overdue: 1, threads: 3, mailboxes: 2 });
  });
  it("groups per thread with counts, last message and counterparts, most urgent first", () => {
    expect(a.threads.map((t) => t.id)).toEqual(["t1", "t3", "t2"]);
    const t3 = a.threads.find((t) => t.id === "t3")!;
    expect(t3.inbound).toBe(1);
    expect(t3.outbound).toBe(1);
    expect(t3.lastFrom).toBe("us");
    expect(t3.lastPreview).toBe("Thanks, cleared.");
    expect(t3.counterparts).toEqual(["Hetero QA"]);
    expect(a.threads[0]!.overdue).toBe(true);
  });
});

function thread(p: Partial<PeriodThread> & { id: string }): PeriodThread {
  return { subject: p.id, mailbox: "sales@x.com", category: "customer", priority: "normal", status: "awaiting_them", overdue: false, inbound: 1, outbound: 0, summary: null, nextAction: null, lastPreview: "x".repeat(200), lastFrom: "Ali", lastAt: now, counterparts: ["Ali"], ...p };
}

describe("buildPeriodInput", () => {
  it("orders by urgency and drops the least urgent threads when over budget", () => {
    const ts = [thread({ id: "low", priority: "low" }), thread({ id: "urgent", priority: "urgent", status: "awaiting_us" }), thread({ id: "overdue", overdue: true, status: "awaiting_us" }), thread({ id: "closed", status: "closed" })];
    expect(orderForDigest(ts).map((t) => t.id)).toEqual(["overdue", "urgent", "low", "closed"]);
    const built = buildPeriodInput(ts, { timezone: TZ, showMailbox: true, maxTokens: 200 });
    expect(built.includedCount).toBeLessThan(4);
    expect(built.omittedCount).toBe(4 - built.includedCount);
    expect(built.text).toContain("[sales@x.com] overdue");
    expect(built.text).toMatch(/less urgent threads? not listed/);
    expect(built.text.indexOf("overdue")).toBeLessThan(built.text.indexOf("urgent |"));
  });
  it("prefers the AI summary over the preview and marks overdue threads", () => {
    const line = formatThreadLine(thread({ id: "t", summary: "Customer wants a quote.", nextAction: "Send quote", overdue: true, status: "awaiting_us" }), TZ, false);
    expect(line).toContain("OVERDUE");
    expect(line).toContain("Customer wants a quote.");
    expect(line).toContain("Next: Send quote");
    expect(line).not.toContain("xxxx");
    expect(line.startsWith("- t |")).toBe(true);
  });
  it("wraps the thread list as data after the figures", () => {
    const built = buildPeriodInput([thread({ id: "t" })], { timezone: TZ, showMailbox: true });
    const msg = periodUserMessage({ orgName: "X", scope: "all 2 mailboxes", periodLabel: "Last 7 days", from: periodRange("week", now, TZ).from, to: now, timezone: TZ, stats: { received: 3, sent: 1, replied: 1, repliedPct: 33.3, awaiting: 1, overdue: 1, threads: 1, mailboxes: 2 } }, built);
    expect(msg).toContain("3 received, 1 sent, 1 answered (33.3%)");
    expect(msg.indexOf("<threads>")).toBeGreaterThan(msg.indexOf(PERIOD_SUMMARY_TOOL_NAME));
    expect(msg.trim().endsWith("</threads>")).toBe(true);
  });
});

const valid = { overview: "Quiet week.", received: ["MedCare sent PO 4512"], sent: ["We cleared batch 1"], needs_attention: ["MedCare: confirm PO 4512 (overdue)"] };
function message(input: unknown, extra: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "tool_use", stop_sequence: null,
    content: [{ type: "tool_use", id: "tu", name: PERIOD_SUMMARY_TOOL_NAME, input }],
    usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 400 } as Anthropic.Usage,
    ...extra,
  } as Anthropic.Message;
}
function fakeClient(responses: (Anthropic.Message | Error)[]): SummaryClient & { calls: Anthropic.MessageCreateParams[] } {
  const calls: Anthropic.MessageCreateParams[] = [];
  return { calls, messages: { create: async (params: Anthropic.MessageCreateParams) => { calls.push(params); const n = responses.shift(); if (!n) throw new Error("no more"); if (n instanceof Error) throw n; return n; } } as unknown as Anthropic["messages"] };
}
const req = { model: "claude-sonnet-5-5", system: "sys", user: "threads" };

describe("period summary calls", () => {
  it("validates the tool output strictly", () => {
    expect(parsePeriodResponse(message(valid)).summary?.overview).toBe("Quiet week.");
    expect(parsePeriodResponse(message({ ...valid, received: new Array(7).fill("x") })).error).toMatch(/invalid_output: received/);
    expect(parsePeriodResponse(message(valid, { content: [] })).error).toBe("no_tool_call");
    expect(PERIOD_SUMMARY_TOOL.input_schema.additionalProperties).toBe(false);
  });
  it("retries once on invalid output, not on API errors, and reports usage", async () => {
    const c = fakeClient([message({ ...valid, overview: "" }), message(valid)]);
    const r = await callPeriodSummary(c, req, "low");
    expect(r.summary?.sent).toEqual(["We cleared batch 1"]);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]!.usage.cacheWriteTokens).toBe(400);
    expect((c.calls[0] as { tool_choice?: { type: string } }).tool_choice?.type).toBe("auto");
    const boom = fakeClient([Object.assign(new Error("overloaded"), { status: 529 })]);
    const e = await callPeriodSummary(boom, req, "low");
    expect(e.summary).toBeNull();
    expect(e.error).toMatch(/api_error 529/);
    expect(e.calls).toHaveLength(1);
  });
});
